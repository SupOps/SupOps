import { createHash } from 'node:crypto';
import { logTemplate } from './logs.ts';

/**
 * Error grouping (what Sentry and Datadog Error Tracking do, from what SupOps can read):
 * an error is its exception type, the top frame of its own code, and its message with the
 * variable parts masked. Errors with the same three are one group, however many times
 * they happen, so a new kind of error stands out from the old familiar ones.
 */

export interface ParsedError {
  type: string;
  message: string;
  /** The top stack frame, file and function, without line numbers (they move with every edit). */
  frame: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Frames from libraries are not where the bug is: prefer the first frame outside them. */
const LIBRARY = /(node_modules|site-packages|dist-packages|\/usr\/lib|java\.base|jdk\.internal|^java\.|^javax\.|^sun\.|^org\.springframework|^io\.netty|^kotlin\.|runtime\/|^internal\/|<anonymous>|\(native\))/;

function pickFrame(frames: string[]): string | null {
  const own = frames.find((f) => !LIBRARY.test(f)) ?? frames[0];
  return own ? clip(own, 200) : null;
}

/** Errors in a log line or a multi-line log entry, in the forms the common runtimes print. */
export function parseErrorText(text: string): ParsedError | null {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  // Java / Kotlin / Scala: "pkg.SomeException: message" then "\tat pkg.Class.method(File.java:42)"
  const java = lines.findIndex((l) => /\b([a-z][\w$]*\.)+[A-Z][\w$]*(Exception|Error|Throwable)\b/.test(l));
  if (java >= 0) {
    const m = /\b((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable))(?::\s*(.*))?/.exec(lines[java]!)!;
    const frames = lines.slice(java + 1).map((l) => /^\s*at\s+([\w$.<>]+)\(([^:)]+)/.exec(l)).filter(Boolean).map((x) => `${x![2]} ${x![1]}`);
    return { type: m[1]!, message: clip((m[2] ?? '').trim(), 300), frame: pickFrame(frames) };
  }
  // Python: Traceback ... File "x.py", line 10, in fn ... "ValueError: message" last
  if (lines.some((l) => l.startsWith('Traceback (most recent call last)'))) {
    const frames = lines.map((l) => /File "([^"]+)", line \d+, in (\S+)/.exec(l)).filter(Boolean).map((x) => `${x![1]} ${x![2]}`).reverse();
    const last = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Warning|Interrupt|Exit)\b/.test(l.trim()));
    if (last) {
      const m = /^([A-Za-z_][\w.]*)(?::\s*(.*))?$/.exec(last.trim())!;
      return { type: m[1]!, message: clip((m[2] ?? '').trim(), 300), frame: pickFrame(frames) };
    }
  }
  // Go: "panic: message" then "goroutine 1 [running]:" and "main.fn(...)" / "\t/app/x.go:12"
  const panic = lines.findIndex((l) => /^panic: /.test(l));
  if (panic >= 0) {
    const frames: string[] = [];
    for (let i = panic + 1; i < lines.length - 1; i++) {
      const fn = /^([\w./*()-]+)\(/.exec(lines[i]!);
      const file = /^\s+(\S+\.go):\d+/.exec(lines[i + 1] ?? '');
      if (fn && file) frames.push(`${file[1]} ${fn[1]}`);
    }
    return { type: 'panic', message: clip(lines[panic]!.slice(7).trim(), 300), frame: pickFrame(frames) };
  }
  // JavaScript / TypeScript: "TypeError: message" then "    at fn (/app/file.js:10:5)"
  const js = lines.findIndex((l, i) => /^\s*(?:Uncaught\s+)?([A-Z]\w*(?:Error|Exception))(?::\s*(.*))?$/.test(l.trim()) && /^\s+at\s/.test(lines[i + 1] ?? ''));
  if (js >= 0) {
    const m = /^\s*(?:Uncaught\s+)?([A-Z]\w*(?:Error|Exception))(?::\s*(.*))?$/.exec(lines[js]!.trim())!;
    const frames = lines.slice(js + 1).map((l) => /^\s+at\s+(?:(\S+)\s+\()?([^():]+)/.exec(l)).filter(Boolean).map((x) => `${x![2]} ${x![1] ?? '<anonymous>'}`);
    return { type: m[1]!, message: clip((m[2] ?? '').trim(), 300), frame: pickFrame(frames) };
  }
  // .NET: "System.InvalidOperationException: message" then "   at Ns.Class.Method() in File.cs:line 12"
  const net = lines.findIndex((l) => /\bSystem(\.\w+)*\.\w+Exception\b/.test(l));
  if (net >= 0) {
    const m = /\b(System(?:\.\w+)*\.\w+Exception)(?::\s*(.*))?/.exec(lines[net]!)!;
    const frames = lines.slice(net + 1).map((l) => /^\s+at\s+([\w.`<>]+)\(.*?\)(?:\s+in\s+(\S+?):line)?/.exec(l)).filter(Boolean).map((x) => `${x![2] ?? ''} ${x![1]}`.trim());
    return { type: m[1]!, message: clip((m[2] ?? '').trim(), 300), frame: pickFrame(frames) };
  }
  // A plain error line: "level=error ... msg=..." or "ERROR something failed"
  const plain = lines.find((l) => /\b(ERROR|FATAL|CRITICAL|level=(error|fatal)|"level":"(error|fatal)")\b/i.test(l));
  if (plain) {
    const msg = /(?:msg|message)[=:]\s*"?([^"]+)"?/.exec(plain)?.[1] ?? plain.replace(/^.*?\b(ERROR|FATAL|CRITICAL)\b[:\]\s-]*/i, '');
    return { type: 'error', message: clip(msg.trim(), 300), frame: null };
  }
  return null;
}

/** A span's exception (OpenTelemetry semantic conventions). */
export function parseSpanError(attrs: { type?: string; message?: string; stacktrace?: string }): ParsedError | null {
  if (!attrs.type && !attrs.message) return null;
  const fromStack = attrs.stacktrace ? parseErrorText(attrs.stacktrace) : null;
  return { type: attrs.type || fromStack?.type || 'error', message: clip((attrs.message ?? fromStack?.message ?? '').trim(), 300), frame: fromStack?.frame ?? null };
}

/** The group an error belongs to: same service, type, own top frame and masked message. */
export function errorFingerprint(service: string, e: ParsedError): string {
  const message = logTemplate(e.message).replace(/'[^']{0,80}'/g, "'<str>'");
  return createHash('sha256').update([service.toLowerCase(), e.type, e.frame ?? '', message].join('\u0000')).digest('hex').slice(0, 24);
}

export interface ErrorSample {
  service: string;
  error: ParsedError;
  at: number;
  example: string;
  source: 'logs' | 'traces';
  traceId?: string;
}

/** Group samples: fingerprint -> count, first and last seen, one example. */
export function groupErrors(samples: ErrorSample[]): Array<{ fingerprint: string; service: string; error: ParsedError; count: number; first: number; last: number; example: string; source: 'logs' | 'traces'; traceId?: string }> {
  const out = new Map<string, { fingerprint: string; service: string; error: ParsedError; count: number; first: number; last: number; example: string; source: 'logs' | 'traces'; traceId?: string }>();
  for (const s of samples) {
    const fp = errorFingerprint(s.service, s.error);
    const g = out.get(fp);
    if (g) {
      g.count++;
      g.first = Math.min(g.first, s.at);
      g.last = Math.max(g.last, s.at);
      g.traceId ??= s.traceId;
    } else out.set(fp, { fingerprint: fp, service: s.service, error: s.error, count: 1, first: s.at, last: s.at, example: clip(s.example, 2000), source: s.source, ...(s.traceId ? { traceId: s.traceId } : {}) });
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}
