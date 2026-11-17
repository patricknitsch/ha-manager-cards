/*
 * ESPHome Manager Card – Geräteübersicht im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly Manager Card und zur Tasmota Manager Card).
 * Liest alle Geräte der ESPHome-Integration live aus der Geräte-/Entitäts-Registry,
 * neue Geräte erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Thermostate (climate) bekommen einen eigenen Block: Ist-, Plan- und Solltemperatur (Pfeiltasten), Betriebsart,
 * Temperaturverlauf im Hintergrund und 24-h-Heizphasen. Preset und Einstellungen wie Eco oder Arbeitstage
 * stehen nur im Info-Dialog.
 *
 * Firmware-Updates laufen über die Update-Entität der ESPHome-Integration (update.install):
 * der ESPHome Device Builder kompiliert die Firmware und flasht sie per OTA. Mehrere Updates
 * werden nacheinander abgearbeitet. Deaktivierte Update-Entitäten kann die Karte aktivieren (nur Admins).
 *
 * Konfiguration (alle optional):
 *   type: custom:esphome-manager-card
 *   integration: esphome          # Plattform der Entitäten
 *   min_width: 320                # Mindestbreite einer Gerätekarte in px
 *   history_hours: 24             # Thermostat- und Leistungsverlauf im Hintergrund, 0 = aus
 *   max_sensors: 4                # so viele sonstige Messwerte zeigt eine Gerätekarte
 *   thermostat_hide: ['_power_switch$', '_eco$', 'arbeitstage']   # bei Thermostaten nur im Dialog (Regex auf die Entitäts-ID)
 *   builder_entity: update.esphome_device_builder_update   # Vergleichsversion, wenn die Update-Entität fehlt
 *   icon_map: { "Tank": "mdi:water" }                      # Gerätename -> Icon
 */
const VERSION = '1.2.0';
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const BAD = ['unavailable', 'unknown'];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "2026.10.2 (config hash …)" / "2026.10.0b1" -> [2026,10,2] */
const parseVersion = (v) => {
  const m = typeof v === 'string' ? v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [m[1], m[2], m[3]].map((n) => parseInt(n, 10)) : null;
};
const isNewer = (available, installed) => {
  const a = parseVersion(available), b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
const shortVersion = (v) => (parseVersion(v) || []).join('.') || '';

const HVAC = {
  off: ['Aus', 'mdi:power'], heat: ['Heizen', 'mdi:fire'], cool: ['Kühlen', 'mdi:snowflake'], auto: ['Auto', 'mdi:thermostat-auto'],
  heat_cool: ['Heizen/Kühlen', 'mdi:sun-snowflake-variant'], dry: ['Trocknen', 'mdi:water-percent'], fan_only: ['Lüften', 'mdi:fan'],
};
const ACTION = {
  heating: 'Heizt', idle: 'Inaktiv', off: 'Aus', cooling: 'Kühlt', drying: 'Trocknet', fan: 'Lüftet', preheating: 'Heizt vor',
  defrosting: 'Taut ab', na: 'Nicht erreichbar',
};
const PRESET = {
  none: ['Normal', 'mdi:home'], eco: ['Eco', 'mdi:leaf'], away: ['Abwesend', 'mdi:home-export-outline'], home: ['Zuhause', 'mdi:home'],
  sleep: ['Nacht', 'mdi:weather-night'], comfort: ['Komfort', 'mdi:sofa'], boost: ['Boost', 'mdi:rocket-launch'], activity: ['Aktiv', 'mdi:run'],
};
const ACTION_COLOR = { heating: '#ef5350', preheating: '#ef5350', cooling: '#42a5f5', idle: '#66bb6a', off: '#78909c', na: 'transparent' };

const DEVICE_ICON = (d) => {
  const n = `${d.name} ${d.model}`.toLowerCase();
  if (d.climates.length) return 'mdi:thermostat';
  if (d.covers.length) return 'mdi:window-shutter';
  if (d.lights.length) return 'mdi:lightbulb-outline';
  if (d.fans.length) return 'mdi:fan';
  if (/tank|zisterne|füllstand|fuellstand/.test(n)) return 'mdi:water';
  if (d.power.length && !d.controls.length) return 'mdi:meter-electric-outline';
  if (d.controls.length) return 'mdi:electric-switch';
  return 'mdi:chip';
};

class EsphomeManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      integration: 'esphome', min_width: 320, history_hours: 24, max_sensors: 4,
      builder_entity: null, icon_map: {}, thermostat_hide: ['_power_switch$', '_eco$', 'arbeitstage'], ...config,
    };
    this._hideRe = [].concat(this._config.thermostat_hide || []).map((p) => new RegExp(p, 'i'));
    this._filter = this._filter || '';
    this._sort = this._sort || 'name';
    this._view = this._view || 'all';
    this._sig = '';
    this._upd = this._upd || {};         // Geräte-ID -> { state: queued|running|failed, eid, name, text }
    this._queue = this._queue || [];     // Geräte-IDs, die noch aktualisiert werden
    this._disabled = this._disabled || {}; // Geräte-ID -> deaktivierte Update-Entität
    this._pend = this._pend || {};       // climate-Entität -> { v, timer } (Solltemperatur in Arbeit)
    this._hist = this._hist || {};       // climate-Entität -> Verlaufszeilen
    this._phist = this._phist || {};     // Leistungs-Entität -> Verlaufszeilen
    this._histTs = this._histTs || 0;
    this._tlCache = {};
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'esphome' }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._started && hass.connection) {
      this._started = true;
      this._loadDisabled();
    }
    this._refresh();
    this._fetchHistory();
  }

  connectedCallback() {
    if (this._hass && !this._started) this.hass = this._hass;
    // Verlauf läuft auch ohne Zustandsänderung weiter
    this._tick = setInterval(() => { this._fetchHistory(); }, 60000);
  }

  disconnectedCallback() {
    if (this._dlgHost) this._closeInfo();
    clearInterval(this._tick);
    this._started = false;
  }

  _refresh(force = false) {
    if (!this._hass) return;
    const devices = this._collect();
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    const sig = JSON.stringify([this._histTs, this._latest, devices.map((d) => [d.id, d.name, d.area, d.sig])]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  /* ---------- Registry: deaktivierte Update-Entitäten ---------- */
  async _loadDisabled() {
    try {
      const list = await this._hass.callWS({ type: 'config/entity_registry/list' });
      const map = {};
      for (const e of list) {
        if (e.platform === this._config.integration && e.entity_id.startsWith('update.') && e.disabled_by && e.device_id) {
          map[e.device_id] = e.entity_id;
        }
      }
      this._disabled = map;
      this._refresh(true);
    } catch (err) {
      console.info('esphome-manager-card: Entitäts-Registry nicht lesbar (kein Administrator?)', err);
    }
  }

  async _enableUpdate(ids) {
    for (const id of ids) {
      const eid = this._disabled[id];
      if (!eid) continue;
      await this._hass.callWS({ type: 'config/entity_registry/update', entity_id: eid, disabled_by: null });
      delete this._disabled[id];
    }
    this._toast('Update-Entitäten aktiviert – Home Assistant lädt die Geräte in etwa 30 s neu');
    this._refresh(true);
  }

  /* ---------- Verlauf der Thermostate ---------- */
  async _fetchHistory() {
    const hours = Number(this._config.history_hours) || 0;
    if (!hours || !this._hass || !this.isConnected || this._histBusy) return;
    if (Date.now() - this._histTs < HISTORY_REFRESH_MS) return;
    const devs = this._devices || [];
    const cids = devs.flatMap((d) => d.climates.map((c) => c.id));
    const pids = devs.map((d) => this._mainPower(d)?.id).filter(Boolean);
    if (!cids.length && !pids.length) return;
    this._histBusy = true;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3600000);
      // Thermostate mit Attributen (Ist-/Solltemperatur, Heizphasen), Leistung nur mit Zustand
      const query = (ids, attrs) => (ids.length ? this._hass.callWS({
        type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ids, minimal_response: !attrs, no_attributes: !attrs, significant_changes_only: false,
      }) : Promise.resolve({}));
      const [ch, ph] = await Promise.all([query(cids, true), query(pids, false)]);
      this._hist = ch || {};
      this._phist = ph || {};
      this._histStart = start.getTime();
    } catch (err) {
      console.info('esphome-manager-card: Verlauf nicht abrufbar', err);
    } finally {
      this._histTs = Date.now();
      this._histBusy = false;
      this._tlCache = {};
      this._refresh(true);
    }
  }

  /** Zeitabschnitte eines Thermostats: [{ t, action, preset }] ab Fensterbeginn, inkl. aktuellem Zustand */
  _points(c) {
    const rows = this._hist[c.id];
    if (!rows || !rows.length || !this._histStart) return null;
    const point = (state, attrs, t) => {
      if (BAD.includes(state)) return { t, action: 'na' };
      const action = attrs?.hvac_action || (state === 'off' ? 'off' : 'idle');
      return { t, action, cur: attrs?.current_temperature, set: state === 'off' ? undefined : attrs?.temperature };
    };
    const pts = rows.map((r) => point(r.s, r.a, Math.max(this._histStart, (r.lu ?? r.lc ?? 0) * 1000)));
    const liveT = new Date(c.st.last_updated).getTime();
    if (liveT > pts[pts.length - 1].t) pts.push(point(c.st.state, c.st.attributes, liveT));
    return pts;
  }

  _track(pts, key, end) {
    const out = [];
    pts.forEach((p, i) => {
      const to = i + 1 < pts.length ? pts[i + 1].t : end;
      if (to <= p.t) return;
      const last = out[out.length - 1];
      if (last && last.v === p[key]) last.to = to;
      else out.push({ v: p[key], from: p.t, to });
    });
    return out;
  }

  /** Heizdauer seit Mitternacht in ms, null ohne Verlauf */
  _heatToday(c) {
    const pts = this._points(c);
    if (!pts) return null;
    const now = Date.now();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const from = Math.max(midnight.getTime(), this._histStart);
    return this._track(pts, 'action', now)
      .filter((s) => s.v === 'heating' || s.v === 'preheating')
      .reduce((sum, s) => sum + Math.max(0, s.to - Math.max(s.from, from)), 0);
  }

  _timelineHtml(c) {
    const pts = this._points(c);
    if (!pts) return '';
    const key = `${this._histTs}|${c.st.last_updated}`;
    const hit = this._tlCache[c.id];
    if (hit && hit.key === key) return hit.html;
    const start = this._histStart, end = Math.max(Date.now(), start + 60000), span = end - start;
    const bar = (title, key2, colors, names) => {
      const segs = this._track(pts, key2, end).map((s) => {
        const w = ((s.to - s.from) / span) * 100;
        const name = names(s.v);
        const tip = `${name} · ${this._clock(s.from)}–${this._clock(s.to)}`;
        return `<span class="seg" style="width:${w.toFixed(3)}%;background:${colors[s.v] || '#8e58b0'}" title="${esc(tip)}">${w > 16 ? esc(name) : ''}</span>`;
      }).join('');
      return `<span class="tl-k">${title}</span><span class="tl-bar">${segs}</span>`;
    };
    // Achse: alle 6 h, Mitternacht mit Datum
    const ticks = [];
    const t = new Date(start); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
    for (; t.getTime() < end; t.setHours(t.getHours() + 1)) {
      if (t.getHours() % 6) continue;
      const pos = ((t.getTime() - start) / span) * 100;
      if (pos < 5 || pos > 95) continue;
      const label = t.getHours() === 0
        ? `<b>${t.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}</b>`
        : `${String(t.getHours()).padStart(2, '0')}:00`;
      ticks.push(`<span style="left:${pos.toFixed(2)}%">${label}</span>`);
    }
    const html = `<div class="tl" data-more="${c.id}">
      ${bar('Heizung', 'action', ACTION_COLOR, (v) => ACTION[v] || v)}
      <span></span><span class="tl-axis">${ticks.join('')}</span></div>`;
    this._tlCache[c.id] = { key, html };
    return html;
  }

  /** Temperaturverlauf als Hintergrund des Thermostatblocks: Ist-Temperatur als Fläche, Sollwert gestrichelt */
  _chartHtml(c) {
    const pts = this._points(c);
    if (!pts) return '';
    const key = `${this._histTs}|${c.st.last_updated}`;
    const hit = this._tlCache[`chart:${c.id}`];
    if (hit && hit.key === key) return hit.html;
    const start = this._histStart, end = Math.max(Date.now(), start + 60000), span = end - start;
    const temps = pts.map((p) => p.cur).filter((v) => typeof v === 'number');
    if (temps.length < 2) return '';
    const vals = temps.concat(pts.map((p) => p.set).filter((v) => typeof v === 'number'));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
    const pad = (hi - lo) * 0.15;
    lo -= pad; hi += pad;
    const W = 1000, H = 100;
    const x = (t) => (((t - start) / span) * W).toFixed(1);
    const y = (v) => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
    // Treppenlinie je Wert, Lücke solange kein Wert gemeldet wird
    const series = (k) => {
      const segs = [];
      let s = null;
      pts.forEach((p, i) => {
        const v = p[k];
        const to = i + 1 < pts.length ? pts[i + 1].t : end;
        if (typeof v !== 'number') { s = null; return; }
        if (to <= p.t) return;
        if (!s) { s = { x0: x(p.t), y0: y(v), d: '' }; segs.push(s); } else s.d += `V${y(v)}`;
        s.d += `H${x(to)}`;
      });
      return segs;
    };
    const cur = series('cur'), set = series('set');
    const line = (segs) => segs.map((s) => `M${s.x0},${s.y0}${s.d}`).join('');
    const area = cur.map((s) => `M${s.x0},${H}V${s.y0}${s.d}V${H}Z`).join('');
    const html = `<svg class="tchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="ta" d="${area}"/><path class="tc" d="${line(cur)}"/><path class="ts" d="${line(set)}"/></svg>`;
    this._tlCache[`chart:${c.id}`] = { key, html };
    return html;
  }

  _mainPower(d) {
    return d.mainPower.find((p) => p.st.attributes.unit_of_measurement === 'W') || null;
  }

  /** Leistungsverlauf als Hintergrund der Leistungswerte: Fläche + Linie, je Bildspalte der Höchstwert (kurze Spitzen bleiben sichtbar) */
  _powerChartHtml(d) {
    const p = this._mainPower(d);
    const rows = p && this._phist[p.id];
    if (!rows || !rows.length || !this._histStart) return '';
    const key = `${this._histTs}|${p.st.last_updated}`;
    const hit = this._tlCache[`pwr:${p.id}`];
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
    this._tlCache[`pwr:${p.id}`] = { key, html, max };
    return html;
  }

  _clock(ms) {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- Datensammlung ---------- */
  _byDevice() {
    const hass = this._hass;
    if (this._entRef === hass.entities) return this._entMap;
    const map = {};
    for (const ent of Object.values(hass.entities)) {
      if (ent.platform !== this._config.integration || !ent.device_id || ent.hidden) continue;
      (map[ent.device_id] ||= []).push(ent);
    }
    this._entRef = hass.entities;
    this._entMap = map;
    return map;
  }

  _builderVersion() {
    const st = this._hass.states;
    if (!this._config.builder_entity && this._builderId && st[this._builderId]) {
      return shortVersion(st[this._builderId].attributes.installed_version);
    }
    const pick = this._config.builder_entity ? st[this._config.builder_entity]
      : Object.values(st).find((s) => s.entity_id.startsWith('update.') && /esphome/i.test(`${s.entity_id} ${s.attributes.title || ''}`)
        && /builder|dashboard|esphome_update|esphome_device/i.test(`${s.entity_id} ${s.attributes.title || ''}`)
        && s.attributes.device_class !== 'firmware');
    this._builderId = pick?.entity_id;
    return shortVersion(pick?.attributes.installed_version);
  }

  _collect() {
    const hass = this._hass;
    if (!hass || !hass.entities || !hass.devices) return [];
    this._latest = this._builderVersion();
    const out = [];
    for (const [devId, ents] of Object.entries(this._byDevice())) {
      const reg = hass.devices[devId];
      if (!reg || reg.disabled_by) continue;
      const swm = String(reg.sw_version || '').match(/^(\S+)(?:\s*\((.+)\))?/) || [];
      const d = {
        id: devId, reg,
        name: (reg.name_by_user || reg.name || devId).trim(),
        model: reg.model || '',
        area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '',
        ver: swm[1] || '', build: swm[2] || '',
        url: reg.configuration_url || '', ip: '',
        climates: [], controls: [], lights: [], covers: [], fans: [], selects: [], power: [], sensors: [], problems: [],
        today: null, year: null, rssi: null, uptime: null, reboot: null, fw: null, versionEnt: null, ipEnt: null,
        reason: null, info: null, plan: null, online: true, sig: '', all: [], extra: [],
      };
      const sigParts = [];
      let alive = 0;
      for (const ent of ents) {
        const st = hass.states[ent.entity_id];
        if (!st) continue;
        const id = ent.entity_id;
        const domain = id.split('.')[0];
        const dc = st.attributes.device_class;
        const unit = st.attributes.unit_of_measurement;
        const item = { id, label: this._label(ent, st, d.name), st, ent };
        d.all.push(item);
        // Die Update-Entität kommt vom Device Builder und bleibt verfügbar, wenn das Gerät offline ist
        if (domain !== 'update' && st.state !== 'unavailable') alive++;
        const sg = () => sigParts.push(id + st.state);
        switch (domain) {
          case 'climate':
            d.climates.push(item);
            sigParts.push([id, st.state, st.attributes.temperature, st.attributes.current_temperature,
              st.attributes.hvac_action, st.attributes.preset_mode].join());
            break;
          case 'switch': if (!ent.entity_category) { d.controls.push(item); sg(); } break;
          case 'light': d.lights.push(item); sigParts.push(id + st.state + (st.attributes.brightness ?? '')); break;
          case 'fan': d.fans.push(item); sg(); break;
          case 'cover': d.covers.push(item); sigParts.push(id + st.state + (st.attributes.current_position ?? '')); break;
          case 'select': if (!ent.entity_category || ent.entity_category === 'config') { d.selects.push(item); sg(); } break;
          case 'sensor':
            if (dc === 'signal_strength') { d.rssi = item; sg(); }
            else if (/_version$/.test(id)) { d.versionEnt = item; sg(); }
            else if (/ip/.test(id) && (IPV4.test(st.state) || /_ip_ad+res+$/.test(id))) { d.ipEnt = item; if (IPV4.test(st.state)) d.ip = st.state; }
            else if (/uptime|betriebszeit/.test(id)) { d.uptime = item; }
            else if (/reset_reason|restart_reason/.test(id)) { d.reason = item; }
            else if (/device_info/.test(id)) { d.info = item; }
            else if (dc === 'temperature' && /plan|sollwert|setpoint|schedule/.test(id)) { d.plan = item; sg(); }
            else if (dc === 'power') { d.power.push(item); sg(); }
            else if (dc === 'energy' && /daily|today|heute|tag/.test(id)) { d.today = item; sg(); }
            else if (dc === 'energy' && /yearly|year|jahr/.test(id)) { d.year = item; }
            else if (['energy', 'voltage', 'current', 'frequency', 'duration'].includes(dc) || ent.entity_category) { /* nur im Dialog */ }
            else if (unit) { d.sensors.push(item); sg(); }
            break;
          case 'binary_sensor':
            if (dc === 'problem') { if (st.state === 'on') d.problems.push(item); sg(); }
            else if (!ent.entity_category) { d.sensors.push(item); sg(); }
            break;
          case 'button':
            if ((dc === 'restart' || /restart|neustart|reboot/.test(id)) && !/safe_mode|factory/.test(id) && !d.reboot) d.reboot = item;
            break;
          case 'update':
            d.fw = item;
            sigParts.push(id + st.state + st.attributes.latest_version + (st.attributes.in_progress ? 'p' : ''));
            break;
          default: break;
        }
      }
      if (!d.ip && /^https?:/.test(d.url)) { try { d.ip = new URL(d.url).hostname; } catch (e) { /* ignore */ } }
      if (!d.ver && d.versionEnt && !BAD.includes(d.versionEnt.st.state)) d.ver = d.versionEnt.st.state.split(' ')[0];
      d.online = alive > 0;
      // Thermostate: Schalter/Auswahlen, die der Thermostatblock schon abdeckt, nur im Dialog zeigen
      if (d.climates.length) {
        const tile = (x) => !this._hideRe.some((r) => r.test(x.id));
        d.controls = d.controls.filter(tile);
        d.selects = d.selects.filter(tile);
      }
      // Hauptleistung: bei mehrphasigen Messdosen nur die Summe zählen
      const main = d.power.filter((p) => !/phase|_l\d/i.test(p.id));
      d.mainPower = main.length ? main : d.power;
      d.fwLatest = d.fw ? shortVersion(d.fw.st.attributes.latest_version) || d.fw.st.attributes.latest_version || '' : this._latest;
      d.fwBusy = !!d.fw?.st.attributes.in_progress;
      d.fwAvail = d.fw ? d.fw.st.state === 'on' : isNewer(this._latest, d.ver);
      d.update = !!(d.fw && d.fwAvail && d.online);
      d.noEntity = !d.fw;
      d.canEnable = !d.fw && !!this._disabled[devId];
      d.upd = this._upd[devId] || null;
      d.icon = this._config.icon_map[d.name] || DEVICE_ICON(d);
      const used = new Set([...d.climates, ...d.controls, ...d.lights, ...d.covers, ...d.fans, ...d.selects, ...d.power, ...d.problems,
        ...d.sensors.slice(0, this._config.max_sensors), d.today, d.year, d.rssi, d.uptime, d.reboot, d.fw, d.versionEnt, d.ipEnt,
        d.reason, d.info, d.plan].filter(Boolean).map((x) => x.id));
      d.extra = d.all.filter((x) => !used.has(x.id));
      d.sig = [sigParts.join('|'), d.online, d.fwAvail, d.canEnable, d.ver, d.ip, d.upd ? d.upd.state + (d.upd.text || '') : '',
        d.uptime && BAD.includes(d.uptime.st.state), d.climates.map((c) => this._pend[c.id]?.v ?? '').join()].join('~');
      out.push(d);
    }
    return out;
  }

  _label(ent, st, devName) {
    let n = ent.name || st.attributes.friendly_name || ent.entity_id;
    if (n.startsWith(devName)) n = n.slice(devName.length).trim();
    return n || devName;
  }

  _num(v, digits = 1) {
    return Number(v).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  _fmt(st, digits) {
    if (!st || BAD.includes(st.state)) return '–';
    const v = parseFloat(st.state);
    const unit = st.attributes.unit_of_measurement || '';
    if (Number.isNaN(v) || !/^-?[\d.]+$/.test(st.state.trim())) return esc(st.state);
    const d = digits ?? (unit === 'kWh' ? 2 : unit === 'V' && v < 10 ? 2 : 1);
    return `${this._num(v, d)} ${esc(unit)}`;
  }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    return this._fmt(st);
  }

  /** Laufzeit: Sekundenwert (duration) oder Text wie "25d 17h 28m 24s" */
  _uptime(st) {
    if (!st || BAD.includes(st.state)) return '';
    const raw = st.state.trim();
    if (/^[\d.]+$/.test(raw)) {
      const f = { s: 1, min: 60, h: 3600, d: 86400 }[st.attributes.unit_of_measurement || 's'] || 1;
      const sec = parseFloat(raw) * f;
      const days = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return days ? `${days} d ${h} h` : `${h} h ${m} min`;
    }
    const m = raw.match(/(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/);
    if (!m || (!m[1] && !m[2] && !m[3])) return raw;
    return m[1] ? `${m[1]} d ${m[2] || 0} h` : `${m[2] || 0} h ${m[3] || 0} min`;
  }

  _rssiIcon(st) {
    const v = st ? parseFloat(st.state) : NaN;
    if (Number.isNaN(v)) return 'mdi:wifi-strength-off-outline';
    if (v >= -55) return 'mdi:wifi-strength-4';
    if (v >= -65) return 'mdi:wifi-strength-3';
    if (v >= -75) return 'mdi:wifi-strength-2';
    return 'mdi:wifi-strength-1';
  }

  _powerSum(d) {
    return d.mainPower.filter((p) => p.st.attributes.unit_of_measurement === 'W').reduce((s, p) => s + (parseFloat(p.st.state) || 0), 0);
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
        .toolbar #tools { display:contents; }
        .stats { font-size:13px; opacity:.9; width:100%; display:flex; gap:16px; flex-wrap:wrap; }
        .grid { display:grid; gap:8px; align-items:start; grid-template-columns: repeat(auto-fill, minmax(var(--emc-min, 320px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline { opacity:.55; }
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--secondary-background-color);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color: var(--state-icon-color, var(--primary-color)); }
        .ico.heat ha-icon { color: var(--state-climate-heat-color, #ff8100); }
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
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .chip[data-act] { cursor:pointer; }
        /* Thermostat */
        .thermo { margin: 2px 14px 8px; }
        .tbox { position:relative; display:flex; align-items:center; gap:8px; cursor:pointer; min-height:96px; }
        .tinfo, .tset { position:relative; z-index:1; }
        .tchart { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; overflow:visible; }
        .tchart .ta { fill: var(--primary-color); opacity:.10; }
        .tchart .tc { fill:none; stroke: var(--primary-color); stroke-width:1.5; opacity:.4; vector-effect:non-scaling-stroke; }
        .tchart .ts { fill:none; stroke: var(--state-climate-heat-color, #ff8100); stroke-width:1; stroke-dasharray:4 3; opacity:.6; vector-effect:non-scaling-stroke; }
        .tinfo { flex:1; display:grid; grid-template-columns:auto 1fr; column-gap:12px; row-gap:3px; font-size:13px; min-width:0; }
        .tinfo .k { color: var(--secondary-text-color); white-space:nowrap; }
        .tinfo .v { font-weight:600; font-variant-numeric: tabular-nums; }
        .tinfo .v.heat { color: var(--state-climate-heat-color, #ff8100); }
        .tset { display:flex; flex-direction:column; align-items:center; flex:none; }
        .tset .iconbtn ha-icon { --mdc-icon-size:26px; }
        .tval { font-size:38px; font-weight:300; line-height:1; font-variant-numeric: tabular-nums; white-space:nowrap; }
        .tval sup { font-size:15px; font-weight:400; margin-left:2px; vertical-align:top; position:relative; top:4px; }
        .tval.pend { color: var(--primary-color); }
        .modes { display:flex; gap:6px; margin-top:8px; }
        .mode { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 4px; font: inherit; font-size:12px;
          border:none; border-radius:8px; cursor:pointer; background: var(--secondary-background-color); color: var(--secondary-text-color); }
        .mode ha-icon { --mdc-icon-size:20px; }
        .mode.on { color: var(--state-climate-heat-color, #ff8100); background: rgba(255,129,0,.16); }
        .mode.on.off { color: var(--primary-text-color); background: var(--divider-color); }
        .mode[disabled] { opacity:.4; cursor:default; }
        .tl { display:grid; grid-template-columns:auto 1fr; column-gap:8px; row-gap:3px; align-items:center; margin-top:10px; font-size:11px; cursor:pointer; }
        .tl-k { color: var(--state-climate-heat-color, #ff8100); }
        .tl-bar { display:flex; height:16px; border-radius:3px; overflow:hidden; background: var(--secondary-background-color); }
        .seg { display:block; height:100%; color:#fff; font-size:10px; line-height:16px; padding-left:4px; box-sizing:border-box;
          overflow:hidden; white-space:nowrap; }
        .tl-axis { position:relative; height:14px; color: var(--secondary-text-color); font-size:10px; }
        .tl-axis span { position:absolute; top:0; transform:translateX(-50%); white-space:nowrap; }
        .rows { padding: 0 10px 6px; flex:1; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:13px;
          border-top: 1px solid var(--divider-color); cursor:pointer; min-height:22px; }
        .sel > .row:first-child, .sel:empty + .vals > .row:first-child { border-top:none; }
        .row .lbl { color: var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .row .val { font-variant-numeric: tabular-nums; white-space:nowrap; }
        .row select, .kv select { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
          border-radius:6px; padding:3px 6px; font: inherit; font-size:13px; max-width:60%; }
        .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
          border:none; cursor:pointer; flex:none; transition: background .15s; }
        .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
        .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
        .tog.on::after { left:21px; }
        .tog[disabled] { opacity:.4; cursor:default; }
        .cover { display:flex; gap:4px; }
        .pwr { position:relative; min-height:56px; border-top: 1px solid var(--divider-color); }
        .sel:empty + .vals > .pwr:first-child, .pwr > .row:first-child { border-top:none; }
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
        .dlg-h > ha-icon { --mdc-icon-size:30px; color: var(--primary-color); }
        .dlg-web { display:flex; align-items:center; justify-content:center; gap:8px; margin: 0 20px 8px; padding:8px; border-radius:8px; cursor:pointer;
          color: var(--primary-color); text-decoration:none; font-weight:500; border:1px solid var(--divider-color); }
        .dlg-web:hover { background: var(--secondary-background-color); }
        .dlg-b { overflow:auto; padding: 0 20px 16px; }
        .dlg-b h4 { margin: 14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
        .kv { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv:last-child { border-bottom:none; }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-word; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .hint { font-size:12px; color: var(--secondary-text-color); padding:4px 0; }
        .dlg-f { display:flex; justify-content:flex-end; gap:8px; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
        .btn.sm { padding:3px 10px; font-size:12px; }
        .btn.sec { background: var(--secondary-background-color); color: var(--primary-text-color); }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:alpha-e-box"></ha-icon>ESPHome Geräte</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view">
          <option value="all">Alle</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="update">Update verfügbar</option>
          <option value="problem">Warnungen</option>
          <option value="climate">Thermostate</option>
        </select>
        <select id="sort">
          <option value="name">Name</option>
          <option value="area">Raum</option>
          <option value="model">Board</option>
          <option value="power">Leistung</option>
          <option value="rssi">Signal</option>
          <option value="ip">IP</option>
          <option value="fw">Firmware</option>
        </select>
        <span id="tools"></span>
        <div class="stats" id="stats"></div>
      </div>
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
    root.getElementById('grid').addEventListener('change', (e) => this._onChange(e));
    root.getElementById('tools').addEventListener('click', (e) => this._onClick(e));
    this._dlg.addEventListener('click', (e) => {
      if (e.target.classList?.contains('dlg-bg')) { this._closeInfo(); return; }
      const path = e.composedPath();
      if (!path.some((el) => el.dataset && el.dataset.act)) {
        const more = path.find((el) => el.dataset && el.dataset.more);
        if (more) { this._closeInfo(); this._fire('hass-more-info', { entityId: more.dataset.more }); return; }
      }
      this._onClick(e);
    });
    this._dlg.addEventListener('change', (e) => this._onChange(e));
    this._dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closeInfo(); });
  }

  _renderGrid() {
    const root = this.shadowRoot;
    if (!root || !this._devices) return;
    root.host.style.setProperty('--emc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.area} ${d.model} ${d.ip} ${d.ver}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'online': return d.online;
        case 'offline': return !d.online;
        case 'update': return d.fwAvail;
        case 'problem': return d.problems.length > 0;
        case 'climate': return d.climates.length > 0;
        default: return true;
      }
    });
    const ipNum = (ip) => String(ip).split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
    const verNum = (v) => (parseVersion(v) || [0, 0, 0]).reduce((a, b) => a * 1000 + b, 0);
    const byName = (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true });
    const rssi = (d) => { const v = parseFloat(d.rssi?.st.state); return Number.isNaN(v) ? -999 : v; };
    const cmp = {
      name: byName,
      area: (a, b) => (a.area || '~').localeCompare(b.area || '~', 'de') || byName(a, b),
      model: (a, b) => a.model.localeCompare(b.model) || byName(a, b),
      power: (a, b) => this._powerSum(b) - this._powerSum(a) || byName(a, b),
      rssi: (a, b) => rssi(b) - rssi(a),
      ip: (a, b) => ipNum(a.ip) - ipNum(b.ip),
      fw: (a, b) => verNum(a.ver) - verNum(b.ver) || byName(a, b),
    }[this._sort];
    list.sort(cmp);

    const online = all.filter((d) => d.online).length;
    const updates = all.filter((d) => d.fwAvail).length;
    const installable = all.filter((d) => d.update && !d.upd && !d.fwBusy).length;
    const enable = all.filter((d) => d.canEnable).length;
    const warn = all.filter((d) => d.problems.length).length;
    const heating = all.filter((d) => d.climates.some((c) => c.st.attributes.hvac_action === 'heating')).length;
    const totalPower = all.reduce((s, d) => s + this._powerSum(d), 0);
    root.getElementById('stats').innerHTML = `
      <span>${all.length} Geräte</span><span>${online} online</span>
      ${all.length - online ? `<span>${all.length - online} offline</span>` : ''}
      ${updates ? `<span>${updates} Update${updates > 1 ? 's' : ''} verfügbar</span>` : ''}
      ${warn ? `<span>${warn} mit Warnung</span>` : ''}
      ${heating ? `<span>${heating} heizen</span>` : ''}
      <span>Σ ${this._num(totalPower, 1)} W</span>
      <span>ESPHome ${this._latest ? `aktuell: ${esc(this._latest)}` : 'Version unbekannt'}</span>`;
    root.getElementById('tools').innerHTML = `
      ${installable > 1 ? `<button class="tb" data-act="update_all"><ha-icon icon="mdi:update"></ha-icon>Alle aktualisieren (${installable})</button>` : ''}
      ${enable ? `<button class="tb" data-act="enable_all" title="Deaktivierte Update-Entitäten der ESPHome-Integration aktivieren"><ha-icon icon="mdi:package-variant-plus"></ha-icon>Update-Entitäten aktivieren (${enable})</button>` : ''}`;
    this._patchGrid(list);
  }

  /* Kacheln bleiben bestehen; nur geänderte Bereiche werden ersetzt (offene Auswahlfelder bleiben offen). */
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
          <div class="ico"><ha-icon></ha-icon><span class="dot"></span></div>
          <div class="name"></div>
          <button class="iconbtn" data-act="info" data-d="${d.id}" title="Geräteinformationen"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
        </div>
        <div class="meta"></div><div class="chips"></div><div class="thermo"></div><div class="rows"><div class="sel"></div><div class="vals"></div></div><div class="foot"></div>`;
      c = this._cards[d.id] = {
        el, ico: el.querySelector('.ico'), icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'),
        meta: el.querySelector('.meta'), chips: el.querySelector('.chips'), thermo: el.querySelector('.thermo'),
        sel: el.querySelector('.sel'), vals: el.querySelector('.vals'), foot: el.querySelector('.foot'), last: {},
      };
      c.sel.style.display = 'contents';
      c.vals.style.display = 'contents';
    }
    const parts = this._deviceParts(d);
    const cls = `dev${d.online ? '' : ' offline'}`;
    if (c.el.className !== cls) c.el.className = cls;
    const heat = d.climates.some((x) => x.st.attributes.hvac_action === 'heating');
    c.ico.className = `ico${heat ? ' heat' : ''}`;
    if (c.icon.getAttribute('icon') !== d.icon) c.icon.setAttribute('icon', d.icon);
    for (const k of ['name', 'meta', 'chips', 'thermo', 'sel', 'vals', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    c.chips.style.display = parts.chips ? '' : 'none';
    c.thermo.style.display = parts.thermo ? '' : 'none';
    return c.el;
  }

  _thermoHtml(c, d) {
    const a = c.st.attributes;
    const off = BAD.includes(c.st.state);
    const unit = this._hass.config?.unit_system?.temperature || '°C';
    const pend = this._pend[c.id];
    const target = pend ? pend.v : a.temperature;
    const action = a.hvac_action || (c.st.state === 'off' ? 'off' : 'idle');
    const heatMs = this._heatToday(c);
    const hm = (ms) => `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}`;
    return `
      ${d.climates.length > 1 ? `<div class="hint">${esc(c.label)}</div>` : ''}
      <div class="tbox" data-more="${c.id}">
        ${this._chartHtml(c)}
        <div class="tinfo">
          <span class="k">Temperatur</span><span class="v">${a.current_temperature != null ? `${this._num(a.current_temperature)} ${esc(unit)}` : '–'}</span>
          ${d.plan && !BAD.includes(d.plan.st.state) ? `<span class="k">Geplant</span><span class="v">${this._num(d.plan.st.state)} ${esc(unit)}</span>` : ''}
          <span class="k">Status</span><span class="v ${action === 'heating' ? 'heat' : ''}">${off ? 'Nicht erreichbar' : esc(ACTION[action] || action)}</span>
          ${heatMs != null ? `<span class="k">Heizzeit heute</span><span class="v">${hm(heatMs)}</span>` : ''}
        </div>
        <div class="tset">
          <button class="iconbtn" data-act="temp" data-e="${c.id}" data-v="1" title="Wärmer" ${off ? 'disabled' : ''}><ha-icon icon="mdi:chevron-up"></ha-icon></button>
          <div class="tval ${pend ? 'pend' : ''}">${target != null ? this._num(target) : '–'}<sup>${esc(unit)}</sup></div>
          <button class="iconbtn" data-act="temp" data-e="${c.id}" data-v="-1" title="Kälter" ${off ? 'disabled' : ''}><ha-icon icon="mdi:chevron-down"></ha-icon></button>
        </div>
      </div>
      ${this._modesHtml(c, false)}
      ${this._timelineHtml(c)}`;
  }

  /** Betriebsarten (und im Dialog die Presets) eines Thermostats */
  _modesHtml(c, withPresets) {
    const a = c.st.attributes;
    const off = BAD.includes(c.st.state);
    const btn = (act, v, on, label, icon, cls = '') => `<button class="mode ${on ? 'on' : ''} ${cls}" data-act="${act}" data-e="${c.id}" data-v="${esc(v)}" ${off ? 'disabled' : ''}><ha-icon icon="${icon}"></ha-icon>${esc(label)}</button>`;
    const modes = (a.hvac_modes || []).map((m) => {
      const [label, icon] = HVAC[m] || [m, 'mdi:thermostat'];
      return btn('hvac', m, c.st.state === m, label, icon, m === 'off' ? 'off' : '');
    }).join('');
    const presets = withPresets ? (a.preset_modes || []).map((p) => {
      const [label, icon] = PRESET[p] || [p, 'mdi:tune-variant'];
      return btn('preset', p, a.preset_mode === p, label, icon);
    }).join('') : '';
    return `${modes ? `<div class="modes">${modes}</div>` : ''}${presets ? `<div class="modes">${presets}</div>` : ''}`;
  }

  _selectHtml(x) {
    const opts = (x.st.attributes.options || []).map((o) => `<option ${o === x.st.state ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<select data-act="select" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}>${opts}</select>`;
  }

  _deviceParts(d) {
    const rows = [];
    for (const c of d.controls) rows.push(this._toggleRow(c));
    for (const c of d.fans) rows.push(this._toggleRow(c));
    for (const c of d.lights) {
      const b = c.st.attributes.brightness;
      rows.push(this._toggleRow(c, c.st.state === 'on' && b != null ? ` <span class="val">${Math.round(b / 2.55)} %</span>` : ''));
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
    const row = (x, label, digits) => `<div class="row" data-more="${x.id}"><span class="lbl">${esc(label)}</span><span class="val">${
      x.st.attributes.unit_of_measurement ? this._fmt(x.st, digits) : this._val(x.st)}</span></div>`;
    // Leistung und Energie in einem Block, dahinter der Leistungsverlauf (Gesamtleistung zuerst, dann die Phasen)
    const main = this._mainPower(d);
    const prows = [main, ...d.power.filter((p) => p !== main)].filter(Boolean)
      .map((p) => row(p, p === main ? 'Leistung' : p.label));
    if (d.today) prows.push(row(d.today, 'Heute', 2));
    if (d.year) prows.push(row(d.year, 'Jahr', 1));
    if (prows.length) {
      const chart = this._powerChartHtml(d);
      const peak = main && this._tlCache[`pwr:${main.id}`]?.max;
      const tip = chart && peak != null ? ` title="Leistung der letzten ${Number(this._config.history_hours)} h · max ${this._num(peak, 1)} W"` : '';
      rows.push(`<div class="pwr"${tip}>${prows.join('')}${chart}</div>`);
    }
    for (const s of d.sensors.slice(0, this._config.max_sensors)) rows.push(row(s, s.label));

    const chips = [];
    for (const p of d.problems) chips.push(`<span class="chip err" data-more="${p.id}"><ha-icon icon="mdi:alert"></ha-icon>${esc(p.label)}</span>`);
    if (d.upd) {
      chips.push({
        queued: '<span class="chip warn"><ha-icon icon="mdi:timer-sand"></ha-icon>Update in Warteschlange</span>',
        running: '<span class="chip warn"><ha-icon icon="mdi:progress-download"></ha-icon>Kompiliert und flasht …</span>',
        failed: `<span class="chip err" data-act="upd_clear" data-d="${d.id}" title="${esc(d.upd.text)} – klicken zum Ausblenden"><ha-icon icon="mdi:alert"></ha-icon>Update fehlgeschlagen: ${esc(d.upd.text || '')}</span>`,
      }[d.upd.state] || '');
    } else if (d.fwBusy) {
      chips.push('<span class="chip warn"><ha-icon icon="mdi:progress-download"></ha-icon>Update läuft</span>');
    } else if (d.fwAvail) {
      chips.push(d.fw
        ? `<span class="chip warn" ${d.update ? `data-act="update" data-d="${d.id}"` : ''}><ha-icon icon="mdi:package-up"></ha-icon>Update ${esc(d.fwLatest)}</span>`
        : `<span class="chip warn" title="Vergleich mit dem ESPHome Device Builder"><ha-icon icon="mdi:package-up"></ha-icon>Update ${esc(d.fwLatest)}</span>`);
    }
    if (d.canEnable) chips.push(`<span class="chip" data-act="enable" data-d="${d.id}" title="Ohne Update-Entität kann die Karte keine Firmware installieren – klicken zum Aktivieren"><ha-icon icon="mdi:package-variant-plus"></ha-icon>Update-Entität aktivieren</span>`);
    if (!d.online) chips.push('<span class="chip err"><ha-icon icon="mdi:lan-disconnect"></ha-icon>Offline</span>');
    const up = this._uptime(d.uptime?.st);
    if (up && d.online) chips.push(`<span class="chip"><ha-icon icon="mdi:timer-outline"></ha-icon>${esc(up)}</span>`);
    if (d.reason && !BAD.includes(d.reason.st.state) && /watchdog|exception|panic|brown/i.test(d.reason.st.state)) {
      chips.push(`<span class="chip" data-more="${d.reason.id}" title="Grund des letzten Neustarts"><ha-icon icon="mdi:restart-alert"></ha-icon>${esc(d.reason.st.state)}</span>`);
    }

    const canUpdate = d.update && !d.upd && !d.fwBusy;
    const link = this._link(d);
    return {
      name: `${esc(d.name)}<small>${esc(d.area || 'kein Raum')}</small>`,
      meta: `
          <span class="k">Signal</span><span class="v"><ha-icon icon="${this._rssiIcon(d.rssi?.st)}"></ha-icon>${d.rssi ? this._fmt(d.rssi.st, 0) : '–'}</span>
          <span class="k">IP</span><span class="v">${d.ip ? `${esc(d.ip)} <button class="iconbtn" data-act="copy" data-v="${esc(d.ip)}" title="IP kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button>` : '–'}</span>
          <span class="k">Board</span><span class="v">${esc(d.model || '–')}</span>
          <span class="k">Firmware</span><span class="v" title="${esc(d.build ? `gebaut ${d.build}` : '')}">${esc(d.ver || '–')}</span>`,
      chips: chips.join(''),
      thermo: d.climates.map((c) => this._thermoHtml(c, d)).join(''),
      sel: d.selects.map((x) => `<div class="row"><span class="lbl">${esc(x.label)}</span>${this._selectHtml(x)}</div>`).join(''),
      vals: rows.join(''),
      foot: `
          <button class="iconbtn" data-act="web" data-v="${esc(link.href)}" title="${esc(link.title)}" ${link.href ? '' : 'disabled'}><ha-icon icon="${link.icon}"></ha-icon></button>
          <span class="sp"></span>
          <button class="iconbtn ${canUpdate ? 'warn' : ''}" data-act="update" data-d="${d.id}" title="${canUpdate ? `Firmware ${esc(d.fwLatest)} installieren` : d.noEntity ? 'Keine Update-Entität' : 'Firmware aktuell'}" ${canUpdate ? '' : 'disabled'}><ha-icon icon="mdi:update"></ha-icon></button>
          <button class="iconbtn" data-act="reboot" data-e="${d.reboot?.id || ''}" data-n="${esc(d.name)}" title="Neu starten" ${d.reboot && d.online ? '' : 'disabled'}><ha-icon icon="mdi:restart"></ha-icon></button>`,
    };
  }

  /** Weboberfläche des Geräts oder – ohne Webserver – der ESPHome Device Builder */
  _link(d) {
    if (/^https?:/.test(d.url)) return { href: d.url, icon: 'mdi:open-in-new', title: 'Weboberfläche öffnen' };
    if (/^homeassistant:\/\//.test(d.url)) return { href: d.url, icon: 'mdi:hammer-wrench', title: 'ESPHome Device Builder öffnen' };
    return { href: '', icon: 'mdi:open-in-new', title: 'Keine Weboberfläche' };
  }

  _toggleRow(c, extra = '') {
    const on = c.st.state === 'on';
    const dis = BAD.includes(c.st.state);
    return `<div class="row" data-more="${c.id}"><span class="lbl">${esc(c.label)}${extra}</span>
      <button class="tog ${on ? 'on' : ''}" data-act="toggle" data-e="${c.id}" ${dis ? 'disabled' : ''} title="${on ? 'Ausschalten' : 'Einschalten'}"></button></div>`;
  }

  /* ---------- Dialog ---------- */
  _openInfo(id) {
    this._infoId = id;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._infoHtml = '';
    this._renderInfo();
  }

  _closeInfo() {
    this._infoId = null; this._infoHtml = '';
    this._dlg.innerHTML = '';
    this._dlgHost.remove();
  }

  _renderInfo() {
    const host = this._dlg;
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { host.innerHTML = ''; return; }
    const r = d.reg || {};
    const mac = (r.connections || []).find((c) => c[0] === 'mac');
    const good = (x) => (x && !BAD.includes(x.st.state) ? x.st.state : '');
    // Text-Sensor "Device Info": "2026.9.1|Chip: ESP32 …|CPU Frequency: 240 MHz|…"
    const infoRows = good(d.info).split('|').map((p) => p.split(/:\s(.*)/s)).filter((p) => p.length > 1 && p[1])
      .filter(([k]) => !/mac|reset|wakeup/i.test(k)).map(([k, v]) => [k.trim(), v.trim()]);
    const info = [
      ['Hersteller', r.manufacturer], ['Board', d.model], ...infoRows,
      ['Firmware', d.ver], ['Gebaut', d.build || (good(d.versionEnt).match(/built ([^)]+)/) || [])[1]],
      ['Config-Hash', (good(d.versionEnt).match(/config hash (0x[0-9a-f]+)/i) || [])[1]],
      ['Verfügbare Version', d.fwLatest], ['IP-Adresse', d.ip], ['MAC-Adresse', mac && mac[1].toUpperCase()],
      ['Signal', d.rssi && good(d.rssi) ? `${this._num(good(d.rssi), 0)} dBm` : ''], ['Laufzeit', this._uptime(d.uptime?.st)],
      ['Neustartgrund', good(d.reason)], ['Raum', d.area], ['Status', d.online ? 'online' : 'offline'],
    ].filter(([, v]) => v);
    const cat = { meas: [], state: [], set: [], diag: [] };
    const primary = new Set([...d.climates, d.fw, d.reboot, d.versionEnt, d.ipEnt, d.rssi, d.uptime, d.reason, d.info].filter(Boolean).map((x) => x.id));
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (primary.has(x.id) || ['event', 'camera'].includes(dom)) continue;
      if (['number', 'select', 'text', 'time', 'datetime', 'date'].includes(dom) || x.ent.entity_category === 'config') cat.set.push(x);
      else if (x.ent.entity_category === 'diagnostic' || dom === 'button' || /internal_voltage/.test(x.id)) cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de', { numeric: true });
    const ent = (x) => {
      const dom = x.id.split('.')[0];
      let right = `<span class="v">${dom === 'sensor' && x.st.attributes.unit_of_measurement ? this._fmt(x.st) : this._val(x.st)}</span>`;
      if (['switch', 'light', 'fan'].includes(dom)) right = `<button class="tog ${x.st.state === 'on' ? 'on' : ''}" data-act="toggle" data-e="${x.id}" ${BAD.includes(x.st.state) ? 'disabled' : ''}></button>`;
      else if (dom === 'select') right = this._selectHtml(x);
      else if (dom === 'button') right = `<button class="btn sec sm" data-act="press" data-e="${x.id}" data-n="${esc(x.label)}" ${x.st.state === 'unavailable' ? 'disabled' : ''}>Ausführen</button>`;
      return `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span>${right}</div>`;
    };
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const link = this._link(d);
    const canUpdate = d.update && !d.upd && !d.fwBusy;
    const fwHint = d.noEntity
      ? `<div class="hint">Für dieses Gerät gibt es keine aktive Update-Entität${d.canEnable ? ' – sie ist deaktiviert und lässt sich über die Gerätekarte aktivieren' : ''}. Ohne sie ist kein Update aus der Karte möglich.</div>`
      : '';
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${d.icon}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        ${link.href ? `<a class="dlg-web" data-act="web" data-v="${esc(link.href)}"><ha-icon icon="${link.icon}"></ha-icon>${esc(link.title)}</a>` : ''}
        <div class="dlg-b">
          <h4>Gerät</h4>
          ${info.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
          ${d.climates.map((c) => `<h4>${esc(d.climates.length > 1 ? c.label : 'Thermostat')}</h4>${this._modesHtml(c, true)}`).join('')}
          ${fwHint}
          ${sec('Messwerte', cat.meas)}${sec('Zustände', cat.state)}${sec('Einstellungen', cat.set)}${sec('Diagnose', cat.diag)}
        </div>
        <div class="dlg-f">
          ${canUpdate ? `<button class="btn sec" data-act="update" data-d="${d.id}">Firmware ${esc(d.fwLatest)} installieren</button>` : ''}
          <button class="btn" data-act="close">Schließen</button></div>
      </div></div>`;
    if (html === this._infoHtml && host.firstElementChild) return;
    // Kein Neuzeichnen, solange ein Auswahlfeld im Dialog offen ist
    if (this._dlgHost.shadowRoot.activeElement?.tagName === 'SELECT' && host.firstElementChild) return;
    const body = host.querySelector('.dlg-b');
    const scroll = body ? body.scrollTop : 0;
    host.innerHTML = html;
    this._infoHtml = html;
    const nb = host.querySelector('.dlg-b');
    if (nb) nb.scrollTop = scroll;
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

  async _onChange(e) {
    const el = e.target;
    if (el.tagName !== 'SELECT' || el.dataset.act !== 'select') return;
    try {
      await this._hass.callService('select', 'select_option', { entity_id: el.dataset.e, option: el.value });
      el.blur();
    } catch (err) {
      this._toast(`Fehler: ${err.message || err}`);
    }
  }

  /** Solltemperatur schrittweise ändern; mehrere Klicks werden zu einem Aufruf zusammengefasst */
  _stepTemp(eid, dir) {
    const st = this._hass.states[eid];
    if (!st) return;
    const a = st.attributes;
    const step = a.target_temp_step || 0.5;
    const cur = this._pend[eid]?.v ?? a.temperature ?? a.current_temperature ?? 20;
    let v = Math.round((cur + dir * step) / step) * step;
    v = Math.min(a.max_temp ?? 35, Math.max(a.min_temp ?? 5, v));
    clearTimeout(this._pend[eid]?.timer);
    const timer = setTimeout(async () => {
      try {
        await this._hass.callService('climate', 'set_temperature', { entity_id: eid, temperature: v });
      } catch (err) {
        this._toast(`Fehler: ${err.message || err}`);
      }
      // Anzeige noch kurz halten, bis das Gerät den neuen Sollwert meldet
      this._pend[eid] = { v, timer: setTimeout(() => { delete this._pend[eid]; this._refresh(true); }, 4000) };
    }, 700);
    this._pend[eid] = { v, timer };
    this._refresh(true);
  }

  _enqueue(list) {
    for (const d of list) {
      if (this._upd[d.id] && this._upd[d.id].state !== 'failed') continue;
      this._upd[d.id] = { state: 'queued', eid: d.fw.id, name: d.name, latest: d.fwLatest };
      this._queue.push(d.id);
    }
    this._refresh(true);
    this._runQueue();
  }

  /* Ein Gerät nach dem anderen: Kompilieren belastet den Home-Assistant-Host */
  async _runQueue() {
    if (this._running) return;
    this._running = true;
    while (this._queue.length) {
      const id = this._queue.shift();
      const u = this._upd[id];
      if (!u) continue;
      u.state = 'running';
      this._refresh(true);
      try {
        await this._hass.callService('update', 'install', { entity_id: u.eid });
        delete this._upd[id];
        this._toast(`${u.name}: Firmware ${u.latest} installiert`);
      } catch (err) {
        u.state = 'failed';
        u.text = err.message || String(err);
        this._toast(`${u.name}: Update fehlgeschlagen – ${u.text}`);
      }
      this._refresh(true);
    }
    this._running = false;
  }

  _open(href) {
    if (!href) return;
    if (/^homeassistant:\/\//.test(href)) {
      // Link in die Home-Assistant-Oberfläche (z. B. ESPHome Device Builder)
      history.pushState(null, '', `/${href.replace(/^homeassistant:\/\//, '')}`);
      window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
      if (this._infoId) this._closeInfo();
    } else {
      window.open(href, '_blank', 'noopener');
    }
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
        case 'temp': this._stepTemp(ds.e, Number(ds.v)); break;
        case 'hvac': await hass.callService('climate', 'set_hvac_mode', { entity_id: ds.e, hvac_mode: ds.v }); break;
        case 'preset': await hass.callService('climate', 'set_preset_mode', { entity_id: ds.e, preset_mode: ds.v }); break;
        case 'press':
          if (window.confirm(`„${ds.n}“ ausführen?`)) await hass.callService('button', 'press', { entity_id: ds.e });
          break;
        case 'reboot':
          if (window.confirm(`${ds.n} neu starten?`)) { await hass.callService('button', 'press', { entity_id: ds.e }); this._toast(`${ds.n} startet neu`); }
          break;
        case 'update':
          if (d && d.update && !d.fwBusy && (!d.upd || d.upd.state === 'failed') && window.confirm(
            `Firmware ${d.fwLatest} auf ${d.name} installieren?\n\nInstalliert: ${d.ver}\nDer ESPHome Device Builder kompiliert die Firmware und flasht sie per OTA. Das dauert einige Minuten, das Gerät startet danach neu.`)) {
            this._enqueue([d]);
          }
          break;
        case 'update_all': {
          const list = (this._devices || []).filter((x) => x.update && !x.upd && !x.fwBusy);
          if (list.length && window.confirm(`Firmware auf ${list.length} Geräten installieren?\n\n${list.map((x) => `• ${x.name} (${x.ver} → ${x.fwLatest})`).join('\n')}\n\nDie Geräte werden nacheinander kompiliert und geflasht; das dauert pro Gerät einige Minuten. Die Seite dabei geöffnet lassen.`)) {
            this._enqueue(list);
          }
          break;
        }
        case 'upd_clear': delete this._upd[ds.d]; this._refresh(true); break;
        case 'enable': if (d && window.confirm(`Update-Entität für ${d.name} aktivieren?`)) await this._enableUpdate([d.id]); break;
        case 'enable_all': {
          const ids = Object.keys(this._disabled);
          if (ids.length && window.confirm(`Update-Entitäten für ${ids.length} ESPHome-Geräte aktivieren?`)) await this._enableUpdate(ids);
          break;
        }
        case 'web': this._open(ds.v); break;
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

if (!customElements.get('esphome-manager-card')) {
  customElements.define('esphome-manager-card', EsphomeManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'esphome-manager-card', name: 'ESPHome Manager', description: 'Alle ESPHome-Geräte im Stil des ioBroker Device Managers, inkl. Thermostat-Bedienung und Firmware-Update' });
  console.info(`%c ESPHOME-MANAGER-CARD %c ${VERSION} `, 'background:#1c9cd8;color:#fff', 'background:#eee;color:#333');
}
