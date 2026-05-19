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
    instruction::{CancelOrderArgs, Side},
    math::{base_locked, decompose_order_id, quote_locked},
    pda,
    state::{AccountTag, BookSide, Market, OpenOrders},
    token,
};

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: CancelOrderArgs,
) -> ProgramResult {
    msg!("Moonex: CancelOrder");
    let ai = &mut accounts.iter();
    let market_ai = next_account_info(ai)?;
    let owner_ai = next_account_info(ai)?;
    let open_orders_ai = next_account_info(ai)?;
    let bids_ai = next_account_info(ai)?;
    let asks_ai = next_account_info(ai)?;
    let base_vault_ai = next_account_info(ai)?;
    let quote_vault_ai = next_account_info(ai)?;
    let user_base_ai = next_account_info(ai)?;
    let user_quote_ai = next_account_info(ai)?;
    let vault_signer_ai = next_account_info(ai)?;
    let token_program_ai = next_account_info(ai)?;

    assert_signer(owner_ai)?;
    assert_writable(open_orders_ai)?;
    assert_writable(bids_ai)?;
    assert_writable(asks_ai)?;
    assert_writable(base_vault_ai)?;
    assert_writable(quote_vault_ai)?;
    assert_writable(user_base_ai)?;
    assert_writable(user_quote_ai)?;

    assert_owned_by(market_ai, program_id)?;
    assert_owned_by(open_orders_ai, program_id)?;
    assert_owned_by(bids_ai, program_id)?;
    assert_owned_by(asks_ai, program_id)?;
    token::assert_token_program(token_program_ai)?;

    assert_account_size(market_ai, Market::SIZE)?;
    assert_account_size(open_orders_ai, OpenOrders::SIZE)?;
    assert_account_size(bids_ai, BookSide::SIZE)?;
    assert_account_size(asks_ai, BookSide::SIZE)?;

    let side_is_bid = args.side.is_bid();
    let (price_lots, seq) = decompose_order_id(side_is_bid, args.order_id);

    let base_lot_size;
    let quote_lot_size;
    let vault_signer_bump;
    {
        let data = market_ai.try_borrow_data()?;
        let m: &Market = bytemuck::from_bytes(&data[..]);
        if m.tag != AccountTag::Market as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if m.bids != bids_ai.key.to_bytes() || m.asks != asks_ai.key.to_bytes() {
            return Err(MoonexError::MarketMismatch.into());
        }
        if m.base_vault != base_vault_ai.key.to_bytes()
            || m.quote_vault != quote_vault_ai.key.to_bytes()
        {
            return Err(MoonexError::VaultMismatch.into());
        }
        base_lot_size = m.base_lot_size;
        quote_lot_size = m.quote_lot_size;
        vault_signer_bump = m.vault_signer_bump;
    }

    let (expected_signer, signer_bump) = pda::find_vault_signer(program_id, market_ai.key);
    assert_address(vault_signer_ai, &expected_signer)?;
    if signer_bump != vault_signer_bump {
        return Err(MoonexError::InvalidPda.into());
    }

    let book_ai = if side_is_bid { bids_ai } else { asks_ai };
    let owner_slot;
    let removed_size;
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let b: &mut BookSide = bytemuck::from_bytes_mut(&mut data[..]);
        let idx = b
            .find(side_is_bid, price_lots, seq)
            .ok_or(MoonexError::OrderNotFound)?;
        if b.orders[idx].owner != owner_ai.key.to_bytes() {
            return Err(MoonexError::OrderOwnerMismatch.into());
        }
        let removed = b.remove_at(idx)?;
        owner_slot = removed.owner_slot;
        removed_size = removed.size_lots;
    }

    let refund_amount;
    let (vault_ai, dest_ai) = match args.side {
        Side::Bid => {
            let amount = quote_locked(price_lots, removed_size, quote_lot_size)?;
            refund_amount = amount;
            (quote_vault_ai, user_quote_ai)
        }
        Side::Ask => {
            let amount = base_locked(removed_size, base_lot_size)?;
            refund_amount = amount;
            (base_vault_ai, user_base_ai)
        }
    };

    {
        let mut data = open_orders_ai.try_borrow_mut_data()?;
        let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut data[..]);
        if oo.tag != AccountTag::OpenOrders as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if oo.owner != owner_ai.key.to_bytes() {
            return Err(MoonexError::OwnerMismatch.into());
        }
        oo.release_slot(owner_slot)?;
        match args.side {
            Side::Bid => {
                oo.quote_locked = oo
                    .quote_locked
                    .checked_sub(refund_amount)
                    .ok_or(MoonexError::MathOverflow)?;
            }
            Side::Ask => {
                oo.base_locked = oo
                    .base_locked
                    .checked_sub(refund_amount)
                    .ok_or(MoonexError::MathOverflow)?;
            }
        }
    }

    let market_key = market_ai.key.to_bytes();
    let bump = [vault_signer_bump];
    let seeds = pda::vault_signer_seeds(&market_key, &bump);
    token::transfer_signed(
        vault_ai,
        dest_ai,
        vault_signer_ai,
        token_program_ai,
        refund_amount,
        &seeds,
    )?;
    Ok(())
}
