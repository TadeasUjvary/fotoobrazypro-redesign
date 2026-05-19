import Busboy from 'busboy';
import { MAX_UPLOAD_BYTES, sniffImageType, extensionForType } from '../lib/validation.js';
import { uploadPhoto } from '../lib/storage.js';
import { blocked } from '../lib/rate-limit.js';

export const config = { api: { bodyParser: false } };

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES + 1 },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    let fileName = null;
    let truncated = false;
    let gotFile = false;

    bb.on('file', (_name, stream, info) => {
      gotFile = true;
      fileName = info.filename || 'photo';
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => {
        truncated = true;
        stream.resume();
      });
    });

    bb.on('error', reject);
    bb.on('close', () => {
      if (!gotFile) {
        resolve({ error: 'NO_FILE' });
        return;
      }
      if (truncated) {
        resolve({ error: 'TOO_LARGE' });
        return;
      }
      resolve({ buffer: Buffer.concat(chunks), fileName });
    });

    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (blocked(req, res, 'upload', { limit: 10, windowMs: 60_000 })) return;

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch {
    res.status(400).json({ error: 'Neplatný formát požadavku.' });
    return;
  }

  if (parsed.error === 'NO_FILE') {
    res.status(400).json({ error: 'Nebyl odeslán žádný soubor.' });
    return;
  }
  if (parsed.error === 'TOO_LARGE') {
    res.status(413).json({ error: 'Fotografie je příliš velká (max. 30 MB).' });
    return;
  }

  const { buffer, fileName } = parsed;

  if (buffer.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'Fotografie je příliš velká (max. 30 MB).' });
    return;
  }

  const type = sniffImageType(buffer);
  if (!type) {
    res.status(415).json({ error: 'Nahrajte prosím obrázek ve formátu JPG, PNG nebo WEBP.' });
    return;
  }

  const ext = extensionForType(type);

  try {
    const { key, url } = await uploadPhoto(buffer, ext, `image/${type}`);
    res.status(200).json({
      blobKey: key,
      blobUrl: url,
      photoName: fileName,
    });
  } catch (err) {
    console.error('Storage upload failed:', err);
    res.status(502).json({ error: 'Fotografii se nepodařilo uložit, zkuste to prosím znovu.' });
  }
}
