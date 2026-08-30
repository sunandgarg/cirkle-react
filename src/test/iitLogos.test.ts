import { describe, expect, it } from "vitest";
import { defaultIitLogo } from "@/data/iitInstitutes";

const allIitLogoMappings = {
  "iitb.ac.in": "iit-bombay.webp",
  "iitd.ac.in": "iit-delhi.webp",
  "iitm.ac.in": "iit-madras.webp",
  "iitk.ac.in": "iit-kanpur.webp",
  "iitkgp.ac.in": "iit-kharagpur.webp",
  "iitr.ac.in": "iit-roorkee.webp",
  "iitg.ac.in": "iit-guwahati.webp",
  "iith.ac.in": "iit-hyderabad.webp",
  "iitbhu.ac.in": "iit-bhu.webp",
  "iiti.ac.in": "iit-indore.webp",
  "iitrpr.ac.in": "iit-ropar.webp",
  "iitp.ac.in": "iit-patna.webp",
  "iitbbs.ac.in": "iit-bhubaneswar.webp",
  "iitgn.ac.in": "iit-gandhinagar.webp",
  "iitj.ac.in": "iit-jodhpur.webp",
  "iitmandi.ac.in": "iit-mandi.webp",
  "iittp.ac.in": "iit-tirupati.webp",
  "iitpkd.ac.in": "iit-palakkad.webp",
  "iitdh.ac.in": "iit-dharwad.webp",
  "iitbhilai.ac.in": "iit-bhilai.webp",
  "iitgoa.ac.in": "iit-goa.webp",
  "iitjammu.ac.in": "iit-jammu.webp",
  "iitism.ac.in": "iit-dhanbad.webp",
} as const;

describe("all IIT logos", () => {
  it("maps all 23 institutes to the correct versioned bundled asset", () => {
    expect(Object.keys(allIitLogoMappings)).toHaveLength(23);
    for (const [domain, filename] of Object.entries(allIitLogoMappings)) {
      expect(defaultIitLogo(domain)).toMatch(new RegExp(`/iit-logos/${filename}\\?v=\\d{8}-\\d+$`));
    }
  });

  it("does not reuse one institute asset for another", () => {
    const urls = Object.keys(allIitLogoMappings).map(defaultIitLogo);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
