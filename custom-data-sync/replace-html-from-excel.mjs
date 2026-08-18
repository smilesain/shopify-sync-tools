import { readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';

const EXCEL_PATH = process.argv[2];
const TARGET_PATH = process.argv[3];
const SHEET = process.argv[4] || '';

function loadMappings(excelPath, sheetName) {
  const wb = XLSX.readFile(excelPath);
  const sheet = sheetName || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
  const entries = [];
  for (const row of rows) {
    const source = String(row[0] ?? '').trim();
    const target = String(row[1] ?? '').trim();
    if (!source || !target || source === 'PT-参考' || target === 'EN') continue;
    entries.push([source, target]);
  }
  return entries.sort((a, b) => b[0].length - a[0].length);
}

function normalizeText(text) {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripTags(html) {
  return normalizeText(html.replace(/<[^>]+>/g, ' '));
}

function wrapEnglish(innerHtml, englishText) {
  const headStrong = innerHtml.match(/^<strong[^>]*>([\s\S]*?)<\/strong>([\s\S]*)$/i);
  if (headStrong) {
    const bodyPlain = normalizeText(headStrong[2]);
    if (!bodyPlain) return `<strong>${englishText}</strong>`;
    if (/:\s*$/.test(normalizeText(headStrong[1]))) {
      const idx = englishText.indexOf(': ');
      if (idx !== -1) {
        return `<strong>${englishText.slice(0, idx + 1)}</strong> ${englishText.slice(idx + 2)}`;
      }
    }
  }

  const h1Match = innerHtml.match(/^(\s*<h1[^>]*><b>)([\s\S]*?)(<\/b><\/h1>\s*)$/i);
  if (h1Match) return `${h1Match[1]}${englishText.trim()}${h1Match[3]}`;

  const h2Match = innerHtml.match(/^(\s*<h2[^>]*><span><b>)([\s\S]*?)(<\/b><\/span><\/h2>\s*)$/i);
  if (h2Match) return `${h2Match[1]}${englishText.trim()}${h2Match[3]}`;

  const h2PlainMatch = innerHtml.match(/^(\s*<h2[^>]*><span><br>)([\s\S]*?)(<\/span><\/h2>\s*)$/i);
  if (h2PlainMatch) return `${h2PlainMatch[1]}${englishText.trim()}${h2PlainMatch[3]}`;

  const spanOnly = innerHtml.match(/^(\s*<span>)([\s\S]*?)(<\/span>\s*)$/i);
  if (spanOnly) return `${spanOnly[1]}${englishText.trim()}${spanOnly[3]}`;

  const pSpan = innerHtml.match(/^(\s*<p><span>)([\s\S]*?)(<\/span><\/p>\s*)$/i);
  if (pSpan) return `${pSpan[1]}${englishText.trim()}${pSpan[3]}`;

  return englishText;
}

function replaceParagraphs(html, mappings) {
  let replaced = 0;
  let output = html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (full, innerHtml) => {
    const plain = stripTags(innerHtml);
    const mapping = mappings.find(([source]) => normalizeText(source) === plain);
    if (!mapping) return full;
    replaced += 1;
    return full.replace(innerHtml, wrapEnglish(innerHtml, mapping[1]));
  });
  return { html: output, replaced };
}

function replaceDivSpans(html, mappings) {
  let replaced = 0;
  let output = html;

  for (const [source, target] of mappings) {
    const sourceNorm = normalizeText(source);
    output = output.replace(/(<div(?:\s[^>]*)?>)([\s\S]*?)(<\/div>)/gi, (full, open, inner, close) => {
      if (normalizeText(stripTags(inner)) !== sourceNorm) return full;
      replaced += 1;
      return `${open}${wrapEnglish(inner, target)}${close}`;
    });
  }

  return { html: output, replaced };
}

function replaceHeadings(html, mappings) {
  let replaced = 0;
  let output = html;

  for (const [source, target] of mappings) {
    const sourceNorm = normalizeText(source);
    output = output.replace(/(<h[12]\b[^>]*>)([\s\S]*?)(<\/h[12]>)/gi, (full, open, inner, close) => {
      if (normalizeText(stripTags(inner)) !== sourceNorm) return full;
      replaced += 1;
      return `${open}${wrapEnglish(inner, target)}${close}`;
    });
  }

  return { html: output, replaced };
}

function replaceLiteral(html, mappings) {
  let output = html;
  let replaced = 0;
  for (const [source, target] of mappings) {
    if (output.includes(source)) {
      output = output.split(source).join(target);
      replaced += 1;
    }
  }
  return { html: output, replaced };
}

const mappings = loadMappings(EXCEL_PATH, SHEET);
const raw = readFileSync(TARGET_PATH, 'utf8');

const altMappings = [
  [
    'Pode especificar em "Definições adicionais" para que fins podemos utilizar cookies e tratar os seus dados pessoais, ou obter mais informações. Se mudar de ideias, pode atualizar estas definições a qualquer momento, com efeito para o futuro, visitando as preferências de cookies, conforme descrito na Declaração de Privacidade.',
    mappings.find(([source]) => source.startsWith('Pode especificar em "Preferências"'))?.[1] ??
      'You can specify under "Further settings" for which purposes we may use cookies and process your personal data, or obtain more information. If you change your mind, you can update these settings at any time with future effect by visiting cookie preferences, as described in the Privacy Statement.',
  ],
];

let output = raw;
let totalReplaced = 0;

for (const [source, target] of altMappings) {
  if (output.includes(source)) {
    output = output.split(source).join(target);
    totalReplaced += 1;
  }
}

const paragraphResult = replaceParagraphs(output, mappings);
const divResult = replaceDivSpans(paragraphResult.html, mappings);
const headingResult = replaceHeadings(divResult.html, mappings);
const literalResult = replaceLiteral(headingResult.html, mappings);
output = literalResult.html;
totalReplaced +=
  paragraphResult.replaced + divResult.replaced + headingResult.replaced + literalResult.replaced;

writeFileSync(TARGET_PATH, output, 'utf8');
console.log(`Mappings: ${mappings.length}, replaced ops: ${totalReplaced}`);

const left = mappings.filter(([source]) => stripTags(output).includes(normalizeText(source)));
console.log(`Remaining PT: ${left.length}`);
left.forEach(([source]) => console.log(`  - ${source.slice(0, 100)}`));
