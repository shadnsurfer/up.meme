/**
 * Client for the up.meme verifier service (server/ — express, default :8787).
 * The server checks the wallet has a pump.fun profile and submits the
 * on-chain create_attestation ix signed by the attestation authority.
 *
 * The express app has no CORS middleware, so in dev the base URL defaults to
 * the same-origin `/api` prefix, proxied to localhost:8787 by vite.config.ts.
 * In production set VITE_API_URL to the deployed verifier origin.
 */
import type { Address } from '@solana/kit';
import { fetchAttestationExists } from './chain';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export interface AttestResult {
  wallet: string;
  attested: boolean;
  already?: boolean;
  signature?: string;
}

/** POST /attest — throws the verifier's own message on rejection */
export async function requestAttestation(wallet: string): Promise<AttestResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet }),
    });
  } catch {
    throw new Error('verifier unreachable — is the up.meme server running?');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<AttestResult> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `verifier returned ${res.status}`);
  return body as AttestResult;
}

export interface PumpfunProfile {
  username: string | null;
  profile_image: string | null;
  bio: string | null;
  followers: number;
  following: number;
}

/** GET /profile/:wallet — null when the wallet has no pump.fun profile */
export async function fetchPumpfunProfile(wallet: string): Promise<PumpfunProfile | null> {
  const res = await fetch(`${API_BASE}/profile/${wallet}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`verifier returned ${res.status}`);
  const body = (await res.json()) as { profile: PumpfunProfile };
  return body.profile;
}

/**
 * Make sure `wallet` is attested on-chain: asks the verifier (which validates
 * the pump.fun profile and submits create_attestation), then polls the chain
 * until the attestation account is visible. Throws with a user-readable
 * message when the verifier refuses (e.g. no pump.fun profile).
 */
export async function ensureAttested(wallet: Address, onStatus?: (s: string) => void): Promise<void> {
  if (await fetchAttestationExists(wallet)) return;
  onStatus?.('checking your pump.fun profile…');
  await requestAttestation(wallet);
  onStatus?.('attestation submitted — waiting for confirmation…');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await fetchAttestationExists(wallet)) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('attestation is not visible on-chain yet — try again in a few seconds');
}
