import type { NextFunction, Request, Response } from 'express';
import type { ServeStaticOptions } from 'serve-static';

/**
 * Browser-facing response headers.
 *
 * The page renders model output (Markdown, Mermaid) and command output, so the
 * policy is the second line of defence if anything ever slipped past sanitising:
 * scripts only from this origin, no plugins, no framing, no form posts elsewhere.
 * Styles allow inline because Mermaid and the charts set style attributes.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=()');
  next();
}

/**
 * Vite puts a content hash in every file under /assets, so those can be cached for a
 * year and never revalidated. Everything else (index.html, the service worker, the
 * manifest, icons) must be checked each time, or a new release would not show up.
 */
export const staticOptions: ServeStaticOptions = {
  setHeaders(res, path) {
    const p = path.replace(/\\/g, '/');
    if (p.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
};

/**
 * Same origin always works. A browser on another origin is allowed only when it is
 * listed; requests without an Origin header (curl, webhooks, server-to-server) are
 * not a CORS matter and pass.
 */
export function corsOrigin(allowed: string[]) {
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void): void => {
    cb(null, !origin || allowed.includes(origin));
  };
}

/** SQLite's message for a duplicate key, turned into something a person can act on. */
export function constraintError(err: unknown): { status: number; error: string } | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const m = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(String((err as Error).message));
    const field = m?.[2] === 'slug' ? 'name' : (m?.[2] ?? 'value');
    return { status: 409, error: `That ${field} is already in use. Pick a different one.` };
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return { status: 409, error: 'Something this refers to no longer exists. Refresh and try again.' };
  }
  return null;
}
