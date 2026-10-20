CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`url` text,
	`command` text,
	`args` text,
	`secret_enc` text,
	`allow_private_network` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`read_only` text DEFAULT '{}' NOT NULL,
	`identity_tool` text,
	`identity` text,
	`server_info` text,
	`last_checked_at` integer,
	`last_error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE INDEX `mcp_servers_project` ON `mcp_servers` (`project_id`);