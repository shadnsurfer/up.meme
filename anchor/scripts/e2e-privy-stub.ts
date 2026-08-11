/**
 * esbuild alias target for `@privy-io/react-auth/solana` when bundling the
 * frontend tx/chain libs for the node e2e harness. The hooks are never called
 * (privyEnabled is false under the harness defines) — this only needs to
 * satisfy the module graph.
 */
export function useSignAndSendTransaction(): never {
  throw new Error('privy is stubbed in the node e2e harness');
}
export function useWallets(): never {
  throw new Error('privy is stubbed in the node e2e harness');
}
