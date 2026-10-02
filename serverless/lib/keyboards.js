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
      [{ text: '🛡️ ساب‌لیدرها' }, { text: '⚙️ تنظیمات' }],
    ],
    resize_keyboard: true,
  };
}

export function subLeaderKeyboard() {
  return {
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '👥 ادمین‌های من' }],
      [{ text: '⏰ مدیریت شیفت‌ها' }, { text: '📊 آمار کانال' }],
      [{ text: '📢 اطلاعیه برای ادمین‌ها' }],
      [{ text: 'ℹ️ اطلاعات کانال' }],
    ],
    resize_keyboard: true,
  };
}

export function ownerSubLeaderMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '➕ افزودن ساب‌لیدر' }],
      [{ text: '👥 لیست ساب‌لیدرها' }],
      [{ text: '◀️ بازگشت' }],
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
      [{ text: '🧪 تست کانال‌ها' }],
      [{ text: '📤 انتشار مستقیم صف' }],
      [{ text: '🗑 پاک‌سازی pending کاربر' }],
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

export function ownerReviewInline(id) {
  return {
    inline_keyboard: [
      [
        { text: '✅ تأیید', callback_data: 'approve:' + id, style: 'success' },
        { text: '❌ رد', callback_data: 'reject_direct:' + id, style: 'danger' },
      ],
    ],
  };
}

export function reviewInline(id, showNext, batchNumber) {
  const rows = [
    [
      { text: 'تأیید', callback_data: 'approve:' + id, style: 'success' },
      { text: 'رد', callback_data: 'reject_menu:' + id, style: 'danger' },
    ],
  ];
  if (showNext) {
    rows.push([
      {
        text: '📥 Batch بعدی' + (batchNumber != null ? ' (' + batchNumber + ')' : ''),
        callback_data: 'review_next' + (batchNumber != null ? ':' + batchNumber : ''),
        style: 'primary',
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function reviewNextInline(batchNumber) {
  return {
    inline_keyboard: [
      [
        {
          text: '📥 دریافت Batch بعدی' + (batchNumber != null ? ' (' + batchNumber + ')' : ''),
          callback_data: 'review_next' + (batchNumber != null ? ':' + batchNumber : ''),
          style: 'success',
        },
      ],
    ],
  };
}

export function reviewDoneInline() {
  return {
    inline_keyboard: [[{ text: '✅ صف خالی شد', callback_data: 'review_done', style: 'primary' }]],
  };
}

export function reviewTakenInline() {
  return {
    inline_keyboard: [[{ text: '📥 ارسال شد', callback_data: 'review_taken', style: 'primary' }]],
  };
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

/** takenMap: startHm -> adminId ; myStarts: Set ; ownerMode: مالک بتواند شیفت دیگران را لغو کند */
export function shiftSlotsInline(channelKey, takenMap, myStarts, slotsOverride, ownerMode) {
  const slots = slotsOverride && slotsOverride.length ? slotsOverride : buildShiftSlots();
  const rows = [];
  function bucket(hm) {
    const parts = String(hm || '0').split(':');
    const h = Number(parts[0]) || 0;
    return String(h).padStart(2, '0') + ':00';
  }
  const takenNorm = {};
  for (const [k, v] of Object.entries(takenMap || {})) {
    // skip invalid zero-length markers
    if (!k) continue;
    takenNorm[bucket(k)] = v;
  }
  const myNorm = new Set();
  if (myStarts) {
    for (const x of myStarts) myNorm.add(bucket(x));
  }
  for (const s of slots) {
    const key = bucket(s.hourKey || s.start);
    const takenBy = takenNorm[key];
    const isMine = myNorm.has(key);
    if (takenBy && !isMine) {
      if (ownerMode) {
        rows.push([
          {
            text: s.label + ' (پر — لغو مالک)',
            callback_data: 'shift_ocancel|' + channelKey + '|' + key,
            style: 'danger',
          },
        ]);
      } else {
        rows.push([
          {
            text: s.label + ' (پر)',
            callback_data: 'shift_full|' + channelKey + '|' + key,
            style: 'danger',
          },
        ]);
      }
    } else if (isMine) {
      rows.push([
        {
          text: s.label + ' (شما — لغو)',
          callback_data: 'shift_cancel|' + channelKey + '|' + key,
          style: 'danger',
        },
      ]);
    } else {
      rows.push([
        {
          text: s.label,
          callback_data: 'shift_pick|' + channelKey + '|' + s.start + '|' + s.end,
          style: 'success',
        },
      ]);
    }
  }
  if (ownerMode) {
    rows.push([
      {
        text: '🗑 لغو همه شیفت‌های این کانال (امروز)',
        callback_data: 'shift_oclear|' + channelKey,
        style: 'danger',
      },
    ]);
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
      [{ text: '📋 لیست و لغو شیفت‌ها', callback_data: 'own_shift_list', style: 'primary' }],
      [{ text: '🗑 لغو همه شیفت‌های دوره', callback_data: 'own_cancel_all', style: 'danger' }],
    ],
  };
}

/** دکمه‌های لغو برای لیست شیفت مالک — هر شیفت یک دکمه */
export function ownerCancelShiftsInline(shiftRows) {
  const rows = [];
  const list = (shiftRows || []).slice(0, 40);
  for (const s of list) {
    const title =
      (s.channelTitle || s.channelKey || '').toString().slice(0, 12);
    const who = (s.name || String(s.adminId || '')).toString().slice(0, 18);
    const tm =
      String(s.startHm || '').slice(0, 5) + '–' + String(s.endHm || '').slice(0, 5);
    rows.push([
      {
        text: '❌ ' + title + ' | ' + tm + ' | ' + who,
        callback_data: 'own_sc:' + s.id,
        style: 'danger',
      },
    ]);
  }
  rows.push([
    { text: '🗑 لغو همه', callback_data: 'own_cancel_all', style: 'danger' },
    { text: 'بستن', callback_data: 'shift_close', style: 'primary' },
  ]);
  return { inline_keyboard: rows };
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

export function subLeaderPickChannelInline() {
  const rows = [];
  for (const c of Object.values(DEFAULT_CHANNELS)) {
    rows.push([{ text: '📢 ' + c.title, callback_data: 'sl_setch:' + c.key, style: 'primary' }]);
  }
  rows.push([{ text: 'لغو', callback_data: 'sl_cancel', style: 'danger' }]);
  return { inline_keyboard: rows };
}

export function subLeaderListInline(items) {
  const rows = [];
  for (const it of items || []) {
    const title =
      (DEFAULT_CHANNELS[it.channelKey] && DEFAULT_CHANNELS[it.channelKey].title) || it.channelKey;
    const st = it.status === 'active' ? '🟢' : '🔴';
    rows.push([
      {
        text: st + ' ' + (it.display || it.userId) + ' | ' + title,
        callback_data: 'sl_view:' + it.userId,
        style: 'primary',
      },
    ]);
  }
  if (!rows.length) {
    rows.push([{ text: 'لیست خالی', callback_data: 'sl_noop', style: 'primary' }]);
  }
  return { inline_keyboard: rows };
}

export function subLeaderManageInline(userId) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 تغییر کانال', callback_data: 'sl_ch:' + userId, style: 'primary' },
        { text: '🚫 غیرفعال', callback_data: 'sl_off:' + userId, style: 'danger' },
      ],
    ],
  };
}

export function subLeaderAnnounceConfirmInline() {
  return {
    inline_keyboard: [
      [
        { text: '✅ ارسال', callback_data: 'sl_ann_yes', style: 'success' },
        { text: '❌ لغو', callback_data: 'sl_ann_no', style: 'danger' },
      ],
    ],
  };
}

/** لیست ادمین ساب‌لیدر با دکمه حذف */
export function subLeaderAdminsInline(admins, channelKey) {
  const rows = [];
  for (const a of admins || []) {
    const name = String(a.display || a.userId).slice(0, 28);
    rows.push([
      { text: name, callback_data: 'sl_ainfo:' + a.userId, style: 'primary' },
      {
        text: 'حذف',
        callback_data: 'sl_adel:' + channelKey + ':' + a.userId,
        style: 'danger',
      },
    ]);
  }
  if (!rows.length) {
    rows.push([{ text: 'ادمینی نیست', callback_data: 'sl_noop', style: 'primary' }]);
  }
  return { inline_keyboard: rows };
}

export function flushChannelPickInline() {
  const rows = [];
  for (const c of Object.values(DEFAULT_CHANNELS)) {
    rows.push([
      {
        text: '📢 ' + c.title,
        callback_data: 'flush_ch:' + c.key,
        style: 'primary',
      },
    ]);
  }
  rows.push([{ text: 'لغو', callback_data: 'flush_cancel', style: 'danger' }]);
  return { inline_keyboard: rows };
}

export function flushProgressInline(finished, hasSkipped) {
  const rows = [];
  if (!finished) {
    rows.push([
      { text: '▶️ انتشار دسته بعدی', callback_data: 'flush_next', style: 'success' },
      { text: '⏹ توقف', callback_data: 'flush_stop', style: 'danger' },
    ]);
  } else {
    rows.push([{ text: '✅ تمام', callback_data: 'flush_noop', style: 'success' }]);
  }
  if (hasSkipped) {
    rows.push([
      {
        text: '👁 مشاهده ردشده‌های این انتشار',
        callback_data: 'flush_view_skip',
        style: 'primary',
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function flushConfirmInline(channelKey) {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ بله، منتشر کن',
          callback_data: 'flush_go:' + channelKey,
          style: 'success',
        },
        { text: 'لغو', callback_data: 'flush_cancel', style: 'danger' },
      ],
    ],
  };
}

export function purgeUserConfirmInline(targetId, count) {
  return {
    inline_keyboard: [
      [
        {
          text: '🗑 پاک کردن ۱۵تای اول (' + count + ' pending)',
          callback_data: 'purge_user_go:' + targetId,
          style: 'danger',
        },
      ],
      [{ text: 'لغو', callback_data: 'purge_user_cancel', style: 'primary' }],
    ],
  };
}

export function purgeUserProgressInline(targetId, finished) {
  if (finished) {
    return {
      inline_keyboard: [[{ text: '✅ تمام', callback_data: 'purge_user_cancel', style: 'success' }]],
    };
  }
  return {
    inline_keyboard: [
      [
        {
          text: '▶️ پاک کردن ۱۵تای بعدی',
          callback_data: 'purge_user_go:' + targetId,
          style: 'danger',
        },
        { text: '⏹ توقف', callback_data: 'purge_user_cancel', style: 'primary' },
      ],
    ],
  };
}
