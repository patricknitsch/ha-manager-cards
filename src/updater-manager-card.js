/*
 * Ultimate Updater Card – Update-Übersicht für den Proxmox Ultimate Updater (BassT23, Integration ultimate_updater)
 * im Stil der übrigen Manager Cards. Je Updater-Instanz (Proxmox-Host) ein Kopfbereich mit Zusammenfassung,
 * laufendem Job, Sammel-Update und Aktionen; darunter je System (Host, LXC, VM) eine Kachel mit Sicherheits- und
 * weiteren Updates, Neustartbedarf, letzter Prüfung und den Tasten Prüfen, Aktualisieren und Neustart.
 * Farben wie im Dashboard: rot Sicherheitsupdates, orange weitere Updates, lila Neustart nötig, grün aktuell.
 *
 * Konfiguration (alle optional):
 *   type: custom:updater-manager-card
 *   integration: ultimate_updater
 *   min_width: 300
 *   confirm: true            # Rückfrage vor Aktualisieren und Neustart
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
  :host { --mc-c: #e57000; }
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
const CHECK = { ok: 'aktuell', up_to_date: 'aktuell', updates_available: 'Updates verfügbar', checking: 'wird geprüft', running: 'läuft',
  error: 'Fehler', failed: 'fehlgeschlagen', unreachable: 'nicht erreichbar', none: '–', pending: 'ausstehend', skipped: 'übersprungen', not_checked: 'nicht geprüft' };
const EVT = { completed: 'erfolgreich', completed_with_warnings: 'mit Warnungen', skipped: 'übersprungen', failed: 'fehlgeschlagen', interrupted: 'abgebrochen' };
const JOB = { check: 'Prüfung', update: 'Update', update_all: 'Sammel-Update', security: 'Sicherheitsupdates', reboot: 'Neustart' };
const STATE_TXT = { sec: 'Sicherheitsupdates', upd: 'Updates', reboot: 'Neustart nötig', ok: 'aktuell', off: 'nicht erreichbar' };

function rel(ts) {
  const t = Date.parse(ts); if (!t) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} Tag${Math.round(s / 86400) === 1 ? '' : 'en'}`;
}

const EXTRA = `
  .inst { grid-column: 1 / -1; background: var(--ha-card-background, var(--card-background-color)); border:1px solid var(--divider-color);
    border-radius: var(--ha-card-border-radius, 12px); padding: 12px 14px; display:flex; flex-direction:column; gap:8px; margin-top:4px; }
  .inst .ih { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .inst .ih ha-icon { --mdc-icon-size:26px; color: var(--mc-c); }
  .inst .it { font-size:17px; font-weight:600; flex:1; min-width:160px; }
  .inst .it small { display:block; font-size:12px; font-weight:400; color: var(--secondary-text-color); }
  .inst .run { display:flex; align-items:center; gap:8px; font-size:13px; }
  .inst .run .t { flex:1; height:6px; border-radius:3px; background: var(--divider-color); overflow:hidden; }
  .inst .run .t i { display:block; height:100%; background: var(--primary-color); }
  .inst .run .t i.ind { width:35%; animation: hmcslide 1.4s linear infinite; }
  @keyframes hmcslide { from { margin-left:-35%; } to { margin-left:100%; } }
  .inst .acts { display:flex; flex-wrap:wrap; gap:6px; }
  .inst .last { font-size:12px; color: var(--secondary-text-color); cursor:pointer; }
  .spin { animation: hmcspin 1.2s linear infinite; } @keyframes hmcspin { to { transform: rotate(360deg); } }
  .kpi.sec b { color: var(--error-color, #db4437); } .kpi.upd b { color: var(--warning-color, #ffa600); }
  .chip.lila { background: rgba(156,39,176,.15); color: #ab47bc; }
`;

class UpdaterManagerCard extends HTMLElement {
  setConfig(config) {
    this._config = { integration: 'ultimate_updater', min_width: 300, confirm: true, ...config };
    this._filter = this._filter || '';
    this._view = this._view || 'all';
    if (!this.shadowRoot) { this.attachShadow({ mode: 'open' }); this._buildShell(); }
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 'full' }; }
  static getStubConfig() { return { integration: 'ultimate_updater' }; }

  set hass(hass) {
    this._hass = hass;
    this._data = this._collect();
    this._render();
    if (this._infoId) this._renderInfo();
  }

  connectedCallback() { this._tick ||= setInterval(() => { if (this._hass) { this._gridHtml = ''; this._render(); } }, 60000); }
  disconnectedCallback() { clearInterval(this._tick); this._tick = null; if (this._dlgHost) this._closeInfo(); }

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
    const it = (ent, dn) => { const st = hass.states[ent.entity_id]; if (!st) return null; let l = ent.name || st.attributes.friendly_name || ent.entity_id; if (l.startsWith(dn)) l = l.slice(dn.length).trim(); return { id: ent.entity_id, st, ent, label: l || dn }; };
    const upd = window.__hmcUpd || (() => ({ sys: false }));
    const insts = ids.filter((id) => !upd(hass, id).sys);
    const out = insts.map((iid) => {
      const reg = hass.devices[iid];
      const inst = { id: iid, reg, area: (reg.area_id && hass.areas?.[reg.area_id]?.name) || '', sw: reg.sw_version || '', k: {}, all: [], systems: [] };
      for (const ent of byDev[iid]) {
        const x = it(ent, (reg.name_by_user || reg.name || '').trim()); if (!x) continue;
        inst.all.push(x);
        const k = TK(ent); const dom = ent.entity_id.split('.')[0]; const dc = x.st.attributes.device_class;
        const set = (key) => { inst.k[key] ||= x; };
        if (dom === 'event') set('event');
        else if (dom === 'binary_sensor' && dc === 'update') set('self');
        else if (dom === 'binary_sensor' && /sammel|bulk/.test(k)) set('bulkRun');
        else if (dom === 'binary_sensor') set('jobRun');
        else if (dom === 'button' && /sammel.*stop|bulk.*stop|stop/.test(k)) set('bulkStop');
        else if (dom === 'button' && /abbrech|cancel/.test(k)) set('cancel');
        else if (dom === 'button' && /sicherheit|security/.test(k)) set('updSec');
        else if (dom === 'button' && /alle_vms|update_all|aktualisieren/.test(k)) set('updAll');
        else if (dom === 'button' && /pruf|check/.test(k)) set('checkAll');
        else if (dom === 'sensor' && /zusammenfassung|summary/.test(k)) set('summary');
        else if (dom === 'sensor' && /fortschritt|progress/.test(k)) set('progress');
        else if (dom === 'sensor' && /version/.test(k)) set('version');
        else if (dom === 'sensor' && /erstellt|generated|created/.test(k)) set('created');
      }
      for (const sid of ids.filter((x) => hass.devices[x].via_device_id === iid)) {
        const sr = hass.devices[sid]; const name = (sr.name_by_user || sr.name || sid).trim();
        const u = upd(hass, sid); if (!u.sys) continue;
        const s = { id: sid, reg: sr, name, model: sr.model || '', os: sr.sw_version || '', u, all: [] };
        for (const ent of byDev[sid]) { const x = it(ent, name); if (x) s.all.push(x); }
        inst.systems.push(s);
      }
      // Host zuerst, dann Container/VMs nach Name
      inst.systems.sort((a, b) => (/host/i.test(b.model) - /host/i.test(a.model)) || a.name.localeCompare(b.name, 'de'));
      const host = inst.systems.find((s) => /host/i.test(s.model));
      inst.name = host ? host.name : (reg.name_by_user || reg.name || 'Ultimate Updater');
      return inst;
    });
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  _val(st) {
    if (!st) return '–';
    if (typeof this._hass.formatEntityState === 'function') return esc(this._hass.formatEntityState(st));
    return esc(st.state);
  }

  /* ---------- Rendering ---------- */
  _buildShell() {
    this.shadowRoot.innerHTML = `<style>${STYLE}${EXTRA}</style>
      <div class="toolbar">
        <div class="title"><ha-icon icon="mdi:update"></ha-icon>Ultimate Updater</div>
        <input id="q" type="search" placeholder="Filtern …">
        <select id="view"><option value="all">Alle</option><option value="todo">Mit Updates</option><option value="sec">Sicherheitsupdates</option>
          <option value="reboot">Neustart nötig</option><option value="off">Nicht erreichbar</option><option value="ok">Aktuell</option></select>
        <div class="stats" id="stats"></div>
      </div>
      <div class="grid" id="grid"></div>`;
    this._dlgHost = document.createElement('div');
    this._dlgHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}${EXTRA}</style><div id="dlg"></div>`;
    this._dlg = this._dlgHost.shadowRoot.getElementById('dlg');
    const root = this.shadowRoot;
    root.getElementById('q').addEventListener('input', (e) => { this._filter = e.target.value.toLowerCase(); this._render(); });
    root.getElementById('view').addEventListener('change', (e) => { this._view = e.target.value; this._render(); });
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

  _match(s) {
    const st = s.u.s;
    switch (this._view) {
      case 'todo': return st === 'sec' || st === 'upd';
      case 'sec': return st === 'sec';
      case 'reboot': return s.u.reboot;
      case 'off': return st === 'off';
      case 'ok': return st === 'ok';
      default: return true;
    }
  }

  _render() {
    const root = this.shadowRoot;
    if (!root || !this._data) return;
    root.host.style.setProperty('--smc-min', `${this._config.min_width}px`);
    const sys = this._data.flatMap((i) => i.systems);
    const c = (f) => sys.filter(f).length;
    const sec = sys.reduce((a, s) => a + s.u.sec, 0); const oth = sys.reduce((a, s) => a + s.u.other, 0);
    morph(root.getElementById('stats'), `<span>${this._data.length} Host${this._data.length === 1 ? '' : 's'} · ${sys.length} Systeme</span>
      ${c((s) => s.u.s === 'sec' || s.u.s === 'upd') ? `<span>${c((s) => s.u.s === 'sec' || s.u.s === 'upd')} mit Updates (${sec} Sicherheit, ${oth} weitere)</span>` : '<span>alle aktuell</span>'}
      ${c((s) => s.u.reboot) ? `<span>${c((s) => s.u.reboot)} Neustart nötig</span>` : ''}
      ${c((s) => s.u.s === 'off') ? `<span>${c((s) => s.u.s === 'off')} nicht erreichbar</span>` : ''}`);
    const f = this._filter;
    const html = this._data.map((inst) => {
      const list = inst.systems.filter((s) => this._match(s) && (!f || `${s.name} ${s.model} ${s.os} ${inst.name}`.toLowerCase().includes(f)));
      return this._inst(inst) + (list.length ? list.map((s) => this._tile(s)).join('') : `<div class="empty" data-k="e${inst.id}" style="grid-column:1/-1">Keine Systeme in dieser Ansicht.</div>`);
    }).join('') || '<div class="empty">Kein Ultimate Updater gefunden.</div>';
    if (html !== this._gridHtml) { morph(root.getElementById('grid'), html); this._gridHtml = html; }
  }

  _inst(i) {
    const k = i.k; const on = (x) => x && x.st.state === 'on'; const av = (x) => x && !BAD.includes(x.st.state);
    const run = on(k.jobRun); const bulk = on(k.bulkRun);
    const prog = k.progress && !BAD.includes(k.progress.st.state) ? parseFloat(k.progress.st.state) : null;
    const ev = k.event && !BAD.includes(k.event.st.state) ? k.event.st : null;
    const evTxt = ev ? `Letzter Job: ${esc(JOB[ev.attributes.job_type] || ev.attributes.job_type || 'Job')}${ev.attributes.target_name ? ` ${esc(ev.attributes.target_name)}` : ''} ${esc(EVT[ev.attributes.event_type] || ev.attributes.event_type || '')}, ${rel(ev.state)}` : '';
    const btn = (x, act, icon, label, cls = '', show = true) => (x && show ? `<button class="pbtn ${cls}" data-act="${act}" data-e="${x.id}" data-n="${esc(label)}" ${av(x) ? '' : 'disabled'}><ha-icon icon="${icon}"></ha-icon>${label}</button>` : '');
    const sub = [i.area, k.version ? `Updater ${this._val(k.version.st)}` : '', k.created && !BAD.includes(k.created.st.state) ? `Stand ${rel(k.created.st.state)}` : ''].filter(Boolean).join(' · ');
    return `<div class="inst" data-k="i${i.id}">
      <div class="ih"><ha-icon icon="mdi:server"></ha-icon><div class="it">${esc(i.name)}<small>${sub}</small></div>
        ${on(k.self) ? `<span class="chip warn" data-more="${k.self.id}"><ha-icon icon="mdi:package-up"></ha-icon>Updater-Update verfügbar</span>` : ''}
        ${k.summary ? `<span class="chip" data-more="${k.summary.id}"><ha-icon icon="mdi:text-box-outline"></ha-icon>Bericht</span>` : ''}
        <button class="iconbtn" data-act="info" data-d="${i.id}" title="Details"><ha-icon icon="mdi:dots-vertical"></ha-icon></button></div>
      ${run || bulk ? `<div class="run"><ha-icon class="spin" icon="mdi:sync"></ha-icon><span>${bulk ? 'Sammel-Update läuft' : 'Job läuft'}${prog != null ? ` · ${Math.round(prog)} %` : ''}</span>
        <div class="t"><i class="${prog != null ? '' : 'ind'}" style="${prog != null ? `width:${Math.min(100, Math.max(0, prog))}%` : ''}"></i></div></div>` : ''}
      <div class="acts">${btn(k.checkAll, 'press', 'mdi:magnify', 'Alle prüfen')}
        ${btn(k.updSec, 'pressc', 'mdi:shield-sync-outline', 'Sicherheitsupdates installieren', 'err')}
        ${btn(k.updAll, 'pressc', 'mdi:update', 'Alle aktualisieren', 'warn')}
        ${btn(k.cancel, 'pressc', 'mdi:stop-circle-outline', 'Job abbrechen', '', run)}
        ${btn(k.bulkStop, 'pressc', 'mdi:stop', 'Sammel-Update stoppen', '', bulk)}</div>
      ${evTxt ? `<div class="last" data-more="${k.event.id}">${evTxt}</div>` : ''}</div>`;
  }

  _tile(s) {
    const u = s.u; const hass = this._hass;
    const icon = /host/i.test(s.model) ? 'mdi:server' : /virtual|vm/i.test(s.model) ? (/home assistant/i.test(s.os) ? 'mdi:home-assistant' : 'mdi:monitor') : 'mdi:package-variant-closed';
    const st = (id) => (id ? hass.states[id] : null);
    const chk = st(u.e.check); const last = st(u.e.last); const job = st(u.e.job); const upd = st(u.e.update);
    const chkTxt = chk && !BAD.includes(chk.state) ? (CHECK[chk.state] || chk.state.replace(/_/g, ' ')) : '–';
    const chips = [];
    if (u.s === 'off') chips.push(`<span class="chip err" data-more="${u.e.reach || ''}"><ha-icon icon="mdi:lan-disconnect"></ha-icon>nicht erreichbar</span>`);
    if (u.reboot) chips.push(`<span class="chip lila" data-more="${u.e.reboot}"><ha-icon icon="mdi:restart-alert"></ha-icon>Neustart erforderlich</span>`);
    if (u.s === 'ok') chips.push('<span class="chip ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon>aktuell</span>');
    if (chk && /error|fail/i.test(chk.state)) chips.push(`<span class="chip err" data-more="${u.e.check}"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>Prüfung fehlgeschlagen</span>`);
    const r = window.__hmcActRaw ? window.__hmcActRaw(hass, s.id) : null;
    const cls = `dev${u.s === 'off' ? ' offline' : ''}${window.__hmcCls ? window.__hmcCls(hass, r ? r.a : '', true) : ''}`;
    const canInstall = upd && upd.state === 'on' && (upd.attributes.supported_features & 1) && !upd.attributes.in_progress;
    const busy = upd && upd.attributes.in_progress;
    const avail = (id) => id && st(id) && !BAD.includes(st(id).state);
    return `<div class="${cls}" data-k="${s.id}">
      <div class="head"><div class="ico"><ha-icon icon="${icon}"></ha-icon><span class="dot"></span></div>
        <div class="name">${esc(s.name)}<small>${esc([s.model.replace('LXC container', 'LXC').replace('Virtual machine', 'VM').replace('Proxmox host', 'Host'), s.os].filter(Boolean).join(' · '))}</small></div>
        <button class="iconbtn" data-act="info" data-d="${s.id}" title="Details"><ha-icon icon="mdi:dots-vertical"></ha-icon></button></div>
      <div class="kpis"><div class="kpi ${u.sec ? 'sec' : ''}" data-more="${u.e.sec || ''}"><b>${u.sec}</b><span>Sicherheit</span></div>
        <div class="kpi ${u.other ? 'upd' : ''}" data-more="${u.e.other || ''}"><b>${u.other}</b><span>Weitere</span></div>
        <div class="kpi" data-more="${u.e.check || ''}"><b style="font-size:14px;line-height:22px">${esc(STATE_TXT[u.s] || chkTxt)}</b><span>Status</span></div></div>
      <div class="meta"><span class="k">Letzte Prüfung</span><span class="v" data-more="${u.e.last || ''}">${last && !BAD.includes(last.state) ? rel(last.state) : '–'}</span>
        <span class="k">Prüfstatus</span><span class="v" data-more="${u.e.check || ''}">${esc(chkTxt)}</span>
        ${job && !BAD.includes(job.state) && job.state !== 'none' ? `<span class="k">Letzter Job</span><span class="v" data-more="${u.e.job}">${esc(JOB[job.state] || job.state)}</span>` : ''}
        ${busy ? `<span class="k">Update</span><span class="v">läuft${upd.attributes.update_percentage != null ? ` · ${upd.attributes.update_percentage} %` : ''}</span>` : ''}</div>
      <div class="chips" ${chips.length ? '' : 'hidden'}>${chips.join('')}</div>
      <div class="foot">
        ${u.e.check_btn ? `<button class="pbtn" data-act="press" data-e="${u.e.check_btn}" data-n="${esc(s.name)}" ${avail(u.e.check_btn) ? '' : 'disabled'} title="Auf Updates prüfen"><ha-icon icon="mdi:magnify"></ha-icon>Prüfen</button>` : ''}
        <span class="sp"></span>
        ${upd ? `<button class="pbtn ${u.sec ? 'err' : 'warn'}" data-act="install" data-e="${u.e.update}" data-n="${esc(s.name)}" ${canInstall ? '' : 'hidden'}><ha-icon icon="mdi:package-up"></ha-icon>Aktualisieren</button>` : ''}
        ${u.e.reboot_btn ? `<button class="pbtn ${u.reboot ? 'warn' : ''}" data-act="reboot" data-e="${u.e.reboot_btn}" data-n="${esc(s.name)}" ${avail(u.e.reboot_btn) ? '' : 'disabled'}><ha-icon icon="mdi:restart"></ha-icon>Neustart</button>` : ''}
      </div></div>`;
  }

  _openInfo(id) { this._infoId = id; if (!this._dlgHost.isConnected) document.body.appendChild(this._dlgHost); this._renderInfo(); }
  _closeInfo() { this._infoId = null; this._infoHtml = ''; this._dlg.innerHTML = ''; this._dlgHost.remove(); }

  _renderInfo() {
    const id = this._infoId; if (!id) return;
    const inst = (this._data || []).find((i) => i.id === id);
    const sys = inst ? null : (this._data || []).flatMap((i) => i.systems).find((s) => s.id === id);
    const x = inst || sys;
    if (!x) { this._dlg.innerHTML = ''; return; }
    const r = x.reg || {};
    const info = [['Modell', r.model], ['Version', r.sw_version], ['Bereich', r.area_id && this._hass.areas?.[r.area_id]?.name]].filter(([, v]) => v);
    const sortL = (a, b) => a.label.localeCompare(b.label, 'de');
    const ent = (e) => `<div class="kv e" data-more="${e.id}"><span class="k">${esc(e.label)}</span><span class="v">${this._val(e.st)}</span></div>`;
    const rep = inst && inst.k.summary ? inst.k.summary.st.attributes.report : '';
    const html = `<div class="dlg-bg"><div class="dlg" role="dialog">
      <div class="dlg-h"><ha-icon icon="${inst ? 'mdi:update' : 'mdi:package-variant-closed'}"></ha-icon><span class="t">${esc(inst ? `Ultimate Updater ${x.name}` : x.name)}</span>
        <button class="iconbtn" data-act="close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>
      <div class="dlg-b"><h4>Gerät</h4>${info.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}
        ${rep ? `<h4>Bericht</h4><pre style="white-space:pre-wrap;font-size:12px;margin:0">${esc(rep)}</pre>` : ''}
        <h4>Entitäten</h4>${x.all.sort(sortL).map(ent).join('')}</div>
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
    const hass = this._hass; const c = this._config.confirm;
    try {
      switch (ds.act) {
        case 'press': await hass.callService('button', 'press', { entity_id: ds.e }); break;
        case 'pressc':
          if (c && !window.confirm(`${ds.n}?`)) break;
          await hass.callService('button', 'press', { entity_id: ds.e }); break;
        case 'install':
          if (c && !window.confirm(`Updates auf ${ds.n} installieren?`)) break;
          await hass.callService('update', 'install', { entity_id: ds.e }); break;
        case 'reboot':
          if (c && !window.confirm(`${ds.n} neu starten?`)) break;
          await hass.callService('button', 'press', { entity_id: ds.e }); break;
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

if (!customElements.get('updater-manager-card')) {
  customElements.define('updater-manager-card', UpdaterManagerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'updater-manager-card', name: 'Ultimate Updater', description: 'Update-Übersicht des Proxmox Ultimate Updaters' });
  console.info(`%c UPDATER-MANAGER-CARD %c ${VERSION} `, 'background:#e57000;color:#fff', 'background:#eee;color:#333');
}
}
