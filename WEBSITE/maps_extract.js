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
      if (mode === 'detail' && (document.querySelector('div[role="main"] h1') || document.querySelector('h1'))) break;
      if (mode === 'list') {
        const hasFeedLinks = Boolean(
          (document.querySelector('[role="feed"]') || document.querySelector('div[aria-label*="Kết quả" i]') || document.querySelector('div[aria-label*="Results" i]'))
            ?.querySelector('a[href*="/maps/place/"]')
        );
        if (hasFeedLinks || (location.pathname.includes('/maps/place/') && document.querySelector('h1'))) break;
      }
      await sleep(500);
    }
    blocked();

    if (mode === 'list') {
      if (noResults()) return [];
      const feed = document.querySelector('[role="feed"]')
        || document.querySelector('div[aria-label*="Kết quả" i]')
        || document.querySelector('div[aria-label*="Results" i]');
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
        const feedTxt = (feed.innerText || '').normalize('NFC');
        const reachedEnd = /bạn đã xem hết danh sách|you['’]ve reached the end of the list/i.test(feedTxt);
        stable = found.size === prev ? stable + 1 : 0;
        if (stable >= 6 || (reachedEnd && stable >= 2)) break;
        feed.scrollTop = feed.scrollHeight;
        await sleep(1000);
      }
      return [...found];
    }

    // Detail mode
    for (let i = 0; i < 16; i++) {
      if (
        document.querySelector('[data-item-id^="phone:tel:"]')
        || document.querySelector('a[href^="tel:"]')
        || document.querySelector('[data-item-id*="phone"]')
        || document.querySelector('button[aria-label*="điện thoại" i]')
        || document.querySelector('button[aria-label*="phone" i]')
      ) {
        break;
      }
      await sleep(400);
    }

    const title = (
      document.querySelector('div[role="main"] h1.DUwDvf')
      || document.querySelector('div[role="main"] h1')
      || document.querySelector('h1')
    )?.innerText?.trim();
    if (!title) throw Error('Không đọc được tên cơ sở.');

    const cleanPhoneCandidate = (raw) => {
      if (!raw) return '';
      let digits = String(raw).replace(/\D+/g, '');
      if (!digits) return '';
      if (digits.startsWith('0084')) digits = digits.slice(4);
      else if (digits.startsWith('84') && digits.length >= 10) digits = digits.slice(2);
      if (/^(1800|1900)\d{4,6}$/.test(digits)) return digits;
      if (!digits.startsWith('0') && (digits.length === 9 || digits.length === 10)) digits = '0' + digits;
      if (!/^0[1-9]\d{8,9}$/.test(digits)) return '';
      return digits;
    };

    const phones = [];
    const seenPhones = new Set();
    const pushPhone = (raw) => {
      const cleaned = cleanPhoneCandidate(raw);
      if (cleaned && !seenPhones.has(cleaned)) {
        seenPhones.add(cleaned);
        phones.push(cleaned);
      }
    };

    const phoneNodes = document.querySelectorAll([
      '[data-item-id^="phone:tel:"]',
      'a[href^="tel:"]',
      '[data-item-id*="phone"]',
      'button[data-tooltip*="điện thoại" i]',
      'button[data-tooltip*="phone" i]',
      'button[aria-label*="điện thoại" i]',
      'button[aria-label*="phone" i]',
      'button[aria-label*="Sao chép số" i]',
      'button[aria-label*="Copy phone" i]'
    ].join(', '));

    for (const el of phoneNodes) {
      pushPhone(el.getAttribute('data-item-id')?.replace(/^phone:tel:/, ''));
      pushPhone(el.getAttribute('href')?.replace(/^tel:/, ''));
      pushPhone(el.querySelector('.Io6YTe')?.innerText);
      pushPhone(el.getAttribute('aria-label'));
      pushPhone(el.innerText);
    }

    const panel = document.querySelector('div[role="main"]') || document.body;
    const panelText = panel ? (panel.innerText || '') : '';
    const phoneRegex = /(?:\(\s*\+?84\s*\)[\s.\-]*|\+?84[\s.\-]*|0)(?:0?[1-9])(?:[\s.\-()]?\d){7,9}\b|\b(?:1800|1900)(?:[\s.\-]?\d){4,6}\b|\(\s*0\d{1,3}\s*\)[\s.\-]?(?:\d[\s.\-]?){6,8}\d\b/g;
    for (const m of panelText.matchAll(phoneRegex)) {
      pushPhone(m[0]);
    }

    const phone = phones[0] || '';
    const addressEl = document.querySelector('[data-item-id="address"]');
    const address = (
      addressEl?.querySelector('.Io6YTe')?.innerText
      || addressEl?.getAttribute('aria-label')
      || addressEl?.innerText
      || ''
    ).replace(/^(Địa chỉ|Address):\s*/i, '').trim();

    const web = document.querySelector('a[data-item-id="authority"]')?.href || '';

    return {
      name: title,
      phone,
      phones,
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
