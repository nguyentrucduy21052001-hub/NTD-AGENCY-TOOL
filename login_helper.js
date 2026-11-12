// login_helper.js – Content script chạy trên trang Facebook login
// Được inject bởi worker khi user thêm tài khoản qua username/password
(()=>{
  if(globalThis.__duyLoginHelper) return;
  globalThis.__duyLoginHelper = true;

  const delay = ms => new Promise(r => setTimeout(r, ms));

  function isVisibleElement(el) {
    if (!el || el.disabled) return false;
    if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return false;
    if (el.closest?.('[hidden], [aria-hidden="true"]')) return false;
    const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    return true;
  }

  function pickPreferredElement(candidates) {
    const visible = [...candidates].filter(isVisibleElement);
    return visible.find(el => el.offsetWidth > 0 || el.offsetHeight > 0) || visible[0] || null;
  }

  function getFieldDescriptor(el) {
    return [
      el.id,
      el.name,
      el.getAttribute?.('placeholder'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('autocomplete'),
      el.getAttribute?.('data-testid')
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function setNativeInputValue(input, value, prevValue) {
    const proto = input?.ownerDocument?.defaultView?.HTMLInputElement?.prototype || HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const tracker = input._valueTracker;
    if (tracker && typeof tracker.setValue === 'function' && prevValue !== undefined) {
      tracker.setValue(prevValue);
    }
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
  }

  function dispatchInputEvent(input, ch) {
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: ch ? 'insertText' : 'deleteContentBackward',
        data: ch || null
      }));
    } catch (_) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async function typeInto(input, text) {
    const str = String(text ?? '');
    input.focus();
    setNativeInputValue(input, '', input.value);
    dispatchInputEvent(input, '');

    let cur = '';
    for (const ch of str) {
      const prev = cur;
      cur += ch;
      setNativeInputValue(input, cur, prev);
      dispatchInputEvent(input, ch);
      await delay(15 + Math.random() * 25);
    }
    if (input.value !== str) {
      setNativeInputValue(input, str, '');
      dispatchInputEvent(input, str);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dismissModals() {
    // Tự đóng các popup như "Nhớ mật khẩu" -> "Lúc khác" / "Not Now" hoặc banner cookie
    const scopeSelectors = '[role="dialog"] [role="button"], [role="dialog"] button, [data-testid*="cookie"] [role="button"], [data-testid*="cookie"] button, [role="button"], button';
    const buttons = [...document.querySelectorAll(scopeSelectors)];
    const dismissBtn = buttons.find(el => {
      if (!isVisibleElement(el)) return false;
      const inDialog = Boolean(el.closest('[role="dialog"], [data-testid*="cookie"]'));
      const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (t === 'lúc khác' || t === 'not now') return true;
      if (inDialog && (t === 'đóng' || t === 'close' || t.includes('từ chối cookie') || t.includes('decline optional cookies') || t.includes('allow all cookies') || t.includes('cho phép tất cả cookie'))) {
        return true;
      }
      return false;
    });
    if (dismissBtn) {
      try { dismissBtn.click(); } catch (_) {}
    }
  }

  function findPasswordInput() {
    const direct = pickPreferredElement(
      document.querySelectorAll('#pass, input[name="pass"], input[type="password"], input[autocomplete="current-password"]')
    );
    if (direct) return direct;

    return pickPreferredElement(
      [...document.querySelectorAll('input')].filter(el => {
        const desc = getFieldDescriptor(el);
        return /mật khẩu|mat khau|password/.test(desc);
      })
    );
  }

  function findEmailInput(passInput = null) {
    const direct = pickPreferredElement(
      document.querySelectorAll('#email, input[name="email"], input[type="email"], input[autocomplete*="username"], input[autocomplete="email"]')
    );
    if (direct) return direct;

    const nonPasswordInputs = [...document.querySelectorAll('input')].filter(el => {
      const type = String(el.type || 'text').toLowerCase();
      return !['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'image'].includes(type);
    });

    const semanticMatch = pickPreferredElement(
      nonPasswordInputs.filter(el => {
        const desc = getFieldDescriptor(el);
        return /email|số di động|di động|số điện thoại|điện thoại|phone|mobile|tài khoản|tai khoan|account|username|uid/.test(desc);
      })
    );
    if (semanticMatch) return semanticMatch;

    // Fallback cấu trúc cho Comet Meta UI: ô nhập liệu ngay phía trên/cùng form với ô Mật khẩu
    if (passInput) {
      let container = passInput.closest('form') || passInput.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        const localInputs = [...container.querySelectorAll('input')].filter(el => {
          if (el === passInput) return false;
          const type = String(el.type || 'text').toLowerCase();
          return ['text', 'email', 'tel', 'search', ''].includes(type);
        });
        const match = pickPreferredElement(localInputs);
        if (match) return match;
        container = container.parentElement;
      }
    }

    return null;
  }

  function findLoginFields() {
    const passInput = findPasswordInput();
    const emailInput = findEmailInput(passInput);
    return { emailInput, passInput };
  }

  function findLoginButton(passInput = null) {
    const scopes = [];
    const form = passInput?.closest?.('form');
    if (form) scopes.push(form);
    scopes.push(document);

    for (const scope of scopes) {
      const directBtn = pickPreferredElement(
        scope.querySelectorAll('[name="login"], #loginbutton, [data-testid="royal_login_button"], [data-testid="royal-login-button"], button[type="submit"], input[type="submit"]')
      );
      if (directBtn) return directBtn;

      const textMatches = [...scope.querySelectorAll('button, [role="button"], input[type="button"], a[role="button"]')].filter(b => {
        const text = (b.innerText || b.textContent || b.getAttribute('aria-label') || b.value || '').trim();
        return /^(Đăng\s*nhập|Log\s*In|Log\s*in|Sign\s*In)$/i.test(text);
      });
      const textBtn = pickPreferredElement(textMatches);
      if (textBtn) return textBtn;
    }

    return null;
  }

  function isOldAccountLoggedIn() {
    const { emailInput, passInput } = findLoginFields();
    if (emailInput || passInput) return false;
    return !!(
      location.pathname.includes('/home') ||
      document.querySelector('[data-pagelet="Feed"], [role="feed"]') ||
      document.querySelector('[role="navigation"] [aria-label*="Trang cá nhân của bạn"], [role="navigation"] [aria-label*="Your profile"]') ||
      document.querySelector('[role="navigation"] [aria-label*="Tài khoản"], [role="navigation"] [aria-label*="Account"]')
    );
  }

  async function tryLogoutOldAccount() {
    dismissModals();
    await delay(300);

    // Tìm nút avatar tài khoản góc trên bên phải
    const profileBtn = document.querySelector(
      '[aria-label*="Trang cá nhân của bạn"], ' +
      '[aria-label*="Your profile"], ' +
      '[aria-label*="Tài khoản"], ' +
      '[aria-label*="Account"], ' +
      'div[role="navigation"] div[role="button"][tabindex="0"]'
    );

    if (profileBtn) {
      profileBtn.click();
      await delay(1200);

      // Tìm nút "Đăng xuất" trong menu thả xuống
      const items = [...document.querySelectorAll('[role="button"], [role="menuitem"], span, div')];
      const logoutBtn = items.find(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return /^(Đăng xuất|Log Out|Log out)$/i.test(text);
      });

      if (logoutBtn) {
        logoutBtn.click();
        await delay(3000);
        return true;
      }
    }

    // Nếu không bấm được menu, chuyển hướng trực tiếp đến trang login
    location.href = 'https://www.facebook.com/login.php';
    await delay(2500);
    return true;
  }

  async function doLogin(email, password) {
    try {
      dismissModals();

      // 1. Kiểm tra nếu tài khoản cũ vẫn còn đăng nhập
      if (isOldAccountLoggedIn()) {
        await tryLogoutOldAccount();
        // Chờ trang đăng nhập xuất hiện sau khi đăng xuất
        await delay(2000);
      }

      // 2. Chờ form đăng nhập hoặc nút "Đăng nhập bằng tài khoản khác"
      const endWaitForm = Date.now() + 15000;
      let emailInput = null;
      let passInput = null;

      while (Date.now() < endWaitForm) {
        dismissModals();

        ({ emailInput, passInput } = findLoginFields());
        if (!emailInput || !passInput) {
          const switchBtn = [...document.querySelectorAll('a, button, [role="button"]')].find(el => {
            if (!isVisibleElement(el)) return false;
            const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
            return t.includes('tài khoản khác') || t.includes('another account') || t.includes('dùng tài khoản khác') || t.includes('thêm tài khoản') || t.includes('switch account');
          });
          if (switchBtn) {
            switchBtn.click();
            await delay(1000);
            ({ emailInput, passInput } = findLoginFields());
          }
        }

        if (emailInput && passInput) break;

        // Nếu phát hiện vẫn đang ở giao diện cũ đã đăng nhập, thử đăng xuất lại
        if (isOldAccountLoggedIn()) {
          await tryLogoutOldAccount();
        }

        await delay(500);
      }

      if (!emailInput || !passInput) {
        return {
          ok: false,
          error: `Không tìm thấy form đăng nhập (${location.hostname}${location.pathname}, inputs=${document.querySelectorAll('input').length}). Vui lòng kiểm tra lại tab Facebook hoặc dùng tab Paste Cookies.`
        };
      }

      // 3. Điền email & password
      await typeInto(emailInput, email);
      await delay(250 + Math.random() * 150);

      await typeInto(passInput, password);
      await delay(250 + Math.random() * 150);

      // 4. Tìm và chờ nút Đăng nhập sẵn sàng (React Comet có thể bật aria-disabled trong tích tắc)
      let loginBtn = findLoginButton(passInput);
      const waitEnableEnd = Date.now() + 800;
      while (loginBtn && (loginBtn.disabled || loginBtn.getAttribute('aria-disabled') === 'true') && Date.now() < waitEnableEnd) {
        await delay(100);
        loginBtn = findLoginButton(passInput) || loginBtn;
      }

      const form = passInput.closest?.('form') || emailInput.closest?.('form') || null;
      if (!loginBtn && !form) {
        return { ok: false, error: 'Không tìm thấy nút Đăng nhập.' };
      }

      // Bấm nút đăng nhập sau 60ms để hàm kịp trả lời kết quả về worker.js
      // Điều này ngăn chặn việc đứt gãy message channel khi trang bắt đầu chuyển hướng (navigation)
      setTimeout(() => {
        try {
          if (loginBtn && !loginBtn.disabled && loginBtn.getAttribute('aria-disabled') !== 'true') {
            loginBtn.click();
          } else if (form) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit(loginBtn || undefined);
            else form.submit();
          } else {
            passInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            passInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            loginBtn?.click?.();
          }
        } catch (_) {}
      }, 60);

      return { ok: true, submitted: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function submit2FACode(code) {
    if (!code) return { ok: false, error: 'Mã 2FA rỗng.' };
    try {
      dismissModals();
      for (let attempt = 0; attempt < 15; attempt++) {
        // Tìm ô nhập mã 2FA (cả giao diện classic & Comet two_step_verification)
        const direct2fa = pickPreferredElement(
          document.querySelectorAll('#approvals_code, input[name="approvals_code"], input[autocomplete="one-time-code"], input[placeholder*="mã" i], input[placeholder*="code" i]')
        );
        const input = direct2fa || pickPreferredElement(
          [...document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input:not([type])')].filter(el => {
            const desc = getFieldDescriptor(el);
            return /code|approv|mã|xác thực|otp|totp|digit|chữ số/.test(desc);
          })
        );

        if (input) {
          await typeInto(input, String(code).trim());
          await delay(300);

          const submitBtn = pickPreferredElement(
            document.querySelectorAll('#checkpointSubmitButton, button[name="submit[Continue]"], button[type="submit"], input[type="submit"]')
          ) || pickPreferredElement(
            [...document.querySelectorAll('button, [role="button"]')].filter(b =>
              /^(Tiếp tục|Continue|Xác nhận|Confirm|Submit|Gửi|Tiếp)$/i.test((b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim())
            )
          );

          if (submitBtn) {
            submitBtn.click();
            await delay(1500);

            // Tự động bấm qua các bước phụ "Tin cậy thiết bị" / "Lưu trình duyệt" / "Đây là tôi"
            setTimeout(() => {
              const nextBtn = pickPreferredElement(
                document.querySelectorAll('#checkpointSubmitButton, button[name="submit[Continue]"], button[name="submit[This was me]"]')
              ) || pickPreferredElement(
                [...document.querySelectorAll('button, [role="button"]')].filter(b =>
                  /^(Tiếp tục|Continue|Đây là tôi|This was me|Tin cậy thiết bị này|Trust this device|Lưu trình duyệt|Save browser|Luôn xác nhận|Always confirm)$/i.test((b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim())
                )
              );
              if (nextBtn) {
                try { nextBtn.click(); } catch (_) {}
              }
            }, 1800);

            return { ok: true };
          }
        }
        await delay(500);
      }
      return { ok: false, error: 'Không tìm thấy ô nhập 2FA trên trang.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m.type === 'DO_LOGIN') {
      doLogin(m.email, m.password).then(reply);
      return true;
    }
    if (m.type === 'SUBMIT_2FA') {
      submit2FACode(m.code).then(reply);
      return true;
    }
  });
})();
