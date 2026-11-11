import express from 'express';
import helmet from 'helmet';
import { AppError } from './utils/errors.js';
import { makeBookingFormToken, sha256, verifyBookingFormToken } from './utils/security.js';
import { sessionCookieName, createRequireAuth, requireRole } from './middleware/auth.js';
import { requireCsrf } from './middleware/csrf.js';
import { distributedRateLimit } from './middleware/rate-limit.js';
import { requestLogging } from './middleware/request-logging.js';
import { login, logout, listAdmins, createStaff, setAdminActive, csrfForSession } from './services/auth.js';
import { getAvailability, createReservation, reservationRequestHash, findPublicReservation, listReservations, updateReservationStatus, getAdminTables } from './repositories/reservations.js';
import { normalizeReservation } from './validators/reservations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function send(res, status, payload) { return res.status(status).json(payload); }
function cookieOptions(config, maxAge) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: '/', maxAge };
}
function clearSessionCookie(res, config) {
  res.clearCookie(sessionCookieName(config), cookieOptions(config, 0));
}
function trustedOrigins(config) {
  return function originGuard(req, _res, next) {
    const origin = req.get('Origin');
    if (typeof origin !== 'string' || !config.allowedOrigins.has(origin)) {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin was not accepted.'));
    }
    next();
  };
}
function cors(config) {
  return function corsPolicy(req, res, next) {
    const origin = req.get('Origin');
    if (origin && !config.allowedOrigins.has(origin)) return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin was not accepted.'));
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!origin || !config.allowedOrigins.has(origin)) return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin was not accepted.'));
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}
function publicLookupError() { return new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation reference was not found.'); }
function makeCookieAuth(config, pool) {
  return createRequireAuth(pool, config);
}
function parseInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function createApp({ pool, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.locals.config = config;
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(requestLogging);
  app.use(cors(config));
  app.use(express.json({ limit: '32kb', strict: true, type: 'application/json' }));

  const requireAuth = makeCookieAuth(config, pool);
  const originGuard = trustedOrigins(config);
  const requireCsrfToken = requireCsrf(config);
  const loginIpLimit = distributedRateLimit(pool, { scope: 'login-ip', limit: config.loginIpRateLimitMax, key: clientIp });
  const publicReadLimit = distributedRateLimit(pool, { scope: 'public-read-ip', limit: config.rateLimitMaxRequests, key: clientIp });
  const loginIdentityLimit = distributedRateLimit(pool, { scope: 'login-identity', limit: config.loginRateLimitMax, key: (req) => String(req.body?.email || '').trim().toLowerCase() || 'invalid' });
  const bookingIpLimit = distributedRateLimit(pool, { scope: 'booking-ip', limit: config.bookingRateLimitMax, key: clientIp });
  const bookingContactLimit = distributedRateLimit(pool, {
    scope: 'booking-contact', limit: config.bookingContactRateLimitMax,
    key: (req) => String(req.body?.customerEmail || req.body?.customerPhone || 'missing').trim().toLowerCase(),
  });
  const lookupLimit = distributedRateLimit(pool, { scope: 'reservation-lookup', limit: config.lookupRateLimitMax, key: clientIp });

  app.get('/api/health', asyncRoute(async (_req, res) => {
    try { await pool.query('SELECT 1'); return send(res, 200, { ok: true, service: 'corner-cafe-api', storage: 'postgresql' }); }
    catch { return send(res, 503, { ok: false, service: 'corner-cafe-api' }); }
  }));

  app.get('/api/availability', publicReadLimit, asyncRoute(async (req, res) => {
    const partySize = parseInteger(req.query.partySize, 2, 1, 8);
    if (!partySize || typeof req.query.date !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid date and party size.');
    if (req.query.tableId !== undefined && (typeof req.query.tableId !== 'string' || !/^T(?:[1-9]|1[0-9]|2[0-7])$/.test(req.query.tableId))) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a valid table.');
    const data = await getAvailability(pool, { date: req.query.date, partySize, tableId: req.query.tableId });
    return send(res, 200, { ...data, formToken: makeBookingFormToken(config.sessionSecret) });
  }));

  const createBooking = asyncRoute(async (req, res) => {
    const fields = normalizeReservation(req.body, new Date(), config.timezone);
    if (fields.website || !verifyBookingFormToken(fields.formToken, config.sessionSecret, Date.now(), config.formMinAgeMs)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Reservation details could not be verified. Please review and try again.');
    }
    if (config.captchaSecretKey) {
      if (!fields.captchaToken) throw new AppError(400, 'CAPTCHA_REQUIRED', 'Please complete the verification and try again.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        const form = new URLSearchParams({ secret: config.captchaSecretKey, response: fields.captchaToken, remoteip: clientIp(req) });
        const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: controller.signal });
        const result = await verification.json();
        if (!verification.ok || result.success !== true) throw new AppError(400, 'CAPTCHA_FAILED', 'Please complete the verification and try again.');
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Reservation verification is temporarily unavailable. Please try again.');
      } finally { clearTimeout(timer); }
    }
    const key = req.get('Idempotency-Key');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Please submit the reservation again.');
    const booking = await createReservation(pool, fields, {
      idempotencyKey: key, requestHash: reservationRequestHash(fields), timezone: config.timezone,
      duplicateWindowMs: config.duplicateWindowMs,
    });
    return send(res, 201, { booking });
  });
  app.post('/api/reservations', originGuard, bookingIpLimit, bookingContactLimit, createBooking);

  const publicLookup = asyncRoute(async (req, res) => {
    const reference = typeof req.query.reference === 'string' ? req.query.reference.trim().toUpperCase() : '';
    const booking = await findPublicReservation(pool, reference);
    if (!booking) throw publicLookupError();
    return send(res, 200, booking);
  });
  app.get('/api/reservation-status', lookupLimit, publicLookup);
  app.get('/api/reservations/:reference', lookupLimit, asyncRoute(async (req, res) => {
    const booking = await findPublicReservation(pool, req.params.reference.toUpperCase());
    if (!booking) throw publicLookupError();
    return send(res, 200, booking);
  }));

  app.post('/api/admin/auth', originGuard, loginIpLimit, loginIdentityLimit, asyncRoute(async (req, res) => {
    const result = await login(pool, req.body, sha256(clientIp(req)), config);
    const maxAge = Math.max(0, new Date(result.expiresAt).getTime() - Date.now());
    res.cookie(sessionCookieName(config), result.token, cookieOptions(config, maxAge));
    return send(res, 200, { admin: result.admin, csrfToken: result.csrfToken, expiresAt: result.expiresAt });
  }));
  app.get('/api/admin/auth', (req, res, next) => {
    if (req.query.action !== 'session') return next(new AppError(404, 'NOT_FOUND', 'Authentication action was not found.'));
    return requireAuth(req, res, async (error) => {
      if (error) return next(error);
      return send(res, 200, { admin: req.auth.admin, csrfToken: csrfForSession(req.auth, config), expiresAt: req.auth.expiresAt });
    });
  });
  app.post('/api/admin/auth/logout', originGuard, requireAuth, requireCsrfToken, asyncRoute(async (req, res) => {
    await logout(pool, req.auth.tokenHash);
    clearSessionCookie(res, config);
    return send(res, 200, { ok: true });
  }));
  app.post('/api/admin/auth/password', originGuard, requireAuth, requireCsrfToken, asyncRoute(async (req, res) => {
    const { changePassword } = await import('./services/auth.js');
    await changePassword(pool, req.auth, req.body);
    clearSessionCookie(res, config);
    return send(res, 200, { ok: true, signedOut: true });
  }));

  app.get('/api/admin/reservations', requireAuth, asyncRoute(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    return send(res, 200, { ...(await listReservations(pool, { date, search, status })) , admin: { id: req.auth.admin.id, email: req.auth.admin.email, role: req.auth.admin.role } });
  }));
  const changeReservation = asyncRoute(async (req, res) => {
    const id = req.params.id || req.query.id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation was not found.');
    const booking = await updateReservationStatus(pool, id, req.body?.status, req.auth.admin.id);
    return send(res, 200, { booking });
  });
  app.patch('/api/admin/reservation', originGuard, requireAuth, requireCsrfToken, changeReservation);
  app.patch('/api/admin/reservations/:id', originGuard, requireAuth, requireCsrfToken, changeReservation);
  app.get('/api/admin/tables', requireAuth, asyncRoute(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format();
    const timeSlot = typeof req.query.timeSlot === 'string' ? req.query.timeSlot : '';
    return send(res, 200, await getAdminTables(pool, date, timeSlot));
  }));

  const ownerOnly = requireRole('owner');
  app.get('/api/admin/users', requireAuth, ownerOnly, asyncRoute(async (_req, res) => send(res, 200, { admins: await listAdmins(pool) })));
  app.post('/api/admin/users', originGuard, requireAuth, ownerOnly, requireCsrfToken, asyncRoute(async (req, res) => send(res, 201, { admin: await createStaff(pool, req.body) })));
  const updateAdmin = asyncRoute(async (req, res) => {
    const id = req.params.id || req.query.id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new AppError(404, 'ADMIN_NOT_FOUND', 'Account was not found.');
    const admin = await setAdminActive(pool, id, req.body?.isActive, req.auth.admin);
    return send(res, 200, { admin });
  });
  app.patch('/api/admin/user', originGuard, requireAuth, ownerOnly, requireCsrfToken, updateAdmin);
  app.patch('/api/admin/users/:id', originGuard, requireAuth, ownerOnly, requireCsrfToken, updateAdmin);

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'API route was not found.')));
  app.use((error, req, res, _next) => {
    if (res.headersSent) return;
    let status = Number.isInteger(error?.status) ? error.status : 500;
    let code = typeof error?.code === 'string' && status < 500 ? error.code : 'INTERNAL_ERROR';
    let message = status < 500 ? error.message : 'The request could not be completed. Please try again.';
    if (error?.type === 'entity.too.large') { status = 413; code = 'REQUEST_TOO_LARGE'; message = 'Request body is too large.'; }
    else if (error?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Request body must be valid JSON.'; }
    else if (status >= 500) console.error(JSON.stringify({ event: 'request_error', requestId: req.requestId, code: error?.code || 'INTERNAL_ERROR' }));
    return res.status(status).json({ error: { code, message, requestId: req.requestId } });
  });
  return app;
}
