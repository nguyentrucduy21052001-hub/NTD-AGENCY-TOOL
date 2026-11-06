import {
  loginWithAccount,
  getMachineId,
  checkCurrentLicense,
  logoutAccount,
  getGoogleScriptUrl,
  setGoogleScriptUrl,
  setCustomMachineId,
  resetMachineIdForAccount
} from './license.js';
import { initSyncModal } from './sync_helper.js';
import { mountThemeToggle } from './theme_toggle.js';

// Gắn nút chuyển đổi Chế độ Ban ngày / Ban đêm góc trên bên phải
mountThemeToggle();

const $ = id => document.getElementById(id);

// Khởi tạo modal phục hồi dữ liệu cũ 1-chạm
initSyncModal({
  triggerBtnId: 'openSyncModalBtn',
  defaultTab: 'restore',
  onRestoreSuccess: async () => {
    const existing = await checkCurrentLicense(false);
    if (existing) {
      window.location.href = chrome.runtime.getURL('panel.html');
    } else {
      window.location.reload();
    }
  }
});

// ── 1. Lấy và hiển thị Machine ID ─────────────────────────────────────────────
let activeMachineId = await getMachineId();
const machineIdEl = $('machineIdDisplay');
if (machineIdEl) machineIdEl.textContent = activeMachineId;

// Tự động đảm bảo URL Google Apps Script được nạp và lưu trữ
getGoogleScriptUrl().then(url => {
  const urlInput = $('scriptUrlInput');
  if (urlInput && (!urlInput.value || urlInput.value.length < 10)) {
    urlInput.value = url;
  }
}).catch(() => {});

// ── 2. Kiểm tra nếu đã có tài khoản đang đăng nhập hợp lệ ─────────────────────
async function checkExistingLogin() {
  try {
    const existing = await checkCurrentLicense(false);
    const card = $('alreadyActiveCard');
    const desc = $('alreadyActiveDesc');

    if (existing && card && desc) {
      card.style.display = 'block';
      const expDate = new Date(existing.expiry);
      const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
      const expiryText = existing.expiryFormatted || expDate.toLocaleDateString('vi-VN');

      desc.innerHTML =
        `Tài khoản: <b style="color:#0f172a;font-size:13.5px">${existing.username}</b> &nbsp;·&nbsp; ` +
        `Hạn dùng: <b>${expiryText}</b> ` +
        `<span style="color:${daysLeft <= 7 ? '#b91c1c' : '#15803d'};font-weight:700">(còn ${daysLeft} ngày)</span>`;
    } else if (card) {
      card.style.display = 'none';
    }
  } catch (e) {
    console.warn('Lỗi kiểm tra trạng thái đăng nhập:', e);
  }
}
await checkExistingLogin();

// ── 3. Đăng xuất tài khoản từ banner ─────────────────────────────────────────
$('cardLogoutBtn')?.addEventListener('click', async () => {
  if (!confirm('Bạn có chắc chắn muốn đăng xuất tài khoản này khỏi máy tính?')) return;
  await logoutAccount();
  const card = $('alreadyActiveCard');
  if (card) card.style.display = 'none';
  const msgEl = $('loginMsg');
  if (msgEl) {
    msgEl.className = 'ok';
    msgEl.textContent = 'Đã đăng xuất. Vui lòng đăng nhập tài khoản khác để tiếp tục.';
  }
  const uInput = $('usernameInput');
  const pInput = $('passwordInput');
  if (uInput) uInput.value = '';
  if (pInput) pInput.value = '';
  if (uInput) uInput.focus();
});

// ── 4. Sao chép & Tùy chỉnh Machine ID ───────────────────────────────────────
$('copyMidBtn')?.addEventListener('click', async () => {
  const btn = $('copyMidBtn');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(activeMachineId);
    } else {
      const ta = document.createElement('textarea');
      ta.value = activeMachineId;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.textContent = 'Đã sao chép!';
  } catch (err) {
    prompt('Vui lòng bôi đen và nhấn Ctrl+C để sao chép mã máy:', activeMachineId);
    btn.textContent = 'Đã sao chép!';
  }
  setTimeout(() => {
    btn.textContent = 'Sao chép';
  }, 2200);
});

$('editMidBtn')?.addEventListener('click', async () => {
  const current = activeMachineId;
  const input = prompt(
    'Nhập mã máy cũ của bạn (từ bản cài đặt trước) nếu bạn muốn dùng tiếp mã cũ:',
    current
  );
  if (!input || !input.trim()) return;
  const clean = input.trim();
  if (clean.length < 8) {
    alert('Mã máy quá ngắn, vui lòng kiểm tra lại.');
    return;
  }
  try {
    await setCustomMachineId(clean);
    activeMachineId = clean;
    if (machineIdEl) machineIdEl.textContent = clean;
    alert('Đã đổi mã máy thành: ' + clean + '\nBây giờ bạn có thể thử đăng nhập lại.');
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
});

// ── 5. Hiện / Ẩn mật khẩu ────────────────────────────────────────────────────
$('togglePasswordBtn')?.addEventListener('click', () => {
  const pInput = $('passwordInput');
  const btn = $('togglePasswordBtn');
  if (!pInput) return;
  if (pInput.type === 'password') {
    pInput.type = 'text';
    btn.textContent = 'Ẩn';
  } else {
    pInput.type = 'password';
    btn.textContent = 'Hiện';
  }
});

let detectedSheetMid = '';

// ── 6. Xử lý Đăng nhập ───────────────────────────────────────────────────────
async function doLogin() {
  const uInput = $('usernameInput');
  const pInput = $('passwordInput');
  const btn = $('submitLoginBtn');
  const msgEl = $('loginMsg');

  const username = uInput?.value?.trim();
  const password = pInput?.value?.trim();

  if (!msgEl) return;
  msgEl.className = '';
  msgEl.textContent = '';
  msgEl.style.display = 'none';

  const lockedBox = $('lockedMachineBox');
  const useOldBtn = $('useOldMidAndLoginBtn');
  if (lockedBox) lockedBox.style.display = 'none';
  if (useOldBtn) useOldBtn.style.display = 'none';

  if (!username) {
    msgEl.className = 'err';
    msgEl.textContent = 'Vui lòng nhập Tên tài khoản.';
    uInput?.focus();
    return;
  }

  if (!password) {
    msgEl.className = 'err';
    msgEl.textContent = 'Vui lòng nhập Mật khẩu.';
    pInput?.focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span>Đang kiểm tra tài khoản…</span>';
  msgEl.className = '';
  msgEl.textContent = 'Đang kết nối máy chủ Google Sheets để xác thực…';
  msgEl.style.display = 'block';

  try {
    const res = await loginWithAccount(username, password);

    if (!res.ok) {
      msgEl.className = 'err';
      msgEl.textContent = res.error || 'Đăng nhập thất bại. Vui lòng kiểm tra lại thông tin.';
      if (res.lockedToOtherMachine || (res.error && res.error.includes('ghim với máy tính khác'))) {
        if (lockedBox) lockedBox.style.display = 'block';
        if (res.sheetMid) {
          detectedSheetMid = res.sheetMid;
          if (useOldBtn) {
            useOldBtn.style.display = 'flex';
            useOldBtn.innerHTML = `<span>⚡ Dùng lại Mã máy cũ (${res.sheetMid.slice(0, 10)}…) &amp; Đăng nhập ngay</span>`;
          }
        }
      }
      if (res.notConfigured) {
        // Tự động mở hộp cấu hình server cho admin
        const sBox = $('serverConfigBox');
        if (sBox) sBox.style.display = 'block';
      }
      btn.disabled = false;
      btn.innerHTML = '<span>Đăng nhập vào hệ thống</span>';
      return;
    }

    if (lockedBox) lockedBox.style.display = 'none';

    msgEl.className = 'ok';
    msgEl.textContent =
      `Đăng nhập thành công!\n` +
      `• Xin chào: ${res.data.username}\n` +
      `• Hạn sử dụng: ${res.data.expiryFormatted}\n\n` +
      `Đang chuyển vào Bảng điều khiển chính…`;

    setTimeout(() => {
      window.location.href = chrome.runtime.getURL('panel.html');
    }, 1100);
  } catch (err) {
    msgEl.className = 'err';
    msgEl.textContent = 'Lỗi hệ thống: ' + (err.message || String(err));
    btn.disabled = false;
    btn.innerHTML = '<span>Đăng nhập vào hệ thống</span>';
  }
}

$('submitLoginBtn')?.addEventListener('click', doLogin);

// ── 7. Khôi phục 1-chạm mã máy cũ đã ghim cho khách hàng ─────────────────────
$('useOldMidAndLoginBtn')?.addEventListener('click', async () => {
  if (!detectedSheetMid) return;
  const btn = $('useOldMidAndLoginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span>Đang chuyển sang mã máy cũ…</span>';

  try {
    await setCustomMachineId(detectedSheetMid);
    activeMachineId = detectedSheetMid;
    if (machineIdEl) machineIdEl.textContent = detectedSheetMid;

    const lockedBox = $('lockedMachineBox');
    if (lockedBox) lockedBox.style.display = 'none';

    // Đăng nhập lại ngay lập tức
    await doLogin();
  } catch (err) {
    alert('Lỗi: ' + (err.message || String(err)));
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>⚡ Tự động dùng lại Mã máy cũ đã ghim &amp; Đăng nhập ngay</span>';
  }
});

// ── 8. Reset mã máy nhanh cho Admin ngay trên màn hình Đăng nhập ─────────────
$('quickResetMidBtn')?.addEventListener('click', async () => {
  const uInput = $('usernameInput');
  const username = uInput?.value?.trim();
  if (!username) {
    alert('Vui lòng nhập Tên tài khoản trước khi Reset mã máy.');
    uInput?.focus();
    return;
  }

  const pass = prompt(
    `Xác nhận Reset mã máy cho tài khoản "${username}" trên Google Sheets:\n\nNhập Mật khẩu Quản trị (Admin Password):`,
    'DuyAdmin@2025'
  );
  if (!pass || !pass.trim()) return;

  const btn = $('quickResetMidBtn');
  btn.disabled = true;
  btn.innerHTML = '<span>Đang kết nối Google Sheets để reset…</span>';

  try {
    const res = await resetMachineIdForAccount(username, pass.trim());
    if (res.ok) {
      alert(`${res.message || 'Reset mã máy thành công!'}\n\nHệ thống sẽ tự động đăng nhập tài khoản với mã máy hiện tại ngay bây giờ.`);
      const lockedBox = $('lockedMachineBox');
      if (lockedBox) lockedBox.style.display = 'none';
      await doLogin();
    } else {
      alert(`Reset thất bại: ${res.error || 'Không xác định'}`);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔑 Quản trị viên: Mở khóa &amp; Reset mã máy trên Google Sheets</span>';
  }
});

$('passwordInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doLogin();
  }
});

$('usernameInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('passwordInput')?.focus();
  }
});

// ── 7. Cấu hình máy chủ Google Sheets (Dành cho Admin) ────────────────────────
$('toggleServerConfigBtn')?.addEventListener('click', async () => {
  const box = $('serverConfigBox');
  if (!box) return;
  const isHidden = box.style.display === 'none' || !box.style.display;
  box.style.display = isHidden ? 'block' : 'none';

  if (isHidden) {
    const currentUrl = await getGoogleScriptUrl();
    const urlInput = $('scriptUrlInput');
    if (urlInput) urlInput.value = currentUrl;
  }
});

$('saveScriptUrlBtn')?.addEventListener('click', async () => {
  const urlInput = $('scriptUrlInput');
  const msgEl = $('serverConfigMsg');
  const rawUrl = urlInput?.value?.trim() || '';

  if (!rawUrl) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '⚠️ Vui lòng nhập URL Google Apps Script Web App (có đuôi /exec).';
    }
    return;
  }

  await setGoogleScriptUrl(rawUrl);
  if (msgEl) {
    msgEl.style.display = 'block';
    msgEl.style.color = '#15803d';
    msgEl.textContent = '✅ Đã lưu URL thành công!';
    setTimeout(() => { msgEl.style.display = 'none'; }, 2500);
  }
});

$('testScriptUrlBtn')?.addEventListener('click', async () => {
  const urlInput = $('scriptUrlInput');
  const msgEl = $('serverConfigMsg');
  const rawUrl = urlInput?.value?.trim();

  if (!rawUrl) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '⚠️ Hãy nhập URL trước khi kiểm tra.';
    }
    return;
  }

  if (msgEl) {
    msgEl.style.display = 'block';
    msgEl.style.color = '#2563eb';
    msgEl.textContent = '⏳ Đang gửi tín hiệu kiểm tra (Ping)…';
  }

  try {
    const testUrl = new URL(rawUrl);
    testUrl.searchParams.set('action', 'ping');

    const res = await fetch(testUrl.toString(), { method: 'GET', redirect: 'follow' });
    const data = await res.json();

    if (data && data.ok) {
      if (msgEl) {
        msgEl.style.color = '#15803d';
        msgEl.textContent = '✅ Kết nối thành công! ' + (data.message || 'Google Sheets sẵn sàng hoạt động.');
      }
      await setGoogleScriptUrl(rawUrl);
    } else {
      if (msgEl) {
        msgEl.style.color = '#dc2626';
        msgEl.textContent = '⚠️ Google Sheets phản hồi nhưng có lỗi: ' + (data?.error || 'Không xác định');
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '❌ Không thể kết nối tới URL này. Hãy đảm bảo bạn đã chọn quyền truy cập là "Bất kỳ ai (Anyone)". Lỗi: ' + err.message;
    }
  }
});
