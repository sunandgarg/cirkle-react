-- Registration credentials must remain attached to the email challenge until
-- that exact challenge is verified. Remove hashes written by the legacy flow
-- from accounts that have never proved ownership of their email address.
ALTER TABLE `email_otps`
    ADD COLUMN `pending_password_hash` VARCHAR(255) NULL,
    ADD COLUMN `pending_name` VARCHAR(160) NULL;

UPDATE `users`
SET `password_hash` = NULL
WHERE `email_verified_at` IS NULL
  AND `password_hash` IS NOT NULL;
