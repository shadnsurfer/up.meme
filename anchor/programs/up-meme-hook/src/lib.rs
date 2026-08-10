//! up-meme-hook — the transfer-gate half of the up.meme launchpad.
//!
//! This is a separate program from `up_meme` by necessity, not preference:
//! the main program initiates curve transfers via token-2022, and token-2022
//! invokes the transfer hook. If the hook were the same program, that CPI
//! chain would be A -> token-2022 -> A — indirect re-entrancy, which the
//! runtime refuses ("Unknown program" from the tombstoned program cache).
//! So the gate lives here: token-2022 only ever calls THIS program, and this
//! program never moves tokens itself.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

// program keypair: anchor/target/deploy/up_meme_hook-keypair.json (gitignored — back it up)
declare_id!("ws45kVaY6HcPrdrT6UP6WorwpviBPjnJbG7yjSkqeHN");

/// the main up_meme program — owner of every launch state account this hook
/// reads. hardcoded: the two programs are deployed as a pair.
const UP_MEME: Pubkey = pubkey!("57RhPQ8nBFrnknZTE4kmm56SSyUA1BysCKA39waoeqaM");

#[program]
pub mod up_meme_hook {
    use super::*;

    /// creates the extra-account-metas PDA for a mint. the main program calls
    /// this via CPI during launch — only this program can sign for its own
    /// PDA. the single resolved extra account is the launch PDA, derived from
    /// the mint passed to every hook invocation.
    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraMetas>) -> Result<()> {
        // two metas, resolved in order on every transfer:
        //   [0] the main program id itself (lands at hook-CPI account index 5)
        //   [1] the launch PDA, derived under the program id found at index 5
        //       — plain new_with_seeds would derive under THIS program, which
        //       owns no launch accounts
        let metas = [
            ExtraAccountMeta::new_with_pubkey(&UP_MEME, false, false)?,
            ExtraAccountMeta::new_external_pda_with_seeds(
                5,
                &[
                    Seed::Literal { bytes: b"launch".to_vec() },
                    // account index 1 in the hook's fixed account list is the mint
                    Seed::AccountKey { index: 1 },
                ],
                false,
                false,
            )?,
        ];
        let metas_size = ExtraAccountMetaList::size_of(metas.len())?;
        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref(), &[ctx.bumps.extra_metas]];
        let rent = Rent::get()?;
        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.extra_metas.key(),
                rent.minimum_balance(metas_size),
                metas_size as u64,
                &crate::ID,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// the gate. during the climb, tokens may only move to or from the curve
    /// token account — i.e. buys and sells through the main program. after
    /// climb_end everything moves freely (and once the main program migrates
    /// the launch, the hook id on the mint is set to None and this program is
    /// never invoked again).
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn execute(ctx: Context<ExecuteHook>, _amount: u64) -> Result<()> {
        let launch = read_launch(&ctx.accounts.launch, &ctx.accounts.mint.key())?;

        let now = Clock::get()?.unix_timestamp;
        if now < launch.climb_end {
            require!(
                ctx.accounts.source.key() == launch.curve_token_account
                    || ctx.accounts.destination.key() == launch.curve_token_account,
                HookError::ClimbTransfersLocked
            );
        }
        Ok(())
    }
}

/// read and fully authenticate the launch account: owned by the main program,
/// correct discriminator, and its address must derive from the mint under the
/// main program id. anything less would let a fake launch account through.
fn read_launch(launch_info: &UncheckedAccount, mint: &Pubkey) -> Result<Launch> {
    require_keys_eq!(*launch_info.owner, UP_MEME, HookError::BadLaunch);
    let data = launch_info.try_borrow_data()?;
    require!(data.len() >= 8 + Launch::LEN, HookError::BadLaunch);
    require!(&data[..8] == Launch::DISCRIMINATOR, HookError::BadLaunch);
    let launch = Launch::try_deserialize(&mut &data[..])?;
    let expected = Pubkey::create_program_address(
        &[b"launch", mint.as_ref(), &[launch.bump]],
        &UP_MEME,
    )
    .map_err(|_| HookError::BadLaunch)?;
    require_keys_eq!(expected, launch_info.key(), HookError::BadLaunch);
    Ok(launch)
}

#[derive(Accounts)]
pub struct InitializeExtraMetas<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: extra-account-metas PDA for this mint, created in-handler
    #[account(mut, seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    /// CHECK: the token-2022 mint this hook serves — no data read here
    pub mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// fixed account order dictated by token-2022's transfer-hook CPI.
#[derive(Accounts)]
pub struct ExecuteHook<'info> {
    /// CHECK: source token account — validated by the token program
    pub source: UncheckedAccount<'info>,
    /// CHECK: the mint — links to the launch PDA, verified in read_launch
    pub mint: UncheckedAccount<'info>,
    /// CHECK: destination token account — validated by the token program
    pub destination: UncheckedAccount<'info>,
    /// CHECK: transfer authority — validated by the token program
    pub owner: UncheckedAccount<'info>,
    /// CHECK: extra account metas list for this mint (PDA of THIS program)
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    /// CHECK: the main up_meme program — resolved by the metas so the launch
    /// PDA derives under the right program id
    #[account(address = UP_MEME)]
    pub up_meme_program: UncheckedAccount<'info>,
    /// CHECK: launch state owned by the main up_meme program — owner,
    /// discriminator, and derived address all verified in read_launch
    pub launch: UncheckedAccount<'info>,
}

/// mirror of the main program's Launch account (up-meme/src/state.rs) —
/// identical field order, so the anchor discriminator ("account:Launch") and
/// borsh layout match. KEEP IN SYNC.
#[account]
pub struct Launch {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub curve_token_account: Pubkey,
    pub sol_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub climb_end: i64,
    pub virtual_sol: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub curve_bump: u8,
    pub sol_vault_bump: u8,
    pub fee_vault_bump: u8,
}

impl Launch {
    pub const LEN: usize = 32 * 5 + 8 + 8 + 1 * 5;
}

#[error_code]
pub enum HookError {
    #[msg("transfers are locked during the climb — buys and sells go through the curve only")]
    ClimbTransfersLocked,
    #[msg("launch account failed authentication (owner, discriminator, or address)")]
    BadLaunch,
}
