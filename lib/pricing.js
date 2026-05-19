import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, '..', 'pricing.json');

let cached = null;

export function getPricing() {
  if (!cached) {
    cached = JSON.parse(readFileSync(PRICING_PATH, 'utf8'));
  }
  return cached;
}

function sizeKey(width, height) {
  return `${width}x${height}`;
}

// item: { print_type, width_cm, height_cm, retouch (bool), quantity }
// Returns line totals in minor units (halíře). Throws on unknown product.
export function priceForItem(item) {
  const pricing = getPricing();
  const type = pricing.print_types?.[item.print_type];
  if (!type) {
    throw new Error(`Unknown print_type: ${item.print_type}`);
  }
  const key = sizeKey(item.width_cm, item.height_cm);
  const base = type.sizes?.[key];
  if (typeof base !== 'number') {
    throw new Error(`Unknown size for ${item.print_type}: ${key}`);
  }
  const retouchPrice = item.retouch ? (pricing.retouch?.price ?? 0) : 0;
  const unitPrice = base + retouchPrice;

  const quantity = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  const lineTotal = unitPrice * quantity;

  return { unitPrice, lineTotal, quantity, basePrice: base, retouchPrice };
}

// items: array of item objects, shippingKey: string
// Authoritative server-side recompute. All amounts in minor units (halíře).
export function computeOrder(items, shippingKey) {
  const pricing = getPricing();

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order has no items');
  }

  const lines = items.map((item) => {
    const { unitPrice, lineTotal, quantity, basePrice, retouchPrice } = priceForItem(item);
    return {
      print_type: item.print_type,
      orientation: item.orientation,
      width_cm: item.width_cm,
      height_cm: item.height_cm,
      retouch: !!item.retouch,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      base_price: basePrice,
      retouch_price: retouchPrice,
    };
  });

  const itemsTotal = lines.reduce((sum, l) => sum + l.line_total, 0);

  const shipping = pricing.shipping?.[shippingKey];
  if (!shipping) {
    throw new Error(`Unknown shipping method: ${shippingKey}`);
  }
  let shippingTotal = shipping.price;
  const threshold = pricing.free_shipping_threshold;
  if (typeof threshold === 'number' && itemsTotal >= threshold) {
    shippingTotal = 0;
  }

  return {
    currency: pricing.currency,
    pricing_version: pricing.version,
    lines,
    items_total: itemsTotal,
    shipping_total: shippingTotal,
    shipping_label: shipping.label,
    grand_total: itemsTotal + shippingTotal,
  };
}
