'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * Read-only data access over the KSP crime database.
 *
 * We use sql.js (SQLite compiled to WebAssembly) so there is no native module
 * to compile — the same code runs locally and inside a Zoho Catalyst Node
 * function. The reference crime data is read-only, so loading the bundled
 * crime.db into memory at cold start is both simple and safe: generated queries
 * physically cannot mutate it.
 *
 * A production deployment would point this adapter at Catalyst Data Store /
 * ZCQL or the live CCTNS schema; the rest of the engine is unchanged.
 */

const DB_PATH = process.env.SURAKSHA_DB_PATH || path.join(__dirname, '..', 'data', 'crime.db');

let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const distDir = path.dirname(require.resolve('sql.js'));
      const SQL = await initSqlJs({ locateFile: (file) => path.join(distDir, file) });
      if (!fs.existsSync(DB_PATH)) {
        throw new Error(
          `Crime database not found at ${DB_PATH}. Run "npm run seed" first.`
        );
      }
      const buffer = fs.readFileSync(DB_PATH);
      return new SQL.Database(buffer);
    })();
  }
  return dbPromise;
}

/**
 * Execute a read-only SELECT and return { columns, rows }. Rows are plain
 * objects keyed by column name. Throws on SQL error (the engine catches this
 * for its Tier-2 self-repair loop).
 */
async function query(sql) {
  const db = await getDb();
  const result = db.exec(sql); // [] for empty result sets
  if (!result.length) return { columns: [], rows: [] };
  const { columns, values } = result[0];
  const rows = values.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  );
  return { columns, rows };
}

module.exports = { getDb, query, DB_PATH };
