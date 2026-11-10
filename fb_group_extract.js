/**
 * NTD Agency - Facebook Group Phone Extractor (fb_group_extract.js)
 * Tự động chạy và trích xuất số điện thoại từ bài viết, hình ảnh (OCR/Alt text), bình luận trong nhóm Facebook.
 */

// ── Danh sách đầu số di động, cố định & hotline từ Google Maps ────────────────
const CURRENT_MOBILE_PREFIXES = [
  '032', '033', '034', '035', '036', '037', '038', '039',
  '086', '096', '097', '098',
  '081', '082', '083', '084', '085', '088', '091', '094',
  '070', '076', '077', '078', '079', '089', '090', '093',
  '052', '056', '058', '092',
  '059', '099',
  '087',
  '055'
];

const HOTLINE_PHONE_PREFIXES = [
  '1900', '1800',
  '024', '028',
  '0203', '0204', '0205', '0206', '0207', '0208', '0209',
  '0210', '0211', '0212', '0213', '0214', '0215', '0216', '0218', '0219',
  '0220', '0221', '0222', '0225', '0226', '0227', '0228', '0229',
  '0232', '0233', '0234', '0235', '0236', '0237', '0238', '0239',
  '0251', '0252', '0254', '0255', '0256', '0257', '0258', '0259',
  '0260', '0261', '0262', '0263', '0269',
  '0270', '0271', '0272', '0273', '0274', '0275', '0276', '0277',
  '0290', '0291', '0292', '0293', '0294', '0296', '0297', '0299'
];

const OLD_PHONE_PREFIXES = [
  '0162', '0163', '0164', '0165', '0166', '0167', '0168', '0169',
  '0120', '0121', '0122', '0126', '0128',
  '0123', '0124', '0125', '0127', '0129',
  '0186', '0188',
  '0199'
];

/**
 * Chuẩn hóa số điện thoại thô thành chuỗi chữ số sạch (tương thích Google Maps)
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\D+/g, '');
  if (s.startsWith('0084')) s = s.slice(4);
  else if (s.startsWith('84') && s.length >= 10) s = s.slice(2);

  if (/^(1800|1900|111|112|113|114|115|156|5656)/.test(s)) return s;
  if (!s.startsWith('0') && (s.length === 9 || s.length === 10)) s = '0' + s;
  return s;
}

/**
 * Phân loại số điện thoại theo 3 nhóm (đồng bộ với Google Maps):
 * - 'current': Số di động 10 số hiện hành (36 đầu số)
 * - 'hotline': Tổng đài 1800, 1900 & Cố định 63 tỉnh thành (024, 028, 02xx...)
 * - 'old': Số 11 số cũ (01xx...)
 */
function classifyPhoneNumber(phone) {
  if (!phone) return null;
  const p = normalizePhone(phone);
  if (!p) return null;

  // 1. Kiểm tra 36 đầu số di động hiện hành (10 số)
  for (const pre of CURRENT_MOBILE_PREFIXES) {
    if (p.startsWith(pre) && p.length === 10) return 'current';
  }

  // 2. Kiểm tra Hotline & Cố định 63 tỉnh thành
  for (const pre of HOTLINE_PHONE_PREFIXES) {
    if (p.startsWith(pre)) return 'hotline';
  }

  // 3. Kiểm tra số 11 số cũ
  for (const pre of OLD_PHONE_PREFIXES) {
    if (p.startsWith(pre) && p.length === 11) return 'old';
  }

  // Fallback mở rộng đảm bảo không sót số hợp lệ:
  if (/^(1800|1900)\d{4,6}$/.test(p) || /^02\d{8,9}$/.test(p)) return 'hotline';
  if (p.length === 10 && p.startsWith('0')) return 'current';
  if (p.length === 11 && p.startsWith('0')) return 'old';

  return 'other';
}

/**
 * Trích xuất toàn bộ số điện thoại có trong văn bản kèm ngữ cảnh xung quanh
 */
function extractPhonesWithContext(text, maxLength = 85) {
  if (!text || typeof text !== 'string') return [];

  // 1. Thay O/o bằng 0 khi đứng trước số hoặc trong dãy số
  let processed = text
    .replace(/\b[oO](?=[0-9])/gi, '0')
    .replace(/(?<=[0-9])[oO](?=[0-9])/gi, '0')
    .replace(/(?<=\b(?:sđt|sdt|lh|zalo|call|phone|hotline|alo|đt|dt)[:\s]*)[oO]/gi, '0')
    .replace(/([oO])(?=[0-9])/g, '0');

  // Chuyển ký tự số fullwidth (０-９) sang halfwidth (0-9)
  processed = processed.replace(/[\uff10-\uff19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

  // 2. Pattern tìm dãy số điện thoại:
  // - Di động / Cố định: bắt đầu bằng (+84|84|0) kèm 8-10 chữ số
  // - Tổng đài: bắt đầu bằng 1800/1900 kèm 4-6 chữ số
  const phonePattern = /(?:(?:\+84|84|0)[.\s-]?)(?:\d[.\s-]?){8,10}\d\b|\b(?:1800|1900)[.\s-]?(?:\d[.\s-]?){3,6}\d\b/gi;

  const found = [];
  const matches = [...processed.matchAll(phonePattern)];

  for (const match of matches) {
    const rawCandidate = match[0];
    const matchIndex = match.index;

    // Loại trừ ngày tháng ví dụ: 20/11/2026, 05-11-2026
    if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(rawCandidate)) continue;
    const before2 = processed.slice(Math.max(0, matchIndex - 2), matchIndex);
    const after2 = processed.slice(matchIndex + rawCandidate.length, matchIndex + rawCandidate.length + 2);
    if (/^\/\d/.test(after2) || /\d\/$/.test(before2)) continue;

    // Chuẩn hóa và phân loại
    const cleanPhone = normalizePhone(rawCandidate);
    const category = classifyPhoneNumber(cleanPhone);
    if (!category || category === 'other') continue;

    // Trích xuất ngữ cảnh xung quanh
    const start = Math.max(0, matchIndex - maxLength / 2);
    const end = Math.min(processed.length, matchIndex + rawCandidate.length + maxLength / 2);
    let snippet = processed.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < processed.length) snippet = snippet + '...';

    found.push({
      phone: cleanPhone,
      rawPhone: rawCandidate.trim(),
      category,
      snippet
    });
  }

  return found;
}

/**
 * Phát hiện xem hiện tại có đang mở bài viết chi tiết / popup / permalink không
 */
function getActivePostDialog() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const d = dialogs[i];
    if (d.offsetWidth > 250 && d.offsetHeight > 250) {
      return d;
    }
  }
  return null;
}

/**
 * Đóng bài viết chi tiết / popup để quay lại bảng tin nhóm Facebook
 */
function closePostDialog() {
  const dialog = getActivePostDialog();
  let closed = false;

  // 1. Tìm và bấm nút Đóng (X) trên dialog
  const closeSelectors = [
    'div[aria-label="Đóng" i]',
    'div[aria-label="Close" i]',
    'div[aria-label="Đóng bài viết" i]',
    'div[aria-label="Đóng cuộc trò chuyện" i]',
    '[aria-label="Đóng" i]',
    '[aria-label="Close" i]'
  ];

  for (const sel of closeSelectors) {
    const btn = (dialog ? dialog.querySelector(sel) : null) || document.querySelector(sel);
    if (btn) {
      try {
        btn.click();
        closed = true;
        break;
      } catch (_) {}
    }
  }

  // 2. Kích hoạt phím Escape trên window & document
  try {
    const escDown = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    const escUp = new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    document.dispatchEvent(escDown);
    document.dispatchEvent(escUp);
    window.dispatchEvent(escDown);
    window.dispatchEvent(escUp);
  } catch (_) {}

  // 3. Nếu URL chứa /permalink/ hoặc /posts/ và dialog chưa đóng, lùi trang lại
  if (location.pathname.includes('/permalink/') || location.pathname.includes('/posts/')) {
    try {
      window.history.back();
    } catch (_) {}
  }

  return closed;
}

let _dialogScrollState = {
  activeUrl: '',
  scrollRounds: 0,
  lastScrollTop: -1
};

/**
 * Tự động tìm và bấm các nút 'Xem thêm', 'Xem thêm bình luận' trong DOM
 */
function expandSeeMoreAndComments(maxCommentClicks = 8) {
  let expandedCount = 0;
  const dialog = getActivePostDialog();
  const root = dialog || document;

  // 1. Mở rộng bài viết: "Xem thêm" / "See more"
  try {
    const seeMoreButtons = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]'))
      .filter(el => {
        const t = (el.innerText || '').trim();
        return t === 'Xem thêm' || t === 'See more' || t === 'Xem thêm...' || t === 'See More';
      });

    for (const btn of seeMoreButtons) {
      try {
        btn.click();
        expandedCount++;
      } catch (_) {}
    }
  } catch (_) {}

  // 2. Mở rộng bình luận: "Xem thêm bình luận", "Xem các bình luận trước", "X câu trả lời"...
  try {
    let commentClicks = 0;
    const commentButtons = Array.from(root.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]'))
      .filter(el => {
        const t = (el.innerText || '').trim().toLowerCase();
        return (
          t.includes('xem thêm bình luận') ||
          t.includes('xem các bình luận trước') ||
          t.includes('xem tất cả bình luận') ||
          t.includes('xem thêm câu trả lời') ||
          t.includes('xem các câu trả lời') ||
          t.includes('xem phản hồi') ||
          t.includes('view more comments') ||
          t.includes('view previous comments') ||
          /^\d+\s+(bình luận|phản hồi|câu trả lời|replies|comments)$/i.test(t)
        );
      });

    for (const btn of commentButtons) {
      if (commentClicks >= maxCommentClicks) break;
      try {
        btn.click();
        commentClicks++;
        expandedCount++;
      } catch (_) {}
    }
  } catch (_) {}

  return expandedCount;
}

/**
 * Trích xuất text từ ảnh (Facebook tự động sinh OCR trong alt/aria-label)
 */
function extractImageTexts(container) {
  if (!container) return [];
  const texts = [];
  try {
    const imgEls = container.querySelectorAll('img, div[role="img"], span[role="img"], [data-visualcompletion="media-vc-image"]');
    for (const el of imgEls) {
      const alt = el.getAttribute('alt') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';

      const combined = [alt, ariaLabel, title]
        .map(s => s.trim())
        .filter(s => s.length > 3)
        .join(' | ');

      if (combined && !texts.includes(combined)) {
        texts.push(combined);
      }
    }
  } catch (_) {}
  return texts;
}

/**
 * Trích xuất toàn bộ dữ liệu bài viết, hình ảnh và bình luận trong nhóm Facebook
 */
function extractGroupPhonesFromDOM(options = {}) {
  const {
    scanPosts = true,
    scanComments = true,
    scanImages = true
  } = options;

  // Lấy tên nhóm Facebook
  let groupTitle = '';
  try {
    const h1 = document.querySelector('h1');
    groupTitle = (h1?.innerText || document.title || '')
      .replace(/ \| Facebook$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) {}

  const currentUrl = location.href;
  const items = [];
  const dialog = getActivePostDialog();

  // ── TRƯỜNG HỢP A: Đang xem bài viết chi tiết trong Popup (Dialog) ──
  if (dialog) {
    let authorName = 'Tác giả bài viết';
    const authorLinks = dialog.querySelectorAll('h2 a, h3 a, strong a, a[role="link"]');
    for (const a of authorLinks) {
      const text = (a.innerText || '').trim();
      const href = a.href || '';
      if (text && text.length > 1 && !text.includes('Xem thêm') && !href.includes('/groups/') && (href.includes('facebook.com/') || href.startsWith('/'))) {
        authorName = text;
        break;
      }
    }

    // 1. Quét nội dung bài viết trong popup
    if (scanPosts) {
      const postText = (dialog.innerText || '').trim();
      const phones = extractPhonesWithContext(postText);
      for (const p of phones) {
        items.push({
          phone: p.phone,
          rawPhone: p.rawPhone,
          category: p.category,
          name: authorName,
          source: 'Bài viết (Chi tiết)',
          context: p.snippet,
          postUrl: currentUrl,
          groupName: groupTitle,
          groupUrl: currentUrl,
          at: new Date().toISOString()
        });
      }
    }

    // 2. Quét hình ảnh trong popup (Alt / OCR)
    if (scanImages) {
      const imgTexts = extractImageTexts(dialog);
      for (const imgText of imgTexts) {
        const phones = extractPhonesWithContext(imgText);
        for (const p of phones) {
          items.push({
            phone: p.phone,
            rawPhone: p.rawPhone,
            category: p.category,
            name: authorName,
            source: 'Hình ảnh bài viết',
            context: p.snippet,
            postUrl: currentUrl,
            groupName: groupTitle,
            groupUrl: currentUrl,
            at: new Date().toISOString()
          });
        }
      }
    }

    // 3. Quét các bình luận trong popup
    if (scanComments) {
      const commentEls = dialog.querySelectorAll('div[role="article"], div[aria-label*="bình luận" i], div[aria-label*="comment" i], div[aria-label*="trả lời" i], ul > li');
      for (const cEl of commentEls) {
        let commentAuthor = authorName;
        const cAuthorEl = cEl.querySelector('a[role="link"], span[dir="auto"] > a, strong');
        if (cAuthorEl?.innerText?.trim()) commentAuthor = cAuthorEl.innerText.trim();

        const commentText = (cEl.innerText || '').trim();
        const phones = extractPhonesWithContext(commentText);
        for (const p of phones) {
          items.push({
            phone: p.phone,
            rawPhone: p.rawPhone,
            category: p.category,
            name: commentAuthor,
            source: 'Bình luận bài viết',
            context: p.snippet,
            postUrl: currentUrl,
            groupName: groupTitle,
            groupUrl: currentUrl,
            at: new Date().toISOString()
          });
        }
      }
    }

    return {
      items,
      postsCount: 1,
      commentsCount: items.length,
      groupTitle,
      isDialog: true
    };
  }

  // ── TRƯỜNG HỢP B: Đang ở bảng tin nhóm (Feed) ──
  let totalPostsFound = 0;
  let totalCommentsFound = 0;

  // Tìm các phần tử bài viết trên trang
  const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]') || document.body;
  let postEls = Array.from(feed.querySelectorAll('div[role="article"], div[data-pagelet^="FeedUnit"], div[data-virtualized="false"]'));

  // Fallback nếu Facebook không gán role="article" cho tất cả thẻ con
  if (!postEls.length && feed) {
    postEls = Array.from(feed.children).filter(el => {
      return el.querySelector('div[dir="auto"]') && (el.scrollHeight > 100);
    });
  }

  totalPostsFound = postEls.length;
  const postIdentifiers = [];

  for (const postEl of postEls) {
    try {
      // 1. Tác giả bài viết
      let authorName = 'Thành viên nhóm';
      let authorUrl = '';
      const authorLinks = postEl.querySelectorAll('h2 a, h3 a, strong a, a[role="link"]');
      for (const a of authorLinks) {
        const text = (a.innerText || '').trim();
        const href = a.href || '';
        // Bỏ qua các liên kết hệ thống, thời gian, xem thêm
        if (
          text &&
          text.length > 1 &&
          !text.includes('Xem thêm') &&
          !text.includes('See more') &&
          !/^\d+\s+(giờ|phút|ngày|tháng|tuần|h|m|d|w|yr)/i.test(text) &&
          !href.includes('/groups/') &&
          (href.includes('facebook.com/') || href.startsWith('/'))
        ) {
          authorName = text;
          authorUrl = href;
          break;
        }
      }

      // 2. Link trực tiếp đến bài viết (permalink)
      let postUrl = currentUrl;
      const permalinkEl = postEl.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="/permalink.php?"]');
      if (permalinkEl?.href) {
        try {
          const u = new URL(permalinkEl.href);
          u.searchParams.delete('__cft__[0]');
          u.searchParams.delete('__tn__');
          postUrl = u.href;
        } catch (_) {
          postUrl = permalinkEl.href;
        }
      }

      // Tạo mã định danh duy nhất cho bài viết để đếm chính xác số bài đã duyệt
      let pKey = '';
      if (permalinkEl?.href) {
        pKey = permalinkEl.href;
      } else {
        const snippet = (postEl.innerText || '').slice(0, 70).replace(/\s+/g, ' ').trim();
        pKey = authorName + '::' + snippet;
      }
      if (pKey) postIdentifiers.push(pKey);

      // 3. Quét SĐT trong NỘI DUNG BÀI VIẾT
      if (scanPosts) {
        const msgContainer = postEl.querySelector('div[data-ad-preview="message"]') ||
                             postEl.querySelector('div[data-ad-rendering-role="story_message"]') ||
                             postEl;
        const postText = (msgContainer?.innerText || '').trim();

        if (postText) {
          const phones = extractPhonesWithContext(postText);
          for (const p of phones) {
            items.push({
              phone: p.phone,
              rawPhone: p.rawPhone,
              category: p.category,
              name: authorName,
              source: 'Bài viết',
              context: p.snippet,
              postUrl: postUrl,
              groupName: groupTitle,
              groupUrl: currentUrl,
              at: new Date().toISOString()
            });
          }
        }
      }

      // 4. Quét SĐT trong HÌNH ẢNH CỦA BÀI VIẾT (Alt text / OCR)
      if (scanImages) {
        const imgTexts = extractImageTexts(postEl);
        for (const imgText of imgTexts) {
          const phones = extractPhonesWithContext(imgText);
          for (const p of phones) {
            items.push({
              phone: p.phone,
              rawPhone: p.rawPhone,
              category: p.category,
              name: authorName,
              source: 'Hình ảnh bài viết',
              context: p.snippet,
              postUrl: postUrl,
              groupName: groupTitle,
              groupUrl: currentUrl,
              at: new Date().toISOString()
            });
          }
        }
      }

      // 5. Quét SĐT trong BÌNH LUẬN & HÌNH ẢNH BÌNH LUẬN
      if (scanComments) {
        const commentEls = postEl.querySelectorAll('div[role="article"], div[aria-label*="Bình luận" i], div[aria-label*="Comment" i], div[aria-label*="trả lời" i], ul > li');
        totalCommentsFound += commentEls.length;

        for (const cEl of commentEls) {
          // Tác giả bình luận
          let commentAuthor = authorName;
          const cAuthorEl = cEl.querySelector('a[role="link"], span[dir="auto"] > a, strong');
          if (cAuthorEl?.innerText?.trim()) {
            commentAuthor = cAuthorEl.innerText.trim();
          }

          // Nội dung bình luận
          const cTextEl = cEl.querySelector('div[dir="auto"], span[dir="auto"]');
          const commentText = (cTextEl?.innerText || '').trim();

          if (commentText) {
            const phones = extractPhonesWithContext(commentText);
            for (const p of phones) {
              items.push({
                phone: p.phone,
                rawPhone: p.rawPhone,
                category: p.category,
                name: commentAuthor,
                source: 'Bình luận',
                context: p.snippet,
                postUrl: postUrl,
                groupName: groupTitle,
                groupUrl: currentUrl,
                at: new Date().toISOString()
              });
            }
          }

          // Hình ảnh trong bình luận
          if (scanImages) {
            const cImgTexts = extractImageTexts(cEl);
            for (const cImgText of cImgTexts) {
              const phones = extractPhonesWithContext(cImgText);
              for (const p of phones) {
                items.push({
                  phone: p.phone,
                  rawPhone: p.rawPhone,
                  category: p.category,
                  name: commentAuthor,
                  source: 'Hình ảnh bình luận',
                  context: p.snippet,
                  postUrl: postUrl,
                  groupName: groupTitle,
                  groupUrl: currentUrl,
                  at: new Date().toISOString()
                });
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // 6. Lớp quét bổ sung toàn diện: Quét toàn bộ khối văn bản dir="auto" trong Feed
  // Đảm bảo không bỏ sót bất kỳ bài viết nào dù giao diện Facebook có thay đổi cấu trúc thẻ
  if (scanPosts) {
    try {
      const allTextNodes = feed.querySelectorAll('div[dir="auto"], span[dir="auto"], p');
      for (const node of allTextNodes) {
        const t = (node.innerText || '').trim();
        if (t.length < 8) continue;

        const phones = extractPhonesWithContext(t);
        for (const p of phones) {
          if (!items.some(it => it.phone === p.phone)) {
            items.push({
              phone: p.phone,
              rawPhone: p.rawPhone,
              category: p.category,
              name: 'Thành viên nhóm',
              source: 'Bài viết',
              context: p.snippet,
              postUrl: currentUrl,
              groupName: groupTitle,
              groupUrl: currentUrl,
              at: new Date().toISOString()
            });
          }
        }
      }
    } catch (_) {}
  }

  return {
    items,
    postsCount: totalPostsFound,
    postKeys: postIdentifiers,
    commentsCount: totalCommentsFound,
    groupTitle,
    isDialog: false
  };
}

/**
 * Cuộn trang thông minh:
 * - Nếu đang mở popup bài viết: Cuộn thanh cuộn của popup để tải và quét toàn bộ bình luận.
 *   Khi đã hết bình luận hoặc cuộn tới đáy, tự động ĐÓNG POPUP để tiếp tục cuộn nhóm.
 * - Nếu đang ở bảng tin nhóm: Cuộn bảng tin bình thường để duyệt bài tiếp theo.
 */
function scrollPostDialogOrFeed(stagnantRound = 0) {
  try {
    const dialog = getActivePostDialog();

    // ── TRƯỜNG HỢP 1: Đang ở trong popup / hộp thoại chi tiết bài viết ──
    if (dialog) {
      const currentUrl = location.href;
      if (_dialogScrollState.activeUrl !== currentUrl) {
        _dialogScrollState.activeUrl = currentUrl;
        _dialogScrollState.scrollRounds = 0;
        _dialogScrollState.lastScrollTop = -1;
      }

      _dialogScrollState.scrollRounds++;

      // Tìm tất cả các phần tử có thể cuộn bên trong dialog
      const allEls = Array.from(dialog.querySelectorAll('*'));
      const scrollableEls = allEls.filter(el => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY || '';
        return (overflowY === 'auto' || overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 40) && el.clientHeight > 100;
      });

      if (!scrollableEls.length) {
        scrollableEls.push(dialog);
      }

      let maxScrollTop = 0;
      let reachedBottom = false;

      for (const el of scrollableEls) {
        el.scrollTop += 1800;
        if (el.scrollTop > maxScrollTop) maxScrollTop = el.scrollTop;

        // Nếu đã cuộn tới đáy của phần tử
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
          reachedBottom = true;
        }
      }

      // Cuộn cả window hỗ trợ
      window.scrollBy({ top: 1200, behavior: 'smooth' });

      const isStagnant = maxScrollTop === _dialogScrollState.lastScrollTop;
      _dialogScrollState.lastScrollTop = maxScrollTop;

      // Điều kiện thoát bài viết:
      // 1. Đã cuộn tới đáy
      // 2. Hoặc vị trí cuộn không đổi sau 2 vòng
      // 3. Hoặc đã cuộn tối đa 6 vòng trong 1 bài viết
      const shouldClose = reachedBottom || (isStagnant && _dialogScrollState.scrollRounds >= 2) || _dialogScrollState.scrollRounds >= 6;

      if (shouldClose) {
        closePostDialog();
        _dialogScrollState.activeUrl = '';
        _dialogScrollState.scrollRounds = 0;
        return {
          isDialog: true,
          closed: true,
          message: 'Đã cuộn hết bình luận trong bài viết. Đang thoát bài viết để cuộn tiếp nhóm...'
        };
      }

      return {
        isDialog: true,
        closed: false,
        scrollRounds: _dialogScrollState.scrollRounds
      };
    }

    // ── TRƯỜNG HỢP 2: Đang ở bảng tin nhóm (Feed) ──
    _dialogScrollState.activeUrl = '';
    _dialogScrollState.scrollRounds = 0;

    if (typeof window.__ntdTriggerSentinels === 'function') {
      window.__ntdTriggerSentinels();
    }

    const scrollDelta = 3000 + (stagnantRound * 600);
    window.scrollBy({ top: scrollDelta, behavior: 'smooth' });

    const feeds = document.querySelectorAll('div[role="feed"], div[role="main"]');
    for (const f of feeds) {
      if (f.scrollHeight > f.clientHeight + 40) {
        f.scrollTop += scrollDelta;
      }
    }

    return {
      isDialog: false,
      closed: false,
      scrollTop: window.scrollY || document.documentElement.scrollTop,
      scrollHeight: document.documentElement.scrollHeight,
      ok: true
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Hỗ trợ cả môi trường ES module và inject toàn cục
if (typeof window !== 'undefined') {
  window.getActivePostDialog = getActivePostDialog;
  window.closePostDialog = closePostDialog;
  window.extractPhonesWithContext = extractPhonesWithContext;
  window.expandSeeMoreAndComments = expandSeeMoreAndComments;
  window.extractImageTexts = extractImageTexts;
  window.extractGroupPhonesFromDOM = extractGroupPhonesFromDOM;
  window.scrollPostDialogOrFeed = scrollPostDialogOrFeed;
  window.scrollFacebookGroupFeed = scrollPostDialogOrFeed;
}

