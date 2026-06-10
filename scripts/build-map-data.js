// scripts/build-map-data.js — TEMPLATE-GRADE build step (run during `npm run build`)
// ---------------------------------------------------------------------------
// Reusable across client deployments with ZERO code changes — only env vars.
// Auto-discovers tables via the Airtable Metadata API, then writes
// ./public/map-data.json in EXACTLY the shape public/map.html expects:
//
//   { id, layer, lat, lng, name, headline, city, image, meta:{primary,secondary} }
//
// The browser only ever loads that JSON — the Airtable token is never exposed.
// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES
//   Required:
//     AIRTABLE_TOKEN        Personal access token. MUST include BOTH scopes:
//                           data.records:read  AND  schema.bases:read
//                           (missing schema.bases:read => 403 at build time)
//     AIRTABLE_BASE_ID      e.g. appXXXXXXXXXXXXXX
//
//   Layer mapping (this is what tells the map which table is which category):
//     AIRTABLE_LAYER_MAP    Comma-separated  tableIdOrName:layer[:label]  entries:
//                           tblRSY9kLo9sE8Ctb:active-sale,tblYhMRC7nJCThGGk:active-lease
//                           The middle value is the STYLE/category and must be one of:
//                           active-sale, active-lease, closed-sale, closed-lease,
//                           tenant-rep, buyer-rep  (these pick the pin icon + legend row).
//                           The optional THIRD part is a custom display label shown in
//                           the legend and popups — use it to relabel per client, e.g.
//                           tblRSY9kLo9sE8Ctb:active-sale:Active Sale Listings
//                           (Avoid commas inside labels; they separate entries.)
//                           A table with NO entry here is treated as internal
//                           (e.g. Property Types, Client Info) and never read.
//
//   Optional narrowing:
//     AIRTABLE_TABLE_IDS    Comma-separated allow-list of table IDs to consider.
//                           If omitted, all discovered tables are considered
//                           (and filtered by AIRTABLE_LAYER_MAP anyway).
//
//   Optional field overrides (sensible defaults are tried if unset):
//     AIRTABLE_LAT_FIELD            (default: Latitude)
//     AIRTABLE_LNG_FIELD           (default: Longitude)
//     AIRTABLE_NAME_FIELD          (default: Property Name / Name / Title …)
//     AIRTABLE_HEADLINE_FIELD      (default: Headline / Description …)
//     AIRTABLE_CITY_FIELD          (default: Address — City / City …)
//     AIRTABLE_IMAGE_FIELD         (default: Hero Image / Gallery Images …)
//     AIRTABLE_PRICE_FIELD         meta.primary, money-formatted if numeric
//     AIRTABLE_META_SECONDARY_FIELDS  comma-separated; joined with " · "
//     AIRTABLE_VISIBLE_FIELD       checkbox; if present and false, row is hidden
// ---------------------------------------------------------------------------

const Airtable = require('airtable');
const fs = require('fs');
const path = require('path');

const TOKEN   = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
if (!TOKEN || !BASE_ID) {
  console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID environment variable.');
  process.exit(1);
}
const base = new Airtable({ apiKey: TOKEN }).base(BASE_ID);

// Must stay in sync with the LAYER_STYLES keys in public/map.html
const VALID_LAYERS = ['active-sale', 'active-lease', 'closed-sale',
                      'closed-lease', 'tenant-rep', 'buyer-rep'];

// ---- env parsing helpers ----
function list(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}
function parseLayerMap(str) {
  // Each comma-separated entry is  tableIdOrName : layer [ : customLabel ]
  //   tblXXX:active-sale                         -> default label
  //   tblXXX:active-sale:Active Sale Listings    -> custom label per client
  // Splits on ':' — table IDs and layer keys have no colons, so the first two
  // segments are key + layer and anything after is the (optional) label.
  const m = new Map();
  for (const item of list(str)) {
    const seg = item.split(':');
    const key   = (seg[0] || '').trim();
    const layer = (seg[1] || '').trim();
    const label = seg.slice(2).join(':').trim();   // optional; '' if absent
    if (key && layer) m.set(key, { layer, label });
  }
  return m;
}

// Default legend/popup labels per style key (must match map.html's defaults).
const DEFAULT_LABELS = {
  'active-sale':  'Active — For Sale',
  'active-lease': 'Active — For Lease',
  'closed-sale':  'Sold',
  'closed-lease': 'Leased',
  'tenant-rep':   'Tenants Represented',
  'buyer-rep':    'Buyers Represented',
};

const LAYER_MAP = parseLayerMap(process.env.AIRTABLE_LAYER_MAP);
const ALLOW_IDS = list(process.env.AIRTABLE_TABLE_IDS);

const LAT_FIELD  = process.env.AIRTABLE_LAT_FIELD  || 'Latitude';
const LNG_FIELD  = process.env.AIRTABLE_LNG_FIELD  || 'Longitude';
const NAME_FIELD = process.env.AIRTABLE_NAME_FIELD;
const HEAD_FIELD = process.env.AIRTABLE_HEADLINE_FIELD;
const CITY_FIELD = process.env.AIRTABLE_CITY_FIELD;
const IMG_FIELD  = process.env.AIRTABLE_IMAGE_FIELD;
const PRICE_FIELD = process.env.AIRTABLE_PRICE_FIELD;
const META_SECONDARY = list(process.env.AIRTABLE_META_SECONDARY_FIELDS);
const VISIBLE_FIELD = process.env.AIRTABLE_VISIBLE_FIELD;

const NAME_CANDS = ['Property Name', 'Listing Name', 'Name', 'Tenant Name', 'Buyer Name', 'Title'];
const HEAD_CANDS = ['Headline', 'Description', 'Subtitle', 'Summary'];
const CITY_CANDS = ['Address — City', 'Address - City', 'City', 'Address City'];
const IMG_CANDS  = ['Hero Image', 'Image', 'Photo', 'Photos', 'Images', 'Gallery Images'];
const LAT_CANDS  = ['Lat', 'lat', 'latitude'];
const LNG_CANDS  = ['Lng', 'Long', 'lng', 'long', 'longitude'];

// ---- value helpers ----
function val(r, explicit, cands) {
  const order = [];
  if (explicit) order.push(explicit);
  for (const c of cands) if (!order.includes(c)) order.push(c);
  for (const k of order) {
    const v = r.get(k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
const num = v => (v === undefined || v === null || v === '') ? null : Number(v);
function money(v) {
  const n = num(v);
  return n == null || Number.isNaN(n) ? null : '$' + n.toLocaleString('en-US');
}
function imageUrl(r) {
  const order = [];
  if (IMG_FIELD) order.push(IMG_FIELD);
  for (const c of IMG_CANDS) if (!order.includes(c)) order.push(c);
  for (const k of order) {
    const a = r.get(k);
    if (Array.isArray(a) && a[0] && a[0].url) return a[0].url;   // attachment
    if (typeof a === 'string' && a) return a;                    // URL string
  }
  return null;
}
function meta(r) {
  const primary = PRICE_FIELD ? (money(r.get(PRICE_FIELD)) || '') : '';
  const secondary = META_SECONDARY.map(f => r.get(f)).filter(Boolean).join(' · ');
  return { primary, secondary };
}

// ---- Metadata API: discover tables (id + name) ----
async function discoverTables() {
  const url = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 403) {
    throw new Error('403 from Airtable Metadata API. Your token must include BOTH ' +
      '"data.records:read" AND "schema.bases:read" scopes.');
  }
  if (!res.ok) {
    throw new Error(`Metadata API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return (json.tables || []).map(t => ({ id: t.id, name: t.name }));
}

async function run() {
  let discovered;
  try {
    discovered = await discoverTables();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Discovered ${discovered.length} table(s): ${discovered.map(t => t.name).join(', ')}`);

  // Consider all discovered tables, or just the allow-list if provided.
  let considered = discovered;
  if (ALLOW_IDS.length) {
    considered = discovered.filter(t => ALLOW_IDS.includes(t.id));
  }

  // A table becomes a pin source only if AIRTABLE_LAYER_MAP assigns it a valid layer.
  const sources = [];
  for (const t of considered) {
    const mapping = LAYER_MAP.get(t.id) || LAYER_MAP.get(t.name);
    if (!mapping) {
      console.log(`  - "${t.name}" (${t.id}): no layer in AIRTABLE_LAYER_MAP -> skipped (treated as internal).`);
      continue;
    }
    const layer = mapping.layer;
    if (!VALID_LAYERS.includes(layer)) {
      console.warn(`  ! "${t.name}": layer "${layer}" is not valid. Use one of: ${VALID_LAYERS.join(', ')}. Skipped.`);
      continue;
    }
    const label = mapping.label || DEFAULT_LABELS[layer];
    sources.push({ ...t, layer, label });
  }

  if (!sources.length) {
    console.warn('\nNo tables were mapped to a layer. Set AIRTABLE_LAYER_MAP, e.g.\n' +
      '  AIRTABLE_LAYER_MAP="tblXXXXXXXXXXXXXX:active-sale,tblYYYYYYYYYYYYYY:active-lease"\n' +
      'Writing an empty map for now.');
  }

  const pins = [];
  for (const t of sources) {
    let records;
    try {
      records = await base(t.id).select().all();
    } catch (err) {
      console.warn(`! Skipping "${t.name}" (${t.id}): ${err.message}`);
      continue;
    }

    const fields = records[0] ? Object.keys(records[0].fields) : [];
    console.log(`\n[${t.name}] layer=${t.layer}; label="${t.label}"; ${records.length} record(s).`);
    if (fields.length) console.log(`  Fields available: ${fields.join(', ')}`);

    let added = 0, skipped = 0;
    records.forEach(r => {
      if (VISIBLE_FIELD && r.get(VISIBLE_FIELD) === false) { skipped++; return; }
      const lat = num(val(r, LAT_FIELD, LAT_CANDS));
      const lng = num(val(r, LNG_FIELD, LNG_CANDS));
      if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) { skipped++; return; }

      pins.push({
        id:       r.id,
        layer:    t.layer,
        label:    t.label,
        lat, lng,
        name:     val(r, NAME_FIELD, NAME_CANDS) || 'Untitled listing',
        headline: val(r, HEAD_FIELD, HEAD_CANDS) || '',
        city:     val(r, CITY_FIELD, CITY_CANDS) || '',
        image:    imageUrl(r),
        meta:     meta(r),
      });
      added++;
    });
    console.log(`  -> ${added} pin(s) added, ${skipped} skipped (no coords / hidden).`);
  }

  const outDir = path.join(__dirname, '..', 'public');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'map-data.json'), JSON.stringify(pins, null, 2));
  console.log(`\nWrote ${pins.length} pin(s) to public/map-data.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
