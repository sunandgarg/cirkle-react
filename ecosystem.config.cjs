const path = require("node:path");

const appRoot = path.resolve(__dirname);
const envFile = process.env.CIRKLE_ENV_FILE || "/etc/cirkle/api.env";
const logDir = process.env.CIRKLE_LOG_DIR || path.join(appRoot, ".local", "pm2-logs");

module.exports = {
  apps: [
    {
      name: "cirkle-api",
      cwd: appRoot,
      script: "server/dist/index.js",
      interpreter: "node",
      node_args: [`--env-file=${envFile}`, "--enable-source-maps"],
      exec_mode: "fork",
      // Socket.IO currently uses in-process subscriptions. Keep one process
      // until a shared adapter and sticky sessions are deliberately added.
      instances: 1,
      env: {
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        PORT: "3001",
        TRUST_PROXY_HOPS: "0",
      },
      env_production: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3001",
        TRUST_PROXY_HOPS: "1",
      },
      autorestart: true,
      watch: false,
      max_memory_restart: "768M",
      min_uptime: "10s",
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      kill_timeout: 15000,
      time: true,
      merge_logs: true,
      out_file: path.join(logDir, "api.out.log"),
      error_file: path.join(logDir, "api.error.log"),
      source_map_support: true,
    },
  ],
};
