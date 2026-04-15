import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { authenticate, authorize, companyFilter } from "./middleware/auth";
import multer from "multer";
import Papa from "papaparse";
import { analyzeCustomer, extractTextFromImage, analyzeCategoryFields, extractSOPTreatments, extractTextFromPdfWithVision, generateTreatmentDraft, type ColumnEvidence } from "./ai-engine";
import { batchProcessWithSSE } from "./replit_integrations/batch";
import { users, uploadLogs, companies, treatments, treatmentRuleGroups, treatmentRules, policyPacks, policyFields } from "@shared/schema";
import type { PolicyFieldDto, RuleSaveRow, DerivationConfig, ArithmeticDerivationConfig, LogicalDerivationConfig } from "@shared/schema";
import { resolveFieldType, deduceTypeFromDerivation, inferBusinessFieldType, safeCoerce, type FieldDataType } from "@shared/field-utils";
import { db } from "./db";
import { eq, inArray } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { normalizeFieldLabel, buildFullFieldCatalog } from "./field-catalog";
import { toLogicOperator, normalizeDraftPriorities } from "./lib/treatment-logic";
import { LogicalDerivationConfigSchema, topologicalSort, generateLogicalDerivationSummary } from "./lib/derivation-config";
import { compilePolicyPrompt } from "./lib/prompt/compile-policy";
import { assemblePrompt, assemblePreview, formatCustomerData, clearTemplateCache } from "./lib/prompt/assemble-prompt";
import { seedDatabase } from "./seed";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { inferBusinessFields } from "./lib/decisioning/business-field-engine";
import { computeDerivedFields, buildResolvedSourceFieldsMap } from "./lib/decisioning/derived-field-engine";
import { buildDecisionPacket, type DecisionPacketTreatment, type ResolvedRuleGroup, type ResolvedRuleCondition } from "./lib/decisioning/decision-packet";
import { buildFinalDecisionSystemPrompt, buildFinalDecisionUserPrompt, buildFinalDecisionRetryPrompt } from "./lib/decisioning/prompts/final-decision-prompt";
import { validateFinalDecisionOutput, tryParseDecisionJson } from "./lib/decisioning/decision-validator";
import { emptyContextSections } from "./lib/decisioning/context-sections";
import { GoogleGenAI } from "@google/genai";

const genAiConfig: any = {
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
};
if (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
  genAiConfig.httpOptions = {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  };
}
const decisionAI = new GoogleGenAI(genAiConfig);

function normalizeSampleValues(input: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value.slice(0, 50));
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Generates a stable, clean treatment code from a treatment name.
 * All non-alphanumeric characters are replaced with underscores and trimmed.
 * This is the single canonical place where treatment codes are generated —
 * used both when building the decision packet and when reading AI output back.
 */
export function makeTreatmentCode(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Resolves a stored field reference to a human-readable label using the same
 * three-format normalisation as derived-field-engine.ts normalizeFieldRef:
 *   1. "source:fieldname" prefix → strip prefix → fieldname
 *   2. Numeric DB ID string → look up in idToLabel map
 *   3. Plain label → returned as-is
 * If unresolvable, logs a warning and returns a "[Unresolved field: X]" placeholder.
 */
function resolveFieldRefToLabel(ref: string | null | undefined, idToLabel: Map<string, string>, context: string): string {
  if (!ref) return "[Unknown field]";
  const bare = ref.startsWith("source:") ? ref.slice(7) : ref;
  const fromMap = idToLabel.get(bare);
  if (fromMap) return fromMap;
  if (/^\d+$/.test(bare)) {
    console.warn(`[Treatment Rules] ${context}: could not resolve numeric field ID "${bare}" — check that allPolicyFields is complete`);
    return `[Unresolved field: ${bare}]`;
  }
  const fromMapFull = idToLabel.get(ref);
  if (fromMapFull) return fromMapFull;
  if (bare !== ref) {
    console.warn(`[Treatment Rules] ${context}: could not resolve field ref "${ref}" after stripping prefix — returning bare name "${bare}"`);
  }
  return bare;
}

/**
 * Formats a human-readable plain English string for a single rule condition.
 */
function formatConditionPlainEnglish(
  leftLabel: string,
  operator: string,
  rightMode: string | null,
  rightConstant: string | null,
  rightLabel: string | null,
): string {
  if (operator === "is_true") return `${leftLabel} is true`;
  if (operator === "is_false") return `${leftLabel} is false`;
  const opDisplay: Record<string, string> = {
    "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤",
    "in": "is one of", "not_in": "is not one of",
    "contains": "contains",
  };
  const op = opDisplay[operator] ?? operator;
  const right = rightMode === "field" && rightLabel ? rightLabel : (rightConstant ?? "?");
  return `${leftLabel} ${op} ${right}`;
}

/**
 * Builds resolved rule groups from a treatment's ruleGroups array.
 * Separates by ruleType ("when_to_offer" vs "blocked_if"), resolves field refs to labels,
 * and formats a plain English string per condition. Preserves group order and condition sort order.
 */
function buildResolvedRuleGroups(
  ruleGroups: Array<{
    ruleType: string;
    logicOperator: string;
    groupOrder: number;
    rules: Array<{
      fieldName: string;
      operator: string;
      value: string | null;
      leftFieldId: string | null;
      rightMode: string | null;
      rightConstantValue: string | null;
      rightFieldId: string | null;
      sortOrder: number;
    }>;
  }>,
  ruleType: "when_to_offer" | "blocked_if",
  idToLabel: Map<string, string>,
  treatmentName: string,
): ResolvedRuleGroup[] {
  return ruleGroups
    .filter(g => g.ruleType === ruleType)
    .sort((a, b) => a.groupOrder - b.groupOrder)
    .map(g => {
      const conditions: ResolvedRuleCondition[] = g.rules
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(r => {
          const leftRef = r.leftFieldId ?? r.fieldName;
          const leftLabel = resolveFieldRefToLabel(leftRef, idToLabel, `treatment "${treatmentName}" ${ruleType}`);
          const rightMode = (r.rightMode as "constant" | "field" | null) ?? null;
          const rightConstantValue = r.rightConstantValue ?? r.value ?? null;
          const rightFieldLabel = r.rightFieldId
            ? resolveFieldRefToLabel(r.rightFieldId, idToLabel, `treatment "${treatmentName}" ${ruleType} right-side`)
            : null;
          const plainEnglish = formatConditionPlainEnglish(leftLabel, r.operator, rightMode, rightConstantValue, rightFieldLabel);
          return {
            leftFieldLabel: leftLabel,
            operator: r.operator,
            rightMode,
            rightConstantValue: rightMode !== "field" ? rightConstantValue : null,
            rightFieldLabel,
            plainEnglish,
          };
        });
      return {
        logic: (g.logicOperator === "OR" ? "OR" : "AND") as "AND" | "OR",
        conditions,
      };
    });
}

// ——— Analysis concurrency helpers ————————————————————————————————————————————

class AiTimeoutError extends Error {
  constructor(
    public readonly custId: string,
    public readonly stage: string,
    ms: number
  ) {
    super(`AI call timed out after ${ms / 1000}s`);
    this.name = "AiTimeoutError";
  }
}

/**
 * Accepts a factory fn that receives an AbortSignal (for true request cancellation
 * when the SDK supports it) and races it against a timeout. On timeout:
 *   1. controller.abort() is called — cancels the underlying HTTP request if the SDK
 *      has wired up the signal (GoogleGenAI `abortSignal` field does).
 *   2. The returned promise rejects with AiTimeoutError.
 * The timeout timer is always cleared when fn settles, so it never fires after
 * the race is decided.
 */
function withAiTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  custId: string,
  stage: string,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      console.warn(`[Timeout] ${custId} stage=${stage} elapsed=${ms / 1000}s`);
      controller.abort();
      reject(new AiTimeoutError(custId, stage, ms));
    }, ms);
  });
  return Promise.race([
    fn(controller.signal).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; }
    ),
    timeoutPromise,
  ]);
}

/**
 * Calls fn and retries on HTTP 429 / 5xx with exponential back-off + jitter.
 * AiTimeoutError is NEVER retried — it propagates immediately.
 * Logs each retry with customer, stage, attempt number, wait, and HTTP status.
 */
async function callWithBackoff<T>(
  fn: () => Promise<T>,
  custId: string,
  stage: string,
  maxRetries = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof AiTimeoutError) throw err;
      // FieldCallTimeoutError: per-call timeout inside callAIForField — never retry.
      if (err instanceof Error && err.name === "FieldCallTimeoutError") throw err;
      const anyErr = err as Record<string, unknown>;
      const status =
        anyErr?.["status"] ?? anyErr?.["statusCode"] ?? anyErr?.["code"];
      const isRetryable =
        status === 429 ||
        status === "RESOURCE_EXHAUSTED" ||
        (typeof status === "number" && status >= 500);
      if (!isRetryable || attempt === maxRetries) throw err;
      const waitMs =
        Math.min(1000 * Math.pow(2, attempt), 30_000) +
        Math.floor(Math.random() * 1000);
      console.warn(
        `[Retry] ${custId} attempt=${attempt + 1}/${maxRetries} stage=${stage} waitMs=${waitMs} httpStatus=${String(status)}`
      );
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// —————————————————————————————————————————————————————————————————————————————

const WORD_TO_UI_OPERATOR: Record<string, string> = {
  equals: "=",
  not_equals: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  is_true: "is true",
  is_false: "is false",
  exists: "is not empty",
  not_exists: "is empty",
  in: "in",
  not_in: "not in",
};
function wordToUiOperator(op: string): string {
  return WORD_TO_UI_OPERATOR[op] ?? op;
}


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

      const rb = await storage.createRulebook({
        ...req.body,
        userId,
        companyId,
        clientConfigId: config?.id ?? null,
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
        clientConfigId: config?.id ?? null,
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

      if (req.body.categoryData && typeof req.body.categoryData === "object") {
        for (const catEntry of Object.values(req.body.categoryData)) {
          if (!catEntry || typeof catEntry !== "object") continue;
          const entry = catEntry as Record<string, unknown>;
          if (!Array.isArray(entry["fieldAnalysis"])) continue;
          for (const field of entry["fieldAnalysis"] as Record<string, unknown>[]) {
            if (Array.isArray(field["sampleValues"])) {
              field["sampleValues"] = normalizeSampleValues(field["sampleValues"] as unknown[]);
            }
          }
        }
      }

      const config = await storage.createDataConfig({
        ...req.body,
        userId,
        companyId,
        clientConfigId: clientConfig?.id ?? null,
      });
      res.status(201).json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to create data config" });
    }
  });

  app.patch("/api/data-config", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      if (req.body.categoryData && typeof req.body.categoryData === "object") {
        for (const catEntry of Object.values(req.body.categoryData)) {
          if (!catEntry || typeof catEntry !== "object") continue;
          const entry = catEntry as Record<string, unknown>;
          if (!Array.isArray(entry["fieldAnalysis"])) continue;
          for (const field of entry["fieldAnalysis"] as Record<string, unknown>[]) {
            if (Array.isArray(field["sampleValues"])) {
              field["sampleValues"] = normalizeSampleValues(field["sampleValues"] as unknown[]);
            }
          }
        }
      }
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
      let allRows: Record<string, string>[] = [];

      if (isTabular) {
        if (/\.csv$/i.test(file.originalname)) {
          const content = file.buffer.toString("utf-8");
          const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
          if (parsed.data.length > 0) {
            headers = Object.keys(parsed.data[0] as Record<string, unknown>);
            allRows = (parsed.data as Record<string, unknown>[]).slice(0, 10).map(row => {
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
            allRows = data.slice(1, 11).map(row => {
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

      // ── Build per-column compact evidence (up to 10 rows) ──────────────────
      function inferColumnType(values: string[]): ColumnEvidence['inferredType'] {
        if (values.length === 0) return 'categorical';
        const BOOL_VALUES = new Set(['yes', 'no', 'true', 'false', '1', '0', 'y', 'n']);
        const DATE_RE = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/;
        let numCount = 0, boolCount = 0, dateCount = 0;
        for (const v of values) {
          const lv = v.trim().toLowerCase();
          if (!isNaN(Number(lv)) && lv !== '') numCount++;
          if (BOOL_VALUES.has(lv)) boolCount++;
          if (DATE_RE.test(v.trim())) dateCount++;
        }
        const n = values.length;
        if (boolCount / n >= 0.8) return 'boolean-like';
        if (dateCount / n >= 0.6) return 'date-like';
        if (numCount / n >= 0.8) return 'numeric';
        const maxLen = Math.max(...values.map(v => v.length));
        if (maxLen > 60) return 'free-text';
        return 'categorical';
      }

      const columnEvidence: ColumnEvidence[] = headers.map(h => {
        const nonEmpty = allRows.map(r => String(r[h] ?? "").trim()).filter(v => v !== "");
        const sampleValues = nonEmpty.slice(0, 5).map(v => v.slice(0, 60));
        const inferredType = inferColumnType(nonEmpty);
        const unique = [...new Set(nonEmpty)];
        const distinctValues = unique.length <= 8 ? unique.map(v => v.slice(0, 60)) : undefined;
        return { fieldName: h, sampleValues, inferredType, distinctValues };
      });

      let fieldAnalysis: Array<{ fieldName: string; beaconsUnderstanding: string; confidence: 'High' | 'Medium' | 'Low' }> = [];
      if (isTabular && headers.length > 0) {
        fieldAnalysis = await analyzeCategoryFields(category, headers, columnEvidence);
      }

      const evidenceMap = new Map(columnEvidence.map(c => [c.fieldName.toLowerCase(), c]));
      const enrichedFieldAnalysis = fieldAnalysis.map(f => {
        const ev = evidenceMap.get(f.fieldName.toLowerCase());
        const rawSamples = ev?.distinctValues ?? ev?.sampleValues ?? [];
        return {
          fieldName: f.fieldName,
          beaconsUnderstanding: f.beaconsUnderstanding,
          confidence: f.confidence,
          sampleValues: normalizeSampleValues(rawSamples),
          dataType: f.data_type ?? "string",
          allowedValues: f.allowed_values ?? [],
          defaultValue: f.default_value ?? null,
        };
      });

      const companyId = getCompanyId(req);
      const existingDataConfig = companyId ? await storage.getDataConfig(companyId) : undefined;
      const existingCategoryData = (existingDataConfig?.categoryData as Record<string, any>) || {};
      const existingEntry = existingCategoryData[category];
      const previousByField = new Map<string, any>(
        (existingEntry?.fieldAnalysis || []).map((f: any) => [f.fieldName.toLowerCase(), f])
      );

      const mergedFieldAnalysis = enrichedFieldAnalysis.map(next => {
        const prev = previousByField.get(next.fieldName.toLowerCase());
        const prevSamples = prev?.sampleValues && prev.sampleValues.length > 0
          ? normalizeSampleValues(prev.sampleValues)
          : null;
        return {
          fieldName: next.fieldName,
          beaconsUnderstanding: prev?.beaconsUnderstanding || next.beaconsUnderstanding,
          confidence: prev?.confidence || next.confidence,
          ignored: prev?.ignored ?? false,
          sampleValues: prevSamples ?? next.sampleValues,
          dataType: prev?.dataType ?? next.dataType ?? "string",
          allowedValues: prev?.allowedValues ?? next.allowedValues ?? [],
          defaultValue: prev?.defaultValue ?? next.defaultValue ?? null,
        };
      });

      res.json({
        categoryId: category,
        docType: isTabular ? "tabular" : "document",
        fieldAnalysis: mergedFieldAnalysis,
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
        clientConfigId: clientConfig?.id ?? null,
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
      const pack = await storage.getPolicyPack(companyId);
      if (!pack) return res.status(404).json({ error: "No policy pack found" });
      res.json(pack);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch policy pack" });
    }
  });

  app.post("/api/policy-pack", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const { policyName, sourceType, sourceFileName, status, id } = req.body;
      if (!policyName?.trim()) return res.status(400).json({ error: "policyName is required" });
      const pack = await storage.upsertPolicyPack({
        id: id || undefined,
        companyId,
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

  app.get("/api/policy-pack/treatments", authenticate, authorize("superadmin", "admin", "manager", "agent"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const pack = await storage.getPolicyPack(companyId);
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
      const pack = await storage.getPolicyPack(companyId);
      if (!pack) return res.status(400).json({ error: "Create a policy pack first" });
      const { name, shortDescription, enabled, priority, tone, displayOrder, draftSourceFields, draftDerivedFields, draftBusinessFields, aiConfidence } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "Treatment name is required" });
      const tx = await storage.createTreatment({
        policyPackId: pack.id,
        name: name.trim(),
        shortDescription: shortDescription || null,
        enabled: enabled !== false,
        priority: priority || null,
        tone: tone || null,
        displayOrder: displayOrder ?? 0,
        ...(draftSourceFields !== undefined && { draftSourceFields }),
        ...(draftDerivedFields !== undefined && { draftDerivedFields }),
        ...(draftBusinessFields !== undefined && { draftBusinessFields }),
        ...(aiConfidence !== undefined && { aiConfidence }),
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
      const { name, shortDescription, enabled, priority, tone, displayOrder, draftSourceFields, draftDerivedFields, draftBusinessFields, aiConfidence } = req.body;
      const tx = await storage.updateTreatment(id, {
        ...(name !== undefined && { name }),
        ...(shortDescription !== undefined && { shortDescription }),
        ...(enabled !== undefined && { enabled }),
        ...(priority !== undefined && { priority }),
        ...(tone !== undefined && { tone }),
        ...(displayOrder !== undefined && { displayOrder }),
        ...(draftSourceFields !== undefined && { draftSourceFields }),
        ...(draftDerivedFields !== undefined && { draftDerivedFields }),
        ...(draftBusinessFields !== undefined && { draftBusinessFields }),
        ...(aiConfidence !== undefined && { aiConfidence }),
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
      const pack = await storage.getPolicyPack(getCompanyId(req));
      const updated = pack ? await storage.getTreatmentsWithRules(pack.id) : [];
      const tx = updated.find(t => t.id === treatmentId);
      res.json(tx || { id: treatmentId });
    } catch (error) {
      console.error("Save rules error:", error);
      res.status(500).json({ error: "Failed to save rules" });
    }
  });

  // Policy Fields API
  function generateDerivationSummary(config: DerivationConfig): string {
    if ("type" in config && config.type === "logical") {
      return generateLogicalDerivationSummary(config);
    }
    const c = config as ArithmeticDerivationConfig;
    const labelA = c.fieldALabel || c.fieldA || "?";
    const labelB = c.operandBType === "field"
      ? (c.operandBLabel || c.operandBValue || "?")
      : (c.operandBValue || "?");
    if (!c.operator2) return `${labelA} ${c.operator1} ${labelB}`;
    const labelC = c.operandCType === "field"
      ? (c.operandCLabel || c.operandCValue || "?")
      : (c.operandCValue || "?");
    return `(${labelA} ${c.operator1} ${labelB}) ${c.operator2} ${labelC}`;
  }

  function toFieldDto(f: {
    id: number;
    label: string;
    displayName?: string | null;
    description: string | null;
    sourceType: string;
    dataType?: string | null;
    derivationConfig: DerivationConfig | null | undefined;
    derivationSummary: string | null | undefined;
    allowedValues?: string[] | null;
    defaultValue?: string | null;
    businessMeaning?: string | null;
    aiGenerated?: boolean | null;
    createdBy?: string | null;
  }): PolicyFieldDto {
    return {
      id: String(f.id),
      label: f.label,
      displayName: f.displayName ?? null,
      description: f.description,
      sourceType: f.sourceType as PolicyFieldDto["sourceType"],
      dataType: f.dataType ?? null,
      derivationConfig: f.derivationConfig ?? null,
      derivationSummary: f.derivationSummary ?? null,
      allowedValues: f.allowedValues ?? null,
      defaultValue: f.defaultValue ?? null,
      businessMeaning: f.businessMeaning ?? null,
      aiGenerated: f.aiGenerated ?? false,
      createdBy: f.createdBy ?? null,
    };
  }

  app.get("/api/policy-fields", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const catalog = await buildFullFieldCatalog(companyId, storage);
      const result: PolicyFieldDto[] = catalog.map(f => ({
        id: f.id ?? `source:${f.label}`,
        label: f.label,
        displayName: f.displayName ?? null,
        description: f.description ?? null,
        sourceType: f.sourceType,
        dataType: f.dataType ?? null,
        derivationConfig: f.derivationConfig ?? null,
        derivationSummary: f.derivationSummary ?? null,
        allowedValues: f.allowedValues ?? null,
        defaultValue: f.defaultValue ?? null,
        businessMeaning: f.businessMeaning ?? null,
        aiGenerated: f.aiGenerated ?? false,
        createdBy: f.createdBy ?? null,
      }));
      res.json(result);
    } catch (error) {
      console.error("Get policy fields error:", error);
      res.status(500).json({ error: "Failed to fetch policy fields" });
    }
  });

  app.post("/api/policy-fields", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const { label, description, sourceType, derivationConfig, dataType, allowedValues, defaultValue, businessMeaning } = req.body;
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
      const dup = existing.find(f => normalizeFieldLabel(f.label) === normalizeFieldLabel(label));
      if (dup) return res.status(409).json({ error: `Field "${label.trim()}" already exists` });
      const derivationSummary = sourceType === "derived_field" && derivationConfig
        ? generateDerivationSummary(derivationConfig)
        : null;
      const VALID_TYPES = ["string", "number", "boolean", "date", "enum"];
      if (dataType && !VALID_TYPES.includes(dataType)) return res.status(400).json({ error: `dataType must be one of: ${VALID_TYPES.join(", ")}` });
      let resolvedType = dataType || null;
      if (!resolvedType && sourceType === "derived_field" && derivationConfig) {
        const cfg = derivationConfig as { operator1?: string; operator2?: string };
        resolvedType = deduceTypeFromDerivation(cfg).deducedType;
      }
      if (!resolvedType && sourceType === "business_field") {
        const parsedAllowed = Array.isArray(allowedValues) && allowedValues.length > 0 ? allowedValues.map(String) : null;
        resolvedType = inferBusinessFieldType(parsedAllowed, description);
      }
      resolvedType = resolveFieldType(resolvedType, null, null);
      const field = await storage.createPolicyField({
        companyId: companyId!,
        policyPackId: null,
        label: label.trim(),
        description: description?.trim() || null,
        sourceType,
        derivationConfig: derivationConfig || null,
        derivationSummary,
        dataType: resolvedType,
        allowedValues: Array.isArray(allowedValues) && allowedValues.length > 0 ? allowedValues.map(String) : null,
        defaultValue: typeof defaultValue === "string" ? (defaultValue.trim() || null) : defaultValue != null ? String(defaultValue) : null,
        businessMeaning: typeof businessMeaning === "string" ? (businessMeaning.trim() || null) : null,
      });
      res.status(201).json(toFieldDto(field));
    } catch (error) {
      console.error("Create policy field error:", error);
      res.status(500).json({ error: "Failed to create policy field" });
    }
  });

  app.patch("/api/policy-fields/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const fieldId = parseInt(req.params.id, 10);
      if (isNaN(fieldId)) return res.status(400).json({ error: "Invalid field id" });
      const existing = await storage.getPolicyFieldById(fieldId);
      if (!existing) return res.status(404).json({ error: "Field not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ error: "Forbidden" });
      if (!["business_field", "derived_field"].includes(existing.sourceType)) {
        return res.status(400).json({ error: "Only business and derived fields can be edited" });
      }
      const { label, description, derivationConfig, dataType, allowedValues, defaultValue, businessMeaning } = req.body;
      const patch: Partial<Pick<typeof existing, "label" | "description" | "derivationConfig" | "derivationSummary" | "dataType" | "allowedValues" | "defaultValue" | "businessMeaning">> = {};
      if (label !== undefined) {
        const trimmed = label.trim();
        if (!trimmed) return res.status(400).json({ error: "label cannot be empty" });
        const allFields = await storage.getPolicyFields(companyId!);
        const dup = allFields.find(f => f.id !== fieldId && normalizeFieldLabel(f.label) === normalizeFieldLabel(trimmed));
        if (dup) return res.status(409).json({ error: `Field "${trimmed}" already exists` });
        patch.label = trimmed;
      }
      if (description !== undefined) patch.description = description?.trim() || null;
      if (derivationConfig !== undefined && existing.sourceType === "derived_field") {
        const existingConfig = existing.derivationConfig as DerivationConfig | null | undefined;
        if (existingConfig && "type" in existingConfig && existingConfig.type === "logical") {
          return res.status(422).json({ error: "AI-generated logical derivation conditions cannot be edited" });
        }
        const arithmeticConfig = derivationConfig as ArithmeticDerivationConfig;
        if (!arithmeticConfig.fieldA) return res.status(400).json({ error: "derivationConfig.fieldA is required" });
        if (!arithmeticConfig.operator1) return res.status(400).json({ error: "derivationConfig.operator1 is required" });
        if (!arithmeticConfig.operandBType || !arithmeticConfig.operandBValue?.toString().trim()) return res.status(400).json({ error: "derivationConfig operandB is required" });
        if (arithmeticConfig.operator2 !== undefined && arithmeticConfig.operator2 !== "") {
          if (!arithmeticConfig.operandCType || !arithmeticConfig.operandCValue?.toString().trim()) return res.status(400).json({ error: "derivationConfig operandC is required when operator2 is set" });
        }
        patch.derivationConfig = arithmeticConfig;
        patch.derivationSummary = generateDerivationSummary(arithmeticConfig);
      }
      const VALID_DATA_TYPES = ["string", "number", "boolean", "date", "enum"];
      if (dataType !== undefined) {
        if (dataType && !VALID_DATA_TYPES.includes(dataType)) return res.status(400).json({ error: `dataType must be one of: ${VALID_DATA_TYPES.join(", ")}` });
        patch.dataType = dataType || null;
      }
      if (allowedValues !== undefined) patch.allowedValues = Array.isArray(allowedValues) && allowedValues.length > 0 ? allowedValues.map(String) : null;
      if (defaultValue !== undefined) patch.defaultValue = typeof defaultValue === "string" ? (defaultValue.trim() || null) : defaultValue != null ? String(defaultValue) : null;
      if (businessMeaning !== undefined) patch.businessMeaning = typeof businessMeaning === "string" ? (businessMeaning.trim() || null) : null;
      const updated = await storage.updatePolicyField(fieldId, patch);
      res.json(toFieldDto(updated));
    } catch (error) {
      console.error("Update policy field error:", error);
      res.status(500).json({ error: "Failed to update policy field" });
    }
  });

  app.delete("/api/policy-fields/:id", authenticate, authorize("admin"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const fieldId = parseInt(req.params.id, 10);
      if (isNaN(fieldId)) return res.status(400).json({ error: "Invalid field id" });
      const existing = await storage.getPolicyFieldById(fieldId);
      if (!existing) return res.status(404).json({ error: "Field not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ error: "Forbidden" });
      if (!["business_field", "derived_field"].includes(existing.sourceType)) {
        return res.status(400).json({ error: "Only business and derived fields can be deleted" });
      }
      await storage.deletePolicyField(fieldId);
      res.status(204).end();
    } catch (error) {
      console.error("Delete policy field error:", error);
      res.status(500).json({ error: "Failed to delete policy field" });
    }
  });

  app.post("/api/policy-pack/extract-sop", authenticate, authorize("admin"), companyFilter, (_req: any, res: any) => {
    res.status(410).json({ error: "This endpoint has been replaced. Please use POST /api/policy-pack/generate-treatment-draft with PDF files instead." });
  });

  const sopUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  app.post("/api/policy-pack/generate-treatment-draft",
    authenticate, authorize("admin"),
    companyFilter,
    sopUpload.array("sopFiles", 10),
    async (req: any, res) => {
      const companyId = getCompanyId(req);
      const files = req.files as Express.Multer.File[] | undefined;
      const requestId = Math.random().toString(36).slice(2, 10);

      try {
        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No files uploaded" });
        }
        for (const file of files) {
          const hassPdfExtension = file.originalname.toLowerCase().endsWith(".pdf");
          const hasPdfMime = file.mimetype === "application/pdf" || file.mimetype === "application/x-pdf";
          if (!hassPdfExtension && !hasPdfMime) {
            return res.status(400).json({ error: `"${file.originalname}" is not a PDF. Only PDF files are accepted.` });
          }
        }

        const pack = await storage.getPolicyPack(companyId);
        if (!pack) return res.status(400).json({ error: "No policy pack found — save your policy configuration first" });

        const pdfParseMod = await import("pdf-parse");
        const PdfParser: { new(opts: { data: Buffer }): { getText(): Promise<{ text: string }> } } = pdfParseMod.PDFParse;
        const textParts: string[] = [];

        for (const file of files) {
          let text = "";
          try {
            const parser = new PdfParser({ data: file.buffer });
            const result = await parser.getText();
            text = result.text?.trim() ?? "";
          } catch {
            text = "";
          }

          const nonWsChars = (text.match(/\S/g) || []).length;
          const alphaNumChars = (text.match(/[a-zA-Z0-9]/g) || []).length;
          const textQuality = nonWsChars > 0 ? alphaNumChars / nonWsChars : 0;
          if (nonWsChars < 100 || textQuality < 0.4) {
            try {
              text = await extractTextFromPdfWithVision(file.buffer);
            } catch (visionErr) {
              return res.status(422).json({ error: `Could not extract text from "${file.originalname}". Please ensure the file is readable.` });
            }
          }

          if (!text.trim()) {
            return res.status(422).json({ error: `No readable content found in "${file.originalname}".` });
          }

          textParts.push(`=== ${file.originalname} ===\n${text}`);
        }

        const sopBundle = textParts.join("\n\n");

        // Save uploaded PDFs to disk so they can be downloaded later
        const uploadsDir = path.join(process.cwd(), "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const sopFilesMeta: { originalName: string; safeName: string; uploadedAt: string }[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const nonce = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
          const safeName = `sop-${nonce}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          fs.writeFileSync(path.join(uploadsDir, safeName), file.buffer);
          sopFilesMeta.push({ originalName: file.originalname, safeName, uploadedAt: new Date().toISOString() });
        }

        const fullCatalog = await buildFullFieldCatalog(companyId, storage);
        const fieldCatalog = fullCatalog.map(f => ({
          label: f.label,
          sourceType: f.sourceType,
          description: f.description?.slice(0, 200) ?? null,
          sampleValues: f.sourceType === "source_field" ? (f.sampleValues ?? []) : [],
          ...(f.sourceType === "derived_field" ? { derivationSummary: f.derivationSummary?.slice(0, 200) ?? null } : {}),
        }));

        // Build column evidence from all uploaded data categories so the
        // post-processor can detect "Yes"/"No" and "0"/"1" source fields and
        // rewrite any spurious is_true/is_false rules to equality operators.
        // Later categories don't overwrite earlier ones (loan fields take priority).
        const evidenceByField = new Map<string, ColumnEvidence>();
        for (const category of ["loan", "payment_history", "conversation_history"]) {
          const upload = await storage.getUploadByCategory(companyId, category);
          if (!upload?.uploadedData || !Array.isArray(upload.uploadedData)) continue;
          const rows = upload.uploadedData as Record<string, unknown>[];
          if (rows.length === 0) continue;
          for (const h of Object.keys(rows[0])) {
            if (evidenceByField.has(h.toLowerCase())) continue;
            const nonEmpty = rows.map(r => String(r[h] ?? "").trim()).filter(v => v !== "");
            const sampleValues = nonEmpty.slice(0, 5).map(v => v.slice(0, 60));
            const unique = Array.from(new Set(nonEmpty));
            const distinctValues = unique.length <= 8 ? unique.map(v => v.slice(0, 60)) : undefined;
            evidenceByField.set(h.toLowerCase(), { fieldName: h, sampleValues, inferredType: "categorical" as const, distinctValues });
          }
        }
        const draftColumnEvidence: ColumnEvidence[] = Array.from(evidenceByField.values());

        console.log(`[generate-treatment-draft] [${requestId}] company=${companyId} pack=${pack.id} files=${files.length} fields=${fieldCatalog.length} evidence_cols=${draftColumnEvidence.length}`);

        const draftResponse = await generateTreatmentDraft(sopBundle, fieldCatalog, draftColumnEvidence);

        console.log(`[generate-treatment-draft] [${requestId}] ai_output treatments=${draftResponse.treatments.length} open_questions=${draftResponse.open_questions.length}`);

        const fieldByLabelLower = new Map(fullCatalog.map(f => [normalizeFieldLabel(f.label), f]));

        const UNARY_OPS = new Set(["is_true", "is_false", "exists", "not_exists"]);
        const EQUALITY_OPS = new Set(["equals", "not_equals"]);
        const SET_OPS = new Set(["in", "not_in"]);
        const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);
        const VALID_OPERATORS = new Set([...UNARY_OPS, ...EQUALITY_OPS, ...SET_OPS, ...NUMERIC_OPS]);

        const normalizedTreatments = draftResponse.treatments
          .filter(t => t.name?.trim())
          .reduce((acc: typeof draftResponse.treatments, t) => {
            const key = t.name.trim().toLowerCase();
            if (!acc.some(x => x.name.trim().toLowerCase() === key)) acc.push(t);
            return acc;
          }, [])
          .map(t => ({
            ...t,
            source_fields: t.source_fields.reduce((acc: typeof t.source_fields, sf) => {
              const resolved = fieldByLabelLower.get(normalizeFieldLabel(sf.field_name));
              const canonicalName = resolved ? resolved.label : sf.field_name;
              if (!acc.some(x => normalizeFieldLabel(x.field_name) === normalizeFieldLabel(canonicalName))) {
                acc.push({ ...sf, field_name: canonicalName, matched_existing_field: !!resolved });
              }
              return acc;
            }, []),
            derived_fields: t.derived_fields.reduce((acc: typeof t.derived_fields, df) => {
              if (!acc.some(x => x.field_name.toLowerCase() === df.field_name.toLowerCase())) acc.push(df);
              return acc;
            }, []),
            business_fields: t.business_fields.reduce((acc: typeof t.business_fields, bf) => {
              if (!acc.some(x => x.field_name.toLowerCase() === bf.field_name.toLowerCase())) acc.push(bf);
              return acc;
            }, []),
          }));

        // Phase A: Early exit if no treatments
        if (normalizedTreatments.length === 0) {
          console.log(`[generate-treatment-draft] [${requestId}] validation=failed reason=empty_output`);
          return res.status(422).json({ error: "No treatments could be generated from the uploaded documents. Please check that the SOP files contain identifiable treatment policies and try again." });
        }

        // Phase A-pre: Structural fail-fast validation — invalid rule shapes abort with 422, no commit
        const validateRule = (r: { field_name: string; operator: string; value?: unknown }, label: string) => {
          const errors: string[] = [];
          if (!r.field_name || !r.field_name.trim()) {
            errors.push(`${label} rule has empty field_name`);
          }
          if (!VALID_OPERATORS.has(r.operator)) {
            errors.push(`${label} uses invalid operator "${r.operator}" (allowed: ${Array.from(VALID_OPERATORS).join(", ")})`);
            return errors;
          }
          if (UNARY_OPS.has(r.operator)) {
            if (r.value != null) {
              errors.push(`${label} operator "${r.operator}" must not have a value (got ${JSON.stringify(r.value)})`);
            }
          } else if (EQUALITY_OPS.has(r.operator)) {
            const vt = typeof r.value;
            if (r.value == null || !["string", "number", "boolean"].includes(vt)) {
              errors.push(`${label} operator "${r.operator}" requires a string, number, or boolean value (got ${r.value == null ? "null/undefined" : vt})`);
            }
          } else if (SET_OPS.has(r.operator)) {
            if (!Array.isArray(r.value)) {
              errors.push(`${label} operator "${r.operator}" requires an array value (got ${r.value == null ? "null/undefined" : typeof r.value})`);
            } else {
              const badElements = (r.value as unknown[]).filter(el => !["string", "number", "boolean"].includes(typeof el));
              if (badElements.length > 0) {
                errors.push(`${label} operator "${r.operator}" array contains invalid element types — each element must be string, number, or boolean`);
              }
            }
          } else if (NUMERIC_OPS.has(r.operator)) {
            if (typeof r.value !== "number") {
              errors.push(`${label} operator "${r.operator}" requires a numeric value (got ${r.value == null ? "null/undefined" : typeof r.value})`);
            }
          }
          return errors;
        };

        const structuralErrors: string[] = [];
        for (const t of normalizedTreatments) {
          for (const r of t.when_to_offer) {
            structuralErrors.push(...validateRule(r, `Treatment "${t.name}": when_to_offer`));
          }
          for (const r of t.blocked_if) {
            structuralErrors.push(...validateRule(r, `Treatment "${t.name}": blocked_if`));
          }
        }
        if (structuralErrors.length > 0) {
          console.warn(`[generate-treatment-draft] [${requestId}] Structural validation failed: ${structuralErrors.length} error(s)`);
          return res.status(422).json({
            error: "AI output failed structural validation — no changes committed",
            details: structuralErrors,
          });
        }

        // Phase B: Collect all unique derived + business fields (global + per-treatment)
        type AIDerived = (typeof normalizedTreatments)[0]["derived_fields"][0];
        type AIBusiness = (typeof normalizedTreatments)[0]["business_fields"][0];
        const allDerivedByKey = new Map<string, AIDerived>();
        const allBusinessByKey = new Map<string, AIBusiness>();

        for (const gdf of (draftResponse.global_derived_fields ?? []) as AIDerived[]) {
          const k = normalizeFieldLabel(gdf.field_name);
          if (!allDerivedByKey.has(k)) allDerivedByKey.set(k, gdf);
        }
        for (const gbf of (draftResponse.global_business_fields ?? []) as AIBusiness[]) {
          const k = normalizeFieldLabel(gbf.field_name);
          if (!allBusinessByKey.has(k)) allBusinessByKey.set(k, gbf);
        }
        for (const t of normalizedTreatments) {
          for (const df of t.derived_fields) {
            const k = normalizeFieldLabel(df.field_name);
            if (!allDerivedByKey.has(k)) allDerivedByKey.set(k, df);
          }
          for (const bf of t.business_fields) {
            const k = normalizeFieldLabel(bf.field_name);
            if (!allBusinessByKey.has(k)) allBusinessByKey.set(k, bf);
          }
        }

        // Phase C: Classify fields — skip existing, validate new, track unresolved
        const unresolvedFields: Array<{ fieldName: string; fieldType: string; reason: string; issueType?: string }> = [];
        const fieldsToCreateDerived: AIDerived[] = [];
        const fieldsToCreateBusiness: AIBusiness[] = [];

        // Step C1: Validate derivation_config schema for new derived fields
        const validatedDerived: AIDerived[] = [];
        for (const [key, df] of allDerivedByKey.entries()) {
          if (fieldByLabelLower.has(key)) continue;
          // New field being created — flag if creation_reason is missing
          if (!df.creation_reason || !df.creation_reason.trim()) {
            console.warn(`[generate-treatment-draft] [${requestId}] derived field "${df.field_name}" created without creation_reason`);
            unresolvedFields.push({
              fieldName: df.field_name,
              fieldType: "derived_field",
              issueType: "missing_creation_reason",
              reason: `Derived field "${df.field_name}" was created without a justification — review whether an existing source field could have been used instead`,
            });
          }
          if (!df.derivation_config) {
            unresolvedFields.push({
              fieldName: df.field_name,
              fieldType: "derived",
              reason: "Missing derivation_config: derived fields must have a structured logical derivation config to be system-consumable",
            });
            continue;
          }
          const parse = LogicalDerivationConfigSchema.safeParse(df.derivation_config);
          if (!parse.success) {
            unresolvedFields.push({
              fieldName: df.field_name,
              fieldType: "derived",
              reason: `Invalid derivation_config: ${parse.error.issues[0]?.message ?? "schema error"}`,
            });
            continue;
          }
          validatedDerived.push(df);
        }
        for (const [key, bf] of allBusinessByKey.entries()) {
          if (fieldByLabelLower.has(key)) continue;
          // New field being created — flag if creation_reason is missing
          if (!bf.creation_reason || !bf.creation_reason.trim()) {
            console.warn(`[generate-treatment-draft] [${requestId}] business field "${bf.field_name}" created without creation_reason`);
            unresolvedFields.push({
              fieldName: bf.field_name,
              fieldType: "business_field",
              issueType: "missing_creation_reason",
              reason: `Business field "${bf.field_name}" was created without a justification — review whether an existing source field could have been used instead`,
            });
          }
          if (!bf.field_name || !bf.field_name.trim()) {
            unresolvedFields.push({ fieldName: "(unnamed)", fieldType: "business", reason: "Business field has an empty field_name and cannot be created" });
            continue;
          }
          if (!bf.description || !bf.description.trim()) {
            unresolvedFields.push({ fieldName: bf.field_name, fieldType: "business", reason: "Business field is missing a description — required for business meaning documentation" });
            continue;
          }
          fieldsToCreateBusiness.push(bf);
        }

        // Step C2: Validate depends_on references against available name set
        const availableFieldNames = new Set<string>([
          ...Array.from(fieldByLabelLower.keys()),
          ...validatedDerived.map(df => normalizeFieldLabel(df.field_name)),
          ...fieldsToCreateBusiness.map(bf => normalizeFieldLabel(bf.field_name)),
        ]);
        for (const df of validatedDerived) {
          const missingDeps = (df.depends_on ?? []).filter(dep => !availableFieldNames.has(normalizeFieldLabel(dep)));
          if (missingDeps.length > 0) {
            unresolvedFields.push({
              fieldName: df.field_name,
              fieldType: "derived",
              reason: `Unresolved depends_on: [${missingDeps.join(", ")}] not found in field catalog or fields being created`,
            });
          } else {
            fieldsToCreateDerived.push(df);
          }
        }

        // Phase D: Topological sort of derived fields (deps first)
        const topoResult = topologicalSort(
          fieldsToCreateDerived.map(df => ({ fieldName: df.field_name, dependsOn: df.depends_on ?? [] }))
        );
        for (const cyclic of topoResult.cyclic) {
          unresolvedFields.push({
            fieldName: cyclic.fieldName,
            fieldType: "derived",
            reason: `Circular dependency detected in derived field "${cyclic.fieldName}". Cannot auto-create.`,
          });
        }
        const sortedDerivedFields = topoResult.sorted
          .map(node => fieldsToCreateDerived.find(df => df.field_name.toLowerCase() === node.fieldName.toLowerCase())!)
          .filter(Boolean);

        // Phase E: Build candidate catalog (existing + to-be-created) for treatment classification
        type CatalogEntry = { id: string; label: string; sourceType: string; description: string | null; derivationConfig: DerivationConfig | null; derivationSummary: string | null };
        const candidateCatalog = new Map<string, CatalogEntry>(
          Array.from(fieldByLabelLower.entries()).map(([k, v]) => [k, {
            id: v.id ?? `source:${v.label}`,
            label: v.label,
            sourceType: v.sourceType,
            description: v.description ?? null,
            derivationConfig: v.derivationConfig ?? null,
            derivationSummary: v.derivationSummary ?? null,
          }])
        );
        for (const df of sortedDerivedFields) {
          candidateCatalog.set(normalizeFieldLabel(df.field_name), {
            id: `pending:${df.field_name}`, label: df.field_name, sourceType: "derived_field",
            description: df.description ?? null,
            derivationConfig: df.derivation_config,
            derivationSummary: df.derivation_summary ?? null,
          });
        }
        for (const bf of fieldsToCreateBusiness) {
          candidateCatalog.set(normalizeFieldLabel(bf.field_name), {
            id: `pending:${bf.field_name}`, label: bf.field_name, sourceType: "business_field",
            description: bf.description ?? null, derivationConfig: null, derivationSummary: null,
          });
        }

        // Phase F: Classify treatments — safe vs critical-dependency
        const unresolvedTreatments: Array<{ name: string; reason: string; unresolvedFields: string[] }> = [];
        const safeTreatments: Array<(typeof normalizedTreatments)[0]> = [];

        // Phase A-pre guarantees all operators are valid by this point — Phase F only resolves fields
        for (const t of normalizedTreatments) {
          const criticalReasons: string[] = [];

          const unresolvedWhen = t.when_to_offer.filter(r => !candidateCatalog.has(normalizeFieldLabel(r.field_name)));
          const resolvedWhen = t.when_to_offer.filter(r => candidateCatalog.has(normalizeFieldLabel(r.field_name)));

          if (t.when_to_offer_logic === "ALL" && unresolvedWhen.length > 0) {
            criticalReasons.push(`when_to_offer (ALL logic): unresolved [${unresolvedWhen.map(r => r.field_name).join(", ")}] — all eligibility conditions must be resolvable`);
          } else if (t.when_to_offer_logic === "ANY" && resolvedWhen.length === 0 && t.when_to_offer.length > 0) {
            criticalReasons.push(`when_to_offer (ANY logic): all fields unresolved [${unresolvedWhen.map(r => r.field_name).join(", ")}] — at least one must be resolvable`);
          }

          const unresolvedBlocked = t.blocked_if.filter(r => !candidateCatalog.has(normalizeFieldLabel(r.field_name)));
          if (unresolvedBlocked.length > 0) {
            criticalReasons.push(`blocked_if: unresolved safety guards [${unresolvedBlocked.map(r => r.field_name).join(", ")}]`);
          }

          if (criticalReasons.length > 0) {
            const unresolvedFieldNames = Array.from(new Set([
              ...unresolvedWhen.map(r => r.field_name),
              ...unresolvedBlocked.map(r => r.field_name),
            ]));
            unresolvedTreatments.push({ name: t.name, reason: criticalReasons.join("; "), unresolvedFields: unresolvedFieldNames });
          } else {
            safeTreatments.push(t);
          }
        }

        console.log(`[generate-treatment-draft] [${requestId}] pipeline: derived=${sortedDerivedFields.length} business=${fieldsToCreateBusiness.length} safe=${safeTreatments.length} unresolvedTx=${unresolvedTreatments.length} unresolvedFields=${unresolvedFields.length}`);

        // Phase G: DB Transaction
        const createdFields: { derived: Array<{ label: string; id: string; creationReason?: string }>; business: Array<{ label: string; id: string; creationReason?: string }> } = {
          derived: [], business: [],
        };
        const createdTreatments: Array<{ name: string; id: number }> = [];
        const liveFieldMap = new Map<string, CatalogEntry>(candidateCatalog);
        // Reset to only existing fields; will populate as fields are inserted
        for (const k of Array.from(liveFieldMap.keys())) {
          if (liveFieldMap.get(k)!.id.startsWith("pending:")) liveFieldMap.delete(k);
        }

        await db.transaction(async (tx) => {
          // 1. Delete existing treatments + rules for this pack
          const existingTxs = await tx.select({ id: treatments.id }).from(treatments)
            .where(eq(treatments.policyPackId, pack.id));
          if (existingTxs.length > 0) {
            const txIds = existingTxs.map(e => e.id);
            const groups = await tx.select({ id: treatmentRuleGroups.id }).from(treatmentRuleGroups)
              .where(inArray(treatmentRuleGroups.treatmentId, txIds));
            if (groups.length > 0) {
              await tx.delete(treatmentRules).where(inArray(treatmentRules.ruleGroupId, groups.map(g => g.id)));
            }
            await tx.delete(treatmentRuleGroups).where(inArray(treatmentRuleGroups.treatmentId, txIds));
            await tx.delete(treatments).where(inArray(treatments.id, txIds));
          }

          // 2. Insert business fields
          for (const bf of fieldsToCreateBusiness) {
            const [inserted] = await tx.insert(policyFields).values({
              companyId: companyId!,
              policyPackId: null,
              label: bf.field_name.trim(),
              displayName: bf.display_name?.trim() || null,
              description: bf.description?.trim() || null,
              sourceType: "business_field",
              dataType: bf.data_type || null,
              allowedValues: bf.allowed_values?.length ? bf.allowed_values : null,
              defaultValue: bf.default_value?.trim() || null,
              businessMeaning: bf.business_meaning?.trim() || null,
              aiGenerated: true,
              createdBy: "system_sop_import",
              sourceDocumentId: requestId,
            }).returning();
            liveFieldMap.set(normalizeFieldLabel(inserted.label), {
              id: String(inserted.id), label: inserted.label, sourceType: "business_field",
              description: inserted.description ?? null, derivationConfig: null, derivationSummary: null,
            });
            createdFields.business.push({ label: inserted.label, id: String(inserted.id), creationReason: bf.creation_reason || undefined });
          }

          // 3. Insert derived fields in topological order (dependencies first)
          for (const df of sortedDerivedFields) {
            const derivationConfig: LogicalDerivationConfig | null = df.derivation_config ?? null;
            const derivationSummary = df.derivation_summary?.trim() ||
              (derivationConfig !== null ? generateLogicalDerivationSummary(derivationConfig) : null);
            const [inserted] = await tx.insert(policyFields).values({
              companyId: companyId!,
              policyPackId: null,
              label: df.field_name.trim(),
              displayName: df.display_name?.trim() || null,
              description: df.description?.trim() || null,
              sourceType: "derived_field",
              dataType: df.data_type || null,
              allowedValues: df.allowed_values?.length ? df.allowed_values : null,
              defaultValue: df.default_value?.trim() || null,
              businessMeaning: df.business_meaning?.trim() || null,
              derivationConfig: derivationConfig,
              derivationSummary: derivationSummary || null,
              aiGenerated: true,
              createdBy: "system_sop_import",
              sourceDocumentId: requestId,
            }).returning();
            liveFieldMap.set(normalizeFieldLabel(inserted.label), {
              id: String(inserted.id), label: inserted.label, sourceType: "derived_field",
              description: inserted.description ?? null,
              derivationConfig: inserted.derivationConfig ?? null,
              derivationSummary: inserted.derivationSummary ?? null,
            });
            createdFields.derived.push({ label: inserted.label, id: String(inserted.id), creationReason: df.creation_reason || undefined });
          }

          // 4. Insert safe treatments with rules
          const normalizedPriorities = normalizeDraftPriorities(safeTreatments.map(t => t.priority ?? null));
          for (let i = 0; i < safeTreatments.length; i++) {
            const t = safeTreatments[i];
            // Operators are all valid at this point (guaranteed by Phase A-pre)
            const resolvedWhen = t.when_to_offer.filter(r => liveFieldMap.has(normalizeFieldLabel(r.field_name)));
            const resolvedBlocked = t.blocked_if.filter(r => liveFieldMap.has(normalizeFieldLabel(r.field_name)));
            // Track skipped when_to_offer rules (ANY logic, some unresolved — non-critical)
            for (const r of t.when_to_offer.filter(r => !liveFieldMap.has(normalizeFieldLabel(r.field_name)))) {
              if (!unresolvedFields.some(u => u.fieldName === r.field_name && u.fieldType === "rule_reference")) {
                unresolvedFields.push({
                  fieldName: r.field_name, fieldType: "rule_reference",
                  reason: `Skipped: unresolved field in when_to_offer (ANY) for treatment "${t.name}"`,
                });
              }
            }
            const [newTx] = await tx.insert(treatments).values({
              policyPackId: pack.id,
              name: t.name.trim(),
              shortDescription: t.description || null,
              enabled: true,
              priority: normalizedPriorities[i],
              tone: null,
              displayOrder: i,
              draftSourceFields: t.source_fields.map(sf => ({
                fieldName: sf.field_name,
                description: sf.description,
                matchedExistingField: sf.matched_existing_field,
              })),
              draftDerivedFields: t.derived_fields.map(df => ({
                fieldName: df.field_name,
                displayName: df.display_name || "",
                description: df.description,
                dataType: df.data_type,
                derivationSummary: df.derivation_summary || "",
                dependsOn: df.depends_on,
                creationReason: df.creation_reason || undefined,
              })),
              draftBusinessFields: t.business_fields.map(bf => ({
                fieldName: bf.field_name,
                displayName: bf.display_name || "",
                description: bf.description,
                dataType: bf.data_type,
                allowedValues: bf.allowed_values,
                defaultValue: bf.default_value,
                businessMeaning: bf.business_meaning,
                creationReason: bf.creation_reason || undefined,
              })),
              aiConfidence: t.confidence,
            }).returning();

            if (resolvedWhen.length > 0) {
              const [whenGroup] = await tx.insert(treatmentRuleGroups).values({
                treatmentId: newTx.id,
                ruleType: "when_to_offer",
                logicOperator: toLogicOperator(t.when_to_offer_logic, "AND"),
                groupOrder: 0,
              }).returning();
              for (let j = 0; j < resolvedWhen.length; j++) {
                const r = resolvedWhen[j];
                const fieldRecord = liveFieldMap.get(normalizeFieldLabel(r.field_name))!;
                const leftFieldId = fieldRecord.id;
                const uiOp = wordToUiOperator(r.operator);
                const rawValue = r.value != null ? String(Array.isArray(r.value) ? r.value.join(", ") : r.value) : "";
                await tx.insert(treatmentRules).values({
                  ruleGroupId: whenGroup.id,
                  fieldName: fieldRecord.label,
                  operator: uiOp,
                  value: rawValue,
                  sortOrder: j,
                  leftFieldId,
                  rightMode: "constant",
                  rightConstantValue: rawValue,
                  rightFieldId: null,
                });
              }
            }
            if (resolvedBlocked.length > 0) {
              const [blockedGroup] = await tx.insert(treatmentRuleGroups).values({
                treatmentId: newTx.id,
                ruleType: "blocked_if",
                logicOperator: toLogicOperator(t.blocked_if_logic, "OR"),
                groupOrder: 0,
              }).returning();
              for (let j = 0; j < resolvedBlocked.length; j++) {
                const r = resolvedBlocked[j];
                const fieldRecord = liveFieldMap.get(normalizeFieldLabel(r.field_name))!;
                const leftFieldId = fieldRecord.id;
                const uiOp = wordToUiOperator(r.operator);
                const rawValue = r.value != null ? String(Array.isArray(r.value) ? r.value.join(", ") : r.value) : "";
                await tx.insert(treatmentRules).values({
                  ruleGroupId: blockedGroup.id,
                  fieldName: fieldRecord.label,
                  operator: uiOp,
                  value: rawValue,
                  sortOrder: j,
                  leftFieldId,
                  rightMode: "constant",
                  rightConstantValue: rawValue,
                  rightFieldId: null,
                });
              }
            }
            createdTreatments.push({ name: newTx.name, id: newTx.id });
          }

          // 5. Update pack metadata (including the source PDFs used for this generation)
          await tx.update(policyPacks).set({
            lastAiGenerationRawOutput: draftResponse as unknown as Record<string, unknown>,
            lastAiGenerationAt: new Date(),
            aiGenerationSummary: draftResponse.summary || null,
            aiOpenQuestions: draftResponse.open_questions,
            sopSourceFiles: sopFilesMeta,
            updatedAt: new Date(),
          }).where(eq(policyPacks.id, pack.id));
        });

        const updatedTreatments = await storage.getTreatmentsWithRules(pack.id);
        const updatedPack = await storage.getPolicyPack(companyId);

        res.json({
          treatments: updatedTreatments,
          summary: draftResponse.summary,
          openQuestions: draftResponse.open_questions,
          generatedAt: updatedPack?.lastAiGenerationAt || new Date(),
          createdTreatments,
          createdFields,
          unresolvedTreatments,
          unresolvedFields,
        });
      } catch (error) {
        console.error(`[generate-treatment-draft] [${requestId}] error company=${companyId}:`, error instanceof Error ? error.message : error);
        const isValidation = error instanceof Error && "isValidationError" in error && (error as Error & { isValidationError: boolean }).isValidationError;
        const statusCode = isValidation ? 422 : 500;
        res.status(statusCode).json({ error: error instanceof Error ? error.message : "Failed to generate treatment draft" });
      }
    }
  );

  app.get("/api/policy-pack/sop-files/:safeName", authenticate, authorize("superadmin", "admin", "manager"), companyFilter, async (req: any, res) => {
    try {
      const companyId = getCompanyId(req);
      const safeName = req.params.safeName as string;
      if (!safeName || /[/\\]/.test(safeName)) return res.status(400).json({ error: "Invalid filename" });
      const pack = await storage.getPolicyPack(companyId);
      if (!pack) return res.status(404).json({ error: "No policy pack found" });
      const meta = (pack.sopSourceFiles || []).find(f => f.safeName === safeName);
      if (!meta) return res.status(404).json({ error: "File not found" });
      const filePath = path.join(process.cwd(), "uploads", safeName);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(meta.originalName)}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.status(500).json({ error: "Failed to serve file" });
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
        clientConfigId: config?.id ?? null,
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
          clientConfigId: config?.id ?? null,
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

      const bureauUpload = await storage.getUploadByCategory(companyId, "credit_bureau");
      const bureauRecords = (bureauUpload?.uploadedData || []) as Record<string, unknown>[];

      const incomeUpload = await storage.getUploadByCategory(companyId, "income_employment");
      const incomeRecords = (incomeUpload?.uploadedData || []) as Record<string, unknown>[];

      const allRulebooks = await storage.getRulebooks(companyId);
      const rulebookGuidanceItems: unknown[] = allRulebooks.map(rb => ({
        id: String(rb.id),
        title: rb.title,
        text: rb.extractedText || rb.sopText || "",
      })).filter((rb) => (rb as Record<string, unknown>)["text"]);

      const CUSTOMER_ID_CANDIDATES = [
        "customer / account / loan id",
        "customer_id",
        "customer id",
        "account_id",
        "account id",
        "loan_id",
        "loan id",
        "id",
      ];

      const firstLoanKeys = loanRecords[0] ? Object.keys(loanRecords[0]) : [];
      const customerIdField =
        CUSTOMER_ID_CANDIDATES.find(c => firstLoanKeys.some(k => k.toLowerCase() === c.toLowerCase()))
        ?? firstLoanKeys[0]
        ?? "customer / account / loan id";

      console.log(`[Analyze] Customer ID field detected: "${customerIdField}" (from keys: [${firstLoanKeys.slice(0, 5).join(", ")}])`);

      const customerMap = new Map<string, { loan: Record<string, unknown>; payments: Record<string, unknown>[]; conversations: Record<string, unknown>[]; bureau: Record<string, unknown> | null; income: Record<string, unknown> | null }>();

      const resolveId = (row: Record<string, unknown>): string => {
        const direct = row[customerIdField];
        if (direct != null && String(direct).trim()) return String(direct).trim();
        const keyLower = Object.keys(row).find(k => k.toLowerCase() === customerIdField.toLowerCase());
        return keyLower ? String(row[keyLower] || "").trim() : "";
      };

      for (const loan of loanRecords) {
        const custId = resolveId(loan);
        if (!custId) continue;
        if (!customerMap.has(custId)) {
          customerMap.set(custId, { loan, payments: [], conversations: [], bureau: null, income: null });
        }
      }

      for (const payment of paymentRecords) {
        const custId = resolveId(payment);
        if (custId && customerMap.has(custId)) {
          customerMap.get(custId)!.payments.push(payment);
        }
      }

      for (const conv of conversationRecords) {
        const custId = resolveId(conv);
        if (custId && customerMap.has(custId)) {
          customerMap.get(custId)!.conversations.push(conv);
        }
      }

      for (const bureau of bureauRecords) {
        const custId = resolveId(bureau);
        if (custId && customerMap.has(custId) && !customerMap.get(custId)!.bureau) {
          customerMap.get(custId)!.bureau = bureau;
        }
      }

      for (const income of incomeRecords) {
        const custId = resolveId(income);
        if (custId && customerMap.has(custId) && !customerMap.get(custId)!.income) {
          customerMap.get(custId)!.income = income;
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

          const allPolicyFields = await storage.getPolicyFields(companyId);
          const businessFieldDefs = allPolicyFields.filter(f => f.sourceType === "business_field");
          const derivedFieldDefs = allPolicyFields.filter(f => f.sourceType === "derived_field");

          const compliancePolicyRules: unknown[] = [];
          if (policyConfig) {
            if (policyConfig.vulnerabilityDefinition) {
              compliancePolicyRules.push({ id: "vulnerability_definition", title: "Vulnerability Definition", text: policyConfig.vulnerabilityDefinition });
            }
            if (Array.isArray(policyConfig.affordabilityRules) && policyConfig.affordabilityRules.length > 0) {
              for (const rule of policyConfig.affordabilityRules) {
                const r = rule as Record<string, unknown>;
                compliancePolicyRules.push({ id: `affordability_${r["name"] ?? compliancePolicyRules.length}`, title: `Affordability Rule: ${r["name"] ?? ""}`, text: r["rule"] ?? r["name"] ?? "" });
              }
            }
            if (Array.isArray(policyConfig.decisionRules) && policyConfig.decisionRules.length > 0) {
              for (const rule of policyConfig.decisionRules) {
                const r = rule as Record<string, unknown>;
                compliancePolicyRules.push({ id: `decision_${r["id"] ?? compliancePolicyRules.length}`, title: `Decision Rule: ${r["name"] ?? r["condition"] ?? ""}`, text: r["action"] ?? r["description"] ?? r["name"] ?? "" });
              }
            }
            if (policyConfig.compiledPolicy && typeof policyConfig.compiledPolicy === "object") {
              const compiled = policyConfig.compiledPolicy as Record<string, string>;
              for (const [key, val] of Object.entries(compiled)) {
                if (val && typeof val === "string" && val.length > 0) {
                  compliancePolicyRules.push({ id: `policy_${key}`, title: key, text: val });
                }
              }
            }
          }

          const policyPack = await storage.getPolicyPack(companyId);

          const idToLabel = new Map<string, string>(
            allPolicyFields.map(f => [String(f.id), f.label])
          );

          const treatmentsWithRules = policyPack
            ? await storage.getTreatmentsWithRules(policyPack.id)
            : [];

          const packedTreatments: DecisionPacketTreatment[] = treatmentsWithRules
            .filter(t => t.enabled)
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map(t => {
              const whenToOfferRules = buildResolvedRuleGroups(t.ruleGroups, "when_to_offer", idToLabel, t.name);
              const blockedIfRules = buildResolvedRuleGroups(t.ruleGroups, "blocked_if", idToLabel, t.name);
              return {
                name: t.name,
                code: makeTreatmentCode(t.name),
                description: t.shortDescription || undefined,
                enabled: t.enabled,
                priority: t.priority,
                displayOrder: t.displayOrder,
                whenToOfferRules,
                blockedIfRules,
              };
            });

          console.log(`[Decisioning] Treatments loaded: ${packedTreatments.length} enabled | ${treatmentsWithRules.length} total`, packedTreatments.map(t => ({
            name: t.name,
            code: t.code,
            whenToOfferGroups: t.whenToOfferRules.length,
            blockedIfGroups: t.blockedIfRules.length,
            whenToOfferConditions: t.whenToOfferRules.reduce((s, g) => s + g.conditions.length, 0),
            blockedIfConditions: t.blockedIfRules.reduce((s, g) => s + g.conditions.length, 0),
            sample: t.whenToOfferRules[0]?.conditions[0]?.plainEnglish ?? "(no conditions)",
          })));

          // Read and validate concurrency config
          const rawConcurrency = parseInt(process.env.ANALYSIS_MAX_CONCURRENCY || "3", 10);
          const maxConcurrency = Math.max(1, Math.min(5, isNaN(rawConcurrency) ? 3 : rawConcurrency));
          if (maxConcurrency !== rawConcurrency) {
            console.warn(`[Batch] ANALYSIS_MAX_CONCURRENCY=${rawConcurrency} out of range [1,5]; using ${maxConcurrency}`);
          }
          console.log(`[Batch] Starting parallel analysis | customers=${customers.length} | concurrency=${maxConcurrency}`);

          // Per-AI-call timeout (ms) — configurable, default 120s, NaN-safe
          const rawTimeoutMs = parseInt(process.env.AI_CALL_TIMEOUT_MS || "120000", 10);
          const aiCallTimeoutMs = isNaN(rawTimeoutMs) ? 120_000 : rawTimeoutMs;
          if (aiCallTimeoutMs < 30_000) {
            console.warn(`[Batch] AI_CALL_TIMEOUT_MS=${aiCallTimeoutMs}ms is very low (<30s) — Gemini calls typically take 30–120s`);
          }

          // Deep-freeze shared context — no cross-customer mutation possible,
          // including nested arrays (whenToOfferRules, blockedIfRules, conditions)
          const frozenTreatments = Object.freeze(
            packedTreatments.map(t => Object.freeze({
              ...t,
              whenToOfferRules: Object.freeze(t.whenToOfferRules.map(g => Object.freeze({
                ...g,
                conditions: Object.freeze([...g.conditions]),
              }))),
              blockedIfRules: Object.freeze(t.blockedIfRules.map(g => Object.freeze({
                ...g,
                conditions: Object.freeze([...g.conditions]),
              }))),
            }))
          ) as readonly DecisionPacketTreatment[];
          const frozenAllPolicyFields = Object.freeze([...allPolicyFields]);
          const frozenBusinessFieldDefs = Object.freeze([...businessFieldDefs]);
          const frozenDerivedFieldDefs = Object.freeze([...derivedFieldDefs]);
          const frozenComplianceRules = Object.freeze([...compliancePolicyRules]);
          const frozenRulebookItems = Object.freeze([...rulebookGuidanceItems]);

          // ——— processCustomer —————————————————————————————————————
          const processCustomer = async (custId: string, data: {
            loan: Record<string, unknown>;
            payments: Record<string, unknown>[];
            conversations: Record<string, unknown>[];
            bureau: Record<string, unknown> | null;
            income: Record<string, unknown> | null;
          }): Promise<void> => {
            const t0 = Date.now();

            // Stage: context build
            const tCtxStart = Date.now();
            const combinedData: Record<string, unknown> = {
              ...data.loan,
              _payments: data.payments,
              _conversations: data.conversations,
              _payment_count: data.payments.length,
              _conversation_count: data.conversations.length,
            };

            const resolvedSourceFields = buildResolvedSourceFieldsMap(combinedData, frozenAllPolicyFields as typeof allPolicyFields);

            const contextSections = emptyContextSections();
            contextSections.customerProfile = resolvedSourceFields;
            contextSections.loanData = data.loan;
            contextSections.paymentData = data.payments;
            contextSections.conversationData = data.conversations;
            contextSections.resolvedSourceFields = resolvedSourceFields;
            if (data.bureau) contextSections.bureauData = data.bureau;
            if (data.income) contextSections.incomeEmploymentData = data.income;
            if (frozenRulebookItems.length > 0) {
              contextSections.knowledgeBaseAgentGuidance = [...frozenRulebookItems];
            }
            if (frozenComplianceRules.length > 0) {
              contextSections.compliancePolicyInternalRules = [...frozenComplianceRules];
            }

            const businessFieldMetas = (frozenBusinessFieldDefs as typeof businessFieldDefs).map(f => ({
              id: String(f.id),
              label: f.label,
              description: f.description,
              dataType: f.dataType,
              allowedValues: f.allowedValues,
              defaultValue: f.defaultValue,
              businessMeaning: f.businessMeaning,
            }));
            const tCtxMs = Date.now() - tCtxStart;

            // Stage: business field inference (AI)
            // Each individual generateContent call inside inferBusinessFields has its own
            // per-call timeout (aiCallTimeoutMs) via an internal AbortController in
            // callAIForField. backoff retries non-timeout failures (429/5xx) on the
            // entire inferBusinessFields invocation.
            const tBizStart = Date.now();
            let businessFieldTraces: Awaited<ReturnType<typeof inferBusinessFields>>;
            try {
              businessFieldTraces = await callWithBackoff(
                () => inferBusinessFields(businessFieldMetas, contextSections, aiCallTimeoutMs),
                custId,
                "bizFields"
              );
            } catch (err: unknown) {
              const tBizElapsed = Date.now() - tBizStart;
              if (err instanceof Error && err.name === "FieldCallTimeoutError") {
                console.warn(
                  `[Timeout] ${custId} stage=bizFields elapsed=${tBizElapsed}ms — ${err.message}`
                );
              }
              throw err;
            }
            const tBizMs = Date.now() - tBizStart;

            const businessFieldsMap: Record<string, unknown> = {};
            for (const trace of businessFieldTraces) {
              if (trace.value !== null) businessFieldsMap[trace.field_label] = trace.value;
            }

            // Stage: derived fields
            const tDerivedStart = Date.now();
            // narrativeTextFieldIds intentionally empty — see comment in prior version
            const narrativeTextFieldIds: Record<string, boolean> = {};
            const derivedFieldTraces = computeDerivedFields(
              frozenDerivedFieldDefs as typeof derivedFieldDefs,
              resolvedSourceFields,
              businessFieldsMap,
              narrativeTextFieldIds,
              frozenAllPolicyFields as typeof allPolicyFields
            );

            const derivedFieldsMap: Record<string, unknown> = {};
            for (const trace of derivedFieldTraces) {
              if (trace.output_value !== null) derivedFieldsMap[trace.field_label] = trace.output_value;
            }
            const tDerivedMs = Date.now() - tDerivedStart;

            console.log(`[Decisioning] Customer ${custId}: starting analysis with ${frozenTreatments.length} treatments, ${Object.keys(businessFieldsMap).length} business fields, ${Object.keys(derivedFieldsMap).length} derived fields`);

            // Build decision packet
            const packet = buildDecisionPacket({
              customerId: custId,
              resolvedSourceFields,
              businessFields: businessFieldsMap,
              derivedFields: derivedFieldsMap,
              loanData: data.loan,
              paymentData: data.payments,
              conversationData: data.conversations,
              bureauData: data.bureau ?? {},
              incomeEmploymentData: data.income ?? {},
              treatments: frozenTreatments as unknown as DecisionPacketTreatment[],
              compliancePolicyInternalRules: frozenComplianceRules as unknown[],
              escalationRules: policyConfig?.escalationRules ? [policyConfig.escalationRules] : [],
            });

            const systemPrompt = buildFinalDecisionSystemPrompt();
            const userPrompt = buildFinalDecisionUserPrompt(packet);

            const escCount = packet.policy.escalationRules?.length ?? 0;
            const compCount = packet.policy.compliancePolicyInternalRules?.length ?? 0;
            console.log(`[Decisioning] Customer ${custId}: packet escalationRules=${escCount} compliancePolicyInternalRules=${compCount}`);

            // Stage: final AI decision — errors propagate so pool counts this customer as failed
            // timeout wraps each individual generateContent attempt; backoff retries non-timeout failures
            const tFinalStart = Date.now();
            let attempt1RawText = "";
            let attempt1Parsed: Record<string, unknown> | null = null;
            let attempt1Passed = false;
            let attempt1Errors: string[] = [];
            let finalParsed: Record<string, unknown>;
            let attempt2RawText = "";
            let attempt2Passed = false;
            let attempt2Errors: string[] = [];

            const resp1 = await callWithBackoff(
              () => withAiTimeout(
                (signal) => decisionAI.models.generateContent({
                  model: "gemini-2.5-pro",
                  contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
                  config: { maxOutputTokens: 16000 },
                  abortSignal: signal,
                }),
                custId,
                "finalDecision-1",
                aiCallTimeoutMs
              ),
              custId,
              "finalDecision-1"
            );
            attempt1RawText = resp1.text || "";
            attempt1Parsed = tryParseDecisionJson(attempt1RawText);
            const v1 = validateFinalDecisionOutput(attempt1Parsed, packet);
            attempt1Passed = v1.valid;
            attempt1Errors = v1.errors;

            if (attempt1Passed && attempt1Parsed) {
              finalParsed = attempt1Parsed;
            } else {
              const retryPrompt = buildFinalDecisionRetryPrompt(attempt1Errors.join("; "));
              const resp2 = await callWithBackoff(
                () => withAiTimeout(
                  (signal) => decisionAI.models.generateContent({
                    model: "gemini-2.5-pro",
                    contents: [
                      { role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] },
                      { role: "model", parts: [{ text: attempt1RawText }] },
                      { role: "user", parts: [{ text: retryPrompt }] },
                    ],
                    config: { maxOutputTokens: 16000 },
                    abortSignal: signal,
                  }),
                  custId,
                  "finalDecision-2",
                  aiCallTimeoutMs
                ),
                custId,
                "finalDecision-2"
              );
              attempt2RawText = resp2.text || "";
              const attempt2Parsed = tryParseDecisionJson(attempt2RawText);
              const v2 = validateFinalDecisionOutput(attempt2Parsed, packet);
              attempt2Passed = v2.valid;
              attempt2Errors = v2.errors;
              if (attempt2Passed && attempt2Parsed) {
                finalParsed = attempt2Parsed;
              } else {
                // Both validation attempts failed — count this customer as failed
                const errSummary = `attempt1: [${attempt1Errors.join("; ")}]; attempt2: [${attempt2Errors.join("; ")}]`;
                console.error(`[analyze] Customer ${custId}: both validation attempts failed. ${errSummary}`);
                throw new Error(`Customer ${custId}: both AI validation attempts failed. ${errSummary}`);
              }
            }
            const tFinalMs = Date.now() - tFinalStart;

            // Extract treatment details — finalParsed is guaranteed valid here
            const code = String(finalParsed.recommended_treatment_code || "AGENT_REVIEW");
            const matchedTreatment = (frozenTreatments as unknown as DecisionPacketTreatment[]).find(t => t.code === code);
            let treatmentName: string;
            let treatmentCode: string;
            if (code === "AGENT_REVIEW") {
              treatmentName = "Agent Review";
              treatmentCode = "AGENT_REVIEW";
            } else if (code === "NO_ACTION") {
              treatmentName = "No Action";
              treatmentCode = "NO_ACTION";
            } else if (matchedTreatment) {
              treatmentName = matchedTreatment.name;
              treatmentCode = code;
            } else {
              treatmentName = String(finalParsed.recommended_treatment_name || "Agent Review");
              treatmentCode = code;
            }
            const customerSituation = String(finalParsed.customer_summary || "");
            const td = (finalParsed.treatment_decision && typeof finalParsed.treatment_decision === "object" && !Array.isArray(finalParsed.treatment_decision))
              ? finalParsed.treatment_decision as Record<string, unknown>
              : null;
            const treatmentEligibilityExplanation = String(td?.["treatment_rationale"] || "");
            const structuredAssessments: Array<{ name: string; value: string | null; reason: string }> = [];
            const proposedEmail = String(finalParsed.proposed_email_to_customer || "NO_ACTION");
            const internalAction = String(finalParsed.internal_action || "");
            const requiresAgentReview = Boolean(finalParsed.requires_agent_review);

            console.log(`[Decisioning] Customer ${custId}: AI selected treatment "${treatmentName}" (${treatmentCode}) | requires_agent_review=${requiresAgentReview} | validation=${attempt1Passed ? "pass-attempt1" : "pass-attempt2"}`);

            const validationTrace: Record<string, unknown> = {
              attempt_1: {
                passed: attempt1Passed,
                errors: attempt1Errors,
                raw_response: attempt1RawText.substring(0, 3000),
              },
              final_status: "passed",
            };
            if (!attempt1Passed) {
              validationTrace["attempt_2"] = {
                passed: attempt2Passed,
                errors: attempt2Errors,
                raw_response: attempt2RawText.substring(0, 3000),
              };
            }

            const decisionTraceJson: Record<string, unknown> = {
              engine_version: "1.0",
              decision_packet: packet as unknown as Record<string, unknown>,
              business_fields_trace: businessFieldTraces,
              derived_fields_trace: derivedFieldTraces,
              validation: validationTrace,
              final_ai_output: finalParsed,
            };

            // Stage: save
            const tSaveStart = Date.now();
            await storage.createDecision({
              clientConfigId: clientConfig?.id ?? null,
              dataUploadId: loanUpload.id,
              userId,
              companyId,
              customerGuid: custId,
              customerData: combinedData,
              proposedSolution: String(finalParsed.proposed_next_best_action || ""),
              internalAction: internalAction || (requiresAgentReview ? "Escalate for agent review." : ""),
              proposedEmailToCustomer: proposedEmail,
              aiRawOutput: finalParsed as Record<string, unknown>,
              status: "pending",
              recommendedTreatmentName: treatmentName,
              recommendedTreatmentCode: treatmentCode,
              customerSituation,
              treatmentEligibilityExplanation,
              structuredAssessments,
              decisionTraceJson,
            });
            const tSaveMs = Date.now() - tSaveStart;

            const totalMs = Date.now() - t0;
            console.log(
              `[Timing] ${custId} | context=${tCtxMs}ms | bizFields=${tBizMs}ms | derivedFields=${tDerivedMs}ms | finalDecision=${tFinalMs}ms | save=${tSaveMs}ms | total=${totalMs}ms`
            );
          };
          // ——— end processCustomer ————————————————————————————————

          // ——— Concurrency-limited worker pool ———————————————————
          const batchStart = Date.now();
          const queue = [...customers];
          let inFlight = 0;

          await new Promise<void>((resolvePool) => {
            const dispatch = () => {
              while (inFlight < maxConcurrency && queue.length > 0) {
                const item = queue.shift()!;
                const [custId, custData] = item;
                inFlight++;
                processCustomer(custId, custData)
                  .then(() => {
                    completed++;
                  })
                  .catch((err: unknown) => {
                    failed++;
                    console.error(`AI analysis failed for customer ${custId}:`, err);
                  })
                  .finally(() => {
                    inFlight--;
                    dispatch(); // may increment inFlight for next queued customer
                    emitEvent({ type: "progress", completed, failed, inFlight, total: customers.length, customerGuid: custId });
                  });
              }
              if (inFlight === 0 && queue.length === 0) {
                resolvePool();
              }
            };
            dispatch();
          });

          const batchWallClock = Math.round((Date.now() - batchStart) / 1000);
          const avgPerCustomer = customers.length > 0
            ? Math.round(batchWallClock / customers.length)
            : 0;
          console.log(
            `[Batch] done | total=${customers.length} | completed=${completed} | failed=${failed} | wallClock=${batchWallClock}s | avgPerCustomer=${avgPerCustomer}s`
          );

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

      const allFields = await storage.getPolicyFields(companyId);
      const fieldTypeMap = new Map<string, FieldDataType>();
      for (const f of allFields) {
        const resolved = resolveFieldType(f.dataType, null, null);
        fieldTypeMap.set(f.label.toLowerCase(), resolved);
      }

      await batchProcessWithSSE(
        records,
        async (record, index) => {
          const coercedRecord: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(record)) {
            const fieldType = fieldTypeMap.get(key.toLowerCase());
            if (fieldType && value != null) {
              coercedRecord[key] = safeCoerce(value, fieldType);
            } else {
              coercedRecord[key] = value;
            }
          }
          const result = await analyzeCustomer(
            coercedRecord,
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
      const { agentAgreed, agentReason, agentOverrideTreatment } = req.body;
      if (agentOverrideTreatment !== undefined) {
        if (typeof agentOverrideTreatment !== "string" || agentOverrideTreatment.trim() === "") {
          return res.status(400).json({ error: "agentOverrideTreatment must be a non-empty string" });
        }
        const pack = await storage.getPolicyPack(companyId);
        const allowedNames = pack ? (await storage.getTreatmentsWithRules(pack.id)).map((t) => t.name) : [];
        allowedNames.push("Agent Review");
        if (!allowedNames.includes(agentOverrideTreatment)) {
          return res.status(400).json({ error: "Invalid agentOverrideTreatment value" });
        }
      }
      const decision = await storage.updateDecisionReview(id, agentAgreed, agentReason, agentOverrideTreatment);
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
