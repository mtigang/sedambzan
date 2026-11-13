import { api, db } from 'sdk';
import { eq, and, desc, sql } from 'sdk/db';
import { subLeaders, channelAdmins, users, messages, shifts } from 'schema';
import { isOwner, getUser, displayName, listAdminsByChannel, normalizeChannelKey } from 'lib/dbutil';
import { DEFAULT_CHANNELS } from 'lib/config';

/** @returns {Promise<{userId:number,channelKey:string,status:string}|null>} */
export async function getSubLeaderRecord(userId) {
  try {
    const rows = await db
      .select()
      .from(subLeaders)
      .where(eq(subLeaders.userId, Number(userId)))
      .all();
    return (rows && rows[0]) || null;
  } catch (e) {
    console.error('getSubLeaderRecord', e);
    return null;
  }
}

/** کانال فعال ساب‌لیدر یا null */
export async function getSubLeaderChannel(userId) {
  const r = await getSubLeaderRecord(userId);
  if (!r || r.status !== 'active') return null;
  return r.channelKey || null;
}

export async function isActiveSubLeader(userId) {
  return !!(await getSubLeaderChannel(userId));
}

export async function listActiveSubLeaders() {
  try {
    const all = (await db.select().from(subLeaders).all()) || [];
    return all.filter((r) => r.status === 'active');
  } catch (e) {
    console.error('listActiveSubLeaders', e);
    return [];
  }
}

export async function listAllSubLeaders() {
  try {
    return (await db.select().from(subLeaders).all()) || [];
  } catch (e) {
    console.error('listAllSubLeaders', e);
    return [];
  }
}

/**
 * ایجاد/فعال‌سازی ساب‌لیدر برای یک کانال.
 * مالک را نمی‌پذیرد.
 */
export async function upsertSubLeader(userId, channelKey, createdBy) {
  userId = Number(userId);
  if (!userId || !channelKey) throw new Error('invalid');
  if (isOwner(userId)) throw new Error('owner');
  const u = await getUser(userId);
  if (u && Number(u.blocked) === 1) throw new Error('blocked');
  if (!DEFAULT_CHANNELS[channelKey]) throw new Error('channel');

  const existing = await getSubLeaderRecord(userId);
  if (existing) {
    await db
      .update(subLeaders)
      .set({ channelKey, status: 'active', createdBy: createdBy != null ? Number(createdBy) : existing.createdBy })
      .where(eq(subLeaders.userId, userId))
      .run();
  } else {
    await db
      .insert(subLeaders)
      .values({
        userId,
        channelKey,
        status: 'active',
        createdBy: createdBy != null ? Number(createdBy) : null,
      })
      .run();
  }
  // نقش در users برای نمایش
  try {
    await db.update(users).set({ role: 'subleader' }).where(eq(users.userId, userId)).run();
  } catch (_e) {}
  return { userId, channelKey, status: 'active' };
}

export async function deactivateSubLeader(userId) {
  userId = Number(userId);
  const existing = await getSubLeaderRecord(userId);
  if (!existing) return false;
  await db
    .update(subLeaders)
    .set({ status: 'inactive' })
    .where(eq(subLeaders.userId, userId))
    .run();
  try {
    // اگر هنوز channel admin است admin بماند وگرنه user
    const ca = await db.select().from(channelAdmins).where(eq(channelAdmins.userId, userId)).all();
    const role = ca && ca.length ? 'admin' : 'user';
    await db.update(users).set({ role }).where(eq(users.userId, userId)).run();
  } catch (_e) {}
  return true;
}

/** آیا ساب‌لیدر اجازه کار روی این کانال را دارد؟ */
export async function assertSubLeaderChannel(userId, channelKey) {
  const ch = await getSubLeaderChannel(userId);
  if (!ch) return { ok: false, text: '⛔ شما به این بخش دسترسی ندارید.' };
  if (channelKey && ch !== channelKey) {
    return { ok: false, text: '⛔ این مورد خارج از محدوده کانال شماست.' };
  }
  return { ok: true, channelKey: ch };
}

/** ادمین‌های فقط کانال Scope */
export async function subLeaderAdmins(userId) {
  const ch = await getSubLeaderChannel(userId);
  if (!ch) return { channelKey: null, admins: [] };
  const ads = await listAdminsByChannel(ch);
  return { channelKey: ch, admins: ads || [] };
}

export async function notifySubLeaderAppointed(userId, channelKey) {
  const title = (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey;
  try {
    await api.sendMessage({
      chat_id: userId,
      text:
        '🛡️ تبریک!\n\n' +
        'شما توسط مالک ربات به عنوان ساب‌لیدر انتخاب شدید.\n\n' +
        '📢 کانال تحت مدیریت:\n«' +
        title +
        '»\n\n' +
        'دسترسی‌های شما:\n' +
        '• مدیریت ادمین‌های کانال\n' +
        '• مشاهده شیفت‌های کانال\n' +
        '• مشاهده و بررسی پیام‌های در انتظار\n' +
        '• مشاهده آمار کانال\n' +
        '• ارسال اطلاعیه برای ادمین‌های کانال\n\n' +
        '⚠️ دسترسی شما فقط به همین کانال محدود است.\n\n' +
        '/start را بزنید تا پنل ساب‌لیدر باز شود.',
    });
  } catch (e) {
    console.error('notifySubLeaderAppointed', e);
  }
}

export async function notifySubLeaderChannelChange(userId, oldKey, newKey) {
  const ot = (DEFAULT_CHANNELS[oldKey] && DEFAULT_CHANNELS[oldKey].title) || oldKey;
  const nt = (DEFAULT_CHANNELS[newKey] && DEFAULT_CHANNELS[newKey].title) || newKey;
  try {
    await api.sendMessage({
      chat_id: userId,
      text:
        '🔄 تغییر محدوده مدیریت\n\n' +
        'محدوده مدیریتی شما توسط مالک تغییر کرد.\n\n' +
        'کانال قبلی: «' +
        ot +
        '»\n' +
        'کانال جدید: «' +
        nt +
        '»',
    });
  } catch (e) {
    console.error('notifySubLeaderChannelChange', e);
  }
}

export async function notifySubLeaderRemoved(userId) {
  try {
    await api.sendMessage({
      chat_id: userId,
      text:
        '🚫 دسترسی ساب‌لیدری شما لغو شد.\n\n' +
        'از این لحظه پنل ساب‌لیدر و امکانات مدیریتی برای شما غیرفعال است.',
    });
  } catch (e) {
    console.error('notifySubLeaderRemoved', e);
  }
}

export async function channelStatsFor(channelKey) {
  let ck = '';
  try {
    ck = normalizeChannelKey(channelKey) || String(channelKey || '');
  } catch (_e) {
    ck = String(channelKey || '');
  }
  const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
  async function countWhere(extra) {
    try {
      const rows = (await db.select({ n: sql`count(*)` }).from(messages).where(extra).all()) || [];
      const row = rows[0] || {};
      return Number(row.n != null ? row.n : Object.values(row)[0] || 0) || 0;
    } catch (e) {
      console.error('channelStatsFor count', e);
      return null;
    }
  }
  try {
    const base = eq(messages.channelKey, ck);
    let total = await countWhere(base);
    let pe = await countWhere(and(base, eq(messages.status, 'pending')));
    let ap = await countWhere(and(base, eq(messages.status, 'approved')));
    let rj = await countWhere(and(base, eq(messages.status, 'rejected')));
    const pub = await countWhere(and(base, eq(messages.status, 'publishing')));
    if (pe != null && pub != null) pe += pub;

    // اگر countها صفر/شکست — نمونهٔ جدیدترین‌ها (مقیاس‌پذیر روی ۵۰k+)
    if (total == null || (total === 0 && pe == null) || (total > 0 && pe == null && ap == null && rj == null)) {
      try {
        const sample =
          (await db
            .select({ status: messages.status, channelKey: messages.channelKey })
            .from(messages)
            .orderBy(desc(messages.id))
            .limit(8000)
            .all()) || [];
        const rows = sample.filter(function (x) {
          const k = String((x.channelKey ?? x.channel_key) || '');
          return k === ck || k.toLowerCase() === String(ck).toLowerCase();
        });
        if (total == null || total === 0) total = rows.length;
        pe = ap = rj = 0;
        for (const x of rows) {
          const st = String(x.status || '');
          if (st === 'pending' || st === 'publishing') pe++;
          else if (st === 'approved') ap++;
          else if (st === 'rejected') rj++;
        }
      } catch (e2) {
        console.error('channelStatsFor sample', e2);
      }
    }
    return {
      title: title,
      total: total || 0,
      pe: pe || 0,
      ap: ap || 0,
      rj: rj || 0,
    };
  } catch (e) {
    console.error('channelStatsFor', e);
    return { title: title, total: 0, pe: 0, ap: 0, rj: 0 };
  }
}
