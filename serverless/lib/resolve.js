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

  // ۱) جستجو در دیتابیس محلی (کاربرانی که ربات را استارت کرده‌اند)
  try {
    const all = (await db.select().from(users).all()) || [];
    for (const u of all) {
      if (u.username && String(u.username).toLowerCase() === unameLower) {
        return Number(u.userId);
      }
    }
  } catch (e) {
    console.error('resolveUserId db', e);
  }

  // ۲) تلاش با Telegram getChat
  try {
    const chat = await api.getChat({ chat_id: '@' + uname });
    if (chat && chat.id) return chat.id;
  } catch (e) {
    console.error('resolveUserId getChat', e);
  }
  return null;
}

export function channelMessageLink(chatId, messageId, channelKey) {
  if (!messageId) return null;
  const uname = channelKey && CHANNEL_USERNAMES ? CHANNEL_USERNAMES[channelKey] : null;
  if (uname) return 'https://t.me/' + uname + '/' + messageId;
  const s = String(chatId || '');
  if (s.startsWith('-100')) return 'https://t.me/c/' + s.slice(4) + '/' + messageId;
  return null;
}

export function channelPublicBase(channelKey) {
  const uname = CHANNEL_USERNAMES && CHANNEL_USERNAMES[channelKey];
  if (uname) return 'https://t.me/' + uname + '/';
  return null;
}
