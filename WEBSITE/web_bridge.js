/**
 * NTD Agency - Web Bridge (web_bridge.js)
 * Cầu nối giữa giao diện Web Platform (nguyentrucduy21052001-hub.github.io, vercel, localhost)
 * và Tiện ích mở rộng Chrome Extension (Background Service Worker).
 * Giúp Web Platform điều khiển trực tiếp các tác vụ tự động hóa Facebook & Google Maps với đầy đủ quyền Extension.
 */

(function () {
  'use strict';

  if (window.__ntd_bridge_loaded) return;
  window.__ntd_bridge_loaded = true;

  // Đánh dấu trạng thái Extension đã được kết nối lên DOM
  const extId = chrome.runtime?.id || 'installed';
  document.documentElement.dataset.ntdExtensionConnected = 'true';
  document.documentElement.dataset.ntdExtensionId = extId;

  // Phát sự kiện báo cho trang Web biết Extension Runner đã sẵn sàng
  window.dispatchEvent(new CustomEvent('NTD_EXTENSION_READY', {
    detail: { extensionId: extId }
  }));

  // Lắng nghe yêu cầu từ trang Web (qua window.postMessage) và chuyển tiếp tới Extension Background Worker
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ntd_web_page') return;

    if (e.data.action === 'PING_EXTENSION') {
      window.postMessage({
        source: 'ntd_extension_bridge',
        action: 'PONG',
        extensionId: extId
      }, '*');
      return;
    }

    if (e.data.action === 'CALL_EXTENSION_WORKER') {
      try {
        const response = await chrome.runtime.sendMessage(e.data.payload);
        window.postMessage({
          source: 'ntd_extension_bridge',
          requestId: e.data.requestId,
          success: true,
          response
        }, '*');
      } catch (err) {
        window.postMessage({
          source: 'ntd_extension_bridge',
          requestId: e.data.requestId,
          success: false,
          error: err ? err.message : 'Extension worker error'
        }, '*');
      }
    }
  });

  // Lắng nghe sự kiện từ Background Worker và phát ngược lại cho trang Web
  if (chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((msg) => {
      try {
        window.postMessage({
          source: 'ntd_extension_bridge',
          action: 'WORKER_EVENT',
          payload: msg
        }, '*');
      } catch (_) {}
    });
  }
})();
