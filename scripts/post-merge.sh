#!/usr/bin/env bash
set -euo pipefail

echo "[post-merge] Installing npm dependencies..."
npm install --ignore-scripts

echo "[post-merge] Applying DB migrations..."
# depends_on_business_fields column added in Task #39
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('ALTER TABLE policy_fields ADD COLUMN IF NOT EXISTS depends_on_business_fields jsonb')
  .then(() => { console.log('[post-merge] depends_on_business_fields column ensured'); pool.end(); })
  .catch(err => { console.error('[post-merge] Migration error:', err.message); pool.end(); process.exit(1); });
"

echo "[post-merge] Done."
