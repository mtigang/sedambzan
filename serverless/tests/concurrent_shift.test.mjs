import assert from 'node:assert/strict';

function shiftIntervalOverlaps(aStart, aEnd, bStart, bEnd) {
  function toOrd(hm) {
    const parts = String(hm || '0:0').split(':').map(Number);
    let m = (parts[0] || 0) * 60 + (parts[1] || 0);
    if (m < 12 * 60) m += 24 * 60;
    return m;
  }
  let a = toOrd(aStart), b = toOrd(aEnd), c = toOrd(bStart), d = toOrd(bEnd);
  if (b <= a) b += 24 * 60;
  if (d <= c) d += 24 * 60;
  return a < d && c < b;
}

function wouldBlockOtherAdmin(existingAdmin, newAdmin, aS, aE, bS, bE) {
  if (Number(existingAdmin) === Number(newAdmin)) {
    return shiftIntervalOverlaps(aS, aE, bS, bE);
  }
  return false; // multi-admin allowed
}

assert.equal(wouldBlockOtherAdmin(1, 2, '12:00', '13:00', '12:00', '13:00'), false);
assert.equal(wouldBlockOtherAdmin(1, 1, '12:00', '13:00', '12:00', '13:00'), true);
assert.equal(wouldBlockOtherAdmin(1, 1, '12:00', '13:00', '13:00', '14:00'), false);

// fencing version monotonic
function nextVersion(prev) {
  return (Number(prev) || 0) + 1;
}
assert.equal(nextVersion(undefined), 1);
assert.equal(nextVersion(1), 2);
assert.equal(nextVersion(5), 6);

console.log('concurrent_shift: all passed');
