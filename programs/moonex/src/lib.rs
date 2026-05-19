//! Moonex — CLOB perpetuals DEX on Solana (native program).

#![deny(unsafe_op_in_unsafe_fn)]

pub mod account_utils;
pub mod error;
pub mod instruction;
pub mod math;
pub mod pda;
pub mod processor;
pub mod state;
pub mod token;

use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey,
};

solana_program::declare_id!("GawUJQ4vdnxeRzbnkwJsMAb1hVSh9qpXpeyvn9nXxZ72");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::Processor::process(program_id, accounts, instruction_data)
}
