import { DEFAULT_CHANNELS, buildShiftSlots } from 'lib/config';

export function userKeyboard() {
  return {
    keyboard: [
      [{ text: '📝 ارسال پیام' }, { text: '📊 وضعیت پیام من' }],
      [{ text: '💬 انتقادات، پیشنهادات، گزارش مشکل' }],
    ],
    resize_keyboard: true,
  };
}

export function adminKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '⏰ شیفت من' }],
      [{ text: '📊 عملکرد من' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '👥 ادمین‌ها' }],
      [{ text: '⏰ شیفت‌ها' }, { text: '📊 آمار' }],
      [{ text: '📬 پیام کاربران' }, { text: '🔍 جستجو' }],
      [{ text: '⚙️ تنظیمات' }],
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
      [{ text: '📣 ارسال به کانال' }, { text: '📣 اطلاعیه' }],
      [{ text: '🧪 تست کانال‌ها' }, { text: '🔄 همگام‌سازی ادمین‌ها' }],
      [{ text: '🧹 پاک‌سازی صف' }],
      [{ text: '📦 بازیابی بکاپ' }],
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
      [{ text: 'صدام بزن', callback_data: 'postch:sadambazan', style: 'success' }],
      [{ text: 'این کاربر', callback_data: 'postch:inkarbar', style: 'primary' }],
      [{ text: 'تو زندگی بعدی', callback_data: 'postch:zendegi', style: 'primary' }],
      [{ text: 'لغو', callback_data: 'postch_cancel', style: 'danger' }],
    ],
  };
}

export function confirmPostInline() {
  return {
    inline_keyboard: [
      [
        { text: 'تأیید ارسال', callback_data: 'post_yes', style: 'success' },
        { text: 'انصراف', callback_data: 'post_no', style: 'danger' },
      ],
    ],
  };
}

export function reviewInline(id, showNextButton = false, batchNumber = null) {
  const rows = [
    [
      { text: 'تأیید', callback_data: 'approve:' + id, style: 'success' },
      { text: 'رد', callback_data: 'reject_menu:' + id, style: 'danger' },
    ],
  ];
  if (showNextButton) {
    rows.push([
      {
        text: '▶️ دریافت ۱۰ پیام بعدی',
        callback_data: batchNumber != null ? 'review_next:' + batchNumber : 'review_next',
        style: 'primary',
      },
    ]);
  }
  return { inline_keyboard: rows };
}

/** فقط دکمه‌ی «Batch بعدی» (بعد از کامل شدن Batch) */
export function reviewNextInline(batchNumber) {
  return {
    inline_keyboard: [
      [
        {
          text: '▶️ دریافت ۱۰ پیام بعدی',
          callback_data: batchNumber != null ? 'review_next:' + batchNumber : 'review_next',
          style: 'primary',
        },
      ],
    ],
  };
}

/** وقتی صف تمام شده */
export function reviewDoneInline() {
  return { inline_keyboard: [[{ text: '✅ صف تمام شد', callback_data: 'review_noop', style: 'success' }]] };
}

/** بعد از گرفتن Batch جدید، دکمه‌ی قبلی بی‌اثر می‌شود */
export function reviewTakenInline() {
  return { inline_keyboard: [[{ text: '✅ Batch بعدی دریافت شد', callback_data: 'review_noop', style: 'success' }]] };
}

export function rejectReasonsInline(id) {
  const reasons = ['نامناسب', 'هیت یا بی احترامی', 'تکراری', 'سیاسی', 'نامفهوم'];
  return {
    inline_keyboard: [
      ...reasons.map((r) => [
        { text: r, callback_data: 'reject:' + id + ':' + r, style: 'danger' },
      ]),
      [{ text: 'سایر (تایپ دلیل)', callback_data: 'reject_other:' + id, style: 'primary' }],
      [{ text: 'انصراف', callback_data: 'reject_cancel:' + id, style: 'primary' }],
    ],
  };
}

export function feedbackInline(id, userId) {
  return {
    inline_keyboard: [
      [
        { text: 'پاسخ', callback_data: 'fb_reply:' + id, style: 'primary' },
        { text: 'بستن', callback_data: 'fb_close:' + id, style: 'success' },
      ],
      [{ text: 'مشاهده کاربر', callback_data: 'fb_user:' + userId, style: 'primary' }],
    ],
  };
}

export function userOpenInline(userId) {
  return {
    inline_keyboard: [
      [{ text: 'مشاهده کاربر', callback_data: 'uv:' + userId, style: 'primary' }],
    ],
  };
}

/** takenMap: startHm -> adminId ; myStarts: Set */
export function shiftSlotsInline(channelKey, takenMap, myStarts, slotsOverride) {
  const slots = slotsOverride && slotsOverride.length ? slotsOverride : buildShiftSlots();
  const rows = [];
  for (const s of slots) {
    const key = s.hourKey || s.start;
    // takenMap may use hourKey or startHm
    let takenBy = takenMap[key] || takenMap[s.start];
    if (!takenBy) {
      // match any taken start in same hour bucket
      for (const [k, v] of Object.entries(takenMap || {})) {
        if (String(k).slice(0, 2) === String(key).slice(0, 2)) {
          takenBy = v;
          break;
        }
      }
    }
    const isMine =
      myStarts &&
      (myStarts.has(s.start) ||
        myStarts.has(key) ||
        [...myStarts].some((x) => String(x).slice(0, 2) === String(key).slice(0, 2)));
    if (takenBy && !isMine) {
      rows.push([
        {
          text: s.label + ' (پر)',
          callback_data: 'shift_full:' + channelKey + ':' + key,
          style: 'danger',
        },
      ]);
    } else if (isMine) {
      rows.push([
        {
          text: s.label + ' (شما — لغو)',
          callback_data: 'shift_cancel:' + channelKey + ':' + key,
          style: 'danger',
        },
      ]);
    } else {
      rows.push([
        {
          text: s.label,
          callback_data: 'shift_pick:' + channelKey + ':' + s.start + ':' + s.end,
          style: 'success',
        },
      ]);
    }
  }
  rows.push([{ text: 'بستن', callback_data: 'shift_close', style: 'danger' }]);
  return { inline_keyboard: rows };
}

export function adminListInline(admins, channelKey) {
  const rows = [];
  for (const a of admins) {
    const name = (a.display || String(a.userId)).slice(0, 40);
    rows.push([
      { text: name, callback_data: 'uv:' + a.userId, style: 'primary' },
      {
        text: 'حذف',
        callback_data: 'adel:' + channelKey + ':' + a.userId,
        style: 'danger',
      },
    ]);
  }
  rows.push([
    { text: 'افزودن ادمین', callback_data: 'aadd:' + channelKey, style: 'success' },
  ]);
  rows.push([
    {
      text: 'بروزرسانی از گروه',
      callback_data: 'async:' + channelKey,
      style: 'primary',
    },
  ]);
  return { inline_keyboard: rows };
}


export function announceTargetInline() {
  return {
    inline_keyboard: [
      [{ text: '👮 فقط ادمین‌ها', callback_data: 'ann_target:admins', style: 'primary' }],
      [{ text: '👥 همه کاربران', callback_data: 'ann_target:all', style: 'success' }],
      [{ text: 'لغو', callback_data: 'ann_cancel', style: 'danger' }],
    ],
  };
}

export function ownerShiftMenuInline() {
  return {
    inline_keyboard: [
      [{ text: '📅 تخصیص شیفت روزانه', callback_data: 'own_shift:daily', style: 'success' }],
      [{ text: '♾️ تخصیص شیفت دائمی', callback_data: 'own_shift:perm', style: 'primary' }],
    ],
  };
}

export function announceProgressInline(done) {
  if (done) {
    return { inline_keyboard: [[{ text: '✅ تمام شد', callback_data: 'ann_noop', style: 'success' }]] };
  }
  return {
    inline_keyboard: [
      [{ text: '▶️ ادامه ارسال', callback_data: 'ann_continue', style: 'success' }],
      [{ text: '⏹ توقف', callback_data: 'ann_stop', style: 'danger' }],
    ],
  };
}
