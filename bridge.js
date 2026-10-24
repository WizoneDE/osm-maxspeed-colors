// @ts-check
/**
 * OSM Maxspeed Colors – bridge between the extension and the map script.
 *
 * Chrome runs this file in the "isolated world": it can use chrome.storage but
 * cannot see the map data. content.js is the opposite. This file sends the current
 * settings and the shared tables from settings.js to content.js (at start, on
 * request and on every change), using window.postMessage limited to this origin.
 * content.js cannot read settings.js itself: Chrome does not share variables
 * between scripts injected into the page world.
 */
(() => {
  const sendSettings = () => {
    chrome.storage.sync.get(OMC_DEFAULTS, (stored) => {
      window.postMessage({
        __omc: 'settings',
        settings: omcCleanSettings(stored),
        noSpeed: OMC_NO_SPEED,
        extraTypes: OMC_EXTRA_TYPES,
        vehicles: OMC_VEHICLES,
      }, location.origin);
    });
  };

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') sendSettings();
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    // content.js only starts once the map exists and then asks for the settings.
    if (msg && typeof msg === 'object' && msg.__omc === 'ready') sendSettings();
  });

  sendSettings();
})();
