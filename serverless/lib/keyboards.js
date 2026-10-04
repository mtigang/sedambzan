/** تضمین می‌کند همه text دکمه‌ها String و غیرخالی باشند */
export function btnText(v, fallback) {
  let s = v == null ? '' : String(v);
  s = s.trim();
  if (!s) s = fallback != null ? String(fallback) : '•';
  if (s.length > 64) s = s.slice(0, 61) + '…';
  return s;
}

/** فیلدهای مجاز دکمه اینلاین تلگرام — style رسمی Bot API 9.4+ (primary/success/danger) */
const INLINE_OK = {
  text: 1,
  url: 1,
  callback_data: 1,
  web_app: 1,
  login_url: 1,
  switch_inline_query: 1,
  switch_inline_query_current_chat: 1,
  switch_inline_query_chosen_chat: 1,
  callback_game: 1,
  pay: 1,
  copy_text: 1,
  icon_custom_emoji_id: 1,
  style: 1,
};

const STYLE_OK = { primary: 1, success: 1, danger: 1 };

export function sanitizeMarkup(markup) {
  if (!markup || typeof markup !== 'object') return markup;
  const out = {};
  if (markup.resize_keyboard != null) out.resize_keyboard = !!markup.resize_keyboard;
  if (markup.one_time_keyboard != null) out.one_time_keyboard = !!markup.one_time_keyboard;
  if (markup.selective != null) out.selective = !!markup.selective;
  if (markup.is_persistent != null) out.is_persistent = !!markup.is_persistent;
  if (markup.input_field_placeholder != null) {
    out.input_field_placeholder = String(markup.input_field_placeholder);
  }
  if (markup.remove_keyboard) {
    out.remove_keyboard = true;
    return out;
  }

  if (Array.isArray(markup.inline_keyboard)) {
    out.inline_keyboard = markup.inline_keyboard
      .map(function (row) {
        if (!Array.isArray(row)) return null;
        return row
          .map(function (b) {
            if (!b || typeof b !== 'object') return null;
            const nb = {};
            nb.text = btnText(b.text, '•');
            for (const k of Object.keys(b)) {
              if (k === 'text') continue;
              if (!INLINE_OK[k]) continue;
              const v = b[k];
              if (v == null) continue;
              if (k === 'style') {
                const st = String(v).toLowerCase();
                if (STYLE_OK[st]) nb.style = st;
                continue;
              }
              if (typeof v === 'object') nb[k] = v;
              else nb[k] = String(v);
            }
            // حداقل text لازم است
            if (!nb.text) nb.text = '•';
            return nb;
          })
          .filter(Boolean);
      })
      .filter(function (row) {
        return row && row.length;
      });
  }

  if (Array.isArray(markup.keyboard)) {
    out.keyboard = markup.keyboard
      .map(function (row) {
        if (!Array.isArray(row)) return null;
        return row
          .map(function (b) {
            if (typeof b === 'string' || typeof b === 'number') {
              return { text: btnText(b, '•') };
            }
            if (!b || typeof b !== 'object') return null;
            const nb = { text: btnText(b.text, '•') };
            if (b.request_contact) nb.request_contact = true;
            if (b.request_location) nb.request_location = true;
            if (b.style != null) {
              const st = String(b.style).toLowerCase();
              if (STYLE_OK[st]) nb.style = st;
            }
            return nb;
          })
          .filter(Boolean);
      })
      .filter(function (row) {
        return row && row.length;
      });
  }

  return out;
}


import { DEFAULT_CHANNELS, buildShiftSlots } from 'lib/config';

export function userKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '📝 ارسال پیام' }, { text: '📊 وضعیت پیام من' }],
      [{ text: '💬 انتقادات، پیشنهادات، گزارش مشکل' }],
    ],
    resize_keyboard: true,
  });
}

export function adminKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '⏰ شیفت من' }],
      [{ text: '📊 عملکرد من' }],
    ],
    resize_keyboard: true,
  });
}

export function ownerKeyboard(uid) {
  const rows = [
    [{ text: '📥 پیام‌های در انتظار' }, { text: '📬 پیام کاربران' }],
    [{ text: '⏰ شیفت‌ها' }, { text: '📊 آمار' }],
    [{ text: '👥 ادمین‌ها' }, { text: '🛡️ ساب‌لیدرها' }],
    [{ text: '⚙️ ابزار ربات' }, { text: '🔍 جستجو' }],
  ];
  // فقط مالک ۶۶۶۶۶۱۰۶۴۶
  if (Number(uid) === 6666610646) {
    rows.push([{ text: '📦 ارسال دیتا بیس' }]);
  }
  return sanitizeMarkup({
    keyboard: rows,
    resize_keyboard: true,
  });
}

export function dbExportContinueInline(done) {
  if (done) {
    return sanitizeMarkup({
      inline_keyboard: [[{ text: '✅ تمام شد', callback_data: 'dbexp_noop', style: 'success' }]],
    });
  }
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '▶️ ادامه (۱۱۰ ردیف)', callback_data: 'dbexp_cont', style: 'primary' }],
      [{ text: '❌ لغو', callback_data: 'dbexp_cancel', style: 'danger' }],
    ],
  });
}

export function subLeaderKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '📥 پیام‌های در انتظار' }, { text: '👥 ادمین‌های من' }],
      [{ text: '➕ افزودن ادمین' }, { text: '⏰ شیفت من' }],
      [{ text: '📋 شیفت‌های کانال' }, { text: '🔎 جستجوی پیام' }],
      [{ text: '📊 آمار کانال' }, { text: '📢 اطلاعیه برای ادمین‌ها' }],
      [{ text: 'ℹ️ اطلاعات کانال' }],
    ],
    resize_keyboard: true,
  });
}

export function ownerSubLeaderMenuKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '➕ افزودن ساب‌لیدر' }],
      [{ text: '👥 لیست ساب‌لیدرها' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  });
}

export function backKeyboard() {
  return { keyboard: [[{ text: '◀️ بازگشت' }]], resize_keyboard: true };
}

export function settingsKeyboard(botOn) {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '📢 حالت تب' }, { text: botOn ? '🔴 خاموش کردن ربات' : '🟢 روشن کردن ربات' }],
      [{ text: '📣 اطلاعیه' }, { text: '📣 ارسال' }],
      [{ text: '🗑 پاک‌سازی pending کاربر' }, { text: '🧹 پاک‌سازی صف' }],
      [{ text: '🧪 تست کانال‌ها' }, { text: '📤 انتشار مستقیم صف' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  });
}

/** انتخاب کانال برای خاموش/تب — رنگی */
export function channelPickFlagsInline(prefix) {
  // prefix: choff | chon | chad | chad_off
  const style = { sadambazan: 'success', inkarbar: 'primary', zendegi: 'primary', all: 'danger' };
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: 'صدام بزن', callback_data: prefix + ':sadambazan', style: style.sadambazan }],
      [{ text: 'این کاربر', callback_data: prefix + ':inkarbar', style: style.inkarbar }],
      [{ text: 'تو زندگی بعدی', callback_data: prefix + ':zendegi', style: style.zendegi }],
      [{ text: 'همه کانال‌ها', callback_data: prefix + ':all', style: style.all }],
      [{ text: 'انصراف', callback_data: prefix + ':cancel', style: 'danger' }],
    ],
  });
}

export function sendDestInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '📢 ارسال به کانال', callback_data: 'send_dest:channel', style: 'primary' }],
      [{ text: '👤 ارسال به کاربر', callback_data: 'send_dest:user', style: 'success' }],
      [{ text: 'انصراف', callback_data: 'send_dest:cancel', style: 'danger' }],
    ],
  });
}

export function searchKeyboard() {
  return sanitizeMarkup({
    keyboard: [
      [{ text: '🔎 جستجوی پیام' }, { text: '🔎 جستجوی کاربر' }],
      [{ text: '◀️ بازگشت' }],
    ],
    resize_keyboard: true,
  });
}

export function channelAdminPickKeyboard() {
  const rows = Object.values(DEFAULT_CHANNELS).map((c) => [
    { text: btnText('ادمین‌های ' + (c.title || c.key || ''), 'ادمین‌ها') },
  ]);
  rows.push([{ text: '◀️ بازگشت' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function shiftChannelPickKeyboard(channelList) {
  const rows = channelList.map((c) => [{ text: btnText('شیفت: ' + (c.title || c.key || ''), 'شیفت') }]);
  rows.push([{ text: '◀️ بازگشت' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function postChannelInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: 'صدام بزن', callback_data: 'postch:sadambazan', style: 'success' }],
      [{ text: 'این کاربر', callback_data: 'postch:inkarbar', style: 'primary' }],
      [{ text: 'تو زندگی بعدی', callback_data: 'postch:zendegi', style: 'primary' }],
      [{ text: 'لغو', callback_data: 'postch_cancel', style: 'danger' }],
    ],
  });
}

export function confirmPostInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: 'تأیید ارسال', callback_data: 'post_yes', style: 'success' },
        { text: 'انصراف', callback_data: 'post_no', style: 'danger' },
      ],
    ],
  });
}

export function ownerReviewInline(id) {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '✅ تأیید', callback_data: 'approve:' + id, style: 'success' },
        { text: '❌ رد', callback_data: 'reject_direct:' + id, style: 'danger' },
      ],
    ],
  });
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
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function reviewNextInline(batchNumber) {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        {
          text: '📥 دریافت Batch بعدی' + (batchNumber != null ? ' (' + batchNumber + ')' : ''),
          callback_data: 'review_next' + (batchNumber != null ? ':' + batchNumber : ''),
          style: 'success',
        },
      ],
    ],
  });
}

export function reviewDoneInline() {
  return sanitizeMarkup({
    inline_keyboard: [[{ text: '✅ صف خالی شد', callback_data: 'review_done', style: 'primary' }]],
  });
}

export function reviewTakenInline() {
  return sanitizeMarkup({
    inline_keyboard: [[{ text: '📥 ارسال شد', callback_data: 'review_taken', style: 'primary' }]],
  });
}

export function rejectReasonsInline(id) {
  const reasons = ['نامناسب', 'هیت یا بی احترامی', 'تکراری', 'سیاسی', 'نامفهوم'];
  return sanitizeMarkup({
    inline_keyboard: [
      ...reasons.map((r) => [
        { text: btnText(r, 'دلیل'), callback_data: 'reject:' + id + ':' + r, style: 'danger' },
      ]),
      [{ text: 'سایر (تایپ دلیل)', callback_data: 'reject_other:' + id, style: 'primary' }],
      [{ text: 'انصراف', callback_data: 'reject_cancel:' + id, style: 'primary' }],
    ],
  });
}

export function feedbackInline(id, userId) {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: 'پاسخ', callback_data: 'fb_reply:' + id, style: 'success' },
        { text: 'بستن', callback_data: 'fb_close:' + id, style: 'danger' },
      ],
      [{ text: 'مشاهده کاربر', callback_data: 'fb_user:' + userId, style: 'primary' }],
    ],
  });
}

export function userOpenInline(userId) {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: 'مشاهده کاربر', callback_data: 'uv:' + userId, style: 'primary' }],
    ],
  });
}

/** takenMap: startHm -> adminId ; myStarts: Set ; ownerMode: مالک بتواند شیفت دیگران را لغو کند */

export function shiftModePickInline(channelKey) {
  const ck = String(channelKey || '');
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '📅 شیفت روزانه (فقط همین دوره)', callback_data: 'shift_mode|daily|' + ck, style: 'primary' }],
      [{ text: '♾️ شیفت دائمی (هر روز)', callback_data: 'shift_mode|perm|' + ck, style: 'success' }],
      [{ text: 'انصراف', callback_data: 'shift_close', style: 'danger' }],
    ],
  });
}

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
            text: btnText((s.label || s.hourKey || 'شیفت') + ' (پر — لغو مالک)', 'پر'),
            callback_data: 'shift_ocancel|' + channelKey + '|' + key,
            style: 'danger',
          },
        ]);
      } else {
        rows.push([
          {
            text: btnText((s.label || s.hourKey || 'شیفت') + ' (پر)', 'پر'),
            callback_data: 'shift_full|' + channelKey + '|' + key,
            style: 'danger',
          },
        ]);
      }
    } else if (isMine) {
      rows.push([
        {
          text: btnText((s.label || s.hourKey || 'شیفت') + ' (شما — لغو)', 'لغو'),
          callback_data: 'shift_cancel|' + channelKey + '|' + key,
          style: 'danger',
        },
      ]);
    } else {
      rows.push([
        {
          text: btnText(s.label || s.hourKey || 'شیفت', 'شیفت'),
          callback_data: 'shift_pick|' + channelKey + '|' + String(s.start || '') + '|' + String(s.end || ''),
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
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function adminListInline(admins, channelKey) {
  const rows = [];
  for (const a of admins) {
    const name = String(a.display || a.userId || 'کاربر').slice(0, 40);
    rows.push([
      { text: btnText(name, 'کاربر'), callback_data: 'uv:' + a.userId, style: 'primary' },
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
  return sanitizeMarkup({ inline_keyboard: rows });
}


export function announceTargetInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '👮 فقط ادمین‌ها', callback_data: 'ann_target:admins', style: 'primary' }],
      [{ text: '👥 همه کاربران', callback_data: 'ann_target:all', style: 'success' }],
      [{ text: 'لغو', callback_data: 'ann_cancel', style: 'danger' }],
    ],
  });
}

export function ownerShiftMenuInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '📅 تخصیص شیفت روزانه', callback_data: 'own_shift:daily', style: 'primary' }],
      [{ text: '♾️ تخصیص شیفت دائمی', callback_data: 'own_shift:perm', style: 'primary' }],
      [{ text: '📋 لیست و لغو شیفت‌ها', callback_data: 'own_shift_list', style: 'primary' }],
      [{ text: '🗑 لغو همه شیفت‌های دوره', callback_data: 'own_cancel_all', style: 'danger' }],
    ],
  });
}

/** متن دکمه را به String امن تلگرام تبدیل می‌کند */
function safeBtnLabel(v, maxLen) {
  maxLen = maxLen || 60;
  let s = v == null ? '' : String(v);
  // حذف کاراکترهای کنترل و صفرعرض که گاهی text را خراب می‌کنند
  s = s.replace(/[\u0000-\u001F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = '—';
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

/** دکمه‌های لغو — قرمز، ساعت داخل دکمه، کلیک = لغو کامل */
export function ownerCancelShiftsInline(shiftRows) {
  const rows = [];
  const list = (shiftRows || []).slice(0, 35);
  for (const s of list) {
    const id = Number(s && s.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const start = safeBtnLabel(s.startHm != null ? s.startHm : '', 5);
    const end = safeBtnLabel(s.endHm != null ? s.endHm : '', 5);
    const whoRaw = s.name != null ? s.name : s.adminId != null ? s.adminId : '';
    const who = safeBtnLabel(whoRaw, 16);
    // فقط ساعت + نام کوتاه — بدون کاراکتر عجیب
    const label = safeBtnLabel('❌ ' + start + '-' + end + ' | ' + who, 64);
    rows.push([
      {
        text: label,
        callback_data: 'own_sc:' + String(id),
        style: 'danger',
      },
    ]);
  }
  if (!rows.length) {
    return sanitizeMarkup({
      inline_keyboard: [[{ text: 'بستن', callback_data: 'shift_close', style: 'primary' }]],
    });
  }
  rows.push([
    { text: '🗑 لغو همه دوره', callback_data: 'own_cancel_all', style: 'danger' },
    { text: 'بستن', callback_data: 'shift_close', style: 'primary' },
  ]);
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function announceProgressInline(done) {
  if (done) {
    return { inline_keyboard: [[{ text: '✅ تمام شد', callback_data: 'ann_noop', style: 'success' }]] };
  }
  return sanitizeMarkup({
    inline_keyboard: [
      [{ text: '▶️ ادامه ارسال', callback_data: 'ann_continue', style: 'success' }],
      [{ text: '⏹ توقف', callback_data: 'ann_stop', style: 'danger' }],
    ],
  });
}

export function subLeaderPickChannelInline() {
  const rows = [];
  for (const c of Object.values(DEFAULT_CHANNELS)) {
    rows.push([{ text: '📢 ' + c.title, callback_data: 'sl_setch:' + c.key, style: 'primary' }]);
  }
  rows.push([{ text: 'لغو', callback_data: 'sl_cancel', style: 'danger' }]);
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function subLeaderListInline(items) {
  const rows = [];
  for (const it of items || []) {
    const title =
      (DEFAULT_CHANNELS[it.channelKey] && DEFAULT_CHANNELS[it.channelKey].title) || it.channelKey;
    const st = it.status === 'active' ? '🟢' : '🔴';
    rows.push([
      {
        text: btnText(st + ' ' + (it.display != null && it.display !== '' ? it.display : it.userId) + ' | ' + title, 'ساب‌لیدر'),
        callback_data: 'sl_view:' + it.userId,
        style: 'primary',
      },
    ]);
  }
  if (!rows.length) {
    rows.push([{ text: 'لیست خالی', callback_data: 'sl_noop', style: 'primary' }]);
  }
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function subLeaderManageInline(userId) {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '🔄 تغییر کانال', callback_data: 'sl_ch:' + userId, style: 'primary' },
        { text: '🚫 غیرفعال', callback_data: 'sl_off:' + userId, style: 'danger' },
      ],
    ],
  });
}

export function subLeaderAnnounceConfirmInline() {
  return sanitizeMarkup({
    inline_keyboard: [
      [
        { text: '✅ ارسال', callback_data: 'sl_ann_yes', style: 'success' },
        { text: '❌ لغو', callback_data: 'sl_ann_no', style: 'danger' },
      ],
    ],
  });
}

/**
 * لیست ادمین ساب‌لیدر با دکمه حذف.
 * روی دکمه‌ها فقط شناسه عددی امن می‌آید (نه اسم خام) تا خطای
 * "text must be of type String" از اسم‌های خراب/یونیکد پیش نیاید.
 * خروجی: { markup, skipped[] } — skipped = ادمین‌هایی که دکمه نشدند.
 */
export function subLeaderAdminsInline(admins, channelKey) {
  const rows = [];
  const skipped = [];
  const ch = channelKey != null ? String(channelKey) : '';
  for (const a of admins || []) {
    const uid = a && (a.userId != null ? a.userId : a.user_id);
    const uidNum = Number(uid);
    const fullName = a
      ? String(a.display != null && a.display !== '' ? a.display : uid != null ? uid : 'کاربر')
      : 'کاربر';
    // فقط اگر userId عددی معتبر باشد دکمه ساخته می‌شود
    if (!uidNum || !Number.isFinite(uidNum)) {
      skipped.push({ userId: uid, display: fullName, reason: 'userId نامعتبر' });
      continue;
    }
    // برچسب دکمه: فقط عدد — همیشه String امن
    const label = btnText(String(uidNum), String(uidNum));
    rows.push([
      { text: label, callback_data: 'sl_ainfo:' + uidNum, style: 'primary' },
      {
        text: btnText('حذف', 'حذف'),
        callback_data: 'sl_adel:' + ch + ':' + uidNum,
        style: 'danger',
      },
    ]);
  }
  if (!rows.length) {
    rows.push([{ text: btnText('ادمینی نیست', '—'), callback_data: 'sl_noop', style: 'primary' }]);
  }
    rows.push([
    {
      text: btnText('➕ افزودن ادمین', 'افزودن'),
      callback_data: 'sl_aadd:' + String(ch || channelKey || ''),
      style: 'success',
    },
  ]);
return { markup: sanitizeMarkup({ inline_keyboard: rows }), skipped: skipped };
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
  return sanitizeMarkup({ inline_keyboard: rows });
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
  return sanitizeMarkup({ inline_keyboard: rows });
}

export function flushConfirmInline(channelKey) {
  return sanitizeMarkup({
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
  });
}

export function purgeUserConfirmInline(targetId, count) {
  return sanitizeMarkup({
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
  });
}

export function purgeUserProgressInline(targetId, finished) {
  if (finished) {
    return sanitizeMarkup({
      inline_keyboard: [[{ text: '✅ تمام', callback_data: 'purge_user_cancel', style: 'success' }]],
    });
  }
  return sanitizeMarkup({
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
  });
}
