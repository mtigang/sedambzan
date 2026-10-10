import { api, db } from 'sdk';
import {  channels, channelAdmins, shifts, settings, users, messages, subLeaders } from 'schema';
// subLeaders used for role
import { eq, and, sql } from 'sdk/db';
import {
  DEFAULT_CHANNELS,
  OWNER_IDS,
  CHANNEL_IDS,
  ADMIN_GROUP_IDS,
} from 'lib/config';
import { tehranNow, inRange, periodDateStr, normHm, hourKeyOf, periodOrd, isWorkHours } from 'lib/time';
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
  '🌙 امروز جمعه‌ست…\n\n' +
  'همه خوابیم 😴\n' +
  'تکست و این حرفا کنسله.\n\n' +
  'شنبه برگرد، با انرژی بیشتر منتظرتیم 🌸';


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
export async function getStatsDashboardText() {
  let rows = [];
  let msgErr = null;
  try {
    rows =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
        })
        .from(messages)
        .all()) || [];
  } catch (e1) {
    console.error('stats light select', e1);
    msgErr = e1;
    rows = [];
    try {
      const cAll = await db.select({ n: sql`count(*)` }).from(messages).all();
      const totalGuess = Number(
        (cAll && cAll[0] && (cAll[0].n != null ? cAll[0].n : Object.values(cAll[0])[0])) || 0
      );
      if (totalGuess) {
        msgErr = new Error('select سبک timeout؛ count≈' + totalGuess);
      }
    } catch (_e2) {}
  }
  function stOf(x) {
    return String((x && x.status) || '');
  }
  function chOf(x) {
    return String((x && (x.channelKey ?? x.channel_key)) || '');
  }
  const pe = rows.filter(function (x) { return stOf(x) === 'pending'; }).length;
  const ap = rows.filter(function (x) { return stOf(x) === 'approved'; }).length;
  const rj = rows.filter(function (x) { return stOf(x) === 'rejected'; }).length;
  let us = [];
  try {
    us = (await db.select().from(users).all()) || [];
  } catch (_e) {}
  let ads = [];
  try {
    ads = (await db.select().from(channelAdmins).all()) || [];
  } catch (_e) {}
  const adminIds = new Set(
    ads.map(function (a) {
      return a.userId || a.user_id;
    })
  );
  let shToday = 0;
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const sh = (await db.select().from(shifts).all()) || [];
    shToday = sh.filter(function (s) {
      if (String(s.status) !== 'active') return false;
      const sd = String(s.shiftDate ?? s.shift_date ?? '');
      return sd === String(now.date) || sd === String(pdate) || sd === 'perm' || sd === 'permanent';
    }).length;
  } catch (_e) {}
  let by = '';
  for (const c of Object.values(DEFAULT_CHANNELS)) {
    const cm = rows.filter(function (x) {
      return chOf(x) === c.key;
    });
    by +=
      '• ' +
      c.title +
      ': ' +
      cm.length +
      ' (🟡' +
      cm.filter(function (x) {
        return stOf(x) === 'pending';
      }).length +
      ' 🟢' +
      cm.filter(function (x) {
        return stOf(x) === 'approved';
      }).length +
      ' 🔴' +
      cm.filter(function (x) {
        return stOf(x) === 'rejected';
      }).length +
      ')\n';
  }
  let text =
    '📊 داشبورد آماری\n\n' +
    '📨 کل پیام‌ها: ' +
    rows.length +
    '\n' +
    '🟡 در انتظار: ' +
    pe +
    '\n' +
    '🟢 تأیید شده: ' +
    ap +
    '\n' +
    '🔴 رد شده: ' +
    rj +
    '\n\n' +
    '👥 کاربران: ' +
    us.length +
    '\n' +
    '👮 ادمین‌ها (یکتا): ' +
    adminIds.size +
    '\n' +
    '⏰ شیفت فعال امروز: ' +
    shToday +
    '\n\n' +
    '📺 تفکیک کانال:\n' +
    by;
  if (msgErr) {
    text +=
      '\n\n⚠️ خطا در خواندن پیام‌ها:\n' +
      String(msgErr.message || msgErr.description || msgErr).slice(0, 220);
  }
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
 *  - ادمین با دکمه‌ی «📥 پیام‌های در انتظار» یک Batch ده‌تایی می‌گیرد.
 *  - IDهای Batch در settings با کلید review_batch:<adminId> ذخیره می‌شوند.
 *  - Lock با Timestamp در DB (بدون setTimeout)؛ TTL کوتاه.
 *  - Batch state ≠ Message state: حذف Batch هیچ پیامی را تغییر نمی‌دهد.
 * ============================================================ */

export const REVIEW_BATCH_SIZE = 16;
const REVIEW_LOCK_TTL_MS = 10 * 1000;

function reviewBatchKey(adminId) {
  return 'review_batch:' + Number(adminId);
}

/** آیا این رکورد shift همین الان (تهران) فعال است؟ */
function shiftActiveNow(s, now, pdate) {
  if (!s || String(s.status) !== 'active') return false;
  if (!now) now = tehranNow();
  if (!pdate) pdate = periodDateStr(now);
  // خارج از ساعت کاری (۱۲–۰۰) هیچ شیفتی فعال نیست
  if (!isWorkHours(now)) return false;
  const start = normHm(s.startHm || s.start_hm || '');
  const end = normHm(s.endHm || s.end_hm || '');
  if (!start || !end || start === end) return false;
  const sd = String(s.shiftDate ?? s.shift_date ?? '');
  if (sd === 'perm' || sd === 'permanent') return false;
  // فقط دورهٔ تقویمی فعلی
  if (sd !== String(pdate)) return false;
  // بازه باید داخل پنجره کاری باشد (شروع بین ۱۲ تا ۲۳)
  const sh = Number(String(start).split(':')[0]) || 0;
  if (sh < 12) return false;
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
      const sh = Number(String(s.startHm || s.start_hm || '0').split(':')[0]) || 0;
      const bad =
        sd === 'perm' ||
        sd === 'permanent' ||
        sh < 12 ||
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
      const sh = Number(String(s.startHm || '0').split(':')[0]) || 0;
      if (sh < 12) continue;
      if (shiftIntervalOverlaps(ss, se, s.startHm || s.start_hm, s.endHm || s.end_hm)) {
        takenMap[ss] = s.adminId ?? s.admin_id;
        takenMap[hourKeyOf(ss)] = s.adminId ?? s.admin_id;
        break;
      }
    }
  }
  return takenMap;
}

/** فقط شیفت‌های معتبر دوره فعلی (۱۲–۰۰، غیر دائم، غیر صفر) */
export function filterPeriodShifts(rows, pdate) {
  return (rows || []).filter(function (s) {
    if (String(s.status) !== 'active') return false;
    const sd = String(s.shiftDate ?? s.shift_date ?? '');
    if (sd === 'perm' || sd === 'permanent') return false;
    if (sd !== String(pdate)) return false;
    if (String(s.startHm) === String(s.endHm)) return false;
    const sh = Number(String(s.startHm || s.start_hm || '0').split(':')[0]) || 0;
    if (sh < 12) return false;
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
      // شیفت‌های نیمه‌شب تا ظهر (باقی‌مانده قدیمی) نادیده
      const sh = Number(String(s.startHm || s.start_hm || '0').split(':')[0]) || 0;
      if (sh < 12) continue;
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
        const sh = Number(String(s.startHm || s.start_hm || '0').split(':')[0]) || 0;
        if (sh < 12) return false;
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
      const sh = Number(String(s.startHm || '0').split(':')[0]) || 0;
      if (sh < 12) continue;
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
  try {
    const chs = await adminChannels(userId);
    if ((chs || []).map(String).includes(String(channelKey))) return true;
  } catch (_e) {}
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl && String(sl) === String(channelKey)) return true;
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
  const uid = Number(adminId);
  return memo('ask:' + uid, async function () {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
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
  });
}

/** مالک همیشه true. ادمین: شیفت فعال (اختیاری: برای کانال مشخص) */
export async function hasActiveShift(adminId, channelKey) {
  if (isOwner(adminId)) return true;
  const keys = await activeShiftChannelKeys(adminId);
  return channelKey ? keys.includes(channelKey) : keys.length > 0;
}


/** کانال‌هایی که کاربر حق بررسی دارد: اسکوپ ساب‌لیدر ∪ شیفت‌های فعال */
export async function allowedReviewChannels(userId) {
  if (isOwner(userId)) return Object.keys(DEFAULT_CHANNELS || {});
  const set = {};
  try {
    const sl = await getActiveSubLeaderChannel(userId);
    if (sl) set[String(sl)] = true;
  } catch (_e) {}
  try {
    const keys = await activeShiftChannelKeys(userId);
    for (const k of keys || []) if (k) set[String(k)] = true;
  } catch (_e) {}
  return Object.keys(set);
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

  try {
    const raw = await settingGet('review_batch_index', '[]');
    let arr = [];
    try { arr = JSON.parse(raw || '[]') || []; } catch (_e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    const aid = Number(adminId);
    if (!arr.map(Number).includes(aid)) {
      arr.push(aid);
      if (arr.length > 500) arr = arr.slice(-500);
      await settingSet('review_batch_index', JSON.stringify(arr));
    }
  } catch (_e) {}

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
  const rows = await Promise.all(
    old.ids.map(function (id) {
      return getMessageById(Number(id));
    })
  );
  const alive = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && String(row.status) === 'pending') alive.push(Number(old.ids[i]));
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
    if (!next.length) await clearReviewBatch(adminId);
    else {
      old.ids = next;
      await saveReviewBatch(adminId, old);
    }
  } catch (e) {
    console.error('dropMessageFromReviewBatch', e);
  }
}

export async function dropMessageFromAllReviewBatches(msgId) {
  msgId = Number(msgId);
  try {
    // ایندکس سبک به‌جای اسکن کل settings (شامل exportهای چندمگابایتی)
    let adminIds = [];
    try {
      const raw = await settingGet('review_batch_index', '[]');
      adminIds = JSON.parse(raw || '[]') || [];
      if (!Array.isArray(adminIds)) adminIds = [];
    } catch (_e) {
      adminIds = [];
    }
    // اگر ایندکس خالی بود، فقط کلیدهای review_batch را از لیست فیلتر کن ولی value بزرگ را نخوان
    if (!adminIds.length) {
      try {
        const all = (await db.select().from(settings).all()) || [];
        for (const row of all) {
          const key = row && row.key != null ? String(row.key) : '';
          if (!key.startsWith('review_batch:')) continue;
          const aid = Number(key.slice('review_batch:'.length));
          if (Number.isFinite(aid)) adminIds.push(aid);
        }
        adminIds = Array.from(new Set(adminIds));
        try {
          await settingSet('review_batch_index', JSON.stringify(adminIds.slice(0, 500)));
        } catch (_e) {}
      } catch (_e) {}
    }
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
  const rows = await Promise.all(batch.ids.map(function (id) { return getMessageById(Number(id)); }));
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && String(rows[i].status) === 'pending') return false;
  }
  return true;
}

/** Pendingهای قابل‌بررسی ادمین، قدیمی‌ترین اول — بدون select همه‌ی content */
async function selectReviewablePending(adminId) {
  // اول فقط id/status/channel (سبک) تا timeout نشود
  let light = [];
  try {
    light =
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
        })
        .from(messages)
        .where(eq(messages.status, 'pending'))
        .all()) || [];
  } catch (e1) {
    console.error('selectReviewablePending light+where', e1);
    try {
      light =
        (await db
          .select({
            id: messages.id,
            status: messages.status,
            channelKey: messages.channelKey,
          })
          .from(messages)
          .all()) || [];
      light = light.filter(function (m) {
        return String(m.status) === 'pending';
      });
    } catch (e2) {
      console.error('selectReviewablePending light all', e2);
      return [];
    }
  }

  light.sort(function (a, b) {
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  function msgCh(m) {
    return String((m.channelKey ?? m.channel_key) || '');
  }

  let filtered = light;
  if (isOwner(adminId)) {
    try {
      const ch = await settingGet('owner_pend_ch:' + adminId, '');
      if (ch) {
        filtered = light.filter(function (m) {
          return msgCh(m) === String(ch);
        });
      }
    } catch (_e) {}
  } else {
    const allowList = await allowedReviewChannels(adminId);
    if (!allowList.length) return [];
    const allowed = {};
    for (const k of allowList) allowed[String(k)] = true;
    filtered = light.filter(function (m) {
      return !!allowed[msgCh(m)];
    });
  }

  // فقط به اندازه‌ی چند Batch ردیف کامل بگیر (نه کل صف)
  const need = Math.max(REVIEW_BATCH_SIZE * 3, 48);
  const ids = filtered.slice(0, need).map(function (m) {
    return Number(m.id);
  });
  const full = [];
  for (let i = 0; i < ids.length; i++) {
    try {
      const row = await getMessageById(ids[i]);
      if (row && String(row.status) === 'pending') full.push(row);
    } catch (_e) {}
  }
  return full;
}



export async function finishReviewBatchIfComplete(adminId, messageId) {
  try {
    const batch = await getReviewBatch(adminId);
    if (!batch) {
      // بدون اسکن کامل صف — hasMore را true فرض کن تا دکمه Batch بعدی بماند
      return { inBatch: false, complete: true, hasMore: true, batch: null };
    }
    const ids = (batch.ids || []).map(Number);
    const inBatch = messageId == null || ids.includes(Number(messageId));
    // سریع: فقط اگر همه idها از لیست رفته‌اند complete است (بعد از drop)
    // isReviewBatchComplete همچنان دقیق است ولی سبک‌تر از selectReviewablePending
    const complete = await isReviewBatchComplete(adminId);
    let hasMore = false;
    if (complete) {
      try {
        await clearReviewBatch(adminId);
      } catch (_e) {}
      // اسکن کامل صف را نکن — دکمه «Batch بعدی» را نشان بده؛ اگر خالی باشد بعداً empty می‌گوید
      hasMore = true;
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
    const allm = (await db.select().from(messages).all()) || [];
    const day = String(now.date);
    for (const m of allm) {
      if (Number(m.reviewedBy ?? m.reviewed_by) !== Number(adminId)) continue;
      const ts = String(m.reviewedAt ?? m.reviewed_at ?? m.createdAt ?? m.created_at ?? '');
      if (ts.indexOf(day) < 0 && !String(ts).startsWith(day)) {
        // تلاش برای تاریخ شمسی/ISO
        try {
          if (ts && ts.length >= 10 && ts.slice(0, 10) !== day) continue;
          if (!ts) continue;
        } catch (_e) {
          continue;
        }
      }
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
        const allowed = await allowedReviewChannels(adminId);
        const allowSet = {};
        for (const k of allowed) allowSet[String(k)] = true;
        pendingRows = pendingRows.filter(function (r) {
          const ck = String((r.channelKey ?? r.channel_key) || '');
          return !!allowSet[ck];
        });
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
  // خوش‌آمد شیفت فقط یک‌بار، روی اولین دریافت Batch در بازه شیفت
  if (!resumed) {
    try {
      await maybeGreetShiftStart(chatId, chatId);
    } catch (_e) {}
  }
  let queueHint = '';
  try {
    const card = await adminShiftCard(chatId);
    if (card && card.pendingTotal > 0) {
      queueHint = '\n📊 کل صف قابل‌بررسی شما: ' + card.pendingTotal + ' پیام';
      if (card.minutesLeftMin != null) {
        queueHint += '\n⏱ حدود ' + card.minutesLeftMin + ' دقیقه تا پایان نزدیک‌ترین شیفت';
      }
    }
  } catch (_e) {}
  const head = resumed
    ? '⏳ Batch فعلی هنوز کامل بررسی نشده است.\nBatch شماره ' +
      batch.batchNumber +
      ' — ' +
      live.length +
      ' پیام باقی مانده.' +
      queueHint
    : '📥 Batch شماره ' +
      batch.batchNumber +
      '\n' +
      live.length +
      ' پیام برای بررسی' +
      queueHint;
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
        reply_markup: sanitizeMarkup(reviewInline(row.id, false, batch.batchNumber)),
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
  if (!row) return { ok: false, code: 'missing', text: 'پیام یافت نشد.' };
  const ch = String((row.channelKey ?? row.channel_key) || '');
  const allowed = await allowedReviewChannels(adminId);
  if (!allowed.length) {
    return { ok: false, code: 'shift_ended', text: '❌ شیفت فعالی ندارید و اسکوپ ساب‌لیدر هم نیست.' };
  }
  if (!allowed.includes(ch)) {
    return {
      ok: false,
      code: 'channel',
      text: '⛔ این پیام خارج از محدوده شماست (نه کانال ساب‌لیدری‌تان است نه شیفت فعال).',
    };
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
