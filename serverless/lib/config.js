export const OWNER_IDS = [6666610646, 8302194171, 8434360251];

/** آیدی عددی کانال‌ها — ثابت تا آخر */
export const CHANNEL_IDS = {
  sadambazan: -1003877061735,
  inkarbar: -1003764383335,
  zendegi: -1004371148799,
};

/** گروه ادمین‌های هر کانال — اعضا = ادمین همان کانال در ربات */
export const ADMIN_GROUP_IDS = {
  sadambazan: -1004444089094,
  inkarbar: -1004335935102,
  zendegi: -1003812392984,
};

export const DEFAULT_CHANNELS = {
  sadambazan: {
    key: 'sadambazan',
    title: 'صدام بزن',
    prefixes: ['صدام بزن'],
    chatId: CHANNEL_IDS.sadambazan,
    adminGroupId: ADMIN_GROUP_IDS.sadambazan,
    workStart: '00:00',
    workEnd: '23:59',
  },
  inkarbar: {
    key: 'inkarbar',
    title: 'این کاربر',
    prefixes: ['این کاربر'],
    chatId: CHANNEL_IDS.inkarbar,
    adminGroupId: ADMIN_GROUP_IDS.inkarbar,
    workStart: '00:00',
    workEnd: '23:59',
  },
  zendegi: {
    key: 'zendegi',
    title: 'تو زندگی بعدی',
    prefixes: ['تو زندگی بعدی'],
    chatId: CHANNEL_IDS.zendegi,
    adminGroupId: ADMIN_GROUP_IDS.zendegi,
    workStart: '11:00',
    workEnd: '00:00',
  },
};

export const CHANNEL_PREFIXES = [
  { key: 'sadambazan', prefix: 'صدام بزن' },
  { key: 'inkarbar', prefix: 'این کاربر' },
  { key: 'zendegi', prefix: 'تو زندگی بعدی' },
];

/** شیفت‌ها: ۱۰ صبح تا ۲ بامداد، یک‌ساعته */
export function buildShiftSlots() {
  const slots = [];
  // 10:00 .. 23:00
  for (let h = 10; h <= 23; h++) {
    const start = String(h).padStart(2, '0') + ':00';
    const end = h === 23 ? '00:00' : String(h + 1).padStart(2, '0') + ':00';
    slots.push({ start, end, label: start + '–' + end });
  }
  // 00:00-01:00, 01:00-02:00
  slots.push({ start: '00:00', end: '01:00', label: '00:00–01:00' });
  slots.push({ start: '01:00', end: '02:00', label: '01:00–02:00' });
  return slots;
}

export const WELCOME_TEXT =
  'به ربات هوشمند آرال خوش آمدید.\n\nاز منوی زیر یک گزینه را انتخاب کنید.';

export const RULES_TEXT =
  '📝 پیام خودت را بفرست.\n\n' +
  '• با «صدام بزن / این کاربر / تو زندگی بعدی» شروع شود .\n' +
  '• کل پیام Bold باشد .\n' +
  '• با « .» تمام شود .\n' +
  '• لینک نداشته باشد .\n' +
  '• فاقد هر گونه ایموجی باشد .\n' +
  '• محتوا سیاسی نباشد .\n' +
  '• هیت نباشد .';

export const BOT_DISABLED_TEXT =
  '🔴 ربات در حال حاضر غیرفعال است.\n\nلطفاً بعداً دوباره امتحان کنید.';

export const FEEDBACK_HINT =
  '💬 این دکمه فقط برای ارسال انتقاد، پیشنهاد یا گزارش مشکل به **مالک** است.\n\n' +
  'اگر می‌خواهید پیام‌تان در کانال منتشر شود، از گزینه\n' +
  '📝 ارسال پیام\n' +
  'استفاده کنید.';
