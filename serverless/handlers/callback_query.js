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
import { tehranNow, inRange, periodDateStr } from 'lib/time';
import { DEFAULT_CHANNELS } from 'lib/config';
import { channelMessageLink } from 'lib/resolve';
import {
  rejectReasonsInline,
  reviewInline,
  adminListInline,
  userOpenInline,
  shiftSlotsInline,
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
          link = channelMessageLink(conf.chatId, mid);
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
        let txt = '✅ پیام #' + id + ' تأیید و منتشر شد.';
        if (link) txt += '\n' + link;
        await api.sendMessage({ chat_id: row.userId, text: txt });
      } catch (_) {}
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
      const pending = ms.filter((m) => m.status === 'pending');
      let body =
        '👤 ' + displayName(uu, uid) + '\nآیدی: ' + uid + '\n\n— پیام‌ها —\n';
      for (const m of ms.slice(0, 25)) {
        body += '#' + m.id + ' | ' + m.status + '\n' + (m.content || '') + '\n\n';
      }
      if (pending.length) {
        body += '— در صف —\n';
        for (const m of pending) body += '#' + m.id + '\n' + m.content + '\n\n';
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: body.slice(0, 3500),
        reply_markup: userOpenInline(uid),
      });
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
        const link = channelMessageLink(conf?.chatId, sent?.message_id);
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
      await api.answerCallbackQuery({ callback_query_id: cq.id, text: 'شیفت شماست' });
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
      if (target === 'admins') {
        const ads = (await db.select().from(channelAdmins).all()) || [];
        ids = [...new Set(ads.map((a) => a.userId || a.user_id).filter(Boolean))];
      } else {
        const all = (await db.select().from(users).all()) || [];
        ids = all.map((u) => u.userId || u.user_id).filter(Boolean);
      }
      ids = ids.filter((id) => id && id !== userId);
      const total = ids.length;
      let ok = 0;
      let fail = 0;
      const progress = await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '📣 در حال ارسال... 0/' + total,
      });
      const bar = (done, tot) => {
        const n = tot ? Math.floor((done / tot) * 10) : 0;
        return '█'.repeat(n) + '░'.repeat(10 - n);
      };
      for (let i = 0; i < ids.length; i++) {
        try {
          await api.sendMessage({ chat_id: ids[i], text: annText });
          ok++;
        } catch (_) {
          fail++;
        }
        if (i % 25 === 0 || i === ids.length - 1) {
          try {
            await api.editMessageText({
              chat_id: cq.message.chat.id,
              message_id: progress.message_id,
              text:
                '📣 ارسال\n' +
                bar(i + 1, total) +
                ' ' +
                (i + 1) +
                '/' +
                total +
                '\n✅ ' +
                ok +
                ' ❌ ' +
                fail,
            });
          } catch (_) {}
        }
      }
      await api.sendMessage({
        chat_id: cq.message.chat.id,
        text: '✅ اطلاعیه تمام شد.\nموفق: ' + ok + ' / ناموفق: ' + fail + ' از ' + total,
      });
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
