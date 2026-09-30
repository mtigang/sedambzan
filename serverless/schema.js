import { table, integer, text, sql } from 'sdk/db';

export const users = table('users', {
  userId: integer('user_id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role').notNull().default('user'), // user | admin | owner
  blocked: integer('blocked').notNull().default(0),
  started: integer('started').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

/** ادمین هر کانال جدا */
export const channelAdmins = table('channel_admins', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  channelKey: text('channel_key').notNull(),
});

/** تنظیمات هر کانال */
export const channels = table('channels', {
  key: text('key').primaryKey(),
  title: text('title').notNull(),
  link: text('link'),
  enabled: integer('enabled').notNull().default(1),
  workStart: text('work_start').default('00:00'),
  workEnd: text('work_end').default('23:59'),
});

/** شیفت ادمین */
export const shifts = table('shifts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelKey: text('channel_key').notNull(),
  adminId: integer('admin_id').notNull(),
  shiftDate: text('shift_date').notNull(), // YYYY-MM-DD (تهران)
  startHm: text('start_hm').notNull(), // HH:MM
  endHm: text('end_hm').notNull(),
  status: text('status').notNull().default('active'), // active | cancelled
});

export const messages = table('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  channelKey: text('channel_key').notNull(),
  status: text('status').notNull().default('pending'),
  rejectReason: text('reject_reason'),
  reviewedBy: integer('reviewed_by'),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
});

export const feedback = table('feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('open'),
  ownerReply: text('owner_reply'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});
