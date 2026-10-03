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
import { reviewInline, sanitizeMarkup } from 'lib/keyboards';

export async function ensureChannelsSeeded() {
  try {
    // فقط در صورت نبود ردیف، seed کن — enabled/work را overwrite نکن
    for (const c of Object.values(DEFAULT_CHANNELS)) {
      try {
        const exist = await db.select().from(channels).where(eq(channels.key, c.key)).all();
        if (exist?.length) {
          // فقط title/link ثابت؛ enabled دست‌نخورده بماند
          await db
            .update(channels)
            .set({
              title: c.title,
              link: String(c.chatId),
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
    const uid = Number(userId);
    // select-all + فیلتر عددی — مقاوم به mismatch نوع و نام فیلد
    const all = (await db.select().from(channelAdmins).all()) || [];
    const out = [];
    const seen = {};
    for (const r of all) {
      const rid = Number(r.userId ?? r.user_id);
      if (!Number.isFinite(rid) || rid !== uid) continue;
      const key = r.channelKey ?? r.channel_key;
      if (!key || seen[key]) continue;
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
  const ck = String(channelKey || '');
  if (!uid || !ck) return { ok: false, reason: 'bad_args' };
  if (isOwner(uid)) return { ok: true, reason: 'owner' };

  // همیشه فلگ حذف را بردار تا دوباره قابل‌افزودن باشد
  try {
    await settingSet('admin_removed:' + ck + ':' + uid, '0');
  } catch (_e) {}

  try {
    const u0 = await getUser(uid);
    if (u0 && Number(u0.blocked) === 1) return { ok: false, reason: 'blocked' };
  } catch (_e) {}

  let exists = false;
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    exists = all.some(function (r) {
      return (
        Number(r.userId ?? r.user_id) === uid &&
        String(r.channelKey ?? r.channel_key) === ck
      );
    });
  } catch (e) {
    console.error('addChannelAdmin list', e);
  }

  if (!exists) {
    try {
      await db.insert(channelAdmins).values({ userId: uid, channelKey: ck }).run();
    } catch (e) {
      console.error('addChannelAdmin insert', e);
      try {
        await db.insert(channelAdmins).values({ userId: uid, channelKey: ck }).run();
      } catch (e2) {
        console.error('addChannelAdmin retry', e2);
        return { ok: false, reason: 'insert_fail' };
      }
    }
  }

  try {
    const u = await getUser(uid);
    if (u) {
      if (u.role !== 'owner' && u.role !== 'admin' && u.role !== 'subleader') {
        await db.update(users).set({ role: 'admin' }).where(eq(users.userId, uid)).run();
      }
    } else {
      await db.insert(users).values({ userId: uid, role: 'admin', started: 0 }).run();
    }
  } catch (e) {
    console.error('addChannelAdmin role', e);
  }
  return { ok: true, reason: exists ? 'already' : 'added' };
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
  if (!s || String(s.status) !== 'active') return false;
  const start = normHm(s.startHm || s.start_hm || '');
  const end = normHm(s.endHm || s.end_hm || '');
  if (!start || !end || start === end) return false;
  const sd = String(s.shiftDate ?? s.shift_date ?? '');
  if (sd === 'perm' || sd === 'permanent') {
    return inRange(now.hm, start, end);
  }
  // روزانه: دوره فعلی یا تاریخ تقویم امروز
  if (sd !== String(pdate) && sd !== String(now.date)) return false;
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


/** کانال‌هایی که کاربر می‌تواند برای خودش شیفت بردارد: ادمین کانال + اسکوپ ساب‌لیدر */
export async function shiftPickChannels(userId) {
  if (isOwner(userId)) return Object.keys(DEFAULT_CHANNELS || {});
  const set = new Set();
  try {
    const chs = await adminChannels(userId);
    for (const c of chs || []) if (c) set.add(String(c));
  } catch (_e) {}
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl) set.add(String(sl));
  } catch (_e) {}
  // اگر role=admin در users ولی ردیف channel_admins خالی/خراب بود — لاگ
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
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const uid = Number(adminId);
    // select-all مقاوم به mismatch نوع
    const all = (await db.select().from(shifts).all()) || [];
    const rows = all.filter(function (s) {
      return Number(s.adminId ?? s.admin_id) === uid && String(s.status) === 'active';
    });
    const keys = [];
    const seen = {};
    for (const s of rows) {
      if (!shiftActiveNow(s, now, pdate)) continue;
      const ck = String((s.channelKey ?? s.channel_key) || '');
      if (!ck || seen[ck]) continue;
      seen[ck] = true;
      keys.push(ck);
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

/** فقط IDهای هنوز pending را نگه می‌دارد */
export async function pruneReviewBatchToPending(adminId) {
  const old = await getReviewBatch(adminId);
  if (!old || !old.ids || !old.ids.length) return { cleared: true, ids: [] };
  const alive = [];
  for (const id of old.ids) {
    const row = await getMessageById(Number(id));
    if (row && String(row.status) === 'pending') alive.push(Number(id));
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
export async function dropMessageFromAllReviewBatches(msgId) {
  msgId = Number(msgId);
  try {
    const all = (await db.select().from(settings).all()) || [];
    for (const row of all) {
      if (!row.key || !String(row.key).startsWith('review_batch:')) continue;
      let b;
      try {
        b = JSON.parse(row.value || '');
      } catch (_e) {
        continue;
      }
      if (!b || !Array.isArray(b.ids)) continue;
      const next = b.ids.map(Number).filter((id) => id !== msgId);
      if (next.length === b.ids.length) continue;
      const adminId = String(row.key).replace('review_batch:', '');
      if (!next.length) await clearReviewBatch(adminId);
      else {
        b.ids = next;
        await saveReviewBatch(adminId, b);
      }
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
  const b = await getReviewBatch(adminId);
  if (!b || !b.ids || !b.ids.length) return true;
  for (const id of b.ids) {
    const row = await getMessageById(Number(id));
    if (row && String(row.status) === 'pending') return false;
  }
  return true;
}

/** Pendingهای قابل‌بررسی ادمین، قدیمی‌ترین اول */
async function selectReviewablePending(adminId) {
  let allMsg = [];
  try {
    allMsg = (await db.select().from(messages).all()) || [];
  } catch (e) {
    console.error('selectReviewablePending all', e);
    return [];
  }
  const pending = allMsg
    .filter(function (m) {
      return String(m.status) === 'pending';
    })
    .sort(function (a, b) {
      return (a.id || 0) - (b.id || 0);
    });
  function msgCh(m) {
    return String((m.channelKey ?? m.channel_key) || '');
  }
  if (isOwner(adminId)) {
    try {
      const ch = await settingGet('owner_pend_ch:' + adminId, '');
      if (ch) return pending.filter(function (m) { return msgCh(m) === String(ch); });
    } catch (_e) {}
    return pending;
  }
  // ساب‌لیدر + ادمین هیبرید: اسکوپ ساب‌لیدر ∪ کانال‌های شیفت فعال
  const allowed = {};
  try {
    const slCh = await getActiveSubLeaderChannel(adminId);
    if (slCh) allowed[String(slCh)] = true;
  } catch (_e) {}
  try {
    const keys = await activeShiftChannelKeys(adminId);
    for (const k of keys || []) allowed[String(k)] = true;
  } catch (_e) {}
  const allowList = Object.keys(allowed);
  if (!allowList.length) return [];
  return pending.filter(function (m) {
    return !!allowed[msgCh(m)];
  });
}



export async function finishReviewBatchIfComplete(adminId, messageId) {
  try {
    const batch = await getReviewBatch(adminId);
    if (!batch) {
      // Batch قبلاً پاک شده — ممکن است hasMore هنوز باشد
      const hasMore = (await selectReviewablePending(adminId)).length > 0;
      return { inBatch: false, complete: true, hasMore, batch: null };
    }
    // حتی اگر messageId دیگر در لیست نباشد (drop شده)، وضعیت کامل بودن را چک کن
    const inBatch =
      messageId == null || batch.ids.map(Number).includes(Number(messageId));
    const complete = await isReviewBatchComplete(adminId);
    let hasMore = false;
    if (complete) {
      hasMore = (await selectReviewablePending(adminId)).length > 0;
      // آزاد کردن Batch تا گیر نکند — شماره Batch را برای دکمه نگه می‌داریم
      try {
        await clearReviewBatch(adminId);
      } catch (_e) {}
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
export async function createReviewBatch(adminId) {
  const lockKey = 'review_batch_lock:' + adminId;
  const lock = await acquireLock(lockKey);
  if (!lock) return { status: 'busy' };
  try {
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
      for (const id of pruned.ids) {
        const row = await getMessageById(id);
        if (row && String(row.status) === 'pending') pendingRows.push(row);
      }
      if (!owner) {
        const keys = await activeShiftChannelKeys(adminId);
        pendingRows = pendingRows.filter((r) => keys.includes(r.channelKey));
      }
      if (pendingRows.length) {
        const batch = pruned.batch || (await getReviewBatch(adminId));
        batch.ids = pendingRows.map((r) => Number(r.id));
        await saveReviewBatch(adminId, batch);
        return { status: 'incomplete', batch, messages: pendingRows };
      }
      await clearReviewBatch(adminId);
    }

    const candidates = (await selectReviewablePending(adminId)).filter(
      (m) => m && String(m.status) === 'pending'
    );
    const clean = candidates.slice(0, REVIEW_BATCH_SIZE);
    if (!clean.length) return { status: 'empty' };

    const old = await getReviewBatch(adminId);
    const batch = {
      ids: clean.map((m) => Number(m.id)),
      batchNumber: (old && Number(old.batchNumber) ? Number(old.batchNumber) : 0) + 1,
      createdAt: Date.now(),
      periodDate: periodDateStr(),
    };
    await saveReviewBatch(adminId, batch);
    return { status: 'created', batch, messages: clean };
  } finally {
    await releaseLock(lockKey, lock);
  }
}

/** ارسال پیام‌های Batch به ادمین (حداکثر ۱۰ + یک پیام سرتیتر) */
export async function sendReviewBatch(chatId, batch, rows, opts) {
  const resumed = !!(opts && opts.resumed);
  const live = [];
  for (const row of rows || []) {
    if (!row) continue;
    const fresh = await getMessageById(Number(row.id));
    if (fresh && String(fresh.status) === 'pending') live.push(fresh);
  }
  if (!live.length) {
    await api.sendMessage({
      chat_id: chatId,
      text: '📭 در این Batch پیام pending نمانده. دوباره «📥 پیام‌های در انتظار» را بزنید.',
    });
    return;
  }
  const lastId = Number(live[live.length - 1].id);
  const head = resumed
    ? '⏳ Batch فعلی هنوز کامل بررسی نشده است.\nBatch شماره ' +
      batch.batchNumber +
      ' — ' +
      live.length +
      ' پیام pending باقی مانده.'
    : '📥 Batch شماره ' + batch.batchNumber + '\n' + live.length + ' پیام برای بررسی دریافت شد.';
  await api.sendMessage({ chat_id: chatId, text: head });
  for (const row of live) {
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
        // فقط زیر آخرین پیام Batch دکمه «Batch بعدی» باشد
        reply_markup: sanitizeMarkup(reviewInline(row.id, Number(row.id) === lastId, batch.batchNumber)),
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
  const st0 = String(row.status || '');
  if (st0 !== 'pending' && st0 !== 'publishing') {
    return { ok: false, code: 'done', text: 'قبلاً بررسی شده' };
  }

  const access = await checkReviewAccess(adminId, row);
  if (!access.ok) return access;

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
    // از pending یا publishing نهایی کن
    await db.update(messages).set(patch).where(eq(messages.id, id)).run();
    try {
      await dropMessageFromAllReviewBatches(id);
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
