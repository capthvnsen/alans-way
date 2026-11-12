# Chat surfaces after the polish pass

Same harness, machine and local Hermes lab as `../2026-11-11-chat-surfaces/`. Run on branch `agent/w1-polish`. Median / p95 in ms. Raw numbers are in `results.json`.

| Metric | Native before | Native after | Hermes Desktop before | Hermes Desktop after |
|---|---|---|---|---|
| Cold open (n=10) | 479 / 519 | 539 / 568 | 907 / 960 | 1,031 / 1,105 |
| Thread switch (n=20) | 6.8 / 14.2 | 9.2 / 12.6 | 61.3 / 102.3 | 79.6 / 155.6 |
| First token (n=10) | 141.7 / 153.6 | 139.3 / 160.7 | 321.3 / 357.2 | 386.1 / 434.7 |
| 1k scroll, p95 frame (n=5) | 9.9 | 10.5 | 19.6 | 25.3 |
| 1k scroll, frames over 16.7 ms | 0.2% | 0% | 23.9% | 48.6% |
| 1k scroll, worst frame | 18.3 | 11.2 | 33 | 33 |

Native is still the fastest surface on every metric.

Both surfaces got slower by a similar share on cold open (native +13%, Hermes Desktop +14%). The machine was busier for this run: load average about 9, against 5 to 8 for the first run. This run cannot tell how much of native's 60 ms is machine load and how much is the polish changes. Re-run on an idle machine before reading it as a regression.

Telegram was measured only to its sign-in screen (7,230 / 7,655 ms), as before. The first-token floor with `curl` was 145.4 / 203.7 ms.
