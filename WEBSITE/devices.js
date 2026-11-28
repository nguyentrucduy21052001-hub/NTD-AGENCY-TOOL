/**
 * NTD Agency - Devices Management & Remote Hub Controller (devices.js)
 */

import { checkCurrentLicense } from './license.js';
import { remoteController } from './remote_controller.js';
import {
  supabaseListDevices,
  supabaseListRemoteTasks,
  supabaseSendRemoteCommand,
  supabaseCancelRemoteTask,
  supabaseGetTaskLogs,
  supabaseUpdateDevice
} from './supabase.js';

let currentUser = null;
let pollTimer = null;

const $ = id => document.getElementById(id);

async function initPage() {
  const lic = await checkCurrentLicense();
  if (!lic || !lic.username) {
    alert('Vui lòng đăng nhập để quản lý thiết bị.');
    window.location.href = 'activate.html';
    return;
  }
  currentUser = lic.username.trim().toLowerCase();
  await remoteController.init(currentUser);

  bindEvents();
  await refreshData();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshData, 6000);
}

function bindEvents() {
  $('btnRefreshAll')?.addEventListener('click', async () => {
    $('btnRefreshAll').textContent = '⏳ Đang làm mới...';
    await refreshData();
    $('btnRefreshAll').textContent = '🔄 Làm mới dữ liệu';
  });

  $('btnStopAllGlobal')?.addEventListener('click', async () => {
    if (!confirm('Dừng toàn bộ tác vụ trên tất cả các máy tính của bạn?')) return;
    await remoteController.stopAllOnDevice('auto');
    alert('✅ Đã gửi lệnh dừng tới toàn bộ máy tính.');
    await refreshData();
  });

  $('btnClearLogsView')?.addEventListener('click', () => {
    const logBox = $('liveLogsContainer');
    if (logBox) logBox.innerHTML = '<div style="color:#64748b;font-style:italic">Đã dọn sạch màn hình log.</div>';
  });
}

async function refreshData() {
  if (!currentUser) return;

  try {
    const [devices, tasks] = await Promise.all([
      supabaseListDevices(currentUser),
      supabaseListRemoteTasks(currentUser, { limit: 20 })
    ]);

    renderKPIs(devices, tasks);
    renderDevicesTable(devices);
    renderTasksTable(tasks);

    // Lấy log từ task đang chạy gần nhất nếu có (ưu tiên task đang running)
    const runningTask = tasks.find(t => t.status === 'running') || tasks.find(t => t.status === 'pending') || tasks[0];
    if (runningTask) {
      const logs = await supabaseGetTaskLogs(runningTask.id, 25);
      renderLiveLogs(logs, runningTask);
    }
  } catch (err) {
    console.warn('[Devices] Lỗi làm mới dữ liệu:', err.message);
  }
}

function renderKPIs(devices, tasks) {
  const onlineDevs = devices.filter(d => d.isOnline);
  const runningDevs = devices.filter(d => d.isOnline && d.status === 'running');
  const completedTasks = tasks.filter(t => t.status === 'completed');

  if ($('kpiTotalDevices')) $('kpiTotalDevices').textContent = devices.length;
  if ($('kpiOnlineDevices')) $('kpiOnlineDevices').textContent = onlineDevs.length;
  if ($('kpiRunningDevices')) $('kpiRunningDevices').textContent = runningDevs.length;
  if ($('kpiCompletedTasks')) $('kpiCompletedTasks').textContent = completedTasks.length;
}

function renderDevicesTable(devices) {
  const tbody = $('devicesTableBody');
  if (!tbody) return;

  if (!devices || devices.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center;padding:32px;color:#94a3b8">
          Chưa có máy tính nào được kết nối.<br>
          <span style="font-size:12px;color:#64748b">Hãy mở Chrome trên máy tính có cài Extension NTD Agency và đăng nhập tài khoản của bạn để máy tính tự động ghép nối.</span>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = devices.map((dev, idx) => {
    const isOnline = dev.isOnline;
    const isRunning = dev.status === 'running';
    const statusPillClass = isOnline ? (isRunning ? 'running' : 'online') : 'offline';
    const statusText = isOnline ? (isRunning ? '🟡 Đang chạy tác vụ' : '🟢 Online / Rảnh') : '⚪ Offline';

    const diffText = dev.secondsSinceHeartbeat < 60
      ? `${dev.secondsSinceHeartbeat} giây trước`
      : `${Math.round(dev.secondsSinceHeartbeat / 60)} phút trước`;

    return `
      <tr>
        <td style="color:#64748b;font-weight:700">${idx + 1}</td>
        <td>
          <div style="font-weight:800;color:#f8fafc;display:flex;align-items:center;gap:6px">
            ${escapeHtml(dev.device_name)}
            <button type="button" class="btn-act rename-dev-btn" data-id="${dev.id}" data-name="${escapeHtml(dev.device_name)}" style="padding:2px 6px;font-size:11px" title="Đổi tên máy tính">✏️</button>
          </div>
        </td>
        <td><code style="color:#38bdf8;font-size:12px">${dev.id.slice(0, 12)}...</code></td>
        <td><span style="color:#94a3b8;font-size:12px">v${escapeHtml(dev.ext_version || '0.4.4')}</span></td>
        <td><span class="status-pill ${statusPillClass}">${statusText}</span></td>
        <td><span style="color:#94a3b8;font-size:12px">${diffText}</span></td>
        <td><span style="color:#cbd5e1;font-size:12px">${dev.current_task_id ? `Task #${dev.current_task_id.slice(0, 8)}` : 'Không có'}</span></td>
        <td>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn-act danger stop-dev-btn" data-id="${dev.id}" style="font-size:11.5px;padding:4px 8px">⏹ Dừng máy</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện đổi tên máy
  tbody.querySelectorAll('.rename-dev-btn').forEach(btn => {
    btn.onclick = async () => {
      const devId = btn.getAttribute('data-id');
      const curName = btn.getAttribute('data-name');
      const newName = prompt('Nhập tên mới cho máy tính:', curName);
      if (newName && newName.trim() && newName.trim() !== curName) {
        await supabaseUpdateDevice(devId, { device_name: newName.trim() });
        await refreshData();
      }
    };
  });

  // Gắn sự kiện dừng máy
  tbody.querySelectorAll('.stop-dev-btn').forEach(btn => {
    btn.onclick = async () => {
      const devId = btn.getAttribute('data-id');
      if (!confirm(`Dừng toàn bộ tác vụ trên máy tính này?`)) return;
      await remoteController.stopAllOnDevice(devId);
      alert('Đã gửi lệnh dừng tới máy tính.');
      await refreshData();
    };
  });
}

function renderTasksTable(tasks) {
  const tbody = $('tasksTableBody');
  const countEl = $('activeTasksCount');
  if (!tbody) return;

  if (countEl) countEl.textContent = `${tasks.length} tác vụ`;

  if (!tasks || tasks.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:32px;color:#94a3b8">
          Chưa có tác vụ nào được tạo.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = tasks.map(t => {
    const prog = t.progress || {};
    const percent = Math.min(100, Math.max(0, Number(prog.percent) || 0));
    const statusColor = t.status === 'running' ? '#38bdf8' : (t.status === 'completed' ? '#34d399' : (t.status === 'failed' ? '#f87171' : '#fbbf24'));
    const timeStr = new Date(t.created_at).toLocaleString('vi-VN');

    return `
      <tr>
        <td><code style="color:#94a3b8;font-size:12px">${t.id.slice(0, 8)}</code></td>
        <td style="font-weight:700;color:#f8fafc">${formatTaskType(t.task_type)}</td>
        <td><span style="color:#cbd5e1;font-size:12px">${t.device_id === 'auto' ? '⚡ Tự động' : (t.device_id ? t.device_id.slice(0, 8) : '--')}</span></td>
        <td style="min-width:140px">
          <div style="font-size:11.5px;color:#94a3b8;margin-bottom:2px">${percent}% - ${escapeHtml(prog.status_text || '')}</div>
          <div style="width:100%;height:6px;background:#1e293b;border-radius:3px;overflow:hidden">
            <div style="width:${percent}%;height:100%;background:#38bdf8;border-radius:3px"></div>
          </div>
        </td>
        <td><span style="font-weight:800;font-size:11.5px;color:${statusColor}">${(t.status || 'PENDING').toUpperCase()}</span></td>
        <td><span style="color:#64748b;font-size:12px">${timeStr}</span></td>
        <td>
          <div style="display:flex;gap:4px">
            ${t.status === 'running' ? `
              <button type="button" class="btn-act pause-task-btn" data-id="${t.id}" data-dev="${t.device_id}" style="padding:3px 7px;font-size:11px">⏸ Tạm dừng</button>
              <button type="button" class="btn-act danger cancel-task-btn" data-id="${t.id}" data-dev="${t.device_id}" style="padding:3px 7px;font-size:11px">⏹ Hủy</button>
            ` : (t.status === 'paused' ? `
              <button type="button" class="btn-act resume-task-btn" data-id="${t.id}" data-dev="${t.device_id}" style="padding:3px 7px;font-size:11px;background:#065f46;color:#34d399;border-color:#059669">▶ Tiếp tục</button>
              <button type="button" class="btn-act danger cancel-task-btn" data-id="${t.id}" data-dev="${t.device_id}" style="padding:3px 7px;font-size:11px">⏹ Hủy</button>
            ` : `
              <span style="color:#64748b;font-size:11.5px">Đã kết thúc</span>
            `)}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện điều khiển task
  tbody.querySelectorAll('.pause-task-btn').forEach(btn => {
    btn.onclick = async () => {
      const dev = btn.getAttribute('data-dev');
      const id = btn.getAttribute('data-id');
      await supabaseSendRemoteCommand(dev || 'auto', 'pause_task', { target_task_id: id }, currentUser);
      await refreshData();
    };
  });

  tbody.querySelectorAll('.resume-task-btn').forEach(btn => {
    btn.onclick = async () => {
      const dev = btn.getAttribute('data-dev');
      const id = btn.getAttribute('data-id');
      await supabaseSendRemoteCommand(dev || 'auto', 'resume_task', { target_task_id: id }, currentUser);
      await refreshData();
    };
  });

  tbody.querySelectorAll('.cancel-task-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Hủy bỏ tác vụ này?')) return;
      const dev = btn.getAttribute('data-dev');
      const id = btn.getAttribute('data-id');
      await supabaseCancelRemoteTask(id);
      await supabaseSendRemoteCommand(dev || 'auto', 'stop_task', { target_task_id: id }, currentUser);
      await refreshData();
    };
  });
}

function renderLiveLogs(logs, task) {
  const box = $('liveLogsContainer');
  if (!box) return;

  if (!logs || logs.length === 0) {
    box.innerHTML = `<div style="color:#64748b;font-style:italic">Đang chờ bản ghi nhật ký đầu tiên từ tác vụ #${task.id.slice(0, 8)}...</div>`;
    return;
  }

  box.innerHTML = logs.map(l => {
    const time = new Date(l.created_at).toLocaleTimeString('vi-VN');
    const color = l.log_level === 'error' ? '#f87171' : (l.log_level === 'warning' ? '#fbbf24' : (l.log_level === 'success' ? '#34d399' : '#10b981'));
    return `<div style="margin-bottom:4px;color:${color}"><span style="color:#64748b">[${time}]</span> ${escapeHtml(l.message)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function formatTaskType(t) {
  switch (t) {
    case 'post_campaign': return '📢 Đăng bài chiến dịch';
    case 'warmup': return '🌱 Nuôi tài khoản';
    case 'scan_groups': return '👥 Quét nhóm Facebook';
    case 'scan_maps': return '📍 Quét Google Maps';
    default: return t || 'Tác vụ';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', initPage);
