/**
 * NTD Agency - Supabase Database Client & RBAC (supabase.js)
 * Quản lý kết nối cơ sở dữ liệu Supabase, phân quyền Admin/Member và xác thực người dùng.
 */

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
 * Đăng nhập người dùng qua Supabase
 */
export async function supabaseLogin(username, password, machineId) {
  const u = (username || '').trim().toLowerCase();
  const p = (password || '').trim();

  const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
  if (!users || users.length === 0) {
    return { ok: false, error: 'Tài khoản không tồn tại trên hệ thống.' };
  }

  const user = users[0];

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

  // Ghim mã máy (nếu chưa có hoặc khớp)
  let updatedMachine = user.machine_id;
  if (!user.machine_id && machineId) {
    try {
      await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
        method: 'PATCH',
        body: JSON.stringify({ machine_id: machineId, last_login: new Date().toISOString() })
      });
      updatedMachine = machineId;
    } catch (_) {}
  } else {
    // Cập nhật last_login
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
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
      status: user.status || 'active',
      note: user.note || ''
    }
  };
}

/**
 * Kiểm tra trạng thái tài khoản trên Supabase (cho sync ngầm)
 */
export async function supabaseCheckLicense(username) {
  try {
    const u = (username || '').trim().toLowerCase();
    const users = await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}&select=*`);
    if (!users || users.length === 0) return null;

    const user = users[0];
    const expiryDate = new Date(user.expiry_date || user.expiry);
    const role = (user.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';

    // Cập nhật last_login ngầm để ghi nhận phiên hoạt động
    supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
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
      machineId: user.machine_id || ''
    };
  } catch (_) {
    return null;
  }
}

/**
 * [ADMIN] Lấy toàn bộ danh sách người dùng kèm phân quyền
 */
export async function supabaseListUsers() {
  const users = await supabaseRequest(`ntd_users?select=*&order=created_at.desc`);
  const now = new Date();

  return (users || []).map(u => {
    const exp = new Date(u.expiry_date || u.expiry);
    const isExpired = !isNaN(exp.getTime()) && exp < now;
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
      fbCount: Number(u.fb_count) || 0,
      fanpageCount: Number(u.fanpage_count) || 0,
      todayPosts: Number(u.today_posts) || 0,
      todayGroupScans: Number(u.today_group_scans) || 0,
      todayMapsScans: Number(u.today_maps_scans) || 0,
      rawLastLogin: u.last_login || null,
      lastLogin: u.last_login ? new Date(u.last_login).toLocaleString('vi-VN') : 'Chưa đăng nhập',
      createdAt: u.created_at ? new Date(u.created_at).toLocaleDateString('vi-VN') : ''
    };
  });
}

/**
 * [TELEMETRY] Cập nhật số liệu hoạt động của người dùng lên Supabase
 */
export async function supabaseUpdateUserStats(username, stats = {}) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return { ok: false };

  try {
    const payload = {
      fb_count: Number(stats.fb_count) || 0,
      fanpage_count: Number(stats.fanpage_count) || 0,
      today_posts: Number(stats.today_posts) || 0,
      today_group_scans: Number(stats.today_group_scans) || 0,
      today_maps_scans: Number(stats.today_maps_scans) || 0,
      last_login: new Date().toISOString()
    };

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
 * [ADMIN] Xóa tài khoản
 */
export async function supabaseDeleteUser(username) {
  const u = (username || '').trim().toLowerCase();

  await supabaseRequest(`ntd_users?username=eq.${encodeURIComponent(u)}`, {
    method: 'DELETE'
  });

  return { ok: true };
}

// ====================================================================
// ĐỒNG BỘ DỮ LIỆU TOÀN DIỆN (WORKSPACES + SĐT + NHÓM FACEBOOK)
// ====================================================================

export const SYNC_WORKSPACE_KEYS = [
  'accounts',
  'groupCategories',
  'draft',
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
  }
};

const SIMPLE_KEY_CLEAR_SCOPE = {
  warmupReports: 'warmup_reports',
  scannedGroupHistory: 'scanned_group_history',
  postedGroupHistory: 'posted_group_history'
};

async function resolveActiveSyncUsername(explicitUsername = '') {
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
export async function pushLocalChangesToSupabase(username, changedKeys = null) {
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
    if (keysToRead.includes(k) && local[k] !== undefined) {
      if (k === 'lastScannedGroups' && startLedger.scanned_groups?.pending) continue;
      const simpleScope = SIMPLE_KEY_CLEAR_SCOPE[k];
      if (simpleScope && startLedger[simpleScope]?.pending) continue;
      wsMap[k] = local[k];
    }
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

  // 1. Tài khoản Facebook / Fanpage
  const remoteAccs = wsMap.get('accounts');
  if (Array.isArray(remoteAccs) && remoteAccs.length > 0) {
    const localAccs = Array.isArray(local.accounts) ? local.accounts : [];
    const merged = mergeByKey(localAccs, remoteAccs, a => a?.uid || a?.id || a?.email || a?.cookie, force);
    if (merged.length > localAccs.length || force) toSet.accounts = merged;
  }

  // 2. Danh mục nhóm
  const remoteCats = wsMap.get('groupCategories');
  if (Array.isArray(remoteCats) && remoteCats.length > 0) {
    const localCats = Array.isArray(local.groupCategories) ? local.groupCategories : [];
    const merged = mergeByKey(localCats, remoteCats, c => c?.id || c?.name, force);
    if (merged.length > localCats.length || force) toSet.groupCategories = merged;
  }

  // 3. Các key cấu hình / nhật ký đơn lẻ
  const simpleKeys = ['draft', 'dailyPostStats', 'warmupConfig', 'warmupReports', 'rinZalo', 'postedGroupHistory', 'scannedGroupHistory', 'lastSelectedCategory'];
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

-- Hoàn tất! Cả 4 bảng dữ liệu đã sẵn sàng hoạt động.
`;

