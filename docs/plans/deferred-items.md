# Deferred items — to build separately

> Branch note: the half-built code for items 2, 4 and 5 lives on the `experiment` branch only; `dev`/`main`
> carry just the finished parts. See `status.md`.

These pieces of the upgrade programme were not built because the work was stopped
by a safety check while writing them. Everything else in their phases is built and
committed. Each section records what exists, what is missing, and the findings
gathered so far, so they can be picked up later without re-investigating.

## 1. Env-variable prefix classification — DONE 2026-10-19
Collected 2026-10-01 while doing Phase 0. **Fixed** (`packages/core/src/risk/rules-env.ts`): prefixes ride on
`SimpleCommand.env`, bare assignments of dangerous variables count for the rest of the line, quoted values
parse, and an unreadable line still has each readable part judged. The table below is kept as the record
of what the probes showed before the fix; every row is now a corpus case.

**Where it happens**
- `packages/core/src/risk/shell-lex.ts` `parseSimpleCommand`: leading `VAR=value` tokens are collected in the
  local `assigned` array and then **dropped** when a command name follows (only bare-assignment segments feed
  `vars` for later substitution). `SimpleCommand` has no field carrying them, so no rule ever sees them.
- The `env VAR=… cmd` form IS handled: `packages/core/src/risk/rules-system.ts` ~597 (`shell.env.preload`, high).
- `export`/`local`/`readonly` are not in the ruleset → fall to `shell.unknown` (high) already.

**Probe results today** (`classifyShellCommand`, staging target):
| Command | Tier now | Rule |
|---|---|---|
| `LD_PRELOAD=/tmp/x.so ls` | read_only (auto-runs) | shell.flat.ls |
| `LD_LIBRARY_PATH=/tmp ls` | read_only | shell.flat.ls |
| `BASH_ENV=/tmp/x bash -c true` | read_only | shell.flat.true |
| `PATH=/tmp:$PATH ls` | read_only | shell.flat.ls |
| `IFS=/ ls` | read_only | shell.flat.ls |
| `KUBECONFIG=/tmp/k kubectl get pods` | read_only | shell.kubectl.get |
| `SYSTEMD_PAGER=cat systemctl status nginx` | read_only (benign) | shell.systemctl.status |
| `LANG=C ls`, `TZ=UTC date` | read_only (benign) | — |
| `GIT_PAGER="sh -c id" git log` | high | shell.unparseable |
| `GIT_SSH_COMMAND="sh /tmp/x" git fetch` | high | shell.unparseable |
| `PAGER=/tmp/x man ls` | high | shell.unknown |
| `PS4='$(id)' bash -x` | high | shell.unparseable |
| `PROMPT_COMMAND=id bash` | high | shell.sh.interactive |
| `env LD_PRELOAD=/tmp/x.so ls` | high | shell.env.preload |

**Expected shape of the fix (for whoever builds it):** carry prefix assignments on `SimpleCommand`; a rule
that raises (never lowers) based on the variable, combined with the inner command's tier via `worst()`;
benign locale/timezone variables stay read_only; add corpus cases for every row above; parity/fuzz must stay green.

## 2. Domain playbook text — write separately
Phase 3's playbook bodies (linux, containers, kubernetes, networking, databases, observability, aws, gcp,
azure, terraform, helm, git, cicd) were not written. Built instead: the selection/injection mechanism in
`packages/core/src/engine/skills.ts` with an empty `SKILLS` list. Each entry needs `id`, `title`, `body`
(≤1,200 chars: triage order, symptom→cause, reversible changes, never-do, verify-after), `kinds`, `keywords`.
Adding entries needs no other code change; `skills.test.ts` checks length/uniqueness/selection.

## 3. run_script tool + its risk gate — DONE 2026-10-19
Built as `packages/core/src/tools/script.ts`: comments, the shebang and `set` lines are skipped for
classification, the tool's autonomy cap is read-only, python3 is always high, and approvers see the script
itself. The findings below were the brief:
- `classifyShellCommand` already handles multi-line scripts (splits on newlines, applies whole-line checks,
  fails closed on loops/`$(...)`): probe showed read-only script → read_only, a `systemctl restart` line →
  medium, `for` loop / `$(hostname)` → high (unparseable), heredoc write to /etc → high.
- Gap: comment lines (`# ...`) and `set -e`-style option lines classify as unknown → high; a script gate
  should treat them as no-ops for classification only.
- Planned shape: tool `run_script` (ssh, bash|sh|python3, ≤32 KB), transport `timeout -k` + quoted `-c`
  (not stdin — `sudo -S` uses it), tool auto-run cap `run_script: read_only` in `DEFAULT_TOOL_AUTO_CAPS`
  (packages/shared/src/autonomy.ts) so a script only auto-runs when every line is read-only; python never auto-runs.
- The core prompt already mentions run_script "when it is available", so nothing breaks while it is absent.

## 4. Phase 4 rule harvester, Learning UI and in-run self-check — DONE 2026-10-19
Built: `packages/core/src/learning/harvest.ts` (called after every denial and every failed automatic change),
the Learning page (`/learning`: switch off/on, delete, reset with undo), and `engine/self-check.ts` (verify
before concluding, a stuck note, and a pre-flight warning on the approval card). The brief follows:
Built: `signatureOf()`, `learned_rules` table, raise-only `learned` stage in assessRisk (rules are read and
applied, hits counted), within-turn denied-repeat block. Not built: the harvester that CREATES rules from
finished runs (denial ladder 2→raise one tier, 3 with ≥2 deciders/comments→block; failed auto changes ×2→ask),
the Learning UI page (list/disable/delete/reset with undo), and in-run self-check (pre-flight, stuck notes,
verify nudge). Until the harvester exists, rules can only be inserted directly; the stage is otherwise inert.

## 5. GitHub/GitLab read tool (Phase 7) — DONE 2026-10-19
Built as the `scm` tool (`packages/core/src/tools/scm.ts`): runs and condensed failed-job logs, PRs/MRs with
checks and files, commits, files, issues, releases; repo allowlist enforced before any request; GitHub job
logs followed through `followAllowedRedirect` to known log stores only. Targets form and connection test
included. The brief:
Built: `github`/`gitlab` target kinds and `KIND_META` entries (packages/shared/src/states.ts), `ScmConfig`
(baseUrl, repos allowlist, allowPrivateNetwork) in packages/db/src/schema/types.ts, and
`followAllowedRedirect()` in packages/core/src/tools/executors/http.ts (follows one https redirect to an
allowlisted host without credentials — needed because GitHub serves job logs via a redirect to blob storage).
Not built: the read-only `scm` tool (list/get runs, job logs condensed to error lines + tail, PRs/MRs with
checks and diff, commits, files, issues, releases; repo must match the allowlist), its registration, the
server create/test routes and the Targets form. Nothing can create a github/gitlab target yet.

## 6. Not started: Phase 6 cloud accounts, toolbox runner container, Phases 8–10
Phase 6 (AWS/GCP/Azure via sandboxed CLIs) needs the toolbox runner container from the Phase 5 design
(runners/runner_jobs tables, /runner Socket.IO protocol, apps/toolbox daemon, Dockerfile.toolbox) — not
built; Phase 5 shipped the observability connections through a guarded server-side HTTP client instead.
Phases 8 (knowledge/runbooks), 9 (reflection, lessons, feedback) and 10 (write operations through
connections) are not started. Designs for all of these are in the original plan.

## 7. Phase 9 automated reflection and lesson gate — DONE 2026-10-19
Built as `packages/core/src/learning/reflect.ts`: one tool-less review after a run with real work, a
deterministic gate, lessons kept in the `lessons` table with every verdict, shown on the Learning page.
Default is drafts; "Approve facts" auto-approves only observed facts with evidence and no commands. The brief:
Built: human feedback (thumbs, "Correct this" -> a pinned knowledge note scoped to the run's targets,
approved for admins / draft for members; "Save to knowledge"), run_feedback table (migration 0015).
Not built: the post-run LLM reflection job and the deterministic lesson gate that would auto-apply "safe"
lessons (design in the original plan, Phase 9) — corrections already cover the human-taught path.

## 8. Toolbox runner container (Phase 5 remainder) and everything that needs it — build separately
Stopped while writing the runner protocol (`packages/shared/src/runner.ts`). Not built: protocol schemas,
`runners`/`runner_jobs` tables, the core hub state machine, the `/runner` Socket.IO namespace, the
`apps/toolbox` daemon, `Dockerfile.toolbox`, compose/k8s wiring. Blocked on it: Phase 6 cloud accounts
(`cloud_cli` for aws/gcloud/az with tier-scoped short-lived credentials), git repo checkout, and the
Terraform plan/apply and repo commit/push parts of Phase 10. The Phase 0 hooks `ToolDef.runsIn` and
`ToolDef.binding` were only needed by these and were not added.
