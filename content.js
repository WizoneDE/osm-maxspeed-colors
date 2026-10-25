// @ts-check
/**
 * OSM Maxspeed Colors – map script (runs in the page's own "MAIN" world).
 *
 * WHAT IT DOES
 *   Colours every road in the OpenStreetMap editor iD by its speed limit, draws
 *   speed-limit signs on the roads and shows a small legend. Roads with different
 *   limits per direction are drawn as two halves, roads with limits per lane as
 *   one stripe per lane. Ways that normally have no speed limit (footways,
 *   stairs …) become a thin white dashed line.
 *
 * WHERE THE DATA COMES FROM
 *   iD attaches each way's data to its SVG <path> element (d3 data binding),
 *   readable as `path.__data__`, including the OSM tags. Only scripts in the page's
 *   own world can see that property, which is why this script runs with
 *   `world: "MAIN"`. Nothing is loaded from the network.
 *
 *   On openstreetmap.org iD runs in an iframe at /id (the page /edit embeds it).
 *   The script only starts on those paths, once iD's map layer exists.
 *
 * SETTINGS
 *   The toolbar popup stores the settings in chrome.storage. This script cannot
 *   read chrome.storage from the page world, so bridge.js forwards them with
 *   window.postMessage, together with the tables from settings.js (ways without a
 *   speed limit, kinds of extra signs, vehicle types).
 *
 *   This file must not use anything defined in settings.js directly: Chrome does
 *   not share top-level variables between scripts injected into the page world,
 *   so such a reference fails at runtime. Everything it needs from settings.js
 *   arrives in the settings message and is type-checked here.
 */
(() => {
  'use strict';

  // ===========================================================================
  // Types (JSDoc, checked with `tsc --checkJs`)
  // ===========================================================================

  /** @typedef {Record<string, string>} Tags  OSM tags of a way, e.g. { highway: "primary" }. */

  /**
   * Human-readable meaning of a condition (maxspeed:conditional).
   * @typedef {object} Condition
   * @property {string} icon   Emoji shown on the extra sign, e.g. 💧.
   * @property {string} label  Text for the tooltip, e.g. "bei Nässe".
   * @property {string} raw    The original condition, e.g. "Mo-Fr 07:00-17:00".
   * @property {string} kind   Key from OMC_EXTRA_TYPES, used by the popup filter.
   */

  /**
   * A conditional limit shown as a small extra sign. `fromDefault`: not tagged but the
   * country's default for this vehicle, shown in grey next to a tagged value.
   * @typedef {Condition & { kmh: number, fromDefault?: boolean }} ExtraLimit
   */

  // ===========================================================================
  // Language and unit
  // ===========================================================================
  // Set from the popup settings. Values are always converted to km/h; mph is only
  // used for display.

  /** @type {'de'|'en'} */ let LANG = 'de';
  /** @type {'kmh'|'mph'} */ let UNIT = 'kmh';
  const KMH_PER_MPH = 1.609344;

  /** Speed as shown to the user, in the selected unit. @param {number} kmh */
  const shown = (kmh) => Math.round(UNIT === 'mph' ? kmh / KMH_PER_MPH : kmh);
  const unitLabel = () => (UNIT === 'mph' ? 'mph' : 'km/h');

  /** @param {{ lang?: string, unit?: string }} settings */
  function setDisplay(settings) {
    LANG = settings.lang === 'en' ? 'en' : 'de';
    UNIT = settings.unit === 'mph' ? 'mph' : 'kmh';
  }

  /** Vehicle keys and OSM suffixes are plain words such as "hgv" or "car". */
  const VEHICLE_KEY = /^[a-z_]{1,30}$/;

  /**
   * Checks settings that arrive by window.postMessage. bridge.js already cleans them
   * with omcCleanSettings (settings.js), but any script on the page could send a
   * message of the same shape, so the types are checked again here. Wrong values
   * fall back to the defaults. (settings.js itself is not reachable from here, see
   * the note at the top of this file.)
   * @param {unknown} input
   * @returns {Settings}
   */
  function checkSettings(input) {
    /** @type {Record<string, unknown>} */
    const s = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
    /** @param {string} key */
    const isOn = (key) => (typeof s[key] === 'boolean' ? /** @type {boolean} */ (s[key]) : true);
    return {
      enabled: isOn('enabled'),
      signs: isOn('signs'),
      extras: isOn('extras'),
      legend: isOn('legend'),
      defaults: isOn('defaults'),
      hiddenExtras: Array.isArray(s.hiddenExtras) ? s.hiddenExtras.filter((k) => typeof k === 'string').slice(0, 50) : [],
      vehicle: typeof s.vehicle === 'string' && VEHICLE_KEY.test(s.vehicle) ? s.vehicle : 'car',
      hgvClass: typeof s.hgvClass === 'string' && /^[A-Z0-9]{1,4}$/.test(s.hgvClass) ? s.hgvClass : '',
      unit: s.unit === 'mph' ? 'mph' : 'kmh',
      lang: s.lang === 'en' ? 'en' : 'de',
    };
  }

  // Ways that normally carry no speed limit, as [tag, value] pairs.
  // The list lives in settings.js (OMC_NO_SPEED) and arrives with the settings.
  /** @type {Array<[string, string]>} */
  let noSpeedRules = [];

  /**
   * Accepts a new "no speed" list. Only [string, string, …] entries are kept,
   * because the message could also come from another script on the page.
   * @param {unknown} list
   */
  function setNoSpeedRules(list) {
    if (!Array.isArray(list)) return;
    noSpeedRules = list
      .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')
      .slice(0, 100)
      .map((e) => [e[0], e[1]]);
  }

  // Kinds of extra signs for the legend: [key, icon, short German, short English].
  // From OMC_EXTRA_TYPES in settings.js, also delivered with the settings message.
  /** @type {Array<[string, string, string, string]>} */
  let extraTypes = [];

  /** Accepts the list of extra-sign kinds; only string entries are kept. @param {unknown} list */
  function setExtraTypes(list) {
    if (!Array.isArray(list)) return;
    extraTypes = list
      .filter((e) => Array.isArray(e) && e.length >= 4 && e.slice(0, 4).every((v) => typeof v === 'string'))
      .slice(0, 50)
      .map((e) => [e[0], e[1], e[2], e[3]]);
  }

  /**
   * Vehicle types: [key, OSM suffixes tried in order, icon, German, English].
   * From OMC_VEHICLES in settings.js; until the first message only cars are known.
   * @typedef {[string, string[], string, string, string]} Vehicle
   */
  /** @type {Vehicle[]} */
  let vehicles = [['car', ['motorcar'], '🚗', 'PKW (motorcar)', 'Car (motorcar)']];

  /** Accepts the vehicle list; entries of the wrong shape are dropped. @param {unknown} list */
  function setVehicles(list) {
    if (!Array.isArray(list)) return;
    /** @type {Vehicle[]} */
    const valid = [];
    for (const e of list.slice(0, 20)) {
      if (!Array.isArray(e) || e.length < 5) continue;
      const [key, suffixes, icon, de, en] = e;
      if (typeof key !== 'string' || !VEHICLE_KEY.test(key)) continue;
      if (!Array.isArray(suffixes) || !suffixes.every((v) => typeof v === 'string' && VEHICLE_KEY.test(v))) continue;
      if (![icon, de, en].every((v) => typeof v === 'string')) continue;
      valid.push([key, suffixes.slice(0, 5), String(icon).slice(0, 8), String(de).slice(0, 60), String(en).slice(0, 60)]);
    }
    if (valid.length) vehicles = valid;
  }

  /** OSM suffixes for a vehicle key, e.g. "hgv" → ["hgv"]; [] (plain maxspeed) if unknown. @param {string} key */
  const suffixesFor = (key) => vehicles.find(([k]) => k === key)?.[1] ?? [];

  /**
   * Truck classes by permissible maximum mass: [key, more than … t, at most … t
   * (null = open), German, English]. From OMC_HGV_CLASSES in settings.js.
   * @typedef {[string, number, number | null, string, string]} HgvClass
   */
  /** @type {HgvClass[]} */
  let hgvClasses = [];

  /** Accepts the truck classes; entries of the wrong shape are dropped. @param {unknown} list */
  function setHgvClasses(list) {
    if (!Array.isArray(list)) return;
    hgvClasses = list
      .filter((e) => Array.isArray(e) && e.length >= 6 && typeof e[0] === 'string' && typeof e[1] === 'number'
        && (typeof e[2] === 'number' || e[2] === null) && typeof e[4] === 'string' && typeof e[5] === 'string')
      .slice(0, 20)
      .map((e) => [String(e[0]).slice(0, 8), e[1], e[2], String(e[4]).slice(0, 60), String(e[5]).slice(0, 60)]);
  }

  /**
   * Weight range of the chosen truck class, null without one (or for other vehicles).
   * @param {Settings} s
   * @returns {WeightRange | null}
   */
  function weightOf(s) {
    const c = s.vehicle === 'hgv' ? hgvClasses.find(([key]) => key === s.hgvClass) : undefined;
    return c ? { min: c[1], max: c[2] ?? Infinity } : null;
  }

  const TEXT = {
    de: {
      drag: 'Ziehen zum Verschieben',
      expand: 'Legende aufklappen',
      collapse: 'Legende einklappen',
      advisoryOnly: 'Richtgeschwindigkeit (none, :advisory)',
      conditionalOnly: 'nur bedingt (:conditional)',
      lanes: 'je Spur (:lanes), Spur 1 links',
      split: 'je Richtung: rechts = Zeichenrichtung',
      variable: 'variabel ohne maxspeed (:variable, signals)',
      variableExtra: (/** @type {string} */ max) => `Wechselverkehrszeichen, höchstens ${max}`,
      variableExtraNone: 'Wechselverkehrszeichen, sonst ohne Limit (Zeichen 282)',
      variableExtraLegend: 'Wechselverkehrszeichen',
      missing: 'fehlt (Fahrzeug)',
      missingRestricted: 'fehlt, Zufahrt beschränkt (access) oder highway=service',
      noSpeed: 'Fußweg u. ä. ohne maxspeed',
      advisory: 'Richtgeschwindigkeit',
      implicit: 'implizit',
      walk: 'Schrittgeschwindigkeit',
      defaultValue: 'Standardwert des Landes – maxspeed ist nicht getaggt',
      aboveDefault: (/** @type {string} */ tag) => `Standardwert des Landes für dieses Fahrzeug – ${tag} liegt darüber und gilt nicht`,
      defaultRoad: (/** @type {string} */ country, /** @type {string} */ road) =>
        `${country}, ${road ? `Straßenart „${road}“` : 'übrige Straßen'}`,
      defaultSource: 'Quelle: OSM-Wiki „Default speed limits“',
      defaultsLegend: 'graues Schild: implizit oder Standardwert',
      bicycleRoadOpen: (/** @type {string} */ tag) => `maxspeed fehlt: Fahrradstraße für Fahrzeuge freigegeben (${tag})`,
      symbols: {
        '325.1': 'Verkehrsberuhigter Bereich (Zeichen 325.1)',
        '242.1': 'Fußgängerzone (Zeichen 242.1)',
        '244.1': 'Fahrradstraße (Zeichen 244.1)',
        '274.1': 'Tempo-30-Zone (Zeichen 274.1)',
        '274.1-20': 'Tempo-20-Zone (Zeichen 274.1-20)',
        'AT-11a': 'Tempo-30-Zone (österreichisches Zeichen 11a)',
        'BE-F4a': 'Tempo-30-Zone (belgisches Zeichen F4a)',
        'CH-2.59.1': 'Tempo-30-Zone (Schweizer Signal 2.59.1)',
        'CH-2.59.5': 'Begegnungszone (Schweizer Signal 2.59.5)',
        'FR-B52': 'Begegnungszone (französisches Zeichen B52)',
        'IT-II-323a': 'Tempo-30-Zone (italienisches Zeichen II 323/a)',
        'NL-A1-30-ZB': 'Tempo-30-Zone (niederländisches Zeichen A1)',
        'NL-A1-60-ZB': 'Tempo-60-Zone (niederländisches Zeichen A1)',
        'NO-366-30': 'Tempo-30-Zone (norwegisches Zeichen 366)',
        'PL-B-43-20': 'Tempo-20-Zone (polnisches Zeichen B-43)',
        'PL-B-43-30': 'Tempo-30-Zone (polnisches Zeichen B-43)',
        'PL-B-43-40': 'Tempo-40-Zone (polnisches Zeichen B-43)',
        'SI-III-29-40': 'Tempo-40-Zone (slowenisches Zeichen III-29)',
      },
      variableSign: 'variabel (Wechselverkehrszeichen)',
      hint: 'Maus über ein Schild zeigt Tag und Bedingung.',
      legendTitle: 'Speed Restriction – Legende',
      vehicleHeading: 'Fahrzeug',
      hgvClassHeading: 'Klasse',
      unitHeading: 'Einheit',
      speedsHeading: 'Geschwindigkeiten',
      distinctionsHeading: 'Abgrenzungen',
      extrasHeading: 'Zusatzschilder',
    },
    en: {
      drag: 'Drag to move',
      expand: 'Expand legend',
      collapse: 'Collapse legend',
      advisoryOnly: 'advisory speed (none, :advisory)',
      conditionalOnly: 'conditional only (:conditional)',
      lanes: 'per lane (:lanes), lane 1 left',
      split: 'per direction: right = drawing direction',
      variable: 'variable without maxspeed (:variable, signals)',
      variableExtra: (/** @type {string} */ max) => `Electronic signs, at most ${max}`,
      variableExtraNone: 'Electronic signs, otherwise no limit (German sign 282)',
      variableExtraLegend: 'Electronic signs',
      missing: 'missing (vehicle)',
      missingRestricted: 'missing, restricted access (access) or highway=service',
      noSpeed: 'footway etc. without maxspeed',
      advisory: 'advisory speed',
      implicit: 'implicit',
      walk: 'walking pace',
      defaultValue: 'Default of the country – maxspeed is not tagged',
      aboveDefault: (/** @type {string} */ tag) => `Default of the country for this vehicle – ${tag} is above it and does not apply`,
      defaultRoad: (/** @type {string} */ country, /** @type {string} */ road) =>
        `${country}, ${road ? `road type “${road}”` : 'other roads'}`,
      defaultSource: 'Source: OSM wiki “Default speed limits”',
      defaultsLegend: 'grey sign: implicit or default',
      bicycleRoadOpen: (/** @type {string} */ tag) => `maxspeed missing: bicycle road open to vehicles (${tag})`,
      symbols: {
        '325.1': 'Living street (German sign 325.1)',
        '242.1': 'Pedestrian zone (German sign 242.1)',
        '244.1': 'Bicycle road (German sign 244.1)',
        '274.1': '30 zone (German sign 274.1)',
        '274.1-20': '20 zone (German sign 274.1-20)',
        'AT-11a': '30 zone (Austrian sign 11a)',
        'BE-F4a': '30 zone (Belgian sign F4a)',
        'CH-2.59.1': '30 zone (Swiss sign 2.59.1)',
        'CH-2.59.5': 'Meeting zone (Swiss sign 2.59.5)',
        'FR-B52': 'Meeting zone (French sign B52)',
        'IT-II-323a': '30 zone (Italian sign II 323/a)',
        'NL-A1-30-ZB': '30 zone (Dutch sign A1)',
        'NL-A1-60-ZB': '60 zone (Dutch sign A1)',
        'NO-366-30': '30 zone (Norwegian sign 366)',
        'PL-B-43-20': '20 zone (Polish sign B-43)',
        'PL-B-43-30': '30 zone (Polish sign B-43)',
        'PL-B-43-40': '40 zone (Polish sign B-43)',
        'SI-III-29-40': '40 zone (Slovenian sign III-29)',
      },
      variableSign: 'variable (electronic signs)',
      hint: 'Hover over a sign to see its tag and condition.',
      legendTitle: 'Speed Restriction – Legend',
      vehicleHeading: 'Vehicle',
      hgvClassHeading: 'Class',
      unitHeading: 'Unit',
      speedsHeading: 'Speeds',
      distinctionsHeading: 'Distinctions',
      extrasHeading: 'Extra signs',
    },
  };
  /** Texts in the current language. */
  const text = () => TEXT[LANG];

  // ===========================================================================
  // Reading OSM speed tags
  // ===========================================================================
  // Everything comes straight from the way's tags in iD; nothing is loaded.
  //
  //   maxspeed=50                     limit for everybody
  //   maxspeed:forward / :backward    per direction (forward = drawing direction)
  //   maxspeed:hgv=60                 per vehicle type (see OMC_VEHICLES)
  //   maxspeed:hgv:forward=60         per vehicle type and direction
  //   maxspeed:lanes=100|80|60        per lane, left to right in driving direction
  //   maxspeed:lanes:forward=…        per lane and direction
  //   maxspeed:conditional=80 @ wet; 30 @ (Mo-Fr 07:00-17:00)
  //   maxspeed:advisory=130           recommended speed
  //   maxspeed=none                   no limit (German motorways: advisory 130)
  //   maxspeed=DE:urban, zone:maxspeed=DE:30 …   implicit limits by type of area

  /** @typedef {'forward' | 'backward'} Direction */

  /**
   * One speed value as written in OSM.
   * @typedef {object} SpeedValue
   * @property {'limit'|'none'|'walk'|'variable'} kind
   * @property {number} kmh            Converted to km/h (0 for none/variable).
   * @property {boolean} implicit      Came from a code like "DE:urban" instead of a number.
   * @property {string} raw            The original text.
   */

  /** Walking pace in km/h. 5, so that it falls into the colour band "≤ 5" (7 used to land in 6–29). */
  const WALK_KMH = 5;

  /** Implicit limits "CC:type"; DEFAULT unless the country is listed. Values in km/h. */
  const IMPLICIT = {
    urban: { DEFAULT: 50 },
    rural: { DEFAULT: 100, AT: 100, CH: 80, FR: 80, DK: 80, NL: 80, BE: 90, IT: 90, ES: 90, GB: 96.56 },
    motorway: { DEFAULT: 130, DE: Infinity, CH: 120, NL: 100, GB: 112.65 },
    trunk: { DEFAULT: 100, DE: Infinity, CH: 100 },
    living_street: { DEFAULT: WALK_KMH },
    pedestrian_zone: { DEFAULT: WALK_KMH },
    bicycle_road: { DEFAULT: 30 },
    walk: { DEFAULT: WALK_KMH },
  };

  const KMH_PER_KNOT = 1.852;

  /** Countries whose codes count in mph (GB:zone20 = 20 mph). */
  const MPH_COUNTRIES = new Set(['GB', 'US', 'IM', 'JE', 'GG', 'LR', 'MM']);

  /**
   * Parses one OSM speed value. Returns null for anything unreadable.
   * @param {unknown} value
   * @returns {SpeedValue | null}
   */
  function parseSpeed(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim().slice(0, 50);
    const lower = raw.toLowerCase();
    if (lower === 'none') return { kind: 'none', kmh: 0, implicit: false, raw };
    if (lower === 'walk') return { kind: 'walk', kmh: WALK_KMH, implicit: false, raw };
    if (lower === 'signals' || lower === 'variable') return { kind: 'variable', kmh: 0, implicit: false, raw };

    let m = lower.match(/^(\d+(?:\.\d+)?)\s*(mph|knots|km\/h|kmh)?$/);
    if (m) {
      const n = Number(m[1]);
      const kmh = m[2] === 'mph' ? n * KMH_PER_MPH : m[2] === 'knots' ? n * KMH_PER_KNOT : n;
      return kmh > 0 && kmh <= 500 ? { kind: 'limit', kmh, implicit: false, raw } : null;
    }
    // DE:zone30, DE:zone:30, DE:30 (zone:maxspeed); GB:zone20 is in mph
    m = raw.match(/^([A-Za-z]{2})(?:-[A-Za-z0-9]+)?:(?:zone:?)?(\d{1,3})$/i);
    if (m) return { kind: 'limit', kmh: Number(m[2]) * (MPH_COUNTRIES.has(m[1].toUpperCase()) ? KMH_PER_MPH : 1), implicit: true, raw };
    // DE:urban, FR:rural, DE:motorway …
    m = raw.match(/^([A-Za-z]{2})(?:-[A-Za-z0-9]+)?:([a-z_]+)$/i);
    if (m) {
      const table = IMPLICIT[/** @type {keyof typeof IMPLICIT} */ (m[2].toLowerCase())];
      if (!table) return null;
      const country = m[1].toUpperCase();
      const kmh = country in table ? table[/** @type {'DEFAULT'} */ (country)] : table.DEFAULT;
      if (kmh === Infinity) return { kind: 'none', kmh: 0, implicit: true, raw };
      return { kind: kmh <= 7 ? 'walk' : 'limit', kmh, implicit: true, raw };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Conditions (maxspeed:conditional)
  // ---------------------------------------------------------------------------
  // Syntax: "<value> @ <condition>; <value> @ (<condition>)". Conditions use the
  // opening_hours notation for times (Mo-Fr 07:00-17:00, sunset-sunrise, PH …) or
  // words such as wet, snow, weight>7.5. They are sorted into the kinds of
  // OMC_EXTRA_TYPES so the popup can hide them by kind.

  /** Kind of a condition text (key of OMC_EXTRA_TYPES). @param {string} condition */
  function conditionKind(condition) {
    const c = condition.toLowerCase();
    if (/\bwet\b/.test(c)) return 'wet';
    if (/\b(snow|ice|icy)\b/.test(c)) return 'snow';
    if (/\bfog\b/.test(c)) return 'fog';
    if (/\bsh\b|school/.test(c)) return 'school';
    if (/\bph\b|holiday/.test(c)) return 'holiday';
    if (/sunrise|sunset|dawn|dusk/.test(c)) return 'daytime';
    if (/\d{1,2}:\d{2}|\b(mo|tu|we|th|fr|sa|su)\b/.test(c)) return 'time';
    if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|winter|summer|spring|autumn/.test(c)) return 'season';
    if (/weight|length|width|height|axle|trailer|caravan|hazmat|occupants|articulated|wheels|hgv|goods|bus/.test(c)) return 'vehicle';
    return 'other';
  }

  const CONDITION_NAMES = {
    de: { wet: 'bei Nässe', snow: 'bei Schnee/Eis', fog: 'bei Nebel' },
    en: { wet: 'when wet', snow: 'in snow/ice', fog: 'in fog' },
  };
  const CONDITION_ICONS = {
    wet: '💧', snow: '🌨️', fog: '🌫️', daytime: '🌙', time: '🕒', school: '🏫',
    holiday: '🏖️', season: '🍂', vehicle: '⚖️', other: '❔',
  };

  /**
   * Splits "80 @ wet; 30 @ (Mo-Fr 07:00-17:00; Sa 08:00-12:00)" at the semicolons
   * that are not inside parentheses.
   * @param {string} text
   */
  function splitConditional(text) {
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ';' && depth === 0) { parts.push(current); current = ''; } else current += ch;
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /**
   * Conditional limits of a maxspeed:…:conditional value.
   * @param {unknown} value
   * @returns {ExtraLimit[]}
   */
  function parseConditional(value) {
    if (typeof value !== 'string') return [];
    /** @type {ExtraLimit[]} */
    const out = [];
    for (const part of splitConditional(value.slice(0, 500))) {
      const m = part.match(/^([^@]+?)\s*@\s*(.+)$/);
      if (!m) continue;
      const speed = parseSpeed(m[1]);
      if (!speed || (speed.kind !== 'limit' && speed.kind !== 'walk')) continue;
      const raw = m[2].trim().replace(/^\((.*)\)$/, '$1').trim();
      const kind = conditionKind(raw);
      const names = /** @type {Record<string, string>} */ (CONDITION_NAMES[LANG]);
      out.push({
        kmh: speed.kmh,
        icon: CONDITION_ICONS[/** @type {keyof typeof CONDITION_ICONS} */ (kind)] || '❔',
        label: names[kind] || raw,
        raw,
        kind,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // What applies to one way, one vehicle type and one direction
  // ---------------------------------------------------------------------------

  /**
   * Result for one direction.
   * @typedef {object} DirectionSpeed
   * @property {'limit'|'missing'|'noSpeed'|'variable'} status
   *   limit    – there is a value (kmh; may be advisory or implicit);
   *   missing  – a road without any value for this vehicle and direction;
   *   noSpeed  – a way type that normally has none (footway …);
   *   variable – electronic signs without a usual maximum (maxspeed:variable=yes
   *              alone, or the outdated maxspeed=signals).
   * @property {number} kmh
   * @property {boolean} advisory      Only a recommended speed (maxspeed:advisory, or maxspeed=none).
   * @property {boolean} implicit      From a code such as DE:urban.
   * @property {boolean} variable      Shown by electronic signs (maxspeed:variable); with
   *                                  status "limit", kmh is the usual maximum (maxspeed).
   * @property {string[]} variableReasons  Reasons from maxspeed:variable, e.g. ["weather"].
   * @property {boolean} unlimited     No legal limit (maxspeed=none); kmh is then the advisory speed.
   * @property {string} sign           Text on the sign ("" = the number).
   * @property {SignSymbol} symbol    Official German sign drawn instead of the speed
   *                                  sign, "" = none (see fixedSign).
   * @property {string} bicycleRoad    The tag that makes it a bicycle road (bicycle_road=yes,
   *                                  cyclestreet=yes or source:maxspeed=DE:bicycle_road), "" if
   *                                  none. At 30 the main sign is 244.1; at another speed
   *                                  244.1 is drawn next to the speed or zone sign.
   * @property {string} source         The tag value it came from, for the tooltip.
   * @property {string} vehicle        Suffix of the vehicle the value is tagged for, e.g. "hgv"
   *                                  for maxspeed:hgv or "maxspeed:conditional=80 @ (hgv)";
   *                                  "" if it applies to every vehicle.
   * @property {Condition | null} condition  Set when the main value itself is conditional
   *                                  (only maxspeed:conditional is tagged).
   * @property {ExtraLimit[]} extras   Conditional limits (maxspeed:…:conditional).
   * @property {LaneSpeed[] | null} lanes  Per-lane values, left to right in driving direction, if they differ.
   * @property {DefaultSpeed | null} fallback  Only with status "missing": what the law of
   *                                  the country sets for this kind of road (see defaultRoad).
   */

  /**
   * A legal default speed limit, shown in grey instead of a tagged one.
   * @typedef {object} DefaultSpeed
   * @property {DirectionSpeed} info  As if the default tags were on the way.
   * @property {string} country       Code of the table, e.g. "DE" or "GB-SCT".
   * @property {string} roadType      Road type from the table, "" for other roads.
   * @property {string} [openTo]      Not from the table but a bicycle road opened to other
   *                                  vehicles without maxspeed: the access tag, e.g. "vehicle=destination".
   * @property {string} [above]       A value for every vehicle is tagged but above this
   *                                  vehicle's own default, so it counts as missing: the tag, e.g. "maxspeed=100".
   */

  /** @typedef {{ kmh: number, advisory: boolean, sign: string }} LaneSpeed */

  /**
   * Official sign drawn instead of a speed sign, a key of SIGN_ART ("" = none): German
   * 325.1 living street, 242.1 pedestrian zone, 244.1 bicycle road (at 30), 274.1 30 zone,
   * 274.1-20 20 zone; signs of other countries for zones (ZONE_SIGNS) and living streets
   * (LIVING_STREET_SIGNS), e.g. "CH-2.59.5".
   * @typedef {string} SignSymbol
   */

  /**
   * Highways that should carry a speed limit; without one they are "missing".
   * living_street gets walking pace when nothing is tagged.
   */
  const ROADS = new Set([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
    'living_street', 'service', 'road', 'busway',
  ]);
  /** access values that make a missing limit plausible (vehicle may not enter). */
  const RESTRICTED_ACCESS = new Set(['no', 'private', 'destination', 'delivery', 'customers', 'agricultural', 'forestry', 'permit']);

  /** Default advisory speed for maxspeed=none (German "Richtgeschwindigkeit"). */
  const DEFAULT_ADVISORY_KMH = 130;

  /**
   * Whether a missing limit may well be correct, so it is drawn quieter (red dashes on
   * grey): restricted access, or highway=service, which is not part of the public
   * road network and rarely has a limit of its own.
   * @param {Tags} tags
   */
  const isAccessRestricted = (tags) => tags.highway === 'service'
    || ['access', 'vehicle', 'motor_vehicle', 'motorcar'].some((key) => RESTRICTED_ACCESS.has(tags[key]));

  /** 1 = one-way in drawing direction, -1 = against it, 0 = both ways. @param {Tags} tags */
  function onewayOf(tags) {
    const o = tags.oneway;
    if (o === 'yes' || o === 'true' || o === '1') return 1;
    if (o === '-1' || o === 'reverse') return -1;
    if (o === 'no' || o === 'false' || o === '0') return 0;
    if (tags.highway === 'motorway' || tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
    return 0;
  }

  /**
   * First non-empty tag among keys, e.g. maxspeed:hgv:forward, then maxspeed:hgv.
   * @param {Tags} tags
   * @param {string[]} keys
   */
  const firstTag = (tags, keys) => {
    for (const key of keys) if (typeof tags[key] === 'string' && tags[key] !== '') return { key, value: tags[key] };
    return null;
  };

  /**
   * Tag keys for one value type, most specific first: vehicle + direction, vehicle,
   * then the same without vehicle (plain maxspeed applies to every vehicle).
   * OSM puts the direction before ":conditional" (maxspeed:forward:conditional)
   * but after ":lanes" (maxspeed:lanes:forward).
   * @param {string[]} vehicleSuffixes  e.g. ["hgv"] or ["bus", "coach"]; [] for cars.
   * @param {Direction} direction
   * @param {'' | ':lanes' | ':conditional'} part
   */
  function keysFor(vehicleSuffixes, direction, part) {
    const bases = [...vehicleSuffixes.map((v) => `maxspeed:${v}`), 'maxspeed'];
    /** @type {string[]} */
    const keys = [];
    for (const base of bases) {
      keys.push(part === ':conditional' ? `${base}:${direction}${part}` : `${base}${part}:${direction}`, `${base}${part}`);
    }
    return keys;
  }

  /**
   * Turns a parsed value into what is shown: maxspeed=none becomes an advisory
   * speed (maxspeed:advisory, else 130), walk shows a pedestrian.
   * @param {SpeedValue} value
   * @param {number} advisoryKmh
   */
  function shownSpeed(value, advisoryKmh) {
    if (value.kind === 'none') return { kmh: advisoryKmh || DEFAULT_ADVISORY_KMH, advisory: true, sign: '' };
    if (value.kind === 'walk') return { kmh: value.kmh, advisory: false, sign: '🚶' };
    return { kmh: value.kmh, advisory: false, sign: '' };
  }

  /** Permissible maximum mass of a truck class in t: more than min, at most max. @typedef {{ min: number, max: number }} WeightRange */

  /**
   * Whether every vehicle of a weight class meets a condition (true), none does
   * (false), or it depends on the vehicle (null). Weight terms (weight, weightrating,
   * maxweightrating: the class is a permissible maximum mass, which signs such as
   * "7,5 t" mean) are judged; the vehicle's own name ("hgv") is met; anything else
   * (trailer, times, wet …) stays open. Terms joined by AND must all hold.
   * @param {string} condition  e.g. "weightrating>7.5" or "trailer AND weight>12".
   * @param {WeightRange} weight
   * @param {string[]} vehicleSuffixes
   * @returns {boolean | null}
   */
  function weightConditionMet(condition, weight, vehicleSuffixes) {
    /** @type {boolean | null} */
    let result = true;
    for (const term of condition.split(/\s+AND\s+/i)) {
      const t = term.trim().toLowerCase();
      if (vehicleSuffixes.includes(t)) continue;
      const m = /^(?:max)?weight(?:rating)?\s*(>=|<=|>|<)\s*([\d.]+)\s*(t|lbs?|st)?$/.exec(t);
      if (!m) { result = null; continue; }
      const n = Number(m[2]) * (m[3]?.startsWith('lb') ? 0.000453592 : m[3] === 'st' ? 0.907185 : 1);
      const op = m[1];
      // The class is the range (min, max]: "more than min, at most max".
      const all = op === '>' || op === '>=' ? weight.min >= n : op === '<' ? weight.max < n : weight.max <= n;
      const none = op === '>' ? weight.max <= n : op === '>=' ? weight.max < n : weight.min >= n;
      if (none) return false;
      if (!all) result = null;
    }
    return result;
  }

  /**
   * What applies to one way for one vehicle type in one direction.
   * @param {Tags} tags
   * @param {string[]} vehicleSuffixes
   * @param {Direction} direction
   * @param {number} oneway  See onewayOf.
   * @param {WeightRange | null} [weight]  Truck class: weight conditions met by the whole
   *                                  class count as its value, those met by none are left out.
   * @param {string | null} [country]  For living streets, see livingStreetSpeed.
   * @returns {DirectionSpeed | null}  null = not a road, leave it alone.
   */
  function directionSpeed(tags, vehicleSuffixes, direction, oneway, weight = null, country = null) {
    /** @type {DirectionSpeed} */
    const base = { status: 'missing', kmh: 0, advisory: false, implicit: false, unlimited: false, variable: false, variableReasons: [], sign: '', symbol: '', source: '', vehicle: '', condition: null, extras: [], lanes: null, fallback: null, bicycleRoad: '' };
    const hasAnySpeedTag = Object.keys(tags).some((k) => k === 'maxspeed' || k.startsWith('maxspeed:') || k === 'zone:maxspeed');
    /** Vehicle suffix of a key such as maxspeed:hgv:forward, "" for plain maxspeed…. @param {string} key */
    const vehicleOf = (key) => vehicleSuffixes.find((v) => key === `maxspeed:${v}` || key.startsWith(`maxspeed:${v}:`)) || '';

    const advisoryTag = firstTag(tags, [`maxspeed:advisory:${direction}`, 'maxspeed:advisory']);
    const advisory = advisoryTag ? parseSpeed(advisoryTag.value) : null;
    const advisoryKmh = advisory && advisory.kind === 'limit' ? advisory.kmh : 0;

    // Conditions for every vehicle (maxspeed:conditional) apply next to those for this
    // vehicle (maxspeed:hgv:conditional). One that names exactly this vehicle
    // ("80 @ (trailer)", also in maxspeed:motorcar:conditional) is no condition for it
    // but its own value.
    const conditionalKeys = keysFor(vehicleSuffixes, direction, ':conditional');
    const extrasTag = firstTag(tags, conditionalKeys);
    const generalTag = firstTag(tags, conditionalKeys.filter((k) => !vehicleOf(k)));
    /** @type {{ extra: ExtraLimit, tag: { key: string, value: string } }[]} */
    const tagged = [extrasTag, generalTag?.key !== extrasTag?.key ? generalTag : null]
      .flatMap((tag) => (tag ? parseConditional(tag.value).map((extra) => ({ extra, tag })) : []))
      // The same entry in both (60 @ (weight>7.5)) is one sign.
      .filter(({ extra }, i, all) => all.findIndex((o) => o.extra.kmh === extra.kmh && o.extra.raw === extra.raw) === i);
    const isOwn = (/** @type {ExtraLimit} */ extra) => vehicleSuffixes.includes(extra.raw.toLowerCase());
    /** For a truck class: true = met by every truck of it, false = by none, null = open. @param {ExtraLimit} extra */
    const met = (extra) => (weight ? weightConditionMet(extra.raw, weight, vehicleSuffixes) : null);
    const open = tagged.filter(({ extra }) => !isOwn(extra) && met(extra) === null);
    const extras = open.map(({ extra }) => extra);
    const ownConditional = tagged.filter(({ extra }) => isOwn(extra)).sort((a, b) => a.extra.kmh - b.extra.kmh)[0];
    const lowestMet = tagged.filter(({ extra }) => !isOwn(extra) && met(extra) === true).sort((a, b) => a.extra.kmh - b.extra.kmh)[0];

    // Per-lane values. On two-way roads plain maxspeed:lanes lists the lanes of both
    // directions together, so only :lanes:forward / :lanes:backward are used there.
    const laneKeys = keysFor(vehicleSuffixes, direction, ':lanes').filter((k) => oneway !== 0 || k.endsWith(`:${direction}`));
    const lanesTag = firstTag(tags, laneKeys);
    /** @type {LaneSpeed[] | null} */
    let lanes = null;
    if (lanesTag) {
      const parsed = lanesTag.value.split('|').slice(0, 12).map((v) => parseSpeed(v));
      if (parsed.length > 1 && parsed.every(Boolean)) {
        lanes = parsed.map((v) => shownSpeed(/** @type {SpeedValue} */ (v), advisoryKmh));
        if (lanes.every((l) => l.kmh === lanes?.[0].kmh && l.advisory === lanes?.[0].advisory)) lanes = null;
      }
    }

    const valueTag = firstTag(tags, keysFor(vehicleSuffixes, direction, ''));
    let value = valueTag ? parseSpeed(valueTag.value) : null;
    let source = valueTag ? `${valueTag.key}=${valueTag.value}` : '';
    let vehicle = valueTag ? vehicleOf(valueTag.key) : '';
    // "80 @ (trailer)" counts like maxspeed:trailer=80: before plain maxspeed and
    // before the vehicles tried after trailer (caravan, motorcar).
    /** @param {string} v */
    const rank = (v) => (v ? vehicleSuffixes.indexOf(v) : vehicleSuffixes.length);
    const ownVehicle = ownConditional ? ownConditional.extra.raw.toLowerCase() : '';
    if (ownConditional && (!value || rank(ownVehicle) < rank(vehicle))) {
      const kmh = ownConditional.extra.kmh;
      value = { kind: kmh === WALK_KMH ? 'walk' : 'limit', kmh, implicit: false, raw: String(kmh) };
      source = `${ownConditional.tag.key}=${ownConditional.tag.value}`;
      vehicle = ownVehicle;
    }
    // A weight condition every truck of the chosen class meets ("60 @ (weightrating>7.5)"
    // for class C) applies on top: the lower value wins.
    if (lowestMet && (!value || value.kind === 'none' || (value.kind !== 'variable' && lowestMet.extra.kmh < value.kmh))) {
      const kmh = lowestMet.extra.kmh;
      value = { kind: kmh === WALK_KMH ? 'walk' : 'limit', kmh, implicit: false, raw: String(kmh) };
      source = `${lowestMet.tag.key}=${lowestMet.tag.value}`;
      vehicle = vehicleOf(lowestMet.tag.key) || vehicleSuffixes[0];
    }
    if (!value) vehicle = '';
    if (!value) {
      // Implicit limit from the type of area, if maxspeed itself is missing.
      const typeTag = firstTag(tags, ['zone:maxspeed', 'maxspeed:type', 'source:maxspeed']);
      const implicit = typeTag ? parseSpeed(typeTag.value) : null;
      if (implicit) { value = { ...implicit, implicit: true }; source = `${typeTag?.key}=${typeTag?.value}`; }
    }
    // A living street means its speed by itself (German sign 325.1: walking pace, Swiss
    // Begegnungszone 2.59.5: 20): the sign stands for it, so this counts as explicit,
    // not implicit (in colour, not grey).
    if (!value && tags.highway === 'living_street') { value = livingStreetSpeed(country); source = 'highway=living_street'; }
    // A bicycle road (German "Fahrradstraße", sign 244.1) has 30 km/h unless signed
    // otherwise; source:maxspeed=DE:bicycle_road says the same.
    const bicycleRoad = tags.bicycle_road === 'yes' ? 'bicycle_road=yes' : tags.cyclestreet === 'yes' ? 'cyclestreet=yes'
      : ['source:maxspeed', 'maxspeed:type'].filter((k) => /^[A-Z]{2}:bicycle_road$/i.test(tags[k] || '')).map((k) => `${k}=${tags[k]}`)[0] || '';
    if (!value && bicycleRoad) { value = { kind: 'limit', kmh: 30, implicit: true, raw: '30' }; source = bicycleRoad; }

    // Electronic signs: maxspeed:variable=yes (or a reason such as "weather"), with
    // maxspeed holding the usual maximum. maxspeed=signals is the outdated form.
    const variableTag = firstTag(tags, [`maxspeed:variable:${direction}`, 'maxspeed:variable']);
    const variable = !!variableTag && variableTag.value !== 'no';
    const variableSource = variable ? `${variableTag?.key}=${variableTag?.value}` : '';
    // Reasons such as "weather;peak_traffic"; "yes" gives none.
    const variableReasons = variable
      ? (variableTag?.value || '').split(';').map((v) => v.trim()).filter((v) => v && v !== 'yes').slice(0, 4)
      : [];
    Object.assign(base, { variableReasons, bicycleRoad });

    if (value && value.kind === 'variable') return { ...base, status: 'variable', variable: true, source, extras };
    if (value) {
      // With lanes the tooltip names both tags: the value for the direction and the lanes.
      if (lanes) source += `\n${lanesTag?.key}=${lanesTag?.value}`;
      if (variable) source += `\n${variableSource}`;
      const symbol = lanes || variable ? '' : fixedSign(tags, value, bicycleRoad, country);
      /** @type {DirectionSpeed} */
      const result = {
        // maxspeed=none without maxspeed:advisory: on motorways the advisory 130 is the
        // rule itself (in Germany signed at the border, not tagged per road), so it is
        // explicit. On other roads (e.g. a motorway-like Kraftfahrstraße) the advisory
        // speed is tagged when it applies, so an untagged 130 there is only assumed.
        ...base, status: 'limit', ...shownSpeed(value, advisoryKmh),
        implicit: value.implicit || (value.kind === 'none' && !advisoryKmh && !/^motorway(_link)?$/.test(tags.highway || '')),
        unlimited: value.kind === 'none', source, vehicle, extras, lanes, symbol, variable,
      };
      // A bicycle road is closed to other vehicles by default (vehicle=no). Once they
      // are let in (vehicle, motor_vehicle or motorcar other than "no"), maxspeed
      // should be tagged: without it the value counts as missing, with the implicit
      // 30 as a grey sign.
      const openTag = !!bicycleRoad && result.implicit
        ? ['vehicle', 'motor_vehicle', 'motorcar'].find((key) => tags[key] && tags[key] !== 'no')
        : undefined;
      if (openTag) return { ...base, extras, fallback: { info: result, country: '', roadType: '', openTo: `${openTag}=${tags[openTag]}` } };
      return result;
    }
    if (variable && !lanes) return { ...base, status: 'variable', variable: true, source: variableSource, extras };
    if (lanes) {
      // Only per-lane values: the lowest one stands for the whole direction.
      const lowest = lanes.reduce((a, b) => (b.kmh < a.kmh ? b : a));
      return { ...base, status: 'limit', ...lowest, source: `${lanesTag?.key}=${lanesTag?.value}`, vehicle: vehicleOf(lanesTag?.key || ''), extras, lanes };
    }
    if (advisoryKmh) return { ...base, status: 'limit', kmh: advisoryKmh, advisory: true, source: `${advisoryTag?.key}=${advisoryTag?.value}`, extras };
    if (extras.length) {
      // Only conditional limits: the lowest becomes the main sign, the rest extra signs.
      const sorted = [...open].sort((a, b) => a.extra.kmh - b.extra.kmh);
      const { kmh, ...condition } = sorted[0].extra;
      return {
        ...base, status: 'limit', kmh, source: `${sorted[0].tag.key}=${sorted[0].tag.value}`, vehicle: vehicleOf(sorted[0].tag.key),
        condition, extras: sorted.slice(1).map(({ extra }) => extra),
      };
    }

    const isNoSpeedType = noSpeedRules.some(([key, v]) => tags[key] === v);
    if (isNoSpeedType && !hasAnySpeedTag) {
      // A pedestrian zone gets its sign even without a speed limit.
      const pedestrian = tags.highway === 'pedestrian';
      return { ...base, status: 'noSpeed', symbol: pedestrian ? '242.1' : '', source: pedestrian ? 'highway=pedestrian' : '' };
    }
    if (ROADS.has(tags.highway)) return base;
    return null;
  }

  /**
   * Zone signs per country and speed (keys of SIGN_ART). Only public-domain artwork
   * from Wikimedia Commons; other countries get the German sign for 20 and 30.
   * Swiss and French 20 zones are meeting zones (Begegnungszone, zone de rencontre).
   * @type {Record<string, Record<number, string>>}
   */
  const ZONE_SIGNS = {
    DE: { 20: '274.1-20', 30: '274.1' },
    AT: { 30: 'AT-11a' },
    BE: { 30: 'BE-F4a' },
    CH: { 20: 'CH-2.59.5', 30: 'CH-2.59.1' },
    FR: { 20: 'FR-B52' },
    IT: { 30: 'IT-II-323a' },
    NL: { 30: 'NL-A1-30-ZB', 60: 'NL-A1-60-ZB' },
    NO: { 30: 'NO-366-30' },
    PL: { 20: 'PL-B-43-20', 30: 'PL-B-43-30', 40: 'PL-B-43-40' },
    SI: { 40: 'SI-III-29-40' },
  };

  /** Signs for highway=living_street where it is not walking pace (325.1). @type {Record<string, string>} */
  const LIVING_STREET_SIGNS = { CH: 'CH-2.59.5', FR: 'FR-B52' };

  /**
   * What highway=living_street means without maxspeed: the country's "living street"
   * row of the default table (CH 20, NL 15), else walking pace.
   * @param {string | null} country  e.g. "CH"; "" or null = not known.
   * @returns {SpeedValue}
   */
  function livingStreetSpeed(country) {
    const walk = { kind: /** @type {const} */ ('walk'), kmh: WALK_KMH, implicit: false, raw: 'walk' };
    if (!country) return walk;
    const { countries } = defaultSpeeds();
    const has = (/** @type {string} */ code) => Object.prototype.hasOwnProperty.call(countries, code);
    const own = has(country) ? country : country.split('-')[0];
    const row = has(own) ? countries[own].find(([name]) => name === 'living street') : undefined;
    const parsed = row ? parseSpeed(row[1].maxspeed) : null;
    return parsed && parsed.kind !== 'variable' && parsed.kind !== 'none' ? { ...parsed, implicit: false } : walk;
  }

  /**
   * Official sign that stands for this value on its own, or "": 325.1 for walking
   * pace on a living street (Begegnungszone 2.59.5 in Switzerland), 244.1 for 30 on
   * a bicycle road, the zone sign of the country (ZONE_SIGNS) for a zone tagged as
   * zone:maxspeed=CH:30, maxspeed:type=CH:zone30, maxspeed=DE:zone:30 ….
   * A bicycle road with another speed keeps its speed or zone sign; 244.1 is then
   * drawn next to it (DirectionSpeed.bicycleRoad).
   * @param {Tags} tags
   * @param {SpeedValue} value
   * @param {string} bicycleRoad
   * @param {string | null} [country]  For living streets.
   * @returns {SignSymbol}
   */
  function fixedSign(tags, value, bicycleRoad, country = null) {
    if (tags.highway === 'living_street') {
      if (value.kind === 'walk') return '325.1';
      const sign = LIVING_STREET_SIGNS[(country || '').split('-')[0]];
      if (sign && value.kind === 'limit' && value.kmh === livingStreetSpeed(country).kmh) return sign;
    }
    if (value.kind !== 'limit') return '';
    if (bicycleRoad && value.kmh === 30) return '244.1';
    const zone = [
      /^([A-Z]{2})(?:-[A-Z0-9]+)?:(?:zone:?)?(\d{1,3})$/i.exec(tags['zone:maxspeed'] || ''),
      ...[tags.maxspeed, tags['maxspeed:type'], tags['source:maxspeed']].map((v) => /^([A-Z]{2})(?:-[A-Z0-9]+)?:zone:?(\d{1,3})$/i.exec(v || '')),
    ].find(Boolean);
    if (!zone) return '';
    const code = zone[1].toUpperCase();
    const kmh = Number(zone[2]);
    // mph zones (GB:zone20) have signs of their own, none of these.
    if (MPH_COUNTRIES.has(code) || kmh !== value.kmh) return '';
    return ZONE_SIGNS[code]?.[kmh] || ZONE_SIGNS.DE[kmh] || '';
  }

  /**
   * What applies to one way and vehicle type, per direction.
   * On one-way roads only the driving direction counts. Unless `country` is null,
   * a missing value gets the legal default of the country as `fallback`.
   * @param {Tags} tags
   * @param {string[]} vehicleSuffixes
   * @param {string | null} [country]  e.g. "DE"; "" = not known (zone:traffic may
   *                                   still name it); null = no defaults.
   * @param {WeightRange | null} [weight]  Truck class, see directionSpeed.
   */
  function waySpeed(tags, vehicleSuffixes, country = null, weight = null) {
    const oneway = onewayOf(tags);
    const speeds = {
      forward: oneway === -1 ? null : directionSpeed(tags, vehicleSuffixes, 'forward', oneway, weight, country),
      backward: oneway === 1 ? null : directionSpeed(tags, vehicleSuffixes, 'backward', oneway, weight, country),
    };
    const isCar = vehicleSuffixes.every((v) => v === 'motorcar');
    // For other vehicles a value for every vehicle (maxspeed=100) may be above what the
    // law allows them anyway (trucks 80): then it says nothing for this vehicle.
    // maxspeed:motorcar is such a value for a car with a trailer.
    /** @param {DirectionSpeed | null} info */
    const isGeneral = (info) => !isCar && info?.status === 'limit' && (!info.vehicle || info.vehicle === 'motorcar');
    const directions = /** @type {const} */ (['forward', 'backward']);
    if (country !== null && directions.some((d) => speeds[d]?.status === 'missing' || isGeneral(speeds[d]))) {
      const road = defaultRoad(country, tags);
      if (road) {
        const merged = { ...tags, ...defaultTagsFor(road.tags, tags) };
        // The table's conditions for all vehicles include ones no car can meet
        // ("80 @ (weightrating>3.5)"); in the car view they are left out. Tagged
        // conditions stay: they stand for real supplementary panels.
        const tableConditional = merged['maxspeed:conditional'];
        if (isCar && tableConditional && !tags['maxspeed:conditional']) {
          const forCars = splitConditional(tableConditional).filter((part) => !isOnlyForHeavierThanCar(part));
          if (forCars.length) merged['maxspeed:conditional'] = forCars.join('; ');
          else delete merged['maxspeed:conditional'];
        }
        // The table gives truck limits also for all goods vehicles (maxspeed:goods).
        const suffixes = vehicleSuffixes.includes('hgv') ? [...vehicleSuffixes, 'goods'] : vehicleSuffixes;
        // The vehicle's own default, as if no maxspeed were tagged at all.
        const bare = Object.fromEntries(Object.entries(tags).filter(([k]) => k !== 'maxspeed' && !k.startsWith('maxspeed:')));
        const ownDefaults = { ...bare, ...defaultTagsFor(road.tags, bare) };
        for (const direction of directions) {
          const info = speeds[direction];
          if (info?.status === 'missing' && !info.fallback) {
            const def = directionSpeed(merged, suffixes, direction, oneway, weight, country);
            if (def?.status !== 'limit') continue;
            // A conditional default not below the main one says nothing new (80 next to 80).
            def.extras = def.extras.filter((extra) => extra.kmh < def.kmh);
            info.fallback = { info: def, country: road.country, roadType: road.roadType };
          } else if (info && isGeneral(info)) {
            const def = directionSpeed(ownDefaults, suffixes, direction, oneway, weight, country);
            if (def?.status !== 'limit') continue;
            // Only a default of the vehicle's own (maxspeed:hgv), not the one for every
            // vehicle: maxspeed=70 in town is above the 50 there but allowed for trucks.
            if (!def.vehicle || def.vehicle === 'motorcar' || def.kmh >= info.kmh - 0.1) {
              // The tagged value applies, but the law's lower limits for part of the
              // vehicles still do (a 70 sign does not lift "60 over 7.5 t"): grey extras.
              const lower = def.extras.filter((extra) => extra.kmh < info.kmh - 0.1
                && !info.extras.some((own) => own.kmh === extra.kmh && own.raw === extra.raw));
              info.extras = [...info.extras, ...lower.map((extra) => ({ ...extra, fromDefault: true }))];
              continue;
            }
            // Tagged conditions below the default still apply (60 @ wet).
            def.extras = [...info.extras, ...def.extras].filter((extra) => extra.kmh < def.kmh);
            speeds[direction] = {
              ...info, status: 'missing', kmh: 0, advisory: false, implicit: false, unlimited: false, variable: false,
              sign: '', symbol: '', source: '', vehicle: '', condition: null, extras: [], lanes: null,
              fallback: { info: def, country: road.country, roadType: road.roadType, above: info.source.split('\n')[0] },
            };
          }
        }
      }
    }
    return { oneway, ...speeds, restricted: isAccessRestricted(tags) };
  }

  // ===========================================================================
  // Legal default speed limits (defaultSpeedTable, at the end of this file)
  // ===========================================================================
  // Where a road has no maxspeed, the law of the country still sets a limit by the
  // kind of road. The OSM wiki page "Default speed limits" lists these per country
  // and road type; a road type is recognised by tag filters such as
  // "{rural} and highway~trunk|primary", where {rural} refers to another road type.
  // Filter syntax and the order in which road types are tried follow
  // osm-legal-default-speeds (github.com/westnordost), the reference implementation
  // for that page.

  /** @typedef {{ revision: number, date: string, roadTypes: Record<string, string>, countries: Record<string, Array<[string, Tags]>> }} DefaultSpeedTable */
  /** @typedef {(tags: Tags, placeholder: (name: string) => boolean) => boolean} TagFilter */

  /** @type {DefaultSpeedTable | null} */
  let defaultTable = null;
  const defaultSpeeds = () => (defaultTable ??= defaultSpeedTable());

  /** Lengths in metres for comparisons such as width<=7.6 (also "7.6 m", "25 ft", 25'). */
  const LENGTH_UNITS = /** @type {Record<string, number>} */ ({ '': 1, m: 1, km: 1000, ft: 0.3048, "'": 0.3048, mi: 1609.344 });

  /** A number with an optional unit, or null. @param {string | undefined} value */
  function numberWithUnit(value) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|km|ft|'|mi)?\s*$/.exec(value || '');
    return m ? Number(m[1]) * LENGTH_UNITS[m[2] || ''] : null;
  }

  /** A regex that has to match the whole text, as in the reference implementation. @param {string} source */
  const wholeMatch = (source) => new RegExp(`^(?:${source})$`);

  /**
   * Compiles a tag filter, e.g. `highway~primary|secondary and !{urban} and lanes>=2`.
   * Supported: key, !key, key=v, key!=v, key~regex, key!~regex, ~keyregex,
   * ~keyregex~regex, key<n (<=, >, >=), {road type}, !{road type}, and, or, !( ),
   * brackets, "quoted" values. Throws on a syntax error.
   * @param {string} text
   * @returns {TagFilter}
   */
  function compileTagFilter(text) {
    let pos = 0;
    const OPERATORS = ['>=', '<=', '!=', '!~', '>', '<', '=', '~'];
    /** @param {string} message @returns {never} */
    const fail = (message) => { throw new Error(`${message} at ${pos} in: ${text}`); };
    const spaces = () => { while (pos < text.length && /\s/.test(text[pos])) pos++; };
    /** @param {string} s */
    const isNext = (s) => text.startsWith(s, pos);
    /** A word, ending at a space or ")" – a key also at an operator. @param {boolean} isKey */
    const word = (isKey) => {
      const quote = text[pos];
      if (quote === '"' || quote === "'") {
        let end = pos + 1;
        while (end < text.length && (text[end] !== quote || text[end - 1] === '\\')) end++;
        if (end >= text.length) fail('open quotation mark');
        const s = text.slice(pos + 1, end).replace(/\\(['"])/g, '$1');
        pos = end + 1;
        return s;
      }
      let end = pos;
      while (end < text.length && !/[\s)]/.test(text[end]) && !(isKey && /[=~<>!]/.test(text[end]))) end++;
      if (end === pos) fail('missing key or value');
      const s = text.slice(pos, end);
      pos = end;
      return s;
    };
    const operator = () => {
      const before = pos;
      spaces();
      const op = OPERATORS.find(isNext);
      if (!op) { pos = before; return ''; }
      pos += op.length;
      spaces();
      return op;
    };
    /** @param {Tags} t @param {string} key */
    const has = (t, key) => Object.prototype.hasOwnProperty.call(t, key);

    /** @returns {TagFilter} */
    const tag = () => {
      if (isNext('!~')) { pos += 2; spaces(); const re = wholeMatch(word(true)); return (t) => !Object.keys(t).some((k) => re.test(k)); }
      if (isNext('!')) { pos += 1; spaces(); const key = word(true); return (t) => !has(t, key); }
      if (isNext('~')) {
        pos += 1;
        spaces();
        const keyRe = wholeMatch(word(true));
        const op = operator();
        if (!op) return (t) => Object.keys(t).some((k) => keyRe.test(k));
        if (op !== '~') fail(`unexpected ${op}`);
        const valueRe = wholeMatch(word(false));
        return (t) => Object.entries(t).some(([k, v]) => keyRe.test(k) && valueRe.test(v));
      }
      const key = word(true);
      const op = operator();
      if (!op) return (t) => has(t, key);
      if (op === '=' || op === '!=') {
        const value = word(false);
        return op === '=' ? (t) => has(t, key) && t[key] === value : (t) => !has(t, key) || t[key] !== value;
      }
      if (op === '~' || op === '!~') {
        const re = wholeMatch(word(false));
        return op === '~' ? (t) => has(t, key) && re.test(t[key]) : (t) => !has(t, key) || !re.test(t[key]);
      }
      const limit = numberWithUnit(word(false));
      if (limit === null) fail('expected a number');
      /** @type {(n: number) => boolean} */
      const compare = op === '<' ? (n) => n < limit : op === '<=' ? (n) => n <= limit : op === '>' ? (n) => n > limit : (n) => n >= limit;
      return (t) => { const n = has(t, key) ? numberWithUnit(t[key]) : null; return n !== null && compare(n); };
    };
    /** "and" / "or" followed by a space or bracket. @param {string} keyword */
    const isKeyword = (keyword) => {
      spaces();
      if (!isNext(keyword) || !/[\s(]/.test(text[pos + keyword.length] || '')) return false;
      pos += keyword.length;
      return true;
    };
    const closing = () => { spaces(); if (text[pos] !== ')') fail('missing )'); pos++; };
    /** @returns {TagFilter} */
    const unary = () => {
      spaces();
      if (/^!\s*\(/.test(text.slice(pos, pos + 20))) {
        pos = text.indexOf('(', pos) + 1;
        const inner = or();
        closing();
        return (t, p) => !inner(t, p);
      }
      if (isNext('(')) { pos++; const inner = or(); closing(); return inner; }
      const negated = isNext('!{');
      if (negated || isNext('{')) {
        pos += negated ? 2 : 1;
        const end = text.indexOf('}', pos);
        if (end < 0) fail('missing }');
        const name = text.slice(pos, end);
        pos = end + 1;
        return negated ? (t, p) => !p(name) : (t, p) => p(name);
      }
      return tag();
    };
    /** @returns {TagFilter} */
    const and = () => {
      const parts = [unary()];
      while (isKeyword('and')) parts.push(unary());
      return parts.length === 1 ? parts[0] : (t, p) => parts.every((f) => f(t, p));
    };
    /** @returns {TagFilter} */
    function or() {
      const parts = [and()];
      while (isKeyword('or')) parts.push(and());
      return parts.length === 1 ? parts[0] : (t, p) => parts.some((f) => f(t, p));
    }
    const filter = or();
    spaces();
    if (pos < text.length) fail('unexpected text');
    return filter;
  }

  // Only the exact tag filters are used. The table's fuzzy filters guess "urban"
  // from lit=yes, a sidewalk or highway=residential, but those are found outside
  // built-up areas too. Inside or outside comes from tags that say so:
  // zone:traffic=DE:urban (or :rural), rural=yes/no, or a maxspeed code such as
  // source:maxspeed=DE:rural.

  /** Compiled filter per road type; null = none or unreadable. @type {Map<string, TagFilter | null>} */
  const roadTypeFilters = new Map();

  /** @param {string} name */
  function filterOf(name) {
    let filter = roadTypeFilters.get(name);
    if (filter === undefined) {
      const types = defaultSpeeds().roadTypes;
      const source = Object.prototype.hasOwnProperty.call(types, name) ? types[name] : '';
      try { filter = source ? compileTagFilter(source) : null; } catch { filter = null; }
      roadTypeFilters.set(name, filter);
    }
    return filter;
  }

  /**
   * Whether the way is of this road type.
   * @param {string} name
   * @param {Tags} tags
   * @param {number} [depth]  Guards against road types that refer to each other.
   * @returns {boolean}
   */
  function isRoadType(name, tags, depth = 0) {
    if (depth > 20) return false;
    const filter = filterOf(name);
    return !!filter && filter(tags, (other) => isRoadType(other, tags, depth + 1));
  }

  /**
   * Whether it stays open if a road is of this type although it does not match:
   * the type depends on being inside or outside built-up areas ({urban}, {rural},
   * directly or through other types), or it has no exact filter at all.
   * @param {string} name
   * @param {number} [depth]
   * @returns {boolean}
   */
  function isUndecidable(name, depth = 0) {
    if (name === 'urban' || name === 'rural') return true;
    if (depth > 20) return false;
    const types = defaultSpeeds().roadTypes;
    const source = Object.prototype.hasOwnProperty.call(types, name) ? types[name] : '';
    return !source || [...source.matchAll(/\{([^}]+)\}/g)].some((m) => isUndecidable(m[1], depth + 1));
  }

  /**
   * zone:traffic of the whole way. On a road along a border, :left and :right may
   * differ; then it is left out, as neither side applies to the whole road.
   * @param {Tags} tags
   * @returns {Tags}
   */
  function withZoneTraffic(tags) {
    const left = tags['zone:traffic:left'];
    if (tags['zone:traffic'] || !left || left !== tags['zone:traffic:right']) return tags;
    return { ...tags, 'zone:traffic': left };
  }

  /**
   * Road type of a way in a country, with the tags that apply there by law.
   * Rows below the fallback row ("" = other roads, usually rural) win from the
   * bottom up, then rows above it from the top down. The fallback row itself only
   * counts where no other row could still apply (see isUndecidable): in Germany,
   * for instance, an untagged road could be inside or outside a built-up area.
   * @param {string} country  e.g. "DE", "GB-SCT"; a subdivision without own rows
   *                          uses its country. "" = not known.
   * @param {Tags} tags
   * @returns {{ country: string, roadType: string, tags: Tags } | null}
   */
  function defaultRoad(country, tags) {
    const { countries } = defaultSpeeds();
    const has = (/** @type {string} */ code) => Object.prototype.hasOwnProperty.call(countries, code);
    const zoned = withZoneTraffic(tags);
    // The country code in zone:traffic (e.g. BE-VLG:urban) names the table, also
    // where the borders in iD do not know the region (Belgium, US states …).
    const zoneCode = (/^([A-Z]{2}(?:-[A-Z0-9]{1,3})?):/i.exec(zoned['zone:traffic'] || '') || [])[1]?.toUpperCase() || '';
    const sameCountry = !country || zoneCode.split('-')[0] === country.split('-')[0];
    const code = zoneCode && has(zoneCode) && sameCountry ? zoneCode : country;
    const own = has(code) ? code : code.split('-')[0];
    if (!own || !has(own)) return null;
    const rows = countries[own];
    const split = rows.findIndex(([name]) => !name);
    const below = split < 0 ? [] : rows.slice(split + 1).reverse();
    const above = split < 0 ? rows : rows.slice(0, split);
    const row = [...below, ...above].find(([name]) => isRoadType(name, zoned));
    if (row) return { country: own, roadType: row[0], tags: row[1] };
    if (split < 0 || rows.some(([name]) => name && isUndecidable(name))) return null;
    return { country: own, roadType: '', tags: rows[split][1] };
  }

  /**
   * Whether a conditional limit ("80 @ (weightrating>3.5 AND trailer)") only applies
   * to vehicles a car (German class B: at most 3.5 t, 8 passenger seats, one trailer)
   * can never be: more than 3.5 t, articulated, 10 or more seats, two trailers, or
   * longer than 12 m. Times, weather or "trailer" can apply to cars and stay.
   * @param {string} part  One entry of a conditional list.
   */
  function isOnlyForHeavierThanCar(part) {
    const condition = part.split('@').slice(1).join('@').trim().replace(/^\((.*)\)$/, '$1');
    return condition.split(/\s+AND\s+/i).some((term) => {
      const t = term.trim().toLowerCase();
      if (t === 'articulated') return true;
      let m = /^weightrating\s*>=?\s*([\d.]+)\s*(t|lbs?|st)?$/.exec(t);
      if (m) return Number(m[1]) * (m[2]?.startsWith('lb') ? 0.000453592 : m[2] === 'st' ? 0.907185 : 1) >= 3.5;
      m = /^seats\s*>=?\s*(\d+)$/.exec(t);
      if (m) return Number(m[1]) >= 10;
      m = /^trailers\s*>=?\s*(\d+)$/.exec(t);
      if (m) return Number(m[1]) >= 2;
      m = /^length\s*>=?\s*([\d.]+)\s*(m|ft)?$/.exec(t);
      if (m) return Number(m[1]) * (m[2] === 'ft' ? 0.3048 : 1) >= 12;
      return false;
    });
  }

  /** km/h of a plain number value, null for anything else (walk, none …). @param {string | undefined} value */
  function plainKmh(value) {
    const parsed = parseSpeed(value);
    return parsed && parsed.kind === 'limit' && !parsed.implicit ? parsed.kmh : null;
  }

  /**
   * Removes limits under `key` that are not below `max`: in the table every limit is
   * an additional restriction, so a truck limit of 80 means nothing where all
   * vehicles have 50. Conditional lists keep only their lower entries.
   * @param {Tags} result
   * @param {string} key
   * @param {number | null} max
   */
  function limitSpeedsTo(result, key, max) {
    if (max !== null) {
      for (const sub of Object.keys(result)) {
        if (!sub.startsWith(`${key}:`)) continue;
        if (sub.endsWith(':conditional')) {
          const lower = splitConditional(result[sub]).filter((part) => {
            const kmh = plainKmh(part.split('@')[0]);
            return kmh === null || kmh < max;
          });
          if (lower.length) result[sub] = lower.join('; ');
          else delete result[sub];
          continue;
        }
        const kmh = plainKmh(result[sub]);
        if (kmh !== null && kmh >= max) delete result[sub];
      }
    }
    for (const sub of Object.keys(result).filter((k) => k.startsWith(`${key}:`))) {
      const own = plainKmh(result[sub]);
      limitSpeedsTo(result, sub, max === null ? own : own === null ? max : Math.min(max, own));
    }
  }

  /**
   * Default tags of a road type that the way does not set itself, ready to be
   * merged into its tags.
   * @param {Tags} roadTags  From defaultRoad.
   * @param {Tags} tags      Of the way.
   * @returns {Tags}
   */
  function defaultTagsFor(roadTags, tags) {
    /** @type {Tags} */
    const result = { ...roadTags };
    limitSpeedsTo(result, 'maxspeed', plainKmh(result.maxspeed));
    // The table gives limits for trailers as a condition ("80 @ (trailer)"); this
    // extension has its own vehicle type for them (maxspeed:trailer).
    const conditional = result['maxspeed:conditional'];
    if (conditional) {
      const rest = [];
      for (const part of splitConditional(conditional)) {
        const m = /^(.+?)\s*@\s*\((?:trailer|caravan)\)$/.exec(part);
        if (m && !result['maxspeed:trailer']) result['maxspeed:trailer'] = m[1].trim();
        else if (!m) rest.push(part);
      }
      if (rest.length) result['maxspeed:conditional'] = rest.join('; ');
      else delete result['maxspeed:conditional'];
    }
    for (const key of Object.keys(tags)) delete result[key];
    return result;
  }

  // ===========================================================================
  // Colours
  // ===========================================================================
  // Each unit has its own bands that match the limits actually posted in the
  // real world. Neighbouring colours differ in hue and brightness; measured colour
  // distance (CIE ΔE76) between any two colours is at least 28.

  /**
   * A colour band. min/max are in the display unit (km/h or mph); min is missing
   * for the open-ended first and last bands.
   * @typedef {{ min?: number, max: number, color: string }} ColorBand
   */

  /** Colours from slow to fast for the mph bands. */
  const PALETTE = [
    '#7f0000', '#d50000', '#ff6d00', '#ffab00', '#ffee58', '#c6ff00', '#64dd17', '#1b5e20',
    '#00bfa5', '#00e5ff', '#2979ff', '#1a237e', '#aa00ff', '#ff4081', '#8d6e63',
  ];
  const COLOR_FASTEST = '#212121';

  /**
   * km/h: grouped by colour family, so the kind of road is visible at a glance.
   * Each band starts at a real posted limit (30, 40, 50 …), so 30 and 39 share a colour.
   *   red     – below 40:  ≤ 5 (walking pace), 6–29, 30–39
   *   orange  – below 60:  40–49, 50–59
   *   blue    – below 100: 60–69, 70–79, 80–89, 90–99
   *   green   – below 120: 100–109, 110–119
   *   pink    – 120–129
   *   purple  – 130 and above
   * @type {ColorBand[]}
   */
  const KMH_BANDS = [
    { max: 5, color: '#3e0000' },
    { min: 6, max: 29, color: '#a50000' },
    { min: 30, max: 39, color: '#ff7961' },
    { min: 40, max: 49, color: '#e65100' },
    { min: 50, max: 59, color: '#ffb74d' },
    { min: 60, max: 69, color: '#0d1b6e' },
    { min: 70, max: 79, color: '#1565c0' },
    { min: 80, max: 89, color: '#42a5f5' },
    { min: 90, max: 99, color: '#80d8ff' },
    { min: 100, max: 109, color: '#1b5e20' },
    { min: 110, max: 119, color: '#76d275' },
    { min: 120, max: 129, color: '#c2185b' },
    { max: Infinity, color: '#7b1fa2' },
  ];

  /**
   * mph: one band per 5 mph, from ≤ 5 to 85, and one band above.
   * US limits are posted in steps of 5 mph up to 85; UK limits are 20/30/40/50/60/70.
   * @type {ColorBand[]}
   */
  const MPH_BANDS = [
    { max: 5, color: PALETTE[0] },
    ...[...PALETTE.slice(1), '#ff00cc', '#ffaaff'].map((color, i) => ({ min: 6 + i * 5, max: 10 + i * 5, color })),
    { max: Infinity, color: COLOR_FASTEST },
  ];

  // Missing limit: red dashes on white, as wide as a normal road. If the way's access
  // is restricted (access=private …), a missing limit can be correct, so the
  // background is grey instead: still visible, less loud.
  const COLOR_MISSING = '#e53935';
  const UNDER_MISSING = '#ffffff';
  const UNDER_MISSING_RESTRICTED = '#9e9e9e';
  // Dots marking an advisory speed. Pure yellow is not used by any km/h band.
  const COLOR_ADVISORY = '#ffff00';
  // Variable limits (maxspeed=signals): short white dashes on blue-grey, a colour no
  // band uses, like the dark face of an electronic sign.
  const COLOR_VARIABLE = '#ffffff';
  const UNDER_VARIABLE = '#546e7a';
  /** Look.dash value for round dots (drawn by drawOverlay, not a plain dasharray). */
  const DOTS = 'dots';

  /** Bands of the selected unit. */
  const colorBands = () => (UNIT === 'mph' ? MPH_BANDS : KMH_BANDS);

  /** Band for a speed given in km/h, using the selected unit. @param {number} kmh */
  function bandFor(kmh) {
    const value = shown(kmh); // in the selected unit, rounded: 48 km/h → 30 mph
    const bands = colorBands();
    return bands.find((b) => value <= b.max) || bands[bands.length - 1];
  }

  /** Legend text for a colour band, e.g. "30–39", "≤ 5" or "≥ 130". @param {ColorBand} band */
  function bandLabel(band) {
    const bands = colorBands();
    if (band.max === Infinity) return `≥ ${bands[bands.length - 2].max + 1}`;
    return band.min ? `${band.min}–${band.max}` : `≤ ${band.max}`;
  }

  // ===========================================================================
  // How a way is drawn
  // ===========================================================================
  // A way is drawn as one or more stripes along the line. Each stripe covers a part
  // of the line's width, given as fractions from -0.5 (left edge, seen in drawing
  // direction) to +0.5 (right edge):
  //   one look for the whole way         [-0.5, 0.5]
  //   different limits per direction     forward [0, 0.5] (right), backward [-0.5, 0] (left)
  //   limits per lane                    the direction's part cut into one stripe per lane

  /**
   * Colour and pattern of one stripe.
   * @typedef {object} Look
   * @property {string} color
   * @property {string} dash   SVG stroke-dasharray, "" for a solid line, or DOTS for round dots.
   * @property {string} under  Solid colour drawn under the dashes, e.g. white under red; "" = none.
   */

  /** @typedef {{ from: number, to: number, look: Look }} Stripe */

  /**
   * Where a sign goes: side 0 = on the line, +1 = right half (forward), -1 = left half.
   * @typedef {{ side: number, info: DirectionSpeed }} SignSpot
   */

  /**
   * How one way is drawn.
   * @typedef {object} LineStyle
   * @property {Stripe[]} stripes
   * @property {boolean} overlay    Needs the overlay layer (several stripes, or a
   *                                background under dashes); the original line is
   *                                then made invisible.
   * @property {string} width       SVG stroke-width, "" to keep iD's own width.
   * @property {string} outline     iD's casing under the way: "" = leave it,
   *                                "none" = hide it (footways).
   * @property {SignSpot[]} signs
   * @property {string} key         Changes whenever the look changes (used to skip redraws).
   */

  /**
   * Look of a value: band colour; yellow dots on it for an advisory speed, long
   * dashes if the value only applies under a condition.
   * @param {number} kmh
   * @param {boolean} advisory
   * @param {boolean} conditional
   * @returns {Look}
   */
  function limitLook(kmh, advisory, conditional) {
    const band = bandFor(kmh).color;
    if (advisory) return { color: COLOR_ADVISORY, dash: DOTS, under: band };
    return { color: band, dash: conditional ? '12,5' : '', under: '' };
  }

  /**
   * Look of one direction without lanes.
   * @param {DirectionSpeed} info
   * @param {boolean} restricted  Access is restricted (see isAccessRestricted).
   * @returns {Look}
   */
  function directionLook(info, restricted) {
    switch (info.status) {
      case 'noSpeed': return { color: '#ffffff', dash: '5,4', under: '' };
      case 'missing': return { color: COLOR_MISSING, dash: '6,5', under: restricted ? UNDER_MISSING_RESTRICTED : UNDER_MISSING };
      case 'variable': return { color: COLOR_VARIABLE, dash: '3,3', under: UNDER_VARIABLE };
      // With maxspeed:variable and a maxspeed, the line shows that maximum as usual;
      // the electronic signs get an extra sign next to the main sign.
      default: return limitLook(info.kmh, info.advisory, !!info.condition);
    }
  }

  /**
   * Stripes for one direction, covering [from, to] of the line's width.
   * OSM lists lanes from left to right in driving direction. Driving forward that
   * is from the low to the high end of [from, to]; driving backward it is the
   * other way round. So on two-way roads lane 1 is next to the centre line on both
   * sides, on oneway=yes it is the left edge, on oneway=-1 the right edge.
   * @param {DirectionSpeed} info
   * @param {Direction} direction
   * @param {number} from
   * @param {number} to
   * @param {boolean} restricted
   * @returns {Stripe[]}
   */
  function stripesFor(info, direction, from, to, restricted) {
    const lanes = info.status === 'limit' ? info.lanes : null;
    if (!lanes) return [{ from, to, look: directionLook(info, restricted) }];
    const step = (to - from) / lanes.length;
    return lanes.map((lane, i) => {
      const k = direction === 'forward' ? i : lanes.length - 1 - i;
      return { from: from + k * step, to: from + (k + 1) * step, look: limitLook(lane.kmh, lane.advisory, false) };
    });
  }

  /** Everything a viewer would see for one direction, to compare the two. @param {DirectionSpeed} d */
  const lookOf = (d) => JSON.stringify([
    d.status, d.kmh, d.advisory, d.variable, d.sign, d.symbol, d.condition?.label, d.lanes,
    d.extras.map((e) => [e.kmh, e.label, e.kind]),
  ]);

  /**
   * Line style for one way and vehicle type, or null to leave iD's own style.
   * One-way roads use the whole width for their one direction. Two-way roads are
   * split into halves when the directions differ or have lanes: the right half
   * (seen in drawing direction) for forward, the left half for backward, as in
   * right-hand traffic.
   * @param {Tags} tags
   * @param {string[]} vehicleSuffixes  See OMC_VEHICLES, e.g. ["hgv"]; [] for cars.
   * @param {string | null} [country]  For the legal defaults, see waySpeed.
   * @param {WeightRange | null} [weight]  Truck class, see directionSpeed.
   * @returns {LineStyle | null}
   */
  function lineStyleFor(tags, vehicleSuffixes, country = null, weight = null) {
    const { forward, backward, restricted } = waySpeed(tags, vehicleSuffixes, country, weight);
    /** @type {Stripe[]} */
    let stripes;
    /** @type {SignSpot[]} */
    let signs;
    let width = '';
    let outline = '';
    if (forward && backward && (forward.lanes || backward.lanes || lookOf(forward) !== lookOf(backward))) {
      stripes = [...stripesFor(forward, 'forward', 0, 0.5, restricted), ...stripesFor(backward, 'backward', -0.5, 0, restricted)];
      signs = [{ side: 1, info: forward }, { side: -1, info: backward }];
    } else {
      const info = forward || backward;
      if (!info) return null;
      stripes = stripesFor(info, forward ? 'forward' : 'backward', -0.5, 0.5, restricted);
      signs = [{ side: 0, info }];
      if (info.status === 'noSpeed') { width = '2px'; outline = 'none'; }
    }
    const first = stripes[0].look;
    const overlay = stripes.length > 1 || !!first.under || first.dash === DOTS;
    const key = JSON.stringify([stripes, width, outline]);
    return { stripes, overlay, width, outline, signs, key };
  }

  /** Text on the sign: the number, "🚶", or one value per lane ("100|80|60"). @param {DirectionSpeed} info */
  function signLabel(info) {
    if (info.status === 'variable') return '≈';
    if (info.lanes) return info.lanes.map((l) => l.sign || String(shown(l.kmh))).join('|');
    return info.sign || String(shown(info.kmh));
  }

  /**
   * Tooltip of a main sign: value with notes, the condition and the tag it came from.
   * @param {DirectionSpeed} info
   */
  function signTooltip(info) {
    const t = text();
    if (info.status === 'variable') return [t.variableSign, info.source].filter(Boolean).join('\n');
    const symbolName = info.symbol ? /** @type {Record<string, string>} */ (t.symbols)[info.symbol] || '' : '';
    if (info.status === 'noSpeed') return [symbolName, info.source].filter(Boolean).join('\n');
    const speed = info.sign && !info.lanes ? `${info.sign} ${t.walk}` : `${signLabel(info)} ${unitLabel()}`;
    const value = symbolName ? `${symbolName}: ${speed.replace(/^🚶 /, '')}` : speed;
    const notes = [
      info.advisory && !info.lanes ? t.advisory : '',
      info.condition ? info.condition.label : '',
      info.implicit ? t.implicit : '',
    ].filter(Boolean);
    return [
      notes.length ? `${value} – ${notes.join(', ')}` : value,
      // The raw condition only if the label is not already the raw text.
      info.condition && info.condition.raw !== info.condition.label ? info.condition.raw : '',
      info.source,
    ].filter(Boolean).join('\n');
  }

  /**
   * Whether a sign is drawn in grey. Only a speed tagged explicitly (a number, none,
   * walk) is in colour. Grey: implicit values (maxspeed=DE:urban, source:maxspeed or
   * maxspeed:type without maxspeed, an untagged bicycle road …) and the country's
   * legal default where nothing is tagged.
   * @param {DirectionSpeed} info
   */
  const isGreySign = (info) => (info.status === 'missing' ? !!info.fallback : info.implicit);

  /**
   * Tooltip of a grey sign: the default value, that it is not tagged, and where it
   * comes from (country, road type) – or, for a bicycle road opened to other
   * vehicles, that maxspeed is missing there.
   * @param {DefaultSpeed} fallback
   */
  function defaultTooltip(fallback) {
    const t = text();
    if (fallback.openTo) return [signTooltip(fallback.info), t.bicycleRoadOpen(fallback.openTo)].join('\n');
    let country = fallback.country;
    try { country = new Intl.DisplayNames([LANG], { type: 'region' }).of(fallback.country) || country; } catch { /* e.g. GB-SCT */ }
    return [
      signTooltip(fallback.info).split('\n')[0],
      fallback.above ? t.aboveDefault(fallback.above) : t.defaultValue,
      t.defaultRoad(country, fallback.roadType),
      t.defaultSource,
    ].join('\n');
  }

  // ===========================================================================
  // Supplementary signs ("Zusatzzeichen") below a speed sign
  // ===========================================================================
  // As on real German signs, a condition is shown on small white panels under the
  // speed sign: an official panel where one exists (bei Nässe, Lkw, 7,5 t …), else
  // a panel in the same style with text made from the condition, e.g.
  // "Mo-Fr 07:00-17:00" → "Mo–Fr" / "7–17 h".

  /**
   * One panel: an official sign (key of SIGN_ART) or lines of text.
   * @typedef {{ art: string, lines: string[] }} Panel
   */

  const PANEL_TEXT = {
    de: {
      days: { mo: 'Mo', tu: 'Di', we: 'Mi', th: 'Do', fr: 'Fr', sa: 'Sa', su: 'So' },
      months: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
      PH: 'an Feiertagen', SH: 'in den Ferien', night: 'nachts', day: 'tagsüber', fog: 'bei Nebel',
      reasons: { peak_traffic: 'Verkehrslage', weather: 'Wetter', environment: 'Umweltschutz', obstruction: 'Störung', border_control: 'Grenzkontrolle' },
    },
    en: {
      days: { mo: 'Mo', tu: 'Tu', we: 'We', th: 'Th', fr: 'Fr', sa: 'Sa', su: 'Su' },
      months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      PH: 'public holidays', SH: 'school holidays', night: 'at night', day: 'by day', fog: 'in fog',
      reasons: { peak_traffic: 'traffic', weather: 'weather', environment: 'environment', obstruction: 'obstruction', border_control: 'border control' },
    },
  };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** Longest text line on a panel; longer conditions are cut. */
  const PANEL_MAX_CHARS = 18;

  /** "07:30" → "7.30", "17:00" → "17" (German signs write times like this). @param {string} time */
  const signTime = (time) => {
    const [h, m] = time.split(':');
    return m === '00' ? String(Number(h)) : `${Number(h)}.${m}`;
  };

  /**
   * Lines for one opening_hours rule such as "Mo-Fr 07:00-17:00", "Sa,Su",
   * "16:00-18:00", "PH" or "Nov-Mar"; null if it is not that simple.
   * @param {string} rule
   * @returns {string[] | null}
   */
  function ruleLines(rule) {
    const words = PANEL_TEXT[LANG];
    const r = rule.trim();
    const special = { 'sunset-sunrise': words.night, 'dusk-dawn': words.night, 'sunrise-sunset': words.day, 'dawn-dusk': words.day };
    const lower = r.toLowerCase();
    if (lower in special) return [special[/** @type {keyof typeof special} */ (lower)]];
    const m = r.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:\s*[-,]\s*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH))*)?\s*(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)?$/i);
    if (m && (m[1] || m[2])) {
      const lines = [];
      if (m[1]) {
        // Weekdays on one line; holidays (PH, SH) each on a line of their own, as on
        // the real panels ("Sa, So" / "an Feiertagen").
        const parts = m[1].replace(/\s+/g, '').split(',');
        const days = parts.filter((p) => !/^(ph|sh)$/i.test(p))
          .map((p) => p.replace(/[A-Za-z]{2}/g, (d) => words.days[/** @type {keyof typeof words.days} */ (d.toLowerCase())] || d).replace(/-/g, '–'));
        if (days.length) lines.push(days.join(', '));
        for (const p of parts) if (/^(ph|sh)$/i.test(p)) lines.push(words[/** @type {'PH'|'SH'} */ (p.toUpperCase())]);
      }
      if (m[2]) {
        const spans = m[2].replace(/\s+/g, '').split(',').map((span) => span.split('-').map(signTime).join('–'));
        lines.push(`${spans.join(', ')} h`);
      }
      return lines;
    }
    const months = r.match(/^([A-Za-z]{3})\s*-\s*([A-Za-z]{3})$/);
    if (months && MONTHS.includes(months[1].toLowerCase()) && MONTHS.includes(months[2].toLowerCase())) {
      return [`${words.months[MONTHS.indexOf(months[1].toLowerCase())]}–${words.months[MONTHS.indexOf(months[2].toLowerCase())]}`];
    }
    return null;
  }

  /**
   * Panels for one condition of maxspeed:conditional.
   * @param {Condition} condition
   * @returns {Panel[]}
   */
  function conditionPanels(condition) {
    const words = PANEL_TEXT[LANG];
    /** @type {Panel[]} */
    const panels = [];
    // "weight>7.5 AND hgv" → one panel per part.
    for (const part of condition.raw.split(/\s+AND\s+/i).map((p) => p.trim()).filter(Boolean)) {
      const lower = part.toLowerCase();
      const weight = lower.match(/^(?:max)?weight(?:rating)?\s*>\s*(\d+(?:\.\d+)?)$/);
      if (lower === 'wet') panels.push({ art: '1053-35', lines: [] });
      else if (/^(snow|ice|icy)$/.test(lower)) panels.push({ art: 'snow', lines: [] });
      else if (lower === 'fog') panels.push({ art: '', lines: [words.fog] });      else if (lower === 'hgv' || lower === 'goods') panels.push({ art: '1010-51', lines: [] });
      else if (lower === 'trailer' || lower === 'caravan') panels.push({ art: '1010-59', lines: [] });
      else if (lower === 'bus' || lower === 'coach') panels.push({ art: '1010-57', lines: [] });
      else if (lower === 'school') panels.push({ art: '1012-50', lines: [] });
      else if (weight && Number(weight[1]) === 7.5) panels.push({ art: '1053-33', lines: [] });
      else if (weight) panels.push({ art: '', lines: [`${LANG === 'de' ? weight[1].replace('.', ',') : weight[1]} t`] });
      else {
        // Times: several rules separated by ";" become several lines, at most four.
        const rules = part.split(';').map(ruleLines);
        const lines = rules.every(Boolean) ? rules.flatMap((l) => /** @type {string[]} */ (l)) : [part];
        panels.push({ art: '', lines: lines.slice(0, 4).map((l) => (l.length > PANEL_MAX_CHARS ? `${l.slice(0, PANEL_MAX_CHARS - 1)}…` : l)) });
      }
    }
    return panels.slice(0, 3);
  }

  /**
   * Panel for a value that only applies to the selected vehicle type, e.g. a truck
   * panel under the sign when the value came from maxspeed:hgv.
   * @param {DirectionSpeed} info
   * @returns {Panel[]}
   */
  function vehiclePanels(info) {
    const art = /** @type {Record<string, string>} */ ({ hgv: '1010-51', goods: '1010-51', bus: '1010-57', coach: '1010-57', trailer: '1010-59', caravan: '1010-59' })[info.vehicle];
    return art ? [{ art, lines: [] }] : [];
  }

  /**
   * Panels under the electronic-sign extra sign: the reasons of maxspeed:variable
   * (school_zone gets the official "Schule" panel).
   * @param {DirectionSpeed} info
   * @returns {Panel[]}
   */
  function variablePanels(info) {
    const reasons = PANEL_TEXT[LANG].reasons;
    return info.variableReasons.map((reason) => (reason === 'school_zone'
      ? { art: '1012-50', lines: [] }
      : { art: '', lines: [(reasons[/** @type {keyof typeof reasons} */ (reason)] || reason).slice(0, PANEL_MAX_CHARS)] }));
  }

  /** All panels under a main sign: vehicle first, then its condition. @param {DirectionSpeed} info */
  const mainPanels = (info) => [...vehiclePanels(info), ...(info.condition ? conditionPanels(info.condition) : [])];

  // Exports for the Node tests; in the browser this branch is skipped.
  if (typeof module !== 'undefined') {
    module.exports = {
      parseSpeed, parseConditional, directionSpeed, waySpeed, onewayOf, lineStyleFor, signLabel, signTooltip,
      compileTagFilter, defaultRoad, defaultTagsFor, defaultTooltip, defaultSpeeds, isGreySign,
      conditionPanels, mainPanels, variablePanels, weightConditionMet, weightOf, setHgvClasses,
      setDisplay, setNoSpeedRules, setExtraTypes, setVehicles, suffixesFor, checkSettings, bandFor, bandLabel, colorBands, shown,
    };
    return;
  }

  // ===========================================================================
  // From here on: browser only
  // ===========================================================================

  // iD runs at /id (an iframe inside /edit); other pages of the site are left alone.
  if (!/^\/(id|edit)(\/|$)/.test(location.pathname)) return;

  // Chrome injects the script once per frame; never run twice.
  const win = /** @type {Window & { __osmMaxspeedColors?: boolean }} */ (window);
  if (win.__osmMaxspeedColors) return;
  win.__osmMaxspeedColors = true;

  // ---------------------------------------------------------------------------
  // Settings from the popup (forwarded by bridge.js)
  // ---------------------------------------------------------------------------

  /** @type {Settings} */
  let settings = checkSettings(null);
  let onSettingsChanged = () => {};

  window.addEventListener('message', (event) => {
    // Only messages from this very page; anything else is ignored.
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.__omc !== 'settings') return;
    // Any script on the page could send this message, so the values are checked.
    settings = checkSettings(msg.settings);
    setNoSpeedRules(msg.noSpeed);
    setExtraTypes(msg.extraTypes);
    setVehicles(msg.vehicles);
    setHgvClasses(msg.hgvClasses);
    setDisplay(settings);
    onSettingsChanged();
  });

  // ---------------------------------------------------------------------------
  // Drawing on the map
  // ---------------------------------------------------------------------------

  // iD is a single-page app: start once its map layer exists.
  const waitForMap = setInterval(() => {
    if (document.querySelector('.layer-osm')) { clearInterval(waitForMap); start(); }
  }, 1000);

  function start() {
    // Position and folded state of the legend are remembered per site.
    const LEGEND_STORE = 'osm-maxspeed-colors';
    /** @type {{ pos: { x: number, y: number } | null, collapsed: boolean }} */
    const legendState = { pos: null, collapsed: false };
    try {
      const saved = JSON.parse(localStorage.getItem(LEGEND_STORE) || '{}');
      if (saved && Number.isFinite(saved.pos?.x) && Number.isFinite(saved.pos?.y)) legendState.pos = { x: saved.pos.x, y: saved.pos.y };
      legendState.collapsed = saved?.collapsed === true;
    } catch { /* unreadable – keep the defaults */ }
    const saveLegendState = () => {
      try { localStorage.setItem(LEGEND_STORE, JSON.stringify(legendState)); } catch { /* storage full or blocked */ }
    };

    /** Last style key per way line, to skip lines that did not change. @type {WeakMap<SVGPathElement, string>} */
    const appliedKey = new WeakMap();
    /** Current style per way line, used for the overlay and the signs. @type {WeakMap<SVGPathElement, LineStyle | null>} */
    const lineStyle = new WeakMap();
    // iD replaces a way's tags object whenever the way is edited, so the style can
    // be kept per tags object until the settings change.
    // The legal defaults also depend on the country, so it is stored with the style.
    /** @type {WeakMap<object, { country: string | null, style: LineStyle | null }>} */
    let styleByTags = new WeakMap();
    let redrawPending = false;
    /** @type {HTMLDivElement | null} */
    let legend = null;

    onSettingsChanged = () => {
      // Language, unit or vehicle may have changed: rebuild the legend, redraw everything.
      styleByTags = new WeakMap();
      if (legend) { legend.remove(); legend = null; }
      scheduleRedraw();
    };
    // Ask bridge.js for the current settings now that we are listening.
    window.postMessage({ __omc: 'ready' }, location.origin);

    /**
     * Data iD attached to an SVG element, if it looks like an OSM entity.
     * @param {Element} element
     * @returns {{ id: string, tags: Tags } | null}
     */
    function entityOf(element) {
      const data = /** @type {any} */ (element).__data__;
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;
      const tags = data.tags;
      return tags && typeof tags === 'object' ? { id: data.id, tags } : null;
    }

    /** @param {Tags} tags @param {string | null} country  null = no defaults. */
    function styleOf(tags, country) {
      let cached = styleByTags.get(tags);
      if (!cached || cached.country !== country) {
        cached = { country, style: lineStyleFor(tags, suffixesFor(settings.vehicle), country, weightOf(settings)) };
        styleByTags.set(tags, cached);
      }
      return cached.style;
    }

    // -------------------------------------------------------------------------
    // Country of a way, for the legal default speed limits
    // -------------------------------------------------------------------------
    // iD bundles the country borders it needs for its presets (country-coder). Its
    // location manager tells which registered areas contain a point, so the
    // countries of the default table are registered there once. Codes iD does not
    // know (most states and provinces) are left out; there the country's own rows
    // apply, if the table has any.
    // Where on earth a point of the map is, follows from iD's URL (#map=zoom/lat/lon
    // is the centre of the map) and Web Mercator with 256 px tiles, like iD itself.

    /** Location set id → table code; null until registered, empty if iD has no location manager. @type {Map<string, string> | null} */
    let countryIds = null;

    /** @returns {any} */
    const locationManager = () => /** @type {any} */ (window).iD?.locationManager;

    /** Table code at a point, "" if none. @param {number} lon @param {number} lat */
    function countryAt(lon, lat) {
      const manager = locationManager();
      if (!countryIds) {
        countryIds = new Map();
        if (!manager) return '';
        /** @type {Array<{ code: string, locationSet: { include: string[] }, locationSetID?: string }>} */
        const sets = [];
        for (const code of Object.keys(defaultSpeeds().countries)) {
          // An unknown code would be registered as the whole world, so it is checked first.
          try { manager.validateLocation(code.toLowerCase()); } catch { continue; }
          sets.push({ code, locationSet: { include: [code.toLowerCase()] } });
        }
        try { manager.registerLocationSets(sets); } catch { return ''; }
        for (const set of sets) if (set.locationSetID) countryIds.set(set.locationSetID, set.code);
      }
      if (!manager || !countryIds.size) return '';
      // Several areas contain the point (GB and GB-SCT): the smallest one wins.
      let best = '';
      let bestArea = Infinity;
      try {
        for (const [id, area] of manager.locationSetsAt([lon, lat])) {
          const code = countryIds.get(id);
          if (code && area < bestArea) { best = code; bestArea = area; }
        }
      } catch { return ''; }
      return best;
    }

    /** Map view from the URL and the map's screen box, or null. */
    function mapView() {
      const m = /[#&]map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(location.hash);
      const map = document.querySelector('.main-map');
      if (!m || !map) return null;
      const box = map.getBoundingClientRect();
      const k = (256 * 2 ** Number(m[1])) / (2 * Math.PI);
      const y0 = Math.log(Math.tan(Math.PI / 4 + (Number(m[2]) * Math.PI) / 360));
      /** Longitude and latitude at a point on screen. @param {number} x @param {number} y */
      const lonLat = (x, y) => [
        Number(m[3]) + ((x - (box.left + box.width / 2)) / k) * (180 / Math.PI),
        (2 * Math.atan(Math.exp(y0 - (y - (box.top + box.height / 2)) / k)) - Math.PI / 2) * (180 / Math.PI),
      ];
      return { key: `${m[0]} ${box.left} ${box.top} ${box.width} ${box.height}`, box, lonLat };
    }

    /** View the countries below were found for. */
    let countryViewKey = '';
    /** Country of the whole view if it shows only one, else null. @type {string | null} */
    let viewCountry = null;
    /** Country per way id, for views with more than one country. @type {Map<string, string>} */
    const countryByWay = new Map();

    /** Called once per redraw: did the view move to other countries? */
    function updateViewCountry() {
      const view = mapView();
      const key = view ? view.key : '';
      if (key === countryViewKey) return;
      countryViewKey = key;
      countryByWay.clear();
      if (!view) { viewCountry = ''; return; }
      // Corners, edge centres and centre: if all lie in one country, so does every way.
      const { box } = view;
      const found = new Set();
      for (const fx of [0, 0.5, 1]) {
        for (const fy of [0, 0.5, 1]) {
          const [lon, lat] = view.lonLat(box.left + fx * box.width, box.top + fy * box.height);
          found.add(countryAt(lon, lat));
        }
      }
      viewCountry = found.size === 1 ? [...found][0] : null;
    }

    // iD writes the map position into the URL only after the map has stopped
    // moving, and without a hashchange event. The countries found during the move
    // may then be off, so a changed URL triggers another redraw.
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash === lastHash) return;
      lastHash = location.hash;
      if (settings.enabled && settings.defaults) scheduleRedraw();
    }, 1000);

    /** Country of one way line ("" = none known). @param {SVGPathElement} path @param {string} id */
    function countryOf(path, id) {
      if (viewCountry !== null) return viewCountry;
      let country = countryByWay.get(id);
      if (country === undefined) {
        country = '';
        const view = mapView();
        const matrix = path.getScreenCTM();
        if (view && matrix) {
          const b = path.getBBox();
          const p = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(matrix);
          const [lon, lat] = view.lonLat(p.x, p.y);
          country = countryAt(lon, lat);
        }
        countryByWay.set(id, country);
      }
      return country;
    }

    /** Colours one way line. @param {SVGPathElement} path */
    function paintLine(path) {
      const entity = settings.enabled ? entityOf(path) : null;
      const country = entity && settings.defaults && ROADS.has(entity.tags.highway) ? countryOf(path, entity.id) : null;
      const style = entity ? styleOf(entity.tags, country) : null;
      lineStyle.set(path, style);

      const key = style ? style.key : '';
      if ((appliedKey.get(path) || '') === key) return;
      appliedKey.set(path, key);

      const css = path.style;
      if (!style) {
        for (const prop of ['stroke', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-width']) css.removeProperty(prop);
        return;
      }
      if (style.overlay) {
        // Drawn by drawOverlay instead (stripes, or dashes on a coloured
        // background), so the original line is made invisible. It stays clickable.
        for (const prop of ['stroke', 'stroke-dasharray', 'stroke-linecap', 'stroke-width']) css.removeProperty(prop);
        css.setProperty('stroke-opacity', '0', 'important');
        return;
      }
      const look = style.stripes[0].look;
      css.setProperty('stroke', look.color, 'important');
      css.setProperty('stroke-opacity', '1', 'important');
      if (style.width) css.setProperty('stroke-width', style.width, 'important');
      else css.removeProperty('stroke-width');
      if (look.dash) {
        css.setProperty('stroke-dasharray', look.dash, 'important');
        // iD draws round line ends; their caps would fill the gaps of a dashed line.
        css.setProperty('stroke-linecap', 'butt', 'important');
      } else {
        css.removeProperty('stroke-dasharray');
        css.removeProperty('stroke-linecap');
      }
    }

    function redraw() {
      redrawPending = false;
      if (!document.querySelector('.layer-osm')) {
        signLayer?.replaceChildren();
        overlayLayer?.replaceChildren();
        return;
      }
      updateLegend();
      if (settings.defaults) updateViewCountry();
      // One <path class="way line stroke"> per way. ".casing" is the outline below,
      // ".shadow" the selection halo and ".target" iD's invisible click area; those
      // stay untouched here.
      const lines = /** @type {SVGPathElement[]} */ (Array.from(
        document.querySelectorAll('.layer-osm path.way.line:not(.shadow):not(.casing):not(.target)'),
      ));
      lines.forEach(paintLine);
      styleOutlines(lines);
      drawOverlay(lines);
      drawSigns(lines);
    }

    function scheduleRedraw() {
      if (redrawPending) return;
      redrawPending = true;
      requestAnimationFrame(redraw);
    }

    // iD draws an outline (casing) under each way as a separate element with the same
    // data. For footways and other "no speed" ways it is hidden, so the thin white
    // dashes stand on the base map.
    /** Outline value applied per element, to skip unchanged ones. @type {WeakMap<SVGPathElement, string>} */
    const appliedOutline = new WeakMap();
    /** @param {SVGPathElement[]} lines */
    function styleOutlines(lines) {
      /** Way id → wanted outline. @type {Map<string, string>} */
      const outlineById = new Map();
      for (const line of lines) {
        const entity = entityOf(line);
        const outline = lineStyle.get(line)?.outline;
        if (entity && outline) outlineById.set(entity.id, outline);
      }
      for (const path of /** @type {NodeListOf<SVGPathElement>} */ (document.querySelectorAll('.layer-osm path.way.casing'))) {
        const entity = entityOf(path);
        const wanted = (settings.enabled && entity && outlineById.get(entity.id)) || '';
        if ((appliedOutline.get(path) || '') === wanted) continue;
        appliedOutline.set(path, wanted);
        const css = path.style;
        if (wanted === 'none') css.setProperty('stroke-opacity', '0', 'important');
        else css.removeProperty('stroke-opacity');
      }
    }

    // -------------------------------------------------------------------------
    // Speed-limit signs
    // -------------------------------------------------------------------------

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const SIGN_RADIUS = 11; // px
    const EXTRA_SIGN_RADIUS = 9; // px, the small signs for conditional limits
    const SIGN_SPACING = 450; // px between signs along long roads
    /** Smallest free space between two signs, in px. */
    const SIGN_CLEARANCE = 4;
    const MAX_SIGNS = 400;
    /** Space between a sign and the next extra sign, in px. */
    const SIGN_GAP = 5;
    /** Height of an official sign (325.1, 274.1 …) as a multiple of the round sign's diameter. */
    const SYMBOL_SCALE = 1.1;
    /** Width of a supplementary panel as a multiple of the round sign's diameter. */
    const PANEL_SCALE = 1.2;
    /** Space between a sign and its panels, in px. */
    const PANEL_GAP = 1.5;
    /**
     * Condition shown as a sample panel in the legend, per kind of OMC_EXTRA_TYPES
     * ("" = a "?" panel). Unknown kinds keep their emoji.
     * @type {Record<string, string>}
     */
    const LEGEND_PANEL_SAMPLES = {
      wet: 'wet', snow: 'snow', fog: 'fog', daytime: 'sunset-sunrise', time: 'Mo-Fr 07:00-17:00',
      school: 'school', holiday: 'PH', season: 'Nov-Mar', vehicle: 'weight>7.5', other: '',
    };
    /** Sign radius the legend's sample panels are scaled to. */
    const LEGEND_PANEL_RADIUS = 9;
    const PANEL_FONT ="'DIN 1451 Mittelschrift','DIN Alternate','Roboto Condensed','Arial Narrow',sans-serif";
    /** A parallel line closer than this (px) counts as a neighbour, see awayFromNeighbour. */
    const NEIGHBOUR_DISTANCE = 60;
    /** Lines whose directions differ by more than about 25° are not parallel (sine of the angle). */
    const NEIGHBOUR_MAX_SINE = 0.42;
    /** Distance between samples for the neighbour lookup, in px, and their upper bound per redraw. */
    const NEIGHBOUR_SAMPLE_STEP = 15;
    const MAX_NEIGHBOUR_SAMPLES = 20000;
    /** @type {SVGGElement | null} */
    let signLayer = null;

    /**
     * @param {string} name
     * @param {Record<string, string | number>} attrs
     */
    function svgElement(name, attrs) {
      const el = document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      return el;
    }

    /** Font size of a sign's text: smaller for three characters and more. @param {string} label @param {number} r */
    const signFontSize = (label, r) => ([...label].length >= 3 ? 0.82 : 1) * r;

    /**
     * Half the width of a sign. Up to three characters fit into the round sign;
     * longer texts (one value per lane) get an elongated sign.
     * @param {string} label
     * @param {number} r
     */
    function signHalfWidth(label, r) {
      const chars = [...label].length;
      return chars <= 3 ? r : Math.max(r, (chars * 0.56 * signFontSize(label, r)) / 2 + r * 0.55);
    }

    // Official sign artwork (SIGN_ART, at the end of this file) is put into the map
    // once as <symbol> elements and drawn with <use>, so each sign on the map is a
    // single small element. The symbols sit in a plain <g>, not in <defs>: iD looks
    // up its clip paths with selectAll("defs") and fails on a <defs> of ours
    // ("insertBefore … not a child", 2026-10-25); symbols are not drawn either way.
    /** @type {SVGGElement | null} */
    let artDefs = null;

    /** Makes sure the <symbol> elements exist in the map's SVG. @param {SVGSVGElement} svg */
    function ensureArt(svg) {
      if (artDefs && artDefs.ownerSVGElement === svg && artDefs.isConnected) return;
      artDefs = /** @type {SVGGElement} */ (svgElement('g', { class: 'osm-maxspeed-art' }));
      for (const [key, art] of Object.entries(SIGN_ART)) {
        const symbol = svgElement('symbol', { id: `omc-sign-${key}`, viewBox: `0 0 ${art.width} ${art.height}` });
        // The artwork is a constant in this file, never data from the page.
        const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${art.svg}</svg>`, 'image/svg+xml');
        symbol.append(...Array.from(parsed.documentElement.childNodes).map((n) => document.importNode(n, true)));
        artDefs.append(symbol);
      }
      svg.prepend(artDefs);
    }

    /**
     * An official sign, `height` px high, centred on (cx, cy).
     * @param {string} key  Key of SIGN_ART.
     * @param {number} cx
     * @param {number} cy
     * @param {number} height
     */
    function artUse(key, cx, cy, height) {
      const art = SIGN_ART[key];
      const width = (height * art.width) / art.height;
      return svgElement('use', { href: `#omc-sign-${key}`, x: cx - width / 2, y: cy - height / 2, width, height });
    }

    /** @typedef {{ l: number, t: number, r: number, b: number }} Box  Extent around a sign's centre, in px. */

    // Panel text is measured with the font the browser actually uses; a guess per
    // character was too small for the fallback fonts (text touched the edge, 2026-10-24).
    const measureContext = document.createElement('canvas').getContext('2d');
    /** Width of panel text in px. @param {string} line @param {number} fontSize */
    function textWidth(line, fontSize) {
      if (!measureContext) return [...line].length * fontSize * 0.62;
      measureContext.font = `600 ${fontSize}px ${PANEL_FONT}`;
      return measureContext.measureText(line).width;
    }

    /**
     * Supplementary panels stacked under a sign, starting at y = top; appended to
     * `group`. Returns the bottom edge and the widest half width.
     * @param {SVGElement} group
     * @param {Panel[]} panels
     * @param {number} r    Radius of the sign above; panels scale with it.
     * @param {number} top
     */
    function addPanels(group, panels, r, top) {
      const baseWidth = 2 * r * PANEL_SCALE;
      let y = top;
      let halfWidth = 0;
      for (const panel of panels) {
        y += PANEL_GAP;
        if (panel.art && panel.art !== 'snow' && SIGN_ART[panel.art]) {
          // Square panels (bei Nässe) are drawn a bit narrower, else they get very tall.
          const art = SIGN_ART[panel.art];
          const width = baseWidth * (art.width / art.height < 1.3 ? 0.8 : 1);
          const height = (width * art.height) / art.width;
          group.append(artUse(panel.art, 0, y + height / 2, height));
          y += height;
          halfWidth = Math.max(halfWidth, width / 2);
          continue;
        }
        // A panel in the official style: white, black edge, black text (or the snow symbol).
        const fontSize = baseWidth * 0.3;
        const lineHeight = fontSize * 1.1;
        // Free space between text and edge, as on the real panels.
        const padX = fontSize * 0.55;
        const padY = fontSize * 0.3;
        const lines = panel.art === 'snow' ? [] : panel.lines;
        const longest = Math.max(0, ...lines.map((l) => textWidth(l, fontSize)));
        const width = Math.max(baseWidth, longest + 2 * padX);
        const height = panel.art === 'snow' ? baseWidth * 0.55 : lines.length * lineHeight + 2 * padY;
        group.append(svgElement('rect', { x: -width / 2, y, width, height, rx: 1.5, fill: '#fff', stroke: '#111', 'stroke-width': 0.8 }));
        if (panel.art === 'snow') group.append(artUse('snow', 0, y + height / 2, height * 0.8));
        lines.forEach((line, i) => {
          const t = svgElement('text', {
            x: 0, y: y + padY + lineHeight * (i + 0.5), 'text-anchor': 'middle', 'dominant-baseline': 'central',
            'font-family': PANEL_FONT, 'font-weight': 600, 'font-size': fontSize.toFixed(2), fill: '#111',
          });
          t.textContent = line;
          group.append(t);
        });
        y += height;
        halfWidth = Math.max(halfWidth, width / 2);
      }
      return { bottom: y, halfWidth };
    }

    /**
     * One sign with its panels, drawn around (0, 0): red ring for a maximum speed,
     * blue square for an advisory speed (like the German sign 380), dark square for
     * variable signs, or an official sign (symbol). `inner` puts an official sign on
     * the dark face of an electronic sign (282 where there is no limit otherwise).
     * `muted` draws it in grey: a legal default, not a tagged value.
     * Returns the group, not yet placed, and its extent.
     * @param {{ label: string, kind: 'limit'|'advisory'|'variable', symbol?: SignSymbol, inner?: string, panels: Panel[], radius?: number, tooltip?: string, muted?: boolean }} spec
     * @returns {{ group: SVGGElement, box: Box }}
     */
    function signUnit(spec) {
      const { label, kind } = spec;
      const r = spec.radius || SIGN_RADIUS;
      const group = /** @type {SVGGElement} */ (svgElement('g', {}));
      // Grey faces (drawSignFace); the filter also turns panels and artwork grey.
      // Set through element.style, not a style attribute: openstreetmap.org's
      // Content-Security-Policy (style-src without 'unsafe-inline') drops style
      // attributes, but allows the CSSOM (2026-10-25).
      if (spec.muted) {
        group.style.filter = 'grayscale(1)';
        group.style.opacity = '0.85';
      }
      // Shown by our own tooltip (see showSignTooltip); the sign itself never takes
      // mouse events, so clicks reach the map underneath.
      if (spec.tooltip) group.setAttribute('data-tooltip', spec.tooltip);
      /** @type {Box} */
      let box;
      if (spec.inner && SIGN_ART[spec.inner]) {
        box = { l: -r, t: -r, r, b: r };
        drawSignFace(group, '', kind, r, r, !!spec.muted);
        group.append(artUse(spec.inner, 0, 0, 2 * r * 0.84));
      } else if (spec.symbol && SIGN_ART[spec.symbol]) {
        // Upright signs (Swiss zone sign 2.59.1, Dutch A1 …) get the full width, else
        // their ring is much smaller than a speed sign's (2026-10-25).
        const art = SIGN_ART[spec.symbol];
        const height = 2 * r * SYMBOL_SCALE * Math.max(1, art.height / art.width);
        const use = artUse(spec.symbol, 0, 0, height);
        group.append(use);
        const half = Number(use.getAttribute('width')) / 2;
        box = { l: -half, t: -height / 2, r: half, b: height / 2 };
      } else {
        const w = signHalfWidth(label, r);
        box = { l: -w, t: -r, r: w, b: r };
        drawSignFace(group, label, kind, r, w, !!spec.muted);
      }
      const { bottom, halfWidth } = addPanels(group, spec.panels, r, box.b);
      return { group, box: { l: Math.min(box.l, -halfWidth), t: box.t, r: Math.max(box.r, halfWidth), b: bottom } };
    }

    /**
     * Ring, square or bar with the speed in it.
     * @param {SVGElement} sign
     * @param {string} label
     * @param {'limit'|'advisory'|'variable'} kind
     * @param {number} r
     * @param {number} w  Half width.
     * @param {boolean} muted  Grey: a legal default, not a tagged value.
     */
    function drawSignFace(sign, label, kind, r, w, muted) {
      const ring = muted ? '#9e9e9e' : '#d00';
      const face = muted ? '#eeeeee' : '#fff';
      if (kind === 'advisory') {
        sign.append(svgElement('rect', { x: -w, y: -r, width: 2 * w, height: 2 * r, rx: 2, fill: muted ? '#8a8a8a' : '#1d4ed8', stroke: '#fff', 'stroke-width': 1.5 }));
      } else if (kind === 'variable') {
        // Dark face of an electronic sign.
        sign.append(svgElement('rect', { x: -w, y: -r, width: 2 * w, height: 2 * r, rx: 3, fill: '#212121', stroke: '#fff', 'stroke-width': 1.5 }));
      } else if (w > r) {
        // Ring stretched to a rounded bar for one value per lane.
        const sw = r * 0.27;
        sign.append(svgElement('rect', { x: -w + sw / 2, y: -r + sw / 2, width: 2 * w - sw, height: 2 * r - sw, rx: r - sw / 2, fill: face, stroke: ring, 'stroke-width': sw }));
      } else {
        sign.append(svgElement('circle', { r, fill: face, stroke: ring, 'stroke-width': r * 0.27 }));
      }
      const value = svgElement('text', {
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': 'system-ui,sans-serif', 'font-weight': 700,
        'font-size': signFontSize(label, r),
        fill: kind === 'advisory' ? '#fff' : kind === 'variable' ? '#ffca28' : muted ? '#616161' : '#111',
      });
      value.textContent = label;
      sign.append(value);
    }

    // -------------------------------------------------------------------------
    // Overlay: stripes and dashes on a background
    // -------------------------------------------------------------------------

    /** @type {SVGGElement | null} */
    let overlayLayer = null;
    /** Upper bound of sampled points per redraw, so huge views stay fast. */
    const MAX_STRIPE_POINTS = 50000;
    /** Distance between sampled points along a way, in px. */
    const STRIPE_SAMPLE_STEP = 4;

    /**
     * Path data for a line parallel to the given points, `offset` px to the right
     * (negative = left), converted with `matrix` into the overlay layer.
     * @param {DOMPoint[]} points  Points along the way, in path coordinates.
     * @param {number} offset
     * @param {DOMMatrix | null} matrix
     */
    function parallelPathData(points, offset, matrix) {
      const out = [];
      for (let i = 0; i < points.length; i++) {
        const before = points[Math.max(0, i - 1)];
        const after = points[Math.min(points.length - 1, i + 1)];
        const len = Math.hypot(after.x - before.x, after.y - before.y) || 1;
        // Right-hand normal (screen y points down).
        const nx = -(after.y - before.y) / len;
        const ny = (after.x - before.x) / len;
        const p = new DOMPoint(points[i].x + nx * offset, points[i].y + ny * offset);
        const q = matrix ? p.matrixTransform(matrix) : p;
        out.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
      }
      return `M${out.join('L')}`;
    }

    /**
     * Draws what a single SVG line cannot show (LineStyle.overlay): several stripes
     * side by side (directions, lanes) and dashes on a coloured background, e.g. red
     * on white for a missing limit, at exactly the width of the way.
     * The layer sits directly after iD's line layer, so points and labels stay on top.
     * iD has more than one layer with way lines: ".layer-osm.covered" (e.g. streams)
     * comes before ".layer-osm.lines". The overlay must follow the last of them,
     * otherwise the roads' casings cover it. Taking the first line's layer did that
     * whenever a stream happened to be in view (2026-10-24).
     * @param {SVGPathElement[]} lines  In document order.
     */
    function drawOverlay(lines) {
      const roadLayer = lines.length ? lines[lines.length - 1].closest('.layer-osm') : null;
      // Below zoom 16 iD draws no ways: the stripes of the last view must go too.
      if (!roadLayer) { overlayLayer?.replaceChildren(); return; }
      if (!overlayLayer || !overlayLayer.isConnected) {
        overlayLayer = /** @type {SVGGElement} */ (svgElement('g', { class: 'osm-maxspeed-stripes', 'pointer-events': 'none' }));
      }
      if (roadLayer.nextSibling !== overlayLayer) roadLayer.after(overlayLayer);

      const overlay = document.createDocumentFragment();
      const layerMatrix = overlayLayer.getCTM();
      if (settings.enabled && layerMatrix) {
        const toLayer = layerMatrix.inverse();
        let budget = MAX_STRIPE_POINTS;
        for (const line of lines) {
          const style = lineStyle.get(line);
          if (!style || !style.overlay) continue;
          const pathMatrix = line.getCTM();
          const matrix = pathMatrix ? toLayer.multiply(pathMatrix) : null;
          const width = parseFloat(getComputedStyle(line).strokeWidth) || 6;
          const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;

          /**
           * Background (if any) and dashes along the given path data.
           * @param {Look} look
           * @param {Record<string, string | number>} shape  d, stroke-width and optionally transform.
           */
          const addLine = (look, shape) => {
            const common = { fill: 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'round', ...shape };
            if (look.under) overlay.append(svgElement('path', { ...common, stroke: look.under }));
            const top = svgElement('path', { ...common, stroke: look.color });
            if (look.dash === DOTS) {
              // Round dots in the middle of the stripe: zero-length dashes with round
              // caps, on a narrower stroke. (Short dashes with straight ends on the
              // full width look like bars across the road instead.)
              const stripeWidth = Number(shape['stroke-width']) || 6;
              const dotSize = stripeWidth * 0.5;
              top.setAttribute('stroke-width', String(dotSize));
              top.setAttribute('stroke-linecap', 'round');
              top.setAttribute('stroke-dasharray', `0 ${dotSize * 2.2}`);
            } else if (look.dash) {
              top.setAttribute('stroke-dasharray', look.dash);
            }
            overlay.append(top);
          };

          /** Sampled points along the way, only computed if a stripe needs them. @type {DOMPoint[] | null} */
          let points = null;
          for (const stripe of style.stripes) {
            if (stripe.from <= -0.5 && stripe.to >= 0.5) {
              // Whole way: copy of the original path, same width, same position.
              /** @type {Record<string, string | number>} */
              const shape = { d: line.getAttribute('d') || '', 'stroke-width': width };
              if (matrix) shape.transform = `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e},${matrix.f})`;
              addLine(stripe.look, shape);
              continue;
            }
            if (!points) {
              let length;
              try { length = line.getTotalLength(); } catch { break; }
              const count = Math.max(2, Math.ceil(length / STRIPE_SAMPLE_STEP) + 1);
              if (count > budget) break;
              budget -= count;
              points = [];
              for (let i = 0; i < count; i++) {
                const p = line.getPointAtLength((length * i) / (count - 1));
                points.push(new DOMPoint(p.x, p.y));
              }
            }
            const centre = ((stripe.from + stripe.to) / 2) * width;
            addLine(stripe.look, { d: parallelPathData(points, centre, matrix), 'stroke-width': (stripe.to - stripe.from) * width * scale });
          }
        }
      }
      overlayLayer.replaceChildren(overlay);
    }

    /** @param {SVGPathElement[]} lines */
    function drawSigns(lines) {
      // SVG has no z-index: whatever comes last is drawn on top. iD has more layers
      // after .layer-osm, so the signs go to the very end of the map's SVG.
      const svg = lines.length ? lines[0].ownerSVGElement : null;
      // No ways (below zoom 16): clear the signs, else those of the last view stay (2026-10-25).
      if (!svg) { signLayer?.replaceChildren(); return; }
      if (!signLayer || !signLayer.isConnected) {
        signLayer = /** @type {SVGGElement} */ (svgElement('g', { class: 'osm-maxspeed-signs', 'pointer-events': 'none' }));
      }
      if (svg.lastChild !== signLayer) svg.append(signLayer);

      const signs = document.createDocumentFragment();
      const layerMatrix = signLayer.getCTM();
      if (settings.enabled && settings.signs && layerMatrix) {
        const toLayer = layerMatrix.inverse();
        const hiddenKinds = new Set(settings.hiddenExtras);
        ensureArt(svg);
        /** Boxes of the signs placed so far, in layer coordinates. @type {Box[]} */
        const placed = [];
        /** @param {Box} box @param {number} x @param {number} y */
        const isFree = (box, x, y) => placed.every((p) =>
          x + box.r + SIGN_CLEARANCE <= p.l || x + box.l - SIGN_CLEARANCE >= p.r
          || y + box.b + SIGN_CLEARANCE <= p.t || y + box.t - SIGN_CLEARANCE >= p.b);
        /** @param {Box} box @param {number} x @param {number} y */
        const place = (box, x, y) => placed.push({ l: x + box.l, t: y + box.t, r: x + box.r, b: y + box.b });
        /** How far a box reaches from its centre in direction u (a unit vector). @param {Box} box @param {{ x: number, y: number }} u */
        const reach = (box, u) => Math.max(box.l * u.x, box.r * u.x) + Math.max(box.t * u.y, box.b * u.y);
        /** @param {DirectionSpeed} info */
        const hasSign = (info) => info.status === 'limit' || info.status === 'variable' || (info.status === 'noSpeed' && !!info.symbol)
          || (info.status === 'missing' && !!info.fallback);

        /** Lines that get signs, with what both passes below need. */
        const signLines = [];
        for (const line of lines) {
          const style = lineStyle.get(line);
          if (!style || !style.signs.some((s) => hasSign(s.info))) continue;
          let length;
          try { length = line.getTotalLength(); } catch { continue; }
          if (length < 3 * SIGN_RADIUS) continue; // too short at this zoom level
          // Path coordinates → sign-layer coordinates, in case groups in between are moved.
          const pathMatrix = line.getCTM();
          const toSigns = pathMatrix ? toLayer.multiply(pathMatrix) : null;
          const toLayerPoint = (/** @type {number} */ at) => {
            const p = line.getPointAtLength(Math.max(0, Math.min(length, at)));
            return toSigns ? new DOMPoint(p.x, p.y).matrixTransform(toSigns) : p;
          };
          signLines.push({ style, length, toLayerPoint });
        }

        // Neighbouring lines. A dual carriageway is two one-way ways side by side; a
        // sign on the line itself would run into the other line's signs. So for every
        // sign we look for another signed line running alongside within
        // NEIGHBOUR_DISTANCE and put the sign on the far side, like the two halves of
        // a split way. The lines are sampled coarsely into a grid for the lookup.
        /** Grid cell → samples [x, y, unit direction x, unit direction y, line index]. @type {Map<string, Array<[number, number, number, number, number]>>} */
        const grid = new Map();
        const cellOf = (/** @type {number} */ x, /** @type {number} */ y) => `${Math.floor(x / NEIGHBOUR_DISTANCE)},${Math.floor(y / NEIGHBOUR_DISTANCE)}`;
        let sampleBudget = MAX_NEIGHBOUR_SAMPLES;
        signLines.forEach(({ length, toLayerPoint }, index) => {
          const count = Math.ceil(length / NEIGHBOUR_SAMPLE_STEP) + 1;
          if (count > sampleBudget) return;
          sampleBudget -= count;
          let previous = toLayerPoint(0);
          for (let i = 1; i < count; i++) {
            const p = toLayerPoint((length * i) / (count - 1));
            const len = Math.hypot(p.x - previous.x, p.y - previous.y) || 1;
            const x = (p.x + previous.x) / 2, y = (p.y + previous.y) / 2;
            const key = cellOf(x, y);
            let cell = grid.get(key);
            if (!cell) grid.set(key, (cell = []));
            cell.push([x, y, (p.x - previous.x) / len, (p.y - previous.y) / len, index]);
            previous = p;
          }
        });

        /**
         * Side away from the nearest parallel signed line next to `at`: +1 = right,
         * -1 = left, 0 = no such line.
         * @param {{ x: number, y: number }} at
         * @param {{ x: number, y: number }} right  Right-hand normal at `at`.
         * @param {number} index  Own line, which is skipped.
         */
        function awayFromNeighbour(at, right, index) {
          const cx = Math.floor(at.x / NEIGHBOUR_DISTANCE), cy = Math.floor(at.y / NEIGHBOUR_DISTANCE);
          let nearest = Infinity;
          let side = 0;
          for (let gx = cx - 1; gx <= cx + 1; gx++) {
            for (let gy = cy - 1; gy <= cy + 1; gy++) {
              for (const [x, y, dx, dy, other] of grid.get(`${gx},${gy}`) || []) {
                if (other === index) continue;
                // Parallel (either way round): direction almost along ours, i.e. almost
                // perpendicular to our normal.
                if (Math.abs(dx * right.x + dy * right.y) > NEIGHBOUR_MAX_SINE) continue;
                const across = (x - at.x) * right.x + (y - at.y) * right.y;
                const ahead = (x - at.x) * -right.y + (y - at.y) * right.x;
                if (Math.abs(across) < 1 || Math.abs(across) > NEIGHBOUR_DISTANCE || Math.abs(ahead) > NEIGHBOUR_DISTANCE / 2) continue;
                if (Math.abs(across) < nearest) { nearest = Math.abs(across); side = across > 0 ? -1 : 1; }
              }
            }
          }
          return side;
        }

        for (const [index, { style, length, toLayerPoint }] of signLines.entries()) {
          if (placed.length >= MAX_SIGNS) break;
          const count = Math.max(1, Math.floor(length / SIGN_SPACING));

          for (let i = 0; i < count; i++) {
            const along = (length * (i + 0.5)) / count;
            const at = toLayerPoint(along);
            // Right-hand normal of the way here (screen y points down).
            const ahead = toLayerPoint(along + 1);
            const behind = toLayerPoint(along - 1);
            const dirLength = Math.hypot(ahead.x - behind.x, ahead.y - behind.y) || 1;
            const right = { x: -(ahead.y - behind.y) / dirLength, y: (ahead.x - behind.x) / dirLength };

            // A sign on the line itself moves aside if another line runs alongside.
            const away = style.signs.length === 1 && style.signs[0].side === 0 ? awayFromNeighbour(at, right, index) : 0;

            for (const { info: tagged, side: ownSide } of style.signs) {
              if (!hasSign(tagged)) continue;
              // No value tagged, but a legal default: its sign, in grey.
              const fallback = tagged.status === 'missing' ? tagged.fallback : null;
              const info = fallback ? fallback.info : tagged;
              const muted = isGreySign(tagged);
              const side = ownSide || away;
              const main = signUnit({
                label: signLabel(info),
                kind: info.status === 'variable' ? 'variable'
                  : (info.lanes ? info.lanes.every((l) => l.advisory) : info.advisory) ? 'advisory' : 'limit',
                symbol: info.symbol,
                panels: mainPanels(info),
                tooltip: fallback ? defaultTooltip(fallback) : signTooltip(info),
                muted,
              });
              // Beside the line (split way or neighbouring line), the sign moves just
              // far enough along the normal that no part of it reaches the line.
              const outward = side === 0 ? { x: 1, y: 0 } : { x: right.x * side, y: right.y * side };
              const offset = side === 0 ? 0 : reach(main.box, { x: -outward.x, y: -outward.y }) + SIGN_CLEARANCE / 2;
              const x = at.x + outward.x * offset;
              const y = at.y + outward.y * offset;
              if (!isFree(main.box, x, y)) continue;
              place(main.box, x, y);
              main.group.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
              signs.append(main.group);

              // Extra signs, each with its panels, next to the main sign: first the
              // electronic signs (maxspeed:variable) with their reasons, then the
              // conditional limits. To the right for a sign on the line, outwards (away
              // from the line) for a sign beside it, so neighbouring signs never run
              // into each other.
              let distance = reach(main.box, outward);
              /** @type {Array<Parameters<typeof signUnit>[0]>} */
              const extraSpecs = [];
              // A bicycle road with a speed other than its 30: sign 244.1 next to the
              // speed or zone sign (with 30, 244.1 is the main sign itself). Shown also
              // with extra signs switched off.
              if (info.bicycleRoad && info.symbol !== '244.1') {
                extraSpecs.push({
                  label: '',
                  kind: 'limit',
                  symbol: '244.1',
                  panels: [],
                  tooltip: `${text().symbols['244.1']}\n${info.bicycleRoad}`,
                });
              }
              if (settings.extras && info.status === 'limit' && info.variable) {
                const reasons = info.variableReasons.map((r) => PANEL_TEXT[LANG].reasons[/** @type {'weather'} */ (r)] || r);
                extraSpecs.push({
                  label: '≈',
                  kind: 'variable',
                  // Without a limit (maxspeed=none) the gantries show sign 282 when
                  // nothing is switched on; the main sign is then the advisory 130.
                  inner: info.unlimited ? '282' : undefined,
                  panels: variablePanels(info),
                  radius: EXTRA_SIGN_RADIUS,
                  tooltip: [
                    info.unlimited ? text().variableExtraNone : text().variableExtra(`${signLabel(info)} ${unitLabel()}`),
                    reasons.join(', '), info.source.split('\n').pop() || '',
                  ].filter(Boolean).join('\n'),
                });
              }
              const extras = settings.extras ? info.extras.filter((e) => !hiddenKinds.has(e.kind)) : [];
              for (const extra of extras) {
                extraSpecs.push({
                  label: String(shown(extra.kmh)),
                  kind: 'limit',
                  panels: conditionPanels(extra),
                  radius: EXTRA_SIGN_RADIUS,
                  tooltip: `${shown(extra.kmh)} ${unitLabel()} ${extra.label}${extra.raw !== extra.label ? `\n${extra.raw}` : ''}${fallback || extra.fromDefault ? `\n${text().defaultValue}` : ''}`,
                  // Conditional limits are tagged as numbers; grey only if they come from the table.
                  muted: !!fallback || !!extra.fromDefault,
                });
              }
              for (const spec of extraSpecs) {
                const unit = signUnit(spec);
                distance += SIGN_GAP + reach(unit.box, { x: -outward.x, y: -outward.y });
                const ex = x + outward.x * distance;
                const ey = y + outward.y * distance;
                place(unit.box, ex, ey);
                unit.group.setAttribute('transform', `translate(${ex.toFixed(1)},${ey.toFixed(1)})`);
                signs.append(unit.group);
                distance += reach(unit.box, outward);
              }
            }
          }
        }
      }
      signLayer.replaceChildren(signs);
    }

    // -------------------------------------------------------------------------
    // Tooltip for the signs
    // -------------------------------------------------------------------------
    // Native SVG <title> tooltips do not appear on iD's map (tested 2026-10-23), as
    // the map handles the mouse itself. So the pointer position is
    // compared with the signs' screen boxes and a small box of our own is shown.

    const tooltip = document.createElement('div');
    tooltip.style.cssText = [
      'position:fixed', 'z-index:1001', 'pointer-events:none', 'white-space:pre-line',
      'background:rgba(20,20,20,.9)', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:4px 6px', 'border-radius:4px', 'max-width:260px', 'overflow-wrap:anywhere',
    ].join(';');
    tooltip.hidden = true;
    /** @type {MouseEvent | null} */
    let lastPointer = null;
    let tooltipPending = false;

    function showSignTooltip() {
      tooltipPending = false;
      const pointer = lastPointer;
      let tip = '';
      if (pointer && signLayer && settings.enabled && settings.signs) {
        // Last match wins: extra signs are drawn after (on top of) their main sign.
        for (const sign of signLayer.querySelectorAll('[data-tooltip]')) {
          const box = sign.getBoundingClientRect();
          if (pointer.clientX >= box.left && pointer.clientX <= box.right && pointer.clientY >= box.top && pointer.clientY <= box.bottom) {
            tip = sign.getAttribute('data-tooltip') || '';
          }
        }
      }
      if (!tip || !pointer) { tooltip.hidden = true; return; }
      if (!tooltip.isConnected) document.body.append(tooltip);
      if (tooltip.textContent !== tip) tooltip.textContent = tip;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(0, Math.min(pointer.clientX + 14, window.innerWidth - tooltip.offsetWidth - 4))}px`;
      tooltip.style.top = `${Math.max(0, Math.min(pointer.clientY + 14, window.innerHeight - tooltip.offsetHeight - 4))}px`;
    }

    window.addEventListener('mousemove', (event) => {
      lastPointer = event;
      if (tooltipPending) return;
      tooltipPending = true;
      requestAnimationFrame(showSignTooltip);
    }, { passive: true });

    // -------------------------------------------------------------------------
    // Legend (display only – the controls are in the toolbar popup)
    // -------------------------------------------------------------------------

    let keepLegendInWindow = () => {};
    window.addEventListener('resize', () => keepLegendInWindow());

    function updateLegend() {
      const wanted = settings.enabled && settings.legend;
      if (!wanted) {
        if (legend) { legend.remove(); legend = null; }
        return;
      }
      if (legend && legend.isConnected) return;
      const box = document.createElement('div');
      legend = box;
      box.style.cssText = [
        // Bottom right of the map: iD's sidebar is on the left, its map controls on
        // the right edge and its footer along the bottom.
        // max-content: otherwise the box gets narrower at the edge and wraps.
        'position:fixed', 'right:56px', 'bottom:46px', 'z-index:1000', 'width:max-content',
        'background:rgba(20,20,20,.85)', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
        'padding:6px 8px', 'border-radius:6px', 'user-select:none', 'pointer-events:auto',
        // Scrolls instead of leaving the window on small screens
        // (46 px default distance to the bottom + 10 px margin at the top).
        'max-height:calc(100vh - 56px)', 'overflow:auto', 'box-sizing:border-box',
      ].join(';');

      // Header: title (drag handle) and fold button.
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;gap:6px;align-items:center;font-weight:600';
      const handle = document.createElement('span');
      handle.textContent = `⠿ ${text().legendTitle}`;
      handle.title = text().drag;
      handle.style.cssText = 'flex:1;cursor:move;touch-action:none';
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.style.cssText = 'background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0 2px;line-height:1';
      header.append(handle, fold);

      const body = document.createElement('div');
      body.style.marginTop = '4px';

      /** "Label: value" line at the top. @param {string} label @param {string} value */
      const addInfo = (label, value) => {
        const line = document.createElement('div');
        const name = document.createElement('span');
        name.style.opacity = '.75';
        name.textContent = `${label}: `;
        line.append(name, value);
        body.append(line);
      };
      const vehicle = vehicles.find(([key]) => key === settings.vehicle);
      addInfo(text().vehicleHeading, vehicle ? `${vehicle[2]} ${LANG === 'en' ? vehicle[4] : vehicle[3]}` : settings.vehicle);
      const hgvClass = settings.vehicle === 'hgv' ? hgvClasses.find(([key]) => key === settings.hgvClass) : undefined;
      if (hgvClass) addInfo(text().hgvClassHeading, LANG === 'en' ? hgvClass[4] : hgvClass[3]);
      addInfo(text().unitHeading, unitLabel());

      /** Section heading with a thin line above. @param {string} title */
      const addHeading = (title) => {
        const heading = document.createElement('div');
        heading.style.cssText = 'font-weight:600;margin-top:6px;padding-top:4px;margin-bottom:2px;border-top:1px solid rgba(255,255,255,.25)';
        heading.textContent = title;
        body.append(heading);
      };

      /**
       * Row with a line sample and a label. The sample is a span whose CSS draws
       * the line (border-top), with `background` showing in the gaps of dashes.
       * @param {HTMLElement} parent
       * @param {string} swatchCss
       * @param {string} label
       */
      const addSwatchRow = (parent, swatchCss, label) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';
        const swatch = document.createElement('span');
        // Light outline so dark colours stay visible on the dark legend.
        swatch.style.cssText = `width:22px;flex:none;outline:1px solid rgba(255,255,255,.55);outline-offset:1px;${swatchCss}`;
        row.append(swatch, label);
        parent.append(row);
      };
      /**
       * @param {HTMLElement} parent
       * @param {string} color
       * @param {string} label
       * @param {'solid'|'dashed'|'dotted'} lineType
       * @param {string} [background]  Colour in the gaps, e.g. white under red dashes.
       */
      const addRow = (parent, color, label, lineType, background = 'transparent') =>
        addSwatchRow(parent, `height:0;border-top:5px ${lineType} ${color};background:${background}`, label);
      /** Two-column grid, used for the speed bands and the extra signs. */
      const addGrid = () => {
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:auto auto;column-gap:10px';
        body.append(grid);
        return grid;
      };

      addHeading(text().speedsHeading);
      const bands = addGrid();
      for (const band of colorBands()) addRow(bands, band.color, bandLabel(band), 'solid');

      addHeading(text().distinctionsHeading);
      addRow(body, COLOR_ADVISORY, text().advisoryOnly, 'dotted', KMH_BANDS[KMH_BANDS.length - 1].color);
      addRow(body, '#ccc', text().conditionalOnly, 'dashed');
      // Split way: two colours on top of each other, like the two halves on the map.
      addSwatchRow(body, `height:0;border-top:3px solid ${KMH_BANDS[9].color};border-bottom:3px solid ${KMH_BANDS[4].color}`, text().split);
      // Lanes: three thin stripes.
      addSwatchRow(body, `height:6px;background:linear-gradient(${KMH_BANDS[9].color} 0 33%,${KMH_BANDS[7].color} 33% 67%,${KMH_BANDS[5].color} 67%)`, text().lanes);
      addRow(body, COLOR_VARIABLE, text().variable, 'dashed', UNDER_VARIABLE);
      addRow(body, COLOR_MISSING, text().missing, 'dashed', UNDER_MISSING);
      addRow(body, COLOR_MISSING, text().missingRestricted, 'dashed', UNDER_MISSING_RESTRICTED);
      if (settings.signs) {
        // Grey sign: no number tagged, the value is implicit (DE:urban, living street …)
        // or the country's legal default.
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center';
        const face = svgElement('svg', { width: 22, height: 16, viewBox: '-11 -8 22 16' });
        face.style.flex = 'none';
        drawSignFace(face, String(shown(50)), 'limit', 7.5, 7.5, true);
        row.append(face, text().defaultsLegend);
        body.append(row);
      }
      addRow(body, '#ffffff', text().noSpeed, 'dashed');

      // Kinds of extra signs, only while they are shown on the map, each with a
      // sample of the panel it gets on the map. Kinds switched off in the popup are dimmed.
      if (settings.signs && settings.extras && extraTypes.length) {
        addHeading(text().extrasHeading);
        const kinds = addGrid();
        kinds.style.rowGap = '2px';
        const hidden = new Set(settings.hiddenExtras);
        // The panels use the artwork in the map's SVG (<use> works across SVGs of one page).
        const mapSvg = document.querySelector('.layer-osm')?.closest('svg');
        if (mapSvg) ensureArt(/** @type {SVGSVGElement} */ (mapSvg));
        for (const [key, kindIcon, de, en] of extraTypes) {
          const item = document.createElement('div');
          item.style.cssText = 'display:flex;gap:6px;align-items:center';
          const sample = LEGEND_PANEL_SAMPLES[key];
          const panels = sample === undefined ? [] : sample ? conditionPanels({ raw: sample, icon: '', label: '', kind: key }) : [{ art: '', lines: ['?'] }];
          if (panels.length) {
            const g = svgElement('g', {});
            const { bottom, halfWidth } = addPanels(g, panels, LEGEND_PANEL_RADIUS, -PANEL_GAP);
            const w = 2 * halfWidth + 2;
            const svg = svgElement('svg', { width: w, height: bottom + 1, viewBox: `${-w / 2} -0.5 ${w} ${bottom + 1}` });
            svg.style.flex = 'none';
            svg.append(g);
            item.append(svg);
          } else {
            item.append(kindIcon);
          }
          item.append(LANG === 'en' ? en : de);
          if (hidden.has(key)) item.style.opacity = '.35';
          kinds.append(item);
        }
        // The electronic-sign extra sign (maxspeed:variable).
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;gap:6px;align-items:center';
        const face = svgElement('svg', { width: 16, height: 16, viewBox: '-8 -8 16 16' });
        face.style.flex = 'none';
        drawSignFace(face, '≈', 'variable', 7, 7, false);
        item.append(face, text().variableExtraLegend);
        kinds.append(item);
      }

      const hint = document.createElement('div');
      hint.style.cssText = 'opacity:.8;font-size:11px;margin-top:4px;max-width:220px';
      hint.textContent = text().hint;
      body.append(hint);

      // Folding only hides the legend body; colouring stays on.
      const showFoldState = () => {
        body.hidden = legendState.collapsed;
        fold.textContent = legendState.collapsed ? '▸' : '▾';
        fold.title = legendState.collapsed ? text().expand : text().collapse;
      };
      showFoldState();
      fold.addEventListener('click', () => {
        legendState.collapsed = !legendState.collapsed;
        showFoldState();
        saveLegendState();
        keepLegendInWindow();
      });

      box.append(header, body);
      document.body.append(box);

      // Dragging by the title. The whole box always stays inside the window.
      /** @param {number} x @param {number} y */
      const moveTo = (x, y) => {
        const maxX = window.innerWidth - box.offsetWidth;
        const maxY = window.innerHeight - box.offsetHeight;
        box.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        box.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
      };
      keepLegendInWindow = () => { if (legendState.pos) moveTo(legendState.pos.x, legendState.pos.y); };
      keepLegendInWindow();

      handle.addEventListener('pointerdown', (down) => {
        down.preventDefault();
        const start = box.getBoundingClientRect();
        const dx = down.clientX - start.left;
        const dy = down.clientY - start.top;
        handle.setPointerCapture(down.pointerId);
        const onMove = (/** @type {PointerEvent} */ move) => moveTo(move.clientX - dx, move.clientY - dy);
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          const end = box.getBoundingClientRect();
          legendState.pos = { x: Math.round(end.left), y: Math.round(end.top) };
          saveLegendState();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    }

    // Redraw whenever the map changes. 'd' is watched too: when the map is moved,
    // iD only changes the path geometry, and the signs have to follow.
    // Our own updates are ignored, otherwise the layers would redraw forever.
    new MutationObserver((records) => {
      const ours = (/** @type {Node} */ node) => !!(signLayer?.contains(node) || overlayLayer?.contains(node) || tooltip.contains(node) || legend?.contains(node));
      if (records.some((r) => !ours(r.target))) scheduleRedraw();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['d'] });
    scheduleRedraw();
  }

  // ===========================================================================
  // Official sign artwork
  // ===========================================================================
  // Traffic signs from Wikimedia Commons (public domain as official works, in
  // Germany § 5 UrhG), optimised with svgo. Keys are the German sign numbers, other
  // countries' signs start with the country code ("CH-2.59.1"); "snow" is the symbol
  // "Schnee- oder Eisglätte". Sources: dev/signs/*.svg. After changing them, run
  // `node dev/build-signs.js`, which rewrites the block between the markers.
  // BEGIN GENERATED SIGN ART
  /** @type {Record<string, { width: number, height: number, svg: string }>} */
  const SIGN_ART = {
    "1010-51": { width: 600, height: 330, svg: "<defs><clipPath id=\"omc-1010-51-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 0h480v264H0z\"/></clipPath><clipPath id=\"omc-1010-51-b\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M477 264h3V0h-3z\"/></clipPath><clipPath id=\"omc-1010-51-c\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M444 0h36v264h-36z\"/></clipPath></defs><g clip-path=\"url(#omc-1010-51-a)\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"><path d=\"M32 263.8A32 32 0 0 1 .2 232V32A32 32 0 0 1 32 .2h416A32 32 0 0 1 479.8 32v200a32 32 0 0 1-31.8 31.8\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M32 .5A31.5 31.5 0 0 0 .5 32v200A31.5 31.5 0 0 0 32 263.5h416a31.5 31.5 0 0 0 31.5-31.5V32A31.5 31.5 0 0 0 448 .5zM448 264H32a32 32 0 0 1-32-32V32A32 32 0 0 1 32 0h416a32 32 0 0 1 32 32v200a32 32 0 0 1-32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M32 20h416a12 12 0 0 1 12 12v200a12 12 0 0 1-12 12H32a12 12 0 0 1-12-12V32a12 12 0 0 1 12-12m0-12A24 24 0 0 0 8 32v200a24 24 0 0 0 24 24h416a24 24 0 0 0 24-24V32a24 24 0 0 0-24-24\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M185.5 204V102.2h210.9V204zm-14.6-25.5-63-3.9c-2.9-.2-5.4-2-6.4-4.7l-16-42.8a29 29 0 0 1-1.9-10.2V76.7c0-4 3.3-7.3 7.3-7.3h3.6a32.7 32.7 0 1 0 65.5 0h131c0 10 4.4 19.3 12 25.5H171zm-25.4-12.7v-36.3l-48.3-5.7h-.4a3.6 3.6 0 0 0-3.4 4.9l12.1 32.5a4 4 0 0 0 3.2 2.3zM127.3 95a25.4 25.4 0 1 1 0-50.9 25.4 25.4 0 0 1 0 50.9m196.3 0a25.5 25.5 0 1 1 0-51 25.5 25.5 0 0 1 0 51m20.6 0a33 33 0 0 0 12.2-25.5h18.1l21.9 7.3V95z\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><g clip-path=\"url(#omc-1010-51-b)\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"><g clip-path=\"url(#omc-1010-51-c)\"><path d=\"M476.8 530.5v11.3m-8.5-19.8H457m615 8.5v11.3m8.6-19.8h11.3M476.8-328.4v-11.4m-8.5 19.9H457m615-8.5v-11.4m8.6 19.9h11.3\" style=\"fill:none;stroke:#fff;stroke-width:.5;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M476.8 530.5v11.3m-8.5-19.8H457m615 8.5v11.3m8.6-19.8h11.3M476.8-328.4v-11.4m-8.5 19.9H457m615-8.5v-11.4m8.6 19.9h11.3\" style=\"fill:none;stroke:#000;stroke-width:.25;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M750.4 542.5h48m-48-883h48M456.3 125V77m636.3 48V77M774.4 554.5v-24m0-859v-24M444.3 101h24m612.3 0h24M774.4 542.5h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0m-6-883h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0M456.3 101h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0m630.3 0h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0\" style=\"fill:none;stroke:#fff;stroke-width:.5;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M750.4 542.5h48m-48-883h48M456.3 125V77m636.3 48V77M774.4 554.5v-24m0-859v-24M444.3 101h24m612.3 0h24M774.4 542.5h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0m-6-883h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0M456.3 101h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0m630.3 0h6a6 6 0 1 0-12 0 6 6 0 0 0 12 0\" style=\"fill:none;stroke:#000;stroke-width:.25;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1\"/></g></g>" },
    "1010-57": { width: 600, height: 330, svg: "<defs><clipPath id=\"omc-1010-57-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 0h480v264H0z\"/></clipPath></defs><g clip-path=\"url(#omc-1010-57-a)\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"><path d=\"M32 263.8A32 32 0 0 1 .2 232V32A32 32 0 0 1 32 .2h416A32 32 0 0 1 479.8 32v200a32 32 0 0 1-31.8 31.8\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M32 .5A31.5 31.5 0 0 0 .5 32v200A31.5 31.5 0 0 0 32 263.5h416a31.5 31.5 0 0 0 31.5-31.5V32A31.5 31.5 0 0 0 448 .5zM448 264H32a32 32 0 0 1-32-32V32A32 32 0 0 1 32 0h416a32 32 0 0 1 32 32v200a32 32 0 0 1-32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M32 20h416a12 12 0 0 1 12 12v200a12 12 0 0 1-12 12H32a12 12 0 0 1-12-12V32a12 12 0 0 1 12-12m0-12A24 24 0 0 0 8 32v200a24 24 0 0 0 24 24h416a24 24 0 0 0 24-24V32a24 24 0 0 0-24-24\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"m78.5 189-.2 11c.2.8.4 1.6 1.4 1.6l311.7.2c14.2-2.8 17-39.6 24.3-60.2V97.1c-3.6-8.4-7.4-9-11.3-10.5L358 87c0 40.5-61.4 40.2-61.4 0H172c0 40.3-60 40.3-60 0H69c-2 .6-3.4 2.5-4.7 4.7l.5 39.9 18.3 52.6c.6 3.5-3 3.3-4.6 4.9\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M351.8 86.8a24.5 24.5 0 1 0-48.9 0 24.5 24.5 0 0 0 49 0M166.7 86.7a24.5 24.5 0 1 0-49 0 24.5 24.5 0 0 0 49 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"m340.5 181.7 10.8-36.7c.6-1.5 1.2-3 3-3.6h37.3c1.5 1.4 3 2.6 3.2 5.3l-10.5 36.6c-.9 3-2 3.7-3.3 4.2h-38q-2.7-1.8-2.5-5.8M287 181.8l10.7-36.7c.6-1.5 1.3-3 3-3.6H338c1.5 1.3 3 2.6 3.3 5.2l-10.6 36.7c-.9 2.9-2 3.7-3.3 4.2h-38q-2.7-1.8-2.5-5.8M233.8 181.8l10.8-36.7c.6-1.5 1.2-3 3-3.6h37.3c1.4 1.3 3 2.6 3.2 5.2l-10.6 36.7c-.8 2.9-2 3.7-3.2 4.2h-38q-2.8-1.8-2.5-5.8M181 181.8l10.7-36.7c.7-1.5 1.3-3 3-3.6H232c1.5 1.3 3 2.6 3.3 5.2l-10.6 36.7c-.9 2.9-2 3.7-3.3 4.2h-38q-2.6-1.8-2.4-5.8M136.6 184.3V145a6 6 0 0 1 3.5-3.6l38.7.2c1.5 1.3 3 2.5 3.3 5.2l-10.6 36.6c-.9 3-2 3.7-3.3 4.2h-28.7c-1.9-1-2.3-1-3-3.2M127.3 183.1V145c-.7-1.5-1.3-3-3-3.7l-44 .3c-1.4 1.2-3 2.5-3.2 5.1l13.2 36.6c.8 2.9 2 3.7 3.3 4.2l31.3-.1c1.8-1.1 2.5-1.7 2.4-4.3\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/>" },
    "1010-59": { width: 600, height: 330, svg: "<defs><clipPath id=\"omc-1010-59-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 0h480v264H0z\"/></clipPath></defs><g clip-path=\"url(#omc-1010-59-a)\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"><path d=\"M32 263.8A32 32 0 0 1 .2 232V32A32 32 0 0 1 32 .2h416A32 32 0 0 1 479.8 32v200a32 32 0 0 1-31.8 31.8\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M32 .5A31.5 31.5 0 0 0 .5 32v200A31.5 31.5 0 0 0 32 263.5h416a31.5 31.5 0 0 0 31.5-31.5V32A31.5 31.5 0 0 0 448 .5zM448 264H32a32 32 0 0 1-32-32V32A32 32 0 0 1 32 0h416a32 32 0 0 1 32 32v200a32 32 0 0 1-32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M32 20h416a12 12 0 0 1 12 12v200a12 12 0 0 1-12 12H32a12 12 0 0 1-12-12V32a12 12 0 0 1 12-12m0-12A24 24 0 0 0 8 32v200a24 24 0 0 0 24 24h416a24 24 0 0 0 24-24V32a24 24 0 0 0-24-24\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M100 101a21.2 21.2 0 1 0-42.4 0 21.2 21.2 0 0 0 42.4 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M146.5 182c1.2 1.3 2.5 2.4 4.8 2.3h102.8l51-40.5q.9-1.7 1-3l.2-35.8c-1-2-2-3.8-4-4h-12c0 35-51.8 35.2-51.8 0H105c0 35-52.3 35-52.3 0H38.3c-1.2.6-2.3 0-4 4.2l-.1 25.8c.8 2.3 1.9 3.2 3 4.1l75 12.5z\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M285.4 101a21.2 21.2 0 1 0-42.4 0 21.2 21.2 0 0 0 42.4 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"m266.5 150.4-21.9 22c-.6.5-1 1.2-2 1h-38.3v-30.8h65.2c3.1.6-1 4.7-3 7.8\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M365 111.7h-33.5v-5.4h-20.7v-5.6h52.5c.4 3.7.2 7.5 1.7 11\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"m122.7 147.2 25.6 25.3q.7 1 2 1h45.5v-31h-71.1c-2.7 1.1-3.1 2.7-2 4.7\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M410.2 101a21.2 21.2 0 1 0-42.5 0 21.2 21.2 0 0 0 42.5 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M331.6 116.4v48.2c1 7.5 4.9 8.2 8.4 9.3h98.2c2.6-.7 6-1.3 7.6-8.7v-48.8h-36.3c-7.5 15.3-33.3 15.4-41.2 0zM445.8 111.7l-5.3-11h-26c-.7 3.7-.7 7.5-2.7 11z\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/>" },
    "1012-50": { width: 600, height: 330, svg: "<defs><clipPath id=\"omc-1012-50-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 0h480v264H0z\"/></clipPath></defs><g clip-path=\"url(#omc-1012-50-a)\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"><path d=\"M32 263.8A32 32 0 0 1 .2 232V32A32 32 0 0 1 32 .2h416A32 32 0 0 1 479.8 32v200a32 32 0 0 1-31.8 31.8\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M32 .5A31.5 31.5 0 0 0 .5 32v200A31.5 31.5 0 0 0 32 263.5h416a31.5 31.5 0 0 0 31.5-31.5V32A31.5 31.5 0 0 0 448 .5zM448 264H32a32 32 0 0 1-32-32V32A32 32 0 0 1 32 0h416a32 32 0 0 1 32 32v200a32 32 0 0 1-32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M32 20h416a12 12 0 0 1 12 12v200a12 12 0 0 1-12 12H32a12 12 0 0 1-12-12V32a12 12 0 0 1 12-12m0-12A24 24 0 0 0 8 32v200a24 24 0 0 0 24 24h416a24 24 0 0 0 24-24V32a24 24 0 0 0-24-24\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/><path d=\"M126.4 114.3c0 7-2.2 13-6.7 16.9-3.5 3.1-7.8 5-15.5 6.1l-9.4 1.4c-3.8.6-7.2 2-9.3 3.9a10 10 0 0 0-3 7.6c0 7.3 5.2 12.9 15 12.9 7 0 12.9-1.5 18-6.4l8 7.9c-7 6.6-14.7 9.4-25.7 9.4-17.1 0-27.6-9.9-27.6-24.2q0-10.2 6-15.8 5.6-5.2 15.7-6.6l9.8-1.4c4.8-.7 7-1.5 9-3.5q3.3-3.1 3.3-8.6c0-8-6.3-12.6-17-12.6-8.6 0-15.2 1.8-21.2 7.8l-8.4-8.2c8-8 16.9-10.9 29.3-10.9 17.3 0 29.7 9 29.7 24.3M184.6 98.4l-8.1 7.7c-3.7-4-6.6-5.5-11.3-5.5q-6.9 0-10.9 5.2c-2.5 3.2-3.5 7.5-3.5 14.4 0 6.8 1 11 3.5 14.2q4 5.2 11 5.3c4.6 0 7.5-1.6 11.2-5.6l8.1 7.9c-5.6 5.9-11.3 8.2-19.4 8.2-13.2 0-26.2-8-26.2-30S152 90 165.2 90c8.1 0 13.8 2.4 19.4 8.4M245.7 90.7v38c0 12.7-7.3 21.5-20.4 21.5-5.8 0-11.2-2.2-15.2-6.6v29.7h-11.9V90.7h11.9v36c0 8.9 5.3 13 11.9 13s11.8-4 11.8-13v-36zM310.8 90.7v58.8H299v-35.8c0-9-5.6-13.1-12.2-13.1s-11.8 3.9-11.8 13v36H263v-37.7c0-6.6 1.4-12.2 6-16.6q5.2-5.1 14.5-5.3a21 21 0 0 1 15.6 6.6v-6zM352.7 90.7v10h-5.2c-4.7 0-6.4 2.4-6.4 7v65.6h-11.8V107c0-8.7 4.9-16.2 16.1-16.2zM412.6 116.7v5.2c0 16.7-9.2 28.3-25 28.3-15 0-25-11-25-30 0-22.4 11.8-30.2 26.5-30.2 10.3 0 16 3.1 22 9.2l-7.5 7c-4.2-4.1-7.6-6-14.2-6-9.7 0-15 6.4-15 16.5zm-11.8 8.2h-26.4c.1 3.6.3 5.4 1.5 8 1.9 4.4 6.1 7.5 11.7 7.5s9.8-3 11.6-7.5c1.2-2.6 1.5-4.4 1.6-8\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 330)\"/>" },
    "1053-33": { width: 421, height: 232, svg: "<path d=\"M22.7 185.2C10.4 185.2.4 175.2.4 163V22.6C.4 10.3 10.4.4 22.7.4H314c12.3 0 22.3 10 22.3 22.2V163c0 12.3-10 22.2-22.3 22.2z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 232)\"/><path d=\"M22.7 185.6A22.6 22.6 0 0 1 0 163V22.6A22.6 22.6 0 0 1 22.7 0H314a22.6 22.6 0 0 1 22.7 22.6V163a22.6 22.6 0 0 1-22.7 22.6zm0-.4H314c12.3 0 22.3-10 22.3-22.2V22.6c0-12.3-10-22.2-22.3-22.2H22.7C10.4.4.4 10.4.4 22.6V163c0 12.3 10 22.2 22.3 22.2\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 232)\"/><path d=\"M22.6 14.1h291.5c4.7 0 8.5 3.8 8.5 8.4v140.6c0 4.6-3.8 8.4-8.5 8.4H22.6a8.4 8.4 0 0 1-8.4-8.4V22.5c0-4.6 3.8-8.4 8.4-8.4m.4-8C13.8 6.1 6.2 13.6 6.2 23v139.8c0 9.3 7.6 16.8 16.8 16.8h290.8c9.3 0 16.8-7.5 16.8-16.8V22.9c0-9.3-7.5-16.8-16.8-16.8\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 232)\"/><path d=\"M261.6 49H253c-8.7 0-15.8 7.1-15.8 15.8v42.9h-7V119h7v21h14v-21h10.5v-11.4h-10.5V66.6c0-2.5 2-4.4 4.4-4.4h6.1zm-99.4 36.5v42h42v-11.2h-31.5V98.6a20.3 20.3 0 0 0 33-16V70.9a22.4 22.4 0 0 0-44.8-2.1h11.3a11.2 11.2 0 0 1 22.2 2v9.9a11.2 11.2 0 0 1-21.2 4.9zm-31-47v24.6h14V49zm-49 10.6 33.2 84H89.2v-14h-14v28h56v-13.2L97.9 49.1\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 232)\"/>" },
    "1053-35": { width: 601, height: 601, svg: "<path d=\"M32.2 480.4A32 32 0 0 1 .4 448.6V32.2A32 32 0 0 1 32.2.4h416.4a32 32 0 0 1 31.8 31.8v416.4a32 32 0 0 1-31.8 31.8z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M32.2 480.8A32 32 0 0 1 0 448.6V32.2A32 32 0 0 1 32.2 0h416.4a32 32 0 0 1 32.2 32.2v416.4a32 32 0 0 1-32.2 32.2zm0-.4h416.4a32 32 0 0 0 31.8-31.8V32.2A32 32 0 0 0 448.6.4H32.2A32 32 0 0 0 .4 32.2v416.4a32 32 0 0 0 31.8 31.8\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M32.2 472.6a24 24 0 0 1-24-24V32.2a24 24 0 0 1 24-24h416.4a24 24 0 0 1 24 24v416.4a24 24 0 0 1-24 24zm0-12h416.4a12 12 0 0 0 12-12V32.2a12 12 0 0 0-12-12H32.2a12 12 0 0 0-12 12v416.4a12 12 0 0 0 12 12\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M80.2 62v12l5.4 2.3a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.8 4.5a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.7 4.5a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.8 4.5a47 47 0 0 0 35.8 0v-12a47 47 0 0 1-35.8 0L354 59.8a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0L261 59.8a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0l-10.8-4.5a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M80.2 86v12l5.4 2.3a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.8 4.5a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.7 4.5a47 47 0 0 0 35.8 0l10.7-4.5a47 47 0 0 1 35.8 0l10.8 4.5a47 47 0 0 0 35.8 0v-12a47 47 0 0 1-35.8 0L354 83.8a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0L261 83.8a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0l-10.8-4.5a47 47 0 0 0-35.8 0l-10.7 4.5a47 47 0 0 1-35.8 0M168 292.4a15 15 0 0 1-13.7-9l-23.8-54.6a55 55 0 0 0-6.3-10.9l-3.6-4.8a18 18 0 0 1-3.6-10.8v-39a15 15 0 0 1 15-15h222.1a15 15 0 0 1 15 15v39a18 18 0 0 1-3.5 10.8L362 218q-3.9 5-6.4 10.9L332 283.3a15 15 0 0 1-13.8 9zm3.7-15h142.8a6 6 0 0 0 5.5-3.7l20.6-47.4h-195l20.6 47.4a6 6 0 0 0 5.5 3.7\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M132 142.3h36v-33c0-5-4-9-9-9h-18c-5 0-9 4-9 9M318.1 142.3h36v-33c0-5-4-9-9-9h-18c-5 0-9 4-9 9M278 433.3h-6.4v6.5h6.4zm0-38.4h-6.4v32h6.4zm-35.2 19.2h13.6a6.8 6.8 0 0 1-13.6 0m20-5.6h-20v-.8c0-2.8 1.7-5.3 4.3-6.3a9 9 0 0 1 10.1 2.5l4.9-4.2c-4.3-5-11.3-6.7-17.4-4.2-5 2-8.3 6.8-8.3 12.2v6.4a13.2 13.2 0 0 0 26.4 0zm-53.6-1.2a6.4 6.4 0 0 1 12.8 0v7.2a6.4 6.4 0 1 1-12.8 0zm-6.4-12.4v44.9h6.4v-16.5a10.8 10.8 0 0 0 19.2-6.8v-11.2a10.8 10.8 0 0 0-19.2-6.8V395M328.5 343.7h18.7a9.4 9.4 0 0 1-18.7 0m27.5-7.8h-27.5v-1c0-3.9 2.3-7.3 5.9-8.7 4.9-2 10.5-.6 14 3.4l6.6-5.8A21 21 0 0 0 331 318a18 18 0 0 0-11.4 16.8v8.9a18.2 18.2 0 1 0 36.3 0zm-83.7-11.6 6.2 6.2a19 19 0 0 1 19.6-4.2c2.3.9 3.4 3.4 2.6 5.7a4 4 0 0 1-3.9 2.8l-9.3.6a13.2 13.2 0 0 0-2.3 26c8.2 2 16.9.1 23.5-5.2l-5.5-6.8a19 19 0 0 1-16 3.5 4.4 4.4 0 0 1 .8-8.7l9.4-.6a13.2 13.2 0 0 0 3.8-25.5 27 27 0 0 0-28.9 6.2m-45.1 0 6.2 6.2a19 19 0 0 1 19.6-4.2c2.2.9 3.4 3.4 2.5 5.7a4 4 0 0 1-3.8 2.8l-9.4.6a13.2 13.2 0 0 0-2.2 26c8.2 2 16.8.1 23.4-5.2l-5.5-6.8a19 19 0 0 1-15.9 3.5 4.4 4.4 0 0 1 .8-8.7l9.3-.6a13.2 13.2 0 0 0 3.9-25.5 27 27 0 0 0-29 6.2M212.9 370H204v8.8h8.8zm-17.6 0h-8.9v8.8h8.9zm13.2-33.6h-12.7a5.5 5.5 0 1 1 0-11h7.2c3 0 5.5 2.5 5.5 5.5zm8.8-19.3h-8.8v4.6a9 9 0 0 0-7.7-4.6h-5.5a13.2 13.2 0 1 0 0 26.5h13.2v4.4a5 5 0 0 1-4.1 4.8 27 27 0 0 1-9.5 0 5 5 0 0 1-3.5-2.6l-7 5.5q3.3 4.7 9 5.8 6.3 1 12.5 0a14 14 0 0 0 11.4-13.5zm-92.5 0V379h8.8l28-44v44h9.4v-61.7h-8.8l-28 44v-44\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/>" },
    "242.1": { width: 600, height: 600, svg: "<path d=\"M28.5 449.8C.2 449.8.2 421.5.2 421.5v-393S.2.2 28.5.2h393c28.3 0 28.3 28.3 28.3 28.3v393s0 28.3-28.3 28.3z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/><path d=\"M28 442.4C7.5 442.4 7.6 422 7.6 422V28S7.7 7.6 28 7.6h394.2c20.3 0 20.2 20.3 20.2 20.3V422s0 20.3-20.2 20.3zm0-11.3h394s9-.3 9-9V28c0-8.7-9-9-9-9H28s-9 .3-9 9V422c0 8.7 9 9 9 9\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/><path d=\"M28.5 450c-14.2 0-21.4-7.1-25-14.3-3.5-7-3.5-14.2-3.5-14.2v-393s0-7.1 3.5-14.2C7.1 7 14.3 0 28.5 0h393c14.2 0 21.4 7.1 25 14.3 3.5 7 3.5 14.2 3.5 14.2v393s0 7.1-3.5 14.2c-3.6 7.2-10.8 14.3-25 14.3Zm0-.2h393c28.3 0 28.3-28.3 28.3-28.3v-393S449.8.2 421.5.2h-393C.2.2.2 28.5.2 28.5v393s0 28.3 28.3 28.3\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/><path d=\"M288.7 45.8v63h40.5v-9h-31v-18h26.5v-8.4h-26.4V54.8h31v-9zm-62 0v63h9l28.8-45v45h9.6v-63h-9l-28.8 45v-45Zm-47.8 22a13 13 0 1 1 25.9 0v19.1a13 13 0 0 1-25.9 0zm-9.6 0v19.1a22.5 22.5 0 0 0 45 0V67.8a22.5 22.5 0 0 0-45 0m-49.5-22v7.9l28.7 46.7h-27.6v8.5h39.4v-7.3l-28.7-46.8h28.7v-9\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/><path d=\"M359.6 269.9a135 135 0 1 0-270 0 135 135 0 0 0 270 0\" style=\"fill:#154889;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/><path d=\"M274.6 276a14.3 14.3 0 1 1-28.6 0 14.3 14.3 0 0 1 28.6 0m-69.3 83.5a16.3 16.3 0 1 0-32.6 0 16.3 16.3 0 0 0 32.6 0m-32.6-83.1 2.8 2.8a4 4 0 0 1 1.2 2.9v30.6c0 1-.9 2-2 2a2 2 0 0 1-2-2zM148.2 229a83 83 0 0 0 19.5 42.1c-4.7 5.2-7.3 12-7.3 19v16.3a28.5 28.5 0 0 0 53.9 13.2l17-32.5a12 12 0 0 0-2.2-14.3l16.8-14a22 22 0 0 1 20.6-4.5l3 .9c3.1.9 6.5-.2 8.5-2.7l20.8-25.2c3.5-4.3 3-10.6-1.3-14.2l-18.8 22 6-30.6-7.7-1.1 4.7-29.7a5.1 5.1 0 0 0-10-1.7l-5.9 29.7-6.6-1-3-32.3a5 5 0 0 0-10.1.8l4 70-29 27.4c-2.7 3.8-2.5 9 .5 12.5l-18 34.7q-.7 1-1.7.6-.7-.4-.7-1.1V282a4 4 0 0 1 1.2-3l3.6-3.5a82 82 0 0 0 23.7-46.5zm42.8-4h12.2V170a6.1 6.1 0 1 0-12.2 0zm-16.3 0H187v-42.9a6.1 6.1 0 0 0-12.2 0\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.33333 0 0 -1.33333 0 600)\"/>" },
    "244.1": { width: 600, height: 600, svg: "<path d=\"M30.4 479.8C.2 479.8.2 449.6.2 449.6V30.4S.2.2 30.4.2h419.2c30.2 0 30.2 30.2 30.2 30.2v419.2s0 30.2-30.2 30.2z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M29.8 471.9c-21.7 0-21.6-21.6-21.6-21.6V29.7s0-21.6 21.6-21.5h420.4c21.7 0 21.6 21.5 21.6 21.5v420.6s0 21.6-21.6 21.6zm0-12h420.4s9.6-.4 9.6-9.6V29.7c0-9.2-9.6-9.6-9.6-9.6H29.8s-9.6.4-9.6 9.6v420.6c0 9.2 9.6 9.6 9.6 9.6\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M30.4 480c-15.2 0-22.8-7.6-26.6-15.2S0 449.6 0 449.6V30.4s0-7.6 3.8-15.2S15.2 0 30.4 0h419.2c15.2 0 22.8 7.6 26.6 15.2s3.8 15.2 3.8 15.2v419.2s0 7.6-3.8 15.2-11.4 15.2-26.6 15.2zm0-.2h419.2c30.2 0 30.2-30.2 30.2-30.2V30.4S479.8.2 449.6.2H30.4C.2.2.2 30.4.2 30.4v419.2s0 30.2 30.2 30.2\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M41.5 49v44.6h28.8v-6.4h-22V74.1h18.8v-6H48.3V48.9zm56.7 0h-6.4v3.2l-.1-.3-.5-.7-.5-.5-.6-.5-.6-.4-.7-.4-.7-.2-.8-.2h-6.9l-1.1.3-1.2.5-1 .6-1 .7-.9.8-.7 1-.6 1-.6 1L73 56l-.2 1.2-.1 1.2v1.3l.3 1.2.3 1 .6 1.2.6 1 .7 1 1 .7.9.7 1 .7 1.2.4 1.1.3 1.2.2h10.2v3.8l-.1.4-.2.4-.2.3-.2.4-.2.4-.4.2-.3.2-.4.3-.4.1-.4.1H89l-1 .3h-5l-.8-.2h-.3l-.4-.2-.4-.1-.3-.3-.4-.2-.2-.3-.4-.3-.2-.4V73l-5.1 4 .3.4.8.9.8.8 1 .6 1 .6 1 .4 1 .4.6.1 1.2.2 2.2.1h2.2l2.4-.1 1-.2.6-.1 1.2-.4 1-.4 1-.6 1-.7.8-.8.7-.9.7-1 .5-1 .4-1 .3-1.3.1-1zm-6.4 13.9V58l-.1-.5-.2-.4-.2-.4-.4-.4-.3-.4-.3-.3-.4-.2-.4-.3-1-.3H82l-.5.2-.5.1-.4.3-.8.6-.3.4-.2.4-.3.5-.1.5-.1.5v1.5l.2.5.3.4.2.5.7.7.4.2.4.3.5.2h.5l.5.2zm16-14v44.7h6.4V77.2l.4.5 1 .9 1 .8 1 .6 1.1.6 1.3.3 1.2.2 1.2.1h1.3l1.3-.2 1.2-.4 1.1-.4 1.1-.7 1-.8 1-.8.8-1 .7-1 .6-1.2.4-1.1.3-1.3.1-1.2.1-.6V48.9H127v20l-.2.8-.1.8-.3.7-.4.7-.5.7-.5.5-.6.5-.8.5-.7.3-.7.2-.8.2h-1.6l-.8-.2-.7-.2-.7-.3-.8-.5-.6-.5-.5-.5-.5-.7-.4-.7-.3-.7-.2-.8-.1-.8v-20zm35.2 0v32h6.4v-3.7l.4.5.8.9 1 .7 1 .6 1 .6 1.2.3 1.2.3 1.2.1h1.2l1.2-.2 1.2-.2 1.1-.4 1.2-.6 1-.6.4-.4-4.5-5.6-.3.3-.6.4-.7.4-.7.3-.8.1h-2.3l-.7-.1-.8-.3-.7-.4-.5-.4-.7-.6-.5-.5-.5-.7-.3-.6-.2-.7-.3-.8V48.9zm26.3 0v32h6.4v-3.7l.4.5 1 .9.8.7 1 .6 1.2.6 1 .3 1.3.3 1.2.1h1.2l1.2-.2 1.2-.2 1.1-.4 1.1-.6 1-.6.5-.4-4.5-5.6-.3.3-.7.4-.6.4-.7.3-.8.1h-2.4l-.7-.1-.7-.3-.7-.4-.6-.4-.6-.6-.5-.5-.5-.7-.3-.6-.2-.7-.3-.8V48.9zm50.3 0h-6.3v3.3l-.2-.3-.4-.7-.6-.5-.5-.5-.7-.4-.6-.4-.8-.2-.7-.2H202l-1.2.3-1 .5-1.1.6-1 .7-.9.8-.8 1-.6 1-.5 1-.4 1.1-.2 1.2-.1 1.2v1.3l.3 1.2.4 1 .5 1.2.6 1 .8 1 1 .7.9.7 1 .7 1.1.4 1.2.3 1.2.2h10.2v3.8l-.1.4-.2.4-.3.3-.1.4-.3.4-.7.4-.3.3-.4.1-.4.1h-.2l-.8.3h-5.2l-.8-.2h-.2l-.4-.2-.4-.1-.4-.3-.3-.2-.3-.3-.3-.3-.2-.4-.1-.1-5 4 .3.4.7.9.9.8.8.6 1 .6 1.1.4 1 .4.6.1 1.2.2 2.3.1h2.2l2.3-.1 1-.2.6-.1 1.2-.4 1-.4 1-.6 1-.7.8-.8.8-.9.7-1 .4-1 .4-1 .3-1.3.1-1zm-6.3 14V58l-.2-.5-.2-.4-.2-.4-.3-.4-.3-.4-.4-.3-.4-.2-.4-.3-.5-.1-.4-.2h-6.6l-.6.2-.4.1-.5.3-.4.3-.3.3-.3.4-.3.4-.2.5-.1.5-.2.5v1l.2.5.1.5.2.4.3.5.3.3.3.4.4.2.5.3.4.2h.6l.5.2zm40.6-14h-6.4v3.6l-.4-.5-.9-.8-1-.8-1-.7-1.2-.5-1.2-.4-1.2-.2H238l-1.2.1-1.2.4-1.2.5-1.2.6-1.9 1.6-.8 1-.7 1-.6 1.2-.4 1.1-.3 1.3-.1 1.2v12.5l.1 1.2.3 1.3.4 1.1.6 1.2.7 1 .8 1 1 .8 1 .8 1 .7 1.3.4 1.2.4 1.2.2h2.5l1.2-.3 1.2-.3 1.2-.6 1-.6 1-.8 1-1 .3-.4v16.4h6.4zm-6.4 12.4V60l-.3-.9-.2-.7-.4-.7-.5-.6-.6-.6-.6-.5-.7-.5-.7-.3-.8-.2-.8-.2h-1.6l-.6.2-.8.2-.7.3-.7.5-.6.5-.6.6-.5.6-.4.7-.2.7-.3.9v9.6l.3.8.2.7.4.7.5.7.6.5.6.5.7.5.7.3.8.2.6.2h1.6l.8-.2.8-.2.7-.3.7-.5.6-.5.6-.5.5-.7.4-.7.2-.7.2-.8.1-.8zM262 54l.8-.8 1.7-1.4 2-1.2 2-1 2.1-.7 2.3-.5 2.2-.1h2.2l2.3.3 2.2.6 1 .3.6.2 1 .5 1 .6.8.8.8.8.6 1 .6 1 .4 1 .3 1.1.1 1.1.1 1.2-.1 1-.3 1.2-.3 1-.5 1-.6 1-.7 1-.8.7-1 .7-.9.6-1 .4-1.2.3-1 .3h-.6l-6.8.5h-.5l-.4.1-.3.2-.4.2-.3.3-.2.2-.3.3-.2.3-.2.4v.3l-.1.4-.1.4v.7l.1.4.2.3.2.4.2.3.3.2.3.3.3.2.3.2.4.1h.2l.7.2 1.5.2h1.5l1.6-.1 1.5-.4 1.4-.4 1.4-.8 1.3-.8.6-.4 4 5-1 .6-1.8 1.2-2 1-2.2.8-2.2.5-2.2.2h-2.3l-2.2-.3-1.1-.2-.6-.2-1-.4-1-.5-1-.6-.9-.7-.8-1-.6-.8-.6-1-.4-1-.3-1.1-.1-1.1v-2.4l.3-1 .3-1.1.5-1 .6-1 .7-1 .8-.7 1-.7.9-.6 1-.4 1.2-.3 1-.3h.6l6.8-.4h.2l.3-.1.4-.1.3-.2.4-.2.3-.2.2-.3.5-.6.2-.3v-.4l.2-.8v-.7l-.2-.3-.1-.4-.2-.3-.2-.4-.3-.2-.3-.2-.3-.3-.3-.1-.2-.1-.7-.3-1.5-.4-1.5-.1-1.6-.1-1.5.2-1.4.3-1.6.5-1.3.7-1.3.8-1.2.9-.6.5zm47-5h-5.3l-.8.2-.8.4-.7.4-.7.4-.7.6-.6.6-.5.8-.4.8-.3.8-.2.8-.1.8v20h-3.2v5.2h3.2v9.6h6.4v-9.6h4.8v-5.1h-4.8V56.5l.1-.5.2-.2v-.2l.2-.1.3-.2.1-.1.3-.1.2-.1h.2l.3-.2h2.9zm8.9 0v31.8h6.3v-3.6l.4.5.9.9 1 .7 1 .6 1 .6 1.2.3 1.2.3 1.2.1h1.3l1.2-.2 1-.2 1.2-.4 1.1-.6 1-.6.5-.4-4.5-5.6-.3.3-.7.4-.6.4-.7.3-.8.1h-2.3l-.8-.1-.7-.3-.7-.4-.6-.4-.6-.6-.5-.5-.4-.7-.4-.6-.3-.7-.1-.8-.2-.7v-20zm50.3 0h-6.4v3.2l-.2-.3-.4-.7-.5-.5-.7-.5-.5-.4-.7-.4-.8-.2-.7-.2h-6.9l-1.2.3-1.1.5-1 .6-1 .7-.9.8-.8 1-.6 1-.5 1-.4 1.1-.2 1.2v2.5l.2 1.2.4 1 .5 1.2.6 1 .8 1 .9.7 1 .7 1 .7 1.1.4 1.2.3 1.2.2h10.2v3.8l-.2.4-.1.4-.2.3-.2.4-.3.4-.6.4-.4.3-.4.1-.4.1h-.2l-.8.3h-5.2l-.8-.2h-.2l-.4-.2-.4-.1-.3-.3-.4-.2-.3-.3-.3-.3-.2-.4-.1-.1-5 4 .3.4.7.9.9.8 1 .6.9.6 1 .4 1.1.4.6.1 1.1.2 2.3.1h2.2l2.3-.1 1.2-.2.5-.1 1.1-.4 1-.4 1-.6 1-.7.9-.8.7-.9.7-1 .4-1 .4-1 .4-1.3v-1l.1-.6zm-6.4 13.9V58l-.2-.5-.1-.4-.3-.4-.3-.4-.6-.7-.4-.2-.4-.3-1-.3H352l-.5.2-.5.1-.4.3-.5.3-.3.3-.3.4-.3.4-.2.5-.2.5v.5l-.1.4v.5l.1.6.2.5.2.4.3.5.3.3.3.4.5.2.4.3.5.2h.5l.4.2zm16-14v35.7l.1 1.1.3 1 .4 1 .4 1 .6 1 .6.8.8.7 1 .7.8.6 1 .4.5.2 1 .4 2 .4 2.2.2h2.1l2.1-.2 2-.4 1.1-.4.5-.2 1-.4 1-.6.8-.7.7-.7.8-.9.5-.9.5-1 .4-1 .2-1 .1-1.1v-2.9l-.2-.7-.3-.8-.3-.6-.4-.6-.5-.7-.5-.5-.6-.4-.6-.5-.7-.3-.4-.1.4-.2.7-.3.6-.4.6-.5.5-.5.5-.6.4-.6.3-.8.3-.7.1-.7.1-.7V56.2l-.7-2.2-.5-.8-.6-1-.7-.7-.9-.7-.8-.7-1-.5-2-.6h-5.5v5.8h3.3l.4.1.4.1.4.2.3.1.3.3.3.2.3.3.2.3.3.7.2.8v12.3l-.2.8-.3.7-.2.3-.3.3-.3.3-.3.2-.3.1-.4.2-.4.1h-4.5v6h4.5l.4.2.7.3.3.2.3.3.3.3.2.3.2.3.1.3.2.9v2l-.2.6-.1.4-.1.3-.3.3-.2.3-.2.2-.4.3-.2.1-.4.2h-.2l-.6.3-1.4.2-1.4.2h-1.4l-1.5-.2-1.4-.2-.7-.2-.1-.1-.4-.2-.3-.1-.2-.3-.3-.2-.2-.3-.2-.3-.2-.3v-.4l-.2-.3V48.9zm60.7 13.6h-20v-1.2l.1-.8.3-.8.2-.8.4-.7.4-.6.6-.7.5-.5.7-.5.7-.4.4-.2.5-.1 1-.3 1-.1 1-.1h1l1 .3.9.2 1 .4.8.6.8.6 1 1 5-4.2-.7-.6-1.2-1.1-1.4-1-1.5-1-1.6-.6-1.6-.5-1.7-.4h-3.5l-1.7.3-1.6.5-1 .2-.6.3-1.4.8-1.3.9-1.1 1-1 1.2-1 1.3-.6 1.5-.6 1.4-.3 1.5-.3 1.6v8l.3 1.6.4 1.7.6 1.5.8 1.4 1 1.4 1.1 1.2 1.3 1 1.3.9 1.6.7 1.6.5 1.6.3 1.7.1h1.6l1.6-.4 1.6-.5 1.5-.7 1.3-.9 1.3-1 1.1-1.2 1-1.4.8-1.4.7-1.5.4-1.7.2-1.6zm-20 5.6v.4l.1.8.3.8.3.8.4.8.5.7.6.6.6.5.8.5.7.4.8.2.9.2h1.7l.8-.2.8-.2.8-.4.7-.5.7-.5.6-.6.4-.7.4-.8.4-.8.2-.8v-1.2z\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M390 277a150 150 0 1 0-300 0 150 150 0 0 0 300 0\" style=\"fill:#154889;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M221.6 350.6h-16.2l-2.1-.2-2-.5-2-.7-2-1-1.8-1.1-1.7-1.4-1.4-1.6-1.3-1.7-1-1.8-1-2-.2-1-13.5-43.2-2.8.5-5.7.4-5.7-.2-5.6-1-5.5-1.7-5.2-2.4-5-3-4.4-3.5-4-4-3.4-4.5-3-5-2.2-5.2-1.6-5.5-.9-5.6-.2-5.8.6-5.7 1.2-5.5 1.9-5.4 2.5-5.1 3.2-4.8 3.7-4.3 4.3-3.8 4.6-3.3 5-2.7 5.5-2 5.5-1.3 5.7-.7h5.7l5.6.8 5.6 1.5 5.3 2.1 5 2.8 4.7 3.3 4.1 4 3.6 4.4 3 4.8 2.6 5.2 1.7 5.4 1.1 5.6.5 5.6-.3 5.7-1 5.6-1.7 5.5-2.4 5.2-3 4.9-3.5 4.5-4.2 4-4.5 3.4-5 3-2.6 1.1 3.7 11.8 54.4-60.4.3-.3.8-.7.8-.6.8-.5.8-.3 1-.3 1-.3h20.7l.7-2.8 1.8-5.4 2.5-5 3.1-4.9 3.6-4.4 4.2-3.9 4.6-3.3 5-2.7 5.3-2.1 5.5-1.5 5.7-.8h5.7l5.6.7 5.5 1.3 5.4 2 5 2.7 4.7 3.3 4.3 3.8 3.6 4.3 3.3 4.8 2.5 5 2 5.4 1.1 5.5.6 5.6-.2 5.8-.8 5.6-1.6 5.5-2.3 5.2-2.8 5-3.4 4.5-4 4-4.5 3.6-4.8 3-5.2 2.4-5.4 1.7-5.6 1-5.8.3-5.6-.4-5.6-1-2.7-.8L286 323l3.4 9.2H300v9.2H260l-.2-.2-.3-.1-.2-.2-.2-.1-.2-.3-.1-.2-.2-.3v-.2l-.2-.2v-1l.1-.2v-.2l.4-.5.2-.2.2-.2.3-.1.2-.2h.4l19.5-4.8-3.5-9.2H194l3.7 12 .2.5.4 1 .6.8.6.9.8.7.8.7.9.6 1 .5 1 .4 1 .2 1 .1h15.7zM191 313.8l57.6-64 24 64zm-18.4-28.3-2.3.4-4.4.2-4.6-.3-4.4-.9-4.3-1.4-4.1-2-3.9-2.4-3.5-2.8-3.1-3.3-2.8-3.6-2.2-4-1.7-4.2-1.2-4.4-.6-4.5-.2-4.5.5-4.6 1-4.3 1.6-4.2 2-4 2.5-3.8 3-3.5 3.4-3 3.7-2.6 4-2.1 4.3-1.6 4.4-1 4.5-.6h4.5l4.5.6 4.4 1.2 4.3 1.6 4 2.2 3.6 2.7 3.4 3 2.8 3.5 2.5 3.8 2 4 1.6 4.3.8 4.4.4 4.6-.1 4.5-.7 4.4-1.3 4.4-1.8 4.2-2.3 3.9-2.7 3.6-3.2 3.3-3.6 2.8-3.8 2.4-2.1 1-10.8-35-.1-.3-.2-.5-.4-.5-.3-.5-.5-.4-.4-.3-.5-.3-.5-.2-.6-.1-.5-.1h-1.2l-.6.1-.5.3-.5.2-.5.3-.4.4-.4.5-.3.5-.3.5-.3 1.1v1.8l.2.2zm85.7-36.2h9.2l.1 2.7.6 5.3 1.3 5.2 1.8 5.1 2.5 4.9 3 4.5 3.5 4 4 3.7 4.2 3.2 2.4 1.4-9.6 21.4zm18.5 0h32l-14.2 31.6-1.7-1.1-3.4-2.6-3-3-2.7-3.2-2.3-3.6-1.9-3.7-1.4-4-1-4.1-.4-4.3zm1-9.3.7-2 1.7-4.2 2-4 2.7-3.6 3-3.3 3.4-3 3.7-2.5 4.1-2 4.2-1.5 4.4-1 4.5-.4h4.5l4.4.7 4.3 1.2 4.2 1.7 3.9 2.1 3.6 2.7 3.3 3.1 2.9 3.4 2.4 3.7 2 4.1 1.4 4.2 1 4.3.4 4.5-.2 4.5-.7 4.5-1.2 4.2-1.8 4.2-2.2 4-2.6 3.4-3.2 3.3-3.4 2.8-3.8 2.4-4 2-4.3 1.4-4.4.9-4.5.3-4.5-.2-4.4-.8-2.2-.5 17-38v-.3l.3-.6.1-.5v-1.6l-.2-.5-.3-.5-.2-.5-.3-.4-.8-.8-.5-.2-1-.5h-.5l-.5-.2z\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/>" },
    "274.1-20": { width: 600, height: 600, svg: "<path d=\"M32.4.5a32 32 0 0 0-32 32v415a32 32 0 0 0 32 32h415.2a32 32 0 0 0 32-32v-415a32 32 0 0 0-32-32\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M32.4 480A32.4 32.4 0 0 1 0 447.6V32.4A32.4 32.4 0 0 1 32.4 0h415.2A32.4 32.4 0 0 1 480 32.4v415.2a32.4 32.4 0 0 1-32.4 32.4zm0-.5h415.2a32 32 0 0 0 32-32v-415a32 32 0 0 0-32-32H32.4a32 32 0 0 0-32 32v415a32 32 0 0 0 32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M32.4 471.5a24 24 0 0 1-24-24v-415a24 24 0 0 1 24-24h415.2a24 24 0 0 1 24 24v415a24 24 0 0 1-24 24zm0-12h415.2a12 12 0 0 0 12-12v-415a12 12 0 0 0-12-12H32.4a12 12 0 0 0-12 12v415a12 12 0 0 0 12 12\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M240 437.5a152 152 0 1 1 0-304 152 152 0 0 1 0 304m0-40a112 112 0 1 0 0-224 112 112 0 0 0 0 224\" style=\"fill:#c1121c;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M308.4 42.5v67.2h43.2v-9.6h-33V81h28.2v-9h-28.2V52.1h33v-9.6zm-66 0v67.2h9.6l30.6-48v48h10.2V42.5h-9.6l-30.6 48v-48zm-51 23.4a13.8 13.8 0 1 1 27.6 0v20.4a13.8 13.8 0 0 1-27.6 0zm-10.2 0v20.4a24 24 0 0 0 48 0V66a24 24 0 0 0-48 0m-52.8-23.4V51l30.6 49.8h-29.4v9h42V102L141 52.1h30.6v-9.6M162 220.1v17.5l52 65.4a18.7 18.7 0 1 1-33.3 11.6H162a37.3 37.3 0 1 0 66.5-23.3l-42-52.5h50.2v-18.7M269.3 256.3a18.7 18.7 0 1 1 37.4 0v58.3a18.7 18.7 0 0 1-37.4 0zm-18.6 0v58.3a37.3 37.3 0 0 0 74.6 0v-58.3a37.3 37.3 0 1 0-74.6 0\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/>" },
    "274.1": { width: 600, height: 600, svg: "<defs><clipPath id=\"omc-274.1-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 0h480v480H0z\"/></clipPath></defs><g clip-path=\"url(#omc-274.1-a)\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"><path d=\"M32.4.5a32 32 0 0 0-32 32v415.1a32 32 0 0 0 32 32h415.2a32 32 0 0 0 32-32V32.4a32 32 0 0 0-32-32\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M32.4 480A32.5 32.5 0 0 1 0 447.6V32.4A32.5 32.5 0 0 1 32.4 0h415.2A32.5 32.5 0 0 1 480 32.4v415.2a32.5 32.5 0 0 1-32.4 32.4zm0-.5h415.2a32 32 0 0 0 32-31.9V32.4a32 32 0 0 0-32-32H32.4a32 32 0 0 0-32 32v415.2a32 32 0 0 0 32 32\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M32.4 471.5a24 24 0 0 1-24-23.9V32.4a24 24 0 0 1 24-24h415.2a24 24 0 0 1 24 24v415.2a24 24 0 0 1-24 24zm0-12h415.2a12 12 0 0 0 12-11.9V32.4a12 12 0 0 0-12-12H32.4a12 12 0 0 0-12 12v415.2a12 12 0 0 0 12 12\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M240 437.5a152 152 0 1 1 0-304 152 152 0 0 1 0 304m0-40a112 112 0 1 0 0-224 112 112 0 0 0 0 224\" style=\"fill:#c1121c;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/><path d=\"M154 252.8h18.9a19.8 19.8 0 0 1 39.1 4.7v2.3c0 11-8.9 19.8-19.8 19.8H184V296h8.2a18.7 18.7 0 1 1-18.4 22.1H155a37.3 37.3 0 0 0 74.5-3.5c0-10.6-5.2-20.6-13.9-26.7 9.4-6.3 15-16.8 15-28.1v-2.3a38.5 38.5 0 0 0-76.7-4.7M268 256.3a18.7 18.7 0 1 1 37.3 0v58.3a18.7 18.7 0 0 1-37.3 0zm-18.7 0v58.3a37.3 37.3 0 0 0 74.7 0v-58.3a37.3 37.3 0 1 0-74.7 0M308.4 42.5v67.2h43.2v-9.6h-33V81h28.2v-9h-28.2V52.1h33v-9.6zm-66 0v67.2h9.6l30.6-48v48h10.2V42.5h-9.6l-30.6 48v-48zm-51 23.4a13.8 13.8 0 1 1 27.6 0v20.4a13.8 13.8 0 0 1-27.6 0zm-10.2 0v20.4a24 24 0 0 0 48 0V66a24 24 0 0 0-48 0m-52.8-23.4V51l30.6 49.8h-29.4v9h42V102L141 52.1h30.6v-9.6\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 600)\"/>" },
    "282": { width: 601, height: 601, svg: "<path d=\"M480.4 240.4a240 240 0 1 0-480 0 240 240 0 0 0 480 0\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M240.4 480.8a240.4 240.4 0 1 1 0-480.8 240.4 240.4 0 0 1 0 480.8m0-.4a240 240 0 1 0 0-480 240 240 0 0 0 0 480\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/><path d=\"M240.4 472.3a232 232 0 0 1 0-463.8 232 232 0 0 1 0 463.8m0-12a219 219 0 0 0 124.7-38.7L59 115.7a219.9 219.9 0 0 0 181.2 344.6m132-43.9 7-5.5L70 101.3l-5.5 7.2zm13.8-11.3 6.6-6L81.8 88l-6.1 6.6zm12.8-12.3 6.1-6.6L94.6 75.7l-6.6 6zm11.9-13.3 5.5-7.2-308-308-7 5.6zm10.7-14.4a219.9 219.9 0 0 0-306-306z\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 0 601)\"/>" },
    "325.1": { width: 732.1, height: 488.9, svg: "<defs><clipPath id=\"omc-325.1-a\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 391h586V0H0z\"/></clipPath><clipPath id=\"omc-325.1-b\" clipPathUnits=\"userSpaceOnUse\"><path d=\"M0 1h586v391H0z\"/></clipPath></defs><g clip-path=\"url(#omc-325.1-a)\" transform=\"matrix(1.25 0 0 -1.25 0 488.9)\"><g clip-path=\"url(#omc-325.1-b)\" transform=\"translate(0 -.9)\"><path d=\"M26.4 1.5a26 26 0 0 0-26 26v338a26 26 0 0 0 26 26h532.9a26 26 0 0 0 26-26v-338a26 26 0 0 0-26-26\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M26.4 391.8A26.4 26.4 0 0 1 0 365.4V27.5A26.4 26.4 0 0 1 26.4 1.1h532.9a26.4 26.4 0 0 1 26.4 26.4v338a26.4 26.4 0 0 1-26.4 26.3zm0-.4h532.9a26 26 0 0 0 26-26V27.5a26 26 0 0 0-26-26h-533a26 26 0 0 0-26 26v338a26 26 0 0 0 26 26\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g><path d=\"M26.4 10.4c-9 0-16.3 7.3-16.3 16.2v338c0 9 7.3 16.2 16.3 16.2h532.9c9 0 16.2-7.3 16.2-16.2v-338c0-9-7.2-16.2-16.2-16.2\" style=\"fill:#154889;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M126.1 155.6V35.7a21 21 0 0 0-20.8 20.9v73L53.2 46.1a21 21 0 0 0-6.7 28.7l38 60.6v20.1M126.1 160.8H84.4v39.3l-27.8-44.5a18 18 0 0 0-5.8 25.1l36.8 59a20.8 20.8 0 0 0 38.5-11.1V205l39.1-23.4a18 18 0 0 0-25-6.3l-14 8.5M139.2 278a20.8 20.8 0 1 0-41.7 0 20.8 20.8 0 0 0 41.7 0M248.5 50.8a15.1 15.1 0 1 0-30.2 0 15.1 15.1 0 0 0 30.2 0M321 114.3l-19-15.7a10.6 10.6 0 0 0-14.2.6l33.6 33.6c7-3 15-2.2 21.3 2l22.3-5a3 3 0 0 0 2-1.6l11.5-23a10.6 10.6 0 0 0-14.2 4.8l-5.4 10.4h-10.6l9-36.3 20.5-1.5c5.6-.4 9.8-5 9.8-10.6H353q-1.6 0-2.5 1.4l-5.1 7.7-10.6-3V46.3c0-5.7-4.5-10.3-10.1-10.6M345.3 153.7a15.1 15.1 0 1 0-30.3 0 15.1 15.1 0 0 0 30.3 0M227 339.9c-2.9 0-5.5-1.7-6.7-4.4l-11.5-26.6q-1.3-2.9-3.1-5.3l-1.8-2.3a9 9 0 0 1-1.7-5.3v-19c0-4 3.2-7.3 7.3-7.3h108.2c4 0 7.3 3.3 7.3 7.3v19q0 3-1.8 5.3l-1.7 2.3a26 26 0 0 0-3 5.3l-11.7 26.6a7 7 0 0 1-6.7 4.4zm1.8-7.3h69.6a3 3 0 0 0 2.7-1.8l10-23h-95l10 23a3 3 0 0 0 2.7 1.8m-10.5-32.2a8.8 8.8 0 1 0 0-17.6 8.8 8.8 0 0 0 0 17.6m90.6 0a8.8 8.8 0 1 0 0-17.6 8.8 8.8 0 0 0 0 17.6M209.5 266.8H227v-16.1c0-2.5-2-4.4-4.4-4.4H214c-2.5 0-4.4 2-4.4 4.4M300.1 266.8h17.6v-16.1c0-2.5-2-4.4-4.4-4.4h-8.8c-2.4 0-4.4 2-4.4 4.4M474.2 352.2 458.4 342v7.2h-15.7v-17.5l-50.4-33h28.3V188.5h107v110.3H556zm0-9.4 44-36.2V197.9h-31.5v47.2h-25.1V198H430v108.7z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M442.6 298.7H468v-31.5h-25.3zM480.4 298.7h25.2v-31.5h-25.2zM526.8 59.1l-108 78.2a135 135 0 0 0-55.8 109h13.2c0-39 18.7-75.5 50.2-98.4l100.4-73\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/></g>" },
    "AT-11a": { width: 900, height: 1200, svg: "<path fill=\"#231F20\" fill-rule=\"evenodd\" d=\"M6.2 1138.4A56.7 56.7 0 0 0 63 1195h774.5a56.7 56.7 0 0 0 56.6-56.6V61.6a56.7 56.7 0 0 0-56.6-56.7H62.9A56.7 56.7 0 0 0 6.2 61.6z\" clip-rule=\"evenodd\"/><path fill=\"#FFF\" fill-rule=\"evenodd\" d=\"M15.7 1138.4a47 47 0 0 0 47.2 47.2h774.5a47 47 0 0 0 47.2-47.2V61.6a47 47 0 0 0-47.2-47.2H62.9a47 47 0 0 0-47.2 47.2z\" clip-rule=\"evenodd\"/><path fill=\"#EB2227\" fill-rule=\"evenodd\" d=\"M450.2 75a349.5 349.5 0 1 0 0 698.9 349.5 349.5 0 0 0 0-699\" clip-rule=\"evenodd\"/><path fill=\"#FFF\" fill-rule=\"evenodd\" d=\"M450.2 169.4a255 255 0 1 1 0 510 255 255 0 0 1 0-510\" clip-rule=\"evenodd\"/><path fill=\"#231F20\" fill-rule=\"evenodd\" d=\"M615.4 425a476 476 0 0 0-4.1-69.7q-4.3-28.8-13-46.8a61 61 0 0 0-23.3-26.3 68 68 0 0 0-34.3-8c-13.8 0-25 2.6-34.6 8a57 57 0 0 0-23 26.3 152 152 0 0 0-13.3 46.8 479 479 0 0 0-4.2 69.6 470 470 0 0 0 4.2 69.3c2.9 19.3 7 34.7 13.3 46.8a56 56 0 0 0 23 25.8 69 69 0 0 0 34.6 8q20 0 34.3-8a59 59 0 0 0 23.3-25.8q8.7-18 13-46.8 4.2-28.4 4.1-69.3m-43 0a753 753 0 0 1-1.6 59.3 179 179 0 0 1-5.5 35.5c-2.5 8.8-5.8 14.2-9.6 17.1q-6.1 4.6-15 4.6t-14.6-5.4q-6.3-5.1-10-18.4t-5.4-35.9A706 706 0 0 1 509 425q-.1-34.9 1.7-58 1.8-22.6 5.4-35.9a38 38 0 0 1 10-18.3q5.8-5 14.6-5 8.3 0 14.6 4.6 5.8 4.3 9.6 17.5 4 13 5.9 35.4c1.2 15.5 1.6 35.1 1.6 59.7m-141 58q0-19.1-4.6-32a65 65 0 0 0-12.5-21.4 54 54 0 0 0-16.7-12.9q-9.2-4.4-18-6.3a61 61 0 0 0 16.8-7.9 62 62 0 0 0 28.8-54.2q-.1-22-5.9-36.4a62 62 0 0 0-15.9-22.5 58 58 0 0 0-22.5-11.7q-12.4-3.2-25.4-3.3a89 89 0 0 0-35 6.6 124 124 0 0 0-31 18.4l18 28a87 87 0 0 1 23.7-13.4 63 63 0 0 1 20.5-3.8q4.5.1 10 .9 5.6.6 10.5 4.6 4.5 4.2 7.9 12 3.2 8.2 3.3 22.6 0 24-9.6 34.7a33 33 0 0 1-25.4 10.8H337v33.8h13.4q7.6 0 14.6 1.7a27 27 0 0 1 12 7.5 42 42 0 0 1 8.4 16.3q3 10.5 3 28c0 10.4-1.3 18.7-3.4 25.9q-3.8 10.5-9.6 16.6a31 31 0 0 1-14.2 9.2 45 45 0 0 1-16.3 3q-12.6 0-23.3-4.2-10.8-4.5-18.4-10L285 553q9.5 7.5 26 13.7a96 96 0 0 0 38.3 6.7q16.8 0 31.7-5.4a75 75 0 0 0 43.8-45q6.8-17 6.7-40.1M676.6 1031h93.6v-21.6q0-22-3-39.6a87 87 0 0 0-10.6-29.4 49 49 0 0 0-19.6-17.8q-12.1-6-29.8-6-35 0-51.3 24.9-16.4 25.4-16.2 80.7 0 30.6 6.4 49.8a76 76 0 0 0 16.2 29.8q10.3 10.7 23.4 14.7a101 101 0 0 0 57.3-.7q14.4-4.4 23-9.4l-10.9-27.6a89 89 0 0 1-40 10.6 59 59 0 0 1-14.7-1.5q-6.7-1-11.7-7.2a39 39 0 0 1-8.3-17.4 140 140 0 0 1-3.8-32.4m29.9-84.5q8 0 13.2 2.6 5.2 3 8.7 9a56 56 0 0 1 5.2 17.8 289 289 0 0 1 1.9 29H677a158 158 0 0 1 3.4-30.9 51 51 0 0 1 6-17.7q4-6.2 9.1-8c3.4-1 6.8-1.8 11-1.8M562 1116.5h37v-138q.1-32.9-13-47.6-12.8-14.2-37.6-14.3-13.7 0-25.7 6-11.9 6.4-20.3 20l-6-22.2h-25.7v196.1h37V987.2q0-11.4 3-19.3 2.8-7.8 7.9-12.8 5-4.5 10.5-6.8 5.7-1.8 11.4-2 9.5 0 15.8 6.9 5.7 7.4 5.7 27.1zm-201.5 3.8q15.5.1 28-4.9t21.5-17a92 92 0 0 0 13.5-31.3q4.6-19.2 4.6-48.6t-4.6-49.1a96 96 0 0 0-13.5-31.3c-6-8-13.2-13.2-21.5-16.6a74 74 0 0 0-28-5 74 74 0 0 0-27.9 5 47 47 0 0 0-21 16.6q-9.1 12-13.7 31.3a200 200 0 0 0-4.8 49q-.2 27.9 4.8 47.2 4.6 19.8 13.6 31.7 8.6 12.1 21.1 17.4a68 68 0 0 0 28 5.6m0-173.1a30 30 0 0 1 13.6 3q5.6 2.8 9.5 11a68 68 0 0 1 5.6 21.4c1.2 9.5 1.5 21.2 1.5 35.9q.1 19.9-1.5 33.5a74 74 0 0 1-5.6 22 27 27 0 0 1-9.5 12 23 23 0 0 1-13.6 3.7q-7.8.2-13.5-3.7a27 27 0 0 1-9.4-12 74 74 0 0 1-5.3-22q-1.9-13.7-2-33.5c0-14.7.8-26.4 2-35.9q1.4-13.5 5.3-21.5 3.8-8 9.4-11 5.7-2.9 13.5-3m-189.3 135.4 92.4-194v-36.1H136.8v34h86.8l-93.5 193.8v36.2h130.5v-33.9z\" clip-rule=\"evenodd\"/>" },
    "BE-F4a": { width: 68.1, height: 102, svg: "<path d=\"M67.6 5.6v91a5 5 0 0 1-5 4.9h-57a5 5 0 0 1-5.1-5v-91a5 5 0 0 1 5-5h57a5 5 0 0 1 5.1 5.1z\" style=\"fill:#fff;stroke:#000;stroke-width:.98790419;stroke-opacity:1\"/><path fill=\"none\" d=\"M68.1 5.2V97a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5c0-2.7 2.3-5 5.1-5h58c2.7 0 5 2.4 5 5.2\"/><path d=\"M36.6 23.9h2v-6.5l3.4 6.5h2.6V13.3h-2.1v6.5l-3.4-6.5h-2.5z\"/><path fill=\"none\" d=\"M36.6 23.9h2v-6.5l3.4 6.5h2.6V13.3h-2.1v6.5l-3.4-6.5h-2.5z\"/><path d=\"M48.5 23.9h7.3v-2h-5v-2.6h3.3v-1.8h-3.3v-2.3h4.8v-1.8h-7.1z\"/><path fill=\"none\" d=\"M48.5 23.9h7.3v-2h-5v-2.6h3.3v-1.8h-3.3v-2.3h4.8v-1.8h-7.1z\"/><path d=\"m17.1 15.2-4.7 7.1v1.6h7.5v-1.7l-4.8-.1 4.9-6.7-.1-1.9h-7.3v1.8z\"/><path fill=\"none\" d=\"m17.1 15.2-4.7 7.1v1.6h7.5v-1.7l-4.8-.1 4.9-6.7-.1-1.9h-7.3v1.8z\"/><path d=\"M28.2 12.9c-3.3 0-4.7 2.6-4.7 5.6s1.4 5.7 4.7 5.7c3.2 0 4.6-2.6 4.6-5.7S31.4 13 28.2 13\"/><path fill=\"none\" d=\"M28.2 12.9c-3.3 0-4.7 2.6-4.7 5.6s1.4 5.7 4.7 5.7c3.2 0 4.6-2.6 4.6-5.7S31.4 13 28.2 13\"/><path fill=\"#ED1C24\" fill-rule=\"evenodd\" d=\"M34 88.1a25.5 25.5 0 1 1 0-51 25.5 25.5 0 0 1 0 51\" clip-rule=\"evenodd\"/><path fill=\"none\" d=\"M34 88.1a25.5 25.5 0 1 1 0-51 25.5 25.5 0 0 1 0 51\"/><path fill=\"#FFF\" fill-rule=\"evenodd\" d=\"M34 80.8a18.2 18.2 0 1 1 16-27.3c7 12.1-1.8 27.3-15.8 27.3\" clip-rule=\"evenodd\"/><path fill=\"none\" d=\"M34 80.8a18.2 18.2 0 1 1 16-27.3c7 12.1-1.8 27.3-15.8 27.3\"/><path fill=\"#FFF\" d=\"M28.2 15.2c1.7 0 2.2 2 2.2 3.3 0 1.4-.5 3.4-2.2 3.4s-2.2-2-2.2-3.4.4-3.3 2.2-3.3\"/><path fill=\"none\" d=\"M28.2 15.2c1.7 0 2.2 2 2.2 3.3 0 1.4-.5 3.4-2.2 3.4s-2.2-2-2.2-3.4.4-3.3 2.2-3.3\"/><path fill=\"#120C0E\" d=\"M33 59.4c0-.8-1-2.3-1.6-2.6q1.1-1.1 1.2-2.9v-.7c0-1.7-1.6-3.5-4-3.4h-1.5c-2 .3-3.4 1.9-3.3 4h2.4a2 2 0 0 1 2-1.7q1.7.1 1.8 1.9c0 1-.7 2-1.8 2h-1v2.1H29q1.3 0 1.4 1.5v.8c-.2 1-1.2 1.6-2.2 1.6q-2-.1-2.3-1.9h-2.4c0 2.3 1.8 4 3.7 4H29c2.4 0 4-1.6 4-3.7z\"/><path fill=\"none\" d=\"M33 59.4c0-.8-1-2.3-1.6-2.6q1.1-1.1 1.2-2.9v-.7c0-1.7-1.6-3.5-4-3.4h-1.5c-2 .3-3.4 1.9-3.3 4h2.4a2 2 0 0 1 2-1.7q1.7.1 1.8 1.9c0 1-.7 2-1.8 2h-1v2.1H29q1.3 0 1.4 1.5v.8c-.2 1-1.2 1.6-2.2 1.6q-2-.1-2.3-1.9h-2.4c0 2.3 1.8 4 3.7 4H29c2.4 0 4-1.6 4-3.7z\"/><path fill=\"#120C0E\" d=\"M35.3 59.4v-5a4.7 4.7 0 1 1 9.3 0v4.9a4.7 4.7 0 0 1-9.3 0\"/><path fill=\"none\" d=\"M35.3 59.4v-5a4.7 4.7 0 1 1 9.3 0v4.9a4.7 4.7 0 0 1-9.3 0\"/><path fill=\"#120C0E\" d=\"M27.2 66.3h1.4v4.5l1.9-2h2l-2.7 3.1 2.8 3.4h-2.1l-1.7-2.2v2.2h-1.5z\"/><path fill=\"none\" d=\"M27.2 66.3h1.4v4.5l1.9-2h2l-2.7 3.1 2.8 3.4h-2.1l-1.7-2.2v2.2h-1.5z\"/><path fill=\"#120C0E\" fill-rule=\"evenodd\" d=\"M34.4 69v6.3h1.7v-3.6c0-1.5 1-1.7 1.4-1.4q.5.2.5 1.1v4h1.6v-3.7c0-1.5 1-1.7 1.4-1.4q.5.2.5 1.1v4h1.6v-4.5c0-2.3-2.6-2.7-3.7-1.2a2 2 0 0 0-3.4.1V69z\" clip-rule=\"evenodd\"/><path fill=\"none\" stroke=\"#120C0E\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"M34.4 69v6.3h1.7v-3.6c0-1.5 1-1.7 1.4-1.4q.5.2.5 1.1v4h1.6v-3.7c0-1.5 1-1.7 1.4-1.4q.5.2.5 1.1v4h1.6v-4.5c0-2.3-2.6-2.7-3.7-1.2a2 2 0 0 0-3.4.1V69z\"/><path fill=\"#FFF\" d=\"M42.2 59.5q-.2 2-2.2 2.2-2-.2-2.2-2.2v-5.3q.2-2 2.2-2.2c2-.2 2.2 1 2.2 2.2z\"/><path fill=\"none\" stroke=\"#FFF\" stroke-miterlimit=\"3.9\" stroke-width=\".2\" d=\"M42.2 59.5q-.2 2-2.2 2.2-2-.2-2.2-2.2v-5.3q.2-2 2.2-2.2c2-.2 2.2 1 2.2 2.2z\"/>" },
    "CH-2.59.1": { width: 94.9, height: 132.7, svg: "<path d=\"M1.4 1.4h708.7v992.1H1.4z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M1.4 1.4h708.7v992.1H1.4V1.5\" style=\"fill:none;stroke:#231f20;stroke-width:2.83500004;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M15.6 44v907q0 11.7 8.3 20a27 27 0 0 0 20 8.4h623.7q11.7 0 20-8.3a27 27 0 0 0 8.3-20V43.8q0-11.7-8.3-20a27 27 0 0 0-20-8.3H43.9q-11.7 0-20 8.3a27 27 0 0 0-8.3 20\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M29.8 44v907q0 6 4.1 10 4.2 4.2 10 4.2h623.7q5.8 0 10-4.2 4-4 4.1-10V44q0-6-4.1-10a14 14 0 0 0-10-4.2H43.9q-5.8 0-10 4.1a14 14 0 0 0-4.1 10\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M206 816.4h58.6V829h-41.3l40.6 73.6v13h-56.6v-12.7H246l-40-72.6zm78.4 11.6q5-6.3 12.1-9.5a38 38 0 0 1 30.1-.1q7 3 12 9.5 5.2 6.2 8.2 16 2.8 9.6 2.8 22.6a76 76 0 0 1-2.8 22q-3 9.3-8.1 15.7a35 35 0 0 1-12 9.5 36 36 0 0 1-14.9 3.2q-8.2 0-15.2-3.2a34 34 0 0 1-12.2-9.4 45 45 0 0 1-8-16q-3-9.7-3-22.7 0-12.6 3-22a44 44 0 0 1 8-15.6m81.3-11.6H380v79.3h.2l35.1-79.3H434v99.2h-14.3v-80h-.3l-35 80h-18.7zm89 0h50.7V829H470v32.3h32v12.6h-32v29h33.8v12.7h-49.1z\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M295 837.6a57 57 0 0 0-5.6 28q0 10.8 1.8 18.3 1.7 7.5 4.9 12.2 3 4.5 7 6.7 4.3 2 8.7 2 10.6 0 16.4-10.3a59 59 0 0 0 5.5-28q0-10.8-1.7-18.3-1.9-7.6-4.8-12a19 19 0 0 0-16-8.9q-10.5 0-16.1 10.3\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M355.8 781a283.5 283.5 0 1 1 0-567 283.5 283.5 0 0 1 0 567\" style=\"fill:#ee2c30;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M355.8 686.5a189 189 0 1 1 0-378 189 189 0 0 1 0 378\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"m275.4 557.8-19.8 18.9 1.7 3.5a37 37 0 0 0 18 14.9 49 49 0 0 0 44.2-3.2 45 45 0 0 0 21.4-39.1 47 47 0 0 0-11.6-30.4q-2.8-3-6-5.4a84 84 0 0 0-7.9-4.8 35 35 0 0 0 13.8-8.9q3.5-3.6 6.4-8a56 56 0 0 0 11.1-34.3 59 59 0 0 0-13.7-37.4 57 57 0 0 0-42.7-20.3q-10.4-.4-20.1 2.8c-7 2.3-15.2 7-21.5 10.9l-2.3 1.5 13 24.2 11-7q3.4-2.2 7-3.7 2.8-1.2 5.7-1.6 5.2-.7 10.5.5 9.6 2.1 16.5 9.1a30 30 0 0 1 8.8 18c.6 6.2-1.3 12.6-4.4 18.1a38 38 0 0 1-14.8 14.7 72 72 0 0 1-19.5 6.5l-2.4.5v29.1l2.8.2q5.3.5 10.5 1.7c4 1 8.5 2.4 11.8 4.9a24 24 0 0 1 7.3 8.6 24 24 0 0 1 2.9 12.6c-.3 4.6-2.1 9.2-5.6 12.3a19 19 0 0 1-9.2 4c-4.5.6-9.1.2-13-1.9-3.4-1.8-6.1-5-8.1-8.3zm138.4 40.9q6.3-.1 12.2-2a43 43 0 0 0 21.2-15.7 73 73 0 0 0 10.5-21q3.5-10.6 5.1-21.8 1.7-11.5 2-23.1.5-13.2-.4-26.6a225 225 0 0 0-3-24.6 149 149 0 0 0-7.7-27.7 61 61 0 0 0-14-22.3 40 40 0 0 0-25.6-10.5 38 38 0 0 0-25 8c-7.6 6-13 16-16.3 25.2q-4.7 13.3-6.9 27.1a300 300 0 0 0-3.3 49.7 197 197 0 0 0 8 46.3c2.2 7.3 5.6 15 10.2 21.2a43 43 0 0 0 33 17.8\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/><path d=\"M414 570.6q3.4 0 6.3-1.5 2.8-1.6 4.5-4.5c2-2.9 3.2-7 4-10.4a172 172 0 0 0 5.6-35.7 259 259 0 0 0-.3-40.1q-1-10.8-3.2-21.5-1.5-7.3-4.4-14.3-1.5-3.6-3.7-7-1.5-2.1-3.7-3.6a11 11 0 0 0-5.3-1.8 10 10 0 0 0-6.4 1.7q-2 1.6-3.4 3.8a42 42 0 0 0-3.6 6.9 73 73 0 0 0-4 14.4 287 287 0 0 0-3.6 43 188 188 0 0 0 3.5 37.1q1.5 8.5 3.7 16.8c1 3.6 2.4 7.8 4.5 10.8q1.7 2.7 4.5 4.4 2.4 1.3 5 1.5\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 132.7)\"/>" },
    "CH-2.59.5": { width: 132.7, height: 94.9, svg: "<path d=\"M1.4 1.4h992.1v708.7H1.5Z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M1.4 1.4h992.1v708.7H1.5Z\" style=\"fill:none;stroke:#231f20;stroke-width:2.83500004;stroke-linecap:butt;stroke-linejoin:round;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M44 696a28.4 28.4 0 0 1-28.4-28.4V44A28.3 28.3 0 0 1 44 15.6h907A28.4 28.4 0 0 1 979.4 44v623.6A28.4 28.4 0 0 1 951 696z\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M44 681.8c-7.9 0-14.2-6.4-14.2-14.2V44c0-7.9 6.3-14.2 14.1-14.2h907.2c7.8 0 14.1 6.3 14.1 14.2v623.6c0 7.8-6.3 14.2-14.1 14.2z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M821.8 108.1V72.3H173.2v425h648.6v-258a94.5 94.5 0 1 1 0-131.2\" style=\"fill:#1a67bb;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M594 374.9a8.7 8.7 0 1 0 0-17.4 8.7 8.7 0 0 0 0 17.4M419.1 253.4c24.6 0 49.3 1.8 54.7 5 0-9.4-2.8-27 13-21.7 7.4 2.5 4.4 18.2 4.4 21.8 10.4 5.2 7.6 11.7 7.8 23.3.5 19.9-3.7 39.7-14 44.3l.4.2c5.4.9 11.1.8 16 .4 1.1 0 2.1.6 2.2 2.4l-.5 7.5q-.2 2.1-2.3 1.9l-8.3.3c-3 .2-5 .4-6.7-1.7l-4-7.4c-3.3 13.3-5.2 24.5-10 37.7-3 8.8-30 10.3-52.7 10-22.6.3-49.6-1.2-52.7-10-4.8-13.2-6.7-24.4-10-37.7l-4 7.4c-1.8 2-3.8 2-6.6 1.7l-8.4-.3c-1.2 0-2.2-.4-2.2-2l-.6-7.4q.3-2.6 2.3-2.4c4.8.4 10.5.5 16-.4l.3-.2c-10.3-4.6-14.5-24.4-14-44.3.3-11.6-2.5-18.1 7.8-23.3 0-3.6-3-19.3 4.5-21.8 15.7-5.2 12.9 12.3 12.9 21.6 5.4-3.1 30.2-5 54.7-5M274 331.7a23.2 23.2 0 1 0-.1-46.5 23.2 23.2 0 0 0 0 46.5M551.5 425a9.7 9.7 0 1 0 0-19.5 9.7 9.7 0 0 0 0 19.4m-32.2-212.8c9.3 0 16.8-7.5 16.8-16.8a16.9 16.9 0 0 0-33.6 0c0 9.3 7.6 16.8 16.8 16.8m-279.7 21.2c-4.7-8.8-7.9-16-13.2-24.6-3-7-5.3-14.6-8.5-20.7-2.2-4.4-6.4-8.5-11.5-7.5-3.2 1.2-2.6 3.1-3.5 5 1.9 33.8 23 64.2 33.6 82.3 5.4 3.2 19 14.8 24 14.7 7-.2 13.6-1.7 20.6-1.8l11.3-13.8 10.5-25.7c.9-2.6 3.9-6.5 6.1-7.8 6-7.9 22-14 29.3-23.2 5.1-6.4-4.4-12.8-9.7-9.7-15 5.5-31.1 12.8-44 23.7l-2.8 2.6c-4.8-19.2 12.6-43.7 19.9-58.4l29.2-59c4-.4 8.4-1.4 12.5-1.4 3.3-.5.6-3-.7-4-3.8-2.7-7.3-6-11.6-8.1l-16.8-8.5c-10.8 17.6-12.4 25-18.6 37.6L265 190.2h-4.1L231 111l-4.2-13.3 7.7-7.5c1-1 2.3-3.3-.5-3.4l-5 .3c-6.4-.3-9.3 1.3-13.9 2.2-4.3 1.7-9.8.9-14 3-3 1.2.8 7 2 10.3.9 2.8 2.6 5.3 3.5 8.1l29.7 90.5c3.3 9.9 3.3 21.9 3.3 32.2\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M546 163.2c0-9.6-.6-19.5 2.4-28.6l2.5-3.3c1.3-1.8 3.5-2.2 6-2.4 9.7.3 16.6 7 26 10 1 .5 1.2.9 3.2 1.3 3.6-5.7 4-8.7 6.7-14.4q-.2-2.3-1.4-4.4c-.3-.6-1.7-.5-2.3 0l-4.3 4q-.8.8-1.7.3c-7.8-5.8-15.6-12-23.7-17.3-10.5 3.5-20.8 10.9-30 17a271 271 0 0 1-55-33.8l-4.5-2.5-7.4 7.8c-1.5 1.6-3.7 4.5-2.6 6.5-.2 1.5.8 3 3.2 2l7-2.9a609 609 0 0 0 44.1 34.8c0 2.4-.3 3.5-.7 5.5-1.7 3.5-2.7 14.8-3 16.7-6.8 0-13.5-3.4-20.2-3.4-9.3-.5-16.4-6.2-24.8-6.5a60 60 0 0 0-7.3-1c-3.9-.2-5.4 3.2-2.6 5.5 2.4 2 4.8 4 7.7 5 7.7 2.5 15.2 5.6 23 8 17 5.5 45.5 10.5 56 8.4 5 0 9-.4 15.2 1.6l14.9 17.7 3.6 3.2c8 5 11.9-4.3 9.4-5.8l-16-21.2-4.3-4.6c-2.7-2.7-6.4-4-10.2-4-3 0-5.8 0-8.8.8m4.3 175.8v-25.8c-1.3-4.2-6-3.5-7.5-.4-.9 5.8-.1 19.4-.1 26zm9.8-.1L560 306c-.1-2.8-5.7-4.4-7.4.2l-.1 32.7z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"m604.1 341 10.2-12.2c1.3 1 1.5 2.6 2.2 4q.6 2.5-.6 4.2c-5.7 5.8-10.4 12.4-15.6 18.6-10-4.9-16 3-22.2 10.2.2.2 1.6 1.9.8 3.7-4.8 11-13.9 41-35.7 29.7-10.2-6.4-8.8-19-8.8-29.2 0-1.1.7-1.4 2.1-2.8a45 45 0 0 1-8.5-27l47-.1c0 13.6-5.7 27.1-16.4 35.6v13.1c.8 1.5 1.7.8 2.3.2 5-6.8 8-16.1 11.5-23.3.2-1.5-.6-2 1.5-4.8 3.1-6.2 8.9-10.1 13.2-15.9-1.1-13.3-3.4-26.6-3.4-40 0-4 5.5-4.7 6.5-.8l1.6 19.8h4c.5-6 1.6-12.1 1.6-18.2.7-3.2 5.6-3.9 6.5 0v.8c0 5.8-1.2 11.5-1.7 17.3h4.5zm152.6 75v-93.4l-127.6-.2V416c-1.7-1.4-3.9-3.4-6.3-3.4-5.1-.8-9.4 3.4-6.5 9 .2.7 1.1 1.5 1.7 2l74.8 56 75-55.9a7 7 0 0 0 2.4-3.5c1.7-8-7.2-9.2-10.6-6.2-1 .2-2.2 1.4-3 2.1\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M419.1 266.2q-35.2 0-70.6 3.2a4 4 0 0 0-3.3 3.7v2.2a3 3 0 0 0 3.3 3q35.3-3.2 70.6-3.1 35.4 0 70.7 3.1a3 3 0 0 0 3.3-3V273c0-2-1.5-3.5-3.3-3.7a769 769 0 0 0-70.7-3.2m0 18.9h-36.6c-2.8 0-4.8 2.2-3.8 4.1l9.4 19.2c.5 1.2 2.1 2 3.8 2h54.4q2.8-.1 4-2l9.3-19.2c1-2-1-4-3.9-4zm58.9 29.8a11 11 0 1 0 0-22 11 11 0 0 0 0 22m-117.8 0a11 11 0 0 1 0-22 11 11 0 0 1 0 22m59.2 15.7c20.5 0 38.4-1.4 55.1-2.7-1.6 6.7-5.8 28.9-8.3 34.2-1.4 3.7-2.3 7-9.4 7.7-5.3 2.6-21 3.5-37.4 3.3-16.4.2-32.6-.7-38-3.3-7-.8-8-4-9.3-7.7-2.6-5.3-6.7-27.5-8.4-34.2 16.8 1.3 35.1 2.6 55.7 2.7m327.9 4.5H708v35.5h-30V335h-39v87.2l53.5 38.9 54.8-41.8zm-205.6 38.3v15.1c.2 1.7 2.7 1.8 2.7 0v-12.8c-1.2-1-1.3 0-2.7-2.3\" style=\"fill:#1a67bb;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M715.1 140.8H749V128h-50c0 31.1 19 41.5 34.6 66.4 9 14.2-20.4 28.2-20.4 1h-14c-3 44.6 62.6 32.3 48.2-5.2-6.6-17-30-30.4-32.4-49.5\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M783 224.5c41.4 0 30-120-10.7-95-21.5 13.2-22.5 95 10.7 95\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M821.8 298.3v-58.8a94.5 94.5 0 1 1 0-131.2V72.4h-167a141.7 141.7 0 0 0 166.9 226\" style=\"fill:#ee2c30;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M678.1 384.8H708v30h-30Zm105.2-174.4c16.7 0 11.6-85.6-4.3-68.7-8.2 8.6-10 68.7 4.3 68.7\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M348 547v13.8l39.7 72.7h-38.5V646h56.6v-13L365 559.7h41.4V547zm78.3 11.6q5-6.4 12-9.6a38 38 0 0 1 30.1-.1q7 3.2 12.2 9.5 5 6.3 8 16 3 9.5 2.9 22.7 0 12.5-2.8 21.9-3 9.3-8.1 15.8a35 35 0 0 1-12 9.5 36 36 0 0 1-14.9 3.1q-8.3 0-15.2-3.1a34 34 0 0 1-12.2-9.4 45 45 0 0 1-8-16q-3-9.8-3-22.8 0-12.6 3-21.9a44 44 0 0 1 8-15.6m81.3-11.6h14.2v79.2h.3l35-79.3h18.7v99.2h-14.2v-79.9h-.3l-35.1 79.9h-18.6zm88.9 0h50.7v12.6h-35.4v32.2H644v12.7h-32.2v29h33.9V646h-49.2z\" style=\"fill:#231f20;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/><path d=\"M437 568.1q5.4-10.2 16.1-10.2 4.6 0 8.7 2.1 4 2 7.2 6.7 3 4.5 4.9 12 1.7 7.5 1.7 18.4 0 17.8-5.6 28-5.7 10.2-16.3 10.2-4.6 0-8.7-2a20 20 0 0 1-7-6.7 35 35 0 0 1-5-12.2 76 76 0 0 1-1.8-18.3q0-17.7 5.7-28\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(.13333 0 0 -.13333 0 94.9)\"/>" },
    "FR-B52": { width: 575.1, height: 575.1, svg: "<g transform=\"translate(.3 .5)\"><rect width=\"573\" height=\"573\" x=\".7\" y=\".5\" rx=\"41\" ry=\"41\" style=\"display:inline;fill:#fff;fill-opacity:1;stroke:#000;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><rect width=\"518.1\" height=\"518.1\" x=\"28.2\" y=\"28\" rx=\"13.5\" ry=\"13.5\" style=\"fill:#0056a4;fill-opacity:1;stroke:none;stroke-width:1.99651;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path fill=\"#fefefe\" fill-rule=\"evenodd\" d=\"M223.5 136.2v20.1c0 1.5-1.4 4-2.8 4H211c-1.4 0-3.1-2.1-3-3.5v-20.6c-3.2 0-6.3-3-6.4-6v-22.3c0-3 4-6.2 7.2-6.2l5.3-22.5c1.2-5.4 5.8-10.1 10.4-10.2h60.9c5.6 0 9.1 4.7 10.6 10.2l5.4 22.5c3.1 0 7 3.2 7 6.2V130c0 3-3.1 6-6.2 6.1v20.6c0 1.3-1.7 3.4-3.1 3.4h-9.5c-1.5 0-3.3-2.4-3.3-3.8l.1-20.2zm-4.2-34.4c-1.3 0-2.2-2.2-1.9-3.6l4.5-18.5c.3-1.4 2.2-3.1 3.4-3.1h59.8c1.2 0 3 1.8 3.3 3.1l4.3 18.4c.3 1.5-.5 3.6-1.8 3.6zm-3.6 11.2a6 6 0 0 1 6 6 6 6 0 0 1-12 0 6 6 0 0 1 6-6m78.4 0a6 6 0 1 1-6 6 6 6 0 0 1 6-6m0 0\" style=\"stroke-width:1.47684\"/><path fill=\"#fff\" fill-rule=\"evenodd\" d=\"m69.5 498.2 28.2 13c12.2 6 21.1-13.2 7.6-19.7l49.3-99.6c2.1-4.2 8.2-2.8 10.2 1.3l55.1 117.3 26.8-11.6c12.5-5.6 4.8-25.3-8.6-19.5l-57.4-121.2 6.2-41.8c.2-1.4 2.9-1.7 3.4.8l10.8 22.2a6 6 0 0 0 3.4 3.3l45.7 22.6c14.3 7.2 21.7-12 8.7-18.8l-41.8-21-18.2-38.4c-4.6-10.5-8.2-11.6-15-14.6l1.6-13.8c22.8-8.1 24-42.4-3.5-47.5a25 25 0 0 0-29.3 23.7 27 27 0 0 0 12.5 23l-1.9 11.1c-7.6 1-13.2 3.1-21.1 10.8l-34.7 36.4a21 21 0 0 0-4.2 7.5l-15.6 52.4c-5.7 13 13.4 19.6 18 7.3L124 328l18.7-18c1.7-2.7 4.6-2.8 4.2.2l-7.7 46.5zM273 80.4q2.3 0 4.4 1.2a8 8 0 0 1 3.3 3.3 9 9 0 0 1 0 8.9 8 8 0 0 1-3.3 3.3 9 9 0 0 1-8.9 0 8 8 0 0 1-3.3-3.3 9 9 0 0 1 0-9 8 8 0 0 1 3.3-3.2 9 9 0 0 1 4.4-1.2m0 0\" style=\"stroke-width:1.47684\"/><g transform=\"translate(324.6 326.5)scale(.36663)\"><circle cx=\"291.6\" cy=\"291.6\" r=\"285\" fill=\"#fff\" style=\"stroke:none\"/><circle cx=\"291.6\" cy=\"291.6\" r=\"272.1\" fill=\"red\" stroke=\"red\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\".2\" style=\"fill:#d40000;fill-opacity:1\"/><circle cx=\"291.6\" cy=\"291.6\" r=\"191.1\" fill=\"#fff\" stroke=\"red\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\".2\"/><path d=\"M378.5 181.7c-63.2 0-78.4 52.4-78.4 114.6 0 57 15.2 105.1 78.4 105.1 63.1 0 78.3-48 78.3-105 0-62.3-15.2-114.7-78.3-114.7m0 42.2c32 0 35.4 28 35.4 67.7s-3.4 67.7-35.4 67.7-35.4-28-35.4-67.7c0-39.6 3.3-67.7 35.4-67.7\" style=\"fill:#000;stroke-width:6.36384;stroke-linecap:round;stroke-linejoin:round;stroke-dashoffset:6.67087;paint-order:stroke fill markers\"/><path d=\"M291.1 245.8c0 22.3-7.8 36.5-21.2 51.1l-61.4 61.2h85.9v42.1H149.3l.1-42.6 90.6-91.4c9.6-9.7 10.1-22.9 4-31.6a29 29 0 0 0-21.5-10.8c-13.2 0-28.6 4.3-32.7 25.9l-40 .1c0-46.4 38-66.9 75-66.9 30.7 0 66 21.8 66.3 63\" style=\"font-size:163.782px;line-height:1.25;font-family:&quot;Caracteres L1&quot;;-inkscape-font-specification:&quot;Caracteres L1&quot;;fill:#000;stroke-width:16.1612\"/></g><path fill=\"#fefefe\" fill-rule=\"evenodd\" d=\"M449.4 226.1a35.3 35.3 0 0 1 0 70.5 35.3 35.3 0 0 1 0-70.5m-115.8 0a35.3 35.3 0 0 1 0 70.5 35.3 35.3 0 0 1 0-70.5m54.3-74q.6-1.8.6-4a12.9 12.9 0 1 0-11 12.8h2l.4.7 1.1 3.9q.6 1.8-.5 2.8l-37.9 37.1-1.5 2a5 5 0 0 0 4.6 7.2 5 5 0 0 0 3.6-1.4l29.3-28.6c.6-.7 1.8-.4 2.2.4l19.4 29.7-32.8 4.2c-5.4.7-11.3 4.7-9 8l13.5 19.5a6 6 0 0 0 5.3 2.8c3.6 0 6.4-4 6.4-6.4s-.4-2.5-1.1-3.6l-3.9-5.6c-.6-.8.4-2 1.2-2l13-1c1-.2 1.8 1 1.4 1.9l-7 14a16 16 0 0 0-1.5 10.8l2.7 21.7a7 7 0 0 0 6.9 6 7 7 0 0 0 6.9-6.9v-.2l-3-21.7c-.3-3 0-4.3 1.5-6.1l22.8-27c2.7-3.3 5.1-11 1.9-15.8l-28.2-43.6c-2.9-5-4.4-6-6.4-5.6-.8.2-1.3-1-2.1-2.1a4 4 0 0 1-.8-3.9m0 0\" style=\"stroke-width:1.47684\"/></g>" },
    "IT-II-323a": { width: 600, height: 600, svg: "<g transform=\"translate(0 -452.4)\"><path d=\"M.5 452.9h599v599H.5z\" style=\"fill:#fff;fill-opacity:1;stroke:#000;stroke-width:.99999994;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-opacity:1;stroke-dasharray:none\"/><rect width=\"582\" height=\"582\" x=\"9\" y=\"461.4\" rx=\"31.7\" ry=\"31.7\" style=\"fill:none;stroke:#000;stroke-width:8.99999905;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-opacity:1;stroke-dasharray:none\"/><g style=\"font-size:128.39006042px;font-style:normal;font-weight:400;line-height:125%;letter-spacing:0;word-spacing:0;fill:#000;fill-opacity:1;stroke:none;font-family:Sans\"><path d=\"M197.8 540.2h36.7V555l-17.4 32.3h17.8V603h-37.8v-14.7l17.4-32.6h-16.7zm69.4-.2q11.4 0 17.9 10.4 5.7 9 5.7 22 0 12.2-5.7 21.2a21 21 0 0 1-18.3 10.3q-10.5 0-17.2-9.2a37 37 0 0 1-6.4-22.4 40 40 0 0 1 5.5-21.6 20 20 0 0 1 18.5-10.6M267 588q3.4 0 4.8-4.7 1-3.3 1-11 0-6.7-.6-9.5-1.2-6.2-5.2-6.2-3.6 0-5 5a45 45 0 0 0-.8 10.7q0 8.2.8 11.2 1.2 4.5 5 4.5m78.5-33.5v48.4h-18.1v-43.2q0-3.6-3.9-3.6-3.8 0-3.8 3.6V603h-18.1v-61.5h14.7l1 2.7q4.9-4.6 11.2-4.6 6.6 0 11.8 4.5t5.2 10.5m53.8 1.7V585q0 3.8 3.5 3.8 1.5 0 2.8-.6l-4.5 14q-2.1.7-4.7.7-7.6 0-12.6-5.3a16 16 0 0 1-12.5 5.3 15 15 0 0 1-10.6-4 16 16 0 0 1-5-12.5q0-5.7 2.8-11 3.8-7.1 11.4-11l10.7-5q0-1-.3-1.8-.5-1.9-2-2.1-6.3-1-14.2 7.4l-8.7-11q12.3-11.7 24.8-11.7 5.3 0 10.5 2.3 4.6 2.1 7 6.8 1.5 3.6 1.6 7M380.6 575q-2.4 1-4.1 3.5-2.4 3-2.3 6.4 0 2.2 1.5 2.2 2 0 4.9-2.7z\" style=\"font-variant:normal;font-stretch:normal;text-align:center;text-anchor:middle;fill:#000;font-family:CodiceNeroCondensed;-inkscape-font-specification:CodiceNeroCondensed\"/></g><path d=\"M1620.3 727a169.7 196 0 1 1-339.4 0 169.7 196 0 1 1 339.4 0z\" style=\"fill:#fff;fill-opacity:1;stroke:#000;stroke-width:.60889953;stroke-miterlimit:4;stroke-opacity:1;stroke-dasharray:none\" transform=\"matrix(.88241 0 0 .76415 -980 261.8)\"/><path d=\"M1620.3 727a169.7 196 0 1 1-339.4 0 169.7 196 0 1 1 339.4 0z\" style=\"fill:#fff;fill-opacity:1;stroke:#d40000;stroke-width:54.16794205;stroke-miterlimit:4;stroke-opacity:1;stroke-dasharray:none\" transform=\"matrix(.74394 0 0 .64423 -779.1 349)\"/><g style=\"font-size:178.31954956px;font-style:normal;font-weight:400;line-height:125%;letter-spacing:0;word-spacing:0;fill:#000;fill-opacity:1;stroke:none;font-family:Sans\"><path d=\"M253.9 753q15.1 0 24.2 8.7 9 9 9.1 21.3 0 21.5-19.8 30.5 9 1.4 15.9 9.3a33 33 0 0 1 8.2 22.3q0 14.3-10.2 25.1a35 35 0 0 1-26.2 11.5 32 32 0 0 1-30.3-17.7 50 50 0 0 1-5.2-17.5l26-5.3q-.5 7.1 2.2 11.2 2.1 3.8 5.9 3.8 3.6 0 6.4-3.5 3-3.5 2.9-9.4 0-9-7.5-13-6-3-15.7-1.8v-24.8q9 0 15.3-6.3 6.5-6.3 4.1-14.7-1.2-4.3-5.2-4.3-1 0-2.4.5-2.6.9-4.7 4.3a21 21 0 0 0-3 10l-24.5-2.7q2.6-21 14-30.5a31 31 0 0 1 20.5-7m90.2-.4q18.6 0 29.5 21.5a94 94 0 0 1 9.2 42.6q0 24.5-8.5 43-10.8 22.8-30 22.8-19.4 0-30.3-22.8a101 101 0 0 1-8.7-43q0-23.1 8.3-41.1 10.8-23 30.5-23m-9.2 64.1q0 37.5 9.4 37.5 2.1 0 3.6-2.1 5.1-7.4 5.1-35.4 0-11.4-1.2-21-2.3-16.5-7.7-16.6-9.2 0-9.2 37.6\" style=\"font-variant:normal;font-stretch:normal;text-align:center;text-anchor:middle;fill:#000;font-family:CodiceNeroCondensed;-inkscape-font-specification:CodiceNeroCondensed\"/></g></g>" },
    "NL-A1-30-ZB": { width: 240, height: 300, svg: "<path d=\"M.2 299.8h239.6V.2H.2zm239.6 0\" style=\"fill:#f7fbf5;stroke:none\"/><path d=\"M.2 299.8h239.6V.2H.2zm239.6 0z\" style=\"fill:none;stroke:#2a2d2f;stroke-width:.49513328\"/><path d=\"M210.6 291.9c10.7 0 19.4-7 19.4-15.8V24c0-8.7-8.7-15.8-19.4-15.8H29.4C18.7 8.1 10 15.1 10 24v252.2c0 8.7 8.7 15.8 19.4 15.8z\" style=\"fill:none;stroke:#2a2d2f;stroke-width:4.95133305\"/><g style=\"fill:#8f9695;fill-opacity:1\"><path d=\"M98.4 43.5H83.5v-3.4l9.9-12.4h-9.6v-3.5h14.5v3.2L88.3 40h10z\" style=\"fill:#8f9695;fill-opacity:1;stroke:none\"/><path d=\"M98.4 43.5H83.5v-3.4l9.9-12.4h-9.6v-3.5h14.5v3.2L88.3 40h10z\" style=\"fill:#2a2d2f;fill-opacity:1;stroke:#f7fbf5;stroke-width:.107279\"/><path d=\"M118 33.7c.5 13.4-16.7 13.4-16.5 0 0-13.2 16.8-12.5 16.6 0m-3.7-1c-.7-7.3-10.2-6.9-9 2.7.6 6.8 10.2 6.7 9-2.8\" style=\"fill:#8f9695;fill-opacity:1;stroke:none\"/><path d=\"M118 33.7c.5 13.4-16.7 13.4-16.5 0 0-13.2 16.8-12.5 16.6 0zm-3.7-1c-.7-7.3-10.2-6.9-9 2.7.6 6.8 10.2 6.7 9-2.8z\" style=\"fill:#2a2d2f;fill-opacity:1;stroke:#f7fbf5;stroke-width:.107279\"/><path d=\"M138.3 24.4v19.2h-3.7l-8.4-12.2v12.2h-3.8V24.4h3.4l8.8 12.5V24.4z\" style=\"fill:#8f9695;fill-opacity:1;stroke:none\"/><path d=\"M138.3 24.4v19.2h-3.7l-8.4-12.2v12.2h-3.8V24.4h3.4l8.8 12.5V24.4z\" style=\"fill:#2a2d2f;fill-opacity:1;stroke:#f7fbf5;stroke-width:.107279\"/><path d=\"M156.5 24.3v3.3H147v4.3h5.7V35H147v5.6h9.4v3.2h-12.6V24.3z\" style=\"fill:#8f9695;fill-opacity:1;stroke:none\"/><path d=\"M156.5 24.3v3.3H147v4.3h5.7V35H147v5.6h9.4v3.2h-12.6V24.3z\" style=\"fill:#2a2d2f;fill-opacity:1;stroke:#f7fbf5;stroke-width:.107279\"/></g><path d=\"M210.7 292c10.7 0 19.4-7 19.4-15.8V23.7c0-8.7-8.7-15.7-19.4-15.7H29.3C18.6 8 9.8 15 9.8 23.7v252.5c0 8.8 8.8 15.8 19.5 15.8z\" style=\"fill:none;stroke:#2a2d2f;stroke-width:4.95718098;stroke-opacity:1\"/><circle cx=\"120.6\" cy=\"150.6\" r=\"85\" fill=\"#0e518d\" style=\"display:inline;fill:#c1121c;fill-opacity:1;stroke-width:.566667\"/><path d=\"M120.6 213.5a62.9 62.9 0 1 0 0-125.8 62.9 62.9 0 0 0 0 125.8\" style=\"display:inline;fill:#f7fbf5;fill-opacity:1;stroke:none\"/><path d=\"M146.5 121c-6.6 0-13 2.8-17.4 7.7a34 34 0 0 0-8.4 22.6c0 8.3 3 16.4 8.4 22.6 4.4 5 10.8 7.7 17.4 7.7s13-2.7 17.4-7.7a34 34 0 0 0 8.4-22.6c0-8.3-3-16.3-8.4-22.6-4.5-5-10.8-7.7-17.4-7.7m-57 0c-6.8 0-13.3 2.5-18.5 7l7 7.6c4-3.4 9.4-4.8 14.6-3.8q3.9.8 6 4.2.9 2.4 0 4.9a6 6 0 0 1-5.6 3.4h-9v10.1h9.7a8 8 0 0 1 7.3 4.6 8 8 0 0 1 0 6.2 10 10 0 0 1-7.3 5.3q-4.4.8-8.7 0-4.9-1.2-8.4-5l-8 7q5.6 6.5 14 8.4 6.5 1.5 13.2 0a23 23 0 0 0 14-10q3-6.2 1.7-12.6a16 16 0 0 0-5.3-9.4q3.8-5.2 3.5-11.5c-.2-4.8-2.7-9.2-6.6-11.9q-6.1-4.3-13.6-4.5m57 10.8c3.5 0 7 1.4 9.3 4a24 24 0 0 1 0 31 13 13 0 0 1-18.7 0 24 24 0 0 1-5.6-15.5c0-5.7 2-11.2 5.6-15.5q3.9-4 9.4-4\" style=\"fill:#2a2d2f;fill-opacity:1;fill-rule:nonzero;stroke:none;stroke-width:.276741\"/>" },
    "NL-A1-60-ZB": { width: 240, height: 300, svg: "<g font-family=\"Arial,Helvetica,sans-serif\"><path d=\"M0 300h240V0H0zm240 0\" style=\"fill:#f7fbf5\"/><text><tspan x=\"50%\" y=\"16%\" alignment-baseline=\"centre\" font-size=\"40\" font-weight=\"bold\" text-anchor=\"middle\">ZONE</tspan></text><circle cx=\"120\" cy=\"140\" r=\"76\" fill=\"#f7fbf5\" stroke=\"red\" stroke-width=\"22\"/><text><tspan x=\"50%\" y=\"56%\" alignment-baseline=\"centre\" font-size=\"96\" font-weight=\"bold\" text-anchor=\"middle\">60</tspan></text><rect width=\"236\" height=\"296\" x=\"2\" y=\"2\" fill=\"none\" stroke=\"#000\" stroke-width=\"4\" rx=\"10\" ry=\"10\"/></g>" },
    "NO-366-30": { width: 255.6, height: 354.9, svg: "<defs><clipPath id=\"omc-NO-366-30-a\"><path d=\"M0 0h2044.8v2839H0z\"/></clipPath></defs><g clip-path=\"url(#omc-NO-366-30-a)\" transform=\"matrix(.13 0 0 -.13 0 354.9)\"><path d=\"M1 1h2042.7v2837H1.1z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1 1h2042.7v2837H1.1z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1 1h2042.7v2837H1.1z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1 1h2042.7v2837H1.1z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M2020.7 2724.1V114.8a89.4 89.4 0 0 0-90.7-90.7H114.8a89.5 89.5 0 0 0-90.7 90.7v2609.3a89.5 89.5 0 0 0 90.7 90.7H1930a89.4 89.4 0 0 0 90.7-90.7\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M2020.7 2724.1V114.8a89.4 89.4 0 0 0-90.7-90.7H114.8a89.5 89.5 0 0 0-90.7 90.7v2609.3a89.5 89.5 0 0 0 90.7 90.7H1930a89.4 89.4 0 0 0 90.7-90.7z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M69.5 2724.1c0 26 19.4 45.4 45.3 45.4H1930c26 0 45.4-19.5 45.4-45.4V114.8a44 44 0 0 0-45.4-45.3H115c-26 0-45.4 19.4-45.4 45.3z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M69.5 2724.1c0 26 19.4 45.4 45.3 45.4H1930c26 0 45.4-19.5 45.4-45.4V114.8a44 44 0 0 0-45.4-45.3H115c-26 0-45.4 19.4-45.4 45.3z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1873 1036.4c0 465.1-382.2 848.2-851 848.2-465 0-848.1-383-848.1-848.2 0-468 383-851 848.1-851 468.8 0 851 383 851 851\" style=\"fill:#e23828;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1873 1036.4c0 465.1-382.2 848.2-851 848.2-465 0-848.1-383-848.1-848.2 0-468 383-851 848.1-851 468.8 0 851 383 851 851z\" style=\"fill:none;stroke:#e23828;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1618.2 2159.6a148 148 0 0 0-141.9 108 298 298 0 0 0 0 159.2c39.7 144.7 244.1 144.7 280.9 0a246 246 0 0 0 11.5-80v-13.7h-227.5a160 160 0 0 1 8.6-54c11.5-28.7 36.7-48.2 68.4-48.2a87 87 0 0 1 79.2 48.3l62.6-31.7c-28.8-53.3-82-87.9-141.8-87.9\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1618.2 2159.6a148 148 0 0 0-141.9 108 298 298 0 0 0 0 159.2c39.7 144.7 244.1 144.7 280.9 0a246 246 0 0 0 11.5-80v-13.7h-227.5a160 160 0 0 1 8.6-54c11.5-28.7 36.7-48.2 68.4-48.2a87 87 0 0 1 79.2 48.3l62.6-31.7c-28.8-53.3-82-87.9-141.8-87.9z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1549.8 2415.2c0-5.7-2.9-14.4-5.8-23h144.8c0 8.6-3 17.3-5.8 23-8 31-36.7 51.2-64.8 51.2-31.7 0-56.9-20.2-68.4-48.3z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1549.8 2415.2c0-5.7-2.9-14.4-5.8-23h144.8c0 8.6-3 17.3-5.8 23-8 31-36.7 51.2-64.8 51.2-31.7 0-56.9-20.2-68.4-48.3z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M733.3 2421c-5.7-26-8.6-48.2-8.6-74.2 0-22.3 2.9-48.2 8.6-70.5 16.6-68.4 76.3-116.7 144-116.7 71.3 0 131 48.3 147.6 116.7 5.8 22.3 8.6 48.2 8.6 70.5 0 26-2.8 48.3-8.6 74.2a152 152 0 0 1-147.6 113 151 151 0 0 1-144-113\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M733.3 2421c-5.7-26-8.6-48.2-8.6-74.2 0-22.3 2.9-48.2 8.6-70.5 16.6-68.4 76.3-116.7 144-116.7 71.3 0 131 48.3 147.6 116.7 5.8 22.3 8.6 48.2 8.6 70.5 0 26-2.8 48.3-8.6 74.2a152 152 0 0 1-147.6 113 151 151 0 0 1-144-113z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M806.8 2412.4c-5.8-23-8.7-42.5-8.7-65.6 0-22.3 2.9-42.5 8.6-61.9 11.6-34.6 39.7-54 70.6-54 34.6 0 62.6 19.4 71.3 54a157 157 0 0 1 11.5 62c0 23-2.9 42.4-11.5 65.4-8.7 31-36.7 54-71.3 54-31 0-59-23-70.5-54\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M806.8 2412.4c-5.8-23-8.7-42.5-8.7-65.6 0-22.3 2.9-42.5 8.6-61.9 11.6-34.6 39.7-54 70.6-54 34.6 0 62.6 19.4 71.3 54a157 157 0 0 1 11.5 62c0 23-2.9 42.4-11.5 65.4-8.7 31-36.7 54-71.3 54-31 0-59-23-70.5-54z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M543.2 2171.2c-91.4-25.2-190-5.8-261.3 54l48.2 59.7c36.7-28.8 85-45.3 133.2-45.3 14.4 0 31.7 0 45.4 5.7 28.8 5 51 31 51 62 0 25.8-16.5 48.2-39.5 59.7a232 232 0 0 1-42.5 11.5l-48.2 13.7a190 190 0 0 0-65.6 28.8c-87.8 54-82 184.3 11.6 232.6 11.5 2.8 23 8.6 33.8 11.5a242 242 0 0 0 187.2-17.3c14.4-5.8 26-14.4 37.4-22.3l-51-62.7a163 163 0 0 1-48.3 25.2 162 162 0 0 1-51.1 8.7 147 147 0 0 1-59.8-11.5 55.5 55.5 0 0 1-39.6-54 57 57 0 0 1 31-47.6c11.5-5.7 23-11.5 34.5-14.4l48.3-11.5c22.3-5.8 42.4-14.4 61.9-22.3 51.1-23 82-74.2 82-128.2 0-61.9-39.5-118.8-98.6-136\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M543.2 2171.2c-91.4-25.2-190-5.8-261.3 54l48.2 59.7c36.7-28.8 85-45.3 133.2-45.3 14.4 0 31.7 0 45.4 5.7 28.8 5 51 31 51 62 0 25.8-16.5 48.2-39.5 59.7a232 232 0 0 1-42.5 11.5l-48.2 13.7a190 190 0 0 0-65.6 28.8c-87.8 54-82 184.3 11.6 232.6 11.5 2.8 23 8.6 33.8 11.5a242 242 0 0 0 187.2-17.3c14.4-5.8 26-14.4 37.4-22.3l-51-62.7a163 163 0 0 1-48.3 25.2 162 162 0 0 1-51.1 8.7 147 147 0 0 1-59.8-11.5 55.5 55.5 0 0 1-39.6-54 57 57 0 0 1 31-47.6c11.5-5.7 23-11.5 34.5-14.4l48.3-11.5c22.3-5.8 42.4-14.4 61.9-22.3 51.1-23 82-74.2 82-128.2 0-61.9-39.5-118.8-98.6-136z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1394.3 2171.2v238.3c0 71.3-54 124.5-125.3 124.5-31 0-62-10.8-87.8-31v23.1h-73.5v-355h73.5v224c0 93.6 139 93.6 139 0v-224z\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1394.3 2171.2v238.3c0 71.3-54 124.5-125.3 124.5-31 0-62-10.8-87.8-31v23.1h-73.5v-355h73.5v224c0 93.6 139 93.6 139 0v-224z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1660.7 1036.4c0 352.1-286.6 635.8-638.7 635.8a636 636 0 0 1-635-635.8c0-351.3 286.6-637.9 635-637.9 352.1 0 638.7 286.6 638.7 638\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1660.7 1036.4c0 352.1-286.6 635.8-638.7 635.8a636 636 0 0 1-635-635.8c0-351.3 286.6-637.9 635-637.9 352.1 0 638.7 286.6 638.7 638z\" style=\"fill:none;stroke:#fff;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M1308.6 644.8c34.6 0 65.5 8.6 93.6 25.9a268 268 0 0 1 82.8 67.7c16.5 25.9 31 48.2 42.5 77a180 180 0 0 1 16.5 56.9 689 689 0 0 1 17.3 152.6c0 34.6-2.9 65.5-8.6 99.4a468 468 0 0 1-25.2 122.4c-11.5 28-26 56.1-45.4 82-23 31-51.1 57-85.7 76.4a219 219 0 0 1-87.8 25.9 242 242 0 0 1-87.8-26c-33.9-16.5-62-45.3-85-76.2a467 467 0 0 1-42.5-82.1c-14.4-39.6-23-80-28-119.5-3-33.9-5.8-67.7-5.8-102.3 0-51.1 5.7-104.4 13.7-152.6a185 185 0 0 1 20.1-57c11.5-28.7 25.2-54 42.5-77 23-28 48.2-51 79.2-67.6 28.8-17.3 62.6-26 93.6-26\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M1308.6 644.8c34.6 0 65.5 8.6 93.6 25.9a268 268 0 0 1 82.8 67.7c16.5 25.9 31 48.2 42.5 77a180 180 0 0 1 16.5 56.9 689 689 0 0 1 17.3 152.6c0 34.6-2.9 65.5-8.6 99.4a468 468 0 0 1-25.2 122.4c-11.5 28-26 56.1-45.4 82-23 31-51.1 57-85.7 76.4a219 219 0 0 1-87.8 25.9 242 242 0 0 1-87.8-26c-33.9-16.5-62-45.3-85-76.2a467 467 0 0 1-42.5-82.1c-14.4-39.6-23-80-28-119.5-3-33.9-5.8-67.7-5.8-102.3 0-51.1 5.7-104.4 13.7-152.6a185 185 0 0 1 20.1-57c11.5-28.7 25.2-54 42.5-77 23-28 48.2-51 79.2-67.6 28.8-17.3 62.6-26 93.6-26z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"M755.6 778.7H750c-48.3 7.9-87.9 48.2-90.8 98.6l-159-13.7a242 242 0 0 1 77-153.3 311 311 0 0 1 158.4-62.7h43.2c82 0 161.3 42.5 203.7 113.8a191 191 0 0 1 28.8 105.1c0 85-51 158.4-131 190 68.4 31 110.9 102.3 110.9 175.8 0 17.3-2.9 33.8-8.7 51a183 183 0 0 1-48.2 82.2 245 245 0 0 1-139 65.5c-16.5 2.9-31 2.9-48.2 2.9a265 265 0 0 1-150.5-48.3 190 190 0 0 1-85-141.8l144.8-14.4c8.6 45.3 45.3 79.2 90.7 79.2 8.6 0 20.2 0 31.7-2.9 42.5-10.8 67.7-51.1 67.7-93.6a97.4 97.4 0 0 0-82.1-96.5c-11.5-2.8-26-2.8-36.7-5V999.7H747c8.6 0 20.2-2.9 28.8-5.7 19.4-5.8 36.7-17.3 53.3-28.1 11.5-11.5 23-26 31.7-40.3a77 77 0 0 0 11.5-42.5c0-16.6-5.8-31-11.5-45.4a123 123 0 0 0-23-28c-5.8-8.7-10.9-14.5-19.5-17.3a62 62 0 0 0-36.7-10.9c-8.7-2.8-17.3-2.8-26-2.8\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"M755.6 778.7H750c-48.3 7.9-87.9 48.2-90.8 98.6l-159-13.7a242 242 0 0 1 77-153.3 311 311 0 0 1 158.4-62.7h43.2c82 0 161.3 42.5 203.7 113.8a191 191 0 0 1 28.8 105.1c0 85-51 158.4-131 190 68.4 31 110.9 102.3 110.9 175.8 0 17.3-2.9 33.8-8.7 51a183 183 0 0 1-48.2 82.2 245 245 0 0 1-139 65.5c-16.5 2.9-31 2.9-48.2 2.9a265 265 0 0 1-150.5-48.3 190 190 0 0 1-85-141.8l144.8-14.4c8.6 45.3 45.3 79.2 90.7 79.2 8.6 0 20.2 0 31.7-2.9 42.5-10.8 67.7-51.1 67.7-93.6a97.4 97.4 0 0 0-82.1-96.5c-11.5-2.8-26-2.8-36.7-5V999.7H747c8.6 0 20.2-2.9 28.8-5.7 19.4-5.8 36.7-17.3 53.3-28.1 11.5-11.5 23-26 31.7-40.3a77 77 0 0 0 11.5-42.5c0-16.6-5.8-31-11.5-45.4a123 123 0 0 0-23-28c-5.8-8.7-10.9-14.5-19.5-17.3a62 62 0 0 0-36.7-10.9c-8.7-2.8-17.3-2.8-26-2.8z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/><path d=\"m1354 1266.1 5.7-5.8 5.8-7.9 5.7-8.6 3-8.6 5.7-11.6 2.8-8.6 5.8-10.8 2.9-8.7 2.9-11.5 2.1-11.5 3-8.6 2.8-10.8v-8.7l2.9-11.5 2.9-8.6v-16.6l2.8-8.6v-28.8l3-8v-74.1l-3-5.8v-28l-2.8-5.8v-20.2l-3-2.8v-13.7l-2.8-5.8v-2.9l-2.9-5.7v-8.7l-2.9-5.7v-5.8l-2.1-2.1v-5.8l-3-5.8-2.8-2.9V855l-2.9-2.9v-5.8l-2.8-2.8v-3l-3-5.7-2.8-2.8v-3l-2.9-2-2.9-3-2.9-5.7-2.8-3-3-2.8-2.8-2.9-2.9-2.8-2.8-5.8-3-2.9-2-2.9-3-2.8h-5.7l-3-3-2.8-2.8h-2.9l-2.8-2.9h-5.8l-2.9-2.2h-22.3l-2.9 2.2h-5.7l-3 2.9h-2.8l-2.9 2.9-2.9 2.9h-2.8l-5.8 2.8-2.9 3-2.9 2.8-2.9 5.8-2.8 2.8-3 3-2 2.8-3 2.9-2.8 5.7-3 3-2.8 2v3l-2.9 2.8v5.8l-2.8 2.9-3 2.8v5.8l-2.8 2.9v5.7l-2.9 3v5.7l-2.9 5.8v2.1l-2.8 5.8v5.7l-3 3v5.7l-2.8 5.7v8.7l-2.9 5.7v10.8l-2.9 3v23l-2.1 2.8V994l-2.9 2.8v54l2.9 5.8v42.5l2.1 8.6v8l3 8.6v8.6l2.8 11.5v8.7l2.9 10.8 2.9 8.6 2.8 11.5 3 11.5 2.8 8.7 5.8 10.8 2.8 8.6 5.8 11.6 5.8 8.6 2.8 8.6 5 8 5.8 5.7 5.8 5.8 5.8 5.7 5.7 5.8 5.8 2.9 5.7 2.9 5.8 2.8h5l5.8 3 5.8-3h5.7l5.8-2.8 5.7-3 5.8-2.8 5.8-5.8 5.7-5.7z\" style=\"fill:#fff;fill-opacity:1;fill-rule:nonzero;stroke:none\"/><path d=\"m1354 1266.1 5.7-5.8 5.8-7.9 5.7-8.6 3-8.6 5.7-11.6 2.8-8.6 5.8-10.8 2.9-8.7 2.9-11.5 2.1-11.5 3-8.6 2.8-10.8v-8.7l2.9-11.5 2.9-8.6v-16.6l2.8-8.6v-28.8l3-8v-74.1l-3-5.8v-28l-2.8-5.8v-20.2l-3-2.8v-13.7l-2.8-5.8v-2.9l-2.9-5.7v-8.7l-2.9-5.7v-5.8l-2.1-2.1v-5.8l-3-5.8-2.8-2.9V855l-2.9-2.9v-5.8l-2.8-2.8v-3l-3-5.7-2.8-2.8v-3l-2.9-2-2.9-3-2.9-5.7-2.8-3-3-2.8-2.8-2.9-2.9-2.8-2.8-5.8-3-2.9-2-2.9-3-2.8h-5.7l-3-3-2.8-2.8h-2.9l-2.8-2.9h-5.8l-2.9-2.2h-22.4l-2.8 2.2h-5.7l-3 2.9h-2.8l-2.9 2.9-2.9 2.9h-2.8l-5.8 2.8-2.9 3-2.9 2.8-2.9 5.8-2.8 2.8-3 3-2 2.8-3 2.9-2.8 5.7-3 3-2.8 2v3l-2.9 2.8v5.8l-2.8 2.9-3 2.8v5.8l-2.8 2.9v5.7l-2.9 3v5.7l-2.9 5.8v2.1l-2.8 5.8v5.7l-3 3v5.7l-2.8 5.7v8.7l-2.9 5.7v10.8l-2.9 3v23l-2.1 2.8V994l-2.9 2.8v54l2.9 5.8v42.5l2.1 8.6v8l3 8.6v8.6l2.8 11.5v8.7l2.9 10.8 2.9 8.6 2.8 11.5 3 11.5 2.8 8.7 5.8 10.8 2.8 8.6 5.8 11.6 5.8 8.6 2.8 8.6 5 8 5.8 5.7 5.8 5.8 5.8 5.7 5.7 5.8 5.8 2.9 5.7 2.9 5.8 2.8h5l5.8 3 5.8-3h5.7l5.8-2.8 5.7-3 5.8-2.8 5.8-5.8 5.7-5.7z\" style=\"fill:none;stroke:#000;stroke-width:2.1500001;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-opacity:1\"/></g>" },
    "PL-B-43-20": { width: 500, height: 500, svg: "<rect width=\"500\" height=\"500\" rx=\"24.7\" ry=\"24.7\" style=\"fill:#000;fill-opacity:1;stroke:none\"/><rect width=\"481.7\" height=\"482.9\" x=\"8.8\" y=\"7.9\" rx=\"19.2\" ry=\"19.2\" style=\"fill:#fff;fill-opacity:1;stroke:none\"/><g transform=\"matrix(1.03225 0 0 1.03204 -2261.7 829.2)\"><circle cx=\"250\" cy=\"250\" r=\"223\" style=\"fill:#fff;stroke:#d40000;stroke-width:52\" transform=\"matrix(.64446 0 0 .64852 2268 -722.7)\"/><path d=\"M2411.1-514.4h-40.3l37.7-50.6a40.5 40.5 0 1 0-72.7-24.7h23.2a17.3 17.3 0 0 1 29.6-12.3q5 4.8 5.1 12.3 0 2.8-.7 5.2t-2.7 5.2l-54.5 72.9v15.2h75.3zm48.4-46.4a104 104 0 0 1 5.8-34.4q2-5.3 6.6-8.5a18.8 18.8 0 0 1 28.2 8.5 106 106 0 0 1 0 68.8 18 18 0 0 1-6.6 8.6 18.8 18.8 0 0 1-28.2-8.6 106 106 0 0 1-5.8-34.4m-23.2 0q0 11.3 2.3 22 2.3 10.8 5.9 20.8a40.6 40.6 0 0 0 76.4 0q3.6-10 5.8-20.8a111 111 0 0 0-5.8-64.8 40.6 40.6 0 0 0-76.4 0q-3.6 10.1-5.9 20.8-2.2 10.8-2.3 22\" style=\"font-size:185.44577026px;font-style:normal;font-variant:normal;font-weight:700;font-stretch:normal;text-align:start;line-height:125%;writing-mode:lr-tb;text-anchor:start;fill:#000;fill-opacity:1;stroke:none;font-family:Drogowskaz;-inkscape-font-specification:Drogowskaz Bold\"/></g>" },
    "PL-B-43-30": { width: 500, height: 500, svg: "<rect width=\"500\" height=\"500\" rx=\"24.7\" ry=\"24.7\" style=\"fill:#000;fill-opacity:1;stroke:none\"/><rect width=\"481.7\" height=\"482.9\" x=\"8.8\" y=\"7.9\" rx=\"19.2\" ry=\"19.2\" style=\"fill:#fff;fill-opacity:1;stroke:none\"/><circle cx=\"250\" cy=\"250\" r=\"223\" style=\"fill:#fff;stroke:#d40000;stroke-width:52\" transform=\"matrix(.66512 0 0 .66932 79.5 83.3)\"/><path d=\"M180.3 254.2a24 24 0 1 1-18 23.1h-23.8a47.7 47.7 0 0 0 47.8 47.9 47.7 47.7 0 0 0 44-67q-3.8-8.8-10.5-15.6a41.5 41.5 0 0 0-4-54.6 41.7 41.7 0 0 0-71.4 29.5h24A17.9 17.9 0 0 1 199 205a17.9 17.9 0 0 1-18.7 29.5zm98-3.8a112 112 0 0 1 6.3-37q2-5.7 7-9.2a20.2 20.2 0 0 1 30.3 9.3 114 114 0 0 1 0 74 19 19 0 0 1-7 9.1 20.2 20.2 0 0 1-30.3-9.2 114 114 0 0 1-6.3-37m-24.9 0q0 12.1 2.5 23.7 2.4 11.5 6.3 22.3a43.7 43.7 0 0 0 82.2 0q3.8-10.8 6.2-22.3a119 119 0 0 0 0-47.3q-2.4-11.6-6.2-22.4a43.7 43.7 0 0 0-82.2 0q-3.9 10.8-6.3 22.4t-2.5 23.6\" style=\"font-size:185.44577026px;font-style:normal;font-variant:normal;font-weight:700;font-stretch:normal;text-align:start;line-height:125%;writing-mode:lr-tb;text-anchor:start;fill:#000;fill-opacity:1;stroke:none;font-family:Drogowskaz;-inkscape-font-specification:Drogowskaz Bold\"/>" },
    "PL-B-43-40": { width: 500, height: 500, svg: "<rect width=\"500\" height=\"500\" rx=\"24.7\" ry=\"24.7\" style=\"fill:#000;fill-opacity:1;stroke:none\"/><rect width=\"481.7\" height=\"482.9\" x=\"8.8\" y=\"7.9\" rx=\"19.2\" ry=\"19.2\" style=\"fill:#fff;fill-opacity:1;stroke:none\"/><g transform=\"matrix(1.03225 0 0 1.03204 -2261.7 829.2)\"><circle cx=\"250\" cy=\"250\" r=\"223\" style=\"fill:#fff;stroke:#d40000;stroke-width:52\" transform=\"matrix(.64446 0 0 .64852 2268 -722.7)\"/><path d=\"m2382.1-630.3-58 81.1v23.2h58v34.8h23.2V-526h11.6l5.8-23.2h-17.4v-81.1zm0 81.1h-34.7l34.7-48.7zm77.4-11.6a104 104 0 0 1 5.8-34.4q2-5.3 6.6-8.5a18.8 18.8 0 0 1 28.2 8.5 106 106 0 0 1 0 68.8 18 18 0 0 1-6.6 8.6 18.8 18.8 0 0 1-28.2-8.6 106 106 0 0 1-5.8-34.4m-23.2 0q0 11.3 2.3 22 2.3 10.8 5.9 20.8a40.6 40.6 0 0 0 76.4 0q3.6-10 5.8-20.8a111 111 0 0 0-5.8-64.8 40.6 40.6 0 0 0-76.4 0q-3.6 10.1-5.9 20.8-2.2 10.8-2.3 22\" style=\"font-size:185.44577026px;font-style:normal;font-variant:normal;font-weight:700;font-stretch:normal;text-align:start;line-height:125%;writing-mode:lr-tb;text-anchor:start;fill:#000;fill-opacity:1;stroke:none;font-family:Drogowskaz;-inkscape-font-specification:Drogowskaz Bold\"/></g>" },
    "SI-III-29-40": { width: 502.6, height: 502.6, svg: "<path d=\"M-4195.3-5732.5a25 25 0 0 0-25.2 25.1v449.7a25 25 0 0 0 25.2 25.2h449.7a25 25 0 0 0 25.1-25.2v-449.7a25 25 0 0 0-25.1-25.1z\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:#000;stroke-opacity:1;stroke-width:2;stroke-miterlimit:4;stroke-dasharray:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"M-4190.3-5723.5a21 21 0 0 0-21.2 21v439.8c0 11.7 9.5 21.2 21.2 21.2h439.7c11.6 0 21.1-9.5 21.1-21.2v-439.7c0-11.6-9.5-21.1-21-21.1z\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"M-4198.7-5262.8c0 4.7 3.8 8.5 8.5 8.5h439.5c4.6 0 8.4-3.8 8.4-8.5v-439.5c0-4.6-3.8-8.4-8.4-8.4h-439.5a8.5 8.5 0 0 0-8.5 8.4z\" style=\"fill:#fff;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"m-3878.2-5681.7 19.5 66h-12.5l-3-9.2h-22.3l-3 9.2h-12.4l19.5-66zm-7.1 18.8-7.9 26.7h15.8zm-117.1-19.6c-12.6 0-22.6 10-22.6 22v23.3c0 12.5 10 22.4 22.6 22.4s22.6-9.9 22.6-22.4v-23.2c0-12.1-10-22.1-22.6-22.1m0 10.6c5.9 0 10.3 4.7 10.3 10.3v25.4a10.3 10.3 0 1 1-20.6 0v-25.4c0-5.6 4.4-10.2 10.3-10.3m-57.2-10.6c-12.6 0-22.6 10-22.6 22v23.3c0 12.5 10 22.4 22.6 22.4s22.6-9.9 22.6-22.4h-12.3v1a10.3 10.3 0 1 1-20.6 0v-25.4a10.3 10.3 0 1 1 20.6 0v1.2h12.3c0-12.1-10-22.1-22.6-22.1m105.6.8h-13.8v66h10.6v-43.6l20.4 43.6h13.9v-66h-10.6v43.7z\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"M-3970.5-5585.6a151 151 0 1 0 0 302 151 151 0 0 0 0-302\" style=\"fill:#d40000;fill-opacity:1;stroke:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"M-3970.5-5555.6a121 121 0 1 0 0 242 121 121 0 0 0 0-242\" style=\"fill:#fff;fill-opacity:1;stroke:none\" transform=\"translate(4221.8 5733.8)\"/><path d=\"M-4010.6-5404.3h-30.4l30.4-64.7zm20 18.1h6v-18.1h-6V-5505h-26l-46.4 100.7v18h52.3v22h20.2zm102.1-12.1v-72.5a36.2 36.2 0 0 0-72.4 0v72.5a36.2 36.2 0 0 0 72.4 0m-20 2v-76.5a16.2 16.2 0 1 0-32.3 0v76.5a16.1 16.1 0 1 0 32.3 0\" style=\"fill:#000;fill-opacity:1;fill-rule:evenodd;stroke:none\" transform=\"translate(4221.8 5733.8)\"/>" },
    "snow": { width: 248, height: 287, svg: "<path d=\"M0 0h248v287H0z\" style=\"fill:#fff;stroke:none\"/><path d=\"M338.9 323.5 352 316v-13.4l11.6 6.7 13.2-7.6v-15.3L352 272v-40l34.7 20v28.6l13.2 7.6 13.2-7.6v-13.4l11.6 6.7 13.2-7.6V251l-11.6-6.6 11.6-6.7v-15.3l-13.2-7.6L400 229l-34.7-20L400 189l24.8 14.3 13.2-7.6v-15.3l-11.6-6.7L438 167v-15.2l-13.2-7.6-11.6 6.6v-13.3l-13.2-7.6-13.2 7.6V166l-34.7 20v-40l24.8-14.4v-15.2l-13.2-7.7-11.6 6.7v-13.3l-13.2-7.7-13.3 7.7v13.3l-11.5-6.7-13.2 7.7v15.2l24.7 14.4v40l-34.7-20v-28.6l-13.2-7.6-13.2 7.6v13.3l-11.6-6.6-13.2 7.6V167l11.6 6.7-11.6 6.7v15.3l13.2 7.6 24.8-14.3 34.7 20-34.7 20.1-24.8-14.3-13.2 7.6v15.3l11.6 6.7-11.6 6.6v15.3l13.2 7.6 11.6-6.7v13.4l13.2 7.6 13.2-7.6V252l34.7-20v40L301 286.3v15.3l13.2 7.6 11.5-6.7V316\" style=\"fill:#000;fill-opacity:1;fill-rule:nonzero;stroke:none\" transform=\"matrix(1.25 0 0 -1.25 -299.6 404.4)\"/>" },
  };
  // END GENERATED SIGN ART

  // BEGIN GENERATED DEFAULT SPEEDS
  /**
   * Legal default speed limits per country, from the OSM wiki page "Default speed
   * limits" (https://wiki.openstreetmap.org/wiki/Default_speed_limits), licensed
   * CC BY-SA 2.0. Written by dev/build-defaults.js; check monthly for updates with
   * `node dev/build-defaults.js --check`.
   * A function, not a constant: declarations are hoisted, so the code above can
   * use it although this block comes last (the Node tests return before it).
   * @returns {DefaultSpeedTable}
   */
  function defaultSpeedTable() {
    return {
      revision: 3108406, date: '2026-10-25',
      roadTypes: {
        "Alabama: rural highway": "{rural} and ref~\"(US|AL|I).*\"",
        "Alabama: rural highway with 2 or more lanes in each direction": "{Alabama: rural highway} and {road with 2 or more lanes in each direction}",
        "Albania: Rrugë interurbane kryesore": "{rural} and {dual carriageway} and lanes>=2",
        "Alberta: Provincial highway": "ref",
        "Alberta: Urban provincial highway": "{urban} and ref",
        "Alberta: Urban road": "{urban} and !ref",
        "alley": "highway=service and service=alley",
        "Andorra: Carretera general": "ref~CG.*",
        "Andorra: Carretera secundària": "ref~CS.*",
        "Argentina: Avenida": "{urban} and highway~trunk|trunk_link|primary|primary_link|secondary|secondary_link",
        "Argentina: Calle": "{urban} and highway~tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|service|track",
        "Argentina: Semiautopista": "highway~trunk|trunk_link and {motorroad}",
        "Benin: Route nationale": "ref~\"RN(IE)?.*\"",
        "Brasil: Estrada rural": "",
        "Brasil: Rodovia rural de pista dupla": "",
        "Brasil: Rodovia rural de pista simples": "",
        "Brasil: Via urbana arterial": "",
        "Brasil: Via urbana coletora": "",
        "Brasil: Via urbana de trânsito rápido": "",
        "Brasil: Via urbana local": "",
        "business district": "abutters~retail|commercial",
        "California: alley": "highway=service and (!width or width<=7.6)",
        "county road": "",
        "Croatia:brza cesta": "highway~trunk|trunk_link and ref~B.*",
        "cycle street": "bicycle_road=yes or cyclestreet=yes",
        "District of Columbia: alley": "highway=service and (!width or width<9.144)",
        "dual carriageway": "dual_carriageway=yes or maxspeed:type~\".*nsl_dual\"",
        "dual carriageway in residential district": "{dual carriageway} and {residential district}",
        "dual carriageway with 2 or more lanes in each direction": "{dual carriageway} and lanes>=2",
        "Ecuador: Via perimetral": "",
        "Egypt: \"الطرق السريعة أو الرئيسية التى تربط المحافظات ، والتى تتبع المحليات أو الهيئة العامة للطرق والكبارى\"": "",
        "Egypt: \"الطرق الصحراوية\"": "",
        "expressway": "expressway=yes",
        "Flanders:Jaagpad": "designation=towpath",
        "footway": "highway=footway",
        "frontage road": "frontage_road=yes or side_road=yes",
        "Guatemala: Arteria principal": "{urban} and ((!{oneway} and lanes>=3 and width>=10.5) or ({oneway} and lanes>=2 and width>=7))",
        "Guatemala: Arteria secundaria": "{urban} and ((!{oneway} and lanes>=3 and width>=9) or ({oneway} and lanes>=2 and width>=6))",
        "Guatemala: Camino": "{unpaved road}",
        "Guatemala: Carretera principal": "{rural} and lanes>=2 and width>=7 and {has shoulder}",
        "Guatemala: Carretera secundaria": "{rural} and lanes>=2 and width>=5.5",
        "Guatemala: Vía local": "{urban} and width>=5",
        "Guatemala: Vía rápida": "{rural} and {has shoulder} and (({oneway} and lanes>=2 and width>=7) or (!{oneway} and lanes>=4 and width>=14))",
        "Guatemala: Vía rápida urbana": "{urban} and {has shoulder} and (({oneway} and lanes>=2 and width>=7) or (!{oneway} and lanes>=4 and width>=14))",
        "Guatemala: Vía residencial": "{urban} and width>=3 and width<5.5",
        "Guyana: Timehri Field / Linden Highway": "",
        "has no sidewalk": "sidewalk~no|none or sidewalk:both~no|none or (sidewalk:left~no|none and sidewalk:right~no|none)",
        "has shoulder": "shoulder~yes|both|left|right or shoulder:left=yes or shoulder:right=yes or shoulder:both=yes",
        "hilly road": "",
        "Idaho: State highway": "ref~\"(ID|SH|US).*\"",
        "Iowa: Institutional road": "",
        "Iowa: suburban district": "{urban} and !{school zone} and !{residential district} and !{business district}",
        "Ireland: National road": "ref~N.* or (highway~trunk|trunk_link|primary|primary_link and (!ref or ref~N.*))",
        "Italy: Autostrada": "{motorway}",
        "Italy: Strada extraurbana local": "{rural}",
        "Italy: Strada extraurbana principale": "{rural} and highway~trunk|trunk_link and {dual carriageway} and lanes>=2 and {has shoulder}",
        "Italy: Strada extraurbana secondaria": "{rural} and {single carriageway} and lanes>=2",
        "Kansas: state highway": "ref~\"(KS|US).*\"",
        "lettered road with 2 lanes": "ref~[A-Z] and lanes=2",
        "living street": "highway=living_street or living_street=yes",
        "Malawi: rural highway": "{rural} and surface~asphalt|concrete and width>5.5",
        "Mauritius: A road": "ref~A.*",
        "Mauritius: B road": "ref~B.*",
        "Mauritius: C road": "ref~C.*",
        "Mauritius: M road": "ref~M.*",
        "Mexico: avenida primaria sin acceso controlado": "highway~primary|primary_link and expressway!=yes",
        "Mexico: calle secundaria o calle terciaria": "highway~secondary|secondary_link|tertiary|tertiary_link|unclassified",
        "Mexico: carretera o autopista de jurisdicción federal": "ref~MEX.*",
        "Mexico: carril central de una avenida de acceso controlado": "highway~primary|primary_link and expressway=yes",
        "Mexico: zona de hospital, asilo, albergue o casa hogar": "highway~living_street|service|pedestrian|residential",
        "Mexico: zona o entorno escolar": "{school zone}",
        "Mexico: zona o entorno escolar en una vía secundaria o calle terciaria": "{Mexico: calle secundaria o calle terciaria} and {school zone}",
        "Mongolia: тууш замд": "",
        "motorroad": "motorroad=yes",
        "motorroad with 2 lanes in each direction": "{motorroad} and {road with 2 or more lanes in each direction}",
        "motorroad with dual carriageway": "{motorroad} and {dual carriageway}",
        "motorroad with single carriageway": "{motorroad} and {single carriageway}",
        "motorway": "highway~motorway|motorway_link",
        "motorway with 2 lanes in each direction": "{motorway} and {road with 2 or more lanes in each direction}",
        "Nebraska: State expressway or super-two highway": "{expressway} and {Nebraska: State highway}",
        "Nebraska: State highway": "ref~\"(NE|US).*\"",
        "Newfoundland and Labrador: Trans-Canada highway": "ref=1",
        "Nicaragua: Carretera": "",
        "Niger: autoroute": "highway~motorway|motorway_link",
        "Niger: national road": "ref~N.*",
        "numbered road": "ref",
        "Ohio: Urban state route": "ref~SR.* and {urban}",
        "oneway": "oneway~yes|-1 or junction~roundabout|circular",
        "Palestine: شارعمختل": "",
        "Panama: Avenida": "",
        "Panama: Avenida de dos carriles": "",
        "Panama: Carretera multicarril en zona urbana": "",
        "parking lot": "highway=service and service=parking_aisle",
        "pedestrian zone": "highway=pedestrian",
        "Perú: Avenida": "name~Avenida.*",
        "Perú: Carretera": "ref~PE.*",
        "Perú: Vía Expresa": "name~\"Vía Expresa.*\"",
        "Philippines: Barangay road": "designation=barangay_road or designation=barangay",
        "Philippines: National road": "ref~[1-9][0-9]? or ref~[1-9][0-9][0-9] or  designation~national_tertiary_road|national_secondary_road|national_primary_road",
        "Philippines: Provincial road": "designation=provincial_road",
        "Philippines: Through street": "{urban} and (ref or designation~provincial_road|national_tertiary_road|national_secondary_road|national_primary_road)",
        "playground zone": "hazard=children or playground_zone=yes or hazard=playground_zone or restriction=playground_zone or maxspeed:variable=playground_zone",
        "public park": "abutters=park",
        "Quebec: Autoroute": "(ref >= 1 and ref <= 99) or (ref >= 400 and ref <= 999)",
        "residential district": "abutters=residential",
        "road with 1 lane in each direction": "!lanes or ((!{oneway} and lanes=2) or ({oneway} and lanes=1))",
        "road with 2 lanes in each direction": "((!{oneway} and lanes=4) or ({oneway} and lanes=2))",
        "road with 2 or more lanes in each direction": "((!{oneway} and lanes>=4) or ({oneway} and lanes>=2))",
        "road with 3 lanes in each direction": "((!{oneway} and lanes=6) or ({oneway} and lanes=3))",
        "road with 4 or more lanes in each direction": "((!{oneway} and lanes>=8) or ({oneway} and lanes>=4))",
        "road with asphalt or concrete surface": "surface~asphalt|concrete or (!surface and tracktype=grade1)",
        "road without asphalt or concrete surface": "(surface and surface!~asphalt|concrete) or (!surface and tracktype and tracktype!=grade1)",
        "Romania: drum expres": "{rural} and {expressway}",
        "Romania: drum național european (E)": "{rural} and int_ref~E.*",
        "roundabout": "junction=roundabout",
        "rural": "source:maxspeed~\".*(rural|motorway|motorroad)\" or maxspeed:type~\".*(rural|motorway|motorroad|nsl_single|nsl_dual)\" or zone:maxspeed~\".*(rural|motorway|motorroad)\" or zone:traffic~\".*(rural|motorway|motorroad)\" or maxspeed~\".*(rural|motorway|motorroad)\" or HFCS~.*Rural.* or rural=yes",
        "rural dual carriageway": "{rural} and {dual carriageway}",
        "rural dual carriageway with 2 or more lanes in each direction": "{rural} and {dual carriageway with 2 or more lanes in each direction}",
        "rural expressway": "{rural} and {expressway}",
        "rural expressway without traffic lights": "",
        "rural motorroad": "{rural} and {motorroad}",
        "rural motorroad with single carriageway": "{rural} and {motorroad} and {single carriageway}",
        "rural motorway": "{rural} and {motorway}",
        "rural numbered road": "{rural} and {numbered road}",
        "rural one-way road with 1 lane": "{rural} and {oneway} and lanes=1",
        "rural open mountain road": "",
        "rural playground zone": "{rural} and {playground zone}",
        "rural residential district": "{rural} and {residential district}",
        "rural road with 1 lane in each direction": "{rural} and {road with 1 lane in each direction}",
        "rural road with 2 lanes in each direction": "{rural} and {road with 2 lanes in each direction}",
        "rural road with 2 or more lanes in each direction": "{rural} and {road with 2 or more lanes in each direction}",
        "rural road with 3 lanes in each direction": "{rural} and {road with 3 lanes in each direction}",
        "rural road with 4 or more lanes in each direction": "{rural} and {road with 4 or more lanes in each direction}",
        "rural road with asphalt or concrete surface": "{rural} and {road with asphalt or concrete surface}",
        "rural road without asphalt or concrete surface": "{rural} and {road without asphalt or concrete surface}",
        "rural school zone": "{rural} and {school zone}",
        "rural single carriageway": "{rural} and {single carriageway}",
        "rural single carriageway with 2 or more lanes in each direction": "{rural} and {single carriageway} and lanes>=4",
        "rural unpaved road": "{rural} and {unpaved road}",
        "rural US interstate highway": "{rural} and {US interstate highway}",
        "rural winding mountain road": "",
        "school zone": "school_zone=yes or hazard=school_zone or restriction=school_zone or maxspeed:variable=school_zone",
        "Senegal: National road": "",
        "service road": "highway=service",
        "Singapore: silver zone": "hazard=elderly or silver_zone=yes or hazard=silver_zone",
        "single carriageway": "dual_carriageway=no or maxspeed:type~\".*nsl_single\"",
        "single carriageway in residential district": "{single carriageway} and {residential district}",
        "Spain: Travesía": "",
        "state park": "",
        "suburban business district": "",
        "suburban residential district": "",
        "Tennessee: Rural state road with 2 or more lanes in each direction": "{Tennessee: State route} and {rural} and {road with 2 or more lanes in each direction}",
        "Tennessee: State route": "ref~\"(TN|SR|US).*\"",
        "Thailand: motorway that is not a ทํางพิเศษ": "{motorway} and ref",
        "Thailand: ทํางขนําน": "{frontage road}",
        "Thailand: ทํางพิเศษ not on bridge or in tunnel": "{motorway} and !ref and (!bridge or bridge=no) and (!tunnel or tunnel=no)",
        "Thailand: ทํางพิเศษ on bridge or in tunnel": "{motorway} and !ref and ((bridge and bridge!=no) or (tunnel and tunnel!=no))",
        "trailer park": "abutters=trailer_park",
        "trunk": "highway~trunk|trunk_link",
        "United Kingdom: restricted road": "lit=yes or maxspeed:type=GB:nsl_restricted",
        "unpaved road": "surface~unpaved|ground|gravel|dirt|grass|compacted|sand|fine_gravel|earth|pebblestone|mud|clay|soil|rock|laterite or (!surface and tracktype and tracktype!=grade1)",
        "urban": "source:maxspeed~.*urban or maxspeed:type~.*urban or zone:maxspeed~.*urban or zone:traffic~.*urban or maxspeed~.*urban or HFCS~.*Urban.* or rural=no",
        "urban and without centerline": "{urban} and {without centerline}",
        "urban business district": "{urban} and {business district}",
        "urban dual carriageway": "{urban} and {dual carriageway}",
        "urban dual carriageway with 2 or more lanes in each direction": "{urban} and {dual carriageway with 2 or more lanes in each direction}",
        "urban expressway": "{urban} and {expressway}",
        "urban expressway without traffic lights": "",
        "urban motorroad": "{urban} and {motorroad}",
        "urban motorway": "{urban} and {motorway}",
        "urban one-way road with 1 lane": "{urban} and {oneway} and lanes<2",
        "urban playground zone": "{urban} and {playground zone}",
        "urban public park": "{urban} and {public park}",
        "urban residential district": "{urban} and {residential district}",
        "urban road which is not numbered": "{urban} and !{numbered road}",
        "urban road with 2 lanes in each direction": "{urban} and {road with 2 lanes in each direction}",
        "urban road with 2 or more lanes in each direction": "{urban} and {road with 2 or more lanes in each direction}",
        "urban road with 3 lanes in each direction": "{urban} and {road with 3 lanes in each direction}",
        "urban road with 4 or more lanes in each direction": "{urban} and {road with 4 or more lanes in each direction}",
        "urban road without sidewalk": "{urban} and {has no sidewalk}",
        "urban school zone": "{urban} and {school zone}",
        "urban single carriageway": "{urban} and {single carriageway}",
        "urban unpaved road": "{urban} and {unpaved road}",
        "urban US interstate highway": "{urban} and {US interstate highway}",
        "US interstate highway": "ref~I.* and {motorway}",
        "US interstate highway with 2 or more lanes in each direction": "{US interstate highway} and ((lanes>=2 and {oneway}) or (lanes>=4 and !{oneway}))",
        "village": "",
        "Virginia: Rustic road": "ref~R.*",
        "Virginia: State primary highway": "ref~\"(US|VA).*\"",
        "Washington: State highway": "ref~\"(US|WA).*\"",
        "Wisconsin: Rustic road": "ref~R.*",
        "Wisconsin: semiurban or outlying district": "",
        "without centerline": "lanes<2 or lane_markings=no",
        "Wyoming: State highway": "ref~WYO?.*",
      },
      countries: {
        "AD": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"60"}],["Andorra: Carretera secundària",{"maxspeed":"60"}],["Andorra: Carretera general",{"maxspeed":"90"}],["motorroad",{"maxspeed":"120"}],["motorway",{"maxspeed":"120"}]],
        "AE": [["service road",{"maxspeed":"25"}],["urban single carriageway",{"maxspeed":"40"}],["urban dual carriageway",{"maxspeed":"60","maxspeed:bus":"80","maxspeed:hgv":"80"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:hgv":"80"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"120","maxspeed:bus":"80","maxspeed:hgv":"80"}]],
        "AF": [["",{"maxspeed":"90"}]],
        "AG": [["urban",{"maxspeed":"20 mph","maxspeed:bus":"15 mph","maxspeed:goods":"15 mph"}],["",{"maxspeed":"40 mph","maxspeed:bus":"25 mph","maxspeed:goods":"25 mph"}],["rural",{"maxspeed":"40 mph","maxspeed:bus":"25 mph","maxspeed:goods":"25 mph"}]],
        "AL": [["urban",{"maxspeed":"40","maxspeed:bus:conditional":"35 @ (weightrating>8)","maxspeed:hgv:conditional":"35 @ (trailer); 35 @ (articulated)"}],["",{"maxspeed":"80","maxspeed:bus:conditional":"70 @ (weightrating>8)","maxspeed:hgv":"70","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated); 60 @ (weightrating>12)"}],["rural",{"maxspeed":"80","maxspeed:bus:conditional":"70 @ (weightrating>8)","maxspeed:hgv":"70","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated); 60 @ (weightrating>12)"}],["Albania: Rrugë interurbane kryesore",{"maxspeed":"90","maxspeed:bus:conditional":"70 @ (weightrating>8)","maxspeed:hgv":"70","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated); 60 @ (weightrating>12)"}],["motorway",{"maxspeed":"110","maxspeed:bus:conditional":"90 @ (weightrating>8)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated); 80 @ (weightrating>12)"}]],
        "AM": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"60","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:coach":"90","maxspeed:conditional":"90 @ (trailer)","maxspeed:hgv":"90"}]],
        "AO": [["urban",{"maxspeed":"60","maxspeed:bus":"50","maxspeed:bus:conditional":"40 @ (trailer)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"60","maxspeed:goods:conditional":"50 @ (trailer)","maxspeed:hgv":"50","maxspeed:hgv:conditional":"50 @ (articulated); 40 @ (trailer)"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (articulated); 70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (articulated); 70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (articulated); 70 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"110","maxspeed:goods:conditional":"90 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"90 @ (articulated); 80 @ (trailer)"}]],
        "AR": [["school zone",{"maxspeed":"20"}],["Argentina: Calle",{"maxspeed":"40"}],["Argentina: Avenida",{"maxspeed":"60"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"110","maxspeed:hgv":"80"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"110","maxspeed:hgv":"80"}],["Argentina: Semiautopista",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"110","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"110","maxspeed:hgv":"80"}]],
        "AS": [["urban",{"maxspeed":"15 mph"}],["",{"maxspeed":"25 mph"}],["rural",{"maxspeed":"25 mph"}]],
        "AT": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"walk"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 70 @ (weightrating>3.5)","maxspeed:hgv":"70"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 70 @ (weightrating>3.5)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 70 @ (weightrating>3.5)","maxspeed:hgv":"70"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (articulated)","maxspeed:conditional":"100 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (articulated)","maxspeed:conditional":"100 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}]],
        "AU": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100"}],["rural",{"maxspeed":"100"}]],
        "AU-ACT": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}],["rural",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}]],
        "AU-NSW": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:conditional":"100 @ (weightrating>4.5)"}],["rural",{"maxspeed":"100","maxspeed:conditional":"100 @ (weightrating>4.5)"}]],
        "AU-NT": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"110","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}],["rural",{"maxspeed":"110","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}]],
        "AU-QLD": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)","maxspeed:hgv:conditional":"90 @ (trailer); 90 @ (articulated)"}],["rural",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)","maxspeed:hgv:conditional":"90 @ (trailer); 90 @ (articulated)"}]],
        "AU-SA": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}],["rural",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}]],
        "AU-TAS": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}],["rural road with asphalt or concrete surface",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)"}],["rural road without asphalt or concrete surface",{"maxspeed":"80"}]],
        "AU-VIC": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)","maxspeed:hgv:conditional":"100 @ (articulated AND weightrating>22)"}],["rural",{"maxspeed":"100","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12)","maxspeed:hgv:conditional":"100 @ (articulated AND weightrating>22)"}]],
        "AU-WA": [["pedestrian zone",{"maxspeed":"10"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"110","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12); 100 @ (trailer)"}],["rural",{"maxspeed":"110","maxspeed:bus:conditional":"100 @ (weightrating>5)","maxspeed:conditional":"100 @ (weightrating>12); 100 @ (trailer)"}]],
        "AW": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}]],
        "AZ": [["service road",{"maxspeed":"20"}],["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:goods":"90","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:goods":"90","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:coach":"90","maxspeed:goods":"110","maxspeed:hgv":"90"}]],
        "BA": [["living street",{"maxspeed":"walk"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}]],
        "BB": [["",{"maxspeed":"60","maxspeed:bus":"50","maxspeed:coach":"50","maxspeed:conditional":"50 @ (weightrating>3); 30 @ (trailer)","maxspeed:hgv":"50"}]],
        "BE-BRU": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"30"}],["",{"maxspeed":"70"}],["rural",{"maxspeed":"70"}],["rural single carriageway with 2 or more lanes in each direction",{"maxspeed":"70"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>3.5)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:conditional":"90 @ (weightrating>3.5)"}]],
        "BE-VLG": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"70"}],["rural",{"maxspeed":"70"}],["rural single carriageway with 2 or more lanes in each direction",{"maxspeed":"70"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>3.5)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:conditional":"90 @ (weightrating>3.5)"}],["Flanders:Jaagpad",{"maxspeed":"30"}]],
        "BE-WAL": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}],["rural single carriageway with 2 or more lanes in each direction",{"maxspeed":"90"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>3.5)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:conditional":"90 @ (weightrating>3.5)"}]],
        "BF": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>10)"}],["rural",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>10)"}]],
        "BG": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:bus":"50","maxspeed:hgv":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated)"}],["motorroad",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>3.5); 90 @ (trailer)","maxspeed:hgv":"90"}],["motorway",{"maxspeed":"140","maxspeed:bus":"100","maxspeed:conditional":"100 @ (weightrating>3.5); 100 @ (trailer)","maxspeed:hgv":"100"}]],
        "BH": [["urban",{"maxspeed":"60","maxspeed:bus":"50","maxspeed:goods":"50"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:goods":"80"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:goods":"80"}]],
        "BI": [["urban",{"maxspeed":"50","maxspeed:bus":"40"}],["",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:conditional":"50 @ (weightrating>10)"}],["rural",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:conditional":"50 @ (weightrating>10)"}],["rural dual carriageway",{"maxspeed":"100","maxspeed:bus":"70","maxspeed:conditional":"90 @ (weightrating>10)"}]],
        "BJ": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:hgv:conditional":"90 @ (weightrating>10)"}],["rural road with asphalt or concrete surface",{"maxspeed":"90","maxspeed:hgv:conditional":"90 @ (weightrating>10)"}],["Benin: Route nationale",{"maxspeed":"90","maxspeed:hgv:conditional":"90 @ (weightrating>10)"}],["motorway",{"maxspeed":"110","maxspeed:hgv:conditional":"90 @ (weightrating>10)"}]],
        "BN": [["urban",{"maxspeed":"60"}],["",{"maxspeed:bus":"80","maxspeed:bus:conditional":"75 @ (trailer)","maxspeed:conditional":"75 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"75 @ (weightrating>7.5); 75 @ (trailer); 75 @ (articulated)"}],["rural",{"maxspeed:bus":"80","maxspeed:bus:conditional":"75 @ (trailer)","maxspeed:conditional":"75 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"75 @ (weightrating>7.5); 75 @ (trailer); 75 @ (articulated)"}]],
        "BO": [["school zone",{"maxspeed":"10"}],["pedestrian zone",{"maxspeed":"20"}],["urban",{"maxspeed":"40"}],["",{"maxspeed":"80"}],["rural road with asphalt or concrete surface",{"maxspeed":"80"}],["rural road without asphalt or concrete surface",{"maxspeed":"70"}]],
        "BR": [["Brasil: Via urbana local",{"maxspeed":"30"}],["Brasil: Via urbana coletora",{"maxspeed":"40"}],["Brasil: Via urbana arterial",{"maxspeed":"60"}],["Brasil: Via urbana de trânsito rápido",{"maxspeed":"80"}],["",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:goods":"100","maxspeed:hgv":"90"}],["Brasil: Rodovia rural de pista simples",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:goods":"100","maxspeed:hgv":"90"}],["Brasil: Rodovia rural de pista dupla",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:goods":"110","maxspeed:hgv":"90"}],["Brasil: Estrada rural",{"maxspeed":"60"}]],
        "BS": [["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"45 mph"}],["rural",{"maxspeed":"45 mph"}]],
        "BS-NP": [["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"30 mph"}],["rural",{"maxspeed":"30 mph"}]],
        "BT": [["urban",{"maxspeed":"30"}],["",{"maxspeed":"50","maxspeed:bus":"35","maxspeed:goods":"50","maxspeed:goods:conditional":"35 @ (weightrating>3)"}],["rural",{"maxspeed":"50","maxspeed:bus":"35","maxspeed:goods":"50","maxspeed:goods:conditional":"35 @ (weightrating>3)"}]],
        "BW": [["living street",{"maxspeed":"30"}],["urban",{"maxspeed":"60","maxspeed:bus":"80","maxspeed:bus:conditional":"100 @ (length>10); 100 @ (seats>=15); 80 @ (trailer); 80 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"100 @ (length>10); 100 @ (seats>=15); 80 @ (trailer); 80 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"100 @ (length>10); 100 @ (seats>=15); 80 @ (trailer); 80 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}]],
        "BY": [["living street",{"maxspeed":"20"}],["pedestrian zone",{"maxspeed":"20"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:conditional":"90 @ (trailer)","maxspeed:hgv":"90"}]],
        "CA-AB": [["playground zone",{"maxspeed":"30"}],["school zone",{"maxspeed":"30"}],["Alberta: Urban road",{"maxspeed":"50"}],["Alberta: Urban provincial highway",{"maxspeed":"80"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["Alberta: Provincial highway",{"maxspeed":"100"}]],
        "CA-BC": [["playground zone",{"maxspeed":"50","maxspeed:conditional":"30 @ (dawn-dusk)"}],["school zone",{"maxspeed":"50","maxspeed:conditional":"30 @ (Mo-Fr 08:00-17:00; PH,SH off)"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}]],
        "CA-MB": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}]],
        "CA-NB": [["urban school zone",{"maxspeed":"50","maxspeed:conditional":"30 @ (07:30-16:00)"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["rural school zone",{"maxspeed":"80","maxspeed:conditional":"50 @ (07:30-16:00)"}]],
        "CA-NL": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["rural school zone",{"maxspeed":"80","maxspeed:conditional":"50 @ (07:00-17:00)"}],["rural road without asphalt or concrete surface",{"maxspeed":"60"}],["Newfoundland and Labrador: Trans-Canada highway",{"maxspeed":"100"}]],
        "CA-NS": [["urban school zone",{"maxspeed":"30"}],["business district",{"maxspeed":"50"}],["residential district",{"maxspeed":"50"}],["urban public park",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["rural school zone",{"maxspeed":"50"}]],
        "CA-NT": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}]],
        "CA-NU": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}]],
        "CA-ON": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}]],
        "CA-PE": [["urban",{"maxspeed":"50"}],["business district",{"maxspeed":"60"}],["",{"maxspeed":"100","maxspeed:conditional":"90 @ (sunset-sunrise)"}],["rural",{"maxspeed":"100","maxspeed:conditional":"90 @ (sunset-sunrise)"}],["rural school zone",{"maxspeed":"100","maxspeed:conditional":"60 @ (Sep-Jun Mo-Fr 08:00-16:00)"}],["rural road without asphalt or concrete surface",{"maxspeed":"80"}]],
        "CA-QC": [["pedestrian zone",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["school zone",{"maxspeed":"90","maxspeed:conditional":"50 @ (Sep-Jun Mo-Fr 08:00-16:00)"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}],["rural road without asphalt or concrete surface",{"maxspeed":"70"}],["Quebec: Autoroute",{"maxspeed":"100"}]],
        "CA-SK": [["",{"maxspeed":"80"}]],
        "CA-YT": [["urban playground zone",{"maxspeed":"30"}],["rural playground zone",{"maxspeed":"40"}],["urban school zone",{"maxspeed":"50","maxspeed:conditional":"30 @ (Mo-Fr 08:00-16:30)"}],["rural school zone",{"maxspeed":"50","maxspeed:conditional":"40 @ (Mo-Fr 08:00-16:30)"}],["",{"maxspeed":"50"}]],
        "CD": [["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"75"}],["rural",{"maxspeed":"90","maxspeed:bus":"75"}],["dual carriageway with 2 or more lanes in each direction",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>7.5)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"90 @ (weightrating>7.5)"}]],
        "CF": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}]],
        "CG": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}]],
        "CH": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated)"}],["",{"maxspeed":"80","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated)"}],["rural",{"maxspeed":"80","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"80 @ (trailer); 80 @ (articulated)"}]],
        "CI": [["urban",{"maxspeed":"70","maxspeed:bus":"50","maxspeed:hgv":"50"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>16)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>16)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>16)"}]],
        "CL": [["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (weightrating>3.86)"}],["rural",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (weightrating>3.86)"}],["rural road with 2 or more lanes in each direction",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:coach":"100","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (weightrating>3.86)"}]],
        "CM": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12); 60 @ (trailerweight>0.75)"}]],
        "CN": [["urban and without centerline",{"maxspeed":"30"}],["without centerline",{"maxspeed":"40"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"70"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:goods":"100"}]],
        "CO": [["residential district",{"maxspeed":"30"}],["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:goods":"80"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:goods":"80"}],["motorway",{"maxspeed":"120","maxspeed:bus":"80","maxspeed:goods":"80"}]],
        "CR": [["roundabout",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}]],
        "CU": [["service road",{"maxspeed":"20"}],["urban school zone",{"maxspeed":"40"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)"}],["rural school zone",{"maxspeed":"60","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)"}],["rural unpaved road",{"maxspeed":"60","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)"}],["motorway",{"maxspeed":"100","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"80 @ (trailer)"}]],
        "CV": [["urban",{"maxspeed":"50","maxspeed:hgv":"50","maxspeed:hgv:conditional":"40 @ (trailer)"}],["",{"maxspeed":"90","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:conditional":"90 @ (weightrating>3.5); 90 @ (weightrating>3.5 AND trailer); 80 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:conditional":"100 @ (weightrating>3.5); 100 @ (trailer); 90 @ (weightrating>3.5 AND trailer)","maxspeed:goods":"110","maxspeed:goods:conditional":"90 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (trailer)"}]],
        "CW": [["urban",{"maxspeed":"40"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}],["motorroad",{"maxspeed":"80"}]],
        "CY": [["urban",{"maxspeed":"50","maxspeed:hgv":"50"}],["",{"maxspeed":"80","maxspeed:hgv":"64"}],["rural",{"maxspeed":"80","maxspeed:hgv":"64"}],["motorway",{"maxspeed":"100","maxspeed:hgv":"80"}]],
        "CZ": [["living street",{"maxspeed":"20"}],["pedestrian zone",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban motorroad",{"maxspeed":"80"}],["urban motorway",{"maxspeed":"80"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:conditional":"80 @ (weightrating>3.5)"}],["rural",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:conditional":"80 @ (weightrating>3.5)"}],["rural motorroad with single carriageway",{"maxspeed":"90","maxspeed:bus":"90"}],["rural motorroad",{"maxspeed":"110","maxspeed:bus":"110","maxspeed:conditional":"80 @ (weightrating>3.5)"}],["rural motorway",{"maxspeed":"130","maxspeed:bus":"130","maxspeed:conditional":"80 @ (weightrating>3.5)"}]],
        "DE": [["living street",{"maxspeed":"walk"}],["pedestrian zone",{"maxspeed":"walk"}],["footway",{"maxspeed":"walk"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"60 @ (weightrating>7.5); 60 @ (trailer)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5); 60 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"60 @ (weightrating>7.5)"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"60 @ (weightrating>7.5); 60 @ (trailer)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5); 60 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"60 @ (weightrating>7.5)"}],["rural dual carriageway",{"maxspeed:advisory":"130","maxspeed:bus":"80","maxspeed:bus:conditional":"60 @ (weightrating>7.5); 60 @ (trailer)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5); 60 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"60 @ (weightrating>7.5)"}],["rural road with 2 or more lanes in each direction",{"maxspeed:advisory":"130","maxspeed:bus":"80","maxspeed:bus:conditional":"60 @ (weightrating>7.5); 60 @ (trailer)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5); 60 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"60 @ (weightrating>7.5)"}],["motorway",{"maxspeed:advisory":"130","maxspeed:bus":"80","maxspeed:bus:conditional":"60 @ (trailer)","maxspeed:coach":"100","maxspeed:coach:conditional":"60 @ (trailer)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"60 @ (trailers>=2)"}]],
        "DK": [["living street",{"maxspeed":"15"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["motorroad",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"130","maxspeed:bus":"130","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:coach":"100","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)","maxspeed:hgv":"80"}]],
        "DO": [["school zone",{"maxspeed":"35","maxspeed:conditional":"25 @ (06:00-18:00)"}],["urban",{"maxspeed":"35"}],["",{"maxspeed":"60","maxspeed:bus":"50","maxspeed:conditional":"50 @ (weightcapacity>2); 50 @ (emptyweight>2)"}],["rural",{"maxspeed":"60","maxspeed:bus":"50","maxspeed:conditional":"50 @ (weightcapacity>2); 50 @ (emptyweight>2)"}]],
        "EC": [["school zone",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:bus":"40"}],["Ecuador: Via perimetral",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:hgv":"70","maxspeed:hgv:conditional":"50 @ (trailer)"}],["",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:hgv":"70","maxspeed:hgv:conditional":"50 @ (trailer)"}],["rural",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:hgv":"70","maxspeed:hgv:conditional":"50 @ (trailer)"}]],
        "EE": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:conditional":"50 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:conditional":"50 @ (trailer)"}]],
        "EG": [["residential district",{"maxspeed":"40"}],["business district",{"maxspeed":"40"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"60 @ (articulated); 60 @ (trailer)","maxspeed:goods":"70"}],["Egypt: \"الطرق السريعة أو الرئيسية التى تربط المحافظات ، والتى تتبع المحليات أو الهيئة العامة للطرق والكبارى\"",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"60 @ (articulated); 60 @ (trailer)","maxspeed:goods":"70"}],["Egypt: \"الطرق الصحراوية\"",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:conditional":"70 @ (articulated); 70 @ (trailer)","maxspeed:goods":"80"}]],
        "ES": [["living street",{"maxspeed":"10"}],["urban road without sidewalk",{"maxspeed":"20"}],["unpaved road",{"maxspeed":"30"}],["urban motorway",{"maxspeed":"80"}],["urban road with 2 or more lanes in each direction",{"maxspeed":"50"}],["Spain: Travesía",{"maxspeed":"50"}],["urban",{"maxspeed":"30"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (trailer); 80 @ (articulated)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (trailer); 80 @ (articulated)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"120","maxspeed:bus":"80","maxspeed:conditional":"90 @ (trailer); 90 @ (articulated)","maxspeed:hgv":"90"}]],
        "FI": [["living street",{"maxspeed":"20"}],["pedestrian zone",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:coach:conditional":"80 @ (trailer)","maxspeed:conditional":"100 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:hgv":"80"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:coach:conditional":"80 @ (trailer)","maxspeed:conditional":"100 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:coach:conditional":"80 @ (trailer)","maxspeed:conditional":"100 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:hgv":"80"}]],
        "FJ": [["urban",{"maxspeed":"50","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer); 50 @ (trailerweight>2.035)","maxspeed:goods:conditional":"60 @ (weight>2.035); 50 @ (weight>2.035 AND trailer); 60 @ (weight>2.035 AND trailerweight>2.035); 40 @ (weight>3.050 AND trailer); 60 @ (weight>3.050 AND trailerweight>1.525); 25 @ (trailers>=2)"}],["",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer); 50 @ (trailerweight>2.035)","maxspeed:goods:conditional":"60 @ (weight>2.035); 50 @ (weight>2.035 AND trailer); 60 @ (weight>2.035 AND trailerweight>2.035); 40 @ (weight>3.050 AND trailer); 60 @ (weight>3.050 AND trailerweight>1.525); 25 @ (trailers>=2)"}],["rural",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer); 50 @ (trailerweight>2.035)","maxspeed:goods:conditional":"60 @ (weight>2.035); 50 @ (weight>2.035 AND trailer); 60 @ (weight>2.035 AND trailerweight>2.035); 40 @ (weight>3.050 AND trailer); 60 @ (weight>3.050 AND trailerweight>1.525); 25 @ (trailers>=2)"}]],
        "FM": [["",{"maxspeed":"25 mph"}]],
        "FM-KSA": [["school zone",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"20 mph"}],["",{"maxspeed":"25 mph"}],["rural",{"maxspeed":"25 mph"}]],
        "FM-PNI": [["",{"maxspeed":"25 mph"}]],
        "FM-TRK": [["school zone",{"maxspeed":"20 mph","maxspeed:conditional":"15 mph @ (Mo-Fr 08:00-15:30)"}],["urban",{"maxspeed":"20 mph"}],["",{"maxspeed":"25 mph"}],["rural",{"maxspeed":"25 mph"}]],
        "FM-YAP": [["school zone",{"maxspeed":"20 mph","maxspeed:conditional":"15 mph @ (Mo-Fr 08:00-15:30)"}],["urban",{"maxspeed":"20 mph"}],["",{"maxspeed":"25 mph"}],["rural",{"maxspeed":"25 mph"}]],
        "FR": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"70"}],["",{"maxspeed":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (wet); 60 @ (trailer AND weightrating>12); 60 @ (articulated AND weightrating>12)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["rural",{"maxspeed":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (wet); 60 @ (trailer AND weightrating>12); 60 @ (articulated AND weightrating>12)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["rural road with 2 or more lanes in each direction",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (wet); 60 @ (trailer AND weightrating>12); 60 @ (articulated AND weightrating>12)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["rural dual carriageway",{"maxspeed":"110","maxspeed:bus":"100","maxspeed:bus:conditional":"100 @ (weightrating>3.5); 90 @ (weightrating>10)","maxspeed:conditional":"100 @ (wet); 90 @ (weightrating>3.5); 80 @ (weightrating>12)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"110 @ (weightrating>3.5); 90 @ (weightrating>10)","maxspeed:coach":"100","maxspeed:conditional":"110 @ (wet); 90 @ (weightrating>3.5)","maxspeed:hgv":"90"}]],
        "GA": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}]],
        "GB": [["United Kingdom: restricted road",{"maxspeed":"30 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph"}],["",{"maxspeed":"60 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph"}],["rural",{"maxspeed":"60 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph"}],["dual carriageway",{"maxspeed":"70 mph","maxspeed:bus":"60 mph","maxspeed:conditional":"60 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"60 mph"}],["motorway",{"maxspeed":"70 mph","maxspeed:bus":"70 mph","maxspeed:bus:conditional":"60 mph @ (length>12)","maxspeed:conditional":"60 mph @ (trailer); 40 mph @ (trailers>=2)","maxspeed:hgv":"70 mph","maxspeed:hgv:conditional":"60 mph @ (weightrating>7.5); 60 mph @ (articulated)"}]],
        "GB-SCT": [["United Kingdom: restricted road",{"maxspeed":"30 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}],["",{"maxspeed":"60 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}],["rural",{"maxspeed":"60 mph","maxspeed:bus":"50 mph","maxspeed:conditional":"50 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}],["dual carriageway",{"maxspeed":"70 mph","maxspeed:bus":"60 mph","maxspeed:conditional":"60 mph @ (trailer); 20 mph @ (trailers>=2)","maxspeed:hgv":"60 mph","maxspeed:hgv:conditional":"50 mph @ (weightrating>7.5)"}],["motorway",{"maxspeed":"70 mph","maxspeed:bus":"70 mph","maxspeed:bus:conditional":"60 mph @ (length>12)","maxspeed:conditional":"60 mph @ (trailer); 40 mph @ (trailers>=2)","maxspeed:hgv":"70 mph","maxspeed:hgv:conditional":"60 mph @ (weightrating>7.5); 60 mph @ (articulated)"}]],
        "GD": [["urban",{"maxspeed":"20 mph"}],["",{"maxspeed":"40 mph","maxspeed:bus":"35 mph","maxspeed:goods":"35 mph"}],["rural",{"maxspeed":"40 mph","maxspeed:bus":"35 mph","maxspeed:goods":"35 mph"}]],
        "GE": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"60","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 80 @ (trailer); 70 @ (trailerweight>0.75)"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 80 @ (trailer); 70 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 80 @ (trailer); 70 @ (trailerweight>0.75)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer); 70 @ (trailerweight>0.75); 80 @ (weightrating>3.5 AND trailerweight>0.75)"}]],
        "GG": [["",{"maxspeed":"35 mph","maxspeed:conditional":"25 mph @ (articulated); 25 mph @ (emptyweight>2); 20 mph @ (trailer)"}]],
        "GH": [["pedestrian zone",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:hgv":"75","maxspeed:hgv:conditional":"80 @ (empty)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:hgv":"75","maxspeed:hgv:conditional":"80 @ (empty)"}],["motorway",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:hgv":"75","maxspeed:hgv:conditional":"80 @ (empty)"}]],
        "GQ": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}]],
        "GR": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"30"}],["urban road with 2 or more lanes in each direction",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (articulated); 70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (articulated); 70 @ (trailer)"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"90 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:goods":"90","maxspeed:goods:conditional":"85 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (articulated); 70 @ (trailer)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"100 @ (trailer); 90 @ (trailerweight>0.75)","maxspeed:goods":"100","maxspeed:goods:conditional":"85 @ (trailer); 80 @ (trailerweight>0.75)","maxspeed:hgv":"85","maxspeed:hgv:conditional":"80 @ (articulated); 80 @ (trailer)"}]],
        "GT": [["school zone",{"maxspeed":"30","maxspeed:conditional":"20 @ (trailer); 20 @ (weightrating>3.5)"}],["Guatemala: Vía residencial",{"maxspeed":"30","maxspeed:conditional":"20 @ (trailer); 20 @ (weightrating>3.5)"}],["Guatemala: Vía local",{"maxspeed":"40","maxspeed:conditional":"30 @ (trailer); 30 @ (weightrating>3.5)"}],["Guatemala: Camino",{"maxspeed":"40","maxspeed:conditional":"30 @ (trailer); 30 @ (weightrating>3.5)"}],["Guatemala: Arteria secundaria",{"maxspeed":"50","maxspeed:conditional":"40 @ (trailer); 40 @ (weightrating>3.5)"}],["Guatemala: Arteria principal",{"maxspeed":"60","maxspeed:conditional":"50 @ (trailer); 50 @ (weightrating>3.5)"}],["Guatemala: Vía rápida urbana",{"maxspeed":"80","maxspeed:conditional":"70 @ (trailer); 70 @ (weightrating>3.5)"}],["urban motorway",{"maxspeed":"90","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}],["",{"maxspeed":"60","maxspeed:conditional":"50 @ (trailer); 50 @ (weightrating>3.5)"}],["Guatemala: Carretera secundaria",{"maxspeed":"60","maxspeed:conditional":"50 @ (trailer); 50 @ (weightrating>3.5)"}],["Guatemala: Carretera principal",{"maxspeed":"80","maxspeed:conditional":"60 @ (trailer); 60 @ (weightrating>3.5)"}],["Guatemala: Vía rápida",{"maxspeed":"90","maxspeed:conditional":"70 @ (trailer); 70 @ (weightrating>3.5)"}],["rural motorway",{"maxspeed":"100","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}]],
        "GU": [["",{"maxspeed":"45 mph"}]],
        "GY": [["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"40 mph","maxspeed:bus":"40 mph","maxspeed:hgv":"40 mph"}],["rural",{"maxspeed":"40 mph","maxspeed:bus":"40 mph","maxspeed:hgv":"40 mph"}],["Guyana: Timehri Field / Linden Highway",{"maxspeed":"60 mph","maxspeed:bus":"40 mph","maxspeed:conditional":"40 mph @ (emptyweight>1.270)","maxspeed:hgv":"40 mph"}]],
        "HK": [["",{"maxspeed":"50","maxspeed:bus":"70","maxspeed:hgv:conditional":"70 @ (weightrating>5.5)"}]],
        "HR": [["living street",{"maxspeed":"walk"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}],["Croatia:brza cesta",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer); 80 @ (weightrating>3.5)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:conditional":"90 @ (trailer); 90 @ (weightrating>3.5)"}]],
        "HT": [["urban",{"maxspeed":"50"}]],
        "HU": [["pedestrian zone",{"maxspeed":"10"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:bus":"70","maxspeed:hgv":"70"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:hgv":"70"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"80"}]],
        "ID": [["residential district",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["urban motorway",{"maxspeed":"80"}],["rural motorway",{"maxspeed":"100"}]],
        "IE": [["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"80"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"80"}],["Ireland: National road",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)","maxspeed:hgv":"90"}]],
        "IL": [["living street",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["",{"maxspeed":"80","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["rural",{"maxspeed":"80","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["rural dual carriageway",{"maxspeed":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>12)"}]],
        "IM": [["living street",{"maxspeed":"20 mph"}],["urban",{"maxspeed":"30 mph","maxspeed:bus":"40 mph","maxspeed:conditional":"20 mph @ (trailers>=2); 40 mph @ (trailer); 40 mph @ (weightrating>32.52 AND articulated); 20 mph @ (trailers>=2)","maxspeed:goods":"60 mph","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}],["",{"maxspeed":"60 mph","maxspeed:bus":"40 mph","maxspeed:conditional":"40 mph @ (trailer); 40 mph @ (weightrating>32.52 AND articulated); 20 mph @ (trailers>=2)","maxspeed:goods":"60 mph","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}],["rural",{"maxspeed":"60 mph","maxspeed:bus":"40 mph","maxspeed:conditional":"40 mph @ (trailer); 40 mph @ (weightrating>32.52 AND articulated); 20 mph @ (trailers>=2)","maxspeed:goods":"60 mph","maxspeed:hgv":"50 mph","maxspeed:hgv:conditional":"40 mph @ (weightrating>7.5)"}]],
        "IN": [["urban",{"maxspeed":"70","maxspeed:bus":"60","maxspeed:goods":"60"}],["",{"maxspeed":"70","maxspeed:bus":"60","maxspeed:goods":"60"}],["rural",{"maxspeed":"70","maxspeed:bus":"60","maxspeed:goods":"60"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:goods":"80"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:goods":"80"}]],
        "IS": [["pedestrian zone",{"maxspeed":"10"}],["living street",{"maxspeed":"10"}],["parking lot",{"maxspeed":"15"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["rural road with asphalt or concrete surface",{"maxspeed":"90"}]],
        "IT": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus:conditional":"80 @ (weightrating>8); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (weightrating>12)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>12); 70 @ (trailer); 70 @ (articulated)"}],["Italy: Strada extraurbana local",{"maxspeed":"90","maxspeed:bus:conditional":"80 @ (weightrating>8); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (weightrating>12)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>12); 70 @ (trailer); 70 @ (articulated)"}],["Italy: Strada extraurbana secondaria",{"maxspeed":"90","maxspeed:bus:conditional":"80 @ (weightrating>8); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (weightrating>12)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>12); 70 @ (trailer); 70 @ (articulated)"}],["Italy: Strada extraurbana principale",{"maxspeed":"110","maxspeed:bus:conditional":"80 @ (weightrating>8); 70 @ (articulated)","maxspeed:conditional":"90 @ (wet); 80 @ (weightrating>3.5); 70 @ (weightrating>12)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>12); 70 @ (trailer); 70 @ (articulated)"}],["Italy: Autostrada",{"maxspeed":"130","maxspeed:bus:conditional":"100 @ (weightrating>8); 80 @ (articulated)","maxspeed:conditional":"110 @ (wet); 100 @ (weightrating>3.5); 100 @ (weightrating>12)","maxspeed:hgv":"100","maxspeed:hgv:conditional":"80 @ (weightrating>12); 80 @ (trailer); 80 @ (articulated)"}]],
        "JE": [["",{"maxspeed":"40 mph","maxspeed:bus":"30 mph","maxspeed:conditional":"30 mph @ (trailer)","maxspeed:hgv":"30 mph"}]],
        "JP": [["without centerline",{"maxspeed":"30","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (weightrating>8)","maxspeed:hgv":"80"}],["",{"maxspeed":"60","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (weightrating>8)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (weightrating>8)","maxspeed:hgv":"80"}]],
        "KE": [["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"65 @ (trailer)","maxspeed:conditional":"80 @ (articulated); 65 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"65 @ (trailer)"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"65 @ (trailer)","maxspeed:conditional":"80 @ (articulated); 65 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"65 @ (trailer)"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"65 @ (trailer)","maxspeed:conditional":"80 @ (articulated); 65 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"65 @ (trailer)"}],["rural dual carriageway",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:bus:conditional":"65 @ (trailer)","maxspeed:conditional":"80 @ (articulated); 65 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"65 @ (trailer)"}]],
        "KG": [["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:coach":"90","maxspeed:conditional":"90 @ (weightrating>3.5); 70 @ (trailer)"}]],
        "KH": [["urban",{"maxspeed":"60"}],["",{"maxspeed":"100","maxspeed:hgv":"80"}],["rural",{"maxspeed":"100","maxspeed:hgv":"80"}]],
        "KI": [["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"40","maxspeed:conditional":"30 @ (emptyweight>5); 30 @ (trailer)"}],["",{"maxspeed":"60","maxspeed:conditional":"30 @ (emptyweight>5); 30 @ (trailer)"}],["rural",{"maxspeed":"60","maxspeed:conditional":"30 @ (emptyweight>5); 30 @ (trailer)"}]],
        "KN": [["urban",{"maxspeed":"20 mph"}],["",{"maxspeed":"40 mph","maxspeed:bus":"30 mph","maxspeed:goods":"30 mph"}],["rural",{"maxspeed":"40 mph","maxspeed:bus":"30 mph","maxspeed:goods":"30 mph"}]],
        "KR": [["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}],["rural road with 2 or more lanes in each direction",{"maxspeed":"80"}],["motorroad",{"maxspeed":"80"}],["motorway",{"maxspeed":"80"}],["motorroad with 2 lanes in each direction",{"maxspeed":"100"}],["motorway with 2 lanes in each direction",{"maxspeed":"100"}]],
        "KZ": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"110","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"90","maxspeed:hgv":"70"}],["rural",{"maxspeed":"110","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"90","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"140","maxspeed:bus":"90","maxspeed:coach":"110","maxspeed:conditional":"90 @ (trailer)","maxspeed:goods":"110","maxspeed:hgv":"90"}]],
        "LI": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}]],
        "LR": [["school zone",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"45 mph"}],["rural",{"maxspeed":"45 mph"}],["rural residential district",{"maxspeed":"35 mph"}]],
        "LS": [["urban",{"maxspeed":"60","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:conditional":"80 @ (articulated AND weightrating>9)","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["rural",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:conditional":"80 @ (articulated AND weightrating>9)","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:conditional":"80 @ (articulated AND weightrating>9)","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}]],
        "LT": [["living street",{"maxspeed":"20"}],["parking lot",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["rural road without asphalt or concrete surface",{"maxspeed":"70"}],["motorroad",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"110 @ (Nov-Mar); 90 @ (trailer); 90 @ (weightrating>3.5)","maxspeed:hgv":"90"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"110 @ (Nov-Mar); 90 @ (weightrating>3.5); 90 @ (trailer)","maxspeed:hgv":"90"}]],
        "LU": [["pedestrian zone",{"maxspeed":"20"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"75","maxspeed:conditional":"75 @ (weightrating>7.5); 75 @ (trailer); 75 @ (articulated)"}],["rural",{"maxspeed":"90","maxspeed:bus":"75","maxspeed:conditional":"75 @ (weightrating>7.5); 75 @ (trailer); 75 @ (articulated)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"90","maxspeed:bus:conditional":"75 @ (weightrating>12)","maxspeed:conditional":"110 @ (wet); 90 @ (weightrating>7.5); 90 @ (trailer); 90 @ (articulated); 75 @ (weightrating>12)"}]],
        "LV": [["living street",{"maxspeed":"20"}],["parking lot",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv:conditional":"80 @ (weightrating>7.5)"}],["rural",{"maxspeed":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv:conditional":"80 @ (weightrating>7.5)"}],["rural road without asphalt or concrete surface",{"maxspeed":"80"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (Dec-Feb)","maxspeed:conditional":"90 @ (Dec-Feb); 90 @ (trailer)","maxspeed:hgv":"110","maxspeed:hgv:conditional":"90 @ (Dec-Feb); 90 @ (weightrating>7.5)"}]],
        "MA": [["urban",{"maxspeed":"60"}],["",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (weightrating>3.5)","maxspeed:coach":"90","maxspeed:goods":"100","maxspeed:goods:conditional":"90 @ (weightrating>3.5); 80 @ (weightrating>12); 70 @ (weightrating>19)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (weightrating>12); 70 @ (weightrating>19)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"120","maxspeed:bus:conditional":"100 @ (weightrating>3.5)","maxspeed:coach":"100","maxspeed:goods":"120","maxspeed:goods:conditional":"100 @ (weightrating>3.5); 90 @ (weightrating>12); 80 @ (weightrating>19)","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (weightrating>12); 80 @ (weightrating>19)"}]],
        "MC": [["",{"maxspeed":"50"}]],
        "MD": [["pedestrian zone",{"maxspeed":"5"}],["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:coach":"90","maxspeed:conditional":"90 @ (trailer)","maxspeed:hgv":"90"}]],
        "ME": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightrating>7.5)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:goods:conditional":"90 @ (weightrating>3.5); 90 @ (trailer)","maxspeed:hgv:conditional":"90 @ (weightrating>3.5); 90 @ (trailer)"}]],
        "MH": [["school zone",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"25 mph"}],["",{}],["rural",{"maxspeed":"40 mph"}]],
        "MK": [["urban school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["rural school zone",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"100","maxspeed:goods:conditional":"90 @ (weightrating>3.5); 80 @ (weightrating>7.5)"}]],
        "MM": [["urban",{"maxspeed":"30 mph","maxspeed:conditional":"20 mph @ (trailer)"}],["",{"maxspeed":"50 mph"}],["rural",{"maxspeed":"50 mph"}]],
        "MN": [["living street",{"maxspeed":"20"}],["school zone",{"maxspeed":"20"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"80","maxspeed:conditional":"60 @ (trailer)"}],["rural",{"maxspeed":"80","maxspeed:conditional":"60 @ (trailer)"}],["Mongolia: тууш замд",{"maxspeed":"100","maxspeed:conditional":"80 @ (trailer)"}]],
        "MO": [["",{"maxspeed":"60","maxspeed:conditional":"50 @ (trailer); 50 @ (weightrating>3.5); 50 @ (seats>=10)"}]],
        "MS": [["urban",{"maxspeed":"20 mph","maxspeed:bus":"15 mph","maxspeed:goods":"15 mph"}],["",{"maxspeed":"40 mph","maxspeed:bus":"25 mph","maxspeed:goods":"25 mph"}],["rural",{"maxspeed":"40 mph","maxspeed:bus":"25 mph","maxspeed:goods":"25 mph"}]],
        "MT": [["urban",{"maxspeed":"50","maxspeed:bus":"40","maxspeed:goods":"40","maxspeed:goods:conditional":"30 @ (weightrating>3)"}],["",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:goods":"60","maxspeed:goods:conditional":"40 @ (weightrating>3)"}],["rural",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:goods":"60","maxspeed:goods:conditional":"40 @ (weightrating>3)"}]],
        "MU": [["Mauritius: C road",{"maxspeed":"40"}],["",{"maxspeed":"60"}],["Mauritius: B road",{"maxspeed":"60"}],["Mauritius: A road",{"maxspeed":"80","maxspeed:conditional":"60 @ (weightrating>3.5); 60 @ (trailer)","maxspeed:goods":"60"}],["Mauritius: M road",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:conditional":"70 @ (weightrating>3.5); 60 @ (trailer)","maxspeed:goods":"80"}]],
        "MW": [["urban",{"maxspeed":"50","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (seats>=28); 80 @ (articulated)","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["",{"maxspeed":"80","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (seats>=28); 80 @ (articulated)","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["rural",{"maxspeed":"80","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (seats>=28); 80 @ (articulated)","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["Malawi: rural highway",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (seats>=28); 80 @ (articulated)","maxspeed:conditional":"90 @ (trailer)","maxspeed:goods:conditional":"80 @ (weightrating>9)"}]],
        "MX": [["Mexico: zona de hospital, asilo, albergue o casa hogar",{"maxspeed":"20"}],["Mexico: zona o entorno escolar en una vía secundaria o calle terciaria",{"maxspeed":"20"}],["Mexico: zona o entorno escolar",{"maxspeed":"30"}],["Mexico: calle secundaria o calle terciaria",{"maxspeed":"30"}],["Mexico: avenida primaria sin acceso controlado",{"maxspeed":"50"}],["Mexico: carril central de una avenida de acceso controlado",{"maxspeed":"80"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["Mexico: carretera o autopista de jurisdicción federal",{"maxspeed":"110","maxspeed:bus":"110","maxspeed:bus:conditional":"95 @ (seats>=30); 95 @ (wheels>=6)","maxspeed:goods":"80"}]],
        "MZ": [["urban",{"maxspeed":"60"}],["",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"100"}],["rural",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"100"}]],
        "NA": [["urban",{"maxspeed":"60","maxspeed:bus":"100","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["rural",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["rural road with asphalt or concrete surface",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:goods:conditional":"80 @ (weightrating>9)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:goods:conditional":"80 @ (weightrating>9)"}]],
        "NE": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:goods:conditional":"90 @ (weightrating>9)"}],["rural road with asphalt or concrete surface",{"maxspeed":"90","maxspeed:goods:conditional":"90 @ (weightrating>9)"}],["Niger: national road",{"maxspeed":"90","maxspeed:goods:conditional":"90 @ (weightrating>9)"}],["Niger: autoroute",{"maxspeed":"110","maxspeed:goods:conditional":"90 @ (weightrating>9)"}]],
        "NG": [["urban",{"maxspeed":"50","maxspeed:hgv":"45"}],["",{"maxspeed":"80","maxspeed:hgv":"50"}],["rural",{"maxspeed":"80","maxspeed:hgv":"50"}],["motorway",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:hgv":"60"}]],
        "NI": [["urban",{"maxspeed":"45"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}],["Nicaragua: Carretera",{"maxspeed":"100"}]],
        "NL": [["living street",{"maxspeed":"15"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:hgv":"80"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:hgv":"80"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:hgv":"80"}],["rural motorroad",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:conditional":"90 @ (trailer); 80 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"80"}],["rural motorway",{"maxspeed":"130","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:conditional":"90 @ (trailer); 80 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"80"}]],
        "NL-BQ1": [["urban",{"maxspeed":"40"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}]],
        "NL-BQ2": [["urban",{"maxspeed":"20"}],["",{"maxspeed":"40"}],["rural",{"maxspeed":"40"}]],
        "NL-BQ3": [["urban",{"maxspeed":"30"}],["",{"maxspeed":"50"}],["rural",{"maxspeed":"50"}]],
        "NO": [["living street",{"maxspeed":"walk"}],["pedestrian zone",{"maxspeed":"walk"}],["urban",{"maxspeed":"50","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (weightrating>7.5); 80 @ (trailer)","maxspeed:goods:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["",{"maxspeed":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (weightrating>7.5); 80 @ (trailer)","maxspeed:goods:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"80","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:conditional":"80 @ (weightrating>7.5); 80 @ (trailer)","maxspeed:goods:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}],["motorway",{"maxspeed":"110","maxspeed:bus:conditional":"80 @ (weightrating>3.5)","maxspeed:coach":"100","maxspeed:conditional":"80 @ (weightrating>7.5); 80 @ (trailer)","maxspeed:goods:conditional":"80 @ (weightrating>3.5)","maxspeed:hgv":"80"}]],
        "NP": [["urban",{"maxspeed":"40"}],["hilly road",{"maxspeed":"80","maxspeed:bus":"50","maxspeed:goods":"50"}],["",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:goods":"70"}],["rural",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:goods":"70"}]],
        "NR": [["school zone",{"maxspeed":"20"}],["",{"maxspeed":"50"}]],
        "NZ": [["living street",{"maxspeed":"10"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"100","maxspeed:conditional":"90 @ (weightrating>3.5); 90 @ (trailer)"}],["rural",{"maxspeed":"100","maxspeed:conditional":"90 @ (weightrating>3.5); 90 @ (trailer)"}]],
        "PA": [["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"40"}],["Panama: Avenida",{"maxspeed":"60"}],["Panama: Avenida de dos carriles",{"maxspeed":"80"}],["Panama: Carretera multicarril en zona urbana",{"maxspeed":"80"}],["",{"maxspeed":"100"}],["rural",{"maxspeed":"100"}],["motorway",{"maxspeed":"120"}]],
        "PE": [["school zone",{"maxspeed":"30"}],["urban",{"maxspeed":"40"}],["",{"maxspeed":"60"}],["rural",{"maxspeed":"60"}],["Perú: Avenida",{"maxspeed":"60"}],["Perú: Vía Expresa",{"maxspeed":"80"}],["Perú: Carretera",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"80"}]],
        "PG": [["school zone",{"maxspeed":"25"}],["playground zone",{"maxspeed":"25"}],["village",{"maxspeed":"40"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"100"}],["rural",{"maxspeed":"100"}]],
        "PH": [["school zone",{"maxspeed":"20"}],["Philippines: Barangay road",{"maxspeed":"20"}],["urban",{"maxspeed":"30"}],["",{"maxspeed":"40","maxspeed:bus":"30","maxspeed:hgv":"30"}],["Philippines: Provincial road",{"maxspeed":"40","maxspeed:bus":"30","maxspeed:hgv":"30"}],["Philippines: Through street",{"maxspeed":"40","maxspeed:bus":"30","maxspeed:hgv":"30"}],["Philippines: National road",{"maxspeed":"80","maxspeed:bus":"50","maxspeed:hgv":"50"}],["motorway",{"maxspeed":"100"}]],
        "PK": [["urban unpaved road",{"maxspeed":"40","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["urban motorway",{"maxspeed":"110","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["urban road with 4 or more lanes in each direction",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["urban road with 3 lanes in each direction",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["urban road with 2 lanes in each direction",{"maxspeed":"70","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["urban",{"maxspeed":"55","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["",{"maxspeed":"70","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural",{"maxspeed":"70","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural unpaved road",{"maxspeed":"50","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural road with 2 lanes in each direction",{"maxspeed":"80","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural road with 3 lanes in each direction",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural road with 4 or more lanes in each direction",{"maxspeed":"110","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:conditional":"50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}],["rural motorway",{"maxspeed":"130","maxspeed:bus":"70","maxspeed:bus:conditional":"65 @ (seats>=15)","maxspeed:goods":"80","maxspeed:goods:conditional":"50 @ (weightrating>2.268); 25 @ (trailer); 25 @ (weightrating>10.2)"}]],
        "PL": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:conditional":"70 @ (weightrating>3.5); 70 @ (trailer)"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)"}],["motorroad with single carriageway",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)"}],["motorroad with dual carriageway",{"maxspeed":"120","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)"}],["motorway",{"maxspeed":"140","maxspeed:bus":"80","maxspeed:coach":"100","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (trailer)"}]],
        "PN": [["",{"maxspeed":"30 mph"}]],
        "PR": [["urban school zone",{"maxspeed:bus":"15 mph","maxspeed:conditional":"15 mph @ (06:00-19:00)"}],["urban",{"maxspeed":"25 mph","maxspeed:bus":"15 mph","maxspeed:conditional":"15 mph @ (weightrating>10000 lb)"}],["",{"maxspeed":"45 mph","maxspeed:bus":"35 mph","maxspeed:conditional":"35 mph @ (weightrating>10000 lb)"}],["rural",{"maxspeed":"45 mph","maxspeed:bus":"35 mph","maxspeed:conditional":"35 mph @ (weightrating>10000 lb)"}],["rural school zone",{"maxspeed:bus":"15 mph","maxspeed:conditional":"25 mph @ (06:00-19:00); 15 mph @ (weightrating>10000 lb)"}],["motorway",{"maxspeed":"65 mph","maxspeed:bus":"55 mph","maxspeed:conditional":"55 mph @ (weightrating>10000 lb)"}]],
        "PS": [["Palestine: شارعمختل",{"maxspeed":"25"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"80"}],["rural",{"maxspeed":"80"}],["motorway",{"maxspeed":"110","maxspeed:bus:conditional":"100 @ (seats>=12)","maxspeed:goods:conditional":"90 @ (weightrating>12)"}]],
        "PT": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:hgv:conditional":"40 @ (trailer)"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"110","maxspeed:goods:conditional":"90 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (trailer)"}]],
        "PY": [["school zone",{"maxspeed":"20"}],["urban",{"maxspeed":"50","maxspeed:bus":"40","maxspeed:hgv":"40"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:hgv":"90"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:hgv":"90"}]],
        "RO": [["living street",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated); 70 @ (weightrating>7.5); 60 @ (weightrating>7.5 AND trailer); 60 @ (weightrating>7.5 AND articulated)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer); 70 @ (articulated); 70 @ (weightrating>7.5); 60 @ (weightrating>7.5 AND trailer); 60 @ (weightrating>7.5 AND articulated)"}],["Romania: drum național european (E)",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"90 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (trailer)"}],["Romania: drum expres",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"110 @ (trailer)","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (trailer)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"110","maxspeed:bus:conditional":"100 @ (trailer)","maxspeed:conditional":"120 @ (trailer)","maxspeed:hgv":"110","maxspeed:hgv:conditional":"100 @ (trailer); 100 @ (articulated); 90 @ (weightrating>7.5); 80 @ (weightrating>7.5 AND trailer); 80 @ (weightrating>7.5 AND articulated)"}]],
        "RS": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"10"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (articulated)","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (weightrating>7.5); 70 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (articulated)","maxspeed:conditional":"80 @ (caravan)","maxspeed:hgv":"100","maxspeed:hgv:conditional":"90 @ (weightrating>7.5); 90 @ (trailer)"}]],
        "RU": [["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"20"}],["urban",{"maxspeed":"60"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"90","maxspeed:conditional":"70 @ (trailer)","maxspeed:hgv":"70"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:coach":"90","maxspeed:conditional":"90 @ (trailer)","maxspeed:hgv":"90"}]],
        "RW": [["urban",{"maxspeed":"40"}],["",{"maxspeed":"80","maxspeed:goods":"60"}],["rural",{"maxspeed":"80","maxspeed:goods":"60"}]],
        "SA": [["urban",{"maxspeed":"50","maxspeed:hgv":"30"}],["",{"maxspeed":"120","maxspeed:hgv":"70"}],["rural",{"maxspeed":"120","maxspeed:hgv":"70"}]],
        "SD": [["urban",{"maxspeed":"50"}]],
        "SE": [["pedestrian zone",{"maxspeed":"walk"}],["living street",{"maxspeed":"walk"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:bus:conditional":"60 @ (articulated)","maxspeed:coach":"100","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (articulated)"}],["",{"maxspeed":"70","maxspeed:bus:conditional":"60 @ (articulated)","maxspeed:coach":"100","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (articulated)"}],["rural",{"maxspeed":"70","maxspeed:bus:conditional":"60 @ (articulated)","maxspeed:coach":"100","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (articulated)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (articulated)","maxspeed:coach":"100","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (articulated)"}]],
        "SG": [["school zone",{"maxspeed":"40"}],["Singapore: silver zone",{"maxspeed":"40"}],["",{"maxspeed":"50"}]],
        "SH": [["",{"maxspeed":"30 mph"}]],
        "SI": [["living street",{"maxspeed":"10"}],["pedestrian zone",{"maxspeed":"10"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (weightrating>3.5 AND trailer); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (caravan); 70 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (weightrating>3.5 AND trailer); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (caravan); 70 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (weightrating>3.5 AND trailer); 70 @ (articulated)","maxspeed:conditional":"80 @ (weightrating>3.5); 80 @ (caravan); 70 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["trunk",{"maxspeed":"110","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (articulated); 80 @ (trailer)","maxspeed:coach":"100","maxspeed:conditional":"100 @ (trailer); 80 @ (weightrating>3.5); 70 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"90 @ (weightrating>3.5); 80 @ (trailer); 80 @ (weightrating>3.5 AND trailer)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"80","maxspeed:bus:conditional":"80 @ (articulated); 80 @ (trailer)","maxspeed:coach":"100","maxspeed:conditional":"100 @ (trailer); 80 @ (weightrating>3.5); 70 @ (weightrating>3.5 AND trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"90 @ (weightrating>3.5); 80 @ (trailer); 80 @ (weightrating>3.5 AND trailer)"}]],
        "SK": [["school zone",{"maxspeed":"20"}],["pedestrian zone",{"maxspeed":"20"}],["living street",{"maxspeed":"20"}],["cycle street",{"maxspeed":"30"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90"}],["rural",{"maxspeed":"90"}],["motorroad",{"maxspeed":"130","maxspeed:bus:conditional":"10090 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (trailerweight>0.75)","maxspeed:hgv":"90"}],["motorway",{"maxspeed":"130","maxspeed:bus:conditional":"10090 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (trailerweight>0.75)","maxspeed:hgv":"90"}]],
        "SN": [["",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"70 @ (seats>=15)","maxspeed:conditional":"85 @ (trailerweight>0.75)","maxspeed:hgv":"85","maxspeed:hgv:conditional":"75 @ (weightrating>10); 65 @ (weightrating>16); 50 @ (weightrating>22)"}],["Senegal: National road",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"70 @ (seats>=15)","maxspeed:conditional":"85 @ (trailerweight>0.75)","maxspeed:hgv":"85","maxspeed:hgv:conditional":"75 @ (weightrating>10); 65 @ (weightrating>16); 50 @ (weightrating>22)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"70 @ (seats>=15)","maxspeed:conditional":"85 @ (trailerweight>0.75)","maxspeed:hgv":"85","maxspeed:hgv:conditional":"75 @ (weightrating>10); 65 @ (weightrating>16); 50 @ (weightrating>22)"}]],
        "SS": [["urban",{"maxspeed":"45"}]],
        "SV": [["roundabout",{"maxspeed":"30"}],["urban",{"maxspeed":"50","maxspeed:bus":"40","maxspeed:hgv":"40"}],["",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:hgv":"70"}],["rural",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:hgv":"70"}]],
        "TD": [["urban",{"maxspeed":"60","maxspeed:conditional":"40 @ (weightrating>3.5)"}],["",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}],["rural",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)","maxspeed:conditional":"90 @ (weightrating>3.5); 60 @ (weightrating>12.5); 60 @ (trailerweight>0.75)"}]],
        "TH": [["urban",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"45 @ (trailer)","maxspeed:goods:conditional":"60 @ (weight>2.2)"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"55 @ (trailer)","maxspeed:goods:conditional":"80 @ (weight>2.2)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:conditional":"55 @ (trailer)","maxspeed:goods:conditional":"80 @ (weight>2.2)"}],["Thailand: ทํางขนําน",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"45 @ (trailer)","maxspeed:goods:conditional":"60 @ (weight>2.2)"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods:conditional":"90 @ (weight>2.2)"}],["Thailand: ทํางพิเศษ on bridge or in tunnel",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods:conditional":"80 @ (weight>2.2)"}],["Thailand: ทํางพิเศษ not on bridge or in tunnel",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods:conditional":"90 @ (weight>2.2)"}],["Thailand: motorway that is not a ทํางพิเศษ",{"maxspeed":"120","maxspeed:bus":"90","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods:conditional":"90 @ (weight>2.2)"}]],
        "TL": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"70 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorroad",{"maxspeed":"100","maxspeed:bus":"90","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"80 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"110","maxspeed:goods:conditional":"90 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"80 @ (trailer)"}]],
        "TN": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (weightrating>10); 70 @ (weightrating>12); 60 @ (weightrating>19)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (weightrating>12); 60 @ (weightrating>19)"}],["rural",{"maxspeed":"90","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (weightrating>10); 70 @ (weightrating>12); 60 @ (weightrating>19)","maxspeed:conditional":"80 @ (weightrating>3.5); 70 @ (weightrating>12); 60 @ (weightrating>19)"}],["motorway",{"maxspeed":"110","maxspeed:bus":"110","maxspeed:bus:conditional":"100 @ (weightrating>10); 90 @ (weightrating>12); 80 @ (weightrating>19)","maxspeed:conditional":"100 @ (weightrating>3.5); 90 @ (weightrating>12); 80 @ (weightrating>19)"}]],
        "TR": [["urban",{"maxspeed":"50","maxspeed:conditional":"40 @ (trailer)"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:bus:conditional":"70 @ (trailer)","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural dual carriageway",{"maxspeed":"110","maxspeed:bus":"90","maxspeed:bus:conditional":"80 @ (trailer)","maxspeed:conditional":"100 @ (trailer)","maxspeed:goods":"100","maxspeed:goods:conditional":"90 @ (trailer)","maxspeed:hgv":"85","maxspeed:hgv:conditional":"75 @ (trailer)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:bus:conditional":"90 @ (trailer)","maxspeed:conditional":"110 @ (trailer)","maxspeed:goods":"110","maxspeed:goods:conditional":"100 @ (trailer)","maxspeed:hgv":"90","maxspeed:hgv:conditional":"0 @ (trailer)"}]],
        "TT": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"80","maxspeed:bus":"65","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods":"65"}],["rural",{"maxspeed":"80","maxspeed:bus":"65","maxspeed:conditional":"65 @ (trailer)","maxspeed:goods":"65"}]],
        "TV": [["",{"maxspeed":"40"}]],
        "TW": [["without centerline",{"maxspeed":"30"}],["",{"maxspeed":"50"}]],
        "TZ": [["urban",{"maxspeed":"50"}],["",{"maxspeed":"110","maxspeed:conditional":"80 @ (weightrating>3.5)"}],["rural",{"maxspeed":"110","maxspeed:conditional":"80 @ (weightrating>3.5)"}]],
        "UA": [["living street",{"maxspeed":"20"}],["pedestrian zone",{"maxspeed":"20"}],["urban",{"maxspeed":"50"}],["",{"maxspeed":"90","maxspeed:bus:conditional":"90 @ (seats>=18)","maxspeed:conditional":"80 @ (trailer)"}],["rural",{"maxspeed":"90","maxspeed:bus:conditional":"90 @ (seats>=18)","maxspeed:conditional":"80 @ (trailer)"}],["dual carriageway",{"maxspeed":"110","maxspeed:bus:conditional":"90 @ (seats>=18)","maxspeed:conditional":"80 @ (trailer)"}],["motorway",{"maxspeed":"130","maxspeed:bus:conditional":"90 @ (seats>=18)","maxspeed:conditional":"80 @ (trailer)"}]],
        "UG": [["urban",{"maxspeed":"50","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer)","maxspeed:goods":"60"}],["",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer)","maxspeed:goods":"60"}],["rural",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:conditional":"60 @ (trailer)","maxspeed:goods":"60"}],["rural road with asphalt or concrete surface",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods":"80"}]],
        "US": [["",{}]],
        "US-AK": [["alley",{"maxspeed":"15 mph"}],["business district",{"maxspeed":"20 mph"}],["residential district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}]],
        "US-AL": [["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"45 mph"}],["rural",{"maxspeed":"45 mph"}],["rural road without asphalt or concrete surface",{"maxspeed":"35 mph"}],["Alabama: rural highway",{"maxspeed":"55 mph"}],["Alabama: rural highway with 2 or more lanes in each direction",{"maxspeed":"65 mph"}],["US interstate highway",{"maxspeed":"70 mph"}]],
        "US-AR": [["urban",{"maxspeed":"30 mph","maxspeed:hgv:conditional":"50 mph @ (weightcapacity>1.5 st); 30 mph @ (weightrating>64000 lb)"}],["",{"maxspeed":"65 mph","maxspeed:conditional":"55 mph @ (caravan)","maxspeed:hgv:conditional":"50 mph @ (weightcapacity>1.5 st); 30 mph @ (weightrating>64000 lb)"}],["rural",{"maxspeed":"65 mph","maxspeed:conditional":"55 mph @ (caravan)","maxspeed:hgv:conditional":"50 mph @ (weightcapacity>1.5 st); 30 mph @ (weightrating>64000 lb)"}]],
        "US-AZ": [["school zone",{"maxspeed":"15 mph"}],["residential district",{"maxspeed":"25 mph"}],["business district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"65 mph"}],["rural",{"maxspeed":"65 mph"}]],
        "US-CA": [["California: alley",{"maxspeed":"15 mph"}],["school zone",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"25 mph"}],["business district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (trailer)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (trailer)"}],["rural road with 1 lane in each direction",{"maxspeed":"65 mph","maxspeed:bus:conditional":"55 mph @ (articulated); 55 mph @ (agricultural)","maxspeed:conditional":"55 mph @ (trailer)","maxspeed:hgv:conditional":"55 mph @ (articulated)"}]],
        "US-CO": [["business district",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["rural winding mountain road",{"maxspeed":"25 mph"}],["rural open mountain road",{"maxspeed":"40 mph"}],["US interstate highway",{"maxspeed":"65 mph"}],["motorway",{"maxspeed":"65 mph"}],["expressway",{"maxspeed":"65 mph"}]],
        "US-CT": [["",{"maxspeed":"55 mph"}],["motorway",{"maxspeed":"65 mph"}]],
        "US-DC": [["playground zone",{"maxspeed":"15 mph"}],["school zone",{"maxspeed":"15 mph"}],["District of Columbia: alley",{"maxspeed":"15 mph"}],["",{"maxspeed":"20 mph"}]],
        "US-DE": [["school zone",{"maxspeed":"20 mph"}],["residential district",{"maxspeed":"25 mph"}],["business district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"50 mph"}],["rural",{"maxspeed":"50 mph"}],["rural single carriageway with 2 or more lanes in each direction",{"maxspeed":"55 mph"}],["rural dual carriageway",{"maxspeed":"55 mph"}]],
        "US-FL": [["residential district",{"maxspeed":"30 mph"}],["business district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph"}],["motorway",{"maxspeed":"70 mph"}]],
        "US-GA": [["residential district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["rural unpaved road",{"maxspeed":"35 mph"}],["US interstate highway",{}]],
        "US-HI": [["",{}]],
        "US-IA": [["business district",{"maxspeed":"20 mph"}],["school zone",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"25 mph"}],["public park",{"maxspeed":"35 mph"}],["Iowa: suburban district",{"maxspeed":"45 mph"}],["Iowa: Institutional road",{"maxspeed":"45 mph"}],["",{"maxspeed":"60 mph"}],["rural",{"maxspeed":"60 mph"}],["rural road without asphalt or concrete surface",{"maxspeed":"55 mph","maxspeed:conditional":"50 mph @ (sunset-sunrise)"}],["motorway",{"maxspeed":"65 mph"}],["US interstate highway",{"maxspeed":"70 mph"}]],
        "US-ID": [["residential district",{"maxspeed":"35 mph"}],["business district",{"maxspeed":"35 mph"}],["urban",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["Idaho: State highway",{"maxspeed":"65 mph"}],["US interstate highway",{"maxspeed":"75 mph","maxspeed:hgv:conditional":"65 mph @ (axles>=5 AND weightrating>26000 lb)"}]],
        "US-IL": [["alley",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph","maxspeed:bus":"55 mph"}],["rural",{"maxspeed":"55 mph","maxspeed:bus":"55 mph"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph","maxspeed:bus":"65 mph"}],["US interstate highway",{"maxspeed":"70 mph","maxspeed:bus":"70 mph"}]],
        "US-IN": [["alley",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"30 mph","maxspeed:conditional":"55 mph @ (length>85 ft)"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (length>85 ft)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (length>85 ft)"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"60 mph","maxspeed:conditional":"55 mph @ (length>85 ft)"}],["rural US interstate highway",{"maxspeed":"70 mph","maxspeed:bus":"70 mph","maxspeed:conditional":"65 mph @ (weightrating>50000 lb); 55 mph @ (length>85 ft)","maxspeed:hgv:conditional":"65 mph @ (weightrating>50000 lb); 55 mph @ (length>85 ft)"}]],
        "US-KS": [["urban",{"maxspeed":"30 mph","maxspeed:conditional":"55 mph @ (caravan)"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (caravan)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"55 mph @ (caravan)"}],["Kansas: state highway",{"maxspeed":"65 mph","maxspeed:conditional":"55 mph @ (caravan)"}],["dual carriageway",{"maxspeed":"75 mph","maxspeed:conditional":"55 mph @ (caravan)"}]],
        "US-KY": [["parking lot",{"maxspeed":"15 mph"}],["residential district",{"maxspeed":"35 mph"}],["business district",{"maxspeed":"35 mph"}],["urban",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["US interstate highway",{"maxspeed":"65 mph"}]],
        "US-LA": [["",{"maxspeed":"55 mph"}],["dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph"}],["US interstate highway",{"maxspeed":"70 mph"}],["motorway",{"maxspeed":"70 mph"}]],
        "US-MA": [["school zone",{"maxspeed":"20 mph"}],["business district",{"maxspeed":"30 mph"}],["residential district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"40 mph"}],["rural",{"maxspeed":"40 mph"}],["rural dual carriageway",{"maxspeed":"50 mph"}]],
        "US-MD": [["school zone",{"maxspeed":"15 mph"}],["business district",{"maxspeed":"30 mph"}],["single carriageway in residential district",{"maxspeed":"30 mph"}],["dual carriageway in residential district",{"maxspeed":"35 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"50 mph"}],["rural",{"maxspeed":"50 mph"}],["rural dual carriageway",{"maxspeed":"55 mph"}]],
        "US-ME": [["school zone",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"45 mph"}]],
        "US-MI": [["trailer park",{"maxspeed":"15 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}],["business district",{"maxspeed":"25 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}],["residential district",{"maxspeed":"25 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}],["public park",{"maxspeed":"25 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}],["",{"maxspeed":"55 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}],["motorway",{"maxspeed":"70 mph","maxspeed:hgv:conditional":"65 mph @ (weightrating>10000 lb); 65 mph @ (trailer); 65 mph @ (articulated)"}]],
        "US-MN": [["alley",{"maxspeed":"10 mph"}],["school zone",{"maxspeed":"15 mph"}],["urban US interstate highway",{"maxspeed":"65 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["expressway",{"maxspeed":"65 mph"}],["motorway",{"maxspeed":"65 mph"}],["rural US interstate highway",{"maxspeed":"70 mph"}]],
        "US-MO": [["lettered road with 2 lanes",{"maxspeed":"55 mph"}],["urban expressway",{"maxspeed":"60 mph"}],["urban motorway",{"maxspeed":"60 mph"}],["urban US interstate highway",{"maxspeed":"60 mph"}],["",{"maxspeed":"60 mph"}],["rural",{"maxspeed":"60 mph"}],["rural expressway",{"maxspeed":"65 mph"}],["rural motorway",{"maxspeed":"70 mph"}],["rural US interstate highway",{"maxspeed":"70 mph"}]],
        "US-MS": [["",{"maxspeed":"65 mph"}]],
        "US-MT": [["urban",{"maxspeed":"25 mph","maxspeed:hgv":"65 mph"}],["",{"maxspeed":"70 mph","maxspeed:conditional":"65 mph @ ((sunset+01:30)-(sunrise-01:30))","maxspeed:hgv":"65 mph"}],["rural",{"maxspeed":"70 mph","maxspeed:conditional":"65 mph @ ((sunset+01:30)-(sunrise-01:30))","maxspeed:hgv":"65 mph"}],["urban US interstate highway",{"maxspeed":"65 mph","maxspeed:hgv":"65 mph"}],["rural US interstate highway",{"maxspeed":"80 mph","maxspeed:hgv":"70 mph"}]],
        "US-NC": [["urban",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}]],
        "US-ND": [["school zone",{"maxspeed":"20 mph"}],["residential district",{"maxspeed":"25 mph"}],["business district",{"maxspeed":"25 mph"}],["public park",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"70 mph"}],["US interstate highway with 2 or more lanes in each direction",{"maxspeed":"75 mph"}]],
        "US-NE": [["business district",{"maxspeed":"20 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["residential district",{"maxspeed":"25 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["urban",{"maxspeed":"25 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["rural unpaved road",{"maxspeed":"50 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["Nebraska: State highway",{"maxspeed":"65 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["Nebraska: State expressway or super-two highway",{"maxspeed":"70 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["motorway",{"maxspeed":"70 mph","maxspeed:conditional":"50 mph @ (caravan)"}],["US interstate highway",{"maxspeed":"75 mph","maxspeed:conditional":"50 mph @ (caravan)"}]],
        "US-NH": [["urban school zone",{"maxspeed":"20 mph"}],["business district",{"maxspeed":"30 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["urban residential district",{"maxspeed":"30 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["urban",{"maxspeed":"35 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural residential district",{"maxspeed":"35 mph"}],["rural school zone",{"maxspeed":"25 mph"}],["dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["US interstate highway",{"maxspeed":"65 mph","maxspeed:conditional":"45 mph @ (caravan)"}]],
        "US-NJ": [["school zone",{"maxspeed":"20 mph"}],["urban business district",{"maxspeed":"25 mph"}],["urban residential district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["suburban business district",{"maxspeed":"35 mph"}],["suburban residential district",{"maxspeed":"35 mph"}],["",{"maxspeed":"50 mph"}],["rural",{"maxspeed":"50 mph"}]],
        "US-NM": [["school zone",{"maxspeed":"15 mph"}],["residential district",{"maxspeed":"30 mph"}],["business district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}]],
        "US-NV": [["school zone",{"maxspeed":"15 mph"}],["",{"maxspeed":"80 mph"}]],
        "US-NY": [["",{"maxspeed":"55 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>10000 lb)"}]],
        "US-OH": [["alley",{"maxspeed":"15 mph"}],["urban motorway",{"maxspeed":"65 mph"}],["urban expressway without traffic lights",{"maxspeed":"65 mph"}],["Ohio: Urban state route",{"maxspeed":"35 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["public park",{"maxspeed":"35 mph"}],["rural dual carriageway",{"maxspeed":"60 mph"}],["rural expressway",{"maxspeed":"60 mph"}],["rural expressway without traffic lights",{"maxspeed":"65 mph"}],["rural motorway",{"maxspeed":"70 mph"}]],
        "US-OK": [["school zone",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph"}],["county road",{"maxspeed":"55 mph"}],["state park",{"maxspeed":"35 mph"}],["US interstate highway",{}]],
        "US-OR": [["alley",{"maxspeed":"15 mph"}],["school zone",{"maxspeed":"25 mph","maxspeed:conditional":"20 mph @ (07:00-17:00)"}],["business district",{"maxspeed":"20 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}],["residential district",{"maxspeed":"25 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}],["public park",{"maxspeed":"25 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}],["",{"maxspeed":"55 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}],["rural",{"maxspeed":"55 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}],["US interstate highway",{"maxspeed":"65 mph","maxspeed:hgv:conditional":"55 mph @ (weightrating>8000 lb AND articulated); 55 mph @ (weightrating>10000 lb)"}]],
        "US-PA": [["school zone",{"maxspeed":"15 mph"}],["urban road which is not numbered",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}]],
        "US-RI": [["school zone",{"maxspeed":"20 mph"}],["business district",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"50 mph","maxspeed:conditional":"45 mph @ ((sunset+00:30)-(sunrise-00:30))"}],["rural",{"maxspeed":"50 mph","maxspeed:conditional":"45 mph @ ((sunset+00:30)-(sunrise-00:30))"}]],
        "US-SC": [["urban",{"maxspeed":"30 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural",{"maxspeed":"55 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural unpaved road",{"maxspeed":"40 mph"}]],
        "US-SD": [["school zone",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"25 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["",{"maxspeed":"65 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["rural",{"maxspeed":"65 mph","maxspeed:conditional":"45 mph @ (caravan)"}],["US interstate highway",{"maxspeed":"80 mph","maxspeed:conditional":"55 mph @ (caravan)"}]],
        "US-TN": [["school zone",{"maxspeed":"15 mph"}],["",{"maxspeed":"65 mph"}],["rural",{"maxspeed":"65 mph"}],["Tennessee: Rural state road with 2 or more lanes in each direction",{"maxspeed":"70 mph"}],["US interstate highway with 2 or more lanes in each direction",{"maxspeed":"70 mph"}]],
        "US-TX": [["alley",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"60 mph"}],["rural",{"maxspeed":"60 mph"}],["rural numbered road",{"maxspeed":"70 mph"}]],
        "US-UT": [["school zone",{"maxspeed":"20 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}]],
        "US-VA": [["school zone",{"maxspeed":"25 mph"}],["business district",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["rural unpaved road",{"maxspeed":"35 mph"}],["Virginia: Rustic road",{"maxspeed":"35 mph"}],["Virginia: State primary highway",{"maxspeed":"55 mph"}],["rural road with 2 or more lanes in each direction",{"maxspeed":"55 mph"}],["motorway",{"maxspeed":"55 mph"}],["US interstate highway",{"maxspeed":"55 mph"}]],
        "US-VT": [["",{"maxspeed":"50 mph"}]],
        "US-WA": [["school zone",{"maxspeed":"20 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"50 mph"}],["rural",{"maxspeed":"50 mph"}],["Washington: State highway",{"maxspeed":"60 mph","maxspeed:conditional":"60 mph @ (weightrating>10000 lb); 60 mph @ (trailer); 60 mph @ (articulated)"}]],
        "US-WI": [["school zone",{"maxspeed":"15 mph"}],["alley",{"maxspeed":"15 mph"}],["urban",{"maxspeed":"25 mph"}],["Wisconsin: semiurban or outlying district",{"maxspeed":"35 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}],["Wisconsin: Rustic road",{"maxspeed":"40 mph"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"65 mph"}],["motorway",{"maxspeed":"70 mph"}]],
        "US-WV": [["school zone",{"maxspeed":"15 mph"}],["business district",{"maxspeed":"25 mph"}],["residential district",{"maxspeed":"25 mph"}],["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"55 mph"}],["rural",{"maxspeed":"55 mph"}]],
        "US-WY": [["school zone",{"maxspeed":"20 mph"}],["residential district",{"maxspeed":"30 mph"}],["urban",{"maxspeed":"30 mph"}],["",{"maxspeed":"65 mph"}],["rural",{"maxspeed":"65 mph"}],["rural road without asphalt or concrete surface",{"maxspeed":"55 mph"}],["Wyoming: State highway",{"maxspeed":"70 mph"}],["US interstate highway",{"maxspeed":"75 mph"}]],
        "UY": [["school zone",{"maxspeed":"20"}],["urban",{"maxspeed":"45"}],["",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:coach":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80"}],["rural",{"maxspeed":"90","maxspeed:bus":"80","maxspeed:coach":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:hgv":"80"}]],
        "UZ": [["urban residential district",{"maxspeed":"30"}],["urban",{"maxspeed":"70"}],["",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:coach":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}],["rural",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:coach":"90","maxspeed:conditional":"80 @ (trailer)","maxspeed:goods:conditional":"70 @ (trailer)","maxspeed:hgv":"80","maxspeed:hgv:conditional":"70 @ (trailer)"}]],
        "VE": [["urban",{"maxspeed":"40"}],["",{"maxspeed":"70","maxspeed:conditional":"50 @ (sunset-sunrise)"}],["rural",{"maxspeed":"70","maxspeed:conditional":"50 @ (sunset-sunrise)"}],["motorway",{"maxspeed":"90"}]],
        "VI": [["urban",{"maxspeed":"20 mph","maxspeed:bus":"10 mph","maxspeed:hgv":"10 mph"}],["",{"maxspeed":"35 mph","maxspeed:bus":"30 mph","maxspeed:hgv":"30 mph"}],["rural",{"maxspeed":"35 mph","maxspeed:bus":"30 mph","maxspeed:hgv":"30 mph"}]],
        "VN": [["urban single carriageway",{"maxspeed":"50"}],["urban one-way road with 1 lane",{"maxspeed":"50"}],["urban dual carriageway with 2 or more lanes in each direction",{"maxspeed":"60"}],["",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:coach":"70","maxspeed:conditional":"70 @ (seats>=31); 50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightcapacity>3.5); 60 @ (trailer)"}],["rural single carriageway",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:coach":"70","maxspeed:conditional":"70 @ (seats>=31); 50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightcapacity>3.5); 60 @ (trailer)"}],["rural single carriageway",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:coach":"70","maxspeed:conditional":"70 @ (seats>=31); 50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightcapacity>3.5); 60 @ (trailer)"}],["rural one-way road with 1 lane",{"maxspeed":"80","maxspeed:bus":"60","maxspeed:coach":"70","maxspeed:conditional":"70 @ (seats>=31); 50 @ (trailer)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (weightcapacity>3.5); 60 @ (trailer)"}],["rural dual carriageway with 2 or more lanes in each direction",{"maxspeed":"90","maxspeed:bus":"70","maxspeed:coach":"80","maxspeed:conditional":"80 @ (seats>=31); 60 @ (trailer)","maxspeed:goods":"90","maxspeed:goods:conditional":"80 @ (weightcapacity>3.5); 70 @ (trailer)"}],["motorway",{"maxspeed":"120"}]],
        "WS": [["urban",{"maxspeed":"25 mph"}],["",{"maxspeed":"35 mph"}],["rural",{"maxspeed":"35 mph"}]],
        "XK": [["urban school zone",{"maxspeed:conditional":"30 @ (07:00-20:00)"}],["urban",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["rural",{"maxspeed":"80","maxspeed:bus":"80","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["rural school zone",{"maxspeed":"50","maxspeed:bus":"80","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["rural dual carriageway",{"maxspeed":"100","maxspeed:bus":"80","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"80","maxspeed:goods:conditional":"70 @ (trailer); 70 @ (weightrating>7.5)"}],["motorroad",{"maxspeed":"110","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (weightrating>12)","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"85","maxspeed:goods:conditional":"80 @ (trailer); 70 @ (weightrating>12)"}],["motorway",{"maxspeed":"130","maxspeed:bus":"100","maxspeed:bus:conditional":"80 @ (weightrating>12)","maxspeed:conditional":"80 @ (caravan)","maxspeed:goods":"85","maxspeed:goods:conditional":"80 @ (trailer); 70 @ (weightrating>12)"}]],
        "ZA": [["urban",{"maxspeed":"60","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["rural",{"maxspeed":"100","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}],["motorway",{"maxspeed":"120","maxspeed:bus":"100","maxspeed:hgv:conditional":"80 @ (weightrating>9)"}]],
        "ZM": [["urban",{"maxspeed":"40"}],["",{"maxspeed":"100","maxspeed:hgv":"80"}],["rural",{"maxspeed":"100","maxspeed:hgv":"80"}]],
      },
    };
  }
  // END GENERATED DEFAULT SPEEDS
})();
