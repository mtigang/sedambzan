import { api, db } from 'sdk';
import { eq, desc, and } from 'sdk/db';
import { messages, feedback, shifts, users, channelAdmins } from 'schema';
import {
  WELCOME_TEXT,
  RULES_TEXT,
  BOT_DISABLED_TEXT,
  FEEDBACK_HINT,
  DEFAULT_CHANNELS,
  OWNER_IDS,
  ADMIN_GROUP_IDS,
} from 'lib/config';
import {
  userKeyboard,
  adminKeyboard,
  ownerKeyboard,
  dbExportContinueInline,
  backKeyboard,
  settingsKeyboard,
  channelPickFlagsInline,
  searchKeyboard,
  channelAdminPickKeyboard,
  shiftChannelPickKeyboard,
  postChannelInline,
  sendDestInline,
  reviewInline,
  ownerReviewInline,
  feedbackInline,
  userOpenInline,
  shiftSlotsInline,
  shiftModePickInline,
  adminListInline,
  announceTargetInline,
  ownerShiftMenuInline,
  reviewNextInline,
  subLeaderKeyboard,
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
import { validateAndFix, normalizeBody, exactBodyKey } from 'lib/validation';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange, hmToMin, periodDateStr, isWorkHours, formatTsJalali, toJalaliDisplay, workHoursClosedText, toFaDigits, buildOwnerShiftSlots, normHm, sortShiftsByPeriod, periodOrd } from 'lib/time';
// normHm via time
import { resolveUserId, channelMessageLink, channelPublicBase } from 'lib/resolve';
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
  canManageOthersShifts,
  getActiveSubLeaderChannel,
  listAdminsByChannel,
  syncAdminsFromGroup,
  syncAllAdminGroups,
  notifyShiftAdmins,
  createReviewBatch,
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
      await api.sendMessage({ chat_id: chatId, text: '🚫 دسترسی محدود است.' });
      return;
    }

    const owner = isOwner(userId);
    const role = await getRole(userId);

    // تحویل خودکار Pending حذف شد: فقط با دکمه «📥 پیام‌های در انتظار» (Batch)

    let state = null;
    try {
      state = await getState(userId);
    } catch (_) {}

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

    // ========== USER ==========
    if (text === '📝 ارسال پیام') {
      if (!(await isBotOn()) && !owner) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      if (!owner && !isWorkHours()) {
        await api.sendMessage({
          chat_id: chatId,
          text: workHoursClosedText(),
          reply_markup: await roleKb(userId),
        });
        return;
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
        if (!owner && !isWorkHours()) {
          await api.sendMessage({
            chat_id: chatId,
            text: workHoursClosedText(),
            reply_markup: sanitizeMarkup(backKeyboard()),
          });
          return;
        }
        if (!(await isBotOn())) {
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

        // —— ضدتکرار بدنه دقیق (بین پیشوند و نقطه پایانی) — حداکثر ۲۰۰ پیام اخیر

        // —— کانال خاموش / حالت تب
        try {
          if (!(await isChannelOpen(v.channelKey))) {
            await api.sendMessage({
              chat_id: chatId,
              text: '🔴 دریافت پیام برای «' + ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) + '» فعلاً غیرفعال است.\nبعداً دوباره تلاش کنید.',
              reply_markup: sanitizeMarkup(backKeyboard()),
            });
            return;
          }
          if (await isChannelAdMode(v.channelKey)) {
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

        // —— شیفت فعال برای کانال؟
        if (!owner) {
          try {
            const activeAds = await activeShiftAdmins(v.channelKey);
            if (!activeAds || !activeAds.length) {
              const nxt = await nextShiftAfterNow(v.channelKey);
              let t =
                '⏰ الان شیفت فعالی برای «' +
                ((DEFAULT_CHANNELS[v.channelKey] && DEFAULT_CHANNELS[v.channelKey].title) || v.channelKey) +
                '» نیست؛ پیام ثبت نمی‌شود.\n';
              if (nxt && nxt.current) {
                t += 'در حال انتقال شیفت… چند لحظه بعد دوباره بفرستید.';
              } else if (nxt && nxt.start) {
                t += 'نزدیک‌ترین شیفت بعدی از ساعت ' + toFaDigits(nxt.start) + ' تا ' + toFaDigits(nxt.end) + ' است.';
              } else {
                t += 'هنوز شیفتی برای ادامه امروز ثبت نشده. لطفاً در ساعت کاری و با شیفت فعال ارسال کنید.';
              }
              await api.sendMessage({
                chat_id: chatId,
                text: t,
                reply_markup: sanitizeMarkup(backKeyboard()),
              });
              return;
            }
          } catch (e) {
            console.error('shift gate', e);
          }
        }
        const bodyKey = exactBodyKey(v.content);
        if (bodyKey) {
          let dup = null;
          let dupIsPending = false;
          let queuePos = 0;
          try {
            const sameCh =
              (await db
                .select()
                .from(messages)
                .where(eq(messages.channelKey, v.channelKey))
                .orderBy(desc(messages.id))
                .all()) || [];
            // فقط ۲۰۰ پیام اخیر کانال
            const recent = sameCh.slice(0, 200);
            const pendingAll = sameCh.filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id);
            for (const row of recent) {
              if (row.status !== 'pending' && row.status !== 'approved') continue;
              const other = exactBodyKey(row.content);
              if (other && other === bodyKey) {
                dup = row;
                dupIsPending = row.status === 'pending';
                if (dupIsPending) {
                  const idx = pendingAll.findIndex((x) => x.id === row.id);
                  queuePos = idx >= 0 ? idx : 0; // تعداد قبل از آن
                }
                break;
              }
            }
          } catch (e) {
            console.error('dup check', e);
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
          const recent = await db
            .select()
            .from(messages)
            .where(eq(messages.userId, userId))
            .orderBy(desc(messages.id))
            .all();
          if (recent && recent[0]) msgId = recent[0].id;
        } finally {
          try {
            await settingSet(sendLockKey, '0');
          } catch (_e) {}
        }

        // keep user_send state for continuous
        let ahead = 0;
        try {
          const pend = (await db.select().from(messages).all()) || [];
          ahead = pend.filter(function (x) {
            return (
              String(x.status) === 'pending' &&
              String((x.channelKey ?? x.channel_key) || '') === String(v.channelKey) &&
              Number(x.id) < Number(msgId)
            );
          }).length;
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
      // ادمین/ساب‌لیدر: ساخت/بازیابی Batch ده‌تایی
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
        const allMsg = (await db.select().from(messages).all()) || [];
        const mine = allMsg.filter(function (m) {
          return Number(m.reviewedBy ?? m.reviewed_by) === Number(userId);
        });
        function isToday(m) {
          const ra = m.reviewedAt ?? m.reviewed_at;
          if (!ra) return false;
          try {
            const d = ra instanceof Date ? ra : new Date(ra);
            if (isNaN(d.getTime())) return false;
            const fmt = new Intl.DateTimeFormat('en-GB', {
              timeZone: 'Asia/Tehran',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            });
            const parts = Object.fromEntries(fmt.formatToParts(d).map(function (p) { return [p.type, p.value]; }));
            const ds = parts.year + '-' + parts.month + '-' + parts.day;
            return ds === now.date;
          } catch (_e) {
            return false;
          }
        }
        const mineToday = mine.filter(isToday);
        const keys = await adminChannels(userId);
        const sl = await getActiveSubLeaderChannel(userId);
        const chans = [...new Set([...(keys || []), ...(sl ? [sl] : [])])];

        function rankIn(list, channelKey, todayOnly) {
          const pool = list.filter(function (m) {
            const ck = String((m.channelKey ?? m.channel_key) || '');
            if (channelKey && ck !== channelKey) return false;
            if (todayOnly && !isToday(m)) return false;
            const st = String(m.status || '');
            return st === 'approved' || st === 'rejected';
          });
          const counts = {};
          for (const m of pool) {
            const id = Number(m.reviewedBy ?? m.reviewed_by);
            if (!id) continue;
            counts[id] = (counts[id] || 0) + 1;
          }
          const ranked = Object.keys(counts)
            .map(function (id) { return { id: Number(id), n: counts[id] }; })
            .sort(function (a, b) { return b.n - a.n; });
          const myN = counts[Number(userId)] || 0;
          let rank = 0;
          for (let i = 0; i < ranked.length; i++) {
            if (ranked[i].id === Number(userId)) {
              rank = i + 1;
              break;
            }
          }
          return { rank: rank || (myN ? ranked.length : 0), totalAdmins: ranked.length, count: myN };
        }

        let body = '📊 عملکرد شما\n';
        body += '📅 امروز تهران: ' + now.date + ' — ' + now.hm + '\n';
        body += 'کانال‌ها: ' + (chans.map(function (k) { return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k; }).join('، ') || '—') + '\n\n';

        const apAll = mine.filter(function (m) { return m.status === 'approved'; }).length;
        const rjAll = mine.filter(function (m) { return m.status === 'rejected'; }).length;
        const apTd = mineToday.filter(function (m) { return m.status === 'approved'; }).length;
        const rjTd = mineToday.filter(function (m) { return m.status === 'rejected'; }).length;
        body += '—— کلی ——\n';
        body += '🟢 تأیید کل: ' + apAll + ' | امروز: ' + apTd + '\n';
        body += '🔴 رد کل: ' + rjAll + ' | امروز: ' + rjTd + '\n';
        body += 'Σ بررسی کل: ' + mine.length + ' | امروز: ' + mineToday.length + '\n';

        const rAllToday = rankIn(allMsg, null, true);
        const rAllTotal = rankIn(allMsg, null, false);
        body += '🏆 رتبه امروز (همه کانال‌ها): ' + (rAllToday.rank || '—') + ' از ' + (rAllToday.totalAdmins || 0) + ' (بررسی: ' + rAllToday.count + ')\n';
        body += '🏆 رتبه کل: ' + (rAllTotal.rank || '—') + ' از ' + (rAllTotal.totalAdmins || 0) + ' (بررسی: ' + rAllTotal.count + ')\n';

        for (const ck of chans.length ? chans : Object.keys(DEFAULT_CHANNELS)) {
          const title = (DEFAULT_CHANNELS[ck] && DEFAULT_CHANNELS[ck].title) || ck;
          const chMine = mine.filter(function (m) { return String((m.channelKey ?? m.channel_key) || '') === ck; });
          const chToday = chMine.filter(isToday);
          const rt = rankIn(allMsg, ck, true);
          const rT = rankIn(allMsg, ck, false);
          body += '\n—— «' + title + '» ——\n';
          body += '🟢' + chMine.filter(function (m) { return m.status === 'approved'; }).length;
          body += ' 🔴' + chMine.filter(function (m) { return m.status === 'rejected'; }).length;
          body += ' | امروز 🟢' + chToday.filter(function (m) { return m.status === 'approved'; }).length;
          body += ' 🔴' + chToday.filter(function (m) { return m.status === 'rejected'; }).length + '\n';
          body += 'رتبه امروز: ' + (rt.rank || '—') + '/' + (rt.totalAdmins || 0) + ' · رتبه کل: ' + (rT.rank || '—') + '/' + (rT.totalAdmins || 0) + '\n';
        }

        await api.sendMessage({ chat_id: chatId, text: body.slice(0, 4000), reply_markup: await roleKb(userId) });
      } catch (e) {
        console.error('perf', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در آمار عملکرد', reply_markup: await roleKb(userId) });
      }
      return;
    }

    // ========== ADMIN/OWNER: shifts ==========
    if ((role === 'admin' || role === 'subleader' || owner) && text === '⏰ شیفت من') {
      const keys = owner ? Object.keys(DEFAULT_CHANNELS) : await shiftPickChannels(userId);
      if (!keys.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'شما ادمین هیچ کانالی نیستید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      const chans = keys.map((k) => ({
        key: k,
        title: DEFAULT_CHANNELS[k]?.title || k,
      }));
      await setState(userId, 'pick_shift_ch');
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال شیفت را انتخاب کنید:',
        reply_markup: sanitizeMarkup(shiftChannelPickKeyboard(chans)),
      });
      return;
    }

    if (state?.kind === 'pick_shift_ch' && text.startsWith('شیفت: ')) {
      const title = text.replace('شیفت: ', '');
      const entry = Object.values(DEFAULT_CHANNELS).find((c) => c.title === title);
      if (!entry) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'کانال نامعتبر',
          reply_markup: sanitizeMarkup(backKeyboard()),
        });
        return;
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          '⏰ کانال «' +
          entry.title +
          '»\nنوع شیفت را انتخاب کنید:\n\n' +
          '📅 روزانه → فقط همین دوره (فردا اعمال نمی‌شود)\n' +
          '♾️ دائمی → هر روز همان ساعت',
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
    if (owner && text === '📌 تخصیص شیفت دائمی') {
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
        const now = tehranNow();
        const pdate = periodDateStr(now);
        let all = [];
        try {
          all = (await db.select().from(shifts).all()) || [];
        } catch (e) {
          console.error('shifts all', e);
        }
        const today = all.filter(function (s) {
          if (s.status !== 'active') return false;
          if (String(s.startHm) === String(s.endHm)) return false;
          return (
            (s.shiftDate === pdate ||
              s.shiftDate === 'perm' ||
              s.shiftDate === 'permanent' ||
              s.shiftDate === now.date)
          );
        });
        let t = '⏰ شیفت‌های دوره فعلی\n📅 ' + pdate + ' (۱۲:۰۰–۰۳:۰۰)\n';
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
              const tag =
                s.shiftDate === 'perm' || s.shiftDate === 'permanent' ? ' · دائم' : '';
              t +=
                '▫️ ' +
                String(s.startHm).slice(0, 5) +
                '–' +
                String(s.endHm).slice(0, 5) +
                '  ·  ' +
                name +
                tag +
                '\n';
            }
          }
        }
        t += '\nاز دکمه‌های زیر:\n• تخصیص روزانه/دائمی\n• لیست و لغو تک‌تک\n• لغو همه شیفت‌های دوره';
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
      const mode = state.mode;
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
        if (s.shiftDate === pdate || s.shiftDate === 'perm' || s.shiftDate === 'permanent' || s.shiftDate === now.date) {
          takenMap[s.startHm] = s.adminId;
        }
      }
      const ownerSlots = buildOwnerShiftSlots(now);
      await api.sendMessage({
        chat_id: chatId,
        text:
          'ساعت را انتخاب کنید (' +
          (mode === 'perm' ? 'دائمی — هر ساعت' : 'روزانه — ۲۴ ساعت آینده') +
          '):',
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

    if (owner && state?.kind === 'post_text' && (text || message.photo || message.video || message.voice || message.audio || message.document || message.video_note || message.sticker)) {
      const media = extractMedia(message);
      await setState(userId, 'post_confirm', {
        channelKey: state.channelKey,
        postText: text || message.caption || '',
        media: media,
        fromChatId: chatId,
        fromMsgId: message.message_id,
      });
      const preview =
        media && media.type
          ? '[' + media.type + '] ' + (text || message.caption || '')
          : text || '';
      await api.sendMessage({
        chat_id: chatId,
        text:
          'ارسال به «' +
          (DEFAULT_CHANNELS[state.channelKey]?.title || state.channelKey) +
          '»:\n\n' +
          (preview || '(مدیا)') +
          '\n\nتأیید می‌کنید؟',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تأیید ارسال', callback_data: 'post_yes' },
              { text: '❌ انصراف', callback_data: 'post_no' },
            ],
          ],
        },
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

    if (role === 'subleader' && text === '📋 شیفت‌های ۷ روز') {
      const myCh = await getActiveSubLeaderChannel(userId);
      if (!myCh) {
        await api.sendMessage({ chat_id: chatId, text: 'اسکوپ نامشخص', reply_markup: await roleKb(userId) });
        return;
      }
      const now = tehranNow();
      let body = '📋 شیفت‌های ۷ روز — «' + (DEFAULT_CHANNELS[myCh]?.title || myCh) + '»\n\n';
      const allSh = (await db.select().from(shifts).where(eq(shifts.channelKey, myCh)).all()) || [];
      for (let i = 0; i < 7; i++) {
        const parts = now.date.split('-').map(Number);
        const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
        dt.setUTCDate(dt.getUTCDate() - i);
        const day =
          dt.getUTCFullYear() +
          '-' +
          String(dt.getUTCMonth() + 1).padStart(2, '0') +
          '-' +
          String(dt.getUTCDate()).padStart(2, '0');
        const dayRows = allSh.filter(
          (s) =>
            s.status === 'active' &&
            (s.shiftDate === day || s.shiftDate === 'perm' || s.shiftDate === 'permanent') &&
            String(s.startHm) !== String(s.endHm)
        );
        body += '📅 ' + day + (i === 0 ? ' (امروز)' : '') + '\n';
        if (!dayRows.length) body += '  —\n';
        else {
          for (const s of dayRows.sort((a, b) => String(a.startHm).localeCompare(String(b.startHm)))) {
            let who = String(s.adminId);
            try { who = displayName(await getUser(s.adminId), s.adminId); } catch (_e) {}
            body += '  ' + s.startHm + '–' + s.endHm + ' | ' + who + '\n';
          }
        }
        body += '\n';
      }
      await api.sendMessage({ chat_id: chatId, text: body.slice(0, 4000), reply_markup: await roleKb(userId) });
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
        '\nبررسی‌کننده: ' +
        reviewer +
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

      if (text === '⏰ مدیریت شیفت‌ها') {
        await setState(userId, 'pick_shift_ch');
        // فقط کانال خودش
        await api.sendMessage({
          chat_id: chatId,
          text: 'شیفت کانال «' + chTitle + '»',
          reply_markup: {
            keyboard: [[{ text: 'شیفت: ' + chTitle }], [{ text: '◀️ بازگشت' }]],
            resize_keyboard: true,
          },
        });
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


    if (owner && text === '📊 آمار') {
      try {
        let all = [];
        try { all = (await db.select().from(messages).all()) || []; } catch (e) { console.error(e); }
        const pe = all.filter((x) => x.status === 'pending').length;
        const ap = all.filter((x) => x.status === 'approved').length;
        const rj = all.filter((x) => x.status === 'rejected').length;
        let us = [];
        try { us = (await db.select().from(users).all()) || []; } catch (e) {}
        let ads = [];
        try {
          ads = (await db.select().from(channelAdmins).all()) || [];
        } catch (_e) {}
        const adminIds = new Set(ads.map((a) => a.userId || a.user_id));
        let shToday = 0;
        try {
          const { date } = tehranNow();
          const sh = (await db.select().from(shifts).all()) || [];
          shToday = sh.filter((s) => s.shiftDate === date && s.status === 'active').length;
        } catch (_) {}
        let by = '';
        for (const c of Object.values(DEFAULT_CHANNELS)) {
          const cm = all.filter((x) => x.channelKey === c.key);
          by +=
            '• ' + c.title + ': ' + cm.length +
            ' (🟡' + cm.filter((x) => x.status === 'pending').length +
            ' 🟢' + cm.filter((x) => x.status === 'approved').length +
            ' 🔴' + cm.filter((x) => x.status === 'rejected').length + ')\n';
        }
        await api.sendMessage({
          chat_id: chatId,
          text:
            '📊 داشبورد آماری\n\n' +
            '📨 کل پیام‌ها: ' + all.length + '\n' +
            '🟡 در انتظار: ' + pe + '\n' +
            '🟢 تأیید شده: ' + ap + '\n' +
            '🔴 رد شده: ' + rj + '\n\n' +
            '👥 کاربران: ' + us.length + '\n' +
            '👮 ادمین‌ها (یکتا): ' + adminIds.size + '\n' +
            '⏰ شیفت فعال امروز: ' + shToday + '\n\n' +
            '📺 تفکیک کانال:\n' + by,
          reply_markup: {
          inline_keyboard: [
            [{ text: '👮 آمار ادمین‌ها (امروز)', callback_data: 'admin_stats:0', style: 'primary' }],
            [{ text: '📅 دیروز', callback_data: 'admin_stats:1', style: 'primary' }],
            [{ text: '📅 ۲ روز پیش', callback_data: 'admin_stats:2', style: 'primary' }],
          ],
        },
        });
      } catch (e) {
        console.error('stats', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در آمار: ' + (e.message || e), reply_markup: ownerKeyboard() });
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
          (reviewerLabel ? '\nبررسی‌کننده: ' + reviewerLabel : '') +
          (row.rejectReason ? '\nدلیل رد: ' + row.rejectReason : '') +
          '\n🕐 ارسال: ' +
          formatTsJalali(row.submittedAt) +
          (row.reviewedAt ? '\n🕐 بررسی: ' + formatTsJalali(row.reviewedAt) : '') +
          '\n\n' +
          row.content +
          '\n\n🔎 آیدی یا لینک بعدی را بفرستید (یا ◀️ بازگشت):',
        reply_markup: row.status === 'pending' ? ownerReviewInline(row.id) : backKeyboard(),
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
      await setState(userId, 'announce_pick_target', { annText: text });
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

if (owner && (text === '⚙️ ابزار ربات' || text === '⚙️ تنظیمات')) {
      const on = await isBotOn();
      await api.sendMessage({
        chat_id: chatId,
        text: '⚙️ ابزار ربات',
        reply_markup: settingsKeyboard(on),
      });
      return;
    }


    if (owner && text === '🔴 خاموش کردن ربات') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🔴 کدام کانال(ها) خاموش شوند؟',
        reply_markup: sanitizeMarkup(channelPickFlagsInline('choff')),
      });
      return;
    }

    if (owner && text === '🟢 روشن کردن ربات') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🟢 کدام کانال(ها) روشن شوند؟',
        reply_markup: sanitizeMarkup(channelPickFlagsInline('chon')),
      });
      return;
    }

    if (owner && text === '📢 حالت تب') {
      await api.sendMessage({
        chat_id: chatId,
        text: '📢 حالت تب (تبلیغات/تبادل) برای کدام کانال؟\nدر این حالت کاربر پیام جدید برای آن کانال ثبت نمی‌کند.',
        reply_markup: sanitizeMarkup(channelPickFlagsInline('chad')),
      });
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
        reply_markup: settingsKeyboard(await isBotOn()),
      });
      return;
    }

    // همگام‌سازی از گروه حذف شد


    // بازیابی بکاپ حذف شد

    
    
    if (owner && text === '🗑 پاک‌سازی pending کاربر') {
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
          reply_markup: settingsKeyboard(await isBotOn()),
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
        text:
          '📤 انتشار مستقیم صف\n\n' +
          'قدیمی‌ترین پیام‌های در انتظار بدون بررسی ادمین، مستقیم در کانال منتشر می‌شوند.\n' +
          'کانال را انتخاب کنید:',
        reply_markup: sanitizeMarkup(flushChannelPickInline()),
      });
      return;
    }

    if (owner && text === '🧹 پاک‌سازی صف') {
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
  }
}
