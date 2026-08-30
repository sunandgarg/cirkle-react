import { describe, expect, it } from "vitest";
import { getProfileCompletion, nextProfileReminder } from "@/lib/profileCompletion";

describe("profile completion reminder", () => {
  it("reports every missing profile section", () => {
    const result = getProfileCompletion({ name: "Sunand", skills: [] });
    expect(result.percent).toBeLessThan(100);
    expect(result.missing.some((item) => item.key === "skills")).toBe(true);
  });

  it("reaches 100 only when every required section is present", () => {
    const result = getProfileCompletion({
      name: "Sunand", phone_number: "9999999999", headline: "Founder", bio: "About",
      location: "Delhi", skills: ["Strategy"], primary_education_id: "edu", iit_name: "IIT Delhi",
      student_status: "alumni", avatar_url: "/avatar.webp", cover_photo_url: "/cover.webp",
    });
    expect(result.percent).toBe(100);
  });

  it("shows once more after five minutes, then stays dismissed for the session", () => {
    expect(nextProfileReminder(0, 1_000)).toEqual({ dismissals: 1, nextAt: 301_000 });
    expect(nextProfileReminder(1, 1_000)).toEqual({ dismissals: 2, nextAt: null });
  });
});
