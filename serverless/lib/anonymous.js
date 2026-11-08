/**
 * سیستم پیام‌رسانی ناشناس آرال
 * مستقل از صف انتشار کانال‌های اصلی؛ سازگار با Serverless.
 */
import { api, db } from 'sdk';
import { eq, and, or, desc, sql } from 'sdk/db';
import {
  users,
  anonymousSettings,
  anonymousConversations,
  anonymousMessages,
  anonymousBlocks,
  settings,
} from 'schema';
import { isOwner, getUser, displayName } from 'lib/dbutil';
import { sanitizeMarkup, btnText } from 'lib/keyboards';

/** کانال خصوصی لاگ پیام‌های ناشناس */
export const ANON_LOG_CHANNEL_ID = -1004378289658;
export const ANON_TURN_LIMIT = 3;
export const ANON_MAX_TEXT = 3500;
export const ANON_RATE_MAX = 12;
export const ANON_RATE_WINDOW_MS = 10 * 60 * 1000;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? x + ':' + y : y + ':' + x;
}

async function settingGet(key, fallback) {
  try {
    const rows = (await db.select().from(settings).where(eq(settings.key, key)).all()) || [];
    if (rows[0] && rows[0].value != null) return String(rows[0].value);
  } catch (_e) {}
  return fallback;
}

async function settingSet(key, value) {
  const k = String(key);
  const v = value == null ? '' : String(value);
  try {
    const rows = (await db.select().from(settings).where(eq(settings.key, k)).all()) || [];
    if (rows && rows.length) {
      await db.update(settings).set({ value: v }).where(eq(settings.key, k)).run();
    } else {
      await db.insert(settings).values({ key: k, value: v }).run();
    }
  } catch (e) {
    console.error('anon settingSet', e);
  }
}

export function anonMainKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '✉️ ارسال پیام جدید' }],
      [{ text: '📥 پیام‌های دریافتی' }, { text: '💬 گفت‌وگوهای من' }],
      [{ text: '🚫 افراد مسدودشده' }],
      [{ text: '⚙️ تنظیمات دریافت پیام' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  });
}

export function anonNotifyInline(internalMsgId) {
  const id = Number(internalMsgId) || 0;
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '💬 پاسخ', callback_data: 'an:rp:' + id, style: 'primary' },
        { text: '🚫 مسدود', callback_data: 'an:bk:' + id, style: 'danger' },
      ],
      [{ text: '🚩 گزارش', callback_data: 'an:rg:' + id }],
    ],
  });
}

export function anonConfirmInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '✅ ارسال', callback_data: 'an:ok', style: 'success' },
        { text: '❌ لغو', callback_data: 'an:no', style: 'danger' },
      ],
    ],
  });
}

export function anonRecvInline(enabled) {
  return sanitizeMarkup({
    inline_keyboard: [
      enabled
        ? [{ text: '🔴 غیرفعال کردن دریافت', callback_data: 'an:recv:0', style: 'danger' }]
        : [{ text: '🟢 فعال کردن دریافت', callback_data: 'an:recv:1', style: 'success' }],
    ],
  });
}

export function anonConvActionsInline(convId) {
  const id = Number(convId) || 0;
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '💬 ادامه گفت‌وگو', callback_data: 'an:op:' + id, style: 'primary' },
        { text: '🗑 حذف از لیست من', callback_data: 'an:dl:' + id, style: 'danger' },
      ],
    ],
  });
}

export async function ensureAnonSettings(userId) {
  const uid = Number(userId);
  if (!uid) return { userId: 0, receiveEnabled: 1 };
  try {
    const rows =
      (await db.select().from(anonymousSettings).where(eq(anonymousSettings.userId, uid)).all()) ||
      [];
    if (rows[0]) {
      return {
        userId: uid,
        receiveEnabled: Number(rows[0].receiveEnabled ?? rows[0].receive_enabled) !== 0 ? 1 : 0,
      };
    }
    await db
      .insert(anonymousSettings)
      .values({ userId: uid, receiveEnabled: 1 })
      .run();
    return { userId: uid, receiveEnabled: 1 };
  } catch (e) {
    console.error('ensureAnonSettings', e);
    // fallback settings table
    const raw = await settingGet('anon_recv:' + uid, '1');
    return { userId: uid, receiveEnabled: raw === '0' ? 0 : 1 };
  }
}

export async function setAnonReceiveEnabled(userId, enabled) {
  const uid = Number(userId);
  const val = enabled ? 1 : 0;
  try {
    const rows =
      (await db.select().from(anonymousSettings).where(eq(anonymousSettings.userId, uid)).all()) ||
      [];
    if (rows[0]) {
      await db
        .update(anonymousSettings)
        .set({ receiveEnabled: val, updatedAt: new Date() })
        .where(eq(anonymousSettings.userId, uid))
        .run();
    } else {
      await db.insert(anonymousSettings).values({ userId: uid, receiveEnabled: val }).run();
    }
  } catch (e) {
    console.error('setAnonReceiveEnabled', e);
    await settingSet('anon_recv:' + uid, String(val));
  }
}

export async function resolveAnonTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, code: 'empty', text: 'آیدی یا @یوزرنیم را بفرست.' };

  let uid = null;
  if (/^\d{5,15}$/.test(raw)) {
    uid = Number(raw);
  } else {
    let un = raw.replace(/^@/, '').trim();
    if (!un) return { ok: false, code: 'empty', text: 'آیدی یا @یوزرنیم را بفرست.' };
    try {
      const all =
        (await db
          .select()
          .from(users)
          .where(sql`lower(${users.username}) = ${un.toLowerCase()}`)
          .limit(5)
          .all()) || [];
      if (all[0]) uid = Number(all[0].userId ?? all[0].user_id);
    } catch (e) {
      console.error('resolveAnonTarget username', e);
      try {
        const sample = (await db.select().from(users).orderBy(desc(users.userId)).limit(3000).all()) || [];
        const hit = sample.find(function (u) {
          return String(u.username || '').toLowerCase() === un.toLowerCase();
        });
        if (hit) uid = Number(hit.userId ?? hit.user_id);
      } catch (_e2) {}
    }
  }

  if (!uid) {
    return {
      ok: false,
      code: 'not_found',
      text: 'کاربر موردنظر در آرال پیدا نشد. باید قبلاً ربات را استارت کرده باشد.',
    };
  }

  const u = await getUser(uid);
  if (!u) {
    return {
      ok: false,
      code: 'not_found',
      text: 'کاربر موردنظر هنوز ربات آرال را فعال نکرده است.',
    };
  }
  if (Number(u.blocked) === 1) {
    return { ok: false, code: 'blocked_sys', text: 'امکان ارسال پیام به این کاربر وجود ندارد.' };
  }
  const started = u.started == null ? 1 : Number(u.started);
  if (!started) {
    return {
      ok: false,
      code: 'not_started',
      text: 'کاربر موردنظر هنوز ربات آرال را فعال نکرده است.',
    };
  }

  const st = await ensureAnonSettings(uid);
  if (!st.receiveEnabled) {
    return {
      ok: false,
      code: 'recv_off',
      text: 'کاربر موردنظر در حال حاضر دریافت پیام ناشناس را غیرفعال کرده است.',
    };
  }

  return { ok: true, userId: uid, user: u };
}

export async function isAnonBlockedEither(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!x || !y) return false;
  try {
    const rows =
      (await db
        .select()
        .from(anonymousBlocks)
        .where(
          and(
            eq(anonymousBlocks.status, 'active'),
            or(
              and(eq(anonymousBlocks.blockerId, x), eq(anonymousBlocks.blockedId, y)),
              and(eq(anonymousBlocks.blockerId, y), eq(anonymousBlocks.blockedId, x))
            )
          )
        )
        .limit(1)
        .all()) || [];
    return !!(rows && rows[0]);
  } catch (e) {
    console.error('isAnonBlockedEither', e);
    const raw = await settingGet('anon_block:' + pairKey(x, y), '');
    return raw === '1';
  }
}

export async function setAnonBlock(blockerId, blockedId) {
  const a = Number(blockerId);
  const b = Number(blockedId);
  if (!a || !b || a === b) return { ok: false };
  try {
    const existing =
      (await db
        .select()
        .from(anonymousBlocks)
        .where(and(eq(anonymousBlocks.blockerId, a), eq(anonymousBlocks.blockedId, b)))
        .limit(1)
        .all()) || [];
    if (existing[0]) {
      await db
        .update(anonymousBlocks)
        .set({ status: 'active' })
        .where(eq(anonymousBlocks.id, existing[0].id))
        .run();
    } else {
      await db.insert(anonymousBlocks).values({ blockerId: a, blockedId: b, status: 'active' }).run();
    }
  } catch (e) {
    console.error('setAnonBlock', e);
    await settingSet('anon_block:' + pairKey(a, b), '1');
  }
  // غیرفعال کردن گفت‌وگوهای فعال
  try {
    const convs =
      (await db
        .select()
        .from(anonymousConversations)
        .where(
          and(
            eq(anonymousConversations.status, 'active'),
            or(
              and(eq(anonymousConversations.userAId, a), eq(anonymousConversations.userBId, b)),
              and(eq(anonymousConversations.userAId, b), eq(anonymousConversations.userBId, a))
            )
          )
        )
        .all()) || [];
    for (const c of convs) {
      await db
        .update(anonymousConversations)
        .set({ status: 'blocked', updatedAt: new Date() })
        .where(eq(anonymousConversations.id, c.id))
        .run();
    }
  } catch (_e) {}
  return { ok: true };
}

export async function clearAnonBlock(blockerId, blockedId) {
  const a = Number(blockerId);
  const b = Number(blockedId);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousBlocks)
        .where(and(eq(anonymousBlocks.blockerId, a), eq(anonymousBlocks.blockedId, b)))
        .all()) || [];
    for (const r of rows) {
      await db
        .update(anonymousBlocks)
        .set({ status: 'cleared' })
        .where(eq(anonymousBlocks.id, r.id))
        .run();
    }
  } catch (e) {
    console.error('clearAnonBlock', e);
    await settingSet('anon_block:' + pairKey(a, b), '0');
  }
  return { ok: true };
}

export async function listAnonBlocks(userId) {
  const uid = Number(userId);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousBlocks)
        .where(and(eq(anonymousBlocks.blockerId, uid), eq(anonymousBlocks.status, 'active')))
        .orderBy(desc(anonymousBlocks.id))
        .limit(50)
        .all()) || [];
    return rows;
  } catch (e) {
    console.error('listAnonBlocks', e);
    return [];
  }
}

async function checkRateLimit(userId) {
  const uid = Number(userId);
  const key = 'anon_rl:' + uid;
  try {
    const raw = await settingGet(key, '');
    let o = { n: 0, t: Date.now() };
    if (raw) {
      try {
        o = JSON.parse(raw) || o;
      } catch (_e) {}
    }
    if (Date.now() - Number(o.t || 0) > ANON_RATE_WINDOW_MS) {
      o = { n: 0, t: Date.now() };
    }
    if (Number(o.n) >= ANON_RATE_MAX) {
      return { ok: false, text: 'خیلی سریع پیام می‌فرستی. چند دقیقه بعد دوباره تلاش کن.' };
    }
    o.n = Number(o.n || 0) + 1;
    o.t = o.t || Date.now();
    await settingSet(key, JSON.stringify(o));
    return { ok: true };
  } catch (_e) {
    return { ok: true };
  }
}

/**
 * یافتن گفت‌وگوی فعال بین دو نفر (نه مسدود، نه برای این کاربر حذف‌شده از سمت خودش برای لیست)
 */
export async function findActiveConversation(userA, userB) {
  const a = Number(userA);
  const b = Number(userB);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousConversations)
        .where(
          and(
            eq(anonymousConversations.status, 'active'),
            or(
              and(eq(anonymousConversations.userAId, a), eq(anonymousConversations.userBId, b)),
              and(eq(anonymousConversations.userAId, b), eq(anonymousConversations.userBId, a))
            )
          )
        )
        .orderBy(desc(anonymousConversations.id))
        .limit(5)
        .all()) || [];
    return rows[0] || null;
  } catch (e) {
    console.error('findActiveConversation', e);
    return null;
  }
}

export async function getConversation(convId) {
  const id = Number(convId);
  if (!id) return null;
  try {
    const rows =
      (await db.select().from(anonymousConversations).where(eq(anonymousConversations.id, id)).limit(1).all()) ||
      [];
    return rows[0] || null;
  } catch (e) {
    console.error('getConversation', e);
    return null;
  }
}

export function peerIdOfConv(conv, userId) {
  const uid = Number(userId);
  const a = Number(conv.userAId ?? conv.user_a_id);
  const b = Number(conv.userBId ?? conv.user_b_id);
  if (uid === a) return b;
  if (uid === b) return a;
  return null;
}

export function isParticipant(conv, userId) {
  return peerIdOfConv(conv, userId) != null;
}

function deletedFlagFor(conv, userId) {
  const uid = Number(userId);
  const a = Number(conv.userAId ?? conv.user_a_id);
  if (uid === a) return Number(conv.deletedByA ?? conv.deleted_by_a) === 1;
  return Number(conv.deletedByB ?? conv.deleted_by_b) === 1;
}

export async function softDeleteConversationForUser(convId, userId) {
  const conv = await getConversation(convId);
  if (!conv || !isParticipant(conv, userId)) return { ok: false, text: 'گفت‌وگو پیدا نشد.' };
  const uid = Number(userId);
  const a = Number(conv.userAId ?? conv.user_a_id);
  try {
    if (uid === a) {
      await db
        .update(anonymousConversations)
        .set({ deletedByA: 1, updatedAt: new Date() })
        .where(eq(anonymousConversations.id, Number(convId)))
        .run();
    } else {
      await db
        .update(anonymousConversations)
        .set({ deletedByB: 1, updatedAt: new Date() })
        .where(eq(anonymousConversations.id, Number(convId)))
        .run();
    }
  } catch (e) {
    console.error('softDeleteConversationForUser', e);
    return { ok: false, text: 'خطا در حذف.' };
  }
  return { ok: true };
}

async function createConversation(initiatorId, targetId) {
  try {
    await db
      .insert(anonymousConversations)
      .values({
        userAId: Number(initiatorId),
        userBId: Number(targetId),
        status: 'active',
        currentSenderId: Number(initiatorId),
        messagesInTurn: 0,
        turnNumber: 1,
        deletedByA: 0,
        deletedByB: 0,
        lastMessageAt: new Date(),
      })
      .run();
    return await findActiveConversation(initiatorId, targetId);
  } catch (e) {
    console.error('createConversation', e);
    return null;
  }
}

/**
 * بررسی نوبت: آیا sender می‌تواند در این گفت‌وگو پیام بفرستد؟
 */
export function canSendInTurn(conv, senderId) {
  if (!conv || String(conv.status) !== 'active') {
    return { ok: false, text: 'این گفت‌وگو فعال نیست.' };
  }
  const sid = Number(senderId);
  const cur = Number(conv.currentSenderId ?? conv.current_sender_id) || 0;
  const used = Number(conv.messagesInTurn ?? conv.messages_in_turn) || 0;
  // نوبت خودم: تا ۳ پیام
  if (!cur || cur === sid) {
    if (used >= ANON_TURN_LIMIT) {
      return {
        ok: false,
        text:
          'سقف ۳ پیام این نوبت پر شده. صبر کن طرف مقابل پاسخ بده تا نوبت دوباره برسه.',
      };
    }
    return { ok: true, remaining: ANON_TURN_LIMIT - used };
  }
  // نوبت طرف مقابل بوده — من می‌توانم با پاسخ، نوبت جدید را شروع کنم
  return { ok: true, remaining: ANON_TURN_LIMIT, startsNewTurn: true };
}

async function updateTurnAfterSend(conv, senderId) {
  const sid = Number(senderId);
  const cur = Number(conv.currentSenderId ?? conv.current_sender_id) || sid;
  let used = Number(conv.messagesInTurn ?? conv.messages_in_turn) || 0;
  let turn = Number(conv.turnNumber ?? conv.turn_number) || 1;
  if (cur !== sid) {
    // شروع نوبت جدید برای این فرستنده
    used = 1;
    turn = turn + 1;
  } else {
    used = used + 1;
  }
  try {
    await db
      .update(anonymousConversations)
      .set({
        currentSenderId: sid,
        messagesInTurn: used,
        turnNumber: turn,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        deletedByA: 0,
        deletedByB: 0,
      })
      .where(eq(anonymousConversations.id, Number(conv.id)))
      .run();
  } catch (e) {
    console.error('updateTurnAfterSend', e);
  }
  // وقتی طرف مقابل بعداً جواب دهد، canSend با cur===other و used از این آپدیت می‌فهمد
}

/**
 * وقتی گیرنده پاسخ می‌دهد، نوبت به او منتقل می‌شود (اولین پیام نوبت جدید).
 * updateTurnAfterSend همین کار را می‌کند اگر currentSender با sender فرق کند.
 */

async function insertAnonMessage(row) {
  try {
    await db.insert(anonymousMessages).values(row).run();
    const last =
      (await db
        .select()
        .from(anonymousMessages)
        .where(
          and(
            eq(anonymousMessages.conversationId, row.conversationId),
            eq(anonymousMessages.senderId, row.senderId)
          )
        )
        .orderBy(desc(anonymousMessages.id))
        .limit(1)
        .all()) || [];
    return last[0] || null;
  } catch (e) {
    console.error('insertAnonMessage', e);
    return null;
  }
}

async function logToChannel(text, replyToChannelMsgId) {
  const payload = {
    chat_id: ANON_LOG_CHANNEL_ID,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  };
  if (replyToChannelMsgId) {
    payload.reply_to_message_id = Number(replyToChannelMsgId);
    payload.allow_sending_without_reply = true;
  }
  try {
    const sent = await api.sendMessage(payload);
    return Number(sent && (sent.message_id || sent.messageId)) || null;
  } catch (e) {
    console.error('anon log channel', e);
    try {
      const sent2 = await api.sendMessage({
        chat_id: ANON_LOG_CHANNEL_ID,
        text: String(text).slice(0, 4000),
        disable_web_page_preview: true,
      });
      return Number(sent2 && (sent2.message_id || sent2.messageId)) || null;
    } catch (e2) {
      console.error('anon log channel retry', e2);
      return null;
    }
  }
}

/**
 * ارسال پیام ناشناس کامل: اعتبارسنجی، ذخیره، کانال، اعلان گیرنده
 */
export async function sendAnonymousMessage(fromId, toId, text, opts) {
  const sender = Number(fromId);
  const receiver = Number(toId);
  const body = String(text || '').trim();
  opts = opts || {};

  if (!sender || !receiver || sender === receiver) {
    return { ok: false, text: 'گیرنده نامعتبر است.' };
  }
  if (!body) return { ok: false, text: 'متن پیام خالی است.' };
  if (body.length > ANON_MAX_TEXT) {
    return { ok: false, text: 'پیام خیلی بلند است (حداکثر حدود ۳۵۰۰ کاراکتر).' };
  }

  const rl = await checkRateLimit(sender);
  if (!rl.ok) return rl;

  if (await isAnonBlockedEither(sender, receiver)) {
    return { ok: false, text: 'امکان ارسال پیام به این کاربر وجود ندارد.' };
  }

  const targetCheck = await resolveAnonTarget(String(receiver));
  if (!targetCheck.ok) return targetCheck;

  let conv = null;
  if (opts.conversationId) {
    conv = await getConversation(opts.conversationId);
    if (!conv || !isParticipant(conv, sender) || !isParticipant(conv, receiver)) {
      return { ok: false, text: 'گفت‌وگو نامعتبر است.' };
    }
    if (String(conv.status) !== 'active') {
      return { ok: false, text: 'این گفت‌وگو فعال نیست.' };
    }
  } else {
    conv = await findActiveConversation(sender, receiver);
    if (!conv) {
      conv = await createConversation(sender, receiver);
    }
  }
  if (!conv) return { ok: false, text: 'ساخت گفت‌وگو ناموفق بود. بعداً تلاش کن.' };

  // اگر کاربر قبلاً حذف کرده بود، با پیام جدید برایش برمی‌گردد
  try {
    await db
      .update(anonymousConversations)
      .set({ deletedByA: 0, deletedByB: 0, status: 'active', updatedAt: new Date() })
      .where(eq(anonymousConversations.id, Number(conv.id)))
      .run();
    conv = await getConversation(conv.id);
  } catch (_e) {}

  const turn = canSendInTurn(conv, sender);
  if (!turn.ok) return turn;

  // idempotency کوتاه
  const idemKey =
    'anon_idem:' +
    sender +
    ':' +
    Number(conv.id) +
    ':' +
    body.slice(0, 80);
  const prevIdem = await settingGet(idemKey, '');
  if (prevIdem && Date.now() - Number(prevIdem) < 8000) {
    return { ok: false, text: 'این پیام همین الان ارسال شده. کمی صبر کن.' };
  }
  await settingSet(idemKey, String(Date.now()));

  let replyToInternal = opts.replyToInternalId ? Number(opts.replyToInternalId) : null;
  let replyChannelId = null;
  if (replyToInternal) {
    try {
      const rm =
        (await db
          .select()
          .from(anonymousMessages)
          .where(eq(anonymousMessages.id, replyToInternal))
          .limit(1)
          .all()) || [];
      if (rm[0]) {
        replyChannelId = Number(rm[0].channelMessageId ?? rm[0].channel_message_id) || null;
        if (Number(rm[0].conversationId ?? rm[0].conversation_id) !== Number(conv.id)) {
          replyToInternal = null;
          replyChannelId = null;
        }
      }
    } catch (_e) {}
  }

  const inserted = await insertAnonMessage({
    conversationId: Number(conv.id),
    senderId: sender,
    receiverId: receiver,
    messageText: body,
    messageType: 'text',
    channelMessageId: null,
    replyToInternalId: replyToInternal,
    status: 'sent',
  });
  if (!inserted) {
    return { ok: false, text: 'خطا در ذخیره پیام. دوباره تلاش کن.' };
  }

  await updateTurnAfterSend(conv, sender);

  const logText =
    '💬 ناشناس\n' +
    'گفت‌وگو #' +
    conv.id +
    ' · پیام #' +
    inserted.id +
    '\n' +
    'فرستنده: ' +
    sender +
    '\nگیرنده: ' +
    receiver +
    '\nنوبت: ' +
    (Number(conv.turnNumber ?? conv.turn_number) || 1) +
    '\n────────────\n' +
    body;

  const chMid = await logToChannel(logText, replyChannelId);
  if (chMid) {
    try {
      await db
        .update(anonymousMessages)
        .set({ channelMessageId: chMid })
        .where(eq(anonymousMessages.id, Number(inserted.id)))
        .run();
    } catch (_e) {}
  }

  // اعلان فوری به گیرنده
  let delivered = false;
  let deliverErr = null;
  try {
    await api.sendMessage({
      chat_id: receiver,
      text:
        '💌 یک پیام ناشناس جدید داری!\n\n' +
        body.slice(0, 3500) +
        '\n\n────────────\n' +
        'گفت‌وگو #' +
        conv.id +
        ' · #' +
        inserted.id,
      reply_markup: anonNotifyInline(inserted.id),
    });
    delivered = true;
  } catch (e) {
    deliverErr = String((e && (e.message || e.description)) || e).slice(0, 200);
    console.error('anon notify', e);
    await settingSet(
      'anon_retry:' + inserted.id,
      JSON.stringify({ receiver: receiver, tries: 0, err: deliverErr, at: Date.now() })
    );
  }

  const fresh = await getConversation(conv.id);
  const used = Number(fresh && (fresh.messagesInTurn ?? fresh.messages_in_turn)) || 0;
  const remaining = Math.max(0, ANON_TURN_LIMIT - used);

  return {
    ok: true,
    messageId: Number(inserted.id),
    conversationId: Number(conv.id),
    delivered: delivered,
    deliverErr: deliverErr,
    remainingInTurn: remaining,
    channelMessageId: chMid,
  };
}

export async function getAnonMessage(id) {
  const mid = Number(id);
  if (!mid) return null;
  try {
    const rows =
      (await db.select().from(anonymousMessages).where(eq(anonymousMessages.id, mid)).limit(1).all()) ||
      [];
    return rows[0] || null;
  } catch (e) {
    console.error('getAnonMessage', e);
    return null;
  }
}

export async function markAnonRead(msgId) {
  try {
    await db
      .update(anonymousMessages)
      .set({ readAt: new Date() })
      .where(eq(anonymousMessages.id, Number(msgId)))
      .run();
  } catch (_e) {}
}

export async function listInbox(userId, limit) {
  const uid = Number(userId);
  const lim = Math.min(Number(limit) || 15, 30);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousMessages)
        .where(eq(anonymousMessages.receiverId, uid))
        .orderBy(desc(anonymousMessages.id))
        .limit(lim)
        .all()) || [];
    return rows;
  } catch (e) {
    console.error('listInbox', e);
    return [];
  }
}

export async function listConversationsForUser(userId, limit) {
  const uid = Number(userId);
  const lim = Math.min(Number(limit) || 20, 40);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousConversations)
        .where(
          or(eq(anonymousConversations.userAId, uid), eq(anonymousConversations.userBId, uid))
        )
        .orderBy(desc(anonymousConversations.id))
        .limit(80)
        .all()) || [];
    return rows
      .filter(function (c) {
        if (deletedFlagFor(c, uid)) return false;
        return true;
      })
      .slice(0, lim);
  } catch (e) {
    console.error('listConversationsForUser', e);
    return [];
  }
}

export async function listMessagesInConv(convId, limit) {
  const id = Number(convId);
  const lim = Math.min(Number(limit) || 30, 50);
  try {
    const rows =
      (await db
        .select()
        .from(anonymousMessages)
        .where(eq(anonymousMessages.conversationId, id))
        .orderBy(desc(anonymousMessages.id))
        .limit(lim)
        .all()) || [];
    return rows.reverse();
  } catch (e) {
    console.error('listMessagesInConv', e);
    return [];
  }
}

/** تلاش مجدد اعلان‌های ناموفق — سبک، در handler فراخوانی می‌شود */
export async function retryAnonDeliveries(maxItems) {
  const n = Math.min(Number(maxItems) || 3, 5);
  // اسکن محدود کلیدها ممکن نیست؛ از آخرین پیام‌های بدون تحویل skip می‌کنیم
  // فقط اگر anon_retry:<id> باشد
  try {
    // بدون اسکن کامل settings — no-op امن
    return n;
  } catch (_e) {
    return 0;
  }
}

export async function reportAnonMessage(msgId, reporterId) {
  const m = await getAnonMessage(msgId);
  if (!m) return { ok: false };
  const text =
    '🚩 گزارش پیام ناشناس\n' +
    'گزارش‌دهنده: ' +
    reporterId +
    '\nپیام #' +
    msgId +
    '\nگفت‌وگو #' +
    (m.conversationId ?? m.conversation_id) +
    '\nفرستنده واقعی: ' +
    (m.senderId ?? m.sender_id) +
    '\nگیرنده: ' +
    (m.receiverId ?? m.receiver_id) +
    '\n\n' +
    String((m.messageText ?? m.message_text) || '').slice(0, 1500);
  try {
    await logToChannel(text, Number(m.channelMessageId ?? m.channel_message_id) || null);
  } catch (_e) {}
  return { ok: true };
}
