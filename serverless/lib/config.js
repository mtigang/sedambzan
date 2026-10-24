import { buildAvailableShiftSlots } from 'lib/time';

export const OWNER_IDS = [6666610646, 8302194171, 8434360251];

/** آدرس مینی‌اپ چت ارسال پیام (tgcloud static) */
export const MINI_APP_URL = 'https://app8730417878.tgcloud.ai/';

export const CHANNEL_USERNAMES = {
  sadambazan: 'callMeAraIl',
  inkarbar: 'inKarbariral',
  zendegi: 'arialcuple',
  fekrmikardam: '',
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
  'به ربات هوشمند آرال خوش آمدید.\n\nاز منوی زیر یک گزینه را انتخاب کنید.';

export const RULES_TEXT =
  'پیام خودتو بفرست.\n\n' +
  'پیامتون با «صدام بزن / این کاربر / تو زندگی بعدی / من فکر میکردم» شروع بشه.\n\n' +
  'سیاسی و بی‌احترامی و حاوی کلمات ناسزا نباشه.\n\n' +
  'می‌تونید چند پیام پشت‌سرهم بفرستید.\n' +
  'حداکثر ۶ پیام در ۱۰ دقیقه.\n\n' +
  'با تشکر مدیریت مجموعه آرال';

export const BOT_DISABLED_TEXT =
  '🔴 ربات موقتاً خاموش است.\n\n' +
  'پیام شما ثبت نشد — این یک توقف عمدی است، نه خرابی.\n' +
  'لطفاً بعداً دوباره تلاش کنید.';

export const FEEDBACK_HINT =
  '💬 این دکمه فقط برای ارسال انتقاد، پیشنهاد یا گزارش مشکل به **مالک** است.\n\n' +
  'اگر می‌خواهید پیام‌تان در کانال منتشر شود، از گزینه\n' +
  '📝 ارسال پیام\n' +
  'استفاده کنید.';

export function buildShiftSlots() {
  return buildAvailableShiftSlots();
}
