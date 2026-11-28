// accounts.js – Quản lý nhiều tài khoản Facebook
import { enforceLicenseGate } from './license.js';
await enforceLicenseGate();
import { initSyncModal, exportJsonBackup, parseJsonFile, applyRestoredData } from './sync_helper.js';
import {
  getTodayDateStr,
  getAccountDailyLimit,
  parseUniversalCookies,
  cookiesObjToStr,
  hasCompleteFacebookCookies,
  isTruncatedXsToken,
  activateAccountSessionDirectly,
  fetchTokenEAAG,
  fetchTokenEAAB,
  fetchProfileByToken,
  fetchFanpagesByToken,
  convertTokenToCookies,
  parseTokenOrCookieInput,
  parseViaString,
  generate2FACode,
  injectCookies,
  parseProxyString,
  formatProxyDisplay,
  normalizeProxyString
} from './core.js';

const $ = id => document.getElementById(id);

if ($('backBtn')) $('backBtn').href = chrome.runtime.getURL('panel.html');

// ── Msg helper ────────────────────────────────────────────────────────────────
const msg = (text, type = 'ok') => {
  const el = $('msg');
  el.textContent = text;
  el.className = type === 'ok' ? 'msg-ok' : 'msg-err';
  if (type === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
};

// ── Proxy tester helper ───────────────────────────────────────────────────────
async function testProxyViaWorker(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) {
    return { ok: false, error: 'Chưa nhập địa chỉ Proxy để kiểm tra.' };
  }
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');

  let res = null;
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      res = await window.chrome.runtime.sendToExtension({
        type: 'TEST_PROXY',
        proxy: proxyStr.trim()
      });
    } catch (e) {
      res = { ok: false, error: e.message || 'Lỗi kết nối tới Extension' };
    }
  }

  if (!res) {
    res = await new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'TEST_PROXY',
          proxy: proxyStr.trim()
        }, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(r || { ok: false, error: 'Không nhận được phản hồi từ extension' });
          }
        });
      } else {
        resolve({ ok: false, error: 'Extension API không khả dụng.' });
      }
    });
  }

  if (res && res.error && (res.error.includes('Lệnh không hợp lệ') || res.error.includes('Invalid command'))) {
    res.error = 'Extension NTD Agency trên trình duyệt đang chạy bản cũ trong bộ nhớ. Hãy vào chrome://extensions và bấm nút ↻ Tải lại (Reload) tiện ích để kích hoạt tính năng kiểm tra Proxy!';
  }
  return res;
}

function handleProxyTestUi(btnEl, inputEl, statusEl) {
  if (!btnEl || !inputEl || !statusEl) return;
  btnEl.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const val = inputEl.value.trim();
    if (!val) {
      statusEl.style.display = 'block';
      statusEl.style.background = '#fffbeb';
      statusEl.style.border = '1px solid #fde68a';
      statusEl.style.color = '#b45309';
      statusEl.textContent = '⚠️ Vui lòng nhập địa chỉ Proxy (IP:Port hoặc IP:Port:User:Pass) trước khi kiểm tra!';
      return;
    }

    const origText = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Đang kiểm tra...';
    statusEl.style.display = 'block';
    statusEl.style.background = '#eff6ff';
    statusEl.style.border = '1px solid #bfdbfe';
    statusEl.style.color = '#1d4ed8';
    statusEl.textContent = '⏳ Đang kết nối thử và đo tốc độ phản hồi qua Proxy...';

    try {
      const res = await testProxyViaWorker(val);
      if (res && res.ok) {
        statusEl.style.background = '#f0fdf4';
        statusEl.style.border = '1px solid #86efac';
        statusEl.style.color = '#15803d';
        statusEl.innerHTML = `✅ <b>Proxy hoạt động tốt!</b> IP thực tế: <code>${res.ip}</code> · Độ trễ: <b>${res.pingMs}ms</b>${res.hasAuth ? ' · Xác thực: OK' : ''}`;
      } else {
        statusEl.style.background = '#fef2f2';
        statusEl.style.border = '1px solid #fca5a5';
        statusEl.style.color = '#dc2626';
        statusEl.innerHTML = `❌ <b>Kiểm tra thất bại:</b> ${res?.error || 'Không thể kết nối qua Proxy này.'}`;
      }
    } catch (err) {
      statusEl.style.background = '#fef2f2';
      statusEl.style.border = '1px solid #fca5a5';
      statusEl.style.color = '#dc2626';
      statusEl.innerHTML = `❌ <b>Lỗi:</b> ${err.message || 'Không thể kiểm tra Proxy'}`;
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = origText;
    }
  };
}

// ── Tab switcher ──────────────────────────────────────────────────────────────
$('tabPass').onclick = () => {
  $('tabPass').classList.add('active');
  $('tabCookie').classList.remove('active');
  $('panePass').classList.add('show');
  $('paneCookie').classList.remove('show');
};
$('tabCookie').onclick = () => {
  $('tabCookie').classList.add('active');
  $('tabPass').classList.remove('active');
  $('paneCookie').classList.add('show');
  $('panePass').classList.remove('show');
};

// ── Quản lý cách ly tài khoản khi bị Spam Rate Limit (3 ngày) ──────────────────
function checkAndReleaseRateLimitAccounts(accounts) {
  if (!Array.isArray(accounts)) return { changed: false, accounts: [], releasedAccounts: [] };

  const now = Date.now();
  let changed = false;
  const releasedAccounts = [];

  const updatedAccounts = accounts.map(acc => {
    if (acc && acc.rateLimitRestrictedUntil) {
      if (now >= acc.rateLimitRestrictedUntil) {
        changed = true;
        const previousGrp = acc.previousAccountGroup || '';
        const oldGroup = acc.accountGroup;

        const restoredAcc = {
          ...acc,
          rateLimitRestricted: false,
          accountGroup: (oldGroup === 'Acc nuôi') ? previousGrp : oldGroup
        };
        delete restoredAcc.rateLimitRestrictedUntil;
        delete restoredAcc.rateLimitRestrictedAt;
        delete restoredAcc.rateLimitReason;
        delete restoredAcc.previousAccountGroup;

        releasedAccounts.push(restoredAcc);
        return restoredAcc;
      }
    }
    return acc;
  });

  return { changed, accounts: updatedAccounts, releasedAccounts };
}

function getRateLimitRemainingText(restrictedUntil) {
  if (!restrictedUntil) return '';
  const diffMs = restrictedUntil - Date.now();
  if (diffMs <= 0) return '0 giờ';
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) {
    return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  }
  return `${hours} giờ`;
}

function isAccountRateLimited(acc) {
  if (!acc) return false;
  return Boolean(acc.rateLimitRestrictedUntil && Date.now() < acc.rateLimitRestrictedUntil);
}

// ── Load / Save accounts ──────────────────────────────────────────────────────
async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  const rawAccounts = accounts || [];
  const { changed, accounts: updatedAccounts } = checkAndReleaseRateLimitAccounts(rawAccounts);
  let finalAccounts = changed ? updatedAccounts : rawAccounts;

  let groupFixed = false;
  finalAccounts.forEach(a => {
    if (a && a.rateLimitRestrictedUntil && Date.now() < a.rateLimitRestrictedUntil) {
      if (a.accountGroup !== 'Acc nuôi') {
        if (!a.previousAccountGroup) a.previousAccountGroup = a.accountGroup || '';
        a.accountGroup = 'Acc nuôi';
        groupFixed = true;
      }
    }
  });

  if (changed || groupFixed) {
    await chrome.storage.local.set({ accounts: finalAccounts });
    const { accountGroupsList = [] } = await chrome.storage.local.get('accountGroupsList');
    const cleanList = Array.isArray(accountGroupsList) ? [...accountGroupsList] : [];
    if (!cleanList.includes('Acc nuôi')) {
      cleanList.push('Acc nuôi');
      await chrome.storage.local.set({ accountGroupsList: cleanList });
    }
    return finalAccounts;
  }
  return finalAccounts;
}
let _saveAccountsCloudSyncTimer = null;
async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      await window.chrome.runtime.sendToExtension({
        type: 'SYNC_DATA_TO_EXTENSION',
        data: { accounts }
      });
    } catch (_) {}
  }
  // Tự động đồng bộ ngay lên Cloud sau khi lưu tài khoản (debounce 1.5s)
  if (_saveAccountsCloudSyncTimer) clearTimeout(_saveAccountsCloudSyncTimer);
  _saveAccountsCloudSyncTimer = setTimeout(() => {
    _saveAccountsCloudSyncTimer = null;
    syncAccountsToCloudImmediately(accounts).catch(() => {});
  }, 1500);
}

// ── Account Groups (Nhóm tài khoản) State & Helpers ───────────────────────────
let currentAccGroupFilter = 'all';
let selectedAccIdsForBulk = new Set();

async function loadAccountGroupsList() {
  const { accountGroupsList = [] } = await chrome.storage.local.get('accountGroupsList');
  const accounts = await loadAccounts();
  const set = new Set();
  if (Array.isArray(accountGroupsList)) {
    accountGroupsList.forEach(g => {
      const s = String(g || '').trim();
      if (s) set.add(s);
    });
  }
  accounts.forEach(a => {
    const g = String(a.accountGroup || '').trim();
    if (g) set.add(g);
    if (a && a.rateLimitRestrictedUntil && Date.now() < a.rateLimitRestrictedUntil) {
      set.add('Acc nuôi');
    }
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
}

async function saveAccountGroupsList(groupsList) {
  const cleanList = Array.from(new Set((groupsList || []).map(g => String(g || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'vi'));
  await chrome.storage.local.set({ accountGroupsList: cleanList });
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      await window.chrome.runtime.sendToExtension({
        type: 'SYNC_DATA_TO_EXTENSION',
        data: { accountGroupsList: cleanList }
      });
    } catch (_) {}
  }
  const accounts = await loadAccounts();
  syncAccountsToCloudImmediately(accounts).catch(() => {});
  return cleanList;
}

function getSelectedOrTypedAccountGroup() {
  const input = $('accGroupNewInput');
  const select = $('accGroupSelect');
  if (input && input.style.display !== 'none' && input.value.trim()) {
    return input.value.trim();
  }
  return select ? select.value.trim() : '';
}

async function sendExtensionCommand(message) {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    return await window.chrome.runtime.sendToExtension(message);
  }
  return await chrome.runtime.sendMessage(message);
}

// ── Kích hoạt session đăng nhập Facebook (có fallback trực tiếp) ─────────────
async function activateSessionWithFallback(accountId, openFacebookTab = true) {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  const accounts = await loadAccounts();
  const acc = accounts.find(a => a.id === accountId);

  // 1. Nếu trên Web Platform và có Extension: đồng bộ ngay và gửi sang Extension Runner
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      await window.chrome.runtime.sendToExtension({
        type: 'SYNC_DATA_TO_EXTENSION',
        data: { accounts }
      });
      const res = await window.chrome.runtime.sendToExtension({
        type: 'ACTIVATE_ACCOUNT_SESSION',
        accountId,
        accountData: acc || null,
        openFacebookTab
      });
      if (res && res.ok) return res;
    } catch (err) {
      console.warn('sendToExtension ACTIVATE_ACCOUNT_SESSION failed:', err);
    }
  }

  // 2. Chạy qua chrome.runtime.sendMessage
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ACTIVATE_ACCOUNT_SESSION',
      accountId,
      accountData: acc || null,
      openFacebookTab
    });
    if (res && res.ok) return res;
    // Nếu worker chưa reload hoặc lỗi bất kỳ, fallback nạp trực tiếp từ tab
    console.warn('Worker trả về không thành công, chạy trực tiếp fallback:', res);
    return await activateAccountSessionDirectly(accountId, openFacebookTab);
  } catch (err) {
    console.warn('Không thể gửi tin nhắn tới worker, chạy trực tiếp fallback:', err);
    return await activateAccountSessionDirectly(accountId, openFacebookTab);
  }
}

// ── Parse / Validate cookies string ──────────────────────────────────────────
function parseCookiesStr(str) {
  return parseUniversalCookies(str);
}
function validateCookies(cookieStr) {
  const obj = parseUniversalCookies(cookieStr);
  if (!obj['c_user']) throw new Error('Cookies thiếu "c_user" – hãy kiểm tra lại định dạng cookies Facebook.');
  if (!obj['xs'])     throw new Error('Cookies thiếu "xs" – hãy kiểm tra lại định dạng cookies Facebook.');

  const xsVal = String(obj['xs'] || '');
  const hasSb = Boolean(obj['sb']);
  // Chuỗi xs chuẩn của Facebook luôn gồm 7 phần phân tách bằng : hoặc %3A và có chữ ký HMAC ở cuối
  const isTruncatedXs = isTruncatedXsToken(xsVal);

  if (!hasSb || isTruncatedXs) {
    const reasons = [];
    if (!hasSb) reasons.push('thiếu "sb" (Secure Browser token)');
    if (isTruncatedXs) reasons.push('chuỗi "xs" bị cắt ngắn thiếu chữ ký bảo mật Facebook');
    throw new Error(`Cookies không đầy đủ (${reasons.join(', ')}). Facebook hiện tại bắt buộc phải có đủ "c_user", "xs", "sb" còn hạn. Khuyên dùng nút "⚡ Lấy cookie từ Facebook đang mở trên Chrome" bên trên để lấy chuẩn 100%!`);
  }

  return obj;
}

// ── Validate group links ──────────────────────────────────────────────────────
function validateGroups(groups) {
  if (!groups) return;
  for (const line of groups.split('\n').map(l => l.trim()).filter(Boolean)) {
    try {
      const u = new URL(line);
      const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
      if (!['www.facebook.com', 'facebook.com'].includes(u.hostname) || !m)
        throw new Error(`Link nhóm không hợp lệ: ${line}`);
    } catch { throw new Error(`Link không hợp lệ: ${line}`); }
  }
}

// ── Progress steps UI ─────────────────────────────────────────────────────────
function setStep(stepId, status) {
  // status: 'done' | 'active' | 'wait'
  const el = $(stepId);
  if (!el) return;
  const icons = { done: '✅', active: '⏳', wait: '○' };
  const text = el.textContent.replace(/^[✅⏳○]\s*/, '');
  el.textContent = icons[status] + ' ' + text;
  el.className = { done: 'step-done', active: 'step-active', wait: 'step-wait' }[status];
}

// ── Helper: Lấy session & cookies Facebook hiện tại trên Chrome ──────────────
async function getCurrentFacebookSession() {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  let extCookieStr = '';
  let extCUser = '';

  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      const extResp = await window.chrome.runtime.sendToExtension({ type: 'GET_FACEBOOK_COOKIES' });
      if (extResp?.ok && (extResp.cookieStr || extResp.cUser)) {
        extCookieStr = extResp.cookieStr || '';
        extCUser = extResp.cUser || '';
      }
    } catch (_) {}
  }

  let allCookies = [];
  if (!extCookieStr && typeof chrome !== 'undefined' && chrome.cookies?.getAll) {
    try {
      allCookies = (await chrome.cookies.getAll({})).filter(c =>
        c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
      );
    } catch (_) {}
  }

  const cookieMap = new Map();
  for (const ck of allCookies) {
    if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
      cookieMap.set(ck.name, ck);
    }
  }

  const cUser = extCUser || cookieMap.get('c_user')?.value || '';
  const cookieStr = extCookieStr || [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');

  return {
    cUser,
    cookieStr,
    hasSession: Boolean(cUser && cookieStr)
  };
}

// Biến theo dõi tiến trình đăng nhập hiện tại để chống pollInterval bắt nhầm cookie nick cũ
let _activeLoginFlowState = null;

// ── Helper: Lưu hoặc cập nhật tài khoản vào cơ sở dữ liệu ───────────────────
async function saveOrUpdateAccountRecord({ accountId = null, name, email, pass, twoFactor, proxy, cookies, token, cUser, groups, accountGroup = '' }) {
  const accounts = await loadAccounts();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanCUser = String(cUser || '').trim();
  const cleanAccId = String(accountId || '').trim();
  const cleanAccGroup = String(accountGroup || '').trim();

  // CHỈ tìm trong tài khoản cá nhân (a.type !== 'fanpage') để tuyệt đối không lưu đè vào bản ghi Fanpage bị ẩn!
  const existingIdx = accounts.findIndex(a =>
    a && a.type !== 'fanpage' && (
      (cleanAccId && a.id === cleanAccId) ||
      (cleanCUser && a.fbId && String(a.fbId).trim() === cleanCUser) ||
      (cleanEmail && a.email && a.email.trim().toLowerCase() === cleanEmail)
    )
  );
  const isExisting = existingIdx >= 0;

  if (isExisting) {
    const cur = accounts[existingIdx];
    cur.type = 'personal';
    cur.name = name || cur.name;
    if (email) cur.email = email;
    if (pass) cur.password = pass;
    if (twoFactor) cur.twoFactor = twoFactor;
    if (proxy !== null && proxy !== undefined) cur.proxy = proxy;
    if (cookies) cur.cookies = cookies;
    if (token) cur.token = token;
    if (cleanCUser) cur.fbId = cleanCUser;
    if (cleanAccGroup) cur.accountGroup = cleanAccGroup;
    cur.status = 'active';
    cur.errorMsg = null;
    cur.lastCookieSync = Date.now();
    if (groups) cur.groups = groups;
    await saveAccounts(accounts);
    syncAccountsToCloudImmediately(accounts).catch(() => {});
    if (cleanAccGroup) {
      loadAccountGroupsList().then(list => {
        if (!list.includes(cleanAccGroup)) saveAccountGroupsList([...list, cleanAccGroup]);
      }).catch(() => {});
    }
    return { isExisting: true, account: cur };
  } else {
    const newAcc = {
      id: cleanAccId || crypto.randomUUID(),
      type: 'personal',
      name: name || (cleanCUser ? `FB Nick (${cleanCUser})` : 'Tài khoản FB'),
      email: email || '',
      password: pass || '',
      twoFactor: twoFactor || null,
      proxy: proxy || null,
      cookies: cookies || '',
      token: token || null,
      groups: groups || '',
      accountGroup: cleanAccGroup || '',
      addedVia: twoFactor ? 'via' : 'password',
      fbId: cleanCUser || '',
      status: 'active',
      errorMsg: null,
      lastCookieSync: Date.now()
    };
    accounts.push(newAcc);
    await saveAccounts(accounts);
    syncAccountsToCloudImmediately(accounts).catch(() => {});
    if (cleanAccGroup) {
      loadAccountGroupsList().then(list => {
        if (!list.includes(cleanAccGroup)) saveAccountGroupsList([...list, cleanAccGroup]);
      }).catch(() => {});
    }
    return { isExisting: false, account: newAcc };
  }
}

// ── Add account via PASSWORD ──────────────────────────────────────────────────
$('loginBtn').onclick = async () => {
  const name   = $('accName').value.trim();
  const email  = $('fbEmail').value.trim();
  const pass   = $('fbPass').value;
  const twoFactor = $('fb2FA')?.value?.trim() || null;
  const proxyRaw  = $('fbProxy')?.value?.trim() || null;
  const normalizedProxy = proxyRaw ? normalizeProxyString(proxyRaw) : null;
  const groups = $('accGroups')?.value?.trim() || '';
  const accountGroup = getSelectedOrTypedAccountGroup();

  if (!name)  { msg('Hãy nhập tên hiển thị.', 'err'); return; }
  if (!email) { msg('Hãy nhập email / số điện thoại.', 'err'); return; }
  if (!pass)  { msg('Hãy nhập mật khẩu.', 'err'); return; }
  if (groups) {
    try { validateGroups(groups); } catch(e) { msg(e.message, 'err'); return; }
  }

  // Ghi nhận phiên Facebook cũ đang mở trên Chrome (nếu có) trước khi bấm đăng nhập
  // để vòng quét cookie TUYỆT ĐỐI KHÔNG bắt nhầm cookie nick cũ rồi ghi đè mất nick mới!
  let preLoginCUser = '';
  try {
    const preSess = await getCurrentFacebookSession();
    if (preSess?.hasSession && preSess.cUser) {
      preLoginCUser = String(preSess.cUser).trim();
    }
  } catch (_) {}

  // Show progress
  $('loginProgress').classList.add('show');
  $('loginBtn').disabled = true;
  $('msg').textContent = '';
  ['step1','step2','step3','step4','step5'].forEach(s => setStep(s, 'wait'));
  const el2fa = $('step_2fa');
  if (el2fa) { el2fa.style.display = 'none'; el2fa.className = 'step-wait'; }
  $('progressTitle').textContent = '🔄 Đang đăng nhập...';

  setStep('step1', 'active');

  let isDone = false;
  let pollInterval = null;
  const loginStartedAt = Date.now();
  const flowState = {
    sessionClearedSeen: !preLoginCUser,
    loginSubmittedSeen: false
  };
  _activeLoginFlowState = flowState;

  const cleanupProgress = (keepPolling = false) => {
    if (!keepPolling && pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (!keepPolling && _activeLoginFlowState === flowState) {
      _activeLoginFlowState = null;
    }
    $('loginBtn').disabled = false;
  };

  const finishLoginSuccessfully = async (cookies, cUser, token = null, accountId = null) => {
    if (isDone) return;
    isDone = true;
    cleanupProgress(false);

    ['step1','step2','step3','step4'].forEach(s => setStep(s, 'done'));
    if (el2fa && el2fa.style.display !== 'none') el2fa.className = 'step-done';
    setStep('step5', 'active');

    const saveRes = await saveOrUpdateAccountRecord({
      accountId,
      name,
      email,
      pass,
      twoFactor,
      proxy: normalizedProxy,
      cookies,
      token,
      cUser,
      groups,
      accountGroup
    });

    setStep('step5', 'done');
    $('progressTitle').textContent = saveRes.isExisting
      ? '✅ Đăng nhập & cập nhật tài khoản thành công!'
      : '✅ Đăng nhập & thêm tài khoản thành công!';

    msg(saveRes.isExisting
      ? `🔄 Đã cập nhật tài khoản "${name}" với Mật khẩu, Cookies và Proxy mới!`
      : `✅ Đã thêm tài khoản "${name}" (FB ID: ${cUser || 'OK'})!`, 'ok');

    // Clear form
    $('accName').value = '';
    $('fbEmail').value = '';
    $('fbPass').value  = '';
    if ($('fb2FA')) $('fb2FA').value = '';
    if ($('fbProxy')) $('fbProxy').value = '';
    if ($('passProxyStatus')) $('passProxyStatus').style.display = 'none';
    if ($('accGroups')) $('accGroups').value = '';
    if ($('accGroupSelect')) $('accGroupSelect').value = '';
    if ($('accGroupNewInput')) {
      $('accGroupNewInput').value = '';
      $('accGroupNewInput').style.display = 'none';
      if ($('accGroupSelect')) $('accGroupSelect').style.display = 'block';
    }
    if ($('btnToggleNewGroupInput')) $('btnToggleNewGroupInput').textContent = '➕ Nhóm mới';

    setTimeout(() => {
      $('loginProgress').classList.remove('show');
      $('progressTitle').textContent = 'Đang đăng nhập…';
      ['step1','step2','step3','step4','step5'].forEach(s => setStep(s, 'wait'));
      if (el2fa) { el2fa.style.display = 'none'; el2fa.className = 'step-wait'; }
    }, 2500);

    await render();
  };

  // Nút 1: Hủy chờ đăng nhập
  const btnCancel = $('btnCancelLoginProgress');
  if (btnCancel) {
    btnCancel.onclick = () => {
      if (isDone) return;
      isDone = true;
      cleanupProgress(false);
      $('loginProgress').classList.remove('show');
      msg('Đã dừng chờ đăng nhập.', 'ok');
    };
  }

  // Nút 2: Bấm lấy Cookie ngay lập tức khi tab Facebook đã đăng nhập
  const btnForce = $('btnForceCaptureCookie');
  if (btnForce) {
    btnForce.onclick = async () => {
      if (isDone) return;
      btnForce.disabled = true;
      const prevText = btnForce.textContent;
      btnForce.textContent = '⏳ Đang quét cookie từ Chrome...';
      try {
        const sess = await getCurrentFacebookSession();
        if (sess.hasSession) {
          await finishLoginSuccessfully(sess.cookieStr, sess.cUser);
          return;
        } else {
          msg('Chưa tìm thấy phiên Facebook (c_user) trên trình duyệt. Vui lòng kiểm tra tab Facebook đã đăng nhập thành công chưa nhé!', 'err');
        }
      } catch (err) {
        msg('Lỗi quét cookie: ' + err.message, 'err');
      } finally {
        btnForce.disabled = false;
        btnForce.textContent = prevText;
      }
    };
  }

  // Vòng quét cookie dự phòng (CHỈ chấp nhận cookie mới SAU KHI phiên nick cũ đã bị xóa sạch)
  pollInterval = setInterval(async () => {
    if (isDone) return;
    try {
      const sess = await getCurrentFacebookSession();
      if (!sess.hasSession) {
        // Đã thấy Chrome xóa sạch cookie cũ!
        flowState.sessionClearedSeen = true;
        return;
      }
      const curCUser = String(sess.cUser || '').trim();
      const elapsed = Date.now() - loginStartedAt;
      const isDifferentUser = Boolean(preLoginCUser && curCUser && curCUser !== preLoginCUser);

      // Chặn tuyệt đối việc bắt nhầm cookie của nick cũ trước khi worker kịp xóa session cũ!
      if (!flowState.sessionClearedSeen && !isDifferentUser) {
        return;
      }
      // Nếu là cùng UID cũ đăng nhập lại, chỉ chấp nhận sau khi đã qua bước xóa phiên + gửi form (ít nhất 4s)
      if (!isDifferentUser && (!flowState.loginSubmittedSeen || elapsed < 4000)) {
        return;
      }
      // Chờ thêm ít nhất 3.5s để DO_LOGIN ưu tiên trả về đầy đủ cả Token + Cookies sạch từ worker
      if (elapsed < 3500) return;

      await finishLoginSuccessfully(sess.cookieStr, curCUser);
    } catch (_) {}
  }, 2000);

  try {
    // Gửi lệnh DO_LOGIN tới Extension Background Worker (kèm autoSaveNewAccount: true làm lưới an toàn kép)
    const loginCmd = sendExtensionCommand({
      type: 'DO_LOGIN',
      accountName: name,
      email,
      password: pass,
      twoFactor,
      proxy: normalizedProxy,
      groups,
      autoSaveNewAccount: true,
      keepSession: true,
      openFacebookTab: true
    });

    // Dù timeoutGuard có chạm ngưỡng trước, nếu DO_LOGIN hoàn tất trễ hơn vẫn tự động lưu nick mới!
    loginCmd.then(async (lateRes) => {
      if (!isDone && lateRes && lateRes.ok && lateRes.cookies) {
        await finishLoginSuccessfully(lateRes.cookies, lateRes.cUser, lateRes.token, lateRes.accountId);
      }
    }).catch(() => {});

    // Nâng ngưỡng chờ lên 125 giây (khớp với thời gian chờ 2FA của worker.js)
    const timeoutGuard = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 125000));
    const result = await Promise.race([loginCmd, timeoutGuard]).catch(e => ({ ok: false, error: e?.message }));

    if (result && result.ok && result.cookies) {
      await finishLoginSuccessfully(result.cookies, result.cUser, result.token, result.accountId);
      return;
    }

    // Nếu lệnh DO_LOGIN kết thúc hoặc timeout nhưng chưa xong:
    if (!isDone) {
      // Quét session 1 lần nữa (CHỈ lấy nếu phiên cũ đã được xóa hoặc là UID khác)
      const finalSess = await getCurrentFacebookSession();
      const finalCUser = String(finalSess.cUser || '').trim();
      const canUseFinalSess = Boolean(
        finalSess.hasSession &&
        (flowState.sessionClearedSeen || (preLoginCUser && finalCUser && finalCUser !== preLoginCUser))
      );
      if (canUseFinalSess) {
        await finishLoginSuccessfully(finalSess.cookieStr, finalCUser);
        return;
      }

      // Vẫn lưu bản nháp tài khoản (không ghi đè Fanpage) để user không mất thông tin
      const accounts = await loadAccounts();
      const cleanEmail = email.trim().toLowerCase();
      const existingIdx = accounts.findIndex(a => a && a.type !== 'fanpage' && a.email && a.email.trim().toLowerCase() === cleanEmail);
      const isExisting = existingIdx >= 0;

      if (isExisting) {
        accounts[existingIdx].name = name || accounts[existingIdx].name;
        accounts[existingIdx].password = pass;
        if (twoFactor) accounts[existingIdx].twoFactor = twoFactor;
        if (normalizedProxy !== null) accounts[existingIdx].proxy = normalizedProxy;
        if (groups) accounts[existingIdx].groups = groups;
        if (accountGroup) accounts[existingIdx].accountGroup = accountGroup;
        await saveAccounts(accounts);
      } else {
        const detectedFbId = email.match(/^\d+$/) ? email : '';
        accounts.push({
          id: crypto.randomUUID(),
          type: 'personal',
          name,
          email,
          password: pass,
          twoFactor: twoFactor || null,
          proxy: normalizedProxy,
          cookies: '',
          token: null,
          groups,
          accountGroup: accountGroup || '',
          addedVia: twoFactor ? 'via' : 'password',
          fbId: detectedFbId,
          lastCookieSync: Date.now()
        });
        await saveAccounts(accounts);
      }
      syncAccountsToCloudImmediately(accounts).catch(() => {});

      // Giữ bảng chờ & vòng quét mở để user hoàn tất đăng nhập thủ công là tự bắt cookie ngay
      setStep('step1', 'done');
      setStep('step2', 'done');
      $('progressTitle').textContent = '⚠️ Hãy đăng nhập trên tab Facebook vừa mở...';
      const errDetail = (result && result.error && !result.timeout) ? ` (${result.error})` : '';
      msg(`⚠️ Tab Facebook đã mở${errDetail}. Khi bạn đã vào được trang Facebook, hệ thống sẽ tự bắt hoặc bạn bấm nút xanh: [⚡ Tab Facebook đã đăng nhập? Bấm lấy Cookie ngay] phía trên!`, 'err');
      await render();
    }
  } catch (e) {
    if (!isDone) {
      cleanupProgress(false);
      $('loginProgress').classList.remove('show');
      msg('❌ ' + e.message, 'err');
    }
  } finally {
    // CHỈ tắt vòng quét nếu đã xong; nếu user đang đăng nhập tay trên tab thì giữ vòng quét tiếp tục chạy
    cleanupProgress(!isDone);
  }
};

$('clearPassFormBtn').onclick = () => {
  $('fbEmail').value = '';
  $('fbPass').value  = '';
  if ($('fbProxy')) $('fbProxy').value = '';
  if ($('passProxyStatus')) $('passProxyStatus').style.display = 'none';
  if ($('accGroups')) $('accGroups').value = '';
  if ($('accGroupSelect')) $('accGroupSelect').value = '';
  if ($('accGroupNewInput')) {
    $('accGroupNewInput').value = '';
    $('accGroupNewInput').style.display = 'none';
    if ($('accGroupSelect')) $('accGroupSelect').style.display = 'block';
  }
  if ($('btnToggleNewGroupInput')) $('btnToggleNewGroupInput').textContent = '➕ Nhóm mới';
  $('msg').textContent = '';
  $('loginProgress').classList.remove('show');
};

// ── Lấy Token & Cookies tự động từ Facebook đang mở trên Chrome ──────────────
const fetchBtn = $('fetchTokenCookieBtn') || $('fetchCurrentCookieBtn');
if (fetchBtn) {
  fetchBtn.onclick = async () => {
    const origText = fetchBtn.textContent;
    fetchBtn.disabled = true;
    fetchBtn.textContent = '⏳ Đang quét Facebook...';
    msg('⏳ Đang quét phiên Facebook, lấy Token và Cookies...');

    try {
      // 1. Quét cookies hiện tại trên Chrome
      let allCookies = [];
      const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
      let extCookieStr = '';
      let extCUser = '';

      if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
        try {
          const extResp = await window.chrome.runtime.sendToExtension({ type: 'GET_FACEBOOK_COOKIES' });
          if (extResp?.ok && extResp.cookieStr) {
            extCookieStr = extResp.cookieStr;
            extCUser = extResp.cUser;
          }
        } catch (_) {}
      }

      if (!extCookieStr) {
        allCookies = (await chrome.cookies.getAll({})).filter(c =>
          c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
        );
      }

      const cookieMap = new Map();
      for (const ck of allCookies) {
        if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
          cookieMap.set(ck.name, ck);
        }
      }
      const cUser = extCUser || cookieMap.get('c_user')?.value;
      if (!cUser && !extCookieStr) {
        msg('Chưa tìm thấy phiên đăng nhập Facebook trên Chrome. Hãy mở tab facebook.com đăng nhập nick trước!', 'err');
        return;
      }

      const cookieStr = extCookieStr || [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');

      // 2. Lấy Token EAAG (Business) và Token EAAB (Ads) từ Facebook (theo cơ chế Get Token Cookie)
      fetchBtn.textContent = '⏳ Đang lấy Token EAAG & EAAB...';
      const [tokenEAAG, tokenEAAB] = await Promise.all([
        fetchTokenEAAG().catch(() => null),
        fetchTokenEAAB().catch(() => null)
      ]);
      const activeToken = tokenEAAG || tokenEAAB;

      // 3. Lấy thông tin tài khoản (Tên & Avatar) từ Graph API hoặc cookies
      let accountName = '';
      if (activeToken) {
        const profile = await fetchProfileByToken(activeToken);
        if (profile.ok && profile.name) {
          accountName = profile.name;
        }
      }

      if (!accountName) {
        accountName = `FB Nick (${cUser})`;
      }

      // 4. Điền vào Form
      if (!$('accName').value.trim()) {
        $('accName').value = accountName;
      }

      // Chuỗi lưu trữ đầy đủ: cookie hoặc cookie|token
      const combinedStr = activeToken ? `${cookieStr}|${activeToken}` : cookieStr;
      $('accCookies').value = combinedStr;

      // 5. Hiển thị thông tin Token đã lấy được
      const tokenBadge = $('tokenBadge');
      const tokenInfoBox = $('tokenInfoBox');
      const tokenInfoContent = $('tokenInfoContent');

      if (tokenBadge) {
        tokenBadge.style.display = 'inline-block';
        tokenBadge.className = 'badge badge-ok';
        tokenBadge.textContent = activeToken ? `Có Token & Cookies` : `Có Cookies`;
      }

      if (tokenInfoBox && tokenInfoContent) {
        tokenInfoBox.style.display = 'block';
        tokenInfoContent.innerHTML = `
          <div><b>Tài khoản:</b> ${accountName} (FB ID: <code>${cUser}</code>)</div>
          ${tokenEAAG ? `<div><b>Token EAAG (Business):</b> <code>${tokenEAAG.slice(0, 25)}...${tokenEAAG.slice(-10)}</code></div>` : ''}
          ${tokenEAAB ? `<div><b>Token EAAB (Ads):</b> <code>${tokenEAAB.slice(0, 25)}...${tokenEAAB.slice(-10)}</code></div>` : ''}
          <div><b>Cookies:</b> Đã bắt đầy đủ <code>${cookieMap.size}</code> cookies hợp lệ</div>
        `;
      }

      msg(`✅ Đã lấy thành công Token & Cookies cho "${accountName}" (FB ID: ${cUser})! Bấm "➕ Thêm & Đăng nhập".`);
    } catch (e) {
      msg('❌ Lỗi: ' + e.message, 'err');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = origText;
    }
  };
}

// ── Kiểm tra VIA, Token & Cookies thời gian thực khi dán vào ô ───────────────
if ($('accCookies')) {
  $('accCookies').oninput = async () => {
    const val = $('accCookies').value.trim();
    const tokenBadge = $('tokenBadge');
    const tokenInfoBox = $('tokenInfoBox');
    const tokenInfoContent = $('tokenInfoContent');

    if (!val) {
      if (tokenBadge) tokenBadge.style.display = 'none';
      if (tokenInfoBox) tokenInfoBox.style.display = 'none';
      return;
    }

    const parsed = parseViaString(val);
    const details = [];

    // 1. Nhận diện UID
    if (parsed.uid) {
      details.push(`<div><b>UID / Tài khoản:</b> <code>${parsed.uid}</code></div>`);
    }

    // 2. Nhận diện Password
    if (parsed.password) {
      details.push(`<div><b>Mật khẩu:</b> <code>${'•'.repeat(Math.min(8, parsed.password.length))}</code></div>`);
    }

    // 3. Nhận diện 2FA Secret Key
    if (parsed.twoFactor) {
      const otp = await generate2FACode(parsed.twoFactor);
      details.push(`<div><b>Mã 2FA Key:</b> <code>${parsed.twoFactor.slice(0, 10)}...</code> &nbsp;<b>Mã 6 số hiện tại:</b> <b style="color:#ea580c;font-size:13px">${otp || '...'}</b> <span style="font-size:10px;color:#059669;font-weight:600">(Tự động giải mã)</span></div>`);
    }

    // 4. Nhận diện Cookies
    if (parsed.cookies) {
      const ckStatus = hasCompleteFacebookCookies(parsed.cookieObj)
        ? '<span style="color:#059669;font-weight:700">Đầy đủ (c_user, xs, sb)</span>'
        : '<span style="color:#d97706;font-weight:700">Thiếu sb/cũ (Hệ thống sẽ tự động dùng Pass+2FA để lấy Cookie chuẩn 100%)</span>';
      details.push(`<div><b>Cookies:</b> ${ckStatus}</div>`);
    }

    // 5. Nhận diện Token & Kiểm tra Graph API
    let tokenStatusText = '';
    if (parsed.token) {
      const profile = await fetchProfileByToken(parsed.token);
      if (profile.ok) {
        tokenStatusText = `Token sống (${profile.name})`;
        details.push(`<div><b>Mã Token:</b> <code>${parsed.token.slice(0, 20)}...</code> &nbsp;<span style="color:#059669;font-weight:700">Hoạt động tốt (${profile.name})</span></div>`);
        if (!$('accName').value.trim()) {
          $('accName').value = profile.name;
        }
      } else {
        tokenStatusText = 'Token cũ / hết hạn';
        details.push(`<div><b>Mã Token:</b> <code>${parsed.token.slice(0, 20)}...</code> &nbsp;<span style="color:#d97706;font-weight:600">Hết hạn (Sẽ tự động cấp Token mới sau khi đăng nhập)</span></div>`);
      }
    }

    // 6. Nhận diện Email / Hotmail
    if (parsed.email) {
      details.push(`<div><b>Email phụ:</b> <code>${parsed.email}</code></div>`);
    }

    // 7. Nhận diện Proxy riêng nếu có trong chuỗi VIA
    if (parsed.proxy) {
      if ($('accProxy') && !$('accProxy').value) {
        $('accProxy').value = parsed.proxy;
      }
      details.push(`<div><b>Proxy riêng:</b> <code>${formatProxyDisplay(parsed.proxy)}</code> &nbsp;<span style="color:#059669;font-weight:700">✓ Đã nhận diện</span></div>`);
    }

    // Cập nhật Badge
    if (tokenBadge) {
      tokenBadge.style.display = 'inline-block';
      if (parsed.type === 'via') {
        tokenBadge.className = 'badge badge-ok';
        tokenBadge.textContent = 'Nhận diện định dạng VIA chuẩn';
      } else if (parsed.token) {
        tokenBadge.className = tokenStatusText.includes('✓') ? 'badge badge-ok' : 'badge badge-warn';
        tokenBadge.textContent = tokenStatusText;
      } else if (parsed.cookies) {
        tokenBadge.className = 'badge badge-ok';
        tokenBadge.textContent = 'Định dạng Cookies';
      }
    }

    // Cập nhật Tên nick nếu chưa có
    if (!$('accName').value.trim() && parsed.uid) {
      $('accName').value = `Nick FB (${parsed.uid})`;
    }

    if (tokenInfoBox && tokenInfoContent) {
      if (details.length > 0) {
        tokenInfoBox.style.display = 'block';
        tokenInfoContent.innerHTML = details.join('');
      } else {
        tokenInfoBox.style.display = 'none';
      }
    }
  };
}

// ── Thêm tài khoản bằng VIA, Token hoặc Cookies ──────────────────────────────
$('addCookieBtn').onclick = async () => {
  const addBtn = $('addCookieBtn');
  const origBtnText = addBtn.textContent;
  let name      = $('accName').value.trim();
  const rawInput  = $('accCookies').value.trim();
  const groups    = $('accGroups')?.value?.trim() || '';
  const accountGroup = getSelectedOrTypedAccountGroup();
  const autoLogin = $('autoLoginAfterAdd') ? $('autoLoginAfterAdd').checked : true;

  if (!rawInput)  { msg('Hãy nhập mã Token, Cookies hoặc chuỗi VIA.', 'err'); return; }

  addBtn.disabled = true;
  addBtn.textContent = '⏳ Đang xử lý...';

  try {
    const parsed = parseViaString(rawInput);
    let cookieObj = parsed.cookieObj || {};
    let cUser = parsed.uid || cookieObj['c_user'] || '';
    let token = parsed.token || null;
    let finalCookieStr = parsed.cookies || '';
    const password = parsed.password || null;
    const twoFactor = parsed.twoFactor || null;
    const proxyRaw = $('accProxy')?.value?.trim() || parsed.proxy || null;
    const normalizedProxy = proxyRaw ? normalizeProxyString(proxyRaw) : null;

    if (groups) {
      try { validateGroups(groups); } catch (e) { msg(e.message, 'err'); return; }
    }

    // 1. Nếu có token: thử kiểm tra xem có sống không
    let isTokenAlive = false;
    if (token) {
      const profile = await fetchProfileByToken(token);
      if (profile.ok) {
        isTokenAlive = true;
        if (!name) name = profile.name;
        if (!cUser) cUser = profile.id;
      }
    }

    const hasCompleteCookies = hasCompleteFacebookCookies(cookieObj);
    const hasBasicAuthCookies = Boolean(cookieObj['c_user'] && cookieObj['xs']);
    let didAutoLoginOk = false;
    let autoLoginError = '';

    // 2. Tự động đăng nhập bằng Pass + 2FA khi VIA chưa có Cookies hoặc Cookies thiếu sb / bị cắt cũ
    if (password && (cUser || parsed.email) && !hasCompleteCookies && (autoLogin || !hasBasicAuthCookies)) {
      msg(`⏳ VIA chưa có Cookies chuẩn (hoặc thiếu sb/cũ). Đang tự động đăng nhập Facebook bằng mật khẩu & 2FA...`);
      addBtn.textContent = '⏳ Đang đăng nhập Facebook...';

      try {
        const loginRes = await sendExtensionCommand({
          type: 'DO_LOGIN',
          email: cUser || parsed.email,
          password: password,
          twoFactor: twoFactor,
          proxy: normalizedProxy,
          keepSession: autoLogin,
          openFacebookTab: autoLogin
        });

        if (loginRes?.ok && loginRes.cookies) {
          didAutoLoginOk = true;
          finalCookieStr = loginRes.cookies;
          cookieObj = parseUniversalCookies(finalCookieStr);
          cUser = loginRes.cUser || cUser;
          if (loginRes.token) token = loginRes.token;
        } else {
          autoLoginError = loginRes?.error || 'Không thể tự động đăng nhập Facebook';
          console.warn('[AddVIA] Auto login không thành công, tiếp tục lưu dữ liệu VIA:', autoLoginError);
        }
      } catch (loginErr) {
        autoLoginError = loginErr?.message || 'Lỗi kết nối Extension';
        console.warn('[AddVIA] Lỗi gọi DO_LOGIN:', loginErr);
      }
    }

    if (!name) name = `Nick FB (${cUser || 'Mới'})`;

    const accounts = await loadAccounts();
    // Kiểm tra xem tài khoản này đã có trong danh sách chưa (CHỈ khớp trong nick cá nhân, không đụng Fanpage)
    const existingIdx = accounts.findIndex(a => {
      if (!a || a.type === 'fanpage') return false;
      if (cUser && a.fbId && String(a.fbId).trim() === String(cUser).trim()) return true;
      if (parsed.email && a.email && a.email.toLowerCase() === parsed.email.toLowerCase()) return true;
      return false;
    });

    let accId;
    if (existingIdx >= 0) {
      accounts[existingIdx].type = 'personal';
      accounts[existingIdx].name = name;
      if (finalCookieStr) accounts[existingIdx].cookies = finalCookieStr;
      if (token) accounts[existingIdx].token = token;
      if (password) accounts[existingIdx].password = password;
      if (twoFactor) accounts[existingIdx].twoFactor = twoFactor;
      if (normalizedProxy !== null) accounts[existingIdx].proxy = normalizedProxy;
      if (cUser) accounts[existingIdx].fbId = cUser;
      if (cUser || parsed.email) accounts[existingIdx].email = cUser || parsed.email || accounts[existingIdx].email;
      accounts[existingIdx].lastCookieSync = Date.now();
      if (groups) accounts[existingIdx].groups = groups;
      if (accountGroup) accounts[existingIdx].accountGroup = accountGroup;
      accId = accounts[existingIdx].id;
      await saveAccounts(accounts);
      syncAccountsToCloudImmediately(accounts).catch(() => {});
      if (accountGroup) {
        loadAccountGroupsList().then(list => {
          if (!list.includes(accountGroup)) saveAccountGroupsList([...list, accountGroup]);
        }).catch(() => {});
      }
      msg(`🔄 Đã cập nhật tài khoản "${name}" (FB ID: ${cUser || 'N/A'})!`);
    } else {
      accId = crypto.randomUUID();
      accounts.push({
        id: accId,
        type: 'personal',
        name,
        email: cUser || parsed.email || '',
        password: password,
        twoFactor: twoFactor,
        proxy: normalizedProxy,
        cookies: finalCookieStr || '',
        token: token || null,
        groups,
        accountGroup: accountGroup || '',
        addedVia: (password && twoFactor) ? 'via' : (token ? 'token' : 'cookies'),
        fbId: cUser || '',
        lastCookieSync: Date.now()
      });
      await saveAccounts(accounts);
      syncAccountsToCloudImmediately(accounts).catch(() => {});
      if (accountGroup) {
        loadAccountGroupsList().then(list => {
          if (!list.includes(accountGroup)) saveAccountGroupsList([...list, accountGroup]);
        }).catch(() => {});
      }
    }

    // 3. Tự động nạp cookies và đăng nhập Facebook trên Chrome nếu được chọn
    if (autoLogin) {
      if (didAutoLoginOk) {
        msg(`✅ Đã tự động đăng nhập Facebook bằng VIA/2FA và lưu "${name}" (FB ID: ${cUser || 'N/A'}) thành công!`);
      } else if (autoLoginError && !hasCompleteFacebookCookies(cookieObj)) {
        msg(`⚠️ Đã lưu tài khoản "${name}", nhưng tự động đăng nhập thất bại: ${autoLoginError}`, 'err');
      } else if (finalCookieStr && (cookieObj['c_user'] && cookieObj['xs'])) {
        msg(`⏳ Đang nạp phiên đăng nhập Facebook cho "${name}"...`);
        const res = await activateSessionWithFallback(accId, true);
        if (res?.ok) {
          if (res.autoRelogged && res.cookies) {
            const refreshedAccs = await loadAccounts();
            const targetAcc = refreshedAccs.find(a => a.id === accId);
            if (targetAcc) {
              targetAcc.cookies = res.cookies;
              if (res.cUser && res.cUser !== 'N/A') targetAcc.fbId = res.cUser;
              targetAcc.lastCookieSync = Date.now();
              await saveAccounts(refreshedAccs);
            }
          }
          msg(`✅ Đã nạp và tự động đăng nhập Facebook thành công cho "${name}" (FB ID: ${res.cUser || cUser})!`);
        } else {
          msg(`❌ Đã lưu tài khoản "${name}", nhưng đăng nhập Facebook thất bại: ${res?.error || 'Cookies không hợp lệ'}`, 'err');
        }
      } else {
        msg(`⚠️ Đã thêm tài khoản "${name}", chưa đủ dữ liệu đăng nhập tự động (${autoLoginError || 'thiếu Cookies/Pass'}).`, 'err');
      }
    } else {
      msg(`✅ Đã thêm tài khoản "${name}" (FB ID: ${cUser || 'N/A'}) thành công!`);
    }

    $('accName').value = '';
    $('accCookies').value = '';
    if ($('accProxy')) $('accProxy').value = '';
    if ($('cookieProxyStatus')) $('cookieProxyStatus').style.display = 'none';
    if ($('accGroups')) $('accGroups').value = '';
    if ($('accGroupSelect')) $('accGroupSelect').value = '';
    if ($('accGroupNewInput')) {
      $('accGroupNewInput').value = '';
      $('accGroupNewInput').style.display = 'none';
      if ($('accGroupSelect')) $('accGroupSelect').style.display = 'block';
    }
    if ($('btnToggleNewGroupInput')) $('btnToggleNewGroupInput').textContent = '➕ Nhóm mới';
    if ($('tokenBadge')) $('tokenBadge').style.display = 'none';
    if ($('tokenInfoBox')) $('tokenInfoBox').style.display = 'none';
    render();
  } catch (err) {
    msg('❌ Lỗi: ' + err.message, 'err');
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = origBtnText;
  }
};

$('clearCookieFormBtn').onclick = () => {
  $('accCookies').value = '';
  if ($('accProxy')) $('accProxy').value = '';
  if ($('cookieProxyStatus')) $('cookieProxyStatus').style.display = 'none';
  if ($('accGroups')) $('accGroups').value  = '';
  if ($('accGroupSelect')) $('accGroupSelect').value = '';
  if ($('accGroupNewInput')) {
    $('accGroupNewInput').value = '';
    $('accGroupNewInput').style.display = 'none';
    if ($('accGroupSelect')) $('accGroupSelect').style.display = 'block';
  }
  if ($('btnToggleNewGroupInput')) $('btnToggleNewGroupInput').textContent = '➕ Nhóm mới';
  $('msg').textContent  = '';
  if ($('tokenBadge')) $('tokenBadge').style.display = 'none';
  if ($('tokenInfoBox')) $('tokenInfoBox').style.display = 'none';
};

// ── Modal Quản lý Nhóm tài khoản Facebook ──────────────────────────────────────
function openManageAccountGroupsModal() {
  let overlay = document.getElementById('manageAccountGroupsModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'manageAccountGroupsModal';
  overlay.className = 'rename-modal-overlay';
  overlay.innerHTML = `
    <div class="rename-modal-card" style="max-width:540px;max-height:90vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc">
        <div style="font-weight:800;font-size:16px;color:#0f172a;display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">📁</span>
          <span>Quản lý Nhóm tài khoản Facebook</span>
        </div>
        <button type="button" class="group-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b;line-height:1;padding:4px" title="Đóng">✕</button>
      </div>
      <div style="padding:18px 20px;overflow-y:auto;flex:1">
        <p style="font-size:12px;color:#64748b;margin:0 0 14px;line-height:1.5">
          Gom tài khoản theo nhóm (VD: <b>Nhóm BĐS, Dàn Nuôi 1, Nick Spa</b>...) giúp bạn lọc danh sách và dễ dàng chọn từng nhóm nick để <b>chia đều bài đăng</b>.
        </p>

        <!-- Thêm nhóm mới -->
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;margin-bottom:16px">
          <label style="display:block;font-size:12px;font-weight:700;color:#1e40af;margin-bottom:6px">➕ Thêm nhóm tài khoản mới:</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="modalNewGroupName" placeholder="Nhập tên nhóm mới (VD: Nhóm 1, BĐS Hà Nội)..." style="flex:1;padding:8px 12px;font-size:13px;border-radius:8px;border:1.5px solid #cbd5e1;background:#fff;color:#0f172a;outline:none">
            <button type="button" class="btn btn-primary" id="modalBtnAddGroup" style="padding:8px 16px;font-size:12.5px;font-weight:700;white-space:nowrap">Thêm</button>
          </div>
        </div>

        <!-- Danh sách các nhóm hiện có -->
        <div style="font-size:12.5px;font-weight:700;color:#0f172a;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
          <span>Danh sách nhóm đã tạo:</span>
          <span id="modalGroupTotalBadge" style="font-size:11px;color:#64748b;font-weight:600">0 nhóm</span>
        </div>
        <div id="modalGroupsListContainer" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;padding-right:4px">
          <!-- Rendered items -->
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 20px;border-top:1px solid #e2e8f0;background:#f8fafc">
        <button type="button" class="btn btn-light group-modal-close" style="padding:8px 18px;font-size:13px;font-weight:600">Đóng</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
  };

  overlay.querySelectorAll('.group-modal-close').forEach(b => b.onclick = close);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const inputNew = overlay.querySelector('#modalNewGroupName');
  const btnAdd = overlay.querySelector('#modalBtnAddGroup');
  const listContainer = overlay.querySelector('#modalGroupsListContainer');
  const badgeTotal = overlay.querySelector('#modalGroupTotalBadge');

  const refreshList = async () => {
    const allGroups = await loadAccountGroupsList();
    const accounts = await loadAccounts();
    const personal = accounts.filter(a => a.type !== 'fanpage');
    badgeTotal.textContent = `${allGroups.length} nhóm`;

    if (!allGroups.length) {
      listContainer.innerHTML = `<div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px">Chưa có nhóm nào được tạo. Hãy nhập tên nhóm phía trên và bấm Thêm!</div>`;
      return;
    }

    listContainer.innerHTML = '';
    allGroups.forEach(g => {
      const count = personal.filter(a => a.accountGroup === g).length;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;gap:10px';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          <span style="font-size:15px">📁</span>
          <span class="group-name-text" style="font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g}</span>
          <span style="font-size:11px;background:#f1f5f9;color:#475569;padding:2px 6px;border-radius:10px;font-weight:600;white-space:nowrap">${count} nick</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <button type="button" class="btn btn-light btn-rename-grp" style="padding:4px 8px;font-size:11px;font-weight:600" title="Đổi tên nhóm này">✏️ Đổi tên</button>
          <button type="button" class="btn btn-light btn-del-grp" style="padding:4px 8px;font-size:11px;font-weight:600;color:#dc2626;border-color:#fca5a5" title="Xóa nhóm này (tài khoản trong nhóm sẽ chuyển về Chưa phân nhóm)">🗑 Xóa</button>
        </div>
      `;

      // Rename
      row.querySelector('.btn-rename-grp').onclick = async () => {
        const newName = prompt(`Nhập tên mới cho nhóm "${g}":`, g);
        if (!newName || !newName.trim() || newName.trim() === g) return;
        const cleanNew = newName.trim();
        const currentGroups = await loadAccountGroupsList();
        const updatedList = currentGroups.map(name => name === g ? cleanNew : name);
        await saveAccountGroupsList(updatedList);

        // Update in accounts
        const curAccs = await loadAccounts();
        let changed = false;
        curAccs.forEach(a => {
          if (a.accountGroup === g) {
            a.accountGroup = cleanNew;
            changed = true;
          }
        });
        if (changed) {
          await saveAccounts(curAccs);
          syncAccountsToCloudImmediately(curAccs).catch(() => {});
        }
        msg(`✏️ Đã đổi tên nhóm thành "${cleanNew}".`);
        await refreshList();
        await render();
      };

      // Delete
      row.querySelector('.btn-del-grp').onclick = async () => {
        if (!confirm(`Xóa nhóm "${g}"?\n\nCác tài khoản đang thuộc nhóm này sẽ không bị xóa, chỉ được chuyển về trạng thái "Chưa phân nhóm".`)) return;
        const currentGroups = await loadAccountGroupsList();
        const updatedList = currentGroups.filter(name => name !== g);
        await saveAccountGroupsList(updatedList);

        // Clear in accounts
        const curAccs = await loadAccounts();
        let changed = false;
        curAccs.forEach(a => {
          if (a.accountGroup === g) {
            a.accountGroup = '';
            changed = true;
          }
        });
        if (changed) {
          await saveAccounts(curAccs);
          syncAccountsToCloudImmediately(curAccs).catch(() => {});
        }
        if (currentAccGroupFilter === g) currentAccGroupFilter = 'all';
        msg(`🗑 Đã xóa nhóm "${g}".`);
        await refreshList();
        await render();
      };

      listContainer.appendChild(row);
    });
  };

  btnAdd.onclick = async () => {
    const val = inputNew.value.trim();
    if (!val) { alert('Vui lòng nhập tên nhóm!'); return; }
    const currentGroups = await loadAccountGroupsList();
    if (currentGroups.includes(val)) {
      alert(`Nhóm "${val}" đã tồn tại!`);
      return;
    }
    await saveAccountGroupsList([...currentGroups, val]);
    inputNew.value = '';
    msg(`➕ Đã tạo nhóm "${val}".`);
    await refreshList();
    await render();
  };

  inputNew.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnAdd.click();
    }
  });

  refreshList();
}

$('btnToggleNewGroupInput')?.addEventListener('click', () => {
  const select = $('accGroupSelect');
  const input = $('accGroupNewInput');
  const btn = $('btnToggleNewGroupInput');
  if (!select || !input || !btn) return;
  const isInputVisible = input.style.display !== 'none';
  if (isInputVisible) {
    input.style.display = 'none';
    select.style.display = 'block';
    btn.textContent = '➕ Nhóm mới';
    btn.title = 'Chuyển sang gõ nhóm mới';
  } else {
    select.style.display = 'none';
    input.style.display = 'block';
    input.focus();
    btn.textContent = '📋 Danh sách nhóm';
    btn.title = 'Chuyển sang chọn từ danh sách nhóm có sẵn';
  }
});

$('openManageGroupsLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  openManageAccountGroupsModal();
});
$('openManageGroupsBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  openManageAccountGroupsModal();
});

// ── Hộp thoại Đổi tên tài khoản Facebook chuyên nghiệp ──────────────────────────
function openRenameModal({ id, currentName, fbId = '', type = 'personal' }) {
  let overlay = document.getElementById('renameAccountModal');
  if (overlay) overlay.remove();

  const isPage = type === 'fanpage';
  const labelType = isPage ? 'Fanpage' : 'tài khoản Facebook';

  overlay = document.createElement('div');
  overlay.id = 'renameAccountModal';
  overlay.className = 'rename-modal-overlay';
  overlay.innerHTML = `
    <div class="rename-modal-card">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">
        <div style="font-weight:700;font-size:16px;color:#0f172a;display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">✏️</span>
          <span>Đổi tên ${labelType}</span>
        </div>
        <button type="button" class="rename-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b;line-height:1;padding:4px" title="Đóng">✕</button>
      </div>
      <div style="padding:20px">
        <div style="font-size:12.5px;color:#64748b;margin-bottom:14px;background:#f8fafc;padding:10px 14px;border-radius:10px;border:1px solid #e2e8f0;line-height:1.6">
          <div><b>Tên hiện tại:</b> <span style="color:#0f172a;font-weight:700">${currentName}</span></div>
          ${fbId ? `<div><b>${isPage ? 'Page ID' : 'Facebook ID'}:</b> <code style="font-size:11.5px;padding:2px 6px;background:#e2e8f0;border-radius:4px;color:#0f172a;font-weight:600">${fbId}</code></div>` : ''}
        </div>
        <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:700;color:#0f172a">
          Tên gợi nhớ mới (theo khách hàng / dự án):
        </label>
        <input type="text" id="renameModalInput" value="${currentName.replace(/"/g, '&quot;')}" placeholder="VD: [Khách BĐS] Anh Tú, Nick 01 - Chị Lan Spa..." style="width:100%;box-sizing:border-box;padding:10px 14px;font-size:14px;border:1.5px solid #cbd5e1;border-radius:8px;outline:none;background:#ffffff;color:#0f172a;font-family:inherit;font-weight:600">
        
        <div style="margin-top:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:11.5px;color:#64748b;font-weight:600">Gợi ý mẫu tiền tố:</span>
          <button type="button" class="rename-tag-chip" data-prefix="[Khách BĐS] " style="font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:600;color:#334155">+ [Khách BĐS]</button>
          <button type="button" class="rename-tag-chip" data-prefix="[Khách Spa] " style="font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:600;color:#334155">+ [Khách Spa]</button>
          <button type="button" class="rename-tag-chip" data-prefix="[Dự án] " style="font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:600;color:#334155">+ [Dự án]</button>
          <button type="button" class="rename-tag-chip" data-prefix="[Nick chính] " style="font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:600;color:#334155">+ [Nick chính]</button>
          <button type="button" class="rename-tag-chip" data-prefix="[Nick phụ] " style="font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:600;color:#334155">+ [Nick phụ]</button>
        </div>

        <div style="font-size:12px;color:#64748b;margin-top:14px;line-height:1.5;background:#eff6ff;padding:10px 12px;border-radius:8px;border:1px solid #bfdbfe">
          💡 <b>Tác dụng:</b> Tên mới sẽ hiển thị ngay trên bảng quản lý, thanh chọn tài khoản, tiến độ đăng bài và cả tin nhắn báo cáo Zalo giúp bạn quản lý bài đăng cho từng khách hàng thuận tiện nhất.
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc">
        <button type="button" class="btn btn-light rename-modal-cancel" style="padding:8px 16px;font-size:13px;font-weight:600">Hủy (Esc)</button>
        <button type="button" class="btn btn-primary rename-modal-save" style="padding:8px 22px;font-size:13px;font-weight:700">💾 Lưu tên mới (Enter)</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input = overlay.querySelector('#renameModalInput');
  const closeBtn = overlay.querySelector('.rename-modal-close');
  const cancelBtn = overlay.querySelector('.rename-modal-cancel');
  const saveBtn = overlay.querySelector('.rename-modal-save');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', handleKey);
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') doSave();
  };
  document.addEventListener('keydown', handleKey);

  closeBtn.onclick = close;
  cancelBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  overlay.querySelectorAll('.rename-tag-chip').forEach(chip => {
    chip.onclick = () => {
      const p = chip.dataset.prefix;
      if (!input.value.startsWith(p)) {
        input.value = p + input.value.replace(/^\[[^\]]+\]\s*/, '');
      }
      input.focus();
    };
  });

  const doSave = async () => {
    const newName = input.value.trim();
    if (!newName) {
      alert('Vui lòng nhập tên tài khoản.');
      input.focus();
      return;
    }

    try {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Đang lưu...';

      const accounts = await loadAccounts();
      const targetAcc = accounts.find(a => a.id === id);
      if (!targetAcc) throw new Error('Không tìm thấy tài khoản.');

      targetAcc.name = newName;

      // Cập nhật parentAccountName cho Fanpage con (nếu có)
      for (const a of accounts) {
        if (a.type === 'fanpage' && a.parentAccountId === id) {
          a.parentAccountName = newName;
        }
      }
      await saveAccounts(accounts);

      // Cập nhật tên trong chiến dịch đang chạy/chờ (nếu có)
      const { campaigns = {} } = await chrome.storage.local.get('campaigns');
      if (campaigns[id]) {
        campaigns[id].accountName = newName;
        await chrome.storage.local.set({ campaigns });
      }

      close();
      msg(`✅ Đã đổi tên ${labelType} thành "${newName}"!`);
      render();
    } catch (err) {
      alert('Lỗi lưu tên: ' + err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Lưu tên mới (Enter)';
    }
  };

  saveBtn.onclick = doSave;

  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

// ── Render account list (Chỉ tài khoản cá nhân / VIA) ─────────────────────────
async function render() {
  const accounts = await loadAccounts();
  const personalAccounts = accounts.filter(a => a.type !== 'fanpage');
  const allGroups = await loadAccountGroupsList();

  // Cập nhật dropdown chọn nhóm ở form thêm nick và toolbar bulk
  const updateGroupDropdowns = () => {
    const selForm = $('accGroupSelect');
    if (selForm) {
      const curVal = selForm.value || '';
      selForm.innerHTML = `<option value="">-- Chưa phân nhóm (Mặc định) --</option>` +
        allGroups.map(g => `<option value="${g.replace(/"/g, '&quot;')}">📁 ${g}</option>`).join('');
      if (curVal && allGroups.includes(curVal)) selForm.value = curVal;
    }
    const selBulk = $('bulkAssignGroupSelect');
    if (selBulk) {
      selBulk.innerHTML = `<option value="">-- Chọn nhóm tài khoản --</option>` +
        allGroups.map(g => `<option value="${g.replace(/"/g, '&quot;')}">📁 ${g}</option>`).join('');
    }
  };
  updateGroupDropdowns();

  // Tính số lượng tài khoản theo nhóm
  const totalCount = personalAccounts.length;
  const unassignedCount = personalAccounts.filter(a => !a.accountGroup || !a.accountGroup.trim()).length;
  const groupCountsMap = {};
  allGroups.forEach(g => { groupCountsMap[g] = 0; });
  personalAccounts.forEach(a => {
    const g = String(a.accountGroup || '').trim();
    if (g) groupCountsMap[g] = (groupCountsMap[g] || 0) + 1;
  });

  // Render pills vào #accGroupPillsContainer
  const pillsContainer = $('accGroupPillsContainer');
  if (pillsContainer) {
    pillsContainer.innerHTML = `
      <button type="button" class="acc-group-pill ${currentAccGroupFilter === 'all' ? 'active' : ''}" data-group="all">
        Tất cả <span class="pill-count">${totalCount}</span>
      </button>
      <button type="button" class="acc-group-pill ${currentAccGroupFilter === 'unassigned' ? 'active' : ''}" data-group="unassigned">
        Chưa phân nhóm <span class="pill-count">${unassignedCount}</span>
      </button>
      ${allGroups.map(g => `
        <button type="button" class="acc-group-pill ${currentAccGroupFilter === g ? 'active' : ''}" data-group="${g.replace(/"/g, '&quot;')}">
          📁 ${g} <span class="pill-count">${groupCountsMap[g] || 0}</span>
        </button>
      `).join('')}
    `;
    pillsContainer.querySelectorAll('.acc-group-pill').forEach(pill => {
      pill.onclick = () => {
        currentAccGroupFilter = pill.dataset.group || 'all';
        render();
      };
    });
  }

  // Lọc tài khoản theo nhóm đang chọn
  let filteredAccounts = personalAccounts;
  if (currentAccGroupFilter === 'unassigned') {
    filteredAccounts = personalAccounts.filter(a => !a.accountGroup || !a.accountGroup.trim());
  } else if (currentAccGroupFilter !== 'all') {
    filteredAccounts = personalAccounts.filter(a => a.accountGroup === currentAccGroupFilter);
  }

  const { campaigns, groupCategories, dailyPostStats, draft: savedDraft } = await chrome.storage.local.get(['campaigns', 'groupCategories', 'dailyPostStats', 'draft']);
  const cats = groupCategories || [];
  const statsMap = dailyPostStats || {};
  const todayStr = getTodayDateStr();
  const globalDailyLimit = savedDraft?.dailyLimit ? Number(savedDraft.dailyLimit) : 20;
  const customDailyLimits = (savedDraft?.accountDailyLimits && typeof savedDraft.accountDailyLimits === 'object') ? savedDraft.accountDailyLimits : null;

  if ($('countBadge')) {
    const filterDesc = currentAccGroupFilter === 'all' ? '' : (currentAccGroupFilter === 'unassigned' ? ' (Chưa phân nhóm)' : ` (${currentAccGroupFilter})`);
    $('countBadge').textContent = `${filteredAccounts.length}/${personalAccounts.length} nick cá nhân${filterDesc}`;
  }

  const list = $('accList');
  if (!list) return;
  list.replaceChildren();

  if (!personalAccounts.length) {
    list.innerHTML = `<div class="empty-state"><p>Chưa có tài khoản Facebook cá nhân nào. Hãy thêm tài khoản đầu tiên!</p></div>`;
    return;
  }
  if (!filteredAccounts.length) {
    list.innerHTML = `<div class="empty-state"><p>Không có tài khoản nào trong nhóm "${currentAccGroupFilter}". Hãy chọn nhóm khác hoặc gán nick vào nhóm này!</p></div>`;
    return;
  }

  for (const acc of filteredAccounts) {
    const campaign = campaigns?.[acc.id];
    const isRunning = campaign?.state === 'running';
    const cUser = parseCookiesStr(acc.cookies || '')['c_user'];

    let statusBadge = `<span class="badge badge-ok" title="Đang tự động đồng bộ cookie theo thời gian thực">Cookie OK · Tự động đồng bộ</span>`;
    if (!cUser) statusBadge = `<span class="badge badge-warn">Cookies lỗi</span>`;
    if (isRunning) statusBadge += `<span class="badge badge-run">Đang chạy</span>`;

    const isRestricted = isAccountRateLimited(acc);
    const remText = isRestricted ? getRateLimitRemainingText(acc.rateLimitRestrictedUntil) : '';
    if (isRestricted) {
      statusBadge += ` <span class="badge" style="background:#fee2e2;color:#dc2626;border:1px solid #fecaca;font-weight:700" title="Tài khoản gặp cảnh báo Spam Rate Limit, đang cách ly 3 ngày trong nhóm 'Acc nuôi'. Hết 3 ngày sẽ tự động mở khóa.">⏳ Cách ly 3 ngày (còn ${remText})</span>`;
    }

    if (acc.addedVia === 'via' || (acc.password && acc.twoFactor)) {
      statusBadge += ` <span class="badge" style="background:#fff4ed;color:#ea580c;border:1px solid #fdba74">VIA (Pass+2FA)</span>`;
    } else if (acc.addedVia === 'password') {
      statusBadge += ` <span class="badge badge-pass">Mật khẩu</span>`;
    } else if (acc.token) {
      statusBadge += ` <span class="badge" style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe">Token</span>`;
    } else {
      statusBadge += ` <span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1">Cookies</span>`;
    }

    const proxyBadge = acc.proxy
      ? `<span class="badge badge-proxy" title="Tài khoản này sử dụng Proxy riêng: ${acc.proxy}">🌐 Proxy: ${formatProxyDisplay(acc.proxy)}</span>`
      : `<span class="badge badge-direct" title="Tài khoản này kết nối trực tiếp qua IP máy của bạn">🌐 IP máy</span>`;

    const groupLines = acc.groups?.trim().split('\n').filter(Boolean) || [];
    const groupInfo  = groupLines.length ? `${groupLines.length} nhóm riêng` : `<span style="color:#059669;font-weight:600">Dùng chung nhóm</span>`;

    const emailInfo = acc.email ? ` · ${acc.email}` : '';
    const syncTimeInfo = acc.lastCookieSync
      ? ` &nbsp;·&nbsp; <span style="color:#059669;font-weight:600">Tự động cập nhật: ${new Date(acc.lastCookieSync).toLocaleTimeString('vi-VN', {hour12:false})}</span>`
      : ` &nbsp;·&nbsp; <span style="color:#059669">Tự động đồng bộ</span>`;

    const todayRecord = statsMap[acc.id];
    const todayCount = (todayRecord && todayRecord.date === todayStr) ? (Number(todayRecord.count) || 0) : 0;
    const maxDaily = getAccountDailyLimit(acc, globalDailyLimit, customDailyLimits);
    const hasCustomLimit = Boolean(customDailyLimits && customDailyLimits[acc.id] !== undefined && Number(customDailyLimits[acc.id]) >= 1);
    const dailyInfo = ` &nbsp;·&nbsp; Hôm nay: <b style="color:${todayCount >= maxDaily ? '#dc2626' : '#059669'}">${todayCount}/${maxDaily} bài</b> (Tối đa ${maxDaily} bài/ngày${hasCustomLimit ? ' · Riêng' : ''})`;

    const isChecked = selectedAccIdsForBulk.has(acc.id);
    const card = document.createElement('div');
    card.className = `acc-card ${isChecked ? 'bulk-selected' : ''}`;
    card.id = `card_${acc.id}`;
    card.innerHTML = `
      <div style="display:flex;gap:12px;align-items:flex-start">
        <input type="checkbox" class="acc-select-cb" data-id="${acc.id}" ${isChecked ? 'checked' : ''} style="cursor:pointer;accent-color:#ea580c;width:17px;height:17px;margin-top:4px;flex-shrink:0" title="Chọn tài khoản để chuyển nhóm">
        <div style="flex:1;min-width:0">
          <div class="acc-name">
            <span class="acc-name-text" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" data-fbid="${cUser || ''}" data-type="personal" title="Bấm vào tên để đổi tên tài khoản nhanh">
              <span>${acc.name}</span>
              <span class="acc-rename-hint" title="Đổi tên">✏️</span>
            </span>
            ${acc.accountGroup ? `<span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;font-weight:700" title="Nhóm tài khoản: ${acc.accountGroup}">📁 ${acc.accountGroup}</span>` : ''}
            ${statusBadge} ${proxyBadge}
          </div>
          <div class="acc-meta">
            FB ID: <code class="acc-id-code">${cUser || '???'}</code>${emailInfo}${syncTimeInfo}
            &nbsp;·&nbsp; Nhóm FB đăng bài: ${groupInfo}
            ${dailyInfo}
          </div>
          ${groupLines.length ? `<div class="acc-groups" title="Danh sách nhóm riêng">${groupLines.join('\n')}</div>` : ''}
        </div>
      </div>
      <div class="acc-actions" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary login-fb-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="font-size:11px;padding:4px 10px;font-weight:700" title="Chuyển trình duyệt sang đăng nhập tài khoản này và mở Facebook">Đăng nhập FB</button>
        <button type="button" class="btn btn-light refresh-cookie-btn" data-id="${acc.id}" title="Lấy cookie mới nhất từ tab Facebook đang mở trên Chrome và lưu vào nick này" style="font-size:11px;padding:4px 8px;border:1px solid #059669;color:#059669;font-weight:700">Đồng bộ cookie</button>
        <button type="button" class="btn btn-light rename-acc-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" data-fbid="${cUser || ''}" data-type="personal" style="font-size:11px;padding:4px 8px;border:1px solid #cbd5e1;color:var(--text);font-weight:700;display:flex;align-items:center;gap:4px" title="Đổi tên gợi nhớ cho tài khoản theo yêu cầu khách hàng / dự án">✏️ Đổi tên</button>
        ${todayCount > 0 ? `<button type="button" class="btn btn-light reset-daily-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="font-size:11px;padding:4px 8px;border:1px solid #d97706;color:#d97706;font-weight:700" title="Đặt lại số bài đã đăng hôm nay của tài khoản này về 0">Đặt lại (${todayCount})</button>` : ''}
        <button class="icon-btn edit-btn" data-id="${acc.id}" title="Chỉnh sửa danh sách nhóm &amp; thông tin chi tiết">⚙️</button>
        <button class="icon-btn del" data-id="${acc.id}" title="Xóa tài khoản này">🗑</button>
      </div>
      <div class="acc-edit-box" id="editBox_${acc.id}" style="display:none">
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Tên hiển thị:</span>
          <input type="text" class="edit-name" value="${acc.name.replace(/"/g, '&quot;')}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Nhóm tài khoản:</span>
          <select class="edit-acc-group" style="margin-top:4px;width:100%;padding:8px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a">
            <option value="">-- Chưa phân nhóm --</option>
            ${allGroups.map(g => `<option value="${g.replace(/"/g, '&quot;')}" ${acc.accountGroup === g ? 'selected' : ''}>📁 ${g}</option>`).join('')}
          </select>
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Email / SĐT đăng nhập:</span>
          <input type="text" class="edit-email" placeholder="email@gmail.com hoặc SĐT" value="${acc.email || ''}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Mật khẩu Facebook (để tự động đăng nhập khi bị đăng xuất):</span>
          <input type="password" class="edit-pass" placeholder="Nhập mật khẩu Facebook nếu muốn tự động đăng nhập..." value="${acc.password || ''}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Mã bảo mật 2FA Secret Key (để tự động giải mã không cần nhập tay):</span>
          <input type="text" class="edit-2fa" placeholder="Ví dụ: JBSWY3DPEHPK3PXP..." value="${acc.twoFactor || ''}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:12px;font-weight:600;color:var(--text)">Proxy riêng cho nick (IP:Port hoặc IP:Port:User:Pass):</span>
            <button type="button" class="btn btn-light test-edit-proxy-btn" data-id="${acc.id}" style="font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid #cbd5e1;font-weight:600" title="Kiểm tra kết nối và độ trễ của Proxy">⚡ Kiểm tra Proxy</button>
          </div>
          <input type="text" class="edit-proxy" placeholder="VD: 160.250.59.145:30146:user:pass hoặc IP:Port (để trống = dùng IP máy)" value="${acc.proxy || ''}" style="margin-top:2px">
          <div class="edit-proxy-status" id="editProxyStatus_${acc.id}" style="display:none;font-size:11.5px;margin-top:4px;padding:4px 8px;border-radius:6px"></div>
        </label>
        <label style="margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:4px">
            <span style="font-size:12px;font-weight:600;color:var(--text)">Danh sách nhóm riêng cho "${acc.name}":</span>
            ${cats.length ? `
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:11px;color:var(--accent)">Nạp từ danh mục:</span>
                <select class="cat-fill-select" data-id="${acc.id}" style="width:auto;padding:2px 6px;font-size:11px;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;border-radius:6px">
                  <option value="">-- Chọn danh mục --</option>
                  ${cats.map(c => `<option value="${c.id}">${c.name} (${(c.links||'').split(/\r?\n/).filter(Boolean).length} nhóm)</option>`).join('')}
                </select>
              </div>` : ''}
          </div>
          <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Mỗi dòng 1 link (https://www.facebook.com/groups/...). Để trống để dùng chung nhóm ở bảng chính.</span>
          <textarea class="edit-groups" rows="5" placeholder="https://www.facebook.com/groups/ten-nhom-1/&#10;https://www.facebook.com/groups/ten-nhom-2/&#10;Để trống = dùng chung nhóm ở bảng chính">${acc.groups || ''}</textarea>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button type="button" class="btn btn-light cancel-edit-btn" data-id="${acc.id}" style="padding:6px 14px;font-size:12px">Hủy</button>
          <button type="button" class="btn btn-primary save-edit-btn" data-id="${acc.id}" style="padding:6px 16px;font-size:12px">💾 Lưu thay đổi</button>
        </div>
      </div>`;
    list.append(card);
  }

  // Handle Cat Fill Select
  list.querySelectorAll('.cat-fill-select').forEach(sel => {
    sel.onchange = () => {
      const catId = sel.value;
      if (!catId) return;
      const cat = cats.find(c => c.id === catId);
      if (!cat) return;
      const box = sel.closest('.acc-edit-box');
      const textarea = box?.querySelector('.edit-groups');
      if (textarea) {
        textarea.value = cat.links || '';
        msg(`📁 Đã nạp nhóm từ danh mục "${cat.name}". Nhớ bấm "Lưu thay đổi"!`);
      }
    };
  });

  // Handle Rename Account Modal (Cả nút "Đổi tên" và bấm trực tiếp vào Tên tài khoản)
  list.querySelectorAll('.rename-acc-btn, .acc-name-text').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const currentName = el.dataset.name;
      const fbId = el.dataset.fbid || '';
      const type = el.dataset.type || 'personal';
      openRenameModal({ id, currentName, fbId, type });
    };
  });

  // Toggle Edit Box
  list.querySelectorAll('.icon-btn.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (!box) return;
      const isOpen = box.style.display !== 'none';
      list.querySelectorAll('.acc-edit-box').forEach(b => { if (b !== box) b.style.display = 'none'; });
      box.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        const textarea = box.querySelector('.edit-groups');
        if (textarea) textarea.focus();
      }
    };
  });

  // Cancel Edit
  list.querySelectorAll('.cancel-edit-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (box) box.style.display = 'none';
    };
  });

  // Save Edit
  list.querySelectorAll('.save-edit-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (!box) return;

      const newName = box.querySelector('.edit-name').value.trim();
      const newEmail = box.querySelector('.edit-email')?.value?.trim() || '';
      const newPass = box.querySelector('.edit-pass')?.value || '';
      const new2FA = box.querySelector('.edit-2fa')?.value?.trim() || '';
      const newProxyRaw = box.querySelector('.edit-proxy')?.value?.trim() || '';
      const newProxy = newProxyRaw ? normalizeProxyString(newProxyRaw) : null;
      if (newProxyRaw && !newProxy) {
        msg('Định dạng Proxy không hợp lệ. Vui lòng nhập: IP:Port hoặc IP:Port:User:Pass!', 'err');
        return;
      }
      const newGroups = box.querySelector('.edit-groups').value.trim();

      if (!newName) {
        msg('Tên hiển thị không được để trống.', 'err');
        return;
      }

      try {
        validateGroups(newGroups);
      } catch (e) {
        msg(e.message, 'err');
        return;
      }

      const accs = await loadAccounts();
      const acc = accs.find(a => a.id === id);
      if (!acc) return;

      acc.name = newName;
      if (newEmail) acc.email = newEmail;
      if (newPass) acc.password = newPass;
      acc.twoFactor = new2FA || null;
      acc.proxy = newProxy;
      acc.groups = newGroups;
      const newAccGroup = box.querySelector('.edit-acc-group')?.value || '';
      acc.accountGroup = newAccGroup;

      for (const a of accs) {
        if (a.type === 'fanpage' && a.parentAccountId === id) {
          a.parentAccountName = newName;
        }
      }
      await saveAccounts(accs);

      const { campaigns = {} } = await chrome.storage.local.get('campaigns');
      if (campaigns[id]) {
        campaigns[id].accountName = newName;
        await chrome.storage.local.set({ campaigns });
      }

      msg(`✅ Đã cập nhật tài khoản "${newName}".`);
      render();
    };
  });

  // Handle Login / Activate Facebook Session for Account
  list.querySelectorAll('.login-fb-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Đang vào...';
      try {
        const accounts = await loadAccounts();
        const acc = accounts.find(a => a.id === id);

        // 1. Thử kích hoạt phiên (worker tự kiểm tra và fallback sang Pass+2FA nếu cookie thiếu sb/hết hạn)
        const res = await activateSessionWithFallback(id, true);
        if (res?.ok) {
          if (res.autoRelogged && res.cookies) {
            const refreshed = await loadAccounts();
            const targetAcc = refreshed.find(a => a.id === id);
            if (targetAcc) {
              targetAcc.cookies = res.cookies;
              if (res.cUser && res.cUser !== 'N/A') targetAcc.fbId = res.cUser;
              targetAcc.lastCookieSync = Date.now();
              await saveAccounts(refreshed);
              render();
            }
          }
          msg(`✅ Đã chuyển đổi Facebook sang tài khoản "${name}" (FB ID: ${res.cUser})!`);
        } else if (acc?.password && (acc?.email || acc?.fbId)) {
          // 2. Nếu cookies hết hạn và có Mật khẩu -> Tự động đăng nhập lại bằng Pass + 2FA
          msg(`⏳ Cookies của "${name}" đã hết hạn. Đang tự động đăng nhập lại bằng mật khẩu & 2FA...`);
          const loginRes = await sendExtensionCommand({
            type: 'DO_LOGIN',
            email: acc.email || acc.fbId,
            password: acc.password,
            twoFactor: acc.twoFactor || null,
            proxy: acc.proxy || null,
            existingAccountId: acc.id,
            openFacebookTab: true,
            keepSession: true
          });
          if (loginRes?.ok) {
            if (loginRes.cookies) {
              const refreshed = await loadAccounts();
              const targetAcc = refreshed.find(a => a.id === id);
              if (targetAcc) {
                targetAcc.cookies = loginRes.cookies;
                if (loginRes.token) targetAcc.token = loginRes.token;
                if (loginRes.cUser) targetAcc.fbId = loginRes.cUser;
                targetAcc.lastCookieSync = Date.now();
                await saveAccounts(refreshed);
              }
            }
            msg(`✅ Đã tự động đăng nhập Facebook thành công cho "${name}"!`);
            render();
          } else {
            msg(`❌ Lỗi đăng nhập lại: ${loginRes?.error || 'Không xác định'}`, 'err');
          }
        } else {
          msg(`❌ Lỗi đăng nhập: ${res?.error || 'Không xác định'}`, 'err');
        }
      } catch (e) {
        msg('Lỗi: ' + e.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    };
  });

  // Handle Refresh Cookies From Chrome
  list.querySelectorAll('.refresh-cookie-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        const allCookies = (await chrome.cookies.getAll({})).filter(c =>
          c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
        );
        const cookieMap = new Map();
        for (const ck of allCookies) {
          if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
            cookieMap.set(ck.name, ck);
          }
        }
        const cUser = cookieMap.get('c_user');
        if (!cUser || !cUser.value) {
          msg('Chưa tìm thấy phiên đăng nhập Facebook trên Chrome. Hãy mở tab facebook.com đăng nhập trước.', 'err');
          return;
        }

        const accounts = await loadAccounts();
        const acc = accounts.find(a => a.id === id);
        if (!acc) return;

        const currentCUser = String(cUser.value).trim();
        const expectedCUser = acc.fbId || parseUniversalCookies(acc.cookies || '')['c_user'];
        if (expectedCUser && expectedCUser !== currentCUser) {
          if (!confirm(`Cảnh báo: Tab Facebook trên Chrome đang đăng nhập nick khác (FB ID: ${currentCUser}), khác với "${acc.name}" (FB ID: ${expectedCUser}).\n\nBạn có chắc chắn muốn ghi đè cookie của nick này thành FB ID ${currentCUser} không?`)) {
            return;
          }
        }

        const cookieStr = [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');
        acc.cookies = cookieStr;
        acc.fbId = currentCUser;
        acc.lastCookieSync = Date.now();
        await saveAccounts(accounts);
        msg(`✅ Đã cập nhật phiên cookies mới cho "${acc.name}" (FB ID: ${currentCUser})!`);
        render();
      } catch (e) {
        msg('Lỗi cập nhật cookies: ' + e.message, 'err');
      }
    };
  });

  // Handle Reset Daily Count For Single Account
  list.querySelectorAll('.reset-daily-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`Đặt lại số bài group đã đăng hôm nay của tài khoản "${name}" về 0?`)) return;
      try {
        await chrome.runtime.sendMessage({ type: 'RESET_DAILY_COUNT', accountId: id });
        msg(`✅ Đã đặt lại số bài hôm nay của "${name}" về 0.`);
        render();
      } catch (e) { msg('Lỗi đặt lại: ' + e.message, 'err'); }
    };
  });

  // Handle Proxy Test inside Account Edit Box
  list.querySelectorAll('.test-edit-proxy-btn').forEach(btn => {
    const id = btn.dataset.id;
    const box = $(`editBox_${id}`);
    const input = box?.querySelector('.edit-proxy');
    const status = box?.querySelector('.edit-proxy-status');
    if (btn && input && status) {
      handleProxyTestUi(btn, input, status);
    }
  });

  // Delete Account
  list.querySelectorAll('.icon-btn.del').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const accs = await loadAccounts();
      const acc = accs.find(a => a.id === id);
      if (!acc || !confirm(`Xóa tài khoản "${acc.name}"?`)) return;
      const remaining = accs.filter(a => a.id !== id);
      await saveAccounts(remaining);
      const { campaigns } = await chrome.storage.local.get('campaigns');
      if (campaigns?.[id]) { delete campaigns[id]; await chrome.storage.local.set({ campaigns }); }
      msg('Đã xóa tài khoản.');
      render();
      syncAccountsToCloudImmediately(remaining);
    };
  });

  // ── Xử lý thao tác chọn hàng loạt (Bulk Bar) ──────────────────────────────
  const updateBulkBar = () => {
    const bulkBar = $('accBulkBar');
    const countEl = $('bulkSelectedCount');
    const selectAllCb = $('bulkSelectAllCb');
    if (!bulkBar) return;
    const selectedCount = selectedAccIdsForBulk.size;
    if (countEl) countEl.textContent = selectedCount;
    bulkBar.style.display = selectedCount > 0 ? 'flex' : 'none';
    if (selectAllCb) {
      selectAllCb.checked = filteredAccounts.length > 0 && filteredAccounts.every(a => selectedAccIdsForBulk.has(a.id));
    }
  };
  updateBulkBar();

  // Checkbox từng thẻ nick
  list.querySelectorAll('.acc-select-cb').forEach(cb => {
    cb.onchange = (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      const card = $(`card_${id}`);
      if (cb.checked) {
        selectedAccIdsForBulk.add(id);
        if (card) card.classList.add('bulk-selected');
      } else {
        selectedAccIdsForBulk.delete(id);
        if (card) card.classList.remove('bulk-selected');
      }
      updateBulkBar();
    };
  });

  // Checkbox chọn tất cả
  const bulkSelectAllCb = $('bulkSelectAllCb');
  if (bulkSelectAllCb) {
    bulkSelectAllCb.onchange = () => {
      if (bulkSelectAllCb.checked) {
        filteredAccounts.forEach(a => {
          selectedAccIdsForBulk.add(a.id);
          const card = $(`card_${a.id}`);
          if (card) card.classList.add('bulk-selected');
        });
      } else {
        filteredAccounts.forEach(a => {
          selectedAccIdsForBulk.delete(a.id);
          const card = $(`card_${a.id}`);
          if (card) card.classList.remove('bulk-selected');
        });
      }
      list.querySelectorAll('.acc-select-cb').forEach(cb => {
        cb.checked = selectedAccIdsForBulk.has(cb.dataset.id);
      });
      updateBulkBar();
    };
  }

  // Nút Áp dụng chuyển nhóm
  const btnApplyBulkGroup = $('btnApplyBulkGroup');
  if (btnApplyBulkGroup) {
    btnApplyBulkGroup.onclick = async () => {
      const targetGroup = $('bulkAssignGroupSelect')?.value;
      if (!targetGroup) {
        msg('Vui lòng chọn một nhóm tài khoản để gán!', 'err');
        return;
      }
      if (selectedAccIdsForBulk.size === 0) {
        msg('Chưa chọn tài khoản nào.', 'err');
        return;
      }
      const accs = await loadAccounts();
      let count = 0;
      accs.forEach(a => {
        if (selectedAccIdsForBulk.has(a.id)) {
          a.accountGroup = targetGroup;
          count++;
        }
      });
      await saveAccounts(accs);
      syncAccountsToCloudImmediately(accs).catch(() => {});
      msg(`📁 Đã chuyển ${count} tài khoản vào nhóm "${targetGroup}"!`, 'ok');
      selectedAccIdsForBulk.clear();
      render();
    };
  }

  // Nút Bỏ khỏi nhóm
  const btnRemoveBulkGroup = $('btnRemoveBulkGroup');
  if (btnRemoveBulkGroup) {
    btnRemoveBulkGroup.onclick = async () => {
      if (selectedAccIdsForBulk.size === 0) {
        msg('Chưa chọn tài khoản nào.', 'err');
        return;
      }
      const accs = await loadAccounts();
      let count = 0;
      accs.forEach(a => {
        if (selectedAccIdsForBulk.has(a.id)) {
          a.accountGroup = '';
          count++;
        }
      });
      await saveAccounts(accs);
      syncAccountsToCloudImmediately(accs).catch(() => {});
      msg(`📁 Đã đưa ${count} tài khoản về trạng thái "Chưa phân nhóm"!`, 'ok');
      selectedAccIdsForBulk.clear();
      render();
    };
  }

  // Nút Bỏ chọn
  const btnCancelBulkSelect = $('btnCancelBulkSelect');
  if (btnCancelBulkSelect) {
    btnCancelBulkSelect.onclick = () => {
      selectedAccIdsForBulk.clear();
      list.querySelectorAll('.acc-select-cb').forEach(cb => cb.checked = false);
      list.querySelectorAll('.acc-card').forEach(card => card.classList.remove('bulk-selected'));
      updateBulkBar();
    };
  }
}

// ── Đồng bộ danh sách tài khoản ngay lập tức lên Supabase khi thêm/xóa ───────
async function syncAccountsToCloudImmediately(remainingAccs) {
  try {
    let username = '';
    try {
      const { checkCurrentLicense } = await import('./license.js');
      const lic = await checkCurrentLicense(false);
      username = (lic?.username || '').trim().toLowerCase();
    } catch (_) {}
    if (!username) {
      try {
        const lic = JSON.parse(localStorage.getItem('ntd_store_license') || 'null');
        username = (lic?.username || '').trim().toLowerCase();
      } catch (_) {}
    }
    if (!username) return;

    const sb = await import('./supabase.js?v=20261126_1635');
    if (typeof sb.pushLocalChangesToSupabase === 'function') {
      await sb.pushLocalChangesToSupabase(username, ['accounts'], { allowReduce: true, accounts: remainingAccs });
    }

    const all = Array.isArray(remainingAccs) ? remainingAccs : [];
    const fbCount = all.filter(a => a.type !== 'fanpage').length;
    const fanpageCount = all.filter(a => a.type === 'fanpage').length;

    if (typeof sb.supabaseUpdateUserStats === 'function') {
      await sb.supabaseUpdateUserStats(username, {
        fb_count: fbCount,
        fanpage_count: fanpageCount
      });
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ntd_force_telemetry'));
      if (typeof window.ntdForceReportActivity === 'function') {
        window.ntdForceReportActivity();
      }
    }
  } catch (err) {
    console.warn('Sync accounts to cloud immediately error:', err);
  }
}

// ── Xóa tất cả tài khoản Facebook cá nhân (Đưa số lượng về 0 trên hệ thống) ────
const clearAllAccountsBtn = $('clearAllAccountsBtn');
if (clearAllAccountsBtn) {
  clearAllAccountsBtn.onclick = async () => {
    const accs = await loadAccounts();
    const personal = accs.filter(a => a.type !== 'fanpage');
    if (personal.length === 0) {
      msg('Hiện tại chưa có tài khoản Facebook cá nhân nào để xóa.');
      return;
    }
    if (!confirm(`⚠️ CẢNH BÁO: Bạn có chắc chắn muốn xóa TOÀN BỘ ${personal.length} tài khoản Facebook cá nhân khỏi máy này?\n\nSố lượng tài khoản trên hệ thống Supabase sẽ được đồng bộ ngay lập tức về 0.`)) {
      return;
    }
    const remaining = accs.filter(a => a.type === 'fanpage');
    await saveAccounts(remaining);
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    personal.forEach(p => { if (campaigns[p.id]) delete campaigns[p.id]; });
    await chrome.storage.local.set({ campaigns });
    msg('✅ Đã xóa toàn bộ nick Facebook cá nhân! Hệ thống đã cập nhật số lượng về 0.', 'ok');
    render();
    await syncAccountsToCloudImmediately(remaining);
  };
}

// Gắn sự kiện kiểm tra Proxy cho các form thêm tài khoản
handleProxyTestUi($('testPassProxyBtn'), $('fbProxy'), $('passProxyStatus'));
handleProxyTestUi($('testCookieProxyBtn'), $('accProxy'), $('cookieProxyStatus'));

// ── Init (Tối ưu hiệu năng: Debounce & Lọc sự kiện thay đổi liên quan) ────────
render();

let _accRenderDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.dailyPostStats || changes.campaigns)) {
    if (_accRenderDebounce) clearTimeout(_accRenderDebounce);
    _accRenderDebounce = setTimeout(render, 150);
  }
});

// Tự động quét cookie & đồng bộ tài khoản đa thiết bị ngay khi mở trang
chrome.runtime.sendMessage({ type: 'SYNC_COOKIES_NOW' }).catch(() => {});
(async () => {
  try {
    const { getActiveSyncUsername, hydrateLocalFromSupabase } = await import('./supabase.js?v=20261125_1700');
    const username = await getActiveSyncUsername();
    if (username) {
      await hydrateLocalFromSupabase(username, { force: false });
    }
  } catch (_) {}
})();

// Nút Quét & Đồng bộ ngay trên banner (Quét cookie Chrome + Đồng bộ Cloud Supabase 2 chiều)
const forceSyncBtn = $('forceSyncAllBtn');
if (forceSyncBtn) {
  forceSyncBtn.onclick = async () => {
    forceSyncBtn.disabled = true;
    forceSyncBtn.textContent = '⏳ Đang quét & đồng bộ...';
    try {
      // 1. Quét cookies từ Chrome
      const res = await chrome.runtime.sendMessage({ type: 'SYNC_COOKIES_NOW' }).catch(() => null);

      // 2. Kéo và gộp tài khoản từ Supabase Cloud về máy (force: true)
      let cloudRes = null;
      try {
        const { getActiveSyncUsername, hydrateLocalFromSupabase } = await import('./supabase.js?v=20261125_1700');
        const username = await getActiveSyncUsername();
        if (username) {
          cloudRes = await hydrateLocalFromSupabase(username, { force: true });
        }
      } catch (err) {
        console.warn('Lỗi đồng bộ Cloud:', err);
      }

      await render();
      if (res?.ok) {
        msg('✅ Đã quét cookie Chrome và đồng bộ tất cả tài khoản từ Cloud!', 'ok');
      } else {
        msg('✅ Đã đồng bộ tài khoản từ Cloud thành công!', 'ok');
      }
    } catch (e) {
      msg('Lỗi đồng bộ: ' + e.message, 'err');
    } finally {
      forceSyncBtn.disabled = false;
      forceSyncBtn.textContent = '🔄 Quét & Đồng bộ ngay';
    }
  };
}

// ── Nút Đăng xuất Facebook trên Chrome để thêm nick mới không bị dính nick cũ ────
async function logoutFacebookOnChrome() {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  msg('⏳ Đang xóa phiên Facebook cũ trên Chrome...');
  try {
    if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
      await window.chrome.runtime.sendToExtension({
        type: 'CLEAR_FACEBOOK_SESSION',
        openLoginTab: true
      });
    } else {
      await chrome.runtime.sendMessage({
        type: 'CLEAR_FACEBOOK_SESSION',
        openLoginTab: true
      });
    }
    msg('✅ Đã đăng xuất Facebook trên Chrome! Tab đăng nhập mới đã mở để bạn thêm hoặc đăng nhập nick mới.', 'ok');
  } catch (err) {
    window.open('https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2F', '_blank');
    msg('✅ Đã mở trang đăng nhập Facebook mới.', 'ok');
  }
}

const logoutBtn = $('logoutFbBtn');
if (logoutBtn) logoutBtn.onclick = logoutFacebookOnChrome;
document.querySelectorAll('.logout-fb-quick-btn').forEach(btn => {
  btn.onclick = logoutFacebookOnChrome;
});

// ── Nút Tự động đăng nhập lại tất cả tài khoản (Batch Auto-Relogin) ───────
const autoReloginAllBtn = $('autoReloginAllBtn');
if (autoReloginAllBtn) {
  autoReloginAllBtn.onclick = async () => {
    const accs = await loadAccounts();
    const personal = accs.filter(a => a.type !== 'fanpage');
    if (personal.length === 0) {
      msg('Chưa có tài khoản Facebook nào trong danh sách.');
      return;
    }

    const eligible = personal.filter(a => a.password && (a.email || a.fbId));
    if (eligible.length === 0) {
      alert('Không có tài khoản nào có lưu Mật khẩu để tự động đăng nhập!\n\nHãy bấm vào biểu tượng ⚙️ (Cài đặt) của từng nick để bổ sung Mật khẩu và Mã 2FA Secret Key (chuỗi 16-32 ký tự). Khi đó hệ thống sẽ tự động đăng nhập mà không cần nhập tay.');
      return;
    }

    const ok = confirm(`Hệ thống sẽ lần lượt tự động đăng nhập và cập nhật Cookie mới cho ${eligible.length} tài khoản có lưu Mật khẩu.\n\nTrong quá trình chạy, tab Facebook sẽ mở ngầm để tự điền thông tin và giải mã 2FA.\n\nBạn có muốn bắt đầu không?`);
    if (!ok) return;

    autoReloginAllBtn.disabled = true;
    const originalText = autoReloginAllBtn.innerHTML;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < eligible.length; i++) {
      const acc = eligible[i];
      autoReloginAllBtn.innerHTML = `⏳ Đang đăng nhập (${i + 1}/${eligible.length}): ${acc.name}...`;
      msg(`⏳ [${i + 1}/${eligible.length}] Đang tự động đăng nhập cho "${acc.name}"...`);

      try {
        const isLast = (i === eligible.length - 1);
        const loginRes = await sendExtensionCommand({
          type: 'DO_LOGIN',
          email: acc.email || acc.fbId,
          password: acc.password,
          twoFactor: acc.twoFactor || null,
          proxy: acc.proxy || null,
          existingAccountId: acc.id,
          openFacebookTab: isLast,
          keepSession: isLast,
          isBackground: !isLast
        });

        if (loginRes?.ok && loginRes.cookies) {
          const currentAccs = await loadAccounts();
          const target = currentAccs.find(a => a.id === acc.id);
          if (target) {
            target.cookies = loginRes.cookies;
            if (loginRes.token) target.token = loginRes.token;
            if (loginRes.cUser) target.fbId = loginRes.cUser;
            target.lastCookieSync = Date.now();
            await saveAccounts(currentAccs);
          }
          successCount++;
          msg(`✅ [${i + 1}/${eligible.length}] Đăng nhập thành công: "${acc.name}"!`, 'ok');
        } else {
          failCount++;
          msg(`⚠️ [${i + 1}/${eligible.length}] "${acc.name}": ${loginRes?.error || 'Lỗi đăng nhập'}`, 'err');
        }
      } catch (err) {
        failCount++;
        msg(`❌ [${i + 1}/${eligible.length}] Lỗi "${acc.name}": ${err.message}`, 'err');
      }

      await new Promise(r => setTimeout(r, 1200));
    }

    autoReloginAllBtn.disabled = false;
    autoReloginAllBtn.innerHTML = originalText;
    render();

    alert(`🎉 Hoàn tất tự động đăng nhập:\n• Thành công: ${successCount}/${eligible.length} tài khoản\n• Cần kiểm tra lại: ${failCount} tài khoản`);
  };
}

// Lắng nghe tiến trình đăng nhập thời gian thực và tự động cập nhật cookie từ worker
chrome.runtime.onMessage.addListener(async m => {
  if (m?.type === 'ACCOUNT_RATE_LIMIT_RESTRICTED') {
    if (Array.isArray(m.accounts)) {
      await chrome.storage.local.set({ accounts: m.accounts });
    }
    if (Array.isArray(m.accountGroupsList)) {
      await chrome.storage.local.set({ accountGroupsList: m.accountGroupsList });
    }
    msg(`🛑 Tài khoản "${m.accountName}" bị cảnh báo Spam Rate Limit! Đã tự động đưa vào nhóm "Acc nuôi" để cách ly & nuôi dưỡng 3 ngày.`, 'warn');
    await render();
    return;
  }
  if (m?.type === 'COOKIE_AUTO_SYNCED') {
    msg(`⚡ Đã tự động cập nhật cookie mới cho "${m.accountName}" (FB ID: ${m.fbId})!`, 'ok');
    render();
  }
  if (m.type === 'LOGIN_STEP' && m.step) {
    if (m.step === 'session_cleared') {
      if (_activeLoginFlowState) _activeLoginFlowState.sessionClearedSeen = true;
    }
    else if (m.step === 'step2') {
      if (_activeLoginFlowState) _activeLoginFlowState.sessionClearedSeen = true;
      setStep('step1', 'done'); setStep('step2', 'active');
    }
    else if (m.step === 'step3') {
      if (_activeLoginFlowState) _activeLoginFlowState.sessionClearedSeen = true;
      setStep('step2', 'done'); setStep('step3', 'active');
    }
    else if (m.step === 'step4') {
      if (_activeLoginFlowState) {
        _activeLoginFlowState.sessionClearedSeen = true;
        _activeLoginFlowState.loginSubmittedSeen = true;
      }
      setStep('step3', 'done'); setStep('step4', 'active');
    }
    else if (m.step === 'step_2fa') {
      if (_activeLoginFlowState) {
        _activeLoginFlowState.sessionClearedSeen = true;
        _activeLoginFlowState.loginSubmittedSeen = true;
      }
      const el = $('step_2fa');
      if (el) {
        el.style.display = 'flex';
        el.className = 'step-active';
      }
      $('progressTitle').textContent = '⚠️ Hãy nhập mã 2FA trên tab Facebook vừa mở...';
    }
    else if (m.step === 'step5') {
      if (_activeLoginFlowState) {
        _activeLoginFlowState.sessionClearedSeen = true;
        _activeLoginFlowState.loginSubmittedSeen = true;
      }
      const el = $('step_2fa');
      if (el && el.style.display !== 'none') el.className = 'step-done';
      setStep('step4', 'done');
      setStep('step5', 'active');
    }
  }
});

// ── Direct 1-Click JSON Backup & Restore ───────────────────────────────────────
$('accBackupBtn')?.addEventListener('click', async () => {
  try {
    const data = await exportJsonBackup();
    msg(`✅ Đã tải file sao lưu (${data.accounts.length} nick, ${data.groupCategories.length} nhóm)!`);
  } catch (e) {
    msg('❌ Lỗi sao lưu: ' + e.message, 'err');
  }
});

$('accRestoreBtn')?.addEventListener('click', () => {
  $('accRestoreInput')?.click();
});

$('accRestoreInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = await parseJsonFile(file);
    const res = await applyRestoredData(data);
    alert(`🎉 Khôi phục dữ liệu thành công!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm.\n\nTrang sẽ tự động tải lại ngay.`);
    window.location.reload();
  } catch (err) {
    alert('❌ Lỗi nạp file sao lưu: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

// ── Reset All Daily Post Counts ──────────────────────────────────────────────
$('resetAllDailyBtn')?.addEventListener('click', async () => {
  if (!confirm('Đặt lại số bài group đã đăng hôm nay của TẤT CẢ tài khoản về 0?')) return;
  try {
    await chrome.runtime.sendMessage({ type: 'RESET_ALL_DAILY_COUNT' });
    msg('✅ Đã đặt lại số bài hôm nay của tất cả tài khoản về 0.');
    render();
  } catch (e) { msg('Lỗi đặt lại: ' + e.message, 'err'); }
});

// ── Full Backup, Restore & 1-Touch Cloud Sync System ─────────────────────────
initSyncModal({
  triggerBtnId: 'openSyncModalBtn',
  defaultTab: 'restore',
  onRestoreSuccess: () => window.location.reload()
});

