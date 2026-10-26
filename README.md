# Ratter-Assistent

Web-App (PWA) fürs Android-Handy: erkennt Rattern beim Fräsen über das Handymikrofon und schlägt stabile Drehzahlen vor.

**App:** https://bollweg.github.io/ratter-app/ in Chrome öffnen, Menü ⋮ > "Zum Startbildschirm hinzufügen". Läuft danach offline.

## Ablauf

1. **Aufbau:** Setup (Maschine, Fräser, z, Auskragung, Halter), Soll-Drehzahl, Vorschub, ap, ae.
2. **Leerlauf:** 5 s Spindel ohne Schnitt. Liefert Grundgeräusch und Ist-Drehzahl (Schlupf).
3. **Schnitt:** Aufnahme im gleichmäßigen Vollschnitt, Start/Stopp von Hand.
4. **Auswertung:** Welch-Spektrum (2,9 Hz Auflösung bei 48 kHz), Peaks werden als Drehharmonische, Zahneingriff, Seitenband oder Ratterfrequenz eingeordnet. Vorschlag n = 60 · f_c / (z · k), über den Schlupf auf Soll-Drehzahl umgerechnet, Vorschub mitskaliert.
5. **Speichern:** Oberfläche bewerten, Notiz. Danach Nachmessung mit vorgeschlagener Drehzahl.

Verlauf je Setup: alle Ratterfrequenzen, Median, stabile Drehzahlen, Stabilitätskarte (ap über n).

## Daten

Alles bleibt im Browser-Speicher (IndexedDB) des Handys. Export als JSON (Sicherung, wieder importierbar) oder CSV (Excel, Semikolon, Dezimalkomma). Rohaudio wird nicht gespeichert, nur die Spektren.

## Dateien

| Datei | Inhalt |
|---|---|
| `dsp.js` | FFT, Welch, Peaksuche, Drehzahlschätzung, Ratterbewertung, Vorschläge (ohne DOM, unter Node testbar) |
| `app.js` | Oberfläche, Aufnahme (AudioWorklet, ohne Echo-/Rauschunterdrückung und Pegelautomatik), Diagramme, Export |
| `store.js` | IndexedDB |
| `sw.js` | Offline-Cache. Bei Änderungen `CACHE` hochzählen |

Lokal testen: `python -m http.server 8765`, dann http://localhost:8765. Mikrofon geht nur über HTTPS oder localhost. Für Tests ohne Maschine lassen sich in Schritt 2 und 3 WAV-Dateien laden.

## Grenzen

- Handymikrofone haben Pegelautomatik und Frequenzgang-Abweichungen. Für die Frequenz ist das unkritisch, Pegel verschiedener Aufnahmen sind nicht vergleichbar.
- Die Ratterfrequenz liegt etwas über der Eigenfrequenz. Vorschläge bei Bedarf 3 bis 5 % höher probieren.
- Die Erkennung braucht einen nicht-harmonischen Peak mit mindestens 10 dB Prominenz und 10 dB über dem Leerlauf (einstellbar).
