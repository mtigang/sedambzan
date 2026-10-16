import { table, integer, text } from 'sdk/db';
// schema-rev: 2026-10-16-v2-tables
// جدول‌های *_v2 تا migrate روی «already exists» گیر نکند.
// داده از جدول‌های قدیمی (در صورت وجود) با ensureDbTables کپی می‌شود.

export const users = table('users_v2', {
  userId: integer('user_id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role').notNull().default('user'),
  blocked: integer('blocked').notNull().default(0),
  started: integer('started').notNull().default(1),
  createdAt: integer('created_at'),
  lastSeen: integer('last_seen'),
});

export const channelAdmins = table('channel_admins_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  channelKey: text('channel_key').notNull(),
});

export const channels = table('channels_v2', {
  key: text('ch_key').primaryKey(),
  title: text('title').notNull(),
  link: text('link'),
  enabled: integer('enabled').notNull().default(1),
  workStart: text('work_start').default('00:00'),
  workEnd: text('work_end').default('23:59'),
});

export const shifts = table('shifts_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelKey: text('channel_key').notNull(),
  adminId: integer('admin_id').notNull(),
  shiftDate: text('shift_date').notNull(),
  startHm: text('start_hm').notNull(),
  endHm: text('end_hm').notNull(),
  status: text('status').notNull().default('active'),
});

export const messages = table('messages_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  channelKey: text('channel_key').notNull(),
  status: text('status').notNull().default('pending'),
  rejectReason: text('reject_reason'),
  reviewedBy: integer('reviewed_by'),
  submittedAt: integer('submitted_at'),
  reviewedAt: integer('reviewed_at'),
});

export const feedback = table('feedback_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('open'),
  ownerReply: text('owner_reply'),
  createdAt: integer('created_at'),
});

export const settings = table('settings_v2', {
  key: text('setting_key').primaryKey(),
  value: text('value'),
});

export const subLeaders = table('sub_leaders_v2', {
  userId: integer('user_id').primaryKey(),
  channelKey: text('channel_key').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: integer('created_by'),
  createdAt: integer('created_at'),
});
