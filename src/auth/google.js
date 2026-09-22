import { OAuth2Client } from 'google-auth-library';

import { HttpError } from '../errors.js';

/**
 * Checks a Google ID token from the app: Google's signature, expiry, and that
 * it was issued for one of our client IDs. Returns who signed in.
 */
export function createGoogleVerifier(config) {
  const client = new OAuth2Client();

  return async function verifyGoogleIdToken(idToken) {
    if (config.GOOGLE_CLIENT_IDS.length === 0) {
      throw new HttpError(503, 'google_not_configured', "Google sign-in isn't set up on the server yet.");
    }
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_IDS });
      payload = ticket.getPayload();
    } catch {
      throw new HttpError(401, 'invalid_google_token', "Google sign-in couldn't be verified. Please try again.");
    }
    if (!payload?.sub) {
      throw new HttpError(401, 'invalid_google_token', "Google sign-in couldn't be verified. Please try again.");
    }
    if (payload.email && payload.email_verified === false) {
      throw new HttpError(401, 'email_not_verified', 'That Google account has no verified email.');
    }
    return {
      sub: payload.sub,
      email: payload.email ?? null,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
  };
}
