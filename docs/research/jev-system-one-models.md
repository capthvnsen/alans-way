# Jev and "System One" decision models

Research date: 2026-10-06. Sources are primary where possible: typesafe.ai and docs.typesafe.ai, github.com/typesafe-ai, partner docs (Vercel, OpenRouter, Cloudflare, DigitalOcean), and the upstream GitHub/Hugging Face repos themselves. Where a claim is vendor-reported or community-reported it is marked as such. Nothing was installed, purchased, or run against the paid API; this is a source review.

## What Jev is

**Jev** is TypeSafe AI's first "System One" model — a proprietary, hosted decision model released 2026-09-15 alongside a $40M DCVC-led seed round (CEO Diogo Almeida, an RLHF/InstructGPT co-inventor). It is deliberately *not* an LLM: you send a `state` (string, JSON, or array) plus a set of typed questions, and it returns typed answers with calibrated probabilities — a `choice` over up to 255 labeled options, a `score` over 2–10 ordered levels, or a `noul` (Bernoulli yes/no, returned as P(yes)). All questions in a request are evaluated in a single parallel pass; question IDs are never sent to the model. Reported latency is ~70–500 ms end-to-end. [typesafe.ai](https://typesafe.ai/), [introducing Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [API shape](https://docs.typesafe.ai/llms-full.txt), [Vercel model page](https://vercel.com/ai-gateway/models/jev)

Key economics: **$0.042 per 1M input tokens, output tokens free** — confirmed identically on TypeSafe's site, Vercel, Cloudflare, and DigitalOcean. Context is a dual budget: 64k tokens for state + all questions combined, 32k for state + the single longest question. [Cloudflare model page](https://developers.cloudflare.com/ai/models/typesafe/jev/), [Pydantic AI docs](https://pydantic.dev/docs/ai/models/typesafe/)

The training method is called **RLCD — Reinforcement Learning for Calibrated Decisions**. Important caveat: there is no published paper, reward function, or calibration curves; RLCD is a name, not a disclosed method. Likewise `confidence` (on choice/score answers) is *distribution peakedness*, not "probability this answer is correct" — probabilities carry the calibration claim, and only as a population property. [blog post](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [confidence docs via Spring AI](https://spring-ai-community.github.io/spring-ai-typesafe/latest/concepts/confidence/)

Access: direct API (`api.typesafe.ai/v1/systemone`, `TYPESAFE_API_KEY`), Vercel AI Gateway, OpenRouter (`typesafe/jev-1.13`), Cloudflare Workers AI, DigitalOcean, plus official Python/JS SDKs and an official MIT-licensed skill (`typesafe-ai/skills`). There is **no official `jev-mcp`**; community MCP servers exist (jkudish, tphakala, others — pick deliberately).

**Clone ecosystem warning.** A large cluster of unofficial lookalike sites exists (jevtypesafeai.com — a 10×-markup key reseller run by "CODEFASHION TECH LTD" — thejevai.com, jevai.org, typesafeai.app, a fake `TypeSafeAI` GitHub org, a `typesafe-ai` PyPI shim, and fake "Jev weights" downloads). The official surface is typesafe.ai, the named gateways, and github.com/typesafe-ai only. [TrustList investigation](https://trustlist.uk/blog/jev-typesafe-decision-model-what-is-proven-and-lookalike-sites)

## Open-source / local versions

All verified to exist; none is the real Jev — they are API-compatible reconstructions, which matters for calibration (see caveats).

| Model/server | Base | Size | Runs on this Mac? | License |
|---|---|---|---|---|
| [razorback16/openjev](https://github.com/razorback16/openjev) | DiffusionGemma 26B-A4B (block-diffusion) | 26B total / 4B active | **Yes — MLX backend**, ~16 GB free to load 4-bit weights (comfortable on 24 GB+); one read at a time, ~0.39 s per 3-question request on M4 Max | Apache-2.0 |
| [Laya](https://github.com/NandhaKishorM/laya) (Convai Innovations) | ModernBERT-large + decision head | 421M | **Yes, trivially — CPU**, ~1–2 GB, ~33 ms/question | Apache-2.0 |
| [Verdict](https://huggingface.co/heman10x/rlcd-modernbert-151m) | ModernBERT-base + GLiClass head | 151M | **Yes — CPU/ONNX/WebGPU**, <1 GB | Apache-2.0 |
| [JevK5](https://huggingface.co/alibiserikbay/JevK5) | Qwen3.5-4B + distilled LoRA | ~9 GB bf16 | **Yes — GGUF via llama.cpp/Ollama**, ~4–6 GB | Apache-2.0 |
| [Jev-Omni](https://huggingface.co/akhilaaa3/Jev-Omni) | Gemma-4-12B fine-tune, multimodal | ~24 GB bf16 | No — CUDA only | Apache-2.0 |

How OpenJev reproduces the contract: DiffusionGemma denoises a full token canvas per pass; OpenJev writes the answer template onto the canvas with only answer-token slots masked, then **reads the per-slot probability distribution in one read-only step** — the distribution *is* the answer, so it can't go off-schema. Uncertain slots (entropy > 0.1) trigger up to 3 re-reads with fresh noise, averaged. Built on [vLLM PR #57250](https://github.com/vllm-project/vllm/pull/57250) (merged 2026-09-22). Extensions beyond the official API: `images` (≤8), `steps`, `samples`, `think` (a bounded pre-answer thought). Serves `openjev-0.1`, `laya-1.0`, `verdict-1.4`, `clm-v0.1`, `jevk5-0.2` behind the same `/v1/systemone` wire API, and accepts the `jev-latest` alias so TypeSafe SDKs work unchanged. Free hosted sibling: [Codiv](https://codiv.ai/) (100M free input tokens, unofficial). [OpenJev README](https://github.com/razorback16/openjev)

## Agent integration patterns (verified repos)

- **[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)** (MIT, ~22k★): the "computer use" showcase. Per step it snapshots the DOM into a numbered, indexed action table (≤250 controls), then makes **one Jev call** carrying the `operation` choice *plus speculative per-operation target questions* (`click_target`, `type_text_target`, `select_target`) — multiple decisions in one round trip. Jev can only return an index you offered, so it cannot hallucinate selectors; a small LLM is invoked only for `TYPE_TEXT`. Author-reported: Zürich→London Google Flights search in **7.07 s**, 17 Jev calls, ~**$0.0039/task**; one independent replication saw repeated misclicks, so treat demo numbers cautiously. [performance.md](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md)
- **[0x7067/jev-browse](https://github.com/0x7067/jev-browse)** (MIT): same observe→choose→act loop, packaged as plugins for Pi/Claude Code/Codex/OpenCode/MCP.
- **[thinkany-ai/autojev](https://github.com/thinkany-ai/autojev)** (AGPL-3.0): a localhost gateway that sits in front of your agents' model endpoint. Local rules filter candidates → Jev picks the model on cost/quality/balanced routes → falls back to local weighted routing on failure. Sends only routing metadata (token estimate, complexity score, candidate list) — never conversation content.
- **[kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)** (MIT): the most relevant repo — built **for Hermes**. Eleven agent-agnostic `SKILL.md` skills + a Hermes plugin using only public plugin seams (`pre_llm_call`, `transform_tool_result`, tools, slash command). Adds `jev_memory_filter`, `jev_compact_select`, `jev_choose_action`, `jev_supervise`, `jev_escalate` tools; per-turn model routing (`/jev routing shadow|on`), skill selection, transcript compaction, mailbox triage, **web_search/web_extract screening for injected instructions**, search-result selection, and computer/browser use where Jev picks the next action from an already-safety-judged candidate table (~0.4–0.5 s/decision, ~$0.00002–0.00006 per triage decision). Notably, Nous Research's hermes-agent shipped a bundled `typesafe-jev-skill-routing` cookbook. [repo](https://github.com/kerpopule/hermes-jev-skills), [Hermes cookbook issue](https://github.com/NousResearch/hermes-agent/issues/114377)

## The "agent activity → cheaper system" answer

Yes — this is the designed use of the model class, and there are four concrete mechanisms:

1. **Speculative fan-out (official pattern).** Put the entire decision tree's questions in one request — including branch-speculative ones you may not use. All questions evaluate in parallel in one pass and the state is billed once per request. Official cookbook result: 13 questions over one state were 12.2× cheaper and 10× faster batched vs. sequential, identical answers. [docs.typesafe.ai](https://docs.typesafe.ai/llms.txt)
2. **Confidence as the automation gate.** Every answer carries a probability/peakedness signal, so code decides when to act autonomously vs. escalate to the LLM or a human. This is the core cost lever: spend frontier-LLM tokens only where the cheap model is unsure. hermes-jev-skills' `jev_supervise`/`jev_escalate`, autojev's `autojev_guard_tool_call` (allow/confirm/review/deny), and `anpicasso/hermes-jev-approvals` (verdict + policy + blast-radius questions in one parallel call → APPROVE/DENY/ESCALATE) are working examples.
3. **Shadow mode + replay on your own activity.** `/jev routing shadow` decides and logs without acting; `jev batch` backtests candidate policies against your recorded session history and prints PASS/FAIL; `tenbin` batch-scores questions on labeled data. This is the "use the agent's activity" loop: the agent's real traffic becomes the tuning corpus, so thresholds are fit to *your* workload before anything goes live. [shadow-to-live.md](https://github.com/kerpopule/hermes-jev-skills/blob/main/docs/shadow-to-live.md), [tenbin](https://github.com/simota/tenbin)
4. **Distilling your own decisions into a local model.** [jaredpalmer/kev](https://github.com/jaredpalmer/kev) extracts a workload from a repo's existing Jev call sites, trains a ~4B calibrated model (~$1/run on Modal), and serves a `/v1/systemone`-compatible endpoint; Laya ships a full public fine-tune loop (dataset → RL via strictly proper scoring rules → temperature calibration → export) that runs on Apple Silicon. **Caveat: TypeSafe's MCA §2.3(b) prohibits training on Jev's outputs** — the legal path is your own labels (shadow logs + human review outcomes are yours to label). [typesafe.ai/legal/mca](https://typesafe.ai/legal/mca)

The honest cost model: cheap per decision, not free per step. jev-ultrafast re-sent the whole element table every step and Jev was ~98% of its model bill (~$0.0039/task — still ~450× cheaper than an LLM policy per TypeSafe's framing). State size × steps is the knob; keep states small and structured.

## Fit with Alan's Way

The project's hard problems are already decision-shaped, which makes this unusually well-matched:

- **Host-vs-VPS handoff.** Today "new browser work routes to the VPS when your computer is unreachable" is a reachability rule. A `choice`/`noul` per task — "can this task run on VPS only?" / "does it need host-local state?" — is exactly the contract, with confidence gating the risky cases to the user. `HANDOFF_JEV=1` in hermes-jev-skills already does this for compaction-on-handoff.
- **Proactivity approval gate.** The plugin's bounded-budget "review and draft suggestions" plus "consequential actions always require approval" is a textbook noul/score policy: score the draft's consequence class, auto-approve below threshold, escalate above. The approvals pattern in `anpicasso/hermes-jev-approvals` maps directly onto our permission model.
- **Computer use in shared tabs.** We already drive per-tab Chromium via CDP, which yields a DOM/accessibility tree — the same indexed-action-space input jev-ultrafast/jev-browse use, and the *safe* version: no screenshots or page text leave the machine, only goal + short element labels (hermes-jev-skills' stated privacy boundary).
- **Supervision across the fleet.** `jev_supervise`-style "watch a delegated run, interrupt only when a decision is needed" matches the take-over/inspect model of the app.

Privacy boundary is preserved by construction in the good integrations: the decision layer sees *features* (element labels, action descriptions, coarse flags), not content (page text, field values, screenshots) — and can be pointed at a local OpenJev/Laya for the profiles in `private_profiles` where nothing may leave the machine at all.

## Caveats before trusting it

- **OpenJev ≠ Jev.** It's a community reconstruction on DiffusionGemma with no RLCD calibration — its README itself says validate thresholds on your own labeled data (community JevBench ranks it #27 vs Jev ~#3). Same caution for Laya (docs admit shipped checkpoints are over-confident until you fit temperatures on held-out data) and JevK5 (self-reported ~89.9 vs 90.6).
- **`confidence` ≠ accuracy** and probabilities are calibrated in aggregate — pin `jev-1.13.0`, not `jev-latest`, before fitting thresholds, and expect distribution shift on your domain.
- **Anti-distillation clause** — never train on Jev's outputs; use kev/Laya on your own labels.
- **Vendor claims unverified**: "193.6× faster, 444.6× cheaper", "zero hallucinations" (true only in the trivial sense that output is constrained to your declared options), RLCD internals.
- **The clone cluster is dangerous**: only typesafe.ai + named gateways + github.com/typesafe-ai are real. Never buy `jv_live_` keys.

## Bottom line

The best use case is real and it is the one guessed in the question: **a fast, calibrated decision layer inside the agent loop** — routing, gating, supervision, compaction, and next-action selection — while the LLM handles generation and hard reasoning. For this project specifically, the highest-value pilots are (1) proactivity/consequence gating and (2) host-vs-VPS task routing, both measurable in shadow mode at near-zero cost before going live. For fully-local operation, Laya/Verdict (CPU, <2 GB) or OpenJev-MLX (~16 GB, M4-class) cover it; for maximum accuracy, the hosted Jev at $0.042/M tokens with fan-out batching is effectively free for the decision volumes a companion app produces.
