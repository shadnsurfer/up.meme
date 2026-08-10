import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { getPumpfunProfile } from './pumpfun.js';
import { hasAttestation, submitAttestation } from './programClient.js';

const app = express();
app.use(express.json());

// --- naive in-memory rate limit: 30 req/min per ip, 5 attest attempts/hr per wallet ---
const buckets = new Map<string, { count: number; resetAt: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, programId: config.programId.toBase58() });
});

/** check a wallet's pump.fun profile (also used by the frontend for display) */
app.get('/profile/:wallet', async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet).toBase58();
    const profile = await getPumpfunProfile(wallet);
    if (!profile) return res.status(404).json({ error: 'no pump.fun profile for this wallet' });
    return res.json({ profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    if (msg.includes('Invalid public key')) return res.status(400).json({ error: 'invalid wallet' });
    return res.status(502).json({ error: msg });
  }
});

/** is this wallet attested onchain? */
app.get('/attest/:wallet', async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    return res.json({ wallet: wallet.toBase58(), attested: await hasAttestation(wallet) });
  } catch {
    return res.status(400).json({ error: 'invalid wallet' });
  }
});

/**
 * request an onchain attestation. verifies the wallet has a pump.fun profile,
 * then the authority submits create_attestation. idempotent.
 */
app.post('/attest', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (limited(`ip:${ip}`, 30, 60_000)) return res.status(429).json({ error: 'rate limited' });

  let wallet: PublicKey;
  try {
    wallet = new PublicKey(String(req.body?.wallet ?? ''));
  } catch {
    return res.status(400).json({ error: 'invalid wallet' });
  }
  const w58 = wallet.toBase58();
  if (limited(`wallet:${w58}`, 5, 60 * 60_000)) {
    return res.status(429).json({ error: 'too many attestation attempts for this wallet' });
  }

  try {
    if (await hasAttestation(wallet)) {
      return res.json({ wallet: w58, attested: true, already: true });
    }

    const profile = await getPumpfunProfile(w58);
    if (!profile) {
      return res
        .status(403)
        .json({ error: 'no pump.fun profile — create one at pump.fun first, then retry' });
    }

    const signature = await submitAttestation(wallet);
    return res.json({ wallet: w58, attested: true, already: false, signature, profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return res.status(502).json({ error: msg });
  }
});

app.listen(config.port, () => {
  console.log(`[verifier] listening on :${config.port}`);
  console.log(`[verifier] program ${config.programId.toBase58()} via ${config.rpcUrl}`);
});
