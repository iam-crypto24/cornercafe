import { AppError } from '../utils/errors.js';
import { authenticate } from '../services/auth.js';

export function sessionCookieName(config) {
  return config.cookieSecure ? '__Host-corner_cafe_session' : 'corner_cafe_session';
}

export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

export function createRequireAuth(pool, config) {
  return async function requireAuth(req, _res, next) {
    try {
      const token = readCookie(req.headers.cookie, sessionCookieName(config));
      const session = await authenticate(pool, token);
      if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      req.auth = session;
      next();
    } catch (error) { next(error); }
  };
}

export function requireRole(role) {
  return function roleGuard(req, _res, next) {
    if (req.auth?.admin?.role !== role) return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'));
    next();
  };
}
