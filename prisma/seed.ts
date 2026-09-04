import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.info("Seed skipped: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to bootstrap an owner.");
    return;
  }
  if (password.length < 12) throw new Error("SEED_ADMIN_PASSWORD must contain at least 12 characters");

  const name = process.env.SEED_ADMIN_NAME?.trim() || "Platform Owner";
  const institute = process.env.SEED_ADMIN_IIT?.trim() || "IIT Delhi";
  const degree = process.env.SEED_ADMIN_DEGREE?.trim() || "BTech";
  const specialisation = process.env.SEED_ADMIN_SPECIALISATION?.trim() || "Computer Science & Engineering";
  const passingYear = process.env.SEED_ADMIN_PASSING_YEAR?.trim() || String(new Date().getFullYear());
  const phoneCountryCode = process.env.SEED_ADMIN_PHONE_COUNTRY_CODE?.trim() || "+91";
  const phoneNumber = process.env.SEED_ADMIN_PHONE_NUMBER?.trim() || "9999999999";
  if (!/^\+[0-9]{1,4}$/.test(phoneCountryCode) || !/^[0-9]{10}$/.test(phoneNumber)) {
    throw new Error("Seed phone must use a +country code and a 10-digit local number");
  }
  if (!/^\d{4}$/.test(passingYear)) throw new Error("SEED_ADMIN_PASSING_YEAR must contain four digits");
  const phone = `${phoneCountryCode}${phoneNumber}`;
  const communityId = process.env.DEFAULT_COMMUNITY_ID ?? "iit-community";

  const password_hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, phone, password_hash, role: "owner", email_verified_at: new Date(), phone_verified_at: new Date() },
    update: { phone, password_hash, role: "owner", status: "active", email_verified_at: new Date(), phone_verified_at: new Date() },
  });

  // A seeded verified account must also have a complete academic identity.
  // Otherwise the forum recovery wizard opens with no verified institute and
  // can never complete. The user id is stable and valid as the legacy row id.
  const educationId = user.id;
  const education = {
    id: educationId,
    user_id: user.id,
    institution: institute,
    degree,
    branch_area: specialisation,
    passing_year: passingYear,
    is_verified: true,
    approval_status: "approved",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await prisma.legacyRecord.upsert({
    where: { table_name_record_id: { table_name: "education", record_id: educationId } },
    create: { table_name: "education", record_id: educationId, owner_id: user.id, community_id: communityId, data: education },
    update: { owner_id: user.id, community_id: communityId, data: education },
  });

  await prisma.profile.upsert({
    where: { user_id: user.id },
    create: { user_id: user.id, name, role: "owner", community_id: communityId, phone_country_code: phoneCountryCode, phone_number: phoneNumber, phone_full: phone, iit_name: institute, student_status: "alumni", primary_education_id: educationId, is_verified: true, onboarding_completed: true },
    update: { name, role: "owner", community_id: communityId, phone_country_code: phoneCountryCode, phone_number: phoneNumber, phone_full: phone, iit_name: institute, student_status: "alumni", primary_education_id: educationId, is_verified: true, onboarding_completed: true },
  });
  console.info(`Seeded owner ${user.id}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
