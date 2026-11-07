/**
 * NTD Agency - Supabase Database Client & RBAC (supabase.js)
 * Quản lý kết nối cơ sở dữ liệu Supabase, phân quyền Admin/Member và xác thực người dùng.
 */

// Key lưu trữ cấu hình trong chrome.storage.local
export const STORAGE_SUPABASE_URL = 'ntd_supabase_url';
export const STORAGE_SUPABASE_KEY = 'ntd_supabase_key';

// Cấu hình mặc định (người dùng có thể thay đổi trong trang Quản trị)
export const DEFAULT_SUPABASE_URL = 'https://jwketbnfapscggpvnbui.supabase.co';
export const DEFAULT_SUPABASE_KEY = 'sb_publishable_HK-WyUKi4lK9RBJvSrf4Kg_i920nRCv';

/**
 * Lấy cấu hình Supabase hiện tại
 */
export async function getSupabaseConfig() {
  try {
    const res = await chrome.storage.local.get([STORAGE_SUPABASE_URL, STORAGE_SUPABASE_KEY]);
    const url = (res[STORAGE_SUPABASE_URL] || DEFAULT_SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = (res[STORAGE_SUPABASE_KEY] || DEFAULT_SUPABASE_KEY || '').trim();
    
    // Tự động lưu giá trị mặc định vào storage nếu chưa có
    if (!res[STORAGE_SUPABASE_URL] && DEFAULT_SUPABASE_URL) {
      await chrome.storage.local.set({
        [STORAGE_SUPABASE_URL]: DEFAULT_SUPABASE_URL,
        [STORAGE_SUPABASE_KEY]: DEFAULT_SUPABASE_KEY
      });
    }
    return { url, key };
  } catch (_) {
    return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY };
  }
}

/**
 * Lưu cấu hình Supabase
 */
export async function setSupabaseConfig(url, key) {
  const cleanUrl = (url || '').trim().replace(/\/+$/, '');
  const cleanKey = (key || '').trim();
  await chrome.storage.local.set({
    [STORAGE_SUPABASE_URL]: cleanUrl,
    [STORAGE_SUPABASE_KEY]: cleanKey
  });
  return { url: cleanUrl, key: cleanKey };
}

/**
 * Kiểm tra xem Supabase đã được cấu hình hay chưa
 */
export async function isSupabaseConfigured() {
  const cfg = await getSupabaseConfig();
  return Boolean(cfg.url && cfg.key && cfg.url.startsWith('http'));
}

/**
 * Helper thực hiện REST request tới Supabase
 */
async function supabaseRequest(endpoint, options = {}) {
  const cfg = await getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Chưa cấu hình Supabase URL hoặc API Key.');
  }

  const url = `${cfg.url}/rest/v1/${endpoint.replace(/^\/+/, '')}`;
  const headers = {
    'apikey': cfg.key,
    'Authorization': `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...(options.headers || {})
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    if (!res.ok) {
      const errMsg = (data && typeof data === 'object' && (data.message || data.error || data.hint)) || `HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Hết thời gian kết nối tới Supabase (Timeout).');
    throw err;
  }
}

/**
 * Kiểm tra kết nối tới Supabase
 */
export async function testSupabaseConnection(url, key) {
  try {
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    const cleanKey = (key || '').trim();

    if (!cleanUrl || !cleanKey) {
      return { ok: false, error: 'Vui lòng nhập đầy đủ Supabase URL và Anon API Key.' };
    }

    const testUrl = `${cleanUrl}/rest/v1/ntd_users?select=count`;
    const res = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'apikey': cleanKey,
        'Authorization': `Bearer ${cleanKey}`,
        'Range': '0-0'
      }
    });

    if (res.status === 200 || res.status === 206) {
      return { ok: true, message: 'Kết nối thành công! Bảng ntd_users đã sẵn sàng.' };
    } else if (res.status === 404 || res.status === 400) {
      const text = await res.text();
      if (text.includes('does not exist') || text.includes('ntd_users')) {
        return {
          ok: true,
          needTable: true,
          message: 'Kết nối API thành công nhưng chưa có bảng "ntd_users". Hãy chạy script SQL tạo bảng!'
        };
      }
      return { ok: false, error: `Lỗi Supabase: ${text}` };
    } else {
      const text = await res.text();
      return { ok: false, error: `Mã HTTP ${res.status}: ${text}` };
    }
  } catch (err) {
    return { ok: false, error: 'Không thể kết nối tới Supabase: ' + err.message };
  }
}

/**
 * Đăng nhập người dùng qua Supabase
 */
export async function supabaseLogin(username, password, machineId) {
  const u = (username || '').trim().toLowerCase();
  const p = (password || '').trim();

  const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
  if (!users || users.length === 0) {
    return { ok: false, error: 'Tài khoản không tồn tại trên hệ thống.' };
  }

  const user = users[0];

  // Kiểm tra mật khẩu
  if (user.password !== p) {
    return { ok: false, error: 'Mật khẩu không chính xác.' };
  }

  // Kiểm tra trạng thái khóa
  if (user.status === 'locked' || user.status === 'khoa') {
    return { ok: false, locked: true, error: 'Tài khoản này đã bị khóa bởi Quản trị viên.' };
  }

  // Kiểm tra hạn sử dụng
  const now = new Date();
  const expiryDate = new Date(user.expiry_date || user.expiry);
  if (isNaN(expiryDate.getTime()) || expiryDate < now) {
    return {
      ok: false,
      expired: true,
      error: `Tài khoản đã hết hạn vào ngày ${expiryDate.toLocaleDateString('vi-VN')}. Vui lòng liên hệ Admin để gia hạn.`
    };
  }

  // Ghim mã máy (nếu chưa có hoặc khớp)
  let updatedMachine = user.machine_id;
  if (!user.machine_id && machineId) {
    try {
      await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
        method: 'PATCH',
        body: JSON.stringify({ machine_id: machineId, last_login: new Date().toISOString() })
      });
      updatedMachine = machineId;
    } catch (_) {}
  } else {
    // Cập nhật last_login
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_login: new Date().toISOString() })
    }).catch(() => {});
  }

  const role = (user.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  return {
    ok: true,
    data: {
      username: user.username,
      role: role,
      expiry: expiryDate.toISOString(),
      expiryFormatted: expiryDate.toLocaleDateString('vi-VN'),
      machineId: updatedMachine || machineId,
      status: user.status || 'active',
      note: user.note || ''
    }
  };
}

/**
 * Kiểm tra trạng thái tài khoản trên Supabase (cho sync ngầm)
 */
export async function supabaseCheckLicense(username) {
  try {
    const u = (username || '').trim().toLowerCase();
    const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
    if (!users || users.length === 0) return null;

    const user = users[0];
    const expiryDate = new Date(user.expiry_date || user.expiry);
    const role = (user.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

    // Cập nhật last_login ngầm để ghi nhận phiên hoạt động
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_login: new Date().toISOString() })
    }).catch(() => {});

    return {
      username: user.username,
      role: role,
      status: user.status || 'active',
      isLocked: user.status === 'locked' || user.status === 'khoa',
      isExpired: expiryDate < new Date(),
      expiry: expiryDate.toISOString(),
      expiryFormatted: expiryDate.toLocaleDateString('vi-VN'),
      machineId: user.machine_id || ''
    };
  } catch (_) {
    return null;
  }
}

/**
 * [ADMIN] Lấy toàn bộ danh sách người dùng kèm phân quyền
 */
export async function supabaseListUsers() {
  const users = await supabaseRequest(`ntd_users?select=*&order=created_at.desc`);
  const now = new Date();

  return (users || []).map(u => {
    const exp = new Date(u.expiry_date || u.expiry);
    const isExpired = !isNaN(exp.getTime()) && exp < now;
    return {
      username: u.username,
      password: u.password,
      role: (u.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member',
      expiry: isNaN(exp.getTime()) ? u.expiry_date : exp.toLocaleDateString('vi-VN'),
      rawExpiry: u.expiry_date,
      isExpired,
      status: u.status || 'active',
      machineId: u.machine_id || '',
      note: u.note || '',
      fbCount: Number(u.fb_count) || 0,
      fanpageCount: Number(u.fanpage_count) || 0,
      todayPosts: Number(u.today_posts) || 0,
      todayGroupScans: Number(u.today_group_scans) || 0,
      todayMapsScans: Number(u.today_maps_scans) || 0,
      rawLastLogin: u.last_login || null,
      lastLogin: u.last_login ? new Date(u.last_login).toLocaleString('vi-VN') : 'Chưa đăng nhập',
      createdAt: u.created_at ? new Date(u.created_at).toLocaleDateString('vi-VN') : ''
    };
  });
}

/**
 * [TELEMETRY] Cập nhật số liệu hoạt động của người dùng lên Supabase
 */
export async function supabaseUpdateUserStats(username, stats = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return { ok: false };

  try {
    const payload = {
      fb_count: Number(stats.fb_count) || 0,
      fanpage_count: Number(stats.fanpage_count) || 0,
      today_posts: Number(stats.today_posts) || 0,
      today_group_scans: Number(stats.today_group_scans) || 0,
      today_maps_scans: Number(stats.today_maps_scans) || 0,
      last_login: new Date().toISOString()
    };

    await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });

    return { ok: true };
  } catch (err) {
    console.warn('Không thể gửi telemetry Supabase:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * [ADMIN] Tạo tài khoản mới với vai trò chỉ định
 */
export async function supabaseCreateUser({ username, password, role = 'member', expiryDate, note = '' }) {
  const u = (username || '').trim().toLowerCase();
  const p = (password || '').trim();
  const r = (role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  if (!u) throw new Error('Vui lòng nhập Tên tài khoản.');
  if (!p) throw new Error('Vui lòng nhập Mật khẩu.');

  const res = await supabaseRequest('ntd_users', {
    method: 'POST',
    body: JSON.stringify({
      username: u,
      password: p,
      role: r,
      expiry_date: expiryDate,
      status: 'active',
      note: note,
      created_at: new Date().toISOString()
    })
  });

  return { ok: true, data: res };
}

/**
 * [ADMIN] Nhập hoặc cập nhật hàng loạt người dùng (Upsert batch)
 */
export async function supabaseUpsertUsers(usersArray) {
  if (!Array.isArray(usersArray) || usersArray.length === 0) {
    return { ok: true, count: 0 };
  }

  // Chuẩn hóa dữ liệu từng user
  const sanitized = usersArray.map(u => ({
    username: (u.username || '').trim().toLowerCase(),
    password: String(u.password || '123456').trim(),
    role: (u.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member',
    expiry_date: u.expiryDate || u.expiry_date,
    status: u.status || 'active',
    machine_id: u.machineId || u.machine_id || null,
    note: u.note || '',
    updated_at: new Date().toISOString()
  })).filter(u => Boolean(u.username));

  if (sanitized.length === 0) {
    return { ok: true, count: 0 };
  }

  const res = await supabaseRequest('ntd_users', {
    method: 'POST',
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(sanitized)
  });

  return { ok: true, data: res, count: Array.isArray(res) ? res.length : sanitized.length };
}

/**
 * [ADMIN] Phân quyền người dùng (Đổi vai trò giữa admin và member)
 */
export async function supabaseUpdateRole(username, newRole) {
  const u = (username || '').trim().toLowerCase();
  const r = (newRole || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      role: r,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, role: r };
}

/**
 * [ADMIN] Khóa hoặc mở khóa tài khoản
 */
export async function supabaseUpdateStatus(username, newStatus) {
  const u = (username || '').trim().toLowerCase();
  const s = newStatus === 'locked' ? 'locked' : 'active';

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: s,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, status: s };
}

/**
 * [ADMIN] Gia hạn ngày sử dụng
 */
export async function supabaseRenewUser(username, daysOrDate) {
  const u = (username || '').trim().toLowerCase();
  let finalExpiry = '';

  if (typeof daysOrDate === 'number' || !isNaN(Number(daysOrDate))) {
    const days = Number(daysOrDate);
    const target = new Date();
    target.setDate(target.getDate() + days);
    const pad = n => String(n).padStart(2, '0');
    finalExpiry = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
  } else {
    finalExpiry = daysOrDate;
  }

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expiry_date: finalExpiry,
      status: 'active',
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, expiryDate: finalExpiry };
}

/**
 * [ADMIN] Reset mã máy để khách đổi máy tính
 */
export async function supabaseResetMachine(username) {
  const u = (username || '').trim().toLowerCase();

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      machine_id: null,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true };
}

/**
 * [ADMIN] Xóa tài khoản
 */
export async function supabaseDeleteUser(username) {
  const u = (username || '').trim().toLowerCase();

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'DELETE'
  });

  return { ok: true };
}

/**
 * Đoạn mã SQL chuẩn để người dùng copy và dán vào Supabase SQL Editor
 */
export const SUPABASE_SETUP_SQL = `-- ====================================================================
-- NTD AGENCY - SUPABASE DATABASE SCHEMA VỚI PHÂN QUYỀN (RBAC)
-- Chạy đoạn mã này trong: Supabase Dashboard -> SQL Editor -> Run
-- ====================================================================

-- 1. Tạo bảng ntd_users (Quản lý tài khoản và phân quyền)
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
    fb_count integer default 0,
    fanpage_count integer default 0,
    today_posts integer default 0,
    today_group_scans integer default 0,
    today_maps_scans integer default 0,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- Cập nhật bổ sung cột nếu bảng ntd_users đã được tạo từ trước:
alter table public.ntd_users 
add column if not exists fb_count integer default 0,
add column if not exists fanpage_count integer default 0,
add column if not exists today_posts integer default 0,
add column if not exists today_group_scans integer default 0,
add column if not exists today_maps_scans integer default 0;

-- 2. Bật Row Level Security (RLS)
alter table public.ntd_users enable row level security;

-- 3. Tạo chính sách bảo mật cho phép đọc và ghi dữ liệu qua API Anon Key
-- (Người dùng và Admin thao tác qua ứng dụng web)
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

-- 4. Thêm tài khoản Quản trị viên (Admin) mặc định ban đầu
insert into public.ntd_users (username, password, role, expiry_date, note)
values 
    ('admin', '123456', 'admin', '2030-12-31', 'Tài khoản Quản trị tối cao'),
    ('khach_demo', '123456', 'member', (current_date + interval '30 days'), 'Tài khoản thành viên dùng thử')
on conflict (username) do update 
set role = excluded.role,
    expiry_date = excluded.expiry_date;

-- Hoàn tất! Bảng ntd_users đã sẵn sàng hoạt động.
`;

