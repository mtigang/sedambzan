import { api } from 'sdk';
import { CHANNEL_USERNAMES } from 'lib/config';

export async function resolveUserId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const uname = s.replace(/^@/, '');
  if (!uname) return null;
  try {
    const chat = await api.getChat({ chat_id: '@' + uname });
    return chat && chat.id ? chat.id : null;
  } catch (e) {
    console.error('resolveUserId', e);
    return null;
  }
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
