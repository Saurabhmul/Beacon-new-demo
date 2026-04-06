import {
  clientConfigs, rulebooks, dataConfigs, dataUploads, decisions, dpdStages, uploadLogs, policyConfigs,
  policyPacks, treatments, treatmentRuleGroups, treatmentRules, policyFields,
  companies, users,
  type ClientConfig, type InsertClientConfig,
  type Rulebook, type InsertRulebook,
  type DataConfig, type InsertDataConfig,
  type DpdStage, type InsertDpdStage,
  type DataUpload, type InsertDataUpload,
  type Decision, type InsertDecision,
  type UploadLog, type InsertUploadLog,
  type PolicyConfig, type InsertPolicyConfig,
  type PolicyPack, type InsertPolicyPack,
  type Treatment, type InsertTreatment,
  type TreatmentRuleGroup, type InsertTreatmentRuleGroup,
  type TreatmentRule, type InsertTreatmentRule,
  type TreatmentWithRules,
  type PolicyFieldRecord, type InsertPolicyField,
  type Company, type InsertCompany,
  type User,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, inArray, isNull, or } from "drizzle-orm";

export interface IStorage {
  getClientConfig(companyId: string): Promise<ClientConfig | undefined>;
  createClientConfig(data: InsertClientConfig): Promise<ClientConfig>;
  updateClientConfig(companyId: string, data: Partial<InsertClientConfig>): Promise<ClientConfig>;

  getRulebooks(companyId: string): Promise<Rulebook[]>;
  getRulebook(id: number): Promise<Rulebook | undefined>;
  createRulebook(data: InsertRulebook): Promise<Rulebook>;
  deleteRulebook(id: number): Promise<void>;

  getDataConfig(companyId: string): Promise<DataConfig | undefined>;
  createDataConfig(data: InsertDataConfig): Promise<DataConfig>;
  updateDataConfig(companyId: string, data: Partial<InsertDataConfig>): Promise<DataConfig>;

  getDpdStages(companyId: string): Promise<DpdStage[]>;
  createDpdStage(data: InsertDpdStage): Promise<DpdStage>;
  updateDpdStage(id: number, data: Partial<InsertDpdStage>): Promise<DpdStage>;
  deleteDpdStage(id: number): Promise<void>;

  getUploads(companyId: string): Promise<DataUpload[]>;
  getUploadByCategory(companyId: string, category: string): Promise<DataUpload | undefined>;
  getUpload(id: number): Promise<DataUpload | undefined>;
  createUpload(data: InsertDataUpload): Promise<DataUpload>;
  updateUploadData(id: number, data: { uploadedData: Record<string, unknown>[]; recordCount: number; fileName: string; fileSize: number }): Promise<DataUpload>;
  updateUploadStatus(id: number, status: string): Promise<void>;

  getDecisions(companyId: string, status?: string): Promise<Decision[]>;
  getDecision(id: number): Promise<Decision | undefined>;
  createDecision(data: InsertDecision): Promise<Decision>;
  updateDecisionReview(id: number, agentAgreed: boolean, agentReason?: string): Promise<Decision>;
  updateDecisionEmailReview(id: number, emailAccepted: boolean, emailRejectReason?: string): Promise<Decision>;
  deletePendingDecisions(companyId: string): Promise<void>;
  deleteDecisionsByIds(ids: number[], companyId: string): Promise<void>;
  getDecisionStats(companyId: string): Promise<{ pending: number; approved: number; total: number; recentDecisions: Decision[] }>;

  createUploadLog(data: InsertUploadLog): Promise<UploadLog>;
  getUploadLogs(companyId: string, category: string): Promise<UploadLog[]>;
  getUploadLog(id: number): Promise<UploadLog | undefined>;

  getPolicyConfig(companyId: string): Promise<PolicyConfig | undefined>;
  createPolicyConfig(data: InsertPolicyConfig): Promise<PolicyConfig>;
  updatePolicyConfig(companyId: string, data: Partial<InsertPolicyConfig>): Promise<PolicyConfig>;

  getPolicyPack(clientConfigId: number): Promise<PolicyPack | undefined>;
  upsertPolicyPack(data: InsertPolicyPack & { id?: number }): Promise<PolicyPack>;
  getTreatmentsWithRules(policyPackId: number): Promise<TreatmentWithRules[]>;
  createTreatment(data: InsertTreatment): Promise<Treatment>;
  updateTreatment(id: number, data: Partial<InsertTreatment>): Promise<Treatment>;
  deleteTreatment(id: number): Promise<void>;
  upsertRuleGroup(data: InsertTreatmentRuleGroup & { id?: number }): Promise<TreatmentRuleGroup>;
  replaceRuleRows(groupId: number, rows: Omit<InsertTreatmentRule, 'ruleGroupId'>[]): Promise<void>;

  getPolicyFields(companyId: string): Promise<PolicyFieldRecord[]>;
  createPolicyField(data: InsertPolicyField): Promise<PolicyFieldRecord>;

  getCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | undefined>;
  createCompany(data: InsertCompany): Promise<Company>;

  getUsers(companyId?: string | null): Promise<User[]>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByInviteToken(token: string): Promise<User | undefined>;
  createUser(data: Partial<User>): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User>;
}

export class DatabaseStorage implements IStorage {
  async getClientConfig(companyId: string): Promise<ClientConfig | undefined> {
    const [config] = await db.select().from(clientConfigs).where(eq(clientConfigs.companyId, companyId));
    return config || undefined;
  }

  async createClientConfig(data: InsertClientConfig): Promise<ClientConfig> {
    const [config] = await db.insert(clientConfigs).values(data).returning();
    return config;
  }

  async updateClientConfig(companyId: string, data: Partial<InsertClientConfig>): Promise<ClientConfig> {
    const [config] = await db
      .update(clientConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clientConfigs.companyId, companyId))
      .returning();
    return config;
  }

  async getRulebooks(companyId: string): Promise<Rulebook[]> {
    return db.select().from(rulebooks).where(eq(rulebooks.companyId, companyId)).orderBy(desc(rulebooks.createdAt));
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

  async getDataConfig(companyId: string): Promise<DataConfig | undefined> {
    const [config] = await db.select().from(dataConfigs).where(eq(dataConfigs.companyId, companyId));
    return config || undefined;
  }

  async createDataConfig(data: InsertDataConfig): Promise<DataConfig> {
    const [config] = await db.insert(dataConfigs).values(data).returning();
    return config;
  }

  async updateDataConfig(companyId: string, data: Partial<InsertDataConfig>): Promise<DataConfig> {
    const [config] = await db
      .update(dataConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dataConfigs.companyId, companyId))
      .returning();
    return config;
  }

  async getDpdStages(companyId: string): Promise<DpdStage[]> {
    return db.select().from(dpdStages).where(eq(dpdStages.companyId, companyId)).orderBy(dpdStages.fromDays);
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

  async getUploads(companyId: string): Promise<DataUpload[]> {
    return db.select().from(dataUploads).where(eq(dataUploads.companyId, companyId)).orderBy(desc(dataUploads.createdAt));
  }

  async getUploadByCategory(companyId: string, category: string): Promise<DataUpload | undefined> {
    const [upload] = await db.select().from(dataUploads)
      .where(and(
        eq(dataUploads.companyId, companyId),
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

  async getDecisions(companyId: string, status?: string): Promise<Decision[]> {
    if (status && status !== "all") {
      return db.select().from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, status)))
        .orderBy(desc(decisions.createdAt));
    }
    return db.select().from(decisions).where(eq(decisions.companyId, companyId)).orderBy(desc(decisions.createdAt));
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

  async deletePendingDecisions(companyId: string): Promise<void> {
    await db.delete(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "pending")));
  }

  async deleteDecisionsByIds(ids: number[], companyId: string): Promise<void> {
    if (ids.length === 0) return;
    await db.delete(decisions).where(and(inArray(decisions.id, ids), eq(decisions.companyId, companyId)));
  }

  async getDecisionStats(companyId: string) {
    const allDecisions = await db.select().from(decisions).where(eq(decisions.companyId, companyId)).orderBy(desc(decisions.createdAt));
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

  async getUploadLogs(companyId: string, category: string): Promise<UploadLog[]> {
    return db.select().from(uploadLogs)
      .where(and(eq(uploadLogs.companyId, companyId), eq(uploadLogs.uploadCategory, category)))
      .orderBy(desc(uploadLogs.createdAt));
  }

  async getUploadLog(id: number): Promise<UploadLog | undefined> {
    const [log] = await db.select().from(uploadLogs).where(eq(uploadLogs.id, id));
    return log || undefined;
  }

  async getPolicyConfig(companyId: string): Promise<PolicyConfig | undefined> {
    const [config] = await db.select().from(policyConfigs).where(eq(policyConfigs.companyId, companyId));
    return config || undefined;
  }

  async createPolicyConfig(data: InsertPolicyConfig): Promise<PolicyConfig> {
    const [config] = await db.insert(policyConfigs).values(data).returning();
    return config;
  }

  async updatePolicyConfig(companyId: string, data: Partial<InsertPolicyConfig>): Promise<PolicyConfig> {
    const [config] = await db
      .update(policyConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(policyConfigs.companyId, companyId))
      .returning();
    return config;
  }

  async getPolicyPack(clientConfigId: number): Promise<PolicyPack | undefined> {
    const [pack] = await db.select().from(policyPacks).where(eq(policyPacks.clientConfigId, clientConfigId)).orderBy(desc(policyPacks.createdAt)).limit(1);
    return pack || undefined;
  }

  async upsertPolicyPack(data: InsertPolicyPack & { id?: number }): Promise<PolicyPack> {
    if (data.id) {
      const { id, ...rest } = data;
      const [pack] = await db.update(policyPacks).set({ ...rest, updatedAt: new Date() }).where(eq(policyPacks.id, id)).returning();
      return pack;
    }
    const [pack] = await db.insert(policyPacks).values(data).returning();
    return pack;
  }

  async getTreatmentsWithRules(policyPackId: number): Promise<TreatmentWithRules[]> {
    const txs = await db.select().from(treatments).where(eq(treatments.policyPackId, policyPackId)).orderBy(treatments.displayOrder);
    const groups = txs.length > 0
      ? await db.select().from(treatmentRuleGroups).where(inArray(treatmentRuleGroups.treatmentId, txs.map(t => t.id))).orderBy(treatmentRuleGroups.groupOrder)
      : [];
    const rules = groups.length > 0
      ? await db.select().from(treatmentRules).where(inArray(treatmentRules.ruleGroupId, groups.map(g => g.id))).orderBy(treatmentRules.sortOrder)
      : [];
    return txs.map(tx => ({
      ...tx,
      ruleGroups: groups.filter(g => g.treatmentId === tx.id).map(g => ({
        ...g,
        rules: rules.filter(r => r.ruleGroupId === g.id),
      })),
    }));
  }

  async createTreatment(data: InsertTreatment): Promise<Treatment> {
    const [tx] = await db.insert(treatments).values(data).returning();
    return tx;
  }

  async updateTreatment(id: number, data: Partial<InsertTreatment>): Promise<Treatment> {
    const [tx] = await db.update(treatments).set(data).where(eq(treatments.id, id)).returning();
    return tx;
  }

  async deleteTreatment(id: number): Promise<void> {
    await db.delete(treatments).where(eq(treatments.id, id));
  }

  async upsertRuleGroup(data: InsertTreatmentRuleGroup & { id?: number }): Promise<TreatmentRuleGroup> {
    if (data.id) {
      const { id, ...rest } = data;
      const [g] = await db.update(treatmentRuleGroups).set(rest).where(eq(treatmentRuleGroups.id, id)).returning();
      return g;
    }
    const [g] = await db.insert(treatmentRuleGroups).values(data).returning();
    return g;
  }

  async replaceRuleRows(groupId: number, rows: Omit<InsertTreatmentRule, 'ruleGroupId'>[]): Promise<void> {
    await db.delete(treatmentRules).where(eq(treatmentRules.ruleGroupId, groupId));
    if (rows.length > 0) {
      await db.insert(treatmentRules).values(rows.map((r, i) => ({ ...r, ruleGroupId: groupId, sortOrder: i })));
    }
  }

  async getPolicyFields(companyId: string): Promise<PolicyFieldRecord[]> {
    return db.select().from(policyFields)
      .where(eq(policyFields.companyId, companyId))
      .orderBy(policyFields.label);
  }

  async createPolicyField(data: InsertPolicyField): Promise<PolicyFieldRecord> {
    const [field] = await db.insert(policyFields).values(data).returning();
    return field;
  }

  async getCompanies(): Promise<Company[]> {
    return db.select().from(companies).orderBy(companies.name);
  }

  async getCompany(id: string): Promise<Company | undefined> {
    const [company] = await db.select().from(companies).where(eq(companies.id, id));
    return company || undefined;
  }

  async createCompany(data: InsertCompany): Promise<Company> {
    const [company] = await db.insert(companies).values(data).returning();
    return company;
  }

  async getUsers(companyId?: string | null): Promise<User[]> {
    if (companyId) {
      return db.select().from(users).where(eq(users.companyId, companyId)).orderBy(desc(users.createdAt));
    }
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async getUserByInviteToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.inviteToken, token));
    return user || undefined;
  }

  async createUser(data: Partial<User>): Promise<User> {
    const [user] = await db.insert(users).values(data as any).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<User>): Promise<User> {
    const [user] = await db.update(users).set({ ...data, updatedAt: new Date() } as any).where(eq(users.id, id)).returning();
    return user;
  }
}

export const storage = new DatabaseStorage();
