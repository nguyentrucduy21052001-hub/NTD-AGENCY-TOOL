/**
 * NTD Agency - Remote Worker Engine (remote_worker.js)
 * Chịu trách nhiệm:
 * - Đăng ký thiết bị (máy tính) và gửi nhịp tim định kỳ tới Supabase
 * - Tiếp nhận tác vụ từ xa nguyên tử (Atomic Claim) qua Supabase
 * - Gọi lại các hàm thực thi cốt lõi trong Extension (Chiến dịch đăng bài, Nuôi nick, Quét data...)
 * - Nhận lệnh điều khiển tức thì: Tạm dừng, Tiếp tục, Dừng hẳn từ Web/Mobile
 * - Đồng bộ tiến độ và nhật ký chi tiết theo thời gian thực về Supabase
 * - Phục hồi an toàn khi mất mạng hoặc khởi động lại Chrome
 */

import { getMachineId } from './license.js';
import {
  supabaseRegisterDevice,
  supabaseSendHeartbeat,
  supabaseClaimRemoteTask,
  supabaseGetRemoteTask,
  supabaseUpdateTaskProgress,
  supabaseFetchPendingCommands,
  supabaseAppendTaskLog,
  isSupabaseConfigured
} from './supabase.js';

const REMOTE_WORKER_ALARM = 'ntd_remote_worker_tick';
const POLL_INTERVAL_MS = 10000; // 10 giây khi Service Worker đang active
const HEARTBEAT_INTERVAL_MS = 25000; // 25 giây gửi nhịp tim

let _activeTaskId = null;
let _activeTaskType = null;
let _lastHeartbeat = 0;
let _isPolling = false;
let _pollTimer = null;
let _registeredDeviceId = null;
let _registeredOwner = null;

/**
 * Lấy thông tin thiết bị và phiên đăng nhập hiện tại
 */
async function getCurrentWorkerIdentity() {
  try {
    const mid = await getMachineId();
    const stored = await chrome.storage.local.get(['license', 'ntd_device_name', 'remoteActiveTaskId']);
    const owner = (stored.license?.username || '').trim().toLowerCase();
    const customName = (stored.ntd_device_name || '').trim();
    const deviceName = customName || `Máy tính NTD (${mid.slice(0, 6).toUpperCase()})`;

    return {
      deviceId: mid,
      ownerUsername: owner,
      deviceName,
      savedTaskId: stored.remoteActiveTaskId || null
    };
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi lấy định danh thiết bị:', err.message);
    return { deviceId: null, ownerUsername: null, deviceName: 'Máy tính NTD', savedTaskId: null };
  }
}

/**
 * Đăng ký hoặc làm mới thông tin thiết bị lên Supabase
 */
export async function syncDeviceRegistration(force = false) {
  const configured = await isSupabaseConfigured();
  if (!configured) return null;

  const identity = await getCurrentWorkerIdentity();
  if (!identity.deviceId || !identity.ownerUsername) {
    return null; // Chưa đăng nhập tài khoản
  }

  if (!force && _registeredDeviceId === identity.deviceId && _registeredOwner === identity.ownerUsername) {
    return identity;
  }

  try {
    await supabaseRegisterDevice({
      deviceId: identity.deviceId,
      ownerUsername: identity.ownerUsername,
      deviceName: identity.deviceName,
      extVersion: '0.4.4',
      capabilities: ['post_campaign', 'warmup', 'scan_groups', 'scan_maps']
    });

    _registeredDeviceId = identity.deviceId;
    _registeredOwner = identity.ownerUsername;
    console.log(`[RemoteWorker] Đã đăng ký thiết bị "${identity.deviceName}" (${identity.deviceId}) cho user "${identity.ownerUsername}".`);
    return identity;
  } catch (err) {
    console.warn('[RemoteWorker] Đăng ký thiết bị thất bại:', err.message);
    return null;
  }
}

/**
 * Gửi nhịp tim định kỳ lên Supabase
 */
async function sendWorkerHeartbeat(status = 'idle') {
  const now = Date.now();
  if (now - _lastHeartbeat < 15000) return; // Tránh gửi quá dồn dập
  const identity = await getCurrentWorkerIdentity();
  if (!identity.deviceId || !identity.ownerUsername) return;

  try {
    await supabaseSendHeartbeat(identity.deviceId, status, _activeTaskId);
    _lastHeartbeat = now;
  } catch (_) {}
}

/**
 * Khởi tạo Remote Worker Engine
 */
export async function initRemoteWorker() {
  console.log('[RemoteWorker] Khởi tạo Remote Worker Engine...');

  // 1. Đăng ký Alarm định kỳ để Service Worker không bị ngủ quên khi có tác vụ
  try {
    if (chrome.alarms?.create) {
      chrome.alarms.create(REMOTE_WORKER_ALARM, { periodInMinutes: 0.5 });
      chrome.alarms.onAlarm.addListener(onWorkerAlarm);
    }
  } catch (err) {
    console.warn('[RemoteWorker] Không thể đăng ký chrome.alarm:', err.message);
  }

  // 2. Lắng nghe thay đổi tài khoản hoặc chiến dịch
  try {
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
  } catch (_) {}

  // 3. Phục hồi trạng thái an toàn sau khi khởi động lại Chrome
  await recoverWorkerStateOnStartup();

  // 4. Bắt đầu vòng lặp polling
  startPollingLoop();
}

/**
 * Xử lý sự kiện Alarm
 */
async function onWorkerAlarm(alarm) {
  if (alarm && alarm.name === REMOTE_WORKER_ALARM) {
    await checkAndExecutePendingTasks();
  }
}

/**
 * Bắt đầu vòng lặp polling chủ động khi Service Worker đang thức
 */
function startPollingLoop() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(async () => {
    await checkAndExecutePendingTasks().catch(() => {});
  }, POLL_INTERVAL_MS);
}

/**
 * Lắng nghe thay đổi storage để cập nhật tiến độ chiến dịch về Supabase
 */
let _progressSyncTimer = null;
function onStorageChanged(changes, areaName) {
  if (areaName !== 'local') return;

  // Nếu người dùng đăng nhập hoặc đổi tài khoản -> Đăng ký lại thiết bị
  if (changes.license) {
    syncDeviceRegistration(true).catch(() => {});
  }

  // Nếu đang có tác vụ chạy và có cập nhật chiến dịch đăng bài -> Đồng bộ tiến độ
  if (_activeTaskId && changes.campaigns) {
    clearTimeout(_progressSyncTimer);
    _progressSyncTimer = setTimeout(() => {
      syncCampaignProgressToSupabase().catch(() => {});
    }, 1000);
  }

  // Đồng bộ tiến độ Nuôi nick
  if (_activeTaskId && _activeTaskType === 'warmup' && changes.warmupStatus) {
    syncWarmupProgressToSupabase(changes.warmupStatus.newValue).catch(() => {});
  }
}

/**
 * Phục hồi trạng thái khi Extension / Chrome khởi động lại
 */
async function recoverWorkerStateOnStartup() {
  try {
    const identity = await getCurrentWorkerIdentity();
    await syncDeviceRegistration(true);

    if (identity.savedTaskId) {
      // Kiểm tra xem tác vụ có thực sự còn đang chạy cục bộ hay không
      const { campaigns = {} } = await chrome.storage.local.get('campaigns');
      const isAnyCampaignRunning = Object.values(campaigns).some(c => c && c.state === 'running');

      if (isAnyCampaignRunning) {
        _activeTaskId = identity.savedTaskId;
        _activeTaskType = 'post_campaign';
        console.log(`[RemoteWorker] Phục hồi phiên tác vụ đang chạy: ${_activeTaskId}`);
      } else {
        // Tác vụ đã dừng khi Chrome tắt -> Hoàn tất hoặc ghi nhận trạng thái
        console.log(`[RemoteWorker] Dọn dẹp tác vụ dở dang sau khi Chrome khởi động lại: ${identity.savedTaskId}`);
        await supabaseUpdateTaskProgress(identity.savedTaskId, {
          status: 'completed',
          result: { note: 'Đã hoàn tất hoặc dừng khi trình duyệt khởi động lại.' }
        });
        await chrome.storage.local.remove('remoteActiveTaskId');
        _activeTaskId = null;
        _activeTaskType = null;
      }
    }
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi phục hồi sau khởi động:', err.message);
  }
}

/**
 * Vòng lặp chính: Kiểm tra lệnh khẩn cấp hoặc tiếp nhận tác vụ mới
 */
export async function checkAndExecutePendingTasks() {
  if (_isPolling) return;
  _isPolling = true;

  try {
    const configured = await isSupabaseConfigured();
    if (!configured) return;

    const identity = await getCurrentWorkerIdentity();
    if (!identity.deviceId || !identity.ownerUsername) return;

    // Đảm bảo thiết bị đã được đăng ký
    await syncDeviceRegistration();

    // ── TÌNH HUỐNG 1: Đang có tác vụ đang chạy ───────────────────────────────
    if (_activeTaskId) {
      // 1. Kiểm tra xem tác vụ cục bộ đã kết thúc chưa
      await verifyActiveTaskLocalState();

      // 2. Gửi nhịp tim trạng thái 'running'
      await sendWorkerHeartbeat('running');

      // 3. Kiểm tra xem có lệnh điều khiển từ xa (Tạm dừng, Tiếp tục, Dừng) hay không
      const pendingCmds = await supabaseFetchPendingCommands(identity.deviceId, _activeTaskId);
      for (const cmd of pendingCmds) {
        await executeRemoteCommand(cmd);
      }
      return;
    }

    // ── TÌNH HUỐNG 2: Thiết bị đang rảnh (Idle) ──────────────────────────────
    // 1. Gửi nhịp tim 'idle'
    await sendWorkerHeartbeat('idle');

    // 2. Tiếp nhận tác vụ nguyên tử (Atomic Claim Task)
    const claimRes = await supabaseClaimRemoteTask(identity.deviceId, null, identity.ownerUsername);
    if (claimRes && claimRes.ok && claimRes.task) {
      const task = claimRes.task;
      console.log(`[RemoteWorker] Nhận tác vụ từ xa thành công! ID: ${task.id}, Loại: ${task.task_type}`);
      await startExecutingRemoteTask(task, identity);
    }
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi trong chu kỳ polling:', err.message);
  } finally {
    _isPolling = false;
  }
}

/**
 * Thực thi một tác vụ vừa nhận từ Supabase
 */
async function startExecutingRemoteTask(task, identity) {
  _activeTaskId = task.id;
  _activeTaskType = task.task_type;
  await chrome.storage.local.set({ remoteActiveTaskId: task.id });

  // Ghi log bắt đầu tác vụ
  await supabaseAppendTaskLog({
    taskId: task.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Máy tính "${identity.deviceName}" đã tiếp nhận tác vụ ${task.task_type.toUpperCase()}.`,
    logLevel: 'info'
  });

  try {
    const payload = task.payload || {};

    switch (task.task_type) {
      case 'post_campaign': {
        await executePostCampaignTask(task, payload, identity);
        break;
      }
      case 'warmup': {
        await executeWarmupTask(task, payload, identity);
        break;
      }
      case 'scan_groups': {
        await executeScanGroupsTask(task, payload, identity);
        break;
      }
      case 'scan_maps': {
        await executeScanMapsTask(task, payload, identity);
        break;
      }
      default: {
        throw new Error(`Loại tác vụ không được hỗ trợ: ${task.task_type}`);
      }
    }
  } catch (err) {
    console.error('[RemoteWorker] Lỗi khi thực thi tác vụ:', err);
    await supabaseAppendTaskLog({
      taskId: task.id,
      ownerUsername: identity.ownerUsername,
      deviceId: identity.deviceId,
      message: `Lỗi thực thi: ${err.message}`,
      logLevel: 'error'
    });
    await finishActiveTask('failed', null, err.message);
  }
}

/**
 * Xử lý tác vụ Đăng bài chiến dịch (post_campaign)
 */
async function executePostCampaignTask(task, payload, identity) {
  const data = payload.data || payload;
  const options = payload.options || {};

  await supabaseAppendTaskLog({
    taskId: task.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Đang khởi chạy chiến dịch đăng bài cho ${(data.accounts || []).length} tài khoản...`,
    logLevel: 'info'
  });

  // Gọi trực tiếp trình thực thi START_ALL trong Chrome Extension
  const res = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        type: 'START_ALL',
        data: data,
        options: options
      }, (resp) => {
        resolve(resp || { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });

  if (!res.ok) {
    throw new Error(res.error || 'Extension Runner từ chối khởi động chiến dịch.');
  }

  // Khởi tạo tiến độ ban đầu
  await supabaseUpdateTaskProgress(task.id, {
    status: 'running',
    progress: {
      current: 0,
      total: (data.groups || []).length * (data.accounts || []).length || 1,
      percent: 0,
      status_text: 'Chiến dịch đang chạy trên máy tính...'
    }
  });
}

/**
 * Xử lý tác vụ Nuôi tài khoản (warmup)
 */
async function executeWarmupTask(task, payload, identity) {
  const accounts = payload.accounts || [];
  const config = payload.config || {};

  await supabaseAppendTaskLog({
    taskId: task.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Đang khởi chạy Nuôi tài khoản cho ${accounts.length} nick...`,
    logLevel: 'info'
  });

  const res = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        type: 'WARMUP_START',
        accounts,
        config
      }, (resp) => resolve(resp || { ok: true }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });

  if (!res.ok) {
    throw new Error(res.error || 'Không thể bắt đầu Nuôi nick.');
  }
}

/**
 * Xử lý tác vụ Quét nhóm Facebook (scan_groups)
 */
async function executeScanGroupsTask(task, payload, identity) {
  await supabaseAppendTaskLog({
    taskId: task.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Bắt đầu quét nhóm Facebook từ khóa: "${payload.query || ''}"...`,
    logLevel: 'info'
  });

  chrome.runtime.sendMessage({
    type: 'FB_GROUP_START_SCAN',
    query: payload.query,
    options: payload.options
  });
}

/**
 * Xử lý tác vụ Quét Google Maps (scan_maps)
 */
async function executeScanMapsTask(task, payload, identity) {
  await supabaseAppendTaskLog({
    taskId: task.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Bắt đầu quét Google Maps từ khóa: "${payload.query || ''}"...`,
    logLevel: 'info'
  });

  chrome.runtime.sendMessage({
    type: 'MAPS_START_SCAN',
    query: payload.query,
    options: payload.options
  });
}

/**
 * Xử lý các lệnh điều khiển từ xa tức thì (Tạm dừng, Tiếp tục, Dừng hẳn)
 */
async function executeRemoteCommand(cmd) {
  const identity = await getCurrentWorkerIdentity();
  console.log(`[RemoteWorker] Nhận lệnh điều khiển từ xa: ${cmd.task_type}`);

  await supabaseAppendTaskLog({
    taskId: _activeTaskId || cmd.id,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: `Nhận lệnh từ điện thoại/website: ${cmd.task_type.toUpperCase()}`,
    logLevel: 'warning'
  });

  try {
    switch (cmd.task_type) {
      case 'pause_task': {
        // Tạm dừng chiến dịch hoặc nuôi nick
        chrome.runtime.sendMessage({ type: 'PAUSE_ALL' });
        chrome.runtime.sendMessage({ type: 'WARMUP_STOP' });
        if (_activeTaskId) {
          await supabaseUpdateTaskProgress(_activeTaskId, {
            status: 'paused',
            progress: { status_text: 'Đang tạm dừng theo lệnh từ xa...' }
          });
        }
        break;
      }
      case 'resume_task': {
        // Tiếp tục chiến dịch
        chrome.runtime.sendMessage({ type: 'RESUME_ALL' });
        if (_activeTaskId) {
          await supabaseUpdateTaskProgress(_activeTaskId, {
            status: 'running',
            progress: { status_text: 'Đang tiếp tục chạy...' }
          });
        }
        break;
      }
      case 'stop_task':
      case 'stop_all': {
        // Dừng hẳn toàn bộ
        chrome.runtime.sendMessage({ type: 'STOP_ALL' });
        chrome.runtime.sendMessage({ type: 'WARMUP_STOP' });
        chrome.runtime.sendMessage({ type: 'MAPS_STOP_SCAN' });
        chrome.runtime.sendMessage({ type: 'FB_GROUP_STOP_SCAN' });

        if (_activeTaskId) {
          await finishActiveTask('cancelled', { note: 'Người dùng dừng từ xa.' });
        }
        break;
      }
    }

    // Đánh dấu lệnh đã được xử lý xong
    await supabaseUpdateTaskProgress(cmd.id, {
      status: 'completed',
      result: { executed_at: new Date().toISOString() }
    });
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi xử lý lệnh điều khiển:', err.message);
  }
}

/**
 * Đồng bộ tiến độ chiến dịch đăng bài lên Supabase
 */
async function syncCampaignProgressToSupabase() {
  if (!_activeTaskId || _activeTaskType !== 'post_campaign') return;

  try {
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    const campaignList = Object.values(campaigns).filter(Boolean);
    if (campaignList.length === 0) return;

    let totalJobs = 0;
    let completedJobs = 0;
    let postedCount = 0;
    let isAnyRunning = false;
    let isAnyPaused = false;
    let statusNotes = [];

    for (const c of campaignList) {
      const jobs = Array.isArray(c.jobs) ? c.jobs : [];
      totalJobs += jobs.length;
      completedJobs += jobs.filter(j => j && j.status && j.status !== 'queued').length;
      postedCount += (Number(c.postedCount) || 0);

      if (c.state === 'running') isAnyRunning = true;
      if (c.state === 'paused') isAnyPaused = true;
      if (c.breakNote) statusNotes.push(c.breakNote);
    }

    const percent = totalJobs > 0 ? Math.min(100, Math.round((completedJobs / totalJobs) * 100)) : 0;
    const statusText = statusNotes[0] || (isAnyRunning ? `Đã đăng ${postedCount}/${totalJobs} nhóm...` : (isAnyPaused ? 'Đang tạm dừng' : 'Đang xử lý'));

    let currentStatus = isAnyRunning ? 'running' : (isAnyPaused ? 'paused' : 'running');

    await supabaseUpdateTaskProgress(_activeTaskId, {
      status: currentStatus,
      progress: {
        current: postedCount,
        total: totalJobs,
        completed_jobs: completedJobs,
        percent,
        status_text: statusText
      }
    });

    // Nếu tất cả tài khoản đã hoàn thành (không còn chạy hay tạm dừng)
    const isAllFinished = campaignList.every(c => c.state === 'completed' || c.state === 'stopped');
    if (isAllFinished && completedJobs >= totalJobs && totalJobs > 0) {
      await finishActiveTask('completed', {
        postedCount,
        totalJobs,
        summary: `Hoàn tất đăng ${postedCount}/${totalJobs} nhóm thành công.`
      });
    }
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi đồng bộ tiến độ chiến dịch:', err.message);
  }
}

/**
 * Đồng bộ tiến độ Nuôi nick lên Supabase
 */
async function syncWarmupProgressToSupabase(warmupStatus) {
  if (!_activeTaskId || _activeTaskType !== 'warmup' || !warmupStatus) return;

  try {
    const isRunning = Boolean(warmupStatus.running);
    const progressText = warmupStatus.note || warmupStatus.status || (isRunning ? 'Đang nuôi nick...' : 'Hoàn tất nuôi nick');

    await supabaseUpdateTaskProgress(_activeTaskId, {
      status: isRunning ? 'running' : 'completed',
      progress: {
        percent: isRunning ? 50 : 100,
        status_text: progressText
      }
    });

    if (!isRunning) {
      await finishActiveTask('completed', { note: progressText });
    }
  } catch (err) {
    console.warn('[RemoteWorker] Lỗi đồng bộ tiến độ nuôi nick:', err.message);
  }
}

/**
 * Kiểm tra trạng thái tác vụ cục bộ để tự động kết thúc nếu không còn hoạt động
 */
async function verifyActiveTaskLocalState() {
  if (!_activeTaskId) return;

  if (_activeTaskType === 'post_campaign') {
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    const list = Object.values(campaigns).filter(Boolean);
    const hasRunning = list.some(c => c && (c.state === 'running' || c.state === 'waiting'));
    const hasPaused = list.some(c => c && c.state === 'paused');

    if (!hasRunning && !hasPaused && list.length > 0) {
      // Đã hoàn tất hoặc dừng hẳn
      await finishActiveTask('completed', { summary: 'Chiến dịch đã kết thúc trên máy tính.' });
    }
  }
}

/**
 * Hoàn tất tác vụ hiện tại, dọn dẹp state và ghi log
 */
async function finishActiveTask(status = 'completed', result = {}, errorMessage = '') {
  if (!_activeTaskId) return;

  const finishedId = _activeTaskId;
  _activeTaskId = null;
  _activeTaskType = null;
  await chrome.storage.local.remove('remoteActiveTaskId');

  const identity = await getCurrentWorkerIdentity();
  await supabaseUpdateTaskProgress(finishedId, {
    status,
    result: result || {},
    errorMessage: errorMessage || ''
  });

  await supabaseAppendTaskLog({
    taskId: finishedId,
    ownerUsername: identity.ownerUsername,
    deviceId: identity.deviceId,
    message: status === 'completed' ? 'Tác vụ đã hoàn thành thành công!' : `Tác vụ kết thúc với trạng thái: ${status.toUpperCase()}`,
    logLevel: status === 'completed' ? 'success' : (status === 'failed' ? 'error' : 'warning')
  });

  await sendWorkerHeartbeat('idle');
  console.log(`[RemoteWorker] Đã hoàn tất tác vụ ${finishedId} [${status}]`);
}

/**
 * Trả về trạng thái hiện tại của Remote Worker
 */
export async function getRemoteWorkerStatus() {
  const identity = await getCurrentWorkerIdentity();
  return {
    deviceId: identity.deviceId,
    ownerUsername: identity.ownerUsername,
    deviceName: identity.deviceName,
    activeTaskId: _activeTaskId,
    activeTaskType: _activeTaskType,
    lastHeartbeat: _lastHeartbeat
  };
}
