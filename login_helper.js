// login_helper.js – Content script chạy trên trang Facebook login
// Được inject bởi worker khi user thêm tài khoản qua username/password
(()=>{
  if(globalThis.__duyLoginHelper) return;
  globalThis.__duyLoginHelper = true;

  const delay = ms => new Promise(r => setTimeout(r, ms));

  function setInputValue(input, value) {
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function typeInto(input, text) {
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, '');
    else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    let cur = '';
    for (const ch of text) {
      cur += ch;
      if (nativeSetter) nativeSetter.call(input, cur);
      else input.value = cur;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      await delay(20 + Math.random() * 30);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dismissModals() {
    // Tự đóng các popup như "Nhớ mật khẩu" -> "Lúc khác" / "Not Now"
    const buttons = [...document.querySelectorAll('[role="button"], button')];
    const dismissBtn = buttons.find(el => {
      const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().trim();
      return t === 'lúc khác' || t === 'not now' || t === 'đóng' || t === 'close';
    });
    if (dismissBtn) {
      try { dismissBtn.click(); } catch (_) {}
    }
  }

  function isOldAccountLoggedIn() {
    const hasEmail = document.getElementById('email') || document.querySelector('input[name="email"], input[type="email"]');
    if (hasEmail) return false;
    return !!(
      location.pathname.includes('/home') ||
      document.querySelector('[data-pagelet="Feed"], [role="feed"]') ||
      document.querySelector('[aria-label*="Trang cá nhân của bạn"], [aria-label*="Your profile"]') ||
      document.querySelector('[aria-label*="Tài khoản"], [aria-label*="Account"]')
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

        // Kiểm tra xem có giao diện "Đăng nhập bằng tài khoản khác" không
        emailInput = document.getElementById('email') || document.querySelector('input[name="email"], input[type="email"], input[autocomplete="username"]');
        if (!emailInput) {
          const switchBtn = [...document.querySelectorAll('a, button, [role="button"]')].find(el => {
            const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().trim();
            return t.includes('tài khoản khác') || t.includes('another account') || t.includes('dùng tài khoản khác') || t.includes('thêm tài khoản');
          });
          if (switchBtn) {
            switchBtn.click();
            await delay(1000);
          }
        }

        emailInput = document.getElementById('email') || document.querySelector('input[name="email"], input[type="email"], input[autocomplete="username"]');
        passInput = document.getElementById('pass') || document.querySelector('input[name="pass"], input[type="password"]');

        if (emailInput && passInput) break;

        // Nếu phát hiện vẫn đang ở giao diện cũ đã đăng nhập, thử đăng xuất lại
        if (isOldAccountLoggedIn()) {
          await tryLogoutOldAccount();
        }

        await delay(600);
      }

      if (!emailInput || !passInput) {
        return { ok: false, error: 'Không tìm thấy form đăng nhập. Vui lòng kiểm tra lại tab Facebook hoặc dùng tab Paste Cookies.' };
      }

      // 3. Điền email & password
      await typeInto(emailInput, email);
      await delay(300 + Math.random() * 200);

      await typeInto(passInput, password);
      await delay(400 + Math.random() * 200);

      // 4. Tìm và bấm nút đăng nhập
      const loginBtn = document.querySelector(
        '[name="login"], #loginbutton, [data-testid="royal_login_button"], button[type="submit"], input[type="submit"]'
      ) || [...document.querySelectorAll('button, [role="button"]')].find(b =>
        /^(Đăng nhập|Log In|Log in)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())
      );

      if (!loginBtn) {
        return { ok: false, error: 'Không tìm thấy nút Đăng nhập.' };
      }

      // Bấm nút đăng nhập sau 60ms để hàm kịp trả lời kết quả về worker.js
      // Điều này ngăn chặn việc đứt gãy message channel khi trang bắt đầu chuyển hướng (navigation)
      setTimeout(() => {
        try {
          loginBtn.click();
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
        // Tìm ô nhập mã 2FA
        const input = document.querySelector(
          '#approvals_code, input[name="approvals_code"], input[autocomplete="one-time-code"], input[placeholder*="mã"], input[placeholder*="code" i]'
        ) || [...document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"]')].find(el => {
          const idOrName = (el.id + ' ' + el.name + ' ' + (el.getAttribute('aria-label')||'')).toLowerCase();
          return idOrName.includes('code') || idOrName.includes('approv') || idOrName.includes('mã');
        });

        if (input) {
          await typeInto(input, String(code).trim());
          await delay(300);

          const submitBtn = document.querySelector(
            '#checkpointSubmitButton, button[name="submit[Continue]"], button[type="submit"]'
          ) || [...document.querySelectorAll('button, [role="button"]')].find(b =>
            /^(Tiếp tục|Continue|Xác nhận|Confirm|Submit)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())
          );

          if (submitBtn) {
            submitBtn.click();
            await delay(1500);

            // Tự động bấm qua các bước phụ "Lưu trình duyệt" / "Đây là tôi"
            setTimeout(() => {
              const nextBtn = document.querySelector(
                '#checkpointSubmitButton, button[name="submit[Continue]"], button[name="submit[This was me]"]'
              ) || [...document.querySelectorAll('button, [role="button"]')].find(b =>
                /^(Tiếp tục|Continue|Đây là tôi|This was me)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())
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
