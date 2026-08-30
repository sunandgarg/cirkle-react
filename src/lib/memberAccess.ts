type MemberAccessProfile = {
  is_verified?: boolean | null;
  onboarding_completed?: boolean | null;
} | null;

export type MemberAccessState = "pending" | "verification" | "onboarding" | "ready";

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
  if (!profile.onboarding_completed) return "onboarding";
  return "ready";
};
