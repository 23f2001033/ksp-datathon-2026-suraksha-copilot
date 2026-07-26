# Suraksha Copilot

**A role-aware, explainable, bilingual crime-intelligence command platform for the KSP crime database.**
Built for **KSP Datathon 2026** (Karnataka State Police × Hack2skill), Challenge 1 — *Intelligent Conversational AI for the KSP Crime Database* (which subsumes Challenge 2's analytics platform). Deploys on **Zoho Catalyst**.

**One crime-intelligence brain, three command surfaces, one copilot.** SCRB holds crime data from 1,100+ stations, but the deep problem isn't "no chatbot" — it's that *one rigid data surface cannot serve three different decision-makers*. So each rank logs into a **different command center** tuned to the decision they actually make — and every surface is fronted by a natural-language copilot for the questions no dashboard anticipated.

| Rank | Decision they make | Their command center |
|---|---|---|
| **DGP / SCRB** | *Where to allocate state resources* | **State Command** — Karnataka choropleth, statewide surge alerts, district & crime-type rankings, 12-month trend |
| **SP (district)** | *Which units to push, where my hotspots are* | **District Command** — per-station performance, district hotspot map, district early-warnings |
| **IO (station)** | *What to work today on my beat* | **Station Desk** — fresh-FIR case queue, beat hotspots, case-status mix |

The copilot: an investigator asks in English or Kannada; the system answers with the exact query it ran, the evidence rows, an auto-chosen chart / real map / network graph, and a hash-chained audit trail — and it says *"I can't answer that reliably"* rather than guess.

---

## Why this design wins

Most teams will demo a GPT-wrapper chatbot that emits plausible SQL. That fails in production the moment a query is subtly wrong — and in policing, a wrong-but-confident answer is worse than no answer. The differentiators here are built around **reliability, trust, and governance**, exactly what a government evaluator needs to greenlight a pilot:

| Concern | What we do |
|---|---|
| **A static dashboard serves everyone the same page** (the actual SCRB pain) | **Role-differentiated command centers** — DGP/SP/IO each get a distinct live dashboard scoped to their authority, assembled from the same verified engine. Not a hidden filter: a genuinely different product per rank. |
| **Text-to-SQL breaks on real schemas** (GPT-4o scores ~10% on enterprise-scale text-to-SQL) | **3-tier engine**: verified templates → generative SQL with execution-consensus → honest abstention. The demo can't break because ~80% of intents are hand-verified SQL. |
| **Hallucination in a high-stakes domain** | The model **never free-generates facts** — answers are composed strictly from returned rows; every number is traceable to its query. |
| **Auditability** (cf. the Axon Draft One scandal — AI that discarded its inputs and defied audit) | **Append-only, SHA-256 hash-chained audit log** of every prompt, SQL, row count, officer, and role. Tampering breaks the chain. |
| **Access control is a legal boundary** | **RBAC with row-level security** injected into every query (DGP → state, SP → district, IO → station). |
| **Privacy / Puttaswamy & DPDP** | Person-level queries (repeat offenders) require a **logged case justification**; predictive features are place-based, not person risk-scores. |
| **Police data can't leave the premises** | **Offline mode**: with no API key, Tier-1 templates + a keyword classifier still answer common questions — the air-gapped / on-prem story, demonstrable live. |
| **Bilingual** | Kannada + English throughout (glossary, intent detection, answer language). |

---

## Architecture (Zoho Catalyst)

```
┌─ Catalyst Web Client Hosting ─────────────┐     ┌─ Catalyst Advanced I/O Function (Node) ─────────┐
│  client/  (static SPA, no build step)     │     │  functions/suraksha_api/                          │
│   • chat + role selector                  │ ──▶ │   app.js      Express API                         │
│   • tier badge + explainability panel     │ POST│   lib/queryEngine.js   3-tier orchestration       │
│   • SVG charts, hotspot map, results table│/ask │      ├─ classify (Claude structured output)       │
│   • justification gate, audit drawer      │     │      ├─ Tier 1  templates.js  (verified SQL)      │
│   • "Export case brief (PDF)"             │     │      ├─ Tier 2  claude.js  (generative + consensus)│
└───────────────────────────────────────────┘     │      └─ Tier 3  abstain                            │
                                                   │   lib/guardrails.js  SELECT-only + RLS injection  │
                                                   │   lib/rbac.js        roles → scope predicate      │
                                                   │   lib/audit.js       hash-chained log             │
                                                   │   lib/db.js          sql.js (WASM SQLite)         │
                                                   │   data/crime.db      bundled read-only dataset    │
                                                   └───────────────────────────────────────────────────┘
                                                        │ Anthropic Node SDK (claude-opus-4-8)
                                                        ▼  ANTHROPIC_API_KEY (Catalyst env var)
```

**Data layer:** the prototype ships a synthetic-but-realistic Karnataka crime database (3,200 FIRs, 1,400 accused, 50 stations, 10 districts) as a read-only `crime.db` opened with **sql.js** — pure WebAssembly, so there is *no native module to compile* and the same code runs locally and on Catalyst. The schema is **aligned to real KSP/CCTNS FIR fields** (district, unit/station, crime type & head, victim age/gender/profession, area profile, occurrence hour, accused profession), and the socio-demographic values are deliberately correlated (cybercrime hits IT professionals in IT-corridor areas; chain-snatching targets homemakers/seniors in commercial areas at dusk) so the analytics tell a real story. The data-access layer is behind one interface (`lib/db.js`); point it at Catalyst Data Store / ZCQL or live CCTNS and nothing else changes.

**Command dashboards** (`lib/overview.js`, `GET /overview`): each rank's dashboard is assembled by running the *same verified templates* the copilot uses, scope-injected via the caller's RBAC predicate — so a dashboard can never show data the officer couldn't get by asking, and an SP's "stations under command" only ever includes their own district's stations.

**Offline map** (`client/karnataka-districts.geojson`, 46 KB): a real 27-district Karnataka boundary set (simplified from public GADM data), bundled so the choropleth works fully **air-gapped** — no external tile servers, preserving the on-prem pitch.

---

## The 3-tier reliability engine

1. **Tier 1 — Verified templates** (`lib/templates.js`). The LLM only classifies intent and fills slots; the SQL is hand-written and reviewed. Deterministic and provably correct. Covers hotspots, trends, top crime types, status breakdown, district comparison, repeat offenders, case lookup, counts, **socio-demographic** (`victim_profile`), **socio-economic** (`socioeconomic_correlation`), **temporal** (`temporal_pattern`), **supervisory** (`station_breakdown`), **operational** (`recent_firs`), area drill-down (`area_cases`) — plus three **service templates** that run scoped analytics: `offender_network` (co-accusation link analysis), `early_warnings` (anomaly detection), `duplicate_records` (entity resolution). Badge: **✅ Verified query**.
2. **Tier 2 — Generative SQL** (`lib/claude.js`). When no template fits, the LLM writes SQL against a **curated semantic layer** (not the raw catalog). N candidates are generated, each guardrailed and executed, and the **majority result** wins (execution self-consistency), with one self-repair retry on error. Badge: **⚠️ AI-generated — review SQL before citing**.
3. **Tier 3 — Honest abstention.** Low confidence or repeated failure → the assistant declines and suggests answerable questions instead of guessing. Badge: **⛔ Abstained**.

Every path is **scope-injected** (RBAC), **guardrailed** (SELECT-only, allow-listed tables, forced LIMIT), and **audited**.

---

## Repository layout

```
suraksha-copilot/
├── catalyst.json                     # Catalyst project config
├── package.json                      # root scripts: seed, dev, smoke
├── .env.example                      # ANTHROPIC_API_KEY, SURAKSHA_MODEL, ...
├── functions/suraksha_api/           # Catalyst Advanced I/O (Node) function
│   ├── catalyst-config.json
│   ├── index.js                      # Catalyst entrypoint (exports Express app)
│   ├── server.js                     # local dev server (also serves the client)
│   ├── app.js                        # Express routes
│   ├── lib/                          # engine, semantic layer, guardrails, rbac, audit, claude, db, heuristic
│   └── data/crime.db                 # generated by `npm run seed`
├── client/                           # Catalyst Web Client Hosting (static SPA)
│   ├── index.html · styles.css · app.js
│   └── client-package.json
└── scripts/
    ├── seed.js                       # builds crime.db (deterministic)
    └── smoke.js                      # end-to-end offline test
```

---

## Quick start (local)

Requires Node 18+.

```bash
# 1. install backend deps
cd functions/suraksha_api && npm install && cd ../..

# 2. generate the synthetic crime database
node scripts/seed.js

# 3. (optional) enable the LLM — copy .env.example to .env and add your key
cp .env.example .env        # then set ANTHROPIC_API_KEY=sk-ant-...

# 4. run the app (serves API + web client on one port)
node functions/suraksha_api/server.js
# open http://localhost:3000
```

**Offline mode:** with no `ANTHROPIC_API_KEY`, the app runs on the keyword classifier + Tier-1 templates only — fully functional for common questions, and the on-prem/air-gapped demo.

**Smoke test** (offline, deterministic — exercises all 3 tiers, RBAC scope injection, the justification gate, and audit-chain integrity):

```bash
node scripts/smoke.js
```

## Measured accuracy (the number most teams can't show)

`npm run eval` runs a 39-case bilingual suite (English + Kannada, including socio-demographic queries and multi-turn follow-ups) and writes [eval/REPORT.md](eval/REPORT.md). Two metrics:

- **Routing accuracy** — did the engine pick the correct verified template, correctly demand a justification for person-level queries, or correctly refuse out-of-scope / destructive questions ("Delete all closed cases…" must abstain)?
- **Execution accuracy** — do the returned rows match, byte-for-byte, independently hand-written ground-truth SQL (including RBAC scope)?

Current results, **offline engine** (no LLM at all):

| Metric | English | Kannada | Overall |
|---|---|---|---|
| Routing accuracy | 100% (32/32) | 100% (7/7) | **100% (39/39)** |
| Execution accuracy vs ground-truth SQL | 100% | 100% | **100%** |

Honest caveats: the suite is in-distribution phrasing written alongside the templates — it demonstrates that *answers the system gives are correct by construction* (Tier-1 SQL is hand-verified; the failure mode is routing), not that arbitrary phrasing always routes. `npm run eval:llm` re-runs the identical suite through the Claude classifier for a like-for-like engine comparison; growing the suite with adversarial phrasings is the intended next step. The harness caught three real bugs during development (glossary key shadowing "vehicle theft"→"theft", a one-row status "breakdown", and destructive requests routing to a read query) — which is the point of having it.

### Try these

- **Switch the officer dropdown** (DGP → SP → IO) → the whole command center changes: state map vs. district station-performance vs. station case-queue
- On the DGP dashboard, **click a district** on the Karnataka map → drills to that district's area hotspots → click a bubble → the individual FIRs
- *Who are the typical victims of chain snatching?* → socio-demographic profile · *Which areas see cybercrime — residential or commercial?* → socio-economic correlation · *What time do chain snatchings happen?* → temporal pattern
- *Where are the chain snatching hotspots in Bengaluru over the last 6 months?* → Tier 1, hotspot map — **click any marker** to drill into the individual FIRs at that locality (the top 8 markers are labeled directly; every marker is clickable/keyboard-activatable regardless)
- …then *"And what about Mysuru?"* → follow-up inherits the crime type & window, swaps the district
- …then *"Which repeat offenders operate there?"* → "there" resolves to the previous district (after the justification gate)
- *Trend of vehicle theft in Bengaluru over the last year* → Tier 1, line chart
- *Which district has the most cybercrime?* → Tier 1, bar chart
- *Any early warnings for Bengaluru?* → anomaly cards (Spike / Elevated / Normal with z-scores)
- *Show the network of Basavaraju Sab* → **justification gate**, then a 2-hop co-accusation graph
- *Show probable duplicate records in Bengaluru* → transliteration-duplicate clusters with confidence
- *Show repeat offenders in Bengaluru* → **justification gate**, then a table
- Switch the officer to **SP Mysuru** and repeat a Bengaluru query → row-level security blocks it
- *What is the meaning of life?* → **Tier 3 abstention**
- Tap 🎤 (toggle EN/ಕನ್ನಡ) and speak the question — Chrome/Edge
- Open **Audit log** (top right) → verify the hash chain

---

## Deploy to Zoho Catalyst

```bash
npm install -g zcatalyst-cli
catalyst login
```

1. Create a project in the [Catalyst console](https://catalyst.zoho.com), then link it: run `catalyst init` in the repo root (select **Functions** + **Client**, and the existing `suraksha_api` / `client` directories), or set `project_id` in `catalyst.json`.
2. **Seed before deploying** so `functions/suraksha_api/data/crime.db` is bundled: `node scripts/seed.js`.
3. Set **Environment Variables** in the console (Settings → Environment Variables): `ANTHROPIC_API_KEY`, and optionally `SURAKSHA_MODEL`, `SURAKSHA_CONSENSUS_N`.
4. Deploy:
   ```bash
   catalyst deploy
   ```
   The function is served at `https://<project>.<env>.catalystserverless.com/server/suraksha_api/...` and the web client at the app domain — same origin, so the client's API base (`/server/suraksha_api`) works without configuration.

> **Production note:** the demo audit sink writes JSONL to `/tmp` (ephemeral on serverless). For durable audit, swap the sink in `lib/audit.js` → `writeEntry()` for a Catalyst **Data Store** table insert (schema: `ts, prev_hash, hash, user_id, role, tier, executed_sql, row_count, justification`). The hash-chaining logic is unchanged.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Service + model + LLM status |
| `GET` | `/meta` | Crime types, districts, statuses, roles, sample questions |
| `GET` | `/users` | Demo officer directory (role + scope) |
| `GET` | `/overview?userId=` | Role-differentiated command dashboard bundle (KPIs + panels), scope-injected + audited |
| `POST` | `/ask` | `{ question, userId, justification?, history?, template?, slots? }` → tiered, audited answer |
| `GET` | `/audit/recent?limit=` | Recent audit entries |
| `GET` | `/audit/verify` | Verify the hash chain is intact |

---

## Mapping to Challenge 1 requirements

| Brief requirement | Status |
|---|---|
| Interactive dashboards & role-based access | ✅ three role-differentiated command centers (DGP/SP/IO), each scoped by RBAC row-level security; KPI tiles + panel grid load on login |
| Geospatial maps & district drilldowns | ✅ bundled-offline Karnataka choropleth (27 real districts) → click a district → area-bubble hotspots → individual case list |
| Socio-demographic insights | ✅ victim-profile analytics (occupation × age band per crime type) |
| Socio-economic crime correlation | ✅ crime distribution by area character (Residential/Commercial/IT Corridor/…), plus time-of-day patterns |
| Natural-language chatbot (English + Kannada) | ✅ implemented (glossary + language detection + answer language) |
| Context-aware conversations | ✅ multi-turn follow-ups ("And what about Mysuru?", "Which repeat offenders operate there?") — the client echoes recent turns; both engines resolve references (LLM natively, offline via slot inheritance). Context is per-officer and cleared on role switch. |
| Crime trend & hotspot detection | ✅ Tier-1 templates (line chart + SVG hotspot map, clickable markers drill into the individual FIRs behind each one) |
| Criminal network visualization | ✅ co-accusation link analysis, 2-hop radial graph, edge weight = shared FIRs, phonetic seed matching, justification-gated |
| Repeat-offender analysis | ✅ repeat-offender template (justification-gated) |
| Predictive analytics & early warnings | ✅ z-score anomaly cards vs 12-month baseline + trend slope — place/time-based, fully explainable, no person risk scores |
| Explainable AI with audit trails | ✅ SQL shown + hash-chained audit + verify endpoint |
| Role-based secure access | ✅ RBAC with row-level security injected into every query |
| PDF export of conversation history | ✅ per-answer court-brief export (browser print → PDF) |
| Voice-enabled interaction | ✅ Web Speech API mic button with English/ಕನ್ನಡ toggle (Chrome/Edge); AI4Bharat IndicConformer / Sarvam STT is the production upgrade path |

### Entity resolution (data-quality layer)

CCTNS-class data has **no unique person identifier** and names vary by transliteration (Shivakumar / Sivakumar / Shiva Kumar). `lib/entityResolution.js` implements an Indic-tuned pipeline: phonetic blocking (aspirate collapse th→t/bh→b…, long-vowel collapse aa→a/ee→i, sh→s, v↔w) → normalized-Levenshtein scoring boosted by shared district/station → **suggest-only clusters with confidence**. Ask *"Show probable duplicate records in Bengaluru"*. Merges are never automatic — a wrong auto-merge in a police database is a civil-liberties incident; here a human confirms, and that confirmation is auditable.

The same phonetic key powers the network seed lookup, so *"network of Sivakumar"* also finds *Shivakumar*.

**Next increments:** Catalyst Data Store audit adapter, IndicConformer/Sarvam STT for production-grade Kannada ASR, adversarial expansion of the eval suite.

---

## Notes

- **Model.** Defaults to `claude-opus-4-8` (highest reliability for the text-to-SQL path). Set `SURAKSHA_MODEL=claude-sonnet-5` to cut cost per query. The model is used only for intent classification, Tier-2 SQL, and grounded answer composition — never to invent facts.
- **Data.** Entirely synthetic and generated deterministically (`scripts/seed.js`); no real personal data. Schema-aligned to real KSP/CCTNS FIR fields; socio-demographic values are correlated but invented. Accused names deliberately include transliteration variants to motivate the entity-resolution feature.
- **Map.** Boundaries are real Karnataka district polygons (simplified from public GADM data), bundled offline; production drops in KSP's own shapefiles. Names mapped from GADM's older spellings.
- **Socio-demographic analytics** are strictly **aggregate cohort** (occupation group, age band, area type) — never per-individual profiling (Puttaswamy/DPDP posture).
- **Judging-criteria alignment** is *inferred* from the 2024 edition + hack2skill norms; no 2026 rubric is published.
- **Positioning.** Decision *support*, never decision-*making*. No autonomous actions; no assertions about individuals without a logged case context.
