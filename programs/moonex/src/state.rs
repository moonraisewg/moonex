//! Pod-layout, zero-copy state. Field order is chosen so that no
//! implicit padding is inserted — each struct's `size_of` matches its
//! Borsh-style hand-counted size, and bytemuck's `Pod` check passes.
//!
//! We avoid `u128` in Pod structs to keep alignment at 8 bytes, matching
//! Solana's SBF account-data alignment. Order ids are composed by the
//! caller from `(price_lots, seq)` and split back when needed — see
//! [`crate::math::make_order_id`].

use bytemuck::{Pod, Zeroable};

use crate::error::MoonexError;

pub type PubkeyBytes = [u8; 32];

pub const MAX_ORDERS_PER_SIDE: usize = 256;
pub const MAX_OPEN_ORDERS_PER_USER: usize = 32;
pub const MAX_EVENTS: usize = 256;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountTag {
    Uninitialized = 0,
    Market = 1,
    Bids = 2,
    Asks = 3,
    OpenOrders = 4,
    EventQueue = 5,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Market {
    pub tick_size: u64,
    pub base_lot_size: u64,
    pub quote_lot_size: u64,
    pub next_order_seq: u64,
    pub authority: PubkeyBytes,
    pub base_mint: PubkeyBytes,
    pub quote_mint: PubkeyBytes,
    pub base_vault: PubkeyBytes,
    pub quote_vault: PubkeyBytes,
    pub bids: PubkeyBytes,
    pub asks: PubkeyBytes,
    pub event_queue: PubkeyBytes,
    pub tag: u8,
    pub vault_signer_bump: u8,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub _pad0: [u8; 4],
    pub _reserved: [u8; 128],
}

impl Market {
    pub const SIZE: usize = core::mem::size_of::<Self>();
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OrderNode {
    pub price_lots: u64,
    pub size_lots: u64,
    pub client_order_id: u64,
    pub seq: u64,
    pub owner: PubkeyBytes,
    pub owner_slot: u8,
    pub _pad: [u8; 7],
}

impl OrderNode {
    pub const EMPTY: OrderNode = OrderNode {
        price_lots: 0,
        size_lots: 0,
        client_order_id: 0,
        seq: 0,
        owner: [0; 32],
        owner_slot: 0,
        _pad: [0; 7],
    };
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BookSide {
    pub orders: [OrderNode; MAX_ORDERS_PER_SIDE],
    pub len: u64,
    pub tag: u8,
    pub side: u8,
    pub _pad: [u8; 6],
}

impl BookSide {
    pub const SIZE: usize = core::mem::size_of::<Self>();

    /// Ascending sort key. Bid side is sorted by `!price_lots` so the
    /// best (highest) bid lives at index 0; ask side uses `price_lots`
    /// directly so the best (lowest) ask lives at index 0.
    fn price_key(side_is_bid: bool, price_lots: u64) -> u64 {
        if side_is_bid { !price_lots } else { price_lots }
    }

    fn cmp_at(&self, side_is_bid: bool, idx: usize, price_lots: u64, seq: u64) -> core::cmp::Ordering {
        let here = (
            Self::price_key(side_is_bid, self.orders[idx].price_lots),
            self.orders[idx].seq,
        );
        here.cmp(&(Self::price_key(side_is_bid, price_lots), seq))
    }

    pub fn insertion_index(&self, side_is_bid: bool, price_lots: u64, seq: u64) -> usize {
        let len = self.len as usize;
        let mut lo = 0usize;
        let mut hi = len;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.cmp_at(side_is_bid, mid, price_lots, seq) == core::cmp::Ordering::Less {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    pub fn insert(&mut self, idx: usize, node: OrderNode) -> Result<(), MoonexError> {
        let len = self.len as usize;
        if len >= MAX_ORDERS_PER_SIDE {
            return Err(MoonexError::BookFull);
        }
        if idx > len {
            return Err(MoonexError::OrderNotFound);
        }
        let mut i = len;
        while i > idx {
            self.orders[i] = self.orders[i - 1];
            i -= 1;
        }
        self.orders[idx] = node;
        self.len += 1;
        Ok(())
    }

    pub fn remove_at(&mut self, idx: usize) -> Result<OrderNode, MoonexError> {
        let len = self.len as usize;
        if idx >= len {
            return Err(MoonexError::OrderNotFound);
        }
        let removed = self.orders[idx];
        let mut i = idx;
        while i + 1 < len {
            self.orders[i] = self.orders[i + 1];
            i += 1;
        }
        self.orders[len - 1] = OrderNode::EMPTY;
        self.len -= 1;
        Ok(removed)
    }

    pub fn find(&self, side_is_bid: bool, price_lots: u64, seq: u64) -> Option<usize> {
        let len = self.len as usize;
        let mut lo = 0usize;
        let mut hi = len;
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.cmp_at(side_is_bid, mid, price_lots, seq) {
                core::cmp::Ordering::Less => lo = mid + 1,
                core::cmp::Ordering::Greater => hi = mid,
                core::cmp::Ordering::Equal => return Some(mid),
            }
        }
        None
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OpenOrderSlot {
    pub price_lots: u64,
    pub size_lots: u64,
    pub client_order_id: u64,
    pub seq: u64,
    pub is_used: u8,
    pub side: u8,
    pub _pad: [u8; 6],
}

impl OpenOrderSlot {
    pub const EMPTY: OpenOrderSlot = OpenOrderSlot {
        price_lots: 0,
        size_lots: 0,
        client_order_id: 0,
        seq: 0,
        is_used: 0,
        side: 0,
        _pad: [0; 6],
    };
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct OpenOrders {
    pub slots: [OpenOrderSlot; MAX_OPEN_ORDERS_PER_USER],
    pub base_free: u64,
    pub quote_free: u64,
    pub base_locked: u64,
    pub quote_locked: u64,
    pub market: PubkeyBytes,
    pub owner: PubkeyBytes,
    pub tag: u8,
    pub _pad: [u8; 7],
}

impl OpenOrders {
    pub const SIZE: usize = core::mem::size_of::<Self>();

    pub fn claim_slot(&mut self) -> Result<u8, MoonexError> {
        for (i, slot) in self.slots.iter_mut().enumerate() {
            if slot.is_used == 0 {
                slot.is_used = 1;
                return Ok(i as u8);
            }
        }
        Err(MoonexError::OpenOrdersFull)
    }

    pub fn release_slot(&mut self, idx: u8) -> Result<(), MoonexError> {
        let i = idx as usize;
        let slot = self
            .slots
            .get_mut(i)
            .ok_or(MoonexError::OrderNotFound)?;
        if slot.is_used == 0 {
            return Err(MoonexError::OrderNotFound);
        }
        *slot = OpenOrderSlot::EMPTY;
        Ok(())
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct FillEvent {
    pub price_lots: u64,
    pub size_lots: u64,
    pub maker_seq: u64,
    pub maker: PubkeyBytes,
    pub taker: PubkeyBytes,
    pub maker_slot: u8,
    pub taker_side: u8,
    pub _pad: [u8; 6],
}

impl FillEvent {
    pub const EMPTY: FillEvent = FillEvent {
        price_lots: 0,
        size_lots: 0,
        maker_seq: 0,
        maker: [0; 32],
        taker: [0; 32],
        maker_slot: 0,
        taker_side: 0,
        _pad: [0; 6],
    };
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct EventQueue {
    pub events: [FillEvent; MAX_EVENTS],
    pub seq: u64,
    pub head: u32,
    pub count: u32,
    pub tag: u8,
    pub _pad: [u8; 7],
}

impl EventQueue {
    pub const SIZE: usize = core::mem::size_of::<Self>();
}
