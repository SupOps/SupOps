CREATE TABLE `extraction_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`matchers` text NOT NULL,
	`field` text NOT NULL,
	`label_name` text,
	`pattern` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`applied` integer DEFAULT 0 NOT NULL,
	`last_applied_at` integer,
	`last_example` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `extraction_rules_project` ON `extraction_rules` (`project_id`,`priority`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `enriched` text;