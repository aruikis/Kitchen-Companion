CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jewel_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_name` text NOT NULL,
	`store_location` text DEFAULT '' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`item_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'built' NOT NULL,
	`created_at` integer NOT NULL
);
