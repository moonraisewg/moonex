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
    pda,
    state::{AccountTag, Market, OpenOrders},
    token,
};

pub fn handle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    msg!("Moonex: SettleFunds");
    let ai = &mut accounts.iter();
    let market_ai = next_account_info(ai)?;
    let owner_ai = next_account_info(ai)?;
    let open_orders_ai = next_account_info(ai)?;
    let base_vault_ai = next_account_info(ai)?;
    let quote_vault_ai = next_account_info(ai)?;
    let user_base_ai = next_account_info(ai)?;
    let user_quote_ai = next_account_info(ai)?;
    let vault_signer_ai = next_account_info(ai)?;
    let token_program_ai = next_account_info(ai)?;

    assert_signer(owner_ai)?;
    assert_writable(open_orders_ai)?;
    assert_writable(base_vault_ai)?;
    assert_writable(quote_vault_ai)?;
    assert_writable(user_base_ai)?;
    assert_writable(user_quote_ai)?;

    assert_owned_by(market_ai, program_id)?;
    assert_owned_by(open_orders_ai, program_id)?;
    token::assert_token_program(token_program_ai)?;

    assert_account_size(market_ai, Market::SIZE)?;
    assert_account_size(open_orders_ai, OpenOrders::SIZE)?;

    let vault_signer_bump;
    {
        let data = market_ai.try_borrow_data()?;
        let m: &Market = bytemuck::from_bytes(&data[..]);
        if m.tag != AccountTag::Market as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if m.base_vault != base_vault_ai.key.to_bytes()
            || m.quote_vault != quote_vault_ai.key.to_bytes()
        {
            return Err(MoonexError::VaultMismatch.into());
        }
        vault_signer_bump = m.vault_signer_bump;
    }
    let (expected_signer, derived_bump) = pda::find_vault_signer(program_id, market_ai.key);
    assert_address(vault_signer_ai, &expected_signer)?;
    if derived_bump != vault_signer_bump {
        return Err(MoonexError::InvalidPda.into());
    }

    let (base_amount, quote_amount) = {
        let mut data = open_orders_ai.try_borrow_mut_data()?;
        let oo: &mut OpenOrders = bytemuck::from_bytes_mut(&mut data[..]);
        if oo.tag != AccountTag::OpenOrders as u8 {
            return Err(MoonexError::InvalidAccountTag.into());
        }
        if oo.owner != owner_ai.key.to_bytes() {
            return Err(MoonexError::OwnerMismatch.into());
        }
        let b = oo.base_free;
        let q = oo.quote_free;
        oo.base_free = 0;
        oo.quote_free = 0;
        (b, q)
    };

    let market_key = market_ai.key.to_bytes();
    let bump_arr = [vault_signer_bump];
    let signer_seeds = pda::vault_signer_seeds(&market_key, &bump_arr);
    if base_amount > 0 {
        token::transfer_signed(
            base_vault_ai,
            user_base_ai,
            vault_signer_ai,
            token_program_ai,
            base_amount,
            &signer_seeds,
        )?;
    }
    if quote_amount > 0 {
        token::transfer_signed(
            quote_vault_ai,
            user_quote_ai,
            vault_signer_ai,
            token_program_ai,
            quote_amount,
            &signer_seeds,
        )?;
    }
    Ok(())
}
