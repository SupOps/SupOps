CREATE TABLE `synthetic_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`port` integer,
	`method` text,
	`expect_status` text,
	`contains` text,
	`max_latency_ms` integer,
	`cert_days_warn` integer DEFAULT 14 NOT NULL,
	`interval_sec` integer DEFAULT 300 NOT NULL,
	`fail_threshold` integer DEFAULT 2 NOT NULL,
	`allow_private` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`fail_streak` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `synthetic_checks_project` ON `synthetic_checks` (`project_id`);--> statement-breakpoint
CREATE TABLE `synthetic_results` (
	`id` text PRIMARY KEY NOT NULL,
	`check_id` text NOT NULL,
	`at` integer NOT NULL,
	`ok` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`status_code` integer,
	`cert_days_left` integer,
	`error` text,
	FOREIGN KEY (`check_id`) REFERENCES `synthetic_checks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `synthetic_results_check_at` ON `synthetic_results` (`check_id`,`at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_slos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`service` text,
	`connection_id` text,
	`synthetic_id` text,
	`good_query` text DEFAULT '' NOT NULL,
	`total_query` text DEFAULT '' NOT NULL,
	`target` real NOT NULL,
	`window_days` integer DEFAULT 30 NOT NULL,
	`alerting` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`synthetic_id`) REFERENCES `synthetic_checks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_slos`("id", "project_id", "name", "service", "connection_id", "synthetic_id", "good_query", "total_query", "target", "window_days", "alerting", "enabled", "status", "created_by", "created_at") SELECT "id", "project_id", "name", "service", "connection_id", NULL, "good_query", "total_query", "target", "window_days", "alerting", "enabled", "status", "created_by", "created_at" FROM `slos`;--> statement-breakpoint
DROP TABLE `slos`;--> statement-breakpoint
ALTER TABLE `__new_slos` RENAME TO `slos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `slos_project` ON `slos` (`project_id`);