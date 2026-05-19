#!/usr/bin/env tsx
//
// Top up every bot wallet with SOL from the admin keypair.
// Usage: npm run fund-bots [-- <sol_amount>]   (default 0.5)

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

const WALLETS_FILE = path.join("scripts", "bot-wallets.json");

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const amount = Number(process.argv[2] ?? "0.5");
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  const connection = new Connection(process.env.MOONEX_RPC_ENDPOINT ?? clusterApiUrl("devnet"), "confirmed");
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const stored = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")) as {
    secret: number[];
  }[];

  console.log(`funding ${stored.length} wallets with ${amount} SOL each (idempotent)`);

  const retry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (e) {
        const msg = (e as Error).message;
        if (!/(429|Too Many Requests|503)/i.test(msg) || attempt >= 8) throw e;
        attempt++;
        const wait = Math.min(30_000, 2_000 * 2 ** attempt);
        console.log(`  ${label} 429 — waiting ${wait}ms (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  for (const w of stored) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(w.secret));
    // Skip wallets already at or above target.
    let current: number;
    try {
      current = await retry("getBalance", () => connection.getBalance(kp.publicKey));
    } catch (e) {
      console.log(`  ${kp.publicKey.toBase58()}  balance check failed: ${(e as Error).message}`);
      continue;
    }
    if (current >= lamports * 0.95) {
      console.log(
        `  ${kp.publicKey.toBase58()}  already has ${(current / LAMPORTS_PER_SOL).toFixed(4)} SOL — skip`
      );
      continue;
    }
    try {
      const sig = await retry("transfer", async () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: kp.publicKey,
            lamports: lamports - current,
          })
        );
        return sendAndConfirmTransaction(connection, tx, [admin]);
      });
      console.log(
        `  ${kp.publicKey.toBase58()}  funded → ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL  ${sig.slice(0, 12)}`
      );
    } catch (e) {
      console.log(`  ${kp.publicKey.toBase58()}  transfer failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void PublicKey; // keep import even if tsx tree-shakes
