'use strict';

const guardrails = require('./guardrails');
const db = require('./db');
const { canonicalCrimeType } = require('./semanticLayer');

/**
 * Early-warning analytics: per crime type, compare the most recent complete
 * month against the trailing baseline and flag statistically unusual activity.
 *
 * Deliberately simple and fully explainable — a z-score against a 12-month
 * baseline plus a least-squares slope, both computable from the rows the
 * officer can see. This is PLACE-AND-TIME-BASED prediction (which crime types
 * are surging where), not person-based risk scoring — the Puttaswamy-compliant
 * framing the plan committed to.
 */

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function slope(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (xs[i] - my);
    den += (i - mx) ** 2;
  }
  return den ? num / den : 0;
}

function signalFor(z, trend) {
  if (z >= 2) return { signal: 'Spike', severity: 'serious' };
  if (z >= 1.2 || trend === 'rising') return { signal: 'Elevated', severity: 'warning' };
  if (z <= -1.2) return { signal: 'Falling', severity: 'good' };
  return { signal: 'Normal', severity: 'good' };
}

/**
 * @returns rows: one alert card per crime type, sorted most-severe first.
 */
async function earlyWarnings({ scopePredicate, district, crime_type }) {
  const clauses = ["occurrence_date >= date('now', '-14 months')"];
  if (district) clauses.push(`district = '${String(district).replace(/'/g, "''")}'`);
  const crime = canonicalCrimeType(crime_type);
  if (crime) clauses.push(`crime_type = '${crime.replace(/'/g, "''")}'`);

  const sql =
    `SELECT crime_type, substr(occurrence_date, 1, 7) AS month, COUNT(*) AS n ` +
    `FROM fir WHERE ${clauses.join(' AND ')} GROUP BY crime_type, month ORDER BY month`;
  const safeSql = guardrails.enforce(sql, { scopePredicate, maxRows: 5000 });
  const { rows } = await db.query(safeSql);

  // The current calendar month is partial — evaluate the last complete month.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = [...new Set(rows.map((r) => r.month))].filter((m) => m < thisMonth).sort();
  if (months.length < 4) return { rows: [], executedSql: safeSql };

  const latest = months[months.length - 1];
  const baselineMonths = months.slice(0, -1);

  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.crime_type)) byType.set(r.crime_type, new Map());
    byType.get(r.crime_type).set(r.month, r.n);
  }

  const alerts = [];
  for (const [type, series] of byType) {
    const baseline = baselineMonths.map((m) => series.get(m) || 0);
    const latestN = series.get(latest) || 0;
    const m = mean(baseline);
    const sd = stddev(baseline);
    const z = sd > 0 ? (latestN - m) / sd : latestN > m ? 2 : 0;
    const recent = months.slice(-4).map((mo) => series.get(mo) || 0);
    const sl = slope(recent);
    const trend = sl > 0.4 ? 'rising' : sl < -0.4 ? 'falling' : 'flat';
    const { signal, severity } = signalFor(z, trend);
    alerts.push({
      crime_type: type,
      month: latest,
      incidents: latestN,
      baseline_avg: Math.round(m * 10) / 10,
      z_score: Math.round(z * 100) / 100,
      trend,
      signal,
      severity,
    });
  }

  const order = { serious: 0, warning: 1, good: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity] || b.z_score - a.z_score);

  return { rows: alerts, executedSql: safeSql, evaluatedMonth: latest };
}

module.exports = { earlyWarnings };
