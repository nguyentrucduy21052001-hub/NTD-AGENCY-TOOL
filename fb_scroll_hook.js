// NTD Agency - Facebook Background Scroll & Wakeup Hook
// Chạy trực tiếp trong MAIN world của Facebook ngay từ document_start
// Đảm bảo không bị Chrome đóng băng khi tab ở chế độ nền (Inactive/Background)
(function() {
  'use strict';
  if (window.__ntdScrollHookInstalled) return;
  window.__ntdScrollHookInstalled = true;

  // 1. Luôn giả lập tab đang active và visible trong mắt Facebook scripts & React 18
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
  } catch (_) {}
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  } catch (_) {}
  try {
    document.hasFocus = () => true;
    window.hasFocus = () => true;
  } catch (_) {}

  // 2. Polyfill requestAnimationFrame khi tab ở background
  // Chrome dừng rAF (0 FPS) ở tab ngầm. Polyfill này dùng setTimeout (20ms) fallback
  // để React 18 Scheduler và Relay GraphQL không bao giờ bị đứng
  const origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  window.requestAnimationFrame = function(cb) {
    let executed = false;
    const timer = setTimeout(() => {
      if (!executed) {
        executed = true;
        try { cb(performance.now()); } catch (_) {}
      }
    }, 20);
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

  // 3. Intercept & Hook IntersectionObserver để tự động kích hoạt callback ngay cả khi Chromium dừng render tab nền
  window.__ntdActiveObservers = window.__ntdActiveObservers || [];
  if (window.IntersectionObserver) {
    const OrigIO = window.IntersectionObserver;
    window.IntersectionObserver = function(callback, options) {
      const inst = new OrigIO(callback, options);
      const record = { callback, options, targets: new Set(), inst };
      window.__ntdActiveObservers.push(record);

      const origObs = inst.observe.bind(inst);
      inst.observe = function(t) {
        if (t && t.nodeType === 1) record.targets.add(t);
        return origObs(t);
      };
      const origUnobs = inst.unobserve.bind(inst);
      inst.unobserve = function(t) {
        if (t) record.targets.delete(t);
        return origUnobs(t);
      };
      const origDisc = inst.disconnect.bind(inst);
      inst.disconnect = function() {
        record.targets.clear();
        const idx = window.__ntdActiveObservers.indexOf(record);
        if (idx !== -1) window.__ntdActiveObservers.splice(idx, 1);
        return origDisc();
      };
      return inst;
    };
    window.IntersectionObserver.prototype = OrigIO.prototype;
  }

  // 4. Kích hoạt thủ công tất cả observer đang theo dõi các phần tử cuối trang / sentinel
  window.__ntdTriggerSentinels = function() {
    if (!window.__ntdActiveObservers || !window.__ntdActiveObservers.length) return;
    for (const rec of window.__ntdActiveObservers) {
      for (const target of rec.targets) {
        if (!target.isConnected) {
          rec.targets.delete(target);
          continue;
        }
        try {
          const rect = target.getBoundingClientRect();
          rec.callback([
            {
              isIntersecting: true,
              intersectionRatio: 1,
              target: target,
              time: performance.now(),
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null
            }
          ], rec.inst);
        } catch (_) {}
      }
    }
  };

  // Tự động kích hoạt khi có sự kiện cuộn
  window.addEventListener('scroll', () => {
    try { window.__ntdTriggerSentinels(); } catch (_) {}
  }, { passive: true });
  window.addEventListener('wheel', () => {
    try { window.__ntdTriggerSentinels(); } catch (_) {}
  }, { passive: true });

  // 5. Tự động cuộn & trích xuất nhóm Facebook trên trang Tìm kiếm
  if (window.location.pathname.includes('/search')) {
    let scanActive = true;
    const scannedGroupUrls = new Set();

    function normGroupUrl(href) {
      if (!href) return null;
      try {
        const u = new URL(href, window.location.origin);
        if (!['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(u.hostname)) return null;
        const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)/i);
        if (!m || ['feed', 'discover', 'joins', 'create', 'search'].includes(m[1].toLowerCase())) return null;
        return `https://www.facebook.com/groups/${m[1].toLowerCase()}/`;
      } catch (_) {
        return null;
      }
    }

    function parseMemberCount(str) {
      if (!str) return 0;
      const clean = String(str).toLowerCase().trim();
      const m = clean.match(/([\d.,]+)\s*(triệu|nghìn|ngàn|tỷ|tr|[kmb])?/i);
      if (!m) return 0;
      let numStr = m[1].replace(/,/g, '.');
      if ((numStr.match(/\./g) || []).length > 1) {
        numStr = numStr.replace(/\./g, '');
      }
      let num = parseFloat(numStr);
      if (isNaN(num)) return 0;
      const unit = m[2] ? m[2].toLowerCase() : '';
      if (unit === 'k' || unit === 'nghìn' || unit === 'ngàn') num *= 1000;
      else if (unit === 'm' || unit === 'triệu' || unit === 'tr') num *= 1000000;
      else if (unit === 'b' || unit === 'tỷ') num *= 1000000000;
      return Math.round(num);
    }

    function doExtractAndScroll() {
      if (!scanActive) return;

      const anchors = document.querySelectorAll('a[href*="/groups/"]');
      for (const a of anchors) {
        const rawHref = a.getAttribute('href') || a.href;
        const cleanUrl = normGroupUrl(rawHref);
        if (!cleanUrl || scannedGroupUrls.has(cleanUrl)) continue;

        let container = a.closest('[role="article"]') ||
                        a.closest('[data-virtualized]') ||
                        a.closest('div[role="feed"] > div') ||
                        a.parentElement?.parentElement?.parentElement?.parentElement;

        let cardText = container ? container.innerText : (a.parentElement?.innerText || '');

        let name = (a.innerText || a.textContent || '').trim().replace(/\r?\n.*/s, '').trim();
        if (!name || name.length < 2) {
          const heading = container?.querySelector('h2, h3, [role="heading"], strong');
          if (heading) name = heading.innerText.trim();
        }
        if (!name) {
          const m = cleanUrl.match(/\/groups\/([^\/]+)\//);
          name = m ? m[1] : 'Nhóm Facebook';
        }

        let privacy = 'Công khai';
        if (/riêng tư|private/i.test(cardText)) {
          privacy = 'Riêng tư';
        } else if (/công khai|public/i.test(cardText)) {
          privacy = 'Công khai';
        }

        let members = '';
        const memMatch = cardText.match(/([\d.,]+\s*(?:triệu|nghìn|ngàn|tỷ|tr|[kmKmMbB])?)\s*(thành viên|members|người theo dõi|followers)/i);
        if (memMatch) {
          members = memMatch[1].trim() + ' thành viên';
        } else {
          const subMatch = cardText.match(/·\s*([^·\n]+(?:thành viên|members)[^·\n]*)/i);
          if (subMatch) members = subMatch[1].trim();
        }

        scannedGroupUrls.add(cleanUrl);

        const groupObj = {
          id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: name.slice(0, 90),
          url: cleanUrl,
          privacy,
          members: members || 'Đang cập nhật',
          memberCount: parseMemberCount(members),
          selected: true
        };

        // Gửi về Opener Window (groups.html trên Web)
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
              source: 'ntd_fb_search_tab',
              type: 'GROUP_SEARCH_ITEM',
              group: groupObj
            }, '*');
          }
        } catch (_) {}

        // Gửi qua chrome.runtime nếu có
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({
              type: 'GROUP_SEARCH_ITEM',
              group: groupObj
            }).catch(() => {});
          }
        } catch (_) {}
      }

      // Tự động cuộn trang để Facebook load thêm bài
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

      // Gửi báo cáo tiến trình
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({
            source: 'ntd_fb_search_tab',
            type: 'GROUP_SEARCH_PROGRESS',
            count: scannedGroupUrls.size
          }, '*');
        }
      } catch (_) {}
    }

    // Lắng nghe lệnh dừng
    window.addEventListener('message', (e) => {
      if (e.data && e.data.action === 'STOP_GROUP_SEARCH') {
        scanActive = false;
      }
    });

    // Bắt đầu quét lặp tự động sau khi trang load
    setTimeout(() => {
      doExtractAndScroll();
      const interval = setInterval(() => {
        if (!scanActive) {
          clearInterval(interval);
          return;
        }
        doExtractAndScroll();
      }, 1500);
    }, 1500);
  }
})();

