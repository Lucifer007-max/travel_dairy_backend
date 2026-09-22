import jwt from 'jsonwebtoken';

const ISSUER = 'traveldiary';

/** The app's own session tokens: a signed user id with an expiry. */
export function createTokens(config) {
  return {
    issue(userId) {
      return jwt.sign({}, config.JWT_SECRET, {
        algorithm: 'HS256',
        subject: userId,
        issuer: ISSUER,
        expiresIn: config.JWT_TTL,
      });
    },

    /** The user id in [token]; throws if it's forged or expired. */
    verify(token) {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
      if (typeof payload.sub !== 'string') throw new Error('Token has no subject');
      return payload.sub;
    },
  };
}
