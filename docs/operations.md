# Running SupOps

## Backups and restore

SupOps keeps everything in one SQLite database (`DATABASE_PATH`, default
`./data/supops.db`). It backs it up on its own with SQLite's online backup, which copies a
consistent snapshot while SupOps keeps running.

| Variable | Default | Meaning |
|---|---|---|
| `SUPOPS_BACKUP_EVERY_HOURS` | `24` | How often. `0` turns scheduled backups off. |
| `SUPOPS_BACKUP_KEEP` | `7` | How many backups are kept; older ones are deleted. |
| `SUPOPS_BACKUP_DIR` | `backups/` next to the database | Where they go. Put it on another disk, or sync it off the machine. |

Settings → Storage lists the backups and has **Back up now** (admins only).

Secrets in the database (SSH keys, tokens, passwords) are encrypted with
`SUPOPS_MASTER_KEY`. **A backup cannot be read without that key**, so keep the key
somewhere safe that is not next to the backups.

### Restore

1. Stop SupOps.
2. Keep the current database aside, in case you need it:
   `mv data/supops.db data/supops.db.before-restore` (and its `-wal` and `-shm` files, if
   there are any).
3. Copy the backup into place: `cp data/backups/supops-20261018-104207123.db data/supops.db`.
4. Start SupOps with the **same** `SUPOPS_MASTER_KEY` as when the backup was made. It
   applies any newer migrations on start, so a backup from an older version restores into
   a newer one.

In Docker, the database and the backups live in the `/app/data` volume; run the same steps
against that volume with the container stopped.

## API keys

Machines use API keys, not a person's login: CI recording deploys, Prometheus scraping
SupOps' metrics, another agent using SupOps over MCP. Admins make them in
Settings → API keys. A key is shown once; SupOps keeps only its SHA-256 hash.

Send it as `Authorization: Bearer sok_…`. A key can do only what its scopes allow:

| Scope | Allows |
|---|---|
| `read` | `GET` on runs, incidents, alerts, changes, SLOs, synthetics, errors, service health, targets, knowledge and workflows. Not settings, users or keys. |
| `investigate` | Start an investigation (`POST /api/runs`, or investigate an incident). It runs under the project's normal risk policy and approvals. |
| `changes` | `POST /api/changes`: CI/CD marks a deploy, so incidents list it as a possible cause. |
| `metrics` | `GET /api/metrics`. |
| `mcp` | `/api/mcp`, the MCP server below. |

A key acts in the name of the admin who made it, as a member: never with admin rights,
and never to manage keys. It stops working when it is revoked, when it expires, or when
the admin who made it is removed or disabled. Every key's last use is shown, and making
or revoking one is in the audit log.

## Metrics

`GET /api/metrics` returns SupOps' own health in the Prometheus text format. It needs an
admin's session or a key with the `metrics` scope:

```yaml
scrape_configs:
  - job_name: supops
    metrics_path: /api/metrics
    authorization:
      credentials: sok_...   # a key with the metrics scope
    static_configs:
      - targets: ['supops.example.test:3001']
```

What it reports:

- **Runs:** `supops_runs{status}`, `supops_runs_queued`, `supops_tool_calls{state}`,
  `supops_approvals_pending`.
- **Incidents and alerts:** `supops_incidents_open{severity}`, `supops_alerts_open`.
- **The model:** `supops_llm_requests_total{model}`, `supops_llm_errors_total{kind}`,
  `supops_llm_tokens_total{type}` and the latency histogram `supops_llm_request_seconds`.
  These count from when SupOps started.
- **What SupOps reads:** `supops_alert_read_ok{connection}` (0 when reading alerts from a
  connection fails) and `supops_watch_errors`.
- **Checks:** `supops_synthetic_up{check}`, `supops_slo_budget_remaining{slo}`,
  `supops_slo_burning{slo}`.
- **Backups:** `supops_backup_last_timestamp_seconds`, `supops_backup_last_failed`.
- **The process:** `process_resident_memory_bytes`, `nodejs_heap_used_bytes`,
  `process_uptime_seconds`, and `supops_up`.

Alerts worth having: `supops_runs_queued` staying above 0, `supops_approvals_pending`
waiting for a long time, `rate(supops_llm_errors_total[10m]) > 0`,
`supops_alert_read_ok == 0`, and `time() - supops_backup_last_timestamp_seconds > 2 * 86400`.

## SupOps as an MCP server

Other agents (Claude, an IDE assistant, another SupOps) can use SupOps over the Model
Context Protocol, at `POST /api/mcp` (streamable HTTP, JSON responses). Give them a key with
the `mcp` scope:

```json
{
  "mcpServers": {
    "supops": {
      "type": "http",
      "url": "https://supops.example.test/api/mcp",
      "headers": { "Authorization": "Bearer sok_..." }
    }
  }
}
```

Tools:

| Tool | Does |
|---|---|
| `list_incidents` | Open incidents, newest first (or all, with `status`). |
| `get_incident` | One incident: its alerts, SupOps' diagnosis, and the changes suspected of causing it. |
| `list_alerts` | Alerts still open, newest first. |
| `list_changes` | Deploys and other changes in the last hours (default 24), optionally for one service. |
| `get_run` | An investigation's status, the actions it took, and its answer. |
| `start_investigation` | Only with the `investigate` scope as well. Starts an investigation of an incident or a question. |

An investigation started over MCP always runs **unattended**, like automatic triage: it
can look, and it never changes anything. Actions that would change something are refused,
not sent for approval.

## Learning

SupOps learns from what happens, and learning only ever makes it stricter (or reorders
suggestions). Everything it learned is on the **Learning** page.

- **Rules from denials and failures.** The same action denied twice on a machine needs
  one tier more approval next time. Denied three times, by two or more people or with two
  comments, it is blocked. An automatic change that fails twice waits for a person next
  time. Admins can switch rules off, delete them, or reset them all (with undo).
  `SUPOPS_LEARNED_RULES=off` stops applying them entirely.
- **Lessons after a run.** After a run with at least three actions, the model reviews it
  once and proposes up to three lessons. A gate in plain code rejects anything without
  evidence from the run, with a secret, about an unknown machine, a duplicate, a
  forbidden command, or wording that tries to tell future runs what to approve. Kept
  lessons go to Knowledge as **drafts** by default. "Approve facts" approves an observed
  fact with evidence and no commands at once, scoped to its machines and never pinned.
  "Off" turns reviews off. **Each review is one extra model call.**
- **Which change caused it.** On an incident, mark a suspected change "This was the
  cause" or "Not this". A small model per project learns from those marks and adjusts
  the order of suspects. It has no effect below three marks, and full weight after about
  thirty. A confirmed cause can be exported as an eval case. The export holds your own
  systems' output, so review it before adding it to `packages/eval/src/cases`.

## Shadow execution (judging an action by what it would do)

Before a non-read-only action is approved, SupOps simulates it and raises the risk from
what it observed — it never lowers it, and if a simulation cannot run, nothing is added
(fail closed). Three mechanisms, strongest isolation first:

- **Native dry-runs** (always on, no setup): `apt-get -s` / `dnf --assumeno` reveals the
  real removal set (a cascade to `openssh-server` is raised to a lockout); `systemctl`
  stop/restart shows the reverse-dependency blast radius; `kubectl` mutating verbs run
  with `--dry-run=server`.
- **Script detonation** (`run_script`): the script runs in a throwaway sandbox (see
  `apps/detonator`), and reading a credential + dialling out is blocked, a backdoor or
  log-wipe is raised. Needs the detonator service; set `SUPOPS_DETONATOR_URL`. Unset =
  scripts are not detonated.
- **Target-side shadow** (`SUPOPS_TARGET_SHADOW=on`, off by default): run the real
  command on the target inside a copy-on-write sandbox (bubblewrap `--tmp-overlay`) whose
  writes are discarded and whose network goes nowhere, and observe what it actually
  touches (files, connections, processes, privilege) with `strace`. Needs `bwrap`,
  overlayfs and `strace` on the target (it probes first, and is unavailable where they
  are missing). Because it runs real code on the target, its isolation profile should
  pass a security review before you enable it in production; it is strictly raise-only
  and fails closed.
- **Fail-closed sandbox gate** (`SUPOPS_SANDBOX_GATE`, `off` by default): by default the
  sandbox is raise-only and fail-*open* -- it escalates what it catches, but a change it
  could not observe still falls through to the normal approval gate. Set the gate to make
  an *unverified* change **block** instead of running on a (possibly mistaken) approval:
  `scripts` blocks an un-detonated `run_script`; `prod` blocks any unverified non-read-only
  change on a production target; `all` blocks every unverified non-read-only change. A
  verified clean run is unaffected (still raise-only). `all` is strict: without the target
  shadow most commands have no sandbox to verify them, so it blocks most changes until a
  backend is running -- `scripts` (with the detonator up) or `prod` is the usable middle
  ground. The block is at the `forbidden` tier, so no approval can run the action; bring up
  the sandbox or relax the gate to proceed.

A human-approved change whose simulation is older than ten minutes is **re-checked**
before it runs; a worse result sends it back for a fresh decision. What a simulation
saw — and what it could **not** see — appears in the "What it would actually do" panel
on the approval card.
