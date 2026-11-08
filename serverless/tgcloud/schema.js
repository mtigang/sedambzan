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

/** ساب‌لیدر — یک کانال به ازای هر کاربر (بدون حذف داده قبلی) */
export const subLeaders = table('sub_leaders', {
  userId: integer('user_id').primaryKey(),
  channelKey: text('channel_key').notNull(),
  status: text('status').notNull().default('active'), // active | inactive
  createdBy: integer('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});


/** تنظیمات دریافت پیام ناشناس */
export const anonymousSettings = table('anonymous_settings', {
  userId: integer('user_id').primaryKey(),
  receiveEnabled: integer('receive_enabled').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

/** گفت‌وگوی ناشناس دوطرفه */
export const anonymousConversations = table('anonymous_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userAId: integer('user_a_id').notNull(),
  userBId: integer('user_b_id').notNull(),
  status: text('status').notNull().default('active'),
  currentSenderId: integer('current_sender_id'),
  messagesInTurn: integer('messages_in_turn').notNull().default(0),
  turnNumber: integer('turn_number').notNull().default(1),
  deletedByA: integer('deleted_by_a').notNull().default(0),
  deletedByB: integer('deleted_by_b').notNull().default(0),
  lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

/** پیام‌های ناشناس */
export const anonymousMessages = table('anonymous_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull(),
  senderId: integer('sender_id').notNull(),
  receiverId: integer('receiver_id').notNull(),
  messageText: text('message_text').notNull(),
  messageType: text('message_type').notNull().default('text'),
  channelMessageId: integer('channel_message_id'),
  replyToInternalId: integer('reply_to_internal_id'),
  status: text('status').notNull().default('sent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  readAt: integer('read_at', { mode: 'timestamp' }),
});

/** مسدودسازی دوطرفه ناشناس */
export const anonymousBlocks = table('anonymous_blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  blockerId: integer('blocker_id').notNull(),
  blockedId: integer('blocked_id').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});


/** اطلاعیه‌های ذخیره‌محور کاربران عادی */
export const botAnnouncements = table('bot_announcements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  entitiesJson: text('entities_json'),
  status: text('status').notNull().default('draft'),
  eligibleCount: integer('eligible_count').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  failCount: integer('fail_count').notNull().default(0),
  createdBy: integer('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  activatedAt: integer('activated_at', { mode: 'timestamp' }),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
});

/** دریافت اطلاعیه توسط کاربر — یک ردیف به ازای هر جفت */
export const botAnnouncementReceipts = table('bot_announcement_receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  announcementId: integer('announcement_id').notNull(),
  userId: integer('user_id').notNull(),
  status: text('status').notNull().default('delivered'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
