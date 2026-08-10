# up.meme frontend ↔ chain wiring

How the React app talks to the Solana program and the verifier service.

## Layers

| file | role |
| --- | --- |
| `src/lib/upmeme.ts` | pure foundation (pre-existing): program ids, PDAs, curve/migration math, ix-data serializers, account decoders. No RPC, no React. |
| `src/lib/chain.ts` | read side: kit RPC client, launch/config/attestation/balance fetchers, launch-metadata recovery, derived helpers (mcap, sold %, claimable…). |
| `src/lib/hooks.ts` | React bindings: `useLaunches` (shared polling store), `useLaunch`, `useAttestation`, `useConnectedWallet`, `usePrivyLogin`. |
| `src/lib/tx.ts` | write side: one instruction builder per program instruction (account lists mirror `anchor/programs/up-meme/src/lib.rs` 1:1) + `useUpmemeTx().send(...)`. |
| `src/lib/attest.ts` | verifier-service client (`POST /attest`, `GET /profile/:wallet`) + `ensureAttested` (submit → poll chain until visible). |
| `src/lib/format.ts` | display formatting (usd/SOL/token amounts, address truncation). |

## Env vars

| var | default | notes |
| --- | --- | --- |
| `VITE_PRIVY_APP_ID` | — | pre-existing; without it wallet login is disabled (stub hooks keep pages alive) |
| `VITE_SOLANA_RPC` | `https://api.devnet.solana.com` | reads + blockhash |
| `VITE_SOLANA_CHAIN` | `solana:devnet` | Privy wallet-standard chain id used for signing. **Must match the deployment cluster** — Privy defaults to mainnet. |
| `VITE_API_URL` | `/api` | verifier base URL. In dev, vite proxies `/api` → `http://localhost:8787` (see `vite.config.ts`) because the express service sends no CORS headers. In production set this to the verifier's origin — and note the verifier still needs CORS headers (or a same-origin reverse proxy) for browsers to accept its responses. |
| `VITE_SOL_PRICE_USD` | `200` | **cosmetic only** — converts lamports to USD for mcap/fee displays. There is no price oracle anywhere; the chain only knows lamports. |

## Privy signing approach (verified against installed sources)

`useUpmemeTx().send(instructions, { signers, cuLimit })`:

1. Builds a kit v0 transaction message (fee payer = connected wallet, latest
   blockhash, prepended `ComputeBudgetProgram.setComputeUnitLimit` when
   `cuLimit` is set — data `[2, u32 LE]`, CU values mirror `anchor/tests`).
2. `compileTransaction` → kit fills the signatures map with every required
   signer (`null` = unsigned slot).
3. Local keypairs — the fresh mint on `launch`, the position-NFT mint on
   `migrate` (both `generateKeyPairSigner()`) — sign **first** via kit's
   `partiallySignTransaction`, which fills only their slots.
4. `new Uint8Array(getTransactionEncoder().encode(tx))` → Privy
   `useSignAndSendTransaction().signAndSendTransaction({ transaction, wallet, chain })`.

Why the pre-signed keypair signatures survive, verified in the installed
`@privy-io/react-auth@3.37` / `@privy-io/js-sdk-core` bundles:

- **Embedded (non-TEE) wallets**: Privy decodes the bytes with kit's own
  `getTransactionDecoder`, signs `messageBytes`, and injects the wallet
  signature keyed by address (`ge()` in `dist/esm/useWallets-*.mjs`:
  `o in r.signatures && (r.signatures[o] = s)`), then re-encodes with kit's
  encoder and broadcasts. Both sides use the same codec, so the byte layout
  matches exactly; the fee-payer slot exists because `compileTransaction`
  includes all required signers, and kit's encoder writes 64 zero bytes for
  unsigned slots.
- **TEE ("unified") embedded wallets**: the raw bytes are POSTed to Privy's
  API (`signTransaction` returns `signed_transaction` bytes) — same contract,
  executed server-side. Not locally verifiable; assumed signature-injection.
- **External wallets (Phantom, Solflare, Backpack, …)**: bytes go through the
  wallet-standard `solana:signAndSendTransaction` feature, whose contract is
  to sign the transaction as-is without touching other signatures.

Privy broadcasts and (unless `optimisticBroadcast`) awaits confirmation, and
returns the signature as raw bytes → base58-encoded here for links.

## Launch metadata (name/symbol/image)

The program takes `name`/`symbol`/`uri` as launch args but stores **none** of
them (args are `_`-prefixed in the handler; the mint has no metadata
extension). The frontend recovers them from the launch transaction itself:
`getSignaturesForAddress(launchPda)` → oldest tx → decode the launch ix data.
Results are immutable, so they are cached in `localStorage`
(`upmeme:meta:v1:<mint>`). `image` is resolved by fetching `uri` as JSON when
it is http(s); launches created in this browser also seed the cache directly
(`seedMetaCache`) because the uploaded image exists nowhere else.

## What could NOT be verified without a live deployment

- Any real transaction landing. CU limits (`CU` in `tx.ts`) come from
  `anchor/tests/up-meme.ts` localnet runs, not from mainnet/devnet estimation.
- The TEE embedded-wallet server-side signing path (see above).
- External wallets' fidelity to the wallet-standard sign-as-is contract.
- Metadata recovery assumes the launch tx is within the newest 1000
  signatures touching the launch PDA (every trade references it) — beyond
  that, pagination would be needed. Fine for devnet; note for later.
- `fetchConfig()` (protocol vault) requires `initialize_config` to have run;
  claim-fees builders fail loudly until then.
- The verifier flow was exercised only against a stub HTTP listener (the
  proxy path is confirmed; the real `POST /attest` was not called).
