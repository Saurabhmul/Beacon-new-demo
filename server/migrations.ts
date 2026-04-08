import { pool } from "./db";

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE policy_fields
        ADD COLUMN IF NOT EXISTS display_name TEXT,
        ADD COLUMN IF NOT EXISTS data_type TEXT,
        ADD COLUMN IF NOT EXISTS allowed_values JSONB,
        ADD COLUMN IF NOT EXISTS default_value TEXT,
        ADD COLUMN IF NOT EXISTS business_meaning TEXT,
        ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN,
        ADD COLUMN IF NOT EXISTS created_by TEXT,
        ADD COLUMN IF NOT EXISTS source_document_id TEXT;
    `);
    console.log("DB migrations applied (policy_fields columns idempotent).");
  } catch (err) {
    console.error("Migration error:", err);
    throw err;
  } finally {
    client.release();
  }
}
