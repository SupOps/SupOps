CREATE TABLE `adaptive_limits` (
	`watch_id` text NOT NULL,
	`series` text NOT NULL,
	`labels` text NOT NULL,
	`upper` real,
	`lower` real,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`watch_id`, `series`),
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `watches` ADD `adaptive` text;