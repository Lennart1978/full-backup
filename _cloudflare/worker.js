import { DurableObject } from "cloudflare:workers";
import manifest from "../.dashboard-dist/manifest.json";
import { deletionAccess, DASHBOARD_ORIGIN } from "./access.js";
import { removeReportFolder } from "./github.js";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export class BackupArchive extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL,
      summary TEXT NOT NULL, log TEXT NOT NULL, report_tree TEXT
    )`);
    if (
      !this.sql
        .exec("PRAGMA table_info(runs)")
        .toArray()
        .some((column) => column.name === "report_tree")
    ) {
      this.sql.exec("ALTER TABLE runs ADD COLUMN report_tree TEXT");
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deleted_reports (
      id TEXT NOT NULL, report_tree TEXT NOT NULL, PRIMARY KEY (id, report_tree)
    )`);
    const stored = new Map(
      this.sql
        .exec("SELECT id, digest, report_tree FROM runs")
        .toArray()
        .map((r) => [r.id, r]),
    );
    this.pending = Object.entries(manifest).filter(
      ([id, { digest, tree }]) =>
        !this.wasDeleted(id, tree) &&
        (stored.get(id)?.digest !== digest || stored.get(id)?.report_tree !== tree),
    );
    // A removed report must disappear from search on the same deployment.
    for (const id of stored.keys()) {
      if (!Object.hasOwn(manifest, id)) this.sql.exec("DELETE FROM runs WHERE id = ?", id);
    }
  }

  wasDeleted(id, tree) {
    return (
      this.sql.exec("SELECT 1 FROM deleted_reports WHERE id = ? AND report_tree = ?", id, tree).toArray()
        .length > 0
    );
  }

  async deleteRun(id, tree) {
    if (this.wasDeleted(id, tree)) return true;
    if (!(await removeReportFolder(this.env.BACKUP_DELETE_TOKEN, id, tree))) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR IGNORE INTO deleted_reports VALUES (?, ?)", id, tree);
      this.sql.exec("DELETE FROM runs WHERE id = ? AND report_tree = ?", id, tree);
    });
    return true;
  }

  async importBatch() {
    // Bound the number of asset reads even on the first import of a large archive.
    for (const [id, { digest, tree }] of this.pending.slice(0, 12)) {
      const response = await this.env.ASSETS.fetch("https://assets.local/_import/" + digest + ".json");
      if (!response.ok) throw new Error("Berichtsimport fehlgeschlagen");
      const { summary, text } = await response.json();
      if (!this.wasDeleted(id, tree)) {
        this.sql.exec(
          "INSERT OR REPLACE INTO runs (id, digest, day, type, summary, log, report_tree) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          digest,
          summary.day,
          summary.type,
          JSON.stringify(summary),
          text,
          tree,
        );
      }
      this.pending.shift();
    }
  }

  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const from = params.get("from") || "",
      to = params.get("to") || "";
    const type = params.get("type") || "";
    const query = (params.get("q") || "").trim().toLowerCase().replaceAll("ß", "ss");
    if (
      [from, to].some((v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) ||
      (from && to && from > to) ||
      query.length > 200 ||
      type.length > 150
    ) {
      return json({ error: "Bitte prüfe den Zeitraum und die Suchbegriffe." }, 400);
    }
    if (this.pending.length) {
      this.importing ??= this.importBatch().finally(() => {
        this.importing = null;
      });
      await this.importing;
      if (this.pending.length) return json({ remaining: this.pending.length }, 202);
    }

    const conditions = [],
      values = [];
    for (const [value, clause] of [
      [from, "day >= ?"],
      [to, "day <= ?"],
      [type, "type = ?"],
    ]) {
      if (value) {
        conditions.push(clause);
        values.push(value);
      }
    }
    if (query) {
      conditions.push("(instr(log, ?) > 0 OR instr(lower(id), ?) > 0)");
      values.push(query, query);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const rows = this.sql.exec(
      `SELECT summary, report_tree FROM runs ${where}
      ORDER BY day DESC, json_extract(summary, '$.start') DESC, json_extract(summary, '$.run') DESC, id`,
      ...values,
    );
    return json({
      runs: rows.toArray().map((row) => ({ ...JSON.parse(row.summary), tree: row.report_tree })),
      types: this.sql
        .exec("SELECT DISTINCT type FROM runs ORDER BY type")
        .toArray()
        .map((row) => row.type),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path;
    try {
      // Reject encoded separators so asset lookup and report routing agree.
      if (/%2f|%5c/i.test(url.pathname)) return new Response(null, { status: 400 });
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const archive = env.ARCHIVE.getByName("backup-reports");
    if (path === "/api/runs") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const [response, access] = await Promise.all([archive.fetch(request), deletionAccess(request, env)]);
      if (response.status !== 200) return response;
      return json({ ...(await response.json()), canDelete: access === "allowed", deletionAccess: access });
    }
    if (path.startsWith("/api/runs/")) {
      if (request.method !== "DELETE") {
        return new Response(null, { status: 405, headers: { Allow: "DELETE" } });
      }
      if (
        request.headers.get("Origin") !== DASHBOARD_ORIGIN ||
        (await deletionAccess(request, env)) !== "allowed"
      ) {
        return json({ error: "Für das Löschen fehlt die Berechtigung." }, 403);
      }
      const id = path.slice("/api/runs/".length);
      const tree = Object.hasOwn(manifest, id) ? manifest[id].tree : null;
      if (!tree)
        return json({ error: "Dieses Protokoll ist nicht mehr verfügbar. Lade die Übersicht neu." }, 404);
      if (request.headers.get("If-Match") !== `"${tree}"`) {
        return json({ error: "Das Protokoll wurde geändert. Lade die Übersicht neu." }, 412);
      }
      try {
        if (!(await archive.deleteRun(id, tree))) {
          return json(
            { error: "Das Protokoll wurde auf GitHub geändert. Warte auf den nächsten Build." },
            409,
          );
        }
        return json({ deleted: id });
      } catch (error) {
        console.error("Löschen des Backup-Protokolls fehlgeschlagen:", error.message);
        return json({ error: "Die Löschung konnte nicht bestätigt werden. Versuche es erneut." }, 502);
      }
    }
    if (path.startsWith("/api/")) return json({ error: "Unbekannter API-Pfad." }, 404);
    const folder = path.split("/")[1];
    if (folder === "_import") return new Response(null, { status: 404 });
    if (Object.hasOwn(manifest, folder)) {
      if (await archive.wasDeleted(folder, manifest[folder].tree)) {
        return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const response = await env.ASSETS.fetch(request);
      const asset = new Response(response.body, response);
      asset.headers.set("Cache-Control", "private, no-store");
      return asset;
    }
    return env.ASSETS.fetch(request);
  },
};
