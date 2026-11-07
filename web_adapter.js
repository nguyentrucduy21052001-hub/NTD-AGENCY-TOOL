/**
 * NTD Agency - Universal Web Adapter (web_adapter.js)
 * Tương thích hóa toàn bộ API chrome.* để ứng dụng chạy độc lập trên Web Browser & Web Server.
 * Hỗ trợ: chrome.storage.local, chrome.runtime, chrome.tabs, chrome.alarms, chrome.power, chrome.action
 */

(function () {
  'use strict';

  // Nếu đã chạy trong môi trường Chrome Extension thật sự có đầy đủ storage thì bỏ qua
  if (typeof window !== 'undefined' && window.chrome && window.chrome.storage && window.chrome.storage.local && window.chrome.runtime && window.chrome.runtime.id) {
    // Đã có chrome extension runtime thật
    return;
  }

  window.chrome = window.chrome || {};

  // ── 1. STORAGE EMULATION (localStorage + memory cache) ──────────────────────
  const STORAGE_PREFIX = 'ntd_store_';
  const storageListeners = new Set();

  function parseStoredValue(raw) {
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  }

  function serializeValue(val) {
    try {
      return JSON.stringify(val);
    } catch (_) {
      return String(val);
    }
  }

  const localStore = {
    async get(keys) {
      const result = {};
      try {
        if (!keys) {
          // Lấy tất cả các keys có tiền tố ntd_store_
          for (let i = 0; i < localStorage.length; i++) {
            const fullKey = localStorage.key(i);
            if (fullKey && fullKey.startsWith(STORAGE_PREFIX)) {
              const k = fullKey.slice(STORAGE_PREFIX.length);
              result[k] = parseStoredValue(localStorage.getItem(fullKey));
            }
          }
          return result;
        }

        if (typeof keys === 'string') {
          const val = parseStoredValue(localStorage.getItem(STORAGE_PREFIX + keys));
          if (val !== undefined) result[keys] = val;
          return result;
        }

        if (Array.isArray(keys)) {
          for (const k of keys) {
            const val = parseStoredValue(localStorage.getItem(STORAGE_PREFIX + k));
            if (val !== undefined) result[k] = val;
          }
          return result;
        }

        if (typeof keys === 'object') {
          for (const [k, defVal] of Object.entries(keys)) {
            const val = parseStoredValue(localStorage.getItem(STORAGE_PREFIX + k));
            result[k] = val !== undefined ? val : defVal;
          }
          return result;
        }
      } catch (e) {
        console.warn('[WebAdapter Storage get error]', e);
      }
      return result;
    },

    async set(items) {
      if (!items || typeof items !== 'object') return;
      const changes = {};

      for (const [k, newVal] of Object.entries(items)) {
        const fullKey = STORAGE_PREFIX + k;
        const oldVal = parseStoredValue(localStorage.getItem(fullKey));
        localStorage.setItem(fullKey, serializeValue(newVal));
        changes[k] = { oldValue: oldVal, newValue: newVal };
      }

      // Thông báo các listeners trong cùng tab
      storageListeners.forEach(listener => {
        try {
          listener(changes, 'local');
        } catch (e) {
          console.error(e);
        }
      });

      // Phát sóng qua BroadcastChannel cho các tab khác
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          bc.postMessage({ type: '__STORAGE_CHANGE__', changes, area: 'local' });
        }
      } catch (_) {}
    },

    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const changes = {};

      for (const k of keyList) {
        const fullKey = STORAGE_PREFIX + k;
        const oldVal = parseStoredValue(localStorage.getItem(fullKey));
        localStorage.removeItem(fullKey);
        changes[k] = { oldValue: oldVal, newValue: undefined };
      }

      storageListeners.forEach(listener => {
        try {
          listener(changes, 'local');
        } catch (e) {
          console.error(e);
        }
      });

      try {
        if (typeof BroadcastChannel !== 'undefined') {
          bc.postMessage({ type: '__STORAGE_CHANGE__', changes, area: 'local' });
        }
      } catch (_) {}
    },

    async clear() {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    }
  };

  window.chrome.storage = window.chrome.storage || {};
  window.chrome.storage.local = localStore;
  window.chrome.storage.sync = localStore; // Fallback sync về local

  window.chrome.storage.onChanged = {
    addListener(fn) {
      if (typeof fn === 'function') storageListeners.add(fn);
    },
    removeListener(fn) {
      storageListeners.delete(fn);
    }
  };

  // ── 2. RUNTIME & MESSAGE EMULATION ──────────────────────────────────────────
  const messageListeners = new Set();
  let bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('ntd_agency_web_bus');
      bc.onmessage = (event) => {
        const data = event.data;
        if (!data) return;

        if (data.type === '__STORAGE_CHANGE__') {
          storageListeners.forEach(listener => {
            try { listener(data.changes, data.area || 'local'); } catch (_) {}
          });
          return;
        }

        // Forward message to runtime listeners
        messageListeners.forEach(fn => {
          try {
            fn(data.message, { id: 'ntd_web_peer', tab: null }, (reply) => {
              if (data.replyChannel && reply !== undefined) {
                try {
                  const replyBc = new BroadcastChannel(data.replyChannel);
                  replyBc.postMessage(reply);
                  replyBc.close();
                } catch (_) {}
              }
            });
          } catch (_) {}
        });
      };
    }
  } catch (_) {}

  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.id = 'ntd-agency-webapp';

  window.chrome.runtime.getURL = function (path) {
    if (!path) return '';
    // Xóa tiền tố chrome-extension:// nếu có
    const clean = String(path).replace(/^chrome-extension:\/\/[^\/]+\//, '').replace(/^\/+/, '');
    return clean;
  };

  window.chrome.runtime.sendMessage = function (message, callback) {
    return new Promise((resolve) => {
      let resolved = false;
      const sendResponse = (resp) => {
        if (!resolved) {
          resolved = true;
          if (typeof callback === 'function') {
            try { callback(resp); } catch (_) {}
          }
          resolve(resp);
        }
      };

      // Xử lý các listeners nội bộ tab trước
      let handled = false;
      messageListeners.forEach(fn => {
        try {
          const ret = fn(message, { id: window.chrome.runtime.id }, sendResponse);
          if (ret === true) handled = true;
        } catch (e) {
          console.warn('[WebAdapter onMessage handler error]', e);
        }
      });

      // Nếu có BroadcastChannel, gửi sang các tab khác
      if (bc) {
        const replyChannelName = 'ntd_reply_' + Math.random().toString(36).slice(2);
        const replyBc = new BroadcastChannel(replyChannelName);
        replyBc.onmessage = (ev) => {
          sendResponse(ev.data);
          replyBc.close();
        };

        bc.postMessage({
          message,
          replyChannel: replyChannelName
        });
      }

      // Xử lý fallback tức thì cho các tác vụ nền khi chạy trên Web Platform
      if (!handled && message?.type) {
        if (message.type === 'MAPS_GET_STATUS' || message.type === 'FB_GROUP_GET_STATUS' || message.type === 'WARMUP_GET_STATUS') {
          setTimeout(() => { if (!resolved) sendResponse({ ok: true, running: false }); }, 20);
          return;
        }
        if (message.type === 'MAPS_STOP_SCAN' || message.type === 'FB_GROUP_STOP_SCAN' || message.type === 'WARMUP_STOP') {
          setTimeout(() => { if (!resolved) sendResponse({ ok: true, stopped: true }); }, 20);
          return;
        }
        if (message.type === 'MAPS_SHOW_TAB' || message.type === 'FB_GROUP_SHOW_TAB' || message.type === 'WARMUP_SHOW_TAB') {
          setTimeout(() => { if (!resolved) sendResponse({ ok: false, error: 'Web Platform mode' }); }, 20);
          return;
        }
        if (message.type.startsWith('MAPS_') || message.type.startsWith('FB_GROUP_') || message.type.startsWith('WARMUP_')) {
          setTimeout(() => {
            if (!resolved) {
              sendResponse({ ok: false, webFallback: true, error: 'Web environment: using direct tab runner' });
            }
          }, 150);
          return;
        }
      }

      // Timeout dự phòng nếu không có handler phản hồi
      setTimeout(() => {
        if (!resolved) {
          sendResponse({ ok: false, error: 'Web timeout: No worker listener replied' });
        }
      }, 3000);
    });
  };

  window.chrome.runtime.onMessage = {
    addListener(fn) {
      if (typeof fn === 'function') messageListeners.add(fn);
    },
    removeListener(fn) {
      messageListeners.delete(fn);
    }
  };

  // ── 3. TABS & SCRIPTING EMULATION ───────────────────────────────────────────
  let _webManagedTabWin = null;
  window.chrome.tabs = window.chrome.tabs || {
    async create({ url, active }) {
      console.log('[WebAdapter chrome.tabs.create]', url);
      try {
        _webManagedTabWin = window.open(url, 'ntd_maps_tab');
        if (active && _webManagedTabWin) _webManagedTabWin.focus();
      } catch (_) {}
      return { id: Date.now(), url, active: Boolean(active) };
    },
    async get(tabId) {
      return { id: tabId, url: window.location.href, status: 'complete' };
    },
    async update(tabId, props) {
      if (props && props.url) {
        try {
          if (!_webManagedTabWin || _webManagedTabWin.closed) {
            _webManagedTabWin = window.open(props.url, 'ntd_maps_tab');
          } else {
            _webManagedTabWin.location.href = props.url;
          }
        } catch (_) {
          _webManagedTabWin = window.open(props.url, 'ntd_maps_tab');
        }
      }
      if (props && props.active && _webManagedTabWin) {
        try { _webManagedTabWin.focus(); } catch (_) {}
      }
      return { id: tabId, ...props, status: 'complete' };
    },
    async remove(tabId) {
      try {
        if (_webManagedTabWin && !_webManagedTabWin.closed) {
          _webManagedTabWin.close();
        }
      } catch (_) {}
      _webManagedTabWin = null;
      return true;
    },
    async query() {
      return [{ id: 1, active: true, url: window.location.href }];
    }
  };

  window.chrome.scripting = window.chrome.scripting || {
    async executeScript(opts) {
      console.log('[WebAdapter chrome.scripting.executeScript]', opts);
      return [{ result: null }];
    }
  };

  // ── 4. ALARMS EMULATION ─────────────────────────────────────────────────────
  const alarmsMap = new Map();
  const alarmListeners = new Set();

  window.chrome.alarms = window.chrome.alarms || {
    create(name, alarmInfo) {
      if (alarmsMap.has(name)) {
        clearInterval(alarmsMap.get(name));
      }
      const periodInMinutes = alarmInfo?.periodInMinutes || (alarmInfo?.delayInMinutes) || 1;
      const ms = Math.max(periodInMinutes * 60 * 1000, 1000);
      const timer = setInterval(() => {
        alarmListeners.forEach(listener => {
          try { listener({ name }); } catch (_) {}
        });
      }, ms);
      alarmsMap.set(name, timer);
    },
    clear(name) {
      if (alarmsMap.has(name)) {
        clearInterval(alarmsMap.get(name));
        alarmsMap.delete(name);
      }
    },
    onAlarm: {
      addListener(fn) {
        if (typeof fn === 'function') alarmListeners.add(fn);
      },
      removeListener(fn) {
        alarmListeners.delete(fn);
      }
    }
  };

  // ── 5. POWER & ACTION EMULATION ─────────────────────────────────────────────
  window.chrome.power = window.chrome.power || {
    requestKeepAwake() {},
    releaseKeepAwake() {}
  };

  window.chrome.action = window.chrome.action || {
    setBadgeText() {},
    setBadgeBackgroundColor() {},
    setTitle() {}
  };

  window.chrome.browsingData = window.chrome.browsingData || {
    async removeCookies() { return true; }
  };

  window.chrome.cookies = window.chrome.cookies || {
    async get() { return null; },
    async getAll() { return []; },
    async set() { return true; },
    async remove() { return true; }
  };

  console.log('✅ [NTD Agency] Web Adapter đã được kích hoạt thành công!');
})();

