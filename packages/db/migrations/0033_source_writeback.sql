CREATE TABLE `source_writebacks` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`integration_id` text,
	`action` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`integration_id`) REFERENCES `alert_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_writebacks_key_unique` ON `source_writebacks` (`key`);--> statement-breakpoint
CREATE INDEX `source_writebacks_incident` ON `source_writebacks` (`incident_id`);--> statement-breakpoint
ALTER TABLE `alert_integrations` ADD `writeback_enc` text;--> statement-breakpoint
ALTER TABLE `alert_integrations` ADD `writeback_config` text;