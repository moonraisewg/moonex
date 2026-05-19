use crate::error::MoonexError;

/// Compose an order id from a price (in lots) and a monotonically
/// increasing sequence number.
///
/// Ask side: higher price = larger id, so sorted ascending puts the best
/// (lowest) ask first.
///
/// Bid side: we invert the price (`!price_lots`) so that higher prices
/// sort *before* lower ones in the same ascending order — both sides
/// share one comparator.
pub fn make_order_id(side_is_bid: bool, price_lots: u64, seq: u64) -> u128 {
    let price_key = if side_is_bid { !price_lots } else { price_lots };
    ((price_key as u128) << 64) | (seq as u128)
}

/// Inverse of [`make_order_id`]: recover `(price_lots, seq)` given the
/// side. Cancel handlers receive only the opaque `u128` from the client.
pub fn decompose_order_id(side_is_bid: bool, order_id: u128) -> (u64, u64) {
    let price_key = (order_id >> 64) as u64;
    let seq = order_id as u64;
    let price_lots = if side_is_bid { !price_key } else { price_key };
    (price_lots, seq)
}

pub fn assert_tick_aligned(price_lots: u64, tick_size: u64) -> Result<(), MoonexError> {
    if tick_size == 0 || price_lots % tick_size != 0 {
        return Err(MoonexError::InvalidTick);
    }
    Ok(())
}

/// Quote-token quantity locked by a resting bid: `price_lots * size_lots *
/// quote_lot_size`. Uses u128 to avoid intermediate overflow; caller
/// down-casts only after the final value fits in u64.
pub fn quote_locked(
    price_lots: u64,
    size_lots: u64,
    quote_lot_size: u64,
) -> Result<u64, MoonexError> {
    let raw = (price_lots as u128)
        .checked_mul(size_lots as u128)
        .and_then(|v| v.checked_mul(quote_lot_size as u128))
        .ok_or(MoonexError::MathOverflow)?;
    u64::try_from(raw).map_err(|_| MoonexError::MathOverflow)
}

/// Base-token quantity locked by a resting ask: `size_lots * base_lot_size`.
pub fn base_locked(size_lots: u64, base_lot_size: u64) -> Result<u64, MoonexError> {
    (size_lots as u128)
        .checked_mul(base_lot_size as u128)
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(MoonexError::MathOverflow)
}
