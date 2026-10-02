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
  backKeyboard,
  settingsKeyboard,
  searchKeyboard,
  channelAdminPickKeyboard,
  shiftChannelPickKeyboard,
  postChannelInline,
  reviewInline,
  ownerReviewInline,
  feedbackInline,
  userOpenInline,
  shiftSlotsInline,
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
  flushProgressInline,
  flushConfirmInline,
} from 'lib/keyboards';
import { validateAndFix, normalizeBody, exactBodyKey } from 'lib/validation';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange, hmToMin, periodDateStr, isWorkHours, formatTsJalali, toJalaliDisplay, workHoursClosedText, toFaDigits, buildOwnerShiftSlots, normHm } from 'lib/time';
// normHm via time
import { resolveUserId } from 'lib/resolve';
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
  settingSet,
  isOwner,
  upsertUser,
  getUser,
  getRole,
  adminChannels,
  addChannelAdmin,
  listAdminsByChannel,
  syncAdminsFromGroup,
  syncAllAdminGroups,
  notifyShiftAdmins,
  createReviewBatch,
  sendReviewBatch,
  decideMessage,
  finishReviewBatchIfComplete,
  testChannels,
  displayName,
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
  if (r === 'owner') return ownerKeyboard();
  if (r === 'subleader') return subLeaderKeyboard();
  if (r === 'admin') return adminKeyboard();
  return userKeyboard();
}

export default async function (message) {
  let idemKeyFinal = null;
  try {
    if (!message?.chat) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = (message.text || '').trim();

    // —— پیام داخل گروه ادمین → ثبت عضو به عنوان ادمین کانال ——
    if (message.chat.type === 'group' || message.chat.type === 'supergroup') {
      for (const [key, gid] of Object.entries(ADMIN_GROUP_IDS)) {
        if (Number(chatId) === Number(gid) && userId && !isOwner(userId)) {
          try {
            await upsertUser(message.from);
            await addChannelAdmin(userId, key);
          } catch (e) {
            console.error('group admin register', e);
          }
        }
      }
      return;
    }

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
        reply_markup: backKeyboard(),
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
        reply_markup: backKeyboard(),
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
          reply_markup: backKeyboard(),
        });
        return;
      }
      await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '✅ برای مالک ارسال شد.',
        reply_markup: await roleKb(userId),
      });
      for (const oid of OWNER_IDS) {
        try {
          await api.sendMessage({
            chat_id: oid,
            text: '📬 فیدبک از ' + userId + ':\n\n' + text,
          });
        } catch (_) {}
      }
      return;
    }

    if (state?.kind === 'user_send' && text) {
      try {
        if (!owner && !isWorkHours()) {
          await api.sendMessage({
            chat_id: chatId,
            text: workHoursClosedText(),
            reply_markup: backKeyboard(),
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
            reply_markup: backKeyboard(),
          });
          return;
        }
        const ch = await getChannel(v.channelKey);
        if (!ch || Number(ch.enabled) === 0) {
          await api.sendMessage({
            chat_id: chatId,
            text: '🔴 این کانال غیرفعال است.',
            reply_markup: backKeyboard(),
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
              reply_markup: backKeyboard(),
            });
            return;
          }
        } catch (_) {}

        // —— محدودیت نرخ
        if (!owner) {
          const rl = await checkRateLimit(userId);
          if (!rl.ok) {
            await api.sendMessage({
              chat_id: chatId,
              text:
                '⏳ محدودیت ارسال: حداکثر ۶ پیام در ۱۰ دقیقه.\nلطفاً کمی صبر کنید و دوباره بفرستید.',
              reply_markup: backKeyboard(),
            });
            return;
          }
        }

        // —— ضدتکرار بدنه دقیق (بین پیشوند و نقطه پایانی)
        const bodyKey = exactBodyKey(v.content);
        if (bodyKey) {
          let dup = null;
          try {
            const sameCh =
              (await db
                .select()
                .from(messages)
                .where(eq(messages.channelKey, v.channelKey))
                .all()) || [];
            for (const row of sameCh) {
              if (row.status !== 'pending' && row.status !== 'approved') continue;
              const other = exactBodyKey(row.content);
              if (other && other === bodyKey) {
                dup = row;
                break;
              }
            }
          } catch (e) {
            console.error('dup check', e);
          }
          if (dup) {
            await api.sendMessage({
              chat_id: chatId,
              text:
                '⚠️ این پیام تکراری است و ثبت نشد.\n\n' +
                'متن بعد از پیشوند کانال قبلاً در صف یا منتشر شده (#' +
                dup.id +
                ').\nپیام دیگری بفرستید یا ◀️ بازگشت.',
              reply_markup: backKeyboard(),
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
              reply_markup: backKeyboard(),
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
        let note =
          '✅ ثبت شد.\n🆔 #' + (msgId != null ? msgId : '?') + '\n🟡 در انتظار بررسی ادمین';
        note += '\n\nپیام بعدی را بفرستید یا ◀️ بازگشت';
        if (v.autoFixed) note += '\n\nℹ️ متن کمی اصلاح شد و ارسال گردید.';
        await api.sendMessage({
          chat_id: chatId,
          text: note,
          reply_markup: backKeyboard(),
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

    if ((role === 'admin' || owner) && state?.kind === 'reject_custom' && text) {
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
            reply_markup: reviewNextInline(fin.batch.batchNumber),
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
      // تنها مسیر دریافت Pending: ساخت/بازیابی Batch ده‌تایی (شیفت داخل createReviewBatch چک می‌شود)
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
    if ((role === 'admin' || owner) && text === '📊 عملکرد من') {
      const all =
        (await db.select().from(messages).where(eq(messages.reviewedBy, userId)).all()) || [];
      const { date } = tehranNow();
      // approx today by reviewedAt string not reliable — count all
      const ap = all.filter((m) => m.status === 'approved').length;
      const rj = all.filter((m) => m.status === 'rejected').length;
      const keys = await adminChannels(userId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          '📊 عملکرد شما\n\n' +
          'کانال‌ها: ' +
          (keys.map((k) => DEFAULT_CHANNELS[k]?.title || k).join('، ') || '—') +
          '\nتأیید کل: ' +
          ap +
          '\nرد کل: ' +
          rj +
          '\nمجموع بررسی: ' +
          all.length +
          '\n📅 امروز (تهران): ' +
          date,
        reply_markup: await roleKb(userId),
      });
      return;
    }

    // ========== ADMIN/OWNER: shifts ==========
    if ((role === 'admin' || owner) && text === '⏰ شیفت من') {
      const keys = owner ? Object.keys(DEFAULT_CHANNELS) : await adminChannels(userId);
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
        reply_markup: shiftChannelPickKeyboard(chans),
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
          reply_markup: backKeyboard(),
        });
        return;
      }
      const now = tehranNow();
      const date = periodDateStr(now);
      const dayShifts =
        (await db
          .select()
          .from(shifts)
          .where(eq(shifts.channelKey, entry.key))
          .all()) || [];
      const todayRaw = dayShifts.filter(
        (s) =>
          (s.shiftDate === date ||
            s.shiftDate === 'permanent' ||
            s.shiftDate === 'perm' ||
            s.shiftDate === now.date) &&
          s.status === 'active'
      );
      const today = todayRaw.filter(function (s) {
        try {
          const a = normHm(s.startHm);
          const b = normHm(s.endHm);
          return a && b && a !== b;
        } catch (_e) {
          return false;
        }
      });
      const takenMap = {};
      const myStarts = new Set();
      for (const s of today) {
        takenMap[normHm(s.startHm)] = s.adminId;
        if (Number(s.adminId) === Number(userId)) myStarts.add(normHm(s.startHm));
      }
      await clearState(userId);
      let head =
        '⏰ شیفت‌های «' +
        entry.title +
        '»\n📅 دوره ' +
        date +
        '\nساعت کاری: ۱۲:۰۰ تا ۰۳:۰۰\nحداکثر ۳ شیفت یک‌ساعته\n🟢 خالی  ·  🔴 پر\n\n';
      if (today.length) {
        const shiftLines = [];
        for (const s of today) {
          let who = Number(s.adminId) === Number(userId) ? 'شما' : String(s.adminId);
          if (Number(s.adminId) !== Number(userId)) {
            try {
              who = displayName(await getUser(s.adminId), s.adminId);
            } catch (_e) {}
          }
          shiftLines.push(
            '────────────\n🕐 ' + normHm(s.startHm) + ' تا ' + normHm(s.endHm) + '\n👤 ' + who
          );
        }
        head += 'شیفت‌های معتبر امروز:\n' + shiftLines.join('\n');
        const invalid = todayRaw.length - today.length;
        if (invalid > 0) {
          head += '\n\n⚠️ ' + invalid + ' شیفت نامعتبر (مثل ۰۰–۰۰) مخفی شد.';
        }
      } else {
        head += 'هنوز شیفت معتبری ثبت نشده.';
      }
      const board = await api.sendMessage({
        chat_id: chatId,
        text: head,
        reply_markup: shiftSlotsInline(entry.key, takenMap, myStarts, null, !!owner),
      });
      try {
        const mid = board && board.message_id;
        if (mid) {
          await settingSet(
            'shift_board:' + entry.key + ':' + date + ':' + userId,
            JSON.stringify({ chatId: userId, messageId: mid })
          );
        }
      } catch (e) {
        console.error('save board', e);
      }
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
        let t = '⏰ شیفت‌های دوره فعلی\n📅 ' + pdate + ' (۱۲:۰۰–۰۳:۰۰)\n\n';
        if (!today.length) {
          t += 'هنوز شیفتی ثبت نشده.\n';
        } else {
          for (const s of today) {
            let name = String(s.adminId);
            try {
              name = displayName(await getUser(s.adminId), s.adminId);
            } catch (_e) {}
            t +=
              '• ' +
              ((DEFAULT_CHANNELS[s.channelKey] && DEFAULT_CHANNELS[s.channelKey].title) ||
                s.channelKey) +
              ' | ' +
              String(s.startHm).slice(0, 5) +
              '–' +
              String(s.endHm).slice(0, 5) +
              ' | ' +
              name +
              (s.shiftDate === 'perm' || s.shiftDate === 'permanent' ? ' (دائم)' : '') +
              '\n';
          }
        }
        t += '\nاز دکمه‌های زیر:\n• تخصیص روزانه/دائمی\n• لیست و لغو تک‌تک\n• لغو همه شیفت‌های دوره';
        await api.sendMessage({
          chat_id: chatId,
          text: t,
          reply_markup: ownerShiftMenuInline(),
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
        reply_markup: backKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'own_assign_admin' && text) {
      const adminId = Number(String(text).replace(/\D/g, ''));
      if (!adminId) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی نامعتبر', reply_markup: backKeyboard() });
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
        reply_markup: shiftSlotsInline(channelKey, takenMap, new Set(), ownerSlots, true),
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
            [{ text: '🔄 همگام‌سازی ادمین‌ها' }],
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
          reply_markup: adminListInline(ads, entry.key),
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

    
    if (owner && text === '📣 ارسال به کانال') {
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال مقصد را انتخاب کنید:',
        reply_markup: postChannelInline(),
      });
      return;
    }

    if (owner && state?.kind === 'post_text' && text) {
      await setState(userId, 'post_confirm', {
        channelKey: state.channelKey,
        postText: text,
      });
      await api.sendMessage({
        chat_id: chatId,
        text:
          'ارسال به «' +
          (DEFAULT_CHANNELS[state.channelKey]?.title || state.channelKey) +
          '»:\n\n' +
          text +
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
    if (owner && text === '🛡️ ساب‌لیدرها') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🛡️ مدیریت ساب‌لیدرها',
        reply_markup: ownerSubLeaderMenuKeyboard(),
      });
      return;
    }
    if (owner && text === '➕ افزودن ساب‌لیدر') {
      await setState(userId, 'sl_add_id');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی یا @username کاربر را بفرستید:',
        reply_markup: backKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'sl_add_id' && text) {
      const tid = await resolveUserId(text);
      if (!tid) {
        await api.sendMessage({ chat_id: chatId, text: '❌ کاربر پیدا نشد.', reply_markup: backKeyboard() });
        return;
      }
      if (isOwner(tid)) {
        await api.sendMessage({ chat_id: chatId, text: '❌ مالک را نمی‌توان ساب‌لیدر کرد.', reply_markup: backKeyboard() });
        return;
      }
      const tu = await getUser(tid);
      if (tu && Number(tu.blocked) === 1) {
        await api.sendMessage({ chat_id: chatId, text: '❌ این کاربر بلاک است.', reply_markup: backKeyboard() });
        return;
      }
      await setState(userId, 'sl_add_ch', { targetId: tid });
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال تحت مدیریت را انتخاب کنید:',
        reply_markup: subLeaderPickChannelInline(),
      });
      return;
    }
    if (owner && text === '👥 لیست ساب‌لیدرها') {
      const all = await listAllSubLeaders();
      if (!all.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'ℹ️ ساب‌لیدری ثبت نشده.',
          reply_markup: ownerSubLeaderMenuKeyboard(),
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
        reply_markup: subLeaderListInline(items),
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
            reply_markup: subLeaderKeyboard(),
          });
          return;
        }
        await api.sendMessage({
          chat_id: chatId,
          text:
            '👥 ادمین‌های «' +
            chTitle +
            '»\nتعداد: ' +
            admins.length +
            '\nروی «حذف» بزنید تا از کانال شما برداشته شوند (سابقه پاک نمی‌شود).',
          reply_markup: subLeaderAdminsInline(admins, channelKey || myCh),
        });
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
          reply_markup: subLeaderKeyboard(),
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
          reply_markup: subLeaderKeyboard(),
        });
        return;
      }

      if (text === '📢 اطلاعیه برای ادمین‌ها') {
        await setState(userId, 'sl_ann_text');
        await api.sendMessage({
          chat_id: chatId,
          text: '📢 متن اطلاعیه را برای ادمین‌های «' + chTitle + '» بفرستید:',
          reply_markup: backKeyboard(),
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
            reply_markup: subLeaderKeyboard(),
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
        reply_markup: searchKeyboard(),
      });
      return;
    }

    if (owner && text === '🔎 جستجوی پیام') {
      try {
        await setState(userId, 'search_msg');
        await api.sendMessage({
          chat_id: chatId,
          text: 'عدد آیدی پیام را بفرستید:',
          reply_markup: backKeyboard(),
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
          reply_markup: backKeyboard(),
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
        const nameMap = { callmearail: 'sadambazan', inkarbariral: 'inkarbar' };
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
          reply_markup: backKeyboard(),
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
          reply_markup: backKeyboard(),
        });
        return;
      }
      const row = rows[0];
      const uu = await getUser(row.userId);
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴' };
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
          (row.reviewedBy ? '\nبررسی‌کننده: ' + row.reviewedBy : '') +
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
          reply_markup: backKeyboard(),
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
          reply_markup: searchKeyboard(),
        });
      } else {
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیامی ثبت نشده.',
          reply_markup: searchKeyboard(),
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
          reply_markup: backKeyboard(),
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

    if (owner && text === '⚙️ تنظیمات') {
      const on = await isBotOn();
      await api.sendMessage({
        chat_id: chatId,
        text: '⚙️ تنظیمات ربات',
        reply_markup: settingsKeyboard(on),
      });
      return;
    }

    if (owner && text === '🟢 روشن کردن ربات') {
      await settingSet('bot_enabled', '1');
      await api.sendMessage({
        chat_id: chatId,
        text: '🟢 ربات روشن شد',
        reply_markup: settingsKeyboard(true),
      });
      return;
    }

    if (owner && text === '🔴 خاموش کردن ربات') {
      await settingSet('bot_enabled', '0');
      await api.sendMessage({
        chat_id: chatId,
        text: '🔴 ربات خاموش شد',
        reply_markup: settingsKeyboard(false),
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

    if (owner && text === '🔄 همگام‌سازی ادمین‌ها') {
      const res = await syncAllAdminGroups(true);
      await api.sendMessage({
        chat_id: chatId,
        text: '🔄 همگام‌سازی انجام شد.\n' + JSON.stringify(res.results || {}, null, 0).slice(0, 500),
        reply_markup: ownerKeyboard(),
      });
      return;
    }


    // بازیابی بکاپ حذف شد

    
    
    if (owner && text === '🗑 پاک‌سازی pending کاربر') {
      await setState(userId, 'purge_user_wait_id');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی کاربری که pendingهایش پاک شود را بفرستید:',
        reply_markup: backKeyboard(),
      });
      return;
    }

    if (owner && state?.kind === 'purge_user_wait_id' && text) {
      const tid = Number(String(text).replace(/\D/g, ''));
      if (!tid) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'آیدی عددی نامعتبر است.',
          reply_markup: backKeyboard(),
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
        reply_markup: flushChannelPickInline(),
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
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: 'پیام #' + row.id + ' از صف حذف شد.',
          });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '🧹 ' + pend.length + ' پیام پاک شد',
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (owner && state?.kind === 'fb_reply' && text) {
      const rows = await db
        .select()
        .from(feedback)
        .where(eq(feedback.id, state.feedbackId))
        .all();
      const row = rows?.[0];
      if (row) {
        await db
          .update(feedback)
          .set({ status: 'replied', ownerReply: text })
          .where(eq(feedback.id, state.feedbackId))
          .run();
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: '💬 پاسخ مدیریت:\n\n' + text + '\n\nبا تشکر — مجموعه آرال',
          });
        } catch (_) {}
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
