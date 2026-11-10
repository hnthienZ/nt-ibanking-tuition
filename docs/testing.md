# Kiểm thử và trình diễn

## Chuẩn bị

1. Đảm bảo MongoDB replica set đang chạy, cấu hình `.env` và seed dữ liệu demo nếu cần.
2. Với luồng OTP email end-to-end, cấu hình Gmail App Password theo [email-otp-guide.md](email-otp-guide.md), rồi khởi động `npm run dev`.
3. Xác nhận `http://127.0.0.1:4004/health` báo `data.emailMode: "SMTP"`. Chạy `npm run test:notification` để kiểm tra cấu hình và mẫu email.
4. Dùng Postman để chạy Login → Tuition lookup → Create payment (gửi OTP) → nhập OTP từ Gmail → Verify OTP → Confirm payment. `npm test` chỉ chạy unit tests và smoke checks an toàn; kiểm thử nghiệp vụ giao dịch trực tiếp bằng Postman với Gmail thật.

Không có OTP giả hoặc OTP trong log. Khi SMTP chưa cấu hình, dịch vụ phát triển có thể chạy nhưng endpoint gửi OTP trả `503`.

## Acceptance

| # | Kịch bản | Kết quả mong đợi |
|---:|---|---|
| 1–2 | Đăng nhập đúng/sai | 200 với cookie HttpOnly / 401 |
| 3–4 | Tra cứu MSSV có/không tồn tại | 200 / 404 |
| 5 | OTP email hợp lệ, sau đó Confirm | Payment `SUCCEEDED`, số dư giảm đúng, invoice `PAID`, history và receipt email đúng |
| 6–7 | Không đủ số dư / invoice đã thanh toán | Từ chối, không debit |
| 8–9 | OTP sai / hết hạn | 400 hoặc giới hạn lần thử 429 / 410; hết hạn hoặc khóa thì payment bị hủy và không debit |
| 10–11 | OTP dùng lại / dùng nhầm giao dịch | Không debit lần hai / bị từ chối |
| 12 | Hai thanh toán đồng thời trên một ví | Không vượt số dư, tối đa một debit đủ điều kiện |
| 13 | Hai ví cùng thanh toán một MSSV | Chỉ một reservation thắng |
| 14 | Lặp request với cùng idempotency key | Không sinh giao dịch/debit thứ hai |
| 15 | Lỗi dịch vụ giữa Saga | Trạng thái có thể phục hồi hoặc compensation; không báo thành công sai |

Các script `demo:otp`, `demo:concurrency`, `demo:compensation` yêu cầu email nhận OTP và có thể làm thay đổi dữ liệu mẫu. Seed lại chỉ khi bạn chấp nhận reset demo data.
