> **STATUS: PARKED — next version, not started.**
> Saved 2026-09-16. Do not act on this yet. Kick off once these are confirmed with stakeholders:
> the actual cloud/on-prem split, whether a per-environment bastion credential is on the table
> (a much cheaper fallback), and what their CMDB exposes. See "To confirm with stakeholders" below.

---

# SupOps — reaching targets without host credentials (the Runner)

## Context

For certain environments, stakeholders refused to hand over IP + password and asked us to "find another way, something like a CMDB." SupOps today reaches every target over SSH with a stored, encrypted credential — so those environments are currently unreachable, and the whole premise (*the AI takes action*) fails for them.

Your answers pin the situation down:

- **Environment is mixed / unknown** → we cannot lead with a single cloud broker (AWS SSM / Azure Arc), because it wouldn't cover the on-prem hosts.
- **The only sanctioned tooling is telemetry** (Prometheus/Splunk) → there is **no** Ansible Tower, ServiceNow Orchestration, or Vault to delegate execution to.
- **Execution is required** → read-only diagnosis alone is not acceptable.
- **"CMDB" means inventory** → it tells us *what hosts exist*, not *how to log in*. It is a discovery source, never an access mechanism.

Put together, four patterns are ruled out and one survives:

| Option | Why it's out (given your constraints) |
|---|---|
| A. Vault-brokered short-lived creds | No Vault/CyberArk exists to broker them |
| B. Cloud command-broker (SSM/Arc/IAP) | Env is mixed/unknown — can't cover on-prem; keep as a *later* optimisation |
| D. Delegate jobs to their platform | No Tower/ServiceNow-Orchestration to delegate to |
| E. Read-only from telemetry | Can't execute — fails the hard requirement |
| **C. Outbound agent (the Runner)** | **Fits all four constraints** ✅ |

**Recommendation: build the SupOps Runner** — a small process *their* team deploys inside each restricted environment. It dials **out** to SupOps, receives only commands SupOps has already classified and approved, executes them with the local identity their team grants it, and streams results back. Layer **CMDB inventory sync** on top for discovery. This is the same shape as SSM Agent / Salt minion / Tower callback — the pattern security teams accept precisely because it needs **no inbound path and no shared host credential**.

---

## Why this fits, in one paragraph

The Runner satisfies the exact objection. **No inbound firewall exception** — the Runner makes outbound connections only. **SupOps never holds a host credential** — the Runner uses whatever local access their team gives its process; nothing is handed to us. **The Runner can't go rogue** — it executes only work items SupOps dispatches, and SupOps dispatches only *after* the existing five-stage risk classification and (per tier) human approval. Every command still lands in the same audit trail. The Runner is a dumb-but-trusted executor of already-authorised commands.

---

## The seam this plugs into (already exists)

Reaching a target differently is a **new transport behind the same tool**, not a rewrite. Confirmed against the code:

- A target has `kind` (`ssh|docker|k8s|http`) + `config` + optional encrypted `credential` — `packages/db/src/schema/targets.ts`, `packages/db/src/schema/types.ts`.
- A tool declares `targetKinds` and an `execute(args, ctx)`; the registry binds tools to targets by `def.targetKinds.includes(t.kind)` — `packages/core/src/tools/registry.ts:21`.
- The runner loop dispatches every call through **one** function, `executeToolCall`, passing an `ExecContext` with `onChunk`, `signal`, and the decrypted `target.secret` — `packages/core/src/engine/runner.ts:295`, `packages/core/src/tools/types.ts`.
- Today only `ssh` has an executor — `packages/core/src/tools/executors/ssh.ts`.

Everything above the executor — the agent loop, risk engine, approvals + suspend/resume, secret redaction (`StreamRedactor`), live streaming, the durable audit trail — is **reused unchanged**. We add: a new target kind, a new executor, a new outbound-only component.

---

## Architecture

### 1. New target kind + executor (server side)
- Add `'agent'` to `TARGET_KINDS` (`packages/shared/src/states.ts`) and a `TargetConfig` variant `{ kind: 'agent'; runnerId: string; label?: string }` (`packages/db/src/schema/types.ts`). The target names *which Runner* reaches the host; the Runner holds the access, so **no credential row is attached**.
- `ssh_exec` / `ssh_read_file` / `ssh_write_file` gain `'agent'` in their `targetKinds` (`packages/core/src/tools/builtin.ts`). The command string, `render()`, and **risk classification are identical** — only delivery changes. The model acts on an agent target exactly as it does an SSH one.
- New executor `packages/core/src/tools/executors/agent.ts` — `agentExec(command, ctx)`: enqueues a work item for the target's `runnerId` + `ctx.toolCallId`, then awaits the Runner's result, feeding chunks into `ctx.onChunk`. Returns the same `ToolOutput`, so truncation/redaction/streaming are untouched. Re-checks `argsHash` at enqueue (the existing TOCTOU seal). On Runner-timeout it resolves `unknown_outcome` for tier ≥ low — **never auto-retried** — matching the SSH executor's crash semantics.

### 2. Durable work queue + Runner identity
- New table `runners` (id, projectId, name, env, tokenHash, status, lastSeenAt) and `runner_work` (id, runnerId, runId, toolCallId, command, argsHash, state `queued|dispatched|done`, resultJson, timestamps) — `packages/db/src/schema/`.
- New routes `apps/server/src/routes/runner.ts`: `POST /runner/enrol` (one-time token → identity), `POST /runner/heartbeat`, `POST /runner/chunk`, `POST /runner/result`. A dedicated **Runner-token middleware**, separate from user JWT auth.
- **Transport: reuse Socket.IO** (already powering browser streaming) with a `/runner` namespace, token-authed. `runner_work` is the source of truth; the socket is just delivery — same "durable rows vs ephemeral socket deltas" principle already in the codebase. A dropped socket reconnects and re-reads `queued` work, so a crash mid-turn recovers like any run.

### 3. The Runner itself
- New workspace `apps/runner` — a small Node/TS process (same monorepo, no new stack). It: enrols with a token → stores its identity; connects the `/runner` socket outbound; on a work item, runs the command via `child_process` with its **local** identity; streams stdout/stderr back over `POST /runner/chunk`; posts the final exit code + output to `POST /runner/result`; honours cancellation and heartbeats. A README for stakeholders: one binary, outbound-only, runs as an unprivileged local user they control.

### 4. CMDB inventory sync (discovery layer — matches "pull host inventory")
- New `packages/core/src/discovery/cmdb.ts` + a settings-driven config (mirroring the existing `settingsStore` LLM-provider pattern). Pulls CIs from the CMDB (ServiceNow Table API `cmdb_ci_server`, or Device42) and **upserts targets** — slug/name/env/kind/description/tags — mapping each CI to a Runner by environment/tag. **No credentials are synced** (there are none — access is the Runner). Exposed as a manual "Sync from CMDB" button on the Targets page and, later, a scheduled trigger (`RUN_TRIGGERS` already includes `'schedule'`). CMDB base URL + a read-only API token stored via the existing encrypted-credential path.

---

## Security properties (state these to stakeholders)

- **No inbound path** to the hosts — the Runner dials out.
- **SupOps never holds a host credential** — the Runner uses local access their team grants; nothing is shared with us.
- **Nothing runs unauthorised** — every command is classified and, per risk tier, human-approved *before* dispatch; the Runner cannot execute what SupOps didn't send.
- **Full, unchanged audit** — `run_steps` / `tool_calls` / `run_events` capture every action, its risk tier, and its outcome.
- **Contained + revocable** — a Runner's blast radius is its own environment and its granted local perms; enrolment tokens revoke instantly.

---

## Phasing (this is a multi-phase build — the largest of the five options, but the only one that fits)

- **Phase 1 — MVP execution:** `runners`/`runner_work` tables, enrol/heartbeat/chunk/result routes + `/runner` socket namespace, `agent` target kind, `agentExec` executor, and the `apps/runner` process. Manual Runner deploy + manual target registration with a `runnerId`. Delivers *execute in a no-creds, no-inbound environment* on its own.
- **Phase 2 — Discovery:** CMDB sync auto-registers targets and maps them to Runners by env/tag.
- **Phase 3 — Opportunistic cloud brokers:** for hosts later confirmed in AWS/Azure/GCP, add an SSM/Arc executor as an alternative transport — no Runner deploy needed for those. (Deferred; revisit once the mixed-env split is known.)

## To confirm with stakeholders (cheaper fallback)
If they will grant **one hardened bastion credential per environment** (not per-host), a far smaller change reuses the existing SSH executor: add `proxyJump` to the ssh `TargetConfig` and a hop in `executors/ssh.ts` (ssh2 supports it), skipping the Runner entirely. You already use this shape for the `uat` jump host. It's the cheapest path *if* a bastion key is on the table — but they may be refusing that along with the host creds, so ask before betting on it.

---

## Verification

1. **Risk engine untouched:** the existing `node --test "packages/**/*.test.ts"` (182 tests) must stay green — classification is transport-agnostic, so an `agent` target reuses the same rules. A single regression here means the transport leaked into classification.
2. **Executor unit tests** (`executors/agent.test.ts`): drive `agentExec` against a fake Runner — assert chunks reach `onChunk` through the redactor, the final `ToolOutput` matches, `argsHash` mismatch refuses dispatch, and a Runner timeout yields `unknown_outcome` (not a retry).
3. **End-to-end with a real local Runner:** enrol a Runner against localhost, register an `agent` target pointing at it, run a read-only command from the Console, and confirm: live output streams into the terminal pane, the result and every `tool_call`/`run_event` row are written, and a `medium`-tier command still parks at approval *before* the Runner ever receives it.
4. **No-inbound proof:** run the Runner with all inbound ports closed; confirm work still flows (outbound socket only).
5. **CMDB sync:** point at a ServiceNow dev instance (or a mock), hit "Sync from CMDB", confirm targets upsert with correct env/kind and **no credential rows**, and that a second sync is idempotent.

---

## Out of scope / already done
The rename to SupOps, the Console fixes, the approvals/edit/status bugs, and the dashboard UI corrections from the previous plan are complete and shipped. This plan is only the new-transport work.
