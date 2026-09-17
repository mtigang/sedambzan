import { db } from 'sdk';
import { users } from 'schema';
import { eq } from 'sdk/db';
import { OWNER_IDS } from 'lib/config';

export function isOwner(userId) {
  return OWNER_IDS.map(Number).includes(Number(userId));
}

export async function upsertUser(from) {
  if (!from || !from.id) return;
  const role = isOwner(from.id) ? 'owner' : 'user';
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.userId, from.id))
    .all();
  if (existing && existing.length) {
    await db
      .update(users)
      .set({
        username: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        lastSeen: new Date(),
        role: isOwner(from.id) ? 'owner' : existing[0].role || 'user',
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
      role,
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
