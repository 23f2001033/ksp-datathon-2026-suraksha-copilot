'use strict';

const guardrails = require('./guardrails');
const db = require('./db');

/**
 * Indic-aware entity resolution over accused records.
 *
 * CCTNS-class data has no unique person identifier, and the same person appears
 * under transliteration variants ("Shivakumar" / "Sivakumar" / "Shiva Kumar").
 * This module finds probable duplicate clusters with a confidence score.
 *
 * Design rule: merges are SUGGESTED, never automatic. A wrong automatic merge
 * of two different people in a police database is a civil-liberties incident;
 * a suggested merge with evidence is an investigator tool. The engine surfaces
 * clusters + confidence and leaves confirmation to a human (which is itself an
 * auditable act in a full deployment).
 *
 * Method (lightweight Splink-style pipeline, dependency-free):
 *   1. Blocking: an Indic-tuned phonetic key over the full name — collapses
 *      aspirated/unaspirated consonants (th/t, bh/b...), long/short vowels
 *      (aa/a, ee/i), sh/s, v/w, spacing.
 *   2. Scoring within a block: normalized Levenshtein over normalized names,
 *      boosted by same district / same station.
 */

// ---- phonetic key -----------------------------------------------------------

const SUBSTITUTIONS = [
  [/aa+/g, 'a'], [/ee+/g, 'i'], [/ii+/g, 'i'], [/oo+/g, 'u'], [/uu+/g, 'u'],
  [/th/g, 't'], [/dh/g, 'd'], [/bh/g, 'b'], [/gh/g, 'g'], [/kh/g, 'k'],
  [/ph/g, 'f'], [/chh?/g, 'c'], [/sh/g, 's'], [/zh/g, 'j'],
  [/w/g, 'v'], [/z/g, 'j'], [/q/g, 'k'], [/x/g, 'ks'], [/y$/g, 'i'],
];

/**
 * Phonetic key for one name: normalize transliteration variants, drop spacing,
 * collapse doubled letters, then drop non-leading vowels (they carry the least
 * signal across transliterations).
 */
function phoneticKey(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [re, sub] of SUBSTITUTIONS) s = s.replace(re, sub);
  s = s.replace(/(.)\1+/g, '$1');
  if (!s) return '';
  const head = s[0];
  const tail = s.slice(1).replace(/[aeiou]/g, '');
  return head + tail;
}

// ---- similarity -------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nameSimilarity(a, b) {
  const na = String(a).toLowerCase().replace(/[^a-z]/g, '');
  const nb = String(b).toLowerCase().replace(/[^a-z]/g, '');
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/** Pairwise match confidence in [0,1]. */
function matchConfidence(a, b) {
  let score = nameSimilarity(a.name, b.name) * 0.7;
  if (a.district === b.district) score += 0.15;
  if (a.station_id === b.station_id) score += 0.1;
  if (a.age != null && b.age != null && Math.abs(a.age - b.age) <= 3) score += 0.05;
  return Math.min(1, Math.round(score * 100) / 100);
}

// ---- clustering -------------------------------------------------------------

/**
 * Find probable-duplicate clusters among accused, optionally limited to a
 * district. Scoped by the caller's RBAC predicate like every other query.
 * Returns rows shaped for the chat card (one row per member, cluster-tagged).
 */
async function duplicateClusters({ scopePredicate, district, minConfidence = 0.62, maxClusters = 12 }) {
  let sql =
    'SELECT accused_id, name, age, gender, district, station_id FROM accused';
  if (district) sql += ` WHERE district = '${String(district).replace(/'/g, "''")}'`;
  const safeSql = guardrails.enforce(sql, { scopePredicate, maxRows: 5000 });
  const { rows: people } = await db.query(safeSql);

  // Block by phonetic key.
  const blocks = new Map();
  for (const p of people) {
    const key = phoneticKey(p.name);
    if (!key) continue;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(p);
  }

  const clusters = [];
  for (const [key, members] of blocks) {
    if (members.length < 2) continue;
    // Distinct raw spellings only — identical strings are the same record style,
    // not a transliteration problem worth surfacing.
    const spellings = new Set(members.map((m) => m.name));
    if (spellings.size < 2) continue;

    // Confidence = min pairwise confidence across the cluster (conservative).
    let conf = 1;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        conf = Math.min(conf, matchConfidence(members[i], members[j]));
      }
    }
    if (conf < minConfidence) continue;
    clusters.push({ key, members, confidence: conf });
  }

  clusters.sort((a, b) => b.confidence - a.confidence || b.members.length - a.members.length);
  const top = clusters.slice(0, maxClusters);

  const rows = [];
  top.forEach((c, idx) => {
    for (const m of c.members) {
      rows.push({
        cluster: idx + 1,
        confidence: c.confidence,
        name: m.name,
        age: m.age,
        district: m.district,
        station_id: m.station_id,
        accused_id: m.accused_id,
      });
    }
  });

  return {
    rows,
    executedSql: safeSql,
    stats: { candidates: people.length, clusters: top.length },
  };
}

module.exports = { phoneticKey, nameSimilarity, matchConfidence, duplicateClusters };
