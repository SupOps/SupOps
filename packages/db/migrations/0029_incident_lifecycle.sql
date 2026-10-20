CREATE TABLE `incident_events` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`kind` text NOT NULL,
	`data` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `incident_events_incident` ON `incident_events` (`incident_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `incidents` ADD `acknowledged_at` integer;--> statement-breakpoint
ALTER TABLE `incidents` ADD `acknowledged_by` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `incidents` ADD `assignee_id` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `incidents` ADD `severity_pinned` integer DEFAULT false NOT NULL;