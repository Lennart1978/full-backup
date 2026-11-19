const $ = (id) => document.getElementById(id);
const number = (value) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
const statusNames = { ok: "Erfolgreich", error: "Fehler", unknown: "Unbekannt" };
const keys = ["q", "from", "to", "type"];
let runs = [],
  metric = "seconds",
  timer,
  request;
const missing = "—";

function element(tag, value, name) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (name) node.className = name;
  return node;
}
function bytes(n) {
  if (n == null) return missing;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return number(n) + " " + units[i];
}
function duration(n) {
  if (n == null) return missing;
  n = Math.round(n);
  const minutes = Math.floor(n / 60);
  return minutes ? minutes + " min " + String(n % 60).padStart(2, "0") + " s" : n + " s";
}
function date(day) {
  return day.split("-").reverse().join(".");
}
function time(r) {
  return r.start?.slice(11, 19) || "Zeit unbekannt";
}
function typeName(type) {
  return type.toLowerCase() === "full" ? "Vollbackup" : type;
}
function series(key) {
  return runs.map((r) => r[key]).filter((n) => n != null);
}
function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}
function coverage(n) {
  return n + " von " + runs.length + (runs.length === 1 ? " Lauf erfasst" : " Läufen erfasst");
}

function drawMetrics() {
  const ok = runs.filter((r) => r.status === "ok").length;
  const fail = runs.filter((r) => r.status === "error").length;
  const known = ok + fail;
  const unknown = runs.length - known;
  $("rate").textContent = known ? number((100 * ok) / known) + " %" : missing;
  $("ratesub").textContent =
    (known ? number((100 * fail) / known) + " % Fehlerquote" : "Kein Abschlussstatus") +
    (unknown ? " · " + unknown + " unbekannt" : "");
  const sizes = series("bytes"),
    lengths = series("seconds");
  $("bytes").textContent = bytes(sizes.length ? sum(sizes) : null);
  $("bytessub").textContent = coverage(sizes.length);
  $("duration").textContent = duration(lengths.length ? sum(lengths) / lengths.length : null);
  $("durationsub").textContent = coverage(lengths.length);
  const measured = runs.find((r) => r.freeGiB != null);
  $("space").textContent = measured ? number(measured.freeGiB) + " GiB" : missing;
  $("spacesub").textContent = measured
    ? "Bei Start · " + date(measured.day) + " " + time(measured).slice(0, 5)
    : "Keine Speicherangabe";
  $("latest").replaceChildren();
  if (runs.length)
    $("latest").append("Letzter Lauf der Auswahl", element("b", date(runs[0].day) + " · " + time(runs[0])));
}

function drawChart() {
  const selected = runs.slice(0, 12).reverse(),
    chart = $("chart");
  const format = metric === "seconds" ? duration : bytes;
  $("show-time").setAttribute("aria-pressed", metric === "seconds");
  $("show-bytes").setAttribute("aria-pressed", metric === "bytes");
  $("historysub").textContent =
    selected.length === 1
      ? "Eine Sicherung"
      : selected.length
        ? "Die letzten " + selected.length + " Sicherungen"
        : "Keine Sicherungen in der Auswahl";
  chart.replaceChildren();
  const max = Math.max(1, ...selected.map((r) => r[metric] ?? 0));
  for (const r of selected) {
    const col = element("div", null, "chart-col"),
      track = element("div", null, "track");
    const bar = element("span", null, "bar");
    bar.style.height = (r[metric] == null ? 0 : Math.max(1, (77 * r[metric]) / max)) + "px";
    track.append(element("b", format(r[metric])), bar);
    const axis = element("div", date(r.day).slice(0, 6), "axis");
    axis.append(element("time", r.start ? time(r).slice(0, 5) : "Lauf " + r.run));
    col.title = date(r.day) + " · " + time(r) + " · " + format(r[metric]);
    col.append(track, axis);
    chart.append(col);
  }
}

function drawChanges() {
  const container = $("changes");
  container.replaceChildren();
  const fields = [
    ["newFiles", "Neu", "added"],
    ["changed", "Geändert¹", "changed"],
    ["deleted", "Gelöscht", "deleted"],
  ];
  const values = fields.map(([key]) => series(key));
  const maximum = Math.max(1, ...values.map(sum));
  fields.forEach(([, label, cls], i) => {
    const block = element("div"),
      row = element("div", null, "file-row");
    const nums = values[i],
      amount = sum(nums);
    row.append(element("span", label), element("b", nums.length ? number(amount) : missing));
    const meter = element("div", null, "meter"),
      part = element("i", null, cls);
    part.style.width = (amount / maximum) * 100 + "%";
    meter.append(part);
    block.append(row, meter);
    container.append(block);
  });
  let note = "¹ Übertragene reguläre Dateien abzüglich neuer regulärer Dateien.";
  if (values.some((v) => v.length < runs.length)) note += " Summen umfassen nur Läufe mit Messwert.";
  container.append(element("p", note, "note"));
}

const deletionDialog = $("delete-dialog");
const deleteCancel = $("delete-cancel");
const deleteConfirm = $("delete-confirm");
let selectedReport;

function confirmDeletion(report) {
  selectedReport = report;
  $("delete-target").textContent =
    typeName(report.type) + " · " + date(report.day) + " · " + time(report) + " · Lauf " + report.run;
  $("delete-error").textContent = "";
  deletionDialog.showModal();
}

deleteCancel.onclick = () => deletionDialog.close();
deletionDialog.addEventListener("cancel", (event) => {
  if (deleteConfirm.disabled) event.preventDefault();
});

deleteConfirm.onclick = async () => {
  const report = selectedReport;
  deleteCancel.disabled = deleteConfirm.disabled = true;
  deleteConfirm.textContent = "Wird gelöscht …";
  $("delete-error").textContent = "";
  try {
    const response = await fetch("/api/runs/" + encodeURIComponent(report.id), {
      method: "DELETE",
      headers: { "If-Match": `"${report.tree}"` },
      redirect: "error",
    });
    const result = await response.json();
    if (!response.ok) {
      $("delete-error").textContent = result.error || "Die Löschung konnte nicht bestätigt werden.";
      return;
    }
    deletionDialog.close();
    $("delete-notice").textContent = "Protokoll und zugehörige Dateien gelöscht.";
    await refresh();
    $("reports-title").focus();
  } catch {
    $("delete-error").textContent =
      "Die Löschung konnte nicht bestätigt werden. Prüfe deine Anmeldung und versuche es erneut.";
  } finally {
    deleteCancel.disabled = deleteConfirm.disabled = false;
    deleteConfirm.textContent = "Protokoll löschen";
  }
};

function jobTable(r, canDelete) {
  const detail = element("div", null, "detail"),
    scroll = element("div", null, "scroll");
  const table = element("table"),
    head = table.createTHead().insertRow();
  for (const label of ["Bereich", "Rsync-Code", "Daten", "Neu", "Geändert¹", "Gelöscht"])
    head.append(element("th", label));
  const body = table.createTBody();
  for (const [name, job] of Object.entries(r.jobs)) {
    const row = body.insertRow();
    const title = element("th", name);
    title.scope = "row";
    row.append(title);
    for (const value of [
      job.code ?? missing,
      bytes(job.bytes),
      ...["newFiles", "changed", "deleted"].map((k) => (job[k] == null ? missing : number(job[k]))),
    ])
      row.append(element("td", value));
  }
  scroll.append(table);
  detail.append(element("h3", "Rsync-Ergebnisse"), scroll);
  const foot = element("div", null, "details-foot"),
    link = element("a", "Protokoll öffnen");
  link.href = "/" + encodeURIComponent(r.id) + "/";
  foot.append(
    element(
      "span",
      typeName(r.type) +
        " · " +
        duration(r.seconds) +
        " · SSD frei: " +
        (r.freeGiB == null ? missing : r.freeGiB + " GiB"),
    ),
    link,
  );
  if (canDelete && r.tree) {
    const button = element("button", "Protokoll löschen", "delete-link");
    button.type = "button";
    button.onclick = () => confirmDeletion(r);
    foot.append(button);
  }
  detail.append(foot);
  return detail;
}

function drawReports(canDelete) {
  const container = $("runs");
  container.replaceChildren();
  $("matches").textContent = number(runs.length) + (runs.length === 1 ? " Protokoll" : " Protokolle");
  if (!runs.length) {
    container.append(element("p", "Keine passenden Backup-Protokolle gefunden.", "empty"));
    return;
  }
  const head = element("div", null, "head-row run-grid");
  for (const label of ["Start", "Typ", "Ergebnis", "Laufzeit", "Daten", ""])
    head.append(element("span", label));
  container.append(head);
  for (const r of runs) {
    const details = element("details"),
      row = element("summary", null, "run-grid");
    const stamp = element("span", null, "stamp");
    stamp.append(element("b", date(r.day)), element("small", time(r) + " · Lauf " + r.run));
    const chevron = element("span", "⌄", "chev");
    chevron.setAttribute("aria-hidden", "true");
    row.append(
      stamp,
      element("span", typeName(r.type), "type"),
      element("span", statusNames[r.status], "badge " + r.status),
      element("span", duration(r.seconds), "length"),
      element("span", bytes(r.bytes), "amount"),
      chevron,
    );
    details.append(row);
    details.addEventListener("toggle", () => {
      if (details.open && details.children.length === 1) details.append(jobTable(r, canDelete));
    });
    container.append(details);
  }
}

const initial = new URLSearchParams(location.search);
for (const key of keys) {
  if (key === "type" && initial.get(key))
    $("type").add(new Option(typeName(initial.get(key)), initial.get(key)));
  $(key).value = initial.get(key) || "";
}
async function refresh() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const params = new URLSearchParams();
  for (const key of keys) if ($(key).value.trim()) params.set(key, $(key).value.trim());
  const qs = params.toString() ? "?" + params : "";
  history.replaceState(null, "", location.pathname + qs + location.hash);
  $("content").hidden = true;
  $("latest").replaceChildren();
  if ($("from").value && $("to").value && $("from").value > $("to").value) {
    $("message").textContent = "Das Enddatum liegt vor dem Startdatum.";
    return;
  }
  $("message").textContent = "Berichte werden geladen …";
  try {
    let result;
    while (true) {
      const response = await fetch("/api/runs" + qs, { signal: controller.signal });
      if (!response.ok) throw new Error("API");
      result = await response.json();
      if (response.status !== 202) break;
      $("message").textContent = "Protokolle werden indiziert. Noch " + result.remaining + " Berichte …";
    }
    if (controller.signal.aborted) return;
    runs = result.runs;
    const choice = params.get("type") || "";
    $("type").replaceChildren(new Option("Alle Typen", ""));
    for (const type of new Set([...result.types, ...(choice ? [choice] : [])]))
      $("type").add(new Option(typeName(type), type));
    $("type").value = choice;
    drawMetrics();
    drawChart();
    drawChanges();
    drawReports(result.canDelete);
    const deletionMessages = {
      configuration:
        "Löschen ist noch nicht verfügbar. Im Worker fehlt die E-Mail-Adresse oder der GitHub-Token.",
      session: "Löschen ist erst nach einer persönlichen Anmeldung über Cloudflare Access verfügbar.",
      email:
        "Deine Cloudflare-Access-Adresse stimmt nicht mit der für das Löschen hinterlegten Adresse überein.",
      verification:
        "Cloudflare Access konnte die Löschberechtigung gerade nicht prüfen. Lade die Seite erneut.",
    };
    $("delete-availability").textContent = deletionMessages[result.deletionAccess] || "";
    $("message").textContent = "";
    $("content").hidden = false;
  } catch (error) {
    if (error.name === "AbortError") return;
    const retry = element("button", "Erneut laden");
    retry.onclick = refresh;
    $("message").replaceChildren("Die Berichte konnten nicht geladen werden. ", retry);
  }
}

$("filters").addEventListener("input", () => {
  request?.abort();
  clearTimeout(timer);
  timer = setTimeout(refresh, 220);
});
$("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(timer);
  refresh();
});
$("filters").addEventListener("reset", (event) => {
  event.preventDefault();
  clearTimeout(timer);
  for (const key of keys) $(key).value = "";
  refresh();
});
$("show-time").onclick = () => {
  metric = "seconds";
  drawChart();
};
$("show-bytes").onclick = () => {
  metric = "bytes";
  drawChart();
};
function markNav() {
  for (const link of document.querySelectorAll("nav a")) {
    if (link.hash === (location.hash || "#uebersicht")) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", markNav);
markNav();
refresh();
