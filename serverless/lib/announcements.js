/**
 * سیستم اطلاعیهٔ ذخیره‌محور کاربران عادی (Serverless-safe)
 * جایگزین/تکمیل passive_user_announce در settings
 */
import { api, db } from 'sdk';
import { eq, and, desc, sql } from 'sdk/db';
import { users, botAnnouncements, botAnnouncementReceipts, settings } from 'schema';
import { isOwner } from 'lib/dbutil';
import { sanitizeMarkup } from 'lib/keyboards';

const LEGACY_KEY = 'passive_user_announce';

async function settingGet(key, fallback) {
  try {
    const rows = (await db.select().from(settings).where(eq(settings.key, key)).all()) || [];
    if (rows[0] && rows[0].value != null) return String(rows[0].value);
  } catch (_e) {}
  return fallback;
}

async function settingSet(key, value) {
  const k = String(key);
  const v = value == null ? '' : String(value);
  try {
    const rows = (await db.select().from(settings).where(eq(settings.key, k)).all()) || [];
    if (rows && rows.length) {
      await db.update(settings).set({ value: v }).where(eq(settings.key, k)).run();
    } else {
      await db.insert(settings).values({ key: k, value: v }).run();
    }
  } catch (e) {
    console.error('ann settingSet', e);
  }
}

function parseEntities(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const o = JSON.parse(String(raw));
    return Array.isArray(o) ? o : null;
  } catch (_e) {
    return null;
  }
}

/** کاربران مشمول همان فیلتر تحویل: started، غیرمسدود، غیرمالک، نقش user (یا خالی) */
export async function countEligibleAnnounceUsers() {
  try {
    const rows =
      (await db
        .select({
          userId: users.userId,
          role: users.role,
          blocked: users.blocked,
          started: users.started,
        })
        .from(users)
        .all()) || [];
    let n = 0;
    for (const u of rows) {
      const uid = Number(u.userId ?? u.user_id);
      if (!uid || isOwner(uid)) continue;
      if (Number(u.blocked) === 1) continue;
      if (u.started != null && Number(u.started) === 0) continue;
      const role = String(u.role || 'user');
      if (role === 'admin' || role === 'owner') continue;
      n++;
    }
    return n;
  } catch (e) {
    console.error('countEligibleAnnounceUsers', e);
    try {
      const c =
        (await db.select({ n: sql`count(*)` }).from(users).all()) || [];
      return Number((c[0] && (c[0].n != null ? c[0].n : Object.values(c[0])[0])) || 0);
    } catch (_e2) {
      return 0;
    }
  }
}

export async function listAnnouncementsByStatus(status, limit) {
  const lim = Math.min(Number(limit) || 20, 40);
  try {
    let q = db.select().from(botAnnouncements);
    if (status) q = q.where(eq(botAnnouncements.status, status));
    const rows = (await q.orderBy(desc(botAnnouncements.id)).limit(lim).all()) || [];
    return rows;
  } catch (e) {
    console.error('listAnnouncementsByStatus', e);
    return [];
  }
}

export async function getAnnouncement(id) {
  const aid = Number(id);
  if (!aid) return null;
  try {
    const rows =
      (await db.select().from(botAnnouncements).where(eq(botAnnouncements.id, aid)).limit(1).all()) ||
      [];
    return rows[0] || null;
  } catch (e) {
    console.error('getAnnouncement', e);
    return null;
  }
}

export async function countReceipts(announcementId, status) {
  const aid = Number(announcementId);
  try {
    if (status) {
      const rows =
        (await db
          .select({ n: sql`count(*)` })
          .from(botAnnouncementReceipts)
          .where(
            and(
              eq(botAnnouncementReceipts.announcementId, aid),
              eq(botAnnouncementReceipts.status, status)
            )
          )
          .all()) || [];
      return Number((rows[0] && (rows[0].n != null ? rows[0].n : Object.values(rows[0])[0])) || 0);
    }
    const rows =
      (await db
        .select({ n: sql`count(*)` })
        .from(botAnnouncementReceipts)
        .where(eq(botAnnouncementReceipts.announcementId, aid))
        .all()) || [];
    return Number((rows[0] && (rows[0].n != null ? rows[0].n : Object.values(rows[0])[0])) || 0);
  } catch (e) {
    console.error('countReceipts', e);
    return 0;
  }
}

async function hasReceipt(announcementId, userId) {
  try {
    const rows =
      (await db
        .select({ id: botAnnouncementReceipts.id })
        .from(botAnnouncementReceipts)
        .where(
          and(
            eq(botAnnouncementReceipts.announcementId, Number(announcementId)),
            eq(botAnnouncementReceipts.userId, Number(userId)),
            eq(botAnnouncementReceipts.status, 'delivered')
          )
        )
        .limit(1)
        .all()) || [];
    return !!(rows && rows[0]);
  } catch (_e) {
    // fallback legacy key
    const seen = await settingGet('pau:' + userId, '');
    const ann = await getAnnouncement(announcementId);
    if (ann && String(seen) === 'ba_' + announcementId) return true;
    if (ann && String(seen) === String(ann.id)) return true;
    return false;
  }
}

async function insertReceipt(announcementId, userId, status) {
  try {
    await db
      .insert(botAnnouncementReceipts)
      .values({
        announcementId: Number(announcementId),
        userId: Number(userId),
        status: status || 'delivered',
      })
      .run();
    return true;
  } catch (e) {
    // ممکن است تکراری باشد
    console.error('insertReceipt', e);
    return false;
  }
}

async function bumpAnnouncementCounter(id, field, delta) {
  try {
    const row = await getAnnouncement(id);
    if (!row) return;
    let snake = field;
    if (field === 'deliveredCount') snake = 'delivered_count';
    if (field === 'failCount') snake = 'fail_count';
    if (field === 'eligibleCount') snake = 'eligible_count';
    const raw = row[field] != null ? row[field] : row[snake];
    const cur = Number(raw || 0);
    const patch = {};
    patch[field] = Math.max(0, cur + (Number(delta) || 1));
    await db.update(botAnnouncements).set(patch).where(eq(botAnnouncements.id, Number(id))).run();
  } catch (e) {
    console.error('bumpAnnouncementCounter', e);
  }
}

/**
 * فعال‌سازی اطلاعیه جدید برای کاربران عادی
 */
export async function activateUserAnnouncement(text, entities, createdBy) {
  const body = String(text || '').trim().slice(0, 4000);
  if (!body) return { ok: false, text: 'متن خالی است.' };
  const eligible = await countEligibleAnnounceUsers();
  try {
    await db
      .insert(botAnnouncements)
      .values({
        text: body,
        entitiesJson: entities ? JSON.stringify(entities) : null,
        status: 'active',
        eligibleCount: eligible,
        deliveredCount: 0,
        failCount: 0,
        createdBy: Number(createdBy) || null,
        activatedAt: new Date(),
      })
      .run();
    const rows =
      (await db
        .select()
        .from(botAnnouncements)
        .where(eq(botAnnouncements.status, 'active'))
        .orderBy(desc(botAnnouncements.id))
        .limit(1)
        .all()) || [];
    const row = rows[0];
    // سازگاری با کلید قدیمی: آخرین فعال را هم در settings بگذار
    if (row) {
      await settingSet(
        LEGACY_KEY,
        JSON.stringify({
          id: 'ba_' + row.id,
          text: body,
          entities: entities || null,
          at: Date.now(),
          dbId: row.id,
        })
      );
    }
    return { ok: true, announcement: row, eligible: eligible };
  } catch (e) {
    console.error('activateUserAnnouncement', e);
    // fallback فقط settings
    const id = 'pa_' + Date.now();
    await settingSet(
      LEGACY_KEY,
      JSON.stringify({ id: id, text: body, entities: entities || null, at: Date.now() })
    );
    return { ok: true, announcement: { id: id, text: body }, eligible: eligible, legacy: true };
  }
}

export async function cancelAnnouncement(id) {
  const aid = Number(id);
  if (!aid) return { ok: false, text: 'شناسه نامعتبر' };
  try {
    const row = await getAnnouncement(aid);
    if (!row) return { ok: false, text: 'پیدا نشد' };
    if (String(row.status) === 'cancelled') return { ok: true, already: true, announcement: row };
    await db
      .update(botAnnouncements)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(botAnnouncements.id, aid))
      .run();
    // اگر این آخرین فعال در legacy بود پاک کن
    try {
      const raw = await settingGet(LEGACY_KEY, '');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && (o.dbId === aid || o.id === 'ba_' + aid)) {
          await settingSet(LEGACY_KEY, '');
        }
      }
    } catch (_e) {}
    return { ok: true, announcement: await getAnnouncement(aid) };
  } catch (e) {
    console.error('cancelAnnouncement', e);
    return { ok: false, text: 'خطا در لغو' };
  }
}

export function formatAnnouncementStats(row, deliveredLive) {
  if (!row) return 'اطلاعیه‌ای نیست.';
  const id = row.id;
  const elig = Number(row.eligibleCount ?? row.eligible_count) || 0;
  const del =
    deliveredLive != null
      ? deliveredLive
      : Number(row.deliveredCount ?? row.delivered_count) || 0;
  const fail = Number(row.failCount ?? row.fail_count) || 0;
  const left = Math.max(0, elig - del);
  const pct = elig > 0 ? Math.min(100, Math.floor((del / elig) * 100)) : 0;
  const st = String(row.status || '');
  const statusFa =
    st === 'active' ? '🟢 فعال' : st === 'cancelled' ? '🔴 لغوشده' : st === 'draft' ? '📝 پیش‌نویس' : st;
  return (
    '📣 اطلاعیه #' +
    id +
    '\nوضعیت: ' +
    statusFa +
    '\n────────────\n' +
    'مشمول (زمان فعال‌سازی): ' +
    elig +
    '\nدریافت موفق: ' +
    del +
    '\nباقی‌مانده (هنوز هندلر نزده‌اند یا خطا): ' +
    left +
    '\nخطای ارسال ثبت‌شده: ' +
    fail +
    '\nپوشش: ' +
    pct +
    '%\n────────────\n' +
    String(row.text || '').slice(0, 500) +
    (String(row.text || '').length > 500 ? '…' : '')
  );
}

export function announceManageKeyboard() {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '➕ ایجاد اطلاعیه کاربران', callback_data: 'ann_m:new', style: 'success' }],
      [{ text: '🟢 فعال‌ها', callback_data: 'ann_m:active', style: 'primary' }],
      [{ text: '🔴 لغوشده / تاریخچه', callback_data: 'ann_m:hist', style: 'primary' }],
      [{ text: 'بستن', callback_data: 'ann_m:close', style: 'danger' }],
    ],
  });
}

export function announceActivateConfirmInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '✅ تأیید و فعال‌سازی', callback_data: 'ann_m:go', style: 'success' },
        { text: '❌ انصراف', callback_data: 'ann_m:abort', style: 'danger' },
      ],
    ],
  });
}

export function announceDetailInline(id, isActive) {
  const rows = [[{ text: '📊 بروزرسانی آمار', callback_data: 'ann_m:st:' + id, style: 'primary' }]];
  if (isActive) {
    rows.push([{ text: '🗑 لغو این اطلاعیه', callback_data: 'ann_m:cx:' + id, style: 'danger' }]);
  }
  rows.push([{ text: '◀️ فهرست', callback_data: 'ann_m:active', style: 'primary' }]);
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function announceCancelConfirmInline(id) {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '✅ بله، لغو شود', callback_data: 'ann_m:cxok:' + id, style: 'danger' },
        { text: 'خیر', callback_data: 'ann_m:st:' + id, style: 'primary' },
      ],
    ],
  });
}

/**
 * تحویل اطلاعیه‌های فعال به کاربر — فقط یک‌بار برای هر اطلاعیه
 * فقط پس از ارسال موفق، receipt ثبت می‌شود.
 */
export async function maybeDeliverPassiveAnnounce(userId, chatId) {
  const uid = Number(userId);
  const cid = Number(chatId);
  if (!uid || !cid || isOwner(uid)) return false;
  try {
    let active = [];
    try {
      active =
        (await db
          .select()
          .from(botAnnouncements)
          .where(eq(botAnnouncements.status, 'active'))
          .orderBy(desc(botAnnouncements.id))
          .limit(10)
          .all()) || [];
    } catch (eTable) {
      // جدول نیست — legacy تک‌اطلاعیه
      active = [];
    }

    if (!active.length) {
      // legacy single
      try {
        const raw = await settingGet(LEGACY_KEY, '');
        if (!raw) return false;
        const job = JSON.parse(raw);
        if (!job || !job.id || !job.text) return false;
        const seenKey = 'pau:' + uid;
        const seen = await settingGet(seenKey, '');
        if (String(seen) === String(job.id)) return false;
        const opts = {
          chat_id: cid,
          text: String(job.text).slice(0, 4000),
          disable_web_page_preview: false,
        };
        if (job.entities && Array.isArray(job.entities) && job.entities.length) {
          opts.entities = job.entities;
        }
        let sent;
        try {
          sent = await api.sendMessage(opts);
        } catch (_e1) {
          sent = await api.sendMessage({ chat_id: cid, text: String(job.text).slice(0, 4000) });
        }
        // فقط بعد از موفقیت
        await settingSet(seenKey, String(job.id));
        const mid = sent && (sent.message_id || sent.messageId);
        if (mid) {
          try {
            await api.pinChatMessage({
              chat_id: cid,
              message_id: Number(mid),
              disable_notification: true,
            });
          } catch (_pin) {}
        }
        return true;
      } catch (eLeg) {
        console.error('legacy passive', eLeg);
        return false;
      }
    }

    let any = false;
    // حداکثر ۲ اطلاعیه در هر درخواست تا timeout نشود
    let sentThisCall = 0;
    for (const ann of active) {
      if (sentThisCall >= 2) break;
      const aid = Number(ann.id);
      if (await hasReceipt(aid, uid)) continue;

      const entities = parseEntities(ann.entitiesJson ?? ann.entities_json);
      const text = String(ann.text || '').slice(0, 4000);
      if (!text) continue;

      let sent = null;
      try {
        const opts = { chat_id: cid, text: text, disable_web_page_preview: false };
        if (entities && entities.length) opts.entities = entities;
        try {
          sent = await api.sendMessage(opts);
        } catch (_e1) {
          sent = await api.sendMessage({ chat_id: cid, text: text });
        }
      } catch (eSend) {
        console.error('ann deliver fail', aid, eSend);
        try {
          await insertReceipt(aid, uid, 'failed');
          await bumpAnnouncementCounter(aid, 'failCount', 1);
        } catch (_e) {}
        continue;
      }

      // موفقیت
      const okIns = await insertReceipt(aid, uid, 'delivered');
      if (okIns) {
        await bumpAnnouncementCounter(aid, 'deliveredCount', 1);
      }
      // legacy seen برای سازگاری
      await settingSet('pau:' + uid, 'ba_' + aid);

      const mid = sent && (sent.message_id || sent.messageId);
      if (mid) {
        try {
          await api.pinChatMessage({
            chat_id: cid,
            message_id: Number(mid),
            disable_notification: true,
          });
        } catch (_pin) {}
      }
      any = true;
      sentThisCall++;
    }
    return any;
  } catch (e) {
    console.error('maybeDeliverPassiveAnnounce', e);
    return false;
  }
}

/** سازگاری با API قبلی dbutil */
export async function setPassiveUserAnnounce(text, entities) {
  const r = await activateUserAnnouncement(text, entities, null);
  if (r.ok && r.announcement) {
    return r.announcement.id != null ? 'ba_' + r.announcement.id : r.announcement.id;
  }
  return null;
}

export async function clearPassiveUserAnnounce() {
  // همه فعال‌ها را لغو نکن — فقط legacy key
  await settingSet(LEGACY_KEY, '');
}

export async function getPassiveUserAnnounce() {
  try {
    const rows =
      (await db
        .select()
        .from(botAnnouncements)
        .where(eq(botAnnouncements.status, 'active'))
        .orderBy(desc(botAnnouncements.id))
        .limit(1)
        .all()) || [];
    if (rows[0]) {
      return {
        id: 'ba_' + rows[0].id,
        text: rows[0].text,
        entities: parseEntities(rows[0].entitiesJson ?? rows[0].entities_json),
        at: Date.now(),
        dbId: rows[0].id,
      };
    }
  } catch (_e) {}
  try {
    const raw = await settingGet(LEGACY_KEY, '');
    if (!raw) return null;
    const o = JSON.parse(String(raw));
    if (!o || !o.id || !o.text) return null;
    return o;
  } catch (_e2) {
    return null;
  }
}
