/**
 * تنظیمات ثابت ربات آرال (Serverless)
 * توکن Bot API اینجا نمی‌آید — پلتفرم خودش از طریق sdk/api وصل است.
 */

/** مالک‌ها — آیدی عددی تلگرام */
export const OWNER_IDS = [
  6666610646,
  8302194171,
  8434360251,
];

/** کانال‌ها */
export const CHANNELS = {
  sadambazan: {
    key: 'sadambazan',
    title: 'صدام بزن',
    prefixes: ['صدام بزن'],
  },
  inkarbar: {
    key: 'inkarbar',
    title: 'این کاربر',
    prefixes: ['این کاربر'],
  },
  zendegi: {
    key: 'zendegi',
    title: 'تو زندگی بعدی',
    prefixes: ['تو زندگی بعدی'],
  },
};

export const DEFAULT_CHANNEL_KEY = 'sadambazan';

export const WELCOME_TEXT =
  'به ربات هوشمند آرال خوش آمدید.\n\n' +
  'از منوی زیر یک گزینه را انتخاب کنید.';

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
