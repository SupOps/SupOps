CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`service` text,
	`environment` text,
	`version` text,
	`previous_version` text,
	`author` text,
	`url` text,
	`status` text,
	`target_id` text,
	`integration_id` text,
	`run_id` text,
	`external_id` text,
	`labels` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`verdict` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`integration_id`) REFERENCES `alert_integrations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `changes_project_started` ON `changes` (`project_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `changes_external` ON `changes` (`project_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `rollout_states` (
	`target_id` text NOT NULL,
	`key` text NOT NULL,
	`generation` integer NOT NULL,
	`images` text NOT NULL,
	PRIMARY KEY(`target_id`, `key`),
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
