import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { messages, feedback, shifts, settings, users, channelAdmins } from 'schema';
import {
  isOwner,
  removeChannelAdmin,
  listAdminsByChannel,
  syncAdminsFromGroup,
  postToChannel,
  toBoldHtml,
  displayName,
  getUser,
  settingGet,
  settingSet,
  activeShiftAdmins,
  deliverPendingForAdmin,
  addChannelAdmin,
} from 'lib/dbutil';
import { setState, getState, clearState } from 'lib/state';
import { tehranNow, inRange, periodDateStr, formatTsJalali } from 'lib/time';
import { DEFAULT_CHANNELS } from 'lib/config';
import { channelMessageLink } from 'lib/resolve';
import {
  rejectReasonsInline,
  reviewInline,
  adminListInline,
  userOpenInline,
  shiftSlotsInline,
  announceProgressInline,
} from 'lib/keyboards';

async function refreshAllShiftBoards(channelKey, date) {
  const dayShifts =
    (await db
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.channelKey, channelKey),
          eq(shifts.shiftDate, date),
          eq(shifts.status, 'active')
        )
      )
      .all()) || [];
  const takenMap = {};
  for (const s of dayShifts) takenMap[s.startHm] = s.adminId;

  // همه boardهای ذخیره‌شده برای این کانال/روز
  try {
    const allSettings = await db.select().from(settings).all();
    const prefix = 'shift_board:' + channelKey + ':' + date + ':';
    for (const row of allSettings || []) {
      if (!row.key || !row.key.startsWith(prefix) || !row.value) continue;
      try {
        const info = JSON.parse(row.value);
        const adminId = Number(row.key.slice(prefix.length));
        const myStarts = new Set(
          dayShifts.filter((s) => s.adminId === adminId).map((s) => s.startHm)
        );
        await api.editMessageReplyMarkup({
          chat_id: info.chatId,
          message_id: info.messageId,
          reply_markup: shiftSlotsInline(channelKey, takenMap, myStarts),
        });
      } catch (e) {
        console.error('refresh board', e);
      }
    }
  } catch (e) {
    console.error('refreshAllShiftBoards', e);
  }
}

export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;

    // ادمین فقط در شیفت بتواند تأیید/رد کند (مالک همیشه)
    async function assertCanReview() {
      if (isOwner(userId)) return true;
      const now = tehranNow();
      const period = periodDateStr(now);
      const mySh = (await db.select().from(shifts).where(eq(shifts.adminId, userId)).all()) || [];
      return mySh.some((s) => {
        if (s.status !== 'active') return false;
        if (s.shiftDate === 'permanent' || s.shiftDate === 'perm') {
          return inRange(now.hm, s.startHm, s.endHm);
        }
        if (s.shiftDate !== period && s.shiftDate !== now.date) return false;
        return inRange(now.hm, s.startHm, s.endHm);
      });
    }

    
    if (data.startsWith('uv:')) {
      const uid = Number(data.slice(3));
      let u = null;
      try { u = await getUser(uid); } catch (_) {}
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(uid)
        : String(uid);
      const un = u?.username ? '@' + u.username : '—';
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          '👤 ' +
          name +
          '\nیوزرنیم: ' +
          un +
          '\nآیدی: ' +
          uid,
      });
      return;
    }

    if (data.startsWith('approve:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date() })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تأیید شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🟢 تأیید #' + id + ' توسط ' + userId,
        });
      } catch (_) {}

      let link = null;
      try {
        const conf = DEFAULT_CHANNELS[row.channelKey];
        if (conf?.chatId) {
          const sent = await api.sendMessage({ chat_id: conf.chatId, text: toBoldHtml(row.content), parse_mode: 'HTML' });
          const mid = sent && sent.message_id;
          link = channelMessageLink(conf.chatId, mid, row.channelKey);
        }
      } catch (e) {
        console.error('publish', e);
        try {
          await api.sendMessage({
            chat_id: userId,
            text: '⚠️ تأیید شد ولی ارسال کانال ناموفق: ' + (e?.description || e),
          });
        } catch (_) {}
      }
      try {
        const conf2 = DEFAULT_CHANNELS[row.channelKey];
        const title = (conf2 && conf2.title) || row.channelKey;
        let txt = '✅ پیام شما تأیید و منتشر شد.';
        if (link) {
          txt += '\n\nمشاهده در کانال «' + title + '»:\n' + link;
        }
        await api.sendMessage({
          chat_id: row.userId,
          text: txt,
          link_preview_options: link ? { is_disabled: false, url: link } : undefined,
        });
      } catch (_e) {}
      return;
    }

    if (data.startsWith('reject_menu:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: rejectReasonsInline(id),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_cancel:')) {
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: reviewInline(id),
        });
      } catch (_) {}
      return;
    }

    
    if (data.startsWith('reject_other:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط در شیفت', show_alert: true });
        return;
      }
      const id = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await setState(userId, 'reject_custom', { msgId: id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'دلیل رد را بنویسید (حداکثر ۲۲ کاراکتر):',
      });
      return;
    }
if (data.startsWith('reject:')) {
      if (!(await assertCanReview())) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'فقط در زمان شیفت خودتان',
          show_alert: true,
        });
        return;
      }
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'قبلاً بررسی شده',
          show_alert: true,
        });
        return;
      }
      await db
        .update(messages)
        .set({
          status: 'rejected',
          rejectReason: reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
        })
        .where(eq(messages.id, id))
        .run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🔴 رد #' + id + '\nدلیل: ' + reason,
        });
      } catch (_) {}
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '🔴 پیام #' + id + ' رد شد.\nدلیل: ' + reason,
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('fb_reply:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await setState(userId, 'fb_reply', { feedbackId: fid });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({ chat_id: cq.message.chat.id, text: 'پاسخ #' + fid + ':' });
      return;
    }

    if (data.startsWith('fb_close:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const fid = Number(data.split(':')[1]);
      await db.update(feedback).set({ status: 'closed' }).where(eq(feedback.id, fid)).run();
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'بسته شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '✅ فیدبک #' + fid + ' بسته شد',
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('fb_user:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const uid = Number(data.split(':')[1]);
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const uu = await getUser(uid);
      const ms = (await db.select().from(messages).where(eq(messages.userId, uid)).all()) || [];
      const pe = ms.filter(function (m) { return m.status === 'pending'; }).length;
      const ap = ms.filter(function (m) { return m.status === 'approved'; }).length;
      const rj = ms.filter(function (m) { return m.status === 'rejected'; }).length;
      const map = { pending: '🟡', approved: '🟢', rejected: '🔴' };
      let body =
        '👤 ' +
        displayName(uu, uid) +
        '\n🆔 ' +
        uid +
        (uu && uu.username ? '\n@' + uu.username : '') +
        '\nنقش: ' +
        ((uu && uu.role) || 'user') +
        '\n📨 پیام‌ها: ' +
        ms.length +
        ' | 🟡' +
        pe +
        ' 🟢' +
        ap +
        ' 🔴' +
        rj;
      try {
        if (uu && uu.createdAt) body += '\n📅 عضویت: ' + formatTsJalali(uu.createdAt);
      } catch (_e) {}
      await api.sendMessage({ chat_id: cq.message.chat.id, text: body });
      if (ms.length) {
        const last = ms.sort(function (a, b) { return b.id - a.id; }).slice(0, 15);
        let list = 'آخرین پیام‌ها:\n';
        for (const row of last) {
          const short = (row.content || '').replace(/\n/g, ' ').slice(0, 70);
          list += (map[row.status] || '•') + ' #' + row.id + ' | ' + row.status + '\n' + short + '\n\n';
        }
        await api.sendMessage({ chat_id: cq.message.chat.id, text: list.slice(0, 3500) });
      }
      return;
    }

    if (data.startsWith('adel:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const [, channelKey, tid] = data.split(':');
      await removeChannelAdmin(Number(tid), channelKey);
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'حذف شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: adminListInline(ads, channelKey),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('aadd:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      await setState(userId, 'add_admin_id', { channelKey });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text:
          'آیدی عددی یا @username برای افزودن به «' +
          (DEFAULT_CHANNELS[channelKey]?.title || '') +
          '»:',
      });
      return;
    }

    if (data.startsWith('async:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const res = await syncAdminsFromGroup(channelKey);
      const ads = await listAdminsByChannel(channelKey);
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: res.ok ? 'بروز شد' : 'خطا',
        show_alert: true,
      });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '👮 ادمین‌های «' +
            (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
            '»\nتعداد: ' +
            ads.length,
          reply_markup: adminListInline(ads, channelKey),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('postch:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      await setState(userId, 'post_text', { channelKey });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'متن برای «' + (DEFAULT_CHANNELS[channelKey]?.title || channelKey) + '»:',
      });
      return;
    }

    if (data === 'postch_cancel' || data === 'post_no') {
      await clearState(userId);
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      return;
    }

    if (data === 'post_yes') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const st = await getState(userId);
      if (!st || st.kind !== 'post_confirm' || !st.postText) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'منقضی', show_alert: true });
        return;
      }
      try {
        const sent = await postToChannel(st.channelKey, st.postText);
        await clearState(userId);
        const conf = DEFAULT_CHANNELS[st.channelKey];
        const link = channelMessageLink(conf && conf.chatId, sent && sent.message_id, state && state.channelKey);
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ارسال شد' });
        try {
          await api.editMessageText({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text:
              '✅ ارسال شد به «' +
              (conf?.title || '') +
              '»' +
              (link ? '\n' + link : ''),
          });
        } catch (_) {}
      } catch (e) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'خطا: ' + (e?.description || 'fail'),
          show_alert: true,
        });
      }
      return;
    }

    if (data.startsWith('shift_full:')) {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'این شیفت پر است',
        show_alert: true,
      });
      return;
    }
    if (data.startsWith('shift_mine:')) {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'برای لغو روی «لغو» بزنید' });
      return;
    }
    if (data.startsWith('shift_cancel:')) {
      const parts = data.split(':');
      const channelKey = parts[1];
      const hourKey = parts[2];
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const mySh =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, userId), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      for (const s of mySh) {
        const sameHour =
          s.startHm === hourKey ||
          String(s.startHm).slice(0, 2) === String(hourKey).slice(0, 2);
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent' ||
          s.shiftDate === now.date;
        if (s.channelKey === channelKey && sameHour && sameDate) {
          await db
            .update(shifts)
            .set({ status: 'cancelled' })
            .where(
              and(
                eq(shifts.adminId, userId),
                eq(shifts.channelKey, channelKey),
                eq(shifts.startHm, s.startHm),
                eq(shifts.shiftDate, s.shiftDate)
              )
            )
            .run();
          cancelled++;
        }
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: cancelled ? 'لغو شد' : 'پیدا نشد',
        show_alert: true,
      });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
      try {
        const dayShifts =
          (await db
            .select()
            .from(shifts)
            .where(
              and(
                eq(shifts.channelKey, channelKey),
                eq(shifts.shiftDate, pdate),
                eq(shifts.status, 'active')
              )
            )
            .all()) || [];
        const takenMap = {};
        for (const s of dayShifts) takenMap[s.startHm] = s.adminId;
        const myStarts = new Set(
          dayShifts.filter(function (s) { return s.adminId === userId; }).map(function (s) { return s.startHm; })
        );
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: shiftSlotsInline(channelKey, takenMap, myStarts),
        });
      } catch (_e) {}
      return;
    }
    if (data === 'shift_close') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: 'بسته شد.',
        });
      } catch (_) {}
      return;
    }

    
    
    if (data === 'own_shift_list') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all = (await db.select().from(shifts).all()) || [];
      const today = all.filter(function (s) {
        return s.status === 'active' && (s.shiftDate === pdate || s.shiftDate === 'perm' || s.shiftDate === 'permanent');
      });
      let t = '⏰ شیفت‌های دوره ' + pdate + '\n(دائمی هم نمایش داده می‌شود)\n\n';
      if (!today.length) t += 'خالی';
      for (const s of today) {
        let name = String(s.adminId);
        try {
          name = displayName(await getUser(s.adminId), s.adminId);
        } catch (_e) {}
        t +=
          '• ' +
          (DEFAULT_CHANNELS[s.channelKey] && DEFAULT_CHANNELS[s.channelKey].title
            ? DEFAULT_CHANNELS[s.channelKey].title
            : s.channelKey) +
          ' | ' +
          s.startHm +
          '–' +
          s.endHm +
          ' | ' +
          name +
          (s.shiftDate === 'perm' || s.shiftDate === 'permanent' ? ' (دائم)' : '') +
          '\n';
      }
      await api.sendMessage({ chat_id: cq.message.chat.id, text: t });
      return;
    }

    if (data.startsWith('own_shift:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const mode = data.split(':')[1];
      await setState(userId, 'own_assign', { mode: mode });
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'کانال را انتخاب کنید:',
        reply_markup: {
          keyboard: Object.values(DEFAULT_CHANNELS).map(function (c) {
            return [{ text: 'شیفت: ' + c.title }];
          }).concat([[{ text: '◀️ بازگشت' }]]),
          resize_keyboard: true,
        },
      });
      return;
    }


    async function loadAnnounceJob() {
      const raw = await settingGet('announce_job', '');
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (_e) {
        return null;
      }
    }

    async function saveAnnounceJob(job) {
      await settingSet('announce_job', JSON.stringify(job));
    }

    async function runAnnounceBatch(chatId, progressMessageId) {
      const BATCH = 80;
      const job = await loadAnnounceJob();
      if (!job || job.status !== 'running') {
        await api.sendMessage({
          chat_id: chatId,
          text: job && job.status === 'done' ? '✅ اطلاعیه قبلاً تمام شده.' : 'هیچ ارسال فعالی نیست.',
        });
        return;
      }
      const ids = job.ids || [];
      const text = job.text || '';
      let cursor = Number(job.cursor) || 0;
      let ok = Number(job.ok) || 0;
      let fail = Number(job.fail) || 0;
      const total = ids.length;
      const end = Math.min(cursor + BATCH, total);

      for (let i = cursor; i < end; i++) {
        try {
          await api.sendMessage({ chat_id: ids[i], text: text });
          ok++;
        } catch (_e) {
          fail++;
        }
      }
      cursor = end;
      job.cursor = cursor;
      job.ok = ok;
      job.fail = fail;
      const finished = cursor >= total;
      if (finished) job.status = 'done';
      await saveAnnounceJob(job);

      const pct = total ? Math.floor((cursor / total) * 10) : 10;
      let bar = '';
      for (let i = 0; i < 10; i++) bar += i < pct ? '█' : '░';
      const body =
        (finished ? '✅ اطلاعیه تمام شد\n' : '📣 در حال ارسال (تکه‌تکه)\n') +
        bar +
        ' ' +
        cursor +
        '/' +
        total +
        '\n✅ ' +
        ok +
        '  ❌ ' +
        fail +
        (finished ? '' : '\n\nبرای دسته بعدی «ادامه ارسال» را بزن.');

      try {
        if (progressMessageId) {
          await api.editMessageText({
            chat_id: chatId,
            message_id: progressMessageId,
            text: body,
            reply_markup: announceProgressInline(finished),
          });
        } else {
          await api.sendMessage({
            chat_id: chatId,
            text: body,
            reply_markup: announceProgressInline(finished),
          });
        }
      } catch (_e) {
        await api.sendMessage({
          chat_id: chatId,
          text: body,
          reply_markup: announceProgressInline(finished),
        });
      }
    }


if (data === 'ann_cancel') {
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو' });
      await clearState(userId);
      return;
    }

    if (data.startsWith('ann_target:')) {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const target = data.split(':')[1];
      const st = await getState(userId);
      const annText = st && st.annText;
      await clearState(userId);
      if (!annText) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: 'متن پیدا نشد. دوباره 📣 اطلاعیه را بزنید.',
        });
        return;
      }
      let ids = [];
      const seen = {};
      if (target === 'admins') {
        const ads = (await db.select().from(channelAdmins).all()) || [];
        for (const a of ads) {
          const id = a.userId || a.user_id;
          if (id && !seen[id] && id !== userId) {
            seen[id] = true;
            ids.push(id);
          }
        }
      } else {
        const all = (await db.select().from(users).all()) || [];
        for (const u of all) {
          const id = u.userId || u.user_id;
          if (id && !seen[id] && id !== userId) {
            seen[id] = true;
            ids.push(id);
          }
        }
      }
      const job = {
        status: 'running',
        text: annText,
        ids: ids,
        cursor: 0,
        ok: 0,
        fail: 0,
        target: target,
        ownerId: userId,
      };
      await saveAnnounceJob(job);
      const progress = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '📣 صف ارسال آماده شد: ' + ids.length + ' نفر\nاولین دسته در حال ارسال...',
        reply_markup: announceProgressInline(false),
      });
      const mid = progress && progress.message_id;
      await runAnnounceBatch(cq.message.chat.id, mid);
      return;
    }

    if (data === 'ann_continue') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ادامه...' });
      await runAnnounceBatch(cq.message.chat.id, cq.message.message_id);
      return;
    }

    if (data === 'ann_stop') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const job = await loadAnnounceJob();
      if (job && job.status === 'running') {
        job.status = 'stopped';
        await saveAnnounceJob(job);
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'متوقف شد' });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            '⏹ ارسال متوقف شد.\n' +
            (job
              ? 'پیشرفت: ' + (job.cursor || 0) + '/' + ((job.ids && job.ids.length) || 0) +
                '\n✅ ' + (job.ok || 0) + '  ❌ ' + (job.fail || 0)
              : ''),
          reply_markup: announceProgressInline(true),
        });
      } catch (_e) {}
      return;
    }

    if (data === 'ann_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      return;
    }


    if (data.startsWith('shift_pick:')) {
      const parts = data.split(':');
      const channelKey = parts[1];
      const startHm = parts[2];
      const endHm = parts[3];
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const stAssign = await getState(userId);
      if (stAssign && stAssign.kind === 'own_assign_slot') {
        const targetAdmin = stAssign.adminId;
        const mode = stAssign.mode;
        const shiftDate = mode === 'perm' ? 'perm' : pdate;
        await clearState(userId);
        await db
          .insert(shifts)
          .values({
            channelKey,
            adminId: targetAdmin,
            shiftDate,
            startHm,
            endHm,
            status: 'active',
          })
          .run();
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تخصیص شد' });
        await api.sendMessage({
          chat_id: userId,
          text:
            '✅ شیفت ' +
            startHm +
            '–' +
            endHm +
            ' برای ادمین ' +
            targetAdmin +
            ' (' +
            (mode === 'perm' ? 'دائمی' : 'روزانه') +
            ') ثبت شد.',
        });
        try {
          await api.sendMessage({
            chat_id: targetAdmin,
            text:
              '📌 شیفت جدید برای شما ثبت شد:\n' +
              (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
              ' ' +
              startHm +
              '–' +
              endHm +
              (mode === 'perm' ? ' (دائمی)' : ''),
          });
        } catch (_) {}
        return;
      }


      const mine =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.adminId, userId), eq(shifts.status, 'active')))
          .all()) || [];
      const minePeriod = mine.filter((s) => s.shiftDate === pdate || s.shiftDate === 'perm');
      if (minePeriod.length >= 2) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'حداکثر ۲ شیفت در هر دوره',
          show_alert: true,
        });
        return;
      }
      const taken =
        (await db
          .select()
          .from(shifts)
          .where(
            and(
              eq(shifts.channelKey, channelKey),
              eq(shifts.status, 'active')
            )
          )
          .all()) || [];
      const conflict = taken.filter(
        (s) =>
          s.startHm === startHm &&
          (s.shiftDate === pdate || s.shiftDate === 'perm')
      );
      if (conflict.length) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'پر شده',
          show_alert: true,
        });
        await refreshAllShiftBoards(channelKey, pdate);
        return;
      }

      await db
        .insert(shifts)
        .values({
          channelKey,
          adminId: userId,
          shiftDate: pdate,
          startHm,
          endHm,
          status: 'active',
        })
        .run();

      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'ثبت شد ✅' });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (e) {
        console.error('refresh', e);
      }
      try {
        // also edit THIS message keyboard immediately
        const dayShifts =
          (await db
            .select()
            .from(shifts)
            .where(
              and(
                eq(shifts.channelKey, channelKey),
                eq(shifts.shiftDate, pdate),
                eq(shifts.status, 'active')
              )
            )
            .all()) || [];
        const takenMap = {};
        for (const s of dayShifts) takenMap[s.startHm] = s.adminId;
        const myStarts = new Set(
          dayShifts.filter((s) => s.adminId === userId).map((s) => s.startHm)
        );
        // include current pick even if startHm partial
        myStarts.add(startHm);
        takenMap[startHm] = userId;
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: shiftSlotsInline(channelKey, takenMap, myStarts),
        });
      } catch (e) {
        console.error('edit self board', e);
      }
      try {
        const n = await deliverPendingForAdmin(userId);
        if (n > 0) {
          await api.sendMessage({
            chat_id: userId,
            text: '📥 ' + n + ' پیام صف ارسال شد.',
          });
        }
      } catch (e) {
        console.error('deliver', e);
      }
      await api.sendMessage({
        chat_id: userId,
        text:
          '✅ شیفت «' +
          (DEFAULT_CHANNELS[channelKey]?.title || channelKey) +
          '» ' +
          startHm +
          '–' +
          endHm +
          ' ثبت شد (دوره ' +
          pdate +
          ').',
      });
      return;
    }

  } catch (e) {
    console.error('cb', e);
    try {
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'خطا',
        show_alert: true,
      });
    } catch (_) {}
  }
}
