#!/usr/bin/env bash
# One-command devnet deploy for up.meme. Run from anywhere:
#   anchor/scripts/deploy-devnet.sh
#
# Deploys both programs (up_meme + up_meme_hook) with the IDs declared in
# Anchor.toml / declare_id!, then initializes the on-chain Config PDA
# (idempotent — safe to re-run).
#
# Prereq: the deploy wallet (~/.config/solana/id.json) holds >= 5 devnet SOL
# (two program binaries ≈ 632 KB of rent + fees). Uses the binaries in
# target/deploy as-is — run a green `anchor test` before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."

source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

MIN_SOL=5
ADDR=$(solana address)
BAL=$(solana balance --url devnet | awk '{print $1}')
if ! python3 -c "import sys; sys.exit(0 if float('$BAL') >= $MIN_SOL else 1)"; then
  echo "deploy wallet $ADDR has $BAL SOL — need >= $MIN_SOL devnet SOL" >&2
  echo "fund it (https://faucet.solana.com or any devnet-funded wallet) and re-run" >&2
  exit 1
fi

anchor deploy --provider.cluster devnet
npx tsx scripts/initialize-config.ts
