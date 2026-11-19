"""Build the Cloudflare assets and import records from the published HTML reports."""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / ".dashboard-dist"
FOLDER = re.compile(r"([\w-]+)_backup_log_(\d{2}-\d{2}-\d{4})(?:_(\d+))?")
STAMP = r"(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2})"
ZONE = ZoneInfo("Europe/Berlin")
SECTIONS = {"ROOT-DATEISYSTEM": "Root", "EFI-PARTITION": "EFI", "HOME-VERZEICHNIS": "Home"}


class ReportText(HTMLParser):
    """Preserve preformatted lines and inline spans, omit document styles."""
    def __init__(self):
        super().__init__()
        self.body = False
        self.hidden = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.body = True
        if tag in {"script", "style"}:
            self.hidden = True
        if self.body and tag in {"br", "div", "p", "pre"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "body":
            self.body = False
        if tag in {"script", "style"}:
            self.hidden = False
        if self.body and tag in {"div", "p", "pre"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.body and not self.hidden:
            self.parts.append(data)


def timestamp(label, text):
    match = re.search(label + r":\s*" + STAMP, text)
    if match:
        try:
            return datetime.strptime(match[1], "%d.%m.%Y %H:%M:%S")
        except ValueError:
            pass
    return None


def elapsed(start, end):
    if start and end:
        # At the autumn clock change, the log has no UTC offset to resolve the hour.
        for dt in (start, end):
            if dt.replace(tzinfo=ZONE, fold=0).utcoffset() != dt.replace(tzinfo=ZONE, fold=1).utcoffset():
                return None
        seconds = int(end.replace(tzinfo=ZONE).timestamp() - start.replace(tzinfo=ZONE).timestamp())
        if seconds >= 0:
            return seconds
    return None


def size_bytes(value):
    match = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*([KMGTPE]?)(i?)B?", value.strip(), re.I)
    if match:
        power = " KMGTPE".index(match[2].upper() or " ")
        return round(float(match[1].replace(",", ".")) * (1024 if match[3] else 1000) ** power)
    return None


def count_regular(value):
    # rsync includes directories and symlinks in the leading total.
    if value.strip() == "0":
        return 0
    if "(" not in value:
        return None
    match = re.search(r"\breg:\s*([\d.,]+)", value)
    return int(re.sub(r"[.,]", "", match[1])) if match else 0


def statistics(text):
    fields = dict(re.findall(r"^(Number of [^:\n]+|Total transferred file size):[ \t]*([^\n]+)", text, re.M))
    new = count_regular(fields.get("Number of created files", ""))
    removed = count_regular(fields.get("Number of deleted files", ""))
    transferred = re.sub(r"[.,]", "", fields.get("Number of regular files transferred", "").strip())
    changed = None
    if transferred.isdigit() and new is not None and int(transferred) >= new:
        changed = int(transferred) - new
    return {"bytes": size_bytes(fields.get("Total transferred file size", "")),
            "newFiles": new, "changed": changed, "deleted": removed}


def report(path, name, date, run):
    parser = ReportText()
    parser.feed(path.read_text(encoding="utf-8"))
    text = "".join(parser.parts)
    start, end = timestamp("Start", text), timestamp("Ende", text)
    free = re.search(r"Freier Speicher:\s*(\d+) GB", text)
    status = "unknown"
    if "GESAMTSTATUS: ALLE BACKUPS ERFOLGREICH!" in text:
        status = "ok"
    if "GESAMTSTATUS: BACKUP FEHLGESCHLAGEN!" in text:
        status = "error"

    headings = list(re.finditer(r"\[ (" + "|".join(SECTIONS) + r") [^\n]*? \]", text))
    jobs = {}
    for i, heading in enumerate(headings):
        stop = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        jobs[SECTIONS[heading[1]]] = statistics(text[heading.end():stop])
    expected = list(SECTIONS.values()) if name.lower() == "full" else list(jobs)
    for job in expected:
        alias = "(?:Boot|EFI)" if job == "EFI" else job
        code = re.search(rf"{alias}(?:-Backup fehlgeschlagen!| )\s*Exit-Code:\s*(\d+)", text)
        ok = re.search(rf"{job}-Backup erfolgreich\.", text)
        jobs.setdefault(job, statistics(""))["code"] = int(code[1]) if code else 0 if ok else None

    summary = {"id": path.parent.name, "type": name, "day": date.date().isoformat(), "run": run,
               "start": start.isoformat() if start else None, "seconds": elapsed(start, end),
               "status": status, "freeGiB": int(free[1]) if free else None, "jobs": jobs}
    for key in ("bytes", "newFiles", "changed", "deleted"):
        values = [job[key] for job in jobs.values()]
        summary[key] = sum(values) if values and None not in values else None
    return {"summary": summary, "text": text.casefold()}


def report_trees():
    """Read the Git tree IDs of the report folders included in this deployment."""
    if not (ROOT / ".git").exists():
        return {}
    entries = subprocess.check_output(["git", "ls-tree", "-z", "HEAD"], cwd=ROOT)
    trees = {}
    for entry in entries.decode("utf-8").split("\0"):
        if not entry:
            continue
        metadata, name = entry.split("\t", 1)
        _, kind, sha = metadata.split()
        if kind == "tree" and FOLDER.fullmatch(name):
            trees[name] = sha
    return trees


def git_digest(kind, chunks, size):
    digest = hashlib.sha1(f"{kind} {size}\0".encode("ascii"), usedforsecurity=False)
    for chunk in chunks:
        digest.update(chunk)
    return digest.digest()


def snapshot_tree(folder):
    """Compute the same tree ID from a source snapshot without Git metadata."""
    entries = []
    for child in folder.iterdir():
        name = os.fsencode(child.name)
        info = child.lstat()
        if stat.S_ISDIR(info.st_mode):
            entries.append((name + b"/", b"40000 " + name + b"\0" + snapshot_tree(child)))
            continue
        if stat.S_ISLNK(info.st_mode):
            mode = b"120000"
            target = os.fsencode(os.readlink(child))
            digest = git_digest("blob", [target], len(target))
        elif stat.S_ISREG(info.st_mode):
            mode = b"100755" if info.st_mode & stat.S_IXUSR else b"100644"
            with child.open("rb") as stream:
                digest = git_digest("blob", iter(lambda: stream.read(65536), b""), info.st_size)
        else:
            raise ValueError(f"Unerwarteter Dateityp im Backup-Bericht: {child}")
        entries.append((name, mode + b" " + name + b"\0" + digest))
    data = b"".join(entry for _, entry in sorted(entries))
    return git_digest("tree", [data], len(data))


def build():
    assets = DIST / "assets"
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(ROOT / "_cloudflare/ui", assets)
    imports = assets / "_import"
    imports.mkdir()
    for shared in ("log_style.css", "bild_192x192.png"):
        shutil.copy2(ROOT / shared, assets / shared)
    manifest = {}
    trees = report_trees()
    for page in sorted(ROOT.glob("*_backup_log_*/index.html")):
        match = FOLDER.fullmatch(page.parent.name)
        if not match:
            continue
        try:
            date = datetime.strptime(match[2], "%d-%m-%Y")
        except ValueError:
            continue
        record = report(page, match[1], date, int(match[3] or 1))
        payload = json.dumps(record, ensure_ascii=False).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        tree = trees.get(page.parent.name) or snapshot_tree(page.parent).hex()
        manifest[page.parent.name] = {"digest": digest, "tree": tree}
        (imports / f"{digest}.json").write_bytes(payload)
        dest = assets / page.parent.name
        dest.mkdir()
        for source in page.parent.iterdir():
            if source.is_file() and not source.is_symlink() and (source == page or source.suffix.lower() in {".7z", ".txt", ".css"}):
                shutil.copy2(source, dest / source.name)
    (DIST / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"{len(manifest)} Backup-Berichte für Cloudflare aufbereitet.")


if __name__ == "__main__":
    build()
