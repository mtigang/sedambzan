import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { messages, feedback } from 'schema';
import { isOwner, setBlocked } from 'lib/users';
import { setState } from 'lib/state';
import { rejectReasonsInline, reviewInline } from 'lib/keyboards';

export default async function (callbackQuery) {
  try {
    const data = callbackQuery.data || '';
    const userId = callbackQuery.from?.id;
    if (!userId) return;

    const owner = isOwner(userId);

    // --- approve ---
    if (data.startsWith('approve:')) {
      if (!owner) {
        // admins can also approve
        // allow any - simplified: only owner for now was restriction; expand to all who got the message
      }
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({ status: 'approved', reviewedAt: new Date() })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'تأیید شد' });
      try {
        await api.editMessageText({
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          text: `🟢 تأیید شد — #${id}`,
        });
      } catch (_) {}
      try {
        await api.sendMessage({ chat_id: row.userId, text: `✅ پیام #${id} تأیید شد.` });
      } catch (_) {}
      return;
    }

    // reject menu
    if (data.startsWith('reject_menu:')) {
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      try {
        await api.editMessageReplyMarkup({
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          reply_markup: rejectReasonsInline(id),
        });
      } catch (_) {
        await api.sendMessage({
          chat_id: callbackQuery.message.chat.id,
          text: `دلیل رد #${id}:`,
          reply_markup: rejectReasonsInline(id),
        });
      }
      return;
    }

    if (data.startsWith('reject_cancel:')) {
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'لغو شد' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          reply_markup: reviewInline(id),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject:')) {
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({ status: 'rejected', rejectReason: reason, reviewedAt: new Date() })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'رد شد' });
      try {
        await api.editMessageText({
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          text: `🔴 رد شد — #${id}\nدلیل: ${reason}`,
        });
      } catch (_) {}
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: `🔴 پیام #${id} رد شد.\nدلیل: ${reason}`,
        });
      } catch (_) {}
      return;
    }

    // feedback
    if (data.startsWith('fb_reply:')) {
      if (!owner) {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'فقط مالک',
          show_alert: true,
        });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await setState(userId, 'fb_reply', { feedbackId: fid });
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.sendMessage({
        chat_id: callbackQuery.message.chat.id,
        text: `پاسخ فیدبک #${fid} را بنویسید:`,
      });
      return;
    }

    if (data.startsWith('fb_close:')) {
      if (!owner) {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'فقط مالک',
          show_alert: true,
        });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await db.update(feedback).set({ status: 'closed' }).where(eq(feedback.id, fid)).run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'بسته شد' });
      try {
        await api.editMessageText({
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          text: `✅ فیدبک #${fid} بسته شد.`,
        });
      } catch (_) {}
      return;
    }

    // ban / unban
    if (data.startsWith('ban:') || data.startsWith('unban:')) {
      if (!owner) {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'فقط مالک',
          show_alert: true,
        });
        return;
      }
      const ban = data.startsWith('ban:');
      const tid = Number(data.split(':')[1]);
      if (isOwner(tid)) {
        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: 'مالک قابل بن نیست',
          show_alert: true,
        });
        return;
      }
      await setBlocked(tid, ban);
      await api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: ban ? 'بن شد' : 'آنبن شد',
      });
      return;
    }
  } catch (e) {
    console.error('callback fatal', e);
    try {
      await api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: 'خطا',
        show_alert: true,
      });
    } catch (_) {}
  }
}
