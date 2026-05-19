// Swappable payment-provider façade. Add lib/gopay.js implementing the same
// three functions and extend the switch to support PAYMENT_PROVIDER=gopay.
import * as comgate from './comgate.js';

function pick() {
  const name = (process.env.PAYMENT_PROVIDER || 'comgate').toLowerCase();
  switch (name) {
    case 'comgate':
      return comgate;
    default:
      throw new Error(`Unsupported PAYMENT_PROVIDER: ${name}`);
  }
}

export const providerName = (process.env.PAYMENT_PROVIDER || 'comgate').toLowerCase();

export function createPayment(args) {
  return pick().createPayment(args);
}

export function getStatus(transId) {
  return pick().getStatus(transId);
}

export function pushLooksAuthentic(payload) {
  return pick().pushLooksAuthentic(payload);
}

// Normalize provider status -> internal order status.
export function toOrderStatus(providerStatus) {
  switch (providerStatus) {
    case 'PAID':
    case 'AUTHORIZED':
      return 'paid';
    case 'CANCELLED':
      return 'payment_failed';
    case 'PENDING':
    default:
      return 'payment_pending';
  }
}
