# Beacon Demo

## Overview
Project Beacon is a B2B web application for lenders to upload CSV/JSON customer data (loans, payments, chat logs). The app uses an AI agent (Gemini) to analyze this data against a specific SOP (Standard Operating Procedure) to recommend decisions (Approve, Deny, Flag for Review).

## Architecture
- **Frontend**: React + TypeScript + Tailwind CSS + Shadcn UI + Wouter routing
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit managed) + Drizzle ORM
- **Auth**: Custom email/password (bcryptjs + express-session)
- **AI**: Gemini 2.5 Flash via Replit AI Integrations (no API key needed)
- **File Processing**: Multer for uploads, PapaParse for CSV parsing

## Key Pages
- `/` - Landing page (unauthenticated) or Dashboard (authenticated)
- `/config` - Client Configuration (4 tabs: Company Details, Action Rulebook, Data Configuration, Prompt Config)
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
- Each section has: sample CSV download, drag-and-drop upload, data table viewer with search by customer ID, column filter, and pagination
- AI analysis (Analyze button) available only on Loan Data uploads
- Upload category stored in `uploadCategory` field on `data_uploads` table
- Conversation History tab persists if data exists, even when disabled in config
- CSV uploads upsert records by customer/loan/account ID — re-uploading updates existing records and adds new ones

## Database Tables
- `users` / `sessions` - Auth
- `client_configs` - Company details per user
- `rulebooks` - SOP documents/text per client
- `data_configs` - Field mapping, prompt templates, payment additional fields
- `data_uploads` - Uploaded file records with `uploadCategory` (loan_data, payment_history, conversation_history)
- `decisions` - AI decisions with review status
- `dpd_stages` - Configurable DPD bucket stages

## Recent Changes
- 2026-02-25: Rebuilt Upload Data page with categorized sections, sample CSV downloads, data table viewers with search/filter/pagination
- 2026-02-25: Added `uploadCategory` to data_uploads, `paymentAdditionalFields` to data_configs
- 2026-02-24: Initial MVP build with all core features
