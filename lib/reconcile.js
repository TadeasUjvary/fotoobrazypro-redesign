import { sql } from './db.js';
import * as payment from './payment-provider.js';
import { sendOrderEmails } from './email.js';

const TERMINAL = new Set(['paid', 'payment_failed', 'cancelled']);

async function logEvent(orderId, source, status, raw) {
  try {
    await sql`
      INSERT INTO payment_events (order_id, source, gateway_status, raw)
      VALUES (${orderId}, ${source}, ${status || null}, ${JSON.stringify(raw || {})})`;
  } catch (err) {
    console.error('payment_events insert failed:', err);
  }
}

// Claim the e-mail slot atomically so notifications go out exactly once.
async function maybeSendEmails(orderId) {
  const claimed = await sql`
    UPDATE orders SET emails_sent_at = now()
    WHERE id = ${orderId} AND status = 'paid' AND emails_sent_at IS NULL
    RETURNING id`;
  if (!claimed.length) return;
  const orderRows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
  const items = await sql`SELECT * FROM order_items WHERE order_id = ${orderId} ORDER BY id`;
  try {
    await sendOrderEmails(orderRows[0], items);
  } catch (err) {
    console.error('sendOrderEmails threw (ignored):', err);
  }
}

async function reconcileOrder(order, source) {
  if (TERMINAL.has(order.status)) {
    if (order.status === 'paid') await maybeSendEmails(order.id);
    return order.status;
  }
  if (!order.gateway_trans_id) return order.status;

  let st;
  try {
    st = await payment.getStatus(order.gateway_trans_id);
  } catch (err) {
    console.error('Provider status check failed:', err);
    return order.status;
  }

  await logEvent(order.id, source, st.status, st.raw);

  // Cross-check the gateway's view against our stored order.
  const refMismatch = st.refId && String(st.refId) !== String(order.public_ref);
  const amountMismatch =
    typeof st.amountMinor === 'number' && st.amountMinor !== order.grand_total;
  const currMismatch = st.currency && st.currency !== order.currency;

  const next = payment.toOrderStatus(st.status);

  if (next === 'paid') {
    if (refMismatch || amountMismatch || currMismatch) {
      console.error('Refusing to mark paid — gateway/order mismatch', {
        ref: order.public_ref, st,
      });
      return order.status;
    }
    await sql`
      UPDATE orders SET status = 'paid', updated_at = now()
      WHERE id = ${order.id} AND status <> 'paid'`;
    await maybeSendEmails(order.id);
    return 'paid';
  }

  if (next === 'payment_failed') {
    await sql`
      UPDATE orders SET status = 'payment_failed', updated_at = now()
      WHERE id = ${order.id} AND status NOT IN ('paid','payment_failed')`;
    return 'payment_failed';
  }

  return order.status; // PENDING — leave as payment_pending
}

export async function reconcileByRef(ref, source) {
  const rows = await sql`SELECT * FROM orders WHERE public_ref = ${ref} LIMIT 1`;
  if (!rows.length) return null;
  const status = await reconcileOrder(rows[0], source);
  return { order: rows[0], status };
}

export async function reconcileByTransId(transId, source) {
  const rows = await sql`SELECT * FROM orders WHERE gateway_trans_id = ${transId} LIMIT 1`;
  if (!rows.length) return null;
  const status = await reconcileOrder(rows[0], source);
  return { order: rows[0], status };
}
