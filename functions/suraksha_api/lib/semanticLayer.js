'use strict';

/**
 * The semantic layer is the curated contract the LLM writes SQL against.
 * It is deliberately small and richly documented — the #1 cause of wrong
 * text-to-SQL is schema misinterpretation, so we never hand the model the raw
 * catalog. Guardrails allow-list exactly the tables/columns named here.
 */

const TABLES = {
  fir: {
    description:
      'One row per First Information Report. The central fact table. Every crime incident is an FIR.',
    columns: {
      fir_id: 'Integer primary key.',
      fir_number: 'Human-readable FIR number, e.g. "BLR-CEN-0142/2025".',
      station_id: 'Police station that registered the FIR. Joins police_station.station_id.',
      district: 'Karnataka district the FIR belongs to (denormalized for fast filtering).',
      crime_type:
        'Category of crime. One of: Chain Snatching, House Burglary, Theft, Motor Vehicle Theft, Cybercrime, Assault, Robbery, Cheating, Drugs (NDPS), Missing Person.',
      crime_head: 'Legal section invoked, e.g. "BNS 303" / "IPC 379". Free text.',
      reported_date: 'ISO date (YYYY-MM-DD) the FIR was registered.',
      occurrence_date: 'ISO date (YYYY-MM-DD) the crime is believed to have occurred.',
      status:
        'Investigation status. One of: Under Investigation, Charge Sheeted, Closed, FR Filed.',
      area: 'Neighbourhood / locality name within the district.',
      area_profile:
        'Character of the incident location. One of: Residential, Commercial, IT Corridor, Market, Highway, Slum. Use for socio-economic correlation.',
      lat: 'Latitude of the incident (decimal degrees).',
      lon: 'Longitude of the incident (decimal degrees).',
      occurrence_hour: 'Hour of day the crime occurred (integer 0-23). Use for temporal / day-vs-night patterns.',
      victim_gender: 'Victim gender: Male, Female, Other, or Unknown.',
      victim_age: 'Victim age in years (integer).',
      victim_profession:
        'Victim occupation. One of: Student, IT Professional, Daily Wage, Business, Homemaker, Senior Citizen, Government, Unemployed, Driver, Skilled Worker. Use for socio-demographic insights.',
      property_value: 'Approximate value of property involved, in INR. 0 when not applicable.',
    },
  },
  accused: {
    description:
      'One row per accused person. Names are dirty and transliterated — the same real person may appear as several rows; normalized_name is a best-effort dedup key, never authoritative.',
    columns: {
      accused_id: 'Integer primary key.',
      name: 'Name as recorded (transliteration varies).',
      normalized_name: 'Lowercased, phonetically-normalized name for approximate matching only.',
      age: 'Age in years, or NULL if unknown.',
      gender: 'Male, Female, Other, or Unknown.',
      profession: 'Accused occupation (e.g. Unemployed, Daily Wage, Driver, Business, Student, Skilled Worker).',
      address: 'Recorded address (free text, often incomplete).',
      station_id: 'Station that recorded the accused. Joins police_station.station_id.',
      district: 'District (denormalized) the accused was booked in.',
    },
  },
  fir_accused: {
    description: 'Link table joining FIRs to accused persons (many-to-many).',
    columns: {
      fir_id: 'Joins fir.fir_id.',
      accused_id: 'Joins accused.accused_id.',
    },
  },
  police_station: {
    description: 'Reference table of police stations. Not scoped by role (public metadata).',
    columns: {
      station_id: 'Integer primary key.',
      name: 'Station name, e.g. "Cubbon Park PS".',
      district: 'District the station is in.',
      city: 'City the station is in.',
      lat: 'Latitude of the station.',
      lon: 'Longitude of the station.',
    },
  },
};

// Tables an investigator's query is allowed to touch. Anything else is rejected
// by the guardrails before execution.
const ALLOWED_TABLES = Object.keys(TABLES);

// Tables that carry a `district` and `station_id` column and are therefore
// scoped by role-based row-level security. police_station is reference data and
// is never scoped.
const SCOPED_TABLES = ['fir', 'accused'];

const CRIME_TYPES = [
  'Chain Snatching',
  'House Burglary',
  'Theft',
  'Motor Vehicle Theft',
  'Cybercrime',
  'Assault',
  'Robbery',
  'Cheating',
  'Drugs (NDPS)',
  'Missing Person',
];

const DISTRICTS = [
  'Bengaluru City',
  'Bengaluru Rural',
  'Mysuru',
  'Mangaluru',
  'Hubballi-Dharwad',
  'Belagavi',
  'Kalaburagi',
  'Tumakuru',
  'Shivamogga',
  'Ballari',
];

const STATUSES = ['Under Investigation', 'Charge Sheeted', 'Closed', 'FR Filed'];

const AREA_PROFILES = ['Residential', 'Commercial', 'IT Corridor', 'Market', 'Highway', 'Slum'];

const VICTIM_PROFESSIONS = [
  'Student', 'IT Professional', 'Daily Wage', 'Business', 'Homemaker',
  'Senior Citizen', 'Government', 'Unemployed', 'Driver', 'Skilled Worker',
];

/**
 * Glossary maps the words investigators actually use — English colloquialisms
 * and Kannada terms — onto canonical crime_type values. Fed to the LLM and used
 * for light client-side normalization.
 */
const GLOSSARY = {
  'chain snatching': 'Chain Snatching',
  'ಚೈನ್ ಸ್ನ್ಯಾಚಿಂಗ್': 'Chain Snatching',
  'chain-snatching': 'Chain Snatching',
  burglary: 'House Burglary',
  'ಮನೆ ಕಳ್ಳತನ': 'House Burglary',
  housebreaking: 'House Burglary',
  theft: 'Theft',
  'ಕಳ್ಳತನ': 'Theft',
  'vehicle theft': 'Motor Vehicle Theft',
  'bike theft': 'Motor Vehicle Theft',
  'car theft': 'Motor Vehicle Theft',
  'ವಾಹನ ಕಳ್ಳತನ': 'Motor Vehicle Theft',
  cyber: 'Cybercrime',
  'cyber crime': 'Cybercrime',
  'online fraud': 'Cybercrime',
  'ಸೈಬರ್ ಅಪರಾಧ': 'Cybercrime',
  assault: 'Assault',
  'ಹಲ್ಲೆ': 'Assault',
  robbery: 'Robbery',
  'ದರೋಡೆ': 'Robbery',
  cheating: 'Cheating',
  fraud: 'Cheating',
  'ಮೋಸ': 'Cheating',
  drugs: 'Drugs (NDPS)',
  ndps: 'Drugs (NDPS)',
  narcotics: 'Drugs (NDPS)',
  missing: 'Missing Person',
  'missing person': 'Missing Person',
  'ಕಾಣೆಯಾದ ವ್ಯಕ್ತಿ': 'Missing Person',
};

/**
 * Compact schema description injected into the LLM prompt for Tier 2 generative
 * SQL. Kept terse but complete — this is the model's entire view of the data.
 */
function schemaPrompt() {
  const lines = [];
  for (const [table, def] of Object.entries(TABLES)) {
    lines.push(`TABLE ${table} — ${def.description}`);
    for (const [col, desc] of Object.entries(def.columns)) {
      lines.push(`  ${col}: ${desc}`);
    }
    lines.push('');
  }
  lines.push(`Enumerations:`);
  lines.push(`  crime_type ∈ {${CRIME_TYPES.join(', ')}}`);
  lines.push(`  status ∈ {${STATUSES.join(', ')}}`);
  lines.push(`  district ∈ {${DISTRICTS.join(', ')}}`);
  lines.push(`  area_profile ∈ {${AREA_PROFILES.join(', ')}}`);
  lines.push(`  victim_profession / accused.profession ∈ {${VICTIM_PROFESSIONS.join(', ')}}`);
  return lines.join('\n');
}

function canonicalCrimeType(text) {
  if (!text) return null;
  const key = String(text).trim().toLowerCase();
  if (GLOSSARY[key]) return GLOSSARY[key];
  // Also try the original (Kannada keys are case-sensitive in the map).
  if (GLOSSARY[text]) return GLOSSARY[text];
  const hit = CRIME_TYPES.find((c) => c.toLowerCase() === key);
  return hit || null;
}

module.exports = {
  TABLES,
  ALLOWED_TABLES,
  SCOPED_TABLES,
  CRIME_TYPES,
  DISTRICTS,
  STATUSES,
  AREA_PROFILES,
  VICTIM_PROFESSIONS,
  GLOSSARY,
  schemaPrompt,
  canonicalCrimeType,
};
