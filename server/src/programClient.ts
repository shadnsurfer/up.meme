import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { config, connection } from './config.js';

/** anchor instruction discriminator: sha256("global:<ix_name>")[..8] */
function ixDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], config.programId)[0];
}

export function attestationPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('attest'), wallet.toBuffer()],
    config.programId,
  )[0];
}

/** true if the wallet already has an onchain attestation */
export async function hasAttestation(wallet: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(attestationPda(wallet));
  return info !== null && info.owner.equals(config.programId);
}

/**
 * Submit create_attestation(wallet) onchain, signed by the attestation
 * authority (which also pays the rent). Anyone may request an attestation for
 * any wallet — it only records a public fact (the wallet has a profile).
 */
export async function submitAttestation(wallet: PublicKey): Promise<string> {
  const data = Buffer.concat([ixDiscriminator('create_attestation'), wallet.toBuffer()]);

  const ix = new TransactionInstruction({
    programId: config.programId,
    keys: [
      { pubkey: config.authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: attestationPda(wallet), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = config.authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(config.authority);
  return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
}
