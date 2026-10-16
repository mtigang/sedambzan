import { table, integer } from 'sdk/db';
// schema-rev: 2026-10-16-min-diag
// فقط یک جدول تست — اگر این هم fail شود مشکل از خود دیتابیس پلتفرم است

export const counters = table('diag_counters', {
  chatId: integer('chat_id').primaryKey(),
  seen: integer('seen').notNull().default(0),
});
