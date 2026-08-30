import { describe, expect, it } from "vitest";
import { defaultIitLogo } from "@/data/iitInstitutes";

const suppliedLogoMappings = {
  "iitb.ac.in": "iit-bombay.webp",
  "iitm.ac.in": "iit-madras.webp",
  "iitd.ac.in": "iit-delhi.webp",
  "iitbhilai.ac.in": "iit-bhilai.webp",
  "iitbhu.ac.in": "iit-bhu.webp",
  "iitbbs.ac.in": "iit-bhubaneswar.webp",
  "iitdh.ac.in": "iit-dharwad.webp",
  "iitism.ac.in": "iit-dhanbad.webp",
  "iitgn.ac.in": "iit-gandhinagar.webp",
  "iitgoa.ac.in": "iit-goa.webp",
  "iitg.ac.in": "iit-guwahati.webp",
  "iith.ac.in": "iit-hyderabad.webp",
} as const;

describe("supplied IIT logos", () => {
  it("maps every supplied institute to its correct versioned bundled asset", () => {
    for (const [domain, filename] of Object.entries(suppliedLogoMappings)) {
      expect(defaultIitLogo(domain)).toMatch(new RegExp(`/iit-logos/${filename}\\?v=\\d{8}-\\d+$`));
    }
  });

  it("does not reuse one institute asset for another", () => {
    const urls = Object.keys(suppliedLogoMappings).map(defaultIitLogo);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
