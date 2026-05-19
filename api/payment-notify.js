import * as payment from '../lib/payment-provider.js';
import { reconcileByTransId, reconcileByRef } from '../lib/reconcile.js';

export const config = { api: { bodyParser: false } };

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!raw) return {};
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch {
    // Malformed — ack so Comgate stops retrying; nothing we can do with it.
    res.status(200).send('OK');
    return;
  }

  if (!payment.pushLooksAuthentic(payload)) {
    console.warn('Push failed authenticity gate', { refId: payload.refId });
    res.status(200).send('OK');
    return;
  }

  const transId = payload.transId || payload.transID || payload.id;
  const refId = payload.refId || payload.refid;

  try {
    let result = null;
    if (transId) result = await reconcileByTransId(transId, 'notify');
    if (!result && refId) result = await reconcileByRef(refId, 'notify');

    if (!result) {
      console.warn('Push for unknown order', { transId, refId });
      // Ack anyway; an unknown order will never become known by retrying.
      res.status(200).send('OK');
      return;
    }
    res.status(200).send('OK');
  } catch (err) {
    // Unexpected/transient — let Comgate retry later.
    console.error('payment-notify error:', err);
    res.status(500).send('ERROR');
  }
}
