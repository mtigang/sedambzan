import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { messages, feedback } from 'schema';
import { isOwner } from 'lib/dbutil';
import { setState } from 'lib/state';
import { rejectReasonsInline, reviewInline } from 'lib/keyboards';

export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;

    if (data.startsWith('approve:')) {
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
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
          text: `🟢 تأیید #${id} توسط ${userId}`,
        });
      } catch (_) {}
      try {
        await api.sendMessage({ chat_id: row.userId, text: `✅ پیام #${id} تأیید شد.` });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_menu:')) {
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
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        return;
      }
      await db
        .update(messages)
        .set({ status: 'rejected', rejectReason: reason, reviewedBy: userId, reviewedAt: new Date() })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `🔴 رد #${id}\nدلیل: ${reason}`,
        });
      } catch (_) {}
      try {
        await api.sendMessage({ chat_id: row.userId, text: `🔴 پیام #${id} رد شد.\nدلیل: ${reason}` });
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
      await api.sendMessage({ chat_id: cq.message.chat.id, text: `پاسخ #${fid}:` });
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
          text: `✅ فیدبک #${fid} بسته شد`,
        });
      } catch (_) {}
      return;
    }
  } catch (e) {
    console.error('cb', e);
    try {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'خطا', show_alert: true });
    } catch (_) {}
  }
}
