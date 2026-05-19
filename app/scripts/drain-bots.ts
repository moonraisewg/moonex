#!/usr/bin/env tsx
//
// Pull SOL from every bot wallet back into the admin so we can pay for
// another program deploy after a failed run drained the admin.
// Usage: npm run drain-bots [-- <reserve_sol_each>]   (default 0.05)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
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
  const reserveSol = Number(process.argv[2] ?? "0.05");
  const reserve = Math.round(reserveSol * LAMPORTS_PER_SOL);
  const connection = new Connection(process.env.MOONEX_RPC_ENDPOINT ?? clusterApiUrl("devnet"), "confirmed");
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const stored = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")) as {
    secret: number[];
  }[];

  const retry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (e) {
        const msg = (e as Error).message;
        if (!/(429|Too Many Requests|503)/i.test(msg) || attempt >= 8) throw e;
        attempt++;
        const wait = Math.min(60_000, 3_000 * 2 ** attempt);
        console.log(`  ${label} 429 — waiting ${wait}ms (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  console.log(`draining ${stored.length} bot wallets → admin (leave ${reserveSol} SOL each)`);
  for (const w of stored) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(w.secret));
    let bal: number;
    try {
      bal = await retry("getBalance", () => connection.getBalance(kp.publicKey));
    } catch (e) {
      console.log(`  ${kp.publicKey.toBase58()}  bal check failed: ${(e as Error).message}`);
      continue;
    }
    if (bal <= reserve + 5_000) {
      console.log(`  ${kp.publicKey.toBase58()}  ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — skip`);
      continue;
    }
    const send = bal - reserve - 5_000; // leave fee headroom
    try {
      const sig = await retry("transfer", () => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: admin.publicKey,
            lamports: send,
          })
        );
        return sendAndConfirmTransaction(connection, tx, [kp]);
      });
      console.log(
        `  ${kp.publicKey.toBase58()}  → ${(send / LAMPORTS_PER_SOL).toFixed(4)} SOL  ${sig.slice(0, 12)}`
      );
    } catch (e) {
      console.log(`  ${kp.publicKey.toBase58()}  transfer failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const final = await connection.getBalance(admin.publicKey);
  console.log(`admin: ${(final / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
