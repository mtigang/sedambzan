/**
 * صف اطلاعیه + نوار پیشرفت سنجاق‌شده برای مالک
 * نکته: لیست کامل کاربران در settings ذخیره نمی‌شود (محدودیت حجم/timeout).
 * برای target=all هر دسته از دیتابیس خوانده می‌شود.
 */
import { api, db } from 'sdk';
import { eq, and, sql, asc } from 'sdk/db';
import { users, channelAdmins } from 'schema';
import { settingGet, settingSet } from 'lib/dbutil';
import { announceProgressInline, sanitizeMarkup } from 'lib/keyboards';

const CHUNK = 30;
const LOCK_MS = 20000;
const JOB_KEY = 'announce_job';

export async function loadAnnounceJob() {
  try {
    const raw = await settingGet(JOB_KEY, '');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

export async function saveAnnounceJob(job) {
  try {
    // هرگز آرایهٔ بزرگ ids را برای all نگه ندار
    const j = Object.assign({}, job || {});
    if (j.target === 'all' && Array.isArray(j.ids) && j.ids.length > 50) {
      delete j.ids;
    }
    await settingSet(JOB_KEY, JSON.stringify(j));
  } catch (e) {
    console.error('saveAnnounceJob', e);
  }
}

export function msgIdOf(msg) {
  if (!msg) return null;
  return msg.message_id || msg.messageId || msg.id || null;
}

export function buildAnnounceProgressText(job) {
  const total = Number(job.total) || (job.ids && job.ids.length) || 0;
  const cursor = Number(job.cursor) || 0;
  const finished = job.status === 'done' || (total > 0 && cursor >= total);
  const pct10 = total ? Math.min(10, Math.floor((cursor / total) * 10)) : finished ? 10 : 0;
  const pct = total ? Math.min(100, Math.floor((cursor / total) * 100)) : finished ? 100 : 0;
  let bar = '';
  for (let i = 0; i < 10; i++) bar += i < pct10 ? '█' : '░';
  let body =
    (finished ? '✅ اطلاعیه تمام شد\n' : '📣 ارسال اطلاعیه در جریان است\n') +
    bar +
    ' ' +
    pct +
    '%\n' +
    cursor +
    ' / ' +
    total +
    '\n✅ موفق: ' +
    (Number(job.ok) || 0) +
    '   ❌ ناموفق: ' +
    (Number(job.fail) || 0);
  if (!finished) {
    body +=
      '\n\n📌 این پیام سنجاق است و خودکار به‌روز می‌شود.\n' +
      'صف روی ترافیک ربات هم جلو می‌رود.\n' +
      'برای سرعت بیشتر «ادامه ارسال» را بزن.';
  } else {
    body += '\n\nارسال کامل شد.';
  }
  return body;
}

export async function bindAnnounceProgress(chatId, progressMessageId) {
  try {
    const job = await loadAnnounceJob();
    if (!job) return;
    job.progressChatId = Number(chatId);
    job.progressMessageId = Number(progressMessageId);
    await saveAnnounceJob(job);
  } catch (_e) {}
}

export async function updateAnnounceProgressBar(job) {
  if (!job) return false;
  const chatId = job.progressChatId || job.ownerId;
  const mid = job.progressMessageId;
  if (!chatId) return false;
  const text = buildAnnounceProgressText(job);
  const finished = job.status === 'done' || job.status === 'stopped';
  try {
    if (mid) {
      try {
        await api.editMessageText({
          chat_id: Number(chatId),
          message_id: Number(mid),
          text: text,
          reply_markup: sanitizeMarkup(announceProgressInline(!!finished)),
        });
        return true;
      } catch (_e) {
        /* fallthrough resend */
      }
    }
    try {
      const sent = await api.sendMessage({
        chat_id: Number(chatId),
        text: text,
        reply_markup: sanitizeMarkup(announceProgressInline(!!finished)),
      });
      const nid = msgIdOf(sent);
      if (nid) {
        job.progressMessageId = Number(nid);
        job.progressChatId = Number(chatId);
        await saveAnnounceJob(job);
        try {
          await api.pinChatMessage({
            chat_id: Number(chatId),
            message_id: Number(nid),
            disable_notification: true,
          });
        } catch (_p) {}
      }
      return true;
    } catch (e2) {
      console.error('updateAnnounceProgressBar resend', e2 && (e2.description || e2.message || e2));
      return false;
    }
  } catch (e) {
    console.error('updateAnnounceProgressBar', e && (e.description || e.message || e));
    return false;
  }
}

/** تعداد مخاطبین */
export async function countAnnounceAudience(target) {
  try {
    if (target === 'admins' || target === 'admin_fb') {
      const rows = (await db.select({ n: sql`count(DISTINCT user_id)` }).from(channelAdmins).all()) || [];
      const row = rows[0] || {};
      return Number(row.n != null ? row.n : Object.values(row)[0] || 0) || 0;
    }
    // همه کاربران غیرمسدود
    try {
      const rows = (await db.select({ n: sql`count(*)` }).from(users).all()) || [];
      const row = rows[0] || {};
      let n = Number(row.n != null ? row.n : Object.values(row)[0] || 0) || 0;
      if (n > 0) return n;
    } catch (_e) {}
    try {
      const all = (await db.select({ userId: users.userId, blocked: users.blocked }).from(users).limit(20000).all()) || [];
      return all.filter(function (u) {
        return Number(u.userId || u.user_id) && Number(u.blocked) !== 1;
      }).length;
    } catch (e2) {
      console.error('count users fallback', e2);
      return 0;
    }
  } catch (e) {
    console.error('countAnnounceAudience', e);
    return 0;
  }
}

/**
 * دسته بعدی آیدی‌ها
 * @returns {{ ids: number[], nextLastId: number }}
 */
export async function fetchAnnounceBatchIds(job, limit) {
  const n = Math.max(1, Math.min(Number(limit) || CHUNK, 80));
  const target = String(job.target || 'all');
  const lastId = Number(job.lastId) || 0;

  // اگر ids از قبل در job باشد (ادمین‌ها / لیست کوچک)
  if (Array.isArray(job.ids) && job.ids.length) {
    const cursor = Number(job.cursor) || 0;
    const slice = job.ids.slice(cursor, cursor + n).map(Number).filter(Boolean);
    return { ids: slice, nextLastId: lastId, fromIndex: cursor };
  }

  if (target === 'admins' || target === 'admin_fb') {
    try {
      const rows = (await db.select().from(channelAdmins).all()) || [];
      const seen = {};
      const all = [];
      for (const a of rows) {
        const id = Number(a.userId || a.user_id);
        if (id && !seen[id]) {
          seen[id] = true;
          all.push(id);
        }
      }
      all.sort(function (a, b) {
        return a - b;
      });
      const slice = all.filter(function (id) {
        return id > lastId;
      }).slice(0, n);
      const nextLast = slice.length ? slice[slice.length - 1] : lastId;
      return { ids: slice, nextLastId: nextLast, fromIndex: 0 };
    } catch (e) {
      console.error('fetchAnnounceBatchIds admins', e);
      return { ids: [], nextLastId: lastId, fromIndex: 0 };
    }
  }

  // همه کاربران — صفحه‌بندی با lastId
  try {
    let rows = [];
    try {
      rows =
        (await db
          .select({ userId: users.userId, blocked: users.blocked })
          .from(users)
          .where(sql`user_id > ${lastId}`)
          .orderBy(asc(users.userId))
          .limit(n * 3)
          .all()) || [];
    } catch (_e1) {
      rows = (await db.select().from(users).all()) || [];
      rows = rows
        .map(function (u) {
          return { userId: Number(u.userId || u.user_id), blocked: u.blocked };
        })
        .filter(function (u) {
          return u.userId > lastId;
        })
        .sort(function (a, b) {
          return a.userId - b.userId;
        })
        .slice(0, n * 3);
    }
    const ids = [];
    for (const u of rows) {
      const id = Number(u.userId || u.user_id);
      if (!id) continue;
      if (Number(u.blocked) === 1) continue;
      ids.push(id);
      if (ids.length >= n) break;
    }
    const nextLast = ids.length ? ids[ids.length - 1] : lastId;
    return { ids: ids, nextLastId: nextLast, fromIndex: 0 };
  } catch (e) {
    console.error('fetchAnnounceBatchIds all', e);
    return { ids: [], nextLastId: lastId, fromIndex: 0 };
  }
}

export async function drainAnnouncePiggyback(maxN) {
  const n = Math.max(1, Math.min(Number(maxN) || CHUNK, 80));
  try {
    const job0 = await loadAnnounceJob();
    if (!job0 || job0.status !== 'running') return { did: false };

    const now = Date.now();
    const lockUntil = Number(await settingGet('announce_lock', '0')) || 0;
    if (lockUntil > now) return { did: false, locked: true };

    const myUntil = now + LOCK_MS;
    await settingSet('announce_lock', String(myUntil));
    const lock2 = Number(await settingGet('announce_lock', '0')) || 0;
    if (lock2 !== myUntil && lock2 > myUntil) return { did: false, locked: true };

    const job = await loadAnnounceJob();
    if (!job || job.status !== 'running') {
      await settingSet('announce_lock', '0');
      return { did: false };
    }

    const total = Number(job.total) || (job.ids && job.ids.length) || 0;
    const cursor = Number(job.cursor) || 0;
    if (total > 0 && cursor >= total) {
      job.status = 'done';
      await saveAnnounceJob(job);
      await settingSet('announce_lock', '0');
      await updateAnnounceProgressBar(job);
      return { did: false, finished: true };
    }

    const batch = await fetchAnnounceBatchIds(job, n);
    const ids = batch.ids || [];
    if (!ids.length) {
      job.status = 'done';
      job.cursor = total || cursor;
      await saveAnnounceJob(job);
      await settingSet('announce_lock', '0');
      await updateAnnounceProgressBar(job);
      return { did: true, finished: true, ok: job.ok, fail: job.fail };
    }

    let ok = Number(job.ok) || 0;
    let fail = Number(job.fail) || 0;
    const text = job.text || '';
    const ents = Array.isArray(job.entities) && job.entities.length ? job.entities : null;
    let hit429 = false;
    let sent = 0;

    for (let i = 0; i < ids.length; i++) {
      try {
        const payload = {
          chat_id: ids[i],
          text: text,
          disable_notification: true,
        };
        if (ents) payload.entities = ents;
        await api.sendMessage(payload);
        ok++;
        sent++;
      } catch (e) {
        const msg = String((e && (e.description || e.message)) || e);
        if (
          msg.includes('429') ||
          msg.toLowerCase().includes('too many') ||
          msg.toLowerCase().includes('retry')
        ) {
          hit429 = true;
          // lastId را تا نفر قبلی جلو ببر
          if (i > 0) job.lastId = ids[i - 1];
          break;
        }
        if (/\b5\d\d\b/.test(msg) || /timeout/i.test(msg) || /ECONN/i.test(msg)) {
          hit429 = true;
          if (i > 0) job.lastId = ids[i - 1];
          break;
        }
        fail++;
        sent++;
      }
    }

    if (!hit429) {
      job.lastId = batch.nextLastId;
    }
    job.ok = ok;
    job.fail = fail;
    // cursor = تعداد پردازش‌شده (موفق+ناموفق قطعی، بدون نفر متوقف‌شده به‌خاطر 429)
    job.cursor = cursor + sent;
    if (!hit429 && (ids.length < n || (total > 0 && job.cursor >= total))) {
      job.status = 'done';
    } else {
      job.status = 'running';
    }
    if (!job.progressMessageId && job0.progressMessageId) {
      job.progressMessageId = job0.progressMessageId;
      job.progressChatId = job0.progressChatId || job0.ownerId;
    }
    await saveAnnounceJob(job);
    await settingSet('announce_lock', '0');
    try {
      await updateAnnounceProgressBar(job);
    } catch (_e) {}

    return {
      did: true,
      ok: ok,
      fail: fail,
      finished: job.status === 'done',
      total: total,
    };
  } catch (e) {
    console.error('drainAnnouncePiggyback', e);
    try {
      await settingSet('announce_lock', '0');
    } catch (_e) {}
    return { did: false, error: true };
  }
}

export async function drainAnnounceOwnerBurst(chatId, progressMessageId, maxMs) {
  const budget = Math.min(Number(maxMs) || 20000, 25000);
  const started = Date.now();
  if (chatId && progressMessageId) {
    await bindAnnounceProgress(chatId, progressMessageId);
  }
  let last = null;
  while (Date.now() - started < budget) {
    last = await drainAnnouncePiggyback(CHUNK);
    if (!last || !last.did) break;
    if (last.finished) break;
    if (last.locked) break;
  }
  try {
    const job = await loadAnnounceJob();
    if (job) await updateAnnounceProgressBar(job);
  } catch (e) {
    console.error('drainAnnounceOwnerBurst progress', e);
  }
  return last;
}

export { CHUNK };
