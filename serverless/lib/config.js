import { buildAvailableShiftSlots } from 'lib/time';

export const OWNER_IDS = [6666610646, 8302194171, 8434360251, 8476063231];

/** آدرس مینی‌اپ چت ارسال پیام (tgcloud static) */
export const MINI_APP_URL = 'https://app8730417878.tgcloud.ai/';

export const CHANNEL_USERNAMES = {
  sadambazan: 'callMeAraIl',
  inkarbar: 'inKarbariral',
  zendegi: 'arialcuple',
  fekrmikardam: 'fekrmi',
};

export const CHANNEL_IDS = {
  sadambazan: -1003877061735,
  inkarbar: -1003764383335,
  zendegi: -1004371148799,
  fekrmikardam: -1003964656653,
};

export const ADMIN_GROUP_IDS = {
  sadambazan: -1004444089094,
  inkarbar: -1004335935102,
  zendegi: -1003812392984,
  fekrmikardam: null,
};

export const DEFAULT_CHANNELS = {
  sadambazan: {
    key: 'sadambazan',
    title: 'صدام بزن',
    prefixes: ['صدام بزن'],
    chatId: CHANNEL_IDS.sadambazan,
    adminGroupId: ADMIN_GROUP_IDS.sadambazan,
    workStart: '12:00',
    workEnd: '00:00',
  },
  inkarbar: {
    key: 'inkarbar',
    title: 'این کاربر',
    prefixes: ['این کاربر'],
    chatId: CHANNEL_IDS.inkarbar,
    adminGroupId: ADMIN_GROUP_IDS.inkarbar,
    workStart: '12:00',
    workEnd: '00:00',
  },
  zendegi: {
    key: 'zendegi',
    title: 'تو زندگی بعدی',
    prefixes: ['تو زندگی بعدی'],
    chatId: CHANNEL_IDS.zendegi,
    adminGroupId: ADMIN_GROUP_IDS.zendegi,
    workStart: '12:00',
    workEnd: '00:00',
  },
  fekrmikardam: {
    key: 'fekrmikardam',
    title: 'من فکر میکردم',
    prefixes: ['من فکر میکردم'],
    chatId: CHANNEL_IDS.fekrmikardam,
    adminGroupId: ADMIN_GROUP_IDS.fekrmikardam,
    workStart: '12:00',
    workEnd: '00:00',
  },
};

export const CHANNEL_PREFIXES = [
  { key: 'sadambazan', prefix: 'صدام بزن' },
  { key: 'inkarbar', prefix: 'این کاربر' },
  { key: 'zendegi', prefix: 'تو زندگی بعدی' },
  { key: 'fekrmikardam', prefix: 'من فکر میکردم' },
];

export const WELCOME_TEXT =
  'سلام قشنگم 🎀\n' +
  'به ربات آرال خوش اومدی 🩵\n\n' +
  'از منوی پایین یکی رو انتخاب کن و بزن بریم ✨';

export const RULES_TEXT =
  'پیامت رو بفرست 🎀\n\n' +
  'با «صدام بزن / این کاربر / تو زندگی بعدی / من فکر میکردم» شروع بشه 🩵\n\n' +
  'سیاسی و بی‌احترامی و ناسزا نباشه 🌟\n\n' +
  'چند تا پشت‌سرهم هم اوکیه ✨\n' +
  'حداکثر ۶ تا در ۱۰ دقیقه 💚\n\n' +
  'مرسی ازت — مجموعه آرال 🎀';

export const BOT_DISABLED_TEXT =
  '🔴 ربات الان خاموشه 🌬\n\n' +
  'پیامت ثبت نشد — خرابی نیست، یه توقف عمدیه 🩵\n' +
  'یه کم دیگه دوباره سر بزن ✨';

export const FEEDBACK_HINT =
  '💬 اینجا فقط برای حرف زدن با مالکه 🎀\n' +
  'انتقاد، پیشنهاد یا گزارش مشکل — هر چی دلت خواست 🩵\n\n' +
  'اگه می‌خوای پیامت بره تو کانال، از\n' +
  '📝 ارسال پیام\n' +
  'استفاده کن ✨';

export function buildShiftSlots() {
  return buildAvailableShiftSlots();
}
