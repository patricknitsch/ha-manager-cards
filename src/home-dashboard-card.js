/* Home Dashboard Card 2.0.0 – Startseite im Stil von Dwains Dashboard.
 * Benötigt die Ressource mit area-overview-card (Raum-Popups mit den Manager Cards).
 *
 *   type: custom:home-dashboard-card
 *   person: person.x
 *   weather: weather.x                    # nur Icon + Temperatur im Kopf
 *   valve: valve.x                        # Grohe-Ventil (offen/zu) in der Statusleiste
 *   warnings: [sensor.wetter_warnungen]   # DWD- oder NINA-Warnungen (Attribut warnings bzw. warning_N_*)
 *   power: { house, pv, grid, battery, battery_soc }
 *   solar_forecast: true                  # PV-Prognose aus den Energie-Einstellungen (Tageswert)
 *   power: { forecast: sensor.x_leistungsprognose, clearsky: sensor.x_clearsky_leistung }   # Kurven aus dem Attribut forecast
 *   area_power: { kinderzimmer: sensor.x }   # Standard: sensor.leistung_<bereich>
 *   cameras: { buro: camera.x, garage: camera.y }   # Kamerabild im Hintergrund der Raumkachel (camera_background: false schaltet es ab)
 *   exclude_areas: [pv]
 *   hide_label: dashboard_ausgeblendet    # per Label ausgeblendete Geräte zählen nicht mit
 *   links: [{ name, icon, path, color, integration, entity }]
 *   makers: [{ type: custom:shelly-manager-card, … }]   # für die Raum-Popups
 *   admin_only: [pi_hole, proxmoxve, xsense]   # Integrationen nur für Administratoren (Links, Räume, Zähler)
 *   links: [{ …, admin: true }]                # einzelnen Link nur Administratoren zeigen
 *   links: [{ …, group: devices }]            # Umschalter Geräte/Links: devices oder links (Standard: Geräte-Integrationen → devices); link_switch: false schaltet ihn ab
 *   links: [{ …, unit: Panel, badge: count }]  # eigene Einheit statt „Gerät“; Badge = Anzahl der Geräte statt der aktiven
 *   links: [{ …, auto_color: false }]          # Geräte-Integrationen färben sich nach ihren aktiven Geräten (häufigste Farbe); true schaltet es für weitere ein
 *   popup_opacity: 50                         # Deckkraft der Popups in % (100 = deckend), popup_blur: 10 (px), popup_dim: 20 (% Abdunklung)
 *   color_strength: 24                         # Farbstärke der Gerätehervorhebung in % (Rahmen = doppelt + 20)
 *   color_entity: input_boolean.dashboard_farben   # farbige Hervorhebung an/aus (aus = aktiv hell, inaktiv gedimmt)
 *   calendars: [calendar.familywall]           # heutige Termine im Header (Standard: alle Kalender); calendar_max: 6
 *   scroll_sections: true                      # Seiten und Räume getrennt scrollbar; section_height: 'calc(100vh - 150px)'
 *   layout: sidebar                            # sidebar (Standard, ab 1100 px: links Uhr/Kopf/Status, rechts Haus/Seiten/Räume)
 *                                              # | sidebar_links (links Kopf + Seiten, rechts Status-Kopfzeile, Haus, Räume) | stacked
 *   awtrix: [{ entity: sensor.awtrix_tc001_bildschirm, request_topic: …/cmd/screen/get, name: TC001 }]   # Uhren in der Seitenleiste
 *   switches: true                             # Statuskachel „Schalter an/aus“ (Steckdosen, Relais, Messdosen); false blendet sie aus
 */
{
const VERSION = '2.13.1';
const BAD = ['unavailable', 'unknown'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (st) => { if (!st || BAD.includes(st.state)) return null; const v = parseFloat(st.state); return Number.isNaN(v) ? null : v; };
const nf = (v, d = 1) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
const fW = (v) => (v == null ? '–' : Math.abs(v) >= 1000 ? `${nf(v / 1000, 2)} kW` : `${nf(v, Math.abs(v) < 10 ? 1 : 0)} W`);
const OPEN_DC = ['door', 'window', 'garage_door', 'opening'];
const HEAT = ['heating', 'preheating', 'cooling'];
const WX = {
  'clear-night': 'mdi:weather-night', cloudy: 'mdi:weather-cloudy', exceptional: 'mdi:alert-circle-outline', fog: 'mdi:weather-fog',
  hail: 'mdi:weather-hail', lightning: 'mdi:weather-lightning', 'lightning-rainy': 'mdi:weather-lightning-rainy',
  partlycloudy: 'mdi:weather-partly-cloudy', pouring: 'mdi:weather-pouring', rainy: 'mdi:weather-rainy', snowy: 'mdi:weather-snowy',
  'snowy-rainy': 'mdi:weather-snowy-rainy', sunny: 'mdi:weather-sunny', windy: 'mdi:weather-windy', 'windy-variant': 'mdi:weather-windy-variant',
};
// Schalter, die eine Last schalten: Steckdosen, Messdosen, Relais, Beleuchtung, Pumpen (keine Einstellungsschalter)
const SW_LOAD = /schaltdose|steckdose|messdose|zwischenstecker|relais|relay|plug|socket|outlet|beleuchtung|lampe|pumpe|lüfter|luefter|ventilator/i;
// Gerätegruppen in der Raumkachel (Anzahl, aktiv hervorgehoben); Reihenfolge zählt (Geschirrspüler/Dishwasher vor Waschmaschine, Dampfgarer vor Backofen)
const APPS = [
  { k: 'boiler', re: /boiler|hei(ß|ss)wasser|warmwasser/i, icon: 'mdi:water-boiler', name: 'Boiler', c: '#f44336' },
  { k: 'dish', re: /geschirrsp(ü|u|ue)ler|dishwasher/i, icon: 'mdi:dishwasher', name: 'Geschirrspüler', c: '#f44336' },
  { k: 'washer', re: /waschmaschine|washing.?machine|\bwasher\b/i, icon: 'mdi:washing-machine', name: 'Waschmaschine', c: '#f44336' },
  { k: 'dryer', re: /trockner|dryer/i, icon: 'mdi:tumble-dryer', name: 'Trockner', c: '#f44336' },
  { k: 'steam', re: /dampfgarer|steam/i, icon: 'mdi:pot-steam', name: 'Dampfgarer', c: '#f44336' },
  { k: 'oven', re: /backofen|oven/i, icon: 'mdi:toaster-oven', name: 'Backofen', c: '#f44336' },
  { k: 'hob', re: /kochfeld|\bherd\b|cooktop|\bhob\b/i, icon: 'mdi:stove', name: 'Kochfeld', c: '#f44336' },
  { k: 'smoke', re: /rauchmelder|smoke|^rm\b/i, icon: 'mdi:smoke-detector-variant', name: 'Rauchmelder', c: '#f44336' },
  { k: 'pihole', re: /pi-?hole/i, icon: 'mdi:pi-hole', name: 'Pi-hole', c: '#ff9800' },
  { k: 'server', re: /server|proxmox|\bnas\b|synology/i, icon: 'mdi:server', name: 'Server', c: '#9c27b0' },
];
const PLUG = /messdose|steckdose|zwischenstecker|plug/i;
// Integrationslinks, deren Farbe sich aus den aktiven Geräten ergibt (andere mit auto_color: true)
const AUTO_LINKS = ['esphome', 'grohe_smarthome', 'localthings', 'miele_lan', 'ojmicroline_thermostat', 'shelly', 'tasmota', 'xsense', 'pi_hole', 'proxmoxve', 'synology_dsm', 'ultimate_updater'];
// Links dieser Integrationen gehören zur Gruppe „Geräte“ (Umschalter Geräte/Links)
const DEVICE_LINKS = ['esphome', 'grohe_smarthome', 'localthings', 'miele_lan', 'ojmicroline_thermostat', 'shelly', 'tasmota', 'xsense', 'pi_hole', 'proxmoxve', 'synology_dsm'];
const APPS_EXCL = /ha-mcp|mcp server/i;   // Dienste, keine Geräte
const DWD_COLOR = ['var(--disabled-color, #9e9e9e)', '#ffeb3b', '#ff9800', '#f44336', '#9c27b0'];
const DWD_TEXT = ['keine Warnung', 'Wetterwarnung', 'Markantes Wetter', 'Unwetterwarnung', 'Extremes Unwetter'];

/* DOM abgleichen statt neu aufbauen (verhindert Flackern). Knoten mit data-keep behalten ihren Inhalt. */
function morph(target, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(target, tpl.content);
}
function morphChildren(a, b) {
  const an = [...a.childNodes]; const bn = [...b.childNodes];
  bn.forEach((y, i) => {
    const x = an[i];
    if (!x) { a.appendChild(y); return; }
    const same = x.nodeType === y.nodeType && (x.nodeType !== 1
      || (x.tagName === y.tagName && (x.getAttribute('data-k') || '') === (y.getAttribute('data-k') || '')));
    if (!same) { a.replaceChild(y, x); return; }
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    // Eingebettete HA-Elemente (Tag mit Bindestrich) verwalten ihren Inhalt selbst: nur gesetzte Attribute abgleichen
    const custom = x.tagName.includes('-');
    if (!custom) for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (!custom && !x.hasAttribute('data-keep')) morphChildren(x, y);
  });
  for (let i = bn.length; i < an.length; i++) an[i].remove();
}

/* Gemeinsamer Speicher für per Label ausgeblendete Geräte und Entitäten (gilt für alle Karten und Browser).
 * Daten bleiben erhalten, die Methoden setzt jede Karte neu – so gilt immer der neueste Stand, egal welche Karte zuerst lädt. */
const HIDE = window.__aocHideStore = Object.assign(window.__aocHideStore || {
  label: 'dashboard_ausgeblendet', ids: new Set(), ents: new Set(), ref: null, eref: null, busy: false, subs: new Set(), ver: 0,
}, {
  sync(hass) {
    if (!hass) return;
    if (!this.ents) this.ents = new Set();
    if (this.eref !== hass.entities) {
      this.eref = hass.entities;
      const ents = new Set(Object.values(hass.entities || {}).filter((e) => (e.labels || []).includes(this.label)).map((e) => e.entity_id));
      if (ents.size !== this.ents.size || [...ents].some((id) => !this.ents.has(id))) { this.ents = ents; this.notify(); }
    }
    if (this.ref === hass.devices) return;
    this.ref = hass.devices;
    const devs = Object.values(hass.devices || {});
    if (devs.some((d) => Array.isArray(d.labels))) {
      this.ids = new Set(devs.filter((d) => (d.labels || []).includes(this.label)).map((d) => d.id));
      this.pending = null;
      this.notify();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    hass.callWS({ type: 'config/device_registry/list' })
      .then((list) => { this.ids = new Set(list.filter((d) => (d.labels || []).includes(this.label)).map((d) => d.id)); this.notify(); })
      .catch((err) => console.warn('ha-manager-cards: Geräteliste nicht lesbar', err))
      .finally(() => { this.busy = false; });
  },
  /** Entität (Registry-Eintrag) ausgeblendet – direkt oder über ihr Gerät */
  hidden(e) { return !!e && ((e.device_id && this.ids.has(e.device_id)) || (this.ents && this.ents.has(e.entity_id)) || (!!this.restricted && this.restricted(e))); },
  async set(hass, id, hide) {
    let cur = hass.devices[id]?.labels;
    if (!Array.isArray(cur)) cur = ((await hass.callWS({ type: 'config/device_registry/list' })).find((d) => d.id === id) || {}).labels || [];
    const labels = hide ? [...new Set([...cur, this.label])] : cur.filter((l) => l !== this.label);
    await hass.callWS({ type: 'config/device_registry/update', device_id: id, labels });
    // Registry-Ereignis abwarten: bis dahin gilt der lokale Stand (kein kurzes Wiederauftauchen)
    this.ids = new Set(this.ids);
    if (hide) this.ids.add(id); else this.ids.delete(id);
    this.pending = { id, hide };
    this.notify();
  },
  /** Entitäten ohne Gerät (Gruppe „Sonstiges“) per Label aus- oder einblenden */
  async setEntities(hass, entityIds, hide) {
    for (const eid of entityIds) {
      const cur = hass.entities[eid]?.labels || [];
      const labels = hide ? [...new Set([...cur, this.label])] : cur.filter((l) => l !== this.label);
      await hass.callWS({ type: 'config/entity_registry/update', entity_id: eid, labels });
    }
    this.ents = new Set(this.ents);
    entityIds.forEach((eid) => (hide ? this.ents.add(eid) : this.ents.delete(eid)));
    this.notify();
  },
  notify() { this.ver = (this.ver || 0) + 1; this.subs.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); },
});

const STYLE = `
  :host { display:block; --r: 20px; --gap: 14px; color: var(--primary-text-color); }
  * { box-sizing: border-box; }
  ha-icon { display:inline-flex; }
  .page { max-width: 1680px; margin: 0 auto; padding: 8px 12px 32px; display:flex; flex-direction:column; gap: var(--gap); }
  .card { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--r);
    border: 1px solid var(--ha-card-border-color, var(--divider-color)); box-shadow: var(--ha-card-box-shadow, none); }
  .click { cursor:pointer; transition: transform .12s, background-color .15s; }
  .click:hover { background-color: var(--secondary-background-color); }
  .click:active { transform: scale(.99); }
  h2 { margin: 6px 0 10px 4px; font-size: 18px; font-weight: 600; display:flex; align-items:center; gap:8px; }
  #linksec h2 { justify-content: space-between; margin-right: 4px; flex-wrap: wrap; row-gap: 6px; min-width:0; }
  #linksec h2 > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .seg { max-width: 100%; box-sizing: border-box; }
  /* schmale Spalte (Handy): Überschrift weglassen, Umschalter über die ganze Spaltenbreite */
  @media (max-width: 700px) {
    #linksec h2.has-seg > span:first-child { display:none; }
    #linksec h2.has-seg .seg { flex: 1 1 100%; }
    .seg button { flex: 1 1 0; min-width:0; justify-content:center; padding: 5px 4px; gap: 3px; }
    .seg button .t { display:none; } .seg button ha-icon { display:inline-flex; }
  }
  .seg { display:inline-flex; background: var(--secondary-background-color); border:1px solid var(--divider-color); border-radius: 10px; padding:2px; gap:2px; }
  .seg[hidden] { display:none; }
  .seg button { font: inherit; font-size: 12.5px; font-weight: 500; border:none; background:none; color: var(--secondary-text-color); cursor:pointer;
    padding: 4px 10px; border-radius: 8px; display:inline-flex; align-items:center; gap:5px; }
  .seg button ha-icon { display:none; --mdc-icon-size: 18px; flex:none; }
  .seg button i { flex:none; }
  .seg button.on { background: var(--card-background-color); color: var(--primary-text-color); box-shadow: 0 1px 2px rgba(0,0,0,.18); }
  .seg button i { font-style:normal; font-size: 11px; min-width: 16px; height: 16px; line-height:16px; border-radius: 8px; padding: 0 4px; box-sizing:border-box;
    background: #ff9800; color:#fff; text-align:center; } .seg button i:empty { display:none; } .seg button i.err { background:#f44336; }
  h2 small { font-size: 13px; font-weight: 400; color: var(--secondary-text-color); }

  /* Kopf, Status-Icons und Haus über die volle Breite; darunter Seiten und Räume immer nebeneinander */
  .cols { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--gap); align-items:start; }
  .cols > section { min-width:0; }
  /* Seiten und Räume scrollen getrennt, ohne die ganze Seite zu verschieben (scroll_sections: false schaltet ab) */
  .cols.scroll .links, .cols.scroll .rooms { max-height: var(--sec-h, calc(100vh - 150px)); overflow-y:auto; overscroll-behavior: contain;
    scrollbar-width: thin; padding: 2px 4px 6px 2px; margin: -2px -4px 0 -2px; }
  @media (max-width: 700px) { .cols { grid-template-columns: minmax(0, 0.8fr) minmax(0, 2fr); gap: 10px; } }

  .side, .main { display:flex; flex-direction:column; gap: var(--gap); min-width:0; }
  .aw { display:flex; flex-direction:column; gap: 8px; } .aw[hidden] { display:none; }
  .clock { display:none; }
  /* Seitenleiste (layout: sidebar, Standard): links Uhr, Begrüßung, Wetter, Termine, Status; rechts Haus, Seiten und Räume.
     Schmaler als 1100 px bleibt alles untereinander. */
  @media (min-width: 1100px) {
    .page.sb { display:grid; grid-template-columns: var(--side-w, 300px) minmax(0, 1fr); align-items:start; max-width: none; padding-top: 0; }
    .page.sb .side { position:sticky; top:0; max-height: var(--hmc-vh, calc(100vh - 56px)); overflow-y:auto; scrollbar-width: thin;
      padding: 14px 10px 14px 4px; border-right: 1px solid var(--divider-color); }
    .page.sb .main { height: var(--hmc-vh, calc(100vh - 56px)); padding-top: 8px; }
    .page.sb .clock { display:flex; flex-direction:column; gap:2px; padding: 0 4px; }
    .page.sb .clock b { font-size: 58px; font-weight: 300; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .page.sb .clock small { font-size: 15px; color: var(--secondary-text-color); }
    .page.sb .clock .kw { font-weight: 600; color: var(--primary-text-color); margin-top: 6px; }
    .page.sb .hdr { flex-wrap: wrap; gap: 10px; padding: 0 4px; align-items: flex-start; }
    .page.sb .av { width:44px; height:44px; } .page.sb .av ha-icon { --mdc-icon-size:24px; }
    .page.sb .greet .g { font-size: 18px; white-space: normal; }
    .page.sb .greet .s { display:none; }
    .page.sb .cal { flex-direction:column; flex-wrap:nowrap; margin-top: 8px; }
    .page.sb .cal .ev { border-radius: 10px; padding: 6px 10px; }
    .page.sb .stat { grid-template-columns: 1fr; gap: 6px; }
    .page.sb .si { flex-direction: row; justify-content:flex-start; gap: 12px; padding: 8px 12px; text-align:left; }
    .page.sb .si .bub { width: 36px; height: 36px; } .page.sb .si .bub ha-icon { --mdc-icon-size: 20px; }
    .page.sb .si .l { font-size: 14px; flex:1; }
    .page.sb .si .cnt { position: static; order: 3; }
    /* rechts: Haus oben, Seiten und Räume füllen den Rest und scrollen getrennt */
    .page.sb .cols { flex:1; min-height:0; align-items: stretch; }
    .page.sb .cols > section { display:flex; flex-direction:column; min-height:0; height:100%; }
    .page.sb .cols.scroll .links, .page.sb .cols.scroll .rooms { max-height:none; flex:1; min-height:0; }
  }
  /* layout: sidebar_links – links Kopf und Seiten, rechts Status als Kopfzeile, Haus und die Räume allein */
  @media (min-width: 1100px) {
    /* Seitenleiste und Statuszeile als leicht abgesetzte Flächen mit Rahmen (Tönung über --panel-tint) */
    .page.sl .side, .page.sl .main > .stat { border-radius: var(--r); border: 1px solid color-mix(in srgb, var(--primary-color) 28%, var(--divider-color));
      background: color-mix(in srgb, var(--primary-color) var(--panel-tint, 7%), var(--ha-card-background, var(--card-background-color)));
      box-shadow: var(--ha-card-box-shadow, none); }
    .page.sl .side { margin: 8px 0 8px 0; height: calc(var(--hmc-vh, calc(100vh - 56px)) - 16px); padding: 14px 10px 10px; border-right-width: 1px; }
    .page.sl .main > .stat { padding: 8px; }
    .page.sl .main > .stat .si { background: var(--ha-card-background, var(--card-background-color)); }
    .page.sl .side { height: var(--hmc-vh, calc(100vh - 56px)); }
    .page.sl #linksec { display:flex; flex-direction:column; flex:1; min-height:0; }
    .page.sl #linksec .links { flex:1; min-height:0; overflow-y:auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 2px 4px 6px 2px; }
    .page.sl .main .stat { grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); }
    .page.sl .main .si { flex-direction: column; align-items:center; gap:6px; padding: 10px 6px 8px; text-align:center; }
    .page.sl .main .si .cnt { position:absolute; order:0; }
    .page.sl .main .si .l { font-size:12px; flex:none; }
    .page.sl .cols { grid-template-columns: minmax(0, 1fr); }
    .page.sl .rooms { display:grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); align-content:start; }
  }

  /* Kopf */
  .hdr { display:flex; align-items:center; gap:16px; padding: 4px 4px 0; }
  .av { width:60px; height:60px; border-radius:50%; background: var(--secondary-background-color) center/cover; flex:none; cursor:pointer;
    display:flex; align-items:center; justify-content:center; border:3px solid var(--success-color, #43a047); }
  .av.away { border-color: var(--disabled-color, #9e9e9e); filter: grayscale(.5); }
  .av ha-icon { --mdc-icon-size:32px; color: var(--secondary-text-color); }
  .greet { flex:1; min-width:0; }
  .greet .g { font-size: 28px; font-weight: 600; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .greet .s { font-size: 14px; color: var(--secondary-text-color); margin-top:2px; }
  .gl { display:flex; align-items:center; gap:10px; min-width:0; }
  .gl .g { min-width:0; }
  .wx { display:flex; align-items:center; gap:4px; cursor:pointer; padding:2px 8px; border-radius:12px; flex:none; }
  .wx:hover { background: var(--secondary-background-color); }
  .wx ha-icon { --mdc-icon-size: 28px; color: var(--amber-color, #ffc107); }
  .wx span { font-size: 20px; font-weight: 600; white-space:nowrap; }
  .greet .s .tm { font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) { .greet .g { font-size: 20px; white-space:normal; } .hdr { gap:10px; }
    .stat { grid-template-columns: repeat(4, 1fr); } .si .l { font-size:11px; } .av { width:48px; height:48px; }
    .wx ha-icon { --mdc-icon-size: 22px; } .wx span { font-size: 16px; } }

  /* Status-Icons */
  .stat { display:grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 8px; }
  .si { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; padding: 12px 6px 10px; text-align:center; }
  .si .bub { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; background: var(--secondary-background-color); }
  .si .bub ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
  .si.on .bub { background: color-mix(in srgb, var(--c) 22%, transparent); }
  .si.on .bub ha-icon { color: var(--c); }
  .si.alert .bub, .si.blink .bub { animation: pulse 1.6s infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 25%, transparent); } }
  .si .l { font-size: 12px; color: var(--secondary-text-color); line-height:1.2; }
  .si.on .l { color: var(--primary-text-color); font-weight:500; }
  .si .cnt { position:absolute; top:8px; right: calc(50% - 30px); min-width:20px; height:20px; padding:0 5px; border-radius:10px;
    background: var(--c); color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }

  /* Haus */
  .haus { padding: 16px; display:flex; flex-direction:column; gap: 12px; }
  .hh { display:flex; align-items:flex-start; gap: 12px; flex-wrap:wrap; }
  .hh .bub { width:44px; height:44px; border-radius:14px; display:flex; align-items:center; justify-content:center; flex:none;
    background: color-mix(in srgb, #f44336 16%, transparent); }
  .hh .bub ha-icon { --mdc-icon-size:26px; color:#f44336; }
  .hh .t { flex:1; min-width: 140px; }
  .hh .t small { display:block; font-size:13px; color: var(--secondary-text-color); }
  .hh .t b { font-size: 30px; font-weight: 700; line-height:1.1; }
  .vals { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); flex:1 1 100%; }
  .val { display:flex; align-items:center; gap:8px; padding: 8px 12px; border-radius: 14px; min-width: 108px;
    background: color-mix(in srgb, var(--c) 9%, transparent); border: 1px solid color-mix(in srgb, var(--c) 22%, transparent); }
  .val ha-icon { --mdc-icon-size:22px; color: var(--c); }
  .val div { line-height:1.15; } .val b { font-size:15px; } .val small { display:block; font-size:12px; color: var(--secondary-text-color); }
  .chart { position:relative; height: 150px; }
  .chart svg { width:100%; height:100%; display:block; overflow:visible; }
  .chart .ymax { position:absolute; top:-2px; left:0; font-size:11px; color: var(--secondary-text-color); background: var(--ha-card-background, var(--card-background-color)); padding: 0 4px 0 0; }
  .chart .grid line { stroke: var(--divider-color); stroke-width:1; vector-effect: non-scaling-stroke; }
  .chart .pv { fill: color-mix(in srgb, #ffc107 22%, transparent); stroke:#ffc107; stroke-width:2; vector-effect: non-scaling-stroke; }
  .chart .use { fill:none; stroke:#f44336; stroke-width:2; vector-effect: non-scaling-stroke; }
  .chart .grd { fill: color-mix(in srgb, #9c27b0 14%, transparent); stroke:#9c27b0; stroke-width:1.5; vector-effect: non-scaling-stroke; }
  .chart .zero { stroke: var(--secondary-text-color); stroke-width:1; opacity:.6; vector-effect: non-scaling-stroke; }
  .chart .ymin { position:absolute; bottom:-2px; left:0; font-size:11px; color: var(--secondary-text-color); background: var(--ha-card-background, var(--card-background-color)); padding: 0 4px 0 0; }
  .chart .fc { fill:none; stroke:#4caf50; stroke-width:2; stroke-dasharray: 6 4; opacity:.95; vector-effect: non-scaling-stroke; }
  .chart .cs { fill:none; stroke: var(--secondary-text-color); stroke-width:1.5; stroke-dasharray: 3 4; opacity:.7; vector-effect: non-scaling-stroke; }
  .chart .now { stroke: var(--secondary-text-color); stroke-width:1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
  .ax { display:flex; justify-content:space-between; font-size: 11px; color: var(--secondary-text-color); padding: 2px 0 0; }
  .leg { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color: var(--secondary-text-color); }
  .cal { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .cal .ev { display:inline-flex; align-items:center; gap:5px; font-size:12.5px; padding: 3px 9px; border-radius: 12px; cursor:pointer;
    background: color-mix(in srgb, var(--primary-color) 14%, transparent); max-width: 100%; }
  .cal .ev ha-icon { --mdc-icon-size:15px; color: var(--primary-color); flex:none; }
  .cal .ev b { font-weight:600; flex:none; } .cal .ev span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cal .ev.past { opacity:.5; }
  .leg i { display:inline-block; width:14px; height:3px; border-radius:2px; vertical-align:middle; margin-right:5px; }

  /* Links */
  .links { display:flex; flex-direction:column; gap: 8px; container-type: inline-size; }
  .lk { display:flex; align-items:center; gap:12px; padding: 10px 14px; }
  .lk .bub { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; flex:none;
    background: color-mix(in srgb, var(--c, var(--primary-color)) 16%, transparent); }
  .lk .bub ha-icon { --mdc-icon-size:22px; color: var(--c, var(--primary-color)); }
  .lk .bub { position:relative; }
  .lk .bdg { position:absolute; top:-6px; right:-6px; min-width:18px; height:18px; padding:0 5px; border-radius:9px; box-sizing:border-box;
    background: var(--c, var(--primary-color)); color:#fff; font-size:11px; font-weight:700; line-height:18px; text-align:center;
    box-shadow: 0 0 0 2px var(--card-background-color, #1c1c1c); z-index:1; }
  .lk .bdg.err { background:#f44336; } .lk .bdg.warn { background:#ff9800; }
  .lk .n { flex:1; min-width:0; } .lk .n b { display:block; font-size:15px; }
  .lk .n span { font-size:12.5px; color: var(--secondary-text-color); }
  .lk .ok { color: var(--success-color, #43a047); } .lk .err { color: var(--error-color, #db4437); } .lk .warn { color: var(--warning-color, #ffa600); }
  .lk .act { color: var(--primary-color); }
  .lk > ha-icon { --mdc-icon-size:20px; color: var(--secondary-text-color); }
  @container (max-width: 260px) {
    .links .lk { gap:8px; padding: 8px 10px; } .links .lk .bub { width:32px; height:32px; border-radius:10px; } .links .lk .bub ha-icon { --mdc-icon-size:19px; }
    .links .lk .n b { font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .links .lk .n span { font-size:11.5px; display:block; }
    .links .lk > ha-icon { display:none; }
  }
  @container (max-width: 170px) {
    .links .lk { flex-direction:column; gap:4px; padding: 8px 4px; text-align:center; } .links .lk .n { width:100%; }
    .links .lk .n b { font-size:12px; white-space:normal; overflow-wrap:anywhere; } .links .lk .n span { display:none; }
  }

  /* Räume */
  .rooms { display:flex; flex-direction:column; gap: 10px; }
  .rc { position:relative; overflow:hidden; min-height: 104px; padding: 12px 14px; display:flex; flex-direction:column; gap: 10px; isolation:isolate; }
  .rc .bgl { position:absolute; inset:0; z-index:-1; pointer-events:none; }
  .rc .bgl svg { position:absolute; left:0; right:0; bottom:0; width:100%; height:48%; }
  .rc .bgl .a { fill: color-mix(in srgb, var(--orange-color, #ff9800) 14%, transparent); }
  .rc .bgl .l { fill:none; stroke: var(--orange-color, #ff9800); stroke-width:1.5; opacity:.55; vector-effect: non-scaling-stroke; }
  .rc .cam { position:absolute; inset:0; z-index:-2; pointer-events:none; }
  .rc .cam > * { position:absolute; inset:0; margin:0; }
  .rc .cam hui-picture-entity-card, .rc .cam ha-card { height:100%; border:none; border-radius:0; box-shadow:none; }
  .rc.withcam { color:#fff; min-height: 150px; }
  .rc.withcam .bgl { background: linear-gradient(90deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.35) 60%, rgba(0,0,0,.15) 100%); }
  .rc.withcam .bgl svg { display:none; }
  .rc.withcam .rn span, .rc.withcam .ic { color: rgba(255,255,255,.85); }
  .rc .rh { display:flex; align-items:center; gap:12px; }
  .rc .ri { width:42px; height:42px; border-radius:13px; display:flex; align-items:center; justify-content:center; flex:none;
    background: color-mix(in srgb, var(--primary-color) 16%, transparent); }
  .rc .ri ha-icon { --mdc-icon-size:24px; color: var(--primary-color); }
  .rc.withcam .ri { background: rgba(255,255,255,.18); } .rc.withcam .ri ha-icon { color:#fff; }
  .rc .rn { flex:1; min-width:0; } .rc .rn b { display:block; font-size:16px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rc .rn span { font-size:13px; color: var(--secondary-text-color); }
  .rc .pw { font-size:18px; font-weight:700; white-space:nowrap; font-variant-numeric: tabular-nums; }
  .rc .pw small { display:block; font-size:11px; font-weight:400; text-align:right; opacity:.7; }
  .icons { display:flex; gap:6px; flex-wrap:wrap; }
  .ic { display:inline-flex; align-items:center; gap:4px; padding: 4px 8px; border-radius: 10px; font-size:13px; font-weight:600;
  .ic.camic { cursor:pointer; } .ic.camic:hover { filter: brightness(1.25); outline: 1px solid color-mix(in srgb, var(--c) 50%, transparent); }
    color: var(--secondary-text-color); background: color-mix(in srgb, var(--secondary-text-color) 14%, var(--ha-card-background, var(--card-background-color))); }
  .ic ha-icon { --mdc-icon-size:18px; }
  .ic.on { color: var(--c); background: color-mix(in srgb, var(--c) 20%, var(--ha-card-background, var(--card-background-color))); }
  .rc.withcam .ic { background: rgba(0,0,0,.35); } .rc.withcam .ic.on { color: var(--c); background: rgba(0,0,0,.5); }
  [hidden] { display:none !important; }
`;

const POP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .bg { position:fixed; inset:0; z-index:99; background: rgba(0,0,0,var(--pop-dim, .2)); display:flex; align-items:center; justify-content:center; padding:24px;
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, sans-serif)); color: var(--primary-text-color); animation: fd .15s; }
  @keyframes fd { from { opacity:0; } }
  @keyframes su { from { transform: translateY(24px); opacity:.4; } }
  .pop { background: color-mix(in srgb, var(--primary-background-color, var(--card-background-color)) var(--pop-op, 50%), transparent);
    -webkit-backdrop-filter: blur(var(--pop-blur, 10px)); backdrop-filter: blur(var(--pop-blur, 10px)); border-radius:24px; width: min(var(--w, 640px), 100%);
    max-height: calc(100vh - 48px); display:flex; flex-direction:column; box-shadow: 0 12px 48px rgba(0,0,0,.45); overflow:hidden; animation: su .18s; }
  .ph { display:flex; align-items:center; gap:12px; padding: 16px 16px 12px 22px; }
  .ph .bub { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center;
    background: color-mix(in srgb, var(--c, var(--primary-color)) 18%, transparent); }
  .ph .bub ha-icon { --mdc-icon-size:24px; color: var(--c, var(--primary-color)); }
  .ph .t { flex:1; font-size:22px; font-weight:600; } .ph .t small { display:block; font-size:13px; font-weight:400; color: var(--secondary-text-color); }
  .x { background: var(--secondary-background-color); border:none; width:38px; height:38px; border-radius:50%; cursor:pointer; color: var(--primary-text-color);
    display:flex; align-items:center; justify-content:center; }
  .pb { overflow:auto; padding: 4px 20px 22px; display:flex; flex-direction:column; gap:12px; }
  .lst { display:flex; flex-direction:column; background: color-mix(in srgb, var(--ha-card-background, var(--card-background-color)) var(--pop-op, 50%), transparent); border-radius:16px; border:1px solid var(--divider-color); overflow:hidden; }
  .it { display:flex; align-items:center; gap:12px; padding:10px 14px; border-top:1px solid var(--divider-color); cursor:pointer; font-size:15px; }
  .it:first-child { border-top:none; } .it:hover { background: var(--secondary-background-color); }
  .it ha-icon { --mdc-icon-size:22px; color: var(--c, var(--secondary-text-color)); }
  .it .n { flex:1; min-width:0; } .it .n small { display:block; font-size:12px; color: var(--secondary-text-color); }
  .it .v { white-space:nowrap; font-variant-numeric: tabular-nums; font-weight:500; }
  .bar { height:6px; border-radius:3px; background: var(--divider-color); margin-top:5px; overflow:hidden; }
  .bar i { display:block; height:100%; background: var(--orange-color, #ff9800); border-radius:3px; }
  .tog { position:relative; width:42px; height:24px; border-radius:12px; background: var(--switch-unchecked-track-color, #9e9e9e); border:none; cursor:pointer; flex:none; }
  .tog::after { content:''; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; }
  .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); } .tog.on::after { left:21px; }
  .acts { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
  .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:12px; padding:9px 18px; font: inherit; font-size:14px; cursor:pointer; }
  .btn.sec { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .none { color: var(--secondary-text-color); padding:16px 4px; }
  .warn { border-radius:16px; padding: 14px 16px; background: var(--ha-card-background, var(--card-background-color)); border:1px solid var(--divider-color);
    border-left: 6px solid var(--c); display:flex; flex-direction:column; gap:6px; }
  .warn b { font-size:16px; } .warn .tm { font-size:12px; color: var(--secondary-text-color); } .warn p { margin:0; font-size:14px; line-height:1.45; }
  .sec { font-weight:600; margin: 4px 4px 0; }
  .mi { border-top:1px solid var(--divider-color); border-left:4px solid var(--c); }
  .mi:first-child { border-top:none; }
  .mh { display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer; flex-wrap:wrap; }
  .mh:hover { background: var(--secondary-background-color); }
  .mh .dot { width:10px; height:10px; border-radius:50%; background: var(--c); flex:none; }
  .mh .n { flex:1; min-width:160px; font-size:15px; font-weight:500; }
  .mh .n small { display:block; font-size:12px; font-weight:400; color: var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px; }
  .mh .chs { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
  .ch { font-size:12px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space:nowrap; }
  .ch.ok { background: rgba(76,175,80,.15); color:#4caf50; } .ch.warn { background: rgba(255,152,0,.16); color:#ff9800; } .ch.err { background: rgba(244,67,54,.15); color:#f44336; }
  .mdet { padding: 0 12px 12px 34px; }
  .msub { font-size:12px; font-weight:600; color: var(--secondary-text-color); margin:8px 0 2px; text-transform:uppercase; letter-spacing:.04em; }
  .mrow { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px; }
  .mrow > span:not(.mlv) { flex:1; min-width:0; overflow-wrap:anywhere; } .mrow small { display:block; font-size:11.5px; color: var(--secondary-text-color); }
  .mrow ha-icon { --mdc-icon-size:18px; flex:none; } .mrow.click { cursor:pointer; } .mrow .btn { padding:4px 10px; font-size:12px; }
  .mlv { font-weight:700; width:18px; text-align:center; flex:none; }
  .msel { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:6px; }
  .mchk { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px; border:1px solid var(--divider-color); cursor:pointer; font-size:14px; }
  .mchk.on { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
  .mchk ha-icon { color: var(--primary-color); flex:none; } .mchk small { display:block; font-size:11px; color: var(--secondary-text-color); }
  .host > * { display:block; }
  .host > .cams { margin-bottom: 14px; }
  .lbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .lf { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color); border-radius:16px;
    padding:5px 12px; font: inherit; font-size:13px; cursor:pointer; }
  .lf b { font-weight:600; opacity:.7; } .lf.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .lq { flex:1; min-width:140px; background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
    border-radius:10px; padding:7px 10px; font: inherit; font-size:14px; }
  .lbar .btn { padding:6px 12px; font-size:13px; }
  .linf { font-size:12px; color: var(--secondary-text-color); margin: 0 4px; }
  .le { padding:9px 14px 9px 12px; border-top:1px solid var(--divider-color); border-left:4px solid var(--c); cursor:pointer; }
  .le:first-child { border-top:none; } .le:hover { background: var(--secondary-background-color); }
  .le .lh { display:flex; gap:8px; align-items:baseline; }
  .le .lv { font-size:11px; font-weight:700; color: var(--c); text-transform:uppercase; flex:none; min-width:58px; }
  .le .lm { flex:1; font-size:14px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .le .lc { font-size:11px; padding:1px 7px; border-radius:9px; background: var(--secondary-background-color); flex:none; }
  .le .ls { font-size:11.5px; color: var(--secondary-text-color); margin: 2px 0 0 66px; overflow-wrap:anywhere; }
  .le pre { margin:8px 0 2px; padding:10px; background: var(--secondary-background-color); border-radius:8px; font-size:12px; line-height:1.4;
    white-space:pre-wrap; word-break:break-word; max-height:360px; overflow:auto; cursor:text; }
  @media (max-width: 600px) { .le .ls { margin-left:0; } }
  @media (max-width: 600px) { .bg { align-items:flex-end; padding:0; } .pop { border-radius:24px 24px 0 0; max-height:92vh; width:100%; } }
`;

class HomeDashboardCard extends HTMLElement {
  setConfig(config) {
    this._config = { exclude_areas: [], cameras: {}, area_power: {}, links: [], makers: [], power: {}, warnings: [],
      solar_forecast: true, battery_low: 20, hide_label: 'dashboard_ausgeblendet', ...config };
    HIDE.label = this._config.hide_label;
    if (this._config.color_entity) window.__hmcColorEntity = this._config.color_entity;
    // Farbstärke der Gerätehervorhebung (Fläche in %, Rahmen etwas kräftiger), gilt für alle Karten
    { const n = Number(this._config.color_strength ?? 24); const v = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 24;
      document.documentElement.style.setProperty('--hmc-a', `${v}%`); document.documentElement.style.setProperty('--hmc-b', `${Math.min(100, v * 2 + 20)}%`); }
    if (!this.shadowRoot) this._build();
    this._camEls = this._camEls || {};
  }

  getCardSize() { return 20; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return {}; }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => { this._renderHeader(); this._fetchCal(); this._fetchHist(); this._fetchForecast(); this._renderHaus(); this._fetchLog(); this._fetchSys(); }, 30000);
    this._onHide = () => this._render();
    HIDE.subs.add(this._onHide);
  }

  disconnectedCallback() { clearInterval(this._tick); HIDE.subs.delete(this._onHide); this._closePopup(); this._closeCams(); }

  set hass(hass) {
    this._hass = hass;
    HIDE.sync(hass);
    HIDE.restrict(hass, this._config.admin_only || []);
    this._render();
    if (this._pop) this._updatePopup();
    if (this._camPop) for (const c of this._camPop.els) c.hass = hass;
    this._renderAwtrix();
    if (!this._calTs) this._fetchCal();
    if (!this._histTs) this._fetchHist();
    if (!this._fcTs) this._fetchForecast();
    if (!this._logTs) this._fetchLog();
    if (!this._sysTs) this._fetchSys();
  }

  /* ---------- Home-Assistant-Log (Systemprotokoll, nur Admins) ---------- */
  async _fetchLog(force) {
    const hass = this._hass;
    const wanted = (this._config.links || []).some((l) => ['log', 'integrations'].includes(l.popup));
    // Systemprotokoll ist nur für Administratoren lesbar: sonst „Unauthorized“-Fehler im Log bei jedem Abruf
    if (!hass || !wanted || this._logBusy || !hass.user?.is_admin) return;
    if (!force && this._logTs && Date.now() - this._logTs < 120000) return;
    this._logBusy = true;
    try {
      const list = await hass.callWS({ type: 'system_log/list' });
      this._log = (list || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      this._logErr = '';
    } catch (err) {
      this._log = this._log || [];
      this._logErr = err && err.code === 'unauthorized' ? 'Nur für Administratoren verfügbar.' : (err.message || String(err));
    } finally {
      this._logTs = Date.now(); this._logBusy = false;
      const lv = (e) => String(e.level || '').toUpperCase();
      this._logSum = { err: this._log.filter((e) => ['ERROR', 'CRITICAL'].includes(lv(e))).length, warn: this._log.filter((e) => lv(e) === 'WARNING').length };
      if (this._hass) { this._renderLinks(); if (['log', 'integrations'].includes(this._pop?.key)) this._updatePopup(); }
    }
  }

  /* ---------- Integrationen: Konfigurationseinträge, Reparaturen, Überwachung (nur Admins) ---------- */
  async _fetchSys(force) {
    const hass = this._hass;
    if (!hass?.user?.is_admin || this._sysBusy) return;
    if (!force && this._sysTs && Date.now() - this._sysTs < 60000) return;
    this._sysBusy = true;
    try {
      const [entries, issues] = await Promise.all([
        hass.callWS({ type: 'config_entries/get' }).catch(() => this._entries || []),
        hass.callWS({ type: 'repairs/list_issues' }).then((r) => r.issues || []).catch(() => this._issues || []),
      ]);
      this._entries = entries; this._issues = issues;
      if (this._monSel === undefined) {
        const r = await hass.callWS({ type: 'frontend/get_user_data', key: 'hmc_integrations' }).catch(() => null);
        this._monSel = Array.isArray(r?.value) ? r.value : null;
      }
      const doms = [...new Set(entries.map((e) => e.domain))].filter((d) => !(this._manifests || {})[d]);
      if (doms.length) {
        const list = await hass.callWS({ type: 'manifest/list', integrations: doms }).catch(() => []);
        this._manifests = { ...(this._manifests || {}), ...Object.fromEntries(list.map((m) => [m.domain, m])) };
      }
    } finally {
      this._sysTs = Date.now(); this._sysBusy = false;
      if (this._hass) { this._renderStatus(); this._renderLinks(); if (['maint', 'integrations'].includes(this._pop?.key)) this._updatePopup(); }
    }
  }

  /** Konfigurationseinträge mit Fehler (nicht deaktiviert) */
  _entryErrors() {
    return (this._entries || []).filter((e) => !e.disabled_by && ['setup_error', 'setup_retry', 'migration_error', 'failed_unload'].includes(e.state));
  }

  /** offene Neustarts: Reparaturmeldungen, die einen Neustart verlangen */
  _restarts() {
    return (this._issues || []).filter((i) => !i.dismissed_version && !i.ignored
      && /restart/i.test(`${i.issue_id} ${i.translation_key || ''}`));
  }

  _intName(domain) { return this._manifests?.[domain]?.name || (this._entries || []).find((e) => e.domain === domain)?.title || domain; }

  /** überwachte Integrationen: eigene Auswahl oder Integrationen aus Links und Herstellerkarten */
  /** Helfer für die Auswahl (gemeinsam mit der Überwachung in Home Assistant), sonst Benutzerdaten */
  _monEntity() {
    const id = this._config.monitor_entity || 'input_text.integrationen_ueberwachung';
    return this._hass?.states[id] ? id : null;
  }

  _monDomains() {
    const me = this._monEntity();
    if (me) {
      const v = String(this._hass.states[me].state || '');
      if (!['unknown', 'unavailable'].includes(v)) return v.split(',').map((x) => x.trim()).filter(Boolean).sort();
    }
    if (Array.isArray(this._monSel)) return this._monSel;
    const d = new Set([...(this._config.links || []).map((l) => l.integration), ...(this._config.makers || []).map((m) => m.integration)].filter(Boolean));
    return [...d].sort();
  }

  _logOf(domain) {
    const re = new RegExp(`(^|\\.)(components|custom_components)\\.${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.|$)`);
    // Bibliotheken, die unter eigenem Logger-Namen schreiben, ihrer Integration zuordnen
    const LIBS = { aioesphomeapi: 'esphome', aioshelly: 'shelly', hatasmota: 'tasmota', proxmoxer: 'proxmoxve', hole: 'pi_hole',
      pymiele: 'miele_lan', pysenec: 'senec', reolink_aio: 'reolink', ...(this._config.log_libraries || {}) };
    return (this._log || []).filter((e) => re.test(e.name || '') || LIBS[String(e.name || '').split('.')[0]] === domain
      || (e.source || []).some((x) => typeof x === 'string' && x.includes(`/${domain}/`)));
  }

  /** Zustand einer Integration: Einträge, Geräte, Log */
  _monitor(domain) {
    const hass = this._hass;
    const entries = (this._entries || []).filter((e) => e.domain === domain && !e.disabled_by);
    const bad = entries.filter((e) => ['setup_error', 'setup_retry', 'migration_error', 'failed_unload'].includes(e.state));
    const devStates = {};
    for (const e of Object.values(hass.entities || {})) {
      if (e.platform !== domain || !e.device_id) continue;
      const st = hass.states[e.entity_id]; if (!st) continue;
      (devStates[e.device_id] ||= []).push(st);
    }
    const devs = Object.keys(devStates).filter((id) => hass.devices[id] && !hass.devices[id].disabled_by);
    const off = devs.filter((id) => devStates[id].every((s) => s.state === 'unavailable'));
    const log = this._logOf(domain);
    const lv = (e) => String(e.level || '').toUpperCase();
    const TO = /time(d)?[ -]?out|timeouterror|clientconnectorerror|cannot connect|connection (refused|reset|error|lost)|unreachable|not reachable|nicht erreichbar|no route to host|server disconnected|failed to connect/i;
    const txt = (e) => `${(e.message || []).join(' ')} ${e.exception || ''}`;
    const errs = log.filter((e) => ['ERROR', 'CRITICAL'].includes(lv(e)));
    const warns = log.filter((e) => lv(e) === 'WARNING');
    const timeouts = log.filter((e) => TO.test(txt(e)));
    const recent = (l) => l.filter((e) => Date.now() / 1000 - (e.timestamp || 0) < 3600);
    const tcount = timeouts.reduce((a, e) => a + (e.count || 1), 0);
    let lvl = 0;
    if (recent(warns).length || recent(timeouts).length || off.length) lvl = 1;
    if (bad.length || recent(errs).length || (devs.length && off.length === devs.length)) lvl = 2;
    if (!entries.length) lvl = 2;
    return { domain, entries, bad, devs, off, log, errs, warns, timeouts, tcount, lvl };
  }

  /* ---------- Grundgerüst ---------- */
  _build() {
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
      <div class="page">
        <aside class="side"><div id="hdr"></div><div id="awtrix" class="aw" hidden></div><div id="stat" class="stat"></div></aside>
        <main class="main">
          <section id="haussec"><h2>Haus</h2><div id="haus" class="card haus click" data-pop="power"></div></section>
          <div class="cols">
            <section id="linksec"><h2><span>Seiten</span><span class="seg" id="lkseg" hidden><button type="button" data-lg="devices" title="Geräte"><ha-icon icon="mdi:devices"></ha-icon><span class="t">Geräte</span><i></i></button><button type="button" data-lg="links" title="Links"><ha-icon icon="mdi:link-variant"></ha-icon><span class="t">Links</span><i></i></button></span></h2><div id="links" class="links"></div></section>
            <section><h2>Räume <small id="rcount"></small></h2><div id="rooms" class="rooms"></div></section>
          </div>
        </main>
      </div>`;
    this.shadowRoot.querySelector('.page').addEventListener('click', (e) => this._onClick(e));
  }

  _set(id, html) {
    this._last = this._last || {};
    if (this._last[id] === html) return false;
    this._last[id] = html;
    morph(this.shadowRoot.getElementById(id), html);
    return true;
  }

  /* ---------- Daten ---------- */
  _areas() {
    const ex = new Set(this._config.exclude_areas || []);
    return Object.values(this._hass.areas || {}).filter((a) => !ex.has(a.area_id)).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Sichtbare Entitäten je Bereich, ohne Entitäten ausgeblendeter Geräte */
  _byArea() {
    const hass = this._hass;
    if (this._baFor !== hass.entities || this._baDev !== hass.devices || this._baHide !== HIDE.ver) {
      this._baFor = hass.entities; this._baDev = hass.devices; this._baHide = HIDE.ver;
      const map = {};
      for (const e of Object.values(hass.entities || {})) {
        if (e.hidden || e.entity_category) continue;
        if (HIDE.hidden(e)) continue;
        const a = e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id);
        if (a) (map[a] ||= []).push(e.entity_id);
      }
      this._ba = map;
    }
    return this._ba;
  }

  _areaStates(areaId) { return (this._byArea()[areaId] || []).map((id) => this._hass.states[id]).filter(Boolean); }

  _climate(area, sts) {
    const hass = this._hass;
    const pick = (dc) => sts.filter((s) => s.entity_id.startsWith('sensor.') && s.attributes.device_class === dc && num(s) != null);
    const avg = (l) => (l.length ? l.reduce((a, s) => a + num(s), 0) / l.length : null);
    const t = num(hass.states[area.temperature_entity_id]); const h = num(hass.states[area.humidity_entity_id]);
    return { temp: t ?? avg(pick('temperature')), hum: h ?? avg(pick('humidity')) };
  }

  _powerId(area) { return this._config.area_power[area.area_id] || `sensor.leistung_${area.area_id}`; }

  _all() {
    const hass = this._hass;
    const out = { lights: [], switches: [], open: [], heat: [], climate: [], covers: [], updates: [], battery: [], offline: [] };
    const devStates = {};
    for (const e of Object.values(hass.entities || {})) {
      const st = hass.states[e.entity_id];
      if (!st || e.hidden) continue;
      if (HIDE.hidden(e)) continue;
      const dom = e.entity_id.split('.')[0];
      const dc = st.attributes.device_class;
      if (e.device_id && !e.entity_category) (devStates[e.device_id] ||= []).push(st);
      if (dom === 'update') { if (st.state === 'on') out.updates.push(st); continue; }
      if (dc === 'battery') {
        const v = num(st);
        if ((dom === 'sensor' && v != null && v <= this._config.battery_low) || (dom === 'binary_sensor' && st.state === 'on')) out.battery.push(st);
        continue;
      }
      if (e.entity_category) continue;
      if (dom === 'switch') { if (!BAD.includes(st.state) && (dc === 'outlet' || SW_LOAD.test(`${this._name(st)} ${e.entity_id}`))) out.switches.push(st); } else if (dom === 'light') { if (st.state === 'on') out.lights.push(st); } else if (dom === 'binary_sensor') { if (OPEN_DC.includes(dc) && st.state === 'on') out.open.push(st); } else if (dom === 'climate') {
        if (!BAD.includes(st.state)) { out.climate.push(st); if (HEAT.includes(st.attributes.hvac_action)) out.heat.push(st); }
      } else if (dom === 'cover' && ['open', 'opening'].includes(st.state)) out.covers.push(st);
    }
    for (const [devId, sts] of Object.entries(devStates)) {
      const d = hass.devices[devId];
      if (!d || d.disabled_by || d.entry_type === 'service') continue;
      if (sts.every((s) => s.state === 'unavailable')) out.offline.push({ devId, d });
    }
    return out;
  }

  _warnings() {
    const out = [];
    const SEV = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
    const lvlOf = (w) => (w.level != null ? Number(w.level) : SEV[String(w.severity || '').toLowerCase()] ?? 1);
    for (const id of this._config.warnings || []) {
      const st = this._hass.states[id];
      if (!st) continue;
      const a = st.attributes;
      if (Array.isArray(a.warnings)) {
        // DWD-Integration und „Wetter & Warnungen“ (NINA): Liste der Warnungen im Attribut warnings
        for (const w of a.warnings) {
          out.push({ src: id, level: lvlOf(w), name: w.event || w.name || '', headline: w.headline || '', description: w.description || '',
            instruction: w.instruction || w.recommended_actions || '', start: w.start || w.onset, end: w.end || w.expires, color: w.color });
        }
      } else {
        const n = Number(a.warning_count || 0);
        for (let i = 1; i <= n; i++) {
          out.push({ src: id, level: Number(a[`warning_${i}_level`] ?? st.state ?? 0), name: a[`warning_${i}_name`] || '', headline: a[`warning_${i}_headline`] || '',
            description: a[`warning_${i}_description`] || '', instruction: a[`warning_${i}_instruction`] || '', start: a[`warning_${i}_start`], end: a[`warning_${i}_end`], color: a[`warning_${i}_color`] });
        }
      }
    }
    // abgelaufene Warnungen weglassen, gleiche Warnung aus mehreren Sensoren nur einmal
    const now = Date.now();
    const seen = new Set();
    return out.filter((w) => {
      const end = w.end ? new Date(w.end).getTime() : NaN;
      if (Number.isFinite(end) && end < now) return false;
      const k = `${w.headline}|${w.start}`; if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => b.level - a.level || String(a.start || '').localeCompare(String(b.start || '')));
  }

  _areaOf(entityId) {
    const hass = this._hass;
    const e = hass.entities[entityId];
    const a = e && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id));
    return (a && hass.areas[a]?.name) || '';
  }

  _name(st) { return st.attributes.friendly_name || this._hass.entities[st.entity_id]?.name || st.entity_id; }

  /* ---------- Rendering ---------- */
  _render() {
    if (!this._hass) return;
    this._data = this._all();
    this._renderHeader();
    this._renderStatus();
    this._renderHaus();
    this._renderLinks();
    this._renderRooms();
  }

  _renderHeader() {
    const hass = this._hass;
    if (!hass) return;
    const now = new Date();
    const h = now.getHours();
    // Person des angemeldeten Benutzers; die konfigurierte Person nur, wenn sie zu ihm gehört oder kein Benutzer bekannt ist
    const persons = Object.values(hass.states).filter((s) => s.entity_id.startsWith('person.'));
    const conf = hass.states[this._config.person];
    const p = (hass.user && persons.find((s) => s.attributes.user_id === hass.user.id))
      || (!hass.user || conf?.attributes.user_id === hass.user?.id ? conf : null);
    this._personId = p?.entity_id || '';
    const first = (p?.attributes.friendly_name || hass.user?.name || '').split(' ')[0];
    const greet = `${h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'}${first ? `, ${first}` : ''}`;
    const w = hass.states[this._config.weather];
    const pic = p?.attributes.entity_picture;
    const t = w?.attributes.temperature;
    const kw = (() => { const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())); const dn = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dn); const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return Math.ceil(((d - y0) / 86400000 + 1) / 7); })();
    const clock = `<div class="clock"><b>${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</b><small>${esc(now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))}</small><small class="kw">KW ${kw}</small></div>`;
    const html = `${clock}<div class="hdr">
      <div class="av ${p && p.state !== 'home' ? 'away' : ''}" data-more="${esc(this._personId)}" ${pic ? `style="background-image:url('${esc(pic)}')"` : ''}>${pic ? '' : '<ha-icon icon="mdi:account"></ha-icon>'}</div>
      <div class="greet"><div class="gl"><div class="g">${esc(greet)}</div>
        ${w ? `<div class="wx" data-more="${esc(this._config.weather)}" title="${esc(w.attributes.friendly_name || '')}"><ha-icon icon="${WX[w.state] || 'mdi:weather-cloudy'}"></ha-icon><span>${t != null ? `${nf(t)}°` : '–'}</span></div>` : ''}</div><div class="s">${esc(now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))} · <span class="tm">${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span></div>${this._calHtml()}</div></div>`;
    this._set('hdr', html);
  }

  /** heutige Termine aus den Kalendern (calendars: [...], Standard: alle) */
  _calHtml() {
    const ev = this._cal || [];
    if (!ev.length) return '';
    const now = Date.now();
    const hm = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return `<div class="cal">${ev.map((e) => `<div class="ev ${e.end <= now ? 'past' : ''}" data-more="${esc(e.cal)}" title="${esc(e.summary)}${e.loc ? ` · ${esc(e.loc)}` : ''}">
      <ha-icon icon="${e.allDay ? 'mdi:calendar-today' : 'mdi:clock-outline'}"></ha-icon>${e.allDay ? '' : `<b>${hm(new Date(e.start))}</b>`}<span>${esc(e.summary)}</span></div>`).join('')}</div>`;
  }

  async _fetchCal() {
    const hass = this._hass;
    if (!hass || this._calBusy || (this._calTs && Date.now() - this._calTs < 10 * 60000)) return;
    const ids = this._config.calendars || Object.keys(hass.states).filter((id) => id.startsWith('calendar.'));
    if (!ids.length) return;
    this._calBusy = true;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(d0.getTime() + 24 * 3600000);
    const ms = (v) => new Date(v.dateTime || v.date || v).getTime();
    try {
      const all = [];
      for (const id of ids) {
        try {
          const res = await hass.callApi('GET', `calendars/${id}?start=${encodeURIComponent(d0.toISOString())}&end=${encodeURIComponent(d1.toISOString())}`);
          for (const e of res || []) {
            const allDay = !!(e.start?.date && !e.start?.dateTime);
            all.push({ cal: id, summary: e.summary || '(ohne Titel)', loc: e.location || '', allDay, start: allDay ? d0.getTime() : ms(e.start), end: allDay ? d1.getTime() : ms(e.end) });
          }
        } catch (err) { /* Kalender nicht lesbar */ }
      }
      this._cal = all.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start).slice(0, this._config.calendar_max || 6);
      this._calTs = Date.now();
      this._renderHeader();
    } finally { this._calBusy = false; }
  }

  /** AWTRIX-Uhren in der Seitenleiste (awtrix: [{ entity, request_topic, name }]) */
  _renderAwtrix() {
    const box = this.shadowRoot.getElementById('awtrix');
    const list = this._config.awtrix || [];
    if (!box) return;
    box.hidden = !list.length || !customElements.get('awtrix-screen-card');
    if (box.hidden) return;
    const key = JSON.stringify(list);
    if (this._awKey !== key) {
      this._awKey = key;
      box.innerHTML = '';
      this._aw = list.map((c) => { const el = document.createElement('awtrix-screen-card'); el.setConfig({ bare: true, ...c }); box.appendChild(el); return el; });
    }
    for (const el of this._aw || []) el.hass = this._hass;
  }

  _renderStatus() {
    const hass = this._hass;
    const d = this._data;
    const items = [];
    // Kacheln mit aktiven Geräten pulsieren wie die DWD-Warnung
    const BLINK = ['lights', 'heat', 'open', 'covers', 'switches'];
    const si = (k, icon, color, label, n, on, alert = false, act = 'pop', blink = on && BLINK.includes(k)) => items.push(`<div class="card si click ${on ? 'on' : ''} ${alert ? 'alert' : ''} ${blink ? 'blink' : ''}" data-k="${k}"
      ${act === 'pop' ? `data-pop="${k}"` : `data-more="${esc(act)}"`} style="--c:${color}">
      <div class="bub"><ha-icon icon="${icon}"></ha-icon></div>${n ? `<span class="cnt">${n}</span>` : ''}<div class="l">${esc(label)}</div></div>`);
    si('lights', d.lights.length ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline', '#ffc107', d.lights.length ? 'Licht an' : 'Licht aus', d.lights.length, d.lights.length > 0);
    si('heat', d.heat.length ? 'mdi:radiator' : 'mdi:radiator-off', '#ff6f22', d.heat.length ? 'Heizung aktiv' : 'Heizung aus', d.heat.length, d.heat.length > 0);
    si('open', d.open.length ? 'mdi:window-open-variant' : 'mdi:window-closed-variant', '#2196f3', d.open.length ? 'Fenster offen' : 'Fenster zu', d.open.length, d.open.length > 0);
    si('covers', d.covers.length ? 'mdi:window-shutter-open' : 'mdi:window-shutter', '#9c27b0', d.covers.length ? 'Rollos offen' : 'Rollos zu', d.covers.length, d.covers.length > 0);
    if (this._config.switches !== false && d.switches.length) {
      const n = d.switches.filter((x) => x.state === 'on').length;
      si('switches', n ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off-outline', '#4caf50', n ? 'Schalter an' : 'Schalter aus', n, n > 0);
    }
    const maint = d.updates.length + d.battery.length + d.offline.length + this._entryErrors().length + this._restarts().length;
    si('maint', 'mdi:wrench', '#ffa600', maint ? 'Wartung' : 'Alles ok', maint, maint > 0);
    const v = hass.states[this._config.valve];
    if (v) {
      const open = ['open', 'opening', 'on'].includes(v.state);
      const bad = BAD.includes(v.state);
      si('valve', open ? 'mdi:valve-open' : 'mdi:valve-closed', open ? '#00bcd4' : '#f44336', bad ? 'Ventil ?' : open ? 'Ventil offen' : 'Ventil zu', 0, !bad, !open && !bad, this._config.valve, open);
    }
    if ((this._config.warnings || []).length) {
      const ws = this._warnings();
      // nur bei aktiven Warnungen, immer rot
      if (ws.length) si('dwd', 'mdi:alert', '#f44336', ws.length === 1 ? 'DWD-Warnung' : 'DWD-Warnungen', ws.length, true, Math.max(...ws.map((w) => w.level)) >= 3);
    }
    this._set('stat', items.join(''));
  }

  _renderHaus() {
    const hass = this._hass;
    if (!hass) return;
    const pw = this._config.power || {};
    const house = num(hass.states[pw.house]); const pv = num(hass.states[pw.pv]); const grid = num(hass.states[pw.grid]);
    const bat = num(hass.states[pw.battery]); const soc = num(hass.states[pw.battery_soc]);
    const vals = [];
    const val = (icon, color, title, v, sub, more) => vals.push(`<div class="val" ${more ? `data-more="${esc(more)}"` : ''} style="--c:${color}"><ha-icon icon="${icon}"></ha-icon><div><b>${v}</b><small>${esc(title)}${sub ? ` · ${esc(sub)}` : ''}</small></div></div>`);
    if (pv != null) val('mdi:solar-power-variant', '#ffc107', 'PV', fW(pv), '', pw.pv);
    if (bat != null || soc != null) {
      // Vorzeichen wie Energy Dashboard: positiv = Entladen, negativ = Laden
      const icon = soc == null ? 'mdi:battery' : `mdi:battery${bat != null && bat < -5 ? '-charging' : ''}${soc >= 95 ? '' : `-${Math.max(10, Math.round(soc / 10) * 10)}`}`;
      val(icon, '#4caf50', bat != null && bat < -5 ? 'Akku lädt' : bat != null && bat > 5 ? 'Akku entlädt' : 'Akku',
        bat != null ? fW(Math.abs(bat)) : '–', soc != null ? `${nf(soc, 0)} %` : '', pw.battery_soc || pw.battery);
    }
    if (grid != null) val(grid < 0 ? 'mdi:transmission-tower-import' : 'mdi:transmission-tower-export', '#9c27b0', grid < 0 ? 'Einspeisung' : 'Netzbezug', fW(Math.abs(grid)), '', pw.grid);
    const fc = this._fc;
    if (fc) val('mdi:weather-sunny-alert', '#ffb300', 'Prognose heute', `${nf(fc.total / 1000, 1)} kWh`, fc.rest != null ? `noch ${nf(fc.rest / 1000, 1)} kWh` : '', '');
    const html = `<div class="hh"><div class="bub"><ha-icon icon="mdi:home-lightning-bolt"></ha-icon></div>
        <div class="t"><small>Stromverbrauch</small><b>${fW(house)}</b></div><div class="vals">${vals.join('')}</div></div>
      <div class="chart">${this._chart()}</div>
      <div class="ax"><span>0 Uhr</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
      <div class="leg"><span><i style="background:#f44336"></i>Verbrauch</span><span><i style="background:#ffc107"></i>PV</span>${pw.grid ? '<span><i style="background:#9c27b0"></i>Netz (Bezug + / Einspeisung −)</span>' : ''}${fc || pw.forecast ? '<span><i style="background:repeating-linear-gradient(90deg,#4caf50 0 6px,transparent 6px 10px)"></i>PV-Prognose</span>' : ''}${pw.clearsky ? '<span><i style="background:repeating-linear-gradient(90deg,var(--secondary-text-color) 0 3px,transparent 3px 7px)"></i>Clearsky</span>' : ''}</div>`;
    this._set('haus', html);
  }

  /** Tageskurve aus dem Attribut forecast eines Sensors ([{ datetime, watts | watts_clearsky }]) */
  _attrCurve(id, key) {
    const st = id && this._hass.states[id];
    const list = st && Array.isArray(st.attributes.forecast) ? st.attributes.forecast : null;
    if (!list) return null;
    const pts = list.map((p) => ({ t: new Date(p.datetime || p.period_start || p.time).getTime(), v: Number(p[key] ?? p.watts ?? p.value) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
    return pts.length ? pts : null;
  }

  _chart() {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const t0 = day0.getTime(); const span = 24 * 3600000;
    const W = 1000; const H = 100;
    const pw = this._config.power || {};
    const series = (id) => (this._hist?.[id] || []).filter((p) => p.t >= t0);
    const use = series(pw.house); const pv = series(pw.pv);
    // Netz mit Vorzeichen: Bezug oberhalb, Einspeisung unterhalb der Nulllinie
    const grid = series(pw.grid);
    const inDay = (pts) => (pts || []).filter((p) => p.t >= t0 && p.t <= t0 + span);
    const fc = inDay(this._attrCurve(pw.forecast, 'watts') || this._fc?.points);
    const cs = inDay(this._attrCurve(pw.clearsky, 'watts_clearsky'));
    const hi = Math.max(500, ...use.map((p) => p.v), ...pv.map((p) => p.v), ...grid.map((p) => p.v), ...fc.map((p) => p.v), ...cs.map((p) => p.v)) * 1.08;
    const lo = Math.min(0, ...grid.map((p) => p.v)) * 1.08;
    const x = (t) => (((t - t0) / span) * W).toFixed(1);
    const y = (v) => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
    const yv = (v) => y(Math.max(0, v)); // Verbrauch, PV, Prognose nie unter null
    const line = (pts, f = yv) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${f(p.v)}`).join('');
    const y0 = y(0);
    const now = Date.now();
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">`;
    for (const f of [0.25, 0.5, 0.75]) svg += `<line x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}"/>`;
    svg += '</g>';
    if (lo < 0) svg += `<line class="zero" x1="0" x2="${W}" y1="${y0}" y2="${y0}"/>`;
    if (pv.length > 1) svg += `<path class="pv" d="${line(pv)}L${x(pv[pv.length - 1].t)},${y0}L${x(pv[0].t)},${y0}Z"/>`;
    if (cs.length > 1) svg += `<path class="cs" d="${line(cs)}"/>`;
    if (fc.length > 1) svg += `<path class="fc" d="${line(fc)}"/>`;
    if (grid.length > 1) svg += `<path class="grd" d="${line(grid, y)}L${x(grid[grid.length - 1].t)},${y0}L${x(grid[0].t)},${y0}Z"/>`;
    if (use.length > 1) svg += `<path class="use" d="${line(use)}"/>`;
    svg += `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="0" y2="${H}"/></svg>`;
    return `${svg}<span class="ymax">${fW(hi / 1.08)}</span>${lo < 0 ? `<span class="ymin">−${fW(-lo / 1.08)}</span>` : ''}`;
  }

  async _fetchHist() {
    const hass = this._hass;
    if (!hass || this._histBusy || (this._histTs && Date.now() - this._histTs < 5 * 60000)) return;
    const pw = this._config.power || {};
    const main = [pw.house, pw.pv, pw.grid].filter((id) => id && hass.states[id]);
    const rooms = this._areas().map((a) => this._powerId(a)).filter((id) => id && hass.states[id] && !main.includes(id));
    if (!main.length && !rooms.length) return;
    this._histBusy = true;
    const end = new Date(); const start = new Date(end.getTime() - 24 * 3600000);
    const bucket = 5 * 60000;
    this._hist = this._hist || {};
    // 1. Langzeitstatistik (5-Minuten-Mittelwerte): schnell, auch bei Sensoren mit sehr vielen Zustandswechseln
    const fromStats = async (ids) => {
      if (!ids.length) return [];
      try {
        const res = await hass.callWS({ type: 'recorder/statistics_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
          statistic_ids: ids, period: '5minute', types: ['mean'] });
        const ok = [];
        for (const id of ids) {
          const rows = (res || {})[id] || [];
          if (rows.length < 2) continue;
          const pts = rows.map((r) => ({ t: (typeof r.start === 'number' ? r.start : new Date(r.start).getTime()) + bucket / 2, v: Number(r.mean) }))
            .filter((p) => Number.isFinite(p.v));
          const cur = num(hass.states[id]);
          if (cur != null) pts.push({ t: end.getTime(), v: cur });
          this._hist[id] = pts; ok.push(id);
        }
        return ok;
      } catch (err) { return []; }
    };
    // 2. Rest über die Zustandshistorie, auf 5-Minuten-Raster gemittelt
    const fromHistory = async (ids) => {
      if (!ids.length) return;
      const res = await hass.callWS({ type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false });
      for (const [id, rows] of Object.entries(res || {})) {
        const agg = new Map();
        for (const r of rows) {
          const v = parseFloat(r.s);
          if (Number.isNaN(v)) continue;
          const t = Math.max(start.getTime(), (r.lu ?? r.lc ?? 0) * 1000);
          const k = Math.floor(t / bucket) * bucket;
          const a = agg.get(k) || { s: 0, n: 0 }; a.s += v; a.n++; agg.set(k, a);
        }
        this._hist[id] = [...agg.entries()].sort((a, b) => a[0] - b[0]).map(([t, a]) => ({ t: t + bucket / 2, v: a.s / a.n }));
      }
    };
    const run = async (ids, after) => {
      const ok = await fromStats(ids);
      await fromHistory(ids.filter((id) => !ok.includes(id)));
      after();
    };
    try {
      // Hauskurve zuerst, Räume danach – das große Diagramm erscheint so ohne auf die Räume zu warten
      await run(main, () => this._hass && this._renderHaus());
      await run(rooms, () => this._hass && this._renderRooms());
    } catch (err) {
      console.info('home-dashboard-card: Verlauf nicht abrufbar', err);
    } finally {
      this._histTs = Date.now(); this._histBusy = false;
      if (this._hass) { this._renderHaus(); this._renderRooms(); }
    }
  }

  async _fetchForecast() {
    const hass = this._hass;
    if (!hass || !this._config.solar_forecast || this._fcBusy || (this._fcTs && Date.now() - this._fcTs < 30 * 60000)) return;
    this._fcBusy = true;
    try {
      const res = await hass.callWS({ type: 'energy/solar_forecast' });
      const hours = new Map();
      for (const entry of Object.values(res || {})) {
        for (const [ts, wh] of Object.entries(entry.wh_hours || {})) {
          const t = new Date(ts).getTime();
          hours.set(t, (hours.get(t) || 0) + Number(wh || 0));
        }
      }
      const day0 = new Date(); day0.setHours(0, 0, 0, 0);
      const t0 = day0.getTime(); const t1 = t0 + 24 * 3600000; const now = Date.now();
      const today = [...hours.entries()].filter(([t]) => t >= t0 && t < t1).sort((a, b) => a[0] - b[0]);
      if (today.length) {
        // Wh je Stunde = mittlere Leistung in W; Punkt in die Stundenmitte
        const points = [{ t: t0, v: 0 }, ...today.map(([t, wh]) => ({ t: t + 1800000, v: wh })), { t: t1, v: 0 }];
        const total = today.reduce((s, [, wh]) => s + wh, 0);
        const rest = today.reduce((s, [t, wh]) => s + (t + 3600000 <= now ? 0 : t >= now ? wh : wh * ((t + 3600000 - now) / 3600000)), 0);
        this._fc = { points, total, rest };
      } else this._fc = null;
    } catch (err) {
      console.info('home-dashboard-card: PV-Prognose nicht abrufbar', err);
      this._fc = null;
    } finally {
      this._fcTs = Date.now(); this._fcBusy = false;
      if (this._hass) this._renderHaus();
    }
  }

  _linkStats(integration) {
    const hass = this._hass;
    this._lsCache = this._lsFor === hass.states && this._lsEnt === hass.entities ? this._lsCache : {};
    this._lsFor = hass.states; this._lsEnt = hass.entities;
    if (this._lsCache[integration]) return this._lsCache[integration];
    const devs = {}; let upd = 0; let act = 0;
    for (const e of Object.values(hass.entities || {})) {
      if (e.platform !== integration || !e.device_id || e.hidden) continue;
      const st = hass.states[e.entity_id];
      if (!st) continue;
      const dom = e.entity_id.split('.')[0];
      if (dom === 'update') { if (st.state === 'on' && !/beta/.test(e.entity_id)) upd++; continue; }
      if (e.entity_category) continue;
      (devs[e.device_id] ||= []).push(st);
      if ((['switch', 'light', 'fan'].includes(dom) && st.state === 'on') || (dom === 'climate' && HEAT.includes(st.attributes.hvac_action))
        || (dom === 'media_player' && st.state === 'playing') || (dom === 'vacuum' && st.state === 'cleaning')
        || (dom === 'binary_sensor' && st.attributes.device_class === 'running' && st.state === 'on')) act++;
    }
    let ids = Object.keys(devs).filter((id) => hass.devices[id] && !hass.devices[id].disabled_by);
    // Volumes/Laufwerke eines NAS sind keine eigenen Geräte
    if (window.__hmcActRaw) ids = ids.filter((id) => !window.__hmcActRaw(hass, id).sub);
    // Ultimate Updater: verwaltete Systeme zählen; Badge = Systeme mit Updates oder Neustartbedarf, Farbe = dringendster Zustand
    if (window.__hmcUpd && integration === 'ultimate_updater') {
      const us = ids.map((id) => window.__hmcUpd(hass, id)).filter((u) => u.sys);
      const order = ['sec', 'upd', 'reboot', 'ok'];
      const worst = order.find((k) => us.some((u) => u.s === k));
      const col = { sec: 'pw', upd: 'ph', reboot: 'srv', ok: 'sw' }[worst];
      return (this._lsCache[integration] = { n: us.length, off: us.filter((u) => u.s === 'off').length, upd: us.filter((u) => u.s === 'sec' || u.s === 'upd').length,
        act: us.filter((u) => ['sec', 'upd', 'reboot'].includes(u.s)).length, color: col ? window.__hmcColors[col] : null,
        reboot: us.filter((u) => u.reboot).length, unit: 'System' });
    }
    const off = ids.filter((id) => devs[id].every((s) => s.state === 'unavailable')).length;
    // aktive Geräte: mindestens eine Entität eingeschaltet bzw. in Betrieb
    const isAct = (st) => {
      const dom = st.entity_id.split('.')[0]; const s = st.state; const a = st.attributes;
      return (['switch', 'light', 'fan', 'humidifier', 'siren'].includes(dom) && s === 'on')
        || (dom === 'climate' && (HEAT.includes(a.hvac_action) || a.hvac_action === 'cooling'))
        || (dom === 'media_player' && s === 'playing') || (dom === 'vacuum' && s === 'cleaning') || (dom === 'lawn_mower' && s === 'mowing')
        || (dom === 'camera' && ['recording', 'streaming'].includes(s))
        || (dom === 'binary_sensor' && ['running', 'power', 'plug'].includes(a.device_class) && s === 'on')
        || (dom === 'sensor' && /^(running|in_use|programmed|on|active)$/i.test(s) && a.device_class === 'enum');
    };
    // dieselben Geräte, die auf den Seiten eingefärbt sind (gemeinsame Erkennung); Rückfall auf die eigene Prüfung
    // Geräte-Integrationen: dieselben Geräte, die auf den Seiten eingefärbt sind; alle anderen (z. B. Frigate-Kameras) wie bisher
    act = window.__hmcActRaw && AUTO_LINKS.includes(integration)
      ? ids.filter((id) => window.__hmcActRaw(hass, id).a).length
      : ids.filter((id) => devs[id].some(isAct)).length;
    // Linkfarbe aus den Gerätefarben: häufigste Farbe der aktiven Geräte, bei Gleichstand die stärkere (Rangfolge wie in den Räumen)
    let color = null;
    if (window.__hmcActRaw && window.__hmcColors) {
      const cnt = {};
      for (const id of ids) { const a = window.__hmcActRaw(hass, id).a; if (a) cnt[a] = (cnt[a] || 0) + 1; }
      const rank = window.__hmcRank || [];
      const kind = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x] || rank.indexOf(x) - rank.indexOf(y))[0];
      if (kind) color = window.__hmcColors[kind];
    }
    return (this._lsCache[integration] = { n: ids.length, off, upd, act, color });
  }

  /** eingeschaltete Apps aller AWTRIX-Studio-Panels (Indikatoren zählen nicht) */
  _awtrixApps() {
    const hass = this._hass; let n = 0; let any = false;
    for (const e of Object.values(hass.entities || {})) {
      if (e.platform !== 'awtrix_studio' || !e.entity_id.startsWith('switch.') || /indicator/.test(e.entity_id)) continue;
      const st = hass.states[e.entity_id]; if (!st) continue;
      any = true; if (st.state === 'on') n++;
    }
    return any ? n : null;
  }

  /** Gruppe eines Links: group: devices | links; ohne Angabe Geräte-Integrationen → Geräte, sonst Links */
  _linkGroup(l) { return l.group || (l.integration && DEVICE_LINKS.includes(l.integration) ? 'devices' : 'links'); }

  _renderLinks() {
    const hass = this._hass;
    const links = this._config.links || [];
    // Umschalter Geräte/Links, sobald beide Gruppen Einträge haben (Auswahl je Browser gemerkt)
    if (!this._lg) { try { this._lg = localStorage.getItem('hmc-linkgroup') || 'devices'; } catch (e) { this._lg = 'devices'; } }
    const groups = new Set(links.map((l) => this._linkGroup(l)));
    const split = this._config.link_switch !== false && groups.has('devices') && groups.has('links');
    const warnOf = { devices: 0, links: 0 }; const errOf = { devices: false, links: false };
    const html = links.map((l, i) => {
      const grp = this._linkGroup(l);
      // Nur für Administratoren: admin: true, Log- und Integrations-Popup, Integrationen aus admin_only
      if (!hass.user?.is_admin && (l.admin || ['log', 'integrations'].includes(l.popup)
        || (l.integration && (this._config.admin_only || []).includes(l.integration)))) return '';
      // Links zu Integrationen ohne Geräte (nicht installiert) ausblenden, außer show_empty: true
      if (l.integration && !l.show_empty && !this._linkStats(l.integration).n) return '';
      const info = [];
      if (l.integration) {
        const s = this._linkStats(l.integration);
        if (s.unit) {
          info.push(`${s.n} ${s.unit}${s.n === 1 ? '' : 'e'}`);
          info.push(s.upd ? `<span class="warn">${s.upd} mit Updates</span>` : '<span class="ok">alle aktuell</span>');
          if (s.reboot) info.push(`<span class="warn">${s.reboot} Neustart</span>`);
          if (s.off) info.push(`<span class="err">${s.off} nicht erreichbar</span>`);
        } else {
          // unit: eigene Bezeichnung statt „Gerät“ (z. B. Panel für AWTRIX), Mehrzahl mit -s
          info.push(l.unit ? `${s.n} ${esc(l.unit)}${s.n === 1 ? '' : 's'}` : `${s.n} Gerät${s.n === 1 ? '' : 'e'}`);
          if (l.integration === 'awtrix_studio') { const on = this._awtrixApps(); if (on != null) info.push(`${on} App${on === 1 ? '' : 's'} an`); }
          if (s.n) info.push(...(s.off ? [`<span class="ok">${s.n - s.off} online</span>`, `<span class="err">${s.off} offline</span>`] : ['<span class="ok">alle online</span>']));
          if (s.upd) info.push(`<span class="warn">${s.upd} Update${s.upd === 1 ? '' : 's'}</span>`);
        }
      }
      if (l.entity && hass.states[l.entity]) {
        const st = hass.states[l.entity];
        info.push(esc(typeof hass.formatEntityState === 'function' ? hass.formatEntityState(st) : st.state));
      }
      if (l.popup === 'log') {
        const s = this._logSum;
        if (!s) info.push('Home Assistant Log');
        else if (s.err) info.push(`<span class="err">${s.err} Fehler</span>`, ...(s.warn ? [`<span class="warn">${s.warn} Warnung${s.warn === 1 ? '' : 'en'}</span>`] : []));
        else info.push(s.warn ? `<span class="warn">${s.warn} Warnung${s.warn === 1 ? '' : 'en'}</span>` : '<span class="ok">keine Fehler</span>');
      }
      let badge = '';
      if (l.integration) {
        const ls = this._linkStats(l.integration); const a = ls.act;
        if (l.badge === 'count' && ls.n) badge = `<span class="bdg" title="${ls.n} ${esc(l.unit || 'Gerät')}${ls.n === 1 ? '' : (l.unit ? 's' : 'e')}">${ls.n}</span>`;
        else if (a) badge = ls.unit ? `<span class="bdg ${ls.color === window.__hmcColors?.pw ? 'err' : 'warn'}" title="${a} ${ls.unit}${a === 1 ? '' : 'e'} mit Updates oder Neustartbedarf">${a}</span>` : `<span class="bdg" title="${a} aktiv">${a}</span>`;
      }
      if (l.popup === 'integrations' && this._entries) {
        const ms = this._monDomains().map((d) => this._monitor(d));
        const e = ms.filter((m) => m.lvl === 2).length; const w = ms.filter((m) => m.lvl === 1).length;
        info.push(e ? `<span class="err">${e} gestört</span>` : w ? `<span class="warn">${w} mit Warnungen</span>` : `<span class="ok">${ms.length} ok</span>`);
        if (e || w) badge = `<span class="bdg ${e ? 'err' : 'warn'}">${e + w}</span>`;
      } else if (l.popup === 'integrations') info.push('Überwachung');
      if (l.text) info.push(esc(l.text));
      // Integrationslinks: Farbe aus den aktiven Geräten (auto_color: false behält die eingestellte Farbe); sonst eingestellte Farbe
      // ohne aktives Gerät grau (alles aus bzw. deaktiviert)
      const isAuto = l.integration && (l.auto_color ?? AUTO_LINKS.includes(l.integration));
      const auto = isAuto ? this._linkStats(l.integration).color || 'var(--disabled-color, #9e9e9e)' : null;
      // Hinweiszahl am Umschalter: Fehler/Warnungen (rote/orange Badges) der jeweils ausgeblendeten Gruppe
      if (/bdg (err|warn)/.test(badge)) { warnOf[grp] += Number((badge.match(/>(\d+)</) || [])[1]) || 1; if (/bdg err/.test(badge)) errOf[grp] = true; }
      if (split && grp !== this._lg) return '';
      return `<div class="card lk click" data-k="l${i}" data-link="${i}" style="--c:${esc(auto || l.color || 'var(--primary-color)')}">
        <div class="bub">${badge}<ha-icon icon="${esc(l.icon || 'mdi:open-in-app')}"></ha-icon></div>
        <div class="n"><b>${esc(l.name || l.path)}</b><span>${info.join(' · ')}</span></div><ha-icon icon="mdi:chevron-right"></ha-icon></div>`;
    }).join('');
    this._set('links', html);
    const seg = this.shadowRoot.getElementById('lkseg');
    seg.hidden = !split; seg.parentNode.classList.toggle('has-seg', split);
    for (const b of seg.querySelectorAll('button')) {
      const g = b.dataset.lg; b.classList.toggle('on', g === this._lg);
      const n = g === this._lg ? '' : String(warnOf[g] || ''); const i = b.querySelector('i');
      if (i.textContent !== n) i.textContent = n; i.classList.toggle('err', errOf[g]);
    }
    this.shadowRoot.getElementById('linksec').hidden = !html && !split;
  }

  _spark(id) {
    const pts = this._hist?.[id];
    if (!pts || pts.length < 2) return '';
    const end = Date.now(); const t0 = end - 24 * 3600000; const span = end - t0;
    const hi = Math.max(...pts.map((p) => p.v), 10) * 1.1;
    const W = 1000; const H = 100;
    let d = '';
    pts.forEach((p, i) => { d += `${i ? 'L' : 'M'}${(((p.t - t0) / span) * W).toFixed(1)},${(H - (Math.max(0, p.v) / hi) * H).toFixed(1)}`; });
    const x0 = (((pts[0].t - t0) / span) * W).toFixed(1); const x1 = (((pts[pts.length - 1].t - t0) / span) * W).toFixed(1);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="a" d="${d}L${x1},${H}L${x0},${H}Z"/><path class="l" d="${d}"/></svg>`;
  }

  _roomIcons(a, sts) {
    const hass = this._hass;
    const of = (dom) => sts.filter((s) => s.entity_id.startsWith(`${dom}.`) && !BAD.includes(s.state));
    const out = [];
    const ic = (icon, color, n, on, title) => out.push(`<span class="ic ${on ? 'on' : ''}" style="--c:${color}" title="${esc(title)}"><ha-icon icon="${icon}"></ha-icon>${n ? n : ''}</span>`);
    const clim = of('climate');
    if (clim.length) { const n = clim.filter((s) => HEAT.includes(s.attributes.hvac_action)).length; ic(n ? 'mdi:radiator' : 'mdi:radiator-off', '#ff6f22', n, n > 0, `${n} von ${clim.length} heizen`); }
    const lights = of('light');
    if (lights.length) { const n = lights.filter((s) => s.state === 'on').length; ic(n ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline', '#ffc107', n, n > 0, `${n} von ${lights.length} Lichtern an`); }
    const sw = of('switch');
    if (sw.length) { const n = sw.filter((s) => s.state === 'on').length; ic(n ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off-outline', '#4caf50', n, n > 0, `${n} von ${sw.length} Schaltern an`); }
    const cov = of('cover');
    if (cov.length) { const n = cov.filter((s) => s.state !== 'closed').length; ic(n ? 'mdi:window-shutter-open' : 'mdi:window-shutter', '#9c27b0', n, n > 0, `${n} von ${cov.length} Rollos offen`); }
    // Mediengeräte nur bei laufender Wiedergabe
    const media = of('media_player').filter((s) => s.state === 'playing');
    if (media.length) ic('mdi:play-circle', '#2196f3', media.length, true, `${media.length} Wiedergabe${media.length > 1 ? 'n' : ''}`);
    const open = sts.filter((s) => s.entity_id.startsWith('binary_sensor.') && OPEN_DC.includes(s.attributes.device_class));
    if (open.some((s) => s.state === 'on')) { const n = open.filter((s) => s.state === 'on').length; ic('mdi:window-open-variant', '#2196f3', n, true, `${n} offen`); }
    // Geräte in derselben Farbe wie ihre Kachel (rot Verbrauch, blau Wasser, lila Server, orange Pi-hole/X-Sense, grün an); aus = kein Symbol
    for (const g of this._appsOf(a.area_id)) {
      ic(g.icon, g.color, g.n, true, `${g.name}: ${g.n} an${g.act ? `, ${g.act} aktiv` : ''}`);
    }
    const cams = this._areaCams(a.area_id).map((id) => hass.states[id]);
    if (cams.length) {
      out.push(`<span class="ic camic ${cams.some((s) => !BAD.includes(s.state)) ? 'on' : ''}" style="--c:#009688" data-cams="${esc(a.area_id)}"
        title="${cams.length > 1 ? `${cams.length} Kameras` : 'Kamera'}"><ha-icon icon="mdi:cctv"></ha-icon>${cams.length > 1 ? cams.length : ''}</span>`);
    }
    return out.join('');
  }

  /** Gerätegruppen eines Raums: Anzahl (Messdose und Gerät selbst zählen als eines) und Anzahl aktiv */
  _appsOf(areaId) {
    const hass = this._hass;
    if (this._apFor !== hass.devices || this._apSt !== hass.states || this._apHide !== HIDE.ver) { this._apFor = hass.devices; this._apSt = hass.states; this._apHide = HIDE.ver; this._apC = {}; }
    if (this._apC[areaId]) return this._apC[areaId];
    const groups = {};
    for (const d of Object.values(hass.devices || {})) {
      if (d.area_id !== areaId || d.disabled_by || d.entry_type === 'service' || HIDE.ids.has(d.id) || HIDE.restrictedDev?.(d.id)) continue;
      const name = `${d.name_by_user || d.name || ''} ${d.model || ''}`;
      const r = window.__hmcActRaw ? window.__hmcActRaw(hass, d.id) : { a: '', on: false };
      // Proxmox-Geräte sind immer Server, Pi-hole-Geräte immer Pi-hole – unabhängig vom Namen (z. B. Container „pihole-backup“)
      if (r.meta || r.sub) continue; // Update-Verwaltung bzw. Volume/Laufwerk eines NAS
      const g = APPS_EXCL.test(name) ? null : r.p ? APPS.find((x) => x.k === (r.p === 'pi_hole' ? 'pihole' : 'server')) : APPS.find((x) => x.re.test(name));
      if (!g) continue;
      if (!r.on) continue; // ausgeschaltet oder nicht erreichbar: kein Symbol
      const x = (groups[g.k] ||= { g, plug: 0, dev: 0, act: 0, kinds: new Set() });
      if (PLUG.test(name)) x.plug++; else x.dev++;
      if (r.a) { x.kinds.add(r.a); if (['pw', 'wa', 'srv', 'ph'].includes(r.a)) x.act++; }
    }
    const rank = window.__hmcRank || [];
    const out = APPS.filter((g) => groups[g.k]).map((g) => {
      const x = groups[g.k]; const n = Math.max(x.plug, x.dev);
      // Farbe wie die Gerätekachel: höchste Aktivität der Gruppe, sonst grün (nur eingeschaltet)
      const kind = rank.find((k) => x.kinds.has(k));
      return { ...g, n, act: Math.min(x.act, n), color: (kind && window.__hmcColors?.[kind]) || '#4caf50' };
    });
    return (this._apC[areaId] = out);
  }

  /** alle Kameras eines Bereichs: konfigurierte zuerst, dann zugeordnete (auch ausgeblendete) */
  _areaCams(areaId) {
    const hass = this._hass;
    const ids = Object.values(hass.entities || {})
      .filter((e) => e.entity_id.startsWith('camera.') && !HIDE.restricted(e) && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id)) === areaId)
      .map((e) => e.entity_id).sort();
    return [...new Set([this._config.cameras[areaId], ...ids])].filter((id) => id && hass.states[id]);
  }

  /** Kamera-Popup über allem (auch über dem Raum-Popup) */
  async _openCams(ids, title) {
    this._closeCams();
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>${POP_CSS}
      .bg { z-index:101; } .cg { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); }</style>
      <div class="bg"><div class="pop" style="--w:${ids.length > 1 ? 1280 : 900}px; --c:#009688">
      <div class="ph"><div class="bub"><ha-icon icon="mdi:cctv"></ha-icon></div><div class="t">${esc(title || 'Kameras')}<small>${ids.length} Kamera${ids.length === 1 ? '' : 's'} · Bild antippen für Livebild</small></div>
      <button class="x" data-x title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="pb"><div class="cg"></div></div></div></div>`;
    this._popStyle(host);
    const r = host.shadowRoot;
    const cp = this._camPop = { host, els: [] };
    for (const type of ['hass-more-info', 'show-dialog']) {
      host.addEventListener(type, (e) => {
        if (e.__hd) return;
        e.stopPropagation();
        const ev = new CustomEvent(type, { detail: e.detail, bubbles: true, composed: true }); ev.__hd = true;
        this.dispatchEvent(ev);
      });
    }
    r.querySelector('.bg').addEventListener('click', (e) => {
      if (e.target.classList.contains('bg') || e.composedPath().some((el) => el.dataset && el.dataset.x != null)) this._closeCams();
    });
    this._camEsc = (e) => { if (e.key === 'Escape' && this._camPop) { e.stopImmediatePropagation(); this._closeCams(); } };
    window.addEventListener('keydown', this._camEsc, true);
    document.body.appendChild(host);
    const grid = r.querySelector('.cg');
    for (const id of ids) {
      const slot = document.createElement('div'); grid.appendChild(slot);
      this._card({ type: 'picture-entity', entity: id, show_state: false, camera_view: 'auto', tap_action: { action: 'more-info' } })
        .then((c) => { if (this._camPop !== cp) return; c.hass = this._hass; cp.els.push(c); slot.appendChild(c); })
        .catch((err) => console.warn('home-dashboard-card:', err));
    }
  }

  /** Deckkraft (popup_opacity, %), Unschärfe (popup_blur, px) und Abdunklung (popup_dim, %) der Popups */
  _popStyle(host) {
    const c = this._config; const cl = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    host.style.setProperty('--pop-op', `${cl(c.popup_opacity, 0, 100, 50)}%`);
    host.style.setProperty('--pop-blur', `${cl(c.popup_blur, 0, 40, 10)}px`);
    host.style.setProperty('--pop-dim', `${cl(c.popup_dim, 0, 100, 20) / 100}`);
  }

  _closeCams() {
    if (!this._camPop) return;
    this._camPop.host.remove();
    window.removeEventListener('keydown', this._camEsc, true);
    this._camPop = null;
  }

  /** Anordnung: sidebar (Standard), sidebar_links (Seiten links, Status als Kopf rechts, Räume allein) oder stacked.
   *  Die Seitenleisten-Varianten gelten ab 1100 px; schmaler bleibt alles untereinander in der gewohnten Reihenfolge. */
  _layout() {
    const r = this.shadowRoot; const page = r.querySelector('.page');
    if (!page) return;
    const lay = this._config.layout || 'sidebar';
    this._mq ||= window.matchMedia('(min-width: 1100px)');
    if (!this._mqBound) { this._mqBound = true; this._mq.addEventListener('change', () => this._layout()); }
    const wide = this._mq.matches;
    const sl = lay === 'sidebar_links' && wide;
    page.classList.toggle('sb', lay !== 'stacked');
    page.classList.toggle('sl', sl);
    const side = r.querySelector('.side'); const main = r.querySelector('.main');
    const stat = r.getElementById('stat'); const linksec = r.getElementById('linksec'); const haussec = r.getElementById('haussec'); const cols = r.querySelector('.cols');
    if (sl) {
      if (linksec.parentNode !== side) side.appendChild(linksec);
      if (stat.parentNode !== main) main.insertBefore(stat, haussec);
    } else {
      if (stat.parentNode !== side) side.appendChild(stat);
      if (linksec.parentNode !== cols) cols.insertBefore(linksec, cols.firstChild);
    }
  }

  _renderRooms() {
    const hass = this._hass;
    this._layout();
    const cols = this.shadowRoot.querySelector('.cols');
    if (cols) {
      cols.classList.toggle('scroll', this._config.scroll_sections !== false);
      if (this._config.section_height) cols.style.setProperty('--sec-h', this._config.section_height); else cols.style.removeProperty('--sec-h');
    }
    const areas = this._areas();
    const html = areas.map((a) => {
      const sts = this._areaStates(a.area_id);
      const c = this._climate(a, sts);
      const pid = this._powerId(a);
      const p = num(hass.states[pid]);
      const cam = this._config.camera_background !== false && this._config.cameras[a.area_id] && hass.states[this._config.cameras[a.area_id]];
      const sub = [c.temp != null && `${nf(c.temp)} °C`, c.hum != null && `${nf(c.hum, 0)} %`].filter(Boolean).join(' · ');
      return `<div class="card rc click ${cam ? 'withcam' : ''}" data-k="${esc(a.area_id)}" data-pop="area:${esc(a.area_id)}">
        ${cam ? '<div class="cam" data-keep></div>' : ''}<div class="bgl">${cam ? '' : this._spark(pid)}</div>
        <div class="rh"><div class="ri"><ha-icon icon="${esc(a.icon || 'mdi:texture-box')}"></ha-icon></div>
          <div class="rn"><b>${esc(a.name)}</b><span>${sub || '&nbsp;'}</span></div>
          ${p != null ? `<div class="pw">${fW(p)}<small>Leistung</small></div>` : ''}</div>
        <div class="icons">${this._roomIcons(a, sts)}</div></div>`;
    }).join('');
    this._set('rooms', html);
    this.shadowRoot.getElementById('rcount').textContent = `${areas.length}`;
    this._mountCams();
  }

  async _card(cfg) {
    this._helpers = this._helpers || (window.loadCardHelpers ? window.loadCardHelpers() : null);
    const h = await this._helpers;
    if (!h) throw new Error('Card-Helper nicht verfügbar');
    const el = h.createCardElement(cfg);
    el.hass = this._hass;
    return el;
  }

  /** Kamerabilder einmalig in die Raumkacheln hängen (bleiben beim Aktualisieren erhalten) */
  _mountCams() {
    const hass = this._hass;
    for (const [areaId, id] of Object.entries(this._config.camera_background !== false ? this._config.cameras || {} : {})) {
      const slot = this.shadowRoot.querySelector(`.rc[data-k="${window.CSS && window.CSS.escape ? window.CSS.escape(areaId) : areaId}"] .cam`);
      if (!slot || !hass.states[id]) continue;
      let c = this._camEls[id];
      if (!c) {
        c = this._camEls[id] = { el: null };
        this._card({ type: 'picture-entity', entity: id, show_name: false, show_state: false, camera_view: 'auto', tap_action: { action: 'none' } })
          .then((el) => { c.el = el; this._mountCams(); }).catch((err) => console.warn('home-dashboard-card:', err));
      }
      if (c.el) {
        if (c.el.parentNode !== slot) slot.appendChild(c.el);
        c.el.hass = hass;
      }
    }
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const act = path.find((el) => el.dataset && el.dataset.act);
    if (act) { e.stopPropagation(); this._action(act.dataset); return; }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more && more.dataset.more) { e.stopPropagation(); this._fire('hass-more-info', { entityId: more.dataset.more }); return; }
    const lg = path.find((el) => el.dataset && el.dataset.lg);
    if (lg) { this._lg = lg.dataset.lg; try { localStorage.setItem('hmc-linkgroup', this._lg); } catch (err) { /* ignore */ } this._renderLinks(); return; }
    const link = path.find((el) => el.dataset && el.dataset.link);
    if (link) {
      const l = this._config.links[Number(link.dataset.link)];
      if (l?.popup) this._openPopup(l.popup); else if (l?.path) this._navigate(l.path);
      return;
    }
    const cam = path.find((el) => el.dataset && el.dataset.cams);
    if (cam) { e.stopPropagation(); this._openCams(this._areaCams(cam.dataset.cams), this._hass.areas[cam.dataset.cams]?.name); return; }
    const pop = path.find((el) => el.dataset && el.dataset.pop);
    if (pop) this._openPopup(pop.dataset.pop);
  }

  async _action(ds) {
    const hass = this._hass;
    try {
      if (ds.act === 'toggle') {
        const dom = ds.e.split('.')[0];
        await hass.callService(['light', 'switch', 'fan', 'input_boolean'].includes(dom) ? dom : 'homeassistant', 'toggle', { entity_id: ds.e });
      } else if (ds.act === 'lights_off') {
        const ids = this._data.lights.map((s) => s.entity_id);
        if (ids.length) await hass.callService('light', 'turn_off', { entity_id: ids });
      } else if (ds.act === 'install') {
        if (window.confirm(`Update für ${ds.n} installieren?`)) await hass.callService('update', 'install', { entity_id: ds.e });
      } else if (ds.act === 'device') {
        this._closePopup(); this._navigate(`/config/devices/device/${ds.d}`);
      } else if (ds.act === 'logf') { this._logF = ds.v; this._updatePopup();
      } else if (ds.act === 'logx') { if (this._logOpen.has(ds.k)) this._logOpen.delete(ds.k); else this._logOpen.add(ds.k); this._updatePopup();
      } else if (ds.act === 'logr') { this._fetchLog(true);
      } else if (ds.act === 'logclear') {
        if (!window.confirm('Systemprotokoll zurücksetzen? Alle Einträge im Home-Assistant-Log werden gelöscht.')) return;
        await hass.callService('system_log', 'clear', {});
        this._logOpen = new Set(); this._fetchLog(true);
        this._fire('hass-notification', { message: 'Systemprotokoll zurückgesetzt' });
      } else if (ds.act === 'logall') { this._closePopup(); this._navigate('/config/logs');
      } else if (ds.act === 'restart') {
        if (!window.confirm('Home Assistant jetzt neu starten?')) return;
        await hass.callService('homeassistant', 'restart', {});
      } else if (ds.act === 'intreload') {
        await hass.callService('homeassistant', 'reload_config_entry', { entry_id: ds.e });
        this._fire('hass-notification', { message: `${ds.n} wird neu geladen` });
        setTimeout(() => this._fetchSys(true), 3000);
      } else if (ds.act === 'intopen') { this._closePopup(); this._navigate(`/config/integrations/integration/${ds.d}`);
      } else if (ds.act === 'monx') { if (this._monOpen.has(ds.d)) this._monOpen.delete(ds.d); else this._monOpen.add(ds.d); this._updatePopup();
      } else if (ds.act === 'monr') { this._fetchSys(true); this._fetchLog(true);
      } else if (ds.act === 'monedit') { this._monEdit = !this._monEdit; this._monQ = ''; this._updatePopup();
      } else if (ds.act === 'montog' || ds.act === 'monall') {
        const sel = new Set(this._monDomains());
        if (ds.act === 'monall') sel.clear(); else if (sel.has(ds.d)) sel.delete(ds.d); else sel.add(ds.d);
        this._monSel = [...sel].sort(); this._updatePopup(); this._renderLinks();
        const me = this._monEntity();
        if (me) {
          const v = this._monSel.join(',');
          const max = hass.states[me].attributes.max || 255;
          if (v.length > max) { this._fire('hass-notification', { message: `Zu viele Integrationen für ${me} (max. ${max} Zeichen)` }); return; }
          await hass.callService('input_text', 'set_value', { entity_id: me, value: v });
        } else await hass.callWS({ type: 'frontend/set_user_data', key: 'hmc_integrations', value: this._monSel });
      } else if (ds.act === 'close') this._closePopup();
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
    }
  }

  _navigate(path) {
    if (/^https?:/.test(path)) { window.open(path, '_blank', 'noopener'); return; }
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  _fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }

  /* ---------- Popups ---------- */
  _openPopup(key) {
    this._closePopup();
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>${POP_CSS}</style><div class="bg"><div class="pop">
      <div class="ph"><div class="bub"><ha-icon></ha-icon></div><div class="t"></div><button class="x" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="pb"><div class="htm"></div><div class="host"></div></div></div></div>`;
    this._popStyle(host);
    const r = host.shadowRoot;
    this._pop = { key, host, r, els: [], html: null };
    // Ereignisse aus dem Popup (liegt an <body>) an Home Assistant weiterreichen
    host.addEventListener('hmc-cameras', (e) => { e.detail.handled = true; e.stopPropagation(); this._openCams(e.detail.ids, e.detail.title); });
    for (const type of ['hass-more-info', 'hass-notification', 'show-dialog']) {
      host.addEventListener(type, (e) => {
        if (e.__hd) return;
        e.stopPropagation();
        const ev = new CustomEvent(type, { detail: e.detail, bubbles: true, composed: true });
        ev.__hd = true;
        this.dispatchEvent(ev);
      });
    }
    r.querySelector('.bg').addEventListener('click', (e) => {
      if (e.target.classList.contains('bg')) { this._closePopup(); return; }
      const path = e.composedPath();
      const act = path.find((el) => el.dataset && el.dataset.act);
      if (act && r.contains(act)) { e.stopPropagation(); this._action(act.dataset); return; }
      const more = path.find((el) => el.dataset && el.dataset.more);
      if (more && r.contains(more)) this._fire('hass-more-info', { entityId: more.dataset.more });
    });
    r.querySelector('.bg').addEventListener('input', (e) => {
      const t = e.composedPath()[0];
      if (t && t.dataset && t.dataset.logq != null) { this._logQ = t.value.toLowerCase(); this._updatePopup(); }
      if (t && t.dataset && t.dataset.monq != null) { this._monQ = t.value; this._updatePopup(); }
    });
    this._escKey = (e) => { if (e.key === 'Escape' && this._pop) this._closePopup(); };
    window.addEventListener('keydown', this._escKey);
    document.body.appendChild(host);
    this._fillPopup();
  }

  _closePopup() {
    clearInterval(this._logTick);
    if (!this._pop) return;
    this._pop.host.remove();
    window.removeEventListener('keydown', this._escKey);
    this._pop = null;
  }

  _popHead(icon, color, title, sub, width) {
    const r = this._pop.r;
    const pop = r.querySelector('.pop');
    pop.style.setProperty('--w', `${width || 640}px`);
    pop.style.setProperty('--c', color);
    const hi = r.querySelector('.ph ha-icon');
    if (hi.getAttribute('icon') !== icon) hi.setAttribute('icon', icon);
    const t = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    if (this._pop.head !== t) { morph(r.querySelector('.ph .t'), t); this._pop.head = t; }
  }

  async _popEl(cfgOrEl) {
    const p = this._pop;
    const el = cfgOrEl instanceof HTMLElement ? cfgOrEl : await this._card(cfgOrEl);
    if (this._pop !== p) return;
    el.hass = this._hass;
    p.els.push(el);
    p.r.querySelector('.host').appendChild(el);
  }

  _fillPopup() {
    const p = this._pop;
    const [kind, arg] = p.key.split(/:(.*)/s);
    if (kind === 'area') {
      const a = this._hass.areas[arg];
      if (!a) return;
      const sts = this._areaStates(a.area_id);
      const c = this._climate(a, sts); const pv = num(this._hass.states[this._powerId(a)]);
      this._popHead(a.icon || 'mdi:texture-box', 'var(--primary-color)', a.name,
        [c.temp != null && `${nf(c.temp)} °C`, c.hum != null && `${nf(c.hum, 0)} %`, pv != null && fW(pv)].filter(Boolean).join(' · '), 1280);
      const el = document.createElement('area-overview-card');
      el.setConfig({ mode: 'devices', makers: this._config.makers, power: this._config.area_power, cameras: this._config.cameras,
        min_width: 300, hide_label: this._config.hide_label, admin_only: this._config.admin_only || [] });
      el._area = arg;
      this._popEl(el);
    } else if (kind === 'log') {
      this._logF = this._logF || 'all'; this._logQ = ''; this._logOpen = new Set();
      this._popHead('mdi:math-log', '#03a9f4', 'Home Assistant Log', 'Systemprotokoll', 1040);
      this._fetchLog(true);
      clearInterval(this._logTick);
      this._logTick = setInterval(() => this._fetchLog(true), 10000);
    } else if (kind === 'integrations') {
      this._monOpen = this._monOpen || new Set(); this._monEdit = false; this._monQ = '';
      this._popHead('mdi:puzzle-check-outline', '#7e57c2', 'Integrationen', 'Verbindung, Geräte und Fehler', 1000);
      this._fetchSys(true); this._fetchLog(true);
      clearInterval(this._logTick);
      this._logTick = setInterval(() => { this._fetchLog(true); this._fetchSys(true); }, 20000);
    } else if (kind === 'power') {
      const pw = this._config.power;
      this._popEl({ type: 'history-graph', hours_to_show: 24, entities: [pw.house, pw.pv, pw.grid, pw.battery].filter(Boolean).map((e) => ({ entity: e })) })
        .then(() => this._popEl({ type: 'energy-distribution', link_dashboard: true }));
    }
    this._updatePopup();
  }

  _updatePopup() {
    const p = this._pop;
    if (!p) return;
    for (const el of p.els) el.hass = this._hass;
    const html = this._popHtml(p.key);
    if (html != null && html !== p.html) { p.html = html; morph(p.r.querySelector('.htm'), html); }
  }

  _row(st, value, icon, color) {
    return `<div class="it" data-k="${st.entity_id}" data-more="${st.entity_id}" style="--c:${color || 'var(--secondary-text-color)'}"><ha-icon icon="${icon}"></ha-icon>
      <div class="n">${esc(this._name(st))}<small>${esc(this._areaOf(st.entity_id) || 'kein Bereich')}</small></div><span class="v">${value}</span></div>`;
  }

  _popHtml(key) {
    const hass = this._hass;
    const d = this._data || this._all();
    const fmt = (st) => esc(typeof hass.formatEntityState === 'function' ? hass.formatEntityState(st) : st.state);
    const byArea = (l) => [...l].sort((a, b) => this._areaOf(a.entity_id).localeCompare(this._areaOf(b.entity_id), 'de') || this._name(a).localeCompare(this._name(b), 'de'));
    const list = (rows) => (rows.length ? `<div class="lst">${rows.join('')}</div>` : '<div class="none">Nichts zu melden.</div>');
    const tog = (st) => `<button class="tog ${st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${st.entity_id}"></button>`;
    const dt = (v) => { const x = v ? new Date(v) : null; return x && !Number.isNaN(x.getTime()) ? x.toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
    switch (key) {
      case 'lights': {
        this._popHead('mdi:lightbulb-group', '#ffc107', 'Licht', `${d.lights.length} an`, 560);
        const all = Object.values(hass.entities).filter((e) => e.entity_id.startsWith('light.') && !e.hidden && !e.entity_category && !HIDE.hidden(e))
          .map((e) => hass.states[e.entity_id]).filter((s) => s && !BAD.includes(s.state));
        return `${d.lights.length ? '<div class="acts"><button class="btn sec" data-act="lights_off">Alle ausschalten</button></div>' : ''}
          ${list(byArea(all).map((s) => this._row(s, tog(s), s.state === 'on' ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline', s.state === 'on' ? '#ffc107' : '')))}`;
      }
      case 'heat':
        this._popHead('mdi:radiator', '#ff6f22', 'Heizung', `${d.heat.length} von ${d.climate.length} heizen`, 600);
        return list(byArea(d.climate).map((s) => {
          const cur = s.attributes.current_temperature; const t = s.attributes.temperature;
          const on = HEAT.includes(s.attributes.hvac_action);
          return this._row(s, `${cur != null ? `${nf(cur)} °C` : ''}${t != null ? ` → ${nf(t)} °C` : ''}`, on ? 'mdi:radiator' : 'mdi:radiator-off', on ? '#ff6f22' : '');
        }));
      case 'switches': {
        const on = d.switches.filter((x) => x.state === 'on').length;
        this._popHead('mdi:toggle-switch', '#4caf50', 'Schalter', `${on} von ${d.switches.length} an`, 560);
        const pw = (st) => {
          // Leistung der Messdose am selben Gerät, falls vorhanden
          const dev = hass.entities[st.entity_id]?.device_id;
          const p = dev && Object.values(hass.entities).find((e) => e.device_id === dev && e.entity_id.startsWith('sensor.') && hass.states[e.entity_id]?.attributes.device_class === 'power' && !e.entity_category);
          const v = p && num(hass.states[p.entity_id]);
          return v != null && v >= 1 ? `<span style="margin-right:12px">${fW(v * (hass.states[p.entity_id].attributes.unit_of_measurement === 'kW' ? 1000 : 1))}</span>` : '';
        };
        return list(byArea(d.switches).map((s) => this._row(s, `<span style="display:inline-flex;align-items:center">${s.state === 'on' ? pw(s) : ''}${tog(s)}</span>`,
          s.state === 'on' ? 'mdi:power-socket-de' : 'mdi:power-plug-off-outline', s.state === 'on' ? '#4caf50' : '')));
      }
      case 'open':
        this._popHead('mdi:window-open-variant', '#2196f3', 'Fenster & Türen', `${d.open.length} offen`, 520);
        return list(byArea(d.open).map((s) => this._row(s, 'offen', 'mdi:window-open-variant', '#2196f3')));
      case 'covers':
        this._popHead('mdi:window-shutter-open', '#9c27b0', 'Rollos', `${d.covers.length} offen`, 520);
        return list(byArea(d.covers).map((s) => this._row(s, fmt(s), 'mdi:window-shutter-open', '#9c27b0')));
      case 'maint': {
        this._popHead('mdi:wrench', '#ffa600', 'Wartung', '', 620);
        const sec = (t, rows) => (rows.length ? `<div class="sec">${t}</div><div class="lst">${rows.join('')}</div>` : '');
        const ST = { setup_error: 'Einrichtung fehlgeschlagen', setup_retry: 'Wiederholt Verbindungsaufbau', migration_error: 'Migration fehlgeschlagen', failed_unload: 'Entladen fehlgeschlagen' };
        const html = sec('Neustart ausstehend', this._restarts().map((i) => `<div class="it" data-k="r-${esc(i.issue_id)}"><ha-icon icon="mdi:restart-alert" style="--c:#ffa600"></ha-icon>
            <div class="n">${esc(this._intName(i.domain))}<small>Neustart erforderlich${i.issue_domain && i.issue_domain !== i.domain ? ` · ${esc(this._intName(i.issue_domain))}` : ''}</small></div>
            <button class="btn" data-act="restart">Neu starten</button></div>`))
          + sec('Integrationen mit Fehler', this._entryErrors().map((e) => `<div class="it" data-k="e-${esc(e.entry_id)}"><ha-icon icon="mdi:puzzle-remove-outline" style="--c:#db4437"></ha-icon>
            <div class="n" data-act="intopen" data-d="${esc(e.domain)}" style="cursor:pointer">${esc(e.title)}<small>${esc(this._intName(e.domain))} · ${esc(ST[e.state] || e.state)}${e.reason ? ` · ${esc(e.reason)}` : ''}</small></div>
            <button class="btn sec" data-act="intreload" data-e="${esc(e.entry_id)}" data-n="${esc(e.title)}">Neu laden</button></div>`))
          + sec('Updates', d.updates.map((s) => `<div class="it" data-k="${s.entity_id}" data-more="${s.entity_id}"><ha-icon icon="mdi:package-up" style="--c:#ffa600"></ha-icon>
            <div class="n">${esc(this._name(s))}<small>${esc(s.attributes.installed_version || '')} → ${esc(s.attributes.latest_version || '')}</small></div>
            ${this._hass.user?.is_admin ? `<button class="btn" data-act="install" data-e="${s.entity_id}" data-n="${esc(this._name(s))}">Installieren</button>` : ''}</div>`))
          + sec('Batterien', d.battery.map((s) => this._row(s, fmt(s), 'mdi:battery-alert-variant-outline', '#db4437')))
          + sec('Nicht erreichbar', d.offline.map(({ devId, d: dv }) => `<div class="it" data-k="${esc(devId)}" data-act="device" data-d="${esc(devId)}"><ha-icon icon="mdi:lan-disconnect" style="--c:#db4437"></ha-icon>
            <div class="n">${esc(dv.name_by_user || dv.name)}<small>${esc([hass.areas[dv.area_id]?.name, dv.manufacturer, dv.model].filter(Boolean).join(' · '))}</small></div></div>`));
        return html || '<div class="none">Nichts zu tun.</div>';
      }
      case 'integrations': {
        if (!this._entries) return '<div class="none">Lädt …</div>';
        if (this._monEdit) {
          const sel = new Set(this._monDomains());
          const q = (this._monQ || '').toLowerCase();
          const doms = [...new Set(this._entries.map((e) => e.domain))].map((d) => ({ d, n: this._intName(d) }))
            .filter((x) => !q || `${x.d} ${x.n}`.toLowerCase().includes(q)).sort((a, b) => a.n.localeCompare(b.n, 'de'));
          return `<div class="lbar"><input class="lq" data-monq placeholder="Integration suchen …" type="search">
              <button class="btn sec" data-act="monall" data-v="0">Keine</button><button class="btn" data-act="monedit">Fertig</button></div>
            <div class="linf">${sel.size} ausgewählt · ${this._monEntity() ? 'gilt auch für die Überwachung mit Telegram-Meldungen' : 'die Auswahl wird für deinen Benutzer gespeichert'}</div>
            <div class="msel">${doms.map((x) => `<label class="mchk ${sel.has(x.d) ? 'on' : ''}" data-act="montog" data-d="${esc(x.d)}" data-k="m-${esc(x.d)}">
              <ha-icon icon="${sel.has(x.d) ? 'mdi:checkbox-marked' : 'mdi:checkbox-blank-outline'}"></ha-icon><span>${esc(x.n)}<small>${esc(x.d)}</small></span></label>`).join('')}</div>`;
        }
        const ST = { loaded: 'verbunden', setup_error: 'Einrichtung fehlgeschlagen', setup_retry: 'versucht erneut zu verbinden', migration_error: 'Migration fehlgeschlagen',
          failed_unload: 'Entladen fehlgeschlagen', not_loaded: 'nicht geladen', setup_in_progress: 'wird eingerichtet' };
        const ms = this._monDomains().map((d) => this._monitor(d)).sort((a, b) => b.lvl - a.lvl || this._intName(a.domain).localeCompare(this._intName(b.domain), 'de'));
        const C = ['#4caf50', '#ff9800', '#f44336'];
        const ts = (t) => (t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
        const bar = `<div class="lbar"><span class="linf" style="margin:0;flex:1">${ms.filter((m) => m.lvl === 2).length} gestört · ${ms.filter((m) => m.lvl === 1).length} mit Warnungen · ${ms.filter((m) => !m.lvl).length} ok
            · Stand ${this._sysTs ? new Date(this._sysTs).toLocaleTimeString('de-DE') : '–'}</span>
          <button class="btn sec" data-act="monr" title="Neu laden">↻</button><button class="btn sec" data-act="monedit">Auswahl bearbeiten</button></div>`;
        if (!ms.length) return `${bar}<div class="none">Keine Integrationen ausgewählt.</div>`;
        return bar + `<div class="lst">${ms.map((m) => {
          const name = this._intName(m.domain);
          const open = this._monOpen.has(m.domain);
          const chips = [];
          if (!m.entries.length) chips.push('<span class="ch err">nicht eingerichtet</span>');
          else if (m.bad.length) chips.push(`<span class="ch err">${esc(ST[m.bad[0].state] || m.bad[0].state)}</span>`);
          else chips.push(`<span class="ch ok">${m.entries.length > 1 ? `${m.entries.length} Einträge ` : ''}verbunden</span>`);
          if (m.devs.length) chips.push(m.off.length ? `<span class="ch ${m.off.length === m.devs.length ? 'err' : 'warn'}">${m.off.length} von ${m.devs.length} Geräten offline</span>` : `<span class="ch">${m.devs.length} Geräte online</span>`);
          if (m.tcount) chips.push(`<span class="ch warn">${m.tcount}× Timeout/Verbindung</span>`);
          if (m.errs.length) chips.push(`<span class="ch err">${m.errs.length} Fehler</span>`);
          if (m.warns.length) chips.push(`<span class="ch warn">${m.warns.length} Warnung${m.warns.length === 1 ? '' : 'en'}</span>`);
          const last = m.log[0];
          let det = '';
          if (open) {
            const eRows = m.entries.map((e) => `<div class="mrow"><ha-icon icon="mdi:link-variant" style="color:${['loaded'].includes(e.state) ? C[0] : C[2]}"></ha-icon>
              <span>${esc(e.title)} · ${esc(ST[e.state] || e.state)}${e.reason ? ` · ${esc(e.reason)}` : ''}</span>
              <button class="btn sec" data-act="intreload" data-e="${esc(e.entry_id)}" data-n="${esc(e.title)}">Neu laden</button></div>`).join('');
            const oRows = m.off.map((id) => { const dv = this._hass.devices[id]; return `<div class="mrow click" data-act="device" data-d="${esc(id)}"><ha-icon icon="mdi:lan-disconnect" style="color:${C[2]}"></ha-icon>
              <span>${esc(dv.name_by_user || dv.name)}${dv.area_id && this._hass.areas[dv.area_id] ? ` · ${esc(this._hass.areas[dv.area_id].name)}` : ''}</span></div>`; }).join('');
            const lRows = m.log.slice(0, 8).map((e) => `<div class="mrow"><span class="mlv" style="color:${String(e.level).toUpperCase() === 'WARNING' ? C[1] : C[2]}">${esc(String(e.level || '').slice(0, 1))}</span>
              <span>${esc((e.message || [])[0] || '')}<small>${esc(ts(e.timestamp))}${e.count > 1 ? ` · ${e.count}×` : ''}</small></span></div>`).join('');
            det = `<div class="mdet">${eRows ? `<div class="msub">Verbindung</div>${eRows}` : ''}${oRows ? `<div class="msub">Offline</div>${oRows}` : ''}
              ${lRows ? `<div class="msub">Log</div>${lRows}` : '<div class="msub">Log</div><div class="mrow"><span>Keine Fehler oder Warnungen im Log.</span></div>'}
              <div class="acts" style="margin-top:8px"><button class="btn sec" data-act="intopen" data-d="${esc(m.domain)}">Integration öffnen</button></div></div>`;
          }
          return `<div class="mi" data-k="mi-${esc(m.domain)}" style="--c:${C[m.lvl]}">
            <div class="mh" data-act="monx" data-d="${esc(m.domain)}"><span class="dot"></span><div class="n">${esc(name)}
              ${last && !open ? `<small>${esc(ts(last.timestamp))} · ${esc(((last.message || [])[0] || '').slice(0, 140))}</small>` : ''}</div>
              <div class="chs">${chips.join('')}</div><ha-icon icon="mdi:chevron-${open ? 'up' : 'down'}"></ha-icon></div>${det}</div>`;
        }).join('')}</div>`;
      }
      case 'log': {
        const lv = (e) => String(e.level || '').toUpperCase();
        const LV = { CRITICAL: ['Kritisch', '#9c27b0'], ERROR: ['Fehler', '#f44336'], WARNING: ['Warnung', '#ff9800'], INFO: ['Info', '#03a9f4'], DEBUG: ['Debug', '#9e9e9e'] };
        const all = this._log || [];
        const cnt = (f) => all.filter(f).length;
        const fl = { all: () => true, error: (e) => ['ERROR', 'CRITICAL'].includes(lv(e)), warning: (e) => lv(e) === 'WARNING', info: (e) => ['INFO', 'DEBUG'].includes(lv(e)) };
        const q = this._logQ || '';
        const rows = all.filter(fl[this._logF] || fl.all).filter((e) => !q || `${e.name} ${(e.message || []).join(' ')} ${(e.source || []).join(':')}`.toLowerCase().includes(q));
        const tab = (v, t, n) => `<button class="lf ${this._logF === v ? 'on' : ''}" data-act="logf" data-v="${v}">${t}${n != null ? ` <b>${n}</b>` : ''}</button>`;
        const ts = (t) => (t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
        const bar = `<div class="lbar">${tab('all', 'Alle', all.length)}${tab('error', 'Fehler', cnt(fl.error))}${tab('warning', 'Warnungen', cnt(fl.warning))}${tab('info', 'Info', cnt(fl.info))}
          <input class="lq" data-logq placeholder="Suchen …" type="search">
          <button class="btn sec" data-act="logr" title="Neu laden">↻</button><button class="btn sec" data-act="logclear" title="Systemprotokoll zurücksetzen">Log leeren</button><button class="btn sec" data-act="logall">Vollständiges Log</button></div>
          <div class="linf">${this._logErr ? `<span style="color:#f44336">${esc(this._logErr)}</span>` : `Stand ${this._logTs ? new Date(this._logTs).toLocaleTimeString('de-DE') : '–'} · aktualisiert sich alle 10 s`}</div>`;
        const body = rows.length ? `<div class="lst">${rows.map((e) => {
          const k = `${e.name}|${(e.source || []).join(':')}|${(e.message || [])[0] || ''}`;
          const [lt, lc] = LV[lv(e)] || [e.level, '#9e9e9e'];
          const open = this._logOpen.has(k);
          const msg = (e.message || []);
          return `<div class="le" data-k="${esc(k)}" data-act="logx" style="--c:${lc}">
            <div class="lh"><span class="lv">${esc(lt)}</span><span class="lm">${esc(msg[0] || '')}</span>${e.count > 1 ? `<span class="lc">${e.count}×</span>` : ''}</div>
            <div class="ls">${esc(ts(e.timestamp))} · ${esc(e.name || '')}${e.source ? ` · ${esc(e.source.join(':'))}` : ''}</div>
            ${open ? `<pre>${esc(msg.join('\n\n'))}${e.exception ? `\n\n${esc(e.exception)}` : ''}</pre>` : ''}</div>`;
        }).join('')}</div>` : `<div class="none">${all.length ? 'Keine Einträge passen zum Filter.' : 'Keine Einträge im Systemprotokoll.'}</div>`;
        return bar + body;
      }
      case 'dwd': {
        const ws = this._warnings();
        const lvl = ws.length ? Math.max(...ws.map((w) => w.level)) : 0;
        const region = (this._config.warnings || []).map((id) => (hass.states[id]?.attributes.region_name || hass.states[id]?.attributes.area)).find(Boolean);
        this._popHead(ws.length ? 'mdi:alert' : 'mdi:shield-check-outline', DWD_COLOR[Math.min(4, lvl)], 'DWD-Wetterwarnungen', region || '', 640);
        if (!ws.length) return '<div class="none">Aktuell liegen keine Warnungen vor.</div>';
        return ws.map((w) => `<div class="warn" data-k="${esc(w.headline)}${esc(w.start || '')}" style="--c:${esc(w.color || DWD_COLOR[Math.min(4, Math.max(1, w.level))])}">
          <b>${esc(w.headline || w.name)}</b>
          <span class="tm">${esc(DWD_TEXT[Math.min(4, Math.max(0, w.level))] || '')}${w.start ? ` · ${esc(dt(w.start))}` : ''}${w.end ? ` bis ${esc(dt(w.end))}` : ''}</span>
          ${w.description ? `<p>${esc(w.description)}</p>` : ''}${w.instruction ? `<p><i>${esc(w.instruction)}</i></p>` : ''}</div>`).join('');
      }
      case 'power': {
        const rooms = this._areas().map((a) => ({ a, id: this._powerId(a), v: num(hass.states[this._powerId(a)]) })).filter((x) => x.v != null).sort((x, y) => y.v - x.v);
        const max = Math.max(1, ...rooms.map((x) => x.v));
        const house = num(hass.states[this._config.power.house]);
        this._popHead('mdi:home-lightning-bolt', '#f44336', 'Stromverbrauch', house != null ? `Haus ${fW(house)}` : '', 760);
        return list(rooms.map(({ a, id, v }) => `<div class="it" data-k="${esc(id)}" data-more="${esc(id)}"><ha-icon icon="${esc(a.icon || 'mdi:texture-box')}"></ha-icon>
          <div class="n">${esc(a.name)}<div class="bar"><i style="width:${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(1)}%"></i></div></div><span class="v">${fW(v)}</span></div>`));
      }
      default: return null;
    }
  }
}

if (!customElements.get('home-dashboard-card')) {
  customElements.define('home-dashboard-card', HomeDashboardCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'home-dashboard-card', name: 'Home Dashboard', description: 'Startseite mit Status, Haus, Seiten und Räumen; Details als Popup' });
  console.info(`%c HOME-DASHBOARD-CARD %c ${VERSION} `, 'background:#ff9800;color:#fff', 'background:#eee;color:#333');
}
}
