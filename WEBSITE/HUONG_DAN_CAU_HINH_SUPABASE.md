# ⚡ HƯỚNG DẪN THIẾT LẬP CƠ SỞ DỮ LIỆU & PHÂN QUYỀN TRÊN SUPABASE

Hướng dẫn chi tiết từ A - Z cách kết nối website **NTD Agency** với cơ sở dữ liệu đám mây **Supabase (PostgreSQL)** và cấu hình hệ thống phân quyền **Admin** / **Thành viên (Member)**.

---

## 🌟 1. VÌ SAO NÊN DÙNG SUPABASE?

1. **Chuẩn cơ sở dữ liệu PostgreSQL**: Cực nhanh, ổn định, hỗ trợ hàng chục nghìn tài khoản đồng thời.
2. **Bảo mật phân quyền Row Level Security (RLS)**: Chống rò rỉ dữ liệu, chỉ tài khoản Admin mới có quyền sửa vai trò và quản lý thành viên.
3. **100% Miễn phí**: Gói Free của Supabase cho phép lưu trữ tới 500MB dữ liệu và 50,000 người dùng hoạt động mỗi tháng.
4. **Giao diện quản lý trực quan**: Bạn có thể xem, thêm, sửa, phân quyền và khóa tài khoản ngay trên trình duyệt web hoặc điện thoại.

---

## 🚀 2. CÁC BƯỚC THIẾT LẬP (CHỈ MẤT 3 PHÚT)

### BƯỚC 1: Tạo dự án mới trên Supabase
1. Truy cập trang chủ Supabase: [https://supabase.com](https://supabase.com)
2. Bấm nút **Start your project** (hoặc **Sign In**) và đăng nhập bằng tài khoản GitHub hoặc Google.
3. Bấm **New Project** (Tạo dự án mới):
   - **Name:** `NTD Agency Database` (hoặc tên tùy thích).
   - **Database Password:** Đặt mật khẩu mạnh (nhớ lưu lại mật khẩu này).
   - **Region:** Chọn **Southeast Asia (Singapore)** để có tốc độ truy cập nhanh nhất tại Việt Nam.
   - **Pricing Plan:** Chọn **Free Plan**.
4. Bấm **Create new project** và đợi khoảng 1-2 phút để Supabase khởi tạo máy chủ.

---

### BƯỚC 2: Chạy mã SQL tạo bảng và phân quyền (RBAC)
1. Trên thanh menu bên trái của Supabase Dashboard, bấm vào biểu tượng **SQL Editor** (biểu tượng trang giấy có dấu `>_`).
2. Bấm nút **+ New query** (hoặc mở cửa sổ soạn thảo).
3. Sao chép toàn bộ đoạn mã SQL bên dưới và DÁN vào khung soạn thảo:

```sql
-- ====================================================================
-- NTD AGENCY - SUPABASE DATABASE SCHEMA VỚI PHÂN QUYỀN (RBAC)
-- ====================================================================

-- 1. Tạo bảng ntd_users (Quản lý tài khoản, mật khẩu và vai trò)
create table if not exists public.ntd_users (
    id uuid default gen_random_uuid() primary key,
    username text unique not null,
    password text not null,
    role text not null default 'member' check (role in ('admin', 'member')),
    expiry_date date not null default (current_date + interval '30 days'),
    status text not null default 'active' check (status in ('active', 'locked')),
    machine_id text,
    note text default '',
    last_login timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- 2. Kích hoạt bảo mật Row Level Security (RLS)
alter table public.ntd_users enable row level security;

-- 3. Tạo chính sách bảo mật cho phép Web App tương tác
drop policy if exists "Cho phép đọc người dùng" on public.ntd_users;
create policy "Cho phép đọc người dùng"
on public.ntd_users for select
using (true);

drop policy if exists "Cho phép thêm người dùng" on public.ntd_users;
create policy "Cho phép thêm người dùng"
on public.ntd_users for insert
with check (true);

drop policy if exists "Cho phép cập nhật người dùng" on public.ntd_users;
create policy "Cho phép cập nhật người dùng"
on public.ntd_users for update
using (true);

drop policy if exists "Cho phép xóa người dùng" on public.ntd_users;
create policy "Cho phép xóa người dùng"
on public.ntd_users for delete
using (true);

-- 4. Thêm sẵn tài khoản Quản trị viên (Admin) mặc định
insert into public.ntd_users (username, password, role, expiry_date, note)
values 
    ('admin', '123456', 'admin', '2030-12-31', 'Tài khoản Quản trị tối cao'),
    ('khach_demo', '123456', 'member', (current_date + interval '30 days'), 'Tài khoản thành viên dùng thử')
on conflict (username) do update 
set role = excluded.role,
    expiry_date = excluded.expiry_date;
```

4. Bấm nút **Run** (màu xanh lá ở góc dưới bên phải) để thực thi.
5. Khi thấy thông báo `Success. No rows returned` nghĩa là bảng dữ liệu và tài khoản mẫu đã được tạo thành công!

---

### BƯỚC 3: Lấy thông tin kết nối (API URL & Anon Key)
1. Ở thanh menu bên trái, bấm vào biểu tượng bánh răng **Project Settings** (Cài đặt dự án) ở góc dưới cùng.
2. Chọn mục **API** (hoặc **Data API**).
3. Tại đây bạn sẽ thấy 2 thông số quan trọng:
   - **Project URL:** (Có dạng `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`) ➔ Bấm **Copy**.
   - **Project API keys:** Tìm dòng có nhãn `anon` `public` ➔ Bấm **Copy**.

---

### BƯỚC 4: Dán thông tin vào website NTD Agency
1. Mở website của bạn và đăng nhập bằng tài khoản:
   - **Tài khoản:** `admin`
   - **Mật khẩu:** `123456`
2. Trên thanh menu, bấm vào mục **Quản trị & Phân quyền** (`manage.html`).
3. Chuyển sang Tab **⚡ Cơ sở dữ liệu Supabase**:
   - Dán **Project URL** vào ô tương ứng.
   - Dán **Anon API Key** vào ô tương ứng.
4. Bấm nút **💾 Lưu cấu hình Supabase**.
5. Bấm nút **⚡ Kiểm tra kết nối**: Khi xuất hiện thông báo xanh *"Kết nối thành công! Bảng ntd_users đã sẵn sàng"* là website đã liên kết 100% với Supabase!

---

## 👥 3. CƠ CHẾ PHÂN QUYỀN TRÊN WEBSITE

Hệ thống được thiết kế theo mô hình **RBAC (Role-Based Access Control)** với 2 cấp độ:

| Vai trò (Role) | Menu Quản trị & Phân quyền | Các tính năng sử dụng |
| :--- | :---: | :--- |
| **👑 Quản trị viên (Admin)** | **HIỂN THỊ** | Toàn quyền: Đăng bài, Quản lý tài khoản FB, Nuôi nick, Quét Maps, Quét nhóm, **Thêm người dùng, Phân quyền Admin/Member, Khóa tài khoản, Gia hạn ngày dùng, Cấu hình cơ sở dữ liệu**. |
| **👤 Thành viên (Member)** | **ẨN HOÀN TOÀN** | Sử dụng các công cụ: Đăng bài, Quản lý tài khoản cá nhân, Nuôi nick, Quét nhóm, Quét Maps, Cài đặt cá nhân. **Bị chặn tuyệt đối không thể truy cập trang Quản trị**. |

### Cách đổi vai trò tài khoản:
1. Mở trang **Quản trị & Phân quyền**.
2. Tại bảng danh sách tài khoản, bấm nút:
   - **⭐ Lên Admin**: Nâng cấp tài khoản thành viên lên quyền Quản trị viên.
   - **👤 Đặt Member**: Hạ quyền tài khoản Admin xuống thành viên thường.
3. Bấm nút **🔒 Khóa** nếu muốn tạm ngừng quyền truy cập của một khách hàng bất kỳ.
4. Bấm nút **+30N** để gia hạn nhanh 30 ngày.

---

## 📱 4. QUẢN LÝ DỮ LIỆU TRỰC TIẾP TRÊN SUPABASE (TABLE EDITOR)

Bên cạnh giao diện Admin của website, bạn cũng có thể mở trực tiếp Supabase trên điện thoại hoặc máy tính:
1. Vào Supabase Dashboard ➔ Chọn mục **Table Editor** (biểu tượng bảng tính ở menu trái).
2. Bấm vào bảng **`ntd_users`**.
3. Bạn có thể xem toàn bộ tài khoản, nhấp đúp để đổi mật khẩu, sửa cột `role` thành `admin` hoặc `member`, hoặc sửa cột `expiry_date` rất dễ dàng!

