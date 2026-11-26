/**
 * NTD Agency - Supabase Database Client & RBAC (supabase.js)
 * Quản lý kết nối cơ sở dữ liệu Supabase, phân quyền Admin/Member và xác thực người dùng.
 */

import { sanitizeScheduledJobsForCloud } from './post_schedule_helper.js';

// Key lưu trữ cấu hình trong chrome.storage.local
export const STORAGE_SUPABASE_URL = 'ntd_supabase_url';
export const STORAGE_SUPABASE_KEY = 'ntd_supabase_key';

// URL dự án mẫu cũ (tự động nâng cấp nếu thiết bị vẫn đang cache cấu hình mặc định cũ)
const LEGACY_DEFAULT_SUPABASE_URL = 'https://jwketbnfapscggpvnbui.supabase.co';
const LEGACY_DEFAULT_SUPABASE_KEY = 'sb_publishable_HK-WyUKi4lK9RBJvSrf4Kg_i920nRCv';

// Cấu hình mặc định mới (Project: website-duy)
export const DEFAULT_SUPABASE_URL = 'https://textwlxfxksdtnbzzzok.supabase.co';
export const DEFAULT_SUPABASE_KEY = 'sb_publishable_r6WLubmJTN-dRmSvAMQZ3Q_RW02M_WE';

/**
 * Tạo headers chuẩn cho Supabase Data API:
 * - Luôn gửi `apikey`
 * - Chỉ gắn `Authorization: Bearer ...` cho legacy JWT key (`eyJ...`), tránh lỗi parse JWT với `sb_publishable_...`
 */
export function buildSupabaseHeaders(apiKey, extra = {}) {
  const cleanKey = String(apiKey || '').trim();
  const headers = {
    'apikey': cleanKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...extra
  };
  if (cleanKey.startsWith('eyJ')) {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }
  return headers;
}

/**
 * Lấy cấu hình Supabase hiện tại
 */
export async function getSupabaseConfig() {
  try {
    const res = await chrome.storage.local.get([STORAGE_SUPABASE_URL, STORAGE_SUPABASE_KEY]);
    const storedUrl = (res[STORAGE_SUPABASE_URL] || '').trim().replace(/\/+$/, '');
    const storedKey = (res[STORAGE_SUPABASE_KEY] || '').trim();

    const isEmptyOrLegacy = !storedUrl || storedUrl === LEGACY_DEFAULT_SUPABASE_URL || storedKey === LEGACY_DEFAULT_SUPABASE_KEY;
    const url = isEmptyOrLegacy ? DEFAULT_SUPABASE_URL : storedUrl;
    const key = isEmptyOrLegacy ? DEFAULT_SUPABASE_KEY : (storedKey || DEFAULT_SUPABASE_KEY);

    // Tự động lưu / nâng cấp lên giá trị mặc định mới vào storage
    if (isEmptyOrLegacy && DEFAULT_SUPABASE_URL) {
      await chrome.storage.local.set({
        [STORAGE_SUPABASE_URL]: url,
        [STORAGE_SUPABASE_KEY]: key
      });
    }
    return { url, key };
  } catch (_) {
    return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY };
  }
}

/**
 * Lưu cấu hình Supabase
 */
export async function setSupabaseConfig(url, key) {
  const cleanUrl = (url || '').trim().replace(/\/+$/, '');
  const cleanKey = (key || '').trim();
  await chrome.storage.local.set({
    [STORAGE_SUPABASE_URL]: cleanUrl,
    [STORAGE_SUPABASE_KEY]: cleanKey
  });
  return { url: cleanUrl, key: cleanKey };
}

/**
 * Kiểm tra xem Supabase đã được cấu hình hay chưa
 */
export async function isSupabaseConfigured() {
  const cfg = await getSupabaseConfig();
  return Boolean(cfg.url && cfg.key && cfg.url.startsWith('http'));
}

/**
 * Helper thực hiện REST request tới Supabase
 */
async function supabaseRequest(endpoint, options = {}) {
  const cfg = await getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    throw new Error('Chưa cấu hình Supabase URL hoặc API Key.');
  }

  const url = `${cfg.url}/rest/v1/${endpoint.replace(/^\/+/, '')}`;
  const headers = buildSupabaseHeaders(cfg.key, options.headers || {});

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const fetchOpts = {
      ...options,
      headers,
      signal: controller.signal
    };
    if (options.keepalive) fetchOpts.keepalive = true;
    const res = await fetch(url, fetchOpts);
    clearTimeout(timeoutId);

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    if (!res.ok) {
      const errMsg = (data && typeof data === 'object' && (data.message || data.error || data.hint)) || `HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.code = data && typeof data === 'object' ? data.code : '';
      throw err;
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Hết thời gian kết nối tới Supabase (Timeout).');
    throw err;
  }
}

async function probeSupabaseTable(cleanUrl, cleanKey, tableName) {
  const res = await fetch(`${cleanUrl}/rest/v1/${tableName}?select=id&limit=1`, {
    method: 'GET',
    headers: buildSupabaseHeaders(cleanKey, { 'Range': '0-0' })
  });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Kiểm tra kết nối tới Supabase và trạng thái 4 bảng đồng bộ
 */
export async function testSupabaseConnection(url, key) {
  try {
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    const cleanKey = (key || '').trim();

    if (!cleanUrl || !cleanKey) {
      return { ok: false, error: 'Vui lòng nhập đầy đủ Supabase URL và Publishable/Anon Key.' };
    }

    const coreProbe = await probeSupabaseTable(cleanUrl, cleanKey, 'ntd_users');
    if (coreProbe.status === 200 || coreProbe.status === 206) {
      const syncTables = ['ntd_workspaces', 'ntd_scanned_phones', 'ntd_scanned_groups'];
      const probes = await Promise.all(syncTables.map(t => probeSupabaseTable(cleanUrl, cleanKey, t).then(r => ({ table: t, ok: r.status === 200 || r.status === 206 }))));
      const missingSync = probes.filter(p => !p.ok).map(p => p.table);
      if (missingSync.length > 0) {
        return {
          ok: true,
          needSyncTables: true,
          missingTables: missingSync,
          message: `Đã nối bảng ntd_users! Còn thiếu ${missingSync.length} bảng đồng bộ (${missingSync.join(', ')}). Hãy chạy đoạn SQL mới nhất bên dưới trong Supabase SQL Editor.`
        };
      }
      return { ok: true, message: 'Kết nối hoàn hảo! Đủ cả 4 bảng (ntd_users, ntd_workspaces, ntd_scanned_phones, ntd_scanned_groups).' };
    }

    if (coreProbe.status === 404 || coreProbe.status === 400 || coreProbe.text.includes('PGRST205')) {
      if (coreProbe.text.includes('does not exist') || coreProbe.text.includes('ntd_users') || coreProbe.text.includes('PGRST205')) {
        return {
          ok: true,
          needTable: true,
          message: 'Kết nối API Supabase thành công nhưng chưa có các bảng dữ liệu! Hãy sao chép đoạn SQL bên dưới chạy trong Supabase SQL Editor.'
        };
      }
      return { ok: false, error: `Lỗi Supabase: ${coreProbe.text}` };
    }

    return { ok: false, error: `Mã HTTP ${coreProbe.status}: ${coreProbe.text}` };
  } catch (err) {
    return { ok: false, error: 'Không thể kết nối tới Supabase: ' + err.message };
  }
}

/**
 * Tách và chuẩn hóa danh sách các mã máy tính được phép (hỗ trợ nhiều máy tính cho 1 tài khoản)
 * @param {string} rawStr Chuỗi chứa 1 hoặc nhiều mã máy (cách nhau bởi phẩy, chấm phẩy, khoảng trắng, xuống dòng)
 * @returns {string[]} Danh sách các mã máy chuẩn hóa (chữ thường, loại bỏ trùng lặp)
 */
export function parseMachineIds(rawStr) {
  if (!rawStr || typeof rawStr !== 'string') return [];
  const parts = rawStr.split(/[\s,;\n\r\t]+/).map(s => s.trim().toLowerCase()).filter(s => s.length >= 8);
  return Array.from(new Set(parts));
}

/**
 * Ghép danh sách mã máy thành chuỗi chuẩn lưu trữ (cách nhau bởi dấu phẩy)
 * @param {string[]|string} mids 
 * @returns {string}
 */
export function formatMachineIds(mids) {
  if (Array.isArray(mids)) {
    return Array.from(new Set(mids.map(s => String(s || '').trim().toLowerCase()).filter(s => s.length >= 8))).join(', ');
  }
  return parseMachineIds(mids).join(', ');
}

/**
 * Kiểm tra xem một mã máy có thuộc danh sách được cấp quyền hay không
 * @param {string} rawStored Chuỗi lưu trong DB
 * @param {string} inputMid Mã máy hiện tại của người dùng
 * @returns {boolean}
 */
export function isMachineIdAllowed(rawStored, inputMid) {
  const allowed = parseMachineIds(rawStored);
  if (allowed.length === 0) return true; // Chưa ghim máy nào -> Cho phép và tự động ghim
  const target = (inputMid || '').trim().toLowerCase();
  if (!target) return true; // Không có mã máy gửi lên
  return allowed.includes(target);
}

/**
 * Đăng nhập người dùng qua Supabase
 */
export async function supabaseLogin(username, password, machineId) {
  const u = (username || '').trim().toLowerCase();
  const p = (password || '').trim();

  // 1. Tìm user theo username (hỗ trợ cả khi có hoặc không có tiền tố dng_)
  let users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
  if ((!users || users.length === 0) && !u.startsWith('dng_')) {
    users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent('dng_' + u)}&select=*`);
  }
  if ((!users || users.length === 0) && u.startsWith('dng_')) {
    users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u.slice(4))}&select=*`);
  }
  if (!users || users.length === 0) {
    return { ok: false, error: 'Tài khoản không tồn tại trên hệ thống.' };
  }

  const user = users[0];
  const canonicalUsername = user.username;

  // Kiểm tra mật khẩu
  if (user.password !== p) {
    return { ok: false, error: 'Mật khẩu không chính xác.' };
  }

  // Kiểm tra trạng thái khóa
  if (user.status === 'locked' || user.status === 'khoa') {
    return { ok: false, locked: true, error: 'Tài khoản này đã bị khóa bởi Quản trị viên.' };
  }

  // Kiểm tra hạn sử dụng
  const now = new Date();
  const expiryDate = new Date(user.expiry_date || user.expiry);
  if (isNaN(expiryDate.getTime()) || expiryDate < now) {
    return {
      ok: false,
      expired: true,
      error: `Tài khoản đã hết hạn vào ngày ${expiryDate.toLocaleDateString('vi-VN')}. Vui lòng liên hệ Admin để gia hạn.`
    };
  }

  // Kiểm tra và Ghim mã máy (Hỗ trợ nhiều máy tính cho 1 tài khoản)
  const currentMid = (machineId || '').trim().toLowerCase();
  const allowedMids = parseMachineIds(user.machine_id);

  let updatedMachine = user.machine_id;

  if (allowedMids.length === 0 && currentMid) {
    // Lần đầu đăng nhập trên thiết bị -> Tự động ghim mã máy này
    try {
      await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(canonicalUsername)}`, {
        method: 'PATCH',
        body: JSON.stringify({ machine_id: currentMid, last_login: new Date().toISOString() })
      });
      updatedMachine = currentMid;
    } catch (_) {}
  } else if (allowedMids.length > 0 && currentMid && !allowedMids.includes(currentMid)) {
    // Máy tính hiện tại KHÔNG nằm trong danh sách mã máy được cấp phép
    return {
      ok: false,
      lockedToOtherMachine: true,
      sheetMid: allowedMids[0],
      allowedMids: allowedMids,
      currentMid: currentMid,
      error: `⚠️ Tài khoản này chưa được cấp quyền trên máy tính này!\n• Mã máy hiện tại của bạn: ${currentMid}\n• Tài khoản đang ghim ${allowedMids.length} máy tính khác.\n\n👉 Vui lòng sao chép Mã máy này gửi cho Quản trị viên để được thêm vào danh sách máy được phép sử dụng!`
    };
  } else {
    // Cập nhật last_login
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(canonicalUsername)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_login: new Date().toISOString() })
    }).catch(() => {});
  }

  const role = (user.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  return {
    ok: true,
    data: {
      username: user.username,
      role: role,
      expiry: expiryDate.toISOString(),
      expiryFormatted: expiryDate.toLocaleDateString('vi-VN'),
      machineId: updatedMachine || machineId,
      allowedMids,
      status: user.status || 'active',
      note: user.note || ''
    }
  };
}

/**
 * Kiểm tra trạng thái tài khoản trên Supabase (cho sync ngầm)
 */
export async function supabaseCheckLicense(username, currentMachineId = null) {
  try {
    const u = (username || '').trim().toLowerCase();
    let users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
    if ((!users || users.length === 0) && !u.startsWith('dng_')) {
      users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent('dng_' + u)}&select=*`);
    }
    if ((!users || users.length === 0) && u.startsWith('dng_')) {
      users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u.slice(4))}&select=*`);
    }
    if (!users || users.length === 0) return null;

    const user = users[0];
    const canonicalUsername = user.username;
    const expiryDate = new Date(user.expiry_date || user.expiry);
    const role = (user.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

    const allowedMids = parseMachineIds(user.machine_id);
    let machineMismatch = false;
    if (currentMachineId && allowedMids.length > 0) {
      const cleanMid = currentMachineId.trim().toLowerCase();
      if (!allowedMids.includes(cleanMid)) {
        machineMismatch = true;
      }
    }

    // Cập nhật last_login ngầm để ghi nhận phiên hoạt động
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(canonicalUsername)}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_login: new Date().toISOString() })
    }).catch(() => {});

    return {
      username: user.username,
      role: role,
      status: user.status || 'active',
      isLocked: user.status === 'locked' || user.status === 'khoa',
      isExpired: expiryDate < new Date(),
      expiry: expiryDate.toISOString(),
      expiryFormatted: expiryDate.toLocaleDateString('vi-VN'),
      machineId: user.machine_id || '',
      allowedMids,
      machineMismatch
    };
  } catch (_) {
    return null;
  }
}

export const TELEMETRY_LEDGER_KEY = 'dailyUserTelemetryLedger';

/**
 * Lấy chuỗi ngày YYYY-MM-DD chuẩn theo múi giờ Việt Nam (Asia/Ho_Chi_Minh GMT+7)
 */
export function getVietnamDateStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch (_) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

export function getVietnamDayStartIso(date = new Date()) {
  const dayStr = getVietnamDateStr(date);
  return new Date(`${dayStr}T00:00:00+07:00`).toISOString();
}

/**
 * Mutex tuần tự hóa thao tác đọc/cộng dồn/đồng bộ telemetry trên cùng origin (đa tab + service worker)
 */
export async function withTelemetryMutex(fn) {
  const runInQueue = () => {
    const prev = globalThis.__ntdTelemetryQueue || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    globalThis.__ntdTelemetryQueue = next.catch(() => {});
    return next;
  };
  try {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      return await navigator.locks.request('ntd_telemetry_ledger_lock_v1', () => runInQueue());
    }
  } catch (_) {}
  return await runInQueue();
}

/**
 * Kiểm tra xem một mốc thời gian có thuộc về ngày hôm nay theo giờ Việt Nam (Asia/Ho_Chi_Minh GMT+7) hay không
 */
export function isTodayVietnamTime(dateStr) {
  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    return getVietnamDateStr(d) === getVietnamDateStr(new Date());
  } catch (_) {
    return false;
  }
}

/**
 * Tự động làm sạch các dòng đã qua ngày hôm trước trên cơ sở dữ liệu Supabase (chạy ngầm)
 */
async function autoResetStaleDailyStats(usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) return;
  try {
    const startIso = getVietnamDayStartIso();
    const list = usernames.map(u => `"${String(u || '').replace(/"/g, '')}"`).join(',');
    await supabaseRequest(`ntd_users?username=in.(${list})&or=(last_login.is.null,last_login.lt.${encodeURIComponent(startIso)})`, {
      method: 'PATCH',
      body: JSON.stringify({
        today_posts: 0,
        today_group_scans: 0,
        today_maps_scans: 0
      })
    });
  } catch (err) {
    console.warn('Lỗi tự động đặt lại số liệu ngày mới trên Supabase:', err.message);
  }
}

/**
 * [ADMIN] Đặt lại toàn bộ số liệu hôm nay (bài đăng, quét nhóm, quét maps) về 0 cho tất cả hoặc các user qua ngày mới
 */
export async function supabaseResetAllDailyStats(onlyStale = true) {
  try {
    let endpoint = 'ntd_users';
    if (onlyStale) {
      const startIso = getVietnamDayStartIso();
      endpoint = `ntd_users?or=(last_login.is.null,last_login.lt.${encodeURIComponent(startIso)})`;
    }
    await supabaseRequest(endpoint, {
      method: 'PATCH',
      body: JSON.stringify({
        today_posts: 0,
        today_group_scans: 0,
        today_maps_scans: 0
      })
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * [ADMIN] Lấy toàn bộ danh sách người dùng kèm phân quyền
 */
export async function supabaseListUsers() {
  const [users, workspaces] = await Promise.all([
    supabaseRequest(`ntd_users?select=*&order=created_at.desc`),
    supabaseRequest(`ntd_workspaces?data_key=eq.accounts&select=owner_username,item_count,payload`).catch(() => [])
  ]);
  const now = new Date();
  const staleUsernames = [];
  const autoHealUsers = [];

  // Tạo map tra cứu accounts từ ntd_workspaces để luôn đối chiếu số liệu thực tế
  const wsAccountsMap = new Map();
  if (Array.isArray(workspaces)) {
    workspaces.forEach(ws => {
      const o = (ws.owner_username || '').trim().toLowerCase();
      if (!o) return;
      let fb = 0;
      let page = 0;
      if (Array.isArray(ws.payload) && ws.payload.length > 0) {
        fb = ws.payload.filter(a => a?.type !== 'fanpage').length;
        page = ws.payload.filter(a => a?.type === 'fanpage').length;
      } else if (ws.item_count > 0) {
        fb = Number(ws.item_count) || 0;
      }
      wsAccountsMap.set(o, { fb, page });
      if (o.startsWith('dng_')) wsAccountsMap.set(o.slice(4), { fb, page });
      else wsAccountsMap.set('dng_' + o, { fb, page });
    });
  }

  const result = (users || []).map(u => {
    const exp = new Date(u.expiry_date || u.expiry);
    const isExpired = !isNaN(exp.getTime()) && exp < now;

    // Kiểm tra xem khách hàng có đăng nhập / hoạt động trong ngày hôm nay (giờ VN) không
    const activeToday = isTodayVietnamTime(u.last_login);
    const rawPosts = Number(u.today_posts) || 0;
    const rawGroups = Number(u.today_group_scans) || 0;
    const rawMaps = Number(u.today_maps_scans) || 0;

    // Sau 0h mỗi ngày: Nếu khách chưa đăng nhập / hoạt động hôm nay, tất cả số liệu BÀI HÔM NAY, QUÉT NHÓM, QUÉT MAPS tự động quay về 0
    const todayPosts = activeToday ? rawPosts : 0;
    const todayGroupScans = activeToday ? rawGroups : 0;
    const todayMapsScans = activeToday ? rawMaps : 0;

    if (!activeToday && (rawPosts > 0 || rawGroups > 0 || rawMaps > 0) && u.username) {
      staleUsernames.push(u.username);
    }

    // Tự động đối chiếu với ntd_workspaces để lấy số lượng nick chính xác nhất
    const uKey = (u.username || '').trim().toLowerCase();
    const wsData = wsAccountsMap.get(uKey);
    let fbCount = Number(u.fb_count) || 0;
    let fanpageCount = Number(u.fanpage_count) || 0;

    if (wsData) {
      if (wsData.fb > fbCount) {
        fbCount = wsData.fb;
        autoHealUsers.push({ username: u.username, fb_count: fbCount, fanpage_count: Math.max(fanpageCount, wsData.page) });
      }
      if (wsData.page > fanpageCount) {
        fanpageCount = wsData.page;
      }
    }

    return {
      username: u.username,
      password: u.password,
      role: (u.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member',
      expiry: isNaN(exp.getTime()) ? u.expiry_date : exp.toLocaleDateString('vi-VN'),
      rawExpiry: u.expiry_date,
      isExpired,
      status: u.status || 'active',
      machineId: u.machine_id || '',
      note: u.note || '',
      fbCount,
      fanpageCount,
      todayPosts,
      todayGroupScans,
      todayMapsScans,
      activeToday,
      rawLastLogin: u.last_login || null,
      lastLogin: u.last_login ? new Date(u.last_login).toLocaleString('vi-VN') : 'Chưa đăng nhập',
      createdAt: u.created_at ? new Date(u.created_at).toLocaleDateString('vi-VN') : ''
    };
  });

  // Tự động dọn sạch các số liệu ngày cũ trên Supabase trong nền
  if (staleUsernames.length > 0) {
    autoResetStaleDailyStats(staleUsernames).catch(() => {});
  }

  // Tự động sửa lỗi sai lệch fb_count trên Supabase trong nền
  if (autoHealUsers.length > 0) {
    Promise.allSettled(autoHealUsers.map(h =>
      supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(h.username)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fb_count: h.fb_count,
          fanpage_count: h.fanpage_count
        })
      })
    )).catch(() => {});
  }

  return result;
}

async function readTelemetryStorage(keys) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return await chrome.storage.local.get(keys);
    }
  } catch (_) {}
  const out = {};
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    try {
      const raw = typeof localStorage !== 'undefined' ? (localStorage.getItem(`ntd_store_${k}`) ?? localStorage.getItem(k)) : null;
      if (raw !== null && raw !== undefined) out[k] = JSON.parse(raw);
    } catch (_) {}
  }
  return out;
}

async function writeTelemetryStorage(obj) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set(obj);
      return;
    }
  } catch (_) {}
  if (typeof localStorage !== 'undefined') {
    for (const [k, v] of Object.entries(obj)) {
      try { localStorage.setItem(`ntd_store_${k}`, JSON.stringify(v)); } catch (_) {}
    }
  }
}

function sumTodayPostsFromMap(statsMap, todayStr) {
  if (!statsMap || typeof statsMap !== 'object') return 0;
  let total = 0;
  for (const k of Object.keys(statsMap)) {
    const rec = statsMap[k];
    if (rec && rec.date === todayStr) {
      total += Math.max(0, Number(rec.count) || 0);
    }
  }
  return total;
}

function countTodayRowsFromStore(rows, todayStr, idPrefix) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const startOfDayMs = new Date(`${todayStr}T00:00:00+07:00`).getTime();
  const [y, m, d] = todayStr.split('-');
  const todayVi = `${Number(d)}/${Number(m)}/${y}`;
  const todayViPad = `${d}/${m}/${y}`;
  return rows.filter(r => {
    if (!r || typeof r !== 'object') return false;
    if (r.id && typeof r.id === 'string' && r.id.startsWith(`${idPrefix}_`)) {
      const ts = Number(r.id.split('_')[1]);
      if (!isNaN(ts) && ts >= startOfDayMs) return true;
    }
    if (r.at && typeof r.at === 'string' && (r.at.includes(todayVi) || r.at.includes(todayViPad) || r.at.includes(todayStr))) return true;
    if (r.scanned_at) {
      const t = new Date(r.scanned_at).getTime();
      if (!isNaN(t) && t >= startOfDayMs) return true;
    }
    return false;
  }).length;
}

function createFreshTelemetryLedger(todayVn, { baselinePosts = 0, baselineGroups = 0, baselineMaps = 0, forceZeroSynced = false } = {}) {
  const bPosts = Math.max(0, Number(baselinePosts) || 0);
  const bGroups = Math.max(0, Number(baselineGroups) || 0);
  const bMaps = Math.max(0, Number(baselineMaps) || 0);
  return {
    date: todayVn,
    posts: bPosts,
    syncedPosts: forceZeroSynced ? 0 : (bPosts === 0 ? 0 : null),
    baselinePosts: bPosts,
    groupScans: bGroups,
    syncedGroupScans: forceZeroSynced ? 0 : (bGroups === 0 ? 0 : null),
    baselineGroupScans: bGroups,
    mapsScans: bMaps,
    syncedMapsScans: forceZeroSynced ? 0 : (bMaps === 0 ? 0 : null),
    baselineMapsScans: bMaps
  };
}

/**
 * Ghi nhận tăng (+1) số bài đăng hoặc lượt quét vào sổ cái bất biến cục bộ (dailyUserTelemetryLedger).
 * Hoàn toàn tách biệt khỏi dailyPostStats (bộ đếm giới hạn 20 bài/nick có thể Đặt lại),
 * giúp tổng số bài trong ngày KHÔNG BAO GIỜ bị tụt khi khách bấm nút "Đặt lại" hay chạy đa Profile.
 */
export async function recordLocalTelemetryIncrement(deltas = {}, options = {}) {
  return withTelemetryMutex(async () => {
    const todayVn = getVietnamDateStr();
    const store = await readTelemetryStorage([TELEMETRY_LEDGER_KEY, 'dailyPostStats', 'dailyScanStats']);
    let ledger = store?.[TELEMETRY_LEDGER_KEY];

    if (!ledger || ledger.date !== todayVn) {
      let basePosts = 0;
      let baseGroups = 0;
      let baseMaps = 0;
      if (!options.isWebExtensionBridged) {
        basePosts = options.preExistingPostsSum !== undefined
          ? Math.max(0, Number(options.preExistingPostsSum) || 0)
          : sumTodayPostsFromMap(store?.dailyPostStats, todayVn);
        const ds = store?.dailyScanStats;
        if (ds && ds.date === todayVn) {
          baseGroups = options.preExistingGroupScans !== undefined
            ? Math.max(0, Number(options.preExistingGroupScans) || 0)
            : Math.max(0, Number(ds.groupScans) || 0);
          baseMaps = options.preExistingMapsScans !== undefined
            ? Math.max(0, Number(options.preExistingMapsScans) || 0)
            : Math.max(0, Number(ds.mapsScans) || 0);
        }
      }
      ledger = createFreshTelemetryLedger(todayVn, { baselinePosts: basePosts, baselineGroups: baseGroups, baselineMaps: baseMaps });
    }

    ledger.posts = Math.max(0, (Number(ledger.posts) || 0) + Math.max(0, Number(deltas.posts) || 0));
    ledger.groupScans = Math.max(0, (Number(ledger.groupScans) || 0) + Math.max(0, Number(deltas.groupScans) || 0));
    ledger.mapsScans = Math.max(0, (Number(ledger.mapsScans) || 0) + Math.max(0, Number(deltas.mapsScans) || 0));

    await writeTelemetryStorage({ [TELEMETRY_LEDGER_KEY]: ledger });
    return ledger;
  });
}

/**
 * [TELEMETRY AN TOÀN] Cộng dồn số liệu trong ngày lên Supabase bằng Compare-And-Set (CAS).
 * Không bao giờ ghi đè làm giảm số liệu từ máy/profile khác hoặc chỉnh tay của Admin.
 */
export async function supabaseAddUserDailyTelemetry(username, {
  deltaPosts = 0,
  deltaGroupScans = 0,
  deltaMapsScans = 0,
  floorPosts = 0,
  floorGroupScans = 0,
  floorMapsScans = 0,
  fb_count,
  fanpage_count,
  forceZeroAccountCounts = false,
  skipLastLogin = false
} = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return { ok: false };

  const dPosts = Math.max(0, Number(deltaPosts) || 0);
  const dGroups = Math.max(0, Number(deltaGroupScans) || 0);
  const dMaps = Math.max(0, Number(deltaMapsScans) || 0);
  const fPosts = Math.max(0, Number(floorPosts) || 0);
  const fGroups = Math.max(0, Number(floorGroupScans) || 0);
  const fMaps = Math.max(0, Number(floorMapsScans) || 0);

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const rows = await supabaseRequest(
        `ntd_users?username=eq.${encodeURIComponent(u)}&select=username,today_posts,today_group_scans,today_maps_scans,last_login,fb_count,fanpage_count`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return { ok: false, error: 'User not found' };

      const activeToday = isTodayVietnamTime(row.last_login);
      const curPosts = activeToday ? (Number(row.today_posts) || 0) : 0;
      const curGroups = activeToday ? (Number(row.today_group_scans) || 0) : 0;
      const curMaps = activeToday ? (Number(row.today_maps_scans) || 0) : 0;

      const nextPosts = Math.max(curPosts + dPosts, fPosts);
      const nextGroups = Math.max(curGroups + dGroups, fGroups);
      const nextMaps = Math.max(curMaps + dMaps, fMaps);

      const payload = {};
      if (fb_count !== undefined) {
        const parsedFb = Math.max(0, Number(fb_count) || 0);
        const curDbFb = Math.max(0, Number(row.fb_count) || 0);
        // Bảo vệ: Tuyệt đối không để telemetry vô tình hạ số lượng nick về 0 khi trên Supabase đã có nick
        if (parsedFb > 0 || curDbFb === 0 || forceZeroAccountCounts) {
          payload.fb_count = parsedFb;
        }
      }
      if (fanpage_count !== undefined) {
        const parsedFp = Math.max(0, Number(fanpage_count) || 0);
        const curDbFp = Math.max(0, Number(row.fanpage_count) || 0);
        if (parsedFp > 0 || curDbFp === 0 || forceZeroAccountCounts) {
          payload.fanpage_count = parsedFp;
        }
      }

      const postsChanged = !activeToday || nextPosts !== curPosts;
      const groupsChanged = !activeToday || nextGroups !== curGroups;
      const mapsChanged = !activeToday || nextMaps !== curMaps;

      if (postsChanged || dPosts > 0) payload.today_posts = nextPosts;
      if (groupsChanged || dGroups > 0) payload.today_group_scans = nextGroups;
      if (mapsChanged || dMaps > 0) payload.today_maps_scans = nextMaps;
      if (!skipLastLogin) payload.last_login = new Date().toISOString();

      if (!postsChanged && !groupsChanged && !mapsChanged && dPosts === 0 && dGroups === 0 && dMaps === 0) {
        if (Object.keys(payload).length > 0) {
          await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
          });
        }
        return { ok: true, row, applied: { posts: 0, groupScans: 0, mapsScans: 0 } };
      }

      const filters = [`username=eq.${encodeURIComponent(u)}`];
      const addEqOrNullFilter = (col, rawVal) => {
        if (rawVal === null || rawVal === undefined) {
          filters.push(`${col}=is.null`);
        } else {
          filters.push(`${col}=eq.${encodeURIComponent(String(rawVal))}`);
        }
      };
      if (payload.today_posts !== undefined) addEqOrNullFilter('today_posts', row.today_posts);
      if (payload.today_group_scans !== undefined) addEqOrNullFilter('today_group_scans', row.today_group_scans);
      if (payload.today_maps_scans !== undefined) addEqOrNullFilter('today_maps_scans', row.today_maps_scans);

      const updated = await supabaseRequest(`ntd_users?${filters.join('&')}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      if (Array.isArray(updated) && updated.length > 0) {
        return {
          ok: true,
          row: updated[0],
          applied: { posts: dPosts, groupScans: dGroups, mapsScans: dMaps }
        };
      }
      await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 140)));
    }

    const finalRows = await supabaseRequest(
      `ntd_users?username=eq.${encodeURIComponent(u)}&select=today_posts,today_group_scans,today_maps_scans,last_login`
    );
    const fr = Array.isArray(finalRows) ? finalRows[0] : null;
    const activeToday = fr ? isTodayVietnamTime(fr.last_login) : false;
    const fallbackPayload = {
      today_posts: Math.max((activeToday ? (Number(fr?.today_posts) || 0) : 0) + dPosts, fPosts),
      today_group_scans: Math.max((activeToday ? (Number(fr?.today_group_scans) || 0) : 0) + dGroups, fGroups),
      today_maps_scans: Math.max((activeToday ? (Number(fr?.today_maps_scans) || 0) : 0) + dMaps, fMaps)
    };
    if (fb_count !== undefined) {
      const parsedFb = Math.max(0, Number(fb_count) || 0);
      const curDbFb = Math.max(0, Number(fr?.fb_count) || 0);
      if (parsedFb > 0 || curDbFb === 0 || forceZeroAccountCounts) {
        fallbackPayload.fb_count = parsedFb;
      }
    }
    if (fanpage_count !== undefined) {
      const parsedFp = Math.max(0, Number(fanpage_count) || 0);
      const curDbFp = Math.max(0, Number(fr?.fanpage_count) || 0);
      if (parsedFp > 0 || curDbFp === 0 || forceZeroAccountCounts) {
        fallbackPayload.fanpage_count = parsedFp;
      }
    }
    if (!skipLastLogin) fallbackPayload.last_login = new Date().toISOString();

    await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
      method: 'PATCH',
      body: JSON.stringify(fallbackPayload)
    });
    return { ok: true, applied: { posts: dPosts, groupScans: dGroups, mapsScans: dMaps } };
  } catch (err) {
    console.warn('Không thể gửi telemetry cộng dồn Supabase:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Đồng bộ phần chênh lệch chưa đẩy (delta) từ dailyUserTelemetryLedger của thiết bị/profile hiện tại lên Supabase.
 */
export async function syncLocalTelemetryToSupabase(username, { isWebExtensionBridged = false, skipAccountCountsIfEmpty = false } = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u || !(await isSupabaseConfigured())) return { ok: false };

  return withTelemetryMutex(async () => {
    const todayVn = getVietnamDateStr();
    const store = await readTelemetryStorage([
      TELEMETRY_LEDGER_KEY,
      'accounts',
      'dailyPostStats',
      'dailyScanStats',
      'rinFbGroup',
      'rinMaps'
    ]);

    const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
    const fbCount = accounts.filter(a => a?.type !== 'fanpage').length;
    const fanpageCount = accounts.filter(a => a?.type === 'fanpage').length;
    const shouldSendAccountCounts = !(skipAccountCountsIfEmpty && accounts.length === 0);

    let ledger = store?.[TELEMETRY_LEDGER_KEY];
    if (!ledger || ledger.date !== todayVn) {
      if (isWebExtensionBridged) {
        // Trên Web đã kết nối Extension: Extension tự quản lý & đẩy dailyPostStats + quét từ Extension.
        // Web KHÔNG kế thừa dailyPostStats copy từ Extension để tránh đếm trùng hoặc ghi đè về 0.
        ledger = createFreshTelemetryLedger(todayVn, { baselinePosts: 0, baselineGroups: 0, baselineMaps: 0, forceZeroSynced: true });
      } else {
        const localPosts = sumTodayPostsFromMap(store?.dailyPostStats, todayVn);
        const ds = store?.dailyScanStats;
        const scanGroups = (ds && ds.date === todayVn) ? Math.max(0, Number(ds.groupScans) || 0) : 0;
        const scanMaps = (ds && ds.date === todayVn) ? Math.max(0, Number(ds.mapsScans) || 0) : 0;
        const tableGroups = countTodayRowsFromStore(store?.rinFbGroup?.rows, todayVn, 'fg');
        const tableMaps = countTodayRowsFromStore(store?.rinMaps?.rows, todayVn, 'mp');
        ledger = createFreshTelemetryLedger(todayVn, {
          baselinePosts: localPosts,
          baselineGroups: Math.max(scanGroups, tableGroups),
          baselineMaps: Math.max(scanMaps, tableMaps)
        });
      }
      await writeTelemetryStorage({ [TELEMETRY_LEDGER_KEY]: ledger });
    }

    // Đối soát lần đầu trong ngày nếu nâng cấp giữa ngày (synced* === null)
    if (ledger.syncedPosts === null || ledger.syncedGroupScans === null || ledger.syncedMapsScans === null) {
      try {
        const rows = await supabaseRequest(
          `ntd_users?username=eq.${encodeURIComponent(u)}&select=today_posts,today_group_scans,today_maps_scans,last_login`
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        const activeToday = row ? isTodayVietnamTime(row.last_login) : false;
        const remotePosts = activeToday ? (Number(row?.today_posts) || 0) : 0;
        const remoteGroups = activeToday ? (Number(row?.today_group_scans) || 0) : 0;
        const remoteMaps = activeToday ? (Number(row?.today_maps_scans) || 0) : 0;

        if (ledger.syncedPosts === null) {
          const baseP = ledger.baselinePosts !== undefined ? (Number(ledger.baselinePosts) || 0) : (Number(ledger.posts) || 0);
          ledger.syncedPosts = Math.min(baseP, remotePosts);
        }
        if (ledger.syncedGroupScans === null) {
          const baseG = ledger.baselineGroupScans !== undefined ? (Number(ledger.baselineGroupScans) || 0) : (Number(ledger.groupScans) || 0);
          ledger.syncedGroupScans = Math.min(baseG, remoteGroups);
        }
        if (ledger.syncedMapsScans === null) {
          const baseM = ledger.baselineMapsScans !== undefined ? (Number(ledger.baselineMapsScans) || 0) : (Number(ledger.mapsScans) || 0);
          ledger.syncedMapsScans = Math.min(baseM, remoteMaps);
        }
        await writeTelemetryStorage({ [TELEMETRY_LEDGER_KEY]: ledger });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    const deltaPosts = Math.max(0, (Number(ledger.posts) || 0) - (Number(ledger.syncedPosts) || 0));
    const deltaGroupScans = Math.max(0, (Number(ledger.groupScans) || 0) - (Number(ledger.syncedGroupScans) || 0));
    const deltaMapsScans = Math.max(0, (Number(ledger.mapsScans) || 0) - (Number(ledger.syncedMapsScans) || 0));

    const statsArgs = {
      deltaPosts,
      deltaGroupScans,
      deltaMapsScans
    };
    if (shouldSendAccountCounts) {
      statsArgs.fb_count = fbCount;
      statsArgs.fanpage_count = fanpageCount;
    }

    const res = await supabaseAddUserDailyTelemetry(u, statsArgs);
    if (res && res.ok) {
      ledger.syncedPosts = (Number(ledger.syncedPosts) || 0) + deltaPosts;
      ledger.syncedGroupScans = (Number(ledger.syncedGroupScans) || 0) + deltaGroupScans;
      ledger.syncedMapsScans = (Number(ledger.syncedMapsScans) || 0) + deltaMapsScans;
      await writeTelemetryStorage({ [TELEMETRY_LEDGER_KEY]: ledger });
    }
    return res;
  });
}

/**
 * [TELEMETRY] Cập nhật số liệu hoạt động của người dùng lên Supabase
 * Mặc định bảo vệ KHÔNG BAO GIỜ hạ thấp today_posts / today_group_scans / today_maps_scans trong cùng ngày VN.
 */
export async function supabaseUpdateUserStats(username, stats = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return { ok: false };

  if (stats.forceOverwrite) {
    try {
      const payload = {};
      if (stats.fb_count !== undefined) payload.fb_count = Math.max(0, Number(stats.fb_count) || 0);
      if (stats.fanpage_count !== undefined) payload.fanpage_count = Math.max(0, Number(stats.fanpage_count) || 0);
      if (stats.today_posts !== undefined) payload.today_posts = Math.max(0, Number(stats.today_posts) || 0);
      if (stats.today_group_scans !== undefined) payload.today_group_scans = Math.max(0, Number(stats.today_group_scans) || 0);
      if (stats.today_maps_scans !== undefined) payload.today_maps_scans = Math.max(0, Number(stats.today_maps_scans) || 0);
      if (!stats.skipLastLogin) payload.last_login = new Date().toISOString();

      await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      return { ok: true };
    } catch (err) {
      console.warn('Không thể gửi telemetry Supabase:', err.message);
      return { ok: false, error: err.message };
    }
  }

  return await supabaseAddUserDailyTelemetry(u, {
    deltaPosts: 0,
    deltaGroupScans: 0,
    deltaMapsScans: 0,
    floorPosts: stats.today_posts !== undefined ? Math.max(0, Number(stats.today_posts) || 0) : 0,
    floorGroupScans: stats.today_group_scans !== undefined ? Math.max(0, Number(stats.today_group_scans) || 0) : 0,
    floorMapsScans: stats.today_maps_scans !== undefined ? Math.max(0, Number(stats.today_maps_scans) || 0) : 0,
    fb_count: stats.fb_count,
    fanpage_count: stats.fanpage_count,
    skipLastLogin: Boolean(stats.skipLastLogin)
  });
}

/**
 * [ADMIN] Đặt lại hoặc chỉnh sửa số lượng nick FB & Fanpage của người dùng
 * Hỗ trợ đồng bộ dọn sạch ntd_workspaces khi đưa số lượng về 0
 */
export async function supabaseResetUserAccountCounts(username, fbCount = 0, fanpageCount = 0, clearWorkspace = false, extraStats = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u) throw new Error('Tài khoản không hợp lệ.');
  
  const payload = {
    fb_count: Math.max(0, Number(fbCount) || 0),
    fanpage_count: Math.max(0, Number(fanpageCount) || 0)
  };

  if (extraStats.today_posts !== undefined) {
    payload.today_posts = Math.max(0, Number(extraStats.today_posts) || 0);
  }
  if (extraStats.today_group_scans !== undefined) {
    payload.today_group_scans = Math.max(0, Number(extraStats.today_group_scans) || 0);
  }
  if (extraStats.today_maps_scans !== undefined) {
    payload.today_maps_scans = Math.max(0, Number(extraStats.today_maps_scans) || 0);
  }
  if (payload.today_posts > 0 || payload.today_group_scans > 0 || payload.today_maps_scans > 0) {
    payload.last_login = new Date().toISOString();
  }

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });

  if (clearWorkspace && payload.fb_count === 0 && payload.fanpage_count === 0) {
    // Dọn dẹp cả bản sao workspace trên đám mây để không bị kéo về lại
    await supabaseRequest(`ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.accounts`, {
      method: 'PATCH',
      body: JSON.stringify({
        payload: [],
        item_count: 0,
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
  }

  return { ok: true, fb_count: payload.fb_count, fanpage_count: payload.fanpage_count };
}

/**
 * [ADMIN] Tạo tài khoản mới với vai trò chỉ định
 */
export async function supabaseCreateUser({ username, password, role = 'member', expiryDate, note = '' }) {
  const u = (username || '').trim().toLowerCase();
  const p = (password || '').trim();
  const r = (role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  if (!u) throw new Error('Vui lòng nhập Tên tài khoản.');
  if (!p) throw new Error('Vui lòng nhập Mật khẩu.');

  const res = await supabaseRequest('ntd_users', {
    method: 'POST',
    body: JSON.stringify({
      username: u,
      password: p,
      role: r,
      expiry_date: expiryDate,
      status: 'active',
      note: note,
      created_at: new Date().toISOString()
    })
  });

  return { ok: true, data: res };
}

/**
 * [ADMIN] Nhập hoặc cập nhật hàng loạt người dùng (Upsert batch)
 */
export async function supabaseUpsertUsers(usersArray) {
  if (!Array.isArray(usersArray) || usersArray.length === 0) {
    return { ok: true, count: 0 };
  }

  // Chuẩn hóa dữ liệu từng user
  const sanitized = usersArray.map(u => ({
    username: (u.username || '').trim().toLowerCase(),
    password: String(u.password || '123456').trim(),
    role: (u.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member',
    expiry_date: u.expiryDate || u.expiry_date,
    status: u.status || 'active',
    machine_id: u.machineId || u.machine_id || null,
    note: u.note || '',
    updated_at: new Date().toISOString()
  })).filter(u => Boolean(u.username));

  if (sanitized.length === 0) {
    return { ok: true, count: 0 };
  }

  const res = await supabaseRequest('ntd_users', {
    method: 'POST',
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(sanitized)
  });

  return { ok: true, data: res, count: Array.isArray(res) ? res.length : sanitized.length };
}

/**
 * [ADMIN] Phân quyền người dùng (Đổi vai trò giữa admin và member)
 */
export async function supabaseUpdateRole(username, newRole) {
  const u = (username || '').trim().toLowerCase();
  const r = (newRole || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      role: r,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, role: r };
}

/**
 * [ADMIN] Khóa hoặc mở khóa tài khoản
 */
export async function supabaseUpdateStatus(username, newStatus) {
  const u = (username || '').trim().toLowerCase();
  const s = newStatus === 'locked' ? 'locked' : 'active';

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: s,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, status: s };
}

/**
 * [ADMIN] Gia hạn ngày sử dụng
 */
export async function supabaseRenewUser(username, daysOrDate) {
  const u = (username || '').trim().toLowerCase();
  let finalExpiry = '';

  if (typeof daysOrDate === 'number' || !isNaN(Number(daysOrDate))) {
    const days = Number(daysOrDate);
    const target = new Date();
    target.setDate(target.getDate() + days);
    const pad = n => String(n).padStart(2, '0');
    finalExpiry = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
  } else {
    finalExpiry = daysOrDate;
  }

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expiry_date: finalExpiry,
      status: 'active',
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, expiryDate: finalExpiry };
}

/**
 * [ADMIN] Reset mã máy để khách đổi máy tính
 */
export async function supabaseResetMachine(username) {
  const u = (username || '').trim().toLowerCase();

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      machine_id: null,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true };
}

/**
 * [ADMIN] Cập nhật toàn bộ danh sách mã máy tính của tài khoản
 * @param {string} username 
 * @param {string|string[]} machineIds 
 */
export async function supabaseUpdateUserMachineIds(username, machineIds) {
  const u = (username || '').trim().toLowerCase();
  if (!u) throw new Error('Chưa cung cấp Tên tài khoản.');

  const formatted = formatMachineIds(machineIds);
  const patchVal = formatted.length > 0 ? formatted : null;

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      machine_id: patchVal,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, machine_id: patchVal, mids: parseMachineIds(patchVal) };
}

/**
 * [ADMIN] Thêm 1 hoặc nhiều mã máy mới vào tài khoản khách hàng (không xóa máy cũ)
 * @param {string} username 
 * @param {string} newMachineId 
 */
export async function supabaseAddMachineIdToUser(username, newMachineId) {
  const u = (username || '').trim().toLowerCase();
  if (!u) throw new Error('Chưa cung cấp Tên tài khoản.');

  const incoming = parseMachineIds(newMachineId);
  if (incoming.length === 0) throw new Error('Mã máy không hợp lệ (cần tối thiểu 8 ký tự).');

  const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=machine_id`);
  const currentRaw = users?.[0]?.machine_id || '';
  const currentList = parseMachineIds(currentRaw);

  const merged = Array.from(new Set([...currentList, ...incoming]));
  const formatted = merged.join(', ');

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      machine_id: formatted,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, machine_id: formatted, mids: merged, addedCount: incoming.length };
}

/**
 * [ADMIN] Xóa 1 mã máy cụ thể khỏi tài khoản
 * @param {string} username 
 * @param {string} targetMachineId 
 */
export async function supabaseRemoveMachineIdFromUser(username, targetMachineId) {
  const u = (username || '').trim().toLowerCase();
  if (!u) throw new Error('Chưa cung cấp Tên tài khoản.');

  const target = (targetMachineId || '').trim().toLowerCase();
  const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=machine_id`);
  const currentRaw = users?.[0]?.machine_id || '';
  const currentList = parseMachineIds(currentRaw);

  const filtered = currentList.filter(id => id !== target);
  const patchVal = filtered.length > 0 ? filtered.join(', ') : null;

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      machine_id: patchVal,
      updated_at: new Date().toISOString()
    })
  });

  return { ok: true, machine_id: patchVal, mids: filtered };
}

/**
 * [ADMIN] Xóa tài khoản
 */
export async function supabaseDeleteUser(username) {
  const u = (username || '').trim().toLowerCase();

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'DELETE'
  });

  return { ok: true };
}

/**
 * [ADMIN] Đổi tên tài khoản đăng nhập (Username) trên hệ thống Supabase
 * Tự động di chuyển dữ liệu (workspaces, SĐT quét, nhóm quét) sang username mới
 */
export async function supabaseRenameUser(oldUsername, newUsername) {
  const oldU = (oldUsername || '').trim().toLowerCase();
  const newU = (newUsername || '').trim().toLowerCase();

  if (!oldU) throw new Error('Tài khoản cũ không hợp lệ.');
  if (!newU) throw new Error('Vui lòng nhập tên tài khoản mới.');
  if (oldU === newU) throw new Error('Tên tài khoản mới phải khác tên tài khoản cũ.');

  if (!/^[a-zA-Z0-9._-]+$/.test(newU)) {
    throw new Error('Tên tài khoản mới chỉ được chứa chữ cái, số, gạch dưới (_), gạch ngang (-) hoặc chấm (.). Không dùng khoảng trắng hoặc tiếng Việt có dấu.');
  }

  // 1. Kiểm tra xem newUsername đã tồn tại trong ntd_users chưa
  const existing = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(newU)}&select=id,username`);
  if (Array.isArray(existing) && existing.length > 0) {
    throw new Error(`Tên tài khoản "${newU}" đã tồn tại trên hệ thống! Vui lòng chọn tên khác.`);
  }

  // 2. Cập nhật bảng ntd_users
  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(oldU)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      username: newU,
      updated_at: new Date().toISOString()
    })
  });

  // 3. Cập nhật các bảng dữ liệu liên kết nếu có
  await Promise.allSettled([
    supabaseRequest(`ntd_workspaces?owner_username=eq.${encodeURIComponent(oldU)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        owner_username: newU,
        updated_at: new Date().toISOString()
      })
    }),
    supabaseRequest(`ntd_scanned_phones?owner_username=eq.${encodeURIComponent(oldU)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        owner_username: newU,
        updated_at: new Date().toISOString()
      })
    }),
    supabaseRequest(`ntd_scanned_groups?owner_username=eq.${encodeURIComponent(oldU)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        owner_username: newU,
        updated_at: new Date().toISOString()
      })
    })
  ]);

  // 4. Cập nhật license lưu cục bộ nếu nick đang đăng nhập chính là nick này
  try {
    let lic = null;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get('license');
      lic = stored.license;
    } else if (typeof localStorage !== 'undefined') {
      lic = JSON.parse(localStorage.getItem('license') || 'null');
    }

    if (lic && lic.username && lic.username.toLowerCase() === oldU) {
      lic.username = newU;
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ license: lic });
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('license', JSON.stringify(lic));
      }
    }
  } catch (_) {}

  return { ok: true, oldUsername: oldU, newUsername: newU };
}

// ====================================================================
// ĐỒNG BỘ DỮ LIỆU TOÀN DIỆN (WORKSPACES + SĐT + NHÓM FACEBOOK)
// ====================================================================

export const SYNC_WORKSPACE_KEYS = [
  'accounts',
  'accountGroupsList',
  'groupCategories',
  'draft',
  'scheduledPostJobs',
  'dailyPostStats',
  'warmupConfig',
  'warmupReports',
  'rinZalo',
  'postedGroupHistory',
  'scannedGroupHistory',
  'lastScannedGroups',
  'lastSelectedCategory'
];

export const CLOUD_CLEAR_LEDGER_KEY = 'ntd_cloud_clear_ledger';

const CLOUD_CLEAR_SPECS = {
  maps: {
    localKey: 'rinMaps',
    endpoints: (u) => [
      `ntd_scanned_phones?owner_username=eq.${encodeURIComponent(u)}&source=eq.maps`
    ]
  },
  fb_group: {
    localKey: 'rinFbGroup',
    endpoints: (u) => [
      `ntd_scanned_phones?owner_username=eq.${encodeURIComponent(u)}&source=eq.fb_group`
    ]
  },
  scanned_groups: {
    localKey: 'lastScannedGroups',
    endpoints: (u) => [
      `ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.lastScannedGroups`,
      `ntd_scanned_groups?owner_username=eq.${encodeURIComponent(u)}&in_saved_category=eq.false`
    ]
  },
  scanned_group_history: {
    localKey: 'scannedGroupHistory',
    endpoints: (u) => [
      `ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.scannedGroupHistory`
    ]
  },
  warmup_reports: {
    localKey: 'warmupReports',
    endpoints: (u) => [
      `ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.warmupReports`
    ]
  },
  posted_group_history: {
    localKey: 'postedGroupHistory',
    endpoints: (u) => [
      `ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.postedGroupHistory`
    ]
  },
  scheduled_post_jobs: {
    localKey: 'scheduledPostJobs',
    endpoints: (u) => [
      `ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&data_key=eq.scheduledPostJobs`
    ]
  }
};

const SIMPLE_KEY_CLEAR_SCOPE = {
  warmupReports: 'warmup_reports',
  scannedGroupHistory: 'scanned_group_history',
  postedGroupHistory: 'posted_group_history',
  scheduledPostJobs: 'scheduled_post_jobs'
};

export async function resolveActiveSyncUsername(explicitUsername = '') {
  const direct = String(explicitUsername || '').trim().toLowerCase();
  if (direct) return direct;
  try {
    if (chrome?.storage?.local?.get) {
      const res = await chrome.storage.local.get('license');
      const stored = String(res?.license?.username || '').trim().toLowerCase();
      if (stored) return stored;
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('ntd_store_license');
      const parsed = raw ? JSON.parse(raw) : null;
      const fromLs = String(parsed?.username || '').trim().toLowerCase();
      if (fromLs) return fromLs;
    }
  } catch (_) {}
  return '';
}

export const getActiveSyncUsername = resolveActiveSyncUsername;

export async function readCloudClearLedger() {
  try {
    if (chrome?.storage?.local?.get) {
      const data = await chrome.storage.local.get(CLOUD_CLEAR_LEDGER_KEY);
      const ledger = data?.[CLOUD_CLEAR_LEDGER_KEY];
      return (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) ? { ...ledger } : {};
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`ntd_store_${CLOUD_CLEAR_LEDGER_KEY}`);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    }
  } catch (_) {}
  return {};
}

async function writeCloudClearLedger(ledger) {
  const safe = (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) ? ledger : {};
  try {
    if (chrome?.storage?.local?.set) {
      await chrome.storage.local.set({ [CLOUD_CLEAR_LEDGER_KEY]: safe });
      return;
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`ntd_store_${CLOUD_CLEAR_LEDGER_KEY}`, JSON.stringify(safe));
    }
  } catch (_) {}
}

function getLedgerSeq(ledger, scope) {
  return Number(ledger?.[scope]?.seq) || 0;
}

function didScopeClearAdvance(beforeLedger, afterLedger, scope) {
  return Boolean(afterLedger?.[scope]?.pending) || getLedgerSeq(afterLedger, scope) > getLedgerSeq(beforeLedger, scope);
}

export async function markCloudClearPending(scopeOrScopes, clearedAt = Date.now()) {
  const scopes = (Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes])
    .filter(s => typeof s === 'string' && Boolean(CLOUD_CLEAR_SPECS[s]));
  if (scopes.length === 0) return {};

  const ledger = await readCloudClearLedger();
  const stamp = Number(clearedAt) || Date.now();
  for (const scope of scopes) {
    const prev = ledger[scope] || {};
    ledger[scope] = {
      pending: true,
      seq: (Number(prev.seq) || 0) + 1,
      clearedAt: stamp
    };
  }
  await writeCloudClearLedger(ledger);
  return ledger;
}

async function deleteScopeFromSupabase(username, scope) {
  const spec = CLOUD_CLEAR_SPECS[scope];
  if (!spec || !username) return { ok: true, skipped: true };
  const endpoints = spec.endpoints(username);
  for (const ep of endpoints) {
    try {
      await supabaseRequest(ep, {
        method: 'DELETE',
        keepalive: true,
        headers: { 'Prefer': 'return=minimal' }
      });
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }
  return { ok: true };
}

/**
 * Hoàn tất các lệnh xóa báo cáo đang chờ đẩy lên Supabase (chạy trước khi hydrate hoặc push).
 * Trả về Set các scope vẫn chưa xóa được trên cloud (ví dụ do mất mạng tạm thời).
 */
export async function flushPendingCloudClears(username = '') {
  const ledger = await readCloudClearLedger();
  const pendingScopes = Object.keys(CLOUD_CLEAR_SPECS).filter(s => Boolean(ledger[s]?.pending));
  const stillPending = new Set(pendingScopes);
  if (pendingScopes.length === 0) return stillPending;

  const u = await resolveActiveSyncUsername(username);
  if (!u || !(await isSupabaseConfigured())) return stillPending;

  const clearedScopes = new Set();
  for (const scope of pendingScopes) {
    const seqBefore = getLedgerSeq(ledger, scope);
    try {
      await deleteScopeFromSupabase(u, scope);
      const latest = await readCloudClearLedger();
      if (getLedgerSeq(latest, scope) === seqBefore) {
        clearedScopes.add(scope);
        stillPending.delete(scope);
      }
    } catch (_) {
      // Giữ pending: true để lần chuyển tab tiếp theo tự động xóa lại trên Supabase
    }
  }

  if (clearedScopes.size > 0) {
    const latest = await readCloudClearLedger();
    let anyUpdated = false;
    for (const scope of clearedScopes) {
      if (getLedgerSeq(latest, scope) === getLedgerSeq(ledger, scope) && latest[scope]?.pending) {
        latest[scope] = { ...latest[scope], pending: false };
        anyUpdated = true;
      }
    }
    if (anyUpdated) {
      await writeCloudClearLedger(latest);
    }
  }
  return stillPending;
}

/**
 * Xóa dữ liệu báo cáo trên Supabase cho một phạm vi cụ thể (maps, fb_group, scanned_groups, ...)
 * Luôn ghi nhận trạng thái pending cục bộ trước để tránh khôi phục dữ liệu cũ khi chuyển tab nhanh.
 */
export async function supabaseClearReportScope(username, scopeOrScopes, options = {}) {
  const scopes = (Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes])
    .filter(s => typeof s === 'string' && Boolean(CLOUD_CLEAR_SPECS[s]));
  if (scopes.length === 0) return { ok: false, error: 'Invalid clear scope' };

  await markCloudClearPending(scopes, options?.clearedAt);
  const u = await resolveActiveSyncUsername(username);
  if (!u || !(await isSupabaseConfigured())) {
    return { ok: false, deferred: true };
  }

  const stillPending = await flushPendingCloudClears(u);
  const unresolved = scopes.filter(s => stillPending.has(s));
  return {
    ok: unresolved.length === 0,
    pending: unresolved,
    cleared: scopes.filter(s => !stillPending.has(s))
  };
}

function isMissingTableError(err) {
  const msg = String(err?.message || '');
  return err?.status === 404 || err?.code === 'PGRST205' || /does not exist|PGRST205|schema cache/i.test(msg);
}

function sanitizeWorkspacePayload(key, value) {
  if (value === undefined || value === null) return null;
  if (key === 'draft' && typeof value === 'object' && !Array.isArray(value)) {
    const clone = { ...value };
    // Tránh lưu chuỗi ảnh base64 quá lớn làm nặng database
    for (const k of Object.keys(clone)) {
      if (typeof clone[k] === 'string' && clone[k].startsWith('data:image/') && clone[k].length > 2048) {
        clone[k] = '';
      }
    }
    return clone;
  }
  if (key === 'scheduledPostJobs' && Array.isArray(value)) {
    return sanitizeScheduledJobsForCloud(value);
  }
  return value;
}

function countPayloadItems(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value ? 1 : 0;
}

async function upsertBatches(table, onConflictCols, rows, conflictKeyFn, chunkSize = 200) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, count: 0 };

  // Loại bỏ dòng trùng conflict key ngay trong mảng để Postgres ON CONFLICT không báo lỗi 21000
  const dedupedMap = new Map();
  for (const row of rows) {
    const k = conflictKeyFn(row);
    if (k) dedupedMap.set(k, row);
  }
  const uniqueRows = Array.from(dedupedMap.values());
  let totalWritten = 0;

  for (let i = 0; i < uniqueRows.length; i += chunkSize) {
    const chunk = uniqueRows.slice(i, i + chunkSize);
    await supabaseRequest(`${table}?on_conflict=${encodeURIComponent(onConflictCols)}`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk)
    });
    totalWritten += chunk.length;
  }
  return { ok: true, count: totalWritten };
}

export function extractGroupIdFromUrl(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) return '';
  const m = raw.match(/\/groups\/([^/?#]+)/i);
  if (m && m[1]) return m[1].toLowerCase();
  return raw.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 120);
}

function normalizePhoneRow(username, source, r) {
  if (!r || typeof r !== 'object') return null;
  const cleanPhone = String(r.phone || '').replace(/[^\d+]/g, '');
  const fallbackId = String(r.url || r.postUrl || r.id || r.name || '').trim().slice(0, 160);
  const rawKey = cleanPhone || fallbackId;
  if (!rawKey) return null;

  const dedupeKey = `${source}|${rawKey}`.slice(0, 220);
  return {
    owner_username: username,
    dedupe_key: dedupeKey,
    source,
    phone: cleanPhone || String(r.phone || ''),
    phone_category: String(r.category || ''),
    name: String(r.name || ''),
    category_or_query: String(source === 'maps' ? (r.query || '') : (r.source || '')),
    address_or_snippet: String(source === 'maps' ? (r.address || '') : (r.context || '')).slice(0, 1000),
    group_name: String(r.groupName || ''),
    source_url: String(r.url || r.postUrl || r.groupUrl || r.website || ''),
    updated_at: new Date().toISOString()
  };
}

function normalizeGroupRow(username, g, defaults = {}) {
  if (!g || typeof g !== 'object') return null;
  const rawUrl = String(g.url || g.groupUrl || '').trim();
  const gid = extractGroupIdFromUrl(g.id || rawUrl || g.name);
  if (!gid) return null;

  const privacyRaw = String(g.privacy || g.groupPrivacy || 'unknown').toLowerCase();
  let privacy = 'unknown';
  if (privacyRaw.includes('public') || privacyRaw.includes('công khai')) privacy = 'public';
  else if (privacyRaw.includes('private') || privacyRaw.includes('riêng tư')) privacy = 'private';

  const approvalStatus = String(g.approvalStatus || defaults.approvalStatus || 'uninspected');
  return {
    owner_username: username,
    group_id: gid,
    group_url: rawUrl || `https://www.facebook.com/groups/${gid}/`,
    group_name: String(g.name || g.title || gid).slice(0, 240),
    privacy,
    approval_status: approvalStatus,
    members_count: Number(g.memberCount ?? g.membersCount ?? 0) || 0,
    members_text: String(g.members || g.membersText || ''),
    category_name: String(g.categoryName || defaults.categoryName || ''),
    in_saved_category: Boolean(g.inSavedCategory ?? defaults.inSavedCategory ?? false),
    keyword: String(g.keyword || defaults.keyword || ''),
    updated_at: new Date().toISOString()
  };
}

/**
 * Đẩy các key cấu hình & dữ liệu workspace lên bảng `ntd_workspaces`
 */
export async function supabaseUpsertWorkspaceKeys(username, keyMap) {
  const u = (username || '').trim().toLowerCase();
  if (!u || !keyMap || typeof keyMap !== 'object') return { ok: false, count: 0 };

  const nowIso = new Date().toISOString();
  const rows = [];
  for (const [key, val] of Object.entries(keyMap)) {
    if (!SYNC_WORKSPACE_KEYS.includes(key)) continue;
    const payload = sanitizeWorkspacePayload(key, val);
    if (payload === null) continue;
    rows.push({
      owner_username: u,
      data_key: key,
      payload,
      item_count: countPayloadItems(payload),
      updated_at: nowIso
    });
  }
  if (rows.length === 0) return { ok: true, count: 0 };

  try {
    return await upsertBatches('ntd_workspaces', 'owner_username,data_key', rows, r => `${r.owner_username}|${r.data_key}`, 20);
  } catch (err) {
    if (isMissingTableError(err)) return { ok: false, needTables: true, error: err.message };
    throw err;
  }
}

export async function supabaseFetchWorkspace(username) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return [];
  try {
    const data = await supabaseRequest(`ntd_workspaces?owner_username=eq.${encodeURIComponent(u)}&select=data_key,payload,item_count,updated_at`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

export async function supabaseUpsertScannedPhones(username, source, rawRows) {
  const u = (username || '').trim().toLowerCase();
  if (!u || !Array.isArray(rawRows) || rawRows.length === 0) return { ok: true, count: 0 };
  const mapped = rawRows.map(r => normalizePhoneRow(u, source, r)).filter(Boolean);
  if (mapped.length === 0) return { ok: true, count: 0 };
  try {
    return await upsertBatches('ntd_scanned_phones', 'owner_username,dedupe_key', mapped, r => r.dedupe_key, 200);
  } catch (err) {
    if (isMissingTableError(err)) return { ok: false, needTables: true, error: err.message };
    throw err;
  }
}

export async function supabaseFetchScannedPhones(username, source = null, limit = 1500) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return [];
  const srcFilter = source ? `&source=eq.${encodeURIComponent(source)}` : '';
  try {
    const data = await supabaseRequest(`ntd_scanned_phones?owner_username=eq.${encodeURIComponent(u)}${srcFilter}&select=*&order=scanned_at.desc&limit=${limit}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

export async function supabaseUpsertScannedGroups(username, groups, defaults = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u || !Array.isArray(groups) || groups.length === 0) return { ok: true, count: 0 };
  const mapped = groups.map(g => normalizeGroupRow(u, g, defaults)).filter(Boolean);
  if (mapped.length === 0) return { ok: true, count: 0 };
  try {
    return await upsertBatches('ntd_scanned_groups', 'owner_username,group_id', mapped, r => r.group_id, 200);
  } catch (err) {
    if (isMissingTableError(err)) return { ok: false, needTables: true, error: err.message };
    throw err;
  }
}

export async function supabaseFetchScannedGroups(username, limit = 1500) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return [];
  try {
    const data = await supabaseRequest(`ntd_scanned_groups?owner_username=eq.${encodeURIComponent(u)}&select=*&order=updated_at.desc&limit=${limit}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

/**
 * Đẩy toàn bộ dữ liệu hiện có trên máy (hoặc chỉ danh sách key truyền vào) lên Supabase
 */
export async function pushLocalChangesToSupabase(username, changedKeys = null, options = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u || !(await isSupabaseConfigured())) return { ok: false, skipped: true };

  // Hoàn tất mọi lệnh xóa báo cáo đang chờ trước khi đồng bộ lên Supabase
  await flushPendingCloudClears(u);
  const startLedger = await readCloudClearLedger();

  const keysToRead = changedKeys && Array.isArray(changedKeys) && changedKeys.length > 0
    ? Array.from(new Set(changedKeys))
    : [...SYNC_WORKSPACE_KEYS, 'rinMaps', 'rinFbGroup'];

  const local = await chrome.storage.local.get(keysToRead);
  const wsMap = {};
  for (const k of SYNC_WORKSPACE_KEYS) {
    if (keysToRead.includes(k) && (local[k] !== undefined || options?.[k] !== undefined)) {
      if (k === 'lastScannedGroups' && startLedger.scanned_groups?.pending) continue;
      const simpleScope = SIMPLE_KEY_CLEAR_SCOPE[k];
      if (simpleScope && startLedger[simpleScope]?.pending) continue;
      wsMap[k] = options?.[k] !== undefined ? options[k] : local[k];
    }
  }

  // BẢO VỆ CHỐNG ĐÈ MẤT NICK:
  // Nếu máy hiện tại đang có ít nick hơn Cloud (ví dụ Laptop vừa thêm 3 nick mới mà PC chưa kịp kéo về)
  // và đây KHÔNG PHẢI là thao tác xóa chủ động của người dùng (options.allowReduce !== true):
  // Tự động gộp dữ liệu từ Cloud vào trước khi đẩy lên Supabase!
  if (wsMap.accounts !== undefined && Array.isArray(wsMap.accounts) && !options?.allowReduce) {
    try {
      const cloudWs = await supabaseFetchWorkspace(u);
      const remoteRow = cloudWs.find(r => r && r.data_key === 'accounts');
      const remoteAccs = Array.isArray(remoteRow?.payload) ? remoteRow.payload : [];
      if (remoteAccs.length > wsMap.accounts.length) {
        const mergedAccs = mergeAccountLists(wsMap.accounts, remoteAccs, false);
        wsMap.accounts = mergedAccs;
        await chrome.storage.local.set({ accounts: mergedAccs });
      }
    } catch (_) {}
  }

  let totalRecords = 0;
  let needTables = false;

  if (Object.keys(wsMap).length > 0) {
    const latestBeforeWs = await readCloudClearLedger();
    if (wsMap.lastScannedGroups !== undefined && didScopeClearAdvance(startLedger, latestBeforeWs, 'scanned_groups')) {
      delete wsMap.lastScannedGroups;
    }
    for (const [k, sc] of Object.entries(SIMPLE_KEY_CLEAR_SCOPE)) {
      if (wsMap[k] !== undefined && didScopeClearAdvance(startLedger, latestBeforeWs, sc)) {
        delete wsMap[k];
      }
    }
    if (Object.keys(wsMap).length > 0) {
      const r = await supabaseUpsertWorkspaceKeys(u, wsMap);
      if (r.needTables) needTables = true;
      totalRecords += r.count || 0;

      // Đồng bộ ngay lập tức fb_count và fanpage_count sang bảng ntd_users
      if (wsMap.accounts !== undefined && Array.isArray(wsMap.accounts)) {
        const fbCount = wsMap.accounts.filter(a => a?.type !== 'fanpage').length;
        const fanpageCount = wsMap.accounts.filter(a => a?.type === 'fanpage').length;
        if (fbCount > 0 || fanpageCount > 0 || options.allowReduce) {
          await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              fb_count: fbCount,
              fanpage_count: fanpageCount,
              last_login: new Date().toISOString()
            })
          }).catch(() => {});
        }
      }
    }
  }

  if (keysToRead.includes('rinMaps') && Array.isArray(local.rinMaps?.rows) && local.rinMaps.rows.length > 0) {
    const latestLedger = await readCloudClearLedger();
    if (!didScopeClearAdvance(startLedger, latestLedger, 'maps')) {
      const r = await supabaseUpsertScannedPhones(u, 'maps', local.rinMaps.rows);
      if (r.needTables) needTables = true;
      totalRecords += r.count || 0;
      const afterLedger = await readCloudClearLedger();
      if (didScopeClearAdvance(startLedger, afterLedger, 'maps')) {
        await deleteScopeFromSupabase(u, 'maps').catch(() => {});
      }
    }
  }

  if (keysToRead.includes('rinFbGroup') && Array.isArray(local.rinFbGroup?.rows) && local.rinFbGroup.rows.length > 0) {
    const latestLedger = await readCloudClearLedger();
    if (!didScopeClearAdvance(startLedger, latestLedger, 'fb_group')) {
      const r = await supabaseUpsertScannedPhones(u, 'fb_group', local.rinFbGroup.rows);
      if (r.needTables) needTables = true;
      totalRecords += r.count || 0;
      const afterLedger = await readCloudClearLedger();
      if (didScopeClearAdvance(startLedger, afterLedger, 'fb_group')) {
        await deleteScopeFromSupabase(u, 'fb_group').catch(() => {});
      }
    }
  }

  // Đồng bộ nhóm quét tạm và các nhóm đã lưu danh mục lên bảng ntd_scanned_groups
  if (keysToRead.includes('lastScannedGroups') && Array.isArray(local.lastScannedGroups) && local.lastScannedGroups.length > 0) {
    const latestLedger = await readCloudClearLedger();
    if (!didScopeClearAdvance(startLedger, latestLedger, 'scanned_groups')) {
      const r = await supabaseUpsertScannedGroups(u, local.lastScannedGroups, { inSavedCategory: false });
      if (r.needTables) needTables = true;
      totalRecords += r.count || 0;
      const afterLedger = await readCloudClearLedger();
      if (didScopeClearAdvance(startLedger, afterLedger, 'scanned_groups')) {
        await deleteScopeFromSupabase(u, 'scanned_groups').catch(() => {});
      }
    }
  }
  if (keysToRead.includes('groupCategories') && Array.isArray(local.groupCategories) && local.groupCategories.length > 0) {
    const savedGroups = [];
    for (const cat of local.groupCategories) {
      if (!cat || !Array.isArray(cat.groups)) continue;
      for (const g of cat.groups) {
        if (typeof g === 'string') {
          savedGroups.push({ url: g, categoryName: cat.name || '' });
        } else if (g && typeof g === 'object') {
          savedGroups.push({ ...g, categoryName: cat.name || '' });
        }
      }
    }
    if (savedGroups.length > 0) {
      const r = await supabaseUpsertScannedGroups(u, savedGroups, { inSavedCategory: true });
      if (r.needTables) needTables = true;
      totalRecords += r.count || 0;
    }
  }

  return { ok: !needTables, needTables, count: totalRecords };
}

export function getAccountKey(a) {
  if (!a || typeof a !== 'object') return '';
  const fbId = String(a.fbId || a.cUser || a.uid || '').trim();
  if (fbId && fbId !== '0') return `fb_${fbId}`;
  const email = String(a.email || '').trim().toLowerCase();
  if (email) return `em_${email}`;
  const id = String(a.id || '').trim();
  if (id) return `id_${id}`;
  return '';
}

function mergeAccountObjects(localAcc, remoteAcc) {
  if (!localAcc) return remoteAcc;
  if (!remoteAcc) return localAcc;

  const localSync = Number(localAcc.lastCookieSync) || 0;
  const remoteSync = Number(remoteAcc.lastCookieSync) || 0;
  const useRemoteCookies = (!localAcc.cookies && Boolean(remoteAcc.cookies)) ||
    (Boolean(remoteAcc.cookies) && remoteSync > localSync);

  let mergedGroups = localAcc.groups;
  if (!mergedGroups || (typeof mergedGroups === 'string' && !mergedGroups.trim())) {
    mergedGroups = remoteAcc.groups || '';
  } else if (remoteAcc.groups && typeof remoteAcc.groups === 'string' && remoteAcc.groups.length > String(mergedGroups).length) {
    mergedGroups = remoteAcc.groups;
  }

  return {
    ...remoteAcc,
    ...localAcc,
    cookies: useRemoteCookies ? remoteAcc.cookies : (localAcc.cookies || remoteAcc.cookies || ''),
    lastCookieSync: Math.max(localSync, remoteSync) || Date.now(),
    password: localAcc.password || remoteAcc.password || '',
    twoFactor: localAcc.twoFactor || remoteAcc.twoFactor || '',
    proxy: localAcc.proxy || remoteAcc.proxy || '',
    token: localAcc.token || remoteAcc.token || '',
    fbId: localAcc.fbId || remoteAcc.fbId || '',
    groups: mergedGroups,
    accountGroup: localAcc.accountGroup || remoteAcc.accountGroup || '',
    status: (localAcc.status === 'active' || remoteAcc.status === 'active') ? 'active' : (localAcc.status || remoteAcc.status || 'active')
  };
}

export function mergeAccountLists(localList, remoteList, force = false) {
  const localArr = Array.isArray(localList) ? localList : [];
  const remoteArr = Array.isArray(remoteList) ? remoteList : [];

  if (localArr.length === 0) return [...remoteArr];
  if (remoteArr.length === 0) return [...localArr];

  const resultMap = new Map();
  const remoteKeyMap = new Map();

  for (const r of remoteArr) {
    const k = getAccountKey(r);
    if (k) remoteKeyMap.set(k, r);
  }

  for (const l of localArr) {
    const k = getAccountKey(l);
    if (k && remoteKeyMap.has(k)) {
      resultMap.set(k, mergeAccountObjects(l, remoteKeyMap.get(k)));
    } else {
      const fallbackKey = k || `item_${Math.random()}`;
      resultMap.set(fallbackKey, l);
    }
  }

  for (const r of remoteArr) {
    const k = getAccountKey(r);
    if (k && !resultMap.has(k)) {
      resultMap.set(k, r);
    }
  }

  return Array.from(resultMap.values());
}

function mergeByKey(localList, remoteList, keyFn, preferRemote = false) {
  const localArr = Array.isArray(localList) ? localList : [];
  const remoteArr = Array.isArray(remoteList) ? remoteList : [];
  if (preferRemote && remoteArr.length > 0) {
    const merged = [...remoteArr];
    const seen = new Set(remoteArr.map(keyFn).filter(Boolean));
    for (const item of localArr) {
      const k = keyFn(item);
      if (!k || !seen.has(k)) {
        if (k) seen.add(k);
        merged.push(item);
      }
    }
    return merged;
  }
  const merged = [...localArr];
  const seen = new Set(localArr.map(keyFn).filter(Boolean));
  for (const item of remoteArr) {
    const k = keyFn(item);
    if (!k || !seen.has(k)) {
      if (k) seen.add(k);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Tải & gộp dữ liệu từ Supabase về máy hiện tại (an toàn, không ghi đè khi đang quét dở)
 */
export async function hydrateLocalFromSupabase(username, options = {}) {
  const u = (username || '').trim().toLowerCase();
  const force = Boolean(options.force);
  if (!u || !(await isSupabaseConfigured())) return { ok: false, skipped: true };

  // Hoàn tất mọi lệnh xóa báo cáo đang chờ trước khi kéo dữ liệu từ Supabase về
  const pendingClearScopes = await flushPendingCloudClears(u);
  const startLedger = await readCloudClearLedger();

  const local = await chrome.storage.local.get([
    ...SYNC_WORKSPACE_KEYS,
    'rinMaps',
    'rinFbGroup',
    'dailyScanStats',
    TELEMETRY_LEDGER_KEY,
    'isGroupScanning'
  ]);

  const [wsRows, phoneRows, groupRows] = await Promise.all([
    supabaseFetchWorkspace(u).catch(() => []),
    supabaseFetchScannedPhones(u, null, 1500).catch(() => []),
    supabaseFetchScannedGroups(u, 1500).catch(() => [])
  ]);

  const toSet = {};
  const wsMap = new Map();
  for (const row of wsRows) {
    if (row && row.data_key) wsMap.set(row.data_key, row.payload);
  }

  // 1. Tài khoản Facebook / Fanpage (Tự động gộp đa thiết bị Laptop - PC)
  const remoteAccs = wsMap.get('accounts');
  if (Array.isArray(remoteAccs) && remoteAccs.length > 0) {
    const localAccs = Array.isArray(local.accounts) ? local.accounts : [];
    if (localAccs.length === 0) {
      // Máy chưa có tài khoản hoặc vừa cài mới: Kéo toàn bộ từ Cloud về
      toSet.accounts = remoteAccs;
    } else {
      // Máy đã có tài khoản (ví dụ PC có 17, Laptop có 20):
      // Tự động gộp để bổ sung ngay lập tức các nick mới thêm từ máy khác
      const merged = mergeAccountLists(localAccs, remoteAccs, force);
      if (merged.length !== localAccs.length || force) {
        toSet.accounts = merged;
      }
    }
  }

  // 2. Danh mục nhóm
  const remoteCats = wsMap.get('groupCategories');
  if (Array.isArray(remoteCats) && remoteCats.length > 0) {
    const localCats = Array.isArray(local.groupCategories) ? local.groupCategories : [];
    const merged = mergeByKey(localCats, remoteCats, c => c?.id || c?.name, force);
    if (merged.length > localCats.length || force) toSet.groupCategories = merged;
  }

  // 3. Các key cấu hình / nhật ký đơn lẻ
  const simpleKeys = ['draft', 'scheduledPostJobs', 'dailyPostStats', 'warmupConfig', 'warmupReports', 'rinZalo', 'postedGroupHistory', 'scannedGroupHistory', 'lastSelectedCategory'];
  for (const k of simpleKeys) {
    const simpleScope = SIMPLE_KEY_CLEAR_SCOPE[k];
    if (simpleScope && pendingClearScopes.has(simpleScope)) continue;
    const rv = wsMap.get(k);
    if (rv === undefined || rv === null) continue;
    const lv = local[k];
    const isEmptyLocal = !lv || (Array.isArray(lv) ? lv.length === 0 : (typeof lv === 'object' && Object.keys(lv).length === 0));
    if (isEmptyLocal || force) {
      toSet[k] = rv;
    }
  }

  // 4. Danh sách nhóm quét tạm (`lastScannedGroups`) — chỉ gộp khi không đang quét và không đang chờ xóa
  if (!local.isGroupScanning && !pendingClearScopes.has('scanned_groups')) {
    const remoteScanGroups = Array.isArray(wsMap.get('lastScannedGroups')) ? wsMap.get('lastScannedGroups') : [];
    const tableScanGroups = groupRows
      .filter(g => !g.in_saved_category)
      .map(g => ({
        url: g.group_url,
        name: g.group_name,
        privacy: g.privacy === 'public' ? 'Công khai' : (g.privacy === 'private' ? 'Riêng tư' : 'Chưa rõ'),
        members: g.members_text || (g.members_count ? String(g.members_count) : ''),
        memberCount: g.members_count || 0,
        approvalStatus: g.approval_status || 'uninspected',
        keyword: g.keyword || ''
      }));
    const combinedRemoteGroups = mergeByKey(remoteScanGroups, tableScanGroups, g => extractGroupIdFromUrl(g?.url || g?.id), false);
    if (combinedRemoteGroups.length > 0) {
      const localScanned = Array.isArray(local.lastScannedGroups) ? local.lastScannedGroups : [];
      const merged = mergeByKey(localScanned, combinedRemoteGroups, g => extractGroupIdFromUrl(g?.url || g?.id), force);
      if (merged.length > localScanned.length || force) toSet.lastScannedGroups = merged;
    }
  }

  // 5. SĐT Google Maps (`rinMaps.rows`)
  if (!local.rinMaps?.isScanning && !pendingClearScopes.has('maps')) {
    const remoteMaps = phoneRows.filter(p => p.source === 'maps').map(p => ({
      name: p.name || '',
      phone: p.phone || '',
      address: p.address_or_snippet || '',
      query: p.category_or_query || '',
      url: p.source_url || '',
      website: ''
    }));
    if (remoteMaps.length > 0) {
      const curState = local.rinMaps && typeof local.rinMaps === 'object' ? { ...local.rinMaps } : { job: null, isScanning: false, rows: [], seenKeys: {} };
      const curRows = Array.isArray(curState.rows) ? curState.rows : [];
      const seen = { ...(curState.seenKeys || {}) };
      const mergedRows = mergeByKey(curRows, remoteMaps, r => String(r?.phone || '').replace(/[^\d+]/g, '') || r?.url || r?.name, force);
      for (const mr of mergedRows) {
        const mk = String(mr?.phone || '').replace(/[^\d+]/g, '') || mr?.url || mr?.name;
        if (mk) seen[mk] = true;
      }
      if (mergedRows.length > curRows.length || force) {
        toSet.rinMaps = { ...curState, rows: mergedRows, seenKeys: seen };
      }
    }
  }

  // 6. SĐT Facebook Group (`rinFbGroup.rows`)
  if (!local.rinFbGroup?.isScanning && !pendingClearScopes.has('fb_group')) {
    const remoteFb = phoneRows.filter(p => p.source === 'fb_group').map((p, idx) => ({
      id: `fg_sb_${p.id || idx}`,
      phone: p.phone || '',
      rawPhone: p.phone || '',
      name: p.name || 'Thành viên nhóm',
      source: p.category_or_query || 'Bài viết',
      context: p.address_or_snippet || '',
      postUrl: p.source_url || '',
      groupName: p.group_name || 'Nhóm Facebook',
      groupUrl: p.source_url || '',
      category: p.phone_category || 'current',
      at: p.scanned_at ? new Date(p.scanned_at).toLocaleString('vi-VN') : ''
    }));
    if (remoteFb.length > 0) {
      const curGroupState = local.rinFbGroup && typeof local.rinFbGroup === 'object' ? { ...local.rinFbGroup } : { job: null, isScanning: false, rows: [], seenKeys: {} };
      const curRows = Array.isArray(curGroupState.rows) ? curGroupState.rows : [];
      const seen = { ...(curGroupState.seenKeys || {}) };
      const mergedRows = mergeByKey(curRows, remoteFb, r => String(r?.phone || '').replace(/[^\d+]/g, '') || r?.id, force);
      for (const mr of mergedRows) {
        const fk = String(mr?.phone || '').replace(/[^\d+]/g, '') || mr?.id;
        if (fk) seen[fk] = true;
      }
      if (mergedRows.length > curRows.length || force) {
        toSet.rinFbGroup = { ...curGroupState, rows: mergedRows, seenKeys: seen };
      }
    }
  }

  // Chốt chống xung đột đa tab: nếu người dùng vừa bấm Xóa dữ liệu ở tab khác trong lúc đang tải Supabase, bỏ qua ghi đè key đó
  const endLedger = await readCloudClearLedger();
  for (const [scope, spec] of Object.entries(CLOUD_CLEAR_SPECS)) {
    if (toSet[spec.localKey] !== undefined && didScopeClearAdvance(startLedger, endLedger, scope)) {
      delete toSet[spec.localKey];
    }
  }

  // Bảo vệ telemetry: neo sổ cái cục bộ theo dữ liệu TRƯỚC KHI gộp từ Cloud để không đếm trùng số liệu từ máy khác kéo về
  const todayVn = getVietnamDateStr();
  if ((!local[TELEMETRY_LEDGER_KEY] || local[TELEMETRY_LEDGER_KEY].date !== todayVn) &&
      (toSet.dailyPostStats !== undefined || toSet.rinMaps !== undefined || toSet.rinFbGroup !== undefined)) {
    const prePosts = sumTodayPostsFromMap(local.dailyPostStats, todayVn);
    const ds = local.dailyScanStats;
    const preGroups = Math.max(
      (ds && ds.date === todayVn) ? (Number(ds.groupScans) || 0) : 0,
      countTodayRowsFromStore(local.rinFbGroup?.rows, todayVn, 'fg')
    );
    const preMaps = Math.max(
      (ds && ds.date === todayVn) ? (Number(ds.mapsScans) || 0) : 0,
      countTodayRowsFromStore(local.rinMaps?.rows, todayVn, 'mp')
    );
    toSet[TELEMETRY_LEDGER_KEY] = createFreshTelemetryLedger(todayVn, {
      baselinePosts: prePosts,
      baselineGroups: preGroups,
      baselineMaps: preMaps
    });
  }

  const updatedKeys = Object.keys(toSet);
  if (updatedKeys.length > 0) {
    await chrome.storage.local.set(toSet);
  }
  return {
    ok: true,
    updatedKeys,
    counts: {
      workspaces: wsRows.length,
      phones: phoneRows.length,
      groups: groupRows.length
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// KHO NỘI DUNG DÙNG CHUNG (SHARED CLOUD CONTENT LIBRARY) & BỘ GIẢI MÃ SPIN-TAX
// Hỗ trợ nuôi tài khoản đăng bài lên Trang cá nhân (Timeline), tự động cập nhật từ Cloud
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Bộ giải mã cú pháp Spin-tax {tùy chọn 1|tùy chọn 2|tùy chọn 3}
 * Hỗ trợ cả Spin-tax lồng nhau, trả về chuỗi văn bản ngẫu nhiên duy nhất cho mỗi bài đăng
 */
export function resolveSpintax(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text;
  const spinRegex = /\{([^{}]+)\}/g;
  let maxLoops = 25;
  while (spinRegex.test(str) && maxLoops-- > 0) {
    str = str.replace(spinRegex, (_, choices) => {
      const parts = choices.split('|');
      const pick = parts[Math.floor(Math.random() * parts.length)];
      return pick !== undefined ? pick : '';
    });
  }
  return str.trim();
}

/**
 * Kho nội dung mẫu mặc định chất lượng cao (30 mẫu bài viết tiếng Việt đa dạng thể loại)
 * Tích hợp sẵn Spin-tax phong phú, chống trùng lặp tuyệt đối khi đăng bài cá nhân
 */
export const DEFAULT_SHARED_CONTENT_LIBRARY = [
  // ── 1. Đời sống & Chào ngày mới (doi_song) ──
  {
    id: 'tmpl_ds_01',
    category: 'doi_song',
    categoryName: '☕ Đời sống & Chào ngày mới',
    title: 'Chào ngày mới tích cực & Năng lượng cà phê',
    content: '{Chào buổi sáng|Chúc cả nhà buổi sáng|Hello mọi người|Chào ngày mới}! {Bắt đầu ngày mới với ly cà phê thật thơm|Chúc mọi người một ngày mới tràn đầy năng lượng|Một ngày mới lại bắt đầu với bao dự định mới|Chúc cả nhà một ngày làm việc thật vui vẻ và thuận lợi nhé}! ☕✨',
    badge: 'Tương tác cao',
    tags: ['Đời sống', 'Chào buổi sáng'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ds_02',
    category: 'doi_song',
    categoryName: '☕ Đời sống & Chào ngày mới',
    title: 'Cuối tuần thư giãn cùng gia đình',
    content: '{Cuối tuần rồi|Thứ 7 thảnh thơi|Chủ nhật an lành}, {cả nhà có kế hoạch đi đâu chơi không|mọi người thường làm gì để nạp lại năng lượng|thư giãn thôi nào cả nhà}? {Chúc mọi người có những phút giây thật ấm áp bên gia đình|Tận hưởng những khoảnh khắc bình yên bên người thân yêu nhé}! 🌿',
    badge: 'Tăng Trust',
    tags: ['Đời sống', 'Cuối tuần'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ds_03',
    category: 'doi_song',
    categoryName: '☕ Đời sống & Chào ngày mới',
    title: 'Hoàn thành công việc trong ngày',
    content: '{Một ngày bận rộn nhưng đầy năng lượng|Vừa hoàn thành xong các công việc quan trọng trong ngày|Thời gian trôi nhanh thật, lại sắp hết một ngày}! {Cảm thấy may mắn vì luôn có những người bạn đồng hành tuyệt vời|Cảm ơn những nỗ lực không ngừng nghỉ của chính mình|Nghỉ ngơi và chuẩn bị cho ngày mai thật tốt thôi nào}! 💪',
    badge: 'Chân thực',
    tags: ['Đời sống', 'Công việc'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ds_04',
    category: 'doi_song',
    categoryName: '☕ Đời sống & Chào ngày mới',
    title: 'Tận hưởng thời tiết & Giữ gìn sức khỏe',
    content: '{Thời tiết hôm nay|Trời hôm nay} {mát mẻ thật dễ chịu|đẹp tuyệt vời|trong lành quá}. {Mọi người ra đường nhớ giữ gìn sức khỏe nhé|Chúc cả nhà một ngày ngập tràn niềm vui và may mắn}! 🌤️',
    badge: 'Thân thiện',
    tags: ['Đời sống', 'Thời tiết'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ds_05',
    category: 'doi_song',
    categoryName: '☕ Đời sống & Chào ngày mới',
    title: 'Niềm vui giản dị mỗi ngày',
    content: '{Hạnh phúc đôi khi chỉ là|Niềm vui giản dị mỗi ngày chính là} {được làm công việc mình yêu thích|thấy mọi việc tiến triển tốt đẹp từng ngày|nhận được một lời cảm ơn chân thành từ khách hàng}. {Chúc cả nhà luôn bình an và vui vẻ|Cứ mỉm cười thì may mắn sẽ tự tìm đến}! ❤️',
    badge: 'Lan tỏa niềm vui',
    tags: ['Đời sống', 'Tích cực'],
    updatedAt: 1731800000000
  },

  // ── 2. Kinh nghiệm & Mẹo thực chiến (kinh_nghiem) ──
  {
    id: 'tmpl_kn_01',
    category: 'kinh_nghiem',
    categoryName: '💡 Kinh nghiệm & Mẹo thực chiến',
    title: 'Bài học rút ra sau thời gian làm việc',
    content: '{Hôm nay chia sẻ với mọi người|Góc chia sẻ kinh nghiệm|Sau nhiều năm làm việc, mình nhận ra|Một bài học thực tế mình rút ra}: {Muốn đi nhanh hãy đi một mình, muốn đi xa hãy đi cùng nhau|Chất lượng phục vụ chính là chìa khóa giữ chân khách hàng tốt nhất|Sự kiên trì quan trọng hơn tài năng rất nhiều|Lắng nghe khách hàng chính là cách marketing hiệu quả nhất}. {Mọi người có đồng quan điểm không|Bạn tâm đắc nhất điều nào}? 🎯',
    badge: 'Nhiều Comment',
    tags: ['Kinh nghiệm', 'Làm việc'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_kn_02',
    category: 'kinh_nghiem',
    categoryName: '💡 Kinh nghiệm & Mẹo thực chiến',
    title: '3 thói quen làm việc hiệu quả mỗi ngày',
    content: '{3 thói quen|3 mẹo nhỏ|3 nguyên tắc} {giúp mình làm việc hiệu quả hơn mỗi ngày|giúp tiết kiệm thời gian và giảm áp lực}: 1. {Lên danh sách việc cần làm từ tối hôm trước|Ghi chú rõ ràng 3 việc quan trọng nhất trong ngày}. 2. {Tập trung giải quyết việc khó nhất vào buổi sáng|Ưu tiên xử lý việc tạo ra giá trị cao trước}. 3. {Dành 15 phút cuối ngày để nhìn lại và cải thiện|Luôn giữ tinh thần tích cực trước mọi thử thách}. {Anh em áp dụng thử xem nhé|Hy vọng sẽ hữu ích với mọi người}! 📝',
    badge: 'Giá trị cao',
    tags: ['Kinh nghiệm', 'Kỹ năng'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_kn_03',
    category: 'kinh_nghiem',
    categoryName: '💡 Kinh nghiệm & Mẹo thực chiến',
    title: 'Giá trị cốt lõi của sự chân thành & uy tín',
    content: '{Làm việc gì cũng vậy|Trong kinh doanh hay công việc hàng ngày}, {sự trung thực và uy tín luôn là giá trị cốt lõi|khách hàng luôn cảm nhận được sự tận tâm của bạn|đừng ngại bắt đầu từ những việc nhỏ nhất}. {Uy tín tạo nên thương hiệu|Chân thành luôn chạm đến trái tim}! 🌟',
    badge: 'Xây dựng uy tín',
    tags: ['Kinh nghiệm', 'Uy tín'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_kn_04',
    category: 'kinh_nghiem',
    categoryName: '💡 Kinh nghiệm & Mẹo thực chiến',
    title: 'Sai lầm thường gặp & Cách khắc phục',
    content: '{Một sai lầm phổ biến mà nhiều người hay gặp phải là|Kinh nghiệm xương máu của mình là}: {quá tập trung vào kết quả mà quên đi trải nghiệm của khách hàng|ngại thay đổi khi xu hướng đã thay đổi|chần chừ không hành động ngay khi có ý tưởng hay}. {Bài học quý giá giúp mình trưởng thành hơn mỗi ngày|Thay đổi nhỏ hôm nay tạo kết quả lớn ngày mai}! 💡',
    badge: 'Bài học hay',
    tags: ['Kinh nghiệm', 'Trải nghiệm'],
    updatedAt: 1731800000000
  },

  // ── 3. Thảo luận & Tương tác cao (tuong_tac) ──
  {
    id: 'tmpl_tt_01',
    category: 'tuong_tac',
    categoryName: '💬 Thảo luận & Tương tác cao',
    title: 'Khảo sát: Làm việc văn phòng hay làm từ xa?',
    content: '{Khảo sát nhỏ cuối tuần|Hỏi nhanh đáp vui|Cần xin ý kiến của mọi người}: {Nếu được chọn giữa làm việc tại văn phòng và làm việc từ xa (Work from home)|Theo anh em thì thái độ hay trình độ quan trọng hơn trong công việc|Mọi người thích đi du lịch biển hay lên vùng núi cao hơn}? {Mọi người để lại bình luận chia sẻ quan điểm nhé|Cùng thảo luận rôm rả dưới phần comment nào}! 👇',
    badge: 'Nhiều Comment',
    tags: ['Tương tác', 'Khảo sát'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_tt_02',
    category: 'tuong_tac',
    categoryName: '💬 Thảo luận & Tương tác cao',
    title: 'Câu hỏi kích thích suy ngẫm',
    content: '{Một câu hỏi làm mình suy nghĩ cả ngày hôm nay|Hôm nay mình tình cờ nghe được câu hỏi này rất hay}: "{Thành công đối với bạn định nghĩa là gì?|Điều gì tạo động lực lớn nhất giúp bạn thức dậy mỗi sáng?|Nếu quay lại 5 năm trước, bạn sẽ nhắn nhủ bản thân điều gì?}" {Rất muốn lắng nghe chia sẻ từ mọi người|Ai có câu trả lời hay nhất không nào}? 💭',
    badge: 'Gợi mở',
    tags: ['Tương tác', 'Thảo luận'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_tt_03',
    category: 'tuong_tac',
    categoryName: '💬 Thảo luận & Tương tác cao',
    title: 'Gợi ý giải trí & Đời sống cuối tuần',
    content: '{Cuối tuần rồi|Hôm nay rảnh rỗi một chút}, {mọi người thường nghe bài hát nào để thư giãn|có cuốn sách hoặc bộ phim nào hay giới thiệu cho mình với|anh em có quán cà phê nào view đẹp gợi ý cho mình nhé}! {Cảm ơn cả nhà rất nhiều|Chờ gợi ý của mọi người dưới comment}! ☕🎶',
    badge: 'Gần gũi',
    tags: ['Tương tác', 'Đời sống'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_tt_04',
    category: 'tuong_tac',
    categoryName: '💬 Thảo luận & Tương tác cao',
    title: 'Góc nhìn: Tích lũy hay đầu tư nâng cấp bản thân?',
    content: '{Giữa việc tích lũy tài chính an toàn và đầu tư mạo hiểm để bứt phá|Giữa chọn con đường an toàn và thử thách kinh doanh riêng}, {theo bạn ở thời điểm hiện tại nên ưu tiên điều gì hơn|quan điểm của bạn thế nào}? {Cùng chia sẻ góc nhìn nhé|Bình luận quan điểm của bạn bên dưới nha}! 💬',
    badge: 'Chuyên sâu',
    tags: ['Tương tác', 'Góc nhìn'],
    updatedAt: 1731800000000
  },

  // ── 4. Uy tín & Tri ân đối tác (uy_tin) ──
  {
    id: 'tmpl_ut_01',
    category: 'uy_tin',
    categoryName: '⭐ Uy tín & Tri ân đối tác',
    title: 'Tri ân khách hàng & Người đồng hành',
    content: '{Cảm ơn sự tin tưởng và đồng hành của|Biết ơn sâu sắc tới|Thật hạnh phúc khi nhận được sự ủng hộ nhiệt tình từ} {quý khách hàng và đối tác trong suốt thời gian qua|toàn thể anh chị em bạn bè gần xa}. {Được phục vụ và mang lại giá trị cho mọi người là niềm vinh dự lớn nhất của mình|Sự hài lòng của khách hàng là động lực lớn nhất để nỗ lực mỗi ngày}! 🙏❤️',
    badge: 'Tạo niềm tin',
    tags: ['Uy tín', 'Tri ân'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ut_02',
    category: 'uy_tin',
    categoryName: '⭐ Uy tín & Tri ân đối tác',
    title: 'Hoàn thành bàn giao & Chinh phục mục tiêu',
    content: '{Hoàn thành bàn giao|Vừa xong một dự án mới|Đạt thêm một cột mốc quan trọng}! {Nhìn lại hành trình mới thấy mỗi bước đi đều xứng đáng|Không có áp lực thì không có kim cương|Cảm ơn team và đối tác đã cùng nhau nỗ lực hết mình}. {Sẵn sàng cho những mục tiêu cao hơn tiếp theo|Tiếp tục bứt phá thôi nào}! 🏆',
    badge: 'Chuyên nghiệp',
    tags: ['Uy tín', 'Thành tích'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ut_03',
    category: 'uy_tin',
    categoryName: '⭐ Uy tín & Tri ân đối tác',
    title: 'Phản hồi chân thành từ khách yêu',
    content: '{Khách hàng nhắn tin:|"Hàng dùng rất thích em nhé",|"Dịch vụ bên bạn chu đáo và nhanh nhẹn quá!"} {Những phản hồi chân thành như thế này chính là món quà quý giá nhất|Chỉ cần khách ưng ý là mọi mệt mỏi đều tan biến hết|Luôn đặt chữ TÂM và chữ TÍN lên hàng đầu}! {Cảm ơn cả nhà luôn yêu thương và ủng hộ}! 🥰',
    badge: 'Đánh giá thật',
    tags: ['Uy tín', 'Khách hàng'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_ut_04',
    category: 'uy_tin',
    categoryName: '⭐ Uy tín & Tri ân đối tác',
    title: 'Cam kết chất lượng bền vững',
    content: '{Chặng đường nào trải bước trên hoa hồng cũng có lúc chông gai|Thành quả không đến từ may mắn mà đến từ sự kiên trì và nghiêm túc}. {Luôn cam kết mang lại chất lượng và dịch vụ tốt nhất tới tay khách hàng|Chân thành cảm ơn mọi người đã luôn đồng hành}! 🤝',
    badge: 'Cam kết',
    tags: ['Uy tín', 'Chất lượng'],
    updatedAt: 1731800000000
  },

  // ── 5. Động lực & Cảm hứng (dong_luc) ──
  {
    id: 'tmpl_dl_01',
    category: 'dong_luc',
    categoryName: '🚀 Động lực & Cảm hứng',
    title: 'Bắt đầu từ những gì bạn có',
    content: '{Đừng chờ đợi cơ hội hoàn hảo, hãy bắt đầu từ những gì bạn có|Mỗi ngày là một cơ hội mới để bạn hoàn thiện chính mình|Tương lai thuộc về những ai tin vào vẻ đẹp của ước mơ}! {Hãy luôn vững tin vào con đường mình đã chọn|Không ngừng nỗ lực, thành quả ngọt ngào sẽ đến}! 🌈✨',
    badge: 'Truyền cảm hứng',
    tags: ['Động lực', 'Phát triển'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_dl_02',
    category: 'dong_luc',
    categoryName: '🚀 Động lực & Cảm hứng',
    title: 'Kiên trì vượt qua khó khăn',
    content: '{Khó khăn hôm nay là bài học cho ngày mai|Thất bại chỉ là một điểm dừng chân để nhìn nhận lại, không phải điểm kết thúc}. {Hãy kiên trì thêm một chút nữa|Người chiến thắng không bao giờ bỏ cuộc, và người bỏ cuộc không bao giờ chiến thắng}! 🔥',
    badge: 'Năng lượng cao',
    tags: ['Động lực', 'Ý chí'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_dl_03',
    category: 'dong_luc',
    categoryName: '🚀 Động lực & Cảm hứng',
    title: 'Năng lượng tích cực thu hút may mắn',
    content: '{Năng lượng tích cực sẽ thu hút những điều may mắn|Tâm an thì vạn sự an, suy nghĩ lạc quan cuộc sống tự khắc nhẹ nhàng}. {Chúc mọi người một tuần mới tràn đầy nhiệt huyết và gặt hái nhiều thành công|Cứ đi rồi sẽ đến, cứ gõ cửa rồi sẽ mở}! ☀️',
    badge: 'Lạc quan',
    tags: ['Động lực', 'May mắn'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_dl_04',
    category: 'dong_luc',
    categoryName: '🚀 Động lực & Cảm hứng',
    title: 'Kỷ luật và sự tiến bộ mỗi ngày',
    content: '{Bạn không cần phải vĩ đại để bắt đầu, nhưng bạn phải bắt đầu để trở nên vĩ đại|Kỷ luật chính là cầu nối vững chắc nhất giữa mục tiêu và thành tựu}. {Hôm nay bạn đã tiến thêm một bước đến ước mơ của mình chưa|Cố gắng mỗi ngày 1%, sau một năm bạn sẽ thấy sự khác biệt kỳ diệu}! 🚀',
    badge: 'Kỷ luật',
    tags: ['Động lực', 'Mục tiêu'],
    updatedAt: 1731800000000
  },

  // ── 6. Bán hàng khéo léo & Giá trị (ban_hang) ──
  {
    id: 'tmpl_bh_01',
    category: 'ban_hang',
    categoryName: '🛍️ Bán hàng & Khéo léo',
    title: 'Tư vấn giải pháp tối ưu cho khách hàng',
    content: '{Nhiều anh chị nhắn tin hỏi mình về|Hôm nay giải đáp thắc mắc của rất nhiều khách hàng về|Góc chia sẻ dành cho những ai đang quan tâm đến}: {cách lựa chọn giải pháp phù hợp nhất với nhu cầu|bí quyết tối ưu chi phí mà vẫn đảm bảo hiệu quả vượt trội|kinh nghiệm sử dụng để đạt kết quả tốt nhất}. {Anh chị cần tư vấn chi tiết cứ inbox em hỗ trợ nhiệt tình nhé|Luôn sẵn sàng hỗ trợ mọi người tận tâm 24/7}! 💌',
    badge: 'Khéo léo',
    tags: ['Bán hàng', 'Tư vấn'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_bh_02',
    category: 'ban_hang',
    categoryName: '🛍️ Bán hàng & Khéo léo',
    title: 'Hàng về & Đóng gói phục vụ khách',
    content: '{Đầu tuần hàng về ngập tràn kho|Chuẩn bị đóng gói các đơn hàng gửi tới khách yêu|Lên đơn phục vụ quý khách hàng chu đáo}! {Cảm ơn mọi người luôn ưu ái và tin tưởng ủng hộ bên mình|Cần tư vấn gì cứ ới mình một tiếng là có mặt liền nhé}! 📦🎁',
    badge: 'Đắt khách',
    tags: ['Bán hàng', 'Đơn hàng'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_bh_03',
    category: 'ban_hang',
    categoryName: '🛍️ Bán hàng & Khéo léo',
    title: 'Khách quen giới thiệu khách mới',
    content: '{Chất lượng tạo nên uy tín - Uy tín tạo nên thương hiệu bền vững|Khách cũ quay lại và giới thiệu thêm bạn bè chính là minh chứng rõ nhất cho chất lượng dịch vụ}. {Bên mình luôn cam kết hỗ trợ tận tâm, bảo hành chu đáo|Sự an tâm và hài lòng của khách hàng là ưu tiên số 1}! 💯',
    badge: 'Uy tín cao',
    tags: ['Bán hàng', 'Chăm sóc'],
    updatedAt: 1731800000000
  },
  {
    id: 'tmpl_bh_04',
    category: 'ban_hang',
    categoryName: '🛍️ Bán hàng & Khéo léo',
    title: 'Giải pháp nhỏ giải quyết vấn đề lớn',
    content: '{Một giải pháp nhỏ nhưng giải quyết được vấn đề lớn|Đầu tư đúng chỗ luôn mang lại hiệu quả vượt trội và tiết kiệm thời gian}. {Nếu bạn đang tìm kiếm hướng đi tối ưu cho công việc kinh doanh, đừng ngần ngại trao đổi cùng mình nhé|Inbox mình chia sẻ chi tiết thêm nha}! 🤝',
    badge: 'Giá trị',
    tags: ['Bán hàng', 'Giải pháp'],
    updatedAt: 1731800000000
  }
];

/**
 * Tải Kho nội dung dùng chung từ Cloud Supabase hoặc fallback bộ đệm
 * Đồng bộ toàn bộ danh mục bài viết cho tất cả khách hàng
 */
export async function fetchSharedContentLibrary() {
  try {
    let localLib = [];
    try {
      const resLocal = await chrome.storage.local.get('ntd_shared_content_library');
      localLib = Array.isArray(resLocal.ntd_shared_content_library) ? resLocal.ntd_shared_content_library : [];
    } catch (_) {}

    // Thử kéo bản cập nhật mới nhất từ Cloud Supabase (owner_username = shared_system, data_key = shared_content_library)
    try {
      const res = await supabaseRequest(`ntd_workspaces?data_key=eq.shared_content_library&select=*`);
      if (Array.isArray(res) && res.length > 0 && Array.isArray(res[0]?.payload) && res[0].payload.length > 0) {
        const cloudLib = res[0].payload;
        await chrome.storage.local.set({ ntd_shared_content_library: cloudLib });
        return cloudLib;
      }
    } catch (netErr) {
      console.warn('[Supabase] Không thể kết nối Cloud để tải Kho nội dung, dùng bộ đệm:', netErr.message);
    }

    if (localLib && localLib.length > 0) {
      return localLib;
    }

    // Nếu chưa có, nạp kho bài viết mẫu mặc định
    await chrome.storage.local.set({ ntd_shared_content_library: DEFAULT_SHARED_CONTENT_LIBRARY });
    return DEFAULT_SHARED_CONTENT_LIBRARY;
  } catch (err) {
    console.error('[Supabase] Lỗi fetchSharedContentLibrary:', err);
    return DEFAULT_SHARED_CONTENT_LIBRARY;
  }
}

/**
 * Đẩy Kho nội dung dùng chung lên Cloud Supabase để chia sẻ cho TOÀN BỘ KHÁCH HÀNG
 */
export async function pushSharedContentLibrary(library) {
  if (!Array.isArray(library) || library.length === 0) {
    throw new Error('Dữ liệu Kho nội dung không được rỗng.');
  }

  // 1. Lưu ngay vào máy người dùng
  await chrome.storage.local.set({ ntd_shared_content_library: library });

  // 2. Đẩy lên Supabase ntd_workspaces để mọi khách hàng đồng bộ
  try {
    const row = {
      owner_username: 'shared_system',
      data_key: 'shared_content_library',
      payload: library,
      item_count: library.length,
      updated_at: new Date().toISOString()
    };

    await upsertBatches('ntd_workspaces', 'owner_username,data_key', [row], r => `${r.owner_username}|${r.data_key}`, 10);
    return { ok: true, count: library.length, message: `Đã đồng bộ thành công ${library.length} bài viết lên Cloud cho toàn bộ khách hàng.` };
  } catch (err) {
    console.error('[Supabase] Lỗi pushSharedContentLibrary:', err);
    return { ok: false, error: err.message, localOnly: true, count: library.length };
  }
}

/**
 * Đoạn mã SQL chuẩn để người dùng copy và dán vào Supabase SQL Editor
 */
export const SUPABASE_SETUP_SQL = `-- ====================================================================
-- NTD AGENCY - SUPABASE FULL DATABASE SCHEMA (RBAC + QUẢN LÝ DỮ LIỆU)
-- Chạy đoạn mã này trong: Supabase Dashboard -> SQL Editor -> Run
-- ====================================================================

-- 1. Bảng ntd_users (Tài khoản tool, phân quyền Admin/Member & thống kê)
create table if not exists public.ntd_users (
    id uuid default gen_random_uuid() primary key,
    username text unique not null,
    password text not null,
    role text not null default 'member' check (role in ('admin', 'member')),
    expiry_date date not null default (current_date + interval '30 days'),
    status text not null default 'active' check (status in ('active', 'locked')),
    machine_id text,
    note text default '',
    last_login timestamptz,
    fb_count integer default 0,
    fanpage_count integer default 0,
    today_posts integer default 0,
    today_group_scans integer default 0,
    today_maps_scans integer default 0,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

alter table public.ntd_users
add column if not exists fb_count integer default 0,
add column if not exists fanpage_count integer default 0,
add column if not exists today_posts integer default 0,
add column if not exists today_group_scans integer default 0,
add column if not exists today_maps_scans integer default 0;

-- 2. Bảng ntd_workspaces (Đồng bộ nick FB, danh mục nhóm, cấu hình nuôi acc, bài nháp...)
create table if not exists public.ntd_workspaces (
    id bigint generated always as identity primary key,
    owner_username text not null,
    data_key text not null,
    payload jsonb not null default '{}'::jsonb,
    item_count integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint ntd_workspaces_owner_key_uidx unique (owner_username, data_key)
);
create index if not exists idx_ntd_workspaces_owner on public.ntd_workspaces (owner_username, updated_at desc);

-- 3. Bảng ntd_scanned_phones (Quản lý toàn bộ SĐT quét từ Google Maps & Facebook Group)
create table if not exists public.ntd_scanned_phones (
    id bigint generated always as identity primary key,
    owner_username text not null,
    dedupe_key text not null,
    source text not null check (source in ('maps', 'fb_group')),
    phone text not null default '',
    phone_category text not null default '',
    name text not null default '',
    category_or_query text not null default '',
    address_or_snippet text not null default '',
    group_name text not null default '',
    source_url text not null default '',
    scanned_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint ntd_scanned_phones_owner_key_uidx unique (owner_username, dedupe_key)
);
create index if not exists idx_ntd_phones_owner_source on public.ntd_scanned_phones (owner_username, source, scanned_at desc);
create index if not exists idx_ntd_phones_phone on public.ntd_scanned_phones (phone);

-- 4. Bảng ntd_scanned_groups (Quản lý danh sách nhóm FB đã quét & đã lưu danh mục)
create table if not exists public.ntd_scanned_groups (
    id bigint generated always as identity primary key,
    owner_username text not null,
    group_id text not null,
    group_url text not null,
    group_name text not null default '',
    privacy text not null default 'unknown',
    approval_status text not null default 'uninspected',
    members_count integer not null default 0,
    members_text text not null default '',
    category_name text not null default '',
    in_saved_category boolean not null default false,
    keyword text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint ntd_scanned_groups_owner_gid_uidx unique (owner_username, group_id)
);
create index if not exists idx_ntd_groups_owner_filter on public.ntd_scanned_groups (owner_username, approval_status, privacy);
create index if not exists idx_ntd_groups_saved on public.ntd_scanned_groups (owner_username, in_saved_category);

-- 5. Bật Row Level Security (RLS) & cấp quyền Data API cho cả 4 bảng
alter table public.ntd_users enable row level security;
alter table public.ntd_workspaces enable row level security;
alter table public.ntd_scanned_phones enable row level security;
alter table public.ntd_scanned_groups enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.ntd_users, public.ntd_workspaces, public.ntd_scanned_phones, public.ntd_scanned_groups to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- Chính sách truy cập Data API
drop policy if exists "ntd_users_select" on public.ntd_users;
drop policy if exists "Cho phép đọc người dùng" on public.ntd_users;
create policy "ntd_users_select" on public.ntd_users for select to anon, authenticated using (true);

drop policy if exists "ntd_users_insert" on public.ntd_users;
drop policy if exists "Cho phép thêm người dùng" on public.ntd_users;
create policy "ntd_users_insert" on public.ntd_users for insert to anon, authenticated with check (true);

drop policy if exists "ntd_users_update" on public.ntd_users;
drop policy if exists "Cho phép cập nhật người dùng" on public.ntd_users;
create policy "ntd_users_update" on public.ntd_users for update to anon, authenticated using (true) with check (true);

drop policy if exists "ntd_users_delete" on public.ntd_users;
drop policy if exists "Cho phép xóa người dùng" on public.ntd_users;
create policy "ntd_users_delete" on public.ntd_users for delete to anon, authenticated using (true);

drop policy if exists "ntd_workspaces_all" on public.ntd_workspaces;
create policy "ntd_workspaces_all" on public.ntd_workspaces for all to anon, authenticated using (true) with check (true);

drop policy if exists "ntd_scanned_phones_all" on public.ntd_scanned_phones;
create policy "ntd_scanned_phones_all" on public.ntd_scanned_phones for all to anon, authenticated using (true) with check (true);

drop policy if exists "ntd_scanned_groups_all" on public.ntd_scanned_groups;
create policy "ntd_scanned_groups_all" on public.ntd_scanned_groups for all to anon, authenticated using (true) with check (true);

-- 6. Thêm tài khoản Quản trị viên (Admin) mặc định
insert into public.ntd_users (username, password, role, expiry_date, note)
values
    ('admin', '123456', 'admin', '2030-12-31', 'Tài khoản Quản trị tối cao'),
    ('khach_demo', '123456', 'member', (current_date + interval '30 days'), 'Tài khoản thành viên dùng thử')
on conflict (username) do update
set role = excluded.role,
    expiry_date = excluded.expiry_date;

-- 7. Tự động hóa đặt lại số liệu ngày mới (0h hàng ngày)
-- Hàm đặt lại BÀI HÔM NAY, QUÉT NHÓM, QUÉT MAPS về 0 cho các tài khoản chưa đăng nhập hôm nay
create or replace function public.reset_daily_stats_if_new_day()
returns jsonb
language plpgsql
security definer
as $$
declare
    v_count integer;
    v_start_of_day_vn timestamptz;
begin
    -- 00:00:00 ngày hôm nay theo múi giờ Việt Nam (UTC+7)
    v_start_of_day_vn := date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) at time zone 'Asia/Ho_Chi_Minh';

    update public.ntd_users
    set today_posts = 0,
        today_group_scans = 0,
        today_maps_scans = 0
    where last_login is null
       or last_login < v_start_of_day_vn;

    get diagnostics v_count = row_count;

    return jsonb_build_object(
        'ok', true,
        'reset_count', v_count,
        'executed_at', now()
    );
end;
$$;

grant execute on function public.reset_daily_stats_if_new_day() to anon, authenticated;

-- Nếu dự án Supabase đã bật Extension pg_cron, bạn có thể tự động chạy hàm này vào đúng 00:00 mỗi đêm:
-- select cron.schedule('reset-daily-stats-midnight-vn', '0 17 * * *', 'select public.reset_daily_stats_if_new_day();');

-- Hoàn tất! Cả 4 bảng dữ liệu đã sẵn sàng hoạt động.
`;

