/*
 * AWTRIX Screen Card – zeigt das aktuelle Bild einer AWTRIX-Uhr als LED-Matrix.
 *
 * Quelle: ein Sensor, dessen Attribute { width, height, pixels:[0xRRGGBB …] } enthalten
 * (z. B. MQTT-Sensor auf <prefix>/state/screen). Solange die Karte sichtbar ist, fordert sie
 * alle `interval` Sekunden per mqtt.publish auf <prefix>/cmd/screen/get ein neues Bild an.
 *
 *   type: custom:awtrix-screen-card
 *   entity: sensor.awtrix_tc001_bildschirm
 *   request_topic: homeassistant/awtrix/88572119014c/cmd/screen/get   # leer = kein Abruf
 *   interval: 2            # Sekunden
 *   name: TC001            # optional
 *   gap: 0.18              # Abstand zwischen den LEDs (Anteil der Pixelgröße)
 *   round: true            # runde LEDs
 *   bare: false            # ohne Kartenrahmen (für die Einbettung)
 *
 * Fehlerfall: Ist MQTT getrennt (Sensor „unavailable“) oder schlägt mqtt.publish fehl, stoppt der Abruf
 * für alle Uhren auf der Seite und die Karte zeigt eine Meldung. Neuer Versuch nach 15 s, 30 s, 60 s …
 * (höchstens 5 min) oder sofort über „Erneut versuchen“. Antwortet die Uhr nicht, wird nur noch alle 30 s abgefragt.
 */
const VERSION = '1.1.0';

// Gemeinsamer Zustand aller AWTRIX-Karten der Seite: ein MQTT-Fehler bremst alle zugleich
const AWX = (window.__hmcAwtrix ||= { downUntil: 0, fails: 0, err: '' });
const STALE_POLL = 30000;

class AwtrixScreenCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entity) throw new Error('entity fehlt');
    this._config = { interval: 2, gap: 0.18, round: true, ...config };
    this._build();
  }

  getCardSize() { return 2; }

  set hass(hass) {
    this._hass = hass;
    const st = hass.states[this._config.entity];
    if (st !== this._st) {
      // Rückkehr nach „unavailable“: MQTT ist wieder verbunden, Sperre aufheben
      if (this._st?.state === 'unavailable' && st && st.state !== 'unavailable') { AWX.downUntil = 0; AWX.fails = 0; AWX.err = ''; }
      this._st = st; this._draw();
    }
    this._status();
  }

  connectedCallback() {
    this._io ||= new IntersectionObserver((e) => { this._visible = e.some((x) => x.isIntersecting); this._schedule(); });
    this._io.observe(this);
    this._onVis ||= () => this._schedule();
    document.addEventListener('visibilitychange', this._onVis);
    this._ro ||= new ResizeObserver(() => this._draw());
    this._ro.observe(this);
  }

  disconnectedCallback() {
    this._io?.disconnect(); this._ro?.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    clearInterval(this._timer); this._timer = null;
  }

  _schedule() {
    const on = this._visible && document.visibilityState === 'visible' && this._config.request_topic;
    if (on && !this._timer) {
      this._first = Date.now(); this._sent = 0;
      this._request();
      this._timer = setInterval(() => this._request(), Math.max(1, Number(this._config.interval) || 2) * 1000);
    } else if (!on && this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** Bild älter als 5 Abrufe (mind. 10 s) trotz erfolgreicher Anfrage: Uhr antwortet nicht */
  _stale() {
    const t = Date.parse(this._st?.last_updated || '');
    const lim = Math.max(10000, 5 * Math.max(1, Number(this._config.interval) || 2) * 1000);
    return !!this._sent && Date.now() - this._sent < 120000 && (!t || Date.now() - t > lim) && Date.now() - this._first > lim;
  }

  _request() {
    if (!this._hass || !this._config.request_topic || this._busy) return;
    if (!this._st || this._st.state === 'unavailable') { this._status(); return; }   // MQTT getrennt: nichts senden
    const now = Date.now();
    if (now < AWX.downUntil) { this._status(); return; }
    if (this._stale() && now - this._sent < STALE_POLL) { this._status(); return; }
    this._busy = true;
    this._hass.callService('mqtt', 'publish', { topic: this._config.request_topic, payload: '' })
      .then(() => { this._sent = Date.now(); AWX.fails = 0; AWX.err = ''; AWX.downUntil = 0; })
      .catch((e) => {
        AWX.fails = Math.min(AWX.fails + 1, 6);
        AWX.downUntil = Date.now() + Math.min(300, 15 * 2 ** (AWX.fails - 1)) * 1000;
        AWX.err = String(e?.message || e?.error?.message || e || 'Fehler');
      })
      .finally(() => { this._busy = false; this._status(); });
  }

  _retry() { AWX.downUntil = 0; AWX.fails = 0; AWX.err = ''; this._sent = 0; this._first = 0; this._status(); this._request(); }

  /** Meldung über dem Bild: MQTT getrennt, Abruf pausiert oder Uhr antwortet nicht */
  _status() {
    const box = this.shadowRoot?.querySelector('.msg');
    if (!box) return;
    let txt = ''; let btn = false;
    if (this._config.request_topic && this._st?.state === 'unavailable') txt = 'MQTT nicht verbunden – Abruf pausiert';
    else if (this._config.request_topic && Date.now() < AWX.downUntil) {
      const s = Math.ceil((AWX.downUntil - Date.now()) / 1000);
      txt = `MQTT-Fehler – Abruf pausiert, neuer Versuch in ${s} s`; btn = true;
    } else if (this._config.request_topic && this._stale()) txt = 'Uhr antwortet nicht – Abfrage nur alle 30 s';
    const key = txt.replace(/\d+ s$/, '') + btn;
    if (txt) box.querySelector('.t').textContent = txt;
    box.title = txt && AWX.err ? AWX.err : '';
    if (key === this._msgKey) return;
    this._msgKey = key;
    box.hidden = !txt;
    box.querySelector('button').hidden = !btn;
    this.shadowRoot.querySelector('.scr').classList.toggle('dim', !!txt);
  }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const bare = this._config.bare;
    this.shadowRoot.innerHTML = `<style>
      :host { display:block; }
      .wrap { ${bare ? '' : 'background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px); border: 1px solid var(--ha-card-border-color, var(--divider-color)); padding: 10px;'} }
      .n { font-size: 12px; color: var(--secondary-text-color); margin: 0 0 6px 2px; display:flex; justify-content:space-between; }
      .scr { background:#050505; border-radius: 8px; padding: 6px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
      canvas { display:block; width:100%; image-rendering: pixelated; }
      .off { font-size:12px; color: var(--secondary-text-color); padding: 10px; text-align:center; }
      .scr { position: relative; }
      .scr.dim canvas { opacity: .35; filter: grayscale(.6); }
      .msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap;
             font-size:12px; color:#fff; text-align:center; padding: 4px 8px; }
      .msg[hidden] { display:none; }
      .msg .t { background: rgba(183,28,28,.85); border-radius: 6px; padding: 3px 8px; }
      .msg button { font: inherit; font-size: 11px; color: #fff; background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.35);
             border-radius: 6px; padding: 2px 8px; cursor: pointer; }
      .msg button[hidden] { display:none; }
    </style>
    <div class="wrap">${this._config.name ? `<div class="n"><span>${this._config.name}</span><span class="age"></span></div>` : ''}
      <div class="scr"><canvas></canvas><div class="off" hidden>kein Bild</div>
        <div class="msg" hidden><span class="t"></span><button type="button">Erneut versuchen</button></div></div></div>`;
    this._cv = this.shadowRoot.querySelector('canvas');
    this.shadowRoot.querySelector('.msg button').addEventListener('click', (e) => { e.stopPropagation(); this._retry(); });
    this._msgKey = null;
    this._draw();
    this._status();
  }

  _draw() {
    const cv = this._cv; const st = this._st;
    if (!cv) return;
    const a = st?.attributes || {};
    const w = Number(a.width); const h = Number(a.height); const px = Array.isArray(a.pixels) ? a.pixels : null;
    const off = this.shadowRoot.querySelector('.off');
    if (!w || !h || !px || px.length < w * h) { cv.hidden = true; off.hidden = false; return; }
    cv.hidden = false; off.hidden = true;
    const cssW = cv.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    const cell = (cssW * dpr) / w;
    cv.width = Math.round(cell * w); cv.height = Math.round(cell * h);
    cv.style.height = `${(cv.height / dpr).toFixed(1)}px`;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, cv.width, cv.height);
    const g = Math.max(0, Math.min(0.45, Number(this._config.gap))) * cell;
    const r = (cell - g) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = Number(px[y * w + x]) || 0;
        // dunkle LEDs leicht andeuten, damit die Matrix erkennbar bleibt
        ctx.fillStyle = c ? `#${c.toString(16).padStart(6, '0')}` : '#141414';
        const cx = x * cell + cell / 2; const cy = y * cell + cell / 2;
        if (this._config.round) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(x * cell + g / 2, y * cell + g / 2, cell - g, cell - g);
      }
    }
  }
}

if (!customElements.get('awtrix-screen-card')) customElements.define('awtrix-screen-card', AwtrixScreenCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'awtrix-screen-card')) {
  window.customCards.push({ type: 'awtrix-screen-card', name: 'AWTRIX Screen', description: 'Aktuelles Bild einer AWTRIX-Uhr als LED-Matrix' });
}
console.info(`%c AWTRIX-SCREEN-CARD %c ${VERSION} `, 'background:#222;color:#fff', 'background:#ff9800;color:#000');
