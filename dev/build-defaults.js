// Writes the legal default speed limits into content.js, between the markers
// "BEGIN GENERATED DEFAULT SPEEDS" and "END GENERATED DEFAULT SPEEDS".
//
//   node dev/build-defaults.js legal_default_speeds.json   write the block
//   node dev/build-defaults.js --check                     is the OSM wiki newer?
//
// Source is the OSM wiki page "Default speed limits", turned into JSON by the parser
// of https://github.com/westnordost/osm-legal-default-speeds (parser/main.py; see
// the README, section "Updating the default speed limits"). The wiki data is
// licensed CC BY-SA 2.0.
//
// Kept are the road types with their exact tag filters (fuzzy and relation filters
// are dropped, see below) and, per country, the maxspeed tags for the vehicle types
// this extension offers.
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'content.js');
const BEGIN = '  // BEGIN GENERATED DEFAULT SPEEDS\n';
const END = '  // END GENERATED DEFAULT SPEEDS\n';
const WIKI_API = 'https://wiki.openstreetmap.org/w/api.php?action=query&prop=revisions&titles=Default_speed_limits&rvprop=ids|timestamp&rvlimit=1&format=json';

/** Tags used by content.js: plain, advisory, conditional, and per vehicle type. */
const KEPT_TAG = /^maxspeed(?::(?:hgv|goods|bus|coach|trailer|caravan))?(?::(?:advisory|conditional))?$/;

const source = fs.readFileSync(target, 'utf8');
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start < 0 || end < start) throw new Error('markers not found in content.js');

if (process.argv[2] === '--check') {
  const embedded = source.slice(start, end).match(/revision: (\d+), date: '([\d-]+)'/);  fetch(WIKI_API).then((r) => r.json()).then((json) => {
    const rev = Object.values(json.query.pages)[0].revisions[0];
    console.log(`content.js: revision ${embedded ? `${embedded[1]} (${embedded[2]})` : 'none'}`);
    console.log(`OSM wiki:   revision ${rev.revid} (${rev.timestamp.slice(0, 10)})`);
    if (embedded && Number(embedded[1]) === rev.revid) {
      console.log('Up to date.');
    } else {
      console.log('The wiki has changed: regenerate the JSON and run this script with it.');
      process.exitCode = 1;
    }
  });
  return;
}

const input = process.argv[2];
if (!input) throw new Error('usage: node dev/build-defaults.js legal_default_speeds.json | --check');
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const revision = Number(data.meta && data.meta.revisionId);
if (!revision) throw new Error('meta.revisionId missing');

/** @type {Record<string, Array<[string, Record<string, string>]>>} */
const countries = {};
const usedTypes = new Set();
for (const [code, rows] of Object.entries(data.speedLimitsByCountryCode).sort(([a], [b]) => a.localeCompare(b))) {
  countries[code] = rows.map((row) => {
    const name = row.name || '';
    if (name) usedTypes.add(name);
    const tags = Object.fromEntries(Object.entries(row.tags || {}).filter(([k]) => KEPT_TAG.test(k)).sort(([a], [b]) => a.localeCompare(b)));
    return [name, tags];
  });
}

// Road types used by a country, plus every type their filters refer to as {placeholder}.
const roadTypes = {};
const unmapped = [];
const queue = [...usedTypes];
while (queue.length) {
  const name = queue.pop();
  if (name in roadTypes) continue;
  const type = data.roadTypesByName[name];
  // The parser could not map these to tags; they never match.
  if (!type) { unmapped.push(name); roadTypes[name] = ''; continue; }
  // Only the exact filter: the fuzzy one guesses (urban from lit=yes, a sidewalk or
  // highway=residential), and those tags are also found outside built-up areas.
  roadTypes[name] = type.filter || '';
  for (const m of roadTypes[name].matchAll(/\{([^}]+)\}/g)) queue.push(m[1]);
}
const sortedTypes = Object.fromEntries(Object.entries(roadTypes).sort(([a], [b]) => a.localeCompare(b)));

const date = new Date().toISOString().slice(0, 10);
const lines = [
  BEGIN,
  '  /**\n',
  '   * Legal default speed limits per country, from the OSM wiki page "Default speed\n',
  '   * limits" (https://wiki.openstreetmap.org/wiki/Default_speed_limits), licensed\n',
  '   * CC BY-SA 2.0. Written by dev/build-defaults.js; check monthly for updates with\n',
  '   * `node dev/build-defaults.js --check`.\n',
  '   * A function, not a constant: declarations are hoisted, so the code above can\n',
  '   * use it although this block comes last (the Node tests return before it).\n',
  '   * @returns {DefaultSpeedTable}\n',
  '   */\n',
  '  function defaultSpeedTable() {\n',
  `    return {\n      revision: ${revision}, date: '${date}',\n`,
  '      roadTypes: {\n',
  ...Object.entries(sortedTypes).map(([name, f]) => `        ${JSON.stringify(name)}: ${JSON.stringify(f)},\n`),
  '      },\n      countries: {\n',
  ...Object.entries(countries).map(([code, rows]) => `        ${JSON.stringify(code)}: ${JSON.stringify(rows)},\n`),
  '      },\n    };\n  }\n',
  END,
];
const block = lines.join('');
const updated = source.slice(0, start) + block + source.slice(end + END.length);
// Written only at the very end, after everything above succeeded.
fs.writeFileSync(target, updated);
console.log(`revision ${revision}: ${Object.keys(countries).length} countries, ${Object.keys(sortedTypes).length} road types, ${block.length} characters written to content.js`);
if (unmapped.length) console.log(`${unmapped.length} road types without tag filter (never match): ${unmapped.sort().join('; ')}`);
