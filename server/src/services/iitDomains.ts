export const instituteDomains: Record<string, readonly [student: string, alumni: string]> = {
  "IIT Delhi": ["iitd.ac.in", "alumni.iitd.ac.in"], "IIT Bombay": ["iitb.ac.in", "alumni.iitb.ac.in"],
  "IIT Madras": ["iitm.ac.in", "alumni.iitm.ac.in"], "IIT Kanpur": ["iitk.ac.in", "alumni.iitk.ac.in"],
  "IIT Kharagpur": ["iitkgp.ac.in", "alumni.iitkgp.ac.in"], "IIT Roorkee": ["iitr.ac.in", "alumni.iitr.ac.in"],
  "IIT Guwahati": ["iitg.ac.in", "alumni.iitg.ac.in"], "IIT Hyderabad": ["iith.ac.in", "alumni.iith.ac.in"],
  "IIT BHU": ["iitbhu.ac.in", "alumni.iitbhu.ac.in"], "IIT Indore": ["iiti.ac.in", "alumni.iiti.ac.in"],
  "IIT Ropar": ["iitrpr.ac.in", "alumni.iitrpr.ac.in"], "IIT Patna": ["iitp.ac.in", "alumni.iitp.ac.in"],
  "IIT Bhubaneswar": ["iitbbs.ac.in", "alumni.iitbbs.ac.in"], "IIT Gandhinagar": ["iitgn.ac.in", "alumni.iitgn.ac.in"],
  "IIT Jodhpur": ["iitj.ac.in", "alumni.iitj.ac.in"], "IIT Mandi": ["iitmandi.ac.in", "alumni.iitmandi.ac.in"],
  "IIT Tirupati": ["iittp.ac.in", "alumni.iittp.ac.in"], "IIT Palakkad": ["iitpkd.ac.in", "alumni.iitpkd.ac.in"],
  "IIT Dharwad": ["iitdh.ac.in", "alumni.iitdh.ac.in"], "IIT Bhilai": ["iitbhilai.ac.in", "alumni.iitbhilai.ac.in"],
  "IIT Goa": ["iitgoa.ac.in", "alumni.iitgoa.ac.in"], "IIT Jammu": ["iitjammu.ac.in", "alumni.iitjammu.ac.in"],
  "IIT Dhanbad (ISM)": ["iitism.ac.in", "alumni.iitism.ac.in"],
};

const iitEmailDomains = new Set(Object.values(instituteDomains).flat());

export function isIitEmailAddress(email: string): boolean {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return false;
  return iitEmailDomains.has(email.slice(separator + 1).trim().toLowerCase());
}
