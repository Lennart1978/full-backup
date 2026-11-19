const REPOSITORY = "https://api.github.com/repos/Lennart1978/full-backup";
const REF = "/git/refs/heads/main";

async function github(token, path, method = "GET", body) {
  const response = await fetch(REPOSITORY + path, {
    method,
    redirect: "manual",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "full-backup-dashboard",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`GitHub ${method} fehlgeschlagen (${response.status})`), {
      status: response.status,
    });
  }
  return response.json();
}

async function readHead(token) {
  return (await github(token, REF)).object.sha;
}

export async function removeReportFolder(token, id, expectedTree) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await readHead(token);
    const commit = await github(token, "/git/commits/" + head);
    const root = await github(token, "/git/trees/" + commit.tree.sha);
    if (root.truncated) throw new Error("GitHub lieferte einen unvollständigen Verzeichnisbaum.");
    const entry = root.tree.find((item) => item.path === id);
    if (!entry) return true; // A retry may follow an already committed deletion.
    if (entry.type !== "tree" || entry.sha !== expectedTree) return false;

    const tree = await github(token, "/git/trees", "POST", {
      base_tree: commit.tree.sha,
      tree: [{ path: id, mode: "040000", type: "tree", sha: null }],
    });
    const next = await github(token, "/git/commits", "POST", {
      message: "Backup-Protokoll entfernen: " + id,
      tree: tree.sha,
      parents: [head],
    });
    try {
      await github(token, REF, "PATCH", { sha: next.sha, force: false });
      return true;
    } catch (error) {
      // A concurrent backup can advance main. Recheck the same folder on the new tip.
      if (![409, 422].includes(error.status) || (await readHead(token)) === head) throw error;
    }
  }
  throw new Error("GitHub-Branch wurde gleichzeitig mehrfach geändert.");
}
