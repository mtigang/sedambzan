/** زمان تهران — دوره شیفت ۱۵:۰۰ تا ۰۳:۰۰ + شمسی */

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

/** ترتیب داخل دوره: ۱۵:۰۰=0 … ۲۳:۰۰=8h, ۰۰:۰۰=9h, ۰۲:۰۰=11h */
export function periodOrd(hm) {
  let m = hmToMin(hm);
  if (m < 15 * 60) m += 24 * 60;
  return m;
}

export function inRange(hm, startHm, endHm) {
  const t = periodOrd(hm);
  let s = periodOrd(startHm);
  let e = periodOrd(endHm === '00:00' && startHm !== '00:00' ? '00:00' : endHm);
  // end 00:00 after 23 means 24:00 in period ord for 23-00 slot
  if (endHm === '00:00' && hmToMin(startHm) >= 15 * 60) {
    e = 24 * 60; // midnight end of 23-00
  }
  if (endHm === '00:00' && startHm === '00:00') {
    s = 24 * 60;
    e = 25 * 60;
  }
  // normal: if end < start in raw minutes overnight within period
  if (hmToMin(endHm) <= hmToMin(startHm) && hmToMin(startHm) >= 15 * 60) {
    // e.g. 23-00 already handled
  }
  // generic period-aware
  const t0 = periodOrd(hm);
  let s0 = periodOrd(startHm);
  let e0 = periodOrd(endHm);
  if (e0 <= s0) e0 += 24 * 60;
  if (t0 < s0) {
    // maybe t is next calendar morning already in periodOrd
  }
  return t0 >= s0 && t0 < e0;
}

/**
 * تاریخ میلادی شروع دوره فعلی (روز تقویمی که ۱۵:۰۰ آن دوره را شروع می‌کند).
 * ساعت ۰۳:۰۰–۱۴:۵۹ → هنوز دوره «امروز ۱۵:۰۰» انتخاب می‌شود (آینده).
 * ساعت ۱۵–۲۳ و ۰۰–۰۲ → دوره از همان/دیروز.
 */
export function periodDateStr(now = tehranNow()) {
  if (now.hour >= 3 && now.hour < 15) {
    // بین ۳ صبح تا ۳ عصر: دوره بعدی از امروز ۱۵:۰۰
    return now.date;
  }
  if (now.hour < 3) {
    // بعد از نیمه‌شب تا ۳: دوره از دیروز ۱۵:۰۰
    return addDays(now.date, -1);
  }
  return now.date; // ۱۵–۲۳
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

export function isWorkHours(now = tehranNow()) {
  // کاربران: ۳ عصر تا ۳ صبح
  return inRange(now.hm, '15:00', '03:00');
}

/** همه اسلات‌های پایه دوره ۱۵→۰۳ */
export function allPeriodSlots() {
  const base = [];
  for (let h = 15; h <= 23; h++) {
    const start = String(h).padStart(2, '0') + ':00';
    const end = h === 23 ? '00:00' : String(h + 1).padStart(2, '0') + ':00';
    base.push({ start, end, hourKey: start, label: start + '–' + end });
  }
  for (const h of [0, 1, 2]) {
    const start = String(h).padStart(2, '0') + ':00';
    const end = String(h + 1).padStart(2, '0') + ':00';
    base.push({ start, end, hourKey: start, label: start + '–' + end });
  }
  return base;
}

/**
 * شیفت‌های قابل انتخاب الان:
 * - گذشته حذف
 * - شیفت جاری: از همین دقیقه تا پایان ساعت
 */
export function buildAvailableShiftSlots(now = tehranNow()) {
  const base = allPeriodSlots();
  // خارج از ساعات کاری دوره: همه اسلات‌های کامل دوره بعدی (از ۱۵)
  if (now.hour >= 3 && now.hour < 15) {
    return base.map((s) => ({ ...s }));
  }

  const oNow = periodOrd(now.hm);
  const out = [];
  for (const s of base) {
    let oStart = periodOrd(s.start);
    let oEnd = periodOrd(s.end);
    if (oEnd <= oStart) oEnd += 24 * 60;

    if (oEnd <= oNow) continue; // گذشته

    if (oStart <= oNow && oNow < oEnd) {
      out.push({
        start: now.hm,
        end: s.end,
        hourKey: s.hourKey,
        label: now.hm + '–' + s.end,
      });
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

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

export function toJalaliDisplay(isoDate, hm) {
  if (!isoDate && !hm) return '—';
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

/** timestamp unix یا Date → شمسی تهران */
export function formatTehranJalali(ts) {
  if (!ts) {
    const n = tehranNow();
    return toJalaliDisplay(n.date, n.hm);
  }
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts === 'number') d = new Date(ts > 1e12 ? ts : ts * 1000);
  else if (typeof ts === 'string' && /^\d+$/.test(ts)) {
    const n = Number(ts);
    d = new Date(n > 1e12 ? n : n * 1000);
  } else {
    d = new Date(ts);
  }
  if (isNaN(d.getTime())) return '—';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const date = parts.year + '-' + parts.month + '-' + parts.day;
  const hm = parts.hour + ':' + parts.minute;
  return toJalaliDisplay(date, hm);
}
