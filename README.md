# Trợ Lý Slide Mr Quân — bản chạy trên Render

App tạo slide cho giáo viên. Điểm khác với bản tĩnh: việc đọc trang sách
(OCR) đi qua máy chủ này thay vì gọi thẳng `api.ocr.space` từ trình duyệt,
nên không bị chặn/chậm ở mạng nhà trường. Máy chủ chuyển tiếp yêu cầu sang
OCR.space và trả JSON về y nguyên.

## Cài đặt trên Render (Web Service)

| Mục | Giá trị |
| --- | --- |
| Repository | `quandsy/tro-ly-slide-mr-quan` (nhánh `main`) |
| Runtime | Node |
| Region | Oregon |
| Plan | Free |
| Build Command | `echo ok` (không cần npm install — code chỉ dùng thư viện có sẵn của Node 18+) |
| Start Command | `node server.js` |

## Biến môi trường (không bắt buộc)

| Tên | Giá trị |
| --- | --- |
| `OCR_SPACE_API_KEY` | Khóa OCR.space. Để trống thì app dùng khóa miễn phí mặc định `helloworld` (giống bản cũ). Nếu đặt một khóa thật thì máy chủ dùng khóa đó thay cho khóa trình duyệt gửi lên. Lấy khóa miễn phí tại https://ocr.space/ocrapi/freekey |

Render tự đặt biến `PORT`, máy chủ nghe ở cổng đó.

## Tên miền phụ

Sau khi Web Service chạy, trong Render vào **Settings → Custom Domains**,
thêm `slide.nguyenvanquan.io.vn` rồi làm theo hướng dẫn trỏ DNS của Render
(thường là một bản ghi CNAME `slide` → địa chỉ `*.onrender.com` của service,
đặt ở nơi quản lý tên miền `nguyenvanquan.io.vn`).

## Chạy thử ở máy mình

```bash
node server.js
# Mở http://localhost:10000
# Kiểm tra: curl http://localhost:10000/health
```
