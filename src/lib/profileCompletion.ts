type ProfileLike = Record<string, unknown> | null | undefined;

export type ProfileCompletionItem = {
  key: string;
  label: string;
  complete: boolean;
};

const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export const getProfileCompletion = (profile: ProfileLike) => {
  const skills = profile?.skills;
  const items: ProfileCompletionItem[] = [
    { key: "name", label: "full name", complete: hasText(profile?.name) },
    { key: "phone", label: "phone number", complete: hasText(profile?.phone_number) },
    { key: "headline", label: "headline", complete: hasText(profile?.headline) },
    { key: "bio", label: "about section", complete: hasText(profile?.bio) },
    { key: "location", label: "location", complete: hasText(profile?.location) },
    { key: "skills", label: "skills", complete: Array.isArray(skills) && skills.length > 0 },
    { key: "education", label: "education", complete: hasText(profile?.primary_education_id) },
    { key: "iit", label: "institute", complete: hasText(profile?.iit_name) },
    { key: "status", label: "member status", complete: hasText(profile?.student_status) },
    { key: "avatar", label: "profile photo", complete: hasText(profile?.avatar_url) },
    { key: "cover", label: "cover photo", complete: hasText(profile?.cover_photo_url) },
  ];
  const completed = items.filter((item) => item.complete).length;
  return {
    items,
    missing: items.filter((item) => !item.complete),
    completed,
    total: items.length,
    percent: Math.round((completed / items.length) * 100),
  };
};

export const nextProfileReminder = (dismissals: number, now: number) => {
  const nextDismissals = Math.min(2, dismissals + 1);
  return {
    dismissals: nextDismissals,
    nextAt: nextDismissals === 1 ? now + 5 * 60_000 : null,
  };
};
