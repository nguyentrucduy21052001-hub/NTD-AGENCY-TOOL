// groups.js – Quản lý kho nhóm và phân loại danh mục nhóm
import { enforceLicenseGate } from './license.js';
import { getGroupKey, getAllPostedGroupKeys } from './core.js';
import {
  extractCanonicalGroupKey,
  normalizeGroupName,
  parseMemberCount,
  extractGroupsFromClipboardPayload,
  filterAndPrepareImportedGroups
} from './group_parser.js?v=20261110_1505';
await enforceLicenseGate();

const $ = id => document.getElementById(id);

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(text, duration = 3000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(el.__timer);
  el.__timer = setTimeout(() => { el.style.display = 'none'; }, duration);
}

// ── Group URL Normalization & Validation ──────────────────────────────────────
function normalizeGroupUrl(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (!['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)/);
    if (!m || ['feed', 'discover', 'joins', 'create', 'search'].includes(m[1])) return null;
    return `https://www.facebook.com/groups/${m[1]}/`;
  } catch (_) {
    return null;
  }
}

function processGroupList(rawText) {
  const lines = rawText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const line of lines) {
    const norm = normalizeGroupUrl(line);
    if (norm) {
      if (!seen.has(norm)) {
        seen.add(norm);
        valid.push(norm);
      }
    } else {
      invalid.push(line);
    }
  }

  return { valid, invalid, total: lines.length };
}

// ── Storage Helpers ───────────────────────────────────────────────────────────
async function loadCategories() {
  const { groupCategories } = await chrome.storage.local.get('groupCategories');
  return groupCategories || [];
}

async function saveCategories(categories) {
  await chrome.storage.local.set({ groupCategories: categories });
}

// ── Render Statistics ─────────────────────────────────────────────────────────
function updateStats(categories) {
  $('totalCats').textContent = categories.length;
  
  let totalLinks = 0;
  const uniqueSet = new Set();

  for (const cat of categories) {
    const links = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    totalLinks += links.length;
    for (const l of links) uniqueSet.add(l);
  }

  $('totalGroups').textContent = totalLinks;
  $('uniqueGroups').textContent = uniqueSet.size;
  $('catCountDisplay').textContent = `${categories.length} danh mục`;
}

// ── Render Category List ──────────────────────────────────────────────────────
function renderCategories(categories, filterKeyword = '') {
  updateStats(categories);

  const listEl = $('catList');
  const kw = filterKeyword.trim().toLowerCase();
  const filtered = kw ? categories.filter(c => c.name.toLowerCase().includes(kw)) : categories;

  if (!filtered.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>${kw ? `Không tìm thấy danh mục nào khớp với "${filterKeyword}".` : 'Chưa có danh mục nào. Hãy tạo danh mục đầu tiên ở bên trái!'}</p>
      </div>`;
    return;
  }

  listEl.replaceChildren();

  for (const cat of filtered) {
    const links = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const dateStr = cat.updatedAt ? new Date(cat.updatedAt).toLocaleDateString('vi-VN') : 'Mới';

    const item = document.createElement('div');
    item.className = 'cat-item';
    item.dataset.id = cat.id;

    item.innerHTML = `
      <div class="cat-header">
        <div class="cat-title-row">
          <span class="cat-name">${escapeHtml(cat.name)}</span>
          <span class="cat-badge">${links.length} nhóm</span>
        </div>
        <span class="cat-date">Cập nhật: ${dateStr}</span>
      </div>

      <div class="cat-actions">
        <button type="button" class="act-btn btn-rename" data-id="${cat.id}">Đổi tên</button>
        <button type="button" class="act-btn btn-edit-links" data-id="${cat.id}">Cập nhật nhóm</button>
        <button type="button" class="act-btn btn-copy" data-id="${cat.id}">Copy link</button>
        <button type="button" class="act-btn btn-filter-posted" data-id="${cat.id}" style="color:#2563eb;border-color:#93c5fd" title="Tự động lọc bỏ các nhóm đã đăng trong báo cáo/lịch sử, chỉ giữ lại các nhóm còn lại chưa đăng">Lọc nhóm đã đăng</button>
        <button type="button" class="act-btn primary btn-use" data-id="${cat.id}">Nạp vào Đăng bài</button>
        <button type="button" class="act-btn danger btn-delete" data-id="${cat.id}">Xóa</button>
      </div>

      <!-- Inline Rename Form -->
      <div class="inline-editor inline-rename-box" id="renameBox_${cat.id}">
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Tên danh mục mới:</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" class="form-input rename-input" value="${escapeHtml(cat.name)}" style="flex:1;padding:7px 10px;font-size:13px">
          <button type="button" class="chip-btn save-rename-btn" data-id="${cat.id}" style="background:#10b981;color:#fff;border-color:#059669;padding:7px 14px">Lưu tên</button>
          <button type="button" class="chip-btn cancel-rename-btn" data-id="${cat.id}" style="padding:7px 12px">Hủy</button>
        </div>
      </div>

      <!-- Inline Edit Links Form -->
      <div class="inline-editor inline-links-box" id="linksBox_${cat.id}">
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Cập nhật danh sách link Facebook Group:</label>
        <textarea class="form-textarea edit-links-textarea" rows="6" style="margin-top:2px">${escapeHtml(cat.links || '')}</textarea>
        <div class="textarea-meta">
          <span class="edit-links-count">${links.length} nhóm</span>
          <div style="display:flex;gap:6px">
            <button type="button" class="chip-btn dedupe-edit-btn" data-id="${cat.id}">Lọc trùng</button>
            <button type="button" class="chip-btn save-links-btn" data-id="${cat.id}" style="background:#ed6b22;color:#fff;border-color:#d95a14;padding:6px 14px">Lưu link</button>
            <button type="button" class="chip-btn close-links-btn" data-id="${cat.id}" style="padding:6px 10px">Đóng</button>
          </div>
        </div>
      </div>

      <!-- Preview first few links -->
      <div class="cat-preview">${links.length ? links.slice(0, 15).join('\n') + (links.length > 15 ? `\n... và ${links.length - 15} nhóm khác` : '') : '(Danh mục trống, chưa có link)'}</div>
    `;

    listEl.appendChild(item);
  }

  attachCardEvents(categories);
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Card Event Listeners ──────────────────────────────────────────────────────
function attachCardEvents(categories) {
  // 1. Rename toggle & save
  document.querySelectorAll('.btn-rename').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`renameBox_${id}`);
      if (!box) return;
      box.classList.toggle('open');
      if (box.classList.contains('open')) {
        const inp = box.querySelector('.rename-input');
        if (inp) { inp.focus(); inp.select(); }
      }
    };
  });

  document.querySelectorAll('.cancel-rename-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`renameBox_${id}`);
      if (box) box.classList.remove('open');
    };
  });

  document.querySelectorAll('.save-rename-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const box = $(`renameBox_${id}`);
      const newName = box?.querySelector('.rename-input')?.value.trim();
      if (!newName) {
        alert('Tên danh mục không được để trống.');
        return;
      }

      const all = await loadCategories();
      const cat = all.find(c => c.id === id);
      if (cat) {
        cat.name = newName;
        cat.updatedAt = Date.now();
        await saveCategories(all);
        showToast(`✅ Đã đổi tên thành: "${newName}"`);
        renderCategories(all, $('searchCat').value);
      }
    };
  });

  // 2. Edit Links toggle & save
  document.querySelectorAll('.btn-edit-links').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`linksBox_${id}`);
      if (!box) return;
      box.classList.toggle('open');
    };
  });

  document.querySelectorAll('.close-links-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`linksBox_${id}`);
      if (box) box.classList.remove('open');
    };
  });

  document.querySelectorAll('.dedupe-edit-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`linksBox_${id}`);
      const ta = box?.querySelector('.edit-links-textarea');
      if (!ta) return;
      const res = processGroupList(ta.value);
      ta.value = res.valid.join('\n');
      const countEl = box.querySelector('.edit-links-count');
      if (countEl) countEl.textContent = `${res.valid.length} nhóm hợp lệ (đã lọc)`;
      showToast(`🧹 Đã lọc: còn ${res.valid.length} nhóm duy nhất.`);
    };
  });

  document.querySelectorAll('.save-links-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const box = $(`linksBox_${id}`);
      const ta = box?.querySelector('.edit-links-textarea');
      if (!ta) return;

      const res = processGroupList(ta.value);
      const all = await loadCategories();
      const cat = all.find(c => c.id === id);
      if (cat) {
        cat.links = res.valid.join('\n');
        cat.updatedAt = Date.now();
        await saveCategories(all);
        showToast(`✅ Đã cập nhật ${res.valid.length} nhóm cho "${cat.name}".`);
        renderCategories(all, $('searchCat').value);
      }
    };
  });

  // 3. Copy links to clipboard
  document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const cat = categories.find(c => c.id === id);
      if (!cat || !cat.links?.trim()) {
        alert('Danh mục này chưa có link nhóm nào.');
        return;
      }
      try {
        await navigator.clipboard.writeText(cat.links);
        const count = cat.links.split(/\r?\n/).filter(Boolean).length;
        showToast(`📋 Đã sao chép ${count} link nhóm vào clipboard!`);
      } catch (_) {
        alert('Không thể sao chép tự động. Hãy mở phần cập nhật nhóm để copy thủ công.');
      }
    };
  });

  // 3b. Lọc bỏ nhóm đã đăng trong báo cáo / lịch sử khỏi danh mục
  document.querySelectorAll('.btn-filter-posted').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const all = await loadCategories();
      const cat = all.find(c => c.id === id);
      if (!cat || !cat.links?.trim()) {
        alert('Danh mục này chưa có link nhóm nào.');
        return;
      }

      const lines = cat.links.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const postedKeys = await getAllPostedGroupKeys();
      if (!postedKeys.size) {
        alert('Chưa ghi nhận nhóm nào đã đăng trong Báo cáo kết quả hoặc Lịch sử đăng.');
        return;
      }

      const posted = [];
      const remaining = [];
      const seen = new Set();
      for (const line of lines) {
        const k = getGroupKey(line);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        if (postedKeys.has(k)) {
          posted.push(line);
        } else {
          remaining.push(line);
        }
      }

      if (!posted.length) {
        alert(`✅ Toàn bộ ${lines.length} nhóm trong danh mục "${cat.name}" đều CHƯA ĐĂNG (không trùng nhóm nào trong báo cáo/lịch sử)!`);
        return;
      }

      if (!remaining.length) {
        alert(`⚠️ Toàn bộ ${lines.length} nhóm trong danh mục "${cat.name}" ĐÃ ĐƯỢC ĐĂNG HẾT!\nKhông còn nhóm nào chưa đăng.`);
        return;
      }

      const confirmMsg = `Danh mục "${cat.name}" có ${posted.length} nhóm ĐÃ ĐĂNG trong tổng số ${lines.length} nhóm.\n\n` +
        `👉 Bấm [OK] để TỰ ĐỘNG LỌC BỎ ${posted.length} nhóm đã đăng, chỉ giữ lại ${remaining.length} nhóm CHƯA ĐĂNG để tiếp tục chạy ngày hôm nay.\n` +
        `👉 Bấm [Cancel] nếu muốn giữ nguyên danh mục.`;

      if (!confirm(confirmMsg)) return;

      cat.links = remaining.join('\n');
      cat.updatedAt = Date.now();
      await saveCategories(all);
      showToast(`🎉 Đã lọc bỏ ${posted.length} nhóm đã đăng! Còn ${remaining.length} nhóm.`);
      renderCategories(all, $('searchCat').value);
    };
  });

  // 4. Use category directly in panel.html
  document.querySelectorAll('.btn-use').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const cat = categories.find(c => c.id === id);
      if (!cat) return;

      // Update draft.links with this category's groups
      const { draft } = await chrome.storage.local.get('draft');
      const updatedDraft = { ...(draft || {}), links: cat.links };
      await chrome.storage.local.set({
        draft: updatedDraft,
        lastSelectedCategory: cat.id
      });

      showToast(`🚀 Đã nạp "${cat.name}". Đang mở Bảng đăng bài...`);
      setTimeout(() => {
        if (isScanning) {
          chrome.tabs.create({ url: chrome.runtime.getURL('panel.html'), active: true });
        } else {
          window.location.href = chrome.runtime.getURL('panel.html');
        }
      }, 600);
    };
  });

  // 5. Delete category
  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const cat = categories.find(c => c.id === id);
      if (!cat) return;

      if (!confirm(`Xóa danh mục "${cat.name}"?\nCác link nhóm trong mục này sẽ bị xóa khỏi kho.`)) return;

      const all = await loadCategories();
      const updated = all.filter(c => c.id !== id);
      await saveCategories(updated);
      showToast(`🗑️ Đã xóa danh mục "${cat.name}".`);
      renderCategories(updated, $('searchCat').value);
    };
  });
}

// ── New Category Form Logic ───────────────────────────────────────────────────
$('newCatLinks')?.addEventListener('input', () => {
  const raw = $('newCatLinks').value;
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  $('newCatCount').textContent = `${lines.length} link`;

  const validCount = lines.filter(l => normalizeGroupUrl(l)).length;
  $('newCatValidCount').textContent = validCount > 0 ? `(${validCount} link Facebook hợp lệ)` : '';
});

// Clean duplicate button
$('cleanNewLinksBtn')?.addEventListener('click', () => {
  const raw = $('newCatLinks').value;
  if (!raw.trim()) {
    showToast('Hãy nhập link trước khi lọc.');
    return;
  }
  const res = processGroupList(raw);
  $('newCatLinks').value = res.valid.join('\n');
  $('newCatCount').textContent = `${res.valid.length} link`;
  $('newCatValidCount').textContent = `(Tất cả ${res.valid.length} link đều hợp lệ & không trùng)`;
  showToast(`🧹 Đã lọc xong: ${res.valid.length} nhóm duy nhất.`);
});

// Paste from shared groups in panel
$('pasteFromSharedBtn')?.addEventListener('click', async () => {
  const { draft } = await chrome.storage.local.get('draft');
  if (draft?.links?.trim()) {
    $('newCatLinks').value = draft.links.trim();
    $('newCatLinks').dispatchEvent(new Event('input'));
    showToast('📋 Đã nạp danh sách link từ Bảng đăng bài.');
  } else {
    alert('Bảng đăng bài hiện chưa có danh sách nhóm dùng chung.');
  }
});

// Save new category button
$('saveNewCatBtn')?.addEventListener('click', async () => {
  const name = $('newCatName').value.trim();
  if (!name) {
    alert('Vui lòng nhập tên danh mục nhóm (Ví dụ: Bất động sản, Tuyển dụng...).');
    $('newCatName').focus();
    return;
  }

  const rawLinks = $('newCatLinks').value;
  const res = processGroupList(rawLinks);

  if (!res.valid.length) {
    alert('Vui lòng nhập ít nhất một link Facebook Group hợp lệ.\n(Định dạng chuẩn: https://www.facebook.com/groups/ten-nhom/)');
    $('newCatLinks').focus();
    return;
  }

  const all = await loadCategories();
  const newCat = {
    id: crypto.randomUUID(),
    name,
    links: res.valid.join('\n'),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  all.unshift(newCat);
  await saveCategories(all);

  // Clear form
  $('newCatName').value = '';
  $('newCatLinks').value = '';
  $('newCatCount').textContent = '0 link';
  $('newCatValidCount').textContent = '';

  showToast(`✅ Đã lưu danh mục "${name}" (${res.valid.length} nhóm)!`);
  renderCategories(all, $('searchCat').value);
});

// Search filter (Debounced 150ms để gõ tìm kiếm mượt mà không khựng)
let _searchCatDebounce = null;
$('searchCat')?.addEventListener('input', () => {
  if (_searchCatDebounce) clearTimeout(_searchCatDebounce);
  _searchCatDebounce = setTimeout(async () => {
    const all = await loadCategories();
    renderCategories(all, $('searchCat').value);
  }, 150);
});

// ── Export & Import Backup ─────────────────────────────────────────────────────
$('exportBtn')?.addEventListener('click', async () => {
  const categories = await loadCategories();
  if (!categories.length) {
    alert('Chưa có danh mục nào để sao lưu.');
    return;
  }

  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    totalCategories: categories.length,
    groupCategories: categories
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0,10);
  a.download = `ntd_group_categories_${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📤 Đã tải file sao lưu kho nhóm về máy.');
});

$('importFile')?.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const importedCats = data.groupCategories || (Array.isArray(data) ? data : null);

    if (!Array.isArray(importedCats)) {
      throw new Error('File JSON không đúng cấu trúc danh mục nhóm.');
    }

    if (!confirm(`Tìm thấy ${importedCats.length} danh mục trong file.\nBạn có muốn nhập và gộp vào danh mục hiện tại?`)) {
      $('importFile').value = '';
      return;
    }

    const current = await loadCategories();
    const currentMap = new Map(current.map(c => [c.name.toLowerCase(), c]));
    let addedCount = 0;

    for (const item of importedCats) {
      if (!item.name || !item.links) continue;
      const key = item.name.toLowerCase();
      if (!currentMap.has(key)) {
        current.push({
          id: item.id || crypto.randomUUID(),
          name: item.name,
          links: item.links,
          createdAt: item.createdAt || Date.now(),
          updatedAt: Date.now()
        });
        addedCount++;
      }
    }

    await saveCategories(current);
    showToast(`📥 Đã nhập thành công ${addedCount} danh mục mới!`);
    renderCategories(current, $('searchCat').value);
  } catch (err) {
    alert('Lỗi đọc file: ' + err.message);
  } finally {
    $('importFile').value = '';
  }
});

// ── Initial load ──────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.groupCategories) {
    const all = changes.groupCategories.newValue || [];
    renderCategories(all, $('searchCat').value);
    updateDedupeBadges();
  }
  if (changes.scannedGroupHistory) {
    updateDedupeBadges();
  }
});

const initialCats = await loadCategories();
renderCategories(initialCats);

// ─────────────────────────────────────────────────────────────────────────────
// 🔍 GROUP SCANNER & POST APPROVAL FILTER ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// ── Tab Switching ─────────────────────────────────────────────────────────────
$('tabCatManager')?.addEventListener('click', () => {
  $('tabCatManager').classList.add('active');
  $('tabGroupScanner').classList.remove('active');
  $('viewCatManager').style.display = 'block';
  $('viewGroupScanner').style.display = 'none';
});

$('tabGroupScanner')?.addEventListener('click', () => {
  $('tabGroupScanner').classList.add('active');
  $('tabCatManager').classList.remove('active');
  $('viewCatManager').style.display = 'none';
  $('viewGroupScanner').style.display = 'block';
});

// Tự động chuyển sang tab Danh mục nếu URL có #categories hoặc ?tab=categories
if (window.location.hash.includes('cat') || window.location.search.includes('cat')) {
  $('tabCatManager')?.click();
}

// ── Keyword Suggestions Chips & Multi-Keyword Parser ─────────────────────────
export function parseKeywords(inputStr) {
  if (!inputStr || typeof inputStr !== 'string') return [];
  const rawItems = inputStr.split(/[\r\n,;]+/);
  const seen = new Set();
  const result = [];
  for (const raw of rawItems) {
    const clean = raw.trim().replace(/\s+/g, ' ');
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      result.push(clean);
    }
  }
  return result;
}

function syncKeywordState() {
  const btn = $('clearKeywordBtn');
  const input = $('scanKeyword');
  const badge = $('kwCountBadge');
  if (input) {
    const kws = parseKeywords(input.value);
    if (btn) {
      btn.style.display = input.value.trim().length > 0 ? 'inline-flex' : 'none';
    }
    if (badge) {
      if (kws.length > 0) {
        badge.style.display = 'inline-block';
        badge.textContent = `${kws.length} từ khóa`;
      } else {
        badge.style.display = 'none';
      }
    }
  }
}

let _kwSyncDebounce = null;
$('scanKeyword')?.addEventListener('input', () => {
  if (_kwSyncDebounce) clearTimeout(_kwSyncDebounce);
  _kwSyncDebounce = setTimeout(syncKeywordState, 80);
});
syncKeywordState();

document.querySelectorAll('.kw-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const kw = chip.dataset.kw;
    if (!kw || !$('scanKeyword')) return;
    const current = $('scanKeyword').value.trim();
    if (!current) {
      $('scanKeyword').value = kw;
    } else {
      const existing = parseKeywords(current);
      if (!existing.some(k => k.toLowerCase() === kw.toLowerCase())) {
        $('scanKeyword').value = current + '\n' + kw;
      }
    }
    syncKeywordState();
    $('scanKeyword').focus();
  });
});

$('clearKeywordBtn')?.addEventListener('click', () => {
  if ($('scanKeyword')) {
    $('scanKeyword').value = '';
    syncKeywordState();
    $('scanKeyword').focus();
  }
});

// ── Scanner Engine State ──────────────────────────────────────────────────────
const isNativeExtensionPage = (
  window.location.protocol === 'chrome-extension:' ||
  (Boolean(window.chrome?.runtime?.id) && window.chrome.runtime.id !== 'ntd-agency-webapp')
);
let extensionSupportsGroupSearch = isNativeExtensionPage;

let isScanning = false;
let activeExtensionRun = false;
let activeScanConfig = null;
window.__ntdGroupScanning = false;
let scanTabId = null;
let currentScannedGroups = []; // Array of group items
let currentActiveFilter = 'all'; // 'all' | 'public' | 'free' | 'approval' | 'private'
let duplicateSkippedTotal = 0; // Đếm số nhóm trùng đã được lọc bỏ
let lowMembersSkippedTotal = 0; // Đếm số nhóm không đủ số lượng thành viên tối thiểu
let privacySkippedTotal = 0; // Đếm số nhóm bị lọc do khác chế độ Công khai / Riêng tư

let webScanTabWin = null;
const webScanState = {
  active: false,
  keywords: [],
  activeKwIdx: 0,
  perKwCounts: {}
};

function updateWebModeNoticeVisibility() {
  const noticeEl = $('webScanNotice');
  if (!noticeEl) return;
  noticeEl.style.display = (!isNativeExtensionPage && !extensionSupportsGroupSearch) ? 'block' : 'none';
}

async function probeGroupSearchCapability() {
  if (isNativeExtensionPage) {
    extensionSupportsGroupSearch = true;
    updateWebModeNoticeVisibility();
    return true;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GROUP_SEARCH_GET_STATUS', probe: true });
    extensionSupportsGroupSearch = !!(resp && resp.ok && !resp.webFallback && !resp.extensionUnsupported);
  } catch (_) {
    extensionSupportsGroupSearch = false;
  }
  updateWebModeNoticeVisibility();
  return extensionSupportsGroupSearch;
}

window.addEventListener('NTD_EXTENSION_READY', () => {
  probeGroupSearchCapability();
});
probeGroupSearchCapability();

let _saveScannedTimeout = null;
async function saveScannedGroupsToStorage(immediate = false) {
  if (immediate) {
    if (_saveScannedTimeout) {
      clearTimeout(_saveScannedTimeout);
      _saveScannedTimeout = null;
    }
    try {
      await chrome.storage.local.set({ lastScannedGroups: currentScannedGroups });
    } catch (e) {
      console.warn('Lỗi lưu lastScannedGroups:', e);
    }
    return;
  }
  if (_saveScannedTimeout) return;
  _saveScannedTimeout = setTimeout(async () => {
    _saveScannedTimeout = null;
    try {
      await chrome.storage.local.set({ lastScannedGroups: currentScannedGroups });
    } catch (e) {
      console.warn('Lỗi lưu lastScannedGroups:', e);
    }
  }, 300);
}

async function restoreScannedGroupsFromStorage() {
  try {
    const { lastScannedGroups } = await chrome.storage.local.get('lastScannedGroups');
    if (Array.isArray(lastScannedGroups) && lastScannedGroups.length > 0) {
      // Chuẩn hóa: nếu có nhóm đang bị kẹt ở trạng thái 'loading' khi tắt trang, chuyển sang 'uninspected'
      currentScannedGroups = lastScannedGroups.map(grp => {
        if (grp.approvalStatus === 'loading') {
          return {
            ...grp,
            approvalStatus: 'uninspected',
            approvalLabel: 'Chưa kiểm tra',
            approvalBadge: '⚪ Chưa rõ'
          };
        }
        return grp;
      });

      if ($('scanResultsCard')) {
        $('scanResultsCard').style.display = 'block';
      }
      renderResultsTable();
      updateScanStats();
    }
  } catch (err) {
    console.warn('Lỗi khôi phục nhóm đã quét:', err);
  }
}

// Khôi phục nhóm đã quét từ storage ngay khi nạp trang
await restoreScannedGroupsFromStorage();

// (parseMemberCount, extractCanonicalGroupKey, normalizeGroupName được nạp từ group_parser.js)

async function getScannedGroupHistory() {
  try {
    const { scannedGroupHistory } = await chrome.storage.local.get('scannedGroupHistory');
    if (Array.isArray(scannedGroupHistory)) {
      return scannedGroupHistory;
    }
    return [];
  } catch (_) {
    return [];
  }
}

async function saveScannedGroupHistory(newKeys) {
  try {
    if (!newKeys || !newKeys.length) return;
    const existing = await getScannedGroupHistory();
    const historySet = new Set(existing);
    for (const k of newKeys) {
      if (k) historySet.add(k);
    }
    // Giữ tối đa 20.000 nhóm trong bộ nhớ để không quá tải storage
    const trimmed = Array.from(historySet).slice(-20000);
    await chrome.storage.local.set({ scannedGroupHistory: trimmed });
    await updateDedupeBadges();
  } catch (_) {}
}

async function clearScannedGroupHistory() {
  if (!confirm('Bạn có chắc muốn xóa toàn bộ lịch sử nhóm đã quét trước đây?\nSau khi xóa, các lần quét tiếp theo sẽ có thể quét lại các nhóm này từ đầu.')) {
    return;
  }
  try {
    await chrome.storage.local.remove('scannedGroupHistory');
    await updateDedupeBadges();
    showToast('✅ Đã xóa toàn bộ bộ nhớ nhóm đã quét.');
  } catch (err) {
    showToast('Lỗi khi xóa lịch sử: ' + err.message);
  }
}

async function getCategoryGroupKeys() {
  try {
    const categories = await loadCategories();
    const set = new Set();
    for (const cat of categories) {
      const lines = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const k = extractCanonicalGroupKey(line);
        if (k) set.add(k);
      }
    }
    return set;
  } catch (_) {
    return new Set();
  }
}

async function updateDedupeBadges() {
  try {
    const historyList = await getScannedGroupHistory();
    const catKeys = await getCategoryGroupKeys();
    
    if ($('txtHistoryCount')) $('txtHistoryCount').textContent = historyList.length;
    if ($('txtHistoryBadge')) $('txtHistoryBadge').textContent = historyList.length;
    if ($('txtCategoriesBadge')) $('txtCategoriesBadge').textContent = catKeys.size;
  } catch (_) {}
}

// Cập nhật số lượng huy hiệu chống trùng ngay khi khởi động
updateDedupeBadges();
$('btnClearHistoryBtn')?.addEventListener('click', clearScannedGroupHistory);

// Đảm bảo trạng thái quét ban đầu sạch khi mở trang
chrome.storage?.local?.set?.({ isGroupScanning: false, groupScanTabId: null }).catch(() => {});

function updateScanStats() {
  const total = currentScannedGroups.length;
  const pub = currentScannedGroups.filter(g => g.privacy === 'Công khai').length;
  const free = currentScannedGroups.filter(g => g.approvalStatus === 'free').length;
  const approval = currentScannedGroups.filter(g => g.approvalStatus === 'approval').length;
  const priv = currentScannedGroups.filter(g => g.privacy === 'Riêng tư' || g.approvalStatus === 'private').length;

  if ($('cntTotal')) $('cntTotal').textContent = total;
  if ($('cntPublic')) $('cntPublic').textContent = pub;
  if ($('cntFree')) $('cntFree').textContent = free;
  if ($('cntApproval')) $('cntApproval').textContent = approval;
  if ($('cntPrivate')) $('cntPrivate').textContent = priv;
  if ($('cntDupes')) $('cntDupes').textContent = duplicateSkippedTotal;
  if ($('cntLowMembers')) $('cntLowMembers').textContent = lowMembersSkippedTotal;
  if ($('cntFilteredPrivacy')) $('cntFilteredPrivacy').textContent = privacySkippedTotal;

  if ($('pillFilteredPrivacy')) {
    $('pillFilteredPrivacy').style.display = privacySkippedTotal > 0 ? 'inline-flex' : 'none';
  }

  if ($('pillLowMembers')) {
    const minMembers = parseInt($('scanMinMembers')?.value || '10000', 10);
    const labelText = minMembers >= 1000 ? `${Math.round(minMembers / 1000)}k` : `${minMembers}`;
    $('pillLowMembers').innerHTML = `Bỏ qua &lt;${labelText} TV: <span id="cntLowMembers">${lowMembersSkippedTotal}</span>`;
    $('pillLowMembers').style.display = lowMembersSkippedTotal > 0 ? 'inline-flex' : 'none';
  }

  if ($('pillCountAll')) $('pillCountAll').textContent = total;
  if ($('pillCountPublic')) $('pillCountPublic').textContent = pub;
  if ($('pillCountFree')) $('pillCountFree').textContent = free;
  if ($('pillCountApproval')) $('pillCountApproval').textContent = approval;
  if ($('pillCountPrivate')) $('pillCountPrivate').textContent = priv;
}

function updateProgressBar(percent, title, detail) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  if ($('scanProgressBar')) $('scanProgressBar').style.width = `${pct}%`;
  if ($('scanProgressPercent')) $('scanProgressPercent').textContent = `${pct}%`;
  if (title && $('scanProgressTitle')) $('scanProgressTitle').textContent = title;
  if (detail && $('scanProgressDetail')) $('scanProgressDetail').textContent = detail;
}

// ── Injected Functions (Run in Facebook Tab Context) ──────────────────────────

/**
 * Script cuộn và trích xuất danh sách nhóm từ trang tìm kiếm Facebook
 */
function extractGroupsFromFacebookSearch() {
  function normUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, window.location.origin);
      if (!['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(u.hostname)) return null;
      const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)/i);
      if (!m || ['feed', 'discover', 'joins', 'create', 'search'].includes(m[1].toLowerCase())) return null;
      return `https://www.facebook.com/groups/${m[1].toLowerCase()}/`;
    } catch (_) {
      return null;
    }
  }

  const items = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/groups/"]');

  for (const a of anchors) {
    const rawHref = a.getAttribute('href') || a.href;
    const cleanUrl = normUrl(rawHref);
    if (!cleanUrl || seen.has(cleanUrl)) continue;

    // Tìm thẻ card chứa liên kết này
    let container = a.closest('[role="article"]') ||
                    a.closest('[data-virtualized]') ||
                    a.parentElement?.parentElement?.parentElement?.parentElement;

    let cardText = container ? container.innerText : (a.parentElement?.innerText || '');

    // Tên nhóm
    let name = (a.innerText || a.textContent || '').trim().replace(/\r?\n.*/s, '').trim();
    if (!name || name.length < 2) {
      const heading = container?.querySelector('h2, h3, [role="heading"], strong');
      if (heading) name = heading.innerText.trim();
    }
    if (!name) {
      const m = cleanUrl.match(/\/groups\/([^\/]+)\//);
      name = m ? m[1] : 'Nhóm Facebook';
    }

    // Chế độ nhóm (Công khai / Riêng tư)
    let privacy = 'Công khai';
    if (/riêng tư|private/i.test(cardText)) {
      privacy = 'Riêng tư';
    } else if (/công khai|public/i.test(cardText)) {
      privacy = 'Công khai';
    }

    // Số lượng thành viên
    let members = '';
    const memMatch = cardText.match(/([\d.,]+\s*(?:triệu|nghìn|ngàn|tỷ|tr|[kmKmMbB])?)\s*(thành viên|members|người theo dõi|followers)/i);
    if (memMatch) {
      members = memMatch[1].trim() + ' thành viên';
    } else {
      const subMatch = cardText.match(/·\s*([^·\n]+(?:thành viên|members)[^·\n]*)/i);
      if (subMatch) members = subMatch[1].trim();
    }

    seen.add(cleanUrl);
    items.push({
      name: name.slice(0, 90),
      url: cleanUrl,
      privacy,
      members: members || 'Đang cập nhật'
    });
  }

  return items;
}

/**
 * Script cuộn và đánh thức Facebook tải tiếp nội dung ngay trong tab nền (Background Tab - Main World)
 * Tự động giải phóng render, polyfill requestAnimationFrame & kích hoạt IntersectionObserver của Facebook
 */
function scrollAndTriggerFacebookSearch(stagnantRound = 0) {
  try {
    // 1. Luôn duy trì giả lập tab đang active và visible trong context Facebook
    try {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    } catch (_) {}
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    } catch (_) {}
    document.hasFocus = () => true;
    window.hasFocus = () => true;

    // 2. Polyfill requestAnimationFrame khi tab ở background (đảm bảo React 18 Scheduler & Relay không bị dừng 0 FPS)
    if (!window.__ntdRafPolyfilled) {
      window.__ntdRafPolyfilled = true;
      const origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
      window.requestAnimationFrame = function(cb) {
        let executed = false;
        const timer = setTimeout(() => {
          if (!executed) {
            executed = true;
            try { cb(performance.now()); } catch (_) {}
          }
        }, 25);
        if (origRAF) {
          try {
            return origRAF(ts => {
              if (!executed) {
                executed = true;
                clearTimeout(timer);
                try { cb(ts); } catch (_) {}
              }
            });
          } catch (_) {}
        }
        return timer;
      };
    }

    // 3. Intercept & Hook IntersectionObserver để tự động kích hoạt callback ngay cả khi Chromium dừng render tab nền
    if (!window.__ntdIoHooked && window.IntersectionObserver) {
      window.__ntdIoHooked = true;
      const OrigIO = window.IntersectionObserver;
      window.__ntdActiveObservers = window.__ntdActiveObservers || [];

      window.IntersectionObserver = function(callback, options) {
        const inst = new OrigIO(callback, options);
        const record = { callback, options, targets: new Set(), inst };
        window.__ntdActiveObservers.push(record);

        const origObs = inst.observe.bind(inst);
        inst.observe = function(t) {
          if (t && t.nodeType === 1) record.targets.add(t);
          return origObs(t);
        };
        const origUnobs = inst.unobserve.bind(inst);
        inst.unobserve = function(t) {
          if (t) record.targets.delete(t);
          return origUnobs(t);
        };
        const origDisc = inst.disconnect.bind(inst);
        inst.disconnect = function() {
          record.targets.clear();
          const idx = window.__ntdActiveObservers.indexOf(record);
          if (idx !== -1) window.__ntdActiveObservers.splice(idx, 1);
          return origDisc();
        };
        return inst;
      };
      window.IntersectionObserver.prototype = OrigIO.prototype;
    }

    // 4. Kích hoạt thủ công tất cả IntersectionObserver đang theo dõi các phần tử cuối trang / Sentinel tải thêm
    if (window.__ntdActiveObservers && window.__ntdActiveObservers.length > 0) {
      for (const rec of window.__ntdActiveObservers) {
        for (const target of rec.targets) {
          if (!target.isConnected) {
            rec.targets.delete(target);
            continue;
          }
          try {
            const rect = target.getBoundingClientRect();
            rec.callback([
              {
                isIntersecting: true,
                intersectionRatio: 1,
                target: target,
                time: performance.now(),
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: null
              }
            ], rec.inst);
          } catch (_) {}
        }
      }
    }

    // 5. Cuộn toàn diện: Quét và cuộn TẤT CẢ các container đang chứa nội dung dài hơn khung nhìn
    const scrollDistance = 3500;
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.scrollHeight > el.clientHeight + 40) {
        if (stagnantRound >= 2 && stagnantRound % 2 === 0) {
          el.scrollTop -= 350; // nhấp nhô để kích hoạt sự kiện thay đổi vị trí
        }
        el.scrollTop = el.scrollHeight;
        el.scrollTop += scrollDistance;
        try { el.dispatchEvent(new Event('scroll', { bubbles: true, cancelable: true })); } catch (_) {}
      }
    }

    // 6. Cuộn window và document
    window.scrollTo(0, document.body.scrollHeight || 999999);
    window.scrollBy({ top: scrollDistance, behavior: 'auto' });
    if (document.documentElement) document.documentElement.scrollTop += scrollDistance;
    if (document.body) document.body.scrollTop += scrollDistance;

    // 7. Cuộn các phần tử cuối cùng vào viewport
    const anchors = document.querySelectorAll('a[href*="/groups/"]');
    if (anchors.length > 0) {
      const last = anchors[anchors.length - 1];
      try { last.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
      let sib = last.parentElement?.nextElementSibling || last.nextElementSibling;
      while (sib) {
        try { sib.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
        sib = sib.nextElementSibling;
      }
    }

    // 8. Tự động bấm nút "Xem thêm / Tải thêm / Thử lại" nếu Facebook hiển thị
    const buttons = document.querySelectorAll('[role="button"], button');
    for (const btn of buttons) {
      const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (/xem thêm|tải thêm|thử lại|see more|load more|retry/i.test(txt)) {
        try { btn.click(); } catch (_) {}
      }
    }

    // 9. Phát các sự kiện cuộn & con lăn chuột để đánh thức các event listener của Facebook React
    try {
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: scrollDistance, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', keyCode: 34, which: 34, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', keyCode: 35, which: 35, bubbles: true }));
    } catch (_) {}

  } catch (err) {
    console.warn('[scrollAndTriggerFacebookSearch error]:', err);
  }

  // Buộc trình duyệt tính toán lại Layout (Reflow) để kích hoạt IntersectionObserver
  const offsetH = document.body ? document.body.offsetHeight : 0;
  const isEnd = /đã hết kết quả|không còn kết quả|hết kết quả tìm kiếm|end of results|no more results/i.test(document.body ? document.body.innerText : '');
  return { offsetH, endOfResults: isEnd };
}

/**
 * Script kiểm tra trạng thái kiểm duyệt bài viết trên trang nhóm Facebook
 */
function inspectGroupApprovalInTab() {
  const norm = str => (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const rawBodyText = document.body ? document.body.innerText : '';
  const pageText = norm(rawBodyText);

  // 1. Kiểm tra nếu chưa đăng nhập Facebook
  if (pageText.includes('dang nhap facebook') || pageText.includes('log into facebook') || window.location.pathname.includes('/login')) {
    return {
      status: 'login_required',
      badge: 'Chưa đăng nhập',
      label: 'Chưa đăng nhập Facebook',
      canPost: false,
      requiresApproval: null
    };
  }

  // 2. Nhóm riêng tư chưa tham gia
  const isPrivateLocked = /nhom nay la nhom rieng tu|nhom rieng tu.*tham gia|this group is private|private group.*join/i.test(pageText) &&
    !pageText.includes('ban viet gi di') && !pageText.includes('tao bai viet') && !pageText.includes('write something');

  if (isPrivateLocked) {
    return {
      status: 'private',
      badge: 'Riêng tư',
      label: 'Nhóm riêng tư (Cần tham gia)',
      canPost: false,
      requiresApproval: null
    };
  }

  // 3. Chỉ quản trị viên mới được đăng bài
  if (/chi quan tri vien moi co the dang|only admins can post|posting is disabled|tinh nang dang bai bi tat/i.test(pageText)) {
    return {
      status: 'admin_only',
      badge: 'Chỉ Admin',
      label: 'Chỉ quản trị viên mới được đăng',
      canPost: false,
      requiresApproval: true
    };
  }

  // 4. Biểu thức regex nhận diện kiểm duyệt bài viết
  const approvalRegex = /kiem duyet|phe duyet|cho duyet|quan tri vien.*(duyet|phe duyet)|gui de phe duyet|bai viet.*phai duoc.*duyet|bai viet.*can.*duyet|admin approval|pending approval|require.*approval|needs? approval|must be approved|submit for approval/i;

  // 5. Tìm ô tạo bài viết
  const allClickables = [...document.querySelectorAll('[role="button"], div[tabindex="0"], a')];
  const composerTrigger = allClickables.find(el => {
    const t = norm(el.textContent);
    return t.includes('ban viet gi di') ||
           t.includes('tao bai viet cong khai') ||
           t.includes('tao bai viet') ||
           t.includes('viet gi do') ||
           t.includes('write something') ||
           t.includes('create a public post');
  });

  if (composerTrigger) {
    // Kiểm tra khu vực bao quanh ô soạn thảo
    const area = composerTrigger.closest('[role="region"], [role="main"], div[data-pagelet]') || composerTrigger.parentElement?.parentElement;
    const areaText = area ? norm(area.innerText || '') : '';

    if (approvalRegex.test(areaText)) {
      return {
        status: 'approval',
        badge: 'Cần kiểm duyệt',
        label: 'Bài viết cần Quản trị viên duyệt',
        canPost: true,
        requiresApproval: true
      };
    }

    // Thử click vào ô soạn thảo để xem thông báo trong hộp thoại
    try {
      composerTrigger.click();
    } catch (_) {}

    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const dialogText = norm(dialog.innerText || '');
      const hasApprovalInDialog = approvalRegex.test(dialogText);

      const buttons = [...dialog.querySelectorAll('[role="button"]')];
      const isSubmitApproval = buttons.some(b => /gui de phe duyet|submit for approval|cho duyet/i.test(norm(b.textContent)));

      // Đóng hộp thoại ngay
      const closeBtn = dialog.querySelector('[aria-label="Đóng"], [aria-label="Close"], [aria-label*="Dong"]') ||
                       dialog.querySelector('[role="button"][tabindex="0"]');
      if (closeBtn) {
        try { closeBtn.click(); } catch (_) {}
      } else {
        try {
          dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (_) {}
      }

      if (hasApprovalInDialog || isSubmitApproval) {
        return {
          status: 'approval',
          badge: 'Cần kiểm duyệt',
          label: 'Bài viết cần Quản trị viên duyệt',
          canPost: true,
          requiresApproval: true
        };
      } else {
        return {
          status: 'free',
          badge: 'Đăng tự do',
          label: 'Không kiểm duyệt (Đăng tự do)',
          canPost: true,
          requiresApproval: false
        };
      }
    }

    // Có ô soạn thảo và không thấy cảnh báo kiểm duyệt
    return {
      status: 'free',
      badge: 'Đăng tự do',
      label: 'Không kiểm duyệt (Đăng tự do)',
      canPost: true,
      requiresApproval: false
    };
  }

  // 6. Kiểm tra toàn bộ text trang nếu không tìm thấy ô soạn thảo
  if (approvalRegex.test(pageText)) {
    return {
      status: 'approval',
      badge: 'Cần kiểm duyệt',
      label: 'Có dấu hiệu kiểm duyệt bài viết',
      canPost: true,
      requiresApproval: true
    };
  }

  // Mặc định cho nhóm công khai
  return {
    status: 'free',
    badge: 'Đăng tự do',
    label: 'Không kiểm duyệt (Mặc định)',
    canPost: true,
    requiresApproval: false
  };
}

async function waitForTab(tabId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await new Promise(r => setTimeout(r, 350));
  }
  return true;
}

// ── Web Assisted Group Scanner (Hoạt động trực tiếp trên Web, không cần nạp lại Extension) ──
function buildFbGroupSearchUrl(keyword) {
  return `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword || '')}`;
}

function openOrNavigateWebScanTab(url, focusTab = true) {
  if ($('webScanOpenLink')) $('webScanOpenLink').href = url;
  try {
    webScanTabWin = window.open(url, 'ntd_fb_search_tab');
    if (focusTab && webScanTabWin && !webScanTabWin.closed) {
      try { webScanTabWin.focus(); } catch (_) {}
    }
    return Boolean(webScanTabWin);
  } catch (_) {
    return false;
  }
}

function focusExistingWebScanTab(fallbackUrl) {
  try {
    if (webScanTabWin && !webScanTabWin.closed) {
      webScanTabWin.focus();
      return true;
    }
  } catch (_) {}
  return openOrNavigateWebScanTab(fallbackUrl, true);
}

function updateWebFeedback(type, message) {
  const el = $('webCaptureFeedback');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    el.className = 'web-capture-feedback';
    return;
  }
  el.className = `web-capture-feedback ${type === 'warn' ? 'warn' : 'ok'}`;
  el.textContent = message;
  el.style.display = 'block';
}

function renderWebScanKeywordChips() {
  const bar = $('webScanKwBar');
  const chipsEl = $('webScanKeywordChips');
  const nextBtn = $('webScanNextKwBtn');
  if (!bar || !chipsEl) return;

  if (!webScanState.active || webScanState.keywords.length === 0) {
    bar.style.display = 'none';
    chipsEl.innerHTML = '';
    return;
  }

  bar.style.display = 'flex';
  chipsEl.replaceChildren();
  webScanState.keywords.forEach((kw, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `web-kw-pill${idx === webScanState.activeKwIdx ? ' active' : ''}`;
    const cnt = webScanState.perKwCounts[idx] || 0;
    btn.textContent = cnt > 0 ? `${kw} (${cnt})` : kw;
    btn.title = `Mở tìm kiếm nhóm Facebook cho "${kw}"`;
    btn.addEventListener('click', () => switchWebScanKeyword(idx));
    chipsEl.appendChild(btn);
  });

  if (nextBtn) {
    nextBtn.style.display = webScanState.keywords.length > 1 ? 'inline-flex' : 'none';
  }
}

function switchWebScanKeyword(idx) {
  if (!webScanState.keywords.length) return;
  const safeIdx = Math.max(0, Math.min(webScanState.keywords.length - 1, idx));
  webScanState.activeKwIdx = safeIdx;
  const activeKw = webScanState.keywords[safeIdx];
  const url = buildFbGroupSearchUrl(activeKw);

  openOrNavigateWebScanTab(url, true);
  renderWebScanKeywordChips();

  const totalKw = webScanState.keywords.length;
  updateProgressBar(
    Math.max(15, Math.round(((safeIdx) / totalKw) * 80)),
    `[Từ khóa ${safeIdx + 1}/${totalKw}: "${activeKw}"] Đã mở tab tìm kiếm Facebook`,
    `Trên tab Facebook: cuộn tải kết quả -> bấm Ctrl + A → Ctrl + C -> quay lại đây bấm "Lấy danh sách nhóm" hoặc Ctrl + V.`
  );
  updateWebFeedback('ok', `🔎 Đã mở từ khóa "${activeKw}" trên tab Facebook. Hãy cuộn kết quả -> Ctrl + A → Ctrl + C rồi quay lại đây dán/lấy nhóm.`);
}

async function handleWebClipboardCapture({ html = '', text = '' } = {}) {
  const payload = extractGroupsFromClipboardPayload({ html, text });

  if (payload.textWithoutUrls) {
    updateWebFeedback(
      'warn',
      '⚠️ Nội dung vừa dán chỉ có chữ thuần, chưa chứa liên kết /groups/... Do copy dạng text không kèm link, hãy sang tab Facebook bấm Ctrl + A rồi Ctrl + C trực tiếp trên trang web và bấm Ctrl + V lại tại đây!'
    );
    showToast('⚠️ Chưa thấy link /groups/ trong clipboard. Hãy bấm Ctrl + A → Ctrl + C trực tiếp trên tab Facebook!', 4200);
    return;
  }

  if (!payload.items.length) {
    updateWebFeedback(
      'warn',
      '⚠️ Không tìm thấy đường dẫn nhóm Facebook (/groups/...) nào trong dữ liệu vừa copy. Hãy kiểm tra lại tab tìm kiếm nhóm Facebook.'
    );
    showToast('Chưa thấy nhóm Facebook nào trong dữ liệu vừa copy.');
    return;
  }

  const maxCountPerKeyword = parseInt($('scanMaxCount')?.value || '30', 10);
  const minMembers = parseInt($('scanMinMembers')?.value || '10000', 10);
  const privacyMode = $('scanPrivacyMode')?.value || 'public_only';
  const dedupeHistory = $('chkDedupeHistory') ? $('chkDedupeHistory').checked : true;
  const dedupeCategories = $('chkDedupeCategories') ? $('chkDedupeCategories').checked : true;
  const dedupeName = $('chkDedupeName') ? $('chkDedupeName').checked : true;

  const fallbackKws = parseKeywords($('scanKeyword')?.value);
  const activeKw = webScanState.active
    ? (webScanState.keywords[webScanState.activeKwIdx] || '')
    : (fallbackKws[0] || '');

  const [historyList, categoryKeySet] = await Promise.all([
    dedupeHistory ? getScannedGroupHistory() : Promise.resolve([]),
    dedupeCategories ? getCategoryGroupKeys() : Promise.resolve(new Set())
  ]);
  const historyKeySet = new Set(historyList);

  const sessionUrls = new Set();
  const sessionKeys = new Set();
  const sessionNames = new Set();
  let existingForKeyword = 0;

  if (!Array.isArray(currentScannedGroups)) {
    currentScannedGroups = [];
  }
  for (const g of currentScannedGroups) {
    if (g.url) sessionUrls.add(g.url);
    const k = extractCanonicalGroupKey(g.url);
    if (k) sessionKeys.add(k);
    const norm = normalizeGroupName(g.name);
    if (norm) sessionNames.add(norm);
    if (activeKw) {
      const kws = String(g.keyword || '').split(',').map(s => s.trim().toLowerCase());
      if (kws.includes(activeKw.toLowerCase())) existingForKeyword++;
    }
  }

  const { accepted, stats, newKeysToSave } = filterAndPrepareImportedGroups(payload.items, {
    keyword: activeKw,
    privacyMode,
    minMembers,
    maxCountPerKeyword,
    existingCountForKeyword: existingForKeyword,
    historyKeySet,
    categoryKeySet,
    sessionUrls,
    sessionKeys,
    sessionNames,
    dedupeHistory,
    dedupeCategories,
    dedupeName,
    existingGroupList: currentScannedGroups
  });

  if (accepted.length > 0) {
    currentScannedGroups.push(...accepted);
    if (webScanState.active) {
      webScanState.perKwCounts[webScanState.activeKwIdx] = (webScanState.perKwCounts[webScanState.activeKwIdx] || 0) + accepted.length;
    }
  }

  duplicateSkippedTotal += stats.skippedDuplicate;
  lowMembersSkippedTotal += stats.skippedLowMembers;
  privacySkippedTotal += stats.skippedPrivacy + stats.skippedUnknownPrivacy;

  if (newKeysToSave.length > 0) {
    await saveScannedGroupHistory(newKeysToSave);
  }
  await saveScannedGroupsToStorage(true);

  if ($('scanResultsCard')) $('scanResultsCard').style.display = 'block';
  if ($('scanProgressCard')) $('scanProgressCard').style.display = 'block';

  // Tự động chọn tab lọc khớp với Chế độ Công khai / Riêng tư đang dùng
  if (accepted.length > 0) {
    if (privacyMode === 'public_only') {
      applyFilter('public');
    } else if (privacyMode === 'private_only') {
      applyFilter('private');
    } else if (currentActiveFilter === 'free' || currentActiveFilter === 'approval') {
      applyFilter('all');
    } else {
      renderResultsTable();
    }
  } else {
    renderResultsTable();
  }

  updateScanStats();
  renderWebScanKeywordChips();

  const totalTarget = Math.max(1, (webScanState.keywords.length || 1) * maxCountPerKeyword);
  const collectedTotal = currentScannedGroups.length;
  const pct = Math.min(100, Math.max(15, Math.round((collectedTotal / totalTarget) * 100)));
  if ($('scanProgressCount')) $('scanProgressCount').textContent = `${collectedTotal} nhóm`;

  const minMembersLabel = minMembers >= 1000 ? `${Math.round(minMembers / 1000)}k` : `${minMembers}`;
  const skipParts = [];
  if (stats.skippedPrivacy > 0) skipParts.push(`${stats.skippedPrivacy} khác chế độ (${privacyMode === 'public_only' ? 'Riêng tư' : 'Công khai'})`);
  if (stats.skippedUnknownPrivacy > 0) skipParts.push(`${stats.skippedUnknownPrivacy} chưa rõ chế độ`);
  if (stats.skippedLowMembers > 0) skipParts.push(`${stats.skippedLowMembers} <${minMembersLabel} TV`);
  if (stats.skippedDuplicate > 0) skipParts.push(`${stats.skippedDuplicate} trùng`);
  if (stats.skippedLimit > 0) skipParts.push(`${stats.skippedLimit} vượt giới hạn ${maxCountPerKeyword}/từ khóa`);

  const skipSuffix = skipParts.length ? ` (Đã lọc bỏ: ${skipParts.join(', ')})` : '';
  const kwLabel = activeKw ? ` cho từ khóa "${activeKw}"` : '';

  if (stats.added > 0) {
    const hasNextKw = webScanState.active && webScanState.activeKwIdx < webScanState.keywords.length - 1;
    const hitLimit = stats.skippedLimit > 0 || (existingForKeyword + stats.added >= maxCountPerKeyword);
    const nextHint = (hasNextKw && hitLimit) ? ' — Đã đủ chỉ tiêu từ khóa này, hãy bấm "Từ khóa tiếp ➡"!' : '';

    updateProgressBar(
      pct,
      `✅ Đã thu +${stats.added} nhóm hợp lệ${kwLabel} (Tổng: ${collectedTotal})`,
      `Đọc ${stats.totalParsed} nhóm từ trang Facebook${skipSuffix}.${nextHint}`
    );
    updateWebFeedback('ok', `✅ Đã thêm +${stats.added} nhóm mới${kwLabel}${skipSuffix}.${nextHint}`);
    showToast(`✅ Đã lấy +${stats.added} nhóm mới${skipSuffix}!`, 3500);
  } else {
    updateProgressBar(
      pct,
      `⚠️ Chưa thêm được nhóm mới${kwLabel} (Tổng hiện có: ${collectedTotal})`,
      `Tìm thấy ${stats.totalParsed} nhóm nhưng bị lọc hết${skipSuffix}.`
    );
    updateWebFeedback('warn', `⚠️ Đọc được ${stats.totalParsed} nhóm nhưng không có nhóm nào phù hợp để thêm mới${skipSuffix}. Hãy kiểm tra bộ lọc thành viên/chống trùng hoặc cuộn thêm nhóm trên tab Facebook.`);
    showToast(`⚠️ 0 nhóm mới được thêm${skipSuffix}.`, 3800);
  }
}

function startWebAssistedScanner(keywords, { maxCountPerKeyword, privacyMode }) {
  const firstKw = keywords[0];
  const firstUrl = buildFbGroupSearchUrl(firstKw);

  // Mở tab tìm kiếm Facebook ĐỒNG BỘ ngay trong click handler để trình duyệt không bao giờ chặn popup
  const opened = openOrNavigateWebScanTab(firstUrl, true);

  webScanState.active = true;
  webScanState.keywords = [...keywords];
  webScanState.activeKwIdx = 0;
  webScanState.perKwCounts = {};

  isScanning = false;
  window.__ntdGroupScanning = false;
  duplicateSkippedTotal = 0;
  lowMembersSkippedTotal = 0;
  privacySkippedTotal = 0;

  if (!Array.isArray(currentScannedGroups)) {
    currentScannedGroups = [];
  }

  $('startScanBtn').style.display = 'none';
  if ($('stopScanBtn')) {
    $('stopScanBtn').style.display = 'inline-flex';
    $('stopScanBtn').textContent = '⏹ Đóng khung quét';
  }
  if ($('focusScanTabBtn')) $('focusScanTabBtn').style.display = 'inline-flex';
  if ($('scanProgressCard')) $('scanProgressCard').style.display = 'block';
  if ($('scanResultsCard')) $('scanResultsCard').style.display = 'block';
  if ($('webScanAssistBox')) $('webScanAssistBox').style.display = 'block';
  $('scanProgressBar')?.classList.remove('scanning');
  if ($('scanStatusQuick')) $('scanStatusQuick').textContent = 'Chế độ Web đang mở tab Facebook...';
  updateWebModeNoticeVisibility();

  if (privacyMode === 'public_only') {
    currentActiveFilter = 'public';
  } else if (privacyMode === 'private_only') {
    currentActiveFilter = 'private';
  } else {
    currentActiveFilter = 'all';
  }

  renderWebScanKeywordChips();
  updateScanStats();
  applyFilter(currentActiveFilter);

  const totalKw = keywords.length;
  updateProgressBar(
    12,
    `[Từ khóa 1/${totalKw}: "${firstKw}"] Đã mở trang tìm kiếm nhóm Facebook`,
    opened
      ? `Trên tab Facebook: cuộn tải kết quả -> bấm Ctrl + A → Ctrl + C -> quay lại đây bấm "Lấy danh sách nhóm" hoặc Ctrl + V.`
      : `Trình duyệt vừa chặn mở tab tự động — hãy bấm nút "🔗 Mở lại tab FB" ngay bên dưới để mở trang tìm kiếm!`
  );

  if (!opened) {
    updateWebFeedback('warn', '⚠️ Popup bị trình duyệt chặn — hãy bấm nút "🔗 Mở lại tab FB" góc phải khung bên dưới để mở trang tìm kiếm Facebook!');
  } else {
    updateWebFeedback('ok', `🔎 Đã mở tab Facebook cho "${firstKw}" (chỉ tiêu ${maxCountPerKeyword} nhóm). Lướt tải danh sách nhóm xong bấm Ctrl + A → Ctrl + C rồi quay lại đây Ctrl + V!`);
  }
}

// ── Scanner Controller ────────────────────────────────────────────────────────
async function startScanningProcess() {
  const rawKeywords = $('scanKeyword')?.value.trim();
  const keywords = parseKeywords(rawKeywords);
  if (!keywords.length) {
    alert('Vui lòng nhập ít nhất một từ khóa tìm kiếm nhóm (Ví dụ: bất động sản, việc làm đà nẵng...).');
    $('scanKeyword')?.focus();
    return;
  }

  const maxCountPerKeyword = parseInt($('scanMaxCount')?.value || '30', 10);
  const filterMode = $('scanFilterMode')?.value || 'free_only';
  const minMembers = parseInt($('scanMinMembers')?.value || '10000', 10);
  const checkApproval = $('checkApprovalToggle') ? $('checkApprovalToggle').checked : (filterMode !== 'all');
  const privacyMode = $('scanPrivacyMode')?.value || 'public_only';

  // Trên Web Platform không có Extension đời mới hỗ trợ quét chéo domain:
  // Chuyển sang Web Assisted Mode ĐỒNG BỘ ngay trong click để giữ nguyên user activation mở tab FB mượt mà!
  if (!isNativeExtensionPage && !extensionSupportsGroupSearch) {
    startWebAssistedScanner(keywords, { maxCountPerKeyword, filterMode, minMembers, privacyMode });
    return;
  }

  // Khởi tạo trạng thái giao diện (Chế độ Extension native)
  isScanning = true;
  activeExtensionRun = false;
  activeScanConfig = { filterMode, privacyMode, minMembers, maxCountPerKeyword };
  window.__ntdGroupScanning = true;
  chrome.storage?.local?.set?.({ isGroupScanning: true }).catch(() => {});
  // KHÔNG xóa currentScannedGroups: giữ lại các nhóm đã quét trước đó cho đến khi bấm "Xóa dữ liệu"
  if (!Array.isArray(currentScannedGroups)) {
    currentScannedGroups = [];
  }
  currentActiveFilter = 'all';

  // Tùy chọn chống quét trùng nhóm
  const dedupeHistory = $('chkDedupeHistory') ? $('chkDedupeHistory').checked : true;
  const dedupeCategories = $('chkDedupeCategories') ? $('chkDedupeCategories').checked : true;
  const dedupeName = $('chkDedupeName') ? $('chkDedupeName').checked : true;

  duplicateSkippedTotal = 0;
  lowMembersSkippedTotal = 0;
  privacySkippedTotal = 0;

  // Lấy danh sách nhóm đã từng quét và nhóm đã lưu trong danh mục để chống trùng
  const historyList = dedupeHistory ? await getScannedGroupHistory() : [];
  const historyKeySet = new Set(historyList);
  const categoryKeySet = dedupeCategories ? await getCategoryGroupKeys() : new Set();

  // Tập hợp chống trùng trong chính phiên quét này
  const sessionScannedUrls = new Set();
  const sessionGroupKeys = new Set();
  const sessionGroupNames = new Set();
  const newDiscoveredKeysToSave = [];

  // Giữ máy và trình duyệt không bị treo/ngủ khi quét số lượng lớn
  try {
    chrome.power?.requestKeepAwake?.('system');
  } catch (_) {}

  $('startScanBtn').style.display = 'none';
  if ($('stopScanBtn')) {
    $('stopScanBtn').style.display = 'inline-flex';
    $('stopScanBtn').textContent = '⏹ Dừng quét';
  }
  if ($('focusScanTabBtn')) $('focusScanTabBtn').style.display = 'inline-flex';
  if ($('webScanAssistBox')) $('webScanAssistBox').style.display = 'none';
  $('scanProgressCard').style.display = 'block';
  $('scanResultsCard').style.display = 'block';
  $('scanProgressBar')?.classList.add('scanning');
  if ($('scanStatusQuick')) $('scanStatusQuick').textContent = 'Đang tiến hành quét...';

  const totalKw = keywords.length;
  updateProgressBar(
    5,
    `Bắt đầu quét ${totalKw} từ khóa...`,
    `Danh sách: ${keywords.slice(0, 3).map(k => `"${k}"`).join(', ')}${totalKw > 3 ? ` và ${totalKw - 3} từ khóa khác` : ''}`
  );
  renderResultsTable();
  updateScanStats();

  // ── Thử khởi động bằng Background Runner qua Tiện ích mở rộng ──
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GROUP_SEARCH_START',
      params: {
        keywords,
        maxCountPerKeyword,
        filterMode,
        minMembers,
        privacyMode,
        dedupeHistory,
        dedupeCategories,
        dedupeName,
        historyKeys: Array.from(historyKeySet),
        categoryKeys: Array.from(categoryKeySet)
      }
    });
    if (res && res.ok && !res.directFallback && !res.webFallback) {
      activeExtensionRun = true;
      if ($('scanStatusQuick')) $('scanStatusQuick').textContent = 'Đang tiến hành quét nhóm Facebook...';
      return;
    }
    if (!isNativeExtensionPage && (!res || !res.ok || res.webFallback || res.extensionUnsupported)) {
      extensionSupportsGroupSearch = false;
      isScanning = false;
      window.__ntdGroupScanning = false;
      chrome.storage?.local?.set?.({ isGroupScanning: false }).catch(() => {});
      startWebAssistedScanner(keywords, { maxCountPerKeyword, filterMode, minMembers, privacyMode });
      return;
    }
  } catch (err) {
    console.warn('[GroupSearch] Runner error, fallback:', err);
    if (!isNativeExtensionPage) {
      extensionSupportsGroupSearch = false;
      isScanning = false;
      window.__ntdGroupScanning = false;
      chrome.storage?.local?.set?.({ isGroupScanning: false }).catch(() => {});
      startWebAssistedScanner(keywords, { maxCountPerKeyword, filterMode, minMembers, privacyMode });
      return;
    }
  }

  try {
    const groupMap = new Map();
    // Đồng bộ sessionScannedUrls, sessionGroupKeys, sessionGroupNames với groupMap hiện có
    currentScannedGroups.forEach(g => {
      groupMap.set(g.url, g);
      sessionScannedUrls.add(g.url);
      const key = extractCanonicalGroupKey(g.url);
      if (key) sessionGroupKeys.add(key);
      const normName = normalizeGroupName(g.name);
      if (normName) sessionGroupNames.add(normName);
    });

    // ── GIAI ĐOẠN 1: QUÉT TỪNG TỪ KHÓA TRÊN FACEBOOK ────────────────────────
    for (let kwIdx = 0; kwIdx < totalKw; kwIdx++) {
      if (!isScanning) break;
      const currentKw = keywords[kwIdx];
      const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(currentKw)}`;

      const basePct = (kwIdx / totalKw) * 40;
      updateProgressBar(
        basePct,
        `[Từ khóa ${kwIdx + 1}/${totalKw}] "${currentKw}"`,
        `Đang mở kết quả tìm kiếm Facebook cho từ khóa "${currentKw}"...`
      );

      // Mở tab mới ở từ khóa đầu tiên, tái sử dụng tab ở các từ khóa tiếp theo
      // Đánh dấu autoDiscardable: false để Chrome không tự đóng băng/discard tab ngầm
      if (!scanTabId) {
        const tab = await chrome.tabs.create({ url: searchUrl, active: false });
        scanTabId = tab.id;
        await chrome.tabs.update(scanTabId, { autoDiscardable: false }).catch(() => {});
      } else {
        await chrome.tabs.update(scanTabId, { url: searchUrl, autoDiscardable: false }).catch(() => {});
      }

      // Đăng ký scanTabId vào storage để Đăng bài / Nuôi nick không bao giờ can thiệp hoặc đóng nhầm
      await chrome.storage.local.set({ groupScanTabId: scanTabId, isGroupScanning: true }).catch(() => {});

      await waitForTab(scanTabId, 15000);
      if (!isScanning) break;

      // Kiểm tra trạng thái đăng nhập (xử lý mềm dẻo nếu có tab khác đang đổi cookies ngắn hạn)
      let currentTabInfo = await chrome.tabs.get(scanTabId).catch(() => null);
      if (currentTabInfo?.url && (currentTabInfo.url.includes('/login') || currentTabInfo.url.includes('checkpoint'))) {
        // Đợi 2.5s để tab đăng bài hoặc nuôi nick hoàn tất nạp cookie
        await new Promise(r => setTimeout(r, 2500));
        currentTabInfo = await chrome.tabs.get(scanTabId).catch(() => null);
        if (currentTabInfo?.url && (currentTabInfo.url.includes('/login') || currentTabInfo.url.includes('checkpoint'))) {
          // Thử nạp lại searchUrl 1 lần nữa với cookies mới
          await chrome.tabs.update(scanTabId, { url: searchUrl });
          await waitForTab(scanTabId, 10000);
          currentTabInfo = await chrome.tabs.get(scanTabId).catch(() => null);
        }
      }

      if (currentTabInfo?.url && (currentTabInfo.url.includes('/login') || currentTabInfo.url.includes('checkpoint'))) {
        showToast('⚠️ Facebook chuyển hướng sang đăng nhập. Đang tạm dừng quét nhóm...', 4000);
        await stopScanningProcess(false);
        return;
      }

      // Giữ tab ở trạng thái visible giả lập và kích hoạt Main World hooks ngay khi mở tab
      await chrome.scripting.executeScript({
        target: { tabId: scanTabId },
        world: 'MAIN',
        func: scrollAndTriggerFacebookSearch,
        args: [0]
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 1800));
      if (!isScanning) break;

      // Vòng lặp cuộn trang thu thập nhóm của từ khóa này
      let stagnantCount = 0;
      let round = 0;
      let countForThisKw = 0;
      const processedDomUrls = new Set();

      while (isScanning && countForThisKw < maxCountPerKeyword && stagnantCount < 25) {
        round++;
        const res = await chrome.scripting.executeScript({
          target: { tabId: scanTabId },
          func: extractGroupsFromFacebookSearch
        }).catch(() => null);

        const items = res?.[0]?.result || [];
        let newCount = 0;
        const newGroupObjs = [];

        for (const item of items) {
          if (privacyMode === 'public_only' && item.privacy === 'Riêng tư') continue;
          if (privacyMode === 'private_only' && item.privacy === 'Công khai') continue;

          // Bỏ qua ngay nếu DOM node của nhóm này đã được đọc ở các vòng cuộn trước
          // Tuyệt đối không tính vào bộ đếm trùng lặp để tránh đếm ảo
          if (processedDomUrls.has(item.url)) {
            continue;
          }
          processedDomUrls.add(item.url);

          // 0. Kiểm tra bộ lọc số lượng thành viên tối thiểu (VD: >= 10.000 thành viên)
          const memberCount = parseMemberCount(item.members);
          if (minMembers > 0 && memberCount < minMembers) {
            lowMembersSkippedTotal++;
            continue;
          }

          const key = extractCanonicalGroupKey(item.url);
          const normName = normalizeGroupName(item.name);
          const hasSignificantName = normName && normName.length >= 5 && !/^\d+$/.test(normName);

          // 1. Kiểm tra trùng bộ nhớ các phiên quét trước đây
          if (dedupeHistory && key && historyKeySet.has(key)) {
            duplicateSkippedTotal++;
            continue;
          }

          // 2. Kiểm tra trùng nhóm đã lưu trong Danh mục
          if (dedupeCategories && key && categoryKeySet.has(key)) {
            duplicateSkippedTotal++;
            continue;
          }

          // 3. Kiểm tra trùng trong phiên quét hiện tại theo canonical key hoặc URL
          if (sessionScannedUrls.has(item.url) || (key && sessionGroupKeys.has(key))) {
            duplicateSkippedTotal++;
            // Bổ sung tag từ khóa nếu cùng phiên
            const existing = groupMap.get(item.url) || (key ? Array.from(groupMap.values()).find(g => extractCanonicalGroupKey(g.url) === key) : null);
            if (existing && existing.keyword && !existing.keyword.includes(currentKw)) {
              existing.keyword += `, ${currentKw}`;
            }
            continue;
          }

          // 4. Kiểm tra trùng tên nhóm giữa các từ khóa (kể cả khác link hoặc link số)
          if (dedupeName && hasSignificantName && sessionGroupNames.has(normName)) {
            duplicateSkippedTotal++;
            const existing = Array.from(groupMap.values()).find(g => normalizeGroupName(g.name) === normName);
            if (existing && existing.keyword && !existing.keyword.includes(currentKw)) {
              existing.keyword += `, ${currentKw}`;
            }
            continue;
          }

          // Nhóm mới hợp lệ!
          const isNumericName = /^\d+$/.test(item.name.trim());
          const groupObj = {
            id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: isNumericName ? item.url.match(/\/groups\/([^\/]+)\/?$/)?.[1] || item.name : item.name,
            url: item.url,
            privacy: item.privacy,
            members: item.members,
            memberCount: memberCount,
            keyword: currentKw,
            approvalStatus: checkApproval ? 'loading' : 'uninspected',
            approvalLabel: checkApproval ? 'Đang chờ kiểm tra...' : 'Chưa kiểm tra',
            approvalBadge: checkApproval ? '⏳ Đang chờ' : '⚪ Chưa kiểm tra',
            selected: true
          };

          groupMap.set(item.url, groupObj);
          sessionScannedUrls.add(item.url);
          if (key) {
            sessionGroupKeys.add(key);
            newDiscoveredKeysToSave.push(key);
          }
          if (hasSignificantName) {
            sessionGroupNames.add(normName);
          }

          currentScannedGroups.push(groupObj);
          newGroupObjs.push(groupObj);
          newCount++;
          countForThisKw++;
          if (countForThisKw >= maxCountPerKeyword) break;
        }

        // Đồng bộ số lượng nhóm nhận được từ Tab Facebook (fb_scroll_hook.js) hoặc Runner
        if (currentScannedGroups.length > groupMap.size) {
          currentScannedGroups.forEach(g => {
            if (!groupMap.has(g.url)) {
              groupMap.set(g.url, g);
              newCount++;
              countForThisKw++;
            }
          });
        }

        if (newCount === 0) {
          stagnantCount++;
        } else {
          stagnantCount = 0;
          // Hiệu năng cao: Chỉ thêm dòng mới vào DOM, không vẽ lại toàn bộ bảng gây lag
          if (newGroupObjs.length > 0) {
            appendNewScannedGroups(newGroupObjs);
            saveScannedGroupsToStorage();
          }
        }

        const kwProgressSlice = (Math.min(countForThisKw, maxCountPerKeyword) / maxCountPerKeyword) * (40 / totalKw);
        const currentPct = basePct + kwProgressSlice;

        const minMembersLabel = minMembers >= 1000 ? `${Math.round(minMembers / 1000)}k` : `${minMembers}`;
        updateProgressBar(
          currentPct,
          `[Từ khóa ${kwIdx + 1}/${totalKw}: "${currentKw}"] Thu thập ${countForThisKw}/${maxCountPerKeyword} nhóm...`,
          `Tổng nhóm duy nhất đã gom: ${groupMap.size} nhóm (Cuộn vòng ${round} - Mới: +${newCount}${duplicateSkippedTotal > 0 ? ` | Trùng: ${duplicateSkippedTotal}` : ''}${lowMembersSkippedTotal > 0 ? ` | <${minMembersLabel} TV: ${lowMembersSkippedTotal}` : ''})`
        );
        if ($('scanProgressCount')) $('scanProgressCount').textContent = `${groupMap.size} nhóm`;
        updateScanStats();

        if (countForThisKw >= maxCountPerKeyword) break;

        // Cuộn tức thì và phát sự kiện đánh thức Facebook trong MAIN world của tab nền
        const scrollRes = await chrome.scripting.executeScript({
          target: { tabId: scanTabId },
          world: 'MAIN',
          func: scrollAndTriggerFacebookSearch,
          args: [stagnantCount]
        }).catch(() => null);

        const scrollInfo = scrollRes?.[0]?.result;
        if (scrollInfo?.endOfResults && stagnantCount >= 3) {
          break;
        }

        // Delay thông minh: Nếu chưa có bài mới thì đợi Facebook nạp GraphQL (2000ms), nếu vừa có thì tiếp tục nhanh (1100ms)
        if (newCount === 0) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          await new Promise(r => setTimeout(r, 1100));
        }
      }

      // Lưu lại các nhóm mới phát hiện vào bộ nhớ lịch sử để các lần quét sau không bị trùng
      if (newDiscoveredKeysToSave.length > 0) {
        saveScannedGroupHistory(newDiscoveredKeysToSave);
      }
      await saveScannedGroupsToStorage(true);

      if (!isScanning) break;

      // Nghỉ ngắn giữa các từ khóa để tránh Facebook chặn
      if (kwIdx < totalKw - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    if (!isScanning) return;

    if (currentScannedGroups.length === 0) {
      updateProgressBar(100, 'Không tìm thấy nhóm nào', `Không tìm thấy nhóm phù hợp với các từ khóa đã nhập.`);
      showToast('Không tìm thấy nhóm nào. Hãy thử từ khóa khác.');
      await stopScanningProcess(false);
      return;
    }

    // ── GIAI ĐOẠN 2: KIỂM ĐỊNH DUYỆT BÀI TỪNG NHÓM (NẾU BẬT) ───────────────
    if (checkApproval) {
      const groupsToCheck = currentScannedGroups.filter(g =>
        !['free', 'approval', 'private', 'admin_only'].includes(g.approvalStatus)
      );
      const totalToCheck = groupsToCheck.length;
      for (let i = 0; i < totalToCheck; i++) {
        if (!isScanning) break;
        const grp = groupsToCheck[i];

        grp.approvalStatus = 'loading';
        grp.approvalLabel = 'Đang kiểm tra...';
        grp.approvalBadge = '⏳ Đang kiểm tra';
        // Chỉ cập nhật trạng thái dòng của nhóm này
        updateGroupRowStatus(grp);

        const pct = 40 + ((i + 1) / totalToCheck) * 55;
        updateProgressBar(
          pct,
          `Kiểm tra duyệt bài (${i + 1}/${totalToCheck})...`,
          `Đang duyệt: "${grp.name.slice(0, 35)}..." (Từ khóa: ${grp.keyword || '—'})`
        );
        if ($('scanProgressCount')) $('scanProgressCount').textContent = `${i + 1}/${totalToCheck}`;

        try {
          await chrome.tabs.update(scanTabId, { url: grp.url, autoDiscardable: false });
          await waitForTab(scanTabId, 12000);

          if (!isScanning) break;

          await chrome.scripting.executeScript({
            target: { tabId: scanTabId },
            world: 'MAIN',
            func: () => {
              try {
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
                Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                document.hasFocus = () => true;
                window.hasFocus = () => true;
              } catch (_) {}
            }
          }).catch(() => {});

          await new Promise(r => setTimeout(r, 2200));
          if (!isScanning) break;

          // ── Lấy tên nhóm từ trang nếu tên hiện tại vẫn là dạng ID/slug thuần số ──
          const needsNameUpdate = /^\d+$/.test(grp.name.trim()) || grp.name === grp.url.match(/\/groups\/([^\/]+)\/?$/)?.[1];
          if (needsNameUpdate) {
            const nameRes = await chrome.scripting.executeScript({
              target: { tabId: scanTabId },
              func: () => {
                // Thử lấy tên từ h1, og:title, hoặc title
                const h1 = document.querySelector('h1');
                if (h1 && h1.innerText.trim().length > 1) return h1.innerText.trim();
                const ogTitle = document.querySelector('meta[property="og:title"]');
                if (ogTitle) return ogTitle.getAttribute('content')?.trim() || '';
                return document.title.replace(/\s*\|.*$/, '').trim();
              }
            }).catch(() => null);
            const resolvedName = nameRes?.[0]?.result;
            if (resolvedName && resolvedName.length > 1 && !/^\d+$/.test(resolvedName)) {
              grp.name = resolvedName.slice(0, 90);
            }
          }

          const checkRes = await chrome.scripting.executeScript({
            target: { tabId: scanTabId },
            func: inspectGroupApprovalInTab
          }).catch(() => null);

          const r = checkRes?.[0]?.result;
          if (r) {
            grp.approvalStatus = r.status;
            grp.approvalLabel = r.label;
            grp.approvalBadge = r.badge;
          } else {
            grp.approvalStatus = 'uninspected';
            grp.approvalLabel = 'Không phản hồi';
            grp.approvalBadge = '⚪ Chưa rõ';
          }
        } catch (e) {
          grp.approvalStatus = 'uninspected';
          grp.approvalLabel = 'Lỗi kết nối';
          grp.approvalBadge = '⚪ Lỗi';
        }

        updateScanStats();
        updateGroupRowStatus(grp);
        saveScannedGroupsToStorage();
      }
    }

    // ── GIAI ĐOẠN 3: HOÀN TẤT QUÉT ──────────────────────────────────────────
    if (newDiscoveredKeysToSave.length > 0) {
      await saveScannedGroupHistory(newDiscoveredKeysToSave);
    }
    await saveScannedGroupsToStorage(true);

    const minMembersLabel = minMembers >= 1000 ? `${Math.round(minMembers / 1000)}k` : `${minMembers}`;
    updateProgressBar(
      100,
      '✅ Quét nhóm hoàn tất!',
      `Đã quét xong ${currentScannedGroups.length} nhóm duy nhất từ ${totalKw} từ khóa${duplicateSkippedTotal > 0 ? ` (Đã tự động loại bỏ ${duplicateSkippedTotal} nhóm trùng lặp)` : ''}${lowMembersSkippedTotal > 0 ? ` (Đã bỏ qua ${lowMembersSkippedTotal} nhóm <${minMembersLabel} thành viên)` : ''}.`
    );
    showToast(`🎉 Quét xong ${currentScannedGroups.length} nhóm duy nhất${duplicateSkippedTotal > 0 ? ` (Đã lọc ${duplicateSkippedTotal} trùng)` : ''}${lowMembersSkippedTotal > 0 ? ` (${lowMembersSkippedTotal} nhóm <${minMembersLabel} TV)` : ''}!`);

    // Tự động kích hoạt bộ lọc ưu tiên đã chọn (chỉ kích hoạt filter duyệt bài nếu có nhóm thuộc trạng thái đó)
    if (filterMode === 'free_only' && currentScannedGroups.some(g => g.approvalStatus === 'free')) {
      applyFilter('free');
    } else if (filterMode === 'approval_only' && currentScannedGroups.some(g => g.approvalStatus === 'approval')) {
      applyFilter('approval');
    } else if (privacyMode === 'public_only' && currentScannedGroups.some(g => g.privacy === 'Công khai')) {
      applyFilter('public');
    } else if (privacyMode === 'private_only' && currentScannedGroups.some(g => g.privacy === 'Riêng tư' || g.approvalStatus === 'private')) {
      applyFilter('private');
    } else {
      applyFilter('all');
    }

  } catch (err) {
    console.error('Lỗi khi quét nhóm:', err);
    updateProgressBar(100, '❌ Lỗi trong quá trình quét', err.message);
    showToast('Lỗi khi quét nhóm: ' + err.message);
  } finally {
    await stopScanningProcess(false);
  }
}

function applyPostScanFilter() {
  const filterMode = activeScanConfig?.filterMode || $('scanFilterMode')?.value || 'free_only';
  const privacyMode = activeScanConfig?.privacyMode || $('scanPrivacyMode')?.value || 'public_only';

  if (filterMode === 'free_only' && currentScannedGroups.some(g => g.approvalStatus === 'free')) {
    applyFilter('free');
  } else if (filterMode === 'approval_only' && currentScannedGroups.some(g => g.approvalStatus === 'approval')) {
    applyFilter('approval');
  } else if (privacyMode === 'public_only' && currentScannedGroups.some(g => g.privacy === 'Công khai')) {
    applyFilter('public');
  } else if (privacyMode === 'private_only' && currentScannedGroups.some(g => g.privacy === 'Riêng tư' || g.approvalStatus === 'private')) {
    applyFilter('private');
  } else {
    applyFilter('all');
  }
}

async function finishExtensionScanUI({ stopped = false } = {}) {
  isScanning = false;
  activeExtensionRun = false;
  window.__ntdGroupScanning = false;

  if ($('startScanBtn')) $('startScanBtn').style.display = 'inline-flex';
  if ($('stopScanBtn')) {
    $('stopScanBtn').style.display = 'none';
    $('stopScanBtn').textContent = '⏹ Dừng quét';
  }
  if ($('focusScanTabBtn')) $('focusScanTabBtn').style.display = 'none';
  if ($('webScanAssistBox')) $('webScanAssistBox').style.display = 'none';
  $('scanProgressBar')?.classList.remove('scanning');
  if ($('scanStatusQuick')) {
    $('scanStatusQuick').textContent = stopped ? 'Đã dừng quét.' : 'Hoàn tất.';
  }

  let fixedLoading = false;
  currentScannedGroups.forEach(g => {
    if (g.approvalStatus === 'loading') {
      g.approvalStatus = 'uninspected';
      g.approvalLabel = stopped ? 'Đã dừng trước khi kiểm tra' : 'Chưa kiểm tra';
      g.approvalBadge = '⚪ Chưa kiểm tra';
      fixedLoading = true;
    }
  });

  await chrome.storage.local.set({ groupScanTabId: null, isGroupScanning: false }).catch(() => {});
  await saveScannedGroupsToStorage(true);
  try { chrome.power?.releaseKeepAwake?.(); } catch (_) {}

  updateScanStats();
  applyPostScanFilter();

  const total = currentScannedGroups.length;
  const freeCnt = currentScannedGroups.filter(g => g.approvalStatus === 'free').length;
  const appCnt = currentScannedGroups.filter(g => g.approvalStatus === 'approval').length;
  const pubCnt = currentScannedGroups.filter(g => g.privacy === 'Công khai').length;
  const privCnt = currentScannedGroups.filter(g => g.privacy === 'Riêng tư' || g.approvalStatus === 'private').length;
  if ($('scanProgressCount')) $('scanProgressCount').textContent = `${total} nhóm`;

  const breakdown = `Công khai: ${pubCnt} | Đăng tự do: ${freeCnt} | Cần duyệt: ${appCnt} | Riêng tư: ${privCnt}`;
  if (stopped) {
    updateProgressBar(100, '⏹ Đã dừng quét nhóm', `Đã giữ lại ${total} nhóm (${breakdown}).`);
    showToast(`Đã dừng quét nhóm (${total} nhóm).`);
  } else {
    updateProgressBar(100, '✅ Quét & phân loại nhóm hoàn tất!', `Tổng ${total} nhóm (${breakdown}).`);
    showToast(`🎉 Hoàn tất! ${breakdown}`);
  }
  if (fixedLoading && currentActiveFilter === 'all') renderResultsTable();
}

async function stopScanningProcess(userCancelled = true) {
  const wasWebMode = webScanState.active;
  isScanning = false;
  activeExtensionRun = false;
  window.__ntdGroupScanning = false;
  webScanState.active = false;

  if (!wasWebMode) {
    try {
      await chrome.runtime.sendMessage({ type: 'GROUP_SEARCH_STOP' }).catch(() => {});
    } catch (_) {}
    currentScannedGroups.forEach(g => {
      if (g.approvalStatus === 'loading') {
        g.approvalStatus = 'uninspected';
        g.approvalLabel = userCancelled ? 'Đã dừng trước khi kiểm tra' : 'Chưa kiểm tra';
        g.approvalBadge = '⚪ Chưa kiểm tra';
      }
    });
  }

  if ($('startScanBtn')) $('startScanBtn').style.display = 'inline-flex';
  if ($('stopScanBtn')) {
    $('stopScanBtn').style.display = 'none';
    $('stopScanBtn').textContent = '⏹ Dừng quét';
  }
  if ($('focusScanTabBtn')) $('focusScanTabBtn').style.display = 'none';
  if ($('webScanAssistBox')) $('webScanAssistBox').style.display = 'none';
  $('scanProgressBar')?.classList.remove('scanning');
  if ($('scanStatusQuick')) {
    $('scanStatusQuick').textContent = (userCancelled && !wasWebMode) ? 'Đã dừng quét.' : 'Sẵn sàng.';
  }

  // Giải phóng trạng thái quét nhóm trong storage
  await chrome.storage.local.set({ groupScanTabId: null, isGroupScanning: false }).catch(() => {});
  await saveScannedGroupsToStorage(true);

  try {
    chrome.power?.releaseKeepAwake?.();
  } catch (_) {}

  if (scanTabId) {
    try {
      await chrome.tabs.remove(scanTabId);
    } catch (_) {}
    scanTabId = null;
  }

  if (!wasWebMode) {
    updateScanStats();
    renderResultsTable();
  }

  if (userCancelled) {
    if (wasWebMode) {
      updateProgressBar(100, '✅ Đã đóng khung thu thập Web', `Hiện có ${currentScannedGroups.length} nhóm trong bảng kết quả bên dưới.`);
      showToast('Đã đóng khung thu thập Web.');
    } else {
      updateProgressBar(100, '⏹ Đã dừng quét', 'Người dùng đã bấm dừng.');
      showToast('Đã dừng tiến trình quét nhóm.');
    }
  }
}

// Cảnh báo người dùng nếu vô tình đóng tab groups.html khi đang quét
window.addEventListener('beforeunload', (e) => {
  if (isScanning) {
    e.preventDefault();
    e.returnValue = 'Tiến trình quét nhóm đang chạy. Bạn có chắc muốn rời đi?';
    return e.returnValue;
  }
});

// ── Results Table Rendering & Filtering ───────────────────────────────────────
const FILTER_LABELS = {
  all: 'Tất cả',
  public: 'Công khai',
  free: 'Đăng tự do',
  approval: 'Cần kiểm duyệt',
  private: 'Riêng tư'
};

function matchesActiveFilter(grp, filterKey = currentActiveFilter) {
  if (!grp) return false;
  if (filterKey === 'public') return grp.privacy === 'Công khai';
  if (filterKey === 'free') return grp.approvalStatus === 'free';
  if (filterKey === 'approval') return grp.approvalStatus === 'approval';
  if (filterKey === 'private') return grp.privacy === 'Riêng tư' || grp.approvalStatus === 'private';
  return true;
}

function getPrivacyBadgeInfo(privacy) {
  if (privacy === 'Công khai') return { cls: 'public', text: 'Công khai' };
  if (privacy === 'Riêng tư') return { cls: 'private', text: 'Riêng tư' };
  return { cls: 'unknown', text: 'Chưa rõ' };
}

function createGroupRow(grp, idx) {
  const tr = document.createElement('tr');
  tr.id = `scanRow_${grp.id}`;

  const badgeClass = ['free', 'approval', 'private', 'admin_only', 'loading'].includes(grp.approvalStatus)
    ? grp.approvalStatus
    : 'uninspected';
  const privInfo = getPrivacyBadgeInfo(grp.privacy);

  tr.innerHTML = `
    <td style="text-align:center">
      <input type="checkbox" class="row-checkbox" data-id="${grp.id}" ${grp.selected ? 'checked' : ''}>
    </td>
    <td style="text-align:center;color:#94a3b8;font-size:12px" class="row-index">${idx + 1}</td>
    <td>
      <div style="font-weight:700;color:var(--text, #0f172a);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="group-row-name">${escapeHtml(grp.name)}</span>
        ${grp.keyword ? `<span style="font-size:10.5px;background:rgba(237,107,34,0.12);color:var(--accent);padding:1px 6px;border-radius:4px;font-weight:600">🏷️ ${escapeHtml(grp.keyword)}</span>` : ''}
      </div>
      <div style="font-size:11px;color:#64748b;margin-top:2px;font-family:monospace">
        ${escapeHtml(grp.url)}
      </div>
    </td>
    <td>
      <span class="badge-status ${badgeClass}" title="${escapeHtml(grp.approvalLabel || '')}">
        ${escapeHtml(grp.approvalBadge || 'Chưa rõ')}
      </span>
    </td>
    <td>
      <span class="privacy-badge ${privInfo.cls}">
        ${privInfo.text}
      </span>
    </td>
    <td style="font-size:12px;color:#94a3b8">
      ${escapeHtml(grp.members || '—')}
    </td>
    <td style="text-align:center">
      <a href="${grp.url}" target="_blank" rel="noopener noreferrer" class="act-btn" style="padding:4px 8px;font-size:11px" title="Mở nhóm trên Facebook">
        Mở
      </a>
    </td>
  `;

  return tr;
}

function appendNewScannedGroups(newGroups) {
  const tbody = $('scanResultsBody');
  if (!tbody || !newGroups || !newGroups.length) return;

  const frag = document.createDocumentFragment();
  let addedRowCount = 0;
  const currentCount = tbody.children.length;
  newGroups.forEach((grp) => {
    if (!matchesActiveFilter(grp)) return;
    frag.appendChild(createGroupRow(grp, currentCount + addedRowCount));
    addedRowCount++;
  });
  if (addedRowCount > 0) {
    if ($('emptyScanState')) $('emptyScanState').style.display = 'none';
    tbody.appendChild(frag);
  }
  syncHeaderCheckbox();
}

function updateGroupRowStatus(grp) {
  const tr = document.getElementById(`scanRow_${grp.id}`);
  if (!tr) return;
  const badgeCell = tr.querySelector('.badge-status');
  if (badgeCell) {
    const badgeClass = ['free', 'approval', 'private', 'admin_only', 'loading'].includes(grp.approvalStatus)
      ? grp.approvalStatus
      : 'uninspected';
    badgeCell.className = `badge-status ${badgeClass}`;
    badgeCell.title = grp.approvalLabel || '';
    badgeCell.textContent = grp.approvalBadge || 'Chưa rõ';
  }
  const nameSpan = tr.querySelector('.group-row-name');
  if (nameSpan && grp.name) {
    nameSpan.textContent = grp.name;
  }
  const privSpan = tr.querySelector('.privacy-badge');
  if (privSpan) {
    const privInfo = getPrivacyBadgeInfo(grp.privacy);
    privSpan.className = `privacy-badge ${privInfo.cls}`;
    privSpan.textContent = privInfo.text;
  }
}

function renderResultsTable() {
  const tbody = $('scanResultsBody');
  if (!tbody) return;

  const filtered = currentScannedGroups.filter(g => matchesActiveFilter(g));

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if ($('emptyScanState')) $('emptyScanState').style.display = 'block';
    syncHeaderCheckbox();
    return;
  }

  if ($('emptyScanState')) $('emptyScanState').style.display = 'none';
  
  const frag = document.createDocumentFragment();
  filtered.forEach((grp, idx) => {
    frag.appendChild(createGroupRow(grp, idx));
  });

  tbody.replaceChildren(frag);
  syncHeaderCheckbox();
}

function syncHeaderCheckbox() {
  const filtered = currentScannedGroups.filter(g => matchesActiveFilter(g));

  const headerCb = $('headerCheckbox');
  if (!headerCb) return;
  if (filtered.length === 0) {
    headerCb.checked = false;
  } else {
    headerCb.checked = filtered.every(g => g.selected);
  }
}

function applyFilter(filterKey) {
  currentActiveFilter = filterKey;
  document.querySelectorAll('#resultsFilterGroup .filter-pill-btn').forEach(btn => {
    if (btn.dataset.filter === filterKey) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  renderResultsTable();
}

// ── Batch Actions & Events ────────────────────────────────────────────────────
document.querySelectorAll('#resultsFilterGroup .filter-pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyFilter(btn.dataset.filter);
  });
});

$('selectAllResultsBtn')?.addEventListener('click', () => {
  currentScannedGroups.forEach(g => {
    if (!matchesActiveFilter(g)) return;
    g.selected = true;
  });
  const tbody = $('scanResultsBody');
  if (tbody) {
    tbody.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = true; });
  }
  syncHeaderCheckbox();
  saveScannedGroupsToStorage();
});

$('deselectAllResultsBtn')?.addEventListener('click', () => {
  currentScannedGroups.forEach(g => {
    if (!matchesActiveFilter(g)) return;
    g.selected = false;
  });
  const tbody = $('scanResultsBody');
  if (tbody) {
    tbody.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = false; });
  }
  syncHeaderCheckbox();
  saveScannedGroupsToStorage();
});

$('headerCheckbox')?.addEventListener('change', e => {
  const isChecked = e.target.checked;
  currentScannedGroups.forEach(g => {
    if (!matchesActiveFilter(g)) return;
    g.selected = isChecked;
  });
  const tbody = $('scanResultsBody');
  if (tbody) {
    tbody.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = isChecked; });
  }
  syncHeaderCheckbox();
  saveScannedGroupsToStorage();
});

// Lắng nghe sự kiện tick/bỏ tick từng dòng checkbox
$('scanResultsBody')?.addEventListener('change', e => {
  if (e.target && e.target.classList.contains('row-checkbox')) {
    const id = e.target.dataset.id;
    const grp = currentScannedGroups.find(g => g.id === id);
    if (grp) {
      grp.selected = e.target.checked;
      syncHeaderCheckbox();
      saveScannedGroupsToStorage();
    }
  }
});

// Xóa toàn bộ dữ liệu nhóm đã quét
$('clearScannedResultsBtn')?.addEventListener('click', async () => {
  if (!currentScannedGroups || currentScannedGroups.length === 0) {
    showToast('Danh sách nhóm đã quét hiện đang trống.');
    return;
  }
  if (!confirm(`Bạn có chắc muốn xóa toàn bộ ${currentScannedGroups.length} nhóm đã quét trong danh sách?\n(Dữ liệu trong các danh mục nhóm đã lưu sẽ KHÔNG bị ảnh hưởng)`)) {
    return;
  }
  if (isScanning || webScanState.active) {
    await stopScanningProcess(true);
  }
  currentScannedGroups = [];
  duplicateSkippedTotal = 0;
  lowMembersSkippedTotal = 0;
  privacySkippedTotal = 0;
  await chrome.storage.local.remove('lastScannedGroups');
  renderResultsTable();
  updateScanStats();
  if ($('scanResultsCard')) $('scanResultsCard').style.display = 'none';
  if ($('scanProgressCard')) $('scanProgressCard').style.display = 'none';
  showToast('🗑️ Đã xóa toàn bộ kết quả nhóm đã quét.');
});

// Chuyển nhanh đến tab Facebook đang quét
$('focusScanTabBtn')?.addEventListener('click', () => {
  if (webScanState.active) {
    const activeKw = webScanState.keywords[webScanState.activeKwIdx] || parseKeywords($('scanKeyword')?.value)[0] || '';
    focusExistingWebScanTab(buildFbGroupSearchUrl(activeKw));
    return;
  }
  chrome.runtime.sendMessage({ type: 'GROUP_SEARCH_SHOW_TAB' }).catch(() => {});
  if (scanTabId) {
    (async () => {
      try {
        await chrome.tabs.update(scanTabId, { active: true });
        const tab = await chrome.tabs.get(scanTabId);
        if (tab?.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (_) {
        showToast('Tab quét không còn tồn tại.');
      }
    })();
  }
});

// Tự động giải phóng nếu người dùng tự đóng tab Facebook
chrome.tabs?.onRemoved?.addListener?.(tabId => {
  if (tabId === scanTabId) {
    scanTabId = null;
    if ($('focusScanTabBtn')) $('focusScanTabBtn').style.display = 'none';
  }
});

// ── Xử lý nhóm Facebook mới tìm thấy (từ Extension Runner hoặc từ Tab Facebook trực tiếp) ──
function handleDiscoveredGroup(g, fromExtensionRunner = false) {
  if (!isScanning || !g || !g.url) return;

  const privacyMode = activeScanConfig?.privacyMode || $('scanPrivacyMode')?.value || 'public_only';
  if (privacyMode === 'public_only' && g.privacy !== 'Công khai') return;
  if (privacyMode === 'private_only' && g.privacy !== 'Riêng tư') return;

  const minMembers = activeScanConfig?.minMembers ?? parseInt($('scanMinMembers')?.value || '10000', 10);
  const memCount = g.memberCount || parseMemberCount(g.members);
  if (minMembers > 0 && memCount < minMembers) return;

  // Chống quét trùng URL
  if (currentScannedGroups.some(x => x.url === g.url)) return;

  const filterMode = activeScanConfig?.filterMode || $('scanFilterMode')?.value || 'free_only';
  const checkApproval = filterMode !== 'all';
  if (!g.approvalStatus || (checkApproval && g.approvalStatus === 'uninspected')) {
    if (checkApproval) {
      g.approvalStatus = 'loading';
      g.approvalBadge = '⏳ Đang chờ';
      g.approvalLabel = 'Đang chờ kiểm tra duyệt bài...';
    } else if (g.privacy === 'Riêng tư') {
      g.approvalStatus = 'private';
      g.approvalBadge = '🔒 Riêng tư';
      g.approvalLabel = 'Nhóm riêng tư (Quyền riêng tư trên Facebook)';
    } else {
      g.approvalStatus = 'uninspected';
      g.approvalBadge = '🌐 Công khai (Chưa check bài)';
      g.approvalLabel = 'Chưa bật kiểm tra duyệt từng bài';
    }
  }

  currentScannedGroups.push(g);
  appendNewScannedGroups([g]);
  updateScanStats();
  saveScannedGroupsToStorage();

  if ($('scanProgressCount')) $('scanProgressCount').textContent = `${currentScannedGroups.length} nhóm`;

  // Khi chạy Extension background runner (Stage 1 + Stage 2), tuyệt đối KHÔNG tự ý dừng ở đây
  // để Extension tiếp tục chạy sang Stage 2 kiểm tra từng nhóm Đăng tự do vs Cần kiểm duyệt!
  if (fromExtensionRunner || activeExtensionRun) {
    return;
  }

  const maxCountPerKeyword = activeScanConfig?.maxCountPerKeyword ?? parseInt($('scanMaxCount')?.value || '30', 10);
  const pct = Math.min(95, Math.round((currentScannedGroups.length / Math.max(1, maxCountPerKeyword)) * 80));
  updateProgressBar(
    pct,
    `Đang thu thập ${currentScannedGroups.length}/${maxCountPerKeyword} nhóm...`,
    `Tổng nhóm duy nhất đã gom: ${currentScannedGroups.length} nhóm`
  );
}

// 1. Lắng nghe thông điệp từ Tab Facebook (fb_scroll_hook.js qua window.opener)
window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.source === 'ntd_fb_search_tab') {
    if (e.data.type === 'GROUP_SEARCH_ITEM' && e.data.group) {
      handleDiscoveredGroup(e.data.group, false);
    } else if (e.data.type === 'GROUP_SEARCH_PROGRESS') {
      updateScanStats();
    }
  }
});

// 2. Lắng nghe sự kiện từ Background Runner (worker.js)
if (chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'GROUP_SEARCH_ITEM' && msg.group) {
      handleDiscoveredGroup(msg.group, true);
    }

    if (msg.type === 'GROUP_SEARCH_STATUS_UPDATE' && msg.url) {
      const g = currentScannedGroups.find(x => x.url === msg.url);
      if (g) {
        g.approvalStatus = msg.approvalStatus;
        g.approvalLabel = msg.approvalLabel;
        g.approvalBadge = msg.approvalBadge;
        if (msg.name && !/^\d+$/.test(String(msg.name).trim())) {
          g.name = msg.name;
        }
        if (msg.privacy) {
          g.privacy = msg.privacy;
        }
        if (currentActiveFilter === 'all') {
          updateGroupRowStatus(g);
        } else {
          renderResultsTable();
        }
        updateScanStats();
        saveScannedGroupsToStorage();
      }
    }

    if (msg.type === 'GROUP_SEARCH_PROGRESS') {
      updateProgressBar(msg.percent, msg.title, msg.detail);
      if (msg.count !== undefined && $('scanProgressCount')) {
        $('scanProgressCount').textContent = `${msg.count} nhóm`;
      }
      updateScanStats();
    }

    if (msg.type === 'GROUP_SEARCH_DONE') {
      finishExtensionScanUI({ stopped: Boolean(msg.stopped), totalFound: msg.totalFound });
    }
  });
}

// ── Helper: lấy danh sách nhóm theo filter đang active ───────────────────────
function getGroupsByActiveFilter() {
  return currentScannedGroups.filter(g => matchesActiveFilter(g));
}

// Copy link – chỉ xuất link theo ô filter đang chọn
$('copySelectedResultsBtn')?.addEventListener('click', async () => {
  // Lấy các nhóm đang hiển thị theo filter, sau đó lọc thêm những cái đã checked
  const visible = getGroupsByActiveFilter();
  const selected = visible.filter(g => g.selected);
  const filterLabel = FILTER_LABELS[currentActiveFilter] || 'hiện tại';
  if (!selected.length) {
    alert(`Vui lòng chọn ít nhất 1 nhóm trong tab "${filterLabel}" để sao chép.`);
    return;
  }
  const text = selected.map(g => g.url).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(`📋 Đã sao chép ${selected.length} link nhóm (${filterLabel}) vào clipboard!`);
  } catch (_) {
    alert('Không thể sao chép tự động: quyền clipboard bị từ chối.');
  }
});

// Lưu thành danh mục mới – xuất theo filter đang chọn
$('saveSelectedToNewCatBtn')?.addEventListener('click', async () => {
  const visible = getGroupsByActiveFilter();
  const selected = visible.filter(g => g.selected);
  const filterLabel = FILTER_LABELS[currentActiveFilter] || 'hiện tại';
  if (!selected.length) {
    alert(`Vui lòng chọn ít nhất một nhóm trong tab "${filterLabel}" để lưu danh mục mới.`);
    return;
  }

  const kws = parseKeywords($('scanKeyword')?.value);
  const kw = kws.slice(0, 2).join(' - ') + (kws.length > 2 ? ` (+${kws.length - 2})` : (kws[0] || 'Facebook'));
  let defaultName = `Nhóm - ${kw}`;
  if (currentActiveFilter === 'public') {
    defaultName = `Nhóm công khai - ${kw}`;
  } else if (currentActiveFilter === 'free') {
    defaultName = `Nhóm không duyệt - ${kw}`;
  } else if (currentActiveFilter === 'approval') {
    defaultName = `Nhóm kiểm duyệt - ${kw}`;
  } else if (currentActiveFilter === 'private') {
    defaultName = `Nhóm riêng tư - ${kw}`;
  }

  const catName = prompt(`Nhập tên danh mục mới cho ${selected.length} nhóm đã chọn:`, defaultName);
  if (!catName || !catName.trim()) return;

  const all = await loadCategories();
  const newCat = {
    id: crypto.randomUUID(),
    name: catName.trim(),
    links: selected.map(g => g.url).join('\n'),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  all.unshift(newCat);
  await saveCategories(all);

  showToast(`✅ Đã lưu danh mục "${catName}" (${selected.length} nhóm)!`);

  // Chuyển sang Tab Danh mục nhóm để người dùng thấy ngay danh mục mới
  $('tabCatManager')?.click();
});

// Nối vào danh mục có sẵn – xuất theo filter đang chọn
$('appendSelectedToCatBtn')?.addEventListener('click', async () => {
  const visible = getGroupsByActiveFilter();
  const selected = visible.filter(g => g.selected);
  const filterLabel = FILTER_LABELS[currentActiveFilter] || 'hiện tại';
  if (!selected.length) {
    alert(`Vui lòng chọn ít nhất một nhóm trong tab "${filterLabel}" để thêm vào danh mục.`);
    return;
  }

  const all = await loadCategories();
  if (!all.length) {
    alert('Bạn chưa có danh mục nhóm nào. Hãy bấm "Lưu thành danh mục mới" trước!');
    return;
  }

  const sel = $('targetCategorySelect');
  if (sel) {
    sel.innerHTML = '';
    all.forEach(c => {
      const linkCount = (c.links || '').split(/\r?\n/).filter(Boolean).length;
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${linkCount} nhóm)`;
      sel.appendChild(opt);
    });
  }

  if ($('modalSelectedCount')) $('modalSelectedCount').textContent = selected.length;
  if ($('appendModal')) $('appendModal').style.display = 'flex';
});

$('cancelAppendModalBtn')?.addEventListener('click', () => {
  if ($('appendModal')) $('appendModal').style.display = 'none';
});

$('confirmAppendModalBtn')?.addEventListener('click', async () => {
  const targetId = $('targetCategorySelect')?.value;
  if (!targetId) return;

  const selected = getGroupsByActiveFilter().filter(g => g.selected);
  const all = await loadCategories();
  const cat = all.find(c => c.id === targetId);
  if (!cat) return;

  const currentLinks = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const newLinks = selected.map(g => g.url);
  const mergedSet = new Set([...currentLinks, ...newLinks]);
  const addedCount = mergedSet.size - currentLinks.length;

  cat.links = Array.from(mergedSet).join('\n');
  cat.updatedAt = Date.now();

  await saveCategories(all);
  if ($('appendModal')) $('appendModal').style.display = 'none';
  showToast(`✅ Đã nối thêm ${addedCount} nhóm mới vào danh mục "${cat.name}"!`);
});

// Nạp trực tiếp vào Bảng đăng bài – xuất theo filter đang chọn
$('useSelectedInPanelBtn')?.addEventListener('click', async () => {
  const visible = getGroupsByActiveFilter();
  const selected = visible.filter(g => g.selected);
  const filterLabel = FILTER_LABELS[currentActiveFilter] || 'hiện tại';
  if (!selected.length) {
    alert(`Vui lòng chọn ít nhất 1 nhóm trong tab "${filterLabel}".`);
    return;
  }

  const { draft } = await chrome.storage.local.get('draft');
  const updatedDraft = { ...(draft || {}), links: selected.map(g => g.url).join('\n') };
  await chrome.storage.local.set({ draft: updatedDraft });

  showToast(`🚀 Đã nạp ${selected.length} nhóm (${filterLabel}). Đang chuyển đến Bảng đăng bài...`);
  setTimeout(() => {
    if (isScanning) {
      chrome.tabs.create({ url: chrome.runtime.getURL('panel.html'), active: true });
    } else {
      window.location.href = chrome.runtime.getURL('panel.html');
    }
  }, 600);
});

// Sự kiện điều khiển Web Assisted Scanner (Lấy clipboard 1 chạm, Ctrl+V, Chuyển từ khóa)
$('readClipboardGroupsBtn')?.addEventListener('click', async () => {
  let html = '';
  let text = '';
  try {
    if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        if (!html && item.types.includes('text/html')) {
          const blob = await item.getType('text/html');
          html = await blob.text();
        }
        if (!text && item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          text = await blob.text();
        }
      }
    } else if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      text = await navigator.clipboard.readText();
    }
  } catch (_) {
    try {
      if (!text && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        text = await navigator.clipboard.readText();
      }
    } catch (_) {}

    if (!html && !text) {
      $('webManualPasteZone')?.focus();
      updateWebFeedback('warn', '⚠️ Trình duyệt chặn đọc clipboard tự động. Hãy click vào khung bên cạnh và bấm Ctrl + V để lấy nhóm ngay!');
      showToast('⚠️ Hãy bấm Ctrl + V trực tiếp vào khung dán bên cạnh!', 4200);
      return;
    }
  }

  if (!html && !text) {
    updateWebFeedback('warn', 'Clipboard hiện đang trống. Hãy quay lại tab Facebook vừa mở và bấm Ctrl + A → Ctrl + C trước.');
    showToast('Clipboard đang trống. Hãy Ctrl + A → Ctrl + C trên tab Facebook trước nhé!');
    return;
  }

  await handleWebClipboardCapture({ html, text });
});

$('webManualPasteZone')?.addEventListener('paste', async (e) => {
  e.preventDefault();
  const html = e.clipboardData?.getData('text/html') || '';
  const text = e.clipboardData?.getData('text/plain') || '';
  if ($('webManualPasteZone')) $('webManualPasteZone').textContent = '';
  await handleWebClipboardCapture({ html, text });
});

$('webManualPasteZone')?.addEventListener('input', () => {
  const el = $('webManualPasteZone');
  if (el && el.textContent.trim()) {
    el.textContent = '';
  }
});

$('webScanNextKwBtn')?.addEventListener('click', () => {
  if (!webScanState.keywords.length) return;
  const nextIdx = (webScanState.activeKwIdx + 1) % webScanState.keywords.length;
  switchWebScanKeyword(nextIdx);
});

document.addEventListener('paste', async (e) => {
  if (!webScanState.active) return;
  const activeEl = document.activeElement;
  if (activeEl === $('webManualPasteZone')) return;
  if (activeEl) {
    const tag = activeEl.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl.isContentEditable) {
      return;
    }
  }
  e.preventDefault();
  const html = e.clipboardData?.getData('text/html') || '';
  const text = e.clipboardData?.getData('text/plain') || '';
  await handleWebClipboardCapture({ html, text });
});

// Nút Bắt đầu / Dừng quét
$('startScanBtn')?.addEventListener('click', startScanningProcess);
$('stopScanBtn')?.addEventListener('click', () => stopScanningProcess(true));

// Dọn dẹp tab quét nếu người dùng đóng hoặc tải lại trang
window.addEventListener('beforeunload', () => {
  if (scanTabId) {
    chrome.tabs.remove(scanTabId).catch(() => {});
  }
});
