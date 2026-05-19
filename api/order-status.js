import { sql } from '../lib/db.js';
import { reconcileByRef } from '../lib/reconcile.js';
import { blocked } from '../lib/rate-limit.js';

const STALE_MS = 3 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (blocked(req, res, 'order-status', { limit: 40, windowMs: 60_000 })) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const ref = url.searchParams.get('ref');
  if (!ref || ref.length > 40) {
    res.status(400).json({ error: 'Chybí číslo objednávky.' });
    return;
  }

  let rows;
  try {
    rows = await sql`
      SELECT public_ref, status, grand_total, currency, updated_at
      FROM orders WHERE public_ref = ${ref} LIMIT 1`;
  } catch (err) {
    console.error('order-status query failed:', err);
    res.status(500).json({ error: 'Stav objednávky se nepodařilo načíst.' });
    return;
  }

  if (!rows.length) {
    res.status(404).json({ error: 'Objednávka nenalezena.' });
    return;
  }

  let order = rows[0];

  // Safety net: a pending order that missed its push gets re-checked lazily.
  const age = Date.now() - new Date(order.updated_at).getTime();
  if (order.status === 'payment_pending' && age > STALE_MS) {
    try {
      const result = await reconcileByRef(ref, 'reconcile');
      if (result) {
        const fresh = await sql`
          SELECT public_ref, status, grand_total, currency
          FROM orders WHERE public_ref = ${ref} LIMIT 1`;
        if (fresh.length) order = fresh[0];
      }
    } catch (err) {
      console.error('lazy reconcile failed:', err);
    }
  }

  res.status(200).json({
    ref: order.public_ref,
    status: order.status,
    grand_total: order.grand_total,
    currency: order.currency,
  });
}
