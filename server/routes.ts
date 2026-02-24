import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import multer from "multer";
import Papa from "papaparse";
import { analyzeCustomer, extractTextFromImage } from "./ai-engine";
import { batchProcessWithSSE } from "./replit_integrations/batch";
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

  // Uploads
  app.get("/api/uploads", isAuthenticated, async (req, res) => {
    try {
      const userId = getUserId(req);
      const uploads = await storage.getUploads(userId);
      res.json(uploads);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  app.post("/api/uploads", isAuthenticated, upload.single("file"), async (req, res) => {
    try {
      const userId = getUserId(req);
      const config = await storage.getClientConfig(userId);
      if (!config) return res.status(400).json({ error: "Configure client first" });

      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      let records: Record<string, unknown>[] = [];
      const content = file.buffer.toString("utf-8");

      if (file.originalname.endsWith(".csv")) {
        const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
        records = parsed.data as Record<string, unknown>[];
      } else if (file.originalname.endsWith(".json")) {
        const json = JSON.parse(content);
        records = Array.isArray(json) ? json : [json];
      } else {
        return res.status(400).json({ error: "Unsupported file type. Use CSV or JSON." });
      }

      const uploadRecord = await storage.createUpload({
        fileName: file.originalname,
        fileType: file.originalname.endsWith(".csv") ? "CSV" : "JSON",
        fileSize: file.size,
        recordCount: records.length,
        status: "uploaded",
        uploadedData: records,
        userId,
        clientConfigId: config.id,
      });

      res.status(201).json(uploadRecord);
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
