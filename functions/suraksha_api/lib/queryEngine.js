'use strict';

const { TEMPLATES, catalog } = require('./templates');
const { schemaPrompt } = require('./semanticLayer');
const guardrails = require('./guardrails');
const claude = require('./claude');
const heuristic = require('./heuristic');
const { scopePredicate } = require('./rbac');
const db = require('./db');
const audit = require('./audit');

/**
 * The 3-tier reliable query engine.
 *
 *   Tier 1  Verified templates  — LLM fills slots, SQL is hand-written. Always
 *                                 correct. ~80% of real investigator intents.
 *   Tier 2  Generative SQL      — LLM writes SQL against the semantic layer;
 *                                 N candidates are executed and the majority
 *                                 result wins (execution self-consistency).
 *   Tier 3  Honest abstention   — low confidence or repeated failure. The
 *                                 assistant says "I can't answer that reliably"
 *                                 instead of guessing. Trust over coverage.
 *
 * Every path is scope-injected (RBAC), guardrailed, and audited.
 */

const ABSTAIN_THRESHOLD = 0.4;
const CONSENSUS_N = Math.max(1, parseInt(process.env.SURAKSHA_CONSENSUS_N || '3', 10));

const TIER_BADGES = {
  1: { tier: 1, badge: 'Verified query', tone: 'verified' },
  2: { tier: 2, badge: 'AI-generated — review SQL before citing', tone: 'generative' },
  3: { tier: 3, badge: 'Abstained', tone: 'abstain' },
};

function signature(rows) {
  return JSON.stringify(rows);
}

function suggestions() {
  return [
    'Where are the chain snatching hotspots in Bengaluru over the last 6 months?',
    'Trend of vehicle theft in Bengaluru over the last year',
    'Which district has the most cybercrime?',
    'How many cases are still under investigation in Mysuru?',
  ];
}

async function classify(question, history) {
  if (claude.hasLLM()) {
    try {
      const result = await claude.classifyIntent(question, catalog(), history);
      if (result && result.decision) return { ...result, engine: 'llm' };
    } catch (err) {
      console.error('[engine] LLM classify failed, falling back to heuristic:', err.message);
    }
  }
  return { ...heuristic.classify(question, history), engine: 'heuristic' };
}

async function runTier1(templateId, slots, ctx) {
  const template = TEMPLATES[templateId];

  // Governance gate: person-level queries require a logged justification.
  if (template.requiresJustification && !ctx.justification) {
    return {
      ok: true,
      needs_justification: true,
      ...TIER_BADGES[1],
      engine: ctx.engine,
      decision: templateId,
      confidence: ctx.confidence,
      language: ctx.language,
      message:
        'This is a person-level query. Enter the case ID or investigative reason to proceed — the justification is recorded in the audit log.',
      slots: ctx.slots,
      scope: ctx.scope,
    };
  }

  // Service templates (network / forecast / entity resolution) run their own
  // scoped, guardrailed queries and return a finished result payload.
  if (template.run) {
    const out = await template.run(slots, ctx);
    if (!out) {
      return abstain(ctx, 'The question matched a template but a required detail was missing (e.g. a person\'s name).');
    }
    return finalize(ctx, {
      tier: 1,
      templateSql: out.executedSql,
      executedSql: out.executedSql,
      title: out.title,
      viz: out.viz,
      columns: out.columns,
      rows: out.rows,
      network: out.network || null,
    });
  }

  const built = template.build(slots);
  if (!built) {
    return abstain(ctx, 'The question matched a template but a required detail was missing.');
  }

  const safeSql = guardrails.enforce(built.sql, { scopePredicate: ctx.scopePredicate });
  const { columns, rows } = await db.query(safeSql);

  return finalize(ctx, {
    tier: 1,
    templateSql: built.sql,
    executedSql: safeSql,
    title: built.title,
    viz: built.viz,
    columns,
    rows,
  });
}

async function runTier2(question, ctx) {
  if (!claude.hasLLM()) {
    return abstain(ctx, 'This needs a custom query, which is unavailable in offline mode.');
  }

  const results = [];
  let lastError = null;

  for (let i = 0; i < CONSENSUS_N; i++) {
    let raw;
    try {
      raw = await claude.generateSqlCandidate(question, i === 0 ? null : lastError);
    } catch (err) {
      lastError = `generation error: ${err.message}`;
      continue;
    }
    try {
      const safeSql = guardrails.enforce(raw, { scopePredicate: ctx.scopePredicate });
      const { columns, rows } = await db.query(safeSql);
      results.push({ rawSql: raw, executedSql: safeSql, columns, rows, sig: signature(rows) });
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!results.length) {
    return abstain(ctx, 'I could not construct a reliable query for this. ' + (lastError ? `(${lastError})` : ''));
  }

  // Execution consensus: pick the result whose row-set the most candidates agree on.
  const counts = new Map();
  for (const r of results) counts.set(r.sig, (counts.get(r.sig) || 0) + 1);
  let bestSig = null;
  let bestCount = 0;
  for (const [sig, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestSig = sig;
    }
  }
  const chosen = results.find((r) => r.sig === bestSig);

  return finalize(ctx, {
    tier: 2,
    templateSql: chosen.rawSql,
    executedSql: chosen.executedSql,
    title: 'AI-generated analysis',
    viz: chosen.columns.length <= 3 ? 'table' : 'table',
    columns: chosen.columns,
    rows: chosen.rows,
    consensus: { candidates: results.length, agreed: bestCount, distinct: counts.size },
  });
}

function abstain(ctx, message) {
  const record = audit.record({
    user_id: ctx.user.id,
    role: ctx.user.role,
    question: ctx.question,
    tier: 3,
    decision: 'abstain',
    engine: ctx.engine,
    executed_sql: null,
    row_count: 0,
  });
  return {
    ok: true,
    ...TIER_BADGES[3],
    engine: ctx.engine,
    decision: 'abstain',
    confidence: ctx.confidence,
    language: ctx.language,
    answer: message,
    reason: ctx.reason,
    suggestions: suggestions(),
    slots: ctx.slots,
    scope: ctx.scope,
    audit: record,
  };
}

async function finalize(ctx, r) {
  let answerText;
  if (claude.hasLLM()) {
    try {
      answerText = await claude.composeAnswer({
        question: ctx.question,
        title: r.title,
        rows: r.rows,
        language: ctx.language,
      });
    } catch (err) {
      console.error('[engine] answer composition failed, using template answer:', err.message);
    }
  }
  if (!answerText) answerText = heuristic.answer({ title: r.title, rows: r.rows, viz: r.viz });

  const record = audit.record({
    user_id: ctx.user.id,
    role: ctx.user.role,
    question: ctx.question,
    justification: ctx.justification || null,
    tier: r.tier,
    decision: ctx.decision,
    engine: ctx.engine,
    executed_sql: r.executedSql,
    row_count: r.rows.length,
    history_len: ctx.historyLen || 0,
  });

  return {
    ok: true,
    ...TIER_BADGES[r.tier],
    engine: ctx.engine,
    decision: ctx.decision,
    confidence: ctx.confidence,
    language: ctx.language,
    title: r.title,
    answer: answerText,
    reason: ctx.reason,
    generatedSql: r.templateSql,
    executedSql: r.executedSql,
    columns: r.columns,
    rows: r.rows,
    viz: r.viz,
    network: r.network || null,
    consensus: r.consensus || null,
    slots: ctx.slots,
    scope: ctx.scope,
    audit: record,
  };
}

/**
 * Answer one investigator question end-to-end.
 * @param {object} args
 * @param {string} args.question
 * @param {object} args.user  resolved RBAC user
 * @param {string} [args.justification]  case ID / reason for person-level queries
 */
/**
 * Sanitize a client-supplied slots object to plain string/number values only —
 * used by direct template invocation (see below) so nothing but scalars can
 * ever reach SQL string interpolation via this path.
 */
function sanitizeSlots(slots) {
  const out = {};
  if (!slots || typeof slots !== 'object') return out;
  for (const [k, v] of Object.entries(slots)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

async function answerQuestion({ question, user, justification, history, template, slots }) {
  // Direct template invocation: the UI already knows exactly which verified
  // query it wants (e.g. clicking a hotspot marker to drill into that area) and
  // skips the free-text classifier. This does NOT skip anything security-
  // relevant — guardrails, RBAC row-level scoping, and the person-level
  // justification gate all still run inside runTier1/finalize exactly as they
  // do for a classified question.
  const cls =
    template && TEMPLATES[template]
      ? {
          decision: template,
          confidence: 1,
          language: 'en',
          reason: 'Directly selected (e.g. a map marker), not classified from free text.',
          slots: sanitizeSlots(slots),
          engine: 'direct',
        }
      : await classify(question, history);
  const ctx = {
    question,
    user,
    justification,
    scopePredicate: scopePredicate(user),
    engine: cls.engine,
    decision: cls.decision,
    confidence: cls.confidence,
    language: cls.language || 'en',
    reason: cls.reason,
    slots: cls.slots || {},
    historyLen: Array.isArray(history) ? history.length : 0,
    scope: { role: user.role, district: user.district, station_id: user.station_id },
  };

  if (cls.confidence != null && cls.confidence < ABSTAIN_THRESHOLD) {
    return abstain(ctx, "I can't answer that reliably. Could you rephrase, or try one of the suggested questions?");
  }

  if (cls.decision === 'abstain') {
    return abstain(ctx, "I can't answer that reliably — it's ambiguous or needs data I don't have. Try rephrasing.");
  }

  if (cls.decision === 'generative') {
    return runTier2(question, ctx);
  }

  if (TEMPLATES[cls.decision]) {
    return runTier1(cls.decision, cls.slots || {}, ctx);
  }

  return abstain(ctx, "I can't answer that reliably. Try one of the suggested questions.");
}

module.exports = { answerQuestion, ABSTAIN_THRESHOLD, CONSENSUS_N };
