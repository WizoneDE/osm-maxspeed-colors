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
  // Generated data (generated/*.js)
  // ===========================================================================
  // The official sign artwork and the legal default speeds are written by the
  // scripts in dev/ into files of their own, so this one stays readable. The
  // manifest runs those files right before this one, at document_start and so
  // before any script of the page. They leave the data on a global, which is taken
  // here and removed at once.

  /** @typedef {{ width: number, height: number, svg: string }} SignArt  Inner SVG markup and viewBox size. */
  /** @typedef {{ signArt: Record<string, SignArt>, defaultSpeeds: DefaultSpeedTable }} GeneratedData */

  const globals = /** @type {typeof globalThis & { __osmMaxspeedColorsData?: GeneratedData }} */ (globalThis);
  const GENERATED = globals.__osmMaxspeedColorsData;
  delete globals.__osmMaxspeedColorsData;
  if (!GENERATED?.signArt || !GENERATED.defaultSpeeds) {
    throw new Error('OSM Maxspeed Colors: generated/signs.js or generated/default-speeds.js not loaded');
  }

  /** Official signs (dev/signs/*.svg). Keys are German sign numbers, others start with the country code. */
  const SIGN_ART = GENERATED.signArt;

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
      defaultBecause: (/** @type {string[]} */ tags) => `erkannt an: ${tags.join(', ')}`,
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
      defaultBecause: (/** @type {string[]} */ tags) => `recognised by: ${tags.join(', ')}`,
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
   * @param {string} source
   */
  function splitConditional(source) {
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of source) {
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
   * @property {Tags} [roadTags]      Tags of the way, to name in the tooltip what made it this road type.
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
            info.fallback = { info: def, country: road.country, roadType: road.roadType, roadTags: tags };
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
              fallback: { info: def, country: road.country, roadType: road.roadType, roadTags: tags, above: info.source.split('\n')[0] },
            };
          }
        }
      }
    }
    return { oneway, ...speeds, restricted: isAccessRestricted(tags) };
  }

  // ===========================================================================
  // Legal default speed limits (table in generated/default-speeds.js)
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

  const defaultSpeeds = () => GENERATED.defaultSpeeds;

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
   * @param {string} source
   * @returns {TagFilter}
   */
  function compileTagFilter(source) {
    let pos = 0;
    const OPERATORS = ['>=', '<=', '!=', '!~', '>', '<', '=', '~'];
    /** @param {string} message @returns {never} */
    const fail = (message) => { throw new Error(`${message} at ${pos} in: ${source}`); };
    const spaces = () => { while (pos < source.length && /\s/.test(source[pos])) pos++; };
    /** @param {string} s */
    const isNext = (s) => source.startsWith(s, pos);
    /** A word, ending at a space or ")" – a key also at an operator. @param {boolean} isKey */
    const word = (isKey) => {
      const quote = source[pos];
      if (quote === '"' || quote === "'") {
        let end = pos + 1;
        while (end < source.length && (source[end] !== quote || source[end - 1] === '\\')) end++;
        if (end >= source.length) fail('open quotation mark');
        const s = source.slice(pos + 1, end).replace(/\\(['"])/g, '$1');
        pos = end + 1;
        return s;
      }
      let end = pos;
      while (end < source.length && !/[\s)]/.test(source[end]) && !(isKey && /[=~<>!]/.test(source[end]))) end++;
      if (end === pos) fail('missing key or value');
      const s = source.slice(pos, end);
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
      if (!isNext(keyword) || !/[\s(]/.test(source[pos + keyword.length] || '')) return false;
      pos += keyword.length;
      return true;
    };
    const closing = () => { spaces(); if (source[pos] !== ')') fail('missing )'); pos++; };
    /** @returns {TagFilter} */
    const unary = () => {
      spaces();
      if (/^!\s*\(/.test(source.slice(pos, pos + 20))) {
        pos = source.indexOf('(', pos) + 1;
        const inner = or();
        closing();
        return (t, p) => !inner(t, p);
      }
      if (isNext('(')) { pos++; const inner = or(); closing(); return inner; }
      const negated = isNext('!{');
      if (negated || isNext('{')) {
        pos += negated ? 2 : 1;
        const end = source.indexOf('}', pos);
        if (end < 0) fail('missing }');
        const name = source.slice(pos, end);
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
    if (pos < source.length) fail('unexpected text');
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
    if (!filter) return false;
    let own = tags;
    if (PER_DIRECTION_TYPE.test(name)) {
      const oneway = isRoadType('oneway', tags, depth + 1);
      const each = lanesEachWay(tags, oneway);
      if (each !== null) own = { ...tags, lanes: String(oneway ? each : 2 * each) };
    }
    return filter(own, (other) => isRoadType(other, own, depth + 1));
  }

  // Road types "… with 2 or more lanes in each direction" (and "one-way road with
  // 1 lane") mean lanes per direction, but their filters only see the total:
  // lanes>=4 on a two-way road stands for 2 + 2. Where the tags say more, those
  // filters see the lanes that go straight on, in the direction with fewer of them
  // (German law: two lanes "für jede Richtung", StVO § 3 (3) 2c). A turn lane does
  // not run along the road. 2026-10-26: the B 255 with 3 + 1 lanes and one way
  // untagged got 130 instead of 100 there.
  const PER_DIRECTION_TYPE = /\blanes? in each direction$|\bone-way road with \d+ lanes?$/;

  /** Lanes of a turn:lanes value that go straight on ("", none or through). @param {string} value */
  const throughLanes = (value) => value.split('|').filter((lane) => {
    const turns = lane.split(';').map((t) => t.trim());
    return turns.includes('through') || turns.every((t) => t === '' || t === 'none');
  }).length;

  /**
   * Lanes that go straight on in the direction with fewer of them, from
   * turn:lanes(:forward/:backward), else lanes:forward/:backward; null where the
   * tags do not say more than `lanes`.
   * @param {Tags} tags
   * @param {boolean} oneway  As the table's {oneway} sees it.
   * @returns {number | null}
   */
  function lanesEachWay(tags, oneway) {
    if (oneway) return tags['turn:lanes'] ? throughLanes(tags['turn:lanes']) : null;
    const count = (/** @type {string} */ direction) => {
      const turn = tags[`turn:lanes:${direction}`];
      if (turn) return throughLanes(turn);
      const lanes = tags[`lanes:${direction}`] || '';
      return /^\d+$/.test(lanes) ? Number(lanes) : null;
    };
    const forward = count('forward');
    const backward = count('backward');
    return forward === null || backward === null ? null : Math.min(forward, backward);
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

  /** Lane tags, read together by the road types (see PER_DIRECTION_TYPE). */
  const LANE_KEY = /^(?:turn:)?lanes(?::forward|:backward)?$/;

  /**
   * The tags that make a way this road type, for the tooltip: each tag is left out
   * in turn and kept only where the type no longer matches without it. The lane
   * tags count as one, as the filters read them together.
   * @param {string} name  Road type; "" (other roads) has no tags of its own.
   * @param {Tags} tags
   * @returns {string[]}  e.g. ["zone:traffic=DE:rural", "lanes=4"]
   */
  function roadTypeReasons(name, tags) {
    let kept = withZoneTraffic(tags);
    if (!name || !isRoadType(name, kept)) return [];
    const groupOf = (/** @type {string} */ key) => (LANE_KEY.test(key) ? 'lanes' : key);
    for (const group of new Set(Object.keys(kept).map(groupOf))) {
      const without = Object.fromEntries(Object.entries(kept).filter(([key]) => groupOf(key) !== group));
      if (isRoadType(name, without)) kept = without;
    }
    return Object.entries(kept).map(([key, value]) => `${key}=${value}`);
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
    const because = fallback.roadTags ? roadTypeReasons(fallback.roadType, fallback.roadTags) : [];
    return [
      signTooltip(fallback.info).split('\n')[0],
      fallback.above ? t.aboveDefault(fallback.above) : t.defaultValue,
      t.defaultRoad(country, fallback.roadType),
      ...(because.length ? [t.defaultBecause(because)] : []),
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

  // ---------------------------------------------------------------------------
  // Style of each way line
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Country of a way, for the legal default speed limits
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Colouring the lines and redrawing
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Overlay: stripes and dashes on a background
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Speed-limit signs
  // ---------------------------------------------------------------------------

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

  // Official sign artwork (SIGN_ART, from generated/signs.js) is put into the map
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
      // The artwork comes from generated/signs.js, taken before any page script
      // ran (see "Generated data"), never from the page.
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

  // ---------------------------------------------------------------------------
  // Placing the signs along the lines
  // ---------------------------------------------------------------------------

  /** Boxes of the signs placed in the current redraw, in layer coordinates. @type {Box[]} */
  let placed = [];
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
      const hiddenKinds = new Set(settings.hiddenExtras);
      ensureArt(svg);
      placed = [];
      const signLines = signLinesOf(lines, layerMatrix.inverse());
      const awayFromNeighbour = neighbourFinder(signLines);

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

          for (const { info, side } of style.signs) {
            if (hasSign(info)) drawSign(signs, info, side || away, at, right, hiddenKinds);
          }
        }
      }
    }
    signLayer.replaceChildren(signs);
  }

  /**
   * The lines that get signs and are long enough for them at this zoom level, each
   * with its length and the point at a distance along it, in sign-layer coordinates.
   * @param {SVGPathElement[]} lines
   * @param {DOMMatrix} toLayer  Inverse of the sign layer's matrix.
   */
  function signLinesOf(lines, toLayer) {
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
    return signLines;
  }

  /**
   * Neighbouring lines. A dual carriageway is two one-way ways side by side; a
   * sign on the line itself would run into the other line's signs. So for every
   * sign we look for another signed line running alongside within
   * NEIGHBOUR_DISTANCE and put the sign on the far side, like the two halves of
   * a split way. The lines are sampled coarsely into a grid for the lookup.
   * @param {ReturnType<typeof signLinesOf>} signLines
   */
  function neighbourFinder(signLines) {
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
    return awayFromNeighbour;
  }

  /**
   * The sign of one direction at a point of its line, with its extra signs next to
   * it, unless the space is taken.
   * @param {DocumentFragment} signs  Collects the signs of this redraw.
   * @param {DirectionSpeed} tagged
   * @param {number} side  0 = on the line, +1 / -1 = beside it, to the right / left.
   * @param {{ x: number, y: number }} at
   * @param {{ x: number, y: number }} right  Right-hand normal of the line at `at`.
   * @param {Set<string>} hiddenKinds  Kinds of extra signs switched off in the popup.
   */
  function drawSign(signs, tagged, side, at, right, hiddenKinds) {
    // No value tagged, but a legal default: its sign, in grey.
    const fallback = tagged.status === 'missing' ? tagged.fallback : null;
    const info = fallback ? fallback.info : tagged;
    const main = signUnit({
      label: signLabel(info),
      kind: info.status === 'variable' ? 'variable'
        : (info.lanes ? info.lanes.every((l) => l.advisory) : info.advisory) ? 'advisory' : 'limit',
      symbol: info.symbol,
      panels: mainPanels(info),
      tooltip: fallback ? defaultTooltip(fallback) : signTooltip(info),
      muted: isGreySign(tagged),
    });
    // Beside the line (split way or neighbouring line), the sign moves just
    // far enough along the normal that no part of it reaches the line.
    const outward = side === 0 ? { x: 1, y: 0 } : { x: right.x * side, y: right.y * side };
    const offset = side === 0 ? 0 : reach(main.box, { x: -outward.x, y: -outward.y }) + SIGN_CLEARANCE / 2;
    const x = at.x + outward.x * offset;
    const y = at.y + outward.y * offset;
    if (!isFree(main.box, x, y)) return;
    place(main.box, x, y);
    main.group.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    signs.append(main.group);

    // Extra signs go to the right for a sign on the line, outwards (away from the
    // line) for a sign beside it, so neighbouring signs never run into each other.
    let distance = reach(main.box, outward);
    for (const spec of extraSignSpecs(info, !!fallback, hiddenKinds)) {
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

  /**
   * Extra signs, each with its panels, next to a main sign: the bicycle road sign,
   * the electronic signs (maxspeed:variable) with their reasons, then the
   * conditional limits.
   * @param {DirectionSpeed} info
   * @param {boolean} isDefault  The main sign is a legal default; its extras are grey too.
   * @param {Set<string>} hiddenKinds
   */
  function extraSignSpecs(info, isDefault, hiddenKinds) {
    /** @type {Array<Parameters<typeof signUnit>[0]>} */
    const specs = [];
    // A bicycle road with a speed other than its 30: sign 244.1 next to the
    // speed or zone sign (with 30, 244.1 is the main sign itself). Shown also
    // with extra signs switched off.
    if (info.bicycleRoad && info.symbol !== '244.1') {
      specs.push({
        label: '',
        kind: 'limit',
        symbol: '244.1',
        panels: [],
        tooltip: `${text().symbols['244.1']}\n${info.bicycleRoad}`,
      });
    }
    if (settings.extras && info.status === 'limit' && info.variable) {
      const reasons = info.variableReasons.map((r) => PANEL_TEXT[LANG].reasons[/** @type {'weather'} */ (r)] || r);
      specs.push({
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
      specs.push({
        label: String(shown(extra.kmh)),
        kind: 'limit',
        panels: conditionPanels(extra),
        radius: EXTRA_SIGN_RADIUS,
        tooltip: `${shown(extra.kmh)} ${unitLabel()} ${extra.label}${extra.raw !== extra.label ? `\n${extra.raw}` : ''}${isDefault || extra.fromDefault ? `\n${text().defaultValue}` : ''}`,
        // Conditional limits are tagged as numbers; grey only if they come from the table.
        muted: isDefault || !!extra.fromDefault,
      });
    }
    return specs;
  }

  // ---------------------------------------------------------------------------
  // Tooltip for the signs
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Legend (display only – the controls are in the toolbar popup)
  // ---------------------------------------------------------------------------

  /** @type {HTMLDivElement | null} */
  let legend = null;

  // Position and folded state of the legend are remembered per site.
  const LEGEND_STORE = 'osm-maxspeed-colors';
  /** @type {{ pos: { x: number, y: number } | null, collapsed: boolean }} */
  const legendState = { pos: null, collapsed: false };
  function loadLegendState() {
    try {
      const saved = JSON.parse(localStorage.getItem(LEGEND_STORE) || '{}');
      if (saved && Number.isFinite(saved.pos?.x) && Number.isFinite(saved.pos?.y)) legendState.pos = { x: saved.pos.x, y: saved.pos.y };
      legendState.collapsed = saved?.collapsed === true;
    } catch { /* unreadable – keep the defaults */ }
  }
  const saveLegendState = () => {
    try { localStorage.setItem(LEGEND_STORE, JSON.stringify(legendState)); } catch { /* storage full or blocked */ }
  };

  /** Puts the legend back inside the window (after a resize); set by makeLegendDraggable. */
  let keepLegendInWindow = () => {};

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

    const { header, handle, fold } = legendHeader();
    const body = document.createElement('div');
    body.style.marginTop = '4px';
    addLegendSettings(body);
    addLegendLines(body);
    addLegendExtras(body);
    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:.8;font-size:11px;margin-top:4px;max-width:220px';
    hint.textContent = text().hint;
    body.append(hint);
    makeLegendFoldable(body, fold);

    box.append(header, body);
    document.body.append(box);
    makeLegendDraggable(box, handle);
  }

  /** Header: title (drag handle) and fold button. */
  function legendHeader() {
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
    return { header, handle, fold };
  }

  /** "Label: value" line at the top. @param {HTMLElement} body @param {string} label @param {string} value */
  function addLegendInfo(body, label, value) {
    const line = document.createElement('div');
    const name = document.createElement('span');
    name.style.opacity = '.75';
    name.textContent = `${label}: `;
    line.append(name, value);
    body.append(line);
  }

  /** Section heading with a thin line above. @param {HTMLElement} body @param {string} title */
  function addLegendHeading(body, title) {
    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;margin-top:6px;padding-top:4px;margin-bottom:2px;border-top:1px solid rgba(255,255,255,.25)';
    heading.textContent = title;
    body.append(heading);
  }

  /**
   * Row with a line sample and a label. The sample is a span whose CSS draws
   * the line (border-top), with `background` showing in the gaps of dashes.
   * @param {HTMLElement} parent
   * @param {string} swatchCss
   * @param {string} label
   */
  function addLegendSwatch(parent, swatchCss, label) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const swatch = document.createElement('span');
    // Light outline so dark colours stay visible on the dark legend.
    swatch.style.cssText = `width:22px;flex:none;outline:1px solid rgba(255,255,255,.55);outline-offset:1px;${swatchCss}`;
    row.append(swatch, label);
    parent.append(row);
  }

  /**
   * @param {HTMLElement} parent
   * @param {string} color
   * @param {string} label
   * @param {'solid'|'dashed'|'dotted'} lineType
   * @param {string} [background]  Colour in the gaps, e.g. white under red dashes.
   */
  const addLegendLine = (parent, color, label, lineType, background = 'transparent') =>
    addLegendSwatch(parent, `height:0;border-top:5px ${lineType} ${color};background:${background}`, label);

  /** Two-column grid, used for the speed bands and the extra signs. @param {HTMLElement} body */
  function addLegendGrid(body) {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:auto auto;column-gap:10px';
    body.append(grid);
    return grid;
  }

  /** Vehicle, weight class and unit from the popup. @param {HTMLElement} body */
  function addLegendSettings(body) {
    const vehicle = vehicles.find(([key]) => key === settings.vehicle);
    addLegendInfo(body, text().vehicleHeading, vehicle ? `${vehicle[2]} ${LANG === 'en' ? vehicle[4] : vehicle[3]}` : settings.vehicle);
    const hgvClass = settings.vehicle === 'hgv' ? hgvClasses.find(([key]) => key === settings.hgvClass) : undefined;
    if (hgvClass) addLegendInfo(body, text().hgvClassHeading, LANG === 'en' ? hgvClass[4] : hgvClass[3]);
    addLegendInfo(body, text().unitHeading, unitLabel());
  }

  /** Speed colours and the other kinds of line. @param {HTMLElement} body */
  function addLegendLines(body) {
    addLegendHeading(body, text().speedsHeading);
    const bands = addLegendGrid(body);
    for (const band of colorBands()) addLegendLine(bands, band.color, bandLabel(band), 'solid');

    addLegendHeading(body, text().distinctionsHeading);
    addLegendLine(body, COLOR_ADVISORY, text().advisoryOnly, 'dotted', KMH_BANDS[KMH_BANDS.length - 1].color);
    addLegendLine(body, '#ccc', text().conditionalOnly, 'dashed');
    // Split way: two colours on top of each other, like the two halves on the map.
    addLegendSwatch(body, `height:0;border-top:3px solid ${KMH_BANDS[9].color};border-bottom:3px solid ${KMH_BANDS[4].color}`, text().split);
    // Lanes: three thin stripes.
    addLegendSwatch(body, `height:6px;background:linear-gradient(${KMH_BANDS[9].color} 0 33%,${KMH_BANDS[7].color} 33% 67%,${KMH_BANDS[5].color} 67%)`, text().lanes);
    addLegendLine(body, COLOR_VARIABLE, text().variable, 'dashed', UNDER_VARIABLE);
    addLegendLine(body, COLOR_MISSING, text().missing, 'dashed', UNDER_MISSING);
    addLegendLine(body, COLOR_MISSING, text().missingRestricted, 'dashed', UNDER_MISSING_RESTRICTED);
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
    addLegendLine(body, '#ffffff', text().noSpeed, 'dashed');
  }

  /**
   * Kinds of extra signs, only while they are shown on the map, each with a
   * sample of the panel it gets on the map. Kinds switched off in the popup are dimmed.
   * @param {HTMLElement} body
   */
  function addLegendExtras(body) {
    if (!settings.signs || !settings.extras || !extraTypes.length) return;
    addLegendHeading(body, text().extrasHeading);
    const kinds = addLegendGrid(body);
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

  /** Folding only hides the legend body; colouring stays on. @param {HTMLElement} body @param {HTMLButtonElement} fold */
  function makeLegendFoldable(body, fold) {
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
  }

  /** Dragging by the title. The whole box always stays inside the window. @param {HTMLDivElement} box @param {HTMLElement} handle */
  function makeLegendDraggable(box, handle) {
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
      const from = box.getBoundingClientRect();
      const dx = down.clientX - from.left;
      const dy = down.clientY - from.top;
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

  // ---------------------------------------------------------------------------
  // Start, once iD's map exists
  // ---------------------------------------------------------------------------

  function start() {
    loadLegendState();

    onSettingsChanged = () => {
      // Language, unit or vehicle may have changed: rebuild the legend, redraw everything.
      styleByTags = new WeakMap();
      if (legend) { legend.remove(); legend = null; }
      scheduleRedraw();
    };
    // Ask bridge.js for the current settings now that we are listening.
    window.postMessage({ __omc: 'ready' }, location.origin);

    // iD writes the map position into the URL only after the map has stopped
    // moving, and without a hashchange event. The countries found during the move
    // may then be off, so a changed URL triggers another redraw.
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash === lastHash) return;
      lastHash = location.hash;
      if (settings.enabled && settings.defaults) scheduleRedraw();
    }, 1000);

    window.addEventListener('mousemove', (event) => {
      lastPointer = event;
      if (tooltipPending) return;
      tooltipPending = true;
      requestAnimationFrame(showSignTooltip);
    }, { passive: true });
    window.addEventListener('resize', () => keepLegendInWindow());

    // Redraw whenever the map changes. 'd' is watched too: when the map is moved,
    // iD only changes the path geometry, and the signs have to follow.
    // Our own updates are ignored, otherwise the layers would redraw forever.
    new MutationObserver((records) => {
      const ours = (/** @type {Node} */ node) => !!(signLayer?.contains(node) || overlayLayer?.contains(node) || tooltip.contains(node) || legend?.contains(node));
      if (records.some((r) => !ours(r.target))) scheduleRedraw();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['d'] });
    scheduleRedraw();
  }
})();
