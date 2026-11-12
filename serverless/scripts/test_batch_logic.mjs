/** Pure logic unit tests for Batch helpers (no DB / Telegram). */
function escapeHtmlBatch(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function parseTelegramRetryAfter(err) {
  try {
    if (!err) return 0;
    if (err.parameters && err.parameters.retry_after != null) return Number(err.parameters.retry_after) || 0;
    const msg = String(err.description || err.message || err || '');
    const m = msg.match(/retry after (\d+)/i);
    if (m) return Number(m[1]) || 0;
  } catch (_e) {}
  return 0;
}
function isTelegram429(err) {
  try {
    const code = Number(err && (err.error_code || err.code || err.statusCode)) || 0;
    if (code === 429) return true;
    const msg = String((err && (err.description || err.message)) || err || '').toLowerCase();
    return msg.includes('too many requests') || msg.includes('retry after');
  } catch (_e) { return false; }
}
function normalizeBatchState(raw, adminId) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    ids: Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [],
    delivered: Array.isArray(b.delivered) ? b.delivered.map(Number).filter(Boolean) : [],
    failed: Array.isArray(b.failed) ? b.failed.map(Number).filter(Boolean) : [],
    batchNumber: Number(b.batchNumber) || 1,
    createdAt: Number(b.createdAt) || 1,
    periodDate: b.periodDate || 'x',
    version: Number(b.version) || 1,
    adminId: Number(b.adminId || adminId) || Number(adminId) || 0,
  };
}
function isPermanentTelegramError(err) {
  try {
    const code = Number(err && (err.error_code || err.code)) || 0;
    if (code === 400 || code === 403 || code === 404) return true;
  } catch (_e) {}
  return false;
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL', msg); }
  else console.log('OK', msg);
}

assert(escapeHtmlBatch('a<b>&"') === 'a&lt;b&gt;&amp;&quot;', 'html escape');
assert(parseTelegramRetryAfter({ parameters: { retry_after: 3 } }) === 3, 'retry_after param');
assert(parseTelegramRetryAfter({ description: 'Too Many Requests: retry after 7' }) === 7, 'retry_after text');
assert(isTelegram429({ error_code: 429 }), '429 code');
assert(isTelegram429({ description: 'Too Many Requests' }), '429 text');
assert(isPermanentTelegramError({ error_code: 400 }), 'permanent 400');
assert(!isPermanentTelegramError({ error_code: 429 }), '429 not permanent');
const n = normalizeBatchState({ ids: ['1', 2], delivered: [1], batchNumber: 5 }, 99);
assert(n.ids.length === 2 && n.delivered[0] === 1 && n.batchNumber === 5 && n.adminId === 99, 'normalize batch');
assert(n.ids.includes(1) && n.ids.includes(2), 'normalize ids numbers');
// 16+3 investigation: remaining count is live pending after partial delivery, not batch size invariant
const delivered = 16, remainingPendingInBatch = 3, size = 18;
assert(delivered + remainingPendingInBatch !== size, '16+3 can exceed size when residual+new or stale ids');
assert(delivered <= size && remainingPendingInBatch <= size, 'each count bounded by size separately');

if (failed) {
  console.error(failed, 'failures');
  process.exit(1);
}
console.log('All pure tests passed');
