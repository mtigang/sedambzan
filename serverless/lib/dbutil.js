import { api, db } from 'sdk';
import { channels, channelAdmins, shifts, settings, users, messages } from 'schema';
import { eq, and } from 'sdk/db';
import {
  DEFAULT_CHANNELS,
  OWNER_IDS,
  CHANNEL_IDS,
  ADMIN_GROUP_IDS,
} from 'lib/config';
import { tehranNow, inRange, periodDateStr } from 'lib/time';

export async function ensureChannelsSeeded() {
  try {
    const rows = await db.select().from(channels).all();
    if (rows && rows.length >= 3) return rows;
    for (const c of Object.values(DEFAULT_CHANNELS)) {
      try {
        const exist = await db.select().from(channels).where(eq(channels.key, c.key)).all();
        if (exist?.length) {
          await db
            .update(channels)
            .set({
              title: c.title,
              link: String(c.chatId),
              enabled: 1,
              workStart: c.workStart,
              workEnd: c.workEnd,
            })
            .where(eq(channels.key, c.key))
            .run();
        } else {
          await db
            .insert(channels)
            .values({
              key: c.key,
              title: c.title,
              link: String(c.chatId),
              enabled: 1,
              workStart: c.workStart,
              workEnd: c.workEnd,
            })
            .run();
        }
      } catch (e) {
        console.error('seed', c.key, e);
      }
    }
    return (await db.select().from(channels).all()) || [];
  } catch (e) {
    console.error('ensureChannelsSeeded', e);
    return Object.values(DEFAULT_CHANNELS).map((c) => ({
      key: c.key,
      title: c.title,
      link: String(c.chatId),
      enabled: 1,
      workStart: c.workStart,
      workEnd: c.workEnd,
    }));
  }
}

export async function getChannels() {
  return (await ensureChannelsSeeded()) || [];
}

export async function getChannel(key) {
  try {
    const rows = await db.select().from(channels).where(eq(channels.key, key)).all();
    if (rows?.[0]) {
      const r = rows[0];
      return {
        ...r,
        chatId: CHANNEL_IDS[key] || Number(r.link) || null,
        adminGroupId: ADMIN_GROUP_IDS[key] || null,
      };
    }
  } catch (e) {
    console.error('getChannel', e);
  }
  const d = DEFAULT_CHANNELS[key];
  if (!d) return null;
  return {
    key: d.key,
    title: d.title,
    link: String(d.chatId),
    enabled: 1,
    workStart: d.workStart,
    workEnd: d.workEnd,
    chatId: d.chatId,
    adminGroupId: d.adminGroupId,
  };
}

export async function settingGet(key, def = null) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    return rows?.[0]?.value ?? def;
  } catch (_) {
    return def;
  }
}

export async function settingSet(key, value) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    if (rows?.length) {
      await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key)).run();
    } else {
      await db.insert(settings).values({ key, value: String(value) }).run();
    }
  } catch (e) {
    console.error('settingSet', e);
  }
}

export async function isBotOn() {
  return (await settingGet('bot_enabled', '1')) !== '0';
}

export function isOwner(id) {
  return OWNER_IDS.map(Number).includes(Number(id));
}

export async function upsertUser(from) {
  if (!from?.id) return;
  try {
    const existing = await db.select().from(users).where(eq(users.userId, from.id)).all();
    if (existing?.length) {
      const role = isOwner(from.id) ? 'owner' : existing[0].role;
      await db
        .update(users)
        .set({
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
          lastSeen: new Date(),
          role,
        })
        .where(eq(users.userId, from.id))
        .run();
    } else {
      await db
        .insert(users)
        .values({
          userId: from.id,
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
          role: isOwner(from.id) ? 'owner' : 'user',
        })
        .run();
    }
  } catch (e) {
    console.error('upsertUser', e);
  }
}

export async function getUser(id) {
  try {
    const rows = await db.select().from(users).where(eq(users.userId, id)).all();
    return rows?.[0] || null;
  } catch (_) {
    return null;
  }
}

export function displayName(u, id) {
  if (!u) return String(id);
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ');
  if (n) return n;
  if (u.username) return '@' + u.username;
  return String(u.userId || id);
}

export async function getRole(id) {
  if (isOwner(id)) return 'owner';
  try {
    const u = await getUser(id);
    if (u?.role === 'admin') return 'admin';
    const ca = await db.select().from(channelAdmins).where(eq(channelAdmins.userId, id)).all();
    if (ca?.length) return 'admin';
  } catch (_) {}
  return 'user';
}

export async function adminChannels(userId) {
  try {
    const rows = await db
      .select()
      .from(channelAdmins)
      .where(eq(channelAdmins.userId, userId))
      .all();
    return (rows || []).map((r) => r.channelKey);
  } catch (_) {
    return [];
  }
}

export async function addChannelAdmin(userId, channelKey) {
  if (isOwner(userId)) return;
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    const exists = all.some(
      (r) =>
        Number(r.userId ?? r.user_id) === Number(userId) &&
        (r.channelKey === channelKey || r.channel_key === channelKey)
    );
    if (exists) return;
    await db.insert(channelAdmins).values({ userId: Number(userId), channelKey }).run();
  } catch (e) {
    console.error('addChannelAdmin insert', e);
    // retry once
    try {
      await db.insert(channelAdmins).values({ userId: Number(userId), channelKey }).run();
    } catch (e2) {
      console.error('addChannelAdmin retry', e2);
      return;
    }
  }
  try {
    const u = await getUser(userId);
    if (u) {
      if (u.role !== 'owner' && u.role !== 'admin') {
        await db.update(users).set({ role: 'admin' }).where(eq(users.userId, userId)).run();
      }
    } else {
      await db.insert(users).values({ userId: Number(userId), role: 'admin', started: 0 }).run();
    }
  } catch (e) {
    console.error('addChannelAdmin role', e);
  }
}

export async function removeChannelAdmin(userId, channelKey) {
  try {
    await db
      .delete(channelAdmins)
      .where(and(eq(channelAdmins.userId, userId), eq(channelAdmins.channelKey, channelKey)))
      .run();
    const left = await adminChannels(userId);
    if (!left.length) {
      const u = await getUser(userId);
      if (u && u.role === 'admin') {
        await db.update(users).set({ role: 'user' }).where(eq(users.userId, userId)).run();
      }
    }
  } catch (e) {
    console.error('removeChannelAdmin', e);
  }
}

export async function listAdminsByChannel(channelKey) {
  try {
    const all = (await db.select().from(channelAdmins).all()) || [];
    const rows = all.filter((r) => r.channelKey === channelKey || r.channel_key === channelKey);
    const out = [];
    for (const r of rows) {
      const uid = r.userId ?? r.user_id;
      if (!uid) continue;
      let u = null;
      try { u = await getUser(uid); } catch (_) {}
      out.push({ userId: uid, display: displayName(u, uid), user: u });
    }
    return out;
  } catch (e) {
    console.error('listAdminsByChannel', channelKey, e);
    return [];
  }
}

/** همگام‌سازی از گروه ادمین — getChatAdministrators + ثبت */
export async function syncAdminsFromGroup(channelKey) {
  const groupId = ADMIN_GROUP_IDS[channelKey];
  if (!groupId) return { ok: false, error: 'no group', added: 0 };

  let added = 0;
  try {
    const admins = await api.getChatAdministrators({ chat_id: groupId });
    for (const a of admins || []) {
      const uid = a.user?.id;
      if (!uid || a.user?.is_bot) continue;
      if (isOwner(uid)) continue;
      try {
        await upsertUser(a.user);
        await addChannelAdmin(uid, channelKey);
        added++;
      } catch (e) {
        console.error('sync admin one', uid, e);
      }
    }
    return { ok: true, added, total: (admins || []).length };
  } catch (e) {
    console.error('getChatAdministrators', channelKey, e);
    return {
      ok: false,
      error: e?.description || String(e),
      added: 0,
    };
  }
}

export async function syncAllAdminGroups(force = false) {
  if (!force) {
    const last = Number(await settingGet('last_admin_sync', '0')) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return null;
  }
  const results = {};
  for (const key of Object.keys(ADMIN_GROUP_IDS)) {
    results[key] = await syncAdminsFromGroup(key);
  }
  await settingSet('last_admin_sync', String(Date.now()));
  return results;
}

export async function activeShiftAdmins(channelKey) {
  try {
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const rows =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
        .all()) || [];
    return rows
      .filter((s) => {
        if (s.shiftDate === 'perm') return inRange(now.hm, s.startHm, s.endHm);
        if (s.shiftDate !== pdate) return false;
        return inRange(now.hm, s.startHm, s.endHm);
      })
      .map((s) => s.adminId);
  } catch (e) {
    console.error('activeShiftAdmins', e);
    return [];
  }
}

/**
 * اطلاع‌رسانی: فقط ادمین‌های شیفت فعال کانال.
 * اگر شیفت نبود → فقط در صف می‌ماند (مالک مستقیم نمی‌گیرد مگر صف را باز کند).
 * delivered flag در settings: delivered:{msgId}:{adminId}
 */
export async function notifyShiftAdmins(channelKey, text, replyMarkup, msgId) {
  const onShift = await activeShiftAdmins(channelKey);
  const sent = [];
  for (const id of onShift) {
    if (isOwner(id)) continue; // مالک فقط از صف
    try {
      const flag = 'delivered:' + msgId + ':' + id;
      if ((await settingGet(flag, '')) === '1') continue;
      await api.sendMessage({ chat_id: id, text, reply_markup: replyMarkup });
      await settingSet(flag, '1');
      sent.push(id);
    } catch (e) {
      console.error('notifyShift', id, e);
    }
  }
  return sent;
}

/** وقتی شیفت ادمین شروع می‌شود / یا هر تعامل: صف کانال‌هایش را تحویل بده */
export async function deliverPendingForAdmin(adminId) {
  const keys = await adminChannels(adminId);
  if (!keys.length) return 0;
  const now = tehranNow();
  const period = periodDateStr(now);
  const allShifts = (await db.select().from(shifts).where(eq(shifts.adminId, adminId)).all()) || [];
  const activeKeys = allShifts
    .filter((s) => {
      if (s.status !== 'active') return false;
      if (s.shiftDate === 'permanent' || s.shiftDate === 'perm') {
        return inRange(now.hm, s.startHm, s.endHm);
      }
      if (s.shiftDate !== period && s.shiftDate !== now.date) return false;
      return inRange(now.hm, s.startHm, s.endHm);
    })
    .map((s) => s.channelKey);
  if (!activeKeys.length) return 0;

  const pending =
    (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
  let n = 0;
  for (const row of pending) {
    if (!activeKeys.includes(row.channelKey)) continue;
    const flag = 'delivered:' + row.id + ':' + adminId;
    if ((await settingGet(flag, '')) === '1') continue;
    try {
      const ch = await getChannel(row.channelKey);
      await api.sendMessage({
        chat_id: adminId,
        text:
          '📨 #' +
          row.id +
          ' | ' +
          (ch?.title || row.channelKey) +
          '\nاز: ' +
          row.userId +
          '\n\n' +
          row.content,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🟢 تأیید', callback_data: 'approve:' + row.id, style: 'success' },
              { text: '🔴 رد', callback_data: 'reject_menu:' + row.id, style: 'danger' },
            ],
          ],
        },
      });
      await settingSet(flag, '1');
      n++;
    } catch (e) {
      console.error('deliver', row.id, e);
    }
  }
  return n;
}

export async function pendingForViewer(userId) {
  try {
    const role = await getRole(userId);
    if (role === 'owner' || isOwner(userId)) {
      const all = (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
      return all.sort((a, b) => b.id - a.id);
    }
    const now = tehranNow();
    const pdate = periodDateStr(now);
    const mySh =
      (await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.adminId, userId), eq(shifts.status, 'active')))
        .all()) || [];
    const activeKeys = [
      ...new Set(
        mySh
          .filter((s) => {
            if (s.shiftDate === 'perm' || s.shiftDate === 'permanent') {
              return inRange(now.hm, s.startHm, s.endHm);
            }
            if (s.shiftDate !== pdate) return false;
            return inRange(now.hm, s.startHm, s.endHm);
          })
          .map((s) => s.channelKey)
      ),
    ];
    if (!activeKeys.length) return [];
    const all = (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
    return all.filter((m) => activeKeys.includes(m.channelKey)).sort((a, b) => b.id - a.id);
  } catch (e) {
    console.error('pendingForViewer', e);
    return [];
  }
}

export async function testChannels() {
  const results = [];
  for (const [key, conf] of Object.entries(DEFAULT_CHANNELS)) {
    const chatId = conf.chatId;
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: '🧪 تست ربات آرال — کانال «' + conf.title + '»\nاگر این پیام را می‌بینید، ربات در کانال دسترسی ارسال دارد.',
      });
      results.push({ key, title: conf.title, ok: true, detail: 'ارسال موفق' });
    } catch (e) {
      results.push({
        key,
        title: conf.title,
        ok: false,
        detail: e?.description || String(e),
      });
    }
  }
  return results;
}

export function toBoldHtml(text) {
  const s = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<b>' + s + '</b>';
}

export async function postToChannel(channelKey, text) {
  const conf = DEFAULT_CHANNELS[channelKey];
  if (!conf) throw new Error('channel');
  return await api.sendMessage({
    chat_id: conf.chatId,
    text: toBoldHtml(text),
    parse_mode: 'HTML',
  });
}
