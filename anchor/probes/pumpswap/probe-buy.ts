/**
 * Supplementary: prove the swap path works on the cloned devnet pump_amm by
 * buying against the CONTROL pool (plain Token-2022 base) created in run 2.
 * Local validator only. Scratch.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';

const DIR = __dirname;
const RPC = 'http://127.0.0.1:8899';
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// control pool artifacts passed as argv: pool, base_mint
const POOL = new PublicKey(process.argv[4] ?? '6Xy3hFzRZsNHrPzCjJnc1jAEVDafAyS5Cv1WWC86cpM5');
const BASE_MINT = new PublicKey(process.argv[5] ?? '316p2BhzMKekg4qAeX7vLrjNPu5g6GQkQ9SgQKTkkFrE');

const pda = (seeds: Buffer[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ataOf = (o: PublicKey, tp: PublicKey, m: PublicKey) => pda([o.toBuffer(), tp.toBuffer(), m.toBuffer()], ATA_PROGRAM);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(DIR, 'probe-wallet.json'), 'utf8'))));

  const GLOBAL_CONFIG = pda([Buffer.from('global_config')], PUMP_AMM);
  const gc = (await connection.getAccountInfo(GLOBAL_CONFIG))!.data;
  const feeRecipient = new PublicKey(gc.subarray(57, 89));

  const poolInfo = (await connection.getAccountInfo(POOL))!.data;
  const coinCreator = new PublicKey(poolInfo.subarray(211, 243));
  console.log('pool coin_creator:', coinCreator.toBase58(), '(wallet:', wallet.publicKey.toBase58() + ')');

  const data = Buffer.alloc(25);
  let o = 0;
  Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]).copy(data, o); o += 8;
  data.writeBigUInt64LE(1_000n * 1_000_000n, o); o += 8; // 1000 tokens out
  data.writeBigUInt64LE(5_000_000n, o); o += 8;            // max 0.005 WSOL in
  data.writeUInt8(0, o);

  const creatorVaultAuth = pda([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMP_AMM);
  const keys = [
    meta(POOL, true),
    meta(wallet.publicKey, true, true),
    meta(GLOBAL_CONFIG),
    meta(BASE_MINT),
    meta(NATIVE_MINT),
    meta(ataOf(wallet.publicKey, TOKEN_2022_PROGRAM_ID, BASE_MINT), true),
    meta(ataOf(wallet.publicKey, TOKEN_PROGRAM_ID, NATIVE_MINT), true),
    meta(ataOf(POOL, TOKEN_2022_PROGRAM_ID, BASE_MINT), true),
    meta(ataOf(POOL, TOKEN_PROGRAM_ID, NATIVE_MINT), true),
    meta(feeRecipient),
    meta(ataOf(feeRecipient, TOKEN_PROGRAM_ID, NATIVE_MINT), true),
    meta(TOKEN_2022_PROGRAM_ID),
    meta(TOKEN_PROGRAM_ID),
    meta(SystemProgram.programId),
    meta(ATA_PROGRAM),
    meta(pda([Buffer.from('__event_authority')], PUMP_AMM)),
    meta(PUMP_AMM),
    meta(ataOf(creatorVaultAuth, TOKEN_PROGRAM_ID, NATIVE_MINT), true),
    meta(creatorVaultAuth),
    meta(pda([Buffer.from('global_volume_accumulator')], PUMP_AMM)),
    meta(pda([Buffer.from('user_volume_accumulator'), wallet.publicKey.toBuffer()], PUMP_AMM), true),
    meta(pda([Buffer.from('fee_config'), PUMP_AMM.toBuffer()], FEE_PROGRAM)),
    meta(FEE_PROGRAM),
  ];
  // devnet global_config has buyback_basis_points = 1000 -> buy requires the 8
  // buyback fee recipient accounts as remaining accounts (error 6058 otherwise).
  // Mode arg: 'ata' -> pass ATA(recipient, spl-token, WSOL); 'raw' -> pass recipient verbatim.
  const mode = process.argv[2] ?? 'raw';
  const off = Number(process.argv[3] ?? 643);
  const buybackRecipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) buybackRecipients.push(new PublicKey(gc.subarray(off + i * 32, off + (i + 1) * 32)));
  for (const r of buybackRecipients) keys.push(meta(mode === 'ata' ? ataOf(r, TOKEN_PROGRAM_ID, NATIVE_MINT) : r, true));
  console.log('buyback mode:', mode, 'offset:', off);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    new TransactionInstruction({ keys, programId: PUMP_AMM, data }),
  );
  const poolQuote = ataOf(POOL, TOKEN_PROGRAM_ID, NATIVE_MINT);
  const before = await connection.getTokenAccountBalance(poolQuote).catch(() => null);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    const after = await connection.getTokenAccountBalance(poolQuote).catch(() => null);
    console.log('BUY SUCCESS sig:', sig);
    console.log('pool quote vault:', before?.value?.amount, '->', after?.value?.amount);
  } catch (e: any) {
    console.log('BUY FAILED:', e?.message);
    const logs = e?.logs ?? [];
    logs.forEach((l: string) => console.log('   ' + l));
  }
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
