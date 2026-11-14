/**
 * NTD Agency - Settings Controller (settings.js)
 * Quản lý các danh mục cài đặt tối giản (Accordion), chạy nền, Zalo Bot,
 * an toàn đăng bài và sao lưu / khôi phục dữ liệu toàn hệ thống.
 */
import { enforceLicenseGate } from './license.js';
await enforceLicenseGate();

import {
  loadZaloSettings,
  saveZaloSettings,
  forgetZaloSettings,
  pairZaloBot,
  testZaloBot,
  setMapsPower
} from './maps_notify.js';

const $ = id => document.getElementById(id);

function setZaloStatus(msg, type = 'info') {
  const el = $('zaloStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-box ' + type;
  el.removeAttribute('style');
}

// ── 1. Khởi tạo chức năng Đóng / Mở (Sổ ra) các mục Cài đặt ──────────────────
function initCollapsibleCards() {
  const headers = document.querySelectorAll('.setting-card-header');
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.setting-card');
      if (card) {
        card.classList.toggle('open');
      }
    });
  });

  // Tự động mở mục theo URL hash nếu có (ví dụ: #cardZalo, #cardBackup)
  if (window.location.hash) {
    const targetId = window.location.hash.replace('#', '');
    const targetEl = document.getElementById(targetId);
    if (targetEl && targetEl.classList.contains('setting-card')) {
      targetEl.classList.add('open');
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

// ── 2. Cập nhật Badge hiển thị ngoài danh mục ────────────────────────────────
function updateInfoGrid(zalo, keepAwake) {
  const infoZalo = $('infoZaloState');
  if (infoZalo) {
    if (zalo?.enabled && zalo?.chat) {
      infoZalo.textContent = 'Đã kết nối';
      infoZalo.className = 'setting-badge success';
    } else if (zalo?.chat) {
      infoZalo.textContent = 'Đã ghép ID';
      infoZalo.className = 'setting-badge active';
    } else {
      infoZalo.textContent = 'Chưa bật';
      infoZalo.className = 'setting-badge';
    }
  }

  const infoPower = $('infoPowerState');
  if (infoPower) {
    infoPower.textContent = keepAwake ? 'Đang bật' : 'Tắt';
    infoPower.className = 'setting-badge ' + (keepAwake ? 'success' : '');
  }
}

// ── 3. Thiết lập sự kiện Zalo Bot & Chạy nền ─────────────────────────────────
function setupZaloAndPowerEvents() {
  const updateSubOptionsState = () => {
    const isEnabled = $('zaloEnabled').checked;
    const sub = $('zaloSubOptions');
    if (sub) {
      sub.style.opacity = isEnabled ? '1' : '0.45';
      sub.style.pointerEvents = isEnabled ? 'auto' : 'none';
    }
  };
  $('zaloEnabled').addEventListener('change', updateSubOptionsState);

  // Lưu cài đặt Zalo
  $('saveZalo').onclick = async () => {
    try {
      const isEnabled = $('zaloEnabled').checked;
      const token = $('zaloToken').value;
      const chat = $('zaloChat').value;
      const notifyFbDone = $('zaloNotifyFbDone').checked;
      const notifyFbStopped = $('zaloNotifyFbStopped') ? $('zaloNotifyFbStopped').checked : true;
      const notifyFbError = $('zaloNotifyFbError').checked;
      const notifyMaps = $('zaloNotifyMaps').checked;
      const keepAwake = $('keepAwake').checked;

      const msg = await saveZaloSettings({
        enabled: isEnabled,
        token,
        chat,
        notifyFbDone,
        notifyFbStopped,
        notifyFbError,
        notifyMaps,
        keepAwake
      });
      setZaloStatus(msg, 'info');

      updateInfoGrid({ enabled: isEnabled, chat }, keepAwake);
      updateSubOptionsState();
    } catch (e) {
      setZaloStatus(e.message, 'danger');
    }
  };

  // Ghép Zalo của tôi
  $('pairZalo').onclick = async () => {
    $('pairZalo').disabled = true;
    try {
      const token = $('zaloToken').value.trim();
      const chatId = await pairZaloBot(token, code => {
        setZaloStatus(`Trong 60 giây, hãy mở Zalo cá nhân và nhắn đúng mã [ ${code} ] cho Bot. Đang chờ kết nối...`, 'warning');
      });
      $('zaloChat').value = chatId;
      setZaloStatus(`Đã ghép Zalo thành công! Chat ID: ${chatId}. Hãy tích chọn "Gửi thông báo Zalo cá nhân", bấm Lưu cài đặt rồi Gửi thử.`, 'success');

      updateInfoGrid({ enabled: $('zaloEnabled').checked, chat: chatId }, $('keepAwake').checked);
    } catch (e) {
      setZaloStatus(e.message, 'danger');
    } finally {
      $('pairZalo').disabled = false;
    }
  };

  // Gửi thử tin nhắn Zalo
  $('testZalo').onclick = async () => {
    $('testZalo').disabled = true;
    try {
      await testZaloBot({
        enabled: $('zaloEnabled').checked,
        token: $('zaloToken').value,
        chat: $('zaloChat').value,
        notifyFbDone: $('zaloNotifyFbDone').checked,
        notifyFbStopped: $('zaloNotifyFbStopped') ? $('zaloNotifyFbStopped').checked : true,
        notifyFbError: $('zaloNotifyFbError').checked,
        notifyMaps: $('zaloNotifyMaps').checked,
        keepAwake: $('keepAwake').checked
      });
      setZaloStatus('Đã gửi yêu cầu tin nhắn thử đến Zalo. Vui lòng kiểm tra điện thoại của bạn!', 'success');
    } catch (e) {
      setZaloStatus(e.message, 'danger');
    } finally {
      $('testZalo').disabled = false;
    }
  };

  // Xóa kết nối
  $('forgetZalo').onclick = async () => {
    if (!confirm('Bạn có chắc chắn muốn xóa Token, Chat ID và các thông báo Zalo đang lưu trữ?')) return;
    await forgetZaloSettings();
    $('zaloToken').value = '';
    $('zaloChat').value = '';
    $('zaloEnabled').checked = false;
    setZaloStatus('Đã xóa toàn bộ kết nối Zalo.', 'neutral');

    updateInfoGrid({ enabled: false, chat: '' }, $('keepAwake').checked);
  };

  // Giữ máy thức
  $('keepAwake').onchange = async () => {
    const isChecked = $('keepAwake').checked;
    await chrome.storage.local.set({ rinKeepAwake: isChecked });
    $('powerStatus').textContent = isChecked
      ? 'Chế độ giữ máy thức đã bật (sẵn sàng khi chạy).'
      : 'Không giữ máy thức.';
    updateInfoGrid(
      { enabled: $('zaloEnabled').checked, chat: $('zaloChat').value },
      isChecked
    );
  };

  // Chạy ngầm 100% (Không nhảy màn hình)
  $('chkBackgroundMode')?.addEventListener('change', async () => {
    const isBg = $('chkBackgroundMode').checked;
    const { warmupConfig = {} } = await chrome.storage.local.get('warmupConfig');
    warmupConfig.backgroundMode = isBg;
    await chrome.storage.local.set({ warmupConfig });
  });

  // Tự động đóng tab khi xong
  $('chkAutoCloseTab')?.addEventListener('change', async () => {
    const isAutoClose = $('chkAutoCloseTab').checked;
    const { warmupConfig = {} } = await chrome.storage.local.get('warmupConfig');
    warmupConfig.autoCloseTab = isAutoClose;
    await chrome.storage.local.set({ warmupConfig });
  });
}

// ── 4. Cấu hình An toàn Facebook ─────────────────────────────────────────────
async function initSafetySettings() {
  const saveBtn = $('saveSafetyBtn');
  const msgEl = $('safetyMsg');

  // Đọc cài đặt an toàn đã lưu
  const { ntdSafety = {} } = await chrome.storage.local.get('ntdSafety');
  if (ntdSafety.dailyLimit) $('cfgDailyLimit').value = ntdSafety.dailyLimit;
  if (ntdSafety.defaultGap) $('cfgDefaultGap').value = ntdSafety.defaultGap;
  if (ntdSafety.humanBehavior !== undefined) $('cfgHumanBehavior').checked = !!ntdSafety.humanBehavior;
  if (ntdSafety.autoSkip !== undefined) $('cfgAutoSkip').checked = !!ntdSafety.autoSkip;

  saveBtn?.addEventListener('click', async () => {
    const dailyLimit = Math.max(1, Math.min(100, Number($('cfgDailyLimit').value) || 20));
    const defaultGap = Math.max(60, Math.min(1200, Number($('cfgDefaultGap').value) || 180));
    const humanBehavior = $('cfgHumanBehavior').checked;
    const autoSkip = $('cfgAutoSkip').checked;

    await chrome.storage.local.set({
      ntdSafety: { dailyLimit, defaultGap, humanBehavior, autoSkip }
    });

    if (msgEl) {
      msgEl.textContent = 'Đã lưu cấu hình an toàn thành công!';
      msgEl.style.display = 'block';
      setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
    }
  });
}

// ── 5. Sao lưu & Khôi phục dữ liệu ───────────────────────────────────────────
function initBackupAndRestore() {
  const exportBtn = $('exportBackupBtn');
  const importBtn = $('importBackupBtn');
  const fileInput = $('importFileInput');
  const backupMsg = $('backupMsg');

  // Xuất file sao lưu JSON
  exportBtn?.addEventListener('click', async () => {
    try {
      const data = await chrome.storage.local.get(null); // Lấy toàn bộ dữ liệu tiện ích
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `NTD-Agency-Backup-${dateStr}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      if (backupMsg) {
        backupMsg.textContent = 'Đã tải file sao lưu JSON về máy thành công!';
        backupMsg.style.display = 'block';
        setTimeout(() => { backupMsg.style.display = 'none'; }, 4000);
      }
    } catch (err) {
      alert('Lỗi xuất sao lưu: ' + err.message);
    }
  });

  // Nạp file sao lưu JSON
  importBtn?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Định dạng tệp JSON không hợp lệ.');
      }

      if (!confirm(`Xác nhận nạp dữ liệu từ file "${file.name}"? Dữ liệu hiện tại sẽ được cập nhật.`)) {
        fileInput.value = '';
        return;
      }

      // Bảo toàn phiên đăng nhập hiện tại trên Web, không để file cũ đè mất session
      const currentAuth = await chrome.storage.local.get(['license', 'machineId']);
      if (currentAuth.license) {
        delete parsed.license;
      }
      if (currentAuth.machineId) {
        delete parsed.machineId;
      }

      await chrome.storage.local.set(parsed);

      if (backupMsg) {
        backupMsg.textContent = 'Đã khôi phục dữ liệu thành công! Tiện ích đang làm mới...';
        backupMsg.style.display = 'block';
      }

      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err) {
      alert('Lỗi nạp file: ' + err.message);
    } finally {
      fileInput.value = '';
    }
  });
}

// ── 6. Khởi động trang Cài đặt ───────────────────────────────────────────────
(async () => {
  initCollapsibleCards();
  setupZaloAndPowerEvents();

  await initSafetySettings();
  initBackupAndRestore();

  try {
    const z = await loadZaloSettings();
    $('zaloEnabled').checked = z.enabled;
    $('zaloNotifyFbDone').checked = z.notifyFbDone !== false;
    if ($('zaloNotifyFbStopped')) $('zaloNotifyFbStopped').checked = z.notifyFbStopped !== false;
    $('zaloNotifyFbError').checked = z.notifyFbError !== false;
    $('zaloNotifyMaps').checked = z.notifyMaps !== false;
    $('zaloToken').value = z.token;
    $('zaloChat').value = z.chat;
    $('keepAwake').checked = z.keepAwake;

    const sub = $('zaloSubOptions');
    if (sub) {
      sub.style.opacity = z.enabled ? '1' : '0.45';
      sub.style.pointerEvents = z.enabled ? 'auto' : 'none';
    }

    $('powerStatus').textContent = z.keepAwake
      ? 'Chế độ giữ máy thức đã bật (sẵn sàng khi chạy).'
      : 'Không giữ máy thức.';

    if (z.enabled && z.chat) {
      setZaloStatus(`✅ Đang bật gửi thông báo đến Chat ID: ${z.chat}`, 'success');
    } else if (z.chat) {
      setZaloStatus(`Đã ghép Chat ID: ${z.chat} (chưa tích chọn gửi thông báo).`, 'info');
    }

    // Nạp cấu hình Chạy ngầm & Tự động đóng tab
    const { warmupConfig = {} } = await chrome.storage.local.get('warmupConfig');
    if ($('chkBackgroundMode')) {
      $('chkBackgroundMode').checked = warmupConfig.backgroundMode !== false;
    }
    if ($('chkAutoCloseTab')) {
      $('chkAutoCloseTab').checked = warmupConfig.autoCloseTab !== false;
    }

    updateInfoGrid(z, z.keepAwake);
  } catch (err) {
    console.warn('Lỗi đọc cài đặt:', err);
  }
})();

// Lắng nghe cập nhật thông báo trạng thái gửi Zalo trong background
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rinDelivery) {
      const d = changes.rinDelivery.newValue;
      if (d) {
        const el = $('zaloStatus');
        if (el) {
          el.textContent = d.message + (d.ok ? '' : ' (Tin nhắn đang nằm trong hàng đợi, sẽ tự động gửi lại khi có mạng).');
        }
      }
    }
  });
}
