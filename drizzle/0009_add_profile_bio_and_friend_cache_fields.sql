ALTER TABLE `profiles` ADD COLUMN `bio` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `location` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `profiles` ADD COLUMN `specialties` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `local_friends` ADD COLUMN `bio` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `local_friends` ADD COLUMN `location` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `local_friends` ADD COLUMN `specialties` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `local_friends` ADD COLUMN `joined_at` text;
