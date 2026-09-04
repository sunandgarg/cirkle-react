-- Preserve discussion context when a member account is removed and prevent
-- parent deletion from silently deleting or promoting another member's reply.
ALTER TABLE `comments` DROP FOREIGN KEY `comments_author_id_fkey`;
ALTER TABLE `comments` DROP FOREIGN KEY `comments_parent_comment_id_fkey`;
ALTER TABLE `comments` MODIFY `author_id` VARCHAR(36) NULL;
ALTER TABLE `comments`
  ADD CONSTRAINT `comments_author_id_fkey`
  FOREIGN KEY (`author_id`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `comments`
  ADD CONSTRAINT `comments_parent_comment_id_fkey`
  FOREIGN KEY (`parent_comment_id`) REFERENCES `comments`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
