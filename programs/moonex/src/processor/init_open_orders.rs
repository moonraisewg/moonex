use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    account_utils::{assert_address, assert_signer, assert_writable},
    error::MoonexError,
    pda::{self, OPEN_ORDERS_SEED},
    state::{AccountTag, OpenOrders},
};

pub fn handle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    msg!("Moonex: InitOpenOrders");
    let ai = &mut accounts.iter();
    let oo_ai = next_account_info(ai)?;
    let market_ai = next_account_info(ai)?;
    let owner_ai = next_account_info(ai)?;
    let system_program_ai = next_account_info(ai)?;

    assert_signer(owner_ai)?;
    assert_writable(owner_ai)?;
    assert_writable(oo_ai)?;

    // OpenOrders is a PDA derived from (program, "open_orders", market, owner).
    // This guarantees a single account per (wallet, market) — anyone trying
    // to call InitOpenOrders a second time hits AlreadyInitialized below
    // because the PDA already has data.
    let (expected, bump) = pda::find_open_orders(program_id, market_ai.key, owner_ai.key);
    assert_address(oo_ai, &expected)?;

    if oo_ai.data_len() > 0 {
        return Err(MoonexError::AlreadyInitialized.into());
    }
    if !system_program_ai.key.eq(&solana_program::system_program::ID) {
        return Err(MoonexError::InvalidAccountOwner.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(OpenOrders::SIZE);
    let market_key = market_ai.key.to_bytes();
    let owner_key = owner_ai.key.to_bytes();
    let bump_arr = [bump];
    let seeds: [&[u8]; 4] = [
        OPEN_ORDERS_SEED,
        market_key.as_ref(),
        owner_key.as_ref(),
        &bump_arr,
    ];
    invoke_signed(
        &system_instruction::create_account(
            owner_ai.key,
            oo_ai.key,
            lamports,
            OpenOrders::SIZE as u64,
            program_id,
        ),
        &[owner_ai.clone(), oo_ai.clone(), system_program_ai.clone()],
        &[&seeds],
    )?;

    let mut data = oo_ai.try_borrow_mut_data()?;
    let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut data[..]);
    oo.tag = AccountTag::OpenOrders as u8;
    oo.market = market_key;
    oo.owner = owner_key;
    Ok(())
}
