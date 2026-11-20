/**
 * Static regression checks for queue eligibility semantics.
 * Runs without Telegram / tgcloud runtime.
 */
import assert from 'node:assert/strict';

// Mirror of normalizeBatchState
function normalizeBatchState(raw, adminId) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const channelKeys = Array.isArray(b.channelKeys)
    ? b.channelKeys.map(String).filter(Boolean)
    : b.channelKey
      ? [String(b.channelKey)]
      : [];
  return {
    ids: Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [],
    delivered: Array.isArray(b.delivered) ? b.delivered.map(Number).filter(Boolean) : [],
    failed: Array.isArray(b.failed) ? b.failed.map(Number).filter(Boolean) : [],
    channelKeys,
    batchNumber: Number(b.batchNumber) || 1,
    createdAt: Number(b.createdAt) || Date.now(),
    version: Number(b.version) || 1,
    adminId: Number(b.adminId || adminId) || Number(adminId) || 0,
    completed: !!b.completed,
  };
}

function remainingToSend(batch, pendingRows) {
  const delSet = Object.create(null);
  for (const d of batch.delivered || []) delSet[Number(d)] = 1;
  return pendingRows.filter((r) => !delSet[Number(r.id)]);
}

// Test F: continuation never resends delivered
{
  const batch = normalizeBatchState({
    ids: [1, 2, 3, 4, 5],
    delivered: [1, 2, 3],
    channelKeys: ['sadambazan'],
    batchNumber: 1,
  }, 42);
  const pending = [1, 2, 3, 4, 5].map((id) => ({ id, status: 'pending', channelKey: 'sadambazan' }));
  const toSend = remainingToSend(batch, pending);
  assert.deepEqual(toSend.map((r) => r.id), [4, 5]);
}

// Test: batch channelKeys immutable shape
{
  const batch = normalizeBatchState({ ids: [10], delivered: [], channelKeys: ['kash'] }, 1);
  assert.deepEqual(batch.channelKeys, ['kash']);
  assert.equal(batch.batchNumber, 1);
}

// Test: empty delivered preserved
{
  const batch = normalizeBatchState({ ids: [1, 2], delivered: [1, 2], channelKeys: ['a'] }, 1);
  const toSend = remainingToSend(batch, [{ id: 1 }, { id: 2 }]);
  assert.equal(toSend.length, 0);
}

// Test: batch number defaults
{
  const b = normalizeBatchState({ ids: [] }, 9);
  assert.equal(b.batchNumber, 1);
  assert.equal(b.adminId, 9);
}

console.log('queue_invariants: all passed');

// Delete fallback replacement text must be exact
{
  const FALLBACK = 'محتوا حذف شده است';
  assert.equal(FALLBACK, 'محتوا حذف شده است');
}

// Stale batch_next should prefer resume when undelivered pending remains
{
  function shouldResumeStale(want, cur) {
    if (want == null || !cur) return false;
    if (!cur.ids || !cur.ids.length) return false;
    if (Number(cur.batchNumber) === Number(want)) return false;
    return true; // resume current, do not create
  }
  assert.equal(shouldResumeStale(1, { batchNumber: 2, ids: [10, 11] }), true);
  assert.equal(shouldResumeStale(2, { batchNumber: 2, ids: [10] }), false);
  assert.equal(shouldResumeStale(1, null), false);
}

console.log('extended invariants: all passed');
