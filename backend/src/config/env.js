function booleanValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('COOKIE_SECURE must be true or false.');
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function normalizedOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute origin URL.`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} must contain only an HTTP(S) origin, without a path or credentials.`);
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV is invalid.');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  let database;
  try { database = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const frontendOrigin = normalizedOrigin(env.FRONTEND_ORIGIN || '', 'FRONTEND_ORIGIN');
  const allowedOrigins = new Set((env.ALLOWED_ORIGINS || frontendOrigin).split(',').map((item) => normalizedOrigin(item.trim(), 'ALLOWED_ORIGINS')));
  if (!allowedOrigins.has(frontendOrigin)) throw new Error('FRONTEND_ORIGIN must appear in ALLOWED_ORIGINS.');
  if (nodeEnv === 'production' && [...allowedOrigins].some((origin) => !origin.startsWith('https://'))) {
    throw new Error('Production allowed origins must use HTTPS.');
  }

  const timezone = env.CAFE_TIME_ZONE;
  if (!timezone) throw new Error('CAFE_TIME_ZONE is required.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error('CAFE_TIME_ZONE must be a supported IANA time zone.'); }

  const cookieSecure = booleanValue(env.COOKIE_SECURE, nodeEnv === 'production');
  const cookieSameSite = (env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(cookieSameSite)) throw new Error('COOKIE_SAME_SITE must be lax, strict, or none.');
  if (cookieSameSite === 'none' && !cookieSecure) throw new Error('SameSite=None cookies require COOKIE_SECURE=true.');
  if (nodeEnv === 'production' && !cookieSecure) throw new Error('COOKIE_SECURE must be true in production.');

  const port = positiveInteger(env.PORT, 8787, 'PORT');
  const config = {
    nodeEnv,
    databaseUrl,
    sessionSecret,
    frontendOrigin,
    allowedOrigins,
    timezone,
    port,
    cookieSecure,
    cookieSameSite,
    trustProxyHops: nonNegativeInteger(env.TRUST_PROXY_HOPS, nodeEnv === 'production' ? 1 : 0, 'TRUST_PROXY_HOPS'),
    requestTimeoutMs: positiveInteger(env.REQUEST_TIMEOUT_MS, 30_000, 'REQUEST_TIMEOUT_MS'),
    rateLimitWindowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS, 15 * 60_000, 'RATE_LIMIT_WINDOW_MS'),
    rateLimitMaxRequests: positiveInteger(env.RATE_LIMIT_MAX_REQUESTS, 120, 'RATE_LIMIT_MAX_REQUESTS'),
    loginRateLimitMax: positiveInteger(env.LOGIN_RATE_LIMIT_MAX, 8, 'LOGIN_RATE_LIMIT_MAX'),
    loginIpRateLimitMax: positiveInteger(env.LOGIN_IP_RATE_LIMIT_MAX, 30, 'LOGIN_IP_RATE_LIMIT_MAX'),
    bookingRateLimitMax: positiveInteger(env.BOOKING_RATE_LIMIT_MAX, 8, 'BOOKING_RATE_LIMIT_MAX'),
    bookingContactRateLimitMax: positiveInteger(env.BOOKING_CONTACT_RATE_LIMIT_MAX, 4, 'BOOKING_CONTACT_RATE_LIMIT_MAX'),
    lookupRateLimitMax: positiveInteger(env.LOOKUP_RATE_LIMIT_MAX, 20, 'LOOKUP_RATE_LIMIT_MAX'),
    duplicateWindowMs: positiveInteger(env.DUPLICATE_WINDOW_MS, 10 * 60_000, 'DUPLICATE_WINDOW_MS'),
    formMinAgeMs: positiveInteger(env.BOT_FORM_MIN_AGE_MS, 1_500, 'BOT_FORM_MIN_AGE_MS'),
    captchaSecretKey: env.CAPTCHA_SECRET_KEY || '',
    poolMax: positiveInteger(env.PG_POOL_MAX, 10, 'PG_POOL_MAX'),
  };
  return Object.freeze(config);
}

export function databaseUrlFromEnv(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  return env.DATABASE_URL;
}
