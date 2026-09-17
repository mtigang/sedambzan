import { CHANNELS } from 'lib/config';

export function channelKeyFromPrefix(text) {
  const t = (text || '').trim();
  for (const [key, cfg] of Object.entries(CHANNELS)) {
    for (const p of cfg.prefixes) {
      if (t.startsWith(p)) return key;
    }
  }
  return null;
}

export function endsWithDot(text) {
  return (text || '').endsWith(' .');
}

/** بررسی سادهٔ Bold بودن کل متن از entities تلگرام */
export function isFullyBold(text, entities) {
  if (!text) return false;
  if (!entities || !entities.length) return false;
  const total = utf16Length(text);
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

function utf16Length(str) {
  let n = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    n += cp > 0xffff ? 2 : 1;
  }
  return n;
}

export function validateSubmission(message) {
  const text = message.text || '';
  const entities = message.entities || [];
  const errors = [];

  if (!channelKeyFromPrefix(text)) {
    errors.push(
      'پیام باید با یکی از این‌ها شروع شود:\n• صدام بزن\n• این کاربر\n• تو زندگی بعدی'
    );
  }
  if (!isFullyBold(text, entities)) {
    errors.push('کل پیام باید Bold باشد.');
  }
  if (!endsWithDot(text)) {
    errors.push('پیام باید با فاصله و نقطه تمام شود: « .»');
  }
  if (entities.some((e) => e.type === 'url' || e.type === 'text_link')) {
    errors.push('لینک در پیام مجاز نیست.');
  }

  if (errors.length) {
    return {
      ok: false,
      error:
        '🚫 پیام قابل ارسال نیست.\n\n' +
        errors.map((e, i) => `❌ ${i + 1}. ${e}`).join('\n\n'),
    };
  }
  return { ok: true, channelKey: channelKeyFromPrefix(text) };
}
