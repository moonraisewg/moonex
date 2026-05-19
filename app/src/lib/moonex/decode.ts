import { PublicKey } from "@solana/web3.js";

import {
  MARKET_SIZE,
  BOOKSIDE_SIZE,
  OPENORDERS_SIZE,
  ORDERNODE_SIZE,
  OPENORDER_SLOT_SIZE,
  MAX_ORDERS_PER_SIDE,
  MAX_OPEN_ORDERS_PER_USER,
  Side,
} from ".";

function pk(buf: Uint8Array, off: number): PublicKey {
  return new PublicKey(buf.slice(off, off + 32));
}

function u64(buf: Uint8Array, off: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset + off, 8).getBigUint64(0, true);
}

function u32(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
}

export interface Market {
  tickSize: bigint;
  baseLotSize: bigint;
  quoteLotSize: bigint;
  nextOrderSeq: bigint;
  authority: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  eventQueue: PublicKey;
  tag: number;
  vaultSignerBump: number;
  baseDecimals: number;
  quoteDecimals: number;
}

export function decodeMarket(buf: Uint8Array): Market {
  if (buf.length !== MARKET_SIZE) {
    throw new Error(`Market: expected ${MARKET_SIZE} bytes, got ${buf.length}`);
  }
  return {
    tickSize: u64(buf, 0),
    baseLotSize: u64(buf, 8),
    quoteLotSize: u64(buf, 16),
    nextOrderSeq: u64(buf, 24),
    authority: pk(buf, 32),
    baseMint: pk(buf, 64),
    quoteMint: pk(buf, 96),
    baseVault: pk(buf, 128),
    quoteVault: pk(buf, 160),
    bids: pk(buf, 192),
    asks: pk(buf, 224),
    eventQueue: pk(buf, 256),
    tag: buf[288],
    vaultSignerBump: buf[289],
    baseDecimals: buf[290],
    quoteDecimals: buf[291],
  };
}

export interface OrderNode {
  priceLots: bigint;
  sizeLots: bigint;
  clientOrderId: bigint;
  seq: bigint;
  owner: PublicKey;
  ownerSlot: number;
}

export interface BookSide {
  tag: number;
  side: number;
  len: number;
  orders: OrderNode[];
}

function decodeOrderNode(buf: Uint8Array, off: number): OrderNode {
  return {
    priceLots: u64(buf, off + 0),
    sizeLots: u64(buf, off + 8),
    clientOrderId: u64(buf, off + 16),
    seq: u64(buf, off + 24),
    owner: pk(buf, off + 32),
    ownerSlot: buf[off + 64],
  };
}

export function decodeBookSide(buf: Uint8Array): BookSide {
  if (buf.length !== BOOKSIDE_SIZE) {
    throw new Error(`BookSide: expected ${BOOKSIDE_SIZE} bytes, got ${buf.length}`);
  }
  const len = Number(u64(buf, ORDERNODE_SIZE * MAX_ORDERS_PER_SIDE));
  const tag = buf[ORDERNODE_SIZE * MAX_ORDERS_PER_SIDE + 8];
  const side = buf[ORDERNODE_SIZE * MAX_ORDERS_PER_SIDE + 9];
  const orders: OrderNode[] = [];
  for (let i = 0; i < len; i++) {
    orders.push(decodeOrderNode(buf, i * ORDERNODE_SIZE));
  }
  return { tag, side, len, orders };
}

export interface OpenOrderSlot {
  priceLots: bigint;
  sizeLots: bigint;
  clientOrderId: bigint;
  seq: bigint;
  isUsed: boolean;
  side: Side;
  orderId: bigint;
}

export interface OpenOrders {
  market: PublicKey;
  owner: PublicKey;
  baseFree: bigint;
  quoteFree: bigint;
  baseLocked: bigint;
  quoteLocked: bigint;
  tag: number;
  slots: OpenOrderSlot[];
}

function decodeSlot(buf: Uint8Array, off: number): OpenOrderSlot {
  const priceLots = u64(buf, off + 0);
  const sizeLots = u64(buf, off + 8);
  const clientOrderId = u64(buf, off + 16);
  const seq = u64(buf, off + 24);
  const isUsed = buf[off + 32] !== 0;
  const side = buf[off + 33] as Side;
  const mask = (1n << 64n) - 1n;
  const priceKey = side === Side.Bid ? (~priceLots) & mask : priceLots;
  const orderId = (priceKey << 64n) | seq;
  return { priceLots, sizeLots, clientOrderId, seq, isUsed, side, orderId };
}

export function decodeOpenOrders(buf: Uint8Array): OpenOrders {
  if (buf.length !== OPENORDERS_SIZE) {
    throw new Error(`OpenOrders: expected ${OPENORDERS_SIZE} bytes, got ${buf.length}`);
  }
  const slotsLen = MAX_OPEN_ORDERS_PER_USER;
  const after = OPENORDER_SLOT_SIZE * slotsLen;
  const slots: OpenOrderSlot[] = [];
  for (let i = 0; i < slotsLen; i++) {
    slots.push(decodeSlot(buf, i * OPENORDER_SLOT_SIZE));
  }
  return {
    slots,
    baseFree: u64(buf, after + 0),
    quoteFree: u64(buf, after + 8),
    baseLocked: u64(buf, after + 16),
    quoteLocked: u64(buf, after + 24),
    market: pk(buf, after + 32),
    owner: pk(buf, after + 64),
    tag: buf[after + 96],
  };
}

void u32; // currently unused; keep helper available for EventQueue (P2)
