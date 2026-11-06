# 📖 HƯỚNG DẪN QUẢN LÝ TÀI KHOẢN, MẬT KHẨU & GIA HẠN (NTD AGENCY)

Hệ thống bản quyền của tiện ích NTD Agency đã được chuyển đổi sang cơ chế: **Tài khoản & Mật khẩu đồng bộ qua Google Sheets**.

---

## 🌟 ĐIỂM NỔI BẬT CỦA HỆ THỐNG MỚI

1. **Khách hàng (Người dùng):**
   - Chỉ cần mở tiện ích lên và nhập **Tài khoản** & **Mật khẩu** do bạn cấp.
   - Không còn phải sao chép Mã máy hay dán các chuỗi key dài dòng phức tạp.
   - Tự động hiển thị thời hạn còn lại (VD: *Hạn dùng: 31/12/2026 - Còn 67 ngày*).

2. **Quản trị viên (Bạn):**
   - **Tạo tài khoản:** Chỉ cần nhập tên tài khoản, mật khẩu và ngày hết hạn.
   - **Gia hạn cực dễ:** Khi khách chuyển khoản gia hạn, bạn chỉ cần mở Google Sheets sửa lại ô **Hạn sử dụng** (hoặc bấm nút Gia hạn trên trang Quản lý). Khách hàng mở lại tiện ích là tự động được gia hạn ngay lập tức!
   - **Khóa 1 tài khoản / 1 máy:** Lần đầu khách đăng nhập, mã máy tính của khách sẽ tự động được ghim vào bảng tính để **chống khách share tài khoản cho người khác dùng chung**.
   - **Đổi máy tính cho khách:** Khi khách mua máy mới hoặc cài lại Win, bạn chỉ cần xóa ô **Mã máy** của khách đó trên Google Sheets là khách có thể đăng nhập trên máy mới.
   - **100% Miễn phí & Tiện lợi:** Dữ liệu lưu trên Google Drive của bạn, có thể xem và chỉnh sửa ngay trên điện thoại hoặc máy tính bất kỳ lúc nào.

---

## 🚀 HƯỚNG DẪN THIẾT LẬP GOOGLE SHEETS (CHỈ LÀM 1 LẦN DUY NHẤT)

### Bước 1: Tạo Google Trang Tính mới
1. Mở trình duyệt web và truy cập: [https://sheets.new](https://sheets.new) để tạo 1 file trang tính mới.
2. Đặt tên file là: `NTD Agency - Quản lý tài khoản` (hoặc tên tùy ý).

---

### Bước 2: Dán mã Google Apps Script
1. Trên thanh menu trên cùng của Google Sheets, chọn: **Tiện ích mở rộng (Extensions)** ➔ **Apps Script**.
2. Một tab mới hiện ra với giao diện lập trình của Google. Hãy **xóa hết** các dòng mã mẫu đang có trong khung code (`function myFunction() {...}`).
3. Mở file [GoogleAppsScript_Code.js](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/GoogleAppsScript_Code.js) trong thư mục tiện ích, **sao chép toàn bộ nội dung** và **DÁN** vào khung code của Google Apps Script.
4. Bấm biểu tượng đĩa mềm **💾 Lưu** (hoặc nhấn phím tắt `Ctrl + S`).

---

### Bước 3: Triển khai Ứng Dụng Web (Web App)
1. Ở góc trên bên phải màn hình Apps Script, bấm nút màu xanh **Triển khai (Deploy)** ➔ chọn **Tùy chọn triển khai mới (New deployment)**.
2. Bấm vào biểu tượng bánh răng **⚙️ Chọn loại** (Select type) ➔ Chọn **Ứng dụng web (Web app)**.
3. Điền các thông tin như sau:
   - **Mô tả (Description):** `NTD Agency Auth API`
   - **Thực thi dưới dạng (Execute as):** `Tôi (email của bạn)`
   - **Ai có quyền truy cập (Who has access):** 👉 **BẤT KỲ AI (Anyone)** *(BẮT BUỘC CHỌN MỤC NÀY để tiện ích kết nối được)*.
4. Bấm nút **Triển khai (Deploy)**.
5. Nếu Google hiển thị cửa sổ thông báo *"Cần có quyền truy cập"*:
   - Bấm **Ủy quyền truy cập (Authorize access)** ➔ Chọn tài khoản Gmail của bạn.
   - Bấm vào chữ **Nâng cao (Advanced)** ở góc dưới bên trái.
   - Bấm vào dòng **Đi tới ... (không an toàn)** [Go to ... (unsafe)].
   - Bấm nút **Cho phép (Allow)**.
6. Sau khi triển khai xong, Google sẽ hiện một hộp thoại có chứa:
   - **URL ứng dụng web (Web app URL)** (có dạng `https://script.google.com/macros/s/AKfycby.../exec`).
   - Hãy bấm **Sao chép (Copy)** đường link này.

---

### Bước 4: Dán URL vào tiện ích NTD Agency
1. Mở tiện ích NTD Agency trên trình duyệt.
2. Mở trang **Quản trị viên** [manage.html](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/manage.html) (hoặc bấm vào dòng *"⚙️ Cài đặt máy chủ Google Sheets"* ở dưới cùng trang Đăng nhập [activate.html](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/activate.html)).
3. Dán URL bạn vừa sao chép ở Bước 3 vào ô và bấm **💾 Lưu URL**.
4. Bấm nút **⚡ Kiểm tra kết nối (Ping)**: Nếu hiện dòng chữ xanh *"✅ Kết nối thành công"* là hệ thống đã sẵn sàng 100%!

---

## 📋 CÁCH QUẢN LÝ TÀI KHOẢN HÀNG NGÀY

Bảng tính Google Sheets sẽ tự động tạo các cột:

| Cột | Tên cột | Ý nghĩa | Cách sử dụng |
| :--- | :--- | :--- | :--- |
| **A** | **Tài khoản** | Tên đăng nhập của khách | Nhập tên tài khoản (VD: `anh_nam_hanoi`, `khach01`) |
| **B** | **Mật khẩu** | Mật khẩu đăng nhập | Nhập mật khẩu cấp cho khách (VD: `123456`, `Nam@2026`) |
| **C** | **Hạn sử dụng** | Ngày hết hạn | Nhập dạng `YYYY-MM-DD` hoặc `DD/MM/YYYY` (VD: `2026-12-31` hoặc `31/12/2026`) |
| **D** | **Mã máy (Tự ghim)** | Khóa máy khách | **ĐỂ TRỐNG** khi tạo mới. Khách đăng nhập lần đầu hệ thống sẽ tự động điền mã máy của khách vào ô này. |
| **E** | **Trạng thái** | Tình trạng tài khoản | Để `active` (hoạt động). Nếu muốn khóa tài khoản, đổi thành `locked` hoặc `khoa`. |
| **F** | **Ghi chú** | Ghi chú của Admin | Ghi thông tin khách: Tên, SĐT, Gói cước (VD: `Anh Nam - 0988xxx - Gói 3 tháng`) |
| **G** | **Đăng nhập cuối** | Thời gian đăng nhập | Hệ thống tự động ghi lại ngày giờ khách mở tool lần gần nhất |

---

### 1. Thêm khách hàng mới
- **Cách 1 (Nhanh nhất):** Mở Google Sheets và gõ thêm 1 dòng mới với Cột A (Tài khoản), Cột B (Mật khẩu), Cột C (Hạn sử dụng). Cột D (Mã máy) để trống.
- **Cách 2:** Mở trang [manage.html](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/manage.html), nhập Tài khoản, Mật khẩu, chọn thời hạn (30 ngày, 3 tháng, 1 năm...) rồi bấm **Tạo tài khoản**.

---

### 2. Gia hạn tài khoản cho khách
Khi khách chuyển khoản gia hạn:
- **Cách 1:** Mở Google Sheets, tìm dòng của khách đó và sửa lại ngày ở cột **Hạn sử dụng** (VD: từ `2026-10-31` đổi thành `2026-11-30`). Xong! Khách không cần làm bất cứ thao tác nào.
- **Cách 2:** Mở trang [manage.html](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/manage.html), nhập tên tài khoản của khách, chọn số ngày gia hạn thêm (VD: `+ 30 ngày`) và bấm nút **Gia hạn tài khoản**.

---

### 3. Đổi máy tính cho khách (Reset máy)
Mỗi tài khoản được bảo vệ chỉ cho phép chạy trên 1 máy tính để tránh khách share tài khoản lung tung.
Nếu khách mua máy mới hoặc cài lại Windows:
- **Cách 1:** Mở Google Sheets, **xóa nội dung ô ở Cột D (Mã máy)** của khách đó. Sau đó báo khách mở máy mới đăng nhập lại, mã máy mới sẽ tự động được ghim vào!
- **Cách 2:** Mở trang [manage.html](file:///c:/Users/T&Tcenter/Downloads/Duy_Group_Poster_v0.1.5/NTD%20Agency/manage.html), nhập tên tài khoản của khách và bấm nút **Reset Mã máy (Đổi máy)**.

---

### 4. Khóa tài khoản
Nếu khách vi phạm hoặc chưa thanh toán:
- Trên Google Sheets, đổi ô cột **Trạng thái** của khách thành `locked`. Tiện ích trên máy khách sẽ lập tức bị chặn và thông báo tài khoản bị tạm khóa.
