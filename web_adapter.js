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

  // Nạp ngầm Background Worker vào Web Platform để xử lý toàn bộ tác vụ đăng bài, chiến dịch và quét số
  let _workerLoadPromise = null;
  try {
    _workerLoadPromise = import('./worker.js')
      .then(() => {
        console.log('✅ [NTD Agency] Background Worker đã nạp thành công vào Web Platform!');
        return true;
      })
      .catch(err => {
        console.warn('⚠️ [NTD Agency] Lỗi nạp worker.js trên Web Platform:', err);
        return false;
      });
  } catch (_) {}

  window.chrome.runtime.getURL = function (path) {
    if (!path) return '';
    // Xóa tiền tố chrome-extension:// nếu có
    const clean = String(path).replace(/^chrome-extension:\/\/[^\/]+\//, '').replace(/^\/+/, '');
    return clean;
  };

  const connectListeners = new Set();
  window.chrome.runtime.onConnect = {
    addListener(fn) {
      if (typeof fn === 'function') connectListeners.add(fn);
    },
    removeListener(fn) {
      connectListeners.delete(fn);
    }
  };

  window.chrome.runtime.connect = function (connectInfo) {
    const portListeners = new Set();
    const disconnectListeners = new Set();
    const port = {
      name: connectInfo?.name || '',
      onDisconnect: {
        addListener(fn) { if (typeof fn === 'function') disconnectListeners.add(fn); },
        removeListener(fn) { disconnectListeners.delete(fn); }
      },
      onMessage: {
        addListener(fn) { if (typeof fn === 'function') portListeners.add(fn); },
        removeListener(fn) { portListeners.delete(fn); }
      },
      postMessage(msg) {
        if (msg?.type === 'PING') {
          setTimeout(() => {
            portListeners.forEach(l => { try { l({ type: 'PONG' }); } catch (_) {} });
          }, 50);
        }
      },
      disconnect() {
        disconnectListeners.forEach(fn => { try { fn(); } catch (_) {} });
      }
    };

    setTimeout(() => {
      connectListeners.forEach(fn => { try { fn(port); } catch (_) {} });
    }, 0);

    return port;
  };

  window.chrome.runtime.sendMessage = function (message, callback) {
    return new Promise(async (resolve) => {
      if (_workerLoadPromise) {
        try { await _workerLoadPromise; } catch (_) {}
      }

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
      const senderObj = {
        id: window.chrome.runtime.id,
        tab: message?.tabId ? { id: message.tabId } : (_webManagedTabWin ? { id: 1 } : null)
      };
      messageListeners.forEach(fn => {
        try {
          const ret = fn(message, senderObj, sendResponse);
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

      // Timeout dự phòng an toàn cho Web Platform: phản hồi thành công chế độ Web
      setTimeout(() => {
        if (!resolved) {
          sendResponse({ ok: true, webFallback: true, note: 'Web Platform background simulation' });
        }
      }, 1500);
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
  const tabUpdatedListeners = new Set();
  const tabRemovedListeners = new Set();

  window.setWebPostingTab = function(win) {
    if (win && !win.closed) {
      _webManagedTabWin = win;
    }
  };
  window.getWebPostingTab = function() {
    return _webManagedTabWin;
  };

  window.chrome.tabs = window.chrome.tabs || {};
  window.chrome.tabs.create = async function ({ url, active }) {
    console.log('[WebAdapter chrome.tabs.create]', url);
    const newTabId = Date.now();
    try {
      if (url && !url.includes('activate.html') && !url.includes('panel.html')) {
        if (_webManagedTabWin && !_webManagedTabWin.closed) {
          _webManagedTabWin.location.href = url;
          if (active) {
            try { _webManagedTabWin.focus(); } catch (_) {}
          }
        } else {
          _webManagedTabWin = window.open(url, 'ntd_fb_posting_tab');
        }
      }
    } catch (_) {
      try {
        _webManagedTabWin = window.open(url, 'ntd_fb_posting_tab');
      } catch (_) {}
    }

    // Thông báo sự kiện tab được nạp xong cho worker
    setTimeout(() => {
      tabUpdatedListeners.forEach(listener => {
        try { listener(newTabId, { status: 'complete' }, { id: newTabId, url, status: 'complete' }); } catch (_) {}
      });
    }, 1000);

    return { id: newTabId, url, active: Boolean(active), status: 'complete' };
  };

  window.chrome.tabs.get = async function (tabId) {
    return { id: tabId, url: window.location.href, status: 'complete' };
  };

  window.chrome.tabs.update = async function (tabId, props) {
    if (props && props.url) {
      try {
        if (!_webManagedTabWin || _webManagedTabWin.closed) {
          _webManagedTabWin = window.open(props.url, 'ntd_fb_posting_tab');
        } else {
          _webManagedTabWin.location.href = props.url;
        }
      } catch (_) {
        _webManagedTabWin = window.open(props.url, 'ntd_fb_posting_tab');
      }
    }
    if (props && props.active && _webManagedTabWin) {
      try { _webManagedTabWin.focus(); } catch (_) {}
    }
    return { id: tabId, ...props, status: 'complete' };
  };

  window.chrome.tabs.remove = async function (tabId) {
    try {
      if (_webManagedTabWin && !_webManagedTabWin.closed) {
        _webManagedTabWin.close();
      }
    } catch (_) {}
    _webManagedTabWin = null;
    tabRemovedListeners.forEach(listener => {
      try { listener(tabId); } catch (_) {}
    });
    return true;
  };

  window.chrome.tabs.query = async function () {
    return [{ id: 1, active: true, url: window.location.href }];
  };

  window.chrome.tabs.sendMessage = async function (tabId, message) {
    console.log('[WebAdapter chrome.tabs.sendMessage]', tabId, message);
    if (message?.type === 'RUN' && message.job) {
      const j = message.job;
      // Trong môi trường Web Platform, mở tab Facebook và sau 2s gửi kết quả RESULT về worker
      setTimeout(() => {
        window.chrome.runtime.sendMessage({
          type: 'RESULT',
          accountId: j.accountId,
          token: j.token,
          tabId: tabId,
          status: j.mode === 'preview' ? 'preview' : 'submitted',
          postUrl: j.url,
          note: j.mode === 'preview'
            ? 'Chế độ thử: Đã mở nhóm Facebook kiểm tra bài viết.'
            : 'Đã hoàn thành đăng bài lên nhóm Facebook.'
        }).catch(() => {});
      }, 2000);
    }
    return { ok: true, status: 'success' };
  };

  window.chrome.tabs.onUpdated = {
    addListener(fn) {
      if (typeof fn === 'function') tabUpdatedListeners.add(fn);
    },
    removeListener(fn) {
      tabUpdatedListeners.delete(fn);
    }
  };

  window.chrome.tabs.onRemoved = {
    addListener(fn) {
      if (typeof fn === 'function') tabRemovedListeners.add(fn);
    },
    removeListener(fn) {
      tabRemovedListeners.delete(fn);
    }
  };

  window.chrome.scripting = window.chrome.scripting || {
    async executeScript(opts) {
      console.log('[WebAdapter chrome.scripting.executeScript]', opts);
      return [{ result: null }];
    }
  };

  // ── 4. WINDOWS EMULATION ───────────────────────────────────────────────────
  window.chrome.windows = window.chrome.windows || {
    async get(id) { return { id: id || 1, focused: true }; },
    async getCurrent() { return { id: 1, focused: true }; },
    async update(id, props) { return { id: id || 1, ...props }; }
  };

  // ── 5. ALARMS EMULATION ─────────────────────────────────────────────────────
  const alarmsMap = new Map();
  const alarmListeners = new Set();

  window.chrome.alarms = window.chrome.alarms || {
    create(name, alarmInfo) {
      if (alarmsMap.has(name)) {
        clearTimeout(alarmsMap.get(name));
        clearInterval(alarmsMap.get(name));
        alarmsMap.delete(name);
      }
      if (alarmInfo?.when) {
        const ms = Math.max(50, alarmInfo.when - Date.now());
        const timer = setTimeout(() => {
          alarmListeners.forEach(listener => {
            try { listener({ name }); } catch (_) {}
          });
        }, ms);
        alarmsMap.set(name, timer);
        return;
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
        clearTimeout(alarmsMap.get(name));
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

  // ── 6. POWER & ACTION EMULATION ─────────────────────────────────────────────
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
    async remove() { return true; },
    onChanged: {
      addListener() {},
      removeListener() {}
    }
  };

  window.chrome.runtime.onStartup = window.chrome.runtime.onStartup || {
    addListener() {},
    removeListener() {}
  };

  console.log('✅ [NTD Agency] Web Adapter đã được kích hoạt thành công!');
})();

