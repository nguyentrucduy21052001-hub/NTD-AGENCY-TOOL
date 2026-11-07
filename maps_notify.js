/**
 * NTD Agency - Maps Notification & Power UI Helper
 * Quản lý tính năng giữ máy thức và gửi thông báo qua Zalo cá nhân.
 */

export async function rpc(m) {
  const r = await chrome.runtime.sendMessage(m);
  if (!r?.ok) throw Error(r?.error || 'Không nhận được phản hồi từ tiện ích.');
  return r;
}

export async function loadZaloSettings() {
  const { rinZalo: c = {}, rinKeepAwake: k = true } = await chrome.storage.local.get(['rinZalo', 'rinKeepAwake']);
  return {
    enabled: !!c.enabled,
    token: c.token || '',
    chat: c.chat || '',
    notifyFbDone: c.notifyFbDone !== undefined ? !!c.notifyFbDone : true,
    notifyFbError: c.notifyFbError !== undefined ? !!c.notifyFbError : true,
    notifyMaps: c.notifyMaps !== undefined ? !!c.notifyMaps : true,
    keepAwake: k
  };
}

export async function saveZaloSettings({ enabled, token, chat, notifyFbDone = true, notifyFbError = true, notifyMaps = true, keepAwake }) {
  const c = {
    enabled: Boolean(enabled),
    token: String(token || '').trim(),
    chat: String(chat || '').trim(),
    notifyFbDone: Boolean(notifyFbDone),
    notifyFbError: Boolean(notifyFbError),
    notifyMaps: Boolean(notifyMaps)
  };
  if (c.enabled && (!c.token || !c.chat)) {
    throw Error('Cần nhập Token và ghép Zalo trước khi bật gửi thông báo.');
  }

  const { rinZalo: old } = await chrome.storage.local.get('rinZalo');
  if (old && (old.token !== c.token || old.chat !== c.chat)) {
    await chrome.storage.local.remove('rinQueue');
  }

  await chrome.storage.local.set({
    rinZalo: c,
    rinKeepAwake: Boolean(keepAwake)
  });

  return c.enabled ? 'Đã lưu và bật thông báo Zalo thành công.' : 'Đã lưu cấu hình (Gửi Zalo đang tắt).';
}

export async function forgetZaloSettings() {
  await chrome.storage.local.remove(['rinZalo', 'rinQueue', 'rinDelivery']);
}

export async function pairZaloBot(token, onWaiting) {
  const trimmedToken = String(token || '').trim();
  if (!trimmedToken) throw Error('Vui lòng nhập Bot Token trước khi ghép.');

  const code = 'NTD-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase();
  const deadline = Date.now() + 60000;

  if (typeof onWaiting === 'function') {
    onWaiting(code);
  }

  while (Date.now() < deadline) {
    const r = await rpc({ type: 'rinPair', token: trimmedToken, code });
    if (r.chat) {
      return r.chat;
    }
    await new Promise(r => setTimeout(r, 600));
  }
  throw Error('Hết 60 giây chờ. Vui lòng bấm Ghép lại và gửi mã mới từ đúng Zalo cá nhân của bạn.');
}

export async function testZaloBot(settings) {
  await saveZaloSettings(settings);
  await rpc({ type: 'rinTest' });
}

export async function setMapsPower(on, isKeepAwakeChecked) {
  const enabled = Boolean(on && isKeepAwakeChecked);
  const current = await chrome.tabs.getCurrent();
  await rpc({ type: 'rinPower', on: enabled, tabId: current?.id });
  return enabled;
}

export async function sendMapsNotify(kind, reason, job, count) {
  const { rinZalo: c = {} } = await chrome.storage.local.get('rinZalo');
  if (c.notifyMaps === false) return;

  const title = {
    done: '✅ QUÉT MAPS HOÀN TẤT',
    stop: '⏸ CHIẾN DỊCH MAPS ĐÃ DỪNG',
    error: '⚠️ TẠM DỪNG DO LỖI'
  }[kind] || 'THÔNG BÁO QUÉT MAPS';

  const progress = job ? Math.min(job.index, job.queries.length) + '/' + job.queries.length + ' lượt hoàn thành' : '—';
  const query = job?.queries[Math.min(job.index, job.queries.length - 1)] || '—';

  const text = [
    'NTD AGENCY — ' + title,
    'Lý do: ' + String(reason).slice(0, 400),
    'Từ khóa: ' + String(query).slice(0, 700),
    'Tiến độ: ' + progress,
    'Đã lưu: ' + count + ' cơ sở',
    'Thời gian: ' + new Date().toLocaleString('vi-VN'),
    kind === 'done' ? 'Mở tiện ích NTD Agency để xuất Excel.' : 'Tiến trình đã lưu. Mở tiện ích kiểm tra rồi bấm Tiếp tục.'
  ].join('\n');

  try {
    await rpc({ type: 'rinNotify', id: crypto.randomUUID(), text });
  } catch (e) {
    console.warn('Lỗi gửi thông báo Zalo:', e);
  }
}
