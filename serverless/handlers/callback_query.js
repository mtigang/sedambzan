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
  addChannelAdmin,
  getRole,
  decideMessage,
  checkReviewAccess,
  createReviewBatch,
  sendReviewBatch,
  finishReviewBatchIfComplete,
  getReviewBatch,
  findAdminShiftConflict,
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
  ownerCancelShiftsInline,
  reviewNextInline,
  reviewDoneInline,
  reviewTakenInline,
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
  for (const s of dayShifts) {
          if (String(s.startHm) === String(s.endHm)) continue;
          takenMap[s.startHm] = s.adminId;
        }

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

/** ویرایش پیام بعد از تأیید/رد؛ اگر Batch کامل شد دکمه‌ی بعدی یا «صف تمام شد» */
async function editReviewResult(cq, text, fin) {
  let markup = null;
  if (fin && fin.inBatch && fin.complete) {
    markup = fin.hasMore ? reviewNextInline(fin.batch.batchNumber) : reviewDoneInline();
  }
  try {
    const p = {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text,
    };
    if (markup) p.reply_markup = markup;
    await api.editMessageText(p);
  } catch (_) {}
  if (fin && fin.inBatch && fin.complete && !fin.hasMore) {
    try {
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '📭 پیام Pending دیگری برای شیفت شما وجود ندارد.',
      });
    } catch (_) {}
  }
}

export default async function (cq) {
  try {
    const data = cq.data || '';
    const userId = cq.from?.id;
    if (!userId) return;

    
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
      const id = Number(data.split(':')[1]);
      // pending بودن + شیفت فعال همان کانال + عضویت در Batch + قفل (idempotent)
      const dec = await decideMessage(userId, id, 'approve');
      if (!dec.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: dec.text, show_alert: true });
        return;
      }
      const row = dec.row;
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'تأیید شد' });
      const fin = await finishReviewBatchIfComplete(userId, id);
      await editReviewResult(cq, '🟢 تأیید #' + id + ' توسط ' + userId, fin);

      let link = null;
      try {
        const conf = DEFAULT_CHANNELS[row.channelKey];
        if (conf?.chatId) {
          const sent = await api.sendMessage({ chat_id: conf.chatId, text: toBoldHtml(row.content), parse_mode: 'HTML' });
          const mid = sent && sent.message_id;
          link = channelMessageLink(conf.chatId, mid, row.channelKey);
          try {
            if (mid) await settingSet('chmsg:' + row.channelKey + ':' + mid, String(id));
          } catch (_e) {}
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
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        return;
      }
      const acc = await checkReviewAccess(userId, row);
      if (!acc.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text, show_alert: true });
        return;
      }
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
      let showNext = false;
      let bn = null;
      try {
        const b = await getReviewBatch(userId);
        if (b && b.ids.length && Number(b.ids[b.ids.length - 1]) === id) {
          showNext = true;
          bn = b.batchNumber;
        }
      } catch (_) {}
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: reviewInline(id, showNext, bn),
        });
      } catch (_) {}
      return;
    }

    if (data.startsWith('reject_other:')) {
      const id = Number(data.split(':')[1]);
      const rows = await db.select().from(messages).where(eq(messages.id, id)).all();
      const row = rows?.[0];
      if (!row || row.status !== 'pending') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'قبلاً بررسی شده', show_alert: true });
        return;
      }
      const acc = await checkReviewAccess(userId, row);
      if (!acc.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: acc.text, show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      await setState(userId, 'reject_custom', { msgId: id });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: 'دلیل رد را بنویسید (حداکثر ۲۲ کاراکتر):',
      });
      return;
    }

    if (data.startsWith('reject:')) {
      const parts = data.split(':');
      const id = Number(parts[1]);
      const reason = parts.slice(2).join(':') || 'نامناسب';
      const dec = await decideMessage(userId, id, 'reject', reason);
      if (!dec.ok) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: dec.text, show_alert: true });
        return;
      }
      const row = dec.row;
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'رد شد' });
      const fin = await finishReviewBatchIfComplete(userId, id);
      await editReviewResult(cq, '🔴 رد #' + id + '\nدلیل: ' + reason, fin);
      try {
        await api.sendMessage({
          chat_id: row.userId,
          text: '🔴 پیام #' + id + ' رد شد.\nدلیل: ' + reason,
        });
      } catch (_) {}
      return;
    }

    if (data === 'review_noop') {
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      return;
    }

    // دریافت Batch بعدی — همه‌ی شرط‌ها دوباره از DB بررسی می‌شود
    if (data === 'review_next' || data.startsWith('review_next:')) {
      const want = data.indexOf(':') >= 0 ? Number(data.split(':')[1]) : null;
      const role = await getRole(userId);
      if (role !== 'admin' && !isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'دسترسی ندارید', show_alert: true });
        return;
      }
      if (want != null) {
        const cur = await getReviewBatch(userId);
        if (cur && Number(cur.batchNumber) !== want) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این دکمه قدیمی است. دوباره «📥 پیام‌های در انتظار» را بزنید.',
            show_alert: true,
          });
          return;
        }
      }
      const res = await createReviewBatch(userId);
      if (res.status === 'no_shift') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ شیفت شما تمام شده است.', show_alert: true });
        return;
      }
      if (res.status === 'busy') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: '⏳ در حال پردازش…', show_alert: true });
        return;
      }
      if (res.status === 'incomplete') {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'اول هر ۱۰ پیام فعلی را بررسی کنید.',
          show_alert: true,
        });
        return;
      }
      if (res.status === 'empty') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پیامی نمانده' });
        try {
          await api.editMessageReplyMarkup({
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: reviewDoneInline(),
          });
        } catch (_) {}
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '📭 پیام Pending دیگری برای شیفت شما وجود ندارد.',
        });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Batch جدید' });
      try {
        await api.editMessageReplyMarkup({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: reviewTakenInline(),
        });
      } catch (_) {}
      await sendReviewBatch(cq.message.chat.id, res.batch, res.messages, { resumed: false });
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
    
    if (data.startsWith('shift_ocancel:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const parts = data.split(':');
      const channelKey = parts[1];
      const hourKey = parts[2];
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      for (const s of all) {
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent' ||
          s.shiftDate === now.date;
        if (!sameDate) continue;
        const sh = String(s.startHm || '');
        const bucket =
          String(Number(String(sh).split(':')[0]) || 0).padStart(2, '0') + ':00';
        if (bucket !== hourKey && sh !== hourKey) continue;
        await db
          .update(shifts)
          .set({ status: 'cancelled' })
          .where(and(eq(shifts.id, s.id)))
          .run();
        cancelled++;
        try {
          await api.sendMessage({
            chat_id: s.adminId,
            text:
              '⚠️ شیفت شما در «' +
              ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
              '» ' +
              sh +
              ' توسط مالک لغو شد.',
          });
        } catch (_e) {}
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: cancelled ? 'لغو شد (' + cancelled + ')' : 'پیدا نشد',
        show_alert: true,
      });
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
      return;
    }

    if (data.startsWith('shift_oclear:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const channelKey = data.split(':')[1];
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all =
        (await db
          .select()
          .from(shifts)
          .where(and(eq(shifts.channelKey, channelKey), eq(shifts.status, 'active')))
          .all()) || [];
      let cancelled = 0;
      const notified = {};
      for (const s of all) {
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent' ||
          s.shiftDate === now.date;
        if (!sameDate) continue;
        await db
          .update(shifts)
          .set({ status: 'cancelled' })
          .where(and(eq(shifts.id, s.id)))
          .run();
        cancelled++;
        if (!notified[s.adminId]) {
          notified[s.adminId] = true;
          try {
            await api.sendMessage({
              chat_id: s.adminId,
              text:
                '⚠️ تمام شیفت‌های امروز شما در «' +
                ((DEFAULT_CHANNELS[channelKey] && DEFAULT_CHANNELS[channelKey].title) || channelKey) +
                '» توسط مالک لغو شد.',
            });
          } catch (_e) {}
        }
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'لغو همه: ' + cancelled,
        show_alert: true,
      });
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: '🗑 همه شیفت‌های امروز «' + channelKey + '» لغو شد (' + cancelled + ').',
        });
      } catch (_e) {}
      try {
        await refreshAllShiftBoards(channelKey, pdate);
      } catch (_e) {}
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
        for (const s of dayShifts) {
          if (String(s.startHm) === String(s.endHm)) continue;
          takenMap[s.startHm] = s.adminId;
        }
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
        return (
          s.status === 'active' &&
          (s.shiftDate === pdate ||
            s.shiftDate === 'perm' ||
            s.shiftDate === 'permanent' ||
            s.shiftDate === now.date)
        );
      });
      const rows = [];
      let t =
        '⏰ شیفت‌های دوره ' +
        pdate +
        '\nروی هر دکمه بزنید تا همان شیفت لغو شود.\n\n';
      if (!today.length) {
        t += 'خالی — شیفتی برای لغو نیست.';
      }
      for (const s of today) {
        let name = String(s.adminId);
        try {
          name = displayName(await getUser(s.adminId), s.adminId);
        } catch (_e) {}
        const title =
          DEFAULT_CHANNELS[s.channelKey] && DEFAULT_CHANNELS[s.channelKey].title
            ? DEFAULT_CHANNELS[s.channelKey].title
            : s.channelKey;
        t +=
          '• #' +
          s.id +
          ' | ' +
          title +
          ' | ' +
          String(s.startHm).slice(0, 5) +
          '–' +
          String(s.endHm).slice(0, 5) +
          ' | ' +
          name +
          (s.shiftDate === 'perm' || s.shiftDate === 'permanent' ? ' (دائم)' : '') +
          '\n';
        rows.push({
          id: s.id,
          channelKey: s.channelKey,
          channelTitle: title,
          startHm: s.startHm,
          endHm: s.endHm,
          adminId: s.adminId,
          name: name,
        });
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: t,
        reply_markup: today.length ? ownerCancelShiftsInline(rows) : undefined,
      });
      return;
    }


    if (data.startsWith('own_sc:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const sid = Number(data.split(':')[1]);
      if (!sid) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'نامعتبر', show_alert: true });
        return;
      }
      const rows = (await db.select().from(shifts).where(eq(shifts.id, sid)).all()) || [];
      const row = rows[0];
      if (!row || row.status !== 'active') {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'پیدا نشد / قبلاً لغو', show_alert: true });
        return;
      }
      await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, sid)).run();
      let name = String(row.adminId);
      try {
        name = displayName(await getUser(row.adminId), row.adminId);
      } catch (_e) {}
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'لغو شد' });
      try {
        await api.sendMessage({
          chat_id: row.adminId,
          text:
            '⚠️ شیفت شما توسط مالک لغو شد:\n' +
            ((DEFAULT_CHANNELS[row.channelKey] && DEFAULT_CHANNELS[row.channelKey].title) ||
              row.channelKey) +
            ' ' +
            String(row.startHm).slice(0, 5) +
            '–' +
            String(row.endHm).slice(0, 5),
        });
      } catch (_e) {}
      try {
        await api.editMessageText({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text:
            (cq.message.text || '') +
            '\n\n❌ لغو شد: #' +
            sid +
            ' | ' +
            name +
            ' | ' +
            String(row.startHm).slice(0, 5),
        });
      } catch (_e) {
        await api.sendMessage({
          chat_id: cq.message.chat.id,
          text: '❌ شیفت #' + sid + ' لغو شد (' + name + ').',
        });
      }
      return;
    }

    if (data === 'own_cancel_all') {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      const now = tehranNow();
      const pdate = periodDateStr(now);
      const all = (await db.select().from(shifts).all()) || [];
      const today = all.filter(function (s) {
        return (
          s.status === 'active' &&
          (s.shiftDate === pdate ||
            s.shiftDate === 'perm' ||
            s.shiftDate === 'permanent' ||
            s.shiftDate === now.date)
        );
      });
      let n = 0;
      const notified = {};
      for (const s of today) {
        try {
          await db.update(shifts).set({ status: 'cancelled' }).where(eq(shifts.id, s.id)).run();
          n++;
          if (!notified[s.adminId]) {
            notified[s.adminId] = true;
            try {
              await api.sendMessage({
                chat_id: s.adminId,
                text: '⚠️ مالک همه شیفت‌های دوره فعلی را لغو کرد.',
              });
            } catch (_e) {}
          }
        } catch (_e) {}
      }
      await api.answerCallbackQuery({
        callback_query_id: cq.id,
        text: n ? 'لغو شد: ' + n : 'چیزی نبود',
        show_alert: true,
      });
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '🗑 تعداد ' + n + ' شیفت دوره «' + pdate + '» (و دائم‌های نمایش‌داده‌شده) لغو شد.',
      });
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



    if (data.startsWith('admin_stats:')) {
      if (!isOwner(userId)) {
        await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'فقط مالک', show_alert: true });
        return;
      }
      await api.answerCallbackQuery({ callback_query_id: cq.id });
      const daysAgo = Number(data.split(':')[1]) || 0;
      const now = tehranNow();
      const parts = now.date.split('-').map(Number);
      const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      dt.setUTCDate(dt.getUTCDate() - daysAgo);
      const day =
        dt.getUTCFullYear() +
        '-' +
        String(dt.getUTCMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getUTCDate()).padStart(2, '0');
      const allMsg = (await db.select().from(messages).all()) || [];
      const allSh = (await db.select().from(shifts).all()) || [];
      let body =
        '👮 آمار ادمین‌ها\n📅 ' +
        day +
        (daysAgo ? ' (' + daysAgo + ' روز پیش)' : ' (امروز)') +
        '\n';
      for (const conf of Object.values(DEFAULT_CHANNELS)) {
        body += '\n━━━━━━━━━━━━\n📢 «' + conf.title + '»\n━━━━━━━━━━━━\n';
        const dayShifts = allSh.filter(function (s) {
          return (
            s.channelKey === conf.key &&
            s.status === 'active' &&
            (s.shiftDate === day || s.shiftDate === 'perm' || s.shiftDate === 'permanent') &&
            String(s.startHm) !== String(s.endHm)
          );
        });
        const adminIds = [];
        const seenA = {};
        for (const s of dayShifts) {
          const aid = Number(s.adminId);
          if (aid && !seenA[aid]) {
            seenA[aid] = true;
            adminIds.push(aid);
          }
        }
        for (const msg of allMsg) {
          if (msg.channelKey !== conf.key || !msg.reviewedBy) continue;
          const aid = Number(msg.reviewedBy);
          if (aid && !seenA[aid]) {
            seenA[aid] = true;
            adminIds.push(aid);
          }
        }
        if (!adminIds.length) {
          body += 'بدون فعالیت\n';
          continue;
        }
        for (const aid of adminIds) {
          let name = String(aid);
          try {
            name = displayName(await getUser(aid), aid);
          } catch (_e) {}
          const reviewed = allMsg.filter(function (msg) {
            return msg.channelKey === conf.key && Number(msg.reviewedBy) === aid;
          });
          const ap = reviewed.filter(function (x) {
            return x.status === 'approved';
          }).length;
          const rj = reviewed.filter(function (x) {
            return x.status === 'rejected';
          }).length;
          const shList = dayShifts
            .filter(function (s) {
              return Number(s.adminId) === aid;
            })
            .map(function (s) {
              return String(s.startHm).slice(0, 5) + ' تا ' + String(s.endHm).slice(0, 5);
            })
            .join(' | ');
          body +=
            '\n👤 ' +
            name +
            '\n⏰ ' +
            (shList || 'بدون شیفت') +
            '\n✅ تأیید ' +
            ap +
            ' | ❌ رد ' +
            rj +
            ' | جمع ' +
            reviewed.length +
            '\n';
        }
      }
      let cur = body;
      while (cur.length > 3500) {
        await api.sendMessage({ chat_id: cq.message.chat.id, text: cur.slice(0, 3500) });
        cur = cur.slice(3500);
      }
      await api.sendMessage({ chat_id: cq.message.chat.id, text: cur });
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
        const targetConflict = await findAdminShiftConflict(targetAdmin, shiftDate, startHm, endHm);
        if (targetConflict) {
          await api.answerCallbackQuery({
            callback_query_id: cq.id,
            text: 'این ادمین در این بازه شیفت دیگری دارد.',
            show_alert: true,
          });
          return;
        }
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
            displayName(await getUser(targetAdmin), targetAdmin) +
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
      const conflict = taken.filter((s) => {
        const sameDate =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent';
        if (!sameDate) return false;
        const toOrd = (hm) => {
          const parts = String(hm || '0:0').split(':').map(Number);
          let m = (parts[0] || 0) * 60 + (parts[1] || 0);
          if (m < 12 * 60) m += 24 * 60;
          return m;
        };
        const a = toOrd(startHm);
        let b = toOrd(endHm);
        const c = toOrd(s.startHm);
        let d = toOrd(s.endHm);
        if (b <= a) b += 24 * 60;
        if (d <= c) d += 24 * 60;
        return a < d && c < b;
      });
      if (conflict.length) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'این بازه در این کانال پر است.',
          show_alert: true,
        });
        await refreshAllShiftBoards(channelKey, pdate);
        return;
      }

      const ownConflict = await findAdminShiftConflict(userId, pdate, startHm, endHm);
      if (ownConflict) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'این بازه با یکی از شیفت‌های خودتان تداخل دارد.',
          show_alert: true,
        });
        return;
      }

      const mineCount = taken.filter((s) => {
        const same =
          s.shiftDate === pdate ||
          s.shiftDate === 'perm' ||
          s.shiftDate === 'permanent';
        return same && Number(s.adminId) === Number(userId);
      }).length;
      if (mineCount >= 3) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'حداکثر ۳ شیفت در هر دوره',
          show_alert: true,
        });
        return;
      }
      if (String(startHm) === String(endHm)) {
        await api.answerCallbackQuery({
          callback_query_id: cq.id,
          text: 'بازه نامعتبر',
          show_alert: true,
        });
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
        for (const s of dayShifts) {
          if (String(s.startHm) === String(s.endHm)) continue;
          takenMap[s.startHm] = s.adminId;
        }
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
          ').\n\nبرای دریافت پیام‌ها «📥 پیام‌های در انتظار» را بزنید.',
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
