import { buildAvailableShiftSlots } from 'lib/time';

export const OWNER_IDS = [6666610646, 8302194171, 8434360251];

export const CHANNEL_USERNAMES = {
  sadambazan: 'callMeAraIl',
  inkarbar: 'inKarbariral',
  zendegi: 'arialcuple',
};

export const CHANNEL_IDS = {
  sadambazan: -1003877061735,
  inkarbar: -1003764383335,
  zendegi: -1004371148799,
};

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
    workStart: '12:00',
    workEnd: '03:00',
  },
  inkarbar: {
    key: 'inkarbar',
    title: 'این کاربر',
    prefixes: ['این کاربر'],
    chatId: CHANNEL_IDS.inkarbar,
    adminGroupId: ADMIN_GROUP_IDS.inkarbar,
    workStart: '12:00',
    workEnd: '03:00',
  },
  zendegi: {
    key: 'zendegi',
    title: 'تو زندگی بعدی',
    prefixes: ['تو زندگی بعدی'],
    chatId: CHANNEL_IDS.zendegi,
    adminGroupId: ADMIN_GROUP_IDS.zendegi,
    workStart: '12:00',
    workEnd: '03:00',
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

export function buildShiftSlots() {
  return buildAvailableShiftSlots();
}
