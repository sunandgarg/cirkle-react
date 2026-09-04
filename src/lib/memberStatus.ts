export const graduationYear = (value?: string | number | null) => {
  const year = typeof value === "number" ? value : Number(value?.trim());
  return Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null;
};

export const shouldBeAlumni = (passingYear?: string | number | null, asOf = new Date()) => {
  const year = graduationYear(passingYear);
  if (!year) return false;
  // Membership follows the Cirkle community calendar, not the browser's
  // local timezone. India midnight on 1 July is 18:30 UTC on 30 June.
  const ist = new Date(asOf.getTime() + 5.5 * 60 * 60_000);
  const cutoffYear = ist.getUTCMonth() >= 6 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return year <= cutoffYear;
};

export const effectiveMemberStatus = (status?: string | null, passingYear?: string | number | null, asOf = new Date()) => (
  status === "current_student" && shouldBeAlumni(passingYear, asOf) ? "alumni" : status
);
