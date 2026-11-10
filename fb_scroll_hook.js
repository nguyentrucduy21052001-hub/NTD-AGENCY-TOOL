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
    const RESERVED = new Set([
      'feed', 'discover', 'joins', 'joined', 'create', 'search', 'category',
      'categories', 'notifications', 'requests', 'invitations', 'invites',
      'your_posts', 'pending_posts', 'settings', 'insights', 'groups', 'browse'
    ]);
    const REJECT_TEXT = /^(?:tham gia(?:\s+nhóm)?|join(?:\s+group)?|đã tham gia|joined|xem nhóm|view group|mở|open|đang chờ|pending|hủy yêu cầu)$/i;
    const META_LINE = /^(?:công khai|riêng tư|không công khai|nhóm công khai|nhóm riêng tư|public(?:\s+group)?|private(?:\s+group)?|\d[\d.,]*\s*(?:k|m|tr|triệu|nghìn|ngàn)?\+?\s*(?:thành viên|members?)|[\d+]+\s*bài viết|\d+\s*người bạn.*)$/i;

    function normGroupUrl(href) {
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
        const u = normGroupUrl(links[i].getAttribute('href') || links[i].href);
        if (u) {
          s.add(u);
          if (s.size > 1) return s;
        }
      }
      return s;
    }

    function doExtractAndScroll() {
      if (!scanActive) return;

      const anchors = document.querySelectorAll('a[href*="/groups/"]');
      const anchorsByUrl = new Map();
      for (const a of anchors) {
        const cleanUrl = normGroupUrl(a.getAttribute('href') || a.href);
        if (!cleanUrl || scannedGroupUrls.has(cleanUrl)) continue;
        if (!anchorsByUrl.has(cleanUrl)) anchorsByUrl.set(cleanUrl, []);
        anchorsByUrl.get(cleanUrl).push(a);
      }

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
          if ((curr.innerText || '').length > 1200) break;
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

        scannedGroupUrls.add(cleanUrl);

        const groupObj = {
          id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: name.slice(0, 120),
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

