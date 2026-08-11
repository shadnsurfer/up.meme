/**
 * devnet-test-launch.ts — one-shot demo launch on the devnet deployment.
 *
 * Does, in order:
 *   1. attests the deploy wallet on-chain so it can launch with a climb window
 *   2. launches "UP Migration Test" ($UPTEST): 24h climb, 0.1 SOL dev buy
 *   3. proves the gate both ways with throwaway wallets:
 *      unattested buy → must revert (NotAttested); attested buy → succeeds
 *   4. prints the CA (mint) + links for manual browser testing
 *
 * TEST SCAFFOLDING ONLY: attestations here are submitted directly with the
 * attestation authority from server/.env, bypassing the verifier's pump.fun
 * profile check. The on-chain result is identical to a verifier-issued
 * attestation (same PDA, same authority signature) — production launches go
 * through the verifier, which only attests wallets that have a pump.fun
 * profile.
 *
 * Cluster-agnostic despite the filename: the VITE_SOLANA_RPC define picks the
 * cluster (devnet below; https://api.mainnet-beta.solana.com for mainnet), and
 * UPMEME_META_URI overrides the token metadata URI (default: the local stub).
 *
 * Run from anchor/:
 *   npx esbuild scripts/devnet-test-launch.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/upmeme-test-launch.mjs \
 *     --alias:@privy-io/react-auth/solana="$PWD/scripts/e2e-privy-stub.ts" \
 *     --define:import.meta.env.VITE_SOLANA_RPC='"https://api.devnet.solana.com"' \
 *     --define:import.meta.env.VITE_PRIVY_APP_ID=undefined \
 *     --define:import.meta.env.VITE_API_URL='"http://127.0.0.1:8790"' \
 *     --define:import.meta.env.VITE_SOLANA_CHAIN=undefined \
 *     --define:import.meta.env.VITE_SOL_PRICE_USD=undefined
 *   node /tmp/upmeme-test-launch.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountRole,
  address as kitAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit';
import {
  fetchAttestationExists,
  fetchLaunchByMint,
  fetchSolBalance,
  fetchTokenBalance,
  rpc,
} from '../../src/lib/chain';
import { buildBuy, buildLaunch, CU } from '../../src/lib/tx';
import {
  SYSTEM_PROGRAM,
  TOTAL_SUPPLY,
  UP_MEME_PROGRAM,
  VIRTUAL_SOL,
  buyTokensOut,
  ixData,
  pdas,
} from '../../src/lib/upmeme';

const SOL = 1_000_000_000n;
const CLIMB_SECONDS = 86_400n; // 24h — long window for manual multi-wallet testing
const SEED = SOL / 10n; // 0.1 SOL dev buy
const NAME = 'UP Migration Test';
const SYMBOL = 'UPTEST';
const URI = process.env.UPMEME_META_URI ?? 'http://127.0.0.1:8791/meta.json'; // local stub unless overridden
/** expected attestation authority (initialized into the devnet config) */
const EXPECTED_AUTHORITY = kitAddress('FjYoBSRYtsLn87vN6JwHgDAPLJSngMhWf2L7x3NAGAEh');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}
function step(name: string) {
  console.log(`\n[${name}]`);
}

// ---------- tx send (same shape as the e2e harness) ----------
const COMPUTE_BUDGET = kitAddress('ComputeBudget111111111111111111111111111111');
function cuLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data };
}
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
};
function errHaystack(e: unknown): string {
  const parts = [String(e)];
  const json = safeJson(e);
  if (json !== '{}') parts.push(json);
  const ctx = (e as { context?: { logs?: string[] } } | null)?.context;
  if (ctx?.logs) parts.push(ctx.logs.join('\n'));
  return parts.join('\n');
}
async function confirmSig(sig: Signature): Promise<string | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st) {
      if (st.err) return safeJson(st.err);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return null;
    }
    await sleep(500);
  }
  return 'timeout waiting for confirmation';
}
async function sendRaw(
  payer: KeyPairSigner,
  ixs: Instruction[],
  opts: { signers?: KeyPairSigner[]; cu?: number } = {},
): Promise<{ sig: string; err: string | null }> {
  const all = opts.cu ? [cuLimitIx(opts.cu), ...ixs] : ixs;
  try {
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(all, m),
    );
    let tx = compileTransaction(msg);
    tx = await partiallySignTransaction([payer.keyPair, ...(opts.signers ?? []).map((s) => s.keyPair)], tx);
    const sig = getSignatureFromTransaction(tx);
    try {
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true })
        .send();
    } catch (e) {
      return { sig, err: errHaystack(e) };
    }
    return { sig, err: await confirmSig(sig) };
  } catch (e) {
    return { sig: '', err: errHaystack(e) };
  }
}
async function mustSend(payer: KeyPairSigner, ixs: Instruction[], opts: { signers?: KeyPairSigner[]; cu?: number } = {}): Promise<string> {
  const { sig, err } = await sendRaw(payer, ixs, opts);
  if (err) throw new Error(`tx failed:\n${err}`);
  return sig;
}
function transferIx(from: Address, to: Address, lamportsV: bigint): Instruction {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // SystemInstruction::Transfer
  dv.setBigUint64(4, lamportsV, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
/** fresh signer whose 64-byte secret we can persist (recover the test SOL later) */
async function recoverableSigner(): Promise<{ signer: KeyPairSigner; secret58: string }> {
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secret64 = new Uint8Array(64);
  secret64.set(seed);
  secret64.set(getAddressEncoder().encode(signer.address), 32);
  return { signer, secret58: getBase58Decoder().decode(secret64) as string };
}

// ---------- main ----------
async function main() {
  step('wallets');
  const creatorRaw = Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8')),
  );
  const creator = await createKeyPairSignerFromBytes(creatorRaw);

  // attestation authority from server/.env — never logged
  const envText = fs.readFileSync(path.resolve(process.cwd(), '../server/.env'), 'utf8');
  const m = /^ATTESTATION_AUTHORITY_SECRET=(.+)$/m.exec(envText);
  if (!m) throw new Error('ATTESTATION_AUTHORITY_SECRET not found in server/.env');
  const authorityBytes = getBase58Encoder().encode(m[1].trim().replace(/^["']|["']$/g, ''));
  const authority = await createKeyPairSignerFromBytes(authorityBytes);

  console.log(`  creator (deploy wallet): ${creator.address}`);
  console.log(`  attestation authority:   ${authority.address}`);
  check('authority matches devnet config', authority.address === EXPECTED_AUTHORITY, authority.address as string);
  const creatorBal = await fetchSolBalance(creator.address);
  check('creator has enough SOL (need ~0.3)', creatorBal >= SOL / 3n, `${Number(creatorBal) / Number(SOL)} SOL`);

  // --- helper: authority-signed create_attestation (verifier bypass, test-only) ---
  const attestDirect = async (wallet: Address): Promise<void> => {
    const ix: Instruction = {
      programAddress: UP_MEME_PROGRAM,
      accounts: [
        { address: authority.address, role: AccountRole.WRITABLE_SIGNER },
        { address: await pdas.config(), role: AccountRole.READONLY },
        { address: await pdas.attestation(wallet), role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: ixData.createAttestation(wallet),
    };
    await mustSend(authority, [ix]);
  };

  step('creator attestation (required to launch with a climb window)');
  if (await fetchAttestationExists(creator.address)) {
    console.log('  already attested — skipping');
  } else {
    await attestDirect(creator.address);
    check('creator attested on-chain', await fetchAttestationExists(creator.address));
  }

  step(`launch "${NAME}" ($${SYMBOL}) — 24h climb, 0.1 SOL dev buy`);
  const mint = (await recoverableSigner()).signer;
  {
    const ix = await buildLaunch({
      creator: creator.address,
      mint: mint.address,
      name: NAME,
      symbol: SYMBOL,
      uri: URI,
      climbSeconds: CLIMB_SECONDS,
      seedLamports: SEED,
      minSeedTokensOut: 0n,
      creatorAttested: true,
    });
    const sig = await mustSend(creator, [ix], { signers: [mint], cu: CU.launch });
    console.log(`  launch sig: ${sig}`);
  }
  const live = await fetchLaunchByMint(mint.address);
  check('launch readable on-chain', live !== null && live.state.mint === mint.address);
  check('not migrated', live?.state.migrated === false);
  const climbEnd = Number(live!.state.climbEnd);
  console.log(`  climb ends: ${new Date(climbEnd * 1000).toISOString()}`);
  check('climb window ~24h', climbEnd > Date.now() / 1000 + 23 * 3600);
  {
    const expected = buyTokensOut(VIRTUAL_SOL, TOTAL_SUPPLY, SEED);
    const bal = await fetchTokenBalance(mint.address, creator.address);
    check('dev-buy tokens in creator ATA match the curve', bal === expected, `${bal} vs ${expected}`);
  }

  step('gate proof with throwaway wallets');
  const stranger = await recoverableSigner(); // no attestation
  const buyer = await recoverableSigner(); // will be attested
  fs.writeFileSync(
    '/tmp/upmeme-test-wallets.json',
    JSON.stringify(
      {
        stranger: { address: stranger.signer.address, secret: stranger.secret58 },
        buyer: { address: buyer.signer.address, secret: buyer.secret58 },
      },
      null,
      2,
    ),
  );
  console.log('  throwaway wallet secrets saved to /tmp/upmeme-test-wallets.json');
  await mustSend(creator, [
    transferIx(creator.address, stranger.signer.address, SOL / 20n),
    transferIx(creator.address, buyer.signer.address, SOL / 20n),
  ]);
  check('throwaway wallets funded', (await fetchSolBalance(buyer.signer.address)) >= SOL / 20n);

  await attestDirect(buyer.signer.address);
  check('buyer attested on-chain', await fetchAttestationExists(buyer.signer.address));
  check('stranger NOT attested', !(await fetchAttestationExists(stranger.signer.address)));

  {
    const ix = await buildBuy({
      trader: stranger.signer.address,
      mint: mint.address,
      lamports: SOL / 50n,
      minTokensOut: 0n,
      attested: false,
    });
    const { err } = await sendRaw(stranger.signer, [ix], { cu: CU.trade });
    const ok = err !== null && /NotAttested|6000|0x1770/.test(err);
    check('UNattested buy during climb reverts (NotAttested)', ok, ok ? '' : (err ?? 'tx unexpectedly succeeded'));
  }
  {
    const ix = await buildBuy({
      trader: buyer.signer.address,
      mint: mint.address,
      lamports: SOL / 50n,
      minTokensOut: 0n,
      attested: true,
    });
    const sig = await mustSend(buyer.signer, [ix], { cu: CU.trade });
    const bal = await fetchTokenBalance(mint.address, buyer.signer.address);
    check('attested buy during climb succeeds', bal > 0n, `${bal} tokens`);
    console.log(`  attested buy sig: ${sig}`);
  }

  console.log('\n================ TEST LAUNCH READY ================');
  console.log(`  CA (mint):   ${mint.address}`);
  console.log(`  coin page:   http://localhost:5173/coin/${mint.address}`);
  console.log(`  solscan:     https://solscan.io/token/${mint.address}?cluster=devnet`);
  console.log(`  climb ends:  ${new Date(climbEnd * 1000).toISOString()} (buys gated until then)`);
  console.log('===================================================');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('\nLAUNCH SCRIPT ERROR:', e);
  process.exitCode = 1;
});
