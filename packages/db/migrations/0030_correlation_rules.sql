CREATE TABLE `correlation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`matchers` text NOT NULL,
	`group_by` text NOT NULL,
	`window_min` integer DEFAULT 15 NOT NULL,
	`threshold` integer DEFAULT 1 NOT NULL,
	`resolve_on` text DEFAULT 'all' NOT NULL,
	`title_template` text DEFAULT '' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`incidents_made` integer DEFAULT 0 NOT NULL,
	`alerts_grouped` integer DEFAULT 0 NOT NULL,
	`last_matched_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `correlation_rules_project` ON `correlation_rules` (`project_id`,`priority`);--> statement-breakpoint
ALTER TABLE `incidents` ADD `rule_id` text;--> statement-breakpoint
ALTER TABLE `incidents` ADD `rule_group_key` text;--> statement-breakpoint
ALTER TABLE `incidents` ADD `held` integer DEFAULT false NOT NULL;