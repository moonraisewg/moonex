"use client";

import { useState } from "react";
import Link from "next/link";
import type { PublicKey } from "@solana/web3.js";

import { useMarketList } from "@/lib/useMoonex";
import { useMarket } from "@/components/MarketProvider";

function short(pk: PublicKey | { toBase58(): string }): string {
  const s = pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function Copy({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1000);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={value}
      className="font-mono text-[11px] text-white/65 hover:text-white"
    >
      {label ?? `${value.slice(0, 4)}…${value.slice(-4)}`}
      <span className="ml-1 text-white/30">{done ? "✓" : "⧉"}</span>
    </button>
  );
}

export function MarketsList() {
  const MARKET = useMarket();
  const { markets, loading } = useMarketList();

  return (
    <section className="flex flex-col rounded-md border border-white/10 bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.22em] text-white">
            pools
          </span>
          <span className="font-mono text-[10px] text-white/35">
            {loading
              ? "scanning chain…"
              : `${markets.length} market${markets.length === 1 ? "" : "s"} on-program`}
          </span>
        </div>
      </div>
      {markets.length === 0 ? (
        <div className="px-4 py-8 text-center font-mono text-xs text-white/30">
          {loading ? "discovering…" : "— no markets on chain —"}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/30">
                <th className="px-4 py-2">market</th>
                <th className="px-4 py-2">base mint</th>
                <th className="px-4 py-2">quote mint</th>
                <th className="px-4 py-2 text-right">tick</th>
                <th className="px-4 py-2 text-right">base lot</th>
                <th className="px-4 py-2 text-right">quote lot</th>
                <th className="px-4 py-2 text-right">vaults</th>
                <th className="px-4 py-2 text-right">event queue</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const active = m.address.equals(MARKET.market);
                return (
                  <tr
                    key={m.address.toBase58()}
                    className={
                      "border-t border-white/[0.05] " +
                      (active
                        ? "bg-emerald-500/[0.05]"
                        : "hover:bg-white/[0.02]")
                    }
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        {active ? (
                          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-[1px] text-[9px] uppercase tracking-widest text-emerald-200/80">
                            active
                          </span>
                        ) : null}
                        <Link
                          href={`/?market=${m.address.toBase58()}`}
                          className="rounded-sm border border-emerald-500/30 bg-emerald-500/[0.06] px-1.5 py-[2px] text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200/85 hover:bg-emerald-500/15"
                        >
                          trade
                        </Link>
                        <Copy value={m.address.toBase58()} label={short(m.address)} />
                      </div>
                    </td>
                    <td className="px-4 py-2 text-white/70">
                      <Copy value={m.data.baseMint.toBase58()} />
                      <span className="ml-1 text-[9px] text-white/30">
                        d{m.data.baseDecimals}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-white/70">
                      <Copy value={m.data.quoteMint.toBase58()} />
                      <span className="ml-1 text-[9px] text-white/30">
                        d{m.data.quoteDecimals}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-white/65">
                      {m.data.tickSize.toString()}
                    </td>
                    <td className="px-4 py-2 text-right text-white/65">
                      {m.data.baseLotSize.toString()}
                    </td>
                    <td className="px-4 py-2 text-right text-white/65">
                      {m.data.quoteLotSize.toString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-2 text-white/50">
                        <Copy value={m.data.baseVault.toBase58()} label="base" />
                        <Copy value={m.data.quoteVault.toBase58()} label="quote" />
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Copy value={m.data.eventQueue.toBase58()} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
