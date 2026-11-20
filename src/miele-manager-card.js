/*
 * Miele Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota-, ESPHome-, X-Sense- und Proxmox Manager Card).
 * Liest alle Geräte der Miele@LAN-Integration (miele_lan) live aus der Geräte-/Entitäts-Registry,
 * neue Geräte erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:miele-manager-card
 *   integration: miele_lan     # Plattform der Entitäten
 *   min_width: 320             # Mindestbreite einer Gerätekarte in px
 *   low_level: 15              # Warnschwelle für Füllstände (Salz, Klarspüler, PowerDisk …) in %
 *   icon_base: ''              # Ordner mit Gerätebildern, z. B. /local/images/miele (leer = MDI-Icons)
 *   icon_map: { "Dishwasher": "g7560" }   # optionale Zuordnung Modell -> Bilddatei
 */
const VERSION = '1.0.0';
const BAD = ['unavailable', 'unknown'];
const RUNNING = ['in_use', 'rinse_hold', 'autocleaning'];
const ACTIVE = ['in_use', 'rinse_hold', 'autocleaning', 'pause', 'programmed', 'waiting_to_start'];
const STATUS_ICON = {
  off: 'mdi:power-off', on: 'mdi:power', idle: 'mdi:power', in_use: 'mdi:play-circle-outline', pause: 'mdi:pause-circle-outline',
  programmed: 'mdi:clock-outline', waiting_to_start: 'mdi:timer-sand', program_ended: 'mdi:check-circle-outline',
  program_interrupted: 'mdi:stop-circle-outline', failure: 'mdi:alert-circle-outline', not_connected: 'mdi:lan-disconnect',
  rinse_hold: 'mdi:water-pump', service: 'mdi:wrench-outline', locked: 'mdi:lock-outline',
};
const TYPES = [
  [/dish|geschirr|spul/, 'mdi:dishwasher'],
  [/dryer|trockn|tumble/, 'mdi:tumble-dryer'],
  [/wash|wasch/, 'mdi:washing-machine'],
  [/oven|backofen|steam|dampf|cooker|herd|microwave|mikrowelle/, 'mdi:stove'],
  [/fridge|freez|kuhl|gefrier|wine|wein/, 'mdi:fridge-outline'],
  [/coffee|kaffee/, 'mdi:coffee-maker-outline'],
  [/hood|dunst/, 'mdi:range-hood'],
  [/hob|kochfeld/, 'mdi:countertop-outline'],
  [/robot|scout|vacuum|sauger/, 'mdi:robot-vacuum'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtMin = (v) => {
  if (v == null) return '–';
  const m = Math.round(v);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h` : `${m} min`;
};

class MieleManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'miele_lan', min_width: 320, low_level: 15, icon_base: '', icon_map: {}, ...config };
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
  static getStubConfig() { return { integration: 'miele_lan' }; }

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
        status: null, program: null, programSensor: null, phase: null, ptype: null,
        remaining: null, elapsed: null, startIn: null, progress: null, endTime: null,
        remote: null, standby: null, rssi: null, signalPct: null, push: null,
        door: null, error: null, notice: null, running: null, mobile: null, power: null,
        ipEnt: null, wifi: null, wifiFw: null, matNr: null,
        levels: [], temps: [], totals: [],
        btnStart: null, btnStop: null, btnPause: null, btnResume: null, btnWake: null,
        warnings: [], online: true, active: false, isRunning: false, paused: false, sig: '', reg, all: [],
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
        const raw = /raw/.test(key);
        switch (domain) {
          case 'binary_sensor':
            if (dc === 'door' || /tur\b|door/.test(key)) d.door = item;
            else if (dc === 'problem' || /fehler|failure|error/.test(key)) d.error = item;
            else if (/hinweis|notice|signal_info|info/.test(key)) d.notice = item;
            else if (dc === 'running' || /lauft|running/.test(key)) d.running = item;
            else if (/mobil|mobile/.test(key)) d.mobile = item;
            break;
          case 'switch':
            if (/ein.?aus|power/.test(key)) d.power = item;
            break;
          case 'select':
            if (/programm|program/.test(key)) d.program = item;
            break;
          case 'sensor':
            if (raw) break;
            if (dc === 'signal_strength') d.rssi = item;
            else if (dc === 'temperature') d.temps.push(item);
            else if (['energy', 'water', 'gas'].includes(dc)) d.totals.push(item);
            else if (/standby/.test(key)) d.standby = item;
            else if (/fernsteuer|remote/.test(key)) d.remote = item;
            else if (/push/.test(key)) d.push = item;
            else if (/verbleib|remaining/.test(key)) d.remaining = item;
            else if (/vergangen|elapsed/.test(key)) d.elapsed = item;
            else if (/start.?in|delay/.test(key)) d.startIn = item;
            else if (/fortschritt|progress/.test(key)) d.progress = item;
            else if (/endzeit|end.?time|finish/.test(key)) d.endTime = item;
            else if (/phase/.test(key)) d.phase = item;
            else if (/programmtyp|program.?type/.test(key)) d.ptype = item;
            else if (/programm|program/.test(key) && !/id/.test(key)) d.programSensor = item;
            else if (/fullstand|level|fill/.test(key)) d.levels.push(item);
            else if (/wlan.?signal|wifi.?signal|signal/.test(key)) d.signalPct = item;
            else if (/ip.?adress|ip.?address/.test(key)) d.ipEnt = item;
            else if (/wifi.?modul.?firm/.test(key)) d.wifiFw = item;
            else if (/wifi.?modul/.test(key)) d.wifi = item;
            else if (/material/.test(key)) d.matNr = item;
            else if (/status|state/.test(key) && !/gerateaktion|prozess/.test(key)) d.status = item;
            break;
          case 'button':
            if (/fortsetz|resume/.test(key)) d.btnResume = item;
            else if (/pause/.test(key)) d.btnPause = item;
            else if (/stop/.test(key)) d.btnStop = item;
            else if (/weck|wake/.test(key)) d.btnWake = item;
            else if (/start/.test(key)) d.btnStart = item;
            break;
          default: break;
        }
      }
      const s = d.status && d.status.st.state;
      d.online = total > 0 && unavailable < total && s !== 'not_connected';
      d.isRunning = RUNNING.includes(s) || d.running?.st.state === 'on';
      d.paused = s === 'pause';
      d.active = d.isRunning || ACTIVE.includes(s);
      if (d.error?.st.state === 'on' || s === 'failure') {
        d.warnings.push({ item: d.error || d.status, text: 'Störung', cls: 'err', icon: 'mdi:alert-circle-outline' });
      }
      if (d.notice?.st.state === 'on') d.warnings.push({ item: d.notice, text: 'Hinweis am Gerät', cls: 'warn', icon: 'mdi:information-outline' });
      for (const l of d.levels) {
        const v = this._num(l);
        if (v != null && v < Number(this._config.low_level)) {
          d.warnings.push({ item: l, text: `${l.label.replace(/\s*f[uü]llstand/i, '') || l.label} ${v} %`, cls: 'warn', icon: 'mdi:cup-off-outline' });
        }
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
  _plain(st, state) {
    const s = state ?? st?.state;
    if (!st || s == null || BAD.includes(s)) return '–';
    if (typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st, s);
    const unit = st.attributes.unit_of_measurement;
    return unit ? `${s} ${unit}` : s;
  }

  _val(st) { return esc(this._plain(st)); }

  _time(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    if (Number.isNaN(dt.getTime())) return '';
    const t = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return dt.toDateString() === new Date().toDateString() ? `${t} Uhr` : `${dt.toLocaleDateString('de-DE', { weekday: 'short' })} ${t} Uhr`;
  }

  _signalRank(d) {
    const v = this._num(d.rssi);
    if (v != null) return v;
    const p = this._num(d.signalPct);
    return p == null ? -999 : p - 120;
  }

  _signalHtml(d) {
    const v = this._num(d.rssi);
    const p = this._num(d.signalPct);
    if (v == null && p == null) return '–';
    const q = p != null ? p : Math.max(0, Math.min(100, 2 * (v + 100)));
    const icon = q >= 75 ? 'mdi:wifi-strength-4' : q >= 50 ? 'mdi:wifi-strength-3' : q >= 25 ? 'mdi:wifi-strength-2' : 'mdi:wifi-strength-1';
    const txt = [p != null ? `${p} %` : '', v != null ? `${v} dBm` : ''].filter(Boolean).join(' · ');
    return `<ha-icon icon="${icon}"></ha-icon>${esc(txt)}`;
  }

  _ip(d) {
    if (d.ipEnt && !BAD.includes(d.ipEnt.st.state)) return d.ipEnt.st.state;
    return d.push?.st.attributes.host_ip || '';
  }

  _deviceIcon(d) {
    const k = slug(`${d.model} ${d.reg.name || ''}`);
    for (const [re, icon] of TYPES) if (re.test(k)) return icon;
    return 'mdi:alpha-m-box-outline';
  }

  _iconSrc(d) {
    const base = this._config.icon_base;
    const name = this._config.icon_map[d.model] || (base ? d.model.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
    if (!name) return '';
    return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${base}/${name}.png`;
  }

  _selectHtml(x, disabled) {
    const opts = (x.st.attributes.options || [])
      .map((o) => `<option value="${esc(o)}" ${o === x.st.state ? 'selected' : ''}>${esc(this._plain(x.st, o))}</option>`).join('');
    const unknown = (x.st.attributes.options || []).includes(x.st.state) ? '' : '<option selected>–</option>';
    return `<select class="sel" data-act="select" data-e="${x.id}" ${disabled ? 'disabled' : ''}>${unknown}${opts}</select>`;
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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--mmc-min, 320px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .dev.active { border-color: var(--primary-color); }
        .dev.fault { border-color: var(--error-color, #db4437); box-shadow: 0 0 0 2px var(--error-color, #db4437); }
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .active .ico ha-icon { color: var(--state-active-color, var(--amber-color, #ffc107)); }
        .fault .ico ha-icon { color: var(--error-color, #db4437); }
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
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:12px; row-gap:1px; font-size:12px; }
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
        .row .val ha-icon { --mdc-icon-size:18px; }
        .row .val.err { color: var(--error-color, #db4437); font-weight:600; }
        .row .val.warn { color: var(--warning-color, #ffa600); }
        .row .val.ok { color: var(--success-color, #43a047); }
        .row .val.act { color: var(--primary-color); font-weight:600; }
        .prog { padding:6px 0 4px; border-top: 1px solid var(--divider-color); cursor:pointer; }
        .prog .bar { height:8px; border-radius:4px; background: var(--secondary-background-color); overflow:hidden; margin-bottom:4px; }
        .prog .bar i { display:block; height:100%; background: var(--primary-color); border-radius:4px; transition: width .4s; }
        .prog .txt { display:flex; justify-content:space-between; font-size:12px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .lvl { display:inline-flex; align-items:center; gap:6px; }
        .lvl .bar { width:60px; height:6px; border-radius:3px; background: var(--secondary-background-color); overflow:hidden; }
        .lvl .bar i { display:block; height:100%; background: var(--success-color, #43a047); }
        .lvl.warn .bar i { background: var(--warning-color, #ffa600); }
        .sel { max-width:190px; background: var(--secondary-background-color); color: var(--primary-text-color);
          border:1px solid var(--divider-color); border-radius:6px; padding:3px 6px; font: inherit; font-size:13px; cursor:pointer; }
        .sel[disabled] { opacity:.5; cursor:default; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .foot { display:flex; align-items:center; gap:4px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); min-height:34px; flex-wrap:wrap; }
        .foot .sp { flex:1; }
        .fbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:5px 8px; border-radius:8px;
          font: inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
        .fbtn ha-icon { --mdc-icon-size:18px; }
        .fbtn:hover { background: var(--divider-color); color: var(--primary-text-color); }
        .fbtn.on { color: var(--primary-color); }
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
        .kv { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv:last-child { border-bottom:none; }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:alpha-m-box"></ha-icon>Miele Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="active">Aktiv</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="model">Gerätetyp</option>
          <option value="status">Status</option>
          <option value="remaining">Restzeit</option>
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
    root.getElementById('grid').addEventListener('change', (e) => this._onChange(e));
    this._dlg.addEventListener('change', (e) => this._onChange(e));
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
    const ok = (x) => x && !BAD.includes(x.st.state) && x.st.state;
    const pa = d.push?.st.attributes || {};
    const info = [
      ['Hersteller', r.manufacturer], ['Gerätetyp', d.model], ['Firmware', r.sw_version], ['Hardware', r.hw_version],
      ['Materialnummer', ok(d.matNr)], ['Seriennummer', r.serial_number || pa.fab], ['Kennung', ident],
      ['WiFi-Modul', ok(d.wifi)], ['WiFi-Firmware', ok(d.wifiFw)], ['MAC', mac && mac[1]],
      ['IP-Adresse', this._ip(d)], ['Raum', d.area], ['Status', d.online ? 'online' : 'offline'],
      ['Push-Überwachung', d.push ? (pa.supervision_ok ? 'ok' : 'nicht aktiv') : ''],
    ].filter(([, v]) => v);
    const cat = { state: [], meas: [], conf: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (dom === 'button' || x === d.ipEnt) continue;
      if (x.ent.entity_category === 'config' || ['number', 'select', 'switch'].includes(dom)) cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic' || /raw/.test(slug(x.label))) cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      let right;
      if (dom === 'switch') right = `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}></button>`;
      else if (dom === 'select') right = this._selectHtml(x, BAD.includes(x.st.state) || d.active);
      else if (x.st.attributes.device_class === 'timestamp') right = `<span class="v">${esc(this._time(x.st) || '–')}</span>`;
      else right = `<span class="v">${this._val(x.st)}</span>`;
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
          ${sec('Zustände', cat.state)}${sec('Messwerte', cat.meas)}${sec('Bedienung', cat.conf)}${sec('Diagnose', cat.diag)}
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
    root.host.style.setProperty('--mmc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'active': return d.active;
        case 'problem': return d.warnings.length > 0;
        default: return true;
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'de');
    const rest = (d) => (d.active ? this._num(d.remaining) ?? 9999 : 99999);
    const cmp = {
      name: byName,
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || byName(a, b),
      model: (a, b) => a.model.localeCompare(b.model) || byName(a, b),
      status: (a, b) => (b.active - a.active) || (b.online - a.online) || byName(a, b),
      remaining: (a, b) => rest(a) - rest(b) || byName(a, b),
      signal: (a, b) => this._signalRank(a) - this._signalRank(b) || byName(a, b),
    }[this._sort];
    // Geräte mit Störung stehen immer oben
    const fault = (d) => d.warnings.some((w) => w.cls === 'err');
    list.sort((a, b) => (fault(b) - fault(a)) || cmp(a, b));

    const online = all.filter((d) => d.online).length;
    const active = all.filter((d) => d.active).length;
    const faults = all.filter(fault).length;
    const warn = all.filter((d) => d.warnings.length).length;
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      <span>${active ? `${active} aktiv` : 'nichts aktiv'}</span>
      ${faults ? `<span class="al">${faults} mit Störung</span>` : ''}
      ${warn - faults > 0 ? `<span>${warn - faults} mit Warnung</span>` : ''}`;

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
    const faulty = d.warnings.some((w) => w.cls === 'err');
    const cls = `dev${d.online ? '' : ' offline'}${d.active ? ' active' : ''}${faulty ? ' fault' : ''}${window.__hmcCls ? window.__hmcCls(this._hass, d.active ? 'pw' : window.__hmcActRaw(this._hass, d.id).a, true) : ''}`;
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
    const s = d.status?.st.state;
    if (d.status) {
      const cls = s === 'failure' ? 'err' : s === 'program_ended' ? 'ok' : d.active ? 'act' : '';
      rows.push(row(d.status, 'Status', `<ha-icon icon="${STATUS_ICON[s] || 'mdi:information-outline'}"></ha-icon>${this._val(d.status.st)}`, cls));
    }
    if (d.program) {
      const lock = !d.online || d.active || BAD.includes(d.program.st.state);
      rows.push(row(d.program, 'Programm', this._selectHtml(d.program, lock)));
    } else if (d.programSensor) {
      rows.push(row(d.programSensor, 'Programm', this._val(d.programSensor.st)));
    }
    if (d.active && d.phase && !BAD.includes(d.phase.st.state)) rows.push(row(d.phase, 'Phase', this._val(d.phase.st)));
    const startIn = this._num(d.startIn);
    if (startIn) rows.push(row(d.startIn, 'Startvorwahl', `<ha-icon icon="mdi:timer-sand"></ha-icon>startet in ${fmtMin(startIn)}`, 'act'));
    const prog = this._num(d.progress);
    const remain = this._num(d.remaining);
    if (d.active && (prog != null || remain != null)) {
      const end = this._time(d.endTime?.st);
      const elapsed = this._num(d.elapsed);
      const target = d.progress || d.remaining;
      rows.push(`<div class="prog" data-more="${target.id}">
          <div class="bar"><i style="width:${Math.max(0, Math.min(100, prog ?? 0))}%"></i></div>
          <div class="txt"><span>${prog != null ? `${Math.round(prog)} %` : ''}${elapsed != null ? ` · seit ${fmtMin(elapsed)}` : ''}</span>
          <span>${remain != null ? `noch ${fmtMin(remain)}` : ''}${end ? ` · fertig ${esc(end)}` : ''}</span></div></div>`);
    }
    for (const t of d.temps) {
      const v = this._num(t);
      if (v == null || (!d.active && v === 0 && !/kuhl|gefrier|fridge|freez/.test(slug(d.model)))) continue;
      rows.push(row(t, t.label, `<ha-icon icon="mdi:thermometer"></ha-icon>${this._val(t.st)}`));
    }
    for (const l of d.levels) {
      const v = this._num(l);
      if (v == null) continue;
      const low = v < Number(this._config.low_level);
      rows.push(row(l, l.label, `<span class="lvl ${low ? 'warn' : ''}"><span class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span>${this._val(l.st)}</span>`, low ? 'warn' : ''));
    }
    for (const t of d.totals) rows.push(row(t, t.label.replace(/^gesamter?\s*/i, '').replace(/^\w/, (m) => m.toUpperCase()), this._val(t.st)));

    const chips = [];
    const chip = (item, cls, icon, text) => `<span class="chip ${cls}" data-more="${item.id}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    for (const w of d.warnings) chips.push(chip(w.item, w.cls, w.icon, w.text));
    if (d.door?.st.state === 'on') chips.push(chip(d.door, 'warn', 'mdi:door-open', 'Tür offen'));
    if (d.mobile) chips.push(d.mobile.st.state === 'on'
      ? chip(d.mobile, 'ok', 'mdi:cellphone-check', 'MobileStart bereit')
      : chip(d.mobile, '', 'mdi:cellphone-off', 'MobileStart aus'));
    const rc = d.remote?.st.state;
    if (rc && !BAD.includes(rc) && rc !== 'full') chips.push(chip(d.remote, 'warn', 'mdi:remote-off', `Fernsteuerung: ${this._plain(d.remote.st)}`));
    const sb = d.standby?.st.state;
    if (sb === 'deep_standby') chips.push(chip(d.standby, '', 'mdi:sleep', 'Tiefschlaf'));

    const ip = this._ip(d);
    const btn = (item, icon, text, title, confirm = '', enabled = true) => (item
      ? `<button class="fbtn" data-act="press" data-e="${item.id}" data-c="${esc(confirm)}" title="${esc(title)}" ${d.online && enabled ? '' : 'disabled'}><ha-icon icon="${icon}"></ha-icon>${text}</button>`
      : '');
    const pw = d.power;
    const pwBtn = pw
      ? `<button class="fbtn ${pw.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${pw.id}" title="Ein-/Ausschalten" ${d.online && !BAD.includes(pw.st.state) ? '' : 'disabled'}><ha-icon icon="mdi:power"></ha-icon>${pw.st.state === 'on' ? 'Ein' : 'Aus'}</button>`
      : '';
    const canStart = !d.isRunning && !d.paused && (!d.mobile || d.mobile.st.state === 'on');
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          <span class="k">WLAN</span><span class="v">${this._signalHtml(d)}</span>
          ${ip ? `<span class="k">IP</span><span class="v">${esc(ip)} <button class="iconbtn" data-act="copy" data-v="${esc(ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button></span>` : ''}
          <span class="k">Gerätetyp</span><span class="v">${esc(d.model || '–')}</span>
          <span class="k">Firmware</span><span class="v">${esc([d.sw, d.wifiFw && !BAD.includes(d.wifiFw.st.state) ? `WiFi ${d.wifiFw.st.state}` : ''].filter(Boolean).join(' · ') || '–')}</span>`,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: `
          ${pwBtn}
          ${sb === 'deep_standby' ? btn(d.btnWake, 'mdi:alarm', 'Wecken', 'Gerät aus dem Tiefschlaf holen') : ''}
          <span class="sp"></span>
          ${!d.isRunning && !d.paused ? btn(d.btnStart, 'mdi:play', 'Start', 'Programm starten (MobileStart)', `Programm auf ${d.name} starten?`, canStart) : ''}
          ${d.isRunning ? btn(d.btnPause, 'mdi:pause', 'Pause', 'Programm pausieren') : ''}
          ${d.paused ? btn(d.btnResume, 'mdi:play-pause', 'Fortsetzen', 'Programm fortsetzen') : ''}
          ${d.isRunning || d.paused ? btn(d.btnStop, 'mdi:stop', 'Stopp', 'Programm abbrechen', `Laufendes Programm auf ${d.name} wirklich abbrechen?`) : ''}`,
    };
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
    if (btn) {
      e.stopPropagation();
      if (btn.disabled || btn.tagName === 'SELECT') return;
      this._action(btn.dataset);
      return;
    }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  _onChange(e) {
    const el = e.composedPath()[0];
    if (!el || el.tagName !== 'SELECT' || el.dataset.act !== 'select') return;
    e.stopPropagation();
    this._action({ act: 'select', e: el.dataset.e, v: el.value });
  }

  async _action(ds) {
    const hass = this._hass;
    const [domain] = (ds.e || '').split('.');
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain, 'toggle', { entity_id: ds.e }); break;
        case 'select': await hass.callService('select', 'select_option', { entity_id: ds.e, option: ds.v }); break;
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
      // Auswahl/Schalter auf den echten Zustand zurücksetzen
      for (const c of Object.values(this._cards || {})) c.last = {};
      this._infoHtml = '';
      this._renderGrid();
      if (this._infoId) this._renderInfo();
    }
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get('miele-manager-card')) {
  customElements.define('miele-manager-card', MieleManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'miele-manager-card', name: 'Miele Manager', description: 'Alle Miele@LAN-Geräte im Stil des ioBroker Device Managers' });
  console.info(`%c MIELE-MANAGER-CARD %c ${VERSION} `, 'background:#8c0014;color:#fff', 'background:#eee;color:#333');
}
