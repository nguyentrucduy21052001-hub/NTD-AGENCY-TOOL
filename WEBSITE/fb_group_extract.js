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
 * Chuẩn hóa chữ số Unicode in đậm / nghiêng / toàn chiều rộng (𝟎-𝟿, 𝟬-𝟵, ０-９...) về ASCII 0-9
 */
function normalizeUnicodeDigits(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xff10 && cp <= 0xff19) {
      out += String.fromCharCode(48 + (cp - 0xff10));
    } else if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
      // 5 bộ chữ số toán học 10 ký tự liên tiếp: 0x1D7CE..0x1D7D7, 0x1D7D8..0x1D7E1, ...
      out += String((cp - 0x1d7ce) % 10);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Chuẩn hóa số điện thoại thô thành chuỗi chữ số sạch (tương thích Google Maps)
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let s = normalizeUnicodeDigits(String(raw)).replace(/\D+/g, '');
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

  // 1. Chuyển chữ số Unicode (đậm/in/fullwidth) về ASCII & thay O/o bằng 0 khi kề số
  let processed = normalizeUnicodeDigits(text)
    .replace(/\b[oO](?=[0-9])/gi, '0')
    .replace(/(?<=[0-9])[oO](?=[0-9])/gi, '0')
    .replace(/(?<=\b(?:sđt|sdt|lh|zalo|call|phone|hotline|alo|đt|dt|tel)[:\s]*)[oO]/gi, '0')
    .replace(/([oO])(?=[0-9])/g, '0');

  // 2. Pattern tìm dãy số điện thoại (hỗ trợ ngoặc đơn, dấu cách, chấm, gạch ngang, gạch dưới, chéo, chữ viết liền cuối số như 0901234567zalo)
  const phonePattern = /(?:\(\s*(?:\+?84|0)\s*\)|(?:\+?84|84|0))[.\s\-/_()]*(?:\d[.\s\-/_()]*){8,10}\d(?!\d)|\b(?:1800|1900)[.\s\-/_]*(?:\d[.\s\-/_]*){3,6}\d(?!\d)/gi;

  const found = [];
  const matches = [...processed.matchAll(phonePattern)];

  for (const match of matches) {
    const rawCandidate = match[0];
    const matchIndex = match.index;

    // Không cắt SĐT từ giữa một dãy số dài (như ID bài viết/UID 15 chữ số)
    const beforeChar = matchIndex > 0 ? processed[matchIndex - 1] : '';
    if (/\d/.test(beforeChar)) continue;

    // Loại trừ ngày tháng ví dụ: 20/11/2026, 05-11-2026
    if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(rawCandidate)) continue;
    const before2 = processed.slice(Math.max(0, matchIndex - 2), matchIndex);
    const after2 = processed.slice(matchIndex + rawCandidate.length, matchIndex + rawCandidate.length + 2);
    if (/^\/\d/.test(after2) || /\d\/$/.test(before2)) continue;

    // Chuẩn hóa và phân loại
    const cleanPhone = normalizePhone(rawCandidate);
    if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 11) continue;
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
    const aria = (d.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('chat') || aria.includes('messenger') || aria.includes('tin nhắn') || aria.includes('thông báo') || aria.includes('notifications')) {
      continue;
    }
    if (d.offsetWidth >= 380 && d.offsetHeight >= 300) {
      const hasPostSignal = /\/(?:posts|permalink|photo|videos)\//i.test(location.href)
        || Boolean(d.querySelector('[data-ad-preview="message"], [data-ad-rendering-role="story_message"], div[role="article"]'));
      if (hasPostSignal) return d;
    }
  }
  return null;
}

/**
 * Đóng bài viết chi tiết / popup để quay lại bảng tin nhóm Facebook
 */
function closePostDialog() {
  const dialog = getActivePostDialog();
  if (!dialog) return false;
  let closed = false;

  // 1. Tìm và bấm nút Đóng (X) thuộc về chính dialog đang mở
  const closeSelectors = [
    'div[aria-label="Đóng" i]',
    'div[aria-label="Close" i]',
    'div[aria-label="Đóng bài viết" i]',
    '[aria-label="Đóng" i]',
    '[aria-label="Close" i]'
  ];

  const scope = dialog.parentElement || dialog;
  for (const sel of closeSelectors) {
    const btn = dialog.querySelector(sel) || scope.querySelector(sel);
    if (btn) {
      try {
        btn.click();
        closed = true;
        break;
      } catch (_) {}
    }
  }

  // 2. Kích hoạt phím Escape trên dialog/document
  try {
    const escDown = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    const escUp = new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    dialog.dispatchEvent(escDown);
    dialog.dispatchEvent(escUp);
    document.dispatchEvent(escDown);
    document.dispatchEvent(escUp);
  } catch (_) {}

  // 3. Nếu URL nhảy sang /permalink/ hoặc /posts/ do mở dialog từ Feed mà bấm Đóng chưa thoát, lùi lại Feed
  if (!closed && (location.pathname.includes('/permalink/') || location.pathname.includes('/posts/'))) {
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
 * Tự động tìm và bấm các nút 'Xem thêm' & mở rộng bình luận NỘI TUYẾN (không click nút mở popup bài viết)
 */
function expandSeeMoreAndComments(maxCommentClicks = 8) {
  let expandedCount = 0;
  const dialog = getActivePostDialog();
  const root = dialog || document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]') || document;

  const isSafeInlineBtn = (el) => {
    if (!el || el.dataset?.ntdExpanded === '1') return false;
    if (el.tagName === 'A' || el.closest('a[href]')) return false;
    return true;
  };

  // 1. Mở rộng bài viết nội tuyến: "Xem thêm" / "See more"
  try {
    const seeMoreButtons = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]'))
      .filter(el => {
        if (!isSafeInlineBtn(el)) return false;
        const t = (el.innerText || '').trim();
        return t === 'Xem thêm' || t === 'See more' || t === 'Xem thêm...' || t === 'See More';
      });

    for (const btn of seeMoreButtons) {
      try {
        btn.dataset.ntdExpanded = '1';
        btn.click();
        expandedCount++;
      } catch (_) {}
    }
  } catch (_) {}

  // 2. Chỉ bấm các nút tải bình luận/phản hồi nội tuyến — TUYỆT ĐỐI KHÔNG bấm "X bình luận" (vì sẽ bật popup modal lặp vô hạn)
  try {
    let commentClicks = 0;
    const commentButtons = Array.from(root.querySelectorAll('div[role="button"], span[role="button"]'))
      .filter(el => {
        if (!isSafeInlineBtn(el)) return false;
        const t = (el.innerText || '').trim().toLowerCase();
        if (!t || /^\d+\s+(bình luận|comments)$/i.test(t) || t.includes('xem tất cả bình luận')) {
          return false;
        }
        return (
          t.includes('xem thêm bình luận') ||
          t.includes('xem các bình luận trước') ||
          t.includes('xem thêm câu trả lời') ||
          t.includes('xem các câu trả lời') ||
          t.includes('xem phản hồi') ||
          t.includes('view more comments') ||
          t.includes('view previous comments') ||
          t.includes('view more replies') ||
          /^(?:xem\s+)?\d+\s+(?:phản hồi|câu trả lời|replies)$/i.test(t)
        );
      });

    for (const btn of commentButtons) {
      if (commentClicks >= maxCommentClicks) break;
      try {
        btn.dataset.ntdExpanded = '1';
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

  // Tìm các phần tử bài viết trên trang (hỗ trợ cả giao diện mới dùng aria-posinset / div[role="feed"] > div)
  const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]') || document.body;
  let postEls = Array.from(feed.querySelectorAll('div[aria-posinset], div[data-pagelet^="FeedUnit"], div[role="article"], div[data-virtualized="false"]'));
  postEls = postEls.filter(el => {
    // Bỏ qua comment role="article" nằm lồng bên trong bài viết cha đã được chọn
    const parentArticle = el.parentElement?.closest('div[aria-posinset], div[data-pagelet^="FeedUnit"], div[role="article"]');
    return !parentArticle || !postEls.includes(parentArticle);
  });

  // Fallback nếu Facebook dùng các div con trực tiếp của div[role="feed"]
  if (postEls.length <= 1 && feed) {
    const directBlocks = Array.from(feed.children).filter(el => el.innerText && el.innerText.trim().length > 20);
    if (directBlocks.length > postEls.length) {
      postEls = directBlocks;
    }
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
      const permalinkEl = postEl.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="/permalink.php?"], a[href*="story_fbid="]');
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
      if (permalinkEl?.href && postUrl && postUrl !== currentUrl) {
        pKey = postUrl;
      } else {
        const snippet = (postEl.innerText || '').slice(0, 70).replace(/\s+/g, ' ').trim();
        pKey = authorName + '::' + snippet;
      }
      if (pKey) postIdentifiers.push(pKey);

      // 3. Quét SĐT trong NỘI DUNG BÀI VIẾT & liên kết tel:/zalo.me/wa.me
      if (scanPosts) {
        const msgContainer = postEl.querySelector('div[data-ad-preview="message"]') ||
                             postEl.querySelector('div[data-ad-rendering-role="story_message"]') ||
                             postEl;
        const postText = (msgContainer?.innerText || postEl.innerText || '').trim();

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
              postKey: pKey,
              groupName: groupTitle,
              groupUrl: currentUrl,
              at: new Date().toISOString()
            });
          }
        }

        const telAnchors = postEl.querySelectorAll('a[href^="tel:"], a[href*="zalo.me/"], a[href*="wa.me/"]');
        for (const ta of telAnchors) {
          const hrefRaw = decodeURIComponent(ta.getAttribute('href') || '');
          const linkPhones = extractPhonesWithContext(hrefRaw);
          for (const p of linkPhones) {
            items.push({
              phone: p.phone,
              rawPhone: p.rawPhone,
              category: p.category,
              name: authorName,
              source: 'Bài viết',
              context: p.snippet || hrefRaw,
              postUrl: postUrl,
              postKey: pKey,
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
              postKey: pKey,
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
              postKey: pKey,
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
              postKey: pKey,
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

  // 6. Lớp quét bổ sung toàn diện: Quét toàn bộ khối văn bản dir="auto" và liên kết tel/zalo trong vùng nội dung chính
  // Đảm bảo không bỏ sót bất kỳ bài viết / bình luận nào dù giao diện Facebook thay đổi cấu trúc thẻ
  if (scanPosts || scanComments) {
    try {
      const scanRoot = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]') || feed;
      const allTextNodes = scanRoot.querySelectorAll('div[dir="auto"], span[dir="auto"], p, a[href^="tel:"], a[href*="zalo.me/"]');
      for (const node of allTextNodes) {
        if (node.closest('[role="navigation"], [role="banner"]')) continue;
        const t = (node.tagName === 'A'
          ? (node.innerText || '') + ' ' + decodeURIComponent(node.getAttribute('href') || '')
          : (node.innerText || '')
        ).trim();
        if (t.length < 8) continue;

        const phones = extractPhonesWithContext(t);
        for (const p of phones) {
          if (!items.some(it => it.phone === p.phone)) {
            items.push({
              phone: p.phone,
              rawPhone: p.rawPhone,
              category: p.category,
              name: 'Thành viên nhóm',
              source: node.closest('div[aria-label*="Bình luận" i], div[aria-label*="Comment" i], div[aria-label*="trả lời" i]') ? 'Bình luận' : 'Bài viết',
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

function scrollGroupFeedForward(stagnantRound = 0) {
  if (typeof window.__ntdTriggerSentinels === 'function') {
    window.__ntdTriggerSentinels();
  }
  const scrollDelta = 3000 + (stagnantRound * 600);
  window.scrollBy(0, scrollDelta);

  const feeds = document.querySelectorAll('div[role="feed"], div[role="main"]');
  for (const f of feeds) {
    if (f.scrollHeight > f.clientHeight + 40) {
      f.scrollTop += scrollDelta;
    }
  }
  return scrollDelta;
}

/**
 * Cuộn trang thông minh:
 * - Nếu lỡ đang mở popup bài viết: quét/cuộn nhanh tối đa 2 lượt (hoặc đóng ngay nếu bài viết không có SĐT / đã cuộn hết),
 *   đồng thời ĐÓNG POPUP và CUỘN BẢNG TIN TIẾP ngay lập tức để không bao giờ bị kẹt bật/tắt cùng 1 bài viết.
 * - Nếu đang ở bảng tin nhóm: Cuộn bảng tin thẳng xuống để duyệt các bài tiếp theo.
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

      const dialogHasPhones = extractPhonesWithContext(dialog.innerText || '').length > 0;
      const allEls = Array.from(dialog.querySelectorAll('*'));
      const scrollableEls = allEls.filter(el => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY || '';
        return (overflowY === 'auto' || overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 40) && el.clientHeight > 100;
      });
      if (!scrollableEls.length) scrollableEls.push(dialog);

      let maxScrollTop = 0;
      let reachedBottom = false;
      for (const el of scrollableEls) {
        el.scrollTop += 1800;
        if (el.scrollTop > maxScrollTop) maxScrollTop = el.scrollTop;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
          reachedBottom = true;
        }
      }

      const isStagnant = maxScrollTop === _dialogScrollState.lastScrollTop;
      _dialogScrollState.lastScrollTop = maxScrollTop;

      // Bài viết không có SĐT hoặc đã chạm đáy -> đóng ngay & cuộn tiếp bảng tin nhóm để sang bài mới!
      const shouldClose = !dialogHasPhones || reachedBottom || isStagnant || _dialogScrollState.scrollRounds >= 2;
      if (shouldClose) {
        closePostDialog();
        _dialogScrollState.activeUrl = '';
        _dialogScrollState.scrollRounds = 0;
        scrollGroupFeedForward(stagnantRound);
        return {
          isDialog: true,
          closed: true,
          message: !dialogHasPhones
            ? 'Bài viết không có SĐT — đã bỏ qua và cuộn sang bài mới.'
            : 'Đã cuộn xong bài viết — đã đóng và cuộn tiếp bảng tin nhóm.'
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
    scrollGroupFeedForward(stagnantRound);

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

