import { z } from 'zod';
import { withTransaction, sql } from '../lib/db.js';
import { computeOrder } from '../lib/pricing.js';
import * as payment from '../lib/payment-provider.js';
import { blocked } from '../lib/rate-limit.js';

const ItemSchema = z.object({
  print_type: z.enum(['canvas']),
  orientation: z.enum(['sirka', 'vyska', 'ctverec']),
  width_cm: z.number().int().positive(),
  height_cm: z.number().int().positive(),
  retouch: z.boolean(),
  quantity: z.number().int().min(1).max(99),
  blobKey: z.string().regex(/^photos\/[\w.-]+$/),
  blobUrl: z.string().url(),
  photoName: z.string().max(200).optional().nullable(),
});

const BodySchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  items: z.array(ItemSchema).min(1).max(20),
  customer: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(160),
    phone: z.string().min(3).max(40),
  }),
  shipping: z.string().min(1).max(40),
  address: z
    .object({
      street: z.string().min(1).max(160),
      city: z.string().min(1).max(120),
      zip: z.string().min(1).max(20),
    })
    .nullable()
    .optional(),
  consent: z.literal(true),
});

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function buildRef(seq) {
  const year = new Date().getFullYear();
  return `FP-${year}-${String(seq).padStart(6, '0')}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (blocked(req, res, 'create-order', { limit: 8, windowMs: 60_000 })) return;

  let body;
  try {
    body = BodySchema.parse(await readJson(req));
  } catch (err) {
    res.status(400).json({ error: 'Neplatná data objednávky.', detail: err?.issues?.[0]?.message });
    return;
  }

  // Authoritative server-side recompute — client prices are ignored entirely.
  let totals;
  try {
    totals = computeOrder(body.items, body.shipping);
  } catch (err) {
    res.status(400).json({ error: 'Položku nebo dopravu se nepodařilo nacenit.', detail: err.message });
    return;
  }

  if (totals.grand_total <= 0) {
    res.status(400).json({ error: 'Neplatná cena objednávky.' });
    return;
  }

  const returnBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!returnBase) {
    res.status(500).json({ error: 'Server není správně nakonfigurován (PUBLIC_BASE_URL).' });
    return;
  }

  // Idempotency: same key returns the same order/redirect.
  try {
    const existing = await sql`
      SELECT public_ref, gateway_redirect
      FROM orders WHERE idempotency_key = ${body.idempotencyKey} LIMIT 1`;
    if (existing.length && existing[0].gateway_redirect) {
      res.status(200).json({ ref: existing[0].public_ref, redirect: existing[0].gateway_redirect });
      return;
    }
  } catch (err) {
    console.error('Idempotency lookup failed:', err);
  }

  // Create order + items atomically.
  let order;
  try {
    order = await withTransaction(async (client) => {
      const seqRes = await client.query(`SELECT nextval('order_ref_seq') AS n`);
      const ref = buildRef(seqRes.rows[0].n);

      const addr = body.address ? JSON.stringify(body.address) : null;
      const ins = await client.query(
        `INSERT INTO orders
          (public_ref, status, customer_name, customer_email, customer_phone,
           delivery_method, delivery_addr, currency, items_total, shipping_total,
           grand_total, pricing_version, gateway, idempotency_key, consent_terms)
         VALUES ($1,'created',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
         RETURNING id, public_ref, grand_total, currency`,
        [
          ref,
          body.customer.name,
          body.customer.email,
          body.customer.phone,
          body.shipping,
          addr,
          totals.currency,
          totals.items_total,
          totals.shipping_total,
          totals.grand_total,
          totals.pricing_version,
          payment.providerName,
          body.idempotencyKey,
        ],
      );
      const o = ins.rows[0];

      for (let i = 0; i < totals.lines.length; i++) {
        const l = totals.lines[i];
        const src = body.items[i];
        await client.query(
          `INSERT INTO order_items
            (order_id, print_type, orientation, width_cm, height_cm, retouch,
             quantity, unit_price, line_total, blob_key, blob_url, photo_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            o.id, l.print_type, l.orientation, l.width_cm, l.height_cm, l.retouch,
            l.quantity, l.unit_price, l.line_total, src.blobKey, src.blobUrl,
            src.photoName || null,
          ],
        );
      }

      await client.query(
        `INSERT INTO payment_events (order_id, source, gateway_status, raw)
         VALUES ($1,'create',NULL,$2)`,
        [o.id, JSON.stringify({ items_total: totals.items_total, grand_total: totals.grand_total })],
      );

      return o;
    });
  } catch (err) {
    // Unique violation on idempotency_key => concurrent duplicate; return that order.
    if (err && err.code === '23505') {
      try {
        const dup = await sql`
          SELECT public_ref, gateway_redirect
          FROM orders WHERE idempotency_key = ${body.idempotencyKey} LIMIT 1`;
        if (dup.length && dup[0].gateway_redirect) {
          res.status(200).json({ ref: dup[0].public_ref, redirect: dup[0].gateway_redirect });
          return;
        }
      } catch { /* fall through */ }
    }
    console.error('Order insert failed:', err);
    res.status(500).json({ error: 'Objednávku se nepodařilo uložit.' });
    return;
  }

  // Initiate payment at the gateway (network — outside the DB transaction).
  let pay;
  try {
    pay = await payment.createPayment({
      amountMinor: order.grand_total,
      currency: order.currency,
      label: `Obraz ${order.public_ref}`,
      refId: order.public_ref,
      email: body.customer.email,
      fullName: body.customer.name,
      returnBase,
    });
  } catch (err) {
    console.error('Payment init failed:', err);
    res.status(502).json({ error: 'Platební bránu se nepodařilo spustit. Zkuste to prosím znovu.' });
    return;
  }

  try {
    await sql`
      UPDATE orders
      SET status = 'payment_pending',
          gateway_trans_id = ${pay.transId},
          gateway_redirect = ${pay.redirect},
          updated_at = now()
      WHERE id = ${order.id}`;
    await sql`
      INSERT INTO payment_events (order_id, source, gateway_status, raw)
      VALUES (${order.id}, 'create', 'INITIATED', ${JSON.stringify({ transId: pay.transId })})`;
  } catch (err) {
    console.error('Order payment-link update failed:', err);
    // Payment was created at the gateway; still send the user there.
  }

  res.status(200).json({ ref: order.public_ref, redirect: pay.redirect });
}
