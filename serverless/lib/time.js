/** زمان تهران — بدون وابستگی npm */
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
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** آیا hm فعلی داخل [start, end) است — پشتیبانی از بازه شبانه */
export function inRange(hm, startHm, endHm) {
  const t = hmToMin(hm);
  const s = hmToMin(startHm);
  let e = hmToMin(endHm);
  if (e === s) return true; // کل روز
  if (e < s) {
    // مثلا 11:00 تا 00:00
    return t >= s || t < e;
  }
  return t >= s && t < e;
}
