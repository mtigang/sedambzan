import { api } from 'sdk';

/** عدد یا @username → user id */
export async function resolveUserId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const uname = raw.replace(/^@/, '');
  try {
    const chat = await api.getChat({ chat_id: '@' + uname });
    if (chat && chat.id) return chat.id;
  } catch (e) {
    console.error('resolveUserId', uname, e);
  }
  return null;
}

/** لینک پیام کانال از chatId عددی و message_id */
export function channelMessageLink(chatId, messageId) {
  if (!chatId || !messageId) return null;
  const s = String(chatId);
  // -100xxxxxxxxxx → t.me/c/xxxxxxxxxx/msg
  if (s.startsWith('-100')) {
    return 'https://t.me/c/' + s.slice(4) + '/' + messageId;
  }
  return null;
}
