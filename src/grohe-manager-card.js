/*
 * Grohe Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota-, ESPHome-, X-Sense- und Proxmox Manager Card).
 * Liest alle Geräte der Grohe-Smarthome-Integration live aus der Geräte-/Entitäts-Registry,
 * neue Geräte (Sense, Sense Guard, Blue …) erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:grohe-manager-card
 *   integration: grohe_smarthome   # Plattform der Entitäten
 *   min_width: 300                 # Mindestbreite einer Gerätekarte in px
 *   low_battery: 20                # Batterie-Warnschwelle in %
 *   icon_base: /local/images/grohe # Ordner mit den Gerätebildern (= /config/www/images/grohe, aus dem ioBroker-Adapter grohe-smarthome)
 *   icon_map: { "Sense Guard": "senseguard" }   # optionale Zuordnung Modell -> Bilddatei
 */
const VERSION = '1.2.1';
const BAD = ['unavailable', 'unknown'];
const NO_NOTIF = /^(no actual notification|keine.*benachrichtigung|none|unknown|unavailable|)$/i;
const DAYS = [
  ['monday', 'montag'], ['tuesday', 'dienstag'], ['wednesday', 'mittwoch'], ['thursday', 'donnerstag'],
  ['friday', 'freitag'], ['saturday', 'samstag'], ['sunday', 'sonntag'],
];
const DAY_DE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
// Gerätebilder aus dem ioBroker-Adapter grohe-smarthome (admin/), abgelegt unter /config/www/images/grohe
const IMG = { guard: 'grohe-sense-guard.png', sense: 'grohe-sense.png', blue: 'grohe-blue.png' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (v, dec = 1) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: dec });

class GroheManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'grohe_smarthome', min_width: 300, low_battery: 20, icon_base: '/local/images/grohe', icon_map: {}, ...config };
    this._filter = this._filter || '';
    this._sort = this._sort || 'name';
    this._view = this._view || 'all';
    this._sig = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'grohe_smarthome' }; }

  set hass(hass) {
    this._hass = hass;
    const devices = this._collect();
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig, window.__hmcAct ? window.__hmcAct(this._hass, d.id) : '']));
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  connectedCallback() {
    // relative Zeitangaben ("vor 5 Min.") laufen auch ohne Zustandsänderung weiter
    clearInterval(this._tick);
    this._tick = setInterval(() => this._renderGrid(), 60000);
  }

  disconnectedCallback() { if (this._dlgHost) this._closeInfo(); clearInterval(this._tick); }

  /* ---------- Datensammlung ---------- */
  _collect() {
    const hass = this._hass;
    if (!hass || !hass.entities || !hass.devices) return [];
    const platform = this._config.integration;
    const byDevice = {};
    for (const ent of Object.values(hass.entities)) {
      if (ent.platform !== platform || !ent.device_id || ent.hidden) continue;
      (byDevice[ent.device_id] ||= []).push(ent);
    }
    const out = [];
    for (const [devId, ents] of Object.entries(byDevice)) {
      const reg = hass.devices[devId];
      if (!reg || reg.disabled_by) continue;
      const d = {
        id: devId,
        name: (reg.name_by_user || reg.name || devId).trim(),
        model: reg.model || '',
        sw: reg.sw_version || '',
        area: reg.area_id && hass.areas?.[reg.area_id]?.name || '',
        onlineEnt: null, update: null, temp: null, hum: null, battery: null, lastMeas: null,
        notif: null, notifList: null, snoozeStatus: null, snoozeUntil: null, wifi: null, pressure: null,
        flow: null, maxFlow: null, today: null, total: null, avgDay: null, avgMonth: null, lastCons: null,
        valve: null, limit: null, sprStart: null, sprStop: null, sprDays: [],
        warnings: [], online: true, sig: '', reg, all: [],
      };
      let unavailable = 0, total = 0;
      for (const ent of ents) {
        const st = hass.states[ent.entity_id];
        if (!st) continue;
        total++;
        if (st.state === 'unavailable') unavailable++;
        const id = ent.entity_id;
        const domain = id.split('.')[0];
        const dc = st.attributes.device_class;
        const label = this._label(ent, st, d.name);
        // Zuordnung über Entitätsname/Übersetzungsschlüssel (deutsch und englisch), nicht über die Entitäts-ID
        const key = `${slug(label)} ${slug(ent.translation_key)} ${slug(ent.original_name)}`;
        const item = { id, label, st, ent };
        d.all.push(item);
        switch (domain) {
          case 'binary_sensor':
            if (/online|verbunden|connect/.test(key)) d.onlineEnt = item;
            else if (/update/.test(key)) d.update = item;
            break;
          case 'sensor':
            if (dc === 'battery' || /batter/.test(key)) d.battery = item;
            else if (dc === 'humidity' || /humid|feuchte/.test(key)) d.hum = item;
            else if (dc === 'temperature' || /temperat/.test(key)) d.temp = item;
            else if (dc === 'pressure' || /pressure|druck/.test(key)) d.pressure = item;
            else if (/measurement.?update|letzte.?messung/.test(key)) d.lastMeas = item;
            else if (/notification|benachricht/.test(key)) d.notif = item;
            else if (/snooz.*status|pausiert.*status/.test(key)) d.snoozeStatus = item;
            else if (/snooz.*until|pausiert.*bis/.test(key)) d.snoozeUntil = item;
            else if (/wifi|wlan|signal/.test(key)) d.wifi = item;
            else if (/max.?flow|max.*durchfluss/.test(key)) d.maxFlow = item;
            else if (dc === 'volume_flow_rate' || /flow|durchfluss/.test(key)) d.flow = item;
            else if (/average.?daily|tag.*durchschn|durchschn.*tag/.test(key)) d.avgDay = item;
            else if (/average.?month|monat/.test(key)) d.avgMonth = item;
            else if (/latest.?consum|letzte.?(entnahme|verbrauch)/.test(key)) d.lastCons = item;
            else if (/total|gesamt/.test(key)) d.total = item;
            else if (dc === 'water' || /consum|verbrauch/.test(key)) d.today = item;
            break;
          case 'valve': d.valve = item; break;
          case 'number': if (/limit|withdrawal|entnahme/.test(key)) d.limit = item; break;
          case 'time':
            if (/start/.test(key)) d.sprStart = item;
            else if (/stop|end/.test(key)) d.sprStop = item;
            break;
          case 'switch': {
            const day = DAYS.findIndex(([en, de]) => key.includes(en) || key.includes(de));
            if (day >= 0) { item.label = `Bewässerung ${DAY_DE[day]}`; item.day = day; d.sprDays[day] = item; }
            break;
          }
          case 'todo': d.notifList = item; break;
          default: break;
        }
      }
      d.online = total > 0 && unavailable < total && !(d.onlineEnt && d.onlineEnt.st.state !== 'on');
      const bat = this._num(d.battery);
      if (d.valve?.st.state === 'closed') d.warnings.push({ item: d.valve, text: 'Ventil geschlossen', cls: 'err', icon: 'mdi:valve-closed' });
      if (bat != null && bat < Number(this._config.low_battery)) {
        d.warnings.push({ item: d.battery, text: `Batterie ${bat} %`, cls: 'warn', icon: 'mdi:battery-alert-variant-outline' });
      }
      if (d.notif && !NO_NOTIF.test(d.notif.st.state.trim())) {
        d.warnings.push({ item: d.notif, text: d.notif.st.state, cls: 'warn', icon: 'mdi:bell-alert-outline' });
      }
      const open = Number(d.notifList?.st.state);
      if (open > 0) d.warnings.push({ item: d.notifList, text: `${open} offene Meldung${open > 1 ? 'en' : ''}`, cls: 'warn', icon: 'mdi:format-list-checks' });
      d.sig = d.all.map((x) => x.st.state).join('|') + d.online;
      out.push(d);
    }
    return out;
  }

  _label(ent, st, devName) {
    let n = ent.name || st.attributes.friendly_name || ent.entity_id;
    if (n.startsWith(devName)) n = n.slice(devName.length).trim();
    return n || devName;
  }

  _num(item) {
    if (!item || BAD.includes(item.st.state)) return null;
    const v = parseFloat(item.st.state);
    return Number.isNaN(v) ? null : v;
  }

  /** Zustand als Klartext (übersetzt, mit Einheit) – noch nicht HTML-maskiert */
  _plain(st) {
    if (!st || BAD.includes(st.state)) return '–';
    if (typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st);
    const unit = st.attributes.unit_of_measurement;
    return unit ? `${st.state} ${unit}` : st.state;
  }

  _val(st) { return esc(this._plain(st)); }

  /** Durchfluss immer in l/min (Integration liefert teils m³/h) */
  _flow(item) {
    const v = this._num(item);
    if (v == null) return '–';
    const unit = item.st.attributes.unit_of_measurement || '';
    const lmin = /m³\/h|m3\/h/i.test(unit) ? (v * 1000) / 60 : /l\/h/i.test(unit) ? v / 60 : v;
    return `${fmt(lmin, 1)} l/min`;
  }

  _liters(item) { const v = this._num(item); return v == null ? '–' : `${fmt(v, 1)} l`; }

  _ago(st) {
    if (!st || !st.state || BAD.includes(st.state)) return '';
    const ms = Date.now() - new Date(st.state).getTime();
    if (Number.isNaN(ms)) return '';
    if (ms < 60000) return 'gerade eben';
    const min = Math.floor(ms / 60000);
    if (min < 60) return `vor ${min} Min.`;
    const h = Math.floor(min / 60);
    if (h < 24) return `vor ${h} Std.`;
    const days = Math.floor(h / 24);
    return `vor ${days} Tag${days > 1 ? 'en' : ''}`;
  }

  _dateTitle(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleString('de-DE');
  }

  _batIcon(v) {
    if (v == null) return 'mdi:battery-unknown';
    if (v >= 95) return 'mdi:battery';
    if (v < 5) return 'mdi:battery-outline';
    return `mdi:battery-${Math.min(90, Math.max(10, Math.round(v / 10) * 10))}`;
  }

  _signalHtml(d) {
    if (!d.wifi) return '–';
    const v = this._num(d.wifi);
    const icon = v == null ? 'mdi:wifi-strength-off-outline' : `mdi:wifi-strength-${Math.max(1, Math.min(4, Math.round(v) + 1))}`;
    return `<ha-icon icon="${icon}"></ha-icon>${v == null ? '–' : `${fmt(v, 0)} / 3`}`;
  }

  _deviceIcon(d) {
    if (d.valve) return d.valve.st.state === 'closed' ? 'mdi:valve-closed' : 'mdi:valve-open';
    if (/blue/i.test(d.model)) return 'mdi:water-pump';
    return 'mdi:water-alert-outline';
  }

  _iconSrc(d) {
    const base = String(this._config.icon_base || '').replace(/\/$/, '');
    const name = this._config.icon_map[d.model];
    if (name) return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${base}/${name}.png`;
    const key = d.valve || /guard/i.test(d.model) ? 'guard' : /blue/i.test(d.model) ? 'blue' : /sense/i.test(d.model) ? 'sense' : '';
    return key && base ? `${base}/${IMG[key]}` : '';
  }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; padding:12px; box-sizing:border-box; }
        .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px;
          background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px); margin-bottom:12px; }
        .toolbar .title { font-size:20px; font-weight:500; margin-right:auto; display:flex; align-items:center; gap:8px; }
        .toolbar input, .toolbar select { background: rgba(255,255,255,.12); color: inherit; border: 1px solid rgba(255,255,255,.3);
          border-radius: 8px; padding: 6px 10px; font: inherit; font-size:14px; }
        .toolbar select option { color: var(--primary-text-color); background: var(--card-background-color); }
        .toolbar input::placeholder { color: rgba(255,255,255,.7); }
        .stats { font-size:13px; opacity:.9; width:100%; display:flex; gap:16px; flex-wrap:wrap; }
        .stats .al { font-weight:700; }
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--gmc-min, 300px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .dev.alarm { opacity:1; border-color: var(--error-color, #db4437); box-shadow: 0 0 0 2px var(--error-color, #db4437); }
        .dev.alarm .ico ha-icon { color: var(--error-color, #db4437); }
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .ico img { width:30px; height:30px; object-fit:contain; border-radius:6px; }
        .ico img + ha-icon { display:none; }
        .ico img.fail { display:none; }
        .ico img.fail + ha-icon { display:block; }
        .dot { position:absolute; right:-3px; bottom:-3px; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:15px; font-weight:600; line-height:1.2; flex:1; min-width:0; }
        .name small { display:block; font-size:11px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .iconbtn[disabled] { opacity:.35; cursor:default; }
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:12px; row-gap:1px; font-size:12px; }
        .meta .k { color: var(--secondary-text-color); }
        .meta .v { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .meta ha-icon { --mdc-icon-size:14px; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; cursor:pointer; max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
        .chip ha-icon { --mdc-icon-size:14px; flex:none; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
        .chip.info { background: rgba(3,169,244,.15); color: var(--info-color, #039be5); }
        .rows { padding: 0 10px 6px; flex:1; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:13px;
          border-top: 1px solid var(--divider-color); cursor:pointer; }
        .row:first-child { border-top:none; }
        .row .lbl { color: var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; display:flex; align-items:center; gap:4px; }
        .row .val ha-icon { --mdc-icon-size:18px; }
        .row .val.err { color: var(--error-color, #db4437); font-weight:600; }
        .row .val.warn { color: var(--warning-color, #ffa600); }
        .row .val.ok { color: var(--success-color, #43a047); }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .foot { display:flex; align-items:center; gap:4px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); min-height:34px; }
        .foot .sp { flex:1; }
        .fbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:5px 8px; border-radius:8px;
          font: inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
        .fbtn ha-icon { --mdc-icon-size:18px; }
        .fbtn:hover { background: var(--divider-color); color: var(--primary-text-color); }
        .fbtn[disabled] { opacity:.35; cursor:default; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
        .dlg-h ha-icon { --mdc-icon-size:32px; color: var(--primary-color); }
        .dlg-h img { width:36px; height:36px; object-fit:contain; border-radius:6px; }
        .dlg-h img + ha-icon { display:none; }
        .dlg-h img.fail { display:none; }
        .dlg-h img.fail + ha-icon { display:inline-block; }
        .dlg-b { overflow:auto; padding: 0 20px 16px; }
        .dlg-b h4 { margin: 14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
        .kv { display:flex; justify-content:space-between; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv:last-child { border-bottom:none; }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:water-check-outline"></ha-icon>Grohe Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="model">Modell</option>
          <option value="battery">Batterie</option>
          <option value="signal">Signal</option>
        </select>
        <div class="stats" id="stats"></div>
      </div>
      <div class="grid" id="grid"></div>`;
    // Dialog außerhalb der Karte (an body), damit position:fixed nicht vom Dashboard-Layout eingeschränkt wird
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${this.shadowRoot.querySelector('style').textContent}</style><div id="dlg"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('dlg');
    const root = this.shadowRoot;
    root.getElementById('q').addEventListener('input', (e) => { this._filter = e.target.value.toLowerCase(); this._renderGrid(); });
    root.getElementById('view').addEventListener('change', (e) => { this._view = e.target.value; this._renderGrid(); });
    root.getElementById('sort').addEventListener('change', (e) => { this._sort = e.target.value; this._renderGrid(); });
    root.getElementById('grid').addEventListener('click', (e) => this._onClick(e));
    this._dlg.addEventListener('click', (e) => {
      if (e.target.classList?.contains('dlg-bg')) { this._closeInfo(); return; }
      const path = e.composedPath();
      if (!path.some((el) => el.dataset && el.dataset.act)) {
        const more = path.find((el) => el.dataset && el.dataset.more);
        if (more) { this._closeInfo(); this._fire('hass-more-info', { entityId: more.dataset.more }); return; }
      }
      this._onClick(e);
    });
    // Gerätebild wird direkt angezeigt; nur wenn es nicht geladen werden kann, erscheint das MDI-Icon
    this._failed = new Set();
    const onError = (e) => {
      if (e.target.tagName !== 'IMG') return;
      e.target.classList.add('fail');
      const src = e.target.getAttribute('src');
      if (src) this._failed.add(src);
    };
    root.getElementById('grid').addEventListener('error', onError, true);
    this._dlg.addEventListener('error', onError, true);
  }

  _openInfo(id) {
    this._infoId = id;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._renderInfo();
  }

  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _renderInfo() {
    const host = this._dlg;
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { host.innerHTML = ''; return; }
    const r = d.reg || {};
    const ident = (r.identifiers || []).map((i) => i[1]).join(', ');
    const info = [
      ['Hersteller', r.manufacturer], ['Modell', d.model], ['Firmware', r.sw_version],
      ['Seriennummer', r.serial_number], ['Geräte-ID', ident], ['Raum', d.area],
      ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const cat = { state: [], meas: [], conf: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (x.ent.entity_category === 'config' || ['number', 'select', 'switch', 'time'].includes(dom)) cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic' || x === d.wifi || x === d.onlineEnt || x === d.update) cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const sortConf = (a, b) => ((a.day ?? -1) - (b.day ?? -1)) || sortL(a, b);
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      const right = dom === 'switch'
        ? `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}></button>`
        : `<span class="v">${x === d.flow ? this._flow(x) : this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list, sort = sortL) => (list.length ? `<h4>${title}</h4>${list.sort(sort).map(ent).join('')}` : '');
    const src = this._iconSrc(d);
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h">${src ? `<img src="${esc(src)}" alt="" class="${this._failed?.has(src) ? 'fail' : ''}">` : ''}<ha-icon icon="${this._deviceIcon(d)}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${sec('Zustände', cat.state)}${sec('Messwerte', cat.meas)}${sec('Konfiguration', cat.conf, sortConf)}${sec('Diagnose', cat.diag)}
        </div>
        <div class="dlg-f"><button class="btn" data-act="close">Schließen</button></div>
      </div></div>`;
    if (html === this._infoHtml && host.firstElementChild) return;
    const body = host.querySelector('.dlg-b');
    const scroll = body ? body.scrollTop : 0;
    host.innerHTML = html;
    this._infoHtml = html;
    const nb = host.querySelector('.dlg-b');
    if (nb) nb.scrollTop = scroll;
  }

  _renderGrid() {
    const root = this.shadowRoot;
    if (!root || !this._devices) return;
    root.host.style.setProperty('--gmc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'problem': return d.warnings.length > 0;
        default: return true;
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'de');
    const cmp = {
      name: byName,
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || byName(a, b),
      model: (a, b) => a.model.localeCompare(b.model) || byName(a, b),
      battery: (a, b) => (this._num(a.battery) ?? 999) - (this._num(b.battery) ?? 999) || byName(a, b),
      signal: (a, b) => (this._num(a.wifi) ?? -1) - (this._num(b.wifi) ?? -1) || byName(a, b),
    }[this._sort];
    // geschlossene Ventile stehen immer oben
    const closed = (d) => (d.valve?.st.state === 'closed' ? 1 : 0);
    list.sort((a, b) => (closed(b) - closed(a)) || cmp(a, b));

    const online = all.filter((d) => d.online).length;
    const nClosed = all.filter(closed).length;
    const warn = all.filter((d) => d.warnings.length).length;
    const today = all.reduce((s, d) => s + (this._num(d.today) || 0), 0);
    const bats = all.map((d) => this._num(d.battery)).filter((v) => v != null);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      ${all.some((d) => d.valve) ? (nClosed ? '<span class="al">Wasser abgesperrt</span>' : '<span>Wasser offen</span>') : ''}
      ${all.some((d) => d.today) ? `<span>heute ${fmt(today, 1)} l</span>` : ''}
      ${warn ? `<span>${warn} mit Warnung</span>` : ''}
      ${bats.length ? `<span>niedrigste Batterie ${Math.min(...bats)} %</span>` : ''}`;

    this._patchGrid(list);
  }

  /* Kacheln bleiben bestehen; nur geänderte Bereiche werden ersetzt. */
  _patchGrid(list) {
    const grid = this.shadowRoot.getElementById('grid');
    this._cards = this._cards || {};
    if (!this._emptyEl) {
      this._emptyEl = document.createElement('div');
      this._emptyEl.className = 'empty';
      this._emptyEl.textContent = 'Keine Geräte gefunden.';
    }
    const wanted = list.length ? list.map((d) => this._updateCard(d)) : [this._emptyEl];
    const keep = new Set(wanted);
    for (const el of [...grid.children]) if (!keep.has(el)) el.remove();
    wanted.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });
    const ids = new Set(this._devices.map((d) => d.id));
    for (const id of Object.keys(this._cards)) if (!ids.has(id)) delete this._cards[id];
  }

  _updateCard(d) {
    let c = this._cards[d.id];
    if (!c) {
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="head">
          <div class="ico"><img alt="" class="fail"><ha-icon></ha-icon><span class="dot"></span></div>
          <div class="name"></div>
          <button class="iconbtn" data-act="info" data-d="${d.id}" title="Geräteinformationen"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
        </div>
        <div class="meta"></div><div class="chips"></div><div class="rows"></div><div class="foot"></div>`;
      c = this._cards[d.id] = {
        el, img: el.querySelector('img'), icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'),
        meta: el.querySelector('.meta'), chips: el.querySelector('.chips'), rows: el.querySelector('.rows'),
        foot: el.querySelector('.foot'), last: {},
      };
    }
    const parts = this._deviceParts(d);
    const cls = `dev${d.online ? '' : ' offline'}${d.valve?.st.state === 'closed' ? ' alarm' : ''}${d.valve?.st.state === 'closed' ? '' : (window.__hmcAct ? window.__hmcAct(this._hass, d.id) : '')}`;
    if (c.el.className !== cls) c.el.className = cls;
    const src = this._iconSrc(d);
    if (c.last.src !== src) {
      c.img.classList.toggle('fail', !src || this._failed.has(src));
      if (src) c.img.src = src; else c.img.removeAttribute('src');
      c.last.src = src;
    }
    const mi = this._deviceIcon(d);
    if (c.icon.getAttribute('icon') !== mi) c.icon.setAttribute('icon', mi);
    for (const k of ['name', 'meta', 'chips', 'rows', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    c.chips.style.display = parts.chips ? '' : 'none';
    c.foot.style.display = parts.foot.trim() ? '' : 'none';
    return c.el;
  }

  _deviceParts(d) {
    const low = Number(this._config.low_battery);
    const row = (item, label, val, cls = '') => (item
      ? `<div class="row" data-more="${item.id}"><span class="lbl">${esc(label)}</span><span class="val ${cls}">${val}</span></div>` : '');
    const rows = [];
    if (d.valve) {
      const s = d.valve.st.state;
      rows.push(row(d.valve, 'Hauptventil', `<ha-icon icon="${s === 'closed' ? 'mdi:valve-closed' : 'mdi:valve-open'}"></ha-icon>${this._val(d.valve.st)}`,
        s === 'closed' ? 'err' : s === 'open' ? 'ok' : ''));
    }
    rows.push(row(d.temp, d.valve ? 'Wassertemperatur' : 'Temperatur', `<ha-icon icon="mdi:thermometer"></ha-icon>${this._val(d.temp?.st)}`));
    if (d.hum) {
      const h = this._num(d.hum);
      rows.push(row(d.hum, 'Luftfeuchte', `<ha-icon icon="mdi:water-percent"></ha-icon>${this._val(d.hum.st)}`, h != null && h >= 70 ? 'warn' : ''));
    }
    if (d.flow) rows.push(row(d.flow, 'Durchfluss', `<ha-icon icon="mdi:waves-arrow-right"></ha-icon>${this._flow(d.flow)}`, this._num(d.flow) > 0 ? 'ok' : ''));
    rows.push(row(d.pressure, 'Druck', `<ha-icon icon="mdi:gauge"></ha-icon>${this._val(d.pressure?.st)}`));
    if (d.today) {
      const avg = this._num(d.avgDay);
      rows.push(row(d.today, 'Verbrauch heute', `${this._liters(d.today)}${avg ? `<span style="color:var(--secondary-text-color)">· Ø ${fmt(avg, 0)} l</span>` : ''}`));
    }
    if (d.battery) {
      const v = this._num(d.battery);
      rows.push(row(d.battery, 'Batterie', `<ha-icon icon="${this._batIcon(v)}"></ha-icon>${this._val(d.battery.st)}`, v != null && v < low ? 'warn' : ''));
    }
    if (d.lastMeas) {
      rows.push(row(d.lastMeas, 'Letzte Messung', `<span title="${esc(this._dateTitle(d.lastMeas.st))}">${this._ago(d.lastMeas.st) || '–'}</span>`));
    }

    const chips = [];
    const chip = (item, cls, icon, text) => `<span class="chip ${cls}" data-more="${item.id}" title="${esc(text)}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    for (const w of d.warnings) chips.push(chip(w.item, w.cls, w.icon, w.text));
    if (d.snoozeStatus && !BAD.includes(d.snoozeStatus.st.state) && !/non.?existent|inactive|^off$/i.test(d.snoozeStatus.st.state)) {
      const until = d.snoozeUntil ? this._dateTitle(d.snoozeUntil.st) : '';
      chips.push(chip(d.snoozeStatus, 'info', 'mdi:sleep', `Pausiert${until ? ` bis ${until}` : ''}`));
    }
    if (d.update?.st.state === 'on') chips.push(chip(d.update, 'info', 'mdi:package-up', 'Update verfügbar'));
    if (d.onlineEnt) chips.push(d.onlineEnt.st.state === 'on'
      ? chip(d.onlineEnt, 'ok', 'mdi:cloud-check-outline', 'Verbunden')
      : chip(d.onlineEnt, 'err', 'mdi:cloud-off-outline', 'Nicht verbunden'));

    const btn = (act, item, icon, text, title, extra = '', disabled = false) => (item
      ? `<button class="fbtn" data-act="${act}" data-e="${item.id}" title="${esc(title)}" ${extra} ${disabled ? 'disabled' : ''}><ha-icon icon="${icon}"></ha-icon>${text}</button>`
      : '');
    const vs = d.valve?.st.state;
    const vBad = !d.valve || BAD.includes(vs);
    const open = Number(d.notifList?.st.state) || 0;
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          ${d.wifi ? `<span class="k">Signal</span><span class="v">${this._signalHtml(d)}</span>` : ''}
          <span class="k">Modell</span><span class="v">${esc(d.model || '–')}</span>
          <span class="k">Firmware</span><span class="v">${esc(d.sw || '–')}</span>`,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: `
          ${btn('more', d.notifList, open ? 'mdi:bell-badge-outline' : 'mdi:bell-outline', `Meldungen${open ? ` (${open})` : ''}`, 'Meldungen anzeigen')}
          <span class="sp"></span>
          ${btn('valve', d.valve, 'mdi:valve-open', 'Öffnen', 'Hauptventil öffnen', 'data-v="open"', vBad || vs === 'open')}
          ${btn('valve', d.valve, 'mdi:valve-closed', 'Schließen', 'Hauptventil schließen', `data-v="close" data-c="${esc(`Hauptventil von ${d.name} schließen? Die Wasserzufuhr wird unterbrochen.`)}"`, vBad || vs === 'closed')}`,
    };
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
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
    const [domain] = (ds.e || '').split('.');
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain, 'toggle', { entity_id: ds.e }); break;
        case 'valve':
          if (ds.c && !window.confirm(ds.c)) break;
          await hass.callService('valve', ds.v === 'open' ? 'open_valve' : 'close_valve', { entity_id: ds.e });
          this._fire('hass-notification', { message: 'Befehl gesendet' });
          break;
        case 'more': this._fire('hass-more-info', { entityId: ds.e }); break;
        case 'info': this._openInfo(ds.d); break;
        case 'close': this._closeInfo(); break;
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

if (!customElements.get('grohe-manager-card')) {
  customElements.define('grohe-manager-card', GroheManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'grohe-manager-card', name: 'Grohe Manager', description: 'Alle Grohe-Geräte im Stil des ioBroker Device Managers' });
  console.info(`%c GROHE-MANAGER-CARD %c ${VERSION} `, 'background:#0b5ea8;color:#fff', 'background:#eee;color:#333');
}
