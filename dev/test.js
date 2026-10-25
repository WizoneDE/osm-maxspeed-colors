// Tests for the tag reading and line styles in ../content.js: node dev/test.js
const api = require('../content.js');
api.setNoSpeedRules([['highway', 'footway'], ['highway', 'track'], ['highway', 'pedestrian'], ['service', 'parking_aisle']]);
let fail = 0;
const eq = (name, got, want) => { const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b) { fail++; console.log('FAIL', name, '\n   got ', a, '\n   want', b); } };
const short = (d) => d && [d.status, Math.round(d.kmh * 10) / 10, d.advisory ? 'richt' : '', d.sign, d.lanes ? d.lanes.map((l) => Math.round(l.kmh)).join('|') : '', d.condition ? d.condition.kind : '', d.extras.map((e) => e.kmh + e.kind).join(',')].filter((x) => x !== '').join(' ');
const W = (tags, veh = []) => { const r = api.waySpeed({ highway: 'primary', ...tags }, veh); return [r.forward ? short(r.forward) : '-', r.backward ? short(r.backward) : '-']; };

// Werte
eq('50', W({ maxspeed: '50' }), ['limit 50', 'limit 50']);
eq('30 mph', W({ maxspeed: '30 mph' }), ['limit 48.3', 'limit 48.3']);
eq('DE:urban', W({ maxspeed: 'DE:urban' }), ['limit 50', 'limit 50']);
eq('DE:zone:30', W({ maxspeed: 'DE:zone:30' }), ['limit 30', 'limit 30']);
eq('zone:maxspeed ohne maxspeed', W({ 'zone:maxspeed': 'DE:30' }), ['limit 30', 'limit 30']);
eq('none → Richt 130', W({ highway: 'motorway', maxspeed: 'none' }), ['limit 130 richt', '-']);
eq('none + advisory 120', W({ maxspeed: 'none', 'maxspeed:advisory': '120' }), ['limit 120 richt', 'limit 120 richt']);
eq('DE:motorway → Richt', W({ highway: 'motorway', maxspeed: 'DE:motorway' }), ['limit 130 richt', '-']);
eq('walk', W({ maxspeed: 'walk' }), ['limit 5 🚶', 'limit 5 🚶']);
eq('living_street leer', W({ highway: 'living_street' }), ['limit 5 🚶', 'limit 5 🚶']);
eq('signals', W({ maxspeed: 'signals' }), ['variable 0', 'variable 0']);
eq('fehlt', W({}), ['missing 0', 'missing 0']);
eq('Fußweg', W({ highway: 'footway' }), ['noSpeed 0', 'noSpeed 0']);
eq('Fußweg mit maxspeed', W({ highway: 'footway', maxspeed: '10' }), ['limit 10', 'limit 10']);
eq('Parkplatzgasse', W({ highway: 'service', service: 'parking_aisle' }), ['noSpeed 0', 'noSpeed 0']);
eq('Gebäude', api.waySpeed({ building: 'yes' }, []).forward, null);
// Richtungen und Einbahn
eq('forward/backward', W({ 'maxspeed:forward': '70', 'maxspeed:backward': '100' }), ['limit 70', 'limit 100']);
eq('maxspeed + forward', W({ maxspeed: '100', 'maxspeed:forward': '70' }), ['limit 70', 'limit 100']);
eq('oneway=yes', W({ oneway: 'yes', maxspeed: '50' }), ['limit 50', '-']);
eq('oneway=-1', W({ oneway: '-1', maxspeed: '50' }), ['-', 'limit 50']);
// Fahrzeuge
eq('hgv eigener Wert', W({ maxspeed: '100', 'maxspeed:hgv': '80' }, ['hgv']), ['limit 80', 'limit 80']);
eq('hgv ohne eigenen Wert → maxspeed', W({ maxspeed: '100' }, ['hgv']), ['limit 100', 'limit 100']);
eq('hgv:forward', W({ maxspeed: '100', 'maxspeed:hgv': '80', 'maxspeed:hgv:forward': '60' }, ['hgv']), ['limit 60', 'limit 80']);
// Bus (Linien-/Stadtbus) und Reisebus getrennt (2026-10-25); Reisebus ohne eigenen Wert → maxspeed:bus
eq('Bus ignoriert coach', W({ maxspeed: '100', 'maxspeed:coach': '80' }, ['bus']), ['limit 100', 'limit 100']);
eq('Reisebus: coach vor bus', W({ maxspeed: '120', 'maxspeed:bus': '80', 'maxspeed:coach': '100' }, ['coach', 'bus']), ['limit 100', 'limit 100']);
eq('Reisebus ohne coach → bus', W({ maxspeed: '120', 'maxspeed:bus': '80' }, ['coach', 'bus']), ['limit 80', 'limit 80']);
eq('PKW ignoriert hgv', W({ maxspeed: '100', 'maxspeed:hgv': '80' }), ['limit 100', 'limit 100']);
// Subtypen (2026-10-25): Bedingung, die genau das Fahrzeug nennt, ist dessen eigener Wert
const CAR = ['motorcar'], TRAILER = ['trailer', 'caravan', 'motorcar'];
eq('PKW: maxspeed:motorcar', W({ maxspeed: '100', 'maxspeed:motorcar': '80' }, CAR), ['limit 80', 'limit 80']);
eq('Anhänger: motorcar:conditional @ trailer', W({ maxspeed: '100', 'maxspeed:motorcar:conditional': '80 @ trailer' }, TRAILER), ['limit 80', 'limit 80']);
eq('Anhänger: maxspeed:conditional @ (trailer) vor maxspeed:motorcar', W({ maxspeed: '120', 'maxspeed:motorcar': '100', 'maxspeed:conditional': '80 @ (trailer); 60 @ wet' }, TRAILER), ['limit 80 60wet', 'limit 80 60wet']);
eq('Anhänger: maxspeed:trailer vor Bedingung', W({ 'maxspeed:trailer': '60', 'maxspeed:conditional': '80 @ trailer' }, TRAILER), ['limit 60', 'limit 60']);
eq('PKW: @ trailer bleibt Zusatzschild', W({ maxspeed: '100', 'maxspeed:motorcar:conditional': '80 @ trailer' }, CAR), ['limit 100 80vehicle', 'limit 100 80vehicle']);
eq('LKW: @ (hgv) wird Hauptwert, Gewicht bleibt Zusatz', W({ maxspeed: '100', 'maxspeed:conditional': '60 @ (hgv)', 'maxspeed:hgv:conditional': '50 @ (weight>7.5)' }, ['hgv']), ['limit 60 50vehicle', 'limit 60 50vehicle']);
eq('LKW: allgemeine und eigene Bedingungen zusammen', W({ maxspeed: '100', 'maxspeed:hgv': '80', 'maxspeed:hgv:conditional': '60 @ (weight>7.5)', 'maxspeed:conditional': '70 @ wet' }, ['hgv']), ['limit 80 60vehicle,70wet', 'limit 80 60vehicle,70wet']);
eq('Zusatz Anhänger aus Bedingung', api.mainPanels(api.waySpeed({ highway: 'primary', maxspeed: '100', 'maxspeed:conditional': '80 @ (trailer)' }, TRAILER).forward).map((p) => p.art), ['1010-59']);
// Bedingungen
eq('conditional wet + Zeit', W({ maxspeed: '120', 'maxspeed:conditional': '80 @ wet; 60 @ (Mo-Fr 07:00-17:00; Sa 08:00-12:00)' }), ['limit 120 80wet,60time', 'limit 120 80wet,60time']);
eq('conditional sunset', W({ maxspeed: '100', 'maxspeed:conditional': '70 @ (sunset-sunrise)' }), ['limit 100 70daytime', 'limit 100 70daytime']);
eq('conditional Gewicht', W({ maxspeed: '100', 'maxspeed:conditional': '60 @ (weight>7.5)' }), ['limit 100 60vehicle', 'limit 100 60vehicle']);
eq('nur conditional', W({ 'maxspeed:conditional': '30 @ (Mo-Fr 07:00-18:00)' }), ['limit 30 time', 'limit 30 time']);
eq('forward:conditional', W({ maxspeed: '100', 'maxspeed:forward:conditional': '80 @ wet' }), ['limit 100 80wet', 'limit 100']);
eq('hgv:conditional', W({ maxspeed: '100', 'maxspeed:hgv:conditional': '60 @ wet' }, ['hgv']), ['limit 100 60wet', 'limit 100 60wet']);
eq('kaputt conditional', W({ maxspeed: '100', 'maxspeed:conditional': 'quatsch; @ ; x @ wet' }), ['limit 100', 'limit 100']);
// Spuren
eq('lanes oneway', W({ oneway: 'yes', 'maxspeed:lanes': '100|80|60' }), ['limit 60 100|80|60', '-']);
eq('lanes oneway + maxspeed', W({ oneway: 'yes', maxspeed: '100', 'maxspeed:lanes': '100|100|80' }), ['limit 100 100|100|80', '-']);
eq('lanes gleich → keine', W({ oneway: 'yes', 'maxspeed:lanes': '80|80' }), ['missing 0', '-']);
eq('lanes forward/backward', W({ maxspeed: '100', 'maxspeed:lanes:forward': '100|80', 'maxspeed:lanes:backward': '100|60' }), ['limit 100 100|80', 'limit 100 100|60']);
eq('lanes auf Zweirichtung ohne :forward ignoriert', W({ maxspeed: '100', 'maxspeed:lanes': '100|80|80|100' }), ['limit 100', 'limit 100']);
eq('lanes mit none', W({ highway: 'motorway', 'maxspeed:lanes': 'none|120' }), ['limit 120 130|120', '-']);
// Sonstiges
eq('Zufahrt beschränkt', api.waySpeed({ highway: 'residential', access: 'private' }, []).restricted, true);
// highway=service gehört nicht zum öffentlichen Netz: fehlendes maxspeed rot auf Grau statt auf Weiß
eq('service ohne maxspeed: rot auf Grau', [{ highway: 'service' }, { highway: 'residential' }].map((t) => api.lineStyleFor(t, []).stripes[0].look.under),
  ['#9e9e9e', '#ffffff']);
eq('Kreisverkehr einbahn', api.onewayOf({ highway: 'primary', junction: 'roundabout' }), 1);
eq('Autobahn oneway=no', api.onewayOf({ highway: 'motorway', oneway: 'no' }), 0);
eq('Unsinn-Werte', [api.parseSpeed('-5'), api.parseSpeed('9999'), api.parseSpeed(42), api.parseSpeed('fast')], [null, null, null, null]);

// Linienstil: Streifen als [von, bis, Farbe, Muster, Untergrund], Breite in Anteilen -0.5 … 0.5
const r3 = (n) => Math.round(n * 1000) / 1000;
const S = (tags, veh = []) => {
  const s = api.lineStyleFor({ highway: 'primary', ...tags }, veh);
  return s && { stripes: s.stripes.map((p) => [r3(p.from), r3(p.to), p.look.color, p.look.dash, p.look.under]), overlay: s.overlay, signs: s.signs.map((x) => x.side), width: s.width, outline: s.outline };
};
const G100 = '#1b5e20', B80 = '#42a5f5', N60 = '#0d1b6e', O50 = '#ffb74d';
eq('Stil gleich', S({ maxspeed: '50' }), { stripes: [[-0.5, 0.5, O50, '', '']], overlay: false, signs: [0], width: '', outline: '' });
eq('Stil je Richtung', S({ 'maxspeed:forward': '100', 'maxspeed:backward': '50' }).stripes, [[0, 0.5, G100, '', ''], [-0.5, 0, O50, '', '']]);
eq('Stil je Richtung Schilder', S({ 'maxspeed:forward': '100', 'maxspeed:backward': '50' }).signs, [1, -1]);
eq('Spuren oneway=yes: Spur 1 links', S({ oneway: 'yes', 'maxspeed:lanes': '100|80|60' }).stripes,
  [[-0.5, -0.167, G100, '', ''], [-0.167, 0.167, B80, '', ''], [0.167, 0.5, N60, '', '']]);
eq('Spuren oneway=-1: gespiegelt', S({ oneway: '-1', 'maxspeed:lanes': '100|80|60' }).stripes,
  [[0.167, 0.5, G100, '', ''], [-0.167, 0.167, B80, '', ''], [-0.5, -0.167, N60, '', '']]);
eq('Spuren Zweirichtung: Spur 1 zur Mitte', S({ maxspeed: '100', 'maxspeed:lanes:forward': '100|80', 'maxspeed:lanes:backward': '100|60' }).stripes,
  [[0, 0.25, G100, '', ''], [0.25, 0.5, B80, '', ''], [-0.25, 0, G100, '', ''], [-0.5, -0.25, N60, '', '']]);
eq('Spuren nur forward → trotzdem geteilt', S({ maxspeed: '100', 'maxspeed:lanes:forward': '100|80' }).stripes,
  [[0, 0.25, G100, '', ''], [0.25, 0.5, B80, '', ''], [-0.5, 0, G100, '', '']]);
eq('fehlt', S({}).stripes, [[-0.5, 0.5, '#e53935', '6,5', '#ffffff']]);
eq('fehlt, beschränkt', S({ access: 'private' }).stripes, [[-0.5, 0.5, '#e53935', '6,5', '#9e9e9e']]);
eq('Richtgeschwindigkeit', S({ highway: 'motorway', maxspeed: 'none' }), { stripes: [[-0.5, 0.5, '#ffff00', 'dots', '#7b1fa2']], overlay: true, signs: [0], width: '', outline: '' });
eq('nur bedingt', S({ 'maxspeed:conditional': '30 @ wet' }).stripes, [[-0.5, 0.5, '#ff7961', '12,5', '']]);
eq('variabel', S({ maxspeed: 'signals' }).stripes, [[-0.5, 0.5, '#ffffff', '3,3', '#546e7a']]);
eq('Fußweg', S({ highway: 'footway' }), { stripes: [[-0.5, 0.5, '#ffffff', '5,4', '']], overlay: false, signs: [0], width: '2px', outline: 'none' });
eq('kein Weg', api.lineStyleFor({ building: 'yes' }, []), null);
// Schilder und Tooltips
const D = (tags) => api.waySpeed({ highway: 'primary', ...tags }, []).forward;
eq('Schild Spuren', api.signLabel(D({ oneway: 'yes', 'maxspeed:lanes': '100|80|60' })), '100|80|60');
eq('Schild walk', api.signLabel(D({ maxspeed: 'walk' })), '🚶');
eq('Tooltip implizit', api.signTooltip(D({ maxspeed: 'DE:urban' })), '50 km/h – implizit\nmaxspeed=DE:urban');
eq('Tooltip Bedingung', api.signTooltip(D({ 'maxspeed:conditional': '30 @ (Mo-Fr 07:00-17:00)' })), '30 km/h – Mo-Fr 07:00-17:00\nmaxspeed:conditional=30 @ (Mo-Fr 07:00-17:00)');
eq('Tooltip Nässe', api.signTooltip(D({ 'maxspeed:conditional': '30 @ wet' })), '30 km/h – bei Nässe\nwet\nmaxspeed:conditional=30 @ wet');
const SYM = (tags) => D(tags).symbol;
// Wechselverkehrszeichen
const V = (tags) => { const d = D(tags); return [d.status, Math.round(d.kmh), d.variable]; };
eq('variable mit maxspeed', V({ maxspeed: '120', 'maxspeed:variable': 'yes' }), ['limit', 120, true]);
eq('variable Grund', V({ maxspeed: '100', 'maxspeed:variable': 'weather' }), ['limit', 100, true]);
eq('variable=no', V({ maxspeed: '100', 'maxspeed:variable': 'no' }), ['limit', 100, false]);
eq('variable ohne maxspeed', V({ 'maxspeed:variable': 'yes' }), ['variable', 0, true]);
eq('signals (veraltet)', V({ maxspeed: 'signals' }), ['variable', 0, true]);
eq('variable Stil = normales Limit', S({ maxspeed: '100', 'maxspeed:variable': 'yes' }).stripes, [[-0.5, 0.5, G100, '', '']]);
eq('variable Tooltip', api.signTooltip(D({ maxspeed: '120', 'maxspeed:variable': 'yes' })), '120 km/h\nmaxspeed=120\nmaxspeed:variable=yes');
eq('variable Gründe', D({ maxspeed: '120', 'maxspeed:variable': 'weather;peak_traffic' }).variableReasons, ['weather', 'peak_traffic']);
eq('variable Tafeln', api.variablePanels(D({ maxspeed: '120', 'maxspeed:variable': 'weather;school_zone;foo' })).map((p) => p.art || p.lines.join()), ['Wetter', '1012-50', 'foo']);
eq('variable yes ohne Tafel', api.variablePanels(D({ maxspeed: '120', 'maxspeed:variable': 'yes' })), []);
eq('variable:forward', [D({ maxspeed: '120', 'maxspeed:variable:forward': 'weather' }).variable, api.waySpeed({ highway: 'primary', maxspeed: '120', 'maxspeed:variable:forward': 'weather' }, []).backward.variable], [true, false]);
const NV = api.waySpeed({ highway: 'motorway', maxspeed: 'none', 'maxspeed:variable': 'yes' }, []).forward;
eq('none + variable: Richt 130, ohne Limit', [NV.status, NV.kmh, NV.advisory, NV.unlimited, NV.variable], ['limit', 130, true, true, true]);
eq('variable keine 274.1', SYM({ maxspeed: 'DE:zone30', 'maxspeed:variable': 'yes' }), '');
eq('Zeichen 325.1', [SYM({ highway: 'living_street' }), SYM({ highway: 'living_street', maxspeed: 'walk' }), SYM({ highway: 'living_street', maxspeed: '20' }), SYM({ highway: 'residential', maxspeed: 'walk' })], ['325.1', '325.1', '', '']);
eq('Tooltip 325.1', api.signTooltip(D({ highway: 'living_street' })), 'Verkehrsberuhigter Bereich (Zeichen 325.1): Schrittgeschwindigkeit\nhighway=living_street');
// 244.1 ist bei 30 das Hauptschild; bei anderem Tempo steht es daneben (bicycleRoad = auslösender Tag)
eq('Zeichen 244.1', [{ highway: 'residential', bicycle_road: 'yes' }, { highway: 'residential', cyclestreet: 'yes', maxspeed: '30' }, { highway: 'residential', bicycle_road: 'yes', maxspeed: '20' },
  { highway: 'residential', 'source:maxspeed': 'DE:bicycle_road', maxspeed: '30' }, { highway: 'residential', maxspeed: '30' }].map((t) => { const d = D(t); return [d.symbol, d.bicycleRoad]; }),
  [['244.1', 'bicycle_road=yes'], ['244.1', 'cyclestreet=yes'], ['', 'bicycle_road=yes'], ['244.1', 'source:maxspeed=DE:bicycle_road'], ['', '']]);
eq('Fahrradstraße ohne maxspeed → 30', short(D({ highway: 'residential', bicycle_road: 'yes' })), 'limit 30');
eq('Zeichen 274.1', [SYM({ maxspeed: 'DE:zone30' }), SYM({ maxspeed: 'DE:zone:30' }), SYM({ maxspeed: '30', 'zone:maxspeed': 'DE:30' }), SYM({ 'zone:maxspeed': 'DE:30' }), SYM({ maxspeed: 'DE:zone20' }), SYM({ maxspeed: '50', 'zone:maxspeed': 'DE:30' }), SYM({ maxspeed: '30', 'maxspeed:type': 'DE:urban' })],
  ['274.1', '274.1', '274.1', '274.1', '274.1-20', '', '']);
eq('Zeichen 242.1', [api.waySpeed({ highway: 'pedestrian' }, []).forward.symbol, api.signTooltip(api.waySpeed({ highway: 'pedestrian' }, []).forward)], ['242.1', 'Fußgängerzone (Zeichen 242.1)\nhighway=pedestrian']);
// Zusatzzeichen
const P = (raw) => api.conditionPanels({ raw, icon: '', label: '', kind: '' }).map((p) => p.art || p.lines.join(' / '));
eq('Zusatz Nässe', P('wet'), ['1053-35']);
eq('Zusatz Schnee', P('snow'), ['snow']);
eq('Zusatz Nebel', P('fog'), ['bei Nebel']);
eq('Zusatz Zeit', P('Mo-Fr 07:00-17:00'), ['Mo–Fr / 7–17 h']);
eq('Zusatz Zeiten', P('Mo-Fr 07:30-09:00,16:00-18:00'), ['Mo–Fr / 7.30–9, 16–18 h']);
eq('Zusatz mehrere Regeln', P('Mo-Fr 07:00-17:00; Sa 08:00-12:00'), ['Mo–Fr / 7–17 h / Sa / 8–12 h']);
eq('Zusatz nur Zeit', P('22:00-06:00'), ['22–6 h']);
eq('Zusatz Tage', P('Sa,Su,PH'), ['Sa, So / an Feiertagen']);
eq('Zusatz Ferien', P('SH'), ['in den Ferien']);
eq('Zusatz nachts', P('sunset-sunrise'), ['nachts']);
eq('Zusatz Monate', P('Nov-Mar'), ['Nov–Mär']);
eq('Zusatz 7,5 t', P('weight>7.5'), ['1053-33']);
eq('Zusatz 12 t', P('weight>12'), ['12 t']);
eq('Zusatz Lkw + Gewicht', P('weight>3.5 AND hgv'), ['3,5 t', '1010-51']);
eq('Zusatz Anhänger', P('trailer'), ['1010-59']);
eq('Zusatz unbekannt', P('Mo-Fr 07:00-17:00 "Schule"'), ['Mo-Fr 07:00-17:00…']);
eq('Zusatz Fahrzeug unter Hauptschild', api.mainPanels(api.waySpeed({ highway: 'primary', maxspeed: '100', 'maxspeed:hgv': '80' }, ['hgv']).forward).map((p) => p.art), ['1010-51']);
eq('Zusatz nur bedingt unter Hauptschild', api.mainPanels(D({ 'maxspeed:conditional': '30 @ (Mo-Fr 07:00-17:00)' })).map((p) => p.lines.join(' / ')), ['Mo–Fr / 7–17 h']);
api.setDisplay({ unit: 'mph', lang: 'en' });
eq('mph Schild', api.signLabel(D({ maxspeed: '30 mph' })), '30');
eq('mph Band', api.bandFor(D({ maxspeed: '30 mph' }).kmh).color, '#c6ff00'); // Band 26–30
eq('Tooltip Richtgeschw. en', api.signTooltip(D({ maxspeed: 'none' })), '81 mph – advisory speed, implicit\nmaxspeed=none');
eq('Tooltip Richtgeschw. getaggt en', api.signTooltip(D({ maxspeed: 'none', 'maxspeed:advisory': '120' })), '75 mph – advisory speed\nmaxspeed=none');
api.setDisplay({ unit: 'kmh', lang: 'de' });
eq('Bandtext', [api.bandLabel(api.colorBands()[0]), api.bandLabel(api.colorBands()[2]), api.bandLabel(api.colorBands()[12])], ['≤ 5', '30–39', '≥ 130']);
// Einstellungen aus der Nachricht
eq('Einstellungen kaputt', api.checkSettings({ enabled: 'ja', vehicle: '<b>', unit: 'x', hiddenExtras: [1, 'wet'] }),
  { enabled: true, signs: true, extras: true, legend: true, defaults: true, hiddenExtras: ['wet'], vehicle: 'car', hgvClass: '', unit: 'kmh', lang: 'de' });
api.setVehicles([['car', [], '🚗', 'PKW', 'Car'], ['hgv', ['hgv'], '🚛', 'LKW', 'Truck'], ['bad', ['x y'], '', '', ''], 'quatsch']);
eq('Fahrzeuge geprüft', [api.suffixesFor('hgv'), api.suffixesFor('bad'), api.suffixesFor('car')], [['hgv'], [], []]);
api.setVehicles('quatsch');
eq('Fahrzeuge bleiben', api.suffixesFor('hgv'), ['hgv']);

// Tag-Filter (Syntax wie osm-legal-default-speeds)
const F = (filter, tags, placeholders = {}) => api.compileTagFilter(filter)(tags, (name) => !!placeholders[name]);
eq('Filter =, !=, Schlüssel', [F('highway=primary', { highway: 'primary' }), F('highway!=primary', {}), F('lit', { lit: 'no' }), F('!lit', { lit: 'no' })], [true, true, true, false]);
eq('Filter ~ ganzer Wert', [F('highway~trunk|primary', { highway: 'primary' }), F('highway~trunk|primary', { highway: 'primary_link' }), F('highway!~trunk', {})], [true, false, true]);
eq('Filter Schlüssel-Regex', [F('~maxspeed:.*', { 'maxspeed:hgv': '80' }), F('~sidewalk.* ~ yes|both', { 'sidewalk:left': 'yes' }), F('!~sidewalk.*', { sidewalk: 'no' })], [true, true, false]);
eq('Filter Vergleich mit Einheit', [F('width<=7.6', { width: '7.5' }), F('width<=7.6', { width: '25 ft' }), F('lanes>=2', { lanes: 'zwei' })], [true, false, false]);
eq('Filter Klammern, and vor or', [F('a or b and c', { a: '1' }), F('(a or b) and c', { a: '1' }), F('!(a or b)', { c: '1' })], [true, false, true]);
eq('Filter Platzhalter und Anführung', [F('{rural} and ref~"(US|AL).*"', { ref: 'US 1' }, { rural: true }), F('!{urban}', {}, { urban: true })], [true, false]);
eq('Filter kaputt', ['highway=', '(a', 'a and', '"offen'].map((f) => { try { api.compileTagFilter(f); return 'ok'; } catch { return 'Fehler'; } }), ['Fehler', 'Fehler', 'Fehler', 'Fehler']);
let filterErrors = 0;
for (const f of Object.values(api.defaultSpeeds().roadTypes)) { try { if (f) api.compileTagFilter(f); } catch { filterErrors++; } }
eq('alle Filter der Tabelle lesbar', filterErrors, 0);

// Standardwerte des Landes (grau, wenn maxspeed fehlt); eigener Block wegen D oben
{
const D = (tags, veh = [], country = 'DE') => {
  const d = api.waySpeed(tags, veh, country).forward;
  const f = d && d.fallback;
  return f ? [d.status, Math.round(f.info.kmh), f.info.advisory ? 'richt' : '', f.roadType || 'übrige'].filter((x) => x !== '').join(' ') : d && d.status;
};
const URBAN = { 'zone:traffic': 'DE:urban' };
const RURAL = { 'zone:traffic': 'DE:rural' };
// Innerorts/außerorts nur aus Tags, die es sagen – nie aus lit, Gehweg oder residential
eq('DE ohne zone:traffic: offen', [D({ highway: 'primary' }), D({ highway: 'residential' }), D({ highway: 'primary', lit: 'yes', sidewalk: 'both' })], ['missing', 'missing', 'missing']);
eq('DE zone:traffic urban', D({ highway: 'residential', ...URBAN }), 'missing 50 urban');
eq('DE zone:traffic rural', D({ highway: 'primary', ...RURAL }), 'missing 100 rural');
eq('DE rural=no / source:maxspeed', [D({ highway: 'primary', rural: 'no' }), D({ highway: 'primary', 'source:maxspeed': 'sign', 'maxspeed:type': 'DE:rural' })], ['missing 50 urban', 'limit']);
eq('DE zone:traffic:left = :right', D({ highway: 'primary', 'zone:traffic:left': 'DE:urban', 'zone:traffic:right': 'DE:urban' }), 'missing 50 urban');
eq('DE zone:traffic:left ≠ :right: offen', D({ highway: 'primary', 'zone:traffic:left': 'DE:urban', 'zone:traffic:right': 'DE:rural' }), 'missing');
eq('DE Autobahn → Richt 130 (ohne zone:traffic)', D({ highway: 'motorway', oneway: 'yes' }), 'missing 130 richt motorway');
eq('DE zweibahnig außerorts → Richt 130', D({ highway: 'trunk', oneway: 'yes', dual_carriageway: 'yes', ...RURAL }), 'missing 130 richt rural dual carriageway');
eq('DE LKW außerorts', D({ highway: 'primary', ...RURAL }, ['hgv']), 'missing 80 rural');
eq('DE LKW innerorts: 80 gilt nicht über 50', D({ highway: 'residential', ...URBAN }, ['hgv']), 'missing 50 urban');
eq('DE Anhänger aus (trailer)', D({ highway: 'primary', ...RURAL }, ['trailer', 'caravan']), 'missing 80 rural');
eq('DE Bus', D({ highway: 'primary', ...RURAL }, ['bus']), 'missing 80 rural');
eq('DE Autobahn: Bus 80, Reisebus 100', [D({ highway: 'motorway', oneway: 'yes' }, ['bus']), D({ highway: 'motorway', oneway: 'yes' }, ['coach', 'bus'])], ['missing 80 motorway', 'missing 100 motorway']);
eq('getaggt geht vor', D({ highway: 'primary', maxspeed: '70', ...RURAL }), 'limit');
eq('Standardwerte aus', D({ highway: 'primary', ...RURAL }, [], null), 'missing');
eq('Land unbekannt, zone:traffic nennt es', [D({ highway: 'primary', ...RURAL }, [], ''), D({ highway: 'primary' }, [], '')], ['missing 100 rural', 'missing']);
eq('Region aus zone:traffic (BE-VLG)', [D({ highway: 'primary', 'zone:traffic': 'BE-VLG:rural' }, [], ''), D({ highway: 'primary', 'zone:traffic': 'BE-WAL:rural' }, [], '')], ['missing 70 rural', 'missing 90 rural']);
eq('zone:traffic eines anderen Landes zählt nicht als Tabelle', D({ highway: 'primary', 'zone:traffic': 'BE-VLG:rural' }, [], 'DE'), 'missing 100 rural');
eq('unbekanntes Land', D({ highway: 'primary', ...RURAL }, [], 'ZZ'), 'missing');
eq('Unterteilung ohne eigene Zeilen → Land', D({ highway: 'primary', ...RURAL }, [], 'DE-BY'), 'missing 100 rural');
eq('Land ohne innerorts/außerorts: übrige Straßen', [D({ highway: 'primary' }, [], 'HK'), D({ highway: 'primary' }, [], 'GG')], ['missing 50 übrige', 'missing 56 übrige']);
eq('Straßenart ohne Filter: offen (BR)', D({ highway: 'primary' }, [], 'BR'), 'missing');
eq('Fußweg bleibt ohne Schild', D({ highway: 'footway', ...URBAN }), 'noSpeed');
eq('nur LKW getaggt: PKW-Standardwert', D({ highway: 'primary', 'maxspeed:hgv': '60', ...RURAL }), 'missing 100 rural');
eq('Standardwert-Tooltip', api.defaultTooltip(api.waySpeed({ highway: 'residential', ...URBAN }, [], 'DE').forward.fallback).split('\n'),
  ['50 km/h', 'Standardwert des Landes – maxspeed ist nicht getaggt', 'Deutschland, Straßenart „urban“', 'Quelle: OSM-Wiki „Default speed limits“']);
// Farbig nur, was explizit als Zahl (none, walk) getaggt ist; alles andere grau
const GREY = (tags) => api.isGreySign(api.waySpeed({ highway: 'residential', ...tags }, [], 'DE').forward);
eq('farbig: explizit getaggt', [{ maxspeed: '50' }, { maxspeed: '50', 'source:maxspeed': 'DE:urban' }, { maxspeed: '30', 'zone:maxspeed': 'DE:30' },
  { highway: 'living_street', maxspeed: 'walk' }, { 'maxspeed:conditional': '30 @ wet' }, { 'maxspeed:advisory': '40' }, { highway: 'motorway', maxspeed: 'none', 'maxspeed:advisory': '120' },
  { highway: 'living_street' }, { highway: 'living_street', ...URBAN },
  // Autobahn: Richtgeschwindigkeit 130 gilt von sich aus (an der Grenze beschildert), wird nicht getaggt
  { highway: 'motorway', maxspeed: 'none' }, { highway: 'motorway_link', maxspeed: 'none' }, { highway: 'trunk', maxspeed: 'none', 'maxspeed:advisory': '130' }].map(GREY),
  [false, false, false, false, false, false, false, false, false, false, false, false]);
eq('grau: implizit oder Standardwert', [{ maxspeed: 'DE:urban' }, { 'source:maxspeed': 'DE:urban' }, { 'maxspeed:type': 'DE:urban' }, { 'zone:maxspeed': 'DE:30' },
  { bicycle_road: 'yes' }, { highway: 'trunk', maxspeed: 'none' }, { highway: 'motorway', maxspeed: 'DE:motorway' }, { highway: 'motorway', oneway: 'yes' }, URBAN].map(GREY),
  [true, true, true, true, true, true, true, true, true]);
api.setDisplay({ unit: 'kmh', lang: 'de' });
eq('verkehrsberuhigt: Zeichen 325.1, Linie ≤ 5', (() => { const s = api.lineStyleFor({ highway: 'living_street', ...URBAN }, [], 'DE'); return [s.signs[0].info.symbol, s.stripes[0].look.color]; })(),
  ['325.1', api.colorBands()[0].color]);
eq('kein Schild: fehlt ohne Standardwert', GREY({}), false);
// Tempo-30/20-Zone: farbig nur mit maxspeed; source:maxspeed / zone:maxspeed allein → graues Zeichen 274.1
const ZONE = (tags) => { const d = api.waySpeed({ highway: 'residential', ...tags }, [], 'DE').forward; return [d.kmh, d.symbol, api.isGreySign(d) ? 'grau' : 'farbig'].join(' '); };
eq('Zone 30', [{ maxspeed: '30', 'source:maxspeed': 'DE:zone30', 'zone:maxspeed': 'DE:30' }, { 'source:maxspeed': 'DE:zone30' }, { 'zone:maxspeed': 'DE:30' },
  { 'source:maxspeed': 'DE:zone30', 'zone:maxspeed': 'DE:30' }].map(ZONE), ['30 274.1 farbig', '30 274.1 grau', '30 274.1 grau', '30 274.1 grau']);
// Fahrradstraße (244.1): ohne maxspeed implizit 30 (grau); für Fahrzeuge freigegeben → maxspeed „fehlt“
const BR = (tags) => {
  const d = api.waySpeed({ highway: 'cycleway', ...tags }, [], 'DE').forward;
  const i = d.fallback ? d.fallback.info : d;
  // Hauptschild (Zahl oder Zeichen) und ob 244.1 daneben gezeichnet wird
  return [d.status, i.kmh, i.symbol || 'Zahl', i.bicycleRoad && i.symbol !== '244.1' ? '+244.1' : '', api.isGreySign(d) ? 'grau' : 'farbig'].filter(Boolean).join(' ');
};
eq('Fahrradstraße ohne maxspeed: graues 244.1', [{ bicycle_road: 'yes' }, { bicycle_road: 'yes', vehicle: 'no' }, { 'source:maxspeed': 'DE:bicycle_road' },
  { bicycle_road: 'yes', 'source:maxspeed': 'DE:bicycle_road' }].map(BR), ['limit 30 244.1 grau', 'limit 30 244.1 grau', 'limit 30 244.1 grau', 'limit 30 244.1 grau']);
eq('Fahrradstraße 30: farbiges 244.1; sonst Tempo/Zone + 244.1', [{ bicycle_road: 'yes', maxspeed: '30', 'source:maxspeed': 'DE:bicycle_road' }, { bicycle_road: 'yes', maxspeed: '20' },
  { bicycle_road: 'yes', maxspeed: '20', 'zone:maxspeed': 'DE:20', 'source:maxspeed': 'DE:zone20' }, { bicycle_road: 'yes', vehicle: 'destination', maxspeed: '30' }].map(BR),
  ['limit 30 244.1 farbig', 'limit 20 Zahl +244.1 farbig', 'limit 20 274.1-20 +244.1 farbig', 'limit 30 244.1 farbig']);
eq('Fahrradstraße freigegeben ohne maxspeed', [{ bicycle_road: 'yes', vehicle: 'destination' }, { bicycle_road: 'yes', motor_vehicle: 'yes' }, { bicycle_road: 'yes', vehicle: 'no', motorcar: 'destination' }].map(BR),
  ['missing 30 244.1 grau', 'missing 30 244.1 grau', 'missing 30 244.1 grau']);
eq('Fahrradstraße freigegeben: Tooltip', api.defaultTooltip(api.waySpeed({ highway: 'cycleway', bicycle_road: 'yes', vehicle: 'destination' }, [], 'DE').forward.fallback).split('\n'),
  ['Fahrradstraße (Zeichen 244.1): 30 km/h – implizit', 'bicycle_road=yes', 'maxspeed fehlt: Fahrradstraße für Fahrzeuge freigegeben (vehicle=destination)']);
// Die drei Fahrradstraßen aus OSM (Luisen-/Casinostraße, 2026-10-25): 30 → 244.1; 20 → Tempo bzw. Zone + 244.1
const OSM = [
  { bicycle: 'designated', bicycle_road: 'yes', highway: 'residential', lanes: '3', 'lanes:backward': '2', 'lanes:forward': '1', maxspeed: '30', motor_vehicle: 'destination', 'source:maxspeed': 'DE:bicycle_road', vehicle: 'destination' },
  { bicycle: 'designated', bicycle_road: 'yes', highway: 'residential', lanes: '2', maxspeed: '20', motor_vehicle: 'destination', oneway: 'yes', 'source:maxspeed': 'DE:bicycle_road', 'zone:maxspeed': 'DE:20' },
  { bicycle: 'designated', bicycle_road: 'yes', hgv: 'destination', highway: 'residential', lanes: '1', maxspeed: '20', motor_vehicle: 'destination', oneway: 'yes', 'source:maxspeed': 'DE:bicycle_road' },
];
eq('Fahrradstraßen aus OSM', OSM.map((t) => BR(t)), ['limit 30 244.1 farbig', 'limit 20 274.1-20 +244.1 farbig', 'limit 20 Zahl +244.1 farbig']);
eq('Fahrradstraße freigegeben: Linie „fehlt“', api.lineStyleFor({ highway: 'cycleway', bicycle_road: 'yes', motor_vehicle: 'yes' }, [], 'DE').stripes[0].look.color, '#e53935');
eq('Zone 20', [{ maxspeed: '20', 'source:maxspeed': 'DE:zone20', 'zone:maxspeed': 'DE:20' }, { 'source:maxspeed': 'DE:zone20' }, { 'zone:maxspeed': 'DE:20' },
  { 'source:maxspeed': 'DE:zone20', 'zone:maxspeed': 'DE:20' }].map(ZONE), ['20 274.1-20 farbig', '20 274.1-20 grau', '20 274.1-20 grau', '20 274.1-20 grau']);
// Zonen anderer Länder (2026-10-25): maxspeed:type=CH:zone30 ist in CH die übliche Form, nicht veraltet.
// Eigenes gemeinfreies Zeichen je Land, sonst das deutsche für 20/30; mph-Zonen (GB) ohne Zeichen.
const ZC = (tags, country = 'CH') => { const d = api.waySpeed({ highway: 'residential', ...tags }, [], country).forward; return [Math.round(d.kmh), d.symbol, api.isGreySign(d) ? 'grau' : 'farbig'].join(' '); };
eq('Zone CH', [{ maxspeed: '30', 'maxspeed:type': 'CH:zone30' }, { 'maxspeed:type': 'CH:zone30' }, { maxspeed: '30', 'zone:maxspeed': 'CH:30' }, { maxspeed: '30', 'source:maxspeed': 'CH:zone:30' },
  { maxspeed: '20', 'maxspeed:type': 'CH:zone20' }, { maxspeed: '50', 'maxspeed:type': 'CH:zone50' }, { maxspeed: '40', 'maxspeed:type': 'CH:zone30' }].map((t) => ZC(t)),
  ['30 CH-2.59.1 farbig', '30 CH-2.59.1 grau', '30 CH-2.59.1 farbig', '30 CH-2.59.1 farbig', '20 CH-2.59.5 farbig', '50  farbig', '40  farbig']);
eq('Zone andere Länder', [[{ maxspeed: '30', 'maxspeed:type': 'AT:zone30' }, 'AT'], [{ maxspeed: '40', 'source:maxspeed': 'PL:zone40' }, 'PL'], [{ maxspeed: '60', 'zone:maxspeed': 'NL:60' }, 'NL'],
  [{ maxspeed: '30', 'source:maxspeed': 'BE-VLG:zone30' }, 'BE'], [{ maxspeed: '30', 'zone:maxspeed': 'FR:30' }, 'FR'], [{ maxspeed: '20', 'zone:maxspeed': 'FR:20' }, 'FR'],
  [{ maxspeed: '30', 'maxspeed:type': 'CZ:zone30' }, 'CZ'], [{ maxspeed: '40', 'maxspeed:type': 'AT:zone40' }, 'AT'], [{ maxspeed: '20 mph', 'maxspeed:type': 'GB:zone20' }, 'GB'], [{ 'maxspeed:type': 'GB:zone20' }, 'GB']].map(([t, c]) => ZC(t, c)),
  ['30 AT-11a farbig', '40 PL-B-43-40 farbig', '60 NL-A1-60-ZB farbig', '30 BE-F4a farbig', '30 274.1 farbig', '20 FR-B52 farbig', '30 274.1 farbig', '40  farbig', '32  farbig', '32  grau']);
// Begegnungszone: highway=living_street ist in CH 20 (Signal 2.59.5), in DE/AT Schrittgeschwindigkeit (325.1)
const LS = (tags, country) => { const d = api.waySpeed({ highway: 'living_street', ...tags }, [], country).forward; return [d.status, d.kmh, d.symbol, api.isGreySign(d) ? 'grau' : 'farbig'].join(' '); };
eq('living_street je Land', [LS({}, 'CH'), LS({ maxspeed: '20' }, 'CH'), LS({ maxspeed: '10' }, 'CH'), LS({}, 'DE'), LS({}, 'AT'), LS({}, ''), LS({}, 'FR'), LS({}, 'NL')],
  ['limit 20 CH-2.59.5 farbig', 'limit 20 CH-2.59.5 farbig', 'limit 10  farbig', 'limit 5 325.1 farbig', 'limit 5 325.1 farbig', 'limit 5 325.1 farbig', 'limit 20 FR-B52 farbig', 'limit 15  farbig']);
eq('Begegnungszone Tooltip', api.signTooltip(api.waySpeed({ highway: 'living_street' }, [], 'CH').forward).split('\n')[0], 'Begegnungszone (Schweizer Signal 2.59.5): 20 km/h');
eq('Linie bleibt „fehlt“', JSON.stringify(api.lineStyleFor({ highway: 'primary', ...RURAL }, [], 'DE').stripes) === JSON.stringify(api.lineStyleFor({ highway: 'primary', ...RURAL }, []).stripes), true);
// Zusatzbedingungen der Standardwerte: PKW ohne Gewichts-/Lkw-Bedingungen, keine Dopplung mit dem Hauptwert
// (K 154, 2026-10-25: PKW zeigte 100 + 80 über 3,5 t + 60 über 7,5 t)
const EXTRAS = (veh) => { const d = api.waySpeed({ highway: 'tertiary', lanes: '2', ref: 'K 154', ...RURAL }, veh, 'DE').forward.fallback.info; return [d.kmh, ...d.extras.map((e) => `${e.kmh}@${e.raw}`)].join(' '); };
eq('Standardwert-Bedingungen je Fahrzeug', [[], ['hgv'], ['bus'], ['trailer', 'caravan']].map(EXTRAS),
  ['100', '80 60@weightrating>7.5', '80 60@weightrating>7.5 60@trailer', '80 60@weightrating>7.5']);
// Andere Fahrzeuge: maxspeed für alle über dem eigenen Standardwert gilt als nicht gesetzt (2026-10-25)
const V = (tags, veh) => { const d = api.waySpeed(tags, veh, 'DE').forward; return [d.status, Math.round((d.fallback ? d.fallback.info : d).kmh), api.isGreySign(d) ? 'grau' : 'farbig'].join(' '); };
eq('LKW: maxspeed über/unter Standardwert', [{ maxspeed: '100' }, { maxspeed: '70' }, { maxspeed: '80' }, { maxspeed: '100', 'maxspeed:hgv': '90' }, { maxspeed: '100' }].map((t, i) =>
  V({ highway: 'primary', ...RURAL, ...t }, i === 4 ? [] : ['hgv'])), ['missing 80 grau', 'limit 70 farbig', 'limit 80 farbig', 'limit 90 farbig', 'limit 100 farbig']);
eq('LKW Autobahn: none → Standard 80', V({ highway: 'motorway', oneway: 'yes', maxspeed: 'none' }, ['hgv']), 'missing 80 grau');
eq('LKW innerorts: 70 gilt (kein eigener Standardwert)', V({ highway: 'primary', ...URBAN, maxspeed: '70' }, ['hgv']), 'limit 70 farbig');
eq('LKW ohne innerorts/außerorts: getaggt bleibt', V({ highway: 'primary', maxspeed: '100' }, ['hgv']), 'limit 100 farbig');
eq('Reisebus Autobahn: maxspeed=120 → 100, maxspeed:bus=80 bleibt', [V({ highway: 'motorway', oneway: 'yes', maxspeed: '120' }, ['coach', 'bus']), V({ highway: 'motorway', oneway: 'yes', maxspeed: '120', 'maxspeed:bus': '80' }, ['coach', 'bus'])],
  ['missing 100 grau', 'limit 80 farbig']);
eq('Bus und Anhänger über Standardwert', [V({ highway: 'primary', ...RURAL, maxspeed: '100' }, ['bus']), V({ highway: 'primary', ...RURAL, 'maxspeed:motorcar': '100' }, ['trailer', 'caravan', 'motorcar'])],
  ['missing 80 grau', 'missing 80 grau']);
eq('über Standardwert: Tooltip', api.defaultTooltip(api.waySpeed({ highway: 'primary', ...RURAL, maxspeed: '100' }, ['hgv'], 'DE').forward.fallback).split('\n')[1],
  'Standardwert des Landes für dieses Fahrzeug – maxspeed=100 liegt darüber und gilt nicht');
eq('über Standardwert: getaggte Bedingung darunter bleibt', api.waySpeed({ highway: 'primary', ...RURAL, maxspeed: '100', 'maxspeed:conditional': '60 @ wet' }, ['hgv'], 'DE').forward.fallback.info.extras.map((e) => e.kmh + e.kind),
  ['60wet', '60vehicle']);
// LKW-Klassen nach zulässiger Gesamtmasse (2026-10-25): Bedingung für die ganze Klasse → Hauptwert,
// für keinen → entfällt, für einen Teil → Zusatzschild
const CLASSES = { C1: { min: 3.5, max: 7.5 }, C: { min: 7.5, max: 18 }, CE: { min: 18, max: 44 }, N2: { min: 3.5, max: 12 }, N3: { min: 12, max: Infinity } };
const M = (cond, cls) => api.weightConditionMet(cond, CLASSES[cls], ['hgv']);
eq('Gewichtsbedingung je Klasse', ['C1', 'C', 'CE', 'N2', 'N3'].map((c) => M('weightrating>7.5', c)), [false, true, true, null, true]);
eq('Gewichtsbedingung Operatoren', [M('weight<=7.5', 'C1'), M('weight<7.5', 'C1'), M('weight>=12', 'N3'), M('maxweightrating>12', 'C'), M('weight>12 AND trailer', 'N3'), M('hgv AND weight>7.5', 'C'), M('wet', 'C')],
  [true, null, true, null, null, true, null]);
const K = (tags, cls) => { const d = api.waySpeed({ highway: 'primary', ...tags }, ['hgv'], 'DE', CLASSES[cls] || null).forward; const i = d.fallback ? d.fallback.info : d;
  return [d.status, Math.round(i.kmh), ...i.extras.map((e) => `${e.kmh}@${e.raw}`), api.isGreySign(d) ? 'grau' : 'farbig'].join(' '); };
eq('DE außerorts Standardwert je Klasse', ['', 'C1', 'C', 'CE', 'N2', 'N3'].map((c) => K(RURAL, c)),
  ['missing 80 60@weightrating>7.5 grau', 'missing 80 grau', 'missing 60 grau', 'missing 60 grau', 'missing 80 60@weightrating>7.5 grau', 'missing 60 grau']);
eq('getaggt: hgv:conditional je Klasse', ['', 'C1', 'C'].map((c) => K({ ...RURAL, 'maxspeed:hgv': '80', 'maxspeed:hgv:conditional': '60 @ (weight>7.5)' }, c)),
  ['limit 80 60@weight>7.5 farbig', 'limit 80 farbig', 'limit 60 farbig']);
eq('Klasse C: maxspeed=70 über eigenem Standardwert 60', K({ ...RURAL, maxspeed: '70' }, 'C'), 'missing 60 grau');
eq('Klasse C1: maxspeed=70 gilt', K({ ...RURAL, maxspeed: '70' }, 'C1'), 'limit 70 farbig');
// L 318 (2026-10-25): maxspeed:forward=70 getaggt, N2 – „60 über 7,5 t“ gilt weiter, grau als Standardwert
const L318 = { highway: 'secondary', lanes: '2', 'maxspeed:backward': '100', 'maxspeed:forward': '70', 'source:maxspeed:backward': 'DE:rural', 'source:maxspeed:forward': 'sign', 'zone:traffic': 'DE:rural' };
const EX = (veh, cls) => { const d = api.waySpeed(L318, veh, 'DE', CLASSES[cls] || null).forward; return [d.status, d.kmh, ...d.extras.map((e) => `${e.kmh}${e.fromDefault ? 'grau' : ''}`)].join(' '); };
eq('getaggter Wert + Standard-Bedingung darunter', [EX(['hgv']), EX(['hgv'], 'N2'), EX(['hgv'], 'C1'), EX(['motorcar'])], ['limit 70 60grau', 'limit 70 60grau', 'limit 70', 'limit 70']);
api.setHgvClasses([['C', 7.5, 18, 'DE', 'C de', 'C en'], ['N3', 12, null, 'EU', 'N3 de', 'N3 en'], ['bad', '1', 2]]);
eq('Klasse aus Einstellungen', [api.weightOf({ vehicle: 'hgv', hgvClass: 'C' }), api.weightOf({ vehicle: 'hgv', hgvClass: 'N3' }), api.weightOf({ vehicle: 'bus', hgvClass: 'C' }), api.weightOf({ vehicle: 'hgv', hgvClass: '' })],
  [{ min: 7.5, max: 18 }, { min: 12, max: null }, null, null]);
eq('getaggte Bedingung bleibt beim PKW', api.waySpeed({ highway: 'tertiary', maxspeed: '100', 'maxspeed:conditional': '60 @ (weight>7.5)' }, [], 'DE').forward.extras.length, 1);
}

console.log(fail ? `${fail} Tests fehlgeschlagen` : 'Alle Tests bestanden');
process.exitCode = fail ? 1 : 0;
