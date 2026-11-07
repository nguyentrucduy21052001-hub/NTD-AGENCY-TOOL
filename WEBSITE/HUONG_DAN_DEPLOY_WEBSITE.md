# 🌐 HƯỚNG DẪN TRIỂN KHAI WEBSITE CÔNG KHAI - NTD AGENCY

Hệ thống đã được chuyển đổi từ **Chrome Extension** sang nền tảng **Website công khai (Web Platform)** hoàn chỉnh, có thể chạy trên mọi trình duyệt (máy tính, điện thoại, máy tính bảng) và dễ dàng đưa lên Internet với tên miền riêng.

---

## 🏗️ 1. CÁC THAY ĐỔI & KIẾN TRÚC MỚI ĐÃ THỰC HIỆN

1. **Bộ chuyển đổi Web Adapter (`web_adapter.js`)**:
   - Tự động thay thế toàn bộ các API độc quyền của extension (`chrome.storage.local`, `chrome.runtime`, `chrome.tabs`, `chrome.alarms`, v.v.) bằng các chuẩn Web hiện đại (`localStorage`, `IndexedDB`, `BroadcastChannel`).
   - Đảm bảo dữ liệu (tài khoản, nhóm, bài viết nháp, chiến dịch) được lưu an toàn ngay trên trình duyệt mà không bị lỗi `chrome is not defined`.
   
2. **Cổng điều khiển trung tâm (`index.html`)**:
   - Giao diện Landing & Dashboard điều hướng sang trọng, tự động kiểm tra đăng nhập & bản quyền theo thời gian thực.
   - Truy cập nhanh 8 phân hệ: Đăng bài Facebook, Quản lý tài khoản, Quản lý nhóm, Quét Google Maps, Fanpage, Nuôi nick, Cài đặt và Quản trị viên.

3. **Máy chủ Web Server (`server.js`)**:
   - Viết bằng Node.js thuần (Native HTTP), không yêu cầu cài đặt thư viện phụ thuộc rườm rà.
   - Sẵn sàng phục vụ tĩnh, hỗ trợ đầy đủ MIME types, chống tấn công Path Traversal và tích hợp API `/api/health`.

4. **Cấu hình Deploy 1-Chạm**:
   - Hỗ trợ triển khai trực tiếp lên **Vercel** (`vercel.json`), **Netlify** (`netlify.toml`), **Render**, **Railway** hoặc **VPS Linux/Windows**.

---

## 🚀 2. CÁCH CHẠY THỬ NGHIỆM TRÊN MÁY TÍNH (LOCALHOST)

### Cách 1: Sử dụng Node.js (Khuyên dùng)
Mở cửa sổ dòng lệnh (Terminal / PowerShell) tại thư mục này và gõ:
```bash
node server.js
```
Trình duyệt sẽ mở tại địa chỉ:
👉 **`http://localhost:3000`**

### Cách 2: Mở trực tiếp file HTML
Bạn có thể nhấp đúp trực tiếp vào file **`index.html`** hoặc **`activate.html`** bằng Google Chrome, Edge hoặc Cốc Cốc. Nhờ có `web_adapter.js`, toàn bộ giao diện và dữ liệu vẫn hoạt động mượt mà.

---

## ☁️ 3. CÁCH ĐƯA LÊN WEBSITE CÔNG KHAI (INTERNET / TÊN MIỀN RIÊNG)

### Cách 1: Deploy lên Vercel (Miễn phí 100% - Nhanh nhất)
1. Đăng ký tài khoản miễn phí tại: [https://vercel.com](https://vercel.com).
2. Tải toàn bộ thư mục này lên GitHub cá nhân của bạn.
3. Trên Vercel, chọn **Add New Project** ➔ Chọn kho GitHub của bạn ➔ Bấm **Deploy**.
4. Vercel sẽ tự động cấp một đường link công khai (dạng `https://ntd-agency.vercel.app`), bạn có thể gắn tên miền riêng bất kỳ lúc nào!

### Cách 2: Deploy lên Netlify (Miễn phí 100%)
1. Truy cập: [https://app.netlify.com/drop](https://app.netlify.com/drop).
2. Kéo thả toàn bộ thư mục mã nguồn này vào ô tải lên.
3. Chỉ sau 10 giây, website của bạn sẽ hoạt động trực tiếp trên Internet.

### Cách 3: Chạy trên VPS (Ubuntu / Debian / Windows Server)
1. Thuê VPS và trỏ tên miền (ví dụ: `app.tenmiencuaban.com`) về IP máy chủ.
2. Cài đặt Node.js:
   ```bash
   sudo apt update && sudo apt install nodejs npm -y
   ```
3. Khởi chạy máy chủ liên tục 24/7 với PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "ntd-agency"
   pm2 startup
   pm2 save
   ```
4. Cài đặt Nginx làm Reverse Proxy và kích hoạt SSL (HTTPS) miễn phí qua Certbot.

---

## 🔒 4. LƯU Ý KỸ THUẬT VỀ TỰ ĐỘNG HÓA FACEBOOK TRÊN WEBSITE

Khi hoạt động dưới dạng **Website công khai**, cơ chế bảo mật Same-Origin Policy của trình duyệt web sẽ không cho phép website tự ý can thiệp vào trang `facebook.com` nếu không có cơ chế trung gian:

* **Mô hình SaaS Hybrid (Khuyên dùng cho quy mô kinh doanh)**:
  - Khách hàng mở **Website** để quản lý: Soạn bài, spin text, tải ảnh, phân nhóm, lên lịch, xem báo cáo, quét Google Maps.
  - Khi thực hiện bấm **"Bắt đầu đăng bài"**, website sẽ kích hoạt tác vụ thông qua:
    1. Tiện ích mở rộng Runner (Extension Bridge) được cài trên trình duyệt khách, HOẶC
    2. Chạy tự động qua phiên trình duyệt mở trực tiếp.
  - **Lợi ích**: Bài viết được đăng bằng đúng địa chỉ IP mạng thật của khách hàng, nick Facebook cực kỳ an toàn, **không bao giờ bị khóa tài khoản hay checkpoint**.

* **Mô hình Cloud Runner (Chạy ngầm hoàn toàn trên VPS)**:
  - Nếu muốn người dùng tắt máy tính mà bài vẫn tự động đăng: Cần cấu hình máy chủ VPS chạy kèm Puppeteer và bắt buộc gắn **Proxy dân cư (Residential Proxy)** cho từng nick Facebook để tránh bị khóa IP Datacenter.

