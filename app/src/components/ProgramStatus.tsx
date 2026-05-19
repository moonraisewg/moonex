"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { PROGRAM_ID } from "@/lib/moonex";

type Status = "loading" | "live" | "missing" | "error";

export function ProgramStatus() {
  const { connection } = useConnection();
  const [status, setStatus] = useState<Status>("loading");
  const [dataLen, setDataLen] = useState<number | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [acct, currentSlot] = await Promise.all([
          connection.getAccountInfo(PROGRAM_ID),
          connection.getSlot(),
        ]);
        if (cancelled) return;
        setSlot(currentSlot);
        if (!acct) {
          setStatus("missing");
          return;
        }
        setStatus("live");
        setDataLen(acct.data.length);
      } catch (e) {
        if (!cancelled) setStatus("error");
        console.error("program lookup failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-5 font-mono text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-white/60">program</span>
        <code className="truncate text-white/90">{PROGRAM_ID.toBase58()}</code>
      </div>
      <div className="mt-2 flex items-center justify-between gap-4">
        <span className="text-white/60">status</span>
        <span
          className={
            status === "live"
              ? "text-emerald-400"
              : status === "missing"
                ? "text-amber-400"
                : status === "error"
                  ? "text-rose-400"
                  : "text-white/50"
          }
        >
          {status === "loading"
            ? "checking…"
            : status === "live"
              ? `deployed (${dataLen?.toLocaleString()} B)`
              : status === "missing"
                ? "not found on cluster"
                : "rpc error"}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-4">
        <span className="text-white/60">slot</span>
        <span className="text-white/80">{slot?.toLocaleString() ?? "—"}</span>
      </div>
    </div>
  );
}
