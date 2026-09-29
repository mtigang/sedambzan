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

export function adminKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '📊 عملکرد من' }],
      [{ text: '📝 ارسال پیام به صورت کاربر عادی' }],
      [{ text: '❓ راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '👥 ادمین‌ها' }],
      [{ text: '📊 آمار و گزارش‌ها' }, { text: '📬 پیام کاربران' }],
      [{ text: '📢 اطلاعیه‌ها' }, { text: '🔍 جستجو' }],
      [{ text: '⚙️ مدیریت سیستم' }, { text: '❓ راهنما' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerStatsKeyboard() {
  return {
    keyboard: [
      [{ text: '📊 داشبورد آماری' }],
      [{ text: '👥 آمار کاربران' }, { text: '👮 آمار ادمین‌ها' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerAdminsKeyboard() {
  return {
    keyboard: [
      [{ text: '📋 لیست ادمین‌ها' }],
      [{ text: '➕ افزودن ادمین' }, { text: '➖ حذف ادمین' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerSearchKeyboard() {
  return {
    keyboard: [
      [{ text: '🔎 جستجو پیام' }, { text: '🔎 جستجو کاربر' }],
      [{ text: '🚫 بن کاربر' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerSystemKeyboard() {
  return {
    keyboard: [
      [{ text: '🟢/🔴 روشن خاموش ربات' }],
      [{ text: '📢 وضعیت کانال‌ها' }],
      [{ text: '🧹 پاک‌سازی صف' }],
      [{ text: '🧪 تست اتصال' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerAnnounceKeyboard() {
  return {
    keyboard: [
      [{ text: '📣 به همه کاربران' }, { text: '📣 به ادمین‌ها' }],
      [{ text: '◀️ بازگشت' }],
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
        { text: '🔴 رد', callback_data: `reject_menu:${messageId}` },
      ],
    ],
  };
}

export function rejectReasonsInline(messageId) {
  return {
    inline_keyboard: [
      [{ text: 'نامناسب', callback_data: `reject:${messageId}:نامناسب` }],
      [{ text: 'هیت یا بی‌احترامی', callback_data: `reject:${messageId}:هیت یا بی‌احترامی` }],
      [{ text: 'تکراری', callback_data: `reject:${messageId}:تکراری` }],
      [{ text: 'سیاسی', callback_data: `reject:${messageId}:سیاسی` }],
      [{ text: 'نامفهوم', callback_data: `reject:${messageId}:نامفهوم` }],
      [{ text: '◀️ انصراف', callback_data: `reject_cancel:${messageId}` }],
    ],
  };
}

export function feedbackInline(feedbackId) {
  return {
    inline_keyboard: [
      [
        { text: '💬 پاسخ', callback_data: `fb_reply:${feedbackId}` },
        { text: '✅ بستن', callback_data: `fb_close:${feedbackId}` },
      ],
    ],
  };
}

export function userProfileInline(userId) {
  return {
    inline_keyboard: [
      [
        { text: '🚫 بن', callback_data: `ban:${userId}` },
        { text: '✅ آنبن', callback_data: `unban:${userId}` },
      ],
    ],
  };
}
