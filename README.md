# Mara Merchant Feed client

Node.js client for two deterministic, paid product-catalog services. Upload a non-personal CSV; receive a bounded audit or Google-format RSS/XML with diagnostics. No URL fetching, AI enrichment or Google submission takes place. Google approval is not guaranteed.

| Operation | POST route | Gross fee, including 19% German VAT | Atomic USDC cap |
|---|---|---|---|
| `feed_audit` | `/v1/feeds/audit` | 0.50 USDC | `500000` |
| `feed_prepare` | `/v1/feeds/prepare` | 2.00 USDC | `2000000` |

Payments use native USDC on Base. These are service fees, not advertising spend. A delivered audit containing content errors is a paid result. Preparation can deliver XML explicitly marked `draft` when errors remain. Structural input errors are rejected before payment processing.

## Start without paying

Use Node.js 24. This repository includes a full npm lockfile:

```sh
npm ci --ignore-scripts
node scripts/parts-client.mjs --discover --operation feed_audit
node scripts/parts-client.mjs --discover --operation feed_prepare
```

Discovery reads an unsigned HTTP 402 offer. It needs no signer and makes no payment. An offer alone does not prove that paid checkout is currently enabled.

## Purchase with your own authorized signer

Checkout is limited to businesses established in Germany whose receiving establishment is also in Germany. Supply truthful business billing details and an EOA signing account authorized for that business and wallet. A generic x402/AgentCash automatic-payment wrapper alone is insufficient: checkout also requires the same-wallet signed business purchase declaration.

```js
import { buyFeed } from './scripts/parts-client.mjs';

const caps = Object.freeze({
  feed_audit: '500000',
  feed_prepare: '2000000',
});

// Call only after approving this purchase. Inject your own signing adapter;
// this example does not create an account, load keys or initiate a purchase.
export async function purchaseCatalog({
  operationId = 'feed_audit', productCsv,
  germanBusiness, authorizedSigningAccount,
}) {
  if (!Object.hasOwn(caps, operationId)) throw new Error('Unsupported operation');
  return buyFeed({
    operationId,
    input: { csv: productCsv, delimiter: ',', decimalSeparator: '.' },
    buyer: germanBusiness,
    signer: authorizedSigningAccount,
    maxAmountAtomic: caps[operationId],
  });
}
```

`germanBusiness` must contain the actual `companyName`, `street` including house number, five-digit `postalCode`, `city`, and `country: 'DE'`. Do not use synthetic test addresses for a real purchase. The signer exposes `address`, `signTypedData(args)` and `signMessage(args)`; a caller-owned viem LocalAccount is compatible.

Before the declaration is signed, the client independently reconstructs its complete message and checks the operation, normalized input, origin, resource, native-USDC contract, recipient, fixed fee and spending cap. It uses one payment authorization and does not automatically pay again. Complete signing promptly: the payment authorization normally expires after 60 seconds; the five-minute declaration does not extend it.

## Input and delivery limits

Maximum 1,000 data rows, 1,000,000 UTF-8 CSV bytes, 64 columns and 16,000 Unicode characters per cell. Choose comma, semicolon or tab explicitly; optional `mapping` maps supported attributes to exact source headers. `decimalSeparator` is `.` or `,`; an explicit `currency: 'EUR'` can supply a missing currency suffix without currency conversion.

Direct request JSON is limited to 2,200,000 bytes; free purchase-preparation JSON, including the payment payload and buyer details, to 2,300,000 bytes. Escaping counts toward these limits. Results are limited to 2,000,000 JSON bytes, with at most 500 displayed issues/changes and explicit total/truncation fields. No XLSX, PDF or remote-URL input is supported. Product IDs and row order are preserved; missing facts are not invented. Validation covers documented core rules, not every Merchant Center policy, product category or account condition.

Save the result, returned settlement details and private receipt URL. On **409, 503, a timeout or an uncertain outcome, do not call `buyFeed` again to create a new authorization**. The returned result or error may expose a non-enumerable `retryRequest` containing the original body and signed headers. Keep it private; do not log it. Reuse only that unchanged request for recovery. Identical successful requests can return the cached result for up to one hour without a second charge; afterward the authorization remains spent.

## Contracts and provenance

- [OpenAPI contract](https://mara-x402-csv-api-production.up.railway.app/openapi.json), [purchase instructions](https://mara-x402-csv-api-production.up.railway.app/purchase.json), [terms](https://mara-x402-csv-api-production.up.railway.app/terms) and [privacy](https://mara-x402-csv-api-production.up.railway.app/privacy).
- [Public x402scan listing](https://www.x402scan.com/server/ae649a82-d23a-412e-99ff-0383bff150e6). A listing or usage counter is not evidence of customer demand, revenue or successful live settlement.
- [Provider imprint](https://mara-x402-csv-api-production.up.railway.app/imprint). Contact: [maragncye@gmail.com](mailto:maragncye@gmail.com).

Release **0.5.0** derives from the ten-file public HTTP client distribution, manifest SHA256 `a92d2c66a8cbab268499be841fa4bccf7485cd8df94cf8224bebbc9e71eaba09`. See `PUBLIC-SOURCE-MANIFEST.json`. This repository additionally includes documentation, a license and a full npm lockfile; the HTTP distribution itself pins direct dependencies and does not include that transitive lockfile. The manifest identifies source bytes, not a payment audit. No real mainnet payment has been tested for this release.
