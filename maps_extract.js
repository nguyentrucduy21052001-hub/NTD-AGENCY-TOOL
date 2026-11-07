/**
 * NTD Agency - Google Maps Extractor
 * Tự chạy bên trong tab Google Maps để thu thập danh sách và thông tin chi tiết cơ sở.
 */

export async function mapsExtract(mode, limit = 50) {
  try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const blocked = () => {
      const txt = document.body?.innerText || '';
      if (location.pathname.includes('/sorry') || document.querySelector('iframe[src*="recaptcha"]') || /unusual traffic|lưu lượng truy cập bất thường/i.test(txt)) {
        throw Error('Maps yêu cầu xác minh. Mở tab Maps xử lý rồi bấm Tiếp tục.');
      }
      if (location.hostname.startsWith('consent.') || /Before you continue to Google|Trước khi bạn tiếp tục sử dụng Google/i.test(txt)) {
        throw Error('Maps yêu cầu đồng ý điều khoản. Mở tab Maps xử lý rồi tiếp tục.');
      }
    };

    // Empty searches have no feed. Recognize Maps' explicit empty-state text,
    // but never mistake loading failures or verification screens for zero results.
    const noResults = () => {
      const txt = (document.body?.innerText || '').normalize('NFC');
      return /không tìm thấy (?:kết quả|thông tin)|không có kết quả|không có thông tin nào|không tìm được kết quả|no results found|no results for|did not match any (?:locations|results)|could(?:n['’]t| not) find/i.test(txt);
    };

    const end = Date.now() + 25000;
    while (Date.now() < end) {
      blocked();
      if (mode === 'list' && noResults()) return [];
      if (mode === 'detail' && document.querySelector('h1')) break;
      if (mode === 'list' && (document.querySelector('[role="feed"]') || (location.pathname.includes('/maps/place/') && document.querySelector('h1')))) break;
      await sleep(500);
    }
    blocked();

    if (mode === 'list') {
      if (noResults()) return [];
      const feed = document.querySelector('[role="feed"]');
      if (!feed) {
        if (location.href.includes('/maps/place/') && document.querySelector('h1')) return [location.href];
        if (location.pathname.includes('/maps/search/')) return [];
        throw Error('Không thấy danh sách kết quả. Kiểm tra từ khóa, trạng thái tải hoặc giao diện Maps.');
      }

      const found = new Set();
      let stable = 0;
      for (let n = 0; n < 100; n++) {
        blocked();
        const prev = found.size;
        for (const a of feed.querySelectorAll('a[href*="/maps/place/"]')) {
          try {
            const u = new URL(a.href);
            u.search = '';
            u.hash = '';
            found.add(u.href);
            if (found.size >= limit) return [...found].slice(0, limit);
          } catch (_) {}
        }
        stable = found.size === prev ? stable + 1 : 0;
        if (stable >= 6) break;
        feed.scrollTop = feed.scrollHeight;
        await sleep(1100);
      }
      return [...found];
    }

    // Detail mode
    for (let i = 0; i < 8; i++) {
      if (document.querySelector('[data-item-id^="phone:tel:"]') || document.querySelector('[data-item-id="address"]')) break;
      await sleep(400);
    }

    const title = document.querySelector('h1')?.innerText?.trim();
    if (!title) throw Error('Không đọc được tên cơ sở.');

    const phoneEl = document.querySelector('[data-item-id^="phone:tel:"]') || document.querySelector('a[href^="tel:"]');
    const phone = (phoneEl?.getAttribute('data-item-id')?.replace(/^phone:tel:/, '') || phoneEl?.getAttribute('href')?.replace(/^tel:/, '') || '').trim();

    const addressEl = document.querySelector('[data-item-id="address"]');
    const address = (addressEl?.getAttribute('aria-label') || addressEl?.innerText || '').replace(/^(Địa chỉ|Address):\s*/i, '').trim();

    const web = document.querySelector('a[data-item-id="authority"]')?.href || '';

    return {
      name: title,
      phone,
      address,
      website: web,
      url: location.href,
      at: new Date().toISOString()
    };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// Support both ES module and window global
if (typeof window !== 'undefined') {
  window.mapsExtract = mapsExtract;
}
