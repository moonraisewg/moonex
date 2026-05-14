use num_derive::FromPrimitive;
use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq, FromPrimitive, Error)]
pub enum MoonexError {
    #[error("Instruction data too short")]
    InstructionDataTooShort,
    #[error("Unknown instruction discriminant")]
    UnknownInstruction,
    #[error("Account not signer")]
    MissingSigner,
    #[error("Account not writable")]
    NotWritable,
    #[error("Account owner mismatch")]
    InvalidAccountOwner,
    #[error("PDA derivation mismatch")]
    InvalidPda,
    #[error("Market already initialized")]
    AlreadyInitialized,
    #[error("Market not initialized")]
    NotInitialized,
    #[error("Math overflow")]
    MathOverflow,
}

impl From<MoonexError> for ProgramError {
    fn from(e: MoonexError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
