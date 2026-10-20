# Upgrade programme — status (2026-10-01)

## Branches
- **main / dev** — fully built, tested features only. `dev` is where finished work lands; main is merged from it.
- **experiment** — everything on dev **plus** the half-built groundwork below. Continue unfinished work there,
  then bring each piece to dev once it is complete and tested.

## Done (on dev and main)
- **Security foundation (Phase 0):** run scope enforced server-side, authenticated live stream, secret-file
  reads need approval, approval roles / second person / expiry enforced, admin-gated configuration,
  per-turn session budgets, output limits, target fingerprint re-checked before an approved call runs,
  token redaction (GitHub/GitLab/AWS/GCP/JWT patterns), one definition of the built-in agents.
- **Run-history retention (Phase 1):** automatic clean-up after 7 / 15 / 30 days (or custom), image-only
  clean-up, "Clean up now" with preview, pinned runs and runs with open health issues kept, real disk reclaim
  (incremental auto-vacuum + WAL truncate), storage meter and low-disk warning in Settings.
- **Autonomy (Phase 2):** configurable auto-run ceiling per project/agent, prod and trigger caps (high never
  auto-runs, forbidden never runs), Settings › Autonomy matrix, Agents editor, audit log.
- **Senior DevOps/SRE persona (Phase 3, part):** core prompt covers Linux, Kubernetes, clouds, Terraform/Helm,
  git, CI/CD, databases, networking, observability; kind-aware health scans; context-size guard (elides old
  outputs, then folds the oldest exchanges into a recap).
- **Within-turn repeat block (Phase 4, part):** an action denied earlier in the same turn is refused instead
  of asking again (uses the command signature, stored on every tool call).
- **Observability connections (Phase 5):** Prometheus, Alertmanager, Loki, Elasticsearch/OpenSearch, Grafana
  (PromQL via datasource proxy); `query_metrics`, `query_logs`, `alerts` tools through an SSRF-guarded HTTP
  client; Alertmanager silences create/expire (gated: medium, forbidden without matchers or over 24h).
- **Knowledge (Phase 8):** runbooks, notes and facts with scopes, pinning, drafts approved by an admin, full-text
  search; approved documents reach every matching run.
- **Feedback (Phase 9, part):** thumbs up/down, "Correct this" (becomes a knowledge note), "Save to knowledge".

## Finished in the engine wrap-up (2026-10-19, on dev; experiment now has the same code)
- **Learned enforcement:** the harvester (denials and failed automatic changes become raise-only rules), the
  Learning page, and the in-run self-check (verify, stuck, pre-flight).
- **Domain playbooks:** thirteen of them, chosen per run.
- **GitHub/GitLab:** the read-only `scm` tool, routes and Targets form.
- **Also built:** env-variable prefix classification, `run_script` with its script gate, post-run reflection
  with a deterministic lesson gate, and a suspect ranking learned from confirmed causes.

## Not started
Parked until stakeholders confirm the setup (see `next-version-runner-credential-less-access.md`): Phase 6 cloud
accounts and the toolbox runner container, Phase 7 repo checkout, Phase 10 write operations (Terraform apply,
repo writes). Details in `deferred-items.md`.
