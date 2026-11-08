import { createHash } from 'node:crypto';
import { AgentError } from './errors.mjs';
import { CSV_LIMITS, parseCsv, needsFormulaProtection } from './csv-format.mjs';
import { validateCsvRules } from './csv-clean.mjs';
import { getOperation, validateOperationInput } from './operations.mjs';

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['csv', 'rules'].includes(key)) || typeof body.csv !== 'string' || !body.csv.isWellFormed()) throw new AgentError('INVALID_INPUT', 'Provide a JSON object with a well-formed Unicode csv string and optional rules.');
  const bytes = Buffer.from(body.csv, 'utf8');
  if (bytes.length > CSV_LIMITS.maxInputBytes) throw new AgentError('CSV_BYTE_LIMIT', 'CSV input must not exceed 100000 UTF-8 bytes.');
  const rules = body.rules === undefined ? { version: 1, columns: {} } : body.rules;
  if (Buffer.byteLength(JSON.stringify(rules)) > CSV_LIMITS.maxRulesBytes) throw new AgentError('CSV_RULE_LIMIT', 'Rules must not exceed 16000 bytes.');
  const records = parseCsv(body.csv);
  const headers = records[0].map(header => header.trim());
  if (headers.some(header => !header)) throw new AgentError('CSV_EMPTY_HEADER', 'CSV headers must be nonempty after trimming.');
  if (new Set(headers).size !== headers.length) throw new AgentError('CSV_DUPLICATE_HEADER', 'CSV headers must be unique after trimming.');
  const protectedHeaders = headers.map(header => needsFormulaProtection(header) ? `'${header}` : header);
  if (new Set(protectedHeaders).size !== headers.length) throw new AgentError('CSV_HEADER_COLLISION', 'Formula protection would collide headers.');
  validateCsvRules(rules, headers);
  return { bytes, rules };
}

// Identity binding only. The official SDK/facilitator performs payment validation.
// An EIP-3009 authorization signs a nonce and transfer, not the HTTP request body.
export function paymentIdentity(header, config, input) {
  const operation=config.operationId===undefined?null:getOperation(config.operationId);
  if(config.operationId!==undefined&&(!operation||config.operationVersion!==operation.version||config.resourceUrl!==config.publicBaseUrl+operation.path||config.amountAtomic!==operation.amountAtomic))throw new Error('Invalid operation payment binding');
  const operationInput=operation?validateOperationInput(operation.id,input):null;
  if (typeof header !== 'string' || header.length > 24000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw new Error('Invalid payment header');
  const decoded = Buffer.from(header, 'base64');
  if (decoded.length > 18000) throw new Error('Payment header too large');
  const payment = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  const accepted = payment.accepted;
  const auth = payment.payload?.authorization;
  if (payment.x402Version !== 2 || !accepted || accepted.scheme !== 'exact' || accepted.network !== config.network
    || typeof accepted.asset !== 'string' || accepted.asset.toLowerCase() !== config.asset.toLowerCase()
    || typeof accepted.payTo !== 'string' || accepted.payTo.toLowerCase() !== config.payTo.toLowerCase()
    || accepted.amount !== config.amountAtomic || !auth
    || !/^0x[0-9a-fA-F]{40}$/.test(auth.from) || typeof auth.to !== 'string' || auth.to.toLowerCase() !== config.payTo.toLowerCase()
    || auth.value !== config.amountAtomic || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)
    || typeof payment.payload.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(payment.payload.signature)) throw new Error('Payment does not match this resource');
  return {
    payer: auth.from.toLowerCase(),
    paymentKey: digest(stableJson([config.network, config.asset.toLowerCase(), auth.from.toLowerCase(), auth.nonce.toLowerCase()])),
    requestHash: digest(stableJson(operation?{bindingVersion:2,method:'POST',resource:config.resourceUrl,operation:operation.id,operationVersion:operation.version,amount:config.amountAtomic,input:operationInput}:{ method: 'POST', resource: config.resourceUrl, amount: config.amountAtomic, csv: input.bytes.toString('utf8'), rules: input.rules })),
    authorizationHash: digest(stableJson(payment)),
  };
}
