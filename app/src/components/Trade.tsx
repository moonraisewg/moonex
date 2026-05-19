"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { formatPrice, formatSize, priceToLots, sizeToLots } from "@/lib/market";
import { useMarket } from "@/components/MarketProvider";
import {
  Side,
  OrderType,
  ixCancelOrder,
  ixConsumeEvents,
  ixInitOpenOrders,
  ixPlaceOrder,
  ixSettleFunds,
} from "@/lib/moonex";
import botOOs from "@/lib/bot-oos.json";
import { sendAndConfirmRetry } from "@/lib/tx";
import { useToast } from "./Toast";
import {
  useAsks,
  useBids,
  useMarketList,
  useMarketStats,
  useOpenOrders,
  useOpenOrdersAddress,
  useTokenBalance,
} from "@/lib/useMoonex";
import { PriceChart, TIMEFRAMES } from "./PriceChart";

/** Print the on-chain logs for a failed tx so we can debug from console.
 *  Handles both the wallet-adapter's `SendTransactionError` and the
 *  post-send case where we have a signature but the tx was reverted. */
async function logTxFailure(
  connection: ReturnType<typeof useConnection>["connection"],
  label: string,
  err: unknown,
  sig?: string
) {
  console.error(`[${label}] failed:`, err);
  const e = err as { getLogs?: (c: typeof connection) => Promise<string[]> };
  if (typeof e.getLogs === "function") {
    try {
      const logs = await e.getLogs(connection);
      console.error(`[${label}] program logs:`, logs);
    } catch (inner) {
      console.error(`[${label}] getLogs threw:`, inner);
    }
  }
  if (sig) {
    try {
      const tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        console.error(`[${label}] tx ${sig} logs:`, tx.meta.logMessages);
      }
      if (tx?.meta?.err) {
        console.error(`[${label}] tx ${sig} err:`, tx.meta.err);
      }
    } catch (inner) {
      console.error(`[${label}] getTransaction threw:`, inner);
    }
  }
}

const BOOK_DEPTH = 12;

function fmtBalance(amount: bigint | null, decimals: number, dp = 4): string {
  if (amount == null) return "—";
  return (Number(amount) / 10 ** decimals).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={
        "flex min-h-0 flex-col rounded-md border border-white/10 bg-[#0a0a0a] " +
        className
      }
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-3 text-[10px] font-medium uppercase tracking-[0.18em] text-white/50">
        <span>{title}</span>
        {right}
      </header>
      <div className="flex flex-1 flex-col min-h-0">{children}</div>
    </section>
  );
}

/* ─────────── Market Header (in-page strip) ─────────── */

function CopyChip({
  value,
  label,
  size = "sm",
}: {
  value: string;
  label: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  const dims =
    size === "md"
      ? "h-7 px-2 text-[11px]"
      : "px-1.5 py-[2px] text-[10px]";
  const labelSize = size === "md" ? "text-[10px]" : "text-[9px]";
  return (
    <button
      type="button"
      onClick={onClick}
      title={value}
      className={
        "group inline-flex items-center gap-1.5 rounded-sm border border-white/10 bg-white/[0.03] font-mono tabular-nums text-white/55 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-white/85 " +
        dims
      }
    >
      <span className={`uppercase tracking-[0.16em] text-white/35 ${labelSize}`}>
        {label}
      </span>
      <span>
        {value.slice(0, 4)}…{value.slice(-4)}
      </span>
      <span className="text-white/35 group-hover:text-white/70">
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

function fmtNum(n: number | null | undefined, dp = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function StatBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "muted";
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-white/35">
        {label}
      </span>
      <span
        className={
          "font-mono text-[12px] tabular-nums " +
          (tone === "up"
            ? "text-emerald-300"
            : tone === "down"
              ? "text-rose-300"
              : tone === "muted"
                ? "text-white/55"
                : "text-white/90")
        }
      >
        {value}
      </span>
    </div>
  );
}

function MarketSwitcher() {
  const MARKET = useMarket();
  const router = useRouter();
  const { markets, loading } = useMarketList();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (addr: string) => {
    setOpen(false);
    router.push(`/?market=${addr}`);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex h-7 items-center gap-1.5 rounded-sm border border-white/10 bg-white/[0.04] px-2 font-mono text-[11px] tabular-nums text-white/90 transition hover:bg-white/[0.08] " +
          (open ? "border-white/25" : "")
        }
      >
        <span>{MARKET.baseSymbol}</span>
        <span className="text-white/30">/</span>
        <span className="text-white/80">{MARKET.quoteSymbol}</span>
        <span className="text-white/40">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+6px)] z-40 w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-md border border-white/10 bg-[#0a0a0a] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/55">
              switch market
            </span>
            <span className="font-mono text-[10px] text-white/35">
              {loading ? "scanning…" : `${markets.length} on-chain`}
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {markets.length === 0 ? (
              <div className="px-3 py-4 text-center font-mono text-[11px] text-white/30">
                {loading ? "discovering…" : "— none —"}
              </div>
            ) : (
              markets.map((m) => {
                const addr = m.address.toBase58();
                const active = m.address.equals(MARKET.market);
                return (
                  <button
                    key={addr}
                    type="button"
                    onClick={() => choose(addr)}
                    className={
                      "grid w-full grid-cols-[auto_1fr_1fr_auto] items-center gap-3 border-t border-white/[0.05] px-3 py-2 text-left font-mono text-[11px] tabular-nums " +
                      (active
                        ? "bg-emerald-500/[0.06]"
                        : "hover:bg-white/[0.04]")
                    }
                  >
                    <span className="text-white/65">
                      {addr.slice(0, 4)}…{addr.slice(-4)}
                    </span>
                    <span className="truncate text-white/55">
                      base {m.data.baseMint.toBase58().slice(0, 4)}…
                      <span className="ml-1 text-[9px] text-white/30">
                        d{m.data.baseDecimals}
                      </span>
                    </span>
                    <span className="truncate text-white/55">
                      quote {m.data.quoteMint.toBase58().slice(0, 4)}…
                      <span className="ml-1 text-[9px] text-white/30">
                        d{m.data.quoteDecimals}
                      </span>
                    </span>
                    {active ? (
                      <span className="text-[9px] uppercase tracking-widest text-emerald-300/80">
                        active
                      </span>
                    ) : (
                      <span className="text-[9px] uppercase tracking-widest text-white/30">
                        switch
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TimeframePicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (s: number) => void;
}) {
  return (
    <div className="flex items-center gap-px rounded-md border border-white/[0.08] bg-white/[0.02] p-[2px]">
      {TIMEFRAMES.map((tf) => {
        const active = value === tf.seconds;
        return (
          <button
            key={tf.seconds}
            type="button"
            onClick={() => onChange(tf.seconds)}
            className={
              "rounded-sm px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.14em] transition " +
              (active
                ? "bg-white/[0.12] text-white"
                : "text-white/50 hover:bg-white/[0.05] hover:text-white/85")
            }
          >
            {tf.label}
          </button>
        );
      })}
    </div>
  );
}

function MarketHeader({
  tfSec,
  onTfChange,
}: {
  tfSec: number;
  onTfChange: (s: number) => void;
}) {
  const MARKET = useMarket();
  const stats = useMarketStats();
  const delta = stats.deltaPct;
  const tone: "up" | "down" | undefined =
    delta == null ? undefined : delta >= 0 ? "up" : "down";
  const arrow = tone === "up" ? "▲" : tone === "down" ? "▼" : "·";

  return (
    <div className="flex flex-wrap items-stretch gap-x-5 gap-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <MarketSwitcher />
        <CopyChip value={MARKET.market.toBase58()} label="pool" size="md" />
      </div>

      <div className="my-[2px] w-px self-stretch bg-white/[0.06]" />

      <div className="flex items-center gap-3">
        <div
          className={
            "flex items-baseline gap-1.5 font-mono tabular-nums " +
            (tone === "up"
              ? "text-emerald-300"
              : tone === "down"
                ? "text-rose-300"
                : "text-white/90")
          }
        >
          <span className="text-[22px] font-semibold leading-none">
            {fmtNum(stats.last, 4)}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-white/40">
            {MARKET.quoteSymbol}
          </span>
        </div>
        <div
          className={
            "flex items-center gap-1 rounded-sm border px-1.5 py-[3px] font-mono text-[12px] tabular-nums " +
            (tone === "up"
              ? "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300"
              : tone === "down"
                ? "border-rose-500/30 bg-rose-500/[0.08] text-rose-300"
                : "border-white/10 bg-white/[0.03] text-white/55")
          }
        >
          <span className="text-[10px] leading-none opacity-80">{arrow}</span>
          <span className="leading-none">{fmtPct(stats.deltaPct)}</span>
          <span className="text-[9px] uppercase tracking-[0.16em] text-white/35">
            1m
          </span>
        </div>
      </div>

      <div className="my-[2px] w-px self-stretch bg-white/[0.06]" />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <StatBlock label="bid" value={fmtNum(stats.bestBid, 4)} tone="up" />
        <StatBlock label="ask" value={fmtNum(stats.bestAsk, 4)} tone="down" />
        <StatBlock
          label="spread"
          value={
            stats.spread != null
              ? `${fmtNum(stats.spread, 4)} · ${fmtPct(stats.spreadPct)}`
              : "—"
          }
          tone="muted"
        />
        <StatBlock label="hi" value={fmtNum(stats.sessionHigh, 4)} tone="muted" />
        <StatBlock label="lo" value={fmtNum(stats.sessionLow, 4)} tone="muted" />
      </div>

      <div className="ml-auto flex items-center gap-2 self-center">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
          ohlc
        </span>
        <TimeframePicker value={tfSec} onChange={onTfChange} />
      </div>
    </div>
  );
}

/* ─────────── Orderbook ─────────── */

function aggregate(orders: { priceLots: bigint; sizeLots: bigint }[], topN: number) {
  const rows: { priceLots: bigint; sizeLots: bigint }[] = [];
  for (const o of orders) {
    const last = rows[rows.length - 1];
    if (last && last.priceLots === o.priceLots) {
      last.sizeLots += o.sizeLots;
    } else {
      rows.push({ priceLots: o.priceLots, sizeLots: o.sizeLots });
      if (rows.length >= topN) break;
    }
  }
  return rows;
}

function withCumulative(rows: { priceLots: bigint; sizeLots: bigint }[]) {
  let cum = 0n;
  const out = rows.map((r) => {
    cum += r.sizeLots;
    return { ...r, cum };
  });
  const max = cum === 0n ? 1n : cum;
  // sqrt scale so small rows near top of book stay visible against the
  // tail. Linear cum/max makes the best price levels look like 1-2%.
  return out.map((r) => {
    const lin = Number((r.cum * 10_000n) / max) / 10_000;
    const pct = Math.sqrt(lin) * 100;
    return { ...r, pct };
  });
}

function BookRow({
  price,
  size,
  cum,
  pct,
  side,
  highlighted,
  onEnter,
  onLeave,
}: {
  price: bigint;
  size: bigint;
  cum: bigint;
  pct: number;
  side: "bid" | "ask";
  highlighted: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className={
        "relative grid grid-cols-[1fr_1fr_1fr] items-center gap-2 px-3 py-[3px] font-mono text-[11px] tabular-nums cursor-default " +
        (highlighted ? "bg-white/[0.05]" : "")
      }
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        className="pointer-events-none absolute inset-y-[1px] right-0 rounded-[2px]"
        style={{
          width: `${pct}%`,
          background:
            side === "bid"
              ? "linear-gradient(to left, rgba(16,185,129,0.42), rgba(16,185,129,0.08))"
              : "linear-gradient(to left, rgba(244,63,94,0.42), rgba(244,63,94,0.08))",
        }}
      />
      <span
        className={
          "relative z-10 " + (side === "bid" ? "text-emerald-300" : "text-rose-300")
        }
      >
        {formatPrice(price)}
      </span>
      <span className="relative z-10 text-right text-white/85">{formatSize(size)}</span>
      <span
        className={
          "relative z-10 text-right " +
          (highlighted ? "text-white font-semibold" : "text-white/60")
        }
      >
        {formatSize(cum)}
      </span>
    </div>
  );
}

function Orderbook() {
  const MARKET = useMarket();
  const bids = useBids();
  const asks = useAsks();
  const stats = useMarketStats();
  // Standard CEX layout:
  //   asks rendered worst → … → best ask  (best sits right above spread)
  //   spread row
  //   bids rendered best → … → worst       (best sits right below spread)
  // Aggregate yields best-first on each side, so asks need a reverse
  // and bids stay as-is.
  const bidRows = withCumulative(aggregate(bids?.orders ?? [], BOOK_DEPTH));
  const askRows = withCumulative(aggregate(asks?.orders ?? [], BOOK_DEPTH))
    .slice()
    .reverse();

  // Hover: highlight every row between the cursor and the spread on the
  // hovered side so the cumulative-to-here jumps out visually.
  //   asks display index 0 = worst, last = best. Highlight idx >= hover.
  //   bids display index 0 = best,  last = worst. Highlight idx <= hover.
  const [hover, setHover] = useState<{ side: "bid" | "ask"; idx: number } | null>(
    null
  );
  const hoveredCum =
    hover && hover.side === "ask"
      ? askRows[hover.idx]?.cum
      : hover && hover.side === "bid"
        ? bidRows[hover.idx]?.cum
        : null;

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col rounded-md border border-white/10 bg-[#0a0a0a]">
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 border-b border-white/[0.06] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/30">
        <span>price ({MARKET.quoteSymbol})</span>
        <span className="text-right">size ({MARKET.baseSymbol})</span>
        <span className="text-right">total</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col justify-end overflow-y-auto">
          {askRows.length === 0 ? (
            <div className="px-3 py-4 text-center font-mono text-[10px] text-white/25">
              — no asks —
            </div>
          ) : (
            askRows.map((o, i) => (
              <BookRow
                key={`a${i}`}
                price={o.priceLots}
                size={o.sizeLots}
                cum={o.cum}
                pct={o.pct}
                side="ask"
                highlighted={hover?.side === "ask" && i >= hover.idx}
                onEnter={() => setHover({ side: "ask", idx: i })}
                onLeave={() => setHover(null)}
              />
            ))
          )}
        </div>
        <div className="flex shrink-0 items-baseline justify-between gap-2 whitespace-nowrap border-y border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[10px] tabular-nums">
          {hoveredCum != null ? (
            <>
              <span className="text-white/40 uppercase tracking-widest">
                sweep
              </span>
              <span
                className={
                  hover?.side === "bid" ? "text-emerald-300" : "text-rose-300"
                }
              >
                Σ {formatSize(hoveredCum)} {MARKET.baseSymbol}
              </span>
              <span className="text-white/40">{MARKET.quoteSymbol}</span>
            </>
          ) : (
            <>
              <span className="text-rose-300">
                {stats.bestAsk != null ? stats.bestAsk.toFixed(4) : "—"}
              </span>
              <span
                className={
                  stats.spread != null && stats.spread < 0
                    ? "text-amber-300/80"
                    : "text-white/50"
                }
              >
                {stats.spread != null
                  ? `Δ ${stats.spread.toFixed(4)}${
                      stats.spreadPct != null
                        ? ` · ${stats.spreadPct.toFixed(2)}%`
                        : ""
                    }`
                  : "—"}
              </span>
              <span className="text-emerald-300">
                {stats.bestBid != null ? stats.bestBid.toFixed(4) : "—"}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-1 flex-col justify-start overflow-y-auto">
          {bidRows.length === 0 ? (
            <div className="px-3 py-4 text-center font-mono text-[10px] text-white/25">
              — no bids —
            </div>
          ) : (
            bidRows.map((o, i) => (
              <BookRow
                key={`b${i}`}
                price={o.priceLots}
                size={o.sizeLots}
                cum={o.cum}
                pct={o.pct}
                side="bid"
                highlighted={hover?.side === "bid" && i <= hover.idx}
                onEnter={() => setHover({ side: "bid", idx: i })}
                onLeave={() => setHover(null)}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/* ─────────── Init Open Orders / Drain ─────────── */

function InitOpenOrdersInline() {
  const MARKET = useMarket();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { address, exists, loading } = useOpenOrdersAddress();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!publicKey) return null;
  if (loading) {
    return (
      <span className="font-mono text-[10px] text-white/40">checking account…</span>
    );
  }
  if (exists && address) {
    return <CopyChip value={address.toBase58()} label="account" />;
  }
  if (!address) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    let sig: string | undefined;
    try {
      const balance = await connection.getBalance(publicKey);
      if (balance < 0.02 * 1e9) {
        throw new Error(`need ≥0.02 SOL (have ${(balance / 1e9).toFixed(4)})`);
      }
      if (!signTransaction) throw new Error("wallet has no signTransaction");
      const tx = new Transaction().add(
        ixInitOpenOrders(MARKET.market, address, publicKey)
      );
      sig = await sendAndConfirmRetry(connection, publicKey, tx, signTransaction);
      toast.push({ kind: "success", title: "account opened", sig });
    } catch (e) {
      await logTxFailure(connection, "InitOpenOrders", e, sig);
      toast.push({
        kind: "error",
        title: "open account failed",
        detail: (e as Error).message,
        sig,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={
        "rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-200 hover:bg-emerald-500/20 " +
        (busy ? "opacity-60" : "")
      }
    >
      open account
    </button>
  );
}

function DrainEventsButton() {
  const MARKET = useMarket();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { address: openOrders } = useOpenOrdersAddress();
  const toast = useToast();
  if (!publicKey) return null;

  const onClick = async () => {
    let sig: string | undefined;
    try {
      if (!signTransaction) throw new Error("wallet has no signTransaction");
      const known = new Set<string>([
        ...(openOrders ? [openOrders.toBase58()] : []),
        ...(botOOs as string[]),
      ]);
      const oos = [...known].map((s) => new PublicKey(s));
      const ix = ixConsumeEvents(MARKET.market, MARKET.eventQueue, oos, 64);
      const tx = new Transaction().add(ix);
      sig = await sendAndConfirmRetry(connection, publicKey, tx, signTransaction);
      toast.push({ kind: "success", title: "events drained", sig });
    } catch (e) {
      await logTxFailure(connection, "ConsumeEvents", e, sig);
      toast.push({
        kind: "error",
        title: "drain failed",
        detail: (e as Error).message,
        sig,
      });
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm border border-white/15 bg-white/[0.04] px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.18em] text-white/70 hover:bg-white/10"
    >
      drain events
    </button>
  );
}

/* ─────────── Order Form ─────────── */

function OrderForm() {
  const MARKET = useMarket();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const { address: openOrders, exists: ooExists } = useOpenOrdersAddress();
  const stats = useMarketStats();
  const baseBal = useTokenBalance(MARKET.baseMint);
  const quoteBal = useTokenBalance(MARKET.quoteMint);
  const toast = useToast();
  const [side, setSide] = useState<Side>(Side.Bid);
  const [price, setPrice] = useState<string>("");
  const [size, setSize] = useState<string>("0.1");
  const [busy, setBusy] = useState(false);

  const refPrice = stats.last ?? stats.bestAsk ?? stats.bestBid ?? null;
  const effectivePrice = price !== "" ? Number(price) : refPrice ?? 0;
  const sizeNum = Number(size) || 0;
  const notional = effectivePrice * sizeNum;
  const disabled = !publicKey || !openOrders || !ooExists;

  const setPercent = (pct: number) => {
    if (!effectivePrice || !Number.isFinite(effectivePrice)) return;
    if (side === Side.Bid) {
      if (quoteBal == null) return;
      const q = (Number(quoteBal) / 10 ** MARKET.quoteDecimals) * pct;
      setSize((q / effectivePrice).toFixed(4));
    } else {
      if (baseBal == null) return;
      const b = (Number(baseBal) / 10 ** MARKET.baseDecimals) * pct;
      setSize(b.toFixed(4));
    }
  };

  const onSubmit = async () => {
    if (!publicKey || !openOrders) return;
    setBusy(true);
    let sig: string | undefined;
    try {
      const px = price !== "" ? Number(price) : refPrice;
      if (px == null || !Number.isFinite(px)) throw new Error("set a price");
      const priceLots = priceToLots(px);
      const sizeLots = sizeToLots(sizeNum);
      if (priceLots <= 0n) throw new Error("price too small");
      if (sizeLots <= 0n) throw new Error("size too small");
      const userBase = getAssociatedTokenAddressSync(MARKET.baseMint, publicKey);
      const userQuote = getAssociatedTokenAddressSync(MARKET.quoteMint, publicKey);
      const fundingAta = side === Side.Bid ? userQuote : userBase;
      const fundingInfo = await connection.getAccountInfo(fundingAta);
      if (!fundingInfo || fundingInfo.data.length === 0) {
        throw new Error(
          `wallet has no ${side === Side.Bid ? MARKET.quoteSymbol : MARKET.baseSymbol} ATA`
        );
      }
      const ataIxs = [
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          userBase,
          publicKey,
          MARKET.baseMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          userQuote,
          publicKey,
          MARKET.quoteMint
        ),
      ];
      const ix = ixPlaceOrder(
        {
          market: MARKET.market,
          owner: publicKey,
          openOrders,
          bids: MARKET.bids,
          asks: MARKET.asks,
          eventQueue: MARKET.eventQueue,
          baseVault: MARKET.baseVault,
          quoteVault: MARKET.quoteVault,
          userBase,
          userQuote,
          vaultSigner: MARKET.vaultSigner,
        },
        {
          side,
          orderType: OrderType.Limit,
          priceLots,
          sizeLots,
          clientOrderId: BigInt(Date.now()),
        }
      );
      if (!signTransaction) throw new Error("wallet has no signTransaction");
      const tx = new Transaction().add(...ataIxs).add(ix);
      sig = await sendAndConfirmRetry(connection, publicKey, tx, signTransaction);
      toast.push({
        kind: "success",
        title: side === Side.Bid ? "buy placed" : "sell placed",
        detail: `${Number(size).toFixed(4)} ${MARKET.baseSymbol} @ ${
          price !== "" ? Number(price).toFixed(4) : (refPrice ?? 0).toFixed(4)
        } ${MARKET.quoteSymbol}`,
        sig,
      });
    } catch (e) {
      await logTxFailure(connection, "PlaceOrder", e, sig);
      toast.push({
        kind: "error",
        title: "place order failed",
        detail: (e as Error).message,
        sig,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col rounded-md border border-white/10 bg-[#0a0a0a]">
      <div className="flex items-center justify-end border-b border-white/[0.06] px-2.5 py-1.5">
        <InitOpenOrdersInline />
      </div>
      <div className="grid grid-cols-2 gap-px bg-white/10 p-px">
        <button
          type="button"
          onClick={() => setSide(Side.Bid)}
          className={
            "py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition " +
            (side === Side.Bid
              ? "bg-emerald-500/25 text-emerald-200"
              : "bg-[#0a0a0a] text-white/45 hover:bg-white/[0.04]")
          }
        >
          buy
        </button>
        <button
          type="button"
          onClick={() => setSide(Side.Ask)}
          className={
            "py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition " +
            (side === Side.Ask
              ? "bg-rose-500/25 text-rose-200"
              : "bg-[#0a0a0a] text-white/45 hover:bg-white/[0.04]")
          }
        >
          sell
        </button>
      </div>
      <div className="flex min-w-0 flex-col gap-2 p-2.5">
        <Field
          label="price"
          symbol={MARKET.quoteSymbol}
          value={price}
          onChange={setPrice}
          placeholder={refPrice ? refPrice.toFixed(4) : "market"}
        />
        <Field
          label="size"
          symbol={MARKET.baseSymbol}
          value={size}
          onChange={setSize}
        />
        <div className="grid grid-cols-4 gap-1">
          {[0.25, 0.5, 0.75, 1].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => setPercent(pct)}
              className="rounded-sm border border-white/10 bg-white/[0.02] py-[3px] text-[9px] uppercase tracking-[0.16em] text-white/55 hover:bg-white/[0.06] hover:text-white/80"
            >
              {pct * 100}%
            </button>
          ))}
        </div>
        <div className="space-y-1 rounded-sm border border-white/[0.06] bg-white/[0.015] px-2 py-1.5">
          <Row
            label="est. cost"
            value={`${notional.toFixed(4)} ${MARKET.quoteSymbol}`}
          />
          <Row
            label="avail."
            value={
              side === Side.Bid
                ? `${fmtBalance(quoteBal, MARKET.quoteDecimals, 2)} ${MARKET.quoteSymbol}`
                : `${fmtBalance(baseBal, MARKET.baseDecimals, 4)} ${MARKET.baseSymbol}`
            }
          />
        </div>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={onSubmit}
          className={
            "mt-1 w-full rounded-sm py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition " +
            (disabled || busy
              ? "cursor-not-allowed bg-white/[0.04] text-white/30"
              : side === Side.Bid
                ? "bg-emerald-500/80 text-black hover:bg-emerald-400"
                : "bg-rose-500/80 text-black hover:bg-rose-400")
          }
        >
          {busy
            ? "submitting…"
            : side === Side.Bid
              ? `buy ${MARKET.baseSymbol}`
              : `sell ${MARKET.baseSymbol}`}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  symbol,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex min-w-0 items-center gap-1 rounded-sm border border-white/10 bg-black/40 px-2 py-1.5 focus-within:border-white/25">
      <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-white/40">
        {label}
      </span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12px] tabular-nums outline-none placeholder:text-white/25"
      />
      <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.16em] text-white/40">
        {symbol}
      </span>
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums">
      <span className="shrink-0 text-white/40 uppercase tracking-[0.14em]">
        {label}
      </span>
      <span className="truncate text-right text-white/80">{value}</span>
    </div>
  );
}

/* ─────────── Balances ─────────── */

function Balances() {
  const MARKET = useMarket();
  const base = useTokenBalance(MARKET.baseMint);
  const quote = useTokenBalance(MARKET.quoteMint);
  const oo = useOpenOrders();
  const { address: ooAddress, exists: ooExists } = useOpenOrdersAddress();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const toast = useToast();

  const hasFree = ooExists && oo && (oo.baseFree > 0n || oo.quoteFree > 0n);
  const baseLocked = oo?.baseLocked ?? 0n;
  const quoteLocked = oo?.quoteLocked ?? 0n;
  const baseFree = oo?.baseFree ?? 0n;
  const quoteFree = oo?.quoteFree ?? 0n;

  const onSettle = async () => {
    if (!publicKey || !ooAddress) return;
    let sig: string | undefined;
    try {
      if (!signTransaction) throw new Error("wallet has no signTransaction");
      const userBase = getAssociatedTokenAddressSync(MARKET.baseMint, publicKey);
      const userQuote = getAssociatedTokenAddressSync(MARKET.quoteMint, publicKey);
      const tx = new Transaction().add(
        ixSettleFunds({
          market: MARKET.market,
          owner: publicKey,
          openOrders: ooAddress,
          baseVault: MARKET.baseVault,
          quoteVault: MARKET.quoteVault,
          userBase,
          userQuote,
          vaultSigner: MARKET.vaultSigner,
        })
      );
      sig = await sendAndConfirmRetry(connection, publicKey, tx, signTransaction);
      toast.push({ kind: "success", title: "settled", sig });
    } catch (e) {
      await logTxFailure(connection, "SettleFunds", e, sig);
      toast.push({
        kind: "error",
        title: "settle failed",
        detail: (e as Error).message,
        sig,
      });
    }
  };

  return (
    <Panel
      title="balances"
      right={
        hasFree ? (
          <button
            type="button"
            onClick={onSettle}
            className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-200 hover:bg-emerald-500/20"
          >
            settle
          </button>
        ) : (
          <DrainEventsButton />
        )
      }
    >
      <table className="w-full font-mono text-[11px] tabular-nums">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-widest text-white/30">
            <th className="px-3 py-1.5">token</th>
            <th className="px-3 py-1.5 text-right">wallet</th>
            <th className="px-3 py-1.5 text-right">locked</th>
            <th className="px-3 py-1.5 text-right">free</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-white/[0.06]">
            <td className="px-3 py-1.5 text-white/70">{MARKET.baseSymbol}</td>
            <td className="px-3 py-1.5 text-right text-white">
              {fmtBalance(base, MARKET.baseDecimals)}
            </td>
            <td className="px-3 py-1.5 text-right text-amber-200/80">
              {fmtBalance(baseLocked, MARKET.baseDecimals)}
            </td>
            <td className="px-3 py-1.5 text-right text-emerald-200/80">
              {fmtBalance(baseFree, MARKET.baseDecimals)}
            </td>
          </tr>
          <tr className="border-t border-white/[0.06]">
            <td className="px-3 py-1.5 text-white/70">{MARKET.quoteSymbol}</td>
            <td className="px-3 py-1.5 text-right text-white">
              {fmtBalance(quote, MARKET.quoteDecimals, 2)}
            </td>
            <td className="px-3 py-1.5 text-right text-amber-200/80">
              {fmtBalance(quoteLocked, MARKET.quoteDecimals, 2)}
            </td>
            <td className="px-3 py-1.5 text-right text-emerald-200/80">
              {fmtBalance(quoteFree, MARKET.quoteDecimals, 2)}
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

/* ─────────── Open Orders ─────────── */

function OpenOrdersList() {
  const MARKET = useMarket();
  const oo = useOpenOrders();
  const { address: openOrders, exists: ooExists } = useOpenOrdersAddress();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!oo) return [];
    return oo.slots
      .map((s, i) => ({ ...s, idx: i }))
      .filter((s) => s.isUsed);
  }, [oo]);

  const onCancel = async (orderId: bigint, side: Side) => {
    if (!publicKey || !openOrders) return;
    setBusy(orderId.toString());
    let sig: string | undefined;
    try {
      const userBase = getAssociatedTokenAddressSync(MARKET.baseMint, publicKey);
      const userQuote = getAssociatedTokenAddressSync(MARKET.quoteMint, publicKey);
      const ix = ixCancelOrder(
        {
          market: MARKET.market,
          owner: publicKey,
          openOrders,
          bids: MARKET.bids,
          asks: MARKET.asks,
          eventQueue: MARKET.eventQueue,
          baseVault: MARKET.baseVault,
          quoteVault: MARKET.quoteVault,
          userBase,
          userQuote,
          vaultSigner: MARKET.vaultSigner,
        },
        { side, orderId }
      );
      if (!signTransaction) throw new Error("wallet has no signTransaction");
      const tx = new Transaction().add(ix);
      sig = await sendAndConfirmRetry(connection, publicKey, tx, signTransaction);
      toast.push({ kind: "success", title: "order canceled", sig });
    } catch (e) {
      await logTxFailure(connection, "CancelOrder", e, sig);
      toast.push({
        kind: "error",
        title: "cancel failed",
        detail: (e as Error).message,
        sig,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={`open orders (${rows.length})`}
      right={openOrders ? null : <InitOpenOrdersInline />}
    >
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center font-mono text-[11px] text-white/30">
          — no open orders —
        </div>
      ) : (
        <table className="w-full font-mono text-[11px] tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-white/30">
              <th className="px-3 py-1.5">market</th>
              <th className="px-3 py-1.5">side</th>
              <th className="px-3 py-1.5 text-right">price</th>
              <th className="px-3 py-1.5 text-right">size</th>
              <th className="px-3 py-1.5 text-right">notional</th>
              <th className="px-3 py-1.5 text-right">wallet</th>
              <th className="px-3 py-1.5 text-right">slot</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const px = Number(formatPrice(r.priceLots));
              const sz = Number(formatSize(r.sizeLots));
              const ownerStr = oo?.owner ? oo.owner.toBase58() : "";
              const ownerLabel = ownerStr
                ? `${ownerStr.slice(0, 4)}…${ownerStr.slice(-4)}`
                : "—";
              return (
                <tr key={r.idx} className="border-t border-white/[0.06]">
                  <td className="px-3 py-1.5 text-white/70">
                    {MARKET.baseSymbol}/{MARKET.quoteSymbol}
                  </td>
                  <td
                    className={
                      "px-3 py-1.5 " +
                      (r.side === Side.Bid ? "text-emerald-300" : "text-rose-300")
                    }
                  >
                    {r.side === Side.Bid ? "buy" : "sell"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/90">
                    {formatPrice(r.priceLots)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/90">
                    {formatSize(r.sizeLots)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/65">
                    {(px * sz).toFixed(4)}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right text-white/55"
                    title={ownerStr}
                  >
                    {ownerLabel}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/35">{r.idx}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => onCancel(r.orderId, r.side)}
                      disabled={busy === r.orderId.toString()}
                      className="rounded-sm border border-white/15 px-2 py-[2px] text-[10px] uppercase tracking-widest text-white/70 hover:bg-white/10 disabled:opacity-40"
                    >
                      {busy === r.orderId.toString() ? "…" : "cancel"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* ─────────── Page composition ─────────── */

export function Trade() {
  const MARKET = useMarket();
  const { connected } = useWallet();
  const [tfSec, setTfSec] = useState<number>(5);

  if (!connected) {
    return (
      <div className="mx-auto max-w-md rounded-md border border-dashed border-white/15 bg-white/[0.02] p-10 text-center font-mono text-sm text-white/55">
        <div>connect wallet to trade {MARKET.baseSymbol}/{MARKET.quoteSymbol}.</div>
        <div className="mt-3 text-[11px] text-amber-300/80">
          Phantom defaults to mainnet — switch to <b>devnet</b> in
          Settings → Developer Settings.
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-2">
      <div className="col-span-12 lg:col-span-7">
        <section className="flex h-[520px] min-h-0 flex-col rounded-md border border-white/10 bg-[#0a0a0a]">
          <MarketHeader tfSec={tfSec} onTfChange={setTfSec} />
          <div className="min-h-0 flex-1 border-t border-white/[0.06]">
            <PriceChart tfSec={tfSec} />
          </div>
        </section>
      </div>
      <div className="col-span-12 sm:col-span-7 lg:col-span-2 flex flex-col h-[520px]">
        <Orderbook />
      </div>
      <div className="col-span-12 sm:col-span-5 lg:col-span-3 flex flex-col h-[520px]">
        <OrderForm />
      </div>

      <div className="col-span-12 lg:col-span-8">
        <OpenOrdersList />
      </div>
      <div className="col-span-12 lg:col-span-4">
        <Balances />
      </div>
    </div>
  );
}
