import { CHANNEL_PREFIXES } from 'lib/config';

function utf16Len(str) {
  let n = 0;
  for (const ch of str) {
    n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return n;
}

function isFullyBold(text, entities) {
  if (!text || !entities?.length) return false;
  const total = utf16Len(text);
  const bold = entities
    .filter((e) => e.type === 'bold')
    .map((e) => [e.offset, e.offset + e.length])
    .sort((a, b) => a[0] - b[0]);
  if (!bold.length) return false;
  let covered = 0;
  for (const [s, e] of bold) {
    if (s > covered) return false;
    covered = Math.max(covered, e);
  }
  return covered >= total;
}

function hasLink(entities, text) {
  if (entities?.some((e) => e.type === 'url' || e.type === 'text_link')) return true;
  return /https?:\/\//i.test(text || '');
}

function hasEmoji(text) {
  // ساده — بلاک‌های رایج ایموجی
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text || '');
}

export function detectChannel(text) {
  const t = (text || '').trim();
  for (const { key, prefix } of CHANNEL_PREFIXES) {
    if (t.startsWith(prefix)) return { key, prefix };
  }
  return null;
}

/**
 * اعتبارسنجی + اصلاح خودکار:
 * - اگر بولد نبود → قبول (نسخه اصلاح‌شده برای ادمین)
 * - اگر نقطه آخر نداشت → « .» اضافه می‌شود
 * - فقط پیشوند کانال اجباری سخت است + لینک/ایموجی
 */
export function validateAndFix(message) {
  let text = (message.text || '').trim();
  const entities = message.entities || [];
  const ch = detectChannel(text);
  if (!ch) {
    return {
      ok: false,
      error:
        '🚫 پیام باید با یکی از این‌ها شروع شود:\n• صدام بزن\n• این کاربر\n• تو زندگی بعدی',
    };
  }
  if (hasLink(entities, text)) {
    return { ok: false, error: '🚫 لینک در پیام مجاز نیست.' };
  }
  if (hasEmoji(text)) {
    return { ok: false, error: '🚫 ایموجی در پیام مجاز نیست.' };
  }

  // نقطه آخر — فارسی یا انگلیسی، با یا بدون فاصله
  if (!/[.．。]\s*$/.test(text) && !/\s+\.\s*$/.test(text)) {
    if (!text.endsWith('.')) text = text.replace(/\s*$/, '') + ' .';
    else text = text.replace(/\.\s*$/, ' .');
  } else if (text.endsWith('.') && !text.endsWith(' .')) {
    text = text.replace(/\.\s*$/, ' .');
  }

  const wasBold = isFullyBold(message.text || '', entities);
  // بولد نبود → گیر نمی‌دهیم؛ فقط علامت می‌زنیم
  return {
    ok: true,
    channelKey: ch.key,
    content: text,
    autoFixed: !wasBold || text !== (message.text || '').trim(),
    fixedBold: !wasBold,
  };
}
