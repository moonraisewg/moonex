# Contributing to Moonex

Thanks for the interest. This file covers the conventions used in the
repo; please read it before opening a PR.

---

## Ground rules

- **License**: by contributing, you agree your changes are licensed
  under BUSL-1.1 (see [LICENSE](./LICENSE)).
- **Security-sensitive changes** (matching engine, lock math, vault
  signer, PDA derivation, account validation, error codes) require a
  reviewer with signing authority. Mark these PRs with the
  `area:on-chain` label and a description of the invariant you're
  preserving.
- **Never commit secrets**: `.env*`, `bot-wallets.json`, mint
  authorities, validator keys. The repo's `.gitignore` covers the
  common cases; double-check `git diff --cached` before committing.

---

## Prereqs

- Rust toolchain (`rustup`) + Solana CLI (Agave 1.18+).
- `cargo-build-sbf` (ships with the Solana CLI).
- Node.js 20+ and npm.
- A keypair at `~/.config/solana/id.json` for devnet deploys.

---

## Project layout

| Path | Owner | Notes |
|---|---|---|
| `programs/moonex/` | on-chain program | native Rust, no Anchor |
| `app/src/` | frontend | Next.js 16 + lightweight-charts + wallet-adapter |
| `app/scripts/` | tooling | tsx scripts: bot, crank, init-market, deploy-program.sh |
| `docs/` | architecture notes | local-only (gitignored) |

---

## Development workflow

### Build & test the program

```sh
cargo build-sbf                # compile BPF binary
cargo test                     # pure-Rust unit + property tests
cargo test-sbf                 # on-chain integration via solana-program-test (when added)
```

### Run the frontend

```sh
cd app
npm install
npm run dev                    # localhost:3000
```

### Deploy a code change to devnet

```sh
cargo build-sbf
bash app/scripts/deploy-program.sh
```

Deploy script wraps `solana program deploy` with 429 backoff + orphan
buffer cleanup. Don't run it against mainnet from a feature branch.

### Drive activity for manual QA

```sh
cd app
npm run bot                    # synthetic market-maker
npm run crank                  # drain event queue
npm run bot:stop
```

---

## Branching

- `main` is protected. All work lands via PR.
- Feature branches: `feat/<short-name>`. Fixes: `fix/<short-name>`.
  Chores / infra: `chore/<short-name>`.
- Rebase onto `main` before review; squash on merge unless a logical
  history matters (matching-engine work often does — keep it).

---

## Commit messages

Follow Conventional Commits:

```
<type>(<scope>): <subject>

<body — optional, wrap at ~72 cols, focus on the why>

<footer — references / BREAKING CHANGE notes>
```

Types we use: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`,
`chore`, `build`, `ci`.

Subject ≤ 50 chars, imperative mood ("add" not "added"). No trailing
period. Body explains motivation, not the diff (the diff is right
there).

Examples:

```
feat(program): saturating_sub on locked-balance reductions

ConsumeEvents could wedge the queue on legacy events with drifted
maker locks. Switch to saturating_sub so a single bad event can't
deny the rest of the queue. Adds still use checked_add — those
would represent active overflow, not stale drift.
```

```
fix(fe): replace accountSubscribe with HTTP polling

QuickNode caps accountSubscribe at 15/sec; the trade page exceeded
the cap during cold start, dropping book updates. Replace shared
subscription registry with a single getMultipleAccountsInfo poll
per tick.
```

---

## On-chain change checklist

When touching `programs/moonex/`, walk through:

1. **State layout** — if you change a Pod struct's fields, padding, or
   `MAX_*` constants, bump the human-readable size in the docs, update
   the FE decoder in `app/src/lib/moonex/decode.ts`, and verify
   `core::mem::size_of::<T>()` against the on-chain `dataSize` filter.
2. **Tags** — every account starts uninitialized (`tag == 0`). New
   account types get a new `AccountTag` variant; don't reuse a number.
3. **Migrations** — Pod structs are not Borsh; you cannot lengthen
   them without reallocating every existing account. Prefer using the
   reserved padding bytes.
4. **CU budget** — matching loops are the hot path. New per-fill work
   needs a quick CU benchmark via `solana-program-test` (or at minimum
   a manual on-chain run with `--use-rpc` and a logged CU count).
5. **Errors** — new error codes go at the end of `MoonexError`. Don't
   insert in the middle (renumbers existing custom codes).
6. **FE wiring** — new instruction or argument? Update
   `app/src/lib/moonex/index.ts` (`ix*` builders + `*_SIZE` consts) and
   call sites in `app/src/components/Trade.tsx`.
7. **Redeploy** — after merge, run `cargo build-sbf` and
   `app/scripts/deploy-program.sh`. Tag a release if it's user-visible.

---

## Frontend conventions

- Read state via the `useMoonex` hooks — never call `connection.*`
  directly from a component for steady-state reads. Polling is shared.
- Transactions go through `sendAndConfirmRetry` in `src/lib/tx.ts`. Do
  not introduce `sendAndConfirmTransaction` or
  `connection.confirmTransaction` — both open websocket subscriptions.
- Tailwind: keep classes co-located with the markup; avoid per-file
  CSS unless you need keyframes.
- The codebase is TypeScript-strict. No `any`. Avoid `as` casts unless
  you're crossing a wire boundary.

---

## Bot / scripts

- New scripts live in `app/scripts/`, written in TypeScript, executed
  via `tsx`. Add an entry to `app/package.json` `scripts` if it's a
  routine command.
- Default RPC for scripts is `MOONEX_RPC_ENDPOINT` (env) with a sane
  fallback. Don't hardcode prod endpoints.
- Long-running scripts must catch transient network errors. Bot's
  `quietFetch` pattern is the reference.

---

## Code style

- Rust: `cargo fmt` before pushing. Lint with `cargo clippy --all-targets`
  and address warnings.
- TypeScript: `npm run lint` from `app/`. Prettier is run by the
  editor; the repo doesn't enforce a save hook yet.
- Prefer small, single-purpose modules over giant ones. Each
  instruction lives in its own file under `processor/`; mirror that
  pattern when adding new instructions.

---

## Pull requests

- Open against `main`. Describe the change, the test coverage, and any
  on-chain implications.
- Include screenshots / short clips for UI changes.
- For on-chain changes, paste a CU count delta (before/after) for the
  hot instructions you touched.

---

## Reporting bugs / vulnerabilities

- Non-sensitive bugs: open a GitHub issue with reproduction steps and
  the program ID / commit SHA you observed it on.
- Security issues: please email `security@moonraise.xyz` (or contact
  Moonraise Labs through the website) instead of filing publicly. We
  will coordinate disclosure.

---

## Questions

Open an issue or reach out via [moonraise.xyz](https://moonraise.xyz).
