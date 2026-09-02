export const JOB_EXPERIENCE_BUCKETS = [
  "Internship",
  "0-1 years",
  "1-2 years",
  "2-3 years",
  "3-5 years",
  "5-7 years",
  "7+ years",
] as const;

export const TRUSTED_JOB_DOMAINS = [
  "amazon.jobs",
  "jobs.apple.com",
  "careers.google.com",
  "jobs.careers.microsoft.com",
  "careers.adobe.com",
  "careers.atlassian.com",
  "careers.ibm.com",
  "careers.oracle.com",
  "careers.salesforce.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
] as const;

export const IIT_EVENT_SOURCES = [
  { name: "IIT Bombay", domain: "iitb.ac.in" },
  { name: "IIT Delhi", domain: "iitd.ac.in" },
  { name: "IIT Madras", domain: "iitm.ac.in" },
  { name: "IIT Kanpur", domain: "iitk.ac.in" },
  { name: "IIT Kharagpur", domain: "iitkgp.ac.in" },
  { name: "IIT Roorkee", domain: "iitr.ac.in" },
  { name: "IIT Guwahati", domain: "iitg.ac.in" },
  { name: "IIT Hyderabad", domain: "iith.ac.in" },
  { name: "IIT BHU", domain: "iitbhu.ac.in" },
  { name: "IIT Indore", domain: "iiti.ac.in" },
  { name: "IIT Ropar", domain: "iitrpr.ac.in" },
  { name: "IIT Patna", domain: "iitp.ac.in" },
  { name: "IIT Bhubaneswar", domain: "iitbbs.ac.in" },
  { name: "IIT Gandhinagar", domain: "iitgn.ac.in" },
  { name: "IIT Jodhpur", domain: "iitj.ac.in" },
  { name: "IIT Mandi", domain: "iitmandi.ac.in" },
  { name: "IIT Tirupati", domain: "iittp.ac.in" },
  { name: "IIT Palakkad", domain: "iitpkd.ac.in" },
  { name: "IIT Dharwad", domain: "iitdh.ac.in" },
  { name: "IIT Bhilai", domain: "iitbhilai.ac.in" },
  { name: "IIT Goa", domain: "iitgoa.ac.in" },
  { name: "IIT Jammu", domain: "iitjammu.ac.in" },
  { name: "IIT Dhanbad (ISM)", domain: "iitism.ac.in" },
] as const;

export const hostnameMatchesDomain = (rawUrl: string, allowedDomain: string) => {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    const domain = allowedDomain.toLowerCase().replace(/^www\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
};

export const hostnameMatchesAnyDomain = (rawUrl: string, allowedDomains: readonly string[]) =>
  allowedDomains.some((domain) => hostnameMatchesDomain(rawUrl, domain));

export const normalizeExperienceBucket = (value: string | null | undefined) => {
  const text = (value || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (/intern|trainee/.test(text)) return "Internship";
  const numbers = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (/7\s*\+|7\s*(?:plus|or more)|senior|lead|principal|director/.test(text) || numbers.some((number) => number > 7)) return "7+ years";
  const lower = numbers[0] ?? 0;
  const upper = numbers[1] ?? lower;
  if (lower <= 0 && upper <= 1) return "0-1 years";
  if (lower <= 1 && upper <= 2) return "1-2 years";
  if (lower <= 2 && upper <= 3) return "2-3 years";
  if (lower <= 3 && upper <= 5) return "3-5 years";
  if (lower <= 5 && upper <= 7) return "5-7 years";
  return lower >= 7 ? "7+ years" : "0-1 years";
};

export const getIitEventSource = (name: string) =>
  IIT_EVENT_SOURCES.find((source) => source.name === name) || null;

export const useSmallDashes = (value: string) => value.replace(/[–—]/g, "-");

const titleCaseSlug = (value: string) => value
  .split(/[-_]+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

export const companyFromJobUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const knownCompanies: Record<string, string> = {
      "amazon.jobs": "Amazon",
      "jobs.apple.com": "Apple",
      "careers.google.com": "Google",
      "jobs.careers.microsoft.com": "Microsoft",
      "careers.adobe.com": "Adobe",
      "careers.atlassian.com": "Atlassian",
      "careers.ibm.com": "IBM",
      "careers.oracle.com": "Oracle",
      "careers.salesforce.com": "Salesforce",
    };
    const known = Object.entries(knownCompanies).find(([domain]) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (known) return known[1];
    if (["jobs.lever.co", "boards.greenhouse.io", "job-boards.greenhouse.io"].includes(hostname)) {
      const slug = url.pathname.split("/").filter(Boolean)[0];
      if (slug) return titleCaseSlug(slug);
    }
    return titleCaseSlug(hostname.split(".")[0]) || "Company";
  } catch {
    return "Company";
  }
};
