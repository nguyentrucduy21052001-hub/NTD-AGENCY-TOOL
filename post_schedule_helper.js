// post_schedule_helper.js — Pure helper logic for multi-milestone auto post scheduling

export const SCHEDULE_ALARM_PREFIX = 'post_sched_';
export const SCHEDULE_SWEEP_ALARM = 'post_sched_sweep';
export const DEFAULT_DAILY_MISSED_GRACE_MS = 2 * 60 * 60 * 1000; // 2 giờ

/**
 * Format local YYYY-MM-DD string from epoch ms or Date.
 */
export function formatLocalDateStr(tsOrDate = new Date()) {
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format local HH:mm string from epoch ms or Date.
 */
export function formatLocalTimeHM(tsOrDate = new Date()) {
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format human-readable Vietnamese datetime label (e.g. "Hôm nay 08:00" or "08:00 13/11/2026").
 */
export function formatScheduleDatetimeLabel(ts, nowMs = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const target = new Date(ts);
  const timeStr = formatLocalTimeHM(target);
  const targetDay = formatLocalDateStr(target);
  const todayDay = formatLocalDateStr(nowMs);
  const tomorrowDay = formatLocalDateStr(nowMs + 24 * 60 * 60 * 1000);
  if (targetDay === todayDay) return `Hôm nay ${timeStr}`;
  if (targetDay === tomorrowDay) return `Ngày mai ${timeStr}`;
  const dd = String(target.getDate()).padStart(2, '0');
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const yyyy = target.getFullYear();
  return `${timeStr} ${dd}/${mm}/${yyyy}`;
}

/**
 * Format countdown in Vietnamese for upcoming timestamps.
 */
export function formatCountdownVi(targetMs, nowMs = Date.now()) {
  if (!Number.isFinite(targetMs) || targetMs <= 0) return '—';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'Đến giờ chạy';
  const totalSec = Math.ceil(diffMs / 1000);
  if (totalSec < 60) return `Còn ${totalSec} giây`;
  const totalMin = Math.floor(totalSec / 60);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `Còn ${days} ngày ${remH} giờ` : `Còn ${days} ngày`;
  }
  if (hours > 0) {
    return mins > 0 ? `Còn ${hours} giờ ${mins} phút` : `Còn ${hours} giờ`;
  }
  return `Còn ${mins} phút`;
}

/**
 * Normalize time strings like "8:5", "08h30", "19H", "20:00" -> "HH:mm".
 * Returns null if invalid.
 */
export function normalizeTimeHM(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase().replace(/[hH]/g, ':');
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Parse comma / newline / semicolon / space separated time milestones.
 * Deduplicates and sorts ascending from "00:00" to "23:59".
 */
export function parseTimeSlotsInput(rawText) {
  const tokens = String(rawText || '')
    .split(/[\n,;|\s]+/)
    .map(t => t.trim())
    .filter(Boolean);
  const validSet = new Set();
  const invalidTokens = [];
  for (const tok of tokens) {
    const norm = normalizeTimeHM(tok);
    if (norm) validSet.add(norm);
    else invalidTokens.push(tok);
  }
  const times = Array.from(validSet).sort((a, b) => a.localeCompare(b));
  return { times, invalidTokens };
}

/**
 * Compute local timestamp (ms) at `timeHM` on calendar day of `baseDate`.
 */
export function computeRunAtOnLocalDay(timeHM, baseDate = new Date(), dayOffset = 0) {
  const norm = normalizeTimeHM(timeHM);
  if (!norm) return NaN;
  const [hh, mm] = norm.split(':').map(Number);
  const d = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hh, mm, 0, 0);
  return target.getTime();
}

/**
 * Parse local "YYYY-MM-DD" + "HH:mm" into local epoch ms.
 */
export function parseLocalDateAndTime(dateStr, timeHM) {
  const mDate = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const normTime = normalizeTimeHM(timeHM);
  if (!mDate || !normTime) return NaN;
  const yyyy = Number(mDate[1]);
  const month = Number(mDate[2]) - 1;
  const dd = Number(mDate[3]);
  const [hh, mm] = normTime.split(':').map(Number);
  const d = new Date(yyyy, month, dd, hh, mm, 0, 0);
  if (d.getFullYear() !== yyyy || d.getMonth() !== month || d.getDate() !== dd) return NaN;
  return d.getTime();
}

/**
 * Compute initial nextRunAt for creating a new milestone job.
 */
export function computeInitialNextRunAt({ scheduleType, dateStr, timeHM, nowMs = Date.now() }) {
  const normTime = normalizeTimeHM(timeHM);
  if (!normTime) {
    return { ok: false, error: `Mốc giờ "${timeHM}" không hợp lệ (dùng định dạng HH:mm, vd 08:30).` };
  }

  if (scheduleType === 'daily') {
    const todayTs = computeRunAtOnLocalDay(normTime, new Date(nowMs), 0);
    // Nếu mốc giờ hôm nay đã trôi qua, tự động xếp vào ngày mai để tránh nổ chạy bù ngoài ý muốn
    const nextRunAt = todayTs > nowMs ? todayTs : computeRunAtOnLocalDay(normTime, new Date(nowMs), 1);
    return { ok: true, timeHM: normTime, dateStr: formatLocalDateStr(nextRunAt), nextRunAt };
  }

  const targetDateStr = dateStr || formatLocalDateStr(nowMs);
  const ts = parseLocalDateAndTime(targetDateStr, normTime);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: `Ngày "${targetDateStr}" không hợp lệ.` };
  }
  if (ts <= nowMs - 60000) {
    return {
      ok: false,
      error: `Mốc "${normTime} (${targetDateStr})" đã nằm trong quá khứ. Hãy chọn giờ/ngày trong tương lai hoặc chọn chế độ "Lặp lại hằng ngày".`
    };
  }
  return { ok: true, timeHM: normTime, dateStr: targetDateStr, nextRunAt: Math.max(nowMs + 1000, ts) };
}

/**
 * Compute the next day's target timestamp after a daily slot executes/finishes today.
 */
export function computeNextDailyAfterRun(timeHM, nowMs = Date.now()) {
  const tomorrowTs = computeRunAtOnLocalDay(timeHM, new Date(nowMs), 1);
  return Number.isFinite(tomorrowTs) ? tomorrowTs : 0;
}

/**
 * Roll stale daily jobs forward safely when the extension/page wakes up on a later day.
 */
export function normalizeScheduleJobState(job, nowMs = Date.now(), missedGraceMs = DEFAULT_DAILY_MISSED_GRACE_MS) {
  if (!job || typeof job !== 'object') return null;
  const copy = { ...job };
  if (copy.scheduleType !== 'daily') return copy;

  const todayKey = formatLocalDateStr(nowMs);
  if (!copy.enabled || copy.completed) return copy;

  const todayTarget = computeRunAtOnLocalDay(copy.timeHM, new Date(nowMs), 0);
  if (!Number.isFinite(todayTarget)) return copy;

  if (copy.lastRunDate === todayKey) {
    const tomorrowTs = computeRunAtOnLocalDay(copy.timeHM, new Date(nowMs), 1);
    if (copy.nextRunAt !== tomorrowTs) {
      copy.nextRunAt = tomorrowTs;
    }
    return copy;
  }

  const prevTargetDay = Number.isFinite(copy.nextRunAt) && copy.nextRunAt > 0
    ? formatLocalDateStr(copy.nextRunAt)
    : '';

  // Nếu nextRunAt đang ở ngày trong quá khứ (máy tắt qua nhiều ngày), cập nhật về lịch hợp lệ hôm nay/ngày mai
  if (prevTargetDay && prevTargetDay < todayKey) {
    copy.nextRunAt = todayTarget > nowMs ? todayTarget : computeRunAtOnLocalDay(copy.timeHM, new Date(nowMs), 1);
    return copy;
  }

  // Nếu đã trôi qua quá giới hạn grace trong ngày hôm nay mà chưa từng được trigger đúng hạn hôm nay
  if (prevTargetDay === todayKey && todayTarget < nowMs && (nowMs - todayTarget) > missedGraceMs) {
    copy.nextRunAt = computeRunAtOnLocalDay(copy.timeHM, new Date(nowMs), 1);
    copy.lastStatusNote = `⏭️ Bỏ qua mốc ${copy.timeHM} hôm nay (đã quá giờ hơn 2 tiếng) — chờ ngày mai`;
    return copy;
  }

  return copy;
}

/**
 * Determine whether a scheduled milestone job is currently due to fire.
 */
export function isScheduleJobDue(job, nowMs = Date.now()) {
  if (!job || !job.enabled || job.completed || job.state === 'done') return false;
  const todayKey = formatLocalDateStr(nowMs);
  if (job.scheduleType === 'daily' && job.lastRunDate === todayKey) return false;
  if (job.scheduleType === 'once' && ((Number(job.runCount) || 0) > 0 || job.completed)) return false;

  const target = Number(job.nextRunAt || job.runAt || 0);
  return Number.isFinite(target) && target > 0 && nowMs >= target;
}

/**
 * Default Facebook group URL parser used when core.groups isn't injected.
 */
export function parseGroupLinesDefault(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    let u;
    try {
      u = new URL(line);
    } catch (_) {
      throw Error('Link nhóm không hợp lệ: ' + line);
    }
    const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/?$/);
    if (!['www.facebook.com', 'facebook.com'].includes(u.hostname) || u.protocol !== 'https:' || !m || ['feed', 'discover', 'joins'].includes(m[1])) {
      throw Error('Chỉ nhận link https://www.facebook.com/groups/ten-hoac-id');
    }
    const value = 'https://www.facebook.com/groups/' + m[1] + '/';
    if (!out.includes(value)) out.push(value);
  }
  if (!out.length) throw Error('Hãy nhập ít nhất một link nhóm.');
  return out;
}

/**
 * Evenly split an array of group URLs into `slotCount` contiguous slices without duplicates.
 */
export function splitGroupUrlsAcrossSlots(urls, slotCount) {
  const list = Array.isArray(urls) ? urls : [];
  const k = Math.max(1, Number(slotCount) || 1);
  const slices = Array.from({ length: k }, () => []);
  if (list.length === 0) return slices;

  const base = Math.floor(list.length / k);
  const rem = list.length % k;
  let offset = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < rem ? 1 : 0);
    slices[i] = list.slice(offset, offset + size);
    offset += size;
  }
  return slices;
}

/**
 * Deduplicate image attachments for a batch so multiple milestones share 1 reference key.
 */
export function extractBatchPictures(posts, rawPicture, batchId) {
  const picturesMap = {};
  const lightPosts = (Array.isArray(posts) ? posts : []).map((p, idx) => {
    if (!p || typeof p !== 'object') return p;
    const clone = { ...p };
    if (clone.picture?.data && (!clone.background || clone.background === 'none')) {
      const refKey = `sched_pic_${batchId}_p${idx}`;
      picturesMap[refKey] = {
        name: clone.picture.name || `image_${idx}.jpg`,
        type: clone.picture.type || 'image/jpeg',
        data: clone.picture.data
      };
      clone.picture = {
        name: picturesMap[refKey].name,
        type: picturesMap[refKey].type,
        refKey
      };
    } else if (clone.picture && !clone.picture.data) {
      clone.picture = { ...clone.picture };
    }
    return clone;
  });

  let lightRootPic = null;
  if (rawPicture?.data) {
    const rootRefKey = `sched_pic_${batchId}_root`;
    picturesMap[rootRefKey] = {
      name: rawPicture.name || 'image.jpg',
      type: rawPicture.type || 'image/jpeg',
      data: rawPicture.data
    };
    lightRootPic = {
      name: picturesMap[rootRefKey].name,
      type: picturesMap[rootRefKey].type,
      refKey: rootRefKey
    };
  } else if (rawPicture?.refKey) {
    lightRootPic = { ...rawPicture };
  }

  return { lightPosts, lightRootPic, picturesMap };
}

/**
 * Re-hydrate image data into a cloned START_ALL payload from `scheduledPictures` storage.
 */
export function resolvePicturesIntoPayload(payloadSnapshot, picturesMap = {}, fallbackDraftPosts = []) {
  if (!payloadSnapshot || typeof payloadSnapshot !== 'object') return payloadSnapshot;
  const clone = {
    ...payloadSnapshot,
    posts: Array.isArray(payloadSnapshot.posts)
      ? payloadSnapshot.posts.map((p, idx) => {
          if (!p || typeof p !== 'object') return p;
          const pc = { ...p };
          if (pc.picture && !pc.picture.data) {
            const refKey = pc.picture.refKey;
            const fromMap = refKey ? picturesMap?.[refKey] : null;
            const fromDraft = (!fromMap && Array.isArray(fallbackDraftPosts))
              ? (fallbackDraftPosts[idx]?.picture?.name === pc.picture.name ? fallbackDraftPosts[idx].picture : null)
              : null;
            if (fromMap?.data) {
              pc.picture = { ...fromMap };
            } else if (fromDraft?.data) {
              pc.picture = { ...fromDraft };
            }
          }
          return pc;
        })
      : undefined
  };

  if (clone.picture && !clone.picture.data && clone.picture.refKey && picturesMap?.[clone.picture.refKey]?.data) {
    clone.picture = { ...picturesMap[clone.picture.refKey] };
  }
  return clone;
}

/**
 * Build scheduled posting milestone jobs from wizard/form inputs & validated draft snapshot.
 */
export function buildScheduledJobBatch({
  batchId = '',
  label = '',
  scheduleType = 'once',
  dispatchMode = 'per_slot',
  dateStr = '',
  times = [],
  perSlotPostChoices = [],
  maxGroupsPerSlot = 0,
  draftData,
  accounts = [],
  groupsParserFn = parseGroupLinesDefault,
  nowMs = Date.now(),
  findBannedWordsFn = null
}) {
  if (!['once', 'daily'].includes(scheduleType)) {
    throw Error('Loại lịch hẹn không hợp lệ (once hoặc daily).');
  }
  if (!['per_slot', 'split_groups'].includes(dispatchMode)) {
    throw Error('Chế độ phân bổ đợt đăng không hợp lệ (per_slot hoặc split_groups).');
  }
  if (!Array.isArray(times) || times.length === 0) {
    throw Error('Vui lòng nhập hoặc chọn ít nhất 1 mốc thời gian (vd: 08:00, 12:00, 20:00).');
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw Error('Chưa có tài khoản nào. Hãy thêm tài khoản trước khi hẹn giờ.');
  }

  // Lọc tài khoản đang hoạt động theo cấu hình hiện tại
  const activePostingAccs = accounts.filter(a => {
    if (draftData.groupSourceMode === 'categories') {
      return !!(draftData.accountGroups?.[a.id]?.trim());
    }
    const isSelected = !draftData.sharedSelectedAccounts || draftData.sharedSelectedAccounts.includes(a.id);
    return isSelected && !!(a.groups?.trim() || draftData.links?.trim());
  });

  if (!activePostingAccs.length) {
    throw Error(
      draftData.groupSourceMode === 'categories'
        ? 'Chưa có tài khoản nào được gán danh mục nhóm ở Bước 2.'
        : 'Chưa có tài khoản nào được chọn hoặc chưa có link nhóm ở Bước 2.'
    );
  }

  // Parse và kiểm tra thời gian cho từng mốc
  const resolvedTimes = [];
  for (const t of times) {
    const init = computeInitialNextRunAt({ scheduleType, dateStr, timeHM: t, nowMs });
    if (!init.ok) throw Error(init.error);
    resolvedTimes.push(init);
  }

  const resolvedBatchId = batchId || `batch_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
  const allPosts = (Array.isArray(draftData.posts) && draftData.posts.length > 0)
    ? draftData.posts
    : [{ id: 1, text: draftData.text || '', picture: draftData.picture || null, background: draftData.background || null, postLinkMode: !!draftData.postLinkMode }];

  const validatePostIndexForAcc = (pIdx, accName) => {
    const p = allPosts[pIdx] || allPosts[0] || {};
    if (!p.text?.trim()) {
      throw Error(`Mốc gán Bài ${pIdx + 1} (tài khoản "${accName}"), nhưng Bài ${pIdx + 1} chưa có nội dung!`);
    }
    if (p.postLinkMode && !/(https?:\/\/[^\s]+|www\.[^\s]+)/i.test(p.text)) {
      throw Error(`Bài ${pIdx + 1} đang bật chế độ "Đăng bài bằng link" nhưng chưa chứa link https://...!`);
    }
    if (typeof findBannedWordsFn === 'function') {
      const vios = findBannedWordsFn(p.text);
      if (vios.length > 0) {
        const unique = [...new Set(vios.map(v => v.word))];
        throw Error(`Bài ${pIdx + 1} chứa từ cấm vi phạm chính sách Facebook: ${unique.join(', ')}.`);
      }
    }
  };

  // Phân tích nguồn nhóm hiện tại để hỗ trợ cả "Mỗi mốc 1 đợt" lẫn "Chia đều nhóm ra các mốc"
  const slotCount = resolvedTimes.length;
  let sharedUrls = [];
  if (draftData.groupSourceMode !== 'categories' && draftData.links?.trim()) {
    const anyNeedsShared = activePostingAccs.some(a => !a.groups?.trim());
    try {
      sharedUrls = groupsParserFn(draftData.links);
    } catch (e) {
      if (anyNeedsShared) throw e;
    }
  }

  const accPersonalUrlsMap = {};
  for (const acc of activePostingAccs) {
    if (draftData.groupSourceMode === 'categories') {
      accPersonalUrlsMap[acc.id] = groupsParserFn(draftData.accountGroups[acc.id]);
    } else if (acc.groups?.trim()) {
      accPersonalUrlsMap[acc.id] = groupsParserFn(acc.groups);
    } else {
      accPersonalUrlsMap[acc.id] = null; // dùng sharedUrls
    }
  }

  const accSlicesMap = {};
  for (const acc of activePostingAccs) {
    if (Array.isArray(accPersonalUrlsMap[acc.id])) {
      accSlicesMap[acc.id] = splitGroupUrlsAcrossSlots(accPersonalUrlsMap[acc.id], slotCount);
    }
  }
  const sharedSlices = sharedUrls.length > 0
    ? splitGroupUrlsAcrossSlots(sharedUrls, slotCount)
    : Array.from({ length: slotCount }, () => []);

  // Tách ảnh ra picturesMap (mỗi ảnh chỉ lưu 1 lần cho cả batch)
  const { lightPosts, lightRootPic, picturesMap } = extractBatchPictures(
    allPosts,
    draftData.picture || null,
    resolvedBatchId
  );

  const jobs = [];
  let skippedEmptySlots = 0;

  for (let i = 0; i < slotCount; i++) {
    const slotTime = resolvedTimes[i];
    const slotPostChoice = String(perSlotPostChoices?.[i] ?? 'auto');

    let slotTargetAccountIds = activePostingAccs.map(a => a.id);
    let slotAccountGroupsOverride = null;
    let slotAccountGroupsCat = draftData.groupSourceMode === 'categories' ? { ...(draftData.accountGroups || {}) } : {};
    let slotLinks = draftData.links || '';
    let slotGroupCount = 0;

    if (dispatchMode === 'split_groups') {
      slotTargetAccountIds = [];
      slotAccountGroupsOverride = {};
      if (draftData.groupSourceMode === 'categories') {
        slotAccountGroupsCat = {};
      }
      const sliceShared = sharedSlices[i] || [];
      slotLinks = sliceShared.join('\n');

      const seenGroupsInSlot = new Set();
      for (const acc of activePostingAccs) {
        if (accSlicesMap[acc.id]) {
          const urlsForAcc = accSlicesMap[acc.id][i] || [];
          if (urlsForAcc.length > 0) {
            slotTargetAccountIds.push(acc.id);
            const joined = urlsForAcc.join('\n');
            slotAccountGroupsOverride[acc.id] = joined;
            if (draftData.groupSourceMode === 'categories') {
              slotAccountGroupsCat[acc.id] = joined;
            }
            urlsForAcc.forEach(u => seenGroupsInSlot.add(u));
          }
        } else if (sliceShared.length > 0) {
          slotTargetAccountIds.push(acc.id);
          sliceShared.forEach(u => seenGroupsInSlot.add(u));
        }
      }
      slotGroupCount = seenGroupsInSlot.size;

      if (slotTargetAccountIds.length === 0 || slotGroupCount === 0) {
        skippedEmptySlots++;
        continue;
      }
    } else {
      const seenAll = new Set();
      for (const acc of activePostingAccs) {
        const list = accPersonalUrlsMap[acc.id] || sharedUrls;
        const limit = Number(maxGroupsPerSlot) > 0 ? Number(maxGroupsPerSlot) : list.length;
        list.slice(0, limit).forEach(u => seenAll.add(u));
      }
      slotGroupCount = seenAll.size;
    }

    // Xác định mapping Bài 1 / 2 / 3 cho từng tài khoản ở mốc này & validate nội dung
    const slotAccountPostMap = {};
    const usedPostIndexes = new Set();
    for (const acc of activePostingAccs) {
      if (!slotTargetAccountIds.includes(acc.id)) continue;
      let chosenIdx;
      if (['0', '1', '2'].includes(slotPostChoice)) {
        chosenIdx = Number(slotPostChoice);
      } else {
        chosenIdx = (draftData.accountPostMap && draftData.accountPostMap[acc.id] !== undefined)
          ? Number(draftData.accountPostMap[acc.id])
          : 0;
      }
      validatePostIndexForAcc(chosenIdx, acc.name);
      slotAccountPostMap[acc.id] = chosenIdx;
      usedPostIndexes.add(chosenIdx);
    }

    const postSummary = ['0', '1', '2'].includes(slotPostChoice)
      ? `Bài ${Number(slotPostChoice) + 1}`
      : (usedPostIndexes.size === 1
        ? `Bài ${Array.from(usedPostIndexes)[0] + 1}`
        : `Theo từng nick (${Array.from(usedPostIndexes).sort().map(x => `Bài ${x + 1}`).join(', ')})`);

    const slotMaxPosts = Number(maxGroupsPerSlot) > 0
      ? Number(maxGroupsPerSlot)
      : (Number(draftData.maxPosts) || 0);

    const payloadSnapshot = {
      ...draftData,
      posts: lightPosts,
      picture: lightRootPic,
      links: slotLinks,
      accountGroups: slotAccountGroupsCat,
      slotAccountGroups: slotAccountGroupsOverride,
      accountPostMap: slotAccountPostMap,
      targetAccountIds: slotTargetAccountIds,
      maxPosts: slotMaxPosts,
      when: ''
    };

    const jobId = `sched_${resolvedBatchId}_${i}_${slotTime.timeHM.replace(':', '')}`;
    jobs.push({
      id: jobId,
      batchId: resolvedBatchId,
      label: String(label || '').trim() || `Lịch tự động ${slotTime.timeHM}`,
      scheduleType,
      dispatchMode,
      dateStr: slotTime.dateStr,
      timeHM: slotTime.timeHM,
      nextRunAt: slotTime.nextRunAt,
      runAt: scheduleType === 'once' ? slotTime.nextRunAt : 0,
      enabled: true,
      completed: false,
      state: 'waiting',
      postChoice: slotPostChoice,
      postSummary,
      accountCount: slotTargetAccountIds.length,
      accountNames: activePostingAccs
        .filter(a => slotTargetAccountIds.includes(a.id))
        .map(a => a.name)
        .slice(0, 6),
      groupCount: slotGroupCount,
      runCount: 0,
      lastRunAt: 0,
      lastRunDate: '',
      lastError: '',
      lastStatusNote: '',
      createdAt: nowMs,
      payloadSnapshot
    });
  }

  if (jobs.length === 0) {
    throw Error('Không đủ link nhóm để chia vào các mốc thời gian đã chọn.');
  }

  return { jobs, picturesMap, skippedEmptySlots };
}

/**
 * Strip oversized (>2KB) base64 data URIs inside scheduledPostJobs before uploading to Supabase.
 */
export function sanitizeScheduledJobsForCloud(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.map(job => {
    if (!job || typeof job !== 'object') return job;
    const snap = job.payloadSnapshot && typeof job.payloadSnapshot === 'object'
      ? { ...job.payloadSnapshot }
      : null;
    if (snap) {
      if (Array.isArray(snap.posts)) {
        snap.posts = snap.posts.map(p => {
          if (!p || typeof p !== 'object') return p;
          const cp = { ...p };
          if (cp.picture && typeof cp.picture === 'object') {
            cp.picture = {
              name: cp.picture.name || '',
              type: cp.picture.type || '',
              refKey: cp.picture.refKey || ''
            };
          }
          return cp;
        });
      }
      if (snap.picture && typeof snap.picture === 'object') {
        snap.picture = {
          name: snap.picture.name || '',
          type: snap.picture.type || '',
          refKey: snap.picture.refKey || ''
        };
      }
    }
    return { ...job, payloadSnapshot: snap };
  });
}

/**
 * Garbage-collect unreferenced keys from scheduledPictures storage map.
 */
export function pruneUnreferencedScheduledPictures(jobs, picturesMap = {}) {
  const referenced = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const snap = job?.payloadSnapshot;
    if (snap?.picture?.refKey) referenced.add(snap.picture.refKey);
    for (const p of Array.isArray(snap?.posts) ? snap.posts : []) {
      if (p?.picture?.refKey) referenced.add(p.picture.refKey);
    }
  }
  const pruned = {};
  for (const [k, v] of Object.entries(picturesMap || {})) {
    if (referenced.has(k) && v) pruned[k] = v;
  }
  return pruned;
}
