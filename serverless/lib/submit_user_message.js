/**
 * ثبت پیام کاربر — مسیر مشترک بات و مینی‌اپ
 * همان قوانین validateAndFix + شیفت + تکراری + نرخ
 */
import { db } from 'sdk';
import { eq, and, desc } from 'sdk/db';
import { messages } from 'schema';
import { DEFAULT_CHANNELS, OWNER_IDS } from 'lib/config';
import { validateAndFix, exactBodyKey, bodyIndexSettingKey } from 'lib/validation';
import { tehranNow, inRange, isWorkHours, workHoursClosedText, toFaDigits } from 'lib/time';
import {
  isBotOn,
  isFridayMode,
  isQueueBusyMode,
  isChannelOpen,
  isChannelAdMode,
  activeShiftAdmins,
  nextShiftAfterNow,
  getChannel,
  settingGet,
  settingSet,
  acquireLock,
  releaseLock,
  forceJoinNeedGate,
  pruneOldestMessageIfOverBudget,
  FRIDAY_MODE_TEXT,
  QUEUE_BUSY_TEXT,
} from 'lib/dbutil';

function isOwner(uid) {
  return (OWNER_IDS || []).map(Number).includes(Number(uid));
}

async function checkRateLimit(uid) {
  const key = 'rate:' + uid;
  const raw = await settingGet(key, '[]');
  let arr = [];
  try {
    arr = JSON.parse(raw) || [];
  } catch (_e) {
    arr = [];
  }
  const now = Date.now();
  arr = arr.filter(function (t) {
    return now - t < 10 * 60 * 1000;
  });
  if (arr.length >= 6) return { ok: false };
  arr.push(now);
  await settingSet(key, JSON.stringify(arr));
  return { ok: true };
}

/**
 * @param {number} userId
 * @param {string} text
 * @returns {{ ok: true, msgId: number, content: string, channelKey: string, autoFixed?: boolean } | { ok: false, error: string }}
 */
export async function submitUserMessage(userId, text) {
  const uid = Number(userId);
  const owner = isOwner(uid);
  const rawText = String(text || '').trim();
  if (!rawText) return { ok: false, error: 'متن خالی است.' };

  // عضویت اجباری
  if (!owner) {
    try {
      const camp = await forceJoinNeedGate(uid);
      if (camp) {
        return {
          ok: false,
          error: '🔐 برای استفاده از ربات باید در کانال اعلام‌شده عضو شوید و در ربات «تأیید عضویت» را بزنید.',
          code: 'force_join',
        };
      }
    } catch (_e) {}
  }

  if (!owner && (await isFridayMode())) {
    return { ok: false, error: FRIDAY_MODE_TEXT || 'امروز جمعه است؛ ارسال پیام ممکن نیست.' };
  }
  if (!owner && (await isQueueBusyMode())) {
    return {
      ok: false,
      error: QUEUE_BUSY_TEXT || 'حجم صف زیاد است. کمی بعد دوباره تلاش کنید.',
    };
  }
  if (!(await isBotOn()) && !owner) {
    return { ok: false, error: '🔴 ربات در حال حاضر غیرفعال است.' };
  }

  // اعتبارسنجی (بدون entity بولد — مینی‌اپ متن ساده می‌فرستد؛ ربات خودش بولد می‌کند)
  const v = validateAndFix({ text: rawText, entities: [] });
  if (!v.ok) return { ok: false, error: v.error || 'پیام نامعتبر است.' };

  const ch = await getChannel(v.channelKey);
  if (!ch || Number(ch.enabled) === 0) {
    return { ok: false, error: '🔴 این کانال غیرفعال است.' };
  }

  try {
    if (!(await isChannelOpen(v.channelKey))) {
      return {
        ok: false,
        error:
          '🔴 دریافت پیام برای «' +
          ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
          '» فعلاً غیرفعال است.',
      };
    }
    if (await isChannelAdMode(v.channelKey)) {
      return {
        ok: false,
        error:
          '📢 «' +
          ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
          '» الان درگیر تبلیغات است. کمی بعد دوباره بفرستید.',
      };
    }
  } catch (_e) {}

  if (!owner) {
    let activeAds = [];
    try {
      activeAds = await activeShiftAdmins(v.channelKey);
    } catch (_e) {
      activeAds = [];
    }
    if (!activeAds || !activeAds.length) {
      if (!isWorkHours()) {
        return { ok: false, error: workHoursClosedText() };
      }
      try {
        const now = tehranNow();
        if (ch.workStart && ch.workEnd && !inRange(now.hm, ch.workStart, ch.workEnd)) {
          return {
            ok: false,
            error:
              '⏰ ساعت کاری «' + ch.title + '» از ' + ch.workStart + ' تا ' + ch.workEnd + ' است.',
          };
        }
      } catch (_e) {}
      let t =
        '⏰ الان شیفت فعالی برای «' +
        ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
        '» نیست؛ پیام ثبت نمی‌شود.\n';
      try {
        const nxt = await nextShiftAfterNow(v.channelKey);
        if (nxt && nxt.start) {
          t +=
            'نزدیک‌ترین شیفت بعدی از ساعت ' +
            toFaDigits(nxt.start) +
            ' تا ' +
            toFaDigits(nxt.end) +
            ' است.';
        } else {
          t += 'لطفاً وقتی شیفت فعال است ارسال کنید.';
        }
      } catch (_e) {
        t += 'لطفاً وقتی شیفت فعال است دوباره تلاش کنید.';
      }
      return { ok: false, error: t };
    }
  }

  const bodyKey = exactBodyKey(v.content);
  if (!bodyKey) return { ok: false, error: '⚠️ متن پیام نامعتبر است.' };

  const bIdx = bodyIndexSettingKey(v.channelKey, bodyKey);
  let bodyLock = null;
  try {
    bodyLock = await acquireLock('lock:' + bIdx, 6000);
  } catch (_e) {}
  if (!bodyLock) {
    return { ok: false, error: '⏳ همین متن در حال ثبت است. چند ثانیه صبر کنید.' };
  }

  try {
    // تکراری
    let dup = null;
    let dupIsPending = false;
    let queuePos = 0;
    const hit = await settingGet(bIdx, '');
    if (hit) {
      const hid = Number(String(hit).split('|')[0]);
      const hst = String(hit).split('|')[1] || 'pending';
      if (hid && (hst === 'pending' || hst === 'approved')) {
        dup = { id: hid, status: hst };
        dupIsPending = hst === 'pending';
      }
    }
    if (!dup) {
      const pendingRows =
        (await db
          .select({
            id: messages.id,
            status: messages.status,
            content: messages.content,
          })
          .from(messages)
          .where(and(eq(messages.channelKey, v.channelKey), eq(messages.status, 'pending')))
          .all()) || [];
      for (const row of pendingRows) {
        const other = exactBodyKey(row.content);
        if (other && other === bodyKey) {
          dup = row;
          dupIsPending = true;
          const pendingSorted = pendingRows.slice().sort(function (a, b) {
            return Number(a.id) - Number(b.id);
          });
          const idx = pendingSorted.findIndex(function (x) {
            return Number(x.id) === Number(row.id);
          });
          queuePos = idx >= 0 ? idx : 0;
          try {
            await settingSet(bIdx, String(row.id) + '|pending');
          } catch (_e) {}
          break;
        }
      }
    }
    if (!dup) {
      const recentApproved =
        (await db
          .select({
            id: messages.id,
            status: messages.status,
            content: messages.content,
          })
          .from(messages)
          .where(and(eq(messages.channelKey, v.channelKey), eq(messages.status, 'approved')))
          .orderBy(desc(messages.id))
          .limit(200)
          .all()) || [];
      for (const row of recentApproved) {
        const other = exactBodyKey(row.content);
        if (other && other === bodyKey) {
          dup = row;
          dupIsPending = false;
          try {
            await settingSet(bIdx, String(row.id) + '|approved');
          } catch (_e) {}
          break;
        }
      }
    }
    if (dup) {
      if (dupIsPending) {
        return {
          ok: false,
          error:
            '⚠️ این پیام قبلاً ارسال شده و در صف تأیید است.\nتعداد قبل از آن: ' +
            queuePos +
            '\nشناسه: #' +
            dup.id,
        };
      }
      return {
        ok: false,
        error: '⚠️ این پیام قبلاً ارسال شده و تکراری است.\nشناسه: #' + dup.id,
      };
    }

    if (!owner) {
      const rl = await checkRateLimit(uid);
      if (!rl.ok) {
        return {
          ok: false,
          error: '⏳ محدودیت ارسال: حداکثر ۶ پیام در ۱۰ دقیقه.',
        };
      }
    }

    const sendLockKey = 'lock:send:' + uid;
    try {
      const lockVal = await settingGet(sendLockKey, '');
      const lockTs = Number(lockVal) || 0;
      if (lockTs && Date.now() - lockTs < 4000) {
        return { ok: false, error: '⏳ درخواست قبلی هنوز در حال ثبت است.' };
      }
      await settingSet(sendLockKey, String(Date.now()));
    } catch (_e) {}

    await db
      .insert(messages)
      .values({
        userId: uid,
        content: v.content,
        channelKey: v.channelKey,
        status: 'pending',
        submittedAt: new Date(),
      })
      .run();

    let msgId = null;
    const lastRows =
      (await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.userId, uid))
        .orderBy(desc(messages.id))
        .limit(1)
        .all()) || [];
    if (lastRows[0]) msgId = lastRows[0].id;
    if (msgId != null && bodyKey) {
      try {
        await settingSet(bIdx, String(msgId) + '|pending');
      } catch (_e) {}
    }

    try {
      await pruneOldestMessageIfOverBudget();
    } catch (_e) {}

    return {
      ok: true,
      msgId: msgId,
      content: v.content,
      channelKey: v.channelKey,
      autoFixed: !!v.autoFixed,
      title: (DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey,
    };
  } finally {
    try {
      if (bodyLock) await releaseLock('lock:' + bIdx, bodyLock);
    } catch (_e) {}
  }
}
