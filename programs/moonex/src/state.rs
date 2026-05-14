use bytemuck::{Pod, Zeroable};
use solana_program::pubkey::Pubkey;

/// First byte of every Moonex-owned account, used to tag the layout in
/// place. Adding a new layout reserves a new tag — never reuse values.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountTag {
    Uninitialized = 0,
    Market = 1,
    OrderBook = 2,
    UserPosition = 3,
}

/// Fixed-size perp market header. Order book pages live in separate
/// accounts so the market header stays small and rent-cheap.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Market {
    pub tag: u8,
    pub bump: u8,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub _pad0: [u8; 4],
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub bids: Pubkey,
    pub asks: Pubkey,
    pub event_queue: Pubkey,
    pub vault: Pubkey,
    pub tick_size: u64,
    pub min_base_lot: u64,
    pub open_interest: u64,
    pub funding_index: i128,
    pub last_funding_ts: i64,
    pub _reserved: [u8; 128],
}
