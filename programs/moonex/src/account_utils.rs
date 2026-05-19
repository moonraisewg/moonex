use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use crate::error::MoonexError;

pub fn assert_signer(account: &AccountInfo) -> Result<(), MoonexError> {
    if !account.is_signer {
        return Err(MoonexError::MissingSigner);
    }
    Ok(())
}

pub fn assert_writable(account: &AccountInfo) -> Result<(), MoonexError> {
    if !account.is_writable {
        return Err(MoonexError::NotWritable);
    }
    Ok(())
}

pub fn assert_owned_by(account: &AccountInfo, owner: &Pubkey) -> Result<(), MoonexError> {
    if account.owner != owner {
        return Err(MoonexError::InvalidAccountOwner);
    }
    Ok(())
}

pub fn assert_address(account: &AccountInfo, expected: &Pubkey) -> Result<(), MoonexError> {
    if account.key != expected {
        return Err(MoonexError::InvalidPda);
    }
    Ok(())
}

pub fn assert_account_size(account: &AccountInfo, expected: usize) -> Result<(), MoonexError> {
    if account.data_len() != expected {
        return Err(MoonexError::InvalidAccountSize);
    }
    Ok(())
}
