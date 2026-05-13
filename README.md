# Moonex

Native CLOB perpetuals DEX on Solana, by [Moonraise Labs](https://moonraise.xyz).

Moonex is implemented as a Solana **native program** and a fully on-chain central limit order book matching engine for perpetual futures.

## Status

Pre-scaffold. The program crate, build configuration, and on-chain logic are not yet in place. This README will be updated as the project takes shape.

## Goals

- **On-chain CLOB** — price-time priority order book lives entirely on-chain, no off-chain sequencer.
- **Perpetual futures** — mark/index price oracles, funding rate accrual, isolated and cross margin, on-chain liquidation.
- **Native program** — minimal dependencies, predictable compute and rent costs, transparent account layouts.
- **Composability** — markets, vaults, and positions exposed as plain accounts so other Solana programs can build on top.

## Planned layout

```
moonex/
├── programs/moonex/     # on-chain native program (Rust, no Anchor)
├── crates/              # shared types, math, client SDK
└── tests/               # solana-program-test integration tests
```

## Building (once scaffolded)

```sh
cargo build-sbf          # build BPF program
cargo test-sbf           # on-chain integration tests
cargo test               # pure-Rust unit tests
```

## License

Business Source License 1.1 (BUSL-1.1). Non-production use is permitted; production / commercial use is reserved to Moonraise Labs. Converts to GPL v2.0-or-later on **2030-05-13**. See [LICENSE](./LICENSE) or contact Moonraise Labs for a commercial license.

## Links

- Moonraise Labs — https://moonraise.xyz
