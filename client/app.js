'use strict';

// API base: same-origin '' works on the local dev server (routes mounted at
// root). On Catalyst, Slate (this static site) and the Serverless function
// live on DIFFERENT subdomains — not the same origin — so production needs an
// absolute URL. Get this from the function's "Invocation URL" in the Catalyst
// console (Serverless > Functions > suraksha_api) if it ever changes, e.g.
// after promoting from Development to Production. No trailing slash — every
// call below does `${API_BASE}/path`.
const CATALYST_FUNCTION_URL = 'https://suraksha-copilot-60076286960.development.catalystserverless.in/server/suraksha_api';
const API_BASE =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? ''
    : CATALYST_FUNCTION_URL;

const $ = (sel) => document.querySelector(sel);
const feed = $('#feed');
const userSelect = $('#userSelect');

let META = null;
let USERS = [];
// Conversation context: last few answered turns (question + resolved intent +
// slots) echoed back to the API so follow-ups like "and in Mysuru?" resolve.
let convo = [];

// ---------- helpers ----------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function currentUser() {
  return USERS.find((u) => u.id === userSelect.value);
}
function scopeLabel(u) {
  if (!u) return '';
  if (u.role === 'DGP') return 'State-wide access (all districts)';
  if (u.role === 'SP') return `District access — <b>${esc(u.district)}</b>`;
  return `Station access — <b>station #${esc(u.station_id)}</b> (${esc(u.district)})`;
}
function columnsOf(rows) {
  return rows.length ? Object.keys(rows[0]) : [];
}
function numericCols(rows) {
  return columnsOf(rows).filter((k) => rows.every((r) => typeof r[k] === 'number'));
}
function pickValueCol(rows) {
  const nums = numericCols(rows).filter((c) => c !== 'lat' && c !== 'lon');
  const pref = ['incidents', 'firs', 'case_count', 'total_firs', 'count'];
  for (const p of pref) if (nums.includes(p)) return p;
  return nums[0];
}
function pickLabelCol(rows, valueCol) {
  const cols = columnsOf(rows);
  return (
    cols.find((k) => k !== valueCol && typeof rows[0][k] !== 'number') ||
    cols.find((k) => k !== valueCol) ||
    cols[0]
  );
}

// ---------- charts (self-contained, no external libs) ------------------------
function barChart(rows) {
  const valueCol = pickValueCol(rows);
  const labelCol = pickLabelCol(rows, valueCol);
  const top = rows.slice(0, 12);
  const max = Math.max(...top.map((r) => r[valueCol] || 0), 1);
  const wrap = el('<div class="chart"></div>');
  for (const r of top) {
    const v = r[valueCol] || 0;
    const frac = v / max;
    const pct = frac * 100;
    // Fill color intensity encodes quantity too (not just bar length) — same
    // single-hue sequential ramp as the choropleth, so "more" always reads as
    // "darker blue" consistently across the whole app.
    const row = el(`
      <div class="bar-row" title="${esc(r[labelCol])}: ${esc(v)}">
        <span class="lbl">${esc(r[labelCol])}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${lerpBlue(0.25 + frac * 0.75)}"></span></span>
        <span class="val">${esc(v)}</span>
      </div>`);
    wrap.appendChild(row);
  }
  return wrap;
}

function lineChart(rows) {
  const valueCol = pickValueCol(rows);
  const labelCol = pickLabelCol(rows, valueCol) || 'month';
  const W = 620, H = 220, padL = 34, padR = 12, padT = 14, padB = 26;
  const xs = rows.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(rows.length - 1, 1));
  const max = Math.max(...rows.map((r) => r[valueCol] || 0), 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const pts = rows.map((r, i) => `${xs[i].toFixed(1)},${y(r[valueCol] || 0).toFixed(1)}`);
  const area = `M${xs[0].toFixed(1)},${(H - padB).toFixed(1)} L${pts.join(' L')} L${xs[xs.length - 1].toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const grid = [0, 0.5, 1].map((f) => {
    const gv = Math.round(max * f);
    const gy = y(gv).toFixed(1);
    return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="currentColor" stroke-opacity="0.12"/>
            <text x="4" y="${(+gy + 3).toFixed(1)}" font-size="9" fill="currentColor" fill-opacity="0.5">${gv}</text>`;
  }).join('');
  const ticks = rows.map((r, i) => {
    if (rows.length > 6 && i % Math.ceil(rows.length / 6) !== 0 && i !== rows.length - 1) return '';
    return `<text x="${xs[i].toFixed(1)}" y="${H - 8}" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity="0.55">${esc(r[labelCol])}</text>`;
  }).join('');
  const dots = rows.map((r, i) =>
    `<circle cx="${xs[i].toFixed(1)}" cy="${y(r[valueCol] || 0).toFixed(1)}" r="3.5" fill="var(--ksp-blue)"><title>${esc(r[labelCol])}: ${esc(r[valueCol])}</title></circle>`
  ).join('');
  return el(`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend line chart">
    ${grid}
    <path d="${area}" fill="var(--ksp-blue)" fill-opacity="0.10"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--ksp-blue)" stroke-width="2"/>
    ${dots}${ticks}
  </svg></div>`);
}

// Each marker shows its identity (area + count) and is clickable/keyboard-
// activatable to drill down into the individual FIRs behind that bubble.
// Only the top N by incident count get a persistent text label (dataviz best
// practice: selective direct labeling, not a number crammed onto every mark) —
// every marker still carries a hover title and is fully clickable regardless.
function mapChart(rows, contextSlots) {
  const pts = rows.filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number');
  if (!pts.length) return null;
  const valueCol = pickValueCol(rows);
  const labelCol = pickLabelCol(rows, valueCol);
  const W = 620, H = 280, pad = 28;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const spanLat = maxLat - minLat || 0.01, spanLon = maxLon - minLon || 0.01;
  const maxV = Math.max(...pts.map((p) => p[valueCol] || 1), 1);
  const x = (lon) => pad + ((lon - minLon) / spanLon) * (W - 2 * pad);
  const yy = (lat) => pad + (1 - (lat - minLat) / spanLat) * (H - 2 * pad);

  const labeledIdx = new Set(
    pts
      .map((p, i) => i)
      .sort((a, b) => (pts[b][valueCol] || 0) - (pts[a][valueCol] || 0))
      .slice(0, Math.min(8, pts.length))
  );

  const markers = pts.map((p, i) => {
    const cx = x(p.lon);
    const cy = yy(p.lat);
    const r = 5 + 14 * ((p[valueCol] || 1) / maxV);
    const name = String(p[labelCol] ?? '');
    const short = name.length > 18 ? name.slice(0, 17) + '…' : name;
    const above = i % 2 === 0;
    const labelY = above ? cy - r - 6 : cy + r + 13;
    const label = labeledIdx.has(i)
      ? `<text class="map-label" x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${esc(short)} (${esc(p[valueCol])})</text>`
      : '';
    return `<g class="map-marker" data-idx="${i}" tabindex="0" role="button" aria-label="${esc(name)}: ${esc(p[valueCol])} incidents. Activate to view individual cases.">
      <circle class="map-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(name)}: ${esc(p[valueCol])} incidents — click to view cases</title></circle>
      ${label}
    </g>`;
  }).join('');

  const wrap = el(`<div class="mapwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Incident hotspot map">${markers}</svg>
    <div class="map-cap">Bubble size = incident count · click or press Enter on a marker to see the cases behind it. Top ${labeledIdx.size} labeled directly; hover any marker for the rest.</div></div>`);

  wrap.querySelectorAll('.map-marker').forEach((g) => {
    const row = pts[Number(g.dataset.idx)];
    const activate = () => drillIntoArea(row, contextSlots || {});
    g.addEventListener('click', activate);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });

  return wrap;
}

// Drill down from a hotspot marker into the individual FIRs at that locality,
// via the area_cases template — a "direct" invocation that skips free-text
// classification but still runs through guardrails, RBAC scoping, and audit
// exactly like any other question (see queryEngine.answerQuestion).
function drillIntoArea(row, contextSlots) {
  if (!row || !row.area) return;
  const district = row.district || contextSlots.district;
  const label = `Cases in ${row.area}${district ? ', ' + district : ''}`;
  ask(label, null, {
    template: 'area_cases',
    slots: {
      area: row.area,
      district,
      crime_type: contextSlots.crime_type,
      months: contextSlots.months,
    },
  });
}

// Co-accusation network: deterministic radial layout (seed center, hop-1 inner
// ring, hop-2 outer ring). Edge width = shared FIR count. No physics libs.
function networkChart(net) {
  const W = 640, H = 380, cx = W / 2, cy = H / 2;
  const seeds = net.nodes.filter((n) => n.seed);
  const hop1 = net.nodes.filter((n) => !n.seed && n.hop === 1);
  const hop2 = net.nodes.filter((n) => !n.seed && n.hop >= 2);
  const pos = new Map();

  seeds.forEach((n, i) => {
    const a = (i / Math.max(seeds.length, 1)) * 2 * Math.PI;
    pos.set(n.id, { x: cx + (seeds.length > 1 ? 26 : 0) * Math.cos(a), y: cy + (seeds.length > 1 ? 26 : 0) * Math.sin(a) });
  });
  const ring = (nodes, r) => nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * 2 * Math.PI - Math.PI / 2;
    pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  ring(hop1, 105);
  ring(hop2, 168);

  const maxShared = Math.max(...net.edges.map((e) => e.shared), 1);
  const edges = net.edges.map((e) => {
    const a = pos.get(e.a), b = pos.get(e.b);
    if (!a || !b) return '';
    const w = 1 + 3 * (e.shared / maxShared);
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
      stroke="var(--ksp-blue)" stroke-opacity="0.30" stroke-width="${w.toFixed(1)}"><title>${e.shared} shared FIR${e.shared === 1 ? '' : 's'}</title></line>`;
  }).join('');

  const nodes = net.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return '';
    const r = n.seed ? 13 : n.hop === 1 ? 9 : 7;
    const fill = n.seed ? 'var(--ksp-magenta)' : 'var(--ksp-blue)';
    const label = n.seed || n.hop === 1
      ? `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 11).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="currentColor" fill-opacity="0.75">${esc(n.name)}</text>`
      : '';
    return `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="0.85" stroke="var(--panel)" stroke-width="2">
      <title>${esc(n.name)} · ${esc(n.district)} · ${esc(n.cases)} case(s) · hop ${esc(n.hop)}</title></circle>${label}</g>`;
  }).join('');

  return el(`<div class="mapwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Co-accusation network graph">${edges}${nodes}</svg>
    <div class="map-cap">◉ seed (phonetic name match) · ring 1 = direct co-accused · ring 2 = second-degree. Line width = shared FIRs. Hover for details.</div></div>`);
}

// Early-warning cards: status colors always paired with an icon + word.
const SIGNAL_ICON = { Spike: '▲', Elevated: '↗', Normal: '—', Falling: '▼' };
function alertCards(rows) {
  const wrap = el('<div class="alerts"></div>');
  rows.forEach((r) => {
    wrap.appendChild(el(`<div class="alert-card sev-${esc(r.severity)}">
      <div class="alert-head"><span class="alert-signal">${SIGNAL_ICON[r.signal] || '·'} ${esc(r.signal)}</span><span class="alert-type">${esc(r.crime_type)}</span></div>
      <div class="alert-nums"><b>${esc(r.incidents)}</b> in ${esc(r.month)} · baseline ${esc(r.baseline_avg)}/mo · z=${esc(r.z_score)} · trend ${esc(r.trend)}</div>
    </div>`));
  });
  return wrap;
}

// Duplicate clusters: grouped, confidence-tagged, suggest-only.
function dupeClusters(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r.cluster)) groups.set(r.cluster, { confidence: r.confidence, members: [] });
    groups.get(r.cluster).members.push(r);
  });
  const wrap = el('<div class="dupes"></div>');
  for (const [id, g] of groups) {
    const names = g.members.map((m) => `<span class="dupe-name">${esc(m.name)} <small>#${esc(m.accused_id)} · ${esc(m.district)}${m.age != null ? ' · ' + esc(m.age) : ''}</small></span>`).join('');
    wrap.appendChild(el(`<div class="dupe-cluster">
      <div class="dupe-head">Cluster ${esc(id)} <span class="pill t2">confidence ${(g.confidence * 100).toFixed(0)}%</span> <span class="dupe-note">suggested merge — human confirmation required</span></div>
      <div class="dupe-members">${names}</div>
    </div>`));
  }
  return wrap;
}

function tableView(columns, rows) {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows
    .slice(0, 100)
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
    .join('');
  return el(`<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
}

// Bundled offline Karnataka district choropleth (no external tiles → air-gapped
// safe). GEO is preloaded once at init. Shades each district by crime intensity
// with the single-hue KSP-blue sequential ramp; click a shaded district to drill.
let GEO = null;
function lerpBlue(t) {
  const a = [220, 230, 242], b = [36, 77, 130];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function choroplethMap(rows, onDistrict) {
  if (!GEO) return null;
  const valueKey = (rows[0] && ('incidents' in rows[0] ? 'incidents' : Object.keys(rows[0]).find((k) => typeof rows[0][k] === 'number'))) || 'incidents';
  const byDist = {};
  rows.forEach((r) => { byDist[r.district] = r[valueKey]; });
  const max = Math.max(1, ...Object.values(byDist).filter((v) => typeof v === 'number'));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eachXY = (geom, fn) => {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    polys.forEach((p) => p.forEach((ring) => ring.forEach(([x, y]) => fn(x, y))));
  };
  GEO.features.forEach((f) => eachXY(f.geometry, (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }));
  const pad = 8, targetW = 560;
  const scale = (targetW - 2 * pad) / (maxX - minX);
  const W = targetW, H = (maxY - minY) * scale + 2 * pad;
  const px = (x) => pad + (x - minX) * scale;
  const py = (y) => pad + (maxY - y) * scale;
  const pathFor = (geom) => {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    return polys.map((poly) => poly.map((ring) =>
      'M' + ring.map(([x, y]) => `${px(x).toFixed(1)} ${py(y).toFixed(1)}`).join(' L') + 'Z'
    ).join(' ')).join(' ');
  };

  const wrap = el(`<div class="choro-wrap"></div>`);
  const paths = GEO.features.map((f) => {
    const name = f.properties.district;
    const v = byDist[name];
    const hasData = typeof v === 'number' && v > 0;
    const fill = hasData ? `fill="${lerpBlue(v / max)}"` : '';
    const cls = hasData ? 'choro-district' : 'choro-district nodata';
    return `<path class="${cls}" data-d="${esc(name)}" data-v="${hasData ? v : ''}" ${fill} d="${pathFor(f.geometry)}"><title>${esc(name)}${hasData ? ': ' + esc(v) + ' incidents — click to drill in' : ' (no data in your scope)'}</title></path>`;
  }).join('');
  wrap.appendChild(el(`<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Karnataka crime intensity by district">${paths}</svg>`));
  const info = el(`<div class="choro-hover-info">Hover a district to see its name and incident count.</div>`);
  wrap.appendChild(info);
  wrap.appendChild(el(`<div class="choro-legend"><span>low</span><span class="choro-bar"></span><span>high (${max})</span><span style="margin-left:auto">click a district to drill in</span></div>`));

  wrap.querySelectorAll('.choro-district').forEach((p) => {
    const name = p.dataset.d;
    const v = p.dataset.v;
    p.addEventListener('mouseenter', () => {
      info.classList.add('active');
      info.innerHTML = v
        ? `<span class="name">${esc(name)}</span><span class="stat">${esc(v)} incidents</span><span>(last 90 days) — click to drill in</span>`
        : `<span class="name">${esc(name)}</span><span>no data in your current scope</span>`;
    });
    p.addEventListener('mouseleave', () => {
      info.classList.remove('active');
      info.textContent = 'Hover a district to see its name and incident count.';
    });
    if (onDistrict && v) {
      p.addEventListener('click', () => onDistrict(name));
    }
  });
  return wrap;
}

// Central viz dispatch — used by both chat answer cards and dashboard panels.
function vizNode(res) {
  const rows = res.rows || [];
  if (!rows.length) return null;
  switch (res.viz) {
    case 'scalar': {
      const col = columnsOf(rows)[0];
      return el(`<div class="stat"><span class="stat-value">${esc(rows[0][col])}</span><span class="stat-label">${esc(col.replace(/_/g, ' '))}</span></div>`);
    }
    case 'line': return lineChart(rows);
    case 'bar': return barChart(rows);
    case 'map': return mapChart(rows, res.slots) || barChart(rows);
    case 'network': return res.network ? networkChart(res.network) : barChart(rows);
    case 'alerts': return alertCards(rows);
    case 'dupes': return dupeClusters(rows);
    case 'table': return tableView(columnsOf(rows), rows);
    case 'choropleth': return choroplethMap(rows, res.onDistrict) || barChart(rows);
    default: return barChart(rows);
  }
}

// ---------- command dashboard (role-differentiated) --------------------------
async function loadDashboard() {
  const u = currentUser();
  if (!u) return;
  const dash = $('#dashboard');
  dash.innerHTML = `<div class="dash-banner"><span class="dash-subtitle">Loading command center…</span></div>`;
  try {
    const data = await fetch(`${API_BASE}/overview?userId=${encodeURIComponent(u.id)}`).then((r) => r.json());
    if (data && data.role) renderDashboard(data);
    else dash.innerHTML = '';
  } catch {
    dash.innerHTML = '';
  }
}

function renderDashboard(d) {
  const dash = $('#dashboard');
  dash.innerHTML = '';
  dash.appendChild(el(`<div class="dash-banner">
    <span class="dash-role">${esc(d.role)}</span>
    <span class="dash-headline">${esc(d.headline)}</span>
    <span class="dash-subtitle">${esc(d.subtitle)}</span>
  </div>`));

  const kpiRow = el(`<div class="kpi-row"></div>`);
  d.kpis.forEach((k) => kpiRow.appendChild(el(`<div class="kpi ${k.tone ? esc(k.tone) : ''}">
    <div class="kpi-value">${esc(k.value)}</div>
    <div class="kpi-label">${esc(k.label)}</div>
    <div class="kpi-sub">${esc(k.sub || '')}</div>
  </div>`)));
  dash.appendChild(kpiRow);

  const grid = el(`<div class="panel-grid"></div>`);
  d.panels.forEach((p) => grid.appendChild(renderPanel(p)));
  dash.appendChild(grid);
}

function renderPanel(p) {
  const wide = ['choropleth', 'alerts', 'table', 'line'].includes(p.viz);
  const panel = el(`<div class="panel ${wide ? 'wide' : ''}"></div>`);
  const head = el(`<div class="panel-head"><span class="panel-title">${esc(p.title)}</span></div>`);
  if (p.drilldown) {
    const btn = el(`<button class="panel-drill" type="button">Open in copilot ↗</button>`);
    btn.onclick = () => ask(
      p.drilldown.question,
      null,
      p.drilldown.template ? { template: p.drilldown.template, slots: p.drilldown.slots || {} } : undefined
    );
    head.appendChild(btn);
  }
  panel.appendChild(head);

  const res = {
    viz: p.viz,
    rows: p.rows,
    columns: p.columns,
    slots: p.drilldown && p.drilldown.slots,
    onDistrict: (name) => ask(`Hotspots in ${name}`, null, { template: 'hotspots', slots: { district: name, months: 6 } }),
  };
  const node = vizNode(res);
  panel.appendChild(node || el(`<div class="provenance">No data in the current range.</div>`));
  return panel;
}

// ---------- rendering an answer ---------------------------------------------
function renderResult(res) {
  const tone = res.tone || 'verified';
  const card = el(`<div class="card"></div>`);

  const head = el(`<div class="card-head">
    <span class="badge ${tone}"><span class="dot"></span>${esc(res.badge)}</span>
    ${res.confidence != null ? `<span class="confidence">confidence ${(res.confidence * 100).toFixed(0)}%</span>` : ''}
    <span class="confidence">via ${esc(res.engine)}</span>
  </div>`);
  card.appendChild(head);

  if (res.title) card.appendChild(el(`<div class="title">${esc(res.title)}</div>`));
  card.appendChild(el(`<div class="answer">${esc(res.answer || res.message || '')}</div>`));

  const rows = res.rows || [];
  if (rows.length) {
    const primary = vizNode(res);
    if (primary) card.appendChild(primary);
    // Table view always present (accessibility + transparency), except where the
    // primary rendering already IS the record view / has no useful tabular twin.
    if (!['scalar', 'dupes', 'alerts', 'table', 'choropleth'].includes(res.viz)) {
      card.appendChild(tableView(columnsOf(rows), rows));
    }
  }

  // Abstention suggestions.
  if (res.suggestions && res.suggestions.length) {
    const box = el(`<div class="suggest"></div>`);
    res.suggestions.forEach((s) => {
      const chip = el(`<button class="chip" type="button">${esc(s)}</button>`);
      chip.onclick = () => ask(s);
      box.appendChild(chip);
    });
    card.appendChild(box);
  }

  // Explainability panel.
  if (res.executedSql || res.reason) {
    const details = el(`<details class="explain"><summary>Show query &amp; evidence</summary><div class="explain-body"></div></details>`);
    const body = details.querySelector('.explain-body');
    if (res.reason) body.appendChild(el(`<div><h4>Why this route</h4><div class="provenance">${esc(res.reason)}</div></div>`));
    if (res.generatedSql && res.generatedSql !== res.executedSql) {
      body.appendChild(el(`<div><h4>Generated query</h4><pre class="sql">${esc(res.generatedSql)}</pre></div>`));
    }
    if (res.executedSql) {
      body.appendChild(el(`<div><h4>Executed query (with role-based row-level security)</h4><pre class="sql">${esc(res.executedSql)}</pre></div>`));
    }
    if (res.consensus) {
      body.appendChild(el(`<div class="provenance">Execution consensus: <span class="k">${res.consensus.agreed}/${res.consensus.candidates}</span> candidates agreed (${res.consensus.distinct} distinct result set${res.consensus.distinct === 1 ? '' : 's'}).</div>`));
    }
    if (res.audit) {
      body.appendChild(el(`<div><h4>Audit provenance (hash-chained)</h4><div class="provenance">entry <span class="k">${esc(res.audit.hash.slice(0, 16))}…</span> · prev <span class="k">${esc(res.audit.prev_hash.slice(0, 12))}…</span></div></div>`));
    }
    card.appendChild(details);
  }

  // Export a printable, provenance-stamped case brief.
  if (rows.length || res.executedSql) {
    const actions = el(`<div class="card-actions"></div>`);
    const btn = el(`<button class="ghost-btn" type="button">Export case brief (PDF)</button>`);
    btn.onclick = () => exportBrief(res);
    actions.appendChild(btn);
    card.appendChild(actions);
  }

  return card;
}

// ---------- brief export (browser print → PDF) -------------------------------
function exportBrief(res) {
  const u = currentUser();
  const cols = columnsOf(res.rows || []);
  const table = (res.rows || []).length
    ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font:12px sans-serif">
        <tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
        ${res.rows.slice(0, 100).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}
       </table>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Case Brief</title></head>
    <body style="font:14px/1.5 sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px">
      <h2 style="color:#244d82;margin-bottom:2px">Suraksha Copilot — Case Brief</h2>
      <div style="color:#666;font-size:12px">Karnataka State Police · generated ${new Date().toLocaleString()}</div>
      <hr>
      <p><b>Officer:</b> ${esc(u ? u.name : '')} (${esc(u ? u.role : '')})<br>
         <b>Question:</b> ${esc(res._question || '')}<br>
         <b>Reliability tier:</b> ${esc(res.badge)} · <b>engine:</b> ${esc(res.engine)}</p>
      <p><b>Answer:</b> ${esc(res.answer || res.message || '')}</p>
      ${res.executedSql ? `<p><b>Executed query:</b></p><pre style="background:#f4f6f9;padding:10px;font:11px monospace;white-space:pre-wrap">${esc(res.executedSql)}</pre>` : ''}
      ${table}
      ${res.audit ? `<p style="font:11px monospace;color:#666;margin-top:20px">Audit hash: ${esc(res.audit.hash)}<br>Previous: ${esc(res.audit.prev_hash)}</p>` : ''}
      <p style="font-size:11px;color:#888">Decision support only — not decision-making. Every figure above is reproducible from the executed query.</p>
    </body></html>`;
  const w = window.open('', '_blank');
  if (!w) return alert('Allow pop-ups to export the brief.');
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

// ---------- ask flow ---------------------------------------------------------
function appendUser(q) {
  feed.querySelector('.welcome')?.remove();
  feed.appendChild(el(`<div class="msg user"><div class="bubble-user">${esc(q)}</div></div>`));
  feed.scrollTop = feed.scrollHeight;
}
function appendThinking() {
  const node = el(`<div class="msg"><div class="card"><div class="thinking"><span></span><span></span><span></span></div></div></div>`);
  feed.appendChild(node);
  feed.scrollTop = feed.scrollHeight;
  return node;
}

async function ask(question, justification, direct) {
  const u = currentUser();
  if (!u || !question.trim()) return;
  if (!justification) appendUser(question);
  const thinking = appendThinking();

  try {
    // Content-Type is deliberately text/plain, not application/json: Catalyst's
    // Advanced I/O edge answers CORS preflight (OPTIONS) requests itself with a
    // bare 200 and no Access-Control-Allow-* headers, before our Express app
    // (and its correct cors() middleware) ever sees the request — so any
    // preflight-triggering header fails silently in the browser as "Failed to
    // fetch" (curl doesn't enforce CORS, so this was invisible to server-side
    // testing). text/plain is a CORS-safelisted content type, so the browser
    // sends this as a "simple" request with no preflight at all. The server
    // still parses it as JSON (see express.json({ type: [...] }) in app.js).
    const r = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        question,
        userId: u.id,
        justification,
        history: convo.slice(-4),
        ...(direct || {}), // { template, slots } for direct invocations (e.g. map drill-down)
      }),
    });
    const res = await r.json();
    res._question = question;
    thinking.remove();

    if (res.needs_justification) {
      openJustify(res.message, question);
      return;
    }
    // Remember answered turns (not abstentions) as context for follow-ups.
    if (res.decision && res.decision !== 'abstain') {
      convo.push({ question, decision: res.decision, slots: res.slots || {} });
      if (convo.length > 8) convo.shift();
    }
    const node = el(`<div class="msg"></div>`);
    node.appendChild(renderResult(res));
    feed.appendChild(node);
    feed.scrollTop = feed.scrollHeight;
  } catch (err) {
    thinking.remove();
    feed.appendChild(el(`<div class="msg"><div class="card"><div class="answer">Network error: ${esc(err.message)}</div></div></div>`));
  }
}

// ---------- overlay coordination ---------------------------------------------
// Only one of {justification modal, audit drawer} should ever be open — close
// the other before showing either, so they can't stack and hide each other's
// controls (including the close buttons).
function closeOverlays() {
  $('#justifyModal').hidden = true;
  $('#auditDrawer').hidden = true;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlays();
});

// ---------- justification modal ---------------------------------------------
function openJustify(message, question) {
  closeOverlays();
  $('#justifyMsg').textContent = message;
  $('#justifyInput').value = '';
  $('#justifyModal').hidden = false;
  $('#justifyInput').focus();
  $('#justifyProceed').onclick = () => {
    const j = $('#justifyInput').value.trim();
    if (!j) return $('#justifyInput').focus();
    $('#justifyModal').hidden = true;
    ask(question, j);
  };
}
$('#justifyCancel').onclick = () => ($('#justifyModal').hidden = true);

// ---------- audit drawer -----------------------------------------------------
$('#auditBtn').onclick = openAudit;
$('#auditClose').onclick = () => ($('#auditDrawer').hidden = true);
async function openAudit() {
  closeOverlays();
  $('#auditDrawer').hidden = false;
  const [verify, recent] = await Promise.all([
    fetch(`${API_BASE}/audit/verify`).then((r) => r.json()),
    fetch(`${API_BASE}/audit/recent?limit=40`).then((r) => r.json()),
  ]);
  const status = $('#auditStatus');
  status.className = 'audit-status ' + (verify.ok ? 'ok' : 'bad');
  status.textContent = `${verify.ok ? '✓' : '✗'} ${verify.message} (${verify.count} entries)`;
  const list = $('#auditList');
  list.innerHTML = '';
  (recent.entries || []).slice().reverse().forEach((e) => {
    list.appendChild(el(`<div class="audit-entry">
      <div class="row"><span class="pill t${e.tier}">Tier ${esc(e.tier)}</span><span>${esc(e.role)} · ${esc(new Date(e.ts).toLocaleTimeString())}</span></div>
      <div class="q">${esc(e.question)}</div>
      ${e.justification ? `<div class="q"><b>Justification:</b> ${esc(e.justification)}</div>` : ''}
      <div class="h">${esc((e.hash || '').slice(0, 40))}…</div>
    </div>`));
  });
}

// ---------- voice input (Web Speech API; kn-IN supported in Chrome) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#micBtn');
const langBtn = $('#langBtn');
let voiceLang = 'en-IN';
let recognizing = false;
let recognizer = null;

langBtn.onclick = () => {
  voiceLang = voiceLang === 'en-IN' ? 'kn-IN' : 'en-IN';
  langBtn.textContent = voiceLang === 'en-IN' ? 'EN' : 'ಕನ್ನಡ';
};

if (!SpeechRec) {
  micBtn.disabled = true;
  micBtn.title = 'Voice input needs Chrome/Edge (Web Speech API).';
} else {
  micBtn.onclick = () => {
    if (recognizing) {
      recognizer.stop();
      return;
    }
    recognizer = new SpeechRec();
    recognizer.lang = voiceLang;
    recognizer.interimResults = true;
    recognizer.continuous = false;
    const input = $('#questionInput');
    recognizer.onstart = () => {
      recognizing = true;
      micBtn.classList.add('listening');
    };
    recognizer.onresult = (e) => {
      input.value = Array.from(e.results).map((r) => r[0].transcript).join('');
    };
    recognizer.onend = () => {
      recognizing = false;
      micBtn.classList.remove('listening');
      const q = input.value.trim();
      if (q) {
        ask(q);
        input.value = '';
      }
    };
    recognizer.onerror = () => {
      recognizing = false;
      micBtn.classList.remove('listening');
    };
    recognizer.start();
  };
}

// ---------- init -------------------------------------------------------------
$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#questionInput');
  const q = input.value.trim();
  if (q) {
    ask(q);
    input.value = '';
  }
});

function refreshScope() {
  $('#scopeNote').innerHTML = `Acting as <b>${esc(currentUser()?.name || '')}</b> — ${scopeLabel(currentUser())}`;
}
userSelect.addEventListener('change', () => {
  convo = []; // context must not leak across officers/scopes
  feed.innerHTML = ''; // clear the previous officer's conversation
  refreshScope();
  loadDashboard(); // each rank gets a different command center
});

(async function init() {
  try {
    [META, USERS] = await Promise.all([
      fetch(`${API_BASE}/meta`).then((r) => r.json()),
      fetch(`${API_BASE}/users`).then((r) => r.json()),
    ]);
  } catch {
    $('#dashboard').innerHTML = '<div class="dash-banner"><span class="dash-subtitle">Could not reach the API. Start it with <code>npm run dev</code>.</span></div>';
    return;
  }
  USERS.forEach((u) => {
    userSelect.appendChild(el(`<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.role)}</option>`));
  });
  refreshScope();

  const eb = $('#engineBadge');
  if (META.llm) { eb.textContent = `LLM · ${META.model}`; eb.classList.add('on'); }
  else { eb.textContent = 'Offline mode · templates only'; eb.classList.add('off'); }

  const samples = $('#samples');
  (META.sampleQuestions || []).forEach((s) => {
    const chip = el(`<button class="chip" type="button">${esc(s)}</button>`);
    chip.onclick = () => ask(s);
    samples.appendChild(chip);
  });

  // Preload the bundled Karnataka map, then render the role dashboard.
  try {
    GEO = await fetch('karnataka-districts.geojson').then((r) => r.json());
  } catch {
    GEO = null; // choropleth falls back to a bar chart
  }
  loadDashboard();
})();
