import { PublicKey } from "@solana/web3.js";

import raw from "./market.json";

export interface MarketConfig {
  programId: PublicKey;
  market: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  eventQueue: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  vaultSigner: PublicKey;
  vaultSignerBump: number;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: bigint;
  baseLotSize: bigint;
  quoteLotSize: bigint;
  baseSymbol: string;
  quoteSymbol: string;
}

export const MARKET: MarketConfig = {
  programId: new PublicKey(raw.programId),
  market: new PublicKey(raw.market),
  baseMint: new PublicKey(raw.baseMint),
  quoteMint: new PublicKey(raw.quoteMint),
  bids: new PublicKey(raw.bids),
  asks: new PublicKey(raw.asks),
  eventQueue: new PublicKey(raw.eventQueue),
  baseVault: new PublicKey(raw.baseVault),
  quoteVault: new PublicKey(raw.quoteVault),
  vaultSigner: new PublicKey(raw.vaultSigner),
  vaultSignerBump: raw.vaultSignerBump,
  baseDecimals: raw.baseDecimals,
  quoteDecimals: raw.quoteDecimals,
  tickSize: BigInt(raw.tickSize),
  baseLotSize: BigInt(raw.baseLotSize),
  quoteLotSize: BigInt(raw.quoteLotSize),
  baseSymbol: raw.baseSymbol,
  quoteSymbol: raw.quoteSymbol,
};

/** Convert (price_lots) → USDC display (e.g. "12.50"). */
export function formatPrice(priceLots: bigint, m: MarketConfig = MARKET): string {
  // 1 base lot = baseLotSize base units = baseLotSize / 10^baseDec base tokens.
  // price_lots × quote_lot_size = quote units locked per 1 base lot.
  // price per 1 base token = (price_lots × quoteLotSize / 10^quoteDec) / (baseLotSize / 10^baseDec).
  const num = priceLots * m.quoteLotSize * 10n ** BigInt(m.baseDecimals);
  const den = m.baseLotSize * 10n ** BigInt(m.quoteDecimals);
  return (Number(num) / Number(den)).toFixed(m.quoteDecimals);
}

/** Convert (size_lots) → base token display. */
export function formatSize(sizeLots: bigint, m: MarketConfig = MARKET): string {
  const units = sizeLots * m.baseLotSize;
  return (Number(units) / 10 ** m.baseDecimals).toFixed(4);
}

/** UI price (e.g. "12.5") → price_lots bigint. */
export function priceToLots(price: number, m: MarketConfig = MARKET): bigint {
  const quoteUnitsPerBaseToken = BigInt(Math.round(price * 10 ** m.quoteDecimals));
  // price_lots × quoteLotSize = quote units per 1 base lot
  // base lot = baseLotSize / 10^baseDec base tokens
  // So quote_units_per_base_lot = quoteUnitsPerBaseToken × baseLotSize / 10^baseDec
  const quoteUnitsPerBaseLot =
    (quoteUnitsPerBaseToken * m.baseLotSize) / 10n ** BigInt(m.baseDecimals);
  return quoteUnitsPerBaseLot / m.quoteLotSize;
}

/** UI size (e.g. "0.5") → size_lots bigint. */
export function sizeToLots(size: number, m: MarketConfig = MARKET): bigint {
  const units = BigInt(Math.round(size * 10 ** m.baseDecimals));
  return units / m.baseLotSize;
}
