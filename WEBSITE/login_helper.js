// login_helper.js – Content script chạy trên trang Facebook login
// Được inject bởi worker khi user thêm tài khoản qua username/password hoặc tự động đăng nhập lại
(()=>{
  if (globalThis.__duyLoginHelperListener) {
    try { chrome.runtime.onMessage.removeListener(globalThis.__duyLoginHelperListener); } catch (_) {}
    globalThis.__duyLoginHelperListener = null;
  }
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
    const labelledById = el.getAttribute?.('aria-labelledby');
    let labelledText = '';
    if (labelledById) {
      labelledText = labelledById.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
    }
    const labelFor = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || '') : '';
    const parentLabel = el.closest?.('label')?.innerText || '';
    return [
      el.id,
      el.name,
      el.getAttribute?.('placeholder'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('autocomplete'),
      el.getAttribute?.('data-testid'),
      labelledText,
      labelFor,
      parentLabel
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
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: ch ? 'insertText' : 'deleteContentBackward',
        data: ch || null
      }));
    } catch (_) {}
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

  function clickElementReliably(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 10, top: 10, width: 20, height: 20 };
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const evInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try { el.focus?.(); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', evInit)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', evInit)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', evInit)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', evInit)); } catch (_) {}
    try { el.click(); } catch (_) {}
  }

  async function typeInto(input, text) {
    const str = String(text ?? '');
    try { input.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    clickElementReliably(input);
    input.focus();
    try { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (_) {}
    await delay(60);

    setNativeInputValue(input, '', input.value);
    dispatchInputEvent(input, '');

    let cur = '';
    for (const ch of str) {
      const prev = cur;
      cur += ch;
      try { input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })); } catch (_) {}
      setNativeInputValue(input, cur, prev);
      dispatchInputEvent(input, ch);
      try { input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true })); } catch (_) {}
      await delay(12 + Math.random() * 20);
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
        return /^(Đăng\s*nhập|Log\s*In|Log\s*in|Sign\s*In|Tiếp\s*tục|Continue)$/i.test(text);
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

  async function doLogin(email, password, accountName = '') {
    try {
      dismissModals();

      // 1. Kiểm tra nếu tài khoản cũ vẫn còn đăng nhập
      if (isOldAccountLoggedIn()) {
        await tryLogoutOldAccount();
        // Chờ trang đăng nhập xuất hiện sau khi đăng xuất
        await delay(2000);
      }

      // 2. Chờ form đăng nhập, nút "Dùng trang cá nhân khác" hoặc nút "Tiếp tục"
      const endWaitForm = Date.now() + 15000;
      let emailInput = null;
      let passInput = null;
      let attemptedContinue = false;

      while (Date.now() < endWaitForm) {
        dismissModals();

        ({ emailInput, passInput } = findLoginFields());

        // Nếu đã có cả 2 ô hoặc ít nhất ô mật khẩu
        if (emailInput && passInput) break;
        if (passInput && !emailInput) break;

        const allButtons = [...document.querySelectorAll('a, button, [role="button"]')].filter(isVisibleElement);

        // Nút chuyển tài khoản / đổi trang cá nhân
        const switchBtn = allButtons.find(el => {
          const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
          return (
            t.includes('tài khoản khác') ||
            t.includes('trang cá nhân khác') ||
            t.includes('another account') ||
            t.includes('another profile') ||
            t.includes('dùng tài khoản khác') ||
            t.includes('dùng trang cá nhân khác') ||
            t.includes('dùng trang khác') ||
            t.includes('thêm tài khoản') ||
            t.includes('switch account') ||
            t.includes('switch profile') ||
            t.includes('log into another') ||
            t.includes('use another profile')
          );
        });

        // Nút Tiếp tục của tài khoản lưu sẵn
        const continueBtn = allButtons.find(el => {
          const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          return /^(Tiếp tục|Continue|Tiếp tục với tư cách|Continue as)/i.test(t);
        });

        const pageText = (document.body ? document.body.innerText : '') || '';
        const normAccountName = (accountName || '').trim().toLowerCase();
        const normEmail = (email || '').trim().toLowerCase();
        const isTargetUserDisplayed = Boolean(
          (normAccountName && normAccountName.length >= 2 && pageText.toLowerCase().includes(normAccountName)) ||
          (normEmail && normEmail.length >= 3 && pageText.toLowerCase().includes(normEmail))
        );

        if (!attemptedContinue && continueBtn && isTargetUserDisplayed && !passInput && !emailInput) {
          attemptedContinue = true;
          continueBtn.click();
          await delay(1200);
          ({ emailInput, passInput } = findLoginFields());
          if (passInput) break;
        } else if (switchBtn) {
          switchBtn.click();
          await delay(1000);
          ({ emailInput, passInput } = findLoginFields());
          if (emailInput && passInput) break;
        } else if (!attemptedContinue && continueBtn && !switchBtn && !passInput && !emailInput) {
          attemptedContinue = true;
          continueBtn.click();
          await delay(1200);
          ({ emailInput, passInput } = findLoginFields());
          if (passInput) break;
        }

        if (emailInput && passInput) break;
        if (passInput) break;

        // Nếu phát hiện vẫn đang ở giao diện cũ đã đăng nhập, thử đăng xuất lại
        if (isOldAccountLoggedIn()) {
          await tryLogoutOldAccount();
        }

        await delay(500);
      }

      if (!passInput && !emailInput) {
        return {
          ok: false,
          error: `Không tìm thấy form đăng nhập (${location.hostname}${location.pathname}, inputs=${document.querySelectorAll('input').length}). Vui lòng kiểm tra lại tab Facebook hoặc dùng tab Paste Cookies.`
        };
      }

      // 3. Điền email (nếu có ô email) & password
      if (emailInput) {
        await typeInto(emailInput, email);
        await delay(250 + Math.random() * 150);
      }

      if (passInput) {
        await typeInto(passInput, password);
        await delay(250 + Math.random() * 150);
      }

      // 4. Tìm và chờ nút Đăng nhập sẵn sàng (React Comet có thể bật aria-disabled trong tích tắc)
      let loginBtn = findLoginButton(passInput);
      const waitEnableEnd = Date.now() + 800;
      while (loginBtn && (loginBtn.disabled || loginBtn.getAttribute('aria-disabled') === 'true') && Date.now() < waitEnableEnd) {
        await delay(100);
        loginBtn = findLoginButton(passInput) || loginBtn;
      }

      const form = passInput?.closest?.('form') || emailInput?.closest?.('form') || null;
      if (!loginBtn && !form) {
        return { ok: false, error: 'Không tìm thấy nút Đăng nhập.' };
      }

      // Bấm nút đăng nhập sau 60ms để hàm kịp trả lời kết quả về worker.js
      // Điều này ngăn chặn việc đứt gãy message channel khi trang bắt đầu chuyển hướng (navigation)
      setTimeout(() => {
        try {
          if (loginBtn && !loginBtn.disabled && loginBtn.getAttribute('aria-disabled') !== 'true') {
            clickElementReliably(loginBtn);
          } else if (form) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit(loginBtn || undefined);
            else form.submit();
          } else if (passInput) {
            passInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            passInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            clickElementReliably(loginBtn);
          }
        } catch (_) {}

        // Dự phòng: sau 900ms nếu vẫn đang ở form đăng nhập (Comet React chưa submit), bấm lại bằng Enter / requestSubmit
        setTimeout(() => {
          try {
            const stillHasPass = findPasswordInput();
            if (stillHasPass && stillHasPass.value) {
              const btnNow = findLoginButton(stillHasPass);
              if (btnNow && !btnNow.disabled && btnNow.getAttribute('aria-disabled') !== 'true') {
                clickElementReliably(btnNow);
              }
              stillHasPass.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
              stillHasPass.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            }
          } catch (_) {}
        }, 900);

        // Tự động kiểm tra và bấm qua các thông báo "Lưu trình duyệt" / "Tiếp tục" / "Đây là tôi" sau khi submit
        let postClickChecks = 0;
        const postClickTimer = setInterval(() => {
          postClickChecks++;
          if (postClickChecks > 10) {
            clearInterval(postClickTimer);
            return;
          }
          dismissModals();
          const continueBtn = pickPreferredElement(
            [...document.querySelectorAll('#checkpointSubmitButton, button, [role="button"], input[type="submit"]')].filter(b => {
              const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || b.value || '').trim();
              return /^(tiếp tục|continue|lưu trình duyệt|save browser|đây là tôi|this was me|tin cậy|trust|đồng ý|xác nhận|lúc khác|not now)$/i.test(t);
            })
          );
          if (continueBtn) {
            try { clickElementReliably(continueBtn); } catch (_) {}
          }
        }, 1000);
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

  const loginHelperMessageListener = (m, s, reply) => {
    if (m.type === 'DO_LOGIN') {
      doLogin(m.email, m.password, m.accountName || '').then(reply);
      return true;
    }
    if (m.type === 'SUBMIT_2FA') {
      submit2FACode(m.code).then(reply);
      return true;
    }
  };
  globalThis.__duyLoginHelperListener = loginHelperMessageListener;
  chrome.runtime.onMessage.addListener(loginHelperMessageListener);
})();
