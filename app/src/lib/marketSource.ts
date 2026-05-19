import { Connection, PublicKey } from "@solana/web3.js";

import { findVaultSigner, PROGRAM_ID } from "./moonex";
import { decodeMarket } from "./moonex/decode";
import { MARKET as DEFAULT_MARKET, type MarketConfig } from "./market";

function shortMintLabel(mint: PublicKey): string {
  const s = mint.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Build a MarketConfig by reading the on-chain Market account at
 *  `marketAddr`. Symbols default to short mint labels since we don't
 *  have a token registry. */
export async function fetchMarketConfig(
  connection: Connection,
  marketAddr: PublicKey
): Promise<MarketConfig> {
  if (marketAddr.equals(DEFAULT_MARKET.market)) {
    // Static config from build-time market.json — keeps friendly symbols.
    return DEFAULT_MARKET;
  }
  const info = await connection.getAccountInfo(marketAddr, "confirmed");
  if (!info) throw new Error(`market ${marketAddr.toBase58()} not found`);
  const m = decodeMarket(new Uint8Array(info.data));
  const [vaultSigner, vaultSignerBump] = findVaultSigner(marketAddr);
  if (vaultSignerBump !== m.vaultSignerBump) {
    console.warn(
      "vault_signer_bump from chain differs from PDA derivation — using on-chain"
    );
  }
  return {
    programId: PROGRAM_ID,
    market: marketAddr,
    baseMint: m.baseMint,
    quoteMint: m.quoteMint,
    bids: m.bids,
    asks: m.asks,
    eventQueue: m.eventQueue,
    baseVault: m.baseVault,
    quoteVault: m.quoteVault,
    vaultSigner,
    vaultSignerBump: m.vaultSignerBump,
    baseDecimals: m.baseDecimals,
    quoteDecimals: m.quoteDecimals,
    tickSize: m.tickSize,
    baseLotSize: m.baseLotSize,
    quoteLotSize: m.quoteLotSize,
    baseSymbol: shortMintLabel(m.baseMint),
    quoteSymbol: shortMintLabel(m.quoteMint),
  };
}
