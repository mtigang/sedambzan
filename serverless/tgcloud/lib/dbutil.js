import { api, db } from 'sdk';
import {  channels, channelAdmins, shifts, settings, users, messages, subLeaders } from 'schema';
// subLeaders used for role
import { eq, and, sql, desc, asc } from 'sdk/db';
import {
  DEFAULT_CHANNELS,
  OWNER_IDS,
  CHANNEL_IDS,
  ADMIN_GROUP_IDS,
} from 'lib/config';
import { tehranNow, inRange, periodDateStr, normHm, hourKeyOf, periodOrd, isWorkHours, setWorkHoursConfig, setShiftDayMode, getShiftDayMode, buildAvailableShiftSlots } from 'lib/time';
import { exactBodyKey, bodyIndexSettingKey } from 'lib/validation';
import { reviewInline, sanitizeMarkup } from 'lib/keyboards';

const __reqMemo = Object.create(null);
const __reqMemoTs = Object.create(null);
const MEMO_TTL_MS = 2500;
function memo(key, fn) {
  const now = Date.now();
  if (
    Object.prototype.hasOwnProperty.call(__reqMemo, key) &&
    now - (Number(__reqMemoTs[key]) || 0) < MEMO_TTL_MS
  ) {
    return __reqMemo[key];
  }
  const p = fn();
  __reqMemo[key] = p;
  __reqMemoTs[key] = now;
  return p;
}
export function clearMemo(prefix) {
  try {
    if (!prefix) {
      for (const k of Object.keys(__reqMemo)) delete __reqMemo[k];
      for (const k of Object.keys(__reqMemoTs)) delete __reqMemoTs[k];
      return;
    }
    for (const k of Object.keys(__reqMemo)) {
      if (String(k).startsWith(prefix)) {
        delete __reqMemo[k];
        delete __reqMemoTs[k];
      }
    }
  } catch (_e) {}
}

let _channelsSeededAt = 0;
export async function ensureChannelsSeeded() {
  try {
    // هر ۶ ساعت یک‌بار کافی است
    if (_channelsSeededAt && Date.now() - _channelsSeededAt < 6 * 60 * 60 * 1000) {
      return Object.values(DEFAULT_CHANNELS);
    }
    for (const c of Object.values(DEFAULT_CHANNELS)) {
      try {
        const exist = await db.select().from(channels).where(eq(channels.key, c.key)).all();
        if (exist && exist.length) {
          // فقط title را همگام کن — workStart/workEnd را بازنویسی نکن
          try {
            if (c.title && String(exist[0].title || '') !== String(c.title)) {
              await db
                .update(channels)
                .set({ title: c.title })
                .where(eq(channels.key, c.key))
                .run();
            }
          } catch (_e) {}
          continue;
        }
        await db
          .insert(channels)
          .values({
            key: c.key,
            title: c.title,
            link: String(c.chatId),
            enabled: 1,
            workStart: c.workStart || '12:00',
            workEnd: c.workEnd || '00:00',
          })
          .run();
      } catch (e) {
        console.error('seed', c.key, e);
      }
    }
    _channelsSeededAt = Date.now();
    return Object.values(DEFAULT_CHANNELS);
  } catch (e) {
    console.error('ensureChannelsSeeded', e);
    return Object.values(DEFAULT_CHANNELS).map((c) => ({
      key: c.key,
      title: c.title,
      link: String(c.chatId),
      enabled: 1,
      workStart: c.workStart || '12:00',
      workEnd: c.workEnd || '00:00',
    }));
  }
}

export async function getChannels() {
  return (await ensureChannelsSeeded()) || [];
}

export async function getChannel(key) {
  let globalWh = null;
  try {
    const { getWorkHoursConfig } = await import('lib/time');
    globalWh = getWorkHoursConfig();
  } catch (_e) {}
  try {
    const rows = await db.select().from(channels).where(eq(channels.key, key)).all();
    if (rows?.[0]) {
      const r = rows[0];
      return {
        ...r,
        workStart: (globalWh && globalWh.start) || r.workStart || '12:00',
        workEnd: (globalWh && globalWh.end) || r.workEnd || '00:00',
        chatId: CHANNEL_IDS[key] || Number(r.link) || null,
        adminGroupId: ADMIN_GROUP_IDS[key] || null,
      };
    }
  } catch (e) {
    console.error('getChannel', e);
  }
  const d = DEFAULT_CHANNELS[key];
  if (!d) return null;
  return {
    key: d.key,
    title: d.title,
    link: String(d.chatId),
    enabled: 1,
    workStart: (globalWh && globalWh.start) || d.workStart,
    workEnd: (globalWh && globalWh.end) || d.workEnd,
    chatId: d.chatId,
    adminGroupId: d.adminGroupId,
  };
}

export async function settingGet(key, def = null) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    return rows?.[0]?.value ?? def;
  } catch (_) {
    return def;
  }
}


export async function settingSet(key, value) {
  const v = String(value);
  try {
    // اول insert؛ اگر تکراری بود update — یک رفت‌وبرگشت کمتر در حالت رایج
    try {
      await db.insert(settings).values({ key, value: v }).run();
      return;
    } catch (_ins) {
      await db.update(settings).set({ value: v }).where(eq(settings.key, key)).run();
    }
  } catch (e) {
    console.error('settingSet', e);
  }
}

/** ایندکس سبک آخرین پیام‌های هر کاربر در settings (بدون تغییر schema) */
export async function rememberUserMessageId(userId, msgId) {
  const uid = Number(userId);
  const mid = Number(msgId);
  if (!Number.isFinite(uid) || !Number.isFinite(mid) || mid <= 0) return;
  const key = 'umsg:' + uid;
  let ids = [];
  try {
    const raw = await settingGet(key, '[]');
    const parsed = JSON.parse(String(raw || '[]'));
    if (Array.isArray(parsed)) ids = parsed.map(Number).filter(function (x) { return Number.isFinite(x) && x > 0; });
  } catch (_e) {}
  ids = [mid].concat(ids.filter(function (x) { return x !== mid; })).slice(0, 400);
  try {
    await settingSet(key, JSON.stringify(ids));
  } catch (_e) {}
}

/**
 * بارگذاری امن پیام‌های یک کاربر بدون WHERE روی userId روی کل جدول
 * (جلوگیری از Sqlite rows_read limit exceeded)
 * @returns {Promise<Array>}
 */
export async function loadUserMessagesPage(userId, limit, opts) {
  const uid = Number(userId);
  const lim = Math.max(1, Math.min(Number(limit) || 30, 50));
  const beforeId =
    opts && opts.beforeId != null && Number.isFinite(Number(opts.beforeId))
      ? Number(opts.beforeId)
      : null;
  const maxScan = Math.max(800, Math.min(Number((opts && opts.maxScan) || 4000), 8000));
  const batchSize = 500;
  const maxRounds = Math.min(
    Number((opts && opts.maxRounds) || Math.ceil(maxScan / batchSize)),
    Math.ceil(maxScan / batchSize)
  );
  const out = [];
  const seen = Object.create(null);
  let indexTotal = 0;

  if (!Number.isFinite(uid) || uid <= 0) {
    return { rows: out, hasMore: false, indexTotal: 0 };
  }

  try {
    const raw = await settingGet('umsg:' + uid, '');
    if (raw) {
      const ids = JSON.parse(String(raw));
      if (Array.isArray(ids)) {
        indexTotal = ids.length;
        const sorted = ids
          .map(Number)
          .filter(function (x) {
            return Number.isFinite(x) && x > 0 && (beforeId == null || x < beforeId);
          })
          .sort(function (a, b) {
            return b - a;
          });
        for (const id of sorted) {
          if (seen[id]) continue;
          try {
            const rows =
              (await db
                .select({
                  id: messages.id,
                  userId: messages.userId,
                  status: messages.status,
                  content: messages.content,
                  channelKey: messages.channelKey,
                  submittedAt: messages.submittedAt,
                  reviewedAt: messages.reviewedAt,
                  reviewedBy: messages.reviewedBy,
                  rejectReason: messages.rejectReason,
                })
                .from(messages)
                .where(eq(messages.id, id))
                .limit(1)
                .all()) || [];
            if (rows[0] && Number(rows[0].userId ?? rows[0].user_id) === uid) {
              seen[id] = 1;
              out.push(rows[0]);
            }
          } catch (_e) {}
          if (out.length >= lim) break;
        }
      }
    }
  } catch (_e) {}

  if (out.length >= lim) {
    const rows = out
      .sort(function (a, b) {
        return Number(b.id) - Number(a.id);
      })
      .slice(0, lim);
    return { rows: rows, hasMore: true, indexTotal: indexTotal };
  }

  let cursor =
    beforeId != null && Number.isFinite(beforeId)
      ? beforeId
      : out.length
        ? Math.min.apply(
            null,
            out.map(function (r) {
              return Number(r.id);
            })
          )
        : Number.MAX_SAFE_INTEGER;

  for (let round = 0; round < maxRounds && out.length < lim; round++) {
    let batch = [];
    try {
      if (cursor < Number.MAX_SAFE_INTEGER) {
        batch =
          (await db
            .select({
              id: messages.id,
              userId: messages.userId,
              status: messages.status,
              content: messages.content,
              channelKey: messages.channelKey,
              submittedAt: messages.submittedAt,
              reviewedAt: messages.reviewedAt,
              reviewedBy: messages.reviewedBy,
              rejectReason: messages.rejectReason,
            })
            .from(messages)
            .where(sql`${messages.id} < ${cursor}`)
            .orderBy(desc(messages.id))
            .limit(batchSize)
            .all()) || [];
      } else {
        batch =
          (await db
            .select({
              id: messages.id,
              userId: messages.userId,
              status: messages.status,
              content: messages.content,
              channelKey: messages.channelKey,
              submittedAt: messages.submittedAt,
              reviewedAt: messages.reviewedAt,
              reviewedBy: messages.reviewedBy,
              rejectReason: messages.rejectReason,
            })
            .from(messages)
            .orderBy(desc(messages.id))
            .limit(batchSize)
            .all()) || [];
      }
    } catch (e) {
      console.error('loadUserMessagesPage batch', round, e);
      break;
    }
    if (!batch.length) break;
    for (const row of batch) {
      const id = Number(row.id);
      if (id < cursor) cursor = id;
      if (Number(row.userId ?? row.user_id) !== uid) continue;
      if (seen[id]) continue;
      seen[id] = 1;
      out.push(row);
      if (out.length >= lim) break;
    }
    const lastId = Number(batch[batch.length - 1].id);
    if (!Number.isFinite(lastId) || lastId <= 1) break;
    cursor = lastId;
    if (batch.length < batchSize) break;
  }

  const rows = out
    .sort(function (a, b) {
      return Number(b.id) - Number(a.id);
    })
    .slice(0, lim);
  return { rows: rows, hasMore: rows.length >= lim, indexTotal: indexTotal };
}

/** سازگاری با فراخوانی‌های قدیمی — فقط آرایه ردیف‌ها */
export async function loadUserMessages(userId, limit, opts) {
  const page = await loadUserMessagesPage(userId, limit, opts);
  return page.rows || [];
}


export async function estimateQueueAhead(channelKey, msgId, maxScan) {
  const ck = String(channelKey || '');
  const mid = Number(msgId);
  if (!ck || !Number.isFinite(mid)) return { ahead: 0, scanned: 0, totalPendingSeen: 0 };
  const scan = Math.max(1000, Math.min(Number(maxScan) || 12000, 20000));
  let ahead = 0;
  let totalPendingSeen = 0;
  try {
    const rows =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(scan)
        .all()) || [];
    for (const r of rows) {
      const rck = String((r.channelKey ?? r.channel_key) || '');
      if (rck !== ck) continue;
      const st = String(r.status || '');
      if (st !== 'pending' && st !== 'publishing') continue;
      totalPendingSeen++;
      if (Number(r.id) < mid) ahead++;
    }
    return { ahead: ahead, scanned: rows.length, totalPendingSeen: totalPendingSeen };
  } catch (e) {
    console.error('estimateQueueAhead', e);
    return { ahead: 0, scanned: 0, totalPendingSeen: 0 };
  }
}

export async function countRecentByStatus(maxScan) {
  const scan = Math.max(500, Math.min(Number(maxScan) || 12000, 20000));
  const byCh = Object.create(null);
  let pe = 0, ap = 0, rj = 0, other = 0;
  try {
    const rows =
      (await db
        .select({
          status: messages.status,
          channelKey: messages.channelKey,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(scan)
        .all()) || [];
    for (const x of rows) {
      const st = String(x.status || '');
      const ck = String((x.channelKey ?? x.channel_key) || '');
      if (!byCh[ck]) byCh[ck] = { pe: 0, ap: 0, rj: 0, total: 0 };
      byCh[ck].total++;
      if (st === 'pending' || st === 'publishing') {
        pe++;
        byCh[ck].pe++;
      } else if (st === 'approved') {
        ap++;
        byCh[ck].ap++;
      } else if (st === 'rejected') {
        rj++;
        byCh[ck].rj++;
      } else other++;
    }
    return { pe: pe, ap: ap, rj: rj, other: other, scanned: rows.length, byCh: byCh };
  } catch (e) {
    console.error('countRecentByStatus', e);
    return { pe: 0, ap: 0, rj: 0, other: 0, scanned: 0, byCh: byCh };
  }
}



/** ذخیره نگاشت دوطرفه message_id کانال ↔ آیدی داخلی */
export async function rememberChannelMessage(channelKey, channelMsgId, internalId) {
  const ck = String(channelKey || '');
  const mid = Number(channelMsgId);
  const id = Number(internalId);
  if (!ck || !Number.isFinite(mid) || !Number.isFinite(id)) return;
  try {
    await settingSet('chmsg:' + ck + ':' + mid, String(id));
  } catch (_e) {}
  try {
    await settingSet('msgch:' + id, ck + ':' + mid);
  } catch (_e) {}
}

/**
 * پیدا کردن message_id کانال از روی آیدی داخلی پیام
 * @returns {{ channelKey: string, channelMsgId: number, chatId: number|null } | null}
 */
export async function findChannelMessageByInternalId(internalId) {
  const id = Number(internalId);
  if (!Number.isFinite(id)) return null;
  try {
    const rev = await settingGet('msgch:' + id, '');
    if (rev && String(rev).includes(':')) {
      const parts = String(rev).split(':');
      const ck = parts[0];
      const mid = Number(parts[1]);
      if (ck && Number.isFinite(mid)) {
        const chatId = (CHANNEL_IDS && CHANNEL_IDS[ck]) != null ? Number(CHANNEL_IDS[ck]) : null;
        return { channelKey: ck, channelMsgId: mid, chatId: chatId };
      }
    }
  } catch (_e) {}
  // بدون اسکن کل settings (timeout روی approve)
  return null;
}

/**
 * حذف امن پیام از کانال.
 * اگر deleteMessage رد شد، یک‌بار edit به «حذف شد» را امتحان می‌کند.
 */
export async function deleteChannelMessageSafe(chatId, messageId) {
  const cid = Number(chatId);
  const mid = Number(messageId);
  if (!Number.isFinite(cid) || !cid || !Number.isFinite(mid) || mid <= 0) {
    return { ok: false, error: 'شناسه کانال یا پیام نامعتبر است.' };
  }
  const attempts = [
    { chat_id: cid, message_id: mid },
    { chat_id: String(cid), message_id: mid },
  ];
  let lastErr = '';
  for (const a of attempts) {
    try {
      await api.deleteMessage(a);
      return { ok: true, method: 'delete' };
    } catch (e) {
      lastErr = String((e && (e.description || e.message)) || e || '');
    }
  }
  // اگر حذف ممکن نبود، محتوا را خنثی کن (اگر ربات نویسنده باشد)
  try {
    await api.editMessageText({
      chat_id: cid,
      message_id: mid,
      text: '🗑 این پیام حذف شد.',
    });
    return { ok: true, method: 'edit' };
  } catch (_e2) {
    try {
      await api.editMessageText({
        chat_id: String(cid),
        message_id: mid,
        text: '🗑 این پیام حذف شد.',
      });
      return { ok: true, method: 'edit' };
    } catch (_e3) {}
  }
  let hint = lastErr || 'حذف ناموفق';
  if (/can.?t be deleted|can't be deleted|message to delete not found|message not found/i.test(lastErr)) {
    hint =
      'تلگرام اجازه حذف نداد.\n' +
      '• ربات را در کانال ادمین کنید و تیک Delete messages را روشن کنید\n' +
      '• یا پیام از قبل پاک شده / آیدی اشتباه است\n' +
      '• لینک عمومی همان پیام کانال را بفرستید\n' +
      '(' +
      lastErr.slice(0, 80) +
      ')';
  }
  return { ok: false, error: hint };
}



/** سقف تقریبی حجم جدول messages ≈ ۵ مگابایت */

/**
 * چک تکراری سبک و مقیاس‌پذیر (بدون .all روی کل pending)
 * 1) ایندکس settings
 * 2) حداکثر N pending اخیر همان کانال
 * 3) حداکثر M approved اخیر
 * در خطا: null برمی‌گرداند تا caller تصمیم بگیرد (fail-open ترجیح داده می‌شود)
 */
export async function findBodyDuplicate(channelKey, bodyKey) {
  const ck = String(channelKey || '');
  const key = String(bodyKey || '');
  if (!ck || !key) return { dup: null, dupIsPending: false, queuePos: 0, error: null };

  const bIdx = bodyIndexSettingKey(ck, key);

  // ۱) ایندکس settings — سریع
  try {
    const hit = await settingGet(bIdx, '');
    if (hit) {
      const hid = Number(String(hit).split('|')[0]);
      const hst = String(hit).split('|')[1] || 'pending';
      if (hid && (hst === 'pending' || hst === 'approved' || hst === 'publishing')) {
        try {
          const row = await getMessageById(hid);
          if (row) {
            const st = String(row.status || '');
            if (st === 'pending' || st === 'publishing' || st === 'approved') {
              return {
                dup: { id: hid, status: st },
                dupIsPending: st === 'pending' || st === 'publishing',
                queuePos: 0,
                error: null,
              };
            }
          }
          try {
            await settingSet(bIdx, '');
          } catch (_e) {}
        } catch (_e) {}
      }
    }
  } catch (e) {
    console.error('findBodyDuplicate index', e);
  }

  // ۲) فقط ۱۰۰ pending اخیر + ۱۰۰ approved اخیر (اسکن از id نزولی — بدون WHERE سنگین)
  try {
    const recent =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
          content: messages.content,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(800)
        .all()) || [];

    let pendChecked = 0;
    let apprChecked = 0;
    for (const row of recent) {
      const rck = String((row.channelKey ?? row.channel_key) || '');
      if (rck !== ck) continue;
      const st = String(row.status || '');
      if (st === 'pending' || st === 'publishing') {
        if (pendChecked >= 100) continue;
        pendChecked++;
        const other = exactBodyKey(row.content);
        if (other && other === key) {
          try {
            await settingSet(bIdx, String(row.id) + '|pending');
          } catch (_e) {}
          return {
            dup: row,
            dupIsPending: true,
            queuePos: 0,
            error: null,
          };
        }
      } else if (st === 'approved') {
        if (apprChecked >= 100) continue;
        apprChecked++;
        const other = exactBodyKey(row.content);
        if (other && other === key) {
          try {
            await settingSet(bIdx, String(row.id) + '|approved');
          } catch (_e) {}
          return {
            dup: row,
            dupIsPending: false,
            queuePos: 0,
            error: null,
          };
        }
      }
      if (pendChecked >= 100 && apprChecked >= 100) break;
    }
  } catch (e) {
    console.error('findBodyDuplicate scan', e);
  }

  return { dup: null, dupIsPending: false, queuePos: 0, error: null };
}

export const MESSAGES_SIZE_BUDGET_BYTES = 5 * 1024 * 1024;
const MSG_ROW_OVERHEAD = 200;

/**
 * اگر برآورد حجم messages از ۵MB بیشتر باشد، قدیمی‌ترین پیام را حذف می‌کند.
 * با هر پیام جدید یک‌بار صدا زده شود تا حجم به‌مرور پایین بیاید.
 * @returns {{ pruned: number, id?: number, estimate?: number }}
 */
export async function pruneOldestMessageIfOverBudget() {
  try {
    let contentBytes = 0;
    let n = 0;
    try {
      const rows =
        (await db
          .select({
            n: sql`count(*)`,
            bytes: sql`coalesce(sum(length(content)), 0)`,
          })
          .from(messages)
          .all()) || [];
      n = Number(rows[0] && (rows[0].n != null ? rows[0].n : rows[0].count)) || 0;
      contentBytes = Number(rows[0] && rows[0].bytes) || 0;
    } catch (e1) {
      // fallback: فقط تعداد
      try {
        const c = (await db.select({ n: sql`count(*)` }).from(messages).all()) || [];
        n = Number(c[0] && c[0].n) || 0;
        contentBytes = n * 400;
      } catch (_e) {
        return { pruned: 0 };
      }
    }
    const estimate = contentBytes + n * MSG_ROW_OVERHEAD;
    if (estimate <= MESSAGES_SIZE_BUDGET_BYTES || n <= 0) {
      return { pruned: 0, estimate: estimate, n: n };
    }
    let oldestId = null;
    async function pickOldestByStatus(st) {
      try {
        const rows =
          (await db
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.status, st))
            .orderBy(asc(messages.id))
            .limit(1)
            .all()) || [];
        if (rows[0] && rows[0].id != null) return Number(rows[0].id);
      } catch (_e) {}
      return null;
    }
    try {
      oldestId = await pickOldestByStatus('rejected');
      if (!oldestId) oldestId = await pickOldestByStatus('approved');
      // فقط اگر هیچ rejected/approved نبود، از pending قدیمی حذف کن
      if (!oldestId) {
      // بودجه پر است ولی فقط rejected/approved قابل حذف‌اند — pending حفظ می‌شود
      return { pruned: 0, estimate: estimate, n: n, skippedPending: true };
    }
    } catch (_e) {
      try {
        const all = (await db.select({ id: messages.id, status: messages.status }).from(messages).limit(800).all()) || [];
        const rej = all.filter(function (r) { return String(r.status) === 'rejected'; });
        const ap = all.filter(function (r) { return String(r.status) === 'approved'; });
        const pool = rej.length ? rej : ap; // هرگز pending را برای بودجه حذف نکن
        if (pool.length) {
          oldestId = Math.min.apply(null, pool.map(function (r) { return Number(r.id); }));
        }
      } catch (_e2) {
        return { pruned: 0, estimate: estimate };
      }
    }
    if (!oldestId || !Number.isFinite(oldestId)) {
      return { pruned: 0, estimate: estimate };
    }
    await db.delete(messages).where(eq(messages.id, oldestId)).run();
    return { pruned: 1, id: oldestId, estimate: estimate, n: n };
  } catch (e) {
    console.error('pruneOldestMessageIfOverBudget', e);
    return { pruned: 0 };
  }
}

export async function loadWorkHoursFromSettings() {
  try {
    const mode = (await settingGet('shift_day_mode', '12')) || '12';
    setShiftDayMode(mode);
    if (String(mode) === '24') {
      const s = '00:00';
      const e = '00:00';
      try {
        for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
          if (DEFAULT_CHANNELS[k]) {
            DEFAULT_CHANNELS[k].workStart = s;
            DEFAULT_CHANNELS[k].workEnd = e;
          }
        }
      } catch (_e) {}
      return { start: s, end: e, mode: '24' };
    }
    const s = (await settingGet('work_start_hm', '12:00')) || '12:00';
    const e = (await settingGet('work_end_hm', '00:00')) || '00:00';
    setWorkHoursConfig(s, e);
    try {
      for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
        if (DEFAULT_CHANNELS[k]) {
          DEFAULT_CHANNELS[k].workStart = s;
          DEFAULT_CHANNELS[k].workEnd = e;
        }
      }
    } catch (_e) {}
    return { start: s, end: e, mode: '12' };
  } catch (e) {
    console.error('loadWorkHoursFromSettings', e);
    return { start: '12:00', end: '00:00', mode: '12' };
  }
}

export async function saveWorkHours(startHm, endHm) {
  const s = String(startHm || '12:00');
  const e = String(endHm || '00:00');
  await settingSet('work_start_hm', s);
  await settingSet('work_end_hm', e);
  try {
    setWorkHoursConfig(s, e);
  } catch (_e) {}
  // همگام‌سازی ساعت کاری هر کانال (لیست شیفت + پیام‌های ساعت کاری)
  try {
    for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
      if (DEFAULT_CHANNELS[k]) {
        DEFAULT_CHANNELS[k].workStart = s;
        DEFAULT_CHANNELS[k].workEnd = e;
      }
    }
  } catch (_e) {}
  try {
    const rows = (await db.select().from(channels).all()) || [];
    for (const row of rows) {
      const key = row.key || row.channelKey;
      if (!key) continue;
      try {
        await db
          .update(channels)
          .set({ workStart: s, workEnd: e })
          .where(eq(channels.key, key));
      } catch (_e) {}
    }
  } catch (e) {
    console.error('saveWorkHours channel sync', e);
  }
}

/** حالت شیفت روزانه: '12' یا '24' */
export async function saveShiftDayMode(mode) {
  const m = mode === '24' ? '24' : '12';
  await settingSet('shift_day_mode', m);
  try {
    setShiftDayMode(m);
  } catch (_e) {}
  if (m === '24') {
    await settingSet('work_start_hm', '00:00');
    await settingSet('work_end_hm', '00:00');
    try {
      for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
        if (DEFAULT_CHANNELS[k]) {
          DEFAULT_CHANNELS[k].workStart = '00:00';
          DEFAULT_CHANNELS[k].workEnd = '00:00';
        }
      }
    } catch (_e) {}
  } else {
    await settingSet('work_start_hm', '12:00');
    await settingSet('work_end_hm', '00:00');
    try {
      for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
        if (DEFAULT_CHANNELS[k]) {
          DEFAULT_CHANNELS[k].workStart = '12:00';
          DEFAULT_CHANNELS[k].workEnd = '00:00';
        }
      }
    } catch (_e) {}
  }
  return m;
}

export async function getShiftDayModeSetting() {
  try {
    const m = (await settingGet('shift_day_mode', '12')) || '12';
    return m === '24' ? '24' : '12';
  } catch (_e) {
    return '12';
  }
}


const PUBLISH_STICKER_SETTING = 'publish_sticker_file_id';
/** fallback قدیمی — معمولاً نامعتبر است تا مالک یک‌بار استیکر را برای ربات بفرستد */
const PUBLISH_STICKER_FALLBACK = '';

export async function getPublishStickerFileId() {
  try {
    const v = await settingGet(PUBLISH_STICKER_SETTING, '');
    if (v && String(v).trim()) return String(v).trim();
  } catch (_e) {}
  return PUBLISH_STICKER_FALLBACK || '';
}

export async function setPublishStickerFileId(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return false;
  await settingSet(PUBLISH_STICKER_SETTING, id);
  return true;
}

/** ارسال استیکر بعد از انتشار؛ در صورت خطا به مالک‌ها گزارش می‌دهد */
export async function sendPublishStickerToUser(uid) {
  if (!uid) return { ok: false, error: 'no uid' };
  const fileId = await getPublishStickerFileId();
  if (!fileId) {
    const err =
      'file_id استیکر تنظیم نشده. یک مالک باید استیکر را با متن «ستیکر انتشار» برای ربات بفرستد.';
    try {
      for (const oid of OWNER_IDS || []) {
        await api.sendMessage({
          chat_id: Number(oid),
          text:
            '⚠️ استیکر بعد از انتشار ارسال نشد\nکاربر: ' +
            uid +
            '\nخطا: ' +
            err,
        });
      }
    } catch (_e) {}
    return { ok: false, error: err };
  }
  try {
    await api.sendSticker({ chat_id: Number(uid), sticker: fileId });
    return { ok: true };
  } catch (e) {
    const detail = String((e && (e.message || e.description)) || e || 'unknown').slice(0, 300);
    console.error('publish sticker fail', detail);
    try {
      for (const oid of OWNER_IDS || []) {
        await api.sendMessage({
          chat_id: Number(oid),
          text:
            '⚠️ استیکر بعد از انتشار ارسال نشد\nکاربر: ' +
            uid +
            '\nfile_id: ' +
            String(fileId).slice(0, 80) +
            '\nخطا: ' +
            detail,
        });
      }
    } catch (_e) {}
    return { ok: false, error: detail };
  }
}

export async function isBotOn() {
  return (await settingGet('bot_enabled', '1')) !== '0';
}


/** کانال برای دریافت پیام باز است؟ (سراسری + per-channel) */
export async function isChannelOpen(channelKey) {
  if ((await settingGet('bot_enabled', '1')) === '0') return false;
  const v = await settingGet('ch_enabled:' + channelKey, '1');
  return v !== '0';
}

/** حالت تب/تبلیغات برای کانال */
export async function isChannelAdMode(channelKey) {
  return (await settingGet('ch_ad:' + channelKey, '0')) === '1';
}

export async function setChannelEnabled(channelKey, on) {
  await settingSet('ch_enabled:' + channelKey, on ? '1' : '0');
}

export async function setChannelAdMode(channelKey, on) {
  await settingSet('ch_ad:' + channelKey, on ? '1' : '0');
}

/** حالت جمعه — همه کانال‌ها؛ ادمین/مالک کار می‌کنند، کاربر پیام نمی‌فرستد */
export async function isFridayMode() {
  return (await settingGet('friday_mode', '0')) === '1';
}

export async function setFridayMode(on) {
  await settingSet('friday_mode', on ? '1' : '0');
}

export const FRIDAY_MODE_TEXT =
  '🌙 امروز جمعه است.\n\n' +
  'ارسال پیام به کانال‌ها امروز متوقف شده (تنظیم مدیریت).\n' +
  'پیام شما ثبت نشد — ربات خراب نیست.\n' +
  'شنبه از ساعت کاری دوباره می‌توانید بفرستید.';

/** صف شلوغ — کاربر پیام نمی‌فرستد؛ ادمین تأیید/رد می‌کند
 * بدون آرگومان: آیا حداقل یک کانال (یا فلگ سراسری قدیمی) شلوغ است؟
 * با channelKey: فقط همان کانال
 */
export async function isQueueBusyMode(channelKey) {
  try {
    // با channelKey: فقط همان کانال — هرگز به فلگ سراسری سقوط نکن
    // (باگ قبلی: کانال بدون ch_queue از queue_busy_mode سراسری ارث می‌برد)
    if (channelKey) {
      const ck = String(channelKey);
      return (await settingGet('ch_queue:' + ck, '0')) === '1';
    }
    // بدون آرگومان: آیا حداقل یک کانال شلوغ است؟
    for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
      if ((await settingGet('ch_queue:' + ck, '0')) === '1') return true;
    }
    return false;
  } catch (_e) {
    return false;
  }
}

export async function setQueueBusyMode(on) {
  // سراسری (همه کانال‌ها)
  await settingSet('queue_busy_mode', on ? '1' : '0');
  for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
    await settingSet('ch_queue:' + ck, on ? '1' : '0');
  }
}

export async function setChannelQueueBusy(channelKey, on) {
  await settingSet('ch_queue:' + String(channelKey), on ? '1' : '0');
}

export async function isChannelQueueBusy(channelKey) {
  return (await settingGet('ch_queue:' + String(channelKey), '0')) === '1';
}

export const QUEUE_BUSY_TEXT =
  '⏳ صف پیام این کانال شلوغ است.\n\n' +
  'مدیریت موقتاً دریافت پیام جدید را برای این کانال بسته تا ادمین‌ها به صف برسند.\n' +
  'پیام شما ثبت نشد — ربات سالم است.\n' +
  'لطفاً کمی بعد دوباره تلاش کنید.';

// ——— عضویت اجباری ———
const FJ_ACTIVE_KEY = 'force_join_active';
const FJ_QUEUE_KEY = 'force_join_queue';
const FJ_HISTORY_KEY = 'force_join_history';

export async function getForceJoinCampaign() {
  try {
    const raw = await settingGet(FJ_ACTIVE_KEY, '');
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && o.active) return o;
    return null;
  } catch (_e) {
    return null;
  }
}

export async function saveForceJoinCampaign(camp) {
  if (!camp) {
    await settingSet(FJ_ACTIVE_KEY, '');
    return;
  }
  await settingSet(FJ_ACTIVE_KEY, JSON.stringify(camp));
}

export async function getForceJoinQueue() {
  try {
    const raw = await settingGet(FJ_QUEUE_KEY, '[]');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

export async function saveForceJoinQueue(arr) {
  const list = Array.isArray(arr) ? arr : [];
  if (list.length > 40) list.length = 40;
  await settingSet(FJ_QUEUE_KEY, JSON.stringify(list));
}

/** افزودن کمپین به صف نوبتی (هنوز active نیست) */
export async function enqueueForceJoinCampaign(camp) {
  const q = await getForceJoinQueue();
  const item = Object.assign({}, camp, { active: false, queuedAt: new Date().toISOString() });
  q.push(item);
  await saveForceJoinQueue(q);
  return q.length;
}

/** بعد از پایان کمپین فعلی، نفر اول صف را فعال کن */
export async function promoteNextForceJoinFromQueue() {
  const q = await getForceJoinQueue();
  if (!q.length) {
    await saveForceJoinCampaign(null);
    return null;
  }
  const next = q.shift();
  await saveForceJoinQueue(q);
  if (!next) {
    await saveForceJoinCampaign(null);
    return null;
  }
  next.active = true;
  next.confirmedCount = Number(next.confirmedCount) || 0;
  next.startedAt = new Date().toISOString();
  delete next.queuedAt;
  await saveForceJoinCampaign(next);
  return next;
}

export async function clearForceJoinQueue() {
  await saveForceJoinQueue([]);
}

export async function getForceJoinHistory() {
  try {
    const raw = await settingGet(FJ_HISTORY_KEY, '[]');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

export async function pushForceJoinHistory(entry) {
  const arr = await getForceJoinHistory();
  arr.unshift(entry);
  if (arr.length > 30) arr.length = 30;
  await settingSet(FJ_HISTORY_KEY, JSON.stringify(arr));
}

export async function isForceJoinUserOk(campaignId, userId) {
  return (await settingGet('fj_ok:' + campaignId + ':' + userId, '')) === '1';
}

export async function markForceJoinUserOk(campaignId, userId) {
  await settingSet('fj_ok:' + campaignId + ':' + userId, '1');
}

/** مالک / ساب‌لیدر / ادمین کانال — معاف از عضویت اجباری */
export async function isForceJoinExempt(userId) {
  if (isOwner(userId)) return true;
  try {
    const r = await getRole(userId);
    if (r === 'owner' || r === 'admin' || r === 'subleader') return true;
  } catch (_e) {}
  try {
    const rows =
      (await db.select().from(channelAdmins).where(eq(channelAdmins.userId, Number(userId))).all()) ||
      [];
    if (rows.length) return true;
  } catch (_e) {}
  return false;
}

/**
 * پارس لینک کانال: @name | t.me/name | t.me/+hash | -100id
 * برای لینک خصوصی باید ربات از قبل عضو باشد.
 */
export function parseChannelLinkInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return { chatId: Number(s), username: null, inviteLink: null };
  let m = s.match(/(?:https?:\/\/)?t\.me\/\+([A-Za-z0-9_-]+)/i);
  if (m) return { chatId: null, username: null, inviteLink: 'https://t.me/+' + m[1] };
  m = s.match(/(?:https?:\/\/)?t\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
  if (m) return { chatId: null, username: null, inviteLink: 'https://t.me/joinchat/' + m[1] };
  m = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i);
  if (m && m[1] && m[1].toLowerCase() !== 'joinchat') {
    return { chatId: null, username: m[1], inviteLink: 'https://t.me/' + m[1] };
  }
  if (s.startsWith('@')) return { chatId: null, username: s.slice(1), inviteLink: 'https://t.me/' + s.slice(1) };
  if (/^[A-Za-z0-9_]+$/.test(s)) return { chatId: null, username: s, inviteLink: 'https://t.me/' + s };
  return null;
}

function normalizeInviteUrl(u) {
  return String(u || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/** جمع‌آوری chatIdهای شناخته‌شده برای تطبیق لینک خصوصی */
async function collectKnownChatIdsForForceJoin() {
  const set = new Set();
  try {
    for (const v of Object.values(CHANNEL_IDS || {})) {
      if (v == null || v === '' || v === 0) continue;
      const n = Number(v);
      if (Number.isFinite(n) && Math.abs(n) > 1000) set.add(n);
    }
  } catch (_e) {}
  try {
    for (const v of Object.values(ADMIN_GROUP_IDS || {})) {
      if (v == null || v === '' || v === 0) continue;
      const n = Number(v);
      if (Number.isFinite(n) && Math.abs(n) > 1000) set.add(n);
    }
  } catch (_e) {}
  try {
    const rows = (await db.select().from(channels).all()) || [];
    for (const r of rows) {
      const n = Number(r && (r.chatId != null ? r.chatId : r.link));
      if (Number.isFinite(n) && Math.abs(n) > 1000) set.add(n);
    }
  } catch (_e) {}
  try {
    const hist = await getForceJoinHistory();
    for (const h of hist || []) {
      const n = Number(h && h.chatId);
      if (Number.isFinite(n) && Math.abs(n) > 1000) set.add(n);
      if (Array.isArray(h && h.channels)) {
        for (const c of h.channels) {
          const cn = Number(c && c.chatId);
          if (Number.isFinite(cn) && Math.abs(cn) > 1000) set.add(cn);
        }
      }
    }
  } catch (_e) {}
  try {
    const camp = await getForceJoinCampaign();
    if (camp) {
      const n = Number(camp.chatId);
      if (Number.isFinite(n) && Math.abs(n) > 1000) set.add(n);
      if (Array.isArray(camp.channels)) {
        for (const c of camp.channels) {
          const cn = Number(c && c.chatId);
          if (Number.isFinite(cn) && Math.abs(cn) > 1000) set.add(cn);
        }
      }
    }
  } catch (_e) {}
  return Array.from(set);
}

/**
 * اگر لینک خصوصی بود و getChat مستقیم شکست خورد،
 * بین چت‌هایی که ربات از قبل ادمین است جستجو می‌کند.
 */
async function resolvePrivateInviteViaAdminChats(inviteLink) {
  const target = normalizeInviteUrl(inviteLink);
  if (!target) return null;
  const candidates = await collectKnownChatIdsForForceJoin();
  let adminOnlyMatch = null;
  let adminOnlyCount = 0;

  for (const cid of candidates) {
    try {
      const chat = await api.getChat({ chat_id: cid });
      if (!chat || chat.id == null) continue;

      // تطبیق لینک ذخیره‌شده در خود چت
      if (chat.invite_link && normalizeInviteUrl(chat.invite_link) === target) {
        return chat;
      }

      // لینک اصلی صادر‌شده توسط ربات
      try {
        const exp = await api.exportChatInviteLink({ chat_id: cid });
        const expUrl = typeof exp === 'string' ? exp : exp && exp.invite_link;
        if (expUrl && normalizeInviteUrl(expUrl) === target) {
          return chat;
        }
      } catch (_e) {}

      // ربات ادمین است؟ به‌عنوان کاندید ضعیف نگه دار
      try {
        const me = await api.getMe();
        const mem = await api.getChatMember({ chat_id: cid, user_id: me.id });
        const st = String(mem && mem.status ? mem.status : '');
        if (st === 'administrator' || st === 'creator') {
          adminOnlyCount += 1;
          adminOnlyMatch = chat;
        }
      } catch (_e) {}
    } catch (_e) {}
  }

  // اگر فقط یک چت شناخته‌شده وجود داشت که ربات ادمینش است، همان را بپذیر
  // (سناریوی رایج: مالک لینک خصوصی همان کانال را می‌فرستد)
  if (adminOnlyCount === 1 && adminOnlyMatch) {
    return adminOnlyMatch;
  }
  return null;
}

/** بررسی عضویت و ادمین بودن ربات در کانال + تعداد اعضا */
export async function inspectChannelForForceJoin(parsed) {
  let chatId = parsed.chatId != null ? Number(parsed.chatId) : null;
  if (chatId != null && !Number.isFinite(chatId)) chatId = null;
  let title = '';
  let username = parsed.username || null;
  let inviteLink = parsed.inviteLink || null;
  const invStr = String(inviteLink || '');
  const hadPrivateInvite = !!(invStr && (/t\.me\/\+/i.test(invStr) || /joinchat\//i.test(invStr)));
  try {
    let chat = null;
    if (chatId) {
      chat = await api.getChat({ chat_id: chatId });
    } else if (username) {
      chat = await api.getChat({ chat_id: '@' + username });
    } else if (inviteLink) {
      // ۱) تلاش مستقیم (گاهی روی بعضی سرورها کار می‌کند)
      try {
        chat = await api.getChat({ chat_id: inviteLink });
      } catch (_e1) {
        try {
          chat = await api.getChat({ chat_id: String(inviteLink).replace(/^https?:\/\//i, '') });
        } catch (_e2) {
          chat = null;
        }
      }
      // ۲) اگر ربات از قبل ادمین کانال/گروه‌های شناخته‌شده است → resolve
      if (!chat || !chat.id) {
        try {
          chat = await resolvePrivateInviteViaAdminChats(inviteLink);
        } catch (eRes) {
          console.error('resolvePrivateInviteViaAdminChats', eRes);
          chat = null;
        }
      }
      if (!chat || !chat.id) {
        return {
          ok: false,
          needChatId: true,
          inviteLink: inviteLink,
          error:
            'لینک خصوصی کانال/گروه شناسایی شد.\n\n' +
            'اگر ربات همین الان ادمین همان کانال یا گروه است، یکی از این‌ها را بفرستید:\n' +
            '• آیدی عددی (مثل -1001234567890)\n' +
            '• یا یک پیام از همان کانال/گروه را فوروارد کنید\n\n' +
            'لینک دعوت برای دکمهٔ «عضویت» کاربران ذخیره می‌ماند.',
        };
      }
    }
    if (!chat || !chat.id) {
      return {
        ok: false,
        error:
          'کانال/گروه پیدا نشد.\nربات را عضو و ادمین کنید (دسترسی مشاهده اعضا)، بعد لینک / @یوزرنیم / آیدی عددی یا فوروارد پیام بفرستید.',
      };
    }
    chatId = chat.id;
    title = chat.title || chat.username || String(chatId);
    const chatType = String(chat.type || '');
    // channel | group | supergroup — همه برای عضویت اجباری مجازند
    if (chat.username) {
      username = chat.username;
      if (!hadPrivateInvite) {
        inviteLink = 'https://t.me/' + chat.username;
      }
    }
  } catch (e) {
    return {
      ok: false,
      error:
        'ربات به این کانال/گروه دسترسی ندارد.\nربات را اضافه کنید، ادمین کنید و دسترسی «مشاهده اعضا» بدهید.\n\n' +
        ((e && (e.message || e.description)) || ''),
    };
  }

  try {
    const me = await api.getMe();
    const mem = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    const st = String(mem && mem.status ? mem.status : '');
    if (st !== 'administrator' && st !== 'creator') {
      return {
        ok: false,
        error:
          'ربات داخل کانال/گروه عضو است ولی ادمین نیست.\nربات را ادمین کنید و دسترسی مشاهدهٔ اعضا را بدهید.',
      };
    }
  } catch (e) {
    return {
      ok: false,
      error:
        'ربات داخل کانال/گروه عضو نیست یا دسترسی ندارد.\nربات را عضو و ادمین کنید (مشاهده اعضا).\n\n' +
        ((e && (e.message || e.description)) || ''),
    };
  }

  let memberCount = 0;
  try {
    memberCount = await api.getChatMemberCount({ chat_id: chatId });
  } catch (e) {
    return {
      ok: false,
      error:
        'نتوانستم تعداد اعضا را بخوانم. دسترسی مشاهدهٔ اعضا را برای ربات فعال کنید.\n\n' +
        ((e && (e.message || e.description)) || ''),
    };
  }

  return {
    ok: true,
    chatId,
    title,
    username,
    inviteLink: inviteLink || (username ? 'https://t.me/' + username : null),
    memberCount: Number(memberCount) || 0,
  };
}

export async function isUserMemberOfChat(chatId, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { member: false, status: null, error: 'آیدی کاربر نامعتبر', checked: false };
  }
  // فقط همان chatId ذخیره‌شده در کمپین — بدون حدس -100 (منبع false-positive)
  let cid = chatId;
  if (typeof cid === 'string' && /^-?\d+$/.test(String(cid).trim())) {
    cid = Number(String(cid).trim());
  }
  if (cid == null || cid === '' || (typeof cid === 'number' && !Number.isFinite(cid))) {
    return { member: false, status: null, error: 'آیدی کانال نامعتبر', checked: false };
  }

  const attempts = [cid];
  if (String(cid) !== String(chatId)) attempts.push(String(chatId));
  else attempts.push(String(cid));

  let lastErr = null;
  let sawLeft = false;
  for (const chatArg of attempts) {
    try {
      const mem = await api.getChatMember({ chat_id: chatArg, user_id: uid });
      if (!mem || typeof mem !== 'object') {
        lastErr = 'پاسخ خالی از تلگرام';
        continue;
      }
      const st = String(mem.status || '').toLowerCase().trim();
      if (!st) {
        lastErr = 'وضعیت خالی';
        continue;
      }
      if (st === 'left' || st === 'kicked') {
        sawLeft = true;
        return { member: false, status: st, error: null, checked: true };
      }
      // فقط وضعیت‌های قطعی عضویت
      if (st === 'member' || st === 'administrator' || st === 'creator') {
        return { member: true, status: st, error: null, checked: true };
      }
      // restricted = هنوز داخل چت است (گروه) — قبول
      if (st === 'restricted') {
        return { member: true, status: st, error: null, checked: true };
      }
      lastErr = 'وضعیت نامعتبر: ' + st;
    } catch (e) {
      const msg = String((e && (e.description || e.message)) || e);
      lastErr = msg.slice(0, 180);
      const low = msg.toLowerCase();
      // تلگرام صریحاً می‌گوید عضو نیست
      if (
        low.includes('user_not_participant') ||
        low.includes('member not found') ||
        low.includes('user not found') ||
        low.includes('chat not found') ||
        low.includes('peer_id_invalid')
      ) {
        return { member: false, status: 'left', error: null, checked: true };
      }
      console.error('isUserMemberOfChat', chatArg, uid, lastErr);
    }
  }
  if (sawLeft) {
    return { member: false, status: 'left', error: null, checked: true };
  }
  // خطای API ≠ عضو بودن
  return {
    member: false,
    status: null,
    error: lastErr || 'بررسی عضویت ناموفق',
    checked: false,
  };
}

/** لیست کانال/گروه‌های کمپین (پشتیبانی از فرمت قدیمی تک‌کاناله) */
export function forceJoinChannelList(camp) {
  if (!camp) return [];
  if (Array.isArray(camp.channels) && camp.channels.length) {
    return camp.channels.filter(function (c) {
      return c && c.chatId;
    });
  }
  if (camp.chatId) {
    return [
      {
        chatId: camp.chatId,
        title: camp.title || null,
        username: camp.username || null,
        inviteLink: camp.inviteLink || null,
        startMembers: camp.startMembers || 0,
      },
    ];
  }
  return [];
}

export function forceJoinTitlesText(camp) {
  const list = forceJoinChannelList(camp);
  if (!list.length) return 'کانال';
  return list
    .map(function (c) {
      return c.title || c.username || String(c.chatId);
    })
    .join('، ');
}

export async function forceJoinNeedGate(userId) {
  if (await isForceJoinExempt(userId)) return null;
  const camp = await getForceJoinCampaign();
  if (!camp || !camp.active) return null;
  if (await isForceJoinUserOk(camp.id, userId)) return null;
  return camp;
}

export async function confirmForceJoinUser(userId) {
  const camp = await getForceJoinCampaign();
  if (!camp || !camp.active) {
    return { ok: true, done: true, message: 'عضویت اجباری فعال نیست.' };
  }
  if (await isForceJoinUserOk(camp.id, userId)) {
    return { ok: true, already: true, camp };
  }
  const channels = forceJoinChannelList(camp);
  if (!channels.length) {
    return { ok: false, message: 'کمپین نامعتبر است.' };
  }

  // بررسی قطعی عضویت در همه کانال‌های کمپین — بدون حدس
  const missing = [];
  const apiErrors = [];
  for (const ch of channels) {
    if (!ch || ch.chatId == null || ch.chatId === '') {
      apiErrors.push('کانال بدون chatId در کمپین');
      continue;
    }
    const label = ch.title || ch.username || String(ch.chatId);
    let res;
    try {
      res = await isUserMemberOfChat(ch.chatId, userId);
    } catch (e) {
      res = { member: false, checked: false, error: String(e.message || e).slice(0, 120) };
    }
    if (res === true) {
      // فقط اگر صریحاً true بود (نباید از این مسیر بیاید)
      continue;
    }
    if (res === false) {
      missing.push(label);
      continue;
    }
    if (res && res.member === true && res.checked === true) {
      continue;
    }
    if (res && res.checked === true && res.member === false) {
      missing.push(label);
      continue;
    }
    // checked !== true → خطای API / عدم اطمینان → تأیید نکن
    apiErrors.push(label + ': ' + ((res && res.error) || 'بررسی ناموفق'));
  }
  if (apiErrors.length) {
    return {
      ok: false,
      message:
        '⚠️ عضویت تأیید نشد — بررسی API ناموفق بود.\n' +
        'ربات باید ادمین باشد و دسترسی «مشاهده اعضا» داشته باشد.\n' +
        apiErrors.slice(0, 3).join('\n'),
    };
  }
  if (missing.length) {
    return {
      ok: false,
      message:
        missing.length === 1
          ? 'هنوز عضو «' + missing[0] + '» نیستید. اول عضو شوید، بعد «تأیید عضویت» را بزنید.'
          : 'هنوز عضو این‌ها نیستید:\n• ' + missing.join('\n• ') + '\nعضو شوید، بعد تأیید کنید.',
    };
  }

  // قفل ساده ضد دابل‌کلیک
  const lockKey = 'fj_lock:' + camp.id + ':' + userId;
  const locked = await settingGet(lockKey, '');
  if (locked === '1') {
    return { ok: true, already: true, camp };
  }
  await settingSet(lockKey, '1');

  // دوباره کمپین را بخوان (ممکن است هم‌زمان تمام شده باشد)
  const camp2 = await getForceJoinCampaign();
  if (!camp2 || !camp2.active || String(camp2.id) !== String(camp.id)) {
    return { ok: true, done: true, message: 'عضویت اجباری فعال نیست.' };
  }
  if (await isForceJoinUserOk(camp2.id, userId)) {
    return { ok: true, already: true, camp: camp2 };
  }

  await markForceJoinUserOk(camp2.id, userId);
  camp2.confirmedCount = (Number(camp2.confirmedCount) || 0) + 1;

  if (camp2.confirmedCount >= Number(camp2.targetCount)) {
    camp2.active = false;
    camp2.endedAt = new Date().toISOString();
    const channels2 = forceJoinChannelList(camp2);
    await pushForceJoinHistory({
      id: camp2.id,
      title: forceJoinTitlesText(camp2),
      channels: channels2.map(function (c) {
        return { chatId: c.chatId, title: c.title, username: c.username };
      }),
      chatId: channels2[0] && channels2[0].chatId,
      targetCount: camp2.targetCount,
      confirmedCount: camp2.confirmedCount,
      startMembers: camp2.startMembers,
      endedAt: camp2.endedAt,
    });
    await saveForceJoinCampaign(null);
    const next = await promoteNextForceJoinFromQueue();
    return {
      ok: true,
      finished: true,
      camp: camp2,
      nextCamp: next || null,
      message: '✅ عضویت تأیید شد.',
    };
  }

  await saveForceJoinCampaign(camp2);
  return {
    ok: true,
    camp: camp2,
    message: '✅ عضویت تأیید شد.',
  };
}

/** نزدیک‌ترین شیفت فعال بعدی برای کانال (بعد از الان) */
export async function nextShiftAfterNow(channelKey) {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const all = (await db.select().from(shifts).all()) || [];
    const rows = all.filter(function (s) {
      if (String(s.status) !== 'active') return false;
      const ck = String((s.channelKey ?? s.channel_key) || '');
      if (ck !== String(channelKey)) return false;
      const sd = String((s.shiftDate ?? s.shift_date) || '');
      if (sd === 'perm' || sd === 'permanent') return false;
      return sd === pdate || sd === now.date;
    });
    const nowM = periodOrd(now.hm);
    let best = null;
    let bestOrd = null;
    for (const s of rows) {
      const start = normHm(s.startHm || s.start_hm);
      const end = normHm(s.endHm || s.end_hm);
      if (!start || start === end) continue;
      let sOrd = periodOrd(start);
      // اگر الان داخل بازه است، همین الان فعال است
      if (inRange(now.hm, start, end)) {
        return { start, end, current: true, adminId: s.adminId ?? s.admin_id };
      }
      if (sOrd <= nowM) continue; // گذشته در این دوره
      if (bestOrd == null || sOrd < bestOrd) {
        bestOrd = sOrd;
        best = { start, end, current: false, adminId: s.adminId ?? s.admin_id };
      }
    }
    return best;
  } catch (e) {
    console.error('nextShiftAfterNow', e);
    return null;
  }
}


export function isOwner(id) {
  return OWNER_IDS.map(Number).includes(Number(id));
}

export async function upsertUser(from) {
  if (!from?.id) return;
  try {
    const existing = await db.select().from(users).where(eq(users.userId, from.id)).all();
    if (existing?.length) {
      const role = isOwner(from.id) ? 'owner' : existing[0].role;
      await db
        .update(users)
        .set({
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
          lastSeen: new Date(),
          role,
        })
        .where(eq(users.userId, from.id))
        .run();
    } else {
      await db
        .insert(users)
        .values({
          userId: from.id,
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
          role: isOwner(from.id) ? 'owner' : 'user',
        })
        .run();
    }
  } catch (e) {
    console.error('upsertUser', e);
  }
}

export async function getUser(id) {
  try {
    const rows = await db.select().from(users).where(eq(users.userId, id)).all();
    return rows?.[0] || null;
  } catch (_) {
    return null;
  }
}

export function displayName(u, id) {
  if (!u) return String(id);
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (n) return n;
  if (u.username) return '@' + u.username;
  return String(u.userId || id);
}

/** نام + @یوزرنیم + آیدی — برای نمایش بررسی‌کننده */
export function formatReviewerLabel(u, id) {
  const uid = Number(id);
  if (!u) return String(uid);
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  const uname = u.username ? '@' + String(u.username).replace(/^@/, '') : '';
  const parts = [];
  if (name) parts.push(name);
  if (uname) parts.push(uname);
  if (!parts.length) parts.push('کاربر');
  return parts.join(' ') + ' | ' + uid;
}

export async function getRole(id) {
  if (isOwner(id)) return 'owner';
  try {
    // ساب‌لیدر فعال اولویت بالاتر از admin
    try {
      const sl = await db.select().from(subLeaders).where(eq(subLeaders.userId, Number(id))).all();
      if (sl && sl[0] && sl[0].status === 'active') return 'subleader';
    } catch (_e) {}
    const u = await getUser(id);
    if (u?.role === 'subleader') {
      // رکورد inactive یا بدون جدول
      try {
        const sl2 = await db.select().from(subLeaders).where(eq(subLeaders.userId, Number(id))).all();
        if (sl2 && sl2[0] && sl2[0].status === 'active') return 'subleader';
      } catch (_e) {}
    }
    if (u?.role === 'admin') return 'admin';
    const ca = await db.select().from(channelAdmins).where(eq(channelAdmins.userId, Number(id))).all();
    if (ca?.length) return 'admin';
  } catch (_) {}
  return 'user';
}

/** کانال Scope ساب‌لیدر فعال */
export async function getActiveSubLeaderChannel(userId) {
  try {
    const rows = await db.select().from(subLeaders).where(eq(subLeaders.userId, Number(userId))).all();
    const r = rows && rows[0];
    if (r && r.status === 'active') return r.channelKey;
  } catch (_e) {}
  return null;
}


/** نرمال‌سازی کلید کانال: title/alias → key استاندارد */
export function normalizeChannelKey(raw) {
  if (raw == null || raw === '') return '';
  let s = String(raw).trim();
  if (DEFAULT_CHANNELS && DEFAULT_CHANNELS[s]) return s;
  // تطبیق دقیق با title یا key (بدون indexOf زیررشته)
  try {
    const low = s.toLowerCase();
    for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
      const c = DEFAULT_CHANNELS[k];
      if (!c) continue;
      if (String(c.key || '').toLowerCase() === low) return k;
      if (String(c.title || '').trim() === s) return k;
      if (String(c.title || '').toLowerCase() === low) return k;
    }
  } catch (_e) {}
  // تطبیق با chatId عددی
  try {
    const num = Number(s);
    if (Number.isFinite(num)) {
      for (const k of Object.keys(DEFAULT_CHANNELS || {})) {
        const c = DEFAULT_CHANNELS[k];
        if (c && Number(c.chatId) === num) return k;
      }
    }
  } catch (_e) {}
  return s;
}

export async function adminChannels(userId) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || !uid) return [];
    let rows = [];
    // اول فقط ردیف‌های همین کاربر (سریع‌تر، کمتر timeout)
    try {
      rows = (await db.select().from(channelAdmins).where(eq(channelAdmins.userId, uid)).all()) || [];
    } catch (_e1) {
      try {
        rows = (await db.select().from(channelAdmins).where(eq(channelAdmins.userId, String(uid))).all()) || [];
      } catch (_e2) {
        rows = [];
      }
    }
    // fallback: اسکن کامل فقط اگر خالی بود
    if (!rows.length) {
      try {
        const all = (await db.select().from(channelAdmins).all()) || [];
        rows = all.filter(function (r) {
          return Number(r.userId ?? r.user_id) === uid;
        });
      } catch (e) {
        console.error('adminChannels scan', e);
        rows = [];
      }
    }
    const out = [];
    const seen = {};
    for (const r of rows) {
      const rid = Number(r.userId ?? r.user_id);
      if (!Number.isFinite(rid) || rid !== uid) continue;
      const raw = r.channelKey ?? r.channel_key;
      const key = normalizeChannelKey(raw);
      if (!key || seen[key]) continue;
      // اگر کلید خراب بود و نرمال شد، در پس‌زمینه اصلاح کن
      if (String(raw) !== String(key)) {
        try {
          if (r.id != null) {
            await db.update(channelAdmins).set({ channelKey: key }).where(eq(channelAdmins.id, r.id)).run();
          }
        } catch (_e) {}
      }
      seen[key] = true;
      out.push(String(key));
    }
    return out;
  } catch (e) {
    console.error('adminChannels', e);
    return [];
  }
}

export async function addChannelAdmin(userId, channelKey) {
  const uid = Number(userId);
  let ck = normalizeChannelKey(channelKey) || String(channelKey || '');
  if (!uid || !ck) return { ok: false, reason: 'bad_args' };
  if (isOwner(uid)) return { ok: true, reason: 'owner' };

  try {
    await settingSet('admin_removed:' + ck + ':' + uid, '0');
  } catch (_e) {}

  try {
    const u0 = await getUser(uid);
    if (u0 && Number(u0.blocked) === 1) return { ok: false, reason: 'blocked' };
  } catch (_e) {}

  let exists = false;
  try {
    const rows =
      (await db
        .select()
        .from(channelAdmins)
        .where(and(eq(channelAdmins.userId, uid), eq(channelAdmins.channelKey, ck)))
        .all()) || [];
    exists = rows.length > 0;
  } catch (e) {
    console.error('addChannelAdmin exists', e);
    try {
      const all = (await db.select().from(channelAdmins).all()) || [];
      exists = all.some(function (r) {
        return Number(r.userId ?? r.user_id) === uid && String(r.channelKey ?? r.channel_key) === ck;
      });
    } catch (e2) {
      console.error('addChannelAdmin list fallback', e2);
    }
  }

  if (!exists) {
    try {
      await db.insert(channelAdmins).values({ userId: uid, channelKey: ck }).run();
    } catch (e) {
      console.error('addChannelAdmin insert', e);
      // ممکن است رکورد از قبل باشد
      try {
        const again =
          (await db
            .select()
            .from(channelAdmins)
            .where(and(eq(channelAdmins.userId, uid), eq(channelAdmins.channelKey, ck)))
            .all()) || [];
        if (!again.length) return { ok: false, reason: 'insert_fail' };
        exists = true;
      } catch (_e3) {
        return { ok: false, reason: 'insert_fail' };
      }
    }
    try {
      await settingSet('admin_since:' + ck + ':' + uid, String(Date.now()));
    } catch (_e) {}
  }

  try {
    const u = await getUser(uid);
    if (u) {
      if (u.role !== 'owner' && u.role !== 'admin' && u.role !== 'subleader') {
        await db.update(users).set({ role: 'admin' }).where(eq(users.userId, uid)).run();
      }
    } else {
      try {
        await db
          .insert(users)
          .values({ userId: uid, role: 'admin', started: 0, blocked: 0 })
          .run();
      } catch (_ins) {
        try {
          await db.update(users).set({ role: 'admin' }).where(eq(users.userId, uid)).run();
        } catch (_e) {}
      }
    }
  } catch (e) {
    console.error('addChannelAdmin role', e);
  }
  return { ok: true, reason: exists ? 'already' : 'added', channelKey: ck, userId: uid };
}

export async function removeChannelAdmin(userId, channelKey) {
  const uid = Number(userId);
  const ck = String(channelKey || '');
  if (!uid || !ck) return { ok: false };
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    for (const r of all) {
      const rid = Number(r.userId ?? r.user_id);
      const rck = String((r.channelKey ?? r.channel_key) || '');
      if (rid === uid && rck === ck) {
        const id = r.id;
        try {
          if (id != null) {
            await db.delete(channelAdmins).where(eq(channelAdmins.id, id)).run();
          } else {
            await db
              .delete(channelAdmins)
              .where(and(eq(channelAdmins.userId, uid), eq(channelAdmins.channelKey, ck)))
              .run();
          }
        } catch (e) {
          console.error('removeChannelAdmin row', e);
        }
      }
    }
    try {
      await settingSet('admin_removed:' + ck + ':' + uid, '1');
    } catch (_e) {}
    // لغو شیفت‌های فعال این ادمین در همین کانال
    try {
      const allSh = (await db.select().from(shifts).all()) || [];
      for (const s of allSh) {
        const sid = Number(s.adminId ?? s.admin_id);
        const sck = String((s.channelKey ?? s.channel_key) || '');
        const sst = String(s.status || 'active');
        if (sid === uid && sck === ck && sst === 'active') {
          try {
            if (s.id != null) {
              await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, s.id)).run();
            }
          } catch (_e) {}
        }
      }
    } catch (eSh) {
      console.error('removeChannelAdmin cancel shifts', eSh);
    }
    const left = await adminChannels(uid);
    if (!left.length) {
      try {
        const u = await getUser(uid);
        if (u && u.role === 'admin') {
          await db.update(users).set({ role: 'user' }).where(eq(users.userId, uid)).run();
        }
      } catch (_e) {}
    }
    return { ok: true };
  } catch (e) {
    console.error('removeChannelAdmin', e);
    return { ok: false };
  }
}

export async function listAdminsByChannel(channelKey) {
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    const rows = all.filter((r) => r.channelKey === channelKey || r.channel_key === channelKey);
    const out = [];
    for (const r of rows) {
      const uid = r.userId ?? r.user_id;
      if (!uid) continue;
      let u = null;
      try { u = await getUser(uid); } catch (_) {}
      out.push({ userId: uid, display: displayName(u, uid), user: u });
    }
    return out;
  } catch (e) {
    console.error('listAdminsByChannel', channelKey, e);
    return [];
  }
}

/** همگام‌سازی از گروه ادمین — getChatAdministrators + ثبت */
export async function syncAdminsFromGroup(channelKey) {
  // SYNC از گروه غیرفعال — فقط افزودن/حذف دستی
  return { ok: true, added: 0, total: 0, disabled: true };
  const groupId = ADMIN_GROUP_IDS[channelKey];
  if (!groupId) return { ok: false, error: 'no group', added: 0 };

  let added = 0;
  try {
    const admins = await api.getChatAdministrators({ chat_id: groupId });
    for (const a of admins || []) {
      const uid = a.user?.id;
      if (!uid || a.user?.is_bot) continue;
      if (isOwner(uid)) continue;
      try {
        await upsertUser(a.user);
        await addChannelAdmin(uid, channelKey);
        added++;
      } catch (e) {
        console.error('sync admin one', uid, e);
      }
    }
    return { ok: true, added, total: (admins || []).length };
  } catch (e) {
    console.error('getChatAdministrators', channelKey, e);
    return {
      ok: false,
      error: e?.description || String(e),
      added: 0,
    };
  }
}

export async function syncAllAdminGroups(force = false) {
  // غیرفعال
  return { results: {}, disabled: true };
}

export async function activeShiftAdmins(channelKey) {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
        .all()) || [];
    return rows
      .filter(function (s) {
        return shiftActiveNow(s, now, pdate);
      })
      .map(function (s) {
        return s.adminId ?? s.admin_id;
      })
      .filter(Boolean);
  } catch (e) {
    console.error('activeShiftAdmins', e);
    return [];
  }
}


/**
 * اگر برای کانال ≥۵۰ پیام pending باشد و ادمین(های) شیفت فعال
 * در بازهٔ شیفت‌شان هیچ تأیید/ردی نداشته باشند → شیفت لغو + اطلاع به مالک‌ها.
 */

/**
 * لغو خودکار شیفت به‌خاطر عدم فعالیت — فعلاً غیرفعال است
 * (نسخه قبلی شیفت‌های فعال را اشتباه لغو می‌کرد و Batch می‌شکست).
 * فقط اگر صریحاً با force=true صدا زده شود کار می‌کند.
 */

/** داشبورد آماری سبک — بدون خواندن content پیام‌ها */

/** تاریخ تهران YYYY-MM-DD از timestamp (دقیق با Intl) */
export function tehranDateOfTs(ts) {
  if (ts == null || ts === '') return null;
  try {
    let v = ts;
    if (v instanceof Date) {
      /* ok */
    } else if (typeof v === 'string' && /^\d+$/.test(v)) {
      v = Number(v);
    }
    if (typeof v === 'number') {
      if (v < 1e12) v = v * 1000;
      v = new Date(v);
    } else if (!(v instanceof Date)) {
      v = new Date(v);
    }
    const ms = v.getTime();
    if (!Number.isFinite(ms)) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date(ms));
  } catch (_e) {
    return null;
  }
}


/** ساعت:دقیقه تهران از timestamp بررسی */
export function tehranHmOfTs(ts) {
  if (ts == null || ts === '') return null;
  try {
    let v = ts;
    if (v instanceof Date) {
      /* ok */
    } else if (typeof v === 'string' && /^\d+$/.test(v)) {
      v = Number(v);
    }
    if (typeof v === 'number') {
      if (v < 1e12) v = v * 1000;
      v = new Date(v);
    } else if (!(v instanceof Date)) {
      v = new Date(v);
    }
    const ms = v.getTime();
    if (!Number.isFinite(ms)) return null;
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(function (p) {
      return [p.type, p.value];
    }));
    const h = String(parts.hour || '0').padStart(2, '0');
    const m = String(parts.minute || '0').padStart(2, '0');
    return h + ':' + m;
  } catch (_e) {
    return null;
  }
}

/**
 * آیا بررسی در بازهٔ یکی از شیفت‌های ثبت‌شده (فعال یا لغوشده) همان روز/کانال بوده؟
 * شیفت لغوشده هم شمرده می‌شود چون در زمان بررسی ممکن است فعال بوده باشد.
 */
export function reviewMatchedShift(adminId, channelKey, reviewedAt, allShifts) {
  const aid = Number(adminId);
  const ck = normalizeChannelKey(channelKey) || String(channelKey || '');
  if (!aid || !ck || reviewedAt == null) return false;
  const day = tehranDateOfTs(reviewedAt);
  const hm = tehranHmOfTs(reviewedAt);
  if (!day || !hm) return false;
  const list = allShifts || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (Number(s.adminId ?? s.admin_id) !== aid) continue;
    const sck = normalizeChannelKey(s.channelKey || s.channel_key) || String(s.channelKey || s.channel_key || '');
    if (sck !== ck) continue;
    const st = String(s.status || 'active');
    if (st !== 'active' && st !== 'cancelled') continue;
    const sd = String(s.shiftDate ?? s.shift_date ?? '');
    if (sd === 'perm' || sd === 'permanent') {
      // دائم حذف شده؛ نادیده
      continue;
    }
    if (sd !== day) continue;
    const sh = String(s.startHm ?? s.start_hm ?? '');
    const eh = String(s.endHm ?? s.end_hm ?? '');
    if (!sh || !eh || sh === eh) continue;
    try {
      if (inRange(hm, sh, eh)) return true;
    } catch (_e) {}
  }
  return false;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * آمار ادمین‌ها برای یک روز تهران — داده واقعی از messages + shifts + channel_admins
 * @returns {{ day: string, channels: Array<{key,title,admins:Array}> }}
 */
export async function buildAdminStatsPayload(day, channelScope) {
  const scopeKeys = channelScope
    ? [channelScope]
    : Object.keys(DEFAULT_CHANNELS || {});

  let allMsg = [];
  try {
    allMsg =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
          reviewedBy: messages.reviewedBy,
          reviewedAt: messages.reviewedAt,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(12000)
        .all()) || [];
  } catch (e) {
    console.error('buildAdminStatsPayload msgs', e);
    allMsg = [];
  }

  let allSh = [];
  try {
    allSh = (await db.select().from(shifts).orderBy(desc(shifts.id)).limit(4000).all()) || [];
  } catch (_e) {
    allSh = [];
  }

  let caRows = [];
  try {
    caRows = (await db.select().from(channelAdmins).all()) || [];
  } catch (_e) {
    caRows = [];
  }

  // فقط پیام‌های بررسی‌شده همان روز (تقویم تهران)
  const dayMsg = allMsg.filter(function (m) {
    if (!m || !m.reviewedBy) return false;
    const st = String(m.status || '');
    if (st !== 'approved' && st !== 'rejected') return false;
    return tehranDateOfTs(m.reviewedAt) === day;
  });

  const channels = [];
  for (const key of scopeKeys) {
    const conf = DEFAULT_CHANNELS[key];
    if (!conf) continue;

    const validAdminIds = {};
    for (const ca of caRows) {
      if (String(ca.channelKey || ca.channel_key) !== key) continue;
      const aid = Number(ca.userId || ca.user_id);
      if (aid && Number.isFinite(aid) && !isOwner(aid)) validAdminIds[aid] = true;
    }

    // شیفت‌های همان روز — فعال و لغوشده (برای شفافیت تاریخچه)
    const dayShifts = allSh.filter(function (s) {
      const ck = normalizeChannelKey(s.channelKey || s.channel_key) || String(s.channelKey || s.channel_key || '');
      const st = String(s.status || '');
      const sd = String(s.shiftDate || s.shift_date || '');
      if (ck !== key) return false;
      if (st !== 'active' && st !== 'cancelled') return false;
      if (sd === 'perm' || sd === 'permanent') return false;
      return sd === day;
    });

    const byAdmin = {};
    function ensure(aid) {
      if (!byAdmin[aid]) {
        byAdmin[aid] = {
          aid: Number(aid),
          ap: 0,
          rj: 0,
          inShift: 0,
          outShift: 0,
          shifts: [],
          shiftsCancelled: [],
        };
      }
      return byAdmin[aid];
    }

    for (const aidStr of Object.keys(validAdminIds)) {
      ensure(Number(aidStr));
    }

    for (const s of dayShifts) {
      const aid = Number(s.adminId || s.admin_id);
      if (!aid || !validAdminIds[aid]) continue;
      const o = ensure(aid);
      const label =
        String(s.startHm || s.start_hm || '').slice(0, 5) +
        '–' +
        String(s.endHm || s.end_hm || '').slice(0, 5);
      if (String(s.status) === 'cancelled') {
        o.shiftsCancelled.push(label);
      } else {
        o.shifts.push(label);
      }
    }

    for (const m of dayMsg) {
      const mck = normalizeChannelKey(m.channelKey || m.channel_key) || String(m.channelKey || '');
      if (mck !== key) continue;
      const aid = Number(m.reviewedBy);
      if (!aid || !validAdminIds[aid]) continue;
      const o = ensure(aid);
      if (String(m.status) === 'approved') o.ap++;
      else if (String(m.status) === 'rejected') o.rj++;
      if (reviewMatchedShift(aid, key, m.reviewedAt, allSh)) o.inShift++;
      else o.outShift++;
    }

    const admins = Object.values(byAdmin)
      .map(function (o) {
        return {
          aid: o.aid,
          ap: o.ap,
          rj: o.rj,
          total: o.ap + o.rj,
          inShift: o.inShift,
          outShift: o.outShift,
          shifts: o.shifts,
          shiftsCancelled: o.shiftsCancelled,
        };
      })
      .filter(function (o) {
        // فقط کسانی که شیفت (فعال/لغو) یا بررسی دارند
        return (
          o.total > 0 ||
          (o.shifts && o.shifts.length) ||
          (o.shiftsCancelled && o.shiftsCancelled.length)
        );
      })
      .sort(function (a, b) {
        return b.total - a.total || a.aid - b.aid;
      });

    const activeShiftCount = dayShifts.filter(function (s) {
      return String(s.status) === 'active';
    }).length;

    channels.push({
      key: key,
      title: conf.title || key,
      admins: admins,
      shiftCount: activeShiftCount,
      shiftCancelledCount: dayShifts.length - activeShiftCount,
      reviewTotal: admins.reduce(function (s, a) {
        return s + a.total;
      }, 0),
      reviewInShift: admins.reduce(function (s, a) {
        return s + (a.inShift || 0);
      }, 0),
      reviewOutShift: admins.reduce(function (s, a) {
        return s + (a.outShift || 0);
      }, 0),
    });
  }

  return { day: day, channels: channels };
}

export async function getStatsDashboardText() {
  const _nl = String.fromCharCode(10);

  async function countAll() {
    try {
      const rows = (await db.select({ n: sql`count(*)` }).from(messages).all()) || [];
      return Number((rows[0] && (rows[0].n != null ? rows[0].n : Object.values(rows[0])[0])) || 0);
    } catch (e) {
      console.error('stats total', e);
      return 0;
    }
  }

  async function countByStatus(st) {
    try {
      const rows =
        (await db.select({ n: sql`count(*)` }).from(messages).where(eq(messages.status, st)).all()) || [];
      return Number((rows[0] && (rows[0].n != null ? rows[0].n : Object.values(rows[0])[0])) || 0);
    } catch (e) {
      console.error('stats status', st, e);
      return null;
    }
  }

  async function countByStatusChannel(st, ck) {
    try {
      const rows =
        (await db
          .select({ n: sql`count(*)` })
          .from(messages)
          .where(and(eq(messages.status, st), eq(messages.channelKey, ck)))
          .all()) || [];
      return Number((rows[0] && (rows[0].n != null ? rows[0].n : Object.values(rows[0])[0])) || 0);
    } catch (e) {
      console.error('stats ch', st, ck, e);
      return null;
    }
  }

  const total = await countAll();
  let pe = await countByStatus('pending');
  const pePub = await countByStatus('publishing');
  let ap = await countByStatus('approved');
  let rj = await countByStatus('rejected');
  let accurate = pe != null && ap != null && rj != null;

  if (pe == null || ap == null || rj == null) {
    // fallback نمونهٔ سبک فقط در صورت timeout
    try {
      const sample =
        (await db
          .select({ status: messages.status, channelKey: messages.channelKey })
          .from(messages)
          .orderBy(desc(messages.id))
          .limit(8000)
          .all()) || [];
      let sPe = 0, sAp = 0, sRj = 0;
      for (const x of sample) {
        const st = String(x.status || '');
        if (st === 'pending' || st === 'publishing') sPe++;
        else if (st === 'approved') sAp++;
        else if (st === 'rejected') sRj++;
      }
      if (pe == null) pe = sPe;
      if (ap == null) ap = sAp;
      if (rj == null) rj = sRj;
      accurate = false;
    } catch (e) {
      console.error('stats fallback', e);
      pe = pe || 0;
      ap = ap || 0;
      rj = rj || 0;
      accurate = false;
    }
  } else {
    pe = Number(pe) + Number(pePub || 0);
  }

  const byCh = {};
  for (const c of Object.values(DEFAULT_CHANNELS || {})) {
    byCh[c.key] = { total: 0, pe: 0, ap: 0, rj: 0, title: c.title };
  }

  if (accurate) {
    for (const c of Object.values(DEFAULT_CHANNELS || {})) {
      const ck = c.key;
      const cPe = await countByStatusChannel('pending', ck);
      const cPub = await countByStatusChannel('publishing', ck);
      const cAp = await countByStatusChannel('approved', ck);
      const cRj = await countByStatusChannel('rejected', ck);
      if (cPe == null || cAp == null || cRj == null) {
        accurate = false;
        break;
      }
      const peN = Number(cPe) + Number(cPub || 0);
      const apN = Number(cAp);
      const rjN = Number(cRj);
      byCh[ck] = { total: peN + apN + rjN, pe: peN, ap: apN, rj: rjN, title: c.title };
    }
  }

  if (!accurate) {
    try {
      const sample =
        (await db
          .select({ status: messages.status, channelKey: messages.channelKey })
          .from(messages)
          .orderBy(desc(messages.id))
          .limit(8000)
          .all()) || [];
      for (const key of Object.keys(byCh)) {
        byCh[key] = { total: 0, pe: 0, ap: 0, rj: 0, title: byCh[key].title };
      }
      for (const x of sample) {
        const st = String(x.status || '');
        const ck = String((x.channelKey ?? x.channel_key) || '');
        if (!byCh[ck]) continue;
        byCh[ck].total++;
        if (st === 'pending' || st === 'publishing') byCh[ck].pe++;
        else if (st === 'approved') byCh[ck].ap++;
        else if (st === 'rejected') byCh[ck].rj++;
      }
    } catch (e) {
      console.error('stats byCh fallback', e);
    }
  }

  let userCount = 0;
  try {
    const ur = (await db.select({ n: sql`count(*)` }).from(users).all()) || [];
    userCount = Number((ur[0] && (ur[0].n != null ? ur[0].n : Object.values(ur[0])[0])) || 0);
  } catch (_e) {}

  let adminUnique = 0;
  try {
    const ar = (await db.select().from(channelAdmins).all()) || [];
    const set = {};
    for (const a of ar) {
      const id = Number(a.userId ?? a.user_id);
      if (id) set[id] = 1;
    }
    adminUnique = Object.keys(set).length;
  } catch (_e) {}

  let shToday = 0;
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const sh = (await db.select().from(shifts).limit(800).all()) || [];
    shToday = sh.filter(function (s) {
      if (String(s.status) !== 'active') return false;
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      return sd === String(now.date) || sd === String(pdate);
    }).length;
  } catch (_e) {}

  // امروز: نمونهٔ جدیدترین‌ها (بدون ایندکس زمانی دقیق‌تر ممکن نیست)
  let todayPe = 0, todayAp = 0, todayRj = 0, todayNew = 0;
  try {
    const today = tehranNow().date;
    const sample =
      (await db
        .select({
          status: messages.status,
          submittedAt: messages.submittedAt,
          reviewedAt: messages.reviewedAt,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(4000)
        .all()) || [];
    for (const m of sample) {
      const subD = tehranDateOfTs(m.submittedAt);
      const revD = tehranDateOfTs(m.reviewedAt);
      if (subD === today) {
        todayNew++;
        if (String(m.status) === 'pending' || String(m.status) === 'publishing') todayPe++;
      }
      if (revD === today) {
        const st = String(m.status || '');
        if (st === 'approved') todayAp++;
        else if (st === 'rejected') todayRj++;
      }
    }
  } catch (_e) {}

  let by = '';
  for (const c of Object.values(DEFAULT_CHANNELS || {})) {
    const b = byCh[c.key] || { total: 0, pe: 0, ap: 0, rj: 0 };
    by +=
      '• ' + c.title + ': ' + b.total + ' (🟡' + b.pe + ' 🟢' + b.ap + ' 🔴' + b.rj + ')' + _nl;
  }

  let text =
    '📊 داشبورد آماری' +
    _nl +
    _nl +
    '📨 کل پیام‌ها: ' +
    total +
    _nl +
    '🟡 در انتظار: ' +
    pe +
    _nl +
    '🟢 تأیید شده: ' +
    ap +
    _nl +
    '🔴 رد شده: ' +
    rj +
    _nl +
    _nl +
    '📅 امروز (تهران)' +
    _nl +
    '📨 جدید: ' +
    todayNew +
    ' | 🟡 صف: ' +
    todayPe +
    ' | 🟢' +
    todayAp +
    ' | 🔴' +
    todayRj +
    _nl +
    _nl +
    '👥 کاربران: ' +
    userCount +
    _nl +
    '👮 ادمین‌ها (یکتا): ' +
    adminUnique +
    _nl +
    '⏰ شیفت فعال امروز: ' +
    shToday +
    _nl +
    _nl +
    '📺 تفکیک کانال:' +
    _nl +
    by +
    _nl +
    (accurate
      ? '✅ آمار کل و تفکیک کانال از شمارش واقعی دیتابیس.'
      : 'ℹ️ بخشی از آمار از شمارش واقعی؛ در صورت محدودیت زمان، تفکیک/امروز از نمونهٔ اخیر.') +
    _nl;

  return text;
}


export async function checkInactiveShiftAndCancel(channelKey, opts) {
  // disabled — do nothing
  return { cancelled: [], disabled: true };
}

/** بازگردانی شیفت‌هایی که status=cancelled دارند ولی هنوز در بازه زمانی‌شان هستند */
export async function restoreMistakenlyCancelledShifts() {
  // عمداً غیرفعال: لغو عمدی مالک/ادمین/dedupe نباید زنده شود
  return { restored: 0, disabled: true };
}

/* ============================================================
 *  سیستم Batch بررسی پیام‌ها (Serverless-safe)
 *  - هیچ Pending ای خودکار برای ادمین ارسال نمی‌شود (No Push).
 *  - ادمین با دکمه‌ی «📥 پیام‌های در انتظار» یک Batch به اندازه REVIEW_BATCH_SIZE می‌گیرد.
 *  - IDهای Batch در settings با کلید review_batch:<adminId> ذخیره می‌شوند.
 *  - پیشرفت تحویل پس از هر sendMessage موفق به‌صورت افزایشی ذخیره می‌شود.
 *  - Claim نرم (review_claim:<msgId>) از اختصاص هم‌زمان به چند بازبین جلوگیری می‌کند.
 *  - Lock با Timestamp در DB (بدون worker دائمی)؛ TTL کوتاه.
 *  - Batch state ≠ Message status: حذف Batch پیام را approve/reject نمی‌کند.
 * ============================================================ */

export const REVIEW_BATCH_SIZE = 18;
/** همیشه برابر REVIEW_BATCH_SIZE */
export const REVIEW_BATCH_HARD = REVIEW_BATCH_SIZE;
const REVIEW_LOCK_TTL_MS = 12 * 1000;
const REVIEW_CLAIM_TTL_MS = 90 * 60 * 1000;
const PUBLISHING_STUCK_MS = 20 * 60 * 1000;
const BATCH_SEND_GAP_MS = 45;
const BATCH_MAX_RETRIES_PER_MSG = 2;

function reviewBatchKey(adminId) {
  return 'review_batch:' + Number(adminId);
}
function reviewClaimKey(msgId) {
  return 'review_claim:' + Number(msgId);
}
function batchLog(event, fields) {
  try {
    console.log(JSON.stringify(Object.assign({ evt: 'batch', at: Date.now(), event: event }, fields || {})));
  } catch (_e) {}
}
function escapeHtmlBatch(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function sleepMs(ms) {
  const n = Math.max(0, Math.min(Number(ms) || 0, 8000));
  if (n <= 0) return Promise.resolve();
  return new Promise(function (resolve) { setTimeout(resolve, n); });
}
function parseTelegramRetryAfter(err) {
  try {
    if (!err) return 0;
    if (err.parameters && err.parameters.retry_after != null) return Number(err.parameters.retry_after) || 0;
    const resp = err.response || err;
    if (resp && resp.parameters && resp.parameters.retry_after != null) return Number(resp.parameters.retry_after) || 0;
    const msg = String(err.description || err.message || err || '');
    const m = msg.match(/retry after (\d+)/i);
    if (m) return Number(m[1]) || 0;
  } catch (_e) {}
  return 0;
}
function isTelegram429(err) {
  try {
    const code = Number(err && (err.error_code || err.code || err.statusCode)) || 0;
    if (code === 429) return true;
    const msg = String((err && (err.description || err.message)) || err || '').toLowerCase();
    return msg.includes('too many requests') || msg.includes('retry after');
  } catch (_e) { return false; }
}
function isPermanentTelegramError(err) {
  try {
    const code = Number(err && (err.error_code || err.code)) || 0;
    if (code === 400 || code === 403 || code === 404) return true;
    const msg = String((err && (err.description || err.message)) || '').toLowerCase();
    if (msg.includes('chat not found') || msg.includes('blocked by the user')) return true;
    if (msg.includes("can't parse entities") || msg.includes('parse entities')) return true;
  } catch (_e) {}
  return false;
}
function normalizeBatchState(raw, adminId) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    ids: Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [],
    delivered: Array.isArray(b.delivered) ? b.delivered.map(Number).filter(Boolean) : [],
    failed: Array.isArray(b.failed) ? b.failed.map(Number).filter(Boolean) : [],
    batchNumber: Number(b.batchNumber) || 1,
    createdAt: Number(b.createdAt) || Date.now(),
    periodDate: b.periodDate || periodDateStr(),
    version: Number(b.version) || 1,
    adminId: Number(b.adminId || adminId) || Number(adminId) || 0,
  };
}


/** آیا این رکورد shift همین الان (تهران) فعال است؟ */
export function shiftActiveNow(s, now, pdate) {
  if (!s || String(s.status) !== 'active') return false;
  if (!now) now = tehranNow();
  if (!pdate) pdate = periodDateStr(now);
  const start = normHm(s.startHm || s.start_hm || '');
  const end = normHm(s.endHm || s.end_hm || '');
  if (!start || !end || start === end) return false;
  const sd = String(s.shiftDate ?? s.shift_date ?? '');
  if (sd === 'perm' || sd === 'permanent') return false;
  // فقط دورهٔ تقویمی فعلی
  if (sd !== String(pdate)) return false;
  // هر ساعتی که مالک/سیستم ثبت کرده — فقط بازه زمانی چک می‌شود
  return inRange(now.hm, start, end);
}

/** کلید کانال‌هایی که ادمین همین الان برایشان شیفت فعال دارد */
export function shiftIntervalOverlaps(startHm, endHm, otherStartHm, otherEndHm) {
  const toOrd = (hm) => {
    const parts = String(hm || '0:0').split(':').map(Number);
    let m = (parts[0] || 0) * 60 + (parts[1] || 0);
    if (m < 12 * 60) m += 24 * 60;
    return m;
  };
  const s1 = toOrd(startHm);
  let e1 = toOrd(endHm);
  const s2 = toOrd(otherStartHm);
  let e2 = toOrd(otherEndHm);
  if (e1 <= s1) e1 += 24 * 60;
  if (e2 <= s2) e2 += 24 * 60;
  return s1 < e2 && s2 < e1;
}


/** آیا این بازه در کانال برای دوره/دائم توسط کسی اشغال است؟ */

/** همه شیفت‌های دائمی را لغو می‌کند (قابلیت دائم حذف شده) */

/** لغو شیفت‌های بی‌اعتبار: دائم، یا شروع قبل از ۱۲ (باقی‌مانده سیستم قدیم) */
export async function pruneOldShifts() {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const all = (await db.select().from(shifts).all()) || [];
    let n = 0;
    for (const s of all) {
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      if (sd === 'perm' || sd === 'permanent') {
        try {
          await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, Number(s.id))).run();
          n += 1;
        } catch (_e) {}
        continue;
      }
      // شیفت‌های تاریخ‌های خیلی قدیمی (>2 روز) را cancelled کن اگر هنوز active‌اند
      if (String(s.status) !== 'active') continue;
      if (sd === String(pdate) || sd === String(now.date)) continue;
      // تاریخ ساده‌ی YYYY-MM-DD
      try {
        const a = sd.split('-').map(Number);
        const b = String(pdate).split('-').map(Number);
        if (a.length === 3 && b.length === 3) {
          const da = Date.UTC(a[0], a[1] - 1, a[2]);
          const db_ = Date.UTC(b[0], b[1] - 1, b[2]);
          const days = (db_ - da) / 86400000;
          if (days > 2) {
            await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, Number(s.id))).run();
            n += 1;
          }
        }
      } catch (_e) {}
    }
    return n;
  } catch (e) {
    console.error('pruneOldShifts', e);
    return 0;
  }
}

export async function cancelInvalidShifts() {
  try {
    const all = (await db.select().from(shifts).all()) || [];
    let n = 0;
    for (const s of all) {
      if (String(s.status) !== 'active') continue;
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      // فقط واقعاً نامعتبر: دائم قدیمی یا بازه صفر
      // ساعت قبل از ۱۲ دیگر لغو نمی‌شود (مالک می‌تواند هر ساعتی بدهد)
      const bad =
        sd === 'perm' ||
        sd === 'permanent' ||
        String(s.startHm) === String(s.endHm);
      if (!bad) continue;
      try {
        await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, Number(s.id))).run();
        n += 1;
      } catch (_e) {}
    }
    return n;
  } catch (e) {
    console.error('cancelInvalidShifts', e);
    return 0;
  }
}

export async function cancelAllPermanentShifts() {
  try {
    const all = (await db.select().from(shifts).all()) || [];
    let n = 0;
    for (const s of all) {
      if (String(s.status) !== 'active') continue;
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      if (sd !== 'perm' && sd !== 'permanent') continue;
      try {
        await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, Number(s.id))).run();
        n += 1;
      } catch (_e) {}
    }
    return n;
  } catch (e) {
    console.error('cancelAllPermanentShifts', e);
    return 0;
  }
}


/** نقشه پر بودن اسلات‌ها بر اساس هم‌پوشانی واقعی (نه فقط ساعت شروع) */
export function buildTakenMapForSlots(activeShifts, slots) {
  const takenMap = {};
  const list = activeShifts || [];
  const slotList = slots || [];
  for (const slot of slotList) {
    const ss = slot.start || slot.hourKey;
    const se = slot.end;
    if (!ss || !se || String(ss) === String(se)) continue;
    for (const s of list) {
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      if (sd === 'perm' || sd === 'permanent') continue;
      if (String(s.startHm) === String(s.endHm)) continue;
      if (shiftIntervalOverlaps(ss, se, s.startHm || s.start_hm, s.endHm || s.end_hm)) {
        takenMap[ss] = s.adminId ?? s.admin_id;
        takenMap[hourKeyOf(ss)] = s.adminId ?? s.admin_id;
        break;
      }
    }
  }
  return takenMap;
}

/** فقط شیفت‌های معتبر دوره فعلی (غیر دائم، غیر صفر — هر ساعتی) */
export function filterPeriodShifts(rows, pdate) {
  return (rows || []).filter(function (s) {
    if (String(s.status) !== 'active') return false;
    const sd = String(s.shiftDate ?? s.shift_date ?? '');
    if (sd === 'perm' || sd === 'permanent') return false;
    if (sd !== String(pdate)) return false;
    if (String(s.startHm) === String(s.endHm)) return false;
    return true;
  });
}

export async function isChannelSlotTaken(channelKey, startHm, endHm, excludeShiftId) {
  try {
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.channelKey, String(channelKey)), eq(shifts.status, 'active')))
        .all()) || [];
    const pdate = periodDateStr(tehranNow());
    for (const s of rows) {
      if (excludeShiftId != null && Number(s.id) === Number(excludeShiftId)) continue;
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      if (sd === 'perm' || sd === 'permanent') continue;
      if (sd !== String(pdate)) continue;
      if (String(s.startHm) === String(s.endHm)) continue;
      if (shiftIntervalOverlaps(startHm, endHm, s.startHm || s.start_hm, s.endHm || s.end_hm)) {
        return s;
      }
    }
    return null;
  } catch (e) {
    console.error('isChannelSlotTaken', e);
    // fail-closed: وانمود کن پر است تا دابل‌بوک نشود
    return { id: -1, adminId: 0, _error: true };
  }
}

/**
 * حذف شیفت‌های تکراری فعال در یک کانال:
 * اگر دو رکورد با همان admin + همان بازه (+ همان نوع دوره) باشند، فقط قدیمی‌ترین می‌ماند.
 * اگر دو ادمین مختلف روی بازه هم‌پوشان باشند، دومی (id بزرگ‌تر) لغو می‌شود.
 */
export async function verifyShiftStillActive(adminId, channelKey, startHm, shiftDate) {
  try {
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.adminId, Number(adminId)),
            eq(shifts.channelKey, String(channelKey)),
            eq(shifts.status, 'active')
          )
        )
        .all()) || [];
    return rows.some(function (s) {
      return (
        String(s.startHm) === String(startHm) &&
        String(s.shiftDate) === String(shiftDate)
      );
    });
  } catch (_e) {
    return false;
  }
}

export async function dedupeActiveShifts(channelKey) {
  try {
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.channelKey, String(channelKey)), eq(shifts.status, 'active')))
        .all()) || [];
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const relevant = rows
      .filter(function (s) {
        const sd = String(s.shiftDate ?? s.shift_date ?? '');
        if (sd === 'perm' || sd === 'permanent') return false;
        if (sd !== String(pdate)) return false;
        if (String(s.startHm) === String(s.endHm)) return false;
        return true;
      })
      .sort(function (a, b) {
        return Number(a.id) - Number(b.id);
      });
    let cancelled = 0;
    const kept = [];
    for (const s of relevant) {
      if (String(s.startHm) === String(s.endHm)) continue;
      let drop = false;
      for (const k of kept) {
        // تکراری دقیق همان ادمین + همان بازه
        const sameAdmin = Number(k.adminId ?? k.admin_id) === Number(s.adminId ?? s.admin_id);
        const sameRange =
          String(k.startHm) === String(s.startHm) && String(k.endHm) === String(s.endHm);
        const kPerm = String(k.shiftDate) === 'perm' || String(k.shiftDate) === 'permanent';
        const sPerm = String(s.shiftDate) === 'perm' || String(s.shiftDate) === 'permanent';
        // هر دو دائم یا هر دو روزانه دوره
        if (sameAdmin && sameRange && kPerm === sPerm) {
          drop = true;
          break;
        }
        // هم‌پوشانی بین دو ادمین مختلف → دومی حذف
        if (
          !sameAdmin &&
          shiftIntervalOverlaps(s.startHm, s.endHm, k.startHm, k.endHm)
        ) {
          drop = true;
          break;
        }
        // همان ادمین بازه هم‌پوشان
        if (
          sameAdmin &&
          shiftIntervalOverlaps(s.startHm, s.endHm, k.startHm, k.endHm)
        ) {
          drop = true;
          break;
        }
      }
      if (drop) {
        try {
          await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, Number(s.id))).run();
          cancelled += 1;
        } catch (_e) {}
      } else {
        kept.push(s);
      }
    }
    return { cancelled: cancelled, kept: kept.length };
  } catch (e) {
    console.error('dedupeActiveShifts', e);
    return { cancelled: 0 };
  }
}


export async function countAdminPeriodShifts(adminId, shiftDate) {
  try {
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.adminId, Number(adminId)), eq(shifts.status, 'active')))
        .all()) || [];
    const target = String(shiftDate);
    let n = 0;
    for (const s of rows) {
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      if (sd === 'perm' || sd === 'permanent') continue;
      if (sd !== target) continue;
      if (String(s.startHm) === String(s.endHm)) continue;
      n += 1;
    }
    return n;
  } catch (e) {
    console.error('countAdminPeriodShifts', e);
    return 99; // fail-closed به سقف
  }
}

/** آیا کاربر ادمین این کانال است (یا مالک/ساب‌لیدر اسکوپ) */
export async function isUserChannelAdmin(userId, channelKey) {
  if (isOwner(userId)) return true;
  const ck = normalizeChannelKey(channelKey);
  try {
    const chs = await adminChannels(userId);
    if ((chs || []).some(function (x) { return normalizeChannelKey(x) === ck; })) return true;
  } catch (_e) {}
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl && normalizeChannelKey(sl) === ck) return true;
  } catch (_e) {}
  return false;
}

export async function findAdminShiftConflict(adminId, shiftDate, startHm, endHm, excludeId = null) {
  try {
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.adminId, Number(adminId)), eq(shifts.status, 'active')))
        .all()) || [];
    const targetDate = String(shiftDate);
    return (
      rows.find(function (s) {
        if (excludeId != null && Number(s.id) === Number(excludeId)) return false;
        const sd = String(s.shiftDate ?? s.shift_date ?? '');
        if (sd === 'perm' || sd === 'permanent') return false;
        if (sd !== targetDate) return false;
        if (String(s.startHm) === String(s.endHm)) return false;
        return shiftIntervalOverlaps(startHm, endHm, s.startHm || s.start_hm, s.endHm || s.end_hm);
      }) || null
    );
  } catch (e) {
    console.error('findAdminShiftConflict', e);
    // fail-closed: وانمود کن تداخل هست تا دابل‌بوک بین کانال‌ها نشود
    return { id: -1, adminId: Number(adminId), _error: true };
  }
}


/** کانال‌هایی که کاربر می‌تواند برای خودش شیفت بردارد: ادمین کانال + اسکوپ ساب‌لیدر */
export async function shiftPickChannels(userId) {
  if (isOwner(userId)) return Object.keys(DEFAULT_CHANNELS || {});
  const set = new Set();
  try {
    const chs = await adminChannels(userId);
    for (const c of chs || []) {
      const nk = normalizeChannelKey(c);
      if (nk && DEFAULT_CHANNELS[nk]) set.add(nk);
      else if (nk) set.add(nk);
    }
  } catch (_e) {}
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl) {
      const nk = normalizeChannelKey(sl);
      if (nk) set.add(nk);
    }
  } catch (_e) {}
  if (!set.size) {
    try {
      const u = await getUser(userId);
      if (u && u.role === 'admin') {
        console.error('shiftPickChannels: admin role but no channel_admins', userId);
      }
    } catch (_e) {}
  }
  return [...set];
}

/** آیا می‌تواند شیفت دیگران را در این کانال لغو/تغییر دهد؟ */
export async function canManageOthersShifts(userId, channelKey) {
  if (isOwner(userId)) return true;
  const sl = await getActiveSubLeaderChannel(userId);
  return !!(sl && sl === channelKey);
}

export async function activeShiftChannelKeys(adminId) {
  const uid = Number(adminId);
  // خالی را memo نکن — خطای موقت باعث قفل ۲.۵ثانیه‌ای نشود
  const cacheKey = 'ask:' + uid;
  const nowMs = Date.now();
  if (
    __reqMemo[cacheKey] &&
    Array.isArray(__reqMemo[cacheKey]) &&
    __reqMemo[cacheKey].length > 0 &&
    nowMs - (Number(__reqMemoTs[cacheKey]) || 0) < MEMO_TTL_MS
  ) {
    return __reqMemo[cacheKey];
  }
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    let rows = [];
    try {
      rows =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, uid), eq(shifts.status, 'active')))
          .all()) || [];
    } catch (_e1) {
      try {
        const all = (await db.select().from(shifts).all()) || [];
        rows = all.filter(function (s) {
          return Number(s.adminId ?? s.admin_id) === uid && String(s.status) === 'active';
        });
      } catch (e2) {
        console.error('activeShiftChannelKeys', e2);
        return [];
      }
    }
    const keys = [];
    const seen = {};
    for (const s of rows) {
      if (!shiftActiveNow(s, now, pdate)) continue;
      const ck = String((s.channelKey ?? s.channel_key) || '');
      const nk = normalizeChannelKey(ck) || ck;
      if (!nk || seen[nk]) continue;
      seen[nk] = true;
      keys.push(nk);
    }
    if (keys.length) {
      __reqMemo[cacheKey] = keys;
      __reqMemoTs[cacheKey] = nowMs;
    }
    return keys;
  } catch (e) {
    console.error('activeShiftChannelKeys', e);
    return [];
  }
}

/** مالک همیشه true. ادمین: شیفت فعال (اختیاری: برای کانال مشخص) */
export async function hasActiveShift(adminId, channelKey) {
  if (isOwner(adminId)) return true;
  const keys = await activeShiftChannelKeys(adminId);
  return channelKey ? keys.includes(channelKey) : keys.length > 0;
}


/**
 * کانال‌هایی که کاربر حق بررسی پیام دارد.
 * اولویت:
 *  1) فقط کانال‌هایی که همین الان شیفت فعال دارد (حتی اگر ساب‌لیدر کانال دیگری هم باشد)
 *  2) اگر هیچ شیفت فعالی نداشت و ساب‌لیدر است → فقط کانال اسکوپ خودش
 * مالک: همه کانال‌ها
 *
 * قبلاً اسکوپ ساب‌لیدر همیشه با شیفت‌ها OR می‌شد؛ در نتیجه کسی که
 * ساب‌لیدر «این کاربر» بود و شیفت «صدام بزن» داشت، پیام هر دو را می‌گرفت.
 */
export async function allowedReviewChannels(userId) {
  // مالک: همه کانال‌ها بدون نیاز به شیفت
  if (isOwner(userId)) return Object.keys(DEFAULT_CHANNELS || {});
  try {
    const keys = await activeShiftChannelKeys(userId);
    if (keys && keys.length) {
      // نرمال‌سازی و یکتا
      const seen = {};
      const out = [];
      for (const k of keys) {
        const nk = normalizeChannelKey(k) || String(k || '');
        if (!nk || seen[nk]) continue;
        seen[nk] = true;
        out.push(nk);
      }
      return out;
    }
  } catch (_e) {}
  // ساب‌لیدر بدون شیفت فعال: دسترسی مدیریتی به کانال خودش (عمدی).
  // این بررسی‌ها در آمار به‌عنوان «خارج شیفت» شمارش می‌شوند.
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl) {
      const nk = normalizeChannelKey(sl) || String(sl);
      return nk ? [nk] : [];
    }
  } catch (_e) {}
  return [];
}

export async function canAdminReviewMessage(adminId, channelKey) {
  if (isOwner(adminId)) return true;
  const ck = String(channelKey || '');
  const allowed = await allowedReviewChannels(adminId);
  return allowed.includes(ck);
}

/* ---------- Lock مبتنی بر Timestamp در DB ---------- */

/**
 * گرفتن قفل. insert روی کلید یکتا (PRIMARY KEY) اتمیک است.
 * اگر قفل موجود ولی منقضی بود، با compare-and-swap تصاحب می‌شود.
 * برمی‌گرداند: توکن قفل (string) یا null (مشغول).
 */
export async function acquireLock(key, ttl = REVIEW_LOCK_TTL_MS) {
  const now = Date.now();
  const mine = JSON.stringify({
    lockedAt: now,
    token: now + ':' + Math.random().toString(36).slice(2),
  });
  try {
    await db.insert(settings).values({ key, value: mine }).run();
    return mine;
  } catch (_e) {
    // کلید قبلاً وجود دارد؛ ادامه
  }
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    const cur = rows && rows[0];
    if (!cur) return null;
    let at = 0;
    try {
      at = Number(JSON.parse(cur.value || '{}').lockedAt) || 0;
    } catch (_e) {
      at = 0;
    }
    if (at && now - at < ttl) return null; // قفل تازه است → مشغول
    await db
      .update(settings)
      .set({ value: mine })
      .where(and(eq(settings.key, key), eq(settings.value, cur.value)))
      .run();
    const again = await db.select().from(settings).where(eq(settings.key, key)).all();
    return again && again[0] && again[0].value === mine ? mine : null;
  } catch (e) {
    console.error('acquireLock', key, e);
    return null;
  }
}

export async function releaseLock(key, mine) {
  if (!mine) return;
  try {
    await db.delete(settings).where(and(eq(settings.key, key), eq(settings.value, mine))).run();
  } catch (e) {
    console.error('releaseLock', key, e);
  }
}

/* ---------- ذخیره/خواندن Batch ---------- */

export async function getReviewBatch(adminId) {
  const raw = await settingGet(reviewBatchKey(adminId), '');
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b && Array.isArray(b.ids)) return normalizeBatchState(b, adminId);
  } catch (_e) {}
  return null;
}

/** برخلاف settingSet خطا را می‌اندازد تا Batch نیمه‌کاره ثبت نشود */
async function saveReviewBatch(adminId, batch) {
  const normalized = normalizeBatchState(batch, adminId);
  normalized.version = (Number(normalized.version) || 0) + 1;
  normalized.adminId = Number(adminId);
  const key = reviewBatchKey(adminId);
  const value = JSON.stringify(normalized);
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  if (rows && rows.length) {
    await db.update(settings).set({ value: value }).where(eq(settings.key, key)).run();
  } else {
    await db.insert(settings).values({ key: key, value: value }).run();
  }
  try {
    const raw = await settingGet('review_batch_index', '[]');
    let arr = [];
    try { arr = JSON.parse(raw || '[]') || []; } catch (_e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    const aid = Number(adminId);
    if (normalized.ids && normalized.ids.length) {
      if (!arr.map(Number).includes(aid)) {
        arr.push(aid);
        if (arr.length > 500) arr = arr.slice(-500);
        await settingSet('review_batch_index', JSON.stringify(arr));
      }
    } else {
      const next = arr.filter(function (x) { return Number(x) !== aid; });
      if (next.length !== arr.length) await settingSet('review_batch_index', JSON.stringify(next));
    }
  } catch (_e) {}
  return normalized;
}

/** فقط state Batch را پاک می‌کند؛ هیچ پیامی تغییر نمی‌کند */
/** پاک کردن پیام‌های UI مربوط به Batch قبلی در چت ادمین */
export async function clearReviewUiMessages(adminId, chatId) {
  const key = 'review_ui:' + Number(adminId);
  let ids = [];
  try {
    const raw = await settingGet(key, '[]');
    ids = JSON.parse(raw) || [];
  } catch (_e) {
    ids = [];
  }
  const chat = chatId != null ? Number(chatId) : Number(adminId);
  for (const mid of ids) {
    try {
      await api.deleteMessage({ chat_id: chat, message_id: Number(mid) });
    } catch (_e) {}
  }
  try {
    await settingSet(key, '[]');
  } catch (_e) {}
  return ids.length;
}

export async function clearReviewBatch(adminId) {
  try {
    const old = await getReviewBatch(adminId);
    if (old && Array.isArray(old.ids)) {
      for (const id of old.ids) {
        try { await releaseReviewClaim(id, adminId); } catch (_e) {}
      }
    }
  } catch (_e) {}
  try {
    await db.delete(settings).where(eq(settings.key, reviewBatchKey(adminId))).run();
  } catch (e) {
    console.error('clearReviewBatch', e);
  }
  try {
    const raw = await settingGet('review_batch_index', '[]');
    let arr = [];
    try { arr = JSON.parse(raw || '[]') || []; } catch (_e) { arr = []; }
    if (Array.isArray(arr)) {
      const next = arr.filter(function (x) { return Number(x) !== Number(adminId); });
      if (next.length !== arr.length) await settingSet('review_batch_index', JSON.stringify(next));
    }
  } catch (_e) {}
}

/** فقط IDهای هنوز pending را نگه می‌دارد */

async function getReviewClaim(msgId) {
  try {
    const raw = await settingGet(reviewClaimKey(msgId), '');
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !c.adminId) return null;
    if (c.expiresAt && Date.now() > Number(c.expiresAt)) {
      try { await db.delete(settings).where(eq(settings.key, reviewClaimKey(msgId))).run(); } catch (_e) {}
      return null;
    }
    return c;
  } catch (_e) {
    return null;
  }
}

async function tryClaimReviewMessage(msgId, adminId, batchNumber) {
  const id = Number(msgId);
  const aid = Number(adminId);
  if (!id || !aid) return { ok: false, code: 'bad' };
  const existing = await getReviewClaim(id);
  if (existing) {
    if (Number(existing.adminId) === aid) return { ok: true, renewed: true };
    return { ok: false, code: 'held', holder: Number(existing.adminId) };
  }
  const payload = JSON.stringify({
    adminId: aid,
    batchNumber: Number(batchNumber) || 0,
    claimedAt: Date.now(),
    expiresAt: Date.now() + REVIEW_CLAIM_TTL_MS,
  });
  try {
    await db.insert(settings).values({ key: reviewClaimKey(id), value: payload }).run();
    return { ok: true };
  } catch (_e) {
    const again = await getReviewClaim(id);
    if (again && Number(again.adminId) === aid) return { ok: true, renewed: true };
    return { ok: false, code: 'held', holder: again ? Number(again.adminId) : null };
  }
}

async function releaseReviewClaim(msgId, adminId) {
  const id = Number(msgId);
  if (!id) return;
  try {
    const cur = await getReviewClaim(id);
    if (!cur) return;
    if (adminId != null && Number(cur.adminId) !== Number(adminId)) return;
    await db.delete(settings).where(eq(settings.key, reviewClaimKey(id))).run();
  } catch (_e) {}
}

export async function pruneReviewBatchToPending(adminId) {
  const old = await getReviewBatch(adminId);
  if (!old || !old.ids || !old.ids.length) return { cleared: true, ids: [] };
  const rows = await Promise.all(
    old.ids.map(function (id) {
      return getMessageById(Number(id)).catch(function () {
        return null;
      });
    })
  );
  const alive = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // فقط pending واقعی؛ approved/rejected/publishing از Batch خارج
    if (row && String(row.status || '') === 'pending') alive.push(Number(old.ids[i]));
  }
  if (!alive.length) {
    await clearReviewBatch(adminId);
    return { cleared: true, ids: [] };
  }
  if (alive.length !== old.ids.length) {
    old.ids = alive;
    await saveReviewBatch(adminId, old);
  }
  return { cleared: false, ids: alive, batch: old };
}

/** بعد از approve/reject/flush این id را از Batch همه ادمین‌ها بردار */
/** فقط Batch همین ادمین — سریع */
export async function dropMessageFromReviewBatch(adminId, msgId) {
  msgId = Number(msgId);
  try {
    const old = await getReviewBatch(adminId);
    if (!old || !Array.isArray(old.ids)) return;
    const next = old.ids.map(Number).filter(function (id) { return id !== msgId; });
    if (next.length === old.ids.length) return;
    try { await releaseReviewClaim(msgId, adminId); } catch (_e) {}
    if (!next.length) await clearReviewBatch(adminId);
    else {
      old.ids = next;
      old.delivered = (old.delivered || []).map(Number).filter(function (id) { return id !== msgId; });
      await saveReviewBatch(adminId, old);
    }
  } catch (e) {
    console.error('dropMessageFromReviewBatch', e);
  }
}

export async function dropMessageFromAllReviewBatches(msgId) {
  msgId = Number(msgId);
  try {
    let adminIds = [];
    try {
      const raw = await settingGet('review_batch_index', '[]');
      adminIds = JSON.parse(raw || '[]') || [];
      if (!Array.isArray(adminIds)) adminIds = [];
    } catch (_e) {
      adminIds = [];
    }
    try { await releaseReviewClaim(msgId, null); } catch (_e) {}
    for (const aid of adminIds) {
      try {
        await dropMessageFromReviewBatch(aid, msgId);
      } catch (_e) {}
    }
  } catch (e) {
    console.error('dropMessageFromAllReviewBatches', e);
  }
}

async function getMessageById(id) {
  const rows = await db.select().from(messages).where(eq(messages.id, Number(id))).all();
  return (rows && rows[0]) || null;
}

/** ردیف‌های پیام‌های Batch به ترتیب ذخیره‌شده */
export async function getReviewBatchMessages(adminId) {
  const b = await getReviewBatch(adminId);
  if (!b) return [];
  const out = [];
  for (const id of b.ids) {
    const row = await getMessageById(id);
    if (row) out.push(row);
  }
  return out;
}

/** Batch کامل است اگر هیچ‌کدام از IDها دیگر pending نباشد (بدون Batch = کامل) */
export async function isReviewBatchComplete(adminId) {
  const batch = await getReviewBatch(adminId);
  if (!batch || !batch.ids || !batch.ids.length) return true;
  for (const id of batch.ids) {
    let row = null;
    try {
      row = await getMessageById(Number(id));
    } catch (_e) {
      row = null;
    }
    if (!row) continue;
    const st = String(row.status || '');
    if (st === 'pending') return false;
    if (st === 'publishing') {
      const ra = row.reviewedAt ? new Date(row.reviewedAt).getTime() : 0;
      if (!ra || Date.now() - ra < PUBLISHING_STUCK_MS) return false;
    }
  }
  return true;
}

/** Pending قابل‌بررسی — قدیمی‌ترین اول در پنجرهٔ اخیر جدول
 * با ۵۰k+ ردیف، ASC از id=0 قبل از رسیدن به صف واقعی بودجه را تمام می‌کند.
 * مسیر پایدار: چند برش DESC روی PK (سریع) → فیلتر pending → sort ASC → FIFO در همان پنجره.
 */
async function selectReviewablePending(adminId, limit) {
  const need = Math.min(Math.max(Number(limit) || REVIEW_BATCH_SIZE, 1), 80);
  const fetchLimit = Math.min(Math.max(need * 8, 24), 300);

  let ownerCh = '';
  if (isOwner(adminId)) {
    try {
      ownerCh = String((await settingGet('owner_pend_ch:' + adminId, '')) || '');
      if (ownerCh === 'all') ownerCh = '';
      if (ownerCh) ownerCh = normalizeChannelKey(ownerCh) || ownerCh;
    } catch (_e) {}
  }

  let allowSet = null;
  if (!isOwner(adminId)) {
    try {
      const allowList = await allowedReviewChannels(adminId);
      if (!allowList || !allowList.length) return [];
      allowSet = {};
      for (const k of allowList) {
        const nk = normalizeChannelKey(k) || String(k);
        if (nk) allowSet[nk] = true;
        allowSet[String(k)] = true;
      }
    } catch (e) {
      console.error('selectReviewablePending allow', e);
      return [];
    }
  }

  function passChannel(ckRaw) {
    const ck = String(ckRaw || '');
    const nk = normalizeChannelKey(ck) || ck;
    if (ownerCh) {
      if (ck !== ownerCh && nk !== ownerCh) return false;
    }
    if (allowSet) {
      if (!(allowSet[ck] || allowSet[nk])) return false;
    }
    return true;
  }

  let rows = [];
  try {
    if (ownerCh) {
      rows =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, ownerCh)))
          .orderBy(asc(messages.id))
          .limit(fetchLimit)
          .all()) || [];
    } else {
      rows =
        (await db
          .select()
          .from(messages)
          .where(eq(messages.status, 'pending'))
          .orderBy(asc(messages.id))
          .limit(allowSet ? Math.min(fetchLimit * 3, 300) : fetchLimit)
          .all()) || [];
    }
  } catch (eFast) {
    console.error('selectReviewablePending query', eFast);
    rows = [];
  }

  const out = [];
  for (const r of rows) {
    if (!r) continue;
    if (String(r.status || '') !== 'pending') continue;
    const ck = String((r.channelKey ?? r.channel_key) || '');
    if (!passChannel(ck)) continue;
    const mid = Number(r.id);
    try {
      const claim = await getReviewClaim(mid);
      if (claim && Number(claim.adminId) !== Number(adminId)) continue;
    } catch (_e) {}
    out.push(r);
    if (out.length >= need) break;
  }
  out.sort(function (a, b) {
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  return out;
}

export async function hasEligiblePending(adminId) {
  try {
    const rows = await selectReviewablePending(adminId, 1);
    return !!(rows && rows.length);
  } catch (e) {
    console.error('hasEligiblePending', e);
    return true;
  }
}

export async function finishReviewBatchIfComplete(adminId, messageId) {
  try {
    const batch = await getReviewBatch(adminId);
    if (!batch) {
      let hasMore = false;
      try {
        hasMore = await hasEligiblePending(adminId);
      } catch (_e) {
        hasMore = true;
      }
      return { inBatch: false, complete: true, hasMore: hasMore, batch: null };
    }
    const ids = (batch.ids || []).map(Number);
    const inBatch = messageId == null || ids.includes(Number(messageId));
    const complete = await isReviewBatchComplete(adminId);
    let hasMore = false;
    if (complete) {
      try {
        await clearReviewBatch(adminId);
      } catch (_e) {}
      try {
        hasMore = await hasEligiblePending(adminId);
      } catch (_e) {
        hasMore = false;
      }
    }
    return { inBatch: inBatch || complete, complete, hasMore, batch };
  } catch (e) {
    console.error('finishReviewBatchIfComplete', e);
    return { inBatch: false, complete: false, hasMore: false, batch: null };
  }
}

/**
 * ساخت (یا بازیابی) Batch.
 * status:
 *   no_shift   → ادمین شیفت فعال ندارد
 *   busy       → درخواست هم‌زمان دیگری در حال اجراست
 *   incomplete → Batch قبلی ناقص است (همان Batch برگردانده می‌شود)
 *   empty      → Pending مناسبی نیست
 *   created    → Batch جدید ساخته شد
 */

/** کارت فشرده شیفت فعلی ادمین: کانال‌ها، دقیقه تا پایان، pending، تأیید/رد امروز */
export async function adminShiftCard(adminId) {
  const now = tehranNow();
  const pdate = periodDateStr(now);
  const out = {
    active: [],
    pendingTotal: 0,
    todayApproved: 0,
    todayRejected: 0,
    minutesLeftMin: null,
  };
  try {
    const all = (await db.select().from(shifts).all()) || [];
    for (const s of all) {
      if (Number(s.adminId ?? s.admin_id) !== Number(adminId)) continue;
      if (!shiftActiveNow(s, now, pdate)) continue;
      const ck = String((s.channelKey ?? s.channel_key) || '');
      const end = normHm(s.endHm || s.end_hm || '');
      let eOrd = periodOrd(end);
      let nOrd = periodOrd(now.hm);
      if (eOrd <= periodOrd(normHm(s.startHm || s.start_hm))) eOrd += 24 * 60;
      if (nOrd < periodOrd(normHm(s.startHm || s.start_hm || '12:00')) && nOrd < 12 * 60) nOrd += 24 * 60;
      const mins = Math.max(0, eOrd - nOrd);
      out.active.push({
        channelKey: ck,
        title: (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck,
        startHm: normHm(s.startHm || s.start_hm),
        endHm: end,
        minutesLeft: mins,
      });
      if (out.minutesLeftMin == null || mins < out.minutesLeftMin) out.minutesLeftMin = mins;
    }
  } catch (e) {
    console.error('adminShiftCard shifts', e);
  }
  try {
    const allowed = await allowedReviewChannels(adminId);
    const allow = {};
    for (const k of allowed || []) allow[String(k)] = true;
    // شمارش سبک pending
    let light = [];
    try {
      light =
        (await db
          .select({ id: messages.id, status: messages.status, channelKey: messages.channelKey })
          .from(messages)
          .where(eq(messages.status, 'pending'))
          .all()) || [];
    } catch (_e) {
      try {
        const allm = (await db.select().from(messages).all()) || [];
        light = allm.filter(function (m) {
          return String(m.status) === 'pending';
        });
      } catch (_e2) {}
    }
    for (const m of light) {
      const ck = String((m.channelKey ?? m.channel_key) || '');
      if (isOwner(adminId) || allow[ck]) out.pendingTotal += 1;
    }
  } catch (e) {
    console.error('adminShiftCard pending', e);
  }
  try {
    const day = String(now.date);
    let mine = [];
    try {
      mine =
        (await db
          .select({
            id: messages.id,
            status: messages.status,
            reviewedAt: messages.reviewedAt,
          })
          .from(messages)
          .where(eq(messages.reviewedBy, Number(adminId)))
          .all()) || [];
    } catch (_e) {
      mine = [];
    }
    for (const m of mine) {
      const ts = String(m.reviewedAt ?? m.reviewed_at ?? '');
      if (!ts) continue;
      // مقایسه روز تقویمی تهران از رشته ISO یا Date
      let dayOk = ts.indexOf(day) >= 0 || ts.startsWith(day);
      if (!dayOk) {
        try {
          const d = new Date(ts);
          if (!isNaN(d.getTime())) {
            const tehran = new Date(d.getTime() + 3.5 * 3600 * 1000);
            const y = tehran.getUTCFullYear();
            const mo = String(tehran.getUTCMonth() + 1).padStart(2, '0');
            const da = String(tehran.getUTCDate()).padStart(2, '0');
            dayOk = y + '-' + mo + '-' + da === day;
          }
        } catch (_e2) {}
      }
      if (!dayOk) continue;
      const st = String(m.status || '');
      if (st === 'approved') out.todayApproved += 1;
      else if (st === 'rejected') out.todayRejected += 1;
    }
  } catch (e) {
    console.error('adminShiftCard today', e);
  }
  return out;
}

/** یک‌بار در اولین Batch شیفت فعال: پیام خوش‌آمد */
export async function maybeGreetShiftStart(adminId, chatId) {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const all = (await db.select().from(shifts).all()) || [];
    const active = all.filter(function (s) {
      return Number(s.adminId ?? s.admin_id) === Number(adminId) && shiftActiveNow(s, now, pdate);
    });
    if (!active.length) return false;
    let greetedAny = false;
    for (const s of active) {
      const ck = String((s.channelKey ?? s.channel_key) || '');
      const start = normHm(s.startHm || s.start_hm);
      const key = 'shift_hello:' + adminId + ':' + ck + ':' + pdate + ':' + start;
      const done = await settingGet(key, '');
      if (done === '1') continue;
      const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
      const end = normHm(s.endHm || s.end_hm);
      let pendingN = 0;
      try {
        const light =
          (await db
            .select({ id: messages.id, status: messages.status, channelKey: messages.channelKey })
            .from(messages)
            .where(eq(messages.status, 'pending'))
            .all()) || [];
        pendingN = light.filter(function (m) {
          return String((m.channelKey ?? m.channel_key) || '') === ck;
        }).length;
      } catch (_e) {}
      const text =
        '🟢 شیفت «' +
        title +
        '» شروع شد\n' +
        '⏰ ' +
        start +
        '–' +
        end +
        '\n' +
        '📥 در صف این کانال: ' +
        pendingN +
        ' پیام\n\n' +
        'پیام‌های همین Batch را یکی‌یکی بررسی کن.\n' +
        'وقتی تمام شد، «Batch بعدی» را بزن.';
      try {
        await api.sendMessage({ chat_id: chatId || adminId, text: text });
      } catch (_e) {}
      try {
        await settingSet(key, '1');
      } catch (_e) {}
      greetedAny = true;
    }
    return greetedAny;
  } catch (e) {
    console.error('maybeGreetShiftStart', e);
    return false;
  }
}



export async function recoverStuckPublishingForReviewer(adminId) {
  const aid = Number(adminId);
  let recovered = 0;
  try {
    let extra = [];
    try {
      extra =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'publishing'), eq(messages.reviewedBy, aid)))
          .orderBy(desc(messages.id))
          .limit(30)
          .all()) || [];
    } catch (_e) {
      extra = [];
    }
    const batch = await getReviewBatch(aid);
    const ids = batch && Array.isArray(batch.ids) ? batch.ids.map(Number) : [];
    const seen = Object.create(null);
    const list = [];
    for (const id of ids) {
      if (seen[id]) continue;
      seen[id] = 1;
      try {
        const row = await getMessageById(id);
        if (row) list.push(row);
      } catch (_e) {}
    }
    for (const row of extra) {
      const id = Number(row.id);
      if (seen[id]) continue;
      seen[id] = 1;
      list.push(row);
    }
    for (const row of list) {
      if (!row || String(row.status || '') !== 'publishing') continue;
      const ra = row.reviewedAt ? new Date(row.reviewedAt).getTime() : 0;
      if (ra && Date.now() - ra < PUBLISHING_STUCK_MS) continue;
      const id = Number(row.id);
      let ref = null;
      try { ref = await findChannelMessageByInternalId(id); } catch (_e) {}
      if (ref && ref.channelMsgId) {
        try {
          await db
            .update(messages)
            .set({ status: 'approved', reviewedAt: new Date() })
            .where(and(eq(messages.id, id), eq(messages.status, 'publishing')))
            .run();
          recovered++;
          batchLog('publishing_to_approved', { adminId: aid, msgId: id });
          try { await dropMessageFromAllReviewBatches(id); } catch (_e) {}
          continue;
        } catch (_e) {}
      }
      try {
        await db
          .update(messages)
          .set({ status: 'pending', reviewedBy: null, reviewedAt: null })
          .where(and(eq(messages.id, id), eq(messages.status, 'publishing')))
          .run();
        recovered++;
        batchLog('publishing_to_pending', { adminId: aid, msgId: id });
      } catch (_e) {}
    }
  } catch (e) {
    console.error('recoverStuckPublishingForReviewer', e);
  }
  return recovered;
}

export async function createReviewBatch(adminId) {
  const lockKey = 'review_batch_lock:' + adminId;
  const lock = await acquireLock(lockKey);
  if (!lock) return { status: 'busy' };
  const t0 = Date.now();
  try {
    try { await recoverStuckPublishingForReviewer(adminId); } catch (_e) {}
    const owner = isOwner(adminId);
    if (!owner) {
      const slCh = await getActiveSubLeaderChannel(adminId);
      const keys = await activeShiftChannelKeys(adminId);
      // ساب‌لیدر بدون شیفت هم می‌تواند صف کانال خودش را ببیند
      if (!slCh && !(keys && keys.length)) {
        await clearReviewBatch(adminId);
        return { status: 'no_shift' };
      }
    }

    // Batch قبلی را به pending واقعی هرس کن
    const pruned = await pruneReviewBatchToPending(adminId);
    if (!pruned.cleared && pruned.ids && pruned.ids.length) {
      let pendingRows = [];
      const got = await Promise.all(
        pruned.ids.map(function (id) {
          return getMessageById(id).catch(function () {
            return null;
          });
        })
      );
      for (const row of got) {
        if (row && String(row.status || '') === 'pending') pendingRows.push(row);
      }
      if (!owner) {
        const allowed = await allowedReviewChannels(adminId);
        const allowSet = {};
        for (const k of allowed) {
          const nk = normalizeChannelKey(k) || String(k);
          if (nk) allowSet[nk] = true;
          allowSet[String(k)] = true;
        }
        pendingRows = pendingRows.filter(function (r) {
          const ck = String((r.channelKey ?? r.channel_key) || '');
          const nk = normalizeChannelKey(ck) || ck;
          return !!(allowSet[ck] || allowSet[nk]);
        });
      }
      if (pendingRows.length) {
        // تکمیل تا ۱۸ از صف، تا Batch ناقص کوچک گیر نکند
        try {
          if (pendingRows.length < REVIEW_BATCH_SIZE) {
            const have = Object.create(null);
            for (const r of pendingRows) have[Number(r.id)] = 1;
            const extra = (await selectReviewablePending(adminId)) || [];
            for (const m of extra) {
              if (pendingRows.length >= REVIEW_BATCH_SIZE) break;
              const mid = Number(m && m.id);
              if (!mid || have[mid]) continue;
              if (String(m.status || '') !== 'pending') continue;
              have[mid] = 1;
              pendingRows.push(m);
            }
          }
        } catch (eFill) {
          console.error('incomplete topup', eFill);
        }
        const batch = pruned.batch || (await getReviewBatch(adminId)) || {
          ids: [],
          batchNumber: 1,
          createdAt: Date.now(),
          periodDate: periodDateStr(),
        };
        batch.ids = pendingRows.map((r) => Number(r.id));
        await saveReviewBatch(adminId, batch);
        return { status: 'incomplete', batch, messages: pendingRows };
      }
      await clearReviewBatch(adminId);
    }

    let candidates = ((await selectReviewablePending(adminId, REVIEW_BATCH_SIZE)) || []).filter(function (m) {
      return m && String(m.status || '') === 'pending';
    });
    {
      const verified = [];
      for (const m of candidates) {
        try {
          const fresh = await getMessageById(Number(m.id));
          if (fresh && String(fresh.status || '') === 'pending') verified.push(fresh);
        } catch (_e) {}
      }
      candidates = verified;
    }
    const old = await getReviewBatch(adminId);
    const batchNumber = (old && Number(old.batchNumber) ? Number(old.batchNumber) : 0) + 1;
    const claimed = [];
    for (const m of candidates) {
      if (claimed.length >= REVIEW_BATCH_SIZE) break;
      const cl = await tryClaimReviewMessage(m.id, adminId, batchNumber);
      if (!cl.ok) continue;
      claimed.push(m);
    }
    if (!claimed.length) {
      batchLog('create_empty', { adminId: Number(adminId), ms: Date.now() - t0 });
      return { status: 'empty' };
    }
    const batch = normalizeBatchState({
      ids: claimed.map(function (m) { return Number(m.id); }),
      delivered: [],
      failed: [],
      batchNumber: batchNumber,
      createdAt: Date.now(),
      periodDate: periodDateStr(),
    }, adminId);
    await saveReviewBatch(adminId, batch);
    batchLog('create_ok', { adminId: Number(adminId), batchNumber: batch.batchNumber, selected: batch.ids.length, ms: Date.now() - t0 });
    return { status: 'created', batch, messages: claimed };
  } finally {
    await releaseLock(lockKey, lock);
  }
}

/**
 * ارسال پیام‌های Batch — پیشرفت افزایشی بعد از هر send موفق
 */
export async function sendReviewBatch(chatId, batch, rows, opts) {
  const resumed = !!(opts && opts.resumed);
  const adminId = Number((opts && opts.adminId) || chatId) || null;
  const t0 = Date.now();
  const TIME_BUDGET_MS = 45000;

  if (!batch && adminId) {
    try { batch = await getReviewBatch(adminId); } catch (_e) {}
  }
  batch = normalizeBatchState(batch || { ids: [] }, adminId);

  const alreadyDelivered = Object.create(null);
  for (const d of batch.delivered || []) alreadyDelivered[Number(d)] = 1;

  const live = [];
  const seen = Object.create(null);
  const idOrder =
    batch.ids && batch.ids.length
      ? batch.ids.map(Number)
      : (rows || [])
          .map(function (r) {
            return Number(r && r.id);
          })
          .filter(Boolean);

  for (const id of idOrder) {
    if (!id || seen[id]) continue;
    if (live.length >= REVIEW_BATCH_SIZE) break;
    if (resumed && alreadyDelivered[id] && !(opts && opts.forceResend)) {
      seen[id] = 1;
      continue;
    }
    try {
      const fresh = await getMessageById(Number(id));
      if (fresh && String(fresh.status || '') === 'pending') {
        seen[id] = 1;
        live.push(fresh);
      }
    } catch (_e) {}
  }

  if (adminId && live.length < REVIEW_BATCH_SIZE) {
    try {
      const more = (await selectReviewablePending(adminId, REVIEW_BATCH_SIZE)) || [];
      for (const m of more) {
        if (live.length >= REVIEW_BATCH_SIZE) break;
        const id = Number(m && m.id);
        if (!id || seen[id] || alreadyDelivered[id]) continue;
        if (String(m.status || '') !== 'pending') continue;
        const cl = await tryClaimReviewMessage(id, adminId, batch.batchNumber);
        if (!cl.ok) continue;
        seen[id] = 1;
        live.push(m);
        if (!(batch.ids || []).map(Number).includes(id)) {
          batch.ids = (batch.ids || []).concat([id]);
        }
      }
      try {
        await saveReviewBatch(adminId, batch);
      } catch (_e) {}
    } catch (eTop) {
      console.error('sendReviewBatch topup', eTop);
    }
  }

  if (!live.length) {
    if (adminId && (batch.ids || []).length) {
      let still = 0;
      for (const id of batch.ids) {
        try {
          const r = await getMessageById(id);
          if (r && String(r.status) === 'pending') still++;
        } catch (_e) {}
      }
      if (still && resumed) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            '⏳ Batch شماره ' +
            batch.batchNumber +
            ' — ' +
            still +
            ' پیام تحویل‌شده هنوز بررسی نشده‌اند.\nپس از بررسی همه، Batch بعدی آزاد می‌شود.',
        });
        batchLog('send_resume_waiting_review', { adminId: adminId, batchNumber: batch.batchNumber, remaining: still });
        return { sent: 0, batch: batch, waitingReview: true };
      }
    }
    if (adminId) {
      try { await clearReviewBatch(adminId); } catch (_e) {}
    }
    await api.sendMessage({
      chat_id: chatId,
      text: '📭 در این Batch پیام pending نمانده. دوباره «📥 پیام‌های در انتظار» را بزنید.',
    });
    return { sent: 0, batch: null };
  }

  if (!resumed) {
    try { await maybeGreetShiftStart(chatId, chatId); } catch (_e) {}
  }

  const head = resumed
    ? '⏳ ادامه Batch شماره ' + batch.batchNumber + '\n' + live.length + ' پیام برای تحویل/بررسی.'
    : '📥 Batch شماره ' + batch.batchNumber + '\n' + live.length + ' پیام برای بررسی';

  const uiIds = [];
  try {
    const headMsg = await api.sendMessage({ chat_id: chatId, text: head });
    const hid = headMsg && (headMsg.message_id || headMsg.messageId);
    if (hid) uiIds.push(Number(hid));
  } catch (_e) {
    try { await api.sendMessage({ chat_id: chatId, text: head }); } catch (_e2) {}
  }

  const deliveredNow = [];
  const failedNow = [];
  let deferred = false;
  const bn = batch.batchNumber || 0;

  async function sendOne(row, useHtml) {
    const ck = String((row.channelKey ?? row.channel_key) || '');
    const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
    let senderLine = '';
    try {
      if (isOwner(Number(chatId))) {
        const suid = Number(row.userId ?? row.user_id);
        let sname = String(suid || '');
        try {
          const su = await getUser(suid);
          sname = displayName(su, suid);
        } catch (_e) {}
        if (useHtml) {
          senderLine =
            'فرستنده: ' +
            escapeHtmlBatch(sname) +
            ' · <code>' +
            escapeHtmlBatch(String(suid)) +
            '</code>\n';
        } else {
          senderLine = 'فرستنده: ' + sname + ' · ' + suid + '\n';
        }
      }
    } catch (_e) {}
    const bodyTxt =
      '#' + row.id + ' | ' + title + '\n' + senderLine + '\n' + String(row.content || '').slice(0, 3600);
    const payload = {
      chat_id: chatId,
      text: bodyTxt,
      reply_markup: sanitizeMarkup(reviewInline(row.id, false, bn)),
    };
    if (useHtml && senderLine) payload.parse_mode = 'HTML';
    const sent = await api.sendMessage(payload);
    return sent && (sent.message_id || sent.messageId);
  }

  for (const row of live) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      deferred = true;
      batchLog('send_budget_stop', { adminId: adminId, batchNumber: bn, deliveredNow: deliveredNow.length });
      break;
    }
    let okMid = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= BATCH_MAX_RETRIES_PER_MSG; attempt++) {
      try {
        okMid = await sendOne(row, true);
        if (okMid) break;
      } catch (e1) {
        lastErr = e1;
        if (isTelegram429(e1)) {
          const ra = parseTelegramRetryAfter(e1) || 1;
          batchLog('send_429', { adminId: adminId, msgId: Number(row.id), retryAfter: ra, attempt: attempt });
          if (ra * 1000 > Math.max(500, TIME_BUDGET_MS - (Date.now() - t0))) {
            deferred = true;
            okMid = null;
            break;
          }
          await sleepMs(Math.min(ra * 1000, 5000));
          continue;
        }
        if (isPermanentTelegramError(e1)) {
          try {
            okMid = await sendOne(row, false);
            if (okMid) break;
          } catch (ePlain) {
            lastErr = ePlain;
            okMid = null;
            break;
          }
        }
        await sleepMs(80 * (attempt + 1));
      }
    }

    if (okMid) {
      uiIds.push(Number(okMid));
      deliveredNow.push(Number(row.id));
      if (adminId) {
        try {
          const cur = (await getReviewBatch(adminId)) || batch;
          const delivered = Array.from(new Set((cur.delivered || []).map(Number).concat([Number(row.id)])));
          const ids = Array.from(new Set((cur.ids || []).map(Number).concat([Number(row.id)])));
          cur.ids = ids;
          cur.delivered = delivered;
          await saveReviewBatch(adminId, cur);
          batch.delivered = delivered;
          batch.ids = ids;
        } catch (eSave) {
          console.error('incremental persist', eSave);
        }
      }
    } else if (!deferred) {
      failedNow.push(Number(row.id));
      batchLog('send_fail', {
        adminId: adminId,
        msgId: Number(row.id),
        err: String((lastErr && (lastErr.description || lastErr.message)) || lastErr || '').slice(0, 120),
      });
      if (adminId) {
        try {
          await releaseReviewClaim(row.id, adminId);
          const cur = (await getReviewBatch(adminId)) || batch;
          cur.ids = (cur.ids || []).map(Number).filter(function (x) { return x !== Number(row.id); });
          cur.failed = Array.from(new Set((cur.failed || []).map(Number).concat([Number(row.id)])));
          await saveReviewBatch(adminId, cur);
          batch.ids = cur.ids;
          batch.failed = cur.failed;
        } catch (_e) {}
      }
    }
    await sleepMs(BATCH_SEND_GAP_MS);
  }

  try {
    const adminKey = Number(adminId || chatId);
    const prevRaw = await settingGet('review_ui:' + adminKey, '[]');
    let prev = [];
    try { prev = JSON.parse(prevRaw) || []; } catch (_e) { prev = []; }
    const merged = prev.concat(uiIds).filter(Boolean).slice(-80);
    await settingSet('review_ui:' + adminKey, JSON.stringify(merged));
  } catch (eUi) {
    console.error('review_ui save', eUi);
  }

  batchLog('send_done', {
    adminId: adminId,
    batchNumber: bn,
    attempted: live.length,
    delivered: deliveredNow.length,
    failed: failedNow.length,
    deferred: deferred ? 1 : 0,
    resumed: resumed ? 1 : 0,
    ms: Date.now() - t0,
  });

  if (!deliveredNow.length && !resumed) {
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: deferred
          ? '⏳ تلگرام موقتاً محدودیت ارسال گذاشت. چند ثانیه بعد دوباره «📥 پیام‌های در انتظار» را بزنید.'
          : '⚠️ ارسال پیام‌های Batch ناموفق بود.\nچند ثانیه بعد دوباره «📥 پیام‌های در انتظار» را بزنید.',
      });
    } catch (_e) {}
  } else if (deferred) {
    try {
      await api.sendMessage({
        chat_id: chatId,
        text:
          '⏳ بخشی از Batch به‌خاطر محدودیت/زمان به تعویق افتاد.\nتحویل‌شده: ' +
          deliveredNow.length +
          '\nدوباره «📥 پیام‌های در انتظار» را بزنید تا ادامه برسد.',
      });
    } catch (_e) {}
  }

  return { sent: deliveredNow.length, failed: failedNow.length, deferred: deferred, batch: batch };
}

/**
 * بررسی مجوز ادمین برای یک پیام.
 * مالک: مستثنی.
 * ادمین/ساب‌لیدر: فقط کانال مجاز (شیفت فعال یا اسکوپ ساب‌لیدر بدون شیفت).
 * عضویت در Batch دیگر اجباری نیست — اگر Batch از بین برود دکمه تأیید گیر نکند.
 */
export async function checkReviewAccess(adminId, row) {
  if (isOwner(adminId)) return { ok: true };
  if (!row) return { ok: false, code: 'missing', text: 'پیام یافت نشد.' };
  const st = String(row.status || '');
  if (st === 'publishing') {
    const holder = Number(row.reviewedBy ?? row.reviewed_by) || 0;
    if (isOwner(adminId) || (holder && holder === Number(adminId))) return { ok: true };
    return { ok: false, code: 'busy', text: 'این پیام در حال انتشار توسط فرد دیگری است.' };
  }
  if (st !== 'pending') {
    return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };
  }
  const ch = String((row.channelKey ?? row.channel_key) || '');
  const chN = normalizeChannelKey(ch) || ch;
  let allowed = [];
  try {
    allowed = await allowedReviewChannels(adminId);
  } catch (e) {
    console.error('checkReviewAccess allowed', e);
    // fail-open جزئی: اگر Batch موجود باشد و پیام داخلش باشد، اجازه بده
    try {
      const batch = await getReviewBatch(adminId);
      if (batch && (batch.ids || []).map(Number).includes(Number(row.id))) {
        return { ok: true };
      }
    } catch (_e) {}
    return { ok: false, code: 'shift_ended', text: '❌ الان شیفت فعالی ندارید.' };
  }
  if (!allowed.length) {
    // آخرین شانس: پیام داخل Batch فعلی است
    try {
      const batch = await getReviewBatch(adminId);
      if (batch && (batch.ids || []).map(Number).includes(Number(row.id))) {
        return { ok: true };
      }
    } catch (_e) {}
    return { ok: false, code: 'shift_ended', text: '❌ الان شیفت فعالی ندارید.' };
  }
  const allowedN = allowed.map(function (k) {
    return normalizeChannelKey(k) || String(k);
  });
  if (allowedN.indexOf(chN) < 0 && allowed.indexOf(ch) < 0) {
    return {
      ok: false,
      code: 'channel',
      text: '⛔ این پیام مربوط به کانال شیفت فعلی شما نیست.',
    };
  }
  return { ok: true };
}

/**
 * تأیید/رد idempotent با قفل per-message.
 * decision: 'approve' | 'reject'
 * فقط یک فراخوانی ok:true می‌گیرد؛ بقیه code='done' یا 'busy'.
 */

/**
 * رزرو اتمیک پیام برای انتشار.
 * فقط اگر status=pending باشد به publishing می‌رود و reviewedBy ست می‌شود.
 * برنده: ok=true. بازنده رقابت: ok=false.
 */
export async function reserveMessageForPublish(msgId, reviewerId) {
  const id = Number(msgId);
  const rid = Number(reviewerId) || 0;
  if (!id) return { ok: false, code: 'bad_id' };
  try {
    await db
      .update(messages)
      .set({
        status: 'publishing',
        reviewedBy: rid || null,
        reviewedAt: new Date(),
      })
      .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
      .run();
    const rows = (await db.select().from(messages).where(eq(messages.id, id)).all()) || [];
    const row = rows[0];
    if (!row) return { ok: false, code: 'missing' };
    if (String(row.status) !== 'publishing') {
      return { ok: false, code: 'not_pending', row: row };
    }
    const holder = Number(row.reviewedBy ?? row.reviewed_by) || 0;
    if (rid && holder && holder !== rid) {
      return { ok: false, code: 'other_holder', row: row, holder: holder };
    }
    return { ok: true, row: row };
  } catch (e) {
    console.error('reserveMessageForPublish', e);
    return { ok: false, code: 'error' };
  }
}

/**
 * تکمیل انتشار برای رزروی که گیر کرده (همان reviewer یا مالک).
 * اگر holder دیگری باشد و owner نباشد → رد.
 */
export async function canCompletePublishing(msgId, reviewerId) {
  const id = Number(msgId);
  const rid = Number(reviewerId) || 0;
  try {
    const rows = (await db.select().from(messages).where(eq(messages.id, id)).all()) || [];
    const row = rows[0];
    if (!row) return { ok: false, code: 'missing' };
    if (String(row.status) !== 'publishing') {
      return { ok: false, code: 'not_publishing', row: row };
    }
    const holder = Number(row.reviewedBy ?? row.reviewed_by) || 0;
    if (isOwner(rid)) return { ok: true, row: row, holder: holder };
    if (holder && holder === rid) return { ok: true, row: row, holder: holder };
    // بدون holder — اجازه به کسی که شیفت دارد نمی‌دهیم مگر مالک؛ برای ایمنی فقط holder یا owner
    if (!holder) return { ok: true, row: row, holder: 0 };
    return { ok: false, code: 'other_holder', row: row, holder: holder };
  } catch (e) {
    console.error('canCompletePublishing', e);
    return { ok: false, code: 'error' };
  }
}

export async function decideMessage(adminId, id, decision, reason) {
  id = Number(id);
  const row = await getMessageById(id);
  if (!row) return { ok: false, code: 'notfound', text: 'پیام پیدا نشد.' };
  const st0 = String(row.status || '');
  if (st0 !== 'pending' && st0 !== 'publishing') {
    return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };
  }

  const alreadyReserved = st0 === 'publishing';
  if (!alreadyReserved && decision === 'approve') {
    try {
      const ck = String((row.channelKey ?? row.channel_key) || '');
      if (ck && (await isChannelAdMode(ck))) {
        return {
          ok: false,
          code: 'ad_mode',
          text: '📢 کانال در حالت تب است؛ فعلاً نمی‌توان پیام را تأیید و منتشر کرد.',
        };
      }
    } catch (_e) {}
  }

  if (!alreadyReserved) {
    const access = await checkReviewAccess(adminId, row);
    if (!access.ok) return access;
  }

  // مسیر سریع: از قبل publishing رزرو شده — بدون قفل و بدون خواندن دوباره
  if (alreadyReserved && decision === 'approve') {
    const patch = {
      status: 'approved',
      reviewedBy: Number(adminId),
      reviewedAt: new Date(),
    };
    await db.update(messages).set(patch).where(eq(messages.id, id)).run();
    try {
      const bk = exactBodyKey(row.content);
      if (bk) await settingSet(bodyIndexSettingKey(row.channelKey || row.channel_key, bk), String(id) + '|approved');
    } catch (_e) {}
    try {
      await dropMessageFromReviewBatch(adminId, id);
    } catch (_e) {}
    try {
      dropMessageFromAllReviewBatches(id).catch(function () {});
    } catch (_e) {}
    return { ok: true, row: row };
  }

  const lockKey = 'review_msg_lock:' + id;
  const lock = await acquireLock(lockKey);
  if (!lock) return { ok: false, code: 'busy', text: '⏳ در حال پردازش…' };
  try {
    const fresh = await getMessageById(id);
    const st = fresh ? String(fresh.status) : '';
    if (!fresh || (st !== 'pending' && st !== 'publishing')) {
      return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };
    }
    const patch =
      decision === 'approve'
        ? { status: 'approved', reviewedBy: Number(adminId), reviewedAt: new Date() }
        : {
            status: 'rejected',
            rejectReason: reason || 'نامناسب',
            reviewedBy: Number(adminId),
            reviewedAt: new Date(),
          };
    await db.update(messages).set(patch).where(eq(messages.id, id)).run();
    // ایندکس تکراری: pending/approved نگه دار؛ rejected آزاد کن
    try {
      const bk = exactBodyKey(fresh.content);
      if (bk) {
        const k = bodyIndexSettingKey(fresh.channelKey || fresh.channel_key, bk);
        if (decision === 'reject') await settingSet(k, String(id) + '|rejected');
        else if (decision === 'approve') await settingSet(k, String(id) + '|approved');
      }
    } catch (_e) {}
    try {
      await dropMessageFromReviewBatch(adminId, id);
    } catch (_e) {}
    try {
      dropMessageFromAllReviewBatches(id).catch(function () {});
    } catch (_e) {}
    return { ok: true, row: fresh };
  } finally {
    await releaseLock(lockKey, lock);
  }
}

/**
 * قدیمی: دیگر Push ندارد. پیام‌های Pending فقط با دکمه‌ی
 * «📥 پیام‌های در انتظار» (Batch) دریافت می‌شوند.
 * برای سازگاری export می‌شود و ارسال تلگرامی انجام نمی‌دهد.
 */
export async function notifyShiftAdmins(channelKey, text, replyMarkup, msgId) {
  // عمداً خالی: پیام جدید فقط از طریق Batch (📥 پیام‌های در انتظار) می‌آید، نه Push لحظه‌ای.
  return [];
}

/** قدیمی: دیگر Push ندارد (compat) */
export async function deliverPendingForAdmin(_adminId) {
  return 0;
}

/** لیست Pending قابل‌بررسی (فقط خواندن؛ جدیدترین اول) — compat */
export async function pendingForViewer(userId) {
  try {
    const all = await selectReviewablePending(userId);
    return all.sort((a, b) => b.id - a.id);
  } catch (e) {
    console.error('pendingForViewer', e);
    return [];
  }
}

/**
 * گزارش تحلیل داده برای مالک — سبک و بدون content پیام‌ها
 * scope: sadambazan | inkarbar | zendegi | all
 */
export async function buildDataAnalysisReport(scope, period, mode) {
  period = period || 'week';
  mode = mode || 'full';
  const now = tehranNow();
  const channelKeys =
    scope === 'all'
      ? Object.keys(DEFAULT_CHANNELS || {})
      : [scope].filter(function (k) {
          return DEFAULT_CHANNELS && DEFAULT_CHANNELS[k];
        });
  if (!channelKeys.length) return 'کانال نامعتبر.';

  function dayOffset(baseDateStr, offset) {
    const parts = String(baseDateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCDate(dt.getUTCDate() + offset);
    return (
      dt.getUTCFullYear() +
      '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getUTCDate()).padStart(2, '0')
    );
  }

  const allowedDays = {};
  let periodLabel = '';
  if (period === 'today') {
    allowedDays[now.date] = true;
    periodLabel = 'امروز (' + now.date + ')';
  } else if (period === 'yesterday') {
    const y = dayOffset(now.date, -1);
    allowedDays[y] = true;
    periodLabel = 'دیروز (' + y + ')';
  } else if (period === 'week') {
    for (let i = 0; i < 7; i++) allowedDays[dayOffset(now.date, -i)] = true;
    periodLabel = '۷ روز اخیر';
  } else if (period === 'month') {
    for (let i = 0; i < 30; i++) allowedDays[dayOffset(now.date, -i)] = true;
    periodLabel = '۳۰ روز اخیر';
  } else {
    periodLabel = 'کل نمونهٔ اخیر';
  }
  const filterByDay = period !== 'all';

  function tsMs(ts) {
    if (ts == null) return null;
    try {
      let t = ts;
      if (typeof t === 'string' && /^\d+$/.test(t)) t = Number(t);
      if (typeof t === 'number' && t < 1e12) t = t * 1000;
      const ms = new Date(t).getTime();
      return Number.isFinite(ms) ? ms : null;
    } catch (_e) {
      return null;
    }
  }

  function fmtMins(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' دقیقه';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h + 'س ' + r + 'د';
  }

  function avg(arr) {
    if (!arr || !arr.length) return null;
    let s = 0;
    for (const x of arr) s += x;
    return s / arr.length;
  }

  let allSh = [];
  try {
    allSh = (await db.select().from(shifts).orderBy(desc(shifts.id)).limit(4000).all()) || [];
  } catch (e) {
    console.error('da shifts', e);
  }

  let allAdmins = [];
  try {
    allAdmins = (await db.select().from(channelAdmins).all()) || [];
  } catch (e) {
    console.error('da admins', e);
  }

  let allMsg = [];
  try {
    allMsg =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
          reviewedBy: messages.reviewedBy,
          reviewedAt: messages.reviewedAt,
          submittedAt: messages.submittedAt,
          rejectReason: messages.rejectReason,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(8000)
        .all()) || [];
  } catch (e) {
    console.error('da msgs', e);
  }

  const scopeSet = {};
  for (const k of channelKeys) scopeSet[k] = true;

  // ادمین‌های معتبر فقط از جدول channel_admins
  const validAdminByCh = {};
  const validAdminAll = {};
  for (const a of allAdmins) {
    const ck = String(a.channelKey || a.channel_key || '');
    const uid = Number(a.userId != null ? a.userId : a.user_id);
    if (!uid || !scopeSet[ck]) continue;
    if (!validAdminByCh[ck]) validAdminByCh[ck] = {};
    validAdminByCh[ck][uid] = true;
    validAdminAll[uid] = true;
  }

  function inPeriodSub(m) {
    if (!filterByDay) return true;
    const d = tehranDateOfTs(m.submittedAt);
    return d && allowedDays[d];
  }
  function inPeriodRev(m) {
    if (!filterByDay) return true;
    const d = tehranDateOfTs(m.reviewedAt);
    return d && allowedDays[d];
  }

  const msgScope = allMsg.filter(function (m) {
    return scopeSet[String(m.channelKey || m.channel_key || '')];
  });

  const received = msgScope.filter(inPeriodSub);
  const reviewed = msgScope.filter(function (m) {
    const st = String(m.status || '');
    return (st === 'approved' || st === 'rejected') && inPeriodRev(m);
  });
  const pendingNow = msgScope.filter(function (m) {
    return String(m.status) === 'pending';
  });

  let ap = 0;
  let rj = 0;
  const waitSamples = [];
  const handleSamples = [];
  const nowMs = Date.now();
  for (const m of reviewed) {
    if (String(m.status) === 'approved') ap++;
    else rj++;
    const sub = tsMs(m.submittedAt);
    const rev = tsMs(m.reviewedAt);
    if (sub != null && rev != null && rev >= sub) {
      waitSamples.push(rev - sub);
      handleSamples.push(rev - sub);
    }
  }
  for (const m of pendingNow) {
    const sub = tsMs(m.submittedAt);
    if (sub != null) waitSamples.push(nowMs - sub);
  }

  const scopeTitle =
    scope === 'all'
      ? 'همه کانال‌ها'
      : (DEFAULT_CHANNELS[scope] && DEFAULT_CHANNELS[scope].title) || scope;

  let body = '';
  body += '📈 تحلیل داده — «' + scopeTitle + '»\n';
  body += '🗓 بازه: ' + periodLabel + '\n';
  body += 'نمونهٔ پیام: ' + allMsg.length + ' ردیف اخیر\n';

  // —— چرخه پیام ——
  if (mode === 'msg' || mode === 'full') {
    body += '\n════════════\n📨 چرخه پیام‌ها\n════════════\n';
    body += '📥 دریافتی (بازه): ' + received.length + '\n';
    body += '🟢 تأیید: ' + ap + '\n';
    body += '🔴 رد: ' + rj + '\n';
    body += '🟡 در انتظار الان: ' + pendingNow.length + '\n';
    const done = ap + rj;
    if (done > 0) {
      body += '٪ تأیید: ' + Math.round((ap / done) * 100) + '٪\n';
      body += '٪ رد: ' + Math.round((rj / done) * 100) + '٪\n';
    }
    body += '⏱ میانگین انتظار تا رسیدگی: ' + fmtMins(avg(handleSamples)) + '\n';
    if (pendingNow.length) {
      const ages = [];
      for (const m of pendingNow) {
        const sub = tsMs(m.submittedAt);
        if (sub != null) ages.push(nowMs - sub);
      }
      body += '⏳ میانگین سن صف فعلی: ' + fmtMins(avg(ages)) + '\n';
      body += '🕰 قدیمی‌ترین pending: ' + fmtMins(ages.length ? Math.max.apply(null, ages) : null) + '\n';
    }

    // تفکیک کانال
    body += '\n📺 تفکیک کانال (بازه):\n';
    for (const ck of channelKeys) {
      const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
      let r = 0,
        a = 0,
        j = 0,
        p = 0;
      for (const m of msgScope) {
        if (String(m.channelKey) !== ck) continue;
        if (String(m.status) === 'pending') p++;
        if (inPeriodSub(m)) r++;
        if (inPeriodRev(m)) {
          if (String(m.status) === 'approved') a++;
          if (String(m.status) === 'rejected') j++;
        }
      }
      body +=
        '• «' +
        title +
        '» 📥' +
        r +
        ' 🟢' +
        a +
        ' 🔴' +
        j +
        ' 🟡' +
        p +
        '\n';
    }

    // دلایل رد
    const reasons = {};
    for (const m of reviewed) {
      if (String(m.status) !== 'rejected') continue;
      const rr = String(m.rejectReason || 'نامشخص').slice(0, 40);
      reasons[rr] = (reasons[rr] || 0) + 1;
    }
    const reasonList = Object.keys(reasons)
      .map(function (k) {
        return { k: k, n: reasons[k] };
      })
      .sort(function (a, b) {
        return b.n - a.n;
      })
      .slice(0, 8);
    if (reasonList.length) {
      body += '\n📌 دلایل رد پرتکرار:\n';
      for (const x of reasonList) body += '• ' + x.k + ': ' + x.n + '\n';
    }
  }

  // —— ادمین‌ها ——
  if (mode === 'adm' || mode === 'full') {
    body += '\n════════════\n👮 عملکرد ادمین‌ها\n════════════\n';
    body += '(فقط ادمین‌های فعلی هر کانال)\n';

    const adminStats = [];
    for (const aidStr of Object.keys(validAdminAll)) {
      const aid = Number(aidStr);
      let a = 0,
        j = 0;
      let inS = 0,
        outS = 0;
      const durs = [];
      let lastAct = null;
      for (const m of reviewed) {
        if (Number(m.reviewedBy) !== aid) continue;
        if (String(m.status) === 'approved') a++;
        else if (String(m.status) === 'rejected') j++;
        const ck = String(m.channelKey || '');
        if (reviewMatchedShift(aid, ck, m.reviewedAt, allSh)) inS++;
        else outS++;
        const sub = tsMs(m.submittedAt);
        const rev = tsMs(m.reviewedAt);
        if (sub != null && rev != null && rev >= sub) durs.push(rev - sub);
        if (rev != null && (lastAct == null || rev > lastAct)) lastAct = rev;
      }
      let shiftsN = 0;
      for (const s of allSh) {
        if (Number(s.adminId || s.admin_id) !== aid) continue;
        if (String(s.status) === 'cancelled') continue;
        const ck = String(s.channelKey || s.channel_key || '');
        if (!scopeSet[ck]) continue;
        if (!validAdminByCh[ck] || !validAdminByCh[ck][aid]) continue;
        const sd = String(s.shiftDate || s.shift_date || '');
        if (filterByDay) {
          if (sd === 'perm' || sd === 'permanent') continue;
          if (!allowedDays[sd]) continue;
        }
        shiftsN++;
      }
      const total = a + j;
      adminStats.push({
        id: aid,
        ap: a,
        rj: j,
        total: total,
        inShift: inS,
        outShift: outS,
        shifts: shiftsN,
        avgHandle: avg(durs),
        lastAct: lastAct,
        rejectPct: total ? Math.round((j / total) * 100) : 0,
      });
    }

    adminStats.sort(function (x, y) {
      return y.total - x.total || y.shifts - x.shifts;
    });

    const shown = adminStats.slice(0, 25);
    if (!shown.length) {
      body += 'ادمینی در محدوده ثبت نشده.\n';
    } else {
      for (const st of shown) {
        let name = String(st.id);
        try {
          name = displayName(await getUser(st.id), st.id);
        } catch (_e) {}
        body +=
          '\n👤 ' +
          name +
          '\n  ✅' +
          st.ap +
          ' ❌' +
          st.rj +
          ' (جمع ' +
          st.total +
          ') · ٪رد ' +
          st.rejectPct +
          '\n  📍 در شیفت: ' +
          (st.inShift || 0) +
          ' · خارج شیفت: ' +
          (st.outShift || 0) +
          '\n  ⏰ شیفت ثبت‌شده در بازه: ' +
          st.shifts +
          ' · میانگین رسیدگی: ' +
          fmtMins(st.avgHandle) +
          '\n';
        if (st.lastAct) {
          body += '  🕰 آخرین فعالیت: ' + fmtMins(nowMs - st.lastAct) + ' پیش\n';
        }
      }
      if (adminStats.length > shown.length) {
        body += '\n… و ' + (adminStats.length - shown.length) + ' ادمین دیگر\n';
      }
    }

    // ضعیف‌ها: شیفت داشته بررسی کم
    const low = adminStats
      .filter(function (s) {
        return s.shifts >= 1 && s.total < Math.max(2, s.shifts);
      })
      .slice(0, 6);
    if (low.length) {
      body += '\n⚠️ شیفت گرفته ولی بررسی کم:\n';
      for (const s of low) {
        let name = String(s.id);
        try {
          name = displayName(await getUser(s.id), s.id);
        } catch (_e) {}
        body += '• ' + name + ' | شیفت ' + s.shifts + ' | بررسی ' + s.total + '\n';
      }
    }
  }

  // —— نتیجه مدیریتی ——
  if (mode === 'full' || mode === 'msg') {
    body += '\n════════════\n🧠 جمع‌بندی مدیریتی\n════════════\n';
    const tips = [];
    if (pendingNow.length > 50) {
      tips.push('صف انتظار بالاست (' + pendingNow.length + '). نیاز به ادمین/شیفت بیشتر در ساعات پیک.');
    }
    if (ap + rj > 0 && rj / (ap + rj) > 0.35) {
      tips.push('نسبت رد بالاست (' + Math.round((rj / (ap + rj)) * 100) + '٪). قوانین ارسال یا آموزش کاربران را بررسی کنید.');
    }
    const avgW = avg(handleSamples);
    if (avgW != null && avgW > 2 * 3600 * 1000) {
      tips.push('میانگین زمان رسیدگی بیش از ۲ ساعت است — پوشش شیفت را متراکم‌تر کنید.');
    }
    // نسبت خارج از شیفت
    let totR = 0,
      outR = 0;
    for (const st of adminStats || []) {
      totR += st.total || 0;
      outR += st.outShift || 0;
    }
    if (totR > 20 && outR / totR > 0.4) {
      tips.push(
        'حدود ' +
          Math.round((outR / totR) * 100) +
          '٪ بررسی‌ها خارج از بازه شیفت ثبت‌شده است (ساب‌لیدر بدون شیفت، پایان Batch، یا مالک).'
      );
    }
    if (!tips.length) {
      tips.push('شاخص‌های اصلی در محدوده قابل‌قبول نمونه هستند. روی کانال‌های با صف بالاتر تمرکز کنید.');
    }
    for (let i = 0; i < tips.length; i++) {
      body += i + 1 + ') ' + tips[i] + '\n';
    }
  }

  body +=
    '\n────────────\n' +
    'ℹ️ آمار از نمونهٔ حداکثر ۸۰۰۰ پیام اخیر + جداول شیفت و ادمین فعلی است.\n' +
    'افراد خارج از لیست ادمین کانال در گزارش ادمین نمی‌آیند.';

  return body;
}

export async function testChannels() {
  const results = [];
  for (const [key, conf] of Object.entries(DEFAULT_CHANNELS)) {
    const chatId = conf.chatId;
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: '🧪 تست ربات آرال — کانال «' + conf.title + '»\nاگر این پیام را می‌بینید، ربات در کانال دسترسی ارسال دارد.',
      });
      results.push({ key, title: conf.title, ok: true, detail: 'ارسال موفق' });
    } catch (e) {
      results.push({
        key,
        title: conf.title,
        ok: false,
        detail: e?.description || String(e),
      });
    }
  }
  return results;
}

export function toBoldHtml(text) {
  const s = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<b>' + s + '</b>';
}

export async function postToChannel(channelKey, text) {
  const conf = DEFAULT_CHANNELS[channelKey];
  if (!conf) throw new Error('channel');
  return await api.sendMessage({
    chat_id: conf.chatId,
    text: toBoldHtml(text),
    parse_mode: 'HTML',
  });
}

/** اطلاعیه کاربران — پیاده‌سازی در lib/announcements.js */
export {
  setPassiveUserAnnounce,
  clearPassiveUserAnnounce,
  getPassiveUserAnnounce,
  maybeDeliverPassiveAnnounce,
  activateUserAnnouncement,
  cancelAnnouncement,
  countEligibleAnnounceUsers,
  listAnnouncementsByStatus,
  getAnnouncement,
  countReceipts,
  formatAnnouncementStats,
  announceManageKeyboard,
  announceActivateConfirmInline,
  announceDetailInline,
  announceCancelConfirmInline,
} from 'lib/announcements';

