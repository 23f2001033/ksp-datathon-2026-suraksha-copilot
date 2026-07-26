'use strict';

const { canonicalCrimeType, DISTRICTS, STATUSES } = require('./semanticLayer');
const { sqlEscape } = require('./rbac');

/**
 * Tier 1 — verified query templates.
 *
 * These cover the head of the investigator-intent distribution. The LLM only
 * classifies intent and fills slots; the SQL is hand-written and reviewed, so
 * a Tier-1 answer is deterministic and provably correct. This is what keeps the
 * live demo from ever breaking and is the core of the reliability story.
 *
 * Templates reference the scoped base tables (fir, accused) without aliases so
 * that guardrail scope-injection stays simple and correct.
 */

function esc(v) {
  return sqlEscape(v);
}

function intOr(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Build a WHERE fragment (without the leading WHERE) from common slots.
function conditions(slots, { dateColumn = 'occurrence_date' } = {}) {
  const clauses = [];
  const notes = [];

  const months = slots.months != null ? intOr(slots.months, null) : null;
  if (months) {
    clauses.push(`${dateColumn} >= date('now', '-${months} months')`);
    notes.push(`last ${months} months`);
  }

  const crime = canonicalCrimeType(slots.crime_type);
  if (crime) {
    clauses.push(`crime_type = '${esc(crime)}'`);
    notes.push(crime);
  }

  if (slots.district && DISTRICTS.includes(slots.district)) {
    clauses.push(`district = '${esc(slots.district)}'`);
    notes.push(slots.district);
  }

  if (slots.status && STATUSES.includes(slots.status)) {
    clauses.push(`status = '${esc(slots.status)}'`);
    notes.push(slots.status);
  }

  // area is free text (locality names aren't a closed enum like district), so
  // it is escaped but not validated against a list.
  if (slots.area) {
    clauses.push(`area = '${esc(slots.area)}'`);
    notes.push(slots.area);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', notes };
}

const TEMPLATES = {
  count_total: {
    description: 'Total number of FIRs matching an optional crime type, district and time window.',
    slots: ['crime_type?', 'district?', 'months?'],
    examples: [
      'How many chain snatching cases in Bengaluru this year?',
      'Total cybercrime FIRs in the last 6 months',
      'ಬೆಂಗಳೂರಿನಲ್ಲಿ ಎಷ್ಟು ಕಳ್ಳತನ ಪ್ರಕರಣಗಳಿವೆ?',
    ],
    viz: 'scalar',
    build(slots) {
      const { where, notes } = conditions(slots);
      return {
        sql: `SELECT COUNT(*) AS total_firs FROM fir ${where}`,
        title: `Total FIRs${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'scalar',
      };
    },
  },

  hotspots: {
    description:
      'Geographic hotspots: the areas with the most incidents for an optional crime type/district over a time window. Returns coordinates for mapping.',
    slots: ['crime_type?', 'district?', 'months? (default 6)'],
    examples: [
      'Where are the chain snatching hotspots in Bengaluru over the last 6 months?',
      'Burglary hotspots in Mysuru',
      'ಬೆಂಗಳೂರಿನಲ್ಲಿ ಚೈನ್ ಸ್ನ್ಯಾಚಿಂಗ್ ಹಾಟ್‌ಸ್ಪಾಟ್ ಎಲ್ಲಿ?',
    ],
    viz: 'map',
    build(slots) {
      const s = { ...slots, months: slots.months != null ? slots.months : 6 };
      const { where, notes } = conditions(s);
      return {
        sql:
          `SELECT area, district, COUNT(*) AS incidents, ` +
          `ROUND(AVG(lat), 5) AS lat, ROUND(AVG(lon), 5) AS lon ` +
          `FROM fir ${where} GROUP BY area, district ` +
          `ORDER BY incidents DESC LIMIT 15`,
        title: `Hotspots${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'map',
      };
    },
  },

  trend: {
    description: 'Monthly time series (count per month) for an optional crime type/district.',
    slots: ['crime_type?', 'district?', 'months? (default 12)'],
    examples: [
      'Trend of vehicle theft in Bengaluru over the last year',
      'Monthly cybercrime cases',
      'ಕಳೆದ ವರ್ಷದ ದರೋಡೆ ಪ್ರವೃತ್ತಿ',
    ],
    viz: 'line',
    build(slots) {
      const s = { ...slots, months: slots.months != null ? slots.months : 12 };
      const { where, notes } = conditions(s);
      return {
        sql:
          `SELECT substr(occurrence_date, 1, 7) AS month, COUNT(*) AS incidents ` +
          `FROM fir ${where} GROUP BY month ORDER BY month`,
        title: `Monthly trend${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'line',
      };
    },
  },

  top_crime_types: {
    description: 'Ranking of crime types by volume for an optional district and time window.',
    slots: ['district?', 'months? (default 12)'],
    examples: [
      'What are the top crimes in Mysuru?',
      'Most common crime types this year',
    ],
    viz: 'bar',
    build(slots) {
      const s = { ...slots, months: slots.months != null ? slots.months : 12 };
      const { where, notes } = conditions(s);
      return {
        sql:
          `SELECT crime_type, COUNT(*) AS incidents FROM fir ${where} ` +
          `GROUP BY crime_type ORDER BY incidents DESC`,
        title: `Top crime types${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  status_breakdown: {
    description: 'Distribution of FIRs across investigation statuses (Under Investigation, Charge Sheeted, etc.).',
    slots: ['crime_type?', 'district?', 'months?'],
    examples: [
      'How many cases are still under investigation in Bengaluru?',
      'Charge sheet rate for cybercrime',
    ],
    viz: 'bar',
    build(slots) {
      // A status mention ("charge sheet rate") is the topic here, not a filter —
      // a breakdown filtered to one status would be a single meaningless row.
      const { where, notes } = conditions({ ...slots, status: undefined });
      return {
        sql:
          `SELECT status, COUNT(*) AS firs FROM fir ${where} ` +
          `GROUP BY status ORDER BY firs DESC`,
        title: `FIR status breakdown${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  district_comparison: {
    description: 'Compare crime volumes across all districts for an optional crime type and time window (state-level view).',
    slots: ['crime_type?', 'months? (default 12)'],
    examples: [
      'Which district has the most cybercrime?',
      'Compare chain snatching across districts',
    ],
    viz: 'bar',
    build(slots) {
      const s = { ...slots, months: slots.months != null ? slots.months : 12 };
      const { where, notes } = conditions(s);
      return {
        sql:
          `SELECT district, COUNT(*) AS incidents FROM fir ${where} ` +
          `GROUP BY district ORDER BY incidents DESC`,
        title: `District comparison${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  repeat_offenders: {
    description:
      'Accused persons linked to multiple FIRs (repeat offenders) in an optional district. Person-level query — requires a case justification.',
    slots: ['district?', 'min_cases? (default 2)'],
    requiresJustification: true,
    examples: [
      'Show repeat offenders in Bengaluru',
      'Who are the habitual offenders in Mysuru?',
    ],
    viz: 'table',
    build(slots) {
      const min = intOr(slots.min_cases, 2);
      const distClause =
        slots.district && DISTRICTS.includes(slots.district)
          ? `WHERE accused.district = '${esc(slots.district)}'`
          : '';
      return {
        sql:
          `SELECT accused.name, accused.age, accused.gender, accused.district, ` +
          `COUNT(DISTINCT fir_accused.fir_id) AS case_count ` +
          `FROM accused JOIN fir_accused ON accused.accused_id = fir_accused.accused_id ` +
          `${distClause} GROUP BY accused.accused_id ` +
          `HAVING case_count >= ${min} ORDER BY case_count DESC LIMIT 25`,
        title: `Repeat offenders${slots.district ? ' — ' + slots.district : ''} (≥ ${min} cases)`,
        viz: 'table',
      };
    },
  },

  victim_profile: {
    description:
      'Socio-demographic insight: the profile of victims (occupation and age band) for a crime type, optionally in a district/time window. Answers "who is typically targeted?". Aggregate only.',
    slots: ['crime_type?', 'district?', 'months?'],
    examples: [
      'Who are the typical victims of chain snatching?',
      'Victim profile for cybercrime in Bengaluru',
      'ಚೈನ್ ಸ್ನ್ಯಾಚಿಂಗ್ ಸಂತ್ರಸ್ತರು ಯಾರು?',
    ],
    viz: 'bar',
    build(slots) {
      const { where, notes } = conditions(slots);
      return {
        sql:
          `SELECT victim_profession, COUNT(*) AS victims, ` +
          `ROUND(AVG(victim_age)) AS avg_age FROM fir ${where} ` +
          `GROUP BY victim_profession ORDER BY victims DESC`,
        title: `Victim profile${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  socioeconomic_correlation: {
    description:
      'Socio-economic correlation: how a crime type distributes across area character (Residential, Commercial, IT Corridor, Market, Highway, Slum). Answers "does this crime happen in residential or commercial areas?". Aggregate only.',
    slots: ['crime_type?', 'district?', 'months?'],
    examples: [
      'Which areas see cybercrime — residential or commercial?',
      'Where does burglary happen by area type?',
      'Socio-economic breakdown of chain snatching',
    ],
    viz: 'bar',
    build(slots) {
      const { where, notes } = conditions(slots);
      return {
        sql:
          `SELECT area_profile, COUNT(*) AS incidents, ` +
          `ROUND(AVG(property_value)) AS avg_property_value FROM fir ${where} ` +
          `GROUP BY area_profile ORDER BY incidents DESC`,
        title: `Crime by area profile${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  temporal_pattern: {
    description:
      'Temporal pattern: when a crime happens by time of day (Night, Morning, Afternoon, Evening). Answers "what time do chain-snatchings occur?".',
    slots: ['crime_type?', 'district?', 'months?'],
    examples: [
      'What time do chain snatchings happen?',
      'When does vehicle theft occur?',
      'Time of day pattern for burglary in Mysuru',
    ],
    viz: 'bar',
    build(slots) {
      const { where, notes } = conditions(slots);
      return {
        sql:
          `SELECT CASE ` +
          `WHEN occurrence_hour >= 0 AND occurrence_hour < 6 THEN '1. Night (00-06)' ` +
          `WHEN occurrence_hour >= 6 AND occurrence_hour < 12 THEN '2. Morning (06-12)' ` +
          `WHEN occurrence_hour >= 12 AND occurrence_hour < 17 THEN '3. Afternoon (12-17)' ` +
          `ELSE '4. Evening (17-24)' END AS time_of_day, ` +
          `COUNT(*) AS incidents FROM fir ${where} ` +
          `GROUP BY time_of_day ORDER BY time_of_day`,
        title: `Time-of-day pattern${notes.length ? ' — ' + notes.join(', ') : ''}`,
        viz: 'bar',
      };
    },
  },

  station_breakdown: {
    description:
      'Supervisory view: FIR volume and charge-sheet rate per police station within scope. Used by district commanders to see which units are hot or underperforming.',
    slots: ['district?', 'months? (default 3)'],
    examples: ['Station-wise breakdown', 'How are my stations performing?', 'FIRs per station this quarter'],
    viz: 'bar',
    build(slots) {
      // Columns are fir-qualified because this template joins police_station
      // (which also has a `district` column) — an unqualified filter or the
      // injected RBAC scope would otherwise be ambiguous.
      const months = intOr(slots.months, 3);
      const clauses = [`fir.occurrence_date >= date('now', '-${months} months')`];
      const notes = [`last ${months} months`];
      if (slots.district && DISTRICTS.includes(slots.district)) {
        clauses.push(`fir.district = '${esc(slots.district)}'`);
        notes.push(slots.district);
      }
      return {
        sql:
          `SELECT police_station.name AS station, COUNT(*) AS firs, ` +
          `ROUND(100.0 * SUM(CASE WHEN fir.status = 'Charge Sheeted' THEN 1 ELSE 0 END) / COUNT(*), 1) AS chargesheet_rate ` +
          `FROM fir JOIN police_station ON fir.station_id = police_station.station_id ` +
          `WHERE ${clauses.join(' AND ')} ` +
          `GROUP BY fir.station_id ORDER BY firs DESC LIMIT 30`,
        title: `Station-wise breakdown — ${notes.join(', ')}`,
        viz: 'bar',
      };
    },
  },

  recent_firs: {
    description:
      'Operational view: the most recent FIRs in scope (newest first). Used at station level as a live case queue.',
    slots: ['crime_type?', 'district?', 'status?', 'days? (default 14)'],
    examples: ['Recent FIRs', 'Fresh cases this week', 'Latest FIRs at my station'],
    viz: 'table',
    build(slots) {
      const days = intOr(slots.days, 14);
      const extra = [`reported_date >= date('now', '-${days} days')`];
      const crime = canonicalCrimeType(slots.crime_type);
      if (crime) extra.push(`crime_type = '${esc(crime)}'`);
      if (slots.district && DISTRICTS.includes(slots.district)) extra.push(`district = '${esc(slots.district)}'`);
      if (slots.status && STATUSES.includes(slots.status)) extra.push(`status = '${esc(slots.status)}'`);
      return {
        sql:
          `SELECT fir_number, crime_type, status, area, reported_date, occurrence_date ` +
          `FROM fir WHERE ${extra.join(' AND ')} ORDER BY reported_date DESC LIMIT 40`,
        title: `Recent FIRs (last ${days} days)`,
        viz: 'table',
      };
    },
  },

  area_cases: {
    description:
      'Individual case records for one specific locality/area — used to drill down from a hotspot map marker into the FIRs behind it. Not a general-purpose lookup: area must be an exact area name as stored on the FIR.',
    slots: ['area (required)', 'district?', 'crime_type?', 'months?'],
    examples: ['Show cases in Gandhi Gate, Bengaluru City'],
    viz: 'table',
    build(slots) {
      if (!slots.area) return null;
      const { where, notes } = conditions(slots);
      return {
        sql:
          `SELECT fir_number, crime_type, status, reported_date, occurrence_date, area, district ` +
          `FROM fir ${where} ORDER BY occurrence_date DESC`,
        title: `Cases — ${notes.join(', ')}`,
        viz: 'table',
      };
    },
  },

  offender_network: {
    description:
      'Criminal network (link analysis) around a named person: everyone co-accused with them in shared FIRs, 2 hops out. Person-level query — requires a case justification. Put the person\'s name in slots.name.',
    slots: ['name (required)', 'justification?'],
    requiresJustification: true,
    examples: [
      'Show the network of Shivakumar Gowda',
      'Who is connected to Imran Sab?',
      'Link analysis for Basavaraju',
    ],
    viz: 'network',
    async run(slots, ctx) {
      if (!slots.name) return null;
      const { networkForName } = require('./network');
      const net = await networkForName(slots.name, { scopePredicate: ctx.scopePredicate });
      if (!net || !net.nodes.length) {
        return {
          title: `Network of "${slots.name}"`,
          viz: 'table',
          columns: [],
          rows: [],
          executedSql: `-- co-accusation link analysis for phonetic match of '${slots.name}' (no match in your scope)`,
        };
      }
      return {
        title: `Co-accusation network — ${net.matchedNames.join(' / ')} (${net.nodes.length} people, 2 hops)`,
        viz: 'network',
        columns: ['name', 'age', 'district', 'cases', 'hop'],
        rows: net.nodes.map((n) => ({ name: n.name, age: n.age, district: n.district, cases: n.cases, hop: n.hop })),
        network: net,
        executedSql:
          `-- edges: co-accused in the same FIR (weight = shared FIRs); seed matched phonetically\n` +
          `SELECT fa1.accused_id, fa2.accused_id, COUNT(DISTINCT fa1.fir_id) AS shared FROM fir_accused fa1 ` +
          `JOIN fir_accused fa2 ON fa1.fir_id = fa2.fir_id AND fa1.accused_id < fa2.accused_id GROUP BY 1, 2`,
      };
    },
  },

  early_warnings: {
    description:
      'Early-warning report: which crime types are statistically unusual (spiking or elevated) in the most recent complete month vs a 12-month baseline, optionally for one district or crime type.',
    slots: ['district?', 'crime_type?'],
    examples: [
      'Any early warnings for Bengaluru?',
      'Which crimes are spiking?',
      'Alert report for Mysuru',
    ],
    viz: 'alerts',
    async run(slots, ctx) {
      const { earlyWarnings } = require('./forecast');
      const res = await earlyWarnings({
        scopePredicate: ctx.scopePredicate,
        district: slots.district,
        crime_type: slots.crime_type,
      });
      return {
        title: `Early warnings — ${res.evaluatedMonth || 'insufficient history'}${slots.district ? ' · ' + slots.district : ''} (z-score vs 12-month baseline)`,
        viz: 'alerts',
        columns: res.rows.length ? Object.keys(res.rows[0]) : [],
        rows: res.rows,
        executedSql: res.executedSql,
      };
    },
  },

  duplicate_records: {
    description:
      'Data quality: probable duplicate accused records caused by transliteration spelling variants (e.g. Shivakumar / Sivakumar), grouped into suggested clusters with a confidence score. Merges are suggested only, never automatic.',
    slots: ['district?'],
    examples: [
      'Show probable duplicate records in Bengaluru',
      'Data quality check on accused names',
      'Find transliteration duplicates',
    ],
    viz: 'dupes',
    async run(slots, ctx) {
      const { duplicateClusters } = require('./entityResolution');
      const res = await duplicateClusters({
        scopePredicate: ctx.scopePredicate,
        district: slots.district,
      });
      return {
        title: `Probable duplicate accused records${slots.district ? ' — ' + slots.district : ''} · ${res.stats.clusters} clusters from ${res.stats.candidates} records (suggest-only)`,
        viz: 'dupes',
        columns: res.rows.length ? Object.keys(res.rows[0]) : [],
        rows: res.rows,
        executedSql: res.executedSql,
      };
    },
  },

  case_lookup: {
    description: 'Look up a single FIR by its FIR number.',
    slots: ['fir_number (required)'],
    examples: ['Show me FIR BLR-CEN-0142/2025', 'Details of case MYS-DEV-0031/2025'],
    viz: 'table',
    build(slots) {
      if (!slots.fir_number) return null;
      return {
        sql:
          `SELECT fir_number, crime_type, crime_head, status, reported_date, ` +
          `occurrence_date, area, district FROM fir ` +
          `WHERE fir_number = '${esc(slots.fir_number)}'`,
        title: `Case ${slots.fir_number}`,
        viz: 'table',
      };
    },
  },
};

// Compact catalog handed to the LLM intent classifier.
function catalog() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id,
    description: t.description,
    slots: t.slots,
    examples: t.examples,
    requiresJustification: !!t.requiresJustification,
  }));
}

module.exports = { TEMPLATES, catalog };
