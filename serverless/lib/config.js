export const OWNER_IDS = [6666610646, 8302194171, 8434360251];

/** کانال‌های پیش‌فرض (اگر جدول channels خالی باشد seed می‌شود) */
export const DEFAULT_CHANNELS = {
  sadambazan: {
    key: 'sadambazan',
    title: 'صدام بزن',
    prefixes: ['صدام بزن'],
    link: '',
    workStart: '00:00',
    workEnd: '23:59',
  },
  inkarbar: {
    key: 'inkarbar',
    title: 'این کاربر',
    prefixes: ['این کاربر'],
    link: '',
    workStart: '00:00',
    workEnd: '23:59',
  },
  zendegi: {
    key: 'zendegi',
    title: 'تو زندگی بعدی',
    prefixes: ['تو زندگی بعدی'],
    link: '',
    workStart: '11:00',
    workEnd: '00:00',
  },
};

export const CHANNEL_PREFIXES = [
  { key: 'sadambazan', prefix: 'صدام بزن' },
  { key: 'inkarbar', prefix: 'این کاربر' },
  { key: 'zendegi', prefix: 'تو زندگی بعدی' },
];

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
