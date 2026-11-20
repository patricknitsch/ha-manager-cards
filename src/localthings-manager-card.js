/*
 * LocalThings Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota-, ESPHome-, X-Sense-, Proxmox-, Miele-, Grohe- und Schlüter Manager Card).
 * Liest alle Samsung-Geräte der LocalThings-Integration (localthings) live aus der Geräte-/Entitäts-Registry,
 * neue Geräte erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:localthings-manager-card
 *   integration: localthings   # Plattform der Entitäten
 *   min_width: 240             # Mindestbreite einer Gerätekarte in px
 *   drum_clean_warn: 0         # Warnung, wenn die Trommelreinigung in höchstens so vielen Waschgängen fällig ist
 *   programs: { "1c": "Baumwolle" }   # optionale Klartextnamen für Programmcodes
 *   icon_base: ''              # Ordner mit Gerätebildern, z. B. /local/images/samsung (leer = MDI-Icons)
 *   icon_map: { "DA_WM_TP2_20_COMMON": "ww90t" }   # optionale Zuordnung Modell -> Bilddatei
 */
const VERSION = '1.0.0';
const BAD = ['unavailable', 'unknown'];
const STATE_DE = { idle: 'Bereit', active: 'Läuft', run: 'Läuft', running: 'Läuft', pause: 'Pausiert', paused: 'Pausiert', ready: 'Bereit', off: 'Aus' };
const STATE_ICON = { idle: 'mdi:power', ready: 'mdi:power', active: 'mdi:play-circle-outline', run: 'mdi:play-circle-outline', running: 'mdi:play-circle-outline', pause: 'mdi:pause-circle-outline', paused: 'mdi:pause-circle-outline', off: 'mdi:power-off' };
const PHASE_DE = {
  idle: 'Bereit', none: '–', weightsensing: 'Beladung wird gemessen', laundrysensing: 'Wäsche wird erkannt', delaywash: 'Startvorwahl',
  prewash: 'Vorwäsche', wash: 'Waschen', rinse: 'Spülen', spin: 'Schleudern', predrain: 'Abpumpen', steaming: 'Dampf',
  sanitizing: 'Hygiene', drying: 'Trocknen', aidrying: 'AI-Trocknen', airwashing: 'AirWash', cooling: 'Abkühlen',
  dryingwithdooropen: 'Trocknen (Tür offen)', finish: 'Fertig', finished: 'Fertig',
};
const OPTION_DE = { rinse_hold: 'Spülstopp', no_spin: 'Kein Schleudern', none: '–' };
const TYPES = [
  [/dryer|trockn|_dry|da_wd/, 'mdi:tumble-dryer'],
  [/dishwasher|geschirr|da_dw/, 'mdi:dishwasher'],
  [/washer|wasch|da_wm/, 'mdi:washing-machine'],
  [/fridge|ref|kuhl|gefrier/, 'mdi:fridge-outline'],
  [/oven|herd|backofen|da_ks|range/, 'mdi:stove'],
  [/robot|rvc|vacuum|sauger/, 'mdi:robot-vacuum'],
  [/air.?con|klima|da_ac|_ac_/, 'mdi:air-conditioner'],
  [/\btv\b|fernseh/, 'mdi:television'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtMin = (v) => {
  if (v == null) return '–';
  const m = Math.round(v);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h` : `${m} min`;
};

class LocalThingsManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'localthings', min_width: 240, drum_clean_warn: 0, programs: {}, icon_base: '', icon_map: {}, ...config };
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
  static getStubConfig() { return { integration: 'localthings' }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._entriesReq) this._loadEntries();
    const devices = this._collect();
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig, window.__hmcAct ? window.__hmcAct(this._hass, d.id) : '']));
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  connectedCallback() {
    // Restzeit / "fertig um" laufen auch ohne Zustandsänderung weiter
    clearInterval(this._tick);
    this._tick = setInterval(() => this._renderGrid(), 60000);
  }

  disconnectedCallback() { if (this._dlgHost) this._closeInfo(); clearInterval(this._tick); }

  /** IP-Adressen stehen nur im Titel des Konfigurationseintrags ("Samsung Washer (192.168.x.y)") */
  async _loadEntries() {
    this._entriesReq = true;
    try {
      const res = await this._hass.callWS({ type: 'config_entries/get', domain: this._config.integration });
      this._entries = Object.fromEntries((res || []).map((e) => [e.entry_id, e]));
      this._sig = '';
      if (this._hass) this.hass = this._hass;
    } catch (err) {
      this._entries = {};
    }
  }

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
      const model = reg.model || '';
      let name = (reg.name_by_user || reg.name || devId).trim();
      // "Samsung Washer (DA_WM_TP2_20_COMMON)" -> "Samsung Washer"
      if (!reg.name_by_user && model && name.endsWith(`(${model})`)) name = name.slice(0, -model.length - 2).trim();
      const regName = (reg.name || '').trim();
      const d = {
        id: devId, name, regName, model,
        sw: String(reg.sw_version || '').replace(`${model}_`, ''),
        area: reg.area_id && hass.areas?.[reg.area_id]?.name || '',
        machine: null, phase: null, progress: null, remaining: null, endTime: null, startState: null,
        alarm: null, diag: null, delay: null, finishAt: null, program: null,
        drumDue: null, drumLast: null, conn: null, lastResp: null,
        running: null, power: null, childLock: null, fwUpdate: null, remote: null, door: null,
        lows: [], temps: [], totals: [], options: [], switches: [],
        btnStart: null, btnPause: null, btnStop: null, btnResume: null, btnDiag: null,
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
        const label = this._label(ent, st, regName, name);
        // Zuordnung über Entitätsname/Übersetzungsschlüssel (deutsch und englisch), nicht über die Entitäts-ID
        const key = `${slug(label)} ${slug(ent.translation_key)}`;
        const item = { id, label, st, ent };
        d.all.push(item);
        switch (domain) {
          case 'binary_sensor':
            if (/niedrig|low|leer|empty/.test(key)) d.lows.push(item);
            else if (dc === 'update' || /update/.test(key)) d.fwUpdate = item;
            else if (dc === 'lock' || /kindersich|child/.test(key)) d.childLock = item;
            else if (dc === 'door' || /tur\b|door/.test(key)) d.door = item;
            else if (dc === 'running' || /lauft|running/.test(key)) d.running = item;
            else if (dc === 'power' || /betrieb|power/.test(key)) d.power = item;
            else if (dc === 'connectivity' || /intelligente|remote|smart.?control|fernsteuer/.test(key)) d.remote = item;
            break;
          case 'sensor':
            if (dc === 'temperature') d.temps.push(item);
            else if (['energy', 'water', 'gas'].includes(dc)) d.totals.push(item);
            else if (/prozent|percent/.test(key)) d.progress = item;
            else if (/maschinenzustand|machine.?state|operating.?state/.test(key)) d.machine = item;
            else if (/fortschritt|progress|job.?state|phase/.test(key)) d.phase = item;
            else if (/voraussichtliches.?ende|estimated.?end|end.?time/.test(key)) d.endTime = item;
            else if (/fertigstellung|remaining|restzeit|completion/.test(key)) d.remaining = item;
            else if (/startstatus|start.?status/.test(key)) d.startState = item;
            else if (/alarm|error|fehler/.test(key)) d.alarm = item;
            else if (/diagnose|diagnos/.test(key)) d.diag = item;
            else if (/trommelreinigung|drum.?clean|tub.?clean/.test(key)) d.drumDue = item;
            else if (/zuletzt.?gereinigt|last.?clean/.test(key)) d.drumLast = item;
            else if (/verbindung|connection/.test(key)) d.conn = item;
            else if (/letzte.?antwort|last.?response|last.?seen/.test(key)) d.lastResp = item;
            break;
          case 'select':
            if (/programm|program|course|cycle/.test(key)) d.program = item;
            else if (!/erinnerung|reminder/.test(key)) d.options.push(item);
            break;
          case 'switch': d.switches.push(item); break;
          case 'number': if (/verzoger|delay/.test(key)) d.delay = item; break;
          case 'time': if (/fertig|finish|end/.test(key)) d.finishAt = item; break;
          case 'button':
            if (/diagnose|diagnos/.test(key)) d.btnDiag = item;
            else if (/fortsetz|resume/.test(key)) d.btnResume = item;
            else if (/pause/.test(key)) d.btnPause = item;
            else if (/stop/.test(key)) d.btnStop = item;
            else if (/start/.test(key)) d.btnStart = item;
            break;
          default: break;
        }
      }
      const ms = d.machine?.st.state;
      d.online = total > 0 && unavailable < total;
      d.paused = ['pause', 'paused'].includes(ms);
      d.isRunning = ['active', 'run', 'running'].includes(ms) || d.running?.st.state === 'on';
      if (d.paused) d.isRunning = false;
      d.active = d.isRunning || d.paused || (this._num(d.delay) || 0) > 0 && d.phase?.st.state === 'delaywash';
      const al = d.alarm?.st.state;
      if (al && !BAD.includes(al) && !['none', 'None', '0', 'normal', 'ok'].includes(al)) {
        d.warnings.push({ item: d.alarm, text: `Störung ${al}`, cls: 'err', icon: 'mdi:alert-circle-outline' });
      }
      for (const l of d.lows) {
        if (l.st.state === 'on') d.warnings.push({ item: l, text: l.label, cls: 'warn', icon: 'mdi:cup-off-outline' });
      }
      const due = this._num(d.drumDue);
      if (due != null && due <= Number(this._config.drum_clean_warn)) {
        d.warnings.push({ item: d.drumDue, text: 'Trommelreinigung fällig', cls: 'warn', icon: 'mdi:washing-machine-alert' });
      }
      if (d.fwUpdate?.st.state === 'on') d.warnings.push({ item: d.fwUpdate, text: 'Firmware-Update', cls: 'warn', icon: 'mdi:package-up' });
      d.sig = d.all.map((x) => x.st.state).join('|') + d.online + (this._entries ? 'e' : '');
      out.push(d);
    }
    return out;
  }

  _label(ent, st, regName, name) {
    let n = ent.name || st.attributes.friendly_name || ent.entity_id;
    for (const p of [regName, name]) if (p && n.startsWith(p)) { n = n.slice(p.length).trim(); break; }
    return n || name;
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
    if (typeof this._hass.formatEntityState === 'function') {
      const f = this._hass.formatEntityState(st, s);
      if (f && f !== s) return f;
    }
    const unit = st.attributes.unit_of_measurement;
    return unit ? `${s} ${unit}` : s;
  }

  _val(st) { return esc(this._plain(st)); }

  /** Klartext mit eigener Übersetzung als Fallback, wenn die Integration keine liefert */
  _txt(item, map) {
    if (!item) return '–';
    const s = item.st.state;
    if (BAD.includes(s)) return '–';
    const f = this._plain(item.st);
    return f !== s ? f : (map[s] ?? map[String(s).toLowerCase()] ?? s);
  }

  _option(x, o) {
    const s = o ?? x.st.state;
    if (/programm|program/.test(slug(x.label)) && this._config.programs[s]) return this._config.programs[s];
    const f = this._plain(x.st, s);
    if (f !== s) return f;
    if (OPTION_DE[s]) return OPTION_DE[s];
    const k = slug(x.label);
    if (/temperatur|temp/.test(k) && /^\d+$/.test(s)) return `${s} °C`;
    if (/schleuder|spin/.test(k) && /^\d+$/.test(s)) return `${s} U/min`;
    if (/spul|rinse/.test(k) && /^\d+$/.test(s)) return `${s}× Spülen`;
    return s;
  }

  _time(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    if (Number.isNaN(dt.getTime())) return '';
    const t = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (dt.toDateString() === new Date().toDateString()) return `${t} Uhr`;
    if (Math.abs(dt.getTime() - Date.now()) > 6 * 86400000) return `${dt.toLocaleDateString('de-DE')} ${t} Uhr`;
    return `${dt.toLocaleDateString('de-DE', { weekday: 'short' })} ${t} Uhr`;
  }

  _date(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('de-DE');
  }

  _ip(d) {
    for (const eid of d.reg.config_entries || []) {
      const m = String(this._entries?.[eid]?.title || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      if (m) return m[1];
    }
    return '';
  }

  _deviceIcon(d) {
    const k = slug(`${d.model} ${d.regName}`);
    for (const [re, icon] of TYPES) if (re.test(k)) return icon;
    return 'mdi:devices';
  }

  _iconSrc(d) {
    const base = this._config.icon_base;
    const name = this._config.icon_map[d.model] || (base ? d.model.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
    if (!name) return '';
    return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${base}/${name}.png`;
  }

  _selectHtml(x, disabled) {
    const opts = (x.st.attributes.options || [])
      .map((o) => `<option value="${esc(o)}" ${o === x.st.state ? 'selected' : ''}>${esc(this._option(x, o))}</option>`).join('');
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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--lmc-min, 240px), 1fr)); }
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
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; display:flex; align-items:center; gap:4px; min-width:0; overflow:hidden; text-overflow:ellipsis; }
        .row .val ha-icon { --mdc-icon-size:16px; }
        .row .val.err { color: var(--error-color, #db4437); font-weight:600; }
        .row .val.warn { color: var(--warning-color, #ffa600); }
        .row .val.ok { color: var(--success-color, #43a047); }
        .row .val.act { color: var(--primary-color); font-weight:600; }
        .prog { padding:5px 0 3px; border-top: 1px solid var(--divider-color); cursor:pointer; }
        .prog .bar { height:7px; border-radius:4px; background: var(--secondary-background-color); overflow:hidden; margin-bottom:3px; }
        .prog .bar i { display:block; height:100%; background: var(--primary-color); border-radius:4px; transition: width .4s; }
        .prog .txt { display:flex; justify-content:space-between; gap:6px; font-size:11px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .sel { max-width:150px; background: var(--secondary-background-color); color: var(--primary-text-color);
          border:1px solid var(--divider-color); border-radius:6px; padding:2px 6px; font: inherit; font-size:12px; cursor:pointer; }
        .sel[disabled] { opacity:.5; cursor:default; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); min-height:28px; flex-wrap:wrap; }
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
        .dlg-b .sel { max-width:220px; font-size:13px; padding:3px 6px; }
        .kv { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv:last-child { border-bottom:none; }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .kv input[type=number] { width:70px; background: var(--secondary-background-color); color: var(--primary-text-color);
          border:1px solid var(--divider-color); border-radius:6px; padding:3px 6px; font: inherit; font-size:13px; }
        .acts { display:flex; flex-wrap:wrap; gap:6px; }
        .acts .fbtn { border:1px solid var(--divider-color); }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:alpha-l-box"></ha-icon>LocalThings Geräte</div>
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
          <option value="model">Modell</option>
          <option value="status">Status</option>
          <option value="remaining">Restzeit</option>
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
    if (host.querySelector('select:focus, input:focus')) return; // Eingabe nicht unterbrechen
    const r = d.reg || {};
    const ident = (r.identifiers || []).map((i) => i[1]).join(', ');
    const ok = (x) => x && !BAD.includes(x.st.state) && x.st.state;
    const info = [
      ['Hersteller', r.manufacturer], ['Modell', d.model], ['Firmware', r.sw_version], ['Hardware', r.hw_version],
      ['Seriennummer', r.serial_number], ['Kennung', ident], ['IP-Adresse', this._ip(d)],
      ['Verbindung', ok(d.conn) && this._plain(d.conn.st)], ['Letzte Antwort', d.lastResp && (this._time(d.lastResp.st) || ok(d.lastResp))],
      ['Raum', d.area], ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const used = new Set([d.program, d.delay, ...d.options, ...d.switches].filter(Boolean));
    const cat = { state: [], meas: [], diag: [] };
    const btns = [];
    const extra = [];
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (used.has(x)) continue;
      if (dom === 'button') { btns.push(x); continue; }
      if (x.ent.entity_category === 'diagnostic' || x === d.diag || x === d.alarm || x === d.fwUpdate) cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else if (['select', 'number', 'switch', 'time'].includes(dom)) extra.push(x);
      else cat.state.push(x);
    }
    const lock = !d.online || d.active;
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      let right;
      if (dom === 'switch') right = `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) || lock ? 'disabled' : ''}></button>`;
      else if (dom === 'select') right = this._selectHtml(x, BAD.includes(x.st.state) || lock);
      else if (dom === 'number') {
        const a = x.st.attributes;
        right = `<span class="v"><input type="number" data-act="number" data-e="${x.id}" min="${a.min ?? 0}" max="${a.max ?? 100}" step="${a.step ?? 1}"
          value="${esc(this._num(x) ?? '')}" ${BAD.includes(x.st.state) || lock ? 'disabled' : ''}> ${esc(a.unit_of_measurement || '')}</span>`;
      } else if (x.st.attributes.device_class === 'timestamp') right = `<span class="v">${esc(this._time(x.st) || this._date(x.st) || '–')}</span>`;
      else right = `<span class="v">${this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const ctrl = [d.program, ...d.options, ...d.switches, d.delay, ...extra].filter(Boolean);
    const controls = ctrl.length ? `<h4>Bedienung${lock && d.active ? ' (gesperrt, solange ein Programm läuft)' : ''}</h4>${ctrl.map(ent).join('')}` : '';
    const acts = btns.length ? `<h4>Aktionen</h4><div class="acts">${btns.sort(sortL).map((b) => `<button class="fbtn" data-act="press" data-e="${b.id}"
      data-c="${esc(`${b.label} auf ${d.name} ausführen?`)}" ${d.online ? '' : 'disabled'}><ha-icon icon="${esc(b.st.attributes.icon || 'mdi:gesture-tap-button')}"></ha-icon>${esc(b.label)}</button>`).join('')}</div>` : '';
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${this._deviceIcon(d)}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${controls}${acts}
          ${sec('Zustände', cat.state)}${sec('Messwerte', cat.meas)}${sec('Diagnose', cat.diag)}
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
    root.host.style.setProperty('--lmc-min', `${this._config.min_width}px`);
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
    }[this._sort];
    // Geräte mit Störung stehen immer oben
    const fault = (d) => d.warnings.some((w) => w.cls === 'err');
    list.sort((a, b) => (fault(b) - fault(a)) || cmp(a, b));

    const online = all.filter((d) => d.online).length;
    const active = all.filter((d) => d.active).length;
    const faults = all.filter(fault).length;
    const warn = all.filter((d) => d.warnings.length).length;
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Gerät${all.length === 1 ? '' : 'e'}</span><span>${online} online</span>
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
    const ms = d.machine?.st.state;
    if (d.machine) {
      const fault = d.warnings.some((w) => w.cls === 'err');
      const cls = fault ? 'err' : d.active ? 'act' : '';
      rows.push(row(d.machine, 'Status', `<ha-icon icon="${STATE_ICON[ms] || 'mdi:information-outline'}"></ha-icon>${esc(this._txt(d.machine, STATE_DE))}`, cls));
    }
    if (d.program) {
      const lock = !d.online || d.active || BAD.includes(d.program.st.state);
      rows.push(row(d.program, 'Programm', this._selectHtml(d.program, lock)));
    }
    const ph = d.phase?.st.state;
    if (d.active && d.phase && !BAD.includes(ph) && !['idle', 'none'].includes(ph)) rows.push(row(d.phase, 'Phase', esc(this._txt(d.phase, PHASE_DE))));
    const prog = this._num(d.progress);
    const remain = this._num(d.remaining);
    if (d.active && (prog != null || remain != null)) {
      const end = this._time(d.endTime?.st);
      const target = d.progress || d.remaining;
      rows.push(`<div class="prog" data-more="${target.id}">
          <div class="bar"><i style="width:${Math.max(0, Math.min(100, prog ?? 0))}%"></i></div>
          <div class="txt"><span>${prog != null ? `${Math.round(prog)} %` : ''}</span>
          <span>${remain != null ? `noch ${fmtMin(remain)}` : ''}${end ? ` · fertig ${esc(end)}` : ''}</span></div></div>`);
    } else if (d.program) {
      // im Ruhezustand: gewählte Einstellungen kompakt in einer Zeile
      const set = [...d.options.map((o) => (BAD.includes(o.st.state) ? '' : this._option(o))),
        ...d.switches.filter((s) => s.st.state === 'on').map((s) => s.label)].filter(Boolean);
      if (set.length) rows.push(row(d.options[0] || d.program, 'Einstellung', `<span title="${esc(set.join(' · '))}">${esc(set.join(' · '))}</span>`));
      if (remain != null && remain > 0) rows.push(row(d.remaining, 'Dauer', `<ha-icon icon="mdi:timer-outline"></ha-icon>${fmtMin(remain)}`));
    }
    const delay = this._num(d.delay);
    if (delay) rows.push(row(d.delay, 'Startvorwahl', `<ha-icon icon="mdi:timer-sand"></ha-icon>${esc(this._plain(d.delay.st))}`, 'act'));
    for (const t of d.temps) {
      if (this._num(t) == null) continue;
      rows.push(row(t, t.label, `<ha-icon icon="mdi:thermometer"></ha-icon>${this._val(t.st)}`));
    }
    const due = this._num(d.drumDue);
    if (due != null) {
      const w = due <= Number(this._config.drum_clean_warn);
      rows.push(row(d.drumDue, 'Trommelreinigung', w ? 'fällig' : `in ${due} Wäsche${due === 1 ? '' : 'n'}`, w ? 'warn' : ''));
    }
    for (const t of d.totals) rows.push(row(t, t.label, this._val(t.st)));

    const chips = [];
    const chip = (item, cls, icon, text) => `<span class="chip ${cls}" data-more="${item.id}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    for (const w of d.warnings) chips.push(chip(w.item, w.cls, w.icon, w.text));
    if (d.door?.st.state === 'on') chips.push(chip(d.door, 'warn', 'mdi:door-open', 'Tür offen'));
    if (d.remote) chips.push(d.remote.st.state === 'on'
      ? chip(d.remote, 'ok', 'mdi:cellphone-check', 'Fernstart bereit')
      : chip(d.remote, '', 'mdi:cellphone-off', 'Fernstart aus'));
    if (d.childLock?.st.state === 'on') chips.push(chip(d.childLock, '', 'mdi:lock-outline', 'Kindersicherung'));

    const ip = this._ip(d);
    const btn = (item, icon, text, title, confirm = '', enabled = true) => (item
      ? `<button class="fbtn" data-act="press" data-e="${item.id}" data-c="${esc(confirm)}" title="${esc(title)}" ${d.online && enabled ? '' : 'disabled'}><ha-icon icon="${icon}"></ha-icon>${text}</button>`
      : '');
    const canStart = !d.isRunning && (!d.remote || d.remote.st.state === 'on');
    const pwr = d.power ? (d.power.st.state === 'on' ? 'Ein' : 'Aus') : '';
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          ${ip ? `<span class="k">IP</span><span class="v">${esc(ip)} <button class="iconbtn" data-act="copy" data-v="${esc(ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button></span>` : ''}
          <span class="k">Modell</span><span class="v">${esc(d.model || '–')}${d.sw ? ` <span style="color:var(--secondary-text-color)">· FW ${esc(d.sw)}</span>` : ''}</span>`,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: `
          ${pwr ? `<span class="fbtn" style="cursor:default" ${d.power ? `data-more="${d.power.id}"` : ''}><ha-icon icon="mdi:power"></ha-icon>${pwr}</span>` : ''}
          <span class="sp"></span>
          ${!d.isRunning ? btn(d.paused ? d.btnResume || d.btnStart : d.btnStart, 'mdi:play', d.paused ? 'Fortsetzen' : 'Start',
            d.paused ? 'Programm fortsetzen' : 'Programm starten', d.paused ? '' : `Programm auf ${d.name} starten?`, canStart) : ''}
          ${d.isRunning ? btn(d.btnPause, 'mdi:pause', 'Pause', 'Programm pausieren') : ''}
          ${d.isRunning || d.paused ? btn(d.btnStop, 'mdi:stop', 'Stopp', 'Programm abbrechen', `Laufendes Programm auf ${d.name} wirklich abbrechen?`) : ''}`,
    };
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
    if (btn) {
      e.stopPropagation();
      if (btn.disabled || btn.tagName === 'SELECT' || btn.tagName === 'INPUT') return;
      this._action(btn.dataset);
      return;
    }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  _onChange(e) {
    const el = e.composedPath()[0];
    if (!el || !el.dataset) return;
    if (el.tagName === 'SELECT' && el.dataset.act === 'select') {
      e.stopPropagation();
      this._action({ act: 'select', e: el.dataset.e, v: el.value });
    } else if (el.tagName === 'INPUT' && el.dataset.act === 'number') {
      e.stopPropagation();
      this._action({ act: 'number', e: el.dataset.e, v: el.value });
    }
  }

  async _action(ds) {
    const hass = this._hass;
    const [domain] = (ds.e || '').split('.');
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain, 'toggle', { entity_id: ds.e }); break;
        case 'select': await hass.callService('select', 'select_option', { entity_id: ds.e, option: ds.v }); break;
        case 'number': await hass.callService('number', 'set_value', { entity_id: ds.e, value: Number(ds.v) }); break;
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

if (!customElements.get('localthings-manager-card')) {
  customElements.define('localthings-manager-card', LocalThingsManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'localthings-manager-card', name: 'LocalThings Manager', description: 'Alle Samsung-Geräte der LocalThings-Integration im Stil des ioBroker Device Managers' });
  console.info(`%c LOCALTHINGS-MANAGER-CARD %c ${VERSION} `, 'background:#1428a0;color:#fff', 'background:#eee;color:#333');
}
