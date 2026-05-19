// Best-effort in-memory rate limiter. Serverless instances are not shared, so
// this throttles per-instance only — enough to blunt accidental floods and
// trivial abuse. For hard guarantees move to Upstash Redis (same interface).
const buckets = new Map();

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Returns true if the request is allowed, false if it should be rejected.
export function allow(key, { limit, windowMs }) {
  const now = Date.now();
  const slot = buckets.get(key);
  if (!slot || now > slot.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (slot.count >= limit) return false;
  slot.count += 1;
  return true;
}

// Convenience: enforce on (req,res). Returns true if blocked (caller should stop).
export function blocked(req, res, name, opts) {
  if (buckets.size > 5000) buckets.clear(); // crude memory cap
  const ok = allow(`${name}:${clientIp(req)}`, opts);
  if (!ok) {
    res.status(429).json({ error: 'Příliš mnoho požadavků. Zkuste to prosím za chvíli.' });
    return true;
  }
  return false;
}
