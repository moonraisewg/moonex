#!/usr/bin/env tsx
//
// Bootstraps a Moonex SOL/USDC test market on devnet.
//
// Usage: npx tsx scripts/init-market.ts <user_wallet_pubkey>
//
// Outputs app/src/lib/market.json — the FE picks the market up from there.

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
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";

import {
  BOOKSIDE_SIZE,
  EVENTQUEUE_SIZE,
  MARKET_SIZE,
  PROGRAM_ID,
  findVaultSigner,
  ixInitMarket,
} from "../src/lib/moonex/index.js";

const TICK_SIZE = 1n;
const BASE_LOT_SIZE = 1_000_000n; // 0.001 moonSOL per base lot (9 dec)
const QUOTE_LOT_SIZE = 1_000n; // 0.001 moonUSDC per quote lot (6 dec)
const BASE_DECIMALS = 9;
const QUOTE_DECIMALS = 6;

const MINT_BASE_AMOUNT = 10n * 10n ** 9n;
const MINT_QUOTE_AMOUNT = 10_000n * 10n ** 6n;

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(process.env.MOONEX_RPC_ENDPOINT ?? clusterApiUrl("devnet"), "confirmed");
  const admin = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  // Default the trader wallet to the CLI keypair so this script is fully
  // self-contained. Pass a base58 pubkey as argv[2] to mint tokens to a
  // different (Phantom-controlled) wallet instead.
  const userWallet = process.argv[2]
    ? new PublicKey(process.argv[2])
    : admin.publicKey;
  console.log("admin:", admin.publicKey.toBase58());
  console.log("user :", userWallet.toBase58());

  // --- fund user with a little SOL for tx fees ---
  console.log("\n[1/7] funding user");
  if (userWallet.equals(admin.publicKey)) {
    console.log("  user === admin, skip");
  } else {
    const userBal = await connection.getBalance(userWallet);
    if (userBal < 0.05 * LAMPORTS_PER_SOL) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: userWallet,
          lamports: 0.2 * LAMPORTS_PER_SOL,
        })
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
      console.log("  +0.2 SOL", sig);
    } else {
      console.log(`  user has ${(userBal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    }
  }

  // --- mints ---
  console.log("\n[2/7] creating moonSOL + moonUSDC mints");
  const baseMintKp = Keypair.generate();
  const quoteMintKp = Keypair.generate();
  const mintRent = await getMinimumBalanceForRentExemptMint(connection);
  const mintTx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: baseMintKp.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      })
    )
    .add(
      createInitializeMintInstruction(
        baseMintKp.publicKey,
        BASE_DECIMALS,
        admin.publicKey,
        admin.publicKey
      )
    )
    .add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: quoteMintKp.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      })
    )
    .add(
      createInitializeMintInstruction(
        quoteMintKp.publicKey,
        QUOTE_DECIMALS,
        admin.publicKey,
        admin.publicKey
      )
    );
  const mintSig = await sendAndConfirmTransaction(connection, mintTx, [
    admin,
    baseMintKp,
    quoteMintKp,
  ]);
  console.log("  baseMint :", baseMintKp.publicKey.toBase58());
  console.log("  quoteMint:", quoteMintKp.publicKey.toBase58());
  console.log("  tx:", mintSig);

  // --- allocate market + book + queue accounts (random keypairs, owned by program) ---
  console.log("\n[3/7] allocating market / bids / asks / event queue");
  const marketKp = Keypair.generate();
  const bidsKp = Keypair.generate();
  const asksKp = Keypair.generate();
  const queueKp = Keypair.generate();
  const marketRent = await connection.getMinimumBalanceForRentExemption(MARKET_SIZE);
  const bookRent = await connection.getMinimumBalanceForRentExemption(BOOKSIDE_SIZE);
  const queueRent = await connection.getMinimumBalanceForRentExemption(EVENTQUEUE_SIZE);

  for (const [name, kp, size, lamports] of [
    ["market", marketKp, MARKET_SIZE, marketRent],
    ["bids", bidsKp, BOOKSIDE_SIZE, bookRent],
    ["asks", asksKp, BOOKSIDE_SIZE, bookRent],
    ["queue", queueKp, EVENTQUEUE_SIZE, queueRent],
  ] as const) {
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports,
        space: size,
        programId: PROGRAM_ID,
      })
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [admin, kp]);
    console.log(`  ${name}:`, kp.publicKey.toBase58(), `(${size} B)`, sig);
  }

  const [vaultSigner, vaultSignerBump] = findVaultSigner(marketKp.publicKey);
  console.log("  vaultSigner:", vaultSigner.toBase58(), "bump", vaultSignerBump);

  // --- vault token accounts (authority = vault signer PDA) ---
  console.log("\n[4/7] vault ATAs");
  const baseVault = getAssociatedTokenAddressSync(
    baseMintKp.publicKey,
    vaultSigner,
    true
  );
  const quoteVault = getAssociatedTokenAddressSync(
    quoteMintKp.publicKey,
    vaultSigner,
    true
  );
  const vaultTx = new Transaction()
    .add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        baseVault,
        vaultSigner,
        baseMintKp.publicKey
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        quoteVault,
        vaultSigner,
        quoteMintKp.publicKey
      )
    );
  await sendAndConfirmTransaction(connection, vaultTx, [admin]);
  console.log("  baseVault :", baseVault.toBase58());
  console.log("  quoteVault:", quoteVault.toBase58());

  // --- user ATAs + initial mint ---
  console.log("\n[5/7] user ATAs + test balances");
  const userBaseAta = getAssociatedTokenAddressSync(
    baseMintKp.publicKey,
    userWallet
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    quoteMintKp.publicKey,
    userWallet
  );
  const fundTx = new Transaction()
    .add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        userBaseAta,
        userWallet,
        baseMintKp.publicKey
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        userQuoteAta,
        userWallet,
        quoteMintKp.publicKey
      )
    )
    .add(
      createMintToInstruction(
        baseMintKp.publicKey,
        userBaseAta,
        admin.publicKey,
        MINT_BASE_AMOUNT
      )
    )
    .add(
      createMintToInstruction(
        quoteMintKp.publicKey,
        userQuoteAta,
        admin.publicKey,
        MINT_QUOTE_AMOUNT
      )
    );
  await sendAndConfirmTransaction(connection, fundTx, [admin]);
  console.log("  userBaseAta :", userBaseAta.toBase58());
  console.log("  userQuoteAta:", userQuoteAta.toBase58());

  // --- InitMarket ---
  console.log("\n[6/7] InitMarket");
  const initIx = ixInitMarket(
    {
      market: marketKp.publicKey,
      authority: admin.publicKey,
      baseMint: baseMintKp.publicKey,
      quoteMint: quoteMintKp.publicKey,
      baseVault,
      quoteVault,
      bids: bidsKp.publicKey,
      asks: asksKp.publicKey,
      eventQueue: queueKp.publicKey,
      vaultSigner,
    },
    {
      baseDecimals: BASE_DECIMALS,
      quoteDecimals: QUOTE_DECIMALS,
      vaultSignerBump,
      tickSize: TICK_SIZE,
      baseLotSize: BASE_LOT_SIZE,
      quoteLotSize: QUOTE_LOT_SIZE,
    }
  );
  const initSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(initIx),
    [admin]
  );
  console.log("  tx:", initSig);

  // --- write config ---
  console.log("\n[7/7] writing market.json");
  const config = {
    programId: PROGRAM_ID.toBase58(),
    market: marketKp.publicKey.toBase58(),
    baseMint: baseMintKp.publicKey.toBase58(),
    quoteMint: quoteMintKp.publicKey.toBase58(),
    bids: bidsKp.publicKey.toBase58(),
    asks: asksKp.publicKey.toBase58(),
    eventQueue: queueKp.publicKey.toBase58(),
    baseVault: baseVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
    vaultSigner: vaultSigner.toBase58(),
    vaultSignerBump,
    baseDecimals: BASE_DECIMALS,
    quoteDecimals: QUOTE_DECIMALS,
    tickSize: TICK_SIZE.toString(),
    baseLotSize: BASE_LOT_SIZE.toString(),
    quoteLotSize: QUOTE_LOT_SIZE.toString(),
    baseSymbol: "moonSOL",
    quoteSymbol: "moonUSDC",
  };
  const outPath = path.join("src", "lib", "market.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log("  →", outPath);
  console.log("\nDone. Next:");
  console.log("  npm run dev");
  console.log("  open http://localhost:3001/ and connect your wallet.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
