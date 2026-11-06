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
  getUser, findBodyDuplicate,
  rememberUserMessageId,
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

  // بن
  if (!owner) {
    try {
      const uBan = await getUser(uid);
      if (uBan && Number(uBan.blocked) === 1) {
        return { ok: false, error: 'شما از ربات مسدود شده‌اید.', code: 'blocked' };
      }
    } catch (_e) {}
  }

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
  if (!(await isBotOn()) && !owner) {
    return {
      ok: false,
      error:
        '🔴 ربات موقتاً خاموش است.\n\n' +
        'پیام شما ثبت نشد — ربات خراب نیست.\n' +
        'لطفاً بعداً دوباره تلاش کنید.',
    };
  }

  // اعتبارسنجی (بدون entity بولد — مینی‌اپ متن ساده می‌فرستد؛ ربات خودش بولد می‌کند)
  const v = validateAndFix({ text: rawText, entities: [] });
  if (!v.ok) return { ok: false, error: v.error || 'پیام نامعتبر است.' };

  const chTitle =
    (DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey;

  // صف شلوغ به‌ازای کانال
  if (!owner && (await isQueueBusyMode(v.channelKey))) {
    return {
      ok: false,
      error:
        '⏳ صف «' +
        chTitle +
        '» شلوغ است.\n\n' +
        'پیام شما ثبت نشد — ربات سالم است و فقط ورودی این کانال موقتاً بسته شده.\n' +
        'کمی بعد دوباره بفرستید.',
    };
  }

  const ch = await getChannel(v.channelKey);
  if (!ch || Number(ch.enabled) === 0) {
    return {
      ok: false,
      error:
        '🔴 کانال «' +
        chTitle +
        '» غیرفعال است.\n\nپیام ثبت نشد (عمدی است، نه خرابی ربات).',
    };
  }

  try {
    if (!(await isChannelOpen(v.channelKey))) {
      return {
        ok: false,
        error:
          '🔴 دریافت پیام برای «' +
          chTitle +
          '» فعلاً خاموش است.\n\n' +
          'پیام شما ثبت نشد.\nمالک این کانال را موقتاً بسته است — بعداً تلاش کنید.',
      };
    }
    if (await isChannelAdMode(v.channelKey)) {
      return {
        ok: false,
        error:
          '📢 «' +
          chTitle +
          '» الان درگیر تبلیغات / تبادل است.\n\n' +
          'پیام شما ثبت نشد — ربات سالم است.\n' +
          'کمی بعد دوباره بفرستید.',
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
    // تکراری — سبک (ایندکس + نمونه محدود؛ نه .all)
  let dup = null;
  let dupIsPending = false;
  let queuePos = 0;
  try {
    const found = await findBodyDuplicate(v.channelKey, bodyKey);
    if (found && found.dup) {
      dup = found.dup;
      dupIsPending = !!found.dupIsPending;
      queuePos = Number(found.queuePos) || 0;
    }
  } catch (e) {
    console.error('submit dup check', e);
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
      })
      .run();

    let msgId = null;
    const lastRows =
      (await db
        .select({
          id: messages.id,
          userId: messages.userId,
          content: messages.content,
          channelKey: messages.channelKey,
          status: messages.status,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(20)
        .all()) || [];
    for (const row of lastRows) {
      if (Number(row.userId ?? row.user_id) !== Number(uid)) continue;
      if (String(row.status) !== 'pending') continue;
      if (String(row.channelKey || row.channel_key) !== String(v.channelKey)) continue;
      if (String(row.content || '') === String(v.content)) {
        msgId = row.id;
        break;
      }
    }
    if (msgId == null) {
      for (const row of lastRows) {
        if (Number(row.userId ?? row.user_id) === Number(uid) && String(row.status) === 'pending') {
          msgId = row.id;
          break;
        }
      }
    }
    if (msgId == null && lastRows[0]) msgId = lastRows[0].id;
    if (msgId != null && bodyKey) {
      try {
        await settingSet(bIdx, String(msgId) + '|pending');
      } catch (_e) {}
    }
    if (msgId != null) {
      try {
        await rememberUserMessageId(uid, msgId);
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
