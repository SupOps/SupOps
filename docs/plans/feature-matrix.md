# Feature matrix: SupOps against Datadog, Dynatrace, Keep, HolmesGPT and CodeXray

**Date and scope:** written 2026-10-16. It covers every feature these platforms have that matters to an
AIOps / AI-SRE tool.

**Sources:**
- Keep and HolmesGPT source code: Keep studied with REA on its UI, see [keep-study.md](keep-study.md).
- Datadog and Dynatrace public documentation.
- CodeXray's public site and docs (closed source), see [codexray-study.md](codexray-study.md).
- REA on SupOps itself, see [rea-audit.md](rea-audit.md).

**The rule:** whatever another platform does that SupOps lacks, or does better, comes into SupOps,
except collecting telemetry ourselves (agents, APM, browser/mobile monitoring, profiling, our own
storage), which the project owner chose to skip.
- SupOps reads the backends people already run.
- Every row says what we do and why. "Skip" always gives the reason.

**Columns:**
- **SupOps today:** ✅ have · 🟡 partial · ❌ missing.
- **Best at it:** who does it best.
- **Decision:** what SupOps does about it, and in which phase. **E** marks the engine wrap-up of 2026-10-19; **S** the shadow-execution work.

## Alerts in

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Poll Alertmanager / Grafana / Prometheus | ✅ | — | Keep. Moves behind the provider interface. **P1.1** |
| Push webhooks (Alertmanager, Grafana, PagerDuty, Opsgenie, generic JSON) | ✅ P1 | Keep (~120 providers) | Build, with one token per integration, shown once and stored hashed. Keep instead shares one plaintext key. **P1.1–1.2** |
| "Send a test alert" when connecting a source | ✅ P1 | Keep (curl example) | Build: a button and a copyable curl command. **P1.2** |
| Duplicate removal (identity hash + content hash, minus ignored fields) | ✅ P1 | Keep | Build: exact repeats are counted, not stored, and the dedup ratio shows per source. **P1.3** |
| Flapping detection | ✅ P1 | none of them do it well | Build: N state changes in a window; triage waits until it settles. **P1.4** |
| Maintenance windows | ✅ P1 | Dynatrace / Keep | Build. Alerts are always stored, only muted; Keep drops them by default. Alertmanager-style matchers; when the window ends, still-firing alerts are processed again. **P1.5** |
| Ack that lapses when the alert fires again ("dispose on new alert") | ✅ P1 | Keep | Build into acknowledge. **P1.7** |
| Regex extraction rules with a log of what each matched or skipped | ✅ P1 | Keep | Build, with a safe regex engine and a time limit (Keep's has no protection against regexes that hang). **P1.8** |
| Lookup enrichment (CSV / service catalogue → owner, team, runbook) | ✅ P1 | Keep / Datadog Service Catalog | Build structured catalogue fields. **P1.8** |

## Grouping and incidents

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Built-in grouping (same host, map link, service, namespace) with a reason per join | ✅ | SupOps | Keep. Already better explained than Keep's. |
| User-defined correlation rules (match, group by, window, threshold, any/all, resolve on) | ✅ P1 | Keep / Datadog patterns | Build, with a live "alerts this would catch" preview. **P1.6** |
| Topology-connected grouping, wait-to-gather delay, merge cap | ✅ P5 | Dynatrace Davis | Build: about 3 minutes' delay, a 5-minute start gap and a 90-minute cap. **P5.2** |
| Root cause = most upstream abnormal component; a symptom is never the cause | ✅ P3 + P5 (prompt rule, symptom cap, likeliest origin from the map) | Dynatrace / Datadog Watchdog | Build as evidence for the LLM, and as a rule in the verdict. **P5.2, P3.5** |
| Incident: acknowledge, assign anyone, comments, one append-only timeline | ✅ P1 | Keep / Datadog | Build. Keep only lets you assign yourself and moves the assignee silently when someone changes the status; we won't. **P1.7** |
| Merge and split | ✅ | — | Keep. Ours runs in a single transaction (Keep's split doesn't). |
| AI-suggested grouping: review, drag between groups, accept | 🟡 P5: rule-based suggestions with reasons, merge or dismiss (remembered); no drag-and-drop or learned suggestions yet | Keep (enterprise) | Build after P3, with corrections fed back into rules (Keep never reads its feedback back). **P5** |

## Notifications, routing and workflows

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Slack posting, threaded per incident | ✅ P2 | Datadog / Keep | Build. **P2.1** |
| Teams, email, signed webhook, PagerDuty, Opsgenie | ✅ P2 | Keep / CodeXray | Build. **P2.1** |
| Routing by severity / service / team, with quiet hours | ✅ P2 | Datadog On-Call | Build. **P2.2** |
| Writeback (PagerDuty note, Slack thread, acknowledge both ways) | ✅ P2 | HolmesGPT / Keep | Build. **P2.3** |
| Workflows (trigger → steps) | ✅ P2 | Keep / Datadog Workflow Automation | Build. Steps are read-only or notify; anything that changes something goes through approvals. Runs only by POST (Keep's GET runs the workflow), are pinned to a revision, and a single step can be tested on its own. **P2.4** |
| On-call schedules and escalation policies | ❌ | Datadog On-Call / PagerDuty | Integrate with PagerDuty/Opsgenie rather than rebuilding paging. Escalation through routing rules. Reason: phone/SMS paging needs carrier services a self-hosted tool can't promise. **P2** |

## Investigation (the AI)

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Tool loop with approvals and risk tiers | ✅ (5 stages that only raise the tier, trusted commands) | **SupOps** | Keep. Ahead of all of them. |
| MCP servers as toolsets, with a health check | ✅ P3 | HolmesGPT | Build. Every MCP tool waits for approval until an admin marks it read-only. **P3.1** |
| Traces (Tempo, Jaeger, SigNoz) | ✅ P3 + P5 (SigNoz not yet tried against a live instance) | HolmesGPT / CodeXray | Build `query_traces`. **P3.2, P5.7** |
| Docker targets | ✅ P3 (docker tool on SSH machines) | HolmesGPT | Build. **P3.2** |
| Long output kept in full, read with grep/offset | ✅ P3 | HolmesGPT | Build `read_output`. **P3.3** |
| Summarising old history near the context limit | ✅ P3 | HolmesGPT | Build an LLM summary, used only if it is smaller. **P3.4** |
| Plan / todo list shown live | ✅ P3 | HolmesGPT | Build. **P3.5** |
| Hypotheses (confirmed / ruled out) + blast radius + "inconclusive" | ✅ P3 | Datadog Bits, HolmesGPT | Build. **P3.5** |
| Parallel read-only calls | ✅ P3 | HolmesGPT | Build. **P3.6** |
| Tells the model which integrations are missing or failing | ✅ P3 | HolmesGPT | Build. **P3.7** |
| Runbooks matched to alerts, with steps reported back | ✅ P3 | HolmesGPT skills | Build matchers. **P3.8** |
| Learning from corrections | ✅ E: corrections → notes; denials and failed changes → raise-only rules (Learning page); lessons after each run through a code gate; learned suspect ranking from confirmed causes | — | Built in the engine wrap-up. Learning only ever makes SupOps stricter, or reorders suggestions. |
| Domain playbooks (per technology, chosen per run) | ✅ E: 13 playbooks, at most four per run | HolmesGPT toolsets / skills | Built. |
| Several steps in one approval (scripts) | ✅ E: `run_script`, every line judged; runs alone only when all lines are read-only | — | Built. |
| Self-check (verify before concluding, notice loops, look before changing) | ✅ E | — | Built from recorded facts, never the model's own claims. |
| GitHub / GitLab: CI runs and failed-job logs, PRs/MRs, commits, files | ✅ E: read-only `scm` tool, repo allowlist | HolmesGPT (GitHub toolset), Datadog CI Visibility | Built. |
| Shadow execution: judge a command by observed real impact, not just its text (dry-runs, script detonation, target-side sandbox) | ✅ S: raise-only `observed` stage; apt/systemctl/kubectl dry-runs + run_script detonation + bwrap target-side shadow; TOCTOU re-check | none of them do this | Build. Detonation/shadow are code-only pending Docker/root + a security review. **S** |
| Live call copilot + client report | ✅ | **SupOps** | Keep. None of the others have it. |

## Measuring accuracy

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Diagnosis test set, LLM judge, pass rate per model | ✅ P4 (30 cases, scripted smoke case in CI) | HolmesGPT (150+ cases) | Build ~30 cases from recorded tool output, so no infrastructure is needed (HolmesGPT needs a live cluster). **P4** |
| Command-risk test set | ✅ (148 commands, fuzz, parity) | **SupOps** | Keep. |

## Metrics intelligence

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Forecasting (trend + daily/weekly pattern, band, backtest) | ✅ | Datadog seasonal forecast | Keep. Same class of method. |
| Anomaly detection (median/MAD, same time of day) | ✅ + P5 self-adjusting thresholds | Datadog agile/robust | Keep, and add Dynatrace self-adjusting thresholds (7-day P99 + n×IQR, 3 of 5 minutes). **P5.3** |
| SLOs and multi-window burn-rate alerts | ✅ P5 | Datadog / Dynatrace | Build at 14.4 / 6 / 3. **P5.4** |
| Change tracking (deploys, config, flags) as cause candidates | ✅ P5 | Datadog Change Tracking | Build. **P5.1** |
| Deploy verdict: before/after window of latency vs SLO, CPU (flag >15%), memory and error logs; only what changed is shown, clean releases show "—" | ✅ P5 | CodeXray | Build on change tracking, detected without webhooks (new ReplicaSet / image change). **P5.1** |
| SLO-driven incidents: one per service, severity changes in place, affected-requests % and budget used shown | 🟡 P5: burn alerts arrive as alerts and group per service; no affected-requests % yet | CodeXray | Build as an option next to alert-driven incidents. **P5.4** |
| Per-service health page: request rate, errors, response time, change markers, SLO, owner | ✅ P5 | CodeXray / Datadog APM | Build from Prometheus / span metrics. **P5.6** |
| Error grouping (type + top frame + message) with first-seen | ✅ P5 | CodeXray / Datadog Error Tracking | Build from traces and logs. **P5.7** |
| Log pattern clustering | ✅ P5 (Drain, Logs view) | Datadog Log Patterns / CodeXray | Build a Drain tree with counts per time bucket. Add a Patterns view: a sparkline and share of volume per pattern, "new since last deploy" and "×N vs before", a "show similar" link, and alerts on a pattern's count. **P5.10** |
| Scheduled HTTP/DNS/TLS checks | ✅ P5 | CodeXray / Datadog Synthetics | Build schedules. Read blackbox_exporter when present. Pass / Partial / Fail / No data, a last-5-runs bar, and an SLA strip for 1 hour / 24 hours / 7 days (≥99% green, 95–99% amber). Browser journeys skipped (they need a fleet of headless browsers). **P5.8** |
| Database insights | ✅ P5 (exporters: connections, lag, long transactions, top queries, Redis memory/evictions/hit rate) | CodeXray / Datadog DBM | Build from existing exporters: queries ranked by total time, % of connections blocked on locks, Redis hit ratio. **P5.9** |
| Node pressure signals: PSI, TCP retransmits, OOM risk (~80% sustained memory is the danger zone, ~95% means OOM is close) | ✅ P5 | CodeXray | Add as built-in watch signals and evidence checks. **P5.9** |
| Daily digest (what fired, what changed, what's trending toward a limit) | ✅ P2 | CodeXray | Build on notification channels. **P2.2** |
| Per-integration toggles: alerts / incidents / deploys | 🟡 P2: per-route event toggles | CodeXray | Event toggles per route are in. Deploy events come with change tracking. **P5.1** |
| APM agents, browser/mobile monitoring, profiling, eBPF collection, our own storage | ❌ | CodeXray / Datadog / Dynatrace | **Skip:** the owner chose not to collect telemetry. SupOps reads what is collected. |
| API security (OWASP, PII, shadow APIs) | ❌ | CodeXray | **Skip:** a separate product category, not operations. |

## Running SupOps

| Feature | SupOps today | Best at it | Decision |
|---|---|---|---|
| Compression, caching, security headers, tight CORS | ❌ → ✅ in P0 | — | Fixed in P0 (found by REA). |
| Push instead of polling | ❌ → ✅ in P0 | — | Fixed in P0 (found by REA). |
| Backups | ✅ P6: scheduled online backups, retention, Back up now, documented restore | — | Build. **P6.1** |
| `/metrics` for SupOps itself | ✅ P6: runs, queue, approvals, incidents, model latency/tokens/errors, alert reads, SLOs, synthetics, backups | — | Build. **P6.2** |
| API keys for machines, and an MCP server exposing SupOps | ✅ P6: hashed, scoped keys in the maker's name, revoke/expiry; MCP server whose investigations are always unattended | Keep (API keys), HolmesGPT (server API) | Build. **P6.3** |
| SSO, two-factor login, session revocation, login throttling, project-level access | ❌ | Keep (some enterprise-only) | **Parked** by the owner. Raised again before outside clients use SupOps. |
