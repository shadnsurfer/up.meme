/**
 * up.meme transaction layer — pure kit instruction builders (account lists
 * mirror the #[derive(Accounts)] structs in anchor/programs/up-meme/src/lib.rs,
 * data comes from ixData in src/lib/upmeme.ts) plus the Privy send path.
 *
 * Signing approach (verified against the installed @privy-io/react-auth 3.37
 * and @privy-io/js-sdk-core sources):
 *   1. We compile a kit v0 transaction message (fee payer = connected wallet).
 *   2. Local keypairs — the fresh mint on launch, the position NFT on migrate —
 *      sign FIRST via kit's partiallySignTransaction, filling their slot in the
 *      signatures map while the wallet's slot stays empty.
 *   3. The encoded bytes go to Privy's useSignAndSendTransaction. Privy's
 *      embedded-wallet flow decodes them with kit's own getTransactionDecoder,
 *      signs the message bytes, and injects the wallet's signature keyed by
 *      address (`ge()` in dist/esm/useWallets-*.mjs) — existing keypair
 *      signatures are preserved byte-for-byte. TEE embedded wallets ship the
 *      raw bytes to Privy's API which returns the signed transaction (same
 *      contract, server-side). External wallets (Phantom/Solflare/…) receive
 *      the bytes through the wallet-standard solana:signAndSendTransaction
 *      feature, whose contract is to sign the transaction as-is.
 *   4. Privy also broadcasts and (by default) awaits confirmation, returning
 *      the signature as raw bytes → base58 here for display.
 *
 * IMPORTANT: `chain` must match the deployment cluster — Privy defaults to
 * solana:mainnet. Driven by VITE_SOLANA_CHAIN (default solana:devnet).
 */
import { useCallback } from 'react';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import type { ConnectedStandardSolanaWallet } from '@privy-io/react-auth/solana';
import {
  ATA_PROGRAM,
  CP_AMM_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  UP_MEME_HOOK_PROGRAM,
  UP_MEME_PROGRAM,
  WSOL_MINT,
  cpPdas,
  ixData,
  pdas,
} from './upmeme';
import { SOLANA_CHAIN, rpc } from './chain';
import { privyEnabled } from './privy';

// ---------- account-meta shorthand ----------
const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const rw = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER });

/** CU limits mirrored from anchor/tests/up-meme.ts */
export const CU = {
  launch: 1_000_000,
  trade: 400_000,
  migrate: 1_400_000,
  claimFees: 200_000,
} as const;

const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');

/** ComputeBudgetProgram.setComputeUnitLimit — data = [2, u32 LE units] */
function cuLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

/** anchor encodes a None Optional account as the program's own id */
const noneAccount = () => UP_MEME_PROGRAM;

// ---------- instruction builders ----------
export async function buildLaunch(p: {
  creator: Address;
  mint: Address;
  name: string;
  symbol: string;
  uri: string;
  climbSeconds: bigint;
  seedLamports: bigint;
  minSeedTokensOut: bigint;
  creatorAttested: boolean;
}): Promise<Instruction> {
  const [launch, vaultAuthority, curve, solVault, feeVault, extraMetas, creatorAta, attestation] =
    await Promise.all([
      pdas.launch(p.mint),
      pdas.vaultAuthority(p.mint),
      pdas.curve(p.mint),
      pdas.solVault(p.mint),
      pdas.feeVault(p.mint),
      pdas.extraMetas(p.mint),
      pdas.ata(p.mint, p.creator),
      pdas.attestation(p.creator),
    ]);
  return {
    programAddress: UP_MEME_PROGRAM,
    // LaunchCtx field order
    accounts: [
      ws(p.creator),
      ws(p.mint),
      rw(launch),
      ro(vaultAuthority),
      rw(curve),
      rw(solVault),
      rw(feeVault),
      rw(extraMetas),
      ro(UP_MEME_HOOK_PROGRAM),
      ro(UP_MEME_PROGRAM),
      rw(creatorAta),
      ro(p.creatorAttested ? attestation : noneAccount()),
      ro(TOKEN_2022_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    data: ixData.launch(p.name, p.symbol, p.uri, p.climbSeconds, p.seedLamports, p.minSeedTokensOut),
  };
}

async function tradeAccounts(trader: Address, mint: Address, attested: boolean) {
  const [launch, curve, traderAta, vaultAuthority, solVault, feeVault, extraMetas, attestation] =
    await Promise.all([
      pdas.launch(mint),
      pdas.curve(mint),
      pdas.ata(mint, trader),
      pdas.vaultAuthority(mint),
      pdas.solVault(mint),
      pdas.feeVault(mint),
      pdas.extraMetas(mint),
      pdas.attestation(trader),
    ]);
  // Trade field order (buy and sell share the struct)
  return [
    ws(trader),
    ro(launch),
    rw(mint),
    rw(curve),
    rw(traderAta),
    ro(vaultAuthority),
    rw(solVault),
    rw(feeVault),
    ro(extraMetas),
    ro(UP_MEME_HOOK_PROGRAM),
    ro(UP_MEME_PROGRAM),
    ro(attested ? attestation : noneAccount()),
    ro(TOKEN_2022_PROGRAM),
    ro(ATA_PROGRAM),
    ro(SYSTEM_PROGRAM),
  ];
}

export async function buildBuy(p: {
  trader: Address;
  mint: Address;
  lamports: bigint;
  minTokensOut: bigint;
  attested: boolean;
}): Promise<Instruction> {
  return {
    programAddress: UP_MEME_PROGRAM,
    accounts: await tradeAccounts(p.trader, p.mint, p.attested),
    data: ixData.buy(p.lamports, p.minTokensOut),
  };
}

export async function buildSell(p: {
  trader: Address;
  mint: Address;
  tokenAmount: bigint;
  minSolOut: bigint;
  attested: boolean;
}): Promise<Instruction> {
  return {
    programAddress: UP_MEME_PROGRAM,
    accounts: await tradeAccounts(p.trader, p.mint, p.attested),
    data: ixData.sell(p.tokenAmount, p.minSolOut),
  };
}

export async function buildClaimFees(p: {
  mint: Address;
  creator: Address;
  protocolVault: Address;
}): Promise<Instruction> {
  const [launch, config, feeVault] = await Promise.all([
    pdas.launch(p.mint),
    pdas.config(),
    pdas.feeVault(p.mint),
  ]);
  return {
    programAddress: UP_MEME_PROGRAM,
    // ClaimFees field order
    accounts: [ro(launch), ro(config), rw(feeVault), rw(p.creator), rw(p.protocolVault), ro(SYSTEM_PROGRAM)],
    data: ixData.claimFees(),
  };
}

export async function buildMigrate(p: {
  cranker: Address;
  mint: Address;
  /** fresh keypair — cp-amm's position NFT mint must sign */
  positionNftMint: Address;
  liquidity: bigint;
}): Promise<Instruction> {
  const [launch, curve, vaultAuthority, solVault, feeVault, poolAuthority, pool, position, positionNftAccount, eventAuthority] =
    await Promise.all([
      pdas.launch(p.mint),
      pdas.curve(p.mint),
      pdas.vaultAuthority(p.mint),
      pdas.solVault(p.mint),
      pdas.feeVault(p.mint),
      cpPdas.poolAuthority(),
      cpPdas.pool(p.mint, WSOL_MINT),
      cpPdas.position(p.positionNftMint),
      cpPdas.positionNftAccount(p.positionNftMint),
      cpPdas.eventAuthority(),
    ]);
  const [wsolAta, tokenAVault, tokenBVault] = await Promise.all([
    pdas.wsolAta(vaultAuthority),
    cpPdas.tokenVault(p.mint, pool),
    cpPdas.tokenVault(WSOL_MINT, pool),
  ]);
  return {
    programAddress: UP_MEME_PROGRAM,
    // Migrate field order
    accounts: [
      ws(p.cranker),
      rw(launch),
      rw(p.mint),
      rw(curve),
      rw(vaultAuthority),
      rw(solVault),
      rw(feeVault),
      rw(wsolAta),
      ro(WSOL_MINT),
      ws(p.positionNftMint),
      rw(positionNftAccount),
      ro(poolAuthority),
      rw(pool),
      rw(position),
      rw(tokenAVault),
      rw(tokenBVault),
      ro(eventAuthority),
      ro(CP_AMM_PROGRAM),
      ro(TOKEN_PROGRAM),
      ro(TOKEN_2022_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
    ],
    data: ixData.migrate(p.liquidity),
  };
}

// ---------- send path (Privy) ----------
export interface SendOptions {
  /** local keypairs that must sign before the wallet does (mint / position NFT) */
  signers?: KeyPairSigner[];
  cuLimit?: number;
}
export type SendFn = (instructions: Instruction[], opts?: SendOptions) => Promise<string>;

export interface UpmemeTx {
  send: SendFn;
  wallet: ConnectedStandardSolanaWallet | null;
}

function useUpmemeTxReal(): UpmemeTx {
  const { wallets } = useSolanaWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = wallets[0] ?? null;

  const send = useCallback<SendFn>(
    async (instructions, opts) => {
      if (!wallet) throw new Error('connect a wallet first');
      const ixs = opts?.cuLimit ? [cuLimitIx(opts.cuLimit), ...instructions] : instructions;
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(wallet.address), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      );
      let tx = compileTransaction(message);
      if (opts?.signers?.length) {
        // local keypairs sign first; Privy fills the wallet slot — see header
        tx = await partiallySignTransaction(
          opts.signers.map((s) => s.keyPair),
          tx,
        );
      }
      const bytes = new Uint8Array(getTransactionEncoder().encode(tx));
      const { signature } = await signAndSendTransaction({
        transaction: bytes,
        wallet,
        chain: SOLANA_CHAIN as 'solana:mainnet' | 'solana:devnet' | 'solana:testnet',
      });
      return getBase58Decoder().decode(signature);
    },
    [wallet, signAndSendTransaction],
  );

  return { send, wallet };
}

function useUpmemeTxStub(): UpmemeTx {
  return {
    send: async () => {
      throw new Error('wallet login is disabled — set VITE_PRIVY_APP_ID');
    },
    wallet: null,
  };
}

export const useUpmemeTx = privyEnabled ? useUpmemeTxReal : useUpmemeTxStub;
