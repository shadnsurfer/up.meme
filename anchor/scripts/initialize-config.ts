/**
 * One-off: initialize the on-chain Config PDA (devnet).
 *
 *   npx tsx scripts/initialize-config.ts        (from anchor/)
 *
 * Idempotent: if the config account already exists it just prints the current
 * values and exits.
 *
 * Env knobs:
 *   SOLANA_RPC_URL         devnet RPC (default https://api.devnet.solana.com)
 *   UP_MEME_PROGRAM_ID     override program id
 *   ATTESTATION_AUTHORITY  pubkey allowed to sign attestations
 *   PROTOCOL_VAULT         pubkey receiving the protocol fee share
 *
 * If ATTESTATION_AUTHORITY is unset, it is derived from
 * ATTESTATION_AUTHORITY_SECRET in ../server/.env (the secret is never printed).
 * If neither is set, the deploy wallet is used — fine for devnet bring-up only.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.UP_MEME_PROGRAM_ID ?? "57RhPQ8nBFrnknZTE4kmm56SSyUA1BysCKA39waoeqaM"
);

function loadDeployWallet(): Keypair {
  const p = path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function serverAttestationPubkey(): PublicKey | null {
  try {
    const envPath = path.join(__dirname, "../../server/.env");
    const m = fs.readFileSync(envPath, "utf8").match(/^ATTESTATION_AUTHORITY_SECRET=(.+)$/m);
    if (!m) return null;
    return Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(m[1].trim())).publicKey;
  } catch {
    return null;
  }
}

async function main() {
  const admin = loadDeployWallet();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(RPC, "confirmed"),
    new anchor.Wallet(admin),
    { commitment: "confirmed" }
  );
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/up_meme.json"), "utf8")
  );
  const program: any = new anchor.Program(idl, provider);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

  if (await provider.connection.getAccountInfo(config)) {
    const cfg = await program.account.config.fetch(config);
    console.log("config already initialized:");
    console.log("  admin:                 ", cfg.admin.toBase58());
    console.log("  attestation authority: ", cfg.attestationAuthority.toBase58());
    console.log("  protocol vault:        ", cfg.protocolVault.toBase58());
    return;
  }

  const attestationAuthority =
    (process.env.ATTESTATION_AUTHORITY && new PublicKey(process.env.ATTESTATION_AUTHORITY)) ||
    serverAttestationPubkey() ||
    admin.publicKey;
  const protocolVault = process.env.PROTOCOL_VAULT
    ? new PublicKey(process.env.PROTOCOL_VAULT)
    : admin.publicKey;
  if (!process.env.ATTESTATION_AUTHORITY && attestationAuthority.equals(admin.publicKey))
    console.warn("WARN: attestation authority = deploy wallet (devnet placeholder)");
  if (!process.env.PROTOCOL_VAULT)
    console.warn("WARN: protocol vault = deploy wallet (devnet placeholder)");

  const sig = await program.methods
    .initializeConfig(attestationAuthority, protocolVault)
    .accounts({ admin: admin.publicKey, config, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("initialize_config tx:", sig);
  console.log("  admin:                 ", admin.publicKey.toBase58());
  console.log("  attestation authority: ", attestationAuthority.toBase58());
  console.log("  protocol vault:        ", protocolVault.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
