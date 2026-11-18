// fb_login_guard.js – Chặn popup Google Password Manager ("Đăng nhập vào www.facebook.com")
// khi Facebook ở trạng thái chưa đăng nhập để không cản trở quá trình chuyển nick & đăng nhập tự động.
(() => {
  if (globalThis.__ntdFbLoginGuardInstalled) return;
  globalThis.__ntdFbLoginGuardInstalled = true;

  try {
    const isLoggedOutCookie = () => {
      try {
        return !(document.cookie && /(?:^|;\s*)c_user=\d+/.test(document.cookie));
      } catch (_) {
        return true;
      }
    };

    const creds = navigator && navigator.credentials;
    if (creds && typeof creds.get === 'function') {
      const origGet = creds.get.bind(creds);
      const guardedGet = function(options) {
        try {
          // Chặn hộp thoại tự động chọn tài khoản Google Password Manager / FedCM khi trang đang ở màn hình đăng nhập
          const isPasswordOrFedCm = !options || Boolean(options.password || options.federated || options.identity);
          if (isPasswordOrFedCm && isLoggedOutCookie()) {
            return Promise.resolve(null);
          }
        } catch (_) {}
        return origGet(options);
      };

      try {
        Object.defineProperty(creds, 'get', {
          value: guardedGet,
          configurable: true,
          writable: true
        });
      } catch (_) {
        try {
          creds.get = guardedGet;
        } catch (_) {}
      }
    }

    if (creds && typeof creds.preventSilentAccess === 'function') {
      try {
        if (isLoggedOutCookie()) {
          creds.preventSilentAccess().catch(() => {});
        }
      } catch (_) {}
    }
  } catch (_) {}
})();
