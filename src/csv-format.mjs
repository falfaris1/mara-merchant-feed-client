import { AgentError } from './errors.mjs';

export const CSV_LIMITS = Object.freeze({ maxInputBytes: 100000, maxDataRecords: 100, maxColumns: 8, maxRulesBytes: 16000 });

export function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AgentError('CSV_INVALID_UTF8', 'The input must be valid UTF-8; no replacement or encoding guess is applied.'); }
}

export function parseCsv(text) {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (!text) throw new AgentError('CSV_EMPTY_INPUT', 'The CSV input is empty.');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw new AgentError('CSV_CONTROL_CHARACTER', 'Unsupported control characters were found.');
  const records = [];
  let record = [];
  let field = '';
  let mode = 'start';
  let endedRecord = false;
  const syntax = () => { throw new AgentError('CSV_SYNTAX', `Invalid quoting in CSV record ${records.length + 1}, field ${record.length + 1}.`); };
  const endField = () => {
    record.push(field); field = ''; mode = 'start';
    if (record.length > CSV_LIMITS.maxColumns) throw new AgentError('CSV_COLUMN_LIMIT', 'The CSV exceeds eight columns.');
  };
  const endRecord = () => {
    endField(); records.push(record); record = []; endedRecord = true;
    if (records.length > CSV_LIMITS.maxDataRecords + 1) throw new AgentError('CSV_RECORD_LIMIT', 'The CSV exceeds one header plus 100 data records.');
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (mode === 'quoted') {
      endedRecord = false;
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else mode = 'after-quote';
      } else field += char;
      continue;
    }
    if (char === ',') { endField(); endedRecord = false; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      endRecord(); continue;
    }
    endedRecord = false;
    if (mode === 'after-quote') syntax();
    if (char === '"') {
      if (mode !== 'start') syntax();
      mode = 'quoted';
    } else { field += char; mode = 'unquoted'; }
  }
  if (mode === 'quoted') syntax();
  if (!endedRecord) endRecord();
  const width = records[0].length;
  for (let index = 1; index < records.length; index++) {
    if (records[index].length !== width) throw new AgentError('CSV_COLUMN_COUNT', `CSV record ${index + 1} has a different number of fields from the header. Missing fields are not invented.`);
  }
  return records;
}

export function encodeCsv(records) {
  const field = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${records.map((record) => record.map(field).join(',')).join('\r\n')}\r\n`;
}

export function needsFormulaProtection(value) {
  return /^[\s\u200B\u200C\u200D\u2060\uFEFF]*[=+\-@]/u.test(value);
}
