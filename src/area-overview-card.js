/*
 * Area Overview Card – Bereichsübersicht im Stil der Home-Assistant-Übersicht.
 * Oben die Bereiche als Auswahl, darunter die Geräte des gewählten Bereichs.
 * Geräte, für die es eine eigene Manager Card gibt (Shelly, Tasmota, ESPHome, X-Sense,
 * Proxmox, Miele, Grohe, Schlüter), werden mit genau dieser Karte dargestellt – auf den
 * Bereich gefiltert und ohne deren Kopfleiste. Alle übrigen Geräte bekommen eine Kachel im
 * gleichen Stil. Neue Geräte und Bereiche erscheinen automatisch.
 *
 * Konfiguration:
 *   type: custom:area-overview-card
 *   makers:                      # Manager Cards in der gewünschten Reihenfolge (Optionen wie auf den Geräteseiten)
 *     - type: custom:shelly-manager-card
 *       integration: shelly
 *   title: Bereiche              # optional
 *   exclude_areas: [pv]          # optional, Bereichs-IDs ausblenden
 *   show_other: true             # optional, Geräte ohne eigene Manager Card anzeigen
 *   min_width: 300               # optional, Mindestbreite der Kacheln für „Weitere Geräte“
 *   power: { kuche: sensor.x }   # optional, Leistungssensor je Bereich (Standard: sensor.leistung_<bereich_id>)
 *   cameras: { buro: camera.x }  # optional, Kamera-Button je Bereich (öffnet das Kamera-Popup)
 *   hide_label: dashboard_ausgeblendet  # Label, mit dem Geräte in Popups ausgeblendet werden
 *   mode: full                   # full = Auswahl + Geräte, list = nur Bereichsliste (Zeilen mit Schnell-Buttons),
 *                                # devices = nur Geräte des gewählten Bereichs (Auswahl kommt aus einer list-Karte)
 *
 * Zusätzlich: type: custom:home-summary-card – Zusammenfassungen (Lichter, Fenster, Thermostate, Batterien …)
 *   battery_low: 20              # optional, Schwelle für „Batterie niedrig“ in %
 *   links:                       # optional, zusätzliche Kacheln mit Verlinkung
 *     - { name: Frigate, icon: mdi:cctv, path: /dashboard-frigate, color: '#e53935' }
 */
const VERSION = '1.4.0';
const EVT = 'area-overview-card-area';
const STORE = 'area-overview-card.area';
const BAD = ['unavailable', 'unknown'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  /** Integrationen nur für Administratoren: für andere Benutzer komplett unsichtbar (nicht „ausgeblendet“) */
  restrict(hass, list) {
    const on = !!hass && !hass.user?.is_admin && Array.isArray(list) && list.length > 0;
    const key = on ? [...list].sort().join(',') : '';
    if (key === (this.rkey || '') && (!on || this.rref === hass.entities)) return;
    this.rkey = key; this.rref = on ? hass.entities : null;
    this.rset = new Set(on ? list : []);
    this.rdev = new Set(on ? Object.values(hass.entities || {}).filter((e) => this.rset.has(e.platform) && e.device_id).map((e) => e.device_id) : []);
    this.notify();
  },
  restricted(e) { return !!e && !!this.rset && this.rset.size > 0 && (this.rset.has(e.platform) || (!!e.device_id && this.rdev.has(e.device_id))); },
  restrictedDev(id) { return !!this.rdev && this.rdev.has(id); },
  /** Entität (Registry-Eintrag) ausgeblendet – direkt oder über ihr Gerät, oder nur für Administratoren */
  hidden(e) { return !!e && ((e.device_id && this.ids.has(e.device_id)) || (this.ents && this.ents.has(e.entity_id)) || this.restricted(e)); },
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

const MAKER_META = {
  'shelly-manager-card': { name: 'Shelly', icon: 'mdi:alpha-s-box' },
  'tasmota-manager-card': { name: 'Tasmota', icon: 'mdi:alpha-t-box' },
  'esphome-manager-card': { name: 'ESPHome', icon: 'mdi:alpha-e-box' },
  'xsense-manager-card': { name: 'X-Sense', icon: 'mdi:smoke-detector-variant' },
  'proxmox-manager-card': { name: 'Proxmox', icon: 'mdi:server-network' },
  'miele-manager-card': { name: 'Miele', icon: 'mdi:alpha-m-box' },
  'grohe-manager-card': { name: 'Grohe', icon: 'mdi:water-check-outline' },
  'schlueter-manager-card': { name: 'Schlüter', icon: 'mdi:heat-wave' },
  'localthings-manager-card': { name: 'Samsung', icon: 'mdi:alpha-l-box' },
  'pihole-manager-card': { name: 'Pi-hole', icon: 'mdi:pi-hole' },
};

const DOMAIN_ICON = {
  light: 'mdi:lightbulb', switch: 'mdi:toggle-switch-outline', cover: 'mdi:window-shutter', climate: 'mdi:thermostat',
  fan: 'mdi:fan', lock: 'mdi:lock', media_player: 'mdi:speaker', vacuum: 'mdi:robot-vacuum', camera: 'mdi:cctv',
  binary_sensor: 'mdi:checkbox-blank-circle-outline', sensor: 'mdi:eye', water_heater: 'mdi:water-boiler',
  humidifier: 'mdi:air-humidifier', valve: 'mdi:valve', lawn_mower: 'mdi:robot-mower', alarm_control_panel: 'mdi:shield-home',
};
const MAIN_DOMAINS = ['light', 'switch', 'cover', 'climate', 'fan', 'lock', 'media_player', 'vacuum', 'water_heater', 'humidifier',
  'valve', 'lawn_mower', 'alarm_control_panel', 'input_boolean'];
const SHOW_DOMAINS = [...MAIN_DOMAINS, 'sensor', 'binary_sensor', 'number', 'select', 'input_number', 'input_select', 'camera'];
const TOGGLE_DOMAINS = ['light', 'switch', 'fan', 'input_boolean', 'humidifier'];

/* Abgeleitete Manager Card: nur Geräte des gewählten Bereichs, ohne eigene Kopfleiste. */
const variantTag = (tag) => `aoc-${tag}`;
async function defineVariant(tag) {
  const vt = variantTag(tag);
  if (customElements.get(vt)) return vt;
  await customElements.whenDefined(tag);
  if (customElements.get(vt)) return vt;
  const Base = customElements.get(tag);
  customElements.define(vt, class extends Base {
    setConfig(config) {
      super.setConfig(config);
      if (this.shadowRoot && !this.shadowRoot.querySelector('style[data-aoc]')) {
        const s = document.createElement('style');
        s.dataset.aoc = '1';
        s.textContent = `:host { padding:0 !important; } .toolbar { display:none !important; }
          .aoc-hidden { opacity:.5; border-style:dashed !important; }
          .aoc-hide { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
          .aoc-hide:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }`;
        this.shadowRoot.appendChild(s);
      }
    }
    _collect() {
      const all = super._collect() || [];
      const area = this._config && this._config.area_filter;
      const devs = (this._hass && this._hass.devices) || {};
      const showHidden = this._config && this._config.show_hidden;
      return all.filter((d) => ((d.reg && d.reg.area_id) || (devs[d.id] && devs[d.id].area_id) || null) === area
        && (showHidden || !HIDE.ids.has(d.id)) && !HIDE.restrictedDev(d.id));
    }
    _updateCard(d) {
      const el = super._updateCard(d);
      if (!el || !el.querySelector) return el;
      let b = el.querySelector('.aoc-hide');
      if (!b) {
        b = document.createElement('button');
        b.className = 'aoc-hide';
        b.innerHTML = '<ha-icon></ha-icon>';
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          HIDE.set(this._hass, d.id, !HIDE.ids.has(d.id)).catch((err) => this.dispatchEvent(new CustomEvent('hass-notification',
            { detail: { message: `Ausblenden fehlgeschlagen: ${err.message || err}` }, bubbles: true, composed: true })));
        });
        const head = el.querySelector('.head');
        if (head) head.insertBefore(b, head.lastElementChild); else el.prepend(b);
      }
      const hid = HIDE.ids.has(d.id);
      const icon = hid ? 'mdi:eye-outline' : 'mdi:eye-off-outline';
      if (b.firstElementChild.getAttribute('icon') !== icon) b.firstElementChild.setAttribute('icon', icon);
      b.title = hid ? 'Wieder einblenden' : 'Im Dashboard ausblenden';
      el.classList.toggle('aoc-hidden', hid);
      return el;
    }
  });
  return vt;
}

class AreaOverviewCard extends HTMLElement {
  setConfig(config) {
    this._config = { title: 'Bereiche', makers: [], exclude_areas: [], show_other: true, min_width: 300, mode: 'full', hide_label: 'dashboard_ausgeblendet', ...config };
    HIDE.label = this._config.hide_label;
    this._mode = ['list', 'devices'].includes(this._config.mode) ? this._config.mode : 'full';
    this._makerCfg = (this._config.makers || []).map((m) => ({ ...m, tag: String(m.type || '').replace(/^custom:/, '') }))
      .filter((m) => m.tag);
    this._makers = this._makers || {};
    this._sig = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
    try { this._area = this._area || localStorage.getItem(STORE) || ''; } catch (e) { this._area = this._area || ''; }
    this.shadowRoot.host.dataset.mode = this._mode;
    if (this._mode === 'list') return;
    for (const m of this._makerCfg) {
      defineVariant(m.tag).then(() => this._render(true)).catch((err) => console.warn('area-overview-card:', m.tag, err));
    }
  }

  getCardSize() { return this._mode === 'list' ? 8 : 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { makers: [] }; }

  connectedCallback() {
    this._onBus = (e) => {
      if (!e.detail || e.detail.area === this._area || e.detail.src === this) return;
      this._area = e.detail.area;
      this._render(true);
      if (this._mode === 'devices' && e.detail.user) {
        const r = this.getBoundingClientRect();
        if (r.top < 0 || r.top > window.innerHeight * 0.6) this.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    window.addEventListener(EVT, this._onBus);
    this._onHide = () => this._render(true);
    HIDE.subs.add(this._onHide);
  }

  disconnectedCallback() { window.removeEventListener(EVT, this._onBus); HIDE.subs.delete(this._onHide); }

  _select(areaId) {
    this._area = areaId;
    try { localStorage.setItem(STORE, areaId); } catch (err) { /* ignore */ }
    this._render(true);
    window.dispatchEvent(new CustomEvent(EVT, { detail: { area: areaId, src: this, user: true } }));
  }

  set hass(hass) {
    const regChanged = !this._hass || hass.devices !== this._hass.devices || hass.entities !== this._hass.entities || hass.areas !== this._hass.areas;
    this._hass = hass;
    HIDE.sync(hass);
    if (this._config.admin_only) HIDE.restrict(hass, this._config.admin_only);
    this._render(regChanged);
  }

  /* ---------- Daten ---------- */
  _areas() {
    const hass = this._hass;
    const ex = new Set(this._config.exclude_areas || []);
    return Object.values(hass.areas || {}).filter((a) => !ex.has(a.area_id))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  _visibleEntities(devId) {
    const hass = this._hass;
    return Object.values(hass.entities || {}).filter((e) => e.device_id === devId && !e.hidden && hass.states[e.entity_id]);
  }

  /** Geräte und Entitäten ohne Gerät je Bereich */
  _index() {
    const hass = this._hass;
    const byArea = {};
    const devEnts = {};
    for (const e of Object.values(hass.entities || {})) {
      if (e.hidden || !hass.states[e.entity_id] || HIDE.restricted(e)) continue;
      if (e.device_id) {
        (devEnts[e.device_id] ||= []).push(e);
        // Entität mit eigenem Bereich (abweichend vom Gerät) zählt im Bereich der Entität
        const dev = hass.devices[e.device_id];
        if (e.area_id && dev && e.area_id !== dev.area_id) ((byArea[e.area_id] ||= { devices: new Set(), loose: [] }).loose).push(e);
      } else if (e.area_id) {
        ((byArea[e.area_id] ||= { devices: new Set(), loose: [] }).loose).push(e);
      }
    }
    for (const [devId, ents] of Object.entries(devEnts)) {
      const dev = hass.devices[devId];
      if (!dev || dev.disabled_by || !dev.area_id) continue;
      if (!ents.some((e) => !e.entity_category)) continue;
      (byArea[dev.area_id] ||= { devices: new Set(), loose: [] }).devices.add(devId);
    }
    this._devEnts = devEnts;
    return byArea;
  }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; box-sizing:border-box; }
        .areas { display:flex; gap:8px; overflow-x:auto; padding:2px 2px 10px; scrollbar-width:thin; }
        .achip { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:20px; cursor:pointer; white-space:nowrap;
          background: var(--ha-card-background, var(--card-background-color)); border:1px solid var(--divider-color);
          color: var(--primary-text-color); font: inherit; font-size:14px; flex:none; }
        .achip ha-icon { --mdc-icon-size:20px; color: var(--state-icon-color, var(--secondary-text-color)); }
        .achip .n { font-size:12px; color: var(--secondary-text-color); }
        .achip:hover { background: var(--secondary-background-color); }
        .achip.sel { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
        .achip.sel ha-icon, .achip.sel .n { color: inherit; }
        .ahead { display:flex; align-items:center; gap:14px; padding:12px 16px; margin:4px 0 12px;
          background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px); }
        .ahead > ha-icon { --mdc-icon-size:32px; }
        .ahead .t { font-size:22px; font-weight:500; margin-right:auto; }
        .ahead .t small { display:block; font-size:13px; opacity:.85; font-weight:400; }
        .sum { display:flex; flex-wrap:wrap; gap:8px; }
        .sum span { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border-radius:12px; background: rgba(255,255,255,.15); font-size:14px; cursor:pointer; }
        .sum ha-icon { --mdc-icon-size:18px; }
        .grp { margin-bottom:16px; }
        .grp[hidden] { display:none; }
        .gh { display:flex; align-items:center; gap:8px; font-size:16px; font-weight:500; margin:4px 4px 8px; color: var(--primary-text-color); }
        .gh ha-icon { --mdc-icon-size:20px; color: var(--secondary-text-color); }
        .gh .c { font-size:13px; font-weight:400; color: var(--secondary-text-color); }
        .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(var(--aoc-min, 300px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }
        .dev.hidden-dev { opacity:.5; border-style:dashed; }
        .row.hidrow { opacity:.5; }
        .row .rhide { padding:2px; margin-left:4px; flex:none; } .row .rhide ha-icon { --mdc-icon-size:16px; }
        .head { display:flex; align-items:center; gap:12px; padding:14px 14px 6px; }
        .ico { position:relative; width:44px; height:44px; border-radius:10px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:28px; color: var(--state-icon-color, var(--primary-color)); }
        .ico.on ha-icon { color: var(--state-active-color, var(--amber-color, #ffc107)); }
        .dot { position:absolute; right:-3px; bottom:-3px; width:14px; height:14px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:17px; font-weight:600; line-height:1.2; flex:1; min-width:0; overflow-wrap:anywhere; }
        .name small { display:block; font-size:12px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .rows { padding: 2px 14px 10px; flex:1; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 0; font-size:14px;
          border-top: 1px solid var(--divider-color); cursor:pointer; }
        .row:first-child { border-top:none; }
        .row .lbl { color: var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:6px; }
        .row .lbl ha-icon { --mdc-icon-size:18px; }
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; }
        .row.more { justify-content:center; color: var(--primary-color); font-size:13px; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .cover { display:flex; gap:2px; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        :host([data-mode="list"]) #areas, :host([data-mode="list"]) #ahead, :host([data-mode="list"]) #makers,
        :host([data-mode="list"]) #other, :host([data-mode="list"]) #empty { display:none !important; }
        :host(:not([data-mode="list"])) #alist { display:none; }
        :host([data-mode="devices"]) #areas { display:none; }
        :host([data-mode="devices"]) .ahead { margin-top:0; }
        .alist { display:flex; flex-direction:column; gap:8px; }
        .arow { display:flex; align-items:center; gap:12px; padding:10px 12px; cursor:pointer;
          background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          border: 1px solid var(--divider-color); box-shadow: var(--ha-card-box-shadow, none); transition: border-color .15s, background .15s; }
        .arow:hover { background: var(--secondary-background-color); }
        .arow.sel { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
        .arow > ha-icon { --mdc-icon-size:28px; color: var(--state-icon-color, var(--primary-color)); flex:none; width:36px; display:flex; justify-content:center; }
        .arow .an { flex:1; min-width:0; font-size:15px; font-weight:500; line-height:1.25; }
        .arow .an small { display:block; font-size:13px; font-weight:400; color: var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .qb { display:flex; gap:6px; flex:none; }
        .q { width:40px; height:40px; border-radius:10px; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center;
          background: var(--secondary-background-color); color: var(--secondary-text-color); }
        .q ha-icon { --mdc-icon-size:22px; }
        .q.on.light { background: rgba(255,193,7,.22); color: var(--amber-color, #ffc107); }
        .q.on.cover { background: rgba(156,39,176,.18); color: var(--purple-color, #9c27b0); }
        .q.on.climate { background: rgba(255,111,34,.18); color: var(--deep-orange-color, #ff6f22); }
        .q.on.media { background: rgba(33,150,243,.18); color: var(--blue-color, #2196f3); }
        .q.on.cam { background: rgba(0,150,136,.18); color: var(--teal-color, #009688); }
        .q.on.open { background: rgba(33,150,243,.18); color: var(--blue-color, #2196f3); }
      </style>
      <div class="alist" id="alist"></div>
      <div class="areas" id="areas"></div>
      <div id="ahead"></div>
      <div id="makers"></div>
      <div class="grp" id="other" hidden>
        <div class="gh"><ha-icon icon="mdi:devices"></ha-icon><span>Weitere Geräte</span><span class="c" id="ocount"></span></div>
        <div class="grid" id="ogrid"></div>
      </div>
      <div class="empty" id="empty" hidden>In diesem Bereich sind keine Geräte.</div>`;
    const root = this.shadowRoot;
    root.getElementById('areas').addEventListener('click', (e) => {
      const chip = e.composedPath().find((el) => el.dataset && el.dataset.area);
      if (!chip) return;
      this._select(chip.dataset.area);
    });
    root.getElementById('alist').addEventListener('click', (e) => {
      const path = e.composedPath();
      const btn = path.find((el) => el.dataset && el.dataset.act);
      if (btn) { e.stopPropagation(); this._areaAction(btn.dataset); return; }
      const row = path.find((el) => el.dataset && el.dataset.area);
      if (row) this._select(row.dataset.area);
    });
    for (const id of ['ahead', 'ogrid']) root.getElementById(id).addEventListener('click', (e) => this._onClick(e));
  }

  _render(full) {
    if (!this._hass || !this._config) return;
    const hass = this._hass;
    const root = this.shadowRoot;
    root.host.style.setProperty('--aoc-min', `${this._config.min_width}px`);
    const areas = this._areas();
    if (!areas.length) return;
    if (!areas.some((a) => a.area_id === this._area)) this._area = areas[0].area_id;
    const area = areas.find((a) => a.area_id === this._area);
    if (full || !this._index_) this._index_ = this._index();
    const idx = this._index_;
    const data = idx[area.area_id] || { devices: new Set(), loose: [] };
    if (this._mode === 'list') { this._renderList(areas, idx, area); return; }

    // Bereichsauswahl
    const chips = areas.map((a) => {
      const n = idx[a.area_id] ? idx[a.area_id].devices.size : 0;
      return `<button class="achip ${a.area_id === area.area_id ? 'sel' : ''}" data-k="${esc(a.area_id)}" data-area="${esc(a.area_id)}">
        <ha-icon icon="${esc(a.icon || 'mdi:texture-box')}"></ha-icon>${esc(a.name)}<span class="n">${n}</span></button>`;
    }).join('');
    if (chips !== this._chipsHtml) {
      morph(root.getElementById('areas'), chips);
      this._chipsHtml = chips;
      // gewählten Bereich in der Leiste sichtbar halten, ohne die Seite zu scrollen
      const bar = root.getElementById('areas'); const sel = root.querySelector('.achip.sel');
      if (sel && (sel.offsetLeft < bar.scrollLeft || sel.offsetLeft + sel.offsetWidth > bar.scrollLeft + bar.clientWidth)) {
        bar.scrollLeft = sel.offsetLeft - 8;
      }
    }

    // Kopf mit Zusammenfassung (Temperatur, Luftfeuchte, Lichter an)
    const areaEnts = Object.values(hass.entities || {}).filter((e) => !e.hidden && !HIDE.hidden(e) && hass.states[e.entity_id]
      && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id)) === area.area_id);
    const pick = (dc) => areaEnts.map((e) => hass.states[e.entity_id])
      .filter((s) => s.entity_id.startsWith('sensor.') && s.attributes.device_class === dc && !BAD.includes(s.state) && !Number.isNaN(parseFloat(s.state)));
    const avg = (list) => list.reduce((s, x) => s + parseFloat(x.state), 0) / list.length;
    const cl = this._climate(area, areaEnts);
    const temps = pick('temperature'); const hums = pick('humidity');
    if (cl.temp != null) temps.unshift({ entity_id: area.temperature_entity_id || temps[0]?.entity_id, state: String(cl.temp), attributes: { unit_of_measurement: '°C' } });
    if (cl.temp != null && temps.length > 1) temps.length = 1;
    if (cl.hum != null) { hums.length = 0; hums.push({ entity_id: area.humidity_entity_id || pick('humidity')[0]?.entity_id, state: String(cl.hum), attributes: {} }); }
    const lights = areaEnts.filter((e) => e.entity_id.startsWith('light.') && !e.entity_category);
    const lightsOn = lights.filter((e) => hass.states[e.entity_id].state === 'on');
    const sum = [];
    if (temps.length) sum.push(`<span data-more="${temps[0].entity_id}" title="${temps.length > 1 ? `Mittel aus ${temps.length} Sensoren` : ''}"><ha-icon icon="mdi:thermometer"></ha-icon>${avg(temps).toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${esc(temps[0].attributes.unit_of_measurement || '°C')}</span>`);
    if (hums.length) sum.push(`<span data-more="${hums[0].entity_id}"><ha-icon icon="mdi:water-percent"></ha-icon>${Math.round(avg(hums))} %</span>`);
    const pwh = this._powerEntity(area);
    if (pwh) sum.push(`<span data-more="${pwh.entity_id}"><ha-icon icon="mdi:flash"></ha-icon>${esc(this._fmtPower(pwh))}</span>`);
    // ein Kamera-Button für alle Kameras des Bereichs (konfigurierte und zugeordnete, auch ausgeblendete)
    const cams = [...new Set([(this._config.cameras || {})[area.area_id], ...Object.values(hass.entities || {})
      .filter((e) => e.entity_id.startsWith('camera.') && !HIDE.restricted(e) && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id)) === area.area_id)
      .map((e) => e.entity_id)])].filter((id) => id && hass.states[id]);
    if (cams.length === 1) sum.push(`<span data-more="${esc(cams[0])}"><ha-icon icon="mdi:cctv"></ha-icon>Kamera</span>`);
    else if (cams.length) sum.push(`<span data-act="cams" data-ids="${esc(cams.join(','))}" data-n="${esc(area.name)}"><ha-icon icon="mdi:cctv"></ha-icon>${cams.length} Kameras</span>`);
    if (lights.length) sum.push(`<span data-more="${(lightsOn[0] || lights[0]).entity_id}"><ha-icon icon="${lightsOn.length ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline'}"></ha-icon>${lightsOn.length ? `${lightsOn.length} an` : 'aus'}</span>`);
    const nHidden = [...data.devices].filter((id) => HIDE.ids.has(id)).length + data.loose.filter((e) => HIDE.ents.has(e.entity_id)).length;
    if (nHidden || this._showHidden) {
      sum.push(`<span data-act="showhidden" title="Ausgeblendete Geräte ${this._showHidden ? 'verbergen' : 'anzeigen'}"><ha-icon icon="${this._showHidden ? 'mdi:eye-off-outline' : 'mdi:eye-outline'}"></ha-icon>${nHidden} ausgeblendet</span>`);
    }
    const nShown = data.devices.size - (this._showHidden ? 0 : nHidden);
    const head = `<div class="ahead"><ha-icon icon="${esc(area.icon || 'mdi:texture-box')}"></ha-icon>
      <div class="t">${esc(area.name)}<small>${nShown} Gerät${nShown === 1 ? '' : 'e'}</small></div>
      <div class="sum">${sum.join('')}</div></div>`;
    if (head !== this._headHtml) { morph(root.getElementById('ahead'), head); this._headHtml = head; }

    // Hersteller-Karten
    const covered = new Set();
    const host = root.getElementById('makers');
    this._makerCfg.forEach((m, i) => {
      const vt = variantTag(m.tag);
      if (!customElements.get(vt)) return;
      // Integrationen nur für Administratoren
      if (m.integration && HIDE.rset && HIDE.rset.has(m.integration)) { if (this._makers[i]) this._makers[i].wrap.hidden = true; return; }
      let mk = this._makers[i];
      if (!mk || mk.tag !== m.tag) {
        const wrap = document.createElement('div');
        wrap.className = 'grp';
        const meta = MAKER_META[m.tag] || { name: m.name || m.tag, icon: 'mdi:devices' };
        wrap.innerHTML = `<div class="gh"><ha-icon icon="${esc(m.icon || meta.icon)}"></ha-icon><span>${esc(m.name || meta.name)}</span><span class="c"></span></div>`;
        const el = document.createElement(vt);
        wrap.appendChild(el);
        mk = this._makers[i] = { tag: m.tag, wrap, el, count: wrap.querySelector('.c'), area: null };
      }
      if (mk.wrap.parentNode !== host || host.children[i] !== mk.wrap) host.insertBefore(mk.wrap, host.children[i] || null);
      try {
        if (mk.area !== area.area_id || full) {
          const { type, tag, name, icon, ...cfg } = m;
          // gleiche Kachelbreite für alle Hersteller und „Weitere Geräte“
          mk.el.setConfig({ ...cfg, min_width: this._config.min_width, area_filter: area.area_id, show_hidden: !!this._showHidden });
          mk.area = area.area_id;
        }
        if (full || !mk.wrap.hidden) mk.el.hass = hass;
      } catch (err) {
        console.warn('area-overview-card:', m.tag, err);
      }
      const devs = mk.el._devices || [];
      devs.forEach((d) => covered.add(d.id));
      mk.wrap.hidden = !devs.length;
      mk.count.textContent = devs.length ? `${devs.length}` : '';
    });

    // Weitere Geräte
    const other = this._config.show_other
      ? [...data.devices].filter((id) => !covered.has(id) && (this._showHidden || !HIDE.ids.has(id))).map((id) => this._genericDevice(id)).filter(Boolean)
      : [];
    if (this._config.show_other && data.loose.length) {
      // Entitäten ohne Gerät: einzeln oder als ganze Gruppe per Entitäts-Label ausblendbar
      const items = data.loose.filter((e) => this._showHidden || !HIDE.ents.has(e.entity_id))
        .map((e) => { const x = this._item(e, ''); if (x) { x.loose = true; x.hid = HIDE.ents.has(e.entity_id); } return x; }).filter(Boolean);
      if (items.length) {
        other.push({ id: `loose:${area.area_id}`, name: 'Sonstiges', sub: 'Entitäten ohne Gerät', icon: 'mdi:shape-outline', items, online: true, on: false,
          loose: true, allHidden: items.every((x) => x.hid) });
      }
    }
    other.sort((a, b) => (a.id.startsWith('loose:') - b.id.startsWith('loose:')) || a.name.localeCompare(b.name, 'de'));
    const og = root.getElementById('other');
    og.hidden = !other.length;
    root.getElementById('ocount').textContent = other.length ? `${other.length}` : '';
    this._patchOther(other);
    root.getElementById('empty').hidden = !!(other.length || this._makerCfg.some((m, i) => this._makers[i] && !this._makers[i].wrap.hidden));
  }

  /* ---------- Bereichsliste (mode: list) ---------- */
  /** Sichtbare Entitäten eines Bereichs (Bereich der Entität vor Bereich des Geräts) */
  _areaEntities(areaId) {
    const hass = this._hass;
    return Object.values(hass.entities || {}).filter((e) => !e.hidden && !e.entity_category && hass.states[e.entity_id]
      && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id)) === areaId);
  }

  _powerEntity(area) {
    const hass = this._hass;
    const id = (this._config.power || {})[area.area_id] || `sensor.leistung_${area.area_id}`;
    const st = hass.states[id];
    if (!st || BAD.includes(st.state) || Number.isNaN(parseFloat(st.state))) return null;
    return st;
  }

  _fmtPower(st) {
    const v = parseFloat(st.state);
    const u = st.attributes.unit_of_measurement || 'W';
    if (u === 'W' && Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
    return `${v.toLocaleString('de-DE', { maximumFractionDigits: u === 'W' ? (Math.abs(v) < 10 ? 1 : 0) : 2 })} ${u}`;
  }

  _climate(area, ents) {
    const hass = this._hass;
    const num = (id) => { const s = id && hass.states[id]; const v = s ? parseFloat(s.state) : NaN; return Number.isNaN(v) ? null : { v, s }; };
    const pick = (dc) => ents.map((e) => hass.states[e.entity_id])
      .filter((s) => s.entity_id.startsWith('sensor.') && s.attributes.device_class === dc && !BAD.includes(s.state) && !Number.isNaN(parseFloat(s.state)));
    const t = num(area.temperature_entity_id); const h = num(area.humidity_entity_id);
    const ts = pick('temperature'); const hs = pick('humidity');
    const avg = (l) => l.reduce((a, x) => a + parseFloat(x.state), 0) / l.length;
    return {
      temp: t ? t.v : ts.length ? avg(ts) : null,
      hum: h ? h.v : hs.length ? avg(hs) : null,
    };
  }

  _renderList(areas, idx, sel) {
    const hass = this._hass;
    const nf = (v, d) => v.toLocaleString('de-DE', { maximumFractionDigits: d });
    const rows = areas.map((a) => {
      const ents = this._areaEntities(a.area_id);
      const c = this._climate(a, ents);
      const n = idx[a.area_id] ? idx[a.area_id].devices.size : 0;
      const pw = this._powerEntity(a);
      const sub = [c.temp != null && `${nf(c.temp, 1)} °C`, c.hum != null && `${nf(c.hum, 0)} %`, pw && `⚡ ${this._fmtPower(pw)}`].filter(Boolean).join(' · ')
        || `${n} Gerät${n === 1 ? '' : 'e'}`;
      const of = (dom) => ents.filter((e) => e.entity_id.startsWith(`${dom}.`)).map((e) => hass.states[e.entity_id]);
      const btns = [];
      const cam = (this._config.cameras || {})[a.area_id];
      if (cam && hass.states[cam]) {
        const camOn = !BAD.includes(hass.states[cam].state);
        btns.push(`<button class="q cam ${camOn ? 'on' : ''}" data-act="more" data-e="${esc(cam)}" title="Kamera ${esc(hass.states[cam].attributes.friendly_name || '')}"><ha-icon icon="${camOn ? 'mdi:cctv' : 'mdi:cctv-off'}"></ha-icon></button>`);
      }
      const openings = ents.map((e) => hass.states[e.entity_id]).filter((s) => s.entity_id.startsWith('binary_sensor.')
        && ['door', 'window', 'garage_door', 'opening'].includes(s.attributes.device_class) && s.state === 'on');
      if (openings.length) btns.push(`<button class="q on open" data-act="more" data-e="${openings[0].entity_id}" title="${openings.length} offen"><ha-icon icon="mdi:window-open-variant"></ha-icon></button>`);
      const media = of('media_player').filter((s) => !BAD.includes(s.state));
      if (media.length) {
        const play = media.find((s) => s.state === 'playing');
        btns.push(`<button class="q media ${play ? 'on' : ''}" data-act="more" data-e="${(play || media[0]).entity_id}" title="Medien"><ha-icon icon="${play ? 'mdi:play' : 'mdi:speaker'}"></ha-icon></button>`);
      }
      const clim = of('climate').filter((s) => !BAD.includes(s.state));
      if (clim.length) {
        const heat = clim.filter((s) => ['heating', 'cooling', 'preheating'].includes(s.attributes.hvac_action));
        btns.push(`<button class="q climate ${heat.length ? 'on' : ''}" data-act="more" data-e="${(heat[0] || clim[0]).entity_id}" title="${heat.length ? `${heat.length} heizt` : 'Thermostat'}"><ha-icon icon="${heat.length ? 'mdi:radiator' : 'mdi:radiator-off'}"></ha-icon></button>`);
      }
      const covers = of('cover').filter((s) => !BAD.includes(s.state));
      if (covers.length) {
        const open = covers.some((s) => s.state !== 'closed');
        btns.push(`<button class="q cover ${open ? 'on' : ''}" data-act="cover" data-a="${esc(a.area_id)}" data-on="${open ? 1 : 0}" title="${open ? 'Rollos schließen' : 'Rollos öffnen'}"><ha-icon icon="${open ? 'mdi:window-shutter-open' : 'mdi:window-shutter'}"></ha-icon></button>`);
      }
      const lights = of('light').filter((s) => !BAD.includes(s.state));
      if (lights.length) {
        const on = lights.filter((s) => s.state === 'on').length;
        btns.push(`<button class="q light ${on ? 'on' : ''}" data-act="light" data-a="${esc(a.area_id)}" data-on="${on ? 1 : 0}" title="${on ? `${on} an – alle ausschalten` : 'Licht einschalten'}"><ha-icon icon="${on ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline'}"></ha-icon></button>`);
      }
      return `<div class="arow ${a.area_id === sel.area_id ? 'sel' : ''}" data-k="${esc(a.area_id)}" data-area="${esc(a.area_id)}">
        <ha-icon icon="${esc(a.icon || 'mdi:texture-box')}"></ha-icon>
        <div class="an">${esc(a.name)}<small>${esc(sub)}</small></div>
        <div class="qb">${btns.join('')}</div></div>`;
    }).join('');
    if (rows !== this._listHtml) { morph(this.shadowRoot.getElementById('alist'), rows); this._listHtml = rows; }
  }

  async _areaAction(ds) {
    const hass = this._hass;
    try {
      if (ds.act === 'light') await hass.callService('light', ds.on === '1' ? 'turn_off' : 'turn_on', {}, { area_id: ds.a });
      else if (ds.act === 'cover') await hass.callService('cover', ds.on === '1' ? 'close_cover' : 'open_cover', {}, { area_id: ds.a });
      else if (ds.act === 'more') this._fire('hass-more-info', { entityId: ds.e });
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
    }
  }

  /* ---------- Kacheln für Geräte ohne Manager Card ---------- */
  _label(e, st, devName) {
    let n = e.name || st.attributes.friendly_name || e.entity_id;
    if (devName && n.startsWith(devName)) n = n.slice(devName.length).trim();
    return n || devName || e.entity_id;
  }

  _item(e, devName) {
    const st = this._hass.states[e.entity_id];
    const domain = e.entity_id.split('.')[0];
    if (!st || e.entity_category || !SHOW_DOMAINS.includes(domain)) return null;
    return { id: e.entity_id, domain, st, label: this._label(e, st, devName), main: MAIN_DOMAINS.includes(domain) };
  }

  _genericDevice(devId) {
    const hass = this._hass;
    const reg = hass.devices[devId];
    const ents = this._devEnts[devId] || [];
    const name = (reg.name_by_user || reg.name || devId).trim();
    const items = ents.map((e) => this._item(e, name)).filter(Boolean);
    if (!items.length) return null;
    items.sort((a, b) => (b.main - a.main) || a.label.localeCompare(b.label, 'de'));
    const states = ents.map((e) => hass.states[e.entity_id]).filter(Boolean);
    const online = states.some((s) => s.state !== 'unavailable');
    const main = items.find((x) => x.main) || items[0];
    const on = items.some((x) => x.main && ['on', 'open', 'playing', 'heat', 'cleaning'].includes(x.st.state));
    return {
      id: devId, name, online, on, items,
      sub: [reg.manufacturer, reg.model].filter(Boolean).join(' · '),
      icon: main.st.attributes.icon || DOMAIN_ICON[main.domain] || 'mdi:devices',
    };
  }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    const u = st.attributes.unit_of_measurement;
    return esc(u ? `${st.state} ${u}` : st.state);
  }

  _rowHtml(x) {
    const st = x.st;
    const dis = BAD.includes(st.state);
    let right;
    if (TOGGLE_DOMAINS.includes(x.domain) || (x.domain === 'switch')) {
      const on = st.state === 'on';
      const b = x.domain === 'light' && on && st.attributes.brightness != null ? `<span class="val">${Math.round(st.attributes.brightness / 2.55)} %</span> ` : '';
      right = `<span style="display:flex;align-items:center;gap:8px">${b}<button class="tog ${on ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${dis ? 'disabled' : ''}></button></span>`;
    } else if (x.domain === 'cover') {
      const pos = st.attributes.current_position;
      right = `<span class="cover">${pos != null ? `<span class="val" style="align-self:center;margin-right:4px">${pos} %</span>` : ''}
        <button class="iconbtn" data-act="cover_open" data-e="${x.id}" title="Öffnen"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
        <button class="iconbtn" data-act="cover_stop" data-e="${x.id}" title="Stopp"><ha-icon icon="mdi:stop"></ha-icon></button>
        <button class="iconbtn" data-act="cover_close" data-e="${x.id}" title="Schließen"><ha-icon icon="mdi:arrow-down"></ha-icon></button></span>`;
    } else if (x.domain === 'climate') {
      const cur = st.attributes.current_temperature; const tgt = st.attributes.temperature;
      right = `<span class="val">${cur != null ? `${Number(cur).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C` : ''}${tgt != null ? ` → ${Number(tgt).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C` : ''} · ${this._val(st)}</span>`;
    } else if (x.domain === 'lock') {
      const locked = st.state === 'locked';
      right = `<span style="display:flex;align-items:center;gap:6px"><span class="val">${this._val(st)}</span><button class="iconbtn" data-act="${locked ? 'unlock' : 'lock'}" data-e="${x.id}" title="${locked ? 'Aufschließen' : 'Abschließen'}"><ha-icon icon="${locked ? 'mdi:lock-open-variant' : 'mdi:lock'}"></ha-icon></button></span>`;
    } else {
      right = `<span class="val">${this._val(st)}</span>`;
    }
    return `<div class="row" data-more="${x.id}"><span class="lbl">${esc(x.label)}</span>${right}</div>`;
  }

  /** Zeile in „Sonstiges“ mit eigenem Ausblenden-Knopf */
  _looseRow(x) {
    const html = this._rowHtml(x);
    const btn = `<button class="iconbtn rhide" data-act="hideent" data-e="${esc(x.id)}" title="${x.hid ? 'Wieder einblenden' : 'Im Dashboard ausblenden'}"><ha-icon icon="${x.hid ? 'mdi:eye-outline' : 'mdi:eye-off-outline'}"></ha-icon></button>`;
    return html.replace(/^<div class="row"/, `<div class="row${x.hid ? ' hidrow' : ''}"`).replace(/<\/div>$/, `${btn}</div>`);
  }

  _patchOther(list) {
    const grid = this.shadowRoot.getElementById('ogrid');
    this._ocards = this._ocards || {};
    const MAX = 6;
    const wanted = list.map((d) => {
      let c = this._ocards[d.id];
      if (!c) {
        const el = document.createElement('div');
        el.innerHTML = `<div class="head"><div class="ico"><ha-icon></ha-icon><span class="dot"></span></div><div class="name"></div>
          ${d.id.startsWith('loose:') ? `<button class="iconbtn hidebtn" data-act="hideloose" data-d="${esc(d.id)}"><ha-icon></ha-icon></button>` : `<button class="iconbtn hidebtn" data-act="hide" data-d="${esc(d.id)}"><ha-icon></ha-icon></button><button class="iconbtn" data-act="device" data-d="${esc(d.id)}" title="Gerät öffnen"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>`}</div>
          <div class="rows"></div>`;
        c = this._ocards[d.id] = { el, ico: el.querySelector('.ico'), icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'), rows: el.querySelector('.rows'), hb: el.querySelector('.hidebtn'), last: {} };
      }
      const hid = d.loose ? d.allHidden : HIDE.ids.has(d.id);
      if (d.loose) this._looseItems = { ...(this._looseItems || {}), [d.id]: d.items };
      if (c.hb) {
        const hi = hid ? 'mdi:eye-outline' : 'mdi:eye-off-outline';
        if (c.hb.firstElementChild.getAttribute('icon') !== hi) c.hb.firstElementChild.setAttribute('icon', hi);
        c.hb.title = d.loose ? (hid ? 'Alle wieder einblenden' : 'Alle im Dashboard ausblenden') : (hid ? 'Wieder einblenden' : 'Im Dashboard ausblenden');
      }
      const cls = `dev${d.online ? '' : ' offline'}${hid ? ' hidden-dev' : ''}`;
      if (c.el.className !== cls) c.el.className = cls;
      c.ico.classList.toggle('on', d.on);
      if (c.icon.getAttribute('icon') !== d.icon) c.icon.setAttribute('icon', d.icon);
      const name = `${esc(d.name)}<small>${esc(d.sub || '')}</small>`;
      const expanded = this._expanded && this._expanded.has(d.id);
      const shown = expanded ? d.items : d.items.slice(0, MAX);
      let rows = shown.map((x) => (x.loose ? this._looseRow(x) : this._rowHtml(x))).join('');
      if (d.items.length > MAX) rows += `<div class="row more" data-act="expand" data-d="${esc(d.id)}">${expanded ? 'weniger anzeigen' : `${d.items.length - MAX} weitere anzeigen`}</div>`;
      if (c.last.name !== name) { morph(c.name, name); c.last.name = name; }
      if (c.last.rows !== rows) { morph(c.rows, rows); c.last.rows = rows; }
      return c.el;
    });
    const keep = new Set(wanted);
    for (const el of [...grid.children]) if (!keep.has(el)) el.remove();
    wanted.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
    if (btn && btn.dataset.act === 'cams') {
      e.stopPropagation();
      // Startseite zeigt alle Kameras im Popup; ohne Startseite das Dialogfenster der ersten Kamera
      const detail = { ids: btn.dataset.ids.split(','), title: btn.dataset.n, handled: false };
      this.dispatchEvent(new CustomEvent('hmc-cameras', { detail, bubbles: true, composed: true }));
      if (!detail.handled) this._fire('hass-more-info', { entityId: detail.ids[0] });
      return;
    }
    if (btn) {
      e.stopPropagation();
      if (btn.disabled) return;
      this._action(btn.dataset);
      return;
    }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  async _action(ds) {
    const hass = this._hass;
    const domain = (ds.e || '').split('.')[0];
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain === 'switch' || domain === 'light' || domain === 'fan' || domain === 'input_boolean' || domain === 'humidifier' ? domain : 'homeassistant', 'toggle', { entity_id: ds.e }); break;
        case 'cover_open': await hass.callService('cover', 'open_cover', { entity_id: ds.e }); break;
        case 'cover_stop': await hass.callService('cover', 'stop_cover', { entity_id: ds.e }); break;
        case 'cover_close': await hass.callService('cover', 'close_cover', { entity_id: ds.e }); break;
        case 'lock': await hass.callService('lock', 'lock', { entity_id: ds.e }); break;
        case 'unlock':
          if (window.confirm('Wirklich aufschließen?')) await hass.callService('lock', 'unlock', { entity_id: ds.e });
          break;
        case 'hide':
          await HIDE.set(hass, ds.d, !HIDE.ids.has(ds.d));
          break;
        case 'hideent':
          await HIDE.setEntities(hass, [ds.e], !HIDE.ents.has(ds.e));
          break;
        case 'hideloose': {
          const items = (this._looseItems || {})[ds.d] || [];
          const hide = !items.every((x) => x.hid);
          await HIDE.setEntities(hass, items.filter((x) => x.hid !== hide).map((x) => x.id), hide);
          break;
        }
        case 'showhidden':
          this._showHidden = !this._showHidden;
          this._render(true);
          break;
        case 'expand':
          this._expanded = this._expanded || new Set();
          if (this._expanded.has(ds.d)) this._expanded.delete(ds.d); else this._expanded.add(ds.d);
          this._render(false);
          break;
        case 'device':
          history.pushState(null, '', `/config/devices/device/${ds.d}`);
          window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
          break;
        default: break;
      }
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
    }
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get('area-overview-card')) {
  customElements.define('area-overview-card', AreaOverviewCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'area-overview-card', name: 'Bereichsübersicht', description: 'Geräte je Bereich, mit den Manager Cards je Hersteller' });
  console.info(`%c AREA-OVERVIEW-CARD %c ${VERSION} `, 'background:#03a9f4;color:#fff', 'background:#eee;color:#333');
}


/* =====================================================================================
 * Home Summary Card – Zusammenfassungen wie in der Home-Assistant-Übersicht.
 * Kacheln mit Anzahl (Lichter an, Fenster/Türen offen, Thermostate heizen, Rollos offen,
 * Medien, Batterien niedrig, Updates, Geräte nicht erreichbar). Klick öffnet die Liste.
 * ===================================================================================== */
const SUMMARY = [
  { key: 'lights', icon: 'mdi:lamps', color: 'var(--amber-color, #ffc107)', always: true,
    text: (n) => (n ? `${n} ${n === 1 ? 'Licht' : 'Lichter'} an` : 'Alle Lichter aus') },
  { key: 'open', icon: 'mdi:window-open-variant', icon0: 'mdi:window-closed-variant', color: 'var(--blue-color, #2196f3)', always: true,
    text: (n) => (n ? `${n} Fenster/Türen offen` : 'Alles geschlossen') },
  { key: 'heat', icon: 'mdi:radiator', icon0: 'mdi:radiator-off', color: 'var(--deep-orange-color, #ff6f22)', always: true,
    text: (n) => (n ? `${n} Thermostat${n === 1 ? '' : 'e'} heiz${n === 1 ? 't' : 'en'}` : 'Keine Heizung aktiv') },
  { key: 'covers', icon: 'mdi:window-shutter-open', color: 'var(--purple-color, #9c27b0)', text: (n) => `${n} Rollo${n === 1 ? '' : 's'} offen` },
  { key: 'media', icon: 'mdi:play-circle', color: 'var(--blue-color, #2196f3)', text: (n) => `${n} Wiedergabe${n === 1 ? '' : 'n'}` },
  { key: 'battery', icon: 'mdi:battery-alert-variant-outline', color: 'var(--error-color, #db4437)', text: (n) => `${n} Batterie${n === 1 ? '' : 'n'} niedrig` },
  { key: 'updates', icon: 'mdi:package-up', color: 'var(--warning-color, #ffa600)', text: (n) => `${n} Update${n === 1 ? '' : 's'}` },
  { key: 'offline', icon: 'mdi:lan-disconnect', color: 'var(--error-color, #db4437)', text: (n) => `${n} nicht erreichbar` },
];

class HomeSummaryCard extends HTMLElement {
  setConfig(config) {
    this._config = { battery_low: 20, ...config };
    if (!this.shadowRoot) this._build();
  }

  getCardSize() { return 4; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return {}; }

  set hass(hass) {
    this._hass = hass;
    this._data = this._collect();
    const html = this._tiles();
    if (html !== this._html) { this._grid.innerHTML = html; this._html = html; }
    if (this._open) this._renderDlg();
  }

  disconnectedCallback() { if (this._dlgHost) this._close(); }

  _areaName(e) {
    const hass = this._hass;
    const id = e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id);
    return (id && hass.areas?.[id]?.name) || '';
  }

  _collect() {
    const hass = this._hass;
    const out = Object.fromEntries(SUMMARY.map((s) => [s.key, []]));
    const low = Number(this._config.battery_low);
    const devStates = {};
    for (const e of Object.values(hass.entities || {})) {
      const st = hass.states[e.entity_id];
      if (!st || e.hidden) continue;
      const dom = e.entity_id.split('.')[0];
      const dc = st.attributes.device_class;
      if (e.device_id && !e.entity_category) (devStates[e.device_id] ||= []).push(st);
      const item = { id: e.entity_id, st, e };
      if (dom === 'update') { if (st.state === 'on') out.updates.push(item); continue; }
      if (dc === 'battery') {
        const v = parseFloat(st.state);
        if ((dom === 'sensor' && !Number.isNaN(v) && v <= low) || (dom === 'binary_sensor' && st.state === 'on')) out.battery.push(item);
        continue;
      }
      if (e.entity_category) continue;
      if (dom === 'light' && st.state === 'on') out.lights.push(item);
      else if (dom === 'binary_sensor' && ['door', 'window', 'garage_door', 'opening'].includes(dc) && st.state === 'on') out.open.push(item);
      else if (dom === 'climate' && ['heating', 'preheating', 'cooling'].includes(st.attributes.hvac_action)) out.heat.push(item);
      else if (dom === 'cover' && ['open', 'opening'].includes(st.state)) out.covers.push(item);
      else if (dom === 'media_player' && st.state === 'playing') out.media.push(item);
    }
    for (const [devId, sts] of Object.entries(devStates)) {
      const d = hass.devices[devId];
      if (!d || d.disabled_by || d.entry_type === 'service') continue;
      if (sts.length && sts.every((s) => s.state === 'unavailable')) out.offline.push({ dev: d, devId });
    }
    return out;
  }

  _tiles() {
    const links = (this._config.links || []).map((l, i) => `<button class="t on link" data-link="${i}" style="--c:${esc(l.color || 'var(--primary-color)')}">
        <ha-icon icon="${esc(l.icon || 'mdi:open-in-app')}"></ha-icon><span>${esc(l.name || l.path)}</span></button>`).join('');
    return SUMMARY.filter((s) => s.always || this._data[s.key].length).map((s) => {
      const n = this._data[s.key].length;
      return `<button class="t ${n ? 'on' : ''}" data-k="${s.key}" style="--c:${s.color}">
        <ha-icon icon="${n || !s.icon0 ? s.icon : s.icon0}"></ha-icon><span>${esc(s.text(n))}</span></button>`;
    }).join('') + links;
  }

  _navigate(path) {
    if (/^https?:/.test(path)) { window.open(path, '_blank', 'noopener'); return; }
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  _build() {
    const css = `
      :host { display:block; }
      .g { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
      .t { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:14px 8px; min-height:92px;
        background: var(--ha-card-background, var(--card-background-color)); border:1px solid var(--divider-color);
        border-radius: var(--ha-card-border-radius, 12px); box-shadow: var(--ha-card-box-shadow, none); cursor:pointer;
        color: var(--primary-text-color); font: inherit; font-size:14px; font-weight:500; text-align:center; }
      .t:hover { background: var(--secondary-background-color); }
      .t ha-icon { --mdc-icon-size:30px; color: var(--secondary-text-color); }
      .t.on ha-icon { color: var(--c); }
      .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
      .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius:16px; width:min(560px, 100%);
        max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
      .dh { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
      .dh ha-icon { --mdc-icon-size:28px; color: var(--c); }
      .dh .tt { font-size:20px; font-weight:600; flex:1; }
      .db { overflow:auto; padding: 0 20px 16px; }
      .kv { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:8px 0; font-size:14px; border-bottom:1px solid var(--divider-color); cursor:pointer; }
      .kv:last-child { border-bottom:none; }
      .kv small { display:block; color: var(--secondary-text-color); font-size:12px; }
      .kv .v { white-space:nowrap; font-variant-numeric: tabular-nums; }
      .none { color: var(--secondary-text-color); padding:12px 0; }
      .ib { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
      .ib:hover { background: var(--secondary-background-color); }
      .df { display:flex; justify-content:flex-end; gap:8px; padding: 8px 16px 16px; }
      .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      .btn.sec { background: var(--secondary-background-color); color: var(--primary-text-color); }`;
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><div class="g" id="g"></div>`;
    this._grid = this.shadowRoot.getElementById('g');
    this._grid.addEventListener('click', (e) => {
      const path = e.composedPath();
      const l = path.find((el) => el.dataset && el.dataset.link);
      if (l) { const link = (this._config.links || [])[Number(l.dataset.link)]; if (link && link.path) this._navigate(link.path); return; }
      const t = path.find((el) => el.dataset && el.dataset.k);
      if (t) this._openDlg(t.dataset.k);
    });
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><div id="d"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('d');
    this._dlg.addEventListener('click', (e) => this._dlgClick(e));
  }

  _openDlg(key) {
    this._open = key;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._renderDlg();
  }

  _close() { this._open = null; this._dlgHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _val(st) {
    if (typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st);
    const u = st.attributes.unit_of_measurement;
    return u ? `${st.state} ${u}` : st.state;
  }

  _renderDlg() {
    const s = SUMMARY.find((x) => x.key === this._open);
    if (!s) return;
    const list = this._data[s.key];
    const hass = this._hass;
    let body;
    if (s.key === 'offline') {
      body = list.map((x) => `<div class="kv" data-dev="${esc(x.devId)}"><span>${esc(x.dev.name_by_user || x.dev.name)}
        <small>${esc([hass.areas?.[x.dev.area_id]?.name, x.dev.manufacturer, x.dev.model].filter(Boolean).join(' · '))}</small></span>
        <span class="v">nicht erreichbar</span></div>`).join('');
    } else {
      const rows = list.map((x) => ({ x, name: x.e.name || x.st.attributes.friendly_name || x.id, area: this._areaName(x.e) }))
        .sort((a, b) => a.area.localeCompare(b.area, 'de') || a.name.localeCompare(b.name, 'de'));
      body = rows.map(({ x, name, area }) => {
        let v = this._val(x.st);
        if (s.key === 'heat') {
          const c = x.st.attributes.current_temperature; const t = x.st.attributes.temperature;
          v = `${c != null ? `${Number(c).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C` : ''}${t != null ? ` → ${Number(t).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C` : ''}`;
        }
        if (s.key === 'updates') v = `${x.st.attributes.installed_version || ''} → ${x.st.attributes.latest_version || ''}`;
        return `<div class="kv" data-more="${x.id}"><span>${esc(name)}<small>${esc(area || 'kein Bereich')}</small></span><span class="v">${esc(v)}</span></div>`;
      }).join('');
    }
    const extra = s.key === 'lights' && list.length
      ? '<button class="btn sec" data-act="lights_off">Alle ausschalten</button>' : '';
    const html = `<div class="dlg-bg"><div class="dlg" style="--c:${s.color}" role="dialog">
      <div class="dh"><ha-icon icon="${s.icon}"></ha-icon><span class="tt">${esc(s.text(list.length))}</span>
        <button class="ib" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="db">${body || '<div class="none">Nichts zu melden.</div>'}</div>
      <div class="df">${extra}<button class="btn" data-act="close">Schließen</button></div></div></div>`;
    if (html !== this._dlgHtml) { this._dlg.innerHTML = html; this._dlgHtml = html; }
  }

  async _dlgClick(e) {
    if (e.target.classList?.contains('dlg-bg')) { this._close(); return; }
    const path = e.composedPath();
    const act = path.find((el) => el.dataset && el.dataset.act);
    if (act) {
      if (act.dataset.act === 'close') this._close();
      if (act.dataset.act === 'lights_off') {
        const ids = this._data.lights.map((x) => x.id);
        if (ids.length && window.confirm(`${ids.length} Lichter ausschalten?`)) await this._hass.callService('light', 'turn_off', { entity_id: ids });
      }
      return;
    }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) { this._close(); this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: more.dataset.more }, bubbles: true, composed: true })); return; }
    const dev = path.find((el) => el.dataset && el.dataset.dev);
    if (dev) {
      this._close();
      history.pushState(null, '', `/config/devices/device/${dev.dataset.dev}`);
      window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
    }
  }
}

if (!customElements.get('home-summary-card')) {
  customElements.define('home-summary-card', HomeSummaryCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'home-summary-card', name: 'Zusammenfassungen', description: 'Lichter, Fenster, Heizung, Batterien, Updates … auf einen Blick' });
}
