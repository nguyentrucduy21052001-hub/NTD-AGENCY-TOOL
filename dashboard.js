/**
 * NTD Agency - Activity & Telemetry Dashboard Controller (dashboard.js)
 * Giám sát hoạt động của toàn bộ tài khoản khách hàng trên hệ thống.
 */

import { checkCurrentLicense } from './license.js';
import { supabaseListUsers } from './supabase.js?v=20261112_1000';

const $ = id => document.getElementById(id);

let cachedUsers = [];
let activeFilter = 'all';
let searchQuery = '';

// ── 1. ACCESS GUARD (CHỈ DÀNH CHO ADMIN) ─────────────────────────────────────
async function enforceAdminAccess() {
  const license = await checkCurrentLicense(false);
  const isAdmin = (license?.role || '').toLowerCase() === 'admin';

  if (!license || !isAdmin) {
    const alertBox = $('unauthorizedAlert');
    const mainBox = $('dashboardMainContent');
    if (alertBox) alertBox.style.display = 'block';
    if (mainBox) mainBox.style.display = 'none';

    setTimeout(() => {
      window.location.replace('panel.html');
    }, 2500);
    return false;
  }

  const mainBox = $('dashboardMainContent');
  if (mainBox) mainBox.style.display = 'block';
  return true;
}

// ── 2. HELPER FORMAT RELATIVE TIME ──────────────────────────────────────────
function formatRelativeTime(dateString) {
  if (!dateString) return { display: 'Chưa đăng nhập', sub: 'Chưa có hoạt động' };
  
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return { display: 'Không rõ', sub: '' };

  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  const formattedExact = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString('vi-VN');

  let relative = '';
  if (diffSec < 60) {
    relative = 'Vừa xong';
  } else if (diffMin < 60) {
    relative = `${diffMin} phút trước`;
  } else if (diffHours < 24) {
    relative = `${diffHours} giờ trước`;
  } else if (diffDays <= 30) {
    relative = `${diffDays} ngày trước`;
  } else {
    relative = date.toLocaleDateString('vi-VN');
  }

  return { display: formattedExact, sub: relative, isToday: diffHours < 24 };
}

// ── 3. TÍNH TOÁN VÀ HIỂN THỊ KPI SUMMARY ──────────────────────────────────────
function renderKpiCards(users) {
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.status === 'active' && !u.isExpired).length;

  let totalFb = 0;
  let totalFanpages = 0;
  let todayPosts = 0;
  let groupScans = 0;
  let mapsScans = 0;

  users.forEach(u => {
    totalFb += Number(u.fbCount) || 0;
    totalFanpages += Number(u.fanpageCount) || 0;
    todayPosts += Number(u.todayPosts) || 0;
    groupScans += Number(u.todayGroupScans) || 0;
    mapsScans += Number(u.todayMapsScans) || 0;
  });

  if ($('kpiActiveUsers')) $('kpiActiveUsers').textContent = activeUsers;
  if ($('kpiTotalUsers')) $('kpiTotalUsers').textContent = totalUsers;
  if ($('kpiTotalFb')) $('kpiTotalFb').textContent = totalFb.toLocaleString('vi-VN');
  if ($('kpiTotalFanpages')) $('kpiTotalFanpages').textContent = totalFanpages.toLocaleString('vi-VN');
  if ($('kpiTodayPosts')) $('kpiTodayPosts').textContent = todayPosts.toLocaleString('vi-VN');
  if ($('kpiGroupScans')) $('kpiGroupScans').textContent = groupScans.toLocaleString('vi-VN');
  if ($('kpiMapsScans')) $('kpiMapsScans').textContent = mapsScans.toLocaleString('vi-VN');
}

// ── 4. RENDER BẢNG HOẠT ĐỘNG ────────────────────────────────────────────────
function filterUsersList(users) {
  const q = (searchQuery || '').trim().toLowerCase();

  return users.filter(u => {
    // 1. Lọc theo từ khóa tìm kiếm (tên tài khoản hoặc ghi chú)
    if (q) {
      const matchName = (u.username || '').toLowerCase().includes(q);
      const matchNote = (u.note || '').toLowerCase().includes(q);
      if (!matchName && !matchNote) return false;
    }

    // 2. Lọc theo pills
    if (activeFilter === 'active-today') {
      if (!u.rawLastLogin) return false;
      const d = new Date(u.rawLastLogin);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    }
    if (activeFilter === 'has-fb') {
      return (Number(u.fbCount) || 0) > 0;
    }
    if (activeFilter === 'has-posts') {
      return (Number(u.todayPosts) || 0) > 0;
    }
    if (activeFilter === 'has-scans') {
      return (Number(u.todayGroupScans) || 0) > 0 || (Number(u.todayMapsScans) || 0) > 0;
    }
    if (activeFilter === 'admin') {
      return u.role === 'admin';
    }
    if (activeFilter === 'member') {
      return u.role !== 'admin';
    }

    return true;
  });
}

function renderTable() {
  const tbody = $('activityTableBody');
  if (!tbody) return;

  const filtered = filterUsersList(cachedUsers);

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:36px;color:var(--text-sub)">
          Không tìm thấy tài khoản nào phù hợp với bộ lọc hiện tại.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((u, idx) => {
    const isAdmin = u.role === 'admin';
    const firstLetter = (u.username || 'U').charAt(0).toUpperCase();
    const loginInfo = formatRelativeTime(u.rawLastLogin);

    // Tính trạng thái tài khoản
    let statusBadge = '';
    if (u.status === 'locked') {
      statusBadge = '<span class="status-pill expired"><span class="pulse-dot-red"></span> Đã khóa</span>';
    } else if (u.isExpired) {
      statusBadge = '<span class="status-pill expired"><span class="pulse-dot-red"></span> Hết hạn</span>';
    } else {
      statusBadge = '<span class="status-pill active"><span class="pulse-dot-green"></span> Đang hoạt động</span>';
    }

    // Badge Nick FB
    const fbCount = Number(u.fbCount) || 0;
    const fbBadge = fbCount > 0 
      ? `<span class="metric-badge badge-blue" title="${fbCount} nick Facebook cá nhân">${fbCount} nick</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    // Badge Fanpage
    const fpCount = Number(u.fanpageCount) || 0;
    const fpBadge = fpCount > 0
      ? `<span class="metric-badge badge-purple" title="${fpCount} Fanpage vệ tinh">${fpCount} page</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    // Badge Bài đăng hôm nay
    const postCount = Number(u.todayPosts) || 0;
    const postBadge = postCount > 0
      ? `<span class="metric-badge badge-green" title="${postCount} bài đã đăng thành công hôm nay">🚀 ${postCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    // Badge Quét số nhóm
    const groupCount = Number(u.todayGroupScans) || 0;
    const groupBadge = groupCount > 0
      ? `<span class="metric-badge badge-orange" title="${groupCount} SĐT / dữ liệu quét từ nhóm hôm nay">📞 ${groupCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    // Badge Quét Maps
    const mapsCount = Number(u.todayMapsScans) || 0;
    const mapsBadge = mapsCount > 0
      ? `<span class="metric-badge badge-orange" title="${mapsCount} cơ sở doanh nghiệp quét từ Maps hôm nay">🗺️ ${mapsCount}</span>`
      : `<span class="metric-badge badge-zero">0</span>`;

    return `
      <tr>
        <td style="text-align:center;color:var(--text-sub);font-weight:700">${idx + 1}</td>
        <td>
          <div class="user-cell">
            <div class="user-avatar-circle">${firstLetter}</div>
            <div>
              <div class="user-name-title">
                <span>${escapeHtml(u.username)}</span>
                ${isAdmin ? '<span class="tag-admin">Admin</span>' : '<span class="tag-member">Member</span>'}
              </div>
              <div class="user-note-sub">${escapeHtml(u.note || 'Không có ghi chú')}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center">${fbBadge}</td>
        <td style="text-align:center">${fpBadge}</td>
        <td style="text-align:center">${postBadge}</td>
        <td style="text-align:center">${groupBadge}</td>
        <td style="text-align:center">${mapsBadge}</td>
        <td>
          <div style="font-weight:600">${loginInfo.display}</div>
          <div class="relative-time" style="color:${loginInfo.isToday ? '#34d399' : 'var(--text-sub)'}">${loginInfo.sub}</div>
        </td>
        <td>
          <div style="font-weight:600;margin-bottom:3px">${u.expiry || '--/--/----'}</div>
          <div>${statusBadge}</div>
        </td>
        <td style="text-align:right">
          <a href="manage.html" class="btn-secondary-dash" style="font-size:11.5px;padding:4px 8px" title="Quản trị hoặc gia hạn tài khoản này trong Quản trị">
            Quản trị &rarr;
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── 5. TẢI DỮ LIỆU TỪ SUPABASE ───────────────────────────────────────────────
async function loadDashboardData() {
  const tbody = $('activityTableBody');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="table-loading">
          <div class="dash-spinner"></div>
          <div>Đang tải dữ liệu hoạt động từ Supabase...</div>
        </td>
      </tr>
    `;
  }

  try {
    const users = await supabaseListUsers();
    cachedUsers = users || [];
    renderKpiCards(cachedUsers);
    renderTable();
  } catch (err) {
    console.error('Lỗi nạp dashboard:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align:center;padding:36px;color:#ef4444">
            ⚠️ Không thể kết nối với cơ sở dữ liệu Supabase: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }
}

// ── 6. XUẤT BÁO CÁO CSV ──────────────────────────────────────────────────────
function exportToCsv() {
  if (!cachedUsers || cachedUsers.length === 0) {
    alert('Không có dữ liệu để xuất file.');
    return;
  }

  const filtered = filterUsersList(cachedUsers);
  const headers = [
    'STT',
    'Tên tài khoản',
    'Vai trò',
    'Ghi chú',
    'Nick FB cá nhân',
    'Fanpage',
    'Bài đăng hôm nay',
    'Quét số nhóm hôm nay',
    'Quét Maps hôm nay',
    'Đăng nhập cuối',
    'Hạn sử dụng',
    'Trạng thái'
  ];

  const rows = filtered.map((u, i) => [
    i + 1,
    `"${(u.username || '').replace(/"/g, '""')}"`,
    u.role || 'member',
    `"${(u.note || '').replace(/"/g, '""')}"`,
    Number(u.fbCount) || 0,
    Number(u.fanpageCount) || 0,
    Number(u.todayPosts) || 0,
    Number(u.todayGroupScans) || 0,
    Number(u.todayMapsScans) || 0,
    `"${u.lastLogin || ''}"`,
    u.expiry || '',
    u.status || 'active'
  ]);

  const csvContent = '\uFEFF' + [
    headers.join(','),
    ...rows.map(r => r.join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const nowStr = new Date().toISOString().slice(0, 10);
  a.download = `Bao_cao_hoat_dong_NTD_Agency_${nowStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 7. KHỞI CHẠY CONTROLLER ──────────────────────────────────────────────────
async function initDashboard() {
  const hasAccess = await enforceAdminAccess();
  if (!hasAccess) return;

  // Gắn sự kiện nút làm mới
  $('refreshBtn')?.addEventListener('click', () => {
    loadDashboardData();
  });

  // Gắn sự kiện xuất CSV
  $('exportCsvBtn')?.addEventListener('click', () => {
    exportToCsv();
  });

  // Gắn sự kiện ô tìm kiếm
  $('userSearchInput')?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderTable();
  });

  // Gắn sự kiện các nút lọc (filter pills)
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter') || 'all';
      renderTable();
    });
  });

  // Nạp dữ liệu lần đầu
  await loadDashboardData();
}

// Chạy khi trang sẵn sàng
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  initDashboard();
}

