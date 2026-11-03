/**
 * Owner analytics & shift board — pure reads from DB.
 * No invented stats. Max 20k recent messages (chunked).
 */
import { db } from 'sdk';
import { shifts, messages, channelAdmins } from 'schema';
import { desc, sql } from 'sdk/db';
import { DEFAULT_CHANNELS, OWNER_IDS } from 'lib/config';
import {
  tehranNow,
  inRange,
  periodDateStr,
  normHm,
  periodOrd,
  toJalaliDisplay,
} from 'lib/time';
import {
  tehranDateOfTs,
  tehranHmOfTs,
  reviewMatchedShift,
  isOwner,
  displayName,
  getUser,
} from 'lib/dbutil';

const MSG_SCAN_LIMIT = 20000;
const MSG_CHUNK = 2000;
const SHIFT_SCAN_LIMIT = 5000;

function dayOffset(baseDateStr, offset) {
  const parts = String(baseDateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + offset);
  return (
    dt.getUTCFullYear() +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  );
}

function tsMs(ts) {
  if (ts == null) return null;
  try {
    let t = ts;
    if (typeof t === 'string' && /^\d+$/.test(t)) t = Number(t);
    if (typeof t === 'number' && t < 1e12) t = t * 1000;
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch (_e) {
    return null;
  }
}

function fmtMins(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'داده کافی نیست';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' دقیقه';
  const h = Math.floor(m / 60);
  return h + 'س ' + (m % 60) + 'د';
}

function avg(arr) {
  if (!arr || !arr.length) return null;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function allowedDaysForPeriod(period, nowDate) {
  const map = {};
  if (period === 'today') {
    map[nowDate] = true;
  } else if (period === 'yesterday') {
    map[dayOffset(nowDate, -1)] = true;
  } else if (period === 'week') {
    for (let i = 0; i < 7; i++) map[dayOffset(nowDate, -i)] = true;
  } else if (period === 'month') {
    for (let i = 0; i < 30; i++) map[dayOffset(nowDate, -i)] = true;
  } else {
    return null; // all sample
  }
  return map;
}

function periodLabel(period, nowDate) {
  if (period === 'today') return 'امروز (' + nowDate + ')';
  if (period === 'yesterday') return 'دیروز (' + dayOffset(nowDate, -1) + ')';
  if (period === 'week') return '۷ روز اخیر';
  if (period === 'month') return '۳۰ روز اخیر';
  return 'کل نمونهٔ اخیر';
}

/** Chunked load of newest messages by PK (no WHERE on user — avoids rows_read traps). */
export async function loadRecentMessages(limit) {
  const cap = Math.min(Math.max(Number(limit) || MSG_SCAN_LIMIT, 100), MSG_SCAN_LIMIT);
  const out = [];
  let cursor = null;
  const seen = Object.create(null);
  while (out.length < cap) {
    let batch = [];
    try {
      if (cursor != null) {
        batch =
          (await db
            .select({
              id: messages.id,
              status: messages.status,
              channelKey: messages.channelKey,
              reviewedBy: messages.reviewedBy,
              reviewedAt: messages.reviewedAt,
              submittedAt: messages.submittedAt,
              rejectReason: messages.rejectReason,
            })
            .from(messages)
            .where(sql`${messages.id} < ${cursor}`)
            .orderBy(desc(messages.id))
            .limit(MSG_CHUNK)
            .all()) || [];
      } else {
        batch =
          (await db
            .select({
              id: messages.id,
              status: messages.status,
              channelKey: messages.channelKey,
              reviewedBy: messages.reviewedBy,
              reviewedAt: messages.reviewedAt,
              submittedAt: messages.submittedAt,
              rejectReason: messages.rejectReason,
            })
            .from(messages)
            .orderBy(desc(messages.id))
            .limit(MSG_CHUNK)
            .all()) || [];
      }
    } catch (e) {
      console.error('loadRecentMessages chunk', e);
      break;
    }
    if (!batch.length) break;
    for (const m of batch) {
      const id = Number(m.id);
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(m);
      if (out.length >= cap) break;
    }
    const last = Number(batch[batch.length - 1].id);
    if (!Number.isFinite(last) || last <= 1) break;
    if (cursor != null && last >= cursor) break;
    cursor = last;
    if (batch.length < MSG_CHUNK) break;
  }
  return out;
}

export async function loadRecentShifts(limit) {
  const cap = Math.min(Number(limit) || SHIFT_SCAN_LIMIT, SHIFT_SCAN_LIMIT);
  try {
    return (await db.select().from(shifts).orderBy(desc(shifts.id)).limit(cap).all()) || [];
  } catch (e) {
    console.error('loadRecentShifts', e);
    try {
      return (await db.select().from(shifts).limit(cap).all()) || [];
    } catch (e2) {
      console.error('loadRecentShifts2', e2);
      return [];
    }
  }
}

export async function loadChannelAdminMap() {
  const map = Object.create(null); // channelKey -> {uid:true}
  const all = Object.create(null); // uid -> {channelKeys}
  try {
    const rows = (await db.select().from(channelAdmins).all()) || [];
    for (const r of rows) {
      const ck = String(r.channelKey || r.channel_key || '');
      const uid = Number(r.userId || r.user_id);
      if (!ck || !uid || isOwner(uid)) continue;
      if (!map[ck]) map[ck] = Object.create(null);
      map[ck][uid] = true;
      if (!all[uid]) all[uid] = Object.create(null);
      all[uid][ck] = true;
    }
  } catch (e) {
    console.error('loadChannelAdminMap', e);
  }
  return { byChannel: map, byAdmin: all };
}

/**
 * Logical shift status (DB status is only active|cancelled).
 * completed = still active in DB but time window has passed.
 */
export function classifyShiftStatus(s, now) {
  if (!now) now = tehranNow();
  const st = String(s.status || 'active');
  if (st === 'cancelled') return 'cancelled';
  if (st !== 'active') return 'other';
  const start = normHm(s.startHm || s.start_hm || '');
  const end = normHm(s.endHm || s.end_hm || '');
  if (!start || !end || start === end) return 'invalid';
  const sd = String(s.shiftDate ?? s.shift_date ?? '');
  if (sd === 'perm' || sd === 'permanent') return 'legacy_perm';
  const pdate = periodDateStr(now);
  if (sd === pdate || sd === now.date) {
    if (inRange(now.hm, start, end)) return 'running';
    const t = periodOrd(now.hm);
    const sOrd = periodOrd(start);
    let eOrd = periodOrd(end);
    if (eOrd <= sOrd) eOrd += 24 * 60;
    if (t < sOrd) return 'upcoming';
    return 'completed';
  }
  // compare calendar dates YYYY-MM-DD
  if (sd < now.date) return 'completed';
  if (sd > now.date) return 'upcoming';
  return 'completed';
}

const STATUS_FA = {
  running: '🟢 در حال اجرا',
  upcoming: '🟡 آینده',
  completed: '✅ تکمیل‌شده',
  cancelled: '🔴 لغوشده',
  invalid: '⚠️ نامعتبر',
  legacy_perm: '⚠️ دائم قدیمی',
  other: '❔ سایر',
};

function countReviewsInShift(s, msgs) {
  const aid = Number(s.adminId || s.admin_id);
  const ck = String(s.channelKey || s.channel_key || '');
  const sd = String(s.shiftDate || s.shift_date || '');
  const start = normHm(s.startHm || s.start_hm || '');
  const end = normHm(s.endHm || s.end_hm || '');
  let ap = 0;
  let rj = 0;
  const seen = Object.create(null);
  for (const m of msgs) {
    const id = Number(m.id);
    if (!id || seen[id]) continue;
    if (Number(m.reviewedBy) !== aid) continue;
    if (String(m.channelKey || '') !== ck) continue;
    const st = String(m.status || '');
    if (st !== 'approved' && st !== 'rejected') continue;
    const day = tehranDateOfTs(m.reviewedAt);
    if (day !== sd) continue;
    const hm = tehranHmOfTs(m.reviewedAt);
    if (!hm) continue;
    try {
      if (!inRange(hm, start, end)) continue;
    } catch (_e) {
      continue;
    }
    seen[id] = 1;
    if (st === 'approved') ap++;
    else rj++;
  }
  return { ap, rj, total: ap + rj };
}

/**
 * Shift board for one day (default: current period).
 * channelKey null = all channels.
 */
export async function buildShiftBoard(channelKey, day) {
  const now = tehranNow();
  const pdate = day || periodDateStr(now);
  const allSh = await loadRecentShifts(SHIFT_SCAN_LIMIT);
  // messages only needed for review counts — sample 8k is enough for today's shifts
  const msgs = await loadRecentMessages(8000);

  const keys = channelKey
    ? [channelKey]
    : Object.keys(DEFAULT_CHANNELS || {});

  const sections = [];
  let totals = {
    active: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    upcoming: 0,
    idle: 0,
    withWork: 0,
  };

  for (const ck of keys) {
    const conf = DEFAULT_CHANNELS[ck];
    if (!conf && channelKey) continue;
    const title = (conf && conf.title) || ck;
    const list = [];
    const seenShift = Object.create(null);
    for (const s of allSh) {
      const sid = Number(s.id);
      if (sid && seenShift[sid]) continue;
      if (sid) seenShift[sid] = 1;
      const sck = String(s.channelKey || s.channel_key || '');
      if (sck !== ck) continue;
      const sd = String(s.shiftDate || s.shift_date || '');
      if (sd === 'perm' || sd === 'permanent') continue;
      if (sd !== pdate) continue;
      const logical = classifyShiftStatus(s, now);
      if (logical === 'invalid') continue;
      const reviews = countReviewsInShift(s, msgs);
      const idle = logical !== 'cancelled' && logical !== 'upcoming' && reviews.total === 0;
      list.push({
        id: sid,
        adminId: Number(s.adminId || s.admin_id),
        startHm: normHm(s.startHm || s.start_hm),
        endHm: normHm(s.endHm || s.end_hm),
        dbStatus: String(s.status || 'active'),
        logical,
        reviews,
        idle,
      });
      if (logical === 'running') {
        totals.running++;
        totals.active++;
      } else if (logical === 'completed') {
        totals.completed++;
        totals.active++;
      } else if (logical === 'upcoming') {
        totals.upcoming++;
        totals.active++;
      } else if (logical === 'cancelled') {
        totals.cancelled++;
      }
      if (idle) totals.idle++;
      if (reviews.total > 0) totals.withWork++;
    }
    // sort by start
    list.sort(function (a, b) {
      return periodOrd(a.startHm) - periodOrd(b.startHm);
    });
    sections.push({ key: ck, title: title, shifts: list });
  }

  return { day: pdate, now, sections, totals };
}

export async function formatShiftBoardMessages(board) {
  const lines = [];
  let head =
    '⏰ شیفت‌های دوره\n📅 ' +
    board.day +
    (toJalaliDisplay ? ' · ' + String(toJalaliDisplay(board.day) || '') : '') +
    '\n';
  head +=
    '🟢 اجرا ' +
    board.totals.running +
    ' · ✅ تکمیل ' +
    board.totals.completed +
    ' · 🟡 آینده ' +
    board.totals.upcoming +
    ' · 🔴 لغو ' +
    board.totals.cancelled +
    '\n';
  head +=
    'شیفت بدون فعالیت (پس از شروع): ' +
    board.totals.idle +
    '\n────────────\n';
  lines.push(head);

  for (const sec of board.sections) {
    if (!sec.shifts.length) {
      lines.push('📢 «' + sec.title + '»\n(شیفتی برای این دوره ثبت نشده)\n');
      continue;
    }
    let body = '📢 «' + sec.title + '» — ' + sec.shifts.length + ' رکورد\n';
    for (const s of sec.shifts) {
      let name = String(s.adminId);
      try {
        name = displayName(await getUser(s.adminId), s.adminId);
      } catch (_e) {}
      body +=
        '<blockquote>' +
        (STATUS_FA[s.logical] || s.logical) +
        (s.idle ? ' · بدون فعالیت' : '') +
        '\n⏰ ' +
        s.startHm.slice(0, 5) +
        '–' +
        s.endHm.slice(0, 5) +
        '\n👤 ' +
        esc(name) +
        '\n🆔 <code>' +
        s.adminId +
        '</code> · شیفت #' +
        (s.id || '—') +
        '\n📨 بررسی در بازه: ' +
        s.reviews.total +
        ' (✅' +
        s.reviews.ap +
        ' ❌' +
        s.reviews.rj +
        ')' +
        '</blockquote>\n';
      if (body.length > 3500) {
        lines.push(body);
        body = '📢 «' + sec.title + '» (ادامه)\n';
      }
    }
    lines.push(body);
  }
  return lines;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Full analytics for owner.
 * period: today|yesterday|week|month|all
 * scope: channel key or 'all'
 */
export async function buildAnalytics(scope, period) {
  const now = tehranNow();
  const dayMap = allowedDaysForPeriod(period || 'week', now.date);
  const channelKeys =
    scope && scope !== 'all'
      ? [scope].filter(function (k) {
          return DEFAULT_CHANNELS[k];
        })
      : Object.keys(DEFAULT_CHANNELS || {});
  if (!channelKeys.length) {
    return { error: 'کانال نامعتبر', texts: ['کانال نامعتبر'] };
  }
  const scopeSet = Object.create(null);
  for (const k of channelKeys) scopeSet[k] = true;

  const [msgs, allSh, adminMap] = await Promise.all([
    loadRecentMessages(MSG_SCAN_LIMIT),
    loadRecentShifts(SHIFT_SCAN_LIMIT),
    loadChannelAdminMap(),
  ]);

  const analyzed = msgs.length;
  // unique by id already

  const team = {
    received: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
    handleMs: [],
  };

  const byAdmin = Object.create(null); // aid -> stats

  function ensure(aid) {
    if (!byAdmin[aid]) {
      byAdmin[aid] = {
        aid: Number(aid),
        ap: 0,
        rj: 0,
        pendingAsReviewer: 0, // n/a
        inShift: 0,
        outShift: 0,
        handleMs: [],
        daysActive: Object.create(null),
        shiftsReg: 0,
        shiftsCompleted: 0,
        shiftsCancelled: 0,
        shiftsIdle: 0,
        shiftsRunning: 0,
      };
    }
    return byAdmin[aid];
  }

  // seed current admins in scope
  for (const ck of channelKeys) {
    const set = adminMap.byChannel[ck] || {};
    for (const uidStr of Object.keys(set)) {
      ensure(Number(uidStr));
    }
  }

  for (const m of msgs) {
    const ck = String(m.channelKey || '');
    if (!scopeSet[ck]) continue;
    const st = String(m.status || '');
    const subD = tehranDateOfTs(m.submittedAt);
    const revD = tehranDateOfTs(m.reviewedAt);

    if (st === 'pending' || st === 'publishing') {
      if (!dayMap || (subD && dayMap[subD])) team.pending++;
    }

    if (st === 'approved' || st === 'rejected') {
      if (dayMap && !(revD && dayMap[revD])) continue;
      team.received++; // counted as handled in period
      if (st === 'approved') team.approved++;
      else team.rejected++;
      const sub = tsMs(m.submittedAt);
      const rev = tsMs(m.reviewedAt);
      if (sub != null && rev != null && rev >= sub) team.handleMs.push(rev - sub);

      const aid = Number(m.reviewedBy);
      if (!aid || isOwner(aid)) continue;
      // only count if currently admin of this channel OR was reviewer with admin map
      const isAdm = adminMap.byChannel[ck] && adminMap.byChannel[ck][aid];
      if (!isAdm) continue;
      const o = ensure(aid);
      if (st === 'approved') o.ap++;
      else o.rj++;
      if (reviewMatchedShift(aid, ck, m.reviewedAt, allSh)) o.inShift++;
      else o.outShift++;
      if (sub != null && rev != null && rev >= sub) o.handleMs.push(rev - sub);
      if (revD) o.daysActive[revD] = true;
    } else if (!dayMap || (subD && dayMap[subD])) {
      // submitted in period but not reviewed yet — not attributed to admin
      if (st === 'pending' || st === 'publishing') {
        /* team.pending already */
      }
    }
  }

  // shifts in period for each admin
  const now2 = tehranNow();
  const seenSh = Object.create(null);
  for (const s of allSh) {
    const sid = Number(s.id);
    if (sid && seenSh[sid]) continue;
    if (sid) seenSh[sid] = 1;
    const ck = String(s.channelKey || s.channel_key || '');
    if (!scopeSet[ck]) continue;
    const sd = String(s.shiftDate || s.shift_date || '');
    if (sd === 'perm' || sd === 'permanent') continue;
    if (dayMap && !dayMap[sd]) continue;
    const aid = Number(s.adminId || s.admin_id);
    if (!aid || isOwner(aid)) continue;
    if (!(adminMap.byChannel[ck] && adminMap.byChannel[ck][aid])) continue;
    const o = ensure(aid);
    const logical = classifyShiftStatus(s, now2);
    const reviews = countReviewsInShift(s, msgs);
    o.shiftsReg++;
    if (logical === 'cancelled') o.shiftsCancelled++;
    else if (logical === 'completed') o.shiftsCompleted++;
    else if (logical === 'running') o.shiftsRunning++;
    if (logical !== 'cancelled' && logical !== 'upcoming' && reviews.total === 0) {
      o.shiftsIdle++;
    }
  }

  // score
  const admins = Object.keys(byAdmin).map(function (k) {
    return byAdmin[k];
  });
  let teamReviews = 0;
  for (const a of admins) teamReviews += a.ap + a.rj;

  for (const a of admins) {
    const total = a.ap + a.rj;
    a.total = total;
    a.avgHandleMs = avg(a.handleMs);
    a.dayCount = Object.keys(a.daysActive).length;
    a.sharePct = teamReviews > 0 ? Math.round((total / teamReviews) * 1000) / 10 : 0;

    // weighted score 0-100 (transparent)
    // volume 40, presence 25, in-shift ratio 20, continuity 15
    let score = 0;
    const reasons = [];
    const vol = Math.min(40, total * 0.15);
    score += vol;
    reasons.push('حجم بررسی: +' + Math.round(vol) + ' (از ۴۰)');

    const presence = Math.min(25, a.shiftsCompleted * 4 + a.shiftsRunning * 3);
    score += presence;
    reasons.push('حضور شیفت: +' + Math.round(presence) + ' (از ۲۵)');

    let inRatio = 0;
    if (total > 0) {
      inRatio = (a.inShift / total) * 20;
      score += inRatio;
      reasons.push('نسبت درشیفت: +' + Math.round(inRatio) + ' (از ۲۰)');
    } else {
      reasons.push('نسبت درشیفت: داده کافی نیست');
    }

    const cont = Math.min(15, a.dayCount * 3);
    score += cont;
    reasons.push('استمرار روزها: +' + Math.round(cont) + ' (از ۱۵)');

    if (a.shiftsIdle > 0) {
      const pen = Math.min(15, a.shiftsIdle * 5);
      score -= pen;
      reasons.push('شیفت بدون فعالیت: −' + Math.round(pen));
    }

    a.score = Math.max(0, Math.min(100, Math.round(score)));
    a.scoreReasons = reasons;

    // category
    if (total === 0 && a.shiftsReg === 0) a.category = 'بدون شیفت و بدون فعالیت';
    else if (total === 0 && a.shiftsIdle > 0) a.category = 'دارای شیفت بدون فعالیت';
    else if (total === 0) a.category = 'اطلاعات ناکافی';
    else if (total >= 80 && a.score >= 60) a.category = 'دارای فعالیت بالا';
    else if (a.score >= 55 && total >= 20) a.category = 'فعال و مؤثر';
    else if (total >= 5 && a.score < 40) a.category = 'فعال اما کم‌کار';
    else if (total < 5 && a.shiftsReg > 0) a.category = 'اطلاعات ناکافی';
    else if (total === 0) a.category = 'غیرفعال';
    else a.category = 'فعال اما کم‌کار';
  }

  admins.sort(function (x, y) {
    return y.score - x.score || y.total - x.total;
  });
  for (let i = 0; i < admins.length; i++) admins[i].rank = i + 1;

  const activeN = admins.filter(function (a) {
    return a.total > 0;
  }).length;
  const inactiveN = admins.filter(function (a) {
    return a.total === 0;
  }).length;
  const idleShifts = admins.reduce(function (s, a) {
    return s + a.shiftsIdle;
  }, 0);
  const totalShifts = admins.reduce(function (s, a) {
    return s + a.shiftsReg;
  }, 0);
  const avgScore =
    admins.length > 0
      ? Math.round(
          admins.reduce(function (s, a) {
            return s + a.score;
          }, 0) / admins.length
        )
      : 0;

  return {
    error: null,
    scope: scope || 'all',
    period: period || 'week',
    periodLabel: periodLabel(period || 'week', now.date),
    analyzed,
    team,
    admins,
    summary: {
      activeN,
      inactiveN,
      idleShifts,
      totalShifts,
      avgScore,
      teamReviews,
    },
    generatedAt: Date.now(),
  };
}

export async function formatAnalyticsMessages(data) {
  if (data.error) return [data.error];
  const texts = [];
  const scopeTitle =
    data.scope === 'all'
      ? 'همه کانال‌ها'
      : (DEFAULT_CHANNELS[data.scope] && DEFAULT_CHANNELS[data.scope].title) || data.scope;

  let head = '📈 تحلیل داده — «' + scopeTitle + '»\n';
  head += '🗓 ' + data.periodLabel + '\n';
  head += 'نمونهٔ پیام: ' + data.analyzed + ' ردیف اخیر (سقف ۲۰۰۰۰)\n';
  head += '────────────\n';
  head += '✅ تأیید: ' + data.team.approved + '\n';
  head += '❌ رد: ' + data.team.rejected + '\n';
  head += '🟡 صف (در نمونه/بازه): ' + data.team.pending + '\n';
  head += '⏱ میانگین رسیدگی: ' + fmtMins(avg(data.team.handleMs)) + '\n';
  head += '────────────\n';
  head += '👮 ادمین با بررسی: ' + data.summary.activeN + '\n';
  head += '😴 بدون بررسی: ' + data.summary.inactiveN + '\n';
  head += '⏰ شیفت ثبت‌شده: ' + data.summary.totalShifts + '\n';
  head += 'شیفت بدون فعالیت: ' + data.summary.idleShifts + '\n';
  head += 'میانگین امتیاز تیم: ' + data.summary.avgScore + '/100\n';

  const top = data.admins.filter(function (a) {
    return a.total > 0;
  }).slice(0, 3);
  const weak = data.admins
    .filter(function (a) {
      return a.total >= 5 && a.score < 40;
    })
    .slice(-3)
    .reverse();
  if (top.length) {
    head += '\n🏆 برتر:\n';
    for (const a of top) {
      let name = String(a.aid);
      try {
        name = displayName(await getUser(a.aid), a.aid);
      } catch (_e) {}
      head += '• #' + a.rank + ' ' + name + ' — امتیاز ' + a.score + ' · بررسی ' + a.total + '\n';
    }
  }
  if (weak.length) {
    head += '\n⚠️ قابل ارزیابی ضعیف:\n';
    for (const a of weak) {
      let name = String(a.aid);
      try {
        name = displayName(await getUser(a.aid), a.aid);
      } catch (_e) {}
      head += '• ' + name + ' — امتیاز ' + a.score + ' · بررسی ' + a.total + '\n';
    }
  }
  texts.push(head);

  // table-like list in chunks
  let body = '📋 جدول ادمین‌ها (مرتب بر امتیاز)\n────────────\n';
  for (const a of data.admins) {
    let name = String(a.aid);
    try {
      name = displayName(await getUser(a.aid), a.aid);
    } catch (_e) {}
    const block =
      '<blockquote>#' +
      a.rank +
      ' · ' +
      esc(name) +
      '\n🆔 <code>' +
      a.aid +
      '</code>\n' +
      '📨 ' +
      a.total +
      ' (✅' +
      a.ap +
      ' ❌' +
      a.rj +
      ')\n' +
      '⏰ شیفت: ' +
      a.shiftsReg +
      ' · تکمیل ' +
      a.shiftsCompleted +
      ' · لغو ' +
      a.shiftsCancelled +
      ' · بیکار ' +
      a.shiftsIdle +
      '\n' +
      '📍 درشیفت ' +
      a.inShift +
      ' · خارج ' +
      a.outShift +
      '\n' +
      '⏱ ' +
      fmtMins(a.avgHandleMs) +
      ' · سهم ' +
      a.sharePct +
      '٪\n' +
      '⭐ ' +
      a.score +
      '/100 · ' +
      a.category +
      '\n' +
      'جزئیات: /oad_' +
      a.aid +
      '</blockquote>\n';
    // use callback-friendly note instead of command
    if ((body + block).length > 3500) {
      texts.push(body);
      body = '📋 ادامه جدول\n';
    }
    body += block;
  }
  if (body.length > 20) texts.push(body);

  texts.push(
    'ℹ️ امتیاز = حجم(۴۰) + حضور شیفت(۲۵) + نسبت درشیفت(۲۰) + استمرار(۱۵) − جریمه بیکاری.\n' +
      'مالک در رتبه‌بندی ادمین نیست. فقط ادمین‌های فعلی کانال.\n' +
      'برای جزئیات یک ادمین از دکمه زیر جدول استفاده کنید.'
  );
  return texts;
}

export async function formatAdminDetail(adminId, scope, period) {
  const data = await buildAnalytics(scope || 'all', period || 'week');
  if (data.error) return [data.error];
  const a = data.admins.find(function (x) {
    return Number(x.aid) === Number(adminId);
  });
  if (!a) {
    return ['ادمین در محدودهٔ فعلی یافت نشد یا ادمین کانال نیست.'];
  }
  let name = String(a.aid);
  try {
    name = displayName(await getUser(a.aid), a.aid);
  } catch (_e) {}

  let t =
    '👤 جزئیات ادمین\n' +
    name +
    '\n🆔 ' +
    a.aid +
    '\nرتبه #' +
    a.rank +
    ' · ' +
    a.category +
    '\n🗓 ' +
    data.periodLabel +
    '\n────────────\n';
  t += '📨 بررسی: ' + a.total + ' (✅' + a.ap + ' ❌' + a.rj + ')\n';
  t += '📍 در شیفت: ' + a.inShift + ' · خارج شیفت: ' + a.outShift + '\n';
  t += '⏱ میانگین رسیدگی: ' + fmtMins(a.avgHandleMs) + '\n';
  t += '📅 روزهای فعال: ' + a.dayCount + '\n';
  t += 'سهم از تیم: ' + a.sharePct + '٪\n';
  t += '────────────\nشیفت‌ها\n';
  t +=
    'ثبت ' +
    a.shiftsReg +
    ' · تکمیل ' +
    a.shiftsCompleted +
    ' · درحال ' +
    a.shiftsRunning +
    ' · لغو ' +
    a.shiftsCancelled +
    ' · بدون فعالیت ' +
    a.shiftsIdle +
    '\n';
  t += '────────────\n⭐ امتیاز ' + a.score + '/100\n';
  for (const r of a.scoreReasons || []) {
    t += '• ' + r + '\n';
  }
  t +=
    '\nمیانگین امتیاز تیم: ' +
    data.summary.avgScore +
    '\n' +
    (a.score >= data.summary.avgScore
      ? 'نسبت به تیم: بالاتر از میانگین'
      : 'نسبت به تیم: پایین‌تر از میانگین');

  // strengths / weaknesses
  t += '\n\nنقاط قوت:\n';
  if (a.inShift >= a.outShift && a.total > 0) t += '• بخش عمده بررسی‌ها داخل شیفت\n';
  if (a.dayCount >= 3) t += '• استمرار در چند روز\n';
  if (a.total >= 30) t += '• حجم کار قابل توجه\n';
  if (a.shiftsIdle === 0 && a.shiftsReg > 0) t += '• بدون شیفت بیکار\n';
  if (t.indexOf('•') < 0) t += '• داده برای قوت مشخص کافی نیست\n';

  t += '\nنقاط ضعف:\n';
  if (a.shiftsIdle > 0) t += '• ' + a.shiftsIdle + ' شیفت بدون فعالیت\n';
  if (a.outShift > a.inShift && a.total > 0) t += '• غلبه بررسی خارج از شیفت\n';
  if (a.total > 0 && a.total < 10) t += '• حجم بررسی پایین\n';
  if (a.total === 0) t += '• هیچ بررسی در این بازه\n';
  if (t.trim().endsWith('نقاط ضعف:')) t += '• مورد خاصی ثبت نشد\n';

  return [t];
}
