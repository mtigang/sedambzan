import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages, feedback, settings, users } from 'schema';
import {
  OWNER_IDS,
  WELCOME_TEXT,
  RULES_TEXT,
  BOT_DISABLED_TEXT,
  CHANNELS,
} from 'lib/config';
import {
  userKeyboard,
  adminKeyboard,
  ownerKeyboard,
  ownerStatsKeyboard,
  ownerAdminsKeyboard,
  ownerSearchKeyboard,
  ownerSystemKeyboard,
  ownerAnnounceKeyboard,
  backKeyboard,
  reviewInline,
  feedbackInline,
  userProfileInline,
} from 'lib/keyboards';
import { validateSubmission } from 'lib/validation';
import {
  upsertUser,
  isOwner,
  getUserRole,
  listAdmins,
  setAdmin,
  setBlocked,
  getUser,
} from 'lib/users';
import { setState, getState, clearState } from 'lib/state';

async function settingGet(key, def = null) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    if (rows && rows[0]) return rows[0].value;
  } catch (_) {}
  return def;
}

async function settingSet(key, value) {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).all();
  if (existing && existing.length) {
    await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key)).run();
  } else {
    await db.insert(settings).values({ key, value: String(value) }).run();
  }
}

async function isBotEnabled() {
  const v = await settingGet('bot_enabled', '1');
  return v !== '0';
}

async function isChannelEnabled(key) {
  const v = await settingGet(`channel_enabled_${key}`, '1');
  return v !== '0';
}

async function roleKb(userId) {
  const role = await getUserRole(userId);
  if (role === 'owner') return ownerKeyboard();
  if (role === 'admin') return adminKeyboard();
  return userKeyboard();
}

function fmtUser(u) {
  if (!u) return '—';
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'بدون نام';
  const un = u.username ? `@${u.username}` : '—';
  return `${name} | ${un} | \`${u.userId}\``;
}

export default async function (message) {
  try {
    if (!message?.chat) return;
    const chatId = message.chat.id;
    const userId = message.from?.id || chatId;
    const text = (message.text || '').trim();
    if (message.chat.type && message.chat.type !== 'private') return;

    // block check
    try {
      const u = await getUser(userId);
      if (u && u.blocked && !isOwner(userId)) {
        await api.sendMessage({ chat_id: chatId, text: '🚫 دسترسی شما محدود شده است.' });
        return;
      }
    } catch (_) {}

    if (text === '/start' || text.startsWith('/start ')) {
      try { await clearState(userId); } catch (_) {}
      try { await upsertUser(message.from || { id: userId }); } catch (e) { console.error(e); }
      await api.sendMessage({
        chat_id: chatId,
        text: WELCOME_TEXT,
        reply_markup: await roleKb(userId),
        parse_mode: 'Markdown',
      });
      return;
    }

    try { await upsertUser(message.from || { id: userId }); } catch (_) {}

    let state = null;
    try { state = await getState(userId); } catch (_) {}

    // ========== بازگشت ==========
    if (text === '◀️ بازگشت') {
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text: 'منوی اصلی',
        reply_markup: await roleKb(userId),
      });
      return;
    }

    const owner = isOwner(userId);
    const role = await getUserRole(userId);
    const isAdm = role === 'admin' || owner;

    // ========== OWNER MENUS ==========
    if (owner && text === '👥 ادمین‌ها') {
      await api.sendMessage({ chat_id: chatId, text: 'مدیریت ادمین‌ها:', reply_markup: ownerAdminsKeyboard() });
      return;
    }
    if (owner && text === '📊 آمار و گزارش‌ها') {
      await api.sendMessage({ chat_id: chatId, text: 'آمار و گزارش‌ها:', reply_markup: ownerStatsKeyboard() });
      return;
    }
    if (owner && text === '🔍 جستجو') {
      await api.sendMessage({ chat_id: chatId, text: 'جستجو:', reply_markup: ownerSearchKeyboard() });
      return;
    }
    if (owner && text === '⚙️ مدیریت سیستم') {
      await api.sendMessage({ chat_id: chatId, text: 'مدیریت سیستم:', reply_markup: ownerSystemKeyboard() });
      return;
    }
    if (owner && text === '📢 اطلاعیه‌ها') {
      await api.sendMessage({ chat_id: chatId, text: 'ارسال اطلاعیه:', reply_markup: ownerAnnounceKeyboard() });
      return;
    }

    // --- ادمین‌ها ---
    if (owner && text === '📋 لیست ادمین‌ها') {
      const admins = await listAdmins();
      if (!admins.length) {
        await api.sendMessage({ chat_id: chatId, text: 'ادمینی ثبت نشده.', reply_markup: ownerAdminsKeyboard() });
        return;
      }
      const lines = admins.map((a, i) => `${i + 1}. ${fmtUser(a)}`).join('\n');
      await api.sendMessage({
        chat_id: chatId,
        text: `👮 ادمین‌ها (${admins.length})\n\n${lines}`,
        reply_markup: ownerAdminsKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }
    if (owner && text === '➕ افزودن ادمین') {
      await setState(userId, 'add_admin');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی کاربر را بفرست.\nبرای چند نفر: هر خط یک آیدی',
        reply_markup: backKeyboard(),
      });
      return;
    }
    if (owner && text === '➖ حذف ادمین') {
      await setState(userId, 'del_admin');
      await api.sendMessage({
        chat_id: chatId,
        text: 'آیدی عددی ادمینی که باید حذف شود را بفرست.',
        reply_markup: backKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'add_admin' && text) {
      const ids = text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
      if (!ids.length) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی معتبر نیست.', reply_markup: backKeyboard() });
        return;
      }
      for (const id of ids) {
        if (isOwner(id)) continue;
        await setAdmin(id, true);
        try {
          await api.sendMessage({ chat_id: id, text: '✅ شما به عنوان ادمین ربات آرال اضافه شدید.\n/start را بزنید.' });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `✅ ${ids.length} ادمین اضافه شد.`,
        reply_markup: ownerAdminsKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'del_admin' && text) {
      const id = Number(text.replace(/\D/g, ''));
      if (!id) {
        await api.sendMessage({ chat_id: chatId, text: 'آیدی نامعتبر.', reply_markup: backKeyboard() });
        return;
      }
      await setAdmin(id, false);
      await clearState(userId);
      await api.sendMessage({ chat_id: chatId, text: `حذف شد: ${id}`, reply_markup: ownerAdminsKeyboard() });
      return;
    }

    // --- آمار ---
    if (owner && text === '📊 داشبورد آماری') {
      let all = [];
      try { all = await db.select().from(messages).all() || []; } catch (_) {}
      const total = all.length;
      const ap = all.filter((m) => m.status === 'approved').length;
      const rj = all.filter((m) => m.status === 'rejected').length;
      const pe = all.filter((m) => m.status === 'pending').length;
      let byCh = '';
      for (const [k, cfg] of Object.entries(CHANNELS)) {
        const n = all.filter((m) => m.channelKey === k).length;
        byCh += `• ${cfg.title}: ${n}\n`;
      }
      let userCount = 0, adminCount = 0;
      try {
        const us = await db.select().from(users).all() || [];
        userCount = us.length;
        adminCount = us.filter((u) => u.role === 'admin').length;
      } catch (_) {}
      await api.sendMessage({
        chat_id: chatId,
        text:
          `📊 داشبورد آماری\n\n` +
          `📨 کل پیام‌ها: ${total}\n🟡 در انتظار: ${pe}\n🟢 تأیید: ${ap}\n🔴 رد: ${rj}\n\n` +
          `👥 کاربران: ${userCount}\n👮 ادمین‌ها: ${adminCount}\n\n` +
          `تفکیک کانال:\n${byCh}`,
        reply_markup: ownerStatsKeyboard(),
      });
      return;
    }
    if (owner && text === '👥 آمار کاربران') {
      let us = [];
      try { us = await db.select().from(users).all() || []; } catch (_) {}
      const started = us.filter((u) => u.started).length;
      const blocked = us.filter((u) => u.blocked).length;
      await api.sendMessage({
        chat_id: chatId,
        text: `👥 آمار کاربران\n\nکل: ${us.length}\nاستارت‌زده: ${started}\nبن‌شده: ${blocked}`,
        reply_markup: ownerStatsKeyboard(),
      });
      return;
    }
    if (owner && text === '👮 آمار ادمین‌ها') {
      const admins = await listAdmins();
      let lines = `👮 تعداد ادمین: ${admins.length}\n\n`;
      for (const a of admins.slice(0, 30)) {
        let approved = 0;
        try {
          const ms = await db.select().from(messages).where(eq(messages.status, 'approved')).all() || [];
          // no reviewer id column — skip detailed
        } catch (_) {}
        lines += `• ${fmtUser(a)}\n`;
      }
      await api.sendMessage({
        chat_id: chatId,
        text: lines.slice(0, 3500),
        reply_markup: ownerStatsKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }

    // --- جستجو ---
    if (owner && text === '🔎 جستجو پیام') {
      await setState(userId, 'search_msg');
      await api.sendMessage({ chat_id: chatId, text: 'آیدی عددی پیام را بفرست (مثلاً 123)', reply_markup: backKeyboard() });
      return;
    }
    if (owner && text === '🔎 جستجو کاربر') {
      await setState(userId, 'search_user');
      await api.sendMessage({ chat_id: chatId, text: 'آیدی عددی کاربر را بفرست.', reply_markup: backKeyboard() });
      return;
    }
    if (owner && text === '🚫 بن کاربر') {
      await setState(userId, 'ban_user');
      await api.sendMessage({ chat_id: chatId, text: 'آیدی عددی کاربر برای بن:', reply_markup: backKeyboard() });
      return;
    }
    if (owner && state?.kind === 'search_msg' && text) {
      const id = Number(text.replace(/\D/g, ''));
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      await clearState(userId);
      if (!rows?.length) {
        await api.sendMessage({ chat_id: chatId, text: 'پیام پیدا نشد.', reply_markup: ownerSearchKeyboard() });
        return;
      }
      const m = rows[0];
      const sender = await getUser(m.userId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          `🔎 پیام #${m.id}\n` +
          `وضعیت: ${m.status}\nکانال: ${m.channelKey}\n` +
          `فرستنده: ${fmtUser(sender)}\n` +
          `رد: ${m.rejectReason || '—'}\n\n${m.content}`,
        reply_markup: m.status === 'pending' ? reviewInline(m.id) : ownerSearchKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }
    if (owner && state?.kind === 'search_user' && text) {
      const id = Number(text.replace(/\D/g, ''));
      await clearState(userId);
      const u = await getUser(id);
      let msgCount = 0;
      try {
        const ms = await db.select().from(messages).where(eq(messages.userId, id)).all() || [];
        msgCount = ms.length;
        var byStatus = {
          pending: ms.filter((x) => x.status === 'pending').length,
          approved: ms.filter((x) => x.status === 'approved').length,
          rejected: ms.filter((x) => x.status === 'rejected').length,
        };
      } catch (_) {
        var byStatus = { pending: 0, approved: 0, rejected: 0 };
      }
      await api.sendMessage({
        chat_id: chatId,
        text:
          `👤 کاربر\n${fmtUser(u || { userId: id })}\n` +
          `نقش: ${u?.role || '?'}\nبن: ${u?.blocked ? 'بله' : 'خیر'}\n` +
          `پیام‌ها: ${msgCount} (🟡${byStatus.pending} 🟢${byStatus.approved} 🔴${byStatus.rejected})`,
        reply_markup: userProfileInline(id),
        parse_mode: 'Markdown',
      });
      return;
    }
    if (owner && state?.kind === 'ban_user' && text) {
      const id = Number(text.replace(/\D/g, ''));
      await clearState(userId);
      if (isOwner(id)) {
        await api.sendMessage({ chat_id: chatId, text: 'نمی‌توان مالک را بن کرد.', reply_markup: ownerSearchKeyboard() });
        return;
      }
      await setBlocked(id, true);
      await api.sendMessage({ chat_id: chatId, text: `🚫 کاربر ${id} بن شد.`, reply_markup: ownerSearchKeyboard() });
      return;
    }

    // --- سیستم ---
    if (owner && text === '🟢/🔴 روشن خاموش ربات') {
      const on = await isBotEnabled();
      const next = on ? '0' : '1';
      await settingSet('bot_enabled', next);
      await api.sendMessage({
        chat_id: chatId,
        text: next === '1' ? '🟢 ربات روشن شد.' : '🔴 ربات خاموش شد.',
        reply_markup: ownerSystemKeyboard(),
      });
      return;
    }
    if (owner && text === '📢 وضعیت کانال‌ها') {
      let t = '📢 وضعیت کانال‌ها\n\n';
      for (const [k, cfg] of Object.entries(CHANNELS)) {
        const en = await isChannelEnabled(k);
        t += `${en ? '🟢' : '🔴'} ${cfg.title} (\`${k}\`)\n`;
      }
      t += '\nبرای تغییر: \n`channel on sadambazan`\n`channel off inkarbar`';
      await setState(userId, 'channel_toggle');
      await api.sendMessage({ chat_id: chatId, text: t, reply_markup: backKeyboard(), parse_mode: 'Markdown' });
      return;
    }
    if (owner && state?.kind === 'channel_toggle' && text) {
      const m = text.match(/^channel\s+(on|off)\s+(\w+)$/i);
      if (!m) {
        await api.sendMessage({ chat_id: chatId, text: 'فرمت: channel on sadambazan', reply_markup: backKeyboard() });
        return;
      }
      const key = m[2];
      if (!CHANNELS[key]) {
        await api.sendMessage({ chat_id: chatId, text: 'کلید کانال نامعتبر.', reply_markup: backKeyboard() });
        return;
      }
      await settingSet(`channel_enabled_${key}`, m[1].toLowerCase() === 'on' ? '1' : '0');
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `${CHANNELS[key].title}: ${m[1].toLowerCase() === 'on' ? '🟢 روشن' : '🔴 خاموش'}`,
        reply_markup: ownerSystemKeyboard(),
      });
      return;
    }
    if (owner && text === '🧹 پاک‌سازی صف') {
      await setState(userId, 'clear_queue_confirm');
      await api.sendMessage({
        chat_id: chatId,
        text: '⚠️ همه پیام‌های pending پاک شوند؟\nبرای تأیید بنویس: yes',
        reply_markup: backKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'clear_queue_confirm' && text.toLowerCase() === 'yes') {
      const pending = await db.select().from(messages).where(eq(messages.status, 'pending')).all() || [];
      for (const row of pending) {
        await db.update(messages).set({ status: 'rejected', rejectReason: 'پاک‌سازی صف' }).where(eq(messages.id, row.id)).run();
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: `پیام #${row.id} از صف حذف شد.\nعلت: پاک‌سازی صف توسط مدیریت`,
          });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `🧹 ${pending.length} پیام از صف پاک شد.`,
        reply_markup: ownerSystemKeyboard(),
      });
      return;
    }
    if (owner && text === '🧪 تست اتصال') {
      try {
        const me = await api.getMe();
        await api.sendMessage({
          chat_id: chatId,
          text: `✅ اتصال OK\n@${me.username}\nid: ${me.id}\n${me.first_name}`,
          reply_markup: ownerSystemKeyboard(),
        });
      } catch (e) {
        await api.sendMessage({ chat_id: chatId, text: `❌ خطا: ${e}`, reply_markup: ownerSystemKeyboard() });
      }
      return;
    }

    // --- اطلاعیه ---
    if (owner && text === '📣 به همه کاربران') {
      await setState(userId, 'announce_users');
      await api.sendMessage({ chat_id: chatId, text: 'متن اطلاعیه برای همه کاربران را بفرست.', reply_markup: backKeyboard() });
      return;
    }
    if (owner && text === '📣 به ادمین‌ها') {
      await setState(userId, 'announce_admins');
      await api.sendMessage({ chat_id: chatId, text: 'متن اطلاعیه برای ادمین‌ها را بفرست.', reply_markup: backKeyboard() });
      return;
    }
    if (owner && state?.kind === 'announce_users' && text) {
      await clearState(userId);
      const us = await db.select().from(users).all() || [];
      let ok = 0, fail = 0;
      await api.sendMessage({ chat_id: chatId, text: `در حال ارسال به ${us.length} کاربر...` });
      for (const u of us) {
        if (u.blocked) continue;
        try {
          await api.sendMessage({ chat_id: u.userId, text });
          ok++;
        } catch (_) {
          fail++;
        }
      }
      await api.sendMessage({
        chat_id: chatId,
        text: `📣 تمام شد.\nموفق: ${ok}\nناموفق: ${fail}`,
        reply_markup: ownerAnnounceKeyboard(),
      });
      return;
    }
    if (owner && state?.kind === 'announce_admins' && text) {
      await clearState(userId);
      const admins = await listAdmins();
      const targets = [...admins.map((a) => a.userId), ...OWNER_IDS];
      const uniq = [...new Set(targets.map(Number))];
      let ok = 0;
      for (const id of uniq) {
        try {
          await api.sendMessage({ chat_id: id, text });
          ok++;
        } catch (_) {}
      }
      await api.sendMessage({
        chat_id: chatId,
        text: `📣 به ${ok} نفر ارسال شد.`,
        reply_markup: ownerAnnounceKeyboard(),
      });
      return;
    }

    // --- صف / فیدبک ---
    if (isAdm && text === '📥 پیام‌های در انتظار') {
      let list = [];
      try {
        list = (await db.select().from(messages).where(eq(messages.status, 'pending')).orderBy(desc(messages.id)).all() || []).slice(0, 25);
      } catch (e) { console.error(e); }
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'صف خالی است.', reply_markup: await roleKb(userId) });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: `📥 ${list.length} پیام در صف (نمایش تا ۲۵)` });
      for (const row of list) {
        await api.sendMessage({
          chat_id: chatId,
          text: `#${row.id} | ${row.channelKey} | user:${row.userId}\n\n${row.content}`,
          reply_markup: reviewInline(row.id),
        });
      }
      return;
    }

    if (owner && text === '📬 پیام کاربران') {
      let list = [];
      try {
        list = (await db.select().from(feedback).where(eq(feedback.status, 'open')).orderBy(desc(feedback.id)).all() || []).slice(0, 20);
      } catch (_) {}
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'فیدبک بازی نیست.', reply_markup: ownerKeyboard() });
        return;
      }
      for (const row of list) {
        await api.sendMessage({
          chat_id: chatId,
          text: `فیدبک #${row.id}\nاز: ${row.userId}\n\n${row.content}`,
          reply_markup: feedbackInline(row.id),
        });
      }
      return;
    }

    // پاسخ فیدبک
    if (owner && state?.kind === 'fb_reply' && text) {
      const fid = state.feedbackId;
      const rows = await db.select().from(feedback).where(eq(feedback.id, fid)).all();
      const row = rows?.[0];
      if (row) {
        await db.update(feedback).set({ status: 'replied', ownerReply: text }).where(eq(feedback.id, fid)).run();
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: `💬 پاسخ مدیریت به پیام شما:\n\n${text}\n\nبا تشکر\nمجموعه آرال`,
          });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({ chat_id: chatId, text: '✅ پاسخ ارسال شد.', reply_markup: ownerKeyboard() });
      return;
    }

    // عملکرد ادمین
    if (isAdm && text === '📊 عملکرد من') {
      await api.sendMessage({
        chat_id: chatId,
        text: '📊 در نسخه Serverless آمار تفصیلی شیفت در دسترس نیست.\nاز «پیام‌های در انتظار» برای بررسی صف استفاده کنید.',
        reply_markup: await roleKb(userId),
      });
      return;
    }

    // ارسال به صورت کاربر عادی (ادمین)
    if (isAdm && text === '📝 ارسال پیام به صورت کاربر عادی') {
      if (!(await isBotEnabled())) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      await setState(userId, 'user_send');
      await api.sendMessage({ chat_id: chatId, text: RULES_TEXT, reply_markup: backKeyboard() });
      return;
    }

    // ========== USER FLOWS ==========
    if (text === '📝 ارسال پیام') {
      if (!(await isBotEnabled())) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      await setState(userId, 'user_send');
      await api.sendMessage({ chat_id: chatId, text: RULES_TEXT, reply_markup: backKeyboard() });
      return;
    }

    if (text === '📊 وضعیت پیام من') {
      let list = [];
      try {
        list = (await db.select().from(messages).where(eq(messages.userId, userId)).orderBy(desc(messages.id)).all() || []).slice(0, 15);
      } catch (_) {}
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'هنوز پیامی ثبت نکرده‌اید.', reply_markup: await roleKb(userId) });
        return;
      }
      const map = { pending: '🟡 در انتظار', approved: '🟢 منتشر شد', rejected: '🔴 رد شد' };
      const body = list
        .map((m) => `#${m.id} | ${map[m.status] || m.status}\n${(m.content || '').slice(0, 90)}`)
        .join('\n────────────\n');
      await api.sendMessage({ chat_id: chatId, text: `📊 پیام‌های شما\n\n${body}`, reply_markup: await roleKb(userId) });
      return;
    }

    if (text === '💬 انتقادات، پیشنهادات، گزارش مشکل') {
      await setState(userId, 'feedback');
      await api.sendMessage({
        chat_id: chatId,
        text: 'پیام خود را بنویسید.\nبرای ارسال به کانال از «📝 ارسال پیام» استفاده کنید.',
        reply_markup: backKeyboard(),
      });
      return;
    }

    if (text === '📖 راهنما' || text === '❓ راهنما') {
      const guide = owner
        ? '👑 راهنمای مالک\n\n• صف و تأیید/رد\n• ادمین اضافه/حذف\n• آمار و جستجو\n• اطلاعیه و تنظیمات\n• پاک‌سازی صف'
        : '📖 راهنما\n\n📝 ارسال پیام\n📊 وضعیت\n💬 ارتباط با مدیریت\n\n' + RULES_TEXT;
      await api.sendMessage({ chat_id: chatId, text: guide, reply_markup: await roleKb(userId) });
      return;
    }

    if (state?.kind === 'feedback' && text) {
      // جلوگیری از اشتباه با قوانین کانال
      if (/^(صدام بزن|این کاربر|تو زندگی بعدی)/.test(text)) {
        await api.sendMessage({
          chat_id: chatId,
          text: 'برای ارسال به کانال از گزینه «📝 ارسال پیام» استفاده کنید.',
          reply_markup: backKeyboard(),
        });
        return;
      }
      try {
        await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
      } catch (e) { console.error(e); }
      await clearState(userId);
      await api.sendMessage({ chat_id: chatId, text: '✅ برای مدیریت ارسال شد.', reply_markup: await roleKb(userId) });
      for (const oid of OWNER_IDS) {
        try { await api.sendMessage({ chat_id: oid, text: `📬 فیدبک از ${userId}:\n\n${text}` }); } catch (_) {}
      }
      return;
    }

    if (state?.kind === 'user_send' && text) {
      if (!(await isBotEnabled())) {
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      const v = validateSubmission(message);
      if (!v.ok) {
        await api.sendMessage({ chat_id: chatId, text: v.error, reply_markup: backKeyboard() });
        return;
      }
      if (!(await isChannelEnabled(v.channelKey))) {
        await api.sendMessage({
          chat_id: chatId,
          text: `🔴 کانال «${CHANNELS[v.channelKey]?.title || v.channelKey}» فعلاً غیرفعال است.`,
          reply_markup: backKeyboard(),
        });
        return;
      }
      let row = null;
      try {
        const inserted = await db
          .insert(messages)
          .values({ userId, content: text, channelKey: v.channelKey, status: 'pending' })
          .returning()
          .run();
        row = inserted?.[0] || inserted?.rows?.[0];
      } catch (e) {
        console.error(e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در ثبت. دوباره تلاش کنید.', reply_markup: await roleKb(userId) });
        return;
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `✅ ثبت شد.\n🆔 #${row?.id ?? '?'}\n🟡 در انتظار بررسی`,
        reply_markup: await roleKb(userId),
      });
      // notify owners + admins
      const admins = await listAdmins();
      const notify = [...new Set([...OWNER_IDS, ...admins.map((a) => a.userId)])];
      for (const id of notify) {
        try {
          await api.sendMessage({
            chat_id: id,
            text: `📨 #${row.id} | ${CHANNELS[v.channelKey]?.title || v.channelKey}\nاز: ${userId}\n\n${text}`,
            reply_markup: reviewInline(row.id),
          });
        } catch (_) {}
      }
      return;
    }

    if (text) {
      await api.sendMessage({
        chat_id: chatId,
        text: 'از منو انتخاب کنید یا /start بزنید.',
        reply_markup: await roleKb(userId),
      });
    }
  } catch (e) {
    console.error('message fatal', e);
    try {
      if (message?.chat?.id) {
        await api.sendMessage({ chat_id: message.chat.id, text: '⚠️ خطا. /start را بزنید.' });
      }
    } catch (_) {}
  }
}
