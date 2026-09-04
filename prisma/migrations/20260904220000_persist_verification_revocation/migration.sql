-- Persist an administrator's verification revocation so a member cannot
-- immediately self-verify again with an institute OTP.
ALTER TABLE `profiles`
  ADD COLUMN `verification_revoked_at` DATETIME(3) NULL AFTER `is_verified`;
