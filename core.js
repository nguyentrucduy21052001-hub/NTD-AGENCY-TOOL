export function groups(text) {
 const out=[]; for(const line of text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
 let u; try {u=new URL(line);} catch {throw Error('Link nhóm không hợp lệ: '+line);}
 const m=u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
 if(!['www.facebook.com','facebook.com'].includes(u.hostname)||u.protocol!=='https:'||!m||['feed','discover','joins'].includes(m[1])) throw Error('Chỉ nhận link https://www.facebook.com/groups/ten-hoac-id');
 const value='https://www.facebook.com/groups/'+m[1]+'/'; if(!out.includes(value))out.push(value);
 } if(!out.length)throw Error('Hãy nhập ít nhất một link nhóm.'); return out;
}

export function normalizeGroupUrl(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : 'https://' + trimmed);
    if (!['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(u.hostname.toLowerCase())) return null;
    const m = u.pathname.match(/\/groups\/([a-zA-Z0-9._-]+)/i);
    if (!m || ['feed', 'discover', 'joins', 'create', 'search'].includes(m[1].toLowerCase())) return null;
    return `https://www.facebook.com/groups/${m[1]}/`;
  } catch (_) {
    return null;
  }
}

export function getGroupKey(line) {
  const norm = normalizeGroupUrl(line);
  if (norm) {
    const m = norm.match(/\/groups\/([a-zA-Z0-9._-]+)\//i);
    if (m) return m[1].toLowerCase();
  }
  const clean = (line || '').trim().toLowerCase();
  const m = clean.match(/\/groups\/([a-zA-Z0-9._-]+)/i);
  if (m) return m[1].toLowerCase();
  return clean.replace(/\/+$/, '');
}

export async function getAllPostedGroupKeys() {
  const keys = new Set();
  try {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    if (campaigns && typeof campaigns === 'object') {
      for (const c of Object.values(campaigns)) {
        for (const j of c?.jobs || []) {
          const isDone = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(j.status) || Boolean(j.postUrl);
          if (isDone && j.url) {
            const k = getGroupKey(j.url);
            if (k) keys.add(k);
          }
        }
      }
    }
    const { postedGroupHistory } = await chrome.storage.local.get('postedGroupHistory');
    if (Array.isArray(postedGroupHistory)) {
      for (const item of postedGroupHistory) {
        const k = getGroupKey(item);
        if (k) keys.add(k);
      }
    }
  } catch (_) {}
  return keys;
}

export async function recordPostedGroupUrl(url) {
  if (!url || typeof url !== 'string') return;
  try {
    const k = getGroupKey(url);
    if (!k) return;
    const { postedGroupHistory = [] } = await chrome.storage.local.get('postedGroupHistory');
    const list = Array.isArray(postedGroupHistory) ? [...postedGroupHistory] : [];
    if (!list.includes(k)) {
      list.push(k);
      const trimmed = list.slice(-20000);
      await chrome.storage.local.set({ postedGroupHistory: trimmed });
    }
  } catch (_) {}
}
export function spinText(text){
 if(!text)return text;
 let prev='',result=text,maxIter=20;
 while(result!==prev&&maxIter-->0){
  prev=result;
  result=result.replace(/\{\{([^{}]+)\}\}/g,(_,opts)=>{
   const arr=opts.split('|');
   return arr[Math.floor(Math.random()*arr.length)];
  });
 }
 result=result.replace(/\(\(([^()]*)\)\)/g,(_,inner)=>Math.random()>0.5?inner:'');
 result=result.replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
 return result;
}

export function getTodayDateStr(date = new Date()) {
 const d = date instanceof Date ? date : new Date(date);
 const y = d.getFullYear();
 const m = String(d.getMonth() + 1).padStart(2, '0');
 const day = String(d.getDate()).padStart(2, '0');
 return `${y}-${m}-${day}`;
}

export function validate(d){
 let urls = [];
 if (d.links?.trim()) {
  try { urls = groups(d.links); } catch (e) { if (!d.accountGroups && !d.allowEmptyLinks) throw e; }
 }
 if (d.accountGroups && Object.values(d.accountGroups).some(g => g?.trim())) {
  for (const grpStr of Object.values(d.accountGroups)) {
   if (grpStr?.trim()) {
    try { urls.push(...groups(grpStr)); } catch (e) { throw e; }
   }
  }
  urls = [...new Set(urls)];
 }
 if (!urls.length && !d.allowEmptyLinks) {
  throw Error('Hãy nhập ít nhất một link nhóm hoặc chọn danh mục nhóm.');
 }
 let postText = d.text;
 if (!postText?.trim() && d.posts && Array.isArray(d.posts)) {
  const readyP = d.posts.find(p => p?.text?.trim());
  if (readyP) postText = readyP.text;
 }
 if(!postText?.trim())throw Error('Hãy nhập nội dung bài viết.');
 if(postText.length>20000)throw Error('Nội dung tối đa 20.000 ký tự.');
 const bannedViolations = findBannedWords(postText);
 if(bannedViolations.length > 0) {
  const uniqueBanned = [...new Set(bannedViolations.map(b => b.word))];
  throw Error(`Nội dung chứa từ cấm vi phạm chính sách Facebook: ${uniqueBanned.join(', ')}. Hãy xóa các từ này trước khi đăng!`);
 }
 const gap=Number(d.gapMin ?? d.gap ?? 180);
 if(!Number.isFinite(gap)||gap<60)throw Error('Khoảng cách tối thiểu 60 giây.');
 const gapMax=Number(d.gapMax ?? gap);
 if(!Number.isFinite(gapMax)||gapMax<gap)throw Error('Khoảng cách tối đa phải lớn hơn hoặc bằng khoảng cách tối thiểu.');
 if(!['preview','auto'].includes(d.mode))throw Error('Chế độ không hợp lệ.');
 const breakAfter = d.breakAfter ? Math.max(1, Number(d.breakAfter)) : 5;
 const breakMinutes = d.breakMinutes ? Math.max(1, Number(d.breakMinutes)) : 10;
 const maxPosts = d.maxPosts ? Math.max(0, Number(d.maxPosts)) : 0;
 const enableDailyLimit = d.enableDailyLimit !== undefined ? !!d.enableDailyLimit : true;
 const dailyLimit = d.dailyLimit ? Math.max(1, Number(d.dailyLimit)) : 20;
 const accountOrder = ['round_robin', 'sequential', 'parallel'].includes(d.accountOrder) ? d.accountOrder : 'round_robin';
 const splitSharedGroups = !!d.splitSharedGroups;
 return {
  ...d,
  urls,
  gap,
  gapMin: gap,
  gapMax,
  accountOrder,
  splitSharedGroups,
  randomTag: d.randomTag !== undefined ? !!d.randomTag : true,
  enableBreak: d.enableBreak !== undefined ? !!d.enableBreak : true,
  breakAfter,
  breakMinutes,
  humanBehavior: d.humanBehavior !== undefined ? !!d.humanBehavior : true,
  autoSkipOnError: d.autoSkipOnError !== undefined ? !!d.autoSkipOnError : true,
  maxPosts,
  enableDailyLimit,
  dailyLimit
 };
}

export function parseUniversalCookies(input) {
 if (!input) return {};
 if (typeof input === 'object' && !Array.isArray(input)) return input;

 let str = String(input).trim();
 const result = {};

 // 1. Thử parse JSON (dạng cookie export từ Cookie-Editor, J2Team, Appstate: [{"name":"...","value":"..."}, ...])
 if ((str.startsWith('[') && str.endsWith(']')) || (str.startsWith('{') && str.endsWith('}'))) {
  try {
   const parsed = JSON.parse(str);
   if (Array.isArray(parsed)) {
    for (const item of parsed) {
     const k = item.name || item.key;
     const v = item.value;
     if (k && v !== undefined) {
      result[String(k).trim()] = String(v).trim();
     }
    }
    if (Object.keys(result).length > 0) {
      if (result['xs'] && result['xs'].includes(':') && !result['xs'].includes('%3A')) {
        result['xs'] = result['xs'].replace(/:/g, '%3A');
      }
      return result;
    }
   } else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
     if (k && v !== undefined) {
      result[String(k).trim()] = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
     }
    }
    if (Object.keys(result).length > 0) {
      if (result['xs'] && result['xs'].includes(':') && !result['xs'].includes('%3A')) {
        result['xs'] = result['xs'].replace(/:/g, '%3A');
      }
      return result;
    }
   }
  } catch (_) {}
 }

 // 2. Bỏ tiền tố header nếu có: "Cookie: " hoặc "cookie: "
 str = str.replace(/^[Cc]ookie:\s*/, '');

 // 3. Chuẩn hóa phân tách theo dấu chấm phẩy, xuống dòng hoặc &
 const tokens = str.split(/[;\r\n&]+/).map(s => s.trim()).filter(Boolean);
 const skipKeys = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'partitioned']);

 for (const token of tokens) {
  const eqIdx = token.indexOf('=');
  if (eqIdx <= 0) continue;
  const rawKey = token.slice(0, eqIdx).trim();
  let rawVal = token.slice(eqIdx + 1).trim();

  // Bỏ qua các thuộc tính của Set-Cookie
  if (skipKeys.has(rawKey.toLowerCase())) continue;

  // Bỏ dấu nháy bọc ngoài nếu có: "..."
  if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
   rawVal = rawVal.slice(1, -1);
  }

  if (rawKey) {
   result[rawKey] = rawVal;
  }
 }

 // Chuẩn hóa xs: nếu xs chứa dấu ':' chưa được mã hóa URL thành '%3A', tự động chuyển đổi
 if (result['xs'] && result['xs'].includes(':') && !result['xs'].includes('%3A')) {
  result['xs'] = result['xs'].replace(/:/g, '%3A');
 }

 return result;
}

export function cookiesObjToStr(obj) {
 if (!obj || typeof obj !== 'object') return '';
 return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── BANNED WORDS DICTIONARY (12 NHÓM TỪ CẤM VI PHẠM CHÍNH SÁCH FACEBOOK) ────────
export const BANNED_CATEGORIES = [
 {
  id: 1,
  name: 'Nội dung tình dục, người lớn',
  words: [
   'Sex', 'XXX', 'khiêu dâm', 'phim sex', 'clip nóng', 'ảnh nóng', 'ảnh khỏa thân',
   'nude', 'mại dâm', 'gái gọi', 'trai bao', 'kích dục', 'dịch vụ tình dục',
   'massage kích dục', 'quan hệ tình dục', 'chat sex', 'bán dâm', 'mua dâm'
  ]
 },
 {
  id: 2,
  name: 'Cờ bạc, cá cược',
  words: [
   'Cá độ', 'đánh bạc', 'tài xỉu', 'xóc đĩa', 'lô đề', 'số đề', 'casino', 'nhà cái',
   'cá cược bóng đá', 'cá cược online', 'đá gà ăn tiền', 'nạp tiền cá cược',
   'soi kèo chắc thắng', 'bao trúng', 'đặt cược', 'jackpot'
  ]
 },
 {
  id: 3,
  name: 'Ma túy, chất cấm',
  words: [
   'Ma túy', 'heroin', 'cocaine', 'thuốc lắc', 'cần sa', 'marijuana', 'methamphetamine',
   'thuốc phiện', 'chất gây nghiện', 'mua bán ma túy', 'thuốc kích thích trái phép',
   'hàng cấm', 'thuốc kê đơn không cần đơn'
  ]
 },
 {
  id: 4,
  name: 'Vũ khí, bạo lực',
  words: [
   'Bán súng', 'súng đạn', 'đạn dược', 'thuốc nổ', 'bom tự chế', 'chế tạo bom',
   'thuê người đánh', 'giết người', 'đâm chém', 'thủ tiêu', 'ám sát', 'khủng bố',
   'đe dọa giết', 'hành hung', 'tra tấn'
  ]
 },
 {
  id: 5,
  name: 'Lừa đảo, tài chính',
  words: [
   'Kiếm tiền 100%', 'lợi nhuận đảm bảo', 'lãi suất 100%', 'không bao giờ thua lỗ',
   'làm giàu nhanh', 'nhân đôi tài khoản', 'kiếm tiền không cần làm',
   'vay tiền không cần điều kiện', 'đầu tư chắc thắng', 'cam kết hoàn vốn',
   'lợi nhuận không rủi ro', 'trúng thưởng 100%'
  ]
 },
 {
  id: 6,
  name: 'Sức khỏe, thuốc và làm đẹp',
  words: [
   'Chữa khỏi 100%', 'trị dứt điểm', 'thuốc chữa bách bệnh', 'chữa ung thư thần kỳ',
   'giảm cân thần tốc', 'giảm 10kg trong 7 ngày', 'giảm mỡ tức thì', 'trắng da vĩnh viễn',
   'tăng chiều cao cấp tốc', 'thuốc tăng sinh lý', 'điều trị không cần bác sĩ',
   'cam kết khỏi bệnh', 'hiệu quả tuyệt đối'
  ]
 },
 {
  id: 7,
  name: 'Phân biệt đối xử, xúc phạm',
  words: [
   'Ngôn từ miệt thị chủng tộc', 'xúc phạm tôn giáo', 'kỳ thị giới tính',
   'kỳ thị người khuyết tật', 'kích động thù ghét', 'đe dọa cá nhân', 'kêu gọi tấn công',
   'xúc phạm ngoại hình', 'kêu gọi bạo lực đối với cộng đồng'
  ]
 },
 {
  id: 8,
  name: 'Spam và tương tác giả',
  words: [
   'Buff like', 'buff follow', 'mua follow ảo', 'bán tài khoản giả', 'tăng tương tác ảo',
   'tăng mắt livestream ảo', 'mua review giả', 'bán đánh giá 5 sao giả', 'spam inbox',
   'spam bình luận', 'tạo tài khoản hàng loạt', 'bán tài khoản Facebook'
  ]
 },
 {
  id: 9,
  name: 'Quảng cáo phóng đại, gây hiểu nhầm',
  words: [
   'Cam kết 100%', 'đảm bảo thành công', 'hiệu quả tuyệt đối', 'rẻ nhất Việt Nam',
   'tốt nhất thế giới', 'số 1 thị trường', 'duy nhất hôm nay', 'miễn phí trọn đời',
   'không giới hạn vĩnh viễn', 'chắc chắn nhận quà', 'ai cũng trúng thưởng', 'bảo đảm không rủi ro'
  ]
 },
 {
  id: 10,
  name: 'Hàng giả, giấy tờ và giao dịch bất hợp pháp',
  words: [
   'Hàng fake', 'hàng giả', 'hàng nhái', 'giấy tờ giả', 'bằng cấp giả', 'làm CCCD giả',
   'làm hộ chiếu giả', 'mua bán dữ liệu cá nhân', 'bán tài khoản ngân hàng',
   'bán thông tin khách hàng', 'mua bán tài khoản đánh cắp'
  ]
 },
 {
  id: 11,
  name: 'Tự gây hại, hành vi nguy hiểm',
  words: [
   'Tự tử', 'tự sát', 'tự hại', 'cắt tay', 'hướng dẫn tự tử', 'thử thách nguy hiểm',
   'nhịn ăn cực đoan', 'cổ vũ tự gây thương tích'
  ]
 },
 {
  id: 12,
  name: 'Từ khóa nhạy cảm trong quảng cáo Marketing',
  words: [
   'Béo phì', 'thừa cân', 'hói đầu', 'vô sinh', 'yếu sinh lý', 'trầm cảm', 'mắc bệnh',
   'nợ nần', 'phá sản', 'nghèo khó', 'thất nghiệp', 'bệnh ung thư', 'HIV', 'tiểu đường',
   'mụn nặng', 'da xấu', 'cơ thể xấu'
  ]
 },
 {
  id: 13,
  name: 'Khuyến mãi, giảm giá & ưu đãi',
  words: [
   'Khuyến mãi', 'khuyến mại', 'km', 'giảm giá', 'ưu đãi', 'đặc biệt', 'deal'
  ]
 }
];

export function escapeRegex(string) {
 return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tìm tất cả các từ cấm xuất hiện trong text.
 * Trả về mảng: [{ word, rawRule, category, index, length }]
 */
export function findBannedWords(text) {
 if (!text || typeof text !== 'string') return [];
 const matches = [];

 for (const cat of BANNED_CATEGORIES) {
  for (const rawWord of cat.words) {
   const trimmed = rawWord.trim();
   if (!trimmed) continue;

   const escaped = escapeRegex(trimmed);
   // Ranh giới chữ: Bắt đầu hoặc trước là ký tự không phải chữ/số, kết thúc hoặc sau là ký tự không phải chữ/số
   const pattern = new RegExp(`(?<=^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, 'giu');

   let m;
   while ((m = pattern.exec(text)) !== null) {
    matches.push({
     word: m[0],
     rawRule: trimmed,
     category: cat.name,
     index: m.index,
     length: m[0].length
    });
   }
  }
 }

 matches.sort((a, b) => a.index - b.index);
 return matches;
}

/**
 * Bôi đỏ các từ cấm trong văn bản dưới dạng HTML mark
 */
export function highlightBannedWordsHtml(text) {
 if (!text) return '';
 const violations = findBannedWords(text);
 if (!violations.length) {
  return escapeHtmlText(text);
 }

 const sorted = violations.map(v => ({ start: v.index, end: v.index + v.length })).sort((a, b) => a.start - b.start);
 const merged = [];
 for (const r of sorted) {
  if (!merged.length) {
   merged.push({ start: r.start, end: r.end });
  } else {
   const last = merged[merged.length - 1];
   if (r.start <= last.end) {
    last.end = Math.max(last.end, r.end);
   } else {
    merged.push({ start: r.start, end: r.end });
   }
  }
 }

 let result = '';
 let lastIdx = 0;
 for (const r of merged) {
  result += escapeHtmlText(text.slice(lastIdx, r.start));
  result += `<mark class="banned-highlight" title="Từ cấm vi phạm chính sách Facebook">${escapeHtmlText(text.slice(r.start, r.end))}</mark>`;
  lastIdx = r.end;
 }
 result += escapeHtmlText(text.slice(lastIdx));
 return result;
}

function escapeHtmlText(str) {
 return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Tự động lọc bỏ các từ cấm ra khỏi nội dung (ưu tiên từ dài trước để tránh làm gãy cụm từ)
 */
export function removeBannedWords(text) {
 if (!text) return text;
 let cleaned = text;
 
 const allWords = [];
 for (const cat of BANNED_CATEGORIES) {
  for (const word of cat.words) {
   const trimmed = word.trim();
   if (trimmed && !allWords.includes(trimmed)) allWords.push(trimmed);
  }
 }
 allWords.sort((a, b) => b.length - a.length);

 for (const word of allWords) {
  const escaped = escapeRegex(word);
  const pattern = new RegExp(`(?<=^|[^\\p{L}\\p{N}_])${escaped}(?=[^\\p{L}\\p{N}_]|$)`, 'giu');
  cleaned = cleaned.replace(pattern, '');
 }
 cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
 return cleaned;
}

/**
 * Kiểm tra token cookie `xs` có bị cắt ngắn (thiếu chữ ký bảo mật) hay không.
 */
export function isTruncatedXsToken(xsVal) {
  const s = String(xsVal || '').trim();
  if (!s) return true;
  return !s.includes('%3A%3A') && !s.includes('::') && (s.endsWith('-1') || s.split(/%3A|:/).length < 6);
}

/**
 * Kiểm tra chuỗi/object cookies Facebook có đủ bộ c_user, xs (nguyên vẹn), và sb hay không.
 */
export function hasCompleteFacebookCookies(cookieInput) {
  if (!cookieInput) return false;
  const obj = (typeof cookieInput === 'object' && !Array.isArray(cookieInput))
    ? cookieInput
    : parseUniversalCookies(cookieInput);
  if (!obj['c_user'] || !obj['xs'] || !obj['sb']) return false;
  return !isTruncatedXsToken(obj['xs']);
}

/**
 * Nạp cookies của tài khoản vào Facebook trên Chrome.
 */
export async function injectCookies(cookieInput) {
  if (typeof chrome === 'undefined' || !chrome.cookies) return [];
  if (!cookieInput) return [];
  const cookieObj = typeof cookieInput === 'object' && !Array.isArray(cookieInput)
    ? { ...cookieInput }
    : parseUniversalCookies(cookieInput);

  const keys = Object.keys(cookieObj);
  if (!keys.length) return [];

  // 1. Tự động chuẩn hóa xs (nếu chứa dấu : chưa mã hóa URL thành %3A)
  if (cookieObj['xs'] && typeof cookieObj['xs'] === 'string') {
    if (cookieObj['xs'].includes(':') && !cookieObj['xs'].includes('%3A')) {
      cookieObj['xs'] = cookieObj['xs'].replace(/:/g, '%3A');
    }
  }

  // 2. Đảm bảo có datr: nếu cookie nhập vào thiếu datr, lấy từ browser hoặc fetch một datr hợp lệ từ Facebook
  if (!cookieObj['datr']) {
    try {
      const fbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
      const existingDatr = fbCookies.find(c => c.name === 'datr')?.value;
      if (existingDatr) {
        cookieObj['datr'] = existingDatr;
      } else {
        await fetch('https://www.facebook.com/', { method: 'HEAD', mode: 'no-cors' }).catch(() => {});
        const newFbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
        const newDatr = newFbCookies.find(c => c.name === 'datr')?.value;
        if (newDatr) cookieObj['datr'] = newDatr;
      }
    } catch (_) {}
  }

  const injected = [];
  const httpOnlyCookies = new Set(['xs', 'fr', 'datr', 'sb']);
  const expDate = Math.floor(Date.now() / 1000) + (365 * 24 * 3600); // 1 năm

  for (const [name, rawValue] of Object.entries(cookieObj)) {
    if (!name || rawValue === undefined) continue;
    const value = String(rawValue).trim();
    if (!value) continue;

    const lowerName = name.toLowerCase();
    const isHttpOnly = httpOnlyCookies.has(lowerName);

    // datr và fr trên Facebook dùng no_restriction (SameSite=None), các cookie auth khác (c_user, xs, sb) dùng lax
    const isCrossSite = ['datr', 'fr'].includes(lowerName);
    const sameSiteVal = isCrossSite ? 'no_restriction' : 'lax';

    let success = false;

    // 1. Set domain cookie (.facebook.com) từ https://www.facebook.com/
    try {
      const res = await chrome.cookies.set({
        url: 'https://www.facebook.com/',
        domain: '.facebook.com',
        name,
        value,
        path: '/',
        secure: true,
        httpOnly: isHttpOnly,
        sameSite: sameSiteVal,
        expirationDate: expDate
      });
      if (res && res.name) success = true;
    } catch (_) {}

    // 2. Thử domain không dấu chấm (facebook.com)
    if (!success) {
      try {
        const res = await chrome.cookies.set({
          url: 'https://facebook.com/',
          domain: 'facebook.com',
          name,
          value,
          path: '/',
          secure: true,
          httpOnly: isHttpOnly,
          sameSite: sameSiteVal,
          expirationDate: expDate
        });
        if (res && res.name) success = true;
      } catch (_) {}
    }

    // 3. Fallback set host-only trên các subdomains
    const subUrls = [
      'https://www.facebook.com/',
      'https://m.facebook.com/',
      'https://web.facebook.com/',
      'https://upload.facebook.com/'
    ];
    for (const targetUrl of subUrls) {
      try {
        const resFallback = await chrome.cookies.set({
          url: targetUrl,
          name,
          value,
          path: '/',
          secure: true,
          httpOnly: isHttpOnly,
          sameSite: sameSiteVal,
          expirationDate: expDate
        });
        if (resFallback && resFallback.name) success = true;
      } catch (_) {}
    }

    if (success) {
      injected.push(name);
    }
  }

  return injected;
}

/**
 * Xóa sạch tất cả cookies Facebook trên mọi cookie stores mà không xóa cache/storage.
 * Có tùy chọn preserveDatr để giữ lại cookie thiết bị datr tránh Facebook nghi ngờ session mới.
 */
export async function clearFacebookCookiesOnly(preserveDatr = false) {
  if (typeof chrome === 'undefined' || !chrome.cookies) return;
  try {
    const storeIds = [];
    try {
      const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
      for (const s of stores) if (s?.id) storeIds.push(s.id);
    } catch (_) {}
    if (!storeIds.length) storeIds.push('0');

    for (const storeId of storeIds) {
      const allCookies = await chrome.cookies.getAll({ storeId }).catch(() => []);
      const fbCookies = allCookies.filter(c =>
        c.domain && (c.domain.includes('facebook.com') || c.domain.includes('fb.com'))
      );

      for (const ck of fbCookies) {
        if (preserveDatr && ck.name === 'datr') continue;
        const protocol = ck.secure ? 'https:' : 'http:';
        const cleanDomain = ck.domain.replace(/^\./, '');
        const targetUrls = [
          `${protocol}//${cleanDomain}${ck.path || '/'}`,
          `https://${cleanDomain}${ck.path || '/'}`,
          `https://www.facebook.com${ck.path || '/'}`,
          `https://facebook.com${ck.path || '/'}`
        ];

        for (const url of targetUrls) {
          const details = {
            url,
            name: ck.name,
            storeId
          };
          if (ck.partitionKey) details.partitionKey = ck.partitionKey;
          await chrome.cookies.remove(details).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

/**
 * Trực tiếp kích hoạt session của tài khoản bằng cookies, cập nhật cookies vào Chrome và mở Facebook
 * Nếu cookies hết hạn hoặc Facebook yêu cầu đăng nhập, tự động fallback sang đăng nhập bằng mật khẩu & 2FA
 */
export async function activateAccountSessionDirectly(accountId, openFacebookTab = true, isBackground = false) {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    throw new Error('Chrome extension API không khả dụng.');
  }
  const { accounts } = await chrome.storage.local.get('accounts');
  const acc = (accounts || []).find(a => a.id === accountId);
  if (!acc) throw new Error('Không tìm thấy tài khoản: ' + accountId);

  let parentAcc = null;
  if (acc.type === 'fanpage') {
    if (acc.parentAccountId) {
      parentAcc = (accounts || []).find(a => a.id === acc.parentAccountId);
    }
    if (!parentAcc) {
      parentAcc = (accounts || []).find(a => a.type !== 'fanpage' && a.cookies);
    }
  }

  const rawCookies = (acc.cookies && acc.cookies.trim()) ? acc.cookies : (parentAcc?.cookies || '');
  const cookieObj = parseUniversalCookies(rawCookies);
  const expectedCUser = acc.type === 'fanpage'
    ? (cookieObj['c_user'] || parentAcc?.fbId || '')
    : (acc.fbId || cookieObj['c_user'] || '');

  const fbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
  const activeCUser = fbCookies.find(c => c.name === 'c_user')?.value;
  const pageId = (acc.type === 'fanpage') ? String(acc.pageId || acc.fbId || '') : null;

  let injected = [];
  let mainTab = null;

  // Chỉ đổi session khi: Chưa có c_user hoặc c_user khác nick cá nhân cần dùng
  const needSwitchUser = !activeCUser || (expectedCUser && activeCUser !== expectedCUser);

  if (needSwitchUser) {
    // 1. Nếu có tab Facebook đang mở, tạm chuyển sang about:blank để ngắt các kết nối nền của phiên cũ gây logout tự động
    // Lưu ý: Bỏ qua tab đang quét nhóm (groupScanTabId) để cho phép chạy song song không bị ngắt quãng!
    const allTabs = (typeof chrome.tabs !== 'undefined' && chrome.tabs.query)
      ? await chrome.tabs.query({}).catch(() => [])
      : [];
    const { groupScanTabId } = (typeof chrome.storage !== 'undefined' && chrome.storage.local)
      ? await chrome.storage.local.get('groupScanTabId').catch(() => ({}))
      : {};
    const existingFbTabs = allTabs.filter(t => 
      t.url && (t.url.includes('facebook.com') || t.url.includes('fb.com')) &&
      (!groupScanTabId || t.id !== groupScanTabId)
    );
    for (const tab of existingFbTabs) {
      try { await chrome.tabs.update(tab.id, { url: 'about:blank' }); } catch (_) {}
    }
    if (existingFbTabs.length > 0) {
      await new Promise(r => setTimeout(r, 200));
    }

    // 2. Xóa sạch cookies Facebook cũ
    const hasDatrInAcc = Boolean(cookieObj['datr']);
    await clearFacebookCookiesOnly(!hasDatrInAcc);
    await new Promise(r => setTimeout(r, 200));

    // 3. Nạp cookies
    if (rawCookies && Object.keys(cookieObj).length > 0) {
      injected = await injectCookies(cookieObj);
      await new Promise(r => setTimeout(r, 350));
    }
  } else {
    // Đã đúng nick cá nhân, đảm bảo cookies c_user & xs vẫn hiện diện
    if (rawCookies && Object.keys(cookieObj).length > 0) {
      const hasCUser = fbCookies.some(c => c.name === 'c_user');
      if (!hasCUser) {
        injected = await injectCookies(cookieObj);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  // 3.1. Thiết lập hoặc xóa cookie i_user cho Fanpage
  if (acc.type === 'fanpage' && pageId) {
    const targetUrls = [
      'https://www.facebook.com/',
      'https://m.facebook.com/',
      'https://web.facebook.com/',
      'https://facebook.com/'
    ];
    for (const targetUrl of targetUrls) {
      await chrome.cookies.set({
        url: targetUrl,
        domain: 'facebook.com',
        name: 'i_user',
        value: pageId,
        path: '/',
        secure: true,
        sameSite: 'lax'
      }).catch(() => {});
    }
  } else {
    for (const targetUrl of ['https://www.facebook.com/', 'https://m.facebook.com/', 'https://facebook.com/']) {
      await chrome.cookies.remove({
        url: targetUrl,
        name: 'i_user'
      }).catch(() => {});
    }
  }

  // Lưu lại cookies vào tài khoản nếu trước đó Fanpage chưa lưu
  if (acc.type === 'fanpage' && !acc.cookies && rawCookies) {
    acc.cookies = rawCookies;
    acc.lastCookieSync = Date.now();
    await chrome.storage.local.set({ accounts });
  }

  // 4. Lấy c_user
  const verifyFbCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
  const cUser = verifyFbCookies.find(c => c.name === 'c_user')?.value || expectedCUser || 'N/A';

  // 5. Nếu có yêu cầu mở/làm mới tab Facebook
  if (openFacebookTab && typeof chrome.tabs !== 'undefined') {
    const hasCookies = Boolean(rawCookies && Object.keys(cookieObj).length > 0 && cookieObj['c_user']);
    const targetUrl = (acc.type === 'fanpage' && pageId)
      ? `https://www.facebook.com/${pageId}`
      : (hasCookies
          ? `https://www.facebook.com/?_r=${Date.now()}`
          : `https://www.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2F`);
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const { groupScanTabId } = (typeof chrome.storage !== 'undefined' && chrome.storage.local)
      ? await chrome.storage.local.get('groupScanTabId').catch(() => ({}))
      : {};
    const existingFbTabs = allTabs.filter(t => 
      t.url && (t.url.includes('facebook.com') || t.url.includes('fb.com')) &&
      (!groupScanTabId || t.id !== groupScanTabId)
    );

    if (existingFbTabs.length > 0) {
      mainTab = existingFbTabs[0];
      await chrome.tabs.update(mainTab.id, { url: targetUrl, active: !isBackground });
      if (!isBackground && mainTab.windowId && typeof chrome.windows !== 'undefined' && chrome.windows.update) {
        chrome.windows.update(mainTab.windowId, { focused: true }).catch(() => {});
      }
      if (mainTab?.id && typeof chrome.tabs !== 'undefined' && chrome.tabs.update) {
        chrome.tabs.update(mainTab.id, { autoDiscardable: false }).catch(() => {});
      }
      for (let i = 1; i < existingFbTabs.length; i++) {
        try { await chrome.tabs.remove(existingFbTabs[i].id); } catch (_) {}
      }
    } else {
      mainTab = await chrome.tabs.create({ url: targetUrl, active: !isBackground });
      if (mainTab?.id && typeof chrome.tabs !== 'undefined' && chrome.tabs.update) {
        chrome.tabs.update(mainTab.id, { autoDiscardable: false }).catch(() => {});
      }
    }

    // 6. Tự động kiểm tra: Nếu nick có Mật khẩu và tab Facebook hiển thị màn hình đăng nhập (do cookie hết hạn / thiếu sb / bị out)
    // -> Tự động đăng nhập lại bằng Mật khẩu + 2FA mà không để người dùng bơ vơ!
    if (acc.password && (acc.email || acc.fbId)) {
      setTimeout(async () => {
        try {
          const tab = await chrome.tabs.get(mainTab.id).catch(() => null);
          if (tab && tab.url && (tab.url.includes('/login') || tab.url.includes('facebook.com/?_r=') || tab.url.includes('facebook.com/') || tab.url.includes('home.php'))) {
            const currentCookies = await chrome.cookies.getAll({ domain: 'facebook.com' }).catch(() => []);
            const currentCookieObj = Object.fromEntries(currentCookies.map(c => [c.name, c.value]));
            const hasLiveCUser = Boolean(currentCookieObj['c_user']);
            let tabShowsLoginForm = false;
            if (typeof chrome.scripting?.executeScript === 'function') {
              tabShowsLoginForm = await chrome.scripting.executeScript({
                target: { tabId: mainTab.id },
                func: () => Boolean(document.querySelector('input[type="password"], #pass, input[name="pass"]'))
              }).then(r => Boolean(r?.[0]?.result)).catch(() => false);
            }
            if (!hasLiveCUser || !hasCompleteFacebookCookies(currentCookieObj) || tabShowsLoginForm) {
              console.log(`[AutoLogin] Cookies của "${acc.name}" đã hết hạn hoặc bị yêu cầu đăng nhập. Đang tự động đăng nhập lại bằng mật khẩu & 2FA...`);
              chrome.runtime.sendMessage({
                type: 'DO_LOGIN',
                email: acc.email || acc.fbId,
                password: acc.password,
                twoFactor: acc.twoFactor || null,
                existingAccountId: acc.id,
                targetTabId: mainTab.id,
                openFacebookTab: true,
                keepSession: true
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }, 2500);
    }
  }

  return {
    ok: true,
    accountId: acc.id,
    accountName: acc.name,
    cUser,
    tabId: mainTab?.id || null,
    injectedCount: injected.length
  };
}

/**
 * Lấy Token EAAG từ business.facebook.com/content_management
 * (Tích hợp từ tiện ích Get Token Cookie)
 */
export async function fetchTokenEAAG() {
  try {
    const res = await fetch('https://business.facebook.com/content_management', {
      method: 'GET',
      credentials: 'include'
    });
    const text = await res.text();
    const match = text.match(/EAAGNO[a-zA-Z0-9]+/);
    if (match && match[0]) return match[0];
    const matchGeneric = text.match(/EAAG[a-zA-Z0-9]+/);
    if (matchGeneric && matchGeneric[0]) return matchGeneric[0];
  } catch (err) {
    console.warn('[Token] Lỗi lấy token EAAG:', err);
  }
  return null;
}

/**
 * Lấy Token EAAB từ adsmanager.facebook.com/adsmanager/manage/campaigns
 * (Tích hợp từ tiện ích Get Token Cookie)
 */
export async function fetchTokenEAAB() {
  try {
    const res = await fetch('https://adsmanager.facebook.com/adsmanager/manage/campaigns', {
      method: 'GET',
      credentials: 'include'
    });
    const text = await res.text();
    if (text.includes('EAA')) {
      const match = text.match(/EAAB[a-zA-Z0-9]+/);
      if (match && match[0]) return match[0];
    }
    const redirectMatch = text.match(/window\.location\.replace\("([^"]+)"\)/);
    if (redirectMatch && redirectMatch[1]) {
      const redirectUrl = decodeURIComponent(redirectMatch[1]);
      const res2 = await fetch(redirectUrl, { method: 'GET', credentials: 'include' });
      const text2 = await res2.text();
      const match2 = text2.match(/EAAB[a-zA-Z0-9]+/);
      if (match2 && match2[0]) return match2[0];
    }
  } catch (err) {
    console.warn('[Token] Lỗi lấy token EAAB:', err);
  }
  return null;
}

/**
 * Giới hạn đăng bài mỗi ngày cho tài khoản:
 * - Fanpage: Cố định 5 bài/ngày (chống checkpoint Fanpage)
 * - Tài khoản cá nhân: Theo cài đặt (mặc định 20 bài/ngày)
 */
export function getAccountDailyLimit(acc, globalLimit = 20) {
  if (acc && acc.type === 'fanpage') {
    return 5;
  }
  return Math.max(1, Number(globalLimit || 20));
}

/**
 * Lấy danh sách Fanpage do tài khoản quản lý qua Facebook Graph API (/me/accounts)
 */
export async function fetchFanpagesByToken(token) {
  try {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return { ok: false, error: 'Token trống.' };
    const res = await fetch(`https://graph.facebook.com/me/accounts?access_token=${encodeURIComponent(cleanToken)}&fields=id,name,category,access_token,tasks&limit=100`);
    const data = await res.json();
    if (data && Array.isArray(data.data)) {
      return {
        ok: true,
        pages: data.data.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category || 'Fanpage',
          access_token: p.access_token || null,
          accessToken: p.access_token || null
        }))
      };
    }
    if (data && data.error) {
      return { ok: false, error: data.error.message || 'Lỗi lấy danh sách Fanpage từ Facebook.' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: 'Không thể lấy danh sách Fanpage từ Token.' };
}

/**
 * Xác thực token và lấy thông tin Profile (Tên, ID, Avatar) từ Facebook Graph API
 */
export async function fetchProfileByToken(token) {
  try {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return { ok: false, error: 'Token trống.' };
    const res = await fetch(`https://graph.facebook.com/me?access_token=${encodeURIComponent(cleanToken)}&fields=id,name,picture`);
    const data = await res.json();
    if (data && data.id && data.name) {
      return {
        ok: true,
        id: data.id,
        name: data.name,
        picture: data.picture?.data?.url || null
      };
    }
    if (data && data.error) {
      return { ok: false, error: data.error.message || 'Token không hợp lệ hoặc đã hết hạn.' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: 'Không thể xác thực Token Facebook.' };
}

/**
 * Đổi Token sang Cookies phiên đăng nhập (thông qua auth.getSessionforApp)
 */
export async function convertTokenToCookies(token) {
  try {
    const cleanToken = String(token || '').trim();
    let appId = '';
    try {
      const appRes = await fetch(`https://graph.facebook.com/app?access_token=${encodeURIComponent(cleanToken)}`);
      const appData = await appRes.json();
      if (appData && appData.id) appId = appData.id;
    } catch (_) {}

    const url = `https://api.facebook.com/method/auth.getSessionforApp?access_token=${encodeURIComponent(cleanToken)}&format=json${appId ? `&new_app_id=${appId}` : ''}&generate_session_cookies=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.session_cookies && Array.isArray(data.session_cookies) && data.session_cookies.length > 0) {
      const cookieObj = {};
      for (const item of data.session_cookies) {
        if (item.name && item.value) {
          cookieObj[item.name] = item.value;
        }
      }
      return {
        ok: true,
        cookieObj,
        cookieStr: cookiesObjToStr(cookieObj),
        uid: data.uid || cookieObj['c_user']
      };
    }
  } catch (err) {
    console.warn('[Token] convertTokenToCookies error:', err);
  }
  return { ok: false };
}

/**
 * Tự động tạo mã xác thực 2FA 6 số (RFC 6238 TOTP) từ mã 2FA Secret Key (chuẩn như 2fa.live)
 */
export async function generate2FACode(secret) {
  if (!secret) return null;
  const clean = String(secret).replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{6}$/.test(clean)) return clean;

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const byteLen = Math.floor(bits.length / 8);
  if (byteLen === 0) return null;

  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = parseInt(bits.substring(i * 8, (i + 1) * 8), 2);
  }

  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / 30);
  const timeBuffer = new ArrayBuffer(8);
  const view = new DataView(timeBuffer);
  view.setBigUint64(0, BigInt(time));

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      bytes,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, timeBuffer);
    const sigBytes = new Uint8Array(signature);
    const offset = sigBytes[sigBytes.length - 1] & 0x0f;
    const binary =
      ((sigBytes[offset] & 0x7f) << 24) |
      ((sigBytes[offset + 1] & 0xff) << 16) |
      ((sigBytes[offset + 2] & 0xff) << 8) |
      (sigBytes[offset + 3] & 0xff);
    return (binary % 1000000).toString().padStart(6, '0');
  } catch (err) {
    console.warn('[2FA] Lỗi tạo mã TOTP:', err);
    return null;
  }
}

/**
 * Phân tích thông minh chuỗi VIA Facebook Việt Nam
 * Hỗ trợ tất cả các định dạng VIA phổ biến:
 * - UID|PASS|2FA|COOKIE|TOKEN|MAIL|PASSMAIL
 * - UID|PASS|2FA|COOKIE|TOKEN
 * - UID|PASS|2FA|COOKIE
 * - UID|PASS|COOKIE
 * - UID|PASS|2FA
 * - UID|PASS
 * - c_user=...; xs=...; [EAA...]
 * - Mã Token thuần (EAAB..., EAAG...)
 * - Cookie JSON / Cookie String thuần
 */
export function parseViaString(rawInput) {
  if (!rawInput) return { type: 'empty' };
  let str = String(rawInput).trim();
  if (!str) return { type: 'empty' };

  // 1. Tách riêng token EAA nếu có dán kèm trong chuỗi
  let extractedToken = null;
  const tokenMatch = str.match(/\[?\b(EAA[a-zA-Z0-9]+)\b\]?/);
  if (tokenMatch) {
    extractedToken = tokenMatch[1];
  }

  // 2. Nếu là chuỗi JSON mảng cookie từ Cookie-Editor, J2Team
  if (str.startsWith('[') && str.endsWith(']') && (str.includes('"name"') || str.includes('"key"'))) {
    const cookieObj = parseUniversalCookies(str);
    return {
      type: 'cookie',
      uid: cookieObj['c_user'] || null,
      password: null,
      twoFactor: null,
      cookies: cookiesObjToStr(cookieObj),
      cookieObj,
      token: null,
      email: null,
      emailPassword: null
    };
  }

  // 3. Phân tách theo dấu pipe | nếu có
  if (str.includes('|')) {
    const parts = str.split('|').map(p => p.trim()).filter(Boolean);
    let uid = null;
    let password = null;
    let twoFactor = null;
    let cookieStr = null;
    let email = null;
    let emailPassword = null;
    let token = extractedToken;

    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];

      // A. Nếu phần này chứa cookie (c_user=, xs=, hoặc cặp cookie phụ kèm dấu ;)
      if (p.includes('c_user=') || p.includes('xs=') || (p.includes(';') && (p.includes('datr=') || p.includes('sb=') || p.includes('fr=')))) {
        // Loại bỏ token bị dính vào cookie nếu có (ví dụ: ; [EAAAU...)
        const cleaned = p.replace(/\[?EAA[a-zA-Z0-9]+\]?/g, '').trim().replace(/;\s*;+/g, ';').replace(/^[;\s]+|[;\s]+$/g, '');
        cookieStr = cleaned;
        continue;
      }

      // B. Nếu phần này là token độc lập
      if (/^EAA[a-zA-Z0-9]+$/.test(p)) {
        token = p;
        continue;
      }

      // C. Nếu phần này là email (chứa @ và .)
      if (p.includes('@') && p.includes('.') && !p.includes('=')) {
        email = p;
        if (i + 1 < parts.length && !parts[i + 1].includes(';') && !parts[i + 1].includes('=')) {
          emailPassword = parts[i + 1];
        }
        continue;
      }

      // D. Vị trí 0 thường là UID
      if (i === 0 && (/^\d{8,25}$/.test(p) || p.includes('@'))) {
        uid = p;
        continue;
      }

      // E. Vị trí 1 thường là Password
      if (i === 1 && !password && !p.includes('=')) {
        password = p;
        continue;
      }

      // F. Vị trí 2 thường là 2FA Secret Key (chuỗi Base32 hoặc mã 6 số)
      if (i === 2 && !twoFactor && (/^[A-Za-z0-9\s]{16,64}$/.test(p) || /^\d{6}$/.test(p)) && !p.includes('=')) {
        twoFactor = p.replace(/\s+/g, '');
        continue;
      }

      // G. Kiểm tra 2FA ở vị trí bất kỳ nếu chưa có
      if (!twoFactor && (/^[A-Z2-7]{16,32}$/i.test(p) || /^\d{6}$/.test(p)) && !p.includes('=')) {
        twoFactor = p.replace(/\s+/g, '');
        continue;
      }
    }

    const cookieObj = cookieStr ? parseUniversalCookies(cookieStr) : {};
    if (!uid && cookieObj['c_user']) uid = cookieObj['c_user'];

    return {
      type: 'via',
      uid,
      password,
      twoFactor,
      cookies: cookieStr,
      cookieObj,
      token,
      email,
      emailPassword
    };
  }

  // 4. Nếu là Token thuần
  if (/^EAA[a-zA-Z0-9]+$/.test(str) || (str.startsWith('EAA') && !str.includes(';') && !str.includes('='))) {
    return {
      type: 'token',
      uid: null,
      password: null,
      twoFactor: null,
      cookies: null,
      cookieObj: {},
      token: str,
      email: null,
      emailPassword: null
    };
  }

  // 5. Nếu là Cookies thuần
  if (str.includes('c_user=') || str.includes('xs=')) {
    const cleaned = str.replace(/\[?EAA[a-zA-Z0-9]+\]?/g, '').trim().replace(/^[;\s]+|[;\s]+$/g, '');
    const cookieObj = parseUniversalCookies(cleaned);
    return {
      type: extractedToken ? 'via' : 'cookie',
      uid: cookieObj['c_user'] || null,
      password: null,
      twoFactor: null,
      cookies: cleaned,
      cookieObj,
      token: extractedToken,
      email: null,
      emailPassword: null
    };
  }

  return {
    type: 'unknown',
    uid: null,
    password: null,
    twoFactor: null,
    cookies: null,
    cookieObj: {},
    token: extractedToken,
    email: null,
    emailPassword: null
  };
}

/**
 * Phân tích đầu vào: VIA, Token (EAAB, EAAG, EAAAA...), hoặc Cookies
 */
export function parseTokenOrCookieInput(rawInput) {
  const via = parseViaString(rawInput);
  return {
    type: via.type,
    token: via.token,
    cookieStr: via.cookies,
    cookieObj: via.cookieObj,
    uid: via.uid,
    password: via.password,
    twoFactor: via.twoFactor,
    email: via.email,
    emailPassword: via.emailPassword
  };
}



