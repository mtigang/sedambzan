import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { messages } from 'schema';
import { OWNER_IDS } from 'lib/config';
import { isOwner } from 'lib/users';

export default async function (callbackQuery) {
  const data = callbackQuery.data || '';
  const userId = callbackQuery.from?.id;
  if (!userId) return;

  if (!isOwner(userId)) {
    await api.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: '⛔ فقط مالک',
      show_alert: true,
    });
    return;
  }

  if (data.startsWith('approve:')) {
    const id = Number(data.split(':')[1]);
    const rows = await db.select().from(messages).where(eq(messages.id, id)).run();
    const row = rows && rows[0];
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
      await api.sendMessage({
        chat_id: row.userId,
        text: `✅ پیام #${id} تأیید شد.`,
      });
    } catch (_) {}
    return;
  }

  if (data.startsWith('reject:')) {
    const id = Number(data.split(':')[1]);
    const rows = await db.select().from(messages).where(eq(messages.id, id)).run();
    const row = rows && rows[0];
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
      .set({ status: 'rejected', rejectReason: 'نامناسب', reviewedAt: new Date() })
      .where(eq(messages.id, id))
      .run();
    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'رد شد' });
    try {
      await api.editMessageText({
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: `🔴 رد شد — #${id}`,
      });
    } catch (_) {}
    try {
      await api.sendMessage({
        chat_id: row.userId,
        text: `🔴 پیام #${id} رد شد.\nدلیل: نامناسب`,
      });
    } catch (_) {}
    return;
  }
}
