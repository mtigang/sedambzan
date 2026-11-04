/**
 * Owner HR reports — fast, shift-first, no heavy 20k scans on every click.
 */
import { db } from 'sdk';
import { shifts, messages, channelAdmins } from 'schema';
import { desc, sql } from 'sdk/db';
import { DEFAULT_CHANNELS } from 'lib/config';
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
  isOwner,
  displayName,
  getUser,
} from 'lib/dbutil';

const SHIFT_LIMIT = 4000;
const MSG_LIGHT = 4000; // only for approval counts in week report

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

function lastNDays(n, nowDate) {
  const map = Object.create(null);
  const list = [];
  for (let i = 0; i < n; i++) {
    const d = dayOffset(nowDate, -i);
    map[d] = true;
    list.push(d);
  }
  return { map: map, list: list };
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function loadRecentShifts(limit) {
  const cap = Math.min(Number(limit) || SHIFT_LIMIT, SHIFT_LIMIT);
  try {
    return (await db.select().from(shifts).orderBy(desc(shifts.id)).limit(cap).all()) || [];
  } catch (e) {
    console.error('loadRecentShifts', e);
    return [];
  }
}

async function loadLightMessages(limit) {
  const cap = Math.min(Number(limit) || MSG_LIGHT, MSG_LIGHT);
  try {
    return (
      (await db
        .select({
          id: messages.id,
          status: messages.status,
          channelKey: messages.channelKey,
          reviewedBy: messages.reviewedBy,
          reviewedAt: messages.reviewedAt,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(cap)
        .all()) || []
    );
  } catch (e) {
    console.error('loadLightMessages', e);
    return [];
  }
}

export async function loadChannelAdminMap() {
  const byChannel = Object.create(null);
  const byAdmin = Object.create(null);
  try {
    const rows = (await db.select().from(channelAdmins).all()) || [];
    for (const r of rows) {
      const ck = String(r.channelKey || r.channel_key || '');
      const uid = Number(r.userId || r.user_id);
      if (!ck || !uid || isOwner(uid)) continue;
      if (!byChannel[ck]) byChannel[ck] = Object.create(null);
      byChannel[ck][uid] = true;
      if (!byAdmin[uid]) byAdmin[uid] = Object.create(null);
      byAdmin[uid][ck] = true;
    }
  } catch (e) {
    console.error('loadChannelAdminMap', e);
  }
  return { byChannel: byChannel, byAdmin: byAdmin };
}

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
    if (tehranDateOfTs(m.reviewedAt) !== sd) continue;
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
  return { ap: ap, rj: rj, total: ap + rj };
}

/** Board for last N days (default 7). channelKey null = all. */
export async function buildShiftBoard(channelKey, daysN) {
  const now = tehranNow();
  const n = Math.min(Math.max(Number(daysN) || 7, 1), 14);
  const days = lastNDays(n, now.date);
  const allSh = await loadRecentShifts(SHIFT_LIMIT);
  // light messages for today's running shift counts only
  const msgs = await loadLightMessages(2500);

  const keys = channelKey
    ? [channelKey]
    : Object.keys(DEFAULT_CHANNELS || {});

  const sections = [];
  const totals = {
    running: 0,
    completed: 0,
    cancelled: 0,
    upcoming: 0,
    idle: 0,
  };

  for (const ck of keys) {
    const conf = DEFAULT_CHANNELS[ck];
    if (!conf && channelKey) continue;
    const title = (conf && conf.title) || ck;
    const byDay = Object.create(null);
    for (const d of days.list) byDay[d] = [];

    const seen = Object.create(null);
    for (const s of allSh) {
      const sid = Number(s.id);
      if (sid && seen[sid]) continue;
      if (sid) seen[sid] = 1;
      const sck = String(s.channelKey || s.channel_key || '');
      if (sck !== ck) continue;
      const sd = String(s.shiftDate || s.shift_date || '');
      if (!days.map[sd]) continue;
      if (sd === 'perm' || sd === 'permanent') continue;
      const logical = classifyShiftStatus(s, now);
      if (logical === 'invalid') continue;
      const reviews = countReviewsInShift(s, msgs);
      const idle =
        logical !== 'cancelled' && logical !== 'upcoming' && reviews.total === 0 &&
        (logical === 'completed' || logical === 'running');
      const item = {
        id: sid,
        adminId: Number(s.adminId || s.admin_id),
        startHm: normHm(s.startHm || s.start_hm),
        endHm: normHm(s.endHm || s.end_hm),
        logical: logical,
        reviews: reviews,
        idle: idle,
        day: sd,
      };
      if (!byDay[sd]) byDay[sd] = [];
      byDay[sd].push(item);
      if (logical === 'running') totals.running++;
      else if (logical === 'completed') totals.completed++;
      else if (logical === 'upcoming') totals.upcoming++;
      else if (logical === 'cancelled') totals.cancelled++;
      if (idle) totals.idle++;
    }
    for (const d of days.list) {
      byDay[d].sort(function (a, b) {
        return periodOrd(a.startHm) - periodOrd(b.startHm);
      });
    }
    sections.push({ key: ck, title: title, byDay: byDay });
  }

  return { days: days.list, now: now, sections: sections, totals: totals };
}

export async function formatShiftBoardMessages(board) {
  const lines = [];
  let head = '⏰ شیفت‌ها — ' + board.days.length + ' روز اخیر\n';
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
  head += 'بدون فعالیت (پس از شروع): ' + board.totals.idle + '\n────────────\n';
  lines.push(head);

  for (const sec of board.sections) {
    let body = '📢 «' + sec.title + '»\n';
    let any = false;
    for (const d of board.days) {
      const list = (sec.byDay && sec.byDay[d]) || [];
      if (!list.length) continue;
      any = true;
      let jal = d;
      try {
        jal = toJalaliDisplay(d) || d;
      } catch (_e) {}
      body += '\n📅 ' + jal + ' (' + d + ')\n';
      for (const s of list) {
        let name = String(s.adminId);
        try {
          name = displayName(await getUser(s.adminId), s.adminId);
        } catch (_e) {}
        body +=
          '<blockquote>' +
          (STATUS_FA[s.logical] || s.logical) +
          (s.idle ? ' · بدون فعالیت' : '') +
          '\n⏰ ' +
          String(s.startHm).slice(0, 5) +
          '–' +
          String(s.endHm).slice(0, 5) +
          '\n👤 ' +
          esc(name) +
          '\n🆔 <code>' +
          s.adminId +
          '</code> · #' +
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
    }
    if (!any) body += '(شیفتی در این بازه نیست)\n';
    lines.push(body);
  }
  return lines;
}

/**
 * Fast HR report for firing/keeping admins:
 * - who had shifts in last 7 days
 * - who did not
 * - who had shifts but few approvals
 */
export async function buildWeeklyHrReport(scope) {
  const now = tehranNow();
  const days = lastNDays(7, now.date);
  const channelKeys =
    scope && scope !== 'all'
      ? [scope].filter(function (k) {
          return DEFAULT_CHANNELS[k];
        })
      : Object.keys(DEFAULT_CHANNELS || {});
  if (!channelKeys.length) return { error: 'کانال نامعتبر', texts: ['کانال نامعتبر'] };

  const scopeSet = Object.create(null);
  for (const k of channelKeys) scopeSet[k] = true;

  const [allSh, adminMap, msgs] = await Promise.all([
    loadRecentShifts(SHIFT_LIMIT),
    loadChannelAdminMap(),
    loadLightMessages(MSG_LIGHT),
  ]);

  // admins in scope
  const adminIds = [];
  const seenA = Object.create(null);
  for (const ck of channelKeys) {
    const set = adminMap.byChannel[ck] || {};
    for (const uidStr of Object.keys(set)) {
      const uid = Number(uidStr);
      if (!uid || seenA[uid]) continue;
      seenA[uid] = 1;
      adminIds.push(uid);
    }
  }

  const stats = Object.create(null);
  function ensure(aid) {
    if (!stats[aid]) {
      stats[aid] = {
        aid: Number(aid),
        shiftCount: 0,
        shiftActiveish: 0,
        shiftCancelled: 0,
        ap: 0,
        rj: 0,
        channels: Object.create(null),
      };
    }
    return stats[aid];
  }

  for (const aid of adminIds) ensure(aid);

  const seenSh = Object.create(null);
  for (const s of allSh) {
    const sid = Number(s.id);
    if (sid && seenSh[sid]) continue;
    if (sid) seenSh[sid] = 1;
    const ck = String(s.channelKey || s.channel_key || '');
    if (!scopeSet[ck]) continue;
    const sd = String(s.shiftDate || s.shift_date || '');
    if (!days.map[sd]) continue;
    if (sd === 'perm' || sd === 'permanent') continue;
    const aid = Number(s.adminId || s.admin_id);
    if (!aid || isOwner(aid) || !seenA[aid]) continue;
    const o = ensure(aid);
    o.shiftCount++;
    o.channels[ck] = true;
    const st = String(s.status || 'active');
    if (st === 'cancelled') o.shiftCancelled++;
    else o.shiftActiveish++;
  }

  // approvals in week from light sample (by reviewedAt day)
  for (const m of msgs) {
    const ck = String(m.channelKey || '');
    if (!scopeSet[ck]) continue;
    const st = String(m.status || '');
    if (st !== 'approved' && st !== 'rejected') continue;
    const day = tehranDateOfTs(m.reviewedAt);
    if (!day || !days.map[day]) continue;
    const aid = Number(m.reviewedBy);
    if (!aid || isOwner(aid) || !seenA[aid]) continue;
    const o = ensure(aid);
    if (st === 'approved') o.ap++;
    else o.rj++;
  }

  const withShift = [];
  const noShift = [];
  const lowApprove = [];

  for (const aid of adminIds) {
    const o = stats[aid] || ensure(aid);
    o.total = o.ap + o.rj;
    if (o.shiftCount > 0) {
      withShift.push(o);
      // کم‌تأیید: حداقل ۱ شیفت غیرلغو و تأیید کمتر از ۲
      if (o.shiftActiveish >= 1 && o.ap < 2) lowApprove.push(o);
    } else {
      noShift.push(o);
    }
  }

  withShift.sort(function (a, b) {
    return b.shiftCount - a.shiftCount || b.ap - a.ap;
  });
  lowApprove.sort(function (a, b) {
    return a.ap - b.ap || b.shiftCount - a.shiftCount;
  });
  noShift.sort(function (a, b) {
    return a.aid - b.aid;
  });

  return {
    error: null,
    scope: scope || 'all',
    days: days.list,
    withShift: withShift,
    noShift: noShift,
    lowApprove: lowApprove,
    msgSample: msgs.length,
    shiftSample: allSh.length,
  };
}

export async function formatWeeklyHrMessages(data) {
  if (data.error) return [data.error];
  const scopeTitle =
    data.scope === 'all'
      ? 'همه کانال‌ها'
      : (DEFAULT_CHANNELS[data.scope] && DEFAULT_CHANNELS[data.scope].title) || data.scope;

  const texts = [];
  let head =
    '📈 گزارش هفتگی ادمین — «' +
    scopeTitle +
    '»\n' +
    'بازه: ۷ روز اخیر\n' +
    'منبع: جدول شیفت + نمونه ' +
    data.msgSample +
    ' پیام اخیر برای شمارش تأیید/رد\n' +
    '────────────\n' +
    '✅ با شیفت: ' +
    data.withShift.length +
    '\n' +
    '❌ بدون شیفت: ' +
    data.noShift.length +
    '\n' +
    '⚠️ شیفت داشته، تأیید کم (<۲): ' +
    data.lowApprove.length +
    '\n';
  texts.push(head);

  // with shift
  let body = '✅ ادمین‌هایی که شیفت داشتند\n────────────\n';
  if (!data.withShift.length) {
    body += '(خالی)\n';
  } else {
    for (const o of data.withShift) {
      let name = String(o.aid);
      try {
        name = displayName(await getUser(o.aid), o.aid);
      } catch (_e) {}
      const chs = Object.keys(o.channels || {})
        .map(function (k) {
          return (DEFAULT_CHANNELS[k] && DEFAULT_CHANNELS[k].title) || k;
        })
        .join('، ');
      body +=
        '<blockquote>👤 ' +
        esc(name) +
        '\n🆔 <code>' +
        o.aid +
        '</code>\n⏰ شیفت: ' +
        o.shiftCount +
        ' (فعال/تمام ' +
        o.shiftActiveish +
        ' · لغو ' +
        o.shiftCancelled +
        ')\n📨 ✅' +
        o.ap +
        ' ❌' +
        o.rj +
        (chs ? '\n📺 ' + esc(chs) : '') +
        '</blockquote>\n';
      if (body.length > 3500) {
        texts.push(body);
        body = '✅ ادامه باشیفت‌ها\n';
      }
    }
  }
  texts.push(body);

  // low approve
  body = '⚠️ شیفت داشته ولی تأیید کم\n────────────\n';
  if (!data.lowApprove.length) {
    body += '(موردی نیست)\n';
  } else {
    for (const o of data.lowApprove) {
      let name = String(o.aid);
      try {
        name = displayName(await getUser(o.aid), o.aid);
      } catch (_e) {}
      body +=
        '<blockquote>👤 ' +
        esc(name) +
        '\n🆔 <code>' +
        o.aid +
        '</code>\n⏰ شیفت: ' +
        o.shiftCount +
        '\n✅ تأیید: ' +
        o.ap +
        ' · ❌ رد: ' +
        o.rj +
        '</blockquote>\n';
      if (body.length > 3500) {
        texts.push(body);
        body = '⚠️ ادامه\n';
      }
    }
  }
  texts.push(body);

  // no shift
  body = '❌ بدون هیچ شیفت در ۷ روز\n────────────\n';
  if (!data.noShift.length) {
    body += '(همه حداقل یک شیفت داشته‌اند)\n';
  } else {
    for (const o of data.noShift) {
      let name = String(o.aid);
      try {
        name = displayName(await getUser(o.aid), o.aid);
      } catch (_e) {}
      body += '• ' + name + ' — <code>' + o.aid + '</code>\n';
      if (body.length > 3500) {
        texts.push(body);
        body = '❌ ادامه بدون‌شیفت\n';
      }
    }
  }
  texts.push(body);

  texts.push(
    'ℹ️ تأیید/رد فقط از نمونهٔ پیام‌های اخیر است؛ اگر ادمین خیلی قدیمی بررسی کرده باشد ممکن است ۰ بماند.\n' +
      'لیست شیفت از جدول shifts و فقط ادمین‌های فعلی کانال است.'
  );
  return texts;
}

// Compat aliases used by older handlers
export async function buildAnalytics(scope, period) {
  const hr = await buildWeeklyHrReport(scope);
  return hr;
}

export async function formatAnalyticsMessages(data) {
  if (data && data.withShift) return formatWeeklyHrMessages(data);
  return ['گزارش خالی بود.'];
}

export async function formatAdminDetail(adminId, scope, period) {
  const hr = await buildWeeklyHrReport(scope || 'all');
  if (hr.error) return [hr.error];
  const all = (hr.withShift || []).concat(hr.noShift || []);
  const o = all.find(function (x) {
    return Number(x.aid) === Number(adminId);
  });
  if (!o) return ['ادمین در لیست فعلی کانال نیست.'];
  let name = String(o.aid);
  try {
    name = displayName(await getUser(o.aid), o.aid);
  } catch (_e) {}
  return [
    '👤 ' +
      name +
      '\n🆔 ' +
      o.aid +
      '\n⏰ شیفت ۷روز: ' +
      o.shiftCount +
      ' (غیرلغو ' +
      o.shiftActiveish +
      ' · لغو ' +
      o.shiftCancelled +
      ')\n✅ ' +
      o.ap +
      ' · ❌ ' +
      o.rj,
  ];
}
