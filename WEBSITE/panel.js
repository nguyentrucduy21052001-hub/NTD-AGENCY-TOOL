import {validate, spinText, getTodayDateStr, findBannedWords, highlightBannedWordsHtml, removeBannedWords, getGroupKey, getAllPostedGroupKeys} from './core.js';
import {validateKey, getMachineId, checkCurrentLicense, enforceLicenseGate} from './license.js';
import {initSyncModal, parseJsonFile, applyRestoredData, exportJsonBackup} from './sync_helper.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Performance: Debounce utility ─────────────────────────────────────────────
function debounce(fn, wait) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}
let picture = null;
let groupSourceMode = 'categories';
let accountCategoryMap = {};
let loadedCategories = [];
let cfgAccountType = 'personal'; // 'personal' | 'fanpage' | 'all'

// ── State for Section 2 & Section 4 Dashboard ────────────────────────────────
let cfgFilter = 'all'; // 'all' | 'selected' | 'unselected'
let cfgSearchTerm = '';
const expandedCategoryAccs = new Set();
let progAccountType = localStorage.getItem('ntd_prog_acc_type') || 'personal'; // 'personal' | 'fanpage' | 'all'
let progFilter = 'all'; // 'all' | 'running' | 'done' | 'error' | 'paused'
let allJobDetailsExpanded = false;
const expandedJobAccs = new Set();
let cachedCampaigns = {};
let cachedAccounts = [];

// ── State for Shared Groups Account Selector ──────────────────────────────────
let sharedSelectedAccIds = new Set();
let sharedAccountType = 'all'; // 'all' | 'personal' | 'fanpage'
let sharedSearchTerm = '';
let sharedAccountsInitialized = false;

// ── Multi-Post System (Hỗ trợ setup nhiều bài cùng lúc: Bài 1, Bài 2, Bài 3) ──
let posts = [
  { id: 1, text: '', picture: null, background: null, postLinkMode: false },
  { id: 2, text: '', picture: null, background: null, postLinkMode: false },
  { id: 3, text: '', picture: null, background: null, postLinkMode: false },
];
let currentPostIndex = 0;
let accountPostMap = {}; // { [accountId]: postIndex }

// ── Facebook Post Background Themes & Swatches ──────────────────────────────
const FB_BACKGROUNDS = [
  { id: 'none', name: 'Không dùng', css: 'none', preview: 'transparent' },
  { id: 'sunset', name: 'Hoàng hôn', css: 'linear-gradient(135deg, #ff512f, #dd2476)', preview: 'linear-gradient(135deg, #ff512f, #dd2476)' },
  { id: 'ocean', name: 'Đại dương', css: 'linear-gradient(135deg, #00c6ff, #0072ff)', preview: 'linear-gradient(135deg, #00c6ff, #0072ff)' },
  { id: 'galaxy', name: 'Vũ trụ', css: 'linear-gradient(135deg, #8a2387, #e94057, #f27121)', preview: 'linear-gradient(135deg, #8a2387, #e94057, #f27121)' },
  { id: 'fire', name: 'Lửa hồng', css: 'linear-gradient(135deg, #f857a6, #ff5858)', preview: 'linear-gradient(135deg, #f857a6, #ff5858)' },
  { id: 'emerald', name: 'Ngọc lục', css: 'linear-gradient(135deg, #11998e, #38ef7d)', preview: 'linear-gradient(135deg, #11998e, #38ef7d)' },
  { id: 'midnight', name: 'Bóng đêm', css: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)', preview: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
  { id: 'sunshine', name: 'Nắng mai', css: 'linear-gradient(135deg, #f7971e, #ffd200)', preview: 'linear-gradient(135deg, #f7971e, #ffd200)' },
  { id: 'candy', name: 'Kẹo ngọt', css: 'linear-gradient(135deg, #d946ef, #8b5cf6)', preview: 'linear-gradient(135deg, #d946ef, #8b5cf6)' },
  { id: 'neon', name: 'Neon tím', css: 'linear-gradient(135deg, #7928ca, #ff0080)', preview: 'linear-gradient(135deg, #7928ca, #ff0080)' },
  { id: 'solid_red', name: 'Đỏ tươi', css: '#dc2626', preview: '#dc2626' },
  { id: 'solid_blue', name: 'Xanh dương', css: '#2563eb', preview: '#2563eb' }
];
let currentFbBg = null;

function renderFbBackgroundSwatches() {
  const container = $('fbBgSwatchesList');
  if (!container) return;
  container.innerHTML = FB_BACKGROUNDS.map(bg => {
    const isNone = bg.id === 'none';
    const isActive = (currentFbBg || 'none') === bg.id;
    const swatchStyle = isNone
      ? 'background:rgba(255,255,255,0.06);border:1px dashed #94a3b8;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;'
      : `background:${bg.preview};border:none;`;
    const inner = isNone ? '✕' : '';
    return `<button type="button" class="fb-bg-swatch ${isActive ? 'active' : ''} ${isNone ? 'none-swatch' : ''}" data-bg-id="${bg.id}" title="${bg.name}" style="${swatchStyle}">${inner}</button>`;
  }).join('');

  container.querySelectorAll('.fb-bg-swatch').forEach(btn => {
    btn.onclick = () => {
      const bgId = btn.getAttribute('data-bg-id');
      setFbBackground(bgId, true);
    };
  });
}

function updateFbBgCharCount() {
  const textVal = $('text')?.value || '';
  const len = textVal.length;
  const numEl = $('fbBgCharCountNum');
  const badgeEl = $('fbBgCharCountBadge');
  const alertEl = $('fbBgLengthAlert');

  if (numEl) numEl.textContent = len;

  if (currentFbBg && currentFbBg !== 'none') {
    if (badgeEl) {
      if (len > 130) {
        badgeEl.className = 'fb-bg-char-badge error';
      } else if (len >= 110) {
        badgeEl.className = 'fb-bg-char-badge warning';
      } else {
        badgeEl.className = 'fb-bg-char-badge normal';
      }
    }
    if (alertEl) {
      alertEl.style.display = len > 130 ? 'flex' : 'none';
    }
  } else {
    if (badgeEl) badgeEl.className = 'fb-bg-char-badge default';
    if (alertEl) alertEl.style.display = 'none';
  }
}

function setFbBackground(bgId, triggerSave = true) {
  const targetBg = FB_BACKGROUNDS.find(b => b.id === bgId) || FB_BACKGROUNDS[0];
  const isNone = !targetBg || targetBg.id === 'none';
  currentFbBg = isNone ? null : targetBg.id;

  if (posts[currentPostIndex]) {
    posts[currentPostIndex].background = currentFbBg;
  }

  // Cập nhật tên màu nền đang chọn
  const nameEl = $('fbBgCurrentName');
  if (nameEl) {
    nameEl.textContent = isNone ? 'Không dùng' : targetBg.name;
    nameEl.className = 'fb-bg-name-badge' + (isNone ? '' : ' active');
  }

  // Đổi active trên swatch palette
  const container = $('fbBgSwatchesList');
  if (container) {
    container.querySelectorAll('.fb-bg-swatch').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-bg-id') === (currentFbBg || 'none'));
    });
  }

  // WYSIWYG live preview trực tiếp trên ô soạn bài #text
  const editor = $('text');
  if (editor) {
    if (!isNone) {
      editor.classList.add('has-fb-bg');
      editor.style.setProperty('background', targetBg.css, 'important');
      editor.style.setProperty('color', '#ffffff', 'important');
    } else {
      editor.classList.remove('has-fb-bg');
      editor.style.removeProperty('background');
      editor.style.removeProperty('color');
    }
  }

  // Nguyên tắc Facebook: Đăng nền màu KHÔNG được đính kèm ảnh
  const imgInput = $('image');
  const imgWrap = $('imageUploadWrap');
  const imgNotice = $('fbBgImageDisabledNotice');
  const imgAlert = $('fbBgImageConflictAlert');

  if (!isNone) {
    let hadImage = false;
    if (picture || (posts[currentPostIndex] && posts[currentPostIndex].picture)) {
      hadImage = true;
      picture = null;
      if (posts[currentPostIndex]) posts[currentPostIndex].picture = null;
      if (imgInput) imgInput.value = '';
      updateImageUi();
      updatePostTabsUi();
      try {
        chrome.storage.local.get('campaignPictures').then(({ campaignPictures = {} }) => {
          delete campaignPictures[currentPostIndex];
          chrome.storage.local.set({ campaignPictures });
        });
      } catch (_) {}
    }
    if (imgInput) imgInput.disabled = true;
    if (imgWrap) {
      imgWrap.style.opacity = '0.5';
      imgWrap.style.pointerEvents = 'none';
    }
    if (imgNotice) imgNotice.style.display = 'block';
    if (imgAlert) imgAlert.style.display = hadImage ? 'flex' : 'none';
  } else {
    if (imgInput) imgInput.disabled = false;
    if (imgWrap) {
      imgWrap.style.opacity = '1';
      imgWrap.style.pointerEvents = 'auto';
    }
    if (imgNotice) imgNotice.style.display = 'none';
    if (imgAlert) imgAlert.style.display = 'none';
  }

  updateFbBgCharCount();

  if (triggerSave) {
    chrome.storage.local.set({ draft: draft() });
  }
}

// ── Chế độ Đăng bài bằng link (Link Preview) ───────────────────────────────
function updatePostLinkModeUI(isActive) {
  const container = $('postLinkModeContainer');
  const badge = $('postLinkModeBadge');
  const checkbox = $('postLinkModeCheckbox');
  const textEl = $('text');

  if (checkbox) checkbox.checked = !!isActive;
  if (container) container.classList.toggle('active', !!isActive);
  if (badge) badge.style.display = isActive ? 'inline-block' : 'none';

  const fbBgSection = $('fbBackgroundSection');
  const fbBgAlert = $('fbBgImageDisabledNotice');

  if (isActive) {
    if (fbBgSection) {
      fbBgSection.style.opacity = '0.45';
      fbBgSection.style.pointerEvents = 'none';
    }
    if (fbBgAlert) {
      fbBgAlert.textContent = '🚫 Đã khóa chọn ảnh & nền màu do đang bật chế độ Đăng bằng link (Link Preview).';
      fbBgAlert.style.display = 'block';
    }
    if (textEl && !textEl.value.trim()) {
      textEl.placeholder = 'Dán đường link bài viết Facebook (hoặc video/web) cần chia sẻ vào đây...';
    }
  } else {
    if (fbBgSection) {
      fbBgSection.style.opacity = '1';
      fbBgSection.style.pointerEvents = 'auto';
    }
    if (fbBgAlert && (!currentFbBg || currentFbBg === 'none')) {
      fbBgAlert.style.display = 'none';
    }
    if (textEl && !textEl.value.trim()) {
      textEl.placeholder = 'Nhập nội dung muốn đăng cho bài viết này...';
    }
  }
}

function getSetupPosts() {
  if (posts[currentPostIndex]) {
    const textVal = $('text')?.value || '';
    posts[currentPostIndex].text = textVal;
    posts[currentPostIndex].picture = picture || null;
    posts[currentPostIndex].background = currentFbBg || null;
    posts[currentPostIndex].postLinkMode = !!$('postLinkModeCheckbox')?.checked;
  }
  return posts
    .map((p, idx) => ({ idx, text: p.text || '', picture: p.picture || null, background: p.background || null, postLinkMode: !!p.postLinkMode, title: `Bài ${idx + 1}` }))
    .filter(item => item.text.trim().length > 0);
}

function updatePostTabsUi() {
  const readyPosts = getSetupPosts();
  const readyIdxSet = new Set(readyPosts.map(p => p.idx));

  for (let i = 0; i < 3; i++) {
    const btn = $(`postTabBtn_${i}`);
    const status = $(`postTabStatus_${i}`);
    if (btn) {
      btn.classList.toggle('active', i === currentPostIndex);
    }
    if (status) {
      const isReady = readyIdxSet.has(i);
      status.textContent = isReady ? 'Đã soạn' : 'Chưa soạn';
      status.classList.toggle('ready', isReady);
    }
  }

  const badge = $('postSetupCountBadge');
  if (badge) {
    badge.textContent = `Đã soạn ${readyPosts.length}/3 bài`;
    if (readyPosts.length === 3) {
      badge.style.background = '#dcfce7';
      badge.style.color = '#15803d';
      badge.style.borderColor = '#86efac';
    } else if (readyPosts.length > 0) {
      badge.style.background = '#e0f2fe';
      badge.style.color = '#0369a1';
      badge.style.borderColor = '#7dd3fc';
    } else {
      badge.style.background = '#f1f5f9';
      badge.style.color = '#64748b';
      badge.style.borderColor = '#cbd5e1';
    }
  }

  const heading = $('editorPostHeading');
  if (heading) heading.textContent = `Nội dung Bài ${currentPostIndex + 1}:`;
  const imgHeading = $('editorImgHeading');
  if (imgHeading) imgHeading.textContent = `Bài ${currentPostIndex + 1}`;
  const imgName = $('currentPostImgName');
  if (imgName) {
    imgName.textContent = posts[currentPostIndex]?.picture?.name ? posts[currentPostIndex].picture.name : '';
  }
}

function switchPostTab(newIdx) {
  if (newIdx < 0 || newIdx > 2 || newIdx === currentPostIndex) return;

  // Lưu nội dung bài hiện tại trước khi chuyển tab
  if (posts[currentPostIndex]) {
    posts[currentPostIndex].text = $('text')?.value || '';
    posts[currentPostIndex].picture = picture || null;
    posts[currentPostIndex].background = currentFbBg || null;
    posts[currentPostIndex].postLinkMode = !!$('postLinkModeCheckbox')?.checked;
  }

  currentPostIndex = newIdx;

  // Nạp nội dung bài mới vào trình soạn thảo
  const nextPost = posts[newIdx] || { text: '', picture: null, background: null, postLinkMode: false };
  if ($('text')) $('text').value = nextPost.text || '';
  picture = nextPost.picture || null;

  setFbBackground(nextPost.background || null, false);
  updatePostLinkModeUI(!!nextPost.postLinkMode);
  updateImageUi();
  updatePostTabsUi();
  checkAndRenderBannedWords();
  updateAllAccountPostPickers();
  chrome.storage.local.set({ draft: draft() });
}

function renderPostButtonsForAccount(accId, containerEl, drawerEl) {
  if (!containerEl) return;
  const readyPosts = getSetupPosts();

  // Nếu chưa bài nào có nội dung, hiển thị Bài 1 mặc định
  const availablePosts = readyPosts.length > 0 
    ? readyPosts 
    : [{ idx: 0, title: 'Bài 1', text: '' }];

  let currentAssigned = accountPostMap[accId];
  const validIndices = availablePosts.map(p => p.idx);
  if (currentAssigned === undefined || !validIndices.includes(currentAssigned)) {
    currentAssigned = validIndices[0];
    accountPostMap[accId] = currentAssigned;
  }

  const buildButtonsHtml = () => {
    return availablePosts.map(p => {
      const isActive = p.idx === currentAssigned;
      const previewText = p.text ? p.text.slice(0, 50).replace(/"/g, '&quot;') : 'Chưa có nội dung';
      return `<button type="button" class="cfg-pbtn ${isActive ? 'active' : ''}" data-acc="${accId}" data-idx="${p.idx}" title="${p.title}: ${previewText}">${p.title}</button>`;
    }).join('');
  };

  containerEl.innerHTML = buildButtonsHtml();

  const attachEvents = (parent) => {
    parent.querySelectorAll('.cfg-pbtn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const chosenIdx = Number(btn.dataset.idx);
        accountPostMap[accId] = chosenIdx;
        renderPostButtonsForAccount(accId, containerEl, drawerEl);
        chrome.storage.local.set({ draft: draft() });
      };
    });
  };

  attachEvents(containerEl);

  if (drawerEl) {
    drawerEl.innerHTML = `
      <span style="font-weight:600;color:#334155">Phân công bài đăng:</span>
      <div style="display:flex;gap:4px">
        ${buildButtonsHtml()}
      </div>
    `;
    attachEvents(drawerEl);
  }
}

function updateAllAccountPostPickers() {
  const container = $('accountCategoryAssignList');
  if (!container) return;

  const rows = container.querySelectorAll('.cfg-acc-item');
  rows.forEach(item => {
    const accId = item.dataset.id;
    const postPickEl = item.querySelector(`#cfgAccPostPick_${accId}`);
    const drawerPostEl = item.querySelector(`#cfgDrawerPostPicker_${accId}`);
    if (postPickEl) {
      renderPostButtonsForAccount(accId, postPickEl, drawerPostEl);
    }
  });

  const bulkBar = $('cfgBulkPostAssignBar');
  const bulkBtns = $('cfgBulkPostButtons');
  const readyPosts = getSetupPosts();
  if (bulkBar && bulkBtns) {
    if (readyPosts.length > 1) {
      bulkBar.style.display = 'flex';
      bulkBtns.innerHTML = readyPosts.map(p => {
        return `<button type="button" class="cfg-action-btn" data-bulk-post="${p.idx}" style="padding:2px 8px;font-size:11px" title="Gán tất cả tài khoản đăng ${p.title}">Đăng ${p.title}</button>`;
      }).join('');
      bulkBtns.querySelectorAll('[data-bulk-post]').forEach(btn => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.bulkPost);
          rows.forEach(item => {
            const accId = item.dataset.id;
            accountPostMap[accId] = idx;
          });
          updateAllAccountPostPickers();
          chrome.storage.local.set({ draft: draft() });
          msg(`✅ Đã gán tất cả tài khoản đăng Bài ${idx + 1}.`);
        };
      });
    } else {
      bulkBar.style.display = 'none';
    }
  }
}

// ── Full Backup, Restore & 1-Touch Cloud Sync System (KHỞI ĐỘNG ĐẦU TIÊN - 0MS) ─
const syncModal = initSyncModal({
  triggerBtnId: 'openSyncModalBtn',
  defaultTab: 'restore',
  onRestoreSuccess: () => window.location.reload()
});
window.openSyncModal = (tab) => syncModal.open(tab || 'restore');

$('openSyncModalBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  syncModal.open('restore');
});

$('quickRestoreBannerBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  syncModal.open('restore');
});

$('panelBackupBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const data = await exportJsonBackup();
    alert(`🎉 Đã tải file sao lưu về máy!\n• ${data.accounts.length} tài khoản Facebook\n• ${data.groupCategories.length} danh mục nhóm.`);
  } catch (err) {
    alert('❌ Lỗi sao lưu: ' + err.message);
  }
});

// Direct JSON File Restore
$('panelRestoreBtn')?.addEventListener('click', () => {
  $('panelRestoreFileInput')?.click();
});
$('panelRestoreFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = await parseJsonFile(file);
    const res = await applyRestoredData(data);
    alert(`🎉 Khôi phục dữ liệu thành công!\n• ${res.accCount} tài khoản Facebook\n• ${res.catCount} danh mục nhóm.\n\nTiện ích sẽ tự động tải lại ngay.`);
    window.location.reload();
  } catch (err) {
    alert('❌ Lỗi nạp file sao lưu: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

// ── Navigation links ──────────────────────────────────────────────────────────
const accountsUrl = chrome.runtime.getURL('accounts.html');
const manageBtn = document.getElementById('manageAccBtn');
if (manageBtn) manageBtn.href = accountsUrl;
document.getElementById('addAccLink')?.addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({url: accountsUrl});
});

// ── License gate & info (Async background check) ──────────────────────────────
let machineId = '';
try {
  machineId = await getMachineId();
} catch (e) {
  console.warn('Cannot get machineId:', e);
}

async function checkLicense() {
  return await checkCurrentLicense();
}
let licenseInfo = await enforceLicenseGate();

function updateLicenseDisplay() {
  const info = document.getElementById('accountInfo');
  if (!info) return;
  if (licenseInfo) {
    const expDate = new Date(licenseInfo.expiry);
    const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
    info.innerHTML =
      `👤 <b>${licenseInfo.username}</b> &nbsp;·&nbsp; ` +
      `Hết hạn: <b>${expDate.toLocaleDateString('vi-VN')}</b> ` +
      `<span style="color:${daysLeft <= 7 ? '#b34317' : '#68758b'}">(còn ${daysLeft} ngày)</span>`;
  } else {
    info.innerHTML =
      `⚠️ <b style="color:#dc2626">Chưa đăng nhập tài khoản</b> &nbsp;·&nbsp; ` +
      `<a href="activate.html" style="color:#ea580c;font-weight:700;text-decoration:underline">Đăng nhập ngay</a> hoặc bấm nút cam <b>[⚡ Cập nhật dữ liệu cũ]</b> để khôi phục`;
  }
}
updateLicenseDisplay();

// ── Logout ─────────────────────────────────────────────────────────────────────
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  if (!licenseInfo) {
    window.location.href = chrome.runtime.getURL('activate.html');
    return;
  }
  if (!confirm('Đăng xuất tài khoản khỏi máy này?\nBạn sẽ cần đăng nhập lại tài khoản & mật khẩu để sử dụng.')) return;
  await chrome.storage.local.remove('license');
  window.location.href = chrome.runtime.getURL('activate.html');
});

const draft = () => {
  if (posts[currentPostIndex]) {
    posts[currentPostIndex].text = $('text')?.value || '';
    posts[currentPostIndex].picture = picture || null;
    posts[currentPostIndex].background = currentFbBg || null;
  }
  const accountGroups = {};
  if (groupSourceMode === 'categories') {
    for (const [accId, catIds] of Object.entries(accountCategoryMap)) {
      if (Array.isArray(catIds) && catIds.length) {
        const lines = [];
        const seen = new Set();
        for (const catId of catIds) {
          const cat = loadedCategories.find(c => c.id === catId);
          if (cat?.links) {
            for (const l of cat.links.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
              if (!seen.has(l)) { seen.add(l); lines.push(l); }
            }
          }
        }
        if (lines.length) accountGroups[accId] = lines.join('\n');
      }
    }
  }

  const curPostLinkMode = !!$('postLinkModeCheckbox')?.checked;
  if (posts[currentPostIndex]) {
    posts[currentPostIndex].postLinkMode = curPostLinkMode;
  }

  const firstReady = posts.find(p => p.text?.trim()) || posts[0];

  return {
    posts,
    currentPostIndex,
    accountPostMap,
    cfgAccountType,
    text: $('text')?.value || firstReady?.text || '',
    picture: null, // Ảnh đã được lưu độc lập trong posts[i].picture, không nhân bản tại root để tiết kiệm bộ nhớ
    background: currentFbBg || firstReady?.background || null,
    postLinkMode: curPostLinkMode || !!firstReady?.postLinkMode || posts.some(p => p.postLinkMode),
    links: $('links').value,
    groupSourceMode,
    sharedSelectedAccounts: Array.from(sharedSelectedAccIds),
    accountCategoryMap,
    accountGroups,
    gap: $('gapMin') ? $('gapMin').value : ($('gap')?.value || '180'),
    gapMin: $('gapMin')?.value || '180',
    gapMax: $('gapMax')?.value || '300',
    accountOrder: $('accountOrder')?.value || 'round_robin',
    splitSharedGroups: $('splitSharedGroups')?.checked ?? false,
    randomTag: true,
    humanBehavior: true,
    enableBreak: $('enableBreak')?.checked ?? true,
    autoSkipOnError: true,
    breakAfter: $('breakAfter')?.value || '5',
    breakMinutes: $('breakMinutes')?.value || '10',
    maxPosts: $('maxPosts')?.value || '',
    enableDailyLimit: $('enableDailyLimit')?.checked ?? true,
    dailyLimit: $('dailyLimit')?.value || '20',
    mode: $('mode').value,
    when: $('when').value,
  };
};
const msg = (t, type = 'ok') => {
  const el = $('message');
  if (!el) return;
  el.textContent = t;
  el.style.color = type === 'err' ? '#dc2626' : (t.startsWith('✅') ? '#16a34a' : '#b34317');
  el.style.fontWeight = type === 'err' ? '700' : '600';

  // Nếu là thông báo chiến dịch đang khởi động hoặc đang chạy -> hiển thị nút Dừng nhanh ngay bên cạnh
  if (t.includes('Đã khởi động') || t.includes('Đang chạy') || t.includes('kích hoạt tự động')) {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.id = 'inlineQuickStopBtn';
    stopBtn.innerHTML = '⏹ Dừng tất cả ngay';
    stopBtn.style.cssText = 'margin-left:12px;background:#ef4444;color:#ffffff;border:none;padding:5px 14px;border-radius:8px;font-size:12.5px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(239,68,68,0.35);vertical-align:middle;';
    stopBtn.onclick = () => {
      const mainStop = $('stopAllBtn');
      if (mainStop) mainStop.click();
    };
    el.appendChild(stopBtn);
  }
};
async function send(type, data) {
  const r = await chrome.runtime.sendMessage({type, data});
  if (!r?.ok) throw Error(r?.error || 'Không kết nối được tiện ích.');
  return r;
}
// ── Keep-Alive Worker Port (Đảm bảo Service Worker không bị Chrome tắt khi chuyển sang cửa sổ khác) ──
let keepAlivePort = null;
function maintainKeepAliveWorker() {
  try {
    if (keepAlivePort) {
      try { keepAlivePort.disconnect(); } catch (_) {}
      keepAlivePort = null;
    }
    keepAlivePort = chrome.runtime.connect({ name: 'keepAliveWorker' });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
      setTimeout(maintainKeepAliveWorker, 2000);
    });
  } catch (_) {
    setTimeout(maintainKeepAliveWorker, 5000);
  }
}
maintainKeepAliveWorker();
setInterval(() => {
  if (keepAlivePort) {
    try {
      keepAlivePort.postMessage({ type: 'PING' });
    } catch (_) {
      maintainKeepAliveWorker();
    }
  } else {
    maintainKeepAliveWorker();
  }
}, 20000);

let _cachedPanelWinId = null;
async function sendDirect(type, extra = {}) {
  const isWeb = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');

  // Nếu đang trên Web Platform và đã kết nối với Tiện ích Chrome Runner:
  // Chuyển toàn bộ các lệnh điều khiển (START, STOP, PAUSE, RESUME, NEXT, RESET) trực tiếp sang Extension!
  if (isWeb && window.__ntdExtensionActive && window.chrome?.runtime?.sendToExtension) {
    const r = await window.chrome.runtime.sendToExtension({ type, ...extra });
    if (!r?.ok && r?.error) throw Error(r.error);
    return r || { ok: true };
  }

  // Ghi nhớ windowId của cửa sổ tiện ích để tab Facebook mở ngầm ở cửa sổ này, không bật đè lên cửa sổ Chrome làm việc
  try {
    if (!_cachedPanelWinId) {
      const win = await chrome.windows.getCurrent();
      if (win?.id) {
        _cachedPanelWinId = win.id;
        await chrome.storage.local.set({ panelWindowId: win.id });
      }
    }
  } catch (_) {}

  const r = await chrome.runtime.sendMessage({type, ...extra});
  if (!r?.ok) throw Error(r?.error || 'Lỗi không xác định.');
  return r;
}


// ── Real-time Banned Words Scanner & Red Highlighter ───────────────────────────
function checkAndRenderBannedWords() {
  const textEl = $('text');
  if (!textEl) return false;
  const raw = textEl.value || '';
  const violations = findBannedWords(raw);
  const box = $('bannedWordsBox');
  const countText = $('bannedWordsCountText');
  const tagsList = $('bannedWordsTags');
  const previewDiv = $('bannedHighlightedPreview');
  const actionAlert = $('bannedActionAlert');
  const actionAlertDesc = $('bannedActionAlertDesc');

  const startBtns = document.querySelectorAll('#startAllBtn, .btn-start-one, #resumeAllBtn, #bannerResumeBtn, #retryErrorsBtn');

  if (violations.length > 0) {
    textEl.classList.add('has-banned-words');
    if (box) box.style.display = 'block';
    if (actionAlert) actionAlert.style.display = 'flex';

    const uniqueWordsMap = new Map();
    for (const v of violations) {
      const k = v.word.toLowerCase();
      if (!uniqueWordsMap.has(k)) {
        uniqueWordsMap.set(k, { word: v.word, category: v.category, count: 0 });
      }
      uniqueWordsMap.get(k).count++;
    }
    const uniqueArr = [...uniqueWordsMap.values()];

    if (countText) {
      countText.textContent = `Phát hiện ${uniqueArr.length} từ cấm vi phạm chính sách Facebook (${violations.length} vị trí)`;
    }
    if (actionAlertDesc) {
      actionAlertDesc.textContent = `Phát hiện ${uniqueArr.length} từ cấm: ${uniqueArr.slice(0, 4).map(u => u.word).join(', ')}${uniqueArr.length > 4 ? '...' : ''}. Nút đăng bài đã bị khóa!`;
    }

    if (tagsList) {
      tagsList.innerHTML = uniqueArr.map(item => `
        <span class="banned-pill" title="Thuộc nhóm: ${item.category}">
          <b>${item.word}</b> ${item.count > 1 ? `<span style="font-size:10px;background:#ef4444;color:#fff;border-radius:10px;padding:0 5px;margin-left:2px">${item.count}</span>` : ''}
          <small>(${item.category})</small>
        </span>
      `).join('');
    }

    if (previewDiv) {
      previewDiv.innerHTML = highlightBannedWordsHtml(raw);
    }

    startBtns.forEach(btn => {
      btn.classList.add('btn-blocked');
      btn.title = 'Nội dung chứa từ cấm vi phạm chính sách Facebook! Không thể thực hiện cho đến khi xóa bỏ từ cấm.';
    });

    return true; // Có từ cấm
  } else {
    textEl.classList.remove('has-banned-words');
    if (box) box.style.display = 'none';
    if (actionAlert) actionAlert.style.display = 'none';

    startBtns.forEach(btn => {
      btn.classList.remove('btn-blocked');
      btn.title = '';
    });

    return false; // Sạch từ cấm
  }
}

// Debounced helpers để giảm tải khi người dùng gõ liên tục
const debouncedUpdatePostPickers = debounce(updateAllAccountPostPickers, 300);
const debouncedSaveDraft = debounce(() => chrome.storage.local.set({ draft: draft() }), 500);
const debouncedBannedWordsScan = debounce(checkAndRenderBannedWords, 200);

function onEditorContentChanged() {
  if (posts[currentPostIndex]) {
    posts[currentPostIndex].text = $('text')?.value || '';
  }
  updatePostTabsUi();
  updateFbBgCharCount();
  debouncedBannedWordsScan();
  debouncedUpdatePostPickers();
  debouncedSaveDraft();
}

// Lắng nghe sự kiện gõ phím / dán nội dung thời gian thực
$('text')?.addEventListener('input', onEditorContentChanged);
$('text')?.addEventListener('change', onEditorContentChanged);
$('text')?.addEventListener('paste', () => setTimeout(onEditorContentChanged, 50));

// Tự động xóa từ cấm khi bấm nút
$('removeBannedWordsBtn')?.addEventListener('click', () => {
  const textEl = $('text');
  if (!textEl) return;
  const cleaned = removeBannedWords(textEl.value);
  textEl.value = cleaned;
  onEditorContentChanged();
  msg('✅ Đã tự động lọc bỏ các từ cấm khỏi nội dung bài viết!');
});

// Gắn sự kiện chuyển tab bài 1, bài 2, bài 3
for (let i = 0; i < 3; i++) {
  $(`postTabBtn_${i}`)?.addEventListener('click', () => {
    switchPostTab(i);
  });
}

// Bật/tắt chế độ Đăng bài bằng link (Link Preview)
$('postLinkModeCheckbox')?.addEventListener('change', () => {
  const isChecked = !!$('postLinkModeCheckbox')?.checked;
  if (posts[currentPostIndex]) {
    posts[currentPostIndex].postLinkMode = isChecked;
  }
  if (isChecked) {
    setFbBackground('none');
    if (picture) {
      picture = null;
      if (posts[currentPostIndex]) posts[currentPostIndex].picture = null;
      updateImageUi();
    }
  }
  updatePostLinkModeUI(isChecked);
  chrome.storage.local.set({ draft: draft() });
});

// Nút nhảy nhanh từ Phần 3 lên Bước 1 xem từ cấm
$('jumpToBannedBtn')?.addEventListener('click', () => {
  $('text')?.focus();
  $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('enableBreak')?.addEventListener('change', () => {
  const row = $('breakSettingsRow');
  if (row) {
    row.style.opacity = $('enableBreak').checked ? '1' : '0.4';
    row.style.pointerEvents = $('enableBreak').checked ? 'auto' : 'none';
  }
});

$('enableDailyLimit')?.addEventListener('change', () => {
  const row = $('dailyLimitRow');
  if (row) {
    row.style.opacity = $('enableDailyLimit').checked ? '1' : '0.4';
    row.style.pointerEvents = $('enableDailyLimit').checked ? 'auto' : 'none';
  }
});

// ── Anti-Spam Collapsible Toggle & Live Summary Badge ─────────────────────────
function initAntiSpamToggle() {
  const card = $('antiSpamCard');
  const header = $('asToggleHeader');
  const btn = $('asToggleBtn');
  const btnText = $('asToggleBtnText');
  const arrow = $('asToggleArrow');
  const body = $('asBody');
  const badge = $('asSummaryBadge');

  if (!header || !body) return;

  function updateBadge() {
    if (!badge) return;
    const min = $('gapMin')?.value || 60;
    const max = $('gapMax')?.value || 90;
    const isDaily = $('enableDailyLimit')?.checked !== false;
    const limit = $('dailyLimit')?.value || 20;
    const parts = [`${min}-${max}s`];
    if (isDaily) parts.push(`Nick: ${limit} bài/ngày · Fanpage: 5 bài/ngày`);
    if ($('autoSkipOnError')?.checked) parts.push('Auto-skip');
    badge.textContent = parts.join(' · ');
  }

  function setCollapsed(collapsed) {
    if (collapsed) {
      body.style.display = 'none';
      if (btnText) btnText.textContent = 'Mở rộng';
      if (arrow) arrow.textContent = '▼';
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (card) card.classList.add('collapsed');
      localStorage.setItem('antiSpamCollapsed', '1');
    } else {
      body.style.display = 'block';
      if (btnText) btnText.textContent = 'Thu gọn';
      if (arrow) arrow.textContent = '▲';
      if (btn) btn.setAttribute('aria-expanded', 'true');
      if (card) card.classList.remove('collapsed');
      localStorage.setItem('antiSpamCollapsed', '0');
    }
    updateBadge();
  }

  header.addEventListener('click', (e) => {
    const isCurrentlyCollapsed = body.style.display === 'none';
    setCollapsed(!isCurrentlyCollapsed);
  });

  for (const id of ['gapMin', 'gapMax', 'enableDailyLimit', 'dailyLimit', 'autoSkipOnError', 'enableBreak']) {
    $(id)?.addEventListener('input', updateBadge);
    $(id)?.addEventListener('change', updateBadge);
  }

  const savedState = localStorage.getItem('antiSpamCollapsed');
  if (savedState === '1') {
    setCollapsed(true);
  } else {
    setCollapsed(false);
  }

  window.updateAntiSpamSummaryBadge = updateBadge;
}
initAntiSpamToggle();

// ── Load draft ─────────────────────────────────────────────────────────────────
const saved = (await chrome.storage.local.get('draft')).draft;
if (saved) {
  if (saved.groupSourceMode) groupSourceMode = saved.groupSourceMode;
  if (saved.cfgAccountType && ['personal', 'fanpage', 'all'].includes(saved.cfgAccountType)) {
    cfgAccountType = saved.cfgAccountType;
  }
  if (saved.accountCategoryMap && typeof saved.accountCategoryMap === 'object') {
    accountCategoryMap = saved.accountCategoryMap;
  }
  if (saved.posts && Array.isArray(saved.posts) && saved.posts.length > 0) {
    posts = [
      saved.posts[0] ? { ...saved.posts[0], postLinkMode: !!saved.posts[0].postLinkMode } : { id: 1, text: '', picture: null, background: null, postLinkMode: false },
      saved.posts[1] ? { ...saved.posts[1], postLinkMode: !!saved.posts[1].postLinkMode } : { id: 2, text: '', picture: null, background: null, postLinkMode: false },
      saved.posts[2] ? { ...saved.posts[2], postLinkMode: !!saved.posts[2].postLinkMode } : { id: 3, text: '', picture: null, background: null, postLinkMode: false },
    ];
  } else if (saved.text !== undefined || saved.picture !== undefined || saved.background !== undefined || saved.postLinkMode !== undefined) {
    posts = [
      { id: 1, text: saved.text || '', picture: saved.picture || null, background: saved.background || null, postLinkMode: !!saved.postLinkMode },
      { id: 2, text: '', picture: null, background: null, postLinkMode: false },
      { id: 3, text: '', picture: null, background: null, postLinkMode: false },
    ];
  }
  if (saved.accountPostMap && typeof saved.accountPostMap === 'object') {
    accountPostMap = saved.accountPostMap;
  }
  if (saved.currentPostIndex !== undefined && saved.currentPostIndex >= 0 && saved.currentPostIndex < 3) {
    currentPostIndex = saved.currentPostIndex;
  }
  for (const k of ['links', 'mode', 'when', 'gapMin', 'gapMax', 'breakAfter', 'breakMinutes', 'maxPosts', 'dailyLimit', 'accountOrder']) {
    if ($(k) && saved[k] !== undefined) $(k).value = saved[k];
  }
  if (saved.gap && !saved.gapMin && $('gapMin')) $('gapMin').value = saved.gap;
  if ($('splitSharedGroups') && saved.splitSharedGroups !== undefined) $('splitSharedGroups').checked = !!saved.splitSharedGroups;
  if (Array.isArray(saved.sharedSelectedAccounts)) {
    sharedSelectedAccIds = new Set(saved.sharedSelectedAccounts);
    sharedAccountsInitialized = true;
  }
  // Các tính năng chống spam & bảo vệ tài khoản cốt lõi luôn bật mặc định
  if ($('randomTag')) $('randomTag').checked = true;
  if ($('humanBehavior')) $('humanBehavior').checked = true;
  if ($('autoSkipOnError')) $('autoSkipOnError').checked = true;
  if ($('enableBreak') && saved.enableBreak !== undefined) {
    $('enableBreak').checked = !!saved.enableBreak;
    const row = $('breakSettingsRow');
    if (row) {
      row.style.opacity = $('enableBreak').checked ? '1' : '0.4';
      row.style.pointerEvents = $('enableBreak').checked ? 'auto' : 'none';
    }
  }
  if ($('enableDailyLimit') && saved.enableDailyLimit !== undefined) {
    $('enableDailyLimit').checked = !!saved.enableDailyLimit;
    const row = $('dailyLimitRow');
    if (row) {
      row.style.opacity = $('enableDailyLimit').checked ? '1' : '0.4';
      row.style.pointerEvents = $('enableDailyLimit').checked ? 'auto' : 'none';
    }
  }

  // Nạp bài viết hiện tại vào ô soạn thảo
  const curP = posts[currentPostIndex] || posts[0];
  if ($('text')) $('text').value = curP.text || '';
  picture = curP.picture || null;
  currentFbBg = curP.background || null;
}
checkAndRenderBannedWords();
updatePostTabsUi();
renderFbBackgroundSwatches();
setFbBackground(currentFbBg, false);
updatePostLinkModeUI(!!posts[currentPostIndex]?.postLinkMode);
window.updateAntiSpamSummaryBadge?.();
updateLinksStatsDisplay();

function updateImageUi() {
  const clearBtn = $('removeImageBtn');
  const imgName = $('currentPostImgName');
  if (clearBtn) {
    if (picture) {
      clearBtn.style.display = 'inline-flex';
      clearBtn.title = picture.name ? `Bỏ ảnh: ${picture.name}` : 'Bỏ ảnh đã chọn';
      if (imgName) imgName.textContent = picture.name || '';
    } else {
      clearBtn.style.display = 'none';
      clearBtn.title = '';
      if (imgName) imgName.textContent = '';
    }
  }
}
updateImageUi();

const imgEl = $('image');
if (imgEl) {
  imgEl.onchange = async () => {
    try {
      const f = imgEl.files?.[0];
      if (!f) return;
      if (currentFbBg) {
        setFbBackground(null, false);
      }
      if (f.size > 4 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
        throw Error('Chọn JPG/PNG/WebP tối đa 4 MB.');
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      picture = {name: f.name, type: f.type, data};
      if (posts[currentPostIndex]) posts[currentPostIndex].picture = picture;
      updateImageUi();
      updatePostTabsUi();
      await chrome.storage.local.set({draft: draft()});
    } catch (e) {
      msg(e.message);
      updateImageUi();
    }
  };
}

const removeImgBtn = document.getElementById('removeImageBtn');
if (removeImgBtn) {
  removeImgBtn.onclick = async () => {
    picture = null;
    if (posts[currentPostIndex]) posts[currentPostIndex].picture = null;
    if ($('image')) $('image').value = '';
    updateImageUi();
    updatePostTabsUi();
    msg('Đã bỏ ảnh đính kèm.');
    try {
      const { campaignPictures = {} } = await chrome.storage.local.get('campaignPictures');
      delete campaignPictures[currentPostIndex];
      await chrome.storage.local.set({ campaignPictures });
    } catch (_) {}
    await chrome.storage.local.set({draft: draft()});
  };
}

const saveBtn = document.getElementById('save');
if (saveBtn) {
  saveBtn.onclick = async () => {
    try {
      await chrome.storage.local.set({draft: draft()});
      msg('Đã lưu bản nháp trên máy.');
    } catch (e) { msg(e.message); }
  };
}

// ── Group Categories Toolbar Logic ────────────────────────────────────────────
async function loadAndRenderCategoriesDropdown() {
  const select = $('categorySelect');
  if (!select) return;

  const { groupCategories, lastSelectedCategory } = await chrome.storage.local.get(['groupCategories', 'lastSelectedCategory']);
  const cats = groupCategories || [];

  select.replaceChildren();
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = cats.length ? `-- Chọn danh mục nhóm (${cats.length} mục) --` : '-- Chưa có danh mục nào (bấm Quản lý để tạo) --';
  select.appendChild(defOpt);

  for (const cat of cats) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    const count = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
    opt.textContent = `${cat.name} (${count} nhóm)`;
    select.appendChild(opt);
  }

  if (lastSelectedCategory && cats.some(c => c.id === lastSelectedCategory)) {
    select.value = lastSelectedCategory;
  }
}

$('applyCategoryBtn')?.addEventListener('click', async () => {
  const catId = $('categorySelect')?.value;
  if (!catId) {
    msg('Vui lòng chọn một danh mục trong danh sách trước khi bấm Nạp nhóm.');
    return;
  }
  const { groupCategories } = await chrome.storage.local.get('groupCategories');
  const cat = (groupCategories || []).find(c => c.id === catId);
  if (!cat || !cat.links?.trim()) {
    msg('Danh mục này chưa có link nhóm nào.');
    return;
  }
  const count = cat.links.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
  if ($('links').value.trim() && !confirm(`Ghi đè ô nhóm bằng ${count} link từ danh mục "${cat.name}"?`)) return;

  $('links').value = cat.links.trim();
  await chrome.storage.local.set({ lastSelectedCategory: cat.id, draft: draft() });
  updateLinksStatsDisplay();
  msg(`✅ Đã nạp ${count} nhóm từ danh mục "${cat.name}".`);
});

// ── Cập nhật thống kê và lọc nhóm đã đăng trong ô nhóm ───────────────────────
async function updateLinksStatsDisplay() {
  const statEl = $('linksStatsText');
  if (!statEl) return;
  const raw = $('links')?.value || '';
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    statEl.textContent = '';
    return;
  }
  const postedKeys = await getAllPostedGroupKeys();
  let postedCount = 0;
  for (const line of lines) {
    const k = getGroupKey(line);
    if (k && postedKeys.has(k)) postedCount++;
  }
  const remainingCount = Math.max(0, lines.length - postedCount);
  if (postedCount > 0) {
    statEl.innerHTML = `Tổng: <b>${lines.length}</b> (Đã đăng: <b style="color:#16a34a">${postedCount}</b> · Chưa đăng: <b style="color:#2563eb">${remainingCount}</b>)`;
  } else {
    statEl.innerHTML = `Tổng: <b>${lines.length}</b> nhóm sẵn sàng`;
  }
}

$('links')?.addEventListener('input', debounce(updateLinksStatsDisplay, 300));

// Xử lý nút Lọc bỏ nhóm đã đăng
$('filterPostedLinksBtn')?.addEventListener('click', async () => {
  const raw = $('links')?.value || '';
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    alert('Chưa có link nhóm nào trong ô để lọc. Vui lòng nạp danh mục hoặc dán link nhóm trước.');
    return;
  }

  const postedKeys = await getAllPostedGroupKeys();
  if (!postedKeys.size) {
    alert('Chưa ghi nhận nhóm nào đã đăng trong Báo cáo kết quả hoặc Lịch sử đăng.\n\nNếu bạn vừa đăng xong hôm qua, hãy đảm bảo các bài đã đăng vẫn hiển thị trong phần 4. Báo cáo kết quả.');
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
    alert(`✅ Toàn bộ ${lines.length} nhóm trong danh sách đều CHƯA ĐĂNG (không trùng nhóm nào trong báo cáo/lịch sử)!\n\nBạn có thể an tâm bấm "Bắt đầu tất cả tài khoản" để chạy tiếp.`);
    return;
  }

  if (!remaining.length) {
    alert(`⚠️ Toàn bộ ${lines.length} nhóm trong danh sách này ĐÃ ĐƯỢC ĐĂNG HẾT!\n\nKhông còn nhóm nào chưa đăng để chạy tiếp. Nếu muốn chạy lại vòng mới, bạn có thể xóa báo cáo cũ.`);
    return;
  }

  const confirmMsg = `Phát hiện ${posted.length} nhóm ĐÃ ĐĂNG trong tổng số ${lines.length} nhóm.\n\n` +
    `👉 Bấm [OK] để TỰ ĐỘNG LỌC BỎ ${posted.length} nhóm đã đăng, chỉ giữ lại ${remaining.length} nhóm CHƯA ĐĂNG để tiếp tục chạy ngày hôm nay.\n` +
    `👉 Bấm [Cancel] nếu muốn giữ nguyên toàn bộ ${lines.length} nhóm.`;

  if (!confirm(confirmMsg)) return;

  $('links').value = remaining.join('\n');
  await chrome.storage.local.set({ draft: draft() });
  updateLinksStatsDisplay();
  msg(`🎉 Đã lọc bỏ ${posted.length} nhóm đã đăng! Hiện còn ${remaining.length} nhóm chưa đăng sẵn sàng chạy tiếp.`);
});

// ── Group Categories Tabs & Assignment Logic ─────────────────────────────────
function switchGroupSourceMode(mode) {
  groupSourceMode = mode;
  const isDark = document.body.classList.contains('ntd-dark-theme') || document.documentElement.classList.contains('ntd-dark-theme');
  const catBtn = $('tabModeCategories');
  const sharedBtn = $('tabModeShared');

  if (catBtn) {
    const isActive = (mode === 'categories');
    catBtn.classList.toggle('active', isActive);
    if (isDark) {
      catBtn.style.background = '';
      catBtn.style.color = '';
    } else {
      catBtn.style.background = isActive ? '#ed6b22' : '#f1f5f9';
      catBtn.style.color = isActive ? '#fff' : '#475569';
    }
  }
  if (sharedBtn) {
    const isActive = (mode === 'shared');
    sharedBtn.classList.toggle('active', isActive);
    if (isDark) {
      sharedBtn.style.background = '';
      sharedBtn.style.color = '';
    } else {
      sharedBtn.style.background = isActive ? '#ed6b22' : '#f1f5f9';
      sharedBtn.style.color = isActive ? '#fff' : '#475569';
    }
  }
  if ($('paneByCategories')) $('paneByCategories').style.display = mode === 'categories' ? 'block' : 'none';
  if ($('paneSharedLinks')) $('paneSharedLinks').style.display = mode === 'shared' ? 'block' : 'none';
  if (mode === 'shared') {
    renderSharedAccountsSelector();
  }
}
$('tabModeCategories')?.addEventListener('click', () => { switchGroupSourceMode('categories'); chrome.storage.local.set({ draft: draft() }); });
$('tabModeShared')?.addEventListener('click', () => { switchGroupSourceMode('shared'); chrome.storage.local.set({ draft: draft() }); });

function setCfgAccountType(type, shouldRender = true) {
  cfgAccountType = type;
  document.querySelectorAll('#cfgTypeSelectorBar .cfg-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  const searchInput = $('cfgSearchAccountInput');
  if (searchInput) {
    if (type === 'personal') searchInput.placeholder = 'Tìm kiếm tài khoản cá nhân...';
    else if (type === 'fanpage') searchInput.placeholder = 'Tìm kiếm trang Fanpage...';
    else searchInput.placeholder = 'Tìm kiếm tài khoản hoặc Fanpage...';
  }
  const bulkLabel = document.querySelector('#cfgBulkPostAssignBar > span');
  if (bulkLabel) {
    if (type === 'personal') bulkLabel.textContent = 'Gán nhanh bài cho nick cá nhân:';
    else if (type === 'fanpage') bulkLabel.textContent = 'Gán nhanh bài cho trang Fanpage:';
    else bulkLabel.textContent = 'Gán nhanh bài cho tất cả nick:';
  }
  if (shouldRender) {
    renderAccountCategoryAssignments();
    chrome.storage.local.set({ draft: draft() });
  }
}

function calcAccountGroups(catIds) {
  const set = new Set();
  if (Array.isArray(catIds)) {
    for (const catId of catIds) {
      const cat = loadedCategories.find(c => c.id === catId);
      if (cat?.links) {
        for (const l of cat.links.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
          set.add(l);
        }
      }
    }
  }
  return set;
}

function getAccountConfiguredGroupUrls(acc, curDraft = null) {
  if (!acc) return [];
  const d = curDraft || draft();
  if (groupSourceMode === 'categories') {
    const catIds = accountCategoryMap[acc.id] || [];
    return [...calcAccountGroups(catIds)];
  } else {
    // Dùng chung nhóm
    const isSelected = !sharedSelectedAccIds || sharedSelectedAccIds.has(acc.id);
    if (!isSelected) return [];

    if (acc.groups?.trim()) {
      return acc.groups.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    const sharedLines = ($('links')?.value || d?.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (sharedLines.length === 0) return [];

    const isSplit = $('splitSharedGroups')?.checked ?? d?.splitSharedGroups ?? false;
    if (isSplit) {
      const selectedAccs = (cachedAccounts || []).filter(a => (!sharedSelectedAccIds || sharedSelectedAccIds.has(a.id)) && !a.groups?.trim());
      const idx = selectedAccs.findIndex(a => a.id === acc.id);
      if (idx >= 0 && selectedAccs.length > 0) {
        return sharedLines.filter((_, i) => i % selectedAccs.length === idx);
      }
      return [];
    } else {
      return [...sharedLines];
    }
  }
}

function getAllConfiguredJobsOrCampaigns() {
  const allList = [];
  const accMap = new Map((cachedAccounts || []).map(a => [a.id, a]));

  if (cachedCampaigns && Object.keys(cachedCampaigns).length > 0) {
    for (const [accId, camp] of Object.entries(cachedCampaigns)) {
      const acc = accMap.get(accId);
      const accName = acc?.name || camp?.accountName || ('Tài khoản ' + String(accId || '').slice(0, 6));
      const jobs = camp?.jobs || [];
      const postIdx = camp?.postIndex !== undefined ? camp.postIndex : (accountPostMap[accId] ?? 0);
      const postTitle = camp?.postTitle || `Bài ${postIdx + 1}`;
      jobs.forEach((j, idx) => {
        allList.push({
          idx: idx + 1,
          accId,
          accName,
          accType: acc?.type || camp?.accountType || 'personal',
          postTitle,
          postIndex: postIdx,
          url: j?.url || '',
          postUrl: j?.postUrl || '',
          status: j?.status || 'queued',
          note: j?.note || '',
          doneAt: j?.doneAt || null,
          startedAt: j?.startedAt || null
        });
      });
    }
    return allList;
  }

  // Khi chưa bắt đầu chạy, tính toán từ cấu hình hiện tại
  const curDraft = draft();
  const accs = cachedAccounts || [];
  let globalIdx = 1;
  accs.forEach(acc => {
    const isSelected = (groupSourceMode === 'categories')
      ? !!(accountCategoryMap[acc.id]?.length)
      : (!sharedSelectedAccIds || sharedSelectedAccIds.has(acc.id));
    if (!isSelected) return;

    const urls = getAccountConfiguredGroupUrls(acc, curDraft);
    const postIdx = (accountPostMap && accountPostMap[acc.id] !== undefined)
      ? Number(accountPostMap[acc.id])
      : 0;
    const postTitle = `Bài ${postIdx + 1}`;

    urls.forEach(url => {
      allList.push({
        idx: globalIdx++,
        accId: acc.id,
        accName: acc.name,
        accType: acc.type || 'personal',
        postTitle,
        postIndex: postIdx,
        url,
        postUrl: '',
        status: 'queued',
        note: 'Sẵn sàng trong hàng đợi đăng',
        doneAt: null,
        startedAt: null
      });
    });
  });

  return allList;
}

function updateMasterKpiMetrics(accs = [], campaigns = {}) {
  const elAccs = $('dashKpiAccounts');
  const elPersonal = $('dashKpiPersonal');
  const elFanpages = $('dashKpiFanpages');
  const elGroups = $('dashKpiSelectedGroups');
  const elRunning = $('dashKpiRunning');

  const personalAccs = accs.filter(a => a.type !== 'fanpage');
  const fanpageAccs = accs.filter(a => a.type === 'fanpage');

  if (elAccs) elAccs.textContent = accs.length;
  if (elPersonal) elPersonal.textContent = personalAccs.length;
  if (elFanpages) elFanpages.textContent = fanpageAccs.length;

  let totalGroupsConfigured = 0;
  if (groupSourceMode === 'categories') {
    for (const acc of accs) {
      const catIds = accountCategoryMap[acc.id] || [];
      const grpSet = calcAccountGroups(catIds);
      totalGroupsConfigured += grpSet.size;
    }
  } else {
    const lines = ($('links')?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const selCount = accs.filter(a => !sharedSelectedAccIds || sharedSelectedAccIds.has(a.id)).length;
    const isSplit = $('splitSharedGroups')?.checked ?? false;
    totalGroupsConfigured = isSplit ? lines.length : (lines.length * (selCount || 1));
  }
  if (elGroups) elGroups.textContent = totalGroupsConfigured;

  const elRepTotal = $('reportCountTotal');
  if (elRepTotal && (!campaigns || Object.keys(campaigns).length === 0)) {
    elRepTotal.textContent = totalGroupsConfigured;
  }

  let runningCount = 0;
  for (const c of Object.values(campaigns || {})) {
    if (c?.state === 'running' || c?.state === 'waiting') runningCount++;
  }
  if (elRunning) elRunning.textContent = runningCount;

  // Cập nhật số đếm và nội dung Note danh sách link bài để đăng
  const elHdrCount = $('hdrQueuedCount');
  if (elHdrCount) elHdrCount.textContent = totalGroupsConfigured;

  // Cập nhật số đếm bài viết đã đăng thành công
  let postedCount = 0;
  for (const c of Object.values(campaigns || {})) {
    for (const j of c?.jobs || []) {
      if (['submitted', 'sent_unverified', 'pending', 'preview'].includes(j.status)) {
        postedCount++;
      }
    }
  }
  const elHdrPosted = $('hdrPostedCount');
  if (elHdrPosted) elHdrPosted.textContent = postedCount;
  const elModalPosted = $('modalTabPostedCount');
  if (elModalPosted) elModalPosted.textContent = postedCount;
  const elModalQueued = $('modalTabQueuedCount');
  if (elModalQueued) elModalQueued.textContent = totalGroupsConfigured;

  const elNoteBadge = $('progQueuedNoteBadge');
  if (elNoteBadge) elNoteBadge.textContent = `${totalGroupsConfigured} link`;

  const elNoteDesc = $('progQueuedNoteDesc');
  if (elNoteDesc) {
    if (totalGroupsConfigured === 0) {
      elNoteDesc.innerHTML = 'Chưa có link nhóm nào được chọn. Hãy cấu hình ở mục <b>2. Cấu hình nhóm đăng bài</b>.';
    } else {
      const pCount = personalAccs.length;
      const fCount = fanpageAccs.length;
      let targetDesc = '';
      if (pCount > 0 && fCount > 0) targetDesc = `${pCount} nick cá nhân & ${fCount} trang Fanpage`;
      else if (fCount > 0) targetDesc = `${fCount} trang Fanpage`;
      else targetDesc = `${pCount} nick cá nhân`;
      elNoteDesc.innerHTML = `Đang có <b>${totalGroupsConfigured}</b> link nhóm sẵn sàng đăng cho ${targetDesc}.`;
    }
  }
}

async function renderAccountCategoryAssignments() {
  const container = $('accountCategoryAssignList');
  if (!container) return;

  const { accounts, groupCategories, campaigns } = await chrome.storage.local.get(['accounts', 'groupCategories', 'campaigns']);
  const accs = accounts || [];
  loadedCategories = groupCategories || [];

  updateMasterKpiMetrics(accs, campaigns || {});

  // Tách riêng tài khoản cá nhân và trang Fanpage
  const personalAccs = accs.filter(a => a.type !== 'fanpage');
  const fanpageAccs = accs.filter(a => a.type === 'fanpage');

  // Cập nhật số đếm trên 2 nút quản lý Section 2
  if ($('cfgTypeCountPersonal')) $('cfgTypeCountPersonal').textContent = personalAccs.length;
  if ($('cfgTypeCountFanpage')) $('cfgTypeCountFanpage').textContent = fanpageAccs.length;
  if ($('cfgTypeCountAll')) $('cfgTypeCountAll').textContent = accs.length;

  if (!accs.length) {
    container.innerHTML = `
      <div style="background:#fffbe6;border:1px solid #ffe58f;border-radius:10px;padding:16px;text-align:center;font-size:12.5px;color:#7a5c00">
        <b>Chưa có tài khoản Facebook hoặc Fanpage nào.</b><br>
        <span style="font-size:12px;color:#64748b">Vui lòng thêm tài khoản để bắt đầu cấu hình đăng bài vào các nhóm.</span>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap">
          <a href="${accountsUrl}" class="manage-btn" style="text-decoration:none;font-weight:700">Thêm nick cá nhân →</a>
          <a href="fanpages.html" class="manage-btn" style="background:#dc2626;color:#fff;border:none;text-decoration:none;font-weight:700">Thêm trang Fanpage →</a>
        </div>
      </div>`;
    if ($('cfgCountAll')) $('cfgCountAll').textContent = 0;
    if ($('cfgCountSelected')) $('cfgCountSelected').textContent = 0;
    if ($('cfgCountUnselected')) $('cfgCountUnselected').textContent = 0;
    return;
  }

  // Xác định danh sách tài khoản thuộc phạm vi hiển thị
  let targetPool = accs;
  if (cfgAccountType === 'personal') {
    targetPool = personalAccs;
  } else if (cfgAccountType === 'fanpage') {
    targetPool = fanpageAccs;
  }

  // Nếu tab hiện tại chưa có tài khoản nào
  if (cfgAccountType === 'personal' && !personalAccs.length) {
    container.innerHTML = `
      <div style="background:#fffbe6;border:1px solid #ffe58f;border-radius:10px;padding:18px;text-align:center;font-size:12.5px;color:#7a5c00">
        <b>Chưa có tài khoản Facebook cá nhân nào.</b><br>
        <span style="font-size:12px;color:#64748b">Bạn đang ở phần quản lý nick cá nhân. Hãy thêm nick cá nhân để cấu hình danh mục nhóm riêng cho từng nick.</span><br>
        <div style="margin-top:12px">
          <a href="${accountsUrl}" class="manage-btn" style="text-decoration:none;font-weight:700;display:inline-block">Quản lý &amp; Thêm nick cá nhân ngay →</a>
        </div>
      </div>`;
    if ($('cfgCountAll')) $('cfgCountAll').textContent = 0;
    if ($('cfgCountSelected')) $('cfgCountSelected').textContent = 0;
    if ($('cfgCountUnselected')) $('cfgCountUnselected').textContent = 0;
    return;
  }

  if (cfgAccountType === 'fanpage' && !fanpageAccs.length) {
    container.innerHTML = `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:18px;text-align:center;font-size:12.5px;color:#991b1b">
        <b>Chưa có trang Fanpage nào trong danh sách.</b><br>
        <span style="font-size:12px;color:#64748b">Bạn đang ở phần quản lý trang Fanpage. Thêm Fanpage để đăng nhóm tự động (tối đa 5 bài/ngày/page chống checkpoint).</span><br>
        <div style="margin-top:12px">
          <a href="fanpages.html" class="manage-btn" style="background:#dc2626;color:#fff;border:none;text-decoration:none;font-weight:700;display:inline-block">Quản lý &amp; Thêm trang Fanpage ngay →</a>
        </div>
      </div>`;
    if ($('cfgCountAll')) $('cfgCountAll').textContent = 0;
    if ($('cfgCountSelected')) $('cfgCountSelected').textContent = 0;
    if ($('cfgCountUnselected')) $('cfgCountUnselected').textContent = 0;
    return;
  }

  if (!loadedCategories.length) {
    container.innerHTML = `
      <div style="background:#fffbe6;border:1px solid #ffe58f;border-radius:10px;padding:16px;text-align:center;font-size:13px;color:#7a5c00">
        <b>Kho danh mục nhóm hiện đang trống.</b><br>
        <span style="font-size:12px;color:#64748b">Hãy tạo các danh mục nhóm nhỏ (Ví dụ: Nhóm 1, Nhóm 2, Bất động sản, Rao vặt...) để chọn cho từng nick hoặc chuyển sang dùng danh sách nhóm chung.</span><br>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap">
          <a href="groups.html#categories" class="manage-btn" style="text-decoration:none;font-weight:700">Tạo danh mục nhóm ngay →</a>
          <button type="button" id="switchToSharedQuickBtn" class="manage-btn" style="background:#ed6b22;color:#fff;border:none;font-weight:700;cursor:pointer">Chuyển sang Dùng chung nhóm</button>
        </div>
      </div>`;
    $('switchToSharedQuickBtn')?.addEventListener('click', () => {
      switchGroupSourceMode('shared');
      chrome.storage.local.set({ draft: draft() });
    });
    return;
  }

  // Đếm cho các nút bộ lọc theo phạm vi tài khoản hiện tại
  let selectedCount = 0;
  let unselectedCount = 0;
  targetPool.forEach(acc => {
    const selCatIds = accountCategoryMap[acc.id] || [];
    const grpSet = calcAccountGroups(selCatIds);
    if (grpSet.size > 0) selectedCount++;
    else unselectedCount++;
  });

  if ($('cfgCountAll')) $('cfgCountAll').textContent = targetPool.length;
  if ($('cfgCountSelected')) $('cfgCountSelected').textContent = selectedCount;
  if ($('cfgCountUnselected')) $('cfgCountUnselected').textContent = unselectedCount;

  // Lọc tài khoản theo từ khóa tìm kiếm và tab bộ lọc
  const filteredAccs = targetPool.filter(acc => {
    const selCatIds = accountCategoryMap[acc.id] || [];
    const grpSet = calcAccountGroups(selCatIds);
    const isSelected = grpSet.size > 0;

    if (cfgFilter === 'selected' && !isSelected) return false;
    if (cfgFilter === 'unselected' && isSelected) return false;

    if (cfgSearchTerm) {
      if (!acc.name.toLowerCase().includes(cfgSearchTerm)) return false;
    }
    return true;
  });

  container.replaceChildren();

  if (!filteredAccs.length) {
    const searchScopeText = cfgAccountType === 'personal' ? 'tài khoản cá nhân' : (cfgAccountType === 'fanpage' ? 'trang Fanpage' : 'tài khoản');
    container.innerHTML = `
      <div style="background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:20px;text-align:center;font-size:12px;color:#64748b">
        Không tìm thấy ${searchScopeText} nào phù hợp với bộ lọc hoặc từ khóa tìm kiếm.
      </div>`;
    return;
  }

  const renderAccItem = (acc) => {
    let selectedCatIds = accountCategoryMap[acc.id] || [];
    if (!Array.isArray(selectedCatIds)) selectedCatIds = [];

    const initialSet = calcAccountGroups(selectedCatIds);
    const isChecked = initialSet.size > 0;
    const isExpanded = expandedCategoryAccs.has(acc.id);

    const selCats = loadedCategories.filter(c => selectedCatIds.includes(c.id));
    const catSummaryText = selCats.length > 0 
      ? selCats.map(c => c.name).join(', ')
      : 'Chưa chọn danh mục nhóm';

    const item = document.createElement('div');
    item.className = `cfg-acc-item ${isExpanded ? 'expanded' : ''}`;
    item.dataset.id = acc.id;

    item.innerHTML = `
      <div class="cfg-acc-row" data-id="${acc.id}">
        <div class="cfg-acc-left">
          <div class="cfg-acc-check-icon ${isChecked ? 'checked' : ''}" id="cfgCheckIcon_${acc.id}">
            ${isChecked ? '✓' : ''}
          </div>
          <div class="cfg-acc-info">
            <div class="cfg-acc-name">
              <span>${acc.name}</span>
            </div>
            <div class="cfg-acc-sub" id="cfgAccSub_${acc.id}">
              <b>${initialSet.size} nhóm</b> · <span>${catSummaryText}</span>
              ${acc.type === 'fanpage' ? ' · <span class="cfg-fp-limit-text" style="color:#ef4444;font-weight:600">Tối đa 5 bài/ngày</span>' : ''}
            </div>
          </div>
        </div>
        <div class="cfg-acc-post-pick" id="cfgAccPostPick_${acc.id}"></div>
        <div class="cfg-acc-right">
          <span class="cfg-badge ${isChecked ? 'active' : ''}" id="cfgBadge_${acc.id}">${initialSet.size} nhóm</span>
          <span class="cfg-chevron">›</span>
        </div>
      </div>

      <div class="cfg-acc-drawer" id="cfgDrawer_${acc.id}" style="display:${isExpanded ? 'block' : 'none'}">
        <div class="cfg-drawer-post-picker" id="cfgDrawerPostPicker_${acc.id}"></div>
        <div class="cfg-drawer-actions">
          <span>Chọn danh mục nhóm cho ${acc.type === 'fanpage' ? 'trang Fanpage' : 'tài khoản'} này:</span>
          <div style="display:flex;gap:5px">
            <button type="button" class="chip-btn select-all-cats-btn" data-id="${acc.id}" style="padding:2px 8px;font-size:10.5px">Chọn tất cả</button>
            <button type="button" class="chip-btn deselect-all-cats-btn" data-id="${acc.id}" style="padding:2px 8px;font-size:10.5px">Bỏ chọn</button>
          </div>
        </div>
        <div class="cat-pills-wrap">
          ${loadedCategories.map(cat => {
            const links = (cat.links || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const isCatChecked = selectedCatIds.includes(cat.id);
            return `
              <label class="cat-pill ${isCatChecked ? 'checked' : ''}" data-cat="${cat.id}">
                <input type="checkbox" class="acc-cat-check" data-acc="${acc.id}" data-cat="${cat.id}" ${isCatChecked ? 'checked' : ''}>
                <span>${cat.name} <small style="opacity:.8">(${links.length})</small></span>
              </label>
            `;
          }).join('')}
        </div>
      </div>
    `;

    // Row click toggle expand/collapse
    const rowEl = item.querySelector('.cfg-acc-row');
    const drawerEl = item.querySelector('.cfg-acc-drawer');
    rowEl.onclick = () => {
      const willExpand = !expandedCategoryAccs.has(acc.id);
      if (willExpand) {
        expandedCategoryAccs.add(acc.id);
        item.classList.add('expanded');
        drawerEl.style.display = 'block';
      } else {
        expandedCategoryAccs.delete(acc.id);
        item.classList.remove('expanded');
        drawerEl.style.display = 'none';
      }
    };

    // Category pills logic
    const pills = item.querySelectorAll('.cat-pill');
    const updateAccountRowUi = (currentCatIds) => {
      accountCategoryMap[acc.id] = currentCatIds;
      const grpSet = calcAccountGroups(currentCatIds);
      const hasCats = grpSet.size > 0;

      const badge = $(`cfgBadge_${acc.id}`);
      if (badge) {
        badge.textContent = `${grpSet.size} nhóm`;
        badge.classList.toggle('active', hasCats);
      }

      const checkIcon = $(`cfgCheckIcon_${acc.id}`);
      if (checkIcon) {
        checkIcon.classList.toggle('checked', hasCats);
        checkIcon.textContent = hasCats ? '✓' : '';
      }

      const sub = $(`cfgAccSub_${acc.id}`);
      if (sub) {
        const curCats = loadedCategories.filter(c => currentCatIds.includes(c.id));
        const names = curCats.length > 0 ? curCats.map(c => c.name).join(', ') : 'Chưa chọn danh mục nhóm';
        sub.innerHTML = `<b>${grpSet.size} nhóm</b> · <span>${names}</span>${acc.type === 'fanpage' ? ' · <span style="color:#dc2626;font-weight:600">Tối đa 5 bài/ngày</span>' : ''}`;
      }

      let selCount = 0;
      let unselCount = 0;
      targetPool.forEach(a => {
        const cIds = accountCategoryMap[a.id] || [];
        if (calcAccountGroups(cIds).size > 0) selCount++;
        else unselCount++;
      });
      if ($('cfgCountSelected')) $('cfgCountSelected').textContent = selCount;
      if ($('cfgCountUnselected')) $('cfgCountUnselected').textContent = unselCount;

      updateMasterKpiMetrics(accs, cachedCampaigns);
      chrome.storage.local.set({ draft: draft() });
    };

    pills.forEach(pill => {
      const check = pill.querySelector('.acc-cat-check');
      check.onchange = () => {
        pill.classList.toggle('checked', check.checked);
        const currentChecked = [...item.querySelectorAll('.acc-cat-check:checked')].map(c => c.dataset.cat);
        updateAccountRowUi(currentChecked);
      };
    });

    item.querySelector('.select-all-cats-btn').onclick = (e) => {
      e.stopPropagation();
      pills.forEach(p => {
        p.classList.add('checked');
        p.querySelector('.acc-cat-check').checked = true;
      });
      updateAccountRowUi(loadedCategories.map(c => c.id));
    };

    item.querySelector('.deselect-all-cats-btn').onclick = (e) => {
      e.stopPropagation();
      pills.forEach(p => {
        p.classList.remove('checked');
        p.querySelector('.acc-cat-check').checked = false;
      });
      updateAccountRowUi([]);
    };

    const postPickEl = item.querySelector(`#cfgAccPostPick_${acc.id}`);
    const drawerPostEl = item.querySelector(`#cfgDrawerPostPicker_${acc.id}`);
    renderPostButtonsForAccount(acc.id, postPickEl, drawerPostEl);

    return item;
  };

  if (cfgAccountType === 'all') {
    const pGroup = filteredAccs.filter(a => a.type !== 'fanpage');
    const fGroup = filteredAccs.filter(a => a.type === 'fanpage');

    if (pGroup.length > 0) {
      const pHeader = document.createElement('div');
      pHeader.className = 'cfg-group-section-title';
      pHeader.innerHTML = `<span>Tài khoản cá nhân</span><span>${pGroup.length} nick</span>`;
      container.appendChild(pHeader);
      pGroup.forEach(a => container.appendChild(renderAccItem(a)));
    }

    if (fGroup.length > 0) {
      const fHeader = document.createElement('div');
      fHeader.className = 'cfg-group-section-title';
      fHeader.style.color = '#dc2626';
      fHeader.style.marginTop = '12px';
      fHeader.innerHTML = `<span>Trang Fanpage</span><span>${fGroup.length} page · 5 bài/ngày</span>`;
      container.appendChild(fHeader);
      fGroup.forEach(a => container.appendChild(renderAccItem(a)));
    }
  } else {
    filteredAccs.forEach(a => container.appendChild(renderAccItem(a)));
  }

  updateAllAccountPostPickers();
}

// ── Selector Tabs for Section 2 (Tài khoản cá nhân vs Fanpage) ───────────────
document.querySelectorAll('#cfgTypeSelectorBar .cfg-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.type || 'personal';
    setCfgAccountType(t, true);
  });
});

// ── Toolbar Search & Filter Events for Section 2 ─────────────────────────────
const debouncedSearchAccountAssignments = debounce(() => {
  renderAccountCategoryAssignments();
}, 150);

$('cfgSearchAccountInput')?.addEventListener('input', (e) => {
  cfgSearchTerm = e.target.value.trim().toLowerCase();
  debouncedSearchAccountAssignments();
});

document.querySelectorAll('#cfgFilterPills .cfg-filter-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#cfgFilterPills .cfg-filter-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    cfgFilter = btn.dataset.filter || 'all';
    renderAccountCategoryAssignments();
  });
});

$('cfgBulkSelectAllBtn')?.addEventListener('click', async () => {
  if (!loadedCategories.length) {
    msg('Kho danh mục nhóm đang trống.');
    return;
  }
  const { accounts } = await chrome.storage.local.get('accounts');
  const allCatIds = loadedCategories.map(c => c.id);
  const targetAccs = (accounts || []).filter(a => {
    if (cfgAccountType === 'personal') return a.type !== 'fanpage';
    if (cfgAccountType === 'fanpage') return a.type === 'fanpage';
    return true;
  });
  targetAccs.forEach(acc => {
    accountCategoryMap[acc.id] = [...allCatIds];
  });
  await chrome.storage.local.set({ draft: draft() });
  await renderAccountCategoryAssignments();
  const label = cfgAccountType === 'personal' ? 'tài khoản cá nhân' : (cfgAccountType === 'fanpage' ? 'trang Fanpage' : 'tài khoản');
  msg(`✅ Đã chọn tất cả danh mục nhóm cho ${targetAccs.length} ${label}.`);
});

$('cfgBulkDeselectBtn')?.addEventListener('click', async () => {
  const { accounts } = await chrome.storage.local.get('accounts');
  const targetAccs = (accounts || []).filter(a => {
    if (cfgAccountType === 'personal') return a.type !== 'fanpage';
    if (cfgAccountType === 'fanpage') return a.type === 'fanpage';
    return true;
  });
  targetAccs.forEach(acc => {
    accountCategoryMap[acc.id] = [];
  });
  await chrome.storage.local.set({ draft: draft() });
  await renderAccountCategoryAssignments();
  const label = cfgAccountType === 'personal' ? 'tài khoản cá nhân' : (cfgAccountType === 'fanpage' ? 'trang Fanpage' : 'tài khoản');
  msg(`Đã bỏ chọn tất cả danh mục nhóm của ${targetAccs.length} ${label}.`);
});

// ── Shared Groups Account & Fanpage Selector Logic ────────────────────────────
function updateSharedCounters(accounts = []) {
  const selectedCount = accounts.filter(a => sharedSelectedAccIds.has(a.id)).length;
  if ($('sharedSelectedCount')) $('sharedSelectedCount').textContent = selectedCount;
  if ($('sharedTotalCount')) $('sharedTotalCount').textContent = accounts.length;

  const groupLines = ($('links')?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const totalGroups = groupLines.length;
  const isSplit = $('splitSharedGroups')?.checked ?? false;

  document.querySelectorAll('#sharedAccountList .shared-acc-card').forEach(card => {
    const accId = card.dataset.accId;
    const isSelected = sharedSelectedAccIds.has(accId);
    const groupDiv = card.querySelector('.shared-group-dist');
    if (groupDiv) {
      if (!isSelected) {
        groupDiv.innerHTML = '<span style="color:#94a3b8;font-size:11px">Không chạy</span>';
      } else if (totalGroups === 0) {
        groupDiv.innerHTML = '<span style="color:#94a3b8;font-size:11px">Chưa nhập link nhóm</span>';
      } else if (isSplit) {
        const approx = selectedCount > 0 ? Math.max(1, Math.round(totalGroups / selectedCount)) : totalGroups;
        groupDiv.innerHTML = `<span style="color:#0284c7;font-weight:700;font-size:11px">~${approx} nhóm (chia đều)</span>`;
      } else {
        groupDiv.innerHTML = `<span style="color:#059669;font-weight:700;font-size:11px">${totalGroups} nhóm</span>`;
      }
    }
  });

  updateMasterKpiMetrics(accounts, cachedCampaigns || {});
}

async function renderSharedAccountsSelector() {
  const container = $('sharedAccountList');
  if (!container) return;

  const { accounts = [] } = await chrome.storage.local.get('accounts');
  
  if (!sharedAccountsInitialized) {
    sharedAccountsInitialized = true;
    if (saved?.sharedSelectedAccounts && Array.isArray(saved.sharedSelectedAccounts)) {
      sharedSelectedAccIds = new Set(saved.sharedSelectedAccounts);
    } else {
      sharedSelectedAccIds = new Set(accounts.map(a => a.id));
    }
  }

  const personalAccs = accounts.filter(a => a.type !== 'fanpage');
  const fanpageAccs = accounts.filter(a => a.type === 'fanpage');

  if ($('sharedTypeCountAll')) $('sharedTypeCountAll').textContent = accounts.length;
  if ($('sharedTypeCountPersonal')) $('sharedTypeCountPersonal').textContent = personalAccs.length;
  if ($('sharedTypeCountFanpage')) $('sharedTypeCountFanpage').textContent = fanpageAccs.length;

  const selectedCount = accounts.filter(a => sharedSelectedAccIds.has(a.id)).length;
  if ($('sharedSelectedCount')) $('sharedSelectedCount').textContent = selectedCount;
  if ($('sharedTotalCount')) $('sharedTotalCount').textContent = accounts.length;

  if (!accounts.length) {
    container.innerHTML = `
      <div style="background:#fffbe6;border:1px solid #ffe58f;border-radius:8px;padding:12px;text-align:center;font-size:12px;color:#7a5c00">
        Chưa có tài khoản Facebook hoặc Fanpage nào. Vui lòng thêm tài khoản trước.
      </div>`;
    return;
  }

  let targetPool = accounts;
  if (sharedAccountType === 'personal') targetPool = personalAccs;
  else if (sharedAccountType === 'fanpage') targetPool = fanpageAccs;

  const term = sharedSearchTerm.trim().toLowerCase();
  const filtered = targetPool.filter(a => !term || (a.name || '').toLowerCase().includes(term));

  if (!filtered.length) {
    container.innerHTML = `
      <div style="background:var(--surface, #f8fafc);border:1px dashed var(--border, #cbd5e1);border-radius:8px;padding:14px;text-align:center;font-size:12px;color:var(--text-muted, #64748b)">
        Không tìm thấy tài khoản hoặc Fanpage nào phù hợp với bộ lọc.
      </div>`;
    return;
  }

  const groupLines = ($('links')?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const totalGroups = groupLines.length;
  const isSplit = $('splitSharedGroups')?.checked ?? false;

  container.replaceChildren();
  const frag = document.createDocumentFragment();

  filtered.forEach(acc => {
    const isSelected = sharedSelectedAccIds.has(acc.id);
    const isFanpage = acc.type === 'fanpage';

    const card = document.createElement('div');
    card.className = `shared-acc-card ${isSelected ? 'selected' : ''}`;
    card.dataset.accId = acc.id;

    let groupDistributionText = '';
    if (!isSelected) {
      groupDistributionText = '<span style="color:#94a3b8;font-size:11px">Không chạy</span>';
    } else if (totalGroups === 0) {
      groupDistributionText = '<span style="color:#94a3b8;font-size:11px">Chưa nhập link nhóm</span>';
    } else if (isSplit) {
      const approx = selectedCount > 0 ? Math.max(1, Math.round(totalGroups / selectedCount)) : totalGroups;
      groupDistributionText = `<span style="color:#0284c7;font-weight:700;font-size:11px">~${approx} nhóm (chia đều)</span>`;
    } else {
      groupDistributionText = `<span style="color:#059669;font-weight:700;font-size:11px">${totalGroups} nhóm</span>`;
    }

    const curPostIdx = (accountPostMap && accountPostMap[acc.id] !== undefined)
      ? Number(accountPostMap[acc.id])
      : 0;

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <input type="checkbox" class="shared-acc-cb" ${isSelected ? 'checked' : ''} style="cursor:pointer;accent-color:#0f172a;width:15px;height:15px;flex-shrink:0">
        <span style="font-size:14px;flex-shrink:0">${isFanpage ? '🚩' : '👤'}</span>
        <div style="display:flex;flex-direction:column;min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:12.5px;font-weight:700;color:var(--text, #0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${acc.name}</span>
            <span class="cfg-acc-type-pill ${isFanpage ? 'fanpage' : 'personal'}" style="font-size:10px;padding:1px 5px;border-radius:4px">${isFanpage ? 'Fanpage' : 'Cá nhân'}</span>
          </div>
          <div class="shared-group-dist" style="margin-top:1px">${groupDistributionText}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button type="button" class="shared-post-btn" data-acc-id="${acc.id}" title="Bấm để đổi bài viết gán cho tài khoản này (Bài 1, Bài 2, Bài 3)">
          Bài ${curPostIdx + 1}
        </button>
      </div>
    `;

    const cb = card.querySelector('.shared-acc-cb');
    const toggleSelect = (e) => {
      if (e.target.closest('.shared-post-btn')) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      if (cb.checked) {
        sharedSelectedAccIds.add(acc.id);
        card.classList.add('selected');
      } else {
        sharedSelectedAccIds.delete(acc.id);
        card.classList.remove('selected');
      }
      updateSharedCounters(accounts);
      debouncedSaveDraft();
    };

    card.addEventListener('click', toggleSelect);

    const postBtn = card.querySelector('.shared-post-btn');
    if (postBtn) {
      postBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentVal = (accountPostMap && accountPostMap[acc.id] !== undefined)
          ? Number(accountPostMap[acc.id])
          : 0;
        const nextIdx = (currentVal + 1) % 3;
        accountPostMap[acc.id] = nextIdx;
        postBtn.textContent = `Bài ${nextIdx + 1}`;
        debouncedSaveDraft();
      });
    }

    frag.appendChild(card);
  });

  container.appendChild(frag);
}

$('sharedSelectAllBtn')?.addEventListener('click', async () => {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  let targetPool = accounts;
  if (sharedAccountType === 'personal') targetPool = accounts.filter(a => a.type !== 'fanpage');
  else if (sharedAccountType === 'fanpage') targetPool = accounts.filter(a => a.type === 'fanpage');
  targetPool.forEach(a => sharedSelectedAccIds.add(a.id));
  await renderSharedAccountsSelector();
  debouncedSaveDraft();
});

$('sharedDeselectAllBtn')?.addEventListener('click', async () => {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  let targetPool = accounts;
  if (sharedAccountType === 'personal') targetPool = accounts.filter(a => a.type !== 'fanpage');
  else if (sharedAccountType === 'fanpage') targetPool = accounts.filter(a => a.type === 'fanpage');
  targetPool.forEach(a => sharedSelectedAccIds.delete(a.id));
  await renderSharedAccountsSelector();
  debouncedSaveDraft();
});

document.querySelectorAll('#sharedTypeSelectorBar .cfg-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sharedAccountType = btn.dataset.type || 'all';
    document.querySelectorAll('#sharedTypeSelectorBar .cfg-type-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    renderSharedAccountsSelector();
  });
});

const debouncedSharedSearch = debounce(() => {
  renderSharedAccountsSelector();
}, 120);

$('sharedSearchInput')?.addEventListener('input', (e) => {
  sharedSearchTerm = e.target.value || '';
  debouncedSharedSearch();
});

const debouncedUpdateSharedCounters = debounce(async () => {
  let accs = cachedAccounts;
  if (!accs || !accs.length) {
    const data = await chrome.storage.local.get('accounts');
    accs = data.accounts || [];
    cachedAccounts = accs;
  }
  updateSharedCounters(accs);
}, 150);

$('links')?.addEventListener('input', debouncedUpdateSharedCounters);

$('splitSharedGroups')?.addEventListener('change', async () => {
  let accs = cachedAccounts;
  if (!accs || !accs.length) {
    const data = await chrome.storage.local.get('accounts');
    accs = data.accounts || [];
    cachedAccounts = accs;
  }
  updateSharedCounters(accs);
});

await loadAndRenderCategoriesDropdown();
setCfgAccountType(cfgAccountType, false);
await renderAccountCategoryAssignments();
await renderSharedAccountsSelector();
switchGroupSourceMode(groupSourceMode);

function getFirstTargetGroupUrl(draftData, accounts) {
  if (!accounts || !accounts.length) return 'https://www.facebook.com/';
  const firstAcc = accounts[0];
  let linkStr = '';
  if (draftData.groupSourceMode === 'categories') {
    linkStr = draftData.accountGroups?.[firstAcc.id] || '';
  } else {
    linkStr = firstAcc.groups?.trim() || draftData.links?.trim() || '';
  }
  if (!linkStr) {
    for (const a of accounts) {
      const s = draftData.groupSourceMode === 'categories'
        ? (draftData.accountGroups?.[a.id] || '')
        : (a.groups?.trim() || draftData.links?.trim() || '');
      if (s.trim()) { linkStr = s; break; }
    }
  }
  if (linkStr) {
    const lines = linkStr.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
    if (lines.length > 0) return lines[0];
  }
  return 'https://www.facebook.com/';
}

// ── Start all ─────────────────────────────────────────────────────────────────
const startAllEl = $('startAllBtn');
if (startAllEl) {
  startAllEl.onclick = async () => {
    let postTab = null;
    try {
      licenseInfo = await checkLicense();
      if (!licenseInfo) {
        alert('⚠️ Tiện ích chưa được kích hoạt bản quyền.\n\nVui lòng kích hoạt key bản quyền hoặc bấm "⚡ Cập nhật dữ liệu cũ / Đồng bộ" để lấy lại bản quyền và tài khoản từ bản cũ!');
        window.location.href = chrome.runtime.getURL('activate.html');
        return;
      }
      const curDraft = draft();
      const {accounts} = await chrome.storage.local.get('accounts');
      if (!accounts?.length) throw Error('Chưa có tài khoản nào. Hãy thêm tài khoản trước.');

      // Kiểm tra danh sách tài khoản có nhóm để đăng bài
      const activePostingAccs = accounts.filter(a => {
        if (curDraft.groupSourceMode === 'categories') {
          return !!(curDraft.accountGroups?.[a.id]?.trim());
        } else {
          const isSelected = !curDraft.sharedSelectedAccounts || curDraft.sharedSelectedAccounts.includes(a.id);
          return isSelected && !!(a.groups?.trim() || curDraft.links?.trim());
        }
      });

      if (!activePostingAccs.length) {
        if (curDraft.groupSourceMode === 'categories') {
          throw Error('Chưa có tài khoản nào được chọn danh mục nhóm. Hãy tick chọn danh mục nhóm cho các nick muốn đăng bài.');
        } else {
          throw Error('Chưa có tài khoản hoặc Fanpage nào được chọn để chạy nhóm chung. Hãy tick chọn ít nhất 1 tài khoản ở danh sách bên dưới.');
        }
      }

      // Kiểm tra tính hợp lệ của bài viết được phân công cho từng tài khoản được chọn
      for (const a of activePostingAccs) {
        const pIdx = (curDraft.accountPostMap && curDraft.accountPostMap[a.id] !== undefined)
          ? Number(curDraft.accountPostMap[a.id])
          : 0;
        const p = (curDraft.posts && curDraft.posts[pIdx]) || { text: curDraft.text, picture: curDraft.picture, background: curDraft.background, postLinkMode: curDraft.postLinkMode };
        if (!p.text?.trim()) {
          switchPostTab(pIdx);
          $('text')?.focus();
          throw Error(`Tài khoản "${a.name}" được gán Bài ${pIdx + 1} nhưng bài này chưa có nội dung. Vui lòng nhập nội dung cho Bài ${pIdx + 1}!`);
        }
        if (p.postLinkMode && !/(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(p.text)) {
          switchPostTab(pIdx);
          $('text')?.focus();
          throw Error(`Tài khoản "${a.name}" được gán Bài ${pIdx + 1} đang bật chế độ "Đăng bài bằng link" nhưng nội dung chưa chứa đường link hợp lệ (https://...). Hãy dán link bài viết cần chia sẻ!`);
        }
        const postViolations = findBannedWords(p.text);
        if (postViolations.length > 0) {
          switchPostTab(pIdx);
          checkAndRenderBannedWords();
          const unique = [...new Set(postViolations.map(v => v.word))];
          msg(`⛔ Không thể đăng bài! Bài ${pIdx + 1} (gán cho "${a.name}") chứa từ cấm vi phạm Facebook: ${unique.join(', ')}. Hãy xóa các từ này trước khi đăng!`, 'err');
          $('text')?.focus();
          $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }

      const d = validate(curDraft);
      let at = Date.now();
      if (d.when) {
        const parsedWhen = new Date(d.when).getTime();
        if (Number.isFinite(parsedWhen) && parsedWhen > Date.now()) {
          at = parsedWhen;
        }
      }

      if (d.groupSourceMode === 'categories') {
        const emptyAccs = accounts.filter(a => !d.accountGroups?.[a.id]?.trim());
        if (emptyAccs.length === accounts.length) {
          throw Error('Chưa có tài khoản nào được chọn danh mục nhóm. Hãy tick chọn danh mục nhóm cho các nick hoặc chuyển sang tab "Dùng chung nhóm".');
        }
        if (emptyAccs.length > 0) {
          const names = emptyAccs.map(a => a.name).join(', ');
          if (!confirm(`Tài khoản [${names}] chưa được chọn danh mục nhóm nào và sẽ KHÔNG đăng bài.\nBạn có muốn tiếp tục chạy cho ${activePostingAccs.length} tài khoản đã chọn?`)) return;
        }
      } else {
        const hasShared = d.links?.trim();
        const allHaveGroups = activePostingAccs.every(a => a.groups?.trim() || hasShared);
        if (!allHaveGroups) throw Error('Một số tài khoản được chọn không có link nhóm.');
      }

      const modeLabel = d.mode === 'auto'
        ? 'Tiện ích sẽ bấm Đăng tự động.'
        : 'Chỉ điền bài để kiểm tra, không bấm Đăng.';

      const orderNames = {
        round_robin: 'XEN KẼ (Tự động đăng xuất nick cũ & đăng nhập nick mới luân phiên từng nhóm)',
        sequential: 'TUẦN TỰ (Đăng hết nhóm nick này rồi đăng xuất sang nick tiếp theo)',
        parallel: 'SONG SONG THÔNG MINH (Tự động luân chuyển phiên đăng nhập giữa các nick)',
      };
      const orderText = orderNames[d.accountOrder || 'round_robin'] || d.accountOrder;
      const splitText = d.groupSourceMode === 'categories'
        ? '\n• Nguồn nhóm: Phân công theo danh mục riêng từng nick'
        : (d.splitSharedGroups ? '\n• Nhóm dùng chung: Chia đều cho các tài khoản đã chọn (không đăng trùng)' : '\n• Nhóm dùng chung: Đăng cho các tài khoản đã chọn');

      const {campaigns: curCamps} = await chrome.storage.local.get('campaigns');
      const pausedAccs = activePostingAccs.filter(a => {
        const c = curCamps?.[a.id];
        return c && (c.state === 'paused' || (c.state === 'stopped' && c.index > 0)) && c.index < (c.jobs?.length || 0);
      });
      if (pausedAccs.length > 0) {
        if (confirm(`Bạn đang có ${pausedAccs.length} tài khoản đã chọn đang tạm dừng ở giữa chừng.\n\n• Bấm [OK] để TIẾP TỤC đăng từ điểm tạm dừng.\n• Bấm [Cancel] nếu muốn BẮT ĐẦU LẠI từ đầu nhóm 1.`)) {
          await sendDirect('RESUME_ALL', {accountIds: activePostingAccs.map(a => a.id)});
          msg('▶ Đã tiếp tục các tài khoản đã chọn từ điểm tạm dừng.');
          await render();
          scheduleNextRender();
          return;
        }
      }

      // Mở ngay tab Facebook trong cử chỉ click của người dùng để không bị Chrome chặn Popup
      const firstTargetUrl = getFirstTargetGroupUrl(curDraft, activePostingAccs);
      const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');

      // 1. Nếu đang trên Web Platform và đã kết nối với Tiện ích Extension Runner -> Chạy tự động 100%
      if (isWebPlatform && window.__ntdExtensionActive && window.chrome?.runtime?.sendToExtension) {
        const allStorage = {
          accounts: (await chrome.storage.local.get('accounts')).accounts || [],
          groupCategories: (await chrome.storage.local.get('groupCategories')).groupCategories || [],
          draft: curDraft,
          license: (await chrome.storage.local.get('license')).license || null
        };
        await window.chrome.runtime.sendToExtension({
          type: 'SYNC_DATA_TO_EXTENSION',
          data: allStorage
        });

        window.__ntdWebRunning = true;
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('ntd_web_running', 'true');
        if ($('stopAllBtn')) $('stopAllBtn').style.display = 'inline-flex';
        if ($('pauseAllBtn')) $('pauseAllBtn').style.display = 'inline-flex';

        const startRes = await window.chrome.runtime.sendToExtension({
          type: 'START_ALL',
          data: {...d, at, targetAccountIds: activePostingAccs.map(a => a.id)}
        });
        if (!startRes?.ok && startRes?.error) {
          window.__ntdWebRunning = false;
          if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('ntd_web_running');
          throw new Error(startRes.error);
        }
        msg(`🚀 [Extension Runner] Đã khởi động tự động điền bài & đăng bài vào Facebook cho ${activePostingAccs.length} tài khoản!`);
        await render();
        scheduleNextRender();
        return;
      }

      // 2. Nếu đang trên Web Platform nhưng CHƯA nạp Tiện ích Extension -> Hiển thị Modal hướng dẫn
      if (isWebPlatform && !window.__ntdExtensionActive) {
        if (typeof showExtensionRequiredModal === 'function') {
          showExtensionRequiredModal(async () => {
            if (navigator.clipboard && curDraft?.text) {
              try { await navigator.clipboard.writeText(curDraft.text); } catch (_) {}
            }
            postTab = window.open(firstTargetUrl, 'ntd_fb_posting_tab');
            await sendDirect('START_ALL', {data: {...d, at, targetAccountIds: activePostingAccs.map(a => a.id)}});
            msg(`📋 ĐÃ COPY BÀI VÀO CLIPBOARD! Hãy nhấn Ctrl + V vào ô "Bạn viết gì đi..." trên tab Facebook.`);
            await render();
            scheduleNextRender();
          });
          return;
        }
      }

      if (isWebPlatform) {
        try {
          if (navigator.clipboard && curDraft?.text) {
            navigator.clipboard.writeText(curDraft.text).catch(() => {});
          }
          postTab = window.open(firstTargetUrl, 'ntd_fb_posting_tab');
          if (window.setWebPostingTab) {
            window.setWebPostingTab(postTab);
          }
        } catch (_) {}
      }

      await sendDirect('START_ALL', {data: {...d, at, targetAccountIds: activePostingAccs.map(a => a.id)}});
      msg(`✅ Đã khởi động ${activePostingAccs.length} tài khoản (${orderText}).`);
      await render();
      scheduleNextRender();
    } catch (e) {
      if (postTab && !postTab.closed) {
        try { postTab.close(); } catch (_) {}
      }
      msg(e.message);
    }
  };
}

// ── Pause all ─────────────────────────────────────────────────────────────────
const pauseAllEl = $('pauseAllBtn');
if (pauseAllEl) {
  pauseAllEl.onclick = async () => {
    try {
      await sendDirect('PAUSE_ALL');
      msg('⏸ Đã tạm dừng tất cả tài khoản.');
      await render();
      scheduleNextRender();
    } catch (e) { msg(e.message); }
  };
}

// ── Resume all ────────────────────────────────────────────────────────────────
const resumeAllEl = $('resumeAllBtn');
if (resumeAllEl) {
  resumeAllEl.onclick = async () => {
    try {
      const curDraft = draft();
      const violations = findBannedWords(curDraft.text);
      if (violations.length > 0) {
        checkAndRenderBannedWords();
        const unique = [...new Set(violations.map(v => v.word))];
        msg(`⛔ Không thể tiếp tục! Nội dung chứa từ cấm vi phạm chính sách: ${unique.join(', ')}. Hãy xóa từ cấm trước!`, 'err');
        $('text')?.focus();
        $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      let targetIds = null;
      if (curDraft.groupSourceMode === 'categories') {
        targetIds = Object.keys(curDraft.accountGroups || {}).filter(id => !!curDraft.accountGroups[id]?.trim());
      }
      await sendDirect('RESUME_ALL', targetIds ? { accountIds: targetIds } : {});
      msg('▶ Đã tiếp tục các tài khoản từ điểm tạm dừng.');
      await render();
      scheduleNextRender();
    } catch (e) { msg(e.message); }
  };
}

$('bannerResumeBtn')?.addEventListener('click', async () => {
  try {
    const curDraft = draft();
    const violations = findBannedWords(curDraft.text);
    if (violations.length > 0) {
      checkAndRenderBannedWords();
      const unique = [...new Set(violations.map(v => v.word))];
      msg(`⛔ Không thể tiếp tục! Nội dung chứa từ cấm vi phạm chính sách: ${unique.join(', ')}. Hãy xóa từ cấm trước!`, 'err');
      $('text')?.focus();
      $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    let targetIds = null;
    if (curDraft.groupSourceMode === 'categories') {
      targetIds = Object.keys(curDraft.accountGroups || {}).filter(id => !!curDraft.accountGroups[id]?.trim());
    }
    await sendDirect('RESUME_ALL', targetIds ? { accountIds: targetIds } : {});
    msg('▶ Đã tiếp tục các tài khoản từ điểm tạm dừng.');
    await render();
    scheduleNextRender();
  } catch (e) { msg(e.message); }
});

// ── Stop all ──────────────────────────────────────────────────────────────────
const stopAllEl = $('stopAllBtn');
if (stopAllEl) {
  stopAllEl.onclick = async () => {
    if (!confirm('Dừng tất cả tài khoản đang chạy?')) return;
    try {
      window.__ntdWebRunning = false;
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('ntd_web_running');
      if ($('stopAllBtn')) $('stopAllBtn').style.display = 'none';
      if ($('pauseAllBtn')) $('pauseAllBtn').style.display = 'none';
      const inlineBtn = document.getElementById('inlineQuickStopBtn');
      if (inlineBtn) inlineBtn.remove();

      msg('🛑 Đang dừng tất cả tài khoản...');
      await sendDirect('STOP_ALL');
      await chrome.storage.local.remove('campaigns');
      await chrome.storage.local.remove('coordinator');
      msg('✅ Đã dừng tất cả tài khoản và làm mới trạng thái.');
      await render();
      scheduleNextRender();
    } catch (e) { msg(e.message); }
  };
}

// ── Show Posting Facebook Tab (Xem tab Facebook đang đăng) ────────────────────
$('showPostingTabBtn')?.addEventListener('click', () => {
  const win = window.getWebPostingTab ? window.getWebPostingTab() : null;
  if (win && !win.closed) {
    try {
      win.focus();
      return;
    } catch (_) {}
  }
  const curDraft = draft();
  const { accounts = [] } = cachedAccounts?.length ? { accounts: cachedAccounts } : {};
  const firstUrl = getFirstTargetGroupUrl(curDraft, accounts);
  const newWin = window.open(firstUrl, 'ntd_fb_posting_tab');
  if (window.setWebPostingTab) window.setWebPostingTab(newWin);
});

// ── Status Classification & Badges ──────────────────────────────────────────
const jobNames = {
  queued: 'Chờ',
  working: 'Đang xử lý',
  preview: 'Đã điền, chờ kiểm tra',
  submitted: 'Đã bấm Đăng',
  sent_unverified: 'Đã gửi — chưa xác minh',
  pending: 'Chờ duyệt',
  unknown: 'Chưa xác minh',
  blocked: 'Bị chặn / Cảnh báo spam',
  error: 'Lỗi',
  skipped: 'Đã bỏ qua',
};

function categorizeJob(status) {
  if (['submitted', 'sent_unverified', 'pending', 'preview'].includes(status)) {
    return 'success';
  }
  if (['queued', 'working'].includes(status)) {
    return 'waiting';
  }
  return 'error'; // 'error', 'blocked', 'unknown', 'skipped'
}

function getStatusBadge(status) {
  switch (status) {
    case 'submitted':
      return { label: 'Đã đăng', cls: 'badge-success', cat: 'success' };
    case 'sent_unverified':
      return { label: 'Đã đăng', cls: 'badge-success', cat: 'success' };
    case 'pending':
      return { label: 'Chờ duyệt', cls: 'badge-pending', cat: 'success' };
    case 'preview':
      return { label: 'Đã điền thử', cls: 'badge-preview', cat: 'success' };
    case 'working':
      return { label: 'Đang xử lý…', cls: 'badge-working', cat: 'waiting' };
    case 'queued':
      return { label: 'Đang chờ đăng', cls: 'badge-waiting', cat: 'waiting' };
    case 'blocked':
      return { label: 'Bị chặn spam', cls: 'badge-blocked', cat: 'error' };
    case 'skipped':
      return { label: 'Đã bỏ qua', cls: 'badge-skipped', cat: 'error' };
    case 'error':
      return { label: 'Không đăng được', cls: 'badge-error', cat: 'error' };
    default:
      return { label: 'Không đăng được', cls: 'badge-error', cat: 'error' };
  }
}

const stateLabel = {
  running: 'Đang chạy',
  waiting: 'Chờ đến lượt',
  paused: 'Tạm dừng',
  done: 'Hoàn tất',
  stopped: 'Đã dừng',
};

// ── Build Single Progress Card Element ────────────────────────────────────────
function buildProgCardElement(itemData, statsMap, todayStr, coordinator) {
  const { acc, c, total, isPausedMidway, isRunning, isWaiting, isDone, hasErrorJob, isStoppedWithError } = itemData;
  const isRunningOrWaiting = isRunning || isWaiting;

  const configuredUrls = getAccountConfiguredGroupUrls(acc);
  const done = c?.jobs?.filter(j => !['queued', 'working'].includes(j.status)).length || 0;
  const percent = (c && total > 0) ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const groupCount = acc.groups?.trim().split('\n').filter(Boolean).length;

  const todayRecord = statsMap[acc.id];
  const todayPosted = (todayRecord && todayRecord.date === todayStr) ? (Number(todayRecord.count) || 0) : 0;
  const isFanpage = acc.type === 'fanpage';
  const dailyLimitNum = isFanpage ? 5 : ($('dailyLimit')?.value ? Number($('dailyLimit').value) : 20);
  const isDailyLimitActive = isFanpage || ($('enableDailyLimit')?.checked !== false);
  const isHitDailyLimit = isDailyLimitActive && todayPosted >= dailyLimitNum;

  // Determine state pill & styles
  let pillBadgeHtml = '';
  let borderClass = '';
  let barFillClass = '';

  const hasRemainingTime = c?.state === 'running' && c?.nextAt && c.nextAt > Date.now();
  const remainingSec = hasRemainingTime ? Math.max(0, Math.ceil((c.nextAt - Date.now()) / 1000)) : 0;
  const formatCountdown = sec => {
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}p ${s < 10 ? '0' : ''}${s}s`;
    }
    return `${sec}s`;
  };

  if (c) {
    if (c.active) {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-running" style="animation:pulse 1.2s infinite">Đang mở tab Facebook…</span>`;
      borderClass = 'running';
      barFillClass = '';
    } else if (isRunning) {
      if (hasRemainingTime) {
        pillBadgeHtml = `<span class="prog-pill-badge prog-pill-waiting prog-pill-countdown" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:700">Đếm ngược ${formatCountdown(remainingSec)}</span>`;
      } else {
        pillBadgeHtml = `<span class="prog-pill-badge prog-pill-running">Đang đăng</span>`;
      }
      borderClass = 'running';
      barFillClass = '';
    } else if (isWaiting) {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-waiting">Chờ lượt</span>`;
      borderClass = 'waiting';
      barFillClass = '';
    } else if (isPausedMidway) {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-paused">Tạm dừng (${c.index + 1}/${total})</span>`;
      borderClass = 'paused';
      barFillClass = 'paused';
    } else if (isDone) {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-done">Hoàn tất (${done}/${total})</span>`;
      borderClass = 'done';
      barFillClass = 'done';
    } else if (hasErrorJob || isStoppedWithError) {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-error">Có lỗi / Đã dừng</span>`;
      borderClass = 'error';
      barFillClass = 'error';
    } else {
      pillBadgeHtml = `<span class="prog-pill-badge prog-pill-none">${stateLabel[c.state] || c.state}</span>`;
    }
  } else {
    pillBadgeHtml = `<span class="prog-pill-badge prog-pill-none">Chưa chạy</span>`;
  }

  if (isHitDailyLimit) {
    pillBadgeHtml += ` <span class="prog-pill-badge prog-pill-error" title="Tài khoản đã đạt giới hạn bài đăng hôm nay">Hết hạn mức ngày</span>`;
  }

  let breakInfo = '';
  const countdownBadge = hasRemainingTime
    ? `<span class="prog-countdown-badge" style="display:inline-flex;align-items:center;gap:4px;color:#2563eb;background:#eff6ff;border:1px solid #bfdbfe;font-weight:700;font-size:11px;padding:2px 8px;border-radius:12px">Đếm ngược: <b>${formatCountdown(remainingSec)}</b></span>`
    : '';

  if (c?.breakNote) {
    const countdownSuffix = hasRemainingTime ? ` <b class="prog-countdown-suffix" style="color:#2563eb;background:#eff6ff;border:1px solid #bfdbfe;padding:1px 6px;border-radius:10px;margin-left:4px">còn ${formatCountdown(remainingSec)}</b>` : '';
    breakInfo = ` &nbsp;·&nbsp; <span style="color:#d97706;font-weight:600">${c.breakNote}${countdownSuffix}</span>`;
  } else if (hasRemainingTime) {
    breakInfo = ` &nbsp;·&nbsp; ${countdownBadge}`;
  } else if (c?.state === 'waiting') {
    if (coordinator?.mode === 'round_robin') {
      breakInfo = ` &nbsp;·&nbsp; <span style="color:#2563eb;font-weight:600">Chờ xen kẽ</span>`;
    } else if (coordinator?.mode === 'sequential') {
      breakInfo = ` &nbsp;·&nbsp; <span style="color:#2563eb;font-weight:600">Chờ tuần tự</span>`;
    }
  }

  let groupSourceLabel = '';
  if (groupSourceMode === 'categories') {
    const selCatIds = accountCategoryMap[acc.id] || [];
    const selCats = loadedCategories.filter(cat => selCatIds.includes(cat.id));
    const selCatNames = selCats.map(cat => cat.name);
    if (selCatNames.length > 0) {
      groupSourceLabel = `<span style="color:#ed6b22;font-weight:600">${selCatNames.join(', ')}</span>`;
    } else {
      groupSourceLabel = `<span style="color:#94a3b8">Chưa chọn danh mục</span>`;
    }
  } else {
    groupSourceLabel = groupCount ? `${groupCount} nhóm riêng` : '<span style="color:#16a34a;font-weight:600">Dùng chung nhóm</span>';
  }

  const isJobExpanded = expandedJobAccs.has(acc.id);
  const card = document.createElement('div');
  card.className = `prog-acc-item ${borderClass}`;
  card.id = `progCard_${acc.id}`;

  card.innerHTML = `
    <div class="prog-acc-main">
      <div class="prog-acc-header">
        <div class="prog-acc-title">
          <span class="prog-acc-name">${acc.name}</span>
          ${isFanpage ? `<span class="prog-post-badge" style="background:#fee2e2;color:#dc2626;border:1px solid #fecaca;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:6px">Fanpage</span>` : ''}
          <span class="prog-post-badge" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:6px">
            ${c?.postTitle || `Bài ${(accountPostMap[acc.id] ?? 0) + 1}`}
          </span>
          <span class="prog-daily-tag ${isHitDailyLimit ? 'limit-hit' : ''}">
            Hôm nay: <b>${todayPosted}/${dailyLimitNum}</b> bài ${isFanpage ? '(Max 5/ngày)' : ''}
          </span>
          ${breakInfo}
        </div>
        <div>
          ${pillBadgeHtml}
        </div>
      </div>

      <!-- Dedicated Progress Bar -->
      <div class="prog-bar-container">
        <div class="prog-bar-track">
          <div class="prog-bar-fill ${barFillClass}" style="width: ${c ? percent : 0}%"></div>
        </div>
        <div class="prog-bar-meta">
          <span>${groupSourceLabel} &nbsp;·&nbsp; ${c ? `Tiến độ: <b>${done}/${total}</b> nhóm (${percent}%)` : `Sẵn sàng: <b>${total}</b> nhóm để đăng`}</span>
          <span>${c?.active ? '<b style="color:#ed6b22">Đang mở tab & điền bài…</b>' : (hasRemainingTime ? `<b style="color:#2563eb">Đang đếm ngược bài tiếp theo: còn ${formatCountdown(remainingSec)}</b>` : '')}</span>
        </div>
      </div>
    </div>

    <!-- Actions Row -->
    <div class="prog-actions-row">
      <div class="prog-btn-group">
        ${isPausedMidway ? `<button type="button" class="prog-action-btn primary btn-resume-one" data-id="${acc.id}">Tiếp tục (${c.index + 1}/${total})</button>` : ''}
        ${isRunningOrWaiting ? `<button type="button" class="prog-action-btn btn-pause-one" data-id="${acc.id}" style="background:#fef3c7;color:#b45309;border-color:#f59e0b">Tạm dừng</button>` : ''}
        ${isPausedMidway || isRunningOrWaiting ? `<button type="button" class="prog-action-btn btn-next" data-id="${acc.id}" title="Bỏ qua nhóm hiện tại và chuyển sang nhóm tiếp theo">Bỏ qua</button>` : ''}
        ${isPausedMidway ? `<button type="button" class="prog-action-btn btn-start-one" data-id="${acc.id}" style="color:#64748b" title="Bắt đầu lại từ nhóm 1">Chạy lại từ đầu</button>` : ''}
        ${!isRunningOrWaiting && !isPausedMidway ? `<button type="button" class="prog-action-btn primary btn-start-one" data-id="${acc.id}">Chạy riêng</button>` : ''}
        ${todayPosted > 0 && acc.type !== 'fanpage' ? `<button type="button" class="prog-action-btn btn-reset-daily-one" data-id="${acc.id}" data-name="${acc.name.replace(/"/g, '&quot;')}" style="color:#b45309;border-color:#f59e0b;background:#fffbeb" title="Đặt lại số bài đã đăng hôm nay về 0 nếu muốn đăng thêm">Đặt lại (${todayPosted})</button>` : ''}
        ${isRunningOrWaiting || isPausedMidway ? `<button type="button" class="prog-action-btn danger btn-stop-one" data-id="${acc.id}">Dừng hẳn</button>` : ''}
      </div>

      <div>
        ${(c?.jobs?.length || configuredUrls.length) ? `
          <button type="button" class="prog-toggle-details-btn" data-id="${acc.id}">
            <span>${isJobExpanded ? 'Thu gọn ▲' : (c ? 'Chi tiết (' + c.jobs.length + ' nhóm) ▼' : 'Xem link để đăng (' + total + ' nhóm) ▼')}</span>
          </button>
        ` : ''}
      </div>
    </div>

    ${(c?.jobs?.length || configuredUrls.length) ? `
      <div class="prog-job-drawer" id="progJobDrawer_${acc.id}" style="display:${isJobExpanded ? 'block' : 'none'}">
        <ol>
          ${(c ? c.jobs : configuredUrls.map(url => ({ url, status: 'queued', note: 'Sẵn sàng trong hàng đợi đăng' }))).map(j => {
            const badge = getStatusBadge(j.status);
            const shortUrl = j.url.replace('https://www.facebook.com/groups/','').replace(/\/$/,'');
            const isDonePost = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(j.status);
            const effPostUrl = j.postUrl || (isDonePost && j.url ? `${j.url.replace(/\/+$/, '')}/your_posts/` : '');
            const postLinkHtml = effPostUrl ? ` <a href="${effPostUrl}" target="_blank" rel="noreferrer" style="margin-left:6px;font-size:11px;color:#2563eb;text-decoration:none;font-weight:600;background:#eff6ff;padding:1px 6px;border-radius:4px;border:1px solid #bfdbfe;" title="${effPostUrl}">🔗 Xem bài viết ↗</a>` : '';
            return `<li><span class="status-badge ${badge.cls}" style="margin-right:6px;font-size:10px;padding:1px 6px">${badge.label}</span><a href="${j.url}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:none"><b>${shortUrl}</b> <span style="font-size:10px;opacity:0.6">↗</span></a>${postLinkHtml}${j.note ? ' · <span style="color:#64748b">' + j.note + '</span>' : ''}</li>`;
          }).join('')}
        </ol>
      </div>
    ` : ''}
  `;

  // Toggle job drawer handler
  const toggleBtn = card.querySelector('.prog-toggle-details-btn');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      if (expandedJobAccs.has(acc.id)) {
        expandedJobAccs.delete(acc.id);
      } else {
        expandedJobAccs.add(acc.id);
      }
      render();
    };
  }

  return card;
}

// ── Render multi-account status (Dashboard Edition) ───────────────────────────
async function render() {
  const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');

  let extCampaigns = null;
  // Nếu đang trên Web Platform và có extension bridge/runner:
  // Kéo trạng thái chiến dịch thời gian thực từ Extension về để hiển thị và điều khiển trực tiếp trên Web
  if (isWebPlatform && window.chrome?.runtime?.sendToExtension) {
    try {
      const extState = await window.chrome.runtime.sendToExtension({ type: 'GET_STATE' });
      if (extState && extState.ok) {
        window.__ntdExtensionActive = true;
        if (extState.campaigns && Object.keys(extState.campaigns).length > 0) {
          extCampaigns = extState.campaigns;
          await chrome.storage.local.set({
            campaigns: extState.campaigns,
            coordinator: extState.coordinator || null,
            dailyPostStats: extState.dailyPostStats || {}
          });
        } else {
          await chrome.storage.local.remove(['campaigns', 'coordinator']);
          if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('ntd_web_running');
          window.__ntdWebRunning = false;
        }
      }
    } catch (_) {}
  }

  const {accounts, campaigns, coordinator, dailyPostStats} = await chrome.storage.local.get(['accounts', 'campaigns', 'coordinator', 'dailyPostStats']);
  const accs = accounts || [];
  const cMap = extCampaigns || campaigns || {};
  const statsMap = dailyPostStats || {};
  const todayStr = getTodayDateStr();

  // Tách riêng tài khoản cá nhân và trang Fanpage
  const personalAccs = accs.filter(a => a.type !== 'fanpage');
  const fanpageAccs = accs.filter(a => a.type === 'fanpage');

  // Cập nhật số đếm trên các tab quản lý Section 4
  if ($('badgeProgPersonal')) $('badgeProgPersonal').textContent = personalAccs.length;
  if ($('badgeProgFanpage')) $('badgeProgFanpage').textContent = fanpageAccs.length;
  if ($('badgeProgAll')) $('badgeProgAll').textContent = accs.length;

  // Xác định danh sách tài khoản thuộc phạm vi hiển thị Section 4
  let targetAccs = accs;
  if (progAccountType === 'personal') {
    targetAccs = personalAccs;
    if ($('accCount')) $('accCount').textContent = `${personalAccs.length} nick cá nhân`;
  } else if (progAccountType === 'fanpage') {
    targetAccs = fanpageAccs;
    if ($('accCount')) $('accCount').textContent = `${fanpageAccs.length} trang Fanpage`;
  } else {
    targetAccs = accs;
    if ($('accCount')) $('accCount').textContent = `${accs.length} tài khoản & Fanpage`;
  }

  if ($('noAccountsNotice')) $('noAccountsNotice').style.display = accs.length ? 'none' : '';
  if ($('newVersionBanner')) $('newVersionBanner').style.display = accs.length ? 'none' : 'flex';

  const anyRunning = Object.values(cMap).some(c => c?.state === 'running' || c?.state === 'waiting');
  const pausedCampaigns = Object.values(cMap).filter(c => (c?.state === 'paused' || (c?.state === 'stopped' && c.index > 0)) && c.index < (c.jobs?.length || 0));
  const anyPaused = pausedCampaigns.length > 0;
  const isWebRunning = Boolean(window.__ntdWebRunning || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('ntd_web_running') === 'true'));
  const shouldShowStop = anyRunning || anyPaused || isWebRunning;

  if ($('pauseAllBtn')) $('pauseAllBtn').style.display = (anyRunning || isWebRunning) ? 'inline-flex' : 'none';
  if ($('resumeAllBtn')) $('resumeAllBtn').style.display = (anyPaused && !anyRunning) ? 'inline-flex' : 'none';
  if ($('stopAllBtn')) $('stopAllBtn').style.display = shouldShowStop ? 'inline-flex' : 'none';
  if ($('showPostingTabBtn')) $('showPostingTabBtn').style.display = (anyRunning || anyPaused) ? 'inline-flex' : 'none';

  const resumeBanner = $('resumeNoticeBanner');
  if (resumeBanner) {
    if (anyPaused && !anyRunning) {
      resumeBanner.style.display = 'flex';
      const resumeText = $('resumeNoticeText');
      if (resumeText) {
        const totalRemaining = pausedCampaigns.reduce((sum, c) => sum + Math.max(0, (c.jobs?.length || 0) - c.index), 0);
        resumeText.innerHTML = `Có <b>${pausedCampaigns.length}</b> tài khoản đang dừng dở dang (còn <b>${totalRemaining}</b> nhóm chưa đăng). Đã lưu vị trí nhóm chính xác. Bấm nút bên cạnh để <b>tiếp tục chạy tiếp ngay</b> từ đúng nhóm đang dừng mà không phải bắt đầu lại từ đầu!`;
      }
    } else {
      resumeBanner.style.display = 'none';
    }
  }

  // Update Master KPI metrics at top
  updateMasterKpiMetrics(accs, cMap);

  // Status analysis for counters & filtering based on targetAccs
  let countRunning = 0;
  let countDone = 0;
  let countError = 0;
  let countPaused = 0;
  const errorAccountIds = [];

  const accountStatusData = targetAccs.map(acc => {
    const c = cMap[acc.id];
    const configuredUrls = getAccountConfiguredGroupUrls(acc);
    const total = c?.jobs?.length || configuredUrls.length;
    const isPausedMidway = (c?.state === 'paused' || (c?.state === 'stopped' && c.index > 0)) && c.index < total;
    const isRunning = c?.state === 'running';
    const isWaiting = c?.state === 'waiting';
    const isDone = c?.state === 'done' || (total > 0 && c?.index >= total);
    const hasErrorJob = (c?.jobs || []).some(j => j.status === 'error' || j.status === 'blocked');
    const isStoppedWithError = (c?.state === 'stopped' || c?.state === 'error') && !isPausedMidway && total > 0;

    if (isRunning || isWaiting) countRunning++;
    else if (isPausedMidway) countPaused++;
    else if (isDone) countDone++;

    if (hasErrorJob || isStoppedWithError) {
      countError++;
      errorAccountIds.push(acc.id);
    }

    return {
      acc,
      c,
      total,
      isPausedMidway,
      isRunning,
      isWaiting,
      isDone,
      hasErrorJob,
      isStoppedWithError
    };
  });

  // Update Section 4 Filter Pill Counters
  if ($('progCountAll')) $('progCountAll').textContent = targetAccs.length;
  if ($('progCountRunning')) $('progCountRunning').textContent = countRunning;
  if ($('progCountDone')) $('progCountDone').textContent = countDone;
  if ($('progCountError')) $('progCountError').textContent = countError;
  if ($('progCountPaused')) $('progCountPaused').textContent = countPaused;

  // Retry errors button in master control bar
  const retryBtn = $('retryErrorsBtn');
  if (retryBtn) {
    if (errorAccountIds.length > 0 && !anyRunning) {
      retryBtn.style.display = 'inline-flex';
      retryBtn.innerHTML = `🔄 Thử lại các nick lỗi (<b>${errorAccountIds.length}</b>)`;
    } else {
      retryBtn.style.display = 'none';
    }
  }

  const list = $('accStatusList');
  list.replaceChildren();

  const accountsUrl = chrome.runtime.getURL('accounts.html');

  // Hiển thị thông báo nếu phạm vi hiện tại chưa có tài khoản nào
  if (!targetAccs.length) {
    if (progAccountType === 'personal') {
      list.innerHTML = `
        <div style="grid-column:1/-1;background:#f8fafc;border:1.5px dashed #cbd5e1;border-radius:12px;padding:26px 16px;text-align:center;font-size:12.5px;color:#64748b;margin-top:8px">
          <b style="color:#334155;font-size:13.5px">Chưa có tài khoản Facebook cá nhân nào</b><br>
          <span style="font-size:12px">Bạn đang xem mục quản lý tài khoản cá nhân. Hãy thêm tài khoản để theo dõi tiến độ đăng bài.</span><br>
          <div style="margin-top:12px">
            <a href="${accountsUrl}" class="manage-btn" style="text-decoration:none;font-weight:700;display:inline-block">Quản lý &amp; Thêm tài khoản cá nhân →</a>
          </div>
        </div>`;
    } else if (progAccountType === 'fanpage') {
      list.innerHTML = `
        <div style="grid-column:1/-1;background:#fff7ed;border:1.5px dashed #fdba74;border-radius:12px;padding:26px 16px;text-align:center;font-size:12.5px;color:#9a3412;margin-top:8px">
          <b style="color:#c2410c;font-size:13.5px">Chưa có trang Fanpage nào</b><br>
          <span style="font-size:12px;color:#b45309">Bạn đang xem mục quản lý Trang Fanpage. Hãy thêm các Fanpage bạn quản lý để bắt đầu đăng tự động.</span><br>
          <div style="margin-top:12px">
            <a href="fanpages.html" class="manage-btn" style="background:#dc2626;color:#fff;border:none;text-decoration:none;font-weight:700;display:inline-block">Quản lý &amp; Thêm trang Fanpage ngay →</a>
          </div>
        </div>`;
    } else {
      list.innerHTML = `
        <div style="grid-column:1/-1;background:#f8fafc;border:1.5px dashed #cbd5e1;border-radius:12px;padding:26px 16px;text-align:center;font-size:12.5px;color:#64748b;margin-top:8px">
          <b>Chưa có tài khoản Facebook hoặc trang Fanpage nào.</b>
        </div>`;
    }
    renderReport(cMap, accs);
    return;
  }

  // Filter list by progFilter
  const displayedAccs = accountStatusData.filter(item => {
    if (progFilter === 'running') return item.isRunning || item.isWaiting;
    if (progFilter === 'done') return item.isDone;
    if (progFilter === 'error') return item.hasErrorJob || item.isStoppedWithError;
    if (progFilter === 'paused') return item.isPausedMidway;
    return true; // 'all'
  });

  if (!displayedAccs.length) {
    const scopeName = progAccountType === 'fanpage' ? 'trang Fanpage' : (progAccountType === 'personal' ? 'tài khoản cá nhân' : 'tài khoản');
    list.innerHTML = `
      <div style="grid-column:1/-1;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:24px;text-align:center;font-size:12.5px;color:#64748b;margin-top:8px">
        Không có ${scopeName} nào thuộc trạng thái này.
      </div>`;
    renderReport(cMap, accs);
    return;
  }

  // Render cards: nếu chọn Tất cả và có cả 2 loại thì hiển thị tiêu đề phân nhóm rõ ràng
  const frag = document.createDocumentFragment();
  if (progAccountType === 'all') {
    const dispPersonal = displayedAccs.filter(i => i.acc.type !== 'fanpage');
    const dispFanpage = displayedAccs.filter(i => i.acc.type === 'fanpage');

    if (dispPersonal.length > 0 && dispFanpage.length > 0) {
      // Group header 1: Cá nhân
      const hPersonal = document.createElement('div');
      hPersonal.style.cssText = 'grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 12px;font-weight:700;color:#1d4ed8;font-size:12.5px;margin-top:4px';
      hPersonal.innerHTML = `<span>1. Tiến độ Tài khoản cá nhân (${dispPersonal.length})</span><a href="${accountsUrl}" style="font-size:11.5px;color:#2563eb;text-decoration:none;font-weight:600">Quản lý nick →</a>`;
      frag.appendChild(hPersonal);

      for (const itemData of dispPersonal) {
        frag.appendChild(buildProgCardElement(itemData, statsMap, todayStr, coordinator));
      }

      // Group header 2: Fanpage
      const hFanpage = document.createElement('div');
      hFanpage.style.cssText = 'grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-weight:700;color:#dc2626;font-size:12.5px;margin-top:12px';
      hFanpage.innerHTML = `<span>2. Tiến độ Trang Fanpage (${dispFanpage.length})</span><a href="fanpages.html" style="font-size:11.5px;color:#dc2626;text-decoration:none;font-weight:600">Quản lý Fanpage →</a>`;
      frag.appendChild(hFanpage);

      for (const itemData of dispFanpage) {
        frag.appendChild(buildProgCardElement(itemData, statsMap, todayStr, coordinator));
      }
    } else {
      for (const itemData of displayedAccs) {
        frag.appendChild(buildProgCardElement(itemData, statsMap, todayStr, coordinator));
      }
    }
  } else {
    for (const itemData of displayedAccs) {
      frag.appendChild(buildProgCardElement(itemData, statsMap, todayStr, coordinator));
    }
  }
  list.appendChild(frag);

  // Per-account button handlers
  list.querySelectorAll('.btn-pause-one').forEach(btn => {
    btn.onclick = async () => {
      try {
        await sendDirect('PAUSE_ONE', {accountId: btn.dataset.id});
        msg('⏸ Đã tạm dừng tài khoản.');
        await render();
        scheduleNextRender();
      } catch (e) { msg(e.message); }
    };
  });

  list.querySelectorAll('.btn-resume-one').forEach(btn => {
    btn.onclick = async () => {
      try {
        const curDraft = draft();
        const violations = findBannedWords(curDraft.text);
        if (violations.length > 0) {
          checkAndRenderBannedWords();
          const unique = [...new Set(violations.map(v => v.word))];
          msg(`⛔ Không thể tiếp tục! Nội dung chứa từ cấm: ${unique.join(', ')}. Hãy xóa từ cấm trước!`, 'err');
          $('text')?.focus();
          $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        await sendDirect('RESUME_ONE', {accountId: btn.dataset.id});
        msg('▶ Đang tiếp tục đăng bài từ điểm tạm dừng...');
        await render();
        scheduleNextRender();
      } catch (e) { msg(e.message); }
    };
  });

  list.querySelectorAll('.btn-start-one').forEach(btn => {
    btn.onclick = async () => {
      let postTab = null;
      try {
        licenseInfo = await checkLicense();
        if (!licenseInfo) {
          alert('⚠️ Tiện ích chưa được kích hoạt bản quyền.\n\nVui lòng kích hoạt key bản quyền hoặc bấm "⚡ Cập nhật dữ liệu cũ / Đồng bộ" để lấy lại bản quyền và tài khoản từ bản cũ!');
          window.location.href = chrome.runtime.getURL('activate.html');
          return;
        }
        const accountId = btn.dataset.id;
        const {accounts, campaigns} = await chrome.storage.local.get(['accounts', 'campaigns']);
        const acc = accounts?.find(a => a.id === accountId);
        const curCamp = campaigns?.[accountId];

        // Nếu tài khoản đang tạm dừng dở dang, hỏi xác nhận để không bị mất tiến độ
        if (curCamp && (curCamp.state === 'paused' || (curCamp.state === 'stopped' && curCamp.index > 0)) && curCamp.index < (curCamp.jobs?.length || 0)) {
          if (confirm(`Tài khoản "${acc?.name}" đang dừng ở nhóm ${curCamp.index + 1}/${curCamp.jobs.length}.\n\n• Bấm [OK] để TIẾP TỤC đăng từ nhóm này.\n• Bấm [Cancel] nếu muốn BẮT ĐẦU LẠI từ nhóm 1.`)) {
            await sendDirect('RESUME_ONE', {accountId});
            msg(`▶ Đã tiếp tục tài khoản ${acc?.name} từ điểm tạm dừng.`);
            await render();
            scheduleNextRender();
            return;
          }
        }

        const curDraft = draft();
        const pIdx = (curDraft.accountPostMap && curDraft.accountPostMap[accountId] !== undefined)
          ? Number(curDraft.accountPostMap[accountId])
          : 0;
        const p = (curDraft.posts && curDraft.posts[pIdx]) || { text: curDraft.text, picture: curDraft.picture, background: curDraft.background, postLinkMode: curDraft.postLinkMode };
        if (!p.text?.trim()) {
          switchPostTab(pIdx);
          $('text')?.focus();
          throw Error(`Tài khoản "${acc?.name}" được gán Bài ${pIdx + 1} nhưng bài này chưa có nội dung. Vui lòng nhập nội dung cho Bài ${pIdx + 1}!`);
        }
        if (p.postLinkMode && !/(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(p.text)) {
          switchPostTab(pIdx);
          $('text')?.focus();
          throw Error(`Tài khoản "${acc?.name}" được gán Bài ${pIdx + 1} đang bật chế độ "Đăng bài bằng link" nhưng nội dung chưa chứa đường link hợp lệ (https://...). Hãy dán link bài viết cần chia sẻ!`);
        }
        const violations = findBannedWords(p.text);
        if (violations.length > 0) {
          switchPostTab(pIdx);
          checkAndRenderBannedWords();
          const unique = [...new Set(violations.map(v => v.word))];
          msg(`⛔ Không thể đăng bài! Bài ${pIdx + 1} chứa ${unique.length} từ cấm: ${unique.join(', ')}. Hãy xóa các từ này trước khi đăng!`, 'err');
          $('text')?.focus();
          $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }

        let hasGroups = false;
        if (curDraft.groupSourceMode === 'categories') {
          hasGroups = !!(curDraft.accountGroups && curDraft.accountGroups[accountId]?.trim());
        } else {
          if (acc?.groups?.trim()) hasGroups = true;
          else if (curDraft.links?.trim()) hasGroups = true;
        }

        if (!hasGroups) {
          throw Error(curDraft.groupSourceMode === 'categories'
            ? `Tài khoản "${acc?.name || accountId}" chưa được chọn danh mục nhóm nào.`
            : `Tài khoản "${acc?.name || accountId}" không có nhóm để đăng.`);
        }

        const d = validate({...curDraft, allowEmptyLinks: true});
        if (d.enableDailyLimit !== false) {
          const {dailyPostStats = {}} = await chrome.storage.local.get('dailyPostStats');
          const todayCount = (dailyPostStats[accountId]?.date === getTodayDateStr()) ? (Number(dailyPostStats[accountId]?.count) || 0) : 0;
          const limit = d.dailyLimit || 20;
          if (todayCount >= limit) {
            throw Error(`Tài khoản "${acc?.name}" đã đạt giới hạn ${limit} bài group hôm nay (${todayCount}/${limit}).\n\nNếu muốn tiếp tục đăng bài, bạn có thể bấm nút "🔄 Đặt lại hôm nay" của nick này trước.`);
          }
        }
        let at = Date.now();
        if (d.when) {
          const parsedWhen = new Date(d.when).getTime();
          if (Number.isFinite(parsedWhen) && parsedWhen > Date.now()) {
            at = parsedWhen;
          }
        }

        // Mở ngay tab Facebook trong cử chỉ click của người dùng
        const firstTargetUrl = getFirstTargetGroupUrl(curDraft, [acc]);
        const isWebPlatform = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');

        // 1. Chạy qua Extension Runner nếu đã kết nối
        if (isWebPlatform && window.__ntdExtensionActive && window.chrome?.runtime?.sendToExtension) {
          const allStorage = {
            accounts: (await chrome.storage.local.get('accounts')).accounts || [],
            groupCategories: (await chrome.storage.local.get('groupCategories')).groupCategories || [],
            draft: curDraft,
            license: (await chrome.storage.local.get('license')).license || null
          };
          await window.chrome.runtime.sendToExtension({
            type: 'SYNC_DATA_TO_EXTENSION',
            data: allStorage
          });
          window.__ntdWebRunning = true;
          if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('ntd_web_running', 'true');
          if ($('stopAllBtn')) $('stopAllBtn').style.display = 'inline-flex';

          const startRes = await window.chrome.runtime.sendToExtension({
            type: 'START_ONE',
            accountId,
            data: {...d, at}
          });
          if (!startRes?.ok && startRes?.error) {
            window.__ntdWebRunning = false;
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('ntd_web_running');
            throw new Error(startRes.error);
          }
          msg(`🚀 [Extension Runner] Đã kích hoạt tự động điền & đăng bài cho ${acc?.name}!`);
          await render();
          scheduleNextRender();
          return;
        }

        // 2. Nếu chưa nạp Tiện ích Extension -> Hiển thị Modal hướng dẫn
        if (isWebPlatform && !window.__ntdExtensionActive) {
          if (typeof showExtensionRequiredModal === 'function') {
            showExtensionRequiredModal(async () => {
              if (navigator.clipboard && p?.text) {
                try { await navigator.clipboard.writeText(p.text); } catch (_) {}
              }
              postTab = window.open(firstTargetUrl, 'ntd_fb_posting_tab');
              await sendDirect('START_ONE', {accountId, data: {...d, at}});
              msg(`📋 ĐÃ COPY BÀI VIẾT CỦA ${acc?.name?.toUpperCase() || ''} VÀO CLIPBOARD! Nhấn Ctrl + V vào ô "Bạn viết gì đi..." trên tab Facebook.`);
              await render();
              scheduleNextRender();
            });
            return;
          }
        }

        if (isWebPlatform) {
          try {
            if (navigator.clipboard && p?.text) {
              navigator.clipboard.writeText(p.text).catch(() => {});
            }
            postTab = window.open(firstTargetUrl, 'ntd_fb_posting_tab');
            if (window.setWebPostingTab) {
              window.setWebPostingTab(postTab);
            }
          } catch (_) {}
        }

        await sendDirect('START_ONE', {accountId, data: {...d, at}});
        msg(`▶ Đã chạy ${acc?.name}`);
        await render();
        scheduleNextRender();
      } catch (e) {
        if (postTab && !postTab.closed) {
          try { postTab.close(); } catch (_) {}
        }
        msg(e.message);
      }
    };
  });

  list.querySelectorAll('.btn-reset-daily-one').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`Đặt lại số bài group đã đăng hôm nay của tài khoản "${name}" về 0?`)) return;
      try {
        await sendDirect('RESET_DAILY_COUNT', {accountId: id});
        msg(`✅ Đã đặt lại số bài hôm nay của "${name}" về 0.`);
        await render();
        scheduleNextRender();
      } catch (e) { msg(e.message); }
    };
  });

  list.querySelectorAll('.btn-stop-one').forEach(btn => {
    btn.onclick = async () => {
      try {
        await sendDirect('STOP_ONE', {accountId: btn.dataset.id});
        msg('Đã dừng tài khoản.');
        await render();
        scheduleNextRender();
      } catch (e) { msg(e.message); }
    };
  });

  list.querySelectorAll('.btn-next').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Bỏ qua nhóm hiện tại và chạy nhóm tiếp theo?')) return;
      try {
        await sendDirect('NEXT', {accountId: btn.dataset.id});
        msg('Đã bỏ qua nhóm hiện tại. Đang chuyển ngay sang nhóm tiếp theo...');
        await render();
        scheduleNextRender();
      } catch (e) { msg(e.message); }
    };
  });

  // Cập nhật Báo cáo chi tiết theo thời gian thực
  renderReport(cMap, accs);

  // Đảm bảo trạng thái khóa/mở nút đăng bài được đồng bộ sang các nút chạy riêng vừa render
  checkAndRenderBannedWords();
}

// ── Section 4 Dashboard Controls & Event Handlers ─────────────────────────────

$('toggleAllJobDetailsBtn')?.addEventListener('click', async () => {
  const { accounts } = await chrome.storage.local.get('accounts');
  const accs = accounts || [];
  allJobDetailsExpanded = !allJobDetailsExpanded;

  if (allJobDetailsExpanded) {
    accs.forEach(a => expandedJobAccs.add(a.id));
    $('toggleAllJobDetailsBtn').innerHTML = '<span>Thu gọn tất cả</span>';
  } else {
    expandedJobAccs.clear();
    $('toggleAllJobDetailsBtn').innerHTML = '<span>Mở rộng chi tiết tất cả</span>';
  }
  render();
});

$('retryErrorsBtn')?.addEventListener('click', async () => {
  try {
    const curDraft = draft();
    const violations = findBannedWords(curDraft.text);
    if (violations.length > 0) {
      checkAndRenderBannedWords();
      const unique = [...new Set(violations.map(v => v.word))];
      msg(`⛔ Không thể thử lại! Nội dung bài viết chứa từ cấm vi phạm chính sách: ${unique.join(', ')}. Hãy xóa từ cấm trước!`, 'err');
      $('text')?.focus();
      $('bannedWordsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const { campaigns, accounts } = await chrome.storage.local.get(['campaigns', 'accounts']);
    const cMap = campaigns || {};
    const accMap = new Map((accounts || []).map(a => [a.id, a]));
    const errorAccs = [];

    for (const [accId, c] of Object.entries(cMap)) {
      const hasError = (c.jobs || []).some(j => j.status === 'error' || j.status === 'blocked');
      const isStoppedMidway = (c.state === 'stopped' || c.state === 'paused') && c.index < (c.jobs?.length || 0);
      if (hasError || isStoppedMidway || c.state === 'error') {
        errorAccs.push({ accId, accName: accMap.get(accId)?.name || accId, camp: c });
      }
    }

    if (!errorAccs.length) {
      msg('Không có tài khoản nào có lỗi cần thử lại.');
      return;
    }

    if (!confirm(`Thử lại ${errorAccs.length} tài khoản có lỗi?\n• Các nhóm lỗi sẽ được đặt lại vào hàng đợi và tiếp tục đăng.`)) return;

    // Reset failed jobs to queued in storage
    for (const { camp } of errorAccs) {
      if (camp.jobs) {
        camp.jobs.forEach(j => {
          if (j.status === 'error' || j.status === 'blocked') {
            j.status = 'queued';
            j.note = 'Thử lại sau lỗi';
          }
        });
        const firstQueued = camp.jobs.findIndex(j => j.status === 'queued');
        if (firstQueued >= 0 && camp.index > firstQueued) {
          camp.index = firstQueued;
        }
      }
      camp.state = 'paused';
    }
    await chrome.storage.local.set({ campaigns: cMap });

    await sendDirect('RESUME_ALL');
    msg(`🔄 Đang thử lại ${errorAccs.length} tài khoản có lỗi...`);
    render();
  } catch (err) {
    msg('❌ Lỗi: ' + err.message);
  }
});

// ── Combined Section 4 View Switcher (Quản lý trực tiếp qua Thẻ KPI: Nick cá nhân vs Trang Fanpage vs Bảng chi tiết) ──
function switchProgressView(view) {
  if (['personal', 'fanpage', 'all'].includes(view)) {
    progAccountType = view;
    localStorage.setItem('ntd_prog_acc_type', view);
  }

  const isTable = view === 'links';

  // Cập nhật trạng thái viền sáng (active-kpi) trên các thẻ KPI
  $('dashKpiCardAccounts')?.classList.toggle('active-kpi', !isTable && progAccountType === 'personal');
  $('dashKpiCardFanpages')?.classList.toggle('active-kpi', !isTable && progAccountType === 'fanpage');
  $('kpiCardTotal')?.classList.toggle('active-kpi', isTable);

  if ($('toolbarAccountsView')) $('toolbarAccountsView').style.display = isTable ? 'none' : 'flex';
  if ($('toolbarLinksView')) $('toolbarLinksView').style.display = isTable ? 'flex' : 'none';
  if ($('paneAccountStatusView')) $('paneAccountStatusView').style.display = isTable ? 'none' : 'block';
  if ($('paneLinksTableView')) $('paneLinksTableView').style.display = isTable ? 'block' : 'none';

  if (isTable) {
    renderReport(cachedCampaigns, cachedAccounts);
  } else {
    render();
  }
}

// Master KPI Cards quick clicks (Chuyển đổi trực tiếp ngay trên các thẻ)
$('dashKpiCardAccounts')?.addEventListener('click', () => {
  progFilter = 'all';
  switchProgressView('personal');
});
$('dashKpiCardFanpages')?.addEventListener('click', () => {
  progFilter = 'all';
  switchProgressView('fanpage');
});
$('backToCardsBtn')?.addEventListener('click', () => {
  progFilter = 'all';
  switchProgressView(progAccountType || 'personal');
});
$('dashKpiCardRunning')?.addEventListener('click', () => {
  if ($('paneLinksTableView')?.style.display !== 'none') {
    switchProgressView(progAccountType || 'personal');
  }
  progFilter = (progFilter === 'running') ? 'all' : 'running';
  render();
});

// ── Format thời gian 24h (từ 00:00 đến 24:00, không phân CH / SA) ───────────────
function formatTime24(timestamp) {
  if (!timestamp) return '---';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '---';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateTime24(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ── Live Report System ────────────────────────────────────────────────────────
let currentReportFilter = 'all'; // 'all' | 'success' | 'waiting' | 'error'
let currentReportEntityTypeFilter = 'all'; // 'all' | 'personal' | 'fanpage'
let currentAccountFilter = 'all'; // 'all' | accId
let currentSearchTerm = '';

function renderReport(campaigns, accounts) {
  try {
    cachedCampaigns = campaigns || {};
    cachedAccounts = accounts || [];

    // Gather rows (hỗ trợ hiển thị đầy đủ cả trước khi chạy và trong khi chạy)
    const allRows = getAllConfiguredJobsOrCampaigns();

    // Calculate counts
    let countSuccess = 0;
    let countWaiting = 0;
    let countError = 0;

    allRows.forEach(row => {
      const cat = categorizeJob(row.status);
      if (cat === 'success') countSuccess++;
      else if (cat === 'waiting') countWaiting++;
      else countError++;
    });

    const total = allRows.length;

    // Update KPI counters
    if ($('reportCountTotal')) $('reportCountTotal').textContent = total;
    if ($('reportCountSuccess')) $('reportCountSuccess').textContent = countSuccess;
    if ($('hdrPostedCount')) $('hdrPostedCount').textContent = countSuccess;
    if ($('modalTabPostedCount')) $('modalTabPostedCount').textContent = countSuccess;
    if ($('modalTabQueuedCount')) $('modalTabQueuedCount').textContent = total;
    if ($('reportCountWaiting')) $('reportCountWaiting').textContent = countWaiting;
    if ($('reportCountError')) $('reportCountError').textContent = countError;

    if ($('pillCountAll')) $('pillCountAll').textContent = total;
    if ($('pillCountSuccess')) $('pillCountSuccess').textContent = countSuccess;
    if ($('pillCountWaiting')) $('pillCountWaiting').textContent = countWaiting;
    if ($('pillCountError')) $('pillCountError').textContent = countError;

    // Update Account Filter dropdown (grouped by Personal Accounts & Fanpages)
    const selectAcc = $('reportAccountFilter');
    if (selectAcc) {
      const curVal = selectAcc.value || currentAccountFilter;
      const accOptions = ['<option value="all">Tất cả tài khoản</option>'];
      const persList = (accounts || []).filter(a => a.type !== 'fanpage');
      const fpList = (accounts || []).filter(a => a.type === 'fanpage');

      if (persList.length > 0) {
        accOptions.push('<optgroup label="Tài khoản cá nhân">');
        persList.forEach(a => accOptions.push(`<option value="${a.id}">${a.name}</option>`));
        accOptions.push('</optgroup>');
      }
      if (fpList.length > 0) {
        accOptions.push('<optgroup label="Trang Fanpage">');
        fpList.forEach(a => accOptions.push(`<option value="${a.id}">${a.name}</option>`));
        accOptions.push('</optgroup>');
      }
      const newHtml = accOptions.join('');
      if (selectAcc.innerHTML !== newHtml) {
        selectAcc.innerHTML = newHtml;
        if (curVal && [...selectAcc.options].some(o => o.value === curVal)) {
          selectAcc.value = curVal;
        }
      }
    }

    // Filter rows
    const filtered = allRows.filter(row => {
      if (currentReportEntityTypeFilter !== 'all') {
        const isFp = row.accType === 'fanpage';
        if (currentReportEntityTypeFilter === 'personal' && isFp) return false;
        if (currentReportEntityTypeFilter === 'fanpage' && !isFp) return false;
      }
      if (currentReportFilter !== 'all') {
        const cat = categorizeJob(row.status);
        if (cat !== currentReportFilter) return false;
      }
      if (currentAccountFilter !== 'all' && row.accId !== currentAccountFilter) {
        return false;
      }
      if (currentSearchTerm) {
        const term = currentSearchTerm.toLowerCase();
        const matchUrl = row.url ? row.url.toLowerCase().includes(term) : false;
        const matchPostUrl = row.postUrl ? row.postUrl.toLowerCase().includes(term) : false;
        const matchAcc = row.accName ? row.accName.toLowerCase().includes(term) : false;
        const matchNote = row.note ? row.note.toLowerCase().includes(term) : false;
        if (!matchUrl && !matchPostUrl && !matchAcc && !matchNote) return false;
      }
      return true;
    });

    // Render Table Body: CHỈ format và chèn bảng khi tab Bảng chi tiết thực sự đang hiển thị để tối ưu tốc độ tối đa
    const paneTable = $('paneLinksTableView');
    const isTableVisible = paneTable && paneTable.style.display !== 'none';
    if (!isTableVisible) {
      return;
    }

    const tbody = $('reportTableBody');
    if (!tbody) return;

    if (allRows.length === 0) {
      tbody.innerHTML = '';
      return;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;padding:24px 16px;color:#94a3b8">
            Không có kết quả nào phù hợp với bộ lọc hiện tại.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map((row, i) => {
      const badge = getStatusBadge(row.status);
      const shortUrl = (row.url || '').replace('https://www.facebook.com/groups/', '').replace(/\/$/, '') || 'Link nhóm';

      const rowCamp = cachedCampaigns?.[row.accId];
      const hasRowRemaining = rowCamp?.state === 'running' && rowCamp?.nextAt && rowCamp.nextAt > Date.now();
      const rowRemSec = hasRowRemaining ? Math.max(0, Math.ceil((rowCamp.nextAt - Date.now()) / 1000)) : 0;
      const rowRemStr = rowRemSec >= 60 ? `${Math.floor(rowRemSec / 60)}p ${rowRemSec % 60 < 10 ? '0' : ''}${rowRemSec % 60}s` : `${rowRemSec}s`;

      const timeStr = row.doneAt 
        ? formatTime24(row.doneAt) 
        : (row.status === 'working' ? (hasRowRemaining && !rowCamp?.active ? `Còn ${rowRemStr}` : 'Đang chạy') : '---');

      let noteText = row.note || '';
      if (!noteText) {
        if (row.status === 'queued') noteText = 'Đang chờ đến lượt đăng';
        else if (row.status === 'working') {
          noteText = hasRowRemaining && !rowCamp?.active
            ? `Đang đếm ngược: còn ${rowRemStr} trước khi mở tab Facebook`
            : 'Đang mở tab Facebook và điền bài viết...';
        }
        else if (row.status === 'submitted') noteText = 'Đã bấm nút Đăng và đóng hộp thoại';
      }

      // Xác định link bài viết đã đăng (ưu tiên postUrl permalink, fallback sang bài viết của bạn trong nhóm nếu đã đăng)
      const isDonePost = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(row.status);
      const groupBase = (row.url || '').replace(/\/+$/, '');
      let directPostUrl = row.postUrl || '';
      let isFallbackYourPosts = false;

      if (!directPostUrl && isDonePost && groupBase) {
        directPostUrl = `${groupBase}/your_posts/`;
        isFallbackYourPosts = true;
      }

      let linkCellHtml = '';
      if (directPostUrl) {
        const linkBtnText = isFallbackYourPosts ? '🔗 Xem bài đã đăng' : '🔗 Link bài viết đã đăng';
        const linkTitle = isFallbackYourPosts 
          ? 'Xem bài viết bạn vừa đăng trong nhóm: ' + directPostUrl 
          : 'Mở trực tiếp bài viết đã đăng: ' + directPostUrl;

        linkCellHtml = `
          <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-start">
            <a href="${directPostUrl}" target="_blank" rel="noreferrer" 
               style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#1d4ed8;background:#eff6ff;padding:4px 10px;border-radius:6px;border:1px solid #bfdbfe;text-decoration:none;transition:all 0.15s ease;box-shadow:0 1px 2px rgba(37,99,235,0.06)" 
               title="${linkTitle}">
              <span>${linkBtnText}</span>
              <span style="font-size:11px">↗</span>
            </a>
            <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#64748b">
              <span>Thuộc nhóm:</span>
              <a href="${row.url || '#'}" target="_blank" rel="noreferrer" style="color:#64748b;text-decoration:none;font-weight:500" title="Nhóm Facebook: ${row.url || ''}">
                👥 ${shortUrl} ↗
              </a>
            </div>
          </div>
        `;
      } else if (row.status === 'queued' || row.status === 'working') {
        linkCellHtml = `
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#94a3b8;font-weight:500">
              <span>⏳ Đang chờ đăng</span>
            </span>
            <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#64748b">
              <span>Thuộc nhóm:</span>
              <a href="${row.url || '#'}" target="_blank" rel="noreferrer" style="color:#64748b;text-decoration:none;font-weight:500" title="Nhóm Facebook: ${row.url || ''}">
                👥 ${shortUrl} ↗
              </a>
            </div>
          </div>
        `;
      } else {
        linkCellHtml = `
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#ef4444;font-weight:600">
              <span>⚠️ Chưa đăng được</span>
            </span>
            <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#64748b">
              <span>Thuộc nhóm:</span>
              <a href="${row.url || '#'}" target="_blank" rel="noreferrer" style="color:#64748b;text-decoration:none;font-weight:500" title="Nhóm Facebook: ${row.url || ''}">
                👥 ${shortUrl} ↗
              </a>
            </div>
          </div>
        `;
      }

      return `
        <tr>
          <td style="text-align:center;color:#64748b;font-weight:600">${i + 1}</td>
          <td>
            <span style="font-weight:700;color:#0f172a">${row.accName}</span>
          </td>
          <td>
            ${linkCellHtml}
          </td>
          <td style="text-align:center">
            <span class="status-badge ${badge.cls}">${badge.label}</span>
          </td>
          <td style="color:#334155;line-height:1.4">
            <span>${noteText}</span>
          </td>
          <td style="text-align:center;color:#64748b;font-size:11.5px">
            ${timeStr}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.warn('[Report] renderReport error:', err);
  }
}

// ── Helpers xuất file báo cáo (TXT & Excel CSV với UTF-8 BOM) ─────────────────
function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsvFile(filename, rows) {
  const csvContent = '\uFEFF' + rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Queued & Posted Links Modal Logic ──────────────────────────────────────────
let modalQueuedLinks = [];
let currentModalTab = 'queued'; // 'queued' | 'posted'

function getModalFilteredItems() {
  const isPosted = currentModalTab === 'posted';
  const searchTerm = ($('modalQueuedSearchInput')?.value || '').trim().toLowerCase();
  const accFilter = $('modalQueuedAccFilter')?.value || 'all';

  const baseList = isPosted
    ? modalQueuedLinks.filter(r => ['submitted', 'sent_unverified', 'pending', 'preview'].includes(r.status) || Boolean(r.postUrl))
    : modalQueuedLinks;

  return baseList.filter(row => {
    if (accFilter !== 'all' && row.accId !== accFilter) return false;
    if (searchTerm) {
      const matchUrl = row.url ? row.url.toLowerCase().includes(searchTerm) : false;
      const matchPostUrl = row.postUrl ? row.postUrl.toLowerCase().includes(searchTerm) : false;
      const matchAcc = row.accName ? row.accName.toLowerCase().includes(searchTerm) : false;
      const matchTitle = row.postTitle ? row.postTitle.toLowerCase().includes(searchTerm) : false;
      if (!matchUrl && !matchPostUrl && !matchAcc && !matchTitle) return false;
    }
    return true;
  });
}

async function openQueuedLinksModal(filterAccId = 'all', mode = 'queued') {
  const modal = $('queuedLinksModal');
  if (!modal) return;

  currentModalTab = mode;
  try {
    const { campaigns, accounts } = await chrome.storage.local.get(['campaigns', 'accounts']);
    if (campaigns) cachedCampaigns = campaigns;
    if (accounts) cachedAccounts = accounts;
  } catch (_) {}

  modalQueuedLinks = getAllConfiguredJobsOrCampaigns();
  const total = modalQueuedLinks.length;
  const postedCount = modalQueuedLinks.filter(r => ['submitted', 'sent_unverified', 'pending', 'preview'].includes(r.status) || Boolean(r.postUrl)).length;

  if ($('modalTabQueuedCount')) $('modalTabQueuedCount').textContent = total;
  if ($('modalTabPostedCount')) $('modalTabPostedCount').textContent = postedCount;
  if ($('hdrPostedCount')) $('hdrPostedCount').textContent = postedCount;

  // Populate account filter select
  const accSelect = $('modalQueuedAccFilter');
  if (accSelect) {
    const accMap = new Map();
    modalQueuedLinks.forEach(item => {
      if (!accMap.has(item.accId)) {
        accMap.set(item.accId, { id: item.accId, name: item.accName, type: item.accType, count: 0, postedCount: 0 });
      }
      accMap.get(item.accId).count++;
      if (['submitted', 'sent_unverified', 'pending', 'preview'].includes(item.status) || Boolean(item.postUrl)) {
        accMap.get(item.accId).postedCount++;
      }
    });

    const optHtml = ['<option value="all">Tất cả tài khoản (' + total + ')</option>'];
    const pers = [...accMap.values()].filter(a => a.type !== 'fanpage');
    const fans = [...accMap.values()].filter(a => a.type === 'fanpage');

    if (pers.length > 0) {
      optHtml.push('<optgroup label="Tài khoản cá nhân">');
      pers.forEach(a => optHtml.push(`<option value="${a.id}">${a.name} (${a.count})</option>`));
      optHtml.push('</optgroup>');
    }
    if (fans.length > 0) {
      optHtml.push('<optgroup label="Trang Fanpage">');
      fans.forEach(a => optHtml.push(`<option value="${a.id}">${a.name} (${a.count})</option>`));
      optHtml.push('</optgroup>');
    }
    accSelect.innerHTML = optHtml.join('');
    if (filterAccId && [...accSelect.options].some(o => o.value === filterAccId)) {
      accSelect.value = filterAccId;
    }
  }

  if ($('modalQueuedSearchInput')) $('modalQueuedSearchInput').value = '';
  updateModalTabVisuals();
  renderQueuedModalTable();

  modal.style.display = 'flex';
}

function updateModalTabVisuals() {
  const isPosted = currentModalTab === 'posted';
  const total = modalQueuedLinks.length;
  const postedCount = modalQueuedLinks.filter(r => ['submitted', 'sent_unverified', 'pending', 'preview'].includes(r.status) || Boolean(r.postUrl)).length;

  if ($('modalHeaderIcon')) $('modalHeaderIcon').textContent = isPosted ? '🔗' : '📋';
  if ($('modalQueuedTitle')) $('modalQueuedTitle').textContent = isPosted ? 'Danh sách link bài viết đã đăng' : 'Danh sách link các bài để đăng';
  if ($('modalQueuedSubtitle')) {
    $('modalQueuedSubtitle').textContent = isPosted 
      ? `Đã đăng thành công ${postedCount} bài viết`
      : `Tổng số ${total} link nhóm được phân công đăng`;
  }

  const btnQueued = $('modalTabQueued');
  const btnPosted = $('modalTabPosted');
  if (btnQueued && btnPosted) {
    btnQueued.classList.toggle('active', !isPosted);
    btnPosted.classList.toggle('active', isPosted);
    const isDark = document.body.classList.contains('ntd-dark-theme');
    if (isDark) {
      btnQueued.style.background = !isPosted ? '#1e293b' : 'transparent';
      btnQueued.style.color = !isPosted ? '#38bdf8' : '#94a3b8';
      btnPosted.style.background = isPosted ? 'rgba(16, 185, 129, 0.25)' : 'transparent';
      btnPosted.style.color = isPosted ? '#34d399' : '#94a3b8';
    } else {
      if (isPosted) {
        btnPosted.style.background = '#16a34a';
        btnPosted.style.color = '#ffffff';
        btnQueued.style.background = 'transparent';
        btnQueued.style.color = '#64748b';
      } else {
        btnQueued.style.background = '#ffffff';
        btnQueued.style.color = '#0284c7';
        btnPosted.style.background = 'transparent';
        btnPosted.style.color = '#64748b';
      }
    }
  }

  if ($('modalColHeaderTarget')) {
    $('modalColHeaderTarget').textContent = isPosted ? 'Link bài viết đã đăng' : 'Đường link nhóm để đăng bài';
  }
}

function closeQueuedLinksModal() {
  const modal = $('queuedLinksModal');
  if (modal) modal.style.display = 'none';
}

function renderQueuedModalTable() {
  const tbody = $('modalQueuedTableBody');
  if (!tbody) return;

  const isPosted = currentModalTab === 'posted';
  const filtered = getModalFilteredItems();
  const baseList = isPosted
    ? modalQueuedLinks.filter(r => ['submitted', 'sent_unverified', 'pending', 'preview'].includes(r.status) || Boolean(r.postUrl))
    : modalQueuedLinks;

  if ($('modalQueuedFooterCount')) {
    $('modalQueuedFooterCount').textContent = `Hiển thị ${filtered.length} / ${baseList.length} ${isPosted ? 'bài viết đã đăng' : 'link nhóm'}`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;padding:28px 16px;color:#94a3b8;line-height:1.6">
          ${isPosted 
            ? '⚠️ Chưa có bài viết nào được đăng thành công.<br><span style="font-size:12px;color:#64748b">Vui lòng bấm nút <b>"Bắt đầu tất cả tài khoản"</b> để chạy chiến dịch đăng bài. Sau khi đăng xong, link bài viết sẽ xuất hiện tại đây để bạn xem và xuất file.</span>' 
            : (modalQueuedLinks.length === 0 ? 'Chưa có link nhóm nào được chọn để đăng bài. Vui lòng cấu hình ở mục 2.' : 'Không có link nào khớp với tìm kiếm.')}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((row, i) => {
    const badge = getStatusBadge(row.status);
    const shortUrl = (row.url || '').replace('https://www.facebook.com/groups/', '').replace(/\/$/, '') || 'Link nhóm';
    const isFp = row.accType === 'fanpage';
    const groupBase = (row.url || '').replace(/\/+$/, '');
    const effPostUrl = (row.postUrl && row.postUrl.trim()) ? row.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : '');

    let linkDisplay = '';
    if (isPosted) {
      linkDisplay = effPostUrl ? `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <a href="${effPostUrl}" target="_blank" rel="noreferrer" 
             style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#1d4ed8;background:#eff6ff;padding:3px 8px;border-radius:5px;border:1px solid #bfdbfe;text-decoration:none" 
             title="${effPostUrl}">
            <span>🔗 Xem bài viết</span>
            <span style="font-size:10px">↗</span>
          </a>
          <button type="button" class="btn-copy-modal-single" data-url="${effPostUrl}" 
             style="background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer;font-size:11px;color:#334155;padding:3px 7px;border-radius:4px;font-weight:600" 
             title="Sao chép link bài viết này">
            📋 Sao chép
          </button>
          <span style="font-size:11px;color:#64748b">Thuộc nhóm: ${shortUrl}</span>
        </div>
      ` : `<span style="color:#94a3b8;font-size:11.5px">Thuộc nhóm: ${shortUrl}</span>`;
    } else {
      linkDisplay = `
        <div style="display:flex;align-items:center;gap:6px">
          <a href="${row.url || '#'}" target="_blank" rel="noreferrer" class="group-link-item" title="${row.url || ''}">
            <span>${shortUrl}</span>
            <span style="font-size:11px;opacity:0.7">↗</span>
          </a>
          <button type="button" class="btn-copy-modal-single" data-url="${row.url || ''}" 
             style="background:#f8fafc;border:1px solid #cbd5e1;cursor:pointer;font-size:11px;color:#334155;padding:2px 6px;border-radius:4px;font-weight:600" 
             title="Sao chép link nhóm này">
            📋 Copy
          </button>
        </div>
      `;
    }

    return `
      <tr>
        <td style="text-align:center;color:#64748b;font-weight:600">${i + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:12px">${isFp ? '🚩' : '👤'}</span>
            <span style="font-weight:700;color:#0f172a;font-size:12.5px">${row.accName}</span>
          </div>
        </td>
        <td style="text-align:center">
          <span style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px">
            ${row.postTitle || 'Bài 1'}
          </span>
        </td>
        <td>
          ${linkDisplay}
        </td>
        <td style="text-align:center">
          <span class="status-badge ${badge.cls}">${badge.label}</span>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện sao chép từng link
  tbody.querySelectorAll('.btn-copy-modal-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const targetUrl = btn.dataset.url;
      if (!targetUrl) return;
      await navigator.clipboard.writeText(targetUrl);
      const originalText = btn.textContent;
      btn.textContent = '✅ Đã chép';
      btn.style.color = '#15803d';
      btn.style.borderColor = '#86efac';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = '#334155';
        btn.style.borderColor = '#cbd5e1';
      }, 1500);
    });
  });
}

// Init report event handlers
function initReportEvents() {
  // Button mở modal xem danh sách link bài để đăng ở Header
  $('btnViewQueuedLinksHeader')?.addEventListener('click', () => openQueuedLinksModal('all', 'queued'));
  $('btnViewQueuedLinksModal')?.addEventListener('click', () => openQueuedLinksModal('all', 'queued'));

  // Button mở modal xem danh sách link bài viết ĐÃ ĐĂNG ở Header
  $('btnViewPostedLinksHeader')?.addEventListener('click', () => {
    openQueuedLinksModal('all', 'posted');
  });

  // Nút chuyển chế độ xem bảng từ toolbar Card View
  $('switchToTableViewBtn')?.addEventListener('click', () => {
    switchProgressView('links');
    $('paneLinksTableView')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Modal tabs
  $('modalTabQueued')?.addEventListener('click', () => {
    currentModalTab = 'queued';
    updateModalTabVisuals();
    renderQueuedModalTable();
  });
  $('modalTabPosted')?.addEventListener('click', () => {
    currentModalTab = 'posted';
    updateModalTabVisuals();
    renderQueuedModalTable();
  });

  // Nút đóng modal
  $('closeQueuedLinksModalBtn')?.addEventListener('click', closeQueuedLinksModal);
  $('modalCloseBottomBtn')?.addEventListener('click', closeQueuedLinksModal);
  $('queuedLinksModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'queuedLinksModal') closeQueuedLinksModal();
  });

  // Tìm kiếm & lọc tài khoản trong modal
  $('modalQueuedSearchInput')?.addEventListener('input', renderQueuedModalTable);
  $('modalQueuedAccFilter')?.addEventListener('change', renderQueuedModalTable);

  // Sao chép danh sách link từ modal (ưu tiên link bài viết nếu đang ở tab bài viết đã đăng)
  $('modalCopyFilteredLinksBtn')?.addEventListener('click', async () => {
    const isPosted = currentModalTab === 'posted';
    const items = getModalFilteredItems();
    if (items.length === 0) {
      alert(isPosted 
        ? '⚠️ Chưa có bài viết nào được đăng thành công để sao chép link. Vui lòng bấm "Bắt đầu tất cả tài khoản" để tiến hành đăng bài trước.' 
        : '⚠️ Không có link nhóm nào để sao chép.');
      return;
    }

    const urls = items.map(r => {
      if (isPosted) {
        const groupBase = (r.url || '').replace(/\/+$/, '');
        return (r.postUrl && r.postUrl.trim()) ? r.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : r.url);
      }
      return r.url;
    }).filter(Boolean);

    const uniqueUrls = [...new Set(urls)];
    await navigator.clipboard.writeText(uniqueUrls.join('\n'));
    alert(`✅ Đã sao chép ${uniqueUrls.length} ${isPosted ? 'link bài viết đã đăng' : 'link nhóm'} vào bộ nhớ tạm!`);
  });

  // Xuất file TXT từ modal
  $('modalExportTxtBtn')?.addEventListener('click', () => {
    const isPosted = currentModalTab === 'posted';
    const items = getModalFilteredItems();
    if (items.length === 0) {
      alert(isPosted 
        ? '⚠️ Chưa có bài viết nào được đăng thành công để xuất file TXT.\nVui lòng bấm "Bắt đầu tất cả tài khoản" để tiến hành đăng bài trước.' 
        : '⚠️ Không có link nhóm nào để xuất file TXT.');
      return;
    }

    const urls = items.map(r => {
      if (isPosted) {
        const groupBase = (r.url || '').replace(/\/+$/, '');
        return (r.postUrl && r.postUrl.trim()) ? r.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : r.url);
      }
      return r.url;
    }).filter(Boolean);

    const uniqueUrls = [...new Set(urls)];
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = isPosted ? `Link_bai_viet_da_dang_${dateStr}.txt` : `Danh_sach_nhom_chuan_bi_dang_${dateStr}.txt`;
    downloadTextFile(filename, uniqueUrls.join('\r\n'));
  });

  // Xuất file Excel (CSV) từ modal
  $('modalExportCsvBtn')?.addEventListener('click', () => {
    const isPosted = currentModalTab === 'posted';
    const items = getModalFilteredItems();
    if (items.length === 0) {
      alert(isPosted 
        ? '⚠️ Chưa có bài viết nào được đăng thành công để xuất file Excel.\nVui lòng bấm "Bắt đầu tất cả tài khoản" để tiến hành đăng bài trước.' 
        : '⚠️ Không có link nào để xuất file Excel.');
      return;
    }

    const rows = isPosted
      ? [
          ['STT', 'Tài khoản', 'Tên bài viết', 'Link bài viết đã đăng', 'Nhóm Facebook', 'Trạng thái', 'Thời gian hoàn tất'],
          ...items.map((r, i) => {
            const groupBase = (r.url || '').replace(/\/+$/, '');
            const postUrl = (r.postUrl && r.postUrl.trim()) ? r.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : '');
            const badge = getStatusBadge(r.status);
            const timeStr = r.doneAt ? formatDateTime24(r.doneAt) : '';
            return [
              i + 1,
              r.accName,
              r.postTitle || 'Bài 1',
              postUrl,
              r.url || '',
              badge.label.replace(/^[^\w\s\u00C0-\u1EF9]*\s*/, ''),
              timeStr
            ];
          })
        ]
      : [
          ['STT', 'Tài khoản phân công', 'Tên bài viết', 'Link nhóm Facebook', 'Trạng thái'],
          ...items.map((r, i) => {
            const badge = getStatusBadge(r.status);
            return [
              i + 1,
              r.accName,
              r.postTitle || 'Bài 1',
              r.url || '',
              badge.label.replace(/^[^\w\s\u00C0-\u1EF9]*\s*/, '')
            ];
          })
        ];

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = isPosted ? `Bao_cao_bai_viet_da_dang_${dateStr}.csv` : `Danh_sach_nhom_chuan_bi_dang_${dateStr}.csv`;
    downloadCsvFile(filename, rows);
  });

  // Sao chép toàn bộ link cần đăng từ Note
  $('btnCopyAllQueuedLinks')?.addEventListener('click', async () => {
    const allList = getAllConfiguredJobsOrCampaigns();
    const urls = [...new Set(allList.map(r => r.url).filter(Boolean))];
    if (urls.length === 0) {
      alert('Chưa có link nhóm nào được cấu hình để đăng.');
      return;
    }
    await navigator.clipboard.writeText(urls.join('\n'));
    alert(`✅ Đã sao chép toàn bộ ${urls.length} link nhóm cần đăng vào bộ nhớ tạm!`);
  });

  // Chuyển sang bảng đầy đủ từ modal
  $('modalSwitchToFullTableBtn')?.addEventListener('click', () => {
    closeQueuedLinksModal();
    switchProgressView('links');
    $('paneLinksTableView')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Filter pills
  document.querySelectorAll('#reportStatusFilters button[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#reportStatusFilters button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentReportFilter = btn.dataset.filter;
      renderReport(cachedCampaigns, cachedAccounts);
    });
  });

  // KPI cards click shortcuts
  $('kpiCardTotal')?.addEventListener('click', () => {
    switchProgressView('links');
    document.querySelector('#reportStatusFilters button[data-filter="all"]')?.click();
  });
  $('kpiCardSuccess')?.addEventListener('click', () => {
    if ($('paneLinksTableView')?.style.display !== 'none') {
      document.querySelector('#reportStatusFilters button[data-filter="success"]')?.click();
    } else {
      progFilter = (progFilter === 'done') ? 'all' : 'done';
      render();
    }
  });
  $('kpiCardWaiting')?.addEventListener('click', () => {
    switchProgressView('links');
    document.querySelector('#reportStatusFilters button[data-filter="waiting"]')?.click();
  });
  $('kpiCardError')?.addEventListener('click', () => {
    if ($('paneLinksTableView')?.style.display !== 'none') {
      document.querySelector('#reportStatusFilters button[data-filter="error"]')?.click();
    } else {
      progFilter = (progFilter === 'error') ? 'all' : 'error';
      render();
    }
  });

  // Entity type filter dropdown
  $('reportEntityTypeFilter')?.addEventListener('change', (e) => {
    currentReportEntityTypeFilter = e.target.value;
    renderReport(cachedCampaigns, cachedAccounts);
  });

  // Account filter dropdown
  $('reportAccountFilter')?.addEventListener('change', (e) => {
    currentAccountFilter = e.target.value;
    renderReport(cachedCampaigns, cachedAccounts);
  });

  // Search input (Debounced 150ms)
  const debouncedReportSearch = debounce(() => {
    renderReport(cachedCampaigns, cachedAccounts);
  }, 150);

  $('reportSearchInput')?.addEventListener('input', (e) => {
    currentSearchTerm = e.target.value.trim();
    debouncedReportSearch();
  });

  // Copy success links (Ưu tiên link bài viết đã đăng, fallback sang link your_posts trong nhóm)
  $('copySuccessLinksBtn')?.addEventListener('click', async () => {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    const successUrls = [];
    const seen = new Set();
    for (const c of Object.values(campaigns || {})) {
      for (const j of c.jobs || []) {
        const isDone = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(j.status) || Boolean(j.postUrl);
        if (isDone) {
          const groupBase = (j.url || '').replace(/\/+$/, '');
          const targetUrl = (j.postUrl && j.postUrl.trim()) ? j.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : j.url);
          if (targetUrl && !seen.has(targetUrl)) {
            seen.add(targetUrl);
            successUrls.push(targetUrl);
          }
        }
      }
    }

    if (successUrls.length === 0) {
      alert('⚠️ Chưa có bài viết nào đăng thành công để sao chép link.\nVui lòng bấm "Bắt đầu tất cả tài khoản" để tiến hành đăng bài trước.');
      return;
    }

    await navigator.clipboard.writeText(successUrls.join('\n'));
    alert(`✅ Đã sao chép thành công ${successUrls.length} link bài viết đã đăng vào bộ nhớ tạm!`);
  });

  // Xuất file TXT danh sách link bài viết đã đăng từ thanh công cụ Section 4
  $('exportPostedTxtBtn')?.addEventListener('click', async () => {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    const successUrls = [];
    const seen = new Set();
    for (const c of Object.values(campaigns || {})) {
      for (const j of c.jobs || []) {
        const isDone = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(j.status) || Boolean(j.postUrl);
        if (isDone) {
          const groupBase = (j.url || '').replace(/\/+$/, '');
          const targetUrl = (j.postUrl && j.postUrl.trim()) ? j.postUrl.trim() : (groupBase ? `${groupBase}/your_posts/` : j.url);
          if (targetUrl && !seen.has(targetUrl)) {
            seen.add(targetUrl);
            successUrls.push(targetUrl);
          }
        }
      }
    }

    if (successUrls.length === 0) {
      alert('⚠️ Chưa có bài viết nào được đăng thành công để xuất file TXT.\nVui lòng bấm "Bắt đầu tất cả tài khoản" để tiến hành đăng bài trước.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    downloadTextFile(`Link_bai_viet_da_dang_${dateStr}.txt`, successUrls.join('\r\n'));
  });

  // Export CSV (UTF-8 BOM for Windows Excel compatibility)
  $('exportReportCsvBtn')?.addEventListener('click', async () => {
    const { campaigns, accounts } = await chrome.storage.local.get(['campaigns', 'accounts']);
    if (campaigns) cachedCampaigns = campaigns;
    if (accounts) cachedAccounts = accounts;

    const rows = [
      ['STT', 'Tài khoản', 'Link nhóm Facebook', 'Link bài viết đã đăng', 'Trạng thái', 'Ghi chú phản hồi', 'Thời gian hoàn tất']
    ];

    let stt = 1;
    const allRows = getAllConfiguredJobsOrCampaigns();
    for (const r of allRows) {
      const badge = getStatusBadge(r.status);
      const timeStr = r.doneAt ? formatDateTime24(r.doneAt) : '';
      const isDone = ['submitted', 'sent_unverified', 'pending', 'preview'].includes(r.status) || Boolean(r.postUrl);
      const groupBase = (r.url || '').replace(/\/+$/, '');
      const postUrlToExport = (r.postUrl && r.postUrl.trim()) ? r.postUrl.trim() : (isDone && groupBase ? `${groupBase}/your_posts/` : '');
      rows.push([
        stt++,
        r.accName,
        r.url || '',
        postUrlToExport,
        badge.label.replace(/^[^\w\s\u00C0-\u1EF9]*\s*/, ''),
        r.note || '',
        timeStr
      ]);
    }

    if (rows.length <= 1) {
      alert('Chưa có dữ liệu link nhóm nào để xuất file.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    downloadCsvFile(`Bao_cao_dang_bai_NTD_${dateStr}.csv`, rows);
  });

  // Clear Report
  $('clearReportBtn')?.addEventListener('click', async () => {
    if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử báo cáo hiện tại?')) return;
    await chrome.storage.local.remove('campaigns');
    await chrome.storage.local.remove('coordinator');
    msg('✅ Đã xóa toàn bộ báo cáo cũ.');
    render();
  });
}

// ── Adaptive countdown ticker: cập nhật đếm ngược siêu tốc trực tiếp trong DOM (0% CPU, không giật lag) ──
let _renderPollTimer = null;
let _lastAnyRunning = false;

function updateCountdownTicks() {
  const now = Date.now();
  let anyCountdownActive = false;

  for (const [accId, c] of Object.entries(cachedCampaigns || {})) {
    if (c?.state === 'running' && c?.nextAt) {
      const remainingSec = Math.max(0, Math.ceil((c.nextAt - now) / 1000));
      const str = formatCountdown(remainingSec);
      if (remainingSec > 0) {
        anyCountdownActive = true;
      }

      const card = document.getElementById(`progCard_${accId}`);
      if (card) {
        const pill = card.querySelector('.prog-pill-countdown');
        if (pill) pill.textContent = remainingSec > 0 ? `Đếm ngược ${str}` : 'Đang đăng';
        const badge = card.querySelector('.prog-countdown-badge b');
        if (badge) badge.textContent = str;
        const suffix = card.querySelector('.prog-countdown-suffix');
        if (suffix) suffix.textContent = `còn ${str}`;
      }
    }
  }

  return anyCountdownActive;
}

function scheduleNextRender() {
  clearTimeout(_renderPollTimer);
  const anyRunning = Object.values(cachedCampaigns || {}).some(
    c => c?.state === 'running' || c?.state === 'waiting'
  );
  const anyPaused = Object.values(cachedCampaigns || {}).some(
    c => c?.state === 'paused' || (c?.state === 'stopped' && c.index > 0 && c.index < (c.jobs?.length || 0))
  );

  // Chuyển trạng thái: nếu vừa có nick chạy xong → render ngay 1 lần nữa để chốt báo cáo
  if (_lastAnyRunning && !anyRunning) {
    _lastAnyRunning = false;
    render();
    return;
  }
  _lastAnyRunning = anyRunning;

  // Cập nhật số giây đếm ngược và đồng bộ tiến độ từ Extension Runner mỗi 1.2s
  if (anyRunning || anyPaused) {
    _renderPollTimer = setTimeout(async () => {
      const isWeb = typeof window !== 'undefined' && (!window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp');
      if (isWeb && window.__ntdExtensionActive) {
        await render();
      } else {
        updateCountdownTicks();
      }
      scheduleNextRender();
    }, 1200);
  }
}

// ── Debounced render để tránh render liên tục khi storage thay đổi nhiều lần ──
const debouncedRender = debounce(() => render().then(scheduleNextRender), 150);
const debouncedRenderCategories = debounce(renderAccountCategoryAssignments, 200);

chrome.storage.onChanged.addListener(async (changes) => {
  // Chỉ xử lý các key thực sự liên quan để tránh render thừa
  const relevantForRender = ['campaigns', 'coordinator', 'accounts', 'dailyPostStats'];
  const relevantForCategories = ['groupCategories', 'accounts'];
  const relevantForCatDropdown = ['groupCategories', 'lastSelectedCategory'];

  if (changes.license) {
    licenseInfo = await checkLicense();
    updateLicenseDisplay();
  }

  if (relevantForRender.some(k => k in changes)) {
    debouncedRender();
  }

  if (relevantForCatDropdown.some(k => k in changes)) {
    loadAndRenderCategoriesDropdown();
  }

  if (relevantForCategories.some(k => k in changes)) {
    debouncedRenderCategories();
    renderSharedAccountsSelector();
  }
});

initReportEvents();
switchProgressView(progAccountType);
await render();
scheduleNextRender();

// Modal quản lý hướng dẫn nạp Extension khi chạy trên Web Platform
let _onManualContinueHandler = null;

function showExtensionRequiredModal(onManualContinue) {
  _onManualContinueHandler = onManualContinue;
  const modal = $('extensionRequiredModal');
  if (modal) {
    modal.style.display = 'flex';
  } else if (typeof onManualContinue === 'function') {
    onManualContinue();
  }
}

const closeExtModalBtn = $('closeExtModalBtn');
if (closeExtModalBtn) {
  closeExtModalBtn.onclick = () => {
    const modal = $('extensionRequiredModal');
    if (modal) modal.style.display = 'none';
  };
}

const continuePasteManualBtn = $('continuePasteManualBtn');
if (continuePasteManualBtn) {
  continuePasteManualBtn.onclick = () => {
    const modal = $('extensionRequiredModal');
    if (modal) modal.style.display = 'none';
    if (typeof _onManualContinueHandler === 'function') {
      _onManualContinueHandler();
    }
  };
}

// Cập nhật thông báo trạng thái nền tảng Web / Extension Connection
(function checkPlatformStatus() {
  const noticeEl = $('webPlatformNotice');
  if (!noticeEl) return;
  const isWebPlatform = !window.chrome?.runtime?.id || window.chrome.runtime.id === 'ntd-agency-webapp';
  if (!isWebPlatform) {
    noticeEl.style.display = 'none';
    window.__ntdExtensionActive = true;
    return;
  }

  noticeEl.style.display = 'block';
  const updateConnUI = (isConnected) => {
    window.__ntdExtensionActive = Boolean(isConnected);
    const icon = $('webPlatformNoticeIcon');
    const title = $('webPlatformNoticeTitle');
    const desc = $('webPlatformNoticeDesc');

    if (isConnected) {
      noticeEl.style.background = 'rgba(16,185,129,0.12)';
      noticeEl.style.borderColor = 'rgba(16,185,129,0.4)';
      noticeEl.style.color = '#6ee7b7';
      if (icon) icon.textContent = '✅';
      if (title) title.textContent = 'Đã kết nối Tiện ích Chrome Runner (Tự động điền & Đăng bài 100%)';
      if (desc) desc.innerHTML = 'Hệ thống đã kết nối thành công với Tiện ích Chrome. Khi bạn bấm <b>"▶ Bắt đầu tất cả tài khoản"</b>, tiện ích sẽ tự động điền bài và bấm Đăng vào Facebook 100%! Bạn có thể thao tác trực tiếp tại đây.';
    } else {
      noticeEl.style.background = 'rgba(245,158,11,0.12)';
      noticeEl.style.borderColor = 'rgba(245,158,11,0.4)';
      noticeEl.style.color = '#fbbf24';
      if (icon) icon.textContent = '⚠️';
      if (title) title.textContent = 'Chưa kết nối Tiện ích Chrome Runner (Chưa thể tự động gõ bài vào Facebook)';
      if (desc) desc.innerHTML = 'Trình duyệt web chặn không cho Website tự ý gõ chữ vào Facebook do chính sách bảo mật.<br>' +
        '👉 <b>Cách 1 (Nhanh nhất - 1 nhấp chuột):</b> Chạy file <code>KHOI_DONG_TU_DONG.bat</code> trong thư mục <code>C:\\Users\\T&Tcenter\\Downloads\\WEBSITE</code> trên máy tính.<br>' +
        '👉 <b>Cách 2:</b> Vào <code>chrome://extensions</code> ➔ Bật Developer mode ➔ Bấm "Tải tiện ích đã giải nén" (Load unpacked) chọn thư mục <code>C:\\Users\\T&Tcenter\\Downloads\\WEBSITE</code>.<br>' +
        '<i>(Sau khi làm xong, nhấn <b>Ctrl + F5</b> tải lại trang web này là hệ thống sẽ tự động chuyển sang màu xanh ✅)</i>';
    }
  };

  // Kiểm tra ngay bằng ping tới extension runner
  if (window.chrome?.runtime?.sendToExtension) {
    window.chrome.runtime.sendToExtension({ type: 'PING' }).then(resp => {
      if (resp && resp.ok) updateConnUI(true);
      else updateConnUI(false);
    }).catch(() => updateConnUI(false));
  } else {
    updateConnUI(false);
  }

  window.addEventListener('NTD_EXTENSION_READY', () => updateConnUI(true));
})();

