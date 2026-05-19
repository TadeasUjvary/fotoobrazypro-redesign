// Comgate payment gateway — REST API v2.0
// Docs: https://apidoc.comgate.cz/en/api/rest/
const BASE = 'https://payments.comgate.cz/v2.0';

function authHeader() {
  const merchant = process.env.COMGATE_MERCHANT;
  const secret = process.env.COMGATE_SECRET;
  if (!merchant || !secret) {
    throw new Error('COMGATE_MERCHANT / COMGATE_SECRET not configured');
  }
  return 'Basic ' + Buffer.from(`${merchant}:${secret}`).toString('base64');
}

function isTest() {
  return String(process.env.COMGATE_TEST).toLowerCase() === 'true';
}

// label must be 1–16 chars.
function clampLabel(s) {
  const t = (s || 'Fotoobraz').replace(/\s+/g, ' ').trim();
  return t.length > 16 ? t.slice(0, 16) : (t || 'Fotoobraz');
}

// Create a payment. amountMinor = price in halíře (integer).
// Returns { transId, redirect }.
export async function createPayment({
  amountMinor, currency, label, refId, email, fullName, returnBase,
}) {
  const body = {
    price: amountMinor,
    curr: currency,
    label: clampLabel(label),
    refId,
    method: 'ALL',
    email,
    fullName,
    country: 'CZ',
    lang: 'cs',
    test: isTest(),
    url_paid: `${returnBase}/api/payment-return?ref=${encodeURIComponent(refId)}&r=paid`,
    url_pending: `${returnBase}/api/payment-return?ref=${encodeURIComponent(refId)}&r=pending`,
    url_cancelled: `${returnBase}/api/payment-return?ref=${encodeURIComponent(refId)}&r=cancelled`,
  };

  const res = await fetch(`${BASE}/payment.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0 || !data.transId || !data.redirect) {
    throw new Error(`Comgate create failed: ${res.status} ${data.message || ''} (code ${data.code})`);
  }
  return { transId: data.transId, redirect: data.redirect, raw: data };
}

// Authoritative status check. Returns normalized { status, amountMinor, currency, refId, raw }.
// status is one of: PENDING | PAID | CANCELLED | AUTHORIZED
export async function getStatus(transId) {
  const res = await fetch(`${BASE}/payment/transId/${encodeURIComponent(transId)}.json`, {
    method: 'GET',
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0 || !data.status) {
    throw new Error(`Comgate status failed: ${res.status} ${data.message || ''} (code ${data.code})`);
  }
  return {
    status: data.status,
    amountMinor: data.price,
    currency: data.curr,
    refId: data.refId,
    raw: data,
  };
}

// Cheap authenticity gate for the push payload (still must re-query getStatus).
export function pushLooksAuthentic(payload) {
  const merchant = process.env.COMGATE_MERCHANT;
  const secret = process.env.COMGATE_SECRET;
  if (!payload) return false;
  if (payload.merchant != null && String(payload.merchant) !== String(merchant)) return false;
  if (payload.secret != null && String(payload.secret) !== String(secret)) return false;
  return true;
}
