'use strict';

const { GLOSSARY, DISTRICTS, canonicalCrimeType } = require('./semanticLayer');

/**
 * Offline fallback: keyword-based intent routing and templated answers, used
 * when no Anthropic API key is configured (air-gapped / on-prem deployments) or
 * when an LLM call fails. It only ever routes to Tier-1 verified templates, so
 * results stay correct even with no model — the reliability floor of the system.
 */

// Kannada district stems (inflected forms like ಬೆಂಗಳೂರಿನಲ್ಲಿ "in Bengaluru"
// contain the stem, so we match by substring, not word boundary).
const KN_DISTRICT_STEMS = {
  'ಬೆಂಗಳೂರ': 'Bengaluru City',
  'ಮೈಸೂರ': 'Mysuru',
  'ಮಂಗಳೂರ': 'Mangaluru',
  'ಹುಬ್ಬಳ್ಳಿ': 'Hubballi-Dharwad',
  'ಧಾರವಾಡ': 'Hubballi-Dharwad',
  'ಬೆಳಗಾವಿ': 'Belagavi',
  'ಕಲಬುರಗಿ': 'Kalaburagi',
  'ತುಮಕೂರ': 'Tumakuru',
  'ಶಿವಮೊಗ್ಗ': 'Shivamogga',
  'ಬಳ್ಳಾರಿ': 'Ballari',
};

const DISTRICT_ALIASES = {
  bengaluru: 'Bengaluru City',
  bangalore: 'Bengaluru City',
  blr: 'Bengaluru City',
  mysore: 'Mysuru',
  mysuru: 'Mysuru',
  mangalore: 'Mangaluru',
  mangaluru: 'Mangaluru',
  hubli: 'Hubballi-Dharwad',
  hubballi: 'Hubballi-Dharwad',
  dharwad: 'Hubballi-Dharwad',
  belgaum: 'Belagavi',
  belagavi: 'Belagavi',
  gulbarga: 'Kalaburagi',
  kalaburagi: 'Kalaburagi',
  tumakuru: 'Tumakuru',
  tumkur: 'Tumakuru',
  shivamogga: 'Shivamogga',
  shimoga: 'Shivamogga',
  ballari: 'Ballari',
  bellary: 'Ballari',
};

function extractDistrict(q) {
  const lower = q.toLowerCase();
  for (const d of DISTRICTS) {
    if (lower.includes(d.toLowerCase())) return d;
  }
  for (const [alias, canonical] of Object.entries(DISTRICT_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(lower)) return canonical;
  }
  // Kannada stems: \b does not work across Indic scripts — substring match.
  for (const [stem, canonical] of Object.entries(KN_DISTRICT_STEMS)) {
    if (q.includes(stem)) return canonical;
  }
  return undefined;
}

// Longest keys first so "vehicle theft" wins over "theft".
const GLOSSARY_KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

function extractCrimeType(q) {
  const lower = q.toLowerCase();
  for (const key of GLOSSARY_KEYS) {
    if (lower.includes(key.toLowerCase())) return GLOSSARY[key];
  }
  return canonicalCrimeType(lower) || undefined;
}

function extractMonths(q) {
  const lower = q.toLowerCase();
  let m = lower.match(/last\s+(\d+)\s+month/);
  if (m) return parseInt(m[1], 10);
  m = lower.match(/last\s+(\d+)\s+year/);
  if (m) return parseInt(m[1], 10) * 12;
  if (/this year|past year|last year|over the year|annual/.test(lower)) return 12;
  if (/this month/.test(lower)) return 1;
  // Kannada: "ಕಳೆದ 6 ತಿಂಗಳ" (last 6 months), "ಕಳೆದ ವರ್ಷ" (last year)
  m = q.match(/(\d+)\s*ತಿಂಗಳ/);
  if (m) return parseInt(m[1], 10);
  if (/ಕಳೆದ\s*ವರ್ಷ|ಈ\s*ವರ್ಷ/.test(q)) return 12;
  return undefined;
}

function extractFirNumber(q) {
  const m = q.match(/([A-Za-z]{2,4}-[A-Za-z]{2,4}-\d{2,5}\/\d{4})/);
  return m ? m[1].toUpperCase() : undefined;
}

function extractPersonName(question) {
  // "network of Shivakumar Gowda", "who is connected to Imran Sab" — take the
  // capitalized tokens after the trigger phrase.
  const m = question.match(
    /(?:network of|connected (?:to|with)|associates? of|link analysis (?:for|of)|nexus of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/
  );
  return m ? m[1].trim() : undefined;
}

function extractStatus(q) {
  const lower = q.toLowerCase();
  if (/charge\s*sheet/.test(lower)) return 'Charge Sheeted';
  if (/under investigation|pending|open case/.test(lower)) return 'Under Investigation';
  if (/closed/.test(lower)) return 'Closed';
  if (/\bfr\b|final report/.test(lower)) return 'FR Filed';
  return undefined;
}

// Contextual slots a follow-up may inherit from the previous turn.
const INHERITABLE = ['district', 'crime_type', 'months'];

/**
 * Is this question a follow-up that references the previous turn?
 * Cues: pronouns/ellipsis ("there", "same"), continuation openers ("and",
 * "what about"), or a very short fragment ("in Mysuru?", "ಮೈಸೂರಿನಲ್ಲಿ?").
 */
function isFollowUp(question, base) {
  const lower = question.toLowerCase().trim();
  if (/\b(there|that area|those|same|these)\b/.test(lower)) return true;
  if (/^(and|what about|how about|also|now|then)\b/.test(lower)) return true;
  // A short fragment only counts as a continuation if it actually carries a
  // recognizable value (a district, crime type, timeframe, ...) — otherwise
  // ANY short utterance ("hii", "thanks", "ok") matched this catch-all and
  // silently re-answered the previous question instead of prompting again
  // (caught live: typing "hii" after a hotspots query repeated the same
  // hotspots answer).
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && base && base.slots && Object.keys(base.slots).length > 0) return true;
  return false;
}

function classify(question, history) {
  const base = classifyOne(question);
  const prev = Array.isArray(history)
    ? [...history].reverse().find((h) => h && h.decision && h.decision !== 'abstain' && h.slots)
    : null;
  if (!prev || !isFollowUp(question, base)) return base;

  // Inherit contextual slots the follow-up did not respecify.
  const inherited = [];
  const slots = { ...base.slots };
  for (const key of INHERITABLE) {
    if (slots[key] == null && prev.slots[key] != null) {
      slots[key] = prev.slots[key];
      inherited.push(key);
    }
  }

  // Pure ellipsis ("And in Mysuru?") carries no intent of its own — reuse the
  // previous turn's intent with the merged slots.
  let { decision, confidence } = base;
  if (decision === 'abstain' && confidence <= 0.5) {
    decision = prev.decision;
    confidence = 0.65;
  }

  return {
    ...base,
    decision,
    confidence,
    slots,
    reason:
      base.reason +
      (inherited.length ? ` Follow-up: inherited ${inherited.join(', ')} from the previous question.` : ''),
  };
}

function classifyOne(question) {
  const q = question.toLowerCase();
  const slots = {};
  const crime = extractCrimeType(question);
  const district = extractDistrict(question);
  const months = extractMonths(question);
  const fir = extractFirNumber(question);
  const status = extractStatus(question);
  if (crime) slots.crime_type = crime;
  if (district) slots.district = district;
  if (months) slots.months = months;
  if (status) slots.status = status;

  let decision = 'abstain';
  let confidence = 0.4;

  // Destructive intent is never routed to a query — abstain outright. (The
  // guardrails would block any write regardless; this keeps routing honest.)
  if (/\b(delete|remove|drop|erase|update|modify|insert|truncate|wipe)\b/.test(q)) {
    return {
      decision: 'abstain',
      confidence: 0.95,
      language: /[ಀ-೿]/.test(question) ? 'kn' : 'en',
      reason: 'Write/modification requests are not permitted — this system is read-only.',
      slots: {},
    };
  }

  // "N months" is a time window, not a trend request — so trend detection is
  // strict (explicit trend phrasing only), and count questions take precedence.
  const isCount = /how many|number of|\bcount\b|\btotal\b|\bhow much\b/.test(q);
  if (fir) {
    decision = 'case_lookup';
    slots.fir_number = fir;
    confidence = 0.9;
  } else if (/network of|connected (to|with)|link analysis|associates? of|nexus of/.test(q)) {
    decision = 'offender_network';
    const name = extractPersonName(question);
    if (name) slots.name = name;
    confidence = name ? 0.8 : 0.5;
  } else if (/early warning|spik(e|ing)|anomal|surg(e|ing)|alert report|unusual activity/.test(q)) {
    decision = 'early_warnings';
    confidence = 0.75;
  } else if (/duplicate|data quality|transliterat|same person|spelling variant/.test(q)) {
    decision = 'duplicate_records';
    confidence = 0.75;
  } else if (/repeat offender|habitual|multiple case|history[- ]sheeter/.test(q)) {
    decision = 'repeat_offenders';
    confidence = 0.75;
  } else if (/victim|who.*targeted|targeted|ಸಂತ್ರಸ್ತ/.test(q) || /ಸಂತ್ರಸ್ತ/.test(question)) {
    decision = 'victim_profile';
    confidence = 0.72;
  } else if (/residential or commercial|area profile|area type|socio.?economic|by area type|what kind of area/.test(q)) {
    decision = 'socioeconomic_correlation';
    confidence = 0.72;
  } else if (/what time|time of day|when do|day or night|hour of|which hours?|ಯಾವ ಸಮಯ/.test(q) || /ಯಾವ ಸಮಯ/.test(question)) {
    decision = 'temporal_pattern';
    confidence = 0.72;
  } else if (/station.?wise|per station|which station|stations? (performing|perform)|station breakdown|unit.?wise/.test(q)) {
    decision = 'station_breakdown';
    confidence = 0.72;
  } else if (/recent fir|latest fir|fresh case|recent case|new fir|cases this week|latest case/.test(q)) {
    decision = 'recent_firs';
    confidence = 0.72;
  } else if (/\btrend\b|over time|per month|monthly|month[- ]?wise|time series|ಪ್ರವೃತ್ತಿ/.test(q) || /ಪ್ರವೃತ್ತಿ/.test(question)) {
    decision = 'trend';
    confidence = 0.7;
  } else if (/hotspot|where.*(happen|occur|most)|which area|locations?/.test(q) || /ಹಾಟ್|ಎಲ್ಲಿ/.test(question)) {
    decision = 'hotspots';
    confidence = 0.7;
  } else if (/which district|across district|compare.*district|district.*most/.test(q) || /ಯಾವ ಜಿಲ್ಲೆ/.test(question)) {
    decision = 'district_comparison';
    confidence = 0.7;
  } else if (isCount || /ಎಷ್ಟು/.test(question)) {
    decision = 'count_total';
    confidence = 0.7;
  } else if (status || /\bstatus\b|charge ?sheet|under investigation|pending|disposal/.test(q)) {
    decision = 'status_breakdown';
    confidence = 0.65;
  } else if (/top crime|most common|which crime|crime types?/.test(q) || /ಯಾವ ಅಪರಾಧ/.test(question)) {
    decision = 'top_crime_types';
    confidence = 0.7;
  }

  // Kannada Unicode block is U+0C80–U+0CFF.
  const language = /[ಀ-೿]/.test(question) ? 'kn' : 'en';
  return { decision, confidence, language, reason: 'Keyword heuristic (offline mode).', slots };
}

/** Deterministic templated answer for offline mode. */
function answer({ title, rows, viz }) {
  if (!rows.length) return 'No matching records were found.';
  if (viz === 'scalar') {
    const key = Object.keys(rows[0])[0];
    return `${title}: ${rows[0][key]}.`;
  }
  const cols = Object.keys(rows[0]);
  const labelCol = cols[0];
  const valueCol = cols.find((c) => typeof rows[0][c] === 'number') || cols[1] || cols[0];
  const top = rows[0];
  return `${rows.length} result${rows.length === 1 ? '' : 's'}. Top: ${top[labelCol]} (${top[valueCol]}).`;
}

module.exports = { classify, answer, isFollowUp };
