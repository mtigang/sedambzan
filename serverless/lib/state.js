/**
 * state ساده در حافظهٔ isolate — برای Serverless ماندگار نیست؛
 * برای state پایدار از جدول settings/users استفاده کنید.
 * اینجا فقط برای فلو کوتاه ارسال پیام در یک invocation کافی نیست،
 * پس state را در settings با کلید user:{id}:state نگه می‌داریم.
 */
import { db } from 'sdk';
import { settings } from 'schema';
import { eq } from 'sdk/db';

function keyFor(userId) {
  return `state:${userId}`;
}

export async function setState(userId, kind, extra = {}) {
  const payload = JSON.stringify({ kind, ...extra, ts: Date.now() });
  const k = keyFor(userId);
  const existing = await db.select().from(settings).where(eq(settings.key, k)).run();
  if (existing && existing.length) {
    await db.update(settings).set({ value: payload }).where(eq(settings.key, k)).run();
  } else {
    await db.insert(settings).values({ key: k, value: payload }).run();
  }
}

export async function getState(userId) {
  const k = keyFor(userId);
  const rows = await db.select().from(settings).where(eq(settings.key, k)).run();
  if (!rows || !rows.length || !rows[0].value) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

export async function clearState(userId) {
  const k = keyFor(userId);
  await db.delete(settings).where(eq(settings.key, k)).run();
}
