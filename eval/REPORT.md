# Suraksha Copilot — Evaluation Report

Engine: **offline heuristic** · 2026-07-16 · 39 cases (32 English, 7 Kannada)

| Metric | English | Kannada | Overall |
|---|---|---|---|
| Routing accuracy (intent / gate / abstain) | 100% (32/32) | 100% (7/7) | 100% (39/39) |
| Execution accuracy vs ground-truth SQL | 100% (26/26) | 100% (7/7) | 100% (33/33) |

**How to read this:** routing accuracy is whether the engine picked the right
verified template, correctly demanded a justification for person-level queries,
or correctly refused out-of-scope/unsafe questions. Execution accuracy compares
the returned rows byte-for-byte against independently hand-written ground-truth
SQL (including RBAC scope). Answers the system does give are never wrong at the
data level by construction — Tier 1 SQL is hand-verified; the failure mode is
routing, which is what this suite measures.

## Failures
- none
