import { sha256 } from '../utils/security.js';
import { AppError } from '../utils/errors.js';

export function distributedRateLimit(pool, { scope, limit, key }) {
  return async function applyRateLimit(req, res, next) {
    try {
      const identity = String(key(req) || 'unknown').slice(0, 512);
      const bucketKey = sha256(`${scope}\0${identity}`);
      const result = await pool.query(
        `INSERT INTO rate_limit_buckets (bucket_key, scope, hit_count, expires_at)
         VALUES ($1, $2, 1, now() + ($3::double precision * interval '1 millisecond'))
         ON CONFLICT (bucket_key) DO UPDATE SET
           hit_count = CASE WHEN rate_limit_buckets.expires_at <= now() THEN 1 ELSE rate_limit_buckets.hit_count + 1 END,
           expires_at = CASE WHEN rate_limit_buckets.expires_at <= now()
             THEN now() + ($3::double precision * interval '1 millisecond') ELSE rate_limit_buckets.expires_at END
         RETURNING hit_count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::integer AS retry_after` ,
        [bucketKey, scope, req.app.locals.config.rateLimitWindowMs],
      );
      const { hit_count: hits, retry_after: retryAfter } = result.rows[0];
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(Math.max(0, limit - Number(hits))));
      if (Number(hits) > limit) {
        res.set('Retry-After', String(retryAfter));
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.');
      }
      next();
    } catch (error) { next(error); }
  };
}
