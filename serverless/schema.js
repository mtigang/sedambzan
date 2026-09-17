/**
 * اسکیمای دیتابیس داخلی Telegram Serverless
 * بعد از push با: npx tgcloud migrate
 */
import { table, integer, text, sql } from 'sdk/db';

export const users = table('users', {
  userId: integer('user_id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role').notNull().default('user'), // user | admin | owner
  started: integer('started').notNull().default(1),
  blocked: integer('blocked').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const messages = table('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  channelKey: text('channel_key').notNull().default('sadambazan'),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  rejectReason: text('reject_reason'),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
});

export const feedback = table('feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('open'), // open | replied | closed
  ownerReply: text('owner_reply'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});
