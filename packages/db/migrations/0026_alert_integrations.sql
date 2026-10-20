CREATE TABLE `alert_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`previous_token_hash` text,
	`previous_token_until` integer,
	`mapping` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`alerts_in` integer DEFAULT 0 NOT NULL,
	`repeats` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`last_received_at` integer,
	`last_error` text,
	`last_error_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alert_integrations_project` ON `alert_integrations` (`project_id`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `integration_id` text REFERENCES alert_integrations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `content_hash` text;