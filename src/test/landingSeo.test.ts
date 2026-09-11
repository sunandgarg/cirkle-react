import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("public market positioning", () => {
  it("positions Cirkle as an open, verified community network in static metadata", () => {
    const html = projectFile("index.html");
    const landing = projectFile("src/pages/Landing.tsx");
    expect(html).toContain("Cirkle - Shared context before the first hello");
    expect(landing).toContain('title: "Cirkle - Shared context before the first hello"');
    expect(html).toContain("Cirkle is a verified community networking platform for focused conversations, trusted connections, relevant opportunities, events and expert access.");
    expect(landing).toContain('description: "Cirkle is a verified community networking platform for focused conversations, trusted connections, relevant opportunities, events and expert access."');
    expect(html).toContain("Where your community becomes your network");
    expect(html).toContain("verified community networking platform");
    expect(html.toLowerCase()).not.toContain("invite-only");
    expect(html).not.toContain("IIT Community Forum, Jobs, Consult & Events");
  });

  it("publishes only genuinely public routes in the sitemap", () => {
    const robots = projectFile("public/robots.txt");
    const sitemap = projectFile("public/sitemap.xml");
    expect(robots).toContain("Sitemap: https://cirkle.world/sitemap.xml");
    expect(sitemap).toContain("https://cirkle.world/");
    expect(sitemap).toContain("https://cirkle.world/privacy");
    expect(sitemap).toContain("https://cirkle.world/terms");
    expect(sitemap).not.toContain("https://cirkle.world/jobs");
    expect(sitemap).not.toContain("https://cirkle.world/blogs");
  });

  it("keeps invite-only positioning out of the public landing and sign-in experience", () => {
    const landing = projectFile("src/pages/Landing.tsx");
    const auth = projectFile("src/pages/Auth.tsx");
    expect(`${landing}\n${auth}`.toLowerCase()).not.toContain("invite-only");
    expect(landing).toContain("Our journey");
    expect(landing).toContain("Voices shaping Cirkle");
  });

  it("keeps the public experience lightweight and respectful of motion preferences", () => {
    const landing = projectFile("src/pages/Landing.tsx");
    const styles = projectFile("src/pages/landing.css");
    const packageJson = projectFile("package.json");

    expect(landing).toContain('reducedMotion="user"');
    expect(landing).toContain("useReducedMotion");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation: none !important");
    expect(packageJson).not.toContain('"three"');
    expect(packageJson).not.toContain('"@react-three/fiber"');
  });
});
