import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages, feedback, settings } from 'schema';
import {
  OWNER_IDS,
  WELCOME_TEXT,
  RULES_TEXT,
  BOT_DISABLED_TEXT,
  CHANNELS,
} from 'lib/config';
import {
  userKeyboard,
  ownerKeyboard,
  backKeyboard,
  reviewInline,
} from 'lib/keyboards';
import { validateSubmission } from 'lib/validation';
import { upsertUser, isOwner } from 'lib/users';
import { setState, getState, clearState } from 'lib/state';

async function isBotEnabled() {
  try {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'bot_enabled'))
      .all();
    if (!rows || !rows.length) return true;
    return rows[0].value !== '0';
  } catch (e) {
    console.error('isBotEnabled', e);
    return true;
  }
}

function roleKb(userId) {
  return isOwner(userId) ? ownerKeyboard() : userKeyboard();
}

export default async function (message) {
  try {
    if (!message || !message.chat) {
      console.error('no message/chat', message);
      return;
    }

    const chatId = message.chat.id;
    const userId = message.from?.id || chatId;
    const text = (message.text || '').trim();

    if (message.chat.type && message.chat.type !== 'private') {
      return;
    }

    if (text === '/start' || text.startsWith('/start ')) {
      try { await clearState(userId); } catch (e) { console.error('clearState', e); }
      try { await upsertUser(message.from || { id: userId }); } catch (e) { console.error('upsertUser', e); }
      await api.sendMessage({
        chat_id: chatId,
        text: WELCOME_TEXT,
        reply_markup: roleKb(userId),
      });
      return;
    }

    try { await upsertUser(message.from || { id: userId }); } catch (e) { console.error('upsertUser', e); }

    if (text === '◀️ بازگشت') {
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({ chat_id: chatId, text: 'منوی اصلی', reply_markup: roleKb(userId) });
      return;
    }

    let state = null;
    try { state = await getState(userId); } catch (e) { console.error('getState', e); }

    if (isOwner(userId) && text === '⚙️ روشن/خاموش') {
      const on = await isBotEnabled();
      const next = on ? '0' : '1';
      try {
        const existing = await db.select().from(settings).where(eq(settings.key, 'bot_enabled')).all();
        if (existing && existing.length) {
          await db.update(settings).set({ value: next }).where(eq(settings.key, 'bot_enabled')).run();
        } else {
          await db.insert(settings).values({ key: 'bot_enabled', value: next }).run();
        }
      } catch (e) { console.error('toggle', e); }
      await api.sendMessage({
        chat_id: chatId,
        text: next === '1' ? '🟢 ربات روشن شد.' : '🔴 ربات خاموش شد.',
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (isOwner(userId) && text === '📊 آمار') {
      let total = 0, ap = 0, rj = 0, pe = 0;
      try {
        const all = await db.select().from(messages).all();
        total = all?.length || 0;
        ap = (all || []).filter((m) => m.status === 'approved').length;
        rj = (all || []).filter((m) => m.status === 'rejected').length;
        pe = (all || []).filter((m) => m.status === 'pending').length;
      } catch (e) { console.error('stats', e); }
      await api.sendMessage({
        chat_id: chatId,
        text: `📊 آمار ربات\n\nکل پیام‌ها: ${total}\nتأیید: ${ap}\nرد: ${rj}\nدر انتظار: ${pe}`,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (isOwner(userId) && text === '📥 پیام‌های در انتظار') {
      let list = [];
      try {
        const rows = await db.select().from(messages).where(eq(messages.status, 'pending')).orderBy(desc(messages.id)).all();
        list = (rows || []).slice(0, 20);
      } catch (e) { console.error('pending', e); }
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'صف خالی است.', reply_markup: ownerKeyboard() });
        return;
      }
      for (const row of list) {
        await api.sendMessage({
          chat_id: chatId,
          text: `#${row.id} | ${row.channelKey}\n\n${row.content}`,
          reply_markup: reviewInline(row.id),
        });
      }
      return;
    }

    if (isOwner(userId) && text === '📬 پیام کاربران') {
      let list = [];
      try {
        const rows = await db.select().from(feedback).where(eq(feedback.status, 'open')).orderBy(desc(feedback.id)).all();
        list = (rows || []).slice(0, 15);
      } catch (e) { console.error('feedback list', e); }
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'پیام باز ندارید.', reply_markup: ownerKeyboard() });
        return;
      }
      for (const row of list) {
        await api.sendMessage({ chat_id: chatId, text: `فیدبک #${row.id}\nاز: ${row.userId}\n\n${row.content}` });
      }
      return;
    }

    if (text === '📝 ارسال پیام') {
      if (!(await isBotEnabled())) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: roleKb(userId) });
        return;
      }
      try { await setState(userId, 'user_send'); } catch (e) { console.error('setState', e); }
      await api.sendMessage({ chat_id: chatId, text: RULES_TEXT, reply_markup: backKeyboard() });
      return;
    }

    if (text === '📊 وضعیت پیام من') {
      let list = [];
      try {
        const rows = await db.select().from(messages).where(eq(messages.userId, userId)).orderBy(desc(messages.id)).all();
        list = (rows || []).slice(0, 10);
      } catch (e) { console.error('status', e); }
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'هنوز پیامی ثبت نکرده‌اید.', reply_markup: roleKb(userId) });
        return;
      }
      const map = { pending: '🟡 در انتظار', approved: '🟢 منتشر شد', rejected: '🔴 رد شد' };
      const body = list.map((m) => `#${m.id} | ${map[m.status] || m.status}\n${(m.content || '').slice(0, 80)}`).join('\n────────────\n');
      await api.sendMessage({ chat_id: chatId, text: `📊 پیام‌های شما\n\n${body}`, reply_markup: roleKb(userId) });
      return;
    }

    if (text === '💬 انتقادات، پیشنهادات، گزارش مشکل') {
      try { await setState(userId, 'feedback'); } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: 'پیام خود را بنویسید.\nتوجه: برای ارسال به کانال از «📝 ارسال پیام» استفاده کنید.',
        reply_markup: backKeyboard(),
      });
      return;
    }

    if (text === '📖 راهنما' || text === '❓ راهنما') {
      await api.sendMessage({
        chat_id: chatId,
        text: '📖 راهنما\n\n📝 ارسال پیام: ثبت متن برای کانال\n📊 وضعیت پیام من: پیگیری\n💬 انتقادات: ارتباط با مدیریت\n\n' + RULES_TEXT,
        reply_markup: roleKb(userId),
      });
      return;
    }

    if (state && state.kind === 'feedback' && text) {
      try {
        await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
      } catch (e) { console.error('feedback insert', e); }
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({ chat_id: chatId, text: '✅ پیام شما برای مدیریت ارسال شد.', reply_markup: roleKb(userId) });
      for (const oid of OWNER_IDS) {
        try { await api.sendMessage({ chat_id: oid, text: `📬 فیدبک جدید از ${userId}:\n\n${text}` }); } catch (_) {}
      }
      return;
    }

    if (state && state.kind === 'user_send' && text) {
      if (!(await isBotEnabled())) {
        try { await clearState(userId); } catch (_) {}
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: roleKb(userId) });
        return;
      }
      const v = validateSubmission(message);
      if (!v.ok) {
        await api.sendMessage({ chat_id: chatId, text: v.error, reply_markup: backKeyboard() });
        return;
      }
      let row = null;
      try {
        const inserted = await db.insert(messages).values({
          userId, content: text, channelKey: v.channelKey, status: 'pending',
        }).returning().run();
        row = inserted && (inserted[0] || inserted.rows?.[0]);
      } catch (e) {
        console.error('insert message', e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در ثبت پیام. دوباره تلاش کنید.', reply_markup: roleKb(userId) });
        return;
      }
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: `✅ پیامت با موفقیت ارسال شد.\n\n🆔 شماره پیگیری: #${row?.id ?? '?'}\n\n🟡 در انتظار بررسی است.`,
        reply_markup: roleKb(userId),
      });
      if (row) {
        for (const oid of OWNER_IDS) {
          try {
            await api.sendMessage({
              chat_id: oid,
              text: `📨 پیام جدید #${row.id}\nکانال: ${CHANNELS[v.channelKey]?.title || v.channelKey}\nاز: ${userId}\n\n${text}`,
              reply_markup: reviewInline(row.id),
            });
          } catch (_) {}
        }
      }
      return;
    }

    if (text) {
      await api.sendMessage({
        chat_id: chatId,
        text: 'از منوی پایین یک گزینه را انتخاب کنید، یا /start بزنید.',
        reply_markup: roleKb(userId),
      });
    }
  } catch (e) {
    console.error('message handler fatal', e);
    try {
      if (message?.chat?.id) {
        await api.sendMessage({ chat_id: message.chat.id, text: '⚠️ خطای موقت. دوباره /start را بزنید.' });
      }
    } catch (_) {}
  }
}
