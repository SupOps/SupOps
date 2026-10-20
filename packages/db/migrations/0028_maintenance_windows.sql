CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`reason` text,
	`matchers` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`recurrence` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	`cancelled_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `maintenance_windows_project` ON `maintenance_windows` (`project_id`,`ends_at`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `maintenance_id` text REFERENCES maintenance_windows(id) ON DELETE SET NULL;