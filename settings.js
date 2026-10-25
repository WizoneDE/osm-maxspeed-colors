// @ts-check
/**
 * OSM Maxspeed Colors – shared settings and lookup tables.
 *
 * Loaded before popup.js (toolbar popup) and before bridge.js (isolated world),
 * which both use these definitions directly.
 *
 * content.js (page world) can NOT use them directly: Chrome does not share
 * top-level variables between scripts injected into the page world. bridge.js
 * therefore sends the cleaned settings and the tables to content.js in its
 * settings message. Keeping the tables here means popup and map never disagree.
 */

/**
 * @typedef {object} Settings
 * @property {boolean} enabled       Colour the roads at all.
 * @property {boolean} signs         Draw speed-limit signs on the roads.
 * @property {boolean} extras        Draw the small extra signs for conditional limits (wet, times …).
 * @property {string[]} hiddenExtras Kinds of extra signs the user switched off (keys of OMC_EXTRA_TYPES).
 * @property {boolean} defaults      Show the country's legal default as a grey sign where maxspeed is missing.
 * @property {boolean} legend        Show the legend box on the map.
 * @property {string} vehicle        Key of OMC_VEHICLES, e.g. "car" or "hgv".
 * @property {string} hgvClass       Key of OMC_HGV_CLASSES for trucks, e.g. "C1"; "" = no filter.
 * @property {'kmh'|'mph'} unit      Display unit. Values are converted to km/h internally.
 * @property {'de'|'en'} lang        Language of popup, legend and tooltips.
 */

/**
 * Vehicle types offered in the popup: [key, OSM suffixes tried in order, icon, German, English].
 * maxspeed:<suffix> is looked up first, then plain maxspeed (which applies to every
 * vehicle). A car with a trailer is still a motorcar, so maxspeed:motorcar comes last.
 * @type {ReadonlyArray<readonly [string, ReadonlyArray<string>, string, string, string]>}
 */
const OMC_VEHICLES = [
  ['car', ['motorcar'], '🚗', 'PKW (motorcar)', 'Car (motorcar)'],
  ['hgv', ['hgv'], '🚛', 'LKW (hgv)', 'Truck (hgv)'],
  ['bus', ['bus'], '🚌', 'Bus / Linienbus / Stadtbus (bus)', 'Bus / city bus (bus)'],
  // A coach is a bus too: without a value of its own, maxspeed:bus applies.
  ['coach', ['coach', 'bus'], '🚍', 'Reisebus (coach)', 'Coach (coach)'],
  ['trailer', ['trailer', 'caravan', 'motorcar'], '🚐', 'Anhänger (trailer, caravan)', 'Trailer (trailer, caravan)'],
];

/**
 * Classes of trucks (hgv) by permissible maximum mass, offered in the popup once
 * "hgv" is chosen: [key, more than … t, at most … t (null = open), group, German, English].
 * Weight conditions ("60 @ (weightrating>7.5)") are judged against this range:
 * met by the whole class → main value, by none → left out, by part → extra sign.
 * @type {ReadonlyArray<readonly [string, number, number | null, 'DE' | 'EU', string, string]>}
 */
const OMC_HGV_CLASSES = [
  ['C1', 3.5, 7.5, 'DE', 'C1: leichte Lkw (3,5–7,5 t)', 'C1: light trucks (3.5–7.5 t)'],
  ['C', 7.5, 18, 'DE', 'C: mittelschwere Lkw (7,5–18 t)', 'C: medium trucks (7.5–18 t)'],
  ['CE', 18, 44, 'DE', 'CE: schwere Lkw, Lastzüge (18–44 t)', 'CE: heavy trucks, road trains (18–44 t)'],
  ['N2', 3.5, 12, 'EU', 'N2: mittelschwere Lkw (3,5–12 t)', 'N2: medium trucks (3.5–12 t)'],
  ['N3', 12, null, 'EU', 'N3: schwere Lkw (über 12 t)', 'N3: heavy trucks (over 12 t)'],
];

/** Default settings, used until the user changes something in the popup. @type {Readonly<Settings>} */
const OMC_DEFAULTS = Object.freeze({
  enabled: true,
  signs: true,
  extras: true,
  hiddenExtras: [],
  defaults: true,
  legend: true,
  vehicle: 'car',
  hgvClass: '',
  unit: 'kmh',
  lang: 'de',
});

/**
 * Ways that normally carry no speed limit. Without any maxspeed tag they are drawn
 * as a thin white dashed line instead of "missing". If they do have a maxspeed tag,
 * that value is shown as usual.
 * Each entry: [tag, value, German name, English name].
 * @type {ReadonlyArray<readonly [string, string, string, string]>}
 */
const OMC_NO_SPEED = [
  ['highway', 'footway', 'Fußweg', 'Footway'],
  ['highway', 'path', 'Weg', 'Path'],
  ['highway', 'cycleway', 'Radweg', 'Cycleway'],
  ['highway', 'bridleway', 'Reitweg', 'Bridleway'],
  ['highway', 'steps', 'Treppe', 'Steps'],
  ['highway', 'pedestrian', 'Fußgängerzone', 'Pedestrian'],
  ['highway', 'corridor', 'Gang', 'Corridor'],
  ['highway', 'track', 'Wirtschaftsweg', 'Track'],
  ['service', 'parking_aisle', 'Parkplatzgasse', 'Parking aisle'],
  ['service', 'driveway', 'Grundstückszufahrt', 'Driveway'],
];

/**
 * Kinds of extra signs (conditional speed limits), shown as checkboxes in the popup
 * and in the legend. Each entry: [key, icon, short German, short English, German
 * tooltip, English tooltip]. Which condition belongs to which key is decided in
 * content.js (conditionKind).
 * @type {ReadonlyArray<readonly [string, string, string, string, string, string]>}
 */
const OMC_EXTRA_TYPES = [
  ['wet', '💧', 'Nässe', 'Wet', 'bei Nässe (wet)', 'when wet'],
  ['snow', '🌨️', 'Schnee/Eis', 'Snow/ice', 'bei Schnee oder Eis (snow, ice)', 'snow or ice'],
  ['fog', '🌫️', 'Nebel', 'Fog', 'bei Nebel (fog)', 'in fog'],
  ['daytime', '🌙', 'Tageszeit', 'Time of day', 'nachts, tagsüber, Sonnenauf-/-untergang', 'night, day, sunrise/sunset'],
  ['time', '🕒', 'Uhrzeit/Tage', 'Times/days', 'Uhrzeiten, Wochentage, Zeiträume', 'times, weekdays, periods'],
  ['school', '🏫', 'Schulzeit', 'School', 'Schulzeiten (school)', 'school hours'],
  ['holiday', '🏖️', 'Feiertage', 'Holidays', 'Feiertage, Ferien (PH, SH)', 'public/school holidays (PH, SH)'],
  ['season', '🍂', 'Jahreszeit', 'Season', 'Monate und Jahreszeiten', 'months and seasons'],
  ['vehicle', '⚖️', 'Fahrzeug', 'Vehicle', 'Gewicht, Länge, Anhänger … (weight>7.5)', 'weight, length, trailer … (weight>7.5)'],
  ['other', '❔', 'Sonstige', 'Other', 'andere Bedingung', 'other condition'],
];

/**
 * Turns whatever came out of storage or a message into valid Settings.
 * Unknown keys are dropped, wrong types fall back to the default.
 * @param {unknown} input
 * @returns {Settings}
 */
function omcCleanSettings(input) {
  /** @type {Record<string, unknown>} */
  const s = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  /** @param {keyof Settings} key @param {boolean} fallback */
  const bool = (key, fallback) => (typeof s[key] === 'boolean' ? /** @type {boolean} */ (s[key]) : fallback);
  const knownExtras = new Set(OMC_EXTRA_TYPES.map(([key]) => key));
  const knownVehicles = new Set(OMC_VEHICLES.map(([key]) => key));
  return {
    enabled: bool('enabled', OMC_DEFAULTS.enabled),
    signs: bool('signs', OMC_DEFAULTS.signs),
    extras: bool('extras', OMC_DEFAULTS.extras),
    defaults: bool('defaults', OMC_DEFAULTS.defaults),
    legend: bool('legend', OMC_DEFAULTS.legend),
    hiddenExtras: Array.isArray(s.hiddenExtras)
      ? s.hiddenExtras.filter((k) => typeof k === 'string' && knownExtras.has(k))
      : [],
    vehicle: typeof s.vehicle === 'string' && knownVehicles.has(s.vehicle) ? s.vehicle : OMC_DEFAULTS.vehicle,
    hgvClass: OMC_HGV_CLASSES.some(([key]) => key === s.hgvClass) ? /** @type {string} */ (s.hgvClass) : '',
    unit: s.unit === 'mph' ? 'mph' : 'kmh',
    lang: s.lang === 'en' ? 'en' : 'de',
  };
}
