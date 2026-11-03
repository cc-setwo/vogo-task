const http = require('node:http');

const statuses = new Set(['pending', 'confirmed', 'cancelled']);
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function parseTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  // Require a timezone and at most millisecond precision; reject time overflow.
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return NaN;
  const date = new Date(`${match[1]}T00:00:00Z`);
  // Date.parse can normalize impossible dates such as February 30.
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return NaN;
  return Date.parse(value);
}

function createServer() {
  const bookings = new Map();

  return http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const bookingRoute = /^\/bookings\/([^/]+)$/.exec(pathname);

    if (pathname === '/webhooks/booking') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reply(405, { error: 'Method not allowed' });
      }

      let payload;
      try {
        req.setEncoding('utf8');
        let body = '';
        for await (const chunk of req) body += chunk;
        payload = JSON.parse(body);
      } catch {
        return reply(400, { error: 'Expected a valid JSON body' });
      }

      if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        return reply(400, { error: 'Expected a JSON object' });
      }
      const { booking_id, property_id, status, sent_at } = payload;
      const timestamp = parseTimestamp(sent_at);
      if (!nonEmptyString(booking_id) || !nonEmptyString(property_id)
          || !statuses.has(status) || !Number.isFinite(timestamp)) {
        return reply(400, { error: 'Expected non-empty string IDs, a valid status, and an ISO sent_at timestamp with timezone and at most 3 fractional digits' });
      }

      const previous = bookings.get(booking_id);
      if (previous && previous.property_id !== property_id) {
        return reply(409, { error: 'property_id cannot change for an existing booking_id' });
      }
      // Equal timestamps cannot establish event order: keep the first state.
      const applied = !previous || timestamp > Date.parse(previous.sent_at);
      if (applied) bookings.set(booking_id, { booking_id, property_id, status, sent_at });
      return reply(previous ? 200 : 201, { applied, booking: bookings.get(booking_id) });
    }

    if (bookingRoute) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return reply(405, { error: 'Method not allowed' });
      }
      let id;
      try {
        id = decodeURIComponent(bookingRoute[1]);
      } catch {
        return reply(400, { error: 'Invalid booking ID encoding' });
      }
      const booking = bookings.get(id);
      return booking ? reply(200, booking) : reply(404, { error: 'Booking not found' });
    }

    reply(404, { error: 'Not found' });
  });
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log(`Booking receiver listening on port ${port}`));
}

module.exports = { createServer };
