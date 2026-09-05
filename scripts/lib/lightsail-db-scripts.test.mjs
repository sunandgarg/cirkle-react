import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const scripts = {
  setup: resolve(root, "aws/hosting/setup-lightsail-db.sh"),
  backup: resolve(root, "aws/hosting/backup-managed-mysql.sh"),
  installBackup: resolve(root, "aws/hosting/install-managed-backup.sh"),
  deploy: resolve(root, "aws/hosting/deploy-lightsail-release.sh"),
};

const source = Object.fromEntries(
  Object.entries(scripts).map(([name, path]) => [name, readFileSync(path, "utf8")]),
);

describe("Lightsail managed-MySQL deployment scripts", () => {
  it("parses every managed-database shell entry point", () => {
    for (const path of Object.values(scripts)) {
      execFileSync("bash", ["-n", path], { stdio: "pipe" });
    }
  });

  it("provisions distinct TLS-only least-privilege identities", () => {
    assert.match(source.setup, /'cirkle_app'@'%'.*REQUIRE SSL/);
    assert.match(source.setup, /'cirkle_migrate'@'%'.*REQUIRE SSL/);
    assert.match(source.setup, /'cirkle_backup'@'%'.*REQUIRE SSL/);
    assert.match(source.setup, /GRANT SELECT, INSERT, UPDATE, DELETE ON cirkle\.\* TO 'cirkle_app'/);
    assert.match(source.setup, /GRANT SELECT, SHOW VIEW, TRIGGER ON cirkle\.\* TO 'cirkle_backup'/);
    assert.doesNotMatch(source.setup, /GRANT ALL/);
    assert.match(source.setup, /--ssl-verify-server-cert/);
    assert.match(source.setup, /did not negotiate verified TLS/);
    assert.match(source.setup, /@@GLOBAL\.require_secure_transport/);
    assert.match(source.setup, /passwords must be distinct/);
  });

  it("fails backups closed unless the read-only identity and strict TLS are configured", () => {
    assert.match(source.backup, /BACKUP_DATABASE_URL/);
    assert.doesNotMatch(source.backup, /: "\$\{DATABASE_URL:/);
    assert.match(source.backup, /cirkle_backup/);
    assert.match(source.backup, /sslaccept/);
    assert.match(source.backup, /ssl-verify-server-cert/);
    assert.match(source.backup, /--metadata "sha256=/);
    assert.match(source.backup, /--checksum-algorithm SHA256/);
    assert.match(source.backup, /--checksum-mode ENABLED/);
    assert.match(source.backup, /head-object/);
    assert.match(source.installBackup, /-m 0600 "\$\{BACKUP_ENV_FILE\}" \/etc\/cirkle\/backup\.env/);
    assert.match(source.installBackup, /backup-managed-mysql\.sh.*\/usr\/local\/sbin\/cirkle-mysql-backup/);
    assert.match(source.installBackup, /the previous backup configuration was restored/);
  });

  it("backs up before migration and rolls both code and runtime config back", () => {
    assert.match(source.deploy, /DATABASE_URL cirkle_app/);
    assert.match(source.deploy, /MIGRATION_DATABASE_URL cirkle_migrate/);
    assert.match(source.deploy, /BACKUP_DATABASE_URL cirkle_backup/);
    assert.match(source.deploy, /sslaccept=strict/);
    assert.ok(source.deploy.indexOf("server/dist/config.js")
      < source.deploy.indexOf("systemctl start cirkle-mysql-backup.service"));
    assert.ok(source.deploy.indexOf("systemctl start cirkle-mysql-backup.service")
      < source.deploy.indexOf("pnpm db:migrate:deploy"));
    assert.ok(source.deploy.indexOf("staged_environment_file")
      < source.deploy.indexOf('mv -Tf "${staged_environment_file}" "${runtime_environment_file}"'));
    assert.match(source.deploy, /mv -Tf "\$\{rollback_environment_file\}" "\$\{runtime_environment_file\}"/);
    assert.match(source.deploy, /previous API release did not recover/);
  });
});
