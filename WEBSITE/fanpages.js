// fanpages.js – Quản lý Fanpage Facebook chuyên biệt (Max 5 bài/ngày)
import { enforceLicenseGate } from './license.js';
await enforceLicenseGate();
import {
  getTodayDateStr,
  parseUniversalCookies,
  activateAccountSessionDirectly
} from './core.js';

const $ = id => document.getElementById(id);

// ── Msg helper ────────────────────────────────────────────────────────────────
const msg = (text, type = 'ok') => {
  const el = $('msg');
  if (!el) return;
  el.textContent = text;
  el.className = type === 'ok' ? 'msg-ok' : 'msg-err';
  if (type === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
};

// ── Load / Save accounts ──────────────────────────────────────────────────────
async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts || [];
}
async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      await window.chrome.runtime.sendToExtension({
        type: 'SYNC_DATA_TO_EXTENSION',
        data: { accounts }
      });
    } catch (_) {}
  }
}

// ── Validate group links ──────────────────────────────────────────────────────
function validateGroups(groups) {
  if (!groups) return;
  for (const line of groups.split('\n').map(l => l.trim()).filter(Boolean)) {
    try {
      const u = new URL(line);
      const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
      if (!['www.facebook.com', 'facebook.com'].includes(u.hostname) || !m)
        throw new Error(`Link nhóm không hợp lệ: ${line}`);
    } catch { throw new Error(`Link không hợp lệ: ${line}`); }
  }
}

// ── Dropdown danh sách tài khoản cá nhân quản trị ──────────────────────────────
async function updateParentAccountOptions() {
  const accounts = await loadAccounts();
  const personalAccounts = accounts.filter(a => a.type !== 'fanpage');

  const manualSel = $('parentAccountSelect');
  if (manualSel) {
    const curVal = manualSel.value;
    manualSel.replaceChildren();

    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = personalAccounts.length
      ? '-- Chọn tài khoản cá nhân quản trị --'
      : '-- Chưa có tài khoản cá nhân (Vào trang Quản lý tài khoản để thêm trước) --';
    manualSel.appendChild(defOpt);

    for (const acc of personalAccounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = `${acc.name} (${acc.fbId || 'FB ID'})`;
      manualSel.appendChild(opt);
    }
    if (curVal && personalAccounts.some(a => a.id === curVal)) {
      manualSel.value = curVal;
    }
  }
}

// ── Kích hoạt session Facebook cho Fanpage (Profile Pro5) ─────────────────────
async function activateSessionWithFallback(accountId, openFacebookTab = true) {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
  const accounts = await loadAccounts();
  const acc = accounts.find(a => a.id === accountId);

  // 1. Nếu trên Web Platform: Đồng bộ dữ liệu sang Extension Runner và chạy qua Extension
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      await window.chrome.runtime.sendToExtension({
        type: 'SYNC_DATA_TO_EXTENSION',
        data: { accounts }
      });
      const res = await window.chrome.runtime.sendToExtension({
        type: 'ACTIVATE_ACCOUNT_SESSION',
        accountId,
        accountData: acc || null,
        openFacebookTab
      });
      if (res && res.ok) return res;
    } catch (e) {
      console.warn('sendToExtension Fanpage failed:', e);
    }
  }

  // 2. Fallback chrome.runtime.sendMessage
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ACTIVATE_ACCOUNT_SESSION',
      accountId,
      accountData: acc || null,
      openFacebookTab
    });
    if (res && res.ok) return res;
    return await activateAccountSessionDirectly(accountId, openFacebookTab);
  } catch (err) {
    return await activateAccountSessionDirectly(accountId, openFacebookTab);
  }
}

// ── Thêm Fanpage thủ công ─────────────────────────────────────────────────────
$('addManualPageBtn')?.addEventListener('click', async () => {
  const name = $('manualPageName')?.value?.trim();
  const pageId = $('manualPageId')?.value?.trim();
  const parentAccountId = $('parentAccountSelect')?.value;
  const token = $('manualPageToken')?.value?.trim() || null;
  const groups = $('accGroups')?.value?.trim() || '';

  if (!name) { msg('Hãy nhập Tên Fanpage.', 'err'); return; }
  if (!pageId || !/^\d+$/.test(pageId)) { msg('Page ID không hợp lệ (phải là dãy số).', 'err'); return; }
  if (!parentAccountId) { msg('Vui lòng chọn Tài khoản cá nhân quản trị Page này.', 'err'); return; }

  const accounts = await loadAccounts();
  const parentAcc = accounts.find(a => a.id === parentAccountId);
  if (!parentAcc) { msg('Không tìm thấy tài khoản cá nhân quản trị đã chọn.', 'err'); return; }

  if (groups) {
    try { validateGroups(groups); } catch (e) { msg(e.message, 'err'); return; }
  }

  const existingIdx = accounts.findIndex(a => a.type === 'fanpage' && (a.pageId === pageId || a.fbId === pageId));
  const parentCookies = parentAcc.cookies || '';

  if (existingIdx >= 0) {
    accounts[existingIdx].name = name;
    accounts[existingIdx].pageId = pageId;
    accounts[existingIdx].parentAccountId = parentAccountId;
    accounts[existingIdx].parentAccountName = parentAcc.name;
    if (token) accounts[existingIdx].token = token;
    if (groups) accounts[existingIdx].groups = groups;
    if (parentCookies) accounts[existingIdx].cookies = parentCookies;
    if (parentAcc.email) accounts[existingIdx].email = parentAcc.email;
    if (parentAcc.password) accounts[existingIdx].password = parentAcc.password;
    if (parentAcc.twoFactor) accounts[existingIdx].twoFactor = parentAcc.twoFactor;
    accounts[existingIdx].lastCookieSync = Date.now();
    await saveAccounts(accounts);
    msg(`🔄 Đã cập nhật Fanpage "${name}" (Page ID: ${pageId})!`);
  } else {
    accounts.push({
      id: crypto.randomUUID(),
      type: 'fanpage',
      name,
      pageId,
      fbId: pageId,
      token,
      parentAccountId,
      parentAccountName: parentAcc.name,
      cookies: parentCookies,
      email: parentAcc.email || '',
      password: parentAcc.password || '',
      twoFactor: parentAcc.twoFactor || null,
      groups,
      addedVia: 'fanpage_manual',
      lastCookieSync: Date.now()
    });
    await saveAccounts(accounts);
    msg(`✅ Đã thêm Fanpage "${name}" (Page ID: ${pageId}) thành công! Giới hạn tối đa 5 bài/ngày.`);
  }

  if ($('manualPageName')) $('manualPageName').value = '';
  if ($('manualPageId')) $('manualPageId').value = '';
  if ($('manualPageToken')) $('manualPageToken').value = '';
  if ($('accGroups')) $('accGroups').value = '';
  render();
});

$('clearManualPageBtn')?.addEventListener('click', () => {
  if ($('manualPageName')) $('manualPageName').value = '';
  if ($('manualPageId')) $('manualPageId').value = '';
  if ($('manualPageToken')) $('manualPageToken').value = '';
  if ($('accGroups')) $('accGroups').value = '';
  $('msg').textContent = '';
});

// ── Render danh sách Fanpage ──────────────────────────────────────────────────
async function render() {
  const accounts = await loadAccounts();

  // Tự động kiểm tra và kế thừa cookies từ tài khoản cá nhân quản trị
  let accountsChanged = false;
  for (const a of accounts) {
    if (a.type === 'fanpage' && (!a.cookies || a.cookies.length < 50)) {
      const parent = accounts.find(p => p.id === a.parentAccountId) || accounts.find(p => p.type !== 'fanpage' && p.cookies);
      if (parent?.cookies) {
        a.cookies = parent.cookies;
        if (!a.parentAccountId) a.parentAccountId = parent.id;
        if (!a.parentAccountName) a.parentAccountName = parent.name;
        if (parent.email && !a.email) a.email = parent.email;
        if (parent.password && !a.password) a.password = parent.password;
        if (parent.twoFactor && !a.twoFactor) a.twoFactor = parent.twoFactor;
        a.lastCookieSync = Date.now();
        accountsChanged = true;
      }
    }
  }
  if (accountsChanged) {
    await saveAccounts(accounts);
  }

  const { campaigns, groupCategories, dailyPostStats } = await chrome.storage.local.get(['campaigns', 'groupCategories', 'dailyPostStats']);
  const cats = groupCategories || [];
  const statsMap = dailyPostStats || {};
  const todayStr = getTodayDateStr();

  // CHỈ LẤY CÁC TÀI KHOẢN FANPAGE
  const fanpages = accounts.filter(a => a.type === 'fanpage');
  const personalAccounts = accounts.filter(a => a.type !== 'fanpage');

  if ($('countBadge')) {
    $('countBadge').textContent = `${fanpages.length} Fanpage`;
  }

  const list = $('fanpageList');
  if (!list) return;
  list.replaceChildren();

  if (!fanpages.length) {
    list.innerHTML = `
      <div class="empty-state">
        <p>Chưa có Fanpage nào được thêm. Hãy nhập thông tin để thêm Fanpage đầu tiên!</p>
      </div>`;
    return;
  }

  for (const acc of fanpages) {
    const campaign = campaigns?.[acc.id];
    const isRunning = campaign?.state === 'running';
    const pageId = acc.pageId || acc.fbId || '???';

    let statusBadge = `<span class="badge badge-page">Fanpage</span>`;
    statusBadge += ` <span class="badge badge-limit">Max 5 bài/ngày</span>`;
    if (acc.parentAccountName) {
      statusBadge += ` <span class="badge badge-parent">Quản trị: ${acc.parentAccountName}</span>`;
    }
    if (isRunning) {
      statusBadge += ` <span class="badge badge-run">Đang chạy</span>`;
    }

    const groupLines = acc.groups?.trim().split('\n').filter(Boolean) || [];
    const groupInfo = groupLines.length ? `${groupLines.length} nhóm riêng` : `<span style="color:#059669;font-weight:600">Dùng chung nhóm</span>`;

    const syncTimeInfo = acc.lastCookieSync
      ? ` &nbsp;·&nbsp; <span style="color:#059669;font-weight:600">Cookie đồng bộ: ${new Date(acc.lastCookieSync).toLocaleTimeString('vi-VN', {hour12:false})}</span>`
      : ` &nbsp;·&nbsp; <span style="color:#059669">Tự động liên kết</span>`;

    const todayRecord = statsMap[acc.id];
    const todayCount = (todayRecord && todayRecord.date === todayStr) ? (Number(todayRecord.count) || 0) : 0;
    const maxDaily = 5;
    const dailyInfo = ` &nbsp;·&nbsp; Hôm nay: <b style="color:${todayCount >= maxDaily ? '#dc2626' : '#059669'}">${todayCount}/${maxDaily} bài</b>`;

    const card = document.createElement('div');
    card.className = 'acc-card';
    card.id = `card_${acc.id}`;
    card.innerHTML = `
      <div>
        <div class="acc-name">${acc.name} ${statusBadge}</div>
        <div class="acc-meta">
          Page ID: <code class="acc-id-code">${pageId}</code>
          ${syncTimeInfo}
          &nbsp;·&nbsp; Nhóm: ${groupInfo}
          ${dailyInfo}
        </div>
        ${groupLines.length ? `<div class="acc-groups" title="Danh sách nhóm riêng">${groupLines.join('\n')}</div>` : ''}
      </div>
      <div class="acc-actions" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary login-page-btn" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="font-size:11px;padding:4px 10px;font-weight:700" title="Chuyển trình duyệt sang Fanpage Profile Pro5 này trên Facebook">Mở Fanpage</button>
        <button type="button" class="btn btn-light sync-page-cookie-btn" data-id="${acc.id}" title="Đồng bộ cookie mới nhất từ tài khoản cá nhân chủ quản" style="font-size:11px;padding:4px 8px;border:1px solid #059669;color:#059669;font-weight:700">Đồng bộ cookie</button>
        <button class="icon-btn edit-btn" data-id="${acc.id}" title="Chỉnh sửa thông tin &amp; nhóm riêng">✏️</button>
        <button class="icon-btn del" data-id="${acc.id}" title="Xóa Fanpage này">🗑</button>
      </div>
      <div class="acc-edit-box" id="editBox_${acc.id}" style="display:none">
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Tên Fanpage:</span>
          <input type="text" class="edit-name" value="${acc.name.replace(/"/g, '&quot;')}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Page ID:</span>
          <input type="text" class="edit-page-id" value="${acc.pageId || acc.fbId || ''}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Tài khoản cá nhân quản trị:</span>
          <select class="edit-parent-id" style="margin-top:4px">
            <option value="">-- Chọn tài khoản cá nhân quản trị --</option>
            ${personalAccounts.map(p => `
              <option value="${p.id}" ${p.id === acc.parentAccountId ? 'selected' : ''}>${p.name} (${p.fbId || 'FB ID'})</option>
            `).join('')}
          </select>
        </label>
        <label style="margin-bottom:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">Page Access Token (Tùy chọn):</span>
          <input type="text" class="edit-token" placeholder="EAA..." value="${acc.token || ''}" style="margin-top:4px">
        </label>
        <label style="margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:4px">
            <span style="font-size:12px;font-weight:600;color:var(--text)">Danh sách nhóm riêng cho "${acc.name}":</span>
            ${cats.length ? `
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:11px;color:var(--accent)">Nạp từ danh mục:</span>
                <select class="cat-fill-select" data-id="${acc.id}" style="width:auto;padding:2px 6px;font-size:11px;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;border-radius:6px">
                  <option value="">-- Chọn danh mục --</option>
                  ${cats.map(c => `<option value="${c.id}">${c.name} (${(c.links||'').split(/\r?\n/).filter(Boolean).length} nhóm)</option>`).join('')}
                </select>
              </div>` : ''}
          </div>
          <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Mỗi dòng 1 link (https://www.facebook.com/groups/...). Để trống để dùng chung nhóm ở bảng chính.</span>
          <textarea class="edit-groups" rows="5" placeholder="https://www.facebook.com/groups/ten-nhom-1/&#10;https://www.facebook.com/groups/ten-nhom-2/&#10;Để trống = dùng chung nhóm ở bảng chính">${acc.groups || ''}</textarea>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button type="button" class="btn btn-light cancel-edit-btn" data-id="${acc.id}" style="padding:6px 14px;font-size:12px">Hủy</button>
          <button type="button" class="btn btn-primary save-edit-btn" data-id="${acc.id}" style="padding:6px 16px;font-size:12px">💾 Lưu thay đổi</button>
        </div>
      </div>`;
    list.append(card);
  }

  // Handle Cat Fill Select
  list.querySelectorAll('.cat-fill-select').forEach(sel => {
    sel.onchange = () => {
      const catId = sel.value;
      if (!catId) return;
      const cat = cats.find(c => c.id === catId);
      if (!cat) return;
      const box = sel.closest('.acc-edit-box');
      const textarea = box?.querySelector('.edit-groups');
      if (textarea) {
        textarea.value = cat.links || '';
        msg(`📁 Đã nạp nhóm từ danh mục "${cat.name}". Nhớ bấm "Lưu thay đổi"!`);
      }
    };
  });

  // Toggle Edit Box
  list.querySelectorAll('.icon-btn.edit-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (!box) return;
      const isOpen = box.style.display !== 'none';
      list.querySelectorAll('.acc-edit-box').forEach(b => { if (b !== box) b.style.display = 'none'; });
      box.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        const textarea = box.querySelector('.edit-groups');
        if (textarea) textarea.focus();
      }
    };
  });

  // Cancel Edit
  list.querySelectorAll('.cancel-edit-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (box) box.style.display = 'none';
    };
  });

  // Save Edit
  list.querySelectorAll('.save-edit-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const box = $(`editBox_${id}`);
      if (!box) return;

      const newName = box.querySelector('.edit-name').value.trim();
      const newPageId = box.querySelector('.edit-page-id')?.value?.trim();
      const newParentId = box.querySelector('.edit-parent-id')?.value;
      const newToken = box.querySelector('.edit-token')?.value?.trim();
      const newGroups = box.querySelector('.edit-groups').value.trim();

      if (!newName) { msg('Tên Fanpage không được để trống.', 'err'); return; }
      if (!newPageId || !/^\d+$/.test(newPageId)) { msg('Page ID không hợp lệ.', 'err'); return; }

      try {
        validateGroups(newGroups);
      } catch (e) {
        msg(e.message, 'err');
        return;
      }

      const accs = await loadAccounts();
      const acc = accs.find(a => a.id === id);
      if (!acc) return;

      acc.name = newName;
      acc.pageId = newPageId;
      acc.fbId = newPageId;
      if (newToken !== undefined) acc.token = newToken || null;

      if (newParentId) {
        const parent = accs.find(p => p.id === newParentId);
        if (parent) {
          acc.parentAccountId = parent.id;
          acc.parentAccountName = parent.name;
          if (parent.cookies) acc.cookies = parent.cookies;
          if (parent.email) acc.email = parent.email;
          if (parent.password) acc.password = parent.password;
          if (parent.twoFactor) acc.twoFactor = parent.twoFactor;
        }
      }

      acc.groups = newGroups;
      await saveAccounts(accs);

      msg(`✅ Đã cập nhật Fanpage "${newName}".`);
      render();
    };
  });

  // Chuyển sang Fanpage trên Facebook
  list.querySelectorAll('.login-page-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Đang vào...';
      try {
        const res = await activateSessionWithFallback(id, true);
        if (res?.ok) {
          msg(`✅ Đã chuyển đổi sang Fanpage "${name}" (Page ID: ${res.cUser || 'Pro5'}) trên Facebook!`);
        } else {
          msg(`❌ Lỗi chuyển sang Fanpage: ${res?.error || 'Không xác định'}`, 'err');
        }
      } catch (e) {
        msg('Lỗi: ' + e.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    };
  });

  // Đồng bộ cookie cho Fanpage
  list.querySelectorAll('.sync-page-cookie-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        const accs = await loadAccounts();
        const acc = accs.find(a => a.id === id);
        if (!acc) return;

        // Tìm nick cá nhân quản trị
        const parent = accs.find(p => p.id === acc.parentAccountId) || accs.find(p => p.type !== 'fanpage' && p.cookies);
        if (parent?.cookies) {
          acc.cookies = parent.cookies;
          acc.parentAccountId = parent.id;
          acc.parentAccountName = parent.name;
          acc.lastCookieSync = Date.now();
          await saveAccounts(accs);
          msg(`✅ Đã đồng bộ cookie từ nick chủ "${parent.name}" sang Fanpage "${acc.name}"!`);
          render();
        } else {
          msg('Chưa tìm thấy cookies của tài khoản cá nhân quản trị. Hãy đồng bộ cookie cho nick cá nhân trước.', 'err');
        }
      } catch (e) {
        msg('Lỗi đồng bộ cookie: ' + e.message, 'err');
      }
    };
  });

  // Xóa Fanpage
  list.querySelectorAll('.icon-btn.del').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const accs = await loadAccounts();
      const acc = accs.find(a => a.id === id);
      if (!acc || !confirm(`Xóa Fanpage "${acc.name}" khỏi danh sách?`)) return;
      await saveAccounts(accs.filter(a => a.id !== id));
      const { campaigns } = await chrome.storage.local.get('campaigns');
      if (campaigns?.[id]) { delete campaigns[id]; await chrome.storage.local.set({ campaigns }); }
      msg(`Đã xóa Fanpage "${acc.name}".`);
      render();
    };
  });
}

// ── Toolbar Actions ───────────────────────────────────────────────────────────

// 2. Đồng bộ cookie cho tất cả Fanpage từ tài khoản chủ quản
$('syncAllPagesCookiesBtn')?.addEventListener('click', async () => {
  try {
    const accounts = await loadAccounts();
    const fanpages = accounts.filter(a => a.type === 'fanpage');
    const personalAccounts = accounts.filter(a => a.type !== 'fanpage');

    if (!fanpages.length) { msg('Chưa có Fanpage nào để đồng bộ.'); return; }

    let count = 0;
    for (const page of fanpages) {
      const parent = personalAccounts.find(p => p.id === page.parentAccountId) || personalAccounts.find(p => p.cookies);
      if (parent?.cookies) {
        page.cookies = parent.cookies;
        if (!page.parentAccountId) page.parentAccountId = parent.id;
        if (!page.parentAccountName) page.parentAccountName = parent.name;
        page.lastCookieSync = Date.now();
        count++;
      }
    }

    await saveAccounts(accounts);
    msg(`✅ Đã đồng bộ cookie thành công cho ${count} Fanpage từ tài khoản cá nhân quản trị!`);
    render();
  } catch (e) {
    msg('Lỗi đồng bộ cookie: ' + e.message, 'err');
  }
});

// ── Init (Tối ưu hiệu năng với Debounce) ──────────────────────────────────────
updateParentAccountOptions();
render();

let _fpRenderDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.dailyPostStats || changes.campaigns)) {
    if (_fpRenderDebounce) clearTimeout(_fpRenderDebounce);
    _fpRenderDebounce = setTimeout(() => {
      updateParentAccountOptions();
      render();
    }, 150);
  }
});
