'use strict';

/**
 * Role-based access control. Roles are the KSP hierarchy; each maps to a data
 * scope enforced as a row-level-security predicate injected into every query.
 * Scope is a legal boundary, not just UX — an SP cannot see another district's
 * FIRs, an IO cannot see another station's.
 */

const ROLES = {
  DGP: {
    label: 'DGP / State CID',
    scope: 'state',
    description: 'State-wide access to all districts and stations.',
  },
  SP: {
    label: 'Superintendent of Police (District)',
    scope: 'district',
    description: 'Access limited to the officer\'s district.',
  },
  IO: {
    label: 'Investigating Officer (Station)',
    scope: 'station',
    description: 'Access limited to the officer\'s own police station.',
  },
};

/**
 * Demo user directory. In production this comes from KSP's identity provider;
 * the shape (role + district/station binding) is what matters.
 */
const USERS = {
  'dgp.state': { id: 'dgp.state', name: 'DGP Control Room', role: 'DGP', district: null, station_id: null },
  'sp.blr': { id: 'sp.blr', name: 'SP Bengaluru City', role: 'SP', district: 'Bengaluru City', station_id: null },
  'sp.mysuru': { id: 'sp.mysuru', name: 'SP Mysuru', role: 'SP', district: 'Mysuru', station_id: null },
  'io.cubbon': { id: 'io.cubbon', name: 'IO Cubbon Park PS', role: 'IO', district: 'Bengaluru City', station_id: 1 },
};

function getUser(userId) {
  return USERS[userId] || null;
}

/**
 * The row-level-security predicate for a user, applied to scoped tables
 * (fir, accused). Returned as a SQL boolean expression referencing columns that
 * exist on those tables. Values are string-escaped; station_id is numeric.
 */
function scopePredicate(user) {
  if (!user) return '1=0'; // unknown user sees nothing
  switch (user.role) {
    case 'DGP':
      return '1=1';
    case 'SP':
      return `district = '${sqlEscape(user.district)}'`;
    case 'IO':
      return `station_id = ${Number(user.station_id)}`;
    default:
      return '1=0';
  }
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = { ROLES, USERS, getUser, scopePredicate, sqlEscape };
