import { Router } from 'express';
import { isAdmin, requireAuth } from '../auth.ts';
import { renderMetrics } from '../metrics.ts';
import { handleRpc } from '../mcp/server.ts';
import { apiKeyGate } from '../apikeys.ts';
import { apiKeyRoutes } from './api-keys.ts';
import { authRoutes } from './auth.ts';
import { projectRoutes } from './projects.ts';
import { targetRoutes } from './targets.ts';
import { agentRoutes } from './agents.ts';
import { dashboardRoutes } from './dashboard.ts';
import { runRoutes } from './runs.ts';
import { settingsRoutes } from './settings.ts';
import { alertRoutes } from './alerts.ts';
import { healthRoutes } from './health.ts';
import { userRoutes } from './users.ts';
import { integrationRoutes } from './integrations.ts';
import { maintenanceRoutes } from './maintenance.ts';
import { knowledgeRoutes } from './knowledge.ts';
import { observabilityRoutes } from './observability.ts';
import { serviceMapRoutes } from './servicemap.ts';
import { trustedRoutes } from './trusted.ts';
import { learningRoutes } from './learning.ts';
import { hookRoutes } from './hooks.ts';
import { alertSourceRoutes } from './alert-sources.ts';
import { maintenanceWindowRoutes } from './maintenance-windows.ts';
import { correlationRuleRoutes } from './correlation-rules.ts';
import { extractionRuleRoutes } from './extraction-rules.ts';
import { notificationRoutesApi } from './notifications.ts';
import { workflowRoutes } from './workflows.ts';
import { mcpServerRoutes } from './mcp-servers.ts';
import { changeIngestRoute, changeRoutes } from './changes.ts';
import { sloRoutes } from './slos.ts';
import { serviceHealthRoutes } from './service-health.ts';
import { syntheticRoutes } from './synthetics.ts';
import { errorRoutes } from './errors.ts';

export const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true }));
api.use('/auth', authRoutes);
// Alert senders authenticate with their own token, not a session.
api.use('/hooks', hookRoutes);
// CI/CD posting changes with a sender token; anything else falls through to the signed-in routes.
api.use('/changes', changeIngestRoute);

// Everything past this point needs a session.
api.use(requireAuth);
// Requests made with an API key reach only what its scopes allow.
api.use(apiKeyGate);
api.use('/api-keys', apiKeyRoutes);
/** SupOps as an MCP server (streamable HTTP, JSON replies), for other agents. */
api.post('/mcp', (req, res) => {
  const caller = { userId: req.user?.id ?? null, scopes: req.apiKey ? req.apiKey.scopes : null };
  const batch = Array.isArray(req.body) ? req.body : [req.body];
  const replies = batch.map((m) => handleRpc(m ?? {}, caller)).filter((r) => r !== null);
  if (!replies.length) {
    res.status(202).end();
    return;
  }
  res.json(Array.isArray(req.body) ? replies : replies[0]);
});
api.get('/mcp', (_req, res) => res.status(405).json({ error: 'SupOps answers MCP requests with JSON; there is no event stream to open.' }));
api.delete('/mcp', (_req, res) => res.status(200).end());

/** SupOps' own metrics, for Prometheus: an admin, or an API key with the metrics scope. */
api.get('/metrics', (req, res) => {
  if (!req.apiKey && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Metrics need an admin, or an API key with the metrics scope.' });
    return;
  }
  res.type('text/plain; version=0.0.4').send(renderMetrics());
});
api.use('/projects', projectRoutes);
api.use('/targets', targetRoutes);
api.use('/agents', agentRoutes);
api.use('/runs', runRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/settings', settingsRoutes);
api.use('/alerts', alertRoutes);
api.use('/health', healthRoutes);
api.use('/users', userRoutes);
api.use('/integrations', integrationRoutes);
api.use('/maintenance', maintenanceRoutes);
api.use('/knowledge', knowledgeRoutes);
api.use('/observability', observabilityRoutes);
api.use('/service-map', serviceMapRoutes);
api.use('/trusted-commands', trustedRoutes);
api.use('/learning', learningRoutes);
api.use('/alert-sources', alertSourceRoutes);
api.use('/maintenance-windows', maintenanceWindowRoutes);
api.use('/correlation-rules', correlationRuleRoutes);
api.use('/extraction-rules', extractionRuleRoutes);
api.use('/notifications', notificationRoutesApi);
api.use('/workflows', workflowRoutes);
api.use('/mcp-servers', mcpServerRoutes);
api.use('/changes', changeRoutes);
api.use('/slos', sloRoutes);
api.use('/service-health', serviceHealthRoutes);
api.use('/synthetics', syntheticRoutes);
api.use('/errors', errorRoutes);
