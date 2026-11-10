# Phân tích và kiến trúc

## Nghiệp vụ và quy tắc

- Một tài khoản đăng nhập có thể thanh toán cho chính người dùng hoặc sinh viên khác.
- Người nộp luôn là tài khoản đã xác thực; frontend không gửi/sửa thông tin người trả tiền.
- MSSV xác định sinh viên và một hóa đơn. Chỉ thanh toán toàn bộ số tiền nguyên VND.
- Hóa đơn chỉ cho phép một giao dịch giữ chỗ tại một thời điểm: `UNPAID → PROCESSING → PAID`. Nếu luồng thất bại trước khi thanh toán hoàn tất, hóa đơn trở về `UNPAID`.
- OTP 6 chữ số gắn một payment, hash trong Notification DB, hết hạn sau tối đa 5 phút, dùng một lần, tối đa 5 lần nhập sai.
- Auth DB cập nhật số dư bằng điều kiện `balance >= amount` trong MongoDB transaction. Ledger thao tác có `operationId` duy nhất để chống debit/refund lặp.
- Idempotency key duy nhất theo payer tạo payment; request lặp trả lại payment cũ.

## Use Case Diagram

```mermaid
flowchart LR
  U[Người dùng đã đăng nhập]
  UC1((Xem hồ sơ và số dư))
  UC2((Tra cứu MSSV / học phí))
  UC3((Chấp nhận điều khoản))
  UC4((Tạo giao dịch))
  UC5((Nhận và xác thực OTP))
  UC6((Thanh toán toàn bộ))
  UC7((Xem lịch sử / chi tiết))
  UC8((Nhận email biên nhận))
  U --> UC1
  U --> UC2
  U --> UC3 --> UC4 --> UC5 --> UC6
  U --> UC7
  UC6 --> UC8
```

## Microservices Architecture Diagram

```mermaid
flowchart LR
  Browser[React + Vite]
  GW[API Gateway :4000<br/>HttpOnly JWT cookie]
  AUTH[Auth Service :4001]
  TUITION[Tuition Service :4002]
  PAY[Payment Service :4003<br/>Saga orchestrator + outbox worker]
  NOTIFY[Notification Service :4004]
  ADB[(MongoDB<br/>ibanking_auth)]
  TDB[(MongoDB<br/>ibanking_tuition)]
  PDB[(MongoDB<br/>ibanking_payment)]
  NDB[(MongoDB<br/>ibanking_notification)]
  SMTP[Gmail SMTP]
  Browser -->|/api REST| GW
  GW -->|REST + bearer JWT| AUTH
  GW -->|REST + bearer JWT| TUITION
  GW -->|REST + bearer JWT| PAY
  PAY -->|private REST, service token| AUTH
  PAY -->|private REST, reserve / settle / release| TUITION
  PAY -->|private REST, OTP / receipt| NOTIFY
  AUTH --> ADB
  TUITION --> TDB
  PAY --> PDB
  NOTIFY --> NDB
  NOTIFY --> SMTP
```

Auth owns users, balances and account-operation ledger; Tuition owns student and invoice documents; Payment owns transaction and receipt outbox; Notification owns OTP challenges. MongoDB databases are separate. Service-specific private APIs guard writes; other services do not connect to those databases. Within Auth, balance plus debit/refund ledger use a local MongoDB transaction. Across services, Payment uses a persisted Saga and compensation instead of a distributed Mongo transaction.

## Entity Relationship Diagram

Logical references across databases are strings/ObjectIds, not enforced by cross-database foreign keys.

```mermaid
erDiagram
  USERS ||--o{ ACCOUNT_OPERATIONS : records
  USERS ||--o{ PAYMENTS : pays
  STUDENTS ||--|| TUITION_INVOICES : billed
  PAYMENTS ||--o| OTP_CHALLENGES : verifies
  PAYMENTS ||--o| RECEIPT_OUTBOX : notifies
  USERS { ObjectId id PK string username UK string passwordHash string fullName string phone string email int balance }
  ACCOUNT_OPERATIONS { ObjectId id PK string operationId UK ObjectId userId enum type int amount datetime createdAt }
  STUDENTS { ObjectId id PK string studentCode UK string fullName string faculty string major }
  TUITION_INVOICES { ObjectId id PK ObjectId studentId UK string studentCode UK int amount string status string processingPaymentId datetime paidAt }
  PAYMENTS { ObjectId id PK string transactionCode UK string payerId string studentCode int amount string status string idempotencyKey datetime createdAt }
  OTP_CHALLENGES { ObjectId id PK string transactionId UK string email string otpHash datetime expiresAt bool used int attempts }
  RECEIPT_OUTBOX { ObjectId id PK string paymentId UK string status int attempts datetime nextAttemptAt }
```

Indexes: username; studentCode; invoice studentCode/studentId unique; payerId+idempotencyKey unique; transactionCode; payerId+createdAt; OTP transactionId unique and expiresAt TTL; operationId unique; outbox paymentId unique. Amounts are integer VND.

## Sequence — payment and OTP

```mermaid
sequenceDiagram
  actor User
  participant UI as React
  participant GW as Gateway
  participant Pay as Payment Service
  participant Tuition as Tuition Service
  participant Auth as Auth Service
  participant Notify as Notification Service
  User->>UI: nhập MSSV + đồng ý điều khoản
  UI->>GW: POST /api/payments + Idempotency-Key
  GW->>Pay: JWT + request
  Pay->>Tuition: GET student/invoice
  Pay->>Auth: đọc tài khoản/số dư
  Pay->>Pay: lưu RESERVING payment
  Pay->>Tuition: reserve UNPAID → PROCESSING
  Pay->>Notify: tạo OTP hash, lưu challenge và gửi Gmail
  Notify-->>UI: chỉ expiry/email masked (không có OTP)
  User->>UI: nhập OTP
  UI->>GW: POST /api/otp/verify
  GW->>Pay: JWT + code
  Pay->>Notify: verify OTP và tiêu thụ một lần
  UI->>GW: POST /api/payments/confirm
  GW->>Pay: JWT + transactionId
  Pay->>Auth: debit(operationId) trong DB transaction
  Pay->>Tuition: settle PROCESSING → PAID
  Pay->>Pay: SUCCEEDED + receipt outbox
  Pay->>Notify: gửi email biên nhận (outbox retry)
  Pay-->>UI: kết quả + trạng thái
```

## Sequence — Saga compensation / retry

```mermaid
sequenceDiagram
  participant Pay as Payment Orchestrator
  participant Auth as Auth DB Service
  participant Tuition as Tuition DB Service
  Pay->>Tuition: reserve invoice
  Tuition-->>Pay: PROCESSING(paymentId)
  Pay->>Auth: debit(operationId)
  Auth-->>Pay: balance debited, operation recorded
  Pay->>Tuition: settle invoice
  alt invoice definitively rejected
    Tuition-->>Pay: 409 conflict
    Pay->>Auth: credit(compensate:paymentId)
    Pay->>Tuition: release reservation
    Pay->>Pay: FAILED + reason
  else service temporarily unavailable
    Tuition--xPay: timeout / 5xx
    Pay->>Pay: retain DEBITED state
    loop recovery worker every 3 seconds
      Pay->>Tuition: retry settle
    end
  else accepted
    Tuition-->>Pay: PAID
    Pay->>Pay: SUCCEEDED
  end
```

The compensation credit has its own unique operation id. Retrying debit is idempotent; a later retry can resume from `DEBITED`. A process failure after DB commit is therefore recoverable, while notification receipt retries use a persistent outbox.

## Sequence — concurrent transactions

```mermaid
sequenceDiagram
  participant P1 as Payment request A
  participant P2 as Payment request B
  participant Auth as Auth Service
  participant Tuition as Tuition Service
  P1->>Tuition: reserve invoice X (status UNPAID)
  P2->>Tuition: reserve invoice X (status UNPAID)
  Tuition-->>P1: atomic update wins → PROCESSING
  Tuition-->>P2: conditional update returns 409
  par same-wallet race
    P1->>Auth: debit amount with balance ≥ amount + unique operation id
    P2->>Auth: debit competing amount with balance ≥ amount
  end
  Auth-->>P1: transaction commits once
  Auth-->>P2: conditional update fails / 409
```

For same-wallet payments, the transaction plus conditional balance update prevents negative balances. For same invoice, the `UNPAID` conditional update serializes reservations; the unique invoice document and paymentId ownership prevent a second settlement. The UI is not part of either lock.

## State transitions

Payment: `RESERVING → OTP_PENDING → OTP_VERIFIED → DEBITED → SUCCEEDED`; definitive failure becomes `FAILED`. Tuition invoice: `UNPAID → PROCESSING → PAID`, or compensation returns `PROCESSING → UNPAID`. OTP has `unused → used` and expires independently. Notification failure after success does not reverse a completed payment; outbox retries the receipt.


