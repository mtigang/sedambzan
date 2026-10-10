import { normalizeBody, exactBodyKey } from 'lib/validation';
import { api, db, InputFile } from 'sdk';
import { eq, and } from 'sdk/db';
import { messages, feedback, shifts, settings, users, channelAdmins } from 'schema';
import {
  isOwner,
  setChannelEnabled,
  setChannelAdMode,
  isChannelAdMode,
  getActiveSubLeaderChannel,
  removeChannelAdmin,
  listAdminsByChannel,
  syncAdminsFromGroup,
  postToChannel,
  toBoldHtml,
  displayName,
  getUser,
  settingGet,
  settingSet,
  activeShiftAdmins,
  addChannelAdmin,
  getRole,
  decideMessage,
  dropMessageFromAllReviewBatches,
  dropMessageFromReviewBatch,
  pruneReviewBatchToPending,
  clearReviewBatch,
  checkReviewAccess,
  activeShiftChannelKeys,
  canManageOthersShifts,
  createReviewBatch,
  restoreMistakenlyCancelledShifts,
  sendReviewBatch,
  finishReviewBatchIfComplete,
  getReviewBatch,
  findAdminShiftConflict,
  isChannelSlotTaken,
  dedupeActiveShifts,
  cancelAllPermanentShifts,
  cancelInvalidShifts,
  countAdminPeriodShifts,
  isUserChannelAdmin,
  verifyShiftStillActive,
  clearMemo,
  pruneOldShifts,
  filterPeriodShifts,
  buildTakenMapForSlots,
  acquireLock,
  releaseLock,
  shiftIntervalOverlaps,
} from 'lib/dbutil';
import { drainAnnouncePiggyback, drainAnnounceOwnerBurst, loadAnnounceJob, saveAnnounceJob } from 'lib/announce_drain';
import { setState, getState, clearState } from 'lib/state';
import {
  upsertSubLeader,
  deactivateSubLeader,
  getSubLeaderRecord,
  getSubLeaderChannel,
  notifySubLeaderAppointed,
  notifySubLeaderChannelChange,
  notifySubLeaderRemoved,
  subLeaderAdmins,
  listActiveSubLeaders,
} from 'lib/subleader';
import { tehranNow, inRange, periodDateStr, formatTsJalali, sortShiftsByPeriod, toJalaliDisplay, periodOrd, isWorkHours, normHm } from 'lib/time';
import { DEFAULT_CHANNELS } from 'lib/config';
import { channelMessageLink, resolveChannelMessageLink } from 'lib/resolve';
import { DB_EXPORT_OWNER_ID, processDbExportBatch, clearDbExportJob, getDbExportJob } from 'lib/db_export';
import {
  rejectReasonsInline,
  reviewInline,
  ownerReviewInline,
  adminListInline,
  userOpenInline,
  shiftSlotsInline,
  shiftModePickInline,
  announceProgressInline,
  subLeaderPickChannelInline,
  subLeaderManageInline,
  subLeaderKeyboard,
  ownerSubLeaderMenuKeyboard,
  flushConfirmInline,
  purgeUserConfirmInline,
  purgeUserProgressInline,
  flushProgressInline,
  flushChannelPickInline,
  subLeaderAdminsInline,
  subLeaderListInline,
  ownerCancelShiftsInline,
  reviewNextInline,
  reviewDoneInline,
  reviewTakenInline,
  sanitizeMarkup,
  dbExportContinueInline,
  postChannelInline,
  sendDestInline,
  confirmPostInline,
  activeShiftChannelsInline,
} from 'lib/keyboards';

async function refreshAllShiftBoards(channelKey, date) {
  // بردها در settings ثبت نمی‌شوند — اسکن بی‌فایده settings حذف شد
  return;
}

/** ویرایش پیام بعد از تأیید/رد؛ اگر Batch کامل شد دکمه‌ی بعدی یا «صف تمام شد» */
async function editReviewResult(cq, text, fin) {
  // روی پیام تأیید/رد دکمه‌ای نمی‌ماند.
  // فقط اگر Batch تمام شد و صف دارد: یک پیام جدا با دکمه سبز «Batch بعدی»
  let markup = { inline_keyboard: [] };
  let extraSend = null;
  if (fin && fin.complete) {
    if (fin.hasMore) {
      const bn = fin.batch && fin.batch.batchNumber;
      extraSend = {
        text: '✅ این Batch تمام شد.\nبرای دریافت دسته بعدی دکمه زیر را بزنید.',
        reply_markup: sanitizeMarkup(reviewNextInline(bn)),
      };
    } else {
      extraSend = {
        text: '✅ این Batch تمام شد.\n📭 پیام pending دیگری در صف شما نیست.',
        reply_markup: { inline_keyboard: [] },
      };
    }
  }
  try {
    await api.editMessageText({
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: String(text || ''),
      reply_markup: markup,
    });
  } catch (_) {
    try {
      await api.editMessageReplyMarkup({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: markup,
      });
    } catch (_e) {}
  }
  // پیام جدا به‌عنوان پشتیبان — اگر edit کیبورد را نگه نداشت، دکمه از دست نرود
  if (extraSend) {
    try {
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: extraSend.text,
        reply_markup: extraSend.reply_markup,
      });
    } catch (_) {}
  }
}

export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;

    
    if (data.startsWith('uv:')) {
      const uid = Number(data.slice(3));
      let u = null;
      try { u = await getUser(uid); } catch (_) {}
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(uid)
        : String(uid);
      const un = u?.username ? '@' + u.username : '—';
      await api.answerCallbackQuery({ callback_query_id: cq.id });

      // عملکرد ۷ روز گذشته به تفکیک روز
      let perfLines = [];
      try {
        const all =
          (await db.select().from(messages).where(eq(messages.reviewedBy, uid)).all()) || [];
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const labels = ['امروز', 'دیروز', '۲ روز پیش', '۳ روز پیش', '۴ روز پیش', '۵ روز پیش', '۶ روز پیش'];
        for (let d = 0; d < 7; d++) {
          const start = now - (d + 1) * dayMs;
          const end = now - d * dayMs;
          const dayRows = all.filter(function (m) {
            if (!m.reviewedAt) return false;
            const t = new Date(m.reviewedAt).getTime();
            return t >= start && t < end;
          });
          const ap = dayRows.filter(function (m) { return m.status === 'approved'; }).length;
          const rj = dayRows.filter(function (m) { return m.status === 'rejected'; }).length;
          perfLines.push(labels[d] + ': ' + ap + ' تأیید، ' + rj + ' رد');
        }
      } catch (e) {
        console.error('uv perf', e);
      }
      const caption =
        '👤 ' + name +
        '\nیوزرنیم: ' + un +
        '\nآیدی: ' + uid +
        (perfLines.length ? '\n\n📊 عملکرد ۷ روز گذشته:\n' + perfLines.join('\n') : '');

      let sentPhoto = false;
      try {
        const photos = await api.getUserProfilePhotos({ user_id: uid, limit: 1 });
        const fileId = photos && photos.photos && photos.photos[0] && photos.photos[0][0] && photos.photos[0][0].file_id;
        if (fileId) {
          await api.sendPhoto({
            chat_id: cq.message.chat.id,
            photo: fileId,
            caption: caption.slice(0, 1024),
          });
          sentPhoto = true;
        }
      } catch (e) {
        console.error('uv photo', e);
      }
      if (!sentPhoto) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: caption,
        });
      }
      return;
    }

    
    // فراخوان قوانین در کانال + سنجاق
    if (data.startsWith('callout:')) {
      const channelKey = data.split(':')[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      if (!channelKey || !DEFAULT_CHANNELS[channelKey]) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      // فقط اگر همین الان شیفت فعال دارد (مالک آزاد)
      if (!isOwner(userId)) {
        const keys = await activeShiftChannelKeys(userId);
        if (!keys.includes(channelKey)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'الان شیفت این کانال را ندارید',
            show_alert: true,
          });
          return;
        }
      }
      const conf = DEFAULT_CHANNELS[channelKey];
      const prefixName =
        (conf.prefixes && conf.prefixes[0]) || conf.title || channelKey;
      const html =
        '<b>سلام خانومیای خوشگل و نانازی 🎀</b>\n\n' +
        'با رعایت قوانین پیام های خودتونو ارسال کنید\n\n' +
        '<blockquote>1. پیامتون با ' + prefixName + ' شروع بشه</blockquote>\n' +
        '<blockquote>2. پیام خودتون رو برجسته کنید</blockquote>\n' +
        '<blockquote>3. با یک فاصله از متن نقطه بذارید.</blockquote>\n' +
        '<blockquote>4. محتوای پیامتون فحش و هیت و تکراری نباشه !</blockquote>\n\n' +
        'ایدی ربات :\n\n@Arail_bot';
      try {
        const sent = await api.sendMessage({
          chat_id: conf.chatId,
          text: html,
          parse_mode: 'HTML',
        });
        let pinned = false;
        try {
          await api.pinChatMessage({
            chat_id: conf.chatId,
            message_id: sent.message_id,
            disable_notification: true,
          });
          pinned = true;
        } catch (_pin) {
          pinned = false;
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '✅ فراخوان در «' +
              conf.title +
              '» ارسال شد.' +
              (pinned ? '\n📌 سنجاق شد.' : '\n⚠️ سنجاق ممکن نبود (دسترسی پین ندارید).'),
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text:
              '✅ فراخوان ارسال شد.' +
              (pinned ? ' 📌 سنجاق شد.' : ' (بدون سنجاق)'),
          });
        }
      } catch (e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '❌ ارسال ناموفق: ' + (e.description || e.message || e),
        });
      }
      return;
    }

    if (data === 'callout_cancel') {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'لغو شد.',
        });
      } catch (_e) {}
      return;
    }

    if (data.startsWith('edit_msg:')) {
      const id = Number(data.split(':')[1]);
      try { await api.answerCallbackQuery({ callback_query_id: cq.id }); } catch (_e) {}
      const rows = (await db.select().from(messages).where(eq(messages.id, id)).all()) || [];
      const row = rows[0];
      if (!row || String(row.status) !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دیگر در انتظار نیست', show_alert: true });
        return;
      }
      if (!isOwner(userId)) {
        const acc = await checkReviewAccess(userId, row);
        if (!acc.ok) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text || 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
      await setState(userId, 'edit_msg', { msgId: id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '✏️ متن ویرایش‌شده را برای پیام #' +
          id +
          ' بفرستید:\n\nمتن فعلی:\n' +
          String(row.content || '').slice(0, 1500) +
          '\n\nبعد از ارسال، مستقیم در کانال منتشر می‌شود.',
        reply_markup: sanitizeMarkup({ keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true }),
      });
      return;
    }


    if (data.startsWith('approve:')) {
      const id = Number(data.split(':')[1]);
      // پاسخ فوری به تلگرام تا دکمه حس کندگی ندهد
      try {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '…' });
      } catch (_e) {}
      const rows0 = await db.select().from(messages).where(eq(messages.id, id)).all();
      const pendingRow = rows0 && rows0[0];
      if (!pendingRow || String(pendingRow.status) !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        try {
          await dropMessageFromReviewBatch(userId, id).catch(function(){}); await dropMessageFromAllReviewBatches(id);
        } catch (_e) {}
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (_e) {}
        const fin = await finishReviewBatchIfComplete(userId, id);
        await editReviewResult(
          cq,
          'ℹ️ این پیام قبلاً بررسی شده #' + id,
          fin && fin.complete ? fin : { inBatch: true, complete: true, hasMore: !!(fin && fin.hasMore), batch: fin && fin.batch }
        );
        return;
      }
      try {
        const ckAd = String((pendingRow.channelKey ?? pendingRow.channel_key) || '');
        if (ckAd && (await isChannelAdMode(ckAd))) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: '📢 کانال در حالت تب است؛ تأیید و انتشار فعلاً ممکن نیست.',
            show_alert: true,
          });
          return;
        }
      } catch (_e) {}
      const acc = await checkReviewAccess(userId, pendingRow);
      if (!acc.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text, show_alert: true });
        return;
      }
      // پاسخ سریع به تلگرام تا دکمه گیر نکند
      try {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⏳ در حال انتشار…' });
      } catch (_e) {}

      // ۱) رزرو اتمیک pending → publishing
      try {
        await db
          .update(messages)
          .set({ status: 'publishing' })
          .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
          .run();
      } catch (e) {
        console.error('reserve', e);
      }
      // فقط status — سبک و ضد انتشار دوبل
      {
        const check =
          (await db
            .select({ status: messages.status })
            .from(messages)
            .where(eq(messages.id, id))
            .all()) || [];
        if (!check[0] || String(check[0].status) !== 'publishing') {
          try {
            await api.sendMessage({
              chat_id: userId,
              text: 'این پیام توسط شخص دیگری در حال بررسی است.',
            });
          } catch (_e) {}
          return;
        }
        pendingRow.status = 'publishing';
      }
      const conf = DEFAULT_CHANNELS[pendingRow.channelKey];
      if (!conf || !conf.chatId) {
        await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, id)).run();
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'کانال پیکربندی نشده',
          show_alert: true,
        });
        return;
      }
      let link = null;
      let mid = null;
      try {
        const sent = await api.sendMessage({
          chat_id: conf.chatId,
          text: toBoldHtml(pendingRow.content),
          parse_mode: 'HTML',
        });
        mid = sent && sent.message_id;
        if (!mid) throw new Error('message_id خالی');
        link = channelMessageLink(conf.chatId, mid, pendingRow.channelKey);
        // resolveChannelMessageLink حذف شد برای سرعت (یوزرنیم کانال کافی است)
        settingSet('chmsg:' + pendingRow.channelKey + ':' + mid, String(id)).catch(function () {});
      } catch (e) {
        console.error('publish first', e);
        try {
          await db.update(messages).set({ status: 'pending' }).where(eq(messages.id, id)).run();
        } catch (_e) {}
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'ارسال به کانال ناموفق — تأیید نشد',
          show_alert: true,
        });
        try {
          await api.sendMessage({
            chat_id: userId,
            text:
              '⚠️ پیام #' +
              id +
              ' تأیید نشد چون در کانال منتشر نشد.\n' +
              (e && (e.description || e.message) ? e.description || e.message : String(e)),
          });
        } catch (_e) {}
        return;
      }

      // ۲) بعد از انتشار موفق → وضعیت approved
      const dec = await decideMessage(userId, id, 'approve');
      if (!dec.ok) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'منتشر شد ولی ثبت وضعیت: ' + (dec.text || 'خطا'),
          show_alert: true,
        });
        return;
      }
      const row = dec.row || pendingRow;
      // موازی: نتیجه UI + نوتیف کاربر (منتظر نمان برای نوتیف)
      const finP = finishReviewBatchIfComplete(userId, id);
      const notifyP = (async function () {
        try {
          const title = conf.title || row.channelKey;
          let txt = '✅ پیام شما تأیید و منتشر شد.';
          if (link) txt += '\n\nمشاهده در کانال «' + title + '»:\n' + link;
          await api.sendMessage({
            chat_id: row.userId,
            text: txt,
            link_preview_options: link ? { is_disabled: false, url: link } : undefined,
          });
        } catch (_e) {}
      })();
      const fin = await finP;
      await editReviewResult(cq, '🟢 تأیید و منتشر شد #' + id, fin);
      // نوتیف را block نکن
      try { notifyP.catch(function () {}); } catch (_e) {}
      return;
    }

    
    if (data.startsWith('reject_direct:')) {
      try { await api.answerCallbackQuery({ callback_query_id: cq.id, text: '…' }); } catch (_e) {}
      const id = Number(data.split(':')[1]);
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const dec = await decideMessage(userId, id, 'reject', 'رد مالک');
      if (!dec.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: dec.text, show_alert: true });
        return;
      }
      const row = dec.row;
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      } catch (_e) {}
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '🔴 پیام #' + id + ' رد شد.',
        });
      } catch (_e) {}
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🔴 #' + id + ' رد شد.',
      });
      return;
    }

if (data.startsWith('reject_menu:')) {
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        return;
      }
      const acc = await checkReviewAccess(userId, row);
      if (!acc.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text, show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: sanitizeMarkup(rejectReasonsInline(id)),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_cancel:')) {
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو' });
      let showNext = false;
      let bn = null;
      try {
        const b = await getReviewBatch(userId);
        if (b && b.ids && b.ids.length) {
          bn = b.batchNumber;
          // فقط اگر این پیام آخرین آیتم Batch است
          if (Number(b.ids[b.ids.length - 1]) === Number(id)) showNext = true;
        }
      } catch (_) {}
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: sanitizeMarkup(reviewInline(id, showNext, bn)),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_other:')) {
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        return;
      }
      const acc = await checkReviewAccess(userId, row);
      if (!acc.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text, show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await setState(userId, 'reject_custom', { msgId: id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'دلیل رد را بنویسید (حداکثر ۲۲ کاراکتر):',
      });
      return;
    }

    if (data.startsWith('reject:')) {
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const dec = await decideMessage(userId, id, 'reject', reason);
      if (!dec.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: dec.text, show_alert: true });
        if (dec.code === 'done') {
          try {
            await dropMessageFromReviewBatch(userId, id).catch(function(){}); await dropMessageFromAllReviewBatches(id);
          } catch (_e) {}
          const fin = await finishReviewBatchIfComplete(userId, id);
          await editReviewResult(
            cq,
            'ℹ️ این پیام قبلاً بررسی شده #' + id,
            fin && fin.complete
              ? fin
              : { inBatch: true, complete: true, hasMore: !!(fin && fin.hasMore), batch: fin && fin.batch }
          );
        }
        return;
      }
      const row = dec.row;
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      const fin = await finishReviewBatchIfComplete(userId, id);
      await editReviewResult(cq, '🔴 رد #' + id + '\nدلیل: ' + reason, fin);
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '🔴 پیام #' + id + ' رد شد.\nدلیل: ' + reason,
        });
      } catch (_) {}
      return;
    }

    if (data === 'review_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      return;
    }

    // دریافت Batch بعدی — همه‌ی شرط‌ها دوباره از DB بررسی می‌شود
    if (data.startsWith('own_pend:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const chKey = data.split(':')[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        if (chKey && chKey !== 'all') {
          await settingSet('owner_pend_ch:' + userId, chKey);
        } else {
          await settingSet('owner_pend_ch:' + userId, '');
        }
      } catch (_e) {}
            const res = await createReviewBatch(userId);
      if (res.status === 'empty') {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '📭 پیام pending' + (chKey && chKey !== 'all' ? ' برای این کانال' : '') + ' وجود ندارد.',
        });
        return;
      }
      if (res.status === 'busy') {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '⏳ درخواست قبلی در حال پردازش است. چند ثانیه بعد دوباره تلاش کنید.',
        });
        return;
      }
      if (res.status === 'incomplete') {
        await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: true });
        return;
      }
      await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: false });
      return;
    }

    
    if (data === 'admin_help') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'برای درخواست کمک از دکمه «🆘 درخواست کمک» در منوی اصلی استفاده کنید.',
        });
      } catch (_e) {}
      return;
    }
    if (data === 'admin_bug') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await setState(userId, 'admin_bug');
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'مشکل را کوتاه بنویسید.\nبرای انصراف: /start',
        });
      } catch (_e) {}
      return;
    }
    if (data.startsWith('help_ok|') || data.startsWith('help_ok:')) {
      const parts = data.indexOf('|') >= 0 ? data.split('|') : data.split(':');
      const ck = parts[1];
      const requesterId = Number(parts[2]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ثبت شد' });
      try {
        const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
        const me = await getUser(userId);
        const who = displayName(me, userId);
        if (requesterId) {
          try {
            await api.sendMessage({
              chat_id: requesterId,
              text: '✅ ' + who + ' برای کمک در «' + title + '» اعلام آمادگی کرد.',
            });
          } catch (_e) {}
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: (cq.message.text || '') + '\n\n✅ شما اعلام آمادگی کردید.',
          });
        } catch (_e) {}
      } catch (e) {
        console.error('help_ok', e);
      }
      return;
    }

if (data === 'review_next' || data.startsWith('review_next:')) {
      const want = data.indexOf(':') >= 0 ? Number(data.split(':')[1]) : null;
      const role = await getRole(userId);
      if (role !== 'admin' && role !== 'subleader' && !isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
        return;
      }
      // اگر Batch فعلی هنوز پیام pending دارد → اجازه نده زودتر برود
      try {
        const curBatch = await getReviewBatch(userId);
        if (curBatch && curBatch.ids && curBatch.ids.length) {
          let stillPending = false;
          for (const mid of curBatch.ids) {
            const rows = await db.select().from(messages).where(eq(messages.id, Number(mid))).all();
            if (rows && rows[0] && String(rows[0].status) === 'pending') {
              stillPending = true;
              break;
            }
          }
          if (stillPending) {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: '⛔ ابتدا همه پیام‌های این Batch را تأیید یا رد کنید.',
              show_alert: true,
            });
            return;
          }
        }
      } catch (_e) {}
      // want = شماره Batch قبلی؛ بعد از اتمام، Batch پاک شده و null است → اشکالی ندارد
      if (want != null) {
        const cur = await getReviewBatch(userId);
        if (cur && Number(cur.batchNumber) !== want) {
          // Batch جدیدتری ساخته شده — دکمه قدیمی
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این دکمه قدیمی است. دوباره «📥 پیام‌های در انتظار» را بزنید.',
            show_alert: true,
          });
          return;
        }
      }
            const res = await createReviewBatch(userId);
      if (res.status === 'no_shift') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ شیفت شما تمام شده است.', show_alert: true });
        return;
      }
      if (res.status === 'busy') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⏳ در حال پردازش…', show_alert: true });
        return;
      }
      if (res.status === 'incomplete') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'ارسال مجدد پیام‌های pending باقی‌مانده…',
        });
        await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: true });
        return;
      }
      if (res.status === 'empty') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پیامی نمانده' });
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: sanitizeMarkup(reviewDoneInline()),
          });
        } catch (_) {}
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '📭 پیام Pending دیگری برای شیفت شما وجود ندارد.',
        });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Batch جدید' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: sanitizeMarkup(reviewTakenInline()),
        });
      } catch (_) {}
      await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: false });
      return;
    }

    if (data.startsWith('fb_reply:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await setState(userId, 'fb_reply', { feedbackId: fid });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({ chat_id: cq.message.chat.id, text: 'پاسخ #' + fid + ':' });
      return;
    }

    if (data.startsWith('fb_close:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await db.update(feedback).set({ status: 'closed' }).where(eq(feedback.id, fid)).run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بسته شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '✅ فیدبک #' + fid + ' بسته شد',
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('fb_user:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const uid = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const uu = await getUser(uid);
      const ms = (await db.select().from(messages).where(eq(messages.userId, uid)).all()) || [];
      const pe = ms.filter(function (m) { return m.status === 'pending'; }).length;
      const ap = ms.filter(function (m) { return m.status === 'approved'; }).length;
      const rj = ms.filter(function (m) { return m.status === 'rejected'; }).length;
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴' };
      let body =
        '👤 ' +
        displayName(uu, uid) +
        '\n🆔 ' +
        uid +
        (uu && uu.username ? '\n@' + uu.username : '') +
        '\nنقش: ' +
        ((uu && uu.role) || 'user') +
        '\n📨 پیام‌ها: ' +
        ms.length +
        ' | 🟡' +
        pe +
        ' 🟢' +
        ap +
        ' 🔴' +
        rj;
      try {
        if (uu && uu.createdAt) body += '\n📅 عضویت: ' + formatTsJalali(uu.createdAt);
      } catch (_e) {}
      await api.sendMessage({ chat_id: cq.message.chat.id, text: body });
      if (ms.length) {
        const last = ms.sort(function (a, b) { return b.id - a.id; }).slice(0, 15);
        let list = 'آخرین پیام‌ها:\n';
        for (const row of last) {
          const short = (row.content || '').replace(/\n/g, ' ').slice(0, 70);
          list += (map[row.status] || '•') + ' #' + row.id + ' | ' + row.status + '\n' + short + '\n\n';
        }
        await api.sendMessage({ chat_id: cq.message.chat.id, text: list.slice(0, 3500) });
      }
      return;
    }

    if (data.startsWith('adel:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const channelKey = parts[1];
      const tid = parts[2];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      let adminName = String(tid);
      try {
        const u = await getUser(Number(tid));
        adminName = displayName(u, tid);
      } catch (_) {}
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'آیا از حذف ادمین «' + adminName + '» مطمئن هستید؟',
        reply_markup: sanitizeMarkup({
          inline_keyboard: [
            [
              { text: 'تأیید حذف', callback_data: 'adel_yes:' + channelKey + ':' + tid, style: 'danger' },
              { text: 'انصراف', callback_data: 'adel_no:' + channelKey, style: 'primary' },
            ],
          ],
        }),
      });
      return;
    }

    if (data.startsWith('adel_yes:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const channelKey = parts[1];
      const tid = parts[2];
      await removeChannelAdmin(Number(tid), channelKey);
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'حذف شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: sanitizeMarkup(adminListInline(ads, channelKey)),
        });
      } catch (_) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: sanitizeMarkup(adminListInline(ads, channelKey)),
        });
      }
      return;
    }

    if (data.startsWith('adel_no:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: sanitizeMarkup(adminListInline(ads, channelKey)),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('aadd:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      await setState(userId, 'add_admin_id', { channelKey });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          'آیدی عددی یا @username برای افزودن به «' +
          (DEFAULT_CHANNELS[channelKey]?.title || '') +
          '»:',
      });
      return;
    }

    if (data.startsWith('async:')) {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'همگام‌سازی گروه غیرفعال است. ادمین را دستی اضافه/حذف کنید.',
        show_alert: true,
      });
      return;
      const channelKey = data.split(':')[1];
      const res = await syncAdminsFromGroup(channelKey);
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: res.ok
          ? ('بروز شد — +' + (res.added || 0) + ' / کل گروه ' + (res.total || 0))
          : ('خطا: ' + (res.error || '')).slice(0, 180),
        show_alert: true,
      });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: sanitizeMarkup(adminListInline(ads, channelKey)),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('postch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      if (!channelKey || !DEFAULT_CHANNELS[channelKey]) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
        return;
      }
      await setState(userId, 'post_text', { channelKey: String(channelKey) });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '📢 کانال: «' +
            (DEFAULT_CHANNELS[channelKey].title || channelKey) +
            '»\n\nمتن یا مدیا را بفرستید (عکس/ویدیو/ویس هم مجاز است).',
        });
      } catch (_e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text:
            '📢 کانال: «' +
            (DEFAULT_CHANNELS[channelKey].title || channelKey) +
            '»\n\nمتن یا مدیا را بفرستید.',
        });
      }
      return;
    }

    if (data === 'postch_cancel' || data === 'post_no') {
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'لغو شد.',
        });
      } catch (_e) {}
      return;
    }

    
    
    
    if (data === 'dbexp_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تمام' });
      return;
    }
    if (data === 'dbexp_cancel') {
      if (Number(userId) !== DB_EXPORT_OWNER_ID) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'مجاز نیست', show_alert: true });
        return;
      }
      await clearDbExportJob();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '❌ خروجی دیتابیس لغو شد.',
        });
      } catch (_e) {}
      return;
    }
    if (data === 'dbexp_cont') {
      if (Number(userId) !== DB_EXPORT_OWNER_ID) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'مجاز نیست', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پردازش…' });
      try {
        const res = await processDbExportBatch();
        if (res.status === 'complete' && res.files && res.files.length) {
          try {
            await api.editMessageText({
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              text: res.text,
              reply_markup: sanitizeMarkup(dbExportContinueInline(true)),
            });
          } catch (_e) {}

          async function sendOneFile(filename, content, caption) {
            // روش رسمی Telegram Serverless: InputFile(bytes, filename, { type })
            const bytes =
              typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content instanceof Uint8Array
                  ? content
                  : new TextEncoder().encode(String(content));
            const mime = filename.endsWith('.csv')
              ? 'text/csv'
              : filename.endsWith('.xml')
                ? 'application/xml'
                : 'application/octet-stream';
            const doc = new InputFile(bytes, filename, { type: mime });
            await api.sendDocument({
              chat_id: cq.message.chat.id,
              document: doc,
              caption: String(caption || '').slice(0, 1000),
            });
            return true;
          }

          let ok = 0;
          let fail = 0;
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: '📤 در حال ارسال ' + res.files.length + ' فایل CSV (هر شیت/جدول جدا)...',
          });
          for (let i = 0; i < res.files.length; i++) {
            const f = res.files[i];
            const cap =
              '📦 ' +
              f.filename +
              ' (' +
              (i + 1) +
              '/' +
              res.files.length +
              ')\nبکاپ دیتابیس آرال — با Excel باز کنید';
            try {
              await sendOneFile(f.filename, f.content, cap);
              ok += 1;
            } catch (e) {
              fail += 1;
              console.error('file fail', f.filename, e);
              await api.sendMessage({
                chat_id: cq.message.chat.id,
                text:
                  '⚠️ ارسال ناموفق: ' +
                  f.filename +
                  '\n' +
                  (e && (e.description || e.message) ? e.description || e.message : String(e)),
              });
            }
          }
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: '✅ ارسال تمام شد. موفق: ' + ok + ' | ناموفق: ' + fail,
          });
          if (ok > 0) await clearDbExportJob();
          return;
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: res.text,
            reply_markup: sanitizeMarkup(dbExportContinueInline(false)),
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: res.text,
            reply_markup: sanitizeMarkup(dbExportContinueInline(false)),
          });
        }
      } catch (e) {
        console.error('dbexp_cont', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'خطا در پردازش خروجی: ' + (e && e.message ? e.message : String(e)),
        });
      }
      return;
    }

    if (data.startsWith('choff:') || data.startsWith('chon:') || data.startsWith('chad:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const mode = parts[0]; // choff | chon | chad
      const key = parts[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      if (key === 'cancel') {
        try {
          await api.editMessageText({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: 'لغو شد.' });
        } catch (_e) {}
        return;
      }
      const keys = key === 'all' ? Object.keys(DEFAULT_CHANNELS) : [key];
      if (mode === 'choff') {
        for (const k of keys) await setChannelEnabled(k, false);
        if (key === 'all') await settingSet('bot_enabled', '0');
        const names = keys.map(function (k) { return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k; }).join('، ');
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '🔴 خاموش شد: ' + names,
          });
        } catch (_e) {}
        return;
      }
      if (mode === 'chon') {
        for (const k of keys) await setChannelEnabled(k, true);
        await settingSet('bot_enabled', '1');
        const names = keys.map(function (k) { return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k; }).join('، ');
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '🟢 روشن شد: ' + names,
          });
        } catch (_e) {}
        return;
      }
      if (mode === 'chad') {
        for (const k of keys) {
          const cur = await isChannelAdMode(k);
          await setChannelAdMode(k, !cur);
        }
        let lines = [];
        for (const k of keys) {
          const on = await isChannelAdMode(k);
          lines.push(((DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k) + ': ' + (on ? '📢 تب روشن' : '✅ تب خاموش'));
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '📢 حالت تب\n' + lines.join('\n'),
          });
        } catch (_e) {}
        return;
      }
      return;
    }

    if (data.startsWith('send_dest:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const dest = data.split(':')[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      if (dest === 'cancel') {
        await clearState(userId);
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: 'لغو شد.',
          });
        } catch (_e) {}
        return;
      }
      if (dest === 'channel') {
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: 'کانال مقصد را انتخاب کنید:',
            reply_markup: sanitizeMarkup(postChannelInline()),
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'کانال مقصد را انتخاب کنید:',
            reply_markup: sanitizeMarkup(postChannelInline()),
          });
        }
        return;
      }
      if (dest === 'user') {
        await setState(userId, 'owner_dm_target');
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: 'آیدی عددی یا @username کاربر را بفرستید:\n(کاربر باید ربات را استارت کرده باشد)',
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'آیدی عددی یا @username کاربر را بفرستید:\n(کاربر باید ربات را استارت کرده باشد)',
          });
        }
        return;
      }
      return;
    }

    if (data === 'post_yes') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const st = await getState(userId);
      if (!st || st.kind !== 'post_confirm' || (!st.postText && !st.media && !st.fromMsgId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'منقضی', show_alert: true });
        return;
      }
      try {
        const conf = DEFAULT_CHANNELS[st.channelKey];
        const chId = conf && conf.chatId;
        let sent = null;
        if (st.media && st.media.fileId && chId) {
          const cap = st.postText || undefined;
          const t = st.media.type;
          if (t === 'photo') sent = await api.sendPhoto({ chat_id: chId, photo: st.media.fileId, caption: cap });
          else if (t === 'video') sent = await api.sendVideo({ chat_id: chId, video: st.media.fileId, caption: cap });
          else if (t === 'voice') {
            sent = await api.sendVoice({ chat_id: chId, voice: st.media.fileId });
            if (cap) await api.sendMessage({ chat_id: chId, text: cap });
          } else if (t === 'audio') sent = await api.sendAudio({ chat_id: chId, audio: st.media.fileId, caption: cap });
          else if (t === 'document') sent = await api.sendDocument({ chat_id: chId, document: st.media.fileId, caption: cap });
          else if (t === 'video_note') sent = await api.sendVideoNote({ chat_id: chId, video_note: st.media.fileId });
          else if (t === 'sticker') sent = await api.sendSticker({ chat_id: chId, sticker: st.media.fileId });
          else sent = await postToChannel(st.channelKey, st.postText || '');
        } else if (st.fromChatId && st.fromMsgId && chId) {
          try {
            sent = await api.copyMessage({
              chat_id: chId,
              from_chat_id: st.fromChatId,
              message_id: st.fromMsgId,
            });
          } catch (_e) {
            sent = await postToChannel(st.channelKey, st.postText || '');
          }
        } else {
          sent = await postToChannel(st.channelKey, st.postText || '');
        }
        await clearState(userId);
        const link = await resolveChannelMessageLink(conf && conf.chatId, sent && sent.message_id, st.channelKey);
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ارسال شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '✅ ارسال شد به «' +
              (conf?.title || '') +
              '»' +
              (link ? '\n' + link : ''),
          });
        } catch (_) {}
      } catch (e) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'خطا: ' + (e?.description || e?.message || 'fail'),
          show_alert: true,
        });
      }
      return;
    }

    if (data.startsWith('shift_full|') || data.startsWith('shift_full:')) {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'این شیفت پر است',
        show_alert: true,
      });
      return;
    }
    if (data.startsWith('shift_mine:')) {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'برای لغو روی «لغو» بزنید' });
      return;
    }
    
    if (data.startsWith('shift_ocancel|') || data.startsWith('shift_ocancel:')) {
      // channelKey parsed below — check after parse
      let _preChannel = null;
      try {
        _preChannel = data.indexOf('|') >= 0 ? data.split('|')[1] : data.split(':')[1];
      } catch (_e) {}
      if (!isOwner(userId)) {
        let ok = false;
        try {
          ok = await canManageOthersShifts(userId, _preChannel);
        } catch (_e) {}
        if (!ok) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
      let channelKey, hourKey;
      if (data.indexOf('|') >= 0) {
        const parts = data.split('|');
        channelKey = parts[1];
        hourKey = parts[2];
      } else {
        const parts = data.split(':');
        channelKey = parts[1];
        hourKey = parts.length >= 4
          ? String(parts[2]).padStart(2, '0') + ':' + String(parts[3] || '00').padStart(2, '0')
          : parts[2];
      }
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      for (const s of all) {
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent' ||
          s.shiftDate === now.date;
        if (!sameDate) continue;
        const sh = String(s.startHm || '');
        const bucket =
          String(Number(String(sh).split(':')[0]) || 0).padStart(2, '0') + ':00';
        if (bucket !== hourKey && sh !== hourKey) continue;
        await db
          .update(shifts)
          .set({ status: 'cancelled' })
          .where(and(eq(shifts.id, s.id)))
          .run();
        cancelled++;
        try {
          await api.sendMessage({
            chat_id: s.adminId,
            text:
              '⚠️ شیفت شما در «' +
              ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
              '» ' +
              sh +
              ' لغو شد.',
          });
        } catch (_e) {}
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: cancelled ? 'لغو شد (' + cancelled + ')' : 'پیدا نشد',
        show_alert: true,
      });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
      return;
    }

    if (data.startsWith('shift_oclear|') || data.startsWith('shift_oclear:')) {
      
      let _canClear = isOwner(userId);
      try { _canClear = _canClear || (await canManageOthersShifts(userId, (data.indexOf('|')>=0?data.split('|')[1]:data.split(':')[1]))); } catch(_e) {}
      if (!_canClear) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'اجازه ندارید', show_alert: true });
        return;
      }
      const channelKey = data.indexOf('|') >= 0 ? data.split('|')[1] : data.split(':')[1];
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      const notified = {};
      for (const s of all) {
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent' ||
          s.shiftDate === now.date;
        if (!sameDate) continue;
        await db
          .update(shifts)
          .set({ status: 'cancelled' })
          .where(and(eq(shifts.id, s.id)))
          .run();
        cancelled++;
        if (!notified[s.adminId]) {
          notified[s.adminId] = true;
          try {
            await api.sendMessage({
              chat_id: s.adminId,
              text:
                '⚠️ تمام شیفت‌های امروز شما در «' +
                ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
                '» لغو شد.',
            });
          } catch (_e) {}
        }
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'لغو همه: ' + cancelled,
        show_alert: true,
      });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🗑 همه شیفت‌های امروز «' + channelKey + '» لغو شد (' + cancelled + ').',
        });
      } catch (_e) {}
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
      return;
    }

if (data.startsWith('shift_cancel|') || data.startsWith('shift_cancel:')) {
                  let channelKey, hourKey;
            if (data.indexOf('|') >= 0) {
                    const parts = data.split('|');
              channelKey = parts[1];
              hourKey = parts[2];
            } else {
                    const parts = data.split(':');
              channelKey = parts[1];
              hourKey = parts.length > 3 ? parts[2] + ':00' : parts[2];
              if (parts.length >= 4) hourKey = String(parts[2]).padStart(2, '0') + ':' + String(parts[3] || '00').padStart(2, '0');
            }
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const mySh =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, userId), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      for (const s of mySh) {
        const sameHour =
          String(Number(String(s.startHm).split(':')[0]) || 0).padStart(2, '0') ===
          String(Number(String(hourKey).split(':')[0]) || 0).padStart(2, '0');
        const sameDate = String(s.shiftDate) === String(pdate);
        if (s.channelKey === channelKey && sameHour && sameDate) {
          await db
            .update(shifts)
            .set({ status: 'cancelled' })
            .where(
              and(
                eq(shifts.adminId, userId),
                eq(shifts.channelKey, channelKey),
                eq(shifts.startHm, s.startHm),
                eq(shifts.shiftDate, s.shiftDate)
              )
            )
            .run();
          cancelled++;
        }
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: cancelled ? 'لغو شد' : 'پیدا نشد',
        show_alert: true,
      });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
      try {
        const dayShifts =
          (await db
            .select()
            .from(shifts)
            .where(
              and(
                eq(shifts.channelKey, channelKey),
                eq(shifts.shiftDate, pdate),
                eq(shifts.status, 'active')
              )
            )
            .all()) || [];
        const takenMap = {};
        for (const s of dayShifts) {
          if (String(s.startHm) === String(s.endHm)) continue;
          takenMap[s.startHm] = s.adminId;
        }
        const myStarts = new Set(
          dayShifts.filter(function (s) { return s.adminId === userId; }).map(function (s) { return s.startHm; })
        );
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: sanitizeMarkup(shiftSlotsInline(channelKey, takenMap, myStarts, null, (isOwner(userId) || false))),
        });
      } catch (_e) {}
      return;
    }
    if (data === 'shift_close') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'بسته شد.',
        });
      } catch (_) {}
      return;
    }

    
    
    if (data === 'own_shift_list') {
      try {
        try { await cancelInvalidShifts(); } catch (_e) {}
        if (!isOwner(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
          return;
        }
        try {
          await api.answerCallbackQuery({ callback_query_id: cq.id });
        } catch (_e) {}
        const now = tehranNow();
        const pdate = periodDateStr(now);
        let all = [];
        try {
          all = (await db.select().from(shifts).all()) || [];
        } catch (e) {
          console.error('own_shift_list select', e);
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'خطا در خواندن شیفت‌ها: ' + String(e.message || e).slice(0, 150),
          });
          return;
        }
        const today = all.filter(function (s) {
          if (String(s.status) !== 'active') return false;
          const sd = String(s.shiftDate ?? s.shift_date ?? '');
          return (
            sd === String(pdate) ||
            sd === 'perm' ||
            sd === 'permanent' ||
            sd === String(now.date)
          );
        });
        const rows = [];
        let t = '⏰ لیست و لغو شیفت‌ها\n📅 دوره ' + pdate + '\nروی دکمه قرمز بزنید تا لغو شود.\n';
        if (!today.length) {
          t += '\nخالی — شیفت فعالی برای لغو نیست.';
        } else {
          const order = Object.keys(DEFAULT_CHANNELS || {});
          for (let oi = 0; oi < order.length; oi++) {
            const ck = order[oi];
            let group = today.filter(function (s) {
              return String(s.channelKey || s.channel_key || '') === String(ck);
            });
            try {
              group = sortShiftsByPeriod(group);
            } catch (_e) {}
            if (!group.length) continue;
            const title =
              DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title
                ? DEFAULT_CHANNELS[ck].title
                : ck;
            t += '\n—— «' + title + '» ——\n';
            for (let gi = 0; gi < group.length; gi++) {
              const s = group[gi];
              let name = String(s.adminId ?? s.admin_id ?? '');
              try {
                name = displayName(await getUser(Number(s.adminId ?? s.admin_id)), Number(s.adminId ?? s.admin_id));
              } catch (_e) {}
              // پاک‌سازی نام برای جلوگیری از خرابی کیبورد
              name = String(name || '')
                .replace(/[\u0000-\u001F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 24);
              if (!name) name = String(s.adminId ?? '');
              const tag =
                String(s.shiftDate) === 'perm' || String(s.shiftDate) === 'permanent' ? ' · دائم' : '';
              const line =
                '▫️ #' +
                s.id +
                '  ' +
                String(s.startHm || '').slice(0, 5) +
                '–' +
                String(s.endHm || '').slice(0, 5) +
                '  ·  ' +
                name +
                tag +
                '\n';
              if ((t + line).length < 3800) t += line;
              rows.push({
                id: Number(s.id),
                channelKey: s.channelKey || s.channel_key,
                channelTitle: title,
                startHm: String(s.startHm || '').slice(0, 5),
                endHm: String(s.endHm || '').slice(0, 5),
                adminId: Number(s.adminId ?? s.admin_id),
                name: name,
              });
            }
          }
        }
        const payload = {
          chat_id: cq.message.chat.id,
          text: t.slice(0, 4000),
        };
        if (rows.length) {
          payload.reply_markup = sanitizeMarkup(ownerCancelShiftsInline(rows));
        }
        await api.sendMessage(payload);
      } catch (e) {
        console.error('own_shift_list', e);
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'خطا',
            show_alert: true,
          });
        } catch (_e) {}
        try {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'خطا در لیست شیفت‌ها: ' + String(e && (e.message || e.description) || e).slice(0, 200),
          });
        } catch (_e2) {}
      }
      return;
    }


    if (data.startsWith('own_sc:')) {
      const sid = Number(data.split(':')[1]);
      if (!sid) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      const rows = (await db.select().from(shifts).where(eq(shifts.id, sid)).all()) || [];
      const row = rows[0];
      if (!row || row.status !== 'active') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پیدا نشد / قبلاً لغو', show_alert: true });
        return;
      }
      if (!isOwner(userId)) {
        let ok = false;
        try {
          ok = await canManageOthersShifts(userId, row.channelKey);
        } catch (_e) {}
        if (!ok) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
      await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, sid)).run();
      let name = String(row.adminId);
      try {
        name = displayName(await getUser(row.adminId), row.adminId);
      } catch (_e) {}
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.sendMessage({
          chat_id: row.adminId,
          text:
            '⚠️ شیفت شما توسط مدیریت لغو شد:\n' +
            ((DEFAULT_CHANNELS[row.channelKey] && DEFAULT_CHANNELS[row.channelKey].title) ||
              row.channelKey) +
            ' ' +
            String(row.startHm).slice(0, 5) +
            '–' +
            String(row.endHm).slice(0, 5),
        });
      } catch (_e) {}
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            (cq.message.text || '') +
            '\n\n❌ لغو شد: #' +
            sid +
            ' | ' +
            name +
            ' | ' +
            String(row.startHm).slice(0, 5),
        });
      } catch (_e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '❌ شیفت #' + sid + ' لغو شد (' + name + ').',
        });
      }
      return;
    }

    if (data === 'own_cancel_all') {
      const now = tehranNow();
      const pdate = periodDateStr(now);
      let slCh = null;
      if (!isOwner(userId)) {
        try {
          slCh = await getActiveSubLeaderChannel(userId);
        } catch (_e) {}
        if (!slCh) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک یا ساب‌لیدر', show_alert: true });
          return;
        }
      }
      const all = (await db.select().from(shifts).all()) || [];
      const today = all.filter(function (s) {
        if (String(s.status) !== 'active') return false;
        if (
          !(
            s.shiftDate === pdate ||
            s.shiftDate === 'perm' ||
            s.shiftDate === 'permanent' ||
            s.shiftDate === now.date
          )
        )
          return false;
        if (slCh && String(s.channelKey) !== String(slCh)) return false;
        return true;
      });
      let n = 0;
      const notified = {};
      for (const s of today) {
        try {
          await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, s.id)).run();
          n++;
          if (!notified[s.adminId]) {
            notified[s.adminId] = true;
            try {
              await api.sendMessage({
                chat_id: s.adminId,
                text: '⚠️ مالک همه شیفت‌های دوره فعلی را لغو کرد.',
              });
            } catch (_e) {}
          }
        } catch (_e) {}
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: n ? 'لغو شد: ' + n : 'چیزی نبود',
        show_alert: true,
      });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🗑 تعداد ' + n + ' شیفت دوره «' + pdate + '» (و دائم‌های نمایش‌داده‌شده) لغو شد.',
      });
      return;
    }

if (data.startsWith('own_shift:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const mode = 'daily'; // دائمی حذف شد
      await setState(userId, 'own_assign', { mode: mode });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'کانال را انتخاب کنید:',
        reply_markup: {
          keyboard: Object.values(DEFAULT_CHANNELS).map(function (c) {
            return [{ text: 'شیفت: ' + c.title }];
          }).concat([[{ text: '◀️ بازگشت' }]]),
          resize_keyboard: true,
        },
      });
      return;
    }


    
    async function runFlushBatch(chatId, progressMessageId) {
      const BATCH = 12;
      let job = null;
      try {
        const raw = await settingGet('flush_job', '');
        job = raw ? JSON.parse(raw) : null;
      } catch (_e) {
        job = null;
      }
      if (!job || job.status !== 'running') {
        await api.sendMessage({ chat_id: chatId, text: 'هیچ انتشار فعالی نیست.' });
        return;
      }
      const channelKey = job.channelKey;
      const conf = DEFAULT_CHANNELS[channelKey];
      if (!conf || !conf.chatId) {
        job.status = 'stopped';
        await settingSet('flush_job', JSON.stringify(job));
        await api.sendMessage({ chat_id: chatId, text: 'کانال نامعتبر' });
        return;
      }
      const totalStart = Number(job.total) || 0;
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
        return a.id - b.id;
      });

      // بدنه پیام‌های قبلاً تأییدشده همین کانال برای ضدتکرار
      const approved =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'approved'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      const seenBody = {};
      for (const a of approved) {
        try {
          const b = exactBodyKey(a.content);
          if (b) seenBody[b] = true;
        } catch (_e) {}
      }

      const slice = pending.slice(0, BATCH);
      let processed = 0;

      async function paint() {
        const leftEst = Math.max(0, totalStart - ok - fail - skip);
        const done = ok + fail + skip;
        const pct = totalStart ? Math.min(10, Math.floor((done / totalStart) * 10)) : 0;
        let bar = '';
        for (let i = 0; i < 10; i++) bar += i < pct ? '█' : '░';
        const body =
          '📤 انتشار مستقیم صف\n' +
          bar +
          ' ' +
          done +
          '/' +
          totalStart +
          '\n' +
          'کانال: «' +
          (conf.title || channelKey) +
          '»\n' +
          '✅ منتشر: ' +
          ok +
          '  ⏭ تکراری: ' +
          skip +
          '  ❌ خطا: ' +
          fail +
          '\n' +
          'باقی حدودی: ' +
          leftEst;
        try {
          if (progressMessageId) {
            await api.editMessageText({
              chat_id: chatId,
              message_id: progressMessageId,
              text: body,
              reply_markup: sanitizeMarkup(flushProgressInline(false, skip > 0 || (skipIds && skipIds.length))),
            });
          }
        } catch (_e) {}
      }

      await paint();

      for (const row of slice) {
        if (job.status !== 'running') break;
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
                rejectReason: 'تکراری (انتشار مستقیم)',
                reviewedBy: Number(job.ownerId) || null,
                reviewedAt: new Date(),
              })
              .where(and(eq(messages.id, row.id), eq(messages.status, 'pending')))
              .run();
            skip++;
            skipIds.push(Number(row.id));
            processed++;
            if (processed % 3 === 0) {
              job.ok = ok;
              job.fail = fail;
              job.skip = skip;
              job.skipIds = skipIds;
              await settingSet('flush_job', JSON.stringify(job));
              await paint();
            }
            continue;
          }

          // رزرو
          await db
            .update(messages)
            .set({ status: 'publishing' })
            .where(and(eq(messages.id, row.id), eq(messages.status, 'pending')))
            .run();
          const chk = (await db.select().from(messages).where(eq(messages.id, row.id)).all()) || [];
          if (!chk[0] || String(chk[0].status) !== 'publishing') {
            skip++;
            continue;
          }
          const sent = await api.sendMessage({
            chat_id: conf.chatId,
            text: toBoldHtml(row.content),
            parse_mode: 'HTML',
          });
          const mid = sent && sent.message_id;
          if (!mid) throw new Error('no message_id');
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
          ok++;
          processed++;
          const link = await resolveChannelMessageLink(conf.chatId, mid, channelKey);
          try {
            let txt = '✅ پیام شما تأیید و منتشر شد.';
            if (link) {
              txt +=
                '\n\nمشاهده در کانال «' +
                (conf.title || channelKey) +
                '»:\n' +
                link;
            }
            await api.sendMessage({
              chat_id: row.userId,
              text: txt,
              link_preview_options: link ? { is_disabled: false, url: link } : undefined,
            });
          } catch (_e) {}
        } catch (e) {
          console.error('flush one', row.id, e);
          fail++;
          processed++;
        }
        job.ok = ok;
        job.fail = fail;
        job.skip = skip;
        job.skipIds = skipIds;
        await settingSet('flush_job', JSON.stringify(job));
        if (processed % 2 === 0 || processed === slice.length) {
          await paint();
        }
      }

      const left =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      job.ok = ok;
      job.fail = fail;
      job.skip = skip;
      job.skipIds = skipIds;
      const finished = left.length === 0;
      if (finished) job.status = 'done';
      await settingSet('flush_job', JSON.stringify(job));

      const done = ok + fail + skip;
      const pct = totalStart ? Math.min(10, Math.floor((done / Math.max(totalStart, done)) * 10)) : 10;
      let bar = '';
      for (let i = 0; i < 10; i++) bar += i < pct ? '█' : '░';
      const body =
        (finished ? '✅ انتشار صف تمام شد\n' : '📤 انتشار صف (تکه‌تکه)\n') +
        bar +
        ' ' +
        done +
        '/' +
        totalStart +
        '\n' +
        'کانال: «' +
        (conf.title || channelKey) +
        '»\n' +
        '✅ منتشر: ' +
        ok +
        '  ⏭ تکراری (بدون ارسال): ' +
        skip +
        '  ❌ خطا: ' +
        fail +
        '\n' +
        'باقی‌مانده pending: ' +
        left.length +
        (finished ? '' : '\n\n▶️ دسته بعدی را بزنید (هر دسته ۱۲ پیام یکتا).');
      try {
        if (progressMessageId) {
          await api.editMessageText({
            chat_id: chatId,
            message_id: progressMessageId,
            text: body,
            reply_markup: sanitizeMarkup(flushProgressInline(finished, skip > 0 || (skipIds && skipIds.length > 0))),
          });
        } else {
          await api.sendMessage({
            chat_id: chatId,
            text: body,
            reply_markup: sanitizeMarkup(flushProgressInline(finished, skip > 0 || (skipIds && skipIds.length > 0))),
          });
        }
      } catch (_e) {
        await api.sendMessage({
          chat_id: chatId,
          text: body,
          reply_markup: sanitizeMarkup(flushProgressInline(finished, skip > 0 || (skipIds && skipIds.length > 0))),
        });
      }
    }


    async function runAnnounceBatch(chatId, progressMessageId) {
      await drainAnnounceOwnerBurst(chatId, progressMessageId, 12000);
    }



    if (data.startsWith('admin_stats:')) {
      let slScope = null;
      if (!isOwner(userId)) {
        try {
          slScope = await getActiveSubLeaderChannel(userId);
        } catch (_e) {}
        if (!slScope) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک یا ساب‌لیدر', show_alert: true });
          return;
        }
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const daysAgo = Number(data.split(':')[1]) || 0;
      const now = tehranNow();
      const parts = now.date.split('-').map(Number);
      const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      dt.setUTCDate(dt.getUTCDate() - daysAgo);
      const day =
        dt.getUTCFullYear() +
        '-' +
        String(dt.getUTCMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getUTCDate()).padStart(2, '0');
      let allMsg = [];
      try {
        allMsg =
          (await db
            .select({
              id: messages.id,
              status: messages.status,
              channelKey: messages.channelKey,
              reviewedBy: messages.reviewedBy,
              reviewedAt: messages.reviewedAt,
            })
            .from(messages)
            .all()) || [];
      } catch (e) {
        console.error('admin_stats messages', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '⚠️ خطا در خواندن پیام‌ها (timeout). بعداً دوباره تلاش کنید.\n' + String(e.message || e).slice(0, 150),
        });
        return;
      }

      const allSh = (await db.select().from(shifts).all()) || [];
      let body =
        '👮 آمار ادمین‌ها\n📅 ' +
        day +
        (daysAgo ? ' (' + daysAgo + ' روز پیش)' : ' (امروز)') +
        '\n';
      const _statsChannels = slScope
        ? Object.values(DEFAULT_CHANNELS).filter(function (c) {
            return c.key === slScope;
          })
        : Object.values(DEFAULT_CHANNELS);
      for (const conf of _statsChannels) {
        body += '\n━━━━━━━━━━━━\n📢 «' + conf.title + '»\n━━━━━━━━━━━━\n';
        const dayShifts = allSh.filter(function (s) {
          return (
            s.channelKey === conf.key &&
            s.status === 'active' &&
            (s.shiftDate === day || s.shiftDate === 'perm' || s.shiftDate === 'permanent') &&
            String(s.startHm) !== String(s.endHm)
          );
        });
        const adminIds = [];
        const seenA = {};
        for (const s of dayShifts) {
          const aid = Number(s.adminId);
          if (aid && !seenA[aid]) {
            seenA[aid] = true;
            adminIds.push(aid);
          }
        }
        for (const msg of allMsg) {
          if (msg.channelKey !== conf.key || !msg.reviewedBy) continue;
          const aid = Number(msg.reviewedBy);
          if (aid && !seenA[aid]) {
            seenA[aid] = true;
            adminIds.push(aid);
          }
        }
        if (!adminIds.length) {
          body += 'بدون فعالیت\n';
          continue;
        }
        for (const aid of adminIds) {
          let name = String(aid);
          try {
            name = displayName(await getUser(aid), aid);
          } catch (_e) {}
          const reviewed = allMsg.filter(function (msg) {
            if (msg.channelKey !== conf.key || Number(msg.reviewedBy) !== aid) return false;
            // فیلتر همان روز (تهران تقریبی از reviewedAt)
            if (!msg.reviewedAt) return daysAgo === 0; // بدون تاریخ فقط در «امروز»
            try {
              const jal = formatTsJalali(msg.reviewedAt);
              // formatTsJalali: "23 مهر 1405 — 12:00" — بهتر میلادی خام
              const t = new Date(msg.reviewedAt).getTime();
              if (!Number.isFinite(t)) return false;
              const IR = 3.5 * 3600 * 1000;
              const adj = new Date(t + IR);
              const dstr =
                adj.getUTCFullYear() +
                '-' +
                String(adj.getUTCMonth() + 1).padStart(2, '0') +
                '-' +
                String(adj.getUTCDate()).padStart(2, '0');
              return dstr === day;
            } catch (_e) {
              return false;
            }
          });
          const ap = reviewed.filter(function (x) {
            return x.status === 'approved';
          }).length;
          const rj = reviewed.filter(function (x) {
            return x.status === 'rejected';
          }).length;
          const shList = dayShifts
            .filter(function (s) {
              return Number(s.adminId) === aid;
            })
            .map(function (s) {
              return String(s.startHm).slice(0, 5) + ' تا ' + String(s.endHm).slice(0, 5);
            })
            .join(' | ');
          body +=
            '\n👤 ' +
            name +
            '\n⏰ ' +
            (shList || 'بدون شیفت') +
            '\n✅ تأیید ' +
            ap +
            ' | ❌ رد ' +
            rj +
            ' | جمع ' +
            reviewed.length +
            '\n';
        }
      }
      let cur = body;
      while (cur.length > 3500) {
        await api.sendMessage({ chat_id: cq.message.chat.id, text: cur.slice(0, 3500) });
        cur = cur.slice(3500);
      }
      await api.sendMessage({ chat_id: cq.message.chat.id, text: cur });
      return;
    }


    
    
    // ========== Sub-Leader owner management ==========
    
    // ========== Sub-Leader: حذف ادمین کانال خودش ==========
    
    if (data.startsWith('sl_aadd:')) {
      const channelKey = data.split(':')[1];
      const role = await getRole(userId);
      const slCh = await getActiveSubLeaderChannel(userId);
      if (!isOwner(userId) && !(role === 'subleader' && slCh === channelKey)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
        return;
      }
      await setState(userId, 'sl_add_admin', { channelKey });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'آیدی عددی یا @username ادمین جدید:',
      });
      return;
    }

    if (data.startsWith('sl_adel:')) {
      const parts = data.split(':');
      const channelKey = parts[1];
      const tid = Number(parts[2]);
      const role = await getRole(userId);
      const slCh = await getActiveSubLeaderChannel(userId);
      if (role !== 'subleader' || !slCh || slCh !== channelKey) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: '⛔ خارج از محدوده',
          show_alert: true,
        });
        return;
      }
      if (isOwner(tid)) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'مالک قابل حذف نیست',
          show_alert: true,
        });
        return;
      }
      await removeChannelAdmin(tid, channelKey);
      try {
        await api.sendMessage({
          chat_id: tid,
          text:
            '🚫 دسترسی ادمینی شما در کانال «' +
            ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
            '» توسط ساب‌لیدر لغو شد.',
        });
      } catch (_e) {}
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'حذف شد' });
      try {
        let listBody =
          '👥 ادمین‌های «' +
          ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
          '»\nتعداد: ' +
          ads.length +
          '\n';
        for (let i = 0; i < (ads || []).length; i++) {
          const a = ads[i] || {};
          listBody +=
            i +
            1 +
            '. ' +
            String(a.display != null && a.display !== '' ? a.display : a.userId) +
            ' | 🆔 ' +
            String(a.userId) +
            '\n';
        }
        const built = subLeaderAdminsInline(ads, channelKey);
        const markup = built && built.markup ? built.markup : built;
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: listBody.slice(0, 4000),
          reply_markup: sanitizeMarkup(markup),
        });
      } catch (_e) {
        console.error('sl_adel refresh', _e);
      }
      return;
    }

        if (data.startsWith('sl_ainfo:')) {
      const tid = Number(data.split(':')[1]);
      const role = await getRole(userId);
      const slCh = await getActiveSubLeaderChannel(userId);
      if (role !== 'subleader' || !slCh) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⛔', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      let name = String(tid);
      try {
        name = displayName(await getUser(tid), tid);
      } catch (_e) {}
      const allMsg = (await db.select().from(messages).where(eq(messages.channelKey, slCh)).all()) || [];
      const mine = allMsg.filter(function (x) { return Number(x.reviewedBy) === tid; });
      const ap = mine.filter(function (x) { return x.status === 'approved'; }).length;
      const rj = mine.filter(function (x) { return x.status === 'rejected'; }).length;
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const sh =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, tid), eq(shifts.channelKey, slCh), eq(shifts.status, 'active')))
          .all()) || [];
      const todaySh = sh.filter(function (s) {
        return s.shiftDate === pdate || s.shiftDate === 'perm' || s.shiftDate === 'permanent';
      });
      const shLine = todaySh.length
        ? todaySh.map(function (s) { return s.startHm + '–' + s.endHm; }).join(', ')
        : '—';
      const title = (DEFAULT_CHANNELS[slCh] && DEFAULT_CHANNELS[slCh].title) || slCh;
      const body =
        '👤 ' + name +
        '\n🆔 ' + tid +
        '\n📢 ' + title +
        '\n\n📊 عملکرد (کل کانال)' +
        '\n🟢 تأیید: ' + ap +
        '\n🔴 رد: ' + rj +
        '\n📦 مجموع بررسی: ' + mine.length +
        '\n\n⏰ شیفت امروز: ' + shLine;
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: body,
      });
      return;
    }

    // ========== Owner: انتشار مستقیم صف pending ==========
    
    if (data.startsWith('purge_user_go:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const targetId = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پاک‌سازی...' });
      const pending =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.userId, targetId), eq(messages.status, 'pending')))
          .all()) || [];
      pending.sort(function (a, b) {
        return a.id - b.id;
      });
      const slice = pending.slice(0, 15);
      let n = 0;
      // فقط وضعیت → rejected | بدون پیام به کاربر | بدون انتشار کانال
      for (const row of slice) {
        try {
          await db
            .update(messages)
            .set({
              status: 'rejected',
              rejectReason: 'رد شده',
              reviewedBy: Number(userId),
              reviewedAt: new Date(),
            })
            .where(and(eq(messages.id, row.id), eq(messages.status, 'pending')))
            .run();
          n++;
        } catch (e) {
          console.error('purge one', row.id, e);
        }
      }
      const left =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.userId, targetId), eq(messages.status, 'pending')))
          .all()) || [];
      const finished = left.length === 0;
      const body =
        '🗑 پاک‌سازی pending کاربر ' +
        targetId +
        '\n' +
        'در این دسته: ' +
        n +
        '\n' +
        'باقی‌مانده: ' +
        left.length +
        (finished ? '\n\n✅ تمام شد.' : '\n\n▶️ برای ۱۵تای بعدی دکمه را بزنید.');
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: body,
          reply_markup: sanitizeMarkup(purgeUserProgressInline(targetId, finished)),
        });
      } catch (_e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: body,
          reply_markup: sanitizeMarkup(purgeUserProgressInline(targetId, finished)),
        });
      }
      return;
    }

    if (data === 'purge_user_cancel') {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بسته شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'پاک‌سازی لغو/متوقف شد.',
        });
      } catch (_e) {}
      return;
    }

if (data.startsWith('flush_ch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const pending =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      pending.sort(function (a, b) {
        return a.id - b.id;
      });
      const title =
        (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey;
      if (!pending.length) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'ℹ️ صف «' + title + '» خالی است.',
        });
        return;
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '⚠️ انتشار مستقیم\n\n' +
          'کانال: «' +
          title +
          '»\n' +
          'تعداد pending: ' +
          pending.length +
          '\n\n' +
          'بدون بررسی ادمین، از قدیمی‌ترین به کانال منتشر می‌شوند (هر دسته حدود ۳۰ پیام).\nادامه؟',
        reply_markup: sanitizeMarkup(flushConfirmInline(channelKey)),
      });
      return;
    }

    if (data === 'flush_cancel' || data === 'flush_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: data === 'flush_cancel' ? 'لغو' : 'OK' });
      if (data === 'flush_cancel') {
        try {
          await settingSet('flush_job', '');
        } catch (_e) {}
      }
      return;
    }

    if (data.startsWith('flush_go:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const pending =
        (await db
          .select()
          .from(messages)
          .where(and(eq(messages.status, 'pending'), eq(messages.channelKey, channelKey)))
          .all()) || [];
      pending.sort(function (a, b) {
        return a.id - b.id;
      });
      const job = {
        status: 'running',
        channelKey: channelKey,
        total: pending.length,
        ok: 0,
        fail: 0,
        ownerId: userId,
      };
      await settingSet('flush_job', JSON.stringify(job));
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شروع...' });
      const progress = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '📤 در حال انتشار...\n0/' + pending.length,
        reply_markup: sanitizeMarkup(flushProgressInline(false)),
      });
      await runFlushBatch(cq.message.chat.id, progress && progress.message_id);
      return;
    }

    
    if (data === 'flush_view_skip') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      let job = null;
      try {
        const raw = await settingGet('flush_job', '');
        job = raw ? JSON.parse(raw) : null;
      } catch (_e) {}
      let ids = (job && Array.isArray(job.skipIds) ? job.skipIds : []).map(Number).filter(Boolean);
      // fallback: آخرین ردهای «تکراری (انتشار مستقیم)» همین کانال
      if (!ids.length && job && job.channelKey) {
        const all =
          (await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.channelKey, job.channelKey),
                eq(messages.status, 'rejected')
              )
            )
            .all()) || [];
        ids = all
          .filter(function (r) {
            return String(r.rejectReason || '') === 'تکراری (انتشار مستقیم)';
          })
          .sort(function (a, b) {
            return b.id - a.id;
          })
          .slice(0, 40)
          .map(function (r) {
            return Number(r.id);
          });
      }
      if (!ids.length) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'ℹ️ در این انتشار پیام ردشده‌ای ثبت نشده.',
        });
        return;
      }
      // نمایش حداکثر ۱۵ تا در هر درخواست
      const st = await getState(userId);
      let offset = 0;
      if (st && st.kind === 'flush_skip_view') offset = Number(st.offset) || 0;
      const page = ids.slice(offset, offset + 15);
      await setState(userId, 'flush_skip_view', { offset: offset + page.length, ids: ids });
      let body = '🔴 ردشده‌های انتشار مستقیم (' + ids.length + ' مورد)\nصفحه از #' + (offset + 1) + '\n\n';
      for (const id of page) {
        const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
        const row = rows && rows[0];
        if (!row) {
          body += '#' + id + ' (یافت نشد)\n────────────\n';
          continue;
        }
        body +=
          '#' +
          row.id +
          ' | ' +
          (row.rejectReason || 'تکراری') +
          '\n' +
          String(row.content || '').slice(0, 180) +
          '\n────────────\n';
      }
      const more = offset + page.length < ids.length;
      const kb = more
        ? {
            inline_keyboard: [
              [{ text: '▶️ بعدی', callback_data: 'flush_view_skip', style: 'primary' }],
            ],
          }
        : {
            inline_keyboard: [
              [{ text: 'پایان لیست', callback_data: 'flush_noop', style: 'primary' }],
            ],
          };
      if (body.length > 3500) body = body.slice(0, 3500) + '\n…';
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: body,
        reply_markup: sanitizeMarkup(kb),
      });
      if (!more) await clearState(userId);
      return;
    }

if (data === 'flush_next') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ادامه...' });
      await runFlushBatch(cq.message.chat.id, cq.message.message_id);
      return;
    }

    if (data === 'flush_stop') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      try {
        const raw = await settingGet('flush_job', '');
        if (raw) {
          const job = JSON.parse(raw);
          job.status = 'stopped';
          await settingSet('flush_job', JSON.stringify(job));
        }
      } catch (_e) {}
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'متوقف شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '⏹ انتشار صف متوقف شد.',
          reply_markup: sanitizeMarkup(flushProgressInline(true)),
        });
      } catch (_e) {}
      return;
    }

if (data.startsWith('sl_setch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const st = await getState(userId);
      // change channel for existing: state sl_change_ch
      if (st && st.kind === 'sl_change_ch' && st.targetId) {
        const tid = Number(st.targetId);
        const prev = await getSubLeaderRecord(tid);
        const oldKey = prev && prev.channelKey;
        await upsertSubLeader(tid, channelKey, userId);
        await clearState(userId);
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال تغییر کرد' });
        if (oldKey && oldKey !== channelKey) {
          await notifySubLeaderChannelChange(tid, oldKey, channelKey);
        }
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '✅ کانال ساب‌لیدر به‌روز شد.',
          reply_markup: sanitizeMarkup(ownerSubLeaderMenuKeyboard()),
        });
        return;
      }
      if (!st || st.kind !== 'sl_add_ch' || !st.targetId) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'جلسه منقضی', show_alert: true });
        return;
      }
      const tid = Number(st.targetId);
      try {
        await upsertSubLeader(tid, channelKey, userId);
      } catch (e) {
        const msg =
          e && e.message === 'owner'
            ? '❌ مالک مجاز نیست'
            : e && e.message === 'blocked'
              ? '❌ کاربر بلاک است'
              : '❌ این کاربر قابل انتخاب نیست';
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: msg, show_alert: true });
        return;
      }
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ثبت شد' });
      await notifySubLeaderAppointed(tid, channelKey);
      const title = (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey;
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '✅ ساب‌لیدر با موفقیت ایجاد شد.\nکاربر: ' + tid + '\nکانال: «' + title + '»',
        reply_markup: sanitizeMarkup(ownerSubLeaderMenuKeyboard()),
      });
      return;
    }

    if (data === 'sl_cancel' || data === 'sl_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      if (data === 'sl_cancel') await clearState(userId);
      return;
    }

    if (data.startsWith('sl_view:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const tid = Number(data.split(':')[1]);
      const rec = await getSubLeaderRecord(tid);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      if (!rec) {
        await api.sendMessage({ chat_id: cq.message.chat.id, text: 'یافت نشد' });
        return;
      }
      const title = (DEFAULT_CHANNELS[rec.channelKey] && DEFAULT_CHANNELS[rec.channelKey].title) || rec.channelKey;
      let name = String(tid);
      try {
        name = displayName(await getUser(tid), tid);
      } catch (_e) {}
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '🛡️ ' +
          name +
          '\n🆔 ' +
          tid +
          '\n📢 «' +
          title +
          '»\nوضعیت: ' +
          (rec.status === 'active' ? '🟢 فعال' : '🔴 غیرفعال'),
        reply_markup: subLeaderManageInline(tid),
      });
      return;
    }

    if (data.startsWith('sl_ch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const tid = Number(data.split(':')[1]);
      await setState(userId, 'sl_change_ch', { targetId: tid });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'کانال جدید را انتخاب کنید:',
        reply_markup: sanitizeMarkup(subLeaderPickChannelInline()),
      });
      return;
    }

    if (data.startsWith('sl_off:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const tid = Number(data.split(':')[1]);
      await deactivateSubLeader(tid);
      await notifySubLeaderRemoved(tid);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'غیرفعال شد' });
      // لیست فعال‌ها را از DB بخوان و UI را رفرش کن
      let items = [];
      try {
        const rows = await listActiveSubLeaders();
        for (const r of rows || []) {
          const u = await getUser(r.userId);
          items.push({
            userId: r.userId,
            channelKey: r.channelKey,
            status: r.status,
            display: displayName(u, r.userId),
          });
        }
      } catch (e) {
        console.error('sl list after off', e);
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🚫 ساب‌لیدر ' + tid + ' غیرفعال شد.\nلیست به‌روز:',
        reply_markup: sanitizeMarkup(subLeaderListInline(items)),
      });
      return;
    }

    if (data === 'sl_ann_yes') {
      const st = await getState(userId);
      const role = await getRole(userId);
      if (role !== 'subleader' || !st || st.kind !== 'sl_ann_confirm') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⛔ دسترسی ندارید', show_alert: true });
        return;
      }
      const ch = await getSubLeaderChannel(userId);
      if (!ch || (st.channelKey && st.channelKey !== ch)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⛔ خارج از محدوده', show_alert: true });
        return;
      }
      const { admins } = await subLeaderAdmins(userId);
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ارسال...' });
      let ok = 0,
        fail = 0;
      const text = st.annText || '';
      for (const a of admins) {
        try {
          await api.sendMessage({
            chat_id: a.userId,
            text: '📢 اطلاعیه ساب‌لیدر\n\n' + text,
          });
          ok++;
        } catch (_e) {
          fail++;
        }
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '✅ ارسال شد\nموفق: ' + ok + ' | ناموفق: ' + fail,
        reply_markup: sanitizeMarkup(subLeaderKeyboard()),
      });
      return;
    }

    if (data === 'sl_ann_no') {
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'اطلاعیه لغو شد.',
        });
      } catch (_e) {}
      return;
    }

if (data.startsWith('ann_target:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const target = data.split(':')[1];
      const st = await getState(userId);
      const annText = st && st.annText;
      await clearState(userId);
      if (!annText) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'متن اطلاعیه پیدا نشد. دوباره از «📣 اطلاعیه» شروع کنید.',
        });
        return;
      }
      let ids = [];
      const seen = {};
      try {
        if (target === 'admins') {
          const ads = (await db.select().from(channelAdmins).all()) || [];
          for (const a of ads) {
            const id = Number(a.userId || a.user_id);
            if (id && !seen[id]) {
              seen[id] = true;
              ids.push(id);
            }
          }
        } else {
          const all = (await db.select().from(users).all()) || [];
          for (const u of all) {
            const id = Number(u.userId || u.user_id);
            if (id && !seen[id]) {
              seen[id] = true;
              ids.push(id);
            }
          }
        }
      } catch (e) {
        console.error('ann collect', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'خطا در جمع‌آوری مخاطبین: ' + (e && e.message ? e.message : e),
        });
        return;
      }
      if (!ids.length) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'هیچ مخاطبی پیدا نشد.',
        });
        return;
      }
      const progress = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '📣 ارسال اطلاعیه شروع شد\n' +
          '░░░░░░░░░░ 0%\n' +
          '0 / ' +
          ids.length +
          '\n✅ موفق: 0   ❌ ناموفق: 0\n\n' +
          'این پیام سنجاق می‌شود و با پیشرفت صف به‌روز می‌گردد.',
        reply_markup: sanitizeMarkup(announceProgressInline(false)),
      });
      const mid = (progress && (progress.message_id || progress.messageId || progress.id)) || null;
      try {
        if (mid) {
          await api.pinChatMessage({
            chat_id: cq.message.chat.id,
            message_id: mid,
            disable_notification: true,
          });
        }
      } catch (_pin) {}
      const job = {
        status: 'running',
        text: annText,
        ids: ids,
        cursor: 0,
        ok: 0,
        fail: 0,
        target: target,
        ownerId: userId,
        progressChatId: cq.message.chat.id,
        progressMessageId: mid || null,
      };
      await saveAnnounceJob(job);
      await runAnnounceBatch(cq.message.chat.id, mid);
      return;
    }

    if (data === 'ann_cancel') {
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'اطلاعیه لغو شد.',
        });
      } catch (_e) {}
      return;
    }

if (data === 'ann_continue') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ادامه...' });
      const pMid = cq.message && (cq.message.message_id || cq.message.messageId);
      const pChat = cq.message && cq.message.chat && cq.message.chat.id;
      await runAnnounceBatch(pChat || userId, pMid);
      return;
    }

    if (data === 'ann_stop') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const job = await loadAnnounceJob();
      if (job && job.status === 'running') {
        job.status = 'stopped';
        await saveAnnounceJob(job);
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'متوقف شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '⏹ ارسال متوقف شد.\n' +
            (job
              ? 'پیشرفت: ' + (job.cursor || 0) + '/' + ((job.ids && job.ids.length) || 0) +
                '\n✅ ' + (job.ok || 0) + '  ❌ ' + (job.fail || 0)
              : ''),
          reply_markup: sanitizeMarkup(announceProgressInline(true)),
        });
      } catch (_e) {}
      return;
    }

    if (data === 'ann_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      return;
    }


    
    if (data.startsWith('shift_mode|') || data.startsWith('shift_mode:')) {
      const parts = data.indexOf('|') >= 0 ? data.split('|') : data.split(':');
      let mode = parts[1]; // فقط daily — perm منسوخ
      const channelKey = parts[2];
      if (!channelKey) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      mode = 'daily';
      try {
        await cancelInvalidShifts();
      } catch (_e) {}
      const now = tehranNow();
      const date = periodDateStr(now);
      const dayShifts =
        (await db.select().from(shifts).where(eq(shifts.channelKey, channelKey)).all()) || [];
      // فقط شیفت روزانه همین دوره
      const occupied = dayShifts.filter(function (s) {
        if (String(s.status) !== 'active') return false;
        if (String(s.startHm) === String(s.endHm)) return false;
        const sd = String(s.shiftDate || '');
        if (sd === 'perm' || sd === 'permanent') return false;
        if (sd !== date) return false;
        const sh = Number(String(s.startHm || '0').split(':')[0]) || 0;
        return sh >= 12;
      });
      const takenMap = {};
      const myStarts = new Set();
      for (const s of occupied) {
        // کلید باکت ساعت شروع تا با دکمه‌ها یکی باشد
        const parts = String(s.startHm || '0').split(':');
        const key = String(Number(parts[0]) || 0).padStart(2, '0') + ':00';
        takenMap[key] = s.adminId;
        if (Number(s.adminId) === Number(userId)) myStarts.add(key);
      }
      await setState(userId, 'pick_shift_slot', { channelKey, mode: 'daily' });
      const title = (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey;
      let head =
        '⏰ شیفت‌های «' +
        title +
        '»\nدوره: ' +
        (toJalaliDisplay(date) || date) +
        ' (یک‌بارمصرف)\nساعت کاری: ۱۲:۰۰ تا ۰۰:۰۰\n' +
        (isOwner(userId) ? 'مالک: بدون سقف شیفت\n' : 'حداکثر ۳ شیفت\n') +
        '🟢 خالی  ·  🔴 پر\n\n';
      if (occupied.length) {
        head += 'اشغال‌شده‌ها:\n';
        for (const s of occupied) {
          let who = Number(s.adminId) === Number(userId) ? 'شما' : String(s.adminId);
          try {
            if (Number(s.adminId) !== Number(userId)) {
              who = displayName(await getUser(s.adminId), s.adminId);
            }
          } catch (_e) {}
          head += '• ' + s.startHm + '–' + s.endHm + ' | ' + who + '\n';
        }
      } else {
        head += 'هنوز شیفتی ثبت نشده — همه خالی‌اند.';
      }
      let manageMode = isOwner(userId);
      try {
        manageMode = manageMode || (await canManageOthersShifts(userId, channelKey));
      } catch (_e) {}
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: head,
          reply_markup: sanitizeMarkup(shiftSlotsInline(channelKey, takenMap, myStarts, null, manageMode)),
        });
      } catch (_e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: head,
          reply_markup: sanitizeMarkup(shiftSlotsInline(channelKey, takenMap, myStarts, null, manageMode)),
        });
      }
      return;
    }

    if (data.startsWith('shift_pick|') || data.startsWith('shift_pick:')) {
      // فرمت درست: shift_pick|channel|HH:MM|HH:MM  (نه split روی :)
      let channelKey, startHm, endHm;
      if (data.indexOf('|') >= 0) {
        const parts = data.split('|');
        channelKey = parts[1];
        startHm = parts[2];
        endHm = parts[3];
      } else {
        // سازگاری قدیمی — ممکن است خراب باشد
        const rest = data.slice('shift_pick:'.length);
        const firstColon = rest.indexOf(':');
        channelKey = rest.slice(0, firstColon);
        const times = rest.slice(firstColon + 1);
        const m = times.match(/^(\d{1,2}:\d{2}):(\d{1,2}:\d{2})$/);
        if (m) {
          startHm = m[1];
          endHm = m[2];
        } else {
          const p = times.split(':');
          startHm = (p[0] || '0').padStart(2, '0') + ':00';
          endHm = (p[1] || '0').padStart(2, '0') + ':00';
        }
      }
      if (!channelKey || !startHm || !endHm) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'داده نامعتبر', show_alert: true });
        return;
      }
      // نرمال HH:MM
      function padHm(x) {
        const p = String(x).split(':');
        const h = String(Number(p[0]) || 0).padStart(2, '0');
        const m = String(Number(p[1]) || 0).padStart(2, '0');
        return h + ':' + m;
      }
      startHm = padHm(startHm);
      endHm = padHm(endHm);
      if (startHm === endHm) {
        const h = (Number(startHm.split(':')[0]) + 1) % 24;
        endHm = String(h).padStart(2, '0') + ':00';
      }
      // ساده: کاربر عادی نه؛ ادمین/ساب‌لیدر/مالک بله
      // اگر channel_admins خراب بود، نقش admin کافی است
      if (!isOwner(userId)) {
        const role = await getRole(userId);
        if (role === 'user') {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: '⛔ فقط ادمین می‌تواند شیفت بردارد',
            show_alert: true,
          });
          return;
        }
        // ساب‌لیدر فقط کانال خودش + کانال‌هایی که ادمین است
        if (role === 'subleader') {
          let allowed = [];
          try {
            allowed = await shiftPickChannels(userId);
          } catch (_e) {
            allowed = [];
          }
          const ck = String(channelKey || '');
          if (allowed.length && !allowed.some(function (x) { return String(x) === ck; })) {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: '⛔ خارج از محدوده کانال شما',
              show_alert: true,
            });
            return;
          }
        }
        // role === 'admin' → بدون محدودیت کانال (ثبت در همان کانال انتخاب‌شده)
      }
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const stAssign = await getState(userId);
      if (stAssign && stAssign.kind === 'own_assign_slot') {
        const targetAdmin = stAssign.adminId;
        const mode = 'daily';
        const shiftDate = pdate;
        const targetConflict = await findAdminShiftConflict(targetAdmin, shiftDate, startHm, endHm);
        if (targetConflict) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این ادمین در این بازه شیفت دیگری دارد.',
            show_alert: true,
          });
          return;
        }
        const slotTaken0 = await isChannelSlotTaken(channelKey, startHm, endHm, null);
        if (slotTaken0 && Number(slotTaken0.adminId ?? slotTaken0.admin_id) !== Number(targetAdmin)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این بازه در کانال قبلاً پر شده است.',
            show_alert: true,
          });
          return;
        }
        await clearState(userId);
        // double-check right before insert
        const slotTaken1 = await isChannelSlotTaken(channelKey, startHm, endHm, null);
        if (slotTaken1 && Number(slotTaken1.adminId ?? slotTaken1.admin_id) !== Number(targetAdmin)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این بازه همین الان پر شد.',
            show_alert: true,
          });
          return;
        }
        // اعتبارسنجی تخصیص مالک
        {
          const sh = Number(String(startHm).split(':')[0]) || 0;
          if (sh < 12) {
            await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شیفت فقط ۱۲–۰۰', show_alert: true });
            return;
          }
          const isAdm = await isUserChannelAdmin(targetAdmin, channelKey);
          if (!isAdm && !isOwner(targetAdmin)) {
            await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کاربر ادمین این کانال نیست', show_alert: true });
            return;
          }
          const conf = await findAdminShiftConflict(targetAdmin, shiftDate, startHm, endHm);
          if (conf) {
            await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تداخل با شیفت دیگر این ادمین', show_alert: true });
            return;
          }
          const slotT = await isChannelSlotTaken(channelKey, startHm, endHm, null);
          if (slotT) {
            await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بازه پر است', show_alert: true });
            return;
          }
        }
        const _oaLock = 'shift_slot:' + channelKey + ':' + shiftDate + ':' + String(Number(String(startHm).split(':')[0])||0).padStart(2,'0');
        let _oaTok = null;
        try { _oaTok = await acquireLock(_oaLock, 8000); } catch (_e) {}
        if (!_oaTok) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قفل — بعداً', show_alert: true });
          return;
        }
        try {
        await db
          .insert(shifts)
          .values({
            channelKey,
            adminId: targetAdmin,
            shiftDate,
            startHm,
            endHm,
            status: 'active',
          })
          .run();
        try { await dedupeActiveShifts(channelKey); } catch (_e) {}
        } finally {
          try { await releaseLock(_oaLock, _oaTok); } catch (_e) {}
        }
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تخصیص شد' });
        await api.sendMessage({
          chat_id: userId,
          text:
            '✅ شیفت ' +
            startHm +
            '–' +
            endHm +
            ' برای ادمین ' +
            displayName(await getUser(targetAdmin), targetAdmin) +
            ' (' +
            'دوره فعلی' +
            ') ثبت شد.',
        });
        try {
          await api.sendMessage({
            chat_id: targetAdmin,
            text:
              '📌 شیفت جدید برای شما ثبت شد:\n' +
              (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
              ' ' +
              startHm +
              '–' +
              endHm +
              ' (دوره فعلی)',
          });
        } catch (_) {}
        return;
      }


      const taken =
        (await db
          .select()
          .from(shifts)
          .where(
            and(
              eq(shifts.channelKey, channelKey),
              eq(shifts.status, 'active')
            )
          )
          .all()) || [];
      const conflict = taken.filter((s) => {
        const sameDate = String(s.shiftDate) === String(pdate);
        if (!sameDate) return false;
        if (String(s.startHm) === String(s.endHm)) return false;
        const toOrd = (hm) => {
          const parts = String(hm || '0:0').split(':').map(Number);
          let m = (parts[0] || 0) * 60 + (parts[1] || 0);
          if (m < 12 * 60) m += 24 * 60;
          return m;
        };
        const a = toOrd(startHm);
        let b = toOrd(endHm);
        const c = toOrd(s.startHm);
        let d = toOrd(s.endHm);
        if (b <= a) b += 24 * 60;
        if (d <= c) d += 24 * 60;
        return a < d && c < b;
      });
      if (conflict.length) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'این بازه در این کانال پر است.',
          show_alert: true,
        });
        await refreshAllShiftBoards(channelKey, pdate);
        return;
      }

      let _modeForConflict = 'daily';
      try {
        const _stc = await getState(userId);
        // دائمی حذف شده — همیشه دوره فعلی
      } catch (_e) {}
      
      // —— اعتبارسنجی سمت سرور ——
      try { clearMemo('ask:'); } catch (_e) {}
      if (!isOwner(userId)) {
        let allowedCh = [];
        try { allowedCh = await shiftPickChannels(userId); } catch (_e) { allowedCh = []; }
        if (!allowedCh.map(String).includes(String(channelKey))) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'اجازه انتخاب شیفت برای این کانال را ندارید',
            show_alert: true,
          });
          return;
        }
      }
      // اسلات گذشته + طول یک‌ساعته
      {
        const nowChk = tehranNow();
        const startN = normHm(startHm);
        const endN = normHm(endHm);
        if (!startN || !endN || startN === endN) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بازه نامعتبر', show_alert: true });
          return;
        }
        let sOrd = periodOrd(startN);
        let eOrd = periodOrd(endN);
        if (eOrd <= sOrd) eOrd += 24 * 60;
        if (eOrd - sOrd > 70 || eOrd - sOrd < 50) {
          // فقط بازه‌های حدود ۱ ساعته (۵۰–۷۰ دقیقه برای انعطاف جزئی)
          // partial owner slots may differ — owners exempt from exact length
          if (!isOwner(userId)) {
            await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بازه باید حدود ۱ ساعت باشد', show_alert: true });
            return;
          }
        }
        if (isWorkHours(nowChk) && periodOrd(nowChk.hm) >= eOrd) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'این بازه تمام شده', show_alert: true });
          return;
        }
        const sh = Number(String(startN).split(':')[0]) || 0;
        if (sh < 12) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شیفت فقط از ۱۲ تا ۰۰', show_alert: true });
          return;
        }
      }

      const ownConflict = await findAdminShiftConflict(
        userId,
        pdate,
        startHm,
        endHm
      );
      if (ownConflict) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'این بازه با یکی از شیفت‌های خودتان تداخل دارد.',
          show_alert: true,
        });
        return;
      }

      let mineCount = 0;
      try {
        mineCount = await countAdminPeriodShifts(userId, pdate);
      } catch (_e) {
        mineCount = 99;
      }
      if (!isOwner(userId) && mineCount >= 3) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'حداکثر ۳ شیفت در هر دوره',
          show_alert: true,
        });
        return;
      }
      if (String(startHm) === String(endHm)) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'بازه نامعتبر',
          show_alert: true,
        });
        return;
      }
      {
        const sh = Number(String(startHm).split(':')[0]) || 0;
        if (sh < 12) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'شیفت فقط از ۱۲ تا ۰۰ معتبر است',
            show_alert: true,
          });
          return;
        }
      }
      // فقط دوره فعلی — دائمی حذف شد
      const pickMode = 'daily';
      const shiftDateVal = pdate;
      // چک نهایی تداخل کانال (جلوگیری از دابل و race)
      // قفل اسلات برای جلوگیری از ثبت همزمان دو ادمین
      const hourBucket = String(Number(String(startHm).split(':')[0]) || 0).padStart(2, '0');
      const slotLockKey = 'shift_slot:' + channelKey + ':' + pdate + ':' + hourBucket;
      const adminLockKey = 'shift_admin:' + userId + ':' + pdate + ':' + hourBucket;
      let slotLock = null;
      let adminLock = null;
      try {
        slotLock = await acquireLock(slotLockKey, 8000);
        adminLock = await acquireLock(adminLockKey, 8000);
      } catch (_e) {}
      if (!slotLock || !adminLock) {
        try { if (slotLock) await releaseLock(slotLockKey, slotLock); } catch (_e) {}
        try { if (adminLock) await releaseLock(adminLockKey, adminLock); } catch (_e) {}
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: '⏳ این ساعت در حال ثبت است — چند ثانیه بعد',
          show_alert: true,
        });
        return;
      }
      let insertOk = false;
      try {
        // چک نهایی داخل قفل: کانال + تداخل ادمین بین همه کانال‌ها
        const slotFinal = await isChannelSlotTaken(channelKey, startHm, endHm, null);
        if (slotFinal) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این بازه پر است یا همزمان گرفته شد.',
            show_alert: true,
          });
          return;
        }
        const conflictFinal = await findAdminShiftConflict(userId, pdate, startHm, endHm);
        if (conflictFinal) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این بازه با شیفت شما در کانال دیگر تداخل دارد.',
            show_alert: true,
          });
          return;
        }
        let mineNow = 0;
        try { mineNow = await countAdminPeriodShifts(userId, pdate); } catch (_e) { mineNow = 99; }
        if (!isOwner(userId) && mineNow >= 3) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'حداکثر ۳ شیفت در هر دوره',
            show_alert: true,
          });
          return;
        }
        await db
          .insert(shifts)
          .values({
            channelKey,
            adminId: userId,
            shiftDate: shiftDateVal,
            startHm,
            endHm,
            status: 'active',
          })
          .run();
        try { await dedupeActiveShifts(channelKey); } catch (_e) {}
        const still = await verifyShiftStillActive(userId, channelKey, startHm, shiftDateVal);
        if (!still) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'ثبت نشد — تداخل تشخیص داده شد',
            show_alert: true,
          });
          return;
        }
        insertOk = true;
      } finally {
        try { if (slotLock) await releaseLock(slotLockKey, slotLock); } catch (_e) {}
        try { if (adminLock) await releaseLock(adminLockKey, adminLock); } catch (_e) {}
      }
      if (!insertOk) return;

      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'ثبت شد ✅',
      });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (e) {
        console.error('refresh', e);
      }
      try {
        const dayShifts =
          (await db
            .select()
            .from(shifts)
            .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
            .all()) || [];
        const active = dayShifts.filter(function (s) {
          const sd = String(s.shiftDate || '');
          if (sd === 'perm' || sd === 'permanent') return false;
          return sd === pdate;
        });
        const takenMap = {};
        for (const s of active) {
          if (String(s.startHm) === String(s.endHm)) continue;
          const parts = String(s.startHm || '0').split(':');
          const key = String(Number(parts[0]) || 0).padStart(2, '0') + ':00';
          takenMap[key] = s.adminId;
        }
        const myStarts = new Set(
          active.filter((s) => Number(s.adminId) === Number(userId)).map((s) => s.startHm)
        );
        myStarts.add(startHm);
        takenMap[startHm] = userId;
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: sanitizeMarkup(shiftSlotsInline(channelKey, takenMap, myStarts, null, (isOwner(userId) || false))),
        });
      } catch (e) {
        console.error('edit self board', e);
      }
      await api.sendMessage({
        chat_id: userId,
        text:
          '✅ شیفت «' +
          (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
          '» ' +
          startHm +
          '–' +
          endHm +
          ' فقط برای دوره ' + pdate + ' ثبت شد (یک‌بارمصرف، فردا تکرار نمی‌شود).' +
          '\n\nوقتی ساعت شیفت رسید «📥 پیام‌های در انتظار» را بزنید.',
      });
      return;
    }

  } catch (e) {
    console.error('cb', e);
    try {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'خطا',
        show_alert: true,
      });
    } catch (_) {}
  } finally {
    try {
      await drainAnnouncePiggyback(35);
    } catch (_d) {}
  }
}
