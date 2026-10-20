CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`target_slugs` text DEFAULT '[]' NOT NULL,
	`verdict` text NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`knowledge_doc_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `lessons_project` ON `lessons` (`project_id`,`created_at`);