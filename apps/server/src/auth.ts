import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';
import { verifyApiKey } from './apikeys.ts';

/**
 * scrypt rather than argon2: argon2 needs a native build, and this machine (like
 * plenty of deployment targets) has no compiler. scrypt is in Node's standard
 * library, is memory-hard, and is a perfectly respectable choice here.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  globalRole: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Set when the request came with an API key instead of a session. */
      apiKey?: { id: string; name: string; scopes: Array<'read' | 'investigate' | 'changes' | 'metrics' | 'mcp'> };
    }
  }
}

export const signToken = (user: AuthUser): string =>
  jwt.sign(user, config.jwtSecret, { expiresIn: '24h' });

/** The signed-in user a session token belongs to, or null if it is missing, forged or expired. */
export function verifySessionToken(token: unknown): AuthUser | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    return jwt.verify(token, config.jwtSecret) as AuthUser;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  // A machine's API key (sok_...): acts as a member, within its scopes (see apiKeyGate).
  if (token.startsWith('sok_')) {
    const k = verifyApiKey(token);
    if (!k) {
      res.status(401).json({ error: 'Unknown, revoked or expired API key' });
      return;
    }
    req.user = k.user;
    req.apiKey = k.key;
    next();
    return;
  }
  const user = verifySessionToken(token);
  if (!user) {
    res.status(401).json({ error: 'Session expired; sign in again' });
    return;
  }
  req.user = user;
  next();
}

/**
 * Whether an email may be used for a NEW account. Open by default; when
 * `AUTH_ALLOWED_EMAIL_DOMAIN` is set, the address must be on one of those domains.
 * Enforced only at account creation — never at login.
 */
export const emailDomainAllowed = (email: string): boolean => {
  if (config.authAllowedDomains.length === 0) return true;
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return config.authAllowedDomains.includes(domain);
};

/** The admin tier for account management. `owner` and `admin` are equivalent here. */
export const ADMIN_ROLES = ['owner', 'admin'];
export const isAdmin = (user: AuthUser | undefined): boolean =>
  !!user && ADMIN_ROLES.includes(user.globalRole);

/** Gate a route on one of the given global roles. Use after `requireAuth`. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.globalRole)) {
      res.status(403).json({ error: 'You do not have permission to do that.' });
      return;
    }
    next();
  };
}
