-- A reply without its parent loses its moderation and conversation context.
-- Delete the reply subtree with the parent instead of promoting children to
-- unrelated top-level comments. The following additive migration replaces
-- this interim rule with durable tombstones and restrictive parent deletion.
ALTER TABLE `comments` DROP FOREIGN KEY `comments_parent_comment_id_fkey`;
ALTER TABLE `comments`
  ADD CONSTRAINT `comments_parent_comment_id_fkey`
  FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
