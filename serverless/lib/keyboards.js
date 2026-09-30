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

export function adminKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '⏰ شیفت من' }],
      [{ text: '📝 ارسال پیام به صورت کاربر عادی' }],
      [{ text: '📖 راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '👥 ادمین‌ها' }],
      [{ text: '⏰ شیفت‌ها' }, { text: '📢 کانال‌ها' }],
      [{ text: '📊 آمار' }, { text: '📬 پیام کاربران' }],
      [{ text: '🔍 جستجو' }, { text: '📣 اطلاعیه' }],
      [{ text: '⚙️ تنظیمات' }, { text: '📖 راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function backKeyboard() {
  return { keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true };
}

export function channelPickKeyboard(channels, prefix) {
  const rows = channels.map((c) => [{ text: `${prefix}${c.title}` }]);
  rows.push([{ text: '◀️ بازگشت' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function reviewInline(id) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 تأیید', callback_data: `approve:${id}` },
        { text: '🔴 رد', callback_data: `reject_menu:${id}` },
      ],
    ],
  };
}

export function rejectReasonsInline(id) {
  const reasons = ['نامناسب', 'هیت یا بی‌احترامی', 'تکراری', 'سیاسی', 'نامفهوم'];
  return {
    inline_keyboard: [
      ...reasons.map((r) => [{ text: r, callback_data: `reject:${id}:${r}` }]),
      [{ text: '◀️ انصراف', callback_data: `reject_cancel:${id}` }],
    ],
  };
}

export function feedbackInline(id) {
  return {
    inline_keyboard: [
      [
        { text: '💬 پاسخ', callback_data: `fb_reply:${id}` },
        { text: '✅ بستن', callback_data: `fb_close:${id}` },
      ],
    ],
  };
}
