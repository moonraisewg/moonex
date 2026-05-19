import { PublicKey, TransactionInstruction, SystemProgram, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

export const PROGRAM_ID = new PublicKey(
  "GawUJQ4vdnxeRzbnkwJsMAb1hVSh9qpXpeyvn9nXxZ72"
);

export const NETWORK: WalletAdapterNetwork = WalletAdapterNetwork.Devnet;

export const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_RPC_ENDPOINT ?? clusterApiUrl(NETWORK);

export { TOKEN_PROGRAM_ID };

// On-chain sizes mirror Rust `core::mem::size_of` of the matching Pod
// structs. Update both sides together — a mismatch shows up as
// MoonexError::InvalidAccountSize (custom error 8).
export const MARKET_SIZE = 424;
export const BOOKSIDE_SIZE = 18448; // 72*256 + 16
export const OPENORDERS_SIZE = 1384; // 40*32 + 32 + 64 + 8
export const EVENTQUEUE_SIZE = 24600; // 96*256 + 24
export const ORDERNODE_SIZE = 72;
export const OPENORDER_SLOT_SIZE = 40; // 4*u64 + (u8 + u8 + [u8;6])
export const FILLEVENT_SIZE = 96;

export const MAX_ORDERS_PER_SIDE = 256;
export const MAX_OPEN_ORDERS_PER_USER = 32;
export const MAX_EVENTS = 256;

export enum Side {
  Bid = 0,
  Ask = 1,
}

export enum OrderType {
  Limit = 0,
  PostOnly = 1,
  ImmediateOrCancel = 2,
  FillOrKill = 3,
}

export const MARKET_SEED = Buffer.from("market");
export const OPEN_ORDERS_SEED = Buffer.from("open_orders");
export const VAULT_SIGNER_SEED = Buffer.from("vault");

export function findMarket(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, baseMint.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

export function findOpenOrders(
  market: PublicKey,
  owner: PublicKey,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [OPEN_ORDERS_SEED, market.toBuffer(), owner.toBuffer()],
    programId
  );
}

export function findVaultSigner(
  market: PublicKey,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SIGNER_SEED, market.toBuffer()],
    programId
  );
}

// ---------- Instruction encoders ----------

function writeBigUint64LE(out: Uint8Array, off: number, v: bigint) {
  const dv = new DataView(out.buffer, out.byteOffset + off, 8);
  dv.setBigUint64(0, v, true);
}

function writeUint128LE(out: Uint8Array, off: number, v: bigint) {
  const mask = (1n << 64n) - 1n;
  writeBigUint64LE(out, off, v & mask);
  writeBigUint64LE(out, off + 8, v >> 64n);
}

export interface InitMarketArgs {
  baseDecimals: number;
  quoteDecimals: number;
  vaultSignerBump: number;
  tickSize: bigint;
  baseLotSize: bigint;
  quoteLotSize: bigint;
}

export function encodeInitMarket(args: InitMarketArgs): Uint8Array {
  const buf = new Uint8Array(1 + 3 + 5 + 24);
  buf[0] = 0; // disc
  buf[1] = args.baseDecimals;
  buf[2] = args.quoteDecimals;
  buf[3] = args.vaultSignerBump;
  // _pad [u8;5] at offset 4
  writeBigUint64LE(buf, 9, args.tickSize);
  writeBigUint64LE(buf, 17, args.baseLotSize);
  writeBigUint64LE(buf, 25, args.quoteLotSize);
  return buf;
}

export function encodeInitOpenOrders(): Uint8Array {
  return new Uint8Array([1]);
}

export interface PlaceOrderArgs {
  side: Side;
  orderType: OrderType;
  priceLots: bigint;
  sizeLots: bigint;
  clientOrderId: bigint;
}

export function encodePlaceOrder(args: PlaceOrderArgs): Uint8Array {
  const buf = new Uint8Array(1 + 1 + 1 + 6 + 24);
  buf[0] = 2;
  buf[1] = args.side;
  buf[2] = args.orderType;
  // _pad [u8;6]
  writeBigUint64LE(buf, 9, args.priceLots);
  writeBigUint64LE(buf, 17, args.sizeLots);
  writeBigUint64LE(buf, 25, args.clientOrderId);
  return buf;
}

export interface CancelOrderArgs {
  side: Side;
  orderId: bigint;
}

export function encodeCancelOrder(args: CancelOrderArgs): Uint8Array {
  const buf = new Uint8Array(1 + 1 + 7 + 16);
  buf[0] = 3;
  buf[1] = args.side;
  writeUint128LE(buf, 9, args.orderId);
  return buf;
}

export function makeOrderId(sideIsBid: boolean, priceLots: bigint, seq: bigint): bigint {
  const mask = (1n << 64n) - 1n;
  const priceKey = sideIsBid ? (~priceLots) & mask : priceLots;
  return (priceKey << 64n) | seq;
}

// ---------- Instruction builders ----------

export interface MarketAccounts {
  market: PublicKey;
  authority: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  eventQueue: PublicKey;
  vaultSigner: PublicKey;
}

export function ixInitMarket(
  accounts: MarketAccounts,
  args: InitMarketArgs
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.market, isSigner: false, isWritable: true },
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
      { pubkey: accounts.quoteMint, isSigner: false, isWritable: false },
      { pubkey: accounts.baseVault, isSigner: false, isWritable: false },
      { pubkey: accounts.quoteVault, isSigner: false, isWritable: false },
      { pubkey: accounts.bids, isSigner: false, isWritable: true },
      { pubkey: accounts.asks, isSigner: false, isWritable: true },
      { pubkey: accounts.eventQueue, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultSigner, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeInitMarket(args)),
  });
}

export function ixInitOpenOrders(
  market: PublicKey,
  openOrders: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: openOrders, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeInitOpenOrders()),
  });
}

export interface PlaceCancelAccounts {
  market: PublicKey;
  owner: PublicKey;
  openOrders: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  eventQueue: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  userBase: PublicKey;
  userQuote: PublicKey;
}

export function ixPlaceOrder(
  accounts: PlaceCancelAccounts & { vaultSigner: PublicKey },
  args: PlaceOrderArgs
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.market, isSigner: false, isWritable: true },
      { pubkey: accounts.owner, isSigner: true, isWritable: false },
      { pubkey: accounts.openOrders, isSigner: false, isWritable: true },
      { pubkey: accounts.bids, isSigner: false, isWritable: true },
      { pubkey: accounts.asks, isSigner: false, isWritable: true },
      { pubkey: accounts.eventQueue, isSigner: false, isWritable: true },
      { pubkey: accounts.baseVault, isSigner: false, isWritable: true },
      { pubkey: accounts.quoteVault, isSigner: false, isWritable: true },
      { pubkey: accounts.userBase, isSigner: false, isWritable: true },
      { pubkey: accounts.userQuote, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultSigner, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodePlaceOrder(args)),
  });
}

export function encodeConsumeEvents(maxEvents: number): Uint8Array {
  const buf = new Uint8Array(1 + 2);
  buf[0] = 4;
  new DataView(buf.buffer).setUint16(1, maxEvents, true);
  return buf;
}

export function encodeSettleFunds(): Uint8Array {
  return new Uint8Array([5]);
}

export function ixConsumeEvents(
  market: PublicKey,
  eventQueue: PublicKey,
  makerOpenOrders: PublicKey[],
  maxEvents: number
): TransactionInstruction {
  const keys = [
    { pubkey: market, isSigner: false, isWritable: false },
    { pubkey: eventQueue, isSigner: false, isWritable: true },
    ...makerOpenOrders.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
  ];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.from(encodeConsumeEvents(maxEvents)),
  });
}

export interface SettleFundsAccounts {
  market: PublicKey;
  owner: PublicKey;
  openOrders: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  userBase: PublicKey;
  userQuote: PublicKey;
  vaultSigner: PublicKey;
}

export function ixSettleFunds(a: SettleFundsAccounts): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.market, isSigner: false, isWritable: false },
      { pubkey: a.owner, isSigner: true, isWritable: false },
      { pubkey: a.openOrders, isSigner: false, isWritable: true },
      { pubkey: a.baseVault, isSigner: false, isWritable: true },
      { pubkey: a.quoteVault, isSigner: false, isWritable: true },
      { pubkey: a.userBase, isSigner: false, isWritable: true },
      { pubkey: a.userQuote, isSigner: false, isWritable: true },
      { pubkey: a.vaultSigner, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeSettleFunds()),
  });
}

export function ixCancelOrder(
  accounts: PlaceCancelAccounts & { vaultSigner: PublicKey },
  args: CancelOrderArgs
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.market, isSigner: false, isWritable: false },
      { pubkey: accounts.owner, isSigner: true, isWritable: false },
      { pubkey: accounts.openOrders, isSigner: false, isWritable: true },
      { pubkey: accounts.bids, isSigner: false, isWritable: true },
      { pubkey: accounts.asks, isSigner: false, isWritable: true },
      { pubkey: accounts.baseVault, isSigner: false, isWritable: true },
      { pubkey: accounts.quoteVault, isSigner: false, isWritable: true },
      { pubkey: accounts.userBase, isSigner: false, isWritable: true },
      { pubkey: accounts.userQuote, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultSigner, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeCancelOrder(args)),
  });
}

export function createAccountIx(
  payer: PublicKey,
  newAccount: PublicKey,
  space: number,
  lamports: number,
  owner: PublicKey
): TransactionInstruction {
  return SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: newAccount,
    lamports,
    space,
    programId: owner,
  });
}
