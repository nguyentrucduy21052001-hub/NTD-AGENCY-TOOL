(()=>{
 if(globalThis.__duyPoster)return;globalThis.__duyPoster=true;

 // Đảm bảo trang luôn được Facebook coi là đang mở trực tiếp (visible & focused)
 // ngay cả khi người dùng chuyển sang cửa sổ Chrome khác hoặc thu nhỏ (minimize) trình duyệt.
 try {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  document.hasFocus = () => true;
  window.hasFocus = () => true;
 } catch (_) {}

 // Tiêm script dự phòng vào DOM trang web (MAIN WORLD) để React Scheduler & Lexical không bị tạm dừng khi Chrome thu nhỏ,
 // đồng thời hook fetch & XMLHttpRequest để bắt trực tiếp permalink bài viết từ phản hồi GraphQL của Facebook
 try {
  const sc = document.createElement('script');
  sc.textContent = `
   try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.hasFocus = () => true;
    window.hasFocus = () => true;
    const stopEvt = e => { if (e) try { e.stopImmediatePropagation(); } catch (_) {} };
    window.addEventListener('visibilitychange', stopEvt, true);
    document.addEventListener('visibilitychange', stopEvt, true);
    window.addEventListener('blur', stopEvt, true);
   } catch (_) {}

   (function() {
    if (window.__ntd_graphql_hooked) return;
    window.__ntd_graphql_hooked = true;

    function checkGraphQLForPostCreated(txt, reqBody, reqUrl) {
     if (!txt || typeof txt !== 'string') return;
     try {
      // BẮT BUỘC: Chỉ kiểm tra nếu đây là mutation tạo bài viết (reject các query tải feed, comment, notification...)
      const isCreateReq = (reqBody && /CometGroupPostCreateMutation|CometGroupPendingPostCreateMutation|ComposerStoryCreateMutation|group_post_create|pending_post_create|CreateGroupPost/i.test(reqBody)) ||
                          (reqUrl && /CometGroupPostCreateMutation|CometGroupPendingPostCreateMutation|ComposerStoryCreateMutation/i.test(reqUrl));
      const isCreateRes = /"group_post_create"|"pending_post_create"|"CometGroupPostCreateMutation"/i.test(txt);

      if (!isCreateReq && !isCreateRes) return;

      const unescaped = txt.replace(/\\u00253A/g, ':').replace(/\\u00252F/g, '/').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      let full = '';
      let isPending = /pending approval|chờ phê duyệt|chờ duyệt|"pending_post_create"|"pending_post"/i.test(unescaped);

      // Ưu tiên 1: Lấy URL từ story hoặc pending_post bên trong mutation kết quả
      const storyMatch = unescaped.match(/"(?:story|pending_post|post)":\s*\{[^}]*?"url":\s*"([^"]+)"/i) ||
                         unescaped.match(/"group_post_create"[^}]+?"url":\s*"([^"]+)"/i) ||
                         unescaped.match(/"url"\s*:\s*"(https?:\/\/[a-z0-9.]*facebook\.com\/groups\/[^"]+\/(?:posts|permalink|pending_posts)\/[^"]+)"/i);

      if (storyMatch && storyMatch[1]) {
       full = storyMatch[1];
      } else {
       const m = unescaped.match(/(https?:\\/\\/[a-z0-9.]*facebook\\.com)?(\\/groups\\/[^/\\"\\'\\s<>]+\\/(?:posts|permalink|pending_posts)\\/[a-zA-Z0-9_.-]+)/i);
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
  `;
  (document.head || document.documentElement).appendChild(sc);
  sc.remove();
 } catch (_) {}

 // Lắng nghe link bài viết được bắt trực tiếp từ GraphQL của Facebook
 let networkCapturedPostUrl = '';
 let networkCapturedIsPending = false;
 try {
  window.addEventListener('__ntd_fb_post_created', (e) => {
   if (e.detail?.url) {
    networkCapturedPostUrl = e.detail.url;
    if (e.detail.isPending) networkCapturedIsPending = true;
   }
  });
 } catch (_) {}

 const seenJobs=new Set();
 const delay=ms=>new Promise(r=>setTimeout(r,ms));

 const visible = e => {
  if (!e || !e.isConnected) return false;
  try {
   if (e.hidden || e.getAttribute('aria-hidden') === 'true') return false;
   if (e.closest('[hidden], [aria-hidden="true"]')) return false;

   const s = getComputedStyle(e);
   if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;

   const rects = e.getClientRects();
   if (rects.length > 0 && (rects[0].width > 0 || rects[0].height > 0)) return true;
   if (e.offsetWidth > 0 || e.offsetHeight > 0 || e.offsetParent !== null) return true;

   // Khi cửa sổ Chrome bị thu nhỏ (minimize) hoặc chạy nền, Chromium không render layout
   // nên offsetWidth / rects có thể bằng 0. Nếu phần tử không bị CSS ẩn thì coi là hiển thị hợp lệ.
   if (typeof e.checkVisibility === 'function') {
    try {
     return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch (_) {}
   }
   return true;
  } catch (_) {
   return false;
  }
 };

 const label = e => {
  if (!e) return '';
  return (
   e.getAttribute('aria-label') ||
   e.placeholder ||
   e.getAttribute('data-placeholder') ||
   e.getAttribute('aria-placeholder') ||
   e.getAttribute('title') ||
   e.innerText ||
   e.textContent ||
   ''
  ).trim();
 };

 const buttons = root => [...root.querySelectorAll('[role="button"],button')].filter(visible);
 const one = (arr, what) => {
  if (!arr || arr.length === 0) throw Error('Không tìm thấy ' + what + '.');
  return arr[0];
 };

 function cleanFacebookPostUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
   let raw = url.trim();
   if (raw.startsWith('/')) {
    raw = 'https://www.facebook.com' + raw;
   }
   const u = new URL(raw);
   if (!u.hostname.includes('facebook.com')) return '';

   // 1. Dạng link nhóm chuẩn: /groups/<name_or_id>/posts/<postId>/ hoặc /permalink/<postId>/
   // Hỗ trợ cả post ID dạng pfbid... (alphanumeric) lẫn dãy số numeric truyền thống
   const m = u.pathname.match(/\/groups\/([^/]+)\/(posts|permalink)\/([a-zA-Z0-9_.-]+)/i);
   if (m) {
    return `https://www.facebook.com/groups/${m[1]}/posts/${m[3]}/`;
   }

   // 2. Dạng query params: /permalink.php?story_fbid=<postId>&id=<groupId>
   const fbid = u.searchParams.get('story_fbid') || u.searchParams.get('fbid') || u.searchParams.get('post_id');
   const gid = u.searchParams.get('id');
   if (fbid && gid) {
    return `https://www.facebook.com/groups/${gid}/posts/${fbid}/`;
   }

   // 3. Dạng bài viết chờ duyệt: /groups/<name_or_id>/pending_posts/<postId>/
   const pMatch = u.pathname.match(/\/groups\/([^/]+)\/pending_posts\/([a-zA-Z0-9_.-]+)/i);
   if (pMatch) {
    return `https://www.facebook.com/groups/${pMatch[1]}/pending_posts/${pMatch[2]}/`;
   }

   // 4. Dạng bài viết của bạn trong nhóm: /groups/<name_or_id>/your_posts/
   const yMatch = u.pathname.match(/\/groups\/([^/]+)\/your_posts/i);
   if (yMatch) {
    return `https://www.facebook.com/groups/${yMatch[1]}/your_posts/`;
   }

   // 5. Dạng bài viết trên user / page: /<id>/posts/<postId>
   const upMatch = u.pathname.match(/\/([a-zA-Z0-9_.-]+)\/posts\/([a-zA-Z0-9_.-]+)/i);
   if (upMatch && !['groups', 'stories', 'watch', 'events', 'marketplace', 'gaming'].includes(upMatch[1].toLowerCase())) {
    return `https://www.facebook.com/${upMatch[1]}/posts/${upMatch[2]}/`;
   }

   // 6. Query param story_fbid độc lập
   if (fbid) {
    return `https://www.facebook.com/permalink.php?story_fbid=${fbid}`;
   }

   // 7. Link bài viết nhóm có chứa /posts/ hoặc /permalink/
   if (u.pathname.includes('/groups/') && (u.pathname.includes('/posts/') || u.pathname.includes('/permalink/'))) {
    u.search = '';
    u.hash = '';
    return u.toString();
   }
   return '';
  } catch (_) {
   return '';
  }
 }

 function extractGroupId(url) {
  if (!url || typeof url !== 'string') return '';
  try {
   const clean = url.trim();
   const m = clean.match(/\/groups\/([^/?#]+)/i);
   if (m && m[1]) return m[1].toLowerCase();
   if (clean.includes('id=')) {
    const u = new URL(clean.startsWith('http') ? clean : 'https://www.facebook.com/' + clean);
    const gid = u.searchParams.get('id');
    if (gid) return gid.toLowerCase();
   }
   if (!clean.includes('/') && !clean.includes('.')) {
    return clean.toLowerCase();
   }
  } catch (_) {}
  return '';
 }

 function isPostUrlMatchingGroup(postUrl, groupUrl) {
  if (!postUrl) return false;
  const targetGid = extractGroupId(groupUrl);
  if (!targetGid) return true;
  const postGid = extractGroupId(postUrl);
  if (postGid && targetGid) {
   return postGid === targetGid;
  }
  return postUrl.toLowerCase().includes('/' + targetGid + '/');
 }

 async function wait(fn, ms = 30000, errorMsg = 'Giao diện Facebook chưa sẵn sàng hoặc đã thay đổi.') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
   const v = fn();
   if (v) return v;
   await delay(400);
  }
  throw Error(errorMsg);
 }

 async function check(job) {
  const r = await chrome.runtime.sendMessage({type: 'CHECK', token: job.token, accountId: job.accountId});
  if (!r?.ok) throw Error('Chiến dịch đã dừng.');
  const normalize = u => (u || '').replace(/\/+$/, '').toLowerCase();
  const currentUrl = normalize(location.origin + location.pathname);
  const targetUrl = normalize(job.url);
  if (currentUrl !== targetUrl && !currentUrl.includes(targetUrl) && !targetUrl.includes(currentUrl)) {
    // Nếu tab bị Facebook tự động đẩy sang /groups/feed hoặc trang chủ, tự động điều hướng lại về nhóm
    if (location.pathname.includes('/groups/feed') || location.pathname === '/' || location.pathname.includes('/home')) {
      console.log('[Content] Bị chuyển hướng sang feed, điều hướng lại về nhóm:', job.url);
      location.href = job.url;
      await delay(2500);
      return;
    }
    throw Error('Trang không còn đúng nhóm đã chọn.');
  }
  const alerts = [...document.querySelectorAll('[role="alert"],[role="dialog"]')].filter(visible).map(x => x.innerText || x.textContent || '').join(' ');
  if (/temporarily blocked|tạm thời bị chặn|tạm thời bị hạn chế|bạn đang thao tác quá nhanh|going too fast|you.re temporarily restricted|confirm your identity|xác nhận danh tính|captcha/i.test(alerts) || /checkpoint|login/.test(location.pathname)) {
   throw Error('Facebook cảnh báo spam hoặc yêu cầu xác minh bảo mật (checkpoint).');
  }
 }

 // ── TEXT SPIN ENGINE ─────────────────────────────────────────────────────────
 function spinText(text){
  if(!text)return text;
  let prev='',result=text,maxIter=20;
  while(result!==prev&&maxIter-->0){
   prev=result;
   result=result.replace(/\{\{([^{}]+)\}\}/g,(_,opts)=>{
    const arr=opts.split('|');
    return arr[Math.floor(Math.random()*arr.length)];
   });
  }
  result=result.replace(/\(\(([^()]*)\)\)/g,(_,inner)=>Math.random()>0.5?inner:'');
  result=result.replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  return result;
 }

 const OPENER_RE = /Bạn viết gì đi|Viết gì đó|Viết gì đi|Bạn đang nghĩ gì|Bạn muốn chia sẻ|Chia sẻ điều gì đó|Bắt đầu thảo luận|Tạo bài viết|Tạo bài|Viết bài|Write something|What's on your mind|Share something|Start a discussion|Create a post|Create public post/i;

 function findOpener() {
  const clickable = [...document.querySelectorAll('[role="button"], button, [role="combobox"], [tabindex="0"]')].filter(visible);
  for (const el of clickable) {
   if (el.closest('nav, header, [role="banner"], [role="navigation"]')) continue;
   const lbl = label(el) || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || '';
   if (OPENER_RE.test(lbl)) {
    if (/^(Thảo luận|Discussion)$/i.test(lbl.trim()) && el.tagName === 'A') continue;
    return el;
   }
  }

  const textEls = [...document.querySelectorAll('span, div')].filter(visible);
  for (const el of textEls) {
   const txt = (el.innerText || el.getAttribute('aria-placeholder') || '').trim();
   if (txt && OPENER_RE.test(txt) && txt.length < 80) {
    if (el.closest('nav, header, [role="banner"], [role="navigation"]')) continue;
    const btn = el.closest('[role="button"], button, [tabindex="0"]') || el;
    if (visible(btn)) return btn;
   }
  }

  const discTab = [...document.querySelectorAll('[role="tab"], a, [role="button"]')].filter(visible).find(e => {
   const t = label(e);
   return /^(Thảo luận|Discussion)$/i.test(t) && !e.closest('header, nav, [role="banner"]');
  });
  if (discTab && !discTab.dataset.__duyClicked) {
   discTab.dataset.__duyClicked = 'true';
   try { discTab.click(); } catch (_) {}
   try { if (typeof globalThis.scrollTo === 'function') globalThis.scrollTo({ top: 0, behavior: 'instant' }); } catch (_) {}
  }

  return null;
 }

 function setInputValue(input, value) {
  if (!input || value === undefined || value === null) return;
  input.focus();
  const prevValue = input.value;
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(input, value);
  else input.value = value;
  const tracker = input._valueTracker;
  if (tracker) {
   try { tracker.setValue(prevValue === value ? '' : prevValue); } catch (_) {}
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
 }

 function hasCUserCookie() {
  try {
   return Boolean(document.cookie && /(?:^|;\s*)c_user=\d+/.test(document.cookie));
  } catch (_) {
   return false;
  }
 }

 function findLoginInputs() {
  const emailInput =
   document.querySelector('#email, input[name="email"], input[type="email"], input[autocomplete*="username"], input[placeholder*="Email" i], input[placeholder*="di động" i], input[placeholder*="mobile" i], input[aria-label*="Email" i], input[aria-label*="di động" i]') ||
   null;
  const passInput =
   document.querySelector('#pass, input[name="pass"], input[type="password"], input[autocomplete="current-password"], input[placeholder*="Mật khẩu" i], input[placeholder*="Password" i], input[aria-label*="Mật khẩu" i], input[aria-label*="Password" i]') ||
   null;
  return { emailInput, passInput };
 }

 function findVisibleLoginDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  return dialogs.find(d => {
   if (d.querySelector('[contenteditable="true"][role="textbox"]')) return false;
   const text = (d.innerText || '').toLowerCase();
   return (
    text.includes('xem thêm trên facebook') ||
    text.includes('see more on facebook') ||
    text.includes('đăng nhập vào facebook') ||
    text.includes('log in to facebook') ||
    text.includes('bạn chưa đăng nhập') ||
    ((text.includes('đăng nhập') || text.includes('log in')) && Boolean(d.querySelector('input[type="password"], input[name="pass"], input[name="email"], input[placeholder*="Email" i], input[placeholder*="di động" i], button[name="login"], [aria-label*="Đăng nhập" i]')))
   );
  }) || null;
 }

 function detectLoggedOutFacebookState() {
  const isLoginUrl = /\/login|\/checkpoint|login\.php|\/auth/i.test(location.pathname || '');
  const { emailInput, passInput } = findLoginInputs();
  const hasVisibleAuthInputs = Boolean((emailInput && visible(emailInput)) || (passInput && visible(passInput)));
  const loginDialog = findVisibleLoginDialog();
  const hasCUser = hasCUserCookie();
  const pageText = (document.body ? document.body.innerText : '') || '';
  const hasLoginBanner = !hasCUser && (
   hasVisibleAuthInputs ||
   Boolean(loginDialog) ||
   /Bạn chưa đăng nhập|Hãy đăng nhập để tiếp tục|Đăng nhập hoặc đăng ký|Log in or sign up|You must log in to continue|Xem thêm trên Facebook|See more on Facebook/i.test(pageText) ||
   [...document.querySelectorAll('a, button, [role="button"]')].filter(visible).some(el => {
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
    return /^(Tạo tài khoản mới|Create new account|Quên mật khẩu\??|Forgotten password\??|Forgotten account\??)$/i.test(t);
   })
  );

  return {
   isLoggedOut: Boolean(isLoginUrl || hasVisibleAuthInputs || loginDialog || hasLoginBanner),
   isLoginUrl,
   emailInput,
   passInput,
   loginDialog,
   hasCUser
  };
 }

 async function handleLoginIfLoggedOut(job) {
  let state = detectLoggedOutFacebookState();
  let { emailInput, passInput, loginDialog, hasCUser } = state;

  // Chỉ đóng dialog "Xem thêm trên Facebook" nếu cookie c_user THỰC SỰ đã đăng nhập
  if (loginDialog && hasCUser) {
   const closeBtn = loginDialog.querySelector('[aria-label="Đóng"], [aria-label="Close"]') ||
                    [...loginDialog.querySelectorAll('[role="button"], button')].find(b => {
                     const l = (b.getAttribute('aria-label') || b.innerText || '').trim();
                     return /^(Đóng|Close|✕|×)$/i.test(l);
                    });
   if (closeBtn) {
    try { closeBtn.click(); } catch (_) {}
    await delay(600);
    if (!visible(loginDialog) && (hasCUserCookie() || findOpener())) {
     return { handled: false };
    }
    state = detectLoggedOutFacebookState();
    emailInput = state.emailInput;
    passInput = state.passInput;
    loginDialog = state.loginDialog;
    hasCUser = state.hasCUser;
   }
  }

  if (!state.isLoggedOut) {
   return { handled: false };
  }

  if (hasCUser && !state.isLoginUrl && !emailInput && !passInput && findOpener()) {
   return { handled: false };
  }

  const root = loginDialog || document;
  const loginBtn = root.querySelector(
   '[name="login"], #loginbutton, [data-testid="royal_login_button"], button[type="submit"], [role="button"][aria-label*="Đăng nhập" i], [role="button"][aria-label*="Log in" i]'
  ) || [...root.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible).find(b =>
   /^(Đăng nhập|Log In|Log in)$/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim())
  );

  let emailVal = emailInput?.value || '';
  let passVal = passInput?.value || '';

  // Nếu input trống nhưng job có tài khoản
  if (!emailVal && job.accountEmail && emailInput) {
   setInputValue(emailInput, job.accountEmail);
   emailVal = job.accountEmail;
   await delay(200);
  }
  if (!passVal && job.accountPassword && passInput) {
   setInputValue(passInput, job.accountPassword);
   passVal = job.accountPassword;
   await delay(200);
  }

  // Nếu có thông tin đăng nhập (không cần 2FA thủ công) thì thử đăng nhập nhanh inline
  if (emailInput && passInput && emailVal && passVal && loginBtn && job.accountPassword && !job.twoFactor) {
   try {
    loginBtn.click();
    const endWait = Date.now() + 7000;
    while (Date.now() < endWait) {
     await delay(600);
     const after = detectLoggedOutFacebookState();
     if (!after.isLoggedOut && hasCUserCookie()) {
      chrome.runtime.sendMessage({
       type: 'UPDATE_COOKIES',
       accountId: job.accountId
      }).catch(() => {});
      await delay(1500);
      if (location.pathname.includes('/login') || (location.origin + location.pathname !== job.url)) {
       location.href = job.url;
       return { handled: true, success: true, redirected: true };
      }
      return { handled: true, success: true };
     }
    }
   } catch (_) {}
  }

  return {
   handled: true,
   success: false,
   authExpired: true,
   reason: 'Tài khoản Facebook chưa đăng nhập hoặc Cookie đã hết hạn (bị đăng xuất).'
  };
 }

 function checkGroupEligibility(job = null) {
  const pageText = (document.body ? document.body.innerText : '') || '';

  // Nếu chưa đăng nhập Facebook: KHÔNG báo là "Chưa tham gia nhóm" hoặc "Không tìm thấy ô tạo bài"
  const authState = detectLoggedOutFacebookState();
  if (authState.isLoggedOut) {
   return 'AUTH_EXPIRED: Tài khoản Facebook chưa đăng nhập (bị đăng xuất). Hãy đăng nhập lại Facebook.';
  }

  if (job?.accountType === 'fanpage') {
   if (/Trang không thể tham gia|Trang không được phép|Chỉ dành cho trang cá nhân|Chỉ tài khoản cá nhân mới có thể tham gia|Pages aren't allowed to join|Only personal profiles can join/i.test(pageText)) {
    return 'Nhóm này không cho phép Trang/Fanpage tham gia hoặc đăng bài (chỉ dành cho tài khoản cá nhân).';
   }
  }

  const joinBtn = [...document.querySelectorAll('[role="button"], button, a')].filter(visible).find(e => {
   const t = label(e);
   return /^(Tham gia nhóm|Tham gia|Join group|Join)$/i.test(t);
  });
  if (joinBtn || /Tham gia nhóm này để đăng bài|Tham gia nhóm để xem hoặc đăng|Join this group to post/i.test(pageText)) {
   return 'Chưa tham gia nhóm (cần tham gia nhóm trước khi đăng).';
  }

  const pendingBtn = [...document.querySelectorAll('[role="button"], button')].filter(visible).find(e => {
   const t = label(e);
   return /Đã gửi yêu cầu|Hủy yêu cầu tham gia|Requested|Cancel request/i.test(t);
  });
  if (pendingBtn || /yêu cầu tham gia của bạn đang chờ phê duyệt|your request to join is pending/i.test(pageText)) {
   return 'Yêu cầu tham gia nhóm đang chờ phê duyệt.';
  }

  if (/Chỉ quản trị viên mới có thể đăng bài|Chỉ quản trị viên và người kiểm duyệt|Only admins can post|Only admins and moderators can post/i.test(pageText)) {
   return 'Chỉ quản trị viên mới có quyền đăng bài trong nhóm này.';
  }

  if (/Nhóm này đã được lưu trữ|Nhóm đã bị tạm dừng|This group is archived|Group is paused/i.test(pageText)) {
   return 'Nhóm này đã bị tạm dừng hoặc lưu trữ.';
  }

  if (/Trang này không khả dụng|Nội dung này hiện không khả dụng|This content isn't available|Page not found/i.test(pageText)) {
   return 'Trang nhóm không tồn tại, đã bị xóa hoặc đổi địa chỉ.';
  }

  if (/Bạn đã bị chặn đăng bài|Bạn tạm thời không thể đăng bài|You cannot post/i.test(pageText)) {
   return 'Tài khoản bị hạn chế đăng bài trong nhóm này.';
  }

  return null;
 }

 async function run(job){let clicked=false;try{
  // 1. Kiểm tra và tự động xử lý đăng nhập nếu Facebook đang bị đăng xuất
  const loginState = await handleLoginIfLoggedOut(job);
  if (loginState.handled && !loginState.success) {
   return {
    status: 'error',
    authExpired: Boolean(loginState.authExpired),
    note: loginState.reason || '❌ Facebook chưa đăng nhập (bị đăng xuất). Hãy đăng nhập lại Facebook.'
   };
  }

  await check(job);

  // Đóng các popup phụ (như quy tắc nhóm, thông báo) nhưng KHÔNG đóng popup đăng nhập khi chưa có session
  const activeLoginDialog = findVisibleLoginDialog();
  const existingDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  for (const d of existingDialogs) {
   if (d === activeLoginDialog && !hasCUserCookie()) continue;
   if (!d.querySelector('[contenteditable="true"][role="textbox"]')) {
    const dismissBtn = [...d.querySelectorAll('[role="button"], button')].filter(visible).find(e => {
     const lbl = label(e);
     return /^(Đóng|Close|Tôi đồng ý|Đồng ý|Tiếp tục|Đã hiểu|Bỏ qua|Got it|I agree|Continue|Dismiss)$/i.test(lbl) || e.getAttribute('aria-label') === 'Đóng' || e.getAttribute('aria-label') === 'Close';
    });
    if (dismissBtn) {
     try { dismissBtn.click(); } catch (_) {}
     await delay(600);
    }
   }
  }

  if (typeof globalThis.scrollTo === 'function') {
   try { globalThis.scrollTo({top: 0, behavior: 'instant'}); } catch (_) {}
   await delay(300);
  }

  // Giả lập cuộn trang xem nhóm như người thật trước khi mở ô soạn
  if(job.humanBehavior && typeof globalThis.scrollBy === 'function'){
   try{
    const scrollDist=Math.floor(Math.random()*150)+200;
    globalThis.scrollBy({top:scrollDist,behavior:'smooth'});
    await delay(Math.floor(Math.random()*400)+700);
    if (typeof globalThis.scrollTo === 'function') {
     globalThis.scrollTo({top: 0, behavior: 'instant'});
    }
    await delay(500);
   }catch(_){}
  }

  // ── XỬ LÝ DANH TÍNH FANPAGE & CHỐNG ĐĂNG BẰNG NICK CÁ NHÂN ─────────────────
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const targetNorm = norm(job.accountName);
  const targetIdStr = String(job.pageId || '').trim();

  // Kiểm tra danh tính hiện tại của tài khoản trên Facebook (worker.js đã chủ động chuyển trước khi mở tab)
  const isHeaderPageProfile = () => {
    if (!targetNorm) return true;
    // 1. Kiểm tra cookie i_user của Fanpage
    if (targetIdStr && typeof document.cookie === 'string' && document.cookie.includes('i_user=' + targetIdStr)) {
      return true;
    }
    // 2. Kiểm tra thông báo chuyển trang hoặc tiêu đề trang
    if (norm(document.title).includes(targetNorm)) return true;
    const alertEls = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')];
    if (alertEls.some(el => norm(el.innerText || '').includes(targetNorm))) return true;

    // 3. Kiểm tra banner / avatar Facebook
    const banner = document.querySelector('[role="banner"]');
    if (banner && norm(banner.innerText || '').includes(targetNorm)) return true;

    const avatar = document.querySelector('[role="banner"] [role="button"][aria-label*="cá nhân" i], [role="banner"] [role="button"][aria-label*="tài khoản" i], [role="banner"] [role="button"][aria-label*="account" i], [role="banner"] [role="button"][aria-label*="profile" i], [role="banner"] [role="button"][aria-label*="hồ sơ" i], div[role="button"][aria-label*="cá nhân" i], div[role="button"][aria-label*="tài khoản" i]');
    if (avatar) {
      const imgAlt = avatar.querySelector('img')?.getAttribute('alt') || '';
      const text = norm((avatar.getAttribute('aria-label') || '') + ' ' + (avatar.innerText || '') + ' ' + imgAlt);
      if (text.includes(targetNorm)) return true;
    }
    const topElements = [...document.querySelectorAll('div[role="button"], button, a')].filter(visible);
    const headerAvatar = topElements.find(b => {
      const l = norm(label(b));
      const r = b.getBoundingClientRect();
      return (r.top >= 0 && r.top <= 65 && r.right >= window.innerWidth - 220) ||
             /tài khoản|your profile|trang cá nhân|account|hồ sơ/i.test(l);
    });
    if (headerAvatar) {
      const l = norm(label(headerAvatar));
      if (l.includes(targetNorm)) return true;
    }
    if (norm(document.body?.innerText || '').includes(targetNorm)) return true;
    return false;
  };

  // Chờ tìm ô tạo bài và tự động kiểm tra tính hợp lệ của nhóm
  let opener = null;
  const openerTimeout = Date.now() + 35000;
  while (Date.now() < openerTimeout) {
   // Nếu Facebook bị chuyển hướng sang feed/home ngoài ý muốn, tự động đưa tab quay lại URL nhóm
   if (location.pathname.includes('/groups/feed') || location.pathname === '/' || location.pathname.includes('/home')) {
     console.log('[Content] Bị đẩy sang feed/home trong lúc tìm ô đăng, điều hướng lại về nhóm:', job.url);
     location.href = job.url;
     await delay(3000);
   }

   opener = findOpener();
   if (opener) break;

   if (Date.now() > openerTimeout - 25000) {
    const ineligibility = checkGroupEligibility(job);
    if (ineligibility) {
     if (ineligibility.startsWith('AUTH_EXPIRED:')) {
      return { status: 'error', authExpired: true, note: ineligibility.replace(/^AUTH_EXPIRED:\s*/, '') };
     }
     return { status: 'skipped', note: 'Bỏ qua: ' + ineligibility };
    }
   }
   await delay(450);
  }

  if (!opener) {
   const finalReason = checkGroupEligibility(job);
   if (finalReason) {
    if (finalReason.startsWith('AUTH_EXPIRED:')) {
     return { status: 'error', authExpired: true, note: finalReason.replace(/^AUTH_EXPIRED:\s*/, '') };
    }
    return { status: 'skipped', note: 'Bỏ qua: ' + finalReason };
   }
   if (detectLoggedOutFacebookState().isLoggedOut) {
    return { status: 'error', authExpired: true, note: 'Tài khoản Facebook chưa đăng nhập hoặc Cookie đã hết hạn (bị đăng xuất).' };
   }
   return { status: 'skipped', note: 'Đã bỏ qua: Không tìm thấy ô tạo bài (Giao diện nhóm khác biệt hoặc chưa sẵn sàng).' };
  }

  await check(job);
  try {
   opener.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
   opener.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  } catch (_) {}
  opener.click();

  let dialog = null;
  try {
   dialog = await wait(() => [...document.querySelectorAll('[role="dialog"]')].find(e => visible(e) && e.querySelector('[contenteditable="true"][role="textbox"]')), 25000, 'Không mở được hộp thoại tạo bài viết.');
  } catch (_) {
   const rulesDialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible).find(d => !d.querySelector('[contenteditable="true"]'));
   if (rulesDialog) {
    const agreeBtn = [...rulesDialog.querySelectorAll('[role="button"], button')].filter(visible).find(e => /Đồng ý|Tôi đồng ý|Tiếp tục|I agree/i.test(label(e)));
    if (agreeBtn) {
     try { agreeBtn.click(); } catch (_) {}
     await delay(1000);
     dialog = await wait(() => [...document.querySelectorAll('[role="dialog"]')].find(e => visible(e) && e.querySelector('[contenteditable="true"][role="textbox"]')), 15000).catch(() => null);
    }
   }
   if (!dialog) {
    return { status: 'skipped', note: 'Đã bỏ qua: Không mở được hộp thoại tạo bài.' };
   }
  }

  // Nếu là Fanpage: kiểm tra dropdown người đăng trong modal tạo bài & thực hiện CHẶN AN TOÀN
  if (job.accountType === 'fanpage' && dialog) {
    let pageAuthorConfirmed = false;
    const editorEl = dialog.querySelector('[contenteditable="true"]');

    const getDialogAuthorText = () => {
      const topEls = [...dialog.querySelectorAll('div, span, [role="button"], h2')].filter(el => {
        if (!visible(el)) return false;
        if (editorEl && editorEl.contains(el)) return false;
        if (editorEl && (el.compareDocumentPosition(editorEl) & Node.DOCUMENT_POSITION_PRECEDING)) return false;
        return true;
      });
      return norm(topEls.map(e => label(e)).join(' '));
    };

    if (getDialogAuthorText().includes(targetNorm) || isHeaderPageProfile()) {
      pageAuthorConfirmed = true;
    }

    if (!pageAuthorConfirmed) {
      // Tìm các nút bấm có thể chọn tác giả đăng bài trong dialog (nằm phía trên editor)
      const authorCandidates = [...dialog.querySelectorAll('[role="button"], button, [aria-haspopup], [role="combobox"]')].filter(el => {
        if (!visible(el)) return false;
        if (editorEl && (editorEl.contains(el) || (el.compareDocumentPosition(editorEl) & Node.DOCUMENT_POSITION_PRECEDING))) return false;
        const l = label(el);
        return !/Đóng|Close|✕|×|Công khai|Bạn bè|Chỉ mình tôi|Public|Friends|Ẩn danh|Anonymous/i.test(l);
      });

      for (const btn of authorCandidates) {
        try { btn.click(); } catch (_) { continue; }
        await delay(800);

        const options = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="dialog"] [role="button"], [role="menu"] [role="button"], [role="menuitem"]')].filter(visible);
        const pageOption = options.find(o => {
          const t = norm(label(o));
          return (targetNorm && t.includes(targetNorm)) || (targetIdStr && o.innerHTML && o.innerHTML.includes(targetIdStr));
        });

        if (pageOption) {
          try { pageOption.click(); } catch (_) {}
          await delay(1200);
          pageAuthorConfirmed = true;
          break;
        } else {
          // Bấm ra nền dialog để đóng nếu mở nhầm menu khác
          try { dialog.click(); } catch (_) {}
          await delay(300);
        }
      }
    }

    // Re-verify sau khi bấm chọn
    if (!pageAuthorConfirmed) {
      if (getDialogAuthorText().includes(targetNorm) || isHeaderPageProfile()) {
        pageAuthorConfirmed = true;
      }
    }

    // NẾU VẪN KHÔNG PHẢI LÀ FANPAGE: CHẶN TUYỆT ĐỐI KHÔNG ĐĂNG BẰNG NICK CÁ NHÂN!
    if (!pageAuthorConfirmed) {
      const closeBtn = dialog.querySelector('[aria-label="Đóng"], [aria-label="Close"]') ||
                       [...dialog.querySelectorAll('[role="button"], button')].find(b => /^(Đóng|Close|✕|×)$/i.test(label(b)));
      if (closeBtn) {
        try { closeBtn.click(); } catch (_) {}
        await delay(500);
      }
      return {
        status: 'skipped',
        note: `Bỏ qua: Không thể chuyển sang tư cách Fanpage "${job.accountName}" để đăng bài trong nhóm này (Nhóm chỉ cho phép tài khoản cá nhân hoặc Fanpage chưa tham gia nhóm). Đã tự động chặn để bảo vệ nick cá nhân quản trị.`
      };
    }
  }

  const editorCandidates = [...dialog.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  const editor = editorCandidates[0] || dialog.querySelector('[contenteditable="true"]');
  if (!editor) throw Error('Không tìm thấy ô soạn bài trong hộp thoại.');

  const existingEditorText = (editor.innerText || editor.textContent || '').trim();
  if (existingEditorText) throw Error('Ô soạn đã có nội dung; dừng để không ghi đè bản nháp.');
  await check(job);
  editor.focus();

  const canonical = s => s.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d\ufeff\u2060]/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/,'').trim();

  // Apply text spin: resolve {{a|b}} and ((optional)) for THIS group
  let spunText = spinText(job.text.replace(/\r\n?/g, '\n'));

  // Chế độ đăng bài bằng link (Link Preview)
  const hasUrlInJob = /(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(spunText);
  const isPureUrl = hasUrlInJob && spunText.trim().startsWith('http') && !spunText.trim().includes('\n');
  const isLinkMode = !job.picture && (Boolean(job.postLinkMode) || isPureUrl);
  let linkUrl = null;
  let remainingText = '';
  if (isLinkMode) {
    const urlMatch = spunText.match(/(https?:\/\/[^\s]+)/i);
    if (urlMatch) {
      linkUrl = urlMatch[0];
      remainingText = spunText.replace(linkUrl, '').trim();
    } else {
      const wwwMatch = spunText.match(/(www\.[^\s]+)/i);
      if (wwwMatch) {
        linkUrl = 'https://' + wwwMatch[0];
        remainingText = spunText.replace(wwwMatch[0], '').trim();
      }
    }
  }

  // Facebook post background: kiểm tra trạng thái bài viết nền màu
  const hasBg = Boolean(job.background && job.background !== 'none' && !job.picture && !isLinkMode);

  // Nếu là bài đăng nền màu Facebook: loại bỏ mọi ký tự xuống dòng (\n) trong nội dung
  // vì Facebook bắt buộc bài viết nền màu phải là văn bản liền mạch trên 1 đoạn duy nhất
  if (hasBg) {
    spunText = spunText.replace(/[\r\n]+/g, ' ').trim();
  }

  // Anti-duplicate: chèn mã ngẫu nhiên nếu được bật (không vượt quá 130 ký tự đối với bài nền màu)
  // ĐẶC BIỆT: Đối với bài nền màu, bỏ hoàn toàn khoảng cách cách 1 dòng (\n\n), chỉ cách 1 khoảng trắng
  if (job.randomTag) {
   const code = Math.random().toString(36).substring(2, 6).toUpperCase();
   const now = new Date();
   const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
   if (isLinkMode) {
     if (remainingText.length > 0) {
       remainingText += ` [#${code} · ${timeStr}]`;
     }
   } else {
     const tag = hasBg ? ` [#${code} · ${timeStr}]` : `\n\n[#${code} · ${timeStr}]`;
     if (!hasBg || (spunText.length + tag.length <= 130)) {
       spunText += tag;
     }
   }
  }

  const expected = isLinkMode ? (linkUrl || spunText) : spunText;

  // Tính tỷ lệ khớp từ
  const calcRatio = (actual, wanted) => {
   const wWords = wanted.split(/\s+/).filter(Boolean);
   if (!wWords.length) return 1;
   const matchCount = wWords.filter(w => actual.includes(w)).length;
   return matchCount / wWords.length;
  };

  const escapeHtml = str => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const getEditorText = el => (el.innerText || el.textContent || '').trim();

  // Điền văn bản vào bộ soạn Lexical của Facebook ngay cả khi cửa sổ thu nhỏ (minimize)
  async function fillEditor(el, text) {
   el.focus();
   await delay(150);

   const sel = window.getSelection();
   if (sel) {
    try {
     sel.removeAllRanges();
     const range = document.createRange();
     range.selectNodeContents(el);
     range.collapse(false);
     sel.addRange(range);
    } catch (_) {}
   }

   let filled = false;

   // Cách 1: ClipboardEvent 'paste' (truyền cả text/plain và text/html theo cấu trúc node Lexical)
   try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const htmlLines = text.split('\n').map(line => {
     if (!line.trim()) return '<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><br></p>';
     return `<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><span data-lexical-text="true">${escapeHtml(line)}</span></p>`;
    }).join('');
    dt.setData('text/html', htmlLines);

    el.dispatchEvent(new ClipboardEvent('paste', {
     clipboardData: dt,
     bubbles: true,
     cancelable: true,
     composed: true
    }));
    await delay(1000);
    if (calcRatio(canonical(getEditorText(el)), canonical(text)) >= 0.8) filled = true;
   } catch (_) {}

   // Cách 2: InputEvent 'beforeinput' (chuẩn cơ chế Lexical Meta)
   if (!filled) {
    try {
     const dt = new DataTransfer();
     dt.setData('text/plain', text);
     try {
      el.dispatchEvent(new InputEvent('beforeinput', {
       inputType: 'insertFromPaste',
       dataTransfer: dt,
       data: text,
       bubbles: true,
       cancelable: true,
       composed: true
      }));
     } catch (_) {}

     try {
      el.dispatchEvent(new InputEvent('beforeinput', {
       inputType: 'insertText',
       data: text,
       bubbles: true,
       cancelable: true,
       composed: true
      }));
     } catch (_) {}

     await delay(800);
     if (calcRatio(canonical(getEditorText(el)), canonical(text)) >= 0.8) filled = true;
    } catch (_) {}
   }

   // Cách 3: document.execCommand('insertText')
   if (!filled) {
    try {
     el.focus();
     if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
     }
     document.execCommand('insertText', false, text);
     await delay(800);
     if (calcRatio(canonical(getEditorText(el)), canonical(text)) >= 0.8) filled = true;
    } catch (_) {}
   }

   // Cách 4: Tạo cấu trúc đoạn DOM chuẩn của Lexical và kích hoạt chuỗi sự kiện đồng bộ
   if (!filled) {
    try {
     el.innerHTML = '';
     const lines = text.split('\n');
     for (const line of lines) {
      const p = document.createElement('p');
      p.className = 'xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8';
      if (line.trim().length > 0) {
       const span = document.createElement('span');
       span.setAttribute('data-lexical-text', 'true');
       span.textContent = line;
       p.appendChild(span);
      } else {
       p.appendChild(document.createElement('br'));
      }
      el.appendChild(p);
     }

     el.dispatchEvent(new Event('change', { bubbles: true }));
     el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
     el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true }));
     el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true }));
     await delay(600);
     if (calcRatio(canonical(getEditorText(el)), canonical(text)) >= 0.8) filled = true;
    } catch (_) {}
   }

   // Cách 5: Fallback textContent
   if (!filled) {
    try {
     el.textContent = text;
     el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
     await delay(500);
    } catch (_) {}
   }
  }

  function nudgeEditor(el, text) {
   if (!el) return;
   try {
    el.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount === 0) {
     const range = document.createRange();
     range.selectNodeContents(el);
     range.collapse(false);
     sel.addRange(range);
    }
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '', bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
   } catch (_) {}
  }

  // Helper xóa sạch link trong ô soạn bài của Facebook sau khi đã tải xong khung xem trước
  async function clearLinkFromEditor(el, replacement = '') {
    if (!el) return;
    el.focus();
    await delay(150);

    const hasText = () => (el.innerText || el.textContent || '').trim().length > 0;

    // Bước A: Select toàn bộ nội dung trong ô soạn thảo
    try {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
      }
    } catch (_) {}

    await delay(80);

    // Bước B: Mô phỏng thao tác chuẩn: Ctrl+A rồi bấm Backspace
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, bubbles: true }));
      document.execCommand('selectAll', false, null);
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, bubbles: true }));
      await delay(80);

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
      document.execCommand('delete', false, null);
      el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
    } catch (_) {}

    await delay(200);

    // Bước C: Nếu có nội dung mô tả kèm theo: điền nội dung mô tả
    if (replacement && replacement.trim().length > 0) {
      await fillEditor(el, replacement.trim());
      return;
    }

    // Bước D: Nếu chỉ có link và muốn xóa hoàn toàn:
    // Kiểm tra xem editor còn chữ không, nếu còn thì can thiệp trực tiếp vào cấu trúc DOM Lexical
    if (hasText()) {
      try {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.addRange(range);
        }
        document.execCommand('delete', false, null);
      } catch (_) {}

      try {
        // Cấu trúc đoạn rỗng chuẩn của Facebook Lexical
        el.innerHTML = '<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><br></p>';
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '', bubbles: true, composed: true }));
      } catch (_) {}
    }

    await delay(250);

    // Bước E: Vòng lặp đảm bảo ô soạn thảo đã sạch 100%
    for (let i = 0; i < 5; i++) {
      if (!hasText()) break;
      try {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        el.innerHTML = '<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><br></p>';
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      } catch (_) {}
      await delay(150);
    }
  }

  // Helper click an toàn: phát đúng 1 chuỗi sự kiện chuột chuẩn (mousedown -> mouseup -> click)
  // Tuyệt đối không click lặp lại để tránh các nút bật/tắt (toggle) như nút Aa bị mở rồi đóng ngay lập tức
  const clickOnce = (target) => {
    if (!target) return false;
    const el = target.closest('[role="button"], [role="checkbox"], [role="radio"], button') || target;
    try { el.focus(); } catch (_) {}
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch (_) {}
    try { el.click(); } catch (_) {}
    return true;
  };

  // Áp dụng màu nền Facebook cho bài viết ngắn (<= 130 ký tự)
  async function applyFacebookPostBackground(dlg, bgId) {
   if (!bgId || bgId === 'none') return;
   try {
    const editor = dlg.querySelector('[contenteditable="true"]');
    const editorRect = editor ? editor.getBoundingClientRect() : null;

    // Xác định tọa độ thanh "Thêm vào bài viết của bạn"
    const getAddToPostTop = () => {
      const textEl = [...dlg.querySelectorAll('span, div')].find(e => {
        const t = (e.textContent || '').trim().toLowerCase();
        return (t === 'thêm vào bài viết của bạn' || t === 'add to your post') && e.children.length === 0;
      });
      if (textEl) return textEl.getBoundingClientRect().top;
      const card = dlg.querySelector('[aria-label*="thêm vào bài viết" i], [aria-label*="add to your post" i]');
      if (card) return card.getBoundingClientRect().top;
      const postBtn = [...dlg.querySelectorAll('[role="button"], button')].find(b => /^(đăng|post)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (postBtn) return postBtn.getBoundingClientRect().top - 60;
      return null;
    };

    const addTop = getAddToPostTop();

    // 1. Quét tìm khay màu đang hiển thị (hàng có từ 7 nút tròn trở lên nằm trên thanh "Thêm vào bài viết")
    const findSwatchesRow = () => {
      const allBtns = [...dlg.querySelectorAll('[role="button"], [role="checkbox"], [role="radio"], button')].filter(visible);
      const rowMap = new Map();
      for (const el of allBtns) {
        if (editor && editor.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.width > 55 || r.height < 16 || r.height > 55) continue;
        if (addTop && r.top >= addTop - 5) continue; // Tuyệt đối không quét vào thanh "Thêm vào bài viết"
        const y = Math.round(r.top);
        let foundY = [...rowMap.keys()].find(k => Math.abs(k - y) <= 8);
        if (!foundY) { foundY = y; rowMap.set(foundY, []); }
        rowMap.get(foundY).push(el);
      }
      for (const items of rowMap.values()) {
        if (items.length >= 7) {
          const unique = [];
          for (const el of items) {
            const btn = el.closest('[role="button"], [role="checkbox"], [role="radio"], button') || el;
            if (!unique.includes(btn)) unique.push(btn);
          }
          if (unique.length >= 7) {
            unique.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
            return unique;
          }
        }
      }
      return null;
    };

    // Tìm nút Aa mở khay màu với 3 lớp định vị thông minh
    const findAaButton = () => {
      // Lớp 1: Quét theo nhãn aria-label, title hoặc text
      const candidates = [...dlg.querySelectorAll('[role="button"], button')].filter(btn => {
        if (editor && editor.contains(btn)) return false;
        const r = btn.getBoundingClientRect();
        if (r.width < 16 || r.width > 60 || r.height < 16 || r.height > 60) return false;
        if (addTop && r.top >= addTop - 5) return false;

        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        const text = (btn.innerText || btn.textContent || '').trim();

        if (text === 'Aa' || text === 'aa') return true;
        if (label.includes('định dạng') || label.includes('format') || label.includes('màu nền') || label.includes('background')) return true;
        if (title.includes('định dạng') || title.includes('format') || title.includes('màu nền') || title.includes('background')) return true;

        const img = btn.querySelector('img');
        if (img) {
          const alt = (img.getAttribute('alt') || '').toLowerCase();
          if (alt.includes('aa') || alt.includes('màu') || alt.includes('format') || alt.includes('định dạng')) return true;
        }
        return false;
      });
      if (candidates.length > 0) return candidates[0];

      // Lớp 2: Quét phần tử có chữ "Aa" bất kỳ (span / div)
      const textEls = [...dlg.querySelectorAll('span, div')];
      const aaText = textEls.find(e => (e.innerText || '').trim() === 'Aa' && (!editor || !editor.contains(e)) && (!addTop || e.getBoundingClientRect().top < addTop - 5));
      if (aaText) {
        return aaText.closest('[role="button"], button') || aaText;
      }

      // Lớp 3: Định vị không gian (Spatial Detection) 100% chuẩn xác
      // Nút Aa luôn nằm ở góc trái, bên dưới nội dung soạn bài và bên trên thanh "Thêm vào bài viết"
      const dlgRect = dlg.getBoundingClientRect();
      const midX = dlgRect.left + dlgRect.width / 2;

      const rowBtns = [...dlg.querySelectorAll('[role="button"], button')].filter(btn => {
        if (editor && editor.contains(btn)) return false;
        const r = btn.getBoundingClientRect();
        if (r.width < 16 || r.width > 60 || r.height < 16 || r.height > 60) return false;
        if (addTop && r.bottom > addTop + 5) return false;
        if (editor && r.bottom <= editor.getBoundingClientRect().top + 10) return false;
        // Phải nằm ở nửa bên TRÁI (nửa bên phải là nút emoji mặt cười)
        if (r.left + r.width / 2 > midX) return false;
        return true;
      });

      if (rowBtns.length > 0) {
        rowBtns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return rowBtns[0];
      }

      return null;
    };

    let swatchesRow = findSwatchesRow();

    // 2. Nếu khay màu CHƯA MỞ: bấm nút Aa đúng 1 lần duy nhất để mở khay màu
    if (!swatchesRow) {
      const aaBtn = findAaButton();
      if (aaBtn) {
        console.log('[NTD Background] Bấm nút Aa mở khay màu qua DOM:', aaBtn);
        clickOnce(aaBtn);
      } else if (addTop && editorRect) {
        // Fallback tọa độ nếu không tìm được DOM: nút Aa nằm ở góc trái, trên thanh "Thêm vào bài viết" ~25px
        const aaX = editorRect.left + 24;
        const aaY = addTop - 25;
        const elAtPoint = document.elementFromPoint(aaX, aaY);
        if (elAtPoint) {
          console.log('[NTD Background] Fallback bấm nút Aa theo tọa độ:', aaX, aaY, elAtPoint);
          clickOnce(elAtPoint);
        }
      }

      // Đợi khay màu bung ra (kiểm tra mỗi 200ms trong tối đa 2.5 giây)
      for (let i = 0; i < 12; i++) {
        await delay(200);
        swatchesRow = findSwatchesRow();
        if (swatchesRow) break;
      }
    }

    // 3. Khi khay màu đã mở: bấm chọn ô màu tương ứng
    const bgIndexMap = {
      'sunset': 3,      // Ô số 2 (Hoàng hôn cam đỏ)
      'ocean': 6,       // Ô số 5 (Đại dương)
      'galaxy': 9,      // Ô số 8 (Vũ trụ)
      'fire': 3,        // Ô số 2 (Lửa hồng)
      'emerald': 7,     // Ô số 6 (Ngọc lục)
      'midnight': 8,    // Ô số 7 (Bóng đêm)
      'sunshine': 7,    // Ô số 6 (Nắng mai)
      'candy': 5,       // Ô số 4 (Kẹo ngọt)
      'neon': 2,        // Ô số 1 (Neon tím)
      'solid_red': 4,   // Ô số 3 (Đỏ tươi)
      'solid_blue': 6   // Ô số 5 (Xanh dương)
    };
    const targetIdx = bgIndexMap[bgId] ?? 3;

    if (swatchesRow && swatchesRow.length >= 7) {
      const targetSwatch = swatchesRow[targetIdx] || swatchesRow[3] || swatchesRow[2];
      if (targetSwatch) {
        console.log('[NTD Background] Bấm chọn ô màu:', targetSwatch);
        clickOnce(targetSwatch);
        await delay(500);
        return;
      }
    }

    // 4. Fallback duy nhất khi khay màu không tìm thấy qua DOM
    if (!swatchesRow && addTop && editorRect) {
      const swatchOffsets = {
        'sunset': 116,
        'ocean': 212,
        'galaxy': 308,
        'fire': 116,
        'emerald': 244,
        'midnight': 276,
        'sunshine': 244,
        'candy': 180,
        'neon': 84,
        'solid_red': 148,
        'solid_blue': 212
      };
      const offsetX = swatchOffsets[bgId] || 116;
      const sX = editorRect.left + offsetX;
      const sY = addTop - 25;
      const swatchEl = document.elementFromPoint(sX, sY);
      if (swatchEl) {
        console.log('[NTD Background] Fallback bấm ô màu theo tọa độ:', sX, sY, swatchEl);
        clickOnce(swatchEl);
        await delay(500);
      }
    }
   } catch (err) {
    console.warn('Không thể tự động áp dụng màu nền Facebook:', err);
   }
  }

  // Đảm bảo không có ảnh đính kèm: nếu hộp thoại đang có ảnh nháp sót lại từ trước thì bấm gỡ bỏ
  if (!job.picture || hasBg || isLinkMode) {
    const removeImgBtns = [...dialog.querySelectorAll('[aria-label*="Gỡ" i], [aria-label*="Remove" i], [aria-label*="Xóa ảnh" i], [aria-label*="Gỡ ảnh" i]')];
    for (const btn of removeImgBtns) {
      try { btn.click(); await delay(300); } catch (_) {}
    }
  }

  if (isLinkMode && linkUrl) {
    console.log('[NTD Link Mode] Đang đăng bài bằng link:', linkUrl);

    // 1. Chụp danh sách ảnh và nút hiện có trong dialog trước khi dán link
    const beforeImages = new Set([...dialog.querySelectorAll('img')].map(e => e.src));
    const beforeBtnsCount = dialog.querySelectorAll('[role="button"], button').length;

    // 2. Dán đường link vào ô soạn bài
    console.log('[NTD Link Mode] Bước 1: Dán link vào ô soạn bài Facebook...');
    await fillEditor(editor, linkUrl);
    await delay(400);

    // Kích hoạt thêm phím cách / khoảng trắng để Link Scraper của Facebook nhận diện và quét liên kết
    try {
      editor.focus();
      document.execCommand('insertText', false, ' ');
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' ', bubbles: true, composed: true }));
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true }));
    } catch (_) {}

    // 3. Đợi Facebook nạp xong khung bài viết xem trước (Link Preview Card)
    console.log('[NTD Link Mode] Bước 2: Đợi Facebook nạp khung bài viết xem trước...');
    const maxWaitMs = 20000;
    const startWait = Date.now();
    let previewReady = false;

    // Chờ tối thiểu 3.5 giây để Facebook gửi request quét link và bắt đầu render card
    await delay(3500);

    const isPreviewLoaded = () => {
      // Dấu hiệu 1: Xuất hiện nút "✕" (Gỡ bản xem trước) ở góc khung bài viết
      const removeBtns = [...dialog.querySelectorAll('[aria-label*="Gỡ" i], [aria-label*="Remove" i], [aria-label*="Xóa" i], [aria-label*="✕" i], [aria-label*="Đóng" i]')].filter(visible);
      if (removeBtns.length > 0) return true;

      // Dấu hiệu 2: Xuất hiện ảnh mới trong dialog (ảnh xem trước của bài viết / website)
      const newImgs = [...dialog.querySelectorAll('img')].filter(img => visible(img) && !beforeImages.has(img.src) && (img.naturalWidth >= 40 || img.clientWidth >= 40));
      if (newImgs.length > 0) return true;

      // Dấu hiệu 3: Xuất hiện card xem trước bên dưới editor
      const cards = [...dialog.querySelectorAll('[data-ad-preview], [role="article"], [role="region"], a[href*="facebook.com"], a[target="_blank"]')].filter(e => {
        if (!visible(e)) return false;
        if (editor.contains(e)) return false;
        const rect = e.getBoundingClientRect();
        const edRect = editor.getBoundingClientRect();
        return rect.top >= (edRect.top - 10) && rect.width > 180 && rect.height > 50;
      });
      if (cards.length > 0) {
        const textContent = cards.map(c => c.innerText || '').join(' ').trim();
        if (!textContent.includes('...') && textContent.length > 10) return true;
      }

      // Dấu hiệu 4: Đã tải xong (không còn progressbar / aria-busy) và số nút tăng lên sau ít nhất 5 giây
      const hasProgress = [...dialog.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
      if (!hasProgress && (Date.now() - startWait >= 5000)) {
        if (dialog.querySelectorAll('[role="button"], button').length > beforeBtnsCount) {
          return true;
        }
      }

      return false;
    };

    while (Date.now() - startWait < maxWaitMs) {
      if (isPreviewLoaded()) {
        previewReady = true;
        console.log('[NTD Link Mode] Đã phát hiện khung xem trước bài viết hoàn tất!');
        break;
      }
      await delay(800);
    }

    // Đợi thêm 1.5 giây để Facebook hoàn tất render khung bài viết ổn định
    await delay(1500);
    console.log('[NTD Link Mode] Trạng thái nạp khung bài viết:', previewReady ? 'Thành công' : 'Hoàn thành thời gian chờ');

    // 4. Xóa đường link trong ô soạn thảo, chỉ để lại khung xem trước bài viết (hoặc nội dung mô tả kèm theo nếu có)
    console.log('[NTD Link Mode] Bước 3: Xóa đường link khỏi ô soạn thảo...');
    try {
      const activeEditor = dialog.querySelector('[contenteditable="true"][role="textbox"]') || dialog.querySelector('[contenteditable="true"]') || editor;
      await clearLinkFromEditor(activeEditor, remainingText);
      await delay(800);
      const afterText = (activeEditor.innerText || activeEditor.textContent || '').trim();
      console.log('[NTD Link Mode] Nội dung ô soạn thảo sau khi xóa link:', afterText || '(Rỗng - chỉ giữ khung xem trước)');
    } catch (e) {
      console.warn('[NTD Link Mode] Lỗi khi xóa link:', e);
    }
    await delay(1000);
  } else {
    // Bước 1: Điền nội dung vào ô soạn thảo Facebook
    await fillEditor(editor, expected);
    await delay(400);

    // Bước 2: Tự động chọn màu nền Facebook nếu bài viết có cấu hình nền màu và <= 130 ký tự
    if (hasBg && expected.length <= 130) {
      await applyFacebookPostBackground(dialog, job.background);
      await delay(500);
    }
  }

  const currentEditor = dialog.querySelector('[contenteditable="true"]') || editor;
  const actualText = canonical(getEditorText(currentEditor)), wantedText = canonical(expected);
  const ratio = calcRatio(actualText, wantedText);
  if (!isLinkMode && ratio < 0.70) {
   throw Error('Dán bài chưa khớp đủ nội dung (' + Math.round(ratio * 100) + '%). Chưa gửi bài, chưa tải ảnh.');
  }

  if (job.picture && !hasBg && !isLinkMode) {
   const beforeImages = new Set([...dialog.querySelectorAll('img')].map(e => e.src));
   const acceptsImage = e => /image|\.jpe?g|\.png|\.webp/i.test(e.accept || '');
   let inputs = [...dialog.querySelectorAll('input[type="file"]')].filter(acceptsImage);
   if (!inputs.length) {
    const oldInputs = new Set(document.querySelectorAll('input[type="file"]'));
    const photoBtns = buttons(dialog).filter(e => /Ảnh|Photo|video/i.test(label(e)));
    const photo = one(photoBtns, 'nút thêm ảnh');
    await check(job);
    photo.click();
    await wait(() => {
     inputs = [...dialog.querySelectorAll('input[type="file"]')].filter(acceptsImage);
     if (!inputs.length) inputs = [...document.querySelectorAll('input[type="file"]')].filter(e => !oldInputs.has(e) && acceptsImage(e));
     return inputs.length;
    }, 20000, 'Không tìm thấy ô chọn ảnh sau khi bấm nút thêm ảnh.');
   }
   const input = one(inputs, 'ô tải ảnh');
   const [head, raw] = job.picture.data.split(',');
   if (!/^data:image\/(jpeg|png|webp);base64$/.test(head)) throw Error('Ảnh không hợp lệ.');
   const bytes = Uint8Array.from(atob(raw), x => x.charCodeAt(0));
   const dt = new DataTransfer();
   dt.items.add(new File([bytes], job.picture.name, { type: job.picture.type }));
   await check(job);
   input.files = dt.files;
   input.dispatchEvent(new Event('change', { bubbles: true }));
   try {
    await wait(() => [...dialog.querySelectorAll('img')].some(e => visible(e) && !beforeImages.has(e.src) && e.complete && e.naturalWidth >= 80 && e.naturalHeight >= 80), 30000);
   } catch {
    throw Error('Chưa xác nhận được ảnh xem trước trong ô tạo bài. Chưa bấm Đăng; hãy chụp phần ảnh và thông báo này.');
   }
   await delay(1000);
   if ([...dialog.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible)) {
    await wait(() => ![...dialog.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible), 30000);
   }
  }

  if (job.mode === 'preview') return { status: 'preview', note: 'Đã điền nội dung. Chưa bấm Đăng. Kiểm tra và tự đóng bản nháp trước khi tiếp tục.' };

  // Nếu có nút "Tiếp" (Next) trước khi Đăng
  const nextBtn = buttons(dialog).find(e => /^(Tiếp|Tiếp tục|Next)$/i.test(label(e)) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  if (nextBtn) {
   try { nextBtn.click(); } catch (_) {}
   await delay(1000);
  }

  const post = await wait(() => {
   const allBtns = [...dialog.querySelectorAll('[role="button"], button')].filter(visible);
   const postBtns = allBtns.filter(e => {
    const lbl = label(e);
    return /^(Đăng|Post|Đăng bài|Đăng bài viết|Publish)$/i.test(lbl);
   });

   if (!postBtns.length) return null;

   const btn = postBtns[0];
   const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
   if (!isDisabled) {
    return btn;
   }

   // Nút Đăng đang bị disabled (aria-disabled="true") do Facebook Lexical chưa kích hoạt re-render
   // Nudge editor để Facebook cập nhật lại trạng thái nút
   nudgeEditor(editor, isLinkMode ? (remainingText || '') : expected);
   return null;
  }, 35000, 'Nút Đăng chưa sẵn sàng hoặc bị vô hiệu hóa.');

  // Dừng vài giây giả lập người thật đọc/rà soát lại trước khi bấm Đăng
  if (job.humanBehavior) {
   await delay(Math.floor(Math.random() * 1500) + 2500);
  }

  // Reset biến bắt URL từ mạng GraphQL trước khi bấm Đăng
  networkCapturedPostUrl = '';
  networkCapturedIsPending = false;
  try {
   delete document.documentElement.dataset.ntdCapturedPostUrl;
   delete document.documentElement.dataset.ntdCapturedIsPending;
  } catch (_) {}

  // Chụp nhanh danh sách các link bài viết đã có sẵn trên trang nhóm trước khi bấm Đăng
  const beforePostUrls = new Set();
  try {
   document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/pending_posts/"]').forEach(a => {
    const cl = cleanFacebookPostUrl(a.getAttribute('href') || a.href);
    if (cl) beforePostUrls.add(cl);
   });
  } catch (_) {}

  await check(job);
  clicked = true;
  try {
   post.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
   post.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  } catch (_) {}
  post.click();

  try {
   await wait(() => !dialog.isConnected || !visible(dialog), 30000);
  } catch (_) {}

  // Kiểm tra ngay các cảnh báo lỗi hoặc chặn từ Facebook
  const getAlertsText = () => [...document.querySelectorAll('[role="alert"],[role="status"]')].filter(visible).map(e => e.innerText || e.textContent || '').join(' ');
  let alerts = getAlertsText();

  if (/temporarily blocked|tạm thời bị chặn|tạm thời bị hạn chế|bạn đang thao tác quá nhanh|going too fast|you.re temporarily restricted|misuse|violation/i.test(alerts)) {
   return { status: 'blocked', note: '🛑 Facebook cảnh báo spam hoặc thao tác nhanh! Đã dừng chiến dịch để bảo vệ tài khoản.' };
  }
  if (/couldn.t post|could not post|unable to post|something went wrong|không thể đăng|đã xảy ra lỗi/i.test(alerts)) {
   return { status: 'unknown', note: 'Facebook báo lỗi sau khi gửi. Kiểm tra nhóm trước khi tiếp tục.' };
  }

  // Quét tìm link bài viết vừa đăng (thử trong tối đa 6 giây để chờ Facebook phản hồi GraphQL, render toast thông báo hoặc feed)
  let postUrl = '';
  let isPending = /pending approval|chờ phê duyệt|chờ duyệt|submitted for approval/i.test(alerts);
  const cleanExpected = (expected || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const textSnippet = cleanExpected.slice(0, 30);
  const targetAccName = (job.accountName || '').trim().toLowerCase();

  const findStart = Date.now();
  while (Date.now() - findStart < 6000) {
   // Ưu tiên 1: Link bắt được trực tiếp từ phản hồi GraphQL mutation tạo bài viết của Facebook
   const capturedUrl = networkCapturedPostUrl || document.documentElement.dataset.ntdCapturedPostUrl || '';
   const capturedPending = networkCapturedIsPending || document.documentElement.dataset.ntdCapturedIsPending === 'true';

   if (capturedUrl && isPostUrlMatchingGroup(capturedUrl, job.url)) {
    const cl = cleanFacebookPostUrl(capturedUrl);
    if (cl) {
     postUrl = cl;
     if (capturedPending || cl.includes('/pending_posts/')) isPending = true;
     break;
    }
   }

   // Ưu tiên 2: Tìm trong thông báo nổi / Toast xác nhận bài viết của Facebook
   const toastContainers = [...document.querySelectorAll('[role="alert"], [role="status"], div[data-pagelet*="Toast"], div[aria-live="polite"]')].filter(visible);
   for (const container of toastContainers) {
    const cText = (container.innerText || container.textContent || '').toLowerCase();
    const isPostConfirm = /bài viết của bạn|đã được chia sẻ|đã chia sẻ|chờ phê duyệt|chờ duyệt|đang chờ duyệt|bài viết đã được gửi|bài viết đã đăng|your post|published|shared|submitted for approval|pending approval/i.test(cText);

    if (isPostConfirm) {
     if (/chờ phê duyệt|chờ duyệt|pending approval|submitted/i.test(cText)) {
      isPending = true;
     }
     const anchors = container.querySelectorAll('a');
     for (const a of anchors) {
      const rawHref = a.getAttribute('href') || a.href || '';
      const clean = cleanFacebookPostUrl(rawHref);
      if (clean && isPostUrlMatchingGroup(clean, job.url)) {
       postUrl = clean;
       if (clean.includes('/pending_posts/')) isPending = true;
       break;
      }
     }
     if (postUrl) break;
    }
   }
   if (postUrl) break;

   // Ưu tiên 3: Tìm thẻ <a> có nhãn rõ ràng "Xem bài viết" / "View post"
   const viewAnchors = document.querySelectorAll('a');
   for (const a of viewAnchors) {
    const txt = (a.innerText || a.textContent || '').trim().toLowerCase();
    if (txt === 'xem bài viết' || txt === 'view post' || txt === 'xem bài' || txt === 'view') {
     const clean = cleanFacebookPostUrl(a.getAttribute('href') || a.href || '');
     if (clean && isPostUrlMatchingGroup(clean, job.url)) {
      postUrl = clean;
      if (clean.includes('/pending_posts/')) isPending = true;
      break;
     }
    }
   }
   if (postUrl) break;

   // Ưu tiên 4: Kiểm tra bài viết trong feed nhóm
   // CHỈ chấp nhận nếu không phải bài ghim (pinned) / bài gợi ý, và có nội dung bài hoặc tác giả khớp với nhãn vừa xong
   const feedArticles = document.querySelectorAll('div[role="feed"] div[role="article"]');
   for (let i = 0; i < Math.min(feedArticles.length, 3); i++) {
    const art = feedArticles[i];
    const artText = (art.innerText || art.textContent || '').toLowerCase();

    const isPinned = artText.includes('đáng chú ý') || artText.includes('bài viết được ghim') || artText.includes('pinned');
    const isSuggested = artText.includes('gợi ý cho bạn') || artText.includes('suggested for you') || artText.includes('được tài trợ') || artText.includes('sponsored');
    if (isPinned || isSuggested) continue;

    const hasJustNow = /vừa xong|just now|vài giây|a few seconds|1 phút|1 min/i.test(artText);
    const hasTextMatch = textSnippet && artText.includes(textSnippet);
    const hasAuthorMatch = targetAccName && artText.includes(targetAccName);

    if (hasTextMatch || (hasAuthorMatch && hasJustNow)) {
     const artAnchors = art.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/pending_posts/"]');
     for (const a of artAnchors) {
      const clean = cleanFacebookPostUrl(a.getAttribute('href') || a.href);
      if (clean && isPostUrlMatchingGroup(clean, job.url)) {
       postUrl = clean;
       if (clean.includes('/pending_posts/') || /chờ phê duyệt|chờ duyệt|pending/i.test(artText)) isPending = true;
       break;
      }
     }
     if (postUrl) break;
    }
   }
   if (postUrl) break;

   // Ưu tiên 5: Link bài viết mới xuất hiện mà trước khi bấm Đăng chưa có
   // (BẮT BUỘC phải khớp với nhóm và chứa trong article có nội dung hoặc tác giả khớp)
   const curAnchors = document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/pending_posts/"]');
   for (const a of curAnchors) {
    const rawHref = a.getAttribute('href') || a.href || '';
    const clean = cleanFacebookPostUrl(rawHref);
    if (clean && !beforePostUrls.has(clean) && isPostUrlMatchingGroup(clean, job.url)) {
     const parentArt = a.closest('div[role="article"]');
     if (parentArt) {
      const pText = (parentArt.innerText || '').toLowerCase();
      const isPinned = pText.includes('đáng chú ý') || pText.includes('bài viết được ghim') || pText.includes('pinned');
      if (!isPinned && ((textSnippet && pText.includes(textSnippet)) || (targetAccName && pText.includes(targetAccName)))) {
       postUrl = clean;
       if (clean.includes('/pending_posts/')) isPending = true;
       break;
      }
     }
    }
   }
   if (postUrl) break;

   await delay(350);
   alerts = getAlertsText();
   if (/pending approval|chờ phê duyệt|chờ duyệt|submitted for approval/i.test(alerts)) isPending = true;
   if (/temporarily blocked|tạm thời bị chặn|tạm thời bị hạn chế|bạn đang thao tác quá nhanh|going too fast|you.re temporarily restricted|misuse|violation/i.test(alerts)) {
    return { status: 'blocked', note: '🛑 Facebook cảnh báo spam hoặc thao tác nhanh! Đã dừng chiến dịch để bảo vệ tài khoản.' };
   }
  }

  // Link dự phòng trực tiếp đến bài viết của người dùng trong nhóm này nếu không lấy được permalink tuyệt đối
  const cleanGroupUrl = (job.url || '').replace(/\/+$/, '');
  const fallbackYourPostsUrl = cleanGroupUrl ? `${cleanGroupUrl}/your_posts/` : '';

  if (isPending) {
   return {
    status: 'pending',
    note: postUrl ? 'Facebook thông báo bài viết đang chờ quản trị viên phê duyệt.' : 'Facebook thông báo bài viết đang chờ duyệt.',
    postUrl: postUrl || fallbackYourPostsUrl
   };
  }

  if (postUrl) {
   return {
    status: 'submitted',
    note: 'Đã đăng bài thành công (Đã lưu link bài viết).',
    postUrl
   };
  }

  if (/post (has been )?(published|shared)|đã đăng bài|bài viết đã được đăng/i.test(alerts)) {
   return {
    status: 'submitted',
    note: 'Facebook thông báo đã gửi bài viết thành công.',
    postUrl: fallbackYourPostsUrl
   };
  }

  return {
   status: 'submitted',
   note: 'Đã bấm Đăng và ô tạo bài đã đóng thành công.',
   postUrl: fallbackYourPostsUrl
  };
  }catch(e){
   const msg=e.message||'';
   if (/^Bỏ qua:|^Đã bỏ qua/i.test(msg)) {
    return {status: 'skipped', note: msg};
   }
   const isBlocked=/cảnh báo spam|checkpoint|tạm thời bị chặn|tạm thời bị hạn chế/i.test(msg);
   return {status:isBlocked?'blocked':(clicked?'unknown':'error'),note:msg};
  }
 }

  chrome.runtime.onMessage.addListener((m, s, r) => {
    if (m.type !== 'RUN') return;
    if (!m.job?.token) { r({ error: 'Missing job token' }); return; }
    if (seenJobs.has(m.job.token)) { r({ ignored: true }); return; }
    seenJobs.add(m.job.token);

    // Phản hồi xác nhận nhận lệnh ngay lập tức để Chrome không ngắt kết nối (timeout port)
    r({ ok: true, started: true });

    // Tiến hành đăng bài không đồng bộ và gửi kết quả về background qua RESULT
    run(m.job).then(async result => {
      await chrome.runtime.sendMessage({
        type: 'RESULT',
        token: m.job.token,
        accountId: m.job.accountId,
        ...result
      }).catch(() => {});
    }).catch(async e => {
      await chrome.runtime.sendMessage({
        type: 'RESULT',
        token: m.job.token,
        accountId: m.job.accountId,
        status: 'error',
        note: e.message || 'Lỗi xử lý bài viết'
      }).catch(() => {});
    });
    return true;
  });
})();
