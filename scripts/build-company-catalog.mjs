import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url).pathname;
const assetDirectory = join(projectRoot, "public/company-logos");
const outputFile = join(projectRoot, "src/data/topCompanies.ts");
const publicCatalogFile = join(projectRoot, "public/company-catalog.json");
const temporaryDirectory = join(projectRoot, ".company-catalog-tmp");
const sourceOrigin = "https://companiesmarketcap.com";
const rankedCompanyLimit = 11_000;
const companiesPerPage = 100;
const customCompanies = [
  {
    rank: rankedCompanyLimit + 1,
    name: "Louis Stitch",
    ticker: "LOUIS-STITCH",
    logoUrl: "https://www.louisstitch.com/cdn/shop/files/346093837_995271755179836_459868386235006090_n_1.jpg?v=1688705321&width=1080",
  },
  {
    rank: rankedCompanyLimit + 2,
    name: "DekhoCampus",
    ticker: "DEKHOCAMPUS",
    logoUrl: "https://ui.dekhocampus.com/favicon.png",
  },
  {
    rank: rankedCompanyLimit + 3,
    name: "Cirkle",
    ticker: "CIRKLE",
    localLogo: join(projectRoot, "public/cirkle-logo.png"),
  },
];
const rankedLogoOverrides = new Map([
  ["Gens Aurea", "https://www.gens-aurea.it/wp-content/uploads/2021/11/logo_gensaurea.png"],
  ["LSL Property Services plc", "https://www.lslps.co.uk/images/logo.png"],
  ["pferdewetten.de AG", "https://www.google.com/s2/favicons?domain=pferdewetten.ag&sz=128"],
]);
const unavailableLogos = [];

const decodeHtml = (value) => value
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ")
  .trim();

const slugify = (value) => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 70) || "company";

const fetchBuffer = async (url, attempts = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Cirkle company catalog builder/1.0" } });
      const body = Buffer.from(await response.arrayBuffer());
      const returnedImage = response.headers.get("content-type")?.startsWith("image/");
      if (!response.ok && !returnedImage) throw new Error(`${response.status} ${response.statusText}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
};

const parseCompanies = (html) => [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].flatMap(([row]) => {
  const rank = Number(row.match(/class="rank-td[^\"]*"[^>]*data-sort="(\d+)"/)?.[1]);
  const name = decodeHtml(row.match(/class="company-name">([\s\S]*?)<\/div>/)?.[1] || "");
  const ticker = decodeHtml(row.match(/class="company-code">[\s\S]*?<\/span>([\s\S]*?)<\/div>/)?.[1] || "");
  const logoPath = row.match(/class="company-logo"[^>]*src="([^"]+)"/)?.[1] || "";
  if (!rank || !name || !logoPath || rank > rankedCompanyLimit) return [];
  return [{ rank, name, ticker, logoPath }];
});

const runPool = async (items, concurrency, worker) => {
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
};

await mkdir(assetDirectory, { recursive: true });
await mkdir(temporaryDirectory, { recursive: true });

const placeholderFileName = "company-placeholder.webp";
const placeholderPath = join(assetDirectory, placeholderFileName);
try {
  await readFile(placeholderPath);
} catch {
  const width = 96;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const isBuilding = x >= 24 && x <= 71 && y >= 18 && y <= 78;
      const isWindow = isBuilding && x % 16 >= 5 && x % 16 <= 10 && y % 16 >= 5 && y % 16 <= 10;
      const color = isBuilding && !isWindow ? [32, 105, 181] : [237, 244, 251];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  const ppmPath = join(temporaryDirectory, "company-placeholder.ppm");
  await writeFile(ppmPath, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  await execFileAsync("cwebp", ["-quiet", "-lossless", ppmPath, "-o", placeholderPath]);
}

const companies = [];
for (let page = 1; page <= Math.ceil(rankedCompanyLimit / companiesPerPage); page += 1) {
  const pageUrl = page === 1 ? `${sourceOrigin}/` : `${sourceOrigin}/page/${page}/`;
  const html = (await fetchBuffer(pageUrl)).toString("utf8");
  companies.push(...parseCompanies(html));
}

const rankedCompanies = [...new Map(companies.sort((a, b) => a.rank - b.rank).map((company) => [company.rank, company])).values()]
  .filter((company) => company.rank <= rankedCompanyLimit);

if (rankedCompanies.length !== rankedCompanyLimit || rankedCompanies.some((company, index) => company.rank !== index + 1)) {
  throw new Error(`Expected ranks 1-${rankedCompanyLimit}, received ${rankedCompanies.length} complete records.`);
}

await runPool(rankedCompanies, 24, async (company) => {
  const fileName = `${String(company.rank).padStart(4, "0")}-${slugify(company.ticker || company.name)}.webp`;
  const outputPath = join(assetDirectory, fileName);
  try {
    try {
      await readFile(outputPath);
    } catch {
      const sourceUrl = rankedLogoOverrides.get(company.name) || new URL(company.logoPath, sourceOrigin).toString();
      const possibleExtension = basename(new URL(sourceUrl).pathname).split(".").pop()?.split("?")[0];
      const sourceExtension = /^(png|jpe?g|webp)$/i.test(possibleExtension || "") ? possibleExtension : "png";
      const temporaryPath = join(temporaryDirectory, `${company.rank}.${sourceExtension}`);
      await writeFile(temporaryPath, await fetchBuffer(sourceUrl));
      await execFileAsync("cwebp", ["-quiet", "-q", "82", "-m", "6", "-alpha_q", "90", temporaryPath, "-o", outputPath]);
    }
    company.logo = `/company-logos/${fileName}`;
  } catch (error) {
    unavailableLogos.push({ rank: company.rank, name: company.name, source: company.logoPath, error: String(error) });
    company.logo = `/company-logos/${placeholderFileName}`;
  }
});

await runPool(customCompanies, 3, async (company) => {
  const fileName = `${company.rank}-${slugify(company.ticker || company.name)}.webp`;
  const outputPath = join(assetDirectory, fileName);
  try {
    await readFile(outputPath);
  } catch {
    const source = company.localLogo
      ? await readFile(company.localLogo)
      : await fetchBuffer(company.logoUrl);
    const sourceExtension = company.localLogo
      ? basename(company.localLogo).split(".").pop()
      : basename(new URL(company.logoUrl).pathname).split(".").pop();
    const temporaryPath = join(temporaryDirectory, `${company.rank}.${sourceExtension || "png"}`);
    await writeFile(temporaryPath, source);
    await execFileAsync("cwebp", ["-quiet", "-q", "82", "-m", "6", "-alpha_q", "90", temporaryPath, "-o", outputPath]);
  }
  company.logo = `/company-logos/${fileName}`;
});

const catalogCompanies = [...rankedCompanies, ...customCompanies]
  .map(({ rank, name, ticker, logo }) => ({ rank, name, ticker, logo }));
const expectedAssets = new Set(catalogCompanies.map(({ logo }) => basename(logo)));
await Promise.all((await readdir(assetDirectory))
  .filter((fileName) => fileName.endsWith(".webp") && !expectedAssets.has(fileName))
  .map((fileName) => unlink(join(assetDirectory, fileName))));

const generated = `// Generated by scripts/build-company-catalog.mjs from the public market-cap ranking.\n` +
  `// Logos identify their respective trademark owners and do not imply endorsement.\n` +
  `export interface TopCompany { rank: number; name: string; ticker: string; logo: string }\n\n` +
  `export const topCompanies: TopCompany[] = ${JSON.stringify(catalogCompanies, null, 2)};\n`;

await writeFile(outputFile, generated);
await writeFile(publicCatalogFile, JSON.stringify(catalogCompanies));
await rm(temporaryDirectory, { recursive: true, force: true });
console.log(`Generated ${rankedCompanies.length} ranked companies, ${customCompanies.length} Cirkle companies, and WebP logos.`);
if (unavailableLogos.length > 0) {
  console.warn(`${unavailableLogos.length} upstream logos were unavailable and use the local company placeholder.`);
  console.warn(JSON.stringify(unavailableLogos, null, 2));
}
