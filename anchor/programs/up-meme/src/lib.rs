use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::{program::{invoke, invoke_signed}, system_instruction};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{self, spl_token_2022, Token2022, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use spl_token_2022::extension::ExtensionType;

pub mod state;
use state::*;

// PLACEHOLDER — replace with the real program keypair pubkey after first build
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod up_meme {
    use super::*;

    /// one-time protocol setup.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        attestation_authority: Pubkey,
        protocol_vault: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.attestation_authority = attestation_authority;
        config.protocol_vault = protocol_vault;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// rotate the attestation authority (admin only).
    pub fn set_attestation_authority(ctx: Context<SetAttestationAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.attestation_authority = new_authority;
        Ok(())
    }

    /// the verifier service calls this after confirming the wallet has a
    /// pump.fun profile. one attestation per wallet, permanent.
    pub fn create_attestation(ctx: Context<CreateAttestation>, wallet: Pubkey) -> Result<()> {
        let att = &mut ctx.accounts.attestation;
        att.wallet = wallet;
        att.created_at = Clock::get()?.unix_timestamp;
        att.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// launch a coin: identical terms for everyone. the creator's seed buy is
    /// the first and only presale — one wallet deploys, one wallet seeds.
    pub fn launch(
        ctx: Context<LaunchCtx>,
        _name: String,
        _symbol: String,
        _uri: String,
        climb_seconds: u64,
        seed_lamports: u64,
        min_seed_tokens_out: u64,
    ) -> Result<()> {
        require!(seed_lamports > 0, UpError::SeedRequired);

        let creator = &ctx.accounts.creator;
        let mint = &ctx.accounts.mint;
        let launch = &mut ctx.accounts.launch;
        let mint_key = mint.key();

        // during a climb the creator seeds through the same gate as everyone
        if climb_seconds > 0 {
            require!(ctx.accounts.creator_attestation.is_some(), UpError::NotAttested);
        }

        // ---- mint (token-2022 + transfer hook pointing at this program) ----
        let mint_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(
            &[ExtensionType::TransferHook],
        )?;
        let rent = Rent::get()?;
        invoke(
            &system_instruction::create_account(
                &creator.key(),
                &mint.key(),
                rent.minimum_balance(mint_space),
                mint_space as u64,
                &spl_token_2022::ID,
            ),
            &[creator.to_account_info(), mint.to_account_info(), ctx.accounts.system_program.to_account_info()],
        )?;
        invoke(
            &spl_token_2022::extension::transfer_hook::instruction::initialize(
                &spl_token_2022::ID,
                &mint.key(),
                None, // hook program is immutable — no update authority
                Some(crate::ID),
            )?,
            &[mint.to_account_info()],
        )?;
        invoke(
            &spl_token_2022::instruction::initialize_mint2(
                &spl_token_2022::ID,
                &mint.key(),
                &ctx.accounts.vault_authority.key(),
                None,
                6,
            )?,
            &[mint.to_account_info()],
        )?;

        // ---- curve token account (PDA, owned by vault authority) ----
        let curve_bump = ctx.bumps.curve_token_account;
        let curve_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve_bump]];
        invoke_signed(
            &system_instruction::create_account(
                &creator.key(),
                &ctx.accounts.curve_token_account.key(),
                rent.minimum_balance(spl_token_2022::state::Account::LEN),
                spl_token_2022::state::Account::LEN as u64,
                &spl_token_2022::ID,
            ),
            &[
                creator.to_account_info(),
                ctx.accounts.curve_token_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[curve_seeds],
        )?;
        invoke(
            &spl_token_2022::instruction::initialize_account3(
                &spl_token_2022::ID,
                &ctx.accounts.curve_token_account.key(),
                &mint.key(),
                &ctx.accounts.vault_authority.key(),
            )?,
            &[
                ctx.accounts.curve_token_account.to_account_info(),
                mint.to_account_info(),
            ],
        )?;

        // ---- transfer-hook extra account metas (resolves the launch PDA) ----
        let metas = [ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"launch".to_vec() },
                // account index 1 in the hook's fixed account list is the mint
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?];
        let metas_size = ExtraAccountMetaList::size_of(metas.len())?;
        let extra_bump = ctx.bumps.extra_metas;
        let extra_seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref(), &[extra_bump]];
        invoke_signed(
            &system_instruction::create_account(
                &creator.key(),
                &ctx.accounts.extra_metas.key(),
                rent.minimum_balance(metas_size),
                metas_size as u64,
                &crate::ID,
            ),
            &[
                creator.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[extra_seeds],
        )?;
        {
            let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
            ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        }

        // ---- SOL vaults (0-data PDAs, funded to the rent floor) ----
        for (vault, bump, seed) in [
            (&ctx.accounts.sol_vault, ctx.bumps.sol_vault, b"solvault".as_ref()),
            (&ctx.accounts.fee_vault, ctx.bumps.fee_vault, b"feevault".as_ref()),
        ] {
            let seeds: &[&[u8]] = &[seed, mint_key.as_ref(), &[bump]];
            invoke_signed(
                &system_instruction::create_account(
                    &creator.key(),
                    &vault.key(),
                    RENT_FLOOR,
                    0,
                    &anchor_lang::solana_program::system_program::ID,
                ),
                &[creator.to_account_info(), vault.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[seeds],
            )?;
        }

        // ---- write launch state (before any token transfer fires the hook) ----
        launch.mint = mint.key();
        launch.creator = creator.key();
        launch.curve_token_account = ctx.accounts.curve_token_account.key();
        launch.sol_vault = ctx.accounts.sol_vault.key();
        launch.fee_vault = ctx.accounts.fee_vault.key();
        launch.climb_end = Clock::get()?.unix_timestamp + climb_seconds as i64;
        launch.virtual_sol = VIRTUAL_SOL;
        launch.bump = ctx.bumps.launch;
        launch.vault_bump = ctx.bumps.vault_authority;
        launch.curve_bump = curve_bump;
        launch.sol_vault_bump = ctx.bumps.sol_vault;
        launch.fee_vault_bump = ctx.bumps.fee_vault;

        // ---- mint the full supply to the curve ----
        let vault_bump = ctx.bumps.vault_authority;
        let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[vault_bump]];
        invoke_signed(
            &spl_token_2022::instruction::mint_to(
                &spl_token_2022::ID,
                &mint.key(),
                &ctx.accounts.curve_token_account.key(),
                &ctx.accounts.vault_authority.key(),
                &[],
                TOTAL_SUPPLY,
            )?,
            &[
                mint.to_account_info(),
                ctx.accounts.curve_token_account.to_account_info(),
                ctx.accounts.vault_authority.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // ---- the seed buy: creator buys from the curve like everyone else ----
        let tokens_out = buy_tokens_out(VIRTUAL_SOL, TOTAL_SUPPLY, seed_lamports)?;
        require!(tokens_out >= min_seed_tokens_out, UpError::SlippageExceeded);

        invoke(
            &system_instruction::transfer(&creator.key(), &ctx.accounts.sol_vault.key(), seed_lamports),
            &[creator.to_account_info(), ctx.accounts.sol_vault.to_account_info(), ctx.accounts.system_program.to_account_info()],
        )?;
        transfer_from_curve(
            &ctx.accounts.token_program,
            ctx.accounts.curve_token_account.to_account_info(),
            mint.to_account_info(),
            ctx.accounts.creator_ata.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            hook_accounts(
                ctx.accounts.launch.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.hook_program.to_account_info(),
            ),
            vault_seeds,
            tokens_out,
        )?;

        Ok(())
    }

    /// buy during the open market — or during the climb with an attestation.
    pub fn buy(ctx: Context<Trade>, lamports: u64, min_tokens_out: u64) -> Result<()> {
        let launch = &ctx.accounts.launch;
        let now = Clock::get()?.unix_timestamp;
        if now < launch.climb_end {
            require!(ctx.accounts.attestation.is_some(), UpError::NotAttested);
        }
        require!(lamports > 0, UpError::ZeroAmount);

        let fee = lamports * FEE_BPS / 10_000;
        let dx = lamports - fee;

        // reserves before this trade's lamports land
        let x = reserve_sol(launch, ctx.accounts.sol_vault.lamports());
        let y = ctx.accounts.curve_token_account.amount;
        let tokens_out = buy_tokens_out(x, y, dx)?;
        require!(tokens_out >= min_tokens_out, UpError::SlippageExceeded);

        let buyer = &ctx.accounts.trader;
        invoke(
            &system_instruction::transfer(&buyer.key(), &launch.sol_vault, dx),
            &[buyer.to_account_info(), ctx.accounts.sol_vault.to_account_info(), ctx.accounts.system_program.to_account_info()],
        )?;
        if fee > 0 {
            invoke(
                &system_instruction::transfer(&buyer.key(), &launch.fee_vault, fee),
                &[buyer.to_account_info(), ctx.accounts.fee_vault.to_account_info(), ctx.accounts.system_program.to_account_info()],
            )?;
        }

        let vault_seeds: &[&[u8]] = &[b"vault", launch.mint.as_ref(), &[launch.vault_bump]];
        transfer_from_curve(
            &ctx.accounts.token_program,
            ctx.accounts.curve_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.trader_ata.to_account_info(),
            ctx.accounts.vault_authority.to_account_info(),
            hook_accounts(
                ctx.accounts.launch.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.hook_program.to_account_info(),
            ),
            vault_seeds,
            tokens_out,
        )
    }

    /// sell back to the curve. sells are never gated — the climb gates
    /// acquisition, not exit.
    pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_out: u64) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(token_amount > 0, UpError::ZeroAmount);

        // reserves before this trade's tokens land
        let x = reserve_sol(launch, ctx.accounts.sol_vault.lamports());
        let y = ctx.accounts.curve_token_account.amount;
        let sol_out = sell_sol_out(x, y, token_amount)?;
        let fee = sol_out * FEE_BPS / 10_000;
        let payout = sol_out - fee;
        require!(payout >= min_sol_out, UpError::SlippageExceeded);
        require!(
            ctx.accounts.sol_vault.lamports() >= RENT_FLOOR + sol_out,
            UpError::InsufficientLiquidity
        );

        // tokens in — trader signs; the hook allows curve-bound transfers
        token_2022::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.trader_ata.to_account_info(),
                    to: ctx.accounts.curve_token_account.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            )
            .with_remaining_accounts(hook_accounts(
                ctx.accounts.launch.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.hook_program.to_account_info(),
            )),
            token_amount,
            6,
        )?;

        // SOL out — vault PDA signs via the system program
        let seeds: &[&[u8]] = &[b"solvault", launch.mint.as_ref(), &[launch.sol_vault_bump]];
        invoke_signed(
            &system_instruction::transfer(&launch.sol_vault, &ctx.accounts.trader.key(), payout),
            &[
                ctx.accounts.sol_vault.to_account_info(),
                ctx.accounts.trader.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        if fee > 0 {
            invoke_signed(
                &system_instruction::transfer(&launch.sol_vault, &launch.fee_vault, fee),
                &[
                    ctx.accounts.sol_vault.to_account_info(),
                    ctx.accounts.fee_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }
        Ok(())
    }

    /// anyone can crank the payout: fee vault always splits 50/50 between the
    /// creator and the protocol vault.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let launch = &ctx.accounts.launch;
        let balance = ctx.accounts.fee_vault.lamports();
        let claimable = balance.saturating_sub(RENT_FLOOR);
        require!(claimable > 0, UpError::NothingToClaim);

        let half = claimable / 2;
        let seeds: &[&[u8]] = &[b"feevault", launch.mint.as_ref(), &[launch.fee_vault_bump]];
        invoke_signed(
            &system_instruction::transfer(&launch.fee_vault, &launch.creator, half),
            &[
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::transfer(&launch.fee_vault, &ctx.accounts.config.protocol_vault, claimable - half),
            &[
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.protocol_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }

    /// SPL transfer-hook interface entrypoint. the `#[interface]` attribute
    /// overrides the instruction discriminator with the one token-2022 calls
    /// (sha256("spl-transfer-hook-interface:execute")[..8], NOT the anchor
    /// default). during the climb, tokens may only move to or from the
    /// curve — buys and sells through the program. after it ends, everything
    /// moves freely.
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn execute(ctx: Context<ExecuteHook>, _amount: u64) -> Result<()> {
        let launch = &ctx.accounts.launch;
        let now = Clock::get()?.unix_timestamp;
        if now < launch.climb_end {
            require!(
                ctx.accounts.source.key() == launch.curve_token_account
                    || ctx.accounts.destination.key() == launch.curve_token_account,
                UpError::ClimbTransfersLocked
            );
        }
        Ok(())
    }
}

// ---------- curve math (constant product over virtual + real reserves) ----------

fn buy_tokens_out(x: u64, y: u64, dx: u64) -> Result<u64> {
    let (x, y, dx) = (x as u128, y as u128, dx as u128);
    let out = y
        .checked_sub(x.checked_mul(y).ok_or(UpError::MathOverflow)?.checked_div(x + dx).ok_or(UpError::MathOverflow)?)
        .ok_or(UpError::MathOverflow)?;
    Ok(u64::try_from(out).map_err(|_| UpError::MathOverflow)?)
}

fn sell_sol_out(x: u64, y: u64, dy: u64) -> Result<u64> {
    let (x, y, dy) = (x as u128, y as u128, dy as u128);
    let out = x
        .checked_sub(x.checked_mul(y).ok_or(UpError::MathOverflow)?.checked_div(y + dy).ok_or(UpError::MathOverflow)?)
        .ok_or(UpError::MathOverflow)?;
    Ok(u64::try_from(out).map_err(|_| UpError::MathOverflow)?)
}

/// effective SOL side of the curve: virtual offset + real lamports above the rent floor.
fn reserve_sol(launch: &Launch, vault_lamports: u64) -> u64 {
    launch.virtual_sol + vault_lamports.saturating_sub(RENT_FLOOR)
}

fn transfer_from_curve<'info>(
    token_program: &Program<'info, Token2022>,
    curve: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    vault_authority: AccountInfo<'info>,
    hook_accounts: Vec<AccountInfo<'info>>,
    vault_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: curve,
                to,
                authority: vault_authority,
                mint,
            },
            &[vault_seeds],
        )
        .with_remaining_accounts(hook_accounts),
        amount,
        6,
    )
}

/// the accounts every token-2022 transfer of an up.meme mint must append so
/// the token program can re-enter this program's transfer hook: resolved
/// extra accounts first (the launch PDA), then the extra-account-metas
/// validation state, then the hook program itself. mirrors the append order
/// of spl-transfer-hook-interface's onchain helper.
fn hook_accounts<'info>(
    launch: AccountInfo<'info>,
    extra_metas: AccountInfo<'info>,
    hook_program: AccountInfo<'info>,
) -> Vec<AccountInfo<'info>> {
    vec![launch, extra_metas, hook_program]
}

// ---------- account contexts ----------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::LEN, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAttestationAuthority<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct CreateAttestation<'info> {
    #[account(mut, address = config.attestation_authority)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Attestation::LEN, seeds = [b"attest", wallet.as_ref()], bump)]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LaunchCtx<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// fresh keypair generated client-side per launch
    #[account(mut)]
    pub mint: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Launch::LEN, seeds = [b"launch", mint.key().as_ref()], bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: mint authority + transfer signer, PDA with no data
    #[account(seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: created in-handler (token account owned by vault_authority)
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve_token_account: UncheckedAccount<'info>,
    /// CHECK: 0-data SOL vault, created in-handler
    #[account(mut, seeds = [b"solvault", mint.key().as_ref()], bump)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: 0-data fee vault, created in-handler
    #[account(mut, seeds = [b"feevault", mint.key().as_ref()], bump)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: transfer-hook extra account metas, created in-handler
    #[account(mut, seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    /// CHECK: this program's executable account — appended to token CPIs so
    /// token-2022 can re-enter the transfer hook
    #[account(address = crate::ID)]
    pub hook_program: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_ata: InterfaceAccount<'info, TokenAccount>,
    /// required when climb_seconds > 0 — checked in-handler
    #[account(seeds = [b"attest", creator.key().as_ref()], bump)]
    pub creator_attestation: Option<Account<'info, Attestation>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [b"launch", mint.key().as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut, address = launch.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = launch.curve_token_account)]
    pub curve_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = trader,
        associated_token::mint = mint,
        associated_token::authority = trader,
        associated_token::token_program = token_program,
    )]
    pub trader_ata: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: mint authority PDA, seeds checked
    #[account(seeds = [b"vault", mint.key().as_ref()], bump = launch.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: SOL vault PDA, address checked against launch state
    #[account(mut, address = launch.sol_vault)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: fee vault PDA, address checked against launch state
    #[account(mut, address = launch.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: transfer-hook extra account metas for this mint
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    /// CHECK: this program's executable account — appended to token CPIs so
    /// token-2022 can re-enter the transfer hook
    #[account(address = crate::ID)]
    pub hook_program: UncheckedAccount<'info>,
    /// required while the climb is open — checked in-handler
    #[account(seeds = [b"attest", trader.key().as_ref()], bump)]
    pub attestation: Option<Account<'info, Attestation>>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: fee vault, address checked against launch state
    #[account(mut, address = launch.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: payout destination taken from launch state — no signature needed
    #[account(mut, address = launch.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: payout destination taken from config — no signature needed
    #[account(mut, address = config.protocol_vault)]
    pub protocol_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// fixed account order dictated by the token-2022 transfer-hook CPI.
#[derive(Accounts)]
pub struct ExecuteHook<'info> {
    /// CHECK: source token account — validated by the token program
    pub source: UncheckedAccount<'info>,
    /// CHECK: the mint — linked to the launch PDA via seeds
    pub mint: UncheckedAccount<'info>,
    /// CHECK: destination token account — validated by the token program
    pub destination: UncheckedAccount<'info>,
    /// CHECK: transfer authority — validated by the token program
    pub owner: UncheckedAccount<'info>,
    /// CHECK: extra account metas list for this mint
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    #[account(seeds = [b"launch", mint.key().as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
}

#[error_code]
pub enum UpError {
    #[msg("wallet is not attested — a pump.fun profile is required during the climb")]
    NotAttested,
    #[msg("slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("curve math overflow")]
    MathOverflow,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("insufficient SOL liquidity in the curve")]
    InsufficientLiquidity,
    #[msg("nothing to claim yet")]
    NothingToClaim,
    #[msg("transfers are locked during the climb — buys and sells go through the curve only")]
    ClimbTransfersLocked,
    #[msg("a seed buy is required — one wallet deploys, one wallet seeds")]
    SeedRequired,
}
