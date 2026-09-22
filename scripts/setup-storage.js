import { loadConfig } from '../src/config.js';
import { createSupabaseStorage } from '../src/storage/supabase.js';

// Creates the private photo bucket in Supabase Storage if it doesn't exist.
const config = loadConfig();
if (config.STORAGE_DRIVER !== 'supabase') {
  console.log('STORAGE_DRIVER is not "supabase"; nothing to set up.');
  process.exit(0);
}

const { client } = createSupabaseStorage(config);
const bucket = config.SUPABASE_BUCKET;
const { data } = await client.storage.getBucket(bucket);
if (data) {
  console.log(`Bucket "${bucket}" already exists (public: ${data.public}).`);
  if (data.public) console.warn('Warning: this bucket is public; photos should be private.');
} else {
  const { error } = await client.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: `${config.MAX_UPLOAD_MB}MB`,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  });
  if (error) {
    console.error(`Could not create bucket "${bucket}": ${error.message}`);
    process.exit(1);
  }
  console.log(`Created private bucket "${bucket}".`);
}
