import { unauthorized } from '../errors.js';

/** The Bearer token on a request, or null. */
export function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  return match ? match[1].trim() : null;
}

/** Requires a valid session; puts the signed-in user row on req.user. */
export function requireUser({ tokens, pool }) {
  return async (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) return next(unauthorized());

    let userId;
    try {
      userId = tokens.verify(token);
    } catch {
      return next(unauthorized('Your session has expired. Please sign in again.'));
    }
    const { rows } = await pool.query('select * from users where id = $1', [userId]);
    if (!rows[0]) return next(unauthorized('This account no longer exists. Please sign in again.'));
    req.user = rows[0];
    next();
  };
}
