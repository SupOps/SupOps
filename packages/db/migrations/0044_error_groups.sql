CREATE TABLE `error_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`service` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`frame` text,
	`source` text NOT NULL,
	`example` text NOT NULL,
	`trace_id` text,
	`count` integer DEFAULT 0 NOT NULL,
	`last_count` integer DEFAULT 0 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`new_after_change` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `error_groups_fp` ON `error_groups` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `error_groups_seen` ON `error_groups` (`project_id`,`last_seen`);