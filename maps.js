/**
 * NTD Agency - Google Maps Scraper Controller (maps.js)
 * Điều khiển toàn bộ quy trình quét số, hiển thị tiến trình, quản lý dữ liệu và thông báo Zalo.
 */
import { enforceLicenseGate } from './license.js';
await enforceLicenseGate();

import { mapsExtract } from './maps_extract.js';
import { splitItems, buildQueries } from './maps_batch.js';
import { downloadXlsx } from './maps_export.js';
import {
  setMapsPower,
  sendMapsNotify
} from './maps_notify.js';
import { VIETNAM_UNITS } from './vietnam_units.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = {
  rows: [],
  job: null,
  tabId: null,
  settings: null
};

let running = false;
let stop = false;

// ── Chế độ hoạt động: 'maps' (Google Maps) hoặc 'group' (Quét số nhóm) ─────────
let activeMode = 'maps';

let groupState = {
  rows: [],
  job: null,
  tabId: null,
  settings: null,
  isScanning: false,
  seenKeys: {},
  postsCount: 0,
  commentsCount: 0
};

let groupRunning = false;
let groupStop = false;

// ── Chuẩn hóa và lọc số điện thoại (Đồng bộ tuyệt đối với Google Maps) ─────────
const CURRENT_PHONE_PREFIXES = [
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

const CARRIER_PREFIX_PRESETS = {
  all: '',
  viettel: '032, 033, 034, 035, 036, 037, 038, 039, 086, 096, 097, 098',
  vinaphone: '081, 082, 083, 084, 085, 088, 091, 094',
  mobifone: '070, 076, 077, 078, 079, 089, 090, 093',
  other: '052, 055, 056, 058, 059, 087, 092, 099',
  hotline: '1900, 1800, 024, 028, 0236, 0225, 0292, 0254, 0274, 0251'
};

function parsePrefixList(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(x => String(x || '').replace(/\D+/g, '')).filter(x => x.length >= 2 && x.length <= 6))];
  }
  return [...new Set(
    String(raw || '')
      .split(/[\s,;|/]+/)
      .map(token => {
        let d = token.replace(/\D+/g, '');
        if (d.startsWith('84') && d.length >= 3) d = '0' + d.slice(2);
        return d;
      })
      .filter(d => d.length >= 2 && d.length <= 6)
  )];
}

function normalizeUnicodeDigits(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xff10 && cp <= 0xff19) {
      out += String.fromCharCode(48 + (cp - 0xff10));
    } else if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
      out += String((cp - 0x1d7ce) % 10);
    } else {
      out += ch;
    }
  }
  return out;
}

function normPhone(p) {
  if (!p) return '';
  let s = normalizeUnicodeDigits(String(p)).replace(/\D+/g, '');
  if (s.startsWith('0084')) s = s.slice(4);
  else if (s.startsWith('84') && s.length >= 10) s = s.slice(2);
  if (/^(1800|1900|111|112|113|114|115|156|5656)/.test(s)) return s;
  if (!s.startsWith('0') && (s.length === 9 || s.length === 10)) s = '0' + s;
  return s;
}

/**
 * Phân loại số điện thoại theo 3 nhóm (đồng bộ với Google Maps & Background Worker):
 * - 'current': Số di động 10 số hiện hành (36 đầu số)
 * - 'hotline': Tổng đài 1800, 1900 & Cố định 63 tỉnh thành (024, 028, 02xx...)
 * - 'old': Số 11 số cũ (01xx...)
 */
function classifyPhone(rawPhone) {
  if (!rawPhone) return null;
  const p = normPhone(rawPhone);
  if (!p) return null;

  // 1. Kiểm tra 36 đầu số di động hiện hành (10 số)
  for (const pre of CURRENT_PHONE_PREFIXES) {
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

const PROVINCE_AREA_CODES = {
  'Hà Nội': '024', 'Hồ Chí Minh': '028', 'TP.HCM': '028', 'Sài Gòn': '028',
  'Hải Phòng': '0225', 'Đà Nẵng': '0236', 'Cần Thơ': '0292', 'An Giang': '0296',
  'Bà Rịa - Vũng Tàu': '0254', 'Vũng Tàu': '0254', 'Bạc Liêu': '0291', 'Bắc Giang': '0204',
  'Bắc Kạn': '0209', 'Bắc Ninh': '0222', 'Bến Tre': '0275', 'Bình Dương': '0274',
  'Bình Định': '0256', 'Bình Phước': '0271', 'Bình Thuận': '0252', 'Cà Mau': '0290',
  'Cao Bằng': '0206', 'Đắk Lắk': '0262', 'Đắk Nông': '0261', 'Điện Biên': '0215',
  'Đồng Nai': '0251', 'Đồng Tháp': '0277', 'Gia Lai': '0269', 'Hà Giang': '0219',
  'Hà Nam': '0226', 'Hà Tĩnh': '0239', 'Hải Dương': '0220', 'Hậu Giang': '0293',
  'Hòa Bình': '0218', 'Hưng Yên': '0221', 'Khánh Hòa': '0258', 'Nha Trang': '0258',
  'Kiên Giang': '0297', 'Kon Tum': '0260', 'Lai Châu': '0213', 'Lạng Sơn': '0205',
  'Lào Cai': '0214', 'Lâm Đồng': '0263', 'Đà Lạt': '0263', 'Long An': '0272',
  'Nam Định': '0228', 'Nghệ An': '0238', 'Vinh': '0238', 'Ninh Bình': '0229',
  'Ninh Thuận': '0259', 'Phú Thọ': '0210', 'Phú Yên': '0257', 'Quảng Bình': '0232',
  'Quảng Nam': '0235', 'Hội An': '0235', 'Quảng Ngãi': '0255', 'Quảng Ninh': '0203',
  'Hạ Long': '0203', 'Quảng Trị': '0233', 'Sóc Trăng': '0299', 'Sơn La': '0212',
  'Tây Ninh': '0276', 'Thái Bình': '0227', 'Thái Nguyên': '0208', 'Thanh Hóa': '0237',
  'Thừa Thiên Huế': '0234', 'Huế': '0234', 'Tiền Giang': '0273', 'Mỹ Tho': '0273',
  'Trà Vinh': '0294', 'Tuyên Quang': '0207', 'Vĩnh Long': '0270', 'Vĩnh Phúc': '0211',
  'Yên Bái': '0216'
};

/**
 * Trích xuất & chuẩn hóa số điện thoại THẬT từ dữ liệu cơ sở (tuyệt đối không tự tạo số giả).
 */
function resolveBusinessPhone(name = '', address = '', query = '', allowedTypes = null, rawPhone = '') {
  const activeTypes = allowedTypes || (activeMode === 'maps' ? getActivePhoneTypes() : getActiveGroupPhoneTypes());

  // 1. Kiểm tra SĐT thật từ thuộc tính cào được
  if (rawPhone) {
    const clean = normPhone(rawPhone);
    if (clean && isPhoneAllowed(clean, activeTypes)) return clean;
  }

  // 2. Quét SĐT thật nằm trong tên/địa chỉ/văn bản nếu có
  const textToScan = `${name} ${address} ${query}`;
  const phoneMatches = textToScan.match(/(?:\+?84|0)[1-9](?:[\s.\-()]?\d){8,9}\b|\b(?:1800|1900)(?:[\s.\-]?\d){4,6}\b|\(\s*0\d{1,3}\s*\)[\s.\-]?(?:\d[\s.\-]?){6,8}\d\b/g);
  if (phoneMatches) {
    for (const m of phoneMatches) {
      const clean = normPhone(m);
      if (clean && isPhoneAllowed(clean, activeTypes)) return clean;
    }
  }

  return '';
}

function getActivePhoneTypes() {
  return {
    current: $('phoneTypeCurrent') ? $('phoneTypeCurrent').checked : (state.settings?.phoneTypes?.current ?? true),
    hotline: $('phoneTypeHotline') ? $('phoneTypeHotline').checked : (state.settings?.phoneTypes?.hotline ?? false),
    old: $('phoneTypeOld') ? $('phoneTypeOld').checked : (state.settings?.phoneTypes?.old ?? false),
    customPrefixes: $('customPhonePrefixes')
      ? parsePrefixList($('customPhonePrefixes').value)
      : parsePrefixList(state.settings?.phoneTypes?.customPrefixes || state.settings?.customPrefixes || [])
  };
}

function getActiveGroupPhoneTypes() {
  return {
    current: $('groupPhoneTypeCurrent') ? $('groupPhoneTypeCurrent').checked : (groupState.settings?.phoneTypes?.current ?? true),
    hotline: $('groupPhoneTypeHotline') ? $('groupPhoneTypeHotline').checked : (groupState.settings?.phoneTypes?.hotline ?? false),
    old: $('groupPhoneTypeOld') ? $('groupPhoneTypeOld').checked : (groupState.settings?.phoneTypes?.old ?? false),
    customPrefixes: $('groupCustomPhonePrefixes')
      ? parsePrefixList($('groupCustomPhonePrefixes').value)
      : parsePrefixList(groupState.settings?.phoneTypes?.customPrefixes || groupState.settings?.customPrefixes || [])
  };
}

function isPhoneAllowed(phone, allowedTypes = null) {
  const clean = normPhone(phone);
  if (!clean) return false;
  const types = allowedTypes || (activeMode === 'maps' ? getActivePhoneTypes() : getActiveGroupPhoneTypes());
  const category = classifyPhone(clean);
  if (!category || !types[category]) return false;
  const customPrefixes = parsePrefixList(types.customPrefixes);
  if (customPrefixes.length > 0) {
    return customPrefixes.some(pre => clean.startsWith(pre));
  }
  return true;
}

function syncPhoneTypeUI() {
  const types = ['Current', 'Hotline', 'Old'];
  types.forEach(t => {
    const input = $('phoneType' + t);
    const label = $('labelPhone' + t);
    if (input && label) {
      label.classList.toggle('checked', input.checked);
    }
  });
}

function syncGroupPhoneTypeUI() {
  const types = ['Current', 'Hotline', 'Old'];
  types.forEach(t => {
    const input = $('groupPhoneType' + t);
    const label = $('labelGroupPhone' + t);
    if (input && label) {
      label.classList.toggle('checked', input.checked);
    }
  });

  const scopeTypes = ['Posts', 'Images', 'Comments'];
  scopeTypes.forEach(s => {
    const input = $('groupScan' + s);
    const label = $('labelGroupScan' + s);
    if (input && label) {
      label.classList.toggle('checked', input.checked);
    }
  });
}

function filterMapsExportableRows() {
  const allowed = getActivePhoneTypes();
  return state.rows
    .map(r => ({ ...r, phone: normPhone(r.phone) }))
    .filter(r => r.phone && isPhoneAllowed(r.phone, allowed));
}

function filterGroupExportableRows() {
  const allowed = getActiveGroupPhoneTypes();
  return (groupState.rows || [])
    .map(r => ({ ...r, phone: normPhone(r.phone) }))
    .filter(r => r.phone && isPhoneAllowed(r.phone, allowed));
}

function filterExportableRows() {
  return activeMode === 'maps' ? filterMapsExportableRows() : filterGroupExportableRows();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueKey(r) {
  const p = normPhone(r.phone);
  if (p) return p;
  const u = String(r.url || '');
  if (u && !u.includes('/maps/search/?')) {
    return u.split('?')[0];
  }
  return `${u}|${r.name || ''}|${r.address || ''}`.trim();
}

function addRow(row, options = {}) {
  const key = uniqueKey(row);
  if (!key) return false;
  // Kiểm tra trong dữ liệu hiện tại
  const existing = state.rows.find(r => uniqueKey(r) === key);
  if (existing) {
    if (row.query && existing.query && !existing.query.includes(row.query)) {
      existing.query += ' | ' + row.query;
    } else if (row.query && !existing.query) {
      existing.query = row.query;
    }
    return false;
  }
  // Kiểm tra trong danh sách đã quét lịch sử (trừ trường hợp đồng bộ trực tiếp row thật từ Extension)
  if (!state.seenKeys) state.seenKeys = {};
  if (!options?.forceIfNotInRows && state.seenKeys[key]) return false;
  state.seenKeys[key] = true;
  state.rows.push(row);
  return true;
}

function safeLink(url) {
  try {
    const u = new URL(url);
    return ['https:', 'http:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// ── Lưu trữ State ─────────────────────────────────────────────────────────────
async function saveState() {
  await chrome.storage.local.set({ rinMaps: state });
}

// ── Nhật ký hoạt động ────────────────────────────────────────────────────────
function log(msg) {
  const time = new Date().toLocaleTimeString('vi-VN');
  const banner = $('status');
  if (banner) banner.textContent = msg;

  const logEl = $('log');
  if (logEl) {
    logEl.textContent = `[${time}] ${msg}\n${logEl.textContent}`.slice(0, 15000);
  }
}

// ── Chuyển đổi chế độ (Google Maps vs Quét số nhóm) ─────────────────────────
function setMode(mode) {
  activeMode = mode;
  chrome.storage.local.set({ mapsActiveMode: mode }).catch(() => {});

  // Cập nhật trạng thái nút chọn chế độ
  $('modeBtnMaps')?.classList.toggle('active', mode === 'maps');
  $('modeBtnGroup')?.classList.toggle('active', mode === 'group');

  // Đổi các khối chỉ số và cấu hình
  if ($('metricsGridMaps')) $('metricsGridMaps').hidden = (mode !== 'maps');
  if ($('metricsGridGroup')) $('metricsGridGroup').hidden = (mode !== 'group');
  if ($('configViewMaps')) $('configViewMaps').hidden = (mode !== 'maps');
  if ($('configViewGroup')) $('configViewGroup').hidden = (mode !== 'group');

  // Đổi tiêu đề cột bảng dữ liệu
  if ($('theadMaps')) $('theadMaps').hidden = (mode !== 'maps');
  if ($('theadGroup')) $('theadGroup').hidden = (mode !== 'group');

  // Đổi tiêu đề và icon Header
  const iconWrap = $('headerIconWrap');
  const titleEl = $('headerTitle');
  if (mode === 'maps') {
    if (titleEl) titleEl.textContent = 'Quét số Google Maps';
    if (iconWrap) {
      iconWrap.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>
      `;
    }
  } else {
    if (titleEl) titleEl.textContent = 'Quét số nhóm Facebook';
    if (iconWrap) {
      iconWrap.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      `;
    }
  }

  // Đổi tùy chọn trong bộ lọc select
  const filterSelect = $('tableFilter');
  if (filterSelect) {
    if (mode === 'maps') {
      filterSelect.innerHTML = `
        <option value="all">Tất cả cơ sở</option>
        <option value="with_phone">Chỉ cơ sở có SĐT</option>
        <option value="without_phone">Cơ sở chưa có SĐT</option>
      `;
    } else {
      filterSelect.innerHTML = `
        <option value="all">Tất cả nguồn</option>
        <option value="post">Chỉ từ Bài viết</option>
        <option value="image">Chỉ từ Hình ảnh (OCR)</option>
        <option value="comment">Chỉ từ Bình luận</option>
      `;
    }
  }

  // Đổi gợi ý tìm kiếm
  const searchInput = $('tableSearch');
  if (searchInput) {
    searchInput.placeholder = mode === 'maps'
      ? 'Tìm nhanh cơ sở, SĐT, địa chỉ, từ khóa...'
      : 'Tìm nhanh SĐT, người đăng, nhóm, nội dung...';
  }

  renderUI();
}

// ── Cập nhật Giao diện (Render) ──────────────────────────────────────────────
function renderUI() {
  if (activeMode === 'maps') {
    renderMapsUI();
  } else {
    renderGroupUI();
  }
}

function renderMapsUI() {
  const allowedTypes = getActivePhoneTypes();
  const totalPlaces = state.rows.length;
  const withPhones = state.rows.filter(r => r.phone && r.phone.trim() && isPhoneAllowed(r.phone, allowedTypes)).length;
  const rate = totalPlaces > 0 ? Math.round((withPhones / totalPlaces) * 100) : 0;

  // Cập nhật thẻ chỉ số Maps
  if ($('metricTotalPlaces')) $('metricTotalPlaces').textContent = totalPlaces.toLocaleString('vi-VN');
  if ($('metricTotalPhones')) $('metricTotalPhones').textContent = withPhones.toLocaleString('vi-VN');
  if ($('metricPhoneRate')) $('metricPhoneRate').textContent = `${rate}%`;

  const statusText = running
    ? 'Đang quét...'
    : state.job
    ? 'Tạm dừng'
    : 'Sẵn sàng';
  if ($('metricStatus')) $('metricStatus').textContent = statusText;

  // Banner status Maps
  const banner = $('statusBanner');
  const pulse = $('statusPulse');
  const statusEl = $('status');
  if (banner && pulse) {
    if (running) {
      banner.style.display = 'flex';
      banner.className = 'status-banner running';
      pulse.style.display = 'inline-block';
      if (statusEl) {
        statusEl.textContent = (isDirectScrapingRunning && !mapsExtSupportsSyncV2)
          ? '⚠️ Thiếu Extension trên profile Chrome này — đang dùng OpenStreetMap (ít SĐT); bật Extension NTD Agency hoặc copy tab Google Maps rồi bấm 📋 Dán'
          : 'Đang quét dữ liệu Google Maps...';
      }
    } else if (state.job) {
      banner.style.display = 'flex';
      banner.className = 'status-banner error';
      pulse.style.display = 'none';
      if (statusEl) statusEl.textContent = 'Tiến trình quét đang tạm dừng.';
    } else {
      banner.style.display = 'none';
      pulse.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
    }
  }

  // Cập nhật trạng thái nút Maps
  if ($('start')) $('start').disabled = running;
  if ($('resume')) $('resume').disabled = running || !state.job;
  if ($('stop')) $('stop').disabled = !running;
  if ($('clear')) $('clear').disabled = running || groupRunning;

  renderMapsTable();
}

function renderGroupUI() {
  const allowedTypes = getActiveGroupPhoneTypes();
  const totalItems = (groupState.postsCount || 0) + (groupState.commentsCount || 0);
  const totalPhones = (groupState.rows || []).filter(r => r.phone && isPhoneAllowed(r.phone, allowedTypes)).length;
  const rate = totalItems > 0 ? Math.round((totalPhones / totalItems) * 100) : (totalPhones > 0 ? 100 : 0);

  // Cập nhật thẻ chỉ số Nhóm Facebook
  if ($('metricGroupTotalItems')) $('metricGroupTotalItems').textContent = totalItems.toLocaleString('vi-VN');
  if ($('metricGroupTotalPhones')) $('metricGroupTotalPhones').textContent = totalPhones.toLocaleString('vi-VN');
  if ($('metricGroupPhoneRate')) $('metricGroupPhoneRate').textContent = `${rate}%`;

  const statusText = groupRunning
    ? 'Đang quét...'
    : groupState.job
    ? 'Tạm dừng'
    : 'Sẵn sàng';
  if ($('metricGroupStatus')) $('metricGroupStatus').textContent = statusText;

  // Banner status Nhóm
  const banner = $('groupStatusBanner');
  const pulse = $('groupStatusPulse');
  const statusEl = $('groupStatus');
  if (banner && pulse) {
    if (groupRunning) {
      banner.style.display = 'flex';
      banner.className = 'status-banner running';
      pulse.style.display = 'inline-block';
      if (statusEl) statusEl.textContent = 'Đang lướt và quét số điện thoại trong nhóm Facebook...';
    } else if (groupState.job) {
      banner.style.display = 'flex';
      banner.className = 'status-banner error';
      pulse.style.display = 'none';
      if (statusEl) statusEl.textContent = 'Tiến trình quét nhóm đang tạm dừng.';
    } else {
      banner.style.display = 'none';
      pulse.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
    }
  }

  // Cập nhật trạng thái nút Nhóm
  if ($('startGroup')) $('startGroup').disabled = groupRunning;
  if ($('resumeGroup')) $('resumeGroup').disabled = groupRunning || !groupState.job;
  if ($('stopGroup')) $('stopGroup').disabled = !groupRunning;
  if ($('clear')) $('clear').disabled = groupRunning || running;

  renderGroupTable();
}

function renderTable() {
  if (activeMode === 'maps') {
    renderMapsTable();
  } else {
    renderGroupTable();
  }
}

function renderMapsTable() {
  const tbody = $('rows');
  if (!tbody) return;

  const searchTerm = ($('tableSearch')?.value || '').trim().toLowerCase();
  const filterVal = $('tableFilter')?.value || 'all';
  const allowedTypes = getActivePhoneTypes();

  let filtered = state.rows;

  // Lọc theo các loại SĐT được tích chọn: nếu cơ sở có SĐT thì SĐT phải thuộc loại được chọn
  filtered = filtered.filter(r => {
    if (!r.phone || !r.phone.trim()) return true;
    return isPhoneAllowed(r.phone, allowedTypes);
  });

  if (filterVal === 'with_phone') {
    filtered = filtered.filter(r => r.phone && r.phone.trim());
  } else if (filterVal === 'without_phone') {
    filtered = filtered.filter(r => !r.phone || !r.phone.trim());
  }

  if (searchTerm) {
    filtered = filtered.filter(r =>
      (r.name || '').toLowerCase().includes(searchTerm) ||
      (r.phone || '').includes(searchTerm) ||
      (r.address || '').toLowerCase().includes(searchTerm) ||
      (r.query || '').toLowerCase().includes(searchTerm)
    );
  }

  const countDisplay = $('displayCount');
  if (countDisplay) {
    countDisplay.textContent = `Hiển thị ${filtered.length}/${state.rows.length} cơ sở`;
  }

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:36px 16px;color:#94a3b8">
          ${state.rows.length === 0 ? 'Chưa có cơ sở nào được quét. Vui lòng bắt đầu lượt mới.' : 'Không tìm thấy cơ sở nào phù hợp với bộ lọc.'}
        </td>
      </tr>
    `;
    return;
  }

  const frag = document.createDocumentFragment();
  const displayRows = filtered.slice(-500).reverse();

  displayRows.forEach((r, idx) => {
    const tr = document.createElement('tr');

    // Index
    const tdIdx = document.createElement('td');
    tdIdx.style.textAlign = 'center';
    tdIdx.style.color = '#94a3b8';
    tdIdx.textContent = String(idx + 1);
    tr.appendChild(tdIdx);

    // Tên cơ sở
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '700';
    tdName.textContent = r.name || '—';
    tr.appendChild(tdName);

    // Số điện thoại
    const tdPhone = document.createElement('td');
    if (r.phone && r.phone.trim()) {
      const cleanP = normPhone(r.phone);
      tdPhone.innerHTML = `
        <span class="phone-cell">
          <span>${cleanP}</span>
          <button type="button" class="phone-copy-btn" title="Sao chép SĐT" data-phone="${cleanP}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </span>
      `;
    } else {
      tdPhone.innerHTML = '<span style="color:#94a3b8">—</span>';
    }
    tr.appendChild(tdPhone);

    // Địa chỉ
    const tdAddress = document.createElement('td');
    tdAddress.textContent = r.address || '—';
    tr.appendChild(tdAddress);

    // Website
    const tdWeb = document.createElement('td');
    const validWeb = safeLink(r.website);
    if (validWeb) {
      tdWeb.innerHTML = `<a href="${validWeb}" target="_blank" rel="noopener noreferrer" class="link-action">${truncateUrl(validWeb)}</a>`;
    } else {
      tdWeb.innerHTML = '<span style="color:#94a3b8">—</span>';
    }
    tr.appendChild(tdWeb);

    // Từ khóa
    const tdQuery = document.createElement('td');
    tdQuery.innerHTML = `<span class="tag-query" title="${r.query || ''}">${r.query || '—'}</span>`;
    tr.appendChild(tdQuery);

    // Maps link
    const tdMaps = document.createElement('td');
    tdMaps.style.textAlign = 'center';
    const validMap = safeLink(r.url);
    if (validMap) {
      tdMaps.innerHTML = `
        <a href="${validMap}" target="_blank" rel="noopener noreferrer" class="link-action" title="Xem trên Google Maps">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          Maps
        </a>
      `;
    } else {
      tdMaps.innerHTML = '<span style="color:#94a3b8">—</span>';
    }
    tr.appendChild(tdMaps);

    frag.appendChild(tr);
  });

  tbody.replaceChildren(frag);

  // Gán sự kiện click nút Copy số điện thoại
  tbody.querySelectorAll('.phone-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const phone = btn.getAttribute('data-phone');
      if (phone) {
        navigator.clipboard.writeText(phone);
        btn.innerHTML = '✓';
        setTimeout(() => {
          btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
        }, 1200);
      }
    });
  });
}

function renderGroupTable() {
  const tbody = $('rows');
  if (!tbody) return;

  const searchTerm = ($('tableSearch')?.value || '').trim().toLowerCase();
  const filterVal = $('tableFilter')?.value || 'all';
  const allowedTypes = getActiveGroupPhoneTypes();

  let filtered = groupState.rows || [];

  // 1. Lọc theo các loại SĐT được tích chọn
  filtered = filtered.filter(r => {
    if (!r.phone || !r.phone.trim()) return true;
    return isPhoneAllowed(r.phone, allowedTypes);
  });

  // 2. Lọc theo Nguồn (Bài viết, Hình ảnh, Bình luận)
  if (filterVal === 'post') {
    filtered = filtered.filter(r => (r.source || '').toLowerCase().includes('bài viết') && !(r.source || '').toLowerCase().includes('hình ảnh'));
  } else if (filterVal === 'image') {
    filtered = filtered.filter(r => (r.source || '').toLowerCase().includes('hình ảnh'));
  } else if (filterVal === 'comment') {
    filtered = filtered.filter(r => (r.source || '').toLowerCase().includes('bình luận') && !(r.source || '').toLowerCase().includes('hình ảnh'));
  }

  // 3. Tìm kiếm theo từ khóa
  if (searchTerm) {
    filtered = filtered.filter(r =>
      (r.name || '').toLowerCase().includes(searchTerm) ||
      (r.phone || '').includes(searchTerm) ||
      (r.context || '').toLowerCase().includes(searchTerm) ||
      (r.groupName || '').toLowerCase().includes(searchTerm) ||
      (r.source || '').toLowerCase().includes(searchTerm)
    );
  }

  const countDisplay = $('displayCount');
  if (countDisplay) {
    countDisplay.textContent = `Hiển thị ${filtered.length}/${(groupState.rows || []).length} số điện thoại`;
  }

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:36px 16px;color:#94a3b8">
          ${(groupState.rows || []).length === 0 ? 'Chưa có số điện thoại nào được quét từ nhóm. Vui lòng nhập link nhóm và bấm "Bắt đầu quét số nhóm".' : 'Không tìm thấy số điện thoại nào phù hợp với bộ lọc.'}
        </td>
      </tr>
    `;
    return;
  }

  const frag = document.createDocumentFragment();
  const displayRows = filtered.slice(-500).reverse();

  displayRows.forEach((r, idx) => {
    const tr = document.createElement('tr');

    // Index
    const tdIdx = document.createElement('td');
    tdIdx.style.textAlign = 'center';
    tdIdx.style.color = '#94a3b8';
    tdIdx.textContent = String(idx + 1);
    tr.appendChild(tdIdx);

    // Người đăng / Tác giả
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '700';
    tdName.textContent = r.name || 'Thành viên nhóm';
    tr.appendChild(tdName);

    // Số điện thoại
    const tdPhone = document.createElement('td');
    const cleanP = normPhone(r.phone);
    tdPhone.innerHTML = `
      <span class="phone-cell">
        <span style="font-weight:700;color:var(--accent)">${cleanP}</span>
        <button type="button" class="phone-copy-btn" title="Sao chép SĐT" data-phone="${cleanP}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </span>
    `;
    tr.appendChild(tdPhone);

    // Nguồn tìm thấy
    const tdSource = document.createElement('td');
    let sourceCls = 'post';
    let sourceIcon = '📝';
    if ((r.source || '').toLowerCase().includes('hình ảnh')) {
      sourceCls = 'image';
      sourceIcon = '🖼️';
    } else if ((r.source || '').toLowerCase().includes('bình luận')) {
      sourceCls = 'comment';
      sourceIcon = '💬';
    }
    tdSource.innerHTML = `
      <span class="source-badge ${sourceCls}" title="${escapeHtml(r.source || '')}">
        <span>${sourceIcon}</span>
        <span>${escapeHtml(r.source || 'Bài viết')}</span>
      </span>
    `;
    tr.appendChild(tdSource);

    // Trích đoạn nội dung
    const tdContext = document.createElement('td');
    let contextHtml = escapeHtml(r.context || '—');
    if (cleanP) {
      const reg = new RegExp('(' + cleanP + '|' + escapeRegex(r.rawPhone || '') + ')', 'gi');
      contextHtml = contextHtml.replace(reg, '<mark>$1</mark>');
    }
    tdContext.innerHTML = `<div class="context-snippet" title="${escapeHtml(r.context || '')}">${contextHtml}</div>`;
    tr.appendChild(tdContext);

    // Tên nhóm
    const tdGroup = document.createElement('td');
    tdGroup.innerHTML = `
      <span class="tag-query" title="${escapeHtml(r.groupName || '')}" style="max-width:160px">
        ${escapeHtml(r.groupName || 'Nhóm Facebook')}
      </span>
    `;
    tr.appendChild(tdGroup);

    // Link bài viết Facebook
    const tdLink = document.createElement('td');
    tdLink.style.textAlign = 'center';
    const validUrl = safeLink(r.postUrl || r.groupUrl);
    if (validUrl) {
      tdLink.innerHTML = `
        <a href="${validUrl}" target="_blank" rel="noopener noreferrer" class="link-action" title="Xem trên Facebook">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          Mở FB
        </a>
      `;
    } else {
      tdLink.innerHTML = '<span style="color:#94a3b8">—</span>';
    }
    tr.appendChild(tdLink);

    frag.appendChild(tr);
  });

  tbody.replaceChildren(frag);

  // Gán sự kiện click nút Copy số điện thoại
  tbody.querySelectorAll('.phone-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const phone = btn.getAttribute('data-phone');
      if (phone) {
        navigator.clipboard.writeText(phone);
        btn.innerHTML = '✓';
        setTimeout(() => {
          btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
        }, 1200);
      }
    });
  });
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'Web';
  }
}

let mapsStop = false;
let mapsTabId = null;

// ── Tiến trình quét số Google Maps chạy trực tiếp (Fallback khi Worker chưa nạp hoặc chạy trên Web) ──
async function waitForMapsTab(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mapsStop) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab Google Maps đã bị đóng.');

    if (tab.status === 'complete' && !tab.pendingUrl) {
      return true;
    }
    await sleep(500);
  }
  return true;
}

let mapsExtSupportsSyncV2 = false;
let mapsLastExtOutdated = false;

function showMapsWebNotice(outdatedExt = false) {
  const box = $('mapsWebNoticeBox');
  const txt = $('mapsWebNoticeText');
  if (!box || !txt) return;
  mapsLastExtOutdated = outdatedExt;
  box.hidden = false;
  if (outdatedExt) {
    txt.innerHTML = '<strong>⚠️ Extension NTD Agency trên profile Chrome này cần Tải lại (↻) 1 lần:</strong> Phiên bản Extension đang chạy chưa có trình đồng bộ Google Maps mới (<code>MAPS_SYNC_V2</code>). Hãy mở <code>chrome://extensions</code> trên <strong>chính cửa sổ Chrome này</strong> → bấm nút <strong>↻ Reload</strong> trên <strong>NTD Agency</strong> (đảm bảo trỏ đúng thư mục Extension mới), rồi quay lại bấm <strong>🔄 Kiểm tra lại</strong>. Hoặc sang tab Google Maps vừa mở → <code>Ctrl+A → Ctrl+C</code> rồi bấm nút <strong>📋 Dán &amp; trích SĐT</strong> bên dưới.';
  } else {
    txt.innerHTML = '<strong>⚠️ Profile Chrome này chưa kết nối Extension NTD Agency mới:</strong> Trình duyệt Web bị chặn Cross-Origin nên không tự đọc được SĐT bên trong tab Google Maps, hiện đang tạm tra cứu nguồn dự phòng OpenStreetMap (hầu hết chưa có SĐT tại VN). Hãy mở <code>chrome://extensions</code> trên <strong>chính cửa sổ Chrome này</strong> → nạp/bật <strong>NTD Agency</strong> bản mới (hoặc mở đúng profile Chrome đã cài Extension), rồi <code>Ctrl+F5</code> lại trang để tự cào 100% SĐT; hoặc sang tab Google Maps vừa mở → <code>Ctrl+A → Ctrl+C</code> rồi bấm <strong>📋 Dán &amp; trích SĐT</strong> bên dưới.';
  }
}

function hideMapsWebNotice() {
  const box = $('mapsWebNoticeBox');
  if (box) box.hidden = true;
}

async function importMapsPhonesFromClipboardText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    log('⚠️ Clipboard trống. Hãy mở tab Google Maps, bấm Ctrl+A rồi Ctrl+C trước.');
    return 0;
  }

  const allowedTypes = getActivePhoneTypes();
  const activeQuery = state.job?.queries?.[state.job?.index || 0]
    || String($('queries')?.value || '').split(/[\r\n]+/)[0]?.trim()
    || 'Google Maps';

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const phoneRegex = /(?:\+?84|0)[1-9](?:[\s.\-()]?\d){8,9}\b|\b(?:1800|1900)(?:[\s.\-]?\d){4,6}\b|\(\s*0\d{1,3}\s*\)[\s.\-]?(?:\d[\s.\-]?){6,8}\d\b/g;
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(phoneRegex)];
    if (!matches.length) continue;

    for (const m of matches) {
      const cleanP = normPhone(m[0]);
      if (!cleanP) continue;
      if (!isPhoneAllowed(cleanP, allowedTypes)) {
        skipped++;
        continue;
      }

      // Tìm tên cơ sở & địa chỉ ở các dòng ngay phía trên dòng chứa SĐT
      let name = '';
      let address = '';
      let website = '';
      for (let back = i - 1; back >= Math.max(0, i - 6); back--) {
        const prev = lines[back];
        if (!prev) continue;
        if (/^https?:\/\//i.test(prev) && !website) {
          website = prev;
          continue;
        }
        if (/^(Chia sẻ|Chỉ đường|Lưu|Gần đây|Trang web|Mở cửa|Đang mở|Đã đóng|Điện thoại|Phone|Website)/i.test(prev)) continue;
        if (/^\d([.,]\d)?\s*\(\d/.test(prev)) continue; // Dòng rating "4,9 (491)"
        if (!address && /(Phường|Xã|Quận|Huyện|TP|Thành phố|Đường|Nguyễn|Lê|Trần|Võ|Hoàng|Phạm|\d+\s+[\p{L}])/iu.test(prev) && prev.length > 8) {
          address = prev;
          continue;
        }
        if (!name && prev.length >= 3 && prev.length <= 120 && !phoneRegex.test(prev)) {
          name = prev;
          break;
        }
      }
      if (!name) name = `Cơ sở (${cleanP})`;

      const beforeCount = state.rows.length;
      addRow({
        name,
        phone: cleanP,
        address,
        website,
        url: `https://www.google.com/maps/search/${encodeURIComponent(name + ' ' + (address || activeQuery))}?hl=vi`,
        query: activeQuery
      });
      if (state.rows.length > beforeCount) {
        added++;
        log(`✅ [Clipboard] ${name} - SĐT: ${cleanP}`);
      }
    }
  }

  await saveState();
  renderUI();
  if (added > 0) {
    log(`🎉 Đã trích & lọc được ${added} SĐT mới hợp lệ từ nội dung Google Maps (bỏ qua ${skipped} số ngoài đầu số lọc).`);
  } else {
    log(`ℹ️ Đã kiểm tra nội dung dán nhưng không thêm được SĐT mới nào khớp bộ lọc đầu số hiện tại (bỏ qua ${skipped} số).`);
  }
  return added;
}

// Tìm kiếm danh sách địa điểm doanh nghiệp thật trên Web (chỉ giữ SĐT thật từ OSM/Google Maps)
async function fetchWebPlacesForQuery(query, limit = 50, allowedTypes = null) {
  try {
    const results = [];
    const activeTypes = allowedTypes || getActivePhoneTypes();

    // 1. Lấy địa điểm thực qua Photon OpenStreetMap
    try {
      const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(query) + '&limit=' + Math.min(limit, 40);
      const resp = await fetch(url, { method: 'GET' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.features)) {
          for (const feat of data.features) {
            const p = feat.properties || {};
            const coords = feat.geometry?.coordinates;
            const name = p.name || '';
            if (!name) continue;

            const addrParts = [
              p.housenumber,
              p.street,
              p.locality,
              p.district,
              p.city || p.state
            ].filter(Boolean);
            const address = addrParts.join(', ');

            const coordsStr = coords && coords.length >= 2 ? `${coords[1]},${coords[0]}` : '';
            const mapUrl = coordsStr
              ? `https://www.google.com/maps/search/?api=1&query=${coordsStr}`
              : `https://www.google.com/maps/search/${encodeURIComponent(name + ' ' + address)}?hl=vi`;

            const rawPhone = p.phone || p['contact:phone'] || p['phone:mobile'] || '';
            const phone = resolveBusinessPhone(name, address, query, activeTypes, rawPhone);

            results.push({
              name,
              phone,
              rawPhone,
              address,
              website: p.website || p['contact:website'] || '',
              url: mapUrl
            });
          }
        }
      }
    } catch (photonErr) {
      console.warn('[Photon places error]', photonErr);
    }

    // 2. Bổ sung từ Nominatim OpenStreetMap nếu kết quả còn ít
    if (results.length < Math.min(limit, 10)) {
      try {
        const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&extratags=1&limit=${Math.min(limit, 30)}`;
        const nomResp = await fetch(nomUrl, { method: 'GET' });
        if (nomResp.ok) {
          const nomData = await nomResp.json();
          if (Array.isArray(nomData)) {
            for (const item of nomData) {
              const name = item.name || item.display_name?.split(',')?.[0]?.trim();
              if (!name || results.some(r => r.name.toLowerCase() === name.toLowerCase())) continue;

              const address = item.display_name || '';
              const rawPhone = item.extratags?.phone || item.extratags?.['contact:phone'] || item.extratags?.['phone:mobile'] || '';
              const phone = resolveBusinessPhone(name, address, query, activeTypes, rawPhone);

              results.push({
                name,
                phone,
                rawPhone,
                address,
                website: item.extratags?.website || '',
                url: `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lon}`
              });
              if (results.length >= limit) break;
            }
          }
        }
      } catch (nomErr) {
        console.warn('[Nominatim places error]', nomErr);
      }
    }

    return results;
  } catch (e) {
    console.warn('[fetchWebPlacesForQuery error]', e);
    return [];
  }
}

let isDirectScrapingRunning = false;
let mapsTabWindow = null;

async function runMapsScraperDirectly({ skipInitialTabOpen = false, extensionOutdated = false } = {}) {
  if (isDirectScrapingRunning) return;
  isDirectScrapingRunning = true;
  running = true;
  mapsStop = false;
  state.isScanning = true;
  await saveState();
  renderUI();

  try {
    const j = state.job;
    if (!j || !Array.isArray(j.queries) || !j.queries.length) {
      throw new Error('Chưa có danh sách từ khóa tìm kiếm.');
    }

    const isRealExtension = typeof window !== 'undefined' &&
      window.chrome?.runtime?.id &&
      window.chrome.runtime.id !== 'ntd-agency-webapp' &&
      typeof window.chrome?.scripting?.executeScript === 'function' &&
      typeof window.chrome?.tabs?.create === 'function';

    const delaySec = Math.max(2, Math.min(60, Number(j.delay) || 5));
    const allowedTypes = j.phoneTypes || getActivePhoneTypes();
    const limit = Math.max(1, Math.min(500, Number(j.limit) || 50));

    log(`🚀 Bắt đầu quét số Google Maps (Tổng ${j.queries.length} từ khóa, giới hạn ${limit} cơ sở/từ khóa)...`);

    if (isRealExtension) {
      // ── CHẾ ĐỘ TIỆN ÍCH EXTENSION ──
      while (j.index < j.queries.length && !mapsStop) {
        const query = j.queries[j.index];
        log(`[${j.index + 1}/${j.queries.length}] Đang mở tab Google Maps tìm kiếm: "${query}"...`);

        if (j.links === null || !Array.isArray(j.links)) {
          const searchUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=vi';
          if (mapsTabId) {
            try {
              await chrome.tabs.get(mapsTabId);
              await chrome.tabs.update(mapsTabId, { url: searchUrl, active: false });
            } catch (_) {
              mapsTabId = null;
            }
          }
          if (!mapsTabId) {
            const t = await chrome.tabs.create({ url: searchUrl, active: false });
            mapsTabId = t.id;
            state.tabId = mapsTabId;
            await chrome.tabs.update(mapsTabId, { autoDiscardable: false }).catch(() => {});
          }

          log(`Đang chờ tải trang kết quả Google Maps... (Bấm '👁️ Xem tab Maps' nếu muốn xem trực tiếp)`);
          await waitForMapsTab(mapsTabId, 25000);
          if (mapsStop) break;

          let links = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            if (mapsStop) break;
            const rs = await chrome.scripting.executeScript({
              target: { tabId: mapsTabId },
              func: mapsExtract,
              args: ['list', limit]
            }).catch(() => null);
            const res = rs?.[0]?.result;
            if (Array.isArray(res)) {
              links = res;
              break;
            }
            await sleep(2000);
          }

          j.links = links;
          j.cursor = 0;
          await saveState();

          if (links.length) {
            log(`Tìm thấy ${links.length} cơ sở cho: "${query}"`);
          } else {
            log(`Không tìm thấy cơ sở nào cho: "${query}". Chuyển sang từ khóa tiếp theo.`);
          }
        }

        while (j.cursor < (j.links || []).length && !mapsStop) {
          const currentLink = j.links[j.cursor];
          log(`Đang đọc thông tin (${j.cursor + 1}/${j.links.length}) của: ${query}...`);

          try {
            await chrome.tabs.update(mapsTabId, { url: currentLink, active: false });
            await waitForMapsTab(mapsTabId, 15000);
            if (mapsStop) break;

            const rs = await chrome.scripting.executeScript({
              target: { tabId: mapsTabId },
              func: mapsExtract,
              args: ['detail']
            }).catch(() => null);

            const row = rs?.[0]?.result;
            if (row && !row.error) {
              const rawCandidates = [
                ...(Array.isArray(row.phones) ? row.phones : []),
                ...(row.phone ? [row.phone] : [])
              ];
              const cleaned = [...new Set(rawCandidates.map(normPhone).filter(Boolean))];
              const matchedPhone = cleaned.find(p => isPhoneAllowed(p, allowedTypes)) || '';

              if (cleaned.length > 0 && !matchedPhone) {
                const sample = cleaned[0];
                const category = classifyPhone(sample);
                const typeName = category === 'hotline' ? 'tổng đài/cố định' : category === 'old' ? '11 số cũ' : 'ngoài đầu số lọc';
                log(`[Bỏ qua] Cơ sở "${row.name}" có SĐT ${typeName} (${sample}) không khớp bộ lọc đầu số.`);
              } else {
                addRow({ ...row, phone: matchedPhone, query });
                log(matchedPhone ? `✅ ${row.name} - SĐT: ${matchedPhone}` : `📍 ${row.name} (không có SĐT)`);
              }
            }
          } catch (itemErr) {
            console.warn('[Maps Scraper Item Error]', itemErr);
          }

          j.cursor++;
          state.lastScraped = { time: Date.now() };
          await saveState();
          renderUI();

          for (let t = 0; t < delaySec * 2 && !mapsStop; t++) {
            await sleep(500);
          }
        }

        if (!mapsStop) {
          j.index++;
          j.links = null;
          j.cursor = 0;
          await saveState();
        }
      }
    } else {
      // ── CHẾ ĐỘ WEB PLATFORM (Khi chưa cài Extension hoặc Extension cũ chưa hỗ trợ MAPS_SYNC_V2) ──
      showMapsWebNotice(extensionOutdated);
      if (extensionOutdated) {
        log('⚠️ Extension trên profile Chrome này chưa cập nhật trình cào Google Maps mới (MAPS_SYNC_V2).');
        log('👉 Mở chrome://extensions trên chính cửa sổ Chrome này bấm Tải lại (↻) NTD Agency, rồi bấm "🔄 Kiểm tra lại" & "Bắt đầu lượt mới" để cào SĐT thật!');
      } else {
        log('⚠️ Profile Chrome này CHƯA kết nối Extension NTD Agency (ID affaocloanjmkpcinmkcbmekgipnddnm) — trang Web không thể tự đọc SĐT bên trong tab Google Maps.');
        log('👉 Đang tạm tra cứu nguồn dự phòng OpenStreetMap (hầu hết chưa có SĐT). Để lấy full SĐT: bật/nạp Extension NTD Agency trên Chrome này rồi Ctrl+F5, HOẶC sang tab Google Maps vừa mở → Ctrl+A → Ctrl+C rồi bấm "📋 Dán & trích SĐT".');
      }

      const maxWebProbe = Math.min(j.queries.length, 3);
      let foundAnyRealPhone = false;

      while (j.index < j.queries.length && !mapsStop) {
        const query = j.queries[j.index];
        const mapsUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=vi';

        if (!(skipInitialTabOpen && j.index === 0)) {
          log(`[${j.index + 1}/${j.queries.length}] Đang mở tab Google Maps tìm kiếm: "${query}"...`);
          try {
            if (!mapsTabWindow || mapsTabWindow.closed) {
              mapsTabWindow = window.open(mapsUrl, 'ntd_maps_tab');
            } else {
              mapsTabWindow.location.href = mapsUrl;
            }
          } catch (_) {
            mapsTabWindow = window.open(mapsUrl, 'ntd_maps_tab');
          }
        }

        const places = await fetchWebPlacesForQuery(query, limit, allowedTypes);
        if (mapsStop) break;

        if (!places || !places.length) {
          log(`Chưa có SĐT công khai trên OpenStreetMap cho: "${query}".`);
        } else {
          log(`Tìm thấy ${places.length} địa điểm công khai cho: "${query}". Đang lọc SĐT thật theo đầu số...`);
          for (let idx = 0; idx < places.length && !mapsStop; idx++) {
            const p = places[idx];
            const cleanP = p.phone ? normPhone(p.phone) : '';
            if (p.rawPhone && !cleanP) {
              log(`[Bỏ qua] Cơ sở "${p.name}" có SĐT (${p.rawPhone}) ngoài bộ lọc đầu số đã chọn.`);
            } else if (cleanP) {
              foundAnyRealPhone = true;
              addRow({
                name: p.name,
                phone: cleanP,
                address: p.address,
                website: p.website || '',
                url: p.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.address || ''))}`,
                query
              });
              log(`✅ ${p.name} - SĐT: ${cleanP}`);
            } else {
              addRow({
                name: p.name,
                phone: '',
                address: p.address,
                website: p.website || '',
                url: p.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.address || ''))}`,
                query
              });
              log(`📍 ${p.name} - (OpenStreetMap chưa có SĐT)`);
            }

            j.cursor = idx + 1;
            await saveState();
            renderUI();

            for (let t = 0; t < Math.min(delaySec, 3) && !mapsStop; t++) {
              await sleep(400);
            }
          }
        }

        j.index++;
        j.cursor = 0;
        await saveState();

        // Không lặp vô hạn qua hàng nghìn từ khóa nếu trình duyệt Web không có Extension DOM Maps
        if (!foundAnyRealPhone && j.index >= maxWebProbe && j.index < j.queries.length) {
          log('⏸ Tạm dừng quét tự động trên Web do không thể đọc DOM trực tiếp từ tab Google Maps (Cross-Origin). Hãy tải lại Extension 1 lần hoặc dùng nút Dán & trích SĐT ở khung thông báo phía trên!');
          break;
        }
      }
    }

    if (j.index >= j.queries.length) {
      state.job = null;
      state.isScanning = false;
      await saveState();
      if (extensionOutdated) {
        log('⚠️ Extension hiện đang chạy bản cũ chưa có MAPS_SYNC_V2 nên Web không đọc được tab Google Maps. Hãy vào chrome://extensions bấm ↻ Reload NTD Agency rồi chạy lại!');
      } else {
        log('⚠️ Đã kiểm tra xong dữ liệu Web dự phòng (OpenStreetMap). Để cào hàng chục cơ sở & SĐT trực tiếp từ Google Maps, hãy bật Extension NTD Agency trên profile Chrome này (hoặc dùng nút 📋 Dán & trích SĐT từ tab Google Maps).');
      }
    } else {
      state.isScanning = false;
      await saveState();
      log('Đã tạm dừng tiến trình quét. Toàn bộ dữ liệu đã được lưu lại.');
    }
  } catch (err) {
    log('Lỗi tiến trình quét Maps: ' + err.message);
  } finally {
    isDirectScrapingRunning = false;
    running = false;
    state.isScanning = false;
    await saveState();
    renderUI();
  }
}

// ── Kết nối với Background Runner trong worker.js hoặc Chạy trực tiếp ────────────────
async function runLoop({ tabAlreadyOpened = false } = {}) {
  running = true;
  mapsStop = false;
  state.isScanning = true;
  await saveState();
  renderUI();
  let extensionOutdated = false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'MAPS_START_SCAN',
      job: state.job,
      phoneTypes: state.job?.phoneTypes || getActivePhoneTypes(),
      seenKeys: state.seenKeys || {},
      resetSeenKeys: state.rows.length === 0 && Object.keys(state.seenKeys || {}).length === 0
    });
    if (res && res.ok && !res.webFallback) {
      mapsExtSupportsSyncV2 = true;
      hideMapsWebNotice();
      log('🚀 Tiến trình quét Google Maps đã được khởi động chạy ngầm qua Extension (cào DOM + SĐT thật 100%)...');
      return;
    }
    extensionOutdated = Boolean(res?.extensionOutdated);
  } catch (err) {
    // Worker chưa nạp hoặc môi trường Web Platform
  }
  log('⚡ Kích hoạt xử lý trực tiếp trên giao diện Web...');
  runMapsScraperDirectly({ skipInitialTabOpen: tabAlreadyOpened, extensionOutdated });
}

// ── Tiến trình quét số nhóm Facebook chạy trực tiếp (Fallback khi Worker chưa nạp) ──
let isDirectGroupScrapingRunning = false;
let fbGroupTabWindow = null;

function showGroupWebNotice(outdatedExt = false) {
  const box = $('groupWebNoticeBox');
  const txt = $('groupWebNoticeText');
  if (!box || !txt) return;
  box.hidden = false;
  if (outdatedExt) {
    txt.innerHTML = '<strong>⚠️ Extension NTD Agency cần Tải lại (↻) 1 lần:</strong> Bản Extension đang cài trong Chrome chưa cập nhật trình đồng bộ quét số nhóm mới (<code>FB_GROUP_SYNC_V2</code>). Hãy mở <code>chrome://extensions</code> → bấm nút <strong>↻ Reload</strong> trên <strong>NTD Agency</strong> 1 lần rồi bấm <strong>🔄 Kiểm tra lại</strong> để tự động cào SĐT bài viết &amp; bình luận trên Facebook. Hoặc mở tab Nhóm Facebook → bấm <code>Ctrl+A → Ctrl+C</code> rồi bấm nút Dán bên dưới.';
  } else {
    txt.innerHTML = '<strong>🌐 Đang chạy ở chế độ Web trực tiếp:</strong> Do trình duyệt chặn đọc DOM cross-origin bên trong tab <code>facebook.com</code> khi thiếu Extension, bạn hãy bật Extension <strong>NTD Agency</strong> (quét tự động) hoặc copy nội dung tab Nhóm Facebook (<code>Ctrl+A → Ctrl+C</code>) rồi bấm <strong>📋 Dán &amp; trích SĐT</strong> bên dưới.';
  }
}

function hideGroupWebNotice() {
  const box = $('groupWebNoticeBox');
  if (box) box.hidden = true;
}

async function importGroupPhonesFromClipboardText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    log('⚠️ Clipboard trống. Hãy mở tab Nhóm Facebook, cuộn qua các bài viết rồi bấm Ctrl+A, Ctrl+C trước.');
    return 0;
  }

  const allowedTypes = getActiveGroupPhoneTypes();
  const rawGroupUrl = String($('groupUrl')?.value || groupState.job?.groupUrl || '').split(/[\r\n,]+/)[0]?.trim() || 'https://www.facebook.com/groups/';
  const gidMatch = rawGroupUrl.match(/groups\/([^/?]+)/);
  const defaultGroupName = gidMatch ? `Nhóm Facebook (${gidMatch[1]})` : 'Nhóm Facebook';

  const normalizedText = normalizeUnicodeDigits(text)
    .replace(/\b[oO](?=[0-9])/gi, '0')
    .replace(/(?<=[0-9])[oO](?=[0-9])/gi, '0')
    .replace(/(?<=\b(?:sđt|sdt|lh|zalo|call|phone|hotline|alo|đt|dt|tel)[:\s]*)[oO]/gi, '0')
    .replace(/([oO])(?=[0-9])/g, '0');

  const lines = normalizedText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const phoneRegex = /(?:\(\s*(?:\+?84|0)\s*\)|(?:\+?84|84|0))[.\s\-/_()]*(?:\d[.\s\-/_()]*){8,10}\d(?!\d)|\b(?:1800|1900)[.\s\-/_]*(?:\d[.\s\-/_]*){3,6}\d(?!\d)/gi;

  if (!groupState.seenKeys) groupState.seenKeys = {};
  if (!Array.isArray(groupState.rows)) groupState.rows = [];

  let added = 0;
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(phoneRegex)];
    if (!matches.length) continue;

    for (const m of matches) {
      const idx = m.index || 0;
      if (idx > 0 && /\d/.test(line[idx - 1])) continue;
      if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(m[0])) continue;

      const cleanP = normPhone(m[0]);
      if (!cleanP || cleanP.length < 8 || cleanP.length > 11) continue;
      const category = classifyPhone(cleanP);
      if (!category || category === 'other') continue;

      if (!isPhoneAllowed(cleanP, allowedTypes)) {
        skipped++;
        continue;
      }
      if (groupState.seenKeys[cleanP]) continue;
      groupState.seenKeys[cleanP] = true;

      let authorName = 'Thành viên nhóm';
      for (let back = i - 1; back >= Math.max(0, i - 6); back--) {
        const prev = lines[back];
        if (!prev || prev.length < 2 || prev.length > 60) continue;
        if (/^(Thích|Bình luận|Chia sẻ|Trả lời|Xem thêm|Quản trị viên|Người đóng góp|\d+\s*(giờ|phút|ngày|tuần))/i.test(prev)) continue;
        if (!phoneRegex.test(prev) && !/https?:\/\//i.test(prev)) {
          authorName = prev;
          break;
        }
      }

      groupState.rows.push({
        id: 'fg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        phone: cleanP,
        rawPhone: m[0].trim(),
        name: authorName,
        source: 'Bài viết / Bình luận (Clipboard)',
        context: line.slice(0, 140),
        postUrl: rawGroupUrl,
        groupName: defaultGroupName,
        groupUrl: rawGroupUrl,
        category,
        at: new Date().toLocaleString('vi-VN')
      });
      added++;
      log(`✅ [Clipboard Nhóm] ${cleanP} (${authorName})`);
    }
  }

  groupState.postsCount = Math.max(groupState.postsCount || 0, Math.min(lines.length, 50));
  await chrome.storage.local.set({ rinFbGroup: groupState });
  renderUI();
  if (added > 0) {
    log(`🎉 Đã trích & lọc được ${added} SĐT thật từ nội dung Nhóm Facebook (bỏ qua ${skipped} số ngoài đầu số lọc).`);
  } else {
    log(`ℹ️ Chưa tìm thấy thêm SĐT mới khớp bộ lọc đầu số (bỏ qua ${skipped} số ngoài bộ lọc).`);
  }
  return added;
}

async function waitForFbTab(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (groupStop) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab Facebook nhóm đã bị đóng.');

    if (tab.status === 'complete' && !tab.pendingUrl) {
      if (tab.url?.includes('/login') || tab.url?.includes('checkpoint')) {
        throw new Error('Facebook chuyển hướng sang đăng nhập. Vui lòng đăng nhập Facebook trên trình duyệt rồi thử lại.');
      }
      return true;
    }
    await sleep(500);
  }
  return true;
}

async function runGroupScraperDirectly({ skipInitialTabOpen = false, extensionOutdated = false } = {}) {
  if (isDirectGroupScrapingRunning) return;
  isDirectGroupScrapingRunning = true;
  groupRunning = true;
  groupStop = false;
  groupState.isScanning = true;
  await chrome.storage.local.set({ rinFbGroup: groupState });
  renderUI();

  try {
    const j = groupState.job;
    if (!j || !j.groupUrl) {
      throw new Error('Chưa nhập đường link nhóm Facebook cần quét.');
    }

    let groupUrls = String(j.groupUrl || '')
      .split(/[\r\n,]+/)
      .map(x => x.trim())
      .filter(Boolean);

    if (!groupUrls.length) {
      throw new Error('Không tìm thấy link nhóm Facebook hợp lệ.');
    }

    if (j.groupIndex == null) j.groupIndex = 0;

    const maxPostsPerGroup = Math.max(5, Math.min(5000, Number(j.maxPosts) || 500));
    const delaySec = Math.max(2, Math.min(30, Number(j.scrollDelay) || 3));
    const allowedTypes = j.phoneTypes || getActiveGroupPhoneTypes();
    const scanOptions = j.options || { scanPosts: true, scanComments: true, scanImages: true };

    const isRealExtension = typeof window !== 'undefined' &&
      window.chrome?.runtime?.id &&
      window.chrome.runtime.id !== 'ntd-agency-webapp' &&
      typeof window.chrome?.scripting?.executeScript === 'function' &&
      typeof window.chrome?.tabs?.create === 'function';

    if (isRealExtension) {
      log(`🚀 Bắt đầu quét số nhóm Facebook (Quy tắc: tối đa ${maxPostsPerGroup} bài viết / mỗi link nhóm, tổng ${groupUrls.length} nhóm)...`);
      // ── CHẾ ĐỘ TIỆN ÍCH EXTENSION (Tự động mở tab Facebook qua Extension & cào DOM) ──
      while (j.groupIndex < groupUrls.length && !groupStop) {
        const rawUrl = groupUrls[j.groupIndex];
        let targetUrl = rawUrl;
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
        if (!targetUrl.includes('sorting_setting=')) {
          targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL';
        }

        log(`[Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Đang mở nhóm Facebook: ${rawUrl}`);

        if (groupState.tabId) {
          try {
            await chrome.tabs.get(groupState.tabId);
            await chrome.tabs.update(groupState.tabId, { url: targetUrl, active: false });
          } catch (_) {
            groupState.tabId = null;
          }
        }

        if (!groupState.tabId) {
          const createdTab = await chrome.tabs.create({ url: targetUrl, active: false });
          groupState.tabId = createdTab.id;
          await chrome.tabs.update(groupState.tabId, { autoDiscardable: false }).catch(() => {});
        }

        await chrome.storage.local.set({ rinFbGroup: groupState });

        log(`Đang chờ tải trang nhóm... (Bấm '👁️ Xem tab Facebook' nếu muốn xem trực tiếp)`);
        await waitForFbTab(groupState.tabId, 25000);
        if (groupStop) break;

        // Nạp script cuộn trang và script trích xuất
        await chrome.scripting.executeScript({
          target: { tabId: groupState.tabId },
          world: 'MAIN',
          files: ['fb_scroll_hook.js']
        }).catch(() => {});

        await chrome.scripting.executeScript({
          target: { tabId: groupState.tabId },
          files: ['fb_group_extract.js']
        }).catch(() => {});

        await sleep(2000);
        if (groupStop) break;

        // Lưu trữ tập hợp các bài viết duy nhất đã duyệt trong nhóm hiện tại
        const seenPostKeysInThisGroup = new Set();
        let stagnantCount = 0;
        let totalPostsScannedInGroup = 0;
        let previousPostCount = 0;
        let scanRound = 0;

        while (!groupStop && totalPostsScannedInGroup < maxPostsPerGroup && stagnantCount < 25) {
          scanRound++;

          // 1. Tự động mở rộng "Xem thêm" bài viết & bình luận
          await chrome.scripting.executeScript({
            target: { tabId: groupState.tabId },
            func: () => {
              if (typeof window.expandSeeMoreAndComments === 'function') {
                return window.expandSeeMoreAndComments(6);
              }
            }
          }).catch(() => {});

          await sleep(1000);
          if (groupStop) break;

          // 2. Trích xuất toàn bộ SĐT trong bài viết, ảnh OCR, bình luận
          const extractRes = await chrome.scripting.executeScript({
            target: { tabId: groupState.tabId },
            func: (opts) => {
              if (typeof window.extractGroupPhonesFromDOM === 'function') {
                return window.extractGroupPhonesFromDOM(opts);
              }
              return { items: [], postsCount: 0, postKeys: [], commentsCount: 0, groupTitle: '' };
            },
            args: [scanOptions]
          }).catch(() => null);

          const data = extractRes?.[0]?.result || { items: [], postsCount: 0, postKeys: [], commentsCount: 0, groupTitle: '' };
          const foundItems = data.items || [];

          // Đếm chính xác bài viết duy nhất bằng tập hợp postKeys (chống sai lệch do Facebook ảo hóa DOM)
          if (Array.isArray(data.postKeys)) {
            for (const pk of data.postKeys) {
              if (pk) seenPostKeysInThisGroup.add(pk);
            }
          }
          totalPostsScannedInGroup = Math.max(seenPostKeysInThisGroup.size, data.postsCount || 0);

          let newPhonesAddedInRound = 0;
          if (!groupState.seenKeys) groupState.seenKeys = {};
          if (!Array.isArray(groupState.rows)) groupState.rows = [];

          for (const item of foundItems) {
            const phone = item.phone;
            if (!phone) continue;

            const category = item.category || classifyPhone(phone);
            if (!isPhoneAllowed(phone, allowedTypes)) continue;

            // Bỏ trùng lặp SĐT
            if (groupState.seenKeys[phone]) continue;
            groupState.seenKeys[phone] = true;

            groupState.rows.push({
              id: 'fg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              phone: phone,
              rawPhone: item.rawPhone || phone,
              name: item.name || 'Thành viên nhóm',
              source: item.source || 'Bài viết',
              context: item.context || '',
              postUrl: item.postUrl || rawUrl,
              groupName: data.groupTitle || item.groupName || 'Nhóm Facebook',
              groupUrl: rawUrl,
              category: category,
              at: new Date().toLocaleString('vi-VN')
            });
            newPhonesAddedInRound++;

            log(`✅ Tìm thấy SĐT: ${phone} (${item.name} – Nguồn: ${item.source})`);
          }

          groupState.postsCount = (groupState.totalPostsOffset || 0) + totalPostsScannedInGroup;
          groupState.commentsCount = (groupState.commentsCount || 0) + (data.commentsCount || 0);
          await chrome.storage.local.set({ rinFbGroup: groupState });
          renderUI();

          if (totalPostsScannedInGroup > previousPostCount || newPhonesAddedInRound > 0) {
            stagnantCount = 0;
            previousPostCount = totalPostsScannedInGroup;
          } else {
            stagnantCount++;
          }

          log(`[Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Vòng ${scanRound}: Đã duyệt ${totalPostsScannedInGroup}/${maxPostsPerGroup} bài | Tìm thấy ${groupState.rows.length} SĐT`);

          if (totalPostsScannedInGroup >= maxPostsPerGroup) {
            log(`🎉 [Nhóm ${j.groupIndex + 1}/${groupUrls.length}] Đã quét đủ chỉ tiêu ${maxPostsPerGroup} bài viết cho link này!`);
            break;
          }

          // 3. Cuộn trang tiếp (Hỗ trợ cuộn trong Popup bài viết hoặc Bảng tin nhóm)
          const scrollRes = await chrome.scripting.executeScript({
            target: { tabId: groupState.tabId },
            func: (stagnant) => {
              if (typeof window.scrollPostDialogOrFeed === 'function') {
                return window.scrollPostDialogOrFeed(stagnant);
              }
              if (typeof window.scrollFacebookGroupFeed === 'function') {
                return window.scrollFacebookGroupFeed(stagnant);
              }
              window.scrollBy({ top: 3000, behavior: 'smooth' });
            },
            args: [stagnantCount]
          }).catch(() => null);

          const scrollInfo = scrollRes?.[0]?.result;
          if (scrollInfo?.isDialog && scrollInfo?.closed) {
            log('💬 Đã quét xong bình luận trong bài viết. Đã đóng bài viết để cuộn tiếp nhóm...');
          } else if (scrollInfo?.isDialog) {
            log(`💬 Đang lướt đọc bình luận trong bài viết (Lượt ${scrollInfo.scrollRounds || 1})...`);
          }

          for (let t = 0; t < delaySec * 2 && !groupStop; t++) {
            await sleep(500);
          }
        }

        if (!groupStop) {
          // Cập nhật tổng số bài đã duyệt tích lũy qua các nhóm
          groupState.totalPostsOffset = (groupState.totalPostsOffset || 0) + totalPostsScannedInGroup;
          j.groupIndex++;
          await chrome.storage.local.set({ rinFbGroup: groupState });

          if (j.groupIndex < groupUrls.length) {
            log(`➡️ Tự động chuyển sang link nhóm tiếp theo [${j.groupIndex + 1}/${groupUrls.length}]: ${groupUrls[j.groupIndex]}`);
            await sleep(2500);
          }
        }
      }
    } else {
      // ── CHẾ ĐỘ NỀN TẢNG WEB (Không thể đọc DOM cross-origin tab Facebook nếu chưa Reload Extension) ──
      showGroupWebNotice(extensionOutdated);
      if (extensionOutdated) {
        log('⚠️ Extension NTD Agency đang ở bản cũ chưa cập nhật FB_GROUP_SYNC_V2 nên trình duyệt chặn đọc DOM tab Facebook.');
        log('👉 Vào chrome://extensions bấm Tải lại (↻) NTD Agency 1 lần rồi bấm "🔄 Kiểm tra lại" & "Bắt đầu quét số nhóm" — hoặc copy nội dung tab Nhóm (Ctrl+A → Ctrl+C) rồi bấm nút Dán ở trên!');
      } else {
        log('🌐 Chế độ Web trực tiếp: Không thể đọc trực tiếp DOM bên trong tab Facebook khi chưa bật Extension. Hãy bật Extension hoặc dùng nút 📋 Dán & trích SĐT từ tab Nhóm Facebook.');
      }

      if (!skipInitialTabOpen) {
        const rawUrl = groupUrls[j.groupIndex] || groupUrls[0];
        let targetUrl = rawUrl;
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
        if (!targetUrl.includes('sorting_setting=')) {
          targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL';
        }
        try {
          if (!fbGroupTabWindow || fbGroupTabWindow.closed) {
            fbGroupTabWindow = window.open(targetUrl, 'ntd_fb_group_tab');
          } else {
            fbGroupTabWindow.location.href = targetUrl;
          }
        } catch (_) {}
      }

      groupState.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: groupState });
      return;
    }

    if (j.groupIndex >= groupUrls.length) {
      groupState.job = null;
      groupState.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: groupState });
      log(`🎉 Hoàn tất quét toàn bộ nhóm! Đã thu thập ${groupState.rows.length} số điện thoại.`);
    } else {
      groupState.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: groupState });
      log('Đã dừng quét nhóm. Tiến trình đã được lưu lại, bạn có thể bấm Tiếp tục bất cứ lúc nào.');
    }
  } catch (err) {
    groupState.isScanning = false;
    await chrome.storage.local.set({ rinFbGroup: groupState });
    log('⚠️ Tạm dừng do sự cố: ' + err.message);
  } finally {
    isDirectGroupScrapingRunning = false;
    groupRunning = false;
    groupState.isScanning = false;
    await chrome.storage.local.set({ rinFbGroup: groupState });
    renderUI();
  }
}

// ── Bộ chọn Địa bàn Hành chính (34 tỉnh - 3.321 phường/xã) ───────────────────
let selectedProvinces = []; // ['Hà Nội', 'Đà Nẵng', ...]
let selectedWards = [];     // [{ name, full, type, code, provName }]

const ALIAS_PROVINCES = {
  'hcm': 'Hồ Chí Minh',
  'tphcm': 'Hồ Chí Minh',
  'tp hcm': 'Hồ Chí Minh',
  'sg': 'Hồ Chí Minh',
  'saigon': 'Hồ Chí Minh',
  'sài gòn': 'Hồ Chí Minh',
  'hn': 'Hà Nội',
  'dn': 'Đà Nẵng',
  'hp': 'Hải Phòng',
  'ct': 'Cần Thơ',
  'bd': 'Bình Dương'
};

function removeVietnameseTones(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function syncProvincesToStore() {
  const provEl = $('provinces');
  if (provEl) provEl.value = selectedProvinces.join('\n');

  const countEl = $('provinceSelectedCount');
  if (countEl) countEl.textContent = `Đã chọn: ${selectedProvinces.length}`;

  document.querySelectorAll('.quick-chip').forEach(chip => {
    const prov = chip.getAttribute('data-prov');
    chip.classList.toggle('active', selectedProvinces.includes(prov));
  });

  renderProvinceChips();
  updateQueryPreview();
}

function renderProvinceChips() {
  const container = $('selectedProvinceChips');
  if (!container) return;
  container.innerHTML = '';

  selectedProvinces.forEach(p => {
    const chip = document.createElement('span');
    chip.className = 'geo-chip';
    chip.innerHTML = `${p} <span class="geo-chip-remove" title="Xóa">×</span>`;
    chip.querySelector('.geo-chip-remove').onclick = (e) => {
      e.stopPropagation();
      toggleProvince(p);
    };
    container.appendChild(chip);
  });
}

function toggleProvince(provName) {
  const idx = selectedProvinces.indexOf(provName);
  if (idx >= 0) {
    selectedProvinces.splice(idx, 1);
    // Lọc bỏ xã của tỉnh này nếu không còn tỉnh
    selectedWards = selectedWards.filter(w => w.provName !== provName);
  } else {
    selectedProvinces.push(provName);
  }

  syncProvincesToStore();
  syncWardsToStore();
  renderProvinceDropdown($('provinceSearch')?.value || '');
  renderWardDropdown($('wardSearch')?.value || '');
}

function renderProvinceDropdown(searchTerm = '') {
  const dropdown = $('provinceDropdownList');
  if (!dropdown) return;

  const raw = (searchTerm || '').trim();
  const rawLower = raw.toLowerCase();
  const aliasTarget = ALIAS_PROVINCES[rawLower];
  const query = removeVietnameseTones(raw);

  let matched = VIETNAM_UNITS;
  if (aliasTarget) {
    matched = VIETNAM_UNITS.filter(u => u.name === aliasTarget);
  } else if (query) {
    matched = VIETNAM_UNITS.filter(u => {
      const nameNorm = removeVietnameseTones(u.name);
      const oldNorm = removeVietnameseTones(u.old);
      return nameNorm.includes(query) || oldNorm.includes(query);
    });
  }

  if (!matched.length) {
    dropdown.innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">Không tìm thấy tỉnh/thành nào phù hợp</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  matched.forEach(u => {
    const isSelected = selectedProvinces.includes(u.name);
    const item = document.createElement('div');
    item.className = 'geo-item' + (isSelected ? ' selected' : '');
    item.innerHTML = `
      <div class="geo-item-left">
        <input type="checkbox" class="geo-item-checkbox" ${isSelected ? 'checked' : ''}>
        <span>${u.name}</span>
        ${u.old && u.old !== u.name ? `<span style="font-size:10.5px;color:#94a3b8">(${u.old})</span>` : ''}
      </div>
      <span class="geo-item-badge count">${u.wards ? u.wards.length : 0} xã/phường</span>
    `;
    item.onclick = (e) => {
      e.stopPropagation();
      toggleProvince(u.name);
    };
    frag.appendChild(item);
  });

  dropdown.replaceChildren(frag);
}

// ── Quản lý Phường / Xã ───────────────────────────────────────────────────────
function getAvailableWards() {
  const list = [];
  if (selectedProvinces.length > 0) {
    VIETNAM_UNITS.forEach(u => {
      if (selectedProvinces.includes(u.name)) {
        (u.wards || []).forEach(w => {
          list.push({ ...w, provName: u.name });
        });
      }
    });
  } else {
    VIETNAM_UNITS.forEach(u => {
      (u.wards || []).forEach(w => {
        list.push({ ...w, provName: u.name });
      });
    });
  }
  return list;
}

function syncWardsToStore() {
  const wardEl = $('wards');
  if (wardEl) {
    wardEl.value = selectedWards.map(w => `${w.full}, ${w.provName}`).join('\n');
  }

  const countEl = $('wardSelectedCount');
  if (countEl) countEl.textContent = `Đã chọn: ${selectedWards.length}`;

  renderWardChips();
  updateQueryPreview();
}

function renderWardChips() {
  const container = $('selectedWardChips');
  if (!container) return;
  container.innerHTML = '';

  const maxDisplay = 20;
  const toDisplay = selectedWards.slice(0, maxDisplay);

  toDisplay.forEach(w => {
    const chip = document.createElement('span');
    chip.className = 'geo-chip';
    chip.innerHTML = `${w.full} <span style="font-size:10.5px;opacity:.75">(${w.provName})</span> <span class="geo-chip-remove" title="Xóa">×</span>`;
    chip.querySelector('.geo-chip-remove').onclick = (e) => {
      e.stopPropagation();
      toggleWard(w);
    };
    container.appendChild(chip);
  });

  if (selectedWards.length > maxDisplay) {
    const moreChip = document.createElement('span');
    moreChip.className = 'geo-chip';
    moreChip.style.background = '#f1f5f9';
    moreChip.style.color = '#64748b';
    moreChip.textContent = `+${selectedWards.length - maxDisplay} xã/phường khác`;
    container.appendChild(moreChip);
  }
}

function toggleWard(wardObj) {
  const idx = selectedWards.findIndex(w => (w.code && w.code === wardObj.code && w.provName === wardObj.provName) || (w.full === wardObj.full && w.provName === wardObj.provName));
  if (idx >= 0) {
    selectedWards.splice(idx, 1);
  } else {
    selectedWards.push(wardObj);
  }

  syncWardsToStore();
  renderWardDropdown($('wardSearch')?.value || '');
}

function renderWardDropdown(searchTerm = '') {
  const dropdown = $('wardDropdownList');
  if (!dropdown) return;

  const available = getAvailableWards();
  const query = removeVietnameseTones(searchTerm || '');

  let matched = available;
  if (query) {
    matched = available.filter(w => {
      const fullNorm = removeVietnameseTones(w.full);
      const nameNorm = removeVietnameseTones(w.name);
      const provNorm = removeVietnameseTones(w.provName);
      return fullNorm.includes(query) || nameNorm.includes(query) || provNorm.includes(query);
    });
  }

  if (!matched.length) {
    dropdown.innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:12px">Không tìm thấy phường/xã nào phù hợp</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  const slice = matched.slice(0, 100);

  slice.forEach(w => {
    const isSelected = selectedWards.some(x => (x.code && x.code === w.code && x.provName === w.provName) || (x.full === w.full && x.provName === w.provName));
    const item = document.createElement('div');
    item.className = 'geo-item' + (isSelected ? ' selected' : '');

    let badgeCls = 'ward';
    if (w.type === 'Xã') badgeCls = 'commune';
    else if (w.type === 'Đặc khu') badgeCls = 'special';

    item.innerHTML = `
      <div class="geo-item-left">
        <input type="checkbox" class="geo-item-checkbox" ${isSelected ? 'checked' : ''}>
        <span class="geo-item-badge ${badgeCls}">${w.type || 'Xã/P'}</span>
        <span>${w.full}</span>
        <span style="font-size:11px;color:#94a3b8;margin-left:4px">(${w.provName})</span>
      </div>
    `;
    item.onclick = (e) => {
      e.stopPropagation();
      toggleWard(w);
    };
    frag.appendChild(item);
  });

  if (matched.length > 100) {
    const more = document.createElement('div');
    more.style.padding = '8px 12px';
    more.style.textAlign = 'center';
    more.style.fontSize = '11.5px';
    more.style.color = '#64748b';
    more.textContent = `... còn ${matched.length - 100} xã/phường. Hãy gõ chữ cái để lọc nhanh.`;
    frag.appendChild(more);
  }

  dropdown.replaceChildren(frag);
}

function restoreGeoPickers(provinceText = '', wardText = '') {
  selectedProvinces = [];
  selectedWards = [];

  // Parse provinces
  const provLines = String(provinceText || '').split(/[\n;,]+/).map(x => x.trim()).filter(Boolean);
  provLines.forEach(line => {
    const lineNorm = removeVietnameseTones(line);
    const found = VIETNAM_UNITS.find(u => {
      return removeVietnameseTones(u.name) === lineNorm || removeVietnameseTones(u.old) === lineNorm;
    });
    const provName = found ? found.name : line;
    if (!selectedProvinces.includes(provName)) {
      selectedProvinces.push(provName);
    }
  });

  // Parse wards
  const wardLines = String(wardText || '').split(/[\n;]+/).map(x => x.trim()).filter(Boolean);
  wardLines.forEach(line => {
    let provPart = selectedProvinces[0] || '';
    let wardPart = line;

    if (line.includes(',')) {
      const parts = line.split(',');
      wardPart = parts[0].trim();
      provPart = parts[1].trim();
    }

    const wardNorm = removeVietnameseTones(wardPart);
    const provNorm = removeVietnameseTones(provPart);

    let matchUnit = VIETNAM_UNITS.find(u => removeVietnameseTones(u.name) === provNorm);
    let matchWard = null;

    if (matchUnit) {
      matchWard = (matchUnit.wards || []).find(w => removeVietnameseTones(w.full) === wardNorm || removeVietnameseTones(w.name) === wardNorm);
    } else {
      for (const u of VIETNAM_UNITS) {
        const found = (u.wards || []).find(w => removeVietnameseTones(w.full) === wardNorm || removeVietnameseTones(w.name) === wardNorm);
        if (found) {
          matchWard = found;
          provPart = u.name;
          break;
        }
      }
    }

    if (matchWard) {
      selectedWards.push({ ...matchWard, provName: provPart || (matchUnit ? matchUnit.name : '') });
    } else {
      selectedWards.push({ full: wardPart, name: wardPart, type: 'Xã/P', provName: provPart, code: '' });
    }
  });

  syncProvincesToStore();
  syncWardsToStore();
  renderProvinceDropdown();
  renderWardDropdown();
}

function setupGeoPickers() {
  // Dropdown Tỉnh
  $('provinceSearch')?.addEventListener('input', e => {
    $('provinceDropdownList').hidden = false;
    renderProvinceDropdown(e.target.value);
  });
  $('provinceSearch')?.addEventListener('focus', () => {
    $('provinceDropdownList').hidden = false;
    renderProvinceDropdown($('provinceSearch').value);
  });
  $('toggleProvinceDropdownBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = $('provinceDropdownList');
    list.hidden = !list.hidden;
    if (!list.hidden) renderProvinceDropdown($('provinceSearch').value);
  });

  // Dropdown Phường / Xã
  $('wardSearch')?.addEventListener('input', e => {
    $('wardDropdownList').hidden = false;
    renderWardDropdown(e.target.value);
  });
  $('wardSearch')?.addEventListener('focus', () => {
    $('wardDropdownList').hidden = false;
    renderWardDropdown($('wardSearch').value);
  });
  $('toggleWardDropdownBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = $('wardDropdownList');
    list.hidden = !list.hidden;
    if (!list.hidden) renderWardDropdown($('wardSearch').value);
  });

  // Đóng khi click ngoài
  document.addEventListener('click', (e) => {
    if (!$('provincePickerCard')?.contains(e.target) && !$('toggleProvinceDropdownBtn')?.contains(e.target)) {
      const pList = $('provinceDropdownList');
      if (pList) pList.hidden = true;
    }
    if (!$('wardPickerCard')?.contains(e.target) && !$('toggleWardDropdownBtn')?.contains(e.target)) {
      const wList = $('wardDropdownList');
      if (wList) wList.hidden = true;
    }
  });

  // Quick picks đô thị lớn
  document.querySelectorAll('.quick-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const prov = chip.getAttribute('data-prov');
      if (prov) toggleProvince(prov);
    });
  });

  // Nút Xóa chọn Tỉnh
  $('clearProvincesBtn')?.addEventListener('click', () => {
    selectedProvinces = [];
    selectedWards = [];
    syncProvincesToStore();
    syncWardsToStore();
    renderProvinceDropdown($('provinceSearch')?.value || '');
    renderWardDropdown($('wardSearch')?.value || '');
  });

  // Nút Chọn tất cả Phường / Xã của tỉnh đang chọn
  $('selectAllWardsBtn')?.addEventListener('click', () => {
    const available = getAvailableWards();
    available.forEach(w => {
      if (!selectedWards.some(x => (x.code && x.code === w.code && x.provName === w.provName) || (x.full === w.full && x.provName === w.provName))) {
        selectedWards.push(w);
      }
    });
    syncWardsToStore();
    renderWardDropdown($('wardSearch')?.value || '');
  });

  // Nút Xóa chọn Phường / Xã
  $('clearWardsBtn')?.addEventListener('click', () => {
    selectedWards = [];
    syncWardsToStore();
    renderWardDropdown($('wardSearch')?.value || '');
  });

  // Toggle chế độ Nhập tay Tỉnh
  $('toggleProvinceManualBtn')?.addEventListener('click', () => {
    const wrap = $('provinceManualWrap');
    wrap.hidden = !wrap.hidden;
    $('toggleProvinceManualBtn').textContent = wrap.hidden ? 'Nhập tay' : 'Đóng nhập tay';
    if (!wrap.hidden) $('provinces')?.focus();
  });

  $('provinces')?.addEventListener('change', () => {
    restoreGeoPickers($('provinces').value, $('wards').value);
  });

  // Toggle chế độ Nhập tay Phường / Xã
  $('toggleWardManualBtn')?.addEventListener('click', () => {
    const wrap = $('wardManualWrap');
    wrap.hidden = !wrap.hidden;
    $('toggleWardManualBtn').textContent = wrap.hidden ? 'Nhập tay' : 'Đóng nhập tay';
    if (!wrap.hidden) $('wards')?.focus();
  });

  $('wards')?.addEventListener('change', () => {
    restoreGeoPickers($('provinces').value, $('wards').value);
  });
}

// ── Cập nhật Preview lượt tìm kiếm ──────────────────────────────────────────
function updateQueryPreview() {
  const isWard = $('areaMode').value === 'ward';
  $('wardBox').hidden = !isWard;

  try {
    const q = buildQueries(
      $('queries').value,
      $('areaMode').value,
      $('provinces').value,
      $('wards').value
    );
    $('preview').textContent = `${q.length} lượt tìm kiếm sẽ chạy lần lượt · Tự lọc trùng SĐT`;
    $('queryPreview').textContent = q.join('\n');
  } catch (e) {
    $('preview').textContent = e.message;
    $('queryPreview').textContent = '';
  }
}

// ── Xử lý các sự kiện nút điều khiển ──────────────────────────────────────────
function setupEventListeners() {
  // Khởi tạo bộ chọn địa bàn
  setupGeoPickers();

  // Toggle Preview List
  $('toggleQueryPreview')?.addEventListener('click', () => {
    const p = $('queryPreview');
    const isHidden = p.hidden;
    p.hidden = !isHidden;
    $('toggleQueryPreview').textContent = isHidden ? 'Thu gọn ▴' : 'Xem chi tiết ▾';
  });

  // Gợi ý từ khóa tag click
  document.querySelectorAll('.tag-item').forEach(tag => {
    tag.addEventListener('click', () => {
      const val = tag.getAttribute('data-tag');
      const textarea = $('queries');
      if (textarea) {
        const cur = textarea.value.trim();
        textarea.value = cur ? cur + '\n' + val : val;
        updateQueryPreview();
      }
    });
  });

  // Thay đổi input từ khóa/khu vực (Debounced 200ms để không giật khi gõ)
  let _queryPreviewDebounce = null;
  const debouncedQueryPreview = () => {
    if (_queryPreviewDebounce) clearTimeout(_queryPreviewDebounce);
    _queryPreviewDebounce = setTimeout(updateQueryPreview, 200);
  };

  ['queries', 'areaMode', 'provinces', 'wards'].forEach(id => {
    $(id)?.addEventListener('input', debouncedQueryPreview);
  });
  $('areaMode')?.addEventListener('change', () => {
    updateQueryPreview();
    if ($('areaMode').value === 'ward') {
      renderWardDropdown($('wardSearch')?.value || '');
    }
  });

  // Tìm kiếm & Lọc trên bảng (Debounced 150ms)
  let _tableSearchDebounce = null;
  $('tableSearch')?.addEventListener('input', () => {
    if (_tableSearchDebounce) clearTimeout(_tableSearchDebounce);
    _tableSearchDebounce = setTimeout(renderTable, 150);
  });
  $('tableFilter')?.addEventListener('change', renderTable);
  $('clearLogBtn')?.addEventListener('click', () => {
    $('log').textContent = '';
  });

  // Lắng nghe thay đổi loại số điện thoại cần quét & bộ lọc đầu số riêng
  ['phoneTypeCurrent', 'phoneTypeHotline', 'phoneTypeOld'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      syncPhoneTypeUI();
      if (!state.settings) state.settings = {};
      state.settings.phoneTypes = getActivePhoneTypes();
      saveState();
      renderUI();
    });
  });

  $('customPhonePrefixes')?.addEventListener('input', () => {
    if (!state.settings) state.settings = {};
    state.settings.phoneTypes = getActivePhoneTypes();
    saveState();
    renderUI();
  });

  $('groupCustomPhonePrefixes')?.addEventListener('input', () => {
    if (!groupState.settings) groupState.settings = {};
    groupState.settings.phoneTypes = getActiveGroupPhoneTypes();
    chrome.storage.local.set({ rinFbGroup: groupState });
    renderUI();
  });

  document.querySelectorAll('.prefix-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target') || 'maps';
      const carrier = btn.getAttribute('data-carrier') || 'all';
      const presetVal = CARRIER_PREFIX_PRESETS[carrier] ?? '';
      const rowEl = $(target === 'maps' ? 'mapsCarrierPresetRow' : 'groupCarrierPresetRow');
      rowEl?.querySelectorAll('.prefix-preset-btn').forEach(b => b.classList.toggle('active', b === btn));

      const inputEl = $(target === 'maps' ? 'customPhonePrefixes' : 'groupCustomPhonePrefixes');
      if (inputEl) inputEl.value = presetVal;

      if (target === 'maps') {
        if (carrier === 'hotline' && $('phoneTypeHotline')) {
          $('phoneTypeHotline').checked = true;
          syncPhoneTypeUI();
        } else if (carrier !== 'all' && $('phoneTypeCurrent')) {
          $('phoneTypeCurrent').checked = true;
          syncPhoneTypeUI();
        }
        if (!state.settings) state.settings = {};
        state.settings.phoneTypes = getActivePhoneTypes();
        saveState();
      } else {
        if (carrier === 'hotline' && $('groupPhoneTypeHotline')) {
          $('groupPhoneTypeHotline').checked = true;
          syncGroupPhoneTypeUI();
        } else if (carrier !== 'all' && $('groupPhoneTypeCurrent')) {
          $('groupPhoneTypeCurrent').checked = true;
          syncGroupPhoneTypeUI();
        }
        if (!groupState.settings) groupState.settings = {};
        groupState.settings.phoneTypes = getActiveGroupPhoneTypes();
        chrome.storage.local.set({ rinFbGroup: groupState });
      }
      renderUI();
    });
  });

  $('mapsPasteImportBtn')?.addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {}
    if (!text) {
      text = prompt('Dán toàn bộ nội dung vừa copy từ tab Google Maps (Ctrl+A -> Ctrl+C) vào đây:') || '';
    }
    if (text) {
      await importMapsPhonesFromClipboardText(text);
    }
  });

  $('mapsRecheckExtBtn')?.addEventListener('click', async () => {
    const st = await chrome.runtime.sendMessage({ type: 'MAPS_GET_STATUS' }).catch(() => null);
    mapsExtSupportsSyncV2 = Boolean(st?.ok && Number(st?.syncVersion) >= 2);
    if (mapsExtSupportsSyncV2) {
      hideMapsWebNotice();
      log('✅ Đã kết nối Extension NTD Agency bản mới (MAPS_SYNC_V2)! Bấm "Bắt đầu lượt mới" để tự động cào SĐT Google Maps.');
    } else {
      const outdated = Boolean(st?.extensionOutdated || document.documentElement.dataset.ntdExtensionConnected === 'true');
      showMapsWebNotice(outdated);
      log(outdated
        ? '⚠️ Extension vẫn chưa nạp bản mới. Hãy mở chrome://extensions và bấm ↻ Tải lại NTD Agency.'
        : '⚠️ Chưa phát hiện Extension NTD Agency đang bật.');
    }
  });

  // Bắt đầu lượt mới (Maps)
  $('start').onclick = async () => {
    let queries;
    try {
      queries = buildQueries(
        $('queries').value,
        $('areaMode').value,
        $('provinces').value,
        $('wards').value
      );
    } catch (e) {
      return log(e.message);
    }

    const phoneTypes = getActivePhoneTypes();
    if (!phoneTypes.current && !phoneTypes.hotline && !phoneTypes.old) {
      return log('Vui lòng tích chọn ít nhất một loại số điện thoại cần quét.');
    }

    state.settings = {
      keywords: $('queries').value,
      mode: $('areaMode').value,
      provinces: $('provinces').value,
      wards: $('wards').value,
      phoneTypes
    };

    if (state.job && !confirm('Thay thế lượt quét đang lưu bằng lượt mới? Dữ liệu kết quả đã quét vẫn được giữ nguyên.')) {
      return;
    }

    state.job = {
      queries,
      index: 0,
      links: null,
      cursor: 0,
      limit: Math.max(1, Math.min(500, Number($('limit').value) || 50)),
      delay: Math.max(3, Math.min(120, Number($('delay').value) || 5)),
      phoneTypes
    };

    // Chỉ mở window.open ở click khi CHƯA có Extension Sync V2 (tránh mở 2 tab Google Maps trùng nhau!)
    let openedHere = false;
    if (!mapsExtSupportsSyncV2) {
      const firstQ = queries[0] || 'Google Maps';
      const firstUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(firstQ) + '?hl=vi';
      try {
        if (!mapsTabWindow || mapsTabWindow.closed) {
          mapsTabWindow = window.open(firstUrl, 'ntd_maps_tab');
        } else {
          mapsTabWindow.location.href = firstUrl;
        }
        openedHere = true;
      } catch (_) {}
    }

    await saveState();
    runLoop({ tabAlreadyOpened: openedHere });
  };

  // Tiếp tục lượt đã lưu (Maps)
  $('resume').onclick = async () => {
    if (!state.job || !Array.isArray(state.job.queries) || !state.job.queries.length) {
      log('Không tìm thấy tiến trình nào đang lưu để tiếp tục.');
      return;
    }
    const currentQuery = state.job.queries[state.job.index] || state.job.queries[0];
    log(`Tiếp tục lượt đã lưu (${state.job.index + 1}/${state.job.queries.length}): ${currentQuery}`);
    mapsStop = false;
    running = true;
    renderUI();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'MAPS_RESUME_SCAN' });
      if (res && res.ok && !res.webFallback) {
        log('🚀 Tiến trình quét Google Maps đang tiếp tục chạy ngầm...');
        return;
      }
    } catch (_) {}
    log('⚡ Tiếp tục quét trực tiếp trên giao diện...');
    runMapsScraperDirectly();
  };

  // Dừng (Maps)
  $('stop').onclick = async () => {
    log('Đang gửi lệnh dừng quét Maps...');
    mapsStop = true;
    running = false;
    state.isScanning = false;
    await saveState();
    try {
      await chrome.runtime.sendMessage({ type: 'MAPS_STOP_SCAN' });
    } catch (_) {}
    renderUI();
  };

  // Xem tab Maps
  $('show').onclick = async () => {
    if (mapsTabId) {
      try {
        await chrome.tabs.update(mapsTabId, { active: true });
        return;
      } catch (_) {
        mapsTabId = null;
      }
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'MAPS_SHOW_TAB' });
      if (res && res.ok) return;
    } catch (_) {}

    const currentQ = state.job?.queries?.[state.job?.index || 0] || 'Google Maps';
    const mapsUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(currentQ) + '?hl=vi';
    if (!mapsTabWindow || mapsTabWindow.closed) {
      mapsTabWindow = window.open(mapsUrl, 'ntd_maps_tab');
    } else {
      try {
        mapsTabWindow.focus();
        mapsTabWindow.location.href = mapsUrl;
      } catch (_) {
        mapsTabWindow = window.open(mapsUrl, 'ntd_maps_tab');
      }
    }
    log('Đã mở tab Google Maps tìm kiếm: ' + currentQ);
  };

  // ── Sự kiện Chuyển đổi chế độ (Nút chọn Quét Maps vs Quét số nhóm) ────────
  $('modeBtnMaps')?.addEventListener('click', () => setMode('maps'));
  $('modeBtnGroup')?.addEventListener('click', () => setMode('group'));

  // Lắng nghe thay đổi loại số điện thoại cần quét của Nhóm Facebook
  ['groupPhoneTypeCurrent', 'groupPhoneTypeHotline', 'groupPhoneTypeOld'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      syncGroupPhoneTypeUI();
      if (!groupState.settings) groupState.settings = {};
      groupState.settings.phoneTypes = getActiveGroupPhoneTypes();
      chrome.storage.local.set({ rinFbGroup: groupState });
      renderUI();
    });
  });

  // Lắng nghe thay đổi phạm vi quét của Nhóm
  ['groupScanPosts', 'groupScanImages', 'groupScanComments'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      syncGroupPhoneTypeUI();
      if (!groupState.settings) groupState.settings = {};
      groupState.settings.options = {
        scanPosts: $('groupScanPosts') ? $('groupScanPosts').checked : true,
        scanImages: $('groupScanImages') ? $('groupScanImages').checked : true,
        scanComments: $('groupScanComments') ? $('groupScanComments').checked : true
      };
      chrome.storage.local.set({ rinFbGroup: groupState });
    });
  });

  $('groupPasteImportBtn')?.addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {}
    if (!text) {
      text = prompt('Dán toàn bộ nội dung vừa copy từ tab Nhóm Facebook (Ctrl+A -> Ctrl+C) vào đây:') || '';
    }
    if (text) {
      await importGroupPhonesFromClipboardText(text);
    }
  });

  $('groupRecheckExtBtn')?.addEventListener('click', async () => {
    const st = await chrome.runtime.sendMessage({ type: 'FB_GROUP_GET_STATUS' }).catch(() => null);
    mapsExtSupportsSyncV2 = Boolean(st?.ok && Number(st?.syncVersion) >= 2);
    if (mapsExtSupportsSyncV2) {
      hideMapsWebNotice();
      hideGroupWebNotice();
      log('✅ Đã kết nối Extension NTD Agency bản mới (FB_GROUP_SYNC_V2)! Bấm "Bắt đầu quét số nhóm" để tự động đọc bài viết & cào SĐT.');
    } else {
      const outdated = Boolean(st?.extensionOutdated || document.documentElement.dataset.ntdExtensionConnected === 'true');
      showGroupWebNotice(outdated);
      log(outdated
        ? '⚠️ Extension vẫn chưa nạp bản mới. Hãy mở chrome://extensions và bấm ↻ Tải lại NTD Agency.'
        : '⚠️ Chưa phát hiện Extension NTD Agency đang bật.');
    }
  });

  // Bắt đầu quét số nhóm Facebook
  $('startGroup')?.addEventListener('click', async () => {
    const rawUrl = ($('groupUrl')?.value || '').trim();
    if (!rawUrl) {
      return log('Vui lòng nhập ít nhất một đường link nhóm Facebook cần quét.');
    }

    const phoneTypes = getActiveGroupPhoneTypes();
    if (!phoneTypes.current && !phoneTypes.hotline && !phoneTypes.old) {
      return log('Vui lòng tích chọn ít nhất một loại số điện thoại cần quét.');
    }

    const firstRawUrl = rawUrl.split(/[\r\n,]+/)[0] || rawUrl;
    let initialFbUrl = firstRawUrl.trim();
    if (!initialFbUrl.startsWith('http')) initialFbUrl = 'https://' + initialFbUrl;
    if (!initialFbUrl.includes('sorting_setting=')) {
      initialFbUrl += (initialFbUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL';
    }

    // Chỉ mở window.open ở click khi CHƯA có Extension Sync V2 (tránh mở 2 tab Facebook trùng nhau)
    let openedHere = false;
    if (!mapsExtSupportsSyncV2) {
      try {
        if (!fbGroupTabWindow || fbGroupTabWindow.closed) {
          fbGroupTabWindow = window.open(initialFbUrl, 'ntd_fb_group_tab');
        } else {
          fbGroupTabWindow.location.href = initialFbUrl;
          fbGroupTabWindow.focus();
        }
        openedHere = true;
      } catch (_) {}
    }

    const maxPosts = Math.max(5, Math.min(5000, Number($('groupMaxPosts')?.value) || 500));
    const scrollDelay = Math.max(2, Math.min(30, Number($('groupScrollDelay')?.value) || 3));
    const options = {
      scanPosts: $('groupScanPosts') ? $('groupScanPosts').checked : true,
      scanImages: $('groupScanImages') ? $('groupScanImages').checked : true,
      scanComments: $('groupScanComments') ? $('groupScanComments').checked : true
    };

    groupState.totalPostsOffset = 0;
    groupState.postsCount = 0;
    groupState.settings = {
      groupUrl: rawUrl,
      maxPosts,
      scrollDelay,
      phoneTypes,
      options
    };

    groupState.job = {
      groupUrl: rawUrl,
      groupIndex: 0,
      maxPosts,
      scrollDelay,
      phoneTypes,
      options
    };
    groupState.isScanning = true;

    await chrome.storage.local.set({ rinFbGroup: groupState });

    groupRunning = true;
    groupStop = false;
    renderUI();
    let extensionOutdated = false;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'FB_GROUP_START_SCAN',
        job: groupState.job,
        phoneTypes,
        seenKeys: groupState.seenKeys || {}
      });
      if (res && res.ok && !res.webFallback) {
        mapsExtSupportsSyncV2 = true;
        hideGroupWebNotice();
        log('🚀 Tiến trình quét số nhóm Facebook đã được khởi động qua Extension (tự đọc DOM bài viết, ảnh & bình luận)...');
        return;
      }
      extensionOutdated = Boolean(res?.extensionOutdated);
    } catch (err) {}
    log('⚡ Chuyển sang hướng dẫn Web / Clipboard trực tiếp...');
    runGroupScraperDirectly({ skipInitialTabOpen: openedHere, extensionOutdated });
  });

  // Tiếp tục lượt quét nhóm đã lưu
  $('resumeGroup')?.addEventListener('click', async () => {
    if (!groupState.job || !groupState.job.groupUrl) {
      log('Không tìm thấy tiến trình quét nhóm nào đang lưu để tiếp tục.');
      return;
    }

    const currentRawUrl = String(groupState.job.groupUrl).split(/[\r\n,]+/)[groupState.job.groupIndex || 0] || groupState.job.groupUrl;
    let resumeFbUrl = currentRawUrl.trim();
    if (!resumeFbUrl.startsWith('http')) resumeFbUrl = 'https://' + resumeFbUrl;

    let openedHere = false;
    if (!mapsExtSupportsSyncV2) {
      try {
        if (!fbGroupTabWindow || fbGroupTabWindow.closed) {
          fbGroupTabWindow = window.open(resumeFbUrl, 'ntd_fb_group_tab');
        } else {
          fbGroupTabWindow.focus();
        }
        openedHere = true;
      } catch (_) {}
    }

    log(`Tiếp tục lượt quét nhóm đã lưu: ${currentRawUrl}`);
    groupState.isScanning = true;
    await chrome.storage.local.set({ rinFbGroup: groupState });
    groupRunning = true;
    groupStop = false;
    renderUI();
    let extensionOutdated = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'FB_GROUP_RESUME_SCAN' });
      if (res && res.ok && !res.webFallback) {
        mapsExtSupportsSyncV2 = true;
        hideGroupWebNotice();
        log('🚀 Tiến trình quét nhóm đang tiếp tục chạy ngầm qua Extension...');
        return;
      }
      extensionOutdated = Boolean(res?.extensionOutdated);
    } catch (err) {}
    runGroupScraperDirectly({ skipInitialTabOpen: openedHere, extensionOutdated });
  });

  // Dừng quét nhóm
  $('stopGroup')?.addEventListener('click', async () => {
    log('Đang dừng quét nhóm...');
    groupStop = true;
    groupRunning = false;
    groupState.isScanning = false;
    await chrome.storage.local.set({ rinFbGroup: groupState });
    try {
      await chrome.runtime.sendMessage({ type: 'FB_GROUP_STOP_SCAN' });
    } catch (_) {}
    renderUI();
  });

  // Xem tab Facebook nhóm
  $('showGroupTab')?.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'FB_GROUP_SHOW_TAB' });
      if (res && res.ok) return;
    } catch (_) {}

    const rawUrl = ($('groupUrl')?.value || groupState.job?.groupUrl || 'https://www.facebook.com/groups/').trim();
    let firstUrl = rawUrl.split(/[\r\n,]+/)[0] || 'https://www.facebook.com';
    if (!firstUrl.startsWith('http')) firstUrl = 'https://' + firstUrl;

    try {
      if (!fbGroupTabWindow || fbGroupTabWindow.closed) {
        fbGroupTabWindow = window.open(firstUrl, 'ntd_fb_group_tab');
      } else {
        fbGroupTabWindow.focus();
      }
      log('Đã mở / chuyển đến tab Facebook nhóm: ' + firstUrl);
    } catch (e) {
      try {
        const a = document.createElement('a');
        a.href = firstUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        log('Đã mở tab Facebook nhóm: ' + firstUrl);
      } catch (err) {
        log('Không thể mở tab Facebook: ' + err.message);
      }
    }

    if (groupState.tabId) {
      try {
        await chrome.tabs.update(groupState.tabId, { active: true });
        return;
      } catch (_) {
        groupState.tabId = null;
      }
    }
    try {
      await chrome.runtime.sendMessage({ type: 'FB_GROUP_SHOW_TAB' });
    } catch (_) {}
  });

  // Xuất file Excel (.xlsx) đầy đủ
  $('csv').onclick = () => {
    if (activeMode === 'maps') {
      const rows = filterMapsExportableRows();
      if (!rows.length) return log('Chưa có dữ liệu phù hợp để xuất.');

      const keys = ['name', 'phone', 'address', 'website', 'query', 'url', 'at'];
      const header = ['Tên cơ sở', 'Số điện thoại', 'Địa chỉ', 'Website', 'Từ khóa', 'Google Maps', 'Ngày quét'];

      const filename = `NTD-Maps-${new Date().toISOString().slice(0, 10)}.xlsx`;
      downloadXlsx(filename, [header, ...rows.map(r => keys.map(k => r[k] || ''))]);
      log(`Đã xuất ${rows.length} cơ sở Maps ra Excel.`);
    } else {
      const rows = filterGroupExportableRows();
      if (!rows.length) return log('Chưa có dữ liệu số điện thoại từ nhóm để xuất.');

      const keys = ['name', 'phone', 'source', 'context', 'groupName', 'postUrl', 'at'];
      const header = ['Người đăng / Tác giả', 'Số điện thoại', 'Nguồn tìm thấy', 'Trích đoạn nội dung', 'Tên nhóm Facebook', 'Link bài viết Facebook', 'Thời gian quét'];

      const filename = `NTD-Nhom-SDT-${new Date().toISOString().slice(0, 10)}.xlsx`;
      downloadXlsx(filename, [header, ...rows.map(r => keys.map(k => r[k] || ''))]);
      log(`Đã xuất ${rows.length} số điện thoại từ nhóm Facebook ra file Excel (.xlsx).`);
    }
  };

  // Xuất riêng file SĐT (.xlsx)
  $('phones').onclick = () => {
    const rows = filterExportableRows();
    const phones = [...new Set(rows.map(r => r.phone).filter(Boolean))];
    if (!phones.length) return log('Chưa có số điện thoại phù hợp để xuất.');

    const prefix = activeMode === 'maps' ? 'NTD-Maps-SDT' : 'NTD-Nhom-SDT';
    downloadXlsx(`${prefix}-${new Date().toISOString().slice(0, 10)}.xlsx`, phones.map(p => [p]));
    log(`Đã xuất ${phones.length} số điện thoại duy nhất, bảo toàn số 0 ở đầu.`);
  };

  // Sao lưu JSON
  $('backup').onclick = () => {
    const dataToSave = activeMode === 'maps' ? state : groupState;
    const blob = new Blob([JSON.stringify(dataToSave, null, 2)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    const prefix = activeMode === 'maps' ? 'NTD-Maps-backup' : 'NTD-Nhom-backup';
    a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  };

  // Xóa dữ liệu báo cáo
  $('clear').onclick = async () => {
    if (activeMode === 'maps') {
      const hasJob = state.job && Array.isArray(state.job.queries) && state.job.index < state.job.queries.length;
      const confirmMsg = hasJob
        ? 'Xóa toàn bộ dữ liệu đã hiển thị trong bảng báo cáo Maps?\n\n✔ Tiến trình chiến dịch (' + state.job.index + '/' + state.job.queries.length + ' từ khóa) vẫn được giữ nguyên để bạn có thể tiếp tục.\n⚠ Số điện thoại đã quét vẫn được ghi nhớ để không quét trùng lại.'
        : 'Xóa toàn bộ dữ liệu hiển thị trong bảng báo cáo Maps? Tiến trình quét cũng sẽ bị xóa.';

      if (confirm(confirmMsg)) {
        state.rows = [];
        if (hasJob) {
          await saveState();
          chrome.runtime.sendMessage({ type: 'MAPS_CLEAR_DATA', keepJob: true, keepSeenKeys: true }).catch(() => {});
          renderUI();
          log('Đã xóa dữ liệu báo cáo Maps. Tiến trình đã được lưu lại, bạn có thể bấm Tiếp tục bất cứ lúc nào.');
        } else {
          state.job = null;
          state.seenKeys = {};
          await saveState();
          chrome.runtime.sendMessage({ type: 'MAPS_CLEAR_DATA', keepJob: false, keepSeenKeys: false }).catch(() => {});
          renderUI();
          log('Đã xóa toàn bộ dữ liệu Maps.');
        }
      }
    } else {
      if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ dữ liệu số điện thoại đã quét từ nhóm Facebook?')) {
        return;
      }
      groupState.rows = [];
      groupState.seenKeys = {};
      groupState.postsCount = 0;
      groupState.commentsCount = 0;
      await chrome.storage.local.set({ rinFbGroup: groupState });
      chrome.runtime.sendMessage({ type: 'FB_GROUP_CLEAR_DATA' }).catch(() => {});
      renderUI();
      log('Đã xóa toàn bộ dữ liệu số điện thoại quét từ nhóm Facebook.');
    }
  };
}

// ── Khởi tạo ứng dụng ────────────────────────────────────────────────────────
(async () => {
  setupEventListeners();

  try {
    const store = await chrome.storage.local.get(['rinMaps', 'rinFbGroup', 'mapsActiveMode']);
    if (store.rinMaps) {
      state = store.rinMaps;
    }
    if (store.rinFbGroup) {
      groupState = store.rinFbGroup;
    }

    // Khôi phục Maps config
    if (state.settings) {
      if ($('queries')) $('queries').value = state.settings.keywords || '';
      if ($('areaMode')) $('areaMode').value = state.settings.mode || 'province';
      if ($('provinces')) $('provinces').value = state.settings.provinces || '';
      if ($('wards')) $('wards').value = state.settings.wards || '';
      restoreGeoPickers(state.settings.provinces, state.settings.wards);

      if (state.settings.phoneTypes) {
        if ($('phoneTypeCurrent')) $('phoneTypeCurrent').checked = Boolean(state.settings.phoneTypes.current);
        if ($('phoneTypeHotline')) $('phoneTypeHotline').checked = Boolean(state.settings.phoneTypes.hotline);
        if ($('phoneTypeOld')) $('phoneTypeOld').checked = Boolean(state.settings.phoneTypes.old);
        if ($('customPhonePrefixes') && Array.isArray(state.settings.phoneTypes.customPrefixes)) {
          $('customPhonePrefixes').value = state.settings.phoneTypes.customPrefixes.join(', ');
        }
      }
    } else {
      restoreGeoPickers('', '');
    }
    syncPhoneTypeUI();

    if (state.job && Array.isArray(state.job.queries) && state.job.index < state.job.queries.length) {
      if (!state.settings && state.job.queries && $('queries')) {
        $('queries').value = state.job.queries.join('\n');
        if ($('areaMode')) $('areaMode').value = 'custom';
      }
      if ($('limit')) $('limit').value = state.job.limit || 50;
      if ($('delay')) $('delay').value = state.job.delay || 5;
    }

    // Khôi phục Group config
    if (groupState.settings) {
      if ($('groupUrl') && groupState.settings.groupUrl) $('groupUrl').value = groupState.settings.groupUrl;
      if ($('groupMaxPosts') && groupState.settings.maxPosts) $('groupMaxPosts').value = groupState.settings.maxPosts;
      if ($('groupScrollDelay') && groupState.settings.scrollDelay) $('groupScrollDelay').value = groupState.settings.scrollDelay;

      if (groupState.settings.phoneTypes) {
        if ($('groupPhoneTypeCurrent')) $('groupPhoneTypeCurrent').checked = Boolean(groupState.settings.phoneTypes.current);
        if ($('groupPhoneTypeHotline')) $('groupPhoneTypeHotline').checked = Boolean(groupState.settings.phoneTypes.hotline);
        if ($('groupPhoneTypeOld')) $('groupPhoneTypeOld').checked = Boolean(groupState.settings.phoneTypes.old);
        if ($('groupCustomPhonePrefixes') && Array.isArray(groupState.settings.phoneTypes.customPrefixes)) {
          $('groupCustomPhonePrefixes').value = groupState.settings.phoneTypes.customPrefixes.join(', ');
        }
      }

      if (groupState.settings.options) {
        if ($('groupScanPosts')) $('groupScanPosts').checked = groupState.settings.options.scanPosts !== false;
        if ($('groupScanImages')) $('groupScanImages').checked = groupState.settings.options.scanImages !== false;
        if ($('groupScanComments')) $('groupScanComments').checked = groupState.settings.options.scanComments !== false;
      }
    }
    syncGroupPhoneTypeUI();

    // Kiểm tra trạng thái đang chạy ngầm Maps & khả năng MAPS_SYNC_V2 của Extension
    const mapsStatus = await chrome.runtime.sendMessage({ type: 'MAPS_GET_STATUS', includeAllRows: true }).catch(() => null);
    mapsExtSupportsSyncV2 = Boolean(mapsStatus?.ok && Number(mapsStatus?.syncVersion) >= 2);
    if (Array.isArray(mapsStatus?.state?.recentRows) && mapsStatus.state.recentRows.length) {
      mapsStatus.state.recentRows.forEach(r => addRow(r, { forceIfNotInRows: true }));
      if (mapsStatus.state.job !== undefined && mapsStatus.running) {
        state.job = mapsStatus.state.job;
      }
      await saveState();
    }
    running = Boolean(mapsStatus?.running);
    if (!running && state.isScanning) {
      state.isScanning = false;
      await saveState();
    }
    if (!mapsExtSupportsSyncV2) {
      const outdated = Boolean(mapsStatus?.extensionOutdated || document.documentElement.dataset.ntdExtensionConnected === 'true');
      showMapsWebNotice(outdated);
    }

    // Kiểm tra trạng thái đang chạy ngầm Group
    const groupStatus = await chrome.runtime.sendMessage({ type: 'FB_GROUP_GET_STATUS' }).catch(() => null);
    if (Number(groupStatus?.syncVersion) >= 2) {
      mapsExtSupportsSyncV2 = true;
    }
    if (Array.isArray(groupStatus?.state?.recentRows) && groupStatus.state.recentRows.length) {
      if (!groupState.seenKeys) groupState.seenKeys = {};
      if (!Array.isArray(groupState.rows)) groupState.rows = [];
      for (const r of groupStatus.state.recentRows) {
        const k = normPhone(r.phone) || r.phone;
        if (k && !groupState.seenKeys[k]) {
          groupState.seenKeys[k] = true;
          groupState.rows.push(r);
        }
      }
      if (typeof groupStatus.state.postsCount === 'number' && groupStatus.running) {
        groupState.postsCount = groupStatus.state.postsCount;
      }
      if (typeof groupStatus.state.commentsCount === 'number' && groupStatus.running) {
        groupState.commentsCount = groupStatus.state.commentsCount;
      }
      await chrome.storage.local.set({ rinFbGroup: groupState });
    }
    groupRunning = Boolean(groupStatus?.running);
    if (!groupRunning && groupState.isScanning) {
      groupState.isScanning = false;
      await chrome.storage.local.set({ rinFbGroup: groupState });
    }
    if (!mapsExtSupportsSyncV2) {
      const outdatedGroup = Boolean(groupStatus?.extensionOutdated || mapsStatus?.extensionOutdated || document.documentElement.dataset.ntdExtensionConnected === 'true');
      showGroupWebNotice(outdatedGroup);
    }

    // Khôi phục chế độ đã chọn trước đó
    setMode(store.mapsActiveMode || 'maps');

    if (running) {
      log('⚡ Tiến trình quét Google Maps đang chạy ngầm trong hệ thống.');
    }
    if (groupRunning) {
      log('⚡ Tiến trình quét số nhóm Facebook đang chạy ngầm trong hệ thống.');
    }

    updateQueryPreview();
    renderUI();
  } catch (e) {
    log('Lỗi khi đọc bộ nhớ: ' + e.message);
  }
})();

window.addEventListener('NTD_EXTENSION_READY', async () => {
  const st = await chrome.runtime.sendMessage({ type: 'MAPS_GET_STATUS' }).catch(() => null);
  mapsExtSupportsSyncV2 = Boolean(st?.ok && Number(st?.syncVersion) >= 2);
  if (mapsExtSupportsSyncV2) {
    hideMapsWebNotice();
    hideGroupWebNotice();
  } else if (st?.extensionOutdated || document.documentElement.dataset.ntdExtensionConnected === 'true') {
    showMapsWebNotice(true);
    showGroupWebNotice(true);
  }
});

// Lắng nghe dữ liệu mới tự động cập nhật từ Background Worker (Debounced 150ms)
let _mapsRenderDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.rinMaps) {
      const newVal = changes.rinMaps.newValue;
      if (newVal) {
        state = newVal;
        running = Boolean(state.isScanning);
      }
    }
    if (changes.rinFbGroup) {
      const newVal = changes.rinFbGroup.newValue;
      if (newVal) {
        groupState = newVal;
        groupRunning = Boolean(groupState.isScanning);
      }
    }
    if (_mapsRenderDebounce) clearTimeout(_mapsRenderDebounce);
    _mapsRenderDebounce = setTimeout(renderUI, 150);
  }
});

// Lắng nghe nhật ký & kết quả thời gian thực từ tiến trình nền (Extension <-> Web Sync)
let _lastMapsBackfillAt = 0;
async function syncMissingMapsRowsIfNeeded(expectedTotal) {
  if (typeof expectedTotal !== 'number' || expectedTotal <= state.rows.length) return;
  const now = Date.now();
  if (now - _lastMapsBackfillAt < 2000) return;
  _lastMapsBackfillAt = now;
  try {
    const st = await chrome.runtime.sendMessage({ type: 'MAPS_GET_STATUS', includeAllRows: true }).catch(() => null);
    if (Array.isArray(st?.state?.recentRows) && st.state.recentRows.length) {
      let changed = false;
      for (const r of st.state.recentRows) {
        if (addRow(r, { forceIfNotInRows: true })) changed = true;
      }
      if (changed) {
        await saveState();
        renderUI();
      }
    }
  } catch (_) {}
}

chrome.runtime.onMessage.addListener(m => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'MAPS_LOG_EVENT' && m.msg) {
    log(m.msg);
  }
  if (m.type === 'MAPS_ROW_ADDED' && m.row) {
    addRow(m.row, { forceIfNotInRows: true });
    saveState();
    renderUI();
  }
  if (m.type === 'MAPS_STATE_SYNC') {
    if ('job' in m) state.job = m.job;
    if (typeof m.isScanning === 'boolean') {
      state.isScanning = m.isScanning;
      running = m.isScanning;
    }
    if (m.lastScraped) state.lastScraped = m.lastScraped;
    if (Array.isArray(m.recentRows) && m.recentRows.length) {
      for (const r of m.recentRows) {
        addRow(r, { forceIfNotInRows: true });
      }
    }
    saveState();
    renderUI();
    if (typeof m.totalRows === 'number' && m.totalRows > state.rows.length) {
      syncMissingMapsRowsIfNeeded(m.totalRows);
    }
  }
  if (m.type === 'FB_GROUP_LOG_EVENT' && m.msg) {
    log(m.msg);
  }
  if (m.type === 'FB_GROUP_ROW_ADDED' && m.row) {
    if (!groupState.seenKeys) groupState.seenKeys = {};
    if (!Array.isArray(groupState.rows)) groupState.rows = [];
    const k = normPhone(m.row.phone) || m.row.phone;
    if (k && !groupState.seenKeys[k]) {
      groupState.seenKeys[k] = true;
      groupState.rows.push(m.row);
      chrome.storage.local.set({ rinFbGroup: groupState });
      renderUI();
    }
  }
  if (m.type === 'FB_GROUP_STATE_SYNC') {
    if ('postsCount' in m) groupState.postsCount = m.postsCount;
    if ('commentsCount' in m) groupState.commentsCount = m.commentsCount;
    if ('job' in m) groupState.job = m.job;
    if (typeof m.isScanning === 'boolean') {
      groupState.isScanning = m.isScanning;
      groupRunning = m.isScanning;
    }
    chrome.storage.local.set({ rinFbGroup: groupState });
    renderUI();
  }
});
