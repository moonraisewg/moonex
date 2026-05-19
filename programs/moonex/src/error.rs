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
    #[error("Account already initialized")]
    AlreadyInitialized,
    #[error("Account not initialized")]
    NotInitialized,
    #[error("PDA derivation mismatch")]
    InvalidPda,
    #[error("Account size mismatch")]
    InvalidAccountSize,
    #[error("Account tag mismatch")]
    InvalidAccountTag,
    #[error("Market reference mismatch")]
    MarketMismatch,
    #[error("Owner mismatch")]
    OwnerMismatch,
    #[error("Vault account mismatch")]
    VaultMismatch,
    #[error("Token program mismatch")]
    InvalidTokenProgram,
    #[error("Price not tick-aligned")]
    InvalidTick,
    #[error("Size not lot-aligned")]
    InvalidLot,
    #[error("Order size must be non-zero")]
    ZeroSize,
    #[error("Order price must be non-zero")]
    ZeroPrice,
    #[error("Book side is full")]
    BookFull,
    #[error("Open orders slots exhausted")]
    OpenOrdersFull,
    #[error("Order not found")]
    OrderNotFound,
    #[error("Order owner mismatch")]
    OrderOwnerMismatch,
    #[error("Order would cross the book")]
    OrderCrossesBook,
    #[error("Order type not supported in this phase")]
    UnsupportedOrderType,
    #[error("Event queue full")]
    EventQueueFull,
    #[error("PostOnly order would have filled")]
    PostOnlyWouldFill,
    #[error("Maker OpenOrders for queued event not provided")]
    MissingMakerOpenOrders,
    #[error("Math overflow")]
    MathOverflow,
}

impl From<MoonexError> for ProgramError {
    fn from(e: MoonexError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
