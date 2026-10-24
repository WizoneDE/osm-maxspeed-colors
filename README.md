# OSM Maxspeed Colors

*Deutsch weiter unten.*

## English

OSM Maxspeed Colors is a Chrome extension for the OpenStreetMap editor **iD** on
`openstreetmap.org` (*Edit* → iD). It makes the `maxspeed` tags visible at a glance, so
missing or implausible values stand out while you edit.

What you see on the map:

- **Coloured roads.** Every road is coloured by its speed limit for the selected vehicle
  type. In km/h the colour family shows the kind of road: red below 40 (≤ 5, 6–29,
  30–39), orange below 60 (40–49, 50–59), blue below 100 (60–69 … 90–99), green below
  120 (100–109, 110–119), pink for 120–129 and purple from 130. In mph there are 18 steps
  of 5 mph (≤ 5 … 85, above 85).
- **Speed-limit signs** on the roads: a red ring for a legal maximum, a blue square for an
  advisory speed, 🚶 for `walk`, a dark sign with ≈ for electronic signs without a usual
  maximum (`maxspeed:variable` alone, or the outdated `maxspeed=signals`). Hover over a
  sign to see the tag it came from; implicit values such as `DE:urban` are marked.
- **Official German signs** where one sign says it all: 325.1 living street
  (`highway=living_street` at walking pace), 242.1 pedestrian zone (`highway=pedestrian`),
  244.1 bicycle road (`bicycle_road=yes` or `cyclestreet=yes`, 30 unless tagged
  otherwise), 274.1 30 zone and 274.1-20 20 zone (`zone:maxspeed=DE:30`,
  `maxspeed=DE:zone30` …).
- **Supplementary panels ("Zusatzzeichen")** under the sign, as on real German signs:
  the official panels for wet (1053-35), 7.5 t (1053-33), trucks (1010-51), buses
  (1010-57), cars with trailer (1010-59), school (1012-50), the snow symbol, and panels
  in the same style with text made from the condition, e.g. `Mo-Fr 07:00-17:00` →
  „Mo–Fr / 7–17 h“, `sunset-sunrise` → „nachts“, `PH` → „an Feiertagen“. A value that
  only applies to the selected vehicle (e.g. `maxspeed:hgv`) gets that vehicle's panel.
- **Extra signs** next to the main sign, each with its panels: conditional limits
  (`maxspeed:conditional`; which kinds are shown can be chosen in the popup) and
  electronic signs (`maxspeed:variable`). For the latter the main sign and the line show
  `maxspeed` as the usual maximum; the extra sign is a dark electronic sign with the
  reasons as panels (`weather` → „Wetter“, `peak_traffic` → „Verkehrslage“,
  `school_zone` → 1012-50 …). With `maxspeed=none` the main sign is the advisory 130 and
  the electronic sign shows sign 282 (end of all restrictions).
- **Line patterns:** yellow dots on the band colour = advisory speed (`maxspeed=none` with
  `maxspeed:advisory`, else 130), long dashes = only a conditional limit, white dashes on
  blue-grey = electronic signs without a usual maximum, red dashes on white = no limit for this vehicle. If access
  is restricted (`access`, `vehicle`, `motor_vehicle` or `motorcar` = `private`,
  `destination`, `no` …) the red dashes are on grey, because there a missing limit can be
  correct.
- **Directions.** One-way roads show only their driving direction, at full width. If
  `:forward` and `:backward` differ, the road is drawn as two halves: seen in drawing
  direction, the right half is `forward`, the left half `backward` (as in right-hand
  traffic), each with its own sign. On dual carriageways (two one-way ways side by side)
  each sign moves to the outer side of its way, so the signs do not overlap.
- **Lanes** (`maxspeed:lanes`, on two-way roads `maxspeed:lanes:forward/backward`): the
  direction's width is cut into one stripe per lane, each in its own colour, and the sign
  reads e.g. `100|80|60`. OSM lists lanes from left to right in driving direction, so on
  two-way roads lane 1 is next to the centre line, on `oneway=yes` at the left edge and on
  `oneway=-1` at the right edge.
- **Ways that normally have no speed limit** (footways, paths, cycleways, steps, tracks,
  parking aisles, driveways …) become a thin white dashed line, unless they are tagged.
- A **legend** you can drag and fold.

Vehicle types: car (`maxspeed`), truck (`maxspeed:hgv`), bus (`maxspeed:bus`, then
`:coach`), trailer (`maxspeed:trailer`, then `:caravan`). Without a value of its own a
vehicle uses plain `maxspeed`.

Settings (toolbar icon): colouring, signs, extra signs and which kinds of them, legend,
vehicle type, km/h or mph, German or English. Changes apply at once to all open tabs.

### How it works

iD keeps every way's tags on its SVG line on the map. The extension reads them there;
nothing is loaded or sent anywhere, and iD's data is not changed.

| File | Purpose |
|---|---|
| `content.js` | Runs inside the iD page: reads the tags, colours roads, draws signs and legend. |
| `bridge.js` | Passes the settings and the shared tables from Chrome's storage to `content.js`. |
| `popup.html`, `popup.js` | The settings popup behind the toolbar icon. |
| `settings.js` | Shared defaults, tables and the settings check, used by popup and bridge. `content.js` gets what it needs through the bridge, because Chrome does not share variables between page-world scripts. |
| `_locales/` | Name and description in English and German. |
| `dev/test.js` | Tests for the tag reading and line styles: `node dev/test.js`. Not needed to run the extension. |
| `dev/signs/`, `dev/build-signs.js` | The official sign artwork and the script that writes it into `content.js` (`node dev/build-signs.js`). |

The German traffic signs come from [Wikimedia Commons](https://commons.wikimedia.org/)
(files named “Zeichen …, StVO …” and “Zusatzzeichen …”, linked from the German Wikipedia
article *Bildtafel der Verkehrszeichen in der Bundesrepublik Deutschland seit 2017*). As
official works they are in the public domain (§ 5 UrhG). They were optimised with svgo.

### Install

1. Download the latest release (or *Code* → *Download ZIP*) and unpack it.
2. Open `chrome://extensions` and switch on *Developer mode*.
3. *Load unpacked* → choose the unpacked folder (the one containing `manifest.json`).
4. Reload the iD editor.

### License

The code is released under the [MIT License](LICENSE). The German traffic sign artwork
(`dev/signs/` and the generated `SIGN_ART` block in `content.js`) is in the public domain
and not covered by that license.

---

## Deutsch

OSM Maxspeed Colors ist eine Chrome-Erweiterung für den OpenStreetMap-Editor **iD** auf
`openstreetmap.org` (*Bearbeiten* → iD). Sie macht die `maxspeed`-Tags auf einen Blick
sichtbar, sodass fehlende oder unplausible Werte beim Bearbeiten auffallen.

Was auf der Karte erscheint:

- **Gefärbte Straßen.** Jede Straße wird nach ihrem Tempolimit für den gewählten
  Fahrzeugtyp gefärbt. In km/h zeigt die Farbfamilie die Art der Straße: Rot unter 40
  (≤ 5, 6–29, 30–39), Orange unter 60 (40–49, 50–59), Blau unter 100 (60–69 … 90–99),
  Grün unter 120 (100–109, 110–119), Pink für 120–129 und Lila ab 130. In mph gibt es 18
  Stufen zu je 5 mph (≤ 5 … 85, darüber).
- **Tempo-Schilder** auf den Straßen: roter Ring für die Höchstgeschwindigkeit, blaues
  Quadrat für eine Richtgeschwindigkeit, 🚶 für `walk`, ein dunkles Schild mit ≈ für
  Wechselverkehrszeichen ohne üblichen Höchstwert (`maxspeed:variable` allein oder das
  veraltete `maxspeed=signals`). Die Maus über einem Schild zeigt den Tag, aus dem der Wert stammt;
  implizite Werte wie `DE:urban` sind gekennzeichnet.
- **Amtliche Verkehrszeichen**, wo ein Zeichen alles sagt: 325.1 verkehrsberuhigter
  Bereich (`highway=living_street` mit Schrittgeschwindigkeit), 242.1 Fußgängerzone
  (`highway=pedestrian`), 244.1 Fahrradstraße (`bicycle_road=yes` oder `cyclestreet=yes`,
  30 sofern nicht anders getaggt), 274.1 Tempo-30-Zone und 274.1-20 Tempo-20-Zone
  (`zone:maxspeed=DE:30`, `maxspeed=DE:zone30` …).
- **Zusatzzeichen** unter dem Schild wie in echt: die amtlichen Tafeln für Nässe
  (1053-35), 7,5 t (1053-33), Lkw (1010-51), Bus (1010-57), Pkw mit Anhänger (1010-59),
  Schule (1012-50), das Sinnbild Schnee- oder Eisglätte, und Tafeln im selben Stil mit
  Text aus der Bedingung, z. B. `Mo-Fr 07:00-17:00` → „Mo–Fr / 7–17 h“,
  `sunset-sunrise` → „nachts“, `PH` → „an Feiertagen“. Gilt ein Wert nur für das gewählte
  Fahrzeug (z. B. `maxspeed:hgv`), bekommt das Schild dessen Tafel.
- **Zusatzschilder** neben dem Hauptschild, jeweils mit ihren Tafeln: bedingte Limits
  (`maxspeed:conditional`; welche Arten erscheinen, lässt sich im Popup wählen) und
  Wechselverkehrszeichen (`maxspeed:variable`). Bei Letzteren zeigen Hauptschild und
  Linie `maxspeed` als üblichen Höchstwert; daneben steht ein dunkles
  Wechselverkehrszeichen mit den Gründen als Tafeln (`weather` → „Wetter“,
  `peak_traffic` → „Verkehrslage“, `school_zone` → 1012-50 …). Bei `maxspeed=none` ist
  das Hauptschild die Richtgeschwindigkeit 130 und das Wechselverkehrszeichen zeigt
  Zeichen 282 (Ende sämtlicher Streckenverbote).
- **Linienmuster:** gelbe Punkte auf der Stufenfarbe = Richtgeschwindigkeit
  (`maxspeed=none` mit `maxspeed:advisory`, sonst 130), lange Striche = nur bedingtes
  Limit, weiße Striche auf Blaugrau = Wechselverkehrszeichen ohne üblichen Höchstwert, rote Striche auf Weiß = kein
  Limit für dieses Fahrzeug. Bei beschränkter Zufahrt (`access`, `vehicle`,
  `motor_vehicle` oder `motorcar` = `private`, `destination`, `no` …) liegen die roten
  Striche auf Grau, weil dort ein fehlendes Limit stimmen kann.
- **Richtungen.** Einbahnstraßen zeigen nur ihre Fahrtrichtung, in voller Breite.
  Unterscheiden sich `:forward` und `:backward`, wird die Straße als zwei Hälften
  gezeichnet: in Zeichenrichtung gesehen rechts `forward`, links `backward` (wie bei
  Rechtsverkehr), jeweils mit eigenem Schild. Bei zweibahnigen Straßen (zwei
  Einbahn-Wege nebeneinander) rückt jedes Schild auf die Außenseite seines Wegs, damit
  sich die Schilder nicht überdecken.
- **Spuren** (`maxspeed:lanes`, auf Zweirichtungsstraßen `maxspeed:lanes:forward/backward`):
  Die Breite der Richtung wird in einen Streifen je Spur geteilt, jeder in seiner Farbe;
  das Schild zeigt z. B. `100|80|60`. OSM zählt Spuren in Fahrtrichtung von links nach
  rechts, deshalb liegt Spur 1 auf Zweirichtungsstraßen an der Mittellinie, bei
  `oneway=yes` am linken und bei `oneway=-1` am rechten Rand.
- **Wege, die normalerweise kein Tempolimit haben** (Fußwege, Pfade, Radwege, Treppen,
  Wirtschaftswege, Parkplatzgassen, Grundstückszufahrten …), werden zur feinen weißen
  Strichlinie, sofern sie kein Limit tragen.
- Eine **Legende**, die sich verschieben und einklappen lässt.

Fahrzeugtypen: PKW (`maxspeed`), LKW (`maxspeed:hgv`), Bus (`maxspeed:bus`, dann
`:coach`), Anhänger (`maxspeed:trailer`, dann `:caravan`). Ohne eigenen Wert gilt für ein
Fahrzeug das allgemeine `maxspeed`.

Einstellungen (Erweiterungs-Icon): Färbung, Schilder, Zusatzschilder und welche Arten
davon, Legende, Fahrzeugtyp, km/h oder mph, Deutsch oder Englisch. Änderungen gelten sofort
in allen offenen Tabs.

### Funktionsweise

iD hängt die Tags jedes Wegs an dessen SVG-Linie auf der Karte. Die Erweiterung liest sie
dort; es wird nichts geladen oder verschickt, und iDs Daten bleiben unverändert.

Die Dateien und ihre Aufgaben stehen in der Tabelle im englischen Teil oben.

### Installation

1. Die neueste Version (Release, oder *Code* → *Download ZIP*) herunterladen und entpacken.
2. `chrome://extensions` öffnen und den *Entwicklermodus* einschalten.
3. *Entpackte Erweiterung laden* → den entpackten Ordner wählen (der mit `manifest.json`).
4. Den iD-Editor neu laden.

### Lizenz

Der Code steht unter der [MIT-Lizenz](LICENSE). Die Verkehrszeichen (`dev/signs/` und der
erzeugte `SIGN_ART`-Block in `content.js`) sind gemeinfrei und fallen nicht unter diese Lizenz.
