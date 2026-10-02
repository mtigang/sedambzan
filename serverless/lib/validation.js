import { CHANNEL_PREFIXES } from 'lib/config';

function utf16Len(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    n += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  return n;
}

function isFullyBold(text, entities) {
  if (!text || !entities || !entities.length) return false;
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
  if (entities && entities.some((e) => e.type === 'url' || e.type === 'text_link')) return true;
  return /https?:\/\//i.test(text || '');
}

function hasEmoji(text) {
  if (!text) return false;
  // بدون flag u برای سازگاری بیشتر — بازه‌های surrogate
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
        // emoji ranges rough
        if (
          (cp >= 0x1f300 && cp <= 0x1faff) ||
          (cp >= 0x1f600 && cp <= 0x1f64f) ||
          (cp >= 0x1f900 && cp <= 0x1f9ff)
        ) {
          return true;
        }
        i++;
      }
    }
  }
  // misc symbols
  if (/[\u2600-\u27BF]/.test(text)) return true;
  return false;
}

/** بدنه پیام بعد از پیشوند تا قبل از نقطه پایانی — برای تشخیص تکراری */
export function normalizeBody(text) {
  let t = String(text || '').trim();
  for (const { prefix } of CHANNEL_PREFIXES) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length);
      break;
    }
  }
  t = t.replace(/\s*\.\s*$/, '').replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * کلید تکراری سخت‌گیرانه:
 * فقط متن بین «پیشوند کانال» و «نقطه پایانی» — بدون فشرده‌سازی فاصله‌های وسط.
 * مثال: صدام بزن | نیلسا چون ... | .
 * فقط اگر همان وسط دقیقاً یکی باشد → تکراری
 */
export function exactBodyKey(text) {
  let t = String(text || '').trim();
  // حذف HTML بولد احتمالی
  t = t.replace(/<\/?b>/gi, '');
  for (const { prefix } of CHANNEL_PREFIXES) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length);
      break;
    }
  }
  // فقط نقطه/فاصله انتهایی
  t = t.replace(/[\s.．.]+$/u, '');
  // فقط trim دو سر — فاصله‌های وسط دست نخورند
  t = t.replace(/^\s+/, '').replace(/\s+$/, '');
  return t;
}

export function detectChannel(text) {

  const t = (text || '').trim();
  for (const { key, prefix } of CHANNEL_PREFIXES) {
    if (t.startsWith(prefix)) return { key, prefix };
  }
  return null;
}

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

  // نقطه آخر
  if (!/\s+\.\s*$/.test(text) && !/\.\s*$/.test(text)) {
    text = text.replace(/\s*$/, '') + ' .';
  } else if (text.endsWith('.') && !/\s\.\s*$/.test(text)) {
    text = text.replace(/\.\s*$/, ' .');
  }

  const wasBold = isFullyBold(message.text || '', entities);
  return {
    ok: true,
    channelKey: ch.key,
    content: text,
    autoFixed: !wasBold || text !== (message.text || '').trim(),
  };
}
