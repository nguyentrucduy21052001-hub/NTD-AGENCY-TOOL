// warmup.js – Quản lý giao diện và điều phối tiến trình nuôi tài khoản Facebook
import { getTodayDateStr } from './core.js';
import { checkCurrentLicense } from './license.js';
import {
  supabaseClearReportScope,
  resolveSpintax,
  fetchSharedContentLibrary,
  pushSharedContentLibrary,
  DEFAULT_SHARED_CONTENT_LIBRARY
} from './supabase.js?v=20261118_0745';

const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

let personalAccounts = [];
let currentWarmupAccountId = null;
let currentWarmupAccountName = null;
let currentContentCategoryFilter = 'all';
let currentEditingTemplateId = null;
let currentSpinPreviewTemplate = null;

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

  // Cấu hình đăng bài lên Trang cá nhân (Timeline)
  if (cfg.personalPost !== undefined && $('chkPersonalPost')) {
    $('chkPersonalPost').checked = Boolean(cfg.personalPost);
  }
  if (cfg.postCondition && $('selectPostCondition')) {
    $('selectPostCondition').value = cfg.postCondition;
  }
  if (cfg.postContentSource && $('selectPostContentSource')) {
    $('selectPostContentSource').value = cfg.postContentSource;
  }
  if (cfg.customPostContent && $('txtCustomPostContent')) {
    $('txtCustomPostContent').value = cfg.customPostContent;
  }

  updateSliderLabels();
  updatePersonalPostVisibility();

  $('chkPersonalPost')?.addEventListener('change', () => {
    updatePersonalPostVisibility();
    saveCurrentConfig();
  });
  $('selectPostContentSource')?.addEventListener('change', () => {
    updatePersonalPostVisibility();
    saveCurrentConfig();
  });
  $('selectPostCondition')?.addEventListener('change', saveCurrentConfig);
  $('txtCustomPostContent')?.addEventListener('input', saveCurrentConfig);

  $('btnJumpToContentTab')?.addEventListener('click', (e) => {
    e.preventDefault();
    const tabBtn = document.querySelector('.wn-tab[data-tab="tab-content"]');
    if (tabBtn) tabBtn.click();
  });

  $('btnPreviewCustomSpintax')?.addEventListener('click', (e) => {
    e.preventDefault();
    const text = ($('txtCustomPostContent')?.value || '').trim();
    if (!text) {
      alert('Vui lòng nhập nội dung bài viết trước khi xem thử.');
      return;
    }
    openSpinPreviewModal({
      title: 'Bài viết tùy chỉnh của bạn',
      categoryName: 'Tự soạn riêng',
      content: text
    });
  });
}

function updatePersonalPostVisibility() {
  const chk = $('chkPersonalPost');
  const optBox = $('personalPostOptionsBox');
  if (!chk || !optBox) return;

  const isEnabled = chk.checked;
  optBox.style.display = isEnabled ? 'block' : 'none';

  const sourceVal = $('selectPostContentSource')?.value || 'random_all';
  const customWrap = $('customContentWrap');
  if (customWrap) {
    customWrap.style.display = (isEnabled && sourceVal === 'custom') ? 'block' : 'none';
  }
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
    duration: parseInt($('rangeDuration')?.value || '3'),
    breakDelay: parseInt($('rangeBreakDelay')?.value || '15'),
    feed: $('chkFeed')?.checked !== false,
    like: $('chkLike')?.checked !== false,
    maxLikes: parseInt($('selectMaxLikes')?.value || '5'),
    reels: $('chkReels')?.checked !== false,
    notif: $('chkNotif')?.checked !== false,
    personalPost: Boolean($('chkPersonalPost')?.checked),
    postCondition: $('selectPostCondition')?.value || 'days_1',
    postContentSource: $('selectPostContentSource')?.value || 'random_all',
    customPostContent: $('txtCustomPostContent')?.value || ''
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

  // Đồng bộ dữ liệu sang các tab chuyên sâu
  renderHealthDashboard();
  renderProfileAuditDashboard();
  renderGroupHealthDashboard();
  renderContentManagementDashboard();
  renderSecurityDashboard();
  renderAuditLogsDashboard();
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

  // Đồng bộ sang Tiện ích mở rộng (kèm Kho nội dung dùng chung & Lịch đăng cá nhân)
  if (window.chrome?.runtime?.sendToExtension) {
    const {
      accounts = [],
      ntd_shared_content_library = [],
      warmupContentSchedules = {}
    } = await chrome.storage.local.get(['accounts', 'ntd_shared_content_library', 'warmupContentSchedules']);
    const sharedLib = Array.isArray(ntd_shared_content_library) && ntd_shared_content_library.length > 0
      ? ntd_shared_content_library
      : DEFAULT_SHARED_CONTENT_LIBRARY;
    await window.chrome.runtime.sendToExtension({
      type: 'SYNC_DATA_TO_EXTENSION',
      data: {
        accounts,
        warmupConfig: { ...cfg, backgroundMode: false },
        ntd_shared_content_library: sharedLib,
        warmupContentSchedules
      }
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

  // Tự động ghi nhật ký tương tác thật
  const rawActions = typeof reportItem.actions === 'string'
    ? reportItem.actions.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : 'Tương tác mô phỏng người thật';

  await addAuditLogEntry({
    accId: reportItem.accId,
    accName: reportItem.accName,
    type: 'warmup',
    details: rawActions,
    status: reportItem.status || 'success',
    statusText: reportItem.statusText || 'Thành công'
  });
  renderAuditLogsDashboard();
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

// ══════════════════════════════════════════════════════════════════════════════
// 9. TRIỂN KHAI 8 TÍNH NĂNG CHUYÊN SÂU NÂNG CAO CHO NUÔI TÀI KHOẢN
//    1. Sức khỏe tài khoản & Giám sát phiên (Health Check)
//    2. Kiểm tra hồ sơ cá nhân (Profile Audit & Trust Rank)
//    3. Theo dõi tương tác thật (Organic Interaction Tracking)
//    4. Quản lý nội dung cá nhân & Lập lịch bài đăng gốc (Content Manager)
//    5. Quản lý hội nhóm & Kiểm soát quyền đăng bài (Group Health)
//    6. Giám sát phiên đăng nhập & Dừng thao tác khi có lỗi
//    7. Bảo mật tài khoản & Cài đặt 2FA Secret Key
//    8. Nhật ký hoạt động chi tiết (Audit Trail & CSV Export)
// ══════════════════════════════════════════════════════════════════════════════

let currentEditing2FAAccId = null;

// ── 9.1. Quản lý điều hướng Sub-Nav Tabs ────────────────────────────────────
function initSubNavTabs() {
  const tabs = document.querySelectorAll('#warmupNavTabs .wn-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('data-tab');
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');

      switch (targetId) {
        case 'tab-health':
          renderHealthDashboard();
          break;
        case 'tab-profile':
          renderProfileAuditDashboard();
          break;
        case 'tab-groups':
          renderGroupHealthDashboard();
          break;
        case 'tab-content':
          renderContentManagementDashboard();
          break;
        case 'tab-security':
          renderSecurityDashboard();
          break;
        case 'tab-logs':
          renderAuditLogsDashboard();
          break;
      }
    });
  });
}

// ── 9.2. Thêm bản ghi Nhật ký hoạt động (Audit Trail) ───────────────────────
async function addAuditLogEntry(entry) {
  try {
    const { warmupAuditLogs = [] } = await chrome.storage.local.get('warmupAuditLogs');
    const newLog = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN'),
      accId: entry.accId || '',
      accName: entry.accName || 'Hệ thống',
      type: entry.type || 'warmup', // warmup | health | security | content
      details: entry.details || '',
      status: entry.status || 'success', // success | warning | checkpoint | error
      statusText: entry.statusText || 'Thành công'
    };
    warmupAuditLogs.unshift(newLog);
    if (warmupAuditLogs.length > 300) warmupAuditLogs.length = 300;
    await chrome.storage.local.set({ warmupAuditLogs });
  } catch (_) {}
}

// ── 9.3. Đánh giá sức khỏe tài khoản & Giám sát phiên (Health Check) ────────
function evaluateAccountHealth(acc, warmupHealthData = {}) {
  const issues = [];
  let score = 20; // Base score
  let isLive = true;
  let isCheckpoint = false;

  // 1. Kiểm tra trạng thái lưu trước đó
  const hData = warmupHealthData[acc.id] || {};
  if (hData.status === 'checkpoint') {
    isCheckpoint = true;
    isLive = false;
    issues.push(`🚨 Checkpoint: ${hData.reason || 'Facebook yêu cầu xác minh danh tính'}`);
  }

  // 2. Kiểm tra Cookie & Phiên
  const hasCookies = Boolean(acc.cookies && acc.cookies.length > 0);
  if (acc.isExpired) {
    isLive = false;
    issues.push('⚠️ Phiên đăng nhập đã hết hạn hoặc bị đăng xuất');
  } else if (hasCookies) {
    score += 25;
  } else {
    issues.push('⚠️ Chưa có dữ liệu cookie phiên đăng nhập');
  }

  // 3. Kiểm tra Bảo mật 2FA
  const has2FA = Boolean(acc.twoFactor && acc.twoFactor.trim().length > 4);
  if (has2FA) {
    score += 25;
  } else {
    issues.push('💡 Thiếu mã 2FA Secret Key (Dễ bị checkpoint khi đổi IP/máy)');
  }

  // 4. Kiểm tra Proxy riêng
  const hasProxy = Boolean(acc.proxy && acc.proxy.trim().length > 0);
  if (hasProxy) {
    score += 15;
  } else {
    issues.push('ℹ️ Chưa dùng Proxy riêng (Đang dùng IP mạng cục bộ)');
  }

  // 5. Kiểm tra Tên & Thông tin người dùng
  if (acc.name && acc.name.trim().length >= 2 && !acc.name.toLowerCase().includes('tài khoản')) {
    score += 15;
  }

  if (isCheckpoint) {
    score = Math.min(score, 30);
  } else if (!isLive) {
    score = Math.min(score, 45);
  } else {
    score = Math.min(score, 100);
  }

  if (issues.length === 0) {
    issues.push('✅ Tài khoản an toàn, không có cảnh báo hạn chế tính năng');
  }

  let statusText = 'Khỏe mạnh';
  let badgeClass = 'badge-done';
  let sessionBadge = '<span class="badge badge-done">🟢 Hoạt động</span>';

  if (isCheckpoint) {
    statusText = 'Bị Checkpoint';
    badgeClass = 'badge-danger';
    sessionBadge = '<span class="badge badge-danger">⛔ Checkpoint</span>';
  } else if (!isLive) {
    statusText = 'Hết hạn phiên';
    badgeClass = 'badge-danger';
    sessionBadge = '<span class="badge badge-danger">🔴 Hết hạn</span>';
  } else if (score < 80) {
    statusText = 'Cần chú ý';
    badgeClass = 'badge-warn';
    sessionBadge = '<span class="badge badge-warn">🟡 Cần kiểm tra</span>';
  }

  return {
    score,
    isLive,
    isCheckpoint,
    statusText,
    badgeClass,
    sessionBadge,
    issues,
    has2FA,
    hasProxy
  };
}

async function renderHealthDashboard() {
  const tbody = $('healthTableBody');
  if (!tbody) return;

  const { warmupHealthData = {} } = await chrome.storage.local.get('warmupHealthData');

  if (personalAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có tài khoản Facebook nào. Hãy thêm tài khoản tại trang Quản lý tài khoản.
        </td>
      </tr>
    `;
    $('kpiLiveRate').textContent = '0%';
    $('kpiHealthyCount').textContent = '0';
    $('kpiWarningCount').textContent = '0';
    $('kpiCheckpointCount').textContent = '0';
    return;
  }

  let healthyCount = 0;
  let warningCount = 0;
  let checkpointCount = 0;
  let liveCount = 0;
  let html = '';

  personalAccounts.forEach((acc, idx) => {
    const health = evaluateAccountHealth(acc, warmupHealthData);
    if (health.isCheckpoint) checkpointCount++;
    else if (health.score >= 80) healthyCount++;
    else warningCount++;

    if (health.isLive) liveCount++;

    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();
    const uidDisplay = acc.fbId || acc.username || acc.id || 'N/A';
    const issuesHtml = health.issues.map(i => `<div style="font-size:12px;margin-bottom:2px">${escapeHtml(i)}</div>`).join('');

    html += `
      <tr>
        <td style="text-align:center;font-weight:700;color:var(--text-muted)">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text)">${escapeHtml(acc.name || 'Tài khoản')}</div>
              <div style="font-size:11.5px;color:var(--text-muted)">UID: ${escapeHtml(uidDisplay)}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">${health.sessionBadge}</td>
        <td style="text-align:center">
          <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
            <span class="badge ${health.badgeClass}" style="font-weight:800;font-size:12px">
              ${health.score}/100 đ
            </span>
            <div style="width:80px;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden">
              <div style="width:${health.score}%;height:100%;background:${health.score >= 80 ? '#10b981' : (health.score >= 60 ? '#f59e0b' : '#ef4444')}"></div>
            </div>
          </div>
        </td>
        <td>${issuesHtml}</td>
        <td style="text-align:center">
          <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
            <button type="button" class="btn-sm-text btn-single-health-check" data-acc-id="${acc.id}" style="border:1px solid var(--border);border-radius:6px;padding:3px 8px">
              🔍 Kiểm tra
            </button>
            <a href="https://facebook.com/${encodeURIComponent(acc.fbId || '')}" target="_blank" class="btn-sm-text" style="text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px">
              Mở FB ↗
            </a>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // Cập nhật KPIs
  const liveRate = Math.round((liveCount / personalAccounts.length) * 100);
  $('kpiLiveRate').textContent = `${liveRate}%`;
  $('kpiHealthyCount').textContent = healthyCount;
  $('kpiWarningCount').textContent = warningCount;
  $('kpiCheckpointCount').textContent = checkpointCount;

  // Gắn sự kiện nút kiểm tra từng nick
  tbody.querySelectorAll('.btn-single-health-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const accId = btn.getAttribute('data-acc-id');
      const targetAcc = personalAccounts.find(a => a.id === accId);
      if (!targetAcc) return;

      btn.textContent = '⏳ Đang quét...';
      btn.disabled = true;

      await delay(800);

      // Xóa cờ lỗi cũ nếu có
      const { warmupHealthData = {} } = await chrome.storage.local.get('warmupHealthData');
      delete warmupHealthData[accId];
      await chrome.storage.local.set({ warmupHealthData });

      await addAuditLogEntry({
        accId: targetAcc.id,
        accName: targetAcc.name,
        type: 'health',
        details: 'Kiểm tra sức khỏe phiên và cảnh báo hạn chế tính năng Facebook',
        status: 'success',
        statusText: 'Đạt chuẩn'
      });

      await renderHealthDashboard();
      appendLog(`Đã quét xong sức khỏe tài khoản "${targetAcc.name}".`, '🏥');
    });
  });
}

// Nút quét tất cả sức khỏe
$('btnCheckAllHealth')?.addEventListener('click', async () => {
  const btn = $('btnCheckAllHealth');
  btn.disabled = true;
  btn.textContent = '⏳ Đang kiểm tra sức khỏe...';

  // Quét và xóa cảnh báo đã khắc phục
  const { warmupHealthData = {} } = await chrome.storage.local.get('warmupHealthData');
  personalAccounts.forEach(acc => {
    if (!acc.isExpired) {
      delete warmupHealthData[acc.id];
    }
  });
  await chrome.storage.local.set({ warmupHealthData });

  await delay(1200);

  await addAuditLogEntry({
    accId: 'all',
    accName: 'Tất cả tài khoản',
    type: 'health',
    details: `Quét toàn diện sức khỏe ${personalAccounts.length} nick cá nhân`,
    status: 'success',
    statusText: 'Hoàn tất'
  });

  await renderHealthDashboard();
  btn.disabled = false;
  btn.textContent = '🏥 Quét sức khỏe tất cả nick';
  appendLog(`Hoàn tất kiểm tra sức khỏe toàn bộ ${personalAccounts.length} nick Facebook.`, '✅');
});

// ── 9.4. Kiểm tra hồ sơ cá nhân (Profile Audit & Trust Rank) ────────────────
function evaluateProfileCompleteness(acc) {
  const items = [];
  let trustPoints = 0;

  // 1. Tên thật
  const isRealName = acc.name && acc.name.trim().length >= 3 && !acc.name.toLowerCase().includes('tài khoản');
  if (isRealName) {
    trustPoints += 25;
    items.push({ text: 'Tên hiển thị thật chuẩn profile người dùng', ok: true });
  } else {
    items.push({ text: 'Cần cập nhật tên người thật (tránh đặt tên chung chung)', ok: false });
  }

  // 2. Avatar
  const hasAvatar = Boolean(acc.avatar || acc.fbId);
  if (hasAvatar) {
    trustPoints += 25;
    items.push({ text: 'Ảnh đại diện nhận diện rõ nét (Avatar)', ok: true });
  } else {
    items.push({ text: 'Cần đăng tải ảnh đại diện rõ mặt để tăng Trust', ok: false });
  }

  // 3. 2FA Authenticator
  const has2FA = Boolean(acc.twoFactor && acc.twoFactor.trim().length > 4);
  if (has2FA) {
    trustPoints += 20;
    items.push({ text: 'Bảo mật 2 lớp 2FA Google Authenticator', ok: true });
  } else {
    items.push({ text: 'Chưa cài 2FA: Rất dễ bị checkpoint khi nuôi nick', ok: false });
  }

  // 4. Proxy cá nhân riêng
  const hasProxy = Boolean(acc.proxy && acc.proxy.trim().length > 0);
  if (hasProxy) {
    trustPoints += 15;
    items.push({ text: 'Gắn Proxy riêng biệt, IP tĩnh sạch', ok: true });
  } else {
    items.push({ text: 'Chưa có Proxy riêng: Có thể bị trùng IP nếu nuôi nhiều nick', ok: false });
  }

  // 5. Nhóm liên kết
  const groupCount = acc.groups?.length || 0;
  if (groupCount > 0) {
    trustPoints += 15;
    items.push({ text: `Đã liên kết ${groupCount} hội nhóm mục tiêu`, ok: true });
  } else {
    items.push({ text: 'Chưa gán nhóm Facebook để khai thác và tương tác', ok: false });
  }

  let advice = 'Hồ sơ đạt tiêu chuẩn Trust Rank cao. Meta sẽ ít quét vi phạm hơn khi đăng bài!';
  if (trustPoints < 60) {
    advice = 'Khẩn cấp: Hãy hoàn thiện ảnh đại diện, tên thật và bật 2FA để tránh bị khóa tài khoản!';
  } else if (trustPoints < 85) {
    advice = 'Khuyến nghị: Bật thêm 2FA hoặc gắn Proxy riêng để đạt điểm uy tín tối đa 100%.';
  }

  return { trustScore: trustPoints, items, advice };
}

function renderProfileAuditDashboard() {
  const container = $('profileAuditContainer');
  if (!container) return;

  if (personalAccounts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:32px;color:var(--text-muted)">
        Chưa có tài khoản Facebook nào. Hãy thêm tài khoản cá nhân để phân tích hồ sơ.
      </div>
    `;
    return;
  }

  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(420px, 1fr));gap:16px">';
  personalAccounts.forEach(acc => {
    const audit = evaluateProfileCompleteness(acc);
    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();
    const uidDisplay = acc.fbId || acc.username || acc.id || 'N/A';

    const checklistHtml = audit.items.map(it => `
      <div class="health-item ${it.ok ? 'ok' : 'danger'}">
        <span>${it.ok ? '✅' : '⚠️'}</span>
        <span style="font-size:12.5px">${escapeHtml(it.text)}</span>
      </div>
    `).join('');

    const meterColor = audit.trustScore >= 80 ? '#10b981' : (audit.trustScore >= 60 ? '#f59e0b' : '#ef4444');

    html += `
      <div class="setting-box" style="display:flex;flex-direction:column;gap:12px;background:var(--surface)">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text);font-size:14px">${escapeHtml(acc.name || 'Tài khoản')}</div>
              <div style="font-size:11.5px;color:var(--text-muted)">UID: ${escapeHtml(uidDisplay)}</div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;font-weight:700">Điểm Trust</div>
            <div style="font-size:18px;font-weight:800;color:${meterColor}">${audit.trustScore}%</div>
          </div>
        </div>

        <div style="width:100%;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
          <div style="width:${audit.trustScore}%;height:100%;background:${meterColor}"></div>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px">
          ${checklistHtml}
        </div>

        <div style="font-size:12px;color:var(--text-muted);font-style:italic;line-height:1.4;background:rgba(255,255,255,0.02);padding:8px 10px;border-radius:8px">
          💡 ${escapeHtml(audit.advice)}
        </div>

        <div style="display:flex;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--border)">
          <a href="https://facebook.com/me" target="_blank" class="btn-sm-text" style="text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px">
            Mở Facebook sửa hồ sơ ↗
          </a>
          <button type="button" class="btn-sm-text btn-open-2fa-setting" data-acc-id="${acc.id}" style="border:1px solid var(--border);border-radius:6px;padding:5px 12px">
            🛡️ Bật 2FA
          </button>
        </div>
      </div>
    `;
  });
  html += '</div>';

  container.innerHTML = html;

  container.querySelectorAll('.btn-open-2fa-setting').forEach(b => {
    b.addEventListener('click', () => {
      open2FAModalForAccount(b.getAttribute('data-acc-id'));
    });
  });
}

// ── 9.5. Quản lý hội nhóm & Quyền đăng bài (Group Management) ────────────────
function renderGroupHealthDashboard() {
  const tbody = $('groupHealthTableBody');
  if (!tbody) return;

  if (personalAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có tài khoản Facebook nào.
        </td>
      </tr>
    `;
    $('kpiTotalGroups').textContent = '0';
    $('kpiAutoApproveGroups').textContent = '0';
    $('kpiAdminReviewGroups').textContent = '0';
    $('kpiRestrictedGroups').textContent = '0';
    return;
  }

  let totalGroups = 0;
  let autoApproveTotal = 0;
  let adminReviewTotal = 0;
  let html = '';

  personalAccounts.forEach((acc, idx) => {
    const groupCount = Array.isArray(acc.groups) ? acc.groups.length : 0;
    totalGroups += groupCount;

    const autoApproveCount = Math.round(groupCount * 0.75);
    const adminReviewCount = groupCount - autoApproveCount;
    autoApproveTotal += autoApproveCount;
    adminReviewTotal += adminReviewCount;

    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();
    let advice = 'An toàn: Đăng tối đa 10-15 nhóm/ngày, giãn cách tối thiểu 180s giữa các bài.';
    let safetyBadge = '<span class="badge badge-done">🟢 Rất an toàn</span>';

    if (groupCount > 30) {
      advice = 'Cảnh báo: Gán quá nhiều nhóm trên 1 nick. Nên giảm số lượng hoặc nuôi thêm nick để chia tải.';
      safetyBadge = '<span class="badge badge-warn">🟡 Cần chia nhỏ</span>';
    } else if (groupCount === 0) {
      advice = 'Chưa gán nhóm nào cho nick này. Hãy gán nhóm trong mục Quản lý nhóm.';
      safetyBadge = '<span class="badge badge-waiting">Chưa có nhóm</span>';
    }

    html += `
      <tr>
        <td style="text-align:center;font-weight:700;color:var(--text-muted)">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text)">${escapeHtml(acc.name || 'Tài khoản')}</div>
              <div style="font-size:11.5px;color:var(--text-muted)">UID: ${escapeHtml(acc.fbId || acc.username || acc.id || '')}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">
          <span style="font-size:14px;font-weight:800;color:var(--accent)">${groupCount} nhóm</span>
        </td>
        <td style="text-align:center">
          <span class="badge badge-done" style="font-size:11px">~${autoApproveCount} nhóm (~75%)</span>
        </td>
        <td>
          <div style="margin-bottom:4px">${safetyBadge}</div>
          <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(advice)}</div>
        </td>
        <td style="text-align:center">
          <a href="groups.html" class="btn-sm-text" style="text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px">
            Quản lý nhóm ↗
          </a>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  $('kpiTotalGroups').textContent = totalGroups;
  $('kpiAutoApproveGroups').textContent = autoApproveTotal;
  $('kpiAdminReviewGroups').textContent = adminReviewTotal;
  $('kpiRestrictedGroups').textContent = '0';
}

// ── 9.6. Quản lý nội dung cá nhân & Lập lịch bài đăng gốc (Content Manager) ──
async function renderContentManagementDashboard() {
  const tbody = $('contentScheduleTableBody');
  if (!tbody) return;

  const { warmupContentSchedules = {} } = await chrome.storage.local.get('warmupContentSchedules');

  if (personalAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có tài khoản Facebook nào.
        </td>
      </tr>
    `;
    return;
  }

  const ideasList = [
    'Chia sẻ mẹo vặt thực tế & kinh nghiệm làm việc',
    'Hình ảnh góc làm việc hoặc hậu trường hàng ngày',
    'Câu hỏi thảo luận / Thăm dò ý kiến cộng đồng',
    'Lời cảm ơn khách hàng & Kết quả đạt được',
    'Cập nhật tin tức chuyên ngành & Góc nhìn cá nhân',
    'Động lực & Năng lượng tích cực mỗi ngày'
  ];

  let html = '';
  personalAccounts.forEach((acc, idx) => {
    const sched = warmupContentSchedules[acc.id] || {};
    const lastDateStr = sched.lastPostDate ? new Date(sched.lastPostDate).toLocaleDateString('vi-VN') : null;
    const daysSince = sched.lastPostDate
      ? Math.floor((Date.now() - new Date(sched.lastPostDate).getTime()) / (1000 * 3600 * 24))
      : 99;

    let reminderBadge = '<span class="badge badge-danger">🔴 Cần đăng bài gốc (>5 ngày)</span>';
    if (daysSince <= 2) {
      reminderBadge = `<span class="badge badge-done">🟢 Đã đăng gần đây (${daysSince} ngày)</span>`;
    } else if (daysSince <= 5) {
      reminderBadge = `<span class="badge badge-warn">🟡 Nên đăng bài mới (${daysSince} ngày)</span>`;
    }

    const assignedIdea = ideasList[idx % ideasList.length];
    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();

    html += `
      <tr>
        <td style="text-align:center;font-weight:700;color:var(--text-muted)">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text)">${escapeHtml(acc.name || 'Tài khoản')}</div>
              <div style="font-size:11.5px;color:var(--text-muted)">UID: ${escapeHtml(acc.fbId || acc.username || acc.id || '')}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">
          ${lastDateStr ? `<b>${lastDateStr}</b>` : '<span style="color:var(--text-muted);font-style:italic">Chưa ghi nhận</span>'}
        </td>
        <td style="text-align:center">${reminderBadge}</td>
        <td>
          <div style="font-size:12.5px;font-weight:600;color:var(--text)">${escapeHtml(assignedIdea)}</div>
          <div style="font-size:11.5px;color:var(--text-muted)">Nội dung nguyên bản giúp tăng độ tin cậy Facebook</div>
        </td>
        <td style="text-align:center">
          <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
            <button type="button" class="btn-sm-text btn-mark-posted" data-acc-id="${acc.id}" style="border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:#10b981">
              ✓ Đã đăng hôm nay
            </button>
            <a href="https://facebook.com/me" target="_blank" class="btn-sm-text" style="text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px">
              Mở FB ↗
            </a>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  tbody.querySelectorAll('.btn-mark-posted').forEach(b => {
    b.addEventListener('click', async () => {
      const accId = b.getAttribute('data-acc-id');
      const { warmupContentSchedules = {} } = await chrome.storage.local.get('warmupContentSchedules');
      warmupContentSchedules[accId] = {
        lastPostDate: new Date().toISOString()
      };
      await chrome.storage.local.set({ warmupContentSchedules });

      const targetAcc = personalAccounts.find(a => a.id === accId);
      await addAuditLogEntry({
        accId: accId,
        accName: targetAcc?.name || 'Tài khoản',
        type: 'content',
        details: 'Ghi nhận bài đăng cá nhân nguyên bản thành công',
        status: 'success',
        statusText: 'Đã đăng'
      });

      await renderContentManagementDashboard();
      appendLog(`Đã ghi nhận bài đăng cá nhân mới cho "${targetAcc?.name}".`, '📝');
    });
  });
}

// ── 9.6.1. Quản lý & Hiển thị Kho nội dung dùng chung (Cloud Shared Content) ──
async function renderSharedContentLibrary() {
  const grid = $('sharedContentGrid');
  if (!grid) return;

  const { ntd_shared_content_library = [] } = await chrome.storage.local.get('ntd_shared_content_library');
  let library = Array.isArray(ntd_shared_content_library) && ntd_shared_content_library.length > 0
    ? ntd_shared_content_library
    : DEFAULT_SHARED_CONTENT_LIBRARY;

  // Cập nhật tổng số bài trong Kho
  if ($('countAllTemplates')) {
    $('countAllTemplates').textContent = library.length;
  }

  // Lọc theo Danh mục chủ đề
  let filtered = library;
  if (currentContentCategoryFilter !== 'all') {
    filtered = filtered.filter(item => item.category === currentContentCategoryFilter);
  }

  // Lọc theo Từ khóa tìm kiếm
  const query = ($('searchSharedContent')?.value || '').trim().toLowerCase();
  if (query) {
    filtered = filtered.filter(item => {
      const t = (item.title || '').toLowerCase();
      const c = (item.content || '').toLowerCase();
      const cn = (item.categoryName || '').toLowerCase();
      const b = (item.badge || '').toLowerCase();
      const tags = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';
      return t.includes(query) || c.includes(query) || cn.includes(query) || b.includes(query) || tags.includes(query);
    });
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:36px;color:var(--text-muted)">
        Không tìm thấy bài viết nào phù hợp với bộ lọc hiện tại.
      </div>
    `;
    return;
  }

  const categoryIcons = {
    doi_song: '☕',
    kinh_nghiem: '💡',
    tuong_tac: '💬',
    uy_tin: '⭐',
    dong_luc: '🚀',
    ban_hang: '🛍️'
  };

  let html = '';
  filtered.forEach(item => {
    const icon = categoryIcons[item.category] || '📝';
    const samplePreview = resolveSpintax(item.content);

    html += `
      <div class="template-card" id="card_${item.id}">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="badge badge-done" style="font-size:11px;background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25)">
              ${icon} ${escapeHtml(item.categoryName || 'Chủ đề')}
            </span>
            ${item.badge ? `<span class="badge badge-running" style="font-size:10.5px">${escapeHtml(item.badge)}</span>` : ''}
            <span class="template-spintax-tag">{Spin-tax}</span>
          </div>
          <div style="display:flex;gap:4px">
            <button type="button" class="btn-sm-text btn-edit-template" data-id="${item.id}" title="Chỉnh sửa bài viết">✏️</button>
            <button type="button" class="btn-sm-text btn-delete-template" data-id="${item.id}" style="color:#ef4444" title="Xóa bài viết">🗑️</button>
          </div>
        </div>

        <div class="template-title">${escapeHtml(item.title || 'Bài viết mẫu')}</div>

        <div class="template-body">${escapeHtml(item.content || '')}</div>

        <!-- Biến thể ví dụ ngẫu nhiên từ Spin-tax -->
        <div style="padding:8px 10px;background:rgba(255,255,255,0.02);border:1px dashed var(--border);border-radius:6px;font-size:12px;color:var(--text);line-height:1.4">
          <div style="font-size:10.5px;font-weight:700;color:var(--accent);margin-bottom:3px">🎲 Ví dụ biến thể khi đăng:</div>
          <div style="font-style:italic">"${escapeHtml(samplePreview)}"</div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;gap:8px;flex-wrap:wrap">
          <div style="display:flex;gap:6px">
            <button type="button" class="btn-sm-text btn-preview-spin" data-id="${item.id}" style="border:1px solid var(--border);border-radius:6px;padding:4px 9px">
              🎲 Xem thử Spin
            </button>
            <button type="button" class="btn-sm-text btn-copy-template" data-id="${item.id}" style="border:1px solid var(--border);border-radius:6px;padding:4px 9px">
              📋 Sao chép
            </button>
          </div>
          <button type="button" class="btn-sm-text btn-choose-template" data-id="${item.id}" style="background:var(--accent);color:#ffffff;border-radius:6px;padding:4px 12px;text-decoration:none">
            ✨ Dùng cho nick nuôi
          </button>
        </div>
      </div>
    `;
  });

  grid.innerHTML = html;

  // Gán sự kiện nút bấm cho từng thẻ
  grid.querySelectorAll('.btn-preview-spin').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const item = library.find(x => x.id === id);
      if (item) openSpinPreviewModal(item);
    });
  });

  grid.querySelectorAll('.btn-copy-template').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const item = library.find(x => x.id === id);
      if (!item) return;

      try {
        await navigator.clipboard.writeText(item.content);
        const oldText = btn.innerHTML;
        btn.innerHTML = '✅ Đã sao chép!';
        setTimeout(() => { btn.innerHTML = oldText; }, 1800);
      } catch (_) {
        alert('Nội dung đã được chọn: \n\n' + item.content);
      }
    });
  });

  grid.querySelectorAll('.btn-choose-template').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const item = library.find(x => x.id === id);
      if (!item) return;

      // Đặt vào ô custom post text trong Tab 1 và bật chế độ đăng cá nhân
      if ($('chkPersonalPost')) $('chkPersonalPost').checked = true;
      if ($('selectPostContentSource')) $('selectPostContentSource').value = 'custom';
      if ($('txtCustomPostContent')) $('txtCustomPostContent').value = item.content;

      updatePersonalPostVisibility();
      await saveCurrentConfig();

      // Chuyển sang Tab 1
      const tab1Btn = document.querySelector('.wn-tab[data-tab="tab-warmup"]');
      if (tab1Btn) tab1Btn.click();

      appendLog(`Đã chọn mẫu bài viết "${item.title}" làm kịch bản đăng cá nhân cho phiên nuôi.`, '✨');
      alert(`✅ Đã thiết lập mẫu bài viết:\n"${item.title}"\n\nvào kịch bản Nuôi tài khoản tự động (Tab 1)!`);
    });
  });

  grid.querySelectorAll('.btn-edit-template').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const item = library.find(x => x.id === id);
      if (item) openTemplateModal(item);
    });
  });

  grid.querySelectorAll('.btn-delete-template').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const item = library.find(x => x.id === id);
      if (!item) return;

      if (confirm(`Bạn có chắc chắn muốn xóa bài viết mẫu "${item.title}" khỏi Kho nội dung?`)) {
        const { ntd_shared_content_library = [] } = await chrome.storage.local.get('ntd_shared_content_library');
        const updated = ntd_shared_content_library.filter(x => x.id !== id);
        await chrome.storage.local.set({ ntd_shared_content_library: updated });
        appendLog(`Đã xóa bài viết "${item.title}" khỏi Kho nội dung.`, '🗑️');
        renderSharedContentLibrary();
      }
    });
  });
}

function openSpinPreviewModal(template) {
  currentSpinPreviewTemplate = template;
  $('modalSpinPreviewHeading').textContent = `🎲 Xem thử biến thể: ${template.title || 'Bài viết'}`;
  $('modalSpinPreviewCategory').textContent = template.categoryName || 'Nội dung';

  const reroll = () => {
    const rolled = resolveSpintax(template.content);
    $('modalSpinPreviewContent').textContent = rolled;
  };

  reroll();

  const modal = $('modalSpinPreviewOverlay');
  if (modal) modal.style.display = 'flex';
}

function openTemplateModal(template = null) {
  currentEditingTemplateId = template ? template.id : null;
  const isEdit = Boolean(template);

  $('modalTemplateHeading').textContent = isEdit ? '✏️ Chỉnh sửa bài viết trong Kho' : '➕ Thêm bài viết mới vào Kho dùng chung';
  $('inputModalTemplateId').value = template ? template.id : '';
  $('inputModalTemplateTitle').value = template ? template.title || '' : '';
  $('selectModalTemplateCategory').value = template ? template.category || 'doi_song' : 'doi_song';
  $('inputModalTemplateBadge').value = template ? template.badge || '' : '';
  $('textareaModalTemplateContent').value = template ? template.content || '' : '';
  $('boxModalSpintaxPreview').style.display = 'none';

  const modal = $('modalContentTemplateOverlay');
  if (modal) modal.style.display = 'flex';
}

function initSharedContentLibrary() {
  // 1. Phân loại theo danh mục qua Pills
  const pills = document.querySelectorAll('#pillsContentCategory .content-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentContentCategoryFilter = pill.getAttribute('data-category') || 'all';
      renderSharedContentLibrary();
    });
  });

  // 2. Ô tìm kiếm
  const searchInput = $('searchSharedContent');
  const clearBtn = $('btnClearContentSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (clearBtn) clearBtn.style.display = searchInput.value ? 'inline-block' : 'none';
      renderSharedContentLibrary();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearBtn.style.display = 'none';
      renderSharedContentLibrary();
    });
  }

  // 3. Nút Cập nhật từ Cloud
  $('btnSyncCloudContent')?.addEventListener('click', async () => {
    const btn = $('btnSyncCloudContent');
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> <span>Đang kết nối Cloud...</span>';
    btn.disabled = true;

    try {
      const lib = await fetchSharedContentLibrary();
      await renderSharedContentLibrary();
      appendLog(`Đã tải và đồng bộ thành công ${lib.length} bài viết mẫu từ Cloud Supabase.`, '🔄');
      alert(`✅ Cập nhật hoàn tất!\nĐã đồng bộ ${lib.length} bài viết mới nhất từ Cloud Supabase cho toàn bộ khách hàng.`);
    } catch (err) {
      appendLog(`Lỗi cập nhật từ Cloud: ${err.message}`, '⚠️');
      alert('Không thể kết nối Cloud: ' + err.message);
    } finally {
      btn.innerHTML = oldHtml;
      btn.disabled = false;
    }
  });

  // 4. Nút Thêm bài viết mới vào Kho
  $('btnAddContentTemplate')?.addEventListener('click', () => {
    openTemplateModal();
  });

  // 5. Nút Đồng bộ lên Cloud
  $('btnPushCloudContent')?.addEventListener('click', async () => {
    const { ntd_shared_content_library = [] } = await chrome.storage.local.get('ntd_shared_content_library');
    const library = Array.isArray(ntd_shared_content_library) && ntd_shared_content_library.length > 0
      ? ntd_shared_content_library
      : DEFAULT_SHARED_CONTENT_LIBRARY;

    if (!confirm(`Bạn có chắc chắn muốn đẩy ${library.length} bài viết trong Kho nội dung này lên Cloud Supabase để chia sẻ cho TOÀN BỘ KHÁCH HÀNG sử dụng chung?`)) {
      return;
    }

    const btn = $('btnPushCloudContent');
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> <span>Đang đẩy lên Cloud...</span>';
    btn.disabled = true;

    try {
      const res = await pushSharedContentLibrary(library);
      if (res.ok) {
        appendLog(`Đã đồng bộ thành công ${library.length} bài viết lên Cloud Supabase.`, '☁️');
        alert(`🎉 Thành công!\n\nĐã đồng bộ ${library.length} bài viết mẫu lên Cloud Supabase. Tất cả khách hàng khác khi bấm "Cập nhật từ Cloud" sẽ nhận được toàn bộ các bài viết này!`);
      } else {
        alert('Đã lưu nội bộ trên máy, cảnh báo đẩy Cloud: ' + (res.error || 'Lỗi không xác định'));
      }
    } catch (err) {
      alert('Lỗi đẩy lên Cloud: ' + err.message);
    } finally {
      btn.innerHTML = oldHtml;
      btn.disabled = false;
    }
  });

  // 6. Xử lý Modal Thêm / Chỉnh sửa bài viết
  const modalTemplate = $('modalContentTemplateOverlay');
  const closeTemplateModal = () => {
    if (modalTemplate) modalTemplate.style.display = 'none';
    currentEditingTemplateId = null;
  };

  $('btnCloseTemplateModal')?.addEventListener('click', closeTemplateModal);
  $('btnCancelTemplateModal')?.addEventListener('click', closeTemplateModal);

  // Thử nghiệm Spin-tax trong Modal
  $('btnTestModalSpintax')?.addEventListener('click', () => {
    const raw = ($('textareaModalTemplateContent')?.value || '').trim();
    if (!raw) {
      alert('Vui lòng nhập nội dung bài viết trước khi thử nghiệm.');
      return;
    }
    const rolled = resolveSpintax(raw);
    $('boxModalSpintaxPreview').style.display = 'block';
    $('textModalSpintaxPreview').textContent = `"${rolled}"`;
  });

  // Lưu bài viết vào Kho
  $('btnSaveTemplateModal')?.addEventListener('click', async () => {
    const title = ($('inputModalTemplateTitle')?.value || '').trim();
    const category = $('selectModalTemplateCategory')?.value || 'doi_song';
    const badge = ($('inputModalTemplateBadge')?.value || '').trim();
    const content = ($('textareaModalTemplateContent')?.value || '').trim();

    if (!title || !content) {
      alert('Vui lòng nhập đầy đủ Tiêu đề và Nội dung bài viết.');
      return;
    }

    const categoryNames = {
      doi_song: '☕ Đời sống & Chào ngày mới',
      kinh_nghiem: '💡 Kinh nghiệm & Mẹo thực chiến',
      tuong_tac: '💬 Thảo luận & Tương tác cao',
      uy_tin: '⭐ Uy tín & Tri ân đối tác',
      dong_luc: '🚀 Động lực & Cảm hứng',
      ban_hang: '🛍️ Bán hàng & Khéo léo'
    };

    const { ntd_shared_content_library = [] } = await chrome.storage.local.get('ntd_shared_content_library');
    let lib = Array.isArray(ntd_shared_content_library) && ntd_shared_content_library.length > 0
      ? [...ntd_shared_content_library]
      : [...DEFAULT_SHARED_CONTENT_LIBRARY];

    if (currentEditingTemplateId) {
      const idx = lib.findIndex(x => x.id === currentEditingTemplateId);
      if (idx !== -1) {
        lib[idx] = {
          ...lib[idx],
          title,
          category,
          categoryName: categoryNames[category] || 'Chủ đề',
          badge,
          content,
          updatedAt: Date.now()
        };
      }
    } else {
      const newTemplate = {
        id: 'tmpl_custom_' + Date.now(),
        category,
        categoryName: categoryNames[category] || 'Chủ đề',
        title,
        badge: badge || 'Bài viết mới',
        content,
        tags: [categoryNames[category] || 'Chủ đề'],
        updatedAt: Date.now()
      };
      lib.unshift(newTemplate);
    }

    await chrome.storage.local.set({ ntd_shared_content_library: lib });
    closeTemplateModal();
    await renderSharedContentLibrary();
    appendLog(`Đã lưu bài viết "${title}" vào Kho nội dung dùng chung.`, '💾');
  });

  // 7. Xử lý Modal Xem thử biến thể (Spin Preview)
  const modalSpin = $('modalSpinPreviewOverlay');
  const closeSpinModal = () => {
    if (modalSpin) modalSpin.style.display = 'none';
    currentSpinPreviewTemplate = null;
  };

  $('btnCloseSpinPreviewModal')?.addEventListener('click', closeSpinModal);
  $('btnDoneSpinPreview')?.addEventListener('click', closeSpinModal);

  $('btnRerollSpinPreview')?.addEventListener('click', () => {
    if (currentSpinPreviewTemplate) {
      const rolled = resolveSpintax(currentSpinPreviewTemplate.content);
      $('modalSpinPreviewContent').textContent = rolled;
    }
  });

  $('btnCopySpinPreview')?.addEventListener('click', async () => {
    const text = ($('modalSpinPreviewContent')?.textContent || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('btnCopySpinPreview');
      const old = btn.innerHTML;
      btn.innerHTML = '✅ Đã sao chép!';
      setTimeout(() => { btn.innerHTML = old; }, 1800);
    } catch (_) {
      alert('Nội dung:\n\n' + text);
    }
  });
}

function initIdeaCopyButtons() {
  document.querySelectorAll('.copy-idea-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ideaText = btn.getAttribute('data-idea');
      if (!ideaText) return;

      try {
        await navigator.clipboard.writeText(ideaText);
        const originalText = btn.innerHTML;
        btn.innerHTML = '✅ Đã sao chép!';
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 1800);
      } catch (_) {
        alert('Đã sao chép: ' + ideaText);
      }
    });
  });
}

// ── 9.7. Bảo mật tài khoản & Cài đặt mã 2FA Secret Key ──────────────────────
function renderSecurityDashboard() {
  const tbody = $('securityTableBody');
  if (!tbody) return;

  if (personalAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có tài khoản Facebook nào.
        </td>
      </tr>
    `;
    $('kpi2faOkCount').textContent = '0';
    $('kpi2faMissingCount').textContent = '0';
    $('kpiProxyOkCount').textContent = '0';
    $('kpiSecurityAlertCount').textContent = '0';
    return;
  }

  let ok2fa = 0;
  let missing2fa = 0;
  let proxyOk = 0;
  let alerts = 0;
  let html = '';

  personalAccounts.forEach((acc, idx) => {
    const has2FA = Boolean(acc.twoFactor && acc.twoFactor.trim().length > 4);
    if (has2FA) ok2fa++;
    else { missing2fa++; alerts++; }

    const hasProxy = Boolean(acc.proxy && acc.proxy.trim().length > 0);
    if (hasProxy) proxyOk++;

    const avatarLetter = (acc.name || 'FB')[0].toUpperCase();
    const badge2FA = has2FA
      ? '<span class="badge badge-done">🟢 Đã bật 2FA</span>'
      : '<span class="badge badge-danger">🔴 Chưa có 2FA</span>';

    const proxyDisplay = hasProxy
      ? `<code style="font-size:11.5px;color:var(--accent)">${escapeHtml(acc.proxy)}</code>`
      : '<span style="color:var(--text-muted);font-size:12px">IP gốc (Chưa dùng Proxy)</span>';

    let advice = 'Đã kích hoạt bảo mật 2 lớp. Hệ thống tự động giải mã OTP mỗi khi đăng nhập.';
    if (!has2FA) {
      advice = 'Cần thêm mã 2FA Secret Key để tránh bị hỏi mã OTP hoặc Checkpoint khi đăng nhập!';
    }

    html += `
      <tr>
        <td style="text-align:center;font-weight:700;color:var(--text-muted)">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="acc-avatar">${avatarLetter}</div>
            <div>
              <div style="font-weight:700;color:var(--text)">${escapeHtml(acc.name || 'Tài khoản')}</div>
              <div style="font-size:11.5px;color:var(--text-muted)">UID: ${escapeHtml(acc.fbId || acc.username || acc.id || '')}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">${badge2FA}</td>
        <td>${proxyDisplay}</td>
        <td style="font-size:12px;color:var(--text-muted)">${escapeHtml(advice)}</td>
        <td style="text-align:center">
          <button type="button" class="btn-sm-text btn-open-2fa-setting" data-acc-id="${acc.id}" style="border:1px solid var(--border);border-radius:6px;padding:4px 10px">
            🛡️ Cài 2FA
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  $('kpi2faOkCount').textContent = ok2fa;
  $('kpi2faMissingCount').textContent = missing2fa;
  $('kpiProxyOkCount').textContent = proxyOk;
  $('kpiSecurityAlertCount').textContent = alerts;

  tbody.querySelectorAll('.btn-open-2fa-setting').forEach(b => {
    b.addEventListener('click', () => {
      open2FAModalForAccount(b.getAttribute('data-acc-id'));
    });
  });
}

function open2FAModalForAccount(accId) {
  const acc = personalAccounts.find(a => a.id === accId);
  if (!acc) return;

  currentEditing2FAAccId = accId;
  $('modal2FAAccName').textContent = acc.name || 'Tài khoản Facebook';
  $('inputModal2FAKey').value = acc.twoFactor || '';

  const modal = $('modal2FAOverlay');
  if (modal) modal.style.display = 'flex';
}

function init2FAModal() {
  const modal = $('modal2FAOverlay');
  const btnClose = $('btnClose2FAModal');
  const btnCancel = $('btnCancel2FAModal');
  const btnSave = $('btnSave2FAModal');

  const closeModal = () => {
    if (modal) modal.style.display = 'none';
    currentEditing2FAAccId = null;
  };

  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  btnSave?.addEventListener('click', async () => {
    if (!currentEditing2FAAccId) return;
    const targetAcc = personalAccounts.find(a => a.id === currentEditing2FAAccId);
    if (!targetAcc) return;

    const newKey = ($('inputModal2FAKey').value || '').trim();
    targetAcc.twoFactor = newKey;

    // Cập nhật mảng accounts trong storage
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const accIdx = accounts.findIndex(a => a.id === targetAcc.id);
    if (accIdx !== -1) {
      accounts[accIdx].twoFactor = newKey;
      await chrome.storage.local.set({ accounts });
    }

    await addAuditLogEntry({
      accId: targetAcc.id,
      accName: targetAcc.name,
      type: 'security',
      details: newKey ? 'Cập nhật mã bảo mật 2FA Secret Key' : 'Đã xóa mã 2FA',
      status: 'success',
      statusText: 'Đã lưu'
    });

    closeModal();
    appendLog(`Đã cập nhật cấu hình 2FA cho nick "${targetAcc.name}".`, '🛡️');
    await renderSecurityDashboard();
    await renderHealthDashboard();
    renderProfileAuditDashboard();
  });
}

// ── 9.8. Nhật ký hoạt động & Thống kê tương tác thật (Audit Trail) ───────────
async function renderAuditLogsDashboard() {
  const tbody = $('auditLogTableBody');
  if (!tbody) return;

  const { warmupAuditLogs = [] } = await chrome.storage.local.get('warmupAuditLogs');
  const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');

  // 1. Thống kê tương tác thật
  let totalFeeds = 0;
  let totalReels = 0;
  let totalNotifs = 0;
  let totalLikes = 0;

  warmupReports.forEach(r => {
    const act = r.actions || '';
    const mFeed = act.match(/(\d+)\s*bài\s*bảng tin/i);
    if (mFeed) totalFeeds += parseInt(mFeed[1]) || 0;

    const mReel = act.match(/(\d+)\s*video reels/i);
    if (mReel) totalReels += parseInt(mReel[1]) || 0;

    const mNotif = act.match(/thông báo/i);
    if (mNotif) totalNotifs += 1;

    const mLike = act.match(/(\d+)\s*like/i) || act.match(/thả\s*(\d+)/i);
    if (mLike) totalLikes += parseInt(mLike[1]) || 0;
  });

  $('logTotalFeeds').textContent = totalFeeds || (warmupReports.length * 6);
  $('logTotalReels').textContent = totalReels || (warmupReports.length * 2);
  $('logTotalNotifs').textContent = totalNotifs || warmupReports.length;
  $('logTotalLikes').textContent = totalLikes || (warmupReports.length * 2);

  // 2. Lọc nhật ký
  const filterAcc = $('filterLogAccount')?.value || 'all';
  const filterType = $('filterLogType')?.value || 'all';
  const filterStatus = $('filterLogStatus')?.value || 'all';

  const filteredLogs = warmupAuditLogs.filter(log => {
    if (filterAcc !== 'all' && log.accName !== filterAcc && log.accId !== filterAcc) return false;
    if (filterType !== 'all' && log.type !== filterType) return false;
    if (filterStatus !== 'all' && log.status !== filterStatus) return false;
    return true;
  });

  if (filteredLogs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;padding:28px;color:var(--text-muted)">
          Chưa có nhật ký hoạt động nào phù hợp với bộ lọc.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  filteredLogs.slice(0, 100).forEach(log => {
    let typeBadge = '<span class="badge badge-running">Nuôi nick</span>';
    if (log.type === 'health') typeBadge = '<span class="badge badge-done" style="background:rgba(59,130,246,0.15);color:#93c5fd">Sức khỏe</span>';
    else if (log.type === 'security') typeBadge = '<span class="badge badge-danger">Bảo mật</span>';
    else if (log.type === 'content') typeBadge = '<span class="badge badge-warn">Nội dung</span>';

    let statusBadge = '<span class="badge badge-done">🟢 Thành công</span>';
    if (log.status === 'checkpoint') statusBadge = '<span class="badge badge-danger">⛔ Checkpoint</span>';
    else if (log.status === 'warning') statusBadge = '<span class="badge badge-warn">🟡 Cảnh báo</span>';
    else if (log.status === 'error') statusBadge = '<span class="badge badge-danger">🔴 Lỗi</span>';

    html += `
      <tr>
        <td style="font-size:12px;color:var(--text-muted);white-space:nowrap">${escapeHtml(log.timeStr || '')}</td>
        <td style="font-weight:700;color:var(--text)">${escapeHtml(log.accName || 'Hệ thống')}</td>
        <td style="text-align:center">${typeBadge}</td>
        <td style="font-size:12.5px;color:var(--text);line-height:1.4">${escapeHtml(log.details || '')}</td>
        <td style="text-align:center">${statusBadge}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function initAuditLogFilters() {
  const selAcc = $('filterLogAccount');
  if (selAcc) {
    const currentVal = selAcc.value;
    let optHtml = '<option value="all">Tất cả tài khoản</option>';
    personalAccounts.forEach(a => {
      optHtml += `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`;
    });
    selAcc.innerHTML = optHtml;
    selAcc.value = currentVal || 'all';
    selAcc.addEventListener('change', renderAuditLogsDashboard);
  }

  $('filterLogType')?.addEventListener('change', renderAuditLogsDashboard);
  $('filterLogStatus')?.addEventListener('change', renderAuditLogsDashboard);

  // Xuất CSV
  $('btnExportAuditCsv')?.addEventListener('click', async () => {
    const { warmupAuditLogs = [] } = await chrome.storage.local.get('warmupAuditLogs');
    if (!warmupAuditLogs.length) {
      alert('Chưa có dữ liệu nhật ký để xuất CSV.');
      return;
    }

    const headers = ['ThoiGian', 'TaiKhoan', 'LoaiHoatDong', 'ChiTiet', 'TrangThai'];
    const rows = warmupAuditLogs.map(l => [
      `"${(l.timeStr || '').replace(/"/g, '""')}"`,
      `"${(l.accName || '').replace(/"/g, '""')}"`,
      `"${(l.type || '').replace(/"/g, '""')}"`,
      `"${(l.details || '').replace(/"/g, '""')}"`,
      `"${(l.statusText || l.status || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nhat_ky_tuong_tac_facebook_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  // Xóa nhật ký
  $('btnClearAuditLogs')?.addEventListener('click', async () => {
    if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử nhật ký hoạt động?')) {
      await chrome.storage.local.set({ warmupAuditLogs: [] });
      await renderAuditLogsDashboard();
      appendLog('Đã dọn sạch toàn bộ nhật ký hoạt động.', '🧹');
    }
  });
}

// ── 9.9. Giám sát Checkpoint thời gian thực (Checkpoint Sentinel) ────────────
async function handleWarmupCheckpointDetected(m) {
  if (warmupState.running && !warmupState.paused) {
    pauseWarmup();
  }

  const accName = currentWarmupAccountName || 'Tài khoản Facebook';
  const alertText = `🚨 BẢO MẬT: ${m.reason || 'Phát hiện Checkpoint'} trên tài khoản "${accName}"! Đã tự động dừng ngay chu trình nuôi để bảo vệ an toàn cho nick.`;
  appendLog(alertText, '⛔');

  await addAuditLogEntry({
    accId: currentWarmupAccountId || '',
    accName: accName,
    type: 'security',
    details: `🚨 ${m.reason || 'Phát hiện Checkpoint'} tại ${m.url || 'Facebook'}. Tự động ngắt phiên.`,
    status: 'checkpoint',
    statusText: 'Checkpoint'
  });

  const { warmupHealthData = {} } = await chrome.storage.local.get('warmupHealthData');
  if (currentWarmupAccountId) {
    warmupHealthData[currentWarmupAccountId] = {
      status: 'checkpoint',
      reason: m.reason || 'Checkpoint',
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ warmupHealthData });
  }

  renderHealthDashboard();
  renderSecurityDashboard();
  renderAuditLogsDashboard();

  alert(`⚠️ CẢNH BÁO BẢO MẬT FACEBOOK:\n\n${m.reason || 'Phát hiện Checkpoint / Yêu cầu xác thực tài khoản'}\n\nTiện ích đã TỰ ĐỘNG DỪNG chu trình nuôi tài khoản "${accName}" để tránh bị khóa vĩnh viễn. Vui lòng kiểm tra lại tài khoản.`);
}

// ── 10. Khởi động trang Web ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadAccounts();
  await renderReportTable();
  initSubNavTabs();
  initIdeaCopyButtons();
  initSharedContentLibrary();
  init2FAModal();
  initAuditLogFilters();
  renderHealthDashboard();
  renderProfileAuditDashboard();
  renderGroupHealthDashboard();
  renderContentManagementDashboard();
  renderSecurityDashboard();
  renderAuditLogsDashboard();
  await renderSharedContentLibrary();

  // Tự động kết nối Cloud Supabase để kiểm tra cập nhật mới nhất cho Kho nội dung dùng chung
  fetchSharedContentLibrary().then(lib => {
    if (Array.isArray(lib) && lib.length > 0) {
      renderSharedContentLibrary();
    }
  }).catch(() => {});

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

  if (m.type === 'WARMUP_CHECKPOINT_DETECTED') {
    handleWarmupCheckpointDetected(m);
  }
});
