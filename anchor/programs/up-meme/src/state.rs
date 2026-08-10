use anchor_lang::prelude::*;

/// 1B tokens, 6 decimals — every launch is identical.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;

/// Virtual SOL offset on the curve. At ~$200/SOL the opening price implies a
/// $5,000 starting market cap (25 SOL / 1B tokens).
pub const VIRTUAL_SOL: u64 = 25_000_000_000;

/// Total trade fee: 1% (100 bps) — split 50/50 creator / protocol.
pub const FEE_BPS: u64 = 100;

/// Rent floor kept in the 0-data SOL vaults so they never get collected.
pub const RENT_FLOOR: u64 = 890_880;

#[account]
pub struct Config {
    /// deployer admin — can rotate the attestation authority
    pub admin: Pubkey,
    /// offchain verifier service pubkey — the only signer allowed to
    /// create attestations (wallets it vouches have a pump.fun profile)
    pub attestation_authority: Pubkey,
    /// receives the protocol's 50% share of fees (buys & burns $UP offchain)
    pub protocol_vault: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 32 + 32 + 32 + 1;
}

#[account]
pub struct Launch {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub curve_token_account: Pubkey,
    pub sol_vault: Pubkey,
    pub fee_vault: Pubkey,
    /// unix timestamp when the climb ends; before this, the transfer hook
    /// only lets tokens move to/from the curve (buys and sells through the
    /// program). after it, the token moves freely.
    pub climb_end: i64,
    pub virtual_sol: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub curve_bump: u8,
    pub sol_vault_bump: u8,
    pub fee_vault_bump: u8,
    /// set by the permissionless `migrate` crank: hook torn down, liquidity
    /// seated in a DAMM v2 pool. buy/sell on the curve stop existing here.
    /// keep LAST and keep the hook program's mirror struct in sync.
    pub migrated: bool,
}

impl Launch {
    pub const LEN: usize = 32 * 5 + 8 + 8 + 1 * 5 + 1;

    pub fn seeds<'a>(mint: &'a Pubkey) -> [&'a [u8]; 2] {
        [b"launch", mint.as_ref()]
    }
}

/// Proof that a wallet has a pump.fun profile, vouched for onchain by the
/// attestation authority. Required to buy while the climb is open.
#[account]
pub struct Attestation {
    pub wallet: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl Attestation {
    pub const LEN: usize = 32 + 8 + 1;
}
