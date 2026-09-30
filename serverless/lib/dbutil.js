import { db } from 'sdk';
import { channels, channelAdmins, shifts, settings, users, messages } from 'schema';
import { eq, and } from 'sdk/db';
import { DEFAULT_CHANNELS, OWNER_IDS } from 'lib/config';
import { tehranNow, inRange } from 'lib/time';

export async function ensureChannelsSeeded() {
  const rows = await db.select().from(channels).all();
  if (rows && rows.length) return rows;
  for (const c of Object.values(DEFAULT_CHANNELS)) {
    await db
      .insert(channels)
      .values({
        key: c.key,
        title: c.title,
        link: c.link || '',
        enabled: 1,
        workStart: c.workStart,
        workEnd: c.workEnd,
      })
      .run();
  }
  return await db.select().from(channels).all();
}

export async function getChannels() {
  return (await ensureChannelsSeeded()) || [];
}

export async function getChannel(key) {
  const rows = await db.select().from(channels).where(eq(channels.key, key)).all();
  return rows?.[0] || null;
}

export async function settingGet(key, def = null) {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  return rows?.[0]?.value ?? def;
}

export async function settingSet(key, value) {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  if (rows?.length) {
    await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key)).run();
  } else {
    await db.insert(settings).values({ key, value: String(value) }).run();
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
}

export async function getUser(id) {
  const rows = await db.select().from(users).where(eq(users.userId, id)).all();
  return rows?.[0] || null;
}

export async function getRole(id) {
  if (isOwner(id)) return 'owner';
  const u = await getUser(id);
  if (u?.role === 'admin') return 'admin';
  // اگر در channel_admins باشد هم ادمین است
  const ca = await db.select().from(channelAdmins).where(eq(channelAdmins.userId, id)).all();
  if (ca?.length) return 'admin';
  return 'user';
}

export async function adminChannels(userId) {
  const rows = await db
    .select()
    .from(channelAdmins)
    .where(eq(channelAdmins.userId, userId))
    .all();
  return (rows || []).map((r) => r.channelKey);
}

export async function addChannelAdmin(userId, channelKey) {
  const exist = await db
    .select()
    .from(channelAdmins)
    .where(and(eq(channelAdmins.userId, userId), eq(channelAdmins.channelKey, channelKey)))
    .all();
  if (exist?.length) return;
  await db.insert(channelAdmins).values({ userId, channelKey }).run();
  const u = await getUser(userId);
  if (u) {
    if (u.role !== 'owner') {
      await db.update(users).set({ role: 'admin' }).where(eq(users.userId, userId)).run();
    }
  } else {
    await db.insert(users).values({ userId, role: 'admin', started: 0 }).run();
  }
}

export async function removeChannelAdmin(userId, channelKey) {
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
}

export async function listAdminsByChannel(channelKey) {
  return (
    (await db
      .select()
      .from(channelAdmins)
      .where(eq(channelAdmins.channelKey, channelKey))
      .all()) || []
  );
}

/** ادمین‌های شیفت فعال همین الان برای یک کانال */
export async function activeShiftAdmins(channelKey) {
  const { date, hm } = tehranNow();
  const rows =
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
  return rows.filter((s) => inRange(hm, s.startHm, s.endHm)).map((s) => s.adminId);
}

export async function notifyReviewers(channelKey, text, replyMarkup) {
  const owners = OWNER_IDS;
  const onShift = await activeShiftAdmins(channelKey);
  const channelAdms = (await listAdminsByChannel(channelKey)).map((a) => a.userId);
  // اولویت: شیفت فعال؛ اگر کسی نبود → همه ادمین‌های کانال + مالک
  const targets = onShift.length
    ? [...new Set([...onShift, ...owners])]
    : [...new Set([...channelAdms, ...owners])];
  for (const id of targets) {
    try {
      await (await import('sdk')).api.sendMessage({
        chat_id: id,
        text,
        reply_markup: replyMarkup,
      });
    } catch (_) {}
  }
  return targets;
}

export async function pendingForAdmin(userId) {
  const role = await getRole(userId);
  let keys = [];
  if (role === 'owner') {
    keys = (await getChannels()).map((c) => c.key);
  } else {
    keys = await adminChannels(userId);
  }
  const all = (await db.select().from(messages).where(eq(messages.status, 'pending')).all()) || [];
  return all.filter((m) => keys.includes(m.channelKey)).sort((a, b) => b.id - a.id);
}
