import { db } from 'sdk';
import { users } from 'schema';
import { eq } from 'sdk/db';
import { OWNER_IDS } from 'lib/config';

export function isOwner(userId) {
  return OWNER_IDS.map(Number).includes(Number(userId));
}

export async function upsertUser(from) {
  if (!from || !from.id) return;
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.userId, from.id))
    .all();
  if (existing && existing.length) {
    const keepRole = isOwner(from.id)
      ? 'owner'
      : existing[0].role === 'admin'
        ? 'admin'
        : existing[0].role || 'user';
    await db
      .update(users)
      .set({
        username: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        lastSeen: new Date(),
        role: keepRole,
      })
      .where(eq(users.userId, from.id))
      .run();
    return;
  }
  await db
    .insert(users)
    .values({
      userId: from.id,
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
      role: isOwner(from.id) ? 'owner' : 'user',
      started: 1,
      blocked: 0,
    })
    .run();
}

export async function getUserRole(userId) {
  if (isOwner(userId)) return 'owner';
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.userId, userId))
    .all();
  if (rows && rows[0] && rows[0].role === 'admin') return 'admin';
  return 'user';
}

export async function isAdmin(userId) {
  const role = await getUserRole(userId);
  return role === 'admin' || role === 'owner';
}

export async function listAdmins() {
  const rows = await db.select().from(users).where(eq(users.role, 'admin')).all();
  return rows || [];
}

export async function setAdmin(userId, makeAdmin) {
  const existing = await db.select().from(users).where(eq(users.userId, userId)).all();
  if (existing && existing.length) {
    await db
      .update(users)
      .set({ role: makeAdmin ? 'admin' : 'user' })
      .where(eq(users.userId, userId))
      .run();
  } else {
    await db
      .insert(users)
      .values({
        userId,
        role: makeAdmin ? 'admin' : 'user',
        started: 0,
        blocked: 0,
      })
      .run();
  }
}

export async function setBlocked(userId, blocked) {
  const existing = await db.select().from(users).where(eq(users.userId, userId)).all();
  if (existing && existing.length) {
    await db
      .update(users)
      .set({ blocked: blocked ? 1 : 0 })
      .where(eq(users.userId, userId))
      .run();
  } else {
    await db
      .insert(users)
      .values({ userId, role: 'user', started: 0, blocked: blocked ? 1 : 0 })
      .run();
  }
}

export async function getUser(userId) {
  const rows = await db.select().from(users).where(eq(users.userId, userId)).all();
  return rows && rows[0] ? rows[0] : null;
}
