import { topCompanies } from "@/data/topCompanies";

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
for (const company of topCompanies) {
  companyLogoIndex.set(normalizeCompany(company.name), company.logo);
  companyLogoIndex.set(simplifiedCompany(company.name), company.logo);
  const parentheticalNames = [...company.name.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]);
  parentheticalNames.forEach((name) => companyLogoIndex.set(normalizeCompany(name), company.logo));
}

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
  return companyLogoIndex.get(normalized)
    || companyLogoIndex.get(simplifiedCompany(company))
    || (alias ? companyLogoIndex.get(normalizeCompany(alias)) : undefined)
    || null;
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
