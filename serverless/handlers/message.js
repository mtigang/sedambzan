import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { counters } from 'schema';

const OWNERS = [6666610646, 8434360251, 8667282502];

export default async function (message) {
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  const text = String(message?.text || '').trim();
  if (!chatId) return;

  console.log('diag hit', { chatId, fromId, text });

  if (text === '/dbinfo' || text === '/start' || text === '/dbtest') {
    const lines = ['🛠 diag'];
    // try migrate-equivalent create via insert
    try {
      const [row] = await db
        .insert(counters)
        .values({ chatId: Number(chatId), seen: 1 })
        .onConflictDoUpdate({
          target: counters.chatId,
          set: { seen: sql`${counters.seen} + 1` },
        })
        .returning()
        .run();
      lines.push('insert/upsert OK seen=' + (row && row.seen));
    } catch (e) {
      lines.push('insert ERR: ' + String(e && e.message ? e.message : e).slice(0, 200));
    }
    try {
      const rows = await db.select().from(counters).all();
      lines.push('select OK rows=' + (rows ? rows.length : 0));
    } catch (e) {
      lines.push('select ERR: ' + String(e && e.message ? e.message : e).slice(0, 200));
    }
    // raw attempts
    for (const label of ['db.run', 'db.all', 'db.get']) {
      try {
        const fn = db[label.split('.')[1]];
        if (typeof fn !== 'function') {
          lines.push(label + ': not a function');
          continue;
        }
      } catch (e) {
        lines.push(label + ': ' + String(e.message || e).slice(0, 80));
      }
    }
    try {
      lines.push('db keys: ' + Object.keys(db || {}).slice(0, 20).join(','));
    } catch (_e) {}
    await api.sendMessage({ chat_id: chatId, text: lines.join('\n') });
    return;
  }

  await api.sendMessage({
    chat_id: chatId,
    text: 'حالت تشخیص DB فعال است. /start یا /dbinfo بزنید.\n(ربات کامل موقتاً برای تست دیتابیس ساده شده)',
  });
}
