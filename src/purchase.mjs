import { createHash } from 'node:crypto';
import { isAddress, verifyMessage } from 'viem';
import { AgentError } from './errors.mjs';
import { getOperation } from './operations.mjs';

export const PURCHASE_TERMS_VERSION = '2026-11-08.1';
const DECLARATION_KEYS = ['version', 'termsVersion', 'buyer', 'issuedAt', 'expiresAt'];
const BUYER_KEYS = ['companyName', 'street', 'postalCode', 'city', 'country'];
const MAX_HEADER_BYTES = 8192;
const MAX_LIFETIME_MS = 3_600_000;
const MAX_FUTURE_MS = 60_000;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function invalid(message = 'Invalid purchase declaration.') {
  return new AgentError('INVALID_PURCHASE_DECLARATION', message);
}

function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  if (required.some(key => !Object.hasOwn(value, key))
      || Reflect.ownKeys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid();
}

function text(value, maxLength) {
  if (typeof value !== 'string' || !value.isWellFormed() || CONTROL_CHARACTERS.test(value)) throw invalid();
  const normalized = value.normalize('NFC').trim();
  if (normalized.length === 0 || normalized.length > maxLength || value.length > maxLength + 20) throw invalid();
  return normalized;
}

function normalizeDeclaration(value, signed) {
  exactObject(value, signed ? [...DECLARATION_KEYS, 'signature'] : DECLARATION_KEYS, signed ? [] : ['signature']);
  if (value.version !== 1) throw invalid('Unsupported purchase declaration version.');
  if (value.termsVersion !== PURCHASE_TERMS_VERSION) throw invalid('Unsupported purchase terms version.');
  exactObject(value.buyer, BUYER_KEYS);
  const buyer = {
    companyName: text(value.buyer.companyName, 200),
    street: text(value.buyer.street, 200),
    postalCode: text(value.buyer.postalCode, 5),
    city: text(value.buyer.city, 100),
    country: value.buyer.country,
  };
  if (buyer.country !== 'DE' || !/^[0-9]{5}$/.test(buyer.postalCode) || Number(buyer.postalCode) < 1000 || Number(buyer.postalCode) > 99998
      || buyer.companyName.length < 2 || !/\p{L}/u.test(buyer.companyName)
      || !/\p{L}/u.test(buyer.street) || !/[0-9]/.test(buyer.street)
      || (buyer.city.match(/\p{L}/gu)?.length ?? 0) < 2) throw invalid('Provide a plausible German business name and full street/house-number, postal-code and city address.');
  const { issuedAt, expiresAt } = value;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) throw invalid('Purchase declaration lifetime must be positive and at most one hour.');
  if (signed && (typeof value.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(value.signature))) throw invalid('A bounded EOA message signature is required.');
  return { version: 1, termsVersion: PURCHASE_TERMS_VERSION, buyer, issuedAt, expiresAt };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function context(config, identity) {
  if (!config || !identity) throw invalid('Missing purchase binding context.');
  let origin, resource;
  try {
    origin = new URL(config.publicBaseUrl);
    resource = new URL(config.resourceUrl);
  } catch { throw invalid('Invalid purchase service URL.'); }
  const operation=config.operationId===undefined?null:getOperation(config.operationId);
  if(config.operationId!==undefined&&(!operation||config.operationVersion!==operation.version||config.amountAtomic!==operation.amountAtomic))throw invalid('Invalid purchase operation.');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash
      || resource.origin !== origin.origin || resource.pathname !== (operation?.path??'/v1/csv/clean')
      || resource.username || resource.password || resource.search || resource.hash) throw invalid('Invalid purchase service URL.');
  if (!/^eip155:[1-9][0-9]*$/.test(config.network)
      || typeof config.amountAtomic !== 'string' || !/^[1-9][0-9]{0,77}$/.test(config.amountAtomic)
      || BigInt(config.amountAtomic) >= 2n ** 256n) throw invalid('Invalid purchase price or network.');
  for (const address of [config.asset, config.payTo, identity.payer]) {
    if (typeof address !== 'string' || !isAddress(address, { strict: true }) || /^0x0{40}$/i.test(address)) throw invalid('Invalid purchase wallet binding.');
  }
  for (const key of ['paymentKey', 'requestHash', 'authorizationHash']) {
    if (typeof identity[key] !== 'string' || !/^[0-9a-f]{64}$/.test(identity[key])) throw invalid('Invalid purchase request binding.');
  }
  return {
    ...(operation&&{operationId:operation.id,operationVersion:operation.version}),
    serviceOrigin: origin.origin,
    resource: resource.href,
    method: 'POST',
    network: config.network,
    asset: config.asset.toLowerCase(),
    payTo: config.payTo.toLowerCase(),
    amountAtomic: config.amountAtomic,
    assetDecimals: 6,
    payer: identity.payer.toLowerCase(),
    paymentKey: identity.paymentKey,
    requestHash: identity.requestHash,
    authorizationHash: identity.authorizationHash,
  };
}

function message(binding, declaration) {
  const atomic = BigInt(binding.amountAtomic);
  const price = `${atomic / 1_000_000n}.${String(atomic % 1_000_000n).padStart(6, '0')}`;
  const feed=binding.operationId==='feed_audit'||binding.operationId==='feed_prepare';
  return [
    feed?'Mara Feed purchase declaration':binding.operationId?'Mara Parts purchase declaration':'Mara CSV Clean purchase declaration',
    `Terms version: ${PURCHASE_TERMS_VERSION}`,
    `I have read and accept the purchase terms at ${binding.serviceOrigin}/terms with this version and the privacy notice at ${binding.serviceOrigin}/privacy.`,
    'I purchase this service in the course of the business identified below, which is established in Germany.',
    'The establishment receiving this service is in Germany, and this purchase is for its business purposes.',
    'I am authorised to act for that business and to authorise this purchase using the paying wallet identified below.',
    'If an agent submits this purchase, I authorise that agent to act for the identified business and paying wallet within this purchase.',
    `I accept the fixed gross price of ${price} USDC for this one ${feed?'feed service':binding.operationId?'parts service':'CSV'} request, including 19% German VAT. VAT is included, not added to this amount.`,
    'I consent to receiving the invoice electronically as JSON.',
    feed?'The product-feed input submitted for this purchase contains no personal data relating to third parties.':binding.operationId?'The parts input submitted for this purchase contains no personal data relating to third parties.':'The CSV submitted for this purchase contains no personal data relating to third parties.',
    feed?'This declaration is bound only to the service, payment authorisation and product-feed request identified below; it is not a token-transfer authorisation.':binding.operationId?'This declaration is bound only to the service, payment authorisation and parts request identified below; it is not a token-transfer authorisation.':'This declaration is bound only to the service, payment authorisation and CSV request identified below; it is not a token-transfer authorisation.',
    '',
    canonicalJson({ ...binding, declaration }),
  ].join('\n');
}

/** Build the exact EIP-191 text to sign; signature may be omitted here. */
export function purchaseMessage(config, identity, declaration) {
  return message(context(config, identity), normalizeDeclaration(declaration, false));
}

/** Prepare the same normalized declaration and EIP-191 message used by validation. */
export function preparePurchase(config, identity, buyer, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 300_000)) throw invalid('Invalid purchase preparation time.');
  const declaration = normalizeDeclaration({ version: 1, termsVersion: PURCHASE_TERMS_VERSION, buyer, issuedAt: now, expiresAt: now + 300_000 }, false);
  const signedMessage = message(context(config, identity), declaration);
  Object.freeze(declaration.buyer);
  return Object.freeze({ declaration: Object.freeze(declaration), message: signedMessage });
}

/**
 * Local EOA ownership check only: no RPC, facilitator call, token transfer or keys.
 * Business/address statements are declarations, not independently verified facts.
 * The caller must keep this header outside the x402 payment payload/extensions.
 * Freshness may be skipped only when checking the stored declaration of a replay.
 */
export async function validatePurchase(header, config, identity, { now = Date.now(), checkFreshness = true } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || typeof checkFreshness !== 'boolean') throw invalid('Invalid purchase validation options.');
  if (typeof header !== 'string' || header.length === 0 || Buffer.byteLength(header, 'utf8') > MAX_HEADER_BYTES
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw invalid('Purchase header must be bounded canonical base64.');
  let value;
  try {
    const bytes = Buffer.from(header, 'base64');
    if (bytes.toString('base64') !== header) throw new Error();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalid('Purchase header must contain UTF-8 JSON.'); }
  const declaration = normalizeDeclaration(value, true);
  if (checkFreshness && declaration.issuedAt - now > MAX_FUTURE_MS) throw invalid('Purchase declaration was issued too far in the future.');
  if (checkFreshness && declaration.expiresAt <= now) throw invalid('Purchase declaration has expired.');
  const binding = context(config, identity);
  const signedMessage = message(binding, declaration);
  let verified = false;
  try { verified = await verifyMessage({ address: binding.payer, message: signedMessage, signature: value.signature }); }
  catch { /* Do not expose input or signature details in errors. */ }
  if (!verified) throw new AgentError('PURCHASE_SIGNATURE_INVALID', 'Purchase declaration signature does not match the paying EOA wallet and request.');
  return Object.freeze({
    buyer: Object.freeze(declaration.buyer),
    termsVersion: declaration.termsVersion,
    issuedAt: declaration.issuedAt,
    expiresAt: declaration.expiresAt,
    declarationHash: createHash('sha256').update(signedMessage, 'utf8').digest('hex'),
  });
}
