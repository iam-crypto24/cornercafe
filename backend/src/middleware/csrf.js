import { csrfForSession } from '../services/auth.js';
import { safeEqual } from '../utils/security.js';
import { AppError } from '../utils/errors.js';

export function requireTrustedOrigin(config) {
  return function trustedOrigin(req, _res, next) {
    const origin = req.get('origin');
    if (!origin || !config.allowedOrigins.has(origin)) {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin was not accepted.'));
    }
    next();
  };
}

export function requireCsrf(config) {
  return function csrfGuard(req, _res, next) {
    const supplied = req.get('x-csrf-token') || '';
    const expected = req.auth ? csrfForSession(req.auth, config) : '';
    if (!safeEqual(supplied, expected)) return next(new AppError(403, 'CSRF_REJECTED', 'Request verification failed. Refresh and try again.'));
    next();
  };
}
