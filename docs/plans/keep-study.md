# Keep alert pipeline: design study for SupOps

**Studied:** Keep (keephq) at commit `465e99152e7586fcbe4c2732213d31c5c28def4b`, MIT licence. The proprietary `ee/` folder was not opened or used. Nothing here is copied code; it describes behaviour so we can write our own.

**Method:**
1. REA module tracing on `keep-ui`, using the retained application Evidence `ev_3d191437…0ec4`, `trace_application_feature` with string seeds, match `contains`, direction `outgoing`. I listed the seed-matched `javascript-module` paths per feature. Those lists are the "REA evidence" lines below.
2. I then read the key UI files and the matching FastAPI routes, SQLModel models and business-logic modules in `keep/api`, `keep/rulesengine` and `keep/topologies`.

**Limits:** Keep was not run (no docker here); all runtime behaviour is read from source. Seeds `grouping_criteria` and `webhook_markdown` matched nothing (the UI uses camelCase) and `ai/suggest` matched one module; those UI files were found via neighbouring seeds (`/rules`, `/providers`, `/incidents`).

**Keep's ingest order** (`process_event_task.py`): pre-format extraction → provider formatting into `AlertDto` → maintenance windows → dedup → save (with mapping and post-format extraction) → search index → workflows → correlation engine → push "poll" events to browsers.

---

## 1. Alert feed, facets, CEL search, presets (saved views)

**Screens and fields**
- `/alerts/feed` is a server-paginated table with a left facet panel.
- Static facets: severity, status, source, `incident.name`, dismissed.
- "Add Facet" opens a modal with name and property path, offering suggestions from fields seen in ingested alerts.
- Each facet value shows a count and an "Only" / "All" toggle, and has a "Filter values…" box. "Reset" clears everything.
- Above the table is a CEL input (placeholder `source.contains("kibana")`, Enter to apply). It has a query-builder mode, "Import from SQL" (turns a SQL WHERE into CEL), and "Save as preset".
- The preset form has:
  - name (required; an "AI" button generates one from the CEL)
  - Private, Noisy, and "counter shows firing only" switches
  - tags (create-on-type)
- Column visibility and order are stored per preset.

**Flow:** type CEL or click facets (clicks become CEL fragments synced to URL params); table and facet counts re-query; save as preset, which appears in the left nav with a live count. A "Noisy" preset plays a sound while any firing, non-dismissed alert matches it (`PresetsNoise.tsx` polls `/alerts/query` with `limit 0`).

**API**
- `POST /alerts/query` takes `{cel, limit, offset, sort…}` and returns `{limit, offset, count, results[AlertDto]}`. CEL is converted to SQL server-side.
- `POST /alerts/facets/options` takes `{cel, facet_queries:{facetId:cel}}` and returns `{facetId:[{display_name,value,matches_count}]}`.
- `GET /alerts/facets[/fields]`, `/preset` CRUD, `PUT /preset/{id}/column-config`.

**Data model**
- `Preset{id, tenant_id, name, created_by, is_private, is_noisy, counter_shows_firing_only, options:[{label,value}], tags}`.
- The CEL query, SQL query and column config all live inside the untyped `options` label/value list.
- `AlertDto` has about 30 fixed fields (name, status, severity, lastReceived, firing/unresolved counters, service, source[], fingerprint, dismissed, dismissUntil, assignee, note, labels, enriched_fields, incident).

**Worth adopting:** facet counts recomputed under the current query; an "Only" shortcut per value; filter state in the URL; per-view column config and "firing only" counter; an opt-in alert for a saved view.

**Weaknesses**
- `Preset.name` is declared `unique=True` globally as well as unique per tenant.
- The preset options are an untyped bag (`options.find(label=="CEL")`).
- Every `POST /alerts/query` schedules `pull_data_from_providers` as a background task. Reading the feed triggers outbound polling.
- Users must learn CEL.

**REA evidence:** `features/filter/{facets-panel,facet-panel-server-side}.tsx`, `features/filter/store/{create-facets-store,use-queries-handler,use-query-params/use-query-params}.ts`, `app/(keep)/alerts/[id]/ui/{alert-table-alert-facets,alert-table-facet-types,alert-table-tab-panel-server-side,alerts}.tsx`, `widgets/alerts-table/ui/{alert-table,alert-table-server-side,ColumnSelection}.tsx`, `entities/presets/model/{usePresets,usePresetActions,usePresetColumnConfig,usePresetPolling}.ts`, `features/presets/presets-manager/ui/{alert-preset-manager,alerts-rules-builder}.tsx`, `features/presets/create-or-update-preset/ui/create-or-update-preset-form.tsx`, `features/presets/custom-preset-links/ui/PresetsNoise.tsx`.

## 2. Alert detail sidebar and actions (acknowledge, assign, dismiss, enrich)

**Screens and fields**
- The row menu (`alert-menu.tsx`): Run Workflow, History, Enrich, Self-Assign, View Alert (raw JSON), provider methods (e.g. the source's own "acknowledge"), Dismiss/Restore, Change Status, Correlate Incident.
- The sidebar shows all fields, linked incidents, an audit **timeline** (`/alerts/{fp}/audit`) and a "Related Services" topology mini-map.
- Change Status modal: status, reason, and a toggle "Disposing on new alerts" / "Keeping on new alerts" (default dispose).
- Dismiss modal: tabs "Dismiss Forever" / "Dismiss Until" (date-time, 15-minute steps), a comment, and the callout "This will dismiss the alert until an alert with the same fingerprint comes in."
- Enrich side panel: free key/value pairs. Removing a key calls `/alerts/unenrich`.

**API**
- `POST /alerts/{fingerprint}/assign/{last_received}?unassign=` assigns to the **caller only**. It sets `assignee` and `assignees{lastReceived:email}`, sets status `acknowledged` if no status is set, and sends an email.
- `POST /alerts/enrich?dispose_on_new_alert=` takes `{fingerprint, enrichments:{k:str}}`. If `dismissed=="true"` it forces status `suppressed`.
- `POST /alerts/batch_enrich` takes `{fingerprints|cel, enrichments}`.
- Also `/alerts/unenrich`, `/alerts/enrich/note`, `/alerts/{fp}/history`, `/alerts/{fp}/audit`.

**Data model**
- Enrichments are a separate per-fingerprint JSON document, merged over the alert on read.
- `dispose_on_new_alert` marks an enrichment as temporary: it is wiped when the next event with that fingerprint arrives.
- Alert statuses: firing, resolved, acknowledged, suppressed, pending, maintenance.

**Worth adopting:** "dispose on new alert", an ack or status override that ends automatically when the problem re-fires (the right default for ack); batch actions by fingerprint list or query; a per-alert audit timeline with actors.

**Weaknesses**
- Assignment is self-only and protected by a *read* permission (the code comment admits it).
- Dismiss UX:
  - "Dismiss Forever" contradicts the callout ("until the same fingerprint comes in").
  - The dismiss comment overwrites the alert's `note` field.
  - In batch mode, dismiss-vs-restore is decided by `alerts[0].dismissed` alone.
- Enrichment values must be strings.

**REA evidence:** `features/alerts/dismiss-alert/ui/alert-dismiss-modal.tsx`, `entities/alerts/model/useAlerts.ts`, `features/alerts/alert-assign-ticket/ui/alert-assign-ticket-modal.tsx`, `widgets/alerts-table/ui/alert-assignee.tsx`, `widgets/alerts-table/lib/alert-table-utils.tsx`, `features/alerts/alert-menu/ui/alert-menu.tsx`, `features/alerts/alert-detail-sidebar/ui/{alert-sidebar,alert-timeline,alert-sidebar-incidents}.tsx`.

## 3. Correlation rules builder

**Screens and fields** (sidebar form, `CorrelationForm.tsx`):
- Name (required); timeframe (default 5, unit seconds to days, max 90 days); group-by attributes; threshold (default 1); assignee.
- Incident name template (`Incident on hosts {{ alert.host }}`, values comma-joined) and prefix (`INC` gives `INC-1 - …`).
- Resolve on: never / all / first / last alert resolved. Create on: any / all conditions met.
- Switches: "require manual approve", multi-level correlation (plus property name).
- A query builder of OR'd groups of AND'd conditions, with a live "alerts found" badge (`useMatchingAlerts` queries alerts with the builder's CEL).

**API:** `GET/POST/PUT/DELETE /rules`; the body is a camelCase mirror of the model below, carrying both `sqlQuery` and `celQuery`.

**Engine** (`rulesengine.py`):
1. For each alert, every rule is evaluated by **splitting the CEL string on `") || ("`** into sub-rules.
2. The fingerprint is built from the group-by values.
3. The engine finds or creates an incident for `(rule, group fingerprint)` within the timeframe.
4. New incidents start `is_visible=False`.
5. An incident becomes visible when the alert count is at or above the threshold and either `create_on=any`, or `create_on=all` and every sub-rule has matched at least once in the incident's history.
6. With `require_approve`, the incident becomes a *candidate* that a user confirms or discards.

**Data model:** `Rule` holds the form fields above plus `definition` (SQL JSON) and `definition_cel`, `group_description`, `item_description` and a soft-delete flag.

**Worth adopting:** a live match count while editing; threshold plus "all groups seen" semantics (e.g. "DB alert AND app alert within 10 minutes"); hidden incidents that surface only past the threshold; an approval mode producing suggested incidents; title templates and a per-rule assignee.

**Weaknesses**
- Sub-rule detection by string split is fragile. A condition containing `) || (` breaks it.
- The rule stores both SQL and CEL forms, which can drift.
- A blank space in a field name silently skips the rule (only logged).
- The model's own TODO notes that every rule is evaluated against every alert.

**REA evidence:** `app/(keep)/rules/{page,client,CorrelationTable,GroupedByCel,flatten-cel-ast}.tsx|ts`, `app/(keep)/rules/CorrelationSidebar/{index,CorrelationForm,CorrelationGroups,RuleGroup,RuleFields,AlertsFoundBadge,CorrelationSubmission,DeleteRule}.tsx`, `…/CorrelationSidebar/{useMatchingAlerts,timeframe-constants,types}.ts`, `…/convert-cel-ast-to-query-builder-ast/*.ts`.

## 4. Incidents list and incident page

**Screens**
- List: facets; columns Status, Incident, Alerts, Sources, Involved Services, Assignee, Created At; bulk merge and delete; "Generate report"; a separate predicted (candidate) incidents table with Confirm and Discard.
- Incident page tabs: Alerts, Activity, Timeline, Topology, Workflows, plus an AI chat.
- The header has status and severity selects, ticket create/link, and provenance badges ("Created by topology correlation", "Created by deleted rule X").
- Incident form: Severity, Name (required), Summary ("What happened?"), Assignee, "Resolve when all alerts are resolved".
- "Same incident in the past" lets you link recurrences.

**Activity:** one feed merging audit entries (comment, statuschange, assign) with alert arrivals. It has a comment box at the top (rich-text Quill with @mention of users, `extractTaggedUsers`).

**Timeline:** a time-axis view of each alert's audit events, dot-coloured by severity.

**API**
- `POST /incidents/{id}/assign` (caller only); `/{id}/status` `{status, comment}`; `/{id}/severity`.
- `POST /incidents/{id}/comment` `{status, comment, tagged_users}`, reusing the status DTO, so a comment carries a status.
- `POST /incidents/merge` `{source_incident_ids, destination_incident_id}`; `POST /incidents/{id}/split` `{alert_fingerprints, destination_incident_id}`.
- Also `/{id}/alerts` (add/remove), `/{id}/enrich`, `/{id}/confirm`, `/{id}/future_incidents`, `/report`, `/facets*`.

**Data model**
- `Incident` notable fields: `running_number`, user and AI name/summary pairs, `assignee`, `severity`, `forced_severity`, `status` (firing, acknowledged, resolved, merged, deleted), `is_candidate`, `is_visible`, `rule_id`, `rule_fingerprint`, `incident_type` (manual, ai, rule, topology), `same_incident_in_the_past_id`, `merged_into_incident_id`, `merged_at`, `merged_by`.
- Comments, assignments and status changes are rows in the **alert audit table**, keyed by the incident id string. Mentions are a separate `CommentMention` table.

**Behaviour to note**
- Setting an incident to acknowledged or resolved writes that status onto **every alert** in it, with dispose-on-new-alert.
- It also **silently re-assigns the incident to whoever changed the status.**

**Worth adopting:** `merged_into` plus who and when; recurrence links; separate user-written and AI-written name and summary; provenance badges; @mentions; one activity stream mixing human actions and new alerts.

**Weaknesses:** split is two non-transactional calls (add, then delete) and needs an existing destination; merge raises `HTTPException("…")` with a string where the status code belongs; assign is self-only; status changes silently take over assignment; comments live in the alert audit table and require a status.

**REA evidence:** `app/(keep)/incidents/{page,layout,predicted-incidents-table}.tsx`, `app/(keep)/incidents/[id]/{incident-header,incident-overview,incident-tabs-navigation,link-ticket-modal,create-ticket-modal}.tsx`, `…/[id]/activity/{incident-activity.tsx,lib/extractTaggedUsers.ts,ui/IncidentActivityItem.tsx,ui/IncidentCommentInput.tsx}`, `…/[id]/timeline/incident-timeline.tsx`, `…/[id]/alerts/{incident-alerts,incident-alert-actions,incident-alert-action-tray}.tsx`, `entities/incidents/{api/incidents.ts,model/models.ts,model/useIncidentActions.tsx}`, `features/incidents/{merge-incidents/ui/merge-incidents-modal,split-incident-alerts/ui/split-incident-alerts-modal,change-incident-status/ui/incident-change-status-select,change-incident-severity/ui/incident-change-severity-select,create-or-update-incident/ui/create-or-update-incident-form,same-incidents-in-the-past/ui/*,incident-list/ui/incidents-table}.tsx`.

## 5. Workflows (builder, YAML, triggers, run history)

**Screens**
- The list shows tiles with a trigger badge, last runs, an enable/disable switch, templates and upload.
- The builder has a React Flow canvas and toolbox, trigger and step editors (step tabs "select", "configure", "Test", so one step can be run alone), a YAML tab with JSON-schema validation, and an AI chat that proposes steps.
- The detail page has an overview, filtered executions, versions, providers used and secrets; the run page shows per-step logs. Manual runs take an inputs form or a chosen alert.

**YAML shape** (`yaml.schema.ts`)
- Top-level `workflow{id, name, description, disabled, debug, triggers[≥1], inputs, consts, strategy(nonparallel_with_retry|nonparallel|parallel), on-failure, owners, permissions[], services, steps[], actions[]}`.
- Triggers:
  - `manual`
  - `alert{filters[{key,value}], cel, only_on_change[]}`
  - `interval{value}`
  - `incident{events[created|updated|deleted…]}`
- Steps and actions: `{name, provider{type, config, with}, if, vars, condition[threshold|assert], foreach, continue, continue_on_error, on-failure}`, using Mustache templating.

**API**
- `POST /workflows` (create/update from YAML), `POST /workflows/{id}/run`, **`GET /workflows/{id}/run`** (runs, then redirects), `POST /workflows/test`, plus `/{id}/runs`, `/versions`, `/toggle`, `/secrets`.

**Data model:** `Workflow{workflow_raw (YAML), revision, is_disabled, provisioned}` plus versions; `WorkflowExecution{triggered_by, status, error, execution_time, results, is_test_run, workflow_revision}`; `WorkflowExecutionLog{timestamp, message, context}`; link tables to an alert fingerprint or incident.

**Worth adopting:** `only_on_change` (fire on a field transition, not every event); per-step test; revisions with executions pinned to one; executions linked back to the alert or incident; a permissions list for manual runs.

**Weaknesses**
- A GET endpoint with side effects: any link preview or crawler that follows a run URL executes the workflow.
- Steps can call any provider method with stored credentials. No power ceiling exists beyond RBAC on who edits.

**REA evidence:** `app/(keep)/workflows/{page,workflows.page,workflow-tile,workflow-menu,create-workflow-modal,upload-workflows-modal}.tsx`, `app/(keep)/workflows/[workflow_id]/{workflow-detail-page,workflow-executions-table,workflow-versions,workflow-secrets,workflow-providers}.tsx`, `…/runs/[workflow_execution_id]/page.tsx`, `widgets/workflow-builder/{workflow-builder,workflow-builder-widget}.tsx`, `features/workflows/builder/ui/{ReactFlowBuilder,WorkflowToolbox,Editor/StepEditor,Editor/TriggerEditor,Editor/StepTest}.tsx`, `entities/workflows/model/{yaml.schema,workflow-store,useWorkflowRevisions}.ts`, `entities/workflows/lib/{parser,validate-definition,getTriggerDescription}.ts`, `features/workflows/{manual-run-workflow,test-run,enable-disable,ai-assistant}/**`, `features/workflow-execution-results/ui/WorkflowExecutionResults.tsx`, `app/(keep)/incidents/[id]/workflows/*.tsx`.

## 6. Maintenance windows

**Form** (`create-or-update-maintenance-rule.tsx`):

| Field | Required | Default and notes |
| --- | --- | --- |
| Name | yes | |
| Description | no | |
| Matching query | yes | CEL builder, reused from presets |
| Ignore statuses | — | an **unlabelled** multi-select, default `[resolved, acknowledged]` |
| Start At | yes | inline date-time picker, default now, no past dates |
| End After | yes | number (default 5) plus minutes / hours / days; red note: "Please adjust when editing… calculated upon submit" |
| Suppress switch | — | default off; its label flips between "Alerts will not show in feed" and "Alerts will show in suppressed status" |
| Enabled switch | — | default on |

Submit needs a name, a CEL query and a start time. The table columns are Name, Description, Start Time, CEL, End Time, Enabled.

**API and model:** `GET/POST/PUT/DELETE /maintenance` with `{name, description, cel_query, start_time, duration_seconds, suppress, enabled, ignore_statuses}`; the row also stores the computed `end_time`.

**Behaviour**
- Runs before dedup. On a match (status not ignored) an audit row is written, then:
  - **suppress off: the event is dropped and never stored;**
  - suppress on: stored as `maintenance` (keeping `previous_status`) or `suppressed`.
- A periodic "recover" job restores the previous status after the window and re-runs workflows, correlation and preset notifications.

**Worth adopting:** an audit line on each affected alert naming the window; re-evaluation at window end so a still-firing alert surfaces.

**Weaknesses**
- The default mode discards alerts with no trace in the feed.
- Unknown fields silently mean "not in window"; no recurrence or match preview; duration is re-derived on edit.
- In the recover job, `pusher_client` is only bound when correlation found incidents. Preset notifications can raise a NameError that is caught and logged.

**REA evidence:** `app/(keep)/maintenance/{page,layout,maintenance,maintenance-rules-table,create-or-update-maintenance-rule}.tsx`, `app/(keep)/maintenance/model.ts`, `utils/hooks/useMaintenanceRules`.

## 7. Deduplication rules

**Form** (`DeduplicationSidebar.tsx`):
- Rule name (required).
- Description (required).
- Provider (required): type plus optional instance.
- Fingerprint fields (at least one required; options are the fields seen from that provider).
- Full deduplication switch.
- Ignore fields (multi-select).
- Callouts warn when editing a default rule or a provisioned one (read-only).

**Table:** Ingested, Dedup Ratio, and a 24-hour hourly Distribution sparkline per rule.

**Algorithm**
1. `fingerprint` = hash of the fingerprint fields.
2. `alert_hash` = sha256 of the alert minus the ignore fields (the default ignores only `lastReceived`).
3. Same fingerprint and same hash as the last one is a **full duplicate**: the event is dropped and counted.
4. Same fingerprint with a different hash is a **partial duplicate**: it is kept as an update of the same alert.
5. Every decision is written to `AlertDeduplicationEvent{rule_id, type, date_hour, provider}` for the stats.

**API:** `GET/POST/PUT/DELETE /deduplications`, `GET /deduplications/fields`.

**Data model:** `AlertDeduplicationRule{name, description, provider_id, provider_type, fingerprint_fields[], full_deduplication, ignore_fields[], priority(unused), enabled, is_provisioned}`.

**Worth adopting:** dedup ratio and sparkline per rule (they make the rule's value visible); field pickers fed by observed fields; provisioned rules shown read-only.

**Weaknesses**
- Rules are scoped only by provider; there is no label matcher.
- `priority` is unused.
- No flapping detection exists anywhere in Keep. Only provider-supplied `isFlapping` fields are passed through. `firingCounter` and `unresolvedCounter` exist but nothing acts on them.

**REA evidence:** `app/(keep)/deduplication/{DeduplicationSidebar,DeduplicationTable}.tsx`.

## 8. Mapping and extraction rules

**Extraction form**
- Name, Description, Priority ("Higher priority will be executed first").
- Pre/post formatting ("applied before or after the alert is standardized").
- Attribute to read (a template path).
- Regex (Python syntax). The UI validates that it has named groups: "Invalid regex pattern. Must contain named groups."
- Condition (CEL; empty or `*` means always).

**Mapping form**
- Name, Priority, Description.
- Type: CSV/XLSX upload or topology.
- Matchers built from the CSV headers, as OR'd groups of AND'd columns.
- "Enriched with" (the remaining columns).
- Multi-level mapping with a new property name and prefix to remove.

Both have a "Run" modal against a chosen alert, and an **executions history** page per rule showing each alert the rule matched or skipped.

**Behaviour**
- Extraction does `re.search(rule.regex, value)` and merges `groupdict()` into the alert, never overwriting `source`.
- Mapping finds the first CSV row whose matcher columns equal the alert's values and copies the other columns.
- Topology mapping copies service metadata (team, repository, and so on).

**API:** `/extraction` and `/mapping` CRUD, plus run endpoints and execution lists.

**Data model**
- `ExtractionRule{priority, pre, condition, attribute, regex, disabled}`.
- `MappingRule{priority, type(csv|topology), matchers[[col]], rows[dict], override, condition, is_multi_level, new_property_name, prefix_to_remove, is_provisioned}`.

**Worth adopting:** a per-rule execution log ("why didn't my rule apply?"); a test run against a real alert; named regex groups become fields; spreadsheet-driven enrichment.

**Weaknesses**
- A user-supplied regex runs unbounded on the ingest path (ReDoS).
- A CEL compile error inside the loop is not separated from "no match".

**REA evidence:** `app/(keep)/extraction/{page,extraction,extractions-table,create-or-update-extraction-rule,run-extraction-modal}.tsx`, `…/extraction/[rule_id]/executions/{page,[execution_id]/page}.tsx`, `app/(keep)/mapping/{page,mapping,rules-table,create-or-edit-mapping,run-mapping-modal,models}.tsx`, `…/mapping/[rule_id]/executions/**`, `utils/hooks/{useExtractionRules,useMappingRules}.ts`.

## 9. Providers page and webhook setup

**Screens**
- A tile grid with search, category filter and label filter.
- Tile states: installed, **linked** (alerts arrived from this provider type without it being installed), and coming soon.
- The connect form is generated from the provider's config schema (sensitive, hint, required, URL/host/port validators), with a scopes check and an "install webhook" checkbox for providers that can configure themselves.
- Providers that cannot self-install show a "semi-automated" panel. `GET /providers/{type}/webhook` renders the provider's `webhook_markdown` or `webhook_template` with the URL and API key substituted in, as copyable blocks.
  - The Prometheus template is an Alertmanager `route` and `receivers` snippet with `basic_auth{username: api_key, password: <key>}`, `send_resolved: true`, `group_wait 15s`, `repeat_interval 1m`.
  - The Grafana instructions are nine numbered contact-point and notification-policy steps with an `X-API-KEY` header.
- Settings › Webhook shows "URL: …/alerts/event" and "API Key: <plaintext>", curl/Python/Node tabs built from the `AlertDto` schema example, and "Click to create an example Alert", which POSTs it from the browser.

**API**
- `GET /settings/webhook` returns `{webhookApi, apiKey, modelSchema}`.
- `POST /alerts/event` (generic) and `POST /alerts/event/{provider_type}?provider_id=` return 202 and enqueue a job.
- Accepted auth: `X-API-KEY` header, HTTP Basic (key as password), or a URL with credentials embedded (`https://keep:<key>@…`).

**Key handling**
- One tenant-wide key, `reference_id="webhook"`, role `webhook`.
- Stored sha256-hashed in the DB **and** in plaintext in the secret manager, so it can be re-displayed to anyone with `read:settings`.

**Worth adopting:** copy-paste snippets per sender type; a one-click test alert; "linked" auto-discovery of senders; config forms generated from a schema.

**Weaknesses**
- A single shared key for all senders. It cannot be rotated without touching every sender.
- The key is shown in plaintext forever, and embedded in URLs, which end up in logs.
- `repeat_interval 1m` is noisy.

**REA evidence:** `app/(keep)/settings/{webhook-settings,settings.client}.tsx`, `app/(keep)/providers/{page,page.client,providers-tiles,provider-tile,provider-form,provider-form-scopes,provider-semi-automated,provider-logs,form-fields,form-validation}.tsx|ts`, `app/(keep)/providers/oauth2/[providerType]/page.tsx`, `shared/api/providers.ts`, `utils/hooks/useProviders.ts`.

## 10. Topology and applications

**Screens**
- A React Flow service map with alert-count badges and application grouping, search, and a side panel to add services and dependencies by hand.
- An Applications list (name, description, repository, services); import and export.
- A Topology tab on incidents and a "Related Services" mini-map in the alert sidebar.

**API:** `GET /topology`, `/topology/applications` CRUD, `POST/PUT/DELETE /topology/service(s)`, `/topology/dependency`, `/topology/pull`, `/export`, `/import`.

**Data model**
- `TopologyService{service, display_name, environment, team, email, slack, repository, tags, namespace, category, source_provider_id, is_manual}`.
- `TopologyServiceDependency{service_id, depends_on_service_id, protocol}`.
- `TopologyApplication{name, description, repository}`, many-to-many with services.
- A background `TopologyProcessor` periodically creates or updates one incident per application when its services have alerts in a look-back window.

**Worth adopting:** owner and contact fields on services, used for enrichment; application-level incidents.

**Weaknesses**
- Topology incidents are created by a polling loop, separate from the rules engine, so there are two correlation paths.

**REA evidence:** `app/(keep)/topology/{page,layout,topology-client,TopologySearchContext}.tsx`, `…/topology/model/{useTopology,useTopologyApplications,TopologyPollingContext,models}.ts`, `…/topology/ui/map/{topology-map,service-node,application-node,AddEditNodeSidePanel,getNodesAndEdgesFromTopologyData}.tsx|ts`, `…/topology/ui/applications/{applications-list,application-card,application-modal,create-or-update-application-form}.tsx`, `app/(keep)/incidents/[id]/topology/page.tsx`.

## 11. AI correlation and incident suggestions

**Flow**
1. Select up to 50 alerts and choose "Create Incidents with AI".
2. `POST /incidents/ai/suggest` takes a fingerprint list.
3. The server sends the alerts plus all topology data to OpenAI and parses the reply into `IncidentClustering{incidents[{incident_name, alerts[idx], reasoning, severity, recommended_actions[], confidence_score, confidence_explanation}]}`.
4. The result is stored as an `AISuggestion` keyed by the input fingerprint set. The same selection returns the cached answer.
5. The modal shows one card per proposed incident, with name, summary, confidence and explanation. Alerts can be **dragged between cards**, and each card can be edited.
6. "Create Incidents" calls `POST /incidents/ai/{suggestion_id}/commit` with `[{accepted, original_suggestion, changes, incident}]`.
7. User edits are stored as `AIFeedback`.

**Worth adopting:** suggest, then human edit, then commit; corrections kept as feedback; caching by input set; confidence and reasoning per group; a hard input cap.

**Weaknesses**
- Any failure becomes "AI service is unavailable" (500).
- All topology is sent regardless of relevance.
- Feedback is stored, but nothing reads it back.

**REA evidence:** `features/alerts/alert-create-incident-ai/ui/{alert-create-incident-ai-modal,alert-create-incident-ai-card}.tsx` (the only module the `ai/suggest` seed matched), `app/(keep)/incidents/predicted-incidents-table.tsx`.

---

## Decisions for SupOps

These are written against what SupOps already has: per-project `alerts` and `incidents`, the single `ingest.ts` entry point, Alertmanager silences behind the risk gate, approvals, and audit.

**Webhook integrations**
- One `integration` row per sender: `{id, projectId, kind(alertmanager|grafana|generic), name, tokenHash, tokenPrefix, createdBy, lastReceivedAt, received24h, rejected24h}`.
- The URL carries the integration id. The token goes in `Authorization: Bearer`. HTTP Basic (token as password) is also accepted, because Alertmanager's `http_config` needs it. Never put the token in the URL.
- Show the token **once** at creation or rotation. Store only the hash. Rotation keeps a 24-hour overlap with the old token.
- The setup page shows per-kind snippets with the URL and a token placeholder filled in:
  - an Alertmanager `receivers`/`route` block (`send_resolved: true`, `repeat_interval` of hours, not 1m)
  - Grafana contact-point steps
  - curl
- It also has a "Send test alert" button that goes through the real ingest path and shows the stored result.
- Unknown-sender view: rejected requests are counted per integration, with the reason (bad token, bad payload). This is Keep's "linked" idea, made safe.

**Dedup**
- Keep Keep's two-level model, adapted to our `ingest.ts`:
  - `fingerprint` (identity) from per-kind defaults: Alertmanager's own fingerprint; otherwise `alertname` plus sorted labels minus volatile ones
  - `contentHash` over the payload minus ignore fields (`startsAt`, `lastReceived`, annotations listed per kind)
- Same fingerprint and same hash bumps `repeatCount` and `lastSeenAt` and stores nothing new. Same fingerprint with a different hash updates the alert and writes an `alert_event`.
- Dedup rules are scoped by label matchers, not by provider. Show the dedup ratio and a 24-hour sparkline per rule.

**Flapping** (Keep has none)
- Record every firing↔resolved transition in `alert_transitions`.
- An alert is `flapping` when it has at least 4 transitions in 30 minutes (configurable per project).
- While flapping, notifications are held back and a badge shows. It clears after 30 quiet minutes, then sends one summary notification.

**Maintenance windows**
- Matchers use Alertmanager syntax (`label=value`, `!=`, `=~`, `!~`) in one grammar shared with silences, routing, dedup scope and correlation filters. Not CEL.
- Fields:
  - name, reason
  - matchers (at least one required; reject the empty set)
  - `startsAt` and `endsAt` as absolute times, never a duration re-derived on edit
  - optional weekly recurrence (days plus a time range plus a time zone)
  - `createdBy`
- Behaviour: alerts are **always stored** and shown with an "in maintenance: <window>" marker. Notifications and auto-triage are muted.
- Never drop events. Show a live "N alerts would match now" preview before saving.
- At window end, re-check still-firing matched alerts and notify once.
- Optional "also create Alertmanager silence" uses the existing gated silence tool.

**Correlation rules**
- A structured rule, not a CEL string:
  - `{name, groups:[{matchers[]}], groupBy[labels], windowSec, threshold, createOn(any|all), resolveOn(never|all|first|last), titleTemplate, assignee, requireApproval}`
- Evaluate groups as data. No string splitting.
- Live "matching alerts in the last 24 hours" count and a dry run listing the incidents it would have made.
- `requireApproval` produces `suggested` incidents shown in a separate list with Confirm and Discard.
- One correlation engine. Service and topology grouping is just `groupBy: [service]` or an application lookup inside it, not a second loop.

**Incident acknowledge, assign, comments and timeline**
- Assign to **any** project member, with an "assign to me" shortcut. Ack and assign are separate actions.
- Changing status never re-assigns. Acking an incident acks its open alerts with "until re-fire" semantics (Keep's dispose-on-new-alert), shown in the UI as "Acknowledged until it fires again."
- One append-only `incident_events{id, incidentId, at, actor, kind(alert_added|alert_removed|status|assign|severity|comment|merged|split|triage|maintenance|notification), data json}`.
  - The Activity tab and the timeline both render from it.
  - Comments are events too, with @mentions stored as user ids.
- Merge and split each run in one DB transaction.
  - Merge leaves the source as `merged` with `mergedInto`, and is undoable within the UI session.
  - Split can target a **new** incident.
- Keep `userTitle`/`aiTitle` and `userSummary`/`aiSummary` as separate columns. Add a recurrence link to a past similar incident.

**Enrichment and extraction**
- Extraction rules: `{name, priority, when(matchers), sourceField, pattern}` with named groups.
  - Compile with a linear-time engine (RE2 via `re2-wasm` or similar) or reject backtracking constructs.
  - Cap input length.
  - Must pass a test against a sample alert before saving.
- Mapping tables: CSV upload, keyed by chosen columns. Multiple key-column sets are OR'd.
- Every field records its origin: `fieldOrigin{field: source|rule:<id>|user:<id>}`.
- Each rule keeps an execution log (matched, skipped and why), retained for 7 days.
- Manual enrichments: values are typed (string, number, bool), with an explicit "keep after re-fire" toggle defaulting to off.

**Notification channels and routing**
- Channels: Slack (existing), email, generic webhook. Each has a send-test button.
- Routing is an ordered tree of `{matchers, channel, groupBy, groupWait, groupInterval, repeatInterval, continue}`, deliberately Alertmanager-shaped.
- Routing runs after maintenance, flapping and ack checks. Ack and maintenance mute; resolve sends one "resolved" message.
- Saved views (typed `{query, columns, sort, visibility: private|project}`) can opt into browser notifications. This is Keep's "noisy preset" without the audio autoplay.

**Feed, facets and saved views**
- Facet counts recomputed under the current filter, with an "Only" per value, and the filter in the URL.
- Reading the feed never triggers outbound polling.

**Workflows**
- Triggers: alert (matchers plus `onChangeOf[fields]`), incident (created, status changed, assigned), schedule, manual.
- Steps come only from the read-only tool set (query metrics or logs, fetch alert or incident, gather evidence, start an investigation run) plus `notify`.
- Any step that would write (silence, restart, scale, close a ticket) becomes an **approval request** through the existing risk gate and never auto-runs. An unattended workflow can therefore never exceed read-only power.
- The step allowlist is checked server-side at save time and again at run time.
- Revisions, with runs pinned to a revision.
- Per-step test with a sample alert.
- Run history with per-step logs, linked back to the alert or incident.
- No state-changing GET endpoints anywhere.

**AI incident suggestions**
- Keep Keep's flow: select alerts (cap 50), get grouped suggestions with reasoning and confidence, drag alerts between groups, accept or reject each group, then commit.
- Send only the relevant service-map slice.
- Store the user edits as feedback and feed accepted and rejected examples into the knowledge and learned-rules path.
- Suggestions never create incidents on their own.
