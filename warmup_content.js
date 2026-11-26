// warmup_content.js – Content script tự động tương tác Facebook (Mô phỏng người dùng thật)
(()=>{
  // Nếu phiên nuôi trước vẫn đang chạy, hủy nó trước khi khởi động phiên mới
  if (globalThis.__ntdWarmupCancel) {
    globalThis.__ntdWarmupCancel();
  }

  // Dọn sạch listener cũ để tránh bị nhân đôi khi tab được tái sử dụng
  if (globalThis.__ntdWarmupListener) {
    chrome.runtime.onMessage.removeListener(globalThis.__ntdWarmupListener);
    globalThis.__ntdWarmupListener = null;
  }

  globalThis.__ntdWarmupActive = true;

  // 1. Đảm bảo tab Facebook luôn ở trạng thái hoạt động (active & visible) ngay cả khi thu nhỏ cửa sổ
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.hasFocus = () => true;
    window.hasFocus = () => true;
  } catch (_) {}

  const delay = ms => new Promise(r => setTimeout(r, ms));
  let isCancelled = false;
  let isPostingTimeline = false;

  // ── Helper kiểm tra phần tử có thực sự hiển thị trên giao diện Facebook ────
  const visible = e => {
    if (!e || !e.isConnected) return false;
    try {
      if (e.hidden || e.getAttribute('aria-hidden') === 'true') return false;
      if (e.closest('[hidden], [aria-hidden="true"]')) return false;

      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;

      const rects = e.getClientRects();
      if (rects.length > 0 && (rects[0].width > 0 || rects[0].height > 0)) return true;
      if (e.offsetWidth > 0 || e.offsetHeight > 0 || e.offsetParent !== null) return true;

      if (typeof e.checkVisibility === 'function') {
        try {
          return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  };

  const label = e => {
    if (!e) return '';
    return (
      e.getAttribute('aria-label') ||
      e.placeholder ||
      e.getAttribute('data-placeholder') ||
      e.getAttribute('aria-placeholder') ||
      e.getAttribute('title') ||
      e.innerText ||
      e.textContent ||
      ''
    ).trim();
  };

  // ── 2. Tự động phát hiện và đóng các hộp thoại/pop-up cản trở của Facebook ───
  function dismissObstructingDialogs() {
    // Nếu đang trong tiến trình soạn hoặc đăng bài cá nhân, TUYỆT ĐỐI không can thiệp
    if (isPostingTimeline) return false;

    try {
      const dialogs = document.querySelectorAll('[role="dialog"], div[aria-modal="true"]');
      if (!dialogs.length) return false;

      // Nếu trên trang đang có hộp thoại tạo bài viết, TUYỆT ĐỐI không đóng
      const hasComposer = [...dialogs].some(d => {
        return d.querySelector('[contenteditable="true"]') ||
          /tạo bài viết|create post|bạn đang nghĩ gì|what's on your mind/i.test(d.innerText || '');
      });
      if (hasComposer) return false;

      let anyDismissed = false;

      for (const dialog of dialogs) {
        // Lấy nội dung text để nhận diện
        const text = (dialog.innerText || dialog.textContent || '').trim().toLowerCase();

        // Không đóng nếu là menu xem danh sách thông báo header ở bước 6
        if (text.includes('thông báo trước đó') || text.includes('tất cả thông báo')) {
          continue;
        }

        // BẢO VỆ TUYỆT ĐỐI HỘP THOẠI TẠO BÀI VIẾT (POST COMPOSER) CỦA FACEBOOK
        if (
          dialog.querySelector('[contenteditable="true"]') ||
          dialog.querySelector('form') ||
          text.includes('tạo bài viết') ||
          text.includes('create post') ||
          text.includes('bạn đang nghĩ gì') ||
          text.includes("what's on your mind")
        ) {
          continue;
        }

        // 1. Ưu tiên tìm nút đóng (X) ở góc hộp thoại (như bảng "Tài khoản Meta của bạn đã sẵn sàng")
        const closeBtn = dialog.querySelector(
          '[aria-label="Đóng"], [aria-label="Close"], [aria-label*="Đóng"], [aria-label*="Close"], [aria-label*="dong"], [aria-label*="Dong"]'
        );

        if (closeBtn && visible(closeBtn)) {
          closeBtn.click();
          anyDismissed = true;
          sendLog('Đã tự động tắt bảng thông báo pop-up của Facebook (Nút X)', '🛡️');
          continue;
        }

        // 2. Tìm các nút hành động mang tính chất đóng/bỏ qua/xác nhận thông báo (VD: "Xem có gì mới", "Lúc khác", "Để sau", "Đã hiểu"...)
        const buttons = [...dialog.querySelectorAll('[role="button"], button')];
        const actionBtn = buttons.find(b => {
          const bText = (b.innerText || b.textContent || '').trim().toLowerCase();
          return (
            bText === 'đóng' ||
            bText === 'close' ||
            bText === 'lúc khác' ||
            bText === 'để sau' ||
            bText === 'không phải bây giờ' ||
            bText === 'not now' ||
            bText === 'later' ||
            bText === 'bỏ qua' ||
            bText === 'skip' ||
            bText === 'đã hiểu' ||
            bText === 'got it' ||
            bText === 'chấp nhận' ||
            bText === 'cho phép tất cả cookie' ||
            bText === 'xem có gì mới' ||
            bText === 'tiếp tục'
          );
        });

        if (actionBtn && visible(actionBtn)) {
          const actionText = actionBtn.innerText.trim();
          actionBtn.click();
          anyDismissed = true;
          sendLog(`Đã tự động bấm "${actionText}" để đóng pop-up`, '🛡️');
          continue;
        }
      }

      // Khôi phục khả năng cuộn trang nếu Facebook khóa overflow do mở modal
      if (document.body && document.body.style.overflow === 'hidden') {
        document.body.style.overflow = '';
      }
      if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
        document.documentElement.style.overflow = '';
      }

      return anyDismissed;
    } catch (_) {
      return false;
    }
  }

  // ── 2.1. Giám sát an ninh, phiên đăng nhập và phát hiện Checkpoint/Hạn chế tính năng ──
  function checkAccountSecurityAndCheckpoint() {
    try {
      const url = (window.location.href || '').toLowerCase();
      
      // 1. Nhận diện qua URL Checkpoint hoặc Login/Recover
      if (url.includes('/checkpoint/') || url.includes('checkpoint') || url.includes('/two_step_verification') || url.includes('login_attempt') || url.includes('/recover/')) {
        return { isAlert: true, type: 'checkpoint', reason: 'Phát hiện trang Checkpoint / Yêu cầu xác thực danh tính Facebook' };
      }
      if (url.includes('facebook.com/login') || url.includes('/login.php')) {
        return { isAlert: true, type: 'session_expired', reason: 'Phiên đăng nhập đã hết hạn hoặc bị đăng xuất khỏi Facebook' };
      }

      // 2. Nhận diện các thông điệp cảnh báo Checkpoint/Đình chỉ từ Meta
      const bodyText = (document.body ? document.body.innerText || '' : '').toLowerCase();
      if (bodyText.includes('tài khoản của bạn tạm thời bị khóa') ||
          bodyText.includes('chúng tôi đã đình chỉ tài khoản') ||
          bodyText.includes('your account has been disabled') ||
          bodyText.includes('your account has been suspended') ||
          bodyText.includes('tài khoản đã bị vô hiệu hóa') ||
          bodyText.includes('xác nhận đây là tài khoản của bạn') ||
          document.querySelector('#checkpointSubmitButton') !== null) {
        return { isAlert: true, type: 'checkpoint', reason: 'Tài khoản Facebook bị Checkpoint hoặc đình chỉ tạm thời' };
      }

      // 3. Nhận diện hạn chế tính năng / chặn thao tác tạm thời
      if (bodyText.includes('bạn tạm thời bị hạn chế') ||
          bodyText.includes('bạn đã bị chặn') ||
          bodyText.includes('tính năng này tạm thời bị khóa') ||
          bodyText.includes('action blocked') ||
          bodyText.includes('you’re temporarily blocked') ||
          bodyText.includes('tài khoản của bạn bị hạn chế')) {
        return { isAlert: true, type: 'restriction', reason: 'Tài khoản bị Facebook hạn chế tính năng / chặn tạm thời' };
      }

      return { isAlert: false };
    } catch (_) {
      return { isAlert: false };
    }
  }

  function reportCheckpointAndHalt(secAlert) {
    if (isCancelled) return;
    isCancelled = true;
    clearInterval(popupGuardInterval);
    sendLog(`🚨 ${secAlert.reason}! Tự động ngắt phiên ngay để bảo vệ an toàn cho nick.`, '⛔');
    try {
      chrome.runtime.sendMessage({
        type: 'WARMUP_CHECKPOINT_DETECTED',
        reason: secAlert.reason,
        alertType: secAlert.type,
        url: window.location.href,
        timestamp: Date.now()
      }).catch(() => {});
    } catch (_) {}
  }

  // Khởi chạy bộ giám sát pop-up & checkpoint định kỳ mỗi 1.5 giây trong suốt phiên nuôi
  const popupGuardInterval = setInterval(() => {
    if (isCancelled) {
      clearInterval(popupGuardInterval);
      return;
    }
    const secAlert = checkAccountSecurityAndCheckpoint();
    if (secAlert.isAlert) {
      reportCheckpointAndHalt(secAlert);
      return;
    }
    dismissObstructingDialogs();
  }, 1500);

  // Gán hàm hủy vào global để lần inject tiếp theo có thể dọn dẹp
  globalThis.__ntdWarmupCancel = () => { 
    isCancelled = true; 
    clearInterval(popupGuardInterval);
  };

  function sendLog(text, icon = 'ℹ️') {
    try {
      chrome.runtime.sendMessage({
        type: 'WARMUP_EVENT',
        event: 'log',
        text: `${icon} ${text}`,
        time: new Date().toLocaleTimeString('vi-VN')
      }).catch(() => {});
    } catch (_) {}
  }

  // ── 3. Cuộn trang mượt mà mô phỏng hành vi tự nhiên của con người ───────────
  function getScrollContainers() {
    const list = [window, document.scrollingElement, document.documentElement, document.body];
    try {
      const feeds = document.querySelectorAll('div[role="feed"], div[role="main"], [data-pagelet*="Feed"], div[tabindex="-1"]');
      feeds.forEach(el => {
        let cur = el;
        while (cur && cur !== document.body) {
          try {
            const style = window.getComputedStyle(cur);
            if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
              if (!list.includes(cur)) list.push(cur);
            }
          } catch (_) {}
          cur = cur.parentElement;
        }
      });
    } catch (_) {}
    return list;
  }

  async function humanScrollBy(distance, stepCount = 15) {
    if (isCancelled) return;
    dismissObstructingDialogs();

    // Mở khóa thanh cuộn nếu Facebook bị kẹt overflow: hidden
    try {
      if (document.body.style.overflow === 'hidden') document.body.style.overflow = '';
      if (document.documentElement.style.overflow === 'hidden') document.documentElement.style.overflow = '';
    } catch (_) {}

    const step = distance / stepCount;
    const containers = getScrollContainers();

    for (let i = 0; i < stepCount; i++) {
      if (isCancelled) break;
      window.scrollBy({
        top: step,
        left: 0,
        behavior: 'auto'
      });
      for (const c of containers) {
        if (c && typeof c.scrollBy === 'function' && c !== window) {
          try { c.scrollBy({ top: step, left: 0, behavior: 'auto' }); } catch (_) {}
        }
      }
      // Delay ngẫu nhiên giữa các bước cuộn để tạo gia tốc tự nhiên
      await delay(25 + Math.random() * 35);
    }

    // Phát xung phím ArrowDown nhẹ để kích hoạt tải thêm bài viết (Infinite Virtualized List) của Facebook
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    } catch (_) {}
  }

  // ── Helper click chuẩn React cho các phần tử Facebook ──────────────────────
  function triggerHumanClick(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (_) {}
    try {
      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2) || 100;
      const clientY = Math.round(rect.top + rect.height / 2) || 100;

      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY
      };

      el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
      el.dispatchEvent(new MouseEvent('mouseover', eventInit));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, button: 0, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, button: 0, buttons: 0 }));
    } catch (_) {}
    try { el.click(); } catch (_) {}
  }

  // ── 4. Lướt Bảng tin & Đọc bài viết & Thả Like/Tim ngẫu nhiên ───────────────
  async function runFeedSurfing(durationMs, likeConfig, stats) {
    if (isCancelled) return;
    dismissObstructingDialogs();
    sendLog('Bắt đầu lướt Bảng tin (Newsfeed) mô phỏng người thật...', '📰');

    const startTime = Date.now();
    const endTime = startTime + durationMs;
    const maxLikes = likeConfig?.enabled ? Math.max(1, parseInt(likeConfig.maxCount || '5')) : 0;
    const likedElements = new WeakSet();

    while (Date.now() < endTime && !isCancelled) {
      const secAlert = checkAccountSecurityAndCheckpoint();
      if (secAlert.isAlert) {
        reportCheckpointAndHalt(secAlert);
        break;
      }
      dismissObstructingDialogs();

      // 1. Cuộn trang mượt mà
      const scrollDist = 360 + Math.floor(Math.random() * 320);
      await humanScrollBy(scrollDist);
      stats.feedPosts++;

      // 2. Tự động tìm và bấm Like bài viết nếu chưa đạt giới hạn
      if (likeConfig?.enabled && stats.likesGiven < maxLikes && !isCancelled) {
        // Tỷ lệ kiểm tra like 70% mỗi lần dừng đọc bài
        if (Math.random() < 0.75) {
          const didLike = await tryLikeVisiblePost(likedElements);
          if (didLike) {
            stats.likesGiven++;
            sendLog(`Đã thả Thích bài viết thành công (${stats.likesGiven}/${maxLikes})`, '❤️');
            await delay(1200 + Math.random() * 1500);
          }
        }
      }

      // 3. Dừng lại đọc bài viết từ 2.5s đến 5.5s
      const pauseDuration = 2500 + Math.floor(Math.random() * 3000);
      sendLog(`Đang xem nội dung bài viết #${stats.feedPosts} trên Bảng tin (${Math.round(pauseDuration / 1000)}s)...`, '👀');
      await delay(pauseDuration);

      // Thỉnh thoảng (20% xác suất) cuộn ngược lên một chút như vừa thấy chi tiết hay
      if (Math.random() < 0.2) {
        await delay(400);
        await humanScrollBy(-(80 + Math.random() * 100), 8);
      }

      await delay(600 + Math.random() * 800);
    }

    stats.feedSec = Math.round((Date.now() - startTime) / 1000);
    sendLog(`Hoàn tất lướt Bảng tin: Đã xem ${stats.feedPosts} bài, thả cảm xúc ${stats.likesGiven} bài (${stats.feedSec}s).`, '✅');
  }

  // ── 5. Tìm và bấm nút Like cho bài viết đang hiển thị trong tầm mắt ──────────
  async function tryLikeVisiblePost(likedSet) {
    dismissObstructingDialogs();
    try {
      // 1. Tìm các nút Thích tiềm năng trong giao diện Facebook
      const candidates = document.querySelectorAll(`
        div[role="feed"] [role="article"] div[role="button"],
        div[role="feed"] [data-pagelet*="FeedUnit"] div[role="button"],
        div[role="main"] div[role="button"],
        div[aria-label*="Thích" i][role="button"],
        div[aria-label*="Like" i][role="button"],
        span[role="button"]
      `);

      const likeButtons = [];
      for (const btn of candidates) {
        if (!btn || likedSet.has(btn)) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Chỉ chọn các nút nằm trong hoặc rất gần màn hình hiện tại
        if (rect.bottom < -100 || rect.top > window.innerHeight + 250) continue;

        const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();

        const isAlreadyLiked = aria.includes('gỡ thích') || aria.includes('bỏ thích') || aria.includes('unlike') || btn.getAttribute('aria-pressed') === 'true';
        if (isAlreadyLiked) continue;

        // Loại trừ nút chia sẻ, bình luận, gửi, tin nhắn
        if (text.includes('bình luận') || text.includes('comment') || text.includes('chia sẻ') || text.includes('share') || text.includes('gửi') || text.includes('tin nhắn')) {
          continue;
        }

        // Nhận diện nút Thích / Like
        const isLike = (
          aria === 'thích' || aria === 'like' ||
          aria.startsWith('thích') || aria.startsWith('like') ||
          aria.includes('thích bài viết') || aria.includes('bày tỏ cảm xúc') ||
          text === 'thích' || text === 'like' ||
          text.startsWith('thích') || text.startsWith('like')
        );

        if (isLike) likeButtons.push(btn);
      }

      if (!likeButtons.length) return false;

      // Chọn 1 nút Thích đang hiển thị
      const targetBtn = likeButtons[0];
      likedSet.add(targetBtn);

      targetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(600 + Math.random() * 400);

      triggerHumanClick(targetBtn);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── 6. Lướt xem Video Reels ngắn (Facebook Reels) ───────────────────────────
  async function runReelsWatching(durationMs, stats) {
    if (isCancelled) return;
    sendLog('Chuyển hướng sang xem Video ngắn (Facebook Reels)...', '🎬');

    const startTime = Date.now();
    try {
      // 1. Điều hướng tới giao diện Reels qua SPA Link (Tránh reload toàn trang làm chết script)
      if (!window.location.pathname.includes('/reel')) {
        const reelLink = document.querySelector(`
          a[href*="/reel/"],
          a[href*="/reels/"],
          div[role="navigation"] a[href*="reel"],
          a[aria-label*="Thước phim" i],
          a[aria-label*="Reels" i],
          a[href*="/watch"]
        `);

        if (reelLink) {
          triggerHumanClick(reelLink);
          await delay(3500);
        } else {
          // Thử bấm icon Video trên thanh điều hướng đầu trang
          const videoNavBtn = document.querySelector('a[aria-label*="Video" i], a[href*="/watch"]');
          if (videoNavBtn) {
            triggerHumanClick(videoNavBtn);
            await delay(3000);
          }
        }
      }

      const endTime = startTime + durationMs;

      while (Date.now() < endTime && !isCancelled) {
        const secAlert = checkAccountSecurityAndCheckpoint();
        if (secAlert.isAlert) {
          reportCheckpointAndHalt(secAlert);
          break;
        }
        dismissObstructingDialogs();
        stats.reelsWatched++;

        // Xem mỗi video từ 8 đến 14 giây
        const watchSec = 8 + Math.floor(Math.random() * 6);
        sendLog(`Đang xem Video Reels #${stats.reelsWatched} (${watchSec}s)...`, '▶️');
        await delay(watchSec * 1000);

        if (isCancelled) break;

        // Thỉnh thoảng (50% tỷ lệ) thả tim Video Reel
        if (Math.random() < 0.5) {
          try {
            const reelLike = document.querySelector(`
              [aria-label="Thích" i],
              [aria-label="Like" i],
              div[role="button"][aria-label*="Thích" i],
              div[role="button"][aria-label*="Like" i]
            `);
            if (reelLike && !reelLike.getAttribute('aria-pressed')) {
              triggerHumanClick(reelLike);
              stats.reelsLiked++;
              sendLog(`Đã thả tim Video Reels #${stats.reelsWatched}!`, '❤️');
              await delay(800);
            }
          } catch (_) {}
        }

        // Chuyển sang Reels tiếp theo bằng phím Mũi tên xuống
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        await delay(800 + Math.random() * 600);
      }

      stats.reelsSec = Math.round((Date.now() - startTime) / 1000);
      sendLog(`Hoàn tất xem Reels: Đã xem ${stats.reelsWatched} video, thả tim ${stats.reelsLiked} video (${stats.reelsSec}s).`, '✅');
    } catch (err) {
      sendLog('Lỗi xem Reels: ' + err.message, '⚠️');
    }
  }

  // ── 7. Bấm xem Thông báo để tăng độ tin cậy của tài khoản ────────────────────
  async function runCheckNotifications(stats) {
    if (isCancelled) return;
    sendLog('Mở xem danh sách Thông báo (Notifications)...', '🔔');

    const startTime = Date.now();
    try {
      // Tìm nút chuông thông báo trên thanh header Facebook
      const notifBtn = document.querySelector(`
        [aria-label*="Thông báo" i],
        [aria-label*="Notifications" i],
        [aria-label*="Notification" i]
      `);

      if (notifBtn) {
        triggerHumanClick(notifBtn);
        await delay(2000);

        // Cuộn nhẹ danh sách thông báo
        const notifList = document.querySelector('[role="dialog"], [role="menu"]');
        if (notifList) {
          notifList.scrollBy({ top: 160, behavior: 'smooth' });
          await delay(2500);
        }

        // Bấm đóng lại hoặc bấm Escape
        triggerHumanClick(notifBtn);
        await delay(800);
        stats.notifsChecked = 1;
        stats.notifSec = Math.round((Date.now() - startTime) / 1000);
        sendLog(`Đã kiểm tra và cập nhật xong danh sách Thông báo (${stats.notifSec}s).`, '✅');
      } else {
        sendLog('Không tìm thấy nút Thông báo trên giao diện hiện tại.', 'ℹ️');
      }
    } catch (err) {
      sendLog('Kiểm tra thông báo: ' + err.message, 'ℹ️');
    }
  }

  // ── Helper điền văn bản vào bộ soạn Lexical của Facebook (ISOLATED fallback) ─
  async function fillFacebookEditor(el, text) {
    if (!el || !text) return false;
    const placeCaret = () => {
      try { el.focus(); } catch (_) {}
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const targetNode = el.querySelector('p') || el;
          const range = document.createRange();
          range.selectNodeContents(targetNode);
          range.collapse(false);
          sel.addRange(range);
        }
      } catch (_) {}
    };

    try {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    placeCaret();
    await delay(250);

    const getEdText = () => (el.innerText || el.textContent || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
    const hasInserted = () => getEdText().length >= Math.min(4, text.trim().length);

    // Cách 1: ClipboardEvent 'paste'
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const htmlLines = text.split('\n').map(line => {
        if (!line.trim()) return '<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><br></p>';
        return `<p class="xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8"><span data-lexical-text="true">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span></p>`;
      }).join('');
      dt.setData('text/html', htmlLines);

      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
      await delay(600);
    } catch (_) {}

    // Cách 2: InputEvent 'beforeinput'
    if (!hasInserted()) {
      placeCaret();
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertFromPaste',
            dataTransfer: dt,
            data: text,
            bubbles: true,
            cancelable: true,
            composed: true
          }));
        } catch (_) {}

        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
            cancelable: true,
            composed: true
          }));
        } catch (_) {}

        await delay(500);
      } catch (_) {}
    }

    // Cách 3: document.execCommand('insertText')
    if (!hasInserted()) {
      placeCaret();
      try {
        document.execCommand('insertText', false, text);
        await delay(500);
      } catch (_) {}
    }

    // Cách 4: Chromium TextEvent 'textInput'
    if (!hasInserted()) {
      placeCaret();
      try {
        const te = document.createEvent('TextEvent');
        te.initTextEvent('textInput', true, true, window, text, 0, '');
        el.dispatchEvent(te);
        await delay(500);
      } catch (_) {}
    }

    // Nudge editor để kích hoạt re-render nút Đăng
    try {
      el.focus();
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '', bubbles: true, composed: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }));
    } catch (_) {}

    return hasInserted();
  }

  // ── 7.1. Tự động đăng bài viết lên Trang cá nhân (Timeline) ─────────────────
  async function runPersonalTimelinePost(postText, stats) {
    if (isCancelled || !postText || !postText.trim()) return;
    isPostingTimeline = true;
    sendLog('📝 Bắt đầu chuẩn bị đăng bài viết lên Trang cá nhân (Timeline)...', '📝');

    try {
      // 1. Cuộn trang lên đầu để thấy ô soạn bài nếu đang ở giữa trang
      try {
        window.scrollTo({ top: 0, behavior: 'instant' });
      } catch (_) {
        window.scrollTo(0, 0);
      }
      await delay(800);

      // 2. Tìm nút mở hộp thoại soạn bài "Bạn đang nghĩ gì thế?"
      const OPENER_RE = /Bạn đang nghĩ gì|Bạn viết gì đi|Viết gì đó|Viết gì đi|Bạn muốn chia sẻ|Chia sẻ điều gì|Bắt đầu thảo luận|Tạo bài viết|Tạo bài|Viết bài|What's on your mind|Create a post|Create post|Write something|Share something/i;

      const findOpenerWithTarget = () => {
        const clickable = [...document.querySelectorAll('[role="button"], button, [role="combobox"], [tabindex="0"]')].filter(visible);
        for (const el of clickable) {
          if (el.closest('nav, header, [role="banner"], [role="navigation"]')) continue;
          const lbl = label(el) || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || '';
          if (OPENER_RE.test(lbl)) {
            if (/^(Thảo luận|Discussion)$/i.test(lbl.trim()) && el.tagName === 'A') continue;
            return { opener: el, span: el.querySelector('span, div') || el };
          }
        }

        const textEls = [...document.querySelectorAll('span, div')].filter(visible);
        for (const el of textEls) {
          const txt = (el.innerText || el.getAttribute('aria-placeholder') || '').trim();
          if (txt && OPENER_RE.test(txt) && txt.length < 90) {
            if (el.closest('nav, header, [role="banner"], [role="navigation"]')) continue;
            const btn = el.closest('[role="button"], button, [tabindex="0"]') || el.parentElement || el;
            if (visible(btn)) return { opener: btn, span: el };
          }
        }

        return null;
      };

      let target = null;
      const findStart = Date.now();
      while (Date.now() - findStart < 25000 && !isCancelled) {
        target = findOpenerWithTarget();
        if (target) break;
        await delay(500);
      }

      if (!target || !target.opener) {
        sendLog('⚠️ Không tìm thấy ô mở soạn bài "Bạn đang nghĩ gì thế?" trên trang cá nhân.', '⚠️');
        return;
      }

      const { opener, span } = target;
      sendLog('Đang bấm mở hộp thoại tạo bài viết mới...', '✍️');

      // CHỈ CLICK 1 LẦN DUY NHẤT VÀO NÚT SOẠN BÀI
      const clickTarget = opener || span;
      try { clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      await delay(250);
      triggerHumanClick(clickTarget);

      // 3. Chờ hộp thoại soạn bài (dialog) mở ra VÀ có chứa textbox
      const findComposerDialog = () => {
        const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
        const exact = candidates.find(d =>
          (d.querySelector('[contenteditable="true"][role="textbox"]') || d.querySelector('[contenteditable="true"]')) &&
          (/tạo bài viết|create post|bạn đang nghĩ gì|what's on your mind/i.test(d.innerText || '') ||
           [...d.querySelectorAll('[role="button"], button')].some(b => /^(Đăng|Post|Tiếp|Next)$/i.test(label(b))))
        );
        if (exact) return exact;
        return candidates.find(d =>
          (d.querySelector('[contenteditable="true"][role="textbox"]') || d.querySelector('[data-lexical-editor="true"]')) &&
          !/gửi tin nhắn|nhắn tin|messenger|chat/i.test(d.getAttribute('aria-label') || '')
        ) || null;
      };

      let dialog = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 25000 && !isCancelled) {
        dialog = findComposerDialog();
        if (dialog) break;

        if (Date.now() - waitStart > 4000 && (Date.now() - waitStart) % 4000 < 500) {
          if (span && span !== clickTarget) {
            triggerHumanClick(span);
          } else {
            triggerHumanClick(clickTarget);
          }
        }
        await delay(400);
      }

      if (!dialog) {
        sendLog('⚠️ Không mở được hộp thoại tạo bài viết Facebook sau 25 giây.', '⚠️');
        return;
      }

      sendLog('Đã mở hộp thoại tạo bài viết thành công! Đang chuẩn bị điền nội dung...', '✅');
      await delay(600);

      // 4. Ưu tiên điền & bấm Đăng trực tiếp trong MAIN world (cùng context JS với React/Lexical của Facebook)
      let mainHandled = false;
      try {
        const mainRes = await chrome.runtime.sendMessage({
          type: 'WARMUP_MAIN_FILL_AND_POST',
          text: postText
        });
        if (mainRes && mainRes.ok && mainRes.step === 'clicked_post') {
          mainHandled = true;
          sendLog(`Đã điền nội dung ("${(mainRes.filledText || postText).slice(0, 40)}...") và bấm nút Đăng!`, '🚀');
        } else if (mainRes && mainRes.error) {
          sendLog(`Thử chế độ dự phòng (MAIN world báo: ${mainRes.error})`, 'ℹ️');
        }
      } catch (mErr) {
        sendLog(`Chuyển sang chế độ điền nội dung trực tiếp: ${mErr.message}`, 'ℹ️');
      }

      // 5. Fallback trong ISOLATED world nếu MAIN world chưa hoàn tất
      if (!mainHandled && !isCancelled) {
        sendLog('Đang tìm ô soạn bài bên trong hộp thoại...', '🔍');
        let editor = null;
        const editorStart = Date.now();
        while (Date.now() - editorStart < 15000 && !isCancelled) {
          editor = [...dialog.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(visible) ||
                   [...dialog.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]')].find(visible) ||
                   [...dialog.querySelectorAll('[contenteditable="true"]')].find(visible) ||
                   dialog.querySelector('[contenteditable="true"]');
          if (editor) break;
          await delay(400);
        }

        if (!editor) {
          sendLog('⚠️ Không tìm thấy ô nhập nội dung bên trong hộp thoại tạo bài.', '⚠️');
          return;
        }

        sendLog('Đang điền nội dung bài viết vào ô soạn thảo...', '⌨️');
        await fillFacebookEditor(editor, postText);
        await delay(1000);

        sendLog('Đang tìm nút Đăng bài viết...', '🔍');
        const POST_RE = /^(Đăng|Post|Đăng bài|Đăng bài viết|Publish)$/i;
        let postBtn = null;
        const postWaitStart = Date.now();

        while (Date.now() - postWaitStart < 20000 && !isCancelled) {
          const allBtns = [...dialog.querySelectorAll('[role="button"], button')].filter(visible);
          const candidate = allBtns.find(b => POST_RE.test(label(b)));

          if (candidate) {
            const isDisabled = candidate.disabled || candidate.getAttribute('aria-disabled') === 'true';
            if (!isDisabled) {
              postBtn = candidate;
              break;
            } else {
              try {
                editor.focus();
                document.execCommand('insertText', false, ' ');
                await delay(150);
                document.execCommand('delete', false, null);
                editor.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
              } catch (_) {}
            }
          }
          await delay(600);
        }

        if (!postBtn) {
          sendLog('⚠️ Nút Đăng chưa sẵn sàng hoặc bị vô hiệu hóa.', '⚠️');
          return;
        }

        sendLog('Đang bấm nút Đăng bài viết...', '🚀');
        try {
          postBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          postBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        postBtn.click();
      }

      await delay(1500);

      // 7. Chờ hộp thoại tạo bài đóng lại xác nhận thành công
      const closeWaitStart = Date.now();
      let isClosed = false;
      while (Date.now() - closeWaitStart < 30000 && !isCancelled) {
        if (!dialog.isConnected || !visible(dialog)) {
          isClosed = true;
          break;
        }
        await delay(800);
      }

      if (isClosed) {
        stats.personalPostDone = true;
        stats.personalPostText = postText;
        sendLog(`🎉 ĐÃ ĐĂNG BÀI VIẾT LÊN TRANG CÁ NHÂN THÀNH CÔNG: "${postText.slice(0, 60)}..."`, '🎉');
      } else {
        // Nếu hộp thoại chưa đóng, kiểm tra xem có thông báo lỗi từ Facebook không
        const alertBox = dialog.querySelector('[role="alert"]');
        const alertText = alertBox ? (alertBox.innerText || alertBox.textContent || '').trim() : '';
        if (alertText) {
          sendLog(`⚠️ Facebook thông báo khi đăng bài: ${alertText}`, '⚠️');
        } else {
          stats.personalPostDone = true;
          stats.personalPostText = postText;
          sendLog(`✅ Đã gửi lệnh Đăng bài viết cá nhân thành công!`, '✅');
        }
      }
    } catch (err) {
      sendLog(`Lỗi khi đăng bài cá nhân: ${err.message}`, '⚠️');
    } finally {
      isPostingTimeline = false;
    }
  }

  // ── 8. Lắng nghe lệnh từ Extension (warmup.js hoặc worker) ───────────────────
  const warmupMessageListener = (msg, sender, sendResponse) => {
    if (msg.type === 'START_WARMUP_SESSION') {
      isCancelled = false;
      const cfg = msg.config || {};
      const enableFeed = cfg.feed !== false;
      const enableLike = cfg.enableLike !== false && cfg.like !== false;
      const maxLikes = parseInt(cfg.maxLikes || '5');
      const enableReels = Boolean(cfg.enableReels || cfg.reels);
      const enableNotif = Boolean(cfg.enableNotif || cfg.notif);

      // 1. Phản hồi NGAY LẬP TỨC để xác nhận đã nhận lệnh thành công
      sendResponse({ ok: true, started: true });

      // 2. Chạy chu trình tương tác
      (async () => {
        const stats = {
          feedPosts: 0,
          feedSec: 0,
          likesGiven: 0,
          maxLikes: maxLikes,
          likesEnabled: enableLike,
          reelsWatched: 0,
          reelsLiked: 0,
          reelsSec: 0,
          notifsChecked: 0,
          notifSec: 0,
          personalPostDone: false,
          personalPostText: ''
        };

        try {
          dismissObstructingDialogs();

          // Tính toán thời lượng cân bằng giữa các hành động
          const totalDurationMs = (cfg.feedDuration || 0) + (cfg.reelsDuration || 0) || (3 * 60 * 1000);
          let feedMs = 0;
          let reelsMs = 0;

          if (enableFeed && enableReels) {
            feedMs = Math.round(totalDurationMs * 0.50);
            reelsMs = totalDurationMs - feedMs;
          } else if (enableFeed) {
            feedMs = totalDurationMs;
          } else if (enableReels) {
            reelsMs = totalDurationMs;
          }

          // Bước 1 (ƯU TIÊN ĐẦU TIÊN): Tự động đăng 1 bài viết lên Trang cá nhân (Timeline) nếu được bật
          if (cfg.enablePersonalPost && cfg.personalPostText && !isCancelled) {
            sendLog('📝 Bắt đầu đăng bài lên Trang cá nhân trước các hoạt động nuôi...', '📝');
            try {
              // Đảm bảo đang ở trang chủ Facebook trước khi đăng bài
              if (window.location.pathname.includes('/reel') ||
                  window.location.pathname.includes('/watch') ||
                  window.location.pathname.includes('/groups')) {
                const homeLink = document.querySelector('a[href="/"], a[aria-label*="Trang chủ" i], a[aria-label*="Home" i], a[aria-label*="Facebook" i]');
                if (homeLink) {
                  triggerHumanClick(homeLink);
                  await delay(2500);
                }
              }
              await runPersonalTimelinePost(cfg.personalPostText, stats);
            } catch (pErr) {
              sendLog(`⚠️ Lỗi khi đăng bài cá nhân: ${pErr.message}`, '⚠️');
            }
          }

          // Bước 2: Lướt Newsfeed và Thả cảm xúc
          if (enableFeed && feedMs > 0 && !isCancelled) {
            await runFeedSurfing(feedMs, { enabled: enableLike, maxCount: maxLikes }, stats);
          }

          // Bước 3: Xem Reels nếu được bật
          if (enableReels && reelsMs > 0 && !isCancelled) {
            await runReelsWatching(reelsMs, stats);
          }

          // Bước 4: Xem Thông báo nếu được bật
          if (enableNotif && !isCancelled) {
            // Quay về trang chủ trước nếu đang ở Reels
            if (window.location.pathname.includes('/reel')) {
              const homeLink = document.querySelector('a[href="/"], a[aria-label*="Trang chủ" i], a[aria-label*="Home" i]');
              if (homeLink) {
                triggerHumanClick(homeLink);
                await delay(2500);
              }
            }
            await runCheckNotifications(stats);
          }

          // Bước 4: Phát sóng báo cáo chi tiết về các hành động đã thực hiện
          try {
            chrome.runtime.sendMessage({
              type: 'WARMUP_SESSION_REPORT',
              stats: stats
            }).catch(() => {});
          } catch (_) {}

          // Bước 5: Nếu phiên nền vẫn còn thời gian, tiếp tục lướt nhẹ Bảng tin
          while (!isCancelled) {
            dismissObstructingDialogs();
            await humanScrollBy(240);
            await delay(3500 + Math.random() * 3000);
          }

        } catch (err) {
          sendLog('Lỗi trong phiên tương tác: ' + err.message, '⚠️');
        } finally {
          clearInterval(popupGuardInterval);
        }
      })();

      return false;
    }

    if (msg.type === 'STOP_WARMUP_SESSION') {
      isCancelled = true;
      clearInterval(popupGuardInterval);
      sendLog('Đã hoàn tất chu trình tương tác cho tài khoản này.', '✅');
      sendResponse({ ok: true });
      return false;
    }
  };

  // Lưu reference listener vào global để lần inject tiếp theo có thể gỡ bỏ
  globalThis.__ntdWarmupListener = warmupMessageListener;
  chrome.runtime.onMessage.addListener(warmupMessageListener);

})();
