export const MENTOR_CATEGORIES = [
  "Career Guidance",
  "Interview Preparation",
  "Resume & LinkedIn Review",
  "Software Engineering",
  "Data Science & AI",
  "Product Management",
  "Management Consulting",
  "Finance & Investing",
  "Marketing & Growth",
  "Design & UX",
  "Entrepreneurship & Startups",
  "Leadership & Management",
  "Sales & Business Development",
  "Study Abroad & Higher Education",
  "Academic Guidance",
] as const;

export const SOCIAL_FIELDS = [
  { key: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/in/..." },
  { key: "x", label: "X", placeholder: "https://x.com/..." },
  { key: "github", label: "GitHub", placeholder: "https://github.com/..." },
  { key: "website", label: "Website", placeholder: "https://your-site.com" },
  { key: "instagram", label: "Instagram", placeholder: "https://instagram.com/..." },
] as const;

export type CustomSocialLink = { id: string; label: string; url: string };

export const safeExternalUrl = (input: string): string => {
  const value = input.trim();
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Links must use http or https');
  return parsed.toString();
};

export const readSocialLinks = (links: Record<string, unknown> | null | undefined) => {
  const fixed: Record<string, string> = {};
  const custom: CustomSocialLink[] = [];
  Object.entries(links || {}).forEach(([key, rawValue]) => {
    if (typeof rawValue !== 'string' || !rawValue) return;
    if (key === 'twitter') fixed.x ||= rawValue;
    else if (key.startsWith('custom:')) custom.push({ id: crypto.randomUUID(), label: key.slice(7), url: rawValue });
    else fixed[key] = rawValue;
  });
  return { fixed, custom };
};

export const buildSocialLinks = (fixed: Record<string, string>, custom: CustomSocialLink[]) => {
  const output: Record<string, string> = {};
  SOCIAL_FIELDS.forEach(({ key }) => {
    const value = safeExternalUrl(fixed[key] || '');
    if (value) output[key] = value;
  });
  custom.forEach(({ label, url }, index) => {
    const cleanLabel = label.trim().replace(/[:\n\r]/g, ' ').slice(0, 40);
    const cleanUrl = safeExternalUrl(url);
    if (!cleanLabel || !cleanUrl) return;
    output[`custom:${cleanLabel || `Link ${index + 1}`}`] = cleanUrl;
  });
  return output;
};

export const socialLabel = (key: string) => {
  if (key === 'x' || key === 'twitter') return 'X';
  if (key.startsWith('custom:')) return key.slice(7);
  if (key === 'github') return 'GitHub';
  return key.charAt(0).toUpperCase() + key.slice(1);
};
