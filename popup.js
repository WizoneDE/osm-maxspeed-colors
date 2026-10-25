// @ts-check
/**
 * OSM Maxspeed Colors – toolbar popup.
 *
 * Shows the settings and saves every change to chrome.storage.sync right away.
 * bridge.js notices the change and passes it to the map, so open iD tabs update
 * immediately. Tables and the settings check come from settings.js.
 */

const POPUP_TEXT = {
  de: {
    enabled: 'Färbung', signs: 'Schilder', extras: 'Zusatzschilder (Nässe, Uhrzeit …)', types: 'Arten anzeigen',
    defaults: 'Standardwerte des Landes (grau)', legend: 'Legende auf der Karte', vehicle: 'Fahrzeug', unit: 'Einheit', lang: 'Sprache',
    noSpeed: 'Ohne maxspeed nur weiß gestrichelt:',
    footer: 'Gilt sofort in allen offenen iD-Tabs.',
  },
  en: {
    enabled: 'Colouring', signs: 'Signs', extras: 'Extra signs (wet, times …)', types: 'Types shown',
    defaults: 'Country defaults (grey)', legend: 'Legend on map', vehicle: 'Vehicle', unit: 'Unit', lang: 'Language',
    noSpeed: 'Without maxspeed only white dashes:',
    footer: 'Applies at once to all open iD tabs.',
  },
};

/** On/off switches; each id equals its settings key. @type {Array<'enabled'|'signs'|'extras'|'defaults'|'legend'>} */
const SWITCHES = ['enabled', 'signs', 'extras', 'defaults', 'legend'];

/**
 * Element by id, checked to be of the expected type (fails loudly if popup.html changes).
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`popup.html: #${id} missing or not a ${type.name}`);
  return el;
}

/**
 * Draws the popup for the given settings.
 * @param {Settings} s
 */
function render(s) {
  const words = POPUP_TEXT[s.lang];
  document.documentElement.lang = s.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.i18n;
    if (key && key in words) el.textContent = words[/** @type {keyof typeof words} */ (key)];
  }

  for (const key of SWITCHES) byId(key, HTMLInputElement).checked = s[key];
  // A sub-option can only be used while the options it depends on are on.
  for (const el of document.querySelectorAll('[data-needs]')) {
    const needs = (/** @type {HTMLElement} */ (el).dataset.needs || '').split(' ');
    const active = needs.every((key) => SWITCHES.includes(/** @type {any} */ (key)) && s[/** @type {'enabled'} */ (key)]);
    el.classList.toggle('disabled', !active);
  }

  // Kinds of extra signs, one checkbox each. What is stored is the list of hidden kinds.
  byId('typeList', HTMLDivElement).replaceChildren(...OMC_EXTRA_TYPES.map(([key, icon, de, en, tipDe, tipEn]) => {
    const label = document.createElement('label');
    label.title = s.lang === 'en' ? tipEn : tipDe;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !s.hiddenExtras.includes(key);
    box.addEventListener('change', () => {
      const hidden = s.hiddenExtras.filter((k) => k !== key);
      if (!box.checked) hidden.push(key);
      save({ hiddenExtras: hidden });
    });
    const iconEl = document.createElement('span');
    iconEl.className = 'ico';
    iconEl.textContent = icon;
    label.append(box, iconEl, s.lang === 'en' ? en : de);
    return label;
  }));

  // Note listing the way types that are drawn as "no speed" (same list the map uses).
  byId('noSpeedList', HTMLUListElement).replaceChildren(...OMC_NO_SPEED.map(([tag, value, de, en]) => {
    const item = document.createElement('li');
    item.title = `${tag}=${value}`;
    item.textContent = s.lang === 'en' ? en : de;
    return item;
  }));

  // Fixed list of vehicle types, labelled in the chosen language.
  const select = byId('vehicle', HTMLSelectElement);
  select.replaceChildren(...OMC_VEHICLES.map(([key, , icon, de, en]) => new Option(`${icon} ${s.lang === 'en' ? en : de}`, key)));
  select.value = s.vehicle;

  byId(`unit-${s.unit}`, HTMLInputElement).checked = true;
  byId(`lang-${s.lang}`, HTMLInputElement).checked = true;
}

/** Reads the settings from storage and draws the popup. */
function load() {
  chrome.storage.sync.get(OMC_DEFAULTS, (stored) => render(omcCleanSettings(stored)));
}

/** Stores a change (after the same check the map applies) and redraws. @param {Partial<Settings>} change */
function save(change) {
  chrome.storage.sync.get(OMC_DEFAULTS, (stored) => {
    chrome.storage.sync.set(omcCleanSettings({ ...stored, ...change }), load);
  });
}

for (const key of SWITCHES) {
  const box = byId(key, HTMLInputElement);
  box.addEventListener('change', () => save({ [key]: box.checked }));
}
const vehicleSelect = byId('vehicle', HTMLSelectElement);
vehicleSelect.addEventListener('change', () => save({ vehicle: vehicleSelect.value }));
for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name=unit]'))) {
  radio.addEventListener('change', () => save({ unit: radio.value === 'mph' ? 'mph' : 'kmh' }));
}
for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name=lang]'))) {
  radio.addEventListener('change', () => save({ lang: radio.value === 'en' ? 'en' : 'de' }));
}

load();
