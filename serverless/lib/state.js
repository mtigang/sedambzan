import { db } from 'sdk';
import { settings } from 'schema';
import { eq } from 'sdk/db';

const k = (uid) => `state:${uid}`;

export async function setState(userId, kind, extra = {}) {
  const payload = JSON.stringify({ kind, ...extra, ts: Date.now() });
  const key = k(userId);
  const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
  if (rows?.length) await db.update(settings).set({ value: payload }).where(eq(settings.key, key)).run();
  else await db.insert(settings).values({ key, value: payload }).run();
}

export async function getState(userId) {
  const rows = await db.select().from(settings).where(eq(settings.key, k(userId))).all();
  if (!rows?.[0]?.value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

export async function clearState(userId) {
  await db.delete(settings).where(eq(settings.key, k(userId))).run();
}
