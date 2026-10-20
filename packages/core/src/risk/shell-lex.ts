/**
 * A deliberately small, deliberately paranoid shell reader.
 *
 * We are not writing a shell. We are answering one question -- "which programs does
 * this line run, with which arguments, writing where?" -- and we would rather refuse
 * to answer than answer wrongly. Every construct that could hide a command name from
 * us (command substitution, eval, arithmetic expansion, a quoted-up `r''m`, an
 * invisible Unicode character) makes us fail closed, which the classifier turns into
 * `high`.
 *
 * This costs some legitimate one-liners. That is the intended trade: the agent
 * learns to split them, and we never mistake `$(echo cm0K|base64 -d) -rf /` for a
 * command we recognise.
 */

export type RedirectOp = '>' | '>>' | '>|' | '&>' | '&>>' | '<' | '<<' | '<<<' | '<>' | '>&' | '<&';

export interface Redirect {
  op: RedirectOp;
  path: string;
  /** The file descriptor being redirected (`2>` is fd 2). */
  fd?: number;
  /** True for `2>&1` / `>&2`: duplicates a descriptor, writes no file. */
  dup?: boolean;
}

export interface SimpleCommand {
  /** argv[0] with any path prefix kept (`/bin/rm` stays `/bin/rm`). */
  name: string;
  args: string[];
  redirects: Redirect[];
  raw: string;
  /** True when this command's output is piped into another. */
  pipedInto: boolean;
  /** True when this command's input comes from the previous command's output. */
  pipedFrom?: boolean;
  /** Run with a trailing `&`: detached from the run that started it. */
  background?: boolean;
  /** The body of a `<<EOF` heredoc feeding this command. */
  heredoc?: string;
  /** Working directory, when a `cd` earlier in the line made it knowable. */
  cwd?: string | null;
  /** Leading `VAR=value` assignments: the environment of this one command. */
  env?: Array<[string, string]>;
  /** First / last command of a `( ... )` subshell, whose `cd` does not leak out. */
  subshellOpen?: boolean;
  subshellClose?: boolean;
}

/** Constructs whose expansion we cannot see. Their presence alone is disqualifying. */
const OBFUSCATION = [
  { pattern: '$(', reason: 'command substitution' },
  { pattern: '`', reason: 'backtick command substitution' },
  { pattern: '<(', reason: 'process substitution' },
  { pattern: '>(', reason: 'process substitution' },
  { pattern: '${', reason: 'parameter expansion' },
  { pattern: '$((', reason: 'arithmetic expansion' },
  { pattern: "$'", reason: 'ANSI-C quoting, which can encode any character' },
  { pattern: '$"', reason: 'locale quoting' },
] as const;

/**
 * Characters that render invisibly or reorder text on screen (Trojan Source), so what
 * the approver reads differs from what runs. Never legitimate in an ops command.
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Words that start or join shell compound statements; the command follows them. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}']);

export interface LexFailure {
  ok: false;
  reason: string;
}
export interface LexSuccess {
  ok: true;
  commands: SimpleCommand[];
  /** Bare `VAR=value` statements, which set shell variables for the rest of the line. */
  assignments?: Array<[string, string]>;
}
export type LexResult = LexSuccess | LexFailure;

export function lexShell(input: string): LexResult {
  const command = input.trim();
  if (!command) return { ok: false, reason: 'empty command' };

  if (INVISIBLE.test(command)) {
    return { ok: false, reason: 'contains invisible or text-reordering characters that can disguise the real command' };
  }
  for (const { pattern, reason } of OBFUSCATION) {
    if (command.includes(pattern)) {
      return { ok: false, reason: `contains ${reason} (${pattern})` };
    }
  }

  const segments = splitOnControlOperators(command);
  if (!segments) return { ok: false, reason: 'unbalanced quotes' };

  const commands: SimpleCommand[] = [];
  // `VAR=value` assignments earlier in the line, so `F=/etc/shadow; cat $F` is read
  // as what it is.
  const vars = new Map<string, string>();
  const assignments: Array<[string, string]> = [];
  for (const seg of segments) {
    const parsed = parseSimpleCommand(seg, vars);
    if (!parsed.ok) return parsed;
    if (parsed.command) commands.push(parsed.command);
    if (parsed.assigned) assignments.push(...parsed.assigned);
  }

  if (commands.length === 0) return { ok: false, reason: 'no command found' };
  // Mark the receiving side of each pipe, so rules can ask "what reads this output?".
  for (let i = 1; i < commands.length; i += 1) {
    if (commands[i - 1]!.pipedInto) commands[i]!.pipedFrom = true;
  }
  return { ok: true, commands, ...(assignments.length ? { assignments } : {}) };
}

interface Segment {
  text: string;
  pipedInto: boolean;
  background: boolean;
  heredoc?: string;
  /** Opens / closes a `( ... )` subshell, whose `cd` does not leak out. */
  subshellOpen?: boolean;
  subshellClose?: boolean;
}

/**
 * Split on ; && || | |& & and newlines while respecting quotes. `&` that belongs to a
 * redirect (`2>&1`, `&>file`, `>&2`) is not a control operator. Heredoc bodies are
 * captured whole rather than read as commands. Returns null on unbalanced quotes.
 */
export function splitOnControlOperators(input: string): Segment[] | null {
  const segments: Segment[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let pendingHeredoc: { delim: string; strip: boolean } | null = null;

  const push = (pipedInto: boolean, background = false) => {
    const t = buf.trim();
    if (t) {
      const open = t.startsWith('(');
      const close = t.endsWith(')') && !/\$\(|\(\)/.test(t);
      segments.push({
        text: t.replace(/^\(+\s*/, '').replace(/\s*\)+$/, ''),
        pipedInto,
        background,
        ...(open ? { subshellOpen: true } : {}),
        ...(close ? { subshellClose: true } : {}),
      });
    }
    buf = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      // A backslash-newline is a line continuation, not a separator.
      if (ch === '\n') buf = buf.slice(0, -1);
      else buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      buf += ch;
      quote = ch;
      continue;
    }

    // `<<DELIM` / `<<-DELIM` / `<<'DELIM'` (but not `<<<`): remember the delimiter.
    if (input.startsWith('<<', i) && input[i + 2] !== '<') {
      const m = input.slice(i + 2).match(/^(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (m) pendingHeredoc = { delim: m[3]!, strip: m[1] === '-' };
    }

    const two = input.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(false);
      i += 1;
      continue;
    }
    if (two === '|&') {
      push(true);
      i += 1;
      continue;
    }
    if (ch === '|') {
      push(true);
      continue;
    }
    if (ch === '&') {
      const prev = buf.replace(/\s+$/, '').slice(-1);
      if (input[i + 1] === '>' || prev === '>' || prev === '<') {
        buf += ch; // part of a redirect: &> or >& / <&
        continue;
      }
      push(false, true);
      continue;
    }
    if (ch === ';' || ch === '\n') {
      push(false);
      if (ch === '\n' && pendingHeredoc) {
        // Consume the heredoc body up to the delimiter line and attach it.
        const lines: string[] = [];
        let j = i + 1;
        let found = false;
        while (j <= input.length) {
          const nl = input.indexOf('\n', j);
          const line = input.slice(j, nl < 0 ? input.length : nl);
          const cmp = pendingHeredoc.strip ? line.replace(/^\t+/, '') : line;
          j = nl < 0 ? input.length + 1 : nl + 1;
          if (cmp.trim() === pendingHeredoc.delim) { found = true; break; }
          lines.push(line);
        }
        if (!found) return null;
        const last = segments[segments.length - 1];
        if (last) last.heredoc = lines.join('\n');
        pendingHeredoc = null;
        i = j - 1;
      }
      continue;
    }
    buf += ch;
  }

  if (quote || escaped) return null;
  push(false);
  return segments;
}

type Token =
  | { kind: 'word'; value: string; raw: string; quoted: boolean }
  | { kind: 'redirect'; op: RedirectOp; fd?: number };

const REDIRECT_AT = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/;

/**
 * Split one simple command into words and redirect operators. Unquoted `>` / `<`
 * are operators even inside a word (`echo hi>/etc/passwd` writes /etc/passwd), and
 * a word of pure digits directly before one is its file descriptor (`2>`).
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let value = '';
  let raw = '';
  let quoted = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (started) tokens.push({ kind: 'word', value, raw, quoted });
    value = '';
    raw = '';
    quoted = false;
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      value += ch;
      raw += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      raw += ch;
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      raw += ch;
      if (ch === quote) quote = null;
      else value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      started = true;
      raw += ch;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && text[i + 1] === '>')) {
      const op = text.slice(i).match(REDIRECT_AT)![1]!;
      let fd: number | undefined;
      if (started && !quoted && /^\d+$/.test(raw)) {
        fd = Number(raw);
        value = ''; raw = ''; started = false;
      } else {
        flush();
      }
      const norm = (op === '<<-' ? '<<' : op) as RedirectOp;
      tokens.push({ kind: 'redirect', op: norm, ...(fd !== undefined ? { fd } : {}) });
      i += op.length - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    value += ch;
    raw += ch;
    started = true;
  }

  if (quote || escaped) return null;
  flush();
  return tokens;
}

function substitute(word: string, vars: Map<string, string>): string {
  return word.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => vars.get(name) ?? m);
}

function parseSimpleCommand(
  seg: Segment,
  vars: Map<string, string>,
): { ok: true; command: SimpleCommand | null; assigned?: Array<[string, string]> } | LexFailure {
  const tokens = tokenize(seg.text);
  if (!tokens) return { ok: false, reason: 'unbalanced quotes in command' };
  if (tokens.length === 0) return { ok: true, command: null };

  const args: string[] = [];
  const redirects: Redirect[] = [];
  let name: string | null = null;
  const assigned: Array<[string, string]> = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'redirect') {
      const next = tokens[i + 1];
      if (!next || next.kind !== 'word') return { ok: false, reason: 'redirect without a destination' };
      i += 1;
      const path = substitute(next.value, vars);
      const dup = (tok.op === '>&' || tok.op === '<&') && /^(\d+|-)$/.test(path);
      redirects.push({ op: tok.op, path, ...(tok.fd !== undefined ? { fd: tok.fd } : {}), ...(dup ? { dup: true } : {}) });
      continue;
    }

    if (name === null) {
      // Compound-statement keywords (`if`, `then`, `do`, `!`, `{`) precede the real
      // command; closers (`fi`, `done`, `}`) run nothing.
      if (!tok.quoted && (KEYWORDS.has(tok.raw) || CLOSERS.has(tok.raw))) continue;
      // Loops, case statements and function definitions bind names we cannot follow.
      if (!tok.quoted && (['for', 'case', 'select', 'function', 'coproc'].includes(tok.raw) || /\(\)$/.test(tok.raw))) {
        return { ok: false, reason: `"${tok.raw}" starts a loop, case statement or function, which cannot be read statically` };
      }
      // Leading VAR=value assignments, then the real command. The raw text must start
      // with a plain name and `=`; the value may be quoted (GIT_PAGER="less -R").
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) {
        const eq = tok.value.indexOf('=');
        assigned.push([tok.value.slice(0, eq), substitute(tok.value.slice(eq + 1), vars)]);
        continue;
      }
      if (tok.raw === 'export' || tok.raw === 'local' || tok.raw === 'readonly') {
        // `export A=b` is an assignment too.
        const rest = tokens.slice(i + 1).filter((t): t is Extract<Token, { kind: 'word' }> => t.kind === 'word');
        if (rest.every((t) => /^[A-Za-z_][A-Za-z0-9_]*(=|$)/.test(t.value))) {
          for (const t of rest) {
            const eq = t.value.indexOf('=');
            if (eq > 0) vars.set(t.value.slice(0, eq), substitute(t.value.slice(eq + 1), vars));
          }
          return { ok: true, command: { name: tok.raw, args: rest.map((t) => t.value), redirects, raw: seg.text, pipedInto: seg.pipedInto } };
        }
      }
      // `r''m`, `"rm"`, `\rm` -- all resolve to `rm` but defeat naive matching.
      // We refuse rather than normalise, because normalising is where this class
      // of bypass historically wins.
      if (tok.quoted || tok.raw.includes('\\')) {
        return { ok: false, reason: `command name is quoted or escaped: ${tok.raw}` };
      }
      const resolved = substitute(tok.value, vars);
      if (resolved.includes('$')) {
        return { ok: false, reason: 'command name may come from a variable' };
      }
      // Homoglyphs: a Cyrillic "р" in "rm" is a different program to the shell and
      // the same word to a human.
      if (/[^\x21-\x7e]/.test(resolved)) {
        return { ok: false, reason: `command name contains non-ASCII characters (${resolved}); lookalike letters can disguise a command` };
      }
      name = resolved;
      continue;
    }
    if (!tok.quoted && CLOSERS.has(tok.raw) && i === tokens.length - 1) continue;
    args.push(substitute(tok.value, vars));
  }

  if (name === null) {
    // A bare assignment segment defines variables for the rest of the line.
    for (const [k, v] of assigned) vars.set(k, v);
    return { ok: true, command: null, ...(assigned.length ? { assigned } : {}) };
  }
  return {
    ok: true,
    command: {
      name,
      args,
      redirects,
      raw: seg.text,
      pipedInto: seg.pipedInto,
      ...(assigned.length ? { env: assigned } : {}),
      ...(seg.background ? { background: true } : {}),
      ...(seg.heredoc !== undefined ? { heredoc: seg.heredoc } : {}),
      ...(seg.subshellOpen ? { subshellOpen: true } : {}),
      ...(seg.subshellClose ? { subshellClose: true } : {}),
    },
  };
}
