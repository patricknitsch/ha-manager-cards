# HA Manager Cards

Geräteseiten für Home Assistant im Stil des ioBroker Device Managers – je Gerätefamilie eine Karte – plus eine Startseite im Stil von Dwains Dashboard, die die Geräteseiten und Räume als Popup öffnet.

Alle Karten stecken in **einer** Datei (`dist/ha-manager-cards.js`). In Home Assistant gibt es dadurch nur eine Ressource.

## Karten

| Karte | Typ | Integration |
|---|---|---|
| Home Dashboard | `custom:home-dashboard-card` | – (Startseite) |
| Bereichsübersicht | `custom:area-overview-card` | – (Raum-Popups, nutzt die Manager Cards) |
| Shelly Manager | `custom:shelly-manager-card` | `shelly` |
| Tasmota Manager | `custom:tasmota-manager-card` | `tasmota` |
| ESPHome Manager | `custom:esphome-manager-card` | `esphome` |
| X-Sense Manager | `custom:xsense-manager-card` | `xsense` |
| Proxmox Manager | `custom:proxmox-manager-card` | `proxmoxve` |
| Miele Manager | `custom:miele-manager-card` | `miele_lan` |
| Grohe Manager | `custom:grohe-manager-card` | `grohe_smarthome` |
| Schlüter Manager | `custom:schlueter-manager-card` | `ojmicroline_thermostat` |
| Pi-hole Manager | `custom:pihole-manager-card` | `pi_hole` |
| LocalThings Manager | `custom:localthings-manager-card` | `localthings` |
| Synology Manager | `custom:synology-manager-card` | `synology_dsm` (+ `wake_on_lan`) |
| Ultimate Updater | `custom:updater-manager-card` | `ultimate_updater` ([Proxmox Ultimate Updater](https://github.com/BassT23/Proxmox)) |
| SENEC Manager | `custom:senec-manager-card` | `senec` ([ha-senec-v3](https://github.com/marq24/ha-senec-v3)) |
| AWTRIX Screen | `custom:awtrix-screen-card` | – (MQTT-Sensor) |

Alle Konfigurationsoptionen stehen im Kopfkommentar der jeweiligen Datei in `src/`.

## Installation über den Marketplace

1. **Einstellungen → Marketplace → Aus Link hinzufügen**, Repository-URL eintragen, Kategorie *Dashboard*.
2. „HA Manager Cards“ installieren. Die Ressource wird automatisch eingetragen (`/local/community/ha-manager-cards/ha-manager-cards.js?v=…`).
3. Alte einzelne Inline-Ressourcen der Karten unter **Einstellungen → Dashboards → Ressourcen** entfernen, sonst sind die Karten doppelt registriert (die zuerst geladene gewinnt).

Updates kommen über den Marketplace, sobald ein neues Release angelegt ist.

## Manuelle Installation

`dist/ha-manager-cards.js` nach `/config/www/ha-manager-cards/` kopieren und als Ressource (Typ *JavaScript-Modul*) eintragen:

```
/local/ha-manager-cards/ha-manager-cards.js?v=1.14.1
```

Bei jedem Update die Versionsnummer in der URL erhöhen, sonst lädt der Browser die alte Datei aus dem Cache.

---

## Startseite (Home Dashboard)

Uhr mit Datum und Kalenderwoche, Begrüßung des angemeldeten Benutzers, Wetter mit DWD-/NINA-Warnungen, heutige Termine,
Statusleiste (Licht, Heizung, Fenster, Rollos, Schalter, Ventil, Wartung, Batterien, offline), Haus mit Leistungsgraph,
Links zu den Geräteseiten und Raumkacheln, die die Bereichsübersicht als Popup öffnen.

```yaml
type: custom:home-dashboard-card
person: person.x
weather: weather.x
warnings: [sensor.wetter_warnungen]          # DWD- oder NINA-Warnungen
valve: valve.x                             # Hauptventil in der Statusleiste
power: { house: sensor.x, pv: sensor.x, grid: sensor.x, battery: sensor.x, battery_soc: sensor.x }
solar_forecast: true                          # PV-Prognose aus den Energie-Einstellungen
layout: sidebar_links                         # sidebar (Standard) | sidebar_links | stacked
calendars: [calendar.familywall]              # Standard: alle Kalender
color_strength: 24
popup_opacity: 50
popup_blur: 10
popup_dim: 20
admin_only: [pi_hole, proxmoxve, xsense]
awtrix:
  - { entity: sensor.awtrix_tc001_bildschirm, request_topic: homeassistant/awtrix/88572119014c/cmd/screen/get, interval: 2 }
links:
  - { name: Shelly, icon: mdi:alpha-s-box, path: /dashboard-geraete/shelly, integration: shelly }
  - { name: HA-Log, icon: mdi:math-log, color: "#03a9f4", popup: log }
  - { name: Integrationen, icon: mdi:puzzle-check-outline, color: "#7e57c2", popup: integrations }
makers:
  - { type: custom:shelly-manager-card }      # Manager Cards für die Raum-Popups
```

Weitere Optionen: `area_power`, `cameras` / `camera_background`, `exclude_areas`, `hide_label`, `monitor_entity`,
`switches`, `scroll_sections`, `section_height`, `calendar_max`, `color_entity` – siehe Kopfkommentar von `src/home-dashboard-card.js`.

### Layout

- **`sidebar`** (Standard): Ab 1100 px Breite stehen Uhr, Datum mit Kalenderwoche, Begrüßung, Wetter, Termine, Status und
  AWTRIX-Uhren links in einer festen Spalte, rechts Haus, Seiten und Räume.
- **`sidebar_links`:** Links Kopf, Termine, Uhren und die Seiten-Links; rechts die Status-Symbole als Kopfzeile, darunter Haus
  und die Räume allein (mehrspaltig, scrollbar).
- **`stacked`:** Die alte Anordnung untereinander (unter 1100 px gilt sie immer).

Seitenleiste und Statuszeile sind leicht getönt und gerahmt (CSS-Variable `--panel-tint`, Standard 7 %; Breite `--side-w`, Höhe `--hmc-vh`).
Seiten und Räume scrollen getrennt in Bildschirmhöhe (`section_height`, Standard `calc(100vh - 150px)`); `scroll_sections: false` schaltet das ab.

### Termine und Haus-Graph

- **Termine:** heutige Termine aus den Kalendern, ganztägige zuerst, vergangene blass. `calendars` wählt Kalender aus, `calendar_max: 6` begrenzt die Anzahl.
- **Netz:** Der Haus-Graph zeigt `power.grid` mit Vorzeichen als lila Fläche: Bezug oberhalb, Einspeisung unterhalb der Nulllinie.

### Links und Badges

Links zu Integrationen tragen am Icon die Anzahl der farbig hervorgehobenen (aktiven) Geräte; der Frigate-Link zeigt die Anzahl der Kameras.
Links zu ESPHome, Grohe, LocalThings, Miele, Schlüter, Shelly, Tasmota, X-Sense, Pi-hole, Proxmox und Synology übernehmen die Farbe ihrer
aktiven Geräte: die häufigste Farbe gewinnt, bei Gleichstand die stärkere (rot vor blau, lila, orange, gelb, grün).
Ist kein Gerät aktiv (alles aus oder deaktiviert), wird der Link grau.
Der Link zum Ultimate Updater zählt die Systeme mit Updates oder Neustartbedarf und nimmt die Farbe des dringendsten Zustands an
(rot Sicherheitsupdates, orange Updates, lila Neustart, grün alles aktuell). `auto_color: false` am Link schaltet das ab,
`auto_color: true` schaltet es für weitere Integrationen ein.
`unit: Panel` ersetzt „Gerät“ in der Beschreibung, `badge: count` zeigt im Badge die Anzahl der Geräte statt der aktiven.
Der AWTRIX-Studio-Link (`integration: awtrix_studio`, `path: /awtrix-studio`) zeigt zusätzlich, wie viele Apps eingeschaltet sind.

### Umschalter Geräte/Links

Sobald es Links beider Gruppen gibt, schaltet ein Umschalter neben „Seiten“ zwischen **Geräte** und **Links** um; die Auswahl
merkt sich der Browser. Zu den Geräten gehören Links zu ESPHome, Grohe, LocalThings, Miele, Schlüter, Shelly, Tasmota, X-Sense,
Pi-hole, Proxmox und Synology, alles andere zu den Links. `group: devices` bzw. `group: links` am Link legt die Gruppe fest
(z. B. für den Speicher), `link_switch: false` zeigt wieder alle Links untereinander. Hat die ausgeblendete Gruppe Warnungen
(z. B. Updates oder gestörte Integrationen), steht ihre Anzahl am Umschalter.

### Popups

Die Popups sind halbtransparent, das Dashboard scheint durch:

```yaml
popup_opacity: 50   # Deckkraft in % (100 = deckend, 0 = nur Unschärfe)
popup_blur: 10      # Unschärfe des Hintergrunds in px (0 = scharf)
popup_dim: 20       # Abdunklung des Dashboards hinter dem Popup in %
```

### Schalter

Die Statuskachel „Schalter an/aus“ zählt eingeschaltete Steckdosen, Messdosen, Relais und Beleuchtungsschalter
(Geräteklasse `outlet` oder Name mit Schaltdose, Steckdose, Messdose, Relais, Beleuchtung, Pumpe …; Einstellungsschalter zählen nicht).
Ein Tipp öffnet die Liste nach Räumen, mit aktueller Leistung der Messdose und Schaltern zum Ein- und Ausschalten.
`switches: false` blendet die Kachel aus.

### Home-Assistant-Log

Ein Link mit `popup: log` öffnet das Systemprotokoll (Fehler, Warnungen, Info; Filter, Suche, Details zum Aufklappen).
Im Link stehen die Anzahl der Fehler und Warnungen. Nur für Administratoren.

### Integrationen überwachen

Ein Link mit `popup: integrations` öffnet die Überwachung der Integrationen: Verbindungsstatus der Konfigurationseinträge,
Geräte offline, Fehler, Warnungen und Timeouts aus dem Systemprotokoll. Welche Integrationen überwacht werden,
wählst du im Popup unter „Auswahl bearbeiten“; die Auswahl wird je Benutzer gespeichert.
Ohne eigene Auswahl werden die Integrationen aus `links` und `makers` überwacht. Nur für Administratoren.
Die Wartung zeigt zusätzlich Integrationen mit Fehler (mit „Neu laden“) und ausstehende Neustarts.

Gibt es den Helfer `input_text.integrationen_ueberwachung` (Option `monitor_entity`), speichert das Popup die Auswahl dort.
Dieselbe Auswahl nutzt dann die Überwachung in Home Assistant, die unabhängig vom Dashboard läuft und per Telegram meldet:
Verbindungsfehler, Geräte offline sowie Fehler, Timeouts und Verbindungsabbrüche aus dem Log.
Ist Telegram nicht erreichbar oder die Meldung älter als 2 Minuten, erscheint sie als Benachrichtigung in Home Assistant,
die bleibt, bis sie jemand quittiert. Paket: [`examples/integrationen_ueberwachung.yaml`](examples/integrationen_ueberwachung.yaml).

### Benutzer ohne Administratorrechte

- Begrüßung und Bild zeigen den angemeldeten Benutzer (seine Person, sonst seinen Namen).
- `admin_only: [pi_hole, proxmoxve, xsense]` blendet diese Integrationen für normale Benutzer aus:
  Links, Geräte in den Räumen und Raum-Popups, Kameras sowie die Zähler (Wartung, Batterien, offline).
- `admin: true` an einem Link zeigt ihn nur Administratoren. HA-Log und Integrationen sind immer nur für Administratoren.
- Administrator-Abfragen (Log, Konfigurationseinträge) werden für normale Benutzer gar nicht erst gestellt.

---

## Hervorhebung aktiver Geräte

Gerätekacheln werden farbig hinterlegt, solange das Gerät aktiv ist. Die Farben gelten einheitlich für Geräteseiten,
Raum-Popups, Raumkachel-Symbole und Link-Farben:

| Farbe | Bedeutung |
|---|---|
| rot | Verbrauch ab 10 W, Heizen, laufendes Haushaltsgerät, Rauchalarm; beim Ultimate Updater: Sicherheitsupdates |
| blau | Wassergerät in Betrieb (Ventil offen, Durchfluss, Pumpe) |
| lila | laufender Server (Proxmox, Synology-NAS); beim Ultimate Updater: Neustart nötig |
| orange | Pi-hole mit aktivem Blockieren, erreichbare X-Sense-Geräte; beim Ultimate Updater: Updates verfügbar |
| gelb | Licht an |
| grün | nur eingeschaltet; beim Ultimate Updater: aktuell |

Gilt für Shelly, Tasmota, ESPHome, Schlüter, Grohe, Miele, LocalThings, X-Sense, Proxmox, Pi-hole und die Raum-Popups.
Die Farbstärke stellt `color_strength` in der Startkarte ein (Standard 24 %).

Der Helfer `input_boolean.dashboard_farben` ([`examples/dashboard_farben.yaml`](examples/dashboard_farben.yaml)) schaltet die Farben ab:
dann werden aktive Geräte hell und inaktive gedimmt dargestellt. Ohne Helfer sind die Farben an; eine andere Entität setzt `color_entity`.

In der Statusleiste pulsieren Licht, Heizung, Fenster, Rollos, Schalter und das offene Ventil, sobald etwas aktiv ist.
Die Raumkacheln zeigen zusätzlich Boiler, Waschmaschine, Trockner, Backofen, Kochfeld, Dampfgarer, Geschirrspüler, Rauchmelder,
Server und Pi-hole mit der Anzahl eingeschalteter Geräte (erkannt am Gerätenamen, deutsch oder englisch, bzw. an der Integration;
Messdose und Gerät zählen zusammen als eines), in derselben Farbe wie die Gerätekachel. Ausgeschaltete oder deaktivierte Geräte
erscheinen nicht, Mediengeräte nur während einer Wiedergabe.

---

## SENEC Manager Card (Speicher)

Speicher-Übersicht für SENEC.Home V2/V3/V4 auf Basis von [ha-senec-v3](https://github.com/marq24/ha-senec-v3)
(lokal und WebAPI), angelehnt an das Dashboard des ioBroker.senec-Adapters: Batterie, Gesundheit und Zyklen, Temperaturen,
Zellspannungen als Heatmap, Netz, PV-Strings, Wallbox, Funktionen, Steuerung (Zwangsladung, Notstrom-Reserve, Steckdosen) und System.
Detailsensoren, die die Integration deaktiviert ausliefert, lassen sich in der Karte mit einem Klick aktivieren (Administratoren).

```yaml
type: custom:senec-manager-card
capacity: 10      # optional, nutzbare Kapazität in kWh (sonst aus dem Modellcode)
```

**Geräteprotokoll:** Das Tagesprotokoll liegt lokal auf dem Speicher (`https://<IP>/log/JJJJ/MM/TT.log`, selbstsigniertes Zertifikat).
Der Browser kann es nicht direkt abrufen, deshalb holt Home Assistant es über einen `shell_command` und ein Skript mit Antwort:

```yaml
# packages/energie/senec_protokoll.yaml (Neustart nötig)
shell_command:
  senec_geraeteprotokoll: >-
    curl -sk --max-time 20 https://192.168.30.6//log/{{ datum[0:4] | int }}/{{ '%02d' | format(datum[5:7] | int) }}/{{ '%02d' | format(datum[8:10] | int) }}.log
```

```yaml
# Skript script.senec_geraeteprotokoll (Feld „datum“, Antwort {text, code})
sequence:
  - action: shell_command.senec_geraeteprotokoll
    data: { datum: "{{ datum }}" }
    response_variable: antwort
  - variables: { ergebnis: "{{ {'text': antwort.stdout, 'code': antwort.returncode} }}" }
  - stop: Protokoll geladen
    response_variable: ergebnis
```

## Synology Manager Card

Je NAS eine Kachel: CPU, RAM, Temperatur, Volumes mit Belegung, Laufwerke mit Status und Temperatur, Netzwerk,
DSM-Update und Sicherheitsberater. Tasten für DSM, **Wecken**, Neustart und Herunterfahren (mit Rückfrage).

Wecken nutzt die Integration **Wake on LAN** (`wake_on_lan`, über die Oberfläche einrichten, MAC des NAS eintragen).
Die Karte findet die Taste über die MAC-Adresse selbst; sonst `wol: { <NAS-Name>: button.x }` angeben.
Im DSM muss unter *Hardware & Energie* „WOL auf LAN aktivieren“ eingeschaltet sein. Liegt das NAS in einem anderen VLAN
als Home Assistant, braucht die Integration die Broadcast-Adresse dieses Netzes.

```yaml
type: custom:synology-manager-card
warn: 80   # Auslastung ab % gelb
crit: 95   # ab % rot
```

## Ultimate Updater Card

Für den [Proxmox Ultimate Updater](https://github.com/BassT23/Proxmox) mit seiner Home-Assistant-Integration.
Je Updater-Instanz (Proxmox-Host) ein Kopfbereich mit Stand, laufendem Job oder Sammel-Update (mit Fortschritt),
letztem Job, Bericht und den Tasten *Alle prüfen*, *Sicherheitsupdates installieren*, *Alle aktualisieren*, *Job abbrechen*.
Darunter je System (Host, LXC, VM) eine Kachel mit Sicherheits- und weiteren Updates, Prüfstatus, letzter Prüfung,
Neustartbedarf und den Tasten *Prüfen*, *Aktualisieren* und *Neustart*. Filter nach Updates, Sicherheit, Neustart, nicht erreichbar.

```yaml
type: custom:updater-manager-card
confirm: true   # Rückfrage vor Aktualisieren und Neustart
```

## AWTRIX Screen Card

Zeigt das aktuelle Bild einer AWTRIX-Uhr (z. B. Ulanzi TC001 32×8 oder 64×8) als LED-Matrix mit runden LEDs.
Quelle ist ein MQTT-Sensor auf `<prefix>/state/screen` ([`examples/awtrix_bildschirm.yaml`](examples/awtrix_bildschirm.yaml)).
Solange die Karte sichtbar ist, fordert sie alle `interval` Sekunden über `<prefix>/cmd/screen/get` ein neues Bild an;
im Hintergrund oder bei verdecktem Tab läuft kein Abruf.

Ist MQTT getrennt oder schlägt der Abruf fehl, stoppt er für alle Uhren auf der Seite und die Karte zeigt eine Meldung über dem
abgedunkelten Bild. Neue Versuche folgen nach 15 s, 30 s, 60 s … (höchstens 5 min), sofort über „Erneut versuchen“ oder automatisch,
sobald der Sensor wieder verfügbar ist. Antwortet die Uhr selbst nicht, fragt die Karte nur noch alle 30 s.

```yaml
type: custom:awtrix-screen-card
entity: sensor.awtrix_tc001_bildschirm
request_topic: homeassistant/awtrix/88572119014c/cmd/screen/get
interval: 2       # Sekunden
name: TC001       # optional
gap: 0.18         # Abstand zwischen den LEDs
round: true       # runde LEDs
bare: false       # ohne Kartenrahmen
```

Den Bildsensor vom Recorder ausnehmen, sonst landet jedes Bild in der Datenbank:

```yaml
recorder:
  exclude:
    entity_globs: [sensor.awtrix_*_bildschirm]
```

In der Startkarte erscheinen die Uhren mit `awtrix: [{ entity, request_topic, name, interval }]` in der Seitenleiste.

---

## Beispielpakete

| Datei | Inhalt |
|---|---|
| [`examples/integrationen_ueberwachung.yaml`](examples/integrationen_ueberwachung.yaml) | Überwachung der Integrationen mit Telegram und Benachrichtigung als Rückfall |
| [`examples/dashboard_farben.yaml`](examples/dashboard_farben.yaml) | Helfer `input_boolean.dashboard_farben` |
| [`examples/awtrix_bildschirm.yaml`](examples/awtrix_bildschirm.yaml) | MQTT-Bildsensoren für die AWTRIX-Uhren |

Die Dateien gehören nach `/config/packages/…` (Pakete müssen in `configuration.yaml` eingebunden sein).

## Entwicklung

```
src/            eine Datei je Karte; 00-activity.js (gemeinsame Aktivitätserkennung) wird zuerst gebündelt
build.mjs       baut dist/ha-manager-cards.js
npm run check   bauen + Syntaxprüfung
```

Neue Version: Version in `package.json` erhöhen, `npm run check`, `dist/` mit committen und pushen.
Dann auf GitHub ein Release mit dem Tag `X.Y.Z` (ohne `v`) anlegen, darüber holt der Marketplace das Update.
