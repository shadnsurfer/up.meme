/**
 * up.meme on-chain client foundation — pure, framework-free helpers matching
 * anchor/programs/up-meme (see that program for the source of truth).
 *
 * Everything here is deterministic: program ids, PDA derivations, curve math,
 * migration math, instruction-data serializers, and account decoders.
 * Transaction assembly + Privy signing live in the UI layer on top of this.
 *
 * Conventions: browser-safe (no Node Buffer), bigints for chain values,
 * addresses are @solana/kit `Address` strings.
 */
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';

// ---------- programs ----------
export const UP_MEME_PROGRAM = address('57RhPQ8nBFrnknZTE4kmm56SSyUA1BysCKA39waoeqaM');
export const UP_MEME_HOOK_PROGRAM = address('ws45kVaY6HcPrdrT6UP6WorwpviBPjnJbG7yjSkqeHN');
/** Meteora DAMM v2 — migration target (same address on devnet + mainnet) */
export const CP_AMM_PROGRAM = address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const WSOL_MINT = address('So11111111111111111111111111111111111111112');

// ---------- curve constants (state.rs) ----------
export const TOTAL_SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
export const VIRTUAL_SOL = 25_000_000_000n; // 25 SOL virtual offset (~$5k open)
export const FEE_BPS = 100n; // 1% total, split 50/50 creator/protocol
export const RENT_FLOOR = 890_880n;
export const DECIMALS = 6;

// ---------- migration constants (lib.rs) ----------
export const MIGRATION_RENT_BUDGET = 30_000_000n; // 0.03 SOL
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;

// ---------- instruction discriminators (sha256("global:<name>")[..8]) ----------
const DISC = {
  initializeConfig: [208, 127, 21, 1, 194, 190, 196, 70],
  createAttestation: [49, 24, 67, 80, 12, 249, 96, 239],
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  claimFees: [82, 251, 233, 156, 12, 52, 184, 202],
  migrate: [155, 234, 231, 146, 236, 158, 162, 30],
} as const;

// ---------- little-endian bytes ----------
const te = new TextEncoder();
const addrEncoder = getAddressEncoder();
const addrDecoder = getAddressDecoder();

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function u128le(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(8, v >> 64n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const bytes = te.encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function concat(...parts: ReadonlyUint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- PDAs ----------
const seed = (s: string) => te.encode(s);
const key = (a: Address) => addrEncoder.encode(a);

async function pda(program: Address, seeds: ReadonlyUint8Array[]): Promise<Address> {
  const [addr] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return addr;
}

export const pdas = {
  config: () => pda(UP_MEME_PROGRAM, [seed('config')]),
  attestation: (wallet: Address) => pda(UP_MEME_PROGRAM, [seed('attest'), key(wallet)]),
  launch: (mint: Address) => pda(UP_MEME_PROGRAM, [seed('launch'), key(mint)]),
  vaultAuthority: (mint: Address) => pda(UP_MEME_PROGRAM, [seed('vault'), key(mint)]),
  curve: (mint: Address) => pda(UP_MEME_PROGRAM, [seed('curve'), key(mint)]),
  solVault: (mint: Address) => pda(UP_MEME_PROGRAM, [seed('solvault'), key(mint)]),
  feeVault: (mint: Address) => pda(UP_MEME_PROGRAM, [seed('feevault'), key(mint)]),
  /** extra-account-metas is a PDA of the HOOK program */
  extraMetas: (mint: Address) => pda(UP_MEME_HOOK_PROGRAM, [seed('extra-account-metas'), key(mint)]),
  /** token-2022 ATA for an up.meme mint */
  ata: (mint: Address, owner: Address) =>
    pda(ATA_PROGRAM, [key(owner), key(TOKEN_2022_PROGRAM), key(mint)]),
  /** classic-token ATA (WSOL) — owner may be a PDA */
  wsolAta: (owner: Address) => pda(ATA_PROGRAM, [key(owner), key(TOKEN_PROGRAM), key(WSOL_MINT)]),
};

/** cp-amm orders pool seeds by raw pubkey bytes (max first) */
function orderKeys(a: Address, b: Address): [Address, Address] {
  const ab = key(a);
  const bb = key(b);
  for (let i = 0; i < 32; i++) {
    if (ab[i] !== bb[i]) return ab[i] > bb[i] ? [a, b] : [b, a];
  }
  return [a, b];
}

/** cp-amm (DAMM v2) PDAs */
export const cpPdas = {
  poolAuthority: () => pda(CP_AMM_PROGRAM, [seed('pool_authority')]),
  eventAuthority: () => pda(CP_AMM_PROGRAM, [seed('__event_authority')]),
  pool: (mintA: Address, mintB: Address) => {
    const [a, b] = orderKeys(mintA, mintB);
    return pda(CP_AMM_PROGRAM, [seed('cpool'), key(a), key(b)]);
  },
  position: (positionNftMint: Address) => pda(CP_AMM_PROGRAM, [seed('position'), key(positionNftMint)]),
  positionNftAccount: (positionNftMint: Address) =>
    pda(CP_AMM_PROGRAM, [seed('position_nft_account'), key(positionNftMint)]),
  tokenVault: (mint: Address, pool: Address) =>
    pda(CP_AMM_PROGRAM, [seed('token_vault'), key(mint), key(pool)]),
};

// ---------- curve math (mirrors buy_tokens_out / sell_sol_out) ----------
export const buyTokensOut = (x: bigint, y: bigint, dx: bigint): bigint => y - (x * y) / (x + dx);
export const sellSolOut = (x: bigint, y: bigint, dy: bigint): bigint => x - (x * y) / (y + dy);
/** effective SOL side of the curve */
export const reserveSol = (solVaultLamports: bigint): bigint =>
  VIRTUAL_SOL + (solVaultLamports > RENT_FLOOR ? solVaultLamports - RENT_FLOOR : 0n);

// ---------- migration math (mirrors lib.rs `migrate` exactly) ----------
export function isqrt(n: bigint): bigint {
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const ceilDiv = (x: bigint, d: bigint) => (x + d - 1n) / d;

/**
 * The program computes the opening sqrt price itself from on-chain balances;
 * the client must replicate it exactly, then pick the largest liquidity whose
 * implied deposits fit the curve's balances (the program floor-checks ~99%).
 */
export function migrationParams(curveTokenAmount: bigint, solVaultLamports: bigint) {
  const A = curveTokenAmount;
  const B = solVaultLamports - RENT_FLOOR - MIGRATION_RENT_BUDGET;
  if (A <= 0n || B <= 0n) return null;
  const sqrtPrice = isqrt((B << 64n) / A) << 32n;
  const la = (A * sqrtPrice * MAX_SQRT_PRICE) / (MAX_SQRT_PRICE - sqrtPrice);
  const lb = (B << 128n) / (sqrtPrice - MIN_SQRT_PRICE);
  let liquidity = la < lb ? la : lb;
  for (let i = 0; i < 4; i++) {
    const impliedA = ceilDiv(liquidity * (MAX_SQRT_PRICE - sqrtPrice), sqrtPrice * MAX_SQRT_PRICE);
    const impliedB = ceilDiv(liquidity * (sqrtPrice - MIN_SQRT_PRICE), 1n << 128n);
    if (impliedA <= A && impliedB <= B) break;
    liquidity -= 1n;
  }
  return { sqrtPrice, liquidity, tokenAAmount: A, tokenBAmount: B };
}

// ---------- instruction data serializers ----------
export const ixData = {
  createAttestation: (wallet: Address) => concat(Uint8Array.from(DISC.createAttestation), key(wallet)),
  launch: (
    name: string,
    symbol: string,
    uri: string,
    climbSeconds: bigint,
    seedLamports: bigint,
    minSeedTokensOut: bigint,
  ) =>
    concat(
      Uint8Array.from(DISC.launch),
      borshString(name),
      borshString(symbol),
      borshString(uri),
      u64le(climbSeconds),
      u64le(seedLamports),
      u64le(minSeedTokensOut),
    ),
  buy: (lamports: bigint, minTokensOut: bigint) =>
    concat(Uint8Array.from(DISC.buy), u64le(lamports), u64le(minTokensOut)),
  sell: (tokenAmount: bigint, minSolOut: bigint) =>
    concat(Uint8Array.from(DISC.sell), u64le(tokenAmount), u64le(minSolOut)),
  claimFees: () => Uint8Array.from(DISC.claimFees),
  migrate: (liquidity: bigint) => concat(Uint8Array.from(DISC.migrate), u128le(liquidity)),
};

// ---------- account decoders ----------
export interface LaunchState {
  mint: Address;
  creator: Address;
  curveTokenAccount: Address;
  solVault: Address;
  feeVault: Address;
  climbEnd: bigint;
  virtualSol: bigint;
  migrated: boolean;
}

/** decode a Launch account (8-byte anchor discriminator + Launch::LEN bytes) */
export function decodeLaunch(data: ReadonlyUint8Array): LaunchState {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: address(addrDecoder.decode(data.subarray(8, 40))),
    creator: address(addrDecoder.decode(data.subarray(40, 72))),
    curveTokenAccount: address(addrDecoder.decode(data.subarray(72, 104))),
    solVault: address(addrDecoder.decode(data.subarray(104, 136))),
    feeVault: address(addrDecoder.decode(data.subarray(136, 168))),
    climbEnd: dv.getBigInt64(168, true),
    virtualSol: dv.getBigUint64(176, true),
    // 5 bump bytes at 184..188
    migrated: data[189] !== 0,
  };
}

/** token balance from a raw SPL/token-2022 token account (amount at offset 64) */
export function decodeTokenAmount(data: ReadonlyUint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}
