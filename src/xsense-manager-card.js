/*
 * X-Sense Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota- und ESPHome Manager Card).
 * Liest alle Geräte der X-Sense-Integration live aus der Geräte-/Entitäts-Registry,
 * neue Melder erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:xsense-manager-card
 *   integration: xsense        # Plattform der Entitäten
 *   min_width: 240             # Mindestbreite einer Gerätekarte in px
 *   low_battery: 20            # Batterie-Warnschwelle in %
 *   icon_base: ''              # Ordner mit Gerätebildern, z. B. /local/images/xsense (leer = MDI-Icons)
 *   icon_map: { "XS01-M": "xs01m" }   # optionale Zuordnung Modell -> Bilddatei
 */
const VERSION = '1.1.0';
const BAD = ['unavailable', 'unknown'];
const ALARM_DC = ['smoke', 'carbon_monoxide', 'heat', 'gas', 'moisture', 'safety'];
const SIGNAL_RANK = { no_signal: 0, weak: 1, moderate: 2, good: 3 };
const SIGNAL_ICON = ['mdi:signal-off', 'mdi:signal-cellular-1', 'mdi:signal-cellular-2', 'mdi:signal-cellular-3'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

class XSenseManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'xsense', min_width: 240, low_battery: 20, icon_base: '', icon_map: {}, ...config };
    this._filter = this._filter || '';
    this._sort = this._sort || 'name';
    this._view = this._view || 'all';
    this._sig = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'xsense' }; }

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
      const via = reg.via_device_id && hass.devices[reg.via_device_id];
      const d = {
        id: devId,
        name: (reg.name_by_user || reg.name || devId).trim(),
        model: reg.model || '',
        sw: reg.sw_version || '',
        area: reg.area_id && hass.areas?.[reg.area_id]?.name || '',
        url: reg.configuration_url || '',
        hub: via ? (via.name_by_user || via.name || '') : '',
        isHub: !reg.via_device_id,
        alarms: [], status: null, battery: null, signal: null, rssi: null, report: null,
        testResult: null, testTime: null, muted: null, eol: null, drill: null, conn: null,
        ipEnt: null, mode: null, btnTest: null, btnMute: null, btnDrill: null,
        alarm: false, warnings: [], online: true, sig: '', reg, all: [],
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
        const key = `${slug(label)} ${slug(ent.translation_key)}`;
        const item = { id, label, st, ent };
        d.all.push(item);
        switch (domain) {
          case 'binary_sensor':
            if (/ubung|drill/.test(key)) d.drill = item;
            else if (/stumm|mute|silenc/.test(key)) d.muted = item;
            else if (/lebensdauer|end.?of.?life/.test(key)) d.eol = item;
            else if (/verbunden|connected|online/.test(key)) d.conn = item;
            else if (ALARM_DC.includes(dc) || /alarm/.test(key)) d.alarms.push(item);
            break;
          case 'sensor':
            if (dc === 'battery') d.battery = item;
            else if (dc === 'signal_strength') d.rssi = item;
            else if (/testergebnis|test.?result/.test(key)) d.testResult = item;
            else if (/testzeit|test.?time/.test(key)) d.testTime = item;
            else if (/meldezeit|report/.test(key)) d.report = item;
            else if (/signal/.test(key)) d.signal = item;
            else if (/geratestatus|device.?status|life.?status/.test(key)) d.status = item;
            else if (/ip.?adress/.test(key)) d.ipEnt = item;
            else if (/sicherheitsmodus|security.?mode/.test(key)) d.mode = item;
            break;
          case 'button':
            if (/ubung|drill/.test(key)) d.btnDrill = item;
            else if (/stumm|mute|silenc/.test(key)) d.btnMute = item;
            else if (/test/.test(key)) d.btnTest = item;
            break;
          default: break;
        }
      }
      d.alarm = d.alarms.some((a) => a.st.state === 'on');
      d.online = total > 0 && unavailable < total
        && !(d.conn && d.conn.st.state !== 'on')
        && !(d.signal && ['no_signal', 'unavailable'].includes(d.signal.st.state));
      const bat = this._num(d.battery);
      if (d.eol?.st.state === 'on') d.warnings.push({ item: d.eol, text: 'Ende der Lebensdauer', cls: 'err', icon: 'mdi:alert' });
      if (d.status && !BAD.includes(d.status.st.state) && d.status.st.state !== 'normal') {
        d.warnings.push({ item: d.status, text: this._plain(d.status.st), cls: 'err', icon: 'mdi:shield-alert-outline' });
      }
      if (bat != null && bat < Number(this._config.low_battery)) {
        d.warnings.push({ item: d.battery, text: `Batterie ${bat} %`, cls: 'warn', icon: 'mdi:battery-alert-variant-outline' });
      }
      if (d.testResult && /fail|fehl|error/i.test(d.testResult.st.state)) {
        d.warnings.push({ item: d.testResult, text: 'Gerätetest fehlgeschlagen', cls: 'err', icon: 'mdi:close-circle-outline' });
      }
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

  _signalRank(d) {
    if (d.signal) return SIGNAL_RANK[d.signal.st.state] ?? -1;
    const v = this._num(d.rssi);
    if (v == null) return -1;
    return v >= -65 ? 3 : v >= -75 ? 2 : 1;
  }

  _signalHtml(d) {
    if (d.signal) {
      const r = SIGNAL_RANK[d.signal.st.state];
      return `<ha-icon icon="${SIGNAL_ICON[r] || 'mdi:signal-off'}"></ha-icon>${this._val(d.signal.st)}`;
    }
    if (d.rssi) {
      const v = this._num(d.rssi);
      const icon = v == null ? 'mdi:wifi-strength-off-outline'
        : v >= -55 ? 'mdi:wifi-strength-4' : v >= -65 ? 'mdi:wifi-strength-3' : v >= -75 ? 'mdi:wifi-strength-2' : 'mdi:wifi-strength-1';
      return `<ha-icon icon="${icon}"></ha-icon>${this._val(d.rssi.st)}`;
    }
    return '–';
  }

  _deviceIcon(d) {
    if (d.isHub) return 'mdi:router-wireless';
    const dc = d.alarms[0]?.st.attributes.device_class;
    if (dc === 'carbon_monoxide') return 'mdi:molecule-co';
    if (dc === 'moisture') return 'mdi:water-alert';
    if (dc === 'heat') return 'mdi:thermometer-alert';
    return d.alarm ? 'mdi:smoke-detector-variant-alert' : 'mdi:smoke-detector-variant';
  }

  _iconSrc(d) {
    const base = this._config.icon_base;
    const name = this._config.icon_map[d.model] || (base ? d.model.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
    if (!name) return '';
    return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${base}/${name}.png`;
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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--xmc-min, 240px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .dev.alarm { opacity:1; border-color: var(--error-color, #db4437); box-shadow: 0 0 0 2px var(--error-color, #db4437); }
        .dev.alarm .ico ha-icon { color: var(--error-color, #db4437); }
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .ico img { width:30px; height:30px; object-fit:contain; }
        .ico img.on + ha-icon { display:none; }
        .ico img:not(.on) { display:none; }
        .dot { position:absolute; right:-3px; bottom:-3px; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:15px; font-weight:600; line-height:1.2; flex:1; min-width:0; }
        .name small { display:block; font-size:11px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .iconbtn[disabled] { opacity:.35; cursor:default; }
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:10px; row-gap:1px; font-size:12px; }
        .meta .k { color: var(--secondary-text-color); }
        .meta .v { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .meta ha-icon { --mdc-icon-size:14px; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
        .chip ha-icon { --mdc-icon-size:14px; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
        .rows { padding: 0 10px 6px; flex:1; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:13px;
          border-top: 1px solid var(--divider-color); cursor:pointer; }
        .row:first-child { border-top:none; }
        .row .lbl { color: var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; display:flex; align-items:center; gap:4px; }
        .row .val ha-icon { --mdc-icon-size:16px; }
        .row .val.err { color: var(--error-color, #db4437); font-weight:600; }
        .row .val.warn { color: var(--warning-color, #ffa600); }
        .row .val.ok { color: var(--success-color, #43a047); }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); min-height:28px; }
        .foot .sp { flex:1; }
        .fbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:3px 6px; border-radius:8px;
          font: inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
        .fbtn ha-icon { --mdc-icon-size:16px; }
        .fbtn:hover { background: var(--divider-color); color: var(--primary-text-color); }
        .fbtn[disabled] { opacity:.35; cursor:default; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
        .dlg-h ha-icon { --mdc-icon-size:32px; color: var(--primary-color); }
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
        <div class="title"><ha-icon icon="mdi:smoke-detector-variant"></ha-icon>X-Sense Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="alarm">Alarm</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="model">Modell</option>
          <option value="battery">Batterie</option>
          <option value="signal">Signal</option>
          <option value="report">Letzte Meldung</option>
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
    root.getElementById('grid').addEventListener('load', (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('on');
    }, true);
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
    const mac = (r.connections || []).find((c) => c[0] === 'mac');
    const ident = (r.identifiers || []).map((i) => i[1]).join(', ');
    const info = [
      ['Hersteller', r.manufacturer], ['Modell', d.model], ['Hardware', r.hw_version], ['Firmware', r.sw_version],
      ['Seriennummer', r.serial_number], ['MAC', mac && mac[1]], ['Kennung', ident],
      ['IP-Adresse', d.ipEnt && !BAD.includes(d.ipEnt.st.state) && d.ipEnt.st.state], ['Raum', d.area],
      ['Verbunden über', d.hub], ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const cat = { state: [], meas: [], conf: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (dom === 'button' || x === d.ipEnt) continue;
      if (x.ent.entity_category === 'config' || ['number', 'select', 'switch'].includes(dom)) cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic') cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      const right = dom === 'switch'
        ? `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}></button>`
        : `<span class="v">${this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${this._deviceIcon(d)}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${sec('Zustände', cat.state)}${sec('Messwerte', cat.meas)}${sec('Konfiguration', cat.conf)}${sec('Diagnose', cat.diag)}
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
    root.host.style.setProperty('--xmc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model} ${d.hub}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'alarm': return d.alarm;
        case 'problem': return d.warnings.length > 0;
        default: return true;
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'de');
    const ts = (d) => { const t = d.report ? new Date(d.report.st.state).getTime() : NaN; return Number.isNaN(t) ? Infinity : t; };
    const cmp = {
      name: byName,
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || byName(a, b),
      model: (a, b) => a.model.localeCompare(b.model) || byName(a, b),
      battery: (a, b) => (this._num(a.battery) ?? 999) - (this._num(b.battery) ?? 999) || byName(a, b),
      signal: (a, b) => this._signalRank(a) - this._signalRank(b) || byName(a, b),
      report: (a, b) => ts(a) - ts(b) || byName(a, b),
    }[this._sort];
    // Geräte im Alarm stehen immer oben
    list.sort((a, b) => (b.alarm - a.alarm) || cmp(a, b));

    const online = all.filter((d) => d.online).length;
    const alarms = all.filter((d) => d.alarm).length;
    const warn = all.filter((d) => d.warnings.length).length;
    const bats = all.map((d) => this._num(d.battery)).filter((v) => v != null);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      ${alarms ? `<span class="al">${alarms} im Alarm</span>` : '<span>kein Alarm</span>'}
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
          <div class="ico"><img alt="" loading="lazy"><ha-icon></ha-icon><span class="dot"></span></div>
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
    const cls = `dev${d.online ? '' : ' offline'}${d.alarm ? ' alarm' : ''}${window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''}`;
    if (c.el.className !== cls) c.el.className = cls;
    const src = this._iconSrc(d);
    if (c.last.src !== src) {
      c.img.classList.remove('on');
      if (src) c.img.src = src; else c.img.removeAttribute('src');
      c.last.src = src;
    }
    const mi = this._deviceIcon(d);
    if (c.icon.getAttribute('icon') !== mi) c.icon.setAttribute('icon', mi);
    for (const k of ['name', 'meta', 'chips', 'rows', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    c.chips.style.display = parts.chips ? '' : 'none';
    return c.el;
  }

  _deviceParts(d) {
    const row = (item, label, val, cls = '') => `<div class="row" data-more="${item.id}"><span class="lbl">${esc(label)}</span><span class="val ${cls}">${val}</span></div>`;
    const rows = [];
    for (const a of d.alarms) {
      const on = a.st.state === 'on';
      const bad = BAD.includes(a.st.state);
      rows.push(row(a, a.label, `<ha-icon icon="${on ? 'mdi:alarm-light' : 'mdi:check-circle-outline'}"></ha-icon>${on ? 'ALARM' : bad ? '–' : 'kein Alarm'}`, on ? 'err' : bad ? '' : 'ok'));
    }
    if (d.status) rows.push(row(d.status, 'Gerätestatus', this._val(d.status.st), d.status.st.state === 'normal' ? 'ok' : BAD.includes(d.status.st.state) ? '' : 'err'));
    if (d.mode) rows.push(row(d.mode, 'Sicherheitsmodus', this._val(d.mode.st)));
    if (d.battery) {
      const v = this._num(d.battery);
      rows.push(row(d.battery, 'Batterie', `<ha-icon icon="${this._batIcon(v)}"></ha-icon>${this._val(d.battery.st)}`, v != null && v < Number(this._config.low_battery) ? 'warn' : ''));
    }
    if (d.report) rows.push(row(d.report, 'Letzte Meldung', `<span title="${esc(this._dateTitle(d.report.st))}">${this._ago(d.report.st) || '–'}</span>`));
    if (d.testResult || d.testTime) {
      const res = d.testResult ? this._plain(d.testResult.st) : '';
      const ago = this._ago(d.testTime?.st);
      const item = d.testResult || d.testTime;
      rows.push(row(item, 'Gerätetest', `<span title="${esc(this._dateTitle(d.testTime?.st))}">${esc([res !== '–' ? res : '', ago].filter(Boolean).join(' · ') || '–')}</span>`));
    }

    const chips = [];
    const chip = (item, cls, icon, text) => `<span class="chip ${cls}" data-more="${item.id}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    if (d.alarm) chips.push(chip(d.alarms.find((a) => a.st.state === 'on'), 'err', 'mdi:alarm-light', 'Alarm'));
    for (const w of d.warnings) chips.push(chip(w.item, w.cls, w.icon, w.text));
    if (d.drill?.st.state === 'on') chips.push(chip(d.drill, 'warn', 'mdi:fire-alert', 'Alarmübung aktiv'));
    if (d.muted?.st.state === 'on') chips.push(chip(d.muted, 'warn', 'mdi:volume-off', 'Stummgeschaltet'));
    if (d.conn) chips.push(d.conn.st.state === 'on'
      ? chip(d.conn, 'ok', 'mdi:cloud-check-outline', 'Verbunden')
      : chip(d.conn, 'err', 'mdi:cloud-off-outline', 'Nicht verbunden'));

    const ip = d.ipEnt && !BAD.includes(d.ipEnt.st.state) ? d.ipEnt.st.state : '';
    const btn = (item, icon, text, title, confirm = '') => (item
      ? `<button class="fbtn" data-act="press" data-e="${item.id}" data-c="${esc(confirm)}" title="${esc(title)}" ${d.online ? '' : 'disabled'}><ha-icon icon="${icon}"></ha-icon>${text}</button>`
      : '');
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          <span class="k">Signal</span><span class="v">${this._signalHtml(d)}</span>
          ${ip ? `<span class="k">IP</span><span class="v">${esc(ip)} <button class="iconbtn" data-act="copy" data-v="${esc(ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button></span>` : ''}
          ${d.hub ? `<span class="k">Basis</span><span class="v">${esc(d.hub)}</span>` : ''}
          <span class="k">Modell</span><span class="v">${esc(d.model || '–')}${d.sw ? ` <span style="color:var(--secondary-text-color)">· FW ${esc(d.sw)}</span>` : ''}</span>`,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: `
          ${btn(d.btnTest, 'mdi:check-circle-outline', 'Test', 'Gerätetest starten', `Gerätetest für ${d.name} starten? Der Melder gibt dabei einen Testton aus.`)}
          ${btn(d.btnMute, 'mdi:volume-off', 'Stumm', 'Melder stummschalten')}
          <span class="sp"></span>
          ${btn(d.btnDrill, 'mdi:fire-alert', 'Übung', 'Alarmübung auslösen', `Alarmübung über ${d.name} auslösen? Dabei können alle vernetzten Melder Alarm geben.`)}`,
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
        case 'press':
          if (ds.c && !window.confirm(ds.c)) break;
          await hass.callService('button', 'press', { entity_id: ds.e });
          this._fire('hass-notification', { message: 'Befehl gesendet' });
          break;
        case 'info': this._openInfo(ds.d); break;
        case 'close': this._closeInfo(); break;
        case 'copy':
          await navigator.clipboard?.writeText(ds.v);
          this._fire('hass-notification', { message: `${ds.v} kopiert` });
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

if (!customElements.get('xsense-manager-card')) {
  customElements.define('xsense-manager-card', XSenseManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'xsense-manager-card', name: 'X-Sense Manager', description: 'Alle X-Sense-Geräte im Stil des ioBroker Device Managers' });
  console.info(`%c XSENSE-MANAGER-CARD %c ${VERSION} `, 'background:#e53935;color:#fff', 'background:#eee;color:#333');
}
