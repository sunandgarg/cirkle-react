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

export const defaultIitLogo = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
