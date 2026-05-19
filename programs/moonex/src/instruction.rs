use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::MoonexError;

/// Top-level instruction set dispatched in [`crate::processor::Processor`].
///
/// Discriminant is the first byte of the instruction data; the remaining
/// bytes are the Borsh-encoded payload for the chosen variant.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum MoonexInstruction {
    /// Initialize a new market over pre-allocated accounts.
    InitMarket(InitMarketArgs),
    /// Initialize a per-user open-orders account for an existing market.
    InitOpenOrders,
    /// Place a limit order. P1 supports `OrderType::Limit` only; the field
    /// is reserved for the matching engine in P2.
    PlaceOrder(PlaceOrderArgs),
    /// Cancel a resting order owned by the signer.
    CancelOrder(CancelOrderArgs),
    /// Process queued fill events, applying them to the maker
    /// OpenOrders accounts passed after the queue.
    ConsumeEvents(ConsumeEventsArgs),
    /// Withdraw `base_free` / `quote_free` from the signer's
    /// OpenOrders back into the user's token accounts.
    SettleFunds,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct InitMarketArgs {
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub vault_signer_bump: u8,
    pub _pad: [u8; 5],
    pub tick_size: u64,
    pub base_lot_size: u64,
    pub quote_lot_size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PlaceOrderArgs {
    pub side: Side,
    pub order_type: OrderType,
    pub _pad: [u8; 6],
    pub price_lots: u64,
    pub size_lots: u64,
    pub client_order_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct CancelOrderArgs {
    pub side: Side,
    pub _pad: [u8; 7],
    pub order_id: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ConsumeEventsArgs {
    /// Maximum number of events to pop in this call. Caps compute use;
    /// caller can re-invoke to drain the queue.
    pub max_events: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Side {
    Bid = 0,
    Ask = 1,
}

impl Side {
    pub fn is_bid(self) -> bool {
        matches!(self, Side::Bid)
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
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
