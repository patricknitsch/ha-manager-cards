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
 */
{
const VERSION = '1.0.0';
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
    morph(root.getElementById('grid'), P.filter(Boolean).join(''));
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
