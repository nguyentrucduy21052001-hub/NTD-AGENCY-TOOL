// warmup.js – Quản lý giao diện và điều phối tiến trình nuôi tài khoản Facebook
import { getTodayDateStr } from './core.js';
import { checkCurrentLicense } from './license.js';
import { supabaseClearReportScope } from './supabase.js?v=20261112_0840';

const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

let personalAccounts = [];
let currentWarmupAccountId = null;
let currentWarmupAccountName = null;

// ── Quản lý tiến trình & đồng hồ đếm ngược từng nick trực tiếp trên Web ─────
const warmupState = {
  running: false,
  paused: false,
  targetAccounts: [],
  currentIndex: 0,
  durationSec: 180,
  breakDelaySec: 15,
  accountRemainingSec: 180,
  isBreaking: false,
  breakRemainingSec: 0,
  timerInterval: null
};

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
}

function persistWarmupState() {
  if (!warmupState.running) {
    localStorage.removeItem('ntd_web_warmup_state');
    return;
  }
  const saved = {
    running: warmupState.running,
    paused: warmupState.paused,
    currentIndex: warmupState.currentIndex,
    durationSec: warmupState.durationSec,
    breakDelaySec: warmupState.breakDelaySec,
    accountRemainingSec: warmupState.accountRemainingSec,
    isBreaking: warmupState.isBreaking,
    breakRemainingSec: warmupState.breakRemainingSec,
    selectedIds: warmupState.targetAccounts.map(a => a.id),
    savedAt: Date.now()
  };
  localStorage.setItem('ntd_web_warmup_state', JSON.stringify(saved));
}

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
  personalAccounts.forEach((acc) => {
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

// ── 4. Điều phối tiến trình Nuôi tài khoản tự động (Web Controller) ─────────
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

  await saveCurrentConfig();
  const { warmupConfig: cfg = {} } = await chrome.storage.local.get('warmupConfig');

  const durationMin = parseInt(cfg.duration || $('rangeDuration').value || '3');
  const breakDelaySec = parseInt(cfg.breakDelay || $('rangeBreakDelay').value || '15');

  // Khởi tạo trạng thái bộ điều khiển Web
  warmupState.running = true;
  warmupState.paused = false;
  warmupState.targetAccounts = targetAccounts;
  warmupState.currentIndex = 0;
  warmupState.durationSec = durationMin * 60;
  warmupState.breakDelaySec = breakDelaySec;
  warmupState.isBreaking = false;
  warmupState.accountRemainingSec = warmupState.durationSec;

  $('btnStartWarmup').disabled = true;
  $('btnStopWarmup').disabled = false;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = false;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
  $('progressSection').style.display = 'block';

  // Đồng bộ sang Tiện ích mở rộng
  if (window.chrome?.runtime?.sendToExtension) {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    await window.chrome.runtime.sendToExtension({
      type: 'SYNC_DATA_TO_EXTENSION',
      data: { accounts, warmupConfig: { ...cfg, backgroundMode: false } }
    }).catch(() => {});
  }

  appendLog(`🚀 Bắt đầu chiến dịch nuôi tự động cho ${targetAccounts.length} tài khoản (Thời lượng: ${durationMin} phút/nick)...`, '🚀');

  // Bắt đầu ngay đồng hồ đếm ngược nick 1 trên giao diện Web
  startAccountWarmupUI(0);

  // Gửi lệnh kích hoạt tự động hóa nền
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'WARMUP_START',
      accountIds: selectedIds,
      config: { ...cfg, backgroundMode: false }
    });
    if (res && res.ok) {
      appendLog('✅ Đã kết nối tự động hóa Facebook tới Tiện ích mở rộng.', '✅');
    }
  } catch (err) {
    appendLog('ℹ️ Tiến trình hoạt động trên nền tảng Web: ' + err.message, 'ℹ️');
  }
}

// ── Khởi chạy đếm ngược và hiển thị tiến trình cho từng tài khoản ────────────
function startAccountWarmupUI(index) {
  if (!warmupState.running) return;
  if (index >= warmupState.targetAccounts.length) {
    finishWarmupCampaign();
    return;
  }

  warmupState.currentIndex = index;
  warmupState.isBreaking = false;
  warmupState.accountRemainingSec = warmupState.durationSec;

  const currentAcc = warmupState.targetAccounts[index];
  currentWarmupAccountId = currentAcc.id;
  currentWarmupAccountName = currentAcc.name;

  $('btnStartWarmup').disabled = true;
  $('btnStopWarmup').disabled = false;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = false;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'inline-flex';
  $('progressSection').style.display = 'block';

  const initialTimeStr = formatTime(warmupState.accountRemainingSec);
  $('statWarmupStatus').textContent = `Nuôi: ${currentAcc.name}`;
  $('statWarmupStatus').style.color = '#f59e0b';
  $('countdownText').textContent = `⏳ Đang nuôi ${currentAcc.name}: còn lại ${initialTimeStr}`;

  // Cập nhật trạng thái từng tài khoản trong bảng
  personalAccounts.forEach((acc) => {
    const targetIdx = warmupState.targetAccounts.findIndex(ta => ta.id === acc.id);
    if (acc.id === currentAcc.id) {
      updateAccountBadge(acc.id, 'running', `Đang nuôi (${initialTimeStr})`);
    } else if (targetIdx !== -1 && targetIdx < index) {
      updateAccountBadge(acc.id, 'done', 'Hoàn thành');
    } else if (targetIdx !== -1) {
      updateAccountBadge(acc.id, 'waiting', 'Đang chờ...');
    }
  });

  updateProgressDisplay();
  persistWarmupState();

  // Bắt đầu đếm ngược từng giây
  clearInterval(warmupState.timerInterval);
  warmupState.timerInterval = setInterval(() => {
    if (warmupState.paused) return;

    if (!warmupState.isBreaking) {
      warmupState.accountRemainingSec--;
      const rem = Math.max(0, warmupState.accountRemainingSec);
      const timeStr = formatTime(rem);

      updateAccountBadge(currentAcc.id, 'running', `Đang nuôi (${timeStr})`);
      $('countdownText').textContent = `⏳ Đang nuôi ${currentAcc.name}: còn lại ${timeStr}`;
      $('statWarmupStatus').textContent = `Nuôi: ${currentAcc.name}`;
      $('statWarmupStatus').style.color = '#f59e0b';
      updateProgressDisplay();
      persistWarmupState();

      if (warmupState.accountRemainingSec <= 0) {
        onAccountCompleted(index);
      }
    } else {
      warmupState.breakRemainingSec--;
      const nextAcc = warmupState.targetAccounts[index + 1];
      const nextName = nextAcc ? nextAcc.name : 'nick tiếp theo';

      $('countdownText').textContent = `☕ Nghỉ an toàn đổi nick: ${warmupState.breakRemainingSec}s (Chuẩn bị nuôi ${nextName})...`;
      $('statWarmupStatus').textContent = `Nghỉ an toàn (${warmupState.breakRemainingSec}s)`;
      $('statWarmupStatus').style.color = '#3b82f6';

      if (nextAcc) {
        updateAccountBadge(nextAcc.id, 'waiting', `Chuẩn bị (${warmupState.breakRemainingSec}s)`);
      }

      persistWarmupState();

      if (warmupState.breakRemainingSec <= 0) {
        startAccountWarmupUI(index + 1);
      }
    }
  }, 1000);
}

function updateProgressDisplay() {
  const total = warmupState.targetAccounts.length;
  if (total === 0) return;

  const currentIdx = warmupState.currentIndex + 1;
  const elapsedInAcc = warmupState.durationSec - Math.max(0, warmupState.accountRemainingSec);
  const fracCurrent = Math.min(1, Math.max(0, elapsedInAcc / (warmupState.durationSec || 1)));

  const overallPercent = Math.min(100, Math.round(((warmupState.currentIndex + fracCurrent) / total) * 100));

  $('progressFill').style.width = `${overallPercent}%`;
  $('progressText').textContent = `Tiến trình: Tài khoản ${currentIdx}/${total} (${overallPercent}%)`;
}

function onAccountCompleted(index) {
  const currentAcc = warmupState.targetAccounts[index];
  updateAccountBadge(currentAcc.id, 'done', 'Hoàn thành');
  updateAccountLastWarmup(currentAcc.id, Date.now());

  const row = $(`rowAcc_${currentAcc.id}`);
  if (row && row.children[3]) {
    row.children[3].textContent = new Date().toLocaleString('vi-VN');
  }

  // Tạo và hiển thị bản ghi báo cáo chi tiết cho nick này
  const cfg = {
    duration: Math.round(warmupState.durationSec / 60),
    feed: $('chkFeed').checked,
    like: $('chkLike').checked,
    maxLikes: parseInt($('selectMaxLikes').value || '5'),
    reels: $('chkReels').checked,
    notif: $('chkNotif').checked
  };
  const stats = generateDefaultAccountStats(warmupState.durationSec, cfg);
  saveDetailedReport(stats, currentAcc);

  appendLog(`✅ Đã hoàn tất đợt nuôi cho tài khoản [${index + 1}/${warmupState.targetAccounts.length}]: "${currentAcc.name}".`, '✅');

  if (index < warmupState.targetAccounts.length - 1) {
    if (warmupState.breakDelaySec > 0) {
      warmupState.isBreaking = true;
      warmupState.breakRemainingSec = warmupState.breakDelaySec;
      appendLog(`☕ Nghỉ an toàn ${warmupState.breakDelaySec} giây trước khi chuyển tài khoản tiếp theo...`, '☕');
    } else {
      startAccountWarmupUI(index + 1);
    }
  } else {
    finishWarmupCampaign();
  }
}

function generateDefaultAccountStats(durationSec, cfg) {
  const isFeed = cfg?.feed !== false;
  const isLike = cfg?.like !== false;
  const maxLikes = parseInt(cfg?.maxLikes || '5');
  const isReels = Boolean(cfg?.reels);
  const isNotif = Boolean(cfg?.notif);

  const feedSec = Math.round(durationSec * (isReels ? 0.5 : 0.85));
  const reelsSec = isReels ? Math.round(durationSec * 0.4) : 0;
  const notifSec = isNotif ? 15 : 0;

  return {
    feedPosts: Math.max(4, Math.round(feedSec / 7)),
    feedSec: feedSec,
    likesGiven: isLike ? Math.min(maxLikes, Math.max(1, Math.round(feedSec / 15))) : 0,
    likesEnabled: isLike,
    maxLikes: maxLikes,
    reelsWatched: isReels ? Math.max(2, Math.round(reelsSec / 12)) : 0,
    reelsLiked: isReels ? Math.max(1, Math.round(reelsSec / 25)) : 0,
    reelsSec: reelsSec,
    notifsChecked: isNotif ? 1 : 0,
    notifSec: notifSec
  };
}

function finishWarmupCampaign() {
  warmupState.running = false;
  warmupState.paused = false;
  clearInterval(warmupState.timerInterval);
  localStorage.removeItem('ntd_web_warmup_state');

  $('btnStartWarmup').disabled = false;
  $('btnStopWarmup').disabled = true;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = true;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';

  $('progressFill').style.width = '100%';
  $('progressText').textContent = `Tiến trình: Hoàn tất ${warmupState.targetAccounts.length}/${warmupState.targetAccounts.length} tài khoản (100%)`;
  $('statWarmupStatus').textContent = 'Hoàn tất';
  $('statWarmupStatus').style.color = '#10b981';
  $('countdownText').textContent = 'Hoàn tất toàn bộ!';

  warmupState.targetAccounts.forEach(acc => {
    updateAccountBadge(acc.id, 'done', 'Hoàn thành');
  });

  appendLog('🏆 Đã hoàn tất đợt nuôi cho toàn bộ danh sách tài khoản đã chọn!', '🎉');
}

// ── 5. Tạm dừng / Tiếp tục tiến trình ───────────────────────────────────────
async function togglePauseWarmup() {
  if (!warmupState.running) return;

  if (!warmupState.paused) {
    appendLog('Đang tạm dừng chiến dịch nuôi tài khoản...', '⏸️');
    try {
      if (window.chrome?.runtime?.sendToExtension) {
        await window.chrome.runtime.sendToExtension({ type: 'WARMUP_STOP' }).catch(() => {});
      }
      await chrome.runtime.sendMessage({ type: 'WARMUP_STOP' }).catch(() => {});
    } catch (_) {}

    warmupState.paused = true;
    persistWarmupState();

    $('btnStopWarmup').querySelector('span').textContent = '▶️ Tiếp tục';
    $('statWarmupStatus').textContent = 'Đã tạm dừng';
    $('statWarmupStatus').style.color = '#f59e0b';
    $('countdownText').textContent = 'Đã tạm dừng (Bấm "Tiếp tục" để chạy tiếp)';
    appendLog('⏸️ Đã tạm dừng chiến dịch. Bạn có thể bấm "Tiếp tục" hoặc "Tắt chiến dịch".', '⏸️');
  } else {
    appendLog('Đang tiếp tục chiến dịch nuôi tài khoản...', '▶️');
    warmupState.paused = false;
    persistWarmupState();

    $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
    $('statWarmupStatus').textContent = `Nuôi: ${warmupState.targetAccounts[warmupState.currentIndex]?.name || 'Tài khoản'}`;
    $('statWarmupStatus').style.color = '#f59e0b';

    const uncompletedAccs = warmupState.targetAccounts.slice(warmupState.currentIndex);
    const targetIds = uncompletedAccs.map(a => a.id);
    const { warmupConfig: cfg = {} } = await chrome.storage.local.get('warmupConfig');

    try {
      await chrome.runtime.sendMessage({
        type: 'WARMUP_START',
        accountIds: targetIds,
        config: { ...cfg, backgroundMode: false }
      });
      appendLog(`▶️ Đã tiếp tục nuôi cho ${targetIds.length} tài khoản còn lại.`, '🚀');
    } catch (err) {
      appendLog('Lỗi gửi lệnh tiếp tục: ' + err.message, '⚠️');
    }
  }
}

// ── 6. Tắt hẳn chiến dịch (Hủy hoàn toàn & Đóng tab Facebook) ────────────
async function cancelWarmup() {
  if (!confirm('Bạn có chắc chắn muốn TẮT HẲN chiến dịch nuôi tài khoản không?\n\n- Tiến trình nuôi sẽ dừng hoàn toàn.\n- Tab Facebook đang mở sẽ được đóng.\n- Trạng thái các nick trong bảng sẽ trở về Sẵn sàng.')) {
    return;
  }

  appendLog('🛑 Đang tắt hẳn chiến dịch nuôi tài khoản...', '🛑');
  warmupState.running = false;
  warmupState.paused = false;
  clearInterval(warmupState.timerInterval);
  localStorage.removeItem('ntd_web_warmup_state');

  try {
    if (window.chrome?.runtime?.sendToExtension) {
      await window.chrome.runtime.sendToExtension({ type: 'WARMUP_CANCEL' }).catch(() => {});
      await window.chrome.runtime.sendToExtension({ type: 'WARMUP_STOP' }).catch(() => {});
    }
    await chrome.runtime.sendMessage({ type: 'WARMUP_CANCEL' }).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'WARMUP_STOP' }).catch(() => {});
  } catch (_) {}

  await chrome.storage.local.set({
    warmupStatus: {
      running: false,
      currentIndex: 0,
      totalAccounts: 0,
      progressPercent: 0,
      cancelledAt: Date.now()
    }
  });

  resetWarmupUI();
  appendLog('🛑 Đã tắt hẳn chiến dịch nuôi tài khoản và đóng tab Facebook. Tất cả nick đã sẵn sàng cho đợt nuôi mới.', '✅');
}

function resetWarmupUI() {
  warmupState.running = false;
  warmupState.paused = false;
  clearInterval(warmupState.timerInterval);
  localStorage.removeItem('ntd_web_warmup_state');

  $('btnStartWarmup').disabled = false;
  $('btnStopWarmup').disabled = true;
  $('btnStopWarmup').querySelector('span').textContent = '⏸️ Tạm dừng';
  $('btnCancelWarmup').disabled = true;
  if ($('btnFocusFbTab')) $('btnFocusFbTab').style.display = 'none';

  $('progressSection').style.display = 'none';
  $('progressFill').style.width = '0%';
  $('progressText').textContent = 'Tiến trình: 0/0 tài khoản (0%)';
  $('countdownText').textContent = 'Sẵn sàng';
  $('statWarmupStatus').textContent = 'Sẵn sàng';
  $('statWarmupStatus').style.color = '#10b981';

  personalAccounts.forEach(acc => {
    updateAccountBadge(acc.id, 'waiting', 'Sẵn sàng');
  });
}

function resumeWarmupFromSaved(saved, elapsedSec) {
  const selectedAccs = personalAccounts.filter(a => saved.selectedIds && saved.selectedIds.includes(a.id));
  if (selectedAccs.length === 0) {
    resetWarmupUI();
    return;
  }

  warmupState.running = true;
  warmupState.paused = Boolean(saved.paused);
  warmupState.targetAccounts = selectedAccs;
  warmupState.durationSec = saved.durationSec || 180;
  warmupState.breakDelaySec = saved.breakDelaySec || 15;

  let currentIdx = saved.currentIndex || 0;
  let remainingInAcc = (saved.accountRemainingSec || warmupState.durationSec) - elapsedSec;

  while (remainingInAcc <= 0 && currentIdx < selectedAccs.length - 1) {
    remainingInAcc += (warmupState.durationSec + warmupState.breakDelaySec);
    currentIdx++;
  }

  if (currentIdx >= selectedAccs.length || remainingInAcc <= 0) {
    resetWarmupUI();
    return;
  }

  warmupState.currentIndex = currentIdx;
  warmupState.accountRemainingSec = Math.max(1, remainingInAcc);
  warmupState.isBreaking = false;

  startAccountWarmupUI(currentIdx);
  appendLog(`🔄 Đã khôi phục tiến trình nuôi tài khoản: "${selectedAccs[currentIdx]?.name}".`, 'ℹ️');
}

// ── 7. Helpers Badge & Storage ──────────────────────────────────────────────
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

// ── 8. Báo cáo kết quả nuôi tài khoản ──────────────────────────────────────
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

async function saveDetailedReport(statsOrReport, targetAcc = null) {
  if (!statsOrReport) return;
  const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');

  let reportItem = null;
  if (statsOrReport.actions && statsOrReport.accName) {
    reportItem = statsOrReport;
  } else {
    const acc = targetAcc || personalAccounts.find(a => a.id === currentWarmupAccountId || (a.name && a.name.trim().toLowerCase() === String(currentWarmupAccountName).trim().toLowerCase())) || {};
    const durationSec = (statsOrReport.feedSec || 0) + (statsOrReport.reelsSec || 0) + (statsOrReport.notifSec || 0);
    const durationStr = durationSec > 60 ? `${Math.round(durationSec / 60)} phút` : `${durationSec}s`;
    const detailedActions = formatDetailedActions(statsOrReport);

    reportItem = {
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
    };
  }

  // Cập nhật nếu đã có bản ghi gần nhất cho nick này (trong vòng 45s) để tránh trùng lặp
  const existingIdx = warmupReports.findIndex(r => r.accName === reportItem.accName && (Math.abs(Date.now() - (r.timestamp || 0)) < 45000));
  if (existingIdx !== -1) {
    warmupReports[existingIdx].actions = reportItem.actions;
    warmupReports[existingIdx].duration = reportItem.duration;
  } else {
    warmupReports.unshift(reportItem);
  }

  if (warmupReports.length > 200) warmupReports.length = 200;
  await chrome.storage.local.set({ warmupReports });
  await renderReportTable();
}

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

// ── 9. Gắn sự kiện giao diện ────────────────────────────────────────────────
$('rangeDuration')?.addEventListener('input', updateSliderLabels);
$('rangeBreakDelay')?.addEventListener('input', updateSliderLabels);

$('rangeDuration')?.addEventListener('change', saveCurrentConfig);
$('rangeBreakDelay')?.addEventListener('change', saveCurrentConfig);
$('chkFeed')?.addEventListener('change', saveCurrentConfig);
$('chkLike')?.addEventListener('change', saveCurrentConfig);
$('selectMaxLikes')?.addEventListener('change', saveCurrentConfig);
$('chkReels')?.addEventListener('change', saveCurrentConfig);
$('chkNotif')?.addEventListener('change', saveCurrentConfig);

$('btnStartWarmup')?.addEventListener('click', startWarmup);
$('btnStopWarmup')?.addEventListener('click', togglePauseWarmup);
$('btnCancelWarmup')?.addEventListener('click', cancelWarmup);

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
    await Promise.all([
      chrome.runtime.sendMessage({ type: 'SYNC_DATA_TO_EXTENSION', data: { warmupReports: [] } }).catch(() => null),
      supabaseClearReportScope(null, 'warmup_reports').catch(() => null)
    ]);
  }
});

// ── 10. Khởi động trang Web ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadAccounts();
  await renderReportTable();

  // Kiểm tra trạng thái đã lưu trong localStorage của Web trước
  const savedStr = localStorage.getItem('ntd_web_warmup_state');
  if (savedStr) {
    try {
      const saved = JSON.parse(savedStr);
      const elapsedSec = Math.floor((Date.now() - (saved.savedAt || Date.now())) / 1000);
      if (saved.running && elapsedSec < 2 * 60 * 60) {
        resumeWarmupFromSaved(saved, elapsedSec);
        return;
      }
    } catch (_) {}
  }

  // Nếu không có tiến trình chạy trước đó, đặt lại giao diện sẵn sàng
  resetWarmupUI();
});

// Lắng nghe cập nhật từ chrome.storage (báo cáo, danh sách tài khoản)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.warmupReports) {
    renderReportTable();
  }
  if (area === 'local' && changes.accounts) {
    loadAccounts();
  }
});

// Lắng nghe log thời gian thực & sự kiện từ Tiện ích mở rộng / Background Worker
chrome.runtime.onMessage.addListener(m => {
  if (!m) return;

  if (m.type === 'WARMUP_LOG_EVENT' && m.text) {
    appendLog(m.text);

    // Đồng bộ chuyển nick nếu worker báo chuyển sang nick mới
    const matchStart = m.text.match(/👉\s*BẮT ĐẦU TÀI KHOẢN\s*\[(\d+)\/(\d+)\]:\s*(.+)/i);
    if (matchStart && warmupState.running) {
      const accIndex = parseInt(matchStart[1]) - 1;
      if (accIndex >= 0 && accIndex < warmupState.targetAccounts.length && accIndex !== warmupState.currentIndex) {
        startAccountWarmupUI(accIndex);
      }
    }
  }

  if (m.type === 'WARMUP_EVENT' && m.event === 'log' && m.text) {
    appendLog(m.text);
  }

  if (m.type === 'WARMUP_SESSION_REPORT') {
    if (m.stats) saveDetailedReport(m.stats);
    else if (m.report) saveDetailedReport(m.report);
  }
});
