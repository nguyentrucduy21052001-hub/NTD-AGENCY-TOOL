/**
 * NTD Agency - Admin & Role Management Controller (manage.js)
 * Quản lý tài khoản, phân quyền Admin/Member và cấu hình cơ sở dữ liệu Supabase.
 */

import { checkCurrentLicense, getGoogleScriptUrl, setGoogleScriptUrl } from './license.js';
import {
  getSupabaseConfig,
  setSupabaseConfig,
  isSupabaseConfigured,
  testSupabaseConnection,
  supabaseListUsers,
  supabaseCreateUser,
  supabaseUpdateRole,
  supabaseUpdateStatus,
  supabaseRenewUser,
  supabaseResetMachine,
  supabaseDeleteUser,
  SUPABASE_SETUP_SQL
} from './supabase.js';

const $ = id => document.getElementById(id);
const DEFAULT_PASS = 'DuyAdmin@2025';

let currentRoleFilter = 'all';
let cachedUsers = [];

// ── 1. KIỂM TRA PHÂN QUYỀN (ACCESS GUARD) ────────────────────────────────────
async function enforceAdminRole() {
  const license = await checkCurrentLicense(false);
  const isAdmin = (license?.role || '').toLowerCase() === 'admin';

  if (!license || !isAdmin) {
    const alertBox = $('unauthorizedAlert');
    const mainBox = $('adminMainContent');
    if (alertBox) alertBox.style.display = 'block';
    if (mainBox) mainBox.style.display = 'none';

    setTimeout(() => {
      window.location.replace('panel.html');
    }, 2500);
    return false;
  }
  return true;
}

// ── 2. QUẢN LÝ TABS ──────────────────────────────────────────────────────────
function initTabs() {
  const tabs = [
    { btn: $('tabBtnUsers'), pane: $('tabUsers') },
    { btn: $('tabBtnSupabase'), pane: $('tabSupabase') },
    { btn: $('tabBtnSheets'), pane: $('tabSheets') }
  ];

  tabs.forEach(t => {
    if (!t.btn) return;
    t.btn.addEventListener('click', () => {
      tabs.forEach(o => {
        o.btn?.classList.remove('active');
        if (o.pane) o.pane.style.display = 'none';
      });
      t.btn.classList.add('active');
      if (t.pane) t.pane.style.display = 'block';
    });
  });
}

// ── 3. KHỞI TẠO DỮ LIỆU BAN ĐẦU ──────────────────────────────────────────────
async function initAdminPage() {
  const hasAccess = await enforceAdminRole();
  if (!hasAccess) return;

  initTabs();

  // Hiển thị code SQL cấu hình Supabase
  const sqlBox = $('sqlCodeDisplay');
  if (sqlBox) sqlBox.textContent = SUPABASE_SETUP_SQL;

  // Nạp cấu hình Supabase
  const sbCfg = await getSupabaseConfig();
  if ($('sbUrlInput')) $('sbUrlInput').value = sbCfg.url;
  if ($('sbKeyInput')) $('sbKeyInput').value = sbCfg.key;

  // Nạp cấu hình Google Sheets
  const sheetUrl = await getGoogleScriptUrl();
  if ($('scriptUrlInput')) $('scriptUrlInput').value = sheetUrl;

  // Đặt ngày hết hạn mặc định: Hôm nay + 30 ngày
  const d30 = new Date();
  d30.setDate(d30.getDate() + 30);
  const pad = n => String(n).padStart(2, '0');
  if ($('newExpiryDate')) {
    $('newExpiryDate').value = `${d30.getFullYear()}-${pad(d30.getMonth() + 1)}-${pad(d30.getDate())}`;
  }

  // Tải danh sách người dùng
  await loadUserList();
}

// ── 4. LƯU & TEST SUPABASE ───────────────────────────────────────────────────
$('saveSupabaseBtn')?.addEventListener('click', async () => {
  const url = $('sbUrlInput')?.value?.trim();
  const key = $('sbKeyInput')?.value?.trim();
  const msg = $('sbConfigMsg');

  if (!url || !key) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Vui lòng nhập cả Supabase Project URL và Anon API Key.';
    }
    return;
  }

  await setSupabaseConfig(url, key);
  if (msg) {
    msg.className = 'msg-box ok';
    msg.textContent = 'Đã lưu cấu hình Supabase thành công!';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  }
  loadUserList();
});

$('testSupabaseBtn')?.addEventListener('click', async () => {
  const url = $('sbUrlInput')?.value?.trim();
  const key = $('sbKeyInput')?.value?.trim();
  const msg = $('sbConfigMsg');

  if (!url || !key) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Hãy nhập Supabase URL và Anon API Key trước khi kiểm tra.';
    }
    return;
  }

  if (msg) {
    msg.className = 'msg-box info';
    msg.textContent = 'Đang kiểm tra kết nối tới Supabase...';
  }

  const res = await testSupabaseConnection(url, key);
  if (res.ok) {
    if (msg) {
      msg.className = 'msg-box ok';
      msg.textContent = res.message;
    }
    await setSupabaseConfig(url, key);
    loadUserList();
  } else {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = res.error;
    }
  }
});

$('copySqlBtn')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
    const notify = $('copySqlNotify');
    if (notify) {
      notify.style.display = 'inline';
      setTimeout(() => { notify.style.display = 'none'; }, 3000);
    }
  } catch (_) {
    alert('Không thể tự động sao chép. Hãy bôi đen khung mã SQL bên dưới và nhấn Ctrl+C.');
  }
});

// ── 5. CẤU HÌNH GOOGLE SHEETS DỰ PHÒNG ───────────────────────────────────────
$('saveScriptUrlBtn')?.addEventListener('click', async () => {
  const rawUrl = $('scriptUrlInput')?.value?.trim() || '';
  const msgEl = $('configMsg');

  await setGoogleScriptUrl(rawUrl);
  if (msgEl) {
    msgEl.className = 'msg-box ok';
    msgEl.textContent = 'Đã lưu URL Google Sheets thành công!';
    setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
  }
  loadUserList();
});

$('testConnectionBtn')?.addEventListener('click', async () => {
  const rawUrl = $('scriptUrlInput')?.value?.trim();
  const msgEl = $('configMsg');

  if (!rawUrl) {
    if (msgEl) {
      msgEl.className = 'msg-box err';
      msgEl.textContent = 'Hãy nhập URL trước khi kiểm tra.';
    }
    return;
  }

  if (msgEl) {
    msgEl.className = 'msg-box info';
    msgEl.textContent = 'Đang kết nối tới Google Sheets…';
  }

  try {
    const testUrl = new URL(rawUrl);
    testUrl.searchParams.set('action', 'ping');
    const res = await fetch(testUrl.toString(), { method: 'GET', redirect: 'follow' });
    const data = await res.json();

    if (data && data.ok) {
      if (msgEl) {
        msgEl.className = 'msg-box ok';
        msgEl.textContent = 'Kết nối thành công tới Google Sheets!';
      }
      await setGoogleScriptUrl(rawUrl);
      loadUserList();
    } else {
      if (msgEl) {
        msgEl.className = 'msg-box err';
        msgEl.textContent = 'Lỗi: ' + (data?.error || 'Không xác định');
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.className = 'msg-box err';
      msgEl.textContent = 'Không thể kết nối tới Google Sheets: ' + err.message;
    }
  }
});

// ── 6. TẠO TÀI KHOẢN MỚI KÈM PHÂN QUYỀN ──────────────────────────────────────
$('quickDaysSelect')?.addEventListener('change', () => {
  const val = $('quickDaysSelect')?.value;
  const wrap = $('customDateWrap');
  if (wrap) wrap.style.display = val === 'custom' ? 'block' : 'none';
});

$('createUserBtn')?.addEventListener('click', async () => {
  const username = $('newUsername')?.value?.trim();
  const password = $('newPassword')?.value?.trim();
  const role = $('newRoleSelect')?.value || 'member';
  const quickDays = $('quickDaysSelect')?.value;
  const customDate = $('newExpiryDate')?.value;
  const note = $('newNote')?.value?.trim() || '';
  const msgEl = $('createUserMsg');

  if (!msgEl) return;
  msgEl.className = 'msg-box';
  msgEl.style.display = 'none';

  if (!username) {
    msgEl.className = 'msg-box err';
    msgEl.textContent = 'Vui lòng nhập Tên tài khoản.';
    $('newUsername')?.focus();
    return;
  }
  if (!password) {
    msgEl.className = 'msg-box err';
    msgEl.textContent = 'Vui lòng nhập Mật khẩu.';
    $('newPassword')?.focus();
    return;
  }

  let finalExpiry = '';
  const pad = n => String(n).padStart(2, '0');
  if (quickDays === 'custom') {
    if (!customDate) {
      msgEl.className = 'msg-box err';
      msgEl.textContent = 'Vui lòng chọn ngày hết hạn cụ thể.';
      return;
    }
    finalExpiry = customDate;
  } else {
    const days = parseInt(quickDays || '30');
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    finalExpiry = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;
  }

  msgEl.className = 'msg-box info';
  msgEl.textContent = 'Đang tạo và phân quyền tài khoản…';

  try {
    // 1. Nếu có Supabase -> Lưu vào Supabase
    if (await isSupabaseConfigured()) {
      await supabaseCreateUser({
        username,
        password,
        role,
        expiryDate: finalExpiry,
        note
      });
      msgEl.className = 'msg-box ok';
      msgEl.textContent = `Tạo tài khoản "${username}" thành công với vai trò: ${role === 'admin' ? 'Quản trị viên (Admin)' : 'Thành viên'} trên Supabase!`;
    } else {
      // 2. Dự phòng: Lưu vào Google Sheets
      const scriptUrl = await getGoogleScriptUrl();
      if (!scriptUrl) throw new Error('Chưa cấu hình Supabase hoặc Google Sheets.');

      const targetUrl = new URL(scriptUrl);
      targetUrl.searchParams.set('action', 'add_user');
      targetUrl.searchParams.set('admin_pass', DEFAULT_PASS);
      targetUrl.searchParams.set('username', username);
      targetUrl.searchParams.set('password', password);
      targetUrl.searchParams.set('expiry', finalExpiry);
      targetUrl.searchParams.set('note', `${note} [Role: ${role}]`);

      const res = await fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow' });
      const data = await res.json();
      if (!data || !data.ok) throw new Error(data?.error || 'Lỗi khi tạo tài khoản');

      msgEl.className = 'msg-box ok';
      msgEl.textContent = data.message;
    }

    $('newUsername').value = '';
    $('newPassword').value = '';
    $('newNote').value = '';
    loadUserList();
  } catch (err) {
    msgEl.className = 'msg-box err';
    msgEl.textContent = 'Lỗi tạo tài khoản: ' + err.message;
  }
});

// ── 7. HIỂN THỊ DANH SÁCH & BẢNG PHÂN QUYỀN ──────────────────────────────────
async function loadUserList() {
  const container = $('userListContainer');
  const badge = $('dbSourceBadge');
  if (!container) return;

  container.innerHTML = '<p style="padding:20px;text-align:center;color:#60a5fa">Đang tải danh sách tài khoản…</p>';

  try {
    const isSb = await isSupabaseConfigured();
    if (isSb) {
      if (badge) badge.innerHTML = '<span style="color:#34d399;font-weight:700">⚡ Cơ sở dữ liệu: Supabase PostgreSQL</span>';
      cachedUsers = await supabaseListUsers();
    } else {
      if (badge) badge.innerHTML = '<span style="color:#fbbf24;font-weight:700">📊 Cơ sở dữ liệu: Google Sheets (Dự phòng)</span>';
      const scriptUrl = await getGoogleScriptUrl();
      if (!scriptUrl) {
        container.innerHTML = '<p style="padding:20px;text-align:center;color:#f87171">Chưa cấu hình Supabase hoặc Google Sheets. Vui lòng chuyển qua tab cấu hình.</p>';
        return;
      }

      const targetUrl = new URL(scriptUrl);
      targetUrl.searchParams.set('action', 'list_users');
      targetUrl.searchParams.set('admin_pass', DEFAULT_PASS);
      const res = await fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow' });
      const data = await res.json();

      if (data && data.ok && Array.isArray(data.users)) {
        cachedUsers = data.users.map(u => {
          const isAdm = u.username.toLowerCase() === 'admin' || (u.note && u.note.includes('Role: admin'));
          return {
            username: u.username,
            password: u.password,
            role: isAdm ? 'admin' : 'member',
            expiry: u.expiry,
            isExpired: u.isExpired,
            status: u.status || 'active',
            machineId: u.machineId || '',
            note: u.note || '',
            lastLogin: u.lastLogin || 'Chưa đăng nhập'
          };
        });
      } else {
        throw new Error(data?.error || 'Không tải được danh sách');
      }
    }

    renderUserTable();
  } catch (err) {
    container.innerHTML = `<p style="padding:20px;text-align:center;color:#f87171">Lỗi tải dữ liệu: ${err.message}</p>`;
  }
}

function renderUserTable() {
  const container = $('userListContainer');
  if (!container) return;

  let filtered = cachedUsers;
  if (currentRoleFilter === 'admin') {
    filtered = cachedUsers.filter(u => u.role === 'admin');
  } else if (currentRoleFilter === 'member') {
    filtered = cachedUsers.filter(u => u.role !== 'admin');
  }

  if (filtered.length === 0) {
    container.innerHTML = '<p style="padding:24px;text-align:center;color:var(--text-sub)">Không có tài khoản nào phù hợp bộ lọc.</p>';
    return;
  }

  let html = `
    <table class="user-table">
      <thead>
        <tr>
          <th>Tài khoản</th>
          <th>Mật khẩu</th>
          <th>Vai trò (Phân quyền)</th>
          <th>Hạn sử dụng</th>
          <th>Trạng thái</th>
          <th>Mã máy</th>
          <th>Ghi chú</th>
          <th>Hành động</th>
        </tr>
      </thead>
      <tbody>
  `;

  filtered.forEach(u => {
    const isAdmin = u.role === 'admin';
    const roleBadge = isAdmin
      ? '<span class="badge-role-admin">👑 Admin</span>'
      : '<span class="badge-role-member">👤 Member</span>';

    const isLocked = u.status === 'locked' || u.status === 'khoa';
    const statusBadge = isLocked
      ? '<span class="badge-locked">Bị khóa</span>'
      : (u.isExpired ? '<span class="badge-expired">Hết hạn</span>' : '<span class="badge-active">Hoạt động</span>');

    const machineDisplay = u.machineId
      ? `<span title="${u.machineId}" style="font-family:monospace;font-size:11px;color:#93c5fd">${u.machineId.slice(0, 8)}…</span>`
      : '<span style="color:#64748b;font-style:italic">Chưa ghim</span>';

    // Role toggle button text
    const roleToggleBtn = isAdmin
      ? `<button type="button" class="action-btn-sm btn-role-toggle" data-user="${escapeHtml(u.username)}" data-next="member" style="background:#334155;color:#cbd5e1" title="Hạ cấp xuống Thành viên thường">👤 Đặt Member</button>`
      : `<button type="button" class="action-btn-sm btn-role-toggle" data-user="${escapeHtml(u.username)}" data-next="admin" style="background:#ea580c;color:#fff" title="Thăng cấp tài khoản này thành Quản trị viên">⭐ Lên Admin</button>`;

    // Lock toggle button
    const lockBtn = isLocked
      ? `<button type="button" class="action-btn-sm btn-lock-toggle" data-user="${escapeHtml(u.username)}" data-next="active" style="background:#10b981;color:#fff" title="Mở khóa tài khoản">🔓 Mở</button>`
      : `<button type="button" class="action-btn-sm btn-lock-toggle" data-user="${escapeHtml(u.username)}" data-next="locked" style="background:#ef4444;color:#fff" title="Khóa tài khoản này">🔒 Khóa</button>`;

    html += `
      <tr>
        <td><b style="color:var(--text-main)">${escapeHtml(u.username)}</b></td>
        <td style="font-family:monospace;color:var(--text-sub)">${escapeHtml(u.password)}</td>
        <td>${roleBadge}</td>
        <td><b>${escapeHtml(u.expiry)}</b></td>
        <td>${statusBadge}</td>
        <td>${machineDisplay}</td>
        <td style="color:var(--text-sub);max-width:150px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(u.note)}">${escapeHtml(u.note || '-')}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${roleToggleBtn}
            ${lockBtn}
            <button type="button" class="action-btn-sm btn-renew-user" data-user="${escapeHtml(u.username)}" style="background:#2563eb;color:#fff" title="Gia hạn thêm 30 ngày">+30N</button>
            <button type="button" class="action-btn-sm btn-reset-mid" data-user="${escapeHtml(u.username)}" style="background:#f59e0b;color:#fff" title="Reset mã máy để khách đổi máy mới">Đổi máy</button>
            <button type="button" class="action-btn-sm btn-delete-user" data-user="${escapeHtml(u.username)}" style="background:#374151;color:#f87171" title="Xóa tài khoản">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;

  attachTableEventListeners(container);
}

// Gắn sự kiện các nút tương tác trong bảng
function attachTableEventListeners(container) {
  // 1. Đổi vai trò (Phân quyền Admin/Member)
  container.querySelectorAll('.btn-role-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      const nextRole = btn.getAttribute('data-next');
      const label = nextRole === 'admin' ? 'Quản trị viên (Admin)' : 'Thành viên (Member)';

      if (!confirm(`Bạn có chắc muốn đổi vai trò của "${u}" thành [${label}]?`)) return;

      try {
        if (await isSupabaseConfigured()) {
          await supabaseUpdateRole(u, nextRole);
        } else {
          alert('Chức năng đổi vai trò tức thì yêu cầu cơ sở dữ liệu Supabase. Hãy thiết lập Supabase ở Tab 2.');
          return;
        }
        alert(`Đã cập nhật vai trò của "${u}" thành: ${label}`);
        loadUserList();
      } catch (err) {
        alert('Lỗi cập nhật vai trò: ' + err.message);
      }
    });
  });

  // 2. Khóa / Mở khóa
  container.querySelectorAll('.btn-lock-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      const nextStatus = btn.getAttribute('data-next');

      if (!confirm(`Bạn có chắc muốn ${nextStatus === 'locked' ? 'KHÓA' : 'MỞ KHÓA'} tài khoản "${u}"?`)) return;

      try {
        if (await isSupabaseConfigured()) {
          await supabaseUpdateStatus(u, nextStatus);
        }
        alert(`Đã cập nhật trạng thái tài khoản: ${nextStatus}`);
        loadUserList();
      } catch (err) {
        alert('Lỗi cập nhật trạng thái: ' + err.message);
      }
    });
  });

  // 3. Gia hạn thêm 30 ngày
  container.querySelectorAll('.btn-renew-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      if (!confirm(`Gia hạn thêm 30 ngày cho tài khoản "${u}"?`)) return;

      try {
        if (await isSupabaseConfigured()) {
          await supabaseRenewUser(u, 30);
        } else {
          const scriptUrl = await getGoogleScriptUrl();
          const targetUrl = new URL(scriptUrl);
          targetUrl.searchParams.set('action', 'renew');
          targetUrl.searchParams.set('admin_pass', DEFAULT_PASS);
          targetUrl.searchParams.set('username', u);
          targetUrl.searchParams.set('days', '30');
          await fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow' });
        }
        alert(`Đã gia hạn thành công cho "${u}"!`);
        loadUserList();
      } catch (err) {
        alert('Lỗi gia hạn: ' + err.message);
      }
    });
  });

  // 4. Reset mã máy (Đổi máy)
  container.querySelectorAll('.btn-reset-mid').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      if (!confirm(`Reset mã máy cho tài khoản "${u}" để khách đăng nhập ở máy mới?`)) return;

      try {
        if (await isSupabaseConfigured()) {
          await supabaseResetMachine(u);
        } else {
          const scriptUrl = await getGoogleScriptUrl();
          const targetUrl = new URL(scriptUrl);
          targetUrl.searchParams.set('action', 'reset_machine');
          targetUrl.searchParams.set('admin_pass', DEFAULT_PASS);
          targetUrl.searchParams.set('username', u);
          await fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow' });
        }
        alert(`Đã reset mã máy thành công cho "${u}"! Khách có thể đăng nhập trên máy mới ngay.`);
        loadUserList();
      } catch (err) {
        alert('Lỗi reset mã máy: ' + err.message);
      }
    });
  });

  // 5. Xóa tài khoản
  container.querySelectorAll('.btn-delete-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      if (!confirm(`⚠️ CẢNH BÁO: Bạn có chắc chắn muốn XÓA VĨNH VIỄN tài khoản "${u}"?`)) return;

      try {
        if (await isSupabaseConfigured()) {
          await supabaseDeleteUser(u);
          alert(`Đã xóa tài khoản "${u}" khỏi cơ sở dữ liệu!`);
          loadUserList();
        } else {
          alert('Vui lòng mở Google Sheets và xóa dòng tài khoản này.');
        }
      } catch (err) {
        alert('Lỗi xóa tài khoản: ' + err.message);
      }
    });
  });
}

// ── 8. BỘ LỌC VAI TRÒ ────────────────────────────────────────────────────────
document.querySelectorAll('.role-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRoleFilter = btn.getAttribute('data-filter') || 'all';
    renderUserTable();
  });
});

$('refreshUsersBtn')?.addEventListener('click', loadUserList);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Chạy khởi tạo
initAdminPage();
