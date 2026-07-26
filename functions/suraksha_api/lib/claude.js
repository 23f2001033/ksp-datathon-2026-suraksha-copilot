'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { schemaPrompt, CRIME_TYPES, DISTRICTS, STATUSES } = require('./semanticLayer');

/**
 * Claude integration for the three LLM-backed steps:
 *   1. Intent classification + slot filling  (routes to Tier 1 / 2 / abstain)
 *   2. Tier-2 generative SQL  (against the semantic layer, guardrailed after)
 *   3. Grounded answer composition  (prose strictly derived from result rows)
 *
 * The model never invents facts: step 3 is handed the actual rows and told to
 * summarize only those. Every number the officer sees is traceable to the SQL
 * that produced it.
 */

const MODEL = process.env.SURAKSHA_MODEL || 'claude-opus-4-8';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function hasLLM() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function firstText(resp) {
  const block = resp.content.find((b) => b.type === 'text');
  return block ? block.text : '';
}

// -- 1. Intent classification -------------------------------------------------

async function classifyIntent(question, catalog, history) {
  const c = getClient();
  if (!c) return null;

  const decisionEnum = [...catalog.map((t) => t.id), 'generative', 'abstain'];

  const schema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: decisionEnum },
      confidence: { type: 'number' },
      language: { type: 'string', enum: ['en', 'kn', 'other'] },
      reason: { type: 'string' },
      slots: { type: 'string', description: 'JSON object of extracted slots.' },
    },
    required: ['decision', 'confidence', 'language', 'reason', 'slots'],
    additionalProperties: false,
  };

  const system = [
    'You route an investigator\'s natural-language question about the Karnataka State Police crime database to the safest way of answering it.',
    '',
    'Prefer a verified template whenever one fits — templates are hand-checked and always correct. Only choose "generative" when no template fits but the question is clearly answerable from the schema. Choose "abstain" when the question is ambiguous, needs data we do not have, or asks for a judgement rather than a fact.',
    '',
    'Verified templates:',
    JSON.stringify(catalog, null, 1),
    '',
    'Slot values must be normalized:',
    `  crime_type ∈ {${CRIME_TYPES.join(', ')}} (map synonyms/Kannada to these)`,
    `  district ∈ {${DISTRICTS.join(', ')}}`,
    `  status ∈ {${STATUSES.join(', ')}}`,
    '  months = integer window; min_cases = integer; fir_number = string as written.',
    '  name = the person\'s name exactly as the user wrote it (for offender_network).',
    '  For person-level templates (repeat_offenders, offender_network), if the user gave a reason to view person-level data, put it in slots.justification.',
    '',
    'confidence is 0..1 that your decision answers the question correctly. Detect the question language (en/kn/other). Return slots as a JSON string (use {} if none).',
    '',
    'If previous turns are provided and the current question is a follow-up (pronouns like "there"/"same", or an elliptical fragment like "and in Mysuru?"), resolve the references: reuse the previous intent when the fragment carries none, and carry over contextual slots (district, crime_type, months) the user did not respecify.',
  ].join('\n');

  const historyBlock =
    Array.isArray(history) && history.length
      ? 'Previous turns:\n' +
        history
          .slice(-4)
          .map((h) => `Q: ${h.question}\n→ intent ${h.decision}, slots ${JSON.stringify(h.slots || {})}`)
          .join('\n') +
        '\n\nCurrent question: '
      : '';

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 512,
    output_config: { format: { type: 'json_schema', schema }, effort: 'low' },
    system,
    messages: [{ role: 'user', content: historyBlock + question }],
  });

  const parsed = JSON.parse(firstText(resp));
  let slots = {};
  try {
    slots = parsed.slots ? JSON.parse(parsed.slots) : {};
  } catch {
    slots = {};
  }
  return {
    decision: parsed.decision,
    confidence: parsed.confidence,
    language: parsed.language,
    reason: parsed.reason,
    slots,
  };
}

// -- 2. Generative SQL (Tier 2) ----------------------------------------------

async function generateSqlCandidate(question, priorError) {
  const c = getClient();
  if (!c) return null;

  const schema = {
    type: 'object',
    properties: {
      sql: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['sql', 'rationale'],
    additionalProperties: false,
  };

  const system = [
    'You write a single read-only SQLite SELECT query to answer an investigator\'s question about the Karnataka State Police crime database.',
    '',
    'Schema (use ONLY these tables and columns):',
    schemaPrompt(),
    '',
    'Rules:',
    '  - Exactly one SELECT statement. No INSERT/UPDATE/DELETE/DDL/PRAGMA.',
    '  - Use only the tables and columns above. Do not invent columns.',
    '  - Dates are ISO text; use date(\'now\', \'-N months\') for relative windows.',
    '  - Do NOT add district/station filters for access control — the system injects those.',
    '  - Prefer GROUP BY aggregates with clear column aliases. Add ORDER BY and a LIMIT.',
    '  - crime_type / status / district values must match the enumerations exactly.',
    priorError ? `\nYour previous attempt failed with: ${priorError}\nFix it.` : '',
  ].join('\n');

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 700,
    output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    system,
    messages: [{ role: 'user', content: question }],
  });

  return JSON.parse(firstText(resp)).sql;
}

// -- 3. Grounded answer -------------------------------------------------------

async function composeAnswer({ question, title, rows, language }) {
  const c = getClient();
  if (!c) return null;

  const langName = language === 'kn' ? 'Kannada' : language === 'other' ? 'the user\'s language' : 'English';
  const sample = rows.slice(0, 40);

  const system = [
    'You are Suraksha Copilot, an investigation assistant for the Karnataka State Police.',
    `Write a short, factual answer in ${langName} to the investigator\'s question, using ONLY the data rows provided.`,
    'Do not add facts, figures, or interpretation not present in the rows. If the rows are empty, say plainly that no matching records were found.',
    'Lead with the direct answer. Keep it to 1–3 sentences. Do not mention SQL or that you are an AI.',
  ].join('\n');

  const content = [
    `Question: ${question}`,
    `Result title: ${title}`,
    `Rows (JSON): ${JSON.stringify(sample)}`,
    rows.length > sample.length ? `(showing ${sample.length} of ${rows.length} rows)` : '',
  ].join('\n');

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 400,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content }],
  });

  return firstText(resp).trim();
}

module.exports = { hasLLM, MODEL, classifyIntent, generateSqlCandidate, composeAnswer };
