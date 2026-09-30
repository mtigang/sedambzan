import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { messages, feedback, shifts, settings } from 'schema';
import {
  isOwner,
  removeChannelAdmin,
  listAdminsByChannel,
  syncAdminsFromGroup,
  postToChannel,
  displayName,
  getUser,
  settingGet,
  settingSet,
  activeShiftAdmins,
} from 'lib/dbutil';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange } from 'lib/time';
import { DEFAULT_CHANNELS } from 'lib/config';
import { channelMessageLink } from 'lib/resolve';
import {
  rejectReasonsInline,
  reviewInline,
  adminListInline,
  userOpenInline,
  shiftSlotsInline,
} from 'lib/keyboards';

async function refreshAllShiftBoards(channelKey, date) {
  const dayShifts =
    (await db
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.channelKey, channelKey),
          eq(shifts.shiftDate, date),
          eq(shifts.status, 'active')
        )
      )
      .all()) || [];
  const takenMap = {};
  for (const s of dayShifts) takenMap[s.startHm] = s.adminId;

  // همه boardهای ذخیره‌شده برای این کانال/روز
  try {
    const allSettings = await db.select().from(settings).all();
    const prefix = 'shift_board:' + channelKey + ':' + date + ':';
    for (const row of allSettings || []) {
      if (!row.key || !row.key.startsWith(prefix) || !row.value) continue;
      try {
        const info = JSON.parse(row.value);
        const adminId = Number(row.key.slice(prefix.length));
        const myStarts = new Set(
          dayShifts.filter((s) => s.adminId === adminId).map((s) => s.startHm)
        );
        await api.editMessageReplyMarkup({
          chat_id: info.chatId,
          message_id: info.messageId,
          reply_markup: shiftSlotsInline(channelKey, takenMap, myStarts),
        });
      } catch (e) {
        console.error('refresh board', e);
      }
    }
  } catch (e) {
    console.error('refreshAllShiftBoards', e);
  }
}

export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;

    // ادمین فقط در شیفت بتواند تأیید/رد کند (مالک همیشه)
    async function assertCanReview() {
      if (isOwner(userId)) return true;
      const { date, hm } = tehranNow();
      const mySh =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, userId), eq(shifts.shiftDate, date), eq(shifts.status, 'active')))
          .all()) || [];
      return mySh.some((s) => inRange(hm, s.startHm, s.endHm));
    }

    if (data.startsWith('approve:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date() })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تأیید شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🟢 تأیید #' + id + ' توسط ' + userId,
        });
      } catch (_) {}

      let link = null;
      try {
        const conf = DEFAULT_CHANNELS[row.channelKey];
        if (conf?.chatId) {
          const sent = await api.sendMessage({ chat_id: conf.chatId, text: row.content });
          const mid = sent && sent.message_id;
          link = channelMessageLink(conf.chatId, mid);
        }
      } catch (e) {
        console.error('publish', e);
        try {
          await api.sendMessage({
            chat_id: userId,
            text: '⚠️ تأیید شد ولی ارسال کانال ناموفق: ' + (e?.description || e),
          });
        } catch (_) {}
      }
      try {
        let txt = '✅ پیام #' + id + ' تأیید و منتشر شد.';
        if (link) txt += '\n' + link;
        await api.sendMessage({ chat_id: row.userId, text: txt });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_menu:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: rejectReasonsInline(id),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_cancel:')) {
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: reviewInline(id),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({
          status: 'rejected',
          rejectReason: reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
        })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🔴 رد #' + id + '\nدلیل: ' + reason,
        });
      } catch (_) {}
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '🔴 پیام #' + id + ' رد شد.\nدلیل: ' + reason,
        });
      } catch (_) {}
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
      const pending = ms.filter((m) => m.status === 'pending');
      let body =
        '👤 ' + displayName(uu, uid) + '\nآیدی: ' + uid + '\n\n— پیام‌ها —\n';
      for (const m of ms.slice(0, 25)) {
        body += '#' + m.id + ' | ' + m.status + '\n' + (m.content || '') + '\n\n';
      }
      if (pending.length) {
        body += '— در صف —\n';
        for (const m of pending) body += '#' + m.id + '\n' + m.content + '\n\n';
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: body.slice(0, 3500),
        reply_markup: userOpenInline(uid),
      });
      return;
    }

    if (data.startsWith('adel:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const [, channelKey, tid] = data.split(':');
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
          reply_markup: adminListInline(ads, channelKey),
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
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const res = await syncAdminsFromGroup(channelKey);
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: res.ok ? 'بروز شد' : 'خطا',
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
          reply_markup: adminListInline(ads, channelKey),
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
      await setState(userId, 'post_text', { channelKey });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'متن برای «' + (DEFAULT_CHANNELS[channelKey]?.title || channelKey) + '»:',
      });
      return;
    }

    if (data === 'postch_cancel' || data === 'post_no') {
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      return;
    }

    if (data === 'post_yes') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const st = await getState(userId);
      if (!st || st.kind !== 'post_confirm' || !st.postText) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'منقضی', show_alert: true });
        return;
      }
      try {
        const sent = await postToChannel(st.channelKey, st.postText);
        await clearState(userId);
        const conf = DEFAULT_CHANNELS[st.channelKey];
        const link = channelMessageLink(conf?.chatId, sent?.message_id);
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
          text: 'خطا: ' + (e?.description || 'fail'),
          show_alert: true,
        });
      }
      return;
    }

    if (data.startsWith('shift_full:')) {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'این شیفت پر است',
        show_alert: true,
      });
      return;
    }
    if (data.startsWith('shift_mine:')) {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شیفت شماست' });
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

    if (data.startsWith('shift_pick:')) {
      const parts = data.split(':');
      const channelKey = parts[1];
      const startHm = parts[2];
      const endHm = parts[3];
      const { date } = tehranNow();

      const mine =
        (await db
          .select()
          .from(shifts)
          .where(
            and(
              eq(shifts.adminId, userId),
              eq(shifts.shiftDate, date),
              eq(shifts.status, 'active')
            )
          )
          .all()) || [];
      if (mine.length >= 2) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'حداکثر ۲ شیفت',
          show_alert: true,
        });
        return;
      }
      const taken =
        (await db
          .select()
          .from(shifts)
          .where(
            and(
              eq(shifts.channelKey, channelKey),
              eq(shifts.shiftDate, date),
              eq(shifts.startHm, startHm),
              eq(shifts.status, 'active')
            )
          )
          .all()) || [];
      if (taken.length) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'پر شده',
          show_alert: true,
        });
        await refreshAllShiftBoards(channelKey, date);
        return;
      }

      await db
        .insert(shifts)
        .values({
          channelKey,
          adminId: userId,
          shiftDate: date,
          startHm,
          endHm,
          status: 'active',
        })
        .run();

      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ثبت شد' });
      await refreshAllShiftBoards(channelKey, date);
      await api.sendMessage({
        chat_id: userId,
        text:
          '✅ شیفت «' +
          (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
          '» ' +
          startHm +
          '–' +
          endHm +
          ' ثبت شد.',
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
  }
}
