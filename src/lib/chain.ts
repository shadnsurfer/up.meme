/**
 * up.meme chain layer — kit RPC client + read-side fetchers.
 *
 * Built on src/lib/upmeme.ts (program ids, PDAs, decoders). Everything here is
 * read-only; transaction building/signing lives in src/lib/tx.ts.
 *
 * Env:
 *   VITE_SOLANA_RPC     — RPC endpoint (default https://api.devnet.solana.com)
 *   VITE_API_URL        — verifier service base (default /api, vite-dev-proxied
 *                         to localhost:8787; see vite.config.ts + attest.ts)
 *   VITE_SOL_PRICE_USD  — cosmetic SOL→USD rate for mcap/fee display (default 200)
 *   VITE_SOLANA_CHAIN   — Privy wallet-standard chain id (default solana:devnet)
 */
import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type ReadonlyUint8Array,
} from '@solana/kit';
import {
  RENT_FLOOR,
  TOTAL_SUPPLY,
  UP_MEME_PROGRAM,
  decodeLaunch,
  decodeTokenAmount,
  pdas,
  reserveSol,
  type LaunchState,
} from './upmeme';

// ---------- env ----------
export const SOLANA_RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? 'https://api.devnet.solana.com';
/** Privy chain id — must match the cluster the program is deployed on */
export const SOLANA_CHAIN = (import.meta.env.VITE_SOLANA_CHAIN as string | undefined) ?? 'solana:devnet';
/**
 * Cosmetic only: mcap/USD figures. The chain only knows lamports — there is no
 * price oracle anywhere in this app.
 */
export const SOL_PRICE_USD = Number(import.meta.env.VITE_SOL_PRICE_USD ?? 200) || 200;

export const rpc = createSolanaRpc(SOLANA_RPC_URL);

// ---------- discriminators (anchor/target/idl/up_meme.json) ----------
/** sha256("account:Launch")[..8] — getProgramAccounts memcmp filter */
const LAUNCH_ACCOUNT_DISC = Uint8Array.from([144, 51, 51, 163, 206, 85, 213, 38]);
/** sha256("global:launch")[..8] — first 8 bytes of the launch ix data (see ixData.launch) */
const LAUNCH_IX_DISC = Uint8Array.from([153, 241, 93, 225, 22, 69, 74, 61]);
const LAUNCH_ACCOUNT_DISC_B58 = getBase58Decoder().decode(LAUNCH_ACCOUNT_DISC) as Base58EncodedBytes;

const b64ToBytes = (s: string): ReadonlyUint8Array => getBase64Encoder().encode(s);
const addrDecoder = getAddressDecoder();

// ---------- types ----------
/** launch args recovered from the launch transaction's instruction data */
export interface LaunchMeta {
  name: string;
  symbol: string;
  uri: string;
  climbSeconds: bigint;
  seedLamports: bigint;
  /** resolved from the uri JSON when it is a fetchable http(s) metadata doc */
  image: string | null;
}

/** a launch account plus the live balances that price its curve */
export interface LiveLaunch {
  /** launch PDA */
  launch: Address;
  state: LaunchState;
  solVaultLamports: bigint | null;
  curveTokenBalance: bigint | null;
  feeVaultLamports: bigint | null;
  meta: LaunchMeta | null;
  /** true once the metadata lookup settled (meta may still be null) */
  metaLoaded: boolean;
}

// ---------- low-level helpers ----------
type EncodedAccount = { data: [string, string]; lamports: bigint; owner: Address } | null;

function accountData(a: EncodedAccount): ReadonlyUint8Array | null {
  if (!a) return null;
  const [data, enc] = a.data;
  return enc === 'base64' ? b64ToBytes(data) : null;
}

/** getMultipleAccounts in RPC-limit-sized chunks, order preserved */
async function getMultiple(addrs: Address[]): Promise<EncodedAccount[]> {
  const out: EncodedAccount[] = [];
  for (let i = 0; i < addrs.length; i += 100) {
    const { value } = await rpc.getMultipleAccounts(addrs.slice(i, i + 100), { encoding: 'base64' }).send();
    out.push(...(value as EncodedAccount[]));
  }
  return out;
}

function withBalances(state: LaunchState, launchAddr: Address, accts: EncodedAccount[]): LiveLaunch {
  const [curve, solVault, feeVault] = accts;
  const curveData = accountData(curve ?? null);
  return {
    launch: launchAddr,
    state,
    curveTokenBalance: curveData && curveData.length >= 72 ? decodeTokenAmount(curveData) : null,
    solVaultLamports: solVault ? solVault.lamports : null,
    feeVaultLamports: feeVault ? feeVault.lamports : null,
    meta: getCachedMeta(state.mint),
    metaLoaded: hasMetaSettled(state.mint),
  };
}

// ---------- fetchers ----------
/** all Launch accounts on the program, with curve/vault balances filled in */
export async function fetchAllLaunches(): Promise<LiveLaunch[]> {
  const accounts = await rpc
    .getProgramAccounts(UP_MEME_PROGRAM, {
      encoding: 'base64',
      filters: [{ memcmp: { offset: 0n, bytes: LAUNCH_ACCOUNT_DISC_B58, encoding: 'base58' } }],
    })
    .send();

  const decoded: { launchAddr: Address; state: LaunchState }[] = [];
  for (const { account, pubkey } of accounts) {
    const data = accountData(account as EncodedAccount);
    if (!data || data.length < 190) continue;
    decoded.push({ launchAddr: pubkey, state: decodeLaunch(data) });
  }

  // curve token account + both SOL vaults per launch, in one batched call
  const addrs = decoded.flatMap(({ state }) => [
    state.curveTokenAccount,
    state.solVault,
    state.feeVault,
  ]);
  const balances = addrs.length > 0 ? await getMultiple(addrs) : [];

  const launches = decoded.map(({ launchAddr, state }, i) =>
    withBalances(state, launchAddr, balances.slice(i * 3, i * 3 + 3)),
  );

  // metadata (name/symbol live in the launch tx, not the account) streams in
  // behind the list; each resolution bumps the shared store via listeners
  for (const l of launches) void ensureMeta(l.state.mint, l.launch);
  return launches;
}

/** one launch by mint address; null when it doesn't exist on-chain */
export async function fetchLaunchByMint(mint: Address): Promise<LiveLaunch | null> {
  const launchAddr = await pdas.launch(mint);
  const { value } = await rpc.getAccountInfo(launchAddr, { encoding: 'base64' }).send();
  const data = accountData(value as EncodedAccount);
  if (!data || data.length < 190) return null;
  const state = decodeLaunch(data);
  const balances = await getMultiple([state.curveTokenAccount, state.solVault, state.feeVault]);
  const live = withBalances(state, launchAddr, balances);
  void ensureMeta(mint, launchAddr);
  return live;
}

/** protocol config (needed for the claim_fees account list) */
export async function fetchConfig(): Promise<{ protocolVault: Address } | null> {
  const configAddr = await pdas.config();
  const { value } = await rpc.getAccountInfo(configAddr, { encoding: 'base64' }).send();
  const data = accountData(value as EncodedAccount);
  if (!data || data.length < 105) return null;
  return { protocolVault: address(addrDecoder.decode(data.subarray(72, 104))) };
}

/** is this wallet attested on-chain? (the climb gate) */
export async function fetchAttestationExists(wallet: Address): Promise<boolean> {
  const att = await pdas.attestation(wallet);
  const { value } = await rpc.getAccountInfo(att, { encoding: 'base64' }).send();
  return value !== null && (value as { owner: Address }).owner === UP_MEME_PROGRAM;
}

/** plain SOL balance of any address */
export async function fetchSolBalance(addr: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(addr).send();
  return value;
}

/** a wallet's token-2022 balance for an up.meme mint (0 when no ATA) */
export async function fetchTokenBalance(mint: Address, owner: Address): Promise<bigint> {
  const ata = await pdas.ata(mint, owner);
  const { value } = await rpc.getAccountInfo(ata, { encoding: 'base64' }).send();
  const data = accountData(value as EncodedAccount);
  return data && data.length >= 72 ? decodeTokenAmount(data) : 0n;
}

// ---------- launch metadata (from the launch tx's instruction data) ----------
const META_LS_PREFIX = 'upmeme:meta:v1:';
const metaCache = new Map<string, LaunchMeta | null>();
const metaInflight = new Map<string, Promise<void>>();
const metaListeners = new Set<() => void>();

/** subscribe to metadata arrivals — used by the shared store to re-render */
export function onMetaSettled(cb: () => void): () => void {
  metaListeners.add(cb);
  return () => metaListeners.delete(cb);
}

function notifyMeta() {
  for (const cb of metaListeners) cb();
}

export function getCachedMeta(mint: Address): LaunchMeta | null {
  const hit = metaCache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const raw = localStorage.getItem(META_LS_PREFIX + mint);
    if (!raw) return null;
    const p = JSON.parse(raw) as { name: string; symbol: string; uri: string; climbSeconds: string; seedLamports: string; image: string | null };
    const meta: LaunchMeta = {
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      climbSeconds: BigInt(p.climbSeconds),
      seedLamports: BigInt(p.seedLamports),
      image: p.image,
    };
    metaCache.set(mint, meta);
    return meta;
  } catch {
    return null;
  }
}

export function hasMetaSettled(mint: Address): boolean {
  if (metaCache.has(mint)) return true;
  try {
    return localStorage.getItem(META_LS_PREFIX + mint) !== null;
  } catch {
    return false;
  }
}

function persistMeta(mint: Address, meta: LaunchMeta) {
  metaCache.set(mint, meta);
  try {
    localStorage.setItem(
      META_LS_PREFIX + mint,
      JSON.stringify({ ...meta, climbSeconds: meta.climbSeconds.toString(), seedLamports: meta.seedLamports.toString() }),
    );
  } catch {
    /* storage unavailable — memory cache still works */
  }
}

/**
 * Pre-seed the metadata cache right after this browser sent a launch — the
 * uploaded image lives nowhere else, so only this browser can show it.
 */
export function seedMetaCache(mint: Address, meta: LaunchMeta) {
  persistMeta(mint, meta);
  notifyMeta();
}

function readBorshString(bytes: ReadonlyUint8Array, off: number): [string, number] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (off + 4 > bytes.length) return null;
  const len = dv.getUint32(off, true);
  if (off + 4 + len > bytes.length) return null;
  return [new TextDecoder().decode(bytes.subarray(off + 4, off + 4 + len)), off + 4 + len];
}

/** decode launch(name, symbol, uri, climb_seconds, seed_lamports, min_seed_tokens_out) */
function parseLaunchIxData(bytes: ReadonlyUint8Array): Omit<LaunchMeta, 'image'> | null {
  for (let i = 0; i < 8; i++) if (bytes[i] !== LAUNCH_IX_DISC[i]) return null;
  let off = 8;
  const name = readBorshString(bytes, off);
  if (!name) return null;
  off = name[1];
  const symbol = readBorshString(bytes, off);
  if (!symbol) return null;
  off = symbol[1];
  const uri = readBorshString(bytes, off);
  if (!uri) return null;
  off = uri[1];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (off + 16 > bytes.length) return null;
  return {
    name: name[0],
    symbol: symbol[0],
    uri: uri[0],
    climbSeconds: dv.getBigUint64(off, true),
    seedLamports: dv.getBigUint64(off + 8, true),
  };
}

/** best-effort image lookup from an http(s) metadata uri; never throws */
async function resolveImage(uri: string): Promise<string | null> {
  if (!/^https?:\/\//.test(uri)) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { image?: unknown };
    return typeof json.image === 'string' && /^(https?:\/\/|data:image\/)/.test(json.image) ? json.image : null;
  } catch {
    return null;
  }
}

/**
 * name/symbol/uri are launch ix args, not account fields — recover them from
 * the launch transaction itself (the oldest tx touching the launch PDA).
 * Cached forever in localStorage: launch metadata is immutable.
 */
export function ensureMeta(mint: Address, launchAddr: Address): Promise<void> {
  if (hasMetaSettled(mint)) return Promise.resolve();
  const inflight = metaInflight.get(mint);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const sigs = await rpc.getSignaturesForAddress(launchAddr, { limit: 1000 }).send();
      const oldest = sigs[sigs.length - 1];
      if (!oldest) return;
      const tx = await rpc
        .getTransaction(oldest.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 })
        .send();
      if (!tx) return;
      const { accountKeys, instructions } = tx.transaction.message;
      for (const ix of instructions) {
        if (!('programIdIndex' in ix)) continue;
        if (accountKeys[ix.programIdIndex] !== UP_MEME_PROGRAM) continue;
        const parsed = parseLaunchIxData(getBase58Encoder().encode(ix.data));
        if (!parsed) continue;
        persistMeta(mint, { ...parsed, image: await resolveImage(parsed.uri) });
        return;
      }
    } catch {
      /* RPC hiccup — retried on next poll cycle */
    } finally {
      metaInflight.delete(mint);
      notifyMeta();
    }
  })();
  metaInflight.set(mint, p);
  return p;
}

// ---------- derived curve/state helpers ----------
/** effective reserves (x = SOL incl. virtual offset, y = tokens on the curve) */
export function curveReserves(l: LiveLaunch): { x: bigint; y: bigint } | null {
  if (l.solVaultLamports === null || l.curveTokenBalance === null || l.curveTokenBalance <= 0n) return null;
  return { x: reserveSol(l.solVaultLamports), y: l.curveTokenBalance };
}

/** SOL per whole token at the current spot price */
export function priceSol(l: LiveLaunch): number | null {
  const r = curveReserves(l);
  if (!r) return null;
  return Number(r.x) / Number(r.y) / 1000; // lamports/raw-unit → SOL/token
}

/** spot mcap in USD (cosmetic — see SOL_PRICE_USD) */
export function mcapUsd(l: LiveLaunch): number | null {
  const r = curveReserves(l);
  if (!r) return null;
  return (Number(r.x) / Number(r.y)) * (Number(TOTAL_SUPPLY) / 1e9) * SOL_PRICE_USD;
}

/** net SOL bought into the curve (above the rent floor) */
export function solRaised(l: LiveLaunch): bigint {
  return l.solVaultLamports !== null && l.solVaultLamports > RENT_FLOOR
    ? l.solVaultLamports - RENT_FLOOR
    : 0n;
}

/** total claimable in the fee vault (splits 50/50 creator/protocol on claim) */
export function feesClaimable(l: LiveLaunch): bigint {
  return l.feeVaultLamports !== null && l.feeVaultLamports > RENT_FLOOR
    ? l.feeVaultLamports - RENT_FLOOR
    : 0n;
}

/** fraction of the supply that has left the curve, 0..1 */
export function soldFraction(l: LiveLaunch): number | null {
  if (l.curveTokenBalance === null) return null;
  return 1 - Number(l.curveTokenBalance) / Number(TOTAL_SUPPLY);
}

/** launch creation time, recoverable only once metadata is loaded */
export function createdAtSeconds(l: LiveLaunch): number | null {
  if (!l.meta) return null;
  return Number(l.state.climbEnd - l.meta.climbSeconds);
}

export function climbEndSeconds(l: LiveLaunch): number {
  return Number(l.state.climbEnd);
}

/** still inside the attestation-gated window */
export function isClimbing(l: LiveLaunch, nowSec: number): boolean {
  return !l.state.migrated && nowSec < climbEndSeconds(l);
}

/** climb over or migrated — transfers are free either way */
export function isOpen(l: LiveLaunch, nowSec: number): boolean {
  return !isClimbing(l, nowSec);
}

export function displayName(l: LiveLaunch): string {
  return l.meta?.name || `${l.state.mint.slice(0, 4)}…${l.state.mint.slice(-4)}`;
}

export function displayTicker(l: LiveLaunch): string {
  return l.meta?.symbol || '···';
}
