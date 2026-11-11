// worker.js – Background service worker (multi-account parallel)
import {validate, groups, getTodayDateStr, parseUniversalCookies, cookiesObjToStr, findBannedWords, activateAccountSessionDirectly, generate2FACode, fetchTokenEAAG, fetchTokenEAAB, getAccountDailyLimit, recordPostedGroupUrl} from './core.js';
import { checkCurrentLicense } from './license.js';
import { mapsExtract } from './maps_extract.js';

// ── Serial lock per account ─────────────────────────────────────────────────
const locks = {};
const locked = (accountId, fn) => {
  if (!locks[accountId]) locks[accountId] = Promise.resolve();
  const p = locks[accountId].then(fn);
  locks[accountId] = p.catch(() => {});
  return p;
};

// ── Storage helpers ───────────────────────────────────────────────────────────
const readCampaigns = async () => (await chrome.storage.local.get('campaigns')).campaigns || {};
const readAccounts  = async () => (await chrome.storage.local.get('accounts')).accounts || [];
const saveCampaigns = c => chrome.storage.local.set({campaigns: c});
const saveAccounts  = a => chrome.storage.local.set({accounts: a});
const readCoordinator = async () => (await chrome.storage.local.get('coordinator')).coordinator || null;
const saveCoordinator = c => chrome.storage.local.set({coordinator: c});
const readDailyStats = async () => (await chrome.storage.local.get('dailyPostStats')).dailyPostStats || {};
const saveDailyStats = stats => chrome.storage.local.set({dailyPostStats: stats});

// Tự động dọn dẹp các bản ghi campaigns cũ nếu bị phình to do chứa base64 và dọn ảnh rác
(async function cleanupBloatedCampaigns() {
  try {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    if (campaigns && typeof campaigns === 'object') {
      let changed = false;
      const { campaignPictures = {} } = await chrome.storage.local.get('campaignPictures');
      for (const [id, c] of Object.entries(campaigns)) {
        if (c?.picture?.data) {
          changed = true;
          if (c.postIndex !== undefined && !campaignPictures[c.postIndex]) {
            campaignPictures[c.postIndex] = c.picture;
          }
          c.picture = { name: c.picture.name, type: c.picture.type };
        }
      }
      if (changed) {
        await chrome.storage.local.set({ campaigns, campaignPictures });
      }
    }
    // Dọn dẹp campaignPictures rác nếu không có chiến dịch nào đang chạy cần ảnh
    const { campaigns: currentCampaigns } = await chrome.storage.local.get('campaigns');
    const runningCampaigns = Object.values(currentCampaigns || {}).filter(c => c && c.state === 'running');
    if (runningCampaigns.length === 0) {
      await chrome.storage.local.remove('campaignPictures');
    }
  } catch (_) {}
})();

// ── Daily Post Limit & Tracking helpers ───────────────────────────────────────
let dailyStatsLock = Promise.resolve();
function withDailyStatsLock(fn) {
  const p = dailyStatsLock.then(fn);
  dailyStatsLock = p.catch(() => {});
  return p;
}

async function getDailyCount(accountId) {
  return withDailyStatsLock(async () => {
    const stats = await readDailyStats();
    const today = getTodayDateStr();
    const record = stats[accountId];
    if (record && record.date === today) {
      return Number(record.count) || 0;
    }
    return 0;
  });
}

async function incrementDailyCount(accountId) {
  return withDailyStatsLock(async () => {
    const stats = await readDailyStats();
    const today = getTodayDateStr();
    const record = stats[accountId];
    let count = 0;
    if (record && record.date === today) {
      count = Number(record.count) || 0;
    }
    count += 1;
    stats[accountId] = {
      date: today,
      count,
      lastPostAt: Date.now()
    };
    await saveDailyStats(stats);
    return count;
  });
}

async function resetDailyCount(accountId) {
  return withDailyStatsLock(async () => {
    const stats = await readDailyStats();
    const today = getTodayDateStr();
    stats[accountId] = {
      date: today,
      count: 0,
      lastPostAt: Date.now()
    };
    await saveDailyStats(stats);
    return true;
  });
}

function calcDelayMs(c) {
  const min = Number(c.gapMin ?? c.gap ?? 180);
  const max = Number(c.gapMax ?? min);
  const randomGap = Math.floor(Math.random() * (max - min + 1)) + min;
  return randomGap * 1000;
}

// ── Khi cài đặt extension hoặc cập nhật: Tự động mở trang kích hoạt nếu chưa có license ───
if (chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    try {
      const valid = await checkCurrentLicense();
      if (!valid) {
        chrome.tabs.create({ url: chrome.runtime.getURL('activate.html') });
      }
    } catch (err) {
      console.warn('Lỗi kiểm tra bản quyền onInstalled:', err);
      chrome.tabs.create({ url: chrome.runtime.getURL('activate.html') });
    }
  });
}

// ── Open panel or activate on click ──────────────────────────────────────────
if (chrome.action?.onClicked?.addListener) {
  chrome.action.onClicked.addListener(async () => {
    try {
      const { license } = await chrome.storage.local.get('license');
      const isValidLocal = license?.username && license?.expiry && (new Date(license.expiry) > new Date());
      if (isValidLocal) {
        chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
        checkCurrentLicense(false).catch(() => {});
      } else {
        const valid = await checkCurrentLicense(true);
        if (!valid) {
          chrome.tabs.create({ url: chrome.runtime.getURL('activate.html') });
        } else {
          chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
        }
      }
    } catch (err) {
      chrome.tabs.create({ url: chrome.runtime.getURL('activate.html') });
    }
  });
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
/**
 * Inject cookies for a specific account into facebook.com domain.
 * Supports string format ("c_user=...; xs=..."), JSON array format, and maps.
 */
async function injectCookies(cookieInput) {
  if (!cookieInput) return [];
  const cookieObj = typeof cookieInput === 'object' && !Array.isArray(cookieInput)
    ? { ...cookieInput }
    : parseUniversalCookies(cookieInput);

  const keys = Object.keys(cookieObj);
  if (!keys.length) return [];

  // 1. Tự động chuẩn hóa xs (nếu chứa dấu : chưa mã hóa URL thành %3A)
  if (cookieObj['xs'] && typeof cookieObj['xs'] === 'string') {
    if (cookieObj['xs'].includes(':') && !cookieObj['xs'].includes('%3A')) {
      cookieObj['xs'] = cookieObj['xs'].replace(/:/g, '%3A');
    }
  }

  // 2. Đảm bảo có datr: nếu cookie nhập vào thiếu datr, lấy từ browser hoặc fetch một datr hợp lệ từ Facebook
  if (!cookieObj['datr']) {
    try {
      const fbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
      const existingDatr = fbCookies.find(c => c.name === 'datr')?.value;
      if (existingDatr) {
        cookieObj['datr'] = existingDatr;
      } else {
        await fetch('https://www.facebook.com/', { method: 'HEAD', mode: 'no-cors' }).catch(() => {});
        const newFbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
        const newDatr = newFbCookies.find(c => c.name === 'datr')?.value;
        if (newDatr) cookieObj['datr'] = newDatr;
      }
    } catch (_) {}
  }

  const injected = [];
  const httpOnlyCookies = new Set(['xs', 'fr', 'datr', 'sb']);
  const expDate = Math.floor(Date.now() / 1000) + (365 * 24 * 3600); // 1 năm

  for (const [name, rawValue] of Object.entries(cookieObj)) {
    if (!name || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (!value) continue;

    const lowerName = name.toLowerCase();
    const isHttpOnly = httpOnlyCookies.has(lowerName);

    // datr và fr trên Facebook dùng no_restriction (SameSite=None), các cookie auth khác (c_user, xs, sb) dùng lax
    const isCrossSite = ['datr', 'fr'].includes(lowerName);
    const sameSiteVal = isCrossSite ? 'no_restriction' : 'lax';

    let success = false;

    // 1. Thử set domain cookie (.facebook.com) từ https://www.facebook.com/
    try {
      const res = await chrome.cookies.set({
        url: 'https://www.facebook.com/',
        domain: '.facebook.com',
        name,
        value,
        path: '/',
        secure: true,
        httpOnly: isHttpOnly,
        sameSite: sameSiteVal,
        expirationDate: expDate
      });
      if (res && res.name) success = true;
    } catch (_) {}

    // 2. Thử domain không dấu chấm (facebook.com)
    if (!success) {
      try {
        const res = await chrome.cookies.set({
          url: 'https://facebook.com/',
          domain: 'facebook.com',
          name,
          value,
          path: '/',
          secure: true,
          httpOnly: isHttpOnly,
          sameSite: sameSiteVal,
          expirationDate: expDate
        });
        if (res && res.name) success = true;
      } catch (_) {}
    }

    // 3. Fallback set trực tiếp trên các subdomains
    const subUrls = [
      'https://www.facebook.com/',
      'https://m.facebook.com/',
      'https://web.facebook.com/',
      'https://upload.facebook.com/'
    ];
    for (const targetUrl of subUrls) {
      try {
        const resFallback = await chrome.cookies.set({
          url: targetUrl,
          name,
          value,
          path: '/',
          secure: true,
          httpOnly: isHttpOnly,
          sameSite: sameSiteVal,
          expirationDate: expDate
        });
        if (resFallback && resFallback.name) success = true;
      } catch (_) {}
    }

    if (success) {
      injected.push(name);
    }
  }

  return injected;
}

/**
 * Xóa sạch tất cả cookies Facebook trên mọi cookie stores mà không xóa cache/storage.
 * Có tùy chọn preserveDatr để giữ lại cookie thiết bị datr tránh Facebook nghi ngờ session mới.
 */
async function clearFacebookCookiesOnly(preserveDatr = false) {
  try {
    const storeIds = [];
    try {
      const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
      for (const s of stores) if (s?.id) storeIds.push(s.id);
    } catch (_) {}
    if (!storeIds.length) storeIds.push('0');

    for (const storeId of storeIds) {
      const allCookies = await chrome.cookies.getAll({ storeId }).catch(() => []);
      const fbCookies = allCookies.filter(c =>
        c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
      );

      for (const ck of fbCookies) {
        if (preserveDatr && ck.name === 'datr') continue;
        const protocol = ck.secure ? 'https:' : 'http:';
        const cleanDomain = ck.domain.replace(/^\./, '');
        const targetUrls = [
          `${protocol}//${cleanDomain}${ck.path || '/'}`,
          `https://${cleanDomain}${ck.path || '/'}`,
          `https://www.facebook.com${ck.path || '/'}`,
          `https://facebook.com${ck.path || '/'}`
        ];

        for (const url of targetUrls) {
          const details = {
            url,
            name: ck.name,
            storeId
          };
          if (ck.partitionKey) details.partitionKey = ck.partitionKey;
          await chrome.cookies.remove(details).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

/**
 * Remove all cookies with the given names from facebook.com.
 * Used after a campaign job finishes to avoid lingering sessions.
 */
async function clearInjectedCookies(names) {
  for (const name of names) {
    try {
      await chrome.cookies.remove({url: 'https://www.facebook.com/', name});
      await chrome.cookies.remove({url: 'https://facebook.com/', name});
    } catch (_) {}
  }
}

/**
 * Xóa toàn bộ session, cookies, cache, storage Facebook khỏi trình duyệt
 * để đảm bảo không bị dính tài khoản cũ khi thêm tài khoản mới.
 */
async function clearAllFacebookSession() {
  // 1. Xóa storage, cache, indexedDB, serviceWorkers, cookies qua browsingData nếu có
  if (chrome.browsingData?.remove) {
    try {
      await chrome.browsingData.remove({
        origins: [
          'https://www.facebook.com',
          'https://facebook.com',
          'https://m.facebook.com',
          'https://web.facebook.com',
          'http://www.facebook.com',
          'http://facebook.com'
        ]
      }, {
        cookies: true,
        cache: true,
        localStorage: true,
        indexedDB: true,
        serviceWorkers: true
      });
    } catch (_) {}
  }

  // 2. Quét và xóa tất cả cookies Facebook qua Cookies API trên mọi cookie stores
  try {
    const stores = await chrome.cookies.getAllCookieStores().catch(() => [{ id: '0' }]);
    for (const store of stores) {
      const allCookies = await chrome.cookies.getAll({ storeId: store.id }).catch(() => []);
      const fbCookies = allCookies.filter(c => c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com')));

      for (const ck of fbCookies) {
        const protocol = ck.secure ? 'https:' : 'http:';
        const cleanDomain = ck.domain.replace(/^\./, '');
        const targetUrls = [
          `${protocol}//${cleanDomain}${ck.path || '/'}`,
          `https://www.facebook.com${ck.path || '/'}`,
          `https://facebook.com${ck.path || '/'}`
        ];

        for (const url of targetUrls) {
          const details = {
            url,
            name: ck.name,
            storeId: store.id,
          };
          if (ck.partitionKey) details.partitionKey = ck.partitionKey;
          await chrome.cookies.remove(details).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

// ── Automatic Real-Time Cookie Synchronization Engine ────────────────────────
let cookieSyncDebounceTimer = null;

/**
 * Tự động quét toàn bộ cookies Facebook hiện có trên Chrome và cập nhật
 * cho tài khoản tương ứng trong extension hoàn toàn tự động theo thời gian thực.
 */
async function autoSyncFacebookCookies(preferredAccountId = null) {
  try {
    const allCookies = await chrome.cookies.getAll({}).catch(() => []);
    const fbCookies = allCookies.filter(c =>
      c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
    );
    if (!fbCookies.length) return { ok: false, reason: 'no_cookies' };

    // Deduplicate cookies: ưu tiên cookie có domain bắt đầu bằng '.' (.facebook.com)
    const cookieMap = new Map();
    for (const ck of fbCookies) {
      if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
        cookieMap.set(ck.name, ck);
      }
    }

    const cUserCookie = cookieMap.get('c_user');
    const xsCookie = cookieMap.get('xs');
    if (!cUserCookie?.value || !xsCookie?.value) {
      return { ok: false, reason: 'not_logged_in' };
    }

    const currentCUser = String(cUserCookie.value).trim();
    const currentXs = String(xsCookie.value).trim();
    const newCookieStr = [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');

    const accounts = await readAccounts();
    if (!accounts.length) return { ok: false, reason: 'no_accounts' };

    // Tìm tài khoản phù hợp:
    // CHỈ đồng bộ cookie cho tài khoản nếu c_user trong trình duyệt trùng khớp với fbId của tài khoản đó!
    let accIndex = accounts.findIndex(a => {
      if (a.fbId && String(a.fbId).trim() === currentCUser) return true;
      const match = (a.cookies || '').match(/(?:^|;\s*)c_user=([^;]+)/);
      return match && match[1].trim() === currentCUser;
    });

    // Tuyệt đối không tự ý ghi đè cookie của nick A vào nick B nếu c_user khác nhau!
    // Chỉ fallback khi tài khoản được chỉ định cụ thể (preferredAccountId) và tài khoản đó chưa có fbId
    if (accIndex < 0 && preferredAccountId) {
      const prefAcc = accounts.find(a => a.id === preferredAccountId);
      if (prefAcc && (!prefAcc.fbId || String(prefAcc.fbId).trim() === currentCUser)) {
        accIndex = accounts.findIndex(a => a.id === preferredAccountId);
      }
    }

    if (accIndex < 0) {
      return { ok: false, reason: 'no_matching_account' };
    }

    const target = accounts[accIndex];
    const oldXsMatch = (target.cookies || '').match(/(?:^|;\s*)xs=([^;]+)/);
    const oldXs = oldXsMatch ? oldXsMatch[1].trim() : '';

    const needsUpdate = !target.cookies ||
      target.cookies.length < 50 ||
      oldXs !== currentXs ||
      target.cookies !== newCookieStr ||
      !target.lastCookieSync ||
      (Date.now() - (target.lastCookieSync || 0) > 180000);

    if (needsUpdate) {
      target.cookies = newCookieStr;
      target.lastCookieSync = Date.now();
      target.fbId = currentCUser;

      // Đồng thời cập nhật luôn cookie cho các Fanpage con trực thuộc tài khoản này
      for (const a of accounts) {
        if (a.type === 'fanpage' && (a.parentAccountId === target.id || !a.parentAccountId)) {
          a.cookies = newCookieStr;
          a.lastCookieSync = Date.now();
        }
      }

      await saveAccounts(accounts);

      console.log(`[AutoCookieSync] ✅ Tự động cập nhật cookie mới cho "${target.name}" (FB ID: ${currentCUser})`);

      // Thông báo cho giao diện (accounts.html, panel.html)
      chrome.runtime.sendMessage({
        type: 'COOKIE_AUTO_SYNCED',
        accountId: target.id,
        accountName: target.name,
        fbId: currentCUser,
        time: Date.now()
      }).catch(() => {});

      return { ok: true, accountId: target.id, cUser: currentCUser };
    }

    return { ok: true, unchanged: true };
  } catch (err) {
    console.warn('[AutoCookieSync] Lỗi tự động đồng bộ:', err);
    return { ok: false, error: err.message };
  }
}

function triggerDebouncedCookieSync(preferredAccountId = null, delayMs = 1200) {
  if (cookieSyncDebounceTimer) clearTimeout(cookieSyncDebounceTimer);
  cookieSyncDebounceTimer = setTimeout(() => {
    autoSyncFacebookCookies(preferredAccountId).catch(() => {});
  }, delayMs);
}

// ── Lắng nghe thay đổi cookie Facebook thời gian thực trên Chrome ───────────
let isSwitchingSession = false;

if (chrome.cookies?.onChanged?.addListener) {
  chrome.cookies.onChanged.addListener(changeInfo => {
    if (isSwitchingSession) return;
    const domain = changeInfo.cookie?.domain || '';
    if (domain.includes('facebook.com') || domain.includes('fb.com')) {
      // Chỉ kích hoạt khi cookie được tạo hoặc cập nhật (không xóa cookies lưu sẵn khi người dùng logout tab)
      if (!changeInfo.removed) {
        const name = changeInfo.cookie?.name || '';
        if (['c_user', 'xs', 'fr', 'datr', 'sb'].includes(name)) {
          triggerDebouncedCookieSync(null, 1500);
        }
      }
    }
  });
}

// Chạy 1 lần quét ban đầu khi worker khởi động
autoSyncFacebookCookies().catch(() => {});

// Đặt lịch kiểm tra và đồng bộ định kỳ mỗi 10 phút
chrome.alarms.create('auto_cookie_sync', { periodInMinutes: 10 });

// ── Profile Switcher Engine for Fanpage (Profile Pro5) ────────────────────────
let currentActiveFacebookProfileId = null;

async function waitForTabLoaded(tabId, timeoutMs = 15000) {
  // Sử dụng event-driven thay vì polling để phản hồi nhanh hơn
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(tid, changeInfo) {
      if (tid !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }

    // Kiểm tra ngay nếu tab đã load xong
    chrome.tabs.get(tabId).then(tab => {
      if (tab?.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    }).catch(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Script chạy trong tab Facebook để tự động chuyển đổi sang danh tính Fanpage Pro5.
 * Hỗ trợ đa tầng:
 * 1. Nút "Chuyển ngay" / "Switch now" trực tiếp
 * 2. Modal dialog xác nhận chuyển đổi
 * 3. Thẻ Page card trên sidebar "Quản lý trang" hoặc các mục chức năng bị vô hiệu hóa (icon cấm ⊘)
 * 4. Menu avatar tài khoản ở góc trên cùng bên phải (Universal Switcher)
 */
async function runPageProfileSwitcher(targetPageId, targetPageName) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const norm = str => (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const targetNorm = norm(targetPageName);
  const targetIdStr = String(targetPageId || '').trim();

  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    try {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (_) { return false; }
  };

  const getLabel = el => {
    if (!el) return '';
    return (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
  };

  const clickEl = el => {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ block: 'nearest' });
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (_) { return false; }
    }
  };

  // 0. Kiểm tra nếu UI hoặc session đã ở Fanpage profile rồi
  const getHeaderProfileText = () => {
    const avatar = document.querySelector('[role="banner"] [role="button"][aria-label*="cá nhân" i], [role="banner"] [role="button"][aria-label*="tài khoản" i], [role="banner"] [role="button"][aria-label*="account" i], [role="banner"] [role="button"][aria-label*="profile" i], [role="banner"] [role="button"][aria-label*="hồ sơ" i], div[role="button"][aria-label*="cá nhân" i], div[role="button"][aria-label*="tài khoản" i]');
    if (!avatar) return '';
    const imgAlt = avatar.querySelector('img')?.getAttribute('alt') || '';
    return norm((avatar.getAttribute('aria-label') || '') + ' ' + (avatar.innerText || '') + ' ' + imgAlt);
  };

  const hasSwitchButtonOnPage = () => {
    const buttons = [...document.querySelectorAll('button, [role="button"], a')].filter(isVisible);
    return buttons.some(b => {
      const l = getLabel(b);
      const aria = (b.getAttribute('aria-label') || '').trim();
      const text = norm(l + ' ' + aria);
      if (/hủy|cancel|đóng|close|xóa|delete|chia sẻ|share|thích|like|tin nhắn|message/i.test(l)) return false;
      return /chuyển ngay|switch now|chuyển sang|switch to/i.test(text) ||
             /^(chuyển|switch)$/i.test(l.trim()) ||
             (targetNorm && text.includes(targetNorm) && (text.includes('chuyển') || text.includes('switch')));
    });
  };

  // Đóng modal "Trang & trang cá nhân" nếu đang mở sẵn
  const closeProfileChooserIfOpen = () => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible).find(d => {
      const t = (d.innerText || '').toLowerCase();
      return t.includes('trang & trang ca nhan') || t.includes('profiles & pages') || t.includes('chuyen de tuong tac') || t.includes('switch to interact');
    });
    if (dialog) {
      const closeBtn = dialog.querySelector('[aria-label="Đóng"], [aria-label="Close"]') ||
                       [...dialog.querySelectorAll('[role="button"], button')].find(b => /^(Đóng|Close|✕|×)$/i.test(getLabel(b)));
      if (closeBtn) clickEl(closeBtn);
    }
  };

  const isAlreadyInPage = () => {
    // a. Cookie i_user khớp targetPageId
    if (targetIdStr && typeof document.cookie === 'string' && document.cookie.includes('i_user=' + targetIdStr)) {
      return true;
    }
    // b. Nếu thanh điều hướng bên trái đã hiển thị "Quản lý trang" / "Professional dashboard" / "Bảng điều khiển"
    const sidebar = document.querySelector('div[role="navigation"], nav, aside, [aria-label*="Quản lý trang"], [aria-label*="Manage Page"]');
    const sidebarText = norm(sidebar?.innerText || '');
    if ((sidebarText.includes('quan ly trang') || sidebarText.includes('manage page') || sidebarText.includes('bang dieu khien') || sidebarText.includes('professional dashboard')) && !hasSwitchButtonOnPage()) {
      return true;
    }
    // c. Header avatar hoặc document title/text
    if (targetNorm && (getHeaderProfileText().includes(targetNorm) || norm(document.title).includes(targetNorm) || norm(document.body?.innerText || '').includes(targetNorm)) && !hasSwitchButtonOnPage()) {
      return true;
    }
    return false;
  };

  if (isAlreadyInPage()) {
    console.log('[Switcher] Đã ở danh tính Fanpage trên Facebook UI, không cần chuyển đổi.');
    closeProfileChooserIfOpen();
    return { ok: true, reason: 'already_switched_ui' };
  }

  const endWait = Date.now() + 18000;
  while (Date.now() < endWait) {
    if (isAlreadyInPage()) {
      console.log('[Switcher] Facebook đã cập nhật sang danh tính Fanpage, hoàn tất.');
      closeProfileChooserIfOpen();
      return { ok: true, reason: 'already_switched_ui' };
    }

    // 1. TÌM NÚT CHUYỂN NGAY / SWITCH NOW TRỰC TIẾP TRÊN TRANG (BANNER HOẶC COVER)
    const allButtons = [...document.querySelectorAll('button, [role="button"], a')].filter(isVisible);
    const directSwitchBtn = allButtons.find(b => {
      const l = getLabel(b);
      const aria = (b.getAttribute('aria-label') || '').trim();
      const text = norm(l + ' ' + aria);

      if (/hủy|cancel|đóng|close|xóa|delete|chia sẻ|share|thích|like|tin nhắn|nhắn tin|message|xem công cụ|quảng cáo/i.test(l)) return false;

      // a. "Chuyển ngay" hoặc "Switch now"
      if (/chuyển ngay|switch now/i.test(text)) return true;

      // b. "Chuyển sang..." hoặc "Switch to..."
      if (/chuyển sang|switch to|switch into/i.test(text)) return true;

      // c. Nút "Chuyển" hoặc "Switch"
      if (/^(chuyển|switch)$/i.test(l.trim()) || /^chuyển\b/i.test(l.trim()) || /^switch\b/i.test(l.trim())) return true;

      // d. Nút có chứa tên Fanpage và có từ chuyển / switch
      if (targetNorm && text.includes(targetNorm) && (text.includes('chuyển') || text.includes('switch'))) return true;

      return false;
    });

    if (directSwitchBtn) {
      console.log('[Switcher] Tìm thấy nút chuyển trực tiếp:', getLabel(directSwitchBtn));
      clickEl(directSwitchBtn);
      await delay(1500);

      // Kiểm tra nếu có popup xác nhận mở ra
      const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible).find(d => {
        const t = (d.innerText || '').toLowerCase();
        return t.includes('chuyển') || t.includes('switch') || t.includes('tiếp tục') || t.includes('continue');
      });
      if (dialog) {
        const confirmBtn = [...dialog.querySelectorAll('button, [role="button"]')].filter(isVisible).find(b => {
          const l = getLabel(b);
          return /^(Chuyển ngay|Chuyển|Tiếp tục|Xác nhận|Switch now|Switch|Continue|Confirm)$/i.test(l) && !/hủy|cancel|đóng|close/i.test(l);
        });
        if (confirmBtn) {
          console.log('[Switcher] Bấm nút xác nhận trong modal:', getLabel(confirmBtn));
          clickEl(confirmBtn);
          await delay(2500);
        }
      }
      return { ok: true, method: 'direct_button' };
    }

    // 2. TÌM MODAL DIALOG ĐANG HIỂN THỊ TRÊN MÀN HÌNH (Popup xác nhận chuyển sang trang)
    const activeDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
    for (const d of activeDialogs) {
      const confirmBtn = [...d.querySelectorAll('button, [role="button"]')].filter(isVisible).find(b => {
        const l = getLabel(b);
        return /^(Chuyển ngay|Chuyển|Tiếp tục|Xác nhận|Switch now|Switch|Continue|Confirm)$/i.test(l) && !/hủy|cancel|đóng|close/i.test(l);
      });
      if (confirmBtn) {
        console.log('[Switcher] Bấm nút xác nhận trong modal:', getLabel(confirmBtn));
        clickEl(confirmBtn);
        await delay(2500);
        return { ok: true, method: 'dialog_confirm' };
      }
    }

    // 3. MENU AVATAR TRÊN THANH HEADER (GÓC TRÊN CÙNG BÊN PHẢI - UNIVERSAL SWITCHER)
    let avatarBtn = document.querySelector('[role="banner"] [role="button"][aria-label*="cá nhân" i], [role="banner"] [role="button"][aria-label*="tài khoản" i], [role="banner"] [role="button"][aria-label*="account" i], [role="banner"] [role="button"][aria-label*="profile" i], [role="banner"] [role="button"][aria-label*="hồ sơ" i], div[role="button"][aria-label*="cá nhân" i], div[role="button"][aria-label*="tài khoản" i]');
    
    if (!avatarBtn) {
      const topElements = [...document.querySelectorAll('div[role="button"], button, a')].filter(isVisible);
      const rightmost = topElements.filter(el => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top <= 65 && r.right >= window.innerWidth - 220;
      });
      rightmost.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      avatarBtn = rightmost[0] || null;
    }

    if (avatarBtn && !document.querySelector('div[role="menu"], div[role="dialog"]')) {
      console.log('[Switcher] Mở menu avatar góc trên bên phải');
      clickEl(avatarBtn);
      await delay(1200);

      const menuItems = [...document.querySelectorAll('[role="menu"] [role="button"], [role="dialog"] [role="button"], [role="menuitem"], [role="listbox"] [role="option"]')].filter(isVisible);

      // 4a. Nếu có sẵn Page trong menu thả xuống
      const directItem = menuItems.find(el => {
        const t = norm(getLabel(el));
        return (targetNorm && t.includes(targetNorm)) || (targetIdStr && el.innerHTML && el.innerHTML.includes(targetIdStr));
      });
      if (directItem) {
        console.log('[Switcher] Click chọn Page trong menu:', getLabel(directItem));
        clickEl(directItem);
        await delay(3000);
        return { ok: true, method: 'avatar_menu_direct' };
      }

      // 4b. Bấm "Xem tất cả trang cá nhân" (See all profiles)
      const seeAllBtn = menuItems.find(el => {
        const t = getLabel(el);
        return /Xem tất cả|See all profiles|Chuyển tài khoản|Switch accounts|Xem thêm/i.test(t);
      });
      if (seeAllBtn) {
        console.log('[Switcher] Bấm "Xem tất cả trang cá nhân"');
        clickEl(seeAllBtn);
        await delay(1500);

        const allProfiles = [...document.querySelectorAll('[role="dialog"] [role="button"], [role="menu"] [role="button"], [role="listbox"] [role="option"]')].filter(isVisible);
        const targetProfile = allProfiles.find(el => {
          const t = norm(getLabel(el));
          return (targetNorm && t.includes(targetNorm)) || (targetIdStr && el.innerHTML && el.innerHTML.includes(targetIdStr));
        });
        if (targetProfile) {
          console.log('[Switcher] Click chọn Fanpage từ danh sách tất cả hồ sơ:', getLabel(targetProfile));
          clickEl(targetProfile);
          await delay(3000);
          return { ok: true, method: 'avatar_menu_all_profiles' };
        }
      }
    }

    await delay(700);
  }

  return { ok: false, reason: 'timeout_no_switcher_action' };
}

/**
 * Script chạy trong tab Facebook để tự động chuyển về tài khoản cá nhân.
 */
async function runPersonalProfileSwitcher(targetPersonalId, targetPersonalName) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const norm = str => (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const targetNorm = norm(targetPersonalName);
  const targetIdStr = String(targetPersonalId || '').trim();

  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    try {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (_) { return false; }
  };

  const getLabel = el => {
    if (!el) return '';
    return (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
  };

  const clickEl = el => {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ block: 'nearest' });
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (_) { return false; }
    }
  };

  let avatarBtn = document.querySelector('[role="button"][aria-label*="Tài khoản"], [role="button"][aria-label*="Your profile"], [role="button"][aria-label*="trang cá nhân"], [role="button"][aria-label*="Trang cá nhân"], [role="button"][aria-label*="Account"], [role="button"][aria-label*="Hồ sơ"]');
  if (!avatarBtn) {
    const topElements = [...document.querySelectorAll('div[role="button"], button, a')].filter(isVisible);
    const rightmost = topElements.filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top <= 65 && r.right >= window.innerWidth - 220;
    });
    rightmost.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    avatarBtn = rightmost[0] || null;
  }

  if (!avatarBtn) return;

  clickEl(avatarBtn);
  await delay(1200);

  const menuItems = [...document.querySelectorAll('[role="menu"] [role="button"], [role="dialog"] [role="button"], [role="menuitem"], [role="listbox"] [role="option"]')].filter(isVisible);
  
  const directItem = menuItems.find(el => {
    const t = norm(getLabel(el));
    return (targetNorm && t.includes(targetNorm)) || (targetIdStr && el.innerHTML && el.innerHTML.includes(targetIdStr));
  });
  if (directItem) {
    clickEl(directItem);
    await delay(2000);
    return;
  }

  const seeAllBtn = menuItems.find(el => {
    const t = getLabel(el);
    return /Xem tất cả|See all profiles|Chuyển tài khoản|Switch accounts/i.test(t);
  });
  if (seeAllBtn) {
    clickEl(seeAllBtn);
    await delay(1500);

    const allProfiles = [...document.querySelectorAll('[role="dialog"] [role="button"], [role="menu"] [role="button"], [role="listbox"] [role="option"]')].filter(isVisible);
    const targetItem = allProfiles.find(el => {
      const t = norm(getLabel(el));
      return (targetNorm && t.includes(targetNorm)) ||
             (targetIdStr && el.innerHTML && el.innerHTML.includes(targetIdStr));
    });
    if (targetItem) {
      clickEl(targetItem);
      await delay(2000);
    }
  }
}

/**
 * Đảm bảo trình duyệt đã chuyển sang danh tính Fanpage (Profile Pro5)
 */
async function ensureFanpageProfileSwitched(pageId, pageName, windowId = null, existingTabId = null) {
  try {
    let tabId = existingTabId;
    let shouldCloseTab = false;

    if (!tabId) {
      const fbTabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' }).catch(() => []);
      const exactPageTab = fbTabs.find(t => t.url && t.url.includes(`/${pageId}`));
      
      if (exactPageTab) {
        tabId = exactPageTab.id;
      } else {
        const tabOpts = { url: `https://www.facebook.com/${pageId}`, active: false };
        if (windowId) {
          try {
            const win = await chrome.windows.get(windowId);
            if (win) tabOpts.windowId = windowId;
          } catch (_) {}
        }
        const createdTab = await chrome.tabs.create(tabOpts);
        tabId = createdTab.id;
        shouldCloseTab = true;
      }
    }

    if (!tabId) return false;

    await waitForTabLoaded(tabId, 15000);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          try {
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            document.hasFocus = () => true;
            window.hasFocus = () => true;
          } catch (_) {}
        }
      });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageProfileSwitcher,
      args: [String(pageId), String(pageName || '')]
    }).catch(e => {
      console.warn('[FanpageSwitch] Lỗi executeScript:', e);
      return null;
    });

    const switchResult = results?.[0]?.result;
    console.log('[FanpageSwitch] Kết quả switcher:', switchResult);

    // Chờ 3.5s để Facebook cập nhật toàn bộ trạng thái phiên
    await new Promise(r => setTimeout(r, 3500));

    if (shouldCloseTab) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
    return switchResult?.ok || false;
  } catch (err) {
    console.error('[FanpageSwitch] Lỗi đảm bảo phiên Fanpage:', err);
    return false;
  }
}

/**
 * Đảm bảo trình duyệt đã chuyển về danh tính cá nhân khi cần
 */
async function ensurePersonalProfileSwitched(personalId, personalName, windowId = null) {
  try {
    const targetUrl = 'https://www.facebook.com/?_r=' + Date.now();
    const tabOpts = { url: targetUrl, active: false };
    if (windowId) {
      try {
        const win = await chrome.windows.get(windowId);
        if (win) tabOpts.windowId = windowId;
      } catch (_) {}
    }

    const tempTab = await chrome.tabs.create(tabOpts);
    if (!tempTab?.id) return false;

    await waitForTabLoaded(tempTab.id, 15000);
    await new Promise(r => setTimeout(r, 1200));

    await chrome.scripting.executeScript({
      target: { tabId: tempTab.id },
      func: runPersonalProfileSwitcher,
      args: [String(personalId || ''), String(personalName || '')]
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 2000));
    try { await chrome.tabs.remove(tempTab.id); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

// ── Session Manager: Quản lý đăng xuất / đăng nhập khi chuyển tab giữa các tài khoản ──
let currentSessionAccountId = null;

async function prepareAccountSession(accountId) {
  const accounts = await readAccounts();
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) throw new Error('Không tìm thấy thông tin tài khoản: ' + accountId);

  // Trên môi trường Web Platform (web adapter), không có quyền chrome.cookies/scripting của facebook.com
  // Bỏ qua nạp cookies và chuyển đổi profile để chạy thẳng tab Facebook
  if (typeof chrome !== 'undefined' && chrome.runtime?.id === 'ntd-agency-webapp') {
    return acc;
  }

  isSwitchingSession = true;
  try {
    let parentAcc = null;
    if (acc.type === 'fanpage') {
      if (acc.parentAccountId) {
        parentAcc = accounts.find(a => a.id === acc.parentAccountId);
      }
      if (!parentAcc) {
        parentAcc = accounts.find(a => a.type !== 'fanpage' && a.cookies);
      }
    }

    const rawCookies = (acc.cookies && acc.cookies.trim()) ? acc.cookies : (parentAcc?.cookies || '');
    const cookieObj = parseUniversalCookies(rawCookies);

    // Lưu lại cookie vào chính Fanpage nếu chưa có để đảm bảo độc lập
    if (acc.type === 'fanpage' && !acc.cookies && rawCookies) {
      acc.cookies = rawCookies;
      acc.lastCookieSync = Date.now();
      await saveAccounts(accounts);
    }

    // UID của phiên đăng nhập (luôn là c_user của nick cá nhân sở hữu phiên)
    const expectedCUser = acc.type === 'fanpage'
      ? (cookieObj['c_user'] || parentAcc?.fbId || '')
      : (acc.fbId || cookieObj['c_user'] || '');

    const fbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
    const activeCUser = fbCookies.find(c => c.name === 'c_user')?.value;
    const pageId = (acc.type === 'fanpage') ? String(acc.pageId || acc.fbId || '') : null;

    // Chỉ đổi session khi: Chưa có c_user hoặc c_user khác nick cá nhân cần dùng
    const needSwitchUser = !activeCUser || (expectedCUser && activeCUser !== expectedCUser);

    if (needSwitchUser) {
      console.log(`[AccountSwitch] Chuyển đổi phiên cá nhân sang "${acc.name}" (UID: ${expectedCUser || 'chưa rõ'})`);
      const hasDatrInAcc = Boolean(cookieObj['datr']);

      // 1. Đăng xuất session cũ
      await clearFacebookCookiesOnly(!hasDatrInAcc);
      await new Promise(r => setTimeout(r, 200));

      // 2. Nạp cookies tài khoản mới vào trình duyệt
      if (rawCookies && Object.keys(cookieObj).length > 0) {
        await injectCookies(cookieObj);
        await new Promise(r => setTimeout(r, 300));
      }
    } else {
      // Đã đúng nick cá nhân, đảm bảo c_user & xs vẫn hiện diện
      if (rawCookies && Object.keys(cookieObj).length > 0) {
        const hasCUser = fbCookies.some(c => c.name === 'c_user');
        if (!hasCUser) {
          await injectCookies(cookieObj);
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    currentSessionAccountId = accountId;

    // 3. Xác minh cookies đã được nạp thành công vào Chrome
    const verifyCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
    const verifiedCUser = verifyCookies.find(c => c.name === 'c_user')?.value;
    if (!verifiedCUser && rawCookies && Object.keys(cookieObj).length > 0) {
      await injectCookies(cookieObj);
      await new Promise(r => setTimeout(r, 300));
    }

    // 4. Quản lý danh tính Fanpage (cookie i_user) & Tự động chuyển đổi session:
    if (acc.type === 'fanpage' && pageId) {
      console.log(`[Fanpage] Thiết lập danh tính Fanpage "${acc.name}" (Page ID: ${pageId})`);
      const targetUrls = [
        'https://www.facebook.com/',
        'https://m.facebook.com/',
        'https://web.facebook.com/',
        'https://facebook.com/'
      ];
      for (const targetUrl of targetUrls) {
        await chrome.cookies.set({
          url: targetUrl,
          domain: 'facebook.com',
          name: 'i_user',
          value: pageId,
          path: '/',
          secure: true,
          sameSite: 'lax'
        }).catch(() => {});
      }

      // Tự động kiểm tra và chuyển profile Facebook sang Fanpage Pro5 nếu chưa chuyển
      if (currentActiveFacebookProfileId !== pageId) {
        const { panelWindowId } = await chrome.storage.local.get('panelWindowId');
        await ensureFanpageProfileSwitched(pageId, acc.name, panelWindowId);
        currentActiveFacebookProfileId = pageId;
      }
    } else {
      // Nick cá nhân: Xóa cookie i_user để về đúng trang cá nhân
      const targetUrls = ['https://www.facebook.com/', 'https://m.facebook.com/', 'https://facebook.com/'];
      for (const targetUrl of targetUrls) {
        await chrome.cookies.remove({ url: targetUrl, name: 'i_user' }).catch(() => {});
      }

      // Nếu trước đó đang ở phiên Fanpage, tự động chuyển về trang cá nhân
      const personalTargetId = acc.fbId || expectedCUser;
      if (currentActiveFacebookProfileId && currentActiveFacebookProfileId !== personalTargetId) {
        const { panelWindowId } = await chrome.storage.local.get('panelWindowId');
        await ensurePersonalProfileSwitched(personalTargetId, acc.name, panelWindowId);
        currentActiveFacebookProfileId = personalTargetId;
      }
    }

    return acc;
  } finally {
    setTimeout(() => { isSwitchingSession = false; }, 2000);
  }
}

// ── Advance Campaign & Coordinator Manager ────────────────────────────────────
async function advanceCampaign(accountId, { isError = false, isSkipped = false, hitDailyLimit = false, note = null } = {}) {
  const campaigns = await readCampaigns();
  const c = campaigns[accountId];
  if (!c) return;

  c.active = null;

  const isDone = c.index >= c.jobs.length || hitDailyLimit;
  if (isDone) {
    c.state = 'done';
    if (hitDailyLimit) {
      c.breakNote = note || `🛑 Đạt giới hạn bài hôm nay. Tự động dừng để bảo vệ tài khoản.`;
    } else {
      c.breakNote = null;
    }

    if (!c.notifiedZaloDone) {
      c.notifiedZaloDone = true;
      const typeLabel = c.accountType === 'fanpage' ? 'fanpage' : 'personal';
      const totalJobs = c.jobs ? c.jobs.length : 0;
      const postedCount = c.postedCount || 0;
      
      if (hitDailyLimit) {
        sendFacebookZaloNotify({
          kind: 'daily_limit',
          accountName: c.accountName || accountId,
          accountType: typeLabel,
          postedCount,
          totalJobs,
          note: c.breakNote
        }).catch(() => {});
      } else {
        sendFacebookZaloNotify({
          kind: 'done',
          accountName: c.accountName || accountId,
          accountType: typeLabel,
          postedCount,
          totalJobs,
          note: `Đã hoàn thành đăng ${postedCount}/${totalJobs} nhóm thành công.`
        }).catch(() => {});
      }
    }
  }

  // Fast gap on error or skipped (5-8s), otherwise regular anti-spam gap
  const fastDelay = Math.floor(Math.random() * 3000) + 5000;
  const delayMs = (isSkipped || isError) ? fastDelay : calcDelayMs(c);

  const coord = await readCoordinator();

  if (coord?.mode === 'round_robin') {
    let nextAccId = null;
    let nextTurn = -1;
    for (let i = 1; i <= coord.order.length; i++) {
      const candidateIdx = (coord.currentTurn + i) % coord.order.length;
      const candidateId = coord.order[candidateIdx];
      const cand = campaigns[candidateId];
      if (cand && !['done', 'stopped', 'blocked', 'paused'].includes(cand.state) && cand.index < cand.jobs.length) {
        nextAccId = candidateId;
        nextTurn = candidateIdx;
        break;
      }
    }

    if (nextAccId) {
      if (nextAccId === accountId) {
        if (!isDone) {
          c.state = 'running';
          c.nextAt = Date.now() + delayMs;
          c.breakNote = isSkipped ? 'Bỏ qua nhóm không phù hợp, chuẩn bị nhóm tiếp...' : (isError ? 'Nhóm trước lỗi, chuẩn bị nhóm tiếp...' : null);
          await scheduleAccountTick(accountId, c.nextAt);
        } else {
          await maybeStopGlobalAlarm();
        }
      } else {
        if (!isDone) {
          c.state = 'waiting';
          c.nextAt = 0;
          c.breakNote = 'Đang chờ đến lượt đăng...';
        }
        const nextCamp = campaigns[nextAccId];
        nextCamp.state = 'running';
        nextCamp.nextAt = Date.now() + delayMs;
        nextCamp.breakNote = isSkipped ? 'Chuyển lượt sang nick tiếp theo...' : (isError ? 'Nhóm trước lỗi, chuyển lượt nick tiếp...' : 'Đang chuẩn bị đăng...');
        coord.currentTurn = nextTurn;
        await saveCoordinator(coord);
        await scheduleAccountTick(nextAccId, nextCamp.nextAt);
      }
    } else {
      await maybeStopGlobalAlarm();
    }
  } else if (coord?.mode === 'sequential') {
    if (!isDone) {
      const breakAfter = Number(c.breakAfter) || 5;
      const breakMinutes = Number(c.breakMinutes) || 10;
      if (!isSkipped && !isError && c.enableBreak && c.postedCount > 0 && c.postedCount % breakAfter === 0) {
        const breakMs = breakMinutes * 60 * 1000;
        c.nextAt = Date.now() + breakMs;
        c.breakNote = `Đã đăng ${c.postedCount} nhóm. Đang tạm nghỉ ${breakMinutes} phút chống spam...`;
        await scheduleAccountTick(accountId, c.nextAt);
      } else {
        c.nextAt = Date.now() + delayMs;
        c.breakNote = isSkipped ? 'Bỏ qua nhóm không phù hợp, chuẩn bị nhóm tiếp...' : (isError ? 'Nhóm trước lỗi, chuẩn bị nhóm tiếp...' : null);
        await scheduleAccountTick(accountId, c.nextAt);
      }
    } else {
      let nextAccId = null;
      let nextIdx = -1;
      for (let i = coord.currentIndex + 1; i < coord.order.length; i++) {
        const candidateId = coord.order[i];
        const cand = campaigns[candidateId];
        if (cand && !['done', 'stopped', 'blocked', 'paused'].includes(cand.state) && cand.index < cand.jobs.length) {
          nextAccId = candidateId;
          nextIdx = i;
          break;
        }
      }

      if (nextAccId) {
        const nextCamp = campaigns[nextAccId];
        nextCamp.state = 'running';
        nextCamp.nextAt = Date.now() + delayMs;
        nextCamp.breakNote = `Bắt đầu sau ${Math.ceil(delayMs / 1000)}s...`;
        coord.currentIndex = nextIdx;
        await saveCoordinator(coord);
        await scheduleAccountTick(nextAccId, nextCamp.nextAt);
      } else {
        await maybeStopGlobalAlarm();
      }
    }
  } else {
    // Parallel or single
    if (!isDone) {
      const breakAfter = Number(c.breakAfter) || 5;
      const breakMinutes = Number(c.breakMinutes) || 10;
      if (!isSkipped && !isError && c.enableBreak && c.postedCount > 0 && c.postedCount % breakAfter === 0) {
        const breakMs = breakMinutes * 60 * 1000;
        c.nextAt = Date.now() + breakMs;
        c.breakNote = `Đã đăng ${c.postedCount} nhóm. Đang tạm nghỉ ${breakMinutes} phút chống spam...`;
        await scheduleAccountTick(accountId, c.nextAt);
      } else {
        c.nextAt = Date.now() + delayMs;
        c.breakNote = isSkipped ? 'Bỏ qua nhóm không phù hợp, chuẩn bị nhóm tiếp...' : (isError ? 'Nhóm trước lỗi, chuẩn bị nhóm tiếp...' : null);
        await scheduleAccountTick(accountId, c.nextAt);
      }
    } else {
      await maybeStopGlobalAlarm();
    }
  }

  await saveCampaigns(campaigns);
}

// ── Tick: advance one job for a given account ─────────────────────────────────
async function tick(accountId) {
  const campaigns = await readCampaigns();
  const c = campaigns[accountId];
  if (!c || c.state !== 'running') return;

  if (c.active) {
    // Check for timeout (2 minutes)
    if (Date.now() - c.active.since > 120000) {
      if (c.active.tabId) {
        chrome.tabs.remove(c.active.tabId).catch(() => {});
      }
      c.jobs[c.index].status = 'error';
      c.jobs[c.index].note = 'Quá thời gian xử lý (2 phút). Tự động chuyển nhóm tiếp theo.';
      c.jobs[c.index].doneAt = Date.now();
      c.index++;
      await saveCampaigns({...campaigns, [accountId]: c});
      await advanceCampaign(accountId, { isError: true, note: 'Quá thời gian xử lý (2 phút).' });
    }
    return;
  }

  if (c.nextAt > Date.now()) return;

  if (c.enableDailyLimit !== false) {
    const todayCount = await getDailyCount(accountId);
    const limit = c.dailyLimit || 20;
    if (todayCount >= limit) {
      await advanceCampaign(accountId, {
        hitDailyLimit: true,
        note: `🛑 Đã đăng ${todayCount}/${limit} bài hôm nay (Đạt giới hạn ngày). Tự động dừng để bảo vệ tài khoản.`
      });
      return;
    }
  }

  if (c.index >= c.jobs.length) {
    await advanceCampaign(accountId);
    return;
  }

  // ── Đảm bảo an toàn đa tài khoản: Không mở nhiều tab Facebook xung đột phiên cùng lúc ─
  const isAnyOtherActive = Object.entries(campaigns).some(([otherId, otherCamp]) => 
    otherId !== accountId && otherCamp.active && otherCamp.state === 'running'
  );
  if (isAnyOtherActive) {
    // Tài khoản khác đang đăng bài trên tab Facebook -> Đợi 3s để tài khoản đó hoàn tất trước
    await scheduleAccountTick(accountId, Date.now() + 3000);
    return;
  }

  const j = c.jobs[c.index];
  j.status = 'working';
  j.startedAt = j.startedAt || Date.now();
  c.breakNote = null;
  c.active = {since: Date.now(), token: crypto.randomUUID()};
  await saveCampaigns({...campaigns, [accountId]: c});

  try {
    // Chuẩn bị phiên Facebook cho tài khoản này (Tự động đăng xuất tài khoản cũ và đăng nhập/nạp cookies tài khoản này)
    const acc = await prepareAccountSession(accountId);

    // Mở tab Facebook chạy ngầm (active: false) và ưu tiên trong cửa sổ tiện ích
    const { panelWindowId } = await chrome.storage.local.get('panelWindowId');
    const tabOpts = { url: j.url, active: false };
    if (panelWindowId) {
      try {
        const win = await chrome.windows.get(panelWindowId);
        if (win) tabOpts.windowId = panelWindowId;
      } catch (_) {}
    }
    const tab = await chrome.tabs.create(tabOpts);
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (_) {}

    const campaigns2 = await readCampaigns();
    const c2 = campaigns2[accountId];
    if (c2?.active) {
      c2.active.tabId = tab.id;
      await saveCampaigns({...campaigns2, [accountId]: c2});
    }

    // If already loaded, dispatch immediately
    const loaded = await chrome.tabs.get(tab.id).catch(() => null);
    if (loaded?.status === 'complete') await dispatch(accountId, tab.id);
  } catch (e) {
    const campaigns3 = await readCampaigns();
    const c3 = campaigns3[accountId];
    if (c3 && c3.state === 'running') {
      c3.jobs[c3.index].status = 'error';
      c3.jobs[c3.index].note = e.message || 'Lỗi mở tab Facebook.';
      c3.jobs[c3.index].doneAt = Date.now();

      const isFatalAuth = /cookie|phiên|đăng nhập|hết hạn|không tìm thấy|unauthorized/i.test(e.message || '');
      if (c3.autoSkipOnError === false || isFatalAuth) {
        c3.state = 'paused';
        c3.active = null;
        c3.breakNote = 'Tạm dừng do lỗi: ' + (e.message || 'Lỗi mở tab/phiên Facebook.');
        await saveCampaigns({...campaigns3, [accountId]: c3});
        await maybeStopGlobalAlarm();

        sendFacebookZaloNotify({
          kind: 'error',
          accountName: c3.accountName || accountId,
          accountType: c3.accountType,
          groupUrl: c3.jobs[c3.index]?.url,
          note: e.message || 'Lỗi khởi tạo tab hoặc phiên Facebook. Chiến dịch đã tạm dừng.',
          postedCount: c3.postedCount || 0,
          totalJobs: c3.jobs?.length || 0
        }).catch(() => {});
        return;
      }

      c3.index++;
      await saveCampaigns({...campaigns3, [accountId]: c3});
      await advanceCampaign(accountId, { isError: true, note: e.message });
    }
  }
}

// ── Dispatch content script to a tab ─────────────────────────────────────────
async function dispatch(accountId, tabId) {
  const campaigns = await readCampaigns();
  const c = campaigns[accountId];
  if (!c || c.state !== 'running' || c.active?.tabId !== tabId || c.active?.dispatched) return;

  c.active.dispatched = true;
  await saveCampaigns({...campaigns, [accountId]: c});

  try {
    const accounts = await readAccounts();
    const acc = accounts.find(a => a.id === accountId);

    // 1. Tiêm script cấu hình MAIN WORLD để Facebook không bị đóng băng/hạn chế khi Chrome minimize hoặc chạy nền
    try {
      await chrome.scripting.executeScript({
        target: {tabId},
        world: 'MAIN',
        func: () => {
          try {
            // Giữ trạng thái trang luôn là visible & focused cho React Scheduler và Lexical
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            document.hasFocus = () => true;
            window.hasFocus = () => true;

            // Ngăn sự kiện ẩn trang / mất focus báo động cho Facebook
            const stopEvt = e => {
              if (e) {
                try { e.stopImmediatePropagation(); } catch (_) {}
              }
            };
            window.addEventListener('visibilitychange', stopEvt, true);
            document.addEventListener('visibilitychange', stopEvt, true);
            window.addEventListener('blur', stopEvt, true);

            // Polyfill requestAnimationFrame: Khi Chrome bị minimize trên Windows, rAF gốc bị dừng (0 FPS).
            // Timer dự phòng 30ms đảm bảo React concurrent scheduler và các cập nhật state vẫn chạy bình thường.
            const origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
            window.requestAnimationFrame = function(cb) {
              let executed = false;
              const timer = setTimeout(() => {
                if (!executed) {
                  executed = true;
                  try { cb(performance.now()); } catch (_) {}
                }
              }, 30);
              if (origRAF) {
                try {
                  return origRAF(ts => {
                    if (!executed) {
                      executed = true;
                      clearTimeout(timer);
                      try { cb(ts); } catch (_) {}
                    }
                  });
                } catch (_) {}
              }
              return timer;
            };

            // Hook fetch & XMLHttpRequest để bắt trực tiếp permalink từ GraphQL mutation tạo bài viết của Facebook
            (function() {
              if (window.__ntd_graphql_hooked) return;
              window.__ntd_graphql_hooked = true;

              function checkGraphQLForPostCreated(txt, reqBody, reqUrl) {
                if (!txt || typeof txt !== 'string') return;
                try {
                  const isCreateReq = (reqBody && /CometGroupPostCreateMutation|CometGroupPendingPostCreateMutation|ComposerStoryCreateMutation|group_post_create|pending_post_create|CreateGroupPost/i.test(reqBody)) ||
                                      (reqUrl && /CometGroupPostCreateMutation|CometGroupPendingPostCreateMutation|ComposerStoryCreateMutation/i.test(reqUrl));
                  const isCreateRes = /"group_post_create"|"pending_post_create"|"CometGroupPostCreateMutation"/i.test(txt);

                  if (!isCreateReq && !isCreateRes) return;

                  const unescaped = txt.replace(/\\u00253A/g, ':').replace(/\\u00252F/g, '/').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
                  let full = '';
                  let isPending = /pending approval|chờ phê duyệt|chờ duyệt|"pending_post_create"|"pending_post"/i.test(unescaped);

                  const storyMatch = unescaped.match(/"(?:story|pending_post|post)":\s*\{[^}]*?"url":\s*"([^"]+)"/i) ||
                                     unescaped.match(/"group_post_create"[^}]+?"url":\s*"([^"]+)"/i) ||
                                     unescaped.match(/"url"\s*:\s*"(https?:\/\/[a-z0-9.]*facebook\.com\/groups\/[^"]+\/(?:posts|permalink|pending_posts)\/[^"]+)"/i);

                  if (storyMatch && storyMatch[1]) {
                    full = storyMatch[1];
                  } else {
                    const m = unescaped.match(/(https?:\/\/[a-z0-9.]*facebook\.com)?(\/groups\/[^/"'\s<>]+\/(?:posts|permalink|pending_posts)\/[a-zA-Z0-9_.-]+)/i);
                    if (m && m[2]) full = m[2];
                  }

                  if (full) {
                    if (!full.startsWith('http')) full = 'https://www.facebook.com' + full;
                    if (!full.endsWith('/')) full += '/';
                    if (full.includes('/pending_posts/')) isPending = true;

                    try {
                      document.documentElement.dataset.ntdCapturedPostUrl = full;
                      document.documentElement.dataset.ntdCapturedIsPending = isPending ? 'true' : 'false';
                    } catch (_) {}

                    window.dispatchEvent(new CustomEvent('__ntd_fb_post_created', {
                      detail: { url: full, isPending: isPending }
                    }));
                  }
                } catch (_) {}
              }

              if (typeof window.fetch === 'function') {
                const origFetch = window.fetch;
                window.fetch = async function(...args) {
                  const res = await origFetch.apply(this, args);
                  try {
                    const url = (args[0] && typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
                    if (url.includes('/api/graphql/') || url.includes('/graphql')) {
                      let reqBody = '';
                      if (args[1] && args[1].body) {
                        const b = args[1].body;
                        if (typeof b === 'string') {
                          reqBody = b;
                        } else if (b instanceof FormData) {
                          try { reqBody = b.get('fb_api_req_friendly_name') || ''; } catch (_) {}
                        } else if (b instanceof URLSearchParams) {
                          reqBody = b.toString();
                        }
                      }
                      res.clone().text().then(txt => checkGraphQLForPostCreated(txt, reqBody, url)).catch(() => {});
                    }
                  } catch (_) {}
                  return res;
                };
              }

              if (typeof window.XMLHttpRequest === 'function') {
                const origOpen = XMLHttpRequest.prototype.open;
                const origSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function(method, url) {
                  this.__ntd_url = url;
                  return origOpen.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send = function(body) {
                  const reqBody = (body && typeof body === 'string') ? body : '';
                  this.addEventListener('load', function() {
                    try {
                      if (this.__ntd_url && (this.__ntd_url.includes('/api/graphql/') || this.__ntd_url.includes('/graphql'))) {
                        checkGraphQLForPostCreated(this.responseText, reqBody, this.__ntd_url);
                      }
                    } catch (_) {}
                  });
                  return origSend.apply(this, arguments);
                };
              }
            })();
          } catch (_) {}
        }
      });
    } catch (_) {}

    let parentAcc = null;
    if (acc?.type === 'fanpage') {
      parentAcc = accounts.find(a => a.id === acc.parentAccountId) || accounts.find(a => a.type !== 'fanpage');
    }

    // 2. Chờ 1200ms để Facebook SPA ổn định routing / redirects
    await new Promise(r => setTimeout(r, 1200));

    // Đảm bảo tab vẫn còn tồn tại trước khi tiêm script
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!currentTab || !currentTab.url) return;

    // Chạy content script xử lý tự động đăng bài
    await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});

    // Lấy ảnh đính kèm: CHỈ nạp từ campaignPictures nếu bài viết THỰC SỰ có đính kèm ảnh (c.picture không null)
    // Và nếu bài viết có áp dụng nền màu Facebook (c.background) thì TUYỆT ĐỐI không đính kèm ảnh
    let jobPicture = null;
    if (c.picture && (!c.background || c.background === 'none')) {
      if (c.picture.data) {
        jobPicture = c.picture;
      } else if (c.postIndex !== undefined) {
        try {
          const { campaignPictures = {} } = await chrome.storage.local.get('campaignPictures');
          if (campaignPictures && campaignPictures[c.postIndex]) {
            jobPicture = campaignPictures[c.postIndex];
          }
        } catch (_) {}
      }
    }

    const jobPayload = {
      type: 'RUN',
      job: {
        id: c.id,
        accountId,
        accountName: acc?.name || '',
        accountType: acc?.type || 'personal',
        pageId: acc?.pageId || null,
        accountEmail: acc?.email || parentAcc?.email || '',
        accountPassword: acc?.password || parentAcc?.password || '',
        twoFactor: acc?.twoFactor || parentAcc?.twoFactor || null,
        token: c.active.token,
        url: c.jobs[c.index].url,
        text: c.text,
        picture: jobPicture,
        background: c.background || null,
        postLinkMode: !!c.postLinkMode,
        mode: c.mode,
        randomTag: c.randomTag,
        humanBehavior: c.humanBehavior,
      }
    };

    let ackReceived = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await chrome.tabs.sendMessage(tabId, jobPayload);
        if (resp && resp.ok) {
          ackReceived = true;
          break;
        }
      } catch (err) {
        const liveTab = await chrome.tabs.get(tabId).catch(() => null);
        if (!liveTab) break;
        await new Promise(r => setTimeout(r, 1500));
        await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']}).catch(() => {});
      }
    }

    if (!ackReceived) {
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      const cx = await readCampaigns();
      const cv = cx[accountId];
      if (cv?.active?.token === c.active.token && cv.state === 'running') {
        cv.jobs[cv.index].status = 'unknown';
        cv.jobs[cv.index].note = 'Không nhận được phản hồi từ tab Facebook sau 3 lần thử.';
        cv.jobs[cv.index].doneAt = Date.now();
        if (cv.autoSkipOnError === false) {
          cv.state = 'paused';
          cv.active = null;
          cv.breakNote = 'Tạm dừng: Không nhận được phản hồi từ tab Facebook sau 3 lần thử.';
          await saveCampaigns({...cx, [accountId]: cv});
          await maybeStopGlobalAlarm();

          sendFacebookZaloNotify({
            kind: 'error',
            accountName: cv.accountName || accountId,
            accountType: cv.accountType,
            groupUrl: cv.jobs[cv.index]?.url,
            note: 'Không nhận được phản hồi từ tab Facebook sau 3 lần thử. Chiến dịch đã tạm dừng.',
            postedCount: cv.postedCount || 0,
            totalJobs: cv.jobs?.length || 0
          }).catch(() => {});
          return;
        }
        cv.index++;
        await saveCampaigns({...cx, [accountId]: cv});
        await advanceCampaign(accountId, { isError: true, note: 'Không nhận được phản hồi từ tab Facebook.' });
      }
    }
  } catch (e) {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    const cx = await readCampaigns();
    const cv = cx[accountId];
    if (cv && cv.state === 'running') {
      cv.jobs[cv.index].status = 'error';
      cv.jobs[cv.index].note = e.message || 'Lỗi nạp script đăng bài.';
      cv.jobs[cv.index].doneAt = Date.now();
      if (cv.autoSkipOnError === false) {
        cv.state = 'paused';
        cv.active = null;
        cv.breakNote = 'Tạm dừng: ' + (e.message || 'Lỗi nạp script đăng bài.');
        await saveCampaigns({...cx, [accountId]: cv});
        await maybeStopGlobalAlarm();

        sendFacebookZaloNotify({
          kind: 'error',
          accountName: cv.accountName || accountId,
          accountType: cv.accountType,
          groupUrl: cv.jobs[cv.index]?.url,
          note: (e.message || 'Lỗi nạp script đăng bài.') + ' Chiến dịch đã tạm dừng.',
          postedCount: cv.postedCount || 0,
          totalJobs: cv.jobs?.length || 0
        }).catch(() => {});
        return;
      }
      cv.index++;
      await saveCampaigns({...cx, [accountId]: cv});
      await advanceCampaign(accountId, { isError: true, note: e.message });
    }
  }
}

// ── Power keep-awake helper (ngăn máy tính / Chrome ngủ đông khi đang đăng bài) ──
function updateKeepAwake(hasActiveCampaigns) {
  if (chrome.power) {
    try {
      if (hasActiveCampaigns) {
        chrome.power.requestKeepAwake('system');
      } else {
        chrome.power.releaseKeepAwake();
      }
    } catch (_) {}
  }
}

// ── Accurate Alarm Scheduler: Đảm bảo tự động chạy ngầm ngay cả khi Chrome tắt SW ─
async function scheduleAccountTick(accountId, whenTimestamp) {
  const now = Date.now();
  const delayMs = Math.max(0, whenTimestamp - now);
  const alarmName = 'tick_' + accountId;

  try { await chrome.alarms.clear(alarmName); } catch (_) {}

  if (delayMs < 60000) {
    setTimeout(() => locked(accountId, () => tick(accountId)), Math.max(50, delayMs));
  }

  // Tạo alarm chính xác đánh thức Service Worker bất cứ lúc nào
  const targetTime = Math.max(now + 1000, whenTimestamp);
  await chrome.alarms.create(alarmName, { when: targetTime });

  // Duy trì alarm nhịp tim 1 phút làm mạng lưới an toàn
  await chrome.alarms.create('queue', { periodInMinutes: 1 });
  updateKeepAwake(true);
}

// ── Google Maps Scraper (Rin-Maps) Integration ──────────────────────────────
let mapsSerial = Promise.resolve(), mapsPowerTab = null;
chrome.tabs.onRemoved.addListener(id => {
  if (id === mapsPowerTab) {
    try { chrome.power?.releaseKeepAwake?.(); } catch (_) {}
    mapsPowerTab = null;
  }
});

function lockedMaps(fn) {
  const r = mapsSerial.then(fn);
  mapsSerial = r.catch(() => {});
  return r;
}

async function mapsZaloApi(token, method, body) {
  if (!token || /[\s/?#]/.test(token)) throw Error('Bot Token trống hoặc sai định dạng.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch('https://bot-api.zaloplatforms.com/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let d;
    try {
      d = await r.json();
    } catch {
      throw Error('Zalo không trả JSON (HTTP ' + r.status + ').');
    }
    if (!r.ok || d.ok !== true) {
      throw Error('Zalo từ chối (HTTP ' + r.status + '): ' + String(d.description || d.message || d.error_code || 'Kiểm tra Token, quyền gửi và hạn mức.').replaceAll(token, '[ẩn]').slice(0, 240));
    }
    return d.result;
  } catch (e) {
    if (e.name === 'AbortError') throw Error('Kết nối Zalo quá thời gian.');
    if (e instanceof TypeError) throw Error('Không kết nối được Zalo. Kiểm tra mạng.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function flushMapsQueue() {
  const s = await chrome.storage.local.get(['rinZalo', 'rinQueue']);
  const c = s.rinZalo, q = s.rinQueue || [];
  if (!c?.enabled || !c.token || !c.chat || !q.length) return;
  while (q.length) {
    const e = q[0];
    try {
      await mapsZaloApi(c.token, 'sendMessage', { chat_id: c.chat, text: e.text });
      q.shift();
      await chrome.storage.local.set({ rinQueue: q, rinDelivery: { at: Date.now(), ok: true, message: 'Zalo đã nhận yêu cầu gửi tin.' } });
    } catch (err) {
      e.attempts = (e.attempts || 0) + 1;
      await chrome.storage.local.set({ rinQueue: q, rinDelivery: { at: Date.now(), ok: false, message: err.message } });
      break;
    }
  }
}

async function sendZaloNotification(text) {
  return lockedMaps(async () => {
    try {
      const { rinZalo: c, rinQueue: q = [] } = await chrome.storage.local.get(['rinZalo', 'rinQueue']);
      if (!c?.enabled || !c.token || !c.chat) return { ok: true, disabled: true };
      
      const id = crypto.randomUUID();
      q.push({ id, text: String(text).slice(0, 2000), attempts: 0 });
      await chrome.storage.local.set({ rinQueue: q });
      await flushMapsQueue();
      return { ok: true };
    } catch (e) {
      console.warn('[ZaloNotify] Lỗi xếp hàng Zalo:', e);
      return { ok: false, error: e.message };
    }
  });
}

async function sendFacebookZaloNotify({ kind, accountName, accountType, postedCount = 0, totalJobs = 0, groupUrl = '', postUrl = '', note = '', reason = '' }) {
  try {
    const { rinZalo: c = {} } = await chrome.storage.local.get('rinZalo');
    if (!c?.enabled || !c.token || !c.chat) return { ok: true, disabled: true };

    const isErrorOrBlocked = kind === 'blocked' || kind === 'error';
    const isDoneOrLimit = kind === 'done' || kind === 'daily_limit';

    if (isErrorOrBlocked && c.notifyFbError === false) return { ok: true, muted: true };
    if (isDoneOrLimit && c.notifyFbDone === false) return { ok: true, muted: true };

    const titleMap = {
      done: '🎉 HOÀN TẤT CHIẾN DỊCH ĐĂNG BÀI',
      daily_limit: '🛑 ĐẠT GIỚI HẠN BÀI ĐĂNG HÔM NAY',
      blocked: '🛑 CẢNH BÁO FACEBOOK HẠN CHẾ / SPAM',
      error: '⚠️ LỖI ĐĂNG BÀI FACEBOOK',
      stop: '⏸ CHIẾN DỊCH ĐĂNG BÀI ĐÃ DỪNG'
    };
    const title = titleMap[kind] || 'THÔNG BÁO ĐĂNG BÀI FACEBOOK';

    const typeDesc = accountType === 'fanpage' ? 'Fanpage Pro5' : 'Trang cá nhân';
    const lines = [
      'NTD AGENCY — ' + title,
      '👤 Tài khoản: ' + (accountName || 'Facebook Account') + ` (${typeDesc})`,
      '📊 Tiến độ: ' + postedCount + '/' + totalJobs + ' nhóm thành công'
    ];

    if (postUrl) {
      lines.push('🔗 Bài viết đã đăng: ' + String(postUrl).slice(0, 300));
    }
    if (groupUrl) {
      lines.push('🔗 Nhóm: ' + String(groupUrl).slice(0, 300));
    }

    if (note || reason) {
      const detail = String(note || reason).trim();
      lines.push('⚠️ Chi tiết: ' + detail.slice(0, 400));
    }

    lines.push('⏰ Thời gian: ' + new Date().toLocaleString('vi-VN'));

    if (kind === 'done') {
      lines.push('📝 Tất cả nhóm trong danh sách đã hoàn thành. Mở tiện ích NTD Agency để kiểm tra kết quả.');
    } else if (kind === 'daily_limit') {
      lines.push('📝 Đã đạt giới hạn bài đăng hôm nay. Tự động dừng chiến dịch để bảo vệ an toàn cho nick.');
    } else if (kind === 'blocked') {
      lines.push('📝 Facebook có dấu hiệu hạn chế hoặc nghi vấn thao tác nhanh. Hãy kiểm tra lại tài khoản.');
    } else if (kind === 'error') {
      lines.push('📝 Đã xảy ra sự cố trong quá trình đăng bài. Mở tiện ích để kiểm tra chi tiết.');
    }

    const text = lines.join('\n');
    return await sendZaloNotification(text);
  } catch (err) {
    console.warn('[ZaloFBNotify] Lỗi gửi thông báo Facebook:', err);
    return { ok: false, error: err.message };
  }
}

// ── Google Maps Scraper Background Loop & Helpers ───────────────────────────
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

const CURRENT_PHONE_PREFIXES = [
  '032', '033', '034', '035', '036', '037', '038', '039',
  '086', '096', '097', '098',
  '081', '082', '083', '084', '085', '088', '091', '094',
  '070', '076', '077', '078', '079', '089', '090', '093',
  '052', '056', '058', '092',
  '059', '099',
  '087',
  '055'
];

const HOTLINE_PHONE_PREFIXES = [
  '1900', '1800',
  '024', '028',
  '0203', '0204', '0205', '0206', '0207', '0208', '0209',
  '0210', '0211', '0212', '0213', '0214', '0215', '0216', '0218', '0219',
  '0220', '0221', '0222', '0225', '0226', '0227', '0228', '0229',
  '0232', '0233', '0234', '0235', '0236', '0237', '0238', '0239',
  '0251', '0252', '0254', '0255', '0256', '0257', '0258', '0259',
  '0260', '0261', '0262', '0263', '0269',
  '0270', '0271', '0272', '0273', '0274', '0275', '0276', '0277',
  '0290', '0291', '0292', '0293', '0294', '0296', '0297', '0299'
];

const OLD_PHONE_PREFIXES = [
  '0162', '0163', '0164', '0165', '0166', '0167', '0168', '0169',
  '0120', '0121', '0122', '0126', '0128',
  '0123', '0124', '0125', '0127', '0129',
  '0186', '0188',
  '0199'
];

function normPhoneWorker(p) {
  if (!p) return '';
  let s = String(p).replace(/\D+/g, '');
  if (s.startsWith('0084')) s = s.slice(4);
  else if (s.startsWith('84') && s.length >= 10) s = s.slice(2);
  if (/^(1800|1900|111|112|113|114|115|156|5656)/.test(s)) return s;
  if (!s.startsWith('0') && (s.length === 9 || s.length === 10)) s = '0' + s;
  return s;
}

function classifyPhoneWorker(phone) {
  if (!phone) return null;
  const p = normPhoneWorker(phone);
  if (!p) return null;
  for (const pre of CURRENT_PHONE_PREFIXES) {
    if (p.startsWith(pre) && p.length === 10) return 'current';
  }
  for (const pre of HOTLINE_PHONE_PREFIXES) {
    if (p.startsWith(pre)) return 'hotline';
  }
  for (const pre of OLD_PHONE_PREFIXES) {
    if (p.startsWith(pre) && p.length === 11) return 'old';
  }
  if (/^(1800|1900)\d{4,6}$/.test(p) || /^02\d{8,9}$/.test(p)) return 'hotline';
  if (p.length === 10 && p.startsWith('0')) return 'current';
  if (p.length === 11 && p.startsWith('0')) return 'old';
  return 'other';
}

function parsePrefixListWorker(raw) {
  if (Array.isArray(raw)) {
    return raw.map(x => String(x || '').replace(/\D+/g, '')).filter(x => x.length >= 2 && x.length <= 6);
  }
  return String(raw || '')
    .split(/[\s,;|/]+/)
    .map(token => {
      let d = token.replace(/\D+/g, '');
      if (d.startsWith('84') && d.length >= 3) d = '0' + d.slice(2);
      return d;
    })
    .filter(d => d.length >= 2 && d.length <= 6);
}

function isPhoneAllowedWorker(phone, allowedTypes = null) {
  const clean = normPhoneWorker(phone);
  if (!clean) return false;
  const types = allowedTypes || { current: true, hotline: false, old: false };
  const category = classifyPhoneWorker(clean);
  if (!category || !types[category]) return false;
  const customPrefixes = parsePrefixListWorker(types.customPrefixes);
  if (customPrefixes.length > 0) {
    return customPrefixes.some(pre => clean.startsWith(pre));
  }
  return true;
}

const PROVINCE_AREA_CODES_WORKER = {
  'Hà Nội': '024', 'Hồ Chí Minh': '028', 'TP.HCM': '028', 'Sài Gòn': '028',
  'Hải Phòng': '0225', 'Đà Nẵng': '0236', 'Cần Thơ': '0292', 'An Giang': '0296',
  'Bà Rịa - Vũng Tàu': '0254', 'Vũng Tàu': '0254', 'Bạc Liêu': '0291', 'Bắc Giang': '0204',
  'Bắc Kạn': '0209', 'Bắc Ninh': '0222', 'Bến Tre': '0275', 'Bình Dương': '0274',
  'Bình Định': '0256', 'Bình Phước': '0271', 'Bình Thuận': '0252', 'Cà Mau': '0290',
  'Cao Bằng': '0206', 'Đắk Lắk': '0262', 'Đắk Nông': '0261', 'Điện Biên': '0215',
  'Đồng Nai': '0251', 'Đồng Tháp': '0277', 'Gia Lai': '0269', 'Hà Giang': '0219',
  'Hà Nam': '0226', 'Hà Tĩnh': '0239', 'Hải Dương': '0220', 'Hậu Giang': '0293',
  'Hòa Bình': '0218', 'Hưng Yên': '0221', 'Khánh Hòa': '0258', 'Nha Trang': '0258',
  'Kiên Giang': '0297', 'Kon Tum': '0260', 'Lai Châu': '0213', 'Lạng Sơn': '0205',
  'Lào Cai': '0214', 'Lâm Đồng': '0263', 'Đà Lạt': '0263', 'Long An': '0272',
  'Nam Định': '0228', 'Nghệ An': '0238', 'Vinh': '0238', 'Ninh Bình': '0229',
  'Ninh Thuận': '0259', 'Phú Thọ': '0210', 'Phú Yên': '0257', 'Quảng Bình': '0232',
  'Quảng Nam': '0235', 'Hội An': '0235', 'Quảng Ngãi': '0255', 'Quảng Ninh': '0203',
  'Hạ Long': '0203', 'Quảng Trị': '0233', 'Sóc Trăng': '0299', 'Sơn La': '0212',
  'Tây Ninh': '0276', 'Thái Bình': '0227', 'Thái Nguyên': '0208', 'Thanh Hóa': '0237',
  'Thừa Thiên Huế': '0234', 'Huế': '0234', 'Tiền Giang': '0273', 'Mỹ Tho': '0273',
  'Trà Vinh': '0294', 'Tuyên Quang': '0207', 'Vĩnh Long': '0270', 'Vĩnh Phúc': '0211',
  'Yên Bái': '0216'
};

function resolveBusinessPhoneWorker(name = '', address = '', query = '', allowedTypes = null, rawPhone = '') {
  const activeTypes = allowedTypes || { current: true, hotline: false, old: false };

  if (rawPhone) {
    const clean = normPhoneWorker(rawPhone);
    const cat = classifyPhoneWorker(clean);
    if (cat && activeTypes[cat]) return clean;
  }

  const textToScan = `${name} ${address} ${query}`;
  const phoneMatches = textToScan.match(/(?:(?:\+?84|0)[1-9]\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4})|1[89]00[\s.-]?\d{4,6}/g);
  if (phoneMatches) {
    for (const m of phoneMatches) {
      const clean = normPhoneWorker(m);
      const cat = classifyPhoneWorker(clean);
      if (cat && activeTypes[cat]) return clean;
    }
  }

  let hash = 0;
  const seed = (name + '|' + address + '|' + query).toLowerCase();
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  hash = Math.abs(hash);

  const fullLoc = (address + ' ' + query).toLowerCase();
  let provinceCode = null;
  for (const [pName, pCode] of Object.entries(PROVINCE_AREA_CODES_WORKER)) {
    if (fullLoc.includes(pName.toLowerCase())) {
      provinceCode = pCode;
      break;
    }
  }

  const enabledCategories = [];
  if (activeTypes.current) enabledCategories.push('current');
  if (activeTypes.hotline) enabledCategories.push('hotline');
  if (activeTypes.old) enabledCategories.push('old');
  if (!enabledCategories.length) enabledCategories.push('current');

  let chosenCat = enabledCategories[0];
  if (enabledCategories.length > 1) {
    const roll = hash % 100;
    if (enabledCategories.includes('hotline') && roll < 20) {
      chosenCat = 'hotline';
    } else if (enabledCategories.includes('old') && roll >= 95) {
      chosenCat = 'old';
    } else if (enabledCategories.includes('current')) {
      chosenCat = 'current';
    } else {
      chosenCat = enabledCategories[hash % enabledCategories.length];
    }
  }

  if (chosenCat === 'hotline') {
    const isToll = (hash % 10) < 3;
    if (isToll) {
      const pre = (hash % 2 === 0) ? '1900' : '1800';
      const suffix = String(1000 + (hash % 9000));
      return pre + suffix;
    } else {
      const area = provinceCode || '024';
      const numDigits = (area.length === 3) ? 8 : 7;
      let suffix = String(hash).padStart(numDigits, '6').slice(0, numDigits);
      if (suffix.startsWith('0') || suffix.startsWith('1')) suffix = '3' + suffix.slice(1);
      return area + suffix;
    }
  }

  if (chosenCat === 'old') {
    const pre = OLD_PHONE_PREFIXES[hash % OLD_PHONE_PREFIXES.length];
    let suffix = String(hash).padStart(7, '8').slice(0, 7);
    return pre + suffix;
  }

  let pool = [...CURRENT_PHONE_PREFIXES];
  if (fullLoc.includes('đà nẵng') || fullLoc.includes('da nang')) {
    pool = ['090', '093', '089', '098', '097', '086', '091', '094', '088', '070', '079', '038', '039', ...CURRENT_PHONE_PREFIXES];
  } else if (fullLoc.includes('hà nội') || fullLoc.includes('ha noi')) {
    pool = ['098', '097', '096', '086', '090', '091', '094', '088', '038', '039', ...CURRENT_PHONE_PREFIXES];
  } else if (fullLoc.includes('hồ chí minh') || fullLoc.includes('sài gòn') || fullLoc.includes('tphcm')) {
    pool = ['090', '093', '089', '091', '094', '098', '097', '086', '070', '077', '078', ...CURRENT_PHONE_PREFIXES];
  }

  const pre = pool[hash % pool.length];
  let suffix = String(hash).padStart(7, '7').slice(0, 7);
  if (suffix.startsWith('0')) suffix = '5' + suffix.slice(1);
  return pre + suffix;
}

function uniqueMapsKeyWorker(r) {
  return normPhoneWorker(r.phone) || (r.url ? r.url.split('?')[0] : r.name);
}

function addMapsRowWorker(rows, row) {
  const key = uniqueMapsKeyWorker(row);
  const existing = rows.find(r => uniqueMapsKeyWorker(r) === key);
  if (existing) {
    if (row.query && !existing.query.includes(row.query)) {
      existing.query += ' | ' + row.query;
    }
    return false;
  }
  rows.push(row);
  return true;
}

let mapsScanRunning = false;
let mapsScanStop = false;
let mapsCurrentTabId = null;

let fbGroupScanRunning = false;
let fbGroupScanStop = false;
let fbGroupCurrentTabId = null;

let warmupRunning = false;
let warmupStop = false;
let warmupCurrentTabId = null;

chrome.tabs.onRemoved.addListener(id => {
  if (id === mapsCurrentTabId) mapsCurrentTabId = null;
  if (id === fbGroupCurrentTabId) fbGroupCurrentTabId = null;
  if (id === warmupCurrentTabId) {
    warmupCurrentTabId = null;
  }
});

function broadcastMapsMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
  try {
    if (chrome.tabs?.query) {
      chrome.tabs.query({}, (tabs) => {
        if (Array.isArray(tabs)) {
          for (const t of tabs) {
            if (t && t.id) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
          }
        }
      });
    }
  } catch (_) {}
}

function broadcastMapsLog(msg) {
  const time = new Date().toLocaleTimeString('vi-VN');
  broadcastMapsMessage({ type: 'MAPS_LOG_EVENT', msg, time });
}

function broadcastMapsStateSync(state) {
  broadcastMapsMessage({
    type: 'MAPS_STATE_SYNC',
    job: state.job || null,
    isScanning: Boolean(state.isScanning),
    tabId: state.tabId || mapsCurrentTabId || null,
    lastScraped: state.lastScraped || null,
    totalRows: Array.isArray(state.rows) ? state.rows.length : 0,
    recentRows: Array.isArray(state.rows) ? state.rows.slice(-20) : []
  });
}

function safeDecodeUrlPath(p) {
  try {
    return decodeURIComponent(String(p || ''));
  } catch (_) {
    return String(p || '');
  }
}

async function openMapsScraperTab(url) {
  let prevTabUrl = '';
  if (mapsCurrentTabId) {
    try {
      const existingTab = await chrome.tabs.get(mapsCurrentTabId);
      prevTabUrl = existingTab?.url || '';
    } catch {
      mapsCurrentTabId = null;
    }
  }

  if (!mapsCurrentTabId) {
    const t = await chrome.tabs.create({ url, active: false });
    mapsCurrentTabId = t.id;
    await chrome.tabs.update(mapsCurrentTabId, { autoDiscardable: false }).catch(() => {});
  } else {
    await chrome.tabs.update(mapsCurrentTabId, { url, autoDiscardable: false }).catch(() => {});
  }

  const startMs = Date.now();
  const deadline = startMs + 60000;
  await sleepMs(1000);

  const expected = new URL(url);
  let prevPathname = '';
  try { prevPathname = prevTabUrl ? new URL(prevTabUrl).pathname : ''; } catch (_) {}
  const prevDecodedPath = safeDecodeUrlPath(prevPathname);
  const placeSlugMatch = expected.pathname.match(/\/maps\/place\/([^/]+)/);
  const expectedPlaceSlug = placeSlugMatch ? placeSlugMatch[1] : '';
  const expectedDecodedSlug = safeDecodeUrlPath(expectedPlaceSlug);

  while (Date.now() < deadline) {
    if (mapsScanStop) throw Error('Đã bấm dừng; toàn bộ tiến trình đã được lưu lại.');
    const t = await chrome.tabs.get(mapsCurrentTabId).catch(() => null);
    if (!t) throw Error('Tab Google Maps đã bị đóng.');
    if (t.status === 'complete' && !t.pendingUrl) {
      let rs = [];
      try {
        rs = await chrome.scripting.executeScript({
          target: { tabId: mapsCurrentTabId },
          func: () => ({ url: location.href, ready: document.readyState })
        });
      } catch (_) {}
      const page = rs[0]?.result;
      const actual = page?.url ? (() => { try { return new URL(page.url); } catch { return null; } })() : null;

      if (actual && (/sorry/.test(actual.pathname) || actual.hostname.startsWith('consent.'))) {
        throw Error('Google Maps yêu cầu xác minh CAPTCHA hoặc đồng ý điều khoản. Mở tab Maps xử lý rồi bấm Tiếp tục.');
      }

      const actualDecodedPath = actual ? safeDecodeUrlPath(actual.pathname) : '';
      let matching = false;
      if (actual && expected.pathname.includes('/maps/search/')) {
        // Google Maps thường tự thêm /@lat,lng,14z/data=... hoặc chuyển thẳng sang /maps/place/...
        const onMapsPage = actual.pathname.includes('/maps/search/') || actual.pathname.includes('/maps/place/');
        const navigatedAwayFromPrev = !prevDecodedPath || actualDecodedPath !== prevDecodedPath || (Date.now() - startMs > 8000);
        matching = onMapsPage && navigatedAwayFromPrev;
      } else if (actual && expected.pathname.includes('/maps/place/')) {
        const onPlace = actual.pathname.includes('/maps/place/');
        const matchesSlug = !expectedDecodedSlug || actualDecodedPath.includes(expectedDecodedSlug);
        const changedPlace = !prevDecodedPath || actualDecodedPath !== prevDecodedPath || (Date.now() - startMs > 12000);
        matching = onPlace && (matchesSlug || changedPlace);
      } else if (actual) {
        matching = actual.pathname.includes('/maps/');
      }

      if (page?.ready === 'complete' && matching) {
        await sleepMs(450);
        return;
      }
    }
    await sleepMs(500);
  }
  throw Error('Maps chưa tải xong trang tìm kiếm đúng hạn. Vui lòng mở tab Maps kiểm tra rồi tiếp tục.');
}

async function extractFromMapsWorker(mode, limit = 50) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (mapsScanStop) throw Error('Đã bấm dừng; toàn bộ tiến trình đã được lưu lại.');
    const rs = await chrome.scripting.executeScript({
      target: { tabId: mapsCurrentTabId },
      func: mapsExtract,
      args: [mode, limit]
    });
    const result = rs[0]?.result;
    if (result?.error) throw Error(result.error);
    if (result != null) return result;

    if (attempt < 2) {
      await sleepMs(2500);
    }
  }
  throw Error('Tab Maps không trả dữ liệu sau 3 lần thử.');
}

async function runMapsScraperLoop(jobParam, phoneTypesParam, seenKeysParam = null, scanOptions = {}) {
  if (mapsScanRunning) return;
  mapsScanRunning = true;
  mapsScanStop = false;

  let { rinMaps } = await chrome.storage.local.get('rinMaps');
  let state = rinMaps || { rows: [], job: null, settings: null };
  if (!Array.isArray(state.rows) || scanOptions?.resetRows === true) state.rows = [];
  if (!state.seenKeys || typeof state.seenKeys !== 'object') state.seenKeys = {};

  if (jobParam) {
    state.job = jobParam;
    if (!state.rows) state.rows = [];
  }
  if (scanOptions?.resetSeenKeys === true) {
    state.clearedKeepSeen = false;
    state.seenKeys = (seenKeysParam && typeof seenKeysParam === 'object') ? { ...seenKeysParam } : {};
  } else if (jobParam && !state.clearedKeepSeen) {
    // Khởi tạo lại seenKeys đồng bộ theo các dòng thực sự có trong bảng + Web truyền sang, tránh sót key mồ côi
    const activeKeys = {};
    for (const r of state.rows) {
      const k = uniqueMapsKeyWorker(r);
      if (k) activeKeys[k] = true;
    }
    state.seenKeys = { ...activeKeys, ...(seenKeysParam && typeof seenKeysParam === 'object' ? seenKeysParam : {}) };
  } else if (seenKeysParam && typeof seenKeysParam === 'object') {
    state.seenKeys = { ...state.seenKeys, ...seenKeysParam };
  }
  if (phoneTypesParam) {
    if (!state.job) state.job = {};
    state.job.phoneTypes = phoneTypesParam;
  }
  state.isScanning = true;
  state.tabId = mapsCurrentTabId;
  await chrome.storage.local.set({ rinMaps: state });
  broadcastMapsStateSync(state);

  try {
    chrome.power?.requestKeepAwake?.('system');
  } catch (_) {}

  try {
    const j = state.job;
    if (!j || !Array.isArray(j.queries) || !j.queries.length) {
      throw new Error('Không có danh sách từ khóa hợp lệ.');
    }

    while (j.index < j.queries.length && !mapsScanStop) {
      const query = j.queries[j.index];

      // Bước 1: Quét danh sách liên kết
      if (j.links === null || !Array.isArray(j.links)) {
        broadcastMapsLog(`[${j.index + 1}/${j.queries.length}] Đang mở Google Maps tìm: "${query}"...`);
        await openMapsScraperTab('https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=vi');
        j.links = await extractFromMapsWorker('list', j.limit || 50);
        j.cursor = 0;
        state.tabId = mapsCurrentTabId;
        await chrome.storage.local.set({ rinMaps: state });
        broadcastMapsStateSync(state);

        if (j.links.length) {
          broadcastMapsLog(`Tìm thấy ${j.links.length} cơ sở cho: "${query}". Bắt đầu lấy SĐT từng cơ sở...`);
        } else {
          broadcastMapsLog(`Không có kết quả nào cho: "${query}" (tự động chuyển sang từ khóa tiếp theo)`);
        }
      }

      // Bước 2: Đọc thông tin chi tiết từng cơ sở
      while (j.cursor < j.links.length && !mapsScanStop) {
        broadcastMapsLog(`Đang đọc thông tin (${j.cursor + 1}/${j.links.length}) của: ${query}`);
        await openMapsScraperTab(j.links[j.cursor]);
        const row = await extractFromMapsWorker('detail');
        if (mapsScanStop) break;

        const allowedTypes = j.phoneTypes || { current: true, hotline: false, old: false, customPrefixes: [] };
        const rawCandidates = [
          ...(Array.isArray(row.phones) ? row.phones : []),
          ...(row.phone ? [row.phone] : [])
        ];
        const cleanedCandidates = [...new Set(rawCandidates.map(normPhoneWorker).filter(Boolean))];
        const matchedPhone = cleanedCandidates.find(p => isPhoneAllowedWorker(p, allowedTypes)) || '';

        if (cleanedCandidates.length > 0 && !matchedPhone) {
          const sample = cleanedCandidates[0];
          const category = classifyPhoneWorker(sample);
          const typeName = category === 'hotline' ? 'tổng đài/cố định' : category === 'old' ? '11 số cũ' : 'ngoài đầu số lọc';
          broadcastMapsLog(`[Bỏ qua] "${row.name}" có SĐT ${typeName} (${sample}) không khớp bộ lọc đầu số.`);
          j.cursor++;
          await chrome.storage.local.set({ rinMaps: state });
          broadcastMapsStateSync(state);
          continue;
        }

        const finalRow = { ...row, phone: matchedPhone, query };
        const uKey = uniqueMapsKeyWorker(finalRow);
        const alreadyInRows = state.rows.some(r => uniqueMapsKeyWorker(r) === uKey);
        const alreadySeen = Boolean(state.seenKeys[uKey]);
        let wasAdded = false;

        if (!alreadySeen && !alreadyInRows) {
          state.seenKeys[uKey] = true;
          wasAdded = addMapsRowWorker(state.rows, finalRow);
          if (wasAdded) {
            broadcastMapsMessage({ type: 'MAPS_ROW_ADDED', row: finalRow });
          }
        } else if (alreadyInRows) {
          // Đồng bộ ghép thêm từ khóa cho cơ sở đã tồn tại
          addMapsRowWorker(state.rows, finalRow);
        }
        j.cursor++;
        state.tabId = mapsCurrentTabId;
        state.lastScraped = { name: row.name, phone: matchedPhone, time: Date.now() };
        await chrome.storage.local.set({ rinMaps: state });
        broadcastMapsStateSync(state);

        let placeLog;
        if (wasAdded) {
          placeLog = matchedPhone ? `✅ ${row.name} - SĐT: ${matchedPhone}` : `📍 ${row.name} (Google Maps không niêm yết SĐT)`;
        } else {
          placeLog = matchedPhone
            ? `♻️ [Trùng/Đã quét trước] ${row.name} (${matchedPhone})`
            : `♻️ [Đã quét trước] ${row.name}`;
        }
        broadcastMapsLog(placeLog);

        const delaySec = Math.max(2, Number(j.delay) || 5);
        for (let t = 0; t < delaySec * 2 && !mapsScanStop; t++) {
          await sleepMs(500);
        }
      }

      if (!mapsScanStop) {
        j.index++;
        j.links = null;
        j.cursor = 0;
        await chrome.storage.local.set({ rinMaps: state });
        broadcastMapsStateSync(state);
      }
    }

    if (j.index >= j.queries.length) {
      state.job = null;
      state.isScanning = false;
      await chrome.storage.local.set({ rinMaps: state });
      broadcastMapsStateSync(state);
      broadcastMapsLog('🎉 Hoàn tất quét toàn bộ từ khóa Google Maps. Bạn có thể xuất file Excel ngay.');
      await sendMapsZaloNotify('done', 'Quét hoàn tất toàn bộ từ khóa', j, state.rows.length);
    } else {
      state.isScanning = false;
      await chrome.storage.local.set({ rinMaps: state });
      broadcastMapsStateSync(state);
      broadcastMapsLog('Đã dừng quét. Tiến trình đã được lưu lại, bạn có thể bấm Tiếp tục bất cứ lúc nào.');
      await sendMapsZaloNotify('stop', 'Người dùng đã bấm dừng', j, state.rows.length);
    }
  } catch (e) {
    state.isScanning = false;
    await chrome.storage.local.set({ rinMaps: state });
    broadcastMapsStateSync(state);
    broadcastMapsLog('Tạm dừng do sự cố: ' + e.message);
    await sendMapsZaloNotify(mapsScanStop ? 'stop' : 'error', mapsScanStop ? 'Người dùng đã bấm dừng' : e.message, state.job, state.rows.length);
  } finally {
    mapsScanRunning = false;
    state.isScanning = false;
    await chrome.storage.local.set({ rinMaps: state });
    broadcastMapsStateSync(state);
    try {
      if (!warmupRunning) chrome.power?.releaseKeepAwake?.();
    } catch (_) {}
  }
}

async function sendMapsZaloNotify(kind, reason, job, count) {
  try {
    const { rinZalo: c = {} } = await chrome.storage.local.get('rinZalo');
    if (!c?.enabled || !c.token || !c.chat) return { ok: true, disabled: true };
    if (c.notifyMaps === false) return { ok: true, muted: true };

    const titleMap = {
      done: '✅ QUÉT MAPS HOÀN TẤT',
      stop: '⏸ CHIẾN DỊCH MAPS ĐÃ DỪNG',
      error: '⚠️ TẠM DỪNG DO LỖI'
    };
    const title = titleMap[kind] || 'THÔNG BÁO QUÉT MAPS';
    const progress = job ? Math.min(job.index, job.queries.length) + '/' + job.queries.length + ' lượt hoàn thành' : '—';
    const query = job?.queries?.[Math.min(job.index, job.queries.length - 1)] || '—';

    const text = [
      'NTD AGENCY — ' + title,
      'Lý do: ' + String(reason).slice(0, 400),
      'Từ khóa: ' + String(query).slice(0, 700),
      'Tiến độ: ' + progress,
      'Đã lưu: ' + count + ' cơ sở',
      'Thời gian: ' + new Date().toLocaleString('vi-VN'),
      kind === 'done' ? 'Mở tiện ích NTD Agency để xuất Excel.' : 'Tiến trình đã lưu. Mở tiện ích kiểm tra rồi bấm Tiếp tục.'
    ].join('\n');

    return await sendZaloNotification(text);
  } catch (err) {
    console.warn('[ZaloMapsNotify] Lỗi gửi thông báo Maps:', err);
    return { ok: false, error: err.message };
  }
}

async function startMapsScan(jobParam, phoneTypesParam, seenKeysParam = null, scanOptions = {}) {
  if (mapsScanRunning) return { ok: true, running: true, syncVersion: 2, message: 'Tiến trình quét đang chạy.' };
  runMapsScraperLoop(jobParam, phoneTypesParam, seenKeysParam, scanOptions).catch(err => {
    console.error('[MapsScraper] Lỗi chạy loop nền:', err);
  });
  return { ok: true, running: true, syncVersion: 2 };
}

async function stopMapsScan() {
  if (!mapsScanRunning) {
    const { rinMaps } = await chrome.storage.local.get('rinMaps');
    if (rinMaps && rinMaps.isScanning) {
      rinMaps.isScanning = false;
      await chrome.storage.local.set({ rinMaps });
      broadcastMapsStateSync(rinMaps);
    }
    return { ok: true, stopped: true };
  }
  mapsScanStop = true;
  return { ok: true, stopping: true };
}

// ── Facebook Group Phone Scraper Background Loop ─────────────────────────────
function broadcastFbGroupLog(msg) {
  const time = new Date().toLocaleTimeString('vi-VN');
  broadcastMapsMessage({ type: 'FB_GROUP_LOG_EVENT', msg, time });
}

async function waitForFbGroupTab(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fbGroupScanStop) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab Facebook nhóm đã bị đóng.');

    if (tab.status === 'complete' && !tab.pendingUrl) {
      if (tab.url?.includes('/login') || tab.url?.includes('checkpoint')) {
        throw new Error('Facebook chuyển hướng sang trang đăng nhập. Hãy mở tab Facebook đăng nhập rồi tiếp tục.');
      }
      return true;
    }
    await sleepMs(500);
  }
  return true;
}

async function sendFbGroupZaloNotify(kind, reason, job, count) {
  try {
    const { rinZalo: c = {} } = await chrome.storage.local.get('rinZalo');
    if (!c?.enabled || !c.token || !c.chat) return { ok: true, disabled: true };
    if (c.notifyMaps === false) return { ok: true, muted: true };

    const titleMap = {
      done: '✅ QUÉT SỐ NHÓM FACEBOOK HOÀN TẤT',
      stop: '⏸ TIẾN TRÌNH QUÉT NHÓM ĐÃ DỪNG',
      error: '⚠️ TẠM DỪNG DO LỖI'
    };
    const title = titleMap[kind] || 'THÔNG BÁO QUÉT SỐ NHÓM';
    const groupUrl = job?.groupUrl || '—';

    const text = [
      'NTD AGENCY — ' + title,
      'Lý do: ' + String(reason).slice(0, 400),
      'Nhóm FB: ' + String(groupUrl).slice(0, 700),
      'Đã thu thập: ' + count + ' số điện thoại',
      'Thời gian: ' + new Date().toLocaleString('vi-VN'),
      kind === 'done' ? 'Mở tiện ích NTD Agency để xuất file Excel.' : 'Tiến trình đã lưu. Mở tiện ích kiểm tra rồi bấm Tiếp tục.'
    ].join('\n');

    return await sendZaloNotification(text);
  } catch (err) {
    console.warn('[ZaloFbGroupNotify] Lỗi gửi thông báo:', err);
    return { ok: false, error: err.message };
  }
}

async function runFbGroupScraperLoop(jobParam, phoneTypesParam, seenKeysParam = null) {
  if (fbGroupScanRunning) return;
  fbGroupScanRunning = true;
  fbGroupScanStop = false;

  let { rinFbGroup } = await chrome.storage.local.get('rinFbGroup');
  let state = rinFbGroup || { rows: [], job: null, settings: null };
  if (!Array.isArray(state.rows)) state.rows = [];
  if (!state.seenKeys) state.seenKeys = {};

  if (jobParam) {
    state.job = jobParam;
    state.postsCount = 0;
    state.commentsCount = 0;
    if (seenKeysParam && typeof seenKeysParam === 'object') {
      state.seenKeys = { ...seenKeysParam };
    }
  }
  if (phoneTypesParam) {
    if (!state.job) state.job = {};
    state.job.phoneTypes = phoneTypesParam;
  }
  state.isScanning = true;
  state.tabId = fbGroupCurrentTabId;
  await chrome.storage.local.set({ rinFbGroup: state });
  broadcastMapsMessage({
    type: 'FB_GROUP_STATE_SYNC',
    postsCount: state.postsCount || 0,
    commentsCount: state.commentsCount || 0,
    isScanning: true,
    job: state.job
  });

  try {
    chrome.power?.requestKeepAwake?.('system');
  } catch (_) {}

  try {
    const j = state.job;
    if (!j || !j.groupUrl) {
      throw new Error('Chưa nhập đường link nhóm Facebook cần quét.');
    }

    let groupUrls = String(j.groupUrl || '')
      .split(/[\r\n,]+/)
      .map(x => x.trim())
      .filter(Boolean);

    if (!groupUrls.length) {
      throw new Error('Không tìm thấy link nhóm Facebook hợp lệ.');
    }

    if (j.groupIndex == null) j.groupIndex = 0;

    const maxPostsPerGroup = Math.max(5, Math.min(5000, Number(j.maxPosts) || 500));
    const delaySec = Math.max(2, Math.min(30, Number(j.scrollDelay) || 3));
    const allowedTypes = j.phoneTypes || { current: true, hotline: false, old: false };
    const scanOptions = j.options || { scanPosts: true, scanComments: true, scanImages: true };

    broadcastFbGroupLog(`🚀 Bắt đầu quét số nhóm Facebook (Quy tắc: tối đa ${maxPostsPerGroup} bài viết / mỗi link nhóm, tổng ${groupUrls.length} nhóm)...`);

    while (j.groupIndex < groupUrls.length && !fbGroupScanStop) {
      const rawUrl = groupUrls[j.groupIndex];
      let targetUrl = rawUrl;
      if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
      if (!targetUrl.includes('sorting_setting=')) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL';
      }

      broadcastFbGroupLog(`[Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Đang mở nhóm: ${rawUrl}`);

      if (fbGroupCurrentTabId) {
        try {
          await chrome.tabs.get(fbGroupCurrentTabId);
          await chrome.tabs.update(fbGroupCurrentTabId, { url: targetUrl, autoDiscardable: false });
        } catch (_) {
          fbGroupCurrentTabId = null;
        }
      }
      if (!fbGroupCurrentTabId) {
        const t = await chrome.tabs.create({ url: targetUrl, active: false });
        fbGroupCurrentTabId = t.id;
        await chrome.tabs.update(fbGroupCurrentTabId, { autoDiscardable: false }).catch(() => {});
      }

      state.tabId = fbGroupCurrentTabId;
      await chrome.storage.local.set({ rinFbGroup: state });

      await waitForFbGroupTab(fbGroupCurrentTabId, 25000);
      if (fbGroupScanStop) break;

      // Nạp hook cuộn trong MAIN world
      await chrome.scripting.executeScript({
        target: { tabId: fbGroupCurrentTabId },
        world: 'MAIN',
        files: ['fb_scroll_hook.js']
      }).catch(() => {});

      // Nạp script trích xuất dữ liệu nhóm
      await chrome.scripting.executeScript({
        target: { tabId: fbGroupCurrentTabId },
        files: ['fb_group_extract.js']
      }).catch(() => {});

      await sleepMs(2000);
      if (fbGroupScanStop) break;

      // Lưu trữ tập hợp các bài viết duy nhất đã duyệt trong nhóm hiện tại
      const seenPostKeysInThisGroup = new Set();
      let stagnantCount = 0;
      let totalPostsScannedInGroup = 0;
      let previousPostCount = 0;
      let scanRound = 0;

      while (!fbGroupScanStop && totalPostsScannedInGroup < maxPostsPerGroup && stagnantCount < 25) {
        scanRound++;

        // 1. Tự động mở rộng "Xem thêm" và "Xem thêm bình luận"
        await chrome.scripting.executeScript({
          target: { tabId: fbGroupCurrentTabId },
          func: () => {
            if (typeof window.expandSeeMoreAndComments === 'function') {
              return window.expandSeeMoreAndComments(6);
            }
          }
        }).catch(() => {});

        await sleepMs(1000);
        if (fbGroupScanStop) break;

        // 2. Trích xuất toàn bộ SĐT trong bài viết, ảnh, cmt
        const extractRes = await chrome.scripting.executeScript({
          target: { tabId: fbGroupCurrentTabId },
          func: (opts) => {
            if (typeof window.extractGroupPhonesFromDOM === 'function') {
              return window.extractGroupPhonesFromDOM(opts);
            }
            return { items: [], postsCount: 0, postKeys: [], commentsCount: 0, groupTitle: '' };
          },
          args: [scanOptions]
        }).catch(() => null);

        const data = extractRes?.[0]?.result || { items: [], postsCount: 0, postKeys: [], commentsCount: 0, groupTitle: '' };
        const foundItems = data.items || [];

        // Đếm chính xác bài viết duy nhất bằng tập hợp postKeys
        if (Array.isArray(data.postKeys)) {
          for (const pk of data.postKeys) {
            if (pk) seenPostKeysInThisGroup.add(pk);
          }
        }
        totalPostsScannedInGroup = Math.max(seenPostKeysInThisGroup.size, data.postsCount || 0);

        let newPhonesAddedInRound = 0;
        for (const item of foundItems) {
          const phone = item.phone;
          if (!phone) continue;

          const category = item.category || classifyPhoneWorker(phone);
          if (!isPhoneAllowedWorker(phone, allowedTypes)) continue;

          // Bỏ trùng lặp SĐT
          const key = normPhoneWorker(phone) || phone;
          if (state.seenKeys[key]) continue;
          state.seenKeys[key] = true;

          const fbRow = {
            id: 'fg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            phone: key,
            rawPhone: item.rawPhone || phone,
            name: item.name || 'Thành viên nhóm',
            source: item.source || 'Bài viết',
            context: item.context || '',
            postUrl: item.postUrl || rawUrl,
            groupName: data.groupTitle || item.groupName || 'Nhóm Facebook',
            groupUrl: rawUrl,
            category: category,
            at: new Date().toLocaleString('vi-VN')
          };
          state.rows.push(fbRow);
          broadcastMapsMessage({ type: 'FB_GROUP_ROW_ADDED', row: fbRow });
          newPhonesAddedInRound++;

          broadcastFbGroupLog(`✅ Tìm thấy SĐT: ${key} (${item.name} – Nguồn: ${item.source})`);
        }

        state.tabId = fbGroupCurrentTabId;
        state.postsCount = (state.totalPostsOffset || 0) + totalPostsScannedInGroup;
        state.commentsCount = (state.commentsCount || 0) + (data.commentsCount || 0);
        await chrome.storage.local.set({ rinFbGroup: state });
        broadcastMapsMessage({
          type: 'FB_GROUP_STATE_SYNC',
          postsCount: state.postsCount,
          commentsCount: state.commentsCount,
          isScanning: state.isScanning,
          job: state.job
        });

        if (totalPostsScannedInGroup > previousPostCount || newPhonesAddedInRound > 0) {
          stagnantCount = 0;
          previousPostCount = totalPostsScannedInGroup;
        } else {
          stagnantCount++;
        }

        broadcastFbGroupLog(`[Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Vòng ${scanRound}: Đã duyệt ${totalPostsScannedInGroup}/${maxPostsPerGroup} bài | Tìm thấy ${state.rows.length} SĐT`);

        if (totalPostsScannedInGroup >= maxPostsPerGroup) {
          broadcastFbGroupLog(`🎉 [Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Đã quét đủ chỉ tiêu ${maxPostsPerGroup} bài viết cho link này!`);
          break;
        }

        // 3. Cuộn trang tiếp (Hỗ trợ cuộn trong Popup bài viết hoặc Bảng tin nhóm)
        const scrollRes = await chrome.scripting.executeScript({
          target: { tabId: fbGroupCurrentTabId },
          func: (stagnant) => {
            if (typeof window.scrollPostDialogOrFeed === 'function') {
              return window.scrollPostDialogOrFeed(stagnant);
            }
            if (typeof window.scrollFacebookGroupFeed === 'function') {
              return window.scrollFacebookGroupFeed(stagnant);
            }
            window.scrollBy({ top: 3000, behavior: 'smooth' });
          },
          args: [stagnantCount]
        }).catch(() => null);

        const scrollInfo = scrollRes?.[0]?.result;
        if (scrollInfo?.isDialog && scrollInfo?.closed) {
          broadcastFbGroupLog(scrollInfo.message || '💬 Đã bỏ qua/đóng bài viết và cuộn tiếp sang bài mới.');
        } else if (scrollInfo?.isDialog) {
          broadcastFbGroupLog(`💬 Đang lướt đọc bình luận trong bài viết (Lượt ${scrollInfo.scrollRounds || 1})...`);
        }

        for (let t = 0; t < delaySec * 2 && !fbGroupScanStop; t++) {
          await sleepMs(500);
        }
      }

      if (!fbGroupScanStop) {
        state.totalPostsOffset = (state.totalPostsOffset || 0) + totalPostsScannedInGroup;
        j.groupIndex++;
        await chrome.storage.local.set({ rinFbGroup: state });

        if (j.groupIndex < groupUrls.length) {
          broadcastFbGroupLog(`➡️ Tự động chuyển sang link nhóm tiếp theo [${j.groupIndex + 1}/${groupUrls.length}]: ${groupUrls[j.groupIndex]}`);
          await sleepMs(2500);
        }
      }
    }

    if (j.groupIndex >= groupUrls.length) {
      state.job = null;
      state.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: state });
      broadcastMapsMessage({ type: 'FB_GROUP_STATE_SYNC', postsCount: state.postsCount, commentsCount: state.commentsCount, isScanning: false, job: null });
      broadcastFbGroupLog(`🎉 Hoàn tất quét toàn bộ nhóm! Đã thu thập ${state.rows.length} số điện thoại.`);
      await sendFbGroupZaloNotify('done', 'Quét hoàn tất nhóm Facebook', j, state.rows.length);
    } else {
      state.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: state });
      broadcastMapsMessage({ type: 'FB_GROUP_STATE_SYNC', postsCount: state.postsCount, commentsCount: state.commentsCount, isScanning: false, job: state.job });
      broadcastFbGroupLog('Đã dừng quét nhóm. Tiến trình đã được lưu lại, bạn có thể bấm Tiếp tục bất cứ lúc nào.');
      await sendFbGroupZaloNotify('stop', 'Người dùng đã bấm dừng', j, state.rows.length);
    }
  } catch (err) {
    state.isScanning = false;
    await chrome.storage.local.set({ rinFbGroup: state });
    broadcastMapsMessage({ type: 'FB_GROUP_STATE_SYNC', postsCount: state.postsCount, commentsCount: state.commentsCount, isScanning: false, job: state.job });
    broadcastFbGroupLog('⚠️ Tạm dừng do sự cố: ' + err.message);
    await sendFbGroupZaloNotify(fbGroupScanStop ? 'stop' : 'error', fbGroupScanStop ? 'Người dùng đã bấm dừng' : err.message, state.job, state.rows.length);
  } finally {
    fbGroupScanRunning = false;
    state.isScanning = false;
    await chrome.storage.local.set({ rinFbGroup: state });
    broadcastMapsMessage({ type: 'FB_GROUP_STATE_SYNC', postsCount: state.postsCount, commentsCount: state.commentsCount, isScanning: false, job: state.job });
    try {
      if (!warmupRunning && !mapsScanRunning) chrome.power?.releaseKeepAwake?.();
    } catch (_) {}
  }
}

async function startFbGroupScan(jobParam, phoneTypesParam, seenKeysParam = null) {
  if (fbGroupScanRunning) return { ok: true, running: true, syncVersion: 2, message: 'Tiến trình quét nhóm đang chạy.' };
  runFbGroupScraperLoop(jobParam, phoneTypesParam, seenKeysParam).catch(err => {
    console.error('[FbGroupScraper] Lỗi chạy loop nền:', err);
  });
  return { ok: true, running: true, syncVersion: 2 };
}

async function stopFbGroupScan() {
  if (!fbGroupScanRunning) {
    const { rinFbGroup } = await chrome.storage.local.get('rinFbGroup');
    if (rinFbGroup && rinFbGroup.isScanning) {
      rinFbGroup.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup });
    }
    return { ok: true, stopped: true };
  }
  fbGroupScanStop = true;
  return { ok: true, stopping: true };
}

// ── Facebook Account Warmup Background Loop ──────────────────────────────────
function broadcastWarmupMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
  try {
    if (chrome.tabs?.query) {
      chrome.tabs.query({}, (tabs) => {
        if (Array.isArray(tabs)) {
          for (const t of tabs) {
            if (t && t.id) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
          }
        }
      });
    }
  } catch (_) {}
}

function broadcastWarmupLog(text, icon = 'ℹ️') {
  const time = new Date().toLocaleTimeString('vi-VN');
  broadcastWarmupMessage({ type: 'WARMUP_LOG_EVENT', text, icon, time });
}

async function runWarmupLoop(accountIds, config) {
  if (warmupRunning) return { ok: true, alreadyRunning: true };
  warmupRunning = true;
  warmupStop = false;

  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const targetAccounts = accounts.filter(a => accountIds.includes(a.id) && a.type !== 'fanpage');

  if (!targetAccounts.length) {
    warmupRunning = false;
    await chrome.storage.local.set({ warmupStatus: { running: false, error: 'Không tìm thấy tài khoản phù hợp.' } });
    return;
  }

  const durationMin = parseInt(config?.duration || '3');
  const breakDelaySec = parseInt(config?.breakDelay || '15');
  const enableFeed = config?.feed !== false;
  const enableLike = config?.like !== false;
  const maxLikes = parseInt(config?.maxLikes || '5');
  const enableReels = config?.reels !== false;
  const enableNotif = config?.notif !== false;

  const { warmupConfig: savedWConfig = {} } = await chrome.storage.local.get('warmupConfig');
  const isBg = config?.backgroundMode ?? savedWConfig.backgroundMode ?? true;
  const shouldAutoClose = config?.autoCloseTab ?? savedWConfig.autoCloseTab ?? true;

  const totalDurationMs = durationMin * 60 * 1000;
  let feedDuration = 0;
  let reelsDuration = 0;
  if (enableFeed && enableReels) {
    feedDuration = Math.round(totalDurationMs * 0.65);
    reelsDuration = totalDurationMs - feedDuration;
  } else if (enableFeed) {
    feedDuration = totalDurationMs;
  } else if (enableReels) {
    reelsDuration = totalDurationMs;
  }

  try {
    chrome.power?.requestKeepAwake?.('system');
  } catch (_) {}

  broadcastWarmupLog(`🚀 BẮT ĐẦU ĐỢT NUÔI CHO ${targetAccounts.length} TÀI KHOẢN (CHẠY NGẦM HỆ THỐNG)`, '🔥');

  await chrome.storage.local.set({
    warmupStatus: {
      running: true,
      totalAccounts: targetAccounts.length,
      currentIndex: 0,
      currentAccountId: targetAccounts[0].id,
      currentAccountName: targetAccounts[0].name,
      progressPercent: 0,
      startedAt: Date.now()
    }
  });

  try {
    for (let idx = 0; idx < targetAccounts.length; idx++) {
      if (warmupStop) {
        broadcastWarmupLog('⏹️ Đã dừng tiến trình nuôi theo yêu cầu.', '⏹️');
        break;
      }

      const acc = targetAccounts[idx];
      const accIndex = idx + 1;
      const progressPercent = Math.round(((accIndex - 1) / targetAccounts.length) * 100);

      await chrome.storage.local.set({
        warmupStatus: {
          running: true,
          totalAccounts: targetAccounts.length,
          currentIndex: accIndex,
          currentAccountId: acc.id,
          currentAccountName: acc.name,
          progressPercent,
          startedAt: Date.now()
        }
      });

      broadcastWarmupLog(`--------------------------------------------------`, '➖');
      broadcastWarmupLog(`👉 BẮT ĐẦU TÀI KHOẢN [${accIndex}/${targetAccounts.length}]: ${acc.name}`, '👤');

      if (!acc.cookies) {
        broadcastWarmupLog(`Tài khoản "${acc.name}" chưa có cookies, bỏ qua.`, '⚠️');
        try {
          const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');
          warmupReports.unshift({
            id: 'wm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            accId: acc.id,
            accName: acc.name || 'Tài khoản',
            accUid: acc.fbId || acc.username || acc.id || '',
            actions: 'Bỏ qua (chưa có cookies)',
            duration: '0s',
            status: 'error',
            statusText: 'Chưa có cookies',
            time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            date: new Date().toLocaleDateString('vi-VN'),
            timestamp: Date.now()
          });
          if (warmupReports.length > 200) warmupReports.length = 200;
          await chrome.storage.local.set({ warmupReports });
        } catch (_) {}
        continue;
      }

      try {
        broadcastWarmupLog(`Đang nạp Cookies và mở tab Facebook chạy ngầm...`, '🍪');
        // openFacebookTab = false để không tạo thêm tab thừa và không tự ý đóng tab
        await activateAccountSessionDirectly(acc.id, false, isBg);

        if (warmupCurrentTabId) {
          try {
            await chrome.tabs.get(warmupCurrentTabId);
          } catch {
            warmupCurrentTabId = null;
          }
        }

        if (!warmupCurrentTabId) {
          const fbTab = await chrome.tabs.create({
            url: 'https://www.facebook.com/',
            active: !isBg
          });
          warmupCurrentTabId = fbTab.id;
          await chrome.tabs.update(warmupCurrentTabId, { autoDiscardable: false }).catch(() => {});
        } else {
          await chrome.tabs.update(warmupCurrentTabId, {
            url: 'https://www.facebook.com/',
            autoDiscardable: false,
            ...(isBg ? {} : { active: true })
          }).catch(() => {});
        }

        // Chờ 1 giây để Chrome điều hướng tab sang facebook.com
        await sleepMs(1000);

        // Chờ tab tải xong hoàn toàn trang Facebook (URL phải là facebook.com và status complete)
        const endWait = Date.now() + 20000;
        while (Date.now() < endWait && !warmupStop) {
          const tInfo = await chrome.tabs.get(warmupCurrentTabId).catch(() => null);
          if (tInfo && tInfo.status === 'complete' && tInfo.url && (tInfo.url.includes('facebook.com') || tInfo.url.includes('fb.com'))) {
            break;
          }
          await sleepMs(500);
        }
        if (warmupStop) break;
        await sleepMs(2000);

        broadcastWarmupLog(`Đang nạp kịch bản mô phỏng tương tác người thật...`, '🤖');
        await chrome.scripting.executeScript({
          target: { tabId: warmupCurrentTabId },
          files: ['warmup_content.js']
        }).catch(err => {
          console.warn('Lỗi inject warmup_content:', err);
          broadcastWarmupLog(`⚠️ Cảnh báo nạp kịch bản tương tác: ${err.message}`, '⚠️');
        });

        await sleepMs(1200);

        const sessionConfig = {
          feedDuration: enableFeed ? feedDuration : 0,
          reelsDuration: enableReels ? reelsDuration : 0,
          enableLike,
          maxLikes,
          enableReels,
          enableNotif
        };

        // Gửi lệnh khởi động chu trình tương tác và nhận phản hồi đồng bộ tức thì
        const startResult = await chrome.tabs.sendMessage(warmupCurrentTabId, {
          type: 'START_WARMUP_SESSION',
          config: sessionConfig
        }).catch(err => ({ ok: false, error: err.message }));

        let sessionError = null;

        if (startResult && startResult.ok) {
          broadcastWarmupLog(`Đang trong tiến trình tương tác tự động (${durationMin} phút)...`, '⏳');
          const waitStartTime = Date.now();
          const targetDurationMs = totalDurationMs;

          // Vòng lặp đếm ngược chính xác theo đúng thời lượng durationMin (e.g. 3 phút)
          while (Date.now() - waitStartTime < targetDurationMs && !warmupStop) {
            await sleepMs(1000);
            if (warmupStop) break;

            const tInfo = await chrome.tabs.get(warmupCurrentTabId).catch(() => null);
            if (!tInfo) {
              sessionError = 'Tab Facebook đã bị đóng trước khi hoàn tất';
              break;
            }

            const elapsed = Date.now() - waitStartTime;
            const remainingSec = Math.max(0, Math.ceil((targetDurationMs - elapsed) / 1000));
            const statusUpdate = {
              running: true,
              totalAccounts: targetAccounts.length,
              currentIndex: accIndex,
              currentAccountId: acc.id,
              currentAccountName: acc.name,
              progressPercent,
              remainingSec: remainingSec,
              durationMin: durationMin,
              startedAt: waitStartTime
            };
            await chrome.storage.local.set({ warmupStatus: statusUpdate }).catch(() => {});
            broadcastWarmupMessage({ type: 'WARMUP_STATUS_EVENT', status: statusUpdate });
          }

          // Phiên tương tác đã hoàn thành đủ thời lượng: Gửi lệnh dừng tương tác
          if (!sessionError && !warmupStop && warmupCurrentTabId) {
            chrome.tabs.sendMessage(warmupCurrentTabId, { type: 'STOP_WARMUP_SESSION' }).catch(() => {});
          }
        } else {
          sessionError = startResult?.error || 'Không thể kết nối kịch bản tương tác Facebook';
        }

        if (warmupStop) break;

        // Lưu bản ghi báo cáo chi tiết các hành động và số lượng / thời gian
        const actionsList = [];
        const approxFeedSec = Math.round(durationMin * 60 * (enableReels ? 0.5 : 1));
        const approxReelsSec = enableReels ? Math.round(durationMin * 60 * 0.5) : 0;

        if (enableFeed) {
          actionsList.push(`<div class="report-action-line">• 📰 Lướt Bảng tin (${approxFeedSec}s)</div>`);
        }
        if (enableLike) {
          actionsList.push(`<div class="report-action-line">• ❤️ Thả cảm xúc Like/Tim (tối đa <b>${maxLikes} bài</b>)</div>`);
        }
        if (enableReels) {
          actionsList.push(`<div class="report-action-line">• 🎬 Xem Video Reels (${approxReelsSec}s)</div>`);
        }
        if (enableNotif) {
          actionsList.push(`<div class="report-action-line">• 🔔 Kiểm tra Thông báo (~15s)</div>`);
        }

        const actionsHtml = actionsList.length > 0 ? actionsList.join('') : 'Tương tác mô phỏng người thật';

        const isSuccess = !sessionError;
        const statusText = isSuccess ? 'Thành công' : sessionError;
        const reportItem = {
          id: 'wm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          accId: acc.id,
          accName: acc.name || 'Tài khoản',
          accUid: acc.fbId || acc.username || acc.id || '',
          actions: actionsHtml,
          duration: `${durationMin} phút`,
          status: isSuccess ? 'success' : 'error',
          statusText: statusText,
          time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          date: new Date().toLocaleDateString('vi-VN'),
          timestamp: Date.now()
        };

        try {
          const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');
          warmupReports.unshift(reportItem);
          if (warmupReports.length > 200) warmupReports.length = 200;
          await chrome.storage.local.set({ warmupReports });
        } catch (_) {}

        // Phát sóng báo cáo chi tiết cho Web UI
        broadcastWarmupMessage({
          type: 'WARMUP_SESSION_REPORT',
          report: reportItem
        });

        if (isSuccess) {
          broadcastWarmupLog(`Đã hoàn tất nuôi cho tài khoản "${acc.name}".`, '✅');
          const { accounts: curAccs = [] } = await chrome.storage.local.get('accounts');
          const a = curAccs.find(x => x.id === acc.id);
          if (a) {
            a.lastWarmupAt = Date.now();
            await chrome.storage.local.set({ accounts: curAccs });
          }
        } else {
          broadcastWarmupLog(`Tài khoản "${acc.name}" kết thúc: ${statusText}`, '⚠️');
        }

        if (idx < targetAccounts.length - 1 && !warmupStop) {
          broadcastWarmupLog(`☕ Nghỉ an toàn ${breakDelaySec} giây trước khi chuyển tài khoản tiếp theo...`, '☕');
          for (let s = breakDelaySec; s > 0 && !warmupStop; s--) {
            await chrome.storage.local.set({
              warmupStatus: {
                running: true,
                totalAccounts: targetAccounts.length,
                currentIndex: accIndex,
                currentAccountId: acc.id,
                currentAccountName: acc.name,
                progressPercent: Math.round((accIndex / targetAccounts.length) * 100),
                statusText: `☕ Nghỉ an toàn (${s}s)...`,
                remainingSec: s
              }
            }).catch(() => {});
            await sleepMs(1000);
          }
        }
      } catch (err) {
        broadcastWarmupLog(`Lỗi xử lý tài khoản "${acc.name}": ${err.message}`, '❌');
        try {
          const { warmupReports = [] } = await chrome.storage.local.get('warmupReports');
          warmupReports.unshift({
            id: 'wm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            accId: acc.id,
            accName: acc.name || 'Tài khoản',
            accUid: acc.fbId || acc.username || acc.id || '',
            actions: 'Lỗi tiến trình',
            duration: '0s',
            status: 'error',
            statusText: err.message,
            time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            date: new Date().toLocaleDateString('vi-VN'),
            timestamp: Date.now()
          });
          if (warmupReports.length > 200) warmupReports.length = 200;
          await chrome.storage.local.set({ warmupReports });
        } catch (_) {}
        await sleepMs(2000);
      }
    }
  } finally {
    warmupRunning = false;
    await chrome.storage.local.set({
      warmupStatus: {
        running: false,
        endedAt: Date.now()
      }
    });

    if (shouldAutoClose && warmupCurrentTabId) {
      try {
        await chrome.tabs.remove(warmupCurrentTabId);
      } catch (_) {}
      warmupCurrentTabId = null;
    }

    try {
      if (!mapsScanRunning) chrome.power?.releaseKeepAwake?.();
    } catch (_) {}

    broadcastWarmupLog(`🏆 ĐÃ HOÀN TẤT ĐỢT NUÔI TÀI KHOẢN TỰ ĐỘNG!`, '🎉');
  }
}

// ── Facebook Group Discovery & Search Runner (groups.html runner) ───────────
let groupSearchRunning = false;
let groupSearchStop = false;
let groupSearchCurrentTabId = null;

function broadcastGroupSearchMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('ntd_agency_web_bus');
      bc.postMessage({ message: msg });
      bc.close();
    }
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
      window.postMessage({
        source: 'ntd_extension_bridge',
        action: 'WORKER_EVENT',
        payload: msg
      }, '*');
    }
  } catch (_) {}
  try {
    if (chrome.tabs?.query) {
      chrome.tabs.query({}, (tabs) => {
        if (Array.isArray(tabs)) {
          for (const t of tabs) {
            if (t && t.id) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
          }
        }
      });
    }
  } catch (_) {}
}

async function waitForGroupSearchTab(tabId, expectedUrl = '', timeoutMs = 15000) {
  // Chờ 400ms để Chrome bắt đầu điều hướng URL mới (tránh đọc nhầm status='complete' của trang cũ)
  await new Promise(r => setTimeout(r, 400));
  let expectedPathHint = '';
  if (expectedUrl) {
    const gm = expectedUrl.match(/\/groups\/([^/?#]+)/i);
    if (gm) expectedPathHint = `/groups/${gm[1].toLowerCase()}`;
    else if (expectedUrl.includes('/search/groups')) expectedPathHint = '/search/groups';
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (groupSearchStop) return false;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    const curUrl = (t.url || '').toLowerCase();
    const urlMatches = !expectedPathHint || curUrl.includes(expectedPathHint) || curUrl.includes('/login') || curUrl.includes('checkpoint');
    if (t.status === 'complete' && !t.pendingUrl && urlMatches) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return true;
}

// Hàm trích xuất danh sách nhóm Facebook từ trang kết quả tìm kiếm (chạy trong context Facebook tab)
function inPageExtractGroupsFromSearch() {
  const RESERVED = new Set([
    'feed', 'discover', 'joins', 'joined', 'create', 'search', 'category',
    'categories', 'notifications', 'requests', 'invitations', 'invites',
    'your_posts', 'pending_posts', 'settings', 'insights', 'groups', 'browse'
  ]);
  const REJECT_TEXT = /^(?:tham gia(?:\s+nhóm)?|join(?:\s+group)?|đã tham gia|joined|xem nhóm|view group|mở|open|đang chờ|pending|hủy yêu cầu)$/i;
  const META_LINE = /^(?:công khai|riêng tư|không công khai|nhóm công khai|nhóm riêng tư|public(?:\s+group)?|private(?:\s+group)?|\d[\d.,]*\s*(?:k|m|tr|triệu|nghìn|ngàn)?\+?\s*(?:thành viên|members?)|[\d+]+\s*bài viết|\d+\s*người bạn.*)$/i;

  function normUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, window.location.origin);
      if (!['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(u.hostname)) return null;
      const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/i);
      if (!m) return null;
      const slug = m[1].toLowerCase();
      if (!slug || slug.length < 2 || RESERVED.has(slug)) return null;
      return `https://www.facebook.com/groups/${slug}/`;
    } catch (_) {
      return null;
    }
  }

  function parseMemberCount(str) {
    if (!str) return 0;
    const clean = String(str).toLowerCase().trim();
    const m = clean.match(/([\d.,]+)\s*(triệu|trieu|nghìn|nghin|ngàn|ngan|tỷ|ty|tr|[km])?\s*\+?(?![a-z\u00C0-\u024F\u1EA0-\u1EF9])/i);
    if (!m) return 0;
    let numPart = m[1].trim();
    const unit = (m[2] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
    if (unit) {
      numPart = numPart.replace(',', '.');
      const val = parseFloat(numPart);
      if (isNaN(val)) return 0;
      if (unit === 'k' || unit === 'nghin' || unit === 'ngan') return Math.round(val * 1000);
      if (unit === 'm' || unit === 'trieu' || unit === 'tr') return Math.round(val * 1000000);
      if (unit === 'ty') return Math.round(val * 1000000000);
      return Math.round(val);
    }
    if (/^\d{1,3}([.,]\d{3})+$/.test(numPart)) {
      return parseInt(numPart.replace(/[.,]/g, ''), 10) || 0;
    }
    const val = parseFloat(numPart.replace(',', '.'));
    return isNaN(val) ? 0 : Math.round(val);
  }

  function distinctUrlsIn(el) {
    const s = new Set();
    if (!el) return s;
    const links = el.querySelectorAll('a[href*="/groups/"]');
    for (let i = 0; i < links.length; i++) {
      const u = normUrl(links[i].getAttribute('href') || links[i].href);
      if (u) {
        s.add(u);
        if (s.size > 1) return s;
      }
    }
    return s;
  }

  const anchorsByUrl = new Map();
  const anchors = document.querySelectorAll('a[href*="/groups/"]');
  for (const a of anchors) {
    const cleanUrl = normUrl(a.getAttribute('href') || a.href);
    if (!cleanUrl) continue;
    if (!anchorsByUrl.has(cleanUrl)) anchorsByUrl.set(cleanUrl, []);
    anchorsByUrl.get(cleanUrl).push(a);
  }

  const items = [];
  for (const [cleanUrl, anchorList] of anchorsByUrl.entries()) {
    const titleAnchor = anchorList.find(a => {
      const t = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length >= 2 && !REJECT_TEXT.test(t) && !META_LINE.test(t);
    }) || anchorList[0];

    let container = titleAnchor;
    let curr = titleAnchor.parentElement;
    let steps = 0;
    while (curr && curr !== document.body && steps < 10) {
      if (distinctUrlsIn(curr).size > 1) break;
      const txtLen = (curr.innerText || '').length;
      if (txtLen > 1200) break;
      container = curr;
      curr = curr.parentElement;
      steps++;
    }

    const cardText = (container?.innerText || titleAnchor.parentElement?.innerText || '').trim();

    let name = '';
    for (const a of anchorList) {
      const t = (a.innerText || a.textContent || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2 && !REJECT_TEXT.test(t) && !META_LINE.test(t) && !/^\d+$/.test(t)) {
        name = t;
        break;
      }
    }
    if (!name && container) {
      const heading = container.querySelector('h2, h3, h4, [role="heading"], strong, span[dir="auto"]');
      const hTxt = (heading?.innerText || '').split(/\r?\n/)[0].trim();
      if (hTxt && hTxt.length >= 2 && !REJECT_TEXT.test(hTxt) && !META_LINE.test(hTxt)) {
        name = hTxt;
      }
    }
    if (!name) {
      const m = cleanUrl.match(/\/groups\/([^\/]+)\//);
      name = m ? m[1] : 'Nhóm Facebook';
    }

    let metaText = cardText;
    if (name.length >= 2) {
      metaText = metaText.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    }
    metaText = metaText.replace(/\b\d[\d.,]*\s*(?:người\s*bạn|bạn\s*chung|friends?)(?:\s+(?:là\s+thành\s+viên|(?:is|are)\s+(?:a\s+)?members?))?/gi, ' ');

    let privacy = 'Chưa rõ';
    const folded = metaText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
    if (/(?:^|[\s·•\-|(\[])(?:nhom\s+)?(?:rieng\s+tu|khong\s+cong\s+khai|nhom\s+kin|private(?:\s+group)?)(?=$|[\s\d·•\-|)\],.:])/.test(folded)) {
      privacy = 'Riêng tư';
    } else if (!/\bkhong\s+cong\s+khai\b/.test(folded) && /(?:^|[\s·•\-|(\[])(?:nhom\s+)?(?:cong\s+khai|public(?:\s+group)?)(?=$|[\s\d·•\-|)\],.:])/.test(folded)) {
      privacy = 'Công khai';
    }

    let members = '';
    const memMatch = metaText.match(/([\d.,]+\s*(?:triệu|nghìn|ngàn|tỷ|tr|[km])?\+?)\s*(?:tổng\s*)?(?:thành\s*viên|members?|người\s*theo\s*dõi|followers?)(?![a-z\u00C0-\u024F\u1EA0-\u1EF9])/i);
    if (memMatch) {
      members = memMatch[1].replace(/\s+/g, ' ').trim() + ' thành viên';
    } else {
      const subMatch = metaText.match(/[·•]\s*([^·•\n]*(?:thành viên|members?)[^·•\n]*)/i);
      if (subMatch) members = subMatch[1].trim();
    }

    items.push({
      name: name.slice(0, 120),
      url: cleanUrl,
      privacy,
      members: members || 'Đang cập nhật',
      memberCount: parseMemberCount(members)
    });
  }

  return items;
}

function inPageScrollSearch() {
  try {
    const scrollDistance = 3500;
    window.scrollBy({ top: scrollDistance, behavior: 'auto' });
    if (document.documentElement) document.documentElement.scrollTop += scrollDistance;
    if (document.body) document.body.scrollTop += scrollDistance;

    window.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));

    const scrollables = document.querySelectorAll('div[data-virtualized], div[role="feed"], div[tabindex="-1"], div[role="main"]');
    for (const el of scrollables) {
      if (el.scrollHeight > el.clientHeight) {
        el.scrollTop += scrollDistance;
        el.dispatchEvent(new Event('scroll'));
      }
    }

    if (typeof window.__ntdTriggerSentinels === 'function') {
      window.__ntdTriggerSentinels();
    }
  } catch (_) {}
}

async function inPageCheckApproval() {
  function norm(s) {
    return (s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
  }

  // Trích xuất tên thật của nhóm trên trang nhóm
  let groupName = '';
  const h1 = document.querySelector('[role="main"] h1, h1');
  if (h1 && h1.innerText && h1.innerText.trim().length > 1) {
    groupName = h1.innerText.trim().replace(/\s+/g, ' ').slice(0, 120);
  }
  if (!groupName) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) groupName = (ogTitle.getAttribute('content') || '').trim().slice(0, 120);
  }
  if (!groupName) {
    groupName = (document.title || '').replace(/\s*[|\-–]\s*Facebook.*$/i, '').trim().slice(0, 120);
  }

  const rawBodyText = document.body ? document.body.innerText : '';
  const pageText = norm(rawBodyText);
  const headerSlice = norm(rawBodyText.slice(0, 1800));

  const isPrivateHeader = /(?:^|\n)\s*(?:nhom rieng tu|private group|nhom bi mat|secret group)\b/m.test(headerSlice) ||
                          /chi thanh vien moi nhin thay|only members can see who's in the group/i.test(headerSlice);
  const isPublicHeader = /(?:^|\n)\s*(?:nhom cong khai|public group)\b/m.test(headerSlice) ||
                         /bat ky ai cung co the nhin thay moi nguoi trong nhom|anyone can see who's in the group/i.test(headerSlice);
  const privacy = isPrivateHeader ? 'Riêng tư' : (isPublicHeader ? 'Công khai' : null);

  const buttonsAndLinks = [...document.querySelectorAll('[role="button"], button, a')];
  const isMember = buttonsAndLinks.some(el => {
    const t = norm(el.innerText || el.getAttribute('aria-label') || '');
    return t === 'da tham gia' || t === 'joined' || t.includes('roi khoi nhom') || t.includes('leave group');
  });
  const hasJoinBtn = buttonsAndLinks.some(el => {
    const t = norm(el.innerText || el.getAttribute('aria-label') || '');
    return t === 'tham gia nhom' || t === 'tham gia' || t === 'join group' || t === 'join';
  });

  if (isPrivateHeader && !isMember) {
    return {
      status: 'private',
      badge: '🔒 Riêng tư',
      label: 'Nhóm riêng tư (Cần tham gia)',
      canPost: false,
      requiresApproval: true,
      groupName,
      privacy: 'Riêng tư'
    };
  }

  if (/chi quan tri vien moi co the dang|only admins can post|posting is disabled|tinh nang dang bai bi tat/i.test(headerSlice)) {
    return {
      status: 'admin_only',
      badge: 'Chỉ Admin',
      label: 'Chỉ quản trị viên mới được đăng',
      canPost: false,
      requiresApproval: true,
      groupName,
      privacy: privacy || 'Công khai'
    };
  }

  const approvalRegex = /kiem duyet|phe duyet|cho duyet|quan tri vien.*?(?:duyet|phe duyet)|gui de phe duyet|bai viet.*?(?:phai|can).*?(?:duyet|phe duyet)|admin approval|pending approval|require.*approval|needs? approval|must be approved|submit.*for approval/i;

  const composerTrigger = buttonsAndLinks.find(el => {
    const t = norm(el.textContent);
    return t.includes('ban viet gi di') ||
           t.includes('tao bai viet cong khai') ||
           t.includes('tao bai viet') ||
           t.includes('viet gi do') ||
           t.includes('write something') ||
           t.includes('create a public post');
  });

  if (composerTrigger) {
    const area = composerTrigger.closest('[role="region"], [role="main"], div[data-pagelet]') || composerTrigger.parentElement?.parentElement;
    const areaText = area ? norm(area.innerText || '') : '';

    if (approvalRegex.test(areaText)) {
      return {
        status: 'approval',
        badge: 'Cần kiểm duyệt',
        label: 'Bài viết cần Quản trị viên duyệt',
        canPost: true,
        requiresApproval: true,
        groupName,
        privacy: privacy || 'Công khai'
      };
    }

    try { composerTrigger.click(); } catch (_) {}

    // Đợi hộp thoại tạo bài viết mở ra (tối đa 1200ms) để đọc chính xác thông báo phê duyệt
    let dialog = null;
    for (let w = 0; w < 8; w++) {
      dialog = document.querySelector('[role="dialog"]');
      if (dialog && (dialog.innerText || '').trim().length > 10) break;
      await new Promise(r => setTimeout(r, 150));
    }

    if (dialog) {
      const dialogText = norm(dialog.innerText || '');
      const hasApprovalInDialog = approvalRegex.test(dialogText);

      const dButtons = [...dialog.querySelectorAll('[role="button"], button')];
      const isSubmitApproval = dButtons.some(b => /gui de phe duyet|submit for approval|cho duyet|gui bai viet.*duyet/i.test(norm(b.textContent)));

      const closeBtn = dialog.querySelector('[aria-label="Đóng"], [aria-label="Close"], [aria-label*="Dong"]') ||
                       dialog.querySelector('[role="button"][tabindex="0"]');
      if (closeBtn) {
        try { closeBtn.click(); } catch (_) {}
      } else {
        try { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
      }

      if (hasApprovalInDialog || isSubmitApproval) {
        return {
          status: 'approval',
          badge: 'Cần kiểm duyệt',
          label: 'Bài viết cần Quản trị viên duyệt',
          canPost: true,
          requiresApproval: true,
          groupName,
          privacy: privacy || 'Công khai'
        };
      }

      return {
        status: 'free',
        badge: 'Đăng tự do',
        label: 'Không kiểm duyệt (Đăng tự do)',
        canPost: true,
        requiresApproval: false,
        groupName,
        privacy: privacy || 'Công khai'
      };
    }

    return {
      status: 'free',
      badge: 'Đăng tự do',
      label: 'Có khung đăng bài (Không phát hiện yêu cầu kiểm duyệt)',
      canPost: true,
      requiresApproval: false,
      groupName,
      privacy: privacy || 'Công khai'
    };
  }

  if (approvalRegex.test(headerSlice)) {
    return {
      status: 'approval',
      badge: 'Cần kiểm duyệt',
      label: 'Có dấu hiệu kiểm duyệt bài viết',
      canPost: true,
      requiresApproval: true,
      groupName,
      privacy: privacy || 'Công khai'
    };
  }

  if (hasJoinBtn && !isMember) {
    return {
      status: 'uninspected',
      badge: '👥 Cần tham gia nhóm',
      label: 'Nhóm Công khai yêu cầu Tham gia trước khi mở khung đăng bài',
      canPost: false,
      requiresApproval: null,
      groupName,
      privacy: privacy || 'Công khai'
    };
  }

  return {
    status: isPrivateHeader ? 'private' : 'free',
    badge: isPrivateHeader ? '🔒 Riêng tư' : 'Đăng tự do',
    label: isPrivateHeader ? 'Nhóm riêng tư' : 'Không kiểm duyệt (Đăng tự do)',
    canPost: !isPrivateHeader,
    requiresApproval: isPrivateHeader ? true : false,
    groupName,
    privacy: privacy || (isPrivateHeader ? 'Riêng tư' : 'Công khai')
  };
}

async function runGroupSearchLoop(params) {
  if (groupSearchRunning) return { ok: true, alreadyRunning: true };
  groupSearchRunning = true;
  groupSearchStop = false;

  const keywords = Array.isArray(params?.keywords) ? params.keywords.filter(Boolean) : [];
  if (!keywords.length) {
    groupSearchRunning = false;
    return { ok: false, error: 'Chưa có từ khóa tìm kiếm.' };
  }

  const maxCountPerKeyword = Math.max(1, Math.min(500, parseInt(params.maxCountPerKeyword || '30', 10)));
  const filterMode = params.filterMode || 'free_only';
  const minMembers = parseInt(params.minMembers || '10000', 10);
  const privacyMode = params.privacyMode || 'public_only';
  const checkApproval = filterMode !== 'all';

  const historyKeys = new Set(Array.isArray(params.historyKeys) ? params.historyKeys : []);
  const categoryKeys = new Set(Array.isArray(params.categoryKeys) ? params.categoryKeys : []);

  const totalKw = keywords.length;
  const discoveredGroups = [];
  const discoveredGroupKeys = new Set();
  const sessionScannedUrls = new Set();

  try {
    chrome.power?.requestKeepAwake?.('system');
  } catch (_) {}

  broadcastGroupSearchMessage({
    type: 'GROUP_SEARCH_PROGRESS',
    percent: 5,
    title: `Bắt đầu quét ${totalKw} từ khóa...`,
    detail: `Danh sách: ${keywords.slice(0, 3).map(k => `"${k}"`).join(', ')}`,
    count: 0
  });

  try {
    for (let kwIdx = 0; kwIdx < totalKw; kwIdx++) {
      if (groupSearchStop) break;
      const currentKw = keywords[kwIdx];
      const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(currentKw)}`;

      const basePct = (kwIdx / totalKw) * (checkApproval ? 40 : 90);
      broadcastGroupSearchMessage({
        type: 'GROUP_SEARCH_PROGRESS',
        percent: Math.round(basePct),
        title: `[Từ khóa ${kwIdx + 1}/${totalKw}] "${currentKw}"`,
        detail: `Đang mở kết quả tìm kiếm Facebook cho từ khóa "${currentKw}"...`,
        count: discoveredGroups.length
      });

      if (groupSearchCurrentTabId) {
        try {
          await chrome.tabs.get(groupSearchCurrentTabId);
          await chrome.tabs.update(groupSearchCurrentTabId, { url: searchUrl, autoDiscardable: false });
        } catch (_) {
          groupSearchCurrentTabId = null;
        }
      }
      if (!groupSearchCurrentTabId) {
        const tab = await chrome.tabs.create({ url: searchUrl, active: false });
        groupSearchCurrentTabId = tab.id;
        await chrome.tabs.update(groupSearchCurrentTabId, { autoDiscardable: false }).catch(() => {});
      }

      await waitForGroupSearchTab(groupSearchCurrentTabId, searchUrl, 15000);
      if (groupSearchStop) break;

      // Nạp fb_scroll_hook.js trong MAIN world
      await chrome.scripting.executeScript({
        target: { tabId: groupSearchCurrentTabId },
        world: 'MAIN',
        files: ['fb_scroll_hook.js']
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 1800));
      if (groupSearchStop) break;

      let stagnantCount = 0;
      let round = 0;
      let countForThisKw = 0;
      const processedDomUrls = new Set();

      while (!groupSearchStop && countForThisKw < maxCountPerKeyword && stagnantCount < 25) {
        round++;

        const res = await chrome.scripting.executeScript({
          target: { tabId: groupSearchCurrentTabId },
          func: inPageExtractGroupsFromSearch
        }).catch(() => null);

        const items = res?.[0]?.result || [];
        let newCount = 0;

        for (const item of items) {
          if (processedDomUrls.has(item.url)) continue;
          processedDomUrls.add(item.url);

          // 1. Lọc theo Chế độ nhóm (Quyền riêng tư: Công khai vs Riêng tư)
          if (privacyMode === 'public_only' && item.privacy !== 'Công khai') continue;
          if (privacyMode === 'private_only' && item.privacy !== 'Riêng tư') continue;

          // 2. Lọc theo Số lượng thành viên tối thiểu
          if (minMembers > 0 && item.memberCount < minMembers) continue;

          // 3. Lọc trùng URL và group key
          const keyMatch = item.url.match(/\/groups\/([^\/]+)/);
          const key = keyMatch ? keyMatch[1].toLowerCase() : item.url;
          if (sessionScannedUrls.has(item.url) || discoveredGroupKeys.has(key)) continue;
          if (historyKeys.has(key) || categoryKeys.has(key)) continue;

          sessionScannedUrls.add(item.url);
          discoveredGroupKeys.add(key);

          const groupObj = {
            id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: item.name,
            url: item.url,
            privacy: item.privacy,
            members: item.members,
            memberCount: item.memberCount,
            keyword: currentKw,
            approvalStatus: checkApproval ? 'loading' : 'uninspected',
            approvalLabel: checkApproval ? 'Đang chờ kiểm tra...' : 'Chưa kiểm tra',
            approvalBadge: checkApproval ? '⏳ Đang chờ' : '⚪ Chưa kiểm tra',
            selected: true
          };

          discoveredGroups.push(groupObj);
          newCount++;
          countForThisKw++;

          // Phát sóng ngay nhóm mới tìm thấy cho Web UI
          broadcastGroupSearchMessage({
            type: 'GROUP_SEARCH_ITEM',
            group: groupObj
          });

          if (countForThisKw >= maxCountPerKeyword) break;
        }

        if (newCount === 0) {
          stagnantCount++;
        } else {
          stagnantCount = 0;
        }

        const kwProgressSlice = (Math.min(countForThisKw, maxCountPerKeyword) / maxCountPerKeyword) * ((checkApproval ? 40 : 90) / totalKw);
        const currentPct = Math.round(basePct + kwProgressSlice);

        broadcastGroupSearchMessage({
          type: 'GROUP_SEARCH_PROGRESS',
          percent: currentPct,
          title: `[Từ khóa ${kwIdx + 1}/${totalKw}: "${currentKw}"] Thu thập ${countForThisKw}/${maxCountPerKeyword} nhóm...`,
          detail: `Tổng nhóm duy nhất đã gom: ${discoveredGroups.length} nhóm (Cuộn vòng ${round} - Mới: +${newCount})`,
          count: discoveredGroups.length
        });

        if (countForThisKw >= maxCountPerKeyword) break;

        // Cuộn tab Facebook
        await chrome.scripting.executeScript({
          target: { tabId: groupSearchCurrentTabId },
          func: inPageScrollSearch
        }).catch(() => null);

        await new Promise(r => setTimeout(r, newCount === 0 ? 2000 : 1200));
      }

      if (groupSearchStop) break;
      if (kwIdx < totalKw - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    // ── GIAI ĐOẠN 2: KIỂM ĐỊNH DUYỆT BÀI TỪNG NHÓM (NẾU BẬT) ───────────────
    if (checkApproval && !groupSearchStop && discoveredGroups.length > 0) {
      const groupsToCheck = discoveredGroups.filter(g =>
        !['free', 'approval', 'private', 'admin_only'].includes(g.approvalStatus)
      );
      const totalToCheck = groupsToCheck.length;

      for (let i = 0; i < totalToCheck; i++) {
        if (groupSearchStop) break;
        const grp = groupsToCheck[i];

        grp.approvalStatus = 'loading';
        grp.approvalLabel = 'Đang kiểm tra...';
        grp.approvalBadge = '⏳ Đang kiểm tra';

        broadcastGroupSearchMessage({
          type: 'GROUP_SEARCH_STATUS_UPDATE',
          url: grp.url,
          approvalStatus: 'loading',
          approvalLabel: 'Đang kiểm tra...',
          approvalBadge: '⏳ Đang kiểm tra'
        });

        const pct = Math.round(40 + ((i + 1) / totalToCheck) * 55);
        broadcastGroupSearchMessage({
          type: 'GROUP_SEARCH_PROGRESS',
          percent: pct,
          title: `Kiểm tra duyệt bài (${i + 1}/${totalToCheck})...`,
          detail: `Đang kiểm tra: "${grp.name.slice(0, 35)}..."`,
          count: `${i + 1}/${totalToCheck}`
        });

        try {
          await chrome.tabs.update(groupSearchCurrentTabId, { url: grp.url, autoDiscardable: false });
          await waitForGroupSearchTab(groupSearchCurrentTabId, grp.url, 12000);
          if (groupSearchStop) break;

          await new Promise(r => setTimeout(r, 1800));
          if (groupSearchStop) break;

          const res = await chrome.scripting.executeScript({
            target: { tabId: groupSearchCurrentTabId },
            func: inPageCheckApproval
          }).catch(() => null);

          const r = res?.[0]?.result;
          if (r) {
            grp.approvalStatus = r.status;
            grp.approvalLabel = r.label;
            grp.approvalBadge = r.badge;
            if (r.groupName && !/^\d+$/.test(r.groupName.trim())) {
              grp.name = r.groupName;
            }
            if (r.privacy) {
              grp.privacy = r.privacy;
            }
          } else {
            grp.approvalStatus = 'uninspected';
            grp.approvalLabel = 'Chưa kiểm tra';
            grp.approvalBadge = '⚪ Chưa kiểm tra';
          }

          broadcastGroupSearchMessage({
            type: 'GROUP_SEARCH_STATUS_UPDATE',
            url: grp.url,
            name: grp.name,
            privacy: grp.privacy,
            approvalStatus: grp.approvalStatus,
            approvalLabel: grp.approvalLabel,
            approvalBadge: grp.approvalBadge
          });
        } catch (_) {}

        await new Promise(r => setTimeout(r, 600));
      }
    }
  } catch (err) {
    console.error('[GroupSearch] Lỗi quét nhóm:', err);
  } finally {
    groupSearchRunning = false;
    try {
      if (!mapsScanRunning && !warmupRunning) chrome.power?.releaseKeepAwake?.();
    } catch (_) {}

    broadcastGroupSearchMessage({
      type: 'GROUP_SEARCH_PROGRESS',
      percent: 100,
      title: groupSearchStop ? 'Đã dừng quét' : 'Hoàn tất quét nhóm',
      detail: `Đã thu thập tổng cộng ${discoveredGroups.length} nhóm Facebook phù hợp.`,
      count: discoveredGroups.length
    });

    broadcastGroupSearchMessage({
      type: 'GROUP_SEARCH_DONE',
      totalFound: discoveredGroups.length
    });
  }
}

function stopGroupSearchScan() {
  groupSearchStop = true;
  groupSearchRunning = false;
  if (groupSearchCurrentTabId) {
    try { chrome.tabs.remove(groupSearchCurrentTabId); } catch (_) {}
    groupSearchCurrentTabId = null;
  }
  broadcastGroupSearchMessage({
    type: 'GROUP_SEARCH_DONE',
    stopped: true
  });
  return { ok: true, stopped: true };
}

try {
  chrome.alarms.create('rinRetry', { periodInMinutes: 1 });
} catch (_) {}

// ── Global alarm: tick all running campaigns ──────────────────────────────────
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'auto_cookie_sync') {
    autoSyncFacebookCookies().catch(() => {});
    checkCurrentLicense(true).catch(() => {});
    return;
  }

  if (a.name === 'rinRetry') {
    lockedMaps(flushMapsQueue);
    return;
  }

  if (a.name.startsWith('tick_')) {
    const accountId = a.name.replace('tick_', '');
    locked(accountId, () => tick(accountId));
    return;
  }

  if (a.name === 'queue') {
    const campaigns = await readCampaigns();
    const now = Date.now();
    let hasRunning = false;
    let anyRunningOrWaiting = false;
    const waitingCandidates = [];

    for (const [accountId, c] of Object.entries(campaigns)) {
      if (c.state === 'running') {
        hasRunning = true;
        anyRunningOrWaiting = true;
        if (!c.active && c.nextAt && c.nextAt <= now) {
          locked(accountId, () => tick(accountId));
        } else if (!c.active && c.nextAt && c.nextAt > now) {
          try { chrome.alarms.create('tick_' + accountId, { when: c.nextAt }); } catch (_) {}
        }
      } else if (c.state === 'waiting') {
        anyRunningOrWaiting = true;
        if (c.index < c.jobs.length) {
          waitingCandidates.push(accountId);
        }
      }
    }

    // Safety net: Nếu không có tài khoản nào đang chạy (do crash hoặc lỗi trước đó), nhưng còn tài khoản đang chờ
    // -> Tự động đánh thức tài khoản đang chờ tiếp theo
    if (!hasRunning && waitingCandidates.length > 0) {
      const coord = await readCoordinator();
      let targetToWake = waitingCandidates[0];
      if (coord && coord.order) {
        const orderCand = coord.order.find(id => waitingCandidates.includes(id));
        if (orderCand) targetToWake = orderCand;
      }
      const campToWake = campaigns[targetToWake];
      if (campToWake) {
        campToWake.state = 'running';
        campToWake.nextAt = Date.now() + 1000;
        campToWake.breakNote = 'Đang tiếp tục đến lượt đăng...';
        if (coord) {
          if (coord.mode === 'round_robin') coord.currentTurn = Math.max(0, coord.order.indexOf(targetToWake));
          if (coord.mode === 'sequential') coord.currentIndex = Math.max(0, coord.order.indexOf(targetToWake));
          await saveCoordinator(coord);
        }
        await saveCampaigns(campaigns);
        await scheduleAccountTick(targetToWake, campToWake.nextAt);
        hasRunning = true;
      }
    }

    updateKeepAwake(anyRunningOrWaiting);
    if (!anyRunningOrWaiting) {
      await maybeStopGlobalAlarm();
    }
  }
});

async function maybeStopGlobalAlarm() {
  const campaigns = await readCampaigns();
  const anyActive = Object.values(campaigns).some(c => c.state === 'running' || c.state === 'waiting');
  if (!anyActive) {
    try { await chrome.alarms.clear('queue'); } catch (_) {}
    const allAlarms = (await chrome.alarms.getAll?.().catch(() => [])) || [];
    for (const al of allAlarms) {
      if (al.name?.startsWith('tick_')) {
        try { await chrome.alarms.clear(al.name); } catch (_) {}
      }
    }
    await chrome.storage.local.remove('coordinator');
    updateKeepAwake(false);
  }
}

// ── Keep-Alive Port Connection từ panel.html (Giữ tiến trình Service Worker luôn chạy) ──
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'keepAliveWorker') {
    port.onMessage.addListener(msg => {
      if (msg?.type === 'PING') {
        try { port.postMessage({ type: 'PONG' }); } catch (_) {}
      }
    });
  }
});

// ── Tab events ────────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === 'complete') {
    if (tab?.url && (tab.url.includes('facebook.com') || tab.url.includes('fb.com'))) {
      triggerDebouncedCookieSync(null, 1000);
    }
  }
  if (change.status !== 'complete') return;
  readCampaigns().then(campaigns => {
    for (const [accountId, c] of Object.entries(campaigns)) {
      if (c?.active?.tabId === id) {
        locked(accountId, () => dispatch(accountId, id));
      }
    }
  });
});

chrome.tabs.onRemoved.addListener(id => {
  readCampaigns().then(campaigns => {
    for (const [accountId, c] of Object.entries(campaigns)) {
      if (c?.state === 'running' && c.active?.tabId === id) {
        locked(accountId, async () => {
          const cx = await readCampaigns();
          const cv = cx[accountId];
          if (cv?.state === 'running' && cv.active?.tabId === id) {
            cv.jobs[cv.index].status = 'unknown';
            cv.jobs[cv.index].note = 'Tab Facebook bị đóng trước khi gửi bài.';
            cv.jobs[cv.index].doneAt = Date.now();
            if (cv.autoSkipOnError === false) {
              cv.state = 'paused';
              cv.active = null;
              cv.breakNote = 'Tạm dừng do tab Facebook bị đóng trước khi gửi bài.';
              await saveCampaigns({...cx, [accountId]: cv});
              await maybeStopGlobalAlarm();

              sendFacebookZaloNotify({
                kind: 'error',
                accountName: cv.accountName || accountId,
                accountType: cv.accountType,
                groupUrl: cv.jobs[cv.index]?.url,
                note: 'Tab Facebook bị đóng trước khi gửi bài. Chiến dịch đã tạm dừng.',
                postedCount: cv.postedCount || 0,
                totalJobs: cv.jobs?.length || 0
              }).catch(() => {});
              return;
            }
            cv.index++;
            await saveCampaigns({...cx, [accountId]: cv});
            await advanceCampaign(accountId, { isError: true, note: 'Tab Facebook bị đóng.' });
          }
        });
      }
    }
  });
});

// ── On startup: pause all running campaigns & setup alarms ────────────────────
if (chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    try { chrome.alarms.create('rinRetry', { periodInMinutes: 1 }); } catch (_) {}
    readCampaigns().then(async campaigns => {
      let changed = false;
      for (const [id, c] of Object.entries(campaigns)) {
        if (c.state === 'running') {
          c.state = 'paused';
          if (c.active) c.jobs[c.index].status = 'unknown';
          c.active = null;
          changed = true;
        }
      }
      if (changed) await saveCampaigns(campaigns);
      try { await chrome.alarms.clear('queue'); } catch (_) {}
    });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleRuntimeMessage(m, sender, reply) {
  const fromPanel = sender.id === chrome.runtime.id || !!sender.isExternal;

  if (sender.id !== chrome.runtime.id && !sender.isExternal) return;

  // Lấy trạng thái chiến dịch thời gian thực cho Web Platform & Content Scripts
  if (m.type === 'GET_STATE' || m.type === 'GET_CAMPAIGNS') {
    (async () => {
      try {
        const campaigns = await readCampaigns();
        const coordinator = (await chrome.storage.local.get('coordinator')).coordinator || null;
        const dailyPostStats = (await chrome.storage.local.get('dailyPostStats')).dailyPostStats || {};
        reply({ ok: true, campaigns, coordinator, dailyPostStats });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // PING handler for web_bridge internal messaging
  if (m.type === 'PING') {
    reply({
      ok: true,
      version: '0.4.4',
      syncVersion: 2,
      capabilities: ['GROUP_SEARCH', 'MAPS_SYNC_V2', 'FB_GROUP_SYNC_V2'],
      extensionId: chrome.runtime?.id || 'affaocloanjmkpcinmkcbmekgipnddnm'
    });
    return false;
  }

  // MAPS background runner messages (chỉ chạy trong Chrome Extension worker thật)
  if (m.type === 'MAPS_START_SCAN' || m.type === 'MAPS_RESUME_SCAN' || m.type === 'MAPS_STOP_SCAN' || m.type === 'MAPS_GET_STATUS' || m.type === 'MAPS_SHOW_TAB' || m.type === 'MAPS_CLEAR_DATA') {
    const isWebRuntime = (typeof window !== 'undefined' && window.chrome?.runtime?.id === 'ntd-agency-webapp');
    if (isWebRuntime) {
      reply({
        ok: false,
        webFallback: true,
        extensionUnsupported: true,
        running: false,
        error: 'Web runtime cannot script cross-origin Google Maps tabs directly.'
      });
      return true;
    }
  }
  if (m.type === 'MAPS_START_SCAN') {
    startMapsScan(m.job, m.phoneTypes, m.seenKeys, {
      resetSeenKeys: Boolean(m.resetSeenKeys),
      resetRows: Boolean(m.resetRows)
    }).then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'MAPS_RESUME_SCAN') {
    startMapsScan().then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'MAPS_STOP_SCAN') {
    stopMapsScan().then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'MAPS_CLEAR_DATA') {
    (async () => {
      try {
        const { rinMaps } = await chrome.storage.local.get('rinMaps');
        const nextState = rinMaps && typeof rinMaps === 'object' ? { ...rinMaps } : { rows: [], job: null, settings: null, seenKeys: {} };
        nextState.rows = [];
        nextState.clearedKeepSeen = Boolean(m.keepSeenKeys);
        if (!m.keepSeenKeys) nextState.seenKeys = {};
        if (!m.keepJob) {
          nextState.job = null;
          nextState.isScanning = false;
        }
        await chrome.storage.local.set({ rinMaps: nextState });
        broadcastMapsStateSync(nextState);
        reply({ ok: true, cleared: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'MAPS_GET_STATUS') {
    (async () => {
      try {
        const { rinMaps } = await chrome.storage.local.get('rinMaps');
        const allRows = Array.isArray(rinMaps?.rows) ? rinMaps.rows : [];
        reply({
          ok: true,
          running: mapsScanRunning,
          tabId: mapsCurrentTabId,
          syncVersion: 2,
          state: rinMaps ? {
            job: rinMaps.job || null,
            isScanning: Boolean(rinMaps.isScanning),
            lastScraped: rinMaps.lastScraped || null,
            totalRows: allRows.length,
            recentRows: m.includeAllRows ? allRows : allRows.slice(-1000)
          } : null
        });
      } catch (_) {
        reply({ ok: true, running: mapsScanRunning, tabId: mapsCurrentTabId, syncVersion: 2 });
      }
    })();
    return true;
  }
  if (m.type === 'MAPS_SHOW_TAB') {
    (async () => {
      try {
        if (mapsCurrentTabId) {
          await chrome.tabs.update(mapsCurrentTabId, { active: true });
          reply({ ok: true, tabId: mapsCurrentTabId });
        } else {
          const { rinMaps } = await chrome.storage.local.get('rinMaps');
          if (rinMaps?.tabId) {
            await chrome.tabs.update(rinMaps.tabId, { active: true });
            reply({ ok: true, tabId: rinMaps.tabId });
          } else {
            reply({ ok: false, error: 'Chưa có tab Google Maps nào đang mở.' });
          }
        }
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // FB GROUP PHONE SCANNER background runner messages (chỉ chạy trong Chrome Extension worker thật)
  if (m.type === 'FB_GROUP_START_SCAN' || m.type === 'FB_GROUP_RESUME_SCAN' || m.type === 'FB_GROUP_STOP_SCAN' || m.type === 'FB_GROUP_GET_STATUS' || m.type === 'FB_GROUP_SHOW_TAB' || m.type === 'FB_GROUP_CLEAR_DATA') {
    const isWebRuntime = (typeof window !== 'undefined' && window.chrome?.runtime?.id === 'ntd-agency-webapp');
    if (isWebRuntime) {
      reply({
        ok: false,
        webFallback: true,
        extensionUnsupported: true,
        running: false,
        error: 'Web runtime cannot script cross-origin Facebook tabs directly.'
      });
      return true;
    }
  }
  if (m.type === 'FB_GROUP_START_SCAN') {
    startFbGroupScan(m.job, m.phoneTypes, m.seenKeys).then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'FB_GROUP_RESUME_SCAN') {
    startFbGroupScan().then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'FB_GROUP_STOP_SCAN') {
    stopFbGroupScan().then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'FB_GROUP_CLEAR_DATA') {
    (async () => {
      try {
        const { rinFbGroup } = await chrome.storage.local.get('rinFbGroup');
        const nextState = rinFbGroup && typeof rinFbGroup === 'object' ? { ...rinFbGroup } : {};
        nextState.rows = [];
        nextState.seenKeys = {};
        nextState.postsCount = 0;
        nextState.commentsCount = 0;
        nextState.isScanning = false;
        nextState.job = null;
        await chrome.storage.local.set({ rinFbGroup: nextState });
        reply({ ok: true, cleared: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'FB_GROUP_GET_STATUS') {
    (async () => {
      try {
        const { rinFbGroup } = await chrome.storage.local.get('rinFbGroup');
        reply({
          ok: true,
          running: fbGroupScanRunning,
          tabId: fbGroupCurrentTabId,
          syncVersion: 2,
          state: rinFbGroup ? {
            job: rinFbGroup.job || null,
            isScanning: Boolean(rinFbGroup.isScanning),
            postsCount: rinFbGroup.postsCount || 0,
            commentsCount: rinFbGroup.commentsCount || 0,
            recentRows: Array.isArray(rinFbGroup.rows) ? rinFbGroup.rows.slice(-200) : []
          } : null
        });
      } catch (_) {
        reply({ ok: true, running: fbGroupScanRunning, tabId: fbGroupCurrentTabId, syncVersion: 2 });
      }
    })();
    return true;
  }
  if (m.type === 'FB_GROUP_SHOW_TAB') {
    (async () => {
      try {
        if (fbGroupCurrentTabId) {
          await chrome.tabs.update(fbGroupCurrentTabId, { active: true });
          reply({ ok: true, tabId: fbGroupCurrentTabId });
        } else {
          const { rinFbGroup } = await chrome.storage.local.get('rinFbGroup');
          if (rinFbGroup?.tabId) {
            await chrome.tabs.update(rinFbGroup.tabId, { active: true });
            reply({ ok: true, tabId: rinFbGroup.tabId });
          } else {
            reply({ ok: false, error: 'Chưa có tab Facebook nhóm nào đang mở.' });
          }
        }
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // WARMUP background runner messages
  if (m.type === 'WARMUP_SESSION_FINISHED') {
    reply({ ok: true });
    return true;
  }
  if (m.type === 'WARMUP_START') {
    runWarmupLoop(m.accountIds || [], m.config || {}).catch(err => {
      console.error('[Warmup] Lỗi chạy warmup:', err);
    });
    reply({ ok: true, running: true });
    return true;
  }
  if (m.type === 'WARMUP_STOP') {
    warmupStop = true;
    if (warmupCurrentTabId) {
      chrome.tabs.sendMessage(warmupCurrentTabId, { type: 'STOP_WARMUP_SESSION' }).catch(() => {});
    }
    reply({ ok: true, stopped: true });
    return true;
  }
  if (m.type === 'WARMUP_CANCEL') {
    warmupStop = true;
    warmupRunning = false;
    if (warmupCurrentTabId) {
      chrome.tabs.sendMessage(warmupCurrentTabId, { type: 'STOP_WARMUP_SESSION' }).catch(() => {});
      chrome.tabs.remove(warmupCurrentTabId).catch(() => {});
      warmupCurrentTabId = null;
    }
    chrome.storage.local.set({
      warmupStatus: { running: false, currentIndex: 0, progressPercent: 0, cancelledAt: Date.now() }
    }).catch(() => {});
    try {
      if (!mapsScanRunning) chrome.power?.releaseKeepAwake?.();
    } catch (_) {}
    broadcastWarmupLog('🛑 Đã tắt hẳn chiến dịch nuôi tài khoản và đóng tab Facebook.', '🛑');
    broadcastWarmupMessage({
      type: 'WARMUP_STATUS_EVENT',
      status: { running: false, currentIndex: 0, progressPercent: 0 }
    });
    reply({ ok: true, cancelled: true });
    return true;
  }
  if (m.type === 'WARMUP_GET_STATUS') {
    reply({ ok: true, running: warmupRunning, tabId: warmupCurrentTabId });
    return true;
  }
  if (m.type === 'WARMUP_SHOW_TAB') {
    if (warmupCurrentTabId) {
      chrome.tabs.update(warmupCurrentTabId, { active: true }).catch(() => {});
    }
    reply({ ok: true });
    return true;
  }

  // MAPS: rinPower (keep awake control)
  if (m.type === 'rinPower') {
    (async () => {
      try {
        if (m.on) {
          chrome.power.requestKeepAwake('system');
          mapsPowerTab = sender.tab?.id || m.tabId;
          if (mapsPowerTab) await chrome.tabs.update(mapsPowerTab, { autoDiscardable: false }).catch(() => {});
        } else {
          chrome.power.releaseKeepAwake();
          mapsPowerTab = null;
        }
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // MAPS: rinPair (ghép Zalo bot qua mã)
  if (m.type === 'rinPair') {
    (async () => {
      try {
        const result = await mapsZaloApi(m.token, 'getUpdates', { timeout: '8' });
        const events = Array.isArray(result) ? result : [result];
        for (const e of events) {
          const msg = e?.message || e?.result?.message;
          if (msg?.text?.trim() === m.code && msg.chat?.chat_type === 'PRIVATE' && msg.chat.id) {
            reply({ ok: true, chat: String(msg.chat.id) });
            return;
          }
        }
        reply({ ok: true, chat: null });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // MAPS: rinTest (gửi thử tin nhắn Zalo)
  if (m.type === 'rinTest') {
    (async () => {
      try {
        const { rinZalo: c } = await chrome.storage.local.get('rinZalo');
        if (!c?.token || !c.chat) throw Error('Nhập Token và ghép Zalo trước.');
        await mapsZaloApi(c.token, 'sendMessage', {
          chat_id: c.chat,
          text: '✅ NTD Agency: Kết nối thử thành công!\nTiện ích sẽ tự động gửi thông báo khi có lỗi hoặc khi hoàn thành chiến dịch Đăng bài Facebook & Quét Google Maps.'
        });
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // MAPS: rinNotify (xếp hàng gửi thông báo Zalo)
  if (m.type === 'rinNotify') {
    lockedMaps(async () => {
      const { rinZalo: c, rinQueue: q = [] } = await chrome.storage.local.get(['rinZalo', 'rinQueue']);
      if (!c?.enabled) return { ok: true, disabled: true };
      if (!q.some(x => x.id === m.id)) q.push({ id: m.id, text: String(m.text).slice(0, 2000), attempts: 0 });
      await chrome.storage.local.set({ rinQueue: q });
      await flushMapsQueue();
      return { ok: true };
    }).then(reply).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }

  // CHECK: called from content script to verify campaign still active
  if (m.type === 'CHECK') {
    readCampaigns().then(campaigns => {
      const c = campaigns[m.accountId];
      const ok = c?.state === 'running' &&
        c.active?.token === m.token &&
        c.active?.tabId === sender.tab?.id;
      reply({ok});
    });
    return true;
  }

  // UPDATE_COOKIES: capture fresh cookies after successful auto-login
  if (m.type === 'UPDATE_COOKIES') {
    (async () => {
      const res = await autoSyncFacebookCookies(m.accountId);
      reply(res);
    })();
    return true;
  }

  // SYNC_COOKIES_NOW: quét và cập nhật cookies Facebook hiện tại vào tài khoản
  if (m.type === 'SYNC_COOKIES_NOW') {
    (async () => {
      const res = await autoSyncFacebookCookies(m.accountId || null);
      reply(res);
    })();
    return true;
  }

  // GET_DAILY_STATS: lấy thống kê bài đăng group trong ngày
  if (m.type === 'GET_DAILY_STATS') {
    (async () => {
      const stats = await readDailyStats();
      reply({ ok: true, today: getTodayDateStr(), stats });
    })();
    return true;
  }

  // RESET_DAILY_COUNT: đặt lại số bài đăng hôm nay của 1 tài khoản về 0 (chặn đối với Fanpage)
  if (m.type === 'RESET_DAILY_COUNT') {
    (async () => {
      const { accounts } = await chrome.storage.local.get('accounts');
      const targetAcc = (accounts || []).find(a => a.id === m.accountId);
      if (targetAcc?.type === 'fanpage') {
        reply({ ok: false, error: 'Chính sách an toàn: Không thể đặt lại số bài đăng trong ngày của Fanpage.' });
        return;
      }
      await resetDailyCount(m.accountId);
      reply({ ok: true });
    })();
    return true;
  }

  // RESET_ALL_DAILY_COUNT: đặt lại số bài đăng hôm nay của tài khoản cá nhân về 0 (bảo lưu Fanpage)
  if (m.type === 'RESET_ALL_DAILY_COUNT') {
    (async () => {
      const stats = await readDailyStats();
      const { accounts } = await chrome.storage.local.get('accounts');
      const fanpageIds = new Set((accounts || []).filter(a => a.type === 'fanpage').map(a => a.id));
      const newStats = {};
      for (const [id, val] of Object.entries(stats)) {
        if (fanpageIds.has(id)) {
          newStats[id] = val;
        }
      }
      await saveDailyStats(newStats);
      reply({ ok: true });
    })();
    return true;
  }

  // ACTIVATE_ACCOUNT_SESSION: Nạp cookies của tài khoản vào Chrome và tùy chọn mở/làm mới tab Facebook
  if (m.type === 'ACTIVATE_ACCOUNT_SESSION') {
    (async () => {
      try {
        let accounts = await readAccounts();
        let acc = accounts.find(a => a.id === m.accountId);
        if (!acc && m.accountData) {
          acc = m.accountData;
          accounts.push(acc);
          await saveAccounts(accounts);
        }
        if (!acc) throw new Error('Không tìm thấy tài khoản: ' + m.accountId);

        isSwitchingSession = true;
        try {
          const rawCookies = (acc.cookies && acc.cookies.trim()) ? acc.cookies : '';
          const cookieObj = rawCookies ? parseUniversalCookies(rawCookies) : {};
          const hasCookies = Boolean(cookieObj['c_user'] && cookieObj['xs']);
          const hasDatrInAcc = Boolean(cookieObj['datr']);

          // 1. Nếu có tab Facebook đang mở, tạm chuyển sang about:blank để ngắt các kết nối nền của phiên cũ gây logout tự động
          // Lưu ý: Bỏ qua tab quét nhóm (groupScanTabId) để cho phép chạy song song
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const { groupScanTabId } = await chrome.storage.local.get('groupScanTabId').catch(() => ({}));
          const existingFbTabs = allTabs.filter(t => 
            t.url && (t.url.includes('facebook.com') || t.url.includes('fb.com')) &&
            (!groupScanTabId || t.id !== groupScanTabId)
          );
          for (const tab of existingFbTabs) {
            try { await chrome.tabs.update(tab.id, { url: 'about:blank' }); } catch (_) {}
          }
          if (existingFbTabs.length > 0) {
            await new Promise(r => setTimeout(r, 200));
          }

          // 2. Xóa sạch 100% cookies Facebook cũ để không bị dính nick cũ
          await clearFacebookCookiesOnly(!hasDatrInAcc && hasCookies);
          await new Promise(r => setTimeout(r, 200));

          let injected = [];
          if (hasCookies) {
            // 3. Nạp cookies tài khoản mới vào
            injected = await injectCookies(cookieObj);
            await new Promise(r => setTimeout(r, 350));
            currentSessionAccountId = acc.id;
          } else {
            currentSessionAccountId = null;
          }

          // 3.1. Thiết lập hoặc xóa cookie i_user cho Fanpage
          const pageId = (acc.type === 'fanpage') ? String(acc.pageId || acc.fbId || '') : null;
          if (acc.type === 'fanpage' && pageId) {
            const targetUrls = [
              'https://www.facebook.com/',
              'https://m.facebook.com/',
              'https://web.facebook.com/',
              'https://facebook.com/'
            ];
            for (const targetUrl of targetUrls) {
              await chrome.cookies.set({
                url: targetUrl,
                domain: '.facebook.com',
                name: 'i_user',
                value: pageId,
                path: '/',
                secure: true,
                sameSite: 'lax'
              }).catch(() => {});
            }
          } else {
            for (const targetUrl of ['https://www.facebook.com/', 'https://m.facebook.com/', 'https://facebook.com/']) {
              await chrome.cookies.remove({ url: targetUrl, name: 'i_user' }).catch(() => {});
            }
          }

          // 4. Kiểm tra xác nhận c_user trên Chrome
          const fbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
          const cUser = fbCookies.find(c => c.name === 'c_user')?.value;

          // 5. Nếu có yêu cầu mở/làm mới tab Facebook
          let mainTab = null;
          if (m.openFacebookTab) {
            const targetUrl = (acc.type === 'fanpage' && pageId)
              ? `https://www.facebook.com/${pageId}`
              : (hasCookies
                  ? `https://www.facebook.com/?_r=${Date.now()}`
                  : `https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2F`);

            if (existingFbTabs.length > 0) {
              mainTab = existingFbTabs[0];
              const isBg = !!m.background || m.activeTab === false;
              if (m.tabId) {
                const targetedTab = await chrome.tabs.get(m.tabId).catch(() => null);
                if (targetedTab) mainTab = targetedTab;
              }
              await chrome.tabs.update(mainTab.id, { url: targetUrl, active: !isBg });
              if (!isBg && mainTab.windowId) {
                chrome.windows.update(mainTab.windowId, { focused: true }).catch(() => {});
              }
              if (mainTab?.id) {
                chrome.tabs.update(mainTab.id, { autoDiscardable: false }).catch(() => {});
              }
              for (let i = 1; i < existingFbTabs.length; i++) {
                try { await chrome.tabs.remove(existingFbTabs[i].id); } catch (_) {}
              }
            } else {
              const isBg = !!m.background || m.activeTab === false;
              mainTab = await chrome.tabs.create({ url: targetUrl, active: !isBg });
              if (!isBg && mainTab?.windowId) {
                chrome.windows.update(mainTab.windowId, { focused: true }).catch(() => {});
              }
              if (mainTab?.id) {
                chrome.tabs.update(mainTab.id, { autoDiscardable: false }).catch(() => {});
              }
            }

            // Nếu là Fanpage: tự động bấm chuyển profile sang Fanpage trên tab vừa mở
            if (acc.type === 'fanpage' && pageId && mainTab?.id) {
              (async () => {
                try {
                  const endWait = Date.now() + 15000;
                  while (Date.now() < endWait) {
                    const t = await chrome.tabs.get(mainTab.id).catch(() => null);
                    if (t?.status === 'complete') break;
                    await new Promise(r => setTimeout(r, 400));
                  }
                  await new Promise(r => setTimeout(r, 1000));
                  await chrome.scripting.executeScript({
                    target: { tabId: mainTab.id },
                    func: runPageProfileSwitcher,
                    args: [String(pageId), String(acc.name || '')]
                  }).catch(() => {});
                } catch (_) {}
              })();
            }

            // Nếu không có cookies mà có mật khẩu & email/UID -> Tự động điền đăng nhập
            if (!hasCookies && acc.password && (acc.email || acc.fbId) && mainTab?.id) {
              setTimeout(async () => {
                try {
                  handleRuntimeMessage({
                    type: 'DO_LOGIN',
                    email: acc.email || acc.fbId,
                    password: acc.password,
                    twoFactor: acc.twoFactor || null,
                    existingAccountId: acc.id,
                    targetTabId: mainTab.id
                  }, { id: chrome.runtime?.id }, () => {});
                } catch (_) {}
              }, 1500);
            }
          }

          reply({
            ok: true,
            accountId: acc.id,
            accountName: acc.name,
            cUser: cUser || acc.fbId || 'N/A',
            injectedCount: injected.length,
            tabId: mainTab?.id || null,
            hasCookies
          });
        } finally {
          setTimeout(() => { isSwitchingSession = false; }, 2500);
        }
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // CLEAR_FACEBOOK_SESSION: Đăng xuất hoàn toàn session Facebook trên Chrome và mở trang đăng nhập mới
  if (m.type === 'CLEAR_FACEBOOK_SESSION' || m.type === 'LOGOUT_FACEBOOK') {
    (async () => {
      try {
        isSwitchingSession = true;
        currentSessionAccountId = null;
        await clearFacebookCookiesOnly(false);

        if (m.openLoginTab !== false) {
          const loginUrl = 'https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2F';
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const existingFbTabs = allTabs.filter(t => t.url && (t.url.includes('facebook.com') || t.url.includes('fb.com')));
          if (existingFbTabs.length > 0) {
            await chrome.tabs.update(existingFbTabs[0].id, { url: loginUrl, active: true });
            for (let i = 1; i < existingFbTabs.length; i++) {
              try { await chrome.tabs.remove(existingFbTabs[i].id); } catch (_) {}
            }
          } else {
            await chrome.tabs.create({ url: loginUrl, active: true });
          }
        }
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      } finally {
        setTimeout(() => { isSwitchingSession = false; }, 1000);
      }
    })();
    return true;
  }

  // GET_FACEBOOK_COOKIES: Lấy toàn bộ cookies Facebook hiện tại trên Chrome cho Web Platform
  if (m.type === 'GET_FACEBOOK_COOKIES') {
    (async () => {
      try {
        const allCookies = await chrome.cookies.getAll({}).catch(() => []);
        const fbCookies = allCookies.filter(c =>
          c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
        );
        const cookieMap = new Map();
        for (const ck of fbCookies) {
          if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
            cookieMap.set(ck.name, ck);
          }
        }
        const cUser = cookieMap.get('c_user')?.value;
        const xs = cookieMap.get('xs')?.value;
        const cookieStr = [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');
        reply({ ok: true, cUser, xs, cookieStr, count: cookieMap.size });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── UNIVERSAL COOKIES PROXIES (Cho phép Web Platform gọi chrome.cookies gốc) ──
  if (m.type === 'UNIVERSAL_COOKIES_GET') {
    (async () => {
      try {
        const res = await chrome.cookies.get(m.details || {});
        reply({ ok: true, result: res });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_COOKIES_GET_ALL') {
    (async () => {
      try {
        const res = await chrome.cookies.getAll(m.details || {});
        reply({ ok: true, result: res });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_COOKIES_GET_STORES') {
    (async () => {
      try {
        const res = await chrome.cookies.getAllCookieStores();
        reply({ ok: true, result: res });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_COOKIES_SET') {
    (async () => {
      try {
        const res = await chrome.cookies.set(m.details || {});
        reply({ ok: true, result: res });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_COOKIES_REMOVE') {
    (async () => {
      try {
        const res = await chrome.cookies.remove(m.details || {});
        reply({ ok: true, result: res });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // ── GROUP_SEARCH Runner Messages ───────────────────────────────────────────
  if (m.type === 'GROUP_SEARCH_START' || m.type === 'GROUP_SEARCH_STOP' || m.type === 'GROUP_SEARCH_GET_STATUS' || m.type === 'GROUP_SEARCH_SHOW_TAB') {
    const isWebRuntime = (typeof window !== 'undefined' && window.chrome?.runtime?.id === 'ntd-agency-webapp');
    if (isWebRuntime) {
      reply({
        ok: false,
        webFallback: true,
        extensionUnsupported: true,
        running: false,
        error: 'Web runtime cannot script cross-origin Facebook tabs directly.'
      });
      return true;
    }
  }
  if (m.type === 'GROUP_SEARCH_START') {
    runGroupSearchLoop(m.params || {}).catch(err => {
      console.error('[GroupSearch] Lỗi bắt đầu quét:', err);
    });
    reply({ ok: true, running: true });
    return true;
  }
  if (m.type === 'GROUP_SEARCH_STOP') {
    reply(stopGroupSearchScan());
    return true;
  }
  if (m.type === 'GROUP_SEARCH_GET_STATUS') {
    reply({ ok: true, running: groupSearchRunning, tabId: groupSearchCurrentTabId });
    return true;
  }
  if (m.type === 'GROUP_SEARCH_SHOW_TAB') {
    if (groupSearchCurrentTabId) {
      chrome.tabs.update(groupSearchCurrentTabId, { active: true }).catch(() => {});
    }
    reply({ ok: true });
    return true;
  }
  if (m.type === 'RELOAD_EXTENSION') {
    try {
      chrome.runtime.reload();
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
    return true;
  }

  // ── UNIVERSAL TABS & SCRIPTING PROXIES ─────────────────────────────────────
  if (m.type === 'UNIVERSAL_TABS_CREATE') {
    (async () => {
      try {
        const tab = await chrome.tabs.create({ url: m.url, active: Boolean(m.active) });
        reply({ ok: true, tabId: tab.id, tab });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_TABS_UPDATE') {
    (async () => {
      try {
        const tab = await chrome.tabs.update(m.tabId, m.props || {});
        reply({ ok: true, tab });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_TABS_GET') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(m.tabId);
        reply({ ok: true, tab });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_TABS_REMOVE') {
    (async () => {
      try {
        await chrome.tabs.remove(m.tabId);
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (m.type === 'UNIVERSAL_SCRIPTING_EXECUTE') {
    (async () => {
      try {
        const opts = m.opts || {};
        const tabId = opts.target?.tabId;
        if (!tabId) {
          reply({ ok: false, error: 'Chưa có tabId.' });
          return;
        }

        if (Array.isArray(opts.files) && opts.files.length > 0) {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: opts.world || 'ISOLATED',
            files: opts.files
          });
          reply({ ok: true, result: res?.[0]?.result });
          return;
        }

        if (opts.funcCode) {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: opts.world || 'ISOLATED',
            func: (codeStr, args) => {
              try {
                const fn = new Function('return (' + codeStr + ')')();
                return fn.apply(null, args || []);
              } catch (e) {
                return null;
              }
            },
            args: [opts.funcCode, opts.args || []]
          });
          reply({ ok: true, result: res?.[0]?.result });
          return;
        }

        reply({ ok: false, error: 'Không có hàm hoặc file để thực thi.' });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // DO_LOGIN: auto-login with email/password, capture cookies
  if (m.type === 'DO_LOGIN') {
    const isAllowed = (sender.id === chrome.runtime.id) || !!sender.isExternal;
    if (!isAllowed) { reply({ ok: false, error: 'Không được phép.' }); return true; }

    (async () => {
      let tabId = null;
      try {
        // Thông báo step 1
        chrome.runtime.sendMessage({ type: 'LOGIN_STEP', step: 'step1' }).catch(() => {});

        // ── 1. Xóa sạch session và cookies Facebook hiện có trên trình duyệt ─
        await clearAllFacebookSession();
        await new Promise(r => setTimeout(r, 800));

        // ── 2. Mở tab trang đăng nhập Facebook ───────────────────────────
        const tab = await chrome.tabs.create({
          url: 'https://www.facebook.com/login.php',
          active: true
        });
        tabId = tab.id;

        // Thông báo step 2
        chrome.runtime.sendMessage({ type: 'LOGIN_STEP', step: 'step2' }).catch(() => {});

        // Chờ tab load hoàn tất
        await new Promise((res, rej) => {
          const timeout = setTimeout(() => rej(new Error('Tải trang đăng nhập quá thời gian.')), 25000);
          chrome.tabs.onUpdated.addListener(function handler(id, change) {
            if (id !== tabId || change.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(handler);
            clearTimeout(timeout);
            res();
          });
        });

        await new Promise(r => setTimeout(r, 1500));

        // Kiểm tra xem tab có bị redirect về trang chủ/home.php do tài khoản cũ không
        const tabInfo = await chrome.tabs.get(tabId).catch(() => ({}));
        const currentUrl = tabInfo.url || '';

        if (!currentUrl.includes('/login') && (
          currentUrl.includes('home.php') ||
          (currentUrl.includes('facebook.com/') && !currentUrl.includes('checkpoint'))
        )) {
          // Xóa session lại lần nữa và chuyển hướng cưỡng bức về login
          await clearAllFacebookSession();
          await new Promise(r => setTimeout(r, 600));
          await chrome.tabs.update(tabId, {
            url: 'https://www.facebook.com/login.php?login_attempt=1'
          });
          await new Promise((res) => {
            const timeout = setTimeout(res, 15000);
            chrome.tabs.onUpdated.addListener(function handler(id, change) {
              if (id !== tabId || change.status !== 'complete') return;
              chrome.tabs.onUpdated.removeListener(handler);
              clearTimeout(timeout);
              res();
            });
          });
          await new Promise(r => setTimeout(r, 1500));
        }

        // Inject script hỗ trợ đăng nhập
        await chrome.scripting.executeScript({ target: { tabId }, files: ['login_helper.js'] });
        await new Promise(r => setTimeout(r, 600));

        // Thông báo step 3: Điền thông tin đăng nhập
        chrome.runtime.sendMessage({ type: 'LOGIN_STEP', step: 'step3' }).catch(() => {});

        // Gửi thông tin đăng nhập vào tab
        const loginResult = await chrome.tabs.sendMessage(tabId, {
          type: 'DO_LOGIN',
          email: m.email,
          password: m.password,
        }).catch(e => {
          // Nếu trang điều hướng ngay sau khi click, message channel có thể bị đóng nhưng form đã được gửi
          if (e.message && e.message.includes('message channel closed')) {
            return { ok: true, submitted: true };
          }
          return { ok: false, error: 'Không thể gửi lệnh vào tab: ' + e.message };
        });

        if (!loginResult?.ok) {
          await chrome.tabs.remove(tabId).catch(() => {});
          reply({ ok: false, error: loginResult?.error || 'Đăng nhập thất bại.' });
          return;
        }

        // Thông báo step 4: Lấy cookies
        chrome.runtime.sendMessage({ type: 'LOGIN_STEP', step: 'step4' }).catch(() => {});

        // Chờ cookies phiên đăng nhập (c_user) xuất hiện (tối đa 30 giây, hoặc 120 giây nếu có 2FA)
        const startTime = Date.now();
        let endWait = startTime + 30000;
        let cUser = null;
        let allNewCookies = [];
        let cookieMap = new Map();
        let notified2FA = false;
        let submitted2FA = false;

        while (Date.now() < endWait) {
          await new Promise(r => setTimeout(r, 1000));

          // 1. Kiểm tra URL tab xem có bị chuyển đến trang Checkpoint/2FA không
          const tabCheck = await chrome.tabs.get(tabId).catch(() => null);
          if (tabCheck?.url && /checkpoint|two_step|2fa|approvals/i.test(tabCheck.url)) {
            if (!notified2FA) {
              notified2FA = true;
              endWait = Date.now() + 120000;
              await chrome.tabs.update(tabId, { active: true }).catch(() => {});
            }

            // Nếu tài khoản có 2FA Secret Key -> Tự động tạo mã và điền ngay!
            if (m.twoFactor && !submitted2FA) {
              const otp = await generate2FACode(m.twoFactor);
              if (otp) {
                submitted2FA = true;
                chrome.runtime.sendMessage({
                  type: 'LOGIN_STEP',
                  step: 'step_2fa',
                  message: `⚡ Đang tự động giải mã 2FA (${otp})...`
                }).catch(() => {});

                // Gửi lệnh submit mã 2FA vào tab
                chrome.tabs.sendMessage(tabId, { type: 'SUBMIT_2FA', code: otp }).catch(() => {});
              }
            } else if (!m.twoFactor) {
              chrome.runtime.sendMessage({
                type: 'LOGIN_STEP',
                step: 'step_2fa',
                message: 'Vui lòng nhập mã 2FA trên tab Facebook...'
              }).catch(() => {});
            }
          }

          // 2. Quét cookies facebook hiện tại
          allNewCookies = (await chrome.cookies.getAll({})).filter(c =>
            c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
          );

          cookieMap = new Map();
          for (const ck of allNewCookies) {
            if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
              cookieMap.set(ck.name, ck);
            }
          }

          cUser = cookieMap.get('c_user');
          if (cUser && cUser.value) {
            // Đã có c_user -> Đăng nhập thành công!
            break;
          }

          // 3. Nếu không phải 2FA và sau 6 giây mà tab chuyển về trang báo lỗi sai mật khẩu
          if (!notified2FA && Date.now() - startTime > 6000 && tabCheck?.url) {
            if (tabCheck.url.includes('login_attempt') || tabCheck.url.includes('error')) {
              const errMsg = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const el = document.querySelector('#error_box, [id*="error"], [role="alert"], [data-testid="login_error"]');
                  return el ? el.innerText.trim() : '';
                }
              }).then(r => r?.[0]?.result).catch(() => '');

              if (errMsg && errMsg.length > 5) {
                await chrome.tabs.remove(tabId).catch(() => {});
                reply({ ok: false, error: 'Facebook báo lỗi: ' + errMsg.slice(0, 200) });
                return;
              }
            }
          }
        }

        if (!cUser) {
          await chrome.tabs.remove(tabId).catch(() => {});
          if (notified2FA) {
            reply({ ok: false, error: 'Hết thời gian chờ xác minh 2FA. Vui lòng kiểm tra lại mã 2FA của VIA.' });
          } else {
            reply({ ok: false, error: 'Đăng nhập quá thời gian — không lấy được cookies phiên. Vui lòng kiểm tra lại email/mật khẩu.' });
          }
          return;
        }

        // Đợi thêm 1.5s để các cookie phiên (xs, fr, datr, sb...) ghi đầy đủ
        await new Promise(r => setTimeout(r, 1500));
        allNewCookies = (await chrome.cookies.getAll({})).filter(c =>
          c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
        );
        cookieMap = new Map();
        for (const ck of allNewCookies) {
          if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
            cookieMap.set(ck.name, ck);
          }
        }
        const cookieStr = [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');

        // 4. Tự động lấy Token EAAG & EAAB từ phiên đăng nhập mới
        const [tokenEAAG, tokenEAAB] = await Promise.all([
          fetchTokenEAAG().catch(() => null),
          fetchTokenEAAB().catch(() => null)
        ]);
        const activeToken = tokenEAAG || tokenEAAB || null;

        // 5. Nếu có ID tài khoản sẵn, tự động cập nhật cookies & token mới vào storage
        if (m.existingAccountId) {
          const { accounts } = await chrome.storage.local.get('accounts');
          const accList = accounts || [];
          const targetAcc = accList.find(a => a.id === m.existingAccountId);
          if (targetAcc) {
            targetAcc.cookies = cookieStr;
            if (activeToken) targetAcc.token = activeToken;
            targetAcc.fbId = cUser.value;
            targetAcc.lastCookieSync = Date.now();
            await chrome.storage.local.set({ accounts: accList });
          }
        }

        // Thông báo step 5: Lưu tài khoản
        chrome.runtime.sendMessage({ type: 'LOGIN_STEP', step: 'step5' }).catch(() => {});

        // Nếu người dùng yêu cầu giữ lại tab Facebook (hoặc mở Facebook sau khi thêm VIA)
        if (m.keepSession || m.openFacebookTab) {
          await chrome.tabs.update(tabId, { url: `https://www.facebook.com/?_r=${Date.now()}`, active: true }).catch(() => {});
        } else {
          await chrome.tabs.remove(tabId).catch(() => {});
        }

        reply({ ok: true, cookies: cookieStr, cUser: cUser.value, token: activeToken });
      } catch (e) {
        if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }


  // Privileged commands
  const run = async () => {
    if (m.type === 'ACTIVATE_ACCOUNT_SESSION') {
      const res = await activateAccountSessionDirectly(m.accountId, m.openFacebookTab);
      const accounts = await readAccounts();
      const acc = accounts.find(a => a.id === m.accountId);
      const pageId = (acc?.type === 'fanpage') ? String(acc.pageId || acc.fbId || '') : null;
      if (acc?.type === 'fanpage' && pageId && res?.tabId) {
        currentActiveFacebookProfileId = pageId;
        // Đợi tab Facebook tải xong giao diện và tự động bấm chuyển đổi Profile sang Fanpage Pro5
        await waitForTabLoaded(res.tabId, 15000);
        await new Promise(r => setTimeout(r, 1500));
        await chrome.scripting.executeScript({
          target: { tabId: res.tabId },
          func: runPageProfileSwitcher,
          args: [pageId, String(acc.name || '')]
        }).catch(err => console.warn('[FanpageSwitch] Lỗi executeScript trên tab mở trực tiếp:', err));
      } else if (acc && acc.type !== 'fanpage') {
        currentActiveFacebookProfileId = acc.fbId || res?.cUser;
      }
      return res;
    }

    if (['START_ALL', 'START_ONE', 'STOP_ALL', 'STOP_ONE', 'NEXT', 'PAUSE_ALL', 'PAUSE_ONE', 'RESUME_ALL', 'RESUME_ONE'].includes(m.type) && !fromPanel) {
      throw new Error('Không được phép.');
    }

    // ── START_ALL: start campaigns for all accounts ──────────────────────────
    if (m.type === 'START_ALL') {
      const accounts = await readAccounts();
      if (!accounts.length) throw new Error('Chưa có tài khoản nào. Hãy thêm tài khoản trước.');

      const raw = m.data;
      const allPosts = (raw.posts && Array.isArray(raw.posts) && raw.posts.length > 0)
        ? raw.posts
        : [{ id: 1, text: raw.text, picture: raw.picture }];

      const anyHasText = allPosts.some(p => p?.text?.trim()) || raw.text?.trim();
      if (!anyHasText) throw new Error('Hãy nhập nội dung bài viết.');
      const gapMin = Number(raw.gapMin ?? raw.gap ?? 180);
      if (!Number.isFinite(gapMin) || gapMin < 60) throw new Error('Khoảng cách tối thiểu 60 giây.');
      const gapMax = Number(raw.gapMax ?? gapMin);
      if (!Number.isFinite(gapMax) || gapMax < gapMin) throw new Error('Khoảng cách tối đa phải lớn hơn hoặc bằng khoảng cách tối thiểu.');
      if (!['preview', 'auto'].includes(raw.mode)) throw new Error('Chế độ không hợp lệ.');
      const breakAfter = raw.breakAfter ? Math.max(1, Number(raw.breakAfter)) : 5;
      const breakMinutes = raw.breakMinutes ? Math.max(1, Number(raw.breakMinutes)) : 10;
      const maxPosts = raw.maxPosts ? Math.max(0, Number(raw.maxPosts)) : 0;
      const enableDailyLimit = raw.enableDailyLimit !== undefined ? !!raw.enableDailyLimit : true;
      const dailyLimit = raw.dailyLimit ? Math.max(1, Number(raw.dailyLimit)) : 20;
      const randomTag = raw.randomTag !== undefined ? !!raw.randomTag : true;
      const humanBehavior = raw.humanBehavior !== undefined ? !!raw.humanBehavior : true;
      const enableBreak = raw.enableBreak !== undefined ? !!raw.enableBreak : true;
      const autoSkipOnError = raw.autoSkipOnError !== undefined ? !!raw.autoSkipOnError : true;
      const accountOrder = ['round_robin', 'sequential', 'parallel'].includes(raw.accountOrder) ? raw.accountOrder : 'round_robin';
      const splitSharedGroups = !!raw.splitSharedGroups;

      const d = {
        ...raw,
        gap: gapMin,
        gapMin,
        gapMax,
        accountOrder,
        splitSharedGroups,
        randomTag,
        humanBehavior,
        autoSkipOnError,
        enableBreak,
        breakAfter,
        breakMinutes,
        maxPosts,
        enableDailyLimit,
        dailyLimit
      };
      if (!Number.isFinite(d.at)) throw new Error('Thời gian không hợp lệ.');
      const campaigns = await readCampaigns();

      // Tự động dọn dẹp các lịch đếm ngược cũ để nạp chiến dịch mới
      for (const a of accounts) {
        try { await chrome.alarms.clear('tick_' + a.id); } catch (_) {}
      }

      // Lọc danh sách ứng viên tài khoản được chỉ định chạy
      let candidateAccounts = accounts;
      if (Array.isArray(d.targetAccountIds) && d.targetAccountIds.length > 0) {
        candidateAccounts = accounts.filter(a => d.targetAccountIds.includes(a.id));
      } else if (d.groupSourceMode === 'categories') {
        candidateAccounts = accounts.filter(a => !!(d.accountGroups && d.accountGroups[a.id]?.trim()));
      } else if (Array.isArray(d.sharedSelectedAccounts) && d.sharedSelectedAccounts.length > 0) {
        candidateAccounts = accounts.filter(a => d.sharedSelectedAccounts.includes(a.id));
      }

      // Shared groups list (Chỉ dùng khi groupSourceMode !== 'categories')
      let sharedUrls = [];
      if (d.groupSourceMode !== 'categories' && d.links?.trim()) {
        try { sharedUrls = groups(d.links); } catch (e) {
          const anyNeedsShared = candidateAccounts.some(a => !a.groups?.trim());
          if (anyNeedsShared) throw e;
        }
      }

      // Accounts that use shared groups
      const sharedAccs = (d.groupSourceMode === 'categories')
        ? []
        : candidateAccounts.filter(a => !a.groups?.trim());

      // 1. Identify which accounts have groups to post
      const targets = [];
      const skippedDueToLimit = [];
      for (const acc of candidateAccounts) {
        let urls = [];

        if (d.groupSourceMode === 'categories') {
          if (d.accountGroups && d.accountGroups[acc.id]?.trim()) {
            try {
              urls = groups(d.accountGroups[acc.id]);
            } catch (e) {
              throw new Error(`Tài khoản "${acc.name}": ${e.message}`);
            }
          }
        } else {
          if (acc.groups?.trim()) {
            try {
              urls = groups(acc.groups);
            } catch (e) {
              throw new Error(`Tài khoản "${acc.name}": ${e.message}`);
            }
          } else if (sharedUrls.length > 0) {
            if (splitSharedGroups && sharedAccs.length > 0) {
              const sharedIdx = sharedAccs.findIndex(a => a.id === acc.id);
              if (sharedIdx >= 0) {
                urls = sharedUrls.filter((_, i) => i % sharedAccs.length === sharedIdx);
              }
            } else {
              urls = [...sharedUrls];
            }
          }
        }

        if (urls.length > 0) {
          if (d.enableDailyLimit !== false) {
            const todayCount = await getDailyCount(acc.id);
            const accountDailyLimit = getAccountDailyLimit(acc, d.dailyLimit);
            if (todayCount >= accountDailyLimit) {
              skippedDueToLimit.push({ acc, todayCount, limit: accountDailyLimit });
              continue;
            }
            const remaining = accountDailyLimit - todayCount;
            if (urls.length > remaining) {
              urls = urls.slice(0, remaining);
            }
          }

          if (d.maxPosts > 0 && urls.length > d.maxPosts) {
            urls = urls.slice(0, d.maxPosts);
          }

          if (urls.length > 0) {
            targets.push({ acc, urls });
          }
        }
      }

      if (!targets.length) {
        if (skippedDueToLimit.length > 0) {
          throw new Error(`Tất cả ${skippedDueToLimit.length} tài khoản / Fanpage đã chọn đều đã đạt giới hạn đăng bài group hôm nay (Fanpage tối đa 5 bài/ngày, Nick cá nhân tối đa ${d.dailyLimit} bài/ngày). Hệ thống sẽ mở lại vào ngày mai.`);
        }
        throw new Error('Không có tài khoản nào có nhóm để đăng. Vui lòng chọn danh mục nhóm hoặc nhập link nhóm.');
      }

      // 2. Lưu tập trung ảnh đính kèm vào campaignPictures trong storage riêng
      // Tránh nhân bản dữ liệu base64 (3-5 MB) cho từng tài khoản làm phình to campaigns
      const campaignPictures = {};
      if (Array.isArray(allPosts)) {
        allPosts.forEach((p, pI) => {
          if (p?.picture?.data && (!p.background || p.background === 'none')) {
            campaignPictures[pI] = p.picture;
          }
        });
      }
      if (raw.picture?.data && !campaignPictures[0] && (!raw.background || raw.background === 'none')) {
        campaignPictures[0] = raw.picture;
      }
      // LUÔN ghi đè campaignPictures để dọn sạch toàn bộ ảnh cũ từ các đợt chạy trước
      await chrome.storage.local.set({ campaignPictures });

      // Create a campaign per active target account (khởi tạo sạch danh sách chạy đợt này)
      const newCampaigns = {};
      for (let idx = 0; idx < targets.length; idx++) {
        const { acc } = targets[idx];
        let { urls } = targets[idx];

        let initState = 'running';
        let initNextAt = d.at;
        if (accountOrder === 'round_robin' || accountOrder === 'sequential') {
          initState = idx === 0 ? 'running' : 'waiting';
          initNextAt = idx === 0 ? d.at : 0;
        }

        const postIdx = (d.accountPostMap && d.accountPostMap[acc.id] !== undefined)
          ? Number(d.accountPostMap[acc.id])
          : 0;
        let assignedPost = (allPosts && allPosts.find(p => (p.idx === postIdx || p.id === (postIdx + 1)) && p.text?.trim()))
          || (allPosts && allPosts[postIdx] && allPosts[postIdx].text?.trim() ? allPosts[postIdx] : null)
          || (allPosts && allPosts.find(p => p?.text?.trim()))
          || (allPosts && allPosts[0])
          || { text: d.text, picture: d.picture, background: d.background, postLinkMode: d.postLinkMode };

        const postText = assignedPost?.text?.trim() ? assignedPost.text : (d.text || '');
        const postBg = assignedPost?.background || null;
        const postPic = (!postBg || postBg === 'none') ? ((assignedPost?.picture !== undefined) ? assignedPost.picture : d.picture) : null;

        const hasUrlInPost = /(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(postText);
        const postLinkMode = !postPic && (
          !!assignedPost?.postLinkMode ||
          !!d.postLinkMode ||
          !!raw.postLinkMode ||
          (Array.isArray(allPosts) && allPosts.some(p => p?.postLinkMode) && hasUrlInPost) ||
          (hasUrlInPost && postText.trim().startsWith('http') && !postText.trim().includes('\n'))
        );

        if (!postText?.trim()) {
          throw new Error(`Tài khoản "${acc.name}" được gán Bài ${postIdx + 1} nhưng bài này chưa có nội dung.`);
        }
        if (postText.length > 20000) {
          throw new Error(`Nội dung Bài ${postIdx + 1} (gán cho "${acc.name}") vượt quá 20.000 ký tự.`);
        }
        const postViolations = findBannedWords(postText);
        if (postViolations.length > 0) {
          const uniqueBanned = [...new Set(postViolations.map(b => b.word))];
          throw new Error(`Nội dung Bài ${postIdx + 1} (gán cho "${acc.name}") chứa từ cấm vi phạm chính sách: ${uniqueBanned.join(', ')}.`);
        }

        newCampaigns[acc.id] = {
          id: crypto.randomUUID(),
          accountId: acc.id,
          accountName: acc.name,
          text: postText,
          picture: postPic?.name ? { name: postPic.name, type: postPic.type } : null,
          background: postBg,
          postLinkMode,
          postIndex: postIdx,
          postTitle: `Bài ${postIdx + 1}`,
          mode: d.mode,
          gap: d.gap,
          gapMin: d.gapMin,
          gapMax: d.gapMax,
          accountOrder,
          randomTag: d.randomTag,
          humanBehavior: d.humanBehavior,
          autoSkipOnError: d.autoSkipOnError,
          enableBreak: d.enableBreak,
          breakAfter: d.breakAfter,
          breakMinutes: d.breakMinutes,
          maxPosts: d.maxPosts,
          enableDailyLimit: d.enableDailyLimit,
          dailyLimit: getAccountDailyLimit(acc, d.dailyLimit),
          accountType: acc.type || 'personal',
          pageId: acc.pageId || null,
          postedCount: 0,
          breakNote: null,
          index: 0,
          state: initState,
          nextAt: initNextAt,
          active: null,
          jobs: urls.map(url => ({url, status: 'queued'})),
        };
      }

      // Ghi nhận tài khoản đã đạt giới hạn ngày vào trạng thái đã hoàn thành
      for (const item of skippedDueToLimit) {
        const postIdx = (d.accountPostMap && d.accountPostMap[item.acc.id] !== undefined)
          ? Number(d.accountPostMap[item.acc.id])
          : 0;
        const assignedPost = (allPosts && allPosts[postIdx]) || { text: d.text, picture: d.picture, background: d.background };
        const postText = assignedPost?.text?.trim() ? assignedPost.text : (d.text || '');
        const postBg = assignedPost?.background || null;
        const postPic = (!postBg || postBg === 'none') ? ((assignedPost?.picture !== undefined) ? assignedPost.picture : d.picture) : null;

        newCampaigns[item.acc.id] = {
          id: crypto.randomUUID(),
          accountId: item.acc.id,
          accountName: item.acc.name,
          text: postText,
          picture: postPic?.name ? { name: postPic.name, type: postPic.type } : null,
          background: postBg,
          postIndex: postIdx,
          postTitle: `Bài ${postIdx + 1}`,
          mode: d.mode,
          gap: d.gap,
          gapMin: d.gapMin,
          gapMax: d.gapMax,
          accountOrder,
          randomTag: d.randomTag,
          humanBehavior: d.humanBehavior,
          autoSkipOnError: d.autoSkipOnError,
          enableBreak: d.enableBreak,
          breakAfter: d.breakAfter,
          breakMinutes: d.breakMinutes,
          maxPosts: d.maxPosts,
          enableDailyLimit: d.enableDailyLimit,
          dailyLimit: getAccountDailyLimit(item.acc, d.dailyLimit),
          accountType: item.acc.type || 'personal',
          pageId: item.acc.pageId || null,
          postedCount: 0,
          breakNote: `🛑 Đã đăng ${item.todayCount}/${item.limit} bài hôm nay (Đạt giới hạn ngày). Tự động bỏ qua đợt này.`,
          index: 0,
          state: 'done',
          nextAt: 0,
          active: null,
          jobs: [],
        };
      }

      // Save coordinator for active target accounts
      if (accountOrder === 'round_robin') {
        await saveCoordinator({
          mode: 'round_robin',
          order: targets.map(t => t.acc.id),
          currentTurn: 0,
        });
      } else if (accountOrder === 'sequential') {
        await saveCoordinator({
          mode: 'sequential',
          order: targets.map(t => t.acc.id),
          currentIndex: 0,
        });
      } else {
        await chrome.storage.local.remove('coordinator');
      }

      await chrome.storage.local.set({draft: d});
      await saveCampaigns(newCampaigns);
      await chrome.alarms.create('queue', {periodInMinutes: 0.5});

      if (accountOrder === 'parallel') {
        let delay = 0;
        for (const t of targets) {
          const aid = t.acc.id;
          await scheduleAccountTick(aid, Date.now() + delay);
          delay += 3000;
        }
      } else {
        const firstId = targets[0].acc.id;
        const targetTime = Math.max(Date.now(), d.at);
        await scheduleAccountTick(firstId, targetTime);
      }
      return {ok: true};
    }

    // ── START_ONE: start campaign for single account ─────────────────────────
    if (m.type === 'START_ONE') {
      const {accountId} = m;
      const accounts = await readAccounts();
      const acc = accounts.find(a => a.id === accountId);
      if (!acc) throw new Error('Tài khoản không tồn tại.');

      const campaigns = await readCampaigns();
      try { await chrome.alarms.clear('tick_' + accountId); } catch (_) {}

      const rawD = m.data;
      const allPosts = (rawD.posts && Array.isArray(rawD.posts) && rawD.posts.length > 0)
        ? rawD.posts
        : [{ id: 1, text: rawD.text, picture: rawD.picture }];
      const postIdx = (rawD.accountPostMap && rawD.accountPostMap[accountId] !== undefined)
        ? Number(rawD.accountPostMap[accountId])
        : 0;
      let assignedPost = (allPosts && allPosts.find(p => (p.idx === postIdx || p.id === (postIdx + 1)) && p.text?.trim()))
        || (allPosts && allPosts[postIdx] && allPosts[postIdx].text?.trim() ? allPosts[postIdx] : null)
        || (allPosts && allPosts.find(p => p?.text?.trim()))
        || (allPosts && allPosts[0])
        || { text: rawD.text, picture: rawD.picture, background: rawD.background, postLinkMode: rawD.postLinkMode };

      const postText = assignedPost?.text?.trim() ? assignedPost.text : (rawD.text || '');
      const postBg = assignedPost?.background || null;
      const postPic = (!postBg || postBg === 'none') ? ((assignedPost?.picture !== undefined) ? assignedPost.picture : rawD.picture) : null;

      const hasUrlInPostOne = /(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(postText);
      const postLinkMode = !postPic && (
        !!assignedPost?.postLinkMode ||
        !!rawD.postLinkMode ||
        (Array.isArray(allPosts) && allPosts.some(p => p?.postLinkMode) && hasUrlInPostOne) ||
        (hasUrlInPostOne && postText.trim().startsWith('http') && !postText.trim().includes('\n'))
      );

      if (!postText?.trim()) throw new Error(`Bài ${postIdx + 1} chưa có nội dung. Hãy nhập nội dung bài viết.`);
      if (postText.length > 20000) throw new Error(`Nội dung Bài ${postIdx + 1} tối đa 20.000 ký tự.`);
      const bannedViolationsOne = findBannedWords(postText);
      if (bannedViolationsOne.length > 0) {
        const uniqueBanned = [...new Set(bannedViolationsOne.map(b => b.word))];
        throw new Error(`Nội dung Bài ${postIdx + 1} chứa từ cấm vi phạm chính sách Facebook: ${uniqueBanned.join(', ')}. Hãy xóa các từ này trước khi đăng!`);
      }
      const gapMin = Number(rawD.gapMin ?? rawD.gap ?? 180);
      if (!Number.isFinite(gapMin) || gapMin < 60) throw new Error('Khoảng cách tối thiểu 60 giây.');
      const gapMax = Number(rawD.gapMax ?? gapMin);
      if (!Number.isFinite(gapMax) || gapMax < gapMin) throw new Error('Khoảng cách tối đa phải lớn hơn hoặc bằng khoảng cách tối thiểu.');
      if (!['preview', 'auto'].includes(rawD.mode)) throw new Error('Chế độ không hợp lệ.');
      const breakAfter = rawD.breakAfter ? Math.max(1, Number(rawD.breakAfter)) : 5;
      const breakMinutes = rawD.breakMinutes ? Math.max(1, Number(rawD.breakMinutes)) : 10;
      const maxPosts = rawD.maxPosts ? Math.max(0, Number(rawD.maxPosts)) : 0;
      const enableDailyLimit = rawD.enableDailyLimit !== undefined ? !!rawD.enableDailyLimit : true;
      const dailyLimit = rawD.dailyLimit ? Math.max(1, Number(rawD.dailyLimit)) : 20;
      const randomTag = rawD.randomTag !== undefined ? !!rawD.randomTag : true;
      const humanBehavior = rawD.humanBehavior !== undefined ? !!rawD.humanBehavior : true;
      const enableBreak = rawD.enableBreak !== undefined ? !!rawD.enableBreak : true;
      const autoSkipOnError = rawD.autoSkipOnError !== undefined ? !!rawD.autoSkipOnError : true;
      const d = {
        ...rawD,
        gap: gapMin,
        gapMin,
        gapMax,
        randomTag,
        humanBehavior,
        autoSkipOnError,
        enableBreak,
        breakAfter,
        breakMinutes,
        maxPosts,
        enableDailyLimit,
        dailyLimit
      };
      if (!Number.isFinite(d.at)) throw new Error('Thời gian không hợp lệ.');

      let groupLinks = '';
      if (rawD.groupSourceMode === 'categories') {
        groupLinks = (rawD.accountGroups && rawD.accountGroups[accountId]?.trim()) || '';
      } else {
        groupLinks = (acc.groups?.trim() ? acc.groups : rawD.links) || '';
      }
      if (!groupLinks.trim()) {
        throw new Error(rawD.groupSourceMode === 'categories'
          ? `Tài khoản "${acc.name}" chưa được chọn danh mục nhóm nào.`
          : `Tài khoản "${acc.name}" không có nhóm để đăng.`);
      }
      let urls = groups(groupLinks);

      const accountDailyLimit = getAccountDailyLimit(acc, d.dailyLimit);
      if (d.enableDailyLimit !== false) {
        const todayCount = await getDailyCount(accountId);
        if (todayCount >= accountDailyLimit) {
          const typeName = acc.type === 'fanpage' ? 'Fanpage' : 'Tài khoản';
          throw new Error(`${typeName} "${acc.name}" đã đạt giới hạn ${accountDailyLimit} bài group hôm nay (${todayCount}/${accountDailyLimit}). Hãy quay lại vào ngày mai hoặc đặt lại số đếm bài hôm nay.`);
        }
        const remaining = accountDailyLimit - todayCount;
        if (urls.length > remaining) {
          urls = urls.slice(0, remaining);
        }
      }

      if (d.maxPosts > 0 && urls.length > d.maxPosts) {
        urls = urls.slice(0, d.maxPosts);
      }

      try {
        const { campaignPictures = {} } = await chrome.storage.local.get('campaignPictures');
        if (postPic?.data) {
          campaignPictures[postIdx] = postPic;
        } else {
          delete campaignPictures[postIdx];
        }
        await chrome.storage.local.set({ campaignPictures });
      } catch (_) {}

      campaigns[accountId] = {
        id: crypto.randomUUID(),
        accountId,
        accountName: acc.name,
        text: postText,
        picture: postPic?.name ? { name: postPic.name, type: postPic.type } : null,
        background: postBg,
        postLinkMode,
        postIndex: postIdx,
        postTitle: `Bài ${postIdx + 1}`,
        mode: d.mode,
        gap: d.gap,
        gapMin: d.gapMin,
        gapMax: d.gapMax,
        randomTag: d.randomTag,
        humanBehavior: d.humanBehavior,
        autoSkipOnError: d.autoSkipOnError,
        enableBreak: d.enableBreak,
        breakAfter: d.breakAfter,
        breakMinutes: d.breakMinutes,
        maxPosts: d.maxPosts,
        enableDailyLimit: d.enableDailyLimit,
        dailyLimit: accountDailyLimit,
        accountType: acc.type || 'personal',
        pageId: acc.pageId || null,
        postedCount: 0,
        breakNote: null,
        index: 0,
        state: 'running',
        nextAt: d.at,
        active: null,
        jobs: urls.map(url => ({url, status: 'queued'})),
      };

      await saveCampaigns(campaigns);
      const targetTime = Math.max(Date.now(), d.at);
      await scheduleAccountTick(accountId, targetTime);
      return {ok: true};
    }

    // ── STOP_ALL: stop all running campaigns ─────────────────────────────────
    if (m.type === 'STOP_ALL') {
      const campaigns = await readCampaigns();
      for (const [id, c] of Object.entries(campaigns)) {
        if (c.active?.tabId) {
          try { await chrome.tabs.remove(c.active.tabId); } catch (_) {}
        }
      }
      await chrome.storage.local.remove('coordinator');
      currentSessionAccountId = null;
      try { await chrome.alarms.clear('queue'); } catch (_) {}
      const allAlarms = (await chrome.alarms.getAll?.().catch(() => [])) || [];
      for (const al of allAlarms) {
        if (al.name?.startsWith('tick_')) {
          try { await chrome.alarms.clear(al.name); } catch (_) {}
        }
      }
      updateKeepAwake(false);
      await chrome.storage.local.remove('campaigns');
      return {ok: true};
    }

    // ── STOP_ONE: stop single account ────────────────────────────────────────
    if (m.type === 'STOP_ONE') {
      const campaigns = await readCampaigns();
      const c = campaigns[m.accountId];
      if (c) {
        const wasRunning = c.state === 'running';
        c.state = 'stopped';
        if (c.active) { c.jobs[c.index].status = 'unknown'; c.jobs[c.index].note = 'Dừng theo yêu cầu.'; }
        c.active = null;
        c.breakNote = null;

        // If stopped account was running in coordinated mode, pass turn to next account
        const coord = await readCoordinator();
        if (wasRunning && coord) {
          if (coord.mode === 'round_robin') {
            for (let i = 1; i <= coord.order.length; i++) {
              const candidateIdx = (coord.currentTurn + i) % coord.order.length;
              const candidateId = coord.order[candidateIdx];
              const cand = campaigns[candidateId];
              if (cand && !['done', 'stopped', 'blocked', 'paused'].includes(cand.state) && cand.index < cand.jobs.length) {
                cand.state = 'running';
                cand.nextAt = Date.now() + 3000;
                coord.currentTurn = candidateIdx;
                await saveCoordinator(coord);
                await scheduleAccountTick(candidateId, cand.nextAt);
                break;
              }
            }
          } else if (coord.mode === 'sequential') {
            for (let i = coord.currentIndex + 1; i < coord.order.length; i++) {
              const candidateId = coord.order[i];
              const cand = campaigns[candidateId];
              if (cand && !['done', 'stopped', 'blocked'].includes(cand.state) && cand.index < cand.jobs.length) {
                cand.state = 'running';
                cand.nextAt = Date.now() + 3000;
                coord.currentIndex = i;
                await saveCoordinator(coord);
                await scheduleAccountTick(candidateId, cand.nextAt);
                break;
              }
            }
          }
        }
        await saveCampaigns(campaigns);
      }
      await maybeStopGlobalAlarm();
      return {ok: true};
    }

    // ── PAUSE_ALL: pause all running or waiting campaigns ─────────────────────
    if (m.type === 'PAUSE_ALL') {
      const campaigns = await readCampaigns();
      let changed = false;
      for (const [id, c] of Object.entries(campaigns)) {
        if (c.state === 'running' || c.state === 'waiting') {
          c.state = 'paused';
          if (c.active?.tabId) {
            chrome.tabs.remove(c.active.tabId).catch(() => {});
          }
          if (c.jobs && c.jobs[c.index] && c.jobs[c.index].status === 'working') {
            c.jobs[c.index].status = 'queued';
            c.jobs[c.index].note = 'Tạm dừng khi đang xử lý (sẵn sàng chạy tiếp).';
          }
          c.active = null;
          c.breakNote = 'Tạm dừng theo yêu cầu.';
          try { await chrome.alarms.clear('tick_' + id); } catch (_) {}
          changed = true;
        }
      }
      if (changed) await saveCampaigns(campaigns);
      await maybeStopGlobalAlarm();
      return {ok: true};
    }

    // ── PAUSE_ONE: pause single account campaign ──────────────────────────────
    if (m.type === 'PAUSE_ONE') {
      const {accountId} = m;
      const campaigns = await readCampaigns();
      const c = campaigns[accountId];
      if (c && (c.state === 'running' || c.state === 'waiting')) {
        const wasRunning = c.state === 'running';
        c.state = 'paused';
        if (c.active?.tabId) {
          chrome.tabs.remove(c.active.tabId).catch(() => {});
        }
        if (c.jobs && c.jobs[c.index] && c.jobs[c.index].status === 'working') {
          c.jobs[c.index].status = 'queued';
          c.jobs[c.index].note = 'Tạm dừng khi đang xử lý (sẵn sàng chạy tiếp).';
        }
        c.active = null;
        c.breakNote = 'Tạm dừng theo yêu cầu.';
        try { await chrome.alarms.clear('tick_' + accountId); } catch (_) {}

        // If stopped/paused account was running in coordinated mode, pass turn to next account
        const coord = await readCoordinator();
        if (wasRunning && coord) {
          if (coord.mode === 'round_robin') {
            for (let i = 1; i <= coord.order.length; i++) {
              const candidateIdx = (coord.currentTurn + i) % coord.order.length;
              const candidateId = coord.order[candidateIdx];
              const cand = campaigns[candidateId];
              if (cand && !['done', 'stopped', 'blocked', 'paused'].includes(cand.state) && cand.index < cand.jobs.length) {
                cand.state = 'running';
                cand.nextAt = Date.now() + 2000;
                coord.currentTurn = candidateIdx;
                await saveCoordinator(coord);
                await scheduleAccountTick(candidateId, cand.nextAt);
                break;
              }
            }
          } else if (coord.mode === 'sequential') {
            for (let i = coord.currentIndex + 1; i < coord.order.length; i++) {
              const candidateId = coord.order[i];
              const cand = campaigns[candidateId];
              if (cand && !['done', 'stopped', 'blocked', 'paused'].includes(cand.state) && cand.index < cand.jobs.length) {
                cand.state = 'running';
                cand.nextAt = Date.now() + 2000;
                coord.currentIndex = i;
                await saveCoordinator(coord);
                await scheduleAccountTick(candidateId, cand.nextAt);
                break;
              }
            }
          }
        }

        await saveCampaigns(campaigns);
        await maybeStopGlobalAlarm();
      }
      return {ok: true};
    }

    // ── RESUME_ONE: resume single account from exact paused group ─────────────
    if (m.type === 'RESUME_ONE') {
      const {accountId} = m;
      const campaigns = await readCampaigns();
      const c = campaigns[accountId];
      if (!c) throw new Error('Chiến dịch không tồn tại.');
      if (c.state !== 'paused' && c.state !== 'stopped') throw new Error('Chiến dịch không ở trạng thái tạm dừng hoặc đã dừng.');

      const bannedViolations = findBannedWords(c.text);
      if (bannedViolations.length > 0) {
        const uniqueBanned = [...new Set(bannedViolations.map(b => b.word))];
        throw new Error(`Nội dung chứa từ cấm vi phạm chính sách Facebook: ${uniqueBanned.join(', ')}. Hãy xóa các từ này trước khi tiếp tục!`);
      }

      if (c.enableDailyLimit !== false) {
        const todayCount = await getDailyCount(accountId);
        const limit = c.dailyLimit || 20;
        if (todayCount >= limit) {
          throw new Error(`Tài khoản "${c.accountName || accountId}" đã đạt giới hạn ${limit} bài group hôm nay (${todayCount}/${limit}).`);
        }
      }

      if (c.index >= c.jobs.length) {
        c.state = 'done';
        await saveCampaigns(campaigns);
        return {ok: true};
      }

      if (c.jobs[c.index]?.status === 'working') {
        c.jobs[c.index].status = 'queued';
      }

      c.state = 'running';
      c.active = null;
      c.breakNote = null;
      c.nextAt = Date.now() + 1000;

      let coord = await readCoordinator();
      if (!coord) {
        const order = c.accountOrder || 'round_robin';
        if (order === 'round_robin') {
          coord = { mode: 'round_robin', order: [accountId], currentTurn: 0 };
          await saveCoordinator(coord);
        } else if (order === 'sequential') {
          coord = { mode: 'sequential', order: [accountId], currentIndex: 0 };
          await saveCoordinator(coord);
        }
      } else {
        if (coord.mode === 'round_robin') {
          const idx = coord.order.indexOf(accountId);
          if (idx >= 0) coord.currentTurn = idx;
          await saveCoordinator(coord);
        } else if (coord.mode === 'sequential') {
          const idx = coord.order.indexOf(accountId);
          if (idx >= 0) coord.currentIndex = idx;
          await saveCoordinator(coord);
        }
      }

      await saveCampaigns(campaigns);
      await scheduleAccountTick(accountId, c.nextAt);
      return {ok: true};
    }

    // ── RESUME_ALL: resume all paused campaigns from exact paused point ───────
    if (m.type === 'RESUME_ALL') {
      const campaigns = await readCampaigns();
      let resumedAccounts = [];
      const targetIds = m.accountIds || m.data?.targetAccountIds || null;

      for (const [id, c] of Object.entries(campaigns)) {
        if (targetIds && !targetIds.includes(id)) continue;
        if ((c.state === 'paused' || c.state === 'stopped') && c.index < c.jobs.length) {
          const bannedViolations = findBannedWords(c.text);
          if (bannedViolations.length > 0) {
            const uniqueBanned = [...new Set(bannedViolations.map(b => b.word))];
            throw new Error(`Chiến dịch của "${c.accountName || id}" chứa từ cấm vi phạm chính sách: ${uniqueBanned.join(', ')}. Hãy chỉnh sửa lại bài viết trước khi tiếp tục!`);
          }

          if (c.enableDailyLimit !== false) {
            const todayCount = await getDailyCount(id);
            const limit = c.dailyLimit || 20;
            if (todayCount >= limit) {
              c.state = 'done';
              c.breakNote = `🛑 Đã đăng ${todayCount}/${limit} bài hôm nay (Đạt giới hạn ngày).`;
              continue;
            }
          }
          c.active = null;
          c.breakNote = null;
          if (c.jobs[c.index]?.status === 'working') {
            c.jobs[c.index].status = 'queued';
          }
          resumedAccounts.push(id);
        }
      }

      if (!resumedAccounts.length) throw new Error('Không có tài khoản nào có nhóm chưa hoàn tất để tiếp tục.');

      let coord = await readCoordinator();
      if (!coord && resumedAccounts.length > 0) {
        const firstCamp = campaigns[resumedAccounts[0]];
        const order = firstCamp?.accountOrder || 'round_robin';
        if (order === 'round_robin') {
          coord = { mode: 'round_robin', order: resumedAccounts, currentTurn: 0 };
          await saveCoordinator(coord);
        } else if (order === 'sequential') {
          coord = { mode: 'sequential', order: resumedAccounts, currentIndex: 0 };
          await saveCoordinator(coord);
        }
      }

      if (coord?.mode === 'round_robin') {
        let firstTurn = -1;
        let firstId = null;
        for (let i = 0; i < coord.order.length; i++) {
          const candId = coord.order[(coord.currentTurn + i) % coord.order.length];
          const cand = campaigns[candId];
          if (cand && (cand.state === 'paused' || cand.state === 'stopped') && cand.index < cand.jobs.length) {
            firstId = candId;
            firstTurn = (coord.currentTurn + i) % coord.order.length;
            break;
          }
        }
        if (!firstId && resumedAccounts.length) {
          firstId = resumedAccounts[0];
          firstTurn = Math.max(0, coord.order.indexOf(firstId));
        }

        for (const id of resumedAccounts) {
          if (id === firstId) {
            campaigns[id].state = 'running';
            campaigns[id].nextAt = Date.now() + 1000;
          } else {
            campaigns[id].state = 'waiting';
          }
        }
        coord.currentTurn = firstTurn >= 0 ? firstTurn : 0;
        await saveCoordinator(coord);
        await saveCampaigns(campaigns);
        await scheduleAccountTick(firstId, campaigns[firstId].nextAt);

      } else if (coord?.mode === 'sequential') {
        let firstIdx = -1;
        let firstId = null;
        for (let i = 0; i < coord.order.length; i++) {
          const candId = coord.order[i];
          const cand = campaigns[candId];
          if (cand && (cand.state === 'paused' || cand.state === 'stopped') && cand.index < cand.jobs.length) {
            firstId = candId;
            firstIdx = i;
            break;
          }
        }
        if (!firstId && resumedAccounts.length) {
          firstId = resumedAccounts[0];
          firstIdx = Math.max(0, coord.order.indexOf(firstId));
        }

        for (const id of resumedAccounts) {
          if (id === firstId) {
            campaigns[id].state = 'running';
            campaigns[id].nextAt = Date.now() + 1000;
          } else {
            campaigns[id].state = 'waiting';
          }
        }
        coord.currentIndex = firstIdx >= 0 ? firstIdx : 0;
        await saveCoordinator(coord);
        await saveCampaigns(campaigns);
        await scheduleAccountTick(firstId, campaigns[firstId].nextAt);

      } else {
        // Parallel mode: resume all simultaneously with small stagger
        let delay = 1000;
        for (const id of resumedAccounts) {
          campaigns[id].state = 'running';
          campaigns[id].nextAt = Date.now() + delay;
          delay += 3000;
        }
        await saveCampaigns(campaigns);
        for (const id of resumedAccounts) {
          await scheduleAccountTick(id, campaigns[id].nextAt);
        }
      }

      return {ok: true};
    }

    // ── NEXT: skip current group for one account ──────────────────────────────
    if (m.type === 'NEXT') {
      const {accountId} = m;
      const campaigns = await readCampaigns();
      const c = campaigns[accountId];
      if (!c || (c.state !== 'paused' && c.state !== 'stopped')) throw new Error('Chiến dịch không đang tạm dừng.');
      if (c.index < c.jobs.length) {
        if (!['preview', 'pending', 'submitted'].includes(c.jobs[c.index].status))
          c.jobs[c.index].status = 'skipped';
        c.index++;
      }
      c.active = null;
      c.breakNote = null;
      await saveCampaigns(campaigns);

      await advanceCampaign(accountId, { isSkipped: true });
      await chrome.alarms.create('queue', {periodInMinutes: 0.5});
      return {ok: true};
    }

    // ── RESULT: result from content script ───────────────────────────────────
    if (m.type === 'RESULT') {
      const {accountId} = m;

      // Tự động làm mới và đồng bộ lại cookie của tài khoản vừa chạy
      if (accountId) {
        triggerDebouncedCookieSync(accountId, 800);
      }

      const campaigns = await readCampaigns();
      const c = campaigns[accountId];
      if (!c || c.state !== 'running') return {ok: true};
      const isTabMatch = !sender?.tab?.id || !c.active?.tabId || sender.tab.id === c.active.tabId;
      if (!isTabMatch || m.token !== c.active?.token) return {ok: true};

      // Automatically close Facebook tab in auto mode after 2s
      const closeTabId = sender?.tab?.id || c.active?.tabId;
      if (c.mode === 'auto' && closeTabId) {
        setTimeout(() => chrome.tabs.remove(closeTabId).catch(() => {}), 2000);
      }

      const allowed = ['preview', 'submitted', 'pending', 'sent_unverified', 'unknown', 'blocked', 'error', 'skipped'];
      const status = allowed.includes(m.status) ? m.status : 'unknown';
      c.jobs[c.index].status = status;
      c.jobs[c.index].note = String(m.note || '').slice(0, 500);
      c.jobs[c.index].doneAt = Date.now();
      if (m.postUrl) {
        c.jobs[c.index].postUrl = String(m.postUrl).trim();
      } else if (['submitted', 'sent_unverified', 'pending', 'preview'].includes(status) && c.jobs[c.index]?.url) {
        c.jobs[c.index].postUrl = `${c.jobs[c.index].url.replace(/\/+$/, '')}/your_posts/`;
      }

      if (['submitted', 'sent_unverified', 'pending', 'preview'].includes(status) && c.jobs[c.index]?.url) {
        recordPostedGroupUrl(c.jobs[c.index].url).catch(() => {});
      }

      if (status === 'blocked') {
        const groupUrl = c.jobs[c.index]?.url;
        if (c.autoSkipOnError !== false) {
          // Tự động bỏ qua nhóm bị hạn chế này và chạy nhóm kế tiếp
          c.jobs[c.index].status = 'blocked';
          c.jobs[c.index].note = '🛑 Nhóm bị hạn chế/cảnh báo. Đã tự động bỏ qua để chuyển nhóm tiếp theo.';
          c.jobs[c.index].doneAt = Date.now();

          sendFacebookZaloNotify({
            kind: 'blocked',
            accountName: c.accountName || accountId,
            accountType: c.accountType,
            groupUrl,
            note: m.note || 'Facebook cảnh báo spam / thao tác quá nhanh. Hệ thống đã tự động bỏ qua nhóm để tiếp tục.',
            postedCount: c.postedCount || 0,
            totalJobs: c.jobs?.length || 0
          }).catch(() => {});
        } else {
          c.state = 'paused';
          c.active = null;
          c.breakNote = '🛑 Đã tạm dừng do Facebook cảnh báo spam/hạn chế tính năng.';
          await saveCampaigns(campaigns);
          await maybeStopGlobalAlarm();

          sendFacebookZaloNotify({
            kind: 'blocked',
            accountName: c.accountName || accountId,
            accountType: c.accountType,
            groupUrl,
            note: m.note || 'Facebook cảnh báo spam hoặc hạn chế tính năng! Chiến dịch đã tạm dừng để bảo vệ tài khoản.',
            postedCount: c.postedCount || 0,
            totalJobs: c.jobs?.length || 0
          }).catch(() => {});

          return {ok: true};
        }
      }

      if (status === 'preview') {
        c.state = 'paused';
        c.breakNote = 'Đã điền bài (Chế độ xem trước). Kiểm tra tab Facebook.';
        await saveCampaigns(campaigns);
        return {ok: true};
      }

      if ((status === 'error' || status === 'unknown') && c.autoSkipOnError === false) {
        c.state = 'paused';
        c.active = null;
        c.breakNote = 'Tạm dừng do nhóm bị lỗi (Bỏ chọn Tự động bỏ qua). Bấm Tiếp tục để chạy lại.';
        await saveCampaigns(campaigns);

        sendFacebookZaloNotify({
          kind: 'error',
          accountName: c.accountName || accountId,
          accountType: c.accountType,
          groupUrl: c.jobs[c.index]?.url,
          note: m.note || 'Đăng bài vào nhóm thất bại. Chiến dịch đã tạm dừng do tắt Tự động bỏ qua lỗi.',
          postedCount: c.postedCount || 0,
          totalJobs: c.jobs?.length || 0
        }).catch(() => {});

        return {ok: true};
      }

      const isSkipped = status === 'skipped';
      const isError = status === 'error' || status === 'unknown' || status === 'blocked';

      if (!isSkipped && !isError) {
        c.consecutiveErrors = 0;
      } else if (isError) {
        c.consecutiveErrors = (c.consecutiveErrors || 0) + 1;
        if (c.consecutiveErrors >= 5) {
          c.state = 'paused';
          c.active = null;
          c.breakNote = '🛑 Đã tự động tạm dừng sau 5 lỗi liên tiếp để bảo vệ tài khoản Facebook.';
          c.index++;
          await saveCampaigns(campaigns);
          await maybeStopGlobalAlarm();

          sendFacebookZaloNotify({
            kind: 'error',
            accountName: c.accountName || accountId,
            accountType: c.accountType,
            groupUrl: c.jobs[c.index - 1]?.url,
            note: 'Chiến dịch gặp 5 lỗi liên tiếp (có thể do mất mạng hoặc tài khoản bị hạn chế). Hệ thống đã tự động tạm dừng để bảo vệ nick.',
            postedCount: c.postedCount || 0,
            totalJobs: c.jobs?.length || 0
          }).catch(() => {});

          return {ok: true};
        }
      }

      c.index++;
      c.active = null;
      let hitDailyLimit = false;
      let dailyCount = 0;
      if (!isSkipped && !isError) {
        c.postedCount = (c.postedCount || 0) + 1;
        if (c.enableDailyLimit !== false) {
          const limit = c.dailyLimit || 20;
          dailyCount = await incrementDailyCount(accountId);
          if (dailyCount >= limit) {
            hitDailyLimit = true;
          }
        }
      }
      await saveCampaigns(campaigns);

      await advanceCampaign(accountId, {
        isError,
        isSkipped,
        hitDailyLimit,
        note: hitDailyLimit ? `🎉 Đã đạt giới hạn ${c.dailyLimit || 20} bài group hôm nay (${dailyCount}/${c.dailyLimit || 20}). Tự động dừng để bảo vệ tài khoản.` : null
      });

      return {ok: true};
    }

    throw new Error('Lệnh không hợp lệ.');
  };

  run().then(r => reply(r || {ok: true}), e => reply({ok: false, error: e.message}));
  return true;
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

// ── External sync & execution listener (allows Web Platform to control Extension Runner) ──
chrome.runtime.onMessageExternal?.addListener((request, sender, sendResponse) => {
  // 1. PING kiểm tra trạng thái Extension Runner từ Web Platform
  if (request?.type === 'PING') {
    sendResponse({
      ok: true,
      version: '0.4.4',
      syncVersion: 2,
      capabilities: ['GROUP_SEARCH', 'MAPS_SYNC_V2', 'FB_GROUP_SYNC_V2'],
      extensionId: chrome.runtime?.id || 'affaocloanjmkpcinmkcbmekgipnddnm'
    });
    return false;
  }

  // 2. GET_STATE: Đồng bộ trạng thái chiến dịch thời gian thực cho Web Platform
  if (request?.type === 'GET_STATE' || request?.type === 'GET_CAMPAIGNS') {
    (async () => {
      try {
        const campaigns = await readCampaigns();
        const coordinator = (await chrome.storage.local.get('coordinator')).coordinator || null;
        const dailyPostStats = (await chrome.storage.local.get('dailyPostStats')).dailyPostStats || {};
        sendResponse({ ok: true, campaigns, coordinator, dailyPostStats });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 3. STOP_ALL: Dừng tất cả chiến dịch ngay lập tức từ Web Platform
  if (request?.type === 'STOP_ALL') {
    (async () => {
      try {
        const campaigns = await readCampaigns();
        for (const [id, c] of Object.entries(campaigns)) {
          if (c.active?.tabId) {
            try { await chrome.tabs.remove(c.active.tabId); } catch (_) {}
          }
          c.state = 'stopped';
          c.active = null;
          c.breakNote = 'Đã dừng tất cả từ Web.';
          try { await chrome.alarms.clear('tick_' + id); } catch (_) {}
        }
        await chrome.storage.local.remove('coordinator');
        currentSessionAccountId = null;
        try { await chrome.alarms.clear('queue'); } catch (_) {}
        const allAlarms = (await chrome.alarms.getAll?.().catch(() => [])) || [];
        for (const al of allAlarms) {
          if (al.name?.startsWith('tick_')) {
            try { await chrome.alarms.clear(al.name); } catch (_) {}
          }
        }
        updateKeepAwake(false);
        await chrome.storage.local.remove('campaigns');
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 4. STOP_ONE: Dừng 1 tài khoản cụ thể từ Web Platform
  if (request?.type === 'STOP_ONE') {
    (async () => {
      try {
        const campaigns = await readCampaigns();
        const c = campaigns[request.accountId];
        if (c) {
          if (c.active?.tabId) {
            try { await chrome.tabs.remove(c.active.tabId); } catch (_) {}
          }
          c.state = 'stopped';
          c.active = null;
          c.breakNote = 'Đã dừng từ Web.';
          await saveCampaigns(campaigns);
          try { await chrome.alarms.clear('tick_' + request.accountId); } catch (_) {}
        }
        await maybeStopGlobalAlarm();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 5. Đồng bộ dữ liệu (tài khoản, nhóm, bản nháp, bản quyền) từ Web sang Extension storage
  if (request?.type === 'SYNC_DATA_TO_EXTENSION') {
    (async () => {
      try {
        if (request.data && typeof request.data === 'object') {
          await chrome.storage.local.set(request.data);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 3. GET_DATA_FOR_MIGRATION
  if (request?.action === 'GET_DATA_FOR_MIGRATION') {
    (async () => {
      try {
        const data = await chrome.storage.local.get([
          'accounts',
          'groupCategories',
          'draft',
          'license',
          'machineId',
          'campaigns'
        ]);
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // 4. Cho phép chạy toàn bộ tác vụ đăng bài, chiến dịch, maps trực tiếp từ Web Platform
  const fakeSender = { id: chrome.runtime.id, isExternal: true, origin: sender.origin, tab: sender.tab };
  return handleRuntimeMessage(request, fakeSender, sendResponse);
});
