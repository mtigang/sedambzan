/**
 * سوراخ پیام (Message Hole) — تخلیه کنترل‌شده صف pending
 * موج‌های کوچک + قفل + بدون از دست رفتن پیام
 */
import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { messages } from 'schema';
import { DEFAULT_CHANNELS } from 'lib/config';
import { settingGet, settingSet, acquireLock, releaseLock, toBoldHtml, dropMessageFromAllReviewBatches } from 'lib/dbutil';
import { exactBodyKey } from 'lib/validation';
import { channelMessageLink } from 'lib/resolve';
import { flushProgressInline, sanitizeMarkup } from 'lib/keyboards';

export const HOLE_BATCH = 10;
export const HOLE_MIN_INTERVAL_MS = 25000;
export const HOLE_LOCK_KEY = 'hole_drain_lock';
export const HOLE_JOB_KEY = 'flush_job'; // سازگار با UI/کد قبلی انتشار مستقیم

export async function getHoleJob() {
  try {
    const raw = await settingGet(HOLE_JOB_KEY, '');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

export async function saveHoleJob(job) {
  try {
    await settingSet(HOLE_JOB_KEY, JSON.stringify(job || {}));
  } catch (e) {
    console.error('saveHoleJob', e);
  }
}

function progressText(job, conf, leftCount, finished) {
  const totalStart = Number(job.total) || 0;
  const ok = Number(job.ok) || 0;
  const fail = Number(job.fail) || 0;
  const skip = Number(job.skip) || 0;
  const done = ok + fail + skip;
  const pct = totalStart ? Math.min(10, Math.floor((done / Math.max(totalStart, 1)) * 10)) : finished ? 10 : 0;
  let bar = '';
  for (let i = 0; i < 10; i++) bar += i < pct ? '█' : '░';
  const title = (conf && conf.title) || job.channelKey || '';
  return (
    (finished ? '✅ سوراخ پیام تمام شد\n' : '🕳️ سوراخ پیام فعال\n') +
    bar +
    ' ' +
    done +
    '/' +
    totalStart +
    '\n' +
    'کانال: «' +
    title +
    '»\n' +
    '✅ منتشر: ' +
    ok +
    '  ⏭ تکراری: ' +
    skip +
    '  ❌ خطا: ' +
    fail +
    '\n' +
    'باقی‌مانده pending: ' +
    leftCount +
    (finished
      ? ''
      : '\n\nموج‌ها خودکار با ترافیک ربات جلو می‌روند.\nبرای سرعت بیشتر «دسته بعدی» را بزنید.')
  );
}

async function paintJob(job, conf, leftCount, finished) {
  if (!job || !job.progressChatId || !job.progressMessageId) return;
  try {
    await api.editMessageText({
      chat_id: job.progressChatId,
      message_id: job.progressMessageId,
      text: progressText(job, conf, leftCount, finished),
      reply_markup: sanitizeMarkup(
        flushProgressInline(finished, (Number(job.skip) || 0) > 0 || (job.skipIds && job.skipIds.length > 0))
      ),
    });
  } catch (_e) {}
}

/**
 * یک موج تخلیه. safe برای piggyback.
 * opts.force=true فاصله زمانی را نادیده می‌گیرد (دکمه ادامه مالک)
 */
export async function drainHoleWave(opts) {
  opts = opts || {};
  const force = !!opts.force;
  const maxN = Math.min(Number(opts.maxN) || HOLE_BATCH, HOLE_BATCH);

  let job = await getHoleJob();
  if (!job || job.status !== 'running') {
    return { ran: false, reason: 'idle' };
  }

  const now = Date.now();
  if (!force && job.lastWaveAt && now - Number(job.lastWaveAt) < HOLE_MIN_INTERVAL_MS) {
    return { ran: false, reason: 'cooldown' };
  }

  const token = await acquireLock(HOLE_LOCK_KEY, 20000);
  if (!token) return { ran: false, reason: 'busy' };

  try {
    job = await getHoleJob();
    if (!job || job.status !== 'running') return { ran: false, reason: 'idle' };
    if (!force && job.lastWaveAt && Date.now() - Number(job.lastWaveAt) < HOLE_MIN_INTERVAL_MS) {
      return { ran: false, reason: 'cooldown' };
    }

    const channelKey = job.channelKey;
    const conf = DEFAULT_CHANNELS[channelKey];
    if (!conf || !conf.chatId) {
      job.status = 'stopped';
      await saveHoleJob(job);
      return { ran: false, reason: 'bad_channel' };
    }

    let ok = Number(job.ok) || 0;
    let fail = Number(job.fail) || 0;
    let skip = Number(job.skip) || 0;
    let skipIds = Array.isArray(job.skipIds) ? job.skipIds.slice() : [];

    const pending =
      (await db
        .select()
        .from(messages)
        .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
        .all()) || [];
    pending.sort(function (a, b) {
      return Number(a.id) - Number(b.id);
    });

    // ضدتکرار روی approved همین کانال (نمونه محدود برای سرعت)
    const seenBody = {};
    try {
      const approved =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'approved'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      const tail = approved.length > 800 ? approved.slice(approved.length - 800) : approved;
      for (const a of tail) {
        try {
          const b = exactBodyKey(a.content);
          if (b) seenBody[b] = true;
        } catch (_e) {}
      }
    } catch (_e) {}

    const slice = pending.slice(0, maxN);
    let processed = 0;

    for (const row of slice) {
      const live = await getHoleJob();
      if (!live || live.status !== 'running') {
        job.status = live && live.status ? live.status : 'stopped';
        break;
      }
      try {
        let bodyKey = '';
        try {
          bodyKey = exactBodyKey(row.content) || String(row.content || '').trim();
        } catch (_e) {
          bodyKey = String(row.content || '').trim();
        }

        if (bodyKey && seenBody[bodyKey]) {
          await db
            .update(messages)
            .set({
              status: 'rejected',
              rejectReason: 'تکراری (سوراخ پیام)',
              reviewedBy: Number(job.ownerId) || null,
              reviewedAt: new Date(),
            })
            .where(and(eq(messages.id, row.id), eq(messages.status, 'pending')))
            .run();
          skip += 1;
          skipIds.push(Number(row.id));
          processed += 1;
          continue;
        }

        // رزرو اتمیک
        await db
          .update(messages)
          .set({ status: 'publishing' })
          .where(and(eq(messages.id, row.id), eq(messages.status, 'pending')))
          .run();
        const chk = (await db.select().from(messages).where(eq(messages.id, row.id)).all()) || [];
        if (!chk[0] || String(chk[0].status) !== 'publishing') {
          processed += 1;
          continue;
        }

        let mid = null;
        try {
          const sent = await api.sendMessage({
            chat_id: conf.chatId,
            text: toBoldHtml(row.content),
            parse_mode: 'HTML',
          });
          mid = sent && sent.message_id;
        } catch (e) {
          // برگرداندن به pending — پیام نسوزد
          try {
            await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, row.id)).run();
          } catch (_e) {}
          fail += 1;
          processed += 1;
          console.error('hole channel send', row.id, e);
          // Flood → توقف موج
          const desc = String((e && (e.description || e.message)) || '');
          if (/retry after|flood|too many requests/i.test(desc)) {
            break;
          }
          continue;
        }

        if (!mid) {
          try {
            await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, row.id)).run();
          } catch (_e) {}
          fail += 1;
          processed += 1;
          continue;
        }

        try {
          await settingSet('chmsg:' + channelKey + ':' + mid, String(row.id));
        } catch (_e) {}

        await db
          .update(messages)
          .set({
            status: 'approved',
            reviewedBy: Number(job.ownerId) || null,
            reviewedAt: new Date(),
          })
          .where(eq(messages.id, row.id))
          .run();

        try {
          await dropMessageFromAllReviewBatches(row.id);
        } catch (_e) {}

        if (bodyKey) seenBody[bodyKey] = true;
        ok += 1;
        processed += 1;

        // اطلاع کاربر — شکست آن پیام را ناموفق نمی‌کند
        try {
          const link = channelMessageLink(conf.chatId, mid, channelKey);
          let txt = '✅ پیام شما تأیید و منتشر شد.';
          if (link) {
            txt += '\n\nمشاهده در کانال «' + (conf.title || channelKey) + '»:\n' + link;
          }
          await api.sendMessage({
            chat_id: row.userId,
            text: txt,
            link_preview_options: link ? { is_disabled: false, url: link } : undefined,
          });
        } catch (_e) {}
      } catch (e) {
        console.error('hole one', row && row.id, e);
        try {
          const again = (await db.select().from(messages).where(eq(messages.id, row.id)).all()) || [];
          if (again[0] && String(again[0].status) === 'publishing') {
            await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, row.id)).run();
          }
        } catch (_e) {}
        fail += 1;
        processed += 1;
      }
    }

    job.ok = ok;
    job.fail = fail;
    job.skip = skip;
    job.skipIds = skipIds.slice(-200);
    job.lastWaveAt = Date.now();

    let leftCount = 0;
    try {
      const left =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      leftCount = left.length;
    } catch (_e) {}

    if (leftCount === 0) job.status = 'done';
    await saveHoleJob(job);
    await paintJob(job, conf, leftCount, job.status === 'done');

    return {
      ran: true,
      processed,
      ok,
      fail,
      skip,
      left: leftCount,
      finished: job.status === 'done',
    };
  } finally {
    try {
      await releaseLock(HOLE_LOCK_KEY, token);
    } catch (_e) {}
  }
}

/** شروع سوراخ برای کانال */
export async function startHoleJob(ownerId, channelKey, progressChatId, progressMessageId) {
  const pending =
    (await db
      .select()
      .from(messages)
      .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
      .all()) || [];
  const job = {
    status: 'running',
    channelKey: channelKey,
    total: pending.length,
    ok: 0,
    fail: 0,
    skip: 0,
    skipIds: [],
    ownerId: ownerId,
    progressChatId: progressChatId || ownerId,
    progressMessageId: progressMessageId || null,
    lastWaveAt: 0,
  };
  await saveHoleJob(job);
  return job;
}

/** piggyback سبک — بعد از موفقیت کار اصلی Handler */
export async function drainHolePiggyback() {
  try {
    const job = await getHoleJob();
    if (!job || job.status !== 'running') return { ran: false };
    return await drainHoleWave({ force: false, maxN: HOLE_BATCH });
  } catch (e) {
    console.error('drainHolePiggyback', e);
    return { ran: false, error: true };
  }
}
