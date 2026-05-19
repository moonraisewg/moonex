import { Connection, PublicKey } from "@solana/web3.js";
import { decodeMarket, decodeBookSide } from "../src/lib/moonex/decode";
import { BOOKSIDE_SIZE } from "../src/lib/moonex";

const RPC = process.env.NEXT_PUBLIC_RPC_ENDPOINT!;
const MKT = new PublicKey("7MarmTAmGDSbnTKC3nC8s2ALXHuURj3KsAqnbZW6RNiC");
const conn = new Connection(RPC, "confirmed");

(async () => {
  const m = await conn.getAccountInfo(MKT);
  if (!m) { console.log("no market account"); return; }
  const mk = decodeMarket(m.data);
  console.log("market:", MKT.toBase58());
  console.log("owner:", m.owner.toBase58(), "len:", m.data.length, "lamports:", m.lamports);
  console.log("authority:", mk.authority.toBase58());
  console.log("base/quote mint:", mk.baseMint.toBase58(), "/", mk.quoteMint.toBase58());
  console.log("baseDecimals:", mk.baseDecimals, "quoteDecimals:", mk.quoteDecimals);
  console.log("tickSize:", mk.tickSize.toString(), "baseLot:", mk.baseLotSize.toString(), "quoteLot:", mk.quoteLotSize.toString());
  console.log("nextOrderSeq:", mk.nextOrderSeq.toString());
  console.log("bids:", mk.bids.toBase58(), "asks:", mk.asks.toBase58());
  console.log("eventQueue:", mk.eventQueue.toBase58());
  console.log("baseVault:", mk.baseVault.toBase58(), "quoteVault:", mk.quoteVault.toBase58());
  console.log("vaultSignerBump:", mk.vaultSignerBump, "tag:", mk.tag);

  const [bidsAcc, asksAcc, eqAcc, bvAcc, qvAcc] = await conn.getMultipleAccountsInfo([
    mk.bids, mk.asks, mk.eventQueue, mk.baseVault, mk.quoteVault,
  ]);
  if (bidsAcc) {
    const bs = decodeBookSide(bidsAcc.data);
    console.log(`\nBIDS len=${bs.len} (BOOKSIDE_SIZE=${BOOKSIDE_SIZE} match=${bidsAcc.data.length===BOOKSIDE_SIZE})`);
    bs.orders.slice(0, 12).forEach((o, i) => {
      const price = Number(o.priceLots) * Number(mk.tickSize) * Number(mk.quoteLotSize) / 10**mk.quoteDecimals / (Number(mk.baseLotSize) / 10**mk.baseDecimals);
      const size = Number(o.sizeLots) * Number(mk.baseLotSize) / 10**mk.baseDecimals;
      console.log(`  [${i}] p=${o.priceLots} (~${price.toFixed(4)}) sz=${o.sizeLots} (~${size.toFixed(4)}) owner=${o.owner.toBase58().slice(0,6)}…`);
    });
  } else console.log("BIDS missing");
  if (asksAcc) {
    const as = decodeBookSide(asksAcc.data);
    console.log(`\nASKS len=${as.len}`);
    as.orders.slice(0, 12).forEach((o, i) => {
      const price = Number(o.priceLots) * Number(mk.tickSize) * Number(mk.quoteLotSize) / 10**mk.quoteDecimals / (Number(mk.baseLotSize) / 10**mk.baseDecimals);
      const size = Number(o.sizeLots) * Number(mk.baseLotSize) / 10**mk.baseDecimals;
      console.log(`  [${i}] p=${o.priceLots} (~${price.toFixed(4)}) sz=${o.sizeLots} (~${size.toFixed(4)}) owner=${o.owner.toBase58().slice(0,6)}…`);
    });
  } else console.log("ASKS missing");
  console.log("\neventQueue lamports:", eqAcc?.lamports, "len:", eqAcc?.data.length);
  console.log("baseVault lamports:", bvAcc?.lamports, "quoteVault lamports:", qvAcc?.lamports);
})();
