import { describe, expect, it } from "vitest";
import {
  IIT_EVENT_SOURCES,
  JOB_EXPERIENCE_BUCKETS,
  TRUSTED_JOB_DOMAINS,
  companyFromJobUrl,
  getIitEventSource,
  hostnameMatchesAnyDomain,
  hostnameMatchesDomain,
  normalizeExperienceBucket,
  useSmallDashes,
} from "../../supabase/functions/_shared/discoveryCatalog";

describe("AI discovery guardrails", () => {
  it("covers every required job experience bucket", () => {
    expect(JOB_EXPERIENCE_BUCKETS).toEqual([
      "Internship", "0-1 years", "1-2 years", "2-3 years",
      "3-5 years", "5-7 years", "7+ years",
    ]);
    expect(normalizeExperienceBucket("summer intern")).toBe("Internship");
    expect(normalizeExperienceBucket("0 to 1 year")).toBe("0-1 years");
    expect(normalizeExperienceBucket("1-2 years")).toBe("1-2 years");
    expect(normalizeExperienceBucket("3 - 5 years")).toBe("3-5 years");
    expect(normalizeExperienceBucket("8 years")).toBe("7+ years");
  });

  it("restricts discovered jobs to trusted career hosts", () => {
    expect(hostnameMatchesAnyDomain("https://jobs.lever.co/company/role", TRUSTED_JOB_DOMAINS)).toBe(true);
    expect(hostnameMatchesAnyDomain("https://careers.example.com/fake-role", TRUSTED_JOB_DOMAINS)).toBe(false);
    expect(companyFromJobUrl("https://jobs.lever.co/jumpcloud/role-id")).toBe("Jumpcloud");
    expect(companyFromJobUrl("https://amazon.jobs/en/jobs/123")).toBe("Amazon");
    expect(useSmallDashes("Role — India – Remote")).toBe("Role - India - Remote");
  });

  it("maps all 23 IITs and accepts their official subdomains", () => {
    expect(IIT_EVENT_SOURCES).toHaveLength(23);
    const delhi = getIitEventSource("IIT Delhi");
    expect(delhi?.domain).toBe("iitd.ac.in");
    expect(hostnameMatchesDomain("https://home.iitd.ac.in/events", delhi!.domain)).toBe(true);
    expect(hostnameMatchesDomain("https://iitd.example.com/events", delhi!.domain)).toBe(false);
  });
});
