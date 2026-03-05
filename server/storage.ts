import {
  clientConfigs, rulebooks, dataConfigs, dataUploads, decisions, dpdStages, uploadLogs, policyConfigs,
  type ClientConfig, type InsertClientConfig,
  type Rulebook, type InsertRulebook,
  type DataConfig, type InsertDataConfig,
  type DpdStage, type InsertDpdStage,
  type DataUpload, type InsertDataUpload,
  type Decision, type InsertDecision,
  type UploadLog, type InsertUploadLog,
  type PolicyConfig, type InsertPolicyConfig,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, inArray } from "drizzle-orm";

export interface IStorage {
  getClientConfig(userId: string): Promise<ClientConfig | undefined>;
  createClientConfig(data: InsertClientConfig): Promise<ClientConfig>;
  updateClientConfig(userId: string, data: Partial<InsertClientConfig>): Promise<ClientConfig>;

  getRulebooks(userId: string): Promise<Rulebook[]>;
  getRulebook(id: number): Promise<Rulebook | undefined>;
  createRulebook(data: InsertRulebook): Promise<Rulebook>;
  deleteRulebook(id: number): Promise<void>;

  getDataConfig(userId: string): Promise<DataConfig | undefined>;
  createDataConfig(data: InsertDataConfig): Promise<DataConfig>;
  updateDataConfig(userId: string, data: Partial<InsertDataConfig>): Promise<DataConfig>;

  getDpdStages(userId: string): Promise<DpdStage[]>;
  createDpdStage(data: InsertDpdStage): Promise<DpdStage>;
  updateDpdStage(id: number, data: Partial<InsertDpdStage>): Promise<DpdStage>;
  deleteDpdStage(id: number): Promise<void>;

  getUploads(userId: string): Promise<DataUpload[]>;
  getUploadByCategory(userId: string, category: string): Promise<DataUpload | undefined>;
  getUpload(id: number): Promise<DataUpload | undefined>;
  createUpload(data: InsertDataUpload): Promise<DataUpload>;
  updateUploadData(id: number, data: { uploadedData: Record<string, unknown>[]; recordCount: number; fileName: string; fileSize: number }): Promise<DataUpload>;
  updateUploadStatus(id: number, status: string): Promise<void>;

  getDecisions(userId: string, status?: string): Promise<Decision[]>;
  getDecision(id: number): Promise<Decision | undefined>;
  createDecision(data: InsertDecision): Promise<Decision>;
  updateDecisionReview(id: number, agentAgreed: boolean, agentReason?: string): Promise<Decision>;
  updateDecisionEmailReview(id: number, emailAccepted: boolean, emailRejectReason?: string): Promise<Decision>;
  deletePendingDecisions(userId: string): Promise<void>;
  deleteDecisionsByIds(ids: number[], userId: string): Promise<void>;
  getDecisionStats(userId: string): Promise<{ pending: number; approved: number; total: number; recentDecisions: Decision[] }>;

  createUploadLog(data: InsertUploadLog): Promise<UploadLog>;
  getUploadLogs(userId: string, category: string): Promise<UploadLog[]>;
  getUploadLog(id: number): Promise<UploadLog | undefined>;

  getPolicyConfig(userId: string): Promise<PolicyConfig | undefined>;
  createPolicyConfig(data: InsertPolicyConfig): Promise<PolicyConfig>;
  updatePolicyConfig(userId: string, data: Partial<InsertPolicyConfig>): Promise<PolicyConfig>;
}

export class DatabaseStorage implements IStorage {
  async getClientConfig(userId: string): Promise<ClientConfig | undefined> {
    const [config] = await db.select().from(clientConfigs).where(eq(clientConfigs.userId, userId));
    return config || undefined;
  }

  async createClientConfig(data: InsertClientConfig): Promise<ClientConfig> {
    const [config] = await db.insert(clientConfigs).values(data).returning();
    return config;
  }

  async updateClientConfig(userId: string, data: Partial<InsertClientConfig>): Promise<ClientConfig> {
    const [config] = await db
      .update(clientConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clientConfigs.userId, userId))
      .returning();
    return config;
  }

  async getRulebooks(userId: string): Promise<Rulebook[]> {
    return db.select().from(rulebooks).where(eq(rulebooks.userId, userId)).orderBy(desc(rulebooks.createdAt));
  }

  async getRulebook(id: number): Promise<Rulebook | undefined> {
    const [rb] = await db.select().from(rulebooks).where(eq(rulebooks.id, id));
    return rb || undefined;
  }

  async createRulebook(data: InsertRulebook): Promise<Rulebook> {
    const [rb] = await db.insert(rulebooks).values(data).returning();
    return rb;
  }

  async deleteRulebook(id: number): Promise<void> {
    await db.delete(rulebooks).where(eq(rulebooks.id, id));
  }

  async getDataConfig(userId: string): Promise<DataConfig | undefined> {
    const [config] = await db.select().from(dataConfigs).where(eq(dataConfigs.userId, userId));
    return config || undefined;
  }

  async createDataConfig(data: InsertDataConfig): Promise<DataConfig> {
    const [config] = await db.insert(dataConfigs).values(data).returning();
    return config;
  }

  async updateDataConfig(userId: string, data: Partial<InsertDataConfig>): Promise<DataConfig> {
    const [config] = await db
      .update(dataConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dataConfigs.userId, userId))
      .returning();
    return config;
  }

  async getDpdStages(userId: string): Promise<DpdStage[]> {
    return db.select().from(dpdStages).where(eq(dpdStages.userId, userId)).orderBy(dpdStages.fromDays);
  }

  async createDpdStage(data: InsertDpdStage): Promise<DpdStage> {
    const [stage] = await db.insert(dpdStages).values(data).returning();
    return stage;
  }

  async updateDpdStage(id: number, data: Partial<InsertDpdStage>): Promise<DpdStage> {
    const [stage] = await db.update(dpdStages).set(data).where(eq(dpdStages.id, id)).returning();
    return stage;
  }

  async deleteDpdStage(id: number): Promise<void> {
    await db.delete(dpdStages).where(eq(dpdStages.id, id));
  }

  async getUploads(userId: string): Promise<DataUpload[]> {
    return db.select().from(dataUploads).where(eq(dataUploads.userId, userId)).orderBy(desc(dataUploads.createdAt));
  }

  async getUploadByCategory(userId: string, category: string): Promise<DataUpload | undefined> {
    const [upload] = await db.select().from(dataUploads)
      .where(and(
        eq(dataUploads.userId, userId),
        eq(dataUploads.uploadCategory, category),
        eq(dataUploads.status, "uploaded")
      ))
      .orderBy(desc(dataUploads.createdAt))
      .limit(1);
    return upload || undefined;
  }

  async getUpload(id: number): Promise<DataUpload | undefined> {
    const [upload] = await db.select().from(dataUploads).where(eq(dataUploads.id, id));
    return upload || undefined;
  }

  async createUpload(data: InsertDataUpload): Promise<DataUpload> {
    const [upload] = await db.insert(dataUploads).values(data).returning();
    return upload;
  }

  async updateUploadData(id: number, data: { uploadedData: Record<string, unknown>[]; recordCount: number; fileName: string; fileSize: number }): Promise<DataUpload> {
    const [upload] = await db.update(dataUploads)
      .set({
        uploadedData: data.uploadedData,
        recordCount: data.recordCount,
        fileName: data.fileName,
        fileSize: data.fileSize,
      })
      .where(eq(dataUploads.id, id))
      .returning();
    return upload;
  }

  async updateUploadStatus(id: number, status: string): Promise<void> {
    await db.update(dataUploads).set({ status }).where(eq(dataUploads.id, id));
  }

  async getDecisions(userId: string, status?: string): Promise<Decision[]> {
    if (status && status !== "all") {
      return db.select().from(decisions)
        .where(and(eq(decisions.userId, userId), eq(decisions.status, status)))
        .orderBy(desc(decisions.createdAt));
    }
    return db.select().from(decisions).where(eq(decisions.userId, userId)).orderBy(desc(decisions.createdAt));
  }

  async getDecision(id: number): Promise<Decision | undefined> {
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, id));
    return decision || undefined;
  }

  async createDecision(data: InsertDecision): Promise<Decision> {
    const [decision] = await db.insert(decisions).values(data).returning();
    return decision;
  }

  async updateDecisionReview(id: number, agentAgreed: boolean, agentReason?: string): Promise<Decision> {
    const [decision] = await db
      .update(decisions)
      .set({
        status: agentAgreed ? "approved" : "rejected",
        agentAgreed,
        agentReason: agentReason || null,
        reviewedAt: new Date(),
      })
      .where(eq(decisions.id, id))
      .returning();
    return decision;
  }

  async updateDecisionEmailReview(id: number, emailAccepted: boolean, emailRejectReason?: string): Promise<Decision> {
    const [decision] = await db
      .update(decisions)
      .set({
        emailAccepted,
        emailRejectReason: emailRejectReason || null,
      })
      .where(eq(decisions.id, id))
      .returning();
    return decision;
  }

  async deletePendingDecisions(userId: string): Promise<void> {
    await db.delete(decisions).where(and(eq(decisions.userId, userId), eq(decisions.status, "pending")));
  }

  async deleteDecisionsByIds(ids: number[], userId: string): Promise<void> {
    if (ids.length === 0) return;
    await db.delete(decisions).where(and(inArray(decisions.id, ids), eq(decisions.userId, userId)));
  }

  async getDecisionStats(userId: string) {
    const allDecisions = await db.select().from(decisions).where(eq(decisions.userId, userId)).orderBy(desc(decisions.createdAt));
    const pending = allDecisions.filter(d => d.status === "pending").length;
    const approved = allDecisions.filter(d => d.status !== "pending").length;
    return {
      pending,
      approved,
      total: allDecisions.length,
      recentDecisions: allDecisions.slice(0, 5),
    };
  }

  async createUploadLog(data: InsertUploadLog): Promise<UploadLog> {
    const [log] = await db.insert(uploadLogs).values(data).returning();
    return log;
  }

  async getUploadLogs(userId: string, category: string): Promise<UploadLog[]> {
    return db.select().from(uploadLogs)
      .where(and(eq(uploadLogs.userId, userId), eq(uploadLogs.uploadCategory, category)))
      .orderBy(desc(uploadLogs.createdAt));
  }

  async getUploadLog(id: number): Promise<UploadLog | undefined> {
    const [log] = await db.select().from(uploadLogs).where(eq(uploadLogs.id, id));
    return log || undefined;
  }

  async getPolicyConfig(userId: string): Promise<PolicyConfig | undefined> {
    const [config] = await db.select().from(policyConfigs).where(eq(policyConfigs.userId, userId));
    return config || undefined;
  }

  async createPolicyConfig(data: InsertPolicyConfig): Promise<PolicyConfig> {
    const [config] = await db.insert(policyConfigs).values(data).returning();
    return config;
  }

  async updatePolicyConfig(userId: string, data: Partial<InsertPolicyConfig>): Promise<PolicyConfig> {
    const [config] = await db
      .update(policyConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(policyConfigs.userId, userId))
      .returning();
    return config;
  }
}

export const storage = new DatabaseStorage();
