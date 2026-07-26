'use strict';

const guardrails = require('./guardrails');
const db = require('./db');
const { scopePredicate } = require('./rbac');
const { TEMPLATES } = require('./templates');
const forecast = require('./forecast');

/**
 * Role-differentiated command dashboards.
 *
 * The same crime-intelligence brain presents as three different products,
 * because each rank makes a different decision:
 *   DGP  — strategic    : where to allocate state resources (whole state)
 *   SP   — supervisory  : which of my units to push, my district's hotspots
 *   IO   — operational  : what to work today on my beat (my station)
 *
 * Every panel is built by running the SAME verified templates the chat copilot
 * uses, scope-injected via the caller's RBAC predicate and guardrailed — so a
 * dashboard can never show data the officer couldn't get by asking, and an SP's
 * "stations under command" only ever includes their own district's stations.
 */

async function runScoped(sql, sp) {
  const safe = guardrails.enforce(sql, { scopePredicate: sp });
  const { columns, rows } = await db.query(safe);
  return { columns, rows, executedSql: safe };
}

async function scalar(sql, sp, fallback = 0) {
  const { rows } = await runScoped(sql, sp);
  if (!rows.length) return fallback;
  const v = Object.values(rows[0])[0];
  return v == null ? fallback : v;
}

// Build a panel from a verified template + slots (scope-injected).
async function panelFromTemplate(templateId, slots, sp, extra = {}) {
  const built = TEMPLATES[templateId].build(slots);
  const { columns, rows } = await runScoped(built.sql, sp);
  return { title: built.title, viz: built.viz, columns, rows, ...extra };
}

async function buildOverview(user) {
  const sp = scopePredicate(user);

  // Shared KPIs (scope-injected everywhere).
  const firs30 = await scalar(`SELECT COUNT(*) FROM fir WHERE reported_date >= date('now', '-30 days')`, sp);
  const csRate = await scalar(
    `SELECT ROUND(100.0 * SUM(CASE WHEN status='Charge Sheeted' THEN 1 ELSE 0 END) / COUNT(*), 1) FROM fir WHERE reported_date >= date('now','-90 days')`,
    sp, 0
  );
  const underInv = await scalar(`SELECT COUNT(*) FROM fir WHERE status='Under Investigation'`, sp);

  const alerts = await forecast.earlyWarnings({ scopePredicate: sp, district: user.district || undefined });
  const activeAlerts = alerts.rows.filter((r) => r.severity === 'serious' || r.severity === 'warning');
  const topSurge = activeAlerts[0] ? activeAlerts[0].crime_type : '—';

  if (user.role === 'DGP') {
    const districtRows = (
      await runScoped(
        `SELECT district, COUNT(*) AS incidents FROM fir WHERE reported_date >= date('now','-90 days') GROUP BY district ORDER BY incidents DESC`,
        sp
      )
    ).rows;
    return {
      role: 'DGP',
      headline: 'State Command Center',
      subtitle: 'Strategic view — all districts of Karnataka',
      kpis: [
        { label: 'FIRs (last 30 days)', value: firs30, sub: 'state-wide' },
        { label: 'Charge-sheet rate', value: csRate + '%', sub: 'last 90 days' },
        { label: 'Active surge alerts', value: activeAlerts.length, sub: 'crime types spiking/elevated', tone: activeAlerts.length ? 'warn' : 'good' },
        { label: 'Top surging crime', value: topSurge, sub: 'this month vs baseline' },
      ],
      panels: [
        {
          title: 'Crime intensity by district (last 90 days)',
          viz: 'choropleth',
          columns: ['district', 'incidents'],
          rows: districtRows,
          drilldown: null,
        },
        {
          title: 'State early warnings',
          viz: 'alerts',
          columns: alerts.rows.length ? Object.keys(alerts.rows[0]) : [],
          rows: alerts.rows,
          drilldown: { question: 'Which crimes are spiking?' },
        },
        await panelFromTemplate('top_crime_types', { months: 12 }, sp, {
          drilldown: { question: 'What are the top crime types this year?' },
        }),
        await panelFromTemplate('trend', { months: 12 }, sp, {
          title: 'State-wide monthly trend',
          drilldown: { question: 'Monthly crime trend' },
        }),
      ],
    };
  }

  if (user.role === 'SP') {
    const stationCount = await scalar(
      `SELECT COUNT(*) FROM police_station WHERE district = '${(user.district || '').replace(/'/g, "''")}'`,
      '1=1'
    );
    const repeatOffenders = await scalar(
      `SELECT COUNT(*) FROM (SELECT accused.accused_id FROM accused JOIN fir_accused ON accused.accused_id = fir_accused.accused_id GROUP BY accused.accused_id HAVING COUNT(DISTINCT fir_accused.fir_id) >= 2) t`,
      sp
    );
    return {
      role: 'SP',
      headline: `District Command — ${user.district}`,
      subtitle: 'Supervisory view — your district and the units under your command',
      kpis: [
        { label: 'FIRs (last 30 days)', value: firs30, sub: user.district },
        { label: 'Charge-sheet rate', value: csRate + '%', sub: 'last 90 days' },
        { label: 'Stations under command', value: stationCount, sub: 'in district' },
        { label: 'Active repeat offenders', value: repeatOffenders, sub: '≥ 2 linked cases', tone: repeatOffenders ? 'warn' : 'good' },
      ],
      panels: [
        await panelFromTemplate('station_breakdown', { district: user.district, months: 3 }, sp, {
          title: 'Station performance (FIRs & charge-sheet rate, last 3 months)',
          drilldown: { question: 'Station-wise breakdown', template: 'station_breakdown', slots: { district: user.district, months: 3 } },
        }),
        await panelFromTemplate('hotspots', { district: user.district, months: 6 }, sp, {
          title: 'District hotspots (last 6 months)',
          drilldown: { question: `Hotspots in ${user.district}`, template: 'hotspots', slots: { district: user.district, months: 6 } },
        }),
        {
          title: 'District early warnings',
          viz: 'alerts',
          columns: alerts.rows.length ? Object.keys(alerts.rows[0]) : [],
          rows: alerts.rows,
          drilldown: { question: `Any early warnings for ${user.district}?` },
        },
      ],
    };
  }

  // IO — operational, station-scoped.
  const hotspotAreas = await scalar(
    `SELECT COUNT(*) FROM (SELECT area FROM fir WHERE occurrence_date >= date('now','-90 days') GROUP BY area HAVING COUNT(*) >= 2) t`,
    sp
  );
  const beatOffenders = await scalar(
    `SELECT COUNT(*) FROM (SELECT accused.accused_id FROM accused JOIN fir_accused ON accused.accused_id = fir_accused.accused_id GROUP BY accused.accused_id HAVING COUNT(DISTINCT fir_accused.fir_id) >= 2) t`,
    sp
  );
  return {
    role: 'IO',
    headline: `Station Desk — ${user.name.replace(/^IO\s+/, '')}`,
    subtitle: 'Operational view — your station and your beat, right now',
    kpis: [
      { label: 'FIRs (last 30 days)', value: firs30, sub: 'this station' },
      { label: 'Open cases', value: underInv, sub: 'under investigation', tone: underInv ? 'warn' : 'good' },
      { label: 'Active hotspot areas', value: hotspotAreas, sub: 'on your beat' },
      { label: 'Repeat offenders', value: beatOffenders, sub: 'on your patch' },
    ],
    panels: [
      await panelFromTemplate('recent_firs', { days: 21 }, sp, {
        title: 'Fresh FIRs (last 21 days) — your case queue',
        drilldown: { question: 'Recent FIRs at my station', template: 'recent_firs', slots: { days: 21 } },
      }),
      await panelFromTemplate('hotspots', { months: 6 }, sp, {
        title: 'Beat hotspots (last 6 months)',
        drilldown: { question: 'Hotspots on my beat', template: 'hotspots', slots: { months: 6 } },
      }),
      await panelFromTemplate('status_breakdown', {}, sp, {
        title: 'Case status at this station',
        drilldown: { question: 'Status breakdown at my station' },
      }),
    ],
  };
}

module.exports = { buildOverview };
