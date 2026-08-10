import { config } from './config.js';

export type PumpfunProfile = {
  address: string;
  username: string | null;
  profile_image: string | null;
  bio: string | null;
  followers: number;
  following: number;
};

type CacheEntry = { at: number; profile: PumpfunProfile | null };

const cache = new Map<string, CacheEntry>();

/**
 * Look up a wallet's pump.fun profile via their public frontend API.
 * 200 → profile, 404 → no profile. Results cached briefly — profile creation
 * isn't instant on their side either, so negatives are cached too.
 */
export async function getPumpfunProfile(wallet: string): Promise<PumpfunProfile | null> {
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < config.profileCacheTtlMs) return hit.profile;

  const res = await fetch(`${config.pumpfunApi}/users/${wallet}`, {
    headers: { 'User-Agent': 'up.meme-verifier/0.1' },
    signal: AbortSignal.timeout(10_000),
  });

  let profile: PumpfunProfile | null = null;
  if (res.ok) {
    const data = (await res.json()) as Partial<PumpfunProfile>;
    profile = {
      address: wallet,
      username: data.username ?? null,
      profile_image: data.profile_image ?? null,
      bio: data.bio ?? null,
      followers: data.followers ?? 0,
      following: data.following ?? 0,
    };
  } else if (res.status !== 404) {
    // 5xx / rate limits: don't cache, surface as unavailable
    throw new Error(`pump.fun api returned ${res.status}`);
  }

  cache.set(wallet, { at: Date.now(), profile });
  return profile;
}
