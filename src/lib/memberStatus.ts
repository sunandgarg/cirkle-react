export const graduationYear = (value?: string | number | null) => {
  const year = typeof value === "number" ? value : Number(value?.trim());
  return Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null;
};

export const shouldBeAlumni = (passingYear?: string | number | null, asOf = new Date()) => {
  const year = graduationYear(passingYear);
  if (!year) return false;
  const transition = new Date(year, 6, 1);
  transition.setHours(0, 0, 0, 0);
  return asOf.getTime() >= transition.getTime();
};

export const effectiveMemberStatus = (status?: string | null, passingYear?: string | number | null, asOf = new Date()) => (
  status === "current_student" && shouldBeAlumni(passingYear, asOf) ? "alumni" : status
);

