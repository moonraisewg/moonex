#!/usr/bin/env tsx
//
// Mint extra moonSOL + moonUSDC to a wallet on the *current* market.
// Reads app/src/lib/market.json — does not create a new market.
//
// Usage:
//   npm run mint -- <wallet_pubkey> [baseAmount] [quoteAmount]
// Defaults: 100 moonSOL, 100 000 moonUSDC.

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
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const walletArg = process.argv[2];
  if (!walletArg) {
    console.error("usage: tsx scripts/mint-more.ts <wallet_pubkey> [baseAmt] [quoteAmt]");
    process.exit(1);
  }
  const baseAmtUi = Number(process.argv[3] ?? "100");
  const quoteAmtUi = Number(process.argv[4] ?? "100000");
  const user = new PublicKey(walletArg);

  const config = JSON.parse(
    fs.readFileSync(path.join("src", "lib", "market.json"), "utf8")
  );
  const baseMint = new PublicKey(config.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);
  const baseDec: number = config.baseDecimals;
  const quoteDec: number = config.quoteDecimals;

  const baseAmt = BigInt(Math.round(baseAmtUi * 10 ** baseDec));
  const quoteAmt = BigInt(Math.round(quoteAmtUi * 10 ** quoteDec));

  const connection = new Connection(process.env.MOONEX_RPC_ENDPOINT ?? clusterApiUrl("devnet"), "confirmed");
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  console.log("admin    :", admin.publicKey.toBase58());
  console.log("user     :", user.toBase58());
  console.log("baseMint :", baseMint.toBase58(), `(+${baseAmtUi} ${config.baseSymbol})`);
  console.log("quoteMint:", quoteMint.toBase58(), `(+${quoteAmtUi} ${config.quoteSymbol})`);

  const userBase = getAssociatedTokenAddressSync(baseMint, user);
  const userQuote = getAssociatedTokenAddressSync(quoteMint, user);

  const tx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        userBase,
        user,
        baseMint
      )
    )
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        userQuote,
        user,
        quoteMint
      )
    )
    .add(createMintToInstruction(baseMint, userBase, admin.publicKey, baseAmt))
    .add(createMintToInstruction(quoteMint, userQuote, admin.publicKey, quoteAmt));

  const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log("\nsig:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
