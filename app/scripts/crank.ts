#!/usr/bin/env tsx
//
// Drain the event queue. Reads every queued FillEvent, resolves the
// maker's OpenOrders for each (either the PDA-derived address for
// post-migration wallets, or the random-keypair address kept in
// bot-wallets.json), then sends ConsumeEvents with the full set so
// the program can apply maker-side bookkeeping.
//
// Usage: npm run crank

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  FILLEVENT_SIZE,
  findOpenOrders,
  ixConsumeEvents,
  MAX_EVENTS,
} from "../src/lib/moonex/index.js";

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

interface BotStored {
  secret: number[];
  openOrders: string;
}

async function main() {
  const connection = new Connection(
    process.env.MOONEX_RPC_ENDPOINT ?? clusterApiUrl("devnet"),
    "confirmed"
  );
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const cfg = JSON.parse(
    fs.readFileSync(path.join("src", "lib", "market.json"), "utf8")
  );
  const market = new PublicKey(cfg.market);
  const eventQueue = new PublicKey(cfg.eventQueue);

  // Build wallet → OpenOrders override map from bot-wallets.json so we
  // can settle events created against bot wallets that used the
  // pre-PDA InitOpenOrders flow.
  const overrides: Record<string, string> = {};
  const botFile = path.join("scripts", "bot-wallets.json");
  if (fs.existsSync(botFile)) {
    const bots = JSON.parse(fs.readFileSync(botFile, "utf8")) as BotStored[];
    for (const b of bots) {
      if (!b.openOrders) continue;
      const wallet = Keypair.fromSecretKey(Uint8Array.from(b.secret)).publicKey;
      overrides[wallet.toBase58()] = b.openOrders;
    }
  }

  const qInfo = await connection.getAccountInfo(eventQueue);
  if (!qInfo) throw new Error("event queue missing");
  const data = qInfo.data;
  const eventsBase = 0;
  const countOff = FILLEVENT_SIZE * MAX_EVENTS + 12; // events + seq(8) + head(4)
  const headOff = FILLEVENT_SIZE * MAX_EVENTS + 8;
  const head = data.readUInt32LE(headOff);
  const count = data.readUInt32LE(countOff);
  console.log(`queue head=${head} count=${count}`);
  if (count === 0) {
    console.log("queue empty, nothing to do");
    return;
  }

  const makers = new Set<string>();
  for (let i = 0; i < count; i++) {
    const idx = (head + i) % MAX_EVENTS;
    const off = eventsBase + idx * FILLEVENT_SIZE;
    const makerBytes = data.subarray(off + 24, off + 24 + 32);
    makers.add(new PublicKey(makerBytes).toBase58());
  }
  console.log(`unique makers: ${makers.size}`);

  const ooAccounts: PublicKey[] = [];
  for (const wallet of makers) {
    const override = overrides[wallet];
    if (override) {
      ooAccounts.push(new PublicKey(override));
      console.log(`  ${wallet.slice(0, 6)}… → bot OO ${override.slice(0, 6)}…`);
      continue;
    }
    const [pda] = findOpenOrders(market, new PublicKey(wallet));
    const exists = await connection.getAccountInfo(pda);
    if (exists) {
      ooAccounts.push(pda);
      console.log(`  ${wallet.slice(0, 6)}… → PDA ${pda.toBase58().slice(0, 6)}…`);
      continue;
    }
    // Fall back to a chain scan — there might be a pre-PDA random-keypair
    // OpenOrders for this wallet that still holds the locked funds.
    const programId = new PublicKey(cfg.programId);
    const found = await connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [
        { dataSize: 1384 },
        { memcmp: { offset: 1312, bytes: market.toBase58() } },
        { memcmp: { offset: 1344, bytes: wallet } },
      ],
    });
    if (found.length > 0) {
      for (const f of found) {
        ooAccounts.push(f.pubkey);
        console.log(
          `  ${wallet.slice(0, 6)}… → legacy OO ${f.pubkey.toBase58().slice(0, 6)}…`
        );
      }
    } else {
      console.log(`  ${wallet.slice(0, 6)}… → MISSING (no PDA, no legacy, no bot mapping)`);
    }
  }

  if (ooAccounts.length === 0) {
    console.log("no resolvable OOs — cannot crank");
    return;
  }

  // ConsumeEvents up to the queue capacity; transaction account limit
  // (~64) might cap how many OOs we can pass per call. Loop just in
  // case.
  let remaining = count;
  while (remaining > 0) {
    const max = Math.min(remaining, 32);
    const ix = ixConsumeEvents(market, eventQueue, ooAccounts, max);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
    console.log(`consume max=${max}  ${sig}`);
    const after = await connection.getAccountInfo(eventQueue);
    if (!after) break;
    const newCount = after.data.readUInt32LE(countOff);
    if (newCount === remaining) {
      console.log("no progress this round — stopping");
      break;
    }
    remaining = newCount;
    console.log(`queue now ${remaining}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
