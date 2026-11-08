import { pathToFileURL } from 'node:url';
import { isAddress, getAddress, verifyTypedData } from 'viem';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { getOperation, operationConfig, validateOperationInput } from '../src/operations.mjs';
import { paymentIdentity, stableJson } from '../src/input.mjs';
import { preparePurchase, purchaseMessage, validatePurchase } from '../src/purchase.mjs';

const NETWORK = 'eip155:8453';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x8111b69BC4e0cDBEBb1286a89A50F8ce11B7f43f';
const DEFAULT_BASE = 'https://mara-x402-csv-api-production.up.railway.app';
const OPERATIONS = Object.freeze({
  parts_quote: Object.freeze({ path: '/v1/parts/quote', amount: '30000' }),
  parts_basket: Object.freeze({ path: '/v1/parts/basket', amount: '50000' }),
  parts_search: Object.freeze({ path: '/v1/parts/search', amount: '30000' }),
  feed_audit: Object.freeze({ path: '/v1/feeds/audit', amount: '500000' }),
  feed_prepare: Object.freeze({ path: '/v1/feeds/prepare', amount: '2000000' }),
});
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 64_000;
const MAX_FEED_REQUEST_BYTES = 2_200_000;
const MAX_FEED_PREPARE_BYTES = 2_300_000;
const isFeed = operationId => operationId === 'feed_audit' || operationId === 'feed_prepare';

export class PartsClientError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'PartsClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryWithNewPayment = false;
  }
}
const fail = (code, status) => { throw new PartsClientError(code, status); };
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_BASE_URL'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) fail('INVALID_BASE_URL');
  return url.origin;
}
function amount(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n) fail('INVALID_AMOUNT_CAP');
  return BigInt(value);
}
function configuration(baseUrl, operationId, cap) {
  const pinned = Object.hasOwn(OPERATIONS, operationId) ? OPERATIONS[operationId] : null;
  const operation = getOperation(operationId);
  if (!pinned || !operation || operation.path !== pinned.path || operation.amountAtomic !== pinned.amount) fail('UNSUPPORTED_OPERATION');
  if (BigInt(pinned.amount) > amount(cap)) fail('PRICE_EXCEEDS_CAP');
  return operationConfig({ publicBaseUrl: origin(baseUrl), network: NETWORK, asset: ASSET, payTo: PAY_TO }, operation);
}
function cloneJson(value, code, maximum = MAX_REQUEST_BYTES) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximum) fail(code);
    return JSON.parse(text);
  } catch { fail(code); }
}
async function jsonBody(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))) {
    await response.body?.cancel(); fail('RESPONSE_TOO_LARGE', response.status);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); fail('JSON_RESPONSE_REQUIRED', response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) fail('EMPTY_RESPONSE', response.status);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('RESPONSE_TOO_LARGE', response.status); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error instanceof PartsClientError) throw error;
    fail('INVALID_JSON_RESPONSE', response.status);
  } finally { reader.releaseLock(); }
}
async function post(fetcher, url, body, headers = {}) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body });
  } catch { fail('HTTP_REQUEST_FAILED'); }
  if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url) {
    await response.body?.cancel(); fail('REDIRECT_REFUSED', response.status);
  }
  return response;
}
function challenge(response, body, config, cap) {
  if (response.status !== 402) fail('PAYMENT_OFFER_REQUIRED', response.status);
  const header = response.headers.get('payment-required');
  if (typeof header !== 'string' || header.length === 0 || header.length > 32_000
    || Buffer.from(header, 'base64').toString('base64') !== header) fail('INVALID_PAYMENT_OFFER');
  let required;
  try { required = decodePaymentRequiredHeader(header); } catch { fail('INVALID_PAYMENT_OFFER'); }
  if (required.x402Version !== 2 || required.resource?.url !== config.resourceUrl || !Array.isArray(required.accepts)) fail('INVALID_PAYMENT_OFFER');
  const valid = required.accepts.filter(option => option?.scheme === 'exact' && option.network === NETWORK
    && typeof option.asset === 'string' && option.asset.toLowerCase() === ASSET.toLowerCase()
    && typeof option.payTo === 'string' && option.payTo.toLowerCase() === PAY_TO.toLowerCase()
    && option.amount === config.amountAtomic && BigInt(option.amount) <= amount(cap)
    && Number.isSafeInteger(option.maxTimeoutSeconds) && option.maxTimeoutSeconds >= 1 && option.maxTimeoutSeconds <= 300
    && option.extra?.name === 'USD Coin' && option.extra?.version === '2'
    && (option.extra.assetTransferMethod === undefined || option.extra.assetTransferMethod === 'eip3009'));
  if (valid.length !== 1) fail('PAYMENT_OFFER_NOT_APPROVED');
  const selected = valid[0];
  // Only EIP-3009 for the pinned native USDC. Do not negotiate additional
  // extensions, Permit2 approvals, RPC reads or server-selected EIP-712 domains.
  return { x402Version: 2, resource: { url: config.resourceUrl, mimeType: 'application/json' }, accepts: [{
    scheme: 'exact', network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: selected.amount,
    maxTimeoutSeconds: selected.maxTimeoutSeconds, extra: { name: 'USD Coin', version: '2' },
  }] };
}

/** Unpaid discovery only. No signer, environment keys, balance queries or payment. */
export async function discoverParts({ baseUrl = DEFAULT_BASE, operationId = 'parts_quote', maxAmountAtomic = OPERATIONS[operationId]?.amount, fetcher = fetch } = {}) {
  if (!['parts_quote', 'parts_basket', 'parts_search'].includes(operationId)) fail('UNSUPPORTED_OPERATION');
  return discoverOperation({ baseUrl, operationId, maxAmountAtomic, fetcher });
}

/** Unpaid discovery of one pinned merchant-feed offer. Never signs or pays. */
export async function discoverFeed({ baseUrl = DEFAULT_BASE, operationId = 'feed_audit', maxAmountAtomic = OPERATIONS[operationId]?.amount, fetcher = fetch } = {}) {
  if (!isFeed(operationId)) fail('UNSUPPORTED_OPERATION');
  return discoverOperation({ baseUrl, operationId, maxAmountAtomic, fetcher });
}

async function discoverOperation({ baseUrl, operationId, maxAmountAtomic, fetcher }) {
  const config = configuration(baseUrl, operationId, maxAmountAtomic);
  const response = await post(fetcher, config.resourceUrl, '{}');
  const body = await jsonBody(response);
  const offer = challenge(response, body, config, maxAmountAtomic);
  return { operationId, resourceUrl: config.resourceUrl, amountAtomic: config.amountAtomic, network: NETWORK, asset: ASSET, payTo: PAY_TO, offer };
}

/**
 * Buy exactly once with a customer-owned viem-style LocalAccount/signing adapter:
 * {address, signTypedData, signMessage}. The caller supplies consent and controls
 * the signer. This module never reads an environment/private key or signs for
 * Mara. It performs three HTTP requests and no automatic retry or second payment.
 *
 * Errors after the paid request include a non-enumerable `retryRequest` holding
 * the ORIGINAL authorization/body for explicit recovery. Keep it private; do not
 * log it. Receipt headers report the seller's result, not an independent chain audit.
 */
export async function buyParts({ baseUrl, operationId, input, buyer, signer, maxAmountAtomic, fetcher = fetch }) {
  if (!['parts_quote', 'parts_basket', 'parts_search'].includes(operationId)) fail('UNSUPPORTED_OPERATION');
  return buyOperation({ baseUrl, operationId, input, buyer, signer, maxAmountAtomic, fetcher });
}

/** Same-wallet checkout for a bounded non-personal product CSV, with an explicit spending cap. */
export async function buyFeed({ baseUrl = DEFAULT_BASE, operationId, input, buyer, signer, maxAmountAtomic, fetcher = fetch }) {
  if (!isFeed(operationId)) fail('UNSUPPORTED_OPERATION');
  return buyOperation({ baseUrl, operationId, input, buyer, signer, maxAmountAtomic, fetcher });
}

async function buyOperation({ baseUrl, operationId, input, buyer, signer, maxAmountAtomic, fetcher }) {
  let retryRequest;
  try {
    const config = configuration(baseUrl, operationId, maxAmountAtomic);
    if (!signer || typeof signer.address !== 'string' || !isAddress(signer.address, { strict: true })
      || typeof signer.signTypedData !== 'function' || typeof signer.signMessage !== 'function') fail('CUSTOMER_SIGNER_REQUIRED');
    const address = getAddress(signer.address);
    const typedSigner = { address, signTypedData: args => signer.signTypedData(args) };
    const maximum = isFeed(operationId) ? MAX_FEED_REQUEST_BYTES : MAX_REQUEST_BYTES;
    const normalizedInput = validateOperationInput(operationId, cloneJson(input, 'INVALID_INPUT', maximum));
    const dummy = { payer: address, paymentKey: '0'.repeat(64), requestHash: '0'.repeat(64), authorizationHash: '0'.repeat(64) };
    const normalizedBuyer = preparePurchase(config, dummy, cloneJson(buyer, 'INVALID_BUYER')).declaration.buyer;
    const originalBody = JSON.stringify(normalizedInput);
    if (Buffer.byteLength(originalBody, 'utf8') > maximum) fail('INVALID_INPUT');
    const unpaid = await post(fetcher, config.resourceUrl, originalBody);
    const offer = challenge(unpaid, await jsonBody(unpaid), config, maxAmountAtomic);
    let typedData;
    // SDK 2.30 defaults to a $1 spend limit. Keep an explicit atomic cap for the
    // one prechecked native-USDC operation, including the 2-USDC prepare route.
    const client = new x402Client().setSpendControls({ allowedAssets: [{ network: NETWORK, asset: ASSET, maxAmountPerPayment: config.amountAtomic }] }).register(NETWORK, new ExactEvmScheme({ ...typedSigner,
      signTypedData: args => { typedData = args; return typedSigner.signTypedData(args); },
    }));
    const payment = await client.createPaymentPayload(offer);
    if (!typedData || !await verifyTypedData({ ...typedData, address, signature: payment.payload.signature })) fail('CUSTOMER_PAYMENT_SIGNATURE_INVALID');
    const paymentSignature = encodePaymentSignatureHeader(payment);
    const identity = paymentIdentity(paymentSignature, config, normalizedInput);
    if (identity.payer !== address.toLowerCase()) fail('CUSTOMER_PAYMENT_SIGNATURE_INVALID');
    const prepareBody = JSON.stringify({
      operationId, input: normalizedInput, paymentSignature, buyer: normalizedBuyer,
    });
    if (Buffer.byteLength(prepareBody, 'utf8') > (isFeed(operationId) ? MAX_FEED_PREPARE_BYTES : maximum)) fail('INVALID_INPUT');
    const preparedResponse = await post(fetcher, config.publicBaseUrl + '/v1/purchase-message', prepareBody);
    if (preparedResponse.status !== 200) { await jsonBody(preparedResponse); fail('PURCHASE_PREPARATION_FAILED', preparedResponse.status); }
    const prepared = await jsonBody(preparedResponse);
    let expected;
    try {
      expected = preparePurchase(config, identity, normalizedBuyer, { now: prepared.declaration?.issuedAt });
      if (stableJson(expected.declaration) !== stableJson(prepared.declaration)
        || prepared.declaration.issuedAt > Date.now() + 60_000 || prepared.declaration.expiresAt <= Date.now()
        || prepared.message !== expected.message || prepared.message !== purchaseMessage(config, identity, prepared.declaration)) fail('PURCHASE_MESSAGE_MISMATCH');
    } catch { fail('PURCHASE_MESSAGE_MISMATCH'); }
    const signature = await signer.signMessage({ message: prepared.message });
    const purchaseHeader = encode({ ...expected.declaration, signature });
    await validatePurchase(purchaseHeader, config, identity);
    retryRequest = Object.freeze({ url: config.resourceUrl, method: 'POST', body: originalBody,
      headers: Object.freeze({ 'content-type': 'application/json', 'PAYMENT-SIGNATURE': paymentSignature, 'X-Mara-Purchase': purchaseHeader }) });
    const paid = await post(fetcher, config.resourceUrl, originalBody, retryRequest.headers);
    const result = await jsonBody(paid);
    if (paid.status !== 200) fail('PAID_REQUEST_REJECTED', paid.status);
    let settlement;
    try { settlement = decodePaymentResponseHeader(paid.headers.get('payment-response') ?? ''); } catch { fail('INVALID_SETTLEMENT_RESPONSE', paid.status); }
    const receiptUrl = paid.headers.get('x-mara-receipt');
    if (settlement.success !== true || settlement.network !== NETWORK || settlement.payer?.toLowerCase() !== address.toLowerCase()
      || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)
      || receiptUrl !== `${config.publicBaseUrl}/v1/receipts/MARA-${identity.paymentKey}`) fail('INVALID_SETTLEMENT_RESPONSE', paid.status);
    const answer = { status: paid.status, result, settlement, receiptUrl };
    Object.defineProperty(answer, 'retryRequest', { value: retryRequest, enumerable: false });
    return answer;
  } catch (error) {
    const safe = error instanceof PartsClientError ? error : new PartsClientError('PARTS_CLIENT_FAILED');
    if (retryRequest) Object.defineProperty(safe, 'retryRequest', { value: retryRequest, enumerable: false });
    throw safe;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--discover') fail('CLI_SUPPORTS_UNPAID_DISCOVERY_ONLY');
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
      if (!['--base-url', '--operation'].includes(args[i]) || !args[i + 1]) fail('INVALID_CLI_ARGUMENTS');
      const key = args[i] === '--base-url' ? 'baseUrl' : 'operationId';
      if (Object.hasOwn(options, key)) fail('INVALID_CLI_ARGUMENTS');
      options[key] = args[i + 1];
    }
    console.log(JSON.stringify(await (isFeed(options.operationId) ? discoverFeed(options) : discoverParts(options)), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof PartsClientError ? error.code : 'DISCOVERY_FAILED' }));
    process.exitCode = 1;
  }
}
