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
 *   cameras: { buro: camera.x, garage: camera.y }   # Kamerabild im Hintergrund der Raumkachel
 *   exclude_areas: [pv]
 *   hide_label: dashboard_ausgeblendet    # per Label ausgeblendete Geräte zählen nicht mit
 *   links: [{ name, icon, path, color, integration, entity }]
 *   makers: [{ type: custom:shelly-manager-card, … }]   # für die Raum-Popups
 */
{
const VERSION = '2.0.1';
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
  hidden(e) { return !!e && ((e.device_id && this.ids.has(e.device_id)) || (this.ents && this.ents.has(e.entity_id))); },
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
  h2 small { font-size: 13px; font-weight: 400; color: var(--secondary-text-color); }

  /* Kopf, Status-Icons und Haus über die volle Breite; darunter Seiten und Räume immer nebeneinander */
  .cols { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--gap); align-items:start; }
  .cols > section { min-width:0; }
  @media (max-width: 700px) { .cols { grid-template-columns: minmax(0, 0.8fr) minmax(0, 2fr); gap: 10px; } }

  /* Kopf */
  .hdr { display:flex; align-items:center; gap:16px; padding: 4px 4px 0; }
  .av { width:60px; height:60px; border-radius:50%; background: var(--secondary-background-color) center/cover; flex:none; cursor:pointer;
    display:flex; align-items:center; justify-content:center; border:3px solid var(--success-color, #43a047); }
  .av.away { border-color: var(--disabled-color, #9e9e9e); filter: grayscale(.5); }
  .av ha-icon { --mdc-icon-size:32px; color: var(--secondary-text-color); }
  .greet { flex:1; min-width:0; }
  .greet .g { font-size: 28px; font-weight: 600; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .greet .s { font-size: 14px; color: var(--secondary-text-color); margin-top:2px; }
  .who { display:flex; flex-direction:column; align-items:center; gap:2px; flex:none; }
  .wx { display:flex; align-items:center; gap:3px; cursor:pointer; padding:2px 6px; border-radius:10px; }
  .wx:hover { background: var(--secondary-background-color); }
  .wx ha-icon { --mdc-icon-size: 22px; color: var(--amber-color, #ffc107); }
  .wx span { font-size: 14px; font-weight: 600; white-space:nowrap; }
  .greet .s .tm { font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) { .greet .g { font-size: 20px; white-space:normal; } .hdr { gap:10px; }
    .stat { grid-template-columns: repeat(4, 1fr); } .si .l { font-size:11px; } .av { width:48px; height:48px; } }

  /* Status-Icons */
  .stat { display:grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 8px; }
  .si { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; padding: 12px 6px 10px; text-align:center; }
  .si .bub { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; background: var(--secondary-background-color); }
  .si .bub ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
  .si.on .bub { background: color-mix(in srgb, var(--c) 22%, transparent); }
  .si.on .bub ha-icon { color: var(--c); }
  .si.alert .bub { animation: pulse 1.6s infinite; }
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
  .val { display:flex; align-items:center; gap:8px; padding: 8px 12px; border-radius: 14px; background: var(--secondary-background-color); min-width: 108px; }
  .val ha-icon { --mdc-icon-size:22px; color: var(--c); }
  .val div { line-height:1.15; } .val b { font-size:15px; } .val small { display:block; font-size:12px; color: var(--secondary-text-color); }
  .chart { position:relative; height: 150px; }
  .chart svg { width:100%; height:100%; display:block; overflow:visible; }
  .chart .ymax { position:absolute; top:-2px; left:0; font-size:11px; color: var(--secondary-text-color); background: var(--ha-card-background, var(--card-background-color)); padding: 0 4px 0 0; }
  .chart .grid line { stroke: var(--divider-color); stroke-width:1; vector-effect: non-scaling-stroke; }
  .chart .pv { fill: color-mix(in srgb, #ffc107 22%, transparent); stroke:#ffc107; stroke-width:2; vector-effect: non-scaling-stroke; }
  .chart .use { fill:none; stroke:#f44336; stroke-width:2; vector-effect: non-scaling-stroke; }
  .chart .fc { fill:none; stroke:#4caf50; stroke-width:2; stroke-dasharray: 6 4; opacity:.95; vector-effect: non-scaling-stroke; }
  .chart .cs { fill:none; stroke: var(--secondary-text-color); stroke-width:1.5; stroke-dasharray: 3 4; opacity:.7; vector-effect: non-scaling-stroke; }
  .chart .now { stroke: var(--secondary-text-color); stroke-width:1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
  .ax { display:flex; justify-content:space-between; font-size: 11px; color: var(--secondary-text-color); padding: 2px 0 0; }
  .leg { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color: var(--secondary-text-color); }
  .leg i { display:inline-block; width:14px; height:3px; border-radius:2px; vertical-align:middle; margin-right:5px; }

  /* Links */
  .links { display:flex; flex-direction:column; gap: 8px; container-type: inline-size; }
  .lk { display:flex; align-items:center; gap:12px; padding: 10px 14px; }
  .lk .bub { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; flex:none;
    background: color-mix(in srgb, var(--c, var(--primary-color)) 16%, transparent); }
  .lk .bub ha-icon { --mdc-icon-size:22px; color: var(--c, var(--primary-color)); }
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
    color: var(--secondary-text-color); background: color-mix(in srgb, var(--secondary-text-color) 14%, var(--ha-card-background, var(--card-background-color))); }
  .ic ha-icon { --mdc-icon-size:18px; }
  .ic.on { color: var(--c); background: color-mix(in srgb, var(--c) 20%, var(--ha-card-background, var(--card-background-color))); }
  .rc.withcam .ic { background: rgba(0,0,0,.35); } .rc.withcam .ic.on { color: var(--c); background: rgba(0,0,0,.5); }
  [hidden] { display:none !important; }
`;

const POP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .bg { position:fixed; inset:0; z-index:99; background: rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:24px;
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, sans-serif)); color: var(--primary-text-color); animation: fd .15s; }
  @keyframes fd { from { opacity:0; } }
  @keyframes su { from { transform: translateY(24px); opacity:.4; } }
  .pop { background: var(--primary-background-color, var(--card-background-color)); border-radius:24px; width: min(var(--w, 640px), 100%);
    max-height: calc(100vh - 48px); display:flex; flex-direction:column; box-shadow: 0 12px 48px rgba(0,0,0,.45); overflow:hidden; animation: su .18s; }
  .ph { display:flex; align-items:center; gap:12px; padding: 16px 16px 12px 22px; }
  .ph .bub { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center;
    background: color-mix(in srgb, var(--c, var(--primary-color)) 18%, transparent); }
  .ph .bub ha-icon { --mdc-icon-size:24px; color: var(--c, var(--primary-color)); }
  .ph .t { flex:1; font-size:22px; font-weight:600; } .ph .t small { display:block; font-size:13px; font-weight:400; color: var(--secondary-text-color); }
  .x { background: var(--secondary-background-color); border:none; width:38px; height:38px; border-radius:50%; cursor:pointer; color: var(--primary-text-color);
    display:flex; align-items:center; justify-content:center; }
  .pb { overflow:auto; padding: 4px 20px 22px; display:flex; flex-direction:column; gap:12px; }
  .lst { display:flex; flex-direction:column; background: var(--ha-card-background, var(--card-background-color)); border-radius:16px; border:1px solid var(--divider-color); overflow:hidden; }
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
  .host > * { display:block; }
  @media (max-width: 600px) { .bg { align-items:flex-end; padding:0; } .pop { border-radius:24px 24px 0 0; max-height:92vh; width:100%; } }
`;

class HomeDashboardCard extends HTMLElement {
  setConfig(config) {
    this._config = { exclude_areas: [], cameras: {}, area_power: {}, links: [], makers: [], power: {}, warnings: [],
      solar_forecast: true, battery_low: 20, hide_label: 'dashboard_ausgeblendet', ...config };
    HIDE.label = this._config.hide_label;
    if (!this.shadowRoot) this._build();
    this._camEls = this._camEls || {};
  }

  getCardSize() { return 20; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return {}; }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => { this._renderHeader(); this._fetchHist(); this._fetchForecast(); this._renderHaus(); }, 30000);
    this._onHide = () => this._render();
    HIDE.subs.add(this._onHide);
  }

  disconnectedCallback() { clearInterval(this._tick); HIDE.subs.delete(this._onHide); this._closePopup(); }

  set hass(hass) {
    this._hass = hass;
    HIDE.sync(hass);
    this._render();
    if (this._pop) this._updatePopup();
    if (!this._histTs) this._fetchHist();
    if (!this._fcTs) this._fetchForecast();
  }

  /* ---------- Grundgerüst ---------- */
  _build() {
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
      <div class="page">
        <div id="hdr"></div>
        <div id="stat" class="stat"></div>
        <section id="haussec"><h2>Haus</h2><div id="haus" class="card haus click" data-pop="power"></div></section>
        <div class="cols">
          <section id="linksec"><h2>Seiten</h2><div id="links" class="links"></div></section>
          <section><h2>Räume <small id="rcount"></small></h2><div id="rooms" class="rooms"></div></section>
        </div>
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
    const out = { lights: [], open: [], heat: [], climate: [], covers: [], updates: [], battery: [], offline: [] };
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
      if (dom === 'light') { if (st.state === 'on') out.lights.push(st); } else if (dom === 'binary_sensor') { if (OPEN_DC.includes(dc) && st.state === 'on') out.open.push(st); } else if (dom === 'climate') {
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
    const p = hass.states[this._config.person];
    const first = (p?.attributes.friendly_name || hass.user?.name || '').split(' ')[0];
    const greet = `${h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'}${first ? `, ${first}` : ''}`;
    const w = hass.states[this._config.weather];
    const pic = p?.attributes.entity_picture;
    const t = w?.attributes.temperature;
    const html = `<div class="hdr">
      <div class="who"><div class="av ${p && p.state !== 'home' ? 'away' : ''}" data-more="${esc(this._config.person || '')}" ${pic ? `style="background-image:url('${esc(pic)}')"` : ''}>${pic ? '' : '<ha-icon icon="mdi:account"></ha-icon>'}</div>
        ${w ? `<div class="wx" data-more="${esc(this._config.weather)}"><ha-icon icon="${WX[w.state] || 'mdi:weather-cloudy'}"></ha-icon><span>${t != null ? `${nf(t)}°` : '–'}</span></div>` : ''}</div>
      <div class="greet"><div class="g">${esc(greet)}</div><div class="s">${esc(now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))} · <span class="tm">${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span></div></div></div>`;
    this._set('hdr', html);
  }

  _renderStatus() {
    const hass = this._hass;
    const d = this._data;
    const items = [];
    const si = (k, icon, color, label, n, on, alert = false, act = 'pop') => items.push(`<div class="card si click ${on ? 'on' : ''} ${alert ? 'alert' : ''}" data-k="${k}"
      ${act === 'pop' ? `data-pop="${k}"` : `data-more="${esc(act)}"`} style="--c:${color}">
      <div class="bub"><ha-icon icon="${icon}"></ha-icon></div>${n ? `<span class="cnt">${n}</span>` : ''}<div class="l">${esc(label)}</div></div>`);
    si('lights', d.lights.length ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline', '#ffc107', d.lights.length ? 'Licht an' : 'Licht aus', d.lights.length, d.lights.length > 0);
    si('heat', d.heat.length ? 'mdi:radiator' : 'mdi:radiator-off', '#ff6f22', d.heat.length ? 'Heizung aktiv' : 'Heizung aus', d.heat.length, d.heat.length > 0);
    si('open', d.open.length ? 'mdi:window-open-variant' : 'mdi:window-closed-variant', '#2196f3', d.open.length ? 'Fenster offen' : 'Fenster zu', d.open.length, d.open.length > 0);
    si('covers', d.covers.length ? 'mdi:window-shutter-open' : 'mdi:window-shutter', '#9c27b0', d.covers.length ? 'Rollos offen' : 'Rollos zu', d.covers.length, d.covers.length > 0);
    const maint = d.updates.length + d.battery.length + d.offline.length;
    si('maint', 'mdi:wrench', '#ffa600', maint ? 'Wartung' : 'Alles ok', maint, maint > 0);
    const v = hass.states[this._config.valve];
    if (v) {
      const open = ['open', 'opening', 'on'].includes(v.state);
      const bad = BAD.includes(v.state);
      si('valve', open ? 'mdi:valve-open' : 'mdi:valve-closed', open ? '#00bcd4' : '#f44336', bad ? 'Ventil ?' : open ? 'Ventil offen' : 'Ventil zu', 0, !bad, !open && !bad, this._config.valve);
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
      <div class="leg"><span><i style="background:#f44336"></i>Verbrauch</span><span><i style="background:#ffc107"></i>PV</span>${fc || pw.forecast ? '<span><i style="background:repeating-linear-gradient(90deg,#4caf50 0 6px,transparent 6px 10px)"></i>PV-Prognose</span>' : ''}${pw.clearsky ? '<span><i style="background:repeating-linear-gradient(90deg,var(--secondary-text-color) 0 3px,transparent 3px 7px)"></i>Clearsky</span>' : ''}</div>`;
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
    const inDay = (pts) => (pts || []).filter((p) => p.t >= t0 && p.t <= t0 + span);
    const fc = inDay(this._attrCurve(pw.forecast, 'watts') || this._fc?.points);
    const cs = inDay(this._attrCurve(pw.clearsky, 'watts_clearsky'));
    const hi = Math.max(500, ...use.map((p) => p.v), ...pv.map((p) => p.v), ...fc.map((p) => p.v), ...cs.map((p) => p.v)) * 1.08;
    const x = (t) => (((t - t0) / span) * W).toFixed(1);
    const y = (v) => (H - (Math.max(0, v) / hi) * H).toFixed(1);
    const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v)}`).join('');
    const now = Date.now();
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">`;
    for (const f of [0.25, 0.5, 0.75]) svg += `<line x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}"/>`;
    svg += '</g>';
    if (pv.length > 1) svg += `<path class="pv" d="${line(pv)}L${x(pv[pv.length - 1].t)},${H}L${x(pv[0].t)},${H}Z"/>`;
    if (cs.length > 1) svg += `<path class="cs" d="${line(cs)}"/>`;
    if (fc.length > 1) svg += `<path class="fc" d="${line(fc)}"/>`;
    if (use.length > 1) svg += `<path class="use" d="${line(use)}"/>`;
    svg += `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="0" y2="${H}"/></svg>`;
    return `${svg}<span class="ymax">${fW(hi / 1.08)}</span>`;
  }

  async _fetchHist() {
    const hass = this._hass;
    if (!hass || this._histBusy || (this._histTs && Date.now() - this._histTs < 5 * 60000)) return;
    const pw = this._config.power || {};
    const main = [pw.house, pw.pv].filter((id) => id && hass.states[id]);
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
    const ids = Object.keys(devs).filter((id) => hass.devices[id] && !hass.devices[id].disabled_by);
    const off = ids.filter((id) => devs[id].every((s) => s.state === 'unavailable')).length;
    return (this._lsCache[integration] = { n: ids.length, off, upd, act });
  }

  _renderLinks() {
    const hass = this._hass;
    const html = (this._config.links || []).map((l, i) => {
      const info = [];
      if (l.integration) {
        const s = this._linkStats(l.integration);
        info.push(`${s.n} Gerät${s.n === 1 ? '' : 'e'}`);
        if (s.n) info.push(...(s.off ? [`<span class="ok">${s.n - s.off} online</span>`, `<span class="err">${s.off} offline</span>`] : ['<span class="ok">alle online</span>']));
        if (s.upd) info.push(`<span class="warn">${s.upd} Update${s.upd === 1 ? '' : 's'}</span>`);
      }
      if (l.entity && hass.states[l.entity]) {
        const st = hass.states[l.entity];
        info.push(esc(typeof hass.formatEntityState === 'function' ? hass.formatEntityState(st) : st.state));
      }
      if (l.text) info.push(esc(l.text));
      return `<div class="card lk click" data-k="l${i}" data-link="${i}" style="--c:${esc(l.color || 'var(--primary-color)')}">
        <div class="bub"><ha-icon icon="${esc(l.icon || 'mdi:open-in-app')}"></ha-icon></div>
        <div class="n"><b>${esc(l.name || l.path)}</b><span>${info.join(' · ')}</span></div><ha-icon icon="mdi:chevron-right"></ha-icon></div>`;
    }).join('');
    this._set('links', html);
    this.shadowRoot.getElementById('linksec').hidden = !(this._config.links || []).length;
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
    if (sw.length) { const n = sw.filter((s) => s.state === 'on').length; ic(n ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off-outline', '#03a9f4', n, n > 0, `${n} von ${sw.length} Schaltern an`); }
    const cov = of('cover');
    if (cov.length) { const n = cov.filter((s) => s.state !== 'closed').length; ic(n ? 'mdi:window-shutter-open' : 'mdi:window-shutter', '#9c27b0', n, n > 0, `${n} von ${cov.length} Rollos offen`); }
    const media = of('media_player');
    if (media.length) { const n = media.filter((s) => s.state === 'playing').length; ic(n ? 'mdi:play-circle' : 'mdi:speaker', '#2196f3', n, n > 0, n ? 'Wiedergabe' : 'Medien'); }
    const open = sts.filter((s) => s.entity_id.startsWith('binary_sensor.') && OPEN_DC.includes(s.attributes.device_class));
    if (open.some((s) => s.state === 'on')) { const n = open.filter((s) => s.state === 'on').length; ic('mdi:window-open-variant', '#2196f3', n, true, `${n} offen`); }
    const camId = this._config.cameras[a.area_id];
    const cams = camId ? [hass.states[camId]].filter(Boolean) : of('camera');
    if (cams.length) ic('mdi:cctv', '#009688', cams.length > 1 ? cams.length : 0, cams.some((s) => !BAD.includes(s.state)), 'Kamera');
    return out.join('');
  }

  _renderRooms() {
    const hass = this._hass;
    const areas = this._areas();
    const html = areas.map((a) => {
      const sts = this._areaStates(a.area_id);
      const c = this._climate(a, sts);
      const pid = this._powerId(a);
      const p = num(hass.states[pid]);
      const cam = this._config.cameras[a.area_id] && hass.states[this._config.cameras[a.area_id]];
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
    for (const [areaId, id] of Object.entries(this._config.cameras || {})) {
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
    const link = path.find((el) => el.dataset && el.dataset.link);
    if (link) { const l = this._config.links[Number(link.dataset.link)]; if (l?.path) this._navigate(l.path); return; }
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
    const r = host.shadowRoot;
    this._pop = { key, host, r, els: [], html: null };
    // Ereignisse aus dem Popup (liegt an <body>) an Home Assistant weiterreichen
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
    this._escKey = (e) => { if (e.key === 'Escape' && this._pop) this._closePopup(); };
    window.addEventListener('keydown', this._escKey);
    document.body.appendChild(host);
    this._fillPopup();
  }

  _closePopup() {
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
        min_width: 300, hide_label: this._config.hide_label });
      el._area = arg;
      this._popEl(el);
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
      case 'open':
        this._popHead('mdi:window-open-variant', '#2196f3', 'Fenster & Türen', `${d.open.length} offen`, 520);
        return list(byArea(d.open).map((s) => this._row(s, 'offen', 'mdi:window-open-variant', '#2196f3')));
      case 'covers':
        this._popHead('mdi:window-shutter-open', '#9c27b0', 'Rollos', `${d.covers.length} offen`, 520);
        return list(byArea(d.covers).map((s) => this._row(s, fmt(s), 'mdi:window-shutter-open', '#9c27b0')));
      case 'maint': {
        this._popHead('mdi:wrench', '#ffa600', 'Wartung', '', 620);
        const sec = (t, rows) => (rows.length ? `<div class="sec">${t}</div><div class="lst">${rows.join('')}</div>` : '');
        const html = sec('Updates', d.updates.map((s) => `<div class="it" data-k="${s.entity_id}" data-more="${s.entity_id}"><ha-icon icon="mdi:package-up" style="--c:#ffa600"></ha-icon>
            <div class="n">${esc(this._name(s))}<small>${esc(s.attributes.installed_version || '')} → ${esc(s.attributes.latest_version || '')}</small></div>
            <button class="btn" data-act="install" data-e="${s.entity_id}" data-n="${esc(this._name(s))}">Installieren</button></div>`))
          + sec('Batterien', d.battery.map((s) => this._row(s, fmt(s), 'mdi:battery-alert-variant-outline', '#db4437')))
          + sec('Nicht erreichbar', d.offline.map(({ devId, d: dv }) => `<div class="it" data-k="${esc(devId)}" data-act="device" data-d="${esc(devId)}"><ha-icon icon="mdi:lan-disconnect" style="--c:#db4437"></ha-icon>
            <div class="n">${esc(dv.name_by_user || dv.name)}<small>${esc([hass.areas[dv.area_id]?.name, dv.manufacturer, dv.model].filter(Boolean).join(' · '))}</small></div></div>`));
        return html || '<div class="none">Nichts zu tun.</div>';
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
