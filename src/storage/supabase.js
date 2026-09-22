import { createClient } from '@supabase/supabase-js';

/** Photos in a private Supabase Storage bucket, handed out as short-lived signed links. */
export function createSupabaseStorage(config) {
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(config.SUPABASE_BUCKET);
  /// Which bucket in which project, so "Bucket not found" is easy to place.
  const where = `bucket "${config.SUPABASE_BUCKET}" in ${new URL(config.SUPABASE_URL).hostname}`;

  return {
    driver: 'supabase',
    client,

    async put(key, buffer, contentType) {
      const { error } = await bucket().upload(key, buffer, { contentType, upsert: false });
      if (error) throw new Error(`Supabase upload to ${where} failed for ${key}: ${error.message}`);
    },

    async remove(keys) {
      if (keys.length === 0) return;
      const { error } = await bucket().remove(keys);
      if (error) throw new Error(`Supabase delete from ${where} failed: ${error.message}`);
    },

    async signedUrls(keys) {
      if (keys.length === 0) return new Map();
      const { data, error } = await bucket().createSignedUrls(keys, config.SIGNED_URL_TTL_SECONDS);
      if (error) throw new Error(`Supabase signed URLs from ${where} failed: ${error.message}`);
      return new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
    },
  };
}
