// group_parser.js – Thuật toán trích xuất, phân loại Công khai/Riêng tư, đếm thành viên & lọc trùng nhóm Facebook
// Tương thích cả trình duyệt (DOMParser) lẫn Node.js unit test (không phụ thuộc Extension API).

export const RESERVED_GROUP_SLUGS = new Set([
  'feed', 'discover', 'joins', 'joined', 'create', 'search', 'category',
  'categories', 'notifications', 'requests', 'invitations', 'invites',
  'your_posts', 'pending_posts', 'settings', 'insights', 'groups', 'browse',
  'suggestions', 'member_requests', 'scheduled_posts', 'admin_activities'
]);

export const ALLOWED_FB_HOSTS = new Set([
  'www.facebook.com', 'facebook.com', 'm.facebook.com',
  'web.facebook.com', 'mbasic.facebook.com', 'touch.facebook.com',
  'd.facebook.com'
]);

const REJECTED_ANCHOR_TEXT_RE = /^(?:tham gia(?:\s+nhóm)?|join(?:\s+group)?|đã tham gia|joined|xem nhóm|view group|mở|open|truy cập nhóm|visit group|đang chờ|pending|hủy yêu cầu|cancel request)$/i;
const PURE_METADATA_LINE_RE = /^(?:công khai|riêng tư|không công khai|nhóm công khai|nhóm riêng tư|public(?:\s+group)?|private(?:\s+group)?|\d[\d.,]*\s*(?:k|m|tr|triệu|nghìn|ngàn)?\+?\s*(?:thành viên|members?)|[\d+]+\s*bài viết|\d+\s*người bạn.*)$/i;

/**
 * Chuẩn hóa đường dẫn Facebook Group từ chuỗi URL hoặc đường dẫn tương đối.
 * Chỉ chấp nhận liên kết tới trang chính của nhóm (/groups/<slug>/), loại bỏ link bài viết/user/permalink.
 */
export function normalizeGroupHref(href) {
  if (!href || typeof href !== 'string') return null;
  let raw = href.trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw) || /^mailto:/i.test(raw)) {
    return null;
  }

  try {
    let parsed = new URL(raw, 'https://www.facebook.com');
    const host = parsed.hostname.toLowerCase();

    // Giải bọc redirect l.facebook.com/l.php?u=...
    if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && parsed.searchParams.has('u')) {
      const inner = parsed.searchParams.get('u');
      if (!inner) return null;
      parsed = new URL(inner, 'https://www.facebook.com');
    }

    if (!ALLOWED_FB_HOSTS.has(parsed.hostname.toLowerCase())) return null;

    // Chỉ lấy link gốc của nhóm (/groups/<slug> hoặc /groups/<slug>/), từ chối /posts/, /user/, /permalink/...
    const m = parsed.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/i);
    if (!m) return null;

    const slug = m[1].toLowerCase();
    if (!slug || slug.length < 2 || RESERVED_GROUP_SLUGS.has(slug)) return null;

    return `https://www.facebook.com/groups/${slug}/`;
  } catch (_) {
    return null;
  }
}

/**
 * Lấy khóa định danh duy nhất của nhóm từ URL hoặc ID số.
 */
export function extractCanonicalGroupKey(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.trim();
  const norm = normalizeGroupHref(clean);
  const target = norm || clean;
  const match = target.match(/\/groups\/([a-zA-Z0-9._-]+)/i);
  if (match) {
    const slug = match[1].toLowerCase();
    if (!RESERVED_GROUP_SLUGS.has(slug)) {
      return slug;
    }
  }
  if (/^\d{8,25}$/.test(clean)) {
    return clean;
  }
  return null;
}

/**
 * Chuẩn hóa tên nhóm (bỏ dấu tiếng Việt, giữ chữ-số thường) để chống trùng chéo giữa các từ khóa.
 */
export function normalizeGroupName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function foldVietnamese(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

/**
 * Chuyển đổi chuỗi số lượng thành viên Facebook sang số nguyên.
 * Hỗ trợ: "151K thành viên", "176,4K thành viên", "10K+ thành viên", "1.2M", "1,2 triệu", "15.400", "1,250,000".
 */
export function parseMemberCount(str) {
  if (typeof str === 'number') {
    return Number.isFinite(str) && str > 0 ? Math.round(str) : 0;
  }
  if (!str || typeof str !== 'string') return 0;
  const clean = str.trim().toLowerCase();
  if (!clean) return 0;

  const m = clean.match(/([\d.,]+)\s*(triệu|trieu|nghìn|nghin|ngàn|ngan|tỷ|ty|tr|[km])?\s*\+?(?![a-z\u00C0-\u024F\u1EA0-\u1EF9])/i);
  if (!m) return 0;

  let numPart = m[1].trim();
  const unit = foldVietnamese(m[2] || '');

  if (unit) {
    numPart = numPart.replace(',', '.');
    const val = parseFloat(numPart);
    if (isNaN(val)) return 0;
    if (unit === 'k' || unit === 'nghin' || unit === 'ngan') {
      return Math.round(val * 1000);
    }
    if (unit === 'm' || unit === 'trieu' || unit === 'tr') {
      return Math.round(val * 1000000);
    }
    if (unit === 'ty') {
      return Math.round(val * 1000000000);
    }
    return Math.round(val);
  }

  // Số phân tách hàng nghìn không kèm đơn vị: "15.400", "1,250,000"
  if (/^\d{1,3}([.,]\d{3})+$/.test(numPart)) {
    return parseInt(numPart.replace(/[.,]/g, ''), 10) || 0;
  }

  numPart = numPart.replace(',', '.');
  const val = parseFloat(numPart);
  return isNaN(val) ? 0 : Math.round(val);
}

/**
 * Loại bỏ các cụm đếm "X người bạn là thành viên" trước khi trích số thành viên thật của nhóm.
 */
export function extractMemberText(cardText, fallbackText = '') {
  const combined = [cardText, fallbackText].filter(Boolean).join('\n');
  if (!combined) return 'Đang cập nhật';

  // Xóa mệnh đề bạn chung / bạn bè là thành viên để tránh bắt nhầm "1 người bạn là thành viên" -> 1
  const sanitized = combined
    .replace(/\b\d[\d.,]*\s*(?:người\s*bạn|người\s*bạn\s*chung|bạn\s*chung|friends?)(?:\s+(?:là\s+thành\s+viên|(?:is|are)\s+(?:a\s+)?members?))?/gi, ' ');

  const memMatch = sanitized.match(
    /([\d.,]+\s*(?:triệu|nghìn|ngàn|tỷ|tr|[km])?\+?)\s*(?:tổng\s*)?(?:thành\s*viên|members?|người\s*theo\s*dõi|followers?)(?![a-z\u00C0-\u024F\u1EA0-\u1EF9])/i
  );
  if (memMatch) {
    const numStr = memMatch[1].replace(/\s+/g, ' ').trim();
    return `${numStr} thành viên`;
  }

  const subMatch = sanitized.match(/[·•]\s*([^·•\n]*(?:thành\s*viên|members?)[^·•\n]*)/i);
  if (subMatch) {
    return subMatch[1].trim();
  }

  return 'Đang cập nhật';
}

/**
 * Nhận diện quyền riêng tư của nhóm ("Công khai" / "Riêng tư" / "Chưa rõ").
 * Loại bỏ tên nhóm khỏi văn bản thẻ trước khi phân tích để không bị tên nhóm ("... Công Khai") làm sai lệch.
 */
export function detectGroupPrivacy(rawCardText, groupName = '') {
  if (!rawCardText || typeof rawCardText !== 'string') return 'Chưa rõ';

  let metaText = rawCardText;
  if (groupName && typeof groupName === 'string') {
    const trimmedName = groupName.trim();
    if (trimmedName.length >= 2) {
      const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      metaText = metaText.replace(new RegExp(escaped, 'gi'), ' ');
    }
  }

  // Xóa nhãn nút bấm & câu bạn bè không liên quan đến quyền riêng tư nhóm
  metaText = metaText
    .replace(/\b\d[\d.,]*\s*(?:người\s*bạn|bạn\s*chung|friends?)(?:\s+(?:là\s+thành\s+viên|(?:is|are)\s+(?:a\s+)?members?))?/gi, ' ');

  // Bước 1: Kiểm tra theo từng dòng / từng khúc phân cách bằng · hoặc • (chính xác cao nhất)
  const segments = metaText.split(/[\r\n·•|]+/).map(s => foldVietnamese(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const seg of segments) {
    if (/^(?:nhom\s+)?(?:rieng\s+tu|khong\s+cong\s+khai|nhom\s+kin|private(?:\s+group)?)$/.test(seg)) {
      return 'Riêng tư';
    }
    if (/^(?:nhom\s+)?(?:cong\s+khai|public(?:\s+group)?)$/.test(seg)) {
      return 'Công khai';
    }
    // Trường hợp dính số phía sau do HTML mất khoảng trắng: "cong khai151k thanh vien"
    if (/^(?:nhom\s+)?(?:rieng\s+tu|khong\s+cong\s+khai|private(?:\s+group)?)(?=\d|[^a-z])/.test(seg)) {
      return 'Riêng tư';
    }
    if (/^(?:nhom\s+)?(?:cong\s+khai|public(?:\s+group)?)(?=\d|[^a-z])/.test(seg)) {
      return 'Công khai';
    }
  }

  // Bước 2: Fallback kiểm tra toàn metaText đã bỏ dấu (kiểm tra "không công khai" TRƯỚC "công khai")
  const folded = foldVietnamese(metaText).replace(/\s+/g, ' ');
  if (/(?:^|[\s(\[,\-:])(?:nhom\s+rieng\s+tu|rieng\s+tu|khong\s+cong\s+khai|nhom\s+kin|private\s+group|private)(?=$|[\s\d)\],.:;\-])/.test(folded)) {
    return 'Riêng tư';
  }
  if (/(?:^|[\s(\[,\-:])(?!khong\s+)(?!not\s+)(?:nhom\s+cong\s+khai|cong\s+khai|public\s+group|public)(?=$|[\s\d)\],.:;\-])/.test(folded)) {
    // Đảm bảo không dính chữ "khong cong khai"
    if (!/\bkhong\s+cong\s+khai\b/.test(folded)) {
      return 'Công khai';
    }
  }

  return 'Chưa rõ';
}

const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'MAIN', 'ASIDE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE',
  'TBODY', 'THEAD', 'BLOCKQUOTE', 'FIGCAPTION'
]);
const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'CANVAS']);

/**
 * Chuyển đổi DOM Node (từ DOMParser) thành văn bản giữ nguyên ngắt dòng giữa các thẻ block
 * để không bị dính chữ ("Phòng trọCông khai151K") trong môi trường DOMParser không render layout.
 */
export function getStructuredText(node) {
  if (!node) return '';
  const parts = [];

  function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) {
      if (n.nodeValue) parts.push(n.nodeValue);
      return;
    }
    if (n.nodeType !== 1) return;

    const tag = (n.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    parts.push(isBlock ? '\n' : ' ');

    const children = n.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i]);
    }

    parts.push(isBlock ? '\n' : ' ');
  }

  walk(node);
  return parts
    .join('')
    .replace(/[ \t\u00A0\u200B\u200E\u200F]+/g, ' ')
    .replace(/ *\r?\n+ */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function getDistinctGroupUrlsInElement(el, limit = 2) {
  const urls = new Set();
  if (!el || typeof el.querySelectorAll !== 'function') return urls;
  const links = el.querySelectorAll('a[href]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute ? links[i].getAttribute('href') : links[i].href;
    const norm = normalizeGroupHref(href);
    if (norm) {
      urls.add(norm);
      if (limit > 0 && urls.size >= limit) return urls;
    }
  }
  return urls;
}

function pickGroupNameFromCard(anchorList, container, cardText, cleanUrl) {
  const candidates = [];

  for (const a of anchorList) {
    const rawTxt = getStructuredText(a).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const aria = (a.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    for (const c of [rawTxt, aria]) {
      if (!c || c.length < 2) continue;
      if (REJECTED_ANCHOR_TEXT_RE.test(c)) continue;
      if (PURE_METADATA_LINE_RE.test(c)) continue;
      candidates.push(c);
    }
  }

  // Chọn ứng viên không phải chỉ là slug hoặc số
  const nonEmpty = candidates.find(c => !/^\d+$/.test(c));
  if (nonEmpty) return nonEmpty.slice(0, 120);
  if (candidates.length > 0) return candidates[0].slice(0, 120);

  if (container && typeof container.querySelector === 'function') {
    const heading = container.querySelector('h1, h2, h3, h4, [role="heading"], strong, b');
    if (heading) {
      const hTxt = getStructuredText(heading).replace(/\n+/g, ' ').trim();
      if (hTxt && hTxt.length >= 2 && !REJECTED_ANCHOR_TEXT_RE.test(hTxt) && !PURE_METADATA_LINE_RE.test(hTxt)) {
        return hTxt.slice(0, 120);
      }
    }
  }

  if (cardText) {
    const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
    const titleLine = lines.find(l => l.length >= 3 && !REJECTED_ANCHOR_TEXT_RE.test(l) && !PURE_METADATA_LINE_RE.test(l));
    if (titleLine) return titleLine.slice(0, 120);
  }

  const slugMatch = cleanUrl.match(/\/groups\/([^\/]+)\/?$/i);
  return slugMatch ? slugMatch[1] : 'Nhóm Facebook';
}

function findSingleGroupCardContainer(anchorList, bodyEl) {
  // Ưu tiên leo từ anchor tiêu đề (có text khác rỗng), nếu không thì từ anchor đầu tiên
  const preferred = anchorList.find(a => {
    const t = getStructuredText(a).trim();
    return t.length >= 2 && !REJECTED_ANCHOR_TEXT_RE.test(t);
  }) || anchorList[0];

  if (!preferred) return null;

  let best = preferred;
  let curr = preferred.parentElement;
  let steps = 0;

  while (curr && curr !== bodyEl && curr.tagName !== 'BODY' && curr.tagName !== 'HTML' && steps < 12) {
    const distinct = getDistinctGroupUrlsInElement(curr, 2);
    if (distinct.size > 1) break;

    const txtLen = getStructuredText(curr).length;
    if (txtLen > 1400) break;

    best = curr;
    curr = curr.parentElement;
    steps++;
  }

  // Nếu tiêu đề và thumbnail nằm ở nhánh anh em bên ngoài nhưng có ít hơn metadata ở container hiện tại,
  // thử leo từ các anchor còn lại trong cùng nhóm (nhưng vẫn giữ distinct.size === 1)
  if (anchorList.length > 1 && getDistinctGroupUrlsInElement(best, 2).size === 1) {
    for (const alt of anchorList) {
      if (alt === preferred) continue;
      let altBest = alt;
      let altCurr = alt.parentElement;
      let altSteps = 0;
      while (altCurr && altCurr !== bodyEl && altCurr.tagName !== 'BODY' && altCurr.tagName !== 'HTML' && altSteps < 12) {
        if (getDistinctGroupUrlsInElement(altCurr, 2).size > 1) break;
        if (getStructuredText(altCurr).length > 1400) break;
        altBest = altCurr;
        altCurr = altCurr.parentElement;
        altSteps++;
      }
      if (getStructuredText(altBest).length > getStructuredText(best).length) {
        best = altBest;
      }
    }
  }

  return best;
}

function extractGroupsWithDOMParser(html, domParser) {
  const doc = domParser.parseFromString(String(html), 'text/html');
  const bodyEl = doc.body || doc.documentElement;
  const allLinks = doc.querySelectorAll('a[href]');

  const anchorsByUrl = new Map();
  for (let i = 0; i < allLinks.length; i++) {
    const a = allLinks[i];
    const rawHref = a.getAttribute ? a.getAttribute('href') : a.href;
    const cleanUrl = normalizeGroupHref(rawHref);
    if (!cleanUrl) continue;
    if (!anchorsByUrl.has(cleanUrl)) {
      anchorsByUrl.set(cleanUrl, []);
    }
    anchorsByUrl.get(cleanUrl).push(a);
  }

  const items = [];
  for (const [cleanUrl, anchorList] of anchorsByUrl.entries()) {
    const container = findSingleGroupCardContainer(anchorList, bodyEl);
    let cardText = getStructuredText(container);

    // Fallback nếu card bị cắt phẳng không bọc được metadata (ví dụ thẻ <a> đứng liền nhau không có wrapper riêng)
    if (container && cardText.length < 30 && container.parentElement && container.parentElement !== bodyEl) {
      const parentText = getStructuredText(container.parentElement);
      const firstAnchorText = getStructuredText(anchorList[0]).trim();
      if (firstAnchorText && parentText.includes(firstAnchorText)) {
        const idx = parentText.indexOf(firstAnchorText);
        cardText = parentText.slice(idx, idx + 450);
      }
    }

    const name = pickGroupNameFromCard(anchorList, container, cardText, cleanUrl);
    const privacy = detectGroupPrivacy(cardText, name);
    const members = extractMemberText(cardText);
    const memberCount = parseMemberCount(members);

    items.push({
      name,
      url: cleanUrl,
      privacy,
      members,
      memberCount
    });
  }

  return items;
}

function decodeBasicHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10) || 32));
}

function stripTagsToStructuredText(fragment) {
  return decodeBasicHtmlEntities(
    String(fragment || '')
      .replace(/<(style|script|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(?:br\b[^>]*|\/?(?:div|p|li|h[1-6]|tr|section|article|header|footer|aside|blockquote)\b[^>]*)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

/**
 * Fallback thuần JS khi chạy trong môi trường không có DOMParser (ví dụ Node CLI).
 */
function extractGroupsFromHtmlRegexFallback(html) {
  const cleaned = String(html || '').replace(/<(style|script|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const anchorRe = /<a\b([^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*)>([\s\S]*?)<\/a>/gi;
  const occurrences = [];
  let m;

  while ((m = anchorRe.exec(cleaned)) !== null) {
    const rawHref = decodeBasicHtmlEntities(m[2] || m[3] || m[4] || '');
    const cleanUrl = normalizeGroupHref(rawHref);
    if (!cleanUrl) continue;

    const innerText = stripTagsToStructuredText(m[5]).replace(/\n+/g, ' ').trim();
    const ariaMatch = m[1].match(/aria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const ariaText = decodeBasicHtmlEntities(ariaMatch?.[1] || ariaMatch?.[2] || '').trim();

    occurrences.push({
      url: cleanUrl,
      index: m.index,
      endIndex: m.index + m[0].length,
      text: (!REJECTED_ANCHOR_TEXT_RE.test(innerText) && innerText.length >= 2) ? innerText : '',
      ariaText: (!REJECTED_ANCHOR_TEXT_RE.test(ariaText) && ariaText.length >= 2) ? ariaText : ''
    });
  }

  // Gom các lần xuất hiện cùng cleanUrl
  const grouped = new Map();
  for (const occ of occurrences) {
    if (!grouped.has(occ.url)) {
      grouped.set(occ.url, { url: occ.url, occs: [occ] });
    } else {
      grouped.get(occ.url).occs.push(occ);
    }
  }

  // Sắp xếp điểm bắt đầu của từng card khác URL để giới hạn chính xác từng khung card
  const distinctFirstPos = [];
  for (const entry of grouped.values()) {
    distinctFirstPos.push({ url: entry.url, pos: entry.occs[0].index });
  }
  distinctFirstPos.sort((a, b) => a.pos - b.pos);

  const items = [];
  for (let i = 0; i < distinctFirstPos.length; i++) {
    const { url, pos } = distinctFirstPos[i];
    const entry = grouped.get(url);
    const prevDistinctPos = i > 0 ? distinctFirstPos[i - 1].pos : 0;
    const nextDistinctPos = i + 1 < distinctFirstPos.length ? distinctFirstPos[i + 1].pos : cleaned.length;
    const forwardEnd = Math.min(nextDistinctPos, pos + 3500);
    const forwardText = stripTagsToStructuredText(cleaned.slice(pos, forwardEnd));

    const bestTextOcc = entry.occs.find(o => o.text && !PURE_METADATA_LINE_RE.test(o.text)) ||
                        entry.occs.find(o => o.ariaText && !PURE_METADATA_LINE_RE.test(o.ariaText));
    const slugMatch = url.match(/\/groups\/([^\/]+)\/?$/i);
    const name = (bestTextOcc?.text || bestTextOcc?.ariaText || slugMatch?.[1] || 'Nhóm Facebook').slice(0, 120);

    let privacy = detectGroupPrivacy(forwardText, name);
    let members = extractMemberText(forwardText);

    // Chỉ lùi tối đa 160 ký tự về trước thẻ <a> nếu phía trước thẻ <a> của chính card này còn thiếu thông tin
    if (privacy === 'Chưa rõ' || members === 'Đang cập nhật') {
      const safeBackStart = Math.max(prevDistinctPos, pos - 160);
      const extendedText = stripTagsToStructuredText(cleaned.slice(safeBackStart, forwardEnd));
      if (privacy === 'Chưa rõ') privacy = detectGroupPrivacy(extendedText, name);
      if (members === 'Đang cập nhật') members = extractMemberText(extendedText);
    }

    const memberCount = parseMemberCount(members);

    items.push({ url, name, privacy, members, memberCount });
  }

  return items;
}

/**
 * Trích xuất danh sách nhóm từ chuỗi HTML clipboard / trang Facebook search.
 */
export function extractGroupsFromHtml(html, options = {}) {
  if (!html || typeof html !== 'string' || !html.trim()) return [];
  const domParser = options.domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
  if (domParser && typeof domParser.parseFromString === 'function') {
    return extractGroupsWithDOMParser(html, domParser);
  }
  return extractGroupsFromHtmlRegexFallback(html);
}

/**
 * Trích xuất danh sách nhóm từ văn bản thuần (chứa các URL https://www.facebook.com/groups/...).
 */
export function extractGroupsFromPlainText(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { items: [], hasFbSearchHints: false };
  }

  const normalizedText = text.replace(/\r\n/g, '\n');
  const foldedAll = foldVietnamese(normalizedText);
  const hasFbSearchHints = (
    /(?:thanh vien|members?|bai viet\/ngay|posts? a day|nhom cong khai|nhom rieng tu)/.test(foldedAll) &&
    /(?:cong khai|rieng tu|tham gia|public|private|join)/.test(foldedAll)
  );

  const lines = normalizedText.split('\n');
  const urlRe = /https?:\/\/(?:www\.|m\.|web\.|mbasic\.|touch\.|l\.|lm\.)?facebook\.com\/[^\s<>"')\]]+/gi;
  const items = [];
  const seenUrls = new Set();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const matches = line.match(urlRe);
    if (!matches) continue;

    for (const rawUrl of matches) {
      const cleanUrl = normalizeGroupHref(rawUrl);
      if (!cleanUrl || seenUrls.has(cleanUrl)) continue;
      seenUrls.add(cleanUrl);

      // Lấy bối cảnh tối đa 2 dòng trước và 3 dòng sau (dừng nếu gặp URL /groups/ khác)
      const ctxLines = [];
      const inlineRemainder = line.replace(rawUrl, ' ').replace(/[|\-–·•]+/g, ' ').trim();
      if (idx > 0 && !/facebook\.com\/groups\//i.test(lines[idx - 1])) {
        ctxLines.push(lines[idx - 1].trim());
      }
      ctxLines.push(inlineRemainder);
      for (let ahead = 1; ahead <= 3 && idx + ahead < lines.length; ahead++) {
        if (/facebook\.com\/groups\//i.test(lines[idx + ahead])) break;
        ctxLines.push(lines[idx + ahead].trim());
      }

      const cardText = ctxLines.filter(Boolean).join('\n');
      let name = '';
      if (inlineRemainder && !PURE_METADATA_LINE_RE.test(inlineRemainder) && !REJECTED_ANCHOR_TEXT_RE.test(inlineRemainder)) {
        name = inlineRemainder;
      } else if (idx > 0 && !/facebook\.com\/groups\//i.test(lines[idx - 1])) {
        const prev = lines[idx - 1].trim();
        if (prev && !PURE_METADATA_LINE_RE.test(prev) && !REJECTED_ANCHOR_TEXT_RE.test(prev)) {
          name = prev;
        }
      }
      if (!name) {
        const slug = cleanUrl.match(/\/groups\/([^\/]+)\/?$/i)?.[1];
        name = slug || 'Nhóm Facebook';
      }

      const privacy = detectGroupPrivacy(cardText, name);
      const members = extractMemberText(cardText);
      const memberCount = parseMemberCount(members);

      items.push({
        name: name.slice(0, 120),
        url: cleanUrl,
        privacy,
        members,
        memberCount
      });
    }
  }

  return { items, hasFbSearchHints };
}

/**
 * Tổng hợp trích xuất từ payload clipboard { html, text } (hỗ trợ HTML, JSON và Plain Text).
 */
export function extractGroupsFromClipboardPayload({ html = '', text = '' } = {}, options = {}) {
  const merged = new Map();
  let source = 'none';

  // 1. Thử parse JSON có cấu trúc nếu người dùng dán JSON danh sách nhóm
  if (typeof text === 'string' && (text.trim().startsWith('[') || text.trim().startsWith('{'))) {
    try {
      const parsedJson = JSON.parse(text.trim());
      const arr = Array.isArray(parsedJson) ? parsedJson : (Array.isArray(parsedJson?.groups) ? parsedJson.groups : []);
      for (const entry of arr) {
        const cleanUrl = normalizeGroupHref(entry?.url || entry?.link || entry?.href);
        if (!cleanUrl || merged.has(cleanUrl)) continue;
        const name = String(entry?.name || '').trim() || cleanUrl.match(/\/groups\/([^\/]+)\/?$/i)?.[1] || 'Nhóm Facebook';
        const privacyRaw = String(entry?.privacy || '');
        const privacy = privacyRaw === 'Công khai' || privacyRaw === 'Riêng tư'
          ? privacyRaw
          : detectGroupPrivacy(privacyRaw || JSON.stringify(entry), name);
        const members = entry?.members ? String(entry.members) : extractMemberText(JSON.stringify(entry));
        const memberCount = Number(entry?.memberCount) || parseMemberCount(members);
        merged.set(cleanUrl, { name: name.slice(0, 120), url: cleanUrl, privacy, members, memberCount });
      }
      if (merged.size > 0) source = 'json';
    } catch (_) {}
  }

  // 2. HTML rich clipboard (từ Ctrl+A -> Ctrl+C trên tab Facebook)
  if (typeof html === 'string' && html.trim()) {
    const htmlItems = extractGroupsFromHtml(html, options);
    for (const item of htmlItems) {
      if (!merged.has(item.url)) {
        merged.set(item.url, item);
      }
    }
    if (htmlItems.length > 0 && source === 'none') {
      source = 'html';
    }
  }

  // 3. Plain text URL fallback hoặc bổ sung
  const plainRes = extractGroupsFromPlainText(text);
  for (const item of plainRes.items) {
    if (!merged.has(item.url)) {
      merged.set(item.url, item);
    } else {
      // Bổ sung thông tin còn thiếu nếu bản HTML thiếu privacy hoặc members
      const cur = merged.get(item.url);
      if (cur.privacy === 'Chưa rõ' && item.privacy !== 'Chưa rõ') cur.privacy = item.privacy;
      if ((!cur.memberCount || cur.memberCount === 0) && item.memberCount > 0) {
        cur.members = item.members;
        cur.memberCount = item.memberCount;
      }
    }
  }
  if (plainRes.items.length > 0 && source === 'none') {
    source = 'text';
  }

  const items = Array.from(merged.values());
  const textWithoutUrls = items.length === 0 && plainRes.hasFbSearchHints;

  return {
    items,
    source,
    textWithoutUrls
  };
}

/**
 * Lọc danh sách nhóm đã trích xuất theo Quyền riêng tư, Thành viên tối thiểu,
 * Giới hạn mỗi từ khóa & Bộ chống quét trùng đa tầng.
 */
export function filterAndPrepareImportedGroups(parsedItems, options = {}) {
  const {
    keyword = '',
    privacyMode = 'public_only',
    minMembers = 10000,
    maxCountPerKeyword = 0,
    existingCountForKeyword = 0,
    historyKeySet = new Set(),
    categoryKeySet = new Set(),
    sessionUrls = new Set(),
    sessionKeys = new Set(),
    sessionNames = new Set(),
    dedupeHistory = true,
    dedupeCategories = true,
    dedupeName = true,
    existingGroupList = []
  } = options;

  const stats = {
    totalParsed: Array.isArray(parsedItems) ? parsedItems.length : 0,
    added: 0,
    skippedPrivacy: 0,
    skippedUnknownPrivacy: 0,
    skippedLowMembers: 0,
    skippedDuplicate: 0,
    skippedLimit: 0
  };

  const accepted = [];
  const newKeysToSave = [];
  const keywordTaggedUrls = [];
  const remainingQuota = maxCountPerKeyword > 0
    ? Math.max(0, maxCountPerKeyword - existingCountForKeyword)
    : Infinity;

  if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
    return { accepted, stats, newKeysToSave, keywordTaggedUrls };
  }

  for (const item of parsedItems) {
    if (!item || !item.url) continue;

    // 1. Lọc theo chế độ Công khai / Riêng tư
    if (privacyMode === 'public_only') {
      if (item.privacy === 'Riêng tư') {
        stats.skippedPrivacy++;
        continue;
      }
      if (item.privacy !== 'Công khai') {
        stats.skippedUnknownPrivacy++;
        continue;
      }
    } else if (privacyMode === 'private_only') {
      if (item.privacy === 'Công khai') {
        stats.skippedPrivacy++;
        continue;
      }
      if (item.privacy !== 'Riêng tư') {
        stats.skippedUnknownPrivacy++;
        continue;
      }
    }

    // 2. Lọc theo số lượng thành viên tối thiểu
    const memberCount = item.memberCount || parseMemberCount(item.members);
    if (minMembers > 0 && memberCount < minMembers) {
      stats.skippedLowMembers++;
      continue;
    }

    // 3. Bộ chống quét trùng nhóm
    const key = extractCanonicalGroupKey(item.url);
    const normName = normalizeGroupName(item.name);
    const hasSignificantName = normName && normName.length >= 5 && !/^\d+$/.test(normName);

    if (dedupeHistory && key && historyKeySet.has(key)) {
      stats.skippedDuplicate++;
      continue;
    }
    if (dedupeCategories && key && categoryKeySet.has(key)) {
      stats.skippedDuplicate++;
      continue;
    }

    if (sessionUrls.has(item.url) || (key && sessionKeys.has(key))) {
      stats.skippedDuplicate++;
      if (keyword && Array.isArray(existingGroupList) && existingGroupList.length > 0) {
        const existing = existingGroupList.find(g => g.url === item.url || (key && extractCanonicalGroupKey(g.url) === key));
        if (existing) {
          const existingKws = String(existing.keyword || '').split(',').map(s => s.trim().toLowerCase());
          if (!existingKws.includes(keyword.toLowerCase())) {
            existing.keyword = existing.keyword ? `${existing.keyword}, ${keyword}` : keyword;
            keywordTaggedUrls.push(existing.url);
          }
        }
      }
      continue;
    }

    if (dedupeName && hasSignificantName && sessionNames.has(normName)) {
      stats.skippedDuplicate++;
      if (keyword && Array.isArray(existingGroupList) && existingGroupList.length > 0) {
        const existing = existingGroupList.find(g => normalizeGroupName(g.name) === normName);
        if (existing) {
          const existingKws = String(existing.keyword || '').split(',').map(s => s.trim().toLowerCase());
          if (!existingKws.includes(keyword.toLowerCase())) {
            existing.keyword = existing.keyword ? `${existing.keyword}, ${keyword}` : keyword;
            keywordTaggedUrls.push(existing.url);
          }
        }
      }
      continue;
    }

    // 4. Kiểm tra giới hạn số lượng nhóm tối đa mỗi từ khóa
    if (accepted.length >= remainingQuota) {
      stats.skippedLimit++;
      continue;
    }

    const isNumericName = /^\d+$/.test((item.name || '').trim());
    const resolvedName = isNumericName
      ? (item.url.match(/\/groups\/([^\/]+)\/?$/)?.[1] || item.name)
      : (item.name || 'Nhóm Facebook');

    let approvalStatus = 'uninspected';
    let approvalBadge = '⚪ Chưa kiểm tra';
    let approvalLabel = 'Chưa kiểm tra kiểm duyệt bài viết';

    if (item.privacy === 'Riêng tư') {
      approvalStatus = 'private';
      approvalBadge = '🔒 Riêng tư';
      approvalLabel = 'Nhóm riêng tư (Quyền riêng tư trên Facebook)';
    } else if (item.privacy === 'Công khai') {
      approvalStatus = 'uninspected';
      approvalBadge = '🌐 Công khai (Chưa check bài)';
      approvalLabel = 'Nhóm Công khai — chế độ Web lọc nhanh quyền riêng tư, chưa tự mở từng nhóm kiểm duyệt bài viết';
    }

    const groupObj = {
      id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: resolvedName,
      url: item.url,
      privacy: item.privacy || 'Chưa rõ',
      members: item.members || 'Đang cập nhật',
      memberCount,
      keyword: keyword || '',
      approvalStatus,
      approvalLabel,
      approvalBadge,
      selected: true
    };

    sessionUrls.add(item.url);
    if (key) {
      sessionKeys.add(key);
      newKeysToSave.push(key);
    }
    if (hasSignificantName) {
      sessionNames.add(normName);
    }

    accepted.push(groupObj);
    stats.added++;
  }

  return {
    accepted,
    stats,
    newKeysToSave,
    keywordTaggedUrls
  };
}
