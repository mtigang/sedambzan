import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { users } from 'schema';
import { CHANNEL_USERNAMES } from 'lib/config';

export async function resolveUserId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const uname = s.replace(/^@/, '').trim();
  if (!uname) return null;
  const unameLower = uname.toLowerCase();

  // ۱) getChat سریع‌تر از اسکن کل users
  try {
    const chat = await api.getChat({ chat_id: '@' + uname });
    if (chat && chat.id) return Number(chat.id);
  } catch (e) {
    console.error('resolveUserId getChat', e);
  }
  // ۲) فقط با where روی username — بدون select().all()
  try {
    const rows =
      (await db.select().from(users).where(eq(users.username, uname)).all()) || [];
    if (rows[0] && rows[0].userId) return Number(rows[0].userId);
    // case-insensitive fallback محدود
    const rows2 =
      (await db.select().from(users).where(eq(users.username, unameLower)).all()) || [];
    if (rows2[0] && rows2[0].userId) return Number(rows2[0].userId);
  } catch (e) {
    console.error('resolveUserId db', e);
  }
  return null;
}

export function channelMessageLink(chatId, messageId, channelKey) {
  const mid = Number(messageId);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const ck = String(channelKey || '');
  const uname = ck && CHANNEL_USERNAMES ? CHANNEL_USERNAMES[ck] : null;
  if (uname) return 'https://t.me/' + uname + '/' + mid;
  // بدون یوزرنیم عمومی فقط در صورت اجبار /c/ (ترجیح: resolveChannelMessageLink)
  const s = String(chatId || '');
  if (s.startsWith('-100')) return 'https://t.me/c/' + s.slice(4) + '/' + mid;
  return null;
}

export function channelPublicBase(channelKey) {
  const uname = CHANNEL_USERNAMES && CHANNEL_USERNAMES[channelKey];
  if (uname) return 'https://t.me/' + uname + '/';
  return null;
}

/**
 * لینک عمومی پیام کانال.
 * اگر CHANNEL_USERNAMES خالی بود، از getChat یوزرنیم را می‌گیرد.
 * هرگز ترجیح نمی‌دهد /c/ را اگر username پیدا شود.
 */
export async function resolveChannelMessageLink(chatId, messageId, channelKey) {
  const mid = Number(messageId);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const ck = String(channelKey || '');
  let uname = ck && CHANNEL_USERNAMES ? CHANNEL_USERNAMES[ck] : null;
  // اگر key اشتباه بود ولی chatId درست است، از خود کانال username بگیر
  if (!uname && chatId) {
    try {
      const chat = await api.getChat({ chat_id: chatId });
      if (chat && chat.username) uname = chat.username;
    } catch (e) {
      console.error('resolveChannelMessageLink getChat', e);
    }
  }
  if (uname) return 'https://t.me/' + String(uname).replace(/^@/, '') + '/' + mid;
  // کانال خصوصی بدون username — ناگزیر /c/
  const s = String(chatId || '');
  if (s.startsWith('-100')) return 'https://t.me/c/' + s.slice(4) + '/' + mid;
  if (s.startsWith('-')) return 'https://t.me/c/' + s.replace(/^-100/, '').replace(/^-/, '') + '/' + mid;
  return null;
}
