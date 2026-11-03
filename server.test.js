const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('./server');

const confirmed = {
  booking_id: 'booking-1',
  property_id: 'property-1',
  status: 'confirmed',
  sent_at: '2026-11-03T10:00:00Z',
};
const cancelled = { ...confirmed, status: 'cancelled', sent_at: '2026-11-03T11:00:00Z' };

async function client(t) {
  const server = createServer();
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, options) {
    const response = await fetch(base + path, options);
    return { status: response.status, body: await response.json() };
  }
  return {
    get: (id = confirmed.booking_id) => request(`/bookings/${encodeURIComponent(id)}`),
    post: (payload) => request('/webhooks/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    request,
  };
}

test('stores a new confirmed booking', async (t) => {
  const api = await client(t);
  assert.equal((await api.get()).status, 404);
  assert.deepEqual(await api.post(confirmed), {
    status: 201, body: { applied: true, booking: confirmed },
  });
  assert.deepEqual(await api.get(), { status: 200, body: confirmed });
});

test('an exact duplicate does not change the stored state', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  assert.deepEqual(await api.post(confirmed), {
    status: 200, body: { applied: false, booking: confirmed },
  });
  assert.deepEqual((await api.get()).body, confirmed);
});

test('applies a newer cancellation', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  assert.deepEqual(await api.post(cancelled), {
    status: 200, body: { applied: true, booking: cancelled },
  });
  assert.deepEqual((await api.get()).body, cancelled);
});

test('ignores an older confirmation arriving after cancellation', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  await api.post(cancelled);
  assert.equal((await api.post(confirmed)).body.applied, false);
  assert.deepEqual((await api.get()).body, cancelled);
});

test('an invalid status returns 400 without storing a booking', async (t) => {
  const api = await client(t);
  assert.equal((await api.post({ ...confirmed, status: 'unknown' })).status, 400);
  assert.equal((await api.get()).status, 404);
});

test('malformed or missing statuses return 400', async (t) => {
  const api = await client(t);
  for (const status of [null, 42, {}, ['confirmed'], undefined]) {
    assert.equal((await api.post({ ...confirmed, status })).status, 400);
  }
  assert.equal((await api.get()).status, 404);
});

test('equal timestamps keep the first state, even with conflicting statuses', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  const conflicting = { ...confirmed, status: 'cancelled' };
  assert.equal((await api.post(conflicting)).body.applied, false);
  // Different timestamp strings can also represent the same instant.
  assert.equal((await api.post({ ...conflicting, sent_at: '2026-11-03T13:00:00+03:00' })).body.applied, false);
  assert.deepEqual((await api.get()).body, confirmed);
});

test('rejects conflicting property IDs regardless of event order', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  for (const sent_at of ['2026-11-03T09:00:00Z', confirmed.sent_at, cancelled.sent_at]) {
    assert.equal((await api.post({ ...cancelled, property_id: 'property-2', sent_at })).status, 409);
    assert.deepEqual((await api.get()).body, confirmed);
  }
});

test('rejects missing, blank, or incorrectly typed required fields', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  for (const field of ['booking_id', 'property_id', 'status', 'sent_at']) {
    for (const value of [undefined, null, '', '   ', 123, true, {}, []]) {
      assert.equal((await api.post({ ...confirmed, [field]: value })).status, 400, field);
    }
  }
  assert.equal((await api.post({ ...cancelled, status: 'unknown' })).status, 400);
  assert.deepEqual((await api.get()).body, confirmed);
});

test('rejects invalid or ambiguous timestamps without modifying state', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  for (const sent_at of [
    'not-a-date', '123', '11/04/2026', '2026-11-04', '2026-11-04T10:00:00',
    '2026-02-29T10:00:00Z', '2026-11-31T10:00:00Z', '2026-13-01T10:00:00Z',
    '2026-11-04T24:00:00Z', '2026-11-04T10:60:00Z', '2026-11-04T10:00:60Z',
    '2026-11-04T10:00:00+24:00', '2026-11-04T10:00:00.0001Z',
  ]) {
    assert.equal((await api.post({ ...cancelled, sent_at })).status, 400, sent_at);
    assert.deepEqual((await api.get()).body, confirmed);
  }
});

test('accepts leap days and orders timezone offsets and milliseconds by instant', async (t) => {
  const api = await client(t);
  const first = { ...confirmed, status: 'pending', sent_at: '2028-02-29T23:00:00.001Z' };
  const newer = { ...confirmed, sent_at: '2028-03-01T02:00:00.002+03:00' };
  assert.equal((await api.post(first)).status, 201);
  assert.equal((await api.post(newer)).body.applied, true);
  assert.equal((await api.post({ ...first, sent_at: '2028-02-29T18:00:00.001-05:00' })).body.applied, false);
  assert.deepEqual((await api.get()).body, newer);
});

test('rejects invalid payloads and malformed JSON without changing stored state', async (t) => {
  const api = await client(t);
  await api.post(confirmed);
  for (const payload of [null, [], {},
    { ...confirmed, booking_id: '' },
    { ...confirmed, property_id: 123 },
    { ...confirmed, sent_at: 'not-a-date' },
    { ...confirmed, sent_at: 123 },
  ]) {
    assert.equal((await api.post(payload)).status, 400);
  }
  assert.equal((await api.request('/webhooks/booking', { method: 'POST', body: '{' })).status, 400);
  assert.deepEqual((await api.get()).body, confirmed);
});
