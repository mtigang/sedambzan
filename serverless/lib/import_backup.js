import { db } from 'sdk';
import { users, messages, feedback, settings } from 'schema';
import { eq } from 'sdk/db';
import {
  USER_CHUNKS,
  MESSAGE_CHUNKS,
  loadUserChunk,
  loadMessageChunk,
  loadFeedback,
  loadSettings,
} from 'lib/seed/index';

export async function importUsersChunk(i) {
  const rows = await loadUserChunk(i);
  let ok = 0, skip = 0, fail = 0;
  for (const r of rows) {
    try {
      const exist = await db.select().from(users).where(eq(users.userId, r.userId)).all();
      if (exist && exist.length) {
        skip++;
        continue;
      }
      await db
        .insert(users)
        .values({
          userId: r.userId,
          username: r.username || null,
          firstName: r.firstName || null,
          lastName: r.lastName || null,
          role: 'user',
          started: r.started ? 1 : 0,
          blocked: r.blocked ? 1 : 0,
        })
        .run();
      ok++;
    } catch (e) {
      fail++;
      console.error('user', r.userId, e);
    }
  }
  return { chunk: i, totalChunks: USER_CHUNKS, ok, skip, fail, size: rows.length };
}

export async function importMessagesChunk(i) {
  const rows = await loadMessageChunk(i);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      await db
        .insert(messages)
        .values({
          userId: r.userId,
          content: r.content,
          channelKey: r.channelKey || 'sadambazan',
          status: r.status || 'pending',
          rejectReason: r.rejectReason || null,
          reviewedBy: r.reviewedBy || null,
        })
        .run();
      ok++;
    } catch (e) {
      fail++;
      console.error('msg', r.id, e);
    }
  }
  return { chunk: i, totalChunks: MESSAGE_CHUNKS, ok, fail, size: rows.length };
}

export async function importFeedbackAll() {
  const rows = await loadFeedback();
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      await db
        .insert(feedback)
        .values({
          userId: r.userId,
          content: r.content,
          status: r.status || 'open',
          ownerReply: r.ownerReply || null,
        })
        .run();
      ok++;
    } catch (e) {
      fail++;
    }
  }
  return { ok, fail, size: rows.length };
}

export async function importSettingsAll() {
  const rows = await loadSettings();
  let ok = 0;
  for (const r of rows) {
    try {
      const exist = await db.select().from(settings).where(eq(settings.key, r.key)).all();
      if (exist && exist.length) {
        await db.update(settings).set({ value: r.value }).where(eq(settings.key, r.key)).run();
      } else {
        await db.insert(settings).values({ key: r.key, value: r.value }).run();
      }
      ok++;
    } catch (e) {
      console.error('setting', r.key, e);
    }
  }
  return { ok };
}

export { USER_CHUNKS, MESSAGE_CHUNKS };
