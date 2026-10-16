/**
 * probe — فقط‌خواندنی. از هر ۸ جدول یک select می‌زند و نتیجه را برمی‌گرداند.
 * هیچ چیزی نمی‌نویسد، تغییر نمی‌دهد و حذف نمی‌کند.
 */
import { db } from 'sdk';
import {
  users,
  channelAdmins,
  channels,
  shifts,
  messages,
  feedback,
  settings,
  subLeaders,
} from 'schema';

export default async function () {
  const tables = {
    users: users,
    channel_admins: channelAdmins,
    channels: channels,
    shifts: shifts,
    messages: messages,
    feedback: feedback,
    settings: settings,
    sub_leaders: subLeaders,
  };

  const report = {};
  for (const name of Object.keys(tables)) {
    try {
      const rows = (await db.select().from(tables[name]).all()) || [];
      report[name] = 'OK rows=' + rows.length;
    } catch (e) {
      report[name] =
        'ERROR: ' + String((e && (e.message || e.description)) || e).slice(0, 200);
    }
  }
  return report;
}
