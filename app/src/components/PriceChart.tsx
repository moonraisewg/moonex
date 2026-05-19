"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { useAsks, useBids } from "@/lib/useMoonex";
import { formatPrice } from "@/lib/market";
import { useMarket } from "@/components/MarketProvider";

interface HoverInfo {
  x: number;
  y: number;
  o: number;
  h: number;
  l: number;
  c: number;
  t: number;
}

export const TIMEFRAMES: { label: string; seconds: number }[] = [
  { label: "1s", seconds: 1 },
  { label: "5s", seconds: 5 },
  { label: "15s", seconds: 15 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
];

const MAX_CANDLES = 600;

export function PriceChart({ tfSec }: { tfSec: number }) {
  const MARKET = useMarket();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candlesRef = useRef<CandlestickData<UTCTimestamp>[]>([]);
  const currentRef = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const bids = useBids();
  const asks = useAsks();
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // ───── set up chart ─────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.55)",
        fontSize: 11,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: "rgba(255,255,255,0.08)",
        rightOffset: 4,
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      crosshair: { mode: 1 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(110,231,183,0.95)",
      downColor: "rgba(248,113,113,0.95)",
      borderUpColor: "rgba(110,231,183,0.95)",
      borderDownColor: "rgba(248,113,113,0.95)",
      wickUpColor: "rgba(110,231,183,0.7)",
      wickDownColor: "rgba(248,113,113,0.7)",
      priceFormat: {
        type: "price",
        precision: Math.min(MARKET.quoteDecimals, 6),
        minMove: 1 / 10 ** Math.min(MARKET.quoteDecimals, 6),
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    if (candlesRef.current.length) series.setData(candlesRef.current);

    // Crosshair → OHLC tooltip. Lightweight-charts gives us the hovered
    // candle's data via seriesData; we just position a div near cursor.
    const onMove = (param: Parameters<
      Parameters<typeof chart.subscribeCrosshairMove>[0]
    >[0]) => {
      if (
        !param.point ||
        param.time == null ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        setHover(null);
        return;
      }
      const data = param.seriesData.get(series) as
        | CandlestickData<UTCTimestamp>
        | undefined;
      if (!data) {
        setHover(null);
        return;
      }
      setHover({
        x: param.point.x,
        y: param.point.y,
        o: data.open,
        h: data.high,
        l: data.low,
        c: data.close,
        t: data.time as number,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // ───── reset candle buckets on timeframe change ─────
  useEffect(() => {
    candlesRef.current = [];
    currentRef.current = null;
    seriesRef.current?.setData([]);
  }, [tfSec]);

  // ───── ingest ticks → candles ─────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (!bids || !asks) return;
    const bestBid = bids.len > 0 ? bids.orders[0].priceLots : null;
    const bestAsk = asks.len > 0 ? asks.orders[0].priceLots : null;
    let mid: number | null = null;
    if (bestBid != null && bestAsk != null) {
      mid = (Number(formatPrice(bestBid)) + Number(formatPrice(bestAsk))) / 2;
    } else if (bestBid != null) {
      mid = Number(formatPrice(bestBid));
    } else if (bestAsk != null) {
      mid = Number(formatPrice(bestAsk));
    }
    if (mid == null || !Number.isFinite(mid)) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = (Math.floor(nowSec / tfSec) * tfSec) as UTCTimestamp;
    const cur = currentRef.current;
    if (!cur || cur.time !== bucket) {
      // close out previous bucket; start new one
      if (cur) {
        candlesRef.current.push(cur);
        if (candlesRef.current.length > MAX_CANDLES) {
          candlesRef.current.splice(
            0,
            candlesRef.current.length - MAX_CANDLES
          );
        }
      }
      const open = cur ? cur.close : mid;
      const next: CandlestickData<UTCTimestamp> = {
        time: bucket,
        open,
        high: Math.max(open, mid),
        low: Math.min(open, mid),
        close: mid,
      };
      currentRef.current = next;
      series.update(next);
    } else {
      cur.high = Math.max(cur.high, mid);
      cur.low = Math.min(cur.low, mid);
      cur.close = mid;
      series.update(cur);
    }
  }, [bids, asks, tfSec]);

  const dec = Math.min(MARKET.quoteDecimals, 6);
  return (
    <div ref={containerRef} className="relative h-full w-full">
      {hover ? (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex gap-2 rounded-sm border border-white/10 bg-black/80 px-2 py-1 font-mono text-[10px] tabular-nums text-white/85 backdrop-blur">
          <span className="text-white/40">
            {new Date(hover.t * 1000).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span>
            <span className="text-white/40">O</span> {hover.o.toFixed(dec)}
          </span>
          <span>
            <span className="text-white/40">H</span> {hover.h.toFixed(dec)}
          </span>
          <span>
            <span className="text-white/40">L</span> {hover.l.toFixed(dec)}
          </span>
          <span
            className={
              hover.c >= hover.o ? "text-emerald-300" : "text-rose-300"
            }
          >
            <span className="text-white/40">C</span> {hover.c.toFixed(dec)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
