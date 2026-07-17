CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`yc_id` text NOT NULL,
	`name` text NOT NULL,
	`batch` text,
	`status` text,
	`website_url` text,
	`yc_url` text,
	`location` text,
	`industry` text,
	`is_hiring` integer,
	`checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_yc_id_unique` ON `companies` (`yc_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text,
	`fact_type` text,
	`fact` text NOT NULL,
	`checked_at` text NOT NULL,
	`confidence` real NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`ciphertext` text NOT NULL,
	`refresh_metadata_ciphertext` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_provider_unique` ON `oauth_tokens` (`provider`);--> statement-breakpoint
CREATE TABLE `outreach_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`purpose` text NOT NULL,
	`text` text NOT NULL,
	`version` integer NOT NULL,
	`evidence_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_target_purpose_version_unique` ON `outreach_drafts` (`target_id`,`purpose`,`version`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`public_profile_url` text,
	`checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_company_name_role_unique` ON `people` (`company_id`,`name`,`role`);--> statement-breakpoint
CREATE TABLE `post_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`text` text NOT NULL,
	`visibility` text NOT NULL,
	`version` integer NOT NULL,
	`checksum` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_draft_version_unique` ON `post_drafts` (`draft_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_draft_row_version_unique` ON `post_drafts` (`id`,`version`);--> statement-breakpoint
CREATE TABLE `post_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`post_draft_id` text NOT NULL,
	`version` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	FOREIGN KEY (`post_draft_id`) REFERENCES `post_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_draft_id`,`version`) REFERENCES `post_drafts`(`id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_previews_token_hash_unique` ON `post_previews` (`token_hash`);--> statement-breakpoint
CREATE TABLE `publish_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`post_draft_id` text NOT NULL,
	`version` integer NOT NULL,
	`requested_at` text NOT NULL,
	`response_category` text NOT NULL,
	`post_urn` text,
	`sanitized_error` text,
	`completed_at` text,
	FOREIGN KEY (`post_draft_id`) REFERENCES `post_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_draft_id`,`version`) REFERENCES `post_drafts`(`id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_unique` ON `settings` (`key`);--> statement-breakpoint
CREATE TABLE `shortlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`shortlist_id` text NOT NULL,
	`target_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shortlist_id`) REFERENCES `shortlists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_target_unique` ON `shortlist_entries` (`shortlist_id`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_position_unique` ON `shortlist_entries` (`shortlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `shortlists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `target_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `targets` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`pmm_opportunity` real NOT NULL,
	`referral_potential` real NOT NULL,
	`network_value` real NOT NULL,
	`total_score` real NOT NULL,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `targets_person_id_unique` ON `targets` (`person_id`);