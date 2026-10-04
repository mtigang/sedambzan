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
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
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
  if (/[\u2600-\u27BF]/.test(text)) return true;
  return false;
}

/**
 * نرمال‌سازی برای تشخیص پیشوند:
 * - حذف کاراکترهای نامرئی / RTL / LTR / BOM
 * - یکسان‌سازی ی/ک عربی و فارسی
 * - یکسان‌سازی فاصله‌ها
 */
export function normalizeForPrefix(text) {
  let t = String(text || '');
  // BOM, zero-width, directional marks, soft hyphen
  t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
  // انواع فاصله → space معمولی
  t = t.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  // ی عربی → ی فارسی ، ك عربی → ک فارسی
  t = t.replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9');
  // فاصله‌های تکراری
  t = t.replace(/[ \t]+/g, ' ');
  return t.trim();
}

/** بدنه پیام بعد از پیشوند تا قبل از نقطه پایانی — برای تشخیص تکراری */
export function normalizeBody(text) {
  let t = normalizeForPrefix(text);
  for (const { prefix } of CHANNEL_PREFIXES) {
    const p = normalizeForPrefix(prefix);
    if (t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  t = t.replace(/\s*\.\s*$/, '').replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * کلید تکراری سخت‌گیرانه:
 * فقط متن بین «پیشوند کانال» و «نقطه پایانی»
 */
export function exactBodyKey(text) {
  let t = normalizeForPrefix(String(text || ''));
  t = t.replace(/<\/?b>/gi, '');
  for (const { prefix } of CHANNEL_PREFIXES) {
    const p = normalizeForPrefix(prefix);
    if (t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  t = t.replace(/[\s.]+$/g, '').trim();
  // فاصله ابتدا بعد از پیشوند
  if (t.startsWith(' ')) t = t.slice(1);
  return t;
}

export function detectChannel(text) {
  const t = normalizeForPrefix(text);
  if (!t) return null;
  for (const { key, prefix } of CHANNEL_PREFIXES) {
    const p = normalizeForPrefix(prefix);
    if (t.startsWith(p)) {
      // بعد از پیشوند یا فاصله یا پایان
      const next = t.charAt(p.length);
      if (!next || next === ' ' || next === '.' || next === '،' || next === ',') {
        return { key, prefix };
      }
      // اگر بلافاصله حرف چسبیده بود هم قبول (بعضی موبایل‌ها)
      if (p.length >= 3) return { key, prefix };
    }
  }
  return null;
}

export function validateAndFix(message) {
  // text یا caption
  let raw = message.text || message.caption || '';
  let text = normalizeForPrefix(raw);
  const entities = message.entities || message.caption_entities || [];
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

  // نقطه آخر (فارسی . و انگلیسی .)
  if (!/[.]\s*$/.test(text)) {
    text = text.replace(/\s*$/, '') + ' .';
  } else if (/[.]\s*$/.test(text) && !/\s[.]\s*$/.test(text)) {
    text = text.replace(/[.]\s*$/, ' .');
  }

  // متن ذخیره‌شده: پیشوند استاندارد کانال + بقیه متن نرمال‌شده
  const rest = text.slice(normalizeForPrefix(ch.prefix).length).replace(/^\s+/, ' ');
  const content = ch.prefix + (rest.startsWith(' ') || rest.startsWith('.') ? rest : ' ' + rest);

  const wasBold = isFullyBold(raw, entities);
  return {
    ok: true,
    channelKey: ch.key,
    content: content.trim(),
    autoFixed: !wasBold || content.trim() !== normalizeForPrefix(raw),
  };
}
