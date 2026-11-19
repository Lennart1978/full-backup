import { DurableObject } from "cloudflare:workers";
import manifest from "../.dashboard-dist/manifest.json";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export class BackupArchive extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL,
      summary TEXT NOT NULL, log TEXT NOT NULL
    )`);
    const stored = new Map(
      this.sql
        .exec("SELECT id, digest FROM runs")
        .toArray()
        .map((r) => [r.id, r.digest]),
    );
    this.pending = Object.entries(manifest).filter(([id, digest]) => stored.get(id) !== digest);
    // A removed report must disappear from search on the same deployment.
    for (const id of stored.keys()) {
      if (!Object.hasOwn(manifest, id)) this.sql.exec("DELETE FROM runs WHERE id = ?", id);
    }
  }

  async importBatch() {
    // Bound the number of asset reads even on the first import of a large archive.
    for (const [id, digest] of this.pending.slice(0, 12)) {
      const response = await this.env.ASSETS.fetch("https://assets.local/_import/" + digest + ".json");
      if (!response.ok) throw new Error("Berichtsimport fehlgeschlagen");
      const { summary, text } = await response.json();
      this.sql.exec(
        "INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?)",
        id,
        digest,
        summary.day,
        summary.type,
        JSON.stringify(summary),
        text,
      );
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
      `SELECT summary FROM runs ${where}
      ORDER BY day DESC, json_extract(summary, '$.start') DESC, json_extract(summary, '$.run') DESC, id`,
      ...values,
    );
    return json({
      runs: rows.toArray().map((row) => JSON.parse(row.summary)),
      types: this.sql
        .exec("SELECT DISTINCT type FROM runs ORDER BY type")
        .toArray()
        .map((row) => row.type),
    });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/runs") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return env.ARCHIVE.getByName("backup-reports").fetch(request);
    }
    if (path.startsWith("/api/")) return json({ error: "Unbekannter API-Pfad." }, 404);
    return env.ASSETS.fetch(request);
  },
};
