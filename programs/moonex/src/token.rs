//! Hand-rolled SPL Token CPIs so we don't pull the `spl-token` crate.
//!
//! Discriminants follow the SPL Token v3 binary layout. Only `Transfer`
//! (discriminant 3) is exposed today; add new variants as needed.

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
};

use crate::error::MoonexError;

/// SPL Token program id (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const TRANSFER_DISCRIMINANT: u8 = 3;

pub fn assert_token_program(account: &AccountInfo) -> Result<(), MoonexError> {
    if *account.key != TOKEN_PROGRAM_ID {
        return Err(MoonexError::InvalidTokenProgram);
    }
    Ok(())
}

fn build_transfer_ix(
    source: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(TRANSFER_DISCRIMINANT);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn transfer<'a>(
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let ix = build_transfer_ix(source.key, destination.key, authority.key, amount);
    invoke(
        &ix,
        &[source.clone(), destination.clone(), authority.clone(), token_program.clone()],
    )
}

pub fn transfer_signed<'a>(
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let ix = build_transfer_ix(source.key, destination.key, authority.key, amount);
    invoke_signed(
        &ix,
        &[source.clone(), destination.clone(), authority.clone(), token_program.clone()],
        &[signer_seeds],
    )
}
