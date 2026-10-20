CREATE TABLE `incident_dismissals` (
	`project_id` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	`by` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`a`, `b`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
