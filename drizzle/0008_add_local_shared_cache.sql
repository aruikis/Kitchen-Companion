CREATE TABLE IF NOT EXISTS `local_shared` (
	`share_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`owner_kc_id` text NOT NULL,
	`owner_name` text DEFAULT '' NOT NULL,
	`share_created_at` text DEFAULT '' NOT NULL
);
