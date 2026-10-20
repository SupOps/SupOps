CREATE TABLE `slos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`service` text,
	`connection_id` text NOT NULL,
	`good_query` text NOT NULL,
	`total_query` text NOT NULL,
	`target` real NOT NULL,
	`window_days` integer DEFAULT 30 NOT NULL,
	`alerting` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `slos_project` ON `slos` (`project_id`);