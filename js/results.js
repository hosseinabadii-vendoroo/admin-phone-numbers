export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function badgeClass(status) {
  const key = String(status || "").toLowerCase().replaceAll("-", "_");

  return `badge badge-${key}`;
}

export function classifyStatus(status) {
  const s = String(status || "").toLowerCase();

  if (s === "error") return "err";
  if (s === "skipped") return "skip";

  return "ok";
}

export function renderResults(els, payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  els.rawJson.textContent = JSON.stringify(payload, null, 2);
  els.rawBlock.hidden = false;

  if (!results.length) {
    els.emptyState.hidden = false;
    els.emptyState.textContent = "Request succeeded but returned no results.";
    els.resultsTable.hidden = true;
    els.stats.innerHTML = "";

    return;
  }

  els.emptyState.hidden = true;
  els.resultsTable.hidden = false;

  let ok = 0;
  let err = 0;
  let skip = 0;

  for (const row of results) {
    const bucket = classifyStatus(row.status);

    if (bucket === "err") err += 1;
    else if (bucket === "skip") skip += 1;
    else ok += 1;
  }

  const action = payload.action ? escapeHtml(payload.action) : "batch";
  const provider = payload.provider ? ` · ${escapeHtml(payload.provider)}` : "";
  els.stats.innerHTML = `
        <span class="stat">${action}${provider}</span>
        <span class="stat ok">${ok} ok</span>
        <span class="stat skip">${skip} skipped</span>
        <span class="stat err">${err} error</span>
      `;

  els.resultsBody.innerHTML = results.map((row) => {
    const elImported = row.elevenlabs_imported === true
      ? "yes"
      : row.elevenlabs_imported === false
        ? "no"
        : "—";

    return `
          <tr>
            <td class="mono">${escapeHtml(row.client_id ?? "—")}</td>
            <td class="mono">${escapeHtml(row.phone_number ?? "—")}</td>
            <td><span class="${badgeClass(row.status)}">${escapeHtml(row.status ?? "—")}</span></td>
            <td class="muted">${escapeHtml(row.reason ?? "—")}</td>
            <td class="mono">${escapeHtml(elImported)}</td>
            <td class="url-cell" title="${escapeHtml(row.voice_url ?? "")}">${escapeHtml(row.voice_url ?? "—")}</td>
            <td class="url-cell" title="${escapeHtml(row.sms_url ?? "")}">${escapeHtml(row.sms_url ?? "—")}</td>
          </tr>
        `;
  }).join("");
}
