'use strict';

/**
 * Generates a synthetic-but-realistic Karnataka crime database (crime.db) for
 * the prototype. Deterministic (seeded RNG) so runs are reproducible.
 *
 * The data intentionally includes dirty, transliteration-variant accused names
 * and shared offenders across FIRs, so the repeat-offender / network features
 * (and the future entity-resolution layer) have something real to work on.
 *
 * Uses sql.js (no native build) resolved from the function's node_modules.
 */

const fs = require('fs');
const path = require('path');

const FN_DIR = path.join(__dirname, '..', 'functions', 'suraksha_api');
const sqlJsMain = require.resolve('sql.js', { paths: [path.join(FN_DIR, 'node_modules')] });
const initSqlJs = require(sqlJsMain);
const sqlJsDist = path.dirname(sqlJsMain);

const OUT = path.join(FN_DIR, 'data', 'crime.db');

// ---- deterministic RNG ------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260716);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [val, w] of pairs) {
    if ((r -= w) <= 0) return val;
  }
  return pairs[0][0];
};
const jitter = (v, amt) => v + (rand() - 0.5) * amt;

// ---- reference data ---------------------------------------------------------
const DISTRICTS = [
  { name: 'Bengaluru City', code: 'BLR', lat: 12.9716, lon: 77.5946 },
  { name: 'Bengaluru Rural', code: 'BLU', lat: 13.2000, lon: 77.6000 },
  { name: 'Mysuru', code: 'MYS', lat: 12.2958, lon: 76.6394 },
  { name: 'Mangaluru', code: 'MNG', lat: 12.9141, lon: 74.8560 },
  { name: 'Hubballi-Dharwad', code: 'HBL', lat: 15.3647, lon: 75.1240 },
  { name: 'Belagavi', code: 'BGM', lat: 15.8497, lon: 74.4977 },
  { name: 'Kalaburagi', code: 'KLB', lat: 17.3297, lon: 76.8343 },
  { name: 'Tumakuru', code: 'TMK', lat: 13.3379, lon: 77.1173 },
  { name: 'Shivamogga', code: 'SMG', lat: 13.9299, lon: 75.5681 },
  { name: 'Ballari', code: 'BLY', lat: 15.1394, lon: 76.9214 },
];

const STATION_WORDS = ['Central', 'North', 'South', 'East', 'West', 'Market', 'City', 'Cantonment', 'Town', 'Nagar'];
const AREA_WORDS = ['Layout', 'Nagar', 'Extension', 'Circle', 'Cross', 'Colony', 'Puram', 'Gate', 'Palya', 'Road'];
const AREA_PREFIX = ['Jaya', 'Vijaya', 'Rajaji', 'Gandhi', 'Basava', 'Kempe', 'Shanti', 'Vidya', 'Hosur', 'Malleshwar', 'Indira', 'Sampige'];

const CRIME_TYPES = [
  ['Theft', 22, 'BNS 303 / IPC 379'],
  ['Motor Vehicle Theft', 14, 'BNS 303(2)'],
  ['House Burglary', 12, 'BNS 305 / IPC 457'],
  ['Chain Snatching', 10, 'BNS 304'],
  ['Cybercrime', 13, 'IT Act 66C / BNS 319'],
  ['Assault', 9, 'BNS 115 / IPC 324'],
  ['Cheating', 8, 'BNS 318 / IPC 420'],
  ['Robbery', 5, 'BNS 309 / IPC 392'],
  ['Drugs (NDPS)', 4, 'NDPS 20'],
  ['Missing Person', 3, 'Missing (Sec 174 CrPC)'],
];
const STATUSES = [
  ['Under Investigation', 40],
  ['Charge Sheeted', 34],
  ['Closed', 16],
  ['FR Filed', 10],
];

// ---- socio-demographic reference data (mirrors real KSP/Kaggle FIR fields) --
// Values are deliberately CORRELATED with crime type / area so the analytics
// tell a real story (chain-snatching in commercial areas at dusk; cybercrime
// hitting IT professionals across areas) rather than uniform noise.

const AREA_PROFILES = ['Residential', 'Commercial', 'IT Corridor', 'Market', 'Highway', 'Slum'];
const PROFESSIONS = [
  'Student', 'IT Professional', 'Daily Wage', 'Business', 'Homemaker',
  'Senior Citizen', 'Government', 'Unemployed', 'Driver', 'Skilled Worker',
];

const AREA_PROFILE_W = {
  'Chain Snatching': [['Commercial', 40], ['Market', 30], ['Residential', 15], ['Highway', 10], ['IT Corridor', 5]],
  'House Burglary': [['Residential', 70], ['Slum', 15], ['Commercial', 15]],
  'Theft': [['Market', 30], ['Commercial', 30], ['Residential', 25], ['Slum', 15]],
  'Motor Vehicle Theft': [['Commercial', 35], ['Market', 30], ['Residential', 20], ['Highway', 15]],
  'Cybercrime': [['IT Corridor', 45], ['Residential', 35], ['Commercial', 20]],
  'Assault': [['Slum', 30], ['Residential', 30], ['Market', 25], ['Highway', 15]],
  'Robbery': [['Highway', 35], ['Commercial', 30], ['Market', 20], ['Slum', 15]],
  'Cheating': [['Commercial', 40], ['Residential', 35], ['IT Corridor', 25]],
  'Drugs (NDPS)': [['Slum', 40], ['Highway', 25], ['Commercial', 20], ['Residential', 15]],
  'Missing Person': [['Residential', 50], ['Slum', 25], ['Market', 25]],
  default: [['Residential', 35], ['Commercial', 25], ['Market', 20], ['Slum', 10], ['Highway', 5], ['IT Corridor', 5]],
};

// Per-crime hour-of-day windows: [loHour, hiHour, weight].
const HOUR_PROFILE = {
  'Chain Snatching': [[17, 22, 55], [6, 11, 20], [11, 17, 15], [22, 24, 10]],
  'Motor Vehicle Theft': [[22, 24, 35], [0, 5, 35], [18, 22, 20], [5, 18, 10]],
  'House Burglary': [[10, 17, 60], [6, 10, 15], [17, 22, 15], [22, 24, 10]],
  'Robbery': [[20, 24, 40], [0, 3, 30], [17, 20, 20], [3, 17, 10]],
  'Assault': [[18, 24, 50], [12, 18, 25], [0, 6, 15], [6, 12, 10]],
  'Cybercrime': [[9, 20, 75], [20, 24, 15], [0, 9, 10]],
  default: [[0, 24, 100]],
};

const VICTIM_PROF_W = {
  'Cybercrime': [['IT Professional', 40], ['Business', 20], ['Government', 15], ['Senior Citizen', 15], ['Student', 10]],
  'Chain Snatching': [['Homemaker', 30], ['Senior Citizen', 25], ['Business', 20], ['Student', 15], ['Government', 10]],
  'House Burglary': [['Business', 30], ['Homemaker', 25], ['Government', 25], ['IT Professional', 20]],
  'Theft': [['Student', 25], ['Daily Wage', 25], ['Homemaker', 20], ['Business', 15], ['IT Professional', 15]],
  'Cheating': [['Business', 35], ['IT Professional', 25], ['Senior Citizen', 20], ['Government', 20]],
  default: [['Business', 20], ['Student', 20], ['Homemaker', 18], ['Daily Wage', 17], ['Government', 13], ['Senior Citizen', 12]],
};

const ACCUSED_PROF_W = [
  ['Unemployed', 28], ['Daily Wage', 24], ['Driver', 14], ['Skilled Worker', 12], ['Business', 10], ['Student', 12],
];

const AGE_BAND = {
  Student: [16, 25], 'IT Professional': [24, 40], Homemaker: [28, 55], 'Senior Citizen': [60, 82],
  'Daily Wage': [20, 50], Business: [30, 60], Government: [30, 58], Unemployed: [18, 40],
  Driver: [22, 52], 'Skilled Worker': [22, 50],
};

function areaProfileFor(crime) {
  return weighted(AREA_PROFILE_W[crime] || AREA_PROFILE_W.default);
}
function hourFor(crime) {
  const prof = HOUR_PROFILE[crime] || HOUR_PROFILE.default;
  const [lo, hi] = weighted(prof.map((p) => [[p[0], p[1]], p[2]]));
  return lo + Math.floor(rand() * (hi - lo));
}
function victimProfessionFor(crime) {
  return weighted(VICTIM_PROF_W[crime] || VICTIM_PROF_W.default);
}
function ageFor(prof) {
  const [lo, hi] = AGE_BAND[prof] || [20, 55];
  return lo + Math.floor(rand() * (hi - lo));
}

// Base names + transliteration variants → dirty data on purpose.
const NAME_BASES = [
  ['Shivakumar', 'Sivakumar', 'Shiva Kumar'],
  ['Ramesh', 'Rammesh'],
  ['Manjunath', 'Manjunatha', 'Manju Nath'],
  ['Lakshmi', 'Laxmi'],
  ['Praveen', 'Pravin'],
  ['Suresh', 'Sureesh'],
  ['Naveen', 'Navin'],
  ['Girish', 'Gireesh'],
  ['Chandru', 'Chandra'],
  ['Basavaraj', 'Basavaraju', 'Basava Raj'],
  ['Fayaz', 'Fayyaz'],
  ['Imran', 'Imraan'],
  ['Santosh', 'Santhosh'],
  ['Vinod', 'Vinodh'],
  ['Prakash', 'Prakaash'],
];
const SURNAMES = ['Gowda', 'Reddy', 'Hegde', 'Naik', 'Rao', 'Shetty', 'Patil', 'Kumar', 'Swamy', 'Sab'];

function nameVariant() {
  const base = pick(NAME_BASES);
  const given = pick(base);
  return `${given} ${pick(SURNAMES)}`;
}
function normalizeName(n) {
  return n.toLowerCase().replace(/[^a-z]/g, '');
}

// ---- build DB ---------------------------------------------------------------
(async () => {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(sqlJsDist, f) });
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE police_station (
      station_id INTEGER PRIMARY KEY, name TEXT, district TEXT, city TEXT, lat REAL, lon REAL
    );
    CREATE TABLE fir (
      fir_id INTEGER PRIMARY KEY, fir_number TEXT, station_id INTEGER, district TEXT,
      crime_type TEXT, crime_head TEXT, reported_date TEXT, occurrence_date TEXT,
      status TEXT, area TEXT, area_profile TEXT, lat REAL, lon REAL, occurrence_hour INTEGER,
      victim_gender TEXT, victim_age INTEGER, victim_profession TEXT, property_value INTEGER
    );
    CREATE TABLE accused (
      accused_id INTEGER PRIMARY KEY, name TEXT, normalized_name TEXT, age INTEGER,
      gender TEXT, profession TEXT, address TEXT, station_id INTEGER, district TEXT
    );
    CREATE TABLE fir_accused (fir_id INTEGER, accused_id INTEGER);
    CREATE INDEX idx_fir_district ON fir(district);
    CREATE INDEX idx_fir_type ON fir(crime_type);
    CREATE INDEX idx_fir_occ ON fir(occurrence_date);
    CREATE INDEX idx_fir_areaprofile ON fir(area_profile);
    CREATE INDEX idx_acc_district ON accused(district);
    CREATE INDEX idx_fa_acc ON fir_accused(accused_id);
  `);

  // Stations
  const stations = [];
  let stationId = 0;
  for (const d of DISTRICTS) {
    const count = 3 + Math.floor(rand() * 4);
    const usedCodes = new Set();
    for (let i = 0; i < count; i++) {
      stationId++;
      const word = STATION_WORDS[i % STATION_WORDS.length];
      let code = word.slice(0, 3).toUpperCase();
      while (usedCodes.has(code)) code = code + i;
      usedCodes.add(code);
      const st = {
        station_id: stationId,
        name: `${word} PS, ${d.name.split(' ')[0]}`,
        district: d.name,
        city: d.name.split('-')[0],
        code,
        d,
        lat: jitter(d.lat, 0.08),
        lon: jitter(d.lon, 0.08),
        seq: 0,
      };
      stations.push(st);
      db.run('INSERT INTO police_station VALUES (?,?,?,?,?,?)', [
        st.station_id, st.name, st.district, st.city, st.lat, st.lon,
      ]);
    }
  }

  // Accused pool (some will become repeat offenders)
  const accused = [];
  const ACCUSED_COUNT = 1400;
  for (let i = 1; i <= ACCUSED_COUNT; i++) {
    const st = pick(stations);
    const name = nameVariant();
    const a = {
      accused_id: i,
      name,
      normalized_name: normalizeName(name),
      age: 18 + Math.floor(rand() * 45),
      gender: weighted([['Male', 88], ['Female', 12]]),
      profession: weighted(ACCUSED_PROF_W),
      address: `${pick(AREA_PREFIX)} ${pick(AREA_WORDS)}, ${st.district}`,
      station_id: st.station_id,
      district: st.district,
    };
    accused.push(a);
    db.run('INSERT INTO accused VALUES (?,?,?,?,?,?,?,?,?)', [
      a.accused_id, a.name, a.normalized_name, a.age, a.gender, a.profession, a.address, a.station_id, a.district,
    ]);
  }
  // Designate ~8% as habitual offenders who recur across FIRs.
  const habitual = accused.filter(() => rand() < 0.08);

  // FIRs + links
  const now = Date.now();
  const DAY = 86400000;
  const FIR_COUNT = 3200;
  const yearOf = (ts) => new Date(ts).getUTCFullYear();
  const iso = (ts) => new Date(ts).toISOString().slice(0, 10);
  const crimePairs = CRIME_TYPES.map(([t, w]) => [t, w]);
  const crimeHead = Object.fromEntries(CRIME_TYPES.map(([t, , h]) => [t, h]));

  for (let i = 1; i <= FIR_COUNT; i++) {
    const st = pick(stations);
    st.seq++;
    const crime_type = weighted(crimePairs);
    const daysAgo = Math.floor(rand() * 540);
    const occTs = now - daysAgo * DAY;
    const repTs = occTs + Math.floor(rand() * 3) * DAY;
    const area = `${pick(AREA_PREFIX)} ${pick(AREA_WORDS)}`;
    const area_profile = areaProfileFor(crime_type);
    const occurrence_hour = hourFor(crime_type);
    const victim_profession = victimProfessionFor(crime_type);
    const victim_age = ageFor(victim_profession);
    const propValue = ['Cybercrime', 'Cheating', 'Robbery', 'House Burglary', 'Motor Vehicle Theft'].includes(crime_type)
      ? Math.floor(2000 + rand() * 400000)
      : Math.floor(rand() * 20000);

    const fir_number = `${st.d.code}-${st.code}-${String(st.seq).padStart(4, '0')}/${yearOf(occTs)}`;
    db.run('INSERT INTO fir VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      i, fir_number, st.station_id, st.district, crime_type, crimeHead[crime_type],
      iso(repTs), iso(occTs), weighted(STATUSES), area, area_profile,
      jitter(st.lat, 0.05), jitter(st.lon, 0.05), occurrence_hour,
      weighted([['Male', 45], ['Female', 40], ['Unknown', 15]]), victim_age, victim_profession, propValue,
    ]);

    // Link accused: prefer same-district accused; occasionally reuse a habitual one.
    const nAcc = weighted([[0, 25], [1, 45], [2, 22], [3, 8]]);
    const linked = new Set();
    for (let k = 0; k < nAcc; k++) {
      let a;
      if (habitual.length && rand() < 0.35) {
        a = pick(habitual);
      } else {
        // same district if possible
        const pool = accused.filter((x) => x.district === st.district);
        a = pool.length ? pick(pool) : pick(accused);
      }
      if (linked.has(a.accused_id)) continue;
      linked.add(a.accused_id);
      db.run('INSERT INTO fir_accused VALUES (?,?)', [i, a.accused_id]);
    }
  }

  // Export
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const bytes = Buffer.from(db.export());
  fs.writeFileSync(OUT, bytes);

  // Report a few real FIR numbers for demos.
  const sampleFirs = db.exec('SELECT fir_number FROM fir ORDER BY RANDOM() LIMIT 3');
  const nums = sampleFirs.length ? sampleFirs[0].values.map((r) => r[0]) : [];
  const counts = db.exec('SELECT COUNT(*) FROM fir')[0].values[0][0];
  const accCount = db.exec('SELECT COUNT(*) FROM accused')[0].values[0][0];
  db.close();

  console.log(`Seeded crime.db → ${OUT}`);
  console.log(`  ${counts} FIRs, ${accCount} accused, ${stations.length} stations, ${DISTRICTS.length} districts.`);
  console.log(`  Enriched: victim age/profession, area_profile, occurrence_hour, accused profession.`);
  console.log(`  Sample FIR numbers for case_lookup demo: ${nums.join(', ')}`);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
