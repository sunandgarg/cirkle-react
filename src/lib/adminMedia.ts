export function versionedInstituteLogoPath(domain: string, version: string = crypto.randomUUID()): string {
  const stem = domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!stem) throw new Error("A valid institute domain is required");
  const safeVersion = version.replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeVersion) throw new Error("A valid logo version is required");
  return `${stem}-${safeVersion}.webp`;
}
