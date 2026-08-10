export type Launch = {
  id: string;
  name: string;
  ticker: string;
  emoji: string;
  creator: string;
  marketCap: number;
  volume24h: number;
  holders: number;
  /** unix seconds when the climb window ends; null = already migrated */
  climbEndsAt: number | null;
  createdAt: number;
  official?: boolean;
};

const now = Math.floor(Date.now() / 1000);

export const mockLaunches: Launch[] = [
  {
    id: 'up',
    name: 'up token',
    ticker: 'UP',
    emoji: '👁️',
    creator: 'upmeme...dao',
    marketCap: 84200,
    volume24h: 152000,
    holders: 2140,
    climbEndsAt: null,
    createdAt: now - 60 * 60 * 24 * 9,
    official: true,
  },
  {
    id: 'uplink',
    name: 'Uplink',
    ticker: 'UPLINK',
    emoji: '📡',
    creator: '7xKq...9fRt',
    marketCap: 5120,
    volume24h: 2310,
    holders: 84,
    climbEndsAt: now + 60 * 42,
    createdAt: now - 60 * 18,
  },
  {
    id: 'faircat',
    name: 'Fair Cat',
    ticker: 'FAIRC',
    emoji: '🐱',
    creator: 'Bq2v...Lm4x',
    marketCap: 6480,
    volume24h: 5120,
    holders: 231,
    climbEndsAt: now + 60 * 60 * 5 + 60 * 11,
    createdAt: now - 60 * 60 * 2,
  },
  {
    id: 'noscope',
    name: 'No Scope',
    ticker: 'SCOPE',
    emoji: '🎯',
    creator: 'Hj8d...P0qw',
    marketCap: 5030,
    volume24h: 410,
    holders: 19,
    climbEndsAt: now + 60 * 3,
    createdAt: now - 60 * 7,
  },
  {
    id: 'signal',
    name: 'Signal',
    ticker: 'SGNL',
    emoji: '⚡',
    creator: 'Mn5t...Vb8c',
    marketCap: 12900,
    volume24h: 18400,
    holders: 612,
    climbEndsAt: now + 60 * 60 * 26,
    createdAt: now - 60 * 60 * 22,
  },
  {
    id: 'cleanroom',
    name: 'Cleanroom',
    ticker: 'CLEAN',
    emoji: '🧼',
    creator: 'Qw1e...Zx7n',
    marketCap: 5200,
    volume24h: 980,
    holders: 44,
    climbEndsAt: now + 60 * 9,
    createdAt: now - 60 * 51,
  },
  {
    id: 'orbit',
    name: 'Orbit',
    ticker: 'ORBIT',
    emoji: '🪐',
    creator: 'Rt6y...Ui3o',
    marketCap: 34200,
    volume24h: 96100,
    holders: 1480,
    climbEndsAt: null,
    createdAt: now - 60 * 60 * 30,
  },
  {
    id: 'ledger',
    name: 'Ledger Legend',
    ticker: 'LDGR',
    emoji: '📒',
    creator: 'As4f...Gh6j',
    marketCap: 21800,
    volume24h: 45200,
    holders: 890,
    climbEndsAt: null,
    createdAt: now - 60 * 60 * 55,
  },
  {
    id: 'mochi',
    name: 'Mochi',
    ticker: 'MOCHI',
    emoji: '🍡',
    creator: 'Fd3k...Qp2w',
    marketCap: 7600,
    volume24h: 3300,
    holders: 152,
    climbEndsAt: now + 60 * 60 * 14,
    createdAt: now - 60 * 60 * 10,
  },
  {
    id: 'tempo',
    name: 'Tempo',
    ticker: 'TMPO',
    emoji: '⏱️',
    creator: 'Gx8m...Rt5v',
    marketCap: 5400,
    volume24h: 890,
    holders: 61,
    climbEndsAt: now + 60 * 60 * 44,
    createdAt: now - 60 * 60 * 4,
  },
  {
    id: 'vault',
    name: 'Vault Boy',
    ticker: 'VAULT',
    emoji: '🏦',
    creator: 'Kp2n...Mw8s',
    marketCap: 47300,
    volume24h: 61400,
    holders: 1102,
    climbEndsAt: null,
    createdAt: now - 60 * 60 * 70,
  },
  {
    id: 'pearl',
    name: 'Pearl',
    ticker: 'PERL',
    emoji: '🦪',
    creator: 'Lm4q...Zx1d',
    marketCap: 12900,
    volume24h: 8300,
    holders: 340,
    climbEndsAt: null,
    createdAt: now - 60 * 60 * 90,
  },
];

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
