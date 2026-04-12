import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, boolean, jsonb, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export * from "./models/auth";
export * from "./models/chat";

export const clientConfigs = pgTable("client_configs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  companyName: text("company_name").notNull(),
  contactEmail: text("contact_email").notNull(),
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const rulebooks = pgTable("rulebooks", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  title: text("title").notNull(),
  sopText: text("sop_text"),
  sopFileUrl: text("sop_file_url"),
  sopFileName: text("sop_file_name"),
  extractedText: text("extracted_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export interface FieldReview {
  fieldName: string;
  beaconsUnderstanding: string;
  confidence: 'High' | 'Medium' | 'Low';
  ignored: boolean;
  sampleValues?: string[];
  dataType?: string | null;
  allowedValues?: string[] | null;
  defaultValue?: string | null;
}

export interface CategoryEntry {
  fileName?: string;
  fileSize?: number;
  docType?: 'tabular' | 'document';
  uploadedAt?: string;
  fieldAnalysis?: FieldReview[];
}

export const dataConfigs = pgTable("data_configs", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  mandatoryFields: jsonb("mandatory_fields").$type<string[]>().default([]).notNull(),
  optionalFields: jsonb("optional_fields").$type<string[]>().default([]).notNull(),
  paymentAdditionalFields: jsonb("payment_additional_fields").$type<string[]>().default([]).notNull(),
  dpdBuckets: jsonb("dpd_buckets").$type<string[]>().default([]).notNull(),
  promptTemplate: text("prompt_template"),
  outputFormat: text("output_format"),
  selectedCategories: jsonb("selected_categories").$type<string[]>().default([]).notNull(),
  categoryData: jsonb("category_data").$type<Record<string, CategoryEntry>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const dpdStages = pgTable("dpd_stages", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  fromDays: integer("from_days").notNull(),
  toDays: integer("to_days").notNull(),
  color: text("color").default("blue").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export interface TreatmentOption {
  name: string;
  enabled: boolean;
  definition: string;
  isCustom?: boolean;
  blockedStages?: string[];
  clearanceMonths?: number;
}

export interface DecisionRule {
  id: number;
  treatmentName: string;
  affordability: string[];
  willingness: string[];
  otherCondition: string;
  priority: number;
  paymentTarget?: string;
  paymentTargetAmount?: number;
  communicationTone?: string;
}

export interface AffordabilityRule {
  id: number;
  label: string;
  operator: string;
  percentage: number | null;
  condition: string;
  isDefault?: boolean;
}

export interface EscalationCustomCondition {
  field: string;
  operator: string;
  value: string;
  leftFieldId?: string | null;
  rightMode?: "constant" | "field" | null;
  rightConstantValue?: string | null;
  rightFieldId?: string | null;
}

export interface VulnerabilityRuleRow {
  leftFieldId: string | null;
  operator: string;
  rightMode: "constant" | "field";
  rightConstantValue: string;
  rightFieldId: string | null;
}

export interface VulnerabilityRuleGroup {
  logicOperator: "AND" | "OR";
  rows: VulnerabilityRuleRow[];
}

export interface EscalationRules {
  vulnerabilityDetected: true;
  legalAction: boolean;
  debtDispute: boolean;
  balanceAbove: number | null;
  dpdAbove: number | null;
  managerRequest: boolean;
  brokenPtps: number | null;
  otherConditions: EscalationCustomCondition[];
  otherConditionsLogicOperator?: "AND" | "OR";
  vulnerabilityRules?: VulnerabilityRuleGroup;
}

export const policyConfigs = pgTable("policy_configs", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  vulnerabilityDefinition: text("vulnerability_definition"),
  affordabilityRules: jsonb("affordability_rules").$type<AffordabilityRule[]>().default([]).notNull(),
  availableTreatments: jsonb("available_treatments").$type<TreatmentOption[]>().default([]).notNull(),
  decisionRules: jsonb("decision_rules").$type<DecisionRule[]>().default([]).notNull(),
  escalationRules: jsonb("escalation_rules").$type<EscalationRules>(),
  compiledPolicy: jsonb("compiled_policy").$type<Record<string, string>>(),
  compiledAt: timestamp("compiled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const dataUploads = pgTable("data_uploads", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  recordCount: integer("record_count").default(0),
  status: text("status").default("uploaded").notNull(),
  uploadCategory: text("upload_category").default("loan_data").notNull(),
  uploadedData: jsonb("uploaded_data").$type<Record<string, unknown>[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const uploadLogs = pgTable("upload_logs", {
  id: serial("id").primaryKey(),
  dataUploadId: integer("data_upload_id"),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  recordCount: integer("record_count").default(0).notNull(),
  processedCount: integer("processed_count").default(0).notNull(),
  failedCount: integer("failed_count").default(0).notNull(),
  uploadCategory: text("upload_category").notNull(),
  rowResults: jsonb("row_results").$type<Array<Record<string, unknown> & { _status: string; _message: string }>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const decisions = pgTable("decisions", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  dataUploadId: integer("data_upload_id").notNull(),
  userId: varchar("user_id").notNull(),
  companyId: varchar("company_id").notNull(),
  customerGuid: text("customer_guid").notNull(),
  customerData: jsonb("customer_data").$type<Record<string, unknown>>().notNull(),
  combinedCmd: real("combined_cmd"),
  problemDescription: text("problem_description"),
  problemConfidenceScore: integer("problem_confidence_score"),
  problemEvidence: text("problem_evidence"),
  proposedSolution: text("proposed_solution"),
  solutionConfidenceScore: integer("solution_confidence_score"),
  solutionEvidence: text("solution_evidence"),
  internalAction: text("internal_action"),
  abilityToPay: real("ability_to_pay"),
  reasonForAbilityToPay: text("reason_for_ability_to_pay"),
  noOfLatestPaymentsFailed: integer("no_of_latest_payments_failed"),
  proposedEmailToCustomer: text("proposed_email_to_customer"),
  aiRawOutput: jsonb("ai_raw_output").$type<Record<string, unknown>>(),
  status: text("status").default("pending").notNull(),
  agentAgreed: boolean("agent_agreed"),
  agentReason: text("agent_reason"),
  emailAccepted: boolean("email_accepted"),
  emailRejectReason: text("email_reject_reason"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  recommendedTreatmentName: text("recommended_treatment_name"),
  recommendedTreatmentCode: text("recommended_treatment_code"),
  customerSituation: text("customer_situation"),
  treatmentEligibilityExplanation: text("treatment_eligibility_explanation"),
  structuredAssessments: jsonb("structured_assessments").$type<Array<{ name: string; value: string | null; reason: string }>>(),
  decisionTraceJson: jsonb("decision_trace_json").$type<Record<string, unknown>>(),
});

// Migration note (Task #22): company_id was added in two SQL phases:
// Phase 1: ADD COLUMN company_id varchar (nullable) → backfill from client_configs → validate
// Phase 2: ALTER COLUMN company_id SET NOT NULL + ADD CONSTRAINT UNIQUE (after validated backfill)
// client_config_id was also made nullable in Phase 1. Existing rows retain their value.
export interface SopSourceFile {
  originalName: string;
  safeName: string;
  uploadedAt: string;
}

export const policyPacks = pgTable("policy_packs", {
  id: serial("id").primaryKey(),
  clientConfigId: integer("client_config_id"),
  companyId: varchar("company_id").notNull().unique(),
  policyName: text("policy_name").notNull(),
  sourceType: text("source_type").notNull().default("ui"),
  sourceFileName: text("source_file_name"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastAiGenerationRawOutput: jsonb("last_ai_generation_raw_output"),
  lastAiGenerationAt: timestamp("last_ai_generation_at"),
  aiGenerationSummary: text("ai_generation_summary"),
  aiOpenQuestions: jsonb("ai_open_questions").$type<string[]>(),
  sopSourceFiles: jsonb("sop_source_files").$type<SopSourceFile[]>(),
});

export const treatments = pgTable("treatments", {
  id: serial("id").primaryKey(),
  policyPackId: integer("policy_pack_id").notNull(),
  name: text("name").notNull(),
  shortDescription: text("short_description"),
  enabled: boolean("enabled").notNull().default(true),
  priority: text("priority"),
  tone: text("tone"),
  displayOrder: integer("display_order").notNull().default(0),
  draftSourceFields: jsonb("draft_source_fields").$type<DraftSourceField[]>(),
  draftDerivedFields: jsonb("draft_derived_fields").$type<DraftDerivedField[]>(),
  draftBusinessFields: jsonb("draft_business_fields").$type<DraftBusinessField[]>(),
  aiConfidence: text("ai_confidence"),
});

export const treatmentRuleGroups = pgTable("treatment_rule_groups", {
  id: serial("id").primaryKey(),
  treatmentId: integer("treatment_id").notNull(),
  ruleType: text("rule_type").notNull(),
  logicOperator: text("logic_operator").notNull().default("AND"),
  plainEnglishInput: text("plain_english_input"),
  groupOrder: integer("group_order").notNull().default(0),
});

export const treatmentRules = pgTable("treatment_rules", {
  id: serial("id").primaryKey(),
  ruleGroupId: integer("rule_group_id").notNull(),
  fieldName: text("field_name").notNull(),
  operator: text("operator").notNull(),
  value: text("value"),
  sortOrder: integer("sort_order").notNull().default(0),
  leftFieldId: text("left_field_id"),
  rightMode: text("right_mode"),
  rightConstantValue: text("right_constant_value"),
  rightFieldId: text("right_field_id"),
});

export interface DraftSourceField {
  fieldName: string;
  description: string;
  matchedExistingField: boolean;
}

export interface DraftDerivedField {
  fieldName: string;
  displayName?: string;
  description: string;
  dataType?: string;
  derivationSummary?: string;
  dependsOn: string[];
  formulaHint?: string;
  creationReason?: string;
}

export interface DraftBusinessField {
  fieldName: string;
  displayName?: string;
  description: string;
  dataType?: string;
  allowedValues: string[];
  defaultValue?: string;
  businessMeaning?: string;
  creationReason?: string;
}

export interface ArithmeticDerivationConfig {
  type?: "arithmetic";
  fieldA: string;
  fieldALabel: string;
  operator1: string;
  operandBType: "field" | "constant";
  operandBValue: string;
  operandBLabel?: string;
  operator2?: string;
  operandCType?: "field" | "constant";
  operandCValue?: string;
  operandCLabel?: string;
}

export type LogicalOperatorType = "AND" | "OR";
export type LogicalComparisonOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in" | "contains" | "is_true" | "is_false";

export interface LogicalConditionLeaf {
  field: string;
  fieldType?: "source" | "derived" | "business";
  operator: LogicalComparisonOperator;
  value?: string | number | (string | number)[];
}

export interface LogicalConditionGroup {
  operator: LogicalOperatorType;
  conditions: (LogicalConditionLeaf | LogicalConditionGroup)[];
}

export interface LogicalDerivationConfig {
  type: "logical";
  operator: LogicalOperatorType;
  conditions: (LogicalConditionLeaf | LogicalConditionGroup)[];
}

export type DerivationConfig = ArithmeticDerivationConfig | LogicalDerivationConfig;

// Migration note (Task #23): new columns added to policy_fields via direct SQL (db:push TUI blocks):
// display_name, data_type, allowed_values (jsonb), default_value, business_meaning,
// ai_generated (boolean), created_by, source_document_id
export const policyFields = pgTable("policy_fields", {
  id: serial("id").primaryKey(),
  companyId: text("company_id").notNull(),
  policyPackId: integer("policy_pack_id"),
  label: text("label").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  sourceType: text("source_type").notNull(),
  dataType: text("data_type"),
  derivationConfig: jsonb("derivation_config").$type<DerivationConfig>(),
  derivationSummary: text("derivation_summary"),
  allowedValues: jsonb("allowed_values").$type<string[]>(),
  defaultValue: text("default_value"),
  businessMeaning: text("business_meaning"),
  aiGenerated: boolean("ai_generated").default(false),
  createdBy: text("created_by"),
  sourceDocumentId: text("source_document_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export interface PolicyFieldDto {
  id: string;
  label: string;
  displayName: string | null;
  description: string | null;
  sourceType: "source_field" | "business_field" | "derived_field";
  dataType: string | null;
  derivationConfig: DerivationConfig | null;
  derivationSummary: string | null;
  allowedValues: string[] | null;
  defaultValue: string | null;
  businessMeaning: string | null;
  aiGenerated: boolean;
  createdBy: string | null;
  sampleValues?: string[] | null;
}

export interface RuleSaveRow {
  leftFieldId: string | null;
  operator: string;
  rightMode: "constant" | "field" | null;
  rightConstantValue: string | null;
  rightFieldId: string | null;
  fieldName?: string | null;
  value?: string | null;
}

export const insertPolicyPackSchema = createInsertSchema(policyPacks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTreatmentSchema = createInsertSchema(treatments).omit({ id: true });
export const insertTreatmentRuleGroupSchema = createInsertSchema(treatmentRuleGroups).omit({ id: true });
export const insertPolicyFieldSchema = createInsertSchema(policyFields).omit({ id: true, createdAt: true });
export type InsertPolicyField = z.infer<typeof insertPolicyFieldSchema>;
export type PolicyFieldRecord = typeof policyFields.$inferSelect;
export const insertTreatmentRuleSchema = createInsertSchema(treatmentRules).omit({ id: true });

export type PolicyPack = typeof policyPacks.$inferSelect;
export type InsertPolicyPack = z.infer<typeof insertPolicyPackSchema>;
export type Treatment = typeof treatments.$inferSelect;
export type InsertTreatment = z.infer<typeof insertTreatmentSchema>;
export type TreatmentRuleGroup = typeof treatmentRuleGroups.$inferSelect;
export type InsertTreatmentRuleGroup = z.infer<typeof insertTreatmentRuleGroupSchema>;
export type TreatmentRule = typeof treatmentRules.$inferSelect;
export type InsertTreatmentRule = z.infer<typeof insertTreatmentRuleSchema>;

export interface TreatmentRuleGroupWithRules extends TreatmentRuleGroup {
  rules: TreatmentRule[];
}

export interface TreatmentWithRules extends Treatment {
  ruleGroups: TreatmentRuleGroupWithRules[];
}

export const clientConfigRelations = relations(clientConfigs, ({ many }) => ({
  rulebooks: many(rulebooks),
  dataConfigs: many(dataConfigs),
  dataUploads: many(dataUploads),
  decisions: many(decisions),
}));

export const rulebookRelations = relations(rulebooks, ({ one }) => ({
  clientConfig: one(clientConfigs, {
    fields: [rulebooks.clientConfigId],
    references: [clientConfigs.id],
  }),
}));

export const dataConfigRelations = relations(dataConfigs, ({ one }) => ({
  clientConfig: one(clientConfigs, {
    fields: [dataConfigs.clientConfigId],
    references: [clientConfigs.id],
  }),
}));

export const dpdStageRelations = relations(dpdStages, ({ one }) => ({
  clientConfig: one(clientConfigs, {
    fields: [dpdStages.clientConfigId],
    references: [clientConfigs.id],
  }),
}));

export const dataUploadRelations = relations(dataUploads, ({ one, many }) => ({
  clientConfig: one(clientConfigs, {
    fields: [dataUploads.clientConfigId],
    references: [clientConfigs.id],
  }),
  decisions: many(decisions),
}));

export const decisionRelations = relations(decisions, ({ one }) => ({
  clientConfig: one(clientConfigs, {
    fields: [decisions.clientConfigId],
    references: [clientConfigs.id],
  }),
  dataUpload: one(dataUploads, {
    fields: [decisions.dataUploadId],
    references: [dataUploads.id],
  }),
}));

export const insertClientConfigSchema = createInsertSchema(clientConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRulebookSchema = createInsertSchema(rulebooks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDataConfigSchema = createInsertSchema(dataConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDpdStageSchema = createInsertSchema(dpdStages).omit({
  id: true,
  createdAt: true,
});

export const insertPolicyConfigSchema = createInsertSchema(policyConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDataUploadSchema = createInsertSchema(dataUploads).omit({
  id: true,
  createdAt: true,
});

export const insertDecisionSchema = createInsertSchema(decisions).omit({
  id: true,
  createdAt: true,
});

export const insertUploadLogSchema = createInsertSchema(uploadLogs).omit({
  id: true,
  createdAt: true,
});

export type ClientConfig = typeof clientConfigs.$inferSelect;
export type InsertClientConfig = z.infer<typeof insertClientConfigSchema>;
export type Rulebook = typeof rulebooks.$inferSelect;
export type InsertRulebook = z.infer<typeof insertRulebookSchema>;
export type DataConfig = typeof dataConfigs.$inferSelect;
export type InsertDataConfig = z.infer<typeof insertDataConfigSchema>;
export type DpdStage = typeof dpdStages.$inferSelect;
export type InsertDpdStage = z.infer<typeof insertDpdStageSchema>;
export type DataUpload = typeof dataUploads.$inferSelect;
export type InsertDataUpload = z.infer<typeof insertDataUploadSchema>;
export type Decision = typeof decisions.$inferSelect;
export type InsertDecision = z.infer<typeof insertDecisionSchema>;
export type PolicyConfig = typeof policyConfigs.$inferSelect;
export type InsertPolicyConfig = z.infer<typeof insertPolicyConfigSchema>;
export type UploadLog = typeof uploadLogs.$inferSelect;
export type InsertUploadLog = z.infer<typeof insertUploadLogSchema>;
