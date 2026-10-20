import { lazy } from 'react';
import type { ComponentType } from 'react';

const RELOADED = 'supops.chunkReload';

/**
 * A page loaded on first visit instead of in the main bundle.
 *
 * After a new release the old hashed files are gone, so a tab left open from
 * before fails to fetch the page it navigates to. Reloading once picks up the new
 * build; the flag stops a genuinely broken deploy from reloading forever.
 */
export function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(RELOADED);
        } catch {
          /* storage unavailable: nothing to clear */
        }
        return { default: m[name] };
      },
      (err: unknown) => {
        let again = false;
        try {
          again = !sessionStorage.getItem(RELOADED);
          if (again) sessionStorage.setItem(RELOADED, '1');
        } catch {
          /* storage unavailable: fall through to the error page */
        }
        if (again) window.location.reload();
        throw err;
      },
    ),
  );
}
