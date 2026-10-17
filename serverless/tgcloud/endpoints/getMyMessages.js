/**
 * لیست پیام‌های اخیر کاربر برای مینی‌اپ
 */
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { messages } from 'schema';
import { formatTsJalali } from 'lib/time';
import { getUser, isOwner } from 'lib/dbutil';

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) {
    return { items: [] };
  }
  const uid = Number(user.id);
  try {
    if (!isOwner(uid)) {
      const u = await getUser(uid);
      if (u && Number(u.blocked) === 1) return { items: [], blocked: true };
    }
  } catch (_e) {}

  let limit = Number((input && input.limit) || 15);
  if (!Number.isFinite(limit) || limit < 1) limit = 15;
  limit = Math.min(limit, 30);

  let rows = [];
  try {
    rows = (await db.select().from(messages).where(eq(messages.userId, uid)).all()) || [];
  } catch (_e) {
    rows = [];
  }
  const list = rows
    .sort(function (a, b) {
      return (b.id || 0) - (a.id || 0);
    })
    .slice(0, limit);

  const map = {
    pending: '🟡 در انتظار',
    approved: '🟢 تأیید',
    rejected: '🔴 رد',
    publishing: '⏳ انتشار',
  };

  return {
    items: list.map(function (row) {
      return {
        id: row.id,
        status: row.status,
        statusLabel: map[row.status] || row.status,
        content: String(row.content || '').slice(0, 120),
        when: formatTsJalali(row.submittedAt),
        channelKey: row.channelKey,
      };
    }),
  };
}
