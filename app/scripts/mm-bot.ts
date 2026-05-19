#!/usr/bin/env tsx
//
// Pseudo market-maker: N synthetic wallets place / cancel orders around
// the current mid price so the order book and chart show realistic
// activity on devnet. State persists in `scripts/bot-wallets.json`.
//
// Usage:
//   npm run bot                              # default 4 wallets, 1500 ms cadence, runs until ^C
//   npm run bot -- --wallets=6 --interval=1000
//
// Each tick:
//   - 55 %: post a resting limit order ±0.5 % from mid
//   - 20 %: cancel one of that wallet's oldest orders
//   - 25 %: cross the spread to generate a fill
// Every 10 ticks the bot drains the event queue via ConsumeEvents and
// pulls settled balances back via SettleFunds, so OpenOrders don't
// accumulate stuck base_free / quote_free.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  MAX_OPEN_ORDERS_PER_USER,
  OrderType,
  PROGRAM_ID,
  Side,
  findOpenOrders,
  ixCancelOrder,
  ixConsumeEvents,
  ixInitOpenOrders,
  ixPlaceOrder,
  ixSettleFunds,
} from "../src/lib/moonex/index.js";
import { decodeBookSide, decodeOpenOrders } from "../src/lib/moonex/decode.js";

const WALLETS_FILE = path.join("scripts", "bot-wallets.json");
const MARKET_FILE = path.join("src", "lib", "market.json");

interface BotWalletStored {
  secret: number[];
  openOrders: string;
  // base58 of the market this wallet has already been provisioned for —
  // SOL funded, ATAs created + balances minted, OO PDA created.
  setupForMarket?: string;
}

interface BotWalletInMem {
  kp: Keypair;
  openOrders: PublicKey;
}

interface ParsedArgs {
  wallets: number;
  interval: number;
}

function parseArgs(): ParsedArgs {
  const out: ParsedArgs = { wallets: 4, interval: 700 };
  for (const a of process.argv.slice(2)) {
    const m = /^--(wallets|interval)=(\d+)$/.exec(a);
    if (!m) continue;
    if (m[1] === "wallets") out.wallets = Number(m[2]);
    if (m[1] === "interval") out.interval = Number(m[2]);
  }
  return out;
}

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

interface MarketCfg {
  programId: string;
  market: string;
  baseMint: string;
  quoteMint: string;
  bids: string;
  asks: string;
  eventQueue: string;
  baseVault: string;
  quoteVault: string;
  vaultSigner: string;
  vaultSignerBump: number;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: string;
  baseLotSize: string;
  quoteLotSize: string;
  baseSymbol: string;
  quoteSymbol: string;
}

class Mkt {
  constructor(readonly cfg: MarketCfg) {}
  get market() { return new PublicKey(this.cfg.market); }
  get baseMint() { return new PublicKey(this.cfg.baseMint); }
  get quoteMint() { return new PublicKey(this.cfg.quoteMint); }
  get bids() { return new PublicKey(this.cfg.bids); }
  get asks() { return new PublicKey(this.cfg.asks); }
  get eventQueue() { return new PublicKey(this.cfg.eventQueue); }
  get baseVault() { return new PublicKey(this.cfg.baseVault); }
  get quoteVault() { return new PublicKey(this.cfg.quoteVault); }
  get vaultSigner() { return new PublicKey(this.cfg.vaultSigner); }
  get tickSize() { return BigInt(this.cfg.tickSize); }
  get baseLotSize() { return BigInt(this.cfg.baseLotSize); }
  get quoteLotSize() { return BigInt(this.cfg.quoteLotSize); }

  priceToLots(price: number): bigint {
    const qBaseTok = BigInt(Math.round(price * 10 ** this.cfg.quoteDecimals));
    const qPerBaseLot = (qBaseTok * this.baseLotSize) / 10n ** BigInt(this.cfg.baseDecimals);
    return qPerBaseLot / this.quoteLotSize;
  }
  priceFromLots(priceLots: bigint): number {
    const num = priceLots * this.quoteLotSize * 10n ** BigInt(this.cfg.baseDecimals);
    const den = this.baseLotSize * 10n ** BigInt(this.cfg.quoteDecimals);
    return Number(num) / Number(den);
  }
  sizeToLots(size: number): bigint {
    const units = BigInt(Math.round(size * 10 ** this.cfg.baseDecimals));
    return units / this.baseLotSize;
  }
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (!/(429|Too Many Requests|503|rate)/i.test(msg) || attempt >= 8) throw e;
      attempt++;
      const wait = Math.min(30_000, 2_000 * 2 ** attempt);
      console.log(`  ${label} 429 — backing off ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function ensureBotWallet(
  connection: Connection,
  admin: Keypair,
  mkt: Mkt,
  kp: Keypair,
  stored: BotWalletStored
): Promise<PublicKey> {
  // Fast path — every previous run already funded SOL, opened ATAs,
  // minted balances and created the OpenOrders PDA for this market.
  // Trust the persisted state and skip the four RPC round-trips entirely.
  if (stored.setupForMarket === mkt.market.toBase58() && stored.openOrders) {
    return new PublicKey(stored.openOrders);
  }
  // Migration path — older runs persisted `openOrders` without the
  // `setupForMarket` marker. If the stored address matches this market's
  // expected OO PDA, the setup is already done; promote the entry to the
  // new schema and short-circuit.
  if (stored.openOrders) {
    const [expected] = findOpenOrders(mkt.market, kp.publicKey);
    if (expected.toBase58() === stored.openOrders) {
      stored.setupForMarket = mkt.market.toBase58();
      return expected;
    }
  }

  // 1) top up SOL for fees
  const sol = await retry("getBalance", () => connection.getBalance(kp.publicKey));
  if (sol < 0.05 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [admin]);
  }

  // 2) ATAs + initial mint (idempotent)
  const userBase = getAssociatedTokenAddressSync(mkt.baseMint, kp.publicKey);
  const userQuote = getAssociatedTokenAddressSync(mkt.quoteMint, kp.publicKey);
  const baseAcct = await retry("getAccountInfo base", () =>
    connection.getAccountInfo(userBase)
  );
  const quoteAcct = await retry("getAccountInfo quote", () =>
    connection.getAccountInfo(userQuote)
  );
  if (!baseAcct || !quoteAcct) {
    const mintTx = new Transaction()
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          userBase,
          kp.publicKey,
          mkt.baseMint
        )
      )
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          userQuote,
          kp.publicKey,
          mkt.quoteMint
        )
      )
      .add(
        createMintToInstruction(
          mkt.baseMint,
          userBase,
          admin.publicKey,
          1_000_000n * 10n ** BigInt(mkt.cfg.baseDecimals)
        )
      )
      .add(
        createMintToInstruction(
          mkt.quoteMint,
          userQuote,
          admin.publicKey,
          1_000_000n * 10n ** BigInt(mkt.cfg.quoteDecimals)
        )
      );
    await sendAndConfirmTransaction(connection, mintTx, [admin]);
  }

  // 3) OpenOrders PDA — derived from (market, owner). Program creates
  // the account via invoke_signed inside InitOpenOrders.
  const [pda] = findOpenOrders(mkt.market, kp.publicKey);
  const existing = await retry("getAccountInfo oo", () =>
    connection.getAccountInfo(pda)
  );
  if (existing) return pda;
  const tx = new Transaction().add(
    ixInitOpenOrders(mkt.market, pda, kp.publicKey)
  );
  await sendAndConfirmTransaction(connection, tx, [kp]);
  return pda;
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function main() {
  // Net safety: don't let one stray unhandled rejection (e.g. an internal
  // web3.js fetch retry losing a race) kill the bot. Log + keep running.
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", (reason as Error)?.message ?? reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err?.message ?? err);
  });

  const { wallets: nWallets, interval } = parseArgs();
  // Default Solana devnet endpoint — keeps the bot off the FE's Helius
  // budget. We supply a custom fetch so 429 responses are retried
  // silently instead of spamming web3.js' built-in console.log loop.
  const aborter = new AbortController();
  let total429 = 0;
  const quietFetch: typeof fetch = async (input, init) => {
    let netRetries = 0;
    while (true) {
      if (aborter.signal.aborted) throw new Error("aborted");
      const merged: RequestInit = { ...init, signal: aborter.signal };
      let res: Response;
      try {
        res = await fetch(input as Parameters<typeof fetch>[0], merged);
      } catch (e) {
        // ECONNRESET / DNS / TLS blips. Quietly back off; web3.js would
        // otherwise surface this as an uncaught rejection and crash the
        // process.
        if (aborter.signal.aborted) throw e;
        netRetries++;
        const wait = Math.min(10_000, 500 * 2 ** Math.min(netRetries, 5));
        if (netRetries === 1 || netRetries % 5 === 0) {
          console.log(`  [rpc] network error — retry ${netRetries} in ${wait}ms (${(e as Error).message})`);
        }
        await sleepAbortable(wait, aborter.signal);
        continue;
      }
      if (res.status !== 429) return res;
      total429++;
      if (total429 % 10 === 1) console.log(`  [rpc] 429 — waiting (n=${total429})`);
      await sleepAbortable(1000, aborter.signal);
    }
  };
  const DEFAULT_BOT_RPC =
    "https://devnet.helius-rpc.com/?api-key=0ff95086-aa52-4a0d-9cd8-25d15bfd695a";
  const endpoint = process.env.MOONEX_RPC_ENDPOINT ?? DEFAULT_BOT_RPC;
  console.log(`rpc: ${endpoint}`);
  const connection = new Connection(endpoint, {
    commitment: "confirmed",
    fetch: quietFetch,
  });
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const cfg = JSON.parse(fs.readFileSync(MARKET_FILE, "utf8")) as MarketCfg;
  const mkt = new Mkt(cfg);
  console.log(`market: ${cfg.market} (${cfg.baseSymbol}/${cfg.quoteSymbol})`);
  console.log(`bot wallets: ${nWallets}, cadence: ${interval} ms`);

  // load or create persisted wallets
  let stored: BotWalletStored[] = [];
  if (fs.existsSync(WALLETS_FILE)) {
    stored = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  }
  while (stored.length < nWallets) {
    const kp = Keypair.generate();
    stored.push({ secret: Array.from(kp.secretKey), openOrders: "" });
  }
  stored = stored.slice(0, nWallets);

  const bots: BotWalletInMem[] = [];
  for (let i = 0; i < stored.length; i++) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(stored[i].secret));
    process.stdout.write(`[setup] ${kp.publicKey.toBase58().slice(0, 8)}… `);
    const oo = await ensureBotWallet(connection, admin, mkt, kp, stored[i]);
    stored[i].openOrders = oo.toBase58();
    stored[i].setupForMarket = mkt.market.toBase58();
    bots.push({ kp, openOrders: oo });
    console.log("OO=" + oo.toBase58().slice(0, 8) + "…");
  }
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(stored, null, 2) + "\n");

  // Publish bot OO pubkeys (no secrets) so the FE can include them when
  // it drains its own events.
  const oosPath = path.join("src", "lib", "bot-oos.json");
  fs.writeFileSync(
    oosPath,
    JSON.stringify(
      bots.map((b) => b.openOrders.toBase58()),
      null,
      2
    ) + "\n"
  );

  let tick = 0;
  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) {
      console.log("\n^C — force exit");
      process.exit(130);
    }
    console.log("\n^C — stopping after current tick (^C again to force)");
    shuttingDown = true;
    aborter.abort();
  });

  let referenceMid = 100; // seed price for an empty book
  while (!shuttingDown) {
    tick++;
    try {
      await runTick(connection, mkt, bots, tick, referenceMid)
        .then((newMid) => {
          if (newMid != null) referenceMid = newMid;
        });
      // Drain the queue every tick. ConsumeEvents is a no-op when the
      // queue is empty, so this stays cheap.
      await crank(connection, mkt, bots);
    } catch (e) {
      console.error(`[tick ${tick}]`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function runTick(
  connection: Connection,
  mkt: Mkt,
  bots: BotWalletInMem[],
  tick: number,
  referenceMid: number
): Promise<number | null> {
  const [bidsInfo, asksInfo] = await Promise.all([
    connection.getAccountInfo(mkt.bids),
    connection.getAccountInfo(mkt.asks),
  ]);
  if (!bidsInfo || !asksInfo) throw new Error("book accounts missing");
  const bids = decodeBookSide(new Uint8Array(bidsInfo.data));
  const asks = decodeBookSide(new Uint8Array(asksInfo.data));
  const bestBid = bids.len > 0 ? mkt.priceFromLots(bids.orders[0].priceLots) : null;
  const bestAsk = asks.len > 0 ? mkt.priceFromLots(asks.orders[0].priceLots) : null;
  let mid: number;
  if (bestBid != null && bestAsk != null) mid = (bestBid + bestAsk) / 2;
  else if (bestBid != null) mid = bestBid * 1.002;
  else if (bestAsk != null) mid = bestAsk * 0.998;
  else mid = referenceMid;

  const bot = pick(bots);
  const roll = Math.random();

  // 10% cancel · 55% cross (taker) · 35% rest (maker). Heavier on
  // crossing so the tape shows fills, not just quote churn.
  if (roll < 0.10) {
    await cancelOldest(connection, mkt, bot);
  } else if (roll < 0.65) {
    await placeCrossing(connection, mkt, bot, bestBid, bestAsk, mid);
  } else {
    await placeResting(connection, mkt, bot, mid);
  }
  return mid;
}

async function placeResting(
  connection: Connection,
  mkt: Mkt,
  bot: BotWalletInMem,
  mid: number
) {
  const side = Math.random() < 0.5 ? Side.Bid : Side.Ask;
  const offset = (Math.random() * 0.01 + 0.0005) * (side === Side.Bid ? -1 : 1); // ±0.05%–1.05%
  const price = Math.max(0.000001, mid * (1 + offset));
  const sizeFloat = 0.5 + Math.random() * 4.5; // 0.5–5.0 base
  await sendPlace(connection, mkt, bot, side, price, sizeFloat, "rest");
}

async function placeCrossing(
  connection: Connection,
  mkt: Mkt,
  bot: BotWalletInMem,
  bestBid: number | null,
  bestAsk: number | null,
  mid: number
) {
  let side: Side;
  let price: number;
  if (bestAsk != null && Math.random() < 0.5) {
    side = Side.Bid;
    price = bestAsk * (1 + Math.random() * 0.001 + 0.0005);
  } else if (bestBid != null) {
    side = Side.Ask;
    price = bestBid * (1 - (Math.random() * 0.001 + 0.0005));
  } else {
    return placeResting(connection, mkt, bot, mid);
  }
  const sizeFloat = 0.5 + Math.random() * 3.5; // 0.5–4.0 base
  await sendPlace(connection, mkt, bot, side, Math.max(0.000001, price), sizeFloat, "cross");
}

async function sendPlace(
  connection: Connection,
  mkt: Mkt,
  bot: BotWalletInMem,
  side: Side,
  price: number,
  sizeFloat: number,
  tag: string
) {
  const priceLots = mkt.priceToLots(price);
  const sizeLots = mkt.sizeToLots(sizeFloat);
  if (priceLots <= 0n || sizeLots <= 0n) return;
  const userBase = getAssociatedTokenAddressSync(mkt.baseMint, bot.kp.publicKey);
  const userQuote = getAssociatedTokenAddressSync(mkt.quoteMint, bot.kp.publicKey);
  const ix = ixPlaceOrder(
    {
      market: mkt.market,
      owner: bot.kp.publicKey,
      openOrders: bot.openOrders,
      bids: mkt.bids,
      asks: mkt.asks,
      eventQueue: mkt.eventQueue,
      baseVault: mkt.baseVault,
      quoteVault: mkt.quoteVault,
      userBase,
      userQuote,
      vaultSigner: mkt.vaultSigner,
    },
    {
      side,
      orderType: OrderType.Limit,
      priceLots,
      sizeLots,
      clientOrderId: BigInt(Date.now()),
    }
  );
  try {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [bot.kp]
    );
    console.log(
      `  ${bot.kp.publicKey.toBase58().slice(0, 4)} ${tag} ${side === Side.Bid ? "BUY" : "SELL"} ${sizeFloat.toFixed(4)} @ ${price.toFixed(4)}  ${sig.slice(0, 8)}`
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("0x16")) {
      // OrderCrossesBook (non-self) — re-quote as a resting order on the
      // other side so the bot still emits an event.
      return;
    }
    if (msg.includes("0x13")) return; // OpenOrdersFull — skip this turn
    if (msg.includes("0x12")) return; // BookFull
    throw e;
  }
}

async function cancelOldest(
  connection: Connection,
  mkt: Mkt,
  bot: BotWalletInMem
) {
  const ooInfo = await connection.getAccountInfo(bot.openOrders);
  if (!ooInfo) return;
  const oo = decodeOpenOrders(new Uint8Array(ooInfo.data));
  const slots = oo.slots.filter((s) => s.isUsed);
  if (slots.length === 0) return;
  const victim = slots[Math.floor(Math.random() * slots.length)];
  const userBase = getAssociatedTokenAddressSync(mkt.baseMint, bot.kp.publicKey);
  const userQuote = getAssociatedTokenAddressSync(mkt.quoteMint, bot.kp.publicKey);
  const ix = ixCancelOrder(
    {
      market: mkt.market,
      owner: bot.kp.publicKey,
      openOrders: bot.openOrders,
      bids: mkt.bids,
      asks: mkt.asks,
      eventQueue: mkt.eventQueue,
      baseVault: mkt.baseVault,
      quoteVault: mkt.quoteVault,
      userBase,
      userQuote,
      vaultSigner: mkt.vaultSigner,
    },
    { side: victim.side as Side, orderId: victim.orderId }
  );
  try {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [bot.kp]
    );
    console.log(
      `  ${bot.kp.publicKey.toBase58().slice(0, 4)} CANCEL slot=${oo.slots.indexOf(victim)} ${sig.slice(0, 8)}`
    );
  } catch (e) {
    if (!(e as Error).message.includes("0x14")) throw e; // OrderNotFound
  }
}

const EXTRA_OOS = new Map<string, PublicKey>();

async function crank(connection: Connection, mkt: Mkt, bots: BotWalletInMem[]) {
  // Read queue depth first; skip the whole pass if the queue is empty.
  let qInfo: Awaited<ReturnType<typeof connection.getAccountInfo>> = null;
  let queueCount = 0;
  let head = 0;
  try {
    qInfo = await connection.getAccountInfo(mkt.eventQueue);
    if (qInfo) {
      const headOff = 96 * 256 + 8;
      const countOff = headOff + 4;
      head = qInfo.data.readUInt32LE(headOff);
      queueCount = qInfo.data.readUInt32LE(countOff);
    }
  } catch {
    return;
  }
  if (queueCount === 0 || !qInfo) return;

  // Peek the head event's maker. If it isn't a bot wallet and we haven't
  // already resolved its OpenOrders, do a one-off chain scan and cache.
  const eventOff = head * 96;
  const makerBytes = qInfo.data.subarray(eventOff + 24, eventOff + 56);
  const makerStr = new PublicKey(makerBytes).toBase58();
  const botOwners = new Set(bots.map((b) => b.kp.publicKey.toBase58()));
  if (!botOwners.has(makerStr) && !EXTRA_OOS.has(makerStr)) {
    try {
      const found = await connection.getProgramAccounts(PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          { dataSize: 1384 },
          { memcmp: { offset: 1312, bytes: mkt.market.toBase58() } },
          { memcmp: { offset: 1344, bytes: makerStr } },
        ],
      });
      if (found.length > 0) {
        EXTRA_OOS.set(makerStr, found[0].pubkey);
        console.log(
          `  [crank] resolved maker ${makerStr.slice(0, 6)}… → ${found[0].pubkey
            .toBase58()
            .slice(0, 6)}…`
        );
      }
    } catch {
      /* ignore */
    }
  }

  const ooKeys = [...bots.map((b) => b.openOrders), ...EXTRA_OOS.values()];
  try {
    const ix = ixConsumeEvents(mkt.market, mkt.eventQueue, ooKeys, 32);
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [bots[0].kp]
    );
    console.log(`  [crank] consume events (queue=${queueCount}) ${sig.slice(0, 8)}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("0x")) console.error("  [crank]", msg);
    return;
  }
  // Settle every ~10 ticks worth of cranks to keep this cheap.
  if (Math.random() < 0.1) {
    for (const bot of bots) {
      try {
        const userBase = getAssociatedTokenAddressSync(mkt.baseMint, bot.kp.publicKey);
        const userQuote = getAssociatedTokenAddressSync(mkt.quoteMint, bot.kp.publicKey);
        const ix = ixSettleFunds({
          market: mkt.market,
          owner: bot.kp.publicKey,
          openOrders: bot.openOrders,
          baseVault: mkt.baseVault,
          quoteVault: mkt.quoteVault,
          userBase,
          userQuote,
          vaultSigner: mkt.vaultSigner,
        });
        await sendAndConfirmTransaction(connection, new Transaction().add(ix), [bot.kp]);
      } catch {
        /* nothing to settle */
      }
    }
  }
}

void MAX_OPEN_ORDERS_PER_USER; // touch import so tsc doesn't strip it

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
