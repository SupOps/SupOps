import type { BecomeMethod, Env, RiskTier, Role, ToolSpec } from '@supops/shared';

/**
 * Autonomy policy. Set on a project; an agent may narrow it but NEVER widen it
 * (enforced at agent-save time, not at runtime, so the guarantee is a data
 * invariant rather than something the hot path has to remember).
 */
export interface RiskPolicy {
  /** Tiers at or below this execute without asking. Default 'low'. Never above 'medium'. */
  autoExecuteMaxTier: RiskTier;
  /** The most an individual agent may be raised to (admins only). Defaults to autoExecuteMaxTier. */
  autoExecuteCeiling?: RiskTier;
  /** Production / sensitivity-3 targets act alone only up to this. Default 'low'. */
  prodAutoExecuteCap?: RiskTier;
  /** Per-tool caps, e.g. { run_script: 'read_only' }. */
  toolAutoExecuteCap?: Record<string, RiskTier>;
  /** Per-trigger caps; defaults keep health read-only and alert/webhook/api/schedule at low. */
  triggerAutoExecuteCap?: Partial<Record<string, RiskTier>>;
  approverRoleByTier: Partial<Record<RiskTier, Role>>;
  /** At or above this tier the approver must differ from whoever started the run. */
  requireSecondPersonAtTier: RiskTier | null;
  ttlMsByTier: Partial<Record<RiskTier, number>>;
  onExpiry: 'continue_as_denied' | 'abort_run';
  /** Per run. Default 1 -- prevents approval storms that train people to click yes. */
  maxConcurrentApprovals: number;
  /**
   * Set only on a run's snapshot, never on a project: nobody is waiting to approve
   * (a scheduled health check), so a call that would need approval is refused and
   * the agent told why, instead of parking the run until someone notices.
   */
  unattended?: boolean;
  /**
   * Set only on a run's snapshot: the run has no access to any system (none was
   * registered, or the operator chose not to give it any). It is given no tools and
   * advises from the operator's facts and the project's knowledge instead.
   */
  advisory?: boolean;
  /** Advisory runs only: read-only network checks (net_check) from the SupOps server are allowed. */
  networkChecks?: boolean;
  /** Set only on a run's snapshot: a live call with a client (advisory, conversational). */
  call?: boolean;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  autoExecuteMaxTier: 'low',
  approverRoleByTier: { medium: 'operator', high: 'admin' },
  requireSecondPersonAtTier: 'high',
  ttlMsByTier: { medium: 30 * 60_000, high: 2 * 60 * 60_000 },
  onExpiry: 'continue_as_denied',
  maxConcurrentApprovals: 1,
};

export type TargetConfig =
  | {
      kind: 'ssh';
      host: string;
      port: number;
      user: string;
      sudo: boolean;
      /** Pinned on first connect; a change means MITM or a rebuild. Never auto-accept silently. */
      hostKeyFingerprint?: string;
      /**
       * Other names this machine is known by -- its hostname, private IPs -- so an
       * alert that names it that way finds it. Recorded by Test and by discovery.
       */
      addresses?: string[];
      /**
       * How to elevate privilege before every command. Enforced by the executor,
       * not by the model. The elevation password (if any) is a separate credential
       * referenced by the target's `becomeCredentialId`, never stored here.
       */
      become?: {
        method: BecomeMethod;
        /** Target user for `su` / `sudo -u`. Required for su and sudo-su. */
        user?: string;
        /** Request a PTY, for sudoers configured with `Defaults requiretty`. */
        pty?: boolean;
        /**
         * Advanced escape hatch for environments that need something other than
         * sudo/su. Must contain `{{CMD}}`, which is replaced with the shell-quoted
         * command. When set, it overrides `method`.
         */
        template?: string;
      };
      /**
       * A second hop: after connecting to `host` (the jump/bastion), reach the real
       * machine by running `ssh <alias> …` ON the jump, so the jump's own ~/.ssh/config
       * resolves the alias, hostname and key. Transport only -- never part of the
       * classified command. Commands (and any elevation) run on the inner machine.
       */
      via?: {
        alias: string;
        /** Force a PTY on the inner ssh (`-tt`). Default true; needed for far-side sudo. */
        pty?: boolean;
        /** Rare extra ssh flags, e.g. `-o StrictHostKeyChecking=accept-new`. */
        sshFlags?: string;
        /**
         * Elevate ON THE JUMP before the hop, for jumps whose ssh config and keys live
         * in another account (e.g. `sudo su -` to root, then `ssh <alias>`). ssh reads
         * the elevated account's ~/.ssh/config. Transport only, like the hop itself.
         */
        become?: { method: 'sudo' | 'su' | 'sudo-su'; user?: string };
      };
      /**
       * Run each command in a login+interactive shell (`bash -lic`) so the login
       * user's aliases, functions and PATH from ~/.bashrc / ~/.profile are available.
       * Needed when a command is a shell alias (e.g. `prodlogin`) rather than a binary.
       * Transport only -- the classified command is still the raw command, not the
       * shell wrapper.
       */
      loginShell?: boolean;
      /**
       * A command run before every command, in the same shell invocation (e.g. an
       * alias that logs into a cluster). Runs statelessly on each call. Transport only.
       */
      prelude?: string;
    }
  | { kind: 'docker'; socketPath?: string; host?: string; port?: number; containerAllowlist?: string[] }
  | {
      kind: 'k8s';
      /** API server URL, for display; the credential carries the authoritative copy. */
      server: string;
      /** Namespace commands run in when none is named. */
      defaultNamespace?: string;
      /** If non-empty, commands may only name these namespaces (and never -A). */
      allowedNamespaces: string[];
    }
  | {
      kind: 'http';
      baseUrl: string;
      allowPrivateNetwork: boolean;
      allowedCidrs?: string[];
      defaultHeaders?: Record<string, string>;
    }
  | ObservabilityConfig
  | ScmConfig;

/**
 * A GitHub or GitLab connection. The token is the target's credential (a bearer
 * credential); use a read-only, repo-scoped token.
 */
export interface ScmConfig {
  kind: 'github' | 'gitlab';
  /** https://api.github.com, a GitHub Enterprise API URL, or a GitLab base URL (https://gitlab.com). */
  baseUrl: string;
  /** Repositories the agent may read, as owner/name (GitHub) or group/project (GitLab); `*` globs allowed. Must be non-empty. */
  repos: string[];
  allowPrivateNetwork: boolean;
  insecureSkipVerify?: boolean;
}

/**
 * An observability backend reached over its HTTP API. Nothing secret lives here:
 * the token or password is the target's credential.
 */
export interface ObservabilityConfig {
  kind: 'prometheus' | 'alertmanager' | 'loki' | 'elasticsearch' | 'grafana' | 'tempo' | 'jaeger' | 'signoz';
  /** e.g. https://prometheus.internal:9090 -- requests never leave this origin. */
  baseUrl: string;
  /** Allow private/loopback addresses (an in-cluster or LAN backend). Cloud metadata is always refused. */
  allowPrivateNetwork: boolean;
  /** Accept a self-signed certificate. */
  insecureSkipVerify?: boolean;
  /** Loki and Tempo multi-tenancy: sent as X-Scope-OrgID. */
  tenantId?: string;
  /** Elasticsearch: index patterns queries may name. Empty = any. */
  indices?: string[];
  /** Grafana: the uid of the Prometheus datasource queries go through (datasource proxy). */
  datasourceUid?: string;
  /** Longest time window a query may cover. Default 168h for metrics, 24h for logs. */
  maxRangeHours?: number;
  /** Read firing alerts from this connection into SupOps (Alertmanager, Prometheus, Grafana). */
  ingestAlerts?: boolean;
  /** Sample key signals from this connection continuously (Prometheus, Grafana). */
  watch?: boolean;
}

/** Credential body for an observability connection (stored encrypted, as JSON). */
export type ObservabilityAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string };

export type CredentialType =
  | 'ssh_password'
  | 'ssh_key'
  | 'sudo_password'
  | 'docker_tls'
  | 'kubeconfig'
  | 'bearer'
  | 'basic'
  | 'header';

/** Budget guards. Without these a wedged agent burns a daily free-tier quota in minutes. */
export interface RunBudget {
  maxIterations: number;
  maxToolCalls: number;
  /** Running time only -- explicitly EXCLUDES time parked in awaiting_approval. */
  maxWallClockMs: number;
  /** 8KB head + 8KB tail, middle elided with a byte count so the model knows. */
  maxOutputBytesPerCall: number;
  /**
   * Interactive sessions only: `maxToolCalls`, `maxIterations` and the wall clock
   * apply per turn, and this caps the whole session. Default 1000.
   */
  maxSessionToolCalls?: number;
  /** Longest single model reply, in tokens. Default 8192. */
  maxOutputTokens?: number;
  /** Conversation size (estimated tokens) above which old command output is elided on the wire. Default 64k. */
  contextTokens?: number;
}

export const DEFAULT_SESSION_TOOL_CALLS = 1000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxIterations: 40,
  maxToolCalls: 120,
  maxWallClockMs: 30 * 60_000,
  maxOutputBytesPerCall: 16_384,
};

/** What the model was shown, frozen at run start for audit and reproducibility. */
export interface TargetSummary {
  slug: string;
  kind: string;
  env: Env;
  description: string | null;
  /** Hostnames/IPs the machine is also known by, so the agent can match an alert's address. */
  addresses?: string[];
}

export interface ToolOutput {
  ok: boolean;
  /** Already truncated, already redacted. This is what reaches the model. */
  text: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  originalBytes?: number;
  /**
   * Set when pass/fail does not describe what happened: the command hit its time
   * limit, or the executor lost contact mid-run and cannot say whether it took
   * effect. `unknown_outcome` is never retried automatically for tier >= low.
   */
  outcome?: 'timed_out' | 'unknown_outcome';
}

export type { ToolSpec };
