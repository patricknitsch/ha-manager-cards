# HA Manager Cards

Geräteseiten für Home Assistant im Stil des ioBroker Device Managers – je Gerätefamilie eine Karte – plus ein Übersichts-Dashboard im Stil von Dwains Dashboard, das die Geräteseiten als Popup öffnet.

Alle Karten stecken in **einer** Datei (`dist/ha-manager-cards.js`). In Home Assistant gibt es dadurch nur eine Ressource.

## Karten

| Karte | Typ | Integration |
|---|---|---|
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
| Bereichsübersicht | `custom:area-overview-card` | – (nutzt die Manager Cards) |
| Home Dashboard | `custom:home-dashboard-card` | – (Startseite) |

Die Konfigurationsoptionen stehen jeweils im Kopfkommentar der Datei in `src/`.

## Installation über den Marketplace

1. **Einstellungen → Marketplace → Aus Link hinzufügen**, Repository-URL eintragen, Kategorie *Dashboard*.
2. „HA Manager Cards“ installieren. Die Ressource wird automatisch eingetragen (`/local/community/ha-manager-cards/ha-manager-cards.js?v=…`).
3. Die bisherigen einzelnen Inline-Ressourcen der Karten unter **Einstellungen → Dashboards → Ressourcen** entfernen, sonst sind die Karten doppelt registriert (die zuerst geladene gewinnt).

## Manuelle Installation

`dist/ha-manager-cards.js` nach `/config/www/ha-manager-cards/` kopieren und als Ressource (Typ *JavaScript-Modul*) eintragen:

```
/local/ha-manager-cards/ha-manager-cards.js?v=1.0.0
```

Bei jedem Update die Versionsnummer in der URL erhöhen, sonst lädt der Browser die alte Datei aus dem Cache.

## Entwicklung

```
src/            eine Datei je Karte
build.mjs       baut dist/ha-manager-cards.js
npm run check   bauen + Syntaxprüfung
```

Neue Version: Version in `package.json` erhöhen, `npm run build`, committen, Tag `vX.Y.Z` pushen. Die GitHub Action baut das Bundle und hängt es an das Release, darüber holt der Marketplace das Update.


## Start-Dashboard: Home-Assistant-Log als Popup

Ein Eintrag in `links` mit `popup: log` öffnet statt einer Seite ein Popup mit dem Systemprotokoll (Fehler, Warnungen, Info;
Filter, Suche, Details zum Aufklappen). Im Link stehen die Anzahl der Fehler und Warnungen. Nur für Administratoren.

```yaml
links:
  - { name: HA-Log, icon: mdi:math-log, color: "#03a9f4", popup: log }
```

## SENEC Manager Card (Speicher)

Speicher-Übersicht für SENEC.Home V2/V3/V4 auf Basis der Integration [ha-senec-v3](https://github.com/marq24/ha-senec-v3)
(lokal und WebAPI), angelehnt an das Dashboard des ioBroker.senec-Adapters: Batterie, Gesundheit und Zyklen, Temperaturen,
Zellspannungen als Heatmap, Netz, PV-Strings, Wallbox, Funktionen, Steuerung (Zwangsladung, Notstrom-Reserve, Steckdosen) und System.
Detailsensoren, die die Integration deaktiviert ausliefert, lassen sich in der Karte mit einem Klick aktivieren (Administratoren).

```yaml
type: custom:senec-manager-card
capacity: 10      # optional, nutzbare Kapazität in kWh (sonst aus dem Modellcode)
```

### Geräteprotokoll

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


## Start-Dashboard: Integrationen überwachen

Ein Link mit `popup: integrations` öffnet die Überwachung der Integrationen: Verbindungsstatus der Konfigurationseinträge,
Geräte offline, Fehler, Warnungen und Timeouts aus dem Systemprotokoll. Welche Integrationen überwacht werden,
wählst du im Popup unter „Auswahl bearbeiten“; die Auswahl wird je Benutzer in Home Assistant gespeichert.
Ohne eigene Auswahl werden die Integrationen aus `links` und `makers` überwacht. Nur für Administratoren.

```yaml
links:
  - { name: Integrationen, icon: mdi:puzzle-check-outline, color: "#7e57c2", popup: integrations }
```

Gibt es den Helfer `input_text.integrationen_ueberwachung` (Option `monitor_entity`), speichert das Popup die Auswahl dort.
Dieselbe Auswahl nutzt dann die Überwachung in Home Assistant, die unabhängig vom Dashboard läuft und per Telegram meldet:
Verbindungsfehler, Geräte offline sowie Fehler, Timeouts und Verbindungsabbrüche aus dem Log.
Ist Telegram nicht erreichbar oder die Meldung älter als 2 Minuten, erscheint sie stattdessen als Benachrichtigung in Home Assistant,
die bleibt, bis sie jemand quittiert – so geht keine Meldung verloren.
Das Paket dazu liegt unter [`examples/integrationen_ueberwachung.yaml`](examples/integrationen_ueberwachung.yaml).

Die Wartung zeigt zusätzlich Integrationen mit Fehler (mit „Neu laden“) und ausstehende Neustarts.
Links zu Integrationen tragen am Icon die Anzahl aktiver Geräte (eingeschaltet bzw. in Betrieb).

## Start-Dashboard: Benutzer ohne Administratorrechte

- Die Begrüßung und das Bild oben zeigen den angemeldeten Benutzer (seine Person, sonst seinen Namen).
- `admin_only: [pi_hole, proxmoxve, xsense]` blendet diese Integrationen für normale Benutzer komplett aus:
  Links, Geräte in den Räumen und Raum-Popups, Kameras sowie die Zähler oben (Wartung, Batterien, offline).
- `admin: true` an einem Link zeigt ihn nur Administratoren. HA-Log und Integrationen sind immer nur für Administratoren.

## Start-Dashboard: Schalter

Die Statuskachel „Schalter an/aus“ zählt eingeschaltete Steckdosen, Messdosen, Relais und Beleuchtungsschalter
(Gerätklasse `outlet` oder Name mit Schaltdose, Steckdose, Messdose, Relais, Beleuchtung, Pumpe …; Einstellungsschalter zählen nicht).
Ein Tipp öffnet die Liste nach Räumen, mit aktueller Leistung der Messdose und Schalter zum Ein- und Ausschalten.
`switches: false` blendet die Kachel aus.

Die Popups sind halbtransparent, das Dashboard scheint durch. Einstellbar über:

```yaml
popup_opacity: 50   # Deckkraft in % (100 = deckend, 0 = nur Unschärfe)
popup_blur: 10      # Unschärfe des Hintergrunds in px (0 = scharf)
popup_dim: 20       # Abdunklung des Dashboards hinter dem Popup in %
```

## Hervorhebung aktiver Geräte

Gerätekacheln (Shelly, Tasmota, ESPHome, Schlüter, Proxmox, Pi-hole und Raum-Popups) werden hinterlegt, solange das Gerät aktiv ist:
rot bei Verbrauch ab 10 W, Heizen, laufendem Haushaltsgerät oder Rauchalarm; blau bei Wassergeräten in Betrieb (Ventil offen, Durchfluss, Pumpe);
gelb bei Licht an; grün, wenn es nur eingeschaltet ist; lila für laufende Server (Proxmox) und Pi-hole mit aktivem Blockieren.
Gilt für Shelly, Tasmota, ESPHome, Schlüter, Grohe, Miele, LocalThings, X-Sense, Proxmox, Pi-hole und die Raum-Popups.

Der Helfer `input_boolean.dashboard_farben` ([`examples/dashboard_farben.yaml`](examples/dashboard_farben.yaml)) schaltet die Farben ab:
dann werden aktive Geräte hell und inaktive gedimmt dargestellt. Ohne Helfer sind die Farben an; eine andere Entität setzt `color_entity`.

In der Statusleiste pulsieren Licht, Heizung, Fenster, Rollos, Schalter und das offene Ventil, sobald etwas aktiv ist.
Die Raumkacheln zeigen zusätzlich Boiler, Waschmaschine, Trockner, Backofen, Kochfeld, Dampfgarer, Geschirrspüler, Rauchmelder
und Server mit der Anzahl eingeschalteter Geräte (erkannt am Gerätenamen; Messdose und Gerät zählen zusammen als eines):
rot, wenn aktiv (Verbrauch, läuft, Server an), sonst grün; ausgeschaltete oder deaktivierte Geräte erscheinen nicht.
Mediengeräte erscheinen dort nur während einer Wiedergabe.
