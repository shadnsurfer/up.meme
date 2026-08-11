#!/usr/bin/env bash
# up.meme end-to-end harness: full launch lifecycle through the real client
# code paths (src/lib) and the real verifier server.
#
#   anchor/scripts/e2e-localnet.sh                     # local validator (default)
#   E2E_MODE=devnet E2E_RPC=https://api.devnet.solana.com \
#     anchor/scripts/e2e-localnet.sh                   # real devnet
#
# Devnet mode expects: programs deployed, config initialized, the verifier
# running externally on :8790 (with PUMPFUN_API_BASE=http://127.0.0.1:8791 so
# the harness's profile stub controls who "has a profile"), and enough SOL in
# ~/.config/solana/id.json to fund the throwaway wallets (faucet is bypassed —
# wallets are funded by transfer).
#
# Local mode spins up solana-test-validator with all three programs
# (up_meme, up_meme_hook, cp-amm fixture), bundles scripts/e2e-localnet.ts
# with the frontend libs (Privy aliased to a stub, VITE_* env injected via
# defines), and runs it. Exits nonzero if any check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
ANCHOR_DIR=$(pwd)
REPO_ROOT=$(dirname "$ANCHOR_DIR")
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

LEDGER=/tmp/upmeme-e2e-ledger
RPC="${E2E_RPC:-http://127.0.0.1:8899}"

if [ -z "${E2E_RPC:-}" ]; then
  solana-test-validator --reset --quiet --ledger "$LEDGER" \
    --bpf-program 57RhPQ8nBFrnknZTE4kmm56SSyUA1BysCKA39waoeqaM target/deploy/up_meme.so \
    --bpf-program ws45kVaY6HcPrdrT6UP6WorwpviBPjnJbG7yjSkqeHN target/deploy/up_meme_hook.so \
    --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG tests/fixtures/cp_amm.so &
  VAL=$!
  trap 'kill $VAL 2>/dev/null || true' EXIT

  echo "waiting for validator…"
  for _ in $(seq 1 60); do
    if curl -s http://127.0.0.1:8899 -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; then
      break
    fi
    sleep 1
  done
else
  echo "E2E_RPC set — running against $RPC (no local validator)"
fi

npx esbuild scripts/e2e-localnet.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/upmeme-e2e.mjs \
  --alias:@privy-io/react-auth/solana="$ANCHOR_DIR/scripts/e2e-privy-stub.ts" \
  --define:import.meta.env.VITE_SOLANA_RPC="\"$RPC\"" \
  --define:import.meta.env.VITE_PRIVY_APP_ID=undefined \
  --define:import.meta.env.VITE_API_URL='"http://127.0.0.1:8790"' \
  --define:import.meta.env.VITE_SOLANA_CHAIN=undefined \
  --define:import.meta.env.VITE_SOL_PRICE_USD=undefined

UPMEME_ROOT="$REPO_ROOT" E2E_MODE="${E2E_MODE:-local}" node /tmp/upmeme-e2e.mjs
