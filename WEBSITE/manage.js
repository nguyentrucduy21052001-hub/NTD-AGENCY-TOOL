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
  supabaseUpsertUsers,
  supabaseUpdateRole,
  supabaseUpdateStatus,
  supabaseRenewUser,
  supabaseResetMachine,
  supabaseDeleteUser,
  supabaseRenameUser,
  pushLocalChangesToSupabase,
  hydrateLocalFromSupabase,
  SUPABASE_SETUP_SQL
} from './supabase.js?v=20261112_1000';

const $ = id => document.getElementById(id);
const DEFAULT_PASS = 'DuyAdmin@2025';

let currentRoleFilter = 'all';
let cachedUsers = [];
const MAX_VISIBLE_MEMBER_ROWS = 8;

function fitMemberTableToMaxRows(wrapEl, maxRows = MAX_VISIBLE_MEMBER_ROWS) {
  if (!wrapEl) return;
  const table = wrapEl.querySelector('table.user-table');
  const thead = table?.querySelector('thead');
  const rows = table ? Array.from(table.querySelectorAll('tbody tr')) : [];
  if (!table || rows.length <= maxRows) {
    wrapEl.style.maxHeight = '';
    return;
  }
  const headerHeight = thead ? Math.ceil(thead.getBoundingClientRect().height) : 0;
  const firstRowHeight = rows[0]?.getBoundingClientRect().height || 0;
  if (headerHeight === 0 && firstRowHeight === 0) return;
  let bodyHeight = 0;
  for (let i = 0; i < maxRows; i++) {
    bodyHeight += rows[i].getBoundingClientRect().height || rows[i].offsetHeight || 0;
  }
  if (bodyHeight > 0) {
    wrapEl.style.maxHeight = `${Math.ceil(headerHeight + bodyHeight + 2)}px`;
  }
}

function refitAllMemberTables() {
  requestAnimationFrame(() => {
    fitMemberTableToMaxRows($('dashActivityTableWrap'), MAX_VISIBLE_MEMBER_ROWS);
    fitMemberTableToMaxRows($('userListContainer'), MAX_VISIBLE_MEMBER_ROWS);
  });
}

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
    { btn: $('tabBtnDashboard'), pane: $('tabDashboard') },
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
      refitAllMemberTables();
    });
  });

  let _resizeFitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeFitTimer);
    _resizeFitTimer = setTimeout(refitAllMemberTables, 120);
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
  initGoogleSheetSection();

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

$('pushCloudSyncNowBtn')?.addEventListener('click', async () => {
  const msg = $('sbConfigMsg');
  const btn = $('pushCloudSyncNowBtn');
  try {
    const lic = await checkCurrentLicense(false);
    const username = lic?.username;
    if (!username) throw new Error('Không tìm thấy tài khoản đang đăng nhập.');
    if (btn) btn.disabled = true;
    if (msg) {
      msg.className = 'msg-box info';
      msg.textContent = 'Đang đồng bộ toàn bộ tài khoản FB, danh mục nhóm, SĐT Maps & FB Group lên Supabase...';
    }
    const res = await pushLocalChangesToSupabase(username);
    if (res.needTables) {
      if (msg) {
        msg.className = 'msg-box err';
        msg.textContent = 'Chưa có các bảng đồng bộ trên Supabase! Hãy bấm "Sao chép mã SQL tạo bảng (1-Chạm)" rồi chạy trong Supabase SQL Editor.';
      }
      return;
    }
    if (msg) {
      msg.className = 'msg-box ok';
      msg.textContent = `Đã đẩy thành công ${res.count || 0} bản ghi dữ liệu của "${username}" lên Supabase!`;
    }
  } catch (err) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Lỗi đẩy dữ liệu lên Supabase: ' + (err?.message || String(err));
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('pullCloudSyncNowBtn')?.addEventListener('click', async () => {
  const msg = $('sbConfigMsg');
  const btn = $('pullCloudSyncNowBtn');
  try {
    const lic = await checkCurrentLicense(false);
    const username = lic?.username;
    if (!username) throw new Error('Không tìm thấy tài khoản đang đăng nhập.');
    if (btn) btn.disabled = true;
    if (msg) {
      msg.className = 'msg-box info';
      msg.textContent = 'Đang tải và gộp dữ liệu từ Supabase về trình duyệt...';
    }
    const res = await hydrateLocalFromSupabase(username, { force: true });
    if (msg) {
      msg.className = 'msg-box ok';
      msg.textContent = `Đã đồng bộ từ Supabase: ${res.counts?.workspaces || 0} mục cấu hình, ${res.counts?.phones || 0} SĐT, ${res.counts?.groups || 0} nhóm FB (cập nhật: ${res.updatedKeys?.length || 0} nhóm dữ liệu).`;
    }
  } catch (err) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Lỗi tải dữ liệu từ Supabase: ' + (err?.message || String(err));
    }
  } finally {
    if (btn) btn.disabled = false;
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
    renderKpiCards(cachedUsers);
    renderDashboardTable();
  } catch (err) {
    container.innerHTML = `<p style="padding:20px;text-align:center;color:#f87171">Lỗi tải dữ liệu: ${err.message}</p>`;
  }
}

// ── Hộp thoại Đổi tên tài khoản đăng nhập (Username) ──────────────────────────
function openRenameUserModal(oldUsername) {
  let overlay = document.getElementById('renameUserModalOverlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'renameUserModalOverlay';
  overlay.className = 'rename-modal-overlay';
  overlay.innerHTML = `
    <div class="rename-modal-card">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--card-border, #334155)">
        <div style="font-weight:700;font-size:16px;color:var(--text-main,#f8fafc);display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">✏️</span>
          <span>Đổi tên tài khoản đăng nhập</span>
        </div>
        <button type="button" class="rename-user-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-sub,#94a3b8);line-height:1;padding:4px" title="Đóng">✕</button>
      </div>
      <div style="padding:20px">
        <div style="font-size:12.5px;color:var(--text-sub,#94a3b8);margin-bottom:16px;background:rgba(255,255,255,0.03);padding:12px 14px;border-radius:10px;border:1px solid var(--card-border,#334155);line-height:1.6">
          <div><b>Tài khoản hiện tại:</b> <span style="color:#60a5fa;font-weight:700;font-size:13.5px">${escapeHtml(oldUsername)}</span></div>
          <div style="font-size:11.5px;color:var(--text-sub,#94a3b8);margin-top:2px">Nguồn dữ liệu: Supabase PostgreSQL (ntd_users)</div>
        </div>

        <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:700;color:var(--text-main,#f8fafc)">
          Tên tài khoản đăng nhập mới (theo yêu cầu khách hàng):
        </label>
        <input type="text" id="renameUserModalInput" value="${escapeHtml(oldUsername)}" placeholder="VD: nam_marketing, anh_tu_bds, spa_linh..." style="width:100%;box-sizing:border-box;padding:11px 14px;font-size:14px;border:1.5px solid var(--card-border,#475569);border-radius:8px;outline:none;background:var(--input-bg, #0f172a);color:var(--text-main,#f8fafc);font-family:monospace;font-weight:600">
        
        <div style="font-size:11.5px;color:var(--text-sub,#94a3b8);margin-top:8px;line-height:1.4">
          ⚠️ <b>Quy tắc:</b> Tên tài khoản viết thường, liền không dấu (hỗ trợ chữ cái, số, gạch dưới <code>_</code> hoặc gạch ngang <code>-</code>). Không dùng khoảng trắng hoặc ký tự có dấu.
        </div>

        <div style="font-size:12px;color:#93c5fd;margin-top:14px;line-height:1.5;background:rgba(59,130,246,0.1);padding:10px 12px;border-radius:8px;border:1px solid rgba(59,130,246,0.25)">
          💡 <b>Tự động di chuyển dữ liệu:</b> Khi đổi tên, toàn bộ dữ liệu của khách (Hạn sử dụng, Mật khẩu, Trạng thái, Mã máy, Nick Facebook & Nhóm quét) sẽ tự động được giữ nguyên và liên kết sang Tên đăng nhập mới!
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--card-border,#334155);background:rgba(0,0,0,0.15)">
        <button type="button" class="btn-secondary rename-user-modal-cancel" style="padding:8px 16px;font-size:13px;font-weight:600">Hủy (Esc)</button>
        <button type="button" class="btn-primary rename-user-modal-save" style="padding:8px 22px;font-size:13px;font-weight:700">💾 Xác nhận Đổi tên (Enter)</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input = overlay.querySelector('#renameUserModalInput');
  const closeBtn = overlay.querySelector('.rename-user-modal-close');
  const cancelBtn = overlay.querySelector('.rename-user-modal-cancel');
  const saveBtn = overlay.querySelector('.rename-user-modal-save');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', handleKey);
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') doSave();
  };
  document.addEventListener('keydown', handleKey);

  closeBtn.onclick = close;
  cancelBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  const doSave = async () => {
    const rawVal = input.value.trim().toLowerCase();
    if (!rawVal) {
      alert('Vui lòng nhập tên tài khoản mới.');
      input.focus();
      return;
    }
    if (rawVal === oldUsername.toLowerCase()) {
      alert('Tên tài khoản mới trùng với tên hiện tại. Vui lòng nhập tên khác.');
      input.focus();
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(rawVal)) {
      alert('Tên tài khoản chỉ được chứa chữ cái, chữ số, gạch dưới (_), gạch ngang (-) hoặc chấm (.). Không dùng khoảng trắng hoặc tiếng Việt có dấu.');
      input.focus();
      return;
    }

    if (!confirm(`Xác nhận đổi tên tài khoản đăng nhập từ "${oldUsername}" sang "${rawVal}" theo yêu cầu khách hàng?`)) {
      return;
    }

    try {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Đang đổi tên…';

      if (await isSupabaseConfigured()) {
        await supabaseRenameUser(oldUsername, rawVal);
      } else {
        const scriptUrl = await getGoogleScriptUrl();
        if (!scriptUrl) throw new Error('Chưa cấu hình Supabase hoặc Google Sheets.');
        const targetUrl = new URL(scriptUrl);
        targetUrl.searchParams.set('action', 'rename_user');
        targetUrl.searchParams.set('admin_pass', DEFAULT_PASS);
        targetUrl.searchParams.set('username', oldUsername);
        targetUrl.searchParams.set('new_username', rawVal);
        const res = await fetch(targetUrl.toString(), { method: 'GET', redirect: 'follow' });
        const json = await res.json().catch(() => ({}));
        if (!json.ok) throw new Error(json.error || 'Lỗi đổi tên trên Google Sheets');
      }

      close();
      alert(`🎉 Đã đổi tên tài khoản thành công!\nTên đăng nhập mới của khách: ${rawVal}`);
      loadUserList();
    } catch (err) {
      alert('Lỗi đổi tên tài khoản: ' + err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Xác nhận Đổi tên (Enter)';
    }
  };

  saveBtn.onclick = doSave;

  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
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
    container.style.maxHeight = '';
    container.innerHTML = '<p style="padding:24px;text-align:center;color:var(--text-sub)">Không có tài khoản nào phù hợp bộ lọc.</p>';
    return;
  }

  let html = `
    <table class="user-table">
      <thead>
        <tr>
          <th>Tài khoản</th>
          <th>Mật khẩu</th>
          <th>Vai trò</th>
          <th style="text-align:center">Nick FB</th>
          <th style="text-align:center">Fanpage</th>
          <th style="text-align:center">Bài hôm nay</th>
          <th style="text-align:center">Quét nhóm</th>
          <th style="text-align:center">Quét Maps</th>
          <th>Đăng nhập cuối</th>
          <th>Hạn dùng</th>
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

    // Hiển thị số liệu hoạt động / hiệu suất
    const loginInfo = formatRelativeTime(u.rawLastLogin);

    const fbCount = Number(u.fbCount) || 0;
    const fbBadge = fbCount > 0 
      ? `<span class="metric-badge badge-blue" title="${fbCount} nick Facebook">${fbCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const fpCount = Number(u.fanpageCount) || 0;
    const fpBadge = fpCount > 0
      ? `<span class="metric-badge badge-purple" title="${fpCount} Fanpage">${fpCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const postCount = Number(u.todayPosts) || 0;
    const postBadge = postCount > 0
      ? `<span class="metric-badge badge-green" title="${postCount} bài đăng hôm nay">🚀 ${postCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const groupCount = Number(u.todayGroupScans) || 0;
    const groupBadge = groupCount > 0
      ? `<span class="metric-badge badge-orange" title="${groupCount} SĐT / data quét nhóm hôm nay">📞 ${groupCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const mapsCount = Number(u.todayMapsScans) || 0;
    const mapsBadge = mapsCount > 0
      ? `<span class="metric-badge badge-orange" title="${mapsCount} cơ sở Maps quét hôm nay">🗺️ ${mapsCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

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
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <b style="color:var(--text-main)">${escapeHtml(u.username)}</b>
            <button type="button" class="btn-rename-user-icon" data-user="${escapeHtml(u.username)}" title="Đổi tên đăng nhập tài khoản này" style="background:none;border:none;cursor:pointer;font-size:12px;opacity:0.75;padding:2px 4px;border-radius:4px;color:var(--text-sub)">✏️</button>
          </div>
        </td>
        <td style="font-family:monospace;color:var(--text-sub)">${escapeHtml(u.password)}</td>
        <td>${roleBadge}</td>
        <td style="text-align:center">${fbBadge}</td>
        <td style="text-align:center">${fpBadge}</td>
        <td style="text-align:center">${postBadge}</td>
        <td style="text-align:center">${groupBadge}</td>
        <td style="text-align:center">${mapsBadge}</td>
        <td>
          <div style="font-weight:600;font-size:12px">${loginInfo.display}</div>
          <div style="font-size:11px;color:${loginInfo.isToday ? '#34d399' : 'var(--text-sub)'}">${loginInfo.sub}</div>
        </td>
        <td><b>${escapeHtml(u.expiry)}</b></td>
        <td>${statusBadge}</td>
        <td>${machineDisplay}</td>
        <td style="color:var(--text-sub);max-width:150px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(u.note)}">${escapeHtml(u.note || '-')}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button type="button" class="action-btn-sm btn-rename-user" data-user="${escapeHtml(u.username)}" style="background:#059669;color:#fff" title="Đổi tên tài khoản đăng nhập (Username) theo yêu cầu khách hàng">✏️ Đổi tên</button>
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
  fitMemberTableToMaxRows(container, MAX_VISIBLE_MEMBER_ROWS);

  attachTableEventListeners(container);
}

// Gắn sự kiện các nút tương tác trong bảng
function attachTableEventListeners(container) {
  // 0. Đổi tên tài khoản đăng nhập (Username)
  container.querySelectorAll('.btn-rename-user, .btn-rename-user-icon').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = btn.getAttribute('data-user');
      openRenameUserModal(u);
    });
  });

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


// ── 7B. DASHBOARD HOẠT ĐỘNG (TELEMETRY & KPI) ──────────────────────────────
let dashFilter = 'all';
let dashSearch = '';

function formatRelativeTime(dateString) {
  if (!dateString) return { display: 'Chưa đăng nhập', sub: 'Chưa có hoạt động', isToday: false };

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return { display: 'Không rõ', sub: '', isToday: false };

  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  const formattedExact = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString('vi-VN');

  let relative = '';
  if (diffSec < 60) {
    relative = 'Vừa xong';
  } else if (diffMin < 60) {
    relative = `${diffMin} phút trước`;
  } else if (diffHours < 24) {
    relative = `${diffHours} giờ trước`;
  } else if (diffDays <= 30) {
    relative = `${diffDays} ngày trước`;
  } else {
    relative = date.toLocaleDateString('vi-VN');
  }

  return { display: formattedExact, sub: relative, isToday: diffHours < 24 };
}

function renderKpiCards(users) {
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.status === 'active' && !u.isExpired).length;

  let totalFb = 0;
  let totalFanpages = 0;
  let todayPosts = 0;
  let groupScans = 0;
  let mapsScans = 0;

  users.forEach(u => {
    totalFb += Number(u.fbCount) || 0;
    totalFanpages += Number(u.fanpageCount) || 0;
    todayPosts += Number(u.todayPosts) || 0;
    groupScans += Number(u.todayGroupScans) || 0;
    mapsScans += Number(u.todayMapsScans) || 0;
  });

  if ($('kpiActiveUsers')) $('kpiActiveUsers').textContent = activeUsers;
  if ($('kpiTotalUsers')) $('kpiTotalUsers').textContent = totalUsers;
  if ($('kpiTotalFb')) $('kpiTotalFb').textContent = totalFb.toLocaleString('vi-VN');
  if ($('kpiTotalFanpages')) $('kpiTotalFanpages').textContent = totalFanpages.toLocaleString('vi-VN');
  if ($('kpiTodayPosts')) $('kpiTodayPosts').textContent = todayPosts.toLocaleString('vi-VN');
  if ($('kpiGroupScans')) $('kpiGroupScans').textContent = groupScans.toLocaleString('vi-VN');
  if ($('kpiMapsScans')) $('kpiMapsScans').textContent = mapsScans.toLocaleString('vi-VN');
}

function filterDashUsers(users) {
  const q = (dashSearch || '').trim().toLowerCase();

  return users.filter(u => {
    if (q) {
      const matchName = (u.username || '').toLowerCase().includes(q);
      const matchNote = (u.note || '').toLowerCase().includes(q);
      if (!matchName && !matchNote) return false;
    }

    if (dashFilter === 'active-today') {
      if (!u.rawLastLogin) return false;
      const d = new Date(u.rawLastLogin);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    }
    if (dashFilter === 'has-fb') {
      return (Number(u.fbCount) || 0) > 0;
    }
    if (dashFilter === 'has-posts') {
      return (Number(u.todayPosts) || 0) > 0;
    }
    if (dashFilter === 'has-scans') {
      return (Number(u.todayGroupScans) || 0) > 0 || (Number(u.todayMapsScans) || 0) > 0;
    }
    if (dashFilter === 'admin') {
      return u.role === 'admin';
    }
    if (dashFilter === 'member') {
      return u.role !== 'admin';
    }

    return true;
  });
}

function renderDashboardTable() {
  const tbody = $('dashActivityTbody');
  if (!tbody) return;

  const filtered = filterDashUsers(cachedUsers);

  if (filtered.length === 0) {
    const wrap = $('dashActivityTableWrap');
    if (wrap) wrap.style.maxHeight = '';
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:32px;color:var(--text-sub)">
          Không tìm thấy tài khoản nào phù hợp với bộ lọc hiện tại.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((u, idx) => {
    const isAdmin = u.role === 'admin';
    const firstLetter = (u.username || 'U').charAt(0).toUpperCase();
    const loginInfo = formatRelativeTime(u.rawLastLogin);

    let statusBadge = '';
    if (u.status === 'locked') {
      statusBadge = '<span class="badge-locked">Bị khóa</span>';
    } else if (u.isExpired) {
      statusBadge = '<span class="badge-expired">Hết hạn</span>';
    } else {
      statusBadge = '<span class="badge-active">Hoạt động</span>';
    }

    const fbCount = Number(u.fbCount) || 0;
    const fbBadge = fbCount > 0 
      ? `<span class="metric-badge badge-blue" title="${fbCount} nick Facebook cá nhân">${fbCount} nick</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const fpCount = Number(u.fanpageCount) || 0;
    const fpBadge = fpCount > 0
      ? `<span class="metric-badge badge-purple" title="${fpCount} Fanpage vệ tinh">${fpCount} page</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const postCount = Number(u.todayPosts) || 0;
    const postBadge = postCount > 0
      ? `<span class="metric-badge badge-green" title="${postCount} bài đã đăng hôm nay">🚀 ${postCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const groupCount = Number(u.todayGroupScans) || 0;
    const groupBadge = groupCount > 0
      ? `<span class="metric-badge badge-orange" title="${groupCount} SĐT / dữ liệu quét từ nhóm hôm nay">📞 ${groupCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    const mapsCount = Number(u.todayMapsScans) || 0;
    const mapsBadge = mapsCount > 0
      ? `<span class="metric-badge badge-orange" title="${mapsCount} cơ sở doanh nghiệp quét từ Maps hôm nay">🗺️ ${mapsCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    return `
      <tr>
        <td style="text-align:center;color:var(--text-sub);font-weight:700">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="user-avatar-sm">${firstLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text-main);display:flex;align-items:center;gap:6px">
                <span>${escapeHtml(u.username)}</span>
                <button type="button" class="btn-rename-user-icon" data-user="${escapeHtml(u.username)}" title="Đổi tên đăng nhập tài khoản này" style="background:none;border:none;cursor:pointer;font-size:11px;opacity:0.75;padding:1px 3px;color:var(--text-sub)">✏️</button>
                ${isAdmin ? '<span class="badge-role-admin" style="font-size:9.5px;padding:1px 5px">👑 Admin</span>' : '<span class="badge-role-member" style="font-size:9.5px;padding:1px 5px">👤 Member</span>'}
              </div>
              <div style="font-size:11.5px;color:var(--text-sub);margin-top:2px" title="${escapeHtml(u.note)}">${escapeHtml(u.note || 'Không có ghi chú')}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">${fbBadge}</td>
        <td style="text-align:center">${fpBadge}</td>
        <td style="text-align:center">${postBadge}</td>
        <td style="text-align:center">${groupBadge}</td>
        <td style="text-align:center">${mapsBadge}</td>
        <td>
          <div style="font-weight:600">${loginInfo.display}</div>
          <div style="font-size:11px;color:${loginInfo.isToday ? '#34d399' : 'var(--text-sub)'}">${loginInfo.sub}</div>
        </td>
        <td>
          <div style="font-weight:600;margin-bottom:3px">${u.expiry || '--/--/----'}</div>
          <div>${statusBadge}</div>
        </td>
        <td style="text-align:right">
          <button type="button" class="action-btn-sm btn-quick-manage" data-user="${escapeHtml(u.username)}" style="background:#ea580c;color:#fff;padding:5px 9px" title="Chuyển sang tab Phân quyền để đổi mật khẩu, vai trò hoặc gia hạn">
            ⚙️ Quản trị
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện nút Đổi tên tài khoản đăng nhập
  tbody.querySelectorAll('.btn-rename-user-icon').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = btn.getAttribute('data-user');
      openRenameUserModal(u);
    });
  });

  // Gắn sự kiện nút Quản trị từng dòng để chuyển ngay sang tab Phân quyền
  tbody.querySelectorAll('.btn-quick-manage').forEach(btn => {
    btn.addEventListener('click', () => {
      $('tabBtnUsers')?.click();
      setTimeout(() => {
        $('userListContainer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    });
  });

  fitMemberTableToMaxRows($('dashActivityTableWrap'), MAX_VISIBLE_MEMBER_ROWS);
}

function exportDashCsv() {
  if (!cachedUsers || cachedUsers.length === 0) {
    alert('Không có dữ liệu để xuất file.');
    return;
  }

  const filtered = filterDashUsers(cachedUsers);
  const headers = [
    'STT',
    'Tên tài khoản',
    'Vai trò',
    'Ghi chú',
    'Nick FB cá nhân',
    'Fanpage',
    'Bài đăng hôm nay',
    'Quét số nhóm hôm nay',
    'Quét Maps hôm nay',
    'Đăng nhập cuối',
    'Hạn sử dụng',
    'Trạng thái'
  ];

  const rows = filtered.map((u, i) => [
    i + 1,
    `"${(u.username || '').replace(/"/g, '""')}"`,
    u.role || 'member',
    `"${(u.note || '').replace(/"/g, '""')}"`,
    Number(u.fbCount) || 0,
    Number(u.fanpageCount) || 0,
    Number(u.todayPosts) || 0,
    Number(u.todayGroupScans) || 0,
    Number(u.todayMapsScans) || 0,
    `"${u.lastLogin || ''}"`,
    u.expiry || '',
    u.status || 'active'
  ]);

  const csvContent = '\uFEFF' + [
    headers.join(','),
    ...rows.map(r => r.join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const nowStr = new Date().toISOString().slice(0, 10);
  a.download = `Bao_cao_hoat_dong_NTD_Agency_${nowStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Gắn sự kiện các chức năng Dashboard
$('refreshDashBtn')?.addEventListener('click', loadUserList);
$('exportDashCsvBtn')?.addEventListener('click', exportDashCsv);

$('dashSearchInput')?.addEventListener('input', (e) => {
  dashSearch = e.target.value;
  renderDashboardTable();
});

document.querySelectorAll('.dash-pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dash-pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dashFilter = btn.getAttribute('data-dashfilter') || 'all';
    renderDashboardTable();
  });
});

// ── 8. BỘ LỌC VAI TRÒ ────────────────────────────────────────────────────────
document.querySelectorAll('.role-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRoleFilter = btn.getAttribute('data-filter') || 'all';
    renderUserTable();
    renderKpiCards(cachedUsers);
    renderDashboardTable();
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

// ── 9. QUẢN LÝ BẢNG TÍNH GOOGLE SHEET TRỰC TIẾP & ĐỒNG BỘ ──────────────────
const DEFAULT_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/1x-5BC99xWLIprAV35BO0f4dAp9RbqUVXm8ytHBU8XmA/edit?gid=1321941166#gid=1321941166';
let parsedImportUsers = [];

function toGoogleSheetEmbedUrl(rawUrl) {
  if (!rawUrl) return '';
  const idMatch = rawUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return rawUrl;
  const sheetId = idMatch[1];
  const gidMatch = rawUrl.match(/gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}&widget=true&headers=false&embedded=true`;
}

function initGoogleSheetSection() {
  const storedUrl = localStorage.getItem('ntd_sheet_view_url') || DEFAULT_SHEET_VIEW_URL;
  const sheetInput = $('sheetUrlInput');
  const iframe = $('sheetIframe');
  const extBtn = $('openSheetExternalBtn');

  if (sheetInput) sheetInput.value = storedUrl;
  if (iframe) iframe.src = toGoogleSheetEmbedUrl(storedUrl);
  if (extBtn) extBtn.href = storedUrl;

  // Nút Lưu URL Google Sheet mới
  $('saveSheetUrlBtn')?.addEventListener('click', () => {
    const val = $('sheetUrlInput')?.value?.trim() || DEFAULT_SHEET_VIEW_URL;
    localStorage.setItem('ntd_sheet_view_url', val);
    if (iframe) iframe.src = toGoogleSheetEmbedUrl(val);
    if (extBtn) extBtn.href = val;

    const msg = $('sheetUrlMsg');
    if (msg) {
      msg.className = 'msg-box ok';
      msg.textContent = 'Đã lưu và cập nhật Bảng tính Google Sheet thành công!';
      setTimeout(() => { msg.style.display = 'none'; }, 3000);
    }
  });

  // Nút Tải lại khung iframe
  $('refreshSheetFrameBtn')?.addEventListener('click', () => {
    if (!iframe) return;
    const currentSrc = iframe.src;
    iframe.src = 'about:blank';
    setTimeout(() => { iframe.src = currentSrc; }, 100);
  });

  // Nút Tải dữ liệu & Đồng bộ tự động 1-Chạm
  $('autoSyncFromSheetBtn')?.addEventListener('click', async () => {
    const msg = $('autoSyncMsg');
    const sheetUrl = $('sheetUrlInput')?.value?.trim() || DEFAULT_SHEET_VIEW_URL;
    const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);

    if (!idMatch) {
      if (msg) {
        msg.className = 'msg-box err';
        msg.textContent = 'Link Google Sheet không hợp lệ.';
      }
      return;
    }

    const sheetId = idMatch[1];
    const gidMatch = sheetUrl.match(/gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    const csvExportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    if (msg) {
      msg.className = 'msg-box info';
      msg.textContent = 'Đang tải dữ liệu từ Google Sheets…';
    }

    try {
      const resp = await fetch(csvExportUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const csvText = await resp.text();

      if (!csvText || csvText.length < 5) {
        throw new Error('Dữ liệu trả về từ Sheet rỗng.');
      }

      if ($('importPasteInput')) {
        $('importPasteInput').value = csvText;
      }
      parseAndPreviewImport(csvText);

      if (msg) {
        msg.className = 'msg-box ok';
        msg.textContent = `Đã tải thành công dữ liệu từ Google Sheet! Vui lòng kiểm tra bảng xem trước bên dưới và bấm "Xác nhận Nhập tất cả".`;
      }
    } catch (err) {
      if (msg) {
        msg.className = 'msg-box err';
        msg.innerHTML = `⚠️ <b>Google Sheet chưa bật chế độ công khai:</b> Google chặn tải tự động từ bên ngoài.<br>
          👉 <b>Giải pháp siêu nhanh:</b> Bạn mở Google Sheet &rarr; Bôi đen danh sách tài khoản &rarr; Bấm <b>Ctrl + C</b> &rarr; Dán vào ô bên dưới &rarr; Bấm <b>"Xem trước danh sách"</b>!`;
      }
    }
  });

  // Nút Xem trước dữ liệu dán
  $('previewImportBtn')?.addEventListener('click', () => {
    const raw = $('importPasteInput')?.value || '';
    parseAndPreviewImport(raw);
  });

  // Nút Xác nhận nạp vào Supabase
  $('confirmImportBtn')?.addEventListener('click', async () => {
    if (!parsedImportUsers || parsedImportUsers.length === 0) {
      alert('Không có tài khoản nào hợp lệ để nhập.');
      return;
    }

    const msg = $('importMsg');
    const confirmBtn = $('confirmImportBtn');

    if (!confirm(`Xác nhận nạp ${parsedImportUsers.length} tài khoản này vào cơ sở dữ liệu Supabase?`)) {
      return;
    }

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Đang nạp vào Supabase...';
    }

    if (msg) {
      msg.className = 'msg-box info';
      msg.textContent = `Đang đồng bộ ${parsedImportUsers.length} tài khoản vào Supabase...`;
    }

    try {
      const res = await supabaseUpsertUsers(parsedImportUsers);
      if (msg) {
        msg.className = 'msg-box ok';
        msg.innerHTML = `🎉 <b>Nhập thành công!</b> Đã đưa <b>${res.count || parsedImportUsers.length}</b> tài khoản vào Supabase. Khách hàng có thể đăng nhập trên Website ngay bây giờ!`;
      }
      await loadUserList();
      alert(`Đã nhập thành công ${res.count || parsedImportUsers.length} tài khoản vào Supabase!`);
    } catch (err) {
      if (msg) {
        msg.className = 'msg-box err';
        msg.textContent = `Lỗi nhập tài khoản vào Supabase: ${err.message}`;
      }
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = `🚀 Xác nhận Nhập tất cả vào Supabase (${parsedImportUsers.length})`;
      }
    }
  });
}

function parseVietnameseDate(val) {
  if (!val) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  }
  const s = String(val).trim();
  // Khớp YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    const p = s.split('T')[0].split('-');
    return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
  }
  // Khớp DD/MM/YYYY hoặc DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 30);
  return fallback.toISOString().split('T')[0];
}

function parseAndPreviewImport(rawText) {
  const container = $('importPreviewContainer');
  const tbody = $('importPreviewTbody');
  const msg = $('importMsg');
  const confirmBtn = $('confirmImportBtn');
  const countBadge = $('importCountBadge');

  if (!rawText || !rawText.trim()) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Vui lòng dán dữ liệu từ Google Sheet vào ô trên trước khi xem trước.';
    }
    return;
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return;

  // Tự động phân tách theo Tab (\t) hoặc Phẩy (,)
  const isTab = lines[0].includes('\t');
  const separator = isTab ? '\t' : ',';

  let startIndex = 0;
  const firstCols = lines[0].split(separator).map(c => c.trim().toLowerCase().replace(/^["']|["']$/g, ''));

  // Kiểm tra xem dòng đầu có phải dòng tiêu đề không (Tài khoản, Mật khẩu,...)
  const isHeader = firstCols.some(c => 
    c.includes('tài khoản') || c.includes('username') || c.includes('user') || c.includes('khách') || c.includes('mật khẩu') || c.includes('pass')
  );
  if (isHeader) {
    startIndex = 1;
  }

  parsedImportUsers = [];
  const rows = [];

  for (let i = startIndex; i < lines.length; i++) {
    const cols = lines[i].split(separator).map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length === 0 || !cols[0]) continue;

    const username = (cols[0] || '').toLowerCase().trim();
    if (!username || username === 'admin' || username === 'tài khoản') continue;

    const password = cols[1] || '123456';
    const rawDate = cols[2] || '';
    const expiryDate = parseVietnameseDate(rawDate);
    
    // Tự động nhận diện vai trò (admin nếu cột chứa chữ admin)
    let role = 'member';
    let note = '';
    
    for (let c = 3; c < cols.length; c++) {
      const val = cols[c];
      if (val.toLowerCase() === 'admin') {
        role = 'admin';
      } else if (val) {
        note = note ? `${note} - ${val}` : val;
      }
    }

    parsedImportUsers.push({
      username,
      password,
      role,
      expiryDate,
      note,
      status: 'active'
    });

    rows.push(`
      <tr>
        <td>${parsedImportUsers.length}</td>
        <td><b style="color:var(--primary)">${escapeHtml(username)}</b></td>
        <td><code>${escapeHtml(password)}</code></td>
        <td><span class="${role === 'admin' ? 'badge-role-admin' : 'badge-role-member'}">${role.toUpperCase()}</span></td>
        <td>${expiryDate}</td>
        <td style="color:var(--text-sub)">${escapeHtml(note || '-')}</td>
      </tr>
    `);
  }

  if (parsedImportUsers.length === 0) {
    if (msg) {
      msg.className = 'msg-box err';
      msg.textContent = 'Không tìm thấy dòng tài khoản hợp lệ nào. Hãy kiểm tra lại dữ liệu vừa dán.';
    }
    if (container) container.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'none';
    return;
  }

  if (tbody) tbody.innerHTML = rows.join('');
  if (container) container.style.display = 'block';
  if (confirmBtn) {
    confirmBtn.style.display = 'inline-flex';
    if (countBadge) countBadge.textContent = parsedImportUsers.length;
  }
  if (msg) {
    msg.className = 'msg-box ok';
    msg.textContent = `Đã phân tích thành công ${parsedImportUsers.length} tài khoản! Hãy nhấn nút "Xác nhận Nhập tất cả vào Supabase" để lưu vào hệ thống.`;
  }
}

// Chạy khởi tạo
initAdminPage();
