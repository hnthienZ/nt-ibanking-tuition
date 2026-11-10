# REST API

## Quy ước

Frontend gọi API qua API Gateway `http://127.0.0.1:4000/api` (Vite dev proxy tại `:5173`). Login đặt JWT vào cookie `ibanking_session` có `HttpOnly`, `SameSite=Strict`, `Path=/`; endpoint có yêu cầu đăng nhập sẽ trả `401` khi cookie không hợp lệ. API nội bộ dùng `x-service-token` và không gọi từ trình duyệt.

Success: `{"success":true,"data":{...}}`. Error: `{"success":false,"error":{"code":"...","message":"..."}}`. Các amount là số nguyên VND.

## Public API

| Method / URI | Auth | Input | Success | Lỗi chính |
|---|---|---|---|---|
| `POST /api/auth/login` | Không | `{ "username":"demo", "password":"Midterm2026!" }` | `200`, user profile; đồng thời đặt cookie JWT | `400` validate, `401` sai credentials, `503` upstream |
| `POST /api/auth/logout` | Không | — | `200 {loggedOut:true}`; xóa cookie | — |
| `GET /api/auth/me` | JWT | — | `200 {user}` | `401` token lỗi/hết hạn |
| `GET /api/users/profile` | JWT | — | `200 {user:{username,fullName,phone,email,balance}}` | `401` |
| `GET /api/users/balance` | JWT | — | `200 {balance,currency}` | `401` |
| `GET /api/students/{studentCode}` | JWT | — | `200 {student}` | `404` không có MSSV |
| `GET /api/tuition/{studentCode}` | JWT | — | `200 {student,invoice:{amount,status,term}}` | `404` không có sinh viên |
| `POST /api/payments` | JWT | `{ "studentCode":"521H0004", "termsAccepted":true, "idempotencyKey":"UUID" }` | `201 {payment,emailMasked,otpExpiresAt,otpResendAvailableAt,emailSent}`; reserves the invoice and sends the OTP to the signed-in account email, without exposing the code | `400` input, `404` student/invoice, `409` insufficient/paid/processing, `503` Gmail unavailable |
| `POST /api/otp/send` | JWT | `{ "transactionId":"ObjectId" }` | Resends OTP to the account email after the 60-second cooldown; response has expiry/resend metadata, never the code | `401`, `404`, `409`, `429` cooldown, `503` Gmail unavailable |
| `POST /api/otp/verify` | JWT | `{ "transactionId":"ObjectId", "email":"account email", "otp":"123456" }` | `200 {verified:true,payment}`; marks OTP verified once but does not debit until confirmation | `400` invalid/wrong email, `404`, `409` reused, `410` expired, `429` locked |
| `POST /api/payments/confirm` | JWT | `{ "transactionId":"ObjectId", "email":"account email" }` | `200 {payment}` after Saga debit/settle; receipt queued | `400`, `409` OTP required/state conflict, `503` Saga retry |
| `GET /api/payments/history?page=1&limit=10` | JWT | Query tùy chọn | `200 {items,page,limit,total}`; chỉ payment của user hiện tại | `401` |
| `GET /api/payments/{id}` | JWT | — | `200 {payment}` | `404` không thuộc/không tồn tại |
| `POST /api/payments/{id}/send-otp` | JWT | Legacy alias, no email input | `200 {expiresAt,resendAvailableAt,emailMasked}` | `404`, `409` trạng thái không phù hợp, `429` cooldown, `503` Gmail unavailable |

### Ví dụ tạo giao dịch và gửi OTP

```http
POST /api/payments
Content-Type: application/json
Cookie: ibanking_session=<HttpOnly cookie>
```

```json
{
  "studentCode": "521H0004",
  "termsAccepted": true,
  "idempotencyKey": "b0d8879e-2517-4050-a877-c114a3c1acbb"
}
```

```json
{
  "success": true,
  "data": {
    "payment": {"id":"...","transactionCode":"IBK-...","status":"OTP_PENDING","studentCode":"521H0004","amount":2000000},
    "emailMasked": "de***@gmail.com"
  }
}
```

`POST /api/payments` đã gửi OTP. Đọc OTP trong Gmail, gọi `/api/otp/verify`, rồi `/api/payments/confirm`. API không bao giờ trả OTP. `/api/otp/send` chỉ dùng để gửi lại sau cooldown.

### Ví dụ sai OTP

```json
{"success":false,"error":{"code":"OTP_INVALID","message":"OTP không chính xác."}}
```

## Private service APIs

Các endpoint sau chỉ dành cho service-to-service và yêu cầu `x-service-token`:

| Service | Method / URI | Mục đích |
|---|---|---|
| Auth | `GET /internal/accounts/{userId}` | Đọc profile + balance cần cho Payment |
| Auth | `POST /internal/accounts/{userId}/debit` | Conditional debit; body `{operationId,amount}`; operation id unique |
| Auth | `POST /internal/accounts/{userId}/credit` | Compensation; body `{operationId,amount}`; idempotent |
| Tuition | `POST /internal/invoices/{studentCode}/reserve` | `UNPAID → PROCESSING`; body `{paymentId}` |
| Tuition | `POST /internal/invoices/{studentCode}/settle` | Chốt `PROCESSING → PAID` cho đúng payment |
| Tuition | `POST /internal/invoices/{studentCode}/release` | Compensation `PROCESSING → UNPAID` |
| Notification | `POST /internal/otp/send` | Hash, lưu và gửi OTP qua Gmail |
| Notification | `POST /internal/otp/verify` | Verify/consume OTP theo transactionId |
| Notification | `POST /internal/otp/resend` | Thay OTP cũ, TTL mới |
| Notification | `POST /internal/receipt` | Gửi biên nhận từ outbox |

## Service docs / health

`GET /health` tồn tại ở mỗi service. API Gateway health `:4000/health`, Auth `:4001/health`, Tuition `:4002/health`, Payment `:4003/health`, Notification `:4004/health`. Các service hiện công bố API tường minh trong tài liệu này; chưa tạo OpenAPI UI riêng.

