/**
 * صف اطلاعیه: تخلیهٔ سبک روی ترافیک طبیعی ربات
 * اولویت با کار هندلر است — این تابع بعد از آن صدا زده می‌شود.
 */
import { api } from 'sdk';
import { settingGet, settingSet } from 'lib/dbutil';

const CHUNK = 35;
const LOCK_MS = 4500;

export async function loadAnnounceJob() {
  const raw = await settingGet('announce_job', '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

export async function saveAnnounceJob(job) {
  await settingSet('announce_job', JSON.stringify(job));
}

export function buildAnnounceProgressText(job) {
  const total = (job.ids && job.ids.length) || Number(job.total) || 0;
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
    (job.ok || 0) +
    '   ❌ ناموفق: ' +
    (job.fail || 0);
  if (!finished) {
    body +=
      '\n\nاین پیام سنجاق شده است و با پیشرفت صف به‌روز می‌شود.\n' +
      'صف روی ترافیک ربات هم جلو می‌رود. برای سرعت بیشتر «ادامه ارسال» را بزن.';
  } else {
    body += '\n\nارسال کامل شد.';
  }
  return { body, finished, pct };
}

/** به‌روز کردن نوار سنجاق‌شدهٔ مالک (بدون پرتاب خطا) */
export async function updateAnnounceProgressBar(jobOverride) {
  try {
    const job = jobOverride || (await loadAnnounceJob());
    if (!job) return;
    const chatId = job.progressChatId || job.ownerId;
    const mid = job.progressMessageId;
    if (!chatId || !mid) return;
    const { body, finished } = buildAnnounceProgressText(job);
    const { announceProgressInline, sanitizeMarkup } = await import('lib/keyboards');
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: mid,
        text: body,
        reply_markup: sanitizeMarkup(announceProgressInline(finished)),
      });
    } catch (_e) {
      // پیام حذف شده یا یکسان — نادیده
    }
  } catch (e) {
    console.error('updateAnnounceProgressBar', e);
  }
}

/**
 * رزرو اتمیک‌مانند: قفل کوتاه + جلو بردن cursor قبل از ارسال
 */
export async function drainAnnouncePiggyback(maxN) {
  const n = Math.max(1, Math.min(Number(maxN) || CHUNK, 80));
  try {
    const job0 = await loadAnnounceJob();
    if (!job0 || job0.status !== 'running') return { did: false };
    const ids0 = job0.ids;
    if (!ids0 || !ids0.length) return { did: false };
    if (Number(job0.cursor) >= ids0.length) {
      job0.status = 'done';
      await saveAnnounceJob(job0);
      await updateAnnounceProgressBar(job0);
      return { did: false, finished: true };
    }

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
    const ids = job.ids || [];
    let cursor = Number(job.cursor) || 0;
    const total = ids.length;
    if (cursor >= total) {
      job.status = 'done';
      await saveAnnounceJob(job);
      await settingSet('announce_lock', '0');
      await updateAnnounceProgressBar(job);
      return { did: false, finished: true };
    }

    const end = Math.min(cursor + n, total);
    const slice = ids.slice(cursor, end);
    job.cursor = end;
    if (end >= total) job.status = 'done';
    await saveAnnounceJob(job);

    let ok = Number(job.ok) || 0;
    let fail = Number(job.fail) || 0;
    const text = job.text || '';

    for (let i = 0; i < slice.length; i++) {
      try {
        await api.sendMessage({ chat_id: slice[i], text: text });
        ok++;
      } catch (e) {
        fail++;
        const msg = String((e && (e.description || e.message)) || e);
        if (msg.includes('429') || msg.toLowerCase().includes('too many') || msg.toLowerCase().includes('retry')) {
          break;
        }
      }
    }

    const job2 = (await loadAnnounceJob()) || job;
    job2.ok = ok;
    job2.fail = fail;
    if (Number(job2.cursor) >= (job2.ids || ids).length) job2.status = 'done';
    await saveAnnounceJob(job2);
    await settingSet('announce_lock', '0');
    // به‌روز کردن نوار سنجاق‌شده
    await updateAnnounceProgressBar(job2);

    return {
      did: true,
      from: cursor,
      to: end,
      ok,
      fail,
      finished: job2.status === 'done',
      total: (job2.ids || ids).length,
    };
  } catch (e) {
    console.error('drainAnnouncePiggyback', e);
    try {
      await settingSet('announce_lock', '0');
    } catch (_e) {}
    return { did: false, error: true };
  }
}

/** برای دکمهٔ ادامهٔ مالک */
export async function drainAnnounceOwnerBurst(chatId, progressMessageId, maxMs) {
  const budget = Math.min(Number(maxMs) || 12000, 18000);
  const started = Date.now();
  let last = null;
  while (Date.now() - started < budget) {
    last = await drainAnnouncePiggyback(CHUNK);
    if (!last || !last.did) break;
    if (last.finished) break;
    if (last.locked) break;
  }
  try {
    const job = await loadAnnounceJob();
    if (!job) return last;
    if (progressMessageId && !job.progressMessageId) {
      job.progressMessageId = progressMessageId;
      job.progressChatId = chatId;
      await saveAnnounceJob(job);
    }
    await updateAnnounceProgressBar(job);
  } catch (e) {
    console.error('drainAnnounceOwnerBurst progress', e);
  }
  return last;
}
