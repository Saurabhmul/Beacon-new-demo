# Beacon Demo

## Overview
Project Beacon is a B2B web application for lenders to upload CSV/JSON customer data (loans, payments, chat logs). The app uses an AI agent (Gemini) to analyze this data against a specific SOP (Standard Operating Procedure) to recommend decisions (Approve, Deny, Flag for Review).

## Architecture
- **Frontend**: React + TypeScript + Tailwind CSS + Shadcn UI + Wouter routing
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit managed) + Drizzle ORM
- **Auth**: Custom email/password (bcryptjs + express-session) with invite-based registration
- **AI**: Gemini 2.5 Pro via Replit AI Integrations (no API key needed)
- **File Processing**: Multer for uploads, PapaParse for CSV parsing

## Rule Engine (Phase 1)
- `policy_fields` table: company-scoped field registry for custom Business and Derived fields
  - `source_field`: synthesized from Data Config field analysis (stable ID = `source:<fieldName>`)
  - `business_field` / `derived_field`: stored in DB, ID = row integer as string
  - Derived fields have `derivationConfig` (jsonb) and auto-generated `derivationSummary`
- `treatment_rules` enhanced with: `leftFieldId`, `rightMode` (constant/field), `rightConstantValue`, `rightFieldId`
- **GET /api/policy-fields**: returns unified field list (source + business + derived), sorted Source→Business→Derived
- **POST /api/policy-fields**: creates business/derived field with server-side duplicate check (case-insensitive, per companyId) and derivation summary generation
- **When to Offer** rule section uses new FieldPicker + RHS Const/Field toggle + info popover
- **Blocked If** rule section uses the legacy knownFields dropdown (Phase 1 only)
- `FieldPicker`: grouped Select (Source / Business / Derived) with "+ Add customer field" action
- `AddCustomFieldModal`: creates business or derived field with optional derivation builder (Field A op Operand B, optional op Operand C)

## Multi-Tenant Architecture
- **Companies**: `companies` table — each lender organization
- **Users**: Expanded `users` table with role (superadmin/admin/manager/agent), companyId, status (invited/active/deactivated), invite token flow
- **Data Isolation**: All business tables (client_configs, rulebooks, data_configs, dpd_stages, policy_configs, data_uploads, upload_logs, decisions) have `companyId` column. All storage methods filter by companyId.
- **Middleware stack**: `authenticate` → `authorize(...roles)` → `companyFilter` on all protected routes
- **SuperAdmin**: Can switch companies via session.viewingCompanyId; defaults to own companyId if none selected
- **Seed data**: Prodigy Finance company with superadmin (saurabh.aggarwal@prodigyfinance.com) and admin (test@prodigyfinance.com / test1234)

## Role Permissions
- **SuperAdmin**: View-only on all company data (config, uploads, review queue, rulebooks). Can manage users + company switching. Exclusive access to Prompt Config tab. Cannot edit/upload/analyze/review company data (403 from backend).
- **Admin**: Client Configuration (full edit), Policy Config, Data Config, Review Queue, Users (create Admin/Manager/Agent). No Prompt Config access.
- **Manager**: Client Configuration (read-only), Upload Data (full), Review Queue (full), Users (create Manager/Agent)
- **Agent**: Review Queue only (no upload, no config, no user management)

## User Invitation Flow
1. Admin/SuperAdmin creates user via POST /api/users — generates invite token (7-day expiry)
2. Invite link returned in API response (no SMTP — must be shared manually)
3. User visits /auth?invite=<token>, sees pre-filled details, sets password
4. POST /api/auth/register with inviteToken activates account
5. Self-registration is disabled — all users must be invited

## Key Pages
- `/` - Landing page (unauthenticated) or Dashboard (authenticated)
- `/config` - Client Configuration (4 tabs: Company Details, Policy Config, Data Configuration, Prompt Config)
- `/upload` - Upload Data (tabbed: Loan Data, Payment History, Conversation History if enabled)
- `/review` - Pending decisions review queue
- `/review/:id` - Individual decision detail with approve/reject
- `/users` - User Management (role-based: add, edit, deactivate/reactivate, resend invite)

## Data Flow
1. Manager configures client details in Client Configuration
2. Manager uploads SOP rules (text or PDF/JPG with OCR) in Action Rulebook tab
3. Manager configures data fields (mandatory loan + payment fields, optional fields) and AI prompt template
4. Manager uploads customer data per category (Loan Data, Payment History, optional Conversation History)
5. AI processes loan data against SOP rules
6. Agent reviews decisions in the review queue
7. Agent approves/rejects with reasoning

## Upload Data Page
- Dynamic sections based on Data Configuration: Loan Data (always), Payment History (always), Conversation History (if selected in optional fields)
- Each section has: sample CSV download, drag-and-drop upload, data table viewer with search by customer/account/loan ID, and pagination
- "Track Uploads" button in each section switches to an in-page upload history view showing: date/time, filename, uploader email, record/processed/failed counts, and CSV download with per-row status
- Download Data button exports current merged data as CSV
- Data table columns ordered to match sample CSV field order (mandatory fields first, then optional, then any extra uploaded fields)
- Upload category stored in `uploadCategory` field on `data_uploads` table
- Conversation History tab persists if data exists, even when disabled in config
- CSV uploads upsert records by customer/loan/account ID — re-uploading updates existing records and adds new ones
- Each upload creates an upload log entry tracking per-row status (created/updated/failed with messages)

## Database Tables
- `companies` - Lender organizations (id, name, status, createdBy, createdAt)
- `users` / `sessions` - Auth with roles, company membership, invite tokens
- `client_configs` - Company details per companyId
- `rulebooks` - SOP documents/text per client
- `data_configs` - Field mapping, prompt templates, selected categories, and per-category file/field analysis data. New columns: `selected_categories` (jsonb string[]), `category_data` (jsonb Record<string, CategoryEntry>)
- `data_uploads` - Uploaded file records with `uploadCategory` (loan_data, payment_history, conversation_history)
- `upload_logs` - Upload history with per-row status tracking (created/updated/failed) and download capability
- `decisions` - AI decisions with review status
- `dpd_stages` - Configurable DPD bucket stages
- `policy_configs` - Policy configuration per client (vulnerability definition, affordability rules, available treatments, decision rules, escalation rules)

## Prompt Compiler Architecture (3-Layer System)
- **Brain (Static)**: `server/lib/prompt/brain-template.txt` — Role, analytical framework, scoring formulas, evidence rules, output format with `{{PLACEHOLDER}}` markers. Rarely changed.
- **Policy (Dynamic)**: Auto-compiled from Policy Config sections A-F whenever client saves config. Stored as `compiledPolicy` (jsonb) on `policy_configs` table. Compiler: `server/lib/prompt/compile-policy.ts`.
- **Customer Data (Per-request)**: Formatted from uploaded data at runtime per customer. Formatter: `server/lib/prompt/assemble-prompt.ts`.
- **Assembler**: `server/lib/prompt/assemble-prompt.ts` — Loads brain template, replaces all `{{PLACEHOLDER}}` markers with compiled policy + customer data + output schema.
- **Output Schema**: `server/lib/prompt/output-schema.json` — Expected JSON response format.
- **Prompt Config tab**: Read-only preview of assembled prompt (brain + policy, customer data placeholder). Has Regenerate and Copy buttons. Only the Expected Output Format section is editable.

## AI Analysis Flow
1. User clicks "Start Analyzing" on Review Queue page
2. `POST /api/analyze` gathers all uploaded data per unique customer (loan + payments + conversations)
3. Loads compiled policy from `policy_configs.compiledPolicy` (or compiles on-the-fly if not cached)
4. Assembles full prompt: brain template + compiled policy + customer data + output schema
5. Gemini AI analyzes each customer via SSE streaming
6. Decisions are created progressively and appear in the review queue in real-time
7. Review Queue shows: Customer ID, Last AI Run Date, Proposed Action, Review button
8. Decision Detail page shows: sidebar with customer metrics, Beacon Analysis section, Ability to Pay section, Recommended Action section, approve/reject controls

## Available Treatments
- Default treatments include: Standard Payment Plan, Forbearance/Payment Holiday, Loan Modification/Restructure, and more
- **Clear Arrears Plan**: Special treatment where customer pays above MAD to clear arrears within configurable months (2-12, default 6). Has eligibility formula `(NMPC - MAD) * months >= Total Arrears`. Prompt compiler emits special calculation instructions. AI output includes `arrears_clearance_plan` object with monthly payment, surplus, total arrears, months to clear, and projected timeline. Decision detail page renders timeline table when present.
- Each treatment has per-DPD-stage blocklist (can block in Early/Mid/Late etc.)
- Decision rules auto-suggest `otherCondition` when Clear Arrears Plan is selected; condition updates when clearanceMonths changes

## SOP → AI Treatment Draft (Task #16)
- **Multi-PDF Upload Panel**: Policy Pack section in Client Config has "Generate from SOP" button that opens a panel for uploading up to 10 PDF files (Standard Operating Procedures). Files validated client-side (type + size).
- **Backend route**: `POST /api/policy-pack/generate-treatment-draft` — accepts multipart PDF uploads, extracts text via `pdf-parse` with Gemini Vision fallback for image-heavy PDFs, fetches field catalog (source + business + derived fields), calls Gemini 2.5 Pro with structured JSON output (Zod-validated), stores draft in `treatments` table columns `draftSourceFields`, `draftDerivedFields`, `draftBusinessFields`, and `aiConfidence`.
- **Policy Pack DB columns**: Added `lastAiGenerationRawOutput`, `lastAiGenerationAt`, `aiGenerationSummary`, `aiOpenQuestions` to `policy_packs` table; `draftSourceFields`, `draftDerivedFields`, `draftBusinessFields`, `aiConfidence` to `treatments` table.
- **Overwrite confirmation modal**: If treatments already exist, user is shown a modal warning before AI generation overwrites them.
- **AI Review Banner**: After generation, shows AI summary and open questions (if any) in a dismissible banner above the treatment list.
- **TreatmentCard enhancements**: Confidence badge (High/Medium/Low, color-coded) shown on cards with AI-generated data. Source/Derived/Business field tab panels appear when counts > 0.

## Field Metadata System (Task #42)
- **MVP Types**: string, number, boolean, date, enum
- **AI extraction**: Source field analysis prompt extracts `data_type`, `allowed_values`, `default_value` per field (conservative defaults: unclear → string, [] , null)
- **SOP extraction**: Business/derived fields from SOP already carry `data_type`, `allowed_values`, `default_value`, `business_meaning`
- **Source field UI**: Data Config table shows Type dropdown, Allowed Values input (shown for enum), Default Value text input — all editable
- **Business field modal**: Data Type dropdown, Allowed Values (shown for enum), Default Value (with soft warning if not in allowed_values for enum), Business Meaning textarea
- **Derived field UI**: Deduced type shown below formula (arithmetic → number, else → string); mismatch warning when arithmetic uses enum/string fields
- **Field info popover**: Shows Type, Allowed Values, Default Value, Business Meaning for all field types
- **Runtime type priority**: user-defined → AI-extracted → system-deduced → fallback string
- **Safe coercion** (`shared/field-utils.ts`): toNumber, toBoolean, toDate, coerceToString, safeCoerce, resolveFieldType, inferBusinessFieldType, deduceTypeFromDerivation, checkFormulaMismatch — all return null on unsafe conversion
- **PATCH /api/policy-fields/:id**: Accepts dataType, allowedValues, defaultValue, businessMeaning
- **POST /api/policy-fields**: Accepts dataType, allowedValues, defaultValue, businessMeaning

## Decisioning Pipeline v2.1 (Tasks #43–#46)
- **Context Sections** (`server/lib/decisioning/context-sections.ts`): 10 named sections + `emptyContextSections()`. Sections: customerProfile, loanData, paymentData, conversationData, bureauData, incomeEmploymentData, resolvedSourceFields, priorBusinessFields, compliancePolicyInternalRules, knowledgeBaseAgentGuidance.
- **Business Field Engine** (`server/lib/decisioning/business-field-engine.ts`): `inferBusinessFields()` — sequential field inference using Gemini 2.5 Pro with truncation of large histories, flagged item detection, prior-field accumulation per field, retry logic, and per-field trace output.
- **Business Field Prompt** (`server/lib/decisioning/prompts/business-field-prompt.ts`): 13-rule system prompt, per-field user prompt, retry suffix with validation error feedback.
- **Derived Field Engine** (`server/lib/decisioning/derived-field-engine.ts`): `computeDerivedFields()` — deterministic topo-sorted execution with cycle detection, safe type coercion, null propagation, and per-field trace. Also exports `buildResolvedSourceFieldsMap()`.
- **Decision Packet** (`server/lib/decisioning/decision-packet.ts`): `DecisionPacket` type + `buildDecisionPacket()` — structured packet containing customer data, grouped source data (loanData, paymentData, conversationData, bureauData, incomeEmploymentData), business fields, derived fields, treatments and policy rules.
- **Final Decision Prompt** (`server/lib/decisioning/prompts/final-decision-prompt.ts`): 18-rule system prompt with JSON output schema, user prompt from packet, retry suffix.
- **Decision Validator** (`server/lib/decisioning/decision-validator.ts`): validates AI output against required fields and output schema.
- **New DB columns on decisions**: `recommended_treatment_name`, `recommended_treatment_code`, `customer_situation`, `treatment_eligibility_explanation`, `structured_assessments` (jsonb), `decision_trace_json` (jsonb) — all nullable.
- **Review Queue (Task #46)**: Column renamed from "Proposed Action" to "Recommended Treatment". Shows `recommendedTreatmentName` (falls back to `proposedSolution`). Search updated.
- **Decision Detail v2.1 (Task #46)**: 5-section layout: (1) Decision Summary — customer ID, status, recommended treatment, situation confidence, customer situation; (2) Source Data — grouped data cards for all data categories; (3) Business Fields — collapsible table from `decisionTraceJson`; (4) Derived Fields — collapsible table from trace; (5) Treatment Decision — structured assessments, decision factors, treatment rationale, internal action, email draft, policy/guidance used, agent review.
- Legacy decisions (no `decisionTraceJson`) show: `"This decision was generated before v2.1 detail tracing was available."` in sections 3 and 4.
- `/api/analyze` route fully replaced with new pipeline: build context sections → inferBusinessFields → computeDerivedFields → buildDecisionPacket → final AI decision.

## Recent Changes
- 2026-04-12: Decisioning pipeline v2.1 (Tasks #43–#46) — new business field inference, derived field computation, structured decision packet, final AI decision prompt/schema, review queue and decision detail UI updated
- 2026-04-11: Field Metadata Extraction & Editing (Task #42) — AI extracts data_type/allowed_values/default_value for source fields; editable in Data Config; business/derived field modal has full metadata inputs; derived field type deduction + mismatch warnings; safe coercion helpers; PATCH/POST endpoints extended
- 2026-04-08: SOP multi-PDF upload → Gemini AI treatment draft generation (Task #16) — full end-to-end flow with confidence badges, field tab panels, overwrite modal, AI review banner
- 2026-04-06: Upload Data tab now uses saved Data Configuration as source of truth — tabs shown only for configured tabular categories (loan_account→loan_data, payment_history, conversation_history, income_employment, credit_bureau); document-only categories (compliance_policy, knowledge_base) excluded; sample CSV generated from saved field analysis (active/non-ignored fields only); falls back to hardcoded defaults if no Data Config saved yet
- 2026-04-06: Redesigned Data Configuration tab — replaced mandatory/optional field chips with 7 category cards (Loan/Account, Payment History, Conversation History, Income/Employment, Credit Bureau, Compliance Policy, Knowledge Base). Checkbox-driven upload flow with AI field analysis (Gemini 2.0 Flash), inline editable field descriptions, confidence badges (High/Medium/Low), ignore toggles, and save to DB. New backend endpoint POST /api/data-config/analyze-category; xlsx support for XLSX parsing; new schema columns selected_categories and category_data on data_configs
- 2026-03-06: Multi-tenant Users & Roles system implemented — companies table, expanded users with roles/invites, company_id on all tables, role-based auth middleware, role-based sidebar navigation, Users management page (add/edit/deactivate/resend invite), invite registration flow, SuperAdmin company switching, seed data for Prodigy Finance
- 2026-03-05: Fixed AI returning "NOT SURE" for affordability/willingness — root causes fixed: 1) `formatCustomerData()` handles `_payments`/`_conversations` underscore-prefixed keys, 2) `compile-policy.ts` now generates plain English thresholds (no NMPC/MAD acronyms), 3) brain-template.txt rewritten with step-by-step calculation instructions, 4) output-schema.json mandates non-empty reason fields ending with "→ LABEL", 5) `routes.ts` always freshly recompiles policy with `clearTemplateCache()` before analysis, 6) Removed duplicate customer data from user message (data only in system prompt's CUSTOMER_DATA section), 7) Model acknowledgment explicitly commits to matching labels to calculations, 8) Safety net `extractLabelFromReason()` + `humanizeReasonText()` as last-resort post-processing
- 2026-03-03: Global analysis context (`client/src/hooks/use-analysis.tsx`) — analysis state (progress, SSE connection) persists across page navigation; header shows progress indicator on all pages during analysis; bulk select/delete for review queue decisions
- 2026-03-03: Added "Start Analyzing" feature with POST /api/analyze endpoint, multi-source data aggregation (loan+payment+conversation per customer), SSE progress streaming, redesigned review queue with pagination, redesigned decision detail page with sidebar layout
- 2026-02-27: Added Track Uploads feature with upload history view, per-row status tracking (created/updated/failed), CSV download with status columns
- 2026-02-27: Replaced "Analyze with AI" button with "Download Data" for loans/payments; ordered table columns to match sample CSV; removed column filter (search only)
- 2026-02-25: Rebuilt Upload Data page with categorized sections, sample CSV downloads, data table viewers with search/filter/pagination
- 2026-02-25: Added `uploadCategory` to data_uploads, `paymentAdditionalFields` to data_configs
- 2026-02-24: Initial MVP build with all core features
