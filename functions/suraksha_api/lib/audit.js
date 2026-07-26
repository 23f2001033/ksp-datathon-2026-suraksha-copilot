'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Append-only, hash-chained audit log.
 *
 * Every question — the prompt, the tier chosen, the exact SQL run, the row
 * count, the officer, their role, and the timestamp — is recorded and chained
 * by SHA-256 so any tampering breaks the chain. This is the deliberate opposite
 * of AI tools (e.g. Axon Draft One) that discard their inputs and defy audit:
 * here, provenance is a first-class, court-oriented artifact.
 *
 * Sink is pluggable. Locally and in the demo we append JSONL to a file; on
 * Catalyst this is where a Data Store table adapter slots in (see writeEntry).
 */

const LOG_PATH =
  process.env.AUDIT_LOG_PATH ||
  path.join(process.env.CATALYST_FUNCTIONS ? '/tmp' : process.cwd(), 'audit-log.jsonl');

const GENESIS = '0'.repeat(64);

let lastHash = null;

function computeHash(prevHash, entry) {
  const material = prevHash + JSON.stringify(entry);
  return crypto.createHash('sha256').update(material).digest('hex');
}

function readLastHash() {
  if (lastHash !== null) return lastHash;
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8').trim();
    if (!raw) {
      lastHash = GENESIS;
      return lastHash;
    }
    const lines = raw.split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    lastHash = last.hash || GENESIS;
  } catch {
    lastHash = GENESIS;
  }
  return lastHash;
}

/**
 * Record one audited action. `record` is the payload (prompt, sql, tier, etc.);
 * we add the chain metadata. Never throws into the request path — audit failure
 * is logged but does not block the officer's answer.
 */
function record(payload) {
  try {
    const prev = readLastHash();
    const entry = {
      ts: new Date().toISOString(),
      prev_hash: prev,
      ...payload,
    };
    const hash = computeHash(prev, entry);
    const line = JSON.stringify({ ...entry, hash });
    writeEntry(line);
    lastHash = hash;
    return { hash, prev_hash: prev };
  } catch (err) {
    // Do not fail the user's request because auditing hiccuped; surface it in logs.
    console.error('[audit] failed to record entry:', err.message);
    return null;
  }
}

function writeEntry(line) {
  // Local / demo sink. Replace with a Catalyst Data Store insert for production
  // durability (table AuditLog: ts, prev_hash, hash, user_id, role, tier, sql, ...).
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
}

/** Verify the whole chain is intact (used by the /audit/verify endpoint). */
function verifyChain() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8').trim();
  } catch {
    return { ok: true, count: 0, message: 'No audit entries yet.' };
  }
  if (!raw) return { ok: true, count: 0, message: 'No audit entries yet.' };

  const lines = raw.split('\n');
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]);
    const { hash, ...entry } = obj;
    if (entry.prev_hash !== prev) {
      return { ok: false, count: lines.length, brokenAt: i, message: 'prev_hash mismatch' };
    }
    if (computeHash(prev, entry) !== hash) {
      return { ok: false, count: lines.length, brokenAt: i, message: 'hash mismatch — entry altered' };
    }
    prev = hash;
  }
  return { ok: true, count: lines.length, headHash: prev, message: 'Audit chain intact.' };
}

function recentEntries(limit = 50) {
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { record, verifyChain, recentEntries, LOG_PATH };
