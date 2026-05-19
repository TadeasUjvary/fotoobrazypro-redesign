import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'photos';
// Signed-URL lifetime for the studio download link (~1 year).
const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

let _client = null;
function client() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    }
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

let _bucketReady = false;
async function ensureBucket() {
  if (_bucketReady) return;
  const c = client();
  // Idempotent: ignore "already exists". Private bucket, generous size cap.
  const { error } = await c.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 52428800, // 50 MB
  });
  if (error && !/exist/i.test(error.message || '')) {
    // Non-fatal if it already exists; otherwise surface.
    console.warn('createBucket warning:', error.message);
  }
  _bucketReady = true;
}

// Stores the ORIGINAL bytes as-is — no compression, resize or transform —
// so the studio gets the photo in full quality for printing.
// Returns { key, url } where key is the storage path and url is a long-lived
// signed download link (used in the studio notification email).
export async function uploadPhoto(buffer, ext, contentType) {
  await ensureBucket();
  const c = client();
  const key = `photos/${randomUUID()}.${ext}`;

  const { error: upErr } = await c.storage.from(BUCKET).upload(key, buffer, {
    contentType,
    upsert: false,
    cacheControl: '3600',
  });
  if (upErr) {
    throw new Error(`Supabase upload failed: ${upErr.message}`);
  }

  const { data, error: signErr } = await c.storage
    .from(BUCKET)
    .createSignedUrl(key, SIGNED_URL_TTL);
  if (signErr || !data?.signedUrl) {
    throw new Error(`Supabase signed URL failed: ${signErr?.message || 'unknown'}`);
  }

  return { key, url: data.signedUrl };
}
