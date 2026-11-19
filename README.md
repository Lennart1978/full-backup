## Full-Backup: My Linux system backup-script log files.
## ! Only for personal use !

- All log file lists are password protected archives.
- Log file converted from ANSI text to HTML with 'aha' CLI tool.
- HTML log file uploaded to GitHub page, eMail report sent with 'msmtp' CLI mail tool.
- Bash backup script with Python3 for eMail composing and 'rsync' for all file transfer operations.

2026 -=by Lennart Martens=-

## Dashboard auf Cloudflare

Der Worker für [full-backup.eisenfeld.workers.dev](https://full-backup.eisenfeld.workers.dev/)
verwendet dieselben Berichtsordner wie GitHub Pages. Bei jedem Wrangler-Build liest
`_cloudflare/build.py` die HTML-Protokolle ein. Beim ersten API-Aufruf gleicht
der Worker neue, korrigierte und entfernte Berichte mit dem SQLite-Speicher
des Durable Objects `BackupArchive` ab. Die Datenbank entsteht mit der in
`wrangler.jsonc` hinterlegten Migration. Die Volltextsuche erfasst die sichtbaren
HTML-Protokolle. Die passwortgeschützten Dateilisten stehen im Originalbericht
zum Download.

- **Laufzeit** ist die Differenz von Start und Ende in der Zeitzone Europe/Berlin.
- **Datenmenge** summiert die von rsync gemeldeten, bereits gerundeten Werte für
  `Total transferred file size`.
- **Neu und gelöscht** zählen reguläre Dateien. **Geändert** ist aus übertragenen
  minus neu erstellten regulären Dateien abgeleitet. Reine Metadatenänderungen
  sind darin nicht erfasst. Hardlinks können die Ableitung beeinflussen.
- **Freier Speicher** stammt aus der Prüfung vor der Sicherung. Das Skript
  rechnet KiB in ganze GiB um und beschriftet den Messwert im Protokoll mit GB.
- **Erfolgs- und Fehlerquote** beziehen sich auf Läufe mit bekanntem Gesamtstatus.
  Fehlende Messwerte erscheinen als Strich. Ein explizit erfolgreicher
  rsync-Schritt entspricht Exit-Code 0.

Lokal mit Python 3.9+, Node.js und Wrangler 4 starten:

```sh
npx wrangler@4 dev
```

`npx wrangler@4 deploy --dry-run` prüft das Cloudflare-Paket.
Für das Deployment des bestehenden Workers gilt `npx wrangler@4 deploy`.
Der Cloudflare-Build erstellt seine eigenen Assets in `.dashboard-dist/`.
GitHub Pages baut die Archivseite weiter mit Jekyll.

### Berichtsordner löschen

Für die Löschfunktion unter **Workers & Pages → full-backup → Settings →
Variables and Secrets** zwei Secrets konfigurieren.

- `BACKUP_DELETE_EMAIL` ist die E-Mail-Adresse des Löschberechtigten in Cloudflare Access.
- `BACKUP_DELETE_TOKEN` ist ein Fine-grained GitHub-Token für das Repository
  `Lennart1978/full-backup` mit **Contents: Read and write**.

Mit **Deploy** werden die Laufzeit-Secrets für den Produktions-Worker wirksam.
Jeder Lauf zeigt **Protokoll öffnen** und **Protokoll löschen** bereits in der
Liste. Bei fehlenden Secrets nennt das Dashboard die betroffenen Namen.
Vor dem Löschen zeigt es den ausgewählten Lauf zur Bestätigung an. Der Worker
prüft das signierte Access-Token für die Produktionsadresse und vergleicht
die Version des Berichtsordners vor dem Löschen mit GitHub. Ein einzelner
Commit entfernt den gesamten Ordner aus `main`. Der Cloudflare-Worker
entfernt den Lauf aus der Suche und sperrt die zugehörigen Downloads sofort.
GitHub Pages übernimmt den Commit beim nächsten Build.
Ältere Git-Commits behalten ihre Historie. Für eine Wiederveröffentlichung
eines gelöschten Berichts einen neuen Lauf-Suffix im Ordnernamen verwenden.
