CREATE TABLE `staged_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`draft` text DEFAULT '{}' NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`sender_email` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`email_date` text,
	`raw_text` text,
	`created_at` integer NOT NULL
);
