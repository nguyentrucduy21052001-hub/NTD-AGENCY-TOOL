// warmup.js – Quản lý giao diện và điều phối tiến trình nuôi tài khoản Facebook
import { getTodayDateStr } from './core.js';
import { checkCurrentLicense } from './license.js';

const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

let personalAccounts = [];
let isRunning = false;
let isStopRequested = false;
let currentTabId = null;
let countdownInterval = null;

// ── 1. Thêm dòng nhật ký vào khung Console Log ──────────────────────────────
function appendLog(text) {
  const container = $('logContainer');
  if (!container) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN');

  const lineEl = document.createElement('div');
  lineEl.className = 'log-line';
  lineEl.innerHTML = `
    <span class="log-time">[${timeStr}]</span>
    <span class="log-text">${escapeHtml(text)}</span>
  `;
  container.appendChild(lineEl);
  container.scrollTop = container.scrollHeight;
}

// ── 2. Nạp cấu hình từ storage ──────────────────────────────────────────────
async function loadConfig() {
  const { warmupConfig } = await chrome.storage.local.get('warmupConfig');
  const cfg = warmupConfig || {};

  if (cfg.duration) $('rangeDuration').value = cfg.duration;
  if (cfg.breakDelay) $('rangeBreakDelay').value = cfg.breakDelay;
  if (cfg.feed !== undefined) $('chkFeed').checked = cfg.feed;
  if (cfg.like !== undefined) $('chkLike').checked = cfg.like;
  if (cfg.maxLikes) $('selectMaxLikes').value = cfg.maxLikes;
  if (cfg.reels !== undefined) $('chkReels').checked = cfg.reels;
  if (cfg.notif !== undefined) $('chkNotif').checked = cfg.notif;

  updateSliderLabels();
}

function updateSliderLabels() {
  const dVal = $('rangeDuration').value;
  $('valDuration').textContent = `${dVal} phút`;
  $('statDurationPerAcc').textContent = `${dVal} phút`;

  const bVal = $('rangeBreakDelay').value;
  $('valBreakDelay').textContent = `${bVal} giây`;
}

async function saveCurrentConfig() {
  const { warmupConfig: oldCfg = {} } = await chrome.storage.local.get('warmupConfig');
  const cfg = {
    ...oldCfg,
    duration: parseInt($('rangeDuration').value || '3'),
    breakDelay: parseInt($('rangeBreakDelay').value || '15'),
    feed: $('chkFeed').checked,
    like: $('chkLike').checked,
    maxLikes: parseInt($('selectMaxLikes').value || '5'),
    reels: $('chkReels').checked,
    notif: $('chkNotif').checked
  };
  await chrome.storage.local.set({ warmupConfig: cfg });
}

// ── 3. Nạp danh sách tài khoản cá nhân ──────────────────────────────────────
async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  const allAccs = Array.isArray(accounts) ? accounts : [];
  // Lọc chỉ lấy tài khoản cá nhân (loại trừ Fanpage)
  personalAccounts = allAccs.filter(a => a.type !== 'fanpage');

  $('statTotalAccs').textContent = personalAccounts.length;
  renderAccountTable();
  updateSelectedCount();
}

function renderAccountTable() {
  const tbody = $('accTableBody');
  if (!tbody) return;

  if (personalAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">
          Chưa có tài khoản Facebook cá nhân nào.<br>
          <a href="accounts.html" style="color:var(--accent);font-weight:700;text-decoration:underline;margin-top:6px;display:inline-block">
            Bấm vào đây để thêm tài khoản cá nhân
          </a>
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  personalAccounts.forEach((acc, idx) => {
    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();
    const uidDisplay = acc.fbId || acc.username || acc.id || 'N/A';
    const lastWarmup = acc.lastWarmupAt
      ? new Date(acc.lastWarmupAt).toLocaleString('vi-VN')
      : '<span style="color:var(--text-muted);font-style:italic">Chưa nuôi</span>';

    html += `
      <tr id="rowAcc_${acc.id}">
        <td style="text-align:center">
          <input type="checkbox" class="acc-chk" data-id="${acc.id}" checked>
        </td>
        <td>
          <div class="acc-user-cell">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <b style="color:var(--text)">${escapeHtml(acc.name || 'Tài khoản')}</b>
              <div style="font-size:11px;color:var(--text-muted)">ID: ${escapeHtml(acc.id)}</div>
            </div>
          </div>
        </td>
        <td>
          <span style="font-family:monospace;font-size:12px;color:var(--text-muted)">${escapeHtml(uidDisplay)}</span>
        </td>
        <td>${lastWarmup}</td>
        <td style="text-align:right" id="statusBadge_${acc.id}">
          <span class="badge badge-waiting">Sẵn sàng</span>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // Gắn sự kiện thay đổi checkbox
  tbody.querySelectorAll('.acc-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      updateSelectedCount();
      const allChecked = [...tbody.querySelectorAll('.acc-chk')].every(c => c.checked);
      $('chkHeaderSelectAll').checked = allChecked;
    });
  });
}

function updateSelectedCount() {
  const chks = document.querySelectorAll('.acc-chk:checked');
  const count = chks.length;
  $('statSelectedAccs').textContent = count;
  $('btnStartWarmup').querySelector('span').textContent = `▶️ Bắt đầu nuôi tự động (${count} tài khoản)`;
}

// ── 4. Lắng nghe sự kiện log từ warmup_content.js ────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WARMUP_EVENT' && msg.event === 'log') {
    appendLog(msg.text);
  }
});

// ── 5. Điều phối tiến trình Nuôi tài khoản tự động (Controller) ─────────────
async function startWarmup() {
  const selectedChks = [...document.querySelectorAll('.acc-chk:checked')];
  if (selectedChks.length === 0) {
    alert('Vui lòng chọn ít nhất 1 tài khoản để bắt đầu nuôi.');
    return;
  }

  const selectedIds = selectedChks.map(c => c.getAttribute('data-id'));
  const targetAccounts = personalAccounts.filter(a => selectedIds.includes(a.id));

  // Kiểm tra thời hạn bản quyền trước khi bắt đầu
  const licenseValid = await checkCurrentLicense();
  if (!licenseValid) {
    alert('Bản quyền chưa được kích hoạt hoặc đã hết hạn. Vui lòng kiểm tra lại trang đăng nhập.');
    window.location.href = 'activate.html';
    return;
  }

  // Khởi tạo trạng thái đang chạy
  isRunning = true;
  isStopRequested = false;
  $('btnStartWarmup').disabled = true;
  $('btnStopWarmup').disabled = false;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
  $('progressSection').style.display = 'block';
  $('statWarmupStatus').textContent = 'Đang nuôi...';
  $('statWarmupStatus').style.color = '#f59e0b';

  await saveCurrentConfig();
  const { warmupConfig: cfg = {} } = await chrome.storage.local.get('warmupConfig');

  selectedIds.forEach(id => {
    updateAccountBadge(id, 'waiting', 'Đang chờ...');
  });

  appendLog(`Đã gửi lệnh khởi động đợt nuôi cho ${targetAccounts.length} tài khoản (Chạy ngầm Service Worker)...`);

  try {
    await chrome.runtime.sendMessage({
      type: 'WARMUP_START',
      accountIds: selectedIds,
      config: cfg
    });
  } catch (err) {
    appendLog('Lỗi gửi lệnh nuôi ngầm: ' + err.message);
    isRunning = false;
    $('btnStartWarmup').disabled = false;
    $('btnStopWarmup').disabled = true;
  }
}

// ── 6. Dừng tiến trình ──────────────────────────────────────────────────────
async function stopWarmup() {
  appendLog('Đang gửi lệnh dừng khẩn cấp tới tiến trình nền...');
  try {
    await chrome.runtime.sendMessage({ type: 'WARMUP_STOP' });
  } catch (_) {}

  isRunning = false;
  $('btnStartWarmup').disabled = false;
  $('btnStopWarmup').disabled = true;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';
  $('statWarmupStatus').textContent = 'Đã dừng';
  $('statWarmupStatus').style.color = '#ef4444';
  $('countdownText').textContent = 'Đã tạm dừng';
}

// ── 7. Helpers đếm ngược & Badge ─────────────────────────────────────────────
function startLiveCountdown(totalMs) {
  stopLiveCountdown();
  const endTime = Date.now() + totalMs;

  const update = () => {
    const rem = Math.max(0, endTime - Date.now());
    const remSec = Math.floor(rem / 1000);
    const m = Math.floor(remSec / 60);
    const s = remSec % 60;
    $('countdownText').textContent = `Còn lại: ${m}m ${s.toString().padStart(2, '0')}s`;

    if (rem <= 0) {
      stopLiveCountdown();
    }
  };

  update();
  countdownInterval = setInterval(update, 1000);
}

function stopLiveCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

async function runBreakCountdown(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !isStopRequested) {
    const rem = Math.max(0, end - Date.now());
    const s = Math.ceil(rem / 1000);
    $('countdownText').textContent = `Nghỉ đổi nick: ${s}s`;
    await delay(500);
  }
}

function updateAccountBadge(accountId, type, text) {
  const badge = $(`statusBadge_${accountId}`);
  if (!badge) return;
  badge.innerHTML = `<span class="badge badge-${type}">${text}</span>`;
}

async function updateAccountLastWarmup(accountId, timestamp) {
  const { accounts } = await chrome.storage.local.get('accounts');
  if (Array.isArray(accounts)) {
    const acc = accounts.find(a => a.id === accountId);
    if (acc) {
      acc.lastWarmupAt = timestamp;
      await chrome.storage.local.set({ accounts });
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 8. Gắn sự kiện giao diện ────────────────────────────────────────────────
$('rangeDuration')?.addEventListener('input', updateSliderLabels);
$('rangeBreakDelay')?.addEventListener('input', updateSliderLabels);

$('rangeDuration')?.addEventListener('change', saveCurrentConfig);
$('rangeBreakDelay')?.addEventListener('change', saveCurrentConfig);
$('chkFeed')?.addEventListener('change', saveCurrentConfig);
$('chkLike')?.addEventListener('change', saveCurrentConfig);
$('selectMaxLikes')?.addEventListener('change', saveCurrentConfig);
$('chkReels')?.addEventListener('change', saveCurrentConfig);
$('chkNotif')?.addEventListener('change', saveCurrentConfig);

$('btnFocusFbTab')?.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'WARMUP_SHOW_TAB' });
  } catch (_) {
    alert('Không thể mở tab Facebook.');
  }
});

$('chkHeaderSelectAll')?.addEventListener('change', e => {
  const checked = e.target.checked;
  document.querySelectorAll('.acc-chk').forEach(c => c.checked = checked);
  updateSelectedCount();
});

$('btnSelectAllAccs')?.addEventListener('click', () => {
  $('chkHeaderSelectAll').checked = true;
  document.querySelectorAll('.acc-chk').forEach(c => c.checked = true);
  updateSelectedCount();
});

$('btnUnselectAllAccs')?.addEventListener('click', () => {
  $('chkHeaderSelectAll').checked = false;
  document.querySelectorAll('.acc-chk').forEach(c => c.checked = false);
  updateSelectedCount();
});

$('btnClearLogs')?.addEventListener('click', () => {
  $('logContainer').innerHTML = '';
  appendLog('Đã xóa lịch sử nhật ký.', '🧹');
});

// Toggle ẩn / bật các hành động trong phiên nuôi
$('btnToggleActions')?.addEventListener('click', () => {
  const panel = $('actionsPanel');
  const label = $('btnToggleActionsText');
  const icon = $('btnToggleActionsIcon');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (label) label.textContent = isHidden ? 'Ẩn cài đặt' : 'Bật cài đặt';
  if (icon) icon.textContent = isHidden ? '▲' : '▼';
});

// Xóa báo cáo nuôi
$('btnClearReport')?.addEventListener('click', async () => {
  if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử báo cáo nuôi tài khoản?')) {
    await chrome.storage.local.set({ warmupReports: [] });
    await renderReportTable();
  }
});

// Hàm hiển thị bảng báo cáo kết quả nuôi tài khoản
async function renderReportTable() {
  const tbody = $('warmupReportTableBody');
  if (!tbody) return;

  const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');
  if (!Array.isArray(warmupReports) || warmupReports.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có kết quả nuôi nào. Hãy chọn tài khoản và bấm <b>"Bắt đầu nuôi tự động"</b>.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  warmupReports.forEach((item, idx) => {
    const stt = idx + 1;
    const isSuccess = item.status === 'success';
    const badgeClass = isSuccess ? 'badge-done' : 'badge-danger';
    const badgeText = isSuccess ? 'Thành công' : (item.statusText || 'Thất bại');
    const timeDisplay = item.time || (item.timestamp ? new Date(item.timestamp).toLocaleTimeString('vi-VN') : '--');
    const dateDisplay = item.date || (item.timestamp ? new Date(item.timestamp).toLocaleDateString('vi-VN') : '');
    const timeFull = dateDisplay ? `${timeDisplay} ${dateDisplay}` : timeDisplay;

    html += `
      <tr>
        <td style="text-align:center;font-weight:600;color:var(--text-muted)">${stt}</td>
        <td>
          <div style="font-weight:700;color:var(--text)">${escapeHtml(item.accName || 'Tài khoản')}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:monospace">${escapeHtml(item.accUid || '')}</div>
        </td>
        <td style="font-size:12px;color:var(--text)">${escapeHtml(item.actions || 'Tương tác')}</td>
        <td style="text-align:center;font-weight:600;color:var(--text)">${escapeHtml(item.duration || '--')}</td>
        <td style="text-align:center">
          <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        </td>
        <td style="text-align:center;font-size:11.5px;color:var(--text-muted);white-space:nowrap">${escapeHtml(timeFull)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

$('btnStartWarmup')?.addEventListener('click', startWarmup);
$('btnStopWarmup')?.addEventListener('click', stopWarmup);

// ── 9. Khởi động trang ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadAccounts();
  await renderReportTable();

  // Kiểm tra trạng thái nuôi ngầm từ worker
  const status = await chrome.runtime.sendMessage({ type: 'WARMUP_GET_STATUS' }).catch(() => null);
  const { warmupStatus } = await chrome.storage.local.get('warmupStatus');
  isRunning = Boolean(status?.running || warmupStatus?.running);

  if (isRunning) {
    $('btnStartWarmup').disabled = true;
    $('btnStopWarmup').disabled = false;
    if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
    $('progressSection').style.display = 'block';
    $('statWarmupStatus').textContent = warmupStatus?.currentAccountName ? `Nuôi: ${warmupStatus.currentAccountName}` : 'Đang nuôi...';
    $('statWarmupStatus').style.color = '#f59e0b';
    if (warmupStatus?.progressPercent !== undefined) {
      $('progressFill').style.width = `${warmupStatus.progressPercent}%`;
      $('progressText').textContent = `Tiến trình: (${warmupStatus.progressPercent}%)`;
    }
    if (warmupStatus?.currentAccountId) {
      updateAccountBadge(warmupStatus.currentAccountId, 'running', 'Đang nuôi...');
    }
    if (warmupStatus?.remainingSec !== undefined) {
      const m = Math.floor(warmupStatus.remainingSec / 60);
      const sec = warmupStatus.remainingSec % 60;
      $('countdownText').textContent = warmupStatus.statusText ? `${warmupStatus.statusText} (${m}m ${sec.toString().padStart(2, '0')}s)` : `Còn lại: ${m}m ${sec.toString().padStart(2, '0')}s`;
    }
    appendLog('Tiến trình nuôi tài khoản đang chạy ngầm trong hệ thống.');
  }
});

// Lắng nghe cập nhật trạng thái nuôi từ Background Worker
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.warmupStatus) {
    const s = changes.warmupStatus.newValue;
    if (s) {
      isRunning = Boolean(s.running);
      $('btnStartWarmup').disabled = isRunning;
      $('btnStopWarmup').disabled = !isRunning;
      if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = isRunning ? 'inline-flex' : 'none';

      if (isRunning) {
        $('progressSection').style.display = 'block';
        $('statWarmupStatus').textContent = s.currentAccountName ? `Nuôi: ${s.currentAccountName}` : 'Đang nuôi...';
        $('statWarmupStatus').style.color = '#f59e0b';
        if (s.progressPercent !== undefined) {
          $('progressFill').style.width = `${s.progressPercent}%`;
          $('progressText').textContent = `Tiến trình: Tài khoản ${s.currentIndex}/${s.totalAccounts} (${s.progressPercent}%)`;
        }
        if (s.currentAccountId) {
          updateAccountBadge(s.currentAccountId, 'running', 'Đang nuôi...');
        }
        if (s.remainingSec !== undefined) {
          const m = Math.floor(s.remainingSec / 60);
          const sec = s.remainingSec % 60;
          $('countdownText').textContent = s.statusText ? `${s.statusText} (${m}m ${sec.toString().padStart(2, '0')}s)` : `Còn lại: ${m}m ${sec.toString().padStart(2, '0')}s`;
        } else if (s.statusText) {
          $('countdownText').textContent = s.statusText;
        }
      } else {
        $('statWarmupStatus').textContent = 'Sẵn sàng';
        $('statWarmupStatus').style.color = '#10b981';
        $('countdownText').textContent = 'Hoàn tất!';
      }
    }
  }
  if (area === 'local' && changes.warmupReports) {
    renderReportTable();
  }
  if (area === 'local' && changes.accounts) {
    loadAccounts();
  }
});

// Lắng nghe log thời gian thực từ tiến trình nền
chrome.runtime.onMessage.addListener(m => {
  if (m?.type === 'WARMUP_LOG_EVENT' && m.text) {
    appendLog(m.text);
  }
});
