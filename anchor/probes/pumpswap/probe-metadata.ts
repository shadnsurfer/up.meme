/**
 * Supplementary probe: is a Token-2022 mint with ONLY pump.fun-style metadata
 * extensions (MetadataPointer + TokenMetadata) accepted by PumpSwap create_pool?
 * Local validator with devnet clones. Scratch only.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ExtensionType, getMintLen,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction, createSyncNativeInstruction,
} from '@solana/spl-token';
import { tokenMetadataInitializeWithRentTransfer } from '@solana/spl-token';

const DIR = __dirname;
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const connection = new Connection(RPC, 'confirmed');

const pda = (seeds: Buffer[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ataOf = (o: PublicKey, tp: PublicKey, m: PublicKey) => pda([o.toBuffer(), tp.toBuffer(), m.toBuffer()], ATA_PROGRAM);
const GLOBAL_CONFIG = pda([Buffer.from('global_config')], PUMP_AMM);
const EVENT_AUTHORITY = pda([Buffer.from('__event_authority')], PUMP_AMM);

async function main() {
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(DIR, 'probe-wallet.json'), 'utf8'))));
  const mint = Keypair.generate();

  // Token-2022 InitializeMint requires account len == try_calculate_account_len(mint, [exts present]).
  // So: size for MetadataPointer ONLY, initMint, then tokenMetadataInitializeWithRentTransfer reallocs bigger.
  const len = getMintLen([ExtensionType.MetadataPointer]);
  const rent = await connection.getMinimumBalanceForRentExemption(len);
  const tx1 = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey,
      space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint.publicKey, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 6, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  const sig1 = await sendAndConfirmTransaction(connection, tx1, [wallet, mint], { commitment: 'confirmed' });
  console.log('mint created (pointer+mint):', mint.publicKey.toBase58(), 'sig:', sig1);

  const sig1b = await tokenMetadataInitializeWithRentTransfer(
    connection, wallet, mint.publicKey, wallet.publicKey, wallet.publicKey,
    'META PROBE', 'META', '',
  );
  console.log('token metadata initialized, sig:', sig1b);

  const ata = ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, mint.publicKey);
  const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, 1_000_000_000_000n, [], TOKEN_2022_PROGRAM_ID),
  ), [wallet], { commitment: 'confirmed' });
  console.log('minted 1M, sig:', sig2);

  const wsol = ataOf(wallet.publicKey, TOKEN_PROGRAM_ID, NATIVE_MINT);
  const wrapIxs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(wsol))) {
    wrapIxs.push(createAssociatedTokenAccountInstruction(wallet.publicKey, wsol, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID));
  }
  wrapIxs.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsol, lamports: 60_000_000 }));
  wrapIxs.push(createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID));
  await sendAndConfirmTransaction(connection, new Transaction().add(...wrapIxs), [wallet], { commitment: 'confirmed' });

  // create_pool index 5
  const idx = Buffer.alloc(2); idx.writeUInt16LE(5);
  const pool = pda([Buffer.from('pool'), idx, wallet.publicKey.toBuffer(), mint.publicKey.toBuffer(), NATIVE_MINT.toBuffer()], PUMP_AMM);
  const lpMint = pda([Buffer.from('pool_lp_mint'), pool.toBuffer()], PUMP_AMM);
  const data = Buffer.alloc(60);
  let o = 0;
  Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]).copy(data, o); o += 8;
  data.writeUInt16LE(5, o); o += 2;
  data.writeBigUInt64LE(1_000_000_000_000n, o); o += 8;
  data.writeBigUInt64LE(50_000_000n, o); o += 8;
  wallet.publicKey.toBuffer().copy(data, o); o += 32;
  data.writeUInt8(0, o); o += 1;
  data.writeUInt8(0, o); o += 1;
  const keys = [
    { pubkey: pool, isWritable: true, isSigner: false },
    { pubkey: GLOBAL_CONFIG, isWritable: false, isSigner: false },
    { pubkey: wallet.publicKey, isWritable: true, isSigner: true },
    { pubkey: mint.publicKey, isWritable: false, isSigner: false },
    { pubkey: NATIVE_MINT, isWritable: false, isSigner: false },
    { pubkey: lpMint, isWritable: true, isSigner: false },
    { pubkey: ata, isWritable: true, isSigner: false },
    { pubkey: wsol, isWritable: true, isSigner: false },
    { pubkey: ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, lpMint), isWritable: true, isSigner: false },
    { pubkey: ataOf(pool, TOKEN_2022_PROGRAM_ID, mint.publicKey), isWritable: true, isSigner: false },
    { pubkey: ataOf(pool, TOKEN_PROGRAM_ID, NATIVE_MINT), isWritable: true, isSigner: false },
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: ATA_PROGRAM, isWritable: false, isSigner: false },
    { pubkey: EVENT_AUTHORITY, isWritable: false, isSigner: false },
    { pubkey: PUMP_AMM, isWritable: false, isSigner: false },
  ];
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    new TransactionInstruction({ keys, programId: PUMP_AMM, data }),
  );
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    console.log('CREATE_POOL (metadata-only Token-2022) SUCCESS sig:', sig);
    console.log('pool:', pool.toBase58());
  } catch (e: any) {
    console.log('CREATE_POOL (metadata-only Token-2022) FAILED:', e?.message);
    const logs = e?.logs ?? (typeof e?.getLogs === 'function' ? await e.getLogs(connection).catch(() => []) : []);
    (logs ?? []).forEach((l: string) => console.log('   ' + l));
  }
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
