/**
 * NTD Agency - Right Navigation Sidebar Component
 * Cung cấp thanh menu bên phải cố định, chuyển đổi đồng bộ giữa 4 phần:
 * 1. Đăng bài (panel.html)
 * 2. Quản lý tài khoản cá nhân (accounts.html)
 * 3. Quản lý Fanpage (fanpages.html)
 * 4. Quản lý danh sách nhóm (groups.html)
 */
import { enforceLicenseGate, logoutAccount, checkCurrentLicense } from './license.js';
import { applyTheme, mountThemeToggle, getCurrentTheme } from './theme_toggle.js';
import { supabaseUpdateUserStats } from './supabase.js';
import { initSyncModal } from './sync_helper.js';

// 0. Khởi tạo Chế độ Ban đêm / Ban ngày & Nút chuyển đổi góc trên bên phải NGAY TỨC THÌ
applyTheme(getCurrentTheme());
mountThemeToggle();


// Bắt buộc kiểm tra bản quyền toàn hệ thống: Nếu chưa kích hoạt, chặn và chuyển hướng ngay về trang đăng nhập
const activeLicense = await enforceLicenseGate();

(() => {
  // Cập nhật lại theme với đầy đủ các phần tử DOM sau khi DOM đã sẵn sàng
  applyTheme(localStorage.getItem('ntd_theme') || 'dark');

  if (chrome?.storage?.local) {
    chrome.storage.local.get(['ntdDarkMode'], (res) => {
      if (res.ntdDarkMode !== undefined) {
        const t = res.ntdDarkMode ? 'dark' : 'light';
        localStorage.setItem('ntd_theme', t);
        applyTheme(t);
      }
    });
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'ntd_theme') {
      applyTheme(e.newValue);
    }
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.ntdDarkMode !== undefined) {
        const t = changes.ntdDarkMode.newValue ? 'dark' : 'light';
        localStorage.setItem('ntd_theme', t);
        applyTheme(t);
      }
    });
  }

  // 1. Kiểm tra trạng thái thu gọn đã lưu từ trước
  const isCollapsed = localStorage.getItem('ntd_sidebar_collapsed') === 'true';
  document.body.classList.add('has-sidebar');
  document.body.classList.add('has-left-sidebar');
  document.body.classList.add('has-right-sidebar');
  if (isCollapsed) {
    document.body.classList.add('sidebar-collapsed');
  }

  // 2. Xác định trang hiện tại để highlight
  const currentPath = window.location.pathname.toLowerCase();
  let activeKey = 'panel';
  if (currentPath.includes('groups.html')) {
    activeKey = 'groups';
  } else if (currentPath.includes('warmup.html')) {
    activeKey = 'warmup';
  } else if (currentPath.includes('fanpages.html')) {
    activeKey = 'fanpages';
  } else if (currentPath.includes('accounts.html')) {
    activeKey = 'accounts';
  } else if (currentPath.includes('maps.html')) {
    activeKey = 'maps';
  } else if (currentPath.includes('settings.html')) {
    activeKey = 'settings';
  } else if (currentPath.includes('manage.html')) {
    activeKey = 'manage';
  } else if (currentPath.includes('dashboard.html')) {
    activeKey = 'dashboard';
  } else if (currentPath.includes('panel.html')) {
    activeKey = 'panel';
  }

  // 3. URLs tương ứng của các mục
  const urlHome = chrome.runtime?.getURL ? chrome.runtime.getURL('index.html') : 'index.html';
  const urlPanel = chrome.runtime?.getURL ? chrome.runtime.getURL('panel.html') : 'panel.html';
  const urlGroups = chrome.runtime?.getURL ? chrome.runtime.getURL('groups.html') : 'groups.html';
  const urlAccounts = chrome.runtime?.getURL ? chrome.runtime.getURL('accounts.html') : 'accounts.html';
  const urlWarmup = chrome.runtime?.getURL ? chrome.runtime.getURL('warmup.html') : 'warmup.html';
  const urlFanpages = chrome.runtime?.getURL ? chrome.runtime.getURL('fanpages.html') : 'fanpages.html';
  const urlMaps = chrome.runtime?.getURL ? chrome.runtime.getURL('maps.html') : 'maps.html';
  const urlSettings = chrome.runtime?.getURL ? chrome.runtime.getURL('settings.html') : 'settings.html';
  const urlManage = chrome.runtime?.getURL ? chrome.runtime.getURL('manage.html') : 'manage.html';
  const urlDashboard = chrome.runtime?.getURL ? chrome.runtime.getURL('dashboard.html') : 'dashboard.html';

  // 4. Kiểm tra quyền Admin & Giao diện Dark / Light để áp dụng style hòa hợp
  const isAdmin = (activeLicense?.role || '').toLowerCase() === 'admin';
  const currentThemeMode = localStorage.getItem('ntd_theme') || 'dark';
  const isDarkPage = currentThemeMode === 'dark' || 
                     document.documentElement.classList.contains('ntd-dark-theme') ||
                     (document.body && document.body.classList.contains('ntd-dark-theme'));

  // 4b. Thông tin tài khoản & Bản quyền để ghim cố định ở góc dưới thanh menu
  const username = activeLicense?.username || 'Tài khoản';
  const expDateObj = activeLicense?.expiry ? new Date(activeLicense.expiry) : null;
  const expiryFormatted = activeLicense?.expiryFormatted || (expDateObj ? expDateObj.toLocaleDateString('vi-VN') : '--/--/----');
  const daysLeft = activeLicense?.daysLeft !== undefined ? activeLicense.daysLeft : (expDateObj ? Math.ceil((expDateObj - new Date()) / 86400000) : 0);
  const daysText = daysLeft > 0 ? `còn ${daysLeft} ngày` : 'Hết hạn';

  // 5. Template HTML của Sidebar
  const sidebarHtml = `
  <aside id="ntdRightSidebar" class="${isDarkPage ? 'theme-dark' : ''}" aria-label="Thanh điều hướng chính">
    <!-- Header -->
    <div class="ntd-sb-header">
      <a href="${urlHome}" data-page="index.html" class="ntd-sb-brand" data-tooltip="NTD Agency – Trang chủ Platform">
        <div class="ntd-sb-logo">NTD</div>
        <div class="ntd-sb-brand-info">
          <span class="ntd-sb-brand-name">NTD Agency</span>
          <span class="ntd-sb-brand-tag">Điều hướng</span>
        </div>
      </a>
      <button type="button" class="ntd-sb-toggle-btn" id="ntdSbToggleBtn" data-tooltip="${isCollapsed ? 'Mở rộng menu' : 'Thu gọn menu'}" aria-label="Thu gọn hoặc mở rộng menu">
        <svg class="ntd-sb-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
    </div>

    <!-- Section Label -->
    <div class="ntd-sb-section-label">Menu chức năng</div>

    <!-- Navigation List (7 mục chính) -->
    <nav class="ntd-sb-nav" role="navigation">
      <!-- Mục 1: Đăng bài -->
      <a href="${urlPanel}" data-page="panel.html" class="ntd-sb-item ${activeKey === 'panel' ? 'active' : ''}" id="sbItemPanel" data-tooltip="Đăng bài">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Đăng bài</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgePanel" style="display:none"></span>
      </a>

      <!-- Mục 2: Quản lý tài khoản cá nhân -->
      <a href="${urlAccounts}" data-page="accounts.html" class="ntd-sb-item ${activeKey === 'accounts' ? 'active' : ''}" id="sbItemAccounts" data-tooltip="Quản lý tài khoản cá nhân">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Quản lý tài khoản</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeAccounts" style="display:none">0</span>
      </a>

      <!-- Mục 3: Nuôi tài khoản Facebook -->
      <a href="${urlWarmup}" data-page="warmup.html" class="ntd-sb-item ${activeKey === 'warmup' ? 'active' : ''}" id="sbItemWarmup" data-tooltip="Nuôi tài khoản Facebook (Tương tác tự động)">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Nuôi tài khoản</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeWarmup" style="display:none">Auto</span>
      </a>

      <!-- Mục 4: Quản lý Fanpage -->
      <a href="${urlFanpages}" data-page="fanpages.html" class="ntd-sb-item ${activeKey === 'fanpages' ? 'active' : ''}" id="sbItemFanpages" data-tooltip="Quản lý Fanpage">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
            <line x1="4" y1="22" x2="4" y2="15"></line>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Quản lý Fanpage</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeFanpages" style="display:none">0</span>
      </a>

      <!-- Mục 5: Quản lý danh sách nhóm -->
      <a href="${urlGroups}" data-page="groups.html" class="ntd-sb-item ${activeKey === 'groups' ? 'active' : ''}" id="sbItemGroups" data-tooltip="Quản lý nhóm">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Quản lý nhóm</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeGroups" style="display:none">0</span>
      </a>

      <!-- Mục 6: Quét data -->
      <a href="${urlMaps}" data-page="maps.html" class="ntd-sb-item ${activeKey === 'maps' ? 'active' : ''}" id="sbItemMaps" data-tooltip="Quét data">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Quét data</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeMaps" style="display:none">0</span>
      </a>

      <!-- Mục 7: Cài đặt -->
      <a href="${urlSettings}" data-page="settings.html" class="ntd-sb-item ${activeKey === 'settings' ? 'active' : ''}" id="sbItemSettings" data-tooltip="Cài đặt hệ thống">
        <div class="ntd-sb-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Cài đặt</span>
        </div>
        <span class="ntd-sb-item-badge" id="sbBadgeSettings" style="display:none"></span>
      </a>

      <!-- Mục 8: Quản trị & Phân quyền (CHỈ DÀNH CHO ADMIN) -->
      ${isAdmin ? `
      <a href="${urlManage}" data-page="manage.html" class="ntd-sb-item ${activeKey === 'manage' ? 'active' : ''}" id="sbItemManage" data-tooltip="Quản trị &amp; Phân quyền">
        <div class="ntd-sb-item-icon" style="color:#f97316">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          </svg>
        </div>
        <div class="ntd-sb-item-content">
          <span class="ntd-sb-item-title">Quản trị &amp; Phân quyền</span>
        </div>
        <span class="ntd-sb-item-badge" style="background:#ea580c;color:#fff;display:inline-block;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700">Admin</span>
      </a>
      ` : ''}
    </nav>

    <!-- Account & License Box (Cố định góc dưới thanh menu) -->
    <div class="ntd-sb-account-box" id="ntdSbAccountBox">
      <!-- 1. Tên tài khoản & Hạn sử dụng -->
      <div class="ntd-sb-user-card" id="ntdSbUserCard" data-tooltip="Tài khoản: ${username} • Hạn dùng: ${expiryFormatted} (${daysText})">
        <div class="ntd-sb-user-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        </div>
        <div class="ntd-sb-user-info">
          <div class="ntd-sb-user-name" id="ntdSbUsername" title="${username}">
            <span>${username}</span>
            ${isAdmin ? '<span style="font-size:9.5px;background:#ea580c;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-left:4px">Admin</span>' : '<span style="font-size:9.5px;background:rgba(255,255,255,0.1);color:#94a3b8;padding:1px 5px;border-radius:4px;margin-left:4px">Thành viên</span>'}
          </div>
          <div class="ntd-sb-user-expiry" id="ntdSbExpiry">
            <span class="ntd-sb-expiry-date">Hạn: ${expiryFormatted}</span>
            <span class="ntd-sb-days-pill ${daysLeft <= 7 ? 'warning' : ''}">${daysLeft > 0 ? `${daysLeft} ngày` : 'Hết hạn'}</span>
          </div>
        </div>
      </div>

      <!-- 2. Nút Đăng xuất (phía dưới phần tên tài khoản và hạn sử dụng) -->
      <button type="button" class="ntd-sb-logout-btn" id="ntdSbLogoutBtn" data-tooltip="Đăng xuất tài khoản">
        <svg class="ntd-sb-logout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
        <span class="ntd-sb-logout-text">Đăng xuất</span>
      </button>
    </div>

    <!-- Footer -->
    <div class="ntd-sb-footer">
      <span class="ntd-sb-version">NTD Agency</span>
      <div class="ntd-sb-status-indicator" title="Hệ thống sẵn sàng hoạt động">
        <span class="ntd-sb-pulse-dot"></span>
        <span class="ntd-sb-status-text">Online</span>
      </div>
    </div>
  </aside>
  `;

  // 6. Chèn vào DOM
  function mountSidebar() {
    if (document.getElementById('ntdRightSidebar') || document.getElementById('ntdSidebar')) return;

    // Chèn container vào cuối body
    const wrapper = document.createElement('div');
    wrapper.innerHTML = sidebarHtml;
    const sidebarEl = wrapper.firstElementChild;
    document.body.appendChild(sidebarEl);

    // Kích hoạt theme chuẩn xác ngay lập tức cho sidebar khi vừa xuất hiện
    applyTheme(localStorage.getItem('ntd_theme') || 'dark');
    mountThemeToggle();

    // Xử lý sự kiện bấm nút thu gọn / mở rộng
    const toggleBtn = document.getElementById('ntdSbToggleBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const nowCollapsed = document.body.classList.toggle('sidebar-collapsed');
        localStorage.setItem('ntd_sidebar_collapsed', nowCollapsed ? 'true' : 'false');
        const tipText = nowCollapsed ? 'Mở rộng menu' : 'Thu gọn menu';
        toggleBtn.setAttribute('data-tooltip', tipText);
        toggleBtn.title = tipText;
        const tooltip = document.getElementById('ntdSbFloatingTooltip');
        if (tooltip) tooltip.classList.remove('visible');
      });
    }

    // Khởi tạo tooltips khi rê chuột vào các nút
    initFloatingTooltips();

    // ── Xử lý chuyển trang trên cùng 1 tab mượt mà (không nhảy tab mới) ────────
    const navLinks = sidebarEl.querySelectorAll('a[data-page]');
    navLinks.forEach(link => {
      link.addEventListener('click', async (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;

        // BẮT BUỘC: Gọi e.preventDefault() đồng bộ ngay lập tức tại đầu hàm
        // để trình duyệt không kích hoạt điều hướng mặc định và không gây cảnh báo beforeunload
        e.preventDefault();

        const targetPage = link.getAttribute('data-page');
        if (!targetPage) return;

        const currentPath = window.location.pathname.toLowerCase();
        // 1. Nếu đang ở chính trang đó thì không làm gì (tránh reload làm gián đoạn việc đang chạy)
        if (currentPath.includes(targetPage.toLowerCase())) {
          return;
        }

        const targetUrl = chrome.runtime?.getURL ? chrome.runtime.getURL(targetPage) : targetPage;

        // Kiểm tra xem hiện tại có đang quét nhóm hay không (cả biến window cùng trang lẫn storage)
        const isScanningHere = Boolean(window.__ntdGroupScanning);
        const { isGroupScanning } = await chrome.storage.local.get('isGroupScanning').catch(() => ({}));
        const scanningActive = isScanningHere || Boolean(isGroupScanning);

        // TRƯỜNG HỢP 1: Trang hiện tại là groups.html VÀ đang có tiến trình quét nhóm chạy:
        // -> Giữ nguyên tab groups.html tiếp tục quét ngầm, chuyển sang tab mới (hoặc tab đã mở) để làm việc song song!
        if (currentPath.includes('groups.html') && scanningActive) {
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const existingTab = allTabs.find(t => t.url && t.url.includes(targetPage.toLowerCase()));
          if (existingTab) {
            await chrome.tabs.update(existingTab.id, { active: true });
            if (existingTab.windowId) {
              await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
            }
          } else {
            await chrome.tabs.create({ url: targetUrl, active: true });
          }
          return;
        }

        // TRƯỜNG HỢP 2: Chuyển từ trang khác sang groups.html và groups.html đang quét ở một tab khác:
        // -> Chuyển focus đến đúng tab groups.html đó thay vì mở đè làm gián đoạn
        if (targetPage.toLowerCase().includes('groups.html') && scanningActive) {
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const existingGroupsTab = allTabs.find(t => t.url && t.url.includes('groups.html'));
          if (existingGroupsTab) {
            await chrome.tabs.update(existingGroupsTab.id, { active: true });
            if (existingGroupsTab.windowId) {
              await chrome.windows.update(existingGroupsTab.windowId, { focused: true }).catch(() => {});
            }
            return;
          }
        }

        // Cập nhật trạng thái active ngay trên menu để phản hồi thị giác tức thì
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');

        // TRƯỜNG HỢP 3: Bình thường không quét: Chuyển trang trực tiếp trên cùng tab này
        window.location.href = targetUrl;
      });
    });

    // ── Xử lý Đăng xuất tài khoản từ thanh menu ──────────────────────────────
    const logoutBtn = sidebarEl.querySelector('#ntdSbLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm(`Bạn có chắc muốn đăng xuất tài khoản "${username}" khỏi thiết bị này?\nBạn sẽ cần nhập lại tài khoản & mật khẩu để sử dụng.`)) {
          return;
        }
        await logoutAccount();
        window.location.href = chrome.runtime?.getURL ? chrome.runtime.getURL('activate.html') : 'activate.html';
      });
    }

    function renderLicenseInfo(lic) {
      if (!lic || !lic.username) return;
      const uEl = document.getElementById('ntdSbUsername');
      const eEl = document.getElementById('ntdSbExpiry');
      const cardEl = document.getElementById('ntdSbUserCard');
      const expDate = new Date(lic.expiry);
      const days = lic.daysLeft !== undefined ? lic.daysLeft : Math.ceil((expDate - new Date()) / 86400000);
      const formatted = lic.expiryFormatted || expDate.toLocaleDateString('vi-VN');
      const dText = days > 0 ? `còn ${days} ngày` : 'Hết hạn';
      if (uEl) {
        uEl.textContent = lic.username;
        uEl.title = lic.username;
      }
      if (eEl) {
        eEl.innerHTML = `<span class="ntd-sb-expiry-date">Hạn: ${formatted}</span><span class="ntd-sb-days-pill ${days <= 7 ? 'warning' : ''}">${days > 0 ? `${days} ngày` : 'Hết hạn'}</span>`;
      }
      if (cardEl) {
        cardEl.setAttribute('data-tooltip', `Tài khoản: ${lic.username} • Hạn dùng: ${formatted} (${dText})`);
      }
    }

    // Lắng nghe cập nhật thông tin license theo thời gian thực
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.license && changes.license.newValue) {
          renderLicenseInfo(changes.license.newValue);
        }
      });
    }

    // Xử lý bấm vào card tài khoản để đồng bộ trực tiếp hạn dùng mới từ Google Sheets
    const userCard = sidebarEl.querySelector('#ntdSbUserCard');
    let isSyncingLicense = false;
    if (userCard) {
      userCard.style.cursor = 'pointer';
      userCard.title = 'Bấm để đồng bộ hạn dùng mới nhất từ Google Sheets';
      userCard.addEventListener('click', async () => {
        if (isSyncingLicense) return;
        const eEl = document.getElementById('ntdSbExpiry');
        if (!eEl) return;
        isSyncingLicense = true;
        const oldHtml = eEl.innerHTML;
        eEl.innerHTML = '<span style="font-size:11px;color:#f97316;font-weight:600">⏳ Đang đồng bộ...</span>';
        try {
          const updated = await checkCurrentLicense(true);
          if (updated && updated.expiry) {
            renderLicenseInfo(updated);
          } else {
            eEl.innerHTML = oldHtml;
          }
        } catch (_) {
          eEl.innerHTML = oldHtml;
        } finally {
          isSyncingLicense = false;
        }
      });
    }

    // Tự động kiểm tra và đồng bộ ngầm hạn dùng mới nhất từ Google Sheets ngay sau 500ms khi mở trang
    setTimeout(async () => {
      try {
        const updated = await checkCurrentLicense(false);
        if (updated && updated.expiry) {
          renderLicenseInfo(updated);
        }
      } catch (err) {
        console.warn('Lỗi kiểm tra license ngầm:', err);
      }
    }, 500);

    // Cập nhật số liệu badge ban đầu & lắng nghe thay đổi
    updateSidebarBadges();
  }

  // 7. Khởi tạo Floating Tooltip cho các nút trên menu
  function initFloatingTooltips() {
    let tooltip = document.getElementById('ntdSbFloatingTooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'ntdSbFloatingTooltip';
      tooltip.className = 'ntd-sb-floating-tooltip';
      document.body.appendChild(tooltip);
    }

    const targets = document.querySelectorAll('#ntdRightSidebar [data-tooltip], #ntdSidebar [data-tooltip]');
    targets.forEach(el => {
      el.addEventListener('mouseenter', () => {
        const text = el.getAttribute('data-tooltip');
        if (!text) return;

        tooltip.textContent = text;
        const rect = el.getBoundingClientRect();
        const top = rect.top + rect.height / 2;
        const left = rect.right + 10;

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
        tooltip.classList.add('visible');
      });

      el.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });

      el.addEventListener('click', () => {
        tooltip.classList.remove('visible');
      });
    });

    window.addEventListener('scroll', () => {
      if (tooltip) tooltip.classList.remove('visible');
    }, { passive: true });
  }

  // 8. Cập nhật các badge số lượng tài khoản cá nhân, Fanpage, nhóm và tiến trình đang chạy theo thời gian thực (Tối ưu hiệu năng cao với Debounce)
  let _badgeDebounceTimer = null;
  let _isUpdatingBadges = false;

  async function updateSidebarBadges() {
    if (!chrome?.storage?.local || _isUpdatingBadges) return;
    _isUpdatingBadges = true;

    try {
      const data = await chrome.storage.local.get([
        'accounts',
        'groupCategories',
        'campaigns',
        'coordinator',
        'rinMaps',
        'rinZalo',
        'warmupStatus',
        'isGroupScanning'
      ]);

      const allAccs = Array.isArray(data.accounts) ? data.accounts : [];
      const personalAccs = allAccs.filter(a => a.type !== 'fanpage');
      const fanpageAccs = allAccs.filter(a => a.type === 'fanpage');

      // Badge tài khoản cá nhân
      const badgeAccounts = document.getElementById('sbBadgeAccounts');
      if (badgeAccounts) {
        if (personalAccs.length > 0) {
          badgeAccounts.textContent = personalAccs.length;
          badgeAccounts.title = `${personalAccs.length} tài khoản cá nhân đã thêm`;
          badgeAccounts.style.display = 'inline-flex';
        } else {
          badgeAccounts.style.display = 'none';
        }
      }

      // Badge Nuôi tài khoản
      const badgeWarmup = document.getElementById('sbBadgeWarmup');
      if (badgeWarmup) {
        const isWarmupRunning = Boolean(data.warmupStatus?.running);
        if (isWarmupRunning) {
          badgeWarmup.innerHTML = '<span class="ntd-sb-pulse-dot" style="margin-right:2px"></span> Nuôi';
          badgeWarmup.title = 'Đang nuôi tài khoản tự động trong nền';
          badgeWarmup.style.display = 'inline-flex';
          badgeWarmup.style.background = '#fef3c7';
          badgeWarmup.style.color = '#b45309';
        } else if (personalAccs.length > 0) {
          badgeWarmup.textContent = 'Auto';
          badgeWarmup.title = `${personalAccs.length} tài khoản cá nhân sẵn sàng nuôi tương tác`;
          badgeWarmup.style.display = 'inline-flex';
          badgeWarmup.style.background = '';
          badgeWarmup.style.color = '';
        } else {
          badgeWarmup.style.display = 'none';
        }
      }

      // Badge Fanpage
      const badgeFanpages = document.getElementById('sbBadgeFanpages');
      if (badgeFanpages) {
        if (fanpageAccs.length > 0) {
          badgeFanpages.textContent = fanpageAccs.length;
          badgeFanpages.title = `${fanpageAccs.length} Fanpage đã thêm (tối đa 5 bài/ngày)`;
          badgeFanpages.style.display = 'inline-flex';
        } else {
          badgeFanpages.style.display = 'none';
        }
      }

      // Badge nhóm / danh mục
      const badgeGroups = document.getElementById('sbBadgeGroups');
      if (badgeGroups) {
        if (data.isGroupScanning) {
          badgeGroups.innerHTML = `<span class="ntd-sb-pulse-dot" style="margin-right:2px"></span> Quét`;
          badgeGroups.title = 'Đang quét link nhóm song song trong hệ thống';
          badgeGroups.style.display = 'inline-flex';
          badgeGroups.style.background = '#fef3c7';
          badgeGroups.style.color = '#b45309';
        } else {
          const cats = Array.isArray(data.groupCategories) ? data.groupCategories : [];
          let totalGroups = 0;
          cats.forEach(c => {
            if (Array.isArray(c.groups)) totalGroups += c.groups.length;
          });

          if (cats.length > 0) {
            badgeGroups.textContent = `${cats.length} mục`;
            badgeGroups.title = `${cats.length} danh mục (${totalGroups} link nhóm)`;
            badgeGroups.style.display = 'inline-flex';
            badgeGroups.style.background = '';
            badgeGroups.style.color = '';
          } else {
            badgeGroups.style.display = 'none';
          }
        }
      }

      // Badge quét số Google Maps
      const badgeMaps = document.getElementById('sbBadgeMaps');
      if (badgeMaps) {
        const mapRows = Array.isArray(data.rinMaps?.rows) ? data.rinMaps.rows : [];
        const phoneCount = mapRows.filter(r => r.phone && r.phone.trim()).length;
        const isMapsScanning = Boolean(data.rinMaps?.isScanning || data.rinMaps?.job);

        if (isMapsScanning) {
          badgeMaps.innerHTML = `<span class="ntd-sb-pulse-dot" style="margin-right:2px"></span> ${phoneCount > 0 ? phoneCount : 'Quét'}`;
          badgeMaps.title = `Đang quét song song: ${phoneCount} SĐT (${mapRows.length} cơ sở)`;
          badgeMaps.style.display = 'inline-flex';
          badgeMaps.style.background = '#fef3c7';
          badgeMaps.style.color = '#b45309';
        } else if (mapRows.length > 0) {
          badgeMaps.textContent = phoneCount > 0 ? `${phoneCount} SĐT` : `${mapRows.length}`;
          badgeMaps.title = `${mapRows.length} cơ sở đã quét (${phoneCount} có số điện thoại)`;
          badgeMaps.style.display = 'inline-flex';
          badgeMaps.style.background = '';
          badgeMaps.style.color = '';
        } else {
          badgeMaps.style.display = 'none';
        }
      }

      // Badge chiến dịch đăng bài (hiển thị trạng thái đang chạy)
      const badgePanel = document.getElementById('sbBadgePanel');
      if (badgePanel) {
        let isRunning = false;
        if (data.coordinator && data.coordinator.status === 'running') {
          isRunning = true;
        } else if (data.campaigns) {
          for (const key of Object.keys(data.campaigns)) {
            if (data.campaigns[key]?.state === 'running') {
              isRunning = true;
              break;
            }
          }
        }

        if (isRunning) {
          badgePanel.innerHTML = '<span class="ntd-sb-pulse-dot" style="margin-right:2px"></span> Chạy';
          badgePanel.style.display = 'inline-flex';
          badgePanel.style.background = '#dcfce7';
          badgePanel.style.color = '#15803d';
        } else {
          badgePanel.style.display = 'none';
        }
      }

      // Badge cài đặt (Zalo đang bật)
      const badgeSettings = document.getElementById('sbBadgeSettings');
      if (badgeSettings) {
        if (data.rinZalo?.enabled && data.rinZalo?.chat) {
          const isDark = document.body.classList.contains('ntd-dark-theme');
          badgeSettings.textContent = 'Zalo ON';
          badgeSettings.title = 'Đang bật nhận thông báo Zalo cá nhân';
          badgeSettings.style.display = 'inline-flex';
          badgeSettings.style.background = isDark ? 'rgba(37, 99, 235, 0.22)' : '#eff6ff';
          badgeSettings.style.color = isDark ? '#93c5fd' : '#1d4ed8';
          badgeSettings.style.borderColor = isDark ? 'rgba(59, 130, 246, 0.4)' : '#bfdbfe';
        } else {
          badgeSettings.style.display = 'none';
        }
      }
    } catch (err) {
      console.warn('Lỗi cập nhật badge sidebar:', err);
    } finally {
      _isUpdatingBadges = false;
    }
  }

  // Lắng nghe thay đổi dữ liệu từ extension để cập nhật badge ngay lập tức (Debounced 300ms)
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.accounts || changes.groupCategories || changes.campaigns || changes.coordinator || changes.rinMaps || changes.rinZalo || changes.warmupStatus || changes.isGroupScanning) {
          if (_badgeDebounceTimer) clearTimeout(_badgeDebounceTimer);
          _badgeDebounceTimer = setTimeout(updateSidebarBadges, 300);
        }
      }
    });
  }

  // Giữ Background Service Worker luôn hoạt động liên tục khi có bất kỳ trang nào của tiện ích đang mở
  function maintainWorkerKeepAlive() {
    let port = null;
    let pingInterval = null;
    function connect() {
      try {
        if (!chrome?.runtime?.connect) return;
        if (pingInterval) clearInterval(pingInterval);
        port = chrome.runtime.connect({ name: 'keepAliveWorker' });
        port.onDisconnect.addListener(() => {
          if (pingInterval) clearInterval(pingInterval);
          setTimeout(connect, 1500);
        });
        pingInterval = setInterval(() => {
          try { port?.postMessage({ type: 'PING' }); } catch (_) {}
        }, 25000);
      } catch (_) {}
    }
    connect();
  }
  maintainWorkerKeepAlive();

  // ── 9. [TELEMETRY] Tự động đồng bộ số liệu hoạt động lên Supabase cho Admin Dashboard ──
  let _lastTelemetryReport = 0;
  async function reportUserActivity() {
    try {
      const now = Date.now();
      // Giới hạn tần suất: Tối đa 1 lần mỗi 20 giây để không gây nghẽn mạng
      if (now - _lastTelemetryReport < 20000) return;
      _lastTelemetryReport = now;

      const lic = activeLicense || JSON.parse(localStorage.getItem('ntd_store_license') || 'null');
      const username = (lic?.username || '').trim();
      if (!username) return;

      let data = {};
      if (chrome?.storage?.local) {
        data = await chrome.storage.local.get([
          'accounts',
          'dailyPostStats',
          'rinFbGroup',
          'rinMaps'
        ]);
      } else {
        try {
          data = {
            accounts: JSON.parse(localStorage.getItem('accounts') || '[]'),
            dailyPostStats: JSON.parse(localStorage.getItem('dailyPostStats') || '{}'),
            rinFbGroup: JSON.parse(localStorage.getItem('rinFbGroup') || '{}'),
            rinMaps: JSON.parse(localStorage.getItem('rinMaps') || '{}')
          };
        } catch (_) {}
      }

      const allAccs = Array.isArray(data.accounts) ? data.accounts : [];
      const fbCount = allAccs.filter(a => a.type !== 'fanpage').length;
      const fanpageCount = allAccs.filter(a => a.type === 'fanpage').length;

      // Tính tổng bài đăng hôm nay theo giờ địa phương (YYYY-MM-DD)
      const todayDate = new Date();
      const y = todayDate.getFullYear();
      const m = String(todayDate.getMonth() + 1).padStart(2, '0');
      const d = String(todayDate.getDate()).padStart(2, '0');
      const todayStr = `${y}-${m}-${d}`;

      let todayPosts = 0;
      const statsMap = data.dailyPostStats || {};
      for (const k of Object.keys(statsMap)) {
        if (statsMap[k] && statsMap[k].date === todayStr) {
          todayPosts += Number(statsMap[k].count) || 0;
        }
      }

      // Quét số nhóm hôm nay (tính theo số điện thoại / bài viết quét được trong ngày)
      let todayGroupScans = 0;
      const groupRows = Array.isArray(data.rinFbGroup?.rows) ? data.rinFbGroup.rows : [];
      if (groupRows.length > 0) {
        const startOfDay = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()).getTime();
        const todayVi = todayDate.toLocaleDateString('vi-VN');
        const matched = groupRows.filter(r => {
          if (r.id && r.id.startsWith('fg_')) {
            const ts = Number(r.id.split('_')[1]);
            if (!isNaN(ts) && ts >= startOfDay) return true;
          }
          if (r.at && (r.at.includes(todayVi) || r.at.includes(todayStr))) return true;
          return false;
        }).length;
        todayGroupScans = matched > 0 ? matched : groupRows.length;
      }

      // Quét Google Maps hôm nay
      const mapRows = Array.isArray(data.rinMaps?.rows) ? data.rinMaps.rows : [];
      const todayMapsScans = mapRows.length;

      // Gửi lên Supabase
      await supabaseUpdateUserStats(username, {
        fb_count: fbCount,
        fanpage_count: fanpageCount,
        today_posts: todayPosts,
        today_group_scans: todayGroupScans,
        today_maps_scans: todayMapsScans
      });
    } catch (err) {
      // Bỏ qua lỗi âm thầm để không ảnh hưởng luồng công việc của khách hàng
      console.warn('Telemetry update ignored:', err);
    }
  }

  // Tự động gửi telemetry sau khi mở trang 2.5 giây
  setTimeout(() => {
    reportUserActivity().catch(() => {});
  }, 2500);

  // Lắng nghe thay đổi dữ liệu để gửi telemetry (Debounced 5s)
  if (chrome?.storage?.onChanged) {
    let _telemetryTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.accounts || changes.dailyPostStats || changes.rinFbGroup || changes.rinMaps)) {
        if (_telemetryTimer) clearTimeout(_telemetryTimer);
        _telemetryTimer = setTimeout(() => {
          reportUserActivity().catch(() => {});
        }, 5000);
      }
    });
  }

  // Khởi động khi DOM sẵn sàng
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSidebar);
  } else {
    mountSidebar();
  }
})();
