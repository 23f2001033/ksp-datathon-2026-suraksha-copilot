'use strict';

/**
 * End-to-end smoke test. Runs the engine offline (heuristic mode, no API key)
 * so it is deterministic and free. Exercises all three tiers, RBAC scope
 * injection, the person-level justification gate, and audit-chain integrity.
 *
 *   node scripts/smoke.js
 */

delete process.env.ANTHROPIC_API_KEY; // force offline/heuristic path

const path = require('path');
const LIB = path.join(__dirname, '..', 'functions', 'suraksha_api', 'lib');
const engine = require(path.join(LIB, 'queryEngine'));
const audit = require(path.join(LIB, 'audit'));
const { getUser } = require(path.join(LIB, 'rbac'));

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const cases = [
  { userId: 'dgp.state', q: 'Which district has the most cybercrime?', expectTier: 1, expectDecision: 'district_comparison' },
  { userId: 'sp.blr', q: 'Where are the chain snatching hotspots in Bengaluru over the last 6 months?', expectTier: 1, expectDecision: 'hotspots', expectScope: "district = 'Bengaluru City'" },
  { userId: 'io.cubbon', q: 'How many theft cases in the last 12 months?', expectTier: 1, expectDecision: 'count_total', expectScope: 'station_id = 1' },
  { userId: 'sp.mysuru', q: 'Trend of vehicle theft over the last year', expectTier: 1, expectDecision: 'trend', expectScope: "district = 'Mysuru'" },
  { userId: 'dgp.state', q: 'Show repeat offenders in Bengaluru', expectGate: true },
  { userId: 'dgp.state', q: 'Show repeat offenders in Bengaluru', justification: 'CR-2026/00554', expectTier: 1, expectDecision: 'repeat_offenders' },
  { userId: 'dgp.state', q: 'What is the meaning of life?', expectTier: 3, expectDecision: 'abstain' },
  { userId: 'sp.blr', q: 'Any early warnings for Bengaluru?', expectTier: 1, expectDecision: 'early_warnings', expectViz: 'alerts' },
  { userId: 'dgp.state', q: 'Show probable duplicate records in Bengaluru', expectTier: 1, expectDecision: 'duplicate_records', expectViz: 'dupes' },
  { userId: 'dgp.state', q: 'Show the network of Basavaraju Sab', expectGate: true },
  { userId: 'dgp.state', q: 'Show the network of Basavaraju Sab', justification: 'CR-2026/00811', expectTier: 1, expectDecision: 'offender_network', expectNetwork: true },
  // Multi-turn: ellipsis follow-up inherits intent + crime type, replaces district.
  {
    userId: 'dgp.state', q: 'And what about Mysuru?',
    history: [{ question: 'Where are the chain snatching hotspots in Bengaluru?', decision: 'hotspots', slots: { crime_type: 'Chain Snatching', district: 'Bengaluru City', months: 6 } }],
    expectTier: 1, expectDecision: 'hotspots',
    expectSqlIncludes: ["crime_type = 'Chain Snatching'", "district = 'Mysuru'"],
  },
  // Multi-turn: "there" resolves to the previous district on a new intent.
  {
    userId: 'dgp.state', q: 'Which repeat offenders operate there?',
    history: [{ question: 'Where are the chain snatching hotspots in Bengaluru?', decision: 'hotspots', slots: { crime_type: 'Chain Snatching', district: 'Bengaluru City', months: 6 } }],
    justification: 'CR-2026/00900',
    expectTier: 1, expectDecision: 'repeat_offenders',
    expectSqlIncludes: ["accused.district = 'Bengaluru City'"],
  },
];

(async () => {
  console.log('Suraksha Copilot — smoke test (offline heuristic mode)\n');

  for (const c of cases) {
    const user = getUser(c.userId);
    const res = await engine.answerQuestion({ question: c.q, user, justification: c.justification, history: c.history });

    console.log(`\n[${c.userId}] "${c.q}"${c.justification ? '  (justification: ' + c.justification + ')' : ''}`);
    if (res.needs_justification) {
      console.log('  -> GATE:', res.message);
      check('person-level query is gated', !!c.expectGate);
      continue;
    }
    console.log(`  tier=${res.tier} (${res.badge}) decision=${res.decision} rows=${res.rows ? res.rows.length : 0}`);
    if (res.executedSql) console.log('  SQL:', res.executedSql.replace(/\s+/g, ' ').slice(0, 160));
    console.log('  answer:', res.answer);

    if (c.expectTier) check(`tier == ${c.expectTier}`, res.tier === c.expectTier);
    if (c.expectDecision) check(`decision == ${c.expectDecision}`, res.decision === c.expectDecision);
    if (c.expectScope) check(`scope injected (${c.expectScope})`, res.executedSql && res.executedSql.includes(c.expectScope));
    if (c.expectViz) check(`viz == ${c.expectViz}`, res.viz === c.expectViz);
    if (c.expectNetwork) check('network payload present', !!(res.network && res.network.nodes.length > 1 && res.network.edges.length > 0));
    if (c.expectSqlIncludes) {
      for (const frag of c.expectSqlIncludes) {
        check(`SQL includes ${frag}`, (res.executedSql || '').includes(frag));
      }
    }
    if (c.expectTier === 1 && !c.expectViz && !c.expectNetwork) check('returned a LIMIT-capped result', /limit\s+\d+/i.test(res.executedSql || ''));
  }

  // Role-differentiated command dashboards.
  const { buildOverview } = require(path.join(LIB, 'overview'));
  console.log('\n--- role command dashboards ---');
  const dgpO = await buildOverview(getUser('dgp.state'));
  const spO = await buildOverview(getUser('sp.blr'));
  const ioO = await buildOverview(getUser('io.cubbon'));
  console.log(`  DGP: ${dgpO.headline} | ${dgpO.panels.map((p) => p.viz).join(',')}`);
  console.log(`  SP:  ${spO.headline} | ${spO.panels.map((p) => p.viz).join(',')}`);
  console.log(`  IO:  ${ioO.headline} | ${ioO.panels.map((p) => p.viz).join(',')}`);
  check('DGP dashboard is State Command', dgpO.role === 'DGP' && dgpO.headline.includes('State'));
  check('SP dashboard is district-scoped', spO.headline.includes('Bengaluru City') && spO.kpis.some((k) => k.label.includes('Stations')));
  check('IO dashboard is station-scoped', ioO.headline.includes('Cubbon') && ioO.kpis.some((k) => k.label === 'Open cases'));
  check('the three dashboards differ (panels)', JSON.stringify(dgpO.panels.map((p) => p.viz)) !== JSON.stringify(ioO.panels.map((p) => p.viz)));
  const dgpFirs = dgpO.kpis[0].value, ioFirs = ioO.kpis[0].value;
  check('RBAC: state FIR count > station FIR count', dgpFirs >= ioFirs);

  // DGP query must NOT be scoped.
  const dgp = await engine.answerQuestion({
    question: 'Which district has the most cybercrime?',
    user: getUser('dgp.state'),
  });
  check('DGP query is not row-scoped', dgp.executedSql && !/district = '/.test(dgp.executedSql.replace("crime_type = 'Cybercrime'", '')));

  // Audit chain integrity.
  const v = audit.verifyChain();
  console.log('\nAudit chain:', v.message, `(entries=${v.count})`);
  check('audit chain intact', v.ok);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
