-- User-owned compatibility rows participate in account lifecycle locking and
-- deletion. The constraint intentionally fails if an orphan exists so a data
-- migration cannot silently discard or reassign ownership.
CREATE INDEX `legacy_records_owner_id_idx` ON `legacy_records`(`owner_id`);
ALTER TABLE `legacy_records`
  ADD CONSTRAINT `legacy_records_owner_id_fkey`
  FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
