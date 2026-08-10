/** display formatting — chain values in, human strings out. */

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** lamports → "12.34" style SOL string (no symbol) */
export function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / 1e9;
  if (sol >= 1000) return sol.toFixed(0);
  if (sol >= 10) return sol.toFixed(1);
  if (sol >= 0.01) return sol.toFixed(2);
  return sol.toFixed(4);
}

/** raw token units (6 decimals) → compact "9.4M" style string */
export function formatTokens(raw: bigint): string {
  const t = Number(raw) / 1e6;
  if (t >= 1_000_000_000) return `${(t / 1_000_000_000).toFixed(2)}B`;
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}K`;
  return t.toFixed(t >= 1 ? 2 : 4);
}

/** "57Rh…eqaM" style truncation for addresses */
export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
