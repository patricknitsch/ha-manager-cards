/*
 * Schlüter Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota-, ESPHome-, X-Sense- und Proxmox Manager Card).
 * Liest alle Schlüter-DITRA-HEAT-Thermostate (Integration OJ Microline) live aus der
 * Geräte-/Entitäts-Registry, neue Thermostate erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:schlueter-manager-card
 *   integration: ojmicroline_thermostat   # Plattform der Entitäten
 *   min_width: 320                        # Mindestbreite einer Gerätekarte in px
 *   step: 0.5                             # Schrittweite der Solltemperatur
 *   floor_max: 0                          # Warnschwelle Bodentemperatur in °C (0 = aus)
 *   history_hours: 24                     # Leistungsverlauf im Hintergrund der Messwerte, 0 = aus
 *   power: { "Bad": "sensor.xyz_leistung" } # Leistungssensor je Thermostat (Gerätename oder Geräte-ID);
 *                                         # ohne Eintrag: eindeutiger Heizungs-Leistungssensor im selben Raum, false = keiner
 *   icon_base: ''                         # Ordner mit Gerätebildern, z. B. /local/images/schlueter (leer = MDI-Icons)
 *   icon_map: { "OWD5": "ditra_heat_e_rs" }   # optionale Zuordnung Modell -> Bilddatei
 */
const VERSION = '1.1.1';
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const BAD = ['unavailable', 'unknown'];
const PRESET_DE = {
  schedule: 'Zeitplan', comfort: 'Komfort', manual: 'Manuell', vacation: 'Urlaub',
  frost_protection: 'Frostschutz', boost: 'Boost', eco: 'Eco',
};
const PRESET_ICON = {
  schedule: 'mdi:calendar-clock', comfort: 'mdi:sofa-outline', manual: 'mdi:hand-back-right-outline',
  vacation: 'mdi:beach', frost_protection: 'mdi:snowflake-thermometer', boost: 'mdi:rocket-launch-outline', eco: 'mdi:leaf',
};
const QUICK = ['schedule', 'comfort', 'boost', 'eco'];
const DAYS = [['monday', 'Mo', 'Montag'], ['tuesday', 'Di', 'Dienstag'], ['wednesday', 'Mi', 'Mittwoch'],
  ['thursday', 'Do', 'Donnerstag'], ['friday', 'Fr', 'Freitag'], ['saturday', 'Sa', 'Samstag'], ['sunday', 'So', 'Sonntag']];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const toMin = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const todayIdx = () => (new Date().getDay() + 6) % 7;

class SchlueterManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'ojmicroline_thermostat', min_width: 280, step: 0.5, floor_max: 0, history_hours: 24, power: {}, icon_base: '', icon_map: {}, ...config };
    this._filter = this._filter || '';
    this._sort = this._sort || 'name';
    this._view = this._view || 'all';
    this._pending = this._pending || {};
    this._sig = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'ojmicroline_thermostat' }; }

  set hass(hass) {
    this._hass = hass;
    const devices = this._collect();
    if (!this._histTs && devices.some((d) => d.power)) setTimeout(() => this._fetchHistory(), 0);
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig, window.__hmcAct ? window.__hmcAct(this._hass, d.id) : '']));
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  connectedCallback() {
    // "nächster Wechsel" und Restlaufzeiten laufen auch ohne Zustandsänderung weiter
    clearInterval(this._tick);
    this._tick = setInterval(() => { this._renderGrid(); this._fetchHistory(); }, 60000);
  }

  disconnectedCallback() { if (this._dlgHost) this._closeInfo(); clearInterval(this._tick); }

  /* ---------- Leistungsverlauf (Hintergrund der Messwerte) ---------- */
  async _fetchHistory() {
    const hours = Number(this._config.history_hours) || 0;
    if (!hours || !this._hass || !this.isConnected || this._histBusy) return;
    if (Date.now() - (this._histTs || 0) < HISTORY_REFRESH_MS) return;
    const ids = [...new Set((this._devices || []).filter((d) => d.power).map((d) => d.power.id))];
    if (!ids.length) return;
    this._histBusy = true;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3600000);
      const res = await this._hass.callWS({
        type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      this._hist = res || {};
      this._histStart = start.getTime();
    } catch (err) {
      console.info('schlueter-manager-card: Verlauf nicht abrufbar', err);
    } finally {
      this._histTs = Date.now();
      this._histBusy = false;
      this._renderGrid();
    }
  }

  _chartHtml(d) {
    if (!d.power || !this._hist || !this._histStart) return '';
    const rows = this._hist[d.power.id] || [];
    const pts = rows.map((r) => {
      const v = parseFloat(r.s);
      return { t: Math.max(this._histStart, (r.lu ?? r.lc ?? 0) * 1000), v: Number.isFinite(v) ? v : null };
    });
    if (!pts.length) return '';
    const start = this._histStart, end = Math.max(this._histTs || Date.now(), start + 60000), span = end - start;
    const vals = pts.map((p) => p.v).filter((v) => v != null);
    const hi = Math.max(...vals, 0);
    if (!(hi > 0)) return '';
    const top = hi * 1.15;
    const W = 1000, H = 100;
    const x = (t) => (((t - start) / span) * W).toFixed(1);
    const y = (v) => (H - (v / top) * H).toFixed(1);
    const segs = [];
    let sg = null;
    pts.forEach((p, i) => {
      const to = i + 1 < pts.length ? pts[i + 1].t : end;
      if (p.v == null) { sg = null; return; }
      if (to <= p.t) return;
      if (!sg) { sg = { x0: x(p.t), y0: y(p.v), d: '' }; segs.push(sg); } else sg.d += `V${y(p.v)}`;
      sg.d += `H${x(to)}`;
    });
    const line = segs.map((q) => `M${q.x0},${q.y0}${q.d}`).join('');
    const area = segs.map((q) => `M${q.x0},${H}V${q.y0}${q.d}V${H}Z`).join('');
    const peak = hi.toLocaleString('de-DE', { maximumFractionDigits: hi < 10 ? 1 : 0 });
    return `<svg class="pchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="pa" d="${area}"/><path class="pl" d="${line}"/></svg>
      <span class="ppeak" title="Höchstwert der letzten ${Number(this._config.history_hours)} h">max ${peak} W</span>`;
  }

  /** Leistungssensor zum Thermostat: aus der Konfiguration oder eindeutig über Raum + Name */
  _resolvePower(d) {
    const hass = this._hass;
    const map = this._config.power || {};
    const cfg = map[d.id] ?? map[d.name] ?? map[d.reg.name];
    if (cfg === false || cfg === '') return null;
    let id = cfg;
    if (!id) {
      if (!d.reg.area_id) return null;
      const cands = Object.values(hass.entities).filter((e) => {
        if (e.platform === this._config.integration || e.hidden) return false;
        const st = hass.states[e.entity_id];
        if (!st || st.attributes.device_class !== 'power') return false;
        const dev = e.device_id && hass.devices[e.device_id];
        if ((e.area_id || dev?.area_id) !== d.reg.area_id) return false;
        return /heizung|fussboden|floor|ditra/.test(slug(`${e.name || ''} ${dev?.name_by_user || dev?.name || ''}`));
      });
      if (cands.length !== 1) return null;
      id = cands[0].entity_id;
    }
    const st = hass.states[id];
    if (!st) return null;
    return { id, label: 'Leistung', st, ent: hass.entities[id] || {} };
  }

  _powerVal(d) { return d.power ? this._num(d.power) : null; }

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
        climate: null, room: null, floor: null, setp: null, rmin: null, rmax: null, energy: null, smode: null,
        boostEnd: null, comfortEnd: null, vacBegin: null, vacEnd: null, schedule: null,
        conn: null, heating: null, adaptive: null, window: null, swVac: null, dVacBegin: null, dVacEnd: null,
        warnings: [], online: true, heatingOn: false, preset: '', sig: '', reg, all: [],
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
          case 'climate': d.climate = item; break;
          case 'sensor':
            if (/range.?min|bereich.?min|minimum/.test(key)) d.rmin = item;
            else if (/range.?max|bereich.?max|maximum/.test(key)) d.rmax = item;
            else if (/set.?point|sollwert|solltemp/.test(key)) d.setp = item;
            else if (/room|raum/.test(key)) d.room = item;
            else if (/floor|boden/.test(key)) d.floor = item;
            else if (dc === 'energy' || /energy|energie|verbrauch/.test(key)) d.energy = item;
            else if (/sensor.?mode|sensormodus|fuhler/.test(key)) d.smode = item;
            else if (/boost/.test(key)) d.boostEnd = item;
            else if (/comfort|komfort/.test(key)) d.comfortEnd = item;
            else if (/(vacation|urlaub).*(begin|start)/.test(key)) d.vacBegin = item;
            else if (/(vacation|urlaub).*(end)/.test(key)) d.vacEnd = item;
            else if (/schedule|zeitplan|wochenplan/.test(key)) d.schedule = item;
            break;
          case 'binary_sensor':
            if (dc === 'connectivity' || /online|verbunden/.test(key)) d.conn = item;
            else if (/window|fenster/.test(key)) d.window = item;
            else if (/adaptiv/.test(key)) d.adaptive = item;
            else if (dc === 'heat' || /heating|heizt|heizen/.test(key)) d.heating = item;
            break;
          case 'switch': if (/vacation|urlaub/.test(key)) d.swVac = item; break;
          case 'date':
            if (/begin|start/.test(key)) d.dVacBegin = item;
            else if (/end/.test(key)) d.dVacEnd = item;
            break;
          default: break;
        }
      }
      const ca = d.climate?.st.attributes || {};
      d.preset = ca.preset_mode || '';
      d.heatingOn = d.heating ? d.heating.st.state === 'on' : ca.hvac_action === 'heating';
      d.online = total > 0 && unavailable < total && !(d.conn && d.conn.st.state !== 'on')
        && !(d.climate && d.climate.st.state === 'unavailable');
      if (!d.online) d.warnings.push({ item: d.conn || d.climate || d.all[0], text: 'Offline', cls: 'err', icon: 'mdi:cloud-off-outline' });
      if (d.window?.st.state === 'on') d.warnings.push({ item: d.window, text: 'Fenster offen erkannt', cls: 'warn', icon: 'mdi:window-open-variant' });
      const fl = this._num(d.floor);
      if (Number(this._config.floor_max) > 0 && fl != null && fl > Number(this._config.floor_max)) {
        d.warnings.push({ item: d.floor, text: `Boden ${fmt(fl)} °C`, cls: 'warn', icon: 'mdi:thermometer-alert' });
      }
      d.power = this._resolvePower(d);
      if (d.power) d.all.push(d.power);
      d.sig = d.all.map((x) => `${x.st.state}${x.ent.entity_id.startsWith('climate.') ? JSON.stringify(x.st.attributes) : ''}`).join('|') + d.online;
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

  _roomTemp(d) {
    // eigener Raumsensor zuerst: current_temperature des Klimageräts folgt im Modus Raum/Boden dem Bodenfühler
    const r = this._num(d.room);
    if (r != null) return r;
    const v = d.climate?.st.attributes.current_temperature;
    return v != null ? Number(v) : null;
  }

  _target(d) {
    if (this._pending[d.id] != null) return this._pending[d.id].value;
    const v = d.climate?.st.attributes.temperature;
    return v != null ? Number(v) : this._num(d.setp);
  }

  _limits(d) {
    const a = d.climate?.st.attributes || {};
    return { min: Number(a.min_temp ?? this._num(d.rmin) ?? 5), max: Number(a.max_temp ?? this._num(d.rmax) ?? 40) };
  }

  /** Zustand als Klartext (übersetzt, mit Einheit) – noch nicht HTML-maskiert */
  _plain(st) {
    if (!st || BAD.includes(st.state)) return '–';
    if (typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st);
    const unit = st.attributes.unit_of_measurement;
    return unit ? `${st.state} ${unit}` : st.state;
  }

  _val(st) { return esc(this._plain(st)); }

  _until(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    if (Number.isNaN(dt.getTime()) || dt.getTime() < Date.now()) return '';
    const sameDay = dt.toDateString() === new Date().toDateString();
    return sameDay ? dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : dt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  _dateDe(st) {
    if (!st || BAD.includes(st.state) || st.state.startsWith('1970')) return '';
    const dt = new Date(st.state);
    return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('de-DE');
  }

  _days(d) {
    const a = d.schedule?.st.attributes;
    if (!a) return null;
    return DAYS.map(([k]) => (Array.isArray(a[k]) ? a[k] : []).slice().sort((x, y) => toMin(x.time) - toMin(y.time)));
  }

  /** nächster Schaltpunkt des Wochenplans */
  _nextSwitch(d) {
    const days = this._days(d);
    if (!days) return null;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const t0 = todayIdx();
    for (let i = 0; i < 8; i++) {
      const di = (t0 + i) % 7;
      for (const p of days[di]) {
        if (i === 0 && toMin(p.time) <= cur) continue;
        return { when: i === 0 ? 'heute' : i === 1 ? 'morgen' : DAYS[di][1], time: p.time, temp: Number(p.temperature) };
      }
    }
    return null;
  }

  _iconSrc(d) {
    const base = this._config.icon_base;
    const name = this._config.icon_map[d.model] || (base ? d.model.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
    if (!name) return '';
    return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${base}/${name}.png`;
  }

  _deviceIcon(d) { return d.heatingOn ? 'mdi:heating-coil' : 'mdi:heat-wave'; }

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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--smc-min, 280px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .dev.heat .ico ha-icon { color: var(--state-climate-heat-color, #ff8100); }
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
        .temps { display:grid; grid-template-columns: 1fr 1fr 1.4fr; gap:6px; padding: 2px 10px 6px; }
        .t { background: var(--secondary-background-color); border-radius:8px; padding:5px 4px; text-align:center; cursor:pointer; min-width:0; }
        .t .tv { display:block; font-size:17px; font-weight:600; font-variant-numeric: tabular-nums; white-space:nowrap; }
        .t .tl { display:block; font-size:11px; color: var(--secondary-text-color); text-transform:uppercase; letter-spacing:.04em; }
        .t.set { display:flex; align-items:center; justify-content:space-between; gap:2px; cursor:default; }
        .t.set .tv { color: var(--state-climate-heat-color, #ff8100); }
        .t.set .pend { opacity:.6; }
        .pm { background: var(--card-background-color); border:1px solid var(--divider-color); color: var(--primary-text-color);
          width:26px; height:26px; border-radius:50%; cursor:pointer; line-height:0; padding:0; flex:none; }
        .pm ha-icon { --mdc-icon-size:16px; }
        .pm:hover { border-color: var(--primary-color); }
        .pm[disabled] { opacity:.35; cursor:default; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
        .chip ha-icon { --mdc-icon-size:14px; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
        .chip.heat { background: rgba(255,129,0,.16); color: var(--state-climate-heat-color, #ff8100); }
        .rowsbox { position:relative; flex:1; display:flex; flex-direction:column; }
        .chart { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
        .pchart { position:absolute; left:0; top:0; width:100%; height:100%; }
        .pchart .pa { fill: var(--primary-color); opacity:.10; }
        .pchart .pl { fill:none; stroke: var(--primary-color); stroke-width:1.5; opacity:.4; vector-effect:non-scaling-stroke; }
        .ppeak { position:absolute; left:50%; transform:translateX(-50%); top:1px; font-size:10px; line-height:1; white-space:nowrap; color: var(--secondary-text-color); opacity:.65; }
        .rows { padding: 0 10px 6px; flex:1; position:relative; z-index:1; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:13px;
          border-top: 1px solid var(--divider-color); cursor:pointer; }
        .row:first-child { border-top:none; }
        .row .lbl { color: var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; display:flex; align-items:center; gap:4px; }
        .row .val ha-icon { --mdc-icon-size:16px; }
        .row select { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
          border-radius:8px; padding:3px 6px; font: inherit; font-size:13px; cursor:pointer; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); min-height:28px; flex-wrap:wrap; }
        .fbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:3px 6px; border-radius:8px;
          font: inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
        .fbtn ha-icon { --mdc-icon-size:16px; }
        .fbtn:hover { background: var(--divider-color); color: var(--primary-text-color); }
        .fbtn.act { color: var(--primary-color); font-weight:600; }
        .fbtn[disabled] { opacity:.35; cursor:default; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(680px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t2 { font-size:20px; font-weight:600; flex:1; }
        .dlg-h ha-icon { --mdc-icon-size:32px; color: var(--primary-color); }
        .dlg-b { overflow:auto; padding: 0 20px 16px; }
        .dlg-b h4 { margin: 14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
        .kv { display:flex; justify-content:space-between; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv:last-child { border-bottom:none; }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .week { display:grid; grid-template-columns: 90px 1fr; row-gap:4px; column-gap:8px; font-size:13px; align-items:center; }
        .week .dn { color: var(--secondary-text-color); }
        .week .dn.today { color: var(--primary-color); font-weight:700; }
        .week .pts { display:flex; flex-wrap:wrap; gap:4px; }
        .week .pt { padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); font-variant-numeric: tabular-nums; }
        .week .pt b { color: var(--state-climate-heat-color, #ff8100); font-weight:600; }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:heat-wave"></ha-icon>Schlüter Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="heating">Heizt</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="room">Raumtemperatur</option>
          <option value="floor">Bodentemperatur</option>
          <option value="energy">Energie</option>
          <option value="power">Leistung</option>
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
    const grid = root.getElementById('grid');
    grid.addEventListener('click', (e) => this._onClick(e));
    grid.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset?.act === 'preset') this._setPreset(t.dataset.e, t.value);
    });
    this._dlg.addEventListener('click', (e) => {
      if (e.target.classList?.contains('dlg-bg')) { this._closeInfo(); return; }
      const path = e.composedPath();
      if (!path.some((el) => el.dataset && el.dataset.act)) {
        const more = path.find((el) => el.dataset && el.dataset.more);
        if (more) { this._closeInfo(); this._fire('hass-more-info', { entityId: more.dataset.more }); return; }
      }
      this._onClick(e);
    });
    grid.addEventListener('load', (e) => {
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
    const ident = (r.identifiers || []).map((i) => i[1]).join(', ');
    const lim = this._limits(d);
    const info = [
      ['Hersteller', r.manufacturer], ['Modell', d.model], ['Hardware', r.hw_version], ['Firmware', r.sw_version],
      ['Seriennummer', r.serial_number], ['Kennung', ident], ['Raum', d.area],
      ['Sensormodus', d.smode && this._plain(d.smode.st)],
      ['Temperaturbereich', `${fmt(lim.min)} – ${fmt(lim.max)} °C`],
      ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const days = this._days(d);
    const t0 = todayIdx();
    const week = days ? `<h4>Wochenplan</h4><div class="week">${DAYS.map(([, , long], i) => `
        <span class="dn ${i === t0 ? 'today' : ''}">${long}</span>
        <span class="pts">${days[i].length ? days[i].map((p) => `<span class="pt">${esc(p.time)} <b>${fmt(Number(p.temperature))}°</b></span>`).join('') : '<span class="pt">–</span>'}</span>`).join('')}
      </div>` : '';
    const cat = { state: [], meas: [], conf: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (dom === 'climate') continue;
      if (x.ent.entity_category === 'config' || ['number', 'select', 'switch', 'date'].includes(dom)) cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic') cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      const right = dom === 'switch'
        ? `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}></button>`
        : `<span class="v">${dom === 'date' ? esc(this._dateDe(x.st) || '–') : this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${this._deviceIcon(d)}"></ha-icon><span class="t2">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${week}
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
    root.host.style.setProperty('--smc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model} ${PRESET_DE[d.preset] || ''}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'heating': return d.heatingOn;
        case 'problem': return d.warnings.length > 0;
        default: return true;
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'de');
    const n = (v, dflt) => (v == null ? dflt : v);
    const cmp = {
      name: byName,
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || byName(a, b),
      room: (a, b) => n(this._roomTemp(a), 999) - n(this._roomTemp(b), 999) || byName(a, b),
      floor: (a, b) => n(this._num(b.floor), -999) - n(this._num(a.floor), -999) || byName(a, b),
      energy: (a, b) => n(this._num(b.energy), -1) - n(this._num(a.energy), -1) || byName(a, b),
      power: (a, b) => n(this._powerVal(b), -1) - n(this._powerVal(a), -1) || byName(a, b),
    }[this._sort];
    list.sort(cmp);

    const online = all.filter((d) => d.online).length;
    const heating = all.filter((d) => d.heatingOn).length;
    const warn = all.filter((d) => d.warnings.length).length;
    const energies = all.map((d) => this._num(d.energy)).filter((v) => v != null);
    const powers = all.map((d) => this._powerVal(d)).filter((v) => v != null);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Gerät${all.length === 1 ? '' : 'e'}</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      <span>${heating} heizt</span>
      ${warn ? `<span>${warn} mit Warnung</span>` : ''}
      ${powers.length ? `<span>Σ ${fmt(powers.reduce((s, v) => s + v, 0), 0)} W</span>` : ''}
      ${energies.length ? `<span>Energie gesamt ${fmt(energies.reduce((s, v) => s + v, 0), 2)} kWh</span>` : ''}`;

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
        <div class="temps"></div><div class="chips"></div>
        <div class="rowsbox"><div class="chart"></div><div class="rows"></div></div><div class="foot"></div>`;
      c = this._cards[d.id] = {
        el, img: el.querySelector('img'), icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'),
        temps: el.querySelector('.temps'), chips: el.querySelector('.chips'), rows: el.querySelector('.rows'),
        chart: el.querySelector('.chart'),
        foot: el.querySelector('.foot'), last: {},
      };
    }
    const parts = this._deviceParts(d);
    const cls = `dev${d.online ? '' : ' offline'}${d.heatingOn ? ' heat' : ''}${window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''}`;
    if (c.el.className !== cls) c.el.className = cls;
    const src = this._iconSrc(d);
    if (c.last.src !== src) {
      c.img.classList.remove('on');
      if (src) c.img.src = src; else c.img.removeAttribute('src');
      c.last.src = src;
    }
    const mi = this._deviceIcon(d);
    if (c.icon.getAttribute('icon') !== mi) c.icon.setAttribute('icon', mi);
    for (const k of ['name', 'temps', 'chips', 'rows', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    const chartKey = `${this._histTs || 0}|${d.power?.id || ''}`;
    if (c.last.chartKey !== chartKey) { c.chart.innerHTML = this._chartHtml(d); c.last.chartKey = chartKey; }
    c.chips.style.display = parts.chips ? '' : 'none';
    return c.el;
  }

  _deviceParts(d) {
    const ce = d.climate?.id || '';
    const ca = d.climate?.st.attributes || {};
    const dis = d.online && ce ? '' : 'disabled';
    const lim = this._limits(d);
    const target = this._target(d);
    const pend = this._pending[d.id] != null;
    const room = this._roomTemp(d);
    const floor = this._num(d.floor);
    const tile = (item, v, l) => `<div class="t" ${item ? `data-more="${item.id}"` : ''}><span class="tv">${fmt(v)} °C</span><span class="tl">${l}</span></div>`;
    const temps = `
      ${tile(d.room || d.climate, room, 'Raum')}
      ${tile(d.floor, floor, 'Boden')}
      <div class="t set">
        <button class="pm" data-act="step" data-d="${d.id}" data-s="-1" ${dis || (target != null && target <= lim.min ? 'disabled' : '')} title="Solltemperatur senken"><ha-icon icon="mdi:minus"></ha-icon></button>
        <span ${ce ? `data-more="${ce}" style="cursor:pointer"` : ''}><span class="tv ${pend ? 'pend' : ''}">${fmt(target)} °C</span><span class="tl">Soll</span></span>
        <button class="pm" data-act="step" data-d="${d.id}" data-s="1" ${dis || (target != null && target >= lim.max ? 'disabled' : '')} title="Solltemperatur erhöhen"><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>`;

    const chips = [];
    const chip = (item, c, icon, text) => `<span class="chip ${c}" ${item ? `data-more="${item.id}"` : ''}><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    for (const w of d.warnings) chips.push(chip(w.item, w.cls, w.icon, w.text));
    if (d.online) chips.push(d.heatingOn ? chip(d.heating || d.climate, 'heat', 'mdi:fire', 'Heizt') : chip(d.heating || d.climate, '', 'mdi:fire-off', 'Heizt nicht'));
    if (d.preset) chips.push(chip(d.climate, d.preset === 'frost_protection' || d.preset === 'vacation' ? 'warn' : '', PRESET_ICON[d.preset] || 'mdi:thermostat', PRESET_DE[d.preset] || d.preset));
    if (d.adaptive?.st.state === 'on') chips.push(chip(d.adaptive, 'ok', 'mdi:brain', 'Adaptiv'));
    if (d.swVac?.st.state === 'on') chips.push(chip(d.swVac, 'warn', 'mdi:beach', 'Urlaub aktiv'));

    const row = (item, label, val) => `<div class="row" ${item ? `data-more="${item.id}"` : ''}><span class="lbl">${esc(label)}</span><span class="val">${val}</span></div>`;
    const rows = [];
    const modes = ca.preset_modes || [];
    if (ce && modes.length) {
      const opts = modes.map((m) => `<option value="${esc(m)}" ${m === d.preset ? 'selected' : ''}>${esc(PRESET_DE[m] || m)}</option>`).join('');
      rows.push(`<div class="row"><span class="lbl">Betriebsart</span><span class="val"><select data-act="preset" data-e="${ce}" ${dis}>${opts}</select></span></div>`);
    }
    if (d.preset === 'schedule') {
      const nx = this._nextSwitch(d);
      if (nx) rows.push(row(d.schedule, 'Nächster Wechsel', `<ha-icon icon="mdi:clock-outline"></ha-icon>${esc(nx.when)} ${esc(nx.time)} → ${fmt(nx.temp)} °C`));
    }
    const boost = this._until(d.boostEnd?.st);
    if (d.preset === 'boost' && boost) rows.push(row(d.boostEnd, 'Boost bis', esc(boost)));
    const comfort = this._until(d.comfortEnd?.st);
    if (d.preset === 'comfort' && comfort) rows.push(row(d.comfortEnd, 'Komfort bis', esc(comfort)));
    if (d.power) rows.push(row(d.power, 'Leistung', `<ha-icon icon="mdi:flash-outline"></ha-icon>${BAD.includes(d.power.st.state) ? '–' : `${fmt(this._num(d.power), 1)} W`}`));
    if (d.energy) rows.push(row(d.energy, 'Energie', `<ha-icon icon="mdi:lightning-bolt-outline"></ha-icon>${this._val(d.energy.st)}`));
    if (d.smode) rows.push(row(d.smode, 'Sensormodus', this._val(d.smode.st)));
    if (d.swVac) {
      const range = [this._dateDe(d.dVacBegin?.st), this._dateDe(d.dVacEnd?.st)].filter(Boolean).join(' – ');
      rows.push(`<div class="row" data-more="${d.swVac.id}"><span class="lbl">Urlaub${range ? ` (${esc(range)})` : ''}</span><span class="val">
        <button class="tog ${d.swVac.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${d.swVac.id}" ${BAD.includes(d.swVac.st.state) ? 'disabled' : ''}></button></span></div>`);
    }

    const qb = (m) => (modes.includes(m)
      ? `<button class="fbtn ${d.preset === m ? 'act' : ''}" data-act="quick" data-e="${ce}" data-m="${m}" title="${esc(PRESET_DE[m])} aktivieren" ${dis}><ha-icon icon="${PRESET_ICON[m]}"></ha-icon>${esc(PRESET_DE[m])}</button>`
      : '');
    return {
      name: `${esc(d.name)}<small>${esc([d.area || 'kein Raum', d.model, d.sw && `FW ${d.sw}`].filter(Boolean).join(' · '))}</small>`,
      temps,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: QUICK.map(qb).join(''),
    };
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
    if (btn) {
      if (btn.tagName === 'SELECT') return;
      e.stopPropagation();
      if (btn.disabled) return;
      this._action(btn.dataset);
      return;
    }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  _step(devId, dir) {
    const d = (this._devices || []).find((x) => x.id === devId);
    if (!d || !d.climate) return;
    const step = Number(this._config.step) || 0.5;
    const lim = this._limits(d);
    const cur = this._target(d) ?? lim.min;
    const value = Math.min(lim.max, Math.max(lim.min, Math.round((cur + dir * step) / step) * step));
    const p = this._pending[devId] || {};
    clearTimeout(p.timer);
    // Klicks sammeln und erst nach kurzer Pause senden (Cloud-API, nicht jeden Klick einzeln)
    p.value = value;
    p.timer = setTimeout(async () => {
      try {
        await this._hass.callService('climate', 'set_temperature', { entity_id: d.climate.id, temperature: value });
        this._fire('hass-notification', { message: `${d.name}: Soll ${fmt(value)} °C` });
      } catch (err) {
        this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
      } finally {
        delete this._pending[devId];
        this._sig = '';
        this._renderGrid();
      }
    }, 900);
    this._pending[devId] = p;
    this._renderGrid();
  }

  async _setPreset(entityId, mode) {
    try {
      await this._hass.callService('climate', 'set_preset_mode', { entity_id: entityId, preset_mode: mode });
      this._fire('hass-notification', { message: `Betriebsart: ${PRESET_DE[mode] || mode}` });
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
      this._sig = '';
      this._renderGrid();
    }
  }

  async _action(ds) {
    const hass = this._hass;
    const [domain] = (ds.e || '').split('.');
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain, 'toggle', { entity_id: ds.e }); break;
        case 'step': this._step(ds.d, Number(ds.s)); break;
        case 'quick': await this._setPreset(ds.e, ds.m); break;
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

if (!customElements.get('schlueter-manager-card')) {
  customElements.define('schlueter-manager-card', SchlueterManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'schlueter-manager-card', name: 'Schlüter Manager', description: 'Alle Schlüter-DITRA-HEAT-Thermostate im Stil des ioBroker Device Managers' });
  console.info(`%c SCHLUETER-MANAGER-CARD %c ${VERSION} `, 'background:#ff8100;color:#fff', 'background:#eee;color:#333');
}
