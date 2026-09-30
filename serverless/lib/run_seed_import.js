import { db, api } from 'sdk';
import { users, settings } from 'schema';
import { eq } from 'sdk/db';
import {
  USER_CHUNKS,
  loadUserChunk,
  loadSettings,
} from 'lib/seed/index';
import { OWNER_IDS } from 'lib/config';

/**
 * یک‌بار از CLI:
 *   npx tgcloud run handlers/seed_import
 * یا با chatId برای گزارش:
 *   npx tgcloud run handlers/seed_import '{ notifyChatId: 123 }'
 */
export default async function seedImport(args = {}) {
  const notify = args?.notifyChatId || OWNER_IDS[0];
  const log = async (text) => {
    console.log(text);
    if (notify) {
      try {
        await api.sendMessage({ chat_id: notify, text: String(text).slice(0, 3500) });
      } catch (e) {
        console.error('notify', e);
      }
    }
  };

  await log('📦 شروع بازیابی کاربران — بخش‌ها: ' + USER_CHUNKS);

  let uOk = 0;
  let uSkip = 0;
  let uFail = 0;

  for (let i = 0; i < USER_CHUNKS; i++) {
    const rows = loadUserChunk(i) || [];
    let ok = 0;
    let skip = 0;
    let fail = 0;
    for (const r of rows) {
      try {
        const exist = await db.select().from(users).where(eq(users.userId, r.userId)).all();
        if (exist && exist.length) {
          skip++;
          continue;
        }
        await db
          .insert(users)
          .values({
            userId: r.userId,
            username: r.username || null,
            firstName: r.firstName || null,
            lastName: r.lastName || null,
            role: 'user',
            started: r.started ? 1 : 0,
            blocked: r.blocked ? 1 : 0,
          })
          .run();
        ok++;
      } catch (e) {
        fail++;
        console.error('user', r.userId, e);
      }
    }
    uOk += ok;
    uSkip += skip;
    uFail += fail;
    await log(
      '👤 بخش ' +
        (i + 1) +
        '/' +
        USER_CHUNKS +
        ' — جدید: ' +
        ok +
        ' | تکراری: ' +
        skip +
        ' | خطا: ' +
        fail
    );
  }

  try {
    const st = loadSettings() || [];
    for (const r of st) {
      const exist = await db.select().from(settings).where(eq(settings.key, r.key)).all();
      if (exist && exist.length) {
        await db.update(settings).set({ value: r.value }).where(eq(settings.key, r.key)).run();
      } else {
        await db.insert(settings).values({ key: r.key, value: r.value }).run();
      }
    }
  } catch (e) {
    console.error('settings', e);
  }

  await log(
    '✅ تمام\nکاربران جدید: ' + uOk + '\nتکراری: ' + uSkip + '\nخطا: ' + uFail
  );
  return { uOk, uSkip, uFail };
}
