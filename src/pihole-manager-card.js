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
  .dev.offline { opacity:.55; }
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
    const cls = `dev${d.online ? '' : ' offline'}${d.enabled === false ? ' paused' : ''}`;
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
