CREATE TABLE `suspect_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`change_id` text NOT NULL,
	`change_title` text NOT NULL,
	`verdict` text NOT NULL,
	`features` text NOT NULL,
	`others` text DEFAULT '[]' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suspect_feedback_pair` ON `suspect_feedback` (`incident_id`,`change_id`);--> statement-breakpoint
CREATE INDEX `suspect_feedback_project` ON `suspect_feedback` (`project_id`);