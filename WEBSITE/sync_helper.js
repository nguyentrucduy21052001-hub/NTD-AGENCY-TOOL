// sync_helper.js – Hệ thống đồng bộ 1-chạm & Cập nhật dữ liệu trực tiếp cho NTD Agency
import { SECRET } from './license.js';

// ── Base64 & Binary Helpers (An toàn cho dữ liệu lớn) ──────────────────────────
export function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64) {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── AES-GCM Encrypt & Decrypt (Bảo mật 100% dữ liệu trước khi đẩy lên Cloud) ────
export async function encryptData(plainText, secret = SECRET) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainText));
  
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return uint8ArrayToBase64(combined);
}

export async function decryptData(cipherBase64, secret = SECRET) {
  const combined = base64ToUint8Array(cipherBase64.trim());
  if (combined.length < 13) {
    throw new Error('Mã dữ liệu không hợp lệ hoặc bị thiếu nội dung.');
  }
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    throw new Error('Giải mã thất bại! Mã đồng bộ này có thể không đúng hoặc không thuộc tiện ích NTD Agency.');
  }
}

// ── Đóng gói & Nạp dữ liệu vào chrome.storage ──────────────────────────────────
export async function collectAllData() {
  const stored = await chrome.storage.local.get([
    'accounts',
    'groupCategories',
    'draft',
    'dailyPostStats',
    'warmupConfig',
    'rinMaps',
    'rinZalo'
  ]);
  return {
    appName: 'NTD Agency',
    version: '0.4.1',
    timestamp: Date.now(),
    exportedAt: new Date().toISOString(),
    accounts: stored.accounts || [],
    groupCategories: stored.groupCategories || [],
    draft: stored.draft || null,
    dailyPostStats: stored.dailyPostStats || {},
    warmupConfig: stored.warmupConfig || null,
    rinMaps: stored.rinMaps || null,
    rinZalo: stored.rinZalo || null
  };
}

export async function applyRestoredData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Dữ liệu khôi phục không đúng định dạng.');
  }

  // 1. Kiểm tra trạng thái hiện tại của thiết bị này
  const currentLocal = await chrome.storage.local.get(['machineId', 'license']);
  const currentMid = currentLocal.machineId;
  const currentLicense = currentLocal.license;

  const toSet = {};
  let accCount = 0;
  let catCount = 0;

  // Trường hợp 1: data là 1 mảng tài khoản trực tiếp [...]
  if (Array.isArray(data)) {
    toSet.accounts = data;
    accCount = data.length;
  } else {
    // Trường hợp 2: data là gói object
    if (Array.isArray(data.accounts)) {
      toSet.accounts = data.accounts;
      accCount = data.accounts.length;
    }
    const cats = data.groupCategories || data.categories;
    if (Array.isArray(cats)) {
      toSet.groupCategories = cats;
      catCount = cats.length;
    }
    if (data.draft && typeof data.draft === 'object') {
      toSet.draft = data.draft;
    }
    if (data.dailyPostStats && typeof data.dailyPostStats === 'object') {
      toSet.dailyPostStats = data.dailyPostStats;
    }
    if (data.warmupConfig && typeof data.warmupConfig === 'object') {
      toSet.warmupConfig = data.warmupConfig;
    }
    if (data.rinMaps && typeof data.rinMaps === 'object') {
      toSet.rinMaps = data.rinMaps;
    }
    if (data.rinZalo && typeof data.rinZalo === 'object') {
      toSet.rinZalo = data.rinZalo;
    }

    // ── NGUYÊN TẮC BẢO TOÀN MÃ MÁY & BẢN QUYỀN ─────────────────────────────
    // Tuyệt đối KHÔNG ghi đè làm sai lệch mã máy của thiết bị hiện tại!
    if (currentLicense && currentLicense.username && currentLicense.expiry) {
      // Thiết bị hiện tại ĐÃ CÓ phiên đăng nhập bản quyền: Giữ nguyên 100%!
      // Không ghi đè license hay machineId từ bản cũ vào để tránh lỗi sai mã máy.
    } else {
      // Thiết bị hiện tại CHƯA ĐĂNG NHẬP:
      // Nếu file sao lưu cũ có chứa license chuẩn object (hệ thống mới):
      if (data.license && typeof data.license === 'object' && data.license.username && data.license.expiry) {
        // Đồng bộ license theo đúng mã máy thực tế của thiết bị hiện tại
        const activeMid = currentMid || data.machineId;
        toSet.license = {
          ...data.license,
          machineId: activeMid
        };
        if (!currentMid && data.machineId) {
          toSet.machineId = data.machineId;
        }
      }
      // Nếu data.license là dạng chuỗi cũ (key cũ) hoặc null -> Bỏ qua, để người dùng đăng nhập tài khoản chuẩn xác
    }
  }

  if (accCount === 0 && catCount === 0 && !toSet.draft && !toSet.accounts) {
    throw new Error('Gói dữ liệu không chứa tài khoản, danh mục nhóm hoặc nội dung nào.');
  }

  await chrome.storage.local.set(toSet);
  return {
    accCount,
    catCount,
    hasLicense: Boolean(currentLicense || toSet.license)
  };
}

// ── Cloud Sync Engine (Tải lên & Tải về 1-chạm qua Cloud) ──────────────────────
export async function uploadToCloud(encryptedText) {
  // Method 1: Bytebin (Tốc độ cao, máy chủ Singapore cực nhanh)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://bytebin.lucko.me/post', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: encryptedText,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const json = await res.json();
      if (json && json.key) {
        const syncKey = 'NTD-' + json.key;
        await chrome.storage.local.set({ lastSyncKey: syncKey, lastSyncTime: Date.now() });
        return { key: syncKey, provider: 'bytebin' };
      }
    }
  } catch (err) {
    console.warn('[Sync] Bytebin failed, trying dpaste fallback...', err);
  }

  // Method 2: dpaste.com (Dự phòng)
  try {
    const formData = new URLSearchParams();
    formData.append('content', encryptedText);
    formData.append('expiry_days', '30');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://dpaste.com/api/v2/', {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const url = (await res.text()).trim();
      const match = url.match(/dpaste\.com\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        const syncKey = 'DP-' + match[1];
        await chrome.storage.local.set({ lastSyncKey: syncKey, lastSyncTime: Date.now() });
        return { key: syncKey, provider: 'dpaste' };
      }
    }
  } catch (err) {
    console.warn('[Sync] dpaste fallback failed...', err);
  }

  throw new Error('Không thể kết nối đến máy chủ Cloud. Vui lòng kiểm tra lại kết nối mạng hoặc sử dụng tính năng "Sao chép mã Offline".');
}

export async function downloadFromCloud(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') throw new Error('Vui lòng nhập mã đồng bộ hợp lệ.');
  const clean = rawKey.trim();
  let encryptedText = null;

  if (clean.startsWith('DP-') || clean.includes('dpaste.com')) {
    const id = clean.replace(/^DP-/, '').replace(/https?:\/\/dpaste\.com\//, '').replace(/\.txt$/, '').trim();
    const res = await fetch(`https://dpaste.com/${id}.txt`);
    if (!res.ok) throw new Error('Không tìm thấy dữ liệu trên Cloud cho mã này (hoặc mã đã hết hạn).');
    encryptedText = await res.text();
  } else {
    const id = clean.replace(/^NTD-/, '').trim();
    const res = await fetch(`https://bytebin.lucko.me/${id}`);
    if (!res.ok) {
      // Thử dpaste dự phòng phòng khi người dùng gõ thiếu tiền tố DP-
      try {
        const dpRes = await fetch(`https://dpaste.com/${id}.txt`);
        if (dpRes.ok) encryptedText = await dpRes.text();
      } catch (_) {}
      if (!encryptedText) {
        throw new Error('Không tìm thấy dữ liệu cho mã đồng bộ này trên Cloud. Hãy kiểm tra lại mã hoặc bấm "Lưu dữ liệu" ở tiện ích cũ.');
      }
    } else {
      encryptedText = await res.text();
    }
  }

  const jsonStr = await decryptData(encryptedText);
  return JSON.parse(jsonStr);
}

// ── Offline Clipboard 1-Chạm (Không cần mạng) ──────────────────────────────────
export async function exportToClipboardToken() {
  const data = await collectAllData();
  const jsonStr = JSON.stringify(data);
  const encrypted = await encryptData(jsonStr);
  const token = 'NTD_SYNC::' + encrypted;
  await navigator.clipboard.writeText(token);
  return { token, data };
}

export async function importFromClipboardToken(input) {
  let text = input;
  if (!text) {
    text = await navigator.clipboard.readText();
  }
  if (!text || typeof text !== 'string') {
    throw new Error('Bộ nhớ tạm (Clipboard) trống hoặc không chứa mã hợp lệ.');
  }
  text = text.trim();
  let cipher = text;
  if (text.startsWith('NTD_SYNC::')) {
    cipher = text.replace('NTD_SYNC::', '');
  }
  const jsonStr = await decryptData(cipher);
  return JSON.parse(jsonStr);
}

// ── Export / Import file JSON truyền thống (Dự phòng) ──────────────────────────
export async function exportJsonBackup() {
  const data = await collectAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `ntd_agency_backup_${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return data;
}

export async function parseJsonFile(file) {
  const text = await file.text();
  try {
    const obj = JSON.parse(text);
    return obj;
  } catch (e) {
    // Có thể file chứa chuỗi mã hóa
    try {
      const decrypted = await decryptData(text.trim().replace(/^NTD_SYNC::/, ''));
      return JSON.parse(decrypted);
    } catch (_) {
      throw new Error('File không đúng định dạng JSON hoặc dữ liệu bị hỏng.');
    }
  }
}

// ── Cross-Extension Migration (Kết nối trực tiếp qua ID) ────────────────────────
export async function requestDataFromOtherExtension(extensionId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(extensionId.trim(), { action: 'GET_DATA_FOR_MIGRATION' }, (res) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message || 'Không thể kết nối đến Extension cũ.'));
      }
      if (res && res.success && res.data) {
        resolve(res.data);
      } else {
        reject(new Error(res?.error || 'Extension cũ không trả về dữ liệu.'));
      }
    });
  });
}

// ── Giao diện Hộp thoại Đồng bộ (Sync Modal UI Engine) ─────────────────────────
export function initSyncModal({ triggerBtnId, onRestoreSuccess, defaultTab = 'restore' } = {}) {
  // 1. Chèn CSS Modal nếu chưa có
  if (!document.getElementById('syncModalStyles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'syncModalStyles';
    styleEl.textContent = `
      .sync-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(15, 23, 42, 0.65);
        backdrop-filter: blur(5px);
        display: none; align-items: center; justify-content: center;
        z-index: 999999; padding: 16px;
        animation: syncFadeIn .2s ease-out;
      }
      @keyframes syncFadeIn { from { opacity: 0; } to { opacity: 1; } }
      .sync-dialog {
        background: #ffffff; width: 560px; max-width: 95vw;
        border-radius: 18px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
        overflow: hidden; display: flex; flex-direction: column;
        border: 1px solid #e2e8f0; font-family: inherit;
        animation: syncSlideUp .25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes syncSlideUp { from { transform: translateY(16px) scale(0.97); } to { transform: translateY(0) scale(1); } }
      .sync-header {
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        color: #fff; padding: 18px 22px; display: flex;
        align-items: center; justify-content: space-between;
      }
      .sync-header h3 { margin: 0; font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; color: #fff; }
      .sync-close-btn {
        background: transparent; border: none; color: #94a3b8;
        font-size: 20px; cursor: pointer; padding: 4px 8px;
        border-radius: 8px; line-height: 1; transition: all .15s;
      }
      .sync-close-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
      .sync-tabs {
        display: flex; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
        padding: 6px 12px 0; gap: 6px;
      }
      .sync-tab-btn {
        flex: 1; padding: 10px 14px; border: 1px solid transparent;
        border-bottom: none; border-radius: 10px 10px 0 0;
        background: transparent; font-size: 13px; font-weight: 700;
        color: #64748b; cursor: pointer; transition: all .15s;
        text-align: center;
      }
      .sync-tab-btn.active {
        background: #fff; color: #ea580c; border-color: #e2e8f0;
        box-shadow: 0 -2px 6px rgba(0,0,0,0.03);
      }
      .sync-body { padding: 22px; max-height: 75vh; overflow-y: auto; }
      .sync-card {
        background: #f8fafc; border: 1px solid #e2e8f0;
        border-radius: 12px; padding: 16px; margin-bottom: 16px;
      }
      .sync-card-title {
        font-size: 13.5px; font-weight: 700; color: #0f172a;
        margin: 0 0 8px; display: flex; align-items: center; gap: 6px;
      }
      .sync-card-desc {
        font-size: 12px; color: #64748b; margin: 0 0 12px; line-height: 1.5;
      }
      .sync-input-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
      .sync-input {
        flex: 1; padding: 10px 14px; border: 1.5px solid #cbd5e1;
        border-radius: 10px; font-size: 13.5px; font-weight: 600;
        font-family: inherit; color: #0f172a; outline: none; transition: all .15s;
      }
      .sync-input:focus { border-color: #ea580c; box-shadow: 0 0 0 3px rgba(234,88,12,0.15); }
      .sync-btn-primary {
        background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
        color: #fff; border: none; font-weight: 700; font-size: 13px;
        padding: 10px 18px; border-radius: 10px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        box-shadow: 0 2px 6px rgba(234,88,12,0.3); transition: all .15s; width: 100%;
      }
      .sync-btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(234,88,12,0.4); }
      .sync-btn-success {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: #fff; border: none; font-weight: 700; font-size: 13px;
        padding: 11px 18px; border-radius: 10px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        box-shadow: 0 2px 6px rgba(16,185,129,0.3); transition: all .15s; width: 100%;
      }
      .sync-btn-success:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.4); }
      .sync-btn-outline {
        background: #fff; color: #334155; border: 1px solid #cbd5e1;
        font-weight: 600; font-size: 12px; padding: 8px 14px;
        border-radius: 8px; cursor: pointer; display: inline-flex;
        align-items: center; justify-content: center; gap: 6px; transition: all .15s;
      }
      .sync-btn-outline:hover { background: #f1f5f9; border-color: #94a3b8; }
      .sync-stat-badge {
        display: inline-flex; align-items: center; gap: 5px;
        background: #e0f2fe; color: #0369a1; padding: 4px 10px;
        border-radius: 20px; font-size: 11.5px; font-weight: 700; margin-right: 6px; margin-bottom: 6px;
      }
      .sync-result-box {
        background: #ecfdf5; border: 1.5px solid #a7f3d0;
        border-radius: 12px; padding: 14px 16px; margin-top: 14px;
        display: none; animation: syncFadeIn .2s ease;
      }
      .sync-code-display {
        font-family: monospace; font-size: 17px; font-weight: 800;
        letter-spacing: 1px; color: #047857; background: #fff;
        padding: 8px 12px; border-radius: 8px; border: 1px dashed #34d399;
        display: inline-block; margin: 8px 0; user-select: all;
      }
      .sync-spinner {
        display: inline-block; width: 16px; height: 16px;
        border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
        border-radius: 50%; animation: syncSpin 0.8s linear infinite;
      }
      @keyframes syncSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(styleEl);
  }

  // 2. Chèn cấu trúc HTML Modal
  let overlay = document.getElementById('syncModalOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'syncModalOverlay';
  overlay.className = 'sync-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.65);backdrop-filter:blur(5px);display:none;align-items:center;justify-content:center;z-index:9999999;padding:16px;';
  overlay.innerHTML = `
      <div class="sync-dialog">
        <div class="sync-header">
          <h3><span>⚡</span> Đồng bộ &amp; Cập nhật dữ liệu cũ</h3>
          <button type="button" class="sync-close-btn" id="syncCloseBtn">✕</button>
        </div>

        <div class="sync-tabs">
          <button type="button" class="sync-tab-btn" id="syncTabRestoreBtn">📥 Cập nhật dữ liệu cũ (Bản mới)</button>
          <button type="button" class="sync-tab-btn" id="syncTabBackupBtn">☁️ Lưu dữ liệu lên Cloud (Bản cũ)</button>
        </div>

        <div class="sync-body">
          <!-- PANE 1: CẬP NHẬT DỮ LIỆU CŨ (RESTORE) -->
          <div id="syncPaneRestore">
            <!-- Cách 1: Chọn file JSON sao lưu -->
            <div class="sync-card" style="border-color:#38bdf8;background:#f0f9ff">
              <div class="sync-card-title" style="color:#0369a1">
                <span>📁</span> Cách 1: Chọn file JSON sao lưu từ máy tính (Đơn giản nhất)
              </div>
              <div class="sync-card-desc">
                Nếu bạn đã lưu file sao lưu (VD: <code>ntd_agency_backup_...json</code>) trên máy tính, bấm nút dưới để chọn file và nạp lại toàn bộ tài khoản, nhóm và cài đặt ngay lập tức.
              </div>
              <button type="button" class="sync-btn-success" id="syncPickJsonBtn" style="padding:12px;font-size:13.5px">
                <span>📁</span> Bấm vào đây để chọn file JSON sao lưu (.json)
              </button>
              <input type="file" id="syncModalFileInput" accept=".json,application/json" style="display:none">
            </div>

            <!-- Cách 2: Tải về từ Cloud -->
            <div class="sync-card">
              <div class="sync-card-title">
                <span>🚀</span> Cách 2: Tải về từ Cloud (Nếu đã lưu lên Đám Mây ở bản cũ)
              </div>
              <div class="sync-card-desc">
                Nhập hoặc dán <b>Mã đồng bộ</b> (VD: <code>NTD-XXXXX</code> hoặc <code>DP-XXXXX</code>) đã lấy từ tiện ích cũ:
              </div>
              
              <div class="sync-input-row">
                <input type="text" class="sync-input" id="syncInputCode" placeholder="Nhập hoặc dán mã đồng bộ vào đây...">
                <button type="button" class="sync-btn-outline" id="syncPasteClipboardBtn" title="Dán nhanh mã từ bộ nhớ tạm">📋 Dán mã</button>
              </div>

              <button type="button" class="sync-btn-primary" id="syncDoCloudRestoreBtn">
                <span>📥</span> Tải &amp; Khôi phục toàn bộ dữ liệu ngay (1-Chạm)
              </button>
              <div id="syncRestoreStatus" style="font-size:12px;margin-top:8px;font-weight:600;display:none"></div>
            </div>

            <!-- Cách 3: Nạp nhanh từ Clipboard -->
            <div class="sync-card">
              <div class="sync-card-title">
                <span>📋</span> Cách 3: Nạp nhanh từ Clipboard (Ngoại tuyến - Không cần mạng)
              </div>
              <div class="sync-card-desc">
                Nếu bạn đã bấm "Sao chép mã Offline" ở bản cũ, bấm nút dưới để nạp dữ liệu trực tiếp trong 0.1 giây.
              </div>
              <button type="button" class="sync-btn-outline" id="syncDoDirectClipboardBtn" style="width:100%;padding:10px;font-weight:700">
                📋 Dán dữ liệu từ Clipboard &amp; Khôi phục
              </button>
            </div>

            <!-- Cách 4: Kết nối trực tiếp Extension cũ -->
            <details style="margin-top:10px;font-size:12.5px;color:#64748b;cursor:pointer">
              <summary style="font-weight:600">⚙️ Cách 4: Lấy trực tiếp từ Extension cũ đang cài trên trình duyệt</summary>
              <div style="margin-top:10px;display:flex;gap:6px">
                <input type="text" class="sync-input" id="syncOtherExtId" placeholder="Nhập Extension ID bản cũ (nếu đang cài song song)..." style="font-size:12px;padding:6px 10px">
                <button type="button" class="sync-btn-outline" id="syncFromOtherExtBtn" style="white-space:nowrap">Kết nối trực tiếp</button>
              </div>
            </details>
          </div>

          <!-- PANE 2: LƯU DỮ LIỆU LÊN CLOUD (BACKUP) -->
          <div id="syncPaneBackup" style="display:none">
            <div class="sync-card">
              <div class="sync-card-title">
                <span>📦</span> Thống kê dữ liệu hiện tại trên tiện ích này
              </div>
              <div id="syncStatBadges" style="margin-bottom:12px">
                <span class="sync-stat-badge" id="syncStatAccs">0 tài khoản FB</span>
                <span class="sync-stat-badge" id="syncStatCats">0 danh mục nhóm</span>
                <span class="sync-stat-badge" id="syncStatLic">License: Đang kiểm tra</span>
              </div>

              <!-- Tùy chọn 1: Xuất file JSON -->
              <div style="margin-bottom:14px">
                <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:4px">
                  💾 Cách 1: Tải file JSON sao lưu về máy (Khuyên dùng)
                </div>
                <div style="font-size:12px;color:#64748b;margin-bottom:8px">
                  Lưu file sao lưu an toàn vào máy tính để đổi máy hoặc nạp vào bản mới bất kỳ lúc nào.
                </div>
                <button type="button" class="sync-btn-success" id="syncDownloadJsonBtn">
                  <span>📥</span> Tải file JSON sao lưu về máy ngay
                </button>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">

              <!-- Tùy chọn 2: Lưu lên Đám mây -->
              <div style="margin-bottom:14px">
                <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:4px">
                  ☁️ Cách 2: Lưu dữ liệu lên Đám Mây (Lấy mã 1-Chạm)
                </div>
                <div style="font-size:12px;color:#64748b;margin-bottom:8px">
                  Dữ liệu được <b>mã hóa an toàn bằng khóa bí mật AES-GCM</b> trước khi lưu lên Đám Mây. Chỉ tiện ích NTD Agency mới có thể giải mã.
                </div>
                <button type="button" class="sync-btn-primary" id="syncDoCloudBackupBtn">
                  <span>☁️</span> Lưu dữ liệu lên Đám Mây (Lấy mã 1-Chạm)
                </button>

                <div id="syncBackupResultBox" class="sync-result-box">
                  <div style="font-weight:700;color:#065f46;font-size:13.5px">
                    🎉 Đã lưu thành công lên Đám Mây!
                  </div>
                  <div style="font-size:12px;color:#047857;margin-top:4px">
                    Mã đồng bộ của bạn (đã tự động sao chép vào bộ nhớ tạm):
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="sync-code-display" id="syncGeneratedCode">NTD-XXXXX</span>
                    <button type="button" class="sync-btn-outline" id="syncCopyCodeBtn" style="border-color:#34d399;color:#065f46">📋 Sao chép lại</button>
                  </div>
                  <div style="font-size:12px;color:#047857;margin-top:6px;line-height:1.4">
                    👉 <b>Cách dùng:</b> Bạn mở bản tiện ích mới lên $\rightarrow$ bấm <b>"Cập nhật dữ liệu cũ"</b> $\rightarrow$ bấm <b>"Tải &amp; Khôi phục ngay"</b> là có lại đầy đủ mọi tài khoản và nhóm!
                  </div>
                </div>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">

              <!-- Tùy chọn 3: Copy Offline -->
              <div>
                <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:4px">
                  📋 Cách 3: Sao chép mã Offline vào Clipboard
                </div>
                <button type="button" class="sync-btn-outline" id="syncCopyOfflineTokenBtn" style="width:100%">
                  📋 Sao chép mã Offline vào bộ nhớ tạm
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

  // 3. Elements mapping
  const paneRestore = overlay.querySelector('#syncPaneRestore');
  const paneBackup = overlay.querySelector('#syncPaneBackup');
  const tabRestoreBtn = overlay.querySelector('#syncTabRestoreBtn');
  const tabBackupBtn = overlay.querySelector('#syncTabBackupBtn');
  const closeBtn = overlay.querySelector('#syncCloseBtn');
  const inputCode = overlay.querySelector('#syncInputCode');
  const pasteClipboardBtn = overlay.querySelector('#syncPasteClipboardBtn');
  const doCloudRestoreBtn = overlay.querySelector('#syncDoCloudRestoreBtn');
  const doDirectClipboardBtn = overlay.querySelector('#syncDoDirectClipboardBtn');
  const restoreStatus = overlay.querySelector('#syncRestoreStatus');
  const doCloudBackupBtn = overlay.querySelector('#syncDoCloudBackupBtn');
  const backupResultBox = overlay.querySelector('#syncBackupResultBox');
  const generatedCode = overlay.querySelector('#syncGeneratedCode');
  const copyCodeBtn = overlay.querySelector('#syncCopyCodeBtn');
  const copyOfflineTokenBtn = overlay.querySelector('#syncCopyOfflineTokenBtn');
  const downloadJsonBtn = overlay.querySelector('#syncDownloadJsonBtn');
  const pickJsonBtn = overlay.querySelector('#syncPickJsonBtn');
  const fileInput = overlay.querySelector('#syncModalFileInput');
  const otherExtId = overlay.querySelector('#syncOtherExtId');
  const fromOtherExtBtn = overlay.querySelector('#syncFromOtherExtBtn');

  // Switch Tab Helper
  function switchTab(tab) {
    if (tab === 'backup') {
      tabBackupBtn?.classList.add('active');
      tabRestoreBtn?.classList.remove('active');
      if (paneBackup) paneBackup.style.display = 'block';
      if (paneRestore) paneRestore.style.display = 'none';
      refreshStats();
    } else {
      tabRestoreBtn?.classList.add('active');
      tabBackupBtn?.classList.remove('active');
      if (paneRestore) paneRestore.style.display = 'block';
      if (paneBackup) paneBackup.style.display = 'none';
      autoDetectClipboardForRestore();
    }
  }

  async function refreshStats() {
    try {
      const data = await collectAllData();
      const accEl = overlay.querySelector('#syncStatAccs');
      if (accEl) accEl.textContent = `👤 ${data.accounts.length} tài khoản FB`;
      const catEl = overlay.querySelector('#syncStatCats');
      if (catEl) catEl.textContent = `📁 ${data.groupCategories.length} danh mục nhóm`;
      const licEl = overlay.querySelector('#syncStatLic');
      if (licEl) {
        if (data.license) {
          let user = 'Có bản quyền';
          if (typeof data.license === 'object') {
            user = data.license.username || (data.license.key ? data.license.key.split('|')[0] : 'Có bản quyền');
          } else if (typeof data.license === 'string') {
            user = data.license.split('|')[0] || 'Có bản quyền';
          }
          licEl.textContent = `🔑 License: ${user}`;
        } else {
          licEl.textContent = `🔑 License: Chưa có`;
        }
      }
    } catch (e) {
      console.warn('refreshStats error', e);
    }
  }

  // Tự động kiểm tra Clipboard hoặc mã gần nhất
  async function autoDetectClipboardForRestore() {
    try {
      // 1. Kiểm tra lastSyncKey đã lưu
      const stored = await chrome.storage.local.get('lastSyncKey');
      if (stored.lastSyncKey && !inputCode.value) {
        inputCode.value = stored.lastSyncKey;
      }
      // 2. Thử đọc Clipboard nếu được cấp quyền
      if (navigator.clipboard?.readText) {
        const clip = await navigator.clipboard.readText();
        if (clip) {
          const trimmed = clip.trim();
          if (trimmed.startsWith('NTD-') || trimmed.startsWith('DP-')) {
            inputCode.value = trimmed;
          }
        }
      }
    } catch (_) {}
  }

  // Mở & Đóng Modal
  function openModal(initialTab = defaultTab) {
    if (!overlay || !overlay.isConnected) {
      document.body.appendChild(overlay);
    }
    overlay.style.setProperty('display', 'flex', 'important');
    switchTab(initialTab || 'restore');
  }
  window.openSyncModal = openModal;

  function closeModal() {
    overlay.style.setProperty('display', 'none', 'important');
    if (restoreStatus) restoreStatus.style.display = 'none';
  }

  // Bind Switch tabs
  tabRestoreBtn?.addEventListener('click', () => switchTab('restore'));
  tabBackupBtn?.addEventListener('click', () => switchTab('backup'));
  closeBtn?.addEventListener('click', closeModal);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display === 'flex') closeModal();
  });

  // Bind Trigger Button
  if (triggerBtnId) {
    document.getElementById(triggerBtnId)?.addEventListener('click', (e) => {
      e?.preventDefault?.();
      openModal(defaultTab || 'restore');
    });
  }

  // ── Actions: RESTORE ────────────────────────────────────────────────────────
  pasteClipboardBtn?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return alert('Bộ nhớ tạm (Clipboard) đang trống.');
      inputCode.value = text.trim();
    } catch (err) {
      alert('Vui lòng cấp quyền truy cập Clipboard hoặc dán thủ công bằng Ctrl+V.');
    }
  });

  doCloudRestoreBtn?.addEventListener('click', async () => {
    const code = inputCode.value.trim();
    if (!code) {
      alert('Vui lòng nhập hoặc dán Mã đồng bộ từ bản cũ vào ô trên.');
      inputCode.focus();
      return;
    }

    doCloudRestoreBtn.disabled = true;
    const oldHtml = doCloudRestoreBtn.innerHTML;
    doCloudRestoreBtn.innerHTML = '<span class="sync-spinner"></span> Đang tải & giải mã dữ liệu từ Cloud...';

    try {
      let data = null;
      if (code.startsWith('NTD_SYNC::')) {
        data = await importFromClipboardToken(code);
      } else {
        data = await downloadFromCloud(code);
      }

      const res = await applyRestoredData(data);
      const licMsg = res.hasLicense
        ? '\n• Bản quyền & Mã máy thiết bị được bảo toàn an toàn 100%'
        : '\n👉 Hãy đăng nhập tài khoản của bạn để vào Bảng điều khiển.';
      alert(`🎉 Cập nhật dữ liệu thành công!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm${licMsg}\n\nTiện ích sẽ tự động tải lại ngay bây giờ.`);
      closeModal();
      if (onRestoreSuccess) onRestoreSuccess();
      else window.location.reload();
    } catch (err) {
      alert('❌ Lỗi nạp dữ liệu: ' + err.message);
    } finally {
      doCloudRestoreBtn.disabled = false;
      doCloudRestoreBtn.innerHTML = oldHtml;
    }
  });

  doDirectClipboardBtn?.addEventListener('click', async () => {
    try {
      const data = await importFromClipboardToken();
      const res = await applyRestoredData(data);
      const licMsg = res.hasLicense
        ? '\n• Bản quyền & Mã máy thiết bị được bảo toàn an toàn 100%'
        : '\n👉 Hãy đăng nhập tài khoản của bạn để vào Bảng điều khiển.';
      alert(`🎉 Khôi phục dữ liệu từ Clipboard thành công!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm.${licMsg}\n\nTiện ích sẽ tự động tải lại ngay bây giờ.`);
      closeModal();
      if (onRestoreSuccess) onRestoreSuccess();
      else window.location.reload();
    } catch (err) {
      alert('❌ Lỗi: ' + err.message + '\n\nHãy đảm bảo bạn đã bấm "Sao chép mã Offline" ở bản cũ trước khi thực hiện.');
    }
  });

  pickJsonBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await parseJsonFile(file);
      const res = await applyRestoredData(data);
      const licMsg = res.hasLicense
        ? '\n• Bản quyền & Mã máy thiết bị được bảo toàn an toàn 100%'
        : '\n👉 Hãy đăng nhập tài khoản của bạn để vào Bảng điều khiển.';
      alert(`🎉 Khôi phục thành công từ file JSON!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm.${licMsg}\n\nTiện ích sẽ tự động tải lại.`);
      closeModal();
      if (onRestoreSuccess) onRestoreSuccess();
      else window.location.reload();
    } catch (err) {
      alert('❌ Lỗi khi đọc file sao lưu: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  fromOtherExtBtn?.addEventListener('click', async () => {
    const id = otherExtId?.value?.trim();
    if (!id) return alert('Vui lòng nhập Extension ID của tiện ích cũ.');
    try {
      const data = await requestDataFromOtherExtension(id);
      const res = await applyRestoredData(data);
      alert(`🎉 Đã lấy dữ liệu trực tiếp thành công!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm.`);
      closeModal();
      if (onRestoreSuccess) onRestoreSuccess();
      else window.location.reload();
    } catch (err) {
      alert('❌ Không kết nối được: ' + err.message);
    }
  });

  // ── Actions: BACKUP ─────────────────────────────────────────────────────────
  doCloudBackupBtn?.addEventListener('click', async () => {
    doCloudBackupBtn.disabled = true;
    const oldHtml = doCloudBackupBtn.innerHTML;
    doCloudBackupBtn.innerHTML = '<span class="sync-spinner"></span> Đang đóng gói, mã hóa & lưu lên Cloud...';

    try {
      const data = await collectAllData();
      if (data.accounts.length === 0 && data.groupCategories.length === 0) {
        if (!confirm('Tiện ích hiện chưa có tài khoản hoặc nhóm nào. Bạn có chắc chắn vẫn muốn lưu bản sao này lên Cloud?')) {
          doCloudBackupBtn.disabled = false;
          doCloudBackupBtn.innerHTML = oldHtml;
          return;
        }
      }

      const jsonStr = JSON.stringify(data);
      const encrypted = await encryptData(jsonStr);
      const result = await uploadToCloud(encrypted);

      if (generatedCode) generatedCode.textContent = result.key;
      if (backupResultBox) backupResultBox.style.display = 'block';

      // Tự động copy vào clipboard
      try {
        await navigator.clipboard.writeText(result.key);
      } catch (_) {}

      // Đồng thời lưu vào storage
      await chrome.storage.local.set({ lastSyncKey: result.key });

    } catch (err) {
      alert('❌ Lỗi lưu dữ liệu: ' + err.message);
    } finally {
      doCloudBackupBtn.disabled = false;
      doCloudBackupBtn.innerHTML = oldHtml;
    }
  });

  copyCodeBtn?.addEventListener('click', async () => {
    const code = generatedCode?.textContent?.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      alert('✅ Đã sao chép mã đồng bộ: ' + code);
    } catch (_) {
      alert('Vui lòng bôi đen và sao chép mã: ' + code);
    }
  });

  copyOfflineTokenBtn?.addEventListener('click', async () => {
    try {
      const { token, data } = await exportToClipboardToken();
      alert(`✅ Đã sao chép toàn bộ dữ liệu Offline vào bộ nhớ tạm (${data.accounts.length} nick, ${data.groupCategories.length} nhóm)!\n\n👉 Bạn hãy mở bản tiện ích mới lên và bấm "Dán dữ liệu từ Clipboard" là xong ngay.`);
    } catch (err) {
      alert('❌ Lỗi: ' + err.message);
    }
  });

  downloadJsonBtn?.addEventListener('click', async () => {
    try {
      const data = await exportJsonBackup();
      alert(`✅ Đã tải file JSON về máy (${data.accounts.length} tài khoản, ${data.groupCategories.length} nhóm)!`);
    } catch (err) {
      alert('❌ Lỗi tải file: ' + err.message);
    }
  });

  return {
    open: openModal,
    close: closeModal,
    switchTab
  };
}
