import { Router } from 'express';
import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  becomeSecrets,
  credentials,
  encryptSecret,
  fingerprintSecret,
  packEnvelope,
  targets,
  toolCalls,
} from '@supops/db';
import { applyMethodScript, diagnoseSecret, kubeCredentialFromInput, kubectlPing, parseHostAddresses, pinHostKey, safeGet, shellQuote, loadTarget, resolveBecomeSecrets, resolveSecret, scmProbe, sshExec, TRACE_PROBE } from '@supops/core';
import { OBSERVABILITY_KINDS, isObservabilityKind, isScmKind } from '@supops/shared';
import { watcher } from '../observe/watcher.ts';
import type { ObservabilityConfig } from '@supops/db';
import type { ResolvedTarget } from '@supops/core';
import { db } from '../context.ts';

export const targetRoutes = Router();

/**
 * Refuse a credential we can already tell will not work.
 *
 * The alternative is storing it, classifying it wrongly, and surfacing
 * "All configured authentication methods failed" twenty seconds into a run -- an
 * error that points at the server's permissions rather than at the paste.
 */
function rejectBadSecret(secret: string | undefined, res: Response): boolean {
  if (secret === undefined || secret === '') return false;
  const { problem } = diagnoseSecret(secret);
  if (!problem) return false;
  res.status(400).json({ error: problem });
  return true;
}


/**
 * Elevation passwords, keyed by the sudo/su account each is for. `user: ''` (or
 * omitted) is the wildcard/default. Sending the array replaces the whole set;
 * omitting it keeps what is stored.
 */
const becomePasswordsSchema = z
  .array(z.object({ user: z.string().max(64).default(''), password: z.string().min(1).max(4000) }))
  .max(20)
  .optional();

const becomeSchema = z
  .object({
    method: z.enum(['none', 'sudo', 'su', 'sudo-su']).default('none'),
    user: z.string().max(64).optional(),
    pty: z.boolean().optional(),
    template: z
      .string()
      .max(500)
      .refine((t) => t.includes('{{CMD}}'), 'Template must contain {{CMD}}')
      .optional(),
  })
  .optional();

const viaSchema = z
  .object({
    alias: z.string().min(1).max(200),
    pty: z.boolean().optional(),
    sshFlags: z.string().max(300).optional(),
    /** Elevate on the jump before the hop (its ssh config lives in that account). */
    become: z.object({ method: z.enum(['sudo', 'su', 'sudo-su']), user: z.string().max(64).optional() }).optional(),
  })
  .optional();

type JumpBecome = { method: 'sudo' | 'su' | 'sudo-su'; user?: string };

const sshConfig = z.object({
  kind: z.literal('ssh'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  sudo: z.boolean().default(false),
  become: becomeSchema,
  via: viaSchema,
  loginShell: z.boolean().optional(),
  prelude: z.string().max(500).optional(),
});

/** A Kubernetes cluster reached through its API server (credential holds server/token/CA). */
const k8sConfig = z.object({
  kind: z.literal('k8s'),
  /** Filled from the credential; clients may omit it. */
  server: z.string().default(''),
  defaultNamespace: z.string().max(63).optional(),
  allowedNamespaces: z.array(z.string().min(1).max(63)).max(50).default([]),
});

/** An observability backend reached over its HTTP API (read-only tools only). */
const observabilityConfig = z.object({
  kind: z.enum(OBSERVABILITY_KINDS),
  baseUrl: z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Use an http:// or https:// URL'),
  allowPrivateNetwork: z.boolean().default(false),
  insecureSkipVerify: z.boolean().optional(),
  tenantId: z.string().max(200).optional(),
  indices: z.array(z.string().min(1).max(200)).max(50).optional(),
  maxRangeHours: z.number().int().min(1).max(24 * 31).optional(),
  datasourceUid: z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  ingestAlerts: z.boolean().optional(),
  watch: z.boolean().optional(),
});

/** Credentials for an observability connection; stored encrypted as JSON. */
const observabilityAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('basic'), username: z.string().min(1).max(200), password: z.string().min(1).max(1000) }),
]);

/** GitHub or GitLab, read-only, limited to the repositories listed. */
const scmConfig = z.object({
  kind: z.enum(['github', 'gitlab']),
  baseUrl: z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Use an http:// or https:// URL'),
  repos: z.array(z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9_.*-]+(\/[A-Za-z0-9_.*-]+)+$/, 'owner/name or group/project; * allowed')).min(1, 'List at least one repository').max(100),
  allowPrivateNetwork: z.boolean().default(false),
  insecureSkipVerify: z.boolean().optional(),
});

const targetConfig = z.union([z.discriminatedUnion('kind', [sshConfig, k8sConfig]), observabilityConfig, scmConfig]);

/** Observability and source-control connections: reached over an HTTP API, with a stored token. */
const isApiKind = (k: string) => isObservabilityKind(k) || isScmKind(k);

/** Store (or clear) an observability connection's credential; returns the credential id or null. */
function observabilityCredential(projectId: string, slug: string, auth: z.infer<typeof observabilityAuth>): string | null {
  if (auth.type === 'none') return null;
  return insertCredential(projectId, `${slug} ${auth.type} credential`, auth.type, JSON.stringify(auth));
}

/**
 * Validate a pasted cluster credential and reconcile the namespace settings with it.
 * Returns the credential JSON to store and the config to save, or an error message.
 */
function prepareCluster(
  config: z.infer<typeof k8sConfig>,
  secret: string | undefined,
  prior: { server: string } | null,
): { ok: true; config: z.infer<typeof k8sConfig>; credential: string | null } | { ok: false; error: string } {
  let server = config.server || prior?.server || '';
  let credential: string | null = null;
  let credNamespace: string | undefined;
  if (secret) {
    const parsed = kubeCredentialFromInput(secret);
    if (!parsed.ok) return parsed;
    credential = JSON.stringify(parsed.cred);
    server = parsed.cred.server;
    credNamespace = parsed.cred.namespace;
  } else if (!prior) {
    return { ok: false, error: 'Paste a kubeconfig (or server + token) for this cluster.' };
  }
  const allowed = [...new Set(config.allowedNamespaces.map((n) => n.trim()).filter(Boolean))];
  let defaultNamespace = config.defaultNamespace?.trim() || credNamespace || undefined;
  if (allowed.length && !defaultNamespace) defaultNamespace = allowed[0];
  if (allowed.length && defaultNamespace && !allowed.includes(defaultNamespace)) {
    return { ok: false, error: `The default namespace "${defaultNamespace}" must be one of the allowed namespaces.` };
  }
  return {
    ok: true,
    credential,
    config: { kind: 'k8s', server, allowedNamespaces: allowed, ...(defaultNamespace ? { defaultNamespace } : {}) },
  };
}

const createBody = z.object({
  projectId: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens'),
  name: z.string().min(1).max(100),
  env: z.enum(['dev', 'staging', 'prod']),
  sensitivity: z.number().int().min(0).max(3).default(1),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).default([]),
  config: targetConfig,
  /** Password or a PEM private key. Encrypted immediately; never stored in the clear. */
  secret: z.string().min(1).optional(),
  /** Observability connections: how to authenticate to the API. */
  auth: observabilityAuth.optional(),
  /** Elevation passwords keyed by sudo account. Stored as separate credentials. */
  becomePasswords: becomePasswordsSchema,
  protectedPaths: z.array(z.string()).optional(),
  writablePaths: z.array(z.string()).optional(),
  unitAllowlist: z.array(z.string()).optional(),
});

targetRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const includeArchived = req.query.includeArchived === '1';

  const filters = [
    ...(projectId ? [eq(targets.projectId, projectId)] : []),
    ...(includeArchived ? [] : [eq(targets.enabled, true)]),
  ];
  const rows = filters.length
    ? db.select().from(targets).where(and(...filters)).all()
    : db.select().from(targets).all();
  // Never leak which credential backs a target beyond "there is one".
  res.json(rows.map(publicTarget));
});

targetRoutes.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid target' });
    return;
  }
  const { secret, becomePasswords, auth, ...target } = parsed.data;
  // Checked before any credential is stored, so a clash leaves nothing behind.
  const taken = db
    .select({ id: targets.id })
    .from(targets)
    .where(and(eq(targets.projectId, target.projectId), eq(targets.slug, target.slug)))
    .get();
  if (taken) {
    res.status(409).json({ error: `A target named "${target.slug}" already exists in this project. Pick a different name.` });
    return;
  }

  if (isApiKind(target.config.kind)) {
    const row = db
      .insert(targets)
      .values({
        ...target,
        kind: target.config.kind,
        credentialId: auth ? observabilityCredential(target.projectId, target.slug, auth) : null,
        createdAt: new Date(),
      })
      .returning()
      .get();
    // Start watching and reading alerts from it now, not at the next tick.
    watcher.kick();
    res.status(201).json(publicTarget(row));
    return;
  }

  if (target.config.kind === 'k8s') {
    const prep = prepareCluster(target.config, secret, null);
    if (!prep.ok) {
      res.status(400).json({ error: prep.error });
      return;
    }
    const row = db
      .insert(targets)
      .values({
        ...target,
        config: prep.config,
        kind: 'k8s',
        credentialId: insertCredential(target.projectId, `${target.slug} cluster credential`, 'kubeconfig', prep.credential!),
        createdAt: new Date(),
      })
      .returning()
      .get();
    res.status(201).json(publicTarget(row));
    return;
  }

  if (rejectBadSecret(secret, res)) return;

  let credentialId: string | null = null;
  if (secret) {
    credentialId = insertCredential(target.projectId, `${target.slug} credential`,
      diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret);
  }

  const row = db
    .insert(targets)
    .values({
      ...target,
      // The discriminant lives in `config`; the column mirrors it so tool binding can
      // filter targets without deserialising every config blob.
      kind: target.config.kind,
      credentialId,
      createdAt: new Date(),
    })
    .returning()
    .get();
  if (becomePasswords) setBecomeSecrets(row.id, row.projectId, row.slug, becomePasswords);
  res.status(201).json(publicTarget(row));
});

/**
 * Replace a target's elevation passwords wholesale. Old entries (and their
 * credential rows) are removed, so this both adds and clears -- an empty array
 * means "no stored elevation passwords".
 */
function setBecomeSecrets(
  targetId: string,
  projectId: string,
  slug: string,
  entries: Array<{ user: string; password: string }>,
): void {
  const old = db.select().from(becomeSecrets).where(eq(becomeSecrets.targetId, targetId)).all();
  db.delete(becomeSecrets).where(eq(becomeSecrets.targetId, targetId)).run();
  for (const o of old) db.delete(credentials).where(eq(credentials.id, o.credentialId)).run();
  // De-dupe by user so the unique (target, user) index cannot be violated; last wins.
  const byUser = new Map<string, string>();
  for (const e of entries) byUser.set(e.user ?? '', e.password);
  for (const [user, password] of byUser) {
    const credId = insertCredential(projectId, `${slug} elevation${user ? ` (${user})` : ''}`, 'sudo_password', password);
    db.insert(becomeSecrets).values({ targetId, sudoUser: user, credentialId: credId }).run();
  }
}

/** The sudo accounts a target has elevation passwords for ('' shown as 'default'). */
function becomeUsersFor(targetId: string): string[] {
  return db
    .select({ user: becomeSecrets.sudoUser })
    .from(becomeSecrets)
    .where(eq(becomeSecrets.targetId, targetId))
    .all()
    .map((r) => r.user);
}

/** Insert an encrypted credential and return its id. */
function insertCredential(projectId: string, name: string, type: 'ssh_key' | 'ssh_password' | 'sudo_password' | 'kubeconfig' | 'bearer' | 'basic', secret: string): string {
  const cred = db
    .insert(credentials)
    .values({
      projectId,
      name,
      type,
      secretEnc: packEnvelope(encryptSecret(secret)),
      fingerprint: fingerprintSecret(secret),
      createdAt: new Date(),
    })
    .returning()
    .get();
  return cred.id;
}

/** Strip credential ids from a target row; expose only whether each exists. */
function publicTarget(row: typeof targets.$inferSelect) {
  const { credentialId, ...rest } = row;
  return { ...rest, hasCredential: !!credentialId, becomeUsers: becomeUsersFor(row.id) };
}

/** Host aliases from an ssh_config body, minus wildcard patterns like `Host *`. */
function parseSshConfigAliases(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*Host\s+(.+?)\s*$/i);
    if (!m) continue;
    for (const alias of m[1]!.split(/\s+/)) {
      if (alias && !alias.includes('*') && !alias.includes('?') && !alias.startsWith('!')) out.add(alias);
    }
  }
  return [...out];
}

/** Each alias's `HostName` from an ssh_config body (the address the jump dials). */
function parseSshConfigHostNames(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string[] = [];
  for (const raw of text.split('\n')) {
    const host = raw.match(/^\s*Host\s+(.+?)\s*$/i);
    if (host) {
      current = host[1]!.split(/\s+/).filter((a) => a && !/[*?!]/.test(a));
      continue;
    }
    if (/^\s*Match\s/i.test(raw)) { current = []; continue; }
    const hn = raw.match(/^\s*HostName\s*=?\s*(\S+)\s*$/i);
    if (hn && !hn[1]!.includes('%')) for (const a of current) out[a] ??= hn[1]!;
  }
  return out;
}

/** Turn a jump alias into a valid target slug. */
function slugify(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';
}

/** Build a throwaway ResolvedTarget just to run a read-only command over SSH. */
function transientJump(host: string, port: number, user: string, secret: string | null): ResolvedTarget {
  return {
    id: 'discover', slug: 'discover', kind: 'ssh', env: 'dev', sensitivity: 0, description: null,
    config: { kind: 'ssh', host, port, user, sudo: false },
    credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
    ...(secret ? { secret } : {}),
  } as ResolvedTarget;
}

const discoverBody = z.object({
  /** Reuse an existing target's jump connection + stored credential... */
  fromTargetId: z.string().optional(),
  /** ...or give the jump connection inline. */
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().optional(),
  secret: z.string().optional(),
  /** Where the ssh config lives; defaults to ~/.ssh/config (expands to the login user). */
  configPath: z.string().max(500).optional(),
});

/**
 * Only these characters are allowed in an ssh-config path before it goes into a
 * `cat` on the jump: word chars, `/._-~`, `*` (globs like config.d/*) and spaces
 * (multiple paths). Everything a shell could use to inject another command is
 * excluded, so the read stays a read.
 */
const SAFE_CONFIG_PATH = /^[\w./~*\- ]+$/;

/** Read the jump's ssh config (following one level of `Include`) for Host aliases. */
targetRoutes.post('/discover', async (req, res) => {
  const parsed = discoverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid discovery request' });
    return;
  }
  const d = parsed.data;

  let jump: ResolvedTarget;
  if (d.fromTargetId) {
    const t = loadTarget(db, d.fromTargetId);
    if (!t || t.config.kind !== 'ssh') {
      res.status(404).json({ error: 'Jump target not found' });
      return;
    }
    const secret = resolveSecret(db, t);
    jump = secret ? { ...t, secret: secret.value } : t;
  } else {
    if (!d.host || !d.user) {
      res.status(400).json({ error: 'Provide fromTargetId, or host + user (+ credential).' });
      return;
    }
    jump = transientJump(d.host, d.port ?? 22, d.user, d.secret ?? null);
  }

  const configPath =
    d.configPath && SAFE_CONFIG_PATH.test(d.configPath) ? d.configPath : '~/.ssh/config';

  // Many jumps keep the ssh config (and the keys it points at) in another account --
  // you `sudo su -` first and only then does `ssh <alias>` work. So read the config as
  // the login user first, and if that finds nothing, read it again as the elevated
  // account: the jump's own elevation profile if it has one, else passwordless root
  // sudo. Whichever account yields the hosts is returned as `readAs`, and the created
  // targets hop from that same account.
  const jc = jump.config.kind === 'ssh' ? jump.config : null;
  const own = jc?.become && jc.become.method !== 'none' && !jc.become.template
    ? { method: jc.become.method, user: jc.become.user } as JumpBecome
    : null;
  const becomeSecretsOfJump = d.fromTargetId ? resolveBecomeSecrets(db, jump) : [];

  type Attempt = { as: JumpBecome | null; noPrompt?: boolean };
  const attempts: Attempt[] = [{ as: null }];
  if (own) attempts.push({ as: own });
  else attempts.push({ as: { method: 'sudo' }, noPrompt: true });

  // `~` must be the ELEVATED account's home, not the login user's, so paths are
  // rewritten to `~<user>/...` before the read runs as that account.
  const homeFor = (as: JumpBecome | null) => (as ? `~${as.user || 'root'}` : '~');
  const localise = (paths: string, as: JumpBecome | null) =>
    as ? paths.split(/\s+/).map((q) => (q === '~' || q.startsWith('~/') ? homeFor(as) + q.slice(1) : q)).join(' ') : paths;

  const readTarget = (a: Attempt): ResolvedTarget =>
    a.as && jc && !a.noPrompt
      ? ({ ...jump, config: { ...jc, become: { method: a.as.method, user: a.as.user } }, becomeSecrets: becomeSecretsOfJump } as ResolvedTarget)
      : jump;
  const catAs = (a: Attempt, paths: string) => {
    const read = `cat ${localise(paths, a.as)} 2>/dev/null`;
    const command = !a.as
      ? read
      : a.noPrompt
        ? `sudo -n sh -c ${shellQuote(read)}`
        : applyMethodScript(a.as, read);
    return sshExec(command, {
      runId: 'discover', toolCallId: 'discover', target: readTarget(a),
      timeoutMs: 15_000, maxOutputBytes: 131_072, signal: AbortSignal.timeout(20_000),
      ...(d.fromTargetId ? { onNewHostKey: (fp: string) => pinHostKey(db, d.fromTargetId!, fp) } : {}),
    });
  };

  // Follow `Include` directives recursively -- many setups split hosts across
  // config.d/* files, sometimes nested. Relative includes resolve against ~/.ssh,
  // matching ssh's own behaviour. Bounded depth so a cyclic include can't loop.
  const includesIn = (s: string): string[] =>
    [...s.matchAll(/^\s*Include\s+(.+?)\s*$/gim)]
      .flatMap((m) => m[1]!.trim().split(/\s+/))
      .filter((p) => SAFE_CONFIG_PATH.test(p))
      .map((p) => (p.startsWith('/') || p.startsWith('~') ? p : `~/.ssh/${p}`));

  const readAll = async (a: Attempt): Promise<{ ok: boolean; text: string }> => {
    const out = await catAs(a, configPath);
    if (!out.ok) return { ok: false, text: out.text };
    let text = out.text;
    const seen = new Set<string>();
    let frontier = includesIn(text);
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const fresh = frontier.filter((p) => !seen.has(p));
      fresh.forEach((p) => seen.add(p));
      if (!fresh.length) break;
      const inc = await catAs(a, fresh.join(' '));
      if (!inc.ok) break;
      text += `\n${inc.text}`;
      frontier = includesIn(inc.text);
    }
    return { ok: true, text };
  };

  let text = '';
  let readAs: JumpBecome | null = null;
  const failures: string[] = [];
  for (const a of attempts) {
    const r = await readAll(a);
    const who = a.as ? `${a.as.method}${a.as.user ? ` ${a.as.user}` : ' root'}` : 'the login user';
    if (r.ok && parseSshConfigAliases(r.text).length) {
      text = r.text;
      readAs = a.as;
      break;
    }
    failures.push(`as ${who}: ${r.ok ? 'no Host entries' : r.text.trim().slice(0, 300) || 'unreadable'}`);
    if (!text && r.ok) text = r.text; // keep what the login user saw, for the raw view
  }
  if (!readAs && !parseSshConfigAliases(text).length && failures.length === attempts.length) {
    const sshDown = failures.some((f) => /SSH connection to/.test(f));
    if (sshDown) {
      res.status(400).json({ error: `Could not reach the jump: ${failures[0]}` });
      return;
    }
  }

  const aliases = parseSshConfigAliases(text);
  const hostNames = parseSshConfigHostNames(text);
  // `raw` lets the UI show what was actually read, so a mismatch (e.g. hosts only in
  // an unreadable include) is diagnosable instead of a silent undercount.
  res.json({
    aliases, hostNames, configPath, hostCount: aliases.length, raw: text.slice(0, 20_000),
    readAs,
    ...(aliases.length ? {} : { tried: failures }),
  });
});

const bulkBody = z.object({
  projectId: z.string().min(1),
  /** The jump connection: an existing target to clone, or inline host/user/secret. */
  fromTargetId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().optional(),
  secret: z.string().optional(),
  env: z.enum(['dev', 'staging', 'prod']),
  sensitivity: z.number().int().min(0).max(3).default(1),
  aliases: z.array(z.string().min(1)).min(1).max(100),
  /** Each alias's HostName from the jump's ssh config, recorded as its address. */
  hostNames: z.record(z.string().max(253)).optional(),
  slugPrefix: z.string().max(40).optional(),
  become: becomeSchema,
  becomePasswords: becomePasswordsSchema,
  /** The account discovery read the jump's config as (`readAs`); hops run from it. */
  viaBecome: z.object({ method: z.enum(['sudo', 'su', 'sudo-su']), user: z.string().max(64).optional() }).nullable().optional(),
});

/** Create one target per alias, all sharing the jump connection + elevation. */
targetRoutes.post('/bulk', (req, res) => {
  const parsed = bulkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk request' });
    return;
  }
  const b = parsed.data;

  // Resolve the jump host/user and the secret to store on each created target.
  let host = b.host, user = b.user, port = b.port;
  let secret = b.secret ?? null;
  let jumpBecome: Array<{ user: string; password: string }> = [];
  if (b.fromTargetId) {
    const t = loadTarget(db, b.fromTargetId);
    if (!t || t.config.kind !== 'ssh') {
      res.status(404).json({ error: 'Jump target not found' });
      return;
    }
    host = t.config.host; user = t.config.user; port = t.config.port;
    if (secret === null) secret = resolveSecret(db, t)?.value ?? null;
    // Hopping from an elevated account on the jump needs the jump's elevation
    // password too; carry it over (a password given here for the same account wins).
    if (b.viaBecome) jumpBecome = resolveBecomeSecrets(db, t).map((s) => ({ user: s.user, password: s.value }));
  }
  const elevationPasswords =
    b.viaBecome || b.becomePasswords ? [...jumpBecome, ...(b.becomePasswords ?? [])] : undefined;
  if (!host || !user) {
    res.status(400).json({ error: 'Provide fromTargetId, or host + user for the jump.' });
    return;
  }

  const bySlug = new Map(
    db.select().from(targets).where(eq(targets.projectId, b.projectId)).all().map((r) => [r.slug, r]),
  );
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const skipped: string[] = [];

  for (const alias of b.aliases) {
    const slug = slugify(b.slugPrefix ? `${b.slugPrefix}-${alias}` : alias);
    const config = {
      kind: 'ssh' as const, host, port, user, sudo: false,
      ...(b.become ? { become: b.become } : {}),
      via: { alias, ...(b.viaBecome ? { become: b.viaBecome } : {}) },
      ...(b.hostNames?.[alias] ? { addresses: [b.hostNames[alias]!.toLowerCase()] } : {}),
    };
    const cred = () =>
      secret
        ? insertCredential(b.projectId, `${slug} credential`,
            diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret)
        : null;

    const prior = bySlug.get(slug);
    if (prior) {
      // Only refresh a machine we ourselves put behind a jump. A hand-made target
      // (or one reached directly) that happens to share the slug is left untouched.
      const pc = prior.config as { via?: { alias?: string }; host?: string; port?: number; hostKeyFingerprint?: string; addresses?: string[] };
      if (!pc.via?.alias) { skipped.push(alias); continue; }
      const keepPin = pc.hostKeyFingerprint && pc.host === host && pc.port === port;
      const row = db.update(targets).set({
        name: alias, env: b.env, sensitivity: b.sensitivity,
        description: `Behind ${host} (ssh ${alias})`,
        config: {
          ...config,
          ...(keepPin ? { hostKeyFingerprint: pc.hostKeyFingerprint } : {}),
          // Keep addresses a Test recorded, alongside the one from the ssh config.
          ...(pc.addresses?.length || config.addresses ? { addresses: [...new Set([...(config.addresses ?? []), ...(pc.addresses ?? [])])] } : {}),
        },
        // Revive it if a prior delete archived it (enabled=false) -- otherwise the
        // stale row keeps the slug and the machine never reappears.
        enabled: true,
        ...(secret ? { credentialId: cred() } : {}),
      }).where(eq(targets.id, prior.id)).returning().get();
      if (elevationPasswords) setBecomeSecrets(row.id, b.projectId, slug, elevationPasswords);
      updated.push(publicTarget(row));
      continue;
    }

    const row = db.insert(targets).values({
      projectId: b.projectId, slug, name: alias, kind: 'ssh',
      env: b.env, sensitivity: b.sensitivity,
      description: `Behind ${host} (ssh ${alias})`,
      config, credentialId: cred(), createdAt: new Date(),
    }).returning().get();
    if (elevationPasswords) setBecomeSecrets(row.id, b.projectId, slug, elevationPasswords);
    created.push(publicTarget(row));
  }

  res.status(201).json({ created, updated, skipped });
});

/**
 * Connectivity check. Runs `echo` -- read-only by construction, so this endpoint
 * can never become a way to run an arbitrary command outside the risk engine.
 */
targetRoutes.post('/:id/test', async (req, res) => {
  const target = loadTarget(db, req.params.id);
  if (!target) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const secret = resolveSecret(db, target);
  const ctx = {
    runId: 'connectivity-test',
    toolCallId: 'connectivity-test',
    target: secret ? { ...target, secret: secret.value } : target,
    timeoutMs: 15_000,
    maxOutputBytes: 2048,
    signal: AbortSignal.timeout(50_000),
    onNewHostKey: (fp: string) => pinHostKey(db, target.id, fp),
  };
  // Source control: read the first allowed repository with the token.
  if (isScmKind(target.kind)) {
    const r = await scmProbe(ctx);
    db.update(targets).set({ healthState: r.ok ? 'ok' : 'unreachable', lastCheckedAt: new Date() }).where(eq(targets.id, target.id)).run();
    res.json(r);
    return;
  }
  // Observability backends: one cheap read-only API call.
  if (isObservabilityKind(target.kind)) {
    const cfg = target.config as unknown as ObservabilityConfig;
    const probe: Record<string, string> = {
      prometheus: '/api/v1/status/buildinfo', alertmanager: '/api/v2/status', loki: '/loki/api/v1/labels', elasticsearch: '/', ...TRACE_PROBE,
      grafana: cfg.datasourceUid ? `/api/datasources/proxy/uid/${cfg.datasourceUid}/api/v1/status/buildinfo` : '/api/health',
    };
    let ok = false;
    let detail = '';
    try {
      const auth = secret ? (JSON.parse(secret.value) as { type: string; token?: string; username?: string; password?: string }) : null;
      const r = await safeGet({
        baseUrl: cfg.baseUrl,
        path: probe[target.kind]!,
        headers: {
          ...(auth?.type === 'bearer' ? (target.kind === 'signoz' ? { 'SIGNOZ-API-KEY': auth.token! } : { authorization: `Bearer ${auth.token}` }) : {}),
          ...(auth?.type === 'basic' ? { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` } : {}),
          ...(cfg.tenantId && (cfg.kind === 'loki' || cfg.kind === 'tempo') ? { 'X-Scope-OrgID': cfg.tenantId } : {}),
        },
        allowPrivateNetwork: cfg.allowPrivateNetwork,
        insecureSkipVerify: cfg.insecureSkipVerify,
        timeoutMs: 10_000,
        maxBytes: 4096,
      });
      ok = r.status >= 200 && r.status < 300;
      detail = ok ? `Connected (HTTP ${r.status}).` : `HTTP ${r.status}: ${r.body.slice(0, 300)}`;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    db.update(targets).set({ healthState: ok ? 'ok' : 'unreachable', lastCheckedAt: new Date() }).where(eq(targets.id, target.id)).run();
    res.json({ ok, detail });
    return;
  }

  // Clusters: server version + what the service account may do. Machines: `echo`,
  // plus the machine's own hostname and IPs (read-only), recorded so an alert that
  // names it by its private address or hostname finds this target.
  const out = target.kind === 'k8s'
    ? await kubectlPing(ctx)
    : await sshExec('echo supops-ok; hostname 2>/dev/null; hostname -I 2>/dev/null || true', ctx);

  const reachable = out.ok && out.text.includes('supops-ok');
  const fresh = db.select().from(targets).where(eq(targets.id, target.id)).get();
  const cfg = fresh?.config.kind === 'ssh' ? fresh.config : null;
  const addresses = reachable && cfg ? parseHostAddresses(out.text.slice(out.text.indexOf('supops-ok'))) : [];
  db.update(targets)
    .set({
      healthState: reachable ? 'ok' : 'unreachable',
      lastCheckedAt: new Date(),
      ...(cfg && addresses.length ? { config: { ...cfg, addresses } } : {}),
    })
    .where(eq(targets.id, target.id))
    .run();

  res.json({ ok: reachable, detail: out.text });
});

/**
 * Forget a target's pinned host key, so the next connection trusts whatever key the
 * server presents. For an expected rebuild; the UI asks before calling it.
 */
targetRoutes.post('/:id/forget-host-key', (req, res) => {
  const existing = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!existing) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }
  const { hostKeyFingerprint: _dropped, ...rest } = existing.config as Record<string, unknown>;
  const row = db.update(targets)
    .set({ config: rest as typeof existing.config, healthState: 'unknown', lastCheckedAt: null })
    .where(eq(targets.id, existing.id))
    .returning()
    .get();
  res.json(publicTarget(row));
});

const patchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  env: z.enum(['dev', 'staging', 'prod']).optional(),
  sensitivity: z.number().int().min(0).max(3).optional(),
  description: z.string().max(300).optional(),
  config: targetConfig.optional(),
  /** Observability connections: replace how to authenticate. */
  auth: observabilityAuth.optional(),
  /** Omit to keep the existing credential; send "" to remove it. */
  secret: z.string().max(8000).optional(),
  /** Elevation passwords keyed by sudo account; omit to keep, [] to clear all. */
  becomePasswords: becomePasswordsSchema,
  enabled: z.boolean().optional(),
});

targetRoutes.patch('/:id', (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid target' });
    return;
  }

  const existing = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!existing) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const { secret, becomePasswords, auth, ...fields } = parsed.data;

  if (isApiKind(existing.kind) || (fields.config && isApiKind(fields.config.kind))) {
    if (fields.config && fields.config.kind !== existing.kind) {
      res.status(400).json({ error: 'A connection cannot change kind; create a new one.' });
      return;
    }
    const row = db
      .update(targets)
      .set({
        ...fields,
        ...(auth ? { credentialId: observabilityCredential(existing.projectId, existing.slug, auth) } : {}),
        ...(fields.config || auth ? { healthState: 'unknown' as const, lastCheckedAt: null } : {}),
      })
      .where(eq(targets.id, existing.id))
      .returning()
      .get();
    res.json(publicTarget(row));
    return;
  }

  if (existing.kind === 'k8s' || fields.config?.kind === 'k8s') {
    if (fields.config && fields.config.kind !== existing.kind) {
      res.status(400).json({ error: 'A target cannot switch between machine and cluster; create a new one.' });
      return;
    }
    const priorCfg = existing.config as { server?: string };
    const cfg = fields.config?.kind === 'k8s'
      ? fields.config
      : { ...(existing.config as z.infer<typeof k8sConfig>) };
    const prep = prepareCluster(cfg, secret || undefined, { server: priorCfg.server ?? '' });
    if (!prep.ok) {
      res.status(400).json({ error: prep.error });
      return;
    }
    const row = db
      .update(targets)
      .set({
        ...fields,
        config: prep.config,
        ...(prep.credential
          ? { credentialId: insertCredential(existing.projectId, `${existing.slug} cluster credential`, 'kubeconfig', prep.credential) }
          : {}),
        ...(fields.config || secret ? { healthState: 'unknown' as const, lastCheckedAt: null } : {}),
      })
      .where(eq(targets.id, existing.id))
      .returning()
      .get();
    res.json(publicTarget(row));
    return;
  }

  if (rejectBadSecret(secret, res)) return;

  // The pinned host key is server-owned (never taken from a client). Keep it across
  // edits unless the edit points the target at a different host or port.
  if (fields.config?.kind === 'ssh') {
    const prev = existing.config as { host?: string; port?: number; hostKeyFingerprint?: string };
    if (prev.hostKeyFingerprint && prev.host === fields.config.host && prev.port === fields.config.port) {
      fields.config = { ...fields.config, hostKeyFingerprint: prev.hostKeyFingerprint } as typeof fields.config;
    }
  }

  // Omit = keep, "" = remove, value = replace.
  let credentialId = existing.credentialId;
  if (secret !== undefined) {
    credentialId = secret === ''
      ? null
      : insertCredential(existing.projectId, `${existing.slug} credential`,
          diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret);
  }

  const row = db
    .update(targets)
    .set({
      ...fields,
      ...(fields.config ? { kind: fields.config.kind } : {}),
      credentialId,
      // Any change to where or how we connect invalidates the last health result.
      ...(fields.config || secret !== undefined
        ? { healthState: 'unknown' as const, lastCheckedAt: null }
        : {}),
    })
    .where(eq(targets.id, existing.id))
    .returning()
    .get();

  // Omitting becomePasswords keeps the stored set; sending it (even []) replaces it.
  if (becomePasswords !== undefined) setBecomeSecrets(row.id, row.projectId, row.slug, becomePasswords);

  res.json(publicTarget(row));
});

/**
 * Remove a target.
 *
 * If an agent has ever acted on it, the row is archived rather than deleted: the
 * audit trail has to keep resolving which machine a command ran against, and a
 * dangling reference would quietly turn a historical record into a mystery. A target
 * that was never used -- a typo, or a test fixture -- is deleted outright.
 */
targetRoutes.delete('/:id', (req, res) => {
  const existing = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!existing) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const used = db
    .select({ n: sql<number>`count(*)` })
    .from(toolCalls)
    .where(eq(toolCalls.targetId, existing.id))
    .get();

  if ((used?.n ?? 0) > 0) {
    db.update(targets).set({ enabled: false }).where(eq(targets.id, existing.id)).run();
    res.json({ ok: true, archived: true, reason: `kept for the audit trail of ${used?.n} past action(s)` });
    return;
  }

  db.delete(targets).where(eq(targets.id, existing.id)).run();
  if (existing.credentialId) {
    db.delete(credentials).where(eq(credentials.id, existing.credentialId)).run();
  }
  res.json({ ok: true, archived: false });
});
