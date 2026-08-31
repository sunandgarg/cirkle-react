export interface CompanyCatalogOption {
  category?: string | null;
  value?: string | null;
  status?: string | null;
  created_by?: string | null;
  logo_url?: string | null;
  id?: string | null;
}

const normalizeCompany = (value?: string | null) => value?.trim().replace(/\s+/g, " ").toLocaleLowerCase() || "";

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

