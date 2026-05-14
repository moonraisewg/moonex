use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

use crate::instruction::{InitMarketArgs, MoonexInstruction, PlaceOrderArgs};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        let ix = MoonexInstruction::try_from_bytes(data)?;

        match ix {
            MoonexInstruction::InitMarket(args) => Self::init_market(program_id, accounts, args),
            MoonexInstruction::PlaceOrder(args) => Self::place_order(program_id, accounts, args),
            MoonexInstruction::CancelOrder { order_id } => {
                Self::cancel_order(program_id, accounts, order_id)
            }
        }
    }

    fn init_market(
        _program_id: &Pubkey,
        _accounts: &[AccountInfo],
        _args: InitMarketArgs,
    ) -> ProgramResult {
        msg!("Moonex: InitMarket");
        Ok(())
    }

    fn place_order(
        _program_id: &Pubkey,
        _accounts: &[AccountInfo],
        _args: PlaceOrderArgs,
    ) -> ProgramResult {
        msg!("Moonex: PlaceOrder");
        Ok(())
    }

    fn cancel_order(
        _program_id: &Pubkey,
        _accounts: &[AccountInfo],
        order_id: u128,
    ) -> ProgramResult {
        msg!("Moonex: CancelOrder {}", order_id);
        Ok(())
    }
}
