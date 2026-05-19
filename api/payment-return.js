import { reconcileByRef } from '../lib/reconcile.js';

const HASH = {
  paid: '#dekujeme',
  payment_pending: '#platba-ceka',
  payment_failed: '#platba-neuspesna',
  cancelled: '#platba-neuspesna',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const ref = url.searchParams.get('ref');
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || '';

  if (!ref) {
    res.statusCode = 302;
    res.setHeader('Location', `${base}/`);
    res.end();
    return;
  }

  let status = 'payment_pending';
  try {
    const result = await reconcileByRef(ref, 'return');
    if (result) status = result.status;
  } catch (err) {
    console.error('payment-return reconcile error:', err);
  }

  const hash = HASH[status] || '#platba-ceka';
  res.statusCode = 302;
  res.setHeader('Location', `${base}/?order=${encodeURIComponent(ref)}${hash}`);
  res.end();
}
