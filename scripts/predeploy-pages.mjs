import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let status;
let revision;
try {
  status = git("status", "--porcelain", "--untracked-files=all");
  revision = git("rev-parse", "--verify", "HEAD");
} catch {
  throw new Error("Cloudflare Pages deployment requires a valid Git checkout");
}

if (status) {
  throw new Error("Cloudflare Pages deployment refused: commit every tracked and untracked project file first");
}
const ignoredBuildInputs = git(
  "ls-files", "--others", "--ignored", "--exclude-standard", "--",
  "src", "public", "index.html", "vite.config.ts", "tailwind.config.ts", "postcss.config.js",
);
if (ignoredBuildInputs) {
  throw new Error(`Cloudflare Pages deployment refused: ignored build input is not part of the commit:\n${ignoredBuildInputs}`);
}
if (!/^[a-f0-9]{40}$/i.test(revision)) {
  throw new Error("Cloudflare Pages deployment could not resolve an exact commit");
}

console.info(`Deploying Cloudflare Pages from exact commit ${revision}`);
