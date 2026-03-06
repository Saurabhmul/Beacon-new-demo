import type { Express } from "express";
import { authStorage } from "./storage";
import { authenticate } from "../../middleware/auth";
import { companies } from "@shared/models/auth";
import { db } from "../../db";
import { eq } from "drizzle-orm";

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/user", authenticate, async (req: any, res) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ message: "Unauthorized" });

      const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));

      const { password: _, ...safeUser } = user;
      res.json({
        ...safeUser,
        companyName: company?.name || "Unknown",
        viewingCompanyId: req.session?.viewingCompanyId || null,
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });
}
