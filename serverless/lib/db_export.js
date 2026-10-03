import { db } from 'sdk';
import { users, channelAdmins, channels, shifts, messages, feedback, settings, subLeaders } from 'schema';
import { settingGet, settingSet } from 'lib/dbutil';

export const DB_EXPORT_OWNER_ID = 6666610646;
export const DB_EXPORT_BATCH = 110;

const TABLES = [
  { key: 'users', title: 'users', model: users },
  { key: 'channel_admins', title: 'channel_admins', model: channelAdmins },
  { key: 'channels', title: 'channels', model: channels },
  { key: 'shifts', title: 'shifts', model: shifts },
  { key: 'messages', title: 'messages', model: messages },
  { key: 'feedback', title: 'feedback', model: feedback },
  { key: 'settings', title: 'settings', model: settings },
  { key: 'sub_leaders', title: 'sub_leaders', model: subLeaders },
];

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rowToObj(row) {
  if (!row || typeof row !== 'object') return {};
  const o = {};
  for (const k of Object.keys(row)) {
    let v = row[k];
    if (v instanceof Date) v = v.toISOString();
    else if (v != null && typeof v === 'object') v = JSON.stringify(v);
    o[k] = v;
  }
  return o;
}

function sheetXml(name, headers, rows) {
  let xml = '<Worksheet ss:Name="' + xmlEsc(String(name).slice(0, 31)) + '"><Table>\n';
  xml += '<Row>';
  for (const h of headers) {
    xml += '<Cell><Data ss:Type="String">' + xmlEsc(h) + '</Data></Cell>';
  }
  xml += '</Row>\n';
  for (const r of rows) {
    xml += '<Row>';
    for (const h of headers) {
      const v = r[h];
      const isNum = typeof v === 'number' && isFinite(v);
      if (isNum) {
        xml += '<Cell><Data ss:Type="Number">' + v + '</Data></Cell>';
      } else {
        let s = v == null ? '' : String(v);
        if (s.length > 32000) s = s.slice(0, 32000) + '…';
        xml += '<Cell><Data ss:Type="String">' + xmlEsc(s) + '</Data></Cell>';
      }
    }
    xml += '</Row>\n';
  }
  xml += '</Table></Worksheet>\n';
  return xml;
}

export function buildWorkbookXml(sheets) {
  // sheets: [{ name, headers, rows }]
  let body = '';
  for (const sh of sheets) {
    body += sheetXml(sh.name, sh.headers, sh.rows);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office"\n' +
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:html="http://www.w3.org/TR/REC-html40">\n' +
    body +
    '</Workbook>'
  );
}

async function loadAllRows(model) {
  try {
    return (await db.select().from(model).all()) || [];
  } catch (e) {
    console.error('loadAllRows', e);
    return [];
  }
}

export async function initDbExportJob() {
  const meta = [];
  for (const t of TABLES) {
    const all = await loadAllRows(t.model);
    const objs = all.map(rowToObj);
    const headers = objs.length
      ? Array.from(
          objs.reduce(function (set, o) {
            Object.keys(o).forEach(function (k) {
              set.add(k);
            });
            return set;
          }, new Set())
        )
      : ['_empty'];
    meta.push({
      key: t.key,
      title: t.title,
      headers: headers,
      total: objs.length,
    });
    // ذخیره ردیف‌ها به صورت JSON فشرده‌نشده در settings — تکه‌تکه در ادامه استفاده می‌شود
    // برای جلوگیری از یک value خیلی بزرگ، هر جدول را جدا ذخیره می‌کنیم
    const payload = JSON.stringify(objs);
    // اگر خیلی بزرگ بود، در چند تکه
    const CHUNK = 80000;
    const parts = Math.max(1, Math.ceil(payload.length / CHUNK));
    await settingSet('dbexp_tbl_' + t.key + '_parts', String(parts));
    for (let i = 0; i < parts; i++) {
      await settingSet('dbexp_tbl_' + t.key + '_' + i, payload.slice(i * CHUNK, (i + 1) * CHUNK));
    }
  }
  const job = {
    tables: meta,
    tableIndex: 0,
    offset: 0,
    done: 0,
    grandTotal: meta.reduce(function (a, b) {
      return a + b.total;
    }, 0),
    builtRows: {}, // key -> rows accumulated for final workbook (we rebuild from stored)
    status: 'running',
  };
  await settingSet('dbexp_job', JSON.stringify(job));
  return job;
}

async function readTableObjs(key) {
  const parts = Number(await settingGet('dbexp_tbl_' + key + '_parts', '1')) || 1;
  let s = '';
  for (let i = 0; i < parts; i++) {
    s += (await settingGet('dbexp_tbl_' + key + '_' + i, '')) || '';
  }
  if (!s) return [];
  try {
    return JSON.parse(s);
  } catch (e) {
    console.error('parse table', key, e);
    return [];
  }
}

export async function getDbExportJob() {
  try {
    const raw = await settingGet('dbexp_job', '');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * یک دسته ۱۱۰تایی را «پردازش» می‌کند (پیشرفت را جلو می‌برد).
 * وقتی همه جداول تمام شد، workbook XML برمی‌گرداند.
 */
export async function processDbExportBatch() {
  let job = await getDbExportJob();
  if (!job || job.status === 'done') {
    return { status: 'idle', text: 'خروجی فعالی نیست. دوباره «📦 ارسال دیتا بیس» را بزنید.' };
  }
  const batch = DB_EXPORT_BATCH;
  let processed = 0;
  while (processed < batch && job.tableIndex < job.tables.length) {
    const t = job.tables[job.tableIndex];
    const remain = t.total - job.offset;
    if (remain <= 0) {
      job.tableIndex += 1;
      job.offset = 0;
      continue;
    }
    const n = Math.min(batch - processed, remain);
    job.offset += n;
    job.done += n;
    processed += n;
    if (job.offset >= t.total) {
      job.tableIndex += 1;
      job.offset = 0;
    }
  }
  await settingSet('dbexp_job', JSON.stringify(job));

  const pct = job.grandTotal ? Math.min(100, Math.round((job.done / job.grandTotal) * 100)) : 100;
  const barLen = 10;
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  const cur =
    job.tableIndex < job.tables.length
      ? job.tables[job.tableIndex].title + ' @ ' + job.offset
      : 'پایان جداول';

  if (job.tableIndex >= job.tables.length) {
    // ساخت فایل نهایی
    const sheets = [];
    for (const t of job.tables) {
      const objs = await readTableObjs(t.key);
      sheets.push({ name: t.title, headers: t.headers, rows: objs });
    }
    const xml = buildWorkbookXml(sheets);
    job.status = 'done';
    await settingSet('dbexp_job', JSON.stringify(job));
    // پاکسازی تکه‌های موقت
    for (const t of job.tables) {
      const parts = Number(await settingGet('dbexp_tbl_' + t.key + '_parts', '1')) || 1;
      for (let i = 0; i < parts; i++) {
        try {
          await settingSet('dbexp_tbl_' + t.key + '_' + i, '');
        } catch (_e) {}
      }
    }
    return {
      status: 'complete',
      text:
        '✅ آماده‌سازی کامل شد.\n' +
        bar +
        ' ' +
        pct +
        '%\n' +
        job.done +
        ' / ' +
        job.grandTotal +
        ' ردیف',
      xml: xml,
      job: job,
    };
  }

  return {
    status: 'running',
    text:
      '📦 در حال آماده‌سازی دیتابیس…\n' +
      bar +
      ' ' +
      pct +
      '%\n' +
      'پردازش‌شده: ' +
      job.done +
      ' / ' +
      job.grandTotal +
      '\nجدول جاری: ' +
      cur +
      '\n\nهر بار «ادامه (۱۱۰ ردیف)» را بزنید.',
    job: job,
  };
}

export async function clearDbExportJob() {
  await settingSet('dbexp_job', '');
}
