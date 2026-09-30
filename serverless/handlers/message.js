import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages, feedback, shifts, users } from 'schema';
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
  feedbackInline,
  userOpenInline,
  shiftSlotsInline,
  adminListInline,
} from 'lib/keyboards';
import { validateAndFix } from 'lib/validation';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange, hmToMin } from 'lib/time';
import { resolveUserId } from 'lib/resolve';
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
  deliverPendingForAdmin,
  pendingForViewer,
  testChannels,
  displayName,
  settingGet,
} from 'lib/dbutil';

async function roleKb(uid) {
  const r = await getRole(uid);
  if (r === 'owner') return ownerKeyboard();
  if (r === 'admin') return adminKeyboard();
  return userKeyboard();
}

export default async function (message) {
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

    await ensureChannelsSeeded();
    try {
      await upsertUser(message.from);
    } catch (e) {
      console.error('upsert', e);
    }

    // همگام‌سازی سبک هر تعامل (حداکثر هر ۳۰ دقیقه)
    try {
      await syncAllAdminGroups(false);
    } catch (_) {}

    const u = await getUser(userId);
    if (u?.blocked && !isOwner(userId)) {
      await api.sendMessage({ chat_id: chatId, text: '🚫 دسترسی محدود است.' });
      return;
    }

    const owner = isOwner(userId);
    const role = await getRole(userId);

    // تحویل صف به ادمین در شیفت
    if (role === 'admin' || owner) {
      try {
        const n = await deliverPendingForAdmin(userId);
        if (n > 0) {
          await api.sendMessage({
            chat_id: chatId,
            text: '📥 ' + n + ' پیام در انتظار برای شیفت فعلی‌تان ارسال شد.',
          });
        }
      } catch (e) {
        console.error('deliver on interact', e);
      }
    }

    let state = null;
    try {
      state = await getState(userId);
    } catch (_) {}

    if (text === '/start' || text.startsWith('/start ')) {
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
    if (text === '📝 ارسال پیام' || text === '📝 ارسال پیام به صورت کاربر عادی') {
      if (!(await isBotOn())) {
        await api.sendMessage({
          chat_id: chatId,
          text: BOT_DISABLED_TEXT,
          reply_markup: await roleKb(userId),
        });
        return;
      }
      await setState(userId, 'user_send');
      await api.sendMessage({ chat_id: chatId, text: RULES_TEXT, reply_markup: backKeyboard() });
      return;
    }

    if (text === '📊 وضعیت پیام من') {
      const rows =
        (await db
          .select()
          .from(messages)
          .where(eq(messages.userId, userId))
          .orderBy(desc(messages.id))
          .all()) || [];
      const list = rows.slice(0, 15);
      if (!list.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'هنوز پیامی ندارید.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      const map = { pending: '🟡 در انتظار', approved: '🟢 تأیید', rejected: '🔴 رد' };
      const body = list
        .map(
          (m) =>
            '#' +
            m.id +
            ' | ' +
            (map[m.status] || m.status) +
            ' | ' +
            m.channelKey +
            '\n' +
            (m.content || '').slice(0, 80)
        )
        .join('\n────────────\n');
      await api.sendMessage({
        chat_id: chatId,
        text: '📊 پیام‌های شما\n\n' + body,
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

        let msgId = null;
        await db
          .insert(messages)
          .values({
            userId,
            content: v.content,
            channelKey: v.channelKey,
            status: 'pending',
          })
          .run();
        const recent = await db
          .select()
          .from(messages)
          .where(eq(messages.userId, userId))
          .orderBy(desc(messages.id))
          .all();
        if (recent?.[0]) msgId = recent[0].id;

        await clearState(userId);
        let note =
          '✅ ثبت شد.\n🆔 #' + (msgId != null ? msgId : '?') + '\n🟡 در انتظار بررسی ادمین';
        if (v.autoFixed) note += '\n\nℹ️ متن کمی اصلاح شد و ارسال گردید.';
        await api.sendMessage({
          chat_id: chatId,
          text: note,
          reply_markup: await roleKb(userId),
        });

        // فقط ادمین‌های شیفت فعال — نه مالک مستقیم
        if (msgId != null) {
          await notifyShiftAdmins(
            v.channelKey,
            '📨 #' +
              msgId +
              ' | ' +
              (ch.title || v.channelKey) +
              '\nاز: ' +
              userId +
              '\n\n' +
              v.content,
            reviewInline(msgId),
            msgId
          );
        }
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
    if ((role === 'admin' || owner) && text === '📥 پیام‌های در انتظار') {
      if (role === 'admin' && !owner) {
        const { date, hm } = tehranNow();
        const mySh =
          (await db
            .select()
            .from(shifts)
            .where(eq(shifts.adminId, userId))
            .all()) || [];
        const activeNow = mySh.filter(
          (s) => s.shiftDate === date && s.status === 'active' && inRange(hm, s.startHm, s.endHm)
        );
        if (!activeNow.length) {
          await api.sendMessage({
            chat_id: chatId,
            text: '⏰ فقط در زمان شیفت خودتان می‌توانید صف را ببینید و پیام‌ها را بررسی کنید.',
            reply_markup: await roleKb(userId),
          });
          return;
        }
      }
      const list = (await pendingForViewer(userId)).slice(0, 40);
      if (!list.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'صف خالی است.',
          reply_markup: await roleKb(userId),
        });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: '📥 ' + list.length + ' پیام در صف' });
      for (const row of list) {
        const ch = await getChannel(row.channelKey);
        await api.sendMessage({
          chat_id: chatId,
          text:
            '#' +
            row.id +
            ' | ' +
            (ch?.title || row.channelKey) +
            ' | user:' +
            row.userId +
            '\n\n' +
            row.content,
          reply_markup: reviewInline(row.id),
        });
      }
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
      const { date } = tehranNow();
      const dayShifts =
        (await db
          .select()
          .from(shifts)
          .where(eq(shifts.channelKey, entry.key))
          .all()) || [];
      const today = dayShifts.filter(
        (s) => s.shiftDate === date && s.status === 'active'
      );
      const takenMap = {};
      const myStarts = new Set();
      for (const s of today) {
        takenMap[s.startHm] = s.adminId;
        if (s.adminId === userId) myStarts.add(s.startHm);
      }
      await clearState(userId);
      let head =
        '⏰ شیفت‌های «' +
        entry.title +
        '»\n📅 ' +
        date +
        '\n۱۰ صبح تا ۲ بامداد · حداکثر ۲ شیفت\n🟢 خالی · 🔴 پر\n\n';
      if (today.length) {
        head +=
          'شیفت‌های ثبت‌شده امروز:\n' +
          today
            .map((s) => {
              const who = s.adminId === userId ? 'شما' : String(s.adminId);
              return '• ' + s.startHm + '–' + s.endHm + ' ← ' + who;
            })
            .join('\n');
      } else {
        head += 'هنوز شیفتی ثبت نشده.';
      }
      const board = await api.sendMessage({
        chat_id: chatId,
        text: head,
        reply_markup: shiftSlotsInline(entry.key, takenMap, myStarts),
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

    if (owner && text === '⏰ شیفت‌ها') {
      try {
        const { date } = tehranNow();
        let all = [];
        try { all = (await db.select().from(shifts).all()) || []; } catch (e) { console.error('shifts all', e); }
        const today = all.filter((s) => s.shiftDate === date && s.status === 'active');
        let t = '⏰ شیفت‌های امروز (' + date + ')\n\n';
        if (!today.length) t += 'خالی';
        for (const s of today) {
          let name = String(s.adminId);
          try { name = displayName(await getUser(s.adminId), s.adminId); } catch (_) {}
          t += '• ' + (DEFAULT_CHANNELS[s.channelKey]?.title || s.channelKey) + ' | ' + s.startHm + '–' + s.endHm + ' | ' + name + '\n';
        }
        await api.sendMessage({ chat_id: chatId, text: t, reply_markup: ownerKeyboard() });
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

    if (owner && text === '👥 ادمین‌ها') {
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال را انتخاب کنید:',
        reply_markup: channelAdminPickKeyboard(),
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
      const id = await resolveUserId(text);
      if (!id) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'کاربر پیدا نشد. آیدی عددی یا @username بفرستید.',
          reply_markup: backKeyboard(),
        });
        return;
      }
      await addChannelAdmin(id, state.channelKey);
      await clearState(userId);
      try {
        await api.sendMessage({
          chat_id: id,
          text:
            '✅ ادمین کانال «' +
            (DEFAULT_CHANNELS[state.channelKey]?.title || '') +
            '» شدید. /start',
        });
      } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: 'اضافه شد: ' + id,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    // ========== OWNER: post to channel ==========
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
    if (owner && text === '📊 آمار') {
      try {
        let all = [];
        try { all = (await db.select().from(messages).all()) || []; } catch (e) { console.error('stats messages', e); }
        const pe = all.filter((x) => x.status === 'pending').length;
        const ap = all.filter((x) => x.status === 'approved').length;
        const rj = all.filter((x) => x.status === 'rejected').length;
        let us = [];
        try { us = (await db.select().from(users).all()) || []; } catch (e) { console.error('stats users', e); }
        let by = '';
        for (const c of Object.values(DEFAULT_CHANNELS)) {
          by += '• ' + c.title + ': ' + all.filter((x) => x.channelKey === c.key).length + '\n';
        }
        await api.sendMessage({
          chat_id: chatId,
          text:
            '📊 آمار\n\nکل: ' +
            all.length +
            '\n🟡' +
            pe +
            ' 🟢' +
            ap +
            ' 🔴' +
            rj +
            '\n👥 ' +
            us.length +
            '\n\n' +
            by,
          reply_markup: ownerKeyboard(),
        });
      } catch (e) {
        console.error('stats', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا در آمار: ' + (e && e.message ? e.message : String(e)),
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
          await api.sendMessage({
            chat_id: chatId,
            text: 'فیدبک #' + row.id + '\nاز: ' + row.userId + '\n\n' + row.content,
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
      const id = Number(String(text).replace(/\D/g, ''));
      await clearState(userId);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      if (!rows?.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'پیدا نشد',
          reply_markup: ownerKeyboard(),
        });
        return;
      }
      const row = rows[0];
      await api.sendMessage({
        chat_id: chatId,
        text:
          '#' +
          row.id +
          ' | ' +
          row.status +
          ' | ' +
          row.channelKey +
          '\nuser: ' +
          row.userId +
          '\n\n' +
          row.content,
        reply_markup:
          row.status === 'pending' ? reviewInline(row.id) : ownerKeyboard(),
      });
      return;
    }

    if (owner && state?.kind === 'search_user' && text) {
      const id = await resolveUserId(text);
      await clearState(userId);
      if (!id) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'کاربر پیدا نشد. آیدی یا @username بفرستید.',
          reply_markup: ownerKeyboard(),
        });
        return;
      }
      const uu = await getUser(id);
      const ms =
        (await db.select().from(messages).where(eq(messages.userId, id)).all()) || [];
      const pending = ms.filter((m) => m.status === 'pending');
      let body =
        '👤 ' +
        displayName(uu, id) +
        '\nآیدی: `' +
        id +
        '`\nنقش: ' +
        (uu?.role || '?') +
        '\nپیام‌ها: ' +
        ms.length +
        '\n\n';
      body += '— همه پیام‌ها —\n';
      for (const m of ms.slice(0, 20)) {
        body +=
          '#' +
          m.id +
          ' | ' +
          m.status +
          '\n' +
          (m.content || '').slice(0, 100) +
          '\n\n';
      }
      if (pending.length) {
        body += '— در انتظار —\n';
        for (const m of pending) {
          body += '#' + m.id + '\n' + m.content + '\n\n';
        }
      }
      await api.sendMessage({
        chat_id: chatId,
        text: body.slice(0, 3500),
        reply_markup: userOpenInline(id),
        parse_mode: 'Markdown',
      });
      return;
    }

    if (owner && text === '📣 اطلاعیه') {
      try {
        await setState(userId, 'announce');
        await api.sendMessage({
          chat_id: chatId,
          text: 'متن اطلاعیه را بفرستید (برای همه کاربران):',
          reply_markup: backKeyboard(),
        });
      } catch (e) {
        console.error('announce', e);
        await api.sendMessage({
          chat_id: chatId,
          text: 'خطا: ' + (e && e.message ? e.message : String(e)),
          reply_markup: ownerKeyboard(),
        });
      }
      return;
    }

    if (owner && state?.kind === 'announce' && text) {
      await clearState(userId);
      const us = (await db.select().from(users).all()) || [];
      let ok = 0;
      for (const x of us) {
        if (x.blocked) continue;
        try {
          await api.sendMessage({ chat_id: x.userId, text });
          ok++;
        } catch (_) {}
      }
      await api.sendMessage({
        chat_id: chatId,
        text: 'ارسال شد: ' + ok,
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
        reply_markup: settingsKeyboard(await isBotOn()),
      });
      return;
    }


    if (owner && text === '📦 بازیابی بکاپ') {
      await api.sendMessage({
        chat_id: chatId,
        text: '📦 بازیابی از داخل ربات خاموش شد.\nروی سرور این دستور را بزن:\nnpx tgcloud run handlers/seed_import',
        reply_markup: settingsKeyboard(await isBotOn()),
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
  }
}
