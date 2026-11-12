// ─── license.js - NTD Agency Account & License Management ────────────────────
// Quản lý xác thực tài khoản (Username + Password) và thời hạn bản quyền qua Supabase & Google Sheets
import { isSupabaseConfigured, supabaseLogin, supabaseCheckLicense } from './supabase.js?v=20261112_1000';

// SECRET giữ nguyên để tương thích giải mã sync_helper.js
export const SECRET = 'DuyPosterHmac@2025#ChangeThisSecret!';

// URL Google Apps Script Web App mặc định
export const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyifsMdaPU67IZBWQlCzYd94Ds4oRtWE2w_TRdlNZMsmYvE0gGmZv2bC2mhuYNKzkKH/exec';

const enc = new TextEncoder();

function _toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── 1. Quản lý URL Google Apps Script ─────────────────────────────────────────
/**
 * Lấy URL Google Apps Script Web App đã cấu hình
 * @returns {Promise<string>}
 */
export async function getGoogleScriptUrl() {
  try {
    const data = await chrome.storage.local.get('googleScriptUrl');
    if (data.googleScriptUrl && typeof data.googleScriptUrl === 'string' && data.googleScriptUrl.trim().startsWith('https://script.google.com/')) {
      return data.googleScriptUrl.trim();
    }
    if (DEFAULT_SCRIPT_URL) {
      await chrome.storage.local.set({ googleScriptUrl: DEFAULT_SCRIPT_URL });
    }
    return DEFAULT_SCRIPT_URL;
  } catch (e) {
    return DEFAULT_SCRIPT_URL;
  }
}

/**
 * Cập nhật URL Google Apps Script Web App
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function setGoogleScriptUrl(url) {
  const cleanUrl = (url || '').trim();
  await chrome.storage.local.set({ googleScriptUrl: cleanUrl });
  return cleanUrl;
}

// ── 2. Persistent Machine ID ──────────────────────────────────────────────────
/**
 * Tạo Mã máy định danh phần cứng (Hardware Fingerprint) ổn định
 * Dựa trên cấu hình phần cứng tĩnh của máy tính (CPU, Platform, Timezone, RAM...)
 * Loại bỏ các thông số động dễ thay đổi như độ phân giải màn hình hoặc chuyển card GPU.
 */
export async function generateDeviceFingerprint() {
  const parts = [];

  try {
    parts.push(navigator.platform || '');
    parts.push(String(navigator.hardwareConcurrency || 4));
    parts.push(String(navigator.deviceMemory || 8));
    parts.push(navigator.language || '');
    try {
      parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    } catch (_) {}

    // Canvas Fingerprint tĩnh cơ bản (không phụ thuộc resize hay zoom)
    if (typeof document !== 'undefined') {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 40;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(50, 5, 60, 20);
          ctx.fillStyle = '#069';
          ctx.fillText('NTD_Static_ID_v2', 2, 10);
          parts.push(canvas.toDataURL());
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Bổ sung seed ngẫu nhiên nếu hệ thống không lấy được đặc trưng phần cứng
  if (parts.length === 0) {
    parts.push(String(Date.now()));
  }

  const rawStr = parts.join('|||');
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(rawStr));
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lấy hoặc tạo Mã máy lưu cố định đa tầng (chrome.storage.local, sync, localStorage)
 * Tuyệt đối không thay đổi mã máy khi người dùng update bản mới hoặc cắm rút màn hình.
 * @returns {Promise<string>}
 */
export async function getMachineId() {
  try {
    // 1. Kiểm tra trong chrome.storage.local
    const stored = await chrome.storage.local.get(['machineId', 'license']);
    if (stored.machineId && typeof stored.machineId === 'string' && stored.machineId.trim().length >= 8) {
      const mid = stored.machineId.trim();
      try { localStorage.setItem('dg_machine_id', mid); } catch (_) {}
      try { await chrome.storage.sync?.set({ machineId: mid }); } catch (_) {}
      return mid;
    }

    // 2. Nếu đã từng có phiên bản quyền (license), lấy mã máy trong license làm chuẩn
    if (stored.license?.machineId && typeof stored.license.machineId === 'string' && stored.license.machineId.trim().length >= 8) {
      const mid = stored.license.machineId.trim();
      await chrome.storage.local.set({ machineId: mid });
      try { localStorage.setItem('dg_machine_id', mid); } catch (_) {}
      try { await chrome.storage.sync?.set({ machineId: mid }); } catch (_) {}
      return mid;
    }

    // 3. Kiểm tra chrome.storage.sync (đồng bộ giữa các lần cập nhật profile Chrome)
    try {
      const syncData = await chrome.storage.sync?.get('machineId');
      if (syncData?.machineId && typeof syncData.machineId === 'string' && syncData.machineId.trim().length >= 8) {
        const mid = syncData.machineId.trim();
        await chrome.storage.local.set({ machineId: mid });
        try { localStorage.setItem('dg_machine_id', mid); } catch (_) {}
        return mid;
      }
    } catch (_) {}

    // 4. Kiểm tra localStorage (bảo lưu dữ liệu web)
    try {
      const lsMid = localStorage.getItem('dg_machine_id');
      if (lsMid && typeof lsMid === 'string' && lsMid.trim().length >= 8) {
        const mid = lsMid.trim();
        await chrome.storage.local.set({ machineId: mid });
        try { await chrome.storage.sync?.set({ machineId: mid }); } catch (_) {}
        return mid;
      }
    } catch (_) {}

    // 5. Nếu hoàn toàn mới (lần đầu cài): Tạo fingerprint ổn định
    let id = await generateDeviceFingerprint().catch(() => '');
    if (!id || id.length < 16) {
      id = _toHex(crypto.getRandomValues(new Uint8Array(16)));
    }

    // Lưu vào cả 3 nơi để không bao giờ bị mất mã máy
    await chrome.storage.local.set({ machineId: id });
    try { await chrome.storage.sync?.set({ machineId: id }); } catch (_) {}
    try { localStorage.setItem('dg_machine_id', id); } catch (_) {}
    return id;
  } catch (e) {
    let id = '';
    try { id = typeof localStorage !== 'undefined' ? (localStorage.getItem('dg_machine_id') || '') : ''; } catch (_) {}
    if (!id || id.length < 8) {
      id = _toHex(crypto.getRandomValues(new Uint8Array(16)));
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('dg_machine_id', id); } catch (_) {}
    }
    return id;
  }
}

/**
 * Tự đặt mã máy tùy chỉnh (dành cho trường hợp cập nhật bản mới muốn dùng mã máy cũ)
 * @param {string} customId
 * @returns {Promise<string>}
 */
export async function setCustomMachineId(customId) {
  const clean = (customId || '').trim();
  if (clean.length < 8) {
    throw new Error('Mã máy quá ngắn, vui lòng kiểm tra lại.');
  }
  await chrome.storage.local.set({ machineId: clean });
  try { await chrome.storage.sync?.set({ machineId: clean }); } catch (_) {}
  try { localStorage.setItem('dg_machine_id', clean); } catch (_) {}

  // Nếu đã có license, cập nhật luôn machineId trong license để đồng bộ
  try {
    const { license } = await chrome.storage.local.get('license');
    if (license && typeof license === 'object') {
      license.machineId = clean;
      await chrome.storage.local.set({ license });
    }
  } catch (_) {}

  return clean;
}

/**
 * Reset mã máy trên Google Sheets (Dành cho Quản trị viên xử lý ngay tại trang đăng nhập)
 * @param {string} username
 * @param {string} adminPass
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
export async function resetMachineIdForAccount(username, adminPass = 'DuyAdmin@2025') {
  const u = (username || '').trim();
  if (!u) return { ok: false, error: 'Chưa nhập Tên tài khoản.' };

  const scriptUrl = await getGoogleScriptUrl();
  if (!scriptUrl || scriptUrl.length < 10) {
    return { ok: false, error: 'Chưa cấu hình URL Google Sheets.' };
  }

  try {
    const targetUrl = new URL(scriptUrl);
    targetUrl.searchParams.set('action', 'reset_machine');
    targetUrl.searchParams.set('admin_pass', adminPass || 'DuyAdmin@2025');
    targetUrl.searchParams.set('username', u);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: 'Không thể kết nối đến Google Sheets: ' + (err.message || String(err)) };
  }
}

// ── 3. Đăng nhập bằng Tài khoản & Mật khẩu ────────────────────────────────────
/**
 * Đăng nhập vào hệ thống qua Google Sheets API
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok: boolean, data?: object, error?: string, expired?: boolean, lockedToOtherMachine?: boolean, sheetMid?: string, notConfigured?: boolean}>}
 */
export async function loginWithAccount(username, password) {
  const u = (username || '').trim();
  const p = (password || '').trim();

  if (!u) return { ok: false, error: 'Vui lòng nhập Tên tài khoản.' };
  if (!p) return { ok: false, error: 'Vui lòng nhập Mật khẩu.' };

  const machineId = await getMachineId();

  // 1. Thử đăng nhập qua cơ sở dữ liệu Supabase trước (nếu đã cấu hình)
  if (await isSupabaseConfigured()) {
    try {
      const sbRes = await supabaseLogin(u, p, machineId);
      if (sbRes.ok) {
        const licenseData = {
          username: sbRes.data.username,
          role: sbRes.data.role || 'member',
          expiry: sbRes.data.expiry,
          expiryFormatted: sbRes.data.expiryFormatted,
          machineId: machineId,
          source: 'supabase',
          lastChecked: Date.now()
        };
        await chrome.storage.local.set({ license: licenseData, machineId: machineId });
        try { localStorage.setItem('dg_machine_id', machineId); } catch (_) {}
        try { await chrome.storage.sync?.set({ machineId: machineId }); } catch (_) {}
        return { ok: true, data: licenseData };
      } else if (sbRes.locked || sbRes.expired) {
        return sbRes;
      }
    } catch (sbErr) {
      console.warn('Đăng nhập Supabase không khớp, chuyển kiểm tra Google Sheets:', sbErr.message);
    }
  }

  // 2. Dự phòng: Kiểm tra qua Google Sheets API
  const scriptUrl = await getGoogleScriptUrl();
  if (!scriptUrl || scriptUrl.length < 10) {
    return {
      ok: false,
      notConfigured: true,
      error: '⚠️ Chưa cấu hình Cơ sở dữ liệu Supabase hoặc Google Sheets kết nối máy chủ.\nQuản trị viên vui lòng cấu hình trong trang Quản lý.'
    };
  }

  try {
    const targetUrl = new URL(scriptUrl);
    targetUrl.searchParams.set('action', 'login');
    targetUrl.searchParams.set('username', u);
    targetUrl.searchParams.set('password', p);
    targetUrl.searchParams.set('machineId', machineId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

    const res = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { ok: false, error: `Máy chủ Google Sheets phản hồi mã HTTP ${res.status}. Vui lòng kiểm tra lại đường link triển khai.` };
    }

    const data = await res.json();
    if (!data || !data.ok) {
      return {
        ok: false,
        error: data?.error || 'Đăng nhập không thành công. Vui lòng kiểm tra lại.',
        expired: !!data?.expired,
        lockedToOtherMachine: !!data?.lockedToOtherMachine,
        sheetMid: data?.sheetMid || ''
      };
    }

    // Xác định vai trò: Nếu username là admin/admin_test hoặc data có role admin
    const userRole = (data.role || (['admin', 'admin_test'].includes(u.toLowerCase()) ? 'admin' : 'member')).toLowerCase();

    // Đăng nhập thành công -> Lưu thông tin phiên đăng nhập vào chrome.storage.local
    const expiryDate = new Date(data.expiry);
    const licenseData = {
      username: data.username || u,
      role: userRole,
      expiry: expiryDate.toISOString(),
      expiryFormatted: data.expiryFormatted || expiryDate.toLocaleDateString('vi-VN'),
      machineId: machineId,
      token: data.token || '',
      source: 'sheets',
      lastChecked: Date.now()
    };

    await chrome.storage.local.set({ license: licenseData, machineId: machineId });
    try { localStorage.setItem('dg_machine_id', machineId); } catch (_) {}
    try { await chrome.storage.sync?.set({ machineId: machineId }); } catch (_) {}
    return { ok: true, data: licenseData };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Hết thời gian kết nối (Timeout). Vui lòng kiểm tra lại đường truyền mạng Internet.' };
    }
    return { ok: false, error: 'Lỗi kết nối tới cơ sở dữ liệu: ' + (err.message || String(err)) };
  }
}

// ── 4. Kiểm tra license hiện tại ──────────────────────────────────────────────
let _inFlightOnlineCheck = null;

async function performOnlineLicenseSync(license, scriptUrl) {
  if (_inFlightOnlineCheck) return _inFlightOnlineCheck;

  _inFlightOnlineCheck = (async () => {
    try {
      const checkUrl = new URL(scriptUrl);
      checkUrl.searchParams.set('action', 'check');
      checkUrl.searchParams.set('username', license.username);
      checkUrl.searchParams.set('_t', String(Date.now())); // Chống HTTP cache của trình duyệt

      const c = new AbortController();
      const tid = setTimeout(() => c.abort(), 12000); // 12s timeout an toàn
      const res = await fetch(checkUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
        signal: c.signal
      });
      clearTimeout(tid);

      if (res.ok) {
        const resData = await res.json();
        if (resData && resData.ok) {
          // Cập nhật lại hạn dùng mới nếu Admin đã gia hạn trên Google Sheets
          if (resData.expiry) {
            license.expiry = new Date(resData.expiry).toISOString();
            license.expiryFormatted = resData.expiryFormatted || new Date(resData.expiry).toLocaleDateString('vi-VN');
          }
          license.lastChecked = Date.now();
          await chrome.storage.local.set({ license: { ...license } });
          return { ok: true, license };
        } else if (resData && !resData.ok) {
          // CHỈ đăng xuất nếu Admin chủ động KHÓA hoặc tài khoản đã hết hạn trên server
          if (resData.locked || resData.expired || (resData.error && resData.error.toLowerCase().includes('khóa'))) {
            console.warn('Tài khoản bị khóa hoặc hết hạn trên Google Sheets:', resData.error);
            await chrome.storage.local.remove('license');
            return { ok: false, locked: true };
          }
          console.warn('Kiểm tra ngầm ghi nhận:', resData.error);
        }
      }
    } catch (e) {
      console.warn('Lỗi kiểm tra online ngầm (tạm dùng cache):', e.message);
    } finally {
      _inFlightOnlineCheck = null;
    }
    return { ok: false, license };
  })();

  return _inFlightOnlineCheck;
}

/**
 * Kiểm tra trạng thái bản quyền hiện tại của extension trong chrome.storage.local.
 * Tự động đồng bộ kiểm tra với Google Sheets định kỳ.
 * @param {boolean} [forceOnline=false]
 * @returns {Promise<{username:string, expiry:Date, expiryFormatted:string, machineId:string, daysLeft:number}|null>}
 */
export async function checkCurrentLicense(forceOnline = false) {
  try {
    const { license } = await chrome.storage.local.get('license');
    if (!license || !license.username || !license.expiry) return null;

    let machineId = await getMachineId();

    // 1. Kiểm tra mã máy:
    // NẾU license đã có machineId và khác với machineId hiện tại:
    // TUYỆT ĐỐI KHÔNG XÓA license! Tự động đồng bộ machineId theo license để bảo vệ phiên làm việc của khách!
    if (license.machineId) {
      if (license.machineId.toLowerCase() !== machineId.toLowerCase()) {
        console.warn('Đồng bộ lại machineId theo license hiện tại:', license.machineId);
        await chrome.storage.local.set({ machineId: license.machineId });
        try { localStorage.setItem('dg_machine_id', license.machineId); } catch (_) {}
        try { await chrome.storage.sync?.set({ machineId: license.machineId }); } catch (_) {}
        machineId = license.machineId;
      }
    } else {
      // Nếu license cũ chưa có machineId, tự động bổ sung
      license.machineId = machineId;
      await chrome.storage.local.set({ license });
    }

    // 2. Kiểm tra hạn dùng lưu cục bộ
    const expiryDate = new Date(license.expiry);
    if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
      return null; // Hết hạn
    }

    // Tính số ngày còn lại theo cache hiện tại
    const currentDaysLeft = Math.ceil((expiryDate - new Date()) / 86400000);
    // Chu kỳ kiểm tra tự động định kỳ: 30 giây (nếu sắp hết hạn <= 5 ngày) hoặc 2 phút (bình thường)
    // để khách hàng luôn nhận được ngày gia hạn mới từ Admin một cách hoàn toàn tự động
    const cacheInterval = (currentDaysLeft <= 5) ? 30 * 1000 : 2 * 60 * 1000;

    // 3. Kiểm tra đồng bộ trực tuyến với Supabase hoặc Google Sheets
    let onlineChecked = false;
    const shouldCheck = forceOnline || (Date.now() - (license.lastChecked || 0) > cacheInterval);

    if (shouldCheck && await isSupabaseConfigured()) {
      try {
        const sbInfo = await supabaseCheckLicense(license.username);
        if (sbInfo) {
          if (sbInfo.isLocked || sbInfo.isExpired) {
            await chrome.storage.local.remove('license');
            return null;
          }
          license.role = sbInfo.role;
          license.expiry = sbInfo.expiry;
          license.expiryFormatted = sbInfo.expiryFormatted;
          license.lastChecked = Date.now();
          await chrome.storage.local.set({ license: { ...license } });
          onlineChecked = true;
        }
      } catch (sbErr) {
        console.warn('Lỗi kiểm tra ngầm Supabase:', sbErr.message);
      }
    } else if (shouldCheck) {
      const scriptUrl = await getGoogleScriptUrl();
      if (scriptUrl && scriptUrl.length > 10) {
        if (forceOnline) {
          const syncRes = await performOnlineLicenseSync(license, scriptUrl);
          if (syncRes?.locked) return null;
          onlineChecked = syncRes?.ok || false;
        } else {
          performOnlineLicenseSync(license, scriptUrl).catch(() => {});
        }
      }
    }

    const currentExpiry = new Date(license.expiry);
    if (currentExpiry < new Date()) return null;

    // Xác định vai trò: kiểm tra role từ Supabase hoặc nhận diện các tài khoản admin chính thức
    const usernameLower = (license.username || '').toLowerCase();
    const isKnownAdmin = ['admin', 'admin_test'].includes(usernameLower) || usernameLower.startsWith('nguyentrucduy');
    const userRole = (license.role || (isKnownAdmin ? 'admin' : 'member')).toLowerCase();

    return {
      username: license.username,
      role: userRole,
      expiry: currentExpiry,
      expiryFormatted: license.expiryFormatted || currentExpiry.toLocaleDateString('vi-VN'),
      machineId: machineId,
      daysLeft: Math.ceil((currentExpiry - new Date()) / 86400000),
      onlineChecked
    };
  } catch (err) {
    console.warn('Lỗi kiểm tra license:', err);
    return null;
  }
}

/**
 * Kiểm tra xem tài khoản hiện tại có phải Quản trị viên (Admin) không
 * @returns {Promise<boolean>}
 */
export async function isCurrentUserAdmin() {
  try {
    const info = await checkCurrentLicense();
    return info?.role === 'admin';
  } catch (_) {
    return false;
  }
}

/**
 * Lấy vai trò của tài khoản hiện tại ('admin' | 'member')
 * @returns {Promise<string>}
 */
export async function getCurrentUserRole() {
  try {
    const info = await checkCurrentLicense();
    return info?.role || 'member';
  } catch (_) {
    return 'member';
  }
}

// ── 5. Đăng xuất tài khoản ───────────────────────────────────────────────────
/**
 * Đăng xuất tài khoản khỏi máy này
 * @returns {Promise<boolean>}
 */
export async function logoutAccount() {
  try {
    await chrome.storage.local.remove('license');
    return true;
  } catch (e) {
    return false;
  }
}

// ── 6. Chặn các trang nếu chưa kích hoạt ──────────────────────────────────────
/**
 * Bắt buộc kiểm tra bản quyền trước khi cho phép xem trang chức năng.
 * Nếu chưa đăng nhập hoặc hết hạn: ẩn trang và chuyển hướng ngay về activate.html.
 * @returns {Promise<{username:string, expiry:Date, machineId:string}|null>}
 */
export async function enforceLicenseGate() {
  const info = await checkCurrentLicense();
  if (!info) {
    if (typeof document !== 'undefined') {
      try {
        if (document.documentElement) document.documentElement.style.display = 'none';
      } catch (e) {}
      window.location.replace(chrome.runtime.getURL('activate.html'));
    }
    return null;
  }
  return info;
}

// ── 7. Giữ lại các hàm cũ để không làm lỗi import từ module khác ──────────────
export async function generateKey(username, expiry, machineId) {
  return `${username}|${expiry}|${machineId}|LEGACY_STUB`;
}

export async function validateKey(key, currentMachineId) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.trim().split('|');
  if (parts.length >= 3) {
    return {
      username: parts[0],
      expiry: new Date(Date.now() + 30 * 86400000),
      machineId: currentMachineId
    };
  }
  return null;
}
