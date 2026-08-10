import 'dotenv/config';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import bs58 from 'bs58';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name} — copy .env.example and fill it in`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  /** onchain up_meme program id (placeholder until first deploy) */
  programId: new PublicKey(
    process.env.UP_MEME_PROGRAM_ID ?? 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS',
  ),
  /** base58 secret key of the onchain attestation authority */
  authority: Keypair.fromSecretKey(bs58.decode(required('ATTESTATION_AUTHORITY_SECRET'))),
  pumpfunApi: process.env.PUMPFUN_API_BASE ?? 'https://frontend-api-v3.pump.fun',
  /** how long to cache a positive/negative profile lookup */
  profileCacheTtlMs: Number(process.env.PROFILE_CACHE_TTL_MS ?? 5 * 60 * 1000),
} as const;

export const connection = new Connection(config.rpcUrl, 'confirmed');
