/**
 * Custom send/confirm pipeline.
 *
 *  Why not `sendAndConfirmTransaction` / `Connection.confirmTransaction`?
 *  Both rely on `signatureSubscribe` which opens a websocket per call —
 *  that's the same ws path we already replaced with HTTP polling for
 *  account reads (avoiding QuickNode's 15/sec accountSubscribe limit).
 *
 *  Pipeline:
 *    1. fetch a fresh blockhash + lastValidBlockHeight (commitment-aware)
 *    2. wallet signs ONCE (single popup)
 *    3. broadcast raw bytes; re-broadcast every `resendMs` while waiting
 *    4. poll `getSignatureStatuses` every `pollMs` until confirmed
 *    5. bail if the blockhash expires (height > lastValidBlockHeight)
 *
 *  Step 3 is the cheap-but-effective retry: dropped txs get back to the
 *  leader without the user re-signing. Step 5 prevents the loop from
 *  hanging forever on a tx the cluster forgot.
 */

import {
  Commitment,
  Connection,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";

export interface SendOptions {
  commitment?: Commitment;
  /** Poll interval for getSignatureStatuses. */
  pollMs?: number;
  /** Resend the raw tx if not confirmed within this many ms. */
  resendMs?: number;
  /** Overall timeout. Defaults to ~90s (standard blockhash window). */
  timeoutMs?: number;
  /** Called when the tx is first broadcast — useful for surfacing the
   *  signature to the UI before confirmation lands. */
  onSignature?: (sig: TransactionSignature) => void;
}

export type SignFn = (tx: Transaction) => Promise<Transaction>;

const DEFAULTS = {
  commitment: "confirmed" as Commitment,
  pollMs: 1000,
  resendMs: 2500,
  timeoutMs: 90_000,
};

export async function sendAndConfirmRetry(
  connection: Connection,
  feePayer: import("@solana/web3.js").PublicKey,
  tx: Transaction,
  sign: SignFn,
  opts: SendOptions = {}
): Promise<TransactionSignature> {
  const { commitment, pollMs, resendMs, timeoutMs, onSignature } = {
    ...DEFAULTS,
    ...opts,
  };

  const latest = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.feePayer = feePayer;

  const signed = await sign(tx);
  const raw = signed.serialize();
  // Broadcast immediately so we have a signature to track.
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 0,
  });
  onSignature?.(sig);

  const start = Date.now();
  let lastResend = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    // Poll status.
    try {
      const { value } = await connection.getSignatureStatuses([sig]);
      const s = value[0];
      if (s?.err) {
        throw new Error(`tx failed: ${JSON.stringify(s.err)}`);
      }
      if (
        s &&
        (s.confirmationStatus === commitment ||
          s.confirmationStatus === "finalized")
      ) {
        return sig;
      }
    } catch (e) {
      // Treat transient RPC errors as retryable; rethrow on-chain errors.
      if ((e as Error).message?.startsWith("tx failed:")) throw e;
    }
    // Periodically re-broadcast in case the tx was dropped.
    if (Date.now() - lastResend >= resendMs) {
      lastResend = Date.now();
      try {
        await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        /* duplicate / leader rejected — fine */
      }
    }
    // Blockhash expiry check (cheap; only when nothing else fired).
    if (latest.lastValidBlockHeight) {
      let h: number;
      try {
        h = await connection.getBlockHeight(commitment);
      } catch {
        continue;
      }
      if (h > latest.lastValidBlockHeight) {
        throw new Error(`tx ${sig} expired before confirmation`);
      }
    }
  }
  throw new Error(`tx ${sig} timed out after ${timeoutMs}ms`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
