/*! HA Manager Cards 1.8.1 – 13 Karten: esphome-manager-card, grohe-manager-card, localthings-manager-card, miele-manager-card, pihole-manager-card, proxmox-manager-card, schlueter-manager-card, senec-manager-card, shelly-manager-card, tasmota-manager-card, xsense-manager-card, area-overview-card, home-dashboard-card */

/* ===== esphome-manager-card.js ===== */
{
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
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
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
    const cls = `dev${d.online ? '' : ' offline'}${window.__hmcAct ? window.__hmcAct(this._hass, d.id) : ''}`;
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

}

/* ===== grohe-manager-card.js ===== */
{
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
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
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
        .dev.offline { opacity:.55; }
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
    const cls = `dev${d.online ? '' : ' offline'}${d.valve?.st.state === 'closed' ? ' alarm' : ''}`;
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

}

/* ===== localthings-manager-card.js ===== */
{
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
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
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
        .dev.offline { opacity:.55; }
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
    const cls = `dev${d.online ? '' : ' offline'}${d.active ? ' active' : ''}${faulty ? ' fault' : ''}`;
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

}

/* ===== miele-manager-card.js ===== */
{
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
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
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
        .dev.offline { opacity:.55; }
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
    const cls = `dev${d.online ? '' : ' offline'}${d.active ? ' active' : ''}${faulty ? ' fault' : ''}`;
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

}

/* ===== pihole-manager-card.js ===== */
{
/*
 * Pi-hole Manager Card – Übersicht über alle Pi-hole-Instanzen im Stil der übrigen Manager Cards
 * (Shelly, Tasmota, ESPHome, …). Liest alle Geräte der Pi-hole-Integration live aus der Registry,
 * neue Instanzen erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:pihole-manager-card
 *   integration: pi_hole        # Plattform der Entitäten
 *   min_width: 320              # Mindestbreite einer Kachel in px
 *   pause: [5, 30, 60]          # Pausen-Buttons in Minuten
 *   confirm: true               # Rückfrage vor Ausschalten/Pausieren
 */
{
const VERSION = '1.0.0';
const BAD = ['unavailable', 'unknown'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 0) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
const keyOf = (ent) => `${ent.translation_key || ''} ${ent.entity_id}`.toLowerCase();

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

const STYLE = `
  :host { display:block; padding:12px; box-sizing:border-box; }
  * { box-sizing:border-box; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px;
    background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px); margin-bottom:12px; }
  .toolbar .title { font-size:20px; font-weight:500; margin-right:auto; display:flex; align-items:center; gap:8px; }
  .toolbar input, .toolbar select { background: rgba(255,255,255,.12); color: inherit; border: 1px solid rgba(255,255,255,.3);
    border-radius: 8px; padding: 6px 10px; font: inherit; font-size:14px; }
  .toolbar select option { color: var(--primary-text-color); background: var(--card-background-color); }
  .toolbar input::placeholder { color: rgba(255,255,255,.7); }
  .stats { font-size:13px; opacity:.9; width:100%; display:flex; gap:16px; flex-wrap:wrap; }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(var(--phc-min, 320px), 1fr)); }
  .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
  .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
  .head { display:flex; align-items:center; gap:12px; padding:14px 14px 6px; }
  .ico { position:relative; width:44px; height:44px; border-radius:10px; background: var(--secondary-background-color);
    display:flex; align-items:center; justify-content:center; flex:none; }
  .ico ha-icon { --mdc-icon-size:28px; color: #96060c; }
  .dev.paused .ico ha-icon { color: var(--warning-color, #ffa600); }
  .dot { position:absolute; right:-3px; bottom:-3px; width:14px; height:14px; border-radius:50%;
    border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
  .dev.paused .dot { background: var(--warning-color, #ffa600); }
  .offline .dot { background: var(--error-color, #db4437); }
  .name { font-size:17px; font-weight:600; line-height:1.2; flex:1; min-width:0; overflow-wrap:anywhere; }
  .name small { display:block; font-size:12px; font-weight:400; color: var(--secondary-text-color); }
  .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
  .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .iconbtn[disabled] { opacity:.35; cursor:default; }
  .kpis { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; padding: 6px 14px 4px; }
  .kpi { background: var(--secondary-background-color); border-radius:10px; padding:8px 10px; cursor:pointer; min-width:0; }
  .kpi b { display:block; font-size:18px; font-variant-numeric: tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .kpi span { font-size:12px; color: var(--secondary-text-color); }
  .kpi.blk b { color: #e53935; }
  .pbar { margin: 6px 14px 2px; height:8px; border-radius:4px; background: var(--divider-color); overflow:hidden; cursor:pointer; }
  .pbar i { display:block; height:100%; background: linear-gradient(90deg, #e53935, #ff7043); border-radius:4px; }
  .pl { display:flex; justify-content:space-between; padding: 2px 14px 0; font-size:12px; color: var(--secondary-text-color); }
  .meta { padding: 8px 14px 8px; display:grid; grid-template-columns: auto 1fr; column-gap:12px; row-gap:2px; font-size:13px; }
  .meta .k { color: var(--secondary-text-color); }
  .meta .v { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric: tabular-nums; cursor:pointer; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; padding: 0 14px 8px; }
  .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
    display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
  .chip ha-icon { --mdc-icon-size:14px; }
  .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
  .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
  .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
  .foot { display:flex; align-items:center; gap:4px; padding:6px 10px; border-top:1px solid var(--divider-color);
    background: var(--secondary-background-color); margin-top:auto; flex-wrap:wrap; }
  .foot .sp { flex:1; }
  .pbtn { background:none; border:1px solid var(--divider-color); border-radius:8px; padding:4px 8px; font: inherit; font-size:12px; cursor:pointer;
    color: var(--primary-text-color); display:inline-flex; align-items:center; gap:4px; }
  .pbtn ha-icon { --mdc-icon-size:16px; }
  .pbtn:hover { background: var(--card-background-color); }
  .pbtn[disabled] { opacity:.4; cursor:default; }
  .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
    border:none; cursor:pointer; flex:none; transition: background .15s; }
  .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
  .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
  .tog.on::after { left:21px; }
  .tog[disabled] { opacity:.4; cursor:default; }
  .tl { font-size:12px; color: var(--secondary-text-color); margin-right:4px; }
  .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
  [hidden] { display:none !important; }
  .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
  .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
    max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
  .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
  .dlg-h ha-icon { --mdc-icon-size:30px; color:#96060c; }
  .dlg-web { display:flex; align-items:center; justify-content:center; gap:8px; margin: 0 20px 8px; padding:8px; border-radius:8px;
    color: var(--primary-color); text-decoration:none; font-weight:500; border:1px solid var(--divider-color); }
  .dlg-web:hover { background: var(--secondary-background-color); }
  .dlg-b { overflow:auto; padding: 0 20px 16px; }
  .dlg-b h4 { margin: 14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
  .kv { display:flex; justify-content:space-between; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
  .kv:last-child { border-bottom:none; }
  .kv .k { font-weight:600; }
  .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
  .kv.e { cursor:pointer; } .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
  .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
  .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
`;

class PiholeManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'pi_hole', min_width: 320, pause: [5, 30, 60], confirm: true, ...config };
    this._filter = this._filter || '';
    this._view = this._view || 'all';
    if (!this.shadowRoot) { this.attachShadow({ mode: 'open' }); this._buildShell(); }
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'pi_hole' }; }

  set hass(hass) {
    this._hass = hass;
    this._devices = this._collect();
    this._renderGrid();
    if (this._infoId) this._renderInfo();
  }

  disconnectedCallback() { if (this._dlgHost) this._closeInfo(); }

  /* ---------- Daten ---------- */
  _collect() {
    const hass = this._hass;
    if (!hass || !hass.entities || !hass.devices) return [];
    const byDev = {};
    for (const ent of Object.values(hass.entities)) {
      if (ent.platform !== this._config.integration || !ent.device_id || ent.hidden) continue;
      (byDev[ent.device_id] ||= []).push(ent);
    }
    const out = [];
    for (const [id, ents] of Object.entries(byDev)) {
      const reg = hass.devices[id];
      if (!reg || reg.disabled_by) continue;
      const d = {
        id, reg, name: (reg.name_by_user || reg.name || id).trim(), url: reg.configuration_url || '', host: '',
        sw: reg.sw_version || '', area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '',
        sw_: null, status: null, queries: null, blocked: null, percent: null, clients: null, seenClients: null,
        domains: null, cached: null, forwarded: null, uniqueDomains: null, updates: [], all: [], online: false,
      };
      try { d.host = d.url ? new URL(d.url).host : ''; } catch (e) { /* ignore */ }
      let unav = 0;
      for (const ent of ents) {
        const st = hass.states[ent.entity_id];
        if (!st) continue;
        if (st.state === 'unavailable') unav++;
        const dom = ent.entity_id.split('.')[0];
        const k = keyOf(ent);
        const item = { id: ent.entity_id, st, ent, label: this._label(ent, st, d.name) };
        d.all.push(item);
        if (dom === 'switch' && !ent.entity_category) d.sw_ = d.sw_ || item;
        else if (dom === 'binary_sensor' && /status/.test(k)) d.status = item;
        else if (dom === 'update') d.updates.push(item);
        else if (dom === 'sensor') {
          if (/percent/.test(k)) d.percent = item;
          else if (/cached/.test(k)) d.cached = item;
          else if (/forwarded/.test(k)) d.forwarded = item;
          else if (/unique_domains/.test(k)) d.uniqueDomains = item;
          else if (/domains/.test(k)) d.domains = item;
          else if (/seen|ever/.test(k)) d.seenClients = item;
          else if (/client/.test(k)) d.clients = item;
          else if (/blocked/.test(k)) d.blocked = item;
          else if (/quer/.test(k)) d.queries = item;
        }
      }
      d.online = d.all.length > 0 && unav < d.all.length;
      d.enabled = d.sw_ ? d.sw_.st.state === 'on' : d.status ? d.status.st.state === 'on' : null;
      d.updAvail = d.updates.filter((u) => u.st.state === 'on');
      out.push(d);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  _label(ent, st, devName) {
    let n = ent.name || st.attributes.friendly_name || ent.entity_id;
    if (n.startsWith(devName)) n = n.slice(devName.length).trim();
    return n || devName;
  }

  _n(item) { if (!item || BAD.includes(item.st.state)) return null; const v = parseFloat(item.st.state); return Number.isNaN(v) ? null : v; }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    const u = st.attributes.unit_of_measurement;
    return esc(u ? `${st.state} ${u}` : st.state);
  }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:pi-hole"></ha-icon>Pi-hole</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view"><option value="all">Alle</option><option value="on">Blockieren aktiv</option><option value="off">Pausiert/aus</option>
          <option value="update">Update verfügbar</option><option value="offline">Offline</option></select>
        <div class="stats" id="stats"></div>
      </div>
      <div class="grid" id="grid"></div>`;
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><div id="dlg"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('dlg');
    const root = this.shadowRoot;
    root.getElementById('q').addEventListener('input', (e) => { this._filter = e.target.value.toLowerCase(); this._renderGrid(); });
    root.getElementById('view').addEventListener('change', (e) => { this._view = e.target.value; this._renderGrid(); });
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
  }

  _renderGrid() {
    const root = this.shadowRoot;
    if (!root || !this._devices) return;
    root.host.style.setProperty('--phc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (f && !`${d.name} ${d.host} ${d.area}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'on': return d.enabled === true;
        case 'off': return d.enabled === false;
        case 'update': return d.updAvail.length > 0;
        case 'offline': return !d.online;
        default: return true;
      }
    });
    const sum = (k) => all.reduce((s, d) => s + (this._n(d[k]) || 0), 0);
    const q = sum('queries'); const b = sum('blocked');
    const upd = all.filter((d) => d.updAvail.length).length;
    morph(root.getElementById('stats'), `<span>${all.length} Pi-hole${all.length === 1 ? '' : 's'}</span>
      <span>${all.filter((d) => d.enabled).length} blockieren</span>
      ${all.some((d) => d.enabled === false) ? `<span>${all.filter((d) => d.enabled === false).length} pausiert/aus</span>` : ''}
      <span>Σ ${nf(q)} Abfragen</span><span>Σ ${nf(b)} blockiert${q ? ` (${nf((b / q) * 100, 1)} %)` : ''}</span>
      ${upd ? `<span>${upd} mit Update</span>` : ''}`);
    const html = list.length ? list.map((d) => this._tile(d)).join('') : '<div class="empty">Keine Pi-hole-Instanzen gefunden.</div>';
    if (html !== this._gridHtml) { morph(root.getElementById('grid'), html); this._gridHtml = html; }
  }

  _tile(d) {
    const pct = this._n(d.percent);
    const kpi = (item, label, cls = '', digits = 0) => `<div class="kpi ${cls}" ${item ? `data-more="${item.id}"` : ''}><b>${this._n(item) != null ? nf(this._n(item), digits) : '–'}</b><span>${label}</span></div>`;
    const metaRow = (k, item, digits = 0) => (item ? `<span class="k">${k}</span><span class="v" data-more="${item.id}">${this._n(item) != null ? nf(this._n(item), digits) : this._val(item.st)}</span>` : '');
    const chips = [];
    for (const u of d.updAvail) chips.push(`<span class="chip warn" data-more="${u.id}"><ha-icon icon="mdi:package-up"></ha-icon>${esc(u.label.replace(/update|aktualisierung/ig, '').trim() || 'Update')} ${esc(u.st.attributes.latest_version || '')}</span>`);
    if (d.updates.length && !d.updAvail.length) chips.push('<span class="chip ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon>aktuell</span>');
    if (d.enabled === false) chips.push(`<span class="chip warn" ${d.sw_ ? `data-more="${d.sw_.id}"` : ''}><ha-icon icon="mdi:pause-circle-outline"></ha-icon>Blockieren pausiert</span>`);
    if (!d.online) chips.push('<span class="chip err"><ha-icon icon="mdi:lan-disconnect"></ha-icon>nicht erreichbar</span>');
    const can = d.sw_ && !BAD.includes(d.sw_.st.state);
    const pauses = (this._config.pause || []).map((m) => `<button class="pbtn" data-act="pause" data-e="${d.sw_?.id || ''}" data-m="${m}" data-n="${esc(d.name)}" ${can && d.enabled ? '' : 'disabled'} title="Blockieren ${m} min pausieren"><ha-icon icon="mdi:timer-pause-outline"></ha-icon>${m}′</button>`).join('');
    const cls = `dev${d.online ? '' : ' offline'}${d.enabled === false ? ' paused' : ''}${window.__hmcCls ? window.__hmcCls(this._hass, d.online && d.enabled !== false ? 'srv' : '', true) : ''}`;
    return `<div class="${cls}" data-k="${d.id}">
      <div class="head"><div class="ico"><ha-icon icon="mdi:pi-hole"></ha-icon><span class="dot"></span></div>
        <div class="name">${esc(d.name)}<small>${esc([d.host, d.area].filter(Boolean).join(' · ') || 'Pi-hole')}</small></div>
        <button class="iconbtn" data-act="info" data-d="${d.id}" title="Details"><ha-icon icon="mdi:dots-vertical"></ha-icon></button></div>
      <div class="kpis">${kpi(d.queries, 'Abfragen heute')}${kpi(d.blocked, 'Blockiert', 'blk')}${kpi(d.clients, 'Clients')}</div>
      <div class="pbar" ${d.percent ? `data-more="${d.percent.id}"` : ''}><i style="width:${pct != null ? Math.min(100, Math.max(0, pct)).toFixed(1) : 0}%"></i></div>
      <div class="pl"><span>blockiert</span><span>${pct != null ? `${nf(pct, 1)} %` : '–'}</span></div>
      <div class="meta">${metaRow('Blockliste', d.domains)}${metaRow('Aus dem Cache', d.cached)}${metaRow('Weitergeleitet', d.forwarded)}${metaRow('Domains', d.uniqueDomains)}${metaRow('Clients gesamt', d.seenClients)}
        ${d.sw ? `<span class="k">Version</span><span class="v">${esc(d.sw)}</span>` : ''}</div>
      <div class="chips" ${chips.length ? '' : 'hidden'}>${chips.join('')}</div>
      <div class="foot">
        <button class="iconbtn" data-act="web" data-v="${esc(d.url)}" title="Weboberfläche öffnen" ${d.url ? '' : 'disabled'}><ha-icon icon="mdi:open-in-new"></ha-icon></button>
        ${pauses}<span class="sp"></span>
        <span class="tl">${d.enabled ? 'Blockieren' : 'Aus'}</span>
        <button class="tog ${d.enabled ? 'on' : ''}" data-act="toggle" data-e="${d.sw_?.id || ''}" data-on="${d.enabled ? 1 : 0}" data-n="${esc(d.name)}" ${can ? '' : 'disabled'}
          title="${d.enabled ? 'Blockieren ausschalten' : 'Blockieren einschalten'}"></button></div></div>`;
  }

  _openInfo(id) {
    this._infoId = id;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._renderInfo();
  }

  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _renderInfo() {
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { this._dlg.innerHTML = ''; return; }
    const r = d.reg || {};
    const info = [['Hersteller', r.manufacturer], ['Modell', r.model], ['Version', r.sw_version], ['Adresse', d.host], ['Bereich', d.area],
      ['Status', d.online ? (d.enabled === false ? 'online, Blockieren aus' : 'online, blockiert') : 'offline']].filter(([, v]) => v);
    const cat = { meas: [], state: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (x.ent.entity_category === 'diagnostic' || dom === 'update' || dom === 'button') cat.diag.push(x);
      else if (dom === 'sensor') cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span><span class="v">${this._val(x.st)}</span></div>`;
    const sec = (t, l) => (l.length ? `<h4>${t}</h4>${l.sort(sortL).map(ent).join('')}` : '');
    const html = `<div class="dlg-bg"><div class="dlg" role="dialog">
      <div class="dlg-h"><ha-icon icon="mdi:pi-hole"></ha-icon><span class="t">${esc(d.name)}</span>
        <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      ${d.url ? `<a class="dlg-web" href="${esc(d.url)}" target="_blank" rel="noopener"><ha-icon icon="mdi:web"></ha-icon>Weboberfläche öffnen</a>` : ''}
      <div class="dlg-b"><h4>Gerät</h4>${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
        ${sec('Statistik', cat.meas)}${sec('Zustände', cat.state)}${sec('Diagnose', cat.diag)}</div>
      <div class="dlg-f"><button class="btn" data-act="close">Schließen</button></div></div></div>`;
    if (html === this._infoHtml && this._dlg.firstElementChild) return;
    const body = this._dlg.querySelector('.dlg-b'); const scroll = body ? body.scrollTop : 0;
    if (this._dlg.firstElementChild) morph(this._dlg, html); else this._dlg.innerHTML = html;
    this._infoHtml = html;
    const nb = this._dlg.querySelector('.dlg-b'); if (nb) nb.scrollTop = scroll;
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const btn = path.find((el) => el.dataset && el.dataset.act);
    if (btn) { e.stopPropagation(); if (!btn.disabled) this._action(btn.dataset); return; }
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  async _action(ds) {
    const hass = this._hass;
    try {
      switch (ds.act) {
        case 'toggle':
          if (!ds.e) break;
          if (ds.on === '1' && this._config.confirm && !window.confirm(`Blockieren auf ${ds.n} ausschalten?`)) break;
          await hass.callService('switch', ds.on === '1' ? 'turn_off' : 'turn_on', { entity_id: ds.e });
          break;
        case 'pause': {
          if (!ds.e) break;
          const m = Number(ds.m);
          if (this._config.confirm && !window.confirm(`Blockieren auf ${ds.n} für ${m} Minuten pausieren?`)) break;
          const hh = String(Math.floor(m / 60)).padStart(2, '0'); const mm = String(m % 60).padStart(2, '0');
          await hass.callService('pi_hole', 'disable', { entity_id: ds.e, duration: `${hh}:${mm}:00` });
          this._fire('hass-notification', { message: `${ds.n}: Blockieren für ${m} Minuten pausiert` });
          break;
        }
        case 'web': if (ds.v) window.open(ds.v, '_blank', 'noopener'); break;
        case 'info': this._openInfo(ds.d); break;
        case 'close': this._closeInfo(); break;
        default: break;
      }
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
    }
  }

  _fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
}

if (!customElements.get('pihole-manager-card')) {
  customElements.define('pihole-manager-card', PiholeManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'pihole-manager-card', name: 'Pi-hole Manager', description: 'Alle Pi-hole-Instanzen im Stil des ioBroker Device Managers' });
  console.info(`%c PIHOLE-MANAGER-CARD %c ${VERSION} `, 'background:#96060c;color:#fff', 'background:#eee;color:#333');
}
}

}

/* ===== proxmox-manager-card.js ===== */
{
/*
 * Proxmox Manager Card – Übersicht über Nodes, VMs und LXC-Container im Stil des ioBroker Device Managers
 * (Gegenstück zur Shelly-, Tasmota-, ESPHome- und X-Sense Manager Card).
 * Liest alle Geräte der Proxmox-VE-Integration (proxmoxve) live aus der Geräte-/Entitäts-Registry,
 * neue Nodes, VMs und Container erscheinen automatisch. Keine weiteren Abhängigkeiten.
 *
 * Konfiguration (alle optional):
 *   type: custom:proxmox-manager-card
 *   integration: proxmoxve     # Plattform der Entitäten
 *   min_width: 320             # Mindestbreite einer Kachel in px
 *   warn: 80                   # Warnschwelle CPU/RAM/Disk/Storage in %
 *   crit: 95                   # kritische Schwelle in %
 *   show_storage: true         # Storages in der Node-Kachel anzeigen
 *   confirm: true              # Rückfrage vor Stoppen/Herunterfahren/Neustart
 */
const VERSION = '1.0.0';
const BAD = ['unavailable', 'unknown'];
const TYPE = { node: 'Node', vm: 'VM', lxc: 'LXC', storage: 'Storage' };
const TYPE_ICON = { node: 'mdi:server', vm: 'mdi:monitor', lxc: 'mdi:cube-outline', storage: 'mdi:database' };
const STATUS_TEXT = {
  online: 'Online', offline: 'Offline', running: 'Läuft', stopped: 'Gestoppt', suspended: 'Angehalten',
  paused: 'Angehalten', unknown: 'Unbekannt',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const stName = (n) => String(n).replace(/^Storage\s*\(?/i, '').replace(/\)$/, '') || n;
const nf = (v, d = 2) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });

class ProxmoxManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'proxmoxve', min_width: 240, warn: 80, crit: 95, show_storage: true, confirm: true, ...config };
    this._filter = this._filter || '';
    this._sort = this._sort || 'node';
    this._view = this._view || 'all';
    this._type = this._type || 'all';
    this._sig = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this._buildShell();
    }
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'proxmoxve' }; }

  set hass(hass) {
    this._hass = hass;
    const devices = this._collect();
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
    this._devices = devices;
    if (this._infoId) this._renderInfo();
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderGrid();
  }

  connectedCallback() {
    // Laufzeit ("1 d 8 h") läuft auch ohne Zustandsänderung weiter
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
    const all = [];
    for (const [devId, ents] of Object.entries(byDevice)) {
      const reg = hass.devices[devId];
      if (!reg || reg.disabled_by) continue;
      const d = this._device(devId, reg, ents);
      if (d) all.push(d);
    }
    // Storages den Nodes zuordnen
    const nodes = Object.fromEntries(all.filter((d) => d.type === 'node').map((d) => [d.id, d]));
    for (const s of all.filter((d) => d.type === 'storage')) {
      const n = nodes[s.reg.via_device_id];
      if (n) n.storages.push(s);
    }
    const out = all.filter((d) => d.type !== 'storage');
    for (const d of out) {
      d.storages.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      this._warnings(d);
      d.sig = d.all.map((x) => x.st.state).join('|') + d.storages.map((s) => s.all.map((x) => x.st.state).join('|')).join('#');
    }
    return out;
  }

  _device(devId, reg, ents) {
    const hass = this._hass;
    const model = String(reg.model || '').toLowerCase();
    const ident = (reg.identifiers || []).map((i) => String(i[1])).join(' ');
    let type = 'lxc';
    if (model === 'node' || /_node_/.test(ident) || !reg.via_device_id) type = 'node';
    else if (model === 'storage' || /_storage_/.test(ident)) type = 'storage';
    else if (model === 'vm' || model === 'qemu' || /_(vm|qemu)_\d+/.test(ident)) type = 'vm';
    const vm = ident.match(/_(?:container|lxc|vm|qemu)_(\d+)/);
    const via = reg.via_device_id && hass.devices[reg.via_device_id];
    const d = {
      id: devId, reg, type,
      name: (reg.name_by_user || reg.name || devId).trim(),
      vmid: vm ? Number(vm[1]) : null,
      node: type === 'node' ? (reg.name_by_user || reg.name || '') : (via ? (via.name_by_user || via.name || '') : ''),
      nodeId: type === 'node' ? devId : (reg.via_device_id || ''),
      area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '',
      url: reg.configuration_url || '',
      status: null, run: null, cpu: null, cpuMax: null, memPct: null, memUsed: null, memMax: null,
      diskPct: null, diskUsed: null, diskMax: null, netIn: null, netOut: null, uptime: null,
      backup: null, backupLast: null, backupDur: null, update: null,
      stUsed: null, stTotal: null, stFree: null, stPct: null, stActive: null, stEnabled: null, stShared: null,
      btn: {}, all: [], storages: [], warnings: [], online: false, running: false,
    };
    for (const ent of ents) {
      const st = hass.states[ent.entity_id];
      if (!st) continue;
      const id = ent.entity_id;
      const domain = id.split('.')[0];
      const unit = st.attributes.unit_of_measurement || '';
      const pct = unit === '%';
      const label = this._label(ent, st, d.name);
      // Zuordnung über Entitätsname/Übersetzungsschlüssel (deutsch und englisch), nicht über die Entitäts-ID
      const key = `${slug(label)} ${slug(ent.translation_key)}`;
      const item = { id, label, st, ent };
      d.all.push(item);
      switch (domain) {
        case 'binary_sensor':
          if (/backup/.test(key)) d.backup = item;
          else if (/geteilt|shared/.test(key)) d.stShared = item;
          else if (/aktiviert|enabled/.test(key)) d.stEnabled = item;
          else if (/aktiv|active/.test(key)) d.stActive = item;
          else if (/status|running|online/.test(key)) d.run = item;
          break;
        case 'sensor':
          if (/letztes.?backup|last.?backup/.test(key)) d.backupLast = item;
          else if (/backup/.test(key)) d.backupDur = item;
          else if (/maximale.?cpu|max.?cpu|cpu.?max/.test(key)) d.cpuMax = item;
          else if (/cpu/.test(key)) d.cpu = item;
          else if (/maximale.?arbeitsspeicher|max.?mem|memory.?max/.test(key)) d.memMax = item;
          else if (/arbeitsspeicher|memory|\bram\b/.test(key)) { if (pct) d.memPct = item; else d.memUsed = item; }
          else if (/maximale.?massenspeicher|max.?disk|disk.?max/.test(key)) d.diskMax = item;
          else if (/massenspeicher|disk/.test(key)) { if (pct) d.diskPct = item; else d.diskUsed = item; }
          else if (/eingang|net.?in|network.?in/.test(key)) d.netIn = item;
          else if (/ausgang|net.?out|network.?out/.test(key)) d.netOut = item;
          else if (/betriebszeit|uptime/.test(key)) d.uptime = item;
          else if (/speicherauslastung|usage.?percent|prozent/.test(key)) d.stPct = item;
          else if (/belegt|used/.test(key)) d.stUsed = item;
          else if (/gesamt|total/.test(key)) d.stTotal = item;
          else if (/verfugbar|avail|free/.test(key)) d.stFree = item;
          else if (/status/.test(key)) d.status = item;
          break;
        case 'button': {
          const b = d.btn;
          if (/alle.?start|start.?all/.test(key)) b.startAll = item;
          else if (/alle.?stop|stop.?all/.test(key)) b.stopAll = item;
          else if (/alle.?susp|suspend.?all/.test(key)) b.suspendAll = item;
          else if (/snapshot/.test(key)) b.snapshot = item;
          else if (/neu.?start|reboot|restart/.test(key)) b.reboot = item;
          else if (/herunterfahren|shutdown/.test(key)) b.shutdown = item;
          else if (/zurucksetzen|reset/.test(key)) b.reset = item;
          else if (/ruhezustand|hibernat/.test(key)) b.hibernate = item;
          else if (/fortsetzen|resume/.test(key)) b.resume = item;
          else if (/anhalten|suspend|pause/.test(key)) b.suspend = item;
          else if (/stopp|stop/.test(key)) b.stop = item;
          else if (/start/.test(key)) b.start = item;
          break;
        }
        case 'update': d.update = item; break;
        default: break;
      }
    }
    if (!d.all.length) return null;
    const s = d.status && !BAD.includes(d.status.st.state) ? d.status.st.state : null;
    if (type === 'storage') {
      d.online = !d.stActive || d.stActive.st.state === 'on';
      d.running = d.online;
    } else if (type === 'node') {
      d.online = s ? s === 'online' : d.run ? d.run.st.state === 'on' : d.all.some((x) => !BAD.includes(x.st.state));
      d.running = d.online;
      d.state = d.online ? 'online' : 'offline';
    } else {
      d.state = s || (d.run ? (d.run.st.state === 'on' ? 'running' : d.run.st.state === 'off' ? 'stopped' : 'unknown') : 'unknown');
      d.running = d.state === 'running';
      d.online = d.state !== 'unknown';
    }
    return d;
  }

  _warnings(d) {
    const { warn, crit } = this._config;
    const lvl = (v) => (v == null ? '' : v >= crit ? 'err' : v >= warn ? 'warn' : '');
    if (d.type === 'node' && !d.online) d.warnings.push({ item: d.status || d.run, text: 'Node offline', cls: 'err', icon: 'mdi:server-off' });
    if (d.running) {
      const cpu = this._num(d.cpu); const mem = this._memPct(d); const disk = this._diskPct(d);
      if (lvl(cpu)) d.warnings.push({ item: d.cpu, text: `CPU ${nf(cpu, 0)} %`, cls: lvl(cpu), icon: 'mdi:cpu-64-bit' });
      if (lvl(mem)) d.warnings.push({ item: d.memPct || d.memUsed, text: `RAM ${nf(mem, 0)} %`, cls: lvl(mem), icon: 'mdi:memory' });
      if (lvl(disk)) d.warnings.push({ item: d.diskPct || d.diskUsed, text: `Disk ${nf(disk, 0)} %`, cls: lvl(disk), icon: 'mdi:harddisk' });
    }
    for (const s of d.storages) {
      const v = this._stPct(s);
      if (lvl(v)) d.warnings.push({ item: s.stPct || s.stUsed, text: `${stName(s.name)} ${nf(v, 0)} %`, cls: lvl(v), icon: 'mdi:database-alert-outline' });
      if (s.stActive && s.stActive.st.state === 'off' && (!s.stEnabled || s.stEnabled.st.state === 'on')) {
        d.warnings.push({ item: s.stActive, text: `${stName(s.name)} inaktiv`, cls: 'err', icon: 'mdi:database-off-outline' });
      }
    }
    if (d.update?.st.state === 'on') {
      d.warnings.push({ item: d.update, text: `Update ${d.update.st.attributes.latest_version || ''}`.trim(), cls: 'warn', icon: 'mdi:package-up' });
    }
    if (d.backup && !BAD.includes(d.backup.st.state)) {
      const problem = d.backup.st.attributes.device_class === 'problem' ? d.backup.st.state === 'on' : d.backup.st.state === 'off';
      if (problem) d.warnings.push({ item: d.backup, text: 'Backup fehlgeschlagen', cls: 'err', icon: 'mdi:backup-restore' });
    }
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

  /** Datenmenge in GiB (Einheit aus der Entität) */
  _gib(item) {
    const v = this._num(item);
    if (v == null) return null;
    const u = String(item.st.attributes.unit_of_measurement || 'GiB');
    const f = { B: 1 / 1073741824, kB: 1e3 / 1073741824, KiB: 1 / 1048576, MB: 1e6 / 1073741824, MiB: 1 / 1024, GB: 1e9 / 1073741824, GiB: 1, TB: 1e12 / 1073741824, TiB: 1024 }[u];
    return f ? v * f : v;
  }

  _size(gib) {
    if (gib == null) return '–';
    if (gib >= 1024) return `${nf(gib / 1024, 2)} TiB`;
    if (gib < 1) return `${nf(gib * 1024, 0)} MiB`;
    return `${nf(gib, 1)} GiB`;
  }

  _memPct(d) {
    const p = this._num(d.memPct);
    if (p != null) return p;
    const u = this._gib(d.memUsed); const m = this._gib(d.memMax);
    return u != null && m ? (u / m) * 100 : null;
  }

  _diskPct(d) {
    const p = this._num(d.diskPct);
    if (p != null) return p;
    const u = this._gib(d.diskUsed); const m = this._gib(d.diskMax);
    return u != null && m ? (u / m) * 100 : null;
  }

  _stPct(s) {
    const p = this._num(s.stPct);
    if (p != null) return p;
    const u = this._gib(s.stUsed); const t = this._gib(s.stTotal);
    return u != null && t ? (u / t) * 100 : null;
  }

  /** Zustand als Klartext (übersetzt, mit Einheit) – noch nicht HTML-maskiert */
  _plain(st) {
    if (!st || BAD.includes(st.state)) return '–';
    if (typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st);
    const unit = st.attributes.unit_of_measurement;
    return unit ? `${st.state} ${unit}` : st.state;
  }

  _val(st) { return esc(this._plain(st)); }

  /** Laufzeit aus dem Startzeitpunkt (Sensor "Betriebszeit") */
  _uptimeMs(d) {
    if (!d.running || !d.uptime || BAD.includes(d.uptime.st.state)) return null;
    const t = new Date(d.uptime.st.state).getTime();
    if (Number.isNaN(t)) {
      const s = parseFloat(d.uptime.st.state); // Fallback: Sekunden
      return Number.isNaN(s) ? null : s * 1000;
    }
    return Math.max(0, Date.now() - t);
  }

  _dur(ms) {
    if (ms == null) return '–';
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ${min % 60} min`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  _dateTitle(st) {
    if (!st || BAD.includes(st.state)) return '';
    const dt = new Date(st.state);
    return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleString('de-DE');
  }

  _lvl(v) {
    if (v == null) return '';
    return v >= this._config.crit ? 'err' : v >= this._config.warn ? 'warn' : 'ok';
  }

  _cores(d) {
    const v = this._num(d.cpuMax);
    return v != null && v > 0 ? v : null;
  }

  _modelLine(d) {
    if (d.type === 'node') {
      const ver = d.update?.st.attributes.installed_version;
      return ['Proxmox VE' + (ver ? ` ${ver}` : ''), this._cores(d) && `${nf(this._cores(d), 0)} CPU`, this._gib(d.memMax) != null && this._size(this._gib(d.memMax))].filter(Boolean).join(' · ');
    }
    return [d.type === 'vm' ? 'QEMU' : 'LXC', this._cores(d) && `${nf(this._cores(d), 0)} vCPU`, this._gib(d.memMax) != null && this._size(this._gib(d.memMax))].filter(Boolean).join(' · ');
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
        .grid { display:grid; gap:8px; grid-template-columns: repeat(auto-fill, minmax(var(--pmc-min, 240px), 1fr)); }
        .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
        .dev.offline .head, .dev.offline .stat, .dev.offline .meta { opacity:.6; }
        .head { display:flex; align-items:center; gap:10px; padding:10px 8px 4px 10px; }
        .ico { position:relative; width:34px; height:34px; border-radius:8px; background: var(--success-color, #43a047);
          display:flex; align-items:center; justify-content:center; flex:none; }
        .ico ha-icon { --mdc-icon-size:22px; color:#fff; }
        .dev.stopped .ico { background: var(--disabled-color, #9e9e9e); }${window.__hmcActCss || ''}
        .dev.offline .ico { background: var(--error-color, #db4437); }
        .dot { position:absolute; right:-3px; bottom:-3px; width:11px; height:11px; border-radius:50%;
          border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
        .dev.stopped .dot { display:none; }
        .dev.offline .dot { background: var(--error-color, #db4437); }
        .name { font-size:15px; font-weight:600; line-height:1.2; flex:1; min-width:0; overflow-wrap:anywhere; }
        .name small { display:block; font-size:11px; font-weight:400; color: var(--secondary-text-color); }
        .iconbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:6px; border-radius:50%; line-height:0; }
        .iconbtn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .stat { display:flex; flex-wrap:wrap; gap:2px 6px; padding: 4px 10px 2px; font-size:12px; }
        .s { display:inline-flex; align-items:center; gap:3px; padding:1px 5px; border-radius:8px; cursor:pointer; white-space:nowrap;
          font-variant-numeric: tabular-nums; color: var(--success-color, #43a047); }
        .s ha-icon { --mdc-icon-size:15px; }
        .s.info { color: var(--info-color, var(--primary-color)); }
        .s.mute { color: var(--secondary-text-color); }
        .s.warn { color: var(--warning-color, #ffa600); background: rgba(255,166,0,.15); }
        .s.err { color: var(--error-color, #db4437); background: rgba(219,68,55,.13); }
        .meta { padding: 2px 10px 6px; display:grid; grid-template-columns: auto 1fr; column-gap:10px; row-gap:1px; font-size:12px; }
        .meta .k { color: var(--secondary-text-color); }
        .meta .v { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .chips { display:flex; flex-wrap:wrap; gap:4px; padding: 0 10px 6px; }
        .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color);
          display:inline-flex; align-items:center; gap:4px; cursor:pointer; }
        .chip ha-icon { --mdc-icon-size:14px; }
        .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
        .chip.err { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }
        .rows { padding: 0 10px 6px; flex:1; }
        .st { padding:3px 0; font-size:12px; cursor:pointer; border-top:1px solid var(--divider-color); }
        .st:first-child { border-top:none; }
        .st .l { display:flex; justify-content:space-between; gap:8px; }
        .st .l span:first-child { color: var(--secondary-text-color); display:flex; align-items:center; gap:4px; }
        .st ha-icon { --mdc-icon-size:16px; }
        .bar { height:6px; border-radius:3px; background: var(--divider-color); overflow:hidden; margin-top:3px; }
        .bar > i { display:block; height:100%; background: var(--primary-color); border-radius:3px; }
        .bar.warn > i { background: var(--warning-color, #ffa600); }
        .bar.err > i { background: var(--error-color, #db4437); }
        .foot { display:flex; align-items:center; gap:2px; padding:2px 6px; border-top:1px solid var(--divider-color); min-height:30px; margin-top:auto; }
        .foot .sp { flex:1; }
        .pbtn { background:none; border:none; cursor:pointer; padding:4px; border-radius:50%; line-height:0; color: var(--primary-text-color); }
        .pbtn ha-icon { --mdc-icon-size:20px; }
        .pbtn:hover { background: var(--secondary-background-color); }
        .pbtn.go { color: var(--success-color, #43a047); }
        .pbtn.halt { color: var(--error-color, #db4437); }
        .pbtn[disabled] { opacity:.3; cursor:default; background:none; }
        .fbtn { background:none; border:none; cursor:pointer; color: var(--secondary-text-color); padding:3px 6px; border-radius:8px;
          font: inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
        .fbtn ha-icon { --mdc-icon-size:16px; }
        .fbtn:hover { background: var(--divider-color); color: var(--primary-text-color); }
        .fbtn[disabled] { opacity:.35; cursor:default; }
        .fbtn.upd { color: var(--warning-color, #ffa600); }
        .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
        .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
        .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(760px, 100%);
          max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
        .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
        .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
        .dlg-h ha-icon { --mdc-icon-size:32px; color: var(--primary-color); }
        .dlg-b { overflow:auto; padding: 0 20px 16px; }
        .dlg-b h4 { margin: 14px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
        .sum { display:grid; grid-template-columns: 1fr 1fr; gap: 4px 32px; }
        @media (max-width: 560px) { .sum { grid-template-columns: 1fr; } }
        .gauge { padding:6px 0; }
        .gauge .l { display:flex; justify-content:space-between; font-size:15px; }
        .gauge .l b { font-weight:600; }
        .gauge .sub { font-size:12px; color: var(--secondary-text-color); text-align:right; }
        .kv { display:flex; justify-content:space-between; gap:16px; padding:5px 0; font-size:14px; border-bottom:1px solid var(--divider-color); }
        .kv .k { font-weight:600; }
        .kv .v { text-align:right; word-break:break-all; font-variant-numeric: tabular-nums; }
        .kv.e { cursor:pointer; }
        .kv.e .k { font-weight:400; color: var(--secondary-text-color); }
        .acts { display:flex; flex-wrap:wrap; gap:6px; }
        .acts .fbtn { border:1px solid var(--divider-color); }
        .dlg-f { display:flex; justify-content:flex-end; padding: 8px 16px 16px; }
        .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:8px 18px; font: inherit; cursor:pointer; }
      </style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:server-network"></ha-icon>Proxmox</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="type">
          <option value="all">Alle Typen</option>
          <option value="node">Nodes</option>
          <option value="vm">VMs</option>
          <option value="lxc">Container</option>
        </select>
        <select id="view">
          <option value="all">Alle</option>
          <option value="running">Läuft / online</option>
          <option value="stopped">Gestoppt / offline</option>
          <option value="problem">Warnungen</option>
        </select>
        <select id="sort">
          <option value="node">Node / ID</option>
          <option value="name">Name</option>
          <option value="cpu">CPU</option>
          <option value="mem">RAM</option>
          <option value="disk">Disk</option>
          <option value="uptime">Laufzeit</option>
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
    root.getElementById('type').addEventListener('change', (e) => { this._type = e.target.value; this._renderGrid(); });
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
  }

  _openInfo(id) {
    this._infoId = id;
    if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost);
    this._renderInfo();
  }

  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _gaugeHtml(label, pct, sub, item) {
    const cls = this._lvl(pct);
    const w = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    return `<div class="gauge" ${item ? `data-more="${item.id}" style="cursor:pointer"` : ''}>
      <div class="l"><b>${label}</b><span>${pct == null ? '–' : `${nf(pct)} %`}</span></div>
      <div class="bar ${cls === 'ok' ? '' : cls}"><i style="width:${w}%"></i></div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
  }

  _storageHtml(s, compact) {
    const v = this._stPct(s);
    const cls = this._lvl(v);
    const used = this._gib(s.stUsed); const tot = this._gib(s.stTotal);
    const off = s.stActive && s.stActive.st.state === 'off';
    const label = stName(s.name);
    const right = off ? 'inaktiv' : `${used != null && tot != null ? `${this._size(used)} / ${this._size(tot)} · ` : ''}${v == null ? '–' : `${nf(v, 1)} %`}`;
    return `<div class="st" data-more="${(s.stPct || s.stUsed || s.all[0]).id}" title="${esc(s.name)}">
      <div class="l"><span><ha-icon icon="${off ? 'mdi:database-off-outline' : 'mdi:database'}"></ha-icon>${esc(label)}${s.stShared?.st.state === 'on' && !compact ? ' (geteilt)' : ''}</span><span>${esc(right)}</span></div>
      <div class="bar ${cls === 'ok' ? '' : cls}"><i style="width:${v == null ? 0 : Math.min(100, v)}%"></i></div></div>`;
  }

  _actions(d) {
    const b = d.btn;
    const list = d.type === 'node'
      ? [[b.startAll, 'mdi:play-box-multiple-outline', 'Alle starten'], [b.stopAll, 'mdi:stop-circle-outline', 'Alle stoppen', true],
        [b.suspendAll, 'mdi:pause-circle-outline', 'Alle suspendieren', true], [b.reboot, 'mdi:restart', 'Neu starten', true],
        [b.shutdown, 'mdi:power', 'Herunterfahren', true]]
      : [[b.start, 'mdi:play', 'Starten'], [b.shutdown, 'mdi:power', 'Herunterfahren', true], [b.reboot, 'mdi:restart', 'Neu starten', true],
        [b.stop, 'mdi:stop', 'Stoppen', true], [b.reset, 'mdi:restore-alert', 'Zurücksetzen', true], [b.suspend, 'mdi:pause', 'Anhalten', true],
        [b.hibernate, 'mdi:power-sleep', 'Ruhezustand', true], [b.resume, 'mdi:play-pause', 'Fortsetzen'], [b.snapshot, 'mdi:camera-outline', 'Snapshot erstellen', true]];
    return list.filter(([it]) => it).map(([it, icon, text, conf]) => `<button class="fbtn" data-act="press" data-e="${it.id}"
      data-c="${conf && this._config.confirm ? esc(`${text}: ${d.name}?`) : ''}"><ha-icon icon="${icon}"></ha-icon>${text}</button>`).join('');
  }

  _renderInfo() {
    const host = this._dlg;
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { host.innerHTML = ''; return; }
    const r = d.reg || {};
    const cpu = this._num(d.cpu);
    const memU = this._gib(d.memUsed); const memM = this._gib(d.memMax);
    const diskU = this._gib(d.diskUsed); const diskM = this._gib(d.diskMax);
    const up = this._uptimeMs(d);
    const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const left = [
      kv('Laufzeit', esc(this._dur(up))),
      kv(d.type === 'node' ? 'CPU-Kerne' : 'vCPU', esc(this._cores(d) != null ? nf(this._cores(d), 0) : '–')),
      kv('Status', esc(STATUS_TEXT[d.state] || d.state || '–')),
    ];
    const right = [
      d.type === 'node' ? kv('Node', esc(d.name)) : kv('VMID', esc(d.vmid ?? '–')),
      d.type === 'node' ? kv('Version', esc(d.update?.st.attributes.installed_version || '–')) : kv('Node', esc(d.node || '–')),
      kv('Typ', esc(this._modelLine(d) || TYPE[d.type])),
    ];
    const gauges = [
      this._gaugeHtml('CPU', cpu, this._cores(d) ? `${nf(this._cores(d), 0)} ${d.type === 'node' ? 'Kerne' : 'vCPU'}` : '', d.cpu),
      this._gaugeHtml('RAM', this._memPct(d), memM != null ? `${memU != null ? `${this._size(memU)} / ` : ''}${this._size(memM)}` : '', d.memPct || d.memUsed),
    ];
    if (d.diskPct || d.diskUsed || d.diskMax) {
      gauges.push(this._gaugeHtml('Disk', this._diskPct(d), diskM != null ? `${diskU != null ? `${this._size(diskU)} / ` : ''}${this._size(diskM)}` : '', d.diskPct || d.diskUsed));
    }
    const net = [];
    if (d.netIn) net.push(`<div class="kv e" data-more="${d.netIn.id}"><span class="k">Netzwerk eingehend</span><span class="v">${this._val(d.netIn.st)}</span></div>`);
    if (d.netOut) net.push(`<div class="kv e" data-more="${d.netOut.id}"><span class="k">Netzwerk ausgehend</span><span class="v">${this._val(d.netOut.st)}</span></div>`);
    if (d.backupLast) net.push(`<div class="kv e" data-more="${d.backupLast.id}"><span class="k">Letztes Backup</span><span class="v">${esc(this._dateTitle(d.backupLast.st) || this._plain(d.backupLast.st))}</span></div>`);
    if (d.backupDur) net.push(`<div class="kv e" data-more="${d.backupDur.id}"><span class="k">Backup-Dauer</span><span class="v">${this._val(d.backupDur.st)}</span></div>`);

    const cat = { state: [], meas: [], conf: [], diag: [] };
    for (const x of d.all) {
      const dom = x.id.split('.')[0];
      if (dom === 'button') continue;
      if (x.ent.entity_category === 'config' || ['number', 'select', 'switch'].includes(dom)) cat.conf.push(x);
      else if (x.ent.entity_category === 'diagnostic') cat.diag.push(x);
      else if (dom === 'sensor' && x.st.attributes.unit_of_measurement) cat.meas.push(x);
      else cat.state.push(x);
    }
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span><span class="v">${this._val(x.st)}</span></div>`;
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.sort(sortL).map(ent).join('')}` : '');
    const acts = this._actions(d);
    const upd = d.update?.st.state === 'on'
      ? `<button class="fbtn upd" data-act="install" data-e="${d.update.id}" data-c="${esc(`Update ${d.update.st.attributes.latest_version || ''} auf ${d.name} installieren?`)}"><ha-icon icon="mdi:package-up"></ha-icon>Update installieren</button>`
      : '';
    const html = `
      <div class="dlg-bg"><div class="dlg" role="dialog">
        <div class="dlg-h"><ha-icon icon="${TYPE_ICON[d.type]}"></ha-icon><span class="t">${esc(d.name)}</span>
          <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dlg-b">
          <div class="sum"><div>${left.join('')}</div><div>${right.join('')}</div></div>
          <div class="sum" style="margin-top:8px">${gauges.join('')}</div>
          ${net.length ? `<div style="margin-top:6px">${net.join('')}</div>` : ''}
          ${d.storages.length ? `<h4>Storages</h4>${d.storages.map((s) => this._storageHtml(s, false)).join('')}` : ''}
          ${acts || upd ? `<h4>Aktionen</h4><div class="acts">${acts}${upd}</div>` : ''}
          ${sec('Zustände', cat.state)}${sec('Messwerte', cat.meas)}${sec('Konfiguration', cat.conf)}${sec('Diagnose', cat.diag)}
          ${r.configuration_url ? `<h4>Links</h4><div class="kv"><span class="k">Weboberfläche</span><span class="v"><a href="${esc(r.configuration_url)}" target="_blank" rel="noreferrer">${esc(r.configuration_url)}</a></span></div>` : ''}
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
    root.host.style.setProperty('--pmc-min', `${this._config.min_width}px`);
    const all = this._devices;
    const f = this._filter;
    const list = all.filter((d) => {
      if (this._type !== 'all' && d.type !== this._type) return false;
      if (f && !`${d.name} ${d.area} ${d.node} ${d.vmid ?? ''} ${TYPE[d.type]}`.toLowerCase().includes(f)) return false;
      switch (this._view) {
        case 'running': return d.running;
        case 'stopped': return !d.running;
        case 'problem': return d.warnings.length > 0;
        default: return true;
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'de');
    const nodeName = (d) => (d.type === 'node' ? d.name : d.node) || '~';
    const desc = (fn) => (a, b) => (fn(b) ?? -1) - (fn(a) ?? -1) || byName(a, b);
    const cmp = {
      node: (a, b) => nodeName(a).localeCompare(nodeName(b), 'de') || (a.type === 'node' ? -1 : b.type === 'node' ? 1 : 0)
        || (a.vmid ?? 1e9) - (b.vmid ?? 1e9) || byName(a, b),
      name: byName,
      cpu: desc((d) => (d.running ? this._num(d.cpu) : null)),
      mem: desc((d) => (d.running ? this._memPct(d) : null)),
      disk: desc((d) => this._diskPct(d)),
      uptime: desc((d) => this._uptimeMs(d)),
    }[this._sort];
    list.sort(cmp);

    const nodes = all.filter((d) => d.type === 'node');
    const guests = all.filter((d) => d.type !== 'node');
    const run = guests.filter((d) => d.running).length;
    const warn = all.filter((d) => d.warnings.length).length;
    const nodesOff = nodes.filter((d) => !d.online).length;
    root.getElementById('stats').innerHTML = `
      <span>${nodes.length} Node${nodes.length === 1 ? '' : 's'}${nodesOff ? ` (${nodesOff} offline)` : ''}</span>
      <span>${guests.filter((d) => d.type === 'vm').length} VMs</span><span>${guests.filter((d) => d.type === 'lxc').length} Container</span>
      <span>${run} laufen</span>${guests.length - run ? `<span>${guests.length - run} gestoppt</span>` : ''}
      ${warn ? `<span class="al">${warn} mit Warnung</span>` : '<span>keine Warnungen</span>'}`;

    this._patchGrid(list);
  }

  /* Kacheln bleiben bestehen; nur geänderte Bereiche werden ersetzt. */
  _patchGrid(list) {
    const grid = this.shadowRoot.getElementById('grid');
    this._cards = this._cards || {};
    if (!this._emptyEl) {
      this._emptyEl = document.createElement('div');
      this._emptyEl.className = 'empty';
      this._emptyEl.textContent = 'Keine Einträge gefunden.';
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
          <button class="iconbtn" data-act="info" data-d="${d.id}" title="Details"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
        </div>
        <div class="stat"></div><div class="meta"></div><div class="chips"></div><div class="rows"></div><div class="foot"></div>`;
      c = this._cards[d.id] = {
        el, icon: el.querySelector('.ico ha-icon'), name: el.querySelector('.name'), stat: el.querySelector('.stat'),
        meta: el.querySelector('.meta'), chips: el.querySelector('.chips'), rows: el.querySelector('.rows'),
        foot: el.querySelector('.foot'), last: {},
      };
    }
    const parts = this._deviceParts(d);
    const cls = `dev${d.type === 'node' && !d.online ? ' offline' : !d.running ? ' stopped' : ''}${window.__hmcCls ? window.__hmcCls(this._hass, (d.type === 'node' ? d.online : d.running) ? 'srv' : '', true) : ''}`;
    if (c.el.className !== cls) c.el.className = cls;
    if (c.icon.getAttribute('icon') !== TYPE_ICON[d.type]) c.icon.setAttribute('icon', TYPE_ICON[d.type]);
    for (const k of ['name', 'stat', 'meta', 'chips', 'rows', 'foot']) {
      if (c.last[k] !== parts[k]) { c[k].innerHTML = parts[k]; c.last[k] = parts[k]; }
    }
    c.chips.style.display = parts.chips ? '' : 'none';
    c.rows.style.display = parts.rows ? '' : 'none';
    return c.el;
  }

  _deviceParts(d) {
    const s = (item, cls, icon, text, title) => `<span class="s ${cls}" ${item ? `data-more="${item.id}"` : ''} title="${esc(title)}"><ha-icon icon="${icon}"></ha-icon>${esc(text)}</span>`;
    const pctStat = (item, v, icon, title) => (v == null || !d.running ? s(item, 'mute', icon, '0 %', title) : s(item, this._lvl(v), icon, `${nf(v)} %`, title));
    const stat = [];
    const stItem = d.status || d.run;
    if (d.type === 'node') stat.push(s(stItem, d.online ? '' : 'err', d.online ? 'mdi:check-circle' : 'mdi:close-circle', d.online ? 'Online' : 'Offline', 'Status'));
    else if (d.running) stat.push(s(stItem, '', 'mdi:check-circle', 'Läuft', 'Status'));
    else stat.push(s(stItem, d.state === 'suspended' ? 'warn' : 'mute', d.state === 'suspended' ? 'mdi:pause-circle' : 'mdi:stop-circle', STATUS_TEXT[d.state] || d.state, 'Status'));
    if (d.running && d.uptime) stat.push(s(d.uptime, 'info', 'mdi:clock-outline', this._dur(this._uptimeMs(d)), `Laufzeit (seit ${this._dateTitle(d.uptime.st)})`));
    if (d.cpu) stat.push(pctStat(d.cpu, this._num(d.cpu), 'mdi:speedometer', 'CPU'));
    if (d.memPct || d.memUsed) stat.push(pctStat(d.memPct || d.memUsed, this._memPct(d), 'mdi:memory', 'RAM'));
    if (d.diskPct || d.diskUsed) {
      const v = this._diskPct(d);
      stat.push(v == null ? s(d.diskPct || d.diskUsed, 'mute', 'mdi:harddisk', '–', 'Disk') : s(d.diskPct || d.diskUsed, this._lvl(v), 'mdi:harddisk', `${nf(v)} %`, 'Disk'));
    }
    if (d.netIn || d.netOut) {
      const t = [d.netIn && `↓ ${this._plain(d.netIn.st)}`, d.netOut && `↑ ${this._plain(d.netOut.st)}`].filter(Boolean).join('  ');
      stat.push(s(d.netIn || d.netOut, d.running ? 'ok' : 'mute', 'mdi:swap-horizontal', t, 'Netzwerk'));
    }

    const copy = (v) => `<button class="iconbtn" data-act="copy" data-v="${esc(v)}" title="Kopieren" style="padding:2px"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size:14px"></ha-icon></button>`;
    const idText = d.type === 'node' ? d.name : `VMID ${d.vmid ?? '?'}, ${d.node || '–'}`;
    const meta = `
      <span class="k">ID</span><span class="v">${esc(idText)} ${copy(d.type === 'node' ? d.name : String(d.vmid ?? ''))}</span>
      <span class="k">Modell</span><span class="v">${esc(this._modelLine(d) || TYPE[d.type])}</span>
      ${d.area ? `<span class="k">Raum</span><span class="v">${esc(d.area)}</span>` : ''}`;

    const chip = (w) => `<span class="chip ${w.cls}" ${w.item ? `data-more="${w.item.id}"` : ''}><ha-icon icon="${w.icon}"></ha-icon>${esc(w.text)}</span>`;
    // CPU/RAM/Disk sind schon in der Statuszeile markiert, als Chip nur die übrigen Warnungen
    const chips = d.warnings.filter((w) => !/^(CPU|RAM|Disk) /.test(w.text)).map(chip).join('');

    const rows = d.type === 'node' && this._config.show_storage && d.storages.length
      ? d.storages.map((st) => this._storageHtml(st, true)).join('') : '';

    const b = d.btn;
    const pb = (item, icon, cls, title, enabled, conf) => `<button class="pbtn ${cls}" data-act="press" data-e="${item ? item.id : ''}"
      data-c="${conf && this._config.confirm ? esc(`${title}: ${d.name}?`) : ''}" title="${esc(title)}" ${item && enabled ? '' : 'disabled'}><ha-icon icon="${icon}"></ha-icon></button>`;
    let foot;
    if (d.type === 'node') {
      foot = `${pb(b.shutdown, 'mdi:power', '', 'Node herunterfahren', d.online, true)}${pb(b.reboot, 'mdi:restart', '', 'Node neu starten', d.online, true)}
        <span class="sp"></span>
        ${d.update?.st.state === 'on' ? `<button class="fbtn upd" data-act="install" data-e="${d.update.id}" data-c="${esc(`Update ${d.update.st.attributes.latest_version || ''} auf ${d.name} installieren?`)}"><ha-icon icon="mdi:package-up"></ha-icon>Update</button>` : ''}`;
    } else {
      const susp = d.state === 'suspended';
      foot = `${pb(susp ? b.resume || b.start : b.start, 'mdi:play', 'go', susp ? 'Fortsetzen' : 'Starten', !d.running, false)}
        ${pb(b.shutdown, 'mdi:power', '', 'Herunterfahren', d.running, true)}
        ${pb(b.reboot, 'mdi:restart', '', 'Neu starten', d.running, true)}
        ${pb(b.stop, 'mdi:stop', 'halt', 'Stoppen (hart)', d.running || susp, true)}
        <span class="sp"></span>
        ${b.snapshot ? `<button class="fbtn" data-act="press" data-e="${b.snapshot.id}" data-c="${this._config.confirm ? esc(`Snapshot von ${d.name} erstellen?`) : ''}" title="Snapshot erstellen"><ha-icon icon="mdi:camera-outline"></ha-icon></button>` : ''}`;
    }
    return {
      name: `${esc(d.name)}<small>${esc(d.type === 'node' ? `Node${d.area ? ` · ${d.area}` : ''}` : `${TYPE[d.type]} ${d.vmid ?? ''}`)}</small>`,
      stat: stat.join(''), meta, chips, rows, foot,
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
    try {
      switch (ds.act) {
        case 'press':
          if (!ds.e) break;
          if (ds.c && !window.confirm(ds.c)) break;
          await hass.callService('button', 'press', { entity_id: ds.e });
          this._fire('hass-notification', { message: 'Befehl gesendet' });
          break;
        case 'install':
          if (ds.c && !window.confirm(ds.c)) break;
          await hass.callService('update', 'install', { entity_id: ds.e });
          this._fire('hass-notification', { message: 'Update gestartet' });
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

if (!customElements.get('proxmox-manager-card')) {
  customElements.define('proxmox-manager-card', ProxmoxManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'proxmox-manager-card', name: 'Proxmox Manager', description: 'Proxmox-Nodes, VMs und Container im Stil des ioBroker Device Managers' });
  console.info(`%c PROXMOX-MANAGER-CARD %c ${VERSION} `, 'background:#e57000;color:#fff', 'background:#eee;color:#333');
}

}

/* ===== schlueter-manager-card.js ===== */
{
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
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
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

}

/* ===== senec-manager-card.js ===== */
{
/*
 * SENEC Manager Card (Speicher) – Übersicht über einen SENEC.Home-Speicher im Stil der übrigen Manager Cards,
 * angelehnt an das Dashboard des ioBroker.senec-Adapters: Batterie, Gesundheit, Temperaturen, Zellspannungen,
 * Netz, PV-Strings, Wallbox, Funktionen, Steuerung und System.
 * Liest alle Entitäten der SENEC-Integration (marq24/ha-senec-v3, lokal + WebAPI) live aus der Registry.
 * Viele Detailwerte (Zellen, SoH, Zyklen, Peak Shaving …) sind in der Integration standardmäßig deaktiviert;
 * die Karte zeigt dann einen Button, der sie in einem Schritt aktiviert (nur Administratoren).
 *
 * Konfiguration (alle optional):
 *   type: custom:senec-manager-card
 *   integration: senec         # Plattform der Entitäten
 *   capacity: 10               # nutzbare Kapazität in kWh (sonst aus dem Modell geschätzt)
 *   min_width: 400             # Mindestbreite einer Kachel in px
 *   confirm: true              # Rückfrage vor Schaltvorgängen
 *   log_script: script.senec_geraeteprotokoll   # Skript, das das Tagesprotokoll des Speichers liefert (Antwort {text, code})
 */
{
const VERSION = '1.2.0';
const BAD = ['unavailable', 'unknown', ''];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 1) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fW = (w) => (w == null ? '–' : Math.abs(w) >= 1000 ? `${nf(w / 1000, 2)} kW` : `${nf(w, 0)} W`);
const MODS = ['a', 'b', 'c', 'd', 'e', 'f'];

// Entitäten, die die Karte nutzt und die die Integration deaktiviert ausliefert (je Modul bzw. global)
const WANT_MOD = (m) => [
  ...Array.from({ length: 16 }, (_, i) => `bms_cell_volt_${m}${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `bms_cell_temp_${m}${i + 1}`),
  `bms_soh_${m}`, `bms_cycles_${m}`];
const WANT = ['webapi_spare_capacity', 'spare_capacity', 'webapi_peakshaving_mode', 'webapi_peakshaving_capacitylimit', 'webapi_peakshaving_enddate',
  'webapi_sgready_mode', 'webapi_sgready_enabled', 'webapi_battery_soh_remaining_capacity', 'webapi_battery_temp_max', 'webapi_gridexport_limit',
  'webapi_battery_inverter_state', 'fan_inv_lv', 'fan_inv_hv', 'wallbox_allow_intercharge', 'li_storage_mode',
  'wallbox_1_state', 'wallbox_1_power', 'wallbox_1_ev_connected', 'wallbox_1_smart_charge_active',
  'wallbox_1_l1_charging_current', 'wallbox_1_l2_charging_current', 'wallbox_1_l3_charging_current'];

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
    const custom = x.tagName.includes('-');
    if (!custom) for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    // Eingabefelder mit Fokus nicht überschreiben
    if (x.tagName === 'INPUT' && x.matches(':focus')) return;
    if (x.tagName === 'INPUT' && y.hasAttribute('value') && x.value !== y.getAttribute('value') && !x.dataset.dirty) x.value = y.getAttribute('value');
    if (!custom && !x.hasAttribute('data-keep')) morphChildren(x, y);
  });
  for (let i = bn.length; i < an.length; i++) an[i].remove();
}

const STYLE = `
  :host { display:block; padding:12px; box-sizing:border-box; }
  * { box-sizing:border-box; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; padding:12px 16px;
    background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px); margin-bottom:12px; }
  .toolbar .title { font-size:20px; font-weight:500; margin-right:auto; display:flex; align-items:center; gap:8px; }
  .stats { font-size:13px; opacity:.9; width:100%; display:flex; gap:16px; flex-wrap:wrap; }
  .state { font-size:13px; padding:3px 10px; border-radius:12px; background: rgba(255,255,255,.16); }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--smc-min, 400px)), 1fr)); align-items:start; }
  .p { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); padding: 14px 16px; min-width:0; }
  .p.wide { grid-column: 1 / -1; }
  .p h3 { margin:0 0 10px; font-size:16px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .p h3 ha-icon { --mdc-icon-size:20px; color: var(--c, var(--primary-color)); }
  .p h3 small { font-weight:400; font-size:12px; color: var(--secondary-text-color); margin-left:auto; }
  .kv { display:grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap:10px 14px; }
  .kv > div { min-width:0; cursor:pointer; }
  .kv span { display:block; font-size:12px; color: var(--secondary-text-color); }
  .kv b { display:block; font-size:18px; font-weight:600; font-variant-numeric: tabular-nums; overflow-wrap:anywhere; }
  .kv b.ok { color: var(--success-color, #43a047); } .kv b.warn { color: var(--warning-color, #ffa600); } .kv b.err { color: var(--error-color, #db4437); }
  .kv b.dim { color: var(--secondary-text-color); }
  .soc { display:flex; align-items:center; gap:14px; margin-bottom:12px; }
  .soc .big.ok { color: var(--success-color, #43a047); } .soc .big.warn { color: var(--warning-color, #ffa600); } .soc .big.err { color: var(--error-color, #db4437); }
  .soc { cursor:pointer; }
  .soc .big { font-size:34px; font-weight:600; font-variant-numeric: tabular-nums; min-width:90px; }
  .bar { flex:1; height:14px; border-radius:7px; background: var(--divider-color); overflow:hidden; position:relative; }
  .bar i { position:absolute; inset:0 auto 0 0; border-radius:7px; background: linear-gradient(90deg, #e53935, #ffb300 35%, #43a047); }
  .bar u { position:absolute; top:-3px; bottom:-3px; width:2px; background: var(--primary-text-color); opacity:.6; }
  .flow { font-size:13px; color: var(--secondary-text-color); margin-top:-6px; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric: tabular-nums; }
  th { font-size:12px; font-weight:500; color: var(--secondary-text-color); text-align:right; padding:2px 0 6px; }
  th:first-child, td:first-child { text-align:left; }
  td { text-align:right; padding:5px 0; border-top:1px solid var(--divider-color); font-weight:600; }
  td:first-child { font-weight:500; color: var(--secondary-text-color); }
  tr.click td { cursor:pointer; }
  td.ok { color: var(--success-color, #43a047); } td.warn { color: var(--warning-color, #ffa600); } td.err { color: var(--error-color, #db4437); }
  .top { display:flex; justify-content:space-between; gap:12px; margin-bottom:10px; font-size:15px; }
  .top b { font-size:20px; }
  .cells { display:grid; grid-template-columns: 28px repeat(16, minmax(0, 1fr)); gap:4px; margin-top:12px; align-items:center; }
  .cells .m { font-size:12px; font-weight:600; color: var(--secondary-text-color); }
  .cells .c { border-radius:5px; padding:6px 0; text-align:center; font-size:11px; font-weight:600; color:#222; cursor:pointer; font-variant-numeric: tabular-nums; }
  .cells .c.na { background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .leg { display:flex; align-items:center; gap:10px; margin-top:10px; font-size:12px; color: var(--secondary-text-color); flex-wrap:wrap; }
  .leg i { width:200px; max-width:50%; height:10px; border-radius:5px; background: linear-gradient(90deg, #e53935, #fb8c00, #fdd835, #43a047); }
  .cells .m.r2 { display:none; }
  @media (max-width: 700px) { .cells { grid-template-columns: 24px repeat(8, minmax(0, 1fr)); } .cells .m.r2 { display:block; } }
  .fn { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:10px 14px; }
  .fn > div { cursor:pointer; min-width:0; }
  .fn span { display:block; font-size:12px; color: var(--secondary-text-color); }
  .fn b { display:flex; align-items:center; gap:6px; font-size:15px; }
  .fn b::before { content:''; width:9px; height:9px; border-radius:50%; background: var(--disabled-color, #9e9e9e); flex:none; }
  .fn b.on::before { background: var(--success-color, #43a047); }
  .fn b.val::before { display:none; }
  .ctl { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--divider-color); flex-wrap:wrap; }
  .sub + .ctl { border-top:none; }
  .ctl .l { flex:1; min-width:150px; font-size:14px; }
  .ctl .l small { display:block; font-size:12px; color: var(--secondary-text-color); }
  .ctl .ok { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; width:32px; height:32px;
    display:inline-flex; align-items:center; justify-content:center; cursor:pointer; flex:none; }
  .ctl .ok ha-icon { --mdc-icon-size:18px; }
  .ctl { flex-wrap:nowrap; } .ctl .l { min-width:0; }
  .ctl input { width:84px; background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
    border-radius:8px; padding:6px 8px; font: inherit; font-size:14px; text-align:right; }
  .ctl .u { font-size:12px; color: var(--secondary-text-color); min-width:22px; }
  .cols { display:grid; gap:4px 28px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); align-items:start; }
  .sub { font-size:14px; font-weight:600; margin: 4px 0 2px; display:flex; align-items:center; gap:8px; }
  .sub .chip { margin-left:auto; }
  .btn { background: var(--primary-color); color: var(--text-primary-color, #fff); border:none; border-radius:8px; padding:6px 14px; font: inherit; font-size:13px; cursor:pointer; }
  .btn.sec { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color); }
  .btn.dng { background: var(--error-color, #db4437); }
  .btn[disabled] { opacity:.4; cursor:default; }
  .tog { position:relative; width:40px; height:22px; border-radius:11px; background: var(--switch-unchecked-track-color, #9e9e9e);
    border:none; cursor:pointer; flex:none; transition: background .15s; }
  .tog::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
  .tog.on { background: var(--switch-checked-track-color, var(--primary-color)); }
  .tog.on::after { left:21px; }
  .tog[disabled] { opacity:.4; cursor:default; }
  .chip { font-size:11px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color); font-weight:500; }
  .chip.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
  .chip.warn { background: rgba(255,166,0,.18); color: var(--warning-color, #ffa600); }
  .note { display:flex; gap:12px; align-items:center; padding:12px 16px; margin-bottom:12px; border-radius:12px; flex-wrap:wrap;
    background: rgba(3,169,244,.10); border:1px solid rgba(3,169,244,.35); font-size:14px; }
  .note ha-icon { color:#03a9f4; } .note div { flex:1; min-width:200px; }
  .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
  .lbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .lbar input, .lbar select { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
    border-radius:8px; padding:6px 10px; font: inherit; font-size:14px; }
  .lbar input[type=search] { flex:1; min-width:160px; }
  .ltab { margin-top:10px; max-height:560px; overflow:auto; border:1px solid var(--divider-color); border-radius:10px; }
  table.log { font-size:13px; }
  table.log th { position:sticky; top:0; background: var(--secondary-background-color); padding:8px 10px; text-align:left; z-index:1; }
  table.log td { text-align:left; font-weight:400; padding:6px 10px; vertical-align:top; color: var(--primary-text-color); }
  table.log td:first-child { white-space:nowrap; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  table.log td:last-child { font-family: var(--code-font-family, monospace); font-size:12px; white-space:pre-wrap; word-break:break-word; }
  table.log tr.err td { background: rgba(219,68,55,.10); } table.log tr.warn td { background: rgba(255,166,0,.10); }
  .lv { display:inline-block; min-width:20px; text-align:center; font-weight:700; border-radius:5px; padding:0 4px; color: var(--secondary-text-color); }
  .lv.err { color: var(--error-color, #db4437); } .lv.warn { color: var(--warning-color, #ffa600); } .lv.info { color:#03a9f4; }
  [hidden] { display:none !important; }
`;

class SenecManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'senec', min_width: 400, confirm: true, ...config };
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="toolbar" id="tb"></div><div id="note"></div><div class="grid" id="grid"></div>`;
      this.shadowRoot.addEventListener('click', (e) => this._onClick(e));
      this.shadowRoot.addEventListener('input', (e) => { const t = e.composedPath()[0]; if (t.tagName === 'INPUT') t.dataset.dirty = '1'; });
      this.shadowRoot.addEventListener('keydown', (e) => {
        const t = e.composedPath()[0];
        if (e.key === 'Enter' && t.tagName === 'INPUT' && t.dataset.num) this._setNum(t.dataset.num, t);
      });
    }
    this.style.setProperty('--smc-min', `${this._config.min_width}px`);
  }

  getCardSize() { return 14; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'senec' }; }

  set hass(hass) {
    this._hass = hass;
    this._index();
    this._render();
    this._checkDisabled();
  }

  /* ---------- Daten ---------- */
  _index() {
    const hass = this._hass;
    if (this._idxFor === hass.entities) return;
    this._idxFor = hass.entities;
    // Schlüssel = Objekt-ID ohne Präfix (senec_ / pv_senec_), getrennt nach Domain
    const map = {}; const devs = new Set();
    for (const ent of Object.values(hass.entities || {})) {
      if (ent.platform !== this._config.integration) continue;
      const [dom, obj] = ent.entity_id.split('.');
      const key = obj.replace(/^(pv_)?senec_/, '');
      map[`${dom}:${key}`] = ent.entity_id;
      if (ent.device_id) devs.add(ent.device_id);
    }
    this._map = map;
    this._devs = [...devs].map((id) => hass.devices?.[id]).filter(Boolean);
  }

  /** Entität per Domain und Schlüssel (mehrere Kandidaten möglich), nur wenn ein Zustand existiert */
  _id(dom, ...keys) {
    for (const k of keys) { const id = this._map[`${dom}:${k}`]; if (id && this._hass.states[id]) return id; }
    return null;
  }
  _st(dom, ...keys) { const id = this._id(dom, ...keys); return id ? this._hass.states[id] : null; }
  _n(dom, ...keys) {
    const s = this._st(dom, ...keys);
    if (!s || BAD.includes(s.state)) return null;
    const v = parseFloat(s.state);
    return Number.isNaN(v) ? null : v;
  }
  _on(dom, ...keys) { const s = this._st(dom, ...keys); return s ? s.state === 'on' : null; }
  _txt(dom, ...keys) { const s = this._st(dom, ...keys); return s && !BAD.includes(s.state) ? s.state : null; }
  _modules() {
    // vorhandene Module: Spannung oder SoC liefert einen Wert
    return MODS.filter((m) => this._n('sensor', `bms_voltage_${m}`) != null || this._n('sensor', `bms_soc_${m}`) != null
      || this._n('sensor', `bms_cell_volt_${m}1`) != null);
  }

  /* ---------- Deaktivierte Sensoren ---------- */
  async _checkDisabled() {
    const hass = this._hass;
    if (!hass.user?.is_admin || this._disChecked && Date.now() - this._disChecked < 300000) return;
    this._disChecked = Date.now();
    try {
      const list = await hass.callWS({ type: 'config/entity_registry/list' });
      const mods = this._modules().length ? this._modules() : ['a', 'b'];
      const want = new Set([...WANT, ...mods.flatMap(WANT_MOD)]);
      this._disabled = list.filter((e) => e.platform === this._config.integration && e.disabled_by === 'integration'
        && want.has(e.entity_id.split('.')[1].replace(/^(pv_)?senec_/, ''))).map((e) => e.entity_id);
    } catch (err) { this._disabled = []; }
    this._renderNote();
  }

  async _enableAll() {
    const ids = this._disabled || [];
    if (!ids.length) return;
    this._enabling = true; this._renderNote();
    let ok = 0;
    for (const id of ids) {
      try { await this._hass.callWS({ type: 'config/entity_registry/update', entity_id: id, disabled_by: null }); ok++; } catch (err) { /* weiter */ }
    }
    this._enabling = false; this._disabled = []; this._enabledAt = Date.now();
    this._renderNote();
    this._fire('hass-notification', { message: `${ok} SENEC-Sensoren aktiviert. Home Assistant lädt die Integration in etwa 30 Sekunden neu.` });
  }

  _renderNote() {
    const n = (this._disabled || []).length;
    let html = '';
    if (this._enabling) html = '<div class="note"><ha-icon icon="mdi:progress-clock"></ha-icon><div>Sensoren werden aktiviert …</div></div>';
    else if (this._enabledAt && Date.now() - this._enabledAt < 90000) html = '<div class="note"><ha-icon icon="mdi:check-circle-outline"></ha-icon><div>Sensoren aktiviert. Die Werte erscheinen, sobald Home Assistant die SENEC-Integration neu geladen hat (ca. 30 Sekunden).</div></div>';
    else if (n) {
      html = `<div class="note"><ha-icon icon="mdi:information-outline"></ha-icon>
        <div><b>${n} SENEC-Sensoren sind deaktiviert.</b> Zellspannungen, Zelltemperaturen, Gesundheit, Zyklen, Peak Shaving, SG-Ready und Reserve liefert die Integration erst nach dem Aktivieren.</div>
        <button class="btn" data-act="enable">Alle aktivieren</button></div>`;
    }
    morph(this.shadowRoot.getElementById('note'), html);
  }

  /* ---------- Darstellung ---------- */
  _render() {
    const hass = this._hass;
    const root = this.shadowRoot;
    const main = this._devs.find((d) => /main|unit/i.test(d.name || '')) || this._devs.find((d) => !/web/i.test(d.name || '')) || this._devs[0];
    const web = this._devs.find((d) => /web/i.test(d.name || ''));
    if (!main && !web) { morph(root.getElementById('grid'), '<div class="empty p wide">Keine SENEC-Geräte gefunden.</div>'); return; }

    const soc = this._n('sensor', 'battery_charge_percent', 'webapi_akku_fullstand_in_prozent');
    const pwr = this._n('sensor', 'battery_state_power');
    const chg = this._n('sensor', 'battery_charge_power', 'webapi_aktuelle_akku_beladung');
    const dis = this._n('sensor', 'battery_discharge_power', 'webapi_aktuelle_akku_entladung');
    const state = this._txt('sensor', 'system_state', 'webapi_systemstatus');
    const pv = this._n('sensor', 'solar_generated_power', 'webapi_aktuell_erzeugter_strom');
    const house = this._n('sensor', 'house_power', 'webapi_aktueller_hausverbrauch');
    const grid = this._n('sensor', 'grid_state_power');
    morph(root.getElementById('tb'), `<div class="title"><ha-icon icon="mdi:home-battery"></ha-icon>Speicher</div>
      ${state ? `<span class="state">${esc(this._cap(state))}</span>` : ''}
      <div class="stats"><span>Akku ${soc != null ? `${nf(soc, 0)} %` : '–'}</span><span>PV ${fW(pv)}</span><span>Haus ${fW(house)}</span>
        ${grid != null ? `<span>${grid < 0 ? 'Einspeisung' : 'Netzbezug'} ${fW(Math.abs(grid))}</span>` : ''}
        ${main?.model ? `<span>${esc(String(main.model).split('|')[0].trim())}</span>` : ''}</div>`);

    const P = [];
    P.push(this._pBattery(soc, pwr, chg, dis, main));
    P.push(this._pHealth());
    P.push(this._pTemp());
    P.push(this._pCells());
    P.push(this._pGrid());
    P.push(this._pPv());
    P.push(this._pWallbox());
    P.push(this._pSystem(main, web));
    P.push(this._pFunctions());
    P.push(this._pControl());
    P.push(`<div class="p wide" data-k="log" style="--c:#546e7a"><h3><ha-icon icon="mdi:text-box-search-outline"></ha-icon>Geräteprotokoll<small id="logcnt"></small></h3><div id="logb" data-keep></div></div>`);
    morph(root.getElementById('grid'), P.filter(Boolean).join(''));
    if (!this._logInit) { this._logInit = true; this._renderLog(); }
  }

  /* ---------- Geräteprotokoll (Tageslog des Speichers, über ein Skript mit Antwort) ---------- */
  _utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

  async _loadLog(quiet) {
    const L = this._log || (this._log = { date: this._utcDay(), q: '', lvl: '', cat: '', rows: [], raw: '' });
    const script = String(this._config.log_script || 'script.senec_geraeteprotokoll');
    if (!this._hass.states[script]) { L.err = `Das Skript ${script} fehlt (siehe Anleitung im README).`; this._renderLog(); return; }
    if (L.busy) return;
    L.busy = true; if (!quiet) { L.err = ''; this._renderLog(); }
    try {
      const res = await this._hass.connection.sendMessagePromise({ type: 'call_service', domain: 'script', service: script.split('.')[1],
        service_data: { datum: L.date }, return_response: true });
      const r = res?.response || {};
      const text = String(r.text ?? '');
      if (r.code && !text) throw new Error(`Speicher nicht erreichbar (Code ${r.code})`);
      if (/<html|404 Not Found/i.test(text.slice(0, 300))) { L.rows = []; L.raw = ''; L.err = 'Für diesen Tag gibt es kein Protokoll.'; }
      else { L.raw = text; L.rows = this._parseLog(text); L.err = ''; }
      L.ts = Date.now();
    } catch (err) {
      L.err = `Laden fehlgeschlagen: ${err.message || err.code || err}`;
    } finally { L.busy = false; this._renderLog(); }
  }

  _parseLog(raw) {
    const out = [];
    for (const line0 of raw.split('\n')) {
      const line = line0.trim(); if (!line) continue;
      let m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\[(\w)\|([^\]]+)\]\s*(.*)$/.exec(line);
      if (m) { out.push({ d: m[1], t: m[2], l: m[3], c: m[4].trim(), m: m[5] }); continue; }
      m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(line);
      if (m) { out.push({ d: m[1], t: m[2], l: '-', c: '', m: m[3] }); continue; }
      if (out.length) out[out.length - 1].m += `\n${line}`; else out.push({ d: '', t: '', l: '-', c: '', m: line });
    }
    return out.reverse();
  }

  _renderLog() {
    const box = this.shadowRoot.getElementById('logb');
    if (!box) return;
    const L = this._log || (this._log = { date: this._utcDay(), q: '', lvl: '', cat: '', rows: [], raw: '' });
    const LV = { E: ['Fehler', 'err'], P: ['Panik', 'err'], W: ['Warnung', 'warn'], I: ['Info', 'info'], D: ['Debug', ''] };
    const cats = [...new Set(L.rows.map((r) => r.c).filter(Boolean))].sort();
    const q = L.q.toLowerCase();
    const rows = L.rows.filter((r) => (!L.lvl || r.l === L.lvl) && (!L.cat || r.c === L.cat) && (!q || `${r.c} ${r.m}`.toLowerCase().includes(q)));
    const MAX = 500;
    const local = (r) => { if (!r.d) return ''; const d = new Date(`${r.d}T${r.t}Z`); return Number.isNaN(d) ? r.t : d.toLocaleTimeString('de-DE'); };
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, t]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    morph(box, `<div class="lbar">
        <input type="date" id="ld" value="${esc(L.date)}" max="${this._utcDay()}">
        <button class="btn" data-act="logload">${L.busy ? 'Lädt …' : 'Laden'}</button>
        <button class="btn ${L.live ? '' : 'sec'}" data-act="loglive" title="Lädt das heutige Protokoll jede Minute neu">${L.live ? '● Live' : 'Live'}</button>
        <input type="search" id="lq" placeholder="Nachrichten filtern …" value="${esc(L.q)}">
        ${sel('ll', [['', 'Alle Stufen'], ['E', 'Fehler'], ['W', 'Warnungen'], ['I', 'Info']], L.lvl)}
        ${sel('lc', [['', 'Alle Kategorien'], ...cats.map((c) => [c, c])], L.cat)}
        <button class="btn sec" data-act="logdl" ${L.raw ? '' : 'disabled'}>Download</button></div>
      ${L.err ? `<div class="flow" style="margin:10px 0 0;color:var(--error-color,#db4437)">${esc(L.err)}</div>` : ''}
      ${L.rows.length ? `<div class="ltab"><table class="log"><tr><th>Zeit</th><th>Stufe</th><th>Kategorie</th><th>Nachricht</th></tr>
        ${rows.slice(0, MAX).map((r) => { const [lt, lc] = LV[r.l] || [r.l, '']; return `<tr class="${lc}"><td>${esc(local(r))}</td><td><span class="lv ${lc}" title="${esc(lt)}">${esc(r.l)}</span></td><td>${esc(r.c)}</td><td>${esc(r.m)}</td></tr>`; }).join('')}
        </table></div>${rows.length > MAX ? `<div class="flow" style="margin:8px 0 0">Es werden die neuesten ${MAX} von ${rows.length} Einträgen gezeigt – Filter eingrenzen oder Download nutzen.</div>` : ''}`
        : !L.err && !L.busy ? '<div class="flow" style="margin:10px 0 0">Tag wählen und „Laden“ antippen. Zeiten werden in Ortszeit angezeigt, das Datum ist UTC wie im Speicher.</div>' : ''}`);
    const cnt = this.shadowRoot.getElementById('logcnt');
    if (cnt) cnt.textContent = L.rows.length ? `${rows.length} von ${L.rows.length} Einträgen` : '';
    if (!this._logBound) {
      this._logBound = true;
      box.addEventListener('change', (e) => {
        const t = e.composedPath()[0];
        if (t.id === 'ld') { L.date = t.value; this._loadLog(); }
        else if (t.id === 'll') { L.lvl = t.value; this._renderLog(); }
        else if (t.id === 'lc') { L.cat = t.value; this._renderLog(); }
      });
      box.addEventListener('input', (e) => { const t = e.composedPath()[0]; if (t.id === 'lq') { L.q = t.value; clearTimeout(this._lqT); this._lqT = setTimeout(() => this._renderLog(), 200); } });
    }
  }

  _logAction(act) {
    const L = this._log;
    if (act === 'logload') this._loadLog();
    else if (act === 'loglive') {
      L.live = !L.live; clearInterval(this._liveT);
      if (L.live) {
        L.date = this._utcDay(); this._loadLog();
        this._liveT = setInterval(() => { if (!this.isConnected) { clearInterval(this._liveT); return; } L.date = this._utcDay(); this._loadLog(true); }, 60000);
      }
      this._renderLog();
    } else if (act === 'logdl' && L.raw) this._download(`senec-log-${L.date}.log`, L.raw, 'text/plain');
  }

  _download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }


  _tr(s) {
    const T = { deactivated: 'Inaktiv', deactivate: 'Inaktiv', manual: 'Manuell', auto: 'Automatisch', automatic: 'Automatisch', no_limit: 'Keine', off: 'Aus', on: 'Ein' };
    return T[String(s).toLowerCase()] || this._cap(String(s).replace(/_/g, ' '));
  }
  _cap(s) { const t = String(s).toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); }
  _more(dom, ...keys) { const id = this._id(dom, ...keys); return id ? `data-more="${esc(id)}"` : ''; }
  _kv(label, val, cls, more) { return `<div ${more || ''}><span>${esc(label)}</span><b class="${cls || ''}">${val}</b></div>`; }

  _capacity(main) {
    if (this._config.capacity) return Number(this._config.capacity);
    // Modellcode z. B. „…-13LI10-…“ → 10 kWh
    const m = /LI(\d{1,2})\b/.exec(this._devs.map((d) => d.model || '').join(' '));
    return m ? Number(m[1]) : null;
  }

  _pBattery(soc, pwr, chg, dis, main) {
    const volt = this._n('sensor', 'battery_state_voltage');
    const cur = this._n('sensor', 'battery_state_current');
    const cap = this._capacity(main);
    const reserve = this._n('number', 'webapi_spare_capacity') ?? this._n('sensor', 'spare_capacity');
    let flow = 'Akku im Ruhezustand';
    let p = pwr;
    if (p == null && (chg != null || dis != null)) p = (chg || 0) - (dis || 0);
    if (p != null && p > 5) flow = `wird mit ${fW(p)} geladen`;
    else if (p != null && p < -5) flow = `wird mit ${fW(-p)} entladen`;
    const rest = cap != null && soc != null ? `${nf(cap * soc / 100, 1)} von ${nf(cap, 1)} kWh` : '';
    const sc = soc == null ? '' : soc < 10 ? 'err' : soc < 25 ? 'warn' : 'ok';
    return `<div class="p" data-k="bat" style="--c:#43a047"><h3><ha-icon icon="mdi:battery-high"></ha-icon>Batterie<small>${esc(rest)}</small></h3>
      <div class="soc" ${this._more('sensor', 'battery_charge_percent', 'webapi_akku_fullstand_in_prozent')}><div class="big ${sc}">${soc != null ? `${nf(soc, 0)} %` : '–'}</div>
        <div class="bar"><i style="width:${Math.max(0, Math.min(100, soc || 0))}%"></i>${reserve ? `<u style="left:${reserve}%" title="Reserve ${nf(reserve, 0)} %"></u>` : ''}</div></div>
      <div class="flow">${esc(flow)}${reserve ? ` · Reserve ${nf(reserve, 0)} %` : ''}</div>
      <div class="kv">
        ${this._kv('Leistung', p != null ? fW(Math.abs(p)) : '–', p > 5 ? 'ok' : p < -5 ? 'warn' : 'dim', this._more('sensor', 'battery_state_power', 'battery_charge_power'))}
        ${this._kv('Spannung', volt != null ? `${nf(volt, 1)} V` : '–', 'dim', this._more('sensor', 'battery_state_voltage'))}
        ${this._kv('Strom', cur != null ? `${nf(cur, 1)} A` : '–', 'dim', this._more('sensor', 'battery_state_current'))}
        ${cap != null ? this._kv('Kapazität', `${nf(cap, 1)} kWh`, 'dim') : ''}
      </div></div>`;
  }

  _pHealth() {
    const mods = this._modules();
    const sohs = mods.map((m) => this._n('sensor', `bms_soh_${m}`));
    const remain = this._st('sensor', 'webapi_battery_soh_remaining_capacity');
    const known = sohs.filter((v) => v != null);
    const soh = known.length ? Math.min(...known) : null;
    const cls = (v) => (v == null ? 'dim' : v >= 90 ? 'ok' : v >= 75 ? 'warn' : 'err');
    const cycles = mods.map((m) => this._n('sensor', `bms_cycles_${m}`));
    const accIn = this._n('sensor', 'webapi_accuexport_total', 'webapi_akku_beladung');
    const accOut = this._n('sensor', 'webapi_accuimport_total', 'webapi_akku_entladung');
    const rows = mods.map((m, i) => `<tr class="click" ${this._more('sensor', `bms_cycles_${m}`, `bms_soh_${m}`)}><td>Modul ${m.toUpperCase()}</td>
      <td class="${cls(sohs[i])}">${sohs[i] != null ? `${nf(sohs[i], 0)} %` : '–'}</td><td>${cycles[i] != null ? nf(cycles[i], 0) : '–'}</td></tr>`).join('');
    return `<div class="p" data-k="health" style="--c:#43a047"><h3><ha-icon icon="mdi:heart-pulse"></ha-icon>Gesundheit &amp; Zyklen<small>${mods.length} Module</small></h3>
      <div class="kv">
        ${this._kv('Gesundheitszustand', soh != null ? `${nf(soh, 0)} %` : '–', cls(soh))}
        ${remain && !BAD.includes(remain.state) ? this._kv('Restkapazität', `${esc(remain.state)} ${esc(remain.attributes.unit_of_measurement || '')}`, 'dim', `data-more="${esc(remain.entity_id)}"`) : ''}
        ${accIn != null ? this._kv('Geladen gesamt', `${nf(accIn, 0)} kWh`, '', this._more('sensor', 'webapi_accuexport_total', 'webapi_akku_beladung')) : ''}
        ${accOut != null ? this._kv('Entladen gesamt', `${nf(accOut, 0)} kWh`, '', this._more('sensor', 'webapi_accuimport_total', 'webapi_akku_entladung')) : ''}
      </div>
      ${mods.length ? `<table style="margin-top:12px"><tr><th></th><th>Gesundheit</th><th>Ladezyklen</th></tr>${rows}</table>` : ''}</div>`;
  }

  _range(vals, unit, d = 1) {
    const v = vals.filter((x) => x != null);
    if (!v.length) return '–';
    const lo = Math.min(...v); const hi = Math.max(...v);
    return lo === hi ? `${nf(lo, d)} ${unit}` : `${nf(lo, d)} – ${nf(hi, d)} ${unit}`;
  }

  _pTemp() {
    const bt = this._n('sensor', 'battery_temp', 'webapi_battery_temp');
    const btMax = this._n('sensor', 'webapi_battery_temp_max');
    const ct = this._n('sensor', 'case_temp', 'webapi_gehausetemperatur');
    const mcu = this._n('sensor', 'mcu_temp');
    const mods = this._modules();
    const cells = mods.map((m) => Array.from({ length: 6 }, (_, i) => this._n('sensor', `bms_cell_temp_${m}${i + 1}`)));
    const tc = (v) => (v == null ? 'dim' : v > 45 ? 'err' : v > 35 ? 'warn' : '');
    return `<div class="p" data-k="temp" style="--c:#ff7043"><h3><ha-icon icon="mdi:thermometer"></ha-icon>Temperatur</h3>
      <div class="kv">
        ${this._kv('Akku', bt != null ? `${nf(bt, 1)} °C` : '–', tc(bt), this._more('sensor', 'battery_temp', 'webapi_battery_temp'))}
        ${btMax != null ? this._kv('Akku max.', `${nf(btMax, 1)} °C`, tc(btMax), this._more('sensor', 'webapi_battery_temp_max')) : ''}
        ${this._kv('Gehäuse', ct != null ? `${nf(ct, 1)} °C` : '–', tc(ct), this._more('sensor', 'case_temp', 'webapi_gehausetemperatur'))}
        ${mcu != null && mcu > -60 ? this._kv('MCU', `${nf(mcu, 1)} °C`, tc(mcu), this._more('sensor', 'mcu_temp')) : ''}
        ${mods.map((m, i) => this._kv(`Zellen ${m.toUpperCase()}`, this._range(cells[i], '°C'), cells[i].some((x) => x != null) ? tc(Math.max(...cells[i].filter((x) => x != null))) : 'dim',
          this._more('sensor', `bms_cell_temp_${m}1`))).join('')}
      </div></div>`;
  }

  _cellColor(v, lo, hi) {
    if (hi - lo < 1) return '#43a047';
    const t = (v - lo) / (hi - lo);
    const stops = [[0, [229, 57, 53]], [0.33, [251, 140, 0]], [0.66, [253, 216, 53]], [1, [67, 160, 71]]];
    let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [a, ca] = stops[i]; const [b, cb] = stops[i + 1];
    const f = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`;
  }

  _pCells() {
    const mods = this._modules();
    if (!mods.length) return '';
    const volt = mods.map((m) => Array.from({ length: 16 }, (_, i) => {
      const v = this._n('sensor', `bms_cell_volt_${m}${i + 1}`);
      // Integration liefert mV (3105) oder V (3.105)
      return v == null ? null : v < 10 ? v * 1000 : v;
    }));
    const all = volt.flat().filter((v) => v != null);
    const lo = all.length ? Math.min(...all) : 0; const hi = all.length ? Math.max(...all) : 0;
    const rows = mods.map((m) => {
      const v = this._n('sensor', `bms_voltage_${m}`); const c = this._n('sensor', `bms_current_${m}`); const s = this._n('sensor', `bms_soc_${m}`);
      return `<tr class="click" ${this._more('sensor', `bms_voltage_${m}`)}><td>Modul ${m.toUpperCase()}</td><td>${s != null ? `${nf(s, 0)} %` : '–'}</td>
        <td>${v != null ? `${nf(v, 1)} V` : '–'}</td><td>${c != null ? `${nf(c, 2)} A` : '–'}</td></tr>`;
    }).join('');
    const grid = all.length ? `<div class="cells">${mods.map((m, mi) => volt[mi].map((v, i) => `${i === 0 ? `<div class="m">${m.toUpperCase()}</div>` : i === 8 ? '<div class="m r2"></div>' : ''}<div class="c ${v == null ? 'na' : ''}" data-k="${m}${i}"
        ${this._more('sensor', `bms_cell_volt_${m}${i + 1}`)} title="Zelle ${m.toUpperCase()}${i + 1}" style="${v == null ? '' : `background:${this._cellColor(v, lo, hi)}`}">${v == null ? '–' : Math.round(v)}</div>`)
        .join('')).join('')}</div>
      <div class="leg"><span>${nf(lo, 0)} mV</span><i></i><span>${nf(hi, 0)} mV</span><span style="margin-left:auto">Spreizung <b>${nf(hi - lo, 0)} mV</b></span></div>` : '<div class="flow" style="margin:10px 0 0">Zellspannungen nicht verfügbar.</div>';
    return `<div class="p wide" data-k="cells" style="--c:#fdd835"><h3><ha-icon icon="mdi:car-battery"></ha-icon>Zellspannung</h3>
      <table><tr><th></th><th>Füllstand</th><th>Spannung</th><th>Strom</th></tr>${rows}</table>${grid}</div>`;
  }

  _pGrid() {
    const f = this._n('sensor', 'enfluri_net_freq');
    const tot = this._n('sensor', 'enfluri_net_power_total', 'grid_state_power');
    if (f == null && tot == null) return '';
    const vc = (v) => (v == null ? '' : v < 207 || v > 253 ? 'err' : v < 215 || v > 245 ? 'warn' : 'ok');
    const rows = [1, 2, 3].map((p) => {
      const u = this._n('sensor', `enfluri_net_potential_p${p}`); const w = this._n('sensor', `enfluri_net_power_p${p}`); const a = this._n('sensor', `enfluri_net_current_p${p}`);
      return `<tr class="click" ${this._more('sensor', `enfluri_net_power_p${p}`)}><td>L${p}</td><td class="${vc(u)}">${u != null ? `${nf(u, 1)} V` : '–'}</td><td>${fW(w)}</td><td>${a != null ? `${nf(a, 2)} A` : '–'}</td></tr>`;
    }).join('');
    const fc = f == null ? '' : Math.abs(f - 50) > 0.2 ? 'err' : Math.abs(f - 50) > 0.1 ? 'warn' : 'ok';
    return `<div class="p" data-k="grid" style="--c:#9c27b0"><h3><ha-icon icon="mdi:transmission-tower"></ha-icon>Netz</h3>
      <div class="kv" style="margin-bottom:10px">
        ${this._kv('Frequenz', f != null ? `${nf(f, 2)} Hz` : '–', fc, this._more('sensor', 'enfluri_net_freq'))}
        ${this._kv(tot != null && tot < 0 ? 'Einspeisung' : 'Bezug', fW(tot != null ? Math.abs(tot) : null), '', this._more('sensor', 'enfluri_net_power_total', 'grid_state_power'))}
      </div>
      <table><tr><th></th><th>Spannung</th><th>Leistung</th><th>Strom</th></tr>${rows}</table></div>`;
  }

  _pPv() {
    const mpps = [1, 2, 3].filter((i) => this._id('sensor', `solar_mpp${i}_power`, `solar_mpp${i}_potential`));
    if (!mpps.length) return '';
    const rows = mpps.map((i) => {
      const w = this._n('sensor', `solar_mpp${i}_power`); const u = this._n('sensor', `solar_mpp${i}_potential`); const a = this._n('sensor', `solar_mpp${i}_current`);
      return `<tr class="click" ${this._more('sensor', `solar_mpp${i}_power`)}><td>MPP ${i}</td><td>${fW(w)}</td><td>${u != null ? `${nf(u, 1)} V` : '–'}</td><td>${a != null ? `${nf(a, 2)} A` : '–'}</td></tr>`;
    }).join('');
    const tot = this._n('sensor', 'solar_generated_power', 'webapi_aktuell_erzeugter_strom');
    const lim = this._txt('sensor', 'webapi_gridexport_limit');
    return `<div class="p" data-k="pv" style="--c:#ffb300"><h3><ha-icon icon="mdi:solar-panel"></ha-icon>PV-Strings<small>${fW(tot)}${lim ? ` · Einspeisegrenze ${esc(lim)} %` : ''}</small></h3>
      <table><tr><th></th><th>Leistung</th><th>Spannung</th><th>Strom</th></tr>${rows}</table></div>`;
  }

  _pWallbox() {
    const st = this._txt('sensor', 'wallbox_1_state', 'webapi_wallbox_1_state');
    const ev = this._st('binary_sensor', 'webapi_wallbox_1_ev_connected') || this._st('sensor', 'wallbox_1_ev_connected');
    const smart = this._on('binary_sensor', 'wallbox_1_smart_charge_active');
    const cur = [1, 2, 3].map((p) => this._n('sensor', `wallbox_1_l${p}_charging_current`));
    if (st == null && (!ev || BAD.includes(ev.state)) && cur.every((c) => c == null)) return '';
    const evOn = ev && ['on', 'true', '1', 'connected'].includes(String(ev.state).toLowerCase());
    const p = this._n('sensor', 'wallbox_1_power');
    return `<div class="p" data-k="wb" style="--c:#00bcd4"><h3><ha-icon icon="mdi:ev-station"></ha-icon>Wallbox${st ? `<small>${esc(st)}</small>` : ''}</h3>
      <div class="fn" style="margin-bottom:10px">
        <div ${ev ? `data-more="${esc(ev.entity_id)}"` : ''}><span>EV verbunden</span><b class="${evOn ? 'on' : ''}">${evOn ? 'Ja' : 'Nein'}</b></div>
        <div ${this._more('binary_sensor', 'wallbox_1_smart_charge_active')}><span>Smart Charge</span><b class="${smart ? 'on' : ''}">${smart ? 'Aktiv' : 'Inaktiv'}</b></div>
        ${p != null ? `<div ${this._more('sensor', 'wallbox_1_power')}><span>Ladeleistung</span><b class="val">${fW(p)}</b></div>` : ''}
      </div>
      <table><tr><th></th><th>Strom</th></tr>${cur.map((c, i) => `<tr><td>L${i + 1}</td><td>${c != null ? `${nf(c, 2)} A` : '–'}</td></tr>`).join('')}</table></div>`;
  }

  _fn(label, on, more, text) {
    if (on == null && text == null) return '';
    return `<div ${more}><span>${esc(label)}</span><b class="${text != null ? 'val' : on ? 'on' : ''}">${text != null ? esc(text) : on ? 'Aktiv' : 'Inaktiv'}</b></div>`;
  }

  _pFunctions() {
    const sg = this._on('switch', 'webapi_sgready_enabled');
    const sgMode = this._txt('sensor', 'webapi_sgready_mode');
    const ps = this._txt('sensor', 'webapi_peakshaving_mode');
    const psLim = this._txt('sensor', 'webapi_peakshaving_capacitylimit');
    const items = [
      this._fn('SG-Ready', sg, this._more('switch', 'webapi_sgready_enabled')),
      this._fn('SG-Ready-Modus', null, this._more('sensor', 'webapi_sgready_mode'), sgMode),
      this._fn('Peak Shaving', null, this._more('sensor', 'webapi_peakshaving_mode'), ps != null ? this._tr(ps) + (psLim && !/deact/i.test(ps) ? ` · ${psLim} %` : '') : null),
      this._fn('Steckdose 1 Automatik', this._on('switch', 'sockets_1_enable'), this._more('switch', 'sockets_1_enable')),
      this._fn('Steckdose 1 ein', this._on('binary_sensor', 'sockets_1_power_on'), this._more('binary_sensor', 'sockets_1_power_on')),
      this._fn('Steckdose 2 Automatik', this._on('switch', 'sockets_2_enable'), this._more('switch', 'sockets_2_enable')),
      this._fn('Steckdose 2 ein', this._on('binary_sensor', 'sockets_2_power_on'), this._more('binary_sensor', 'sockets_2_power_on')),
      this._fn('Wallbox aus Speicher', this._on('switch', 'wallbox_allow_intercharge'), this._more('switch', 'wallbox_allow_intercharge')),
      this._fn('Lithium Storage Mode', this._on('switch', 'li_storage_mode'), this._more('switch', 'li_storage_mode')),
      this._fn('Lüfter LV-Inverter', this._on('binary_sensor', 'fan_inv_lv'), this._more('binary_sensor', 'fan_inv_lv')),
      this._fn('Lüfter HV-Inverter', this._on('binary_sensor', 'fan_inv_hv'), this._more('binary_sensor', 'fan_inv_hv')),
      this._fn('Drosselung', null, this._more('select', 'webapi_request_drosselung'), this._txt('select', 'webapi_request_drosselung') && this._tr(this._txt('select', 'webapi_request_drosselung'))),
      this._fn('Akku-Inverter', null, this._more('sensor', 'webapi_battery_inverter_state'), this._txt('sensor', 'webapi_battery_inverter_state')),
    ].filter(Boolean);
    if (!items.length) return '';
    return `<div class="p wide" data-k="fn" style="--c:#03a9f4"><h3><ha-icon icon="mdi:tune-variant"></ha-icon>Funktionen</h3><div class="fn">${items.join('')}</div></div>`;
  }

  _tog(label, sub, dom, key) {
    const s = this._st(dom, key);
    if (!s) return '';
    const on = s.state === 'on';
    return `<div class="ctl"><div class="l">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <button class="tog ${on ? 'on' : ''}" data-act="tog" data-e="${esc(s.entity_id)}" data-n="${esc(label)}" data-on="${on ? 1 : 0}" ${BAD.includes(s.state) ? 'disabled' : ''}></button></div>`;
  }

  _num(label, dom, key, unit) {
    const s = this._st(dom, key);
    if (!s) return '';
    const a = s.attributes;
    const v = BAD.includes(s.state) ? '' : String(Number(s.state));
    return `<div class="ctl"><div class="l">${esc(label)}</div>
      <input type="number" data-k="in-${esc(s.entity_id)}" data-num="${esc(s.entity_id)}" value="${esc(v)}" ${a.min != null ? `min="${a.min}"` : ''} ${a.max != null ? `max="${a.max}"` : ''} step="${a.step ?? 1}">
      <span class="u">${esc(unit || a.unit_of_measurement || '')}</span>
      <button class="ok" data-act="num" data-e="${esc(s.entity_id)}" title="Übernehmen"><ha-icon icon="mdi:check"></ha-icon></button></div>`;
  }

  _pControl() {
    const sock = [1, 2].map((i) => {
      const body = [
        this._tog('Automatik', 'Schaltet nach Überschuss bzw. Zeit', 'switch', `sockets_${i}_enable`),
        this._tog('Permanent ein', '', 'switch', `sockets_${i}_force_on`),
        this._tog('Schaltzeit verwenden', '', 'switch', `sockets_${i}_use_time`),
        this._num('Einschaltschwelle', 'number', `sockets_${i}_upper_limit`, 'W'),
        this._num('Abschaltschwelle', 'number', `sockets_${i}_lower_limit`, 'W'),
        this._num('Dauer Überschuss', 'number', `sockets_${i}_time_limit`, 'min'),
        this._num('Einschaltdauer', 'number', `sockets_${i}_power_on_time`, 'min'),
        this._num('Einschaltzeit Stunde', 'number', `sockets_${i}_switch_on_hour`, 'h'),
        this._num('Einschaltzeit Minute', 'number', `sockets_${i}_switch_on_minute`, 'min'),
      ].join('');
      if (!body) return '';
      const on = this._on('binary_sensor', `sockets_${i}_power_on`);
      const rem = this._n('sensor', `sockets_${i}_time_rem`);
      return `<div><div class="sub">Steckdose ${i}<span class="chip ${on ? 'ok' : ''}">${on ? `ein${rem ? ` · noch ${nf(rem, 0)} min` : ''}` : 'aus'}</span></div>${body}</div>`;
    }).join('');
    const top = [
      this._tog('Akku-Zwangsladung', 'Lädt den Akku voll (Safe Charge)', 'switch', 'safe_charge'),
      this._num('Notstrom-Reserve', 'number', 'webapi_spare_capacity', '%'),
    ].join('');
    if (!top && !sock) return '';
    return `<div class="p wide" data-k="ctl" style="--c:#7e57c2"><h3><ha-icon icon="mdi:cog-outline"></ha-icon>Steuerung</h3>
      <div class="cols">${top ? `<div><div class="sub">Akku</div>${top}</div>` : ''}${sock}</div></div>`;
  }

  _pSystem(main, web) {
    const hours = this._n('sensor', 'hours_of_operation');
    const upd = this._st('update', 'home_v2_x_v3_v4_systems_update') || Object.values(this._map).filter((id) => id.startsWith('update.')).map((id) => this._hass.states[id]).find(Boolean);
    const reboot = this._id('button', 'system_reboot');
    const sw = String(main?.sw_version || '');
    const part = (k) => (new RegExp(`${k}:(\\S+)`).exec(sw) || [])[1];
    const model = String(web?.model || main?.model || '').split('|');
    const mods = this._modules();
    return `<div class="p" data-k="sys" style="--c:#607d8b"><h3><ha-icon icon="mdi:information-outline"></ha-icon>System</h3>
      <div class="kv">
        ${this._kv('Produkt', esc(model[0].trim() || '–'), 'dim')}
        ${part('FW') ? this._kv('Firmware', esc(part('FW')), 'dim') : ''}
        ${part('NPU-Image') ? this._kv('NPU', esc(part('NPU-Image')), 'dim') : ''}
        ${part('App') ? this._kv('App', esc(part('App')), 'dim') : ''}
        ${hours != null ? this._kv('Betriebsstunden', `${nf(hours, 0)} h`, 'dim', this._more('sensor', 'hours_of_operation')) : ''}
        ${this._kv('Module', String(mods.length), 'dim')}
        ${model[1] ? this._kv('Gehäuse', esc(model[1].replace(/SENEC\.Case:\s*/i, '').trim()), 'dim') : ''}
        ${upd ? this._kv('Update', upd.state === 'on' ? 'verfügbar' : 'aktuell', upd.state === 'on' ? 'warn' : 'ok', `data-more="${esc(upd.entity_id)}"`) : ''}
      </div>
      ${reboot ? `<div class="ctl" style="margin-top:10px;border-top:1px solid var(--divider-color)"><div class="l">System neu starten</div>
        <button class="btn dng" data-act="reboot" data-e="${esc(reboot)}">Neustart</button></div>` : ''}</div>`;
  }

  /* ---------- Aktionen ---------- */
  _onClick(e) {
    const path = e.composedPath();
    const act = path.find((el) => el.dataset && el.dataset.act);
    if (act) { e.stopPropagation(); this._action(act.dataset, act); return; }
    if (path.some((el) => el.tagName === 'INPUT')) return;
    const more = path.find((el) => el.dataset && el.dataset.more);
    if (more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  async _action(ds) {
    const hass = this._hass;
    try {
      if (ds.act === 'enable') await this._enableAll();
      else if (ds.act.startsWith('log')) this._logAction(ds.act);
      else if (ds.act === 'tog') {
        const on = ds.on === '1';
        if (this._config.confirm && !window.confirm(`${ds.n} ${on ? 'ausschalten' : 'einschalten'}?`)) return;
        await hass.callService('switch', on ? 'turn_off' : 'turn_on', { entity_id: ds.e });
      } else if (ds.act === 'num') {
        const inp = this.shadowRoot.querySelector(`input[data-num="${CSS.escape(ds.e)}"]`);
        await this._setNum(ds.e, inp);
      } else if (ds.act === 'reboot') {
        if (!window.confirm('SENEC-System wirklich neu starten? Der Speicher ist dabei einige Minuten nicht erreichbar.')) return;
        await hass.callService('button', 'press', { entity_id: ds.e });
        this._fire('hass-notification', { message: 'Neustart des SENEC-Systems ausgelöst' });
      }
    } catch (err) {
      this._fire('hass-notification', { message: `Fehler: ${err.message || err}` });
    }
  }

  async _setNum(id, inp) {
    if (!inp || inp.value === '') return;
    const v = Number(inp.value);
    const s = this._hass.states[id];
    if (s && (s.attributes.min != null && v < s.attributes.min || s.attributes.max != null && v > s.attributes.max)) {
      this._fire('hass-notification', { message: `Wert muss zwischen ${s.attributes.min} und ${s.attributes.max} liegen` });
      return;
    }
    await this._hass.callService('number', 'set_value', { entity_id: id, value: v });
    delete inp.dataset.dirty;
    this._fire('hass-notification', { message: `${s?.attributes.friendly_name || id}: ${nf(v, 0)} übernommen` });
  }

  _fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
}

if (!customElements.get('senec-manager-card')) {
  customElements.define('senec-manager-card', SenecManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'senec-manager-card', name: 'SENEC Manager Card', description: 'Speicher-Übersicht für SENEC.Home (Batterie, Zellen, Netz, PV, Steuerung)', preview: false });
  console.info(`%c SENEC-MANAGER-CARD %c ${VERSION} `, 'background:#43a047;color:#fff', 'background:#eee;color:#333');
}
}

}

/* ===== shelly-manager-card.js ===== */
{
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

}

/* ===== tasmota-manager-card.js ===== */
{
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
    const sig = JSON.stringify([this._latest, this._histTs, devices.map((d) => [d.id, d.name, d.area, d.sig])]);
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

}

/* ===== xsense-manager-card.js ===== */
{
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
    const sig = JSON.stringify(devices.map((d) => [d.id, d.name, d.area, d.sig]));
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
        .dev.offline { opacity:.55; }
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
    const cls = `dev${d.online ? '' : ' offline'}${d.alarm ? ' alarm' : ''}`;
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

}

/* ===== area-overview-card.js ===== */
{
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
const VERSION = '1.4.1';
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
/* Aktivität eines Geräts für die Hervorhebung der Gerätekacheln (gemeinsam für alle Karten).
 * Farbig (Standard): act-pw = verbraucht Strom/heizt/läuft (rot), act-li = Licht an (gelb), act-sw = nur geschaltet (blau),
 * act-srv = Server/Pi-hole aktiv (lila). Mit input_boolean.dashboard_farben = aus: aktive Geräte hell, inaktive gedimmt (act-off). */
{
  const SETTING = /power.?switch|lock|sperre|kindersicherung|led|anzeige|display|detect|motion|record|snapshot|modus|mode|sprinkler|zugriff|access|privacy|eco|auto|alarm|notification|benachricht/i;
  const U = { W: 1, kW: 1000, MW: 1e6 };
  const SRV = ['proxmoxve', 'pi_hole'];
  let idxFor = null; let idx = {}; let resFor = null; let res = {};
  window.__hmcColorEntity = window.__hmcColorEntity || 'input_boolean.dashboard_farben';
  /** { a: 'pw'|'li'|'sw'|'srv'|'', cap: Gerät kann aktiv sein } */
  window.__hmcActRaw = (hass, devId) => {
    if (!hass || !devId || !hass.entities) return { a: '', cap: false };
    if (idxFor !== hass.entities) {
      idxFor = hass.entities; idx = {};
      for (const e of Object.values(hass.entities)) if (e.device_id && !e.hidden && !e.disabled_by) (idx[e.device_id] ||= []).push(e);
    }
    if (resFor !== hass.states) { resFor = hass.states; res = {}; }
    if (res[devId]) return res[devId];
    let watt = 0; let run = false; let light = false; let sw = false; let cap = false; let srv = null; let online = false;
    for (const e of idx[devId] || []) {
      const st = hass.states[e.entity_id];
      if (!st) continue;
      const dom = e.entity_id.split('.')[0]; const a = st.attributes; const on = st.state === 'on';
      if (st.state !== 'unavailable') online = true;
      if (SRV.includes(e.platform)) {
        srv ||= e.platform;
        if (e.platform === 'pi_hole' && dom === 'switch' && !e.entity_category) srv = on ? 'on' : srv === 'on' ? 'on' : 'pi_hole';
        if (e.platform === 'proxmoxve' && dom === 'binary_sensor' && ['running', 'connectivity', 'power'].includes(a.device_class)) srv = on ? 'on' : srv === 'on' ? 'on' : 'proxmoxve';
        continue;
      }
      if (dom === 'sensor' && a.device_class === 'power' && U[a.unit_of_measurement]) { cap = true; const v = parseFloat(st.state); if (v > 0) watt = Math.max(watt, v * U[a.unit_of_measurement]); continue; }
      if (dom === 'binary_sensor' && a.device_class === 'smoke') { cap = true; if (on) run = true; continue; }
      if (e.entity_category) continue;
      if (dom === 'climate') { cap = true; if (['heating', 'preheating'].includes(a.hvac_action)) run = true; } else if (dom === 'light') { cap = true; if (on) light = true; } else if (['switch', 'fan'].includes(dom) && !SETTING.test(`${a.friendly_name || ''} ${e.entity_id}`)) { cap = true; if (on) sw = true; } else if (dom === 'binary_sensor' && ['running', 'power', 'plug'].includes(a.device_class)) { cap = true; if (on) run = true; } else if (dom === 'sensor' && a.device_class === 'enum' && /^(running|in_use|programmed|active|main_wash|drying|rinse|spin)$/i.test(st.state)) { cap = true; run = true; }
    }
    // Server/Pi-hole: aktiv = läuft (Proxmox) bzw. Blockieren an (Pi-hole); ohne Status-Entität reicht „erreichbar“
    if (srv) return (res[devId] = { a: srv === 'on' || (srv === 'proxmoxve' && online && !(idx[devId] || []).some((e) => e.entity_id.startsWith('binary_sensor.'))) ? 'srv' : '', cap: true });
    return (res[devId] = { a: run || watt >= 10 ? 'pw' : light ? 'li' : sw ? 'sw' : '', cap });
  };
  /** Klassen je nach Modus: farbig oder hell/dunkel */
  window.__hmcCls = (hass, a, cap) => {
    const color = hass?.states?.[window.__hmcColorEntity]?.state !== 'off';
    if (color) return a ? ` act-${a}` : '';
    return !a && cap ? ' act-off' : '';
  };
  window.__hmcAct = (hass, devId) => { const r = window.__hmcActRaw(hass, devId); return window.__hmcCls(hass, r.a, r.cap); };
  const T = (c, p) => `background: color-mix(in srgb, ${c} ${p}%, var(--ha-card-background, var(--card-background-color))); border-color: color-mix(in srgb, ${c} 45%, transparent);`;
  window.__hmcActCss = `
    .dev.act-pw { ${T('#f44336', 13)} }
    .dev.act-li { ${T('#ffc107', 16)} }
    .dev.act-sw { ${T('#03a9f4', 13)} }
    .dev.act-srv { ${T('#9c27b0', 13)} }
    .dev.act-off { opacity:.55; filter: saturate(.6); }`;
}

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
      // Ausblenden ändert die Geräte-Registry – nur für Administratoren
      if (!this._hass?.user?.is_admin) { if (b) b.remove(); el.classList.remove('aoc-hidden'); return el; }
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
    this.toggleAttribute('data-noadmin', !hass.user?.is_admin);
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
        .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
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
        :host([data-noadmin]) .hidebtn, :host([data-noadmin]) .rhide, :host([data-noadmin]) [data-act="showhidden"] { display:none !important; }
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
      const cls = `dev${d.online ? '' : ' offline'}${hid ? ' hidden-dev' : ''}${d.loose ? '' : window.__hmcAct(this._hass, d.id)}`;
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

}

/* ===== home-dashboard-card.js ===== */
{
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
 *   cameras: { buro: camera.x, garage: camera.y }   # Kamerabild im Hintergrund der Raumkachel (camera_background: false schaltet es ab)
 *   exclude_areas: [pv]
 *   hide_label: dashboard_ausgeblendet    # per Label ausgeblendete Geräte zählen nicht mit
 *   links: [{ name, icon, path, color, integration, entity }]
 *   makers: [{ type: custom:shelly-manager-card, … }]   # für die Raum-Popups
 *   admin_only: [pi_hole, proxmoxve, xsense]   # Integrationen nur für Administratoren (Links, Räume, Zähler)
 *   links: [{ …, admin: true }]                # einzelnen Link nur Administratoren zeigen
 *   popup_opacity: 50                         # Deckkraft der Popups in % (100 = deckend), popup_blur: 10 (px), popup_dim: 20 (% Abdunklung)
 *   color_entity: input_boolean.dashboard_farben   # farbige Hervorhebung an/aus (aus = aktiv hell, inaktiv gedimmt)
 *   switches: true                             # Statuskachel „Schalter an/aus“ (Steckdosen, Relais, Messdosen); false blendet sie aus
 */
{
const VERSION = '2.7.0';
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
// Schalter, die eine Last schalten: Steckdosen, Messdosen, Relais, Beleuchtung, Pumpen (keine Einstellungsschalter)
const SW_LOAD = /schaltdose|steckdose|messdose|zwischenstecker|relais|relay|plug|socket|outlet|beleuchtung|lampe|pumpe|lüfter|luefter|ventilator/i;
// Gerätegruppen in der Raumkachel (Anzahl, aktiv hervorgehoben); Reihenfolge zählt (Dampfgarer vor Backofen)
const APPS = [
  { k: 'boiler', re: /boiler|hei(ß|ss)wasser|warmwasser/i, icon: 'mdi:water-boiler', name: 'Boiler', c: '#f44336' },
  { k: 'washer', re: /waschmaschine|washing.?machine|washer/i, icon: 'mdi:washing-machine', name: 'Waschmaschine', c: '#f44336' },
  { k: 'dryer', re: /trockner|dryer/i, icon: 'mdi:tumble-dryer', name: 'Trockner', c: '#f44336' },
  { k: 'steam', re: /dampfgarer|steam/i, icon: 'mdi:pot-steam', name: 'Dampfgarer', c: '#f44336' },
  { k: 'dish', re: /geschirrsp(ü|u|ue)ler|dishwasher/i, icon: 'mdi:dishwasher', name: 'Geschirrspüler', c: '#f44336' },
  { k: 'oven', re: /backofen|oven/i, icon: 'mdi:toaster-oven', name: 'Backofen', c: '#f44336' },
  { k: 'hob', re: /kochfeld|\bherd\b|cooktop|\bhob\b/i, icon: 'mdi:stove', name: 'Kochfeld', c: '#f44336' },
  { k: 'smoke', re: /rauchmelder|smoke|^rm\b/i, icon: 'mdi:smoke-detector-variant', name: 'Rauchmelder', c: '#f44336' },
  { k: 'server', re: /server|proxmox|\bnas\b|synology|pi-?hole/i, icon: 'mdi:server', name: 'Server', c: '#9c27b0' },
];
const PLUG = /messdose|steckdose|zwischenstecker|plug/i;
const APPS_EXCL = /ha-mcp|mcp server/i;   // Dienste, keine Geräte
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
  hidden(e) { return !!e && ((e.device_id && this.ids.has(e.device_id)) || (this.ents && this.ents.has(e.entity_id)) || (!!this.restricted && this.restricted(e))); },
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
  .gl { display:flex; align-items:center; gap:10px; min-width:0; }
  .gl .g { min-width:0; }
  .wx { display:flex; align-items:center; gap:4px; cursor:pointer; padding:2px 8px; border-radius:12px; flex:none; }
  .wx:hover { background: var(--secondary-background-color); }
  .wx ha-icon { --mdc-icon-size: 28px; color: var(--amber-color, #ffc107); }
  .wx span { font-size: 20px; font-weight: 600; white-space:nowrap; }
  .greet .s .tm { font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  @media (max-width: 600px) { .greet .g { font-size: 20px; white-space:normal; } .hdr { gap:10px; }
    .stat { grid-template-columns: repeat(4, 1fr); } .si .l { font-size:11px; } .av { width:48px; height:48px; }
    .wx ha-icon { --mdc-icon-size: 22px; } .wx span { font-size: 16px; } }

  /* Status-Icons */
  .stat { display:grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 8px; }
  .si { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; padding: 12px 6px 10px; text-align:center; }
  .si .bub { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; background: var(--secondary-background-color); }
  .si .bub ha-icon { --mdc-icon-size: 24px; color: var(--secondary-text-color); }
  .si.on .bub { background: color-mix(in srgb, var(--c) 22%, transparent); }
  .si.on .bub ha-icon { color: var(--c); }
  .si.alert .bub, .si.blink .bub { animation: pulse 1.6s infinite; }
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
  .val { display:flex; align-items:center; gap:8px; padding: 8px 12px; border-radius: 14px; min-width: 108px;
    background: color-mix(in srgb, var(--c) 9%, transparent); border: 1px solid color-mix(in srgb, var(--c) 22%, transparent); }
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
  .lk .bub { position:relative; }
  .lk .bdg { position:absolute; top:-6px; right:-6px; min-width:18px; height:18px; padding:0 5px; border-radius:9px; box-sizing:border-box;
    background: var(--c, var(--primary-color)); color:#fff; font-size:11px; font-weight:700; line-height:18px; text-align:center;
    box-shadow: 0 0 0 2px var(--card-background-color, #1c1c1c); z-index:1; }
  .lk .bdg.err { background:#f44336; } .lk .bdg.warn { background:#ff9800; }
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
  .ic.camic { cursor:pointer; } .ic.camic:hover { filter: brightness(1.25); outline: 1px solid color-mix(in srgb, var(--c) 50%, transparent); }
    color: var(--secondary-text-color); background: color-mix(in srgb, var(--secondary-text-color) 14%, var(--ha-card-background, var(--card-background-color))); }
  .ic ha-icon { --mdc-icon-size:18px; }
  .ic.on { color: var(--c); background: color-mix(in srgb, var(--c) 20%, var(--ha-card-background, var(--card-background-color))); }
  .rc.withcam .ic { background: rgba(0,0,0,.35); } .rc.withcam .ic.on { color: var(--c); background: rgba(0,0,0,.5); }
  [hidden] { display:none !important; }
`;

const POP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .bg { position:fixed; inset:0; z-index:99; background: rgba(0,0,0,var(--pop-dim, .2)); display:flex; align-items:center; justify-content:center; padding:24px;
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, sans-serif)); color: var(--primary-text-color); animation: fd .15s; }
  @keyframes fd { from { opacity:0; } }
  @keyframes su { from { transform: translateY(24px); opacity:.4; } }
  .pop { background: color-mix(in srgb, var(--primary-background-color, var(--card-background-color)) var(--pop-op, 50%), transparent);
    -webkit-backdrop-filter: blur(var(--pop-blur, 10px)); backdrop-filter: blur(var(--pop-blur, 10px)); border-radius:24px; width: min(var(--w, 640px), 100%);
    max-height: calc(100vh - 48px); display:flex; flex-direction:column; box-shadow: 0 12px 48px rgba(0,0,0,.45); overflow:hidden; animation: su .18s; }
  .ph { display:flex; align-items:center; gap:12px; padding: 16px 16px 12px 22px; }
  .ph .bub { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center;
    background: color-mix(in srgb, var(--c, var(--primary-color)) 18%, transparent); }
  .ph .bub ha-icon { --mdc-icon-size:24px; color: var(--c, var(--primary-color)); }
  .ph .t { flex:1; font-size:22px; font-weight:600; } .ph .t small { display:block; font-size:13px; font-weight:400; color: var(--secondary-text-color); }
  .x { background: var(--secondary-background-color); border:none; width:38px; height:38px; border-radius:50%; cursor:pointer; color: var(--primary-text-color);
    display:flex; align-items:center; justify-content:center; }
  .pb { overflow:auto; padding: 4px 20px 22px; display:flex; flex-direction:column; gap:12px; }
  .lst { display:flex; flex-direction:column; background: color-mix(in srgb, var(--ha-card-background, var(--card-background-color)) var(--pop-op, 50%), transparent); border-radius:16px; border:1px solid var(--divider-color); overflow:hidden; }
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
  .mi { border-top:1px solid var(--divider-color); border-left:4px solid var(--c); }
  .mi:first-child { border-top:none; }
  .mh { display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer; flex-wrap:wrap; }
  .mh:hover { background: var(--secondary-background-color); }
  .mh .dot { width:10px; height:10px; border-radius:50%; background: var(--c); flex:none; }
  .mh .n { flex:1; min-width:160px; font-size:15px; font-weight:500; }
  .mh .n small { display:block; font-size:12px; font-weight:400; color: var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px; }
  .mh .chs { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
  .ch { font-size:12px; padding:2px 8px; border-radius:10px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space:nowrap; }
  .ch.ok { background: rgba(76,175,80,.15); color:#4caf50; } .ch.warn { background: rgba(255,152,0,.16); color:#ff9800; } .ch.err { background: rgba(244,67,54,.15); color:#f44336; }
  .mdet { padding: 0 12px 12px 34px; }
  .msub { font-size:12px; font-weight:600; color: var(--secondary-text-color); margin:8px 0 2px; text-transform:uppercase; letter-spacing:.04em; }
  .mrow { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px; }
  .mrow > span:not(.mlv) { flex:1; min-width:0; overflow-wrap:anywhere; } .mrow small { display:block; font-size:11.5px; color: var(--secondary-text-color); }
  .mrow ha-icon { --mdc-icon-size:18px; flex:none; } .mrow.click { cursor:pointer; } .mrow .btn { padding:4px 10px; font-size:12px; }
  .mlv { font-weight:700; width:18px; text-align:center; flex:none; }
  .msel { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:6px; }
  .mchk { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px; border:1px solid var(--divider-color); cursor:pointer; font-size:14px; }
  .mchk.on { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
  .mchk ha-icon { color: var(--primary-color); flex:none; } .mchk small { display:block; font-size:11px; color: var(--secondary-text-color); }
  .host > * { display:block; }
  .host > .cams { margin-bottom: 14px; }
  .lbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .lf { background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color); border-radius:16px;
    padding:5px 12px; font: inherit; font-size:13px; cursor:pointer; }
  .lf b { font-weight:600; opacity:.7; } .lf.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .lq { flex:1; min-width:140px; background: var(--secondary-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color);
    border-radius:10px; padding:7px 10px; font: inherit; font-size:14px; }
  .lbar .btn { padding:6px 12px; font-size:13px; }
  .linf { font-size:12px; color: var(--secondary-text-color); margin: 0 4px; }
  .le { padding:9px 14px 9px 12px; border-top:1px solid var(--divider-color); border-left:4px solid var(--c); cursor:pointer; }
  .le:first-child { border-top:none; } .le:hover { background: var(--secondary-background-color); }
  .le .lh { display:flex; gap:8px; align-items:baseline; }
  .le .lv { font-size:11px; font-weight:700; color: var(--c); text-transform:uppercase; flex:none; min-width:58px; }
  .le .lm { flex:1; font-size:14px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .le .lc { font-size:11px; padding:1px 7px; border-radius:9px; background: var(--secondary-background-color); flex:none; }
  .le .ls { font-size:11.5px; color: var(--secondary-text-color); margin: 2px 0 0 66px; overflow-wrap:anywhere; }
  .le pre { margin:8px 0 2px; padding:10px; background: var(--secondary-background-color); border-radius:8px; font-size:12px; line-height:1.4;
    white-space:pre-wrap; word-break:break-word; max-height:360px; overflow:auto; cursor:text; }
  @media (max-width: 600px) { .le .ls { margin-left:0; } }
  @media (max-width: 600px) { .bg { align-items:flex-end; padding:0; } .pop { border-radius:24px 24px 0 0; max-height:92vh; width:100%; } }
`;

class HomeDashboardCard extends HTMLElement {
  setConfig(config) {
    this._config = { exclude_areas: [], cameras: {}, area_power: {}, links: [], makers: [], power: {}, warnings: [],
      solar_forecast: true, battery_low: 20, hide_label: 'dashboard_ausgeblendet', ...config };
    HIDE.label = this._config.hide_label;
    if (this._config.color_entity) window.__hmcColorEntity = this._config.color_entity;
    if (!this.shadowRoot) this._build();
    this._camEls = this._camEls || {};
  }

  getCardSize() { return 20; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return {}; }

  connectedCallback() {
    clearInterval(this._tick);
    this._tick = setInterval(() => { this._renderHeader(); this._fetchHist(); this._fetchForecast(); this._renderHaus(); this._fetchLog(); this._fetchSys(); }, 30000);
    this._onHide = () => this._render();
    HIDE.subs.add(this._onHide);
  }

  disconnectedCallback() { clearInterval(this._tick); HIDE.subs.delete(this._onHide); this._closePopup(); this._closeCams(); }

  set hass(hass) {
    this._hass = hass;
    HIDE.sync(hass);
    HIDE.restrict(hass, this._config.admin_only || []);
    this._render();
    if (this._pop) this._updatePopup();
    if (this._camPop) for (const c of this._camPop.els) c.hass = hass;
    if (!this._histTs) this._fetchHist();
    if (!this._fcTs) this._fetchForecast();
    if (!this._logTs) this._fetchLog();
    if (!this._sysTs) this._fetchSys();
  }

  /* ---------- Home-Assistant-Log (Systemprotokoll, nur Admins) ---------- */
  async _fetchLog(force) {
    const hass = this._hass;
    const wanted = (this._config.links || []).some((l) => ['log', 'integrations'].includes(l.popup));
    if (!hass || !wanted || this._logBusy) return;
    if (!force && this._logTs && Date.now() - this._logTs < 120000) return;
    this._logBusy = true;
    try {
      const list = await hass.callWS({ type: 'system_log/list' });
      this._log = (list || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      this._logErr = '';
    } catch (err) {
      this._log = this._log || [];
      this._logErr = err && err.code === 'unauthorized' ? 'Nur für Administratoren verfügbar.' : (err.message || String(err));
    } finally {
      this._logTs = Date.now(); this._logBusy = false;
      const lv = (e) => String(e.level || '').toUpperCase();
      this._logSum = { err: this._log.filter((e) => ['ERROR', 'CRITICAL'].includes(lv(e))).length, warn: this._log.filter((e) => lv(e) === 'WARNING').length };
      if (this._hass) { this._renderLinks(); if (['log', 'integrations'].includes(this._pop?.key)) this._updatePopup(); }
    }
  }

  /* ---------- Integrationen: Konfigurationseinträge, Reparaturen, Überwachung (nur Admins) ---------- */
  async _fetchSys(force) {
    const hass = this._hass;
    if (!hass?.user?.is_admin || this._sysBusy) return;
    if (!force && this._sysTs && Date.now() - this._sysTs < 60000) return;
    this._sysBusy = true;
    try {
      const [entries, issues] = await Promise.all([
        hass.callWS({ type: 'config_entries/get' }).catch(() => this._entries || []),
        hass.callWS({ type: 'repairs/list_issues' }).then((r) => r.issues || []).catch(() => this._issues || []),
      ]);
      this._entries = entries; this._issues = issues;
      if (this._monSel === undefined) {
        const r = await hass.callWS({ type: 'frontend/get_user_data', key: 'hmc_integrations' }).catch(() => null);
        this._monSel = Array.isArray(r?.value) ? r.value : null;
      }
      const doms = [...new Set(entries.map((e) => e.domain))].filter((d) => !(this._manifests || {})[d]);
      if (doms.length) {
        const list = await hass.callWS({ type: 'manifest/list', integrations: doms }).catch(() => []);
        this._manifests = { ...(this._manifests || {}), ...Object.fromEntries(list.map((m) => [m.domain, m])) };
      }
    } finally {
      this._sysTs = Date.now(); this._sysBusy = false;
      if (this._hass) { this._renderStatus(); this._renderLinks(); if (['maint', 'integrations'].includes(this._pop?.key)) this._updatePopup(); }
    }
  }

  /** Konfigurationseinträge mit Fehler (nicht deaktiviert) */
  _entryErrors() {
    return (this._entries || []).filter((e) => !e.disabled_by && ['setup_error', 'setup_retry', 'migration_error', 'failed_unload'].includes(e.state));
  }

  /** offene Neustarts: Reparaturmeldungen, die einen Neustart verlangen */
  _restarts() {
    return (this._issues || []).filter((i) => !i.dismissed_version && !i.ignored
      && /restart/i.test(`${i.issue_id} ${i.translation_key || ''}`));
  }

  _intName(domain) { return this._manifests?.[domain]?.name || (this._entries || []).find((e) => e.domain === domain)?.title || domain; }

  /** überwachte Integrationen: eigene Auswahl oder Integrationen aus Links und Herstellerkarten */
  /** Helfer für die Auswahl (gemeinsam mit der Überwachung in Home Assistant), sonst Benutzerdaten */
  _monEntity() {
    const id = this._config.monitor_entity || 'input_text.integrationen_ueberwachung';
    return this._hass?.states[id] ? id : null;
  }

  _monDomains() {
    const me = this._monEntity();
    if (me) {
      const v = String(this._hass.states[me].state || '');
      if (!['unknown', 'unavailable'].includes(v)) return v.split(',').map((x) => x.trim()).filter(Boolean).sort();
    }
    if (Array.isArray(this._monSel)) return this._monSel;
    const d = new Set([...(this._config.links || []).map((l) => l.integration), ...(this._config.makers || []).map((m) => m.integration)].filter(Boolean));
    return [...d].sort();
  }

  _logOf(domain) {
    const re = new RegExp(`(^|\\.)(components|custom_components)\\.${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.|$)`);
    // Bibliotheken, die unter eigenem Logger-Namen schreiben, ihrer Integration zuordnen
    const LIBS = { aioesphomeapi: 'esphome', aioshelly: 'shelly', hatasmota: 'tasmota', proxmoxer: 'proxmoxve', hole: 'pi_hole',
      pymiele: 'miele_lan', pysenec: 'senec', reolink_aio: 'reolink', ...(this._config.log_libraries || {}) };
    return (this._log || []).filter((e) => re.test(e.name || '') || LIBS[String(e.name || '').split('.')[0]] === domain
      || (e.source || []).some((x) => typeof x === 'string' && x.includes(`/${domain}/`)));
  }

  /** Zustand einer Integration: Einträge, Geräte, Log */
  _monitor(domain) {
    const hass = this._hass;
    const entries = (this._entries || []).filter((e) => e.domain === domain && !e.disabled_by);
    const bad = entries.filter((e) => ['setup_error', 'setup_retry', 'migration_error', 'failed_unload'].includes(e.state));
    const devStates = {};
    for (const e of Object.values(hass.entities || {})) {
      if (e.platform !== domain || !e.device_id) continue;
      const st = hass.states[e.entity_id]; if (!st) continue;
      (devStates[e.device_id] ||= []).push(st);
    }
    const devs = Object.keys(devStates).filter((id) => hass.devices[id] && !hass.devices[id].disabled_by);
    const off = devs.filter((id) => devStates[id].every((s) => s.state === 'unavailable'));
    const log = this._logOf(domain);
    const lv = (e) => String(e.level || '').toUpperCase();
    const TO = /time(d)?[ -]?out|timeouterror|clientconnectorerror|cannot connect|connection (refused|reset|error|lost)|unreachable|not reachable|nicht erreichbar|no route to host|server disconnected|failed to connect/i;
    const txt = (e) => `${(e.message || []).join(' ')} ${e.exception || ''}`;
    const errs = log.filter((e) => ['ERROR', 'CRITICAL'].includes(lv(e)));
    const warns = log.filter((e) => lv(e) === 'WARNING');
    const timeouts = log.filter((e) => TO.test(txt(e)));
    const recent = (l) => l.filter((e) => Date.now() / 1000 - (e.timestamp || 0) < 3600);
    const tcount = timeouts.reduce((a, e) => a + (e.count || 1), 0);
    let lvl = 0;
    if (recent(warns).length || recent(timeouts).length || off.length) lvl = 1;
    if (bad.length || recent(errs).length || (devs.length && off.length === devs.length)) lvl = 2;
    if (!entries.length) lvl = 2;
    return { domain, entries, bad, devs, off, log, errs, warns, timeouts, tcount, lvl };
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
    const out = { lights: [], switches: [], open: [], heat: [], climate: [], covers: [], updates: [], battery: [], offline: [] };
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
      if (dom === 'switch') { if (!BAD.includes(st.state) && (dc === 'outlet' || SW_LOAD.test(`${this._name(st)} ${e.entity_id}`))) out.switches.push(st); } else if (dom === 'light') { if (st.state === 'on') out.lights.push(st); } else if (dom === 'binary_sensor') { if (OPEN_DC.includes(dc) && st.state === 'on') out.open.push(st); } else if (dom === 'climate') {
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
    // Person des angemeldeten Benutzers; die konfigurierte Person nur, wenn sie zu ihm gehört oder kein Benutzer bekannt ist
    const persons = Object.values(hass.states).filter((s) => s.entity_id.startsWith('person.'));
    const conf = hass.states[this._config.person];
    const p = (hass.user && persons.find((s) => s.attributes.user_id === hass.user.id))
      || (!hass.user || conf?.attributes.user_id === hass.user?.id ? conf : null);
    this._personId = p?.entity_id || '';
    const first = (p?.attributes.friendly_name || hass.user?.name || '').split(' ')[0];
    const greet = `${h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'}${first ? `, ${first}` : ''}`;
    const w = hass.states[this._config.weather];
    const pic = p?.attributes.entity_picture;
    const t = w?.attributes.temperature;
    const html = `<div class="hdr">
      <div class="av ${p && p.state !== 'home' ? 'away' : ''}" data-more="${esc(this._personId)}" ${pic ? `style="background-image:url('${esc(pic)}')"` : ''}>${pic ? '' : '<ha-icon icon="mdi:account"></ha-icon>'}</div>
      <div class="greet"><div class="gl"><div class="g">${esc(greet)}</div>
        ${w ? `<div class="wx" data-more="${esc(this._config.weather)}" title="${esc(w.attributes.friendly_name || '')}"><ha-icon icon="${WX[w.state] || 'mdi:weather-cloudy'}"></ha-icon><span>${t != null ? `${nf(t)}°` : '–'}</span></div>` : ''}</div><div class="s">${esc(now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))} · <span class="tm">${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span></div></div></div>`;
    this._set('hdr', html);
  }

  _renderStatus() {
    const hass = this._hass;
    const d = this._data;
    const items = [];
    // Kacheln mit aktiven Geräten pulsieren wie die DWD-Warnung
    const BLINK = ['lights', 'heat', 'open', 'covers', 'switches'];
    const si = (k, icon, color, label, n, on, alert = false, act = 'pop', blink = on && BLINK.includes(k)) => items.push(`<div class="card si click ${on ? 'on' : ''} ${alert ? 'alert' : ''} ${blink ? 'blink' : ''}" data-k="${k}"
      ${act === 'pop' ? `data-pop="${k}"` : `data-more="${esc(act)}"`} style="--c:${color}">
      <div class="bub"><ha-icon icon="${icon}"></ha-icon></div>${n ? `<span class="cnt">${n}</span>` : ''}<div class="l">${esc(label)}</div></div>`);
    si('lights', d.lights.length ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline', '#ffc107', d.lights.length ? 'Licht an' : 'Licht aus', d.lights.length, d.lights.length > 0);
    si('heat', d.heat.length ? 'mdi:radiator' : 'mdi:radiator-off', '#ff6f22', d.heat.length ? 'Heizung aktiv' : 'Heizung aus', d.heat.length, d.heat.length > 0);
    si('open', d.open.length ? 'mdi:window-open-variant' : 'mdi:window-closed-variant', '#2196f3', d.open.length ? 'Fenster offen' : 'Fenster zu', d.open.length, d.open.length > 0);
    si('covers', d.covers.length ? 'mdi:window-shutter-open' : 'mdi:window-shutter', '#9c27b0', d.covers.length ? 'Rollos offen' : 'Rollos zu', d.covers.length, d.covers.length > 0);
    if (this._config.switches !== false && d.switches.length) {
      const n = d.switches.filter((x) => x.state === 'on').length;
      si('switches', n ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off-outline', '#03a9f4', n ? 'Schalter an' : 'Schalter aus', n, n > 0);
    }
    const maint = d.updates.length + d.battery.length + d.offline.length + this._entryErrors().length + this._restarts().length;
    si('maint', 'mdi:wrench', '#ffa600', maint ? 'Wartung' : 'Alles ok', maint, maint > 0);
    const v = hass.states[this._config.valve];
    if (v) {
      const open = ['open', 'opening', 'on'].includes(v.state);
      const bad = BAD.includes(v.state);
      si('valve', open ? 'mdi:valve-open' : 'mdi:valve-closed', open ? '#00bcd4' : '#f44336', bad ? 'Ventil ?' : open ? 'Ventil offen' : 'Ventil zu', 0, !bad, !open && !bad, this._config.valve, open);
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
    // aktive Geräte: mindestens eine Entität eingeschaltet bzw. in Betrieb
    const isAct = (st) => {
      const dom = st.entity_id.split('.')[0]; const s = st.state; const a = st.attributes;
      return (['switch', 'light', 'fan', 'humidifier', 'siren'].includes(dom) && s === 'on')
        || (dom === 'climate' && (HEAT.includes(a.hvac_action) || a.hvac_action === 'cooling'))
        || (dom === 'media_player' && s === 'playing') || (dom === 'vacuum' && s === 'cleaning') || (dom === 'lawn_mower' && s === 'mowing')
        || (dom === 'camera' && ['recording', 'streaming'].includes(s))
        || (dom === 'binary_sensor' && ['running', 'power', 'plug'].includes(a.device_class) && s === 'on')
        || (dom === 'sensor' && /^(running|in_use|programmed|on|active)$/i.test(s) && a.device_class === 'enum');
    };
    act = ids.filter((id) => devs[id].some(isAct)).length;
    return (this._lsCache[integration] = { n: ids.length, off, upd, act });
  }

  _renderLinks() {
    const hass = this._hass;
    const html = (this._config.links || []).map((l, i) => {
      // Nur für Administratoren: admin: true, Log- und Integrations-Popup, Integrationen aus admin_only
      if (!hass.user?.is_admin && (l.admin || ['log', 'integrations'].includes(l.popup)
        || (l.integration && (this._config.admin_only || []).includes(l.integration)))) return '';
      // Links zu Integrationen ohne Geräte (nicht installiert) ausblenden, außer show_empty: true
      if (l.integration && !l.show_empty && !this._linkStats(l.integration).n) return '';
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
      if (l.popup === 'log') {
        const s = this._logSum;
        if (!s) info.push('Home Assistant Log');
        else if (s.err) info.push(`<span class="err">${s.err} Fehler</span>`, ...(s.warn ? [`<span class="warn">${s.warn} Warnung${s.warn === 1 ? '' : 'en'}</span>`] : []));
        else info.push(s.warn ? `<span class="warn">${s.warn} Warnung${s.warn === 1 ? '' : 'en'}</span>` : '<span class="ok">keine Fehler</span>');
      }
      let badge = '';
      if (l.integration) { const a = this._linkStats(l.integration).act; if (a) badge = `<span class="bdg" title="${a} aktiv">${a}</span>`; }
      if (l.popup === 'integrations' && this._entries) {
        const ms = this._monDomains().map((d) => this._monitor(d));
        const e = ms.filter((m) => m.lvl === 2).length; const w = ms.filter((m) => m.lvl === 1).length;
        info.push(e ? `<span class="err">${e} gestört</span>` : w ? `<span class="warn">${w} mit Warnungen</span>` : `<span class="ok">${ms.length} ok</span>`);
        if (e || w) badge = `<span class="bdg ${e ? 'err' : 'warn'}">${e + w}</span>`;
      } else if (l.popup === 'integrations') info.push('Überwachung');
      if (l.text) info.push(esc(l.text));
      return `<div class="card lk click" data-k="l${i}" data-link="${i}" style="--c:${esc(l.color || 'var(--primary-color)')}">
        <div class="bub">${badge}<ha-icon icon="${esc(l.icon || 'mdi:open-in-app')}"></ha-icon></div>
        <div class="n"><b>${esc(l.name || l.path)}</b><span>${info.join(' · ')}</span></div><ha-icon icon="mdi:chevron-right"></ha-icon></div>`;
    }).join('');
    this._set('links', html);
    this.shadowRoot.getElementById('linksec').hidden = !html;
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
    // Mediengeräte nur bei laufender Wiedergabe
    const media = of('media_player').filter((s) => s.state === 'playing');
    if (media.length) ic('mdi:play-circle', '#2196f3', media.length, true, `${media.length} Wiedergabe${media.length > 1 ? 'n' : ''}`);
    const open = sts.filter((s) => s.entity_id.startsWith('binary_sensor.') && OPEN_DC.includes(s.attributes.device_class));
    if (open.some((s) => s.state === 'on')) { const n = open.filter((s) => s.state === 'on').length; ic('mdi:window-open-variant', '#2196f3', n, true, `${n} offen`); }
    for (const g of this._appsOf(a.area_id)) {
      ic(g.icon, g.c, g.n, g.act > 0, `${g.name}: ${g.n}${g.act ? `, ${g.act} aktiv` : ''}`);
    }
    const cams = this._areaCams(a.area_id).map((id) => hass.states[id]);
    if (cams.length) {
      out.push(`<span class="ic camic ${cams.some((s) => !BAD.includes(s.state)) ? 'on' : ''}" style="--c:#009688" data-cams="${esc(a.area_id)}"
        title="${cams.length > 1 ? `${cams.length} Kameras` : 'Kamera'}"><ha-icon icon="mdi:cctv"></ha-icon>${cams.length > 1 ? cams.length : ''}</span>`);
    }
    return out.join('');
  }

  /** Gerätegruppen eines Raums: Anzahl (Messdose und Gerät selbst zählen als eines) und Anzahl aktiv */
  _appsOf(areaId) {
    const hass = this._hass;
    if (this._apFor !== hass.devices || this._apSt !== hass.states || this._apHide !== HIDE.ver) { this._apFor = hass.devices; this._apSt = hass.states; this._apHide = HIDE.ver; this._apC = {}; }
    if (this._apC[areaId]) return this._apC[areaId];
    const groups = {};
    for (const d of Object.values(hass.devices || {})) {
      if (d.area_id !== areaId || d.disabled_by || d.entry_type === 'service' || HIDE.ids.has(d.id) || HIDE.restrictedDev?.(d.id)) continue;
      const name = `${d.name_by_user || d.name || ''} ${d.model || ''}`;
      const g = !APPS_EXCL.test(name) && APPS.find((x) => x.re.test(name));
      if (!g) continue;
      const r = window.__hmcActRaw ? window.__hmcActRaw(hass, d.id) : { a: '' };
      const x = (groups[g.k] ||= { g, plug: 0, dev: 0, act: 0 });
      if (PLUG.test(name)) x.plug++; else x.dev++;
      if (r.a) x.act++;
    }
    const out = APPS.filter((g) => groups[g.k]).map((g) => { const x = groups[g.k]; const n = Math.max(x.plug, x.dev); return { ...g, n, act: Math.min(x.act, n) }; });
    return (this._apC[areaId] = out);
  }

  /** alle Kameras eines Bereichs: konfigurierte zuerst, dann zugeordnete (auch ausgeblendete) */
  _areaCams(areaId) {
    const hass = this._hass;
    const ids = Object.values(hass.entities || {})
      .filter((e) => e.entity_id.startsWith('camera.') && !HIDE.restricted(e) && (e.area_id || (e.device_id && hass.devices[e.device_id]?.area_id)) === areaId)
      .map((e) => e.entity_id).sort();
    return [...new Set([this._config.cameras[areaId], ...ids])].filter((id) => id && hass.states[id]);
  }

  /** Kamera-Popup über allem (auch über dem Raum-Popup) */
  async _openCams(ids, title) {
    this._closeCams();
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>${POP_CSS}
      .bg { z-index:101; } .cg { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); }</style>
      <div class="bg"><div class="pop" style="--w:${ids.length > 1 ? 1280 : 900}px; --c:#009688">
      <div class="ph"><div class="bub"><ha-icon icon="mdi:cctv"></ha-icon></div><div class="t">${esc(title || 'Kameras')}<small>${ids.length} Kamera${ids.length === 1 ? '' : 's'} · Bild antippen für Livebild</small></div>
      <button class="x" data-x title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="pb"><div class="cg"></div></div></div></div>`;
    this._popStyle(host);
    const r = host.shadowRoot;
    const cp = this._camPop = { host, els: [] };
    for (const type of ['hass-more-info', 'show-dialog']) {
      host.addEventListener(type, (e) => {
        if (e.__hd) return;
        e.stopPropagation();
        const ev = new CustomEvent(type, { detail: e.detail, bubbles: true, composed: true }); ev.__hd = true;
        this.dispatchEvent(ev);
      });
    }
    r.querySelector('.bg').addEventListener('click', (e) => {
      if (e.target.classList.contains('bg') || e.composedPath().some((el) => el.dataset && el.dataset.x != null)) this._closeCams();
    });
    this._camEsc = (e) => { if (e.key === 'Escape' && this._camPop) { e.stopImmediatePropagation(); this._closeCams(); } };
    window.addEventListener('keydown', this._camEsc, true);
    document.body.appendChild(host);
    const grid = r.querySelector('.cg');
    for (const id of ids) {
      const slot = document.createElement('div'); grid.appendChild(slot);
      this._card({ type: 'picture-entity', entity: id, show_state: false, camera_view: 'auto', tap_action: { action: 'more-info' } })
        .then((c) => { if (this._camPop !== cp) return; c.hass = this._hass; cp.els.push(c); slot.appendChild(c); })
        .catch((err) => console.warn('home-dashboard-card:', err));
    }
  }

  /** Deckkraft (popup_opacity, %), Unschärfe (popup_blur, px) und Abdunklung (popup_dim, %) der Popups */
  _popStyle(host) {
    const c = this._config; const cl = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    host.style.setProperty('--pop-op', `${cl(c.popup_opacity, 0, 100, 50)}%`);
    host.style.setProperty('--pop-blur', `${cl(c.popup_blur, 0, 40, 10)}px`);
    host.style.setProperty('--pop-dim', `${cl(c.popup_dim, 0, 100, 20) / 100}`);
  }

  _closeCams() {
    if (!this._camPop) return;
    this._camPop.host.remove();
    window.removeEventListener('keydown', this._camEsc, true);
    this._camPop = null;
  }

  _renderRooms() {
    const hass = this._hass;
    const areas = this._areas();
    const html = areas.map((a) => {
      const sts = this._areaStates(a.area_id);
      const c = this._climate(a, sts);
      const pid = this._powerId(a);
      const p = num(hass.states[pid]);
      const cam = this._config.camera_background !== false && this._config.cameras[a.area_id] && hass.states[this._config.cameras[a.area_id]];
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
    for (const [areaId, id] of Object.entries(this._config.camera_background !== false ? this._config.cameras || {} : {})) {
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
    if (link) {
      const l = this._config.links[Number(link.dataset.link)];
      if (l?.popup) this._openPopup(l.popup); else if (l?.path) this._navigate(l.path);
      return;
    }
    const cam = path.find((el) => el.dataset && el.dataset.cams);
    if (cam) { e.stopPropagation(); this._openCams(this._areaCams(cam.dataset.cams), this._hass.areas[cam.dataset.cams]?.name); return; }
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
      } else if (ds.act === 'logf') { this._logF = ds.v; this._updatePopup();
      } else if (ds.act === 'logx') { if (this._logOpen.has(ds.k)) this._logOpen.delete(ds.k); else this._logOpen.add(ds.k); this._updatePopup();
      } else if (ds.act === 'logr') { this._fetchLog(true);
      } else if (ds.act === 'logclear') {
        if (!window.confirm('Systemprotokoll zurücksetzen? Alle Einträge im Home-Assistant-Log werden gelöscht.')) return;
        await hass.callService('system_log', 'clear', {});
        this._logOpen = new Set(); this._fetchLog(true);
        this._fire('hass-notification', { message: 'Systemprotokoll zurückgesetzt' });
      } else if (ds.act === 'logall') { this._closePopup(); this._navigate('/config/logs');
      } else if (ds.act === 'restart') {
        if (!window.confirm('Home Assistant jetzt neu starten?')) return;
        await hass.callService('homeassistant', 'restart', {});
      } else if (ds.act === 'intreload') {
        await hass.callService('homeassistant', 'reload_config_entry', { entry_id: ds.e });
        this._fire('hass-notification', { message: `${ds.n} wird neu geladen` });
        setTimeout(() => this._fetchSys(true), 3000);
      } else if (ds.act === 'intopen') { this._closePopup(); this._navigate(`/config/integrations/integration/${ds.d}`);
      } else if (ds.act === 'monx') { if (this._monOpen.has(ds.d)) this._monOpen.delete(ds.d); else this._monOpen.add(ds.d); this._updatePopup();
      } else if (ds.act === 'monr') { this._fetchSys(true); this._fetchLog(true);
      } else if (ds.act === 'monedit') { this._monEdit = !this._monEdit; this._monQ = ''; this._updatePopup();
      } else if (ds.act === 'montog' || ds.act === 'monall') {
        const sel = new Set(this._monDomains());
        if (ds.act === 'monall') sel.clear(); else if (sel.has(ds.d)) sel.delete(ds.d); else sel.add(ds.d);
        this._monSel = [...sel].sort(); this._updatePopup(); this._renderLinks();
        const me = this._monEntity();
        if (me) {
          const v = this._monSel.join(',');
          const max = hass.states[me].attributes.max || 255;
          if (v.length > max) { this._fire('hass-notification', { message: `Zu viele Integrationen für ${me} (max. ${max} Zeichen)` }); return; }
          await hass.callService('input_text', 'set_value', { entity_id: me, value: v });
        } else await hass.callWS({ type: 'frontend/set_user_data', key: 'hmc_integrations', value: this._monSel });
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
    this._popStyle(host);
    const r = host.shadowRoot;
    this._pop = { key, host, r, els: [], html: null };
    // Ereignisse aus dem Popup (liegt an <body>) an Home Assistant weiterreichen
    host.addEventListener('hmc-cameras', (e) => { e.detail.handled = true; e.stopPropagation(); this._openCams(e.detail.ids, e.detail.title); });
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
    r.querySelector('.bg').addEventListener('input', (e) => {
      const t = e.composedPath()[0];
      if (t && t.dataset && t.dataset.logq != null) { this._logQ = t.value.toLowerCase(); this._updatePopup(); }
      if (t && t.dataset && t.dataset.monq != null) { this._monQ = t.value; this._updatePopup(); }
    });
    this._escKey = (e) => { if (e.key === 'Escape' && this._pop) this._closePopup(); };
    window.addEventListener('keydown', this._escKey);
    document.body.appendChild(host);
    this._fillPopup();
  }

  _closePopup() {
    clearInterval(this._logTick);
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
        min_width: 300, hide_label: this._config.hide_label, admin_only: this._config.admin_only || [] });
      el._area = arg;
      this._popEl(el);
    } else if (kind === 'log') {
      this._logF = this._logF || 'all'; this._logQ = ''; this._logOpen = new Set();
      this._popHead('mdi:math-log', '#03a9f4', 'Home Assistant Log', 'Systemprotokoll', 1040);
      this._fetchLog(true);
      clearInterval(this._logTick);
      this._logTick = setInterval(() => this._fetchLog(true), 10000);
    } else if (kind === 'integrations') {
      this._monOpen = this._monOpen || new Set(); this._monEdit = false; this._monQ = '';
      this._popHead('mdi:puzzle-check-outline', '#7e57c2', 'Integrationen', 'Verbindung, Geräte und Fehler', 1000);
      this._fetchSys(true); this._fetchLog(true);
      clearInterval(this._logTick);
      this._logTick = setInterval(() => { this._fetchLog(true); this._fetchSys(true); }, 20000);
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
      case 'switches': {
        const on = d.switches.filter((x) => x.state === 'on').length;
        this._popHead('mdi:toggle-switch', '#03a9f4', 'Schalter', `${on} von ${d.switches.length} an`, 560);
        const pw = (st) => {
          // Leistung der Messdose am selben Gerät, falls vorhanden
          const dev = hass.entities[st.entity_id]?.device_id;
          const p = dev && Object.values(hass.entities).find((e) => e.device_id === dev && e.entity_id.startsWith('sensor.') && hass.states[e.entity_id]?.attributes.device_class === 'power' && !e.entity_category);
          const v = p && num(hass.states[p.entity_id]);
          return v != null && v >= 1 ? `<span style="margin-right:12px">${fW(v * (hass.states[p.entity_id].attributes.unit_of_measurement === 'kW' ? 1000 : 1))}</span>` : '';
        };
        return list(byArea(d.switches).map((s) => this._row(s, `<span style="display:inline-flex;align-items:center">${s.state === 'on' ? pw(s) : ''}${tog(s)}</span>`,
          s.state === 'on' ? 'mdi:power-socket-de' : 'mdi:power-plug-off-outline', s.state === 'on' ? '#03a9f4' : '')));
      }
      case 'open':
        this._popHead('mdi:window-open-variant', '#2196f3', 'Fenster & Türen', `${d.open.length} offen`, 520);
        return list(byArea(d.open).map((s) => this._row(s, 'offen', 'mdi:window-open-variant', '#2196f3')));
      case 'covers':
        this._popHead('mdi:window-shutter-open', '#9c27b0', 'Rollos', `${d.covers.length} offen`, 520);
        return list(byArea(d.covers).map((s) => this._row(s, fmt(s), 'mdi:window-shutter-open', '#9c27b0')));
      case 'maint': {
        this._popHead('mdi:wrench', '#ffa600', 'Wartung', '', 620);
        const sec = (t, rows) => (rows.length ? `<div class="sec">${t}</div><div class="lst">${rows.join('')}</div>` : '');
        const ST = { setup_error: 'Einrichtung fehlgeschlagen', setup_retry: 'Wiederholt Verbindungsaufbau', migration_error: 'Migration fehlgeschlagen', failed_unload: 'Entladen fehlgeschlagen' };
        const html = sec('Neustart ausstehend', this._restarts().map((i) => `<div class="it" data-k="r-${esc(i.issue_id)}"><ha-icon icon="mdi:restart-alert" style="--c:#ffa600"></ha-icon>
            <div class="n">${esc(this._intName(i.domain))}<small>Neustart erforderlich${i.issue_domain && i.issue_domain !== i.domain ? ` · ${esc(this._intName(i.issue_domain))}` : ''}</small></div>
            <button class="btn" data-act="restart">Neu starten</button></div>`))
          + sec('Integrationen mit Fehler', this._entryErrors().map((e) => `<div class="it" data-k="e-${esc(e.entry_id)}"><ha-icon icon="mdi:puzzle-remove-outline" style="--c:#db4437"></ha-icon>
            <div class="n" data-act="intopen" data-d="${esc(e.domain)}" style="cursor:pointer">${esc(e.title)}<small>${esc(this._intName(e.domain))} · ${esc(ST[e.state] || e.state)}${e.reason ? ` · ${esc(e.reason)}` : ''}</small></div>
            <button class="btn sec" data-act="intreload" data-e="${esc(e.entry_id)}" data-n="${esc(e.title)}">Neu laden</button></div>`))
          + sec('Updates', d.updates.map((s) => `<div class="it" data-k="${s.entity_id}" data-more="${s.entity_id}"><ha-icon icon="mdi:package-up" style="--c:#ffa600"></ha-icon>
            <div class="n">${esc(this._name(s))}<small>${esc(s.attributes.installed_version || '')} → ${esc(s.attributes.latest_version || '')}</small></div>
            ${this._hass.user?.is_admin ? `<button class="btn" data-act="install" data-e="${s.entity_id}" data-n="${esc(this._name(s))}">Installieren</button>` : ''}</div>`))
          + sec('Batterien', d.battery.map((s) => this._row(s, fmt(s), 'mdi:battery-alert-variant-outline', '#db4437')))
          + sec('Nicht erreichbar', d.offline.map(({ devId, d: dv }) => `<div class="it" data-k="${esc(devId)}" data-act="device" data-d="${esc(devId)}"><ha-icon icon="mdi:lan-disconnect" style="--c:#db4437"></ha-icon>
            <div class="n">${esc(dv.name_by_user || dv.name)}<small>${esc([hass.areas[dv.area_id]?.name, dv.manufacturer, dv.model].filter(Boolean).join(' · '))}</small></div></div>`));
        return html || '<div class="none">Nichts zu tun.</div>';
      }
      case 'integrations': {
        if (!this._entries) return '<div class="none">Lädt …</div>';
        if (this._monEdit) {
          const sel = new Set(this._monDomains());
          const q = (this._monQ || '').toLowerCase();
          const doms = [...new Set(this._entries.map((e) => e.domain))].map((d) => ({ d, n: this._intName(d) }))
            .filter((x) => !q || `${x.d} ${x.n}`.toLowerCase().includes(q)).sort((a, b) => a.n.localeCompare(b.n, 'de'));
          return `<div class="lbar"><input class="lq" data-monq placeholder="Integration suchen …" type="search">
              <button class="btn sec" data-act="monall" data-v="0">Keine</button><button class="btn" data-act="monedit">Fertig</button></div>
            <div class="linf">${sel.size} ausgewählt · ${this._monEntity() ? 'gilt auch für die Überwachung mit Telegram-Meldungen' : 'die Auswahl wird für deinen Benutzer gespeichert'}</div>
            <div class="msel">${doms.map((x) => `<label class="mchk ${sel.has(x.d) ? 'on' : ''}" data-act="montog" data-d="${esc(x.d)}" data-k="m-${esc(x.d)}">
              <ha-icon icon="${sel.has(x.d) ? 'mdi:checkbox-marked' : 'mdi:checkbox-blank-outline'}"></ha-icon><span>${esc(x.n)}<small>${esc(x.d)}</small></span></label>`).join('')}</div>`;
        }
        const ST = { loaded: 'verbunden', setup_error: 'Einrichtung fehlgeschlagen', setup_retry: 'versucht erneut zu verbinden', migration_error: 'Migration fehlgeschlagen',
          failed_unload: 'Entladen fehlgeschlagen', not_loaded: 'nicht geladen', setup_in_progress: 'wird eingerichtet' };
        const ms = this._monDomains().map((d) => this._monitor(d)).sort((a, b) => b.lvl - a.lvl || this._intName(a.domain).localeCompare(this._intName(b.domain), 'de'));
        const C = ['#4caf50', '#ff9800', '#f44336'];
        const ts = (t) => (t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
        const bar = `<div class="lbar"><span class="linf" style="margin:0;flex:1">${ms.filter((m) => m.lvl === 2).length} gestört · ${ms.filter((m) => m.lvl === 1).length} mit Warnungen · ${ms.filter((m) => !m.lvl).length} ok
            · Stand ${this._sysTs ? new Date(this._sysTs).toLocaleTimeString('de-DE') : '–'}</span>
          <button class="btn sec" data-act="monr" title="Neu laden">↻</button><button class="btn sec" data-act="monedit">Auswahl bearbeiten</button></div>`;
        if (!ms.length) return `${bar}<div class="none">Keine Integrationen ausgewählt.</div>`;
        return bar + `<div class="lst">${ms.map((m) => {
          const name = this._intName(m.domain);
          const open = this._monOpen.has(m.domain);
          const chips = [];
          if (!m.entries.length) chips.push('<span class="ch err">nicht eingerichtet</span>');
          else if (m.bad.length) chips.push(`<span class="ch err">${esc(ST[m.bad[0].state] || m.bad[0].state)}</span>`);
          else chips.push(`<span class="ch ok">${m.entries.length > 1 ? `${m.entries.length} Einträge ` : ''}verbunden</span>`);
          if (m.devs.length) chips.push(m.off.length ? `<span class="ch ${m.off.length === m.devs.length ? 'err' : 'warn'}">${m.off.length} von ${m.devs.length} Geräten offline</span>` : `<span class="ch">${m.devs.length} Geräte online</span>`);
          if (m.tcount) chips.push(`<span class="ch warn">${m.tcount}× Timeout/Verbindung</span>`);
          if (m.errs.length) chips.push(`<span class="ch err">${m.errs.length} Fehler</span>`);
          if (m.warns.length) chips.push(`<span class="ch warn">${m.warns.length} Warnung${m.warns.length === 1 ? '' : 'en'}</span>`);
          const last = m.log[0];
          let det = '';
          if (open) {
            const eRows = m.entries.map((e) => `<div class="mrow"><ha-icon icon="mdi:link-variant" style="color:${['loaded'].includes(e.state) ? C[0] : C[2]}"></ha-icon>
              <span>${esc(e.title)} · ${esc(ST[e.state] || e.state)}${e.reason ? ` · ${esc(e.reason)}` : ''}</span>
              <button class="btn sec" data-act="intreload" data-e="${esc(e.entry_id)}" data-n="${esc(e.title)}">Neu laden</button></div>`).join('');
            const oRows = m.off.map((id) => { const dv = this._hass.devices[id]; return `<div class="mrow click" data-act="device" data-d="${esc(id)}"><ha-icon icon="mdi:lan-disconnect" style="color:${C[2]}"></ha-icon>
              <span>${esc(dv.name_by_user || dv.name)}${dv.area_id && this._hass.areas[dv.area_id] ? ` · ${esc(this._hass.areas[dv.area_id].name)}` : ''}</span></div>`; }).join('');
            const lRows = m.log.slice(0, 8).map((e) => `<div class="mrow"><span class="mlv" style="color:${String(e.level).toUpperCase() === 'WARNING' ? C[1] : C[2]}">${esc(String(e.level || '').slice(0, 1))}</span>
              <span>${esc((e.message || [])[0] || '')}<small>${esc(ts(e.timestamp))}${e.count > 1 ? ` · ${e.count}×` : ''}</small></span></div>`).join('');
            det = `<div class="mdet">${eRows ? `<div class="msub">Verbindung</div>${eRows}` : ''}${oRows ? `<div class="msub">Offline</div>${oRows}` : ''}
              ${lRows ? `<div class="msub">Log</div>${lRows}` : '<div class="msub">Log</div><div class="mrow"><span>Keine Fehler oder Warnungen im Log.</span></div>'}
              <div class="acts" style="margin-top:8px"><button class="btn sec" data-act="intopen" data-d="${esc(m.domain)}">Integration öffnen</button></div></div>`;
          }
          return `<div class="mi" data-k="mi-${esc(m.domain)}" style="--c:${C[m.lvl]}">
            <div class="mh" data-act="monx" data-d="${esc(m.domain)}"><span class="dot"></span><div class="n">${esc(name)}
              ${last && !open ? `<small>${esc(ts(last.timestamp))} · ${esc(((last.message || [])[0] || '').slice(0, 140))}</small>` : ''}</div>
              <div class="chs">${chips.join('')}</div><ha-icon icon="mdi:chevron-${open ? 'up' : 'down'}"></ha-icon></div>${det}</div>`;
        }).join('')}</div>`;
      }
      case 'log': {
        const lv = (e) => String(e.level || '').toUpperCase();
        const LV = { CRITICAL: ['Kritisch', '#9c27b0'], ERROR: ['Fehler', '#f44336'], WARNING: ['Warnung', '#ff9800'], INFO: ['Info', '#03a9f4'], DEBUG: ['Debug', '#9e9e9e'] };
        const all = this._log || [];
        const cnt = (f) => all.filter(f).length;
        const fl = { all: () => true, error: (e) => ['ERROR', 'CRITICAL'].includes(lv(e)), warning: (e) => lv(e) === 'WARNING', info: (e) => ['INFO', 'DEBUG'].includes(lv(e)) };
        const q = this._logQ || '';
        const rows = all.filter(fl[this._logF] || fl.all).filter((e) => !q || `${e.name} ${(e.message || []).join(' ')} ${(e.source || []).join(':')}`.toLowerCase().includes(q));
        const tab = (v, t, n) => `<button class="lf ${this._logF === v ? 'on' : ''}" data-act="logf" data-v="${v}">${t}${n != null ? ` <b>${n}</b>` : ''}</button>`;
        const ts = (t) => (t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
        const bar = `<div class="lbar">${tab('all', 'Alle', all.length)}${tab('error', 'Fehler', cnt(fl.error))}${tab('warning', 'Warnungen', cnt(fl.warning))}${tab('info', 'Info', cnt(fl.info))}
          <input class="lq" data-logq placeholder="Suchen …" type="search">
          <button class="btn sec" data-act="logr" title="Neu laden">↻</button><button class="btn sec" data-act="logclear" title="Systemprotokoll zurücksetzen">Log leeren</button><button class="btn sec" data-act="logall">Vollständiges Log</button></div>
          <div class="linf">${this._logErr ? `<span style="color:#f44336">${esc(this._logErr)}</span>` : `Stand ${this._logTs ? new Date(this._logTs).toLocaleTimeString('de-DE') : '–'} · aktualisiert sich alle 10 s`}</div>`;
        const body = rows.length ? `<div class="lst">${rows.map((e) => {
          const k = `${e.name}|${(e.source || []).join(':')}|${(e.message || [])[0] || ''}`;
          const [lt, lc] = LV[lv(e)] || [e.level, '#9e9e9e'];
          const open = this._logOpen.has(k);
          const msg = (e.message || []);
          return `<div class="le" data-k="${esc(k)}" data-act="logx" style="--c:${lc}">
            <div class="lh"><span class="lv">${esc(lt)}</span><span class="lm">${esc(msg[0] || '')}</span>${e.count > 1 ? `<span class="lc">${e.count}×</span>` : ''}</div>
            <div class="ls">${esc(ts(e.timestamp))} · ${esc(e.name || '')}${e.source ? ` · ${esc(e.source.join(':'))}` : ''}</div>
            ${open ? `<pre>${esc(msg.join('\n\n'))}${e.exception ? `\n\n${esc(e.exception)}` : ''}</pre>` : ''}</div>`;
        }).join('')}</div>` : `<div class="none">${all.length ? 'Keine Einträge passen zum Filter.' : 'Keine Einträge im Systemprotokoll.'}</div>`;
        return bar + body;
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

}

console.info('%c HA-MANAGER-CARDS %c 1.8.1 ', 'background:#03a9f4;color:#fff', 'background:#eee;color:#333');
