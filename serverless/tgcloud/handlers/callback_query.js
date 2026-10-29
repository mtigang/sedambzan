import { normalizeBody, exactBodyKey, bodyIndexSettingKey } from 'lib/validation';
import { api, db, InputFile } from 'sdk';
import { eq, and, desc } from 'sdk/db';
import { messages, feedback, shifts, settings, users, channelAdmins } from 'schema';
import {
  isOwner,
  setChannelEnabled,
  setChannelAdMode,
  isChannelAdMode,
  isFridayMode,
  setFridayMode,
  isBotOn,
  isQueueBusyMode,
  setQueueBusyMode,
  setChannelQueueBusy,
  isChannelQueueBusy,
  loadWorkHoursFromSettings,
  getForceJoinCampaign,
  getForceJoinHistory,
  getForceJoinQueue,
  clearForceJoinQueue,
  promoteNextForceJoinFromQueue,
  saveForceJoinCampaign,
  pushForceJoinHistory,
  confirmForceJoinUser,
  forceJoinTitlesText,
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
  rememberChannelMessage,
  findChannelMessageByInternalId,
  activeShiftAdmins,
  addChannelAdmin,
  getRole,
  decideMessage,
  loadUserMessages,
  rememberUserMessageId,
  reserveMessageForPublish,
  canCompletePublishing,
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
  clearReviewUiMessages,
  finishReviewBatchIfComplete,
  getReviewBatch,
  findAdminShiftConflict,
  isChannelSlotTaken,
  dedupeActiveShifts,
  cancelAllPermanentShifts,
  cancelInvalidShifts,
  shiftActiveNow,
  countAdminPeriodShifts,
  isUserChannelAdmin,
  normalizeChannelKey,
  shiftPickChannels,
  verifyShiftStillActive,
  clearMemo,
  pruneOldShifts,
  filterPeriodShifts,
  buildTakenMapForSlots,
  acquireLock,
  releaseLock,
  shiftIntervalOverlaps,
  buildDataAnalysisReport,
  buildAdminStatsPayload,
} from 'lib/dbutil';
import { drainHoleWave, startHoleJob, getHoleJob, saveHoleJob, drainHolePiggyback } from 'lib/hole_drain';
import { drainAnnouncePiggyback, drainAnnounceOwnerBurst, loadAnnounceJob, saveAnnounceJob, countAnnounceAudience } from 'lib/announce_drain';
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
import { DEFAULT_CHANNELS, OWNER_IDS, CHANNEL_IDS } from 'lib/config';
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
  adminFbReplyInline,
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
  ownerShiftListChannelInline,
  reviewNextInline,
  reviewDoneInline,
  reviewTakenInline,
  sanitizeMarkup,
  dbExportContinueInline,
  postChannelInline,
  disableModesInline,
  channelPickFlagsInline,
  forceJoinInline,
  forceJoinOwnerInline,
  ownerKeyboard,
  userKeyboard,
  adminKeyboard,
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
  async function pushUi(mid) {
    try {
      const uid = cq.from && cq.from.id;
      if (!uid || !mid) return;
      const key = 'review_ui:' + Number(uid);
      let prev = [];
      try {
        prev = JSON.parse(await settingGet(key, '[]')) || [];
      } catch (_e) {
        prev = [];
      }
      if (prev.indexOf(Number(mid)) < 0) prev.push(Number(mid));
      await settingSet(key, JSON.stringify(prev.slice(-80)));
    } catch (_e) {}
  }
  try {
    await pushUi(cq.message && cq.message.message_id);
  } catch (_e) {}
  if (extraSend) {
    try {
      const sent = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: extraSend.text,
        reply_markup: extraSend.reply_markup,
      });
      await pushUi(sent && (sent.message_id || sent.messageId));
    } catch (_) {}
  }
}


export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;
    try { await loadWorkHoursFromSettings(); } catch (_e) {}

    // H1: کاربر بن‌شده هیچ callbackای را اجرا نکند
    try {
      if (!isOwner(userId)) {
        const _bu = await getUser(userId);
        if (_bu && Number(_bu.blocked) === 1) {
          try {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: 'شما از ربات مسدود شده‌اید.',
              show_alert: true,
            });
          } catch (_e) {}
          return;
        }
      }
    } catch (_eBan) {}

    // —— هندلرهای کمکی (بن / حذف / ناوبری) ——
// —— بن کاربر از جستجو ——
    
    if (data === 'nav:search') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await setState(userId, 'search_user');
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'آیدی عددی یا @username کاربر را بفرستید:',
        reply_markup: sanitizeMarkup({ keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true }),
      });
      return;
    }
if (data.startsWith('ban_user:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const tid = Number(data.split(':')[1]);
      if (!tid) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      if (isOwner(tid)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نمی‌توان مالک را بن کرد', show_alert: true });
        return;
      }
      try {
        const existing = await db.select().from(users).where(eq(users.userId, tid)).all();
        if (existing && existing.length) {
          await db.update(users).set({ blocked: 1 }).where(eq(users.userId, tid)).run();
        } else {
          await db
            .insert(users)
            .values({
              userId: tid,
              role: 'user',
              started: 0,
              blocked: 1,
            })
            .run();
        }
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'مسدود شد' });
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text:
            '🚫 کاربر ' +
            tid +
            ' از ربات مسدود شد.\nدیگر نمی‌تواند پیام بفرستد یا از منوها استفاده کند.',
        });
      } catch (e) {
        console.error('ban_user', e);
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'خطا: ' + String((e && e.message) || e).slice(0, 100),
          show_alert: true,
        });
      }
      return;
    }

    // —— لغو پیام pending توسط خود کاربر ——
    if (data.startsWith('ucancel:')) {
      const id = Number(data.split(':')[1]);
      try {
        const rows = (await db.select().from(messages).where(eq(messages.id, id)).all()) || [];
        const row = rows[0];
        if (!row || Number(row.userId) !== Number(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
        if (String(row.status) !== 'pending') {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دیگر در انتظار نیست', show_alert: true });
          return;
        }
        await db
          .update(messages)
          .set({ status: 'rejected', rejectReason: 'لغو توسط کاربر', reviewedBy: Number(userId), reviewedAt: new Date() })
          .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
          .run();
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (_e) {}
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '✅ پیام #' + id + ' از صف انتظار لغو شد و دیگر بررسی نمی‌شود.',
        });
      } catch (e) {
        console.error('ucancel', e);
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'خطا', show_alert: true });
      }
      return;
    }
    if (data === 'ucancel_close') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      } catch (_e) {}
      return;
    }

    // —— درخواست حذف پیام منتشرشده توسط کاربر (تأیید مالک) ——
    if (data.startsWith('udel_ok:') || data.startsWith('udel_no:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const ok = parts[0] === 'udel_ok';
      const mid = Number(parts[1]);
      const uid = Number(parts[2]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: ok ? 'حذف…' : 'رد شد' });
      try {
        if (!ok) {
          try {
            await api.sendMessage({ chat_id: uid, text: '❌ درخواست حذف پیام #' + mid + ' توسط مالک رد شد.' });
          } catch (_e) {}
          try {
            await api.editMessageReplyMarkup({
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              reply_markup: { inline_keyboard: [] },
            });
          } catch (_e) {}
          try {
            const fbs = (await db.select().from(feedback).all()) || [];
            for (const f of fbs) {
              if (String(f.status) !== 'open') continue;
              if (String(f.content || '').includes('DEL_REQ:' + mid)) {
                try {
                  await db.update(feedback).set({ status: 'closed' }).where(eq(feedback.id, f.id)).run();
                } catch (_e) {}
              }
            }
          } catch (_e) {}
          return;
        }
        const rows = (await db.select().from(messages).where(eq(messages.id, mid)).all()) || [];
        const row = rows[0];
        if (!row) {
          await api.sendMessage({ chat_id: cq.message.chat.id, text: 'پیام یافت نشد' });
          return;
        }
        const ck = String(row.channelKey || row.channel_key || '');
        let channelMsgId = null;
        let chatIdCh = CHANNEL_IDS && CHANNEL_IDS[ck] != null ? Number(CHANNEL_IDS[ck]) : null;
        try {
          const ref = await findChannelMessageByInternalId(mid);
          if (ref) {
            if (ref.channelMsgId) channelMsgId = Number(ref.channelMsgId);
            if (ref.chatId != null) chatIdCh = Number(ref.chatId);
          }
        } catch (_e) {}
        if (chatIdCh && channelMsgId) {
          try {
            await api.deleteMessage({ chat_id: chatIdCh, message_id: channelMsgId });
          } catch (e) {
            await api.sendMessage({
              chat_id: cq.message.chat.id,
              text: 'خطا حذف از کانال: ' + String((e && (e.description || e.message)) || e).slice(0, 120),
            });
            return;
          }
        } else {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'لینک کانال برای #' + mid + ' پیدا نشد؛ از کانال دستی حذف کنید.',
          });
        }
        try {
          const n = Number(await settingGet('user_del_ok:' + uid, '0')) || 0;
          await settingSet('user_del_ok:' + uid, String(n + 1));
        } catch (_e) {}
        try {
          await api.sendMessage({
            chat_id: uid,
            text: '✅ درخواست حذف پیام #' + mid + ' تأیید شد و از کانال حذف گردید.',
          });
        } catch (_e) {}
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (_e) {}
        // بستن فیدبک‌های مرتبط در «پیام کاربران»
        try {
          const fbs = (await db.select().from(feedback).all()) || [];
          for (const f of fbs) {
            if (String(f.status) !== 'open') continue;
            if (String(f.content || '').includes('DEL_REQ:' + mid)) {
              try {
                await db.update(feedback).set({ status: 'closed' }).where(eq(feedback.id, f.id)).run();
              } catch (_e) {}
            }
          }
        } catch (_e) {}
        await api.sendMessage({ chat_id: cq.message.chat.id, text: '✅ #' + mid + ' از کانال حذف شد.' });
      } catch (e) {
        console.error('udel', e);
      }
      return;
    }

    // —— حذف پیام از کانال (نه از دیتابیس) ——
    // callback: smsg_del:<internalId>  یا  smsg_del:<internalId>:<channelKey>:<channelMsgId>
    if (data.startsWith('smsg_del:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const mid = Number(parts[1]);
      let ckFromCb = parts[2] || null;
      let channelMsgIdFromCb = parts[3] != null ? Number(parts[3]) : null;
      try {
        const rows = await db.select().from(messages).where(eq(messages.id, mid)).all();
        if (!rows || !rows.length) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'یافت نشد', show_alert: true });
          return;
        }
        const row = rows[0];
        let chatIdCh = null;
        let channelMsgId = channelMsgIdFromCb;
        let ck = ckFromCb || row.channelKey || row.channel_key || null;

        if (channelMsgId && ck && CHANNEL_IDS && CHANNEL_IDS[ck] != null) {
          chatIdCh = Number(CHANNEL_IDS[ck]);
        }

        if (!chatIdCh || !channelMsgId) {
          try {
            const ref = await findChannelMessageByInternalId(mid);
            if (ref) {
              if (ref.chatId != null) chatIdCh = Number(ref.chatId);
              if (ref.channelMsgId != null) channelMsgId = Number(ref.channelMsgId);
              if (ref.channelKey) ck = ref.channelKey;
            }
          } catch (_e) {}
        }

        if ((!chatIdCh || !channelMsgId) && ck && CHANNEL_IDS && CHANNEL_IDS[ck] != null) {
          chatIdCh = Number(CHANNEL_IDS[ck]);
        }

        // آخرین تلاش: اگر فقط channelMsgId از callback داریم
        if (!chatIdCh && ck && CHANNEL_IDS && CHANNEL_IDS[ck] != null) {
          chatIdCh = Number(CHANNEL_IDS[ck]);
        }

        if (!chatIdCh || !channelMsgId) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'پیام کانال پیدا نشد. لینک عمومی کانال را در حذف پیام کانال بفرستید.',
            show_alert: true,
          });
          return;
        }
        await api.deleteMessage({ chat_id: chatIdCh, message_id: channelMsgId });
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'از کانال حذف شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: (cq.message.text || '') + '\n\n🗑 از کانال حذف شد (در دیتابیس باقی ماند).',
          });
        } catch (_e) {}
      } catch (e) {
        console.error('smsg_del', e);
        const em = (e && (e.description || e.message)) || String(e);
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'خطا حذف کانال: ' + String(em).slice(0, 120),
          show_alert: true,
        });
      }
      return;
    }

    // —— حذف دسته‌جمعی ادمین ——
    if (data.startsWith('abulkdel:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const ck = data.split(':')[1];
      await setState(userId, 'bulk_del_admin', { channelKey: ck || null });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          'حذف دسته‌جمعی ادمین' +
          (ck ? ' «' + ((DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck) + '»' : '') +
          '\nهر خط یک آیدی عددی یا @username بفرستید:',
        reply_markup: sanitizeMarkup({ keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true }),
      });
      return;
    }

    // —— پاسخ ادمین به اطلاعیه انتقادات ——
    if (data === 'admin_fb_reply') {
      try {
        const rfb = await getRole(userId);
        if (!isOwner(userId) && rfb !== 'admin' && rfb !== 'subleader' && rfb !== 'sub_leader') {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      } catch (_e) {
        if (!isOwner(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
      await setState(userId, 'admin_fb_reply_text', {});
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'پاسخ خود را بنویسید (مستقیم برای مالک ارسال می‌شود):',
      });
      return;
    }

    
    if (data.startsWith('uv:')) {
      try {
        const roleUv = await getRole(userId);
        if (!isOwner(userId) && roleUv !== 'admin' && roleUv !== 'subleader' && roleUv !== 'sub_leader') {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      } catch (_e) {
        if (!isOwner(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
      const uid = Number(data.slice(3));
      if (!Number.isFinite(uid) || uid <= 0) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'آیدی نامعتبر', show_alert: true });
        return;
      }
      let u = null;
      try { u = await getUser(uid); } catch (_) {}
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(uid)
        : String(uid);
      const un = u && u.username ? '@' + u.username : '—';
      await api.answerCallbackQuery({ callback_query_id: cq.id });

      // پیام‌های کاربر
      let pe = 0, ap = 0, rj = 0;
      let lastLines = [];
      try {
        const ms = await loadUserMessages(uid, 50, { maxScan: 10000, maxRounds: 15 });
        for (const m of ms) {
          const st = String(m.status || '');
          if (st === 'pending' || st === 'publishing') pe++;
          else if (st === 'approved') ap++;
          else if (st === 'rejected') rj++;
        }
        const map = { pending: '🟡', approved: '🟢', rejected: '🔴', publishing: '⏳' };
        for (const row of ms.slice(0, 12)) {
          const short = String(row.content || '').replace(/\n/g, ' ').slice(0, 60);
          lastLines.push((map[row.status] || '•') + ' #' + row.id + ' | ' + short);
        }
      } catch (e) {
        console.error('uv msgs', e);
      }

      // عملکرد بررسی‌کننده (اگر ادمین بوده) — فقط ۳۰۰ ردیف اخیر
      let perfLines = [];
      try {
        const revs =
          (await db
            .select({
              status: messages.status,
              reviewedAt: messages.reviewedAt,
            })
            .from(messages)
            .where(eq(messages.reviewedBy, uid))
            .orderBy(desc(messages.id))
            .limit(300)
            .all()) || [];
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const labels = ['امروز', 'دیروز', '۲ روز پیش', '۳ روز پیش', '۴ روز پیش', '۵ روز پیش', '۶ روز پیش'];
        for (let d = 0; d < 7; d++) {
          const start = now - (d + 1) * dayMs;
          const end = now - d * dayMs;
          let dayAp = 0, dayRj = 0;
          for (const m of revs) {
            if (!m.reviewedAt) continue;
            const t = new Date(m.reviewedAt).getTime();
            if (t >= start && t < end) {
              if (m.status === 'approved') dayAp++;
              else if (m.status === 'rejected') dayRj++;
            }
          }
          perfLines.push(labels[d] + ': ' + dayAp + ' تأیید، ' + dayRj + ' رد');
        }
      } catch (e) {
        console.error('uv perf', e);
      }

      let caption =
        '👤 ' + name +
        '\nیوزرنیم: ' + un +
        '\nآیدی: ' + uid +
        '\nنقش: ' + ((u && u.role) || 'user') +
        '\n📨 اخیر: 🟡' + pe + ' 🟢' + ap + ' 🔴' + rj;
      try {
        if (u && u.createdAt) caption += '\n📅 عضویت: ' + formatTsJalali(u.createdAt);
      } catch (_e) {}
      if (perfLines.length) caption += '\n\n📊 عملکرد بررسی (نمونه اخیر):\n' + perfLines.join('\n');
      if (lastLines.length) caption += '\n\nآخرین پیام‌ها:\n' + lastLines.join('\n');

      try {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: caption.slice(0, 3900),
        });
      } catch (e) {
        console.error('uv send', e);
        try {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: '👤 ' + name + '\nآیدی: ' + uid + '\n(جزئیات کامل در دسترس نبود)',
          });
        } catch (_e2) {}
      }
      return;
    }


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
        '<b>با رعایت قوانین تکست بدین</b>\n' +
        '@arail_bot\n\n' +
        '<blockquote>1. پیامتون با ' + prefixName + ' شروع بشه</blockquote>\n' +
        '<blockquote>2. پیام خودتون رو برجسته کنید</blockquote>\n' +
        '<blockquote>3. با یک فاصله از متن نقطه بذارید.</blockquote>\n' +
        '<blockquote>4. محتوای پیامتون فحش و هیت و تکراری نباشه !</blockquote>';
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


    // مالک از جستجو: تأیید و انتشار پیام ردشده
    if (data.startsWith('search_approve:')) {
      const id = Number(data.split(':')[1]);
      try {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⏳ انتشار…' });
      } catch (_e) {}
      if (!isOwner(userId)) {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'فقط مالک',
            show_alert: true,
          });
        } catch (_e) {}
        return;
      }
      const rows0 = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows0 && rows0[0];
      if (!row) {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'پیام پیدا نشد',
            show_alert: true,
          });
        } catch (_e) {}
        return;
      }
      const st = String(row.status || '');
      if (st === 'approved') {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'قبلاً تأیید شده',
            show_alert: true,
          });
        } catch (_e) {}
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        } catch (_e) {}
        return;
      }
      if (st !== 'rejected' && st !== 'pending') {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'وضعیت قابل تأیید نیست: ' + st,
            show_alert: true,
          });
        } catch (_e) {}
        return;
      }
      try {
        const ckAd = String((row.channelKey ?? row.channel_key) || '');
        if (ckAd && (await isChannelAdMode(ckAd))) {
          try {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: '📢 کانال در حالت تب است',
              show_alert: true,
            });
          } catch (_e) {}
          return;
        }
      } catch (_e) {}
      // رزرو اتمیک قبل از ارسال (برای pending؛ rejected را اول به pending برگردان)
      const st0 = String(row.status || '');
      if (st0 === 'rejected') {
        try {
          await db
            .update(messages)
            .set({ status: 'pending', rejectReason: null, reviewedBy: null })
            .where(and(eq(messages.id, id), eq(messages.status, 'rejected')))
            .run();
        } catch (_e) {}
      }
      const reserved = await reserveMessageForPublish(id, userId);
      if (!reserved.ok && st0 !== 'publishing') {
        // اگر publishing خود مالک است ادامه بده
        const can = await canCompletePublishing(id, userId);
        if (!can.ok) {
          try {
            await api.sendMessage({
              chat_id: userId,
              text: 'این پیام هم‌اکنون توسط دیگری در حال انتشار است.',
            });
          } catch (_e) {}
          return;
        }
      }
      const conf = DEFAULT_CHANNELS[row.channelKey || row.channel_key];
      if (!conf || !conf.chatId) {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'کانال پیکربندی نشده',
            show_alert: true,
          });
        } catch (_e) {}
        return;
      }
      let link = null;
      let mid = null;
      try {
        const sent = await api.sendMessage({
          chat_id: conf.chatId,
          text: toBoldHtml(row.content),
          parse_mode: 'HTML',
        });
        mid = sent && sent.message_id;
        if (!mid) throw new Error('message_id خالی');
        link = channelMessageLink(conf.chatId, mid, row.channelKey || row.channel_key);
        rememberChannelMessage(row.channelKey || row.channel_key, mid, id).catch(function () {});
      } catch (e) {
        console.error('search_approve publish', e);
        try {
          await api.sendMessage({
            chat_id: userId,
            text:
              '⚠️ انتشار #' +
              id +
              ' ناموفق:\n' +
              ((e && (e.description || e.message)) || String(e)),
          });
        } catch (_e) {}
        return;
      }
      try {
        await db
          .update(messages)
          .set({
            status: 'approved',
            reviewedBy: Number(userId),
            reviewedAt: new Date(),
            rejectReason: null,
          })
          .where(eq(messages.id, id))
          .run();
      } catch (e) {
        console.error('search_approve status', e);
      }
      try {
        const bk = exactBodyKey(row.content);
        if (bk) {
          await settingSet(
            bodyIndexSettingKey(row.channelKey || row.channel_key, bk),
            String(id) + '|approved'
          );
        }
      } catch (_e) {}
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      } catch (_e) {}
      const title = conf.title || row.channelKey;
      await api.sendMessage({
        chat_id: userId,
        text:
          '✅ پیام #' +
          id +
          ' تأیید و منتشر شد.\n\n' +
          'مشاهده در کانال «' +
          title +
          '»:\n' +
          (link || ''),
        link_preview_options: link ? { is_disabled: false, url: link } : undefined,
      });
      try {
        let txt = '✅ پیام شما تأیید و منتشر شد.';
        if (link) txt += '\n\nمشاهده در کانال «' + title + '»:\n' + link;
        await api.sendMessage({
          chat_id: row.userId,
          text: txt,
          link_preview_options: link ? { is_disabled: false, url: link } : undefined,
        });
      } catch (_e) {}
      return;
    }

    if (data.startsWith('approve:')) {
      const id = Number(data.split(':')[1]);
      async function ans(text, alert) {
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: String(text || '…').slice(0, 180),
            show_alert: !!alert,
          });
        } catch (_e) {}
      }

      try {
        const rows0 = await db.select().from(messages).where(eq(messages.id, id)).all();
        let pendingRow = rows0 && rows0[0];
        if (!pendingRow) {
          await ans('پیام یافت نشد', true);
          return;
        }
        const st0 = String(pendingRow.status || '');
        if (st0 !== 'pending' && st0 !== 'publishing') {
          try { await dropMessageFromReviewBatch(userId, id); } catch (_e) {}
          await ans('قبلاً بررسی شده', false);
          await editReviewResult(cq, 'ℹ️ این پیام قبلاً بررسی شده #' + id, {
            inBatch: true, complete: true, hasMore: true,
          });
          return;
        }

        // حالت تب
        try {
          const ckAd = String((pendingRow.channelKey ?? pendingRow.channel_key) || '');
          if (ckAd && (await isChannelAdMode(ckAd))) {
            await ans('📢 کانال در حالت تب است؛ تأیید ممکن نیست.', true);
            return;
          }
        } catch (_e) {}

        // دسترسی + رزرو قبل از answer نهایی
        if (st0 === 'pending') {
          const acc = await checkReviewAccess(userId, pendingRow);
          if (!acc.ok) {
            await ans(acc.text || 'دسترسی ندارید', true);
            return;
          }
          const reserved = await reserveMessageForPublish(id, userId);
          if (!reserved.ok) {
            await ans(
              reserved.code === 'other_holder'
                ? 'شخص دیگری در حال انتشار است'
                : 'گرفته شد؛ دوباره بزنید',
              true
            );
            return;
          }
          if (reserved.row) pendingRow = reserved.row;
        } else {
          const can = await canCompletePublishing(id, userId);
          if (!can.ok) {
            await ans(
              can.code === 'other_holder'
                ? 'شخص دیگری در حال انتشار است'
                : 'دسترسی ندارید',
              true
            );
            return;
          }
        }

        await ans('⏳ در حال انتشار…', false);

        const ckRaw = String((pendingRow.channelKey ?? pendingRow.channel_key) || '');
        const ckNorm = normalizeChannelKey(ckRaw) || ckRaw;
        const conf = DEFAULT_CHANNELS[ckNorm] || DEFAULT_CHANNELS[ckRaw];
        if (!conf || !conf.chatId) {
          try {
            await db
              .update(messages)
              .set({ status: 'pending', reviewedBy: null })
              .where(eq(messages.id, id))
              .run();
          } catch (_e) {}
          try {
            await api.sendMessage({ chat_id: userId, text: 'کانال پیکربندی نشده #' + id });
          } catch (_e2) {}
          return;
        }
        pendingRow.channelKey = conf.key || ckNorm || pendingRow.channelKey;

        // فقط lookup سبک msgch: — بدون اسکن settings
        let mid = null;
        let link = null;
        let alreadyPosted = false;
        if (st0 === 'publishing') {
          try {
            const ref = await findChannelMessageByInternalId(id);
            if (ref && ref.channelMsgId) {
              alreadyPosted = true;
              mid = Number(ref.channelMsgId);
              link = channelMessageLink(conf.chatId, mid, pendingRow.channelKey);
            }
          } catch (_e) {}
        }

        if (!alreadyPosted) {
          try {
            const sent = await api.sendMessage({
              chat_id: conf.chatId,
              text: toBoldHtml(pendingRow.content),
              parse_mode: 'HTML',
            });
            mid = sent && sent.message_id;
            if (!mid) throw new Error('message_id خالی');
            link = channelMessageLink(conf.chatId, mid, pendingRow.channelKey);
            try {
              await rememberChannelMessage(pendingRow.channelKey, mid, id);
            } catch (_e) {}
          } catch (e) {
            console.error('publish first', e);
            try {
              await db
                .update(messages)
                .set({ status: 'pending', reviewedBy: null })
                .where(eq(messages.id, id))
                .run();
            } catch (_e) {}
            try {
              await api.sendMessage({
                chat_id: userId,
                text:
                  '⚠️ #' +
                  id +
                  ' در کانال منتشر نشد.\n' +
                  String((e && (e.description || e.message)) || e).slice(0, 200) +
                  '\nدوباره تأیید را بزنید.',
              });
            } catch (_e) {}
            return;
          }
        }

        // approved
        try {
          await db
            .update(messages)
            .set({
              status: 'approved',
              reviewedBy: Number(userId),
              reviewedAt: new Date(),
              rejectReason: null,
            })
            .where(eq(messages.id, id))
            .run();
        } catch (e) {
          console.error('approve status', e);
          try {
            await api.sendMessage({
              chat_id: userId,
              text: 'در کانال رفت ولی ثبت وضعیت خطا داد #' + id,
            });
          } catch (_e) {}
        }

        try { await dropMessageFromReviewBatch(userId, id); } catch (_e) {}
        try { dropMessageFromAllReviewBatches(id).catch(function () {}); } catch (_e) {}

        const fin = await finishReviewBatchIfComplete(userId, id);
        await editReviewResult(cq, '🟢 تأیید و منتشر شد #' + id, fin);

        const uidNotify = Number(pendingRow.userId ?? pendingRow.user_id);
        if (uidNotify) {
          const title = conf.title || pendingRow.channelKey;
          let txt = '✅ پیام شما تأیید و منتشر شد.';
          if (link) txt += '\n\nمشاهده در کانال «' + title + '»:\n' + link;
          api
            .sendMessage({
              chat_id: uidNotify,
              text: txt,
              link_preview_options: link ? { is_disabled: false, url: link } : undefined,
            })
            .catch(function () {});
        }
      } catch (e) {
        console.error('approve', e);
        try {
          await api.sendMessage({
            chat_id: userId,
            text: 'خطا در تأیید #' + id + ': ' + String((e && (e.message || e.description)) || e).slice(0, 150),
          });
        } catch (_e) {}
      }
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
        text: 'دلیل رد را بنویسید (حداکثر ۳۰ کاراکتر):',
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
      try {
        const rb = await getRole(userId);
        if (!isOwner(userId) && rb !== 'admin' && rb !== 'subleader' && rb !== 'sub_leader') {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      } catch (_e) {
        if (!isOwner(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
          return;
        }
      }
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
      const ckRaw = parts[1];
      const ck = normalizeChannelKey(ckRaw) || String(ckRaw || '');
      const requesterId = Number(parts[2]);
      try {
        if (!ck || !DEFAULT_CHANNELS[ck]) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
          return;
        }
        let isAdm = false;
        try {
          isAdm = await isUserChannelAdmin(userId, ck);
        } catch (_e) {}
        if (!isAdm && !isOwner(userId)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'فقط ادمین همین کانال',
            show_alert: true,
          });
          return;
        }
        if (Number(userId) === Number(requesterId)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'درخواست خودتان است',
            show_alert: true,
          });
          return;
        }

        const now = tehranNow();
        const pdate = periodDateStr(now);
        const takenKey = 'help_taken:' + ck + ':' + pdate + ':' + String(requesterId || 0);
        let prev = '';
        try {
          prev = await settingGet(takenKey, '');
        } catch (_e) {}
        if (prev && Number(prev) !== Number(userId)) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'قبلاً فرد دیگری قبول کرده',
            show_alert: true,
          });
          return;
        }

        let reqShift = null;
        try {
          const all = (await db.select().from(shifts).all()) || [];
          for (const s of all) {
            if (Number(s.adminId ?? s.admin_id) !== Number(requesterId)) continue;
            if (normalizeChannelKey(s.channelKey ?? s.channel_key) !== ck) continue;
            if (String(s.status) !== 'active') continue;
            if (!shiftActiveNow(s, now, pdate)) continue;
            reqShift = s;
            break;
          }
        } catch (e) {
          console.error('help_ok find shift', e);
        }
        if (!reqShift) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'شیفت درخواست‌دهنده فعال نیست',
            show_alert: true,
          });
          return;
        }

        const endHm = String(reqShift.endHm || reqShift.end_hm || '').slice(0, 5);
        let startHm = String(now.hm || '').slice(0, 5);
        try {
          if (periodOrd(startHm) >= periodOrd(endHm) && endHm !== startHm) {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: 'شیفت تقریباً تمام شده',
              show_alert: true,
            });
            return;
          }
        } catch (_e) {}

        try {
          await db
            .insert(shifts)
            .values({
              channelKey: ck,
              adminId: Number(userId),
              shiftDate: pdate,
              startHm: startHm,
              endHm: endHm,
              status: 'active',
            })
            .run();
        } catch (eIns) {
          console.error('help_ok insert shift', eIns);
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'خطا در ثبت شیفت کمکی',
            show_alert: true,
          });
          return;
        }
        try {
          await settingSet(takenKey, String(userId));
        } catch (_e) {}
        try {
          if (typeof clearMemo === 'function') clearMemo('ask:' + Number(userId));
        } catch (_e) {}

        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'شیفت کمکی ثبت شد',
          show_alert: true,
        });

        const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
        let who = String(userId);
        try {
          who = displayName(await getUser(userId), userId);
        } catch (_e) {}

        if (requesterId) {
          try {
            await api.sendMessage({
              chat_id: requesterId,
              text:
                '✅ ' +
                who +
                ' کمک را پذیرفت. شیفت کمکی تا ' +
                endHm +
                ' در «' +
                title +
                '».',
            });
          } catch (_e) {}
        }
        const doneText =
          (cq.message && cq.message.text ? cq.message.text : '') +
          '\n\n✅ شما قبول کردید.\nشیفت کمکی: ' +
          startHm +
          '–' +
          endHm +
          '\nالان «📥 پیام‌های در انتظار» را بزنید.';
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: doneText,
          });
        } catch (_e) {
          try {
            await api.sendMessage({
              chat_id: cq.message.chat.id,
              text:
                '✅ شیفت کمکی ثبت شد: «' +
                title +
                '» ' +
                startHm +
                '–' +
                endHm +
                '\n📥 پیام‌های در انتظار را بزنید.',
            });
          } catch (_e2) {}
        }
      } catch (e) {
        console.error('help_ok', e);
        try {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'خطا',
            show_alert: true,
          });
        } catch (_e) {}
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
      // پاسخ سریع تا تلگرام لودینگ نماند
      try {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⏳ دریافت Batch…' });
      } catch (_e) {}
      // اگر Batch فعلی هنوز پیام pending دارد → اجازه نده زودتر برود
      try {
        const curBatch = await getReviewBatch(userId);
        if (curBatch && curBatch.ids && curBatch.ids.length) {
          const checks = await Promise.all(
            curBatch.ids.map(function (mid) {
              return db
                .select({ id: messages.id, status: messages.status })
                .from(messages)
                .where(eq(messages.id, Number(mid)))
                .all()
                .catch(function () {
                  return [];
                });
            })
          );
          let stillPending = false;
          for (const rows of checks) {
            if (rows && rows[0] && String(rows[0].status) === 'pending') {
              stillPending = true;
              break;
            }
          }
          if (stillPending) {
            await api.sendMessage({
              chat_id: cq.message.chat.id,
              text: '⛔ ابتدا همه پیام‌های این Batch را تأیید یا رد کنید.',
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
          await api.sendMessage({ chat_id: cq.message.chat.id, text: 'این دکمه قدیمی است. دوباره «📥 پیام‌های در انتظار» را بزنید.' });
          return;
        }
      }
                  try {
        await clearReviewUiMessages(userId, cq.message.chat.id);
      } catch (_e) {}
      try {
        await api.deleteMessage({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
        });
      } catch (_e) {}
const res = await createReviewBatch(userId);
      if (res.status === 'no_shift') {
        await api.sendMessage({ chat_id: cq.message.chat.id, text: '❌ شیفت شما تمام شده است.' });
        return;
      }
      if (res.status === 'busy') {
        await api.sendMessage({ chat_id: cq.message.chat.id, text: '⏳ در حال پردازش… لحظه‌ای بعد دوباره بزنید.' });
        return;
      }
      if (res.status === 'incomplete') {
        /* answered early */
        await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: true });
        return;
      }
      if (res.status === 'empty') {
        /* answered early */
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
      /* answered early */
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
      const uid = Number(data.slice(8));
      if (!Number.isFinite(uid) || uid <= 0) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'آیدی نامعتبر', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      let uu = null;
      try { uu = await getUser(uid); } catch (_e) {}
      let pe = 0, ap = 0, rj = 0;
      let ms = [];
      try {
        ms = await loadUserMessages(uid, 50, { maxScan: 10000, maxRounds: 15 });
        for (const m of ms) {
          const st = String(m.status || '');
          if (st === 'pending' || st === 'publishing') pe++;
          else if (st === 'approved') ap++;
          else if (st === 'rejected') rj++;
        }
      } catch (e) {
        console.error('fb_user msgs', e);
      }
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴', publishing: '⏳' };
      let body =
        '👤 ' +
        displayName(uu, uid) +
        '\n🆔 ' +
        uid +
        (uu && uu.username ? '\n@' + uu.username : '') +
        '\nنقش: ' +
        ((uu && uu.role) || 'user') +
        '\n📨 اخیر (حداکثر ۲۰۰): 🟡' +
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
        let list = 'آخرین پیام‌ها:\n';
        for (const row of ms.slice(0, 15)) {
          const short = String(row.content || '').replace(/\n/g, ' ').slice(0, 70);
          list += (map[row.status] || '•') + ' #' + row.id + ' | ' + (row.status || '') + '\n' + short + '\n\n';
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
      if (!channelKey) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
        return;
      }
      await setState(userId, 'add_admin_id', { channelKey: String(channelKey) });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          'آیدی عددی یا @username برای افزودن به «' +
          ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
          '»\n\nچند نفر را با خط جدید می‌توانید بفرستید.',
        reply_markup: sanitizeMarkup({
          keyboard: [[{ text: '◀️ بازگشت' }]],
          resize_keyboard: true,
        }),
      });
      return;
    }

    if (data.startsWith('abulk:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      await setState(userId, 'bulk_del_admin', { channelKey: channelKey || null });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const title =
        (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey || 'همه';
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '🗑 حذف دسته‌جمعی از «' +
          title +
          '»\n\nآیدی عددی یا @username را بفرستید (هر خط یک مورد):\n\nمثال:\n8607359838\n8086042544\n\nبرای انصراف ◀️ بازگشت.',
        reply_markup: sanitizeMarkup({
          keyboard: [[{ text: '◀️ بازگشت' }]],
          resize_keyboard: true,
        }),
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

    // —— عضویت اجباری
    if (data === 'fj_check') {
      try {
        const res = await confirmForceJoinUser(userId);
        if (!res.ok) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: res.message || 'عضو نیستید',
            show_alert: true,
          });
          return;
        }
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'تأیید شد',
        });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '✅ عضویت تأیید شد.',
          });
        } catch (_e) {}
        let replyKb = userKeyboard();
        try {
          const r = await getRole(userId);
          if (r === 'owner') replyKb = ownerKeyboard(userId);
          else if (r === 'subleader') replyKb = subLeaderKeyboard();
          else if (r === 'admin') replyKb = adminKeyboard();
        } catch (_e) {}
        // به کاربر جزئیات کمپین نشان داده نمی‌شود
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'می‌توانید از ربات استفاده کنید.',
          reply_markup: replyKb,
        });
        if (res.finished) {
          let ownerTxt =
            '🔐 کمپین عضویت اجباری تمام شد.\n' +
            'تأیید: ' +
            ((res.camp && res.camp.confirmedCount) || '') +
            ' / ' +
            ((res.camp && res.camp.targetCount) || '');
          if (res.nextCamp) {
            ownerTxt +=
              '\n\n▶️ کمپین بعدی از صف شروع شد:\n«' +
              (res.nextCamp.title || forceJoinTitlesText(res.nextCamp) || '') +
              '»\nهدف: ' +
              (res.nextCamp.targetCount || '') +
              ' نفر';
          } else {
            ownerTxt += '\nصف نوبتی خالی است — عضویت اجباری خاموش شد.';
          }
          for (const oid of OWNER_IDS || []) {
            try {
              await api.sendMessage({ chat_id: oid, text: ownerTxt });
            } catch (_e) {}
          }
        }
      } catch (e) {
        console.error('fj_check', e);
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'خطا در بررسی',
          show_alert: true,
        });
      }
      return;
    }

    if (data === 'fj_new' || data === 'fj_cancel' || data === 'fj_close' || data === 'fj_clear_queue') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      if (data === 'fj_close') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بسته شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: 'پنل عضویت اجباری بسته شد.',
          });
        } catch (_e) {}
        return;
      }
      if (data === 'fj_cancel') {
        const camp = await getForceJoinCampaign();
        if (camp) {
          camp.active = false;
          camp.endedAt = new Date().toISOString();
          await pushForceJoinHistory({
            id: camp.id,
            title: camp.title,
            chatId: camp.chatId,
            targetCount: camp.targetCount,
            confirmedCount: camp.confirmedCount || 0,
            startMembers: camp.startMembers,
            endedAt: camp.endedAt,
            cancelled: true,
          });
          await saveForceJoinCampaign(null);
        }
        const next = await promoteNextForceJoinFromQueue();
        const qLeft = await getForceJoinQueue();
        let txt = '⏹ کمپین فعال لغو شد.';
        if (next) {
          txt +=
            '\n\n▶️ کمپین بعدی از صف شروع شد:\n«' +
            (next.title || forceJoinTitlesText(next) || '') +
            '» — هدف ' +
            (next.targetCount || '') +
            '\nباقی صف: ' +
            ((qLeft && qLeft.length) || 0);
        } else {
          txt += '\nصف نوبتی خالی است.';
        }
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: txt,
            reply_markup: sanitizeMarkup(forceJoinOwnerInline(!!next, (qLeft && qLeft.length) || 0)),
          });
        } catch (_e) {}
        return;
      }
      if (data === 'fj_clear_queue') {
        await clearForceJoinQueue();
        const camp = await getForceJoinCampaign();
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'صف خالی شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '🗑 صف نوبتی عضویت اجباری خالی شد.\nکمپین فعال دست نخورده باقی ماند.',
            reply_markup: sanitizeMarkup(forceJoinOwnerInline(!!(camp && camp.active), 0)),
          });
        } catch (_e) {}
        return;
      }
      if (data === 'fj_new') {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
        await setState(userId, 'force_join_link', { channels: [] });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '🔗 لینک کانال یا گروه را بفرستید.\n' +
              'می‌توانید چند لینک پشت‌سرهم بفرستید (همزمان در یک کمپین).\n' +
              'وقتی تمام شد، عدد هدف را بفرستید (مثلاً 100).\n\n' +
              'اگر کمپین دیگری فعال باشد، این یکی در صف نوبتی می‌ماند.\n' +
              'ربات باید در هر مورد ادمین باشد (مشاهده اعضا).',
          });
        } catch (_e) {}
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'لینک اول را بفرستید:',
          reply_markup: sanitizeMarkup({ keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true }),
        });
        return;
      }
    }

    // —— پنل شیشه‌ای انواع غیرفعال‌سازی
    if (data.startsWith('dis:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const action = data.slice(4);
      async function refreshDisablePanel(extraLine) {
        const [fri, botOn, queue] = await Promise.all([
          isFridayMode(),
          isBotOn(),
          isQueueBusyMode(),
        ]);
        let body =
          '🛑 انواع غیرفعال‌سازی ربات\n\n' +
          '• 🌙 جمعه: ' +
          (fri ? 'روشن' : 'خاموش') +
          '\n• 🔴 ربات: ' +
          (botOn ? 'روشن' : 'خاموش') +
          '\n• ⏳ صف شلوغ: ' +
          (queue ? 'روشن' : 'خاموش') +
          '\n\nدکمه‌ها را بزنید؛ وضعیت لحظه‌ای عوض می‌شود.';
        if (extraLine) body += '\n\n' + extraLine;
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: body,
            reply_markup: sanitizeMarkup(
              disableModesInline({ friday: fri, botOn: botOn, queueBusy: queue })
            ),
          });
        } catch (_e) {
          try {
            await api.editMessageReplyMarkup({
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              reply_markup: sanitizeMarkup(
                disableModesInline({ friday: fri, botOn: botOn, queueBusy: queue })
              ),
            });
          } catch (_e2) {}
        }
      }
      if (action === 'close') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بسته شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: 'پنل غیرفعال‌سازی بسته شد.',
          });
        } catch (_e) {}
        return;
      }
      if (action === 'refresh') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'به‌روز شد' });
        await refreshDisablePanel();
        return;
      }
      if (action === 'friday') {
        const cur = await isFridayMode();
        await setFridayMode(!cur);
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: !cur ? '🌙 حالت جمعه روشن' : '☀️ حالت جمعه خاموش',
        });
        await refreshDisablePanel(!cur ? '✅ حالت جمعه فعال شد.' : '✅ حالت جمعه خاموش شد.');
        return;
      }
      if (action === 'queue') {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
        try {
          // وضعیت فعلی هر کانال
          const lines = [];
          for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
            const on = await isChannelQueueBusy(ck);
            lines.push(
              ((DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck) +
                ': ' +
                (on ? '⏳ شلوغ' : '✅ آزاد')
            );
          }
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '⏳ صف شلوغ — کانال را انتخاب کنید\n' +
              'با هر کلیک فقط همان کانال عوض می‌شود.\n' +
              'کاربر برای کانال شلوغ پیام ثبت نمی‌کند؛ ادمین همچنان تأیید می‌کند.\n\n' +
              lines.join('\n'),
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chq')),
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: '⏳ کانال صف شلوغ را انتخاب کنید:',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chq')),
          });
        }
        return;
      }
      if (action === 'tab') {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '📢 حالت تب — کانال را انتخاب کنید\n' +
              'با هر کلیک وضعیت تب آن کانال عوض می‌شود.\n' +
              'کاربر برای آن کانال پیام نمی‌فرستد.',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chad')),
          });
        } catch (_e) {}
        return;
      }
      if (action === 'bot_off') {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '🔴 کدام کانال(ها) خاموش شوند؟',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('choff')),
          });
        } catch (_e) {}
        return;
      }
      if (action === 'bot_on') {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '🟢 کدام کانال(ها) روشن شوند؟',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chon')),
          });
        } catch (_e) {}
        return;
      }
      return;
    }

    if (data.startsWith('choff:') || data.startsWith('chon:') || data.startsWith('chad:') || data.startsWith('chq:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const mode = parts[0]; // choff | chon | chad
      const key = parts[1];
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      async function backToDisable(extra) {
        const [fri, botOn, queue] = await Promise.all([
          isFridayMode(),
          isBotOn(),
          isQueueBusyMode(),
        ]);
        let body =
          '🛑 انواع غیرفعال‌سازی ربات\n\n' +
          '• 🌙 جمعه: ' +
          (fri ? 'روشن' : 'خاموش') +
          '\n• 🔴 ربات: ' +
          (botOn ? 'روشن' : 'خاموش') +
          '\n• ⏳ صف شلوغ: ' +
          (queue ? 'روشن' : 'خاموش');
        if (extra) body += '\n\n' + extra;
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: body,
            reply_markup: sanitizeMarkup(
              disableModesInline({ friday: fri, botOn: botOn, queueBusy: queue })
            ),
          });
        } catch (_e) {}
      }
      if (key === 'cancel') {
        await backToDisable('لغو شد.');
        return;
      }
      const keys = key === 'all' ? Object.keys(DEFAULT_CHANNELS) : [key];
      if (mode === 'choff') {
        for (const k of keys) await setChannelEnabled(k, false);
        if (key === 'all') await settingSet('bot_enabled', '0');
        const names = keys.map(function (k) { return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k; }).join('، ');
        await backToDisable('🔴 خاموش شد: ' + names);
        return;
      }
      if (mode === 'chon') {
        for (const k of keys) await setChannelEnabled(k, true);
        await settingSet('bot_enabled', '1');
        const names = keys.map(function (k) { return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k; }).join('، ');
        await backToDisable('🟢 روشن شد: ' + names);
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
            text: '📢 حالت تب\n' + lines.join('\n') + '\n\nکانال دیگر را بزنید یا انصراف.',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chad')),
          });
        } catch (_e) {}
        return;
      }
      if (mode === 'chq') {
        for (const k of keys) {
          const cur = await isChannelQueueBusy(k);
          await setChannelQueueBusy(k, !cur);
        }
        // همگام‌سازی فلگ سراسری قدیمی
        try {
          let any = false;
          for (const ck of Object.keys(DEFAULT_CHANNELS || {})) {
            if (await isChannelQueueBusy(ck)) any = true;
          }
          await settingSet('queue_busy_mode', any ? '1' : '0');
        } catch (_e) {}
        let lines = [];
        for (const k of keys) {
          const on = await isChannelQueueBusy(k);
          lines.push(((DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k) + ': ' + (on ? '⏳ شلوغ' : '✅ آزاد'));
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: '⏳ صف شلوغ\n' + lines.join('\n') + '\n\nکانال دیگر را بزنید یا انصراف.',
            reply_markup: sanitizeMarkup(channelPickFlagsInline('chq')),
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
        // اولویت: copyMessage تا قالب (بولد/کوچک/لینک) حفظ شود
        if (st.fromChatId && st.fromMsgId && chId) {
          try {
            sent = await api.copyMessage({
              chat_id: chId,
              from_chat_id: st.fromChatId,
              message_id: st.fromMsgId,
            });
          } catch (eCopy) {
            console.error('post_yes copyMessage', eCopy);
            sent = null;
          }
        }
        if (!sent && st.media && st.media.fileId && chId) {
          const cap = st.postText || undefined;
          const ents = Array.isArray(st.postEntities) && st.postEntities.length ? st.postEntities : null;
          const t = st.media.type;
          const base = { chat_id: chId };
          if (cap) base.caption = cap;
          if (ents && cap) base.caption_entities = ents;
          if (t === 'photo') sent = await api.sendPhoto(Object.assign({ photo: st.media.fileId }, base));
          else if (t === 'video') sent = await api.sendVideo(Object.assign({ video: st.media.fileId }, base));
          else if (t === 'voice') {
            sent = await api.sendVoice({ chat_id: chId, voice: st.media.fileId });
            if (cap) {
              const p = { chat_id: chId, text: cap };
              if (ents) p.entities = ents;
              await api.sendMessage(p);
            }
          } else if (t === 'audio') sent = await api.sendAudio(Object.assign({ audio: st.media.fileId }, base));
          else if (t === 'document') sent = await api.sendDocument(Object.assign({ document: st.media.fileId }, base));
          else if (t === 'video_note') sent = await api.sendVideoNote({ chat_id: chId, video_note: st.media.fileId });
          else if (t === 'sticker') sent = await api.sendSticker({ chat_id: chId, sticker: st.media.fileId });
        }
        if (!sent) {
          // متن خالی با entities
          const ents = Array.isArray(st.postEntities) && st.postEntities.length ? st.postEntities : null;
          if (ents && st.postText && chId) {
            try {
              sent = await api.sendMessage({ chat_id: chId, text: st.postText, entities: ents });
            } catch (_e) {
              sent = await postToChannel(st.channelKey, st.postText || '');
            }
          } else {
            sent = await postToChannel(st.channelKey, st.postText || '');
          }
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
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      try {
        await api.answerCallbackQuery({ callback_query_id: cq.id });
      } catch (_e) {}
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '📋 لیست و لغو شیفت‌ها\n\nاول کانال را انتخاب کنید:',
        reply_markup: sanitizeMarkup(ownerShiftListChannelInline()),
      });
      return;
    }

    if (data.startsWith('own_shift_list:')) {
      try {
        try { await cancelInvalidShifts(); } catch (_e) {}
        if (!isOwner(userId)) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
          return;
        }
        const channelKey = String(data.split(':')[1] || '');
        if (!channelKey || !DEFAULT_CHANNELS[channelKey]) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
          return;
        }
        try {
          await api.answerCallbackQuery({ callback_query_id: cq.id });
        } catch (_e) {}
        const now = tehranNow();
        const pdate = periodDateStr(now);
        const title =
          (DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey;
        let all = [];
        try {
          all = (await db.select().from(shifts).all()) || [];
        } catch (e) {
          console.error('own_shift_list ch select', e);
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'خطا در خواندن شیفت‌ها',
          });
          return;
        }
        let group = all.filter(function (s) {
          const st = String(s.status || 'active');
          if (st !== 'active' && st !== 'cancelled') return false;
          if (String(s.channelKey || s.channel_key || '') !== channelKey) return false;
          const sd = String(s.shiftDate ?? s.shift_date ?? '');
          return (
            sd === String(pdate) ||
            sd === 'perm' ||
            sd === 'permanent' ||
            sd === String(now.date)
          );
        });
        try {
          group = sortShiftsByPeriod(group);
        } catch (_e) {}
        const rows = [];
        let t =
          '⏰ لیست و لغو — «' +
          title +
          '»\n📅 دوره ' +
          pdate +
          '\nنام‌ها در متن؛ دکمه‌ها فقط ساعت لغو.\n';
        if (!group.length) {
          t += '\nخالی — شیفت فعالی در این کانال نیست.';
        } else {
          t += '\n';
          for (let gi = 0; gi < group.length; gi++) {
            const s = group[gi];
            let name = String(s.adminId ?? s.admin_id ?? '');
            try {
              name = displayName(
                await getUser(Number(s.adminId ?? s.admin_id)),
                Number(s.adminId ?? s.admin_id)
              );
            } catch (_e) {}
            name = String(name || '')
              .replace(/[\u0000-\u001F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 40);
            if (!name) name = String(s.adminId ?? '');
            const st = String(s.status || 'active');
            const mark = st === 'cancelled' ? '🔴لغو #' : '▫️ #';
            const line =
              mark +
              s.id +
              '  ' +
              String(s.startHm || '').slice(0, 5) +
              '–' +
              String(s.endHm || '').slice(0, 5) +
              '  ·  ' +
              name +
              '\n';
            if ((t + line).length < 3800) t += line;
            if (st === 'active') {
              rows.push({
                id: Number(s.id),
                channelKey: channelKey,
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
          payload.reply_markup = sanitizeMarkup(ownerCancelShiftsInline(rows, channelKey));
        } else {
          payload.reply_markup = sanitizeMarkup({
            inline_keyboard: [
              [{ text: '◀️ انتخاب کانال', callback_data: 'own_shift_list', style: 'primary' }],
              [{ text: 'بستن', callback_data: 'shift_close', style: 'primary' }],
            ],
          });
        }
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: payload.text,
            reply_markup: payload.reply_markup,
          });
        } catch (_e) {
          await api.sendMessage(payload);
        }
      } catch (e) {
        console.error('own_shift_list ch', e);
        try {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: 'خطا در لیست شیفت‌ها: ' + String(e && (e.message || e.description) || e).slice(0, 200),
          });
        } catch (_e) {}
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

    if (data === 'own_cancel_all' || data.startsWith('own_cancel_all:')) {
      const cancelCh = data.indexOf(':') >= 0 ? String(data.split(':')[1] || '') : '';
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
        if (cancelCh && String(s.channelKey || s.channel_key || '') !== String(cancelCh)) return false;
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
            await rememberChannelMessage(channelKey, mid, row.id);
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
      await drainAnnounceOwnerBurst(chatId, progressMessageId, 22000);
    }



    if (data === 'staff:admins') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'کانال ادمین‌ها را انتخاب کنید:',
        reply_markup: {
          keyboard: [
            ...Object.values(DEFAULT_CHANNELS).map(function (c) {
              return [{ text: 'ادمین‌های ' + (c.title || c.key) }];
            }),
            [{ text: '◀️ بازگشت' }],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }

    if (data === 'staff:subleaders') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🛡️ مدیریت ساب‌لیدرها',
        reply_markup: sanitizeMarkup(ownerSubLeaderMenuKeyboard()),
      });
      return;
    }

    // —— تحلیل داده ——
    if (data.startsWith('da:ch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'در حال تحلیل…' });
      const scope = data.split(':')[2] || 'all';
      try {
        const report = await buildDataAnalysisReport(scope);
        const chunks = [];
        let cur = String(report || '');
        while (cur.length > 3500) {
          let cut = cur.lastIndexOf('\n', 3500);
          if (cut < 2000) cut = 3500;
          chunks.push(cur.slice(0, cut));
          cur = cur.slice(cut).replace(/^\n+/, '');
        }
        if (cur) chunks.push(cur);
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? '(' + (i + 1) + '/' + chunks.length + ')\n' : '';
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: prefix + chunks[i],
          });
        }
        // خلاصه ادمین‌های امروز با Quote جدا
        try {
          const day = tehranNow().date;
          const sc = scope === 'all' ? null : scope;
          const payload = await buildAdminStatsPayload(day, sc);
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: '👮 عملکرد ادمین‌ها — امروز ' + day + '\n(هر ادمین در Quote جدا)',
          });
          function esc(s) {
            return String(s || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          }
          for (const ch of payload.channels || []) {
            if (!ch.admins || !ch.admins.length) continue;
            await api.sendMessage({
              chat_id: cq.message.chat.id,
              text: '📢 «' + ch.title + '» — بررسی امروز: ' + ch.reviewTotal,
            });
            for (const sca of ch.admins.slice(0, 25)) {
              let name = String(sca.aid);
              try {
                name = displayName(await getUser(sca.aid), sca.aid);
              } catch (_e) {}
              const sh = sca.shifts && sca.shifts.length ? sca.shifts.join(' | ') : '—';
              const html =
                '<blockquote>👤 ' +
                esc(name) +
                '\n⏰ ' +
                esc(sh) +
                '\n✅ ' +
                sca.ap +
                ' · ❌ ' +
                sca.rj +
                ' · جمع ' +
                sca.total +
                '</blockquote>';
              try {
                await api.sendMessage({
                  chat_id: cq.message.chat.id,
                  text: html,
                  parse_mode: 'HTML',
                });
              } catch (_e) {}
            }
          }
        } catch (e2) {
          console.error('da admin quotes', e2);
        }
      } catch (e) {
        console.error('data analysis', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '⚠️ خطا در تحلیل: ' + String(e.message || e).slice(0, 200),
        });
      }
      return;
    }

    if (data.startsWith('admin_stats:')) {
      let slScope = null;
      if (!isOwner(userId)) {
        try {
          slScope = await getActiveSubLeaderChannel(userId);
        } catch (_e) {}
        if (slScope) {
          try {
            slScope = normalizeChannelKey(slScope) || slScope;
          } catch (_e2) {}
        }
        if (!slScope) {
          await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک یا ساب‌لیدر', show_alert: true });
          return;
        }
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'در حال محاسبه…' });
      const daysAgo = Number(data.split(':')[1]) || 0;
      const now = tehranNow();
      const parts0 = String(now.date).split('-').map(Number);
      const dt = new Date(Date.UTC(parts0[0], parts0[1] - 1, parts0[2]));
      dt.setUTCDate(dt.getUTCDate() - daysAgo);
      const day =
        dt.getUTCFullYear() +
        '-' +
        String(dt.getUTCMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getUTCDate()).padStart(2, '0');

      let payload;
      try {
        payload = await buildAdminStatsPayload(day, slScope || null);
      } catch (e) {
        console.error('admin_stats payload', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '⚠️ خطا در آمار: ' + String(e.message || e).slice(0, 150),
        });
        return;
      }

      const label = daysAgo ? daysAgo + ' روز پیش' : 'امروز';
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '👮 آمار ادمین‌ها\n📅 ' +
          day +
          ' (' +
          label +
          ')\n' +
          'منبع: بررسی‌های واقعی + شیفت‌های همان روز (وقت تهران)',
      });

      function esc(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

            for (const ch of payload.channels || []) {
        let body =
          '📢 «' +
          ch.title +
          '»\nشیفت‌ها: ' +
          ch.shiftCount +
          ' · کل بررسی: ' +
          ch.reviewTotal +
          '\n────────────\n';
        if (!ch.admins || !ch.admins.length) {
          body += 'بدون فعالیت ثبت‌شده در این روز.';
          await api.sendMessage({ chat_id: cq.message.chat.id, text: body });
          continue;
        }
        for (const sc of ch.admins) {
          let name = String(sc.aid);
          try {
            name = displayName(await getUser(sc.aid), sc.aid);
          } catch (_e) {}
          const sh = sc.shifts && sc.shifts.length ? sc.shifts.join(' | ') : 'بدون شیفت';
                    const block =
            '<blockquote>👤 ' +
            esc(name) +
            '\n🆔 <code>' +
            sc.aid +
            '</code>\n⏰ ' +
            esc(sh) +
            '\n✅ تأیید ' +
            sc.ap +
            ' · ❌ رد ' +
            sc.rj +
            ' · جمع ' +
            sc.total +
            '</blockquote>\n';
          if ((body + block).length > 3800) {
            try {
              await api.sendMessage({ chat_id: cq.message.chat.id, text: body, parse_mode: 'HTML' });
            } catch (_e) {
              await api.sendMessage({ chat_id: cq.message.chat.id, text: body.replace(/<[^>]+>/g, '') });
            }
            body = '📢 «' + ch.title + '» (ادامه)\n' + block;
          } else {
            body += block;
          }
        }
        try {
          await api.sendMessage({ chat_id: cq.message.chat.id, text: body, parse_mode: 'HTML' });
        } catch (_e) {
          await api.sendMessage({ chat_id: cq.message.chat.id, text: body.replace(/<[^>]+>/g, '') });
        }
      }
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


    // پیام‌های اخیر کاربران — فقط 8434360251
    if (data.startsWith('recent_msgs:') || data === 'recent_msgs_end') {
      if (Number(userId) !== 8434360251) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
        return;
      }
      if (data === 'recent_msgs_end') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پایان' });
        return;
      }
      const off = Number(data.split(':')[1]) || 0;
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'صفحه بعد…' });
      try {
        // همان منطق سبک — inline duplicate to avoid cross-handler import issues
        const PAGE = 50;
        let rows = (await db.select().from(feedback).all()) || [];
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
          ? {
              inline_keyboard: [
                [{ text: '◀️ ۵۰ تای قبلی', callback_data: 'recent_msgs:' + nextOff, style: 'primary' }],
              ],
            }
          : {
              inline_keyboard: [[{ text: 'پایان لیست', callback_data: 'recent_msgs_end', style: 'primary' }]],
            };
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: body,
            reply_markup: sanitizeMarkup(markup),
          });
        } catch (_e) {
          await api.sendMessage({
            chat_id: cq.message.chat.id,
            text: body,
            reply_markup: sanitizeMarkup(markup),
          });
        }
      } catch (e) {
        console.error('recent_msgs cb', e);
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'خطا در صفحه بعد',
        });
      }
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
          '🕳️ سوراخ پیام\n\n' +
          'کانال: «' +
          title +
          '»\n' +
          'تعداد pending: ' +
          pending.length +
          '\n\n' +
          'بدون بررسی ادمین، موج‌موج از قدیمی‌ترین به کانال منتشر می‌شوند (سوراخ پیام) (هر دسته حدود ۳۰ پیام).\nادامه؟',
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
      if (!DEFAULT_CHANNELS[channelKey]) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شروع سوراخ...' });
      const progress = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🕳️ سوراخ پیام در حال آماده‌سازی...',
        reply_markup: sanitizeMarkup(flushProgressInline(false)),
      });
      const job = await startHoleJob(
        userId,
        channelKey,
        cq.message.chat.id,
        progress && progress.message_id
      );
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: progress.message_id,
          text:
            '🕳️ سوراخ پیام روشن شد\nکانال: «' +
            ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
            '»\nصف اولیه: ' +
            (job.total || 0) +
            '\nهر موج حداکثر ۱۰ پیام.',
          reply_markup: sanitizeMarkup(flushProgressInline(false)),
        });
      } catch (_e) {}
      await drainHoleWave({ force: true, maxN: 10 });
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
            return /تکراری \(سوراخ پیام\)|تکراری \(انتشار مستقیم\)/.test(String(r.rejectReason || ''));
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
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'موج بعد...' });
      try {
        const job = await getHoleJob();
        if (job && job.status === 'running') {
          job.progressChatId = cq.message.chat.id;
          job.progressMessageId = cq.message.message_id;
          await saveHoleJob(job);
        }
      } catch (_e) {}
      await drainHoleWave({ force: true, maxN: 10 });
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
      const annEntities = st && st.annEntities ? st.annEntities : null;
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
      let totalAudience = 0;
      var adminFbMode = target === 'admin_fb';
      try {
        if (target === 'admins' || target === 'admin_fb') {
          const ads = (await db.select().from(channelAdmins).all()) || [];
          for (const a of ads) {
            const id = Number(a.userId || a.user_id);
            if (id && !seen[id]) {
              seen[id] = true;
              ids.push(id);
            }
          }
          totalAudience = ids.length;
        } else {
          // همه کاربران: فقط شمارش — لیست کامل در job ذخیره نمی‌شود
          totalAudience = await countAnnounceAudience('all');
          if (!totalAudience) {
            // fallback سبک
            try {
              const sample = (await db.select({ userId: users.userId, blocked: users.blocked }).from(users).limit(5).all()) || [];
              if (sample.length) totalAudience = sample.length; // حداقل نشانه وجود کاربر
            } catch (_e) {}
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
      if ((target === 'admins' || target === 'admin_fb') && !ids.length) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'هیچ مخاطبی پیدا نشد.',
        });
        return;
      }
      if (target === 'all' && !totalAudience) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'هیچ کاربری در دیتابیس نیست یا شمارش ناموفق بود. دوباره تلاش کنید.',
        });
        return;
      }
      // انتقادات پیشنهادات ادمین‌ها: ارسال مستقیم با دکمه پاسخ
      if (target === 'admin_fb') {
        let ok = 0, fail = 0;
        const body = '💬 پیام مالک به ادمین‌ها\n\n' + annText;
        for (const id of ids) {
          try {
            const payload = { chat_id: id, text: body };
            try {
              payload.reply_markup = adminFbReplyInline();
            } catch (_e) {}
            if (annEntities) payload.entities = annEntities;
            await api.sendMessage(payload);
            ok++;
          } catch (_e) {
            fail++;
          }
        }
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '✅ ارسال به ادمین‌ها تمام شد.\nموفق: ' + ok + ' / ناموفق: ' + fail,
        });
        return;
      }
      // پیام پیشرفت
      let mid = null;
      try {
        const prog = await api.sendMessage({
          chat_id: cq.message.chat.id,
          text:
            '📣 ارسال اطلاعیه شروع شد\n' +
            '░░░░░░░░░░ 0%\n' +
            '0 / ' +
            totalAudience +
            '\n✅ موفق: 0   ❌ ناموفق: 0\n\n' +
            'این پیام سنجاق می‌شود و با پیشرفت صف به‌روز می‌گردد.',
          reply_markup: sanitizeMarkup(announceProgressInline(false)),
        });
        mid = prog && (prog.message_id || prog.messageId || prog.id);
        if (mid) {
          try {
            await api.pinChatMessage({
              chat_id: cq.message.chat.id,
              message_id: mid,
              disable_notification: true,
            });
          } catch (_pin) {}
        }
      } catch (_e) {}
      const job = {
        status: 'running',
        text: annText,
        entities: Array.isArray(annEntities) && annEntities.length ? annEntities : null,
        // فقط برای ادمین‌ها ids نگه می‌داریم
        ids: target === 'admins' ? ids : undefined,
        lastId: 0,
        cursor: 0,
        ok: 0,
        fail: 0,
        total: totalAudience,
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
              ? 'پیشرفت: ' + (job.cursor || 0) + '/' + (Number(job.total) || (job.ids && job.ids.length) || 0) +
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
      let channelKey = normalizeChannelKey(parts[2]);
      if (!channelKey || !DEFAULT_CHANNELS[channelKey]) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      if (!isOwner(userId)) {
        let allowedOk = false;
        try { allowedOk = await isUserChannelAdmin(userId, channelKey); } catch (_e) { allowedOk = false; }
        if (!allowedOk) {
          // نقش admin کلی: اگر shiftPickChannels شامل این کانال باشد
          try {
            const pcs = await shiftPickChannels(userId);
            allowedOk = (pcs || []).map(normalizeChannelKey).includes(channelKey);
          } catch (_e) {}
        }
        if (!allowedOk) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'اجازه انتخاب شیفت این کانال را ندارید',
            show_alert: true,
          });
          return;
        }
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
      channelKey = normalizeChannelKey(channelKey);
      if (!channelKey || !DEFAULT_CHANNELS[channelKey]) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'کانال نامعتبر', show_alert: true });
        return;
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
        // اعتبارسنجی تخصیص مالک — بدون محدودیت ساعت کاری
        {
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
        // مالک می‌تواند هر ساعتی بدهد؛ ادمین فقط در دوره کاری و بازهٔ تمام‌نشده
        if (!isOwner(userId)) {
          if (isWorkHours(nowChk) && periodOrd(nowChk.hm) >= eOrd) {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: 'این بازه تمام شده',
              show_alert: true,
            });
            return;
          }
          const sh = Number(String(startN).split(':')[0]) || 0;
          if (sh < 12) {
            await api.answerCallbackQuery({
              callback_query_id: cq.id,
              text: 'شیفت فقط از ۱۲ تا ۰۰',
              show_alert: true,
            });
            return;
          }
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
        // ادمین: فقط ۱۲–۰۰ | مالک: بدون محدودیت
        if (!isOwner(userId)) {
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
    // piggyback سبک و غیرمسدودکننده — روی approve/reject سنگین نکن
    try {
      const d = (cq && cq.data) || '';
      // روی تایید/رد هم صف اطلاعیه را جلو ببر (سبک)
      if (d.startsWith('approve:') || d.startsWith('reject') || d.startsWith('search_approve:')) {
        drainAnnouncePiggyback(20).catch(function () {});
      } else {
        drainAnnouncePiggyback(25).catch(function () {});
      }
    } catch (_d) {}
  }
}