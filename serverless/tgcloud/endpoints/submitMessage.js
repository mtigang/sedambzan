/**
 * Endpoint مینی‌اپ: ثبت پیام با همان قوانین «ارسال پیام» ربات
 * فراخوانی از مینی‌اپ: Telegram.WebApp.Serverless.call('submitMessage', { text: '...' })
 */
import { EndpointError } from 'sdk';
import { submitUserMessage } from 'lib/submit_user_message';
import { upsertUser } from 'lib/dbutil';

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) {
    throw new EndpointError('ورود نامعتبر', { code: 'NO_USER' });
  }

  const text = input && input.text != null ? String(input.text) : '';
  if (!String(text).trim()) {
    throw new EndpointError('متن پیام را بنویسید.', { code: 'EMPTY' });
  }

  try {
    await upsertUser({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
    });
  } catch (_e) {}

  const res = await submitUserMessage(user.id, text);
  if (!res.ok) {
    throw new EndpointError(res.error || 'ثبت ناموفق', { code: res.code || 'REJECT' });
  }

  return {
    ok: true,
    msgId: res.msgId,
    channelKey: res.channelKey,
    title: res.title,
    autoFixed: !!res.autoFixed,
    message:
      '✅ پیامت ثبت شد.\n🆔 شماره پیگیری: #' +
      res.msgId +
      '\n📺 کانال: «' +
      res.title +
      '»\n🟡 در انتظار بررسی ادمین است.',
  };
}
