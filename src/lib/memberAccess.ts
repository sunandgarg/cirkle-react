type MemberAccessProfile = {
  is_verified?: boolean | null;
  onboarding_completed?: boolean | null;
} | null;

export type MemberAccessState = "pending" | "verification" | "ready";

/**
 * Route only after the server has answered. A missing cache on a new device is
 * not evidence that the member needs to repeat verification.
 */
export const resolveMemberAccessState = (
  profile: MemberAccessProfile,
  profileResolved: boolean,
): MemberAccessState => {
  if (!profileResolved) return "pending";
  if (!profile?.is_verified) return "verification";
  // IIT verification is the security boundary. Profile enrichment is useful,
  // but it must never become a second blocking login gate for a member whose
  // institute identity is already verified.
  return "ready";
};
