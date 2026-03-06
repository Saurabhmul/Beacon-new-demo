import { db } from "./db";
import { companies, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function seedDatabase() {
  console.log("Running database seed...");

  const [existingCompany] = await db.select().from(companies).where(eq(companies.name, "Prodigy Finance"));

  let prodigyCompanyId: string;

  if (existingCompany) {
    prodigyCompanyId = existingCompany.id;
    console.log("Prodigy Finance company already exists:", prodigyCompanyId);
  } else {
    const [newCompany] = await db.insert(companies).values({
      name: "Prodigy Finance",
      status: "active",
    }).returning();
    prodigyCompanyId = newCompany.id;
    console.log("Created Prodigy Finance company:", prodigyCompanyId);
  }

  const [existingSuperAdmin] = await db.select().from(users).where(eq(users.email, "saurabh.aggarwal@prodigyfinance.com"));
  if (!existingSuperAdmin) {
    const hashedPw = await bcrypt.hash("beacon2026!", 10);
    await db.insert(users).values({
      email: "saurabh.aggarwal@prodigyfinance.com",
      password: hashedPw,
      firstName: "Saurabh",
      lastName: "Aggarwal",
      designation: "Head of AI & New Initiatives",
      companyId: prodigyCompanyId,
      role: "superadmin",
      status: "active",
      registeredAt: new Date(),
    });
    console.log("Created SuperAdmin user: saurabh.aggarwal@prodigyfinance.com");
  } else {
    if (existingSuperAdmin.role !== "superadmin" || existingSuperAdmin.companyId !== prodigyCompanyId) {
      await db.update(users).set({
        role: "superadmin",
        companyId: prodigyCompanyId,
        designation: existingSuperAdmin.designation || "Head of AI & New Initiatives",
        status: "active",
      }).where(eq(users.id, existingSuperAdmin.id));
      console.log("Updated SuperAdmin user: saurabh.aggarwal@prodigyfinance.com");
    } else {
      console.log("SuperAdmin already exists and configured correctly.");
    }
  }

  const [existingAdmin] = await db.select().from(users).where(eq(users.email, "test@prodigyfinance.com"));
  if (!existingAdmin) {
    const hashedPw = await bcrypt.hash("test1234", 10);
    await db.insert(users).values({
      email: "test@prodigyfinance.com",
      password: hashedPw,
      firstName: "Test",
      lastName: "Test",
      designation: "Test Admin",
      companyId: prodigyCompanyId,
      role: "admin",
      status: "active",
      registeredAt: new Date(),
    });
    console.log("Created Admin user: test@prodigyfinance.com");
  } else {
    if (existingAdmin.role !== "admin" || existingAdmin.companyId !== prodigyCompanyId) {
      await db.update(users).set({
        role: "admin",
        companyId: prodigyCompanyId,
        designation: existingAdmin.designation || "Test Admin",
        status: "active",
      }).where(eq(users.id, existingAdmin.id));
      console.log("Updated Admin user: test@prodigyfinance.com");
    } else {
      console.log("Admin already exists and configured correctly.");
    }
  }

  console.log("Migrating existing data to Prodigy Finance company_id...");
  const tablesToMigrate = [
    "client_configs", "rulebooks", "data_configs", "dpd_stages",
    "policy_configs", "data_uploads", "upload_logs", "decisions"
  ];

  for (const table of tablesToMigrate) {
    try {
      await db.execute(
        `UPDATE ${table} SET company_id = '${prodigyCompanyId}' WHERE company_id IS NULL OR company_id = ''`
      );
      console.log(`  Migrated ${table}`);
    } catch (e: any) {
      console.log(`  Skipped ${table}: ${e.message}`);
    }
  }

  console.log("Seed complete.");
  return prodigyCompanyId;
}
