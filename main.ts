// btc-race-24h-20261115-0828: deep-dip mean reversion, long only.
//
// The idea: in a one-asset replay (cbBTC vs USDC, 1-minute bars) the only way to make money
// long-only is to buy a real local oversold dip after it turns, ride the bounce, and leave. It
// never shorts, never holds through a falling window, and it trades rarely, because a full-size
// round trip costs roughly 40 bps in fee, slippage and price impact and a move must clear that.
//
//   - Dip: a close at least DIP_DD_BPS (3%) below the rolling DIP_LOOKBACK (120-bar) high. That
//     drawdown arms a latched oversold event, which stays live for DIP_EXPIRY_BARS (240) bars so the
//     entry can wait for a turn instead of demanding the dip be instant. It arms once per crossing:
//     the drawdown must recover below half the threshold before a new event can arm, so one selloff
//     is played once even across a stop-out and cooldown.
//   - Rebound confirmation: the newest bar is not a new low, and the close is either up over the last
//     REBOUND_BARS (15) bars or REBOUND_OFF_LOW_BPS (0.2%) off that window's low. The first confirmed
//     bounce while the event is live is the entry, and the entry consumes the event.
//   - Exits, all decided on the latest close and filled at the next open: a stop at STOP_BPS (1.5%)
//     below cost, a take-profit at TARGET_BPS (4%) above cost, a trailing stop of TRAIL_BPS (1%) that
//     only arms once the position is TRAIL_ARM_BPS (2.5%) over cost, and a time stop at MAX_HOLD_BARS
//     (120) bars, where the bounce edge in the dev data peaks and then fades.
//   - Cooldown: after any exit it sits out COOLDOWN_BARS (30) minutes, so it does not immediately
//     re-enter the same chop and pay the round trip again.
//   - Sizing is regime-adaptive: 60-95% of equity, scaled down when recent realised volatility is
//     high and scaled with the dip depth. One asset and a hard stop keep the per-trade risk bounded.
//
// It reads only the closes it has already observed and the account the harness reports; every
// decision uses bars already received, never a later bar, and no clock, environment or randomness is
// consulted, so two runs on the same window produce byte-identical action logs.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Rolling high lookback, in bars: a dip is a drawdown off this window's high. */
const DIP_LOOKBACK = 120;
/** A close this many bps below the window high opens an oversold event. */
const DIP_DD_BPS = 300;
/** The oversold event stays live this many bars, waiting for a rebound before it expires. */
const DIP_EXPIRY_BARS = 240;
/** Rebound confirmation: positive return over this many bars, or this far off the window low. */
const REBOUND_BARS = 15;
/** How far off the rolling low (bps) counts as a rebound when the longer return is not positive. */
const REBOUND_OFF_LOW_BPS = 20;
/** Stop loss below entry cost, in bps: wide enough to survive entry noise, tight enough to cap a loss. */
const STOP_BPS = 150;
/** Take profit above entry cost, in bps. */
const TARGET_BPS = 400;
/** Trailing stop distance, in bps. */
const TRAIL_BPS = 100;
/** Profit above cost (bps) at which the trailing stop arms: only near the target, so it protects a gain without cutting it early. */
const TRAIL_ARM_BPS = 250;
/** Longest hold, in bars: the bounce edge peaks around two hours and then fades. */
const MAX_HOLD_BARS = 120;
/** Bars to sit out after an exit. */
const COOLDOWN_BARS = 30;

/** Volatility lookback for regime sizing, in bars. */
const VOL_BARS = 30;
/** Exposure floor and ceiling, as a fraction of equity: one asset, a hard stop, so most capital is deployed. */
const MIN_FRAC = 0.6;
const MAX_FRAC = 0.95;

/** An order may slip this many bps past the latest close before the market refuses it. */
const MAX_SLIPPAGE_BPS = 200;

const closes: number[] = [];
/** The trailing stop's peak position value, in quote units; reset only when the account is flat. */
let peak = 0n;
/** True once the trailing stop is armed for the current position. */
let trailArmed = false;
/** Bars left to sit out; decremented each fresh bar while flat. */
let cooldown = 0;
/** Batch seq through which the current oversold event may still trigger an entry (-1: none). */
let oversoldUntil = -1;
/** Whether the account held the position on the previous batch, to read fills as transitions. */
let prevHeld = false;
/** Batch seq at which the current position was first seen in the account (-1: none). */
let entrySeq = -1;
/** Hysteresis: true once the drawdown has recovered below half the dip threshold, so a new event can arm. */
let dipReset = true;

/** Recent realised volatility: the sample std of the last VOL_BARS close-to-close returns. */
function volatility(): number {
  const n = closes.length;
  if (n < 2) return 0;
  const start = Math.max(1, n - VOL_BARS);
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < n; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    sum += r;
    sumSq += r * r;
    count++;
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** The exposure fraction for a fresh entry, from the dip depth and recent volatility. */
function sizeFraction(depth: number): number {
  const vol = volatility();
  // A 1-minute return std of 0.15% is treated as a calm regime; scale down as it climbs.
  const calm = Math.max(0, 1 - vol / 0.0015);
  // Deeper dips get a modestly larger bet, capped.
  const deep = Math.min(1, depth / 0.05);
  const frac = MAX_FRAC * (0.5 + 0.5 * calm) * (0.85 + 0.15 * deep);
  return Math.max(MIN_FRAC, Math.min(MAX_FRAC, frac));
}

/** The current drawdown off the rolling high over DIP_LOOKBACK bars, as a fraction (0 if short). */
function drawdown(): number {
  const n = closes.length;
  if (n < DIP_LOOKBACK) return 0;
  let high = -Infinity;
  for (let i = n - DIP_LOOKBACK; i < n; i++) if (closes[i] > high) high = closes[i];
  return high > 0 ? (high - closes[n - 1]) / high : 0;
}

/** Whether the last bars confirm a rebound off the rolling low or a positive short return. */
function reboundConfirmed(): boolean {
  const n = closes.length;
  if (n < REBOUND_BARS + 2) return false;
  const last = closes[n - 1];
  if (last < closes[n - 2]) return false; // the newest bar must not make a new low
  const ret = last / closes[n - REBOUND_BARS - 1] - 1;
  let low = Infinity;
  for (let i = n - REBOUND_BARS; i < n; i++) if (closes[i] < low) low = closes[i];
  const offLow = low > 0 ? (last - low) / low : 0;
  return ret > 0 || offLow >= REBOUND_OFF_LOW_BPS / 10_000;
}

/** Exit the whole position when its value breaches the stop, target or armed trailing stop. */
function shouldExit(state: BarsState, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(SYMBOL, held.qty);
  const cost = held.cost;
  // Stop and take-profit are relative to cost.
  if (value * BPS <= cost * (BPS - BigInt(STOP_BPS))) return true;
  if (value * BPS >= cost * (BPS + BigInt(TARGET_BPS))) return true;
  // Trailing stop arms once value is TRAIL_ARM_BPS over cost, then trails TRAIL_BPS off the peak.
  if (value > peak) peak = value;
  if (!trailArmed && value * BPS >= cost * (BPS + BigInt(TRAIL_ARM_BPS))) trailArmed = true;
  if (trailArmed && value * BPS <= peak * (BPS - BigInt(TRAIL_BPS))) return true;
  // Time stop: a confirmed bounce is a swing trade, not a hold.
  if (entrySeq >= 0 && state.seq - entrySeq >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      fresh = true;
    }

    // Read fills from the account, never from assumptions: only a real flat/held transition resets
    // the trailing state, so a refused sell keeps the peak it already had.
    const held = state.positions.get(SYMBOL);
    const heldNow = held !== undefined;
    if (heldNow && !prevHeld) {
      peak = state.value(SYMBOL, held!.qty);
      trailArmed = false;
      entrySeq = state.seq;
      oversoldUntil = -1; // one entry per dip event: do not re-enter the same latch
    } else if (!heldNow && prevHeld) {
      peak = 0n;
      trailArmed = false;
      cooldown = COOLDOWN_BARS;
      entrySeq = -1;
    }
    prevHeld = heldNow;

    if (state.warmingUp) return [];
    if (!fresh) return []; // no bar this minute: decide nothing on stale prices

    // Arm an oversold event once per dip crossing, with hysteresis: the drawdown must recover below
    // half the entry threshold before a new event can arm. An entry consumes the event, so the same
    // selloff cannot re-fire after a stop-out and cooldown (the old rearm-every-bar latch could, and
    // did in a persistent selloff).
    const depth = drawdown();
    if (depth < DIP_DD_BPS / 20_000) dipReset = true;
    if (dipReset && depth >= DIP_DD_BPS / 10_000) {
      oversoldUntil = state.seq + DIP_EXPIRY_BARS;
      dipReset = false;
    }

    if (held !== undefined) {
      if (shouldExit(state, held)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }] satisfies SellInput[];
      }
      return [];
    }

    if (cooldown > 0) {
      cooldown--;
      return [];
    }
    if (state.seq > oversoldUntil || !reboundConfirmed()) return [];

    const frac = sizeFraction(depth);
    let notional = (BigInt(Math.round(frac * 1e6)) * state.equity) / 1_000_000n;
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }] satisfies BuyInput[];
  },
});
