-- A version number per kind of data the UI shows. Triggers bump it on every write,
-- from any part of the code, and the server pushes "this changed" to open pages,
-- so pages stop polling every few seconds. Not in the drizzle schema, like knowledge_fts.
CREATE TABLE `live_versions` (`topic` text PRIMARY KEY NOT NULL, `version` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
INSERT INTO `live_versions` (`topic`, `version`) VALUES ('runs', 0), ('approvals', 0), ('alerts', 0), ('observability', 0), ('health', 0), ('knowledge', 0);
--> statement-breakpoint
CREATE TRIGGER `live_runs_insert` AFTER INSERT ON `runs` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'runs';
END;
--> statement-breakpoint
CREATE TRIGGER `live_runs_update` AFTER UPDATE OF status ON `runs` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'runs';
END;
--> statement-breakpoint
CREATE TRIGGER `live_tool_calls_insert` AFTER INSERT ON `tool_calls` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'approvals';
END;
--> statement-breakpoint
CREATE TRIGGER `live_tool_calls_update` AFTER UPDATE OF state ON `tool_calls` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'approvals';
END;
--> statement-breakpoint
CREATE TRIGGER `live_alerts_insert` AFTER INSERT ON `alerts` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'alerts';
END;
--> statement-breakpoint
CREATE TRIGGER `live_alerts_update` AFTER UPDATE ON `alerts` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'alerts';
END;
--> statement-breakpoint
CREATE TRIGGER `live_incidents_insert` AFTER INSERT ON `incidents` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'observability';
END;
--> statement-breakpoint
CREATE TRIGGER `live_incidents_update` AFTER UPDATE ON `incidents` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'observability';
END;
--> statement-breakpoint
CREATE TRIGGER `live_observations_insert` AFTER INSERT ON `observations` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'observability';
END;
--> statement-breakpoint
CREATE TRIGGER `live_observations_update` AFTER UPDATE OF resolved_at, incident_id ON `observations` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'observability';
END;
--> statement-breakpoint
CREATE TRIGGER `live_health_issues_insert` AFTER INSERT ON `health_issues` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'health';
END;
--> statement-breakpoint
CREATE TRIGGER `live_health_issues_update` AFTER UPDATE ON `health_issues` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'health';
END;
--> statement-breakpoint
CREATE TRIGGER `live_health_checks_insert` AFTER INSERT ON `health_checks` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'health';
END;
--> statement-breakpoint
CREATE TRIGGER `live_health_checks_update` AFTER UPDATE OF status ON `health_checks` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'health';
END;
--> statement-breakpoint
CREATE TRIGGER `live_knowledge_docs_insert` AFTER INSERT ON `knowledge_docs` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'knowledge';
END;
--> statement-breakpoint
CREATE TRIGGER `live_knowledge_docs_update` AFTER UPDATE OF status ON `knowledge_docs` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'knowledge';
END;
--> statement-breakpoint
CREATE TRIGGER `live_knowledge_docs_delete` AFTER DELETE ON `knowledge_docs` BEGIN
  UPDATE live_versions SET version = version + 1 WHERE topic = 'knowledge';
END;
