/**
 * NTD Agency - Theme Toggle Component
 * Quản lý chế độ Ban ngày (Light Mode) / Ban đêm (Dark Mode)
 * Cung cấp nút bấm chuyển đổi cố định ở góc trên bên phải màn hình:
 * - Ban ngày: Icon mặt trời ☀️
 * - Ban đêm: Icon mặt trăng 🌙
 */

export function getCurrentTheme() {
  try {
    const saved = localStorage.getItem('ntd_theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (_) {}
  return 'dark'; // Mặc định dark theme cao cấp
}

export function applyTheme(theme) {
  const isDark = theme === 'dark';

  // 1. Cập nhật thẻ HTML và Body
  if (isDark) {
    document.documentElement.classList.add('ntd-dark-theme');
    document.documentElement.style.backgroundColor = '#070b14';
    document.documentElement.style.colorScheme = 'dark';
    if (document.body) {
      document.body.classList.add('ntd-dark-theme');
      document.body.style.backgroundColor = '#070b14';
    }
  } else {
    document.documentElement.classList.remove('ntd-dark-theme');
    document.documentElement.style.backgroundColor = '#f3f5fa';
    document.documentElement.style.colorScheme = 'light';
    if (document.body) {
      document.body.classList.remove('ntd-dark-theme');
      document.body.style.backgroundColor = '';
    }
  }

  // 2. Cập nhật Sidebar nếu có
  const sb = document.getElementById('ntdRightSidebar') || document.getElementById('ntdSidebar');
  if (sb) {
    sb.classList.toggle('theme-dark', isDark);
  }

  // 3. Cập nhật các Tab cấu hình trên panel.html nếu có
  const tabShared = document.getElementById('tabModeShared');
  const tabCat = document.getElementById('tabModeCategories');
  if (tabShared && tabCat) {
    const isSharedActive = tabShared.classList.contains('active');
    if (isDark) {
      tabShared.style.background = '';
      tabShared.style.color = '';
      tabCat.style.background = '';
      tabCat.style.color = '';
    } else {
      const inactiveBg = '#f1f5f9';
      const inactiveColor = '#475569';
      if (isSharedActive) {
        tabShared.style.background = '#ed6b22';
        tabShared.style.color = '#fff';
        tabCat.style.background = inactiveBg;
        tabCat.style.color = inactiveColor;
      } else {
        tabCat.style.background = '#ed6b22';
        tabCat.style.color = '#fff';
        tabShared.style.background = inactiveBg;
        tabShared.style.color = inactiveColor;
      }
    }
  }

  // 4. Cập nhật giao diện nút bấm chuyển đổi ở góc trên bên phải
  updateToggleButtonUI(isDark);

  // 5. Phát sự kiện toàn cục để các component khác lắng nghe
  try {
    window.dispatchEvent(new CustomEvent('ntd-theme-changed', { detail: { theme, isDark } }));
  } catch (_) {}
}

export function setTheme(isDark) {
  const themeName = isDark ? 'dark' : 'light';
  try {
    localStorage.setItem('ntd_theme', themeName);
  } catch (_) {}

  if (chrome?.storage?.local) {
    chrome.storage.local.set({ ntdDarkMode: isDark });
  }

  applyTheme(themeName);
}

export function toggleTheme() {
  const current = getCurrentTheme();
  const nextIsDark = current !== 'dark';
  setTheme(nextIsDark);
  return nextIsDark ? 'dark' : 'light';
}

function updateToggleButtonUI(isDark) {
  const btn = document.getElementById('ntdThemeToggleBtn');
  if (!btn) return;

  btn.classList.toggle('is-dark', isDark);
  btn.classList.toggle('is-light', !isDark);

  const label = btn.querySelector('.ntd-tt-label');
  if (label) {
    label.textContent = isDark ? 'Ban đêm' : 'Ban ngày';
  }

  const tooltipText = isDark
    ? 'Đang ở Chế độ Ban đêm • Bấm để chuyển sang Ban ngày'
    : 'Đang ở Chế độ Ban ngày • Bấm để chuyển sang Ban đêm';
  btn.setAttribute('data-tooltip', tooltipText);
  btn.setAttribute('title', tooltipText);
  btn.setAttribute('aria-label', tooltipText);
}

/**
 * Gắn nút chuyển đổi Ngày / Đêm vào góc trên bên phải màn hình
 */

export function mountThemeToggle() {
  if (document.getElementById('ntdThemeToggleBtn')) {
    updateToggleButtonUI(getCurrentTheme() === 'dark');
    return;
  }

  if (!document.body) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountThemeToggle);
    } else {
      setTimeout(mountThemeToggle, 50);
    }
    return;
  }

  const isDark = getCurrentTheme() === 'dark';
  const tooltipText = isDark
    ? 'Đang ở Chế độ Ban đêm • Bấm để chuyển sang Ban ngày'
    : 'Đang ở Chế độ Ban ngày • Bấm để chuyển sang Ban đêm';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'ntdThemeToggleBtn';
  btn.className = `ntd-theme-toggle-btn ${isDark ? 'is-dark' : 'is-light'}`;
  btn.setAttribute('data-tooltip', tooltipText);
  btn.setAttribute('title', tooltipText);
  btn.setAttribute('aria-label', tooltipText);

  btn.innerHTML = `
    <div class="ntd-tt-icon-wrap" aria-hidden="true">
      <!-- Icon Mặt trời (Ban ngày) -->
      <svg class="ntd-tt-icon ntd-tt-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>
      <!-- Icon Mặt trăng (Ban đêm) -->
      <svg class="ntd-tt-icon ntd-tt-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    </div>
    <span class="ntd-tt-label">${isDark ? 'Ban đêm' : 'Ban ngày'}</span>
    <div class="ntd-tt-switch" aria-hidden="true">
      <div class="ntd-tt-switch-thumb"></div>
    </div>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTheme();
  });

  document.body.appendChild(btn);

  // Đảm bảo trạng thái ban đầu được đồng bộ
  updateToggleButtonUI(isDark);
}

// Tự động lắng nghe thay đổi theme từ các tab/cửa sổ khác
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'ntd_theme' && e.newValue) {
      applyTheme(e.newValue);
    }
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.ntdDarkMode !== undefined) {
        const theme = changes.ntdDarkMode.newValue ? 'dark' : 'light';
        try {
          localStorage.setItem('ntd_theme', theme);
        } catch (_) {}
        applyTheme(theme);
      }
    });
  }

  // Đăng ký toàn cục
  window.applyNtdTheme = applyTheme;
  window.toggleNtdTheme = toggleTheme;
  window.mountNtdThemeToggle = mountThemeToggle;
}
