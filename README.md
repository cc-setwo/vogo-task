# Booking webhook receiver

Uses built-in Node.js modules only. Run with a current Node.js LTS release; no installation is needed.

```sh
node server.js
node --test
```

`npm start` and `npm test` are equivalent shortcuts. The server defaults to port 3000; set `PORT` to override it.

Send JSON to `POST /webhooks/booking`:

```json
{
  "booking_id": "booking-1",
  "property_id": "property-1",
  "status": "confirmed",
  "sent_at": "2026-11-03T10:00:00Z"
}
```

- IDs must be non-empty strings. Status must be `pending`, `confirmed`, or `cancelled`.
- `sent_at` must be a valid ISO timestamp in `YYYY-MM-DDTHH:mm:ss[.SSS]Z` format or with a numeric timezone offset such as `+03:00`. Optional fractional seconds have 1–3 digits (millisecond precision). Impossible dates, overflowing times, date-only strings, and timestamps without a timezone return **400**.
- A new booking returns **201**. Updates and ignored events return **200**, with `{ "applied": true/false, "booking": ... }`. Invalid payloads or malformed JSON return **400**.
- A booking's `property_id` is fixed on creation. A valid event with a different property returns **409** without modifying state, whether its timestamp is older, equal, or newer.
- `GET /bookings/:id` returns the stored booking, or **404** if missing. Unsupported methods on known routes return **405**; unknown routes return **404**.

Each server owns an in-memory Map keyed by `booking_id`. Data is lost on restart and is not shared between processes. Only a strictly newer timestamp replaces a booking; duplicate and older events are acknowledged without changing it. Comparison and replacement are synchronous so requests cannot interleave that operation.

**Equal-timestamp limitation:** for events with the same booking and property IDs, the first stored event wins, including when equal instants use different timezone offsets. Without an event sequence or another ordering key, conflicting statuses at the same timestamp cannot be ordered reliably. Timestamps are compared at JavaScript's millisecond precision; finer precision is rejected to avoid silently treating distinct instants as equal.

Tests use real HTTP requests, a fresh server and Map per test, ephemeral loopback ports, and automatic server cleanup.
