// warmup.js – Quản lý giao diện và điều phối tiến trình nuôi tài khoản Facebook
import { getTodayDateStr } from './core.js';
import { checkCurrentLicense } from './license.js';

const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

let personalAccounts = [];
let isRunning = false;
let isPaused = false;
let isStopRequested = false;
let currentTabId = null;
let countdownInterval = null;
let currentWarmupAccountId = null;
let currentWarmupAccountName = null;

// ── 1. Thêm dòng nhật ký vào khung Console Log ──────────────────────────────
function appendLog(text, icon = 'ℹ️') {
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
  isPaused = false;
  isStopRequested = false;
  $('btnStartWarmup').disabled = true;
  $('btnStopWarmup').disabled = false;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = false;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
  $('progressSection').style.display = 'block';
  $('statWarmupStatus').textContent = 'Đang khởi động...';
  $('statWarmupStatus').style.color = '#f59e0b';

  await saveCurrentConfig();
  const { warmupConfig: cfg = {} } = await chrome.storage.local.get('warmupConfig');

  selectedIds.forEach((id, idx) => {
    updateAccountBadge(id, idx === 0 ? 'running' : 'waiting', idx === 0 ? 'Đang nạp...' : 'Đang chờ...');
  });

  appendLog(`🚀 Bắt đầu chiến dịch nuôi tự động cho ${targetAccounts.length} tài khoản...`, '🚀');

  // Luôn đồng bộ danh sách tài khoản và cấu hình sang Tiện ích mở rộng trước
  if (window.chrome?.runtime?.sendToExtension) {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    await window.chrome.runtime.sendToExtension({
      type: 'SYNC_DATA_TO_EXTENSION',
      data: { accounts, warmupConfig: { ...cfg, backgroundMode: false } }
    }).catch(() => {});
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'WARMUP_START',
      accountIds: selectedIds,
      config: { ...cfg, backgroundMode: false }
    });
    if (res && res.ok) {
      appendLog('✅ Đã kết nối tiến trình nuôi tự động tới Tiện ích mở rộng Chrome.', '✅');
    }
  } catch (err) {
    appendLog('❌ Lỗi gửi lệnh nuôi ngầm: ' + err.message, '❌');
    isRunning = false;
    $('btnStartWarmup').disabled = false;
    $('btnStopWarmup').disabled = true;
    $('btnCancelWarmup').disabled = true;
  }
}

// ── 6. Tạm dừng / Tiếp tục tiến trình ───────────────────────────────────────
async function togglePauseWarmup() {
  if (!isRunning && !isPaused) return;

  if (!isPaused) {
    appendLog('Đang tạm dừng chiến dịch nuôi tài khoản...', '⏸️');
    try {
      if (window.chrome?.runtime?.sendToExtension) {
        await window.chrome.runtime.sendToExtension({ type: 'WARMUP_STOP' }).catch(() => {});
      }
      await chrome.runtime.sendMessage({ type: 'WARMUP_STOP' }).catch(() => {});
    } catch (_) {}

    isPaused = true;
    $('btnStopWarmup').querySelector('span').textContent = '▶️ Tiếp tục';
    $('statWarmupStatus').textContent = 'Đã tạm dừng';
    $('statWarmupStatus').style.color = '#f59e0b';
    $('countdownText').textContent = 'Đã tạm dừng (Bấm "Tiếp tục" để chạy tiếp)';
    stopLiveCountdown();
    appendLog('⏸️ Đã tạm dừng chiến dịch. Bạn có thể bấm "Tiếp tục" để chạy tiếp hoặc "Tắt chiến dịch" để dừng hoàn toàn.', '⏸️');
  } else {
    appendLog('Đang tiếp tục chiến dịch nuôi tài khoản...', '▶️');
    isPaused = false;
    $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
    $('statWarmupStatus').textContent = 'Đang nuôi...';
    $('statWarmupStatus').style.color = '#f59e0b';

    const selectedChks = [...document.querySelectorAll('.acc-chk:checked')];
    const selectedIds = selectedChks.map(c => c.getAttribute('data-id'));
    const uncompletedIds = selectedIds.filter(id => {
      const badge = $(`statusBadge_${id}`);
      return !badge || !badge.innerText.includes('Hoàn thành');
    });
    const targetIds = uncompletedIds.length > 0 ? uncompletedIds : selectedIds;
    const { warmupConfig: cfg = {} } = await chrome.storage.local.get('warmupConfig');

    try {
      await chrome.runtime.sendMessage({
        type: 'WARMUP_START',
        accountIds: targetIds,
        config: { ...cfg, backgroundMode: false }
      });
      appendLog(`▶️ Đã gửi lệnh tiếp tục nuôi cho ${targetIds.length} tài khoản còn lại.`, '🚀');
    } catch (err) {
      appendLog('❌ Lỗi tiếp tục nuôi: ' + err.message, '❌');
    }
  }
}

// ── 6.1. Tắt hẳn chiến dịch (Hủy hoàn toàn & Đóng tab Facebook) ────────────
async function cancelWarmup() {
  if (!confirm('Bạn có chắc chắn muốn TẮT HẲN chiến dịch nuôi tài khoản không?\n\n- Tiến trình nuôi sẽ dừng hoàn toàn.\n- Tab Facebook đang mở sẽ được đóng.\n- Trạng thái các nick trong bảng sẽ trở về Sẵn sàng.')) {
    return;
  }

  appendLog('🛑 Đang tắt hẳn chiến dịch nuôi tài khoản...', '🛑');
  stopLiveCountdown();

  try {
    if (window.chrome?.runtime?.sendToExtension) {
      await window.chrome.runtime.sendToExtension({ type: 'WARMUP_CANCEL' }).catch(() => {});
      await window.chrome.runtime.sendToExtension({ type: 'WARMUP_STOP' }).catch(() => {});
    }
    await chrome.runtime.sendMessage({ type: 'WARMUP_CANCEL' }).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'WARMUP_STOP' }).catch(() => {});
  } catch (_) {}

  isRunning = false;
  isPaused = false;
  isStopRequested = true;

  await chrome.storage.local.set({
    warmupStatus: {
      running: false,
      currentIndex: 0,
      totalAccounts: 0,
      progressPercent: 0,
      cancelledAt: Date.now()
    }
  });

  $('btnStartWarmup').disabled = false;
  $('btnStopWarmup').disabled = true;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = true;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';

  $('progressFill').style.width = '0%';
  $('progressText').textContent = 'Tiến trình: 0/0 tài khoản (0%)';
  $('countdownText').textContent = 'Đã tắt chiến dịch';
  $('statWarmupStatus').textContent = 'Sẵn sàng';
  $('statWarmupStatus').style.color = '#10b981';

  personalAccounts.forEach(acc => {
    updateAccountBadge(acc.id, 'waiting', 'Sẵn sàng');
  });

  appendLog('🛑 Đã tắt hẳn chiến dịch nuôi tài khoản và đóng tab Facebook. Tất cả nick đã sẵn sàng cho đợt nuôi mới.', '✅');
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
        <td style="font-size:12px;color:var(--text);line-height:1.5">
          <div class="report-actions-detail">${item.actions || 'Tương tác chung'}</div>
        </td>
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

// ── Định dạng báo cáo chi tiết các hành động đã thực hiện ──────────────────
function formatDetailedActions(stats) {
  if (!stats) return 'Tương tác chung';
  const items = [];
  if (stats.feedPosts > 0 || stats.feedSec > 0) {
    items.push(`📰 Lướt <b>${stats.feedPosts || 1} bài</b> Bảng tin (${stats.feedSec || 0}s)`);
  }
  if (stats.likesGiven > 0) {
    items.push(`❤️ Đã thả <b>${stats.likesGiven} Like/Tim</b> bài viết`);
  } else if (stats.likesEnabled) {
    items.push(`❤️ Đã kiểm tra Like bài viết`);
  }
  if (stats.reelsWatched > 0 || stats.reelsSec > 0) {
    const likeStr = stats.reelsLiked > 0 ? `, thả tim ${stats.reelsLiked}` : '';
    items.push(`🎬 Xem <b>${stats.reelsWatched} Video Reels</b> (${stats.reelsSec || 0}s${likeStr})`);
  }
  if (stats.notifsChecked > 0 || stats.notifSec > 0) {
    items.push(`🔔 Kiểm tra <b>Thông báo</b> (${stats.notifSec || 12}s)`);
  }
  if (items.length === 0) {
    return 'Tương tác mô phỏng người thật';
  }
  return items.map(t => `<div class="report-action-line">• ${t}</div>`).join('');
}

// ── Lưu bản ghi báo cáo chi tiết vào Storage và cập nhật bảng ──────────────
async function saveDetailedReport(stats) {
  if (!stats) return;
  const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');
  const acc = personalAccounts.find(a => a.id === currentWarmupAccountId || (a.name && a.name.trim().toLowerCase() === String(currentWarmupAccountName).trim().toLowerCase())) || {};
  const durationSec = (stats.feedSec || 0) + (stats.reelsSec || 0) + (stats.notifSec || 0);
  const durationStr = durationSec > 60 ? `${Math.round(durationSec / 60)} phút` : `${durationSec}s`;

  // Kiểm tra xem đã có bản ghi vừa tạo trong vòng 5 giây trước không để cập nhật thay vì tạo trùng
  const existingIdx = warmupReports.findIndex(r => r.accName === (acc.name || currentWarmupAccountName) && (Date.now() - r.timestamp < 30000));
  const detailedActions = formatDetailedActions(stats);

  if (existingIdx !== -1) {
    warmupReports[existingIdx].actions = detailedActions;
    warmupReports[existingIdx].duration = durationStr;
  } else {
    warmupReports.unshift({
      id: 'wm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      accId: acc.id || '',
      accName: acc.name || currentWarmupAccountName || 'Tài khoản',
      accUid: acc.fbId || acc.username || acc.id || '',
      actions: detailedActions,
      duration: durationStr,
      status: 'success',
      statusText: 'Thành công',
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: new Date().toLocaleDateString('vi-VN'),
      timestamp: Date.now()
    });
  }

  if (warmupReports.length > 200) warmupReports.length = 200;
  await chrome.storage.local.set({ warmupReports });
  await renderReportTable();
}

// ── Đồng bộ giao diện Bảng tài khoản theo thời gian thực ─────────────────────
function updateUIForCurrentAccount(currentIdx, total, accName) {
  isRunning = true;
  isPaused = false;
  currentWarmupAccountName = accName;

  $('btnStartWarmup').disabled = true;
  $('btnStopWarmup').disabled = false;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = false;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
  $('progressSection').style.display = 'block';

  const percent = Math.round(((currentIdx - 1) / total) * 100);
  $('progressFill').style.width = `${percent}%`;
  $('progressText').textContent = `Tiến trình: Tài khoản ${currentIdx}/${total} (${percent}%)`;
  $('statWarmupStatus').textContent = `Nuôi: ${accName}`;
  $('statWarmupStatus').style.color = '#f59e0b';

  let foundTarget = false;
  personalAccounts.forEach((acc, idx) => {
    const isTarget = acc.name && (acc.name.trim().toLowerCase() === accName.trim().toLowerCase());
    const rowIdx = idx + 1;
    if (isTarget || (!foundTarget && rowIdx === currentIdx)) {
      foundTarget = true;
      currentWarmupAccountId = acc.id;
      updateAccountBadge(acc.id, 'running', 'Đang nuôi...');
    } else if (rowIdx < currentIdx) {
      updateAccountBadge(acc.id, 'done', 'Hoàn thành');
    } else {
      updateAccountBadge(acc.id, 'waiting', 'Đang chờ...');
    }
  });
}

function markAccountDoneByName(accName) {
  const acc = personalAccounts.find(a => a.name && a.name.trim().toLowerCase() === accName.trim().toLowerCase());
  if (acc) {
    updateAccountBadge(acc.id, 'done', 'Hoàn thành');
    updateAccountLastWarmup(acc.id, Date.now());
    const row = $(`rowAcc_${acc.id}`);
    if (row && row.children[3]) {
      row.children[3].textContent = new Date().toLocaleString('vi-VN');
    }
  }
}

function startBreakCountdownUI(sec) {
  let remaining = sec;
  $('statWarmupStatus').textContent = 'Nghỉ an toàn';
  $('statWarmupStatus').style.color = '#3b82f6';
  $('countdownText').textContent = `☕ Nghỉ đổi nick: ${remaining}s`;
  stopLiveCountdown();
  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      stopLiveCountdown();
      $('countdownText').textContent = 'Đang chuyển tài khoản tiếp theo...';
    } else {
      $('countdownText').textContent = `☕ Nghỉ đổi nick: ${remaining}s`;
    }
  }, 1000);
}

function finishWarmupCampaign() {
  isRunning = false;
  isPaused = false;
  stopLiveCountdown();

  $('btnStartWarmup').disabled = false;
  $('btnStopWarmup').disabled = true;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = true;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';

  $('progressFill').style.width = '100%';
  $('statWarmupStatus').textContent = 'Hoàn tất';
  $('statWarmupStatus').style.color = '#10b981';
  $('countdownText').textContent = 'Hoàn tất toàn bộ!';

  personalAccounts.forEach(acc => {
    const badge = $(`statusBadge_${acc.id}`);
    if (badge && (badge.innerText.includes('Đang nuôi') || badge.innerText.includes('Đang chờ'))) {
      updateAccountBadge(acc.id, 'done', 'Hoàn thành');
    }
  });

  appendLog('🏆 Đã hoàn tất đợt nuôi cho toàn bộ danh sách tài khoản đã chọn!', '🎉');
}

function applyWarmupStatus(s) {
  if (!s) return;
  if (s.running) {
    isRunning = true;
    isPaused = false;
    $('btnStartWarmup').disabled = true;
    $('btnStopWarmup').disabled = false;
    $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
    $('btnCancelWarmup').disabled = false;
    if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
    $('progressSection').style.display = 'block';

    $('statWarmupStatus').textContent = s.currentAccountName ? `Nuôi: ${s.currentAccountName}` : 'Đang nuôi...';
    $('statWarmupStatus').style.color = '#f59e0b';

    if (s.progressPercent !== undefined) {
      $('progressFill').style.width = `${s.progressPercent}%`;
      $('progressText').textContent = `Tiến trình: Tài khoản ${s.currentIndex || 1}/${s.totalAccounts || 1} (${s.progressPercent}%)`;
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
    if (isRunning) {
      isRunning = false;
      isPaused = false;
      $('btnStartWarmup').disabled = false;
      $('btnStopWarmup').disabled = true;
      $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
      $('btnCancelWarmup').disabled = true;
      if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';
      $('statWarmupStatus').textContent = 'Sẵn sàng';
      $('statWarmupStatus').style.color = '#10b981';
      $('countdownText').textContent = 'Hoàn tất!';
    }
  }
}

$('btnStartWarmup')?.addEventListener('click', startWarmup);
$('btnStopWarmup')?.addEventListener('click', togglePauseWarmup);
$('btnCancelWarmup')?.addEventListener('click', cancelWarmup);

// ── 9. Khởi động trang ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadAccounts();
  await renderReportTable();

  // Kiểm tra trạng thái nuôi ngầm từ worker
  const status = await chrome.runtime.sendMessage({ type: 'WARMUP_GET_STATUS' }).catch(() => null);
  const { warmupStatus } = await chrome.storage.local.get('warmupStatus');

  const isActuallyRunning = Boolean(status?.running);
  const isStale = warmupStatus?.startedAt && (Date.now() - warmupStatus.startedAt > 60 * 60 * 1000);

  if (!isActuallyRunning || isStale) {
    if (warmupStatus?.running) {
      await chrome.storage.local.set({ warmupStatus: { running: false, currentIndex: 0, progressPercent: 0 } });
    }
    isRunning = false;
    isPaused = false;
    $('btnStartWarmup').disabled = false;
    $('btnStopWarmup').disabled = true;
    $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
    $('btnCancelWarmup').disabled = true;
    if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';
    $('statWarmupStatus').textContent = 'Sẵn sàng';
    $('statWarmupStatus').style.color = '#10b981';
    $('countdownText').textContent = 'Sẵn sàng';
  } else {
    applyWarmupStatus(warmupStatus);
    appendLog('Tiến trình nuôi tài khoản đang chạy ngầm trong hệ thống.');
  }
});

// Lắng nghe cập nhật trạng thái nuôi từ Background Worker
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.warmupStatus) {
    const s = changes.warmupStatus.newValue;
    applyWarmupStatus(s);
  }
  if (area === 'local' && changes.warmupReports) {
    renderReportTable();
  }
  if (area === 'local' && changes.accounts) {
    loadAccounts();
  }
});

// Lắng nghe log thời gian thực & trạng thái từ Background Worker & Content Script
chrome.runtime.onMessage.addListener(m => {
  if (m?.type === 'WARMUP_LOG_EVENT' && m.text) {
    appendLog(m.text);

    // 1. Nhận diện bắt đầu tài khoản
    const matchStart = m.text.match(/👉\s*BẮT ĐẦU TÀI KHOẢN\s*\[(\d+)\/(\d+)\]:\s*(.+)/i);
    if (matchStart) {
      const currentIdx = parseInt(matchStart[1]);
      const total = parseInt(matchStart[2]);
      const accName = matchStart[3].trim();
      updateUIForCurrentAccount(currentIdx, total, accName);
    }

    // 2. Nhận diện hoàn tất tài khoản
    const matchDone = m.text.match(/Đã hoàn tất nuôi cho tài khoản\s*["'«“](.+?)["'»”]/i);
    if (matchDone) {
      markAccountDoneByName(matchDone[1].trim());
    }

    // 3. Nhận diện nghỉ an toàn
    const matchBreak = m.text.match(/☕\s*Nghỉ an toàn\s*(\d+)\s*giây/i);
    if (matchBreak) {
      const sec = parseInt(matchBreak[1]);
      startBreakCountdownUI(sec);
    }

    // 4. Nhận diện kết thúc chiến dịch
    if (m.text.includes('🏆') || m.text.includes('HOÀN TẤT ĐỢT NUÔI')) {
      finishWarmupCampaign();
    }
  }

  if (m?.type === 'WARMUP_EVENT' && m.event === 'log' && m.text) {
    appendLog(m.text);
  }

  if (m?.type === 'WARMUP_STATUS_EVENT' && m.status) {
    applyWarmupStatus(m.status);
  }

  if (m?.type === 'WARMUP_SESSION_REPORT' && m.stats) {
    saveDetailedReport(m.stats);
  }
});
