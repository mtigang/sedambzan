/** زمان تهران — دوره شیفت ۱۲:۰۰ تا ۰۳:۰۰ + شمسی */

const PERIOD_START_MIN = 12 * 60; // ۱۲ ظهر
const PERIOD_END_MIN = 3 * 60; // ۳ بامداد

export function tehranNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    hm: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
    hour,
    minute,
  };
}

export function hmToMin(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minToHm(mins) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/** نرمال HH:MM */
export function normHm(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return String(h || 0).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0');
}

/** ساعت باکت (برای مقایسه پر بودن شیفت) */
export function hourKeyOf(hm) {
  const [h] = String(hm || '0').split(':').map(Number);
  return String(h || 0).padStart(2, '0') + ':00';
}

/**
 * ترتیب داخل دوره ۱۲:۰۰→۰۳:۰۰:
 * ۱۲:۰۰=720 … ۲۳:۵۹ ، بعد ۰۰:۰۰=1440+ … ۰۲:۵۹
 * قبل از ۱۲ ظهر در همان تقویم → +۲۴س برای مقایسه داخل دوره شبانه
 */
export function periodOrd(hm) {
  let m = hmToMin(normHm(hm));
  if (m < PERIOD_START_MIN) m += 24 * 60;
  return m;
}

/**
 * آیا hm داخل [startHm, endHm) است؟
 * پشتیبانی overnight (مثلاً ۲۳→۰۰ یا ۱۲→۰۳).
 * شیفت با طول صفر (start===end) هرگز فعال نیست.
 */
export function inRange(hm, startHm, endHm) {
  const start = normHm(startHm);
  const end = normHm(endHm);
  if (start === end) return false; // ۰۰–۰۰ و مشابه = نامعتبر
  const t = periodOrd(hm);
  let s = periodOrd(start);
  let e = periodOrd(end);
  if (e <= s) e += 24 * 60;
  // اگر بازه بیش از ۱۵ ساعت باشد احتمالاً داده خراب است — محدود کن
  if (e - s > 15 * 60) return false;
  return t >= s && t < e;
}

/**
 * تاریخ میلادی شروع دوره فعلی (روزی که ۱۲:۰۰ دوره را شروع می‌کند).
 * ۰۳:۰۰–۱۱:۵۹ → دوره بعدی از امروز ۱۲:۰۰
 * ۱۲:۰۰–۲۳:۵۹ → دوره امروز
 * ۰۰:۰۰–۰۲:۵۹ → دوره از دیروز ۱۲:۰۰
 */
export function periodDateStr(now) {
  if (!now) now = tehranNow();
  if (now.hour >= 3 && now.hour < 12) return now.date;
  if (now.hour < 3) return addDays(now.date, -1);
  return now.date;
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return (
    dt.getUTCFullYear() +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  );
}

export function isWorkHours(now) {
  if (!now) now = tehranNow();
  return inRange(now.hm, '12:00', '03:00');
}

/**
 * شیفت‌های قابل انتخاب ادمین:
 * - داخل دوره (۱۲–۰۳): فقط از الان به بعد (گذشته مخفی)
 * - خارج از دوره (۰۳–۱۲): همهٔ شیفت‌های دورهٔ پیش‌رو قابل انتخاب/لغو
 */
export function buildAvailableShiftSlots(now) {
  if (!now) now = tehranNow();
  // انتخاب شیفت همیشه فعال (۲۴ ساعته) — همه بازه‌های دوره ۱۲:۰۰→۰۳:۰۰
  const slots = [];
  const pad = (n) => String(n).padStart(2, '0');
  const hours = [];
  for (let h = 12; h <= 23; h++) hours.push(h);
  for (let h = 0; h <= 2; h++) hours.push(h);

  for (const h of hours) {
    const start = pad(h) + ':00';
    const endH = (h + 1) % 24;
    const end = pad(endH) + ':00';
    slots.push({
      start: start,
      end: end,
      label: start + '–' + end,
      hourKey: start,
    });
  }
  return slots;
}

export function buildOwnerShiftSlots(now) {
  if (!now) now = tehranNow();
  // مالک: ۲۴ ساعت آینده
  const slots = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 24; i++) {
    const startH = (now.hour + i) % 24;
    const endH = (startH + 1) % 24;
    let start = pad(startH) + ':00';
    const end = pad(endH) + ':00';
    if (i === 0 && now.minute > 0) start = pad(now.hour) + ':' + pad(now.minute);
    slots.push({
      start: start,
      end: end,
      label: start + '–' + end,
      hourKey: pad(startH) + ':00',
    });
  }
  return slots;
}

const JMONTHS = [
  '',
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) -
    80 +
    gd +
    g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

export function toJalaliDisplay(isoDate, hm) {
  let datePart = '';
  if (isoDate) {
    const p = String(isoDate).split(/[T\s]/)[0];
    const [gy, gm, gd] = p.split('-').map(Number);
    if (gy && gm && gd) {
      const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
      datePart = jd + ' ' + JMONTHS[jm] + ' ' + jy;
    }
  }
  const timePart = hm ? String(hm).slice(0, 5) : '';
  if (datePart && timePart) return datePart + ' — ' + timePart;
  return datePart || timePart || '—';
}

export function formatTsJalali(ts) {
  if (ts == null || ts === '') return '—';
  let ms = NaN;
  if (ts instanceof Date) ms = ts.getTime();
  else if (typeof ts === 'number') ms = ts > 1e12 ? ts : ts * 1000;
  else if (typeof ts === 'string' && /^\d+$/.test(ts.trim())) {
    const n = Number(ts.trim());
    ms = n > 1e12 ? n : n * 1000;
  } else ms = new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms >= 1e9 && ms < 1e12) ms = ms * 1000;
  const IRAN_OFFSET = 3.5 * 3600 * 1000;
  const adj = new Date(ms + IRAN_OFFSET);
  const y = adj.getUTCFullYear();
  const mo = adj.getUTCMonth() + 1;
  const da = adj.getUTCDate();
  const hh = adj.getUTCHours();
  const mi = adj.getUTCMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  return toJalaliDisplay(y + '-' + pad(mo) + '-' + da, pad(hh) + ':' + pad(mi));
}

export { formatTsJalali as formatTehranJalali };

export function toFaDigits(s) {
  return String(s).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export function hoursUntilWorkOpen(now) {
  if (!now) now = tehranNow();
  if (isWorkHours(now)) return 0;
  const nowM = hmToMin(now.hm);
  const openM = 12 * 60;
  if (nowM >= 3 * 60 && nowM < openM) return Math.max(1, Math.ceil((openM - nowM) / 60));
  return Math.max(1, Math.ceil((openM + 24 * 60 - nowM) / 60));
}

export function workHoursClosedText() {
  const h = hoursUntilWorkOpen();
  return (
    '⏰ ساعت کاری از ' +
    toFaDigits('12:00') +
    ' تا ' +
    toFaDigits('03:00') +
    ' است.\nالان خارج از ساعت کاری هستید.\nحدود ' +
    toFaDigits(h) +
    ' ساعت تا شروع کار مانده.'
  );
}

/** مرتب‌سازی شیفت‌ها داخل دوره ۱۲→۰۳ */
export function sortShiftsByPeriod(list) {
  return (list || []).slice().sort(function (a, b) {
    const sa = periodOrd(normHm(a.startHm || a.start_hm || '12:00'));
    const sb = periodOrd(normHm(b.startHm || b.start_hm || '12:00'));
    return sa - sb;
  });
}
