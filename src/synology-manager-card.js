/*
 * Synology Manager Card – NAS-Übersicht im Stil der übrigen Manager Cards (Shelly, Proxmox, Pi-hole, …).
 * Liest alle Geräte der Integration synology_dsm aus der Registry: je NAS eine Kachel mit CPU, RAM, Temperatur,
 * Netzwerk, Volumes, Laufwerken, DSM-Update und Sicherheitsstatus. Wecken per Wake on LAN (Taste der Integration
 * wake_on_lan mit derselben MAC wird automatisch gefunden), Neustart und Herunterfahren mit Rückfrage.
 *
 * Konfiguration (alle optional):
 *   type: custom:synology-manager-card
 *   integration: synology_dsm
 *   min_width: 340
 *   wol: { NAS-Homeserver: button.nas_homeserver_wecken }   # Wecktaste je NAS-Name, falls nicht automatisch gefunden
 *   warn: 80                 # Volume-/RAM-Auslastung ab % gelb
 *   crit: 95                 # ab % rot
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
  :host { --mc-c: #4f7ec2; }
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
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fill, minmax(var(--smc-min, 320px), 1fr)); }
  .dev { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); display:flex; flex-direction:column; overflow:hidden; }
  .dev.offline { opacity:.55; }${window.__hmcActCss || ''}
  .head { display:flex; align-items:center; gap:12px; padding:14px 14px 6px; }
  .ico { position:relative; width:44px; height:44px; border-radius:10px; background: var(--secondary-background-color);
    display:flex; align-items:center; justify-content:center; flex:none; }
  .ico ha-icon { --mdc-icon-size:28px; color: var(--mc-c); }
  .dev.warnst .ico ha-icon { color: var(--warning-color, #ffa600); }
  .dot { position:absolute; right:-3px; bottom:-3px; width:14px; height:14px; border-radius:50%;
    border:2px solid var(--card-background-color); background: var(--success-color, #43a047); }
  .dev.warnst .dot { background: var(--warning-color, #ffa600); }
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

  .bars { padding: 4px 14px 2px; display:flex; flex-direction:column; gap:6px; }
  .bar { cursor:pointer; }
  .bar .l { display:flex; justify-content:space-between; font-size:12px; color: var(--secondary-text-color); margin-bottom:2px; }
  .bar .l b { color: var(--primary-text-color); font-weight:500; }
  .bar .t { height:8px; border-radius:4px; background: var(--divider-color); overflow:hidden; }
  .bar .t i { display:block; height:100%; border-radius:4px; background: var(--primary-color); }
  .bar .t i.w { background: var(--warning-color, #ffa600); } .bar .t i.c { background: var(--error-color, #db4437); }
  .disks { padding: 4px 14px 6px; display:flex; flex-direction:column; gap:2px; font-size:13px; }
  .disk { display:flex; align-items:center; gap:8px; cursor:pointer; padding:3px 0; border-bottom: 1px solid var(--divider-color); }
  .disk:last-child { border-bottom:none; }
  .disk ha-icon { --mdc-icon-size:18px; color: var(--secondary-text-color); }
  .disk .dn { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .disk .ds { font-size:12px; color: var(--success-color, #43a047); } .disk .ds.bad { color: var(--error-color, #db4437); }
  .disk .dt { font-size:12px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; min-width:44px; text-align:right; }
  .sect { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); padding: 8px 14px 0; }
  .pbtn.warn { border-color: var(--warning-color, #ffa600); color: var(--warning-color, #ffa600); }
  .pbtn.err { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
  .pbtn.go { border-color: var(--success-color, #43a047); color: var(--success-color, #43a047); }
  .empty { padding:24px; text-align:center; color: var(--secondary-text-color); }
  [hidden] { display:none !important; }
  .dlg-bg { position:fixed; inset:0; background: rgba(0,0,0,.45); z-index:100; display:flex; align-items:center; justify-content:center; padding:16px; }
  .dlg { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 16px; width:min(640px, 100%);
    max-height: calc(100vh - 32px); display:flex; flex-direction:column; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  .dlg-h { display:flex; align-items:center; gap:12px; padding:16px 16px 8px 20px; }
  .dlg-h .t { font-size:20px; font-weight:600; flex:1; }
  .dlg-h ha-icon { --mdc-icon-size:30px; color:var(--mc-c); }
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

const TK = (ent) => `${ent.translation_key || ''}|${ent.entity_id}`.toLowerCase();

class SynologyManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'synology_dsm', min_width: 340, warn: 80, crit: 95, wol: {}, ...config };
    this._filter = this._filter || '';
    if (!this.shadowRoot) { this.attachShadow({ mode: 'open' }); this._buildShell(); }
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'synology_dsm' }; }

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
    const ids = Object.keys(byDev).filter((id) => hass.devices[id] && !hass.devices[id].disabled_by);
    // Hauptgerät = NAS; Volumes und Laufwerke hängen per via_device_id daran
    const mains = ids.filter((id) => !ids.includes(hass.devices[id].via_device_id));
    const item = (ent, devName) => { const st = hass.states[ent.entity_id]; return st ? { id: ent.entity_id, st, ent, label: this._label(ent, st, devName) } : null; };
    const out = [];
    for (const id of mains) {
      const reg = hass.devices[id];
      const name = (reg.name_by_user || reg.name || id).trim();
      const d = { id, reg, name, url: reg.configuration_url || '', host: '', model: reg.model || '', sw: reg.sw_version || '',
        area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '', all: [], vols: [], disks: [], k: {} };
      try { d.host = d.url ? new URL(d.url).hostname : ''; } catch (e) { /* ignore */ }
      let unav = 0; let n = 0;
      for (const ent of byDev[id]) {
        const it = item(ent, name); if (!it) continue;
        n++; if (it.st.state === 'unavailable') unav++;
        d.all.push(it);
        const k = TK(ent); const dom = ent.entity_id.split('.')[0];
        const set = (key) => { d.k[key] ||= it; };
        if (dom === 'update') set('update');
        else if (dom === 'button') { if (/reboot|neu_starten|restart/.test(k)) set('reboot'); else if (/shutdown|herunterfahren/.test(k)) set('shutdown'); }
        else if (dom === 'binary_sensor' && it.st.attributes.device_class === 'safety') set('security');
        else if (dom === 'sensor') {
          if (/cpu_total_load|cpu_auslastung_gesamt/.test(k)) set('cpu');
          else if (/memory_real_usage|speichernutzung_real/.test(k)) set('ram');
          else if (/memory_total_real|speicher_gesamt_real/.test(k)) set('ramTotal');
          else if (/network_up|upload/.test(k)) set('up');
          else if (/network_down|download/.test(k)) set('down');
          else if (/uptime|betriebszeit/.test(k)) set('uptime');
          else if (/cpu_5min|5_min/.test(k)) set('load5');
          else if (it.st.attributes.device_class === 'temperature') set('temp');
        }
      }
      // Volumes und Laufwerke
      for (const cid of ids.filter((x) => hass.devices[x].via_device_id === id)) {
        const cr = hass.devices[cid];
        const cname = (cr.name_by_user || cr.name || cid).trim();
        const short = cname.startsWith(name) ? cname.slice(name.length).replace(/^[\s(]+|[)\s]+$/g, '') : cname;
        const c = { id: cid, name: short || cname, model: (cr.model || '').trim(), maker: (cr.manufacturer || '').trim(), k: {}, all: [] };
        for (const ent of byDev[cid]) {
          const it = item(ent, cname); if (!it) continue;
          n++; if (it.st.state === 'unavailable') unav++;
          c.all.push(it); d.all.push(it);
          const k = TK(ent); const dom = ent.entity_id.split('.')[0];
          const set = (key) => { c.k[key] ||= it; };
          if (dom === 'binary_sensor') { if (it.st.state === 'on') (c.k.alarms ||= []).push(it); continue; }
          if (/volume_percentage_used|volume_nutzung/.test(k)) set('pct');
          else if (/volume_size_used|belegter/.test(k)) set('used');
          else if (/volume_size_total|gesamtgr/.test(k)) set('total');
          else if (/disk_smart_status|status_smart/.test(k)) set('smart');
          else if (/status/.test(k)) set('status');
          else if (it.st.attributes.device_class === 'temperature' && /temp_avg|durchschnitt|disk_temp|laufwerk_\d+_temp|_temperatur$/.test(k)) set('temp');
        }
        (/volume/i.test(cname) || c.k.pct ? d.vols : d.disks).push(c);
      }
      d.online = n > 0 && unav < n;
      d.wol = this._config.wol?.[name] || this._findWol(reg);
      d.updAvail = d.k.update && d.k.update.st.state === 'on';
      d.unsafe = d.k.security && d.k.security.st.state === 'on';
      d.alarms = [...d.vols, ...d.disks].flatMap((c) => c.k.alarms || []);
      d.vols.sort((a, b) => a.name.localeCompare(b.name, 'de')); d.disks.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      out.push(d);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** Wake-on-LAN-Taste mit derselben MAC wie das NAS (Integration wake_on_lan) */
  _findWol(reg) {
    const hass = this._hass;
    const macs = (reg.connections || []).filter(([t]) => t === 'mac').map(([, m]) => m.toLowerCase().replace(/[^0-9a-f]/g, ''));
    if (!macs.length) return null;
    for (const dv of Object.values(hass.devices)) {
      if (dv.id === reg.id) continue;
      if (!(dv.connections || []).some(([t, m]) => t === 'mac' && macs.includes(m.toLowerCase().replace(/[^0-9a-f]/g, '')))) continue;
      const e = Object.values(hass.entities).find((x) => x.device_id === dv.id && x.platform === 'wake_on_lan' && x.entity_id.startsWith('button.'));
      if (e) return e.entity_id;
    }
    const e = Object.values(hass.entities).find((x) => x.platform === 'wake_on_lan' && macs.some((m) => x.entity_id.replace(/_/g, '').includes(m)));
    return e ? e.entity_id : null;
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

  _lvl(p) { return p == null ? '' : p >= this._config.crit ? 'c' : p >= this._config.warn ? 'w' : ''; }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:nas"></ha-icon>Synology</div>
        <input id="q" type="search" placeholder="Filtern …">
        <div class="stats" id="stats"></div>
      </div>
      <div class="grid" id="grid"></div>`;
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><div id="dlg"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('dlg');
    const root = this.shadowRoot;
    root.getElementById('q').addEventListener('input', (e) => { this._filter = e.target.value.toLowerCase(); this._renderGrid(); });
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
    root.host.style.setProperty('--smc-min', `${this._config.min_width}px`);
    const all = this._devices; const f = this._filter;
    const list = all.filter((d) => !f || `${d.name} ${d.host} ${d.model} ${d.area}`.toLowerCase().includes(f));
    const on = all.filter((d) => d.online).length;
    morph(root.getElementById('stats'), `<span>${all.length} NAS</span><span>${on} online</span>${all.length - on ? `<span>${all.length - on} aus/offline</span>` : ''}
      ${all.some((d) => d.updAvail) ? `<span>${all.filter((d) => d.updAvail).length} mit DSM-Update</span>` : ''}
      ${all.some((d) => d.unsafe || d.alarms.length) ? '<span>Warnungen vorhanden</span>' : ''}`);
    const html = list.length ? list.map((d) => this._tile(d)).join('') : '<div class="empty">Keine Synology-NAS gefunden.</div>';
    if (html !== this._gridHtml) { morph(root.getElementById('grid'), html); this._gridHtml = html; }
  }

  _tile(d) {
    const k = d.k;
    const kpi = (it, label, digits = 0, unit = '') => `<div class="kpi" ${it ? `data-more="${it.id}"` : ''}><b>${this._n(it) != null ? `${nf(this._n(it), digits)}${unit}` : '–'}</b><span>${label}</span></div>`;
    const bar = (label, pct, txt, more) => `<div class="bar" ${more ? `data-more="${more}"` : ''}><div class="l"><span>${label}</span><b>${txt}</b></div>
      <div class="t"><i class="${this._lvl(pct)}" style="width:${pct != null ? Math.min(100, Math.max(0, pct)).toFixed(1) : 0}%"></i></div></div>`;
    const ram = this._n(k.ram); const ramT = this._n(k.ramTotal);
    const vols = d.vols.map((v) => {
      const p = this._n(v.k.pct); const used = v.k.used ? this._val(v.k.used.st) : '';
      const tot = v.k.total ? this._val(v.k.total.st) : '';
      const st = v.k.status && !BAD.includes(v.k.status.st.state) && v.k.status.st.state !== 'normal' ? ` · ${esc(v.k.status.st.state)}` : '';
      return bar(`${esc(v.name)}${st}`, p, `${p != null ? `${nf(p, 1)} %` : '–'}${used ? ` · ${used}${tot ? ` / ${tot}` : ''}` : ''}`, (v.k.pct || v.k.used)?.id);
    }).join('');
    const disks = d.disks.map((c) => {
      const s = c.k.status || c.k.smart; const sv = s && !BAD.includes(s.st.state) ? s.st.state : '';
      const bad = (sv && !/normal|ok|healthy/i.test(sv)) || (c.k.alarms || []).length;
      return `<div class="disk" data-more="${(s || c.k.temp || c.all[0])?.id || ''}"><ha-icon icon="mdi:harddisk"></ha-icon>
        <span class="dn">${esc(c.name)}${c.model ? ` <small style="color:var(--secondary-text-color)">${esc(c.model)}</small>` : ''}</span>
        <span class="ds ${bad ? 'bad' : ''}">${bad ? ((c.k.alarms || []).length ? 'Warnung' : esc(sv)) : sv ? 'ok' : '–'}</span>
        <span class="dt">${this._n(c.k.temp) != null ? `${nf(this._n(c.k.temp))} °C` : ''}</span></div>`;
    }).join('');
    const chips = [];
    if (d.updAvail) chips.push(`<span class="chip warn" data-more="${k.update.id}"><ha-icon icon="mdi:package-up"></ha-icon>DSM ${esc(k.update.st.attributes.latest_version || 'Update')}</span>`);
    else if (k.update && d.online) chips.push('<span class="chip ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon>DSM aktuell</span>');
    if (d.unsafe) chips.push(`<span class="chip err" data-more="${k.security.id}"><ha-icon icon="mdi:shield-alert-outline"></ha-icon>Sicherheitsberater: Warnung</span>`);
    else if (k.security && d.online) chips.push(`<span class="chip ok" data-more="${k.security.id}"><ha-icon icon="mdi:shield-check-outline"></ha-icon>sicher</span>`);
    for (const a of d.alarms) chips.push(`<span class="chip err" data-more="${a.id}"><ha-icon icon="mdi:harddisk-remove"></ha-icon>${esc(a.label)}</span>`);
    if (!d.online) chips.push('<span class="chip err"><ha-icon icon="mdi:power-sleep"></ha-icon>aus oder nicht erreichbar</span>');
    const r = window.__hmcActRaw ? window.__hmcActRaw(this._hass, d.id) : null;
    const cls = `dev${d.online ? '' : ' offline'}${d.unsafe || d.alarms.length ? ' warnst' : ''}${window.__hmcCls ? window.__hmcCls(this._hass, r ? r.a : (d.online ? 'srv' : ''), true) : ''}`;
    const can = (it) => it && !BAD.includes(it.st.state) && d.online;
    return `<div class="${cls}" data-k="${d.id}">
      <div class="head"><div class="ico"><ha-icon icon="mdi:nas"></ha-icon><span class="dot"></span></div>
        <div class="name">${esc(d.name)}<small>${esc([d.model, d.host, d.area].filter(Boolean).join(' · '))}</small></div>
        <button class="iconbtn" data-act="info" data-d="${d.id}" title="Details"><ha-icon icon="mdi:dots-vertical"></ha-icon></button></div>
      ${d.online ? `<div class="kpis">${kpi(k.cpu, 'CPU', 0, ' %')}${kpi(k.ram, 'RAM', 0, ' %')}${kpi(k.temp, 'Temperatur', 0, ' °C')}</div>
      <div class="bars">${bar('Arbeitsspeicher', ram, `${ram != null ? `${nf(ram)} %` : '–'}${ramT ? ` von ${nf(ramT / 1024, 1)} GB` : ''}`, k.ram?.id)}${vols}</div>
      ${disks ? `<div class="sect">Laufwerke</div><div class="disks">${disks}</div>` : ''}
      <div class="meta">${k.up ? `<span class="k">Upload</span><span class="v" data-more="${k.up.id}">${this._val(k.up.st)}</span>` : ''}
        ${k.down ? `<span class="k">Download</span><span class="v" data-more="${k.down.id}">${this._val(k.down.st)}</span>` : ''}
        ${k.load5 ? `<span class="k">Last (5 min)</span><span class="v" data-more="${k.load5.id}">${this._val(k.load5.st)}</span>` : ''}
        ${k.uptime && !BAD.includes(k.uptime.st.state) ? `<span class="k">Läuft seit</span><span class="v" data-more="${k.uptime.id}">${this._val(k.uptime.st)}</span>` : ''}
        ${d.sw ? `<span class="k">Version</span><span class="v">${esc(d.sw)}</span>` : ''}</div>` : '<div class="empty">Das NAS ist ausgeschaltet oder schläft.</div>'}
      <div class="chips" ${chips.length ? '' : 'hidden'}>${chips.join('')}</div>
      <div class="foot">
        <button class="iconbtn" data-act="web" data-v="${esc(d.url)}" title="DSM öffnen" ${d.url ? '' : 'disabled'}><ha-icon icon="mdi:open-in-new"></ha-icon></button>
        <span class="sp"></span>
        ${d.wol ? `<button class="pbtn go" data-act="wake" data-e="${d.wol}" data-n="${esc(d.name)}" ${d.online ? 'disabled title="läuft bereits"' : 'title="per Wake on LAN einschalten"'}><ha-icon icon="mdi:power"></ha-icon>Wecken</button>` : ''}
        ${k.update ? `<button class="pbtn warn" data-act="install" data-e="${k.update.id}" data-n="${esc(d.name)}" ${d.updAvail && can(k.update) && (k.update.st.attributes.supported_features & 1) ? '' : 'hidden'}><ha-icon icon="mdi:package-up"></ha-icon>Update</button>` : ''}
        ${k.reboot ? `<button class="pbtn" data-act="press" data-e="${k.reboot.id}" data-q="${esc(d.name)} neu starten?" ${can(k.reboot) ? '' : 'disabled'}><ha-icon icon="mdi:restart"></ha-icon>Neustart</button>` : ''}
        ${k.shutdown ? `<button class="pbtn err" data-act="press" data-e="${k.shutdown.id}" data-q="${esc(d.name)} herunterfahren?${d.wol ? '' : ' Ohne Wake on LAN lässt es sich nur am Gerät wieder einschalten.'}" ${can(k.shutdown) ? '' : 'disabled'}><ha-icon icon="mdi:power-standby"></ha-icon>Aus</button>` : ''}
      </div></div>`;
  }

  _openInfo(id) { this._infoId = id; if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost); this._renderInfo(); }

  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _renderInfo() {
    const d = this._infoId && (this._devices || []).find((x) => x.id === this._infoId);
    if (!d) { this._dlg.innerHTML = ''; return; }
    const r = d.reg || {};
    const mac = (r.connections || []).filter(([t]) => t === 'mac').map(([, m]) => m).join(', ');
    const info = [['Hersteller', r.manufacturer], ['Modell', r.model], ['Version', r.sw_version], ['Adresse', d.host], ['MAC', mac],
      ['Bereich', d.area], ['Wake on LAN', d.wol || 'nicht eingerichtet'], ['Status', d.online ? 'online' : 'aus oder offline']].filter(([, v]) => v);
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (x) => `<div class="kv e" data-more="${x.id}"><span class="k">${esc(x.label)}</span><span class="v">${this._val(x.st)}</span></div>`;
    const main = d.all.filter((x) => x.ent.device_id === d.id);
    const subs = [...d.vols, ...d.disks].map((c) => `<h4>${esc(c.name)}${c.model ? ` · ${esc(c.model)}` : ''}</h4>${c.all.sort(sortL).map(ent).join('')}`).join('');
    const html = `<div class="dlg-bg"><div class="dlg" role="dialog">
      <div class="dlg-h"><ha-icon icon="mdi:nas"></ha-icon><span class="t">${esc(d.name)}</span>
        <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      ${d.url ? `<a class="dlg-web" href="${esc(d.url)}" target="_blank" rel="noopener"><ha-icon icon="mdi:web"></ha-icon>DSM öffnen</a>` : ''}
      <div class="dlg-b"><h4>Gerät</h4>${info.map(([kk, v]) => `<div class="kv"><span class="k">${kk}</span><span class="v">${esc(v)}</span></div>`).join('')}
        <h4>System</h4>${main.sort(sortL).map(ent).join('')}${subs}</div>
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
    if (more && more.dataset.more) this._fire('hass-more-info', { entityId: more.dataset.more });
  }

  async _action(ds) {
    const hass = this._hass;
    try {
      switch (ds.act) {
        case 'wake':
          await hass.callService('button', 'press', { entity_id: ds.e });
          this._fire('hass-notification', { message: `${ds.n}: Weckpaket gesendet, das Hochfahren dauert etwa 1–2 Minuten` });
          break;
        case 'press':
          if (!window.confirm(ds.q)) break;
          await hass.callService('button', 'press', { entity_id: ds.e });
          break;
        case 'install':
          if (!window.confirm(`DSM-Update auf ${ds.n} installieren? Das NAS startet dabei neu.`)) break;
          await hass.callService('update', 'install', { entity_id: ds.e });
          break;
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

if (!customElements.get('synology-manager-card')) {
  customElements.define('synology-manager-card', SynologyManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'synology-manager-card', name: 'Synology Manager', description: 'Synology-NAS mit Volumes, Laufwerken, Wake on LAN' });
  console.info(`%c SYNOLOGY-MANAGER-CARD %c ${VERSION} `, 'background:#b5b5b6;color:#000', 'background:#eee;color:#333');
}
}
