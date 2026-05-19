use solana_program::pubkey::Pubkey;

pub const MARKET_SEED: &[u8] = b"market";
pub const OPEN_ORDERS_SEED: &[u8] = b"open_orders";
pub const VAULT_SIGNER_SEED: &[u8] = b"vault";

pub fn find_market(
    program_id: &Pubkey,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MARKET_SEED, base_mint.as_ref(), quote_mint.as_ref()],
        program_id,
    )
}

pub fn find_open_orders(
    program_id: &Pubkey,
    market: &Pubkey,
    owner: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[OPEN_ORDERS_SEED, market.as_ref(), owner.as_ref()],
        program_id,
    )
}

pub fn find_vault_signer(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SIGNER_SEED, market.as_ref()], program_id)
}

pub fn market_signer_seeds<'a>(base_mint: &'a [u8], quote_mint: &'a [u8], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [MARKET_SEED, base_mint, quote_mint, bump]
}

pub fn vault_signer_seeds<'a>(market: &'a [u8], bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [VAULT_SIGNER_SEED, market, bump]
}
