import { Resend } from 'resend';

function fmt(minor) {
  return Math.round((minor || 0) / 100).toLocaleString('cs-CZ') + ' Kč';
}

function itemsTable(items, { withPhoto }) {
  return items
    .map((it) => {
      const desc = `Fotoobraz na plátně — ${it.width_cm} × ${it.height_cm} cm${it.retouch ? ' · retuš' : ''}`;
      const photo = withPhoto && it.blob_url
        ? `<div><a href="${it.blob_url}">Stáhnout fotografii${it.photo_name ? ` (${it.photo_name})` : ''}</a></div>`
        : (it.photo_name ? `<div style="color:#5A4F47">${it.photo_name}</div>` : '');
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee">${desc}<br>${photo}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${it.quantity}×</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${fmt(it.line_total)}</td>
      </tr>`;
    })
    .join('');
}

function totalsBlock(order) {
  return `<table style="width:100%;margin-top:12px">
    <tr><td>Mezisoučet</td><td style="text-align:right">${fmt(order.items_total)}</td></tr>
    <tr><td>Doprava</td><td style="text-align:right">${order.shipping_total ? fmt(order.shipping_total) : 'zdarma'}</td></tr>
    <tr><td style="font-weight:700;padding-top:6px">Celkem</td><td style="text-align:right;font-weight:700;padding-top:6px">${fmt(order.grand_total)}</td></tr>
  </table>`;
}

function deliveryLine(order) {
  if (!order.delivery_addr) return `Doprava: ${order.delivery_method} (osobní odběr)`;
  const a = order.delivery_addr;
  return `Doručení (${order.delivery_method}): ${a.street}, ${a.zip} ${a.city}`;
}

// Sends customer confirmation + studio notification. Never throws — email
// failure must not roll back a paid order.
export async function sendOrderEmails(order, items) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const studio = process.env.STUDIO_NOTIFY_EMAIL || 'das1979@seznam.cz';

  if (!apiKey || !from) {
    console.warn('Email skipped: RESEND_API_KEY / EMAIL_FROM not configured');
    return { sent: false, reason: 'not_configured' };
  }

  const resend = new Resend(apiKey);
  const results = {};

  try {
    const r = await resend.emails.send({
      from,
      to: order.customer_email,
      subject: `Potvrzení objednávky ${order.public_ref} — FotoobrazyPRO`,
      html: `<div style="font-family:Arial,sans-serif;color:#171311;max-width:560px">
        <h2 style="font-family:Georgia,serif">Děkujeme za objednávku!</h2>
        <p>Dobrý den ${order.customer_name},<br>vaši objednávku <strong>${order.public_ref}</strong> jsme přijali a platba proběhla úspěšně.</p>
        <table style="width:100%;border-collapse:collapse">${itemsTable(items, { withPhoto: false })}</table>
        ${totalsBlock(order)}
        <p style="margin-top:14px">${deliveryLine(order)}</p>
        <p style="color:#5A4F47;font-size:14px">FotoobrazyPRO — Stefan Paralič, Tišnov · tel. +420 776 654 099</p>
      </div>`,
    });
    results.customer = r?.data?.id || 'sent';
  } catch (err) {
    console.error('Customer email failed:', err);
    results.customer = 'error';
  }

  try {
    const r = await resend.emails.send({
      from,
      to: studio,
      replyTo: order.customer_email,
      subject: `NOVÁ OBJEDNÁVKA ${order.public_ref} — ${fmt(order.grand_total)}`,
      html: `<div style="font-family:Arial,sans-serif;color:#171311;max-width:560px">
        <h2>Nová zaplacená objednávka ${order.public_ref}</h2>
        <p><strong>Zákazník:</strong> ${order.customer_name}<br>
           <strong>E-mail:</strong> ${order.customer_email}<br>
           <strong>Telefon:</strong> ${order.customer_phone}</p>
        <p>${deliveryLine(order)}</p>
        <table style="width:100%;border-collapse:collapse">${itemsTable(items, { withPhoto: true })}</table>
        ${totalsBlock(order)}
        <p style="color:#5A4F47;font-size:13px">Fotografie ke stažení jsou odkazované u jednotlivých položek výše.</p>
      </div>`,
    });
    results.studio = r?.data?.id || 'sent';
  } catch (err) {
    console.error('Studio email failed:', err);
    results.studio = 'error';
  }

  return { sent: true, results };
}
