import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferHook,
} from "@solana/spl-token";
import { assert } from "chai";

// NOTE: `anchor build` has not run yet, so the generated `target/types/up_meme`
// import does not exist. The workspace handle is loosely typed on purpose —
// account names/order and argument shapes below follow
// programs/up-meme/src/lib.rs directly.
describe("up-meme", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  // `anchor build` generates target/types/up_meme; until it exists, keep the
  // handle untyped (a Program<any> annotation trips TS2589 deep-instantiation
  // errors on the methods builder and buys nothing at runtime).
  const program: any = (anchor.workspace as any).UpMeme;

  // ---- constants mirrored from programs/up-meme/src/state.rs ----
  const TOTAL_SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
  const VIRTUAL_SOL = 25_000_000_000n; // 25 SOL virtual offset
  const FEE_BPS = 100n; // 1% total trade fee
  const RENT_FLOOR = 890_880n;
  const DECIMALS = 6;

  // ---- wallets ----
  const admin = provider.wallet; // deployer; also the launch creator
  const verifier = Keypair.generate(); // attestation authority
  const protocolVault = Keypair.generate().publicKey; // protocol fee sink
  const buyer = Keypair.generate(); // attested trader
  const stranger = Keypair.generate(); // never attested
  const third = Keypair.generate(); // buys post-climb, never attested
  const recipient = Keypair.generate(); // transfer target (no SOL needed)

  // set by test (c), reused by (d)-(h), (j)
  let mint1: Keypair;
  // set by test (i), reused by (j)-(l)
  let mint2: Keypair;

  // ---- PDA helpers (seeds from lib.rs) ----
  const HOOK_PROGRAM_ID = new PublicKey("ws45kVaY6HcPrdrT6UP6WorwpviBPjnJbG7yjSkqeHN");
  const pda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const hookPda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, HOOK_PROGRAM_ID)[0];
  const str = (s: string) => Buffer.from(s, "utf8");

  const configPda = pda(str("config"));
  const attestPda = (wallet: PublicKey) => pda(str("attest"), wallet.toBuffer());
  const launchPda = (mint: PublicKey) => pda(str("launch"), mint.toBuffer());
  const vaultAuthorityPda = (mint: PublicKey) => pda(str("vault"), mint.toBuffer());
  const curvePda = (mint: PublicKey) => pda(str("curve"), mint.toBuffer());
  const solVaultPda = (mint: PublicKey) => pda(str("solvault"), mint.toBuffer());
  const feeVaultPda = (mint: PublicKey) => pda(str("feevault"), mint.toBuffer());
  // extra-account-metas is a PDA of the HOOK program, not the main program
  const extraMetasPda = (mint: PublicKey) => hookPda(str("extra-account-metas"), mint.toBuffer());

  // ---- curve math, mirroring buy_tokens_out / sell_sol_out in lib.rs ----
  const buyTokensOut = (x: bigint, y: bigint, dx: bigint): bigint => y - (x * y) / (x + dx);
  const sellSolOut = (x: bigint, y: bigint, dy: bigint): bigint => x - (x * y) / (y + dy);

  const ataOf = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

  async function fund(pubkey: PublicKey, lamports: number) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  // rpc() resolves at the provider's (processed) commitment, but assertions
  // read at "confirmed" — always confirm before reading
  async function confirm(sig: string) {
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }

  function tradeAccounts(mint: PublicKey, trader: PublicKey, attestation: PublicKey | null) {
    return {
      trader,
      launch: launchPda(mint),
      mint,
      curveTokenAccount: curvePda(mint),
      traderAta: ataOf(mint, trader),
      vaultAuthority: vaultAuthorityPda(mint),
      solVault: solVaultPda(mint),
      feeVault: feeVaultPda(mint),
      extraMetas: extraMetasPda(mint),
      hookProgram: HOOK_PROGRAM_ID,
      upMemeProgram: program.programId,
      attestation,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  // Extra keys a raw token-2022 transfer must carry so the token program can
  // invoke the transfer hook: the resolved extras in metas order (the main
  // program id, then the launch PDA), the extra-account-metas validation
  // state, and the hook program. (spl-transfer-hook-interface matches these
  // by pubkey, so positional order is convention, not load-bearing.)
  function hookKeys(mint: PublicKey) {
    return [
      { pubkey: program.programId, isSigner: false, isWritable: false },
      { pubkey: launchPda(mint), isSigner: false, isWritable: false },
      { pubkey: extraMetasPda(mint), isSigner: false, isWritable: false },
      { pubkey: HOOK_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
  }

  async function expectFail(promise: Promise<unknown>, ...patterns: string[]): Promise<void> {
    let err: any;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    if (!err) {
      assert.fail(`expected transaction to fail with one of: ${patterns.join(", ")}`);
    }
    const parts: string[] = [];
    if (err.message) parts.push(String(err.message));
    if (err.error) {
      try {
        parts.push(JSON.stringify(err.error));
      } catch {
        /* non-serializable */
      }
    }
    if (Array.isArray(err.logs)) parts.push(err.logs.join("\n"));
    parts.push(String(err));
    const haystack = parts.join("\n");
    assert.ok(
      patterns.some((p) => haystack.includes(p)),
      `expected error matching one of [${patterns.join(", ")}], got:\n${haystack}`
    );
  }

  // Full launch flow (used by the 1h climb and the 2s climb). The creator
  // (provider wallet) is attested in test (b), which `launch` requires when
  // climb_seconds > 0. Mint is a fresh keypair signed over as a signer.
  async function launchCoin(climbSeconds: number, seedLamports: number): Promise<Keypair> {
    const mint = Keypair.generate();
    const m = mint.publicKey;
    const sig = await program.methods
      .launch(
        "Test Coin",
        "TEST",
        "https://up.meme/test.json",
        new BN(climbSeconds),
        new BN(seedLamports),
        new BN(0) // min_seed_tokens_out
      )
      .accounts({
        creator: admin.publicKey,
        mint: m,
        launch: launchPda(m),
        vaultAuthority: vaultAuthorityPda(m),
        curveTokenAccount: curvePda(m),
        solVault: solVaultPda(m),
        feeVault: feeVaultPda(m),
        extraMetas: extraMetasPda(m),
        hookProgram: HOOK_PROGRAM_ID,
        upMemeProgram: program.programId,
        creatorAta: ataOf(m, admin.publicKey), // init_if_needed in-handler
        creatorAttestation: attestPda(admin.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([cu(1_000_000)]) // launch is CU-heavy
      .signers([mint])
      .rpc();
    // rpc() resolves at the provider's (processed) commitment — wait for
    // confirmed before assertions read accounts at "confirmed"
    const conf = await connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(`launch tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
    return mint;
  }

  before("fund test wallets", async () => {
    for (const kp of [verifier, buyer, stranger, third]) {
      await fund(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    }
  });

  // ------------------------------------------------------------------
  it("a. initialize_config sets admin, verifier and protocol vault", async () => {
    await program.methods
      .initializeConfig(verifier.publicKey, protocolVault)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin.publicKey), "admin");
    assert.ok(config.attestationAuthority.equals(verifier.publicKey), "attestation authority");
    assert.ok(config.protocolVault.equals(protocolVault), "protocol vault");
  });

  // ------------------------------------------------------------------
  it("b. create_attestation stores one attestation per wallet", async () => {
    for (const wallet of [admin.publicKey, buyer.publicKey]) {
      const attestation = attestPda(wallet);
      await program.methods
        .createAttestation(wallet)
        .accounts({
          authority: verifier.publicKey,
          config: configPda,
          attestation,
          systemProgram: SystemProgram.programId,
        })
        .signers([verifier])
        .rpc();

      const att = await program.account.attestation.fetch(attestation);
      assert.ok(att.wallet.equals(wallet), "wallet");
      assert.ok(att.createdAt.toNumber() > 0, "created_at set");
      const [, expectedBump] = PublicKey.findProgramAddressSync(
        [str("attest"), wallet.toBuffer()],
        program.programId
      );
      assert.strictEqual(att.bump, expectedBump, "bump");
    }
  });

  // ------------------------------------------------------------------
  // NOTE: if this test fails with AccountDiscriminatorMismatch (3002) /
  // AccountDiscriminatorNotFound coming out of the transfer-hook CPI during
  // the seed buy, that is a lib.rs issue, not a test issue: the hook's
  // ExecuteHook deserializes the `launch` account, but anchor only serializes
  // freshly-`init`ed accounts at instruction exit — i.e. after the handler
  // (and the seed-buy transfer) has run.
  it("c. launch: token-2022 mint with hook, seeded curve, launch state", async () => {
    const seedLamports = 500_000_000; // 0.5 SOL
    const climbSeconds = 3600;

    const before = Math.floor(Date.now() / 1000);
    const mint = await launchCoin(climbSeconds, seedLamports);
    const after = Math.floor(Date.now() / 1000);

    const m = mint.publicKey;
    const launch = launchPda(m);
    const vaultAuthority = vaultAuthorityPda(m);
    const curve = curvePda(m);
    const solVault = solVaultPda(m);
    const feeVault = feeVaultPda(m);
    const extraMetas = extraMetasPda(m);
    const creatorAta = ataOf(m, admin.publicKey);

    // mint is token-2022 with a transfer-hook extension pointing at our program
    const mintInfo = await getMint(connection, m, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(mintInfo.decimals, DECIMALS, "decimals");
    assert.strictEqual(mintInfo.supply, TOTAL_SUPPLY, "supply");
    assert.ok(mintInfo.mintAuthority !== null && mintInfo.mintAuthority.equals(vaultAuthority), "mint authority = vault PDA");
    const hook = getTransferHook(mintInfo);
    assert.ok(hook !== null, "transfer-hook extension present");
    assert.ok(hook!.programId.equals(HOOK_PROGRAM_ID), "hook program id = up_meme_hook");
    assert.ok(hook!.authority.equals(vaultAuthority), "hook authority = vault PDA");

    // curve holds TOTAL_SUPPLY minus the seed buy; creator holds the seed tokens
    const expectedSeed = buyTokensOut(VIRTUAL_SOL, TOTAL_SUPPLY, BigInt(seedLamports));
    const curveAcct = await getAccount(connection, curve, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(curveAcct.amount, TOTAL_SUPPLY - expectedSeed, "curve balance");
    const creatorAcct = await getAccount(connection, creatorAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(creatorAcct.amount, expectedSeed, "creator seed tokens");

    // launch PDA state
    const launchAcct = await program.account.launch.fetch(launch);
    assert.ok(launchAcct.mint.equals(m), "launch.mint");
    assert.ok(launchAcct.creator.equals(admin.publicKey), "launch.creator");
    assert.ok(launchAcct.curveTokenAccount.equals(curve), "launch.curve_token_account");
    assert.ok(launchAcct.solVault.equals(solVault), "launch.sol_vault");
    assert.ok(launchAcct.feeVault.equals(feeVault), "launch.fee_vault");
    assert.strictEqual(launchAcct.virtualSol.toString(), VIRTUAL_SOL.toString(), "launch.virtual_sol");
    const climbEnd = launchAcct.climbEnd.toNumber();
    assert.ok(
      climbEnd >= before + climbSeconds - 60 && climbEnd <= after + climbSeconds + 60,
      `climb_end ≈ now + ${climbSeconds} (got ${climbEnd}, window ${before + climbSeconds}..${after + climbSeconds})`
    );

    // seed lamports land in the sol vault; fee vault sits at the rent floor
    assert.strictEqual(await connection.getBalance(solVault), Number(RENT_FLOOR) + seedLamports, "sol vault funded by seed");
    assert.strictEqual(await connection.getBalance(feeVault), Number(RENT_FLOOR), "fee vault untouched by seed");

    // transfer-hook extra account metas, owned by our program
    const extraMetasInfo = await connection.getAccountInfo(extraMetas);
    assert.ok(extraMetasInfo !== null, "extra metas account exists");
    assert.ok(extraMetasInfo!.owner.equals(HOOK_PROGRAM_ID), "extra metas owned by up_meme_hook");

    mint1 = mint;
  });

  // ------------------------------------------------------------------
  it("d. buy by attested wallet during the climb succeeds", async () => {
    const m = mint1.publicKey;
    const lamports = 250_000_000; // 0.25 SOL
    const fee = Math.floor((lamports * Number(FEE_BPS)) / 10_000); // 2_500_000
    const dx = lamports - fee;

    const solVault = solVaultPda(m);
    const feeVault = feeVaultPda(m);
    const solVaultBefore = await connection.getBalance(solVault);
    const feeVaultBefore = await connection.getBalance(feeVault);
    const curveBefore = (await getAccount(connection, curvePda(m), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    const buySig = await program.methods
      .buy(new BN(lamports), new BN(0)) // min_tokens_out = 0
      .accounts(tradeAccounts(m, buyer.publicKey, attestPda(buyer.publicKey)))
      .preInstructions([cu(400_000)])
      .signers([buyer])
      .rpc();
    await confirm(buySig);

    const buyerAta = ataOf(m, buyer.publicKey);
    const buyerAcct = await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    const x = VIRTUAL_SOL + BigInt(solVaultBefore) - RENT_FLOOR;
    const expectedOut = buyTokensOut(x, curveBefore, BigInt(dx));
    assert.ok(buyerAcct.amount > 0n, "buyer received tokens");
    assert.strictEqual(buyerAcct.amount, expectedOut, "tokens out match the curve");
    assert.strictEqual(await connection.getBalance(solVault), solVaultBefore + dx, "sol vault +dx");
    assert.strictEqual(await connection.getBalance(feeVault), feeVaultBefore + fee, "fee vault +1%");
  });

  // ------------------------------------------------------------------
  it("e. buy by unattested wallet during the climb fails (NotAttested)", async () => {
    const m = mint1.publicKey;
    await expectFail(
      program.methods
        .buy(new BN(100_000_000), new BN(0)) // 0.1 SOL
        .accounts(tradeAccounts(m, stranger.publicKey, null)) // attestation = None
        .preInstructions([cu(400_000)])
        .signers([stranger])
        .rpc(),
      "NotAttested",
      "6000",
      "0x1770"
    );
  });

  // ------------------------------------------------------------------
  it("f. raw user->user transfer during the climb fails (ClimbTransfersLocked)", async () => {
    const m = mint1.publicKey;
    const buyerAta = ataOf(m, buyer.publicKey);
    const recipientAta = ataOf(m, recipient.publicKey);

    // destination token account must exist for transfer_checked; creating an
    // ATA moves no tokens, so the hook is not involved here
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          buyer.publicKey, // rent payer
          recipientAta,
          recipient.publicKey,
          m,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      ),
      [buyer]
    );

    const ix = createTransferCheckedInstruction(
      buyerAta,
      m,
      recipientAta,
      buyer.publicKey,
      1_000, // base units
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    ix.keys.push(...hookKeys(m));

    const tx = new Transaction().add(cu(300_000), ix);
    await expectFail(provider.sendAndConfirm(tx, [buyer]), "ClimbTransfersLocked", "6006", "0x1776");
  });

  // ------------------------------------------------------------------
  it("g. sell during the climb succeeds without attestation", async () => {
    const m = mint1.publicKey;
    const buyerAta = ataOf(m, buyer.publicKey);
    const buyerTokensBefore = (await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const tokenAmount = buyerTokensBefore / 2n;

    const solVault = solVaultPda(m);
    const feeVault = feeVaultPda(m);
    const solVaultBefore = await connection.getBalance(solVault);
    const feeVaultBefore = await connection.getBalance(feeVault);
    const curveBefore = (await getAccount(connection, curvePda(m), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const buyerSolBefore = await connection.getBalance(buyer.publicKey);

    const sellSig = await program.methods
      .sell(new BN(tokenAmount.toString()), new BN(0)) // min_sol_out = 0; attestation = None
      .accounts(tradeAccounts(m, buyer.publicKey, null))
      .preInstructions([cu(400_000)])
      .signers([buyer])
      .rpc();
    await confirm(sellSig);

    const x = VIRTUAL_SOL + BigInt(solVaultBefore) - RENT_FLOOR;
    const solOut = sellSolOut(x, curveBefore, tokenAmount);
    const fee = (solOut * FEE_BPS) / 10_000n;
    const payout = solOut - fee;

    assert.strictEqual(await connection.getBalance(solVault), solVaultBefore - Number(solOut), "sol vault -sol_out");
    assert.strictEqual(await connection.getBalance(feeVault), feeVaultBefore + Number(fee), "fee vault +1%");
    // the provider wallet pays the tx fee, so the buyer's balance moves by
    // exactly the payout
    const buyerDelta = (await connection.getBalance(buyer.publicKey)) - buyerSolBefore;
    assert.strictEqual(buyerDelta, Number(payout), "buyer receives SOL minus fee");

    const buyerAcctAfter = await getAccount(connection, buyerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(buyerAcctAfter.amount, buyerTokensBefore - tokenAmount, "tokens left the buyer ATA");
  });

  // ------------------------------------------------------------------
  it("h. claim_fees splits the fee vault 50/50 creator/protocol", async () => {
    const m = mint1.publicKey;
    const feeVault = feeVaultPda(m);

    const feeBal = await connection.getBalance(feeVault);
    const claimable = feeBal - Number(RENT_FLOOR);
    assert.ok(claimable > 0, "fees accrued from the buy and the sell");
    const half = Math.floor(claimable / 2);

    const creatorBefore = await connection.getBalance(admin.publicKey);
    const protocolBefore = await connection.getBalance(protocolVault);

    const claimSig = await program.methods
      .claimFees()
      .accounts({
        launch: launchPda(m),
        config: configPda,
        feeVault,
        creator: admin.publicKey,
        protocolVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await confirm(claimSig);

    const creatorDelta = (await connection.getBalance(admin.publicKey)) - creatorBefore;
    const protocolDelta = (await connection.getBalance(protocolVault)) - protocolBefore;

    assert.strictEqual(protocolDelta, claimable - half, "protocol gets claimable - half");
    // the creator is also the fee payer here, so its delta is half minus the
    // tx fee — allow generous tolerance
    assert.ok(
      creatorDelta >= half - 50_000 && creatorDelta <= half,
      `creator gets ~half (delta ${creatorDelta}, half ${half})`
    );
    assert.strictEqual(await connection.getBalance(feeVault), Number(RENT_FLOOR), "vault drained to rent floor");
  });

  // ------------------------------------------------------------------
  it("i. after climb end: buys need no attestation and transfers are free", async () => {
    const seedLamports = 500_000_000; // 0.5 SOL
    mint2 = await launchCoin(2, seedLamports); // 2-second climb
    const m2 = mint2.publicKey;

    // let the climb window lapse (local validator clock tracks wall time)
    await new Promise((resolve) => setTimeout(resolve, 4_500));

    // third wallet buys with NO attestation — climb is over
    const thirdSig = await program.methods
      .buy(new BN(100_000_000), new BN(0)) // 0.1 SOL
      .accounts(tradeAccounts(m2, third.publicKey, null))
      .preInstructions([cu(400_000)])
      .signers([third])
      .rpc();
    await confirm(thirdSig);

    const thirdAta = ataOf(m2, third.publicKey);
    const thirdAcct = await getAccount(connection, thirdAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.ok(thirdAcct.amount > 0n, "unattested buy succeeds after climb end");

    // raw user->user transfer succeeds — the hook is a no-op after climb end
    const recipientAta2 = ataOf(m2, recipient.publicKey);
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          third.publicKey,
          recipientAta2,
          recipient.publicKey,
          m2,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      ),
      [third]
    );

    const ix = createTransferCheckedInstruction(
      thirdAta,
      m2,
      recipientAta2,
      third.publicKey,
      1_000,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    ix.keys.push(...hookKeys(m2));
    const freeTransferSig = await provider.sendAndConfirm(new Transaction().add(cu(300_000), ix), [third]);
    await confirm(freeTransferSig);

    const recipientAcct = await getAccount(connection, recipientAta2, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(recipientAcct.amount, 1_000n, "tokens moved freely after climb end");
  });

  // ------------------------------------------------------------------
  // migration: Meteora DAMM v2 (cp-amm), loaded into the test validator via
  // [[test.genesis]] (tests/fixtures/cp_amm.so, dumped from mainnet)

  const CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
  const MIGRATION_RENT_BUDGET = 30_000_000n;
  const MIN_SQRT = 4_295_048_016n;
  const MAX_SQRT = 79_226_673_521_066_979_257_578_248_091n;

  const cpPda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, CP_AMM)[0];
  const maxKey = (a: PublicKey, b: PublicKey) =>
    Buffer.compare(a.toBuffer(), b.toBuffer()) === 1 ? a : b;
  const minKey = (a: PublicKey, b: PublicKey) =>
    Buffer.compare(a.toBuffer(), b.toBuffer()) === 1 ? b : a;

  function isqrt(n: bigint): bigint {
    if (n === 0n) return 0n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  // exact replicas of the on-chain computations in lib.rs `migrate` — the
  // program recomputes sqrt_price itself, so the client must match it for the
  // liquidity floor-check to pass.
  function migrationParams(A: bigint, B: bigint) {
    const sqrtPrice = isqrt((B << 64n) / A) << 32n;
    // cp-amm amounts from liquidity (ceil): a = L(√max-√P)/(√P√max),
    // b = L(√P-√min)/2^128 — invert both with floor and take the min
    const la = (A * sqrtPrice * MAX_SQRT) / (MAX_SQRT - sqrtPrice);
    const lb = (B << 128n) / (sqrtPrice - MIN_SQRT);
    let liquidity = la < lb ? la : lb;
    const ceilDiv = (x: bigint, d: bigint) => (x + d - 1n) / d;
    for (let i = 0; i < 4; i++) {
      const impliedA = ceilDiv(liquidity * (MAX_SQRT - sqrtPrice), sqrtPrice * MAX_SQRT);
      const impliedB = ceilDiv(liquidity * (sqrtPrice - MIN_SQRT), 1n << 128n);
      if (impliedA <= A && impliedB <= B) break;
      liquidity -= 1n;
    }
    return { sqrtPrice, liquidity };
  }

  function migrateAccounts(mint: PublicKey, positionNftMint: PublicKey) {
    const vaultAuthority = vaultAuthorityPda(mint);
    const pool = cpPda(str("cpool"), maxKey(mint, NATIVE_MINT).toBuffer(), minKey(mint, NATIVE_MINT).toBuffer());
    return {
      cranker: admin.publicKey,
      launch: launchPda(mint),
      mint,
      curveTokenAccount: curvePda(mint),
      vaultAuthority,
      solVault: solVaultPda(mint),
      feeVault: feeVaultPda(mint),
      wsolAta: getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuthority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      wsolMint: NATIVE_MINT,
      positionNftMint,
      positionNftAccount: cpPda(str("position_nft_account"), positionNftMint.toBuffer()),
      poolAuthority: cpPda(str("pool_authority")),
      pool,
      position: cpPda(str("position"), positionNftMint.toBuffer()),
      tokenAVault: cpPda(str("token_vault"), mint.toBuffer(), pool.toBuffer()),
      tokenBVault: cpPda(str("token_vault"), NATIVE_MINT.toBuffer(), pool.toBuffer()),
      eventAuthority: cpPda(str("__event_authority")),
      cpAmmProgram: CP_AMM,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  it("j. migrate before climb end is rejected (ClimbNotOver)", async () => {
    const m = mint1.publicKey; // 1h climb, still open
    const nft = Keypair.generate();
    await expectFail(
      program.methods
        .migrate(new BN(1))
        .accounts(migrateAccounts(m, nft.publicKey))
        .preInstructions([cu(1_400_000)])
        .signers([nft])
        .rpc(),
      "ClimbNotOver"
    );
  });

  // ------------------------------------------------------------------
  it("k. migrate: hook revoked forever, full-range pool seated + locked, token trades freely", async () => {
    const m2 = mint2.publicKey;
    const curve = curvePda(m2);
    const solVault = solVaultPda(m2);

    const A = (await getAccount(connection, curve, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const solBal = BigInt(await connection.getBalance(solVault));
    const B = solBal - RENT_FLOOR - MIGRATION_RENT_BUDGET;
    assert.ok(A > 0n && B > 0n, "curve has both sides");

    const { sqrtPrice, liquidity } = migrationParams(A, B);
    const nft = Keypair.generate();
    const accounts = migrateAccounts(m2, nft.publicKey);

    const sig = await program.methods
      .migrate(new BN(liquidity.toString()))
      .accounts(accounts)
      .preInstructions([cu(1_400_000)])
      .signers([nft])
      .rpc();
    await confirm(sig);

    // launch flagged migrated
    const launch = await program.account.launch.fetch(launchPda(m2));
    assert.strictEqual(launch.migrated, true, "launch.migrated");

    // hook fully torn down: program id AND authority both None — the exact
    // state DAMM v2's is_supported_mint requires, and irreversible by anyone
    const mintInfo = await getMint(connection, m2, "confirmed", TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(mintInfo);
    assert.ok(hook !== null, "hook extension still present (type can never be removed)");
    assert.ok(hook!.programId.equals(PublicKey.default), "hook program id = None");
    assert.ok(hook!.authority.equals(PublicKey.default), "hook authority revoked");

    // pool + vaults exist, owned by cp-amm, holding (nearly) the full curve
    const poolInfo = await connection.getAccountInfo(accounts.pool);
    assert.ok(poolInfo !== null && poolInfo.owner.equals(CP_AMM), "pool owned by cp-amm");
    const ceilDiv = (x: bigint, d: bigint) => (x + d - 1n) / d;
    const expectedA = ceilDiv(liquidity * (MAX_SQRT - sqrtPrice), sqrtPrice * MAX_SQRT);
    const expectedB = ceilDiv(liquidity * (sqrtPrice - MIN_SQRT), 1n << 128n);
    const vaultA = await getAccount(connection, accounts.tokenAVault, "confirmed", TOKEN_2022_PROGRAM_ID);
    const vaultB = await getAccount(connection, accounts.tokenBVault, "confirmed", TOKEN_PROGRAM_ID);
    assert.strictEqual(vaultA.amount, expectedA, "token_a seated");
    assert.strictEqual(vaultB.amount, expectedB, "token_b seated");
    assert.ok(expectedA * 100n >= A * 99n, "pool got >= 99% of the token side");
    assert.ok(expectedB * 100n >= B * 99n, "pool got >= 99% of the SOL side");

    // the LP position nft sits in program custody (vault PDA)
    const nftAcct = await getAccount(connection, accounts.positionNftAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(nftAcct.amount, 1n, "position nft minted");
    assert.ok(nftAcct.owner.equals(vaultAuthorityPda(m2)), "position nft owned by vault PDA");

    // sol vault left at the rent floor; rent-budget leftover went to fees
    assert.strictEqual(await connection.getBalance(solVault), Number(RENT_FLOOR), "sol vault back to rent floor");

    // the token now moves wallet-to-wallet with NO hook accounts appended —
    // the hook is dead, the token is plain token-2022
    const thirdAta = ataOf(m2, third.publicKey);
    const recipientAta2 = ataOf(m2, recipient.publicKey);
    const freeSig = await provider.sendAndConfirm(
      new Transaction().add(
        cu(200_000),
        createTransferCheckedInstruction(
          thirdAta, m2, recipientAta2, third.publicKey, 2_000, DECIMALS, [], TOKEN_2022_PROGRAM_ID
        )
      ),
      [third]
    );
    await confirm(freeSig);
    const recipientAcct = await getAccount(connection, recipientAta2, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(recipientAcct.amount, 3_000n, "token moves freely after migration");
  });

  // ------------------------------------------------------------------
  it("l. the curve is closed after migration (AlreadyMigrated)", async () => {
    const m2 = mint2.publicKey;
    await expectFail(
      program.methods
        .buy(new BN(10_000_000), new BN(0))
        .accounts(tradeAccounts(m2, third.publicKey, null))
        .preInstructions([cu(400_000)])
        .signers([third])
        .rpc(),
      "AlreadyMigrated"
    );
    await expectFail(
      program.methods
        .sell(new BN(1_000), new BN(0))
        .accounts(tradeAccounts(m2, third.publicKey, null))
        .preInstructions([cu(400_000)])
        .signers([third])
        .rpc(),
      "AlreadyMigrated"
    );
  });
});
