/**
 * up.meme end-to-end lifecycle harness — runs the REAL client code paths
 * (src/lib/tx.ts builders, src/lib/chain.ts fetchers, src/lib/attest.ts
 * verifier client) and the REAL verifier server against a local validator
 * with all three programs loaded (up_meme, up_meme_hook, cp-amm fixture).
 *
 * Signing uses CLI/generated keypairs instead of Privy — identical from the
 * program's point of view (tx.ts signs keypair slots first, the wallet fills
 * the rest; here one keypair fills everything). Privy signing itself is
 * browser-only and stays covered by the bundle-level verification noted in
 * src/lib/tx.ts.
 *
 * The pump.fun profile API is stubbed on 127.0.0.1:8791 (creator + buyer have
 * "profiles", stranger/third do not) — the verifier server itself is real.
 *
 * Run via scripts/e2e-localnet.sh (validator lifecycle + bundling). Env:
 *   UPMEME_ROOT — repo root (for spawning server/)
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  lamports,
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
  fetchAllLaunches,
  fetchAttestationExists,
  fetchConfig,
  fetchLaunchByMint,
  fetchSolBalance,
  fetchTokenBalance,
  feesClaimable,
  getCachedMeta,
  rpc,
} from '../../src/lib/chain';
import { buildBuy, buildClaimFees, buildLaunch, buildMigrate, buildSell, CU } from '../../src/lib/tx';
import { ensureAttested, requestAttestation } from '../../src/lib/attest';
import {
  CP_AMM_PROGRAM,
  RENT_FLOOR,
  SYSTEM_PROGRAM,
  UP_MEME_PROGRAM,
  VIRTUAL_SOL,
  WSOL_MINT,
  buyTokensOut,
  cpPdas,
  migrationParams,
  pdas,
  TOTAL_SUPPLY,
} from '../../src/lib/upmeme';

const ROOT = process.env.UPMEME_ROOT ?? path.resolve(process.cwd(), '..');
const VERIFIER_PORT = 8790;
const STUB_PORT = 8791;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = 1_000_000_000n;

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}
function step(name: string) {
  console.log(`\n[${name}]`);
}

// ---------- tx send (CLI keypair stands in for the Privy wallet) ----------
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st) {
      if (st.err) return safeJson(st.err);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return null;
    }
    await sleep(400);
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

async function airdrop(addr: Address, sol: number) {
  const sig = await rpc.requestAirdrop(addr, lamports(BigInt(sol) * SOL)).send();
  const err = await confirmSig(sig);
  if (err) throw new Error(`airdrop failed: ${err}`);
}

// ---------- main ----------
async function main() {
  // --- pump.fun profile stub (creator + buyer get "profiles") ---
  const profiles = new Set<string>();
  const stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url ?? '/', 'http://stub');
    if (u.pathname === '/meta.json') {
      res.end(
        JSON.stringify({
          name: 'E2E Coin',
          symbol: 'E2E',
          image:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        }),
      );
      return;
    }
    const m = /^\/users\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(u.pathname);
    if (m && profiles.has(m[1])) {
      res.end(JSON.stringify({ username: 'e2e-tester', profile_image: null, bio: null, followers: 1, following: 1 }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

  // --- attestation authority + verifier server ---
  // localnet: generate a throwaway authority and spawn the server ourselves.
  // devnet (E2E_MODE=devnet): the program config is already initialized with
  // the authority from server/.env, and the verifier runs as an external
  // process — the harness only drives HTTP + chain against both.
  const DEVNET = process.env.E2E_MODE === 'devnet';
  let serverProc: ChildProcess | null = null;
  let verifierSigner: KeyPairSigner | null = null;
  if (!DEVNET) {
    const verifierSeed = globalThis.crypto.getRandomValues(new Uint8Array(32));
    verifierSigner = await createKeyPairSignerFromPrivateKeyBytes(verifierSeed);
    const secret64 = new Uint8Array(64);
    secret64.set(verifierSeed);
    secret64.set(getAddressEncoder().encode(verifierSigner.address), 32);
    const verifierSecret58 = getBase58Decoder().decode(secret64) as string; // kit v7: decoder = bytes → base58 text

    serverProc = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      env: {
        ...process.env,
        PORT: String(VERIFIER_PORT),
        SOLANA_RPC_URL: 'http://127.0.0.1:8899',
        UP_MEME_PROGRAM_ID: UP_MEME_PROGRAM as string,
        ATTESTATION_AUTHORITY_SECRET: verifierSecret58,
        PUMPFUN_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => process.stdout.write(`[verifier] ${d}`));
    serverProc.stderr.on('data', (d) => process.stdout.write(`[verifier:err] ${d}`));
    process.on('exit', () => {
      try {
        serverProc?.kill();
      } catch {
        /* already gone */
      }
    });
  }

  let protocolVaultAddr: Address = kitAddress('11111111111111111111111111111111'); // replaced in initialize_config step
  try {
    step('verifier up');
    {
      const deadline = Date.now() + 30_000;
      let up = false;
      while (Date.now() < deadline && !up) {
        try {
          up = (await fetch(`http://127.0.0.1:${VERIFIER_PORT}/health`)).ok;
        } catch {
          /* not yet */
        }
        if (!up) await sleep(500);
      }
      check('verifier /health responds', up);
      if (!up) throw new Error('verifier never came up');
    }

    // --- wallets ---
    const adminRaw = Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8')),
    );
    const creator = await createKeyPairSignerFromBytes(adminRaw); // launch creator + cranker
    const buyer = await generateKeyPairSigner();
    const stranger = await generateKeyPairSigner();
    const third = await generateKeyPairSigner();
    profiles.add(creator.address as string);
    profiles.add(buyer.address as string);

    step(DEVNET ? 'fund wallets (transfer from deploy wallet)' : 'fund wallets (localnet airdrops)');
    if (DEVNET) {
      // devnet faucet is unusable — fund the throwaway wallets from the deploy wallet
      const transfer = (to: Address, lamportsV: bigint): Instruction => {
        const data = new Uint8Array(12);
        const dv = new DataView(data.buffer);
        dv.setUint32(0, 2, true); // SystemInstruction::Transfer
        dv.setBigUint64(4, lamportsV, true);
        return {
          programAddress: SYSTEM_PROGRAM,
          accounts: [
            { address: creator.address, role: AccountRole.WRITABLE_SIGNER },
            { address: to, role: AccountRole.WRITABLE },
          ],
          data,
        };
      };
      await mustSend(creator, [
        transfer(buyer.address, 2n * SOL),
        transfer(stranger.address, SOL / 2n),
        transfer(third.address, SOL / 2n),
      ]);
      check('transfers landed', (await fetchSolBalance(buyer.address)) >= 2n * SOL);
    } else {
      await airdrop(creator.address, 30);
      await airdrop(buyer.address, 5);
      await airdrop(stranger.address, 2);
      await airdrop(third.address, 2);
      await airdrop(verifierSigner!.address, 1); // pays rent for attestation PDAs
      check('airdrops landed', (await fetchSolBalance(buyer.address)) >= 5n * SOL);
    }

    // --- config ---
    step(DEVNET ? 'config (already initialized on devnet)' : 'initialize_config (attestation authority = verifier key)');
    if (DEVNET) {
      const cfg = await fetchConfig();
      check('config readable via chain.ts', cfg !== null, cfg?.protocolVault);
      protocolVaultAddr = cfg!.protocolVault;
    } else {
      const disc = createHash('sha256').update('global:initialize_config').digest().subarray(0, 8);
      const protocolVault = await generateKeyPairSigner();
      const data = new Uint8Array(72);
      data.set(disc, 0);
      data.set(getAddressEncoder().encode(verifierSigner!.address), 8);
      data.set(getAddressEncoder().encode(protocolVault.address), 40);
      const initIx: Instruction = {
        programAddress: UP_MEME_PROGRAM,
        accounts: [
          { address: creator.address, role: AccountRole.WRITABLE_SIGNER },
          { address: await pdas.config(), role: AccountRole.WRITABLE },
          { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ],
        data,
      };
      await mustSend(creator, [initIx]);
      const cfg = await fetchConfig();
      check('config readable via chain.ts', cfg?.protocolVault === protocolVault.address, cfg?.protocolVault);
      protocolVaultAddr = protocolVault.address;
    }

    // --- attestation through the REAL verifier server ---
    step('attestations via real verifier (stubbed pump.fun API behind it)');
    await ensureAttested(creator.address);
    check('creator attested on-chain', await fetchAttestationExists(creator.address));
    await ensureAttested(buyer.address);
    check('buyer attested on-chain', await fetchAttestationExists(buyer.address));
    {
      let refused = '';
      try {
        await requestAttestation(stranger.address as string);
      } catch (e) {
        refused = String(e);
      }
      check('stranger (no pump profile) refused by verifier', refused.includes('no pump.fun profile'), refused);
      check('stranger has no on-chain attestation', !(await fetchAttestationExists(stranger.address)));
    }

    // --- launch ---
    step('launch (45s climb, 0.5 SOL seed) via tx.ts buildLaunch');
    const mint = await generateKeyPairSigner();
    const CLIMB = 45n;
    const SEED = SOL / 2n;
    {
      const ix = await buildLaunch({
        creator: creator.address,
        mint: mint.address,
        name: 'E2E Coin',
        symbol: 'E2E',
        uri: `http://127.0.0.1:${STUB_PORT}/meta.json`,
        climbSeconds: CLIMB,
        seedLamports: SEED,
        minSeedTokensOut: 0n,
        creatorAttested: true,
      });
      await mustSend(creator, [ix], { signers: [mint], cu: CU.launch });
    }
    const live0 = await fetchLaunchByMint(mint.address);
    check('launch visible via chain.ts fetchLaunchByMint', live0 !== null && live0.state.mint === mint.address);
    check('not migrated at open', live0?.state.migrated === false);
    {
      const expectedSeed = buyTokensOut(VIRTUAL_SOL, TOTAL_SUPPLY, SEED);
      const creatorBal = await fetchTokenBalance(mint.address, creator.address);
      check('creator seed tokens match the curve', creatorBal === expectedSeed, `${creatorBal} vs ${expectedSeed}`);
    }

    // --- buys during the climb ---
    step('buy by attested wallet during climb via buildBuy');
    {
      const ix = await buildBuy({ trader: buyer.address, mint: mint.address, lamports: SOL / 4n, minTokensOut: 0n, attested: true });
      await mustSend(buyer, [ix], { cu: CU.trade });
      check('buyer received tokens', (await fetchTokenBalance(mint.address, buyer.address)) > 0n);
    }

    step('buy by UNattested wallet during climb must fail');
    {
      const ix = await buildBuy({ trader: stranger.address, mint: mint.address, lamports: SOL / 10n, minTokensOut: 0n, attested: false });
      const { err } = await sendRaw(stranger, [ix], { cu: CU.trade });
      const ok = err !== null && /NotAttested|6000|0x1770/.test(err);
      check('rejected with NotAttested', ok, ok ? '' : (err ?? 'tx unexpectedly succeeded'));
    }

    step('sell during climb (no attestation needed) via buildSell');
    {
      const bal = await fetchTokenBalance(mint.address, buyer.address);
      const half = bal / 2n;
      const ix = await buildSell({ trader: buyer.address, mint: mint.address, tokenAmount: half, minSolOut: 0n, attested: false });
      await mustSend(buyer, [ix], { cu: CU.trade });
      check('half the tokens left the buyer ATA', (await fetchTokenBalance(mint.address, buyer.address)) === bal - half);
    }

    // --- climb lapse, then open access ---
    step('wait for climb to lapse (on-chain clock, not wall clock)');
    {
      // the validator's Clock sysvar is a slot-based estimate that drifts from
      // wall time — poll it directly (unix_timestamp at byte offset 32)
      const CLOCK_SYSVAR = kitAddress('SysvarC1ock11111111111111111111111111111111');
      const onchainNow = async (): Promise<number> => {
        const { value } = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: 'base64' }).send();
        const acct = value as { data: [string, string] } | null;
        const bytes = getBase64Encoder().encode(acct!.data[0]);
        return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(32, true));
      };
      const live = await fetchLaunchByMint(mint.address);
      const climbEnd = Number(live!.state.climbEnd);
      const wallWait = climbEnd - Math.floor(Date.now() / 1000) + 2;
      if (wallWait > 0) await sleep(wallWait * 1000);
      const deadline = Date.now() + 120_000;
      while ((await onchainNow()) < climbEnd && Date.now() < deadline) await sleep(1_000);
      check('on-chain clock passed climb end', (await onchainNow()) >= climbEnd);
    }
    step('unattested buy after climb end via buildBuy');
    {
      const ix = await buildBuy({ trader: third.address, mint: mint.address, lamports: SOL / 10n, minTokensOut: 0n, attested: false });
      await mustSend(third, [ix], { cu: CU.trade });
      check('third wallet bought with no attestation', (await fetchTokenBalance(mint.address, third.address)) > 0n);
    }

    // --- migrate ---
    step('migrate crank via buildMigrate (DAMM v2)');
    {
      const live = await fetchLaunchByMint(mint.address);
      const params = migrationParams(live!.curveTokenBalance!, live!.solVaultLamports!);
      check('migrationParams computed', params !== null && params.liquidity > 0n);
      const nft = await generateKeyPairSigner();
      const ix = await buildMigrate({
        cranker: creator.address,
        mint: mint.address,
        positionNftMint: nft.address,
        liquidity: params!.liquidity,
      });
      await mustSend(creator, [ix], { signers: [nft], cu: CU.migrate });

      const migrated = await fetchLaunchByMint(mint.address);
      check('launch flagged migrated', migrated?.state.migrated === true);
      const pool = await cpPdas.pool(mint.address, WSOL_MINT);
      const { value: poolInfo } = await rpc.getAccountInfo(pool, { encoding: 'base64' }).send();
      check('cp-amm pool exists, owned by cp-amm', poolInfo !== null && poolInfo.owner === CP_AMM_PROGRAM);
      const solVaultLeft = await fetchSolBalance(migrated!.state.solVault);
      check('sol vault back at rent floor', solVaultLeft === RENT_FLOOR, `${solVaultLeft}`);
    }

    // --- curve closed post-migration ---
    step('curve closed after migration');
    {
      const ix = await buildBuy({ trader: third.address, mint: mint.address, lamports: SOL / 100n, minTokensOut: 0n, attested: false });
      const { err } = await sendRaw(third, [ix], { cu: CU.trade });
      const ok = err !== null && /AlreadyMigrated|6009|0x1771/.test(err);
      check('buy rejected with AlreadyMigrated', ok, ok ? '' : (err ?? 'tx unexpectedly succeeded'));
    }

    // --- fee claim ---
    step('claim_fees via buildClaimFees (50/50 split)');
    {
      const live = await fetchLaunchByMint(mint.address);
      const claimable = feesClaimable(live!);
      check('fees accrued from trades', claimable > 0n, `${claimable} lamports`);
      const half = claimable / 2n;
      const creatorBefore = await fetchSolBalance(creator.address);
      const protocolBefore = await fetchSolBalance(protocolVaultAddr);
      const ix = await buildClaimFees({ mint: mint.address, creator: creator.address, protocolVault: protocolVaultAddr });
      await mustSend(creator, [ix], { cu: CU.claimFees });
      const protocolDelta = (await fetchSolBalance(protocolVaultAddr)) - protocolBefore;
      const creatorDelta = (await fetchSolBalance(creator.address)) - creatorBefore;
      if (protocolVaultAddr === creator.address) {
        // devnet placeholder config: both shares land in the deploy wallet —
        // expect the full claimable minus the tx fee
        check(
          'creator+protocol same wallet: full claimable minus tx fee',
          protocolDelta >= claimable - 60_000n && protocolDelta <= claimable,
          `${protocolDelta} vs claimable ${claimable}`,
        );
      } else {
        check('protocol got claimable - half', protocolDelta === claimable - half, `${protocolDelta}`);
        check(
          'creator got ~half (minus tx fee)',
          creatorDelta >= half - 50_000n && creatorDelta <= half,
          `${creatorDelta} vs half ${half}`,
        );
      }
    }

    // --- read-side: list + metadata recovery ---
    step('fetchAllLaunches + launch metadata recovery');
    {
      const list = await fetchAllLaunches();
      check('launch appears in fetchAllLaunches', list.some((l) => l.state.mint === mint.address));
      let meta = getCachedMeta(mint.address);
      for (let i = 0; i < 20 && !meta; i++) {
        await sleep(500);
        meta = getCachedMeta(mint.address);
      }
      check(
        'name/symbol recovered from launch tx, image resolved from uri',
        meta?.name === 'E2E Coin' && meta?.symbol === 'E2E' && (meta?.image?.startsWith('data:image/') ?? false),
        meta ? `${meta.name} / ${meta.symbol}` : 'meta never settled',
      );
    }
  } finally {
    serverProc?.kill();
    stub.close();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('\nHARNESS ERROR:', e);
  process.exitCode = 1;
});
