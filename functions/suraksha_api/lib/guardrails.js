'use strict';

const { ALLOWED_TABLES, SCOPED_TABLES } = require('./semanticLayer');

/**
 * SQL guardrails. Every query — whether from a hand-verified Tier-1 template or
 * from Tier-2 generative SQL — passes through here before it touches the
 * database. The engine runs against a read-only DB connection as defence in
 * depth; these checks are the primary boundary.
 *
 * Responsibilities:
 *   1. Reject anything that is not a single read-only SELECT.
 *   2. Reject references to tables outside the semantic layer's allow-list.
 *   3. Inject the caller's role-based row-level-security predicate.
 *   4. Cap the result size with a LIMIT.
 *
 * NOTE: this is a lexical guard sufficient for the prototype. Production should
 * parse to an AST (e.g. node-sql-parser) and enforce on the parse tree.
 */

const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace',
  'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'truncate',
  'grant', 'revoke', 'commit', 'rollback', 'savepoint',
];

// Reserved words that must not be mistaken for a table alias during scope
// injection (e.g. "FROM fir WHERE" — WHERE is not an alias).
const NOT_AN_ALIAS = new Set([
  'where', 'group', 'order', 'limit', 'join', 'on', 'left', 'right', 'inner',
  'outer', 'cross', 'union', 'having', 'as', 'using', 'natural', 'and', 'or',
]);

class GuardrailError extends Error {}

function enforce(sql, { user, scopePredicate, maxRows = 500 } = {}) {
  if (!sql || typeof sql !== 'string') {
    throw new GuardrailError('Empty query.');
  }

  let q = sql.trim().replace(/;+\s*$/, ''); // strip trailing semicolons

  if (q.includes(';')) {
    throw new GuardrailError('Multiple statements are not allowed.');
  }

  const lower = q.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) {
    throw new GuardrailError('Only SELECT queries are allowed.');
  }

  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(q)) {
      throw new GuardrailError(`Disallowed keyword: ${kw}.`);
    }
  }

  // Every table referenced after FROM/JOIN must be in the allow-list.
  const referenced = new Set();
  const refRe = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = refRe.exec(q)) !== null) referenced.add(m[1].toLowerCase());
  for (const t of referenced) {
    if (!ALLOWED_TABLES.includes(t)) {
      throw new GuardrailError(`Unknown or disallowed table: ${t}.`);
    }
  }

  // Inject row-level-security scope on scoped tables. One replace pass over the
  // original string; inserted subqueries are not re-scanned by String.replace,
  // so the wrapper's own inner "FROM fir" is safe from double-wrapping.
  if (scopePredicate && scopePredicate !== '1=1') {
    const tablesAlt = SCOPED_TABLES.join('|');
    const scopeRe = new RegExp(
      `\\b(from|join)\\s+(${tablesAlt})\\b(\\s+(?:as\\s+)?([a-z_][a-z0-9_]*))?`,
      'gi'
    );
    q = q.replace(scopeRe, (full, kw, table, aliasClause, aliasName) => {
      const isRealAlias = aliasName && !NOT_AN_ALIAS.has(aliasName.toLowerCase());
      const alias = isRealAlias ? aliasName : table;
      // If the token after the table was actually a keyword (WHERE/GROUP/...),
      // the regex consumed it — re-append it so it isn't dropped.
      const tail = isRealAlias ? '' : aliasClause || '';
      return `${kw} (SELECT * FROM ${table} WHERE ${scopePredicate}) ${alias}${tail}`;
    });
  }

  // Enforce a hard row cap.
  if (!/\blimit\s+\d+/i.test(q)) {
    q = `${q} LIMIT ${maxRows}`;
  }

  return q;
}

module.exports = { enforce, GuardrailError };
