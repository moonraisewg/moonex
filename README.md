# Moonex

Native CLOB DEX on Solana, by [Moonraise Labs](https://moonraise.xyz).

Moonex is a fully on-chain central limit order book. Implemented as a
Solana **native program** (no Anchor) — manual instruction dispatch,
Borsh args, Pod (zero-copy) state, explicit account validation. Spot
matching is live; perpetual extensions (funding, mark price, margin,
liquidation) are planned.

Program ID (devnet): `GawUJQ4vdnxeRzbnkwJsMAb1hVSh9qpXpeyvn9nXxZ72`

---

## Repo layout

```
moonex/
├── programs/moonex/        # on-chain native program (Rust)
│   ├── src/
│   │   ├── lib.rs          # entrypoint
│   │   ├── instruction.rs  # MoonexInstruction enum (Borsh)
│   │   ├── processor/      # one file per instruction
│   │   ├── state.rs        # Pod state: Market, BookSide, OpenOrders, EventQueue
│   │   ├── math.rs         # order id, lock math
│   │   ├── pda.rs          # PDA seeds
│   │   ├── token.rs        # SPL transfer wrappers
│   │   └── error.rs
│   └── tests/              # cargo test (unit + property tests)
├── app/                    # Next.js 16 frontend + scripts
│   ├── src/
│   │   ├── app/            # routes
│   │   ├── components/     # Trade, Orderbook, PriceChart, …
│   │   └── lib/
│   │       ├── moonex/     # decoders + ix builders (mirrors program state)
│   │       ├── useMoonex.ts# polled subscription registry
│   │       └── tx.ts       # sendAndConfirmRetry (raw send + status poll)
│   └── scripts/
│       ├── mm-bot.ts       # synthetic market-maker
│       ├── crank.ts        # event queue drain
│       ├── init-market.ts  # bootstrap a new market
│       ├── fund-bots.ts / drain-bots.ts / mint-more.ts
│       └── deploy-program.sh
├── CONTRIBUTING.md
├── LICENSE                 # BUSL-1.1
└── README.md
```

---

## Quick start

### Prereqs

- Rust + `solana` CLI 1.18+ (or compatible Agave) with `cargo-build-sbf`
- Node.js 20+ and npm
- A Solana keypair at `~/.config/solana/id.json`
- Devnet RPC endpoint (Helius / QuickNode / public)

### Build & deploy the program

```sh
cargo build-sbf
cargo test                            # pure-Rust unit tests
bash app/scripts/deploy-program.sh    # wraps `solana program deploy` with 429 backoff
```

### Run the frontend

```sh
cd app
npm install
echo 'NEXT_PUBLIC_RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=YOUR_KEY' > .env.local
npm run dev
# → http://localhost:3000
```

### Bootstrap a market

```sh
cd app
npm run init-market    # mints test base/quote, allocates market accounts, calls InitMarket
```

### Drive activity with the bot

```sh
cd app
npm run bot                                # 4 wallets, 700 ms cadence (defaults)
npm run bot -- --wallets=6 --interval=400  # tune at will
npm run bot:stop
```

### Drain stuck events manually

```sh
cd app
npm run crank
```

---

## Architecture at a glance

- **Instructions**: `InitMarket`, `InitOpenOrders`, `PlaceOrder`,
  `CancelOrder`, `ConsumeEvents`, `SettleFunds`.
- **Order types**: `Limit`, `PostOnly`, `IOC`, `FOK`.
- **State** (all Pod, fixed-size):
  - `Market` (424 B) — params, vault refs, sub-account pubkeys
  - `BookSide` (18,448 B) — sorted `[OrderNode; 256]` per side
  - `OpenOrders` (1,384 B, PDA) — 32 slots + free/locked accounting
  - `EventQueue` (24,600 B) — ring buffer of 256 `FillEvent`s
- **PDAs**: vault signer (`["vault", market]`), open orders
  (`["open_orders", market, owner]`).
- **Settlement**: taker is paid inline by `PlaceOrder` (≤3 SPL
  transfers per call). Makers are settled out-of-band via
  `ConsumeEvents` — anyone can crank.
- **Matching**: O(N) shift-array book, capped at 8 fills per
  `PlaceOrder` call; self-trade prevention skips own makers.

Full architecture reference: `docs/architecture.md` (kept as a local
working doc — gitignored).

---

## Frontend / RPC notes

- All read paths use HTTP-polling via a shared subscription registry
  (`src/lib/useMoonex.ts`). No `accountSubscribe` — keeps the page well
  under RPC ws-subscription rate limits.
- Transactions go through `src/lib/tx.ts` `sendAndConfirmRetry`: wallet
  signs once, raw bytes are sent + status-polled + auto-rebroadcast
  until confirmed or the blockhash expires. No `signatureSubscribe`.
- Orderbook layout: best bid / best ask hug the spread row; cumulative
  total column with hover-to-spread highlight + sweep readout.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch/commit conventions,
build steps, and a checklist for changing on-chain layouts.

## License

Business Source License 1.1 (BUSL-1.1). Non-production use permitted;
production / commercial use reserved to Moonraise Labs. Converts to
GPL v2.0-or-later on **2030-05-13**. See [LICENSE](./LICENSE) or
contact Moonraise Labs for a commercial license.

## Links

- Moonraise Labs — https://moonraise.xyz
