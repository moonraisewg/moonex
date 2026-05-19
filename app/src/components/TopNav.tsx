"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

function useSolBalance(): number | null {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [bal, setBal] = useState<number | null>(null);
  useEffect(() => {
    if (!publicKey) {
      setBal(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const v = await connection.getBalance(publicKey, "confirmed");
        if (!cancelled) setBal(v / LAMPORTS_PER_SOL);
      } catch {
        /* ignore transient RPC errors */
      }
    };
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, publicKey]);
  return bal;
}

function NavLinks() {
  const path = usePathname();
  const items: { href: string; label: string }[] = [
    { href: "/", label: "trade" },
    { href: "/markets", label: "markets" },
  ];
  return (
    <nav className="flex items-center gap-1">
      {items.map((it) => {
        const active = path === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={
              "rounded-sm px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.18em] transition " +
              (active
                ? "bg-white/[0.08] text-white"
                : "text-white/55 hover:bg-white/[0.04] hover:text-white/85")
            }
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function TopNav() {
  const { connected } = useWallet();
  const sol = useSolBalance();

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/85 backdrop-blur">
      <div className="flex h-10 items-center gap-5 px-4 text-[11px]">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-[0.28em] text-white">
            MOONEX
          </span>
          <span className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-1 py-[1px] text-[9px] uppercase tracking-[0.16em] text-emerald-200/80">
            devnet
          </span>
        </div>

        <div className="h-5 w-px bg-white/10" />

        <NavLinks />

        <div className="ml-auto flex items-center gap-3">
          {connected ? (
            <div className="hidden items-baseline gap-1 font-mono text-[10px] tabular-nums sm:flex">
              <span className="text-white/40 uppercase tracking-[0.16em]">sol</span>
              <span className="text-white/85">
                {sol != null ? sol.toFixed(3) : "—"}
              </span>
            </div>
          ) : null}
          <WalletMultiButton
            style={{
              background: "rgba(255,255,255,0.06)",
              height: 28,
              lineHeight: "28px",
              borderRadius: 5,
              fontSize: 11,
              letterSpacing: "0.08em",
              padding: "0 10px",
            }}
          />
        </div>
      </div>
    </header>
  );
}
