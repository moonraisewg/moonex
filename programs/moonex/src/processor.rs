use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey,
};

use crate::instruction::MoonexInstruction;

mod cancel_order;
mod consume_events;
mod init_market;
mod init_open_orders;
mod place_order;
mod settle_funds;

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        let ix = MoonexInstruction::try_from_bytes(data)?;
        match ix {
            MoonexInstruction::InitMarket(args) => {
                init_market::handle(program_id, accounts, args)
            }
            MoonexInstruction::InitOpenOrders => init_open_orders::handle(program_id, accounts),
            MoonexInstruction::PlaceOrder(args) => {
                place_order::handle(program_id, accounts, args)
            }
            MoonexInstruction::CancelOrder(args) => {
                cancel_order::handle(program_id, accounts, args)
            }
            MoonexInstruction::ConsumeEvents(args) => {
                consume_events::handle(program_id, accounts, args)
            }
            MoonexInstruction::SettleFunds => settle_funds::handle(program_id, accounts),
        }
    }
}
