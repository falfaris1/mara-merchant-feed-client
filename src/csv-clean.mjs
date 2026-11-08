import { createHash } from 'node:crypto';
import { AgentError } from './errors.mjs';
import { CSV_LIMITS, decodeUtf8, parseCsv, encodeCsv, needsFormulaProtection } from './csv-format.mjs';

const DATE_FORMATS = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'];
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateCsvRules(rules, headers) {
  if (!isObject(rules) || Object.keys(rules).some((key) => !['version', 'columns'].includes(key)) || rules.version !== 1 || !isObject(rules.columns)) {
    throw new AgentError('CSV_INVALID_RULES', 'Rules must contain version: 1 and a columns object; unsupported options are rejected.');
  }
  const map = new Map();
  for (const [header, rule] of Object.entries(rules.columns)) {
    if (!headers.includes(header) || !isObject(rule)) throw new AgentError('CSV_INVALID_RULES', 'Every rule must name an existing, trimmed CSV header.');
    const allowed = rule.type === 'text' ? ['type'] : rule.type === 'date' ? ['type', 'inputFormat', 'outputFormat'] : rule.type === 'number' ? ['type', 'decimalSeparator', 'thousandsSeparator'] : [];
    if (!allowed.length || Object.keys(rule).some((key) => !allowed.includes(key))) throw new AgentError('CSV_INVALID_RULES', 'Unsupported column rule or option.');
    if (rule.type === 'date' && (!DATE_FORMATS.includes(rule.inputFormat) || (rule.outputFormat !== undefined && rule.outputFormat !== 'YYYY-MM-DD'))) throw new AgentError('CSV_INVALID_RULES', 'Date rules need an explicit supported inputFormat; output is YYYY-MM-DD.');
    if (rule.type === 'number' && (!['.', ','].includes(rule.decimalSeparator) ||
        ![undefined, null, '.', ',', ' '].includes(rule.thousandsSeparator) || rule.thousandsSeparator === rule.decimalSeparator)) throw new AgentError('CSV_INVALID_RULES', 'Number rules need an explicit decimalSeparator and a distinct optional thousandsSeparator.');
    map.set(header, { ...rule });
  }
  return map;
}

function normalizeNumber(value, rule) {
  const sign = /^[+-]/.test(value) ? value[0] : '';
  const unsigned = sign ? value.slice(1) : value;
  const parts = unsigned.split(rule.decimalSeparator);
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) return null;
  let integer = parts[0];
  const separator = rule.thousandsSeparator;
  if (separator && integer.includes(separator)) {
    const groups = integer.split(separator);
    if (!/^[1-9]\d{0,2}$/.test(groups[0]) || !groups.slice(1).every((group) => /^\d{3}$/.test(group))) return null;
    integer = groups.join('');
  } else if (!/^(?:0|[1-9]\d*)$/.test(integer)) return null;
  return `${sign === '-' ? '-' : ''}${integer}${parts.length === 2 ? `.${parts[1]}` : ''}`;
}

function normalizeDate(value, rule) {
  let match;
  let year;
  let month;
  let day;
  if (rule.inputFormat === 'YYYY-MM-DD') {
    match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) [, year, month, day] = match;
  } else {
    const separator = rule.inputFormat === 'DD.MM.YYYY' ? '\\.' : '/';
    match = value.match(new RegExp(`^(\\d{2})${separator}(\\d{2})${separator}(\\d{4})$`));
    if (match) {
      year = match[3];
      [day, month] = rule.inputFormat === 'MM/DD/YYYY' ? [match[2], match[1]] : [match[1], match[2]];
    }
  }
  if (!match) return null;
  const y = Number(year); const m = Number(month); const d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${year}-${month}-${day}`;
}

export function cleanCsv(bytes, rules = { version: 1, columns: {} }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > CSV_LIMITS.maxInputBytes) throw new AgentError('CSV_BYTE_LIMIT', 'CSV input must not exceed 100000 bytes.');
  const decoded = decodeUtf8(bytes);
  const records = parseCsv(decoded);
  const originalHeaders = records[0];
  const headers = originalHeaders.map((header) => header.trim());
  if (headers.some((header) => !header)) throw new AgentError('CSV_EMPTY_HEADER', 'CSV headers must be nonempty after trimming.');
  if (new Set(headers).size !== headers.length) throw new AgentError('CSV_DUPLICATE_HEADER', 'CSV headers must be unique after trimming.');
  const columnRules = validateCsvRules(rules, headers);
  const report = {
    version: 1,
    limits: { ...CSV_LIMITS },
    input: { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), hadUtf8Bom: decoded.startsWith('\uFEFF'), dataRecords: records.length - 1, columns: headers.length, headers: originalHeaders },
    output: { dataRecords: 0, columns: headers.length, headers: [], encoding: 'UTF-8', delimiter: ',', lineEnding: 'CRLF' },
    rules: { version: 1, columns: Object.fromEntries(columnRules) },
    summary: { trimmedCells: 0, normalizedNumbers: 0, normalizedDates: 0, duplicateRowsRemoved: 0, normalizedDuplicateRowsRetained: 0, formulaProtectedCells: 0, missingValues: 0, retainedAmbiguousValues: 0, rejectedRows: 0 },
    changes: [], duplicatesRemoved: [], normalizedDuplicatesRetained: [], issues: [], rejectedRows: [],
    notes: [
      'Record numbers are logical CSV records: header=1, first data record=2. Embedded newlines do not increase the record number.',
      'Only originally identical parsed data records are removed. Rows that become identical after trimming/normalization are retained and flagged.',
      'Missing and ambiguous values are retained. No value, date interpretation, delimiter or encoding is invented.',
      'Formula protection adds one apostrophe to flagged text cells, including headers. Each change records before/after values; it is not silently removed.',
      'CSV syntax, UTF-8, width or limit violations reject the entire input before output files are created.',
    ],
  };
  const change = (record, column, kind, before, after) => { report.changes.push({ record, column: column + 1, header: headers[column], kind, before, after }); };
  const issue = (record, column, code) => { report.issues.push({ record, column: column + 1, header: headers[column], code, disposition: 'retained' }); };
  const protect = (value, record, column, isText) => {
    if (isText && needsFormulaProtection(value)) {
      const safe = `'${value}`;
      change(record, column, 'formula_protection', value, safe);
      report.summary.formulaProtectedCells++;
      return safe;
    }
    return value;
  };
  const outputHeaders = headers.map((header, column) => {
    if (header !== originalHeaders[column]) { change(1, column, 'trim', originalHeaders[column], header); report.summary.trimmedCells++; }
    return protect(header, 1, column, true);
  });
  if (new Set(outputHeaders).size !== outputHeaders.length) throw new AgentError('CSV_HEADER_COLLISION', 'Formula protection would make distinct headers identical; explicit source headers are required.');
  report.output.headers = outputHeaders;
  const originalKeys = new Map();
  const normalizedKeys = new Map();
  const outputRows = [];
  for (let index = 1; index < records.length; index++) {
    const recordNumber = index + 1;
    const row = records[index];
    const key = JSON.stringify(row);
    if (originalKeys.has(key)) {
      report.duplicatesRemoved.push({ record: recordNumber, identicalToRecord: originalKeys.get(key) });
      report.summary.duplicateRowsRemoved++;
      continue;
    }
    originalKeys.set(key, recordNumber);
    const cleaned = row.map((original, column) => {
      let value = original.trim();
      let isText = true;
      if (value !== original) { change(recordNumber, column, 'trim', original, value); report.summary.trimmedCells++; }
      if (value === '') { issue(recordNumber, column, 'missing_value'); report.summary.missingValues++; return value; }
      const rule = columnRules.get(headers[column]);
      if (rule?.type === 'number' || rule?.type === 'date') {
        const normalized = rule.type === 'number' ? normalizeNumber(value, rule) : normalizeDate(value, rule);
        if (normalized === null) { issue(recordNumber, column, rule.type === 'number' ? 'number_format_not_unambiguous' : 'date_format_or_value_not_valid'); report.summary.retainedAmbiguousValues++; }
        else {
          isText = false;
          if (normalized !== value) {
            change(recordNumber, column, rule.type === 'number' ? 'number_normalization' : 'date_normalization', value, normalized);
            report.summary[rule.type === 'number' ? 'normalizedNumbers' : 'normalizedDates']++;
            value = normalized;
          }
        }
      } else if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(value)) {
        issue(recordNumber, column, 'date_like_text_without_explicit_rule'); report.summary.retainedAmbiguousValues++;
      }
      return protect(value, recordNumber, column, isText);
    });
    const normalizedKey = JSON.stringify(cleaned);
    if (normalizedKeys.has(normalizedKey)) {
      report.normalizedDuplicatesRetained.push({ record: recordNumber, sameOutputAsRecord: normalizedKeys.get(normalizedKey) });
      report.summary.normalizedDuplicateRowsRetained++;
    } else normalizedKeys.set(normalizedKey, recordNumber);
    outputRows.push(cleaned);
  }
  report.output.dataRecords = outputRows.length;
  if (!outputRows.length) report.notes.push('There are no data records to clean.');
  const csv = encodeCsv([outputHeaders, ...outputRows]);
  return { csv, report, textReport: renderCsvReport(report) };
}

export function renderCsvReport(report) {
  const lines = [
    'CSV Starter – Bereinigungsbericht',
    `Grenzen: ${report.limits.maxInputBytes} Bytes, ${report.limits.maxDataRecords} Datensätze, ${report.limits.maxColumns} Spalten.`,
    `Eingang: ${report.input.dataRecords} Datensätze, ${report.input.columns} Spalten, ${report.input.bytes} Bytes.`,
    `Ausgang: ${report.output.dataRecords} Datensätze. UTF-8, Komma, CRLF.`,
    `Äußere Leerzeichen entfernt: ${report.summary.trimmedCells} Zellen.`,
    `Zahlen normalisiert: ${report.summary.normalizedNumbers}; Daten normalisiert: ${report.summary.normalizedDates}.`,
    `Exakte ursprüngliche Dubletten entfernt: ${report.summary.duplicateRowsRemoved}.`,
    `Erst nach Bearbeitung gleiche Datensätze beibehalten: ${report.summary.normalizedDuplicateRowsRetained}.`,
    `Leere Werte beibehalten: ${report.summary.missingValues}; unklare Werte beibehalten/markiert: ${report.summary.retainedAmbiguousValues}.`,
    `Formelverdächtige Textzellen mit zusätzlichem Apostroph geschützt: ${report.summary.formulaProtectedCells}.`,
    `Verworfene Datensätze: ${report.summary.rejectedRows}. Strukturell ungültige Eingaben werden vollständig abgewiesen.`,
    '', 'Änderungen (Datensatz, Spalte, Art, vorher -> nachher):',
    ...report.changes.map((entry) => `${entry.record}, ${entry.column}, ${entry.kind}: ${JSON.stringify(entry.before)} -> ${JSON.stringify(entry.after)}`),
    '', 'Entfernte Dubletten:',
    ...report.duplicatesRemoved.map((entry) => `Datensatz ${entry.record}: identisch mit Datensatz ${entry.identicalToRecord}.`),
    '', 'Beibehaltene Datensätze mit gleichem Bearbeitungsergebnis:',
    ...report.normalizedDuplicatesRetained.map((entry) => `Datensatz ${entry.record}: nach Bearbeitung gleich wie Datensatz ${entry.sameOutputAsRecord}; beide beibehalten.`),
    '', 'Hinweise zu beibehaltenen Werten:',
    ...report.issues.map((entry) => `Datensatz ${entry.record}, Spalte ${entry.column}: ${entry.code}.`),
    '', 'Originaldatei wird nicht verändert. report.json enthält die vollständige maschinenlesbare Änderungsübersicht.',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
