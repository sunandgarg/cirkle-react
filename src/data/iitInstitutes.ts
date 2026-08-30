export const IIT_LIST = [
  { name: "IIT Bombay", studentDomain: "iitb.ac.in", alumniDomain: "alumni.iitb.ac.in" },
  { name: "IIT Delhi", studentDomain: "iitd.ac.in", alumniDomain: "alumni.iitd.ac.in" },
  { name: "IIT Madras", studentDomain: "iitm.ac.in", alumniDomain: "alumni.iitm.ac.in" },
  { name: "IIT Kanpur", studentDomain: "iitk.ac.in", alumniDomain: "alumni.iitk.ac.in" },
  { name: "IIT Kharagpur", studentDomain: "iitkgp.ac.in", alumniDomain: "alumni.iitkgp.ac.in" },
  { name: "IIT Roorkee", studentDomain: "iitr.ac.in", alumniDomain: "alumni.iitr.ac.in" },
  { name: "IIT Guwahati", studentDomain: "iitg.ac.in", alumniDomain: "alumni.iitg.ac.in" },
  { name: "IIT Hyderabad", studentDomain: "iith.ac.in", alumniDomain: "alumni.iith.ac.in" },
  { name: "IIT BHU", studentDomain: "iitbhu.ac.in", alumniDomain: "alumni.iitbhu.ac.in" },
  { name: "IIT Indore", studentDomain: "iiti.ac.in", alumniDomain: "alumni.iiti.ac.in" },
  { name: "IIT Ropar", studentDomain: "iitrpr.ac.in", alumniDomain: "alumni.iitrpr.ac.in" },
  { name: "IIT Patna", studentDomain: "iitp.ac.in", alumniDomain: "alumni.iitp.ac.in" },
  { name: "IIT Bhubaneswar", studentDomain: "iitbbs.ac.in", alumniDomain: "alumni.iitbbs.ac.in" },
  { name: "IIT Gandhinagar", studentDomain: "iitgn.ac.in", alumniDomain: "alumni.iitgn.ac.in" },
  { name: "IIT Jodhpur", studentDomain: "iitj.ac.in", alumniDomain: "alumni.iitj.ac.in" },
  { name: "IIT Mandi", studentDomain: "iitmandi.ac.in", alumniDomain: "alumni.iitmandi.ac.in" },
  { name: "IIT Tirupati", studentDomain: "iittp.ac.in", alumniDomain: "alumni.iittp.ac.in" },
  { name: "IIT Palakkad", studentDomain: "iitpkd.ac.in", alumniDomain: "alumni.iitpkd.ac.in" },
  { name: "IIT Dharwad", studentDomain: "iitdh.ac.in", alumniDomain: "alumni.iitdh.ac.in" },
  { name: "IIT Bhilai", studentDomain: "iitbhilai.ac.in", alumniDomain: "alumni.iitbhilai.ac.in" },
  { name: "IIT Goa", studentDomain: "iitgoa.ac.in", alumniDomain: "alumni.iitgoa.ac.in" },
  { name: "IIT Jammu", studentDomain: "iitjammu.ac.in", alumniDomain: "alumni.iitjammu.ac.in" },
  { name: "IIT Dhanbad (ISM)", studentDomain: "iitism.ac.in", alumniDomain: "alumni.iitism.ac.in" },
] as const;

export type IitInstitute = (typeof IIT_LIST)[number];
export type IitMemberStatus = "current_student" | "alumni";

export const expectedIitEmailDomain = (iit: IitInstitute, status: IitMemberStatus) =>
  status === "alumni" ? iit.alumniDomain : iit.studentDomain;

export const isMatchingIitEmail = (email: string, iit: IitInstitute, status: IitMemberStatus) => {
  const match = email.trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  return match?.[1] === expectedIitEmailDomain(iit, status);
};

export const iitLogoSettingKey = (domain: string) => `iit_logo_${domain.replace(/[^a-z0-9]/gi, "_")}`;

const IIT_LOGOS: Record<string, string> = {
  "iitb.ac.in": "/iit-logos/iit-bombay.webp",
  "iitd.ac.in": "/iit-logos/iit-delhi.webp",
  "iitm.ac.in": "/iit-logos/iit-madras.webp",
  "iitk.ac.in": "/iit-logos/iit-kanpur.webp",
  "iitkgp.ac.in": "/iit-logos/iit-kharagpur.webp",
  "iitr.ac.in": "/iit-logos/iit-roorkee.webp",
  "iitg.ac.in": "/iit-logos/iit-guwahati.webp",
  "iith.ac.in": "/iit-logos/iit-hyderabad.webp",
  "iitbhu.ac.in": "/iit-logos/iit-bhu.webp",
  "iiti.ac.in": "/iit-logos/iit-indore.webp",
  "iitrpr.ac.in": "/iit-logos/iit-ropar.webp",
  "iitp.ac.in": "/iit-logos/iit-patna.webp",
  "iitbbs.ac.in": "/iit-logos/iit-bhubaneswar.webp",
  "iitgn.ac.in": "/iit-logos/iit-gandhinagar.webp",
  "iitj.ac.in": "/iit-logos/iit-jodhpur.webp",
  "iitmandi.ac.in": "/iit-logos/iit-mandi.webp",
  "iittp.ac.in": "/iit-logos/iit-tirupati.webp",
  "iitpkd.ac.in": "/iit-logos/iit-palakkad.webp",
  "iitdh.ac.in": "/iit-logos/iit-dharwad.webp",
  "iitbhilai.ac.in": "/iit-logos/iit-bhilai.webp",
  "iitgoa.ac.in": "/iit-logos/iit-goa.webp",
  "iitjammu.ac.in": "/iit-logos/iit-jammu.webp",
  "iitism.ac.in": "/iit-logos/iit-dhanbad.webp",
};

// Version local logo URLs when bundled artwork changes. The image service
// worker is intentionally cache-first, so a versioned request prevents a
// returning member from seeing an older institute mark on the first load.
const IIT_LOGO_ASSET_VERSION = "20260830-3";

export const defaultIitLogo = (domain: string) => {
  const logo = IIT_LOGOS[domain];
  return logo ? `${logo}?v=${IIT_LOGO_ASSET_VERSION}` : "/cirkle-logo.png";
};
