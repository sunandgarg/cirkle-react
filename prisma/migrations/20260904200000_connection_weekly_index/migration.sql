-- The connection-request weekly guard filters by requester and creation time.
-- Keep that policy query index-backed as the connection table grows.
CREATE INDEX `connections_requester_id_created_at_idx`
    ON `connections`(`requester_id`, `created_at`);
