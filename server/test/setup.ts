process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "mysql://cirkle:cirkle_local_only_change_me@127.0.0.1:3306/cirkle";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-that-is-at-least-32-characters";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-that-is-at-least-32-characters";
process.env.STORAGE_SIGNING_SECRET ||= "test-storage-signing-secret-value";
process.env.IP_HASH_SECRET ||= "test-ip-hash-secret";
process.env.OTP_PEPPER ||= "test-otp-pepper-value";
// Keep OAuth allow-list tests hermetic when CI supplies localhost URLs for the
// separate built-API smoke step. Environment changes here stay in Vitest.
process.env.FRONTEND_URL = "https://cirkle.world";
process.env.CORS_ORIGINS = "https://cirkle.world,https://www.cirkle.world";
