import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages, feedback, settings } from 'schema';
import { OWNER_IDS, WELCOME_TEXT, RULES_TEXT, BOT_DISABLED_TEXT, CHANNELS } from 'lib/config';
import { userKeyboard, ownerKeyboard, backKeyboard, reviewInline } from 'lib/keyboards';
import { validateSubmission, channelKeyFromPrefix } from 'lib/validation';
import { upsertUser, isOwner, getUserRole } from 'lib/users';
import { setState, getState, clearState } from 'lib/state';

async function isBotEnabled() {
  const rows = await db.select().from(settings).where(eq(settings.key, 'bot_enabled')).run();
  if (!rows || !rows.length) return true;
  return rows[0].value !== '0';
}

function roleKb(userId) {
  return isOwner(userId) ? ownerKeyboard() : userKeyboard();
}

export default async function (message) {
  if (!message || message.chat?.type !== 'private') return;
  if (!message.from) return;

  const userId = message.from.id;
  const text = (message.text || '').trim();
  await upsertUser(message.from);

  // /start
  if (text === '/start' || text.startsWith('/start ')) {
    await clearState(userId);
    await api.sendMessage({
      chat_id: userId,
      text: WELCOME_TEXT,
      reply_markup: roleKb(userId),
    });
    return;
  }

  // بازگشت
  if (text === '◀️ بازگشت') {
    await clearState(userId);
    await api.sendMessage({
      chat_id: userId,
      text: 'منوی اصلی',
      reply_markup: roleKb(userId),
    });
    return;
  }

  const state = await getState(userId);

  // ---- owner: toggle bot ----
  if (isOwner(userId) && text === '⚙️ روشن/خاموش') {
    const on = await isBotEnabled();
    const next = on ? '0' : '1';
    const existing = await db.select().from(settings).where(eq(settings.key, 'bot_enabled')).run();
    if (existing && existing.length) {
      await db.update(settings).set({ value: next }).where(eq(settings.key, 'bot_enabled')).run();
    } else {
      await db.insert(settings).values({ key: 'bot_enabled', value: next }).run();
    }
    await api.sendMessage({
      chat_id: userId,
      text: next === '1' ? '🟢 ربات روشن شد.' : '🔴 ربات خاموش شد.',
      reply_markup: ownerKeyboard(),
    });
    return;
  }

  // ---- owner: stats ----
  if (isOwner(userId) && text === '📊 آمار') {
    const all = await db.select().from(messages).run();
    const total = all?.length || 0;
    const ap = (all || []).filter((m) => m.status === 'approved').length;
    const rj = (all || []).filter((m) => m.status === 'rejected').length;
    const pe = (all || []).filter((m) => m.status === 'pending').length;
    await api.sendMessage({
      chat_id: userId,
      text:
        `📊 آمار ربات\n\n` +
        `کل پیام‌ها: ${total}\n` +
        `تأیید: ${ap}\n` +
        `رد: ${rj}\n` +
        `در انتظار: ${pe}`,
      reply_markup: ownerKeyboard(),
    });
    return;
  }

  // ---- owner: pending ----
  if (isOwner(userId) && text === '📥 پیام‌های در انتظار') {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.status, 'pending'))
      .orderBy(desc(messages.id))
      .run();
    const list = (rows || []).slice(0, 20);
    if (!list.length) {
      await api.sendMessage({
        chat_id: userId,
        text: 'صف خالی است.',
        reply_markup: ownerKeyboard(),
      });
      return;
    }
    for (const row of list) {
      await api.sendMessage({
        chat_id: userId,
        text: `#${row.id} | ${row.channelKey}\n\n${row.content}`,
        reply_markup: reviewInline(row.id),
      });
    }
    return;
  }

  // ---- owner: feedback list ----
  if (isOwner(userId) && text === '📬 پیام کاربران') {
    const rows = await db
      .select()
      .from(feedback)
      .where(eq(feedback.status, 'open'))
      .orderBy(desc(feedback.id))
      .run();
    const list = (rows || []).slice(0, 15);
    if (!list.length) {
      await api.sendMessage({
        chat_id: userId,
        text: 'پیام باز ندارید.',
        reply_markup: ownerKeyboard(),
      });
      return;
    }
    for (const row of list) {
      await api.sendMessage({
        chat_id: userId,
        text: `فیدبک #${row.id}\nاز: ${row.userId}\n\n${row.content}`,
      });
    }
    return;
  }

  // ---- user: send start ----
  if (text === '📝 ارسال پیام') {
    if (!(await isBotEnabled())) {
      await api.sendMessage({ chat_id: userId, text: BOT_DISABLED_TEXT, reply_markup: roleKb(userId) });
      return;
    }
    await setState(userId, 'user_send');
    await api.sendMessage({
      chat_id: userId,
      text: RULES_TEXT,
      reply_markup: backKeyboard(),
    });
    return;
  }

  // ---- user: status ----
  if (text === '📊 وضعیت پیام من') {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.userId, userId))
      .orderBy(desc(messages.id))
      .run();
    const list = (rows || []).slice(0, 10);
    if (!list.length) {
      await api.sendMessage({
        chat_id: userId,
        text: 'هنوز پیامی ثبت نکرده‌اید.',
        reply_markup: roleKb(userId),
      });
      return;
    }
    const map = { pending: '🟡 در انتظار', approved: '🟢 منتشر شد', rejected: '🔴 رد شد' };
    const body = list
      .map((m) => `#${m.id} | ${map[m.status] || m.status}\n${(m.content || '').slice(0, 80)}`)
      .join('\n────────────\n');
    await api.sendMessage({
      chat_id: userId,
      text: `📊 پیام‌های شما\n\n${body}`,
      reply_markup: roleKb(userId),
    });
    return;
  }

  // ---- feedback ----
  if (text === '💬 انتقادات، پیشنهادات، گزارش مشکل') {
    await setState(userId, 'feedback');
    await api.sendMessage({
      chat_id: userId,
      text:
        'پیام خود را بنویسید.\n' +
        'توجه: برای ارسال به کانال از «📝 ارسال پیام» استفاده کنید.',
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (text === '📖 راهنما' || text === '❓ راهنما') {
    await api.sendMessage({
      chat_id: userId,
      text:
        '📖 راهنما\n\n' +
        '📝 ارسال پیام: ثبت متن برای کانال\n' +
        '📊 وضعیت پیام من: پیگیری\n' +
        '💬 انتقادات: ارتباط با مدیریت\n\n' +
        RULES_TEXT,
      reply_markup: roleKb(userId),
    });
    return;
  }

  // ---- state: feedback body ----
  if (state && state.kind === 'feedback' && text) {
    await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
    await clearState(userId);
    await api.sendMessage({
      chat_id: userId,
      text: '✅ پیام شما برای مدیریت ارسال شد.',
      reply_markup: roleKb(userId),
    });
    for (const oid of OWNER_IDS) {
      try {
        await api.sendMessage({
          chat_id: oid,
          text: `📬 فیدبک جدید از ${userId}:\n\n${text}`,
        });
      } catch (_) {}
    }
    return;
  }

  // ---- state: user_send ----
  if (state && state.kind === 'user_send' && text) {
    if (!(await isBotEnabled())) {
      await clearState(userId);
      await api.sendMessage({ chat_id: userId, text: BOT_DISABLED_TEXT, reply_markup: roleKb(userId) });
      return;
    }
    const v = validateSubmission(message);
    if (!v.ok) {
      await api.sendMessage({ chat_id: userId, text: v.error, reply_markup: backKeyboard() });
      return;
    }
    const [row] = await db
      .insert(messages)
      .values({
        userId,
        content: text,
        channelKey: v.channelKey,
        status: 'pending',
      })
      .returning()
      .run();

    await clearState(userId);
    await api.sendMessage({
      chat_id: userId,
      text:
        `✅ پیامت با موفقیت ارسال شد.\n\n` +
        `🆔 شماره پیگیری: #${row.id}\n\n` +
        `🟡 در انتظار بررسی است.`,
      reply_markup: roleKb(userId),
    });

    // notify owners
    for (const oid of OWNER_IDS) {
      try {
        await api.sendMessage({
          chat_id: oid,
          text: `📨 پیام جدید #${row.id}\nکانال: ${CHANNELS[v.channelKey]?.title || v.channelKey}\nاز: ${userId}\n\n${text}`,
          reply_markup: reviewInline(row.id),
        });
      } catch (_) {}
    }
    return;
  }
}
