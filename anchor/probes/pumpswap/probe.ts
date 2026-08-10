/**
 * PumpSwap devnet probe: does create_pool accept a Token-2022 mint carrying a
 * DISABLED transfer-hook extension (TLV present, authority=None, program_id=None),
 * when called by an arbitrary wallet?
 *
 * Usage:  npx tsx probe.ts            (run from anchor/probes/pumpswap)
 * Env:    RPC_URL (default https://api.devnet.solana.com)
 *
 * NOTE: Token-2022 (current devnet binary) REJECTS TransferHook Initialize with
 * both authority=None and program_id=None ("requires at least an authority or a
 * program id", error 0xc). The closest reachable disabled-hook state is
 * authority=Some, program_id=None — TLV entry present, no hook ever invoked.
 * That is what this probe uses (after documenting the both-None rejection).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  ExtensionType,
  getMintLen,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  getMint,
  getTransferHook,
} from '@solana/spl-token';

// ---------------------------------------------------------------- constants
const DIR = __dirname;
const WALLET_PATH = path.join(DIR, 'probe-wallet.json');
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';

const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = SystemProgram.programId;
const ZERO = new PublicKey('11111111111111111111111111111111'); // all-zero pubkey == COption None

const DISC_CREATE_POOL = Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]);
const DISC_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

const ERRORS: Record<number, string> = {
  6000: 'FeeBasisPointsExceedsMaximum', 6001: 'ZeroBaseAmount', 6002: 'ZeroQuoteAmount',
  6003: 'TooLittlePoolTokenLiquidity', 6004: 'ExceededSlippage', 6005: 'InvalidAdmin',
  6006: 'UnsupportedBaseMint', 6007: 'UnsupportedQuoteMint', 6008: 'InvalidBaseMint',
  6009: 'InvalidQuoteMint', 6010: 'InvalidLpMint', 6011: 'AllProtocolFeeRecipientsShouldBeNonZero',
  6012: 'UnsortedNotUniqueProtocolFeeRecipients', 6013: 'InvalidProtocolFeeRecipient',
  6014: 'InvalidPoolBaseTokenAccount', 6015: 'InvalidPoolQuoteTokenAccount',
  6016: 'BuyMoreBaseAmountThanPoolReserves', 6017: 'DisabledCreatePool', 6018: 'DisabledDeposit',
  6019: 'DisabledWithdraw', 6020: 'DisabledBuy', 6021: 'DisabledSell', 6022: 'SameMint',
  6023: 'Overflow', 6024: 'Truncation', 6025: 'DivisionByZero', 6026: 'NewSizeLessThanCurrentSize',
  6027: 'AccountTypeNotSupported', 6028: 'OnlyCanonicalPumpPoolsCanHaveCoinCreator',
  6041: 'MayhemModeDisabled', 6042: 'OnlyPumpPoolsMayhemMode', 6049: 'CashbackNotEnabled',
  6050: 'OnlyPumpPoolsCashback',
};

const DECIMALS = 6;
const MINT_AMOUNT = 1_000_000n * 10n ** BigInt(DECIMALS); // 1M tokens
const BASE_IN = MINT_AMOUNT;                              // deposit full supply
const QUOTE_IN = 200_000_000n;                            // 0.2 SOL
const WRAP_AMOUNT = 350_000_000n;                         // 0.35 SOL

// ---------------------------------------------------------------- helpers
const connection = new Connection(RPC, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadWallet(): Keypair {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pda(seeds: Buffer[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}
const ataOf = (owner: PublicKey, tokenProgram: PublicKey, mint: PublicKey): PublicKey =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

const [GLOBAL_CONFIG] = [pda([Buffer.from('global_config')], PUMP_AMM)];
const EVENT_AUTHORITY = pda([Buffer.from('__event_authority')], PUMP_AMM);
const GLOBAL_VOLUME_ACC = pda([Buffer.from('global_volume_accumulator')], PUMP_AMM);
const FEE_CONFIG = pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], FEE_PROGRAM);

function poolPda(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(index);
  return pda([Buffer.from('pool'), idx, creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM);
}
const lpMintPda = (pool: PublicKey): PublicKey => pda([Buffer.from('pool_lp_mint'), pool.toBuffer()], PUMP_AMM);
const userVolumeAccPda = (user: PublicKey): PublicKey =>
  pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_AMM);
const creatorVaultAuthorityPda = (coinCreator: PublicKey): PublicKey =>
  pda([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMP_AMM);

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

function decodeErr(logs: string[] | undefined): string {
  if (!logs) return '';
  for (const l of logs) {
    const m = l.match(/custom program error: 0x([0-9a-f]+)/i);
    if (m) {
      const code = parseInt(m[1], 16);
      return `custom error ${code} (${ERRORS[code] ?? 'unknown'})`;
    }
  }
  return '';
}

interface SendResult { ok: boolean; sig?: string; logs?: string[] }

async function sendIx(label: string, ixs: TransactionInstruction[], signers: Keypair[]): Promise<SendResult> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...ixs,
  );
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log(`[${label}] SUCCESS`);
    console.log(`[${label}] sig: ${sig}`);
    return { ok: true, sig };
  } catch (e: any) {
    console.log(`[${label}] FAILED: ${e?.message ?? e}`);
    let logs: string[] | undefined = e?.logs;
    if (!logs && typeof e?.getLogs === 'function') {
      logs = await e.getLogs(connection).catch(() => undefined);
    }
    if (!logs) {
      try {
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signers[0].publicKey;
        tx.sign(...signers);
        const sim = await connection.simulateTransaction(tx);
        logs = sim.value.logs ?? undefined;
      } catch { /* ignore */ }
    }
    const decoded = decodeErr(logs);
    if (decoded) console.log(`[${label}] decoded: ${decoded}`);
    console.log(`[${label}] program logs:`);
    (logs ?? ['<no logs captured>']).forEach((l) => console.log('    ' + l));
    return { ok: false, logs };
  }
}

// ------------------------------------------------- instruction constructors
function createPoolIx(args: {
  index: number;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  coinCreator: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
}): { ix: TransactionInstruction; pool: PublicKey; lpMint: PublicKey } {
  const pool = poolPda(args.index, args.creator, args.baseMint, args.quoteMint);
  const lpMint = lpMintPda(pool);
  const userPoolAta = ataOf(args.creator, TOKEN_2022_PROGRAM_ID, lpMint);
  const poolBaseAta = ataOf(pool, args.baseTokenProgram, args.baseMint);
  const poolQuoteAta = ataOf(pool, args.quoteTokenProgram, args.quoteMint);

  const data = Buffer.alloc(8 + 2 + 8 + 8 + 32 + 1 + 1);
  let o = 0;
  DISC_CREATE_POOL.copy(data, o); o += 8;
  data.writeUInt16LE(args.index, o); o += 2;
  data.writeBigUInt64LE(args.baseAmountIn, o); o += 8;
  data.writeBigUInt64LE(args.quoteAmountIn, o); o += 8;
  args.coinCreator.toBuffer().copy(data, o); o += 32;
  data.writeUInt8(0, o); o += 1; // is_mayhem_mode = false
  data.writeUInt8(0, o); o += 1; // is_cashback_coin = OptionBool(false) / None

  // account order per pump_amm.json create_pool
  const keys = [
    meta(pool, true),                       // pool
    meta(GLOBAL_CONFIG),                    // global_config
    meta(args.creator, true, true),         // creator
    meta(args.baseMint),                    // base_mint
    meta(args.quoteMint),                   // quote_mint
    meta(lpMint, true),                     // lp_mint
    meta(args.userBaseAta, true),           // user_base_token_account
    meta(args.userQuoteAta, true),          // user_quote_token_account
    meta(userPoolAta, true),                // user_pool_token_account
    meta(poolBaseAta, true),                // pool_base_token_account
    meta(poolQuoteAta, true),               // pool_quote_token_account
    meta(SYSTEM),                           // system_program
    meta(TOKEN_2022_PROGRAM_ID),            // token_2022_program
    meta(args.baseTokenProgram),            // base_token_program
    meta(args.quoteTokenProgram),           // quote_token_program
    meta(ATA_PROGRAM),                      // associated_token_program
    meta(EVENT_AUTHORITY),                  // event_authority
    meta(PUMP_AMM),                         // program
  ];
  return { ix: new TransactionInstruction({ keys, programId: PUMP_AMM, data }), pool, lpMint };
}

function buyIx(args: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  protocolFeeRecipient: PublicKey;
  coinCreator: PublicKey;
  baseAmountOut: bigint;
  maxQuoteAmountIn: bigint;
}): TransactionInstruction {
  const userBaseAta = ataOf(args.user, args.baseTokenProgram, args.baseMint);
  const userQuoteAta = ataOf(args.user, args.quoteTokenProgram, args.quoteMint);
  const poolBaseAta = ataOf(args.pool, args.baseTokenProgram, args.baseMint);
  const poolQuoteAta = ataOf(args.pool, args.quoteTokenProgram, args.quoteMint);
  const feeRecipientAta = ataOf(args.protocolFeeRecipient, args.quoteTokenProgram, args.quoteMint);
  const creatorVaultAuth = creatorVaultAuthorityPda(args.coinCreator);
  const creatorVaultAta = ataOf(creatorVaultAuth, args.quoteTokenProgram, args.quoteMint);
  const userVolumeAcc = userVolumeAccPda(args.user);

  const data = Buffer.alloc(8 + 8 + 8 + 1);
  let o = 0;
  DISC_BUY.copy(data, o); o += 8;
  data.writeBigUInt64LE(args.baseAmountOut, o); o += 8;
  data.writeBigUInt64LE(args.maxQuoteAmountIn, o); o += 8;
  data.writeUInt8(0, o); o += 1; // track_volume = OptionBool(false) / None

  // account order per pump_amm.json buy
  const keys = [
    meta(args.pool, true),                  // pool
    meta(args.user, true, true),            // user
    meta(GLOBAL_CONFIG),                    // global_config
    meta(args.baseMint),                    // base_mint
    meta(args.quoteMint),                   // quote_mint
    meta(userBaseAta, true),                // user_base_token_account
    meta(userQuoteAta, true),               // user_quote_token_account
    meta(poolBaseAta, true),                // pool_base_token_account
    meta(poolQuoteAta, true),               // pool_quote_token_account
    meta(args.protocolFeeRecipient),        // protocol_fee_recipient
    meta(feeRecipientAta, true),            // protocol_fee_recipient_token_account
    meta(args.baseTokenProgram),            // base_token_program
    meta(args.quoteTokenProgram),           // quote_token_program
    meta(SYSTEM),                           // system_program
    meta(ATA_PROGRAM),                      // associated_token_program
    meta(EVENT_AUTHORITY),                  // event_authority
    meta(PUMP_AMM),                         // program
    meta(creatorVaultAta, true),            // coin_creator_vault_ata
    meta(creatorVaultAuth),                 // coin_creator_vault_authority
    meta(GLOBAL_VOLUME_ACC),                // global_volume_accumulator
    meta(userVolumeAcc, true),              // user_volume_accumulator
    meta(FEE_CONFIG),                       // fee_config
    meta(FEE_PROGRAM),                      // fee_program
  ];
  return new TransactionInstruction({ keys, programId: PUMP_AMM, data });
}

// ------------------------------------------------------------- mint factory
async function createMint2022WithDisabledHook(wallet: Keypair): Promise<PublicKey> {
  const len = getMintLen([ExtensionType.TransferHook]);
  const rent = await connection.getMinimumBalanceForRentExemption(len);

  // Step 0: document that the BOTH-None init (authority=None, program_id=None) is
  // rejected by the current Token-2022 program — expected failure, do not abort.
  {
    const probeMint = Keypair.generate();
    const r0 = await sendIx('A0: init transfer hook with BOTH fields None (expected to fail)', [
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey, newAccountPubkey: probeMint.publicKey,
        space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(probeMint.publicKey, ZERO, ZERO, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(probeMint.publicKey, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [wallet, probeMint]);
    console.log(`    A0 both-None init ${r0.ok ? 'UNEXPECTEDLY SUCCEEDED' : 'rejected as expected (0xc InvalidInstruction)'} — falling back to authority=Some(wallet), program_id=None (the only reachable disabled-hook state)`);
  }

  // Real probe mint: TransferHook TLV present, program_id = None (disabled),
  // authority = wallet (must be Some; Token-2022 forbids both-None at init).
  const mint = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      space: len,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // DISABLED hook: program_id = None (zero). authority must be non-None at init.
    createInitializeTransferHookInstruction(mint.publicKey, wallet.publicKey, ZERO, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  const r = await sendIx('mintA:create+init (Token-2022, DISABLED transfer hook: program_id=None)', tx.instructions, [wallet, mint]);
  if (!r.ok) throw new Error('mint creation failed');

  const ata = ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mint.publicKey);
  const r2 = await sendIx('mintA:ata+mintTo 1M', [
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, MINT_AMOUNT, [], TOKEN_2022_PROGRAM_ID),
  ], [wallet]);
  if (!r2.ok) throw new Error('mintTo failed');

  // prove the TLV state: extension present, both fields None (all-zero)
  const info = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(info);
  console.log(`    mint: ${mint.publicKey.toBase58()}`);
  console.log(`    account size: ${len} bytes, tlvData length: ${info.tlvData.length} bytes`);
  console.log(`    tlv header (hex): ${Buffer.from(info.tlvData.slice(0, 4)).toString('hex')} (type u16 LE 0e00 = TransferHook(14), len 4800 = 72)`);
  console.log(`    transferHook.authority: ${hook ? hook.authority.toBase58() : '<ext missing>'} (111... = None)`);
  console.log(`    transferHook.programId: ${hook ? hook.programId.toBase58() : '<ext missing>'} (111... = None)`);
  return mint.publicKey;
}

async function createPlain2022Mint(wallet: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([]);
  const rent = await connection.getMinimumBalanceForRentExemption(len);
  const r = await sendIx('mintB:create+init (plain Token-2022, NO extensions)', [
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey,
      space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [wallet, mint]);
  if (!r.ok) throw new Error('control mint creation failed');
  const ata = ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mint.publicKey);
  await sendIx('mintB:ata+mintTo 1M', [
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, MINT_AMOUNT, [], TOKEN_2022_PROGRAM_ID),
  ], [wallet]);
  console.log(`    mint: ${mint.publicKey.toBase58()} (${len} bytes, no extensions)`);
  return mint.publicKey;
}

async function createClassicSplMint(wallet: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([]);
  const rent = await connection.getMinimumBalanceForRentExemption(len);
  const r = await sendIx('mintC:create+init (classic SPL Token)', [
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey,
      space: len, lamports: rent, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, wallet.publicKey, null, TOKEN_PROGRAM_ID),
  ], [wallet, mint]);
  if (!r.ok) throw new Error('classic mint creation failed');
  const ata = ataOf(wallet.publicKey, TOKEN_PROGRAM_ID, mint.publicKey);
  await sendIx('mintC:ata+mintTo 1M', [
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, MINT_AMOUNT, [], TOKEN_PROGRAM_ID),
  ], [wallet]);
  console.log(`    mint: ${mint.publicKey.toBase58()} (classic SPL, ${len} bytes)`);
  return mint.publicKey;
}

async function wrapSol(wallet: Keypair, amount: bigint): Promise<PublicKey> {
  const wsolAta = ataOf(wallet.publicKey, TOKEN_PROGRAM_ID, NATIVE_MINT);
  const ixs: TransactionInstruction[] = [];
  const existing = await connection.getAccountInfo(wsolAta);
  if (!existing) {
    ixs.push(createAssociatedTokenAccountInstruction(wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: amount }));
  ixs.push(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));
  const r = await sendIx(`wrap ${Number(amount) / LAMPORTS_PER_SOL} SOL -> WSOL`, ixs, [wallet]);
  if (!r.ok) throw new Error('wrap failed');
  return wsolAta;
}

// ------------------------------------------------------------------- main
async function main() {
  const wallet = loadWallet();
  console.log('=== PumpSwap devnet probe: disabled-transfer-hook Token-2022 mint ===');
  console.log('rpc:', RPC);
  console.log('wallet:', wallet.publicKey.toBase58());
  const bal = await connection.getBalance(wallet.publicKey);
  console.log('balance:', (bal / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  if (bal < 1.5 * LAMPORTS_PER_SOL) {
    console.error('INSUFFICIENT BALANCE — airdrop first. Exiting.');
    process.exit(2);
  }

  // --- sanity: program + global config on devnet
  const progInfo = await connection.getAccountInfo(PUMP_AMM);
  console.log('pump_amm program deployed on devnet:', !!progInfo, progInfo ? `(executable=${progInfo.executable})` : '');
  if (!progInfo) { console.error('BLOCKED: pump_amm not on devnet'); process.exit(3); }
  const gcInfo = await connection.getAccountInfo(GLOBAL_CONFIG);
  if (!gcInfo) { console.error('BLOCKED: global_config PDA does not exist on devnet'); process.exit(3); }
  const gc = gcInfo.data;
  const admin = new PublicKey(gc.subarray(8, 40));
  const disableFlags = gc[56];
  const recipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) recipients.push(new PublicKey(gc.subarray(57 + i * 32, 57 + (i + 1) * 32)));
  console.log('global_config:', GLOBAL_CONFIG.toBase58());
  console.log('  admin:', admin.toBase58());
  console.log(`  disable_flags: 0x${disableFlags.toString(16).padStart(2, '0')} (bit0 create_pool=${(disableFlags & 1) ? 'DISABLED' : 'enabled'}, bit3 buy=${(disableFlags & 8) ? 'DISABLED' : 'enabled'})`);
  console.log('  protocol_fee_recipients[0]:', recipients[0].toBase58());
  const feeProgInfo = await connection.getAccountInfo(FEE_PROGRAM);
  console.log('fee program deployed on devnet:', !!feeProgInfo, feeProgInfo ? `(executable=${feeProgInfo.executable})` : '');
  console.log('fee_config exists:', !!(await connection.getAccountInfo(FEE_CONFIG)));

  // --- Phase A: hook mint
  console.log('\n--- Phase A: Token-2022 mint with DISABLED transfer hook ---');
  let mintA: PublicKey;
  let indexA = 0;
  if (process.env.FIXED_MINT) {
    // Use a pre-existing mint account (validator-injected both-None TLV state:
    // TransferHook extension present, authority=None, program_id=None).
    mintA = new PublicKey(process.env.FIXED_MINT);
    indexA = Number(process.env.INDEX ?? 3);
    const info = await getMint(connection, mintA, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(info);
    console.log('    using FIXED_MINT:', mintA.toBase58());
    console.log(`    tlv header (hex): ${Buffer.from(info.tlvData.slice(0, 4)).toString('hex')} (0e00 = TransferHook(14), 4000 = len 64)`);
    console.log(`    transferHook.authority: ${hook ? hook.authority.toBase58() : '<ext missing>'} (111... = None)`);
    console.log(`    transferHook.programId: ${hook ? hook.programId.toBase58() : '<ext missing>'} (111... = None)`);
    if (!hook) throw new Error('FIXED_MINT has no transfer hook extension');
    const ata = ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mintA);
    const ixs: TransactionInstruction[] = [];
    if (!(await connection.getAccountInfo(ata))) {
      ixs.push(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mintA, TOKEN_2022_PROGRAM_ID));
    }
    ixs.push(createMintToInstruction(mintA, ata, wallet.publicKey, MINT_AMOUNT, [], TOKEN_2022_PROGRAM_ID));
    const rr = await sendIx('mintA(fixed):ata+mintTo 1M', ixs, [wallet]);
    if (!rr.ok) throw new Error('mintTo (fixed mint) failed');
  } else {
    mintA = await createMint2022WithDisabledHook(wallet);
  }
  const userBaseAtaA = ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mintA);
  await sleep(800);

  // --- Phase B: WSOL
  console.log('\n--- Phase B: wrap SOL ---');
  const wsolAta = await wrapSol(wallet, WRAP_AMOUNT);
  await sleep(800);

  // --- Phase C: create_pool with hook mint
  console.log('\n--- Phase C: create_pool (base = hook mint, quote = WSOL) ---');
  const { ix: cpIx, pool: poolA, lpMint: lpMintA } = createPoolIx({
    index: indexA,
    baseAmountIn: BASE_IN,
    quoteAmountIn: QUOTE_IN,
    coinCreator: wallet.publicKey,
    creator: wallet.publicKey,
    baseMint: mintA,
    quoteMint: NATIVE_MINT,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    userBaseAta: userBaseAtaA,
    userQuoteAta: wsolAta,
  });
  console.log('    pool PDA:', poolA.toBase58(), ' lp_mint PDA:', lpMintA.toBase58(), ' index:', indexA);
  const createRes = await sendIx('create_pool#1 (hook mint)', [cpIx], [wallet]);

  if (createRes.ok) {
    // --- Phase D: buy swap
    console.log('\n--- Phase D: buy swap against the new pool ---');
    await sleep(1000);
    const poolInfo = await connection.getAccountInfo(poolA);
    if (poolInfo) {
      const lpSupply = poolInfo.data.readBigUInt64LE(203);
      console.log('    pool account exists, lp_supply:', lpSupply.toString());
    }
    const poolBaseAta = ataOf(poolA, TOKEN_2022_PROGRAM_ID, mintA);
    const poolQuoteAta = ataOf(poolA, TOKEN_PROGRAM_ID, NATIVE_MINT);
    const qBefore = await connection.getTokenAccountBalance(poolQuoteAta).catch(() => null);
    console.log('    pool quote vault before buy:', qBefore?.value?.amount ?? '?');
    const buy = buyIx({
      pool: poolA,
      user: wallet.publicKey,
      baseMint: mintA,
      quoteMint: NATIVE_MINT,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      protocolFeeRecipient: recipients[0],
      coinCreator: wallet.publicKey,
      baseAmountOut: 1_000n * 10n ** BigInt(DECIMALS), // buy 1000 tokens
      maxQuoteAmountIn: 5_000_000n,                     // max 0.005 SOL
    });
    const buyRes = await sendIx('buy 1000 tokens', [buy], [wallet]);
    const qAfter = await connection.getTokenAccountBalance(poolQuoteAta).catch(() => null);
    console.log('    pool quote vault after buy:', qAfter?.value?.amount ?? '?');
    console.log('\n================= SUMMARY =================');
    console.log('PRIMARY RESULT: create_pool with disabled-hook Token-2022 mint SUCCEEDED');
    console.log('  pool:        ', poolA.toBase58());
    console.log('  base mint:   ', mintA.toBase58());
    console.log('  create_pool sig:', createRes.sig);
    console.log('  buy swap:', buyRes.ok ? `SUCCESS sig=${buyRes.sig}` : 'FAILED (see logs above)');
    return;
  }

  // --- Phase E: controls
  console.log('\n--- Phase E: CONTROL 1 — plain Token-2022 mint, no extensions ---');
  await sleep(1000);
  const mintB = await createPlain2022Mint(wallet);
  const wsolAtaB = await wrapSol(wallet, 60_000_000n);
  const { ix: cpB, pool: poolB } = createPoolIx({
    index: 1, baseAmountIn: BASE_IN, quoteAmountIn: 50_000_000n,
    coinCreator: wallet.publicKey, creator: wallet.publicKey,
    baseMint: mintB, quoteMint: NATIVE_MINT,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
    userBaseAta: ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mintB), userQuoteAta: wsolAtaB,
  });
  console.log('    pool PDA:', poolB.toBase58());
  const resB = await sendIx('create_pool#control1 (plain 2022)', [cpB], [wallet]);

  let resC: SendResult | null = null;
  if (!resB.ok) {
    console.log('\n--- Phase E: CONTROL 2 — classic SPL Token mint ---');
    await sleep(1000);
    const mintC = await createClassicSplMint(wallet);
    const { ix: cpC, pool: poolC } = createPoolIx({
      index: 2, baseAmountIn: BASE_IN, quoteAmountIn: 50_000_000n,
      coinCreator: wallet.publicKey, creator: wallet.publicKey,
      baseMint: mintC, quoteMint: NATIVE_MINT,
      baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
      userBaseAta: ataOf(wallet.publicKey, TOKEN_PROGRAM_ID, mintC), userQuoteAta: wsolAtaB,
    });
    console.log('    pool PDA:', poolC.toBase58());
    resC = await sendIx('create_pool#control2 (classic SPL)', [cpC], [wallet]);
  }

  console.log('\n================= SUMMARY =================');
  console.log('PRIMARY (hook mint): FAILED —', decodeErr(createRes.logs) || 'see logs above');
  console.log('CONTROL 1 (plain Token-2022):', resB.ok ? `SUCCESS sig=${resB.sig} pool=${poolB.toBase58()}` : `FAILED — ${decodeErr(resB.logs) || 'see logs'}`);
  if (resC) console.log('CONTROL 2 (classic SPL):', resC.ok ? `SUCCESS sig=${resC.sig}` : `FAILED — ${decodeErr(resC.logs) || 'see logs'}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
