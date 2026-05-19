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
    instruction::InitMarketArgs,
    pda,
    state::{AccountTag, BookSide, EventQueue, Market},
    token::TOKEN_PROGRAM_ID,
};

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: InitMarketArgs,
) -> ProgramResult {
    msg!("Moonex: InitMarket");
    let ai = &mut accounts.iter();
    let market_ai = next_account_info(ai)?;
    let authority_ai = next_account_info(ai)?;
    let base_mint_ai = next_account_info(ai)?;
    let quote_mint_ai = next_account_info(ai)?;
    let base_vault_ai = next_account_info(ai)?;
    let quote_vault_ai = next_account_info(ai)?;
    let bids_ai = next_account_info(ai)?;
    let asks_ai = next_account_info(ai)?;
    let event_queue_ai = next_account_info(ai)?;
    let vault_signer_ai = next_account_info(ai)?;

    assert_signer(authority_ai)?;
    assert_writable(market_ai)?;
    assert_writable(bids_ai)?;
    assert_writable(asks_ai)?;
    assert_writable(event_queue_ai)?;

    assert_owned_by(market_ai, program_id)?;
    assert_owned_by(bids_ai, program_id)?;
    assert_owned_by(asks_ai, program_id)?;
    assert_owned_by(event_queue_ai, program_id)?;

    assert_account_size(market_ai, Market::SIZE)?;
    assert_account_size(bids_ai, BookSide::SIZE)?;
    assert_account_size(asks_ai, BookSide::SIZE)?;
    assert_account_size(event_queue_ai, EventQueue::SIZE)?;

    assert_owned_by(base_vault_ai, &TOKEN_PROGRAM_ID)?;
    assert_owned_by(quote_vault_ai, &TOKEN_PROGRAM_ID)?;

    // Market is an ordinary program-owned account (random keypair allocated
    // by the client). The (base_mint, quote_mint) pair is recorded inside the
    // Market struct, and consumers look up the market address from a registry
    // off-chain. Vault signer remains a PDA so the program can sign refunds.
    let (expected_vault, expected_bump) = pda::find_vault_signer(program_id, market_ai.key);
    assert_address(vault_signer_ai, &expected_vault)?;
    if args.vault_signer_bump != expected_bump {
        return Err(MoonexError::InvalidPda.into());
    }
    if args.tick_size == 0 || args.base_lot_size == 0 || args.quote_lot_size == 0 {
        return Err(MoonexError::InvalidLot.into());
    }

    {
        let mut data = market_ai.try_borrow_mut_data()?;
        let m: &mut Market = bytemuck::from_bytes_mut(&mut data[..]);
        if m.tag != AccountTag::Uninitialized as u8 {
            return Err(MoonexError::AlreadyInitialized.into());
        }
        m.tick_size = args.tick_size;
        m.base_lot_size = args.base_lot_size;
        m.quote_lot_size = args.quote_lot_size;
        m.next_order_seq = 0;
        m.authority = authority_ai.key.to_bytes();
        m.base_mint = base_mint_ai.key.to_bytes();
        m.quote_mint = quote_mint_ai.key.to_bytes();
        m.base_vault = base_vault_ai.key.to_bytes();
        m.quote_vault = quote_vault_ai.key.to_bytes();
        m.bids = bids_ai.key.to_bytes();
        m.asks = asks_ai.key.to_bytes();
        m.event_queue = event_queue_ai.key.to_bytes();
        m.tag = AccountTag::Market as u8;
        m.vault_signer_bump = args.vault_signer_bump;
        m.base_decimals = args.base_decimals;
        m.quote_decimals = args.quote_decimals;
    }

    {
        let mut data = bids_ai.try_borrow_mut_data()?;
        let b: &mut BookSide = bytemuck::from_bytes_mut(&mut data[..]);
        if b.tag != AccountTag::Uninitialized as u8 {
            return Err(MoonexError::AlreadyInitialized.into());
        }
        b.tag = AccountTag::Bids as u8;
        b.side = 0;
        b.len = 0;
    }
    {
        let mut data = asks_ai.try_borrow_mut_data()?;
        let b: &mut BookSide = bytemuck::from_bytes_mut(&mut data[..]);
        if b.tag != AccountTag::Uninitialized as u8 {
            return Err(MoonexError::AlreadyInitialized.into());
        }
        b.tag = AccountTag::Asks as u8;
        b.side = 1;
        b.len = 0;
    }
    {
        let mut data = event_queue_ai.try_borrow_mut_data()?;
        let q: &mut EventQueue = bytemuck::from_bytes_mut(&mut data[..]);
        if q.tag != AccountTag::Uninitialized as u8 {
            return Err(MoonexError::AlreadyInitialized.into());
        }
        q.tag = AccountTag::EventQueue as u8;
        q.head = 0;
        q.count = 0;
        q.seq = 0;
    }
    Ok(())
}
