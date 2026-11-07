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
})();

