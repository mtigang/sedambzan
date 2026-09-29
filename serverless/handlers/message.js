import { api } from 'sdk';

/**
 * نسخه تشخیصی — بدون DB، بدون import اضافه
 * اگر این جواب داد، webhook و Serverless سالم‌اند.
 */
export default async function (message) {
  console.log('handler hit', {
    text: message?.text,
    chat: message?.chat?.id,
    type: message?.chat?.type,
    from: message?.from?.id,
  });

  if (!message?.chat?.id) {
    console.error('missing chat.id', message);
    return;
  }

  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  try {
    await api.sendMessage({
      chat_id: chatId,
      text:
        'ربات Serverless زنده است ✅\n\n' +
        'متن شما: ' +
        (text || '(بدون متن)') +
        '\nchat: ' +
        chatId,
    });
  } catch (e) {
    console.error('sendMessage failed', e);
    throw e;
  }
}
