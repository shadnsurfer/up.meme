# up.meme — Solana programs

Launchpad where every launch opens with a creator-set window (the **climb**)
during which only attested wallets can buy. Attestations are issued off-chain
by the up.meme verifier (pump.fun profile check) and recorded on-chain; when
the curve completes, anyone can crank `migrate` and the token graduates to a
public AMM pool and trades freely everywhere.

## Architecture

Two programs:

- **`up-meme`** (`57RhPQ8nBFrnknZTE4kmm56SSyUA1BysCKA39waoeqaM`) — launches,
  bonding curve (1B supply, 6 decimals, 25 SOL virtual offset), 1% trade fee
  split 50/50 creator/protocol, attestation registry, migration.
- **`up-meme-hook`** (`ws45kVaY6HcPrdrT6UP6WorwpviBPjnJbG7yjSkqeHN`) —
  Token-2022 transfer hook enforcing the climb rules on every transfer.

Every mint is Token-2022 with the transfer-hook extension. During the climb
the hook gates buys to wallets holding a valid attestation PDA signed out by
the on-chain attestation authority. After the climb, curve buys are open.

## Migration: Meteora DAMM v2 (cp-amm)

When the curve fills, the permissionless `migrate` crank:

1. disables the transfer hook irreversibly (`program_id` and authority both
   set to `None`, signed by the launch's vault PDA),
2. creates the DAMM v2 pool + position, locking liquidity permanently.

DAMM v2 was chosen from source-level probing: Raydium CPMM/CLMM hard-reject
hook-extension mints, Orca needs a permissioned TokenBadge, and PumpSwap
rejects any mint carrying a TransferHook TLV with `6006 UnsupportedBaseMint`
(see `probes/pumpswap/README.md`). DAMM v2 accepts the mint once the hook is
fully disabled.

## Tests

`anchor test` runs the full suite (12 tests) on a local validator with the
**real mainnet cp-amm binary** dumped into genesis — launch, attestation
gating, hook enforcement, fee splits, climb lapse, and the complete
migration against the actual DAMM v2 program.

## Deploy (devnet)

```
anchor/scripts/deploy-devnet.sh
```

Deploys both programs and initializes the Config PDA (idempotent). Requires
~5 devnet SOL in `~/.config/solana/id.json`. See
`scripts/initialize-config.ts` for the env knobs (attestation authority,
protocol vault).
