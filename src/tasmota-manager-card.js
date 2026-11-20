/*
 * Tasmota Manager Card – Geräteübersicht im Stil des ioBroker Device Managers (Gegenstück zur Shelly Manager Card).
 * Liest alle Geräte der Tasmota-Integration live aus der Geräte-/Entitäts-Registry, neue Geräte erscheinen automatisch.
 *
 * Zusätzlich über MQTT (WebSocket mqtt/subscribe, daher nur für Admins):
 *   - tasmota/discovery/<MAC>/config  -> Topic, Modul, Hostname je Gerät
 *   - tele/<topic>/LWT               -> Online/Offline
 *   - stat/<topic>/+                 -> Status-0-Antworten (Gerätedetails), Upgrade-Fortschritt, Konsolenantworten
 * Firmware-Updates: die neueste Tasmota-Version kommt von GitHub (arendst/Tasmota, Cache 6 h),
 * installiert wird mit "Upgrade 1" (das Gerät lädt die Firmware von seiner eigenen OtaUrl).
 *
 * Konfiguration (alle optional):
 *   type: custom:tasmota-manager-card
 *   integration: tasmota          # Plattform der Entitäten
 *   discovery_prefix: tasmota     # Präfix der Tasmota-Discovery
 *   check_updates: true           # neueste Version bei GitHub abfragen
 *   latest_version: "16.0.0"      # feste Vergleichsversion statt GitHub
 *   min_width: 300                # Mindestbreite einer Gerätekarte in px
 *   history_hours: 24             # Leistungsverlauf im Hintergrund der Leistungswerte, 0 = aus
 */
const VERSION = '1.1.0';
const RELEASE_URL = 'https://api.github.com/repos/arendst/Tasmota/releases/latest';
const RELEASE_CACHE_KEY = 'tasmota-manager-card.latest';
const RELEASE_CACHE_MS = 6 * 3600 * 1000;
const UPDATE_TIMEOUT_MS = 6 * 60 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const macKey = (m) => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
const BAD = ['unavailable', 'unknown'];

/** "16.0.0(release-tasmota32)" / "v16.0.0" -> [16,0,0,0] */
const parseVersion = (v) => {
  const m = typeof v === 'string' ? v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/) : null;
  return m ? [m[1], m[2], m[3], m[4] || '0'].map((n) => parseInt(n, 10)) : null;
};
/** Ist `available` neuer als `installed`? Ein Entwicklungs-Build (4. Stelle) gilt als neuer als das gleichnamige Release. */
const isNewer = (available, installed) => {
  const a = parseVersion(available), b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const DEVICE_ICON = (d) => {
  const n = `${d.name} ${d.module}`.toLowerCase();
  if (n.includes('nspanel')) return 'mdi:tablet-dashboard';
  if (d.covers.length) return 'mdi:window-shutter';
  if (d.lights.length) return 'mdi:lightbulb-outline';
  if (d.fans.length) return 'mdi:fan';
  if (d.power.length || /plug|pow|messdose|steckdose/.test(n)) return 'mdi:power-socket-de';
  if (!d.controls.length && d.temps.length) return 'mdi:thermometer';
  return 'mdi:electric-switch';
};

class TasmotaManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      integration: 'tasmota', discovery_prefix: 'tasmota', check_updates: true,
      latest_version: null, min_width: 300, history_hours: 24, ...config,
    };
    this._filter = this._filter || '';
    this._sort = this._sort || 'name';
    this._view = this._view || 'all';
    this._sig = '';
    this._disc = this._disc || {};   // MAC -> Discovery-Config
    this._lwt = this._lwt || {};     // MAC -> 'Online' | 'Offline'
    this._status = this._status || {}; // MAC -> zusammengeführte Status-0-Antwort
    this._upd = this._upd || {};     // MAC -> { from, text, start, failed }
    this._last = this._last || {};   // MAC -> letzte Konsolenantwort
    this._subs = this._subs || {};   // Topic -> Unsubscribe-Promise
    this._hist = this._hist || {};   // Leistungs-Entität -> Verlaufszeilen
    this._histTs = this._histTs || 0;
    this._chartCache = {};
    if (this._config.latest_version) this._latest = String(this._config.latest_version);
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'tasmota' }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._started && hass.connection) {
      this._started = true;
      this._subscribe(`${this._config.discovery_prefix}/discovery/+/config`, (m) => this._onDiscovery(m));
      this._fetchLatest();
    }
    this._refresh();
    this._fetchHistory();
  }

  connectedCallback() {
    // nach einem Seitenwechsel wieder anmelden
    if (this._hass && !this._started) this.hass = this._hass;
    // Verlauf läuft auch ohne Zustandsänderung weiter
    clearInterval(this._tick);
    this._tick = setInterval(() => this._fetchHistory(), 60000);
  }

  disconnectedCallback() {
    if (this._dlgHost) this._closeInfo();
    for (const p of Object.values(this._subs)) p.then((u) => u && u()).catch(() => {});
    this._subs = {};
    this._started = false;
    this._subscribedDevs = {};
    clearInterval(this._tick);
  }

  _refresh(force = false) {
    if (!this._hass) return;
    const devices = this._collect();
    this._devices = devices;
    for (const d of devices) this._ensureDeviceSubs(d);
    if (this._infoId) this._renderInfo();
    const sig = JSON.stringify([this._latest, this._histTs, devices.map((d) => [d.id, d.name, d.area, d.sig, window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''])]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  /* ---------- MQTT ---------- */
  _subscribe(topic, cb) {
    if (this._subs[topic]) return;
    this._subs[topic] = this._hass.connection
      .subscribeMessage((msg) => cb(msg), { type: 'mqtt/subscribe', topic })
      .catch((err) => {
        console.warn(`tasmota-manager-card: Abo ${topic} fehlgeschlagen`, err);
        this._mqttError = err.message || String(err);
        delete this._subs[topic];
        this._renderGrid();
        return null;
      });
  }

  _json(payload) {
    if (typeof payload !== 'string') return payload && typeof payload === 'object' ? payload : null;
    try { return JSON.parse(payload); } catch (e) { return null; }
  }

  _onDiscovery(msg) {
    const cfg = this._json(msg.payload);
    const mac = macKey(cfg?.mac || msg.topic.split('/').slice(-2, -1)[0]);
    if (!cfg || !mac) return;
    this._disc[mac] = cfg;
    this._refresh(true);
  }

  /** Vollständiges Topic eines Geräts, prefix 0 = cmnd, 1 = stat, 2 = tele */
  _topic(mac, prefixIdx, cmd = '') {
    const c = this._disc[mac];
    if (!c || !c.t) return null;
    const tp = c.tp || ['cmnd', 'stat', 'tele'];
    const ft = c.ft || '%prefix%/%topic%/';
    return ft.replace('%prefix%', tp[prefixIdx]).replace('%topic%', c.t).replace('%hostname%', c.hn || '')
      .replace('%id%', mac.slice(-6)) + cmd;
  }

  _ensureDeviceSubs(d) {
    if (!d.mac || !this._disc[d.mac]) return;
    this._subscribedDevs = this._subscribedDevs || {};
    if (this._subscribedDevs[d.mac]) return;
    this._subscribedDevs[d.mac] = true;
    const mac = d.mac;
    this._subscribe(this._topic(mac, 2, 'LWT'), (m) => {
      this._lwt[mac] = String(m.payload).trim();
      this._refresh(true);
    });
    this._subscribe(this._topic(mac, 1, '+'), (m) => this._onStat(mac, m));
  }

  _onStat(mac, m) {
    const sub = m.topic.split('/').pop();
    const data = this._json(m.payload);
    if (/^STATUS\d*$/.test(sub) && data) {
      this._status[mac] = { ...(this._status[mac] || {}), ...data };
      if (this._infoMac === mac) this._renderInfo();
      return;
    }
    if (sub === 'RESULT' || sub === 'UPGRADE') {
      if (data && data.Upgrade !== undefined && this._upd[mac]) {
        const text = String(data.Upgrade);
        this._upd[mac].text = text;
        if (/fail|abort|error|fehl/i.test(text)) this._upd[mac].failed = true;
        this._refresh(true);
      }
      if (this._waitConsole === mac) {
        this._last[mac] = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
        this._renderInfo();
      }
    }
  }

  async _publish(mac, cmd, payload = '') {
    const topic = this._topic(mac, 0, cmd);
    if (!topic) throw new Error('MQTT-Topic des Geräts unbekannt (keine Tasmota-Discovery empfangen)');
    await this._hass.callService('mqtt', 'publish', { topic, payload: String(payload) });
  }

  /* ---------- neueste Firmware ---------- */
  async _fetchLatest() {
    if (this._config.latest_version || !this._config.check_updates) return;
    try {
      const cached = JSON.parse(localStorage.getItem(RELEASE_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < RELEASE_CACHE_MS && parseVersion(cached.v)) {
        this._latest = cached.v;
        this._refresh(true);
        return;
      }
    } catch (e) { /* kein localStorage */ }
    try {
      const res = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const rel = await res.json();
      const v = parseVersion(rel.tag_name);
      if (!v) throw new Error(`unbekannte Version ${rel.tag_name}`);
      this._latest = v.slice(0, 3).join('.');
      try { localStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ v: this._latest, ts: Date.now() })); } catch (e) { /* egal */ }
      this._refresh(true);
    } catch (err) {
      console.info('tasmota-manager-card: neueste Tasmota-Version nicht abrufbar', err);
    }
  }

  /* ---------- Leistungsverlauf ---------- */
  _mainPower(d) {
    return d.power.find((p) => p.st.attributes.unit_of_measurement === 'W') || null;
  }

  async _fetchHistory() {
    const hours = Number(this._config.history_hours) || 0;
    if (!hours || !this._hass || !this.isConnected || this._histBusy) return;
    if (Date.now() - this._histTs < HISTORY_REFRESH_MS) return;
    const ids = (this._devices || []).map((d) => this._mainPower(d)?.id).filter(Boolean);
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
      console.info('tasmota-manager-card: Leistungsverlauf nicht abrufbar', err);
    } finally {
      this._histTs = Date.now();
      this._histBusy = false;
      this._chartCache = {};
      this._refresh(true);
    }
  }

  /** Leistungsverlauf als Hintergrund der Leistungswerte: Fläche + Linie, je Bildspalte der Höchstwert (kurze Spitzen bleiben sichtbar) */
  _powerChartHtml(d) {
    const p = this._mainPower(d);
    const rows = p && this._hist[p.id];
    if (!rows || !rows.length || !this._histStart) return '';
    const key = `${this._histTs}|${p.st.last_updated}`;
    const hit = this._chartCache[p.id];
    if (hit && hit.key === key) return hit.html;
    const start = this._histStart, end = Math.max(Date.now(), start + 60000), span = end - start;
    const pts = rows.map((r) => ({ t: Math.max(start, (r.lu ?? r.lc ?? 0) * 1000), v: parseFloat(r.s) }));
    const liveT = new Date(p.st.last_updated).getTime();
    if (liveT > pts[pts.length - 1].t) pts.push({ t: liveT, v: parseFloat(p.st.state) });
    const W = 1000, H = 100;
    const col = new Array(W).fill(NaN);
    const xi = (t) => Math.min(W - 1, Math.max(0, Math.floor(((t - start) / span) * W)));
    pts.forEach((pt, i) => {
      const to = i + 1 < pts.length ? pts[i + 1].t : end;
      if (!Number.isFinite(pt.v) || to <= pt.t) return;
      const x1 = Math.max(xi(pt.t), xi(to) - (to < end ? 1 : 0));
      for (let x = xi(pt.t); x <= x1; x++) if (!(col[x] >= pt.v)) col[x] = pt.v;
    });
    const max = Math.max(0, ...col.filter(Number.isFinite));
    const hi = Math.max(max * 1.2, 10);
    const y = (v) => (H - (v / hi) * H).toFixed(1);
    let area = '', line = '', open = false;
    for (let x = 0; x < W; x++) {
      const v = col[x];
      if (!Number.isFinite(v)) {
        if (open) { area += `V${H}Z`; open = false; }
        continue;
      }
      if (!open) { area += `M${x},${H}V${y(v)}H${x + 1}`; line += `M${x},${y(v)}H${x + 1}`; open = true; }
      else { area += `V${y(v)}H${x + 1}`; line += `V${y(v)}H${x + 1}`; }
    }
    if (open) area += `V${H}Z`;
    const html = area ? `<svg class="pchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="pa" d="${area}"/><path class="pl" d="${line}"/></svg>` : '';
    this._chartCache[p.id] = { key, html, max };
    return html;
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
      const macConn = (reg.connections || []).find((c) => c[0] === 'mac');
      const mac = macKey(macConn && macConn[1]);
      const disc = this._disc[mac] || {};
      const d = {
        id: devId, mac, reg, disc,
        name: (reg.name_by_user || reg.name || devId).trim(),
        module: disc.md || '',
        topic: disc.t || '',
        hostname: disc.hn || '',
        area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '',
        sw: reg.sw_version || '',
        ip: disc.ip || '',
        controls: [], lights: [], covers: [], fans: [], power: [], today: null, total: null, temps: [],
        signal: null, rssiPct: null, fw: null, restart: null, reason: null, ssid: null,
        online: true, sig: '', all: [], extra: [],
      };
      const sigParts = [];
      let unavailable = 0, total = 0;
      for (const ent of ents) {
        const st = hass.states[ent.entity_id];
        if (!st) continue;
        total++;
        if (st.state === 'unavailable') unavailable++;
        const id = ent.entity_id;
        const domain = id.split('.')[0];
        const dc = st.attributes.device_class;
        const item = { id, label: this._label(ent, st, d.name), st, ent };
        d.all.push(item);
        switch (domain) {
          case 'switch':
            if (ent.entity_category) break;
            d.controls.push(item); sigParts.push(id + st.state); break;
          case 'light': d.lights.push(item); sigParts.push(id + st.state + (st.attributes.brightness ?? '')); break;
          case 'fan': d.fans.push(item); sigParts.push(id + st.state); break;
          case 'cover': d.covers.push(item); sigParts.push(id + st.state + (st.attributes.current_position ?? '')); break;
          case 'sensor':
            if (/_firmware_version$/.test(id)) { d.fw = item; sigParts.push(id + st.state); }
            else if (/_ip$/.test(id)) { if (!BAD.includes(st.state)) d.ip = st.state; d.ipEnt = item; }
            else if (/_last_restart_time$/.test(id)) { d.restart = item; }
            else if (/_restart_reason$/.test(id)) { d.reason = item; }
            else if (/_ssid$/.test(id)) { d.ssid = item; }
            else if (/_signal$/.test(id) || (dc === 'signal_strength' && st.attributes.unit_of_measurement === 'dBm')) { d.signal = item; sigParts.push(id + st.state); }
            else if (/_rssi$/.test(id)) { d.rssiPct = item; }
            else if (dc === 'power') { d.power.push(item); sigParts.push(id + st.state); }
            else if (dc === 'energy' && /_today$/.test(id)) { d.today = item; sigParts.push(id + st.state); }
            else if (dc === 'energy' && /_total$/.test(id)) { d.total = item; }
            else if (dc === 'temperature') { d.temps.push(item); sigParts.push(id + st.state); }
            break;
          default: break;
        }
      }
      if (!d.sw && d.fw && !BAD.includes(d.fw.st.state)) d.sw = d.fw.st.state;
      // "16.0.0(release-tasmota32)" -> Version und Build-Variante
      const fwState = d.fw && !BAD.includes(d.fw.st.state) ? d.fw.st.state : (disc.sw || d.sw);
      d.swFull = fwState || '';
      d.variant = (String(fwState).match(/\(([^)]+)\)/) || [])[1] || '';
      const lwt = this._lwt[mac];
      d.online = lwt ? !/offline/i.test(lwt) : total > 0 && unavailable < total;
      d.update = !!(this._latest && d.online && isNewer(this._latest, d.swFull));
      // Laufendes Update abschließen, sobald eine neue Version gemeldet wird
      const u = this._upd[mac];
      if (u) {
        if (d.swFull && d.swFull !== u.from && !isNewer(this._latest, d.swFull)) {
          delete this._upd[mac];
          this._toast(`${d.name}: Firmware ${d.swFull} installiert`);
        } else if (Date.now() - u.start > UPDATE_TIMEOUT_MS) {
          u.failed = true;
          u.text = u.text || 'keine Rückmeldung';
        }
      }
      d.upd = this._upd[mac] || null;
      const used = new Set([...d.controls, ...d.lights, ...d.fans, ...d.covers, ...d.power, ...d.temps,
        d.today, d.total, d.signal, d.rssiPct, d.fw, d.restart, d.reason, d.ssid, d.ipEnt].filter(Boolean).map((x) => x.id));
      d.extra = d.all.filter((x) => !used.has(x.id));
      d.sig = `${sigParts.join('|')}${d.online}${d.update}${lwt}${d.topic}${d.upd ? d.upd.text + d.upd.failed : ''}${d.restart?.st.state}`;
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
    if (!st || BAD.includes(st.state)) return '–';
    const v = parseFloat(st.state);
    const unit = st.attributes.unit_of_measurement || '';
    if (Number.isNaN(v)) return esc(st.state);
    const d = digits ?? (unit === 'W' ? 1 : unit === 'kWh' ? 2 : 1);
    return `${v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })} ${esc(unit)}`;
  }

  _since(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!iso || Number.isNaN(ms) || ms < 0) return '';
    const days = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
    return days ? `${days} d ${h} h` : `${h} h ${Math.floor((ms % 3600000) / 60000)} min`;
  }

  _rssiIcon(v) {
    if (v == null || Number.isNaN(v)) return 'mdi:wifi-strength-off-outline';
    if (v >= -55) return 'mdi:wifi-strength-4';
    if (v >= -65) return 'mdi:wifi-strength-3';
    if (v >= -75) return 'mdi:wifi-strength-2';
    return 'mdi:wifi-strength-1';
  }

  _dbm(d) {
    const v = d.signal ? parseFloat(d.signal.st.state) : NaN;
    if (!Number.isNaN(v)) return v;
    const w = this._status[d.mac]?.StatusSTS?.Wifi?.Signal;
    return typeof w === 'number' ? w : NaN;
  }

  _toast(message) { this._fire('hass-notification', { message }); }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; padding:12px; box-sizing:border-box; }
        .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px;
          background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px); margin-bottom:12px; }
        .toolbar .title { font-size:20px; font-weight:500; margin-right:auto; display:flex; align-items:center; gap:8px; }
        .toolbar input, .toolbar select, .toolbar .tb { background: rgba(255,255,255,.12); color: inherit; border: 1px solid rgba(255,255,255,.3);
          border-radius: 8px; padding: 6px 10px; font: inherit; font-size:14px; }
        .toolbar .tb { cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
        .toolbar .tb ha-icon { --mdc-icon-size:18px; }
        .toolbar select option { color: var(--primary-text-color); background: var(--card-background-color); }
        .toolbar input::placeholder { color: rgba(255,255,255,.7); }
        .stats { font-size:13px; opacity:.9; width:100%; display:flex; gap:16px; flex-wrap:wrap; }
        .notice { margin-bottom:12px; padding:10px 14px; border-radius:10px; font-size:13px;
          background: rgba(255,166,0,.15); color: var(--primary-text-color); }
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--tmc-min, 300px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .dot { position:absolute; right:-3px; bottom:-3px; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:15px; font-weight:600; line-height:1.2; flex:1; min-width:0; overflow-wrap:anywhere; }
        .name small { display:block; font-size:11px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .iconbtn.warn { color: var(--warning-color, #ffa600); }
        .iconbtn[disabled] { opacity:.35; cursor:default; }
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:12px; row-gap:1px; font-size:12px; }
        .meta .k { color: var(--secondary-text-color); }
        .meta .v { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .meta ha-icon { --mdc-icon-size:14px; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .chip ha-icon { --mdc-icon-size:14px; flex:none; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); cursor:pointer; }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
        .rows { padding: 0 10px 6px; flex:1; }
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
        .pwr { position:relative; min-height:56px; }
        .rows > .pwr:not(:first-child) { border-top: 1px solid var(--divider-color); }
        .pwr .row { position:relative; z-index:1; }
        .pchart { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; }
        .pchart .pa { fill: var(--primary-color); opacity:.10; }
        .pchart .pl { fill:none; stroke: var(--primary-color); stroke-width:1.5; opacity:.4; vector-effect:non-scaling-stroke; }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color);
          background: var(--secondary-background-color); }
        .foot .sp { flex:1; }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); font-family: var(--paper-font-body1_-_font-family, inherit); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
        .dlg-h ha-icon { --mdc-icon-size:30px; color: var(--primary-color); }
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
        .hint { font-size:12px; color: var(--secondary-text-color); padding:4px 0; }
        .console { display:flex; gap:8px; margin-top:6px; }
        .console input { flex:1; background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
          border-radius:8px; padding:6px 10px; font: inherit; font-family: var(--code-font-family, monospace); }
        .out { margin-top:6px; padding:8px; border-radius:8px; background: var(--secondary-background-color); font-family: var(--code-font-family, monospace);
          font-size:12px; white-space:pre-wrap; word-break:break-all; max-height:160px; overflow:auto; }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
        .btn.sec { background: var(--secondary-background-color); color: var(--primary-text-color); }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:alpha-t-box"></ha-icon>Tasmota Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="update">Update verfügbar</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="module">Modul</option>
          <option value="power">Leistung</option>
          <option value="rssi">Signal</option>
          <option value="ip">IP</option>
        </select>
        <span id="updall"></span>
        <div class="stats" id="stats"></div>
      </div>
      <div id="notice"></div>
      <div class="grid" id="grid"></div>`;
    // Dialog hängt am body, damit position:fixed nicht vom Dashboard-Layout eingeschränkt wird
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${this.shadowRoot.querySelector('style').textContent}</style><div id="dlg"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('dlg');
    const root = this.shadowRoot;
    root.getElementById('q').addEventListener('input', (e) => { this._filter = e.target.value.toLowerCase(); this._renderGrid(); });
    root.getElementById('view').addEventListener('change', (e) => { this._view = e.target.value; this._renderGrid(); });
    root.getElementById('sort').addEventListener('change', (e) => { this._sort = e.target.value; this._renderGrid(); });
    root.getElementById('grid').addEventListener('click', (e) => this._onClick(e));
    root.getElementById('updall').addEventListener('click', (e) => this._onClick(e));
    this._dlg.addEventListener('click', (e) => {
      if (e.target.classList?.contains('dlg-bg')) { this._closeInfo(); return; }
      const path = e.composedPath();
      if (!path.some((el) => el.dataset && el.dataset.act)) {
        const more = path.find((el) => el.dataset && el.dataset.more);
        if (more) { this._closeInfo(); this._fire('hass-more-info', { entityId: more.dataset.more }); return; }
      }
      this._onClick(e);
    });
    this._dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'cmd') this._action({ act: 'console' });
      if (e.key === 'Escape') this._closeInfo();
    });
  }

  _openInfo(id) {
    this._infoId = id;
    const d = (this._devices || []).find((x) => x.id === id);
    this._infoMac = d?.mac || null;
    this._last[this._infoMac] = '';
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._infoHtml = '';
    this._renderInfo();
    // Gerätedetails wie im ioBroker Device Manager: "Status 0" liefert Netzwerk, Firmware, Laufzeit …
    if (d && d.online && this._disc[d.mac]) this._publish(d.mac, 'Status', '0').catch(() => {});
  }

  _closeInfo() {
    this._infoId = null; this._infoMac = null; this._waitConsole = null; this._infoHtml = '';
    this._dlg.innerHTML = '';
    this._dlgHost.remove();
  }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    return this._fmt(st);
  }

  _renderInfo() {
    const host = this._dlg;
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { host.innerHTML = ''; return; }
    const s = this._status[d.mac] || {};
    const net = s.StatusNET || {}, fwr = s.StatusFWR || {}, prm = s.StatusPRM || {}, st0 = s.Status || {}, sts = s.StatusSTS || {};
    const macFmt = d.mac ? d.mac.match(/../g).join(':') : '';
    const rssi = sts.Wifi?.RSSI ?? (d.rssiPct && !BAD.includes(d.rssiPct.st.state) ? d.rssiPct.st.state : '');
    const info = [
      ['Geräte-ID', d.topic], ['Hostname', net.Hostname || d.hostname], ['Gerätename', st0.DeviceName],
      ['Modul', d.module], ['IP-Adresse', net.IPAddress || d.ip], ['MAC-Adresse', net.Mac || macFmt],
      ['Gateway', net.Gateway], ['Subnetzmaske', net.Subnetmask], ['WLAN', sts.Wifi?.SSId || (d.ssid && d.ssid.st.state)],
      ['Hardware', fwr.Hardware], ['Build-Datum', fwr.BuildDateTime], ['Core', fwr.Core], ['SDK', fwr.SDK],
      ['Firmware-Version', fwr.Version || d.swFull], ['Neueste Version', this._latest],
      ['RSSI', rssi !== '' ? `${rssi} %` : ''], ['Signal', Number.isNaN(this._dbm(d)) ? '' : `${this._dbm(d)} dBm`],
      ['Laufzeit', sts.Uptime || prm.Uptime], ['Neustartgrund', prm.RestartReason || (d.reason && d.reason.st.state)],
      ['Raum', d.area], ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '' && !BAD.includes(v));
    const cat = { meas: [], state: [], diag: [], conf: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (['event', 'camera'].includes(dom)) continue;
      if (x.ent.entity_category === 'config') cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic' || x === d.fw || x === d.ipEnt || x === d.ssid || x === d.restart || x === d.reason
        || x === d.signal || x === d.rssiPct) cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      const right = ['switch', 'light', 'fan'].includes(dom)
        ? `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}"></button>`
        : `<span class="v">${this._val(x.st)}</span>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const hasTopic = !!this._disc[d.mac];
    const statusHint = !hasTopic
      ? '<div class="hint">Keine Tasmota-Discovery empfangen – Details, Konsole und Update sind nicht verfügbar.</div>'
      : (!s.StatusFWR && d.online ? '<div class="hint">Gerätedetails werden abgefragt …</div>' : '');
    const consoleOut = this._last[d.mac];
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${DEVICE_ICON(d)}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        ${d.ip ? `<a class="dlg-web" href="http://${esc(d.ip)}/" target="_blank" rel="noopener"><ha-icon icon="mdi:web"></ha-icon>Weboberfläche des Geräts öffnen</a>` : ''}
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${statusHint}
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${sec('Messwerte', cat.meas)}${sec('Zustände', cat.state)}${sec('Konfiguration', cat.conf)}${sec('Diagnose', cat.diag)}
          ${hasTopic ? `<h4>Konsole</h4>
            <div class="console"><input id="cmd" placeholder="Befehl, z. B. Status 11" autocomplete="off" spellcheck="false">
              <button class="btn" data-act="console">Senden</button></div>
            ${consoleOut ? `<div class="out">${esc(consoleOut)}</div>` : ''}` : ''}
        </div>
        <div class="dlg-f"><button class="btn" data-act="close">Schließen</button></div>
      </div></div>`;
    if (html === this._infoHtml && host.firstElementChild) return;
    // Eingabe und Scrollposition beim Neuzeichnen erhalten
    const body = host.querySelector('.dlg-b');
    const scroll = body ? body.scrollTop : 0;
    const input = host.querySelector('#cmd');
    const typed = input ? input.value : '';
    const focused = input && this._dlgHost.shadowRoot.activeElement === input;
    host.innerHTML = html;
    this._infoHtml = html;
    const nb = host.querySelector('.dlg-b');
    if (nb) nb.scrollTop = scroll;
    const ni = host.querySelector('#cmd');
    if (ni) { ni.value = typed; if (focused) ni.focus(); }
  }

  _powerSum(d) {
    return d.power.filter((p) => p.st.attributes.unit_of_measurement === 'W').reduce((s, p) => s + (parseFloat(p.st.state) || 0), 0);
  }

  _renderGrid() {
    const root = this.shadowRoot;
    if (!root || !this._devices) return;
    root.host.style.setProperty('--tmc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.module} ${d.ip} ${d.topic}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'update': return d.update;
        default: return true;
      }
    });
    const ipNum = (ip) => String(ip).split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'de'),
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || a.name.localeCompare(b.name, 'de'),
      module: (a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name, 'de'),
      power: (a, b) => this._powerSum(b) - this._powerSum(a),
      rssi: (a, b) => (this._dbm(b) || -999) - (this._dbm(a) || -999),
      ip: (a, b) => ipNum(a.ip) - ipNum(b.ip),
    }[this._sort];
    list.sort(cmp);

    const online = all.filter((d) => d.online).length;
    const updates = all.filter((d) => d.update && !d.upd).length;
    const totalPower = all.reduce((s, d) => s + this._powerSum(d), 0);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      ${updates ? `<span>${updates} Update${updates > 1 ? 's' : ''} verfügbar</span>` : ''}
      <span>Σ ${totalPower.toLocaleString('de-DE', { maximumFractionDigits: 1 })} W</span>
      <span>Tasmota ${this._latest ? `aktuell: ${esc(this._latest)}` : 'Version unbekannt'}</span>`;
    root.getElementById('updall').innerHTML = updates > 1
      ? `<button class="tb" data-act="update_all"><ha-icon icon="mdi:update"></ha-icon>Alle aktualisieren</button>` : '';
    root.getElementById('notice').innerHTML = this._mqttError
      ? `<div class="notice">MQTT-Abfrage nicht möglich (${esc(this._mqttError)}) – Online-Status, Gerätedetails und Updates
         brauchen einen Administrator und die MQTT-Integration.</div>` : '';

    root.getElementById('grid').innerHTML = list.length
      ? list.map((d) => this._deviceHtml(d)).join('')
      : '<div class="empty">Keine Geräte gefunden.</div>';
  }

  _deviceHtml(d) {
    const rows = [];
    for (const c of d.controls) rows.push(this._toggleRow(c));
    for (const c of d.fans) rows.push(this._toggleRow(c));
    for (const c of d.lights) {
      const b = c.st.attributes.brightness;
      const extra = c.st.state === 'on' && b != null ? ` <span class="val">${Math.round(b / 2.55)} %</span>` : '';
      rows.push(this._toggleRow(c, extra));
    }
    for (const c of d.covers) {
      const pos = c.st.attributes.current_position;
      // Position 0 = geschlossen, alles darüber = offen; ohne Position zählt der Zustand des Covers
      let coverState = '';
      if (pos != null) coverState = pos > 0 ? ` · ${pos} % offen` : ' · geschlossen';
      else if (c.st.state === 'open') coverState = ' · offen';
      else if (c.st.state === 'closed') coverState = ' · geschlossen';
      rows.push(`<div class="row" data-more="${c.id}"><span class="lbl">${esc(c.label)}${coverState}</span>
        <span class="cover">
          <button class="iconbtn" data-act="cover_open" data-e="${c.id}" title="Öffnen"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="iconbtn" data-act="cover_stop" data-e="${c.id}" title="Stopp"><ha-icon icon="mdi:stop"></ha-icon></button>
          <button class="iconbtn" data-act="cover_close" data-e="${c.id}" title="Schließen"><ha-icon icon="mdi:arrow-down"></ha-icon></button>
        </span></div>`);
    }
    // Leistung und Energie in einem Block, dahinter der Leistungsverlauf
    const prows = [];
    for (const p of d.power.filter((x) => x.st.attributes.unit_of_measurement === 'W')) {
      prows.push(`<div class="row" data-more="${p.id}"><span class="lbl">Leistung</span><span class="val">${this._fmt(p.st)}</span></div>`);
    }
    if (d.today) prows.push(`<div class="row" data-more="${d.today.id}"><span class="lbl">Heute</span><span class="val">${this._fmt(d.today.st, 3)}</span></div>`);
    if (d.total) prows.push(`<div class="row" data-more="${d.total.id}"><span class="lbl">Gesamt</span><span class="val">${this._fmt(d.total.st, 2)}</span></div>`);
    if (prows.length) {
      const chart = this._powerChartHtml(d);
      const peak = this._chartCache[this._mainPower(d)?.id]?.max;
      const tip = chart && peak != null ? ` title="Leistung der letzten ${Number(this._config.history_hours)} h · max ${peak.toLocaleString('de-DE', { maximumFractionDigits: 1 })} W"` : '';
      rows.push(`<div class="pwr"${tip}>${prows.join('')}${chart}</div>`);
    }
    for (const t of d.temps) {
      const lbl = /esp32|chip|cpu/i.test(t.id) ? 'Temperatur (Chip)' : /analog/i.test(t.id) ? 'Temperatur (Raum)' : t.label;
      rows.push(`<div class="row" data-more="${t.id}"><span class="lbl">${esc(lbl)}</span><span class="val">${this._fmt(t.st, 1)}</span></div>`);
    }

    const chips = [];
    if (d.upd) {
      chips.push(d.upd.failed
        ? `<span class="chip err" title="${esc(d.upd.text)}"><ha-icon icon="mdi:alert"></ha-icon>Update: ${esc(d.upd.text || 'fehlgeschlagen')}</span>`
        : `<span class="chip warn" title="${esc(d.upd.text)}"><ha-icon icon="mdi:progress-download"></ha-icon>${esc(d.upd.text || 'Update läuft …')}</span>`);
    } else if (d.update) {
      chips.push(`<span class="chip warn" data-act="update" data-d="${d.id}"><ha-icon icon="mdi:package-up"></ha-icon>Update ${esc(this._latest)}</span>`);
    }
    if (!d.online) chips.push('<span class="chip err"><ha-icon icon="mdi:lan-disconnect"></ha-icon>Offline</span>');
    const up = d.restart && !BAD.includes(d.restart.st.state) ? this._since(d.restart.st.state) : '';
    if (up && d.online) chips.push(`<span class="chip"><ha-icon icon="mdi:timer-outline"></ha-icon>${up}</span>`);
    if (d.variant) chips.push(`<span class="chip"><ha-icon icon="mdi:chip"></ha-icon>${esc(d.variant)}</span>`);

    const dbm = this._dbm(d);
    const pct = d.rssiPct && !BAD.includes(d.rssiPct.st.state) ? ` (${esc(d.rssiPct.st.state)} %)` : '';
    const sigVal = Number.isNaN(dbm) ? (pct ? pct.slice(2, -1) : '–') : `${dbm} dBm${pct}`;
    const hasTopic = !!this._disc[d.mac];
    const canUpdate = d.update && !d.upd && hasTopic;
    const fwShort = (parseVersion(d.swFull) || []).slice(0, 3).join('.') || d.swFull || '–';
    return `
      <div class="dev ${d.online ? '' : 'offline'}${window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''}">
        <div class="head">
          <div class="ico"><ha-icon icon="${DEVICE_ICON(d)}"></ha-icon><span class="dot"></span></div>
          <div class="name">${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small></div>
          <button class="iconbtn" data-act="info" data-d="${d.id}" title="Geräteinformationen"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
        </div>
        <div class="meta">
          <span class="k">Signal</span><span class="v"><ha-icon icon="${this._rssiIcon(dbm)}"></ha-icon>${sigVal}</span>
          <span class="k">IP</span><span class="v">${d.ip ? `${esc(d.ip)} <button class="iconbtn" data-act="copy" data-v="${esc(d.ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button>` : '–'}</span>
          <span class="k">Modul</span><span class="v">${esc(d.module || '–')}</span>
          <span class="k">Firmware</span><span class="v">${esc(fwShort)}</span>
        </div>
        ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
        <div class="rows">${rows.join('')}</div>
        <div class="foot">
          <button class="iconbtn" data-act="web" data-v="${d.ip ? `http://${esc(d.ip)}/` : ''}" title="Weboberfläche öffnen" ${d.ip ? '' : 'disabled'}><ha-icon icon="mdi:open-in-new"></ha-icon></button>
          <span class="sp"></span>
          <button class="iconbtn ${canUpdate ? 'warn' : ''}" data-act="update" data-d="${d.id}" title="${canUpdate ? `Firmware ${esc(this._latest)} installieren` : 'Firmware aktuell'}" ${canUpdate ? '' : 'disabled'}><ha-icon icon="mdi:update"></ha-icon></button>
          <button class="iconbtn" data-act="reboot" data-d="${d.id}" title="Neu starten" ${d.online && hasTopic ? '' : 'disabled'}><ha-icon icon="mdi:restart"></ha-icon></button>
        </div>
      </div>`;
  }

  _toggleRow(c, extra = '') {
    const on = c.st.state === 'on';
    const dis = BAD.includes(c.st.state);
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

  async _startUpdate(d) {
    await this._publish(d.mac, 'Upgrade', '1');
    this._upd[d.mac] = { from: d.swFull, text: 'Update gestartet …', start: Date.now(), failed: false };
  }

  async _action(ds) {
    const hass = this._hass;
    const [domain] = (ds.e || '').split('.');
    const d = ds.d && (this._devices || []).find((x) => x.id === ds.d);
    try {
      switch (ds.act) {
        case 'toggle': await hass.callService(domain, 'toggle', { entity_id: ds.e }); break;
        case 'cover_open': await hass.callService('cover', 'open_cover', { entity_id: ds.e }); break;
        case 'cover_stop': await hass.callService('cover', 'stop_cover', { entity_id: ds.e }); break;
        case 'cover_close': await hass.callService('cover', 'close_cover', { entity_id: ds.e }); break;
        case 'reboot':
          if (d && window.confirm(`${d.name} neu starten?`)) { await this._publish(d.mac, 'Restart', '1'); this._toast(`${d.name} startet neu`); }
          break;
        case 'update':
          if (d && d.update && !d.upd && window.confirm(
            `Firmware ${this._latest} auf ${d.name} installieren?\n\nInstalliert: ${d.swFull}\nDas Gerät lädt die Firmware von seiner OtaUrl und startet danach neu.`)) {
            await this._startUpdate(d);
            this._refresh(true);
          }
          break;
        case 'update_all': {
          const list = (this._devices || []).filter((x) => x.update && !x.upd && this._disc[x.mac]);
          if (list.length && window.confirm(`Firmware ${this._latest} auf ${list.length} Geräten installieren?\n\n${list.map((x) => `• ${x.name} (${x.swFull})`).join('\n')}`)) {
            for (const x of list) await this._startUpdate(x);
            this._refresh(true);
          }
          break;
        }
        case 'console': {
          const input = this._dlg.querySelector('#cmd');
          const line = (input?.value || '').trim();
          if (!line || !this._infoMac) break;
          const [cmd, ...rest] = line.split(/\s+/);
          this._waitConsole = this._infoMac;
          this._last[this._infoMac] = '…';
          await this._publish(this._infoMac, cmd, rest.join(' '));
          if (/^status$/i.test(cmd)) {
            // Status-Antworten kommen auf STATUSx statt RESULT
            setTimeout(() => {
              if (this._last[this._infoMac] === '…') {
                const s = this._status[this._infoMac];
                this._last[this._infoMac] = s ? JSON.stringify(s, null, 1) : '…';
                this._renderInfo();
              }
            }, 1500);
          }
          if (input) input.value = '';
          this._renderInfo();
          break;
        }
        case 'web': if (ds.v) window.open(ds.v, '_blank', 'noopener'); break;
        case 'info': this._openInfo(ds.d); break;
        case 'close': this._closeInfo(); break;
        case 'copy':
          await navigator.clipboard?.writeText(ds.v);
          this._toast(`${ds.v} kopiert`);
          break;
        default: break;
      }
    } catch (err) {
      this._toast(`Fehler: ${err.message || err}`);
    }
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get('tasmota-manager-card')) {
  customElements.define('tasmota-manager-card', TasmotaManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'tasmota-manager-card', name: 'Tasmota Manager', description: 'Alle Tasmota-Geräte im Stil des ioBroker Device Managers, inkl. Firmware-Update' });
  console.info(`%c TASMOTA-MANAGER-CARD %c ${VERSION} `, 'background:#1fa3ec;color:#fff', 'background:#eee;color:#333');
}
