-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(36) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `phone` VARCHAR(32) NULL,
    `password_hash` VARCHAR(255) NULL,
    `role` VARCHAR(24) NOT NULL DEFAULT 'member',
    `status` VARCHAR(24) NOT NULL DEFAULT 'active',
    `email_verified_at` DATETIME(3) NULL,
    `phone_verified_at` DATETIME(3) NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    UNIQUE INDEX `users_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_identities` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `provider_subject` VARCHAR(255) NOT NULL,
    `provider_email` VARCHAR(320) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `auth_identities_user_id_idx`(`user_id`),
    UNIQUE INDEX `auth_identities_provider_provider_subject_key`(`provider`, `provider_subject`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `profiles` (
    `user_id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(160) NULL,
    `slug` VARCHAR(100) NULL,
    `avatar_url` TEXT NULL,
    `cover_photo_url` TEXT NULL,
    `headline` VARCHAR(255) NULL,
    `bio` TEXT NULL,
    `location` VARCHAR(255) NULL,
    `date_of_birth` DATE NULL,
    `phone_country_code` VARCHAR(8) NULL,
    `phone_number` VARCHAR(24) NULL,
    `phone_full` VARCHAR(32) NULL,
    `iit_email` VARCHAR(320) NULL,
    `iit_name` VARCHAR(160) NULL,
    `student_status` VARCHAR(40) NULL,
    `community_id` VARCHAR(80) NOT NULL DEFAULT 'iit-community',
    `role` VARCHAR(24) NOT NULL DEFAULT 'member',
    `is_verified` BOOLEAN NOT NULL DEFAULT false,
    `onboarding_completed` BOOLEAN NOT NULL DEFAULT false,
    `is_mentor` BOOLEAN NOT NULL DEFAULT false,
    `mentor_category` VARCHAR(120) NULL,
    `mentor_price_chat` DECIMAL(10, 2) NULL,
    `mentor_price_audio` DECIMAL(10, 2) NULL,
    `mentor_price_video` DECIMAL(10, 2) NULL,
    `expertise` JSON NULL,
    `skills` JSON NULL,
    `experience` JSON NULL,
    `social_links` JSON NULL,
    `primary_education_id` VARCHAR(36) NULL,
    `slug_updated_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `profiles_slug_key`(`slug`),
    UNIQUE INDEX `profiles_iit_email_key`(`iit_email`),
    INDEX `profiles_community_id_is_verified_idx`(`community_id`, `is_verified`),
    INDEX `profiles_iit_name_student_status_idx`(`iit_name`, `student_status`),
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_sessions` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `family_id` VARCHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `parent_id` VARCHAR(36) NULL,
    `replaced_by_id` VARCHAR(36) NULL,
    `user_agent` VARCHAR(512) NULL,
    `ip_hash` CHAR(64) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoke_reason` VARCHAR(80) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refresh_sessions_token_hash_key`(`token_hash`),
    INDEX `refresh_sessions_user_id_revoked_at_idx`(`user_id`, `revoked_at`),
    INDEX `refresh_sessions_family_id_idx`(`family_id`),
    INDEX `refresh_sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_otps` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NULL,
    `email` VARCHAR(320) NOT NULL,
    `destination_hash` CHAR(64) NOT NULL,
    `code_hash` VARCHAR(255) NOT NULL,
    `purpose` VARCHAR(40) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `ip_hash` CHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_otps_destination_hash_purpose_created_at_idx`(`destination_hash`, `purpose`, `created_at`),
    INDEX `email_otps_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_resets` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_resets_token_hash_key`(`token_hash`),
    INDEX `password_resets_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_codes` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `redirect_uri` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `oauth_codes_code_hash_key`(`code_hash`),
    INDEX `oauth_codes_kind_expires_at_idx`(`kind`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `posts` (
    `id` VARCHAR(36) NOT NULL,
    `author_id` VARCHAR(36) NULL,
    `content` TEXT NOT NULL,
    `community_id` VARCHAR(80) NOT NULL DEFAULT 'iit-community',
    `channel` VARCHAR(40) NULL,
    `scope_type` VARCHAR(40) NOT NULL DEFAULT 'GLOBAL',
    `scope_key` VARCHAR(255) NOT NULL DEFAULT 'IIT_ALL',
    `is_anonymous` BOOLEAN NOT NULL DEFAULT false,
    `tags` JSON NULL,
    `campus_filter` VARCHAR(160) NULL,
    `degree_filter` VARCHAR(160) NULL,
    `branch_filter` VARCHAR(160) NULL,
    `batch_filter` VARCHAR(40) NULL,
    `cohort_filter` VARCHAR(255) NULL,
    `student_status_filter` VARCHAR(40) NULL,
    `image_url` TEXT NULL,
    `image_path` TEXT NULL,
    `media_url` TEXT NULL,
    `media_type` VARCHAR(80) NULL,
    `media_path` TEXT NULL,
    `media_metadata` JSON NULL,
    `file_url` TEXT NULL,
    `file_path` TEXT NULL,
    `file_name` VARCHAR(255) NULL,
    `file_type` VARCHAR(160) NULL,
    `file_size` BIGINT NULL,
    `voice_url` TEXT NULL,
    `voice_path` TEXT NULL,
    `voice_duration` INTEGER NULL,
    `client_id` VARCHAR(100) NULL,
    `message_type` VARCHAR(40) NULL,
    `reply_to_id` VARCHAR(36) NULL,
    `reshared_post_id` VARCHAR(36) NULL,
    `is_deleted_for_everyone` BOOLEAN NOT NULL DEFAULT false,
    `deleted_by_user_id` VARCHAR(36) NULL,
    `deleted_for_users` JSON NULL,
    `seen_by` JSON NULL,
    `deleted_at` DATETIME(3) NULL,
    `edited_at` DATETIME(3) NULL,
    `pinned_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `posts_scope_type_scope_key_created_at_idx`(`scope_type`, `scope_key`, `created_at`),
    INDEX `posts_community_id_created_at_idx`(`community_id`, `created_at`),
    INDEX `posts_author_id_created_at_idx`(`author_id`, `created_at`),
    INDEX `posts_reply_to_id_created_at_idx`(`reply_to_id`, `created_at`),
    UNIQUE INDEX `posts_author_id_client_id_key`(`author_id`, `client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `comments` (
    `id` VARCHAR(36) NOT NULL,
    `post_id` VARCHAR(36) NOT NULL,
    `author_id` VARCHAR(36) NOT NULL,
    `content` TEXT NOT NULL,
    `parent_comment_id` VARCHAR(36) NULL,
    `edited_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `comments_post_id_created_at_idx`(`post_id`, `created_at`),
    INDEX `comments_author_id_idx`(`author_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reactions` (
    `id` VARCHAR(36) NOT NULL,
    `entity_id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL DEFAULT 'post',
    `emoji` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reactions_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `reactions_user_id_idx`(`user_id`),
    UNIQUE INDEX `reactions_entity_type_entity_id_user_id_emoji_key`(`entity_type`, `entity_id`, `user_id`, `emoji`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reports` (
    `id` VARCHAR(36) NOT NULL,
    `entity_id` VARCHAR(36) NOT NULL,
    `reporter_id` VARCHAR(36) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL DEFAULT 'forum_msg',
    `reason` VARCHAR(500) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'open',
    `resolved_at` DATETIME(3) NULL,
    `resolved_by` VARCHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reports_status_created_at_idx`(`status`, `created_at`),
    UNIQUE INDEX `reports_entity_type_entity_id_reporter_id_key`(`entity_type`, `entity_id`, `reporter_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `connections` (
    `id` VARCHAR(36) NOT NULL,
    `requester_id` VARCHAR(36) NOT NULL,
    `receiver_id` VARCHAR(36) NOT NULL,
    `pair_key` VARCHAR(73) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
    `note` VARCHAR(200) NULL,
    `responded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `connections_pair_key_key`(`pair_key`),
    INDEX `connections_requester_id_status_idx`(`requester_id`, `status`),
    INDEX `connections_receiver_id_status_idx`(`receiver_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` VARCHAR(36) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `community_id` VARCHAR(80) NOT NULL DEFAULT 'iit-community',
    `company` VARCHAR(255) NOT NULL,
    `company_logo_url` TEXT NULL,
    `location` VARCHAR(255) NULL,
    `job_type` VARCHAR(80) NULL,
    `category` VARCHAR(120) NULL,
    `experience` VARCHAR(255) NULL,
    `experience_level` VARCHAR(80) NULL,
    `easy_apply` BOOLEAN NOT NULL DEFAULT false,
    `description` LONGTEXT NULL,
    `application_url` TEXT NULL,
    `apply_url` TEXT NULL,
    `source_url` TEXT NULL,
    `source_type` VARCHAR(40) NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'published',
    `salary_min` DECIMAL(14, 2) NULL,
    `salary_max` DECIMAL(14, 2) NULL,
    `salary_currency` VARCHAR(8) NULL,
    `salary_text` VARCHAR(255) NULL,
    `skills` JSON NULL,
    `source_fingerprint` CHAR(64) NULL,
    `scan_run_id` VARCHAR(36) NULL,
    `discovered_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `jobs_source_fingerprint_key`(`source_fingerprint`),
    INDEX `jobs_status_published_at_idx`(`status`, `published_at`),
    INDEX `jobs_community_id_status_published_at_idx`(`community_id`, `status`, `published_at`),
    INDEX `jobs_company_idx`(`company`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `applications` (
    `id` VARCHAR(36) NOT NULL,
    `job_id` VARCHAR(36) NOT NULL,
    `applicant_id` VARCHAR(36) NOT NULL,
    `note` TEXT NULL,
    `resume_url` TEXT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'submitted',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `applications_applicant_id_created_at_idx`(`applicant_id`, `created_at`),
    UNIQUE INDEX `applications_job_id_applicant_id_key`(`job_id`, `applicant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events` (
    `id` VARCHAR(36) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` LONGTEXT NULL,
    `location` VARCHAR(255) NULL,
    `start_time` DATETIME(3) NOT NULL,
    `end_time` DATETIME(3) NULL,
    `image_url` TEXT NULL,
    `registration_url` TEXT NULL,
    `organizer_name` VARCHAR(255) NULL,
    `organizer` VARCHAR(255) NULL,
    `source_iit` VARCHAR(160) NULL,
    `audience_type` VARCHAR(40) NULL,
    `audience_targets` JSON NULL,
    `audience_mode` VARCHAR(40) NULL,
    `target_iits` JSON NULL,
    `target_courses` JSON NULL,
    `target_specialisations` JSON NULL,
    `source_url` TEXT NULL,
    `source_fingerprint` CHAR(64) NULL,
    `scan_run_id` VARCHAR(36) NULL,
    `source_type` VARCHAR(40) NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'draft',
    `community_id` VARCHAR(80) NOT NULL DEFAULT 'iit-community',
    `created_by` VARCHAR(36) NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `events_source_fingerprint_key`(`source_fingerprint`),
    INDEX `events_status_start_time_idx`(`status`, `start_time`),
    INDEX `events_community_id_start_time_idx`(`community_id`, `start_time`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rsvps` (
    `id` VARCHAR(36) NOT NULL,
    `event_id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'going',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `rsvps_user_id_idx`(`user_id`),
    UNIQUE INDEX `rsvps_event_id_user_id_key`(`event_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_objects` (
    `id` VARCHAR(36) NOT NULL,
    `uploaded_by` VARCHAR(36) NULL,
    `bucket` VARCHAR(80) NOT NULL,
    `object_key` VARCHAR(600) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(160) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `visibility` VARCHAR(16) NOT NULL DEFAULT 'private',
    `sha256` CHAR(64) NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'ready',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `file_objects_object_key_key`(`object_key`),
    INDEX `file_objects_uploaded_by_bucket_created_at_idx`(`uploaded_by`, `bucket`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(36) NOT NULL,
    `actor_id` VARCHAR(36) NULL,
    `action` VARCHAR(120) NOT NULL,
    `resource_type` VARCHAR(80) NOT NULL,
    `resource_id` VARCHAR(100) NULL,
    `ip_hash` CHAR(64) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_actor_id_created_at_idx`(`actor_id`, `created_at`),
    INDEX `audit_logs_resource_type_resource_id_idx`(`resource_type`, `resource_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legacy_records` (
    `id` VARCHAR(36) NOT NULL,
    `table_name` VARCHAR(100) NOT NULL,
    `record_id` VARCHAR(100) NOT NULL,
    `owner_id` VARCHAR(36) NULL,
    `community_id` VARCHAR(80) NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `legacy_records_table_name_owner_id_idx`(`table_name`, `owner_id`),
    INDEX `legacy_records_table_name_community_id_idx`(`table_name`, `community_id`),
    UNIQUE INDEX `legacy_records_table_name_record_id_key`(`table_name`, `record_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_identities` ADD CONSTRAINT `auth_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `profiles` ADD CONSTRAINT `profiles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_sessions` ADD CONSTRAINT `refresh_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_otps` ADD CONSTRAINT `email_otps_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_resets` ADD CONSTRAINT `password_resets_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `oauth_codes` ADD CONSTRAINT `oauth_codes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_reply_to_id_fkey` FOREIGN KEY (`reply_to_id`) REFERENCES `posts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `posts` ADD CONSTRAINT `posts_reshared_post_id_fkey` FOREIGN KEY (`reshared_post_id`) REFERENCES `posts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `comments` ADD CONSTRAINT `comments_post_id_fkey` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `comments` ADD CONSTRAINT `comments_author_id_fkey` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `comments` ADD CONSTRAINT `comments_parent_comment_id_fkey` FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reactions` ADD CONSTRAINT `reactions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_reporter_id_fkey` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `connections` ADD CONSTRAINT `connections_requester_id_fkey` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `connections` ADD CONSTRAINT `connections_receiver_id_fkey` FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `applications` ADD CONSTRAINT `applications_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `applications` ADD CONSTRAINT `applications_applicant_id_fkey` FOREIGN KEY (`applicant_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rsvps` ADD CONSTRAINT `rsvps_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rsvps` ADD CONSTRAINT `rsvps_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_uploaded_by_fkey` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
