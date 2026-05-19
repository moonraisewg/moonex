"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind: ToastKind;
  title: string;
  detail?: string;
  sig?: string;
}

interface Toast extends ToastInput {
  id: number;
}

interface Ctx {
  push: (t: ToastInput) => void;
}

const ToastCtx = createContext<Ctx>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

let nextId = 0;
const SOLSCAN = (sig: string) =>
  `https://solscan.io/tx/${sig}?cluster=devnet`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((t: ToastInput) => {
    const id = ++nextId;
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
    }, 9000);
  }, []);

  const dismiss = (id: number) =>
    setItems((p) => p.filter((x) => x.id !== id));

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-[min(400px,calc(100vw-1.5rem))] flex-col gap-2">
        {items.map((t) => {
          const palette =
            t.kind === "success"
              ? "border-emerald-500/40 bg-emerald-500/[0.08]"
              : t.kind === "error"
                ? "border-rose-500/40 bg-rose-500/[0.08]"
                : "border-white/15 bg-white/[0.04]";
          const accent =
            t.kind === "success"
              ? "text-emerald-300"
              : t.kind === "error"
                ? "text-rose-300"
                : "text-white/80";
          const icon =
            t.kind === "success" ? "●" : t.kind === "error" ? "✕" : "·";
          return (
            <div
              key={t.id}
              className={
                "pointer-events-auto flex items-start gap-2 rounded-md border bg-[#0a0a0a] p-3 shadow-xl backdrop-blur " +
                palette
              }
            >
              <span className={"font-mono text-[10px] leading-none " + accent}>
                {icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className={"text-[11px] font-medium uppercase tracking-[0.16em] " + accent}>
                  {t.title}
                </div>
                {t.detail ? (
                  <div className="mt-0.5 break-all font-mono text-[10px] text-white/55">
                    {t.detail}
                  </div>
                ) : null}
                {t.sig ? (
                  <div className="mt-1 flex items-center gap-2">
                    <a
                      href={SOLSCAN(t.sig)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-white/65 underline-offset-2 hover:text-white hover:underline"
                    >
                      {t.sig.slice(0, 8)}…{t.sig.slice(-8)}
                    </a>
                    <span className="text-[9px] uppercase tracking-widest text-white/30">
                      view on solscan ↗
                    </span>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-[14px] leading-none text-white/40 hover:text-white"
                aria-label="dismiss"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
