//! Host-side unit tests for math + BookSide. Runs under plain `cargo
//! test`; no SBF or BanksClient needed.

use bytemuck::Zeroable;
use moonex::{
    math::{base_locked, decompose_order_id, make_order_id, quote_locked},
    state::{
        BookSide, EventQueue, FillEvent, Market, OpenOrderSlot, OpenOrders, OrderNode,
        MAX_ORDERS_PER_SIDE,
    },
};

#[test]
fn pod_sizes_pinned() {
    // These constants are duplicated in the TypeScript SDK (app/src/lib/moonex/index.ts);
    // changing one without the other surfaces as MoonexError::InvalidAccountSize.
    assert_eq!(core::mem::size_of::<Market>(), 424);
    assert_eq!(core::mem::size_of::<OrderNode>(), 72);
    assert_eq!(core::mem::size_of::<BookSide>(), 18_448);
    assert_eq!(core::mem::size_of::<OpenOrderSlot>(), 40);
    assert_eq!(core::mem::size_of::<OpenOrders>(), 1_384);
    assert_eq!(core::mem::size_of::<FillEvent>(), 96);
    assert_eq!(core::mem::size_of::<EventQueue>(), 24_600);
}

fn empty_book() -> Box<BookSide> {
    // Host stack is 8 MB, so constructing a zeroed BookSide on the stack
    // before boxing is fine here. The SBF program never builds a BookSide
    // by value — it operates on the account buffer in place.
    Box::new(BookSide::zeroed())
}

fn node(price: u64, seq: u64, owner_slot: u8) -> OrderNode {
    OrderNode {
        price_lots: price,
        size_lots: 10,
        client_order_id: seq,
        seq,
        owner: [owner_slot; 32],
        owner_slot,
        _pad: [0; 7],
    }
}

#[test]
fn order_id_roundtrip_bid_and_ask() {
    for &side_is_bid in &[true, false] {
        for &(price, seq) in &[(1u64, 0u64), (100, 7), (u64::MAX / 2, 99), (u64::MAX, u64::MAX)] {
            let id = make_order_id(side_is_bid, price, seq);
            let (p, s) = decompose_order_id(side_is_bid, id);
            assert_eq!((p, s), (price, seq), "side_is_bid={side_is_bid}");
        }
    }
}

#[test]
fn quote_locked_overflow_guards() {
    // happy path
    assert_eq!(quote_locked(10, 5, 1).unwrap(), 50);
    // overflow on multiplication
    assert!(quote_locked(u64::MAX, u64::MAX, 2).is_err());
}

#[test]
fn base_locked_happy_and_overflow() {
    assert_eq!(base_locked(10, 100).unwrap(), 1000);
    assert!(base_locked(u64::MAX, 2).is_err());
}

#[test]
fn ask_book_sorts_ascending_by_price_then_seq() {
    let mut book = empty_book();
    // Insert out of order
    for (price, seq) in [(100u64, 3u64), (50, 0), (200, 1), (50, 2)] {
        let idx = book.insertion_index(false, price, seq);
        book.insert(idx, node(price, seq, seq as u8)).unwrap();
    }
    assert_eq!(book.len, 4);
    // Ask side: best (lowest price) first; same price → lower seq first.
    let observed: Vec<_> = (0..book.len as usize)
        .map(|i| (book.orders[i].price_lots, book.orders[i].seq))
        .collect();
    assert_eq!(observed, vec![(50, 0), (50, 2), (100, 3), (200, 1)]);
}

#[test]
fn bid_book_sorts_descending_by_price_then_ascending_by_seq() {
    let mut book = empty_book();
    for (price, seq) in [(100u64, 3u64), (50, 0), (200, 1), (200, 2)] {
        let idx = book.insertion_index(true, price, seq);
        book.insert(idx, node(price, seq, seq as u8)).unwrap();
    }
    let observed: Vec<_> = (0..book.len as usize)
        .map(|i| (book.orders[i].price_lots, book.orders[i].seq))
        .collect();
    // Bid side: best (highest price) first; FIFO at the same level.
    assert_eq!(observed, vec![(200, 1), (200, 2), (100, 3), (50, 0)]);
}

#[test]
fn find_and_remove_keep_invariants() {
    let mut book = empty_book();
    for (price, seq) in [(100u64, 0u64), (200, 1), (150, 2)] {
        let idx = book.insertion_index(false, price, seq);
        book.insert(idx, node(price, seq, seq as u8)).unwrap();
    }
    let idx = book.find(false, 150, 2).expect("should find");
    let removed = book.remove_at(idx).unwrap();
    assert_eq!(removed.price_lots, 150);
    assert_eq!(book.len, 2);
    // Tail slot must be wiped to all-zero so subsequent finds don't hit ghosts.
    assert_eq!(book.orders[2].price_lots, 0);
    assert_eq!(book.orders[2].seq, 0);
}

#[test]
fn book_full_rejects_insert() {
    let mut book = empty_book();
    for i in 0..MAX_ORDERS_PER_SIDE as u64 {
        let idx = book.insertion_index(false, 100 + i, i);
        book.insert(idx, node(100 + i, i, 0)).unwrap();
    }
    let idx = book.insertion_index(false, 9999, 9999);
    assert!(book.insert(idx, node(9999, 9999, 0)).is_err());
}
