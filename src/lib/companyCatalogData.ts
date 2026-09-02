export interface CompanyCatalogRecord {
  rank: number;
  name: string;
  ticker: string;
  logo: string;
}

let catalogPromise: Promise<CompanyCatalogRecord[]> | null = null;

export const loadCompanyCatalog = () => {
  if (!catalogPromise) {
    catalogPromise = fetch("/company-catalog.json", { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Company catalog request failed (${response.status})`);
        return response.json() as Promise<CompanyCatalogRecord[]>;
      })
      .catch((error) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
};
