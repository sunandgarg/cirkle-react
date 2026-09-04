const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
};

const databaseUrl = new URL(required("DATABASE_URL"));
if (databaseUrl.protocol !== "mysql:") throw new Error("DATABASE_URL must use mysql:");

const normalizedPort = (value) => String(Number(value || "3306"));
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
const expected = {
  host: databaseUrl.hostname.toLowerCase(),
  port: normalizedPort(databaseUrl.port),
  database: databaseName,
};
const backup = {
  host: required("MYSQL_BACKUP_HOST").toLowerCase(),
  port: normalizedPort(required("MYSQL_BACKUP_PORT")),
  database: required("MYSQL_BACKUP_DATABASE"),
};

const mismatches = Object.keys(expected).filter((key) => expected[key] !== backup[key]);
if (mismatches.length) {
  throw new Error(`Backup target does not match DATABASE_URL (${mismatches.join(", ")})`);
}

console.info("Backup host, port, and database match the migration target.");
