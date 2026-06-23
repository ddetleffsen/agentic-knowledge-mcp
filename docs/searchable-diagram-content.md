# Konzept: Durchsuchbare Diagramm-Inhalte & Binärdaten-Filter

**Datum:** 2026-06-23
**Status:** Proposal
**Betrifft:** `packages/core/src/search/searcher.ts` (`search_docs`-Tool)

---

## Problem

`search_docs` liefert bei Docsets mit Diagramm-Assets sporadisch `Transport closed`.

Ursache: Die Binär-Erkennung (`isBinaryFile`) prüft nur die ersten 8 KB auf
Null-Bytes. Text-Formate mit eingebetteten Bildern entgehen dieser Prüfung:

- `.gliffy`, `.excalidraw` (JSON) enthalten Bilder als Data-URI
  (`"dataURL": "data:image/png;base64,iVBOR…"`) — oft mehrere MB **in einer Zeile**.
- Komprimierte `.drawio` (XML) enthalten im `<diagram>`-Tag einen langen,
  reinen Base64-Lauf (deflate-komprimiert).

`grepFile` gibt die komplette Match-Zeile zurück. Trifft das Pattern eine solche
Zeile, landen Megabytes Base64 in der JSON-RPC-Antwort → die stdio-Antwort wird zu
groß, das Framing/Timeout bricht → `Transport closed`.

`.drawio.png` wird dagegen als echtes Binär (PNG-Header mit Null-Bytes) komplett
übersprungen — das darin eingebettete Diagramm-XML ist aktuell nicht durchsuchbar.

## Ziel

- **Text bleibt durchsuchbar** — Labels, Titel, Shape-Texte in Diagrammen.
- **Nur die Binärdaten** (Base64-Payloads) werden entfernt, nicht ganze Zeilen
  oder Dateien.
- **`.drawio.png`** wird durchsuchbar, ohne den Dual-Use zu verlieren (rendert
  als Bild in der IDE, editierbar in drawio).
- **Keine neue Dependency** — alles mit `node:zlib` (builtin).

## Lösung in drei Ebenen

### 1. `stripBinary()` — Payload auf Zeilenebene entfernen

Vor dem Matchen wird jede Zeile durch einen Filter geschickt, der nur die
Binär-Substrings ersetzt und den umgebenden Text erhält:

```ts
const DATA_URI = /(data:[^,;\s]*;base64,)[A-Za-z0-9+/=]+/g;
const RAW_B64   = /[A-Za-z0-9+/]{500,}={0,2}/g; // lange, freistehende Base64-Läufe

function stripBinary(line: string): string {
  return line
    .replace(DATA_URI, "$1…[omitted]")
    .replace(RAW_B64, "[base64 omitted]");
}
```

In der Lese-Schleife von `grepFile`:

```ts
for await (const line of rl) {
  const clean = stripBinary(line);
  lines.push(clean);
  if (regex.test(clean)) matchIndices.push(lines.length - 1);
}
```

Eigenschaften:

- Zeilennummern bleiben korrekt (Ersetzung *in* der Zeile, keine Zeile wird verworfen).
- Funktioniert auch bei minifizierten Single-Line-JSONs (Text neben der Payload überlebt).
- `;base64,` ist 100 % treffsicher; der `RAW_B64`-Schwellwert (500) ist konservativ,
  da 500+ zusammenhängende Base64-Zeichen ohne Trennzeichen in echtem Text/Code
  praktisch nicht vorkommen.

### 2. `extractDrawioXml()` — Diagramm-XML aus `.drawio.png` lesen

`.drawio.png` ist ein valides PNG mit dem Diagramm-XML in einem `tEXt`/`zTXt`-Chunk
(Keyword `mxfile`), der **vor** dem Pixel-Chunk `IDAT` liegt. Wir scannen nur die
Chunk-Header bis `IDAT` und brechen dann ab — Pixel-Daten werden nie dekodiert.

```ts
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

async function extractDrawioXml(absPath: string): Promise<string | null> {
  const buf = await readFile(absPath);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let off = 8;
  while (off + 8 <= buf.length) {
    const len  = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT" || type === "IEND") break; // Pixel-Daten → kein mxfile-Chunk
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === "tEXt" || type === "zTXt") {
      const sep = data.indexOf(0);
      const keyword = data.toString("latin1", 0, sep);
      if (keyword === "mxfile" || keyword === "mxGraphModel") {
        const payload = type === "zTXt"
          ? inflateSync(data.subarray(sep + 2)).toString("latin1") // \0 + Kompressionsbyte
          : data.toString("latin1", sep + 1);
        return decodeURIComponent(payload); // inneres <diagram> ggf. zusätzlich inflateRaw
      }
    }
    off += 12 + len; // 4 len + 4 type + len + 4 crc
  }
  return null;
}
```

Einbindung im Lese-Pfad (`grepFile`/`readTextFile`), vor der Binär-Behandlung:

```ts
if (/\.png$/i.test(absPath)) {
  const xml = await extractDrawioXml(absPath);
  if (xml) return /* dieses XML durchsuchen statt der Bytes */;
  // sonst: normales Bild → wie bisher überspringen
}
```

Der `stripBinary()`-Filter (Ebene 1) läuft anschließend über das extrahierte XML,
falls das innere `<diagram>` noch komprimiert/Base64 ist.

### 3. (Optional) `.drawio.svg`

Analog: Bei `.drawio.svg` steckt das `<mxfile>` im `content="…"`-Attribut des
SVG-Roots. Dieselbe Decode-Logik wie bei PNG, anderer Container.

## Auswirkungen

- Behebt die `Transport closed`-Abbrüche, da keine Megabyte-Payloads mehr in die
  Antwort gelangen.
- Diagramm-Texte (drawio/gliffy/excalidraw) werden durchsuchbar statt verworfen.
- Performance bleibt günstig: PNG-Scan stoppt vor den Pixel-Daten; bei normalen
  Screenshot-PNGs ist man nach wenigen Chunks raus.

## Abgrenzung / Caveats

- **Zeilennummern bei `.drawio.png` sind synthetisch** — sie beziehen sich auf das
  extrahierte Diagramm-XML, nicht auf Byte-Offsets im PNG.
- **Reine Bild-PNGs** (Screenshots ohne `mxfile`-Chunk) fallen sauber auf „skip" zurück.
- `isBinaryFile` bleibt unverändert für echte Binärdateien (PDF, normale PNG/JPG);
  die neuen Mechanismen ergänzen es, ersetzen es nicht.
- Inneres `<diagram>` kann raw-deflate + URL-encoded sein → bei Bedarf
  `inflateRawSync` + zweites `decodeURIComponent`.

## Out of Scope

- Volltext-Tracing/Observability im MCP-Server (separat zu bewerten; falls nötig,
  nur strukturiertes Logging nach `stderr` — niemals `stdout`, das ist der
  JSON-RPC-Kanal).
- Rendering oder Vorschau von Diagrammen.
