import { loadCompanyCatalog, type CompanyCatalogRecord } from "@/lib/companyCatalogData";

export interface CompanyCatalogOption {
  category?: string | null;
  value?: string | null;
  status?: string | null;
  created_by?: string | null;
  logo_url?: string | null;
  id?: string | null;
}

const normalizeCompany = (value?: string | null) => value
  ?.normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ")
  .toLocaleLowerCase() || "";

const simplifiedCompany = (value?: string | null) => normalizeCompany(value)
  .replace(/\b(the|limited|ltd|incorporated|inc|corporation|corp|company|co|plc|group|holdings|holding|sa|se|ag|nv)\b/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const companyLogoIndex = new Map<string, string>();
const featuredCompanyLogos = new Map<string, string>([
  [normalizeCompany("Neuron7"), "/company-logos/custom-neuron7.webp"],
  [normalizeCompany("Kobie"), "/company-logos/custom-kobie.webp"],
  [normalizeCompany("Hevo Data"), "/company-logos/active-hevo-data.webp"],
  [normalizeCompany("Weekday"), "/company-logos/active-weekday.webp"],
  [normalizeCompany("Weekdayworks"), "/company-logos/active-weekday.webp"],
  [normalizeCompany("Acceldata"), "/company-logos/active-acceldata.webp"],
  [normalizeCompany("Brafton"), "/company-logos/active-brafton.webp"],
  [normalizeCompany("Dozee"), "/company-logos/active-dozee.webp"],
  [normalizeCompany("Teikametrics"), "/company-logos/active-teikametrics.webp"],
  [normalizeCompany("Doola"), "/company-logos/active-doola.webp"],
  [normalizeCompany("Paytmpayments"), "/company-logos/active-paytm-payments.webp"],
  [normalizeCompany("Margo Group"), "/company-logos/active-margo-group.webp"],
  [normalizeCompany("Embed"), "/company-logos/active-embed.webp"],
  [normalizeCompany("Zimperium"), "/company-logos/active-zimperium.webp"],
  [normalizeCompany("Everbridge"), "/company-logos/active-everbridge.webp"],
  [normalizeCompany("3pillarglobal"), "/company-logos/active-three-pillar-global.webp"],
  [normalizeCompany("Brillio 2"), "/company-logos/active-brillio.webp"],
  [normalizeCompany("Loop AI"), "/company-logos/active-loop-ai.webp"],
  [normalizeCompany("H1"), "/company-logos/active-h1.webp"],
  [normalizeCompany("JumpCloud"), "/company-logos/active-jumpcloud.webp"],
]);
let companyLogoIndexReady = false;
const indexCompanyLogo = (name: string, logo: string) => {
  if (name && !companyLogoIndex.has(name)) companyLogoIndex.set(name, logo);
};
const indexCompanyLogos = (companies: CompanyCatalogRecord[]) => companies.forEach((company) => {
  indexCompanyLogo(normalizeCompany(company.name), company.logo);
  indexCompanyLogo(simplifiedCompany(company.name), company.logo);
  const parentheticalNames = [...company.name.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  parentheticalNames.forEach((name) => indexCompanyLogo(normalizeCompany(name), company.logo));
});

const companyAliases: Record<string, string> = {
  google: "Alphabet (Google)",
  alphabet: "Alphabet (Google)",
  facebook: "Meta Platforms (Facebook)",
  meta: "Meta Platforms (Facebook)",
  "jp morgan": "JPMorgan Chase",
  "jp morgan chase": "JPMorgan Chase",
  jpmorgan: "JPMorgan Chase",
  twitter: "X Corp.",
  "twitter x": "X Corp.",
  x: "X Corp.",
};

export const getCompanyLogo = (company?: string | null) => {
  const normalized = normalizeCompany(company);
  const alias = companyAliases[normalized];
  return featuredCompanyLogos.get(normalized)
    || companyLogoIndex.get(normalized)
    || companyLogoIndex.get(simplifiedCompany(company))
    || (alias ? companyLogoIndex.get(normalizeCompany(alias)) : undefined)
    || null;
};

export const getCompanyLogoAsync = async (company?: string | null) => {
  const cached = getCompanyLogo(company);
  if (cached || !normalizeCompany(company)) return cached;
  if (!companyLogoIndexReady) {
    indexCompanyLogos(await loadCompanyCatalog());
    companyLogoIndexReady = true;
  }
  return getCompanyLogo(company);
};

export const findCompanyOption = (company: string, options: CompanyCatalogOption[]) => {
  const normalized = normalizeCompany(company);
  if (!normalized) return undefined;
  return options.find((option) => option.category === "company" && normalizeCompany(option.value) === normalized);
};

export const isKnownCompany = (company: string, builtInCompanies: string[], options: CompanyCatalogOption[]) => {
  const normalized = normalizeCompany(company);
  return !!normalized && (
    builtInCompanies.some((item) => normalizeCompany(item) === normalized)
    || !!findCompanyOption(company, options)
  );
};

export const shouldOfferInitialCompanyLogo = (
  company: string,
  isEditingExperience: boolean,
  builtInCompanies: string[],
  options: CompanyCatalogOption[],
) => !isEditingExperience && !!normalizeCompany(company) && !isKnownCompany(company, builtInCompanies, options);
