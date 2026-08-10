# Probe: can up.meme tokens migrate to PumpSwap?

**Verdict: no — `REJECTED_FOR_HOOK_EXT`.**

PumpSwap's `create_pool` rejects any Token-2022 mint that carries a
TransferHook TLV entry — **even a fully disabled one** (`authority=None`,
`program_id=None`) — with Anchor error **6006 `UnsupportedBaseMint`**
(`programs/pump-amm/src/instructions/create_pool.rs:190`). Pool creation itself
is permissionless; the rejection is specifically about the transfer-hook
extension's presence in the mint account.

## Method

The devnet faucet rate-limited this IP, so no txs landed on real devnet.
Instead the probe ran against a local `solana-test-validator` running
**byte-identical clones fetched from devnet**: pump_amm
(`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` + programdata), the pump fee
program, Token-2022, and the live devnet `global_config` (verified
`disable_flags=0x00`). Same binary + same config ⇒ same validation logic.

## Evidence

- Mint with TransferHook TLV, both fields zero (the exact post-migration state
  our tokens would carry) → `create_pool` fails with `0x1776` (6006) at
  `create_pool.rs:190`. Reproduced 3×.
- The both-None state isn't even instruction-constructible today: Token-2022
  rejects `InitializeTransferHook(None, None)` — so no client trick can
  launder a hooked mint into an accepted shape either.
- Controls pass: plain Token-2022 mint → pool created; Token-2022 with
  pump.fun-style MetadataPointer+TokenMetadata → pool created.
- Side observation: non-canonical pools get `coin_creator = 1111...1111`, so
  creator-fee attribution via PumpSwap is unavailable to third-party creators
  regardless.

## Consequence

up.meme migrates to **Meteora DAMM v2 (cp-amm)** instead — see
`programs/up-meme/src/lib.rs` (`migrate`) and the integration tests
(`tests/up-meme.ts`, tests j–l). PumpSwap would only be viable by swapping to
a fresh extension-free mint at graduation, which breaks mint/CA continuity —
rejected.

## Reproduce

```
# needs a funded devnet wallet in probe-wallet.json (gitignored)
npx tsx probe.ts            # main experiment: hook mint + controls
npx tsx probe-metadata.ts   # metadata-only Token-2022 control
npx tsx probe-buy.ts        # buy builder against a control pool
```

Artifacts: `probe.ts`, `probe-metadata.ts`, `probe-buy.ts`, `pump_amm.json`
(official IDL), `both-none-mint.json` (exact both-None mint account image).
