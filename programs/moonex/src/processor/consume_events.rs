use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
};

use crate::{
    account_utils::{assert_account_size, assert_owned_by},
    error::MoonexError,
    instruction::ConsumeEventsArgs,
    math::{base_locked, quote_locked},
    state::{AccountTag, EventQueue, Market, OpenOrders, MAX_EVENTS},
};

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: ConsumeEventsArgs,
) -> ProgramResult {
    msg!("Moonex: ConsumeEvents");
    let mut iter = accounts.iter();
    let market_ai = next_account_info(&mut iter)?;
    let event_queue_ai = next_account_info(&mut iter)?;

    assert_owned_by(market_ai, program_id)?;
    assert_owned_by(event_queue_ai, program_id)?;
    assert_account_size(market_ai, Market::SIZE)?;
    assert_account_size(event_queue_ai, EventQueue::SIZE)?;

    let base_lot_size;
    let quote_lot_size;
    {
        let data = market_ai.try_borrow_data()?;
        let m: &Market = bytemuck::from_bytes(&data[..]);
        if m.tag != AccountTag::Market as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if m.event_queue != event_queue_ai.key.to_bytes() {
            return Err(MoonexError::MarketMismatch.into());
        }
        base_lot_size = m.base_lot_size;
        quote_lot_size = m.quote_lot_size;
    }

    // Remaining accounts: maker OpenOrders accounts, in any order. We
    // match each event's `.maker` (owner pubkey) against the
    // OpenOrders.owner of the accounts the caller supplied.
    let maker_accounts: Vec<&AccountInfo> = iter.collect();
    for a in &maker_accounts {
        assert_owned_by(a, program_id)?;
        assert_account_size(a, OpenOrders::SIZE)?;
    }

    let processed = {
        let mut q_data = event_queue_ai.try_borrow_mut_data()?;
        let q: &mut EventQueue = bytemuck::from_bytes_mut(&mut q_data[..]);
        if q.tag != AccountTag::EventQueue as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }

        let cap = (args.max_events as u32).min(q.count);
        let mut applied = 0u32;
        while applied < cap {
            let head = q.head as usize;
            let event = q.events[head];

            // Find the matching maker OO.
            let mut found = false;
            for a in &maker_accounts {
                let mut oo_data = a.try_borrow_mut_data()?;
                let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut oo_data[..]);
                if oo.tag != AccountTag::OpenOrders as u8 {
                    continue;
                }
                if oo.owner != event.maker {
                    continue;
                }
                if oo.market != market_ai.key.to_bytes() {
                    continue;
                }
                // Apply the fill to the maker.
                let fill_base = base_locked(event.size_lots, base_lot_size)?;
                let fill_quote =
                    quote_locked(event.price_lots, event.size_lots, quote_lot_size)?;
                let slot = &mut oo.slots[event.maker_slot as usize];
                if event.taker_side == 0 /* Bid taker */ {
                    // Maker on ask side: base_locked → quote_free.
                    // saturating_sub guards against legacy on-chain
                    // accounting drift (e.g. queued events that
                    // pre-date a lock-tracking fix) so a single bad
                    // event can't wedge the whole queue.
                    oo.base_locked = oo.base_locked.saturating_sub(fill_base);
                    oo.quote_free = oo
                        .quote_free
                        .checked_add(fill_quote)
                        .ok_or(MoonexError::MathOverflow)?;
                } else {
                    // Maker on bid side: quote_locked → base_free.
                    oo.quote_locked = oo.quote_locked.saturating_sub(fill_quote);
                    oo.base_free = oo
                        .base_free
                        .checked_add(fill_base)
                        .ok_or(MoonexError::MathOverflow)?;
                }
                if slot.is_used != 0 && slot.seq == event.maker_seq {
                    slot.size_lots = slot.size_lots.saturating_sub(event.size_lots);
                    if slot.size_lots == 0 {
                        oo.release_slot(event.maker_slot)?;
                    }
                }
                found = true;
                break;
            }

            if !found {
                // The caller didn't provide this maker's OO — pause
                // here. Returning Ok lets partial progress commit; if
                // *nothing* progressed the caller still sees that as a
                // no-op (`consumed 0 events`) and can retry with the
                // right account list. Earlier we returned an error,
                // which trashed any forward progress made so far.
                break;
            }

            q.head = ((q.head as usize + 1) % MAX_EVENTS) as u32;
            q.count = q.count.checked_sub(1).ok_or(MoonexError::MathOverflow)?;
            applied += 1;
        }
        applied
    };

    msg!("consumed {} events", processed);
    Ok(())
}
