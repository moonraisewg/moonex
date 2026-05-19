"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { formatPrice } from "./market";
import { findOpenOrders, PROGRAM_ID } from "./moonex";
import { useMarket } from "@/components/MarketProvider";
import {
  decodeBookSide,
  decodeMarket,
  decodeOpenOrders,
  type BookSide,
  type Market,
  type OpenOrders,
} from "./moonex/decode";

/** Shared account-data registry.
 *
 *  Replaces per-account `onAccountChange` websockets with a single
 *  polling timer that batches every subscribed pubkey into one
 *  `getMultipleAccountsInfo` round-trip per tick. Avoids QuickNode's
 *  15/sec accountSubscribe rate limit and keeps the number of in-flight
 *  ws connections at 0.
 *
 *  Trade-off: updates lag by up to POLL_MS instead of arriving on the
 *  next slot. Acceptable for orderbook UX.
 */
type Listener = (data: Uint8Array | null) => void;
interface SubEntry {
  pubkey: PublicKey;
  listeners: Set<Listener>;
  data: Uint8Array | null;
  loaded: boolean;
  dataHash: string;
}
const subs = new Map<string, SubEntry>();

const POLL_MS = 5_000;
const MAX_KEYS_PER_BATCH = 100;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInflight = false;
let pollConn: ReturnType<typeof useConnection>["connection"] | null = null;

function hashBytes(buf: Uint8Array | null): string {
  if (!buf) return "";
  // Cheap fingerprint: length + first/middle/last 16 bytes hex. Avoids
  // diffing 18 KB book sides byte-by-byte on every poll.
  const n = buf.length;
  const slice = (off: number, len: number) =>
    Array.from(buf.slice(off, off + len), (b) => b.toString(16).padStart(2, "0")).join("");
  if (n <= 48) return `${n}:${slice(0, n)}`;
  return `${n}:${slice(0, 16)}:${slice(Math.floor(n / 2) - 8, 16)}:${slice(n - 16, 16)}`;
}

async function pollOnce() {
  if (pollInflight || !pollConn || subs.size === 0) return;
  pollInflight = true;
  try {
    const entries = [...subs.values()];
    for (let i = 0; i < entries.length; i += MAX_KEYS_PER_BATCH) {
      const chunk = entries.slice(i, i + MAX_KEYS_PER_BATCH);
      const pks = chunk.map((e) => e.pubkey);
      const infos = await pollConn.getMultipleAccountsInfo(pks, "confirmed");
      for (let j = 0; j < chunk.length; j++) {
        const entry = chunk[j];
        if (!subs.has(entry.pubkey.toBase58())) continue;
        const info = infos[j];
        const next = info?.data ? new Uint8Array(info.data) : null;
        const nextHash = hashBytes(next);
        if (entry.loaded && nextHash === entry.dataHash) continue;
        entry.data = next;
        entry.dataHash = nextHash;
        entry.loaded = true;
        for (const l of entry.listeners) l(entry.data);
      }
    }
  } catch (e) {
    console.warn("pollOnce failed:", e);
  } finally {
    pollInflight = false;
  }
}

function ensurePollTimer() {
  if (pollTimer != null) return;
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopPollTimer() {
  if (pollTimer == null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function subscribeShared(
  connection: ReturnType<typeof useConnection>["connection"],
  pubkey: PublicKey,
  cb: Listener
): () => void {
  pollConn = connection;
  const key = pubkey.toBase58();
  let entry = subs.get(key);
  const fresh = !entry;
  if (!entry) {
    entry = { pubkey, listeners: new Set(), data: null, loaded: false, dataHash: "" };
    subs.set(key, entry);
  }
  entry.listeners.add(cb);
  if (entry.loaded) cb(entry.data);
  ensurePollTimer();
  if (fresh) {
    // Kick an immediate poll so the new pubkey is populated without
    // waiting POLL_MS. Coalesced if other subs land in the same tick.
    void pollOnce();
  }
  return () => {
    const e = subs.get(key);
    if (!e) return;
    e.listeners.delete(cb);
    if (e.listeners.size === 0) {
      subs.delete(key);
      if (subs.size === 0) stopPollTimer();
    }
  };
}

/** Subscribes to an account via the shared registry. */
function useAccountData<T>(
  pubkey: PublicKey | null,
  decode: (buf: Uint8Array) => T
): { value: T | null; error: string | null } {
  const { connection } = useConnection();
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pubkey) {
      setValue(null);
      return;
    }
    const unsub = subscribeShared(connection, pubkey, (data) => {
      if (!data) {
        setValue(null);
        return;
      }
      try {
        setValue(decode(data));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    });
    return unsub;
  }, [pubkey, connection, decode]);

  return { value, error };
}

export function useBids(): BookSide | null {
  const m = useMarket();
  return useAccountData(m.bids, decodeBookSide).value;
}

export function useAsks(): BookSide | null {
  const m = useMarket();
  return useAccountData(m.asks, decodeBookSide).value;
}

/** OpenOrders is now a PDA derived from (program, "open_orders",
 *  market, owner). The address itself is always the same for a given
 *  wallet; the only on-chain question is "has it been initialised yet?"
 *  We answer that with a single getAccountInfo and subscribe so the UI
 *  reacts the moment InitOpenOrders confirms. */
export function useOpenOrdersAddress(): {
  address: PublicKey | null;
  exists: boolean;
  loading: boolean;
} {
  const m = useMarket();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [address, setAddress] = useState<PublicKey | null>(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) {
      setAddress(null);
      setExists(false);
      setLoading(false);
      return;
    }
    const [pda] = findOpenOrders(m.market, publicKey);
    setAddress(pda);
    setLoading(true);
    const unsub = subscribeShared(connection, pda, (data) => {
      setExists(data != null && data.length > 0);
      setLoading(false);
    });
    return unsub;
  }, [connection, publicKey, m.market]);

  return { address, exists, loading };
}

export function useOpenOrders(): OpenOrders | null {
  const { address, exists } = useOpenOrdersAddress();
  return useAccountData(exists ? address : null, decodeOpenOrders).value;
}

/** Lightweight market stats derived from the live book. We don't have a
 *  fill tape, so high/low/volume are computed in-session from the mid. */
export function useMarketStats() {
  const m = useMarket();
  const bids = useBids();
  const asks = useAsks();
  const [last, setLast] = useState<number | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const highRef = useRef<number | null>(null);
  const lowRef = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  const bestBid = bids?.len ? Number(formatPrice(bids.orders[0].priceLots, m)) : null;
  const bestAsk = asks?.len ? Number(formatPrice(asks.orders[0].priceLots, m)) : null;

  useEffect(() => {
    let mid: number | null = null;
    if (bestBid != null && bestAsk != null) mid = (bestBid + bestAsk) / 2;
    else if (bestBid != null) mid = bestBid;
    else if (bestAsk != null) mid = bestAsk;
    if (mid == null || !Number.isFinite(mid)) return;
    setLast(mid);
    highRef.current = highRef.current == null ? mid : Math.max(highRef.current, mid);
    lowRef.current = lowRef.current == null ? mid : Math.min(lowRef.current, mid);
    setTick((t) => t + 1);
  }, [bestBid, bestAsk]);

  // Snapshot a baseline mid roughly once a minute so we can show a delta.
  useEffect(() => {
    const t = setInterval(() => {
      setPrev(last);
    }, 60_000);
    return () => clearInterval(t);
  }, [last]);

  const stats = useMemo(() => {
    const delta = last != null && prev != null ? last - prev : null;
    const deltaPct = delta != null && prev ? (delta / prev) * 100 : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const spreadPct = spread != null && last ? (spread / last) * 100 : null;
    return {
      last,
      prev,
      delta,
      deltaPct,
      bestBid,
      bestAsk,
      spread,
      spreadPct,
      sessionHigh: highRef.current,
      sessionLow: lowRef.current,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, prev, bestBid, bestAsk, tick]);

  return stats;
}

export interface MarketEntry {
  address: PublicKey;
  data: Market;
}

/** Discovers every initialised Market account on this program by
 *  filtering `getProgramAccounts` on size + the AccountTag::Market byte
 *  (offset 288, value 1 → base58 "2"). */
export function useMarketList(): { markets: MarketEntry[]; loading: boolean } {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const accts = await connection.getProgramAccounts(PROGRAM_ID, {
          commitment: "confirmed",
          filters: [
            { dataSize: 424 },
            { memcmp: { offset: 288, bytes: "2" } },
          ],
        });
        if (cancelled) return;
        const out: MarketEntry[] = [];
        for (const a of accts) {
          try {
            out.push({
              address: a.pubkey,
              data: decodeMarket(new Uint8Array(a.account.data)),
            });
          } catch {
            // skip malformed
          }
        }
        setMarkets(out);
      } catch (e) {
        console.warn("market list failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return { markets, loading };
}

export function useTokenBalance(mint: PublicKey): bigint | null {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [amount, setAmount] = useState<bigint | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setAmount(null);
      return;
    }
    const ata = getAssociatedTokenAddressSync(mint, publicKey);
    // SPL Token account layout: u64 `amount` at offset 64.
    const unsub = subscribeShared(connection, ata, (data) => {
      if (!data || data.length < 72) {
        setAmount(0n);
        return;
      }
      const dv = new DataView(data.buffer, data.byteOffset + 64, 8);
      setAmount(dv.getBigUint64(0, true));
    });
    return unsub;
  }, [connection, publicKey, mint]);

  return amount;
}
