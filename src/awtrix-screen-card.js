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
 */
const VERSION = '1.0.0';

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
    if (st !== this._st) { this._st = st; this._draw(); }
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
      this._request();
      this._timer = setInterval(() => this._request(), Math.max(1, Number(this._config.interval) || 2) * 1000);
    } else if (!on && this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _request() {
    if (!this._hass || !this._config.request_topic) return;
    this._hass.callService('mqtt', 'publish', { topic: this._config.request_topic, payload: '' }).catch(() => { /* ohne Recht oder MQTT: letztes Bild bleibt */ });
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
    </style>
    <div class="wrap">${this._config.name ? `<div class="n"><span>${this._config.name}</span><span class="age"></span></div>` : ''}
      <div class="scr"><canvas></canvas><div class="off" hidden>kein Bild</div></div></div>`;
    this._cv = this.shadowRoot.querySelector('canvas');
    this._draw();
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
