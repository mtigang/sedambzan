/** کیبوردهای Reply و Inline */

export function userKeyboard() {
  return {
    keyboard: [
      [{ text: '📝 ارسال پیام' }, { text: '📊 وضعیت پیام من' }],
      [{ text: '💬 انتقادات، پیشنهادات، گزارش مشکل' }],
      [{ text: '📖 راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '📬 پیام کاربران' }],
      [{ text: '📊 آمار' }, { text: '⚙️ روشن/خاموش' }],
      [{ text: '❓ راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function backKeyboard() {
  return {
    keyboard: [[{ text: '◀️ بازگشت' }]],
    resize_keyboard: true,
  };
}

export function reviewInline(messageId) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 تأیید', callback_data: `approve:${messageId}` },
        { text: '🔴 رد', callback_data: `reject:${messageId}` },
      ],
    ],
  };
}
