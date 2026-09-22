import { createLocalStorage } from './local.js';
import { createSupabaseStorage } from './supabase.js';

/**
 * Where photo files live. Every driver offers:
 *   put(key, buffer, contentType), remove(keys), signedUrls(keys) -> Map<key, url>
 */
export function createStorage(config) {
  return config.STORAGE_DRIVER === 'supabase' ? createSupabaseStorage(config) : createLocalStorage(config);
}
