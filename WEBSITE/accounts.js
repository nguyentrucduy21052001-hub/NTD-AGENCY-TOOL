// accounts.js – Quản lý nhiều tài khoản Facebook
import { enforceLicenseGate } from './license.js';
await enforceLicenseGate();
import { initSyncModal, exportJsonBackup, parseJsonFile, applyRestoredData } from './sync_helper.js';
import {
  getTodayDateStr,
  parseUniversalCookies,
  cookiesObjToStr,
  activateAccountSessionDirectly,
  fetchTokenEAAG,
  fetchTokenEAAB,
  fetchProfileByToken,
  fetchFanpagesByToken,
  convertTokenToCookies,
  parseTokenOrCookieInput,
  parseViaString,
  generate2FACode,
  injectCookies
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

// ── Load / Save accounts ──────────────────────────────────────────────────────
async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts || [];
}
async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

// ── Kích hoạt session đăng nhập Facebook (có fallback trực tiếp) ─────────────
async function activateSessionWithFallback(accountId, openFacebookTab = true) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ACTIVATE_ACCOUNT_SESSION',
      accountId,
      openFacebookTab
    });
    if (res && res.ok) return res;
    // Nếu worker chưa reload (trả về lỗi 'Lệnh không hợp lệ') hoặc lỗi bất kỳ, fallback nạp trực tiếp từ tab
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
  const isTruncatedXs = !xsVal.includes('%3A%3A') && !xsVal.includes('::') && (xsVal.endsWith('-1') || xsVal.split(/%3A|:/).length < 6);

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

// ── Add account via PASSWORD ──────────────────────────────────────────────────
$('loginBtn').onclick = async () => {
  const name   = $('accName').value.trim();
  const email  = $('fbEmail').value.trim();
  const pass   = $('fbPass').value;
  const twoFactor = $('fb2FA')?.value?.trim() || null;
  const groups = $('accGroups')?.value?.trim() || '';

  if (!name)  { msg('Hãy nhập tên hiển thị.', 'err'); return; }
  if (!email) { msg('Hãy nhập email / số điện thoại.', 'err'); return; }
  if (!pass)  { msg('Hãy nhập mật khẩu.', 'err'); return; }
  if (groups) {
    try { validateGroups(groups); } catch(e) { msg(e.message, 'err'); return; }
  }

  // Check duplicate email
  const accounts = await loadAccounts();
  if (accounts.some(a => a.email === email)) {
    msg('Email này đã được thêm rồi.', 'err'); return;
  }

  // Show progress
  $('loginProgress').classList.add('show');
  $('loginBtn').disabled = true;
  $('msg').textContent = '';
  ['step1','step2','step3','step4','step5'].forEach(s => setStep(s, 'wait'));
  const el2fa = $('step_2fa');
  if (el2fa) { el2fa.style.display = 'none'; el2fa.className = 'step-wait'; }

  setStep('step1', 'active');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'DO_LOGIN',
      email,
      password: pass,
      twoFactor,
      keepSession: true
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Đăng nhập thất bại.');
    }

    ['step1','step2','step3','step4'].forEach(s => setStep(s, 'done'));
    if (el2fa && el2fa.style.display !== 'none') el2fa.className = 'step-done';
    setStep('step5', 'active');

    // Save account (lưu cả mật khẩu & 2FA để tự động đăng nhập lại khi Facebook bị đăng xuất)
    accounts.push({
      id: crypto.randomUUID(),
      name,
      email,
      password: pass,
      twoFactor: twoFactor || null,
      cookies: result.cookies,
      token: result.token || null,
      groups,
      addedVia: twoFactor ? 'via' : 'password',
      fbId: result.cUser || '',
      lastCookieSync: Date.now()
    });
    await saveAccounts(accounts);

    setStep('step5', 'done');
    $('progressTitle').textContent = '✅ Thêm tài khoản thành công!';

    // Clear form
    $('accName').value = '';
    $('fbEmail').value = '';
    $('fbPass').value  = '';
    if ($('accGroups')) $('accGroups').value = '';

    msg(`✅ Đã thêm tài khoản "${name}" (FB ID: ${result.cUser})`);
    setTimeout(() => {
      $('loginProgress').classList.remove('show');
      $('progressTitle').textContent = 'Đang đăng nhập…';
      ['step1','step2','step3','step4','step5'].forEach(s => setStep(s, 'wait'));
      if (el2fa) { el2fa.style.display = 'none'; el2fa.className = 'step-wait'; }
    }, 3000);

    render();
  } catch (e) {
    $('loginProgress').classList.remove('show');
    msg('❌ ' + e.message, 'err');
  } finally {
    $('loginBtn').disabled = false;
  }
};

$('clearPassFormBtn').onclick = () => {
  $('fbEmail').value = '';
  $('fbPass').value  = '';
  if ($('accGroups')) $('accGroups').value = '';
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
      const allCookies = (await chrome.cookies.getAll({})).filter(c =>
        c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
      );
      const cookieMap = new Map();
      for (const ck of allCookies) {
        if (!cookieMap.has(ck.name) || ck.domain.startsWith('.')) {
          cookieMap.set(ck.name, ck);
        }
      }
      const cUser = cookieMap.get('c_user')?.value;
      if (!cUser) {
        msg('Chưa tìm thấy phiên đăng nhập Facebook trên Chrome. Hãy mở tab facebook.com đăng nhập nick trước!', 'err');
        return;
      }

      const cookieStr = [...cookieMap.values()].map(c => `${c.name}=${c.value}`).join('; ');

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
      const hasSb = Boolean(parsed.cookieObj['sb']);
      const hasXs = Boolean(parsed.cookieObj['xs']);
      const ckStatus = (hasSb && hasXs)
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

    const hasLiveCookies = Boolean(cookieObj['c_user'] && cookieObj['xs']);

    // 2. Chỉ tự động đăng nhập bằng Pass + 2FA khi chuỗi VIA CHƯA có sẵn cookies hợp lệ
    if (password && (cUser || parsed.email) && !hasLiveCookies) {
      msg(`⏳ VIA chưa có Cookies sẵn. Đang tự động đăng nhập Facebook bằng mật khẩu & 2FA để lấy cookies...`);
      addBtn.textContent = '⏳ Đang đăng nhập Facebook...';

      try {
        const loginRes = await chrome.runtime.sendMessage({
          type: 'DO_LOGIN',
          email: cUser || parsed.email,
          password: password,
          twoFactor: twoFactor,
          keepSession: autoLogin
        });

        if (loginRes?.ok) {
          finalCookieStr = loginRes.cookies;
          cookieObj = parseUniversalCookies(finalCookieStr);
          cUser = loginRes.cUser || cUser;
          if (loginRes.token) token = loginRes.token;
        } else {
          console.warn('[AddVIA] Auto login không thành công, tiếp tục lưu dữ liệu VIA:', loginRes?.error);
        }
      } catch (loginErr) {
        console.warn('[AddVIA] Lỗi gọi DO_LOGIN:', loginErr);
      }
    }

    if (!name) name = `Nick FB (${cUser || 'Mới'})`;

    const accounts = await loadAccounts();
    // Kiểm tra xem tài khoản này đã có trong danh sách chưa (chỉ khớp đúng FB UID duy nhất)
    const existingIdx = accounts.findIndex(a => {
      if (cUser && a.fbId && String(a.fbId).trim() === String(cUser).trim()) return true;
      if (parsed.email && a.email && a.email.toLowerCase() === parsed.email.toLowerCase()) return true;
      return false;
    });

    let accId;
    if (existingIdx >= 0) {
      accounts[existingIdx].name = name;
      if (finalCookieStr) accounts[existingIdx].cookies = finalCookieStr;
      if (token) accounts[existingIdx].token = token;
      if (password) accounts[existingIdx].password = password;
      if (twoFactor) accounts[existingIdx].twoFactor = twoFactor;
      if (cUser) accounts[existingIdx].fbId = cUser;
      if (cUser || parsed.email) accounts[existingIdx].email = cUser || parsed.email || accounts[existingIdx].email;
      accounts[existingIdx].lastCookieSync = Date.now();
      if (groups) accounts[existingIdx].groups = groups;
      accId = accounts[existingIdx].id;
      await saveAccounts(accounts);
      msg(`🔄 Đã cập nhật tài khoản "${name}" (FB ID: ${cUser || 'N/A'})!`);
    } else {
      accId = crypto.randomUUID();
      accounts.push({
        id: accId,
        name,
        email: cUser || parsed.email || '',
        password: password,
        twoFactor: twoFactor,
        cookies: finalCookieStr || '',
        token: token || null,
        groups,
        addedVia: (password && twoFactor) ? 'via' : (token ? 'token' : 'cookies'),
        fbId: cUser || '',
        lastCookieSync: Date.now()
      });
      await saveAccounts(accounts);
    }

    // 3. Tự động nạp cookies và đăng nhập Facebook trên Chrome nếu được chọn
    if (autoLogin) {
      if (finalCookieStr) {
        msg(`⏳ Đang nạp phiên đăng nhập Facebook cho "${name}"...`);
        const res = await activateSessionWithFallback(accId, true);
        if (res?.ok) {
          msg(`✅ Đã nạp và tự động đăng nhập Facebook thành công cho "${name}" (FB ID: ${res.cUser || cUser})!`);
        } else {
          msg(`✅ Đã lưu tài khoản "${name}" (FB ID: ${cUser || 'N/A'})!`);
        }
      } else {
        msg(`✅ Đã thêm tài khoản "${name}" (FB ID: ${cUser || 'N/A'}) thành công!`);
      }
    } else {
      msg(`✅ Đã thêm tài khoản "${name}" (FB ID: ${cUser || 'N/A'}) thành công!`);
    }

    $('accName').value = '';
    $('accCookies').value = '';
    if ($('accGroups')) $('accGroups').value = '';
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
  if ($('accGroups')) $('accGroups').value  = '';
  $('msg').textContent  = '';
  if ($('tokenBadge')) $('tokenBadge').style.display = 'none';
  if ($('tokenInfoBox')) $('tokenInfoBox').style.display = 'none';
};

// ── Render account list (Chỉ tài khoản cá nhân / VIA) ─────────────────────────
async function render() {
  const accounts = await loadAccounts();
  const personalAccounts = accounts.filter(a => a.type !== 'fanpage');

  const { campaigns, groupCategories, dailyPostStats } = await chrome.storage.local.get(['campaigns', 'groupCategories', 'dailyPostStats']);
  const cats = groupCategories || [];
  const statsMap = dailyPostStats || {};
  const todayStr = getTodayDateStr();

  if ($('countBadge')) {
    $('countBadge').textContent = `${personalAccounts.length} tài khoản cá nhân`;
  }

  const list = $('accList');
  if (!list) return;
  list.replaceChildren();

  if (!personalAccounts.length) {
    list.innerHTML = `<div class="empty-state"><p>Chưa có tài khoản Facebook cá nhân nào. Hãy thêm tài khoản đầu tiên!</p></div>`;
    return;
  }

  for (const acc of personalAccounts) {
    const campaign = campaigns?.[acc.id];
    const isRunning = campaign?.state === 'running';
    const cUser = parseCookiesStr(acc.cookies || '')['c_user'];

    let statusBadge = `<span class="badge badge-ok" title="Đang tự động đồng bộ cookie theo thời gian thực">Cookie OK · Tự động đồng bộ</span>`;
    if (!cUser) statusBadge = `<span class="badge badge-warn">Cookies lỗi</span>`;
    if (isRunning) statusBadge += `<span class="badge badge-run">Đang chạy</span>`;

    if (acc.addedVia === 'via' || (acc.password && acc.twoFactor)) {
      statusBadge += ` <span class="badge" style="background:#fff4ed;color:#ea580c;border:1px solid #fdba74">VIA (Pass+2FA)</span>`;
    } else if (acc.addedVia === 'password') {
      statusBadge += ` <span class="badge badge-pass">Mật khẩu</span>`;
    } else if (acc.token) {
      statusBadge += ` <span class="badge" style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe">Token</span>`;
    } else {
      statusBadge += ` <span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1">Cookies</span>`;
    }

    const groupLines = acc.groups?.trim().split('\n').filter(Boolean) || [];
    const groupInfo  = groupLines.length ? `${groupLines.length} nhóm riêng` : `<span style="color:#059669;font-weight:600">Dùng chung nhóm</span>`;

    const emailInfo = acc.email ? ` · ${acc.email}` : '';
    const syncTimeInfo = acc.lastCookieSync
      ? ` &nbsp;·&nbsp; <span style="color:#059669;font-weight:600">Tự động cập nhật: ${new Date(acc.lastCookieSync).toLocaleTimeString('vi-VN', {hour12:false})}</span>`
      : ` &nbsp;·&nbsp; <span style="color:#059669">Tự động đồng bộ</span>`;

    const todayRecord = statsMap[acc.id];
    const todayCount = (todayRecord && todayRecord.date === todayStr) ? (Number(todayRecord.count) || 0) : 0;
    const maxDaily = 20;
    const dailyInfo = ` &nbsp;·&nbsp; Hôm nay: <b style="color:${todayCount >= maxDaily ? '#dc2626' : '#059669'}">${todayCount}/${maxDaily} bài</b> (Tối đa ${maxDaily} bài/ngày)`;

    const card = document.createElement('div');
    card.className = 'acc-card';
    card.id = `card_${acc.id}`;
    card.innerHTML = `
      <div>
        <div class="acc-name">${acc.name} ${statusBadge}</div>
        <div class="acc-meta">
          FB ID: <code class="acc-id-code">${cUser || '???'}</code>${emailInfo}${syncTimeInfo}
          &nbsp;·&nbsp; Nhóm: ${groupInfo}
          ${dailyInfo}
        </div>
        ${groupLines.length ? `<div class="acc-groups" title="Danh sách nhóm riêng">${groupLines.join('\n')}</div>` : ''}
      </div>
      <div class="acc-actions" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary login-fb-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="font-size:11px;padding:4px 10px;font-weight:700" title="Chuyển trình duyệt sang đăng nhập tài khoản này và mở Facebook">Đăng nhập FB</button>
        <button type="button" class="btn btn-light refresh-cookie-btn" data-id="${acc.id}" title="Lấy cookie mới nhất từ tab Facebook đang mở trên Chrome và lưu vào nick này" style="font-size:11px;padding:4px 8px;border:1px solid #059669;color:#059669;font-weight:700">Đồng bộ cookie</button>
        ${todayCount > 0 ? `<button type="button" class="btn btn-light reset-daily-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="font-size:11px;padding:4px 8px;border:1px solid #d97706;color:#d97706;font-weight:700" title="Đặt lại số bài đã đăng hôm nay của tài khoản này về 0">Đặt lại (${todayCount})</button>` : ''}
        <button class="icon-btn edit-btn" data-id="${acc.id}" title="Chỉnh sửa danh sách nhóm &amp; thông tin">✏️</button>
        <button class="icon-btn del" data-id="${acc.id}" title="Xóa tài khoản này">🗑</button>
      </div>
      <div class="acc-edit-box" id="editBox_${acc.id}" style="display:none">
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Tên hiển thị:</span>
          <input type="text" class="edit-name" value="${acc.name.replace(/"/g, '&quot;')}" style="margin-top:4px">
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
      acc.groups = newGroups;
      await saveAccounts(accs);

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

        // 1. Thử kích hoạt phiên
        const res = await activateSessionWithFallback(id, true);
        if (res?.ok) {
          msg(`✅ Đã chuyển đổi Facebook sang tài khoản "${name}" (FB ID: ${res.cUser})!`);
        } else if (acc?.password && (acc?.email || acc?.fbId)) {
          // 2. Nếu cookies hết hạn và có Mật khẩu -> Tự động đăng nhập lại bằng Pass + 2FA
          msg(`⏳ Cookies của "${name}" đã hết hạn. Đang tự động đăng nhập lại bằng mật khẩu & 2FA...`);
          const loginRes = await chrome.runtime.sendMessage({
            type: 'DO_LOGIN',
            email: acc.email || acc.fbId,
            password: acc.password,
            twoFactor: acc.twoFactor || null,
            existingAccountId: acc.id,
            openFacebookTab: true,
            keepSession: true
          });
          if (loginRes?.ok) {
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

  // Delete Account
  list.querySelectorAll('.icon-btn.del').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const accs = await loadAccounts();
      const acc = accs.find(a => a.id === id);
      if (!acc || !confirm(`Xóa tài khoản "${acc.name}"?`)) return;
      await saveAccounts(accs.filter(a => a.id !== id));
      const { campaigns } = await chrome.storage.local.get('campaigns');
      if (campaigns?.[id]) { delete campaigns[id]; await chrome.storage.local.set({ campaigns }); }
      msg('Đã xóa tài khoản.');
      render();
    };
  });
}

// ── Init (Tối ưu hiệu năng: Debounce & Lọc sự kiện thay đổi liên quan) ────────
render();

let _accRenderDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.dailyPostStats || changes.campaigns)) {
    if (_accRenderDebounce) clearTimeout(_accRenderDebounce);
    _accRenderDebounce = setTimeout(render, 150);
  }
});

// Tự động quét và đồng bộ cookie ngay khi mở trang
chrome.runtime.sendMessage({ type: 'SYNC_COOKIES_NOW' }).catch(() => {});

// Nút Quét & Đồng bộ ngay trên banner
const forceSyncBtn = $('forceSyncAllBtn');
if (forceSyncBtn) {
  forceSyncBtn.onclick = async () => {
    forceSyncBtn.disabled = true;
    forceSyncBtn.textContent = '⏳ Đang quét...';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SYNC_COOKIES_NOW' });
      if (res?.ok) {
        msg('✅ Đã quét và tự động cập nhật cookie thành công!', 'ok');
        render();
      } else {
        msg('Chưa tìm thấy phiên Facebook đang đăng nhập trên Chrome: ' + (res?.reason || res?.error || ''), 'err');
      }
    } catch (e) {
      msg('Lỗi đồng bộ: ' + e.message, 'err');
    } finally {
      forceSyncBtn.disabled = false;
      forceSyncBtn.textContent = '🔄 Quét & Đồng bộ ngay';
    }
  };
}

// Lắng nghe tiến trình đăng nhập thời gian thực và tự động cập nhật cookie từ worker
chrome.runtime.onMessage.addListener(m => {
  if (m?.type === 'COOKIE_AUTO_SYNCED') {
    msg(`⚡ Đã tự động cập nhật cookie mới cho "${m.accountName}" (FB ID: ${m.fbId})!`, 'ok');
    render();
  }
  if (m.type === 'LOGIN_STEP' && m.step) {
    if (m.step === 'step2') { setStep('step1', 'done'); setStep('step2', 'active'); }
    else if (m.step === 'step3') { setStep('step2', 'done'); setStep('step3', 'active'); }
    else if (m.step === 'step4') { setStep('step3', 'done'); setStep('step4', 'active'); }
    else if (m.step === 'step_2fa') {
      const el = $('step_2fa');
      if (el) {
        el.style.display = 'flex';
        el.className = 'step-active';
      }
      $('progressTitle').textContent = '⚠️ Hãy nhập mã 2FA trên tab Facebook vừa mở...';
    }
    else if (m.step === 'step5') {
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

