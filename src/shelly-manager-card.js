/*
 * Shelly Manager Card – Geräteübersicht im Stil des ioBroker Device Managers.
 * Liest alle Geräte der Shelly-Integration live aus der Geräte-/Entitäts-Registry,
 * neue Shellies erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:shelly-manager-card
 *   integration: shelly        # Plattform der Entitäten
 *   show_beta: false           # Beta-Firmware-Updates berücksichtigen
 *   min_width: 300             # Mindestbreite einer Gerätekarte in px
 *   history_hours: 24          # Leistungsverlauf im Hintergrund der Messwerte, 0 = aus
 *   icon_base: /local/images/shelly   # Ordner mit den Gerätebildern (= /config/www/images/shelly)
 *   icon_map: { "S3SW-001P8EU": "shelly1pmminig3" }  # optionale Zuordnung Modell/Modell-ID -> Bilddatei
 */
const VERSION = '1.4.0';
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

// ioBroker-Icon-Name aus dem HA-Modellnamen ableiten: "Shelly 1PM Mini Gen3" -> "shelly1pmminig3"
const IOB_ICON = (model = '') => model.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/gen(\d)/g, 'g$1');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MODEL_ICON = (model = '', dev) => {
  const m = model.toLowerCase();
  if (dev.lights.length || m.includes('rgbw') || m.includes('dimmer')) return 'mdi:led-strip-variant';
  if (m.includes('camera')) return 'mdi:cctv';
  if (m.includes('plug')) return 'mdi:power-socket-de';
  if (dev.covers.length) return 'mdi:window-shutter';
  if (m.includes('pm mini') && !dev.controls.length) return 'mdi:meter-electric-outline';
  return 'mdi:electric-switch';
};

class ShellyManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      integration: 'shelly', show_beta: false, min_width: 240,
      icon_base: '/local/images/shelly', icon_map: {}, history_hours: 24, ...config,
    };
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
  static getStubConfig() { return { integration: 'shelly' }; }

  set hass(hass) {
    this._hass = hass;
    const devices = this._collect();
    if (!this._histTs && devices.length) setTimeout(() => this._fetchHistory(), 0);
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  connectedCallback() {
    // Verlauf läuft auch ohne Zustandsänderung weiter
    clearInterval(this._tick);
    this._tick = setInterval(() => this._fetchHistory(), 60000);
  }

  /* ---------- Leistungsverlauf (Hintergrund der Messwerte) ---------- */
  async _fetchHistory() {
    const hours = Number(this._config.history_hours) || 0;
    if (!hours || !this._hass || !this.isConnected || this._histBusy) return;
    if (Date.now() - (this._histTs || 0) < HISTORY_REFRESH_MS) return;
    const ids = (this._devices || []).flatMap((d) => d.power.map((p) => p.id));
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
      console.info('shelly-manager-card: Verlauf nicht abrufbar', err);
    } finally {
      this._histTs = Date.now();
      this._histBusy = false;
      this._renderGrid();
    }
  }

  /** Summe aller Leistungssensoren eines Geräts als Treppenkurve: [{ t, v }] (v = null: kein Wert) */
  _powerSeries(d) {
    if (!this._hist || !this._histStart || !d.power.length) return null;
    const events = [];
    d.power.forEach((p, i) => {
      for (const r of this._hist[p.id] || []) {
        const v = parseFloat(r.s);
        events.push({ t: Math.max(this._histStart, (r.lu ?? r.lc ?? 0) * 1000), i, v: Number.isFinite(v) ? v : null });
      }
    });
    if (!events.length) return null;
    events.sort((a, b) => a.t - b.t);
    const cur = new Array(d.power.length).fill(null);
    const out = [];
    for (const e of events) {
      cur[e.i] = e.v;
      const known = cur.filter((v) => v != null);
      const v = known.length ? known.reduce((a, b) => a + b, 0) : null;
      const last = out[out.length - 1];
      if (last && last.t === e.t) last.v = v; else out.push({ t: e.t, v });
    }
    return out;
  }

  _chartHtml(d) {
    const pts = this._powerSeries(d);
    if (!pts) return '';
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
        modelId: reg.model_id || '',
        sw: (reg.sw_version || '').split('/').pop(),
        area: reg.area_id && hass.areas?.[reg.area_id]?.name || '',
        url: reg.configuration_url || '',
        ip: '',
        controls: [], lights: [], covers: [], power: [], energy: null, temp: null,
        rssi: null, uptime: null, cloud: null, reboot: null, fw: null, problems: [],
        online: true, sig: '', reg, all: [], extra: [],
      };
      try { d.ip = d.url ? new URL(d.url).hostname : ''; } catch (e) { /* ignore */ }
      if (!d.ip) {
        const c = (reg.connections || []).find((x) => x[0] === 'ip');
        if (c) d.ip = c[1];
      }
      const sigParts = [];
      let unavailable = 0, total = 0;
      for (const ent of ents) {
        const st = hass.states[ent.entity_id];
        if (!st) continue;
        total++;
        if (st.state === 'unavailable') unavailable++;
        const domain = ent.entity_id.split('.')[0];
        const dc = st.attributes.device_class;
        const tk = ent.translation_key || '';
        const id = ent.entity_id;
        const label = this._label(ent, st, d.name);
        const item = { id, label, st, ent };
        d.all.push(item);
        switch (domain) {
          case 'switch':
            if (ent.entity_category) break; // Konfig-Schalter (z. B. MQTT Update) ausblenden
            d.controls.push(item); sigParts.push(id + st.state); break;
          case 'light': d.lights.push(item); sigParts.push(id + st.state); break;
          case 'cover': d.covers.push(item); sigParts.push(id + st.state + (st.attributes.current_position ?? '')); break;
          case 'sensor':
            if (dc === 'power') { d.power.push(item); sigParts.push(id + st.state); }
            else if (dc === 'energy' && !/einspeisung|returned|ret_/i.test(id + tk) && !/verbrauch$/i.test(id)) {
              if (!d.energy || id.length < d.energy.id.length) d.energy = item;
            } else if (dc === 'temperature') { if (!d.temp) { d.temp = item; sigParts.push(id + st.state); } }
            else if (dc === 'signal_strength') { d.rssi = item; sigParts.push(id + st.state); }
            else if (dc === 'timestamp' && /betriebszeit|uptime/i.test(id + tk)) { d.uptime = item; }
            break;
          case 'binary_sensor':
            if (/_cloud$/.test(id) || tk === 'cloud') { d.cloud = item; sigParts.push(id + st.state); }
            else if ((dc === 'problem' || /neustart_erforderlich|restart_required/.test(id + tk)) && st.state === 'on') {
              d.problems.push(item); sigParts.push(id + st.state);
            }
            break;
          case 'button':
            if (dc === 'restart' || /neu_starten|reboot/.test(id + tk)) d.reboot = item;
            break;
          case 'update': {
            const beta = /beta/.test(id + tk);
            if (beta && !this._config.show_beta) break;
            const avail = st.state === 'on';
            if (!d.fw || (avail && d.fw.st.state !== 'on')) d.fw = { ...item, beta };
            sigParts.push(id + st.state + (st.attributes.in_progress ? 'p' : ''));
            break;
          }
          default: break;
        }
      }
      d.online = total > 0 && unavailable < total && !(d.rssi && d.rssi.st.state === 'unavailable');
      if (d.energy) sigParts.push(d.energy.id + d.energy.st.state);
      const used = new Set([...d.controls, ...d.lights, ...d.covers, ...d.power, ...d.problems,
        d.energy, d.temp, d.rssi, d.uptime, d.cloud, d.reboot, d.fw].filter(Boolean).map((x) => x.id));
      d.extra = d.all.filter((x) => !used.has(x.id));
      d.sig = sigParts.join('|') + d.online;
      out.push(d);
    }
    return out;
  }

  _label(ent, st, devName) {
    let n = ent.name || st.attributes.friendly_name || ent.entity_id;
    if (n.startsWith(devName)) n = n.slice(devName.length).trim();
    return n || devName;
  }

  _fmt(st, digits) {
    if (!st || ['unavailable', 'unknown'].includes(st.state)) return '–';
    const v = parseFloat(st.state);
    const unit = st.attributes.unit_of_measurement || '';
    if (Number.isNaN(v)) return esc(st.state);
    const d = digits ?? (unit === 'W' ? 1 : unit === 'kWh' ? 2 : 1);
    return `${v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })} ${esc(unit)}`;
  }

  _uptime(st) {
    if (!st || !st.state || ['unavailable', 'unknown'].includes(st.state)) return '';
    const ms = Date.now() - new Date(st.state).getTime();
    if (Number.isNaN(ms) || ms < 0) return '';
    const days = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
    return days ? `${days} d ${h} h` : `${h} h ${Math.floor((ms % 3600000) / 60000)} min`;
  }

  _rssiIcon(st) {
    const v = st ? parseFloat(st.state) : NaN;
    if (Number.isNaN(v)) return 'mdi:wifi-strength-off-outline';
    if (v >= -55) return 'mdi:wifi-strength-4';
    if (v >= -65) return 'mdi:wifi-strength-3';
    if (v >= -75) return 'mdi:wifi-strength-2';
    return 'mdi:wifi-strength-1';
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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--smc-min, 300px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .ico img { width:30px; height:30px; object-fit:contain; }
        .ico img + ha-icon { display:none; }
        .ico img.fail { display:none; }
        .ico img.fail + ha-icon { display:block; }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
        .dlg-h img { width:40px; height:40px; object-fit:contain; }
        .dlg-web { display:flex; align-items:center; justify-content:center; gap:8px; margin: 0 20px 8px; padding:8px; border-radius:8px;
          color: var(--primary-color); text-decoration:none; font-weight:500; border:1px solid var(--divider-color); }
        .dlg-web:hover { background: var(--secondary-background-color); }
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
        .dot { position:absolute; right:-3px; bottom:-3px; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:15px; font-weight:600; line-height:1.2; flex:1; min-width:0; }
        .name small { display:block; font-size:11px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .iconbtn.warn { color: var(--warning-color, #ffa600); }
        .iconbtn.accent { color: var(--primary-color); }
        .iconbtn[disabled] { opacity:.35; cursor:default; }
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:12px; row-gap:1px; font-size:12px; }
        .meta .k { color: var(--secondary-text-color); }
        .meta .v { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .meta ha-icon { --mdc-icon-size:14px; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; }
        .chip ha-icon { --mdc-icon-size:14px; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
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
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .cover { display:flex; gap:4px; }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); }
        .foot .sp { flex:1; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:alpha-s-box"></ha-icon>Shelly Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="update">Update verfügbar</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="model">Modell</option>
          <option value="power">Leistung</option>
          <option value="rssi">Signal</option>
          <option value="ip">IP</option>
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
    root.getElementById('grid').addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('fail');
    }, true);
  }

  _iconSrc(d) {
    const name = this._config.icon_map[d.model] || this._config.icon_map[d.modelId] || IOB_ICON(d.model);
    return name.startsWith('http') || name.startsWith('/') || name.startsWith('data:') ? name : `${this._config.icon_base}/${name}.png`;
  }

  _openInfo(id) {
    this._infoId = id;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._renderInfo();
  }

  disconnectedCallback() { if (this._dlgHost) this._closeInfo(); clearInterval(this._tick); }
  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    return this._fmt(st);
  }

  _renderInfo() {
    const host = this._dlg;
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { host.innerHTML = ''; return; }
    const r = d.reg || {};
    const mac = (r.connections || []).find((c) => c[0] === 'mac');
    const ident = (r.identifiers || []).map((i) => i[1]).join(', ');
    const via = r.via_device_id && this._hass.devices[r.via_device_id];
    const info = [
      ['Hersteller', r.manufacturer], ['Modell', d.model], ['Modell-ID', d.modelId], ['Hardware', r.hw_version],
      ['Firmware', r.sw_version], ['Seriennummer', r.serial_number], ['MAC', mac && mac[1]], ['Kennung', ident],
      ['IP-Adresse', d.ip], ['Raum', d.area], ['Verbunden über', via && (via.name_by_user || via.name)],
      ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const cat = { meas: [], state: [], diag: [], conf: [] };
    for (const x of d.extra) {
      const dom = x.id.split('.')[0];
      if (['event', 'camera'].includes(dom)) continue;
      if (x.ent.entity_category === 'config') cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic' || dom === 'update' || dom === 'button') cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      const right = dom === 'switch'
        ? `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}"></button>`
        : `<span class="v">${this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><img src="${esc(this._iconSrc(d))}" onerror="this.style.display='none'"><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        ${d.url ? `<a class="dlg-web" href="${esc(d.url)}" target="_blank" rel="noopener"><ha-icon icon="mdi:web"></ha-icon>Weboberfläche des Geräts öffnen</a>` : ''}
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${sec('Messwerte', cat.meas)}${sec('Zustände', cat.state)}${sec('Konfiguration', cat.conf)}${sec('Diagnose', cat.diag)}
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

  _powerSum(d) { return d.power.reduce((s, p) => s + (parseFloat(p.st.state) || 0), 0); }

  _renderGrid() {
    const root = this.shadowRoot;
    if (!root || !this._devices) return;
    root.host.style.setProperty('--smc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    let list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model} ${d.ip}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'update': return d.fw && d.fw.st.state === 'on';
        case 'problem': return d.problems.length > 0;
        default: return true;
      }
    });
    const ipNum = (ip) => ip.split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'de'),
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || a.name.localeCompare(b.name, 'de'),
      model: (a, b) => a.model.localeCompare(b.model) || a.name.localeCompare(b.name, 'de'),
      power: (a, b) => this._powerSum(b) - this._powerSum(a),
      rssi: (a, b) => (parseFloat(b.rssi?.st.state) || -999) - (parseFloat(a.rssi?.st.state) || -999),
      ip: (a, b) => ipNum(a.ip) - ipNum(b.ip),
    }[this._sort];
    list.sort(cmp);

    const online = all.filter((d) => d.online).length;
    const updates = all.filter((d) => d.fw && d.fw.st.state === 'on').length;
    const warn = all.filter((d) => d.problems.length).length;
    const totalPower = all.reduce((s, d) => s + this._powerSum(d), 0);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      ${updates ? `<span>${updates} Update${updates > 1 ? 's' : ''} verfügbar</span>` : ''}
      ${warn ? `<span>${warn} mit Warnung</span>` : ''}
      <span>Σ ${totalPower.toLocaleString('de-DE', { maximumFractionDigits: 1 })} W</span>`;

    this._patchGrid(list);
  }

  /* Kacheln bleiben bestehen; nur geänderte Bereiche werden ersetzt (kein Neuladen der Bilder). */
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
        <div class="meta"></div><div class="chips"></div>
        <div class="rowsbox"><div class="chart"></div><div class="rows"></div></div><div class="foot"></div>`;
      c = this._cards[d.id] = {
        el, img: el.querySelector('img'), icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'),
        meta: el.querySelector('.meta'), chips: el.querySelector('.chips'), rows: el.querySelector('.rows'),
        chart: el.querySelector('.chart'),
        foot: el.querySelector('.foot'), last: {},
      };
    }
    const parts = this._deviceParts(d);
    const cls = `dev${d.online ? '' : ' offline'}${window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''}`;
    if (c.el.className !== cls) c.el.className = cls;
    const src = this._iconSrc(d);
    if (c.last.src !== src) { c.img.classList.remove('fail'); c.img.src = src; c.last.src = src; }
    const mi = MODEL_ICON(d.model, d);
    if (c.icon.getAttribute('icon') !== mi) c.icon.setAttribute('icon', mi);
    for (const k of ['name', 'meta', 'chips', 'rows', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    const chartKey = `${this._histTs || 0}|${d.power.map((p) => p.id).join(',')}`;
    if (c.last.chartKey !== chartKey) { c.chart.innerHTML = this._chartHtml(d); c.last.chartKey = chartKey; }
    c.chips.style.display = parts.chips ? '' : 'none';
    return c.el;
  }

  _deviceParts(d) {
    const rows = [];
    for (const c of d.controls) rows.push(this._toggleRow(c, d));
    for (const c of d.lights) {
      const b = c.st.attributes.brightness;
      const extra = c.st.state === 'on' && b != null ? ` <span class="val">${Math.round(b / 2.55)} %</span>` : '';
      rows.push(this._toggleRow(c, d, extra));
    }
    for (const c of d.covers) {
      const pos = c.st.attributes.current_position;
      rows.push(`<div class="row" data-more="${c.id}"><span class="lbl">${esc(c.label)}${pos != null ? ` · ${pos} %` : ''}</span>
        <span class="cover">
          <button class="iconbtn" data-act="cover_open" data-e="${c.id}" title="Öffnen"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="iconbtn" data-act="cover_stop" data-e="${c.id}" title="Stopp"><ha-icon icon="mdi:stop"></ha-icon></button>
          <button class="iconbtn" data-act="cover_close" data-e="${c.id}" title="Schließen"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
        </span></div>`);
    }
    for (const p of d.power) {
      rows.push(`<div class="row" data-more="${p.id}"><span class="lbl">${esc(p.label)}</span><span class="val">${this._fmt(p.st)}</span></div>`);
    }
    if (d.energy) rows.push(`<div class="row" data-more="${d.energy.id}"><span class="lbl">${esc(d.energy.label)}</span><span class="val">${this._fmt(d.energy.st)}</span></div>`);
    if (d.temp) rows.push(`<div class="row" data-more="${d.temp.id}"><span class="lbl">Temperatur</span><span class="val">${this._fmt(d.temp.st, 1)}</span></div>`);

    const chips = [];
    for (const p of d.problems) chips.push(`<span class="chip err" data-more="${p.id}"><ha-icon icon="mdi:alert"></ha-icon>${esc(p.label)}</span>`);
    if (d.fw && d.fw.st.state === 'on') {
      const v = d.fw.st.attributes.latest_version || '';
      chips.push(`<span class="chip warn" data-more="${d.fw.id}"><ha-icon icon="mdi:package-up"></ha-icon>Update ${esc(v.split('/').pop())}</span>`);
    }
    if (d.fw?.st.attributes.in_progress) chips.push('<span class="chip warn"><ha-icon icon="mdi:progress-download"></ha-icon>Update läuft</span>');
    if (d.cloud) chips.push(d.cloud.st.state === 'on'
      ? '<span class="chip ok"><ha-icon icon="mdi:cloud-check-outline"></ha-icon>Cloud</span>'
      : '<span class="chip"><ha-icon icon="mdi:cloud-off-outline"></ha-icon>Cloud aus</span>');
    const up = this._uptime(d.uptime?.st);
    if (up) chips.push(`<span class="chip"><ha-icon icon="mdi:timer-outline"></ha-icon>${up}</span>`);

    const rssiVal = d.rssi ? this._fmt(d.rssi.st, 0) : '–';
    const fwAvail = d.fw && d.fw.st.state === 'on' && !d.fw.st.attributes.in_progress;
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          <span class="k">Signal</span><span class="v"><ha-icon icon="${this._rssiIcon(d.rssi?.st)}"></ha-icon>${rssiVal}</span>
          <span class="k">IP</span><span class="v">${d.ip ? `${esc(d.ip)} <button class="iconbtn" data-act="copy" data-v="${esc(d.ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button>` : '–'}</span>
          <span class="k">Modell</span><span class="v">${esc(d.model)}${d.modelId ? ` <span style="color:var(--secondary-text-color)">(${esc(d.modelId)})</span>` : ''}</span>
          <span class="k">Firmware</span><span class="v">${esc(d.sw || '–')}</span>`,
      chips: chips.join(''),
      rows: rows.join(''),
      foot: `
          <button class="iconbtn" data-act="web" data-v="${esc(d.url)}" title="Weboberfläche öffnen" ${d.url ? '' : 'disabled'}><ha-icon icon="mdi:open-in-new"></ha-icon></button>
          <span class="sp"></span>
          <button class="iconbtn ${fwAvail ? 'warn' : ''}" data-act="update" data-e="${d.fw?.id || ''}" title="${fwAvail ? 'Firmware-Update installieren' : 'Firmware aktuell'}" ${fwAvail ? '' : 'disabled'}><ha-icon icon="mdi:update"></ha-icon></button>
          <button class="iconbtn" data-act="reboot" data-e="${d.reboot?.id || ''}" data-n="${esc(d.name)}" title="Neu starten" ${d.reboot && d.online ? '' : 'disabled'}><ha-icon icon="mdi:restart"></ha-icon></button>`,
    };
  }

  _toggleRow(c, d, extra = '') {
    const on = c.st.state === 'on';
    const dis = ['unavailable', 'unknown'].includes(c.st.state);
    return `<div class="row" data-more="${c.id}"><span class="lbl">${esc(c.label)}${extra}</span>
      <button class="tog ${on ? 'on' : ''}" data-act="toggle" data-e="${c.id}" ${dis ? 'disabled' : ''} title="${on ? 'Ausschalten' : 'Einschalten'}"></button></div>`;
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
        case 'cover_open': await hass.callService('cover', 'open_cover', { entity_id: ds.e }); break;
        case 'cover_stop': await hass.callService('cover', 'stop_cover', { entity_id: ds.e }); break;
        case 'cover_close': await hass.callService('cover', 'close_cover', { entity_id: ds.e }); break;
        case 'reboot':
          if (window.confirm(`${ds.n} neu starten?`)) await hass.callService('button', 'press', { entity_id: ds.e });
          break;
        case 'update': {
          const st = hass.states[ds.e];
          const v = st?.attributes.latest_version || '';
          if (window.confirm(`Firmware ${v} auf ${st?.attributes.friendly_name || ds.e} installieren?`)) {
            await hass.callService('update', 'install', { entity_id: ds.e });
          }
          break;
        }
        case 'web': if (ds.v) window.open(ds.v, '_blank', 'noopener'); break;
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

if (!customElements.get('shelly-manager-card')) {
  customElements.define('shelly-manager-card', ShellyManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'shelly-manager-card', name: 'Shelly Manager', description: 'Alle Shelly-Geräte im Stil des ioBroker Device Managers' });
  console.info(`%c SHELLY-MANAGER-CARD %c ${VERSION} `, 'background:#4499ff;color:#fff', 'background:#eee;color:#333');
}
