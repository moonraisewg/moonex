use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

use crate::{
    account_utils::{
        assert_account_size, assert_address, assert_owned_by, assert_signer, assert_writable,
    },
    error::MoonexError,
    instruction::{OrderType, PlaceOrderArgs, Side},
    math::{assert_tick_aligned, base_locked, quote_locked},
    pda,
    state::{
        AccountTag, BookSide, EventQueue, FillEvent, Market, OpenOrders, OrderNode, MAX_EVENTS,
    },
    token,
};

const MAX_FILLS_PER_PLACE: u32 = 8;

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: PlaceOrderArgs,
) -> ProgramResult {
    msg!("Moonex: PlaceOrder");
    if args.price_lots == 0 {
        return Err(MoonexError::ZeroPrice.into());
    }
    if args.size_lots == 0 {
        return Err(MoonexError::ZeroSize.into());
    }

    let ai = &mut accounts.iter();
    let market_ai = next_account_info(ai)?;
    let owner_ai = next_account_info(ai)?;
    let open_orders_ai = next_account_info(ai)?;
    let bids_ai = next_account_info(ai)?;
    let asks_ai = next_account_info(ai)?;
    let event_queue_ai = next_account_info(ai)?;
    let base_vault_ai = next_account_info(ai)?;
    let quote_vault_ai = next_account_info(ai)?;
    let user_base_ai = next_account_info(ai)?;
    let user_quote_ai = next_account_info(ai)?;
    let vault_signer_ai = next_account_info(ai)?;
    let token_program_ai = next_account_info(ai)?;

    assert_signer(owner_ai)?;
    assert_writable(market_ai)?;
    assert_writable(open_orders_ai)?;
    assert_writable(bids_ai)?;
    assert_writable(asks_ai)?;
    assert_writable(event_queue_ai)?;
    assert_writable(base_vault_ai)?;
    assert_writable(quote_vault_ai)?;
    assert_writable(user_base_ai)?;
    assert_writable(user_quote_ai)?;

    assert_owned_by(market_ai, program_id)?;
    assert_owned_by(open_orders_ai, program_id)?;
    assert_owned_by(bids_ai, program_id)?;
    assert_owned_by(asks_ai, program_id)?;
    assert_owned_by(event_queue_ai, program_id)?;
    token::assert_token_program(token_program_ai)?;

    assert_account_size(market_ai, Market::SIZE)?;
    assert_account_size(open_orders_ai, OpenOrders::SIZE)?;
    assert_account_size(bids_ai, BookSide::SIZE)?;
    assert_account_size(asks_ai, BookSide::SIZE)?;
    assert_account_size(event_queue_ai, EventQueue::SIZE)?;

    let side_is_bid = args.side.is_bid();

    let tick_size;
    let base_lot_size;
    let quote_lot_size;
    let vault_signer_bump;
    let seq;
    {
        let mut data = market_ai.try_borrow_mut_data()?;
        let m: &mut Market = bytemuck::from_bytes_mut(&mut data[..]);
        if m.tag != AccountTag::Market as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if m.bids != bids_ai.key.to_bytes() || m.asks != asks_ai.key.to_bytes() {
            return Err(MoonexError::MarketMismatch.into());
        }
        if m.event_queue != event_queue_ai.key.to_bytes() {
            return Err(MoonexError::MarketMismatch.into());
        }
        if m.base_vault != base_vault_ai.key.to_bytes()
            || m.quote_vault != quote_vault_ai.key.to_bytes()
        {
            return Err(MoonexError::VaultMismatch.into());
        }
        tick_size = m.tick_size;
        base_lot_size = m.base_lot_size;
        quote_lot_size = m.quote_lot_size;
        vault_signer_bump = m.vault_signer_bump;
        seq = m.next_order_seq;
        m.next_order_seq = seq.checked_add(1).ok_or(MoonexError::MathOverflow)?;
    }

    let (expected_signer, derived_bump) = pda::find_vault_signer(program_id, market_ai.key);
    assert_address(vault_signer_ai, &expected_signer)?;
    if derived_bump != vault_signer_bump {
        return Err(MoonexError::InvalidPda.into());
    }

    assert_tick_aligned(args.price_lots, tick_size)?;

    let opposite_ai = if side_is_bid { asks_ai } else { bids_ai };
    let book_ai = if side_is_bid { bids_ai } else { asks_ai };
    let expected_opp_tag = if side_is_bid {
        AccountTag::Asks as u8
    } else {
        AccountTag::Bids as u8
    };
    let expected_book_tag = if side_is_bid {
        AccountTag::Bids as u8
    } else {
        AccountTag::Asks as u8
    };

    let owner_key = owner_ai.key.to_bytes();
    // Tallies; bid taker gets base back, ask taker gets quote back.
    let mut refund_base: u64 = 0;
    let mut refund_quote: u64 = 0;
    let mut fill_base_total: u64 = 0;
    let mut fill_quote_total: u64 = 0;
    let mut remaining = args.size_lots;
    let mut had_any_fill = false;

    // Matching with self-trade prevention. We never cancel or fill our own
    // resting orders — they stay on the book to wait for a non-self taker.
    // The scan steps past any own makers and only fills against external
    // makers whose price still crosses the taker's limit.
    {
        let mut opp_data = opposite_ai.try_borrow_mut_data()?;
        let opp: &mut BookSide = bytemuck::from_bytes_mut(&mut opp_data[..]);
        if opp.tag != expected_opp_tag {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        let mut q_data = event_queue_ai.try_borrow_mut_data()?;
        let q: &mut EventQueue = bytemuck::from_bytes_mut(&mut q_data[..]);
        if q.tag != AccountTag::EventQueue as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        let mut oo_data = open_orders_ai.try_borrow_mut_data()?;
        let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut oo_data[..]);
        if oo.tag != AccountTag::OpenOrders as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if oo.market != market_ai.key.to_bytes() {
            return Err(MoonexError::MarketMismatch.into());
        }
        if oo.owner != owner_key {
            return Err(MoonexError::OwnerMismatch.into());
        }
        let _ = oo; // keep the borrow alive for the duration of the scan

        let mut fills = 0u32;
        let mut i = 0usize;
        while remaining > 0 && i < opp.len as usize && fills < MAX_FILLS_PER_PLACE {
            let maker = opp.orders[i];
            let crosses = if side_is_bid {
                args.price_lots >= maker.price_lots
            } else {
                args.price_lots <= maker.price_lots
            };
            if !crosses {
                break;
            }
            if maker.owner == owner_key {
                // Self-trade prevention: leave the order on the book and
                // walk past it. The taker may still rest at the same or
                // worse price afterwards.
                i += 1;
                continue;
            }
            let fill_size = remaining.min(maker.size_lots);
            let fill_price = maker.price_lots;
            let fill_base = base_locked(fill_size, base_lot_size)?;
            let fill_quote = quote_locked(fill_price, fill_size, quote_lot_size)?;

            // Record event for maker-side settlement via ConsumeEvents.
            if (q.count as usize) >= MAX_EVENTS {
                return Err(MoonexError::EventQueueFull.into());
            }
            let tail = ((q.head as usize) + (q.count as usize)) % MAX_EVENTS;
            q.events[tail] = FillEvent {
                price_lots: fill_price,
                size_lots: fill_size,
                maker_seq: maker.seq,
                maker: maker.owner,
                taker: owner_key,
                maker_slot: maker.owner_slot,
                taker_side: args.side.as_u8(),
                _pad: [0; 6],
            };
            q.count = q.count.checked_add(1).ok_or(MoonexError::MathOverflow)?;

            // Mutate the maker's book entry; remove it if fully filled.
            // When we don't remove, advance past it so the next iteration
            // examines the next entry at the same index after the shift.
            if fill_size == maker.size_lots {
                opp.remove_at(i)?;
                // do not increment `i` — the row that was at i+1 moved up
            } else {
                opp.orders[i].size_lots = maker.size_lots - fill_size;
                i += 1;
            }

            remaining = remaining
                .checked_sub(fill_size)
                .ok_or(MoonexError::MathOverflow)?;
            if side_is_bid {
                refund_base = refund_base
                    .checked_add(fill_base)
                    .ok_or(MoonexError::MathOverflow)?;
                fill_quote_total = fill_quote_total
                    .checked_add(fill_quote)
                    .ok_or(MoonexError::MathOverflow)?;
            } else {
                refund_quote = refund_quote
                    .checked_add(fill_quote)
                    .ok_or(MoonexError::MathOverflow)?;
                fill_base_total = fill_base_total
                    .checked_add(fill_base)
                    .ok_or(MoonexError::MathOverflow)?;
            }
            had_any_fill = true;
            fills += 1;
        }
    }

    // PostOnly: any fill at all → reject (transaction reverts).
    if matches!(args.order_type, OrderType::PostOnly) && had_any_fill {
        return Err(MoonexError::PostOnlyWouldFill.into());
    }

    let rests = remaining > 0
        && !matches!(
            args.order_type,
            OrderType::ImmediateOrCancel | OrderType::FillOrKill
        );

    // Original upfront lock at the taker's limit price.
    let original_lock = match args.side {
        Side::Bid => quote_locked(args.price_lots, args.size_lots, quote_lot_size)?,
        Side::Ask => base_locked(args.size_lots, base_lot_size)?,
    };
    let rest_lock = if rests {
        match args.side {
            Side::Bid => quote_locked(args.price_lots, remaining, quote_lot_size)?,
            Side::Ask => base_locked(remaining, base_lot_size)?,
        }
    } else {
        0
    };

    // Excess of the upfront lock that isn't consumed by fills or held as
    // the resting portion. Comes back to the user as a single CPI below.
    let excess = match args.side {
        Side::Bid => original_lock
            .checked_sub(fill_quote_total)
            .and_then(|v| v.checked_sub(rest_lock))
            .ok_or(MoonexError::MathOverflow)?,
        Side::Ask => original_lock
            .checked_sub(fill_base_total)
            .and_then(|v| v.checked_sub(rest_lock))
            .ok_or(MoonexError::MathOverflow)?,
    };
    if side_is_bid {
        refund_quote = refund_quote
            .checked_add(excess)
            .ok_or(MoonexError::MathOverflow)?;
    } else {
        refund_base = refund_base
            .checked_add(excess)
            .ok_or(MoonexError::MathOverflow)?;
    }

    // If we're resting, claim an OO slot + insert into our own side.
    if rests {
        let slot_idx;
        {
            let mut oo_data = open_orders_ai.try_borrow_mut_data()?;
            let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut oo_data[..]);
            slot_idx = oo.claim_slot()?;
            let slot = &mut oo.slots[slot_idx as usize];
            slot.side = args.side.as_u8();
            slot.price_lots = args.price_lots;
            slot.size_lots = remaining;
            slot.seq = seq;
            slot.client_order_id = args.client_order_id;
            match args.side {
                Side::Bid => {
                    oo.quote_locked = oo
                        .quote_locked
                        .checked_add(rest_lock)
                        .ok_or(MoonexError::MathOverflow)?;
                }
                Side::Ask => {
                    oo.base_locked = oo
                        .base_locked
                        .checked_add(rest_lock)
                        .ok_or(MoonexError::MathOverflow)?;
                }
            }
        }
        {
            let mut data = book_ai.try_borrow_mut_data()?;
            let b: &mut BookSide = bytemuck::from_bytes_mut(&mut data[..]);
            if b.tag != expected_book_tag {
                return Err(MoonexError::InvalidAccountTag.into());
            }
            let idx = b.insertion_index(side_is_bid, args.price_lots, seq);
            let node = OrderNode {
                price_lots: args.price_lots,
                size_lots: remaining,
                client_order_id: args.client_order_id,
                seq,
                owner: owner_key,
                owner_slot: slot_idx,
                _pad: [0; 7],
            };
            b.insert(idx, node)?;
        }
    }

    // Token movements: user→vault for the full upfront lock, then
    // vault→user for any refund (self-cancel + fill proceeds + excess).
    let market_key = market_ai.key.to_bytes();
    let bump_arr = [vault_signer_bump];
    let signer_seeds = pda::vault_signer_seeds(&market_key, &bump_arr);

    let (lock_vault, lock_source) = match args.side {
        Side::Bid => (quote_vault_ai, user_quote_ai),
        Side::Ask => (base_vault_ai, user_base_ai),
    };
    token::transfer(
        lock_source,
        lock_vault,
        owner_ai,
        token_program_ai,
        original_lock,
    )?;

    if refund_base > 0 {
        token::transfer_signed(
            base_vault_ai,
            user_base_ai,
            vault_signer_ai,
            token_program_ai,
            refund_base,
            &signer_seeds,
        )?;
    }
    if refund_quote > 0 {
        token::transfer_signed(
            quote_vault_ai,
            user_quote_ai,
            vault_signer_ai,
            token_program_ai,
            refund_quote,
            &signer_seeds,
        )?;
    }

    Ok(())
}
