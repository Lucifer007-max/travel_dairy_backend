import { buildApp } from '../src/bootstrap.js';

// Vercel runs the API as a function. Build it once per instance, then hand
// every request to Express. If the settings are wrong, answer each request
// with what is wrong (setting names and rules, never values) instead of
// crashing with FUNCTION_INVOCATION_FAILED.
let app;
let startupError;
try {
  ({ app } = buildApp());
} catch (error) {
  startupError = error;
  console.error(error.message);
}

export default function handler(req, res) {
  if (app) return app(req, res);
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { code: 'server_misconfigured', message: startupError.message } }));
}
