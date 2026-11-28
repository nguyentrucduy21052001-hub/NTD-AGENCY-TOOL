/**
 * NTD Agency - Remote Controller (remote_controller.js)
 * Chịu trách nhiệm cho Web App (đặc biệt là Mobile / iPhone):
 * - Nhận diện môi trường (Điện thoại / Không Extension -> Chuyển sang Remote Mode)
 * - Quản lý và theo dõi danh sách máy tính (Online/Offline, Idle/Running, Heartbeat)
 * - Giao tiếp và gửi tác vụ từ xa tới máy tính qua Supabase
 * - Điều khiển từ xa: Bắt đầu, Tạm dừng, Tiếp tục, Dừng hẳn
 * - Theo dõi tiến độ thời gian gần thực và nhật ký thực thi (Terminal log)
 */

import {
  supabaseListDevices,
  supabaseCreateRemoteTask,
  supabaseGetRemoteTask,
  supabaseListRemoteTasks,
  supabaseSendRemoteCommand,
  supabaseCancelRemoteTask,
  supabaseGetTaskLogs,
  supabaseUpdateDevice,
  isSupabaseConfigured
} from './supabase.js';

class RemoteController {
  constructor() {
    this.ownerUsername = null;
    this.mode = 'local'; // 'local' hoặc 'remote'
    this.devices = [];
    this.selectedDeviceId = 'auto'; // 'auto' hoặc deviceId cụ thể
    this.activeTask = null;
    this.activeTaskLogs = [];
    this.pollInterval = null;
    this.devicePollInterval = null;
    this.listeners = {
      devicesChanged: [],
      modeChanged: [],
      taskProgress: [],
      taskFinished: []
    };
  }

  /**
   * Phát hiện thiết bị di động (iPhone, iPad, Android...)
   */
  isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isMobileUa = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isSmallScreen = typeof window !== 'undefined' && window.innerWidth < 800;
    return isMobileUa || isSmallScreen;
  }

  /**
   * Kiểm tra Extension có đang kết nối trực tiếp trên trình duyệt hiện tại hay không
   */
  hasLocalExtension() {
    if (typeof document === 'undefined') return false;
    return document.documentElement.dataset.ntdExtensionConnected === 'true';
  }

  /**
   * Khởi tạo bộ điều khiển với tài khoản đang đăng nhập
   */
  async init(ownerUsername) {
    this.ownerUsername = (ownerUsername || '').trim().toLowerCase();
    const isMobile = this.isMobileDevice();
    const hasExt = this.hasLocalExtension();

    // Khôi phục lựa chọn thiết bị từ bộ nhớ
    try {
      this.selectedDeviceId = localStorage.getItem('ntd_selected_remote_device') || 'auto';
      const savedMode = localStorage.getItem('ntd_execution_mode');
      if (savedMode && (savedMode === 'local' || savedMode === 'remote')) {
        this.mode = savedMode;
      }
    } catch (_) {}

    // Trên điện thoại hoặc khi không có Extension -> Bắt buộc dùng Remote Mode
    if (isMobile || !hasExt) {
      this.mode = 'remote';
    }

    this.notifyModeChanged();

    // Bắt đầu quét danh sách máy tính
    await this.refreshDevices();
    this.startDevicePolling();

    // Kiểm tra xem có tác vụ nào đang chạy của người dùng không
    await this.checkRunningRemoteTask();
  }

  /**
   * Chuyển đổi chế độ thực thi (Local Mode <-> Remote Mode)
   */
  setMode(newMode) {
    if (newMode !== 'local' && newMode !== 'remote') return;
    if (newMode === 'local' && (!this.hasLocalExtension() || this.isMobileDevice())) {
      console.warn('[RemoteController] Không thể chuyển sang Local Mode vì thiết bị hiện tại không có Extension.');
      return;
    }
    this.mode = newMode;
    try { localStorage.setItem('ntd_execution_mode', newMode); } catch (_) {}
    this.notifyModeChanged();
  }

  /**
   * Chọn máy tính thực thi
   */
  setSelectedDevice(deviceId) {
    this.selectedDeviceId = deviceId || 'auto';
    try { localStorage.setItem('ntd_selected_remote_device', this.selectedDeviceId); } catch (_) {}
    this.notifyDevicesChanged();
  }

  /**
   * Làm mới danh sách máy tính từ Supabase
   */
  async refreshDevices() {
    if (!this.ownerUsername) return [];
    try {
      const configured = await isSupabaseConfigured();
      if (!configured) return [];

      const list = await supabaseListDevices(this.ownerUsername);
      this.devices = list || [];
      this.notifyDevicesChanged();
      return this.devices;
    } catch (err) {
      console.warn('[RemoteController] Lỗi làm mới danh sách thiết bị:', err.message);
      return [];
    }
  }

  /**
   * Bắt đầu chu kỳ thăm dò danh sách thiết bị (mỗi 12 giây)
   */
  startDevicePolling() {
    if (this.devicePollInterval) clearInterval(this.devicePollInterval);
    this.devicePollInterval = setInterval(async () => {
      await this.refreshDevices().catch(() => {});
    }, 12000);
  }

  /**
   * Kiểm tra xem người dùng có máy tính nào đang Online không
   */
  hasOnlineDevice() {
    return this.devices.some(d => d.isOnline);
  }

  /**
   * Lấy danh sách máy tính Online
   */
  getOnlineDevices() {
    return this.devices.filter(d => d.isOnline);
  }

  /**
   * Lấy thiết bị được chọn hoặc máy tính Online phù hợp nhất
   */
  getTargetDevice() {
    if (this.selectedDeviceId && this.selectedDeviceId !== 'auto') {
      const found = this.devices.find(d => d.id === this.selectedDeviceId);
      if (found) return found;
    }
    // 'auto': Tìm máy tính rảnh (idle) và online trước, nếu không lấy máy running
    const online = this.getOnlineDevices();
    const idle = online.find(d => d.status === 'idle');
    return idle || online[0] || null;
  }

  /**
   * Tạo và gửi một tác vụ từ xa tới máy tính
   * @param {string} taskType Loại tác vụ ('post_campaign', 'warmup', 'scan_groups', 'scan_maps')
   * @param {object} payload Dữ liệu tham số của tác vụ
   * @param {object} options Các tùy chọn bổ sung
   */
  async dispatchTask(taskType, payload = {}, options = {}) {
    if (!this.ownerUsername) {
      throw new Error('Vui lòng đăng nhập trước khi gửi tác vụ.');
    }

    const onlineDevices = this.getOnlineDevices();
    if (onlineDevices.length === 0 && !options.allowOfflineQueue) {
      // Hỏi người dùng có muốn lưu chờ không
      const confirmQueue = confirm(
        '⚠️ Hiện tại chưa có máy tính nào Online để thực hiện ngay!\n\n' +
        'Bạn có muốn lưu tác vụ này vào hàng đợi (Pending) để máy tính tự động nhận và chạy ngay khi bật Chrome lên không?'
      );
      if (!confirmQueue) {
        return { ok: false, cancelled: true };
      }
    }

    const targetDeviceId = (this.selectedDeviceId && this.selectedDeviceId !== 'auto')
      ? this.selectedDeviceId
      : 'auto';

    console.log(`[RemoteController] Đang gửi tác vụ ${taskType} tới thiết bị "${targetDeviceId}"...`);

    const createdTask = await supabaseCreateRemoteTask({
      ownerUsername: this.ownerUsername,
      deviceId: targetDeviceId,
      taskType: taskType,
      payload: payload
    });

    if (!createdTask || !createdTask.id) {
      throw new Error('Không thể tạo tác vụ trên máy chủ Supabase.');
    }

    this.activeTask = createdTask;
    this.activeTaskLogs = [];
    this.startTaskMonitoring(createdTask.id);

    return {
      ok: true,
      taskId: createdTask.id,
      task: createdTask,
      message: onlineDevices.length > 0
        ? 'Đã gửi tác vụ thành công! Máy tính đang tiếp nhận...'
        : 'Đã lưu tác vụ vào hàng đợi! Máy tính sẽ tự động chạy khi Online.'
    };
  }

  /**
   * Bắt đầu theo dõi tiến độ và log của tác vụ từ xa (Polling mỗi 2-3s)
   */
  startTaskMonitoring(taskId) {
    if (this.pollInterval) clearInterval(this.pollInterval);

    const pollTask = async () => {
      try {
        const task = await supabaseGetRemoteTask(taskId);
        if (!task) return;

        this.activeTask = task;

        // Lấy log mới nhất
        const logs = await supabaseGetTaskLogs(taskId, 30);
        this.activeTaskLogs = logs || [];

        this.notifyTaskProgress(this.activeTask, this.activeTaskLogs);

        // Kiểm tra xem tác vụ đã kết thúc chưa
        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
          this.notifyTaskFinished(this.activeTask);
        }
      } catch (err) {
        console.warn('[RemoteController] Lỗi theo dõi tác vụ:', err.message);
      }
    };

    pollTask();
    this.pollInterval = setInterval(pollTask, 2500);
  }

  /**
   * Dừng theo dõi tác vụ hiện tại
   */
  stopTaskMonitoring() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Kiểm tra xem tài khoản có tác vụ nào đang chạy dở dang không để khôi phục màn hình theo dõi
   */
  async checkRunningRemoteTask() {
    if (!this.ownerUsername) return null;
    try {
      const runningTasks = await supabaseListRemoteTasks(this.ownerUsername, {
        status: 'running',
        limit: 1
      });

      if (runningTasks && runningTasks.length > 0) {
        const task = runningTasks[0];
        console.log(`[RemoteController] Phát hiện tác vụ đang chạy: ${task.id} (${task.task_type})`);
        this.activeTask = task;
        this.startTaskMonitoring(task.id);
        return task;
      }

      // Kiểm tra tác vụ pending mới tạo gần đây (< 5 phút)
      const pendingTasks = await supabaseListRemoteTasks(this.ownerUsername, {
        status: 'pending',
        limit: 1
      });

      if (pendingTasks && pendingTasks.length > 0) {
        const task = pendingTasks[0];
        const ageSec = Math.round((Date.now() - new Date(task.created_at).getTime()) / 1000);
        if (ageSec < 300) {
          this.activeTask = task;
          this.startTaskMonitoring(task.id);
          return task;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Lệnh điều khiển: Tạm dừng tác vụ từ xa
   */
  async pauseActiveTask() {
    if (!this.activeTask) return { ok: false, error: 'Không có tác vụ nào đang chạy.' };
    const deviceId = this.activeTask.device_id || this.selectedDeviceId || 'auto';
    return await supabaseSendRemoteCommand(deviceId, 'pause_task', { target_task_id: this.activeTask.id }, this.ownerUsername);
  }

  /**
   * Lệnh điều khiển: Tiếp tục tác vụ từ xa
   */
  async resumeActiveTask() {
    if (!this.activeTask) return { ok: false, error: 'Không có tác vụ nào đang tạm dừng.' };
    const deviceId = this.activeTask.device_id || this.selectedDeviceId || 'auto';
    return await supabaseSendRemoteCommand(deviceId, 'resume_task', { target_task_id: this.activeTask.id }, this.ownerUsername);
  }

  /**
   * Lệnh điều khiển: Dừng hẳn tác vụ từ xa
   */
  async stopActiveTask() {
    if (!this.activeTask) return { ok: false, error: 'Không có tác vụ nào đang chạy.' };
    const deviceId = this.activeTask.device_id || this.selectedDeviceId || 'auto';
    await supabaseCancelRemoteTask(this.activeTask.id, 'Người dùng đã dừng từ xa qua điện thoại/web.');
    return await supabaseSendRemoteCommand(deviceId, 'stop_task', { target_task_id: this.activeTask.id }, this.ownerUsername);
  }

  /**
   * Lệnh điều khiển: Dừng toàn bộ hoạt động trên máy tính
   */
  async stopAllOnDevice(deviceId = null) {
    const target = deviceId || this.selectedDeviceId || 'auto';
    return await supabaseSendRemoteCommand(target, 'stop_all', {}, this.ownerUsername);
  }

  /**
   * Cập nhật tên gợi nhớ cho máy tính
   */
  async renameDevice(deviceId, newName) {
    const cleanName = String(newName || '').trim();
    if (!cleanName) return false;
    const ok = await supabaseUpdateDevice(deviceId, { device_name: cleanName });
    if (ok) {
      await this.refreshDevices();
    }
    return ok;
  }

  // ── ĐĂNG KÝ VÀ PHÁT SỰ KIỆN GIAO DIỆN ───────────────────────────────────────

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  notifyDevicesChanged() {
    for (const cb of this.listeners.devicesChanged) {
      try { cb(this.devices, this.selectedDeviceId); } catch (_) {}
    }
  }

  notifyModeChanged() {
    for (const cb of this.listeners.modeChanged) {
      try { cb(this.mode); } catch (_) {}
    }
  }

  notifyTaskProgress(task, logs) {
    for (const cb of this.listeners.taskProgress) {
      try { cb(task, logs); } catch (_) {}
    }
  }

  notifyTaskFinished(task) {
    for (const cb of this.listeners.taskFinished) {
      try { cb(task); } catch (_) {}
    }
  }
}

// Khởi tạo Singleton Instance cho toàn bộ giao diện Web
export const remoteController = new RemoteController();
