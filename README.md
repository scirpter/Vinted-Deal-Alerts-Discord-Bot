# Vinted Deal-Alerts - Discord-Bot

Multi-Guild, privater Vinted-Monitoring-Bot (pro Nutzer), der neue passende Angebote als Embeds in dedizierte Discord-Kanäle postet - mit Action-Buttons.

## Was du damit machen kannst

- Verbinde dein Vinted-Konto über `/setup account` (Region + Refresh-Token)
- Erstelle und verwalte mehrere private Kanäle pro Nutzer mit `/setup subscription add|filters|list|remove`
- Füge beliebige Vinted-Such-URLs ein (Kategorien, Keywords, Preisspannen und weitere Filter)
- Verfeinere Abos mit zusätzlichen Include/Exclude-Wörtern und einer Preisspanne
- Erhalte neue passende Angebote „quasi in Echtzeit“ (Polling) in den konfigurierten Kanälen
- Nutze Buttons pro Angebot: **Ansehen**, **Jetzt kaufen**, **Angebot machen**, **Favorisieren**
- Setze Koordinaten mit `/set_pickup_point`

## Hinweise zu API-Aktionen

Vinted nutzt Anti-Bot- und Zugriffsschutz. Einige zustandsändernde Aktionen (insbesondere Checkout/Kauf/Favorisieren/Angebot) können abgewiesen werden. Der Bot:

- Führt API-Aktionen aus, wenn möglich
- Erkennt und unterscheidet `blocked` (Cloudflare/CAPTCHA) und `access_denied` (API-Zugriff verweigert)
- Versucht bei `401/403` im `auto`-Backend zusätzlich einen zweiten Request über `curl`, bevor endgültig fehlgeschlagen wird
- Erkennt DataDome-Captcha-Challenges (`captcha-delivery.com`) und versucht einmalig ein Session-Priming mit anschließendem Retry
- Gibt bei DataDome-Blocks den konkreten Challenge-Link zurück, damit du ihn im Browser öffnen und danach den Kauf erneut auslösen kannst
- Gibt klare, konkrete Hinweise zur Behebung (`/setup account`, Region prüfen, manuell in Vinted abschließen)
- Erkennt auch API-`errors`-Payloads (bei HTTP 200) als echte Fehler statt stillem Fallback
- Übernimmt `Set-Cookie` aus Vinted-Antworten in eine interne Session-Cookie-Chain und sendet sie bei Folgerequests mit
- Berücksichtigt Cookie-Domains (`Domain=.vinted.<region>`) in der Session-Cookie-Chain für Folge-Requests auf Subdomains
- Trennt die interne Session/Cookie-Chain pro Discord-User (Multi-Account-fähig, ohne globale Header-Kollisionen)
- Setzt `x-anon-id` und `x-v-udt` automatisch aus Session-Headern/Cookies (kein manueller Input pro User nötig)
- Setzt `x-datadome-clientid` automatisch aus dem `datadome`-Cookie, wenn vorhanden
- Nutzt für API-Aktionen primär Web-Session-Auth (`access_token_web`/`refresh_token_web` Cookie + Browser-Header) und versucht bei `401/403` zusätzlich einen Authorization-Fallback
- Nutzt bei Checkout einen Fallback ohne `pickup_point`, falls die gespeicherten Koordinaten ungültig sind
- Versucht bei Checkout zuerst die aufgelöste Transaktions-ID und fällt bei fehlender Checkout-URL automatisch auf die ursprüngliche Item-ID zurück
- Erkennt zusätzliche Checkout-Response-Formate (verschachtelte `purchase_id`/`next_step.url`) statt fälschlich als blockiert zu enden
- Versucht bei fehlender `checkout_url` zusätzlich einen direkten Submit-Fallback mit den ermittelten Kauf-ID-Kandidaten (`transactionId`/`itemId`)
- Loggt beim Submit-Fallback jeden Kauf-ID-Kandidaten inkl. Ergebnis, um Checkout-Blocks präzise zu diagnostizieren
- Erkennt `invalid_grant` beim Token-Refresh als dauerhaft und pausiert weitere Refresh-Versuche zeitweise, bis `/setup account` erneut ausgeführt wurde
- Benachrichtigt bei `invalid_grant` zusätzlich direkt im Abo-Kanal (mit Mention) und per DM als Best-Effort mit Cooldown

Optional kannst du das HTTP-Backend erzwingen via `VINTED_HTTP_BACKEND=curl` (oder `fetch`).

Aktueller Status:

- Favorisieren: API-Aufruf mit klarer Fehlerklassifikation (`blocked`/`access_denied`)
- Jetzt kaufen / Autokauf: Best-Effort-Direktkauf über Checkout-API (`build` + `purchases/{id}/checkout`), inkl. Fallback ohne `pickup_point`; falls Vinted trotzdem manuelle Bestätigung verlangt, wird klar darauf hingewiesen
- Angebot machen: versucht API-Senden; bei Fehlern Fallback mit klarer Meldung und ggf. Gebührenschätzung

## Koordinaten (`/set_pickup_point`)

- Erwartet werden **Rohkoordinaten** im Format `latitude,longitude`.
- Beispiele: `52.520008,13.404954` oder `48.137154,11.576124`
- Erlaubt sind Dezimalzahlen mit Punkt; keine freie Ortsbeschreibung und keine Vinted-Abholpunkt-ID.
- Bereich: Latitude `-90..90`, Longitude `-180..180`.
- Die Antwort zeigt den tatsächlich gespeicherten Wert zur direkten Kontrolle.

## Einrichtung

### 1) Discord-Anwendung

Erstelle eine Discord Application + Bot und lade ihn mit folgenden Berechtigungen auf deinen Server ein:

- Kanäle verwalten (nur wenn der Bot private Kanäle erstellen soll)
- Kanäle ansehen, Nachrichten senden, Links einbetten, Externe Emojis verwenden

### 2) Umgebungsvariablen

Kopiere `.env.example` nach `.env` und setze:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DATABASE_URL`
- `TOKEN_ENCRYPTION_KEY` (base64, 32 Bytes)
- Optional:
  - `LOG_LEVEL` (z. B. `info`, `debug`)
  - `DISCORD_GUILD_ID` (nur Dev: Slash-Commands nur für einen Server deployen; Updates sind sofort sichtbar)
  - `VINTED_HTTP_BACKEND` (`auto` | `fetch` | `curl`)
  - `VINTED_SESSION_WARMUP` (optional `true|false`; Standard: aktiv außerhalb von Tests)
  - `VINTED_USER_AGENT` (optional eigener User-Agent; Standard ist ein Browser-UA)
  - `VINTED_INCOGNIA_REQUEST_TOKEN` (optional `X-Incognia-Request-Token` Header für geschützte Endpunkte)
  - `VINTED_AUTO_INCOGNIA_REQUEST_TOKEN` (optional `true|false`; Standard: `true` außerhalb von Tests. Generiert automatisch `X-Incognia-Request-Token`, wenn keiner gesetzt ist)
  - `VINTED_INCOGNIA_APP_ID` (optional App-ID für Auto-Incognia; wenn leer, wird sie automatisch von `www.vinted.<region>` ermittelt)
  - `VINTED_ANON_ID` (optional `X-Anon-Id` Header; wird sonst auch aus `VINTED_COOKIE` `anon_id=...` abgeleitet)
  - `VINTED_COOKIE` (optional Cookie-Header, z. B. `datadome=...; anon_id=...`; wird mit serverseitigen `Set-Cookie`-Werten kombiniert)
  - `X-CSRF-Token` wird automatisch gesetzt (Web-Default), kann bei Bedarf über `VINTED_EXTRA_HEADERS_JSON` überschrieben werden
  - `VINTED_EXTRA_HEADERS_JSON` (optional JSON-Objekt zusätzlicher Header, z. B. `{"x-custom":"value"}`)
  - `WATCH_INTERVAL_MS` (Default: `5000`)
  - `WATCH_CONCURRENCY` (Default: `1`)
  - `WATCH_FETCH_DELAY_MS` (Default: `1000`)

### 3) Installieren + migrieren + Slash-Commands deployen

```bash
pnpm install
pnpm setup
pnpm dev
```

Wichtig:

- Ohne `DISCORD_GUILD_ID` werden Global-Commands deployed (Discord braucht dafür teils deutlich länger).
- Für sofortige Updates im Test-Server: `pnpm deploy:commands -- --scope guild --guild-id <GUILD_ID>`.
- Danach Bot-Prozess neu starten, damit Codeänderungen aktiv sind.

Falls Slash-Commands doppelt angezeigt werden:

- Nur Guild behalten: `pnpm deploy:commands -- --clear-global --scope guild --guild-id <GUILD_ID>`
- Nur Global behalten: `pnpm deploy:commands -- --clear-guild --guild-id <GUILD_ID> --scope global`
- Alles (global + alle Guilds) löschen, ohne Guild-ID: `pnpm deploy:commands -- --clear-all --no-deploy`

### 4) Vinted verbinden

Führe `/setup account` in deinem Discord-Server aus.

Der Bot erwartet deinen Vinted-Web-Refresh-Token. Du findest ihn meistens als Cookie `refresh_token_web` auf `www.vinted.<region>` nach dem Login.

Hinweis zur Eingabe:

- Du kannst den reinen Wert oder `refresh_token_web=...` einfügen; der Bot extrahiert den Token automatisch.
- Wenn die gewählte Region nicht passt und nur `invalid_grant` zurückkommt, prüft der Bot die unterstützten Regionen automatisch.
- Auch `Cookie:`/`Set-Cookie:`-Zeilen mit `refresh_token_web=...` werden akzeptiert; Leerzeichen/Zeilenumbrüche werden bereinigt.
- Wenn dein Account parallel in einem anderen Bot läuft, kann dessen Token-Rotation alte `refresh_token_web`-Werte ungültig machen.

## Befehle

- `/setup account` - verbindet dein Vinted-Konto (Region + Refresh-Token)
- `/setup help` - Kurzanleitung und Tipps für die Einrichtung
- `/setup subscription add` - fügt ein Abo hinzu (Vinted-Such-URL einfügen, Kanal wählen/erstellen; optional: Wörter/Preisspanne)
- `/setup subscription filters` - setzt zusätzliche Filter (positive/negative Wörter + Preisspanne) für ein bestehendes Abo
- `/setup subscription list` - zeigt deine Abos auf diesem Server
- `/setup subscription remove` - entfernt ein Abo
- `/set_pickup_point` - speichert deine Rohkoordinaten (für Checkout/Autokauf, falls unterstützt)
