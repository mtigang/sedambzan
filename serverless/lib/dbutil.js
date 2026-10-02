import { api, db } from 'sdk';
import {  channels, channelAdmins, shifts, settings, users, messages, subLeaders } from 'schema';
// subLeaders used for role
import { eq, and } from 'sdk/db';
import {
  DEFAULT_CHANNELS,
  OWNER_IDS,
  CHANNEL_IDS,
  ADMIN_GROUP_IDS,
} from 'lib/config';
import { tehranNow, inRange, periodDateStr, normHm, hourKeyOf } from 'lib/time';
import { reviewInline } from 'lib/keyboards';

export async function ensureChannelsSeeded() {
  try {
    // همیشه از DEFAULT_CHANNELS همگام کن (ساعت کاری ۱۲:۰۰–۰۳:۰۰)
    for (const c of Object.values(DEFAULT_CHANNELS)) {
      try {
        const exist = await db.select().from(channels).where(eq(channels.key, c.key)).all();
        if (exist?.length) {
          await db
            .update(channels)
            .set({
              title: c.title,
              link: String(c.chatId),
              enabled: 1,
              workStart: c.workStart || '12:00',
              workEnd: c.workEnd || '03:00',
            })
            .where(eq(channels.key, c.key))
            .run();
        } else {
          await db
            .insert(channels)
            .values({
              key: c.key,
              title: c.title,
              link: String(c.chatId),
              enabled: 1,
              workStart: c.workStart || '12:00',
              workEnd: c.workEnd || '03:00',
            })
            .run();
        }
      } catch (e) {
        console.error('seed', c.key, e);
      }
    }
    return (await db.select().from(channels).all()) || [];
  } catch (e) {
    console.error('ensureChannelsSeeded', e);
    return Object.values(DEFAULT_CHANNELS).map((c) => ({
      key: c.key,
      title: c.title,
      link: String(c.chatId),
      enabled: 1,
      workStart: c.workStart || '12:00',
      workEnd: c.workEnd || '03:00',
    }));
  }
}

export async function getChannels() {
  return (await ensureChannelsSeeded()) || [];
}

export async function getChannel(key) {
  try {
    const rows = await db.select().from(channels).where(eq(channels.key, key)).all();
    if (rows?.[0]) {
      const r = rows[0];
      return {
        ...r,
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
    workStart: d.workStart,
    workEnd: d.workEnd,
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
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    if (rows?.length) {
      await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key)).run();
    } else {
      await db.insert(settings).values({ key, value: String(value) }).run();
    }
  } catch (e) {
    console.error('settingSet', e);
  }
}

export async function isBotOn() {
  return (await settingGet('bot_enabled', '1')) !== '0';
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
  if (!u || Number(u.started) !== 1) return String(id);
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ');
  if (n) return n;
  if (u.username) return '@' + u.username;
  return String(u.userId || id);
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
    const ca = await db.select().from(channelAdmins).where(eq(channelAdmins.userId, id)).all();
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

export async function adminChannels(userId) {
  try {
    const rows = await db
      .select()
      .from(channelAdmins)
      .where(eq(channelAdmins.userId, userId))
      .all();
    return (rows || []).map((r) => r.channelKey);
  } catch (_) {
    return [];
  }
}

export async function addChannelAdmin(userId, channelKey) {
  if (isOwner(userId)) return;
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    const exists = all.some(
      (r) =>
        Number(r.userId ?? r.user_id) === Number(userId) &&
        (r.channelKey === channelKey || r.channel_key === channelKey)
    );
    if (exists) return;
    await db.insert(channelAdmins).values({ userId: Number(userId), channelKey }).run();
  } catch (e) {
    console.error('addChannelAdmin insert', e);
    // retry once
    try {
      await db.insert(channelAdmins).values({ userId: Number(userId), channelKey }).run();
    } catch (e2) {
      console.error('addChannelAdmin retry', e2);
      return;
    }
  }
  try {
    const u = await getUser(userId);
    if (u) {
      if (u.role !== 'owner' && u.role !== 'admin') {
        await db.update(users).set({ role: 'admin' }).where(eq(users.userId, userId)).run();
      }
    } else {
      await db.insert(users).values({ userId: Number(userId), role: 'admin', started: 0 }).run();
    }
  } catch (e) {
    console.error('addChannelAdmin role', e);
  }
}

export async function removeChannelAdmin(userId, channelKey) {
  try {
    await db
      .delete(channelAdmins)
      .where(and(eq(channelAdmins.userId, userId), eq(channelAdmins.channelKey, channelKey)))
      .run();
    const left = await adminChannels(userId);
    if (!left.length) {
      const u = await getUser(userId);
      if (u && u.role === 'admin') {
        await db.update(users).set({ role: 'user' }).where(eq(users.userId, userId)).run();
      }
    }
  } catch (e) {
    console.error('removeChannelAdmin', e);
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
  if (!force) {
    const last = Number(await settingGet('last_admin_sync', '0')) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return null;
  }
  const results = {};
  for (const key of Object.keys(ADMIN_GROUP_IDS)) {
    results[key] = await syncAdminsFromGroup(key);
  }
  await settingSet('last_admin_sync', String(Date.now()));
  return results;
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
      .filter((s) => {
        if (s.shiftDate === 'perm' || s.shiftDate === 'permanent') {
          return inRange(now.hm, s.startHm, s.endHm);
        }
        if (s.shiftDate !== pdate && s.shiftDate !== now.date) return false;
        return inRange(now.hm, s.startHm, s.endHm);
      })
      .map((s) => s.adminId);
  } catch (e) {
    console.error('activeShiftAdmins', e);
    return [];
  }
}

/* ============================================================
 *  سیستم Batch بررسی پیام‌ها (Serverless-safe)
 *  - هیچ Pending ای خودکار برای ادمین ارسال نمی‌شود (No Push).
 *  - ادمین با دکمه‌ی «📥 پیام‌های در انتظار» یک Batch ده‌تایی می‌گیرد.
 *  - IDهای Batch در settings با کلید review_batch:<adminId> ذخیره می‌شوند.
 *  - Lock با Timestamp در DB (بدون setTimeout)؛ TTL کوتاه.
 *  - Batch state ≠ Message state: حذف Batch هیچ پیامی را تغییر نمی‌دهد.
 * ============================================================ */

export const REVIEW_BATCH_SIZE = 10;
const REVIEW_LOCK_TTL_MS = 10 * 1000;

function reviewBatchKey(adminId) {
  return 'review_batch:' + Number(adminId);
}

/** آیا این رکورد shift همین الان (تهران) فعال است؟ */
function shiftActiveNow(s, now, pdate) {
  if (!s || s.status !== 'active') return false;
  const start = String(s.startHm || '');
  const end = String(s.endHm || '');
  if (!start || !end || start === end) return false;
  if (s.shiftDate === 'perm' || s.shiftDate === 'permanent') {
    return inRange(now.hm, start, end);
  }
  if (s.shiftDate !== pdate && s.shiftDate !== now.date) return false;
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

export async function findAdminShiftConflict(adminId, shiftDate, startHm, endHm, excludeId = null) {
  try {
    const rows = (await db.select().from(shifts).where(
      and(eq(shifts.adminId, Number(adminId)), eq(shifts.status, 'active'))
    ).all()) || [];
    const newPermanent = shiftDate === 'perm' || shiftDate === 'permanent';
    return rows.find((s) => {
      if (excludeId != null && Number(s.id) === Number(excludeId)) return false;
      const oldPermanent = s.shiftDate === 'perm' || s.shiftDate === 'permanent';
      const samePeriod = newPermanent || oldPermanent || String(s.shiftDate) === String(shiftDate);
      if (!samePeriod) return false;
      return shiftIntervalOverlaps(startHm, endHm, s.startHm, s.endHm);
    }) || null;
  } catch (e) {
    console.error('findAdminShiftConflict', e);
    return null;
  }
}

export async function activeShiftChannelKeys(adminId) {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.adminId, Number(adminId)), eq(shifts.status, 'active')))
        .all()) || [];
    return [...new Set(rows.filter((s) => shiftActiveNow(s, now, pdate)).map((s) => s.channelKey))];
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

export async function canAdminReviewMessage(adminId, channelKey) {
  if (isOwner(adminId)) return true;
  const keys = await activeShiftChannelKeys(adminId);
  return keys.includes(channelKey);
}

/* ---------- Lock مبتنی بر Timestamp در DB ---------- */

/**
 * گرفتن قفل. insert روی کلید یکتا (PRIMARY KEY) اتمیک است.
 * اگر قفل موجود ولی منقضی بود، با compare-and-swap تصاحب می‌شود.
 * برمی‌گرداند: توکن قفل (string) یا null (مشغول).
 */
async function acquireLock(key, ttl = REVIEW_LOCK_TTL_MS) {
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

async function releaseLock(key, mine) {
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
    if (b && Array.isArray(b.ids)) return b;
  } catch (_e) {}
  return null;
}

/** برخلاف settingSet خطا را می‌اندازد تا Batch نیمه‌کاره ثبت نشود */
async function saveReviewBatch(adminId, batch) {
  const key = reviewBatchKey(adminId);
  const value = JSON.stringify(batch);
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  if (rows && rows.length) {
    await db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  } else {
    await db.insert(settings).values({ key, value }).run();
  }
}

/** فقط state Batch را پاک می‌کند؛ هیچ پیامی تغییر نمی‌کند */
export async function clearReviewBatch(adminId) {
  try {
    await db.delete(settings).where(eq(settings.key, reviewBatchKey(adminId))).run();
  } catch (e) {
    console.error('clearReviewBatch', e);
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
  const b = await getReviewBatch(adminId);
  if (!b) return true;
  const rows = await getReviewBatchMessages(adminId);
  return rows.every((r) => r.status !== 'pending');
}

/** Pendingهای قابل‌بررسی ادمین، قدیمی‌ترین اول */
async function selectReviewablePending(adminId) {
  const pending = (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
  pending.sort((a, b) => a.id - b.id);
  if (isOwner(adminId)) return pending;
  // ساب‌لیدر: فقط کانال Scope — بدون نیاز به شیفت
  const slCh = await getActiveSubLeaderChannel(adminId);
  if (slCh) return pending.filter((m) => m.channelKey === slCh);
  const keys = await activeShiftChannelKeys(adminId);
  if (!keys.length) return [];
  return pending.filter((m) => keys.includes(m.channelKey));
}

/**
 * وضعیت Batch بعد از هر تأیید/رد (فقط‌خواندنی).
 * messageId اختیاری: اگر پیام عضو Batch نباشد inBatch=false.
 */
export async function finishReviewBatchIfComplete(adminId, messageId) {
  try {
    const batch = await getReviewBatch(adminId);
    if (!batch) return { inBatch: false, complete: true, hasMore: false, batch: null };
    if (messageId != null && !batch.ids.map(Number).includes(Number(messageId))) {
      return { inBatch: false, complete: false, hasMore: false, batch };
    }
    const complete = await isReviewBatchComplete(adminId);
    let hasMore = false;
    if (complete) hasMore = (await selectReviewablePending(adminId)).length > 0;
    return { inBatch: true, complete, hasMore, batch };
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
export async function createReviewBatch(adminId) {
  adminId = Number(adminId);
  const owner = isOwner(adminId);
  const slCh = owner ? null : await getActiveSubLeaderChannel(adminId);
  let keys = null;
  if (!owner) {
    if (slCh) {
      keys = [slCh];
    } else {
      keys = await activeShiftChannelKeys(adminId);
      if (!keys.length) return { status: 'no_shift' };
    }
  }

  const lockKey = 'review_lock:' + adminId;
  const lock = await acquireLock(lockKey);
  if (!lock) return { status: 'busy' };

  try {
    const old = await getReviewBatch(adminId);
    if (old) {
      const rows = await getReviewBatchMessages(adminId);
      let pendingRows = rows.filter((r) => r.status === 'pending');
      if (pendingRows.length && !owner) {
        // سیاست شیفت بعدی: Batch ناقص ادامه می‌یابد، فقط برای کانال‌های شیفت فعلی.
        // پیام‌های کانال‌های غیرفعال از Batch کنار گذاشته می‌شوند (در صف pending می‌مانند).
        const stale = pendingRows.filter((r) => !keys.includes(r.channelKey));
        if (stale.length) {
          const drop = new Set(stale.map((r) => Number(r.id)));
          pendingRows = pendingRows.filter((r) => !drop.has(Number(r.id)));
          if (pendingRows.length) {
            old.ids = old.ids.filter((id) => !drop.has(Number(id)));
            await saveReviewBatch(adminId, old);
          }
        }
      }
      if (pendingRows.length) {
        if (!owner) {
          keys = await activeShiftChannelKeys(adminId);
          if (!keys.length) {
            await clearReviewBatch(adminId);
            return { status: 'no_shift' };
          }
          pendingRows = pendingRows.filter((r) => keys.includes(r.channelKey));
          if (!pendingRows.length) {
            await clearReviewBatch(adminId);
          } else {
            old.ids = pendingRows.map((r) => r.id);
            await saveReviewBatch(adminId, old);
            return { status: 'incomplete', batch: old, messages: pendingRows };
          }
        } else {
          return { status: 'incomplete', batch: old, messages: pendingRows };
        }
      }
    }

    const candidates = (await selectReviewablePending(adminId)).slice(0, REVIEW_BATCH_SIZE);
    if (!candidates.length) return { status: 'empty' };

    const batch = {
      ids: candidates.map((m) => Number(m.id)),
      batchNumber: (old && Number(old.batchNumber) ? Number(old.batchNumber) : 0) + 1,
      createdAt: Date.now(),
      periodDate: periodDateStr(),
    };
    await saveReviewBatch(adminId, batch);
    return { status: 'created', batch, messages: candidates };
  } finally {
    await releaseLock(lockKey, lock);
  }
}

/** ارسال پیام‌های Batch به ادمین (حداکثر ۱۰ + یک پیام سرتیتر) */
export async function sendReviewBatch(chatId, batch, rows, opts) {
  const resumed = !!(opts && opts.resumed);
  const lastId = Number(batch.ids[batch.ids.length - 1]);
  const head = resumed
    ? '⏳ Batch فعلی هنوز کامل بررسی نشده است.\nBatch شماره ' +
      batch.batchNumber +
      ' — ' +
      rows.length +
      ' پیام باقی‌مانده دوباره ارسال شد.'
    : '📥 Batch شماره ' + batch.batchNumber + '\n' + rows.length + ' پیام برای بررسی دریافت شد.';
  await api.sendMessage({ chat_id: chatId, text: head });
  for (const row of rows) {
    try {
      const ch = await getChannel(row.channelKey);
      const sender = await getUser(row.userId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          '#' +
          row.id +
          ' | ' +
          ((ch && ch.title) || row.channelKey) +
          ' | کاربر: ' +
          displayName(sender, row.userId) +
          '\n\n' +
          String(row.content || '').slice(0, 3800),
        reply_markup: reviewInline(row.id, Number(row.id) === lastId, batch.batchNumber),
      });
    } catch (e) {
      console.error('sendReviewBatch', row.id, e);
    }
  }
}

/**
 * بررسی مجوز ادمین برای یک پیام (هر Callback باید دوباره بررسی کند).
 * مالک: مستثنی. ادمین: شیفت فعال همان کانال + عضویت در Batch فعلی.
 */
export async function checkReviewAccess(adminId, row) {
  if (isOwner(adminId)) return { ok: true };
  const slCh = await getActiveSubLeaderChannel(adminId);
  if (slCh) {
    if (!row || row.channelKey !== slCh) {
      return { ok: false, code: 'channel', text: '⛔ این پیام خارج از محدوده کانال شماست.' };
    }
    const batch = await getReviewBatch(adminId);
    if (!batch || !batch.ids.map(Number).includes(Number(row.id))) {
      return { ok: false, code: 'not_in_batch', text: '⛔ این پیام در Batch فعلی شما نیست.' };
    }
    return { ok: true };
  }
  const keys = await activeShiftChannelKeys(adminId);
  if (!keys.length) return { ok: false, code: 'shift_ended', text: '❌ شیفت شما تمام شده است.' };
  if (!row || !keys.includes(row.channelKey)) {
    return { ok: false, code: 'channel', text: '⛔ این پیام مربوط به کانال شیفت فعلی شما نیست.' };
  }
  const batch = await getReviewBatch(adminId);
  if (!batch || !batch.ids.map(Number).includes(Number(row.id))) {
    return { ok: false, code: 'not_in_batch', text: '⛔ این پیام در Batch فعلی شما نیست.' };
  }
  return { ok: true };
}

/**
 * تأیید/رد idempotent با قفل per-message.
 * decision: 'approve' | 'reject'
 * فقط یک فراخوانی ok:true می‌گیرد؛ بقیه code='done' یا 'busy'.
 */
export async function decideMessage(adminId, id, decision, reason) {
  id = Number(id);
  const row = await getMessageById(id);
  if (!row) return { ok: false, code: 'notfound', text: 'پیام پیدا نشد.' };
  if (row.status !== 'pending') return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };

  const access = await checkReviewAccess(adminId, row);
  if (!access.ok) return access;

  const lockKey = 'review_msg_lock:' + id;
  const lock = await acquireLock(lockKey);
  if (!lock) return { ok: false, code: 'busy', text: '⏳ در حال پردازش…' };
  try {
    const fresh = await getMessageById(id);
    if (!fresh || fresh.status !== 'pending') return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };
    const patch =
      decision === 'approve'
        ? { status: 'approved', reviewedBy: Number(adminId), reviewedAt: new Date() }
        : {
            status: 'rejected',
            rejectReason: reason || 'نامناسب',
            reviewedBy: Number(adminId),
            reviewedAt: new Date(),
          };
    await db
      .update(messages)
      .set(patch)
      .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
      .run();
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
