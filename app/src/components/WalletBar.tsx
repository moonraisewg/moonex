"use client";

import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export function WalletBar() {
  return (
    <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
      <div className="flex items-baseline gap-3">
        <span className="text-lg font-semibold tracking-tight">moonex</span>
        <span className="text-xs uppercase tracking-widest text-white/40">
          devnet
        </span>
      </div>
      <WalletMultiButton style={{ background: "rgba(255,255,255,0.08)" }} />
    </header>
  );
}
