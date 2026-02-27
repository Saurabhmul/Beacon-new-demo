import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import multer from "multer";
import Papa from "papaparse";
import { analyzeCustomer, extractTextFromImage } from "./ai-engine";
import { batchProcessWithSSE } from "./replit_integrations/batch";
import { users, uploadLogs } from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  function getUserId(req: any): string {
    return req.user?.id;
  }

  // Client Config
  app.get("/api/client-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
      if (!config) return res.status(404).json({ error: "Not configured" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch config" });
    }
  });

  app.post("/api/client-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.createClientConfig({ ...req.body, userId });
      res.status(201).json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to create config" });
    }
  });

  app.patch("/api/client-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.updateClientConfig(userId, req.body);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to update config" });
    }
  });

  // Rulebooks
  app.get("/api/rulebooks", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const rbs = await storage.getRulebooks(userId);
      res.json(rbs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch rulebooks" });
    }
  });

  app.post("/api/rulebooks", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const rb = await storage.createRulebook({
        ...req.body,
        userId,
        clientConfigId: config.id,
      });
      res.status(201).json(rb);
    } catch (error) {
      res.status(500).json({ error: "Failed to create rulebook" });
    }
  });

  app.post("/api/rulebooks/upload", isAuthenticated, upload.single("file"), async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
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

  app.delete("/api/rulebooks/:id", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const rb = await storage.getRulebook(parseInt(req.params.id));
      if (!rb || rb.userId !== userId) return res.status(404).json({ error: "Rulebook not found" });
      await storage.deleteRulebook(rb.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete rulebook" });
    }
  });

  // Data Config
  app.get("/api/data-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getDataConfig(userId);
      if (!config) return res.status(404).json({ error: "Not configured" });
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch data config" });
    }
  });

  app.post("/api/data-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const clientConfig = await storage.getClientConfig(userId);
      if (!clientConfig) return res.status(400).json({ error: "Configure client first" });

      const config = await storage.createDataConfig({
        ...req.body,
        userId,
        clientConfigId: clientConfig.id,
      });
      res.status(201).json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to create data config" });
    }
  });

  app.patch("/api/data-config", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.updateDataConfig(userId, req.body);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to update data config" });
    }
  });

  // DPD Stages
  app.get("/api/dpd-stages", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const stages = await storage.getDpdStages(userId);
      res.json(stages);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch DPD stages" });
    }
  });

  app.post("/api/dpd-stages", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const { name, description, fromDays, toDays, color } = req.body;
      if (fromDays >= toDays) return res.status(400).json({ error: "From days must be less than To days" });

      const existing = await storage.getDpdStages(userId);
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
        clientConfigId: config.id,
      });
      res.status(201).json(stage);
    } catch (error) {
      res.status(500).json({ error: "Failed to create DPD stage" });
    }
  });

  app.patch("/api/dpd-stages/:id", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const id = parseInt(req.params.id);
      const { name, description, fromDays, toDays, color } = req.body;

      const existing = await storage.getDpdStages(userId);
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

  app.delete("/api/dpd-stages/:id", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const id = parseInt(req.params.id);
      const stages = await storage.getDpdStages(userId);
      const stage = stages.find(s => s.id === id);
      if (!stage) return res.status(404).json({ error: "DPD stage not found" });
      await storage.deleteDpdStage(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete DPD stage" });
    }
  });

  // Uploads
  app.get("/api/uploads", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const category = req.query.category as string | undefined;
      const uploads = await storage.getUploads(userId);
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
    "customer / account / loan id", "date_of_payment", "amount_paid", "payment_status",
  ];

  const CONVERSATION_HISTORY_FIELDS = [
    "customer / account / loan id", "date", "channel", "direction", "message_content",
  ];

  app.get("/api/uploads/sample/:category", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const category = req.params.category;
      const dataConfig = await storage.getDataConfig(userId);

      let fields: string[] = [];
      let filename = "sample.csv";

      if (category === "loan_data") {
        fields = [...MANDATORY_LOAN_FIELDS];
        if (dataConfig?.optionalFields) {
          const optional = dataConfig.optionalFields as string[];
          fields.push(...optional.filter(f => f !== "conversation_history"));
        }
        filename = "sample_loan_data.csv";
      } else if (category === "payment_history") {
        fields = [...MANDATORY_PAYMENT_FIELDS];
        if (dataConfig?.paymentAdditionalFields) {
          fields.push(...(dataConfig.paymentAdditionalFields as string[]));
        }
        filename = "sample_payment_history.csv";
      } else if (category === "conversation_history") {
        fields = [...CONVERSATION_HISTORY_FIELDS];
        filename = "sample_conversation_history.csv";
      } else {
        return res.status(400).json({ error: "Invalid category" });
      }

      const SAMPLE_VALUES: Record<string, string> = {
        "customer / account / loan id": "CUST001",
        "dpd_bucket": "30 or Easy",
        "amount_due": "5000",
        "minimum_due": "1500",
        "due_date": "2026-01-15",
        "date_of_payment": "2026-01-10",
        "amount_paid": "5000",
        "payment_status": "paid",
        "date": "2026-01-12",
        "channel": "phone",
        "direction": "inbound",
        "message_content": "Customer called regarding payment",
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

  app.get("/api/upload-logs", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const category = req.query.category as string;
      if (!category) return res.status(400).json({ error: "Category is required" });

      const logs = await storage.getUploadLogs(userId, category);

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

  app.get("/api/upload-logs/:id/download", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const logId = Number(req.params.id);
      const log = await storage.getUploadLog(logId);
      if (!log || log.userId !== userId) return res.status(404).json({ error: "Upload log not found" });

      const rows = log.rowResults || [];
      if (rows.length === 0) return res.status(400).json({ error: "No row data available" });

      const allDataKeys = Object.keys(rows[0]).filter(k => k !== "_status" && k !== "_message");

      let orderedFields: string[] = [];
      if (log.uploadCategory === "loan_data") {
        orderedFields = [...MANDATORY_LOAN_FIELDS];
        const dataConfig = await storage.getDataConfig(userId);
        if (dataConfig?.optionalFields) {
          orderedFields.push(...(dataConfig.optionalFields as string[]).filter(f => f !== "conversation_history"));
        }
      } else if (log.uploadCategory === "payment_history") {
        orderedFields = [...MANDATORY_PAYMENT_FIELDS];
        const dataConfig = await storage.getDataConfig(userId);
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

  app.post("/api/uploads", isAuthenticated, upload.single("file"), async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
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

      const existingUpload = await storage.getUploadByCategory(userId, category);
      const rowResults: Array<Record<string, unknown> & { _status: string; _message: string }> = [];
      let processedCount = 0;
      let failedCount = 0;

      if (existingUpload && existingUpload.uploadedData) {
        const existingRecords = existingUpload.uploadedData as Record<string, unknown>[];
        const idCol = newRecords.length > 0 ? findIdColumn(newRecords[0]) : undefined;

        let mergedRecords: Record<string, unknown>[];

        if (idCol) {
          const existingIds = new Set<string>();
          const recordMap = new Map<string, Record<string, unknown>>();
          for (const r of existingRecords) {
            const id = String(r[idCol] || "");
            if (id) {
              recordMap.set(id, r);
              existingIds.add(id);
            }
          }
          for (const r of newRecords) {
            const id = String(r[idCol] || "");
            if (!id) {
              rowResults.push({ ...r, _status: "failed", _message: "Missing ID value" });
              failedCount++;
              continue;
            }
            const isUpdate = existingIds.has(id);
            recordMap.set(id, r);
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
          clientConfigId: config.id,
        });

        await storage.createUploadLog({
          dataUploadId: uploadRecord.id,
          userId,
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

  // Process upload with AI
  app.post("/api/uploads/:id/process", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const uploadId = parseInt(req.params.id);
      const uploadRecord = await storage.getUpload(uploadId);

      if (!uploadRecord || uploadRecord.userId !== userId) return res.status(404).json({ error: "Upload not found" });
      if (uploadRecord.status === "processed") return res.status(400).json({ error: "Already processed" });

      const rbs = await storage.getRulebooks(userId);
      if (!rbs.length) return res.status(400).json({ error: "No rulebook configured" });

      const dataConfig = await storage.getDataConfig(userId);
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
  app.get("/api/decisions/stats", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const stats = await storage.getDecisionStats(userId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/decisions/:status", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const status = req.params.status;
      if (!isNaN(parseInt(status))) {
        const decision = await storage.getDecision(parseInt(status));
        if (!decision || decision.userId !== userId) return res.status(404).json({ error: "Decision not found" });
        return res.json(decision);
      }
      const decisions = await storage.getDecisions(userId, status);
      res.json(decisions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch decisions" });
    }
  });

  app.patch("/api/decisions/:id/review", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const id = parseInt(req.params.id);
      const existing = await storage.getDecision(id);
      if (!existing || existing.userId !== userId) return res.status(404).json({ error: "Decision not found" });
      const { agentAgreed, agentReason } = req.body;
      const decision = await storage.updateDecisionReview(id, agentAgreed, agentReason);
      res.json(decision);
    } catch (error) {
      res.status(500).json({ error: "Failed to update review" });
    }
  });

  app.patch("/api/decisions/:id/email-review", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const id = parseInt(req.params.id);
      const existing = await storage.getDecision(id);
      if (!existing || existing.userId !== userId) return res.status(404).json({ error: "Decision not found" });
      const { emailAccepted, emailRejectReason } = req.body;
      const decision = await storage.updateDecisionEmailReview(id, emailAccepted, emailRejectReason);
      res.json(decision);
    } catch (error) {
      res.status(500).json({ error: "Failed to update email review" });
    }
  });

  return httpServer;
}
