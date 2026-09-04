import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("public market positioning", () => {
  it("positions Cirkle as a community-specific network in static metadata", () => {
    const html = projectFile("index.html");
    expect(html).toContain("Invite-only community-specific networking");
    expect(html).toContain("private networking platform for verified communities");
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
});
