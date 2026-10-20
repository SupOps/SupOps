ALTER TABLE `alerts` ADD `flapping` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `flapping_since` integer;