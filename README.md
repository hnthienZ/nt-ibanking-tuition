# NT iBANKING — Tuition Payment

**Tên đầy đủ:** NT iBanking – Internet Banking System  
**Phân hệ:** Tuition Payment – Thanh toán học phí

> Hệ thống mô phỏng phục vụ môn Kiến trúc hướng dịch vụ. Người dùng đăng nhập, tra cứu học phí, thanh toán toàn bộ hóa đơn bằng số dư tài khoản, xác thực OTP qua email, xem lịch sử và nhận biên nhận. Đây không phải ứng dụng ngân hàng thật và không kết nối hệ thống thanh toán bên ngoài.

## 1. Phạm vi và yêu cầu nghiệp vụ

- Đăng nhập bằng username/password; không có đăng ký. Mật khẩu được hash bằng bcrypt, phiên đăng nhập dùng JWT trong cookie `HttpOnly`.
- Người nộp tiền được lấy từ tài khoản đang đăng nhập. Người dùng có thể trả học phí cho chính mình hoặc sinh viên khác. Thông tin người nộp và hồ sơ sinh viên là chỉ đọc trên màn hình thanh toán.
- Nhập MSSV để tra cứu sinh viên, khoa/ngành và hóa đơn. Chỉ trả toàn bộ hóa đơn; không hỗ trợ trả một phần.
- Chỉ tạo giao dịch khi hóa đơn chưa thanh toán, người dùng đồng ý điều khoản và số dư đủ.
- OTP gồm 6 chữ số, gửi đến email đã lưu trên tài khoản người nộp, gắn với giao dịch, lưu dạng HMAC hash, hết hạn sau 5 phút, chỉ xác thực một lần, tối đa 5 lần nhập sai và chờ 60 giây trước khi gửi lại. Mã OTP không trả về API, giao diện hoặc log.
- Sau khi OTP hợp lệ, backend kiểm tra lại số dư/hóa đơn, trừ tiền, chốt hóa đơn `PAID`, ghi lịch sử và xếp email biên nhận vào outbox.
- Hệ thống bảo vệ giao dịch đồng thời bằng conditional updates, reservation hóa đơn `UNPAID → PROCESSING → PAID`, idempotency key và Saga compensation. Mỗi service sở hữu dữ liệu của mình.

## 2. Công nghệ và kiến trúc

- **Frontend:** React, Vite, Tailwind CSS, React Router, Axios, Lucide React.
- **Backend:** Node.js, Express, REST API, JWT, bcryptjs, Zod, Mongoose, Nodemailer.
- **Database:** MongoDB replica set `rs0` để hỗ trợ transaction/consistency.
- **Email:** Gmail SMTP dùng Google App Password; không dùng mật khẩu đăng nhập Google.
- **Microservices:**
  1. API Gateway (`4000`) — entry point cho frontend, xác thực/định tuyến API và phục vụ frontend build.
  2. Auth Service (`4001`) — tài khoản, đăng nhập, số dư và debit/credit có điều kiện.
  3. Tuition Service (`4002`) — sinh viên, hóa đơn, giữ/chốt/nhả hóa đơn.
  4. Payment Service (`4003`) — điều phối thanh toán, idempotency, Saga, lịch sử và outbox biên nhận.
  5. Notification Service (`4004`) — OTP, xác thực OTP và email biên nhận.

Các service trao đổi REST nội bộ qua service token. Frontend gọi API Gateway qua Vite proxy; không gọi trực tiếp các service nội bộ.

Sơ đồ, ERD và luồng tuần tự: [docs/architecture.md](docs/architecture.md). Danh sách API: [docs/api.md](docs/api.md).

## 3. Yêu cầu cài đặt

- Windows 10/11, VS Code và PowerShell.
- Node.js **20.19+** (khuyến nghị Node 22 hoặc mới hơn) và npm.
- MongoDB **Server** chạy local trên `127.0.0.1:27017`, được cấu hình replica set tên `rs0`. MongoDB Compass chỉ là giao diện quản lý, không phải database server.
- Một tài khoản Gmail có thể tạo Google App Password để gửi email thật. Người nhận OTP là email đang lưu ở tài khoản payer trong MongoDB, không nhất thiết phải trùng email gửi.

## 4. Cài đặt lần đầu

Mở PowerShell tại thư mục gốc của repository (thư mục có `package.json`) rồi chạy:

```powershell
Copy-Item .env.example .env # chỉ lần đầu, nếu chưa có .env
npm install
```

`Copy-Item` chỉ dùng lần đầu khi chưa có `.env`; không chạy lại để tránh ghi đè cấu hình Gmail hiện có. Hãy mở **`ibanking-tuition/.env`** trong VS Code (không phải `.env` ở thư mục cha) và kiểm tra:

```dotenv
MONGO_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0
JWT_SECRET=thay-bang-chuoi-bi-mat-dai-va-ngau-nhien
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=your_google_app_password
MAIL_FROM='"NT iBANKING" <your_gmail@gmail.com>'
OTP_PEPPER=thay-bang-chuoi-bi-mat-khac
```

Thay giá trị ví dụ bằng cấu hình của bạn. `SMTP_USER` là Gmail gửi thư; `SMTP_PASS` là App Password 16 ký tự, dán liền không có khoảng trắng; địa chỉ trong `MAIL_FROM` phải khớp `SMTP_USER`. Không đưa mật khẩu vào README, Postman, ảnh chụp hoặc Git. Hướng dẫn tạo App Password và xử lý lỗi Gmail: [docs/email-otp-guide.md](docs/email-otp-guide.md).

Nếu chưa có App Password, có thể để **cả bốn biến** `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` rỗng để mở giao diện và kiểm tra các API không gửi mail. Notification Service sẽ ở chế độ `DISABLED`; gửi OTP/biên nhận trả `503`, nên không thể demo thanh toán hoàn tất. Không có OTP giả trong response.

### MongoDB replica set

Replica set cần được bật trên MongoDB Server, không phải tạo trong Compass. `.env.example` dùng URI `replicaSet=rs0`; MongoDB Server phải khởi động với tên replica set đó.

Trên Windows, nếu MongoDB Server đã cài như một service:

1. Mở **Services** trong Windows, tìm dịch vụ MongoDB, mở **Properties** và xem **Path to executable** để xác định file `mongod.cfg` đang được dùng.
2. Mở `mongod.cfg` bằng Notepad/VS Code với quyền Administrator. Thêm cấu hình dưới đây ở cấp gốc (không đặt dưới phần `#replication:` đang comment):

   ```yaml
   replication:
     replSetName: rs0
   ```

3. Lưu file và khởi động lại dịch vụ MongoDB từ Services.
4. Mở MongoDB Shell (`mongosh`) hoặc Compass → **Open MongoDB shell**, kết nối tới `127.0.0.1:27017` rồi chạy một lần:

   ```javascript
   rs.initiate({
     _id: "rs0",
     members: [{ _id: 0, host: "127.0.0.1:27017" }]
   })
   ```

5. Xác nhận `rs.status().ok` trả về `1`; prompt thường hiện `rs0 [direct: primary]`. Nếu replica set đã được khởi tạo thì không chạy `rs.initiate()` lần nữa.

Hướng dẫn chính thức: [Convert a Standalone to a Replica Set](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/).

## 5. Tạo dữ liệu demo (lần đầu)

Nếu muốn nhận OTP thật trên Gmail của mình, trước khi seed hãy đặt `DEMO2_EMAIL` trong `.env` thành email bạn có thể mở, sau đó chạy:

```powershell
npm run seed
```

Seed tạo ba tài khoản, 10 sinh viên và 10 hóa đơn. **Lưu ý:** seed xóa/khởi tạo lại dữ liệu nghiệp vụ demo (số dư, trạng thái hóa đơn, lịch sử/giao dịch); không chạy nếu cần giữ dữ liệu hiện tại. Nếu đã seed rồi, thay `DEMO2_EMAIL` đơn thuần không cập nhật email của user trong MongoDB. Có thể cập nhật trường `email` của user `demo2` tại `ibanking_auth.users` bằng Compass, hoặc chủ động seed lại và chấp nhận reset dữ liệu.

### Tài khoản và dữ liệu mẫu

Mật khẩu seed cho cả ba tài khoản là `Midterm2026!`.

| Username | Số dư seed | Email mặc định |
|---|---:|---|
| `demo` | 30.000.000 ₫ | `demo@example.com` |
| `demo2` | 30.000.000 ₫ | `demo2@example.com` |
| `demo3` | 5.000.000 ₫ | `demo3@example.com` |

`demo2` phù hợp để demo Gmail thật nếu email của tài khoản đã được cập nhật thành email bạn truy cập được. Đăng nhập vào giao diện bằng username và mật khẩu seed.

| MSSV | Trạng thái ban đầu | Học phí |
|---|---|---:|
| `521H0001` | UNPAID | 23.500.000 ₫ |
| `521H0002` | UNPAID | 18.750.000 ₫ |
| `521H0003` | UNPAID | 5.000.000 ₫ |
| `521H0004` | UNPAID | 2.000.000 ₫ |
| `521H0005` | PAID | 6.500.000 ₫ |
| `521H0006`–`521H0010` | UNPAID | Xem màn hình tra cứu |

## 6. Khởi chạy toàn hệ thống

Đảm bảo MongoDB Server đang chạy, `.env` đã lưu và không còn phiên cũ chiếm cổng. Từ **một** PowerShell ở thư mục `ibanking-tuition`, chạy:

```powershell
npm run dev
```

Đây là lệnh duy nhất cần để chạy Vite frontend, Gateway và bốn service backend. Chờ terminal báo các service đã mở cổng `4000–4004`, MongoDB đã kết nối, và Notification Service ở chế độ `SMTP`. Gmail cần cấu hình đúng; nếu gặp `EAUTH`, kiểm tra `SMTP_USER` và App Password trong đúng file `.env`.

- **Giao diện:** http://127.0.0.1:5173
- **API Gateway health (JSON):** http://127.0.0.1:4000/health
- **Notification health (JSON):** http://127.0.0.1:4004/health — `data.emailMode` phải là `SMTP` để gửi email thật.

Mở **5173** để dùng website; địa chỉ health chỉ trả trạng thái dịch vụ, không phải giao diện. Giữ PowerShell đang chạy; nhấn `Ctrl+C` trong cửa sổ đó để dừng toàn bộ stack. Không chạy thêm lệnh `npm run dev:*` song song vì có thể chiếm cổng.

## 7. Trình tự demo theo đề bài

### A. Demo luồng thanh toán thành công trên giao diện

1. Chạy `npm run dev`, xác nhận frontend mở được tại `http://127.0.0.1:5173` và health Notification báo `SMTP`.
2. Đăng nhập bằng `demo2` / `Midterm2026!`. Giải thích dashboard hiển thị người dùng, số dư và giao dịch gần đây; mở **Tài khoản**/**Thông tin cá nhân** để xem hồ sơ và email nhận OTP.
3. Mở **Thanh toán học phí**, nhập MSSV chưa thanh toán, ví dụ `521H0004`. Hệ thống tra cứu tự động; giải thích thông tin sinh viên và người nộp tiền không sửa được, khoản tiền thanh toán là toàn bộ hóa đơn.
4. Kiểm tra số dư và hóa đơn, tích đồng ý điều khoản, bấm **Xác nhận & nhận OTP**. Backend tạo giao dịch, giữ hóa đơn, rồi Notification gửi OTP đến email của `demo2` trong MongoDB. Không gửi OTP cho người khác.
5. Mở Gmail của tài khoản người nộp, lấy OTP 6 chữ số và nhập trên màn hình chi tiết giao dịch trong vòng 5 phút. Nếu cần gửi lại, chờ nút hết đếm ngược 60 giây.
6. Sau khi OTP hợp lệ, xác nhận thanh toán. Trình bày trang kết quả/chi tiết, số dư giảm đúng một lần, hóa đơn chuyển sang `PAID`, và giao dịch xuất hiện trong **Lịch sử giao dịch**.
7. Kiểm tra hộp thư để xem email biên nhận thành công có mã giao dịch, MSSV, tên sinh viên, số tiền, số dư còn lại và thời gian.

### B. Demo các trường hợp từ chối

- Tra cứu `521H0005` để thấy hóa đơn `PAID`; nút thanh toán không khả dụng.
- Nhập MSSV không tồn tại để minh họa lỗi tra cứu.
- Bỏ chọn điều khoản hoặc chọn hóa đơn lớn hơn số dư để thấy không thể tạo giao dịch.
- Trong giao dịch chờ OTP, nhập OTP sai; backend từ chối và không trừ số dư. OTP hết hạn sau 5 phút; quá 5 lần nhập sai sẽ khóa/hủy giao dịch và nhả reservation hóa đơn.
- Bấm gửi lại OTP liên tục; backend áp dụng cooldown 60 giây và giới hạn số lần gửi lại.

### C. Demo Postman

Import [postman/NT-iBanking.postman_collection.json](postman/NT-iBanking.postman_collection.json). Chọn collection variables `baseUrl=http://127.0.0.1:4000/api`, username/password và MSSV. Chạy lần lượt **Login → Tuition lookup → Create payment**. Login lưu cookie phiên; Create payment gửi OTP, nhưng không lấy/hiển thị OTP trong response. Đọc mã từ Gmail, điền biến `otp`, rồi chạy **Verify OTP → Confirm payment → Payment history/detail**. Chi tiết request/response và status code: [docs/api.md](docs/api.md).

### D. Trình bày concurrency và tính nhất quán

Giải thích hai khóa nghiệp vụ trong code: debit ví là conditional/idempotent theo operation id; hóa đơn được reserve có điều kiện nên chỉ một payment giữ được cùng MSSV. Nêu kết quả cần đạt: ví không âm, hóa đơn chỉ trả một lần, request gửi lặp không debit lần hai, Saga có bù trừ nếu chốt hóa đơn thất bại.

`npm run demo:concurrency` là demo tương tác, gửi OTP thật đến email của các payer và **làm thay đổi dữ liệu**; chỉ chạy sau khi đã seed, đã cập nhật email nhận được và chấp nhận dùng các MSSV demo. Script dùng các hóa đơn `521H0001`, `521H0002`, `521H0003`, hỏi nhập các OTP và xác nhận đồng thời hai giao dịch trên cùng ví, rồi cạnh tranh cùng một MSSV từ hai tài khoản. Seed lại để đưa trạng thái mẫu về ban đầu.

`npm run demo:compensation` mô phỏng tình huống hóa đơn bị một giao dịch khác chốt giữa quy trình để minh họa Saga hoàn tiền. Đây là script demo nâng cao, can thiệp trạng thái một hóa đơn seed rồi khôi phục; chỉ chạy trên dữ liệu demo sau khi đọc source script và sẵn sàng seed lại nếu cần. Không dùng trên dữ liệu cần giữ.

## 8. API chính

Frontend/Postman gọi qua API Gateway. API có đăng nhập yêu cầu cookie phiên; response thống nhất dạng `success/data` hoặc `success/error`.

| Method | Endpoint | Mục đích |
|---|---|---|
| `POST` | `/api/auth/login` | Đăng nhập |
| `POST` | `/api/auth/logout` | Đăng xuất, xóa cookie |
| `GET` | `/api/auth/me` | Tài khoản phiên hiện tại |
| `GET` | `/api/users/profile` | Hồ sơ người dùng |
| `GET` | `/api/users/balance` | Số dư khả dụng |
| `GET` | `/api/students/:studentCode` | Tra cứu sinh viên |
| `GET` | `/api/tuition/:studentCode` | Tra cứu hóa đơn |
| `POST` | `/api/payments` | Tạo giao dịch và gửi OTP |
| `POST` | `/api/otp/send` | Gửi lại OTP sau cooldown |
| `POST` | `/api/otp/verify` | Xác thực OTP một lần |
| `POST` | `/api/payments/confirm` | Tiếp tục Saga, hoàn tất debit/chốt hóa đơn |
| `GET` | `/api/payments/history` | Lịch sử của payer hiện tại |
| `GET` | `/api/payments/:id` | Chi tiết giao dịch thuộc payer |

Xem payload, status code, lỗi và API nội bộ tại [docs/api.md](docs/api.md). Các API service-to-service không gọi trực tiếp từ trình duyệt.

## 9. Kiểm thử và build

Các lệnh dưới đây chạy từ thư mục project:

```powershell
npm run test:notification
npm test
npm run build
```

`npm test` chạy unit test Notification và smoke test nếu Gateway đang hoạt động; smoke test không tạo giao dịch/gửi email/reset dữ liệu. Build sinh frontend production trong `frontend/dist`; Gateway phục vụ build đó khi dùng cấu hình production tương ứng. Ma trận nghiệp vụ, kết quả mong đợi và tình huống kiểm thử: [docs/testing.md](docs/testing.md).

## 10. Xử lý lỗi thường gặp

| Triệu chứng | Cách kiểm tra |
|---|---|
| `ERR_CONNECTION_REFUSED` tại `:5173` | Hệ thống chưa chạy hoặc supervisor đã dừng. Xem lỗi đầu tiên trong PowerShell, khởi động lại bằng `npm run dev`. |
| EADDRINUSE / port đang được dùng | Dừng phiên cũ bằng `Ctrl+C` tại terminal của nó; kiểm tra `netstat -ano \| findstr :5173` (lặp lại với cổng lỗi). Không đổi port riêng lẻ; các URL service phải đồng bộ. |
| MongoDB replica set/server selection timeout | Khởi động MongoDB Server, kiểm tra URI có `replicaSet=rs0` và replica set `rs0` đã được khởi tạo. Compass connected không đồng nghĩa server được cấu hình replica set. |
| Notification báo `EAUTH` | Dùng Gmail tạo App Password; `SMTP_USER` phải là tài khoản tạo App Password, `SMTP_PASS` phải là App Password mới (không phải Gmail password), `MAIL_FROM` phải cùng địa chỉ. Lưu `.env` và khởi động lại. |
| Email không tới | Kiểm tra `ibanking_auth.users` → user payer → `email`; chính email này nhận OTP. Kiểm tra Spam/Promotions và `http://127.0.0.1:4004/health`. |
| `503` khi gửi OTP | Notification chưa có SMTP hợp lệ hoặc Gmail tạm thời không gửi được. Hệ thống không giả vờ đã gửi mail và không trả OTP thay thế. |
| Cổng không mở sau khi sửa `.env` | Lưu đúng `ibanking-tuition/.env`, kiểm tra không có biến SMTP điền dở dang; tắt phiên cũ rồi chạy lại `npm run dev`. |

## 11. Tài liệu và source

- [Phân tích, kiến trúc, Use Case, ERD, sequence diagrams](docs/architecture.md)
- [REST API](docs/api.md)
- [Kiểm thử](docs/testing.md)
- [Cấu hình Gmail OTP](docs/email-otp-guide.md)
- [Postman collection](postman/NT-iBanking.postman_collection.json)
- Source microservices: `backend/`; frontend: `frontend/`; scripts demo: `scripts/`.

## 12. Đưa project lên GitHub và để thành viên khác chạy

### Tạo repository và push lần đầu

1. Trên GitHub, chọn **New repository**. Đặt tên, ví dụ `nt-ibanking-tuition`. Chọn Public nếu giảng viên/nhóm cần truy cập công khai, hoặc Private và thêm thành viên trong mục **Settings → Collaborators**. Tạo repository **trống**; không chọn tạo README, `.gitignore` hay license vì các file này đã có trong project.
2. Mở PowerShell tại thư mục `ibanking-tuition` (đây là repository cần push, không phải thư mục Midterm bên ngoài). Kiểm tra Git đã cài:

   ```powershell
   git --version
   ```

3. Khởi tạo Git, kiểm tra file được đưa vào staging và commit:

   ```powershell
   git init -b main
   git add .
   git status --short
   git check-ignore .env
   ```

   Trong `git status`, cần thấy source, docs, Postman collection, `.env.example` và `.gitignore`; **không được thấy `.env`**. `git check-ignore .env` phải xác nhận `.env` đang bị bỏ qua. Nếu `.env` xuất hiện trong danh sách staged, dừng lại và bỏ nó khỏi staging trước khi commit:

   ```powershell
   git restore --staged .env
   ```

   Sau khi kiểm tra, commit:

   ```powershell
   git commit -m "Build NT iBanking tuition payment demo"
   ```

4. Thay `<USERNAME>` bằng tên tài khoản GitHub của bạn rồi liên kết repository và push:

   ```powershell
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/nt-ibanking-tuition.git
   git push -u origin main
   ```

   Thay `YOUR_GITHUB_USERNAME` bằng username GitHub thật. Nếu repository của bạn có tên khác, dùng URL mà GitHub hiển thị. GitHub có thể yêu cầu đăng nhập qua trình duyệt hoặc credential manager. Không gửi token/mật khẩu GitHub trong chat.

### Thành viên khác clone và chạy demo

```powershell
git clone https://github.com/YOUR_GITHUB_USERNAME/nt-ibanking-tuition.git
cd nt-ibanking-tuition
Copy-Item .env.example .env
npm install
```

Sau đó mỗi thành viên tự cấu hình MongoDB replica set `rs0` và Gmail SMTP trong `.env` của máy mình theo các mục phía trên. Họ cần đặt `DEMO2_EMAIL` thành email nhận OTP của chính họ **trước khi seed**, rồi chạy `npm run seed` nếu cơ sở dữ liệu demo chưa có. Cuối cùng chạy `npm run dev` và mở `http://127.0.0.1:5173`. Không chia sẻ file `.env`; mỗi máy tạo file riêng.

Nếu đã khởi tạo Git từ thư mục cha `Midterm` thay vì `ibanking-tuition`, đừng push toàn bộ thư mục cha vì nó có `.env`, `.venv` và source FastAPI cũ. Tạo repository trong riêng thư mục `ibanking-tuition` như các bước trên.

### Ghi chú bảo mật

- Không commit `.env`; repository chỉ cung cấp `.env.example`.
- Không chia sẻ App Password. Nếu đã lộ trong ảnh/chat, hãy thu hồi App Password đó trong Google Account và tạo cái mới.
- Email OTP chỉ đi đến email tài khoản đang đăng nhập; không nhập email tùy ý để đổi người nhận.
- Đây là project học tập; dữ liệu seed và giao dịch không đại diện cho tài khoản ngân hàng thật.
