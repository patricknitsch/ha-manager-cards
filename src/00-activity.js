/* Gemeinsame Aktivitätserkennung und Farben für alle Karten. Wird im Bundle zuerst geladen,
 * damit Karten, die ihre Stile beim Laden zusammensetzen (z. B. Pi-hole), die Farbregeln schon vorfinden. */
/* Aktivität eines Geräts für die Hervorhebung der Gerätekacheln (gemeinsam für alle Karten).
 * Farbig (Standard): act-pw = verbraucht Strom/heizt/läuft (rot), act-li = Licht an (gelb), act-sw = nur geschaltet (grün),
 * act-wa = Wassergerät aktiv (blau), act-srv = Server aktiv (lila), act-ph = Pi-hole aktiv und act-xs = X-Sense online (orange).
 * Farbstärke über die CSS-Variablen --hmc-a (Fläche) und --hmc-b (Rahmen), gesetzt von der Startkarte (color_strength). Mit input_boolean.dashboard_farben = aus: aktive Geräte hell, inaktive gedimmt (act-off). */
{
  const PSW = /power.?switch/i; // Ein/Aus eines Thermostats ist eine Einstellung, bei Schaltdosen der Ausgang
  const SETTING = /lock|sperre|kindersicherung|led|anzeige|display|detect|motion|record|snapshot|modus|mode|sprinkler|zugriff|access|privacy|eco|auto|alarm|notification|benachricht/i;
  const U = { W: 1, kW: 1000, MW: 1e6 };
  const SRV = ['proxmoxve', 'pi_hole', 'synology_dsm'];
  const META = ['ultimate_updater'];   // Verwaltungsgeräte ohne eigene Aktivität (Update-Status), zählen nicht als Server
  const WATER = /pumpe|pump|bewässer|bewaesser|sprinkler|zisterne|ventil|valve|wasser(?!.*speicher)/i;
  let idxFor = null; let idx = {}; let resFor = null; let res = {};
  window.__hmcColorEntity = window.__hmcColorEntity || 'input_boolean.dashboard_farben';
  const ensureIdx = (hass) => {
    if (idxFor === hass.entities) return;
    idxFor = hass.entities; idx = {};
    for (const e of Object.values(hass.entities)) if (e.device_id && !e.hidden && !e.disabled_by) (idx[e.device_id] ||= []).push(e);
  };
  const UPD_ACT = { sec: 'pw', upd: 'ph', reboot: 'srv', ok: 'sw' };
  const num = (st) => { const v = parseFloat(st?.state); return Number.isNaN(v) ? 0 : v; };
  /** Update-Status eines vom Ultimate Updater verwalteten Systems:
   * { sys: System (kein Updater-Gerät), s: 'sec'|'upd'|'reboot'|'ok'|'off', sec, other, reboot, reach, ents } */
  window.__hmcUpd = (hass, devId) => {
    ensureIdx(hass);
    const r = { sys: false, s: '', sec: 0, other: 0, reboot: false, reach: null, e: {} };
    for (const e of idx[devId] || []) {
      const st = hass.states[e.entity_id]; if (!st) continue;
      const k = `${e.translation_key || ''}|${e.entity_id}`.toLowerCase(); const dom = e.entity_id.split('.')[0];
      if (dom === 'update') { r.sys = true; r.e.update = e.entity_id; }
      else if (dom === 'binary_sensor' && st.attributes.device_class === 'connectivity') { r.reach = st.state === 'on'; r.e.reach = e.entity_id; }
      else if (dom === 'binary_sensor' && /reboot|neustart/.test(k)) { r.reboot = st.state === 'on'; r.e.reboot = e.entity_id; }
      else if (dom === 'sensor' && /security|sicherheit/.test(k)) { r.sec = num(st); r.e.sec = e.entity_id; }
      else if (dom === 'sensor' && /other|weitere|normal/.test(k)) { r.other = num(st); r.e.other = e.entity_id; }
      else if (dom === 'sensor' && /check_status|prufstatus|pruefstatus/.test(k)) r.e.check = e.entity_id;
      else if (dom === 'sensor' && /last_check|letzte_pruf/.test(k)) r.e.last = e.entity_id;
      else if (dom === 'sensor' && /last_job|letzter_job/.test(k)) r.e.job = e.entity_id;
      else if (dom === 'button' && /check|prufen/.test(k)) r.e.check_btn = e.entity_id;
      else if (dom === 'button' && /reboot|restart|neustart/.test(k)) r.e.reboot_btn = e.entity_id;
    }
    r.s = !r.sys ? '' : r.reach === false ? 'off' : r.sec > 0 ? 'sec' : r.other > 0 ? 'upd' : r.reboot ? 'reboot' : 'ok';
    return r;
  };
  /** { a: 'pw'|'li'|'sw'|'srv'|'', cap: Gerät kann aktiv sein, on: eingeschaltet bzw. betriebsbereit } */
  window.__hmcActRaw = (hass, devId) => {
    if (!hass || !devId || !hass.entities) return { a: '', cap: false, on: false };
    ensureIdx(hass);
    if (resFor !== hass.states) { resFor = hass.states; res = {}; }
    if (res[devId]) return res[devId];
    const dv = hass.devices?.[devId]; const names = `${dv?.name_by_user || ''} ${dv?.name || ''}`;
    const ents = idx[devId] || [];
    if (ents.length && ents.every((e) => META.includes(e.platform))) {
      // Ultimate Updater: Farbe nach Update-Status (rot Sicherheitsupdates, orange Updates, lila Neustart nötig, grün aktuell)
      const u = window.__hmcUpd(hass, devId);
      return (res[devId] = { a: UPD_ACT[u.s] || '', cap: u.sys, on: u.sys && u.s !== 'off', p: ents[0].platform, meta: true, u });
    }
    let watt = 0; let run = false; let light = false; let sw = false; let cap = false; let srv = null; let online = false; let on2 = false; let water = false; let clim = false; let psw = false; let xs = false; let pwr = null; let plat = null;
    for (const e of idx[devId] || []) {
      const st = hass.states[e.entity_id];
      if (!st) continue;
      const dom = e.entity_id.split('.')[0]; const a = st.attributes; const on = st.state === 'on';
      if (st.state !== 'unavailable') online = true;
      if (e.platform === 'xsense') xs = true;
      if (SRV.includes(e.platform)) {
        srv ||= e.platform; if (e.platform !== 'pi_hole' || !plat) plat = e.platform;
        if (e.platform === 'pi_hole' && dom === 'switch' && !e.entity_category) srv = on ? 'on' : srv === 'on' ? 'on' : 'pi_hole';
        if (e.platform === 'proxmoxve' && dom === 'binary_sensor' && ['running', 'connectivity', 'power'].includes(a.device_class)) srv = on ? 'on' : srv === 'on' ? 'on' : 'proxmoxve';
        continue;
      }
      if (dom === 'sensor' && a.device_class === 'power' && U[a.unit_of_measurement]) { cap = true; const v = parseFloat(st.state); if (v > 0) watt = Math.max(watt, v * U[a.unit_of_measurement]); continue; }
      // Wassergeräte: Ventil offen, Durchfluss, Pumpe/Bewässerung läuft
      if (dom === 'valve' || (dom === 'sensor' && a.device_class === 'volume_flow_rate')) { cap = true; if (st.state === 'open' || st.state === 'opening' || parseFloat(st.state) > 0) water = true; if (st.state !== 'unavailable') on2 = true; continue; }
      if (dom === 'binary_sensor' && a.device_class === 'smoke') { cap = true; if (on) run = true; if (st.state !== 'unavailable') on2 = true; continue; }
      // eigene Ein/Aus-Anzeige des Geräts (Samsung „Betrieb“, Miele-Schalter „Ein/Aus“) hat Vorrang vor Statuswerten
      if (dom === 'binary_sensor' && a.device_class === 'power') { cap = true; if (st.state !== 'unavailable') pwr = (pwr || false) || on; continue; }
      if (dom === 'switch' && /ein.?aus|on.?off/i.test(`${a.friendly_name || ''} ${e.entity_id}`)) { cap = true; if (st.state !== 'unavailable') pwr = (pwr || false) || on; }
      if (e.entity_category) continue;
      if (dom === 'sensor' && a.device_class === 'enum' && /status|zustand|state|phase/i.test(e.entity_id) && !/standby|push|fernsteuer|remote|diagnose/i.test(e.entity_id)
        && !/^(off|aus|unknown|unavailable|not_connected|disconnected|none|stop|standby|-)$/i.test(st.state)) on2 = true;
      if (dom === 'climate') { clim = true; cap = true; if (st.state !== 'off' && st.state !== 'unavailable') on2 = true; if (['heating', 'preheating'].includes(a.hvac_action)) run = true; } else if (dom === 'light') { cap = true; if (on) light = true; } else if (['switch', 'fan'].includes(dom) && !SETTING.test(`${a.friendly_name || ''} ${e.entity_id}`)) { cap = true; if (PSW.test(`${a.friendly_name || ''} ${e.entity_id}`)) { if (on) psw = true; } else if (on) sw = true; } else if (dom === 'binary_sensor' && a.device_class === 'running') { cap = true; if (on) run = true; } else if (dom === 'sensor' && a.device_class === 'enum' && /^(running|in_use|programmed|active|main_wash|drying|rinse|spin)$/i.test(st.state)) { cap = true; run = true; }
    }
    // Server/Pi-hole: aktiv = läuft (Proxmox) bzw. Blockieren an (Pi-hole); ohne Status-Entität reicht „erreichbar“
    // Synology: läuft = erreichbar; Volumes und Laufwerke (via_device) sind Teile des NAS, kein eigener Server
    if (srv) {
      const up = srv === 'on' || (srv === 'proxmoxve' && online && !(idx[devId] || []).some((e) => e.entity_id.startsWith('binary_sensor.'))) || (srv === 'synology_dsm' && online);
      return (res[devId] = { a: up ? (plat === 'pi_hole' ? 'ph' : 'srv') : '', cap: true, on: up, p: plat, sub: plat === 'synology_dsm' && !!dv?.via_device_id });
    }
    if (psw && !clim) sw = true; // „Power Switch“ ohne Thermostat = Ausgang einer Schaltdose
    const act = run || watt >= 10 ? 'pw' : xs && online ? 'xs' : water ? 'wa' : light ? 'li' : sw ? (WATER.test(names) ? 'wa' : 'sw') : '';
    return (res[devId] = { a: act, cap, on: !!act || (pwr !== null ? pwr : on2 || watt >= 1) });
  };
  /** Farbe je Aktivität – dieselben Werte für Kacheln und Raumsymbole */
  window.__hmcColors = { pw: '#f44336', wa: '#2196f3', li: '#ffc107', sw: '#4caf50', srv: '#9c27b0', ph: '#ff9800', xs: '#ff9800' };
  /** Rangfolge, wenn mehrere Geräte einer Gruppe unterschiedlich aktiv sind */
  window.__hmcRank = ['pw', 'wa', 'srv', 'ph', 'xs', 'li', 'sw'];
  /** Klassen je nach Modus: farbig oder hell/dunkel */
  window.__hmcCls = (hass, a, cap) => {
    const color = hass?.states?.[window.__hmcColorEntity]?.state !== 'off';
    if (color) return a ? ` act-${a}` : '';
    return !a && cap ? ' act-off' : '';
  };
  window.__hmcAct = (hass, devId) => { const r = window.__hmcActRaw(hass, devId); return window.__hmcCls(hass, r.a, r.cap); };
  const T = (c) => `background: color-mix(in srgb, ${c} var(--hmc-a, 24%), var(--ha-card-background, var(--card-background-color))); border-color: color-mix(in srgb, ${c} var(--hmc-b, 70%), transparent);`;
  window.__hmcActCss = `
    .dev.act-pw { ${T(window.__hmcColors.pw)} }
    .dev.act-li { ${T(window.__hmcColors.li)} }
    .dev.act-sw { ${T(window.__hmcColors.sw)} }
    .dev.act-wa { ${T(window.__hmcColors.wa)} }
    .dev.act-srv { ${T(window.__hmcColors.srv)} }
    .dev.act-ph, .dev.act-xs { ${T(window.__hmcColors.ph)} }
    .dev.act-off { opacity:.55; filter: saturate(.6); }`;
}
