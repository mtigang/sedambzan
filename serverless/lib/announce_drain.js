/**
 * صف اطلاعیه + نوار پیشرفت سنجاق‌شده برای مالک
 */
import { api } from 'sdk';
import { settingGet, settingSet } from 'lib/dbutil';
import { announceProgressInline, sanitizeMarkup } from 'lib/keyboards';

const CHUNK = 55;
const LOCK_MS = 5500;

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

function msgIdOf(msg) {
  if (!msg) return null;
  return msg.message_id || msg.messageId || msg.id || null;
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
    (Number(job.ok) || 0) +
    '   ❌ ناموفق: ' +
    (Number(job.fail) || 0);
  if (!finished) {
    body +=
      '\n\n📌 این پیام سنجاق است و خودکار به‌روز می‌شود.\n' +
      'صف روی ترافیک ربات هم جلو می‌رود.\nبرای سرعت بیشتر «ادامه ارسال» را بزن.';
  } else {
    body += '\n\nارسال کامل شد.';
  }
  return { body, finished, pct };
}

/**
 * ذخیرهٔ ارجاع نوار پیشرفت (برای پیام قدیمی هم کار می‌کند)
 */
export async function bindAnnounceProgress(chatId, messageId) {
  if (!chatId || !messageId) return null;
  const job = await loadAnnounceJob();
  if (!job) return null;
  job.progressChatId = Number(chatId);
  job.progressMessageId = Number(messageId);
  await saveAnnounceJob(job);
  return job;
}

export async function updateAnnounceProgressBar(jobOverride) {
  try {
    const job = jobOverride || (await loadAnnounceJob());
    if (!job) return false;
    const chatId = job.progressChatId || job.ownerId;
    const mid = job.progressMessageId;
    if (!chatId || !mid) return false;
    const { body, finished } = buildAnnounceProgressText(job);
    try {
      await api.editMessageText({
        chat_id: Number(chatId),
        message_id: Number(mid),
        text: body,
        reply_markup: sanitizeMarkup(announceProgressInline(!!finished)),
      });
      return true;
    } catch (e) {
      // اگر ویرایش نشد، یک پیام جدید بفرست و آن را جایگزین نوار کن
      try {
        const sent = await api.sendMessage({
          chat_id: Number(chatId),
          text: body,
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
    }
  } catch (e) {
    console.error('updateAnnounceProgressBar', e && (e.description || e.message || e));
    return false;
  }
}

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
    const cursor = Number(job.cursor) || 0;
    const total = ids.length;
    if (cursor >= total) {
      job.status = 'done';
      await saveAnnounceJob(job);
      await settingSet('announce_lock', '0');
      await updateAnnounceProgressBar(job);
      return { did: false, finished: true };
    }

    const end = Math.min(cursor + n, total);
    let ok = Number(job.ok) || 0;
    let fail = Number(job.fail) || 0;
    const text = job.text || '';
    let pos = cursor;
    let hit429 = false;

    for (; pos < end; pos++) {
      try {
        await api.sendMessage({
          chat_id: ids[pos],
          text: text,
          disable_notification: true,
        });
        ok++;
      } catch (e) {
        const msg = String((e && (e.description || e.message)) || e);
        if (msg.includes('429') || msg.toLowerCase().includes('too many') || msg.toLowerCase().includes('retry')) {
          // cursor روی همین نفر بماند تا بعداً دوباره تلاش شود
          hit429 = true;
          break;
        }
        // بلاک / حذف‌شده / چت نامعتبر → رد شو برو بعدی
        fail++;
      }
    }

    const job2 = (await loadAnnounceJob()) || job;
    job2.ok = ok;
    job2.fail = fail;
    job2.cursor = pos;
    if (!hit429 && pos >= total) job2.status = 'done';
    else if (hit429) job2.status = 'running';
    if (!job2.progressMessageId && job.progressMessageId) {
      job2.progressMessageId = job.progressMessageId;
      job2.progressChatId = job.progressChatId || job.ownerId;
    }
    await saveAnnounceJob(job2);
    await settingSet('announce_lock', '0');
    // هر دسته نوار را به‌روز کن
    try {
      await updateAnnounceProgressBar(job2);
    } catch (_e) {}

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

export async function drainAnnounceOwnerBurst(chatId, progressMessageId, maxMs) {
  const budget = Math.min(Number(maxMs) || 20000, 25000);
  const started = Date.now();
  // همیشه ارجاع نوار را به پیام فعلی مالک بچسبان
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

export { msgIdOf };
