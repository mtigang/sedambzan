import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages, feedback, channels, shifts, users } from 'schema';
import {
  WELCOME_TEXT,
  RULES_TEXT,
  BOT_DISABLED_TEXT,
  FEEDBACK_HINT,
  DEFAULT_CHANNELS,
  OWNER_IDS,
} from 'lib/config';
import {
  userKeyboard,
  adminKeyboard,
  ownerKeyboard,
  backKeyboard,
  channelPickKeyboard,
  reviewInline,
  feedbackInline,
} from 'lib/keyboards';
import { validateAndFix } from 'lib/validation';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow } from 'lib/time';
import {
  ensureChannelsSeeded,
  getChannels,
  getChannel,
  isBotOn,
  settingGet,
  settingSet,
  isOwner,
  upsertUser,
  getUser,
  getRole,
  adminChannels,
  addChannelAdmin,
  removeChannelAdmin,
  listAdminsByChannel,
  activeShiftAdmins,
  notifyReviewers,
  pendingForAdmin,
} from 'lib/dbutil';

async function roleKb(uid) {
  const r = await getRole(uid);
  if (r === 'owner') return ownerKeyboard();
  if (r === 'admin') return adminKeyboard();
  return userKeyboard();
}

function fmtUser(u, id) {
  if (!u) return `\`${id}\``;
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
  return `${n}${u.username ? ' @' + u.username : ''} (\`${u.userId || id}\`)`;
}

export default async function (message) {
  try {
    if (!message?.chat || (message.chat.type && message.chat.type !== 'private')) return;
    const chatId = message.chat.id;
    const userId = message.from?.id || chatId;
    const text = (message.text || '').trim();

    await ensureChannelsSeeded();
    try { await upsertUser(message.from || { id: userId }); } catch (e) { console.error('upsert', e); }

    const u = await getUser(userId);
    if (u?.blocked && !isOwner(userId)) {
      await api.sendMessage({ chat_id: chatId, text: '🚫 دسترسی شما محدود است.' });
      return;
    }

    let state = null;
    try { state = await getState(userId); } catch (_) {}

    const owner = isOwner(userId);
    const role = await getRole(userId);

    // —— /start ——
    if (text === '/start' || text.startsWith('/start ')) {
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({ chat_id: chatId, text: WELCOME_TEXT, reply_markup: await roleKb(userId) });
      return;
    }

    if (text === '◀️ بازگشت') {
      try { await clearState(userId); } catch (_) {}
      await api.sendMessage({ chat_id: chatId, text: 'منوی اصلی', reply_markup: await roleKb(userId) });
      return;
    }

    // ===================== USER =====================
    if (text === '📝 ارسال پیام' || text === '📝 ارسال پیام به صورت کاربر عادی') {
      if (!(await isBotOn())) {
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
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
        await api.sendMessage({ chat_id: chatId, text: 'هنوز پیامی ندارید.', reply_markup: await roleKb(userId) });
        return;
      }
      const map = { pending: '🟡 در انتظار', approved: '🟢 تأیید', rejected: '🔴 رد' };
      const body = list
        .map((m) => `#${m.id} | ${map[m.status] || m.status} | ${m.channelKey}\n${(m.content || '').slice(0, 80)}`)
        .join('\n────────────\n');
      await api.sendMessage({ chat_id: chatId, text: `📊 پیام‌های شما\n\n${body}`, reply_markup: await roleKb(userId) });
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

    if (text === '📖 راهنما') {
      const t =
        role === 'owner'
          ? '👑 راهنمای مالک\n\n• صف و تأیید/رد\n• ادمین per کانال\n• شیفت‌ها\n• لینک و تنظیم کانال\n• اطلاعیه و جستجو'
          : role === 'admin'
            ? '👮 راهنمای ادمین\n\n• شیفت انتخاب کنید\n• صف کانال‌های خود را بررسی کنید\n• تأیید/رد کنید'
            : '📖 راهنما\n\n' + RULES_TEXT;
      await api.sendMessage({ chat_id: chatId, text: t, reply_markup: await roleKb(userId) });
      return;
    }

    // state: feedback
    if (state?.kind === 'feedback' && text) {
      if (/^(صدام بزن|این کاربر|تو زندگی بعدی)/.test(text)) {
        await api.sendMessage({
          chat_id: chatId,
          text:
            '⚠️ این دکمه فقط برای انتقاد/پیشنهاد به مالک است.\n\n' +
            'برای گذاشتن پیام در کانال از\n📝 ارسال پیام\nاستفاده کنید.',
          reply_markup: backKeyboard(),
        });
        return;
      }
      await db.insert(feedback).values({ userId, content: text, status: 'open' }).run();
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: '✅ انتقاد/پیشنهاد شما برای مالک ارسال شد.',
        reply_markup: await roleKb(userId),
      });
      for (const oid of OWNER_IDS) {
        try {
          await api.sendMessage({ chat_id: oid, text: `📬 فیدبک از ${userId}:\n\n${text}` });
        } catch (_) {}
      }
      return;
    }

    // state: user_send
    if (state?.kind === 'user_send' && text) {
      if (!(await isBotOn())) {
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: BOT_DISABLED_TEXT, reply_markup: await roleKb(userId) });
        return;
      }
      const v = validateAndFix(message);
      if (!v.ok) {
        await api.sendMessage({ chat_id: chatId, text: v.error, reply_markup: backKeyboard() });
        return;
      }
      const ch = await getChannel(v.channelKey);
      if (!ch || !ch.enabled) {
        await api.sendMessage({
          chat_id: chatId,
          text: `🔴 کانال «${ch?.title || v.channelKey}» فعلاً غیرفعال است.`,
          reply_markup: backKeyboard(),
        });
        return;
      }
      // ساعت کاری
      const now = tehranNow();
      const { inRange } = await import('lib/time');
      if (ch.workStart && ch.workEnd && !inRange(now.hm, ch.workStart, ch.workEnd)) {
        await api.sendMessage({
          chat_id: chatId,
          text: `⏰ ساعت کاری «${ch.title}» از ${ch.workStart} تا ${ch.workEnd} است.\nلطفاً در همین بازه پیام بفرستید.`,
          reply_markup: backKeyboard(),
        });
        return;
      }

      let row;
      try {
        const ins = await db
          .insert(messages)
          .values({
            userId,
            content: v.content,
            channelKey: v.channelKey,
            status: 'pending',
          })
          .returning()
          .run();
        row = ins?.[0] || ins?.rows?.[0];
      } catch (e) {
        console.error(e);
        await api.sendMessage({ chat_id: chatId, text: 'خطا در ثبت. دوباره تلاش کنید.', reply_markup: await roleKb(userId) });
        return;
      }
      await clearState(userId);
      let note = `✅ ثبت شد.\n🆔 #${row?.id}\n🟡 در انتظار بررسی ادمین`;
      if (v.autoFixed) note += '\n\nℹ️ متن کمی اصلاح شد (بولد/نقطه) و برای بررسی ارسال گردید.';
      await api.sendMessage({ chat_id: chatId, text: note, reply_markup: await roleKb(userId) });

      await notifyReviewers(
        v.channelKey,
        `📨 #${row.id} | ${ch.title}\nاز: ${userId}\n\n${v.content}`,
        reviewInline(row.id)
      );
      return;
    }

    // ===================== ADMIN: shifts =====================
    if ((role === 'admin' || owner) && text === '⏰ شیفت من') {
      const keys = owner ? (await getChannels()).map((c) => c.key) : await adminChannels(userId);
      if (!keys.length) {
        await api.sendMessage({ chat_id: chatId, text: 'شما ادمین هیچ کانالی نیستید.', reply_markup: await roleKb(userId) });
        return;
      }
      const chans = (await getChannels()).filter((c) => keys.includes(c.key));
      await setState(userId, 'pick_shift_channel');
      await api.sendMessage({
        chat_id: chatId,
        text: 'برای کدام کانال شیفت می‌خواهید؟',
        reply_markup: channelPickKeyboard(chans, 'شیفت: '),
      });
      return;
    }

    if (state?.kind === 'pick_shift_channel' && text.startsWith('شیفت: ')) {
      const title = text.replace('شیفت: ', '');
      const ch = (await getChannels()).find((c) => c.title === title);
      if (!ch) {
        await api.sendMessage({ chat_id: chatId, text: 'کانال نامعتبر', reply_markup: backKeyboard() });
        return;
      }
      const { date } = tehranNow();
      // شیفت‌های موجود امروز این کانال
      const today =
        (await db
          .select()
          .from(shifts)
          .where(eq(shifts.channelKey, ch.key))
          .all()) || [];
      const mine = today.filter((s) => s.shiftDate === date && s.adminId === userId && s.status === 'active');
      let info = `⏰ کانال: ${ch.title}\n📅 امروز: ${date}\n\n`;
      if (mine.length) {
        info += 'شیفت‌های شما امروز:\n' + mine.map((s) => `• ${s.startHm}–${s.endHm}`).join('\n');
      } else {
        info += 'شیفت فعالی ندارید.\n';
      }
      info +=
        '\n\nبرای ثبت شیفت جدید بفرستید:\n`HH:MM-HH:MM`\nمثال: `14:00-16:00`';
      await setState(userId, 'set_shift', { channelKey: ch.key });
      await api.sendMessage({ chat_id: chatId, text: info, reply_markup: backKeyboard(), parse_mode: 'Markdown' });
      return;
    }

    if (state?.kind === 'set_shift' && text) {
      const m = text.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) {
        await api.sendMessage({ chat_id: chatId, text: 'فرمت: 14:00-16:00', reply_markup: backKeyboard() });
        return;
      }
      const { date } = tehranNow();
      // جلوگیری از هم‌پوشانی با شیفت خودش
      const existing =
        (await db
          .select()
          .from(shifts)
          .where(eq(shifts.adminId, userId))
          .all()) || [];
      const sameDay = existing.filter(
        (s) => s.shiftDate === date && s.status === 'active' && s.channelKey === state.channelKey
      );
      // چک ساده هم‌پوشانی
      const { hmToMin } = await import('lib/time');
      const ns = hmToMin(m[1]);
      const ne = hmToMin(m[2]) || 24 * 60;
      for (const s of sameDay) {
        const ss = hmToMin(s.startHm);
        const se = hmToMin(s.endHm) || 24 * 60;
        if (ns < se && ne > ss) {
          await api.sendMessage({
            chat_id: chatId,
            text: `هم‌پوشانی با شیفت ${s.startHm}–${s.endHm}`,
            reply_markup: backKeyboard(),
          });
          return;
        }
      }
      await db
        .insert(shifts)
        .values({
          channelKey: state.channelKey,
          adminId: userId,
          shiftDate: date,
          startHm: m[1],
          endHm: m[2],
          status: 'active',
        })
        .run();
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `✅ شیفت ثبت شد: ${m[1]}–${m[2]}`,
        reply_markup: await roleKb(userId),
      });
      // تحویل صف قبلی
      const pend = await pendingForAdmin(userId);
      if (pend.length) {
        await api.sendMessage({ chat_id: chatId, text: `📥 ${pend.length} پیام در صف کانال‌های شما:` });
        for (const row of pend.slice(0, 15)) {
          await api.sendMessage({
            chat_id: chatId,
            text: `#${row.id} | ${row.channelKey}\n\n${row.content}`,
            reply_markup: reviewInline(row.id),
          });
        }
      }
      return;
    }

    // pending for admin/owner
    if ((role === 'admin' || owner) && text === '📥 پیام‌های در انتظار') {
      const list = (await pendingForAdmin(userId)).slice(0, 30);
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'صف خالی است.', reply_markup: await roleKb(userId) });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: `📥 ${list.length} پیام` });
      for (const row of list) {
        await api.sendMessage({
          chat_id: chatId,
          text: `#${row.id} | ${row.channelKey} | user:${row.userId}\n\n${row.content}`,
          reply_markup: reviewInline(row.id),
        });
      }
      return;
    }

    // ===================== OWNER =====================
    if (owner && text === '👥 ادمین‌ها') {
      const chans = await getChannels();
      await setState(userId, 'admin_menu');
      await api.sendMessage({
        chat_id: chatId,
        text: 'کانال را انتخاب کنید (مدیریت ادمین):',
        reply_markup: channelPickKeyboard(chans, 'ادمین: '),
      });
      return;
    }

    if (owner && state?.kind === 'admin_menu' && text.startsWith('ادمین: ')) {
      const title = text.replace('ادمین: ', '');
      const ch = (await getChannels()).find((c) => c.title === title);
      if (!ch) return;
      const ads = await listAdminsByChannel(ch.key);
      let lines = `👮 ادمین‌های «${ch.title}»\n\n`;
      if (!ads.length) lines += 'خالی\n';
      for (const a of ads) {
        const uu = await getUser(a.userId);
        lines += `• ${fmtUser(uu, a.userId)}\n`;
      }
      lines +=
        '\n➕ افزودن: `+ 123456789`\n➖ حذف: `- 123456789`\nچند نفر: هر خط یک دستور';
      await setState(userId, 'admin_edit', { channelKey: ch.key });
      await api.sendMessage({
        chat_id: chatId,
        text: lines,
        reply_markup: backKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }

    if (owner && state?.kind === 'admin_edit' && text) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      let report = [];
      for (const line of lines) {
        const m = line.match(/^([+\-])\s*(\d+)$/);
        if (!m) {
          report.push(`نامعتبر: ${line}`);
          continue;
        }
        const id = Number(m[2]);
        if (m[1] === '+') {
          await addChannelAdmin(id, state.channelKey);
          report.push(`➕ ${id}`);
          try {
            await api.sendMessage({
              chat_id: id,
              text: `✅ ادمین کانال «${(await getChannel(state.channelKey))?.title}» شدید.\n/start`,
            });
          } catch (_) {}
        } else {
          await removeChannelAdmin(id, state.channelKey);
          report.push(`➖ ${id}`);
        }
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: 'نتیجه:\n' + report.join('\n'),
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (owner && text === '📢 کانال‌ها') {
      const chans = await getChannels();
      let t = '📢 کانال‌ها\n\n';
      for (const c of chans) {
        t += `${c.enabled ? '🟢' : '🔴'} *${c.title}*\nکلید: \`${c.key}\`\nلینک: ${c.link || '—'}\nساعت: ${c.workStart}–${c.workEnd}\n\n`;
      }
      t +=
        'دستورات:\n' +
        '`link KEY https://t.me/...`\n' +
        '`on KEY` / `off KEY`\n' +
        '`hours KEY 11:00 00:00`';
      await setState(userId, 'channel_cfg');
      await api.sendMessage({
        chat_id: chatId,
        text: t,
        reply_markup: backKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }

    if (owner && state?.kind === 'channel_cfg' && text) {
      let m;
      if ((m = text.match(/^link\s+(\w+)\s+(\S+)$/i))) {
        await db.update(channels).set({ link: m[2] }).where(eq(channels.key, m[1])).run();
        await api.sendMessage({ chat_id: chatId, text: `لینک ${m[1]} ذخیره شد.` });
        return;
      }
      if ((m = text.match(/^(on|off)\s+(\w+)$/i))) {
        await db
          .update(channels)
          .set({ enabled: m[1].toLowerCase() === 'on' ? 1 : 0 })
          .where(eq(channels.key, m[2]))
          .run();
        await api.sendMessage({ chat_id: chatId, text: `${m[2]} → ${m[1]}` });
        return;
      }
      if ((m = text.match(/^hours\s+(\w+)\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})$/i))) {
        await db
          .update(channels)
          .set({ workStart: m[2], workEnd: m[3] })
          .where(eq(channels.key, m[1]))
          .run();
        await api.sendMessage({ chat_id: chatId, text: `ساعت ${m[1]}: ${m[2]}–${m[3]}` });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: 'دستور نامعتبر.', reply_markup: backKeyboard() });
      return;
    }

    if (owner && text === '⏰ شیفت‌ها') {
      const { date } = tehranNow();
      const all = (await db.select().from(shifts).all()) || [];
      const today = all.filter((s) => s.shiftDate === date && s.status === 'active');
      let t = `⏰ شیفت‌های امروز (${date})\n\n`;
      if (!today.length) t += 'خالی';
      for (const s of today) {
        t += `• ${s.channelKey} | ${s.startHm}–${s.endHm} | admin ${s.adminId}\n`;
      }
      await api.sendMessage({ chat_id: chatId, text: t, reply_markup: ownerKeyboard() });
      return;
    }

    if (owner && text === '📊 آمار') {
      const all = (await db.select().from(messages).all()) || [];
      const pe = all.filter((m) => m.status === 'pending').length;
      const ap = all.filter((m) => m.status === 'approved').length;
      const rj = all.filter((m) => m.status === 'rejected').length;
      const us = (await db.select().from(users).all()) || [];
      let by = '';
      for (const c of await getChannels()) {
        by += `• ${c.title}: ${all.filter((m) => m.channelKey === c.key).length}\n`;
      }
      await api.sendMessage({
        chat_id: chatId,
        text: `📊 آمار\n\nکل: ${all.length}\n🟡${pe} 🟢${ap} 🔴${rj}\n👥 کاربران: ${us.length}\n\n${by}`,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    if (owner && text === '📬 پیام کاربران') {
      const list =
        (await db
          .select()
          .from(feedback)
          .where(eq(feedback.status, 'open'))
          .orderBy(desc(feedback.id))
          .all()) || [];
      if (!list.length) {
        await api.sendMessage({ chat_id: chatId, text: 'فیدبک بازی نیست.', reply_markup: ownerKeyboard() });
        return;
      }
      for (const row of list.slice(0, 20)) {
        await api.sendMessage({
          chat_id: chatId,
          text: `فیدبک #${row.id}\nاز: ${row.userId}\n\n${row.content}`,
          reply_markup: feedbackInline(row.id),
        });
      }
      return;
    }

    if (owner && text === '🔍 جستجو') {
      await setState(userId, 'search');
      await api.sendMessage({
        chat_id: chatId,
        text: 'بفرست:\n`msg 123` جستجوی پیام\n`user 123` جستجوی کاربر',
        reply_markup: backKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }

    if (owner && state?.kind === 'search' && text) {
      let m;
      if ((m = text.match(/^msg\s+(\d+)$/i))) {
        const rows = await db.select().from(messages).where(eq(messages.id, Number(m[1]))).all();
        await clearState(userId);
        if (!rows?.length) {
          await api.sendMessage({ chat_id: chatId, text: 'پیدا نشد', reply_markup: ownerKeyboard() });
          return;
        }
        const row = rows[0];
        await api.sendMessage({
          chat_id: chatId,
          text: `#${row.id} | ${row.status} | ${row.channelKey}\nuser: ${row.userId}\n\n${row.content}`,
          reply_markup: row.status === 'pending' ? reviewInline(row.id) : ownerKeyboard(),
        });
        return;
      }
      if ((m = text.match(/^user\s+(\d+)$/i))) {
        const id = Number(m[1]);
        const uu = await getUser(id);
        const ms = (await db.select().from(messages).where(eq(messages.userId, id)).all()) || [];
        await clearState(userId);
        await api.sendMessage({
          chat_id: chatId,
          text: `👤 ${fmtUser(uu, id)}\nنقش: ${uu?.role || '?'}\nبن: ${uu?.blocked ? 'بله' : 'خیر'}\nپیام‌ها: ${ms.length}`,
          reply_markup: ownerKeyboard(),
          parse_mode: 'Markdown',
        });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: 'فرمت: msg 1 یا user 1', reply_markup: backKeyboard() });
      return;
    }

    if (owner && text === '📣 اطلاعیه') {
      await setState(userId, 'announce');
      await api.sendMessage({
        chat_id: chatId,
        text: 'متن اطلاعیه را بفرست.\nاولین خط: `all` یا `admins`\nبقیه: متن',
        reply_markup: backKeyboard(),
      });
      return;
    }

    if (owner && state?.kind === 'announce' && text) {
      const lines = text.split('\n');
      const target = (lines[0] || '').trim().toLowerCase();
      const body = lines.slice(1).join('\n').trim() || text;
      await clearState(userId);
      let ids = [];
      if (target === 'admins') {
        const allAd = [];
        for (const c of await getChannels()) {
          for (const a of await listAdminsByChannel(c.key)) allAd.push(a.userId);
        }
        ids = [...new Set([...allAd, ...OWNER_IDS])];
      } else {
        ids = ((await db.select().from(users).all()) || []).filter((x) => !x.blocked).map((x) => x.userId);
      }
      let ok = 0;
      for (const id of ids) {
        try {
          await api.sendMessage({ chat_id: id, text: body });
          ok++;
        } catch (_) {}
      }
      await api.sendMessage({ chat_id: chatId, text: `ارسال شد: ${ok}/${ids.length}`, reply_markup: ownerKeyboard() });
      return;
    }

    if (owner && text === '⚙️ تنظیمات') {
      const on = await isBotOn();
      await setState(userId, 'settings');
      await api.sendMessage({
        chat_id: chatId,
        text:
          `⚙️ تنظیمات\nربات: ${on ? '🟢 روشن' : '🔴 خاموش'}\n\n` +
          '`bot on` / `bot off`\n' +
          '`clear queue` پاک‌سازی صف (با تأیید yes)',
        reply_markup: backKeyboard(),
        parse_mode: 'Markdown',
      });
      return;
    }

    if (owner && state?.kind === 'settings' && text) {
      if (/^bot on$/i.test(text)) {
        await settingSet('bot_enabled', '1');
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: '🟢 روشن', reply_markup: ownerKeyboard() });
        return;
      }
      if (/^bot off$/i.test(text)) {
        await settingSet('bot_enabled', '0');
        await clearState(userId);
        await api.sendMessage({ chat_id: chatId, text: '🔴 خاموش', reply_markup: ownerKeyboard() });
        return;
      }
      if (/^clear queue$/i.test(text)) {
        await setState(userId, 'clear_q');
        await api.sendMessage({ chat_id: chatId, text: 'تأیید: yes', reply_markup: backKeyboard() });
        return;
      }
      await api.sendMessage({ chat_id: chatId, text: 'دستور نامعتبر', reply_markup: backKeyboard() });
      return;
    }

    if (owner && state?.kind === 'clear_q' && text.toLowerCase() === 'yes') {
      const pend = (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
      for (const row of pend) {
        await db
          .update(messages)
          .set({ status: 'rejected', rejectReason: 'پاک‌سازی صف' })
          .where(eq(messages.id, row.id))
          .run();
        try {
          await api.sendMessage({
            chat_id: row.userId,
            text: `پیام #${row.id} از صف حذف شد (پاک‌سازی مدیریت).`,
          });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({
        chat_id: chatId,
        text: `🧹 ${pend.length} پیام پاک شد`,
        reply_markup: ownerKeyboard(),
      });
      return;
    }

    // fb reply state
    if (owner && state?.kind === 'fb_reply' && text) {
      const rows = await db.select().from(feedback).where(eq(feedback.id, state.feedbackId)).all();
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
            text: `💬 پاسخ مدیریت:\n\n${text}\n\nبا تشکر — مجموعه آرال`,
          });
        } catch (_) {}
      }
      await clearState(userId);
      await api.sendMessage({ chat_id: chatId, text: '✅ پاسخ ارسال شد', reply_markup: ownerKeyboard() });
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
        await api.sendMessage({ chat_id: message.chat.id, text: '⚠️ خطا. /start' });
      }
    } catch (_) {}
  }
}
