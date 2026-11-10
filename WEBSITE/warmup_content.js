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

  // ── 2. Tự động phát hiện và đóng các hộp thoại/pop-up cản trở của Facebook ───
  function dismissObstructingDialogs() {
    try {
      const dialogs = document.querySelectorAll('[role="dialog"], div[aria-modal="true"]');
      if (!dialogs.length) return false;

      let anyDismissed = false;

      for (const dialog of dialogs) {
        // Lấy nội dung text để nhận diện
        const text = (dialog.innerText || dialog.textContent || '').trim().toLowerCase();

        // Không đóng nếu là menu xem danh sách thông báo header ở bước 6
        if (text.includes('thông báo trước đó') || text.includes('tất cả thông báo')) {
          continue;
        }

        // 1. Ưu tiên tìm nút đóng (X) ở góc hộp thoại (như bảng "Tài khoản Meta của bạn đã sẵn sàng")
        const closeBtn = dialog.querySelector(
          '[aria-label="Đóng"], [aria-label="Close"], [aria-label*="Đóng"], [aria-label*="Close"], [aria-label*="dong"], [aria-label*="Dong"]'
        );

        if (closeBtn && closeBtn.offsetParent !== null) {
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

        if (actionBtn && actionBtn.offsetParent !== null) {
          const actionText = actionBtn.innerText.trim();
          actionBtn.click();
          anyDismissed = true;
          sendLog(`Đã tự động bấm "${actionText}" để đóng pop-up`, '🛡️');
          continue;
        }

        // 3. Nếu chưa đóng được, phát phím Escape
        try {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          anyDismissed = true;
        } catch (_) {}
      }

      // Khôi phục khả năng cuộn trang nếu Facebook khóa overflow do mở modal
      if (document.body.style.overflow === 'hidden') {
        document.body.style.overflow = '';
      }
      if (document.documentElement.style.overflow === 'hidden') {
        document.documentElement.style.overflow = '';
      }

      return anyDismissed;
    } catch (_) {
      return false;
    }
  }

  // Khởi chạy bộ giám sát pop-up định kỳ mỗi 1.5 giây trong suốt phiên nuôi
  const popupGuardInterval = setInterval(() => {
    if (isCancelled) {
      clearInterval(popupGuardInterval);
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

  // ── 4. Lướt Bảng tin & Đọc bài viết ─────────────────────────────────────────
  async function runFeedSurfing(durationMs, likeConfig) {
    if (isCancelled) return;
    dismissObstructingDialogs();
    sendLog('Bắt đầu lướt Bảng tin (Newsfeed) mô phỏng người thật...', '📰');

    const endTime = Date.now() + durationMs;
    let likeCount = 0;
    const maxLikes = likeConfig?.enabled ? (likeConfig.maxCount || 4) : 0;
    const likedElements = new WeakSet();

    while (Date.now() < endTime && !isCancelled) {
      // Tự động kiểm tra và đóng pop-up nếu vừa xuất hiện
      dismissObstructingDialogs();

      // 1. Cuộn trang một đoạn ngẫu nhiên (300px - 650px)
      const scrollDist = 320 + Math.floor(Math.random() * 320);
      await humanScrollBy(scrollDist);

      // Thỉnh thoảng (20% xác suất) cuộn ngược lên một chút như vừa thấy bài thú vị
      if (Math.random() < 0.2) {
        await delay(500 + Math.random() * 600);
        await humanScrollBy(-(80 + Math.random() * 120), 8);
      }

      // 2. Dừng lại đọc bài từ 3 đến 7 giây
      const pauseDuration = 3000 + Math.floor(Math.random() * 4000);
      sendLog(`Đang đọc nội dung bài viết (${Math.round(pauseDuration / 1000)}s)...`, '👀');
      await delay(pauseDuration);

      // 3. Nếu bật tính năng thả Like và chưa đạt giới hạn
      if (likeConfig?.enabled && likeCount < maxLikes && !isCancelled) {
        // Tỷ lệ tương tác 40% mỗi khi dừng đọc bài
        if (Math.random() < 0.45) {
          const didLike = await tryLikeVisiblePost(likedElements);
          if (didLike) {
            likeCount++;
            sendLog(`Đã thả Thích bài viết thành công (${likeCount}/${maxLikes})`, '❤️');
            await delay(1200 + Math.random() * 1500);
          }
        }
      }

      // Nghỉ ngắn trước khi cuộn tiếp
      await delay(800 + Math.random() * 1200);
    }

    sendLog(`Hoàn tất lướt Bảng tin. Đã tương tác: ${likeCount} bài viết.`, '✅');
  }

  // ── 5. Tìm và bấm nút Like cho bài viết đang hiển thị trong tầm mắt ──────────
  async function tryLikeVisiblePost(likedSet) {
    dismissObstructingDialogs();
    try {
      // Tìm các nút Thích trên giao diện Facebook
      const allButtons = [...document.querySelectorAll('div[role="button"], span[role="button"]')];
      
      const likeButtons = allButtons.filter(btn => {
        if (!btn || likedSet.has(btn)) return false;
        
        // Kiểm tra xem nút có nằm trong khung nhìn (viewport) không
        const rect = btn.getBoundingClientRect();
        if (rect.top < 80 || rect.bottom > window.innerHeight - 50) return false;
        if (rect.width === 0 || rect.height === 0) return false;

        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();

        // Nút thích chưa bấm: aria-label="Thích" hoặc text là "Thích" / "Like"
        // Tránh nút đã like (aria-label="Gỡ Thích", "Bỏ Thích", "Unlike", hoặc có aria-pressed="true")
        const isLikeText = (ariaLabel === 'thích' || ariaLabel === 'like' || text === 'thích' || text === 'like');
        const isAlreadyLiked = ariaLabel.includes('gỡ thích') || ariaLabel.includes('bỏ thích') || ariaLabel.includes('unlike') || btn.getAttribute('aria-pressed') === 'true';

        return isLikeText && !isAlreadyLiked;
      });

      if (!likeButtons.length) return false;

      // Chọn ngẫu nhiên 1 bài đang hiển thị
      const targetBtn = likeButtons[Math.floor(Math.random() * likeButtons.length)];
      likedSet.add(targetBtn);

      // Mô phỏng rê chuột và click
      targetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(600 + Math.random() * 400);

      try { targetBtn.focus({ preventScroll: true }); } catch (_) {}
      targetBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await delay(150 + Math.random() * 200);

      targetBtn.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── 5. Lướt xem Video Reels ngắn ────────────────────────────────────────────
  async function runReelsWatching(durationMs) {
    if (isCancelled) return;
    sendLog('Chuyển hướng sang xem Video ngắn (Reels)...', '🎬');

    try {
      // Điều hướng tới Facebook Reels (Ưu tiên bấm SPA Link để không bị mất kết nối script)
      if (!window.location.pathname.includes('/reel')) {
        let reelLink = document.querySelector('a[href*="/reel/"], a[aria-label*="Reels"], a[aria-label*="Thước phim"], a[aria-label="Video"], a[href*="/watch"]');
        if (!reelLink) {
          const seeMore = document.querySelector('div[role="navigation"] [aria-label*="Xem thêm"], div[role="navigation"] [aria-label*="See more"]');
          if (seeMore) {
            try { seeMore.click(); } catch (_) {}
            await delay(800);
            reelLink = document.querySelector('a[href*="/reel/"], a[aria-label*="Reels"], a[aria-label*="Thước phim"]');
          }
        }
        if (reelLink) {
          reelLink.click();
          await delay(3500);
        } else {
          // Điều hướng mềm dạng SPA để không làm mất kết nối script
          const fakeLink = document.createElement('a');
          fakeLink.href = '/reel/';
          fakeLink.style.display = 'none';
          document.body.appendChild(fakeLink);
          fakeLink.click();
          await delay(800);
          fakeLink.remove();
          await delay(3000);
        }
      }

      const endTime = Date.now() + durationMs;
      let reelsCount = 0;

      while (Date.now() < endTime && !isCancelled) {
        dismissObstructingDialogs();
        reelsCount++;
        // Xem mỗi video từ 12 đến 20 giây
        const watchTime = 12000 + Math.floor(Math.random() * 8000);
        sendLog(`Đang xem Video Reels #${reelsCount} (${Math.round(watchTime / 1000)}s)...`, '▶️');
        await delay(watchTime);

        if (isCancelled) break;

        // Thỉnh thoảng (30%) like reel
        if (Math.random() < 0.3) {
          try {
            const reelLike = document.querySelector('[aria-label="Thích"], [aria-label="Like"]');
            if (reelLike && !reelLike.getAttribute('aria-pressed')) {
              reelLike.click();
              sendLog('Đã thả tim Video Reels!', '❤️');
              await delay(800);
            }
          } catch (_) {}
        }

        // Chuyển sang Reels tiếp theo (bấm phím Mũi tên xuống hoặc PageDown)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        await delay(800 + Math.random() * 600);
      }

      sendLog(`Hoàn tất xem Reels. Đã xem ${reelsCount} video.`, '✅');
    } catch (err) {
      sendLog('Lỗi xem Reels: ' + err.message, '⚠️');
    }
  }

  // ── 6. Bấm xem Thông báo để tăng độ tin cậy của tài khoản ────────────────────
  async function runCheckNotifications() {
    if (isCancelled) return;
    sendLog('Mở xem danh sách Thông báo (Notifications)...', '🔔');

    try {
      // Tìm nút chuông thông báo trên thanh header Facebook
      const notifBtn = document.querySelector(
        '[aria-label*="Thông báo"], [aria-label*="Notifications"], [aria-label*="Thông báo mới"]'
      );

      if (notifBtn) {
        notifBtn.click();
        await delay(2500 + Math.random() * 1500);

        // Cuộn nhẹ danh sách thông báo
        const notifList = document.querySelector('[role="dialog"], [role="menu"]');
        if (notifList) {
          notifList.scrollBy({ top: 120, behavior: 'smooth' });
          await delay(2000);
        }

        // Đóng lại
        notifBtn.click();
        await delay(1000);
        sendLog('Đã kiểm tra và cập nhật xong Thông báo.', '✅');
      } else {
        sendLog('Không tìm thấy nút Thông báo trên giao diện hiện tại.', 'ℹ️');
      }
    } catch (err) {
      sendLog('Kiểm tra thông báo: ' + err.message, 'ℹ️');
    }
  }

  // ── 7. Lắng nghe lệnh từ Extension (warmup.js hoặc worker) ───────────────────
  const warmupMessageListener = (msg, sender, sendResponse) => {
    if (msg.type === 'START_WARMUP_SESSION') {
      isCancelled = false;
      const { feedDuration, reelsDuration, enableLike, maxLikes, enableReels, enableNotif } = msg.config || {};

      // 1. Phản hồi NGAY LẬP TỨC để xác nhận đã nhận lệnh thành công
      // Tuyệt đối không giữ cổng message chờ 3-5 phút vì Chrome MV3 sẽ tự động ngắt kết nối
      sendResponse({ ok: true, started: true });

      // 2. Chạy chu trình tương tác
      (async () => {
        try {
          // Tự động quét và đóng mọi pop-up/hộp thoại cản trở trước khi bắt đầu các hành động
          dismissObstructingDialogs();

          // Bước 1: Lướt Newsfeed và Thả cảm xúc
          if (feedDuration > 0 && !isCancelled) {
            await runFeedSurfing(feedDuration, { enabled: enableLike, maxCount: maxLikes });
          }

          // Bước 2: Xem Reels nếu được bật
          if (enableReels && reelsDuration > 0 && !isCancelled) {
            await runReelsWatching(reelsDuration);
          }

          // Bước 3: Xem Thông báo nếu được bật
          if (enableNotif && !isCancelled) {
            // Nếu vừa xem reels thì quay về trang chủ trước (Ưu tiên bấm SPA Link)
            if (window.location.pathname.includes('/reel')) {
              const homeLink = document.querySelector('a[href="/"], a[aria-label*="Trang chủ"], a[aria-label*="Home"]');
              if (homeLink) {
                homeLink.click();
                await delay(2500);
              } else {
                const fakeHome = document.createElement('a');
                fakeHome.href = '/';
                fakeHome.style.display = 'none';
                document.body.appendChild(fakeHome);
                fakeHome.click();
                await delay(800);
                fakeHome.remove();
                await delay(2500);
              }
            }
            await runCheckNotifications();
          }

          // Bước 4: Nếu phiên nền vẫn còn thời gian, tiếp tục lướt nhẹ Bảng tin cho đến khi nhận STOP_WARMUP_SESSION
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

      return false; // Phản hồi đồng bộ xong
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
