# CodeXray: product study for SupOps

**Studied:** CodeXray Observability and API Security (Codifinary Technologies), a commercial, closed-source product with no published licence. **Date:** 2026-10-16.

**Method:** Only public pages. I captured each page's accessibility tree with REA `capture_browser_scenario` (headless Chromium) and read the text. That covered about 45 pages of docs.codexray.io: the introduction, architecture, requirements, Instances, Logs, Traces, Databases, End-User Monitoring, Profiling, Alerts, Incidents, Synthetics, Dashboards, access control, application grouping and API Security. I did not decompile or download anything, sign up, log in, or submit a form. Nothing is copied; this describes behaviour so we can design our own.

**Limits:**
- www.codexray.io returned **403 (bot protection)** to the headless browser. I did not try to get around it. WebFetch got only the title ("AI-Guided Observability + API Security"), because the page is rendered in the browser. So I saw no marketing claims, demo assets or network list.
- No docs page covers CodeXAI. What is known comes from the sizing tables and a few lines elsewhere.
- Everything here is documented behaviour, not observed product behaviour.

**In short:**
- CodeXray collects telemetry with OTel and eBPF through its own agents and stores it in ClickHouse, keeping 30 days hot.
- Every service ("application") has the same tabs: Overview, Traces, Logs, Runtime, Profiling, Deployments and DB Insights.
- Its triage flow is: RED anomaly → which signal dominates? Errors lead to fingerprinted error clusters, latency to a breakdown into app, DB and dependency time, and a traffic shift to change correlation (deploy, config, upstream).

---

## Area by area

### 1. APM / RED overview (per-service Overview tab)
- **Header:**
  - status badge OK/WARNING/CRITICAL ("from SLOs, errors and resource pressure")
  - Requests, mean latency, Errors %, Restarts
  - **Upstream healthy/total** and **Instances healthy/desired**
  - I/O load and DNS latency
  - any KPI past its threshold turns red
- **Cards:**
  - CPU donut
  - requests and errors chart
  - disk latency
  - memory sparkline
  - **OOM risk LOW/MED/HIGH**, from the memory trend against the limit
  - IOPS
  - TCP connections
  - p50/75/95/99
- **Bottom of the page:**
  - **Top consumers**: callers with their error rate and percentiles
  - mini service map
  - **Error traces** and **Slow traces** tables
- Header icons show firing alerts (bell) and open incidents (triangle), next to an **SLO Config** button.

**SupOps: build** (from Prometheus). See "Per-service health page".

### 2. Service map
Built from real traffic (eBPF plus traces). There is a full Topology view, a mini map per service, and a per-instance connection map (solid line = active, dashed = recently closed). Nodes can be filtered or coloured by application category.

**SupOps: already have** a map built from documents and confirmed by live checks. **Build:** the mini map on the service page with each neighbour's health, a category filter, and the upstream healthy/total count.

### 3. Traces
- Each service has a scatter chart: time against log-scale duration, coloured by status.
- **Drag a rectangle** and every chart and list below narrows to it.
- Filters: All, Error and Slow. Each trace opens in a waterfall or tree view.
- **Compare Attributes** contrasts the selection with a baseline ("93% of selected have flag X vs 12%").
- Health-check and probe traffic is excluded by default.

**SupOps: skip** (no trace collection). If a Tempo or Jaeger connection is added later, read error and slow traces from it and link to Grafana.

### 4. Logs and patterns
- Logs come from container stdout through the node agent or from OTLP; a Source selector switches between them.
- **Patterns are clustered on the host**, and each line carries `pattern.hash`.
- The Logs tab has:
  - a severity-stacked volume chart
  - an "Error only" filter
  - **List** and **Patterns** views. Each pattern row has a sparkline and its **% of volume** (example: one pattern = 96%).
  - a detail panel with service, host and container, plus **"Show similar messages (N)"**
- Documented workflow: Error only → zoom into the spike → Patterns. A new pattern, or one whose count jumped, is the cause.

**SupOps: already have the core.** `log_errors` on Loki and Elasticsearch clusters lines with `clusterLogLines` and compares against the previous 15 minutes. **Build:** a Patterns view (see "Error grouping").

### 5. Error intelligence
- Errors are "clustered automatically by fingerprint" into top patterns, each with the endpoints it affects.
- Latency is broken down into app, DB and dependency time.
- Browser errors are grouped by name: events, impacted users and last seen, then occurrences with a stack trace and breadcrumbs.

**SupOps: build** from logs plus 5xx metrics.

### 6. Databases
**Consumer view, per service, from OTel spans:**
- KPIs: distinct query patterns, executions, rate and average time
- a **Slow Queries** table: fingerprint, operation, entity, P99, average, QPM, max and executions
- a row expands to a trace showing **DB time vs total time**
- advice: rank by **executions × average** (total time spent)

**Engine view, from an agent with a read-only user that polls engine statistics:**
- **SQL fleet list:** up/down, query rate and duration, CPU and memory, connections, **% blocked on locks**, and the CPU/Lock/IO wait mix
- **SQL detail page:**
  - Top Queries from the engine's own stats, including currently running executions and the longest one
  - a vital-signs grid: disk latency, IOPS, queue depth
  - Active Connections by wait group, wait event, SQL, user and client
- **Redis:** hit ratio as the headline, top commands by **share of command time**, the slow log, fragmentation, and evicted counts

**SupOps: build** the engine view from exporters. **Skip** the consumer view, which needs spans.

### 7. Infrastructure (Runtime tabs)
- **CPU:** usage, **CPU delay** (runnable but waiting), throttling ("can make p99 10× worse with little change in usage"), node CPU, and the top consumers on the node.
- **Memory:** RSS, and node unreclaimable memory (**~80% sustained = danger, 95% = OOM imminent**), with a stacked chart of which containers on the node use it.
- **Network:** RTT, TCP connect latency (if RTT is flat but connect latency is up, the peer is slow), connection churn, and **retransmissions** (any non-zero baseline = loss).
- **DNS:** NXDOMAIN and SERVFAIL per domain. Healthy cluster DNS takes 1–5 ms; 30 ms or more is degraded.

**SupOps: mostly already have** (CPU, memory, disk, forecasts, OOM, restarts, crashloops, throttling). **Build** from node-exporter and cAdvisor: PSI pressure as our stand-in for CPU delay, TCP retransmits, top consumers on the node, and the 80%/95% guidance. **Skip** DNS and per-peer RTT, which need eBPF.

### 8. End-user monitoring
A browser agent reports page loads, Web Vitals and errors, with errors grouped by name and impacted users.

**SupOps: skip** (needs an agent and storage).

### 9. Synthetic monitoring
- **A job** has a name, an interval (5m, 10m, 15m, 1h, 3h, 12h, 1d), a target URL and steps: goto, click, type, upload, wait and measure.
- **Run statuses:** Pass, **Partial** (amber, "a signal to look, not an outage"), Fail, and No data.
- **Web Vitals grades:** FCP ≤ 1.8/3 s, LCP ≤ 2.5/4 s, CLS ≤ 0.1/0.25.
- **Jobs list:**
  - Total, Healthy, Failed and Running cards
  - a **last-5-runs mini bar** (colour = result, height = latency)
  - pause, Run now and Run all
- **Job page:**
  - steps that expand to show the first failing step and its error
  - a honeycomb of the last 7, 15 or 30 runs
  - an **SLA summary for the last hour, 24 h and week**: green above 99%, amber 95–99%, red below 95%
- History is kept for 30 days. Viewers don't see the action buttons at all.

**SupOps: build** (see "Synthetic checks").

### 10. Alerts
- **25 built-in rules**, all on by default, covering CPU, memory, availability and deploy stuck, network, storage, log errors, JVM/.NET, and **SLO burn rate (fast, slow, daily)**.
- **Custom rules:** wrap a built-in rule, plain PromQL, or **log pattern** (fires on the pattern count, not on each line).
- **Rule fields:**
  - warning or critical
  - `for` and **`keep_firing_for`**
  - **`repeat_interval`** (5m on built-ins)
  - scope: an app, a category or all
  - summary tokens `{value}` and `{count}`
- A bulk API takes up to 500 rules per request.
- **Channels** group Slack, Teams, Webhook and PagerDuty, each with **Alerts / Incidents / Deploy toggles**. A rule with no channel notifies nobody.
- **Fired-alert drawer:** summary, a **sample log line**, a **fire/resolve frequency chart**, and Suppress vs Resolve.

**SupOps: already have** imports and silences; evaluation stays in the backends. **Build:** fire/resolve history per alert, a sample log line on log alerts, and per-channel event toggles.

### 11. Incidents
- Incidents are **only automatic SLO breaches**: no manual create, ack or close. At most one is open per app; severity moves in place by burn rate and the incident resolves itself.
- **List:** Critical and Warning counters, with Resolved hidden. Each row shows availability and latency compliance, **affected requests %** and **consumed error budget %**, which the docs suggest sorting by.
- **Detail:**
  - an SLO table in plain words ("99% of requests should not fail: 76%")
  - a **latency heatmap**: steady vs bursty, where bursty means retries or backpressure
  - a Traces tab limited to the incident window

**SupOps: already have** incidents built from alerts and forecasts, automatic triage and a timeline. **Build:** SLOs as an extra incident source, plus the budget and affected columns.

### 12. SLOs
Each app has an Availability SLO (objective %) and a Latency SLO (objective % plus a threshold, e.g. **99% under 5 s**). Burn rate is computed on rolling windows with fast, slow and daily rules. A change applies on the next evaluation only.

**SupOps: build**, computed with PromQL over request metrics that already exist (or Sloth/Pyrra recording rules). We store only the objective.

### 13. Deployment markers
- **Detected with no webhook:** new ReplicaSet, image tag or digest change, binary hash change.
- **Deployments tab:** each row has a hash, image tag, age and an **automatic summary** comparing a baseline window before the deploy with one after it:
  - latency against the SLO ("85% under 5000 ms, objective 99%")
  - CPU Δ, flagged at **> ~15%**
  - memory Δ
  - log errors, flagged on a "statistically significant" rise ("+3900%")
- **Display:** only changed signals appear, "—" means clean, and each row is striped green, yellow or red.
- Deploy events also go to channels.

**SupOps: partly have.** The `deploys` check covers the last 2 h, and incident timelines show deploys. **Build:** see "Deploy markers".

### 14. Dashboards
Four panel types, a query builder or PromQL, and formula templates.

**SupOps: skip.** Link to Grafana.

### 15. RBAC, tenancy and grouping
- Tenant (data boundary) → project. Roles are Admin, Editor and Viewer, with permission scopes and an audit log, and the last admin can't demote themselves. SSO is Entra ID with role mapping.
- **Application categories:** a service can be in several. Status rolls up **worst-case**, and each category has its own dashboard and alert scope.
- **Custom applications:** glob patterns on the instance name.

**SupOps: already have** projects, five roles and an audit log. **Build:** service categories with the worst-case rollup. **Skip** SSO for now.

### 16. API Security (a separate product)
API discovery from Postman, HAR or SDK traffic, OWASP checks, and a **0–100 risk score** with weighted factors and bands, each with a time to fix (80+ = within 24 h).

**SupOps: skip.** The banded score with a time to fix is a format worth reusing for health findings.

### 17. AI / CodeXAI
What is public:
- **"RCA on fire"** is an option on custom rules. When the rule fires, a plain-English root cause appears in the alert drawer shortly after the notification. It correlates log patterns, nearby deploys, upstream and downstream trace errors, and CPU, memory and network changes. The docs advise using it only on critical rules.
- AI triage is described as "(soon)".
- "Daily highlights/lowlights" summaries.
- Sizing tables list optional **"CodeXAI: correlation & causation"** (a GPU node) and **"Anomalies & Forecasting"**, sized for about **200 RCA runs a day**.

**SupOps: already have more** (investigations, automatic triage from an evidence pack, anomalies, forecasts). **Build:** a short RCA summary from the triage run on the incident and alert, and a daily digest.

---

## Concrete designs for SupOps (all read from existing backends)

### Per-service health page
- **Badge:** the worst of SLO state, error rate and resource pressure, next to clickable alert and incident counts and an SLO button.
- **KPIs from PromQL:** requests per second, error %, p50/95/99, restarts, **ready/desired replicas**, and **upstream healthy/total** (from the map).
- **Charts:** requests vs errors with **deploy markers**, and latency percentiles.
- **Cards:** CPU (with throttling and PSI), memory with **OOM risk** (our forecast against the limit), and disk.
- **Lower half:** mini map, top error groups, recent deploys with their verdicts, and open incidents.
- **Sourcing:** every number names its connection and query and links to Grafana Explore. A missing metric shows as "not available", never zero.

### Error grouping
- **Source:** Loki or Elasticsearch error lines plus 5xx by route, fingerprinted with `clusterLogLines` (IDs and numbers masked).
- **Each group shows:**
  - template, count and **share of the service's errors**
  - sparkline, first seen and last seen
  - flags for **"new since last deploy"** and "×N vs the previous window"
  - one sample line, and **"show similar"**, which opens the matching query
- **Ordering:** new or spiking groups first, then by share. We store fingerprints and counts only.
- **Triage branches on the dominant signal:** errors → groups; latency → saturation, DB and dependencies; traffic → deploys and config.

### Synthetic checks
- **First step:** read blackbox_exporter's `probe_success`, `probe_duration_seconds` and certificate expiry.
- **Optional built-in HTTP/TLS check:** URL, expected status or text, and an interval of 1m, 5m, 15m or 1h. Keep only pass/fail and timing, for 30 days.
- **Show:**
  - a last-5 mini bar per check
  - Healthy, Failed and Paused counts
  - SLA for the last hour, 24 h and week, coloured green above 99%, amber 95–99% and red below 95%
  - the error text
  - **Partial** (slow, or a certificate expiring within 14 days) as amber
- **Skip:** browser journeys and Web Vitals.

### Deploy markers
- **Detection:** changes to `kube_deployment_status_observed_generation` (we already have this), image tags in `kube_pod_container_info`, and `kube_replicaset_created`. Grafana annotations or Git releases can come later.
- **Verdict per deploy:** compare equal windows before and after (default 30 min):
  - error % or SLO compliance
  - p99
  - CPU Δ (flag above 15%)
  - memory Δ
  - error-log ratio, with a minimum count
  - **new error groups**
- **Display:** only show the signals that changed, show "—" when clean, and use green, yellow and red stripes.
- **Linking:**
  - The evidence pack names the nearest earlier deploy of the service *or its upstreams* as the prime suspect.
  - An SLO burn that starts soon after a deploy says so in the incident.

### DB insights (engine view)
- **Sources:** postgres_exporter (`pg_stat_statements` and activity), mysqld_exporter (digests) and redis_exporter.
- **Fleet list:** up/down, QPS, average duration, connections against max, **% waiting on locks**, and the wait mix where available.
- **Detail page:**
  - **top queries by total time** (calls × mean), with calls, mean and max
  - connections by state, wait event, user and client
  - replication lag and cache hit ratio
  - for Redis: hit ratio, evictions, fragmentation and top commands by share
- **Deeper looks:** live `pg_stat_activity` or `EXPLAIN` stays a run tool that needs approval.

---

## Verdicts

| Area | SupOps |
|---|---|
| RED / service page | Build |
| Service map | Have; add mini map, categories |
| Traces | Skip (later read-only Tempo/Jaeger) |
| Logs and patterns | Have core; build Patterns view |
| Error grouping | Build |
| Databases | Build engine view from exporters |
| Infrastructure | Mostly have; add PSI, retransmits, top consumers |
| End-user monitoring, Profiling | Skip (need agents) |
| Synthetics | Build (blackbox first) |
| Alerts | Have; add history, sample log, channel toggles |
| Incidents | Have; add SLO source, budget columns |
| SLOs | Build |
| Deploy markers | Partly have; build verdicts |
| Dashboards | Skip (Grafana) |
| RBAC / tenancy | Have; add categories |
| API security | Skip |
| AI / CodeXAI | Have more; add RCA summary, daily digest |
