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
- `/config` - Client company configuration
- `/rulebook` - SOP/Rulebook management (text or file upload)
- `/data-config` - Data field configuration and AI prompt template
- `/upload` - CSV/JSON file upload and AI processing
- `/review` - Pending decisions review queue
- `/review/:id` - Individual decision detail with approve/reject
- `/history` - Decision history

## Data Flow
1. Manager configures client details
2. Manager uploads SOP rules (text or PDF/JPG with OCR)
3. Manager configures data fields and AI prompt template
4. Manager uploads customer data (CSV/JSON)
5. AI processes each customer against SOP rules
6. Agent reviews decisions in the review queue
7. Agent approves/rejects with reasoning

## Database Tables
- `users` / `sessions` - Replit Auth
- `client_configs` - Company details per user
- `rulebooks` - SOP documents/text per client
- `data_configs` - Field mapping and prompt templates
- `data_uploads` - Uploaded file records
- `decisions` - AI decisions with review status

## Recent Changes
- 2026-02-24: Initial MVP build with all core features
