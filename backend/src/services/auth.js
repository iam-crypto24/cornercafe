import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { sha256, randomToken, csrfTokenFor } from '../utils/security.js';
import { DUMMY_PASSWORD_HASH, makePassword, verifyPassword } from '../utils/password.js';
import { withTransaction } from '../utils/database.js';
import { hasControlCharacters } from '../utils/validation.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeAdmin(admin) {
  return { id: admin.id, name: admin.name, email: admin.email, role: admin.role, isActive: admin.is_active, createdAt: admin.created_at };
}

export async function authenticate(pool, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const result = await pool.query(
    `SELECT s.token_hash, s.expires_at, a.id, a.name, a.email, a.role, a.is_active
     FROM sessions s JOIN admin_users a ON a.id = s.admin_user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.is_active = true`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    admin: { id: row.id, name: row.name, email: row.email, role: row.role },
  };
}

export function csrfForSession(session, config) {
  return csrfTokenFor(session.tokenHash, config.sessionSecret);
}

export async function login(pool, body, ipHash, config) {
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === 'string' ? body.password : '';
  const identityHash = sha256(email || 'invalid-email');
  if (!validEmail(email) || password.length < 1 || password.length > 128) {
    await recordLogin(pool, ipHash, identityHash, false);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password was not recognised.');
  }

  const result = await pool.query(
    'SELECT id, name, email, role, password_hash, is_active, created_at FROM admin_users WHERE email = $1',
    [email],
  );
  const candidate = result.rows[0];
  const passwordOk = await verifyPassword(password, candidate?.password_hash || await DUMMY_PASSWORD_HASH);
  if (!candidate || !candidate.is_active || !passwordOk) {
    await recordLogin(pool, ipHash, identityHash, false);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password was not recognised.');
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const tokenHash = sha256(token);
  await withTransaction(pool, async (client) => {
    if (candidate.password_hash.startsWith('scrypt$16384$')) {
      const upgradedHash = await makePassword(password);
      await client.query('UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1', [candidate.id, upgradedHash]);
    }
    await client.query('DELETE FROM sessions WHERE admin_user_id = $1 OR expires_at <= now()', [candidate.id]);
    await client.query(
      'INSERT INTO sessions (token_hash, admin_user_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash, candidate.id, expiresAt],
    );
  });
  await recordLogin(pool, ipHash, identityHash, true);
  const session = { tokenHash, expiresAt };
  return { token, admin: safeAdmin(candidate), csrfToken: csrfForSession(session, config), expiresAt };
}

async function recordLogin(pool, ipHash, identityHash, succeeded) {
  await pool.query(
    'INSERT INTO login_attempts (ip_hash, identity_hash, succeeded) VALUES ($1, $2, $3)',
    [ipHash, identityHash, succeeded],
  );
}

export async function logout(pool, tokenHash) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function listAdmins(pool) {
  const result = await pool.query(
    'SELECT id, name, email, role, is_active, created_at FROM admin_users ORDER BY created_at, email',
  );
  return result.rows.map((admin) => ({ ...safeAdmin(admin), isActive: admin.is_active }));
}

export async function createStaff(pool, body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 100 || hasControlCharacters(name)
    || !validEmail(email) || password.length < 12 || password.length > 128) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid name, email, and password of at least 12 characters.');
  }
  const passwordHash = await makePassword(password);
  try {
    const result = await pool.query(
      `INSERT INTO admin_users (id, name, email, role, password_hash)
       VALUES ($1, $2, $3, 'staff', $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [randomUUID(), name, email, passwordHash],
    );
    return safeAdmin(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
    throw error;
  }
}

export async function setAdminActive(pool, targetId, isActive, currentAdmin) {
  if (typeof isActive !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', 'Provide an active or inactive account status.');
  if (targetId === currentAdmin.id && !isActive) throw new AppError(400, 'VALIDATION_ERROR', 'You cannot deactivate your own account.');
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE admin_users SET is_active = $2, updated_at = now()
       WHERE id = $1 RETURNING id, name, email, role, is_active, created_at`,
      [targetId, isActive],
    );
    const admin = result.rows[0];
    if (!admin) throw new AppError(404, 'ADMIN_NOT_FOUND', 'Account was not found.');
    if (!isActive) await client.query('DELETE FROM sessions WHERE admin_user_id = $1', [targetId]);
    return { ...safeAdmin(admin), isActive: admin.is_active };
  });
}

export async function changePassword(pool, session, body) {
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  const result = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1 AND is_active = true', [session.admin.id]);
  const oldHash = result.rows[0]?.password_hash;
  if (!oldHash || !await verifyPassword(currentPassword, oldHash)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password was not recognised.');
  }
  if (newPassword.length < 12 || newPassword.length > 128) throw new AppError(400, 'VALIDATION_ERROR', 'Use a new password from 12 to 128 characters.');
  const passwordHash = await makePassword(newPassword);
  await withTransaction(pool, async (client) => {
    const update = await client.query(
      'UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1 AND is_active = true',
      [session.admin.id, passwordHash],
    );
    if (!update.rowCount) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    await client.query('DELETE FROM sessions WHERE admin_user_id = $1', [session.admin.id]);
  });
}
