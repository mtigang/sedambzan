import { DEFAULT_CHANNELS, buildShiftSlots } from 'lib/config';

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
      [{ text: '📊 عملکرد من' }],
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
      [{ text: '⏰ شیفت‌ها' }, { text: '📣 ارسال به کانال' }],
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

export function settingsKeyboard(botOn) {
  return {
    keyboard: [
      [{ text: botOn ? '🔴 خاموش کردن ربات' : '🟢 روشن کردن ربات' }],
      [{ text: '🧪 تست کانال‌ها' }],
      [{ text: '🔄 همگام‌سازی ادمین‌ها' }],
      [{ text: '🧹 پاک‌سازی صف' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function searchKeyboard() {
  return {
    keyboard: [
      [{ text: '🔎 جستجوی پیام' }, { text: '🔎 جستجوی کاربر' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  };
}

export function channelAdminPickKeyboard() {
  const rows = Object.values(DEFAULT_CHANNELS).map((c) => [
    { text: 'ادمین‌های ' + c.title },
  ]);
  rows.push([{ text: '◀️ بازگشت' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function shiftChannelPickKeyboard(channelList) {
  const rows = channelList.map((c) => [{ text: 'شیفت: ' + c.title }]);
  rows.push([{ text: '◀️ بازگشت' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function postChannelInline() {
  return {
    inline_keyboard: [
      [{ text: '🟢 صدام بزن', callback_data: 'postch:sadambazan' }],
      [{ text: '🔵 این کاربر', callback_data: 'postch:inkarbar' }],
      [{ text: '🟣 تو زندگی بعدی', callback_data: 'postch:zendegi' }],
      [{ text: 'لغو', callback_data: 'postch_cancel' }],
    ],
  };
}

export function confirmPostInline() {
  return {
    inline_keyboard: [
      [
        { text: '✅ تأیید ارسال', callback_data: 'post_yes' },
        { text: '❌ انصراف', callback_data: 'post_no' },
      ],
    ],
  };
}

export function reviewInline(id) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 تأیید', callback_data: 'approve:' + id },
        { text: '🔴 رد', callback_data: 'reject_menu:' + id },
      ],
    ],
  };
}

export function rejectReasonsInline(id) {
  const reasons = ['نامناسب', 'هیت یا بی‌احترامی', 'تکراری', 'سیاسی', 'نامفهوم'];
  return {
    inline_keyboard: [
      ...reasons.map((r) => [{ text: r, callback_data: 'reject:' + id + ':' + r }]),
      [{ text: '◀️ انصراف', callback_data: 'reject_cancel:' + id }],
    ],
  };
}

export function feedbackInline(id, userId) {
  return {
    inline_keyboard: [
      [
        { text: '💬 پاسخ', callback_data: 'fb_reply:' + id },
        { text: '✅ بستن', callback_data: 'fb_close:' + id },
      ],
      [{ text: '👤 مشاهده کاربر', callback_data: 'fb_user:' + userId }],
    ],
  };
}

export function userOpenInline(userId) {
  return {
    inline_keyboard: [[{ text: '✉️ باز کردن پیوی', url: 'tg://user?id=' + userId }]],
  };
}

/**
 * takenMap: { '10:00': adminId }
 * myStarts: Set of start times already selected by this admin
 */
export function shiftSlotsInline(channelKey, takenMap, myStarts) {
  const slots = buildShiftSlots();
  const rows = [];
  for (const s of slots) {
    const takenBy = takenMap[s.start];
    if (takenBy && !(myStarts && myStarts.has(s.start))) {
      rows.push([
        {
          text: '🔴 ' + s.label + ' (پر)',
          callback_data: 'shift_full:' + channelKey + ':' + s.start,
        },
      ]);
    } else if (myStarts && myStarts.has(s.start)) {
      rows.push([
        {
          text: '🟢 ' + s.label + ' (شما)',
          callback_data: 'shift_mine:' + channelKey + ':' + s.start,
        },
      ]);
    } else {
      rows.push([
        {
          text: '▫️ ' + s.label,
          callback_data: 'shift_pick:' + channelKey + ':' + s.start + ':' + s.end,
        },
      ]);
    }
  }
  rows.push([{ text: '◀️ بستن', callback_data: 'shift_close' }]);
  return { inline_keyboard: rows };
}

export function adminListInline(admins, channelKey) {
  const rows = [];
  for (const a of admins) {
    const name = a.display || String(a.userId);
    rows.push([
      { text: '👤 ' + name, url: 'tg://user?id=' + a.userId },
      { text: '➖ حذف', callback_data: 'adel:' + channelKey + ':' + a.userId },
    ]);
  }
  rows.push([{ text: '➕ افزودن ادمین', callback_data: 'aadd:' + channelKey }]);
  rows.push([{ text: '🔄 بروزرسانی از گروه', callback_data: 'async:' + channelKey }]);
  return { inline_keyboard: rows };
}
