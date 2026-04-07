import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { authenticate, authorize, companyFilter } from "./middleware/auth";
import multer from "multer";
import Papa from "papaparse";
import { analyzeCustomer, extractTextFromImage, analyzeCategoryFields, extractSOPTreatments } from "./ai-engine";
import { batchProcessWithSSE } from "./replit_integrations/batch";
import { users, uploadLogs, companies } from "@shared/schema";
import type { PolicyFieldDto, RuleSaveRow, DerivationConfig } from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { compilePolicyPrompt } from "./lib/prompt/compile-policy";
import { assemblePrompt, assemblePreview, formatCustomerData, clearTemplateCache } from "./lib/prompt/assemble-prompt";
import { seedDatabase } from "./seed";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

interface AnalysisJob {
  events: Array<Record<string, unknown>>;
  complete: boolean;
  listeners: Set<(event: Record<string, unknown>) => void>;
}
const analysisJobs = new Map<string, AnalysisJob>();

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  try {
    await seedDatabase();
  } catch (e: any) {
    console.error("Seed error:", e.message);
  }

  function getUserId(req: any): string {
    return req.user?.id;
  }

  function getCompanyId(req: any): string | null {
    return req.companyId || null;
  }

  // Companies API (SuperAdmin only)
  app.get("/api/companies", authenticate, authorize("superadmin"), async (req, res) => {
    try {
      const companiesList = await storage.getCompanies();
      res.json(companiesList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch companies" });
    }
  });

  // Users API
  app.get("/api/users", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = req.user.role === "superadmin" ? (req.query.companyId as string || null) : req.user.companyId;
      const allUsers = await storage.getUsers(companyId);
      const usersList = req.user.role === "superadmin" ? allUsers : allUsers.filter(u => u.role !== "superadmin");
      const safeUsers = await Promise.all(usersList.map(async (u) => {
        const { password: _, ...safe } = u;
        let invitedByName = null;
        if (u.invitedBy) {
          const inviter = await storage.getUserById(u.invitedBy);
          if (inviter) invitedByName = `${inviter.firstName || ""} ${inviter.lastName || ""}`.trim();
        }
        let companyName = "";
        const company = await storage.getCompany(u.companyId);
        if (company) companyName = company.name;
        return { ...safe, invitedByName, companyName };
      }));
      res.json(safeUsers);
    } catch (error) {
      console.error("Get users error:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.post("/api/users", authenticate, authorize("superadmin", "admin", "manager"), async (req: any, res) => {
    try {
      const creator = req.user;
      const { firstName, lastName, email, designation, role, companyName } = req.body;

      if (!firstName || firstName.length < 2) return res.status(400).json({ error: "First name must be at least 2 characters" });
      if (!lastName || lastName.length < 2) return res.status(400).json({ error: "Last name must be at least 2 characters" });
      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!designation) return res.status(400).json({ error: "Designation is required" });
      if (!role) return res.status(400).json({ error: "Role is required" });

      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: "A user with this email already exists." });

      if (creator.role === "superadmin") {
        if (!["superadmin", "admin"].includes(role)) return res.status(400).json({ error: "SuperAdmin can only create SuperAdmin or Admin" });
        if (role === "superadmin" && !email.endsWith("@prodigyfinance.com")) {
          return res.status(400).json({ error: "SuperAdmin accounts require a @prodigyfinance.com email address." });
        }
      } else if (creator.role === "admin") {
        if (!["admin", "manager", "agent"].includes(role)) return res.status(400).json({ error: "Admin can only create Admin, Manager or Agent" });
      } else if (creator.role === "manager") {
        if (!["manager", "agent"].includes(role)) return res.status(400).json({ error: "Manager can only create Manager or Agent" });
      }

      let targetCompanyId: string;

      if (creator.role === "superadmin") {
        if (role === "superadmin") {
          const prodigy = await db.select().from(companies).where(eq(companies.name, "Prodigy Finance"));
          if (!prodigy.length) return res.status(500).json({ error: "Prodigy Finance company not found" });
          targetCompanyId = prodigy[0].id;
        } else if (role === "admin") {
          if (!companyName) return res.status(400).json({ error: "Company name is required for Admin" });
          const existingCompany = await db.select().from(companies).where(eq(companies.name, companyName));
          if (existingCompany.length) {
            targetCompanyId = existingCompany[0].id;
          } else {
            const [newCompany] = await db.insert(companies).values({
              name: companyName,
              status: "active",
              createdBy: creator.id,
            }).returning();
            targetCompanyId = newCompany.id;
          }
        } else {
          targetCompanyId = creator.companyId;
        }
      } else {
        targetCompanyId = creator.companyId;
      }

      const inviteToken = crypto.randomUUID();
      const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const newUser = await storage.createUser({
        firstName,
        lastName,
        email,
        designation,
        companyId: targetCompanyId,
        role,
        status: "invited",
        invitedBy: creator.id,
        inviteToken,
        inviteExpiresAt,
      });

      const { password: _, ...safeUser } = newUser;
      const company = await storage.getCompany(targetCompanyId);

      res.status(201).json({
        ...safeUser,
        companyName: company?.name || "",
        inviteLink: `/auth?invite=${inviteToken}`,
      });
    } catch (error) {
      console.error("Create user error:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.patch("/api/users/:id", authenticate, authorize("superadmin", "admin"), async (req: any, res) => {
    try {
      const creator = req.user;
      const targetId = req.params.id;
      const target = await storage.getUserById(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });

      if (creator.role === "admin" && target.companyId !== creator.companyId) {
        return res.status(403).json({ error: "Cannot edit users from another company" });
      }

      const { firstName, lastName, designation, role } = req.body;
      const updates: Partial<any> = {};

      if (firstName) updates.firstName = firstName;
      if (lastName) updates.lastName = lastName;
      if (designation) updates.designation = designation;

      if (role && role !== target.role) {
        if (creator.role === "admin" && role === "superadmin") {
          return res.status(403).json({ error: "Admin cannot promote to SuperAdmin" });
        }
        updates.role = role;
      }

      const updated = await storage.updateUser(targetId, updates);
      const { password: _, ...safe } = updated;
      res.json(safe);
    } catch (error) {
      console.error("Edit user error:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.post("/api/users/:id/deactivate", authenticate, authorize("superadmin", "admin"), async (req: any, res) => {
    try {
      const creator = req.user;
      const targetId = req.params.id;

      if (creator.id === targetId) {
        return res.status(400).json({ error: "You cannot deactivate your own account." });
      }

      const target = await storage.getUserById(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });

      if (creator.role === "admin" && target.companyId !== creator.companyId) {
        return res.status(403).json({ error: "Cannot deactivate users from another company" });
      }

      const updated = await storage.updateUser(targetId, { status: "deactivated" });
      const { password: _, ...safe } = updated;
      res.json(safe);
    } catch (error) {
      res.status(500).json({ error: "Failed to deactivate user" });
    }
  });

  app.post("/api/users/:id/reactivate", authenticate, authorize("superadmin", "admin"), async (req: any, res) => {
    try {
      const creator = req.user;
      const targetId = req.params.id;
      const target = await storage.getUserById(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });

      if (creator.role === "admin" && target.companyId !== creator.companyId) {
        return res.status(403).json({ error: "Cannot reactivate users from another company" });
      }

      const updated = await storage.updateUser(targetId, { status: "active" });
      const { password: _, ...safe } = updated;
      res.json(safe);
    } catch (error) {
      res.status(500).json({ error: "Failed to reactivate user" });
    }
  });

  app.post("/api/users/:id/resend-invite", authenticate, authorize("superadmin", "admin", "manager"), async (req: any, res) => {
    try {
      const targetId = req.params.id;
      const target = await storage.getUserById(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });
      if (target.status !== "invited") return res.status(400).json({ error: "User is not in invited status" });

      const inviteToken = crypto.randomUUID();
      const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await storage.updateUser(targetId, { inviteToken, inviteExpiresAt });

      res.json({ message: "Invite link regenerated", inviteLink: `/auth?invite=${inviteToken}` });
    } catch (error) {
      res.status(500).json({ error: "Failed to resend invite" });
    }
  });

  // Client Config
  app.get("/api/client-config", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const config = await storage.getClientConfig(companyId);
      if (!config) return res.status(404).json({ error: "Not configured" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch config" });
    }
  });

  app.post("/api/client-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const config = await storage.createClientConfig({ ...req.body, userId, companyId });
      res.status(201).json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to create config" });
    }
  });

  app.patch("/api/client-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const config = await storage.updateClientConfig(companyId, req.body);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to update config" });
    }
  });

  // Rulebooks
  app.get("/api/rulebooks", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const rbs = await storage.getRulebooks(companyId);
      res.json(rbs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch rulebooks" });
    }
  });

  app.post("/api/rulebooks", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const config = await storage.getClientConfig(companyId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const rb = await storage.createRulebook({
        ...req.body,
        userId,
        companyId,
        clientConfigId: config.id,
      });
      res.status(201).json(rb);
    } catch (error) {
      res.status(500).json({ error: "Failed to create rulebook" });
    }
  });

  app.post("/api/rulebooks/upload", authenticate, authorize("admin"), companyFilter, upload.single("file"), async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const config = await storage.getClientConfig(companyId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      let extractedText = "";

      if (file.mimetype === "application/pdf") {
        try {
          const base64 = file.buffer.toString("base64");
          extractedText = await extractTextFromImage(base64, "application/pdf");
        } catch (e) {
          extractedText = `[PDF document: ${file.originalname}] Text extraction failed - please enter SOP as text instead.`;
        }
      } else if (file.mimetype.startsWith("image/")) {
        try {
          const base64 = file.buffer.toString("base64");
          extractedText = await extractTextFromImage(base64, file.mimetype);
        } catch (e) {
          extractedText = `[Image document: ${file.originalname}] OCR extraction failed - content available for manual review.`;
        }
      }

      const uploadsDir = path.join(process.cwd(), "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const filePath = path.join(uploadsDir, safeName);
      fs.writeFileSync(filePath, file.buffer);

      const rb = await storage.createRulebook({
        title: req.body.title || file.originalname,
        userId,
        companyId,
        clientConfigId: config.id,
        sopFileUrl: filePath,
        sopFileName: file.originalname,
        extractedText,
        sopText: extractedText,
      });

      res.status(201).json(rb);
    } catch (error) {
      console.error("Rulebook upload error:", error);
      res.status(500).json({ error: "Failed to upload rulebook" });
    }
  });

  app.delete("/api/rulebooks/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const rb = await storage.getRulebook(parseInt(req.params.id));
      if (!rb || rb.companyId !== companyId) return res.status(404).json({ error: "Rulebook not found" });
      await storage.deleteRulebook(rb.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete rulebook" });
    }
  });

  // Data Config
  app.get("/api/data-config", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const config = await storage.getDataConfig(companyId);
      if (!config) return res.status(404).json({ error: "Not configured" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch data config" });
    }
  });

  app.post("/api/data-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(400).json({ error: "Configure client first" });

      const config = await storage.createDataConfig({
        ...req.body,
        userId,
        companyId,
        clientConfigId: clientConfig.id,
      });
      res.status(201).json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to create data config" });
    }
  });

  app.patch("/api/data-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const config = await storage.updateDataConfig(companyId, req.body);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to update data config" });
    }
  });

  app.post("/api/data-config/analyze-category", authenticate, authorize("admin"), companyFilter, upload.single("file"), async (req: any, res) => {
    try {
      const file = req.file;
      const category = req.body?.category;
      if (!file) return res.status(400).json({ error: "No file uploaded" });
      if (!category) return res.status(400).json({ error: "Category is required" });

      const isTabular = /\.(csv|xlsx|xls)$/i.test(file.originalname);
      const isDocument = /\.(pdf|docx|txt)$/i.test(file.originalname);

      if (!isTabular && !isDocument) {
        return res.status(400).json({ error: "Unsupported file type. Use CSV, XLSX, PDF, DOCX, or TXT." });
      }

      let headers: string[] = [];
      let sampleRows: Record<string, string>[] = [];

      if (isTabular) {
        if (/\.csv$/i.test(file.originalname)) {
          const content = file.buffer.toString("utf-8");
          const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
          if (parsed.data.length > 0) {
            headers = Object.keys(parsed.data[0] as Record<string, unknown>);
            sampleRows = (parsed.data as Record<string, unknown>[]).slice(0, 3).map(row => {
              const r: Record<string, string> = {};
              for (const [k, v] of Object.entries(row)) r[k] = String(v ?? "");
              return r;
            });
          }
        } else {
          const XLSX = await import("xlsx");
          const wb = XLSX.read(file.buffer, { type: "buffer" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
          if (data.length > 0) {
            headers = (data[0] as unknown[]).map(h => String(h ?? "")).filter(h => h.trim());
            sampleRows = data.slice(1, 4).map(row => {
              const r: Record<string, string> = {};
              headers.forEach((h, i) => { r[h] = String((row as unknown[])[i] ?? ""); });
              return r;
            });
          }
        }

        if (headers.length === 0) {
          return res.status(400).json({ error: "Could not extract column headers from file. Please check the file format." });
        }
      }

      let fieldAnalysis: Array<{ fieldName: string; beaconsUnderstanding: string; confidence: 'High' | 'Medium' | 'Low' }> = [];
      if (isTabular && headers.length > 0) {
        fieldAnalysis = await analyzeCategoryFields(category, headers, sampleRows);
      }

      res.json({
        categoryId: category,
        docType: isTabular ? "tabular" : "document",
        fieldAnalysis,
        fileName: file.originalname,
        fileSize: file.size,
      });
    } catch (error) {
      console.error("analyze-category error:", error);
      res.status(500).json({ error: "Failed to analyze file" });
    }
  });

  // Policy Config
  app.get("/api/policy-config", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const config = await storage.getPolicyConfig(companyId);
      if (!config) return res.status(404).json({ error: "Not configured" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch policy config" });
    }
  });

  app.post("/api/policy-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(400).json({ error: "Configure client first" });

      const dpdStagesData = await storage.getDpdStages(companyId);

      const compiled = compilePolicyPrompt({
        dpdStages: dpdStagesData.map(s => ({ name: s.name, fromDays: s.fromDays, toDays: s.toDays })),
        vulnerabilityDefinition: req.body.vulnerabilityDefinition,
        affordabilityRules: req.body.affordabilityRules,
        treatments: req.body.availableTreatments,
        decisionRules: req.body.decisionRules,
        escalationRules: req.body.escalationRules,
      });

      const config = await storage.createPolicyConfig({
        ...req.body,
        userId,
        companyId,
        clientConfigId: clientConfig.id,
        compiledPolicy: compiled as unknown as Record<string, string>,
        compiledAt: new Date(),
      });
      res.status(201).json(config);
    } catch (error) {
      console.error("Create policy config error:", error);
      res.status(500).json({ error: "Failed to create policy config" });
    }
  });

  app.patch("/api/policy-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const dpdStagesData = await storage.getDpdStages(companyId);

      const compiled = compilePolicyPrompt({
        dpdStages: dpdStagesData.map(s => ({ name: s.name, fromDays: s.fromDays, toDays: s.toDays })),
        vulnerabilityDefinition: req.body.vulnerabilityDefinition,
        affordabilityRules: req.body.affordabilityRules,
        treatments: req.body.availableTreatments,
        decisionRules: req.body.decisionRules,
        escalationRules: req.body.escalationRules,
      });

      const config = await storage.updatePolicyConfig(companyId, {
        ...req.body,
        compiledPolicy: compiled as unknown as Record<string, string>,
        compiledAt: new Date(),
      });
      res.json(config);
    } catch (error) {
      console.error("Update policy config error:", error);
      res.status(500).json({ error: "Failed to update policy config" });
    }
  });

  // Policy Pack — new structured treatment system
  app.get("/api/policy-pack", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(404).json({ error: "No client config found" });
      const pack = await storage.getPolicyPack(clientConfig.id);
      if (!pack) return res.status(404).json({ error: "No policy pack found" });
      res.json(pack);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch policy pack" });
    }
  });

  app.post("/api/policy-pack", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(400).json({ error: "Configure client first" });
      const { policyName, sourceType, sourceFileName, status, id } = req.body;
      if (!policyName?.trim()) return res.status(400).json({ error: "policyName is required" });
      const pack = await storage.upsertPolicyPack({
        id: id || undefined,
        clientConfigId: clientConfig.id,
        policyName: policyName.trim(),
        sourceType: sourceType || "ui",
        sourceFileName: sourceFileName || null,
        status: status || "draft",
      });
      res.json(pack);
    } catch (error) {
      console.error("Upsert policy pack error:", error);
      res.status(500).json({ error: "Failed to save policy pack" });
    }
  });

  app.get("/api/policy-pack/treatments", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(404).json({ error: "No client config" });
      const pack = await storage.getPolicyPack(clientConfig.id);
      if (!pack) return res.json([]);
      const txs = await storage.getTreatmentsWithRules(pack.id);
      res.json(txs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch treatments" });
    }
  });

  app.post("/api/policy-pack/treatments", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const clientConfig = await storage.getClientConfig(companyId);
      if (!clientConfig) return res.status(400).json({ error: "Configure client first" });
      const pack = await storage.getPolicyPack(clientConfig.id);
      if (!pack) return res.status(400).json({ error: "Create a policy pack first" });
      const { name, shortDescription, enabled, priority, tone, displayOrder } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Treatment name is required" });
      const tx = await storage.createTreatment({
        policyPackId: pack.id,
        name: name.trim(),
        shortDescription: shortDescription || null,
        enabled: enabled !== false,
        priority: priority || null,
        tone: tone || null,
        displayOrder: displayOrder ?? 0,
      });
      res.status(201).json(tx);
    } catch (error) {
      console.error("Create treatment error:", error);
      res.status(500).json({ error: "Failed to create treatment" });
    }
  });

  app.patch("/api/policy-pack/treatments/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const { name, shortDescription, enabled, priority, tone, displayOrder } = req.body;
      const tx = await storage.updateTreatment(id, {
        ...(name !== undefined && { name }),
        ...(shortDescription !== undefined && { shortDescription }),
        ...(enabled !== undefined && { enabled }),
        ...(priority !== undefined && { priority }),
        ...(tone !== undefined && { tone }),
        ...(displayOrder !== undefined && { displayOrder }),
      });
      res.json(tx);
    } catch (error) {
      console.error("Update treatment error:", error);
      res.status(500).json({ error: "Failed to update treatment" });
    }
  });

  app.delete("/api/policy-pack/treatments/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      await storage.deleteTreatment(parseInt(req.params.id));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete treatment" });
    }
  });

  app.post("/api/policy-pack/treatments/:id/rules", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const treatmentId = parseInt(req.params.id);
      const { ruleType, logicOperator, plainEnglishInput, rows } = req.body;
      if (!ruleType) return res.status(400).json({ error: "ruleType required" });
      await storage.deleteRuleGroupsByTreatmentAndType(treatmentId, ruleType);
      const group = await storage.upsertRuleGroup({
        treatmentId,
        ruleType,
        logicOperator: logicOperator || "AND",
        plainEnglishInput: plainEnglishInput || null,
        groupOrder: 0,
      });
      const typedRows = (rows ?? []) as RuleSaveRow[];
      await storage.replaceRuleRows(group.id, typedRows.map((r, i) => ({
        fieldName: r.fieldName || r.leftFieldId || "",
        operator: r.operator,
        value: r.value || null,
        sortOrder: i,
        leftFieldId: r.leftFieldId,
        rightMode: r.rightMode,
        rightConstantValue: r.rightConstantValue,
        rightFieldId: r.rightFieldId,
      })));
      const updated = await storage.getTreatmentsWithRules((await storage.getPolicyPack((await storage.getClientConfig(getCompanyId(req)))!.id))!.id);
      const tx = updated.find(t => t.id === treatmentId);
      res.json(tx || { id: treatmentId });
    } catch (error) {
      console.error("Save rules error:", error);
      res.status(500).json({ error: "Failed to save rules" });
    }
  });

  // Policy Fields API
  function generateDerivationSummary(config: DerivationConfig): string {
    const labelA = config.fieldALabel || config.fieldA || "?";
    const labelB = config.operandBType === "field"
      ? (config.operandBLabel || config.operandBValue || "?")
      : (config.operandBValue || "?");
    if (!config.operator2) return `${labelA} ${config.operator1} ${labelB}`;
    const labelC = config.operandCType === "field"
      ? (config.operandCLabel || config.operandCValue || "?")
      : (config.operandCValue || "?");
    return `(${labelA} ${config.operator1} ${labelB}) ${config.operator2} ${labelC}`;
  }

  function toFieldDto(f: { id: number; label: string; description: string | null; sourceType: string; derivationConfig: DerivationConfig | null | undefined; derivationSummary: string | null | undefined }): PolicyFieldDto {
    return {
      id: String(f.id),
      label: f.label,
      description: f.description,
      sourceType: f.sourceType as PolicyFieldDto["sourceType"],
      derivationConfig: f.derivationConfig ?? null,
      derivationSummary: f.derivationSummary ?? null,
    };
  }

  app.get("/api/policy-fields", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const dataConfig = await storage.getDataConfig(companyId!);
      const categoryData = (dataConfig?.categoryData as Record<string, { fieldAnalysis?: { fieldName: string; ignored: boolean; beaconsUnderstanding?: string }[] }>) || {};
      const sourceFields: PolicyFieldDto[] = [];
      for (const [, catEntry] of Object.entries(categoryData)) {
        if (catEntry?.fieldAnalysis && Array.isArray(catEntry.fieldAnalysis)) {
          for (const f of catEntry.fieldAnalysis) {
            if (!f.ignored && f.fieldName) {
              const id = `source:${f.fieldName}`;
              if (!sourceFields.find(sf => sf.id === id)) {
                sourceFields.push({
                  id,
                  label: f.fieldName,
                  description: f.beaconsUnderstanding ?? null,
                  sourceType: "source_field",
                  derivationConfig: null,
                  derivationSummary: null,
                });
              }
            }
          }
        }
      }
      sourceFields.sort((a, b) => a.label.localeCompare(b.label));
      const dbFields = await storage.getPolicyFields(companyId!);
      const businessFields: PolicyFieldDto[] = dbFields.filter(f => f.sourceType === "business_field").map(toFieldDto);
      const derivedFields: PolicyFieldDto[] = dbFields.filter(f => f.sourceType === "derived_field").map(toFieldDto);
      res.json([...sourceFields, ...businessFields, ...derivedFields]);
    } catch (error) {
      console.error("Get policy fields error:", error);
      res.status(500).json({ error: "Failed to fetch policy fields" });
    }
  });

  app.post("/api/policy-fields", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const { label, description, sourceType, derivationConfig } = req.body;
      if (!label?.trim()) return res.status(400).json({ error: "label is required" });
      if (!["business_field", "derived_field"].includes(sourceType)) return res.status(400).json({ error: "sourceType must be business_field or derived_field" });
      if (sourceType === "derived_field") {
        if (!derivationConfig) return res.status(400).json({ error: "derivationConfig is required for derived_field" });
        if (!derivationConfig.fieldA) return res.status(400).json({ error: "derivationConfig.fieldA is required" });
        if (!derivationConfig.operator1) return res.status(400).json({ error: "derivationConfig.operator1 is required" });
        if (!derivationConfig.operandBType || !derivationConfig.operandBValue?.toString().trim()) return res.status(400).json({ error: "derivationConfig operandB (type and value) is required" });
        if (derivationConfig.operator2 !== undefined && derivationConfig.operator2 !== "") {
          if (!derivationConfig.operandCType || !derivationConfig.operandCValue?.toString().trim()) return res.status(400).json({ error: "derivationConfig operandC (type and value) is required when operator2 is set" });
        }
      }
      const existing = await storage.getPolicyFields(companyId!);
      const dup = existing.find(f => f.label.trim().toLowerCase() === label.trim().toLowerCase());
      if (dup) return res.status(409).json({ error: `Field "${label.trim()}" already exists` });
      const derivationSummary = sourceType === "derived_field" && derivationConfig
        ? generateDerivationSummary(derivationConfig)
        : null;
      const field = await storage.createPolicyField({
        companyId: companyId!,
        policyPackId: null,
        label: label.trim(),
        description: description?.trim() || null,
        sourceType,
        derivationConfig: derivationConfig || null,
        derivationSummary,
      });
      res.status(201).json({
        id: String(field.id),
        label: field.label,
        description: field.description,
        sourceType: field.sourceType,
        derivationConfig: field.derivationConfig,
        derivationSummary: field.derivationSummary,
      });
    } catch (error) {
      console.error("Create policy field error:", error);
      res.status(500).json({ error: "Failed to create policy field" });
    }
  });

  app.post("/api/policy-pack/extract-sop", authenticate, authorize("admin"), companyFilter, upload.single("file"), async (req: any, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      let fileText = "";
      if (file.mimetype === "application/pdf") {
        try {
          const base64 = file.buffer.toString("base64");
          fileText = await extractTextFromImage(base64, "application/pdf");
        } catch {
          fileText = "";
        }
      } else {
        fileText = file.buffer.toString("utf8");
      }

      if (!fileText.trim()) {
        return res.status(422).json({ error: "Could not extract text from the uploaded file. Please use a TXT or DOCX file." });
      }

      const treatments = await extractSOPTreatments(fileText);
      res.json({ treatments, fileName: file.originalname });
    } catch (error) {
      console.error("SOP extraction error:", error);
      res.status(500).json({ error: "Failed to extract treatments from SOP" });
    }
  });

  app.get("/api/prompt-preview", authenticate, authorize("superadmin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const policyConfig = await storage.getPolicyConfig(companyId);
      const dataConfig = await storage.getDataConfig(companyId);

      if (!policyConfig || !policyConfig.compiledPolicy) {
        const dpdStagesData = await storage.getDpdStages(companyId);
        const compiled = compilePolicyPrompt({
          dpdStages: dpdStagesData.map(s => ({ name: s.name, fromDays: s.fromDays, toDays: s.toDays })),
          vulnerabilityDefinition: policyConfig?.vulnerabilityDefinition,
          affordabilityRules: policyConfig?.affordabilityRules,
          treatments: policyConfig?.availableTreatments,
          decisionRules: policyConfig?.decisionRules,
          escalationRules: policyConfig?.escalationRules,
        });
        const preview = assemblePreview(compiled, dataConfig?.outputFormat || undefined);
        res.json({ preview, compiledAt: null, isLive: false });
        return;
      }

      const preview = assemblePreview(
        policyConfig.compiledPolicy as Record<string, string>,
        dataConfig?.outputFormat || undefined
      );
      res.json({
        preview,
        compiledAt: policyConfig.compiledAt,
        isLive: true,
      });
    } catch (error) {
      console.error("Prompt preview error:", error);
      res.status(500).json({ error: "Failed to generate prompt preview" });
    }
  });

  app.post("/api/prompt-preview/regenerate", authenticate, authorize("superadmin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const policyConfig = await storage.getPolicyConfig(companyId);
      const dpdStagesData = await storage.getDpdStages(companyId);
      const dataConfig = await storage.getDataConfig(companyId);

      const compiled = compilePolicyPrompt({
        dpdStages: dpdStagesData.map(s => ({ name: s.name, fromDays: s.fromDays, toDays: s.toDays })),
        vulnerabilityDefinition: policyConfig?.vulnerabilityDefinition,
        affordabilityRules: policyConfig?.affordabilityRules,
        treatments: policyConfig?.availableTreatments,
        decisionRules: policyConfig?.decisionRules,
        escalationRules: policyConfig?.escalationRules,
      });

      if (policyConfig) {
        await storage.updatePolicyConfig(companyId, {
          compiledPolicy: compiled as unknown as Record<string, string>,
          compiledAt: new Date(),
        });
      }

      const preview = assemblePreview(compiled, dataConfig?.outputFormat || undefined);
      res.json({ preview, compiledAt: new Date(), isLive: true });
    } catch (error) {
      console.error("Prompt regenerate error:", error);
      res.status(500).json({ error: "Failed to regenerate prompt" });
    }
  });

  // DPD Stages
  app.get("/api/dpd-stages", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const stages = await storage.getDpdStages(companyId);
      res.json(stages);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch DPD stages" });
    }
  });

  app.post("/api/dpd-stages", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const config = await storage.getClientConfig(companyId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const { name, description, fromDays, toDays, color } = req.body;
      if (fromDays >= toDays) return res.status(400).json({ error: "From days must be less than To days" });

      const existing = await storage.getDpdStages(companyId);
      const overlap = existing.find(s =>
        (fromDays >= s.fromDays && fromDays <= s.toDays) ||
        (toDays >= s.fromDays && toDays <= s.toDays) ||
        (fromDays <= s.fromDays && toDays >= s.toDays)
      );
      if (overlap) return res.status(400).json({ error: `Overlaps with existing stage "${overlap.name}" (${overlap.fromDays}-${overlap.toDays} days)` });

      const stage = await storage.createDpdStage({
        name,
        description,
        fromDays,
        toDays,
        color: color || "blue",
        userId,
        companyId,
        clientConfigId: config.id,
      });
      res.status(201).json(stage);
    } catch (error) {
      res.status(500).json({ error: "Failed to create DPD stage" });
    }
  });

  app.patch("/api/dpd-stages/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const id = parseInt(req.params.id);
      const { name, description, fromDays, toDays, color } = req.body;

      const existing = await storage.getDpdStages(companyId);
      const owned = existing.find(s => s.id === id);
      if (!owned) return res.status(404).json({ error: "DPD stage not found" });

      const checkFrom = fromDays ?? owned.fromDays;
      const checkTo = toDays ?? owned.toDays;

      if (checkFrom >= checkTo) {
        return res.status(400).json({ error: "From days must be less than To days" });
      }

      const overlap = existing.find(s =>
        s.id !== id && (
          (checkFrom >= s.fromDays && checkFrom <= s.toDays) ||
          (checkTo >= s.fromDays && checkTo <= s.toDays) ||
          (checkFrom <= s.fromDays && checkTo >= s.toDays)
        )
      );
      if (overlap) return res.status(400).json({ error: `Overlaps with existing stage "${overlap.name}" (${overlap.fromDays}-${overlap.toDays} days)` });

      const stage = await storage.updateDpdStage(id, { name, description, fromDays: checkFrom, toDays: checkTo, color });
      res.json(stage);
    } catch (error) {
      res.status(500).json({ error: "Failed to update DPD stage" });
    }
  });

  app.delete("/api/dpd-stages/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const id = parseInt(req.params.id);
      const stages = await storage.getDpdStages(companyId);
      const stage = stages.find(s => s.id === id);
      if (!stage) return res.status(404).json({ error: "DPD stage not found" });
      await storage.deleteDpdStage(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete DPD stage" });
    }
  });

  // Uploads
  app.get("/api/uploads", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const category = req.query.category as string | undefined;
      const uploads = await storage.getUploads(companyId);
      if (category) {
        res.json(uploads.filter(u => u.uploadCategory === category));
      } else {
        res.json(uploads);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  const MANDATORY_LOAN_FIELDS = [
    "customer / account / loan id", "dpd_bucket",
    "amount_due", "minimum_due", "due_date",
  ];

  const MANDATORY_PAYMENT_FIELDS = [
    "customer / account / loan id", "payment_reference", "date_of_payment", "amount_paid", "payment_status",
  ];

  const CONVERSATION_HISTORY_FIELDS = [
    "customer / account / loan id", "date_and_timestamp", "message",
  ];

  app.get("/api/uploads/sample/:category", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const category = req.params.category;
      const dataConfig = await storage.getDataConfig(companyId);

      let fields: string[] = [];
      const filename = `sample_${category}.csv`;

      // Map upload category key → Data Config category ID
      const uploadToDataConfig: Record<string, string> = {
        loan_data: "loan_account",
        payment_history: "payment_history",
        conversation_history: "conversation_history",
        income_employment: "income_employment",
        credit_bureau: "credit_bureau",
      };

      const dataCatId = uploadToDataConfig[category];
      const categoryData = (dataConfig?.categoryData as Record<string, any>) || {};
      const catEntry = dataCatId ? categoryData[dataCatId] : undefined;

      if (catEntry?.fieldAnalysis && Array.isArray(catEntry.fieldAnalysis) && catEntry.fieldAnalysis.length > 0) {
        // Use saved field analysis as source of truth for column headers
        const activeFields = catEntry.fieldAnalysis.filter((f: any) => !f.ignored);
        fields = activeFields.map((f: any) => f.fieldName);
      } else if (category === "loan_data") {
        fields = [...MANDATORY_LOAN_FIELDS];
        if (dataConfig?.optionalFields) {
          const optional = dataConfig.optionalFields as string[];
          fields.push(...optional.filter(f => f !== "conversation_history"));
        }
      } else if (category === "payment_history") {
        fields = [...MANDATORY_PAYMENT_FIELDS];
        if (dataConfig?.paymentAdditionalFields) {
          fields.push(...(dataConfig.paymentAdditionalFields as string[]));
        }
      } else if (category === "conversation_history") {
        fields = [...CONVERSATION_HISTORY_FIELDS];
      } else {
        // Generic fallback for any other category with no field analysis yet
        fields = ["id"];
      }

      const SAMPLE_VALUES: Record<string, string> = {
        "customer / account / loan id": "CUST001",
        "dpd_bucket": "30 or Easy",
        "amount_due": "5000",
        "minimum_due": "1500",
        "due_date": "2026-01-15",
        "payment_reference": "PAY001",
        "date_of_payment": "2026-01-10",
        "amount_paid": "5000",
        "payment_status": "paid",
        "date_and_timestamp": "2026-01-12 14:30:00",
        "message": "Customer called regarding payment",
      };

      const header = fields.join(",");
      const sampleRow = fields.map(f => SAMPLE_VALUES[f] || "").join(",");
      const csv = header + "\n" + sampleRow + "\n";

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      res.status(500).json({ error: "Failed to generate sample CSV" });
    }
  });

  function findIdColumn(record: Record<string, unknown>): string | undefined {
    const keys = Object.keys(record);
    return keys.find(k => {
      const lower = k.toLowerCase();
      return lower.includes("customer") || lower.includes("account") || lower.includes("loan");
    });
  }

  function findPaymentRefColumn(record: Record<string, unknown>): string | undefined {
    const keys = Object.keys(record);
    return keys.find(k => k.toLowerCase().includes("payment_reference") || k.toLowerCase() === "payment reference");
  }

  function findConversationKeyCols(record: Record<string, unknown>): { timestampCol?: string; messageCol?: string } {
    const keys = Object.keys(record);
    const timestampCol = keys.find(k => k.toLowerCase() === "date_and_timestamp" || k.toLowerCase() === "date and timestamp");
    const messageCol = keys.find(k => k.toLowerCase() === "message");
    return { timestampCol, messageCol };
  }

  function getRecordKey(record: Record<string, unknown>, keyCols: string[]): string {
    return keyCols.map(col => String(record[col] || "")).join("||");
  }

  app.get("/api/upload-logs", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const category = req.query.category as string;
      if (!category) return res.status(400).json({ error: "Category is required" });

      const logs = await storage.getUploadLogs(companyId, category);

      const logsWithEmail = await Promise.all(
        logs.map(async (log) => {
          const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, log.userId));
          const { rowResults, ...logWithoutResults } = log;
          return { ...logWithoutResults, uploaderEmail: user?.email || "Unknown" };
        })
      );

      res.json(logsWithEmail);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch upload logs" });
    }
  });

  app.get("/api/upload-logs/:id/download", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const logId = Number(req.params.id);
      const log = await storage.getUploadLog(logId);
      if (!log || log.companyId !== companyId) return res.status(404).json({ error: "Upload log not found" });

      const rows = log.rowResults || [];
      if (rows.length === 0) return res.status(400).json({ error: "No row data available" });

      const allDataKeys = Object.keys(rows[0]).filter(k => k !== "_status" && k !== "_message");

      let orderedFields: string[] = [];
      if (log.uploadCategory === "loan_data") {
        orderedFields = [...MANDATORY_LOAN_FIELDS];
        const dataConfig = await storage.getDataConfig(companyId);
        if (dataConfig?.optionalFields) {
          orderedFields.push(...(dataConfig.optionalFields as string[]).filter(f => f !== "conversation_history"));
        }
      } else if (log.uploadCategory === "payment_history") {
        orderedFields = [...MANDATORY_PAYMENT_FIELDS];
        const dataConfig = await storage.getDataConfig(companyId);
        if (dataConfig?.paymentAdditionalFields) {
          orderedFields.push(...(dataConfig.paymentAdditionalFields as string[]));
        }
      } else if (log.uploadCategory === "conversation_history") {
        orderedFields = [...CONVERSATION_HISTORY_FIELDS];
      }

      const knownKeys = orderedFields.filter(f => allDataKeys.includes(f));
      const remainingKeys = allDataKeys.filter(f => !orderedFields.includes(f));
      const headers = [...knownKeys, "status", "message", ...remainingKeys];
      const csvRows = rows.map(row => {
        return headers.map(h => {
          let val: string;
          if (h === "status") val = String(row._status || "");
          else if (h === "message") val = String(row._message || "");
          else val = String((row as Record<string, unknown>)[h] ?? "");
          return val.includes(",") || val.includes('"') || val.includes("\n")
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        }).join(",");
      });

      const csv = [headers.join(","), ...csvRows].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${log.fileName.replace(/\.[^.]+$/, "")}_status.csv"`);
      res.send(csv);
    } catch (error) {
      res.status(500).json({ error: "Failed to download upload log" });
    }
  });

  app.put("/api/uploads/:category/records/:index", authenticate, authorize("admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const category = req.params.category;
      const index = Number(req.params.index);
      const updatedRecord = req.body as Record<string, unknown>;

      if (!Number.isInteger(index) || index < 0) {
        return res.status(400).json({ error: "Invalid record index" });
      }

      const existingUpload = await storage.getUploadByCategory(companyId, category);
      if (!existingUpload || !existingUpload.uploadedData) {
        return res.status(404).json({ error: "No data found for this category" });
      }

      const records = existingUpload.uploadedData as Record<string, unknown>[];
      if (index >= records.length) {
        return res.status(400).json({ error: "Record index out of bounds" });
      }

      records[index] = updatedRecord;

      await storage.updateUploadData(existingUpload.id, {
        uploadedData: records,
        recordCount: records.length,
        fileName: existingUpload.fileName,
        fileSize: existingUpload.fileSize,
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update record" });
    }
  });

  app.delete("/api/uploads/:category/records", authenticate, authorize("admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const category = req.params.category;
      const { indices } = req.body as { indices: number[] };

      if (!Array.isArray(indices) || indices.length === 0) {
        return res.status(400).json({ error: "No rows specified for deletion" });
      }

      const existingUpload = await storage.getUploadByCategory(companyId, category);
      if (!existingUpload || !existingUpload.uploadedData) {
        return res.status(404).json({ error: "No data found for this category" });
      }

      const records = existingUpload.uploadedData as Record<string, unknown>[];
      const validIndices = indices.filter(i => Number.isInteger(i) && i >= 0 && i < records.length);
      const indicesToDelete = new Set(validIndices);
      const remaining = records.filter((_, i) => !indicesToDelete.has(i));

      await storage.updateUploadData(existingUpload.id, {
        uploadedData: remaining,
        recordCount: remaining.length,
        fileName: existingUpload.fileName,
        fileSize: existingUpload.fileSize,
      });

      res.json({ deletedCount: records.length - remaining.length, remainingCount: remaining.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete records" });
    }
  });

  app.post("/api/uploads", authenticate, authorize("admin", "manager"), companyFilter, upload.single("file"), async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const config = await storage.getClientConfig(companyId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const category = req.body.category || "loan_data";

      let newRecords: Record<string, unknown>[] = [];
      const content = file.buffer.toString("utf-8");

      if (file.originalname.endsWith(".csv")) {
        const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
        newRecords = parsed.data as Record<string, unknown>[];
      } else if (file.originalname.endsWith(".json")) {
        const json = JSON.parse(content);
        newRecords = Array.isArray(json) ? json : [json];
      } else {
        return res.status(400).json({ error: "Unsupported file type. Use CSV or JSON." });
      }

      if (category === "payment_history" && newRecords.length > 0 && !findPaymentRefColumn(newRecords[0])) {
        return res.status(400).json({ error: "Payment data must include a 'payment_reference' column" });
      }

      const existingUpload = await storage.getUploadByCategory(companyId, category);
      const rowResults: Array<Record<string, unknown> & { _status: string; _message: string }> = [];
      let processedCount = 0;
      let failedCount = 0;

      if (existingUpload && existingUpload.uploadedData) {
        const existingRecords = existingUpload.uploadedData as Record<string, unknown>[];
        const idCol = newRecords.length > 0 ? findIdColumn(newRecords[0]) : undefined;

        let keyCols: string[] = [];
        let keyLabels: string[] = [];
        if (idCol) {
          keyCols = [idCol];
          keyLabels = ["ID"];
          if (category === "payment_history") {
            const paymentRefCol = findPaymentRefColumn(newRecords[0]);
            if (paymentRefCol) {
              keyCols.push(paymentRefCol);
              keyLabels.push("payment reference");
            }
          } else if (category === "conversation_history") {
            const { timestampCol, messageCol } = findConversationKeyCols(newRecords[0]);
            if (timestampCol) { keyCols.push(timestampCol); keyLabels.push("date and timestamp"); }
            if (messageCol) { keyCols.push(messageCol); keyLabels.push("message"); }
          }
        }

        let mergedRecords: Record<string, unknown>[];

        if (idCol) {
          const existingKeys = new Set<string>();
          const recordMap = new Map<string, Record<string, unknown>>();
          for (const r of existingRecords) {
            const key = getRecordKey(r, keyCols);
            const emptyKey = keyCols.every(c => !String(r[c] || ""));
            if (!emptyKey) {
              recordMap.set(key, r);
              existingKeys.add(key);
            }
          }
          for (const r of newRecords) {
            let missingField: string | null = null;
            for (let k = 0; k < keyCols.length; k++) {
              if (!String(r[keyCols[k]] || "")) {
                missingField = keyLabels[k];
                break;
              }
            }
            if (missingField) {
              rowResults.push({ ...r, _status: "failed", _message: `Missing ${missingField} value` });
              failedCount++;
              continue;
            }
            const key = getRecordKey(r, keyCols);
            const isUpdate = existingKeys.has(key);
            recordMap.set(key, r);
            rowResults.push({ ...r, _status: isUpdate ? "updated" : "created", _message: isUpdate ? "Updated successfully" : "Created successfully" });
            processedCount++;
          }
          mergedRecords = Array.from(recordMap.values());
        } else {
          mergedRecords = [...existingRecords, ...newRecords];
          for (const r of newRecords) {
            rowResults.push({ ...r, _status: "created", _message: "Created successfully" });
            processedCount++;
          }
        }

        const updatedUpload = await storage.updateUploadData(existingUpload.id, {
          uploadedData: mergedRecords,
          recordCount: mergedRecords.length,
          fileName: file.originalname,
          fileSize: file.size,
        });

        await storage.createUploadLog({
          dataUploadId: existingUpload.id,
          userId,
          companyId,
          fileName: file.originalname,
          fileType: file.originalname.endsWith(".csv") ? "CSV" : "JSON",
          fileSize: file.size,
          recordCount: newRecords.length,
          processedCount,
          failedCount,
          uploadCategory: category,
          rowResults,
        });

        res.status(200).json(updatedUpload);
      } else {
        for (const r of newRecords) {
          rowResults.push({ ...r, _status: "created", _message: "Created successfully" });
          processedCount++;
        }

        const uploadRecord = await storage.createUpload({
          fileName: file.originalname,
          fileType: file.originalname.endsWith(".csv") ? "CSV" : "JSON",
          fileSize: file.size,
          recordCount: newRecords.length,
          status: "uploaded",
          uploadCategory: category,
          uploadedData: newRecords,
          userId,
          companyId,
          clientConfigId: config.id,
        });

        await storage.createUploadLog({
          dataUploadId: uploadRecord.id,
          userId,
          companyId,
          fileName: file.originalname,
          fileType: file.originalname.endsWith(".csv") ? "CSV" : "JSON",
          fileSize: file.size,
          recordCount: newRecords.length,
          processedCount,
          failedCount,
          uploadCategory: category,
          rowResults,
        });

        res.status(201).json(uploadRecord);
      }
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to upload file" });
    }
  });

  app.post("/api/analyze", authenticate, authorize("admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);

      const existingJob = analysisJobs.get(companyId);
      if (existingJob && !existingJob.complete) {
        return res.status(409).json({ error: "Analysis already in progress." });
      }
      if (existingJob) {
        analysisJobs.delete(companyId);
      }

      const loanUpload = await storage.getUploadByCategory(companyId, "loan_data");
      if (!loanUpload || !loanUpload.uploadedData || !(loanUpload.uploadedData as Record<string, unknown>[]).length) {
        return res.status(400).json({ error: "No loan data uploaded. Please upload loan data first." });
      }

      const dataConfig = await storage.getDataConfig(companyId);
      const policyConfig = await storage.getPolicyConfig(companyId);
      const loanRecords = loanUpload.uploadedData as Record<string, unknown>[];

      const paymentUpload = await storage.getUploadByCategory(companyId, "payment_history");
      const paymentRecords = (paymentUpload?.uploadedData || []) as Record<string, unknown>[];

      const conversationUpload = await storage.getUploadByCategory(companyId, "conversation_history");
      const conversationRecords = (conversationUpload?.uploadedData || []) as Record<string, unknown>[];

      const customerIdField = "customer / account / loan id";
      const customerMap = new Map<string, { loan: Record<string, unknown>; payments: Record<string, unknown>[]; conversations: Record<string, unknown>[] }>();

      for (const loan of loanRecords) {
        const custId = String(loan[customerIdField] || "").trim();
        if (!custId) continue;
        if (!customerMap.has(custId)) {
          customerMap.set(custId, { loan, payments: [], conversations: [] });
        }
      }

      for (const payment of paymentRecords) {
        const custId = String(payment[customerIdField] || "").trim();
        if (custId && customerMap.has(custId)) {
          customerMap.get(custId)!.payments.push(payment);
        }
      }

      for (const conv of conversationRecords) {
        const custId = String(conv[customerIdField] || "").trim();
        if (custId && customerMap.has(custId)) {
          customerMap.get(custId)!.conversations.push(conv);
        }
      }

      const customers = Array.from(customerMap.entries());
      if (!customers.length) return res.status(400).json({ error: "No valid customers found in loan data." });

      const clientConfig = await storage.getClientConfig(companyId);

      await storage.deletePendingDecisions(companyId);

      const job: AnalysisJob = { events: [], complete: false, listeners: new Set() };
      analysisJobs.set(companyId, job);

      const emitEvent = (event: Record<string, unknown>) => {
        job.events.push(event);
        for (const listener of job.listeners) {
          listener(event);
        }
      };

      res.json({ started: true, total: customers.length });

      (async () => {
        try {
          emitEvent({ type: "start", total: customers.length });

          let completed = 0;
          let failed = 0;

          clearTemplateCache();
          const dpdStagesData = await storage.getDpdStages(companyId);
          const compiled = compilePolicyPrompt({
            dpdStages: dpdStagesData.map(s => ({ name: s.name, fromDays: s.fromDays, toDays: s.toDays })),
            vulnerabilityDefinition: policyConfig?.vulnerabilityDefinition,
            affordabilityRules: policyConfig?.affordabilityRules,
            treatments: policyConfig?.availableTreatments,
            decisionRules: policyConfig?.decisionRules,
            escalationRules: policyConfig?.escalationRules,
          });
          const compiledPolicy = compiled as unknown as Record<string, string>;

          for (const [custId, data] of customers) {
            try {
              const combinedData: Record<string, unknown> = {
                ...data.loan,
                _payments: data.payments,
                _conversations: data.conversations,
                _payment_count: data.payments.length,
                _conversation_count: data.conversations.length,
              };

              const assembledPrompt = assemblePrompt(
                compiledPolicy,
                combinedData,
                dataConfig?.outputFormat || undefined
              );

              const result = await analyzeCustomer(
                combinedData,
                assembledPrompt
              );

              await storage.createDecision({
                clientConfigId: clientConfig?.id || 0,
                dataUploadId: loanUpload.id,
                userId,
                companyId,
                customerGuid: result.customer_guid || custId,
                customerData: combinedData,
                combinedCmd: result.combined_cmd,
                problemDescription: result.problem_description,
                problemConfidenceScore: result.problem_confidence_score,
                problemEvidence: result.problem_evidence,
                proposedSolution: result.proposed_solution,
                solutionConfidenceScore: result.solution_confidence_score,
                solutionEvidence: result.solution_evidence,
                internalAction: result.internal_action,
                abilityToPay: result.ability_to_pay,
                reasonForAbilityToPay: result.reason_for_ability_to_pay,
                noOfLatestPaymentsFailed: result.no_of_latest_payments_failed,
                proposedEmailToCustomer: result.proposed_email_to_customer,
                aiRawOutput: result as unknown as Record<string, unknown>,
                status: "pending",
              });

              completed++;
              emitEvent({ type: "progress", completed, failed, total: customers.length, customerGuid: custId });
            } catch (err) {
              failed++;
              console.error(`AI analysis failed for customer ${custId}:`, err);
              emitEvent({ type: "error", completed, failed, total: customers.length, customerGuid: custId, error: String(err) });
            }
          }

          emitEvent({ type: "complete", completed, failed, total: customers.length });
        } catch (error) {
          console.error("Background analysis error:", error);
          emitEvent({ type: "error", error: "Analysis failed unexpectedly" });
        } finally {
          job.complete = true;
          setTimeout(() => analysisJobs.delete(companyId), 30000);
        }
      })();
    } catch (error) {
      console.error("Analyze error:", error);
      res.status(500).json({ error: "Failed to start analysis" });
    }
  });

  app.get("/api/analyze/events", authenticate, companyFilter, async (req: any, res) => {
    const companyId = getCompanyId(req);

    let job = analysisJobs.get(companyId);
    if (!job) {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        job = analysisJobs.get(companyId);
        if (job) break;
      }
    }

    if (!job) {
      return res.status(404).json({ error: "No active analysis" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const startIdx = parseInt(req.query.lastIndex as string) || 0;
    for (let i = startIdx; i < job.events.length; i++) {
      res.write(`id: ${i + 1}\ndata: ${JSON.stringify(job.events[i])}\n\n`);
    }

    if (job.complete) {
      res.end();
      return;
    }

    let eventIdx = job.events.length;
    const listener = (event: Record<string, unknown>) => {
      eventIdx++;
      res.write(`id: ${eventIdx}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "complete" || (event.type === "error" && !event.customerGuid)) {
        res.end();
      }
    };

    job.listeners.add(listener);

    req.on("close", () => {
      job!.listeners.delete(listener);
    });
  });

  // Process upload with AI
  app.post("/api/uploads/:id/process", authenticate, authorize("admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const companyId = getCompanyId(req);
      const uploadId = parseInt(req.params.id);
      const uploadRecord = await storage.getUpload(uploadId);

      if (!uploadRecord || uploadRecord.companyId !== companyId) return res.status(404).json({ error: "Upload not found" });
      if (uploadRecord.status === "processed") return res.status(400).json({ error: "Already processed" });

      const rbs = await storage.getRulebooks(companyId);
      if (!rbs.length) return res.status(400).json({ error: "No rulebook configured" });

      const dataConfig = await storage.getDataConfig(companyId);
      const sopText = rbs.map(r => r.sopText || r.extractedText || "").join("\n\n");
      const records = (uploadRecord.uploadedData || []) as Record<string, unknown>[];

      if (!records.length) return res.status(400).json({ error: "No records in upload" });

      await storage.updateUploadStatus(uploadId, "processing");

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const sendEvent = (event: { type: string; [key: string]: unknown }) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      await batchProcessWithSSE(
        records,
        async (record, index) => {
          const result = await analyzeCustomer(
            record,
            sopText,
            dataConfig?.promptTemplate || undefined
          );

          await storage.createDecision({
            clientConfigId: uploadRecord.clientConfigId,
            dataUploadId: uploadId,
            userId,
            companyId,
            customerGuid: result.customer_guid,
            customerData: record,
            combinedCmd: result.combined_cmd,
            problemDescription: result.problem_description,
            problemConfidenceScore: result.problem_confidence_score,
            problemEvidence: result.problem_evidence,
            proposedSolution: result.proposed_solution,
            solutionConfidenceScore: result.solution_confidence_score,
            solutionEvidence: result.solution_evidence,
            internalAction: result.internal_action,
            abilityToPay: result.ability_to_pay,
            reasonForAbilityToPay: result.reason_for_ability_to_pay,
            noOfLatestPaymentsFailed: result.no_of_latest_payments_failed,
            proposedEmailToCustomer: result.proposed_email_to_customer,
            aiRawOutput: result as unknown as Record<string, unknown>,
            status: "pending",
          });

          return result;
        },
        (event) => {
          sendEvent({ ...event, total: records.length });
        },
        { retries: 5, minTimeout: 2000, maxTimeout: 30000 }
      );

      await storage.updateUploadStatus(uploadId, "processed");
      res.end();
    } catch (error) {
      console.error("Processing error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to process upload" });
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Processing failed" })}\n\n`);
        res.end();
      }
    }
  });

  // Decisions
  app.get("/api/decisions/stats", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const stats = await storage.getDecisionStats(companyId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/decisions/:status", authenticate, companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const status = req.params.status;
      if (!isNaN(parseInt(status))) {
        const decision = await storage.getDecision(parseInt(status));
        if (!decision || decision.companyId !== companyId) return res.status(404).json({ error: "Decision not found" });
        return res.json(decision);
      }
      const decisionsList = await storage.getDecisions(companyId, status);
      res.json(decisionsList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch decisions" });
    }
  });

  app.delete("/api/decisions/bulk", authenticate, authorize("admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === "number")) {
        return res.status(400).json({ error: "ids must be a non-empty array of numbers" });
      }
      await storage.deleteDecisionsByIds(ids, companyId);
      res.json({ success: true, deleted: ids.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete decisions" });
    }
  });

  app.patch("/api/decisions/:id/review", authenticate, authorize("admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const id = parseInt(req.params.id);
      const existing = await storage.getDecision(id);
      if (!existing || existing.companyId !== companyId) return res.status(404).json({ error: "Decision not found" });
      const { agentAgreed, agentReason } = req.body;
      const decision = await storage.updateDecisionReview(id, agentAgreed, agentReason);
      res.json(decision);
    } catch (error) {
      res.status(500).json({ error: "Failed to update review" });
    }
  });

  app.patch("/api/decisions/:id/email-review", authenticate, authorize("admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const id = parseInt(req.params.id);
      const existing = await storage.getDecision(id);
      if (!existing || existing.companyId !== companyId) return res.status(404).json({ error: "Decision not found" });
      const { emailAccepted, emailRejectReason } = req.body;
      const decision = await storage.updateDecisionEmailReview(id, emailAccepted, emailRejectReason);
      res.json(decision);
    } catch (error) {
      res.status(500).json({ error: "Failed to update email review" });
    }
  });

  return httpServer;
}
