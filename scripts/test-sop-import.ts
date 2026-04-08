import fs from "fs";
import path from "path";
import { extractTextFromPdfWithVision, generateTreatmentDraft } from "../server/ai-engine";
import { buildFullFieldCatalog } from "../server/field-catalog";
import { storage } from "../server/storage";

const LENDABLE_COMPANY_ID = "f8e55a8d-ff5b-4fc5-9e1f-f5ef1564e309";
const PDF_PATH = path.resolve("attached_assets/Beacon_-_Example_SOP_(1)_1775677470456.pdf");

async function run() {
  console.log("=== SOP Import E2E Test ===\n");

  console.log("Step 1: Reading PDF file...");
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  console.log(`  PDF size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

  console.log("Step 2: Extracting text from PDF via AI...");
  const sopText = await extractTextFromPdfWithVision(pdfBuffer);
  console.log(`  Extracted ${sopText.length} characters`);
  console.log(`  Preview: ${sopText.slice(0, 120).replace(/\n/g, " ")}...`);

  console.log("Step 3: Loading field catalog via buildFullFieldCatalog...");
  const fullCatalog = await buildFullFieldCatalog(LENDABLE_COMPANY_ID, storage);
  const fieldCatalog = fullCatalog.map(f => ({
    label: f.label,
    sourceType: f.sourceType,
    description: f.description ?? null,
    derivationSummary: f.derivationSummary ?? null,
  }));
  console.log(`  Loaded ${fieldCatalog.length} fields`);
  fieldCatalog.slice(0, 5).forEach(f => console.log(`    - ${f.label} (${f.sourceType})`));

  console.log("Step 4: Running generateTreatmentDraft (this takes ~75s)...");
  const start = Date.now();
  try {
    const result = await generateTreatmentDraft(sopText, fieldCatalog);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✅ SUCCESS in ${elapsed}s`);
    console.log(`  Summary: ${(result.summary ?? "").slice(0, 120)}...`);
    console.log(`  Treatments: ${result.treatments.length}`);
    console.log(`  Global source fields: ${result.global_source_fields.length}`);
    console.log(`  Global derived fields: ${result.global_derived_fields.length}`);
    console.log(`  Global business fields: ${result.global_business_fields.length}`);
    console.log(`  Open questions: ${result.open_questions.length}`);
    for (const t of result.treatments) {
      console.log(`    - ${t.name} (when_to_offer: ${t.when_to_offer.length}, blocked_if: ${t.blocked_if.length})`);
    }
  } catch (err: unknown) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ FAILED in ${elapsed}s`);
    console.error(`  Error: ${message}`);
    process.exit(1);
  }
}

run().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
