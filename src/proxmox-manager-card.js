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
