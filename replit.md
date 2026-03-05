# Beacon Demo

## Overview
Project Beacon is a B2B web application for lenders to upload CSV/JSON customer data (loans, payments, chat logs). The app uses an AI agent (Gemini) to analyze this data against a specific SOP (Standard Operating Procedure) to recommend decisions (Approve, Deny, Flag for Review).

## Architecture
- **Frontend**: React + TypeScript + Tailwind CSS + Shadcn UI + Wouter routing
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit managed) + Drizzle ORM
- **Auth**: Custom email/password (bcryptjs + express-session)
- **AI**: Gemini 2.5 Pro via Replit AI Integrations (no API key needed)
- **File Processing**: Multer for uploads, PapaParse for CSV parsing

## Key Pages
- `/` - Landing page (unauthenticated) or Dashboard (authenticated)
- `/config` - Client Configuration (4 tabs: Company Details, Policy Config, Data Configuration, Prompt Config)
- `/upload` - Upload Data (tabbed: Loan Data, Payment History, Conversation History if enabled)
- `/review` - Pending decisions review queue
- `/review/:id` - Individual decision detail with approve/reject
- `/history` - Decision history

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
- `users` / `sessions` - Auth
- `client_configs` - Company details per user
- `rulebooks` - SOP documents/text per client
- `data_configs` - Field mapping, prompt templates, payment additional fields
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

## Recent Changes
- 2026-03-05: Fixed AI returning "NOT SURE" for affordability/willingness — root causes: 1) `formatCustomerData()` handles `_payments`/`_conversations` underscore-prefixed keys, 2) brain-template.txt rewritten with step-by-step calculation instructions using plain English (no NMPC/MAD acronyms), 3) output-schema.json mandates non-empty reason fields ending with "→ LABEL", 4) server-side safety net `extractLabelFromReason()` in ai-engine.ts overrides NOT SURE when reason text contains a clear label conclusion, 5) `humanizeReasonText()` replaces any remaining NMPC/MAD acronyms with plain English before saving
- 2026-03-03: Global analysis context (`client/src/hooks/use-analysis.tsx`) — analysis state (progress, SSE connection) persists across page navigation; header shows progress indicator on all pages during analysis; bulk select/delete for review queue decisions
- 2026-03-03: Added "Start Analyzing" feature with POST /api/analyze endpoint, multi-source data aggregation (loan+payment+conversation per customer), SSE progress streaming, redesigned review queue with pagination, redesigned decision detail page with sidebar layout
- 2026-02-27: Added Track Uploads feature with upload history view, per-row status tracking (created/updated/failed), CSV download with status columns
- 2026-02-27: Replaced "Analyze with AI" button with "Download Data" for loans/payments; ordered table columns to match sample CSV; removed column filter (search only)
- 2026-02-25: Rebuilt Upload Data page with categorized sections, sample CSV downloads, data table viewers with search/filter/pagination
- 2026-02-25: Added `uploadCategory` to data_uploads, `paymentAdditionalFields` to data_configs
- 2026-02-24: Initial MVP build with all core features
