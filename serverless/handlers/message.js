import { api, db } from 'sdk';
import { eq, desc, and, sql } from 'sdk/db';
import { messages, feedback, shifts, users, channelAdmins } from 'schema';
import {
  WELCOME_TEXT,
  RULES_TEXT,
  BOT_DISABLED_TEXT,
  FEEDBACK_HINT,
  DEFAULT_CHANNELS,
  OWNER_IDS,
  ADMIN_GROUP_IDS,
  CHANNEL_IDS,
  CHANNEL_USERNAMES,
} from 'lib/config';
import {
  userKeyboard,
  adminKeyboard,
  ownerKeyboard,
  dbExportContinueInline,
  ownerCancelShiftsInline,
  backKeyboard,
  settingsKeyboard,
  recentUserMsgsInline,
  channelPickFlagsInline,
  disableModesInline,
  forceJoinInline,
  forceJoinOwnerInline,
  searchKeyboard,
  channelAdminPickKeyboard,
  shiftChannelPickKeyboard,
  postChannelInline,
  sendDestInline,
  activeShiftChannelsInline,
  reviewInline,
  ownerReviewInline,
  searchMsgActionsInline,
  feedbackInline,
  userOpenInline,
  shiftSlotsInline,
  shiftModePickInline,
  adminListInline,
  announceTargetInline,
  ownerShiftMenuInline,
  reviewNextInline,
  subLeaderKeyboard,
  adminPerfInline,
  adminHelpConfirmInline,
  ownerSubLeaderMenuKeyboard,
  subLeaderPickChannelInline,
  subLeaderListInline,
  subLeaderManageInline,
  subLeaderAnnounceConfirmInline,
  subLeaderAdminsInline,
  flushChannelPickInline,
  purgeUserConfirmInline,
  purgeUserProgressInline,
  sanitizeMarkup,
  btnText,
  flushProgressInline,
  flushConfirmInline,
} from 'lib/keyboards';
// sanitize imported below
import { validateAndFix, normalizeBody, exactBodyKey, bodyIndexSettingKey } from 'lib/validation';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange, hmToMin, periodDateStr, isWorkHours, formatTsJalali, toJalaliDisplay, workHoursClosedText, toFaDigits, buildOwnerShiftSlots, normHm, sortShiftsByPeriod, periodOrd } from 'lib/time';
// normHm via time
import { resolveUserId, channelMessageLink, channelPublicBase } from 'lib/resolve';
import { setBlocked } from 'lib/users';
import { DB_EXPORT_OWNER_ID, initDbExportJob, processDbExportBatch } from 'lib/db_export';
import {
  getSubLeaderChannel,
  upsertSubLeader,
  deactivateSubLeader,
  listAllSubLeaders,
  listActiveSubLeaders,
  notifySubLeaderAppointed,
  notifySubLeaderChannelChange,
  notifySubLeaderRemoved,
  subLeaderAdmins,
  channelStatsFor,
  assertSubLeaderChannel,
} from 'lib/subleader';
import {
  ensureChannelsSeeded,
  getChannels,
  getChannel,
  isBotOn,
  isChannelOpen,
  isChannelAdMode,
  isFridayMode,
  setFridayMode,
  isQueueBusyMode,
  QUEUE_BUSY_TEXT,
  forceJoinNeedGate,
  getForceJoinCampaign,
  getForceJoinHistory,
  saveForceJoinCampaign,
  parseChannelLinkInput,
  inspectChannelForForceJoin,
  FRIDAY_MODE_TEXT,
  setChannelEnabled,
  setChannelAdMode,
  nextShiftAfterNow,
  activeShiftAdmins,
  settingSet,
  isOwner,
  upsertUser,
  getUser,
  getRole,
  adminChannels,
  addChannelAdmin,
  shiftPickChannels,
  normalizeChannelKey,
  isUserChannelAdmin,
  canManageOthersShifts,
  getActiveSubLeaderChannel,
  checkReviewAccess,
  dropMessageFromAllReviewBatches,
  dropMessageFromReviewBatch,
  toBoldHtml,
  activeShiftChannelKeys,
  checkInactiveShiftAndCancel,
  restoreMistakenlyCancelledShifts,
  getStatsDashboardText,
  dedupeActiveShifts,
  cancelAllPermanentShifts,
  cancelInvalidShifts,
  filterPeriodShifts,
  acquireLock,
  releaseLock,
  listAdminsByChannel,
  syncAdminsFromGroup,
  syncAllAdminGroups,
  notifyShiftAdmins,
  createReviewBatch,
  adminShiftCard,
  maybeGreetShiftStart,
  pruneReviewBatchToPending,
  clearReviewBatch,
  sendReviewBatch,
  decideMessage,
  finishReviewBatchIfComplete,
  testChannels,
  displayName,
  formatReviewerLabel,
  settingGet,
} from 'lib/dbutil';
import { drainAnnouncePiggyback } from 'lib/announce_drain';
import { drainHolePiggyback, getHoleJob } from 'lib/hole_drain';

async function checkRateLimit(uid) {
  const key = 'rate:' + uid;
  const raw = await settingGet(key, '[]');
  let arr = [];
  try { arr = JSON.parse(raw) || []; } catch (_e) { arr = []; }
  const now = Date.now();
  arr = arr.filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 6) return { ok: false, left: arr.length };
  arr.push(now);
  await settingSet(key, JSON.stringify(arr));
  return { ok: true, left: arr.length };
}

/** آیا الان شیفت فعالی روی حداقل یک کانال هست؟ (برای اجازه ارسال خارج از ساعت کاری) */
async function hasAnyActiveShiftNow() {
  try {
    for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
      const ads = await activeShiftAdmins(ck);
      if (ads && ads.length) return true;
    }
  } catch (_e) {}
  return false;
}

async function roleKb(uid) {
  const r = await getRole(uid);
  let kb =
    r === 'owner'
      ? ownerKeyboard(uid)
      : r === 'subleader'
        ? subLeaderKeyboard()
        : r === 'admin'
          ? adminKeyboard()
          : userKeyboard();
  return sanitizeMarkup(kb);
}


function extractMedia(message) {
  if (!message) return null;
  if (message.photo && message.photo.length) {
    return { type: 'photo', fileId: message.photo[message.photo.length - 1].file_id };
  }
  if (message.video) return { type: 'video', fileId: message.video.file_id };
  if (message.voice) return { type: 'voice', fileId: message.voice.file_id };
  if (message.audio) return { type: 'audio', fileId: message.audio.file_id };
  if (message.document) return { type: 'document', fileId: message.document.file_id };
  if (message.video_note) return { type: 'video_note', fileId: message.video_note.file_id };
  if (message.sticker) return { type: 'sticker', fileId: message.sticker.file_id };
  return null;
}

async function copyOrSendContent(api, toChatId, message) {
  try {
    await api.copyMessage({
      chat_id: toChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
    return;
  } catch (e) {
    console.error('copyMessage', e);
  }
  const media = extractMedia(message);
  const caption = message.caption || message.text || '';
  if (!media) {
    if (caption) await api.sendMessage({ chat_id: toChatId, text: caption });
    return;
  }
  if (media.type === 'photo') await api.sendPhoto({ chat_id: toChatId, photo: media.fileId, caption: caption || undefined });
  else if (media.type === 'video') await api.sendVideo({ chat_id: toChatId, video: media.fileId, caption: caption || undefined });
  else if (media.type === 'voice') {
    await api.sendVoice({ chat_id: toChatId, voice: media.fileId });
    if (caption) await api.sendMessage({ chat_id: toChatId, text: caption });
  } else if (media.type === 'audio') await api.sendAudio({ chat_id: toChatId, audio: media.fileId, caption: caption || undefined });
  else if (media.type === 'document') await api.sendDocument({ chat_id: toChatId, document: media.fileId, caption: caption || undefined });
  else if (media.type === 'video_note') await api.sendVideoNote({ chat_id: toChatId, video_note: media.fileId });
  else if (media.type === 'sticker') await api.sendSticker({ chat_id: toChatId, sticker: media.fileId });
}



async function sendRecentUserMessages(chatId, offset) {
  const PAGE = 50;
  const off = Math.max(0, Number(offset) || 0);
  let rows = [];
  try {
    rows = (await db.select().from(feedback).all()) || [];
  } catch (e) {
    console.error('recent feedback select', e);
    rows = [];
  }
  rows.sort(function (a, b) {
    return Number(b.id) - Number(a.id);
  });
  const slice = rows.slice(off, off + PAGE);
  const statusLabel = {
    open: '🟡 باز',
    replied: '🟢 پاسخ‌داده‌شده',
    closed: '⚫️ بسته',
  };
  let body =
    '📋 پیام‌های اخیر کاربران (انتقاد/پیشنهاد)\n' +
    'از #' +
    (off + 1) +
    ' تا #' +
    (off + slice.length) +
    ' (جدید→قدیم)\n' +
    'کل: ' +
    rows.length +
    '\n────────────\n';
  if (!slice.length) {
    body += 'هنوز پیامی از طریق انتقادات/پیشنهادات ثبت نشده.';
  } else {
    for (const r of slice) {
      const st = String(r.status || 'open');
      const lab = statusLabel[st] || st;
      let line =
        '#' +
        r.id +
        ' ' +
        lab +
        ' | u:' +
        r.userId +
        '\n';
      line += '💬 ' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 90);
      const reply = r.ownerReply ?? r.owner_reply;
      if (reply) {
        line += '\n↳ پاسخ مالک: ' + String(reply).replace(/\s+/g, ' ').slice(0, 90);
      } else if (st === 'closed') {
        line += '\n↳ بسته شد (بدون متن پاسخ)';
      } else {
        line += '\n↳ هنوز پاسخ داده نشده';
      }
      line += '\n────────────\n';
      if ((body + line).length > 3900) {
        body += '…\n';
        break;
      }
      body += line;
    }
  }
  const nextOff = off + PAGE;
  const hasMore = nextOff < rows.length;
  const markup = hasMore
    ? recentUserMsgsInline(nextOff)
    : sanitizeMarkup({
        inline_keyboard: [[{ text: 'پایان لیست', callback_data: 'recent_msgs_end', style: 'primary' }]],
      });
  await api.sendMessage({
    chat_id: chatId,
    text: body,
    reply_markup: markup,
  });
}


export default async function (message) {
  let idemKeyFinal = null;
  try {
    if (!message?.chat) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = (message.text || '').trim();

    // گروه: هیچ ثبت ادمین خودکاری نیست
    if (message.chat.type && message.chat.type !== 'private') return;
    if (!userId) return;

    // —— ضد پردازش دوباره (retry تلگرام / timeout)
    const telegramMsgId = message.message_id;
    const idemKey =
      telegramMsgId != null ? 'idem:tg:' + chatId + ':' + telegramMsgId : null;
    if (idemKey) {
      try {
        const already = await settingGet(idemKey, '');
        if (already === '1' || already === 'pending') {
          console.log('skip duplicate telegram message', idemKey, already);
          return;
        }
        // قفل زودهنگام تا retry موازی insert نزند
        await settingSet(idemKey, 'pending');
        idemKeyFinal = idemKey;
      } catch (e) {
        console.error('idempotency', e);
      }
    }

    await ensureChannelsSeeded();
    try {
      await upsertUser(message.from);
    } catch (e) {
      console.error('upsert', e);
    }

    // همگام‌سازی خودکار حذف شد — فقط از دکمه مالک (برای جلوگیری از تایم‌اوت)

    const u = await getUser(userId);
    if (u?.blocked && !isOwner(userId)) {
      await api.sendMessage({
        chat_id: chatId,
        text:
          '🚫 از ربات مسدود شدی.\n\nامکان استفاده از هیچ‌کدام از خدمات ربات وجود ندارد.',
      });
      return;
    }

    const owner = isOwner(userId);
    const role = await getRole(userId);

    // تحویل خودکار Pending حذف شد: فقط با دکمه «📥 پیام‌های در انتظار» (Batch)

    let state = null;
    try {
      state = await getState(userId);
    } catch (_) {}

    // —— عضویت اجباری: فقط کاربر عادی؛ هر دکمه/استارت ——
    // مالک در حال تنظیم کمپین (state) از گیت رد شود
    const ownerFjSetup =
      owner &&
      state &&
      (state.kind === 'force_join_link' || state.kind === 'force_join_count');
    if (!ownerFjSetup) {
      try {
        const campGate = await forceJoinNeedGate(userId);
        if (campGate) {
          const tname = campGate.title || campGate.username || 'کانال';
          await api.sendMessage({
            chat_id: chatId,
            text: '🔐 برای استفاده از ربات عضو «' + tname + '» شوید، بعد تأیید کنید.',
            reply_markup: sanitizeMarkup(forceJoinInline(campGate)),
          });
          return;
        }
      } catch (e) {
        console.error('forceJoin gate', e);
      }
    }

    if (text === '/start' || text.startsWith('/start ')) {
      try {
        await db
          .update(users)
          .set({
            started: 1,
            username: message.from?.username || null,
            firstName: message.from?.first_name || null,
            lastName: message.from?.last_name || null,
            lastSeen: new Date(),
          })
          .where(eq(users.userId, userId))
          .run();
      } catch (e) {
        console.error('mark started', e);
      }
      try {
        await clearState(userId);
      } catch (_) {}
      try {
        await api.setMyCommands({
          commands: [{ command: 'start', description: 'راه‌اندازی مجدد ربات' }],
        });
      } catch (e) {
        console.error('setMyCommands', e);
      }
      await api.sendMessage({
        chat_id: chatId,
        text: WELCOME_TEXT,
        reply_markup: await roleKb(userId),
      });
      return;
    }

    if (text === '◀️ بازگشت') {
      try {
        await clearState(userId);
      } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: 'منوی اصلی',
        reply_markup: await roleKb(userId),
      });
      return;
    }


    // ——— مالک: دریافت متن/مدیا برای ارسال به کانال (اولویت بالا) ———
    if (owner && state && state.kind === 'post_text') {
      const hasContent =
        !!(text && String(text).trim()) ||
        !!(message.photo || message.video || message.voice || message.audio ||
          message.document || message.video_note || message.sticker);
      if (!hasContent) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'متن یا مدیا بفرستید، یا ◀️ بازگشت.',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      const media = extractMedia(message);
      const chKey = String(state.channelKey || '');
      await setState(userId, 'post_confirm', {
        channelKey: chKey,
        postText: text || message.caption || '',
        media: media,
        fromChatId: chatId,
        fromMsgId: message.message_id,
      });
      const preview =
        media && media.type
          ? '[' + media.type + '] ' + (text || message.caption || '')
          : text || '(مدیا)';
      await api.sendMessage({
        chat_id: chatId,
        text:
          'ارسال به «' +
          ((DEFAULT_CHANNELS[chKey] && DEFAULT_CHANNELS[chKey].title) || chKey) +
          '»:\n\n' +
          String(preview).slice(0, 3500) +
          '\n\nتأیید می‌کنید؟',
        reply_markup: sanitizeMarkup({
          inline_keyboard: [
            [
              { text: '✅ تأیید ارسال', callback_data: 'post_yes', style: 'success' },
              { text: '❌ انصراف', callback_data: 'post_no', style: 'danger' },
            ],
          ],
        }),
      });
      return;
    }


    // ========== USER ==========
    
    // ——— فراخوان کانال (ادمین / ساب‌لیدر با شیفت فعال) ———
    if ((role === 'admin' || role === 'subleader') && text === '📌 فراخوان کانال') {
      try {
        const keys = await activeShiftChannelKeys(userId);
        if (!keys || !keys.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: '⏰ الان در هیچ کانالی شیفت فعال ندارید.\nوقتی شیفت‌تان شروع شد دوباره امتحان کنید.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
        const chans = keys.map(function (k) {
          return { key: k, title: (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k };
        });
        await api.sendMessage({
          chat_id: chatId,
          text: '📌 فراخوان در کدام کانال ارسال و سنجاق شود؟\n(فقط کانال‌هایی که همین الان شیفت دارید)',
          reply_markup: sanitizeMarkup(activeShiftChannelsInline(chans)),
        });
      } catch (e) {
        console.error('callout menu', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + (e && e.message ? e.message : String(e)),
          reply_markup: await roleKb(userId),
        });
      }
      return;
    }

    // گزارش مشکل ادمین → مالک
    if (state?.kind === 'admin_bug' && text && text !== '/start' && text !== '◀️ بازگشت') {
      try {
        const me = await getUser(userId);
        const who = displayName(me, userId);
        const payload =
          '🐞 گزارش ادمین\nاز: ' +
          who +
          ' | ' +
          userId +
          '\n\n' +
          String(text).slice(0, 3500);
        for (const oid of OWNER_IDS || []) {
          try {
            await api.sendMessage({ chat_id: Number(oid), text: payload });
          } catch (_e) {}
        }
        await clearState(userId);
        await api.sendMessage({
          chat_id: chatId,
          text: '✅ گزارش برای مالک ارسال شد. ممنون.',
          reply_markup: await roleKb(userId),
        });
      } catch (e) {
        console.error('admin_bug', e);
        await api.sendMessage({ chat_id: chatId, text: 'ارسال گزارش ناموفق', reply_markup: await roleKb(userId) });
      }
      return;
    }

        // ویرایش پیام توسط ادمین
    if (state && state.kind === 'edit_msg' && text && text !== '◀️ بازگشت') {
      const mid = Number(state.msgId);
      await clearState(userId);
      try {
        const rows = (await db.select().from(messages).where(eq(messages.id, mid)).all()) || [];
        const row = rows[0];
        if (!row || String(row.status) !== 'pending') {
          await api.sendMessage({
            chat_id: chatId,
            text: 'این پیام دیگر در انتظار نیست.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
        // دسترسی
        if (!isOwner(userId)) {
          const acc = await checkReviewAccess(userId, row);
          if (!acc.ok) {
            await api.sendMessage({ chat_id: chatId, text: acc.text || 'دسترسی ندارید', reply_markup: await roleKb(userId) });
            return;
          }
        }
        let newText = String(text).trim().replace(/\s*[.]\s*$/, '').replace(/\s+$/, '') + ' .';
        const conf = DEFAULT_CHANNELS[row.channelKey];
        if (!conf || !conf.chatId) {
          await api.sendMessage({ chat_id: chatId, text: 'کانال پیکربندی نشده', reply_markup: await roleKb(userId) });
          return;
        }
        // رزرو + انتشار
        try {
          await db.update(messages).set({ status: 'publishing' }).where(and(eq(messages.id, mid), eq(messages.status, 'pending'))).run();
        } catch (_e) {}
        let sent = null;
        try {
          sent = await api.sendMessage({
            chat_id: conf.chatId,
            text: toBoldHtml(newText),
            parse_mode: 'HTML',
          });
        } catch (e) {
          try { await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, mid)).run(); } catch (_e) {}
          await api.sendMessage({ chat_id: chatId, text: 'ارسال ناموفق: ' + (e.message || e), reply_markup: await roleKb(userId) });
          return;
        }
        await db.update(messages).set({
          status: 'approved',
          content: newText,
          reviewedBy: Number(userId),
          reviewedAt: new Date(),
        }).where(eq(messages.id, mid)).run();
        try { await dropMessageFromReviewBatch(userId, mid); } catch (_e) {}
        try { dropMessageFromAllReviewBatches(mid).catch(function(){}); } catch (_e) {}
        const link = channelMessageLink(conf.chatId, sent && sent.message_id, row.channelKey);
        await api.sendMessage({
          chat_id: chatId,
          text: '✅ ویرایش و منتشر شد #' + mid + (link ? '\n' + link : ''),
          reply_markup: await roleKb(userId),
        });
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: '✅ پیام شما پس از ویرایش تأیید و منتشر شد.' + (link ? '\n' + link : ''),
          });
        } catch (_e) {}
      } catch (e) {
        console.error('edit_msg', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در ویرایش', reply_markup: await roleKb(userId) });
      }
      return;
    }


    if (text === '📝 ارسال پیام') {
      if (!(await isBotOn()) && !owner) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      if (!owner && (await isFridayMode())) {
        await api.sendMessage({
          chat_id: chatId,
          text: FRIDAY_MODE_TEXT,
          reply_markup: await roleKb(userId),
        });
        return;
      }
      if (!owner && (await isQueueBusyMode())) {
        await api.sendMessage({
          chat_id: chatId,
          text: QUEUE_BUSY_TEXT,
          reply_markup: await roleKb(userId),
        });
        return;
      }
      if (!owner && !isWorkHours()) {
        // اگر مالک شیفت خارج از ساعت کاری داده و الان فعال است → اجازه بده
        const anyShift = await hasAnyActiveShiftNow();
        if (!anyShift) {
          await api.sendMessage({
            chat_id: chatId,
            text: workHoursClosedText(),
            reply_markup: await roleKb(userId),
          });
          return;
        }
      }
      await setState(userId, 'user_send');
      await api.sendMessage({
        chat_id: chatId,
        text: RULES_TEXT + '\n\nمی‌توانید چند پیام پشت‌سرهم بفرستید.\nحداکثر ۶ پیام در ۱۰ دقیقه.',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (text === '📊 وضعیت پیام من') {
      const rows =
        (await db
          .select()
          .from(messages)
          .where(eq(messages.userId, userId))
          .all()) || [];
      const list = rows.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 15);
      if (!list.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیامی ثبت نکرده‌اید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      const map = { pending: '🟡 در انتظار', approved: '🟢 تأیید', rejected: '🔴 رد شده' };
      let body = '📊 پیام‌های شما (' + list.length + ' مورد اخیر)\n\n';
      for (const row of list) {
        const short = (row.content || '').replace(/\n/g, ' ').slice(0, 70);
        const when = formatTsJalali(row.submittedAt);
        body +=
          '#' +
          row.id +
          ' | ' +
          (map[row.status] || row.status) +
          '\n' +
          short +
          (short.length >= 70 ? '…' : '') +
          '\n🕐 ' +
          when +
          '\n────────────\n';
      }
      await api.sendMessage({
        chat_id: chatId,
        text: body,
        reply_markup: await roleKb(userId),
      });
      return;
    }

    
    if (text === '💬 انتقادات، پیشنهادات، گزارش مشکل') {
      await setState(userId, 'feedback');
      await api.sendMessage({
        chat_id: chatId,
        text: FEEDBACK_HINT,
        reply_markup: sanitizeMarkup(backKeyboard()),
        parse_mode: 'Markdown',
      });
      return;
    }


    if (state?.kind === 'feedback' && text) {
      if (/^(صدام بزن|این کاربر|تو زندگی بعدی)/.test(text)) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            '⚠️ این دکمه فقط برای انتقاد/پیشنهاد به مالک است.\n\nبرای کانال از «📝 ارسال پیام» استفاده کنید.',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '✅ ثبت شد. مالک از «📬 پیام کاربران» می‌بیند.',
        reply_markup: await roleKb(userId),
      });
      /* فیدبک فقط از پنل «پیام کاربران» */
      return;
    }

    if (state?.kind === 'user_send' && text) {
      try {
        // درِ ساعت کاری اینجا برداشته شد؛ بعد از تشخیص کانال، شیفت فعال چک می‌شود
        const [_fri, _botOn, _qBusy] = await Promise.all([
          isFridayMode(),
          isBotOn(),
          isQueueBusyMode(),
        ]);
        if (!owner && _fri) {
          await clearState(userId);
          await api.sendMessage({
            chat_id: chatId,
            text: FRIDAY_MODE_TEXT,
            reply_markup: await roleKb(userId),
          });
          return;
        }
        if (!owner && _qBusy) {
          await clearState(userId);
          await api.sendMessage({
            chat_id: chatId,
            text: QUEUE_BUSY_TEXT,
            reply_markup: await roleKb(userId),
          });
          return;
        }
        if (!_botOn) {
          await clearState(userId);
          await api.sendMessage({
            chat_id: chatId,
            text: BOT_DISABLED_TEXT,
            reply_markup: await roleKb(userId),
          });
          return;
        }
        const v = validateAndFix(message);
        if (!v.ok) {
          await api.sendMessage({
            chat_id: chatId,
            text: v.error,
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        const ch = await getChannel(v.channelKey);
        if (!ch || Number(ch.enabled) === 0) {
          await api.sendMessage({
            chat_id: chatId,
            text: '🔴 این کانال غیرفعال است.',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        // —— کانال خاموش / حالت تب
        try {
          const [_chOpen, _adMode] = await Promise.all([
            isChannelOpen(v.channelKey),
            isChannelAdMode(v.channelKey),
          ]);
          if (!_chOpen) {
            await api.sendMessage({
              chat_id: chatId,
              text: '🔴 دریافت پیام برای «' + ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) + '» فعلاً غیرفعال است.\nبعداً دوباره تلاش کنید.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
          if (_adMode) {
            await api.sendMessage({
              chat_id: chatId,
              text:
                '📢 «' +
                ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
                '» الان درگیر تبلیغات یا تبادل است.\n' +
                'پیام‌های جدید موقتاً پذیرفته نمی‌شوند.\nکمی بعد دوباره سر بزن 🌸',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
        } catch (e) {
          console.error('ch flags', e);
        }

        // —— شیفت فعال برای کانال؟ (معیار اصلی؛ خارج از ساعت کاری هم اگر شیفت باشد مجاز است)
        if (!owner) {
          let activeAds = [];
          try {
            activeAds = await activeShiftAdmins(v.channelKey);
          } catch (e) {
            console.error('shift gate', e);
            activeAds = [];
          }
          if (!activeAds || !activeAds.length) {
            // بدون شیفت فعال: اگر خارج ساعت کاری بود همان پیام ساعت کاری، وگرنه پیام نبود شیفت
            if (!isWorkHours()) {
              await api.sendMessage({
                chat_id: chatId,
                text: workHoursClosedText(),
                reply_markup: sanitizeMarkup(backKeyboard()),
              });
              return;
            }
            try {
              const now = tehranNow();
              if (ch.workStart && ch.workEnd && !inRange(now.hm, ch.workStart, ch.workEnd)) {
                await api.sendMessage({
                  chat_id: chatId,
                  text:
                    '⏰ ساعت کاری «' +
                    ch.title +
                    '» از ' +
                    ch.workStart +
                    ' تا ' +
                    ch.workEnd +
                    ' است.',
                  reply_markup: sanitizeMarkup(backKeyboard()),
                });
                return;
              }
            } catch (_) {}
            let t =
              '⏰ الان شیفت فعالی برای «' +
              ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
              '» نیست؛ پیام ثبت نمی‌شود.\n';
            try {
              const nxt = await nextShiftAfterNow(v.channelKey);
              if (nxt && nxt.current) {
                t += 'در حال انتقال شیفت… چند لحظه بعد دوباره بفرستید.';
              } else if (nxt && nxt.start) {
                t += 'نزدیک‌ترین شیفت بعدی از ساعت ' + toFaDigits(nxt.start) + ' تا ' + toFaDigits(nxt.end) + ' است.';
              } else {
                t += 'هنوز شیفتی برای ادامه امروز ثبت نشده. لطفاً وقتی شیفت فعال است ارسال کنید.';
              }
            } catch (_e) {
              t += 'لطفاً وقتی شیفت فعال است دوباره تلاش کنید.';
            }
            await api.sendMessage({
              chat_id: chatId,
              text: t,
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
        }
        const bodyKey = exactBodyKey(v.content);
        if (!bodyKey) {
          await api.sendMessage({
            chat_id: chatId,
            text: '⚠️ متن پیام نامعتبر است.',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        {
          let dup = null;
          let dupIsPending = false;
          let queuePos = 0;
          try {
            // ایندکس سریع در settings
            const bIdx = bodyIndexSettingKey(v.channelKey, bodyKey);
            // قفل ضد ثبت موازی همان بدنه
            let bodyLock = null;
            try {
              bodyLock = await acquireLock('lock:' + bIdx, 6000);
            } catch (_e) {}
            if (!bodyLock) {
              await api.sendMessage({
                chat_id: chatId,
                text: '⏳ همین متن در حال ثبت است. چند ثانیه صبر کنید.',
                reply_markup: sanitizeMarkup(backKeyboard()),
              });
              return;
            }
            // برای finally آزادسازی
            globalThis.__bodyLock = { key: 'lock:' + bIdx, token: bodyLock };
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
              // همهٔ pending کانال (سبک)
              const pendingRows =
                (await db
                  .select({
                    id: messages.id,
                    status: messages.status,
                    content: messages.content,
                  })
                  .from(messages)
                  .where(
                    and(eq(messages.channelKey, v.channelKey), eq(messages.status, 'pending'))
                  )
                  .all()) || [];
              for (const row of pendingRows) {
                const other = exactBodyKey(row.content);
                if (other && other === bodyKey) {
                  dup = row;
                  dupIsPending = true;
                  const pendingSorted = pendingRows
                    .slice()
                    .sort(function (a, b) {
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
                  .where(
                    and(eq(messages.channelKey, v.channelKey), eq(messages.status, 'approved'))
                  )
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
          } catch (e) {
            console.error('dup check', e);
            // fail-closed: در خطای چک تکراری، ثبت نکن
            await api.sendMessage({
              chat_id: chatId,
              text: '⏳ بررسی تکراری بودن پیام طول کشید. چند ثانیه بعد دوباره بفرستید.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
          if (dup) {
            let msgText = '';
            if (dupIsPending) {
              msgText =
                '⚠️ این پیام قبلاً ارسال شده و اکنون در صف تأیید است.\n' +
                'تعداد پیام‌های قبل از آن: ' + queuePos + '\n' +
                'شناسه: #' + dup.id;
            } else {
              msgText =
                '⚠️ این پیام قبلاً ارسال شده و تکراری است.\n' +
                'شناسه: #' + dup.id;
              try {
                // تلاش برای ساخت لینک از settings یا کانال
                const conf = DEFAULT_CHANNELS[v.channelKey];
                // message_id کانال ممکن است در settings ذخیره شده باشد (chmsg:key:mid -> id)
                // فعلاً لینک پایه کانال را بفرست
                const base = channelPublicBase(v.channelKey);
                if (base) msgText += '\nلینک کانال: ' + base;
              } catch (_) {}
            }
            await api.sendMessage({
              chat_id: chatId,
              text: msgText + '\n\nپیام دیگری بفرستید یا ◀️ بازگشت.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            try {
              const bl = globalThis.__bodyLock;
              if (bl) {
                await releaseLock(bl.key, bl.token);
                globalThis.__bodyLock = null;
              }
            } catch (_e) {}
            return;
          }
        }

        // —— محدودیت نرخ
        if (!owner) {
          const rl = await checkRateLimit(userId);
          if (!rl.ok) {
            await api.sendMessage({
              chat_id: chatId,
              text:
                '⏳ محدودیت ارسال: حداکثر ۶ پیام در ۱۰ دقیقه.\nلطفاً کمی صبر کنید و دوباره بفرستید.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
        }

        // —— قفل کوتاه ضد double-submit موازی
        const sendLockKey = 'lock:send:' + userId;
        try {
          const lockVal = await settingGet(sendLockKey, '');
          const lockTs = Number(lockVal) || 0;
          if (lockTs && Date.now() - lockTs < 4000) {
            await api.sendMessage({
              chat_id: chatId,
              text: '⏳ درخواست قبلی هنوز در حال ثبت است. چند ثانیه صبر کنید.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
          await settingSet(sendLockKey, String(Date.now()));
        } catch (_e) {}

        let msgId = null;
        try {
          await db
            .insert(messages)
            .values({
              userId,
              content: v.content,
              channelKey: v.channelKey,
              status: 'pending',
              submittedAt: new Date(),
            })
            .run();
          const lastRows =
            (await db
              .select({ id: messages.id })
              .from(messages)
              .where(eq(messages.userId, userId))
              .orderBy(desc(messages.id))
              .limit(1)
              .all()) || [];
          if (lastRows[0]) msgId = lastRows[0].id;
          if (msgId != null && bodyKey) {
            try {
              await settingSet(bodyIndexSettingKey(v.channelKey, bodyKey), String(msgId) + '|pending');
            } catch (_e) {}
          }
        } finally {
          try {
            await settingSet(sendLockKey, '0');
          } catch (_e) {}
          try {
            const bl = globalThis.__bodyLock;
            if (bl) {
              await releaseLock(bl.key, bl.token);
              globalThis.__bodyLock = null;
            }
          } catch (_e) {}
        }

        // keep user_send state for continuous
        let ahead = 0;
        try {
          if (msgId != null) {
            const pendIds =
              (await db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(eq(messages.channelKey, v.channelKey), eq(messages.status, 'pending'))
                )
                .all()) || [];
            ahead = pendIds.filter(function (x) {
              return Number(x.id) < Number(msgId);
            }).length;
          }
        } catch (_e) {}
        let note =
          '✅ ثبت شد.\n🆔 #' + (msgId != null ? msgId : '?') + '\n🟡 در انتظار بررسی ادمین';
        if (ahead > 0) {
          note += '\n📋 حدود ' + toFaDigits(String(ahead)) + ' پیام جلوتر از شما در صف «' + ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || '') + '» است.';
          if (ahead % 30 === 0) {
            note += '\n⏳ هر ۳۰ پیام یک‌بار وضعیت صف به شما یادآوری می‌شود — الان دقیقاً روی مرز ' + toFaDigits(String(ahead)) + ' هستید.';
          } else if (ahead <= 30) {
            note += '\n🔔 کمتر از ۳۰ پیام تا نوبت بررسی شما مانده.';
          }
        } else {
          note += '\n🔔 پیام شما نزدیک ابتدای صف است.';
        }
        note += '\n\nپیام بعدی را بفرستید یا ◀️ بازگشت';
        if (v.autoFixed) note += '\n\nℹ️ متن کمی اصلاح شد و ارسال گردید.';
        await api.sendMessage({
          chat_id: chatId,
          text: note,
          reply_markup: sanitizeMarkup(backKeyboard()),
        });

        // سوراخ پیام: فقط بعد از موفقیت ثبت کاربر
        try {
          await drainHolePiggyback();
        } catch (_e) {}

        // اگر صف خیلی سنگین شد و ادمین شیفت هیچ فعالیتی نداشت → لغو شیفت
        try {
          await checkInactiveShiftAndCancel(v.channelKey);
        } catch (_e) {
          console.error('inactive shift check', _e);
        }

        // batch only
        return;
      } catch (e) {
        console.error('user_send', e);
        await api.sendMessage({
          chat_id: chatId,
          text: '⚠️ خطا در ارسال. دوباره تلاش کنید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
    }

    // ========== PENDING ==========

    if ((role === 'admin' || role === 'subleader' || owner) && state?.kind === 'reject_custom' && text) {
      const reason = String(text).trim().slice(0, 22);
      const msgId = Number(state.msgId);
      await clearState(userId);
      if (!msgId) {
        await api.sendMessage({ chat_id: chatId, text: 'خطا', reply_markup: await roleKb(userId) });
        return;
      }
      // شیفت + کانال + عضویت در Batch + pending بودن دوباره از DB بررسی می‌شود
      const dec = await decideMessage(userId, msgId, 'reject', reason);
      if (!dec.ok) {
        await api.sendMessage({ chat_id: chatId, text: dec.text, reply_markup: await roleKb(userId) });
        return;
      }
      const row = dec.row;
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '❌ پیام #' + msgId + ' رد شد.\nدلیل: ' + reason,
        });
      } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: 'رد شد #' + msgId + ' — ' + reason,
        reply_markup: await roleKb(userId),
      });
      const fin = await finishReviewBatchIfComplete(userId, msgId);
      if (fin.inBatch && fin.complete) {
        if (fin.hasMore) {
          await api.sendMessage({
            chat_id: chatId,
            text: '✅ همه‌ی پیام‌های Batch شماره ' + fin.batch.batchNumber + ' بررسی شدند.',
            reply_markup: sanitizeMarkup(reviewNextInline(fin.batch.batchNumber)),
          });
        } else {
          await api.sendMessage({
            chat_id: chatId,
            text: '📭 پیام Pending دیگری برای شیفت شما وجود ندارد.',
          });
        }
      }
      return;
    }

    if ((role === 'admin' || role === 'subleader' || owner) && text === '📥 پیام‌های در انتظار') {
      // مالک: ابتدا کانال را انتخاب کند
      if (owner) {
        const rows = Object.values(DEFAULT_CHANNELS).map(function (c) {
          return [{
            text: String(c.title || c.key || 'کانال'),
            callback_data: 'own_pend:' + c.key,
            style: 'primary',
          }];
        });
        rows.push([{ text: 'همه کانال‌ها', callback_data: 'own_pend:all', style: 'success' }]);
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیام‌های در انتظار کدام کانال را می‌خواهید ببینید؟',
          reply_markup: sanitizeMarkup({ inline_keyboard: rows }),
        });
        return;
      }
      // ادمین/ساب‌لیدر: ساخت/بازیابی Batch
      // اگر شیفت‌ها اشتباه لغو شده بودند، همان‌هایی که هنوز در بازه ساعت‌شان هستند برگردان
      try {
              } catch (_e) {}
      const res = await createReviewBatch(userId);
      if (res.status === 'no_shift') {
        await api.sendMessage({
          chat_id: chatId,
          text: '⏰ الان داخل بازهٔ شیفت ثبت‌شده نیستید.\n\nاگر تازه شیفت برداشتید، فقط وقتی ساعت شیفت‌تان شروع شود می‌توانید پیام‌های در انتظار را بگیرید.\nاز «⏰ شیفت من» ساعت ثبت‌شده را چک کنید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      if (res.status === 'busy') {
        await api.sendMessage({
          chat_id: chatId,
          text: '⏳ درخواست قبلی شما در حال پردازش است. چند ثانیه بعد دوباره تلاش کنید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      if (res.status === 'empty') {
        await api.sendMessage({
          chat_id: chatId,
          text: '📭 در حال حاضر پیام در انتظاری وجود ندارد.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      if (res.status === 'incomplete') {
        await sendReviewBatch(chatId, res.batch, res.messages, { resumed: true });
        return;
      }
      await sendReviewBatch(chatId, res.batch, res.messages, { resumed: false });
      return;
    }

    
    // ========== ADMIN: performance ==========
    
    if ((role === 'admin' || role === 'subleader' || owner) && text === '📊 عملکرد من') {
      try {
        const now = tehranNow();
        let shiftHead = '';
        try {
          const card = await adminShiftCard(userId);
          shiftHead = '🧭 وضعیت الان\n';
          if (card.active && card.active.length) {
            for (const a of card.active) {
              shiftHead +=
                '• «' +
                a.title +
                '» ' +
                a.startHm +
                '–' +
                a.endHm +
                ' · باقی‌مانده ~' +
                a.minutesLeft +
                ' دقیقه\n';
            }
            shiftHead += '📥 صف قابل‌بررسی: ' + (card.pendingTotal || 0) + ' پیام\n';
            shiftHead +=
              'امروز شما: 🟢' +
              (card.todayApproved || 0) +
              '  🔴' +
              (card.todayRejected || 0) +
              '\n';
          } else {
            shiftHead += 'الان شیفت فعالی ندارید.\n';
          }
          shiftHead += '────────────\n';
        } catch (_e) {}

        // فقط پیام‌های بررسی‌شده توسط همین کاربر (نه کل جدول)
        let mine = [];
        try {
          mine =
            (await db
              .select({
                id: messages.id,
                status: messages.status,
                channelKey: messages.channelKey,
                reviewedAt: messages.reviewedAt,
                reviewedBy: messages.reviewedBy,
              })
              .from(messages)
              .where(eq(messages.reviewedBy, Number(userId)))
              .all()) || [];
        } catch (e1) {
          console.error('perf mine', e1);
          try {
            const light =
              (await db
                .select({
                  id: messages.id,
                  status: messages.status,
                  channelKey: messages.channelKey,
                  reviewedAt: messages.reviewedAt,
                  reviewedBy: messages.reviewedBy,
                })
                .from(messages)
                .all()) || [];
            mine = light.filter(function (x) {
              return Number(x.reviewedBy ?? x.reviewed_by) === Number(userId);
            });
          } catch (e2) {
            console.error('perf mine fallback', e2);
            mine = [];
          }
        }

        function isToday(row) {
          const ra = row.reviewedAt ?? row.reviewed_at;
          if (!ra) return false;
          try {
            const dt = ra instanceof Date ? ra : new Date(ra);
            if (isNaN(dt.getTime())) return false;
            const fmt = new Intl.DateTimeFormat('en-GB', {
              timeZone: 'Asia/Tehran',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            });
            const parts = Object.fromEntries(
              fmt.formatToParts(dt).map(function (p) {
                return [p.type, p.value];
              })
            );
            return parts.year + '-' + parts.month + '-' + parts.day === now.date;
          } catch (_e) {
            return false;
          }
        }

        const mineToday = mine.filter(isToday);
        const keys = await adminChannels(userId);
        const sl = await getActiveSubLeaderChannel(userId);
        const chans = [...new Set([...(keys || []), ...(sl ? [sl] : [])])].map(function (k) {
          return normalizeChannelKey(k);
        }).filter(Boolean);

        const apAll = mine.filter(function (x) { return String(x.status) === 'approved'; }).length;
        const rjAll = mine.filter(function (x) { return String(x.status) === 'rejected'; }).length;
        const apTd = mineToday.filter(function (x) { return String(x.status) === 'approved'; }).length;
        const rjTd = mineToday.filter(function (x) { return String(x.status) === 'rejected'; }).length;

        let body = shiftHead + '📊 عملکرد شما\n';
        body += '📅 ' + now.date + ' — ' + now.hm + '\n';
        body +=
          'کانال‌ها: ' +
          (chans
            .map(function (k) {
              return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k;
            })
            .join('، ') || '—') +
          '\n\n';
        body += '—— کلی ——\n';
        body += '🟢 تأیید کل: ' + apAll + ' | امروز: ' + apTd + '\n';
        body += '🔴 رد کل: ' + rjAll + ' | امروز: ' + rjTd + '\n';
        body += 'Σ بررسی کل: ' + mine.length + ' | امروز: ' + mineToday.length + '\n';

        for (const ck of chans.length ? chans : []) {
          const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
          const chMine = mine.filter(function (x) {
            return normalizeChannelKey(x.channelKey ?? x.channel_key) === ck;
          });
          const chToday = chMine.filter(isToday);
          body += '\n—— «' + title + '» ——\n';
          body +=
            '🟢' +
            chMine.filter(function (x) { return String(x.status) === 'approved'; }).length +
            ' 🔴' +
            chMine.filter(function (x) { return String(x.status) === 'rejected'; }).length;
          body +=
            ' | امروز 🟢' +
            chToday.filter(function (x) { return String(x.status) === 'approved'; }).length +
            ' 🔴' +
            chToday.filter(function (x) { return String(x.status) === 'rejected'; }).length +
            '\n';
        }

        // ۷ روز اخیر
        try {
          const dayCounts = {};
          for (let i = 0; i < 7; i++) dayCounts[i] = { a: 0, r: 0 };
          for (const msg of mine) {
            const ra = msg.reviewedAt ?? msg.reviewed_at;
            if (!ra) continue;
            let dt;
            try {
              dt = ra instanceof Date ? ra : new Date(ra);
              if (isNaN(dt.getTime())) continue;
            } catch (_e) {
              continue;
            }
            const diff = Math.floor((Date.now() - dt.getTime()) / 86400000);
            if (diff < 0 || diff > 6) continue;
            const st = String(msg.status || '');
            if (st === 'approved') dayCounts[diff].a += 1;
            else if (st === 'rejected') dayCounts[diff].r += 1;
          }
          body += '\n—— ۷ روز اخیر ——\n';
          for (let i = 0; i < 7; i++) {
            body +=
              (i === 0 ? 'امروز' : i + ' روز پیش') +
              ': 🟢' +
              dayCounts[i].a +
              ' 🔴' +
              dayCounts[i].r +
              '\n';
          }
        } catch (_e) {}

        await api.sendMessage({
          chat_id: chatId,
          text: body.slice(0, 4000),
          reply_markup: await roleKb(userId),
        });
      } catch (e) {
        console.error('perf me', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در آمار عملکرد: ' + (e && e.message ? e.message : 'نامشخص'),
          reply_markup: await roleKb(userId),
        });
      }
      return;
    }

    if ((role === 'admin' || role === 'subleader') && text === '🆘 درخواست کمک') {
      try {
        const card = await adminShiftCard(userId);
        if (!card.active || !card.active.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'الان شیفت فعالی ندارید.\nدرخواست کمک فقط داخل شیفت معنا دارد.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
        const a = card.active[0];
        const ck = a.channelKey;
        const title = a.title;
        // جلوگیری از اسپم: یک درخواست باز در هر کانال/دوره
        const pdate = periodDateStr(tehranNow());
        const flagKey = 'help_req:' + ck + ':' + pdate + ':' + userId;
        if ((await settingGet(flagKey, '')) === '1') {
          await api.sendMessage({
            chat_id: chatId,
            text: 'درخواست کمک شما برای این شیفت قبلاً ارسال شده.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
        await settingSet(flagKey, '1');
        const me = await getUser(userId);
        const who = displayName(me, userId);
        const textH =
          '🆘 درخواست کمک\n' +
          'از: ' + who + '\n' +
          'کانال: «' + title + '»\n' +
          'شیفت: ' + a.startHm + '–' + a.endHm + '\n' +
          'صف تقریبی: ' + (card.pendingTotal || 0) + ' پیام\n\n' +
          'اگر می‌توانید وارد شیفت شوید یا پیام‌های در انتظار را بررسی کنید.';
        // فقط ادمین‌ها و ساب‌لیدر همان کانال (نه همه مالک‌ها)
        const targets = new Set();
        const ckN = normalizeChannelKey(ck) || String(ck);
        try {
          const rows = (await db.select().from(channelAdmins).all()) || [];
          for (const r of rows) {
            const rck = normalizeChannelKey(r.channelKey ?? r.channel_key);
            if (String(rck) === String(ckN)) {
              const uid = Number(r.userId ?? r.user_id);
              if (uid && uid !== Number(userId)) targets.add(uid);
            }
          }
        } catch (_e) {}
        try {
          const slRows = (await listActiveSubLeaders()) || [];
          for (const r of slRows) {
            const rck = normalizeChannelKey(r.channelKey ?? r.channel_key);
            if (String(rck) === String(ckN)) {
              const uid = Number(r.userId ?? r.user_id);
              if (uid && uid !== Number(userId)) targets.add(uid);
            }
          }
        } catch (_e) {}
        let sent = 0;
        for (const tid of targets) {
          try {
            await api.sendMessage({
              chat_id: tid,
              text: textH,
              reply_markup: sanitizeMarkup(adminHelpConfirmInline(ck, userId)),
            });
            sent += 1;
          } catch (_e) {}
        }
        await api.sendMessage({
          chat_id: chatId,
          text: '✅ درخواست کمک برای «' + title + '» به ' + sent + ' نفر ارسال شد.',
          reply_markup: await roleKb(userId),
        });
      } catch (e) {
        console.error('help req', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در ارسال درخواست کمک', reply_markup: await roleKb(userId) });
      }
      return;
    }

    if ((role === 'admin' || role === 'subleader') && text === '🐞 گزارش مشکل') {
      await setState(userId, 'admin_bug');
      await api.sendMessage({
        chat_id: chatId,
        text: 'مشکل را کوتاه بنویسید.\n(مستقیم برای مالک ارسال می‌شود)\n\nبرای انصراف: /start',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    // ========== ADMIN/OWNER: shifts ==========
    if ((role === 'admin' || role === 'subleader' || owner) && text === '⏰ شیفت من') {
      let keys = owner ? Object.keys(DEFAULT_CHANNELS) : await shiftPickChannels(userId);
      keys = (keys || []).map(function (k) { return normalizeChannelKey(k); }).filter(Boolean);
      // یکتا
      keys = keys.filter(function (k, i, a) { return a.indexOf(k) === i; });
      if (!keys.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'شما ادمین هیچ کانالی نیستید.\nاگر اخیراً اضافه شده‌اید از مالک بخواهید دوباره اضافه‌تان کند.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      const chans = keys.map((k) => ({
        key: k,
        title: (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k,
      }));
      // کلیدهای مجاز را در state نگه دار تا خواندن دوباره DB خطا ندهد
      await setState(userId, 'pick_shift_ch', { allowedKeys: keys });
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال شیفت را انتخاب کنید:',
        reply_markup: sanitizeMarkup(shiftChannelPickKeyboard(chans)),
      });
      return;
    }

    if (state?.kind === 'pick_shift_ch' && text.startsWith('شیفت: ')) {
      const title = String(text.replace(/^شیفت:\s*/, '').replace(/^شیفت: /, '')).trim();
      let entry = Object.values(DEFAULT_CHANNELS).find((c) => c.title === title);
      if (!entry) {
        entry = Object.values(DEFAULT_CHANNELS).find(function (c) {
          return title.indexOf(c.title) >= 0 || String(c.title).indexOf(title) >= 0;
        });
      }
      if (!entry) {
        const nk = normalizeChannelKey(title);
        if (nk && DEFAULT_CHANNELS[nk]) entry = DEFAULT_CHANNELS[nk];
      }
      if (!entry) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'کانال نامعتبر. دوباره «⏰ شیفت من» را بزنید.',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      if (!isOwner(userId)) {
        let allowed = [];
        // اول از state (قابل اعتمادتر)
        if (state.allowedKeys && Array.isArray(state.allowedKeys) && state.allowedKeys.length) {
          allowed = state.allowedKeys.map(function (k) { return normalizeChannelKey(k); });
        }
        if (!allowed.length) {
          try { allowed = (await shiftPickChannels(userId)).map(function (k) { return normalizeChannelKey(k); }); } catch (_e) { allowed = []; }
        }
        const ck = normalizeChannelKey(entry.key);
        let ok = allowed.some(function (x) { return String(x) === String(ck); });
        if (!ok) {
          try { ok = await isUserChannelAdmin(userId, ck); } catch (_e) { ok = false; }
        }
        if (!ok) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'اجازه انتخاب شیفت برای این کانال را ندارید.\nدوباره «⏰ شیفت من» را بزنید.',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          '⏰ کانال «' +
          entry.title +
          '»\nشیفت فقط برای همین دوره است (یک‌بارمصرف، فردا تکرار نمی‌شود).\nحداکثر ۳ شیفت.\nساعت را انتخاب کنید:',
        reply_markup: sanitizeMarkup(shiftModePickInline(entry.key)),
      });
      return;
    }

    // دکمه اختصاص شیفت از پنل اصلی حذف شد — فقط داخل شیفت‌ها

    
    if (owner && text === '📌 تخصیص شیفت روزانه') {
      await setState(userId, 'own_assign', { mode: 'daily' });
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال را انتخاب کنید:',
        reply_markup: shiftChannelPickKeyboard(
          Object.values(DEFAULT_CHANNELS).map((c) => ({ key: c.key, title: c.title }))
        ),
      });
      return;
    }
    if (false && owner && text === '📌 تخصیص شیفت دائمی') {
      await setState(userId, 'own_assign', { mode: 'perm' });
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال را انتخاب کنید:',
        reply_markup: shiftChannelPickKeyboard(
          Object.values(DEFAULT_CHANNELS).map((c) => ({ key: c.key, title: c.title }))
        ),
      });
      return;
    }

    if (owner && text === '⏰ شیفت‌ها') {
      try {
try {
        try { await cancelInvalidShifts(); } catch (_e) {}
        for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
          try { await dedupeActiveShifts(ck); } catch (_e) {}
        }
      } catch (_e) {}
      
        const now = tehranNow();
        const pdate = periodDateStr(now);
        let all = [];
        try {
          all = (await db.select().from(shifts).all()) || [];
        } catch (e) {
          console.error('shifts all', e);
        }
        const today = all.filter(function (s) {
          if (String(s.status) !== 'active') return false;
          if (String(s.startHm) === String(s.endHm)) return false;
          const sd = String(s.shiftDate || '');
          if (sd === 'perm' || sd === 'permanent') return false;
          return sd === pdate || sd === now.date;
        });
        let t = '⏰ شیفت‌های دوره فعلی\n📅 ' + pdate + ' (۲۴ ساعته — نمایش همه شیفت‌های فعال امروز)\n';
        if (!today.length) {
          t += '\nهنوز شیفتی ثبت نشده.\n';
        } else {
          const order = Object.keys(DEFAULT_CHANNELS);
          for (const ck of order) {
            const group = sortShiftsByPeriod(
              today.filter(function (s) {
                return String(s.channelKey || s.channel_key) === ck;
              })
            );
            if (!group.length) continue;
            const title =
              (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
            t += '\n—— «' + title + '» ——\n';
            for (const s of group) {
              let name = String(s.adminId);
              try {
                name = displayName(await getUser(s.adminId), s.adminId);
              } catch (_e) {}
              t +=
                '▫️ ' +
                String(s.startHm).slice(0, 5) +
                '–' +
                String(s.endHm).slice(0, 5) +
                '  ·  ' +
                name +
                '\n';
            }
          }
        }
        t += '\nاز دکمه‌های زیر:\n• تخصیص این دوره\n• لیست و لغو\n• لغو همه شیفت‌های دوره';
        await api.sendMessage({
          chat_id: chatId,
          text: t,
          reply_markup: sanitizeMarkup(ownerShiftMenuInline()),
        });
      } catch (e) {
        console.error('owner shifts', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در شیفت‌ها: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }


    if (owner && state?.kind === 'own_assign' && text.startsWith('شیفت: ')) {
      const title = text.replace('شیفت: ', '');
      const entry = Object.values(DEFAULT_CHANNELS).find((c) => c.title === title);
      if (!entry) {
        await api.sendMessage({ chat_id: chatId, text: 'کانال نامعتبر', reply_markup: ownerKeyboard() });
        return;
      }
      await setState(userId, 'own_assign_admin', { mode: state.mode, channelKey: entry.key });
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی ادمین را بفرستید:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }
    if (owner && state?.kind === 'own_assign_admin' && text) {
      const adminId = Number(String(text).replace(/\D/g, ''));
      if (!adminId) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی نامعتبر', reply_markup: sanitizeMarkup(backKeyboard()) });
        return;
      }
      const mode = 'daily';
      const channelKey = state.channelKey;
      await setState(userId, 'own_assign_slot', { mode, channelKey, adminId });
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const dayShifts =
        (await db
          .select()
          .from(shifts)
          .where(eq(shifts.channelKey, channelKey))
          .all()) || [];
      const takenMap = {};
      for (const s of dayShifts) {
        if (s.status !== 'active') continue;
        {
          const _sd = String(s.shiftDate || '');
          if (_sd === 'perm' || _sd === 'permanent') continue;
          if (!(_sd === pdate || _sd === now.date)) continue;
        }
        takenMap[s.startHm] = s.adminId;
      }
      const ownerSlots = buildOwnerShiftSlots(now);
      await api.sendMessage({
        chat_id: chatId,
        text:
          'ساعت را انتخاب کنید (۲۴ ساعت کامل — بدون محدودیت ساعت کاری):\n' +
          'فقط همین دوره ثبت می‌شود.',
        reply_markup: sanitizeMarkup(shiftSlotsInline(channelKey, takenMap, new Set(), ownerSlots, true)),
      });
      // reuse shift_pick won't know admin - use special callbacks
      // store and intercept - for simplicity owner uses same shift_pick but we need different insert
      return;
    }

    if (owner && text === '👥 ادمین‌ها') {
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال ادمین‌ها را انتخاب کنید:',
        reply_markup: {
          keyboard: [
            [{ text: 'ادمین‌های صدام بزن' }],
            [{ text: 'ادمین‌های این کاربر' }],
            [{ text: 'ادمین‌های تو زندگی بعدی' }],
                        [{ text: '◀️ بازگشت' }],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }

    if (owner && text.startsWith('ادمین‌های ')) {
      try {
        const title = text.replace('ادمین‌های ', '').trim();
        const entry = Object.values(DEFAULT_CHANNELS).find((c) => c.title === title);
        if (!entry) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'کانال پیدا نشد: ' + title,
            reply_markup: ownerKeyboard(),
          });
          return;
        }
        try {
          await syncAdminsFromGroup(entry.key);
        } catch (e) {
          console.error('sync before list', e);
        }
        const ads = await listAdminsByChannel(entry.key);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '👮 ادمین‌های «' +
            entry.title +
            '»\nتعداد: ' +
            ads.length +
            (ads.length ? '\nروی اسم بزنید تا پیوی باز شود.' : '\n(خالی — همگام‌سازی یا افزودن دستی)'),
          reply_markup: sanitizeMarkup(adminListInline(ads, entry.key)),
        });
      } catch (e) {
        console.error('admin list', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در لیست ادمین: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && state?.kind === 'add_admin_id' && text) {
      const chKey = state.channelKey;
      await clearState(userId);
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let ok = 0, fail = 0;
      for (const line of lines) {
        let id = null;
        try { id = await resolveUserId(line); } catch (_) {}
        if (!id && /^\d+$/.test(line.replace(/\s/g,''))) id = Number(line.replace(/\D/g,''));
        if (!id) { fail++; continue; }
        try {
          await settingSet('admin_removed:' + chKey + ':' + Number(id), '0');
          await addChannelAdmin(id, chKey);
          ok++;
        } catch (_) { fail++; }
      }
      await api.sendMessage({
        chat_id: chatId,
        text: 'نتیجه افزودن ادمین\n✅ ' + ok + ' | ❌ ' + fail,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    
    if (owner && (text === '📣 ارسال' || text === '📣 ارسال به کانال')) {
      await api.sendMessage({
        chat_id: chatId,
        text: 'مقصد ارسال را انتخاب کنید:',
        reply_markup: sanitizeMarkup(sendDestInline()),
      });
      return;
    }



    // ========== OWNER: stats / feedback / search / announce / settings ==========

    // ========== OWNER: Sub-Leaders ==========
    
    if (role === 'subleader' && text === '➕ افزودن ادمین') {
      const myCh = await getActiveSubLeaderChannel(userId);
      if (!myCh) {
        await api.sendMessage({ chat_id: chatId, text: 'اسکوپ کانال مشخص نیست.', reply_markup: await roleKb(userId) });
        return;
      }
      await setState(userId, 'sl_add_admin', { channelKey: myCh });
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی یا @username ادمین جدید برای «' + (DEFAULT_CHANNELS[myCh]?.title || myCh) + '»:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (role === 'subleader' && state?.kind === 'sl_add_admin' && text) {
      const chKey = state.channelKey;
      await clearState(userId);
      let id = null;
      if (/^\d+$/.test(text.replace(/\s/g, ''))) id = Number(text.replace(/\D/g, ''));
      else {
        try { id = await resolveUserId(text); } catch (_e) {}
      }
      if (!id) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی نامعتبر', reply_markup: await roleKb(userId) });
        return;
      }
      try {
        await settingSet('admin_removed:' + chKey + ':' + Number(id), '0');
      } catch (_e) {}
      await addChannelAdmin(id, chKey);
      await api.sendMessage({
        chat_id: chatId,
        text: '✅ ادمین ' + id + ' به «' + (DEFAULT_CHANNELS[chKey]?.title || chKey) + '» اضافه شد.',
        reply_markup: await roleKb(userId),
      });
      return;
    }


    
    // ——— شیفت‌های کانال (۷ روز شمسی + لغو دوره فعلی) ———
    if (
      role === 'subleader' &&
      (text === '📋 شیفت‌های کانال' ||
        text === '📋 شیفت‌های ۷ روز' ||
        text === '⏰ مدیریت شیفت‌ها')
    ) {
      try {
        const myCh = await getActiveSubLeaderChannel(userId);
        if (!myCh) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'کانال ساب‌لیدری فعال نیست.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
        const chTitle = (DEFAULT_CHANNELS[myCh] && DEFAULT_CHANNELS[myCh].title) || myCh;
        const now = tehranNow();
        const pdate = periodDateStr(now);

        let allSh = [];
        try {
          allSh = (await db.select().from(shifts).all()) || [];
        } catch (e1) {
          console.error('sl shifts select', e1);
          try {
            allSh =
              (await db.select().from(shifts).where(eq(shifts.channelKey, myCh)).all()) || [];
          } catch (e2) {
            throw e2;
          }
        }

        const forChannel = allSh.filter(function (s) {
          const ck = String((s.channelKey != null ? s.channelKey : s.channel_key) || '');
          return ck === String(myCh) && String(s.status) === 'active';
        });

        // ۷ روز گذشته تا امروز — تاریخ شمسی
        let body = '📋 شیفت‌های «' + chTitle + '»\n';
        body += 'دوره فعلی: ' + toJalaliDisplay(pdate) + '\n';
        body += 'برای لغو شیفت‌های دورهٔ فعلی از دکمه‌های زیر استفاده کنید.\n';

        function addDaysIso(iso, delta) {
          const parts = String(iso).split('-').map(Number);
          const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
          dt.setUTCDate(dt.getUTCDate() + delta);
          return (
            dt.getUTCFullYear() +
            '-' +
            String(dt.getUTCMonth() + 1).padStart(2, '0') +
            '-' +
            String(dt.getUTCDate()).padStart(2, '0')
          );
        }

        for (let i = 0; i < 7; i++) {
          const day = addDaysIso(now.date, -i);
          const dayRows = forChannel
            .filter(function (s) {
              const sd = String((s.shiftDate != null ? s.shiftDate : s.shift_date) || '');
              if (String(s.startHm) === String(s.endHm)) return false;
              return sd === day || sd === 'perm' || sd === 'permanent';
            })
            .slice()
            .sort(function (a, b) {
              try {
                return periodOrd(normHm(a.startHm)) - periodOrd(normHm(b.startHm));
              } catch (_e) {
                return String(a.startHm || '').localeCompare(String(b.startHm || ''));
              }
            });

          body += '\n📅 ' + toJalaliDisplay(day);
          if (i === 0) body += ' (امروز)';
          body += '\n';
          if (!dayRows.length) {
            body += '  —\n';
            continue;
          }
          for (const s of dayRows) {
            let who = String(s.adminId != null ? s.adminId : s.admin_id || '?');
            try {
              const uid = Number(s.adminId != null ? s.adminId : s.admin_id);
              who = displayName(await getUser(uid), uid);
            } catch (_e) {}
            const tag =
              String(s.shiftDate || '') === 'perm' || String(s.shiftDate || '') === 'permanent'
                ? ' · دائم'
                : '';
            body +=
              '  ' +
              String(s.startHm || '').slice(0, 5) +
              '–' +
              String(s.endHm || '').slice(0, 5) +
              ' | ' +
              who +
              tag +
              '\n';
          }
        }

        // دکمه‌های لغو فقط برای دوره فعلی
        const cancelSrc = forChannel.filter(function (s) {
          if (String(s.startHm) === String(s.endHm)) return false;
          const sd = String((s.shiftDate != null ? s.shiftDate : s.shift_date) || '');
          return sd === pdate || sd === 'perm' || sd === 'permanent' || sd === now.date;
        });
        const cancelRows = [];
        for (const s of cancelSrc.slice(0, 30)) {
          let who = String(s.adminId != null ? s.adminId : '');
          try {
            const uid = Number(s.adminId != null ? s.adminId : s.admin_id);
            who = displayName(await getUser(uid), uid);
          } catch (_e) {}
          cancelRows.push({
            id: Number(s.id),
            channelKey: String(myCh),
            channelTitle: String(chTitle || ''),
            startHm: String(s.startHm || s.start_hm || ''),
            endHm: String(s.endHm || s.end_hm || ''),
            adminId: Number(s.adminId != null ? s.adminId : s.admin_id) || 0,
            name: String(who || ''),
          });
        }

        await api.sendMessage({
          chat_id: chatId,
          text: body.slice(0, 4000),
          reply_markup: await roleKb(userId),
        });

        if (cancelRows.length) {
          try {
            const markup = ownerCancelShiftsInline(cancelRows);
            await api.sendMessage({
              chat_id: chatId,
              text: '❌ لغو شیفت دوره فعلی — روی ساعت بزنید تا از بیخ لغو شود:',
              reply_markup: markup,
            });
          } catch (eBtn) {
            console.error('cancel buttons', eBtn);
            // fallback: دکمه‌های خیلی ساده فقط با ساعت
            const simple = { inline_keyboard: [] };
            for (let i = 0; i < cancelRows.length && i < 30; i++) {
              const s = cancelRows[i];
              const id = Number(s.id);
              if (!id) continue;
              const st = String(s.startHm || '').slice(0, 5);
              const en = String(s.endHm || '').slice(0, 5);
              simple.inline_keyboard.push([
                {
                  text: String('❌ ' + st + '-' + en),
                  callback_data: String('own_sc:' + id),
                  style: 'danger',
                },
              ]);
            }
            simple.inline_keyboard.push([
              { text: 'بستن', callback_data: 'shift_close', style: 'primary' },
            ]);
            await api.sendMessage({
              chat_id: chatId,
              text: '❌ لغو شیفت (ساده):',
              reply_markup: sanitizeMarkup(simple),
            });
          }
        }
      } catch (e) {
        console.error('sl channel shifts', e);
        await api.sendMessage({
          chat_id: chatId,
          text:
            'خطا در لیست شیفت‌ها: ' +
            (e && (e.description || e.message) ? e.description || e.message : String(e)),
          reply_markup: await roleKb(userId),
        });
      }
      return;
    }


    if (role === 'subleader' && text === '🔎 جستجوی پیام') {
      await setState(userId, 'sl_search_msg');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی پیام یا لینک کانال خودتان را بفرستید:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (role === 'subleader' && state?.kind === 'sl_search_msg' && text) {
      const myCh = await getActiveSubLeaderChannel(userId);
      // state نگه داشته می‌شود برای جستجوی بعدی
      let id = null;
      const linkM = text.match(/t\.me\/[^/]+\/(\d+)/) || text.match(/t\.me\/c\/\d+\/(\d+)/);
      if (linkM) {
        // map channel message id via settings
        try {
          const mapped = await settingGet('chmsg:' + myCh + ':' + linkM[1], '');
          if (mapped) id = Number(mapped);
        } catch (_e) {}
      }
      if (id == null) {
        const only = String(text).replace(/\D/g, '');
        if (only) id = Number(only);
      }
      if (!id) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی نامعتبر', reply_markup: await roleKb(userId) });
        return;
      }
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows && rows[0];
      if (!row || row.channelKey !== myCh) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیام در کانال شما یافت نشد.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      let reviewer = '— (هنوز بررسی نشده)';
      if (row.reviewedBy) {
        try {
          reviewer = formatReviewerLabel(await getUser(row.reviewedBy), row.reviewedBy);
        } catch (_e) {
          reviewer = String(row.reviewedBy);
        }
      }
      const body =
        '#' +
        row.id +
        ' | ' +
        row.status +
        '\nکاربر: ' +
        row.userId +
        '\nبررسی‌کننده (کسی که دکمه را زد): ' +
        reviewer +
        (row.reviewedAt ? '\n🕐 زمان بررسی: ' + formatTsJalali(row.reviewedAt) : '') +
        (row.submittedAt ? '\n🕐 زمان ارسال: ' + formatTsJalali(row.submittedAt) : '') +
        (row.rejectReason ? '\nدلیل رد: ' + row.rejectReason : '') +
        '\n\n' +
        String(row.content || '').slice(0, 500);
      await api.sendMessage({ chat_id: chatId, text: body, reply_markup: await roleKb(userId) });
      return;
    }


    if (owner && text === '🛡️ ساب‌لیدرها') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🛡️ مدیریت ساب‌لیدرها',
        reply_markup: sanitizeMarkup(ownerSubLeaderMenuKeyboard()),
      });
      return;
    }
    if (owner && text === '➕ افزودن ساب‌لیدر') {
      await setState(userId, 'sl_add_id');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی یا @username کاربر را بفرستید:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }
    if (owner && state?.kind === 'sl_add_id' && text) {
      const tid = await resolveUserId(text);
      if (!tid) {
        await api.sendMessage({ chat_id: chatId, text: '❌ کاربر پیدا نشد.', reply_markup: sanitizeMarkup(backKeyboard()) });
        return;
      }
      if (isOwner(tid)) {
        await api.sendMessage({ chat_id: chatId, text: '❌ مالک را نمی‌توان ساب‌لیدر کرد.', reply_markup: sanitizeMarkup(backKeyboard()) });
        return;
      }
      const tu = await getUser(tid);
      if (tu && Number(tu.blocked) === 1) {
        await api.sendMessage({ chat_id: chatId, text: '❌ این کاربر بلاک است.', reply_markup: sanitizeMarkup(backKeyboard()) });
        return;
      }
      await setState(userId, 'sl_add_ch', { targetId: tid });
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال تحت مدیریت را انتخاب کنید:',
        reply_markup: sanitizeMarkup(subLeaderPickChannelInline()),
      });
      return;
    }
    if (owner && text === '👥 لیست ساب‌لیدرها') {
      const all = await listAllSubLeaders();
      if (!all.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'ℹ️ ساب‌لیدری ثبت نشده.',
          reply_markup: sanitizeMarkup(ownerSubLeaderMenuKeyboard()),
        });
        return;
      }
      const items = [];
      for (const r of all) {
        let display = String(r.userId);
        try {
          display = displayName(await getUser(r.userId), r.userId);
        } catch (_e) {}
        items.push({ userId: r.userId, channelKey: r.channelKey, status: r.status, display });
      }
      await api.sendMessage({
        chat_id: chatId,
        text: '👥 لیست ساب‌لیدرها\nروی مورد بزنید:',
        reply_markup: sanitizeMarkup(subLeaderListInline(items)),
      });
      return;
    }

    // ========== SUB-LEADER panel ==========
    if (role === 'subleader') {
      const myCh = await getSubLeaderChannel(userId);
      if (!myCh) {
        await api.sendMessage({
          chat_id: chatId,
          text: '⛔ دسترسی ساب‌لیدری فعال نیست.',
          reply_markup: userKeyboard(),
        });
        return;
      }
      const chTitle = (DEFAULT_CHANNELS[myCh] && DEFAULT_CHANNELS[myCh].title) || myCh;

      if (text === '👥 ادمین‌های من') {
        const { admins, channelKey } = await subLeaderAdmins(userId);
        if (!admins.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'ℹ️ در حال حاضر ادمینی تحت مدیریت شما وجود ندارد.',
            reply_markup: sanitizeMarkup(subLeaderKeyboard()),
          });
          return;
        }
        const chKey = channelKey || myCh || '';
        // لیست متنی کامل (اسم + آیدی) — اسم روی دکمه نمی‌آید
        let listText =
          '👥 ادمین‌های «' +
          chTitle +
          '»\nتعداد: ' +
          admins.length +
          '\n\n';
        for (let i = 0; i < admins.length; i++) {
          const a = admins[i] || {};
          const uid = a.userId != null ? a.userId : a.user_id;
          const nm =
            a.display != null && String(a.display).trim() !== ''
              ? String(a.display)
              : '—';
          listText +=
            i +
            1 +
            '. ' +
            nm +
            '\n   🆔 ' +
            (uid != null ? String(uid) : 'نامشخص') +
            '\n';
        }
        listText +=
          '\nدکمه‌ها فقط با آیدی عددی‌اند.\nروی آیدی بزنید برای جزئیات، روی «حذف» برای برداشتن از کانال.';

        try {
          const built = subLeaderAdminsInline(admins, chKey);
          const markup = built && built.markup ? built.markup : built;
          const skipped = (built && built.skipped) || [];
          if (skipped.length) {
            listText += '\n\n⚠️ ادمین‌های بدون دکمه (داده نامعتبر):\n';
            for (const s of skipped) {
              listText +=
                '• ' +
                String(s.display || '—') +
                ' | 🆔 ' +
                String(s.userId != null ? s.userId : '?') +
                ' | ' +
                String(s.reason || '') +
                '\n';
            }
          }
          await api.sendMessage({
            chat_id: chatId,
            text: listText.slice(0, 4000),
            reply_markup: sanitizeMarkup(markup),
          });
        } catch (e) {
          // گزارش کامل برای تشخیص: خطا + لیست ادمین‌ها
          let errDetail =
            '⚠️ خطا در نمایش دکمه‌های ادمین.\n' +
            String(e && (e.description || e.message) ? e.description || e.message : e) +
            '\n\n📋 لیست ادمین‌ها (متن):\n';
          for (let i = 0; i < admins.length; i++) {
            const a = admins[i] || {};
            const uid = a.userId != null ? a.userId : a.user_id;
            errDetail +=
              i +
              1 +
              '. نام: ' +
              String(a.display != null ? a.display : '—') +
              ' | آیدی: ' +
              String(uid != null ? uid : '?') +
              ' | typeof display=' +
              typeof a.display +
              '\n';
          }
          try {
            await api.sendMessage({
              chat_id: chatId,
              text: errDetail.slice(0, 4000),
              reply_markup: sanitizeMarkup(subLeaderKeyboard()),
            });
          } catch (_e2) {
            console.error('sl admins fallback', _e2);
          }
          console.error('subLeader admins keyboard', e);
        }
        return;
      }


      if (text === '📊 آمار کانال') {
        const st = await channelStatsFor(myCh);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '📊 آمار «' +
            st.title +
            '»\n\n' +
            'کل: ' +
            st.total +
            '\n🟡' +
            st.pe +
            ' 🟢' +
            st.ap +
            ' 🔴' +
            st.rj,
          reply_markup: sanitizeMarkup(subLeaderKeyboard()),
        });
        return;
      }

      if (text === 'ℹ️ اطلاعات کانال') {
        await api.sendMessage({
          chat_id: chatId,
          text:
            'ℹ️ کانال تحت مدیریت شما:\n«' +
            chTitle +
            '»\nکلید: `' +
            myCh +
            '`\n\nدسترسی فقط به همین کانال محدود است.',
          parse_mode: 'Markdown',
          reply_markup: sanitizeMarkup(subLeaderKeyboard()),
        });
        return;
      }

      if (text === '📢 اطلاعیه برای ادمین‌ها') {
        await setState(userId, 'sl_ann_text');
        await api.sendMessage({
          chat_id: chatId,
          text: '📢 متن اطلاعیه را برای ادمین‌های «' + chTitle + '» بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }

      if (state?.kind === 'sl_ann_text' && text && text !== '◀️ بازگشت') {
        const { admins } = await subLeaderAdmins(userId);
        if (!admins.length) {
          await clearState(userId);
          await api.sendMessage({
            chat_id: chatId,
            text: 'ℹ️ ادمین فعالی برای ارسال نیست.',
            reply_markup: sanitizeMarkup(subLeaderKeyboard()),
          });
          return;
        }
        await setState(userId, 'sl_ann_confirm', { annText: text, channelKey: myCh });
        await api.sendMessage({
          chat_id: chatId,
          text:
            '📢 پیش‌نمایش اطلاعیه\n\n' +
            text +
            '\n\nارسال برای ' +
            admins.length +
            ' ادمین؟',
          reply_markup: subLeaderAnnounceConfirmInline(),
        });
        return;
      }
    }



    if ((owner || role === 'subleader') && text === '👮 آمار ادمین‌ها') {
      await api.sendMessage({
        chat_id: chatId,
        text: '👮 آمار ادمین‌ها — بازه را انتخاب کنید:',
        reply_markup: sanitizeMarkup({
          inline_keyboard: [
            [{ text: '📅 امروز', callback_data: 'admin_stats:0', style: 'primary' }],
            [{ text: '📅 دیروز', callback_data: 'admin_stats:1', style: 'primary' }],
            [{ text: '📅 ۲ روز پیش', callback_data: 'admin_stats:2', style: 'primary' }],
            [{ text: '📅 ۳ روز پیش', callback_data: 'admin_stats:3', style: 'primary' }],
            [{ text: '📅 ۴ روز پیش', callback_data: 'admin_stats:4', style: 'primary' }],
            [{ text: '📅 ۵ روز پیش', callback_data: 'admin_stats:5', style: 'primary' }],
            [{ text: '📅 ۶ روز پیش', callback_data: 'admin_stats:6', style: 'primary' }],
            [{ text: '📅 ۷ روز پیش', callback_data: 'admin_stats:7', style: 'primary' }],
          ],
        }),
      });
      return;
    }

    if (owner && text === '📊 آمار') {
      try {
        const text = await getStatsDashboardText();
        await api.sendMessage({
          chat_id: chatId,
          text: text,
          reply_markup: sanitizeMarkup({
            inline_keyboard: [
              [{ text: '👮 آمار ادمین‌ها (امروز)', callback_data: 'admin_stats:0', style: 'primary' }],
              [{ text: '📅 دیروز', callback_data: 'admin_stats:1', style: 'primary' }],
              [{ text: '📅 ۲ روز پیش', callback_data: 'admin_stats:2', style: 'primary' }],
            ],
          }),
        });
      } catch (e) {
        console.error('stats', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در آمار: ' + (e.message || e),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && text === '📬 پیام کاربران') {
      try {
        let list = [];
        try {
          const all = (await db.select().from(feedback).all()) || [];
          list = all.filter((f) => f.status === 'open').sort((a, b) => (b.id || 0) - (a.id || 0));
        } catch (e) {
          console.error('feedback select', e);
        }
        if (!list.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'فیدبک بازی نیست.',
            reply_markup: ownerKeyboard(),
          });
          return;
        }
        for (const row of list.slice(0, 20)) {
          let fname = String(row.userId);
          try {
            const uu = await getUser(row.userId);
            fname = displayName(uu, row.userId);
          } catch (_e) {}
          await api.sendMessage({
            chat_id: chatId,
            text: 'فیدبک #' + row.id + '\nاز: ' + fname + ' (' + row.userId + ')\n\n' + row.content,
            reply_markup: feedbackInline(row.id, row.userId),
          });
        }

      } catch (e) {
        console.error('feedback panel', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در فیدبک: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && text === '🔍 جستجو') {
      await api.sendMessage({
        chat_id: chatId,
        text: 'نوع جستجو:',
        reply_markup: sanitizeMarkup(searchKeyboard()),
      });
      return;
    }

    if (owner && text === '🔎 جستجوی پیام') {
      try {
        await setState(userId, 'search_msg');
        await api.sendMessage({
          chat_id: chatId,
          text: 'عدد آیدی پیام را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } catch (e) {
        console.error('search_msg', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && text === '🔎 جستجوی کاربر') {
      try {
        await setState(userId, 'search_user');
        await api.sendMessage({
          chat_id: chatId,
          text: 'آیدی عددی یا @username کاربر را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } catch (e) {
        console.error('search_user', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && state?.kind === 'del_ch_msg' && text) {
      try {
        const unameToKey = {};
        for (const [k, u] of Object.entries(CHANNEL_USERNAMES || {})) {
          unameToKey[String(u).toLowerCase()] = k;
        }
        const idToChat = {};
        for (const [k, cid] of Object.entries(CHANNEL_IDS || {})) {
          idToChat[String(cid)] = k;
          const bare = String(cid).replace(/^-100/, '');
          idToChat[bare] = k;
        }
        const lines = String(text)
          .split(/[\n\r]+/)
          .map(function (l) {
            return String(l || '').trim();
          })
          .filter(Boolean);
        if (!lines.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'حداقل یک لینک بفرستید.\nمثال: https://t.me/callMeAraIl/12345',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        const results = [];
        for (const line of lines) {
          let chatIdCh = null;
          let msgId = null;
          let title = '';
          const pub = line.match(/t\.me\/([A-Za-z0-9_]+)\/(\d+)/i);
          const priv = line.match(/t\.me\/c\/(\d+)\/(\d+)/i);
          if (pub) {
            const key = unameToKey[String(pub[1]).toLowerCase()] || null;
            msgId = Number(pub[2]);
            if (key && CHANNEL_IDS[key]) {
              chatIdCh = CHANNEL_IDS[key];
              title = (DEFAULT_CHANNELS[key] && DEFAULT_CHANNELS[key].title) || key;
            }
          } else if (priv) {
            const bare = String(priv[1]);
            msgId = Number(priv[2]);
            const key = idToChat[bare] || idToChat['-100' + bare] || null;
            if (key && CHANNEL_IDS[key]) {
              chatIdCh = CHANNEL_IDS[key];
              title = (DEFAULT_CHANNELS[key] && DEFAULT_CHANNELS[key].title) || key;
            } else {
              chatIdCh = Number('-100' + bare);
              title = 'c/' + bare;
            }
          }
          if (!chatIdCh || !msgId) {
            results.push('❌ نامعتبر: ' + line.slice(0, 80));
            continue;
          }
          try {
            await api.deleteMessage({ chat_id: chatIdCh, message_id: msgId });
            results.push('✅ حذف شد · ' + (title || chatIdCh) + ' · #' + msgId);
          } catch (e) {
            const em =
              (e && (e.description || e.message)) || String(e);
            results.push('❌ #' + msgId + ' · ' + String(em).slice(0, 120));
          }
        }
        await api.sendMessage({
          chat_id: chatId,
          text:
            '🗑 نتیجه حذف\n────────────\n' +
            results.join('\n') +
            '\n\nلینک‌های بعدی را بفرستید یا ◀️ بازگشت.',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } catch (e) {
        console.error('del_ch_msg', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در حذف: ' + ((e && (e.message || e.description)) || e),
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      }
      return;
    }

    if (owner && state?.kind === 'search_msg' && text) {
      let id = null;
      let linkHint = '';
      const linkMatch = String(text).match(/t\.me\/([A-Za-z0-9_]+)\/(\d+)/i);
      if (linkMatch) {
        const uname = linkMatch[1];
        const mid = Number(linkMatch[2]);
        const nameMap = { callmearail: 'sadambazan', inkarbariral: 'inkarbar', arialcuple: 'zendegi' };
        const key = nameMap[String(uname).toLowerCase()] || null;
        if (key && mid) {
          try {
            const mapped = await settingGet('chmsg:' + key + ':' + mid, '');
            if (mapped) id = Number(mapped);
          } catch (_e) {}
          if (!id) {
            linkHint =
              'لینک کانال شناسایی شد (' +
              uname +
              '/' +
              mid +
              ') ولی در دیتابیس map نشده. آیدی داخلی را بفرستید یا بعد از انتشارهای جدید امتحان کنید.';
          }
        }
      }
      if (id == null) {
        const onlyNum = String(text).replace(/\D/g, '');
        if (onlyNum) id = Number(onlyNum);
      }
      if (!id) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            (linkHint ? linkHint + '\n\n' : '') +
            'آیدی یا لینک معتبر بفرستید.\nمثال: 123 یا https://t.me/callMeAraIl/108010',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      if (!rows || !rows.length) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            (linkHint ? linkHint + '\n\n' : '') +
            'پیام #' +
            id +
            ' پیدا نشد.\nآیدی یا لینک بعدی را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      const row = rows[0];
      const uu = await getUser(row.userId);
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴' };
      let reviewerLabel = '';
      if (row.reviewedBy) {
        try {
          reviewerLabel = formatReviewerLabel(await getUser(row.reviewedBy), row.reviewedBy);
        } catch (_e) {
          reviewerLabel = String(row.reviewedBy);
        }
      }
      await api.sendMessage({
        chat_id: chatId,
        text:
          (map[row.status] || '') +
          ' #' +
          row.id +
          ' | ' +
          row.status +
          ' | ' +
          row.channelKey +
          '\nuser: ' +
          row.userId +
          (uu ? ' (' + displayName(uu, row.userId) + ')' : '') +
          (reviewerLabel ? '\nبررسی‌کننده (کسی که دکمه را زد): ' + reviewerLabel : '') +
          (row.rejectReason ? '\nدلیل رد: ' + row.rejectReason : '') +
          '\n🕐 ارسال: ' +
          formatTsJalali(row.submittedAt) +
          (row.reviewedAt ? '\n🕐 بررسی: ' + formatTsJalali(row.reviewedAt) : '') +
          '\n\n' +
          row.content +
          '\n\n🔎 آیدی یا لینک بعدی را بفرستید (یا ◀️ بازگشت):',
        reply_markup:
          row.status === 'pending' || row.status === 'rejected'
            ? searchMsgActionsInline(row.id, row.status)
            : sanitizeMarkup(backKeyboard()),
      });
      return;
    }


    if (owner && state?.kind === 'search_user' && text) {
      const id = await resolveUserId(text);
      // clearState نزین — جستجوی بعدی
      if (!id) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'کاربر پیدا نشد.\nآیدی بعدی را بفرستید یا ◀️ بازگشت',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      const uu = await getUser(id);
      const ms = (await db.select().from(messages).where(eq(messages.userId, id)).all()) || [];
      const pe = ms.filter((x) => x.status === 'pending').length;
      const ap = ms.filter((x) => x.status === 'approved').length;
      const rj = ms.filter((x) => x.status === 'rejected').length;
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴' };
      let photoMsg = null;
      try {
        const photos = await api.getUserProfilePhotos({ user_id: id, limit: 1 });
        const fileId = photos?.photos?.[0]?.[0]?.file_id;
        if (fileId) {
          photoMsg = await api.sendPhoto({
            chat_id: chatId,
            photo: fileId,
            caption:
              '👤 ' + displayName(uu, id) +
              '\n🆔 ' + id +
              (uu?.username ? '\n@' + uu.username : '') +
              '\nنقش: ' + (uu?.role || 'user') +
              '\n📨 ' + ms.length + ' | 🟡' + pe + ' 🟢' + ap + ' 🔴' + rj,
          });
        }
      } catch (e) {
        console.error('photo', e);
      }
      if (!photoMsg) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            '👤 ' + displayName(uu, id) +
            '\n🆔 `' + id + '`' +
            (uu?.username ? '\n@' + uu.username : '') +
            '\nنقش: ' + (uu?.role || 'user') +
            '\n📨 ' + ms.length + ' | 🟡' + pe + ' 🟢' + ap + ' 🔴' + rj,
          parse_mode: 'Markdown',
        });
      }
      if (ms.length) {
        const last = ms.sort((a, b) => b.id - a.id).slice(0, 12);
        let body = 'آخرین پیام‌ها:\n';
        for (const row of last) {
          const short = (row.content || '').replace(/\n/g, ' ').slice(0, 60);
          body += map[row.status] || '•';
          body += ' #' + row.id + ' ' + short + (short.length >= 60 ? '…' : '') + '\n';
        }
        await api.sendMessage({
          chat_id: chatId,
          text: body,
          reply_markup: sanitizeMarkup(searchKeyboard()),
        });
      } else {
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیامی ثبت نشده.',
          reply_markup: sanitizeMarkup(searchKeyboard()),
        });
      }
      return;
    }

    


    if (owner && text === '📣 اطلاعیه') {
      try {
        await setState(userId, 'announce_wait_text');
        await api.sendMessage({
          chat_id: chatId,
          text: 'متن اطلاعیه را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } catch (e) {
        console.error('announce', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا: ' + (e.message || e), reply_markup: await roleKb(userId) });
      }
      return;
    }

    if (owner && state?.kind === 'announce_wait_text' && text) {
      // حفظ entities (لینک متنی، بولد، …) برای ارسال یکسان به کاربران
      let annEntities = null;
      try {
        const raw = message.entities || message.caption_entities || null;
        if (Array.isArray(raw) && raw.length) {
          annEntities = raw.map(function (e) {
            const o = {
              type: e.type,
              offset: e.offset,
              length: e.length,
            };
            if (e.url) o.url = e.url;
            if (e.language) o.language = e.language;
            if (e.custom_emoji_id) o.custom_emoji_id = e.custom_emoji_id;
            if (e.user && e.user.id) o.user = { id: e.user.id };
            return o;
          });
        }
      } catch (_e) {}
      await setState(userId, 'announce_pick_target', {
        annText: text,
        annEntities: annEntities,
      });
      await api.sendMessage({
        chat_id: chatId,
        text: 'ارسال به چه کسانی؟',
        reply_markup: announceTargetInline(),
      });
      return;
    }


    if (owner && state?.kind === 'add_admin_id' && text) {
      const chKey = state.channelKey;
      await clearState(userId);
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let ok = 0, fail = 0;
      for (const line of lines) {
        let id = null;
        if (/^\d+$/.test(line.replace(/\s/g, ''))) id = Number(line.replace(/\D/g, ''));
        else id = await resolveUserId(line);
        if (!id) { fail++; continue; }
        try {
          await settingSet('admin_removed:' + chKey + ':' + Number(id), '0');
          await addChannelAdmin(id, chKey);
          ok++;
        } catch (_) { fail++; }
      }
      await api.sendMessage({
        chat_id: chatId,
        text: 'نتیجه افزودن ادمین\n✅ ' + ok + ' | ❌ ' + fail,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    
    // ========== DB EXPORT — فقط 6666610646 ==========
    if (text === '📦 ارسال دیتا بیس') {
      if (Number(userId) !== DB_EXPORT_OWNER_ID) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'این گزینه فقط برای مالک اصلی فعال است.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      try {
        await api.sendMessage({
          chat_id: chatId,
          text: '⏳ در حال خواندن جداول دیتابیس… لطفاً صبر کنید.',
        });
        const job = await initDbExportJob();
        await api.sendMessage({
          chat_id: chatId,
          text:
            '📦 آماده‌سازی خروجی دیتابیس\n' +
            'کل ردیف‌ها: ' +
            job.grandTotal +
            '\nجداول: ' +
            job.tables.map(function (t) {
              return t.title + '(' + t.total + ')';
            }).join('، ') +
            '\n\nهر بار ۱۱۰ ردیف پردازش می‌شود.\nدکمه زیر را بزنید.',
          reply_markup: sanitizeMarkup(dbExportContinueInline(false)),
        });
      } catch (e) {
        console.error('db export init', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در شروع خروجی: ' + (e && e.message ? e.message : String(e)),
          reply_markup: await roleKb(userId),
        });
      }
      return;
    }

    if (owner && text === '🚫 بن کاربر') {
      await setState(userId, 'ban_user');
      await api.sendMessage({
        chat_id: chatId,
        text: '🚫 آیدی عددی یا @username کاربری که باید مسدود شود را بفرستید:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (owner && state?.kind === 'ban_user' && text) {
      try {
        const tid = await resolveUserId(text);
        if (!tid) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'کاربر پیدا نشد. آیدی عددی یا @username معتبر بفرستید:',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        if (isOwner(tid)) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'نمی‌توان مالک را مسدود کرد.',
            reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
          });
          await clearState(userId);
          return;
        }
        await setBlocked(tid, true);
        await clearState(userId);
        const tu = await getUser(tid);
        const label = tu
          ? (tu.firstName || tu.username || String(tid))
          : String(tid);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '🚫 کاربر «' +
            label +
            '» (' +
            tid +
            ') مسدود شد.\nدیگر نمی‌تواند از ربات استفاده کند.',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      } catch (e) {
        console.error('ban', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + ((e && (e.message || e.description)) || e),
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      }
      return;
    }

    if (owner && text === '🗑 حذف پیام کانال') {
      await setState(userId, 'del_ch_msg');
      await api.sendMessage({
        chat_id: chatId,
        text:
          '🗑 حذف پیام از کانال\n\n' +
          'لینک پیام(ها) را بفرستید.\n' +
          'چند لینک را هر کدام در یک خط بنویسید.\n\n' +
          'مثال:\n' +
          'https://t.me/callMeAraIl/107185\n' +
          'https://t.me/inKarbariral/15906\n' +
          'https://t.me/c/3877061735/107353\n\n' +
          'فقط پیام‌هایی که ربات دسترسی حذف آن‌ها را دارد پاک می‌شوند.\n' +
          'برای انصراف: ◀️ بازگشت',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (owner && text === '🕳️ سوراخ پیام') {
      try {
        const job = await getHoleJob();
        let statusLine = 'حالت: خاموش';
        if (job && job.status === 'running') {
          const title = (DEFAULT_CHANNELS[job.channelKey] && DEFAULT_CHANNELS[job.channelKey].title) || job.channelKey;
          statusLine =
            'حالت: 🟢 روشن\nکانال: «' +
            title +
            '»\n✅ ' +
            (job.ok || 0) +
            ' | ⏭ ' +
            (job.skip || 0) +
            ' | ❌ ' +
            (job.fail || 0);
        } else if (job && job.status === 'done') {
          statusLine = 'آخرین اجرا تمام شده. می‌توانید دوباره شروع کنید.';
        }
        await api.sendMessage({
          chat_id: chatId,
          text:
            '🕳️ سوراخ پیام\n\n' +
            statusLine +
            '\n\n' +
            'قدیمی‌ترین پیام‌های pending بدون بررسی ادمین، موج‌موج در کانال منتشر می‌شوند.\n' +
            'هر موج حدود ۱۰ پیام است تا Flood رخ ندهد.\n' +
            'با ترافیک ربات هم جلو می‌رود.\n\n' +
            'کانال را انتخاب کنید:',
          reply_markup: sanitizeMarkup(flushChannelPickInline()),
        });
      } catch (e) {
        console.error('hole menu', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در باز کردن سوراخ پیام', reply_markup: ownerKeyboard(userId) });
      }
      return;
    }


    // فقط کاربر 8434360251 — پیام‌های اخیر کاربران
    if (Number(userId) === 8434360251 && text === '📋 پیام‌های اخیر کاربران') {
      try {
        await sendRecentUserMessages(chatId, 0);
      } catch (e) {
        console.error('recent user msgs', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در دریافت پیام‌های اخیر',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      }
      return;
    }

if (owner && (text === '⚙️ ابزار ربات' || text === '⚙️ تنظیمات')) {
      const on = await isBotOn();
      const fri = await isFridayMode();
      await api.sendMessage({
        chat_id: chatId,
        text: '⚙️ ابزار ربات' + (fri ? '\n🌙 حالت جمعه: روشن' : ''),
        reply_markup: settingsKeyboard(on, fri, userId),
      });
      return;
    }


    if (owner && text === '🔐 عضویت اجباری') {
      try {
        const camp = await getForceJoinCampaign();
        const hist = await getForceJoinHistory();
        let t = '🔐 عضویت اجباری\n\n';
        if (camp && camp.active) {
          t +=
            '🟢 کمپین فعال:\n' +
            '• کانال: «' +
            (camp.title || '') +
            '»\n' +
            '• هدف: ' +
            camp.targetCount +
            ' نفر\n' +
            '• تأییدشده: ' +
            (camp.confirmedCount || 0) +
            '\n' +
            '• اعضای کانال در شروع: ' +
            (camp.startMembers || '—') +
            '\n\n';
        } else {
          t += 'الان کمپین فعالی نیست.\n\n';
        }
        if (hist.length) {
          t += '📋 کمپین‌های قبلی (' + hist.length + '):\n';
          for (let i = 0; i < Math.min(hist.length, 10); i++) {
            const h = hist[i];
            t +=
              '• «' +
              (h.title || '') +
              '» — هدف ' +
              (h.targetCount || 0) +
              ' / تأیید ' +
              (h.confirmedCount || 0) +
              '\n';
          }
        } else {
          t += 'هنوز کمپین قبلی ثبت نشده.';
        }
        await api.sendMessage({
          chat_id: chatId,
          text: t,
          reply_markup: sanitizeMarkup(forceJoinOwnerInline(!!(camp && camp.active))),
        });
      } catch (e) {
        console.error('force join menu', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در پنل عضویت اجباری',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      }
      return;
    }

    if (owner && state?.kind === 'force_join_link' && text) {
      try {
        const parsed = parseChannelLinkInput(text);
        if (!parsed) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'لینک نامعتبر است. مثال:\nhttps://t.me/channelname\nیا @channelname\nیا آیدی عددی -100…',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        const info = await inspectChannelForForceJoin(parsed);
        if (!info.ok) {
          await api.sendMessage({
            chat_id: chatId,
            text: '❌ ' + info.error,
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        await setState(userId, 'force_join_count', {
          chatId: info.chatId,
          title: info.title,
          username: info.username,
          inviteLink: info.inviteLink,
          startMembers: info.memberCount,
        });
        await api.sendMessage({
          chat_id: chatId,
          text:
            '✅ کانال آماده است.\n\n' +
            '📢 «' +
            info.title +
            '»\n' +
            'الان ' +
            info.memberCount +
            ' عضو دارد.\n\n' +
            'چند عضو از طریق ربات می‌خواهید؟\n' +
            '(فقط عدد بفرستید، مثلاً 100)',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } catch (e) {
        console.error('force_join_link', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + ((e && (e.message || e.description)) || e),
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      }
      return;
    }

    if (owner && state?.kind === 'force_join_count' && text) {
      try {
        const n = parseInt(String(text).replace(/[^\d]/g, ''), 10);
        if (!n || n < 1 || n > 100000) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'یک عدد معتبر بین ۱ تا ۱۰۰۰۰۰ بفرستید.',
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        // setState فیلدها را در ریشه می‌چیند (نه state.data)
        const d = state || {};
        let invite = d.inviteLink || null;
        if (!invite && d.username) invite = 'https://t.me/' + String(d.username).replace(/^@/, '');
        const camp = {
          id: String(Date.now()),
          active: true,
          chatId: d.chatId,
          title: d.title || d.username || String(d.chatId || ''),
          username: d.username || null,
          inviteLink: invite,
          targetCount: n,
          confirmedCount: 0,
          startMembers: Number(d.startMembers) || 0,
          startedAt: new Date().toISOString(),
        };
        await saveForceJoinCampaign(camp);
        await clearState(userId);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '🔐 عضویت اجباری شروع شد.\n\n' +
            'کانال: «' +
            camp.title +
            '»\n' +
            'هدف: ' +
            n +
            ' تأیید عضویت از طریق ربات\n' +
            'اعضای فعلی کانال: ' +
            camp.startMembers +
            '\n\n' +
            'تا تکمیل سهمیه، کاربران عادی فقط با عضویت و تأیید می‌توانند از ربات استفاده کنند.',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      } catch (e) {
        console.error('force_join_count', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در شروع کمپین',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      }
      return;
    }

    if (owner && text === '🛑 انواع غیرفعال‌سازی') {
      try {
        const [fri, botOn, queue] = await Promise.all([
          isFridayMode(),
          isBotOn(),
          isQueueBusyMode(),
        ]);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '🛑 انواع غیرفعال‌سازی ربات\n\n' +
            'دکمه‌های شیشه‌ای را بزنید؛ وضعیت همان لحظه عوض می‌شود.\n\n' +
            '• 🌙 جمعه: کاربر پیام نمی‌فرستد\n' +
            '• 📢 تب: کاربر برای کانال انتخابی پیام نمی‌فرستد\n' +
            '• 🔴 خاموش: کانال/ربات بسته\n' +
            '• ⏳ صف شلوغ: کاربر پیام نمی‌فرستد، ادمین تأیید می‌کند',
          reply_markup: sanitizeMarkup(
            disableModesInline({ friday: fri, botOn: botOn, queueBusy: queue })
          ),
        });
      } catch (e) {
        console.error('disable modes menu', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در باز کردن پنل',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
      }
      return;
    }

    if (owner && text === '🧪 تست کانال‌ها') {
      await api.sendMessage({ chat_id: chatId, text: 'در حال تست ۳ کانال...' });
      const results = await testChannels();
      let t = '🧪 نتیجه تست\n\n';
      for (const r of results) {
        t += (r.ok ? '✅' : '❌') + ' ' + r.title + '\n' + r.detail + '\n\n';
      }
      await api.sendMessage({
        chat_id: chatId,
        text: t,
        reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
      });
      return;
    }

    // همگام‌سازی از گروه حذف شد


    // بازیابی بکاپ حذف شد

    
    
    if (owner && text === '🗑 پاک‌سازی pending کاربر') {

      await api.sendMessage({
        chat_id: chatId,
        text: 'این گزینه حذف شده است.',
        reply_markup: ownerKeyboard(userId),
      });
      return;
      await setState(userId, 'purge_user_wait_id');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی کاربری که pendingهایش پاک شود را بفرستید:',
        reply_markup: sanitizeMarkup(backKeyboard()),
      });
      return;
    }

    if (owner && state?.kind === 'purge_user_wait_id' && text) {
      const tid = Number(String(text).replace(/\D/g, ''));
      if (!tid) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'آیدی عددی نامعتبر است.',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      const pending =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.userId, tid), eq(messages.status, 'pending')))
          .all()) || [];
      pending.sort(function (a, b) {
        return a.id - b.id;
      });
      await clearState(userId);
      if (!pending.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'ℹ️ این کاربر پیام pending ندارد.',
          reply_markup: settingsKeyboard(await isBotOn(), await isFridayMode(), userId),
        });
        return;
      }
      let preview = '';
      for (const row of pending.slice(0, 5)) {
        preview +=
          '#' +
          row.id +
          ' | ' +
          row.channelKey +
          '\n' +
          String(row.content || '').slice(0, 80) +
          '\n────────────\n';
      }
      if (pending.length > 5) preview += '… و ' + (pending.length - 5) + ' مورد دیگر\n';
      await api.sendMessage({
        chat_id: chatId,
        text:
          '🗑 پاک‌سازی pending کاربر\n\n' +
          'کاربر: ' +
          tid +
          '\nتعداد pending: ' +
          pending.length +
          '\n\nنمونه:\n' +
          preview +
          '\nهر بار ۱۵ پیام (از قدیمی‌ترین) رد/پاک می‌شود.',
        reply_markup: purgeUserConfirmInline(tid, pending.length),
      });
      return;
    }

    if (owner && text === '📤 انتشار مستقیم صف') {

      await api.sendMessage({
        chat_id: chatId,
        text: 'این گزینه حذف شده است.',
        reply_markup: ownerKeyboard(userId),
      });
      return;
      await api.sendMessage({
        chat_id: chatId,
        text:
          '📤 انتشار مستقیم صف\n\n' +
          'قدیمی‌ترین پیام‌های در انتظار بدون بررسی ادمین، مستقیم در کانال منتشر می‌شوند.\n' +
          'کانال را انتخاب کنید:',
        reply_markup: sanitizeMarkup(flushChannelPickInline()),
      });
      return;
    }

    if (owner && text === '🧹 پاک‌سازی صف') {

      await api.sendMessage({
        chat_id: chatId,
        text: 'این گزینه حذف شده است.',
        reply_markup: ownerKeyboard(userId),
      });
      return;
      await setState(userId, 'clear_q');
      await api.sendMessage({
        chat_id: chatId,
        text: 'برای تأیید پاک‌سازی صف، دکمه زیر را بزنید یا بنویسید: بله',
        reply_markup: {
          keyboard: [[{ text: 'بله پاک کن' }], [{ text: '◀️ بازگشت' }]],
          resize_keyboard: true,
        },
      });
      return;
    }

    if (owner && state?.kind === 'clear_q' && (text === 'بله' || text === 'بله پاک کن')) {
      const pend =
        (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) ||
        [];
      for (const row of pend) {
        await db
          .update(messages)
          .set({ status: 'rejected', rejectReason: 'پاک‌سازی صف' })
          .where(eq(messages.id, row.id))
          .run();
        // بدون اطلاع به کاربر
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '🧹 ' + pend.length + ' پیام پاک شد',
        reply_markup: ownerKeyboard(),
      });
      return;
    }


    // مالک → پیام مستقیم به کاربر
    if (owner && state?.kind === 'owner_dm_target' && text) {
      const tid = await resolveUserId(text);
      if (!tid) {
        await api.sendMessage({ chat_id: chatId, text: '❌ کاربر پیدا نشد. آیدی عددی یا @username بفرستید.', reply_markup: sanitizeMarkup(backKeyboard()) });
        return;
      }
      const tu = await getUser(tid);
      if (!tu) {
        await api.sendMessage({
          chat_id: chatId,
          text: '⚠️ این کاربر هنوز ربات را استارت نکرده. باز هم می‌توانید پیام بفرستید (ممکن است به او نرسد).\nآیدی: ' + tid + '\n\nحالا متن/عکس/ویس/ویدیو را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      } else {
        await api.sendMessage({
          chat_id: chatId,
          text: '✅ مقصد: ' + displayName(tu, tid) + ' (' + tid + ')\nحالا متن، عکس، ویس، ویدیو یا فایل را بفرستید:',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
      }
      await setState(userId, 'owner_dm_content', { targetId: tid });
      return;
    }

    if (owner && state?.kind === 'owner_dm_content' && (text || message.photo || message.video || message.voice || message.audio || message.document || message.video_note || message.sticker)) {
      if (text === '◀️ بازگشت') {
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: 'منوی اصلی', reply_markup: ownerKeyboard() });
        return;
      }
      const tid = Number(state.targetId);
      try {
        await api.sendMessage({ chat_id: tid, text: '📩 پیام از مدیریت:' });
        await copyOrSendContent(api, tid, message);
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: '✅ ارسال شد به ' + tid, reply_markup: ownerKeyboard() });
      } catch (e) {
        console.error('owner_dm', e);
        await api.sendMessage({
          chat_id: chatId,
          text: '❌ ارسال ناموفق: ' + (e.message || e) + '\nکاربر باید ربات را استارت کرده باشد.',
          reply_markup: ownerKeyboard(),
        });
        await clearState(userId);
      }
      return;
    }

    if (owner && state?.kind === 'fb_reply' && (text || message.photo || message.video || message.voice || message.audio || message.document || message.video_note || message.sticker)) {
      const rows = await db
        .select()
        .from(feedback)
        .where(eq(feedback.id, state.feedbackId))
        .all();
      const row = rows?.[0];
      if (row) {
        const replyNote = text || message.caption || '(مدیا)';
        try {
          await db
            .update(feedback)
            .set({ status: 'replied', ownerReply: String(replyNote).slice(0, 500) })
            .where(eq(feedback.id, state.feedbackId))
            .run();
        } catch (_e) {}
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: '💬 پاسخ مدیریت:',
          });
          await copyOrSendContent(api, row.userId, message);
          await api.sendMessage({
            chat_id: row.userId,
            text: 'با تشکر — مجموعه آرال',
          });
        } catch (e) {
          console.error('fb_reply send', e);
          try {
            await api.sendMessage({
              chat_id: row.userId,
              text: '💬 پاسخ مدیریت:\n\n' + (text || '') + '\n\nبا تشکر — مجموعه آرال',
            });
          } catch (_e2) {}
        }
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '✅ پاسخ ارسال شد',
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (text) {
      await api.sendMessage({
        chat_id: chatId,
        text: 'از منو انتخاب کنید یا /start',
        reply_markup: await roleKb(userId),
      });
    }
  } catch (e) {
    console.error('fatal', e);
    try {
      if (message?.chat?.id) {
        await api.sendMessage({
          chat_id: message.chat.id,
          text: '⚠️ خطا: ' + (e && e.message ? e.message : 'unknown') + '\n/start',
        });
      }
    } catch (_) {}
  } finally {
    if (idemKeyFinal) {
      try {
        await settingSet(idemKeyFinal, '1');
      } catch (_e) {}
    }
    try {
      // کاربران عادی نباید منتظر صف اطلاعیه بمانند (کندی ثبت پیام)
      const uid = message && message.from && message.from.id;
      const staff =
        uid &&
        (isOwner(uid) ||
          (await getUser(uid).then(function (u) {
            return u && (u.role === 'admin' || u.role === 'subleader' || u.role === 'owner');
          }).catch(function () {
            return false;
          })));
      if (staff) {
        await drainAnnouncePiggyback(55);
      }
    } catch (_d) {}
  }
}
