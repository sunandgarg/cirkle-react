import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const recruiterFile = join(root, "scripts/data/iit-recruiters.json");
const catalogFile = join(root, "public/company-catalog.json");
const typescriptFile = join(root, "src/data/topCompanies.ts");
const logoDirectory = join(root, "public/company-logos");
const placeholderLogo = "/company-logos/company-placeholder.webp";

const normalize = (value) => String(value || "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ")
  .replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
const simplify = (value) => normalize(value)
  .replace(/\b(the|limited|ltd|incorporated|inc|corporation|corp|company|co|plc|group|holdings|holding|sa|se|ag|nv|india|pvt|private)\b/g, " ")
  .trim().replace(/\s+/g, " ");
const slugify = (value) => normalize(value).replace(/\s+/g, "-").slice(0, 70) || "recruiter";

const fetchLogo = async (domain, outputPath) => {
  const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, {
    headers: { "User-Agent": "Cirkle recruiter catalog/1.0" },
  });
  if (!response.ok) throw new Error(`favicon ${response.status}`);
  const source = `${outputPath}.png`;
  await writeFile(source, Buffer.from(await response.arrayBuffer()));
  try {
    await execFileAsync("cwebp", ["-quiet", "-q", "84", "-m", "6", "-alpha_q", "90", source, "-o", outputPath]);
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(source).catch(() => undefined));
  }
};

const runPool = async (items, concurrency, worker) => {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
};

await mkdir(logoDirectory, { recursive: true });
const recruiters = JSON.parse(await readFile(recruiterFile, "utf8"));
const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
const nameIndex = new Map();
for (const company of catalog) {
  nameIndex.set(normalize(company.name), company);
  nameIndex.set(simplify(company.name), company);
}

let nextRank = Math.max(...catalog.map((company) => Number(company.rank) || 0)) + 1;
const additions = [];
for (const row of recruiters) {
  const name = String(row["Company / Recruiter Group"] || "").trim();
  const variants = String(row["Published Name Variants"] || "").split("|").map((value) => value.trim()).filter(Boolean);
  const matched = [name, ...variants].map((value) => nameIndex.get(normalize(value)) || nameIndex.get(simplify(value))).find(Boolean);
  if (matched) {
    matched.iitRecruiter = true;
    matched.iitCount = Number(row["IIT Count"]) || 0;
    matched.careerUrl ||= row["Direct Career / Recruitment Page"] || null;
    continue;
  }
  const careerUrl = row["Direct Career / Recruitment Page"] || null;
  const fileName = `recruiter-${slugify(name)}.webp`;
  const company = {
    rank: nextRank++, name, ticker: "", logo: careerUrl ? `/company-logos/${fileName}` : placeholderLogo,
    iitRecruiter: true, iitCount: Number(row["IIT Count"]) || 0, careerUrl,
    logoStatus: careerUrl ? "official-domain-favicon" : "placeholder-pending-official-source",
  };
  additions.push(company);
  nameIndex.set(normalize(name), company);
  nameIndex.set(simplify(name), company);
}

const logoCandidates = [...catalog, ...additions].filter((company) =>
  company.iitRecruiter && company.careerUrl && company.logoStatus !== undefined,
);
const logoFailures = [];
await runPool(logoCandidates, 12, async (company) => {
  const desiredLogo = `/company-logos/recruiter-${slugify(company.name)}.webp`;
  const outputPath = join(root, "public", desiredLogo.replace(/^\//, ""));
  try {
    await readFile(outputPath);
    company.logo = desiredLogo;
    company.logoStatus = "official-domain-favicon";
  } catch {
    try {
      await fetchLogo(new URL(company.careerUrl).hostname, outputPath);
      company.logo = desiredLogo;
      company.logoStatus = "official-domain-favicon";
    } catch (error) {
      company.logo = placeholderLogo;
      company.logoStatus = "placeholder-fetch-failed";
      logoFailures.push({ name: company.name, error: String(error) });
    }
  }
});

const merged = [...catalog, ...additions];
const generated = `// Generated company catalog. Logos identify their respective trademark owners and do not imply endorsement.\n` +
  `export interface TopCompany { rank: number; name: string; ticker: string; logo: string; iitRecruiter?: boolean; iitCount?: number; careerUrl?: string | null; logoStatus?: string }\n\n` +
  `export const topCompanies = JSON.parse(${JSON.stringify(JSON.stringify(merged))}) as TopCompany[];\n`;
await writeFile(catalogFile, JSON.stringify(merged));
await writeFile(typescriptFile, generated);

console.log(JSON.stringify({ workbookRecruiters: recruiters.length, matchedExisting: recruiters.length - additions.length, added: additions.length, catalogSize: merged.length, logoCandidates: logoCandidates.length, logoFailures: logoFailures.length }));
if (logoFailures.length) console.error(JSON.stringify(logoFailures.slice(0, 3)));
