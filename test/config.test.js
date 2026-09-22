import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { detectImageType } from '../src/storage/images.js';

const base = { DATABASE_URL: 'postgres://localhost/x', JWT_SECRET: 'x'.repeat(32) };

test('config fills sensible defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.PORT, 8080);
  assert.equal(c.STORAGE_DRIVER, 'local');
  assert.equal(c.DATABASE_SSL, false);
  assert.deepEqual(c.GOOGLE_CLIENT_IDS, []);
  assert.equal(c.PUBLIC_BASE_URL, 'http://localhost:8080');
});

test('config lists every problem at once', () => {
  assert.throws(() => loadConfig({ JWT_SECRET: 'short' }), (e) => {
    assert.match(e.message, /DATABASE_URL/);
    assert.match(e.message, /JWT_SECRET/);
    return true;
  });
});

test('Supabase storage needs its URL and key', () => {
  assert.throws(() => loadConfig({ ...base, STORAGE_DRIVER: 'supabase' }), /SUPABASE_URL/);
  const c = loadConfig({
    ...base,
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
    GOOGLE_CLIENT_IDS: 'a.apps.googleusercontent.com, b.apps.googleusercontent.com',
    DATABASE_SSL: 'true',
  });
  assert.equal(c.DATABASE_SSL, true);
  assert.deepEqual(c.GOOGLE_CLIENT_IDS, ['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com']);
});

test('a public Supabase key is refused with a clear explanation', () => {
  const withKey = (key) => () =>
    loadConfig({ ...base, STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: key });
  assert.throws(withKey('sb_publishable_abc123'), /public \(publishable\/anon\) key/);
  const jwt = (role) => ['e30', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'sig'].join('.');
  assert.throws(withKey(jwt('anon')), /public \(publishable\/anon\) key/);
  assert.doesNotThrow(withKey(jwt('service_role')));
  assert.doesNotThrow(withKey('sb_secret_abc123'));
});

test('local photo storage is refused on Vercel', () => {
  assert.throws(() => loadConfig({ ...base, VERCEL: '1' }), /must be "supabase" on Vercel/);
  assert.doesNotThrow(() => loadConfig({ ...base }));
});

test('image types are recognised from their bytes', () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe1, ...Array(20).fill(0)]))?.extension, 'jpg');
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))?.extension, 'webp');
  assert.equal(detectImageType(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1'))?.extension, 'heic');
  assert.equal(detectImageType(Buffer.from('GIF89a..........', 'latin1')), null);
  assert.equal(detectImageType(Buffer.from('tiny')), null);
});
