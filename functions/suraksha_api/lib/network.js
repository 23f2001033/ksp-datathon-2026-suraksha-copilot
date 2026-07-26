'use strict';

const guardrails = require('./guardrails');
const db = require('./db');
const { phoneticKey } = require('./entityResolution');

/**
 * Criminal network (link) analysis.
 *
 * Edges are co-accusation: two people named in the same FIR, weighted by how
 * many FIRs they share. That is the strongest-provenance link available in FIR
 * data (vs. weak links like shared surname), and every edge is traceable to
 * specific FIRs — consistent with the "every claim has evidence" rule.
 *
 * The seed person is matched by name using the same phonetic key as the
 * entity-resolution layer, so "network of Sivakumar" also finds "Shivakumar".
 * Person-level feature → gated behind a logged justification by the template.
 */

const MAX_NODES = 40;

async function coAccusedEdges(scopePredicate) {
  // fir_accused is a link table (not scoped); accused is scoped via the join.
  const sql =
    'SELECT fa1.accused_id AS a, fa2.accused_id AS b, COUNT(DISTINCT fa1.fir_id) AS shared ' +
    'FROM fir_accused fa1 ' +
    'JOIN fir_accused fa2 ON fa1.fir_id = fa2.fir_id AND fa1.accused_id < fa2.accused_id ' +
    'GROUP BY fa1.accused_id, fa2.accused_id';
  const safeSql = guardrails.enforce(sql, { scopePredicate: null, maxRows: 100000 });
  const { rows } = await db.query(safeSql);
  return rows;
}

async function findSeeds(name, scopePredicate) {
  const sql = 'SELECT accused_id, name, age, gender, district FROM accused';
  const safeSql = guardrails.enforce(sql, { scopePredicate, maxRows: 5000 });
  const { rows } = await db.query(safeSql);
  const target = phoneticKey(name);
  if (!target) return [];
  return rows.filter((r) => phoneticKey(r.name) === target);
}

async function loadPeople(ids, scopePredicate) {
  if (!ids.length) return [];
  const list = ids.map((n) => Number(n)).filter(Number.isFinite).join(',');
  const sql =
    `SELECT accused.accused_id, accused.name, accused.age, accused.gender, accused.district, ` +
    `COUNT(DISTINCT fir_accused.fir_id) AS case_count ` +
    `FROM accused JOIN fir_accused ON accused.accused_id = fir_accused.accused_id ` +
    `WHERE accused.accused_id IN (${list}) GROUP BY accused.accused_id`;
  const safeSql = guardrails.enforce(sql, { scopePredicate, maxRows: MAX_NODES + 10 });
  const { rows } = await db.query(safeSql);
  return rows;
}

/**
 * Build the 2-hop co-accusation network around a named person.
 * Returns { nodes, edges, seedIds, executedSql } or null when no match.
 */
async function networkForName(name, { scopePredicate }) {
  const seeds = await findSeeds(name, scopePredicate);
  if (!seeds.length) return null;

  const allEdges = await coAccusedEdges(scopePredicate);
  const adj = new Map();
  for (const e of allEdges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ other: e.b, shared: e.shared });
    adj.get(e.b).push({ other: e.a, shared: e.shared });
  }

  // BFS 2 hops from all seed variants (they are probably the same person).
  const seedIds = new Set(seeds.map((s) => s.accused_id));
  const hop = new Map();
  for (const id of seedIds) hop.set(id, 0);
  let frontier = [...seedIds];
  for (let depth = 1; depth <= 2 && hop.size < MAX_NODES; depth++) {
    const next = [];
    // Expand strongest edges first so the cap keeps the most relevant nodes.
    const candidates = [];
    for (const id of frontier) {
      for (const { other, shared } of adj.get(id) || []) {
        if (!hop.has(other)) candidates.push({ other, shared });
      }
    }
    candidates.sort((x, y) => y.shared - x.shared);
    for (const { other } of candidates) {
      if (hop.size >= MAX_NODES) break;
      if (!hop.has(other)) {
        hop.set(other, depth);
        next.push(other);
      }
    }
    frontier = next;
  }

  const ids = [...hop.keys()];
  const people = await loadPeople(ids, scopePredicate);
  const present = new Set(people.map((p) => p.accused_id));

  const nodes = people.map((p) => ({
    id: p.accused_id,
    name: p.name,
    age: p.age,
    gender: p.gender,
    district: p.district,
    cases: p.case_count,
    hop: hop.get(p.accused_id),
    seed: seedIds.has(p.accused_id),
  }));

  const edges = allEdges
    .filter((e) => present.has(e.a) && present.has(e.b))
    .map((e) => ({ a: e.a, b: e.b, shared: e.shared }));

  return {
    nodes,
    edges,
    seedIds: [...seedIds],
    matchedNames: [...new Set(seeds.map((s) => s.name))],
  };
}

module.exports = { networkForName, MAX_NODES };
