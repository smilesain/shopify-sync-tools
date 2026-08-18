import { readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';

const EXCEL_PATH = process.argv[2];
const TARGET_PATH = process.argv[3];
const SHEET = process.argv[4] || '';

if (!EXCEL_PATH || !TARGET_PATH) {
  console.error('Usage: node replace-text-from-excel.mjs <EXCEL_PATH> <TARGET_PATH> [SHEET_NAME]');
  process.exit(1);
}

function loadMappings(excelPath, sheetName) {
  const wb = XLSX.readFile(excelPath);
  const sheet = sheetName || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], {
    header: 1,
    defval: '',
  });

  const entries = [];
  for (const row of rows.slice(1)) {
    const source = String(row[0] ?? '').trim();
    const target = String(row[1] ?? '').trim();
    if (!source || !target) continue;
    entries.push([source, target]);

    const sourceLines = source.split('\n').map((line) => line.trim()).filter(Boolean);
    const targetLines = target.split('\n').map((line) => line.trim()).filter(Boolean);
    if (sourceLines.length > 1 && sourceLines.length === targetLines.length) {
      sourceLines.forEach((line, index) => {
        if (line && targetLines[index]) entries.push([line, targetLines[index]]);
      });
    }
  }

  const seen = new Set();
  return entries
    .filter(([source]) => {
      if (seen.has(source)) return false;
      seen.add(source);
      return true;
    })
    .sort((a, b) => b[0].length - a[0].length);
}

function applyLiteralReplacements(text, mappings) {
  let result = text;
  let hits = 0;
  for (const [source, target] of mappings) {
    if (!result.includes(source)) continue;
    result = result.split(source).join(target);
    hits += 1;
  }
  return { result, hits };
}

function findRemaining(text, mappings) {
  return mappings.filter(([source]) => text.includes(source)).map(([source]) => source);
}

const mappings = loadMappings(EXCEL_PATH, SHEET);
const raw = readFileSync(TARGET_PATH, 'utf8');
const { result, hits } = applyLiteralReplacements(raw, mappings);
writeFileSync(TARGET_PATH, result, 'utf8');

const remaining = findRemaining(result, mappings);
console.log(`Sheet: ${SHEET || '(first)'}`);
console.log(`Mappings loaded: ${mappings.length}`);
console.log(`Mappings applied: ${hits}`);
console.log(`Remaining source phrases: ${remaining.length}`);
remaining.forEach((item) => console.log(`  - ${item.substring(0, 120)}`));
console.log(`Updated file: ${TARGET_PATH}`);
