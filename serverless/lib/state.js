import { db } from 'sdk';
import { settings } from 'schema';
import { eq } from 'sdk/db';

const k = (uid) => 'state:' + uid;

export async function setState(userId, kind, extra = {}) {
  const payload = JSON.stringify({ kind, ...extra, ts: Date.now() });
  const key = k(userId);
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, key)).all();
    if (rows && rows.length) {
      await db.update(settings).set({ value: payload }).where(eq(settings.key, key)).run();
    } else {
      await db.insert(settings).values({ key, value: payload }).run();
    }
  } catch (e) {
    console.error('setState', e);
    const msg = e && (e.message || e.description) ? (e.message || e.description) : String(e);
    if (String(msg).includes('no such table')) {
      throw new Error('جدول settings وجود ندارد. روی سرور بزن: npx tgcloud migrate');
    }
    throw e;
  }
}

export async function getState(userId) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, k(userId))).all();
    if (!rows || !rows[0] || !rows[0].value) return null;
    try {
      return JSON.parse(rows[0].value);
    } catch (_e) {
      return null;
    }
  } catch (e) {
    console.error('getState', e);
    return null;
  }
}

export async function clearState(userId) {
  try {
    await db.delete(settings).where(eq(settings.key, k(userId))).run();
  } catch (e) {
    console.error('clearState', e);
  }
}
