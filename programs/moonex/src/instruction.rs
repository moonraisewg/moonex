use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::MoonexError;

/// Top-level instruction set dispatched in [`crate::processor::Processor`].
///
/// Discriminant is the first byte of the instruction data; the remaining
/// bytes are the Borsh-encoded payload for the chosen variant.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum MoonexInstruction {
    /// Initialize a new perpetual market.
    InitMarket(InitMarketArgs),
    /// Place a new order on the book.
    PlaceOrder(PlaceOrderArgs),
    /// Cancel an existing order.
    CancelOrder { order_id: u128 },
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct InitMarketArgs {
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub tick_size: u64,
    pub min_base_lot: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PlaceOrderArgs {
    pub side: Side,
    pub price: u64,
    pub size: u64,
    pub order_type: OrderType,
    pub client_order_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Side {
    Bid = 0,
    Ask = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum OrderType {
    Limit = 0,
    PostOnly = 1,
    ImmediateOrCancel = 2,
    FillOrKill = 3,
}

impl MoonexInstruction {
    pub fn try_from_bytes(data: &[u8]) -> Result<Self, MoonexError> {
        if data.is_empty() {
            return Err(MoonexError::InstructionDataTooShort);
        }
        Self::try_from_slice(data).map_err(|_| MoonexError::UnknownInstruction)
    }
}
