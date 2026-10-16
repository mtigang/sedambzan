import { db } from 'sdk';
import { settings } from 'schema';
import { eq } from 'sdk/db';

const k = (uid) => 'state:' + uid;
const STATE_TTL_MS = 30 * 60 * 1000;

function errText(e) {
  return String((e && (e.message || e.description)) || e || 'Sqlite error');
}

export async function setState(userId, kind, extra = {}) {
  const payload = JSON.stringify({ kind, ...extra, ts: Date.now() });
  const key = k(userId);
  // upsert مقاوم: insert بعد update
  try {
    try {
      await db.insert(settings).values({ key, value: payload }).run();
      return;
    } catch (_ins) {
      await db.update(settings).set({ value: payload }).where(eq(settings.key, key)).run();
      return;
    }
  } catch (e) {
    console.error('setState', e);
    const msg = errText(e);
    if (/no such table/i.test(msg)) {
      throw new Error('جدول settings نیست. در پوشه serverless بزنید: npx tgcloud migrate');
    }
    // یک‌بار دیگر فقط update
    try {
      await db.update(settings).set({ value: payload }).where(eq(settings.key, key)).run();
      return;
    } catch (e2) {
      throw new Error('Sqlite: ' + errText(e2).slice(0, 180));
    }
  }
}

export async function getState(userId) {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, k(userId))).all();
    if (!rows || !rows[0] || !rows[0].value) return null;
    try {
      const parsed = JSON.parse(rows[0].value);
      if (parsed && parsed.ts && Date.now() - Number(parsed.ts) > STATE_TTL_MS) {
        try {
          await db.delete(settings).where(eq(settings.key, k(userId))).run();
        } catch (_e) {}
        return null;
      }
      return parsed;
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
