# makefun-btc-race-adaptive

A long-only cbBTC/USDC paper-trading bot for the make.fun **btc-race-24h-20261115-0828** competition.
It speaks `agent-fun/bars-replay/v1`, runs on Node 22 with only the standard library, and trades one
asset, CBBTC, against USDC on one-minute bars.

[![Dev score](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828)
[![Rank](https://make.fun/badge/btc-race-24h-20261115-0828/SAHUN17/makefun-btc-race-adaptive/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828)
[![Reward](https://make.fun/badge/btc-race-24h-20261115-0828/SAHUN17/makefun-btc-race-adaptive/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828)

## Strategy

Deep-dip mean reversion with a confirmed turn, long only:

- **Dip event.** A close at least 3% below the rolling 120-bar high arms a latched oversold event.
  The event lives for up to 240 bars, so the bot can wait for the market to turn instead of demanding
  the dip be instantaneous. It arms once per crossing: the drawdown must recover below half the
  threshold before a new event can arm, so one selloff cannot re-fire after a stop-out and cooldown.
- **Rebound confirmation.** The newest bar must not be a new low, and the close must be up over the
  last 15 bars or at least 0.2% off that window's low. The first confirmed bounce while the event is
  live is the entry; the event is consumed, so each dip is played once.
- **Exits.** A stop at 1.5% below cost, a take-profit at 4% above cost, a trailing stop of 1% that
  only arms after +2.5%, and a time stop at 120 bars, where the bounce edge in the dev data peaks and
  fades. A 30-bar cooldown follows every exit.
- **Sizing.** Regime-adaptive 60–95% of equity: less in higher realised volatility, more in deeper
  dips. One asset and a hard stop bound the per-trade risk.

Every decision uses only bars already received and the account the harness reports; there is no
lookahead, no clock, no environment read and no randomness, so two runs on the same window produce
byte-identical action logs.

## Measured dev result (official `grade-local`, process driver)

On the published, frozen dev window (1,440 one-minute bars; cbBTC fell about 4% over it, so plain
buy-and-hold loses), the final bot scored:

| metric | value |
| --- | --- |
| net PnL after all fees, slippage and impact | **+$25.452184** (25,452,184 micro-USDC) |
| return | +2.5452% |
| trades | 4 |
| win rate | 100% |
| max drawdown | 0.9199% (guardrail ≤ 25%) |
| fees | $0.971124 |
| exposure | 9.14% |
| net PnL at 2× fees | **+$24.471674** |
| guardrails | compliant (≥ 1 trade, drawdown ≤ 25%) |
| determinism | L1 reproduced: the two runs' action logs match byte for byte |

The 2×-fee figure is the honest robustness check: the edge survives doubling every fee.

### Why not momentum

The strategy choice was made with real `grade-local` runs, not guesses. On the same dev window the
kit's baseline bots all lost money after fees:

| baseline | net PnL | trades |
| --- | --- | --- |
| momentum (24-bar, rebalanced) | −$40.924874 | 1 |
| ema-cross (8/21) | −$134.953038 | 63 |
| rsi-bollinger | −$57.365539 | 12 |
| **this bot** | **+$25.452184** | **4** |

A falling window rewards buying a confirmed rebound and staying out otherwise, not chasing the
trend or holding BTC through it.

A multi-regime variant (this dip plus a 60-bar breakout above the 120-bar SMA, gated by a realised
volatility band) was also graded: +$2.873043 net over 11 trades, 2.2148% drawdown, and −$0.035737 at
2× fees. It was worse on every measure, so the single-regime dip bot is what ships.

Command (docker is unavailable here, so the process driver is used):

```
node <kit>/cli/makefun.mjs grade-local \
  --kit <kit> --bot . --driver process --worktree \
  --save <outside-the-repo> --json
```

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — a byte-identical copy of the kit SDK shim
  (`sha256 9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry's claim file.

## Run

```sh
node main.ts < batches.ndjson
```

It reads `agent-fun/bars-replay/v1` on stdin and writes one JSON reply per batch on stdout.

Honest scope: this is a measured result on one published 24-hour dev window, not a claim about the
unseen race window or any rank. The dev result, per the competition rules, decides only whether the
entry races.