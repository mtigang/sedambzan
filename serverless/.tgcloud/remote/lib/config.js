import { buildAvailableShiftSlots, getShiftDayMode } from 'lib/time';

export const OWNER_IDS = [6666610646, 8302194171, 8434360251, 8476063231];


export const CHANNEL_USERNAMES = {
  sadambazan: 'callMeAraIl',
  inkarbar: 'inKarbariral',
  zendegi: 'arialcuple',
  fekrmikardam: 'fekrmi',
  kash: 'kasharal',
  delammikhahad: 'wantraI',
};

export const CHANNEL_IDS = {
  sadambazan: -1003877061735,
  inkarbar: -1003764383335,
  zendegi: -1004371148799,
  fekrmikardam: -1003964656653,
  kash: -1004325797413,
  delammikhahad: -1004443890239,
};

export const ADMIN_GROUP_IDS = {
  sadambazan: -1004444089094,
  inkarbar: -1004335935102,
  zendegi: -1003812392984,
  fekrmikardam: null,
  kash: null,
  delammikhahad: null,
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
  kash: {
    key: 'kash',
    title: 'کاش',
    prefixes: ['کاش'],
    chatId: CHANNEL_IDS.kash,
    adminGroupId: ADMIN_GROUP_IDS.kash,
    workStart: '12:00',
    workEnd: '00:00',
  },
  delammikhahad: {
    key: 'delammikhahad',
    title: 'دلم میخواد',
    prefixes: ['دلم میخواد'],
    chatId: CHANNEL_IDS.delammikhahad,
    adminGroupId: ADMIN_GROUP_IDS.delammikhahad,
    workStart: '12:00',
    workEnd: '00:00',
  },
};

export const CHANNEL_PREFIXES = [
  { key: 'sadambazan', prefix: 'صدام بزن' },
  { key: 'inkarbar', prefix: 'این کاربر' },
  { key: 'zendegi', prefix: 'تو زندگی بعدی' },
  { key: 'fekrmikardam', prefix: 'من فکر میکردم' },
  { key: 'kash', prefix: 'کاش' },
  { key: 'delammikhahad', prefix: 'دلم میخواد' },
];

export const WELCOME_TEXT =
  'سلام 🐳\n' +
  'به ربات آرال خوش اومدی\n\n' +
  'از منوی پایین یکی رو انتخاب کن';

export const RULES_TEXT =
  'پیامت با یکی از اینا شروع شه :\n' +
  '{ صدام بزن / این کاربر / تو زندگی بعدی / من فکر میکردم / کاش / دلم میخواد }\n\n' +
  'توی ۱۰ دقیقه ۶ تا پیام بیشتر نمیتونی بدی به بقیه توهین نکن تکست سیاسیم نذار 🐳';

export const BOT_DISABLED_TEXT =
  '🔴 ربات الان خاموشه 🌬\n\n' +
  'پیامت ثبت نشد — خرابی نیست، یه توقف عمدیه 🩵\n' +
  'یه کم دیگه دوباره سر بزن ✨';

export const FEEDBACK_HINT =
  '💬 اینجا فقط برای حرف زدن با مالکه\n' +
  'انتقاد، پیشنهاد یا گزارش مشکل — هر چی دلت خواست رو میتونی باهاش درمیون بذاری 🐳\n\n' +
  'اگه می‌خوای پیامت بره تو کانال، از\n' +
  '{ 📝 ارسال پیام } استفاده کن';

export function buildShiftSlots() {
  // همیشه از وضعیت فعلی time.js (بعد از loadWorkHoursFromSettings)
  return buildAvailableShiftSlots();
}
