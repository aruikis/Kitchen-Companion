CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`kc_id` text NOT NULL,
	`photo_key` text,
	`photo_data` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_friends` (
	`kc_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`photo_data` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`share_key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`synced` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
