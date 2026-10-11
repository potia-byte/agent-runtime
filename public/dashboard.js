const POLL_MS = 3000;
let currentFilter = "all";
let allTasks = [];

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      body?.error ? body.error : UI_RU.errors.requestFailed(res.status),
    );
  }
  return body;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(rawValue) {
  const cls = String(rawValue).toLowerCase();
  return `<span class="badge badge-${escapeHtml(cls)}">${escapeHtml(ru(rawValue))}</span>`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return UI_RU.common.dash;
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} мин ${s} сек`;
}

function card(label, valueHtml) {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${valueHtml}</div></div>`;
}

function renderStatus(status) {
  const L = UI_RU.statusCard;
  const dash = UI_RU.common.dash;
  document.getElementById("status-cards").innerHTML = [
    card(L.runtime, badge(status.runtime_status)),
    card(L.pid, escapeHtml(status.pid ?? dash)),
    card(L.started, escapeHtml(status.started_at ?? dash)),
    card(L.heartbeat, escapeHtml(status.updated_at)),
    card(
      L.currentTask,
      status.current_task
        ? `${escapeHtml(status.current_task.id)} (${escapeHtml(status.current_task.agent)})`
        : escapeHtml(UI_RU.common.none),
    ),
    card(L.workers, escapeHtml(status.worker_count)),
    card(L.lastSuccessfulTask, escapeHtml(status.last_successful_task ?? dash)),
    card(L.lastMessage, escapeHtml(status.last_message ?? dash)),
  ].join("");
}

function renderWorkers(workers) {
  const L = UI_RU.workers;
  const tbody = document.querySelector("#worker-table tbody");
  tbody.innerHTML = workers.length
    ? workers
        .map(
          (worker) => `
    <tr data-worker-row data-slot-id="${escapeHtml(worker.slot_id)}">
      <td>${escapeHtml(worker.slot_id)}</td>
      <td>${escapeHtml(worker.worker)}</td>
      <td>${escapeHtml(worker.task_id)}</td>
      <td>${escapeHtml(worker.pid ?? UI_RU.common.dash)}</td>
      <td>${badge(worker.status)}</td>
      <td>${badge(worker.liveness)}</td>
      <td>${escapeHtml(worker.heartbeat_at)}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="7">${escapeHtml(L.empty)}</td></tr>`;
}

function renderProviders(providers) {
  const L = UI_RU.provider;
  const dash = UI_RU.common.dash;
  document.getElementById("providers").innerHTML = providers
    .map(
      (provider) => `
    <div class="card">
      <div class="label">${escapeHtml(provider.name)}</div>
      <div class="value">${badge(provider.status)}</div>
      <div class="label">${escapeHtml(L.task)}: ${escapeHtml(provider.current_task_id ?? dash)}</div>
      <div class="label">${escapeHtml(L.quotaReset)}: ${escapeHtml(provider.cooldown_until ?? dash)}</div>
      <div class="label">${escapeHtml(L.reason)}: ${escapeHtml(provider.cooldown_reason ?? provider.unavailable_reason ?? dash)}</div>
    </div>`,
    )
    .join("");
}

function taskMatchesFilter(task, filter) {
  if (filter === "all") return true;
  if (filter === "active")
    return task.status === "in_progress" || task.status === "validating";
  if (filter === "queued")
    return task.status === "todo" || task.status === "ready";
  if (filter === "done") return task.status === "done";
  if (filter === "blocked") return task.status === "blocked";
  return true;
}

function renderTasks() {
  const tbody = document.querySelector("#task-table tbody");
  tbody.innerHTML = allTasks
    .filter((task) => taskMatchesFilter(task, currentFilter))
    .map(
      (task) => `
    <tr data-task-row data-task-id="${escapeHtml(task.id)}">
      <td>${escapeHtml(task.id)}</td>
      <td>${escapeHtml(task.title)}</td>
      <td>${escapeHtml(task.priority)}</td>
      <td>${badge(task.status)}</td>
      <td>${escapeHtml(task.agent)}</td>
      <td>${escapeHtml(task.started_at ?? UI_RU.common.dash)}</td>
      <td>${formatDuration(task.duration_ms)}</td>
      <td>${escapeHtml(task.attempts)}</td>
    </tr>`,
    )
    .join("");
}

function renderHistory(items) {
  document.getElementById("history").innerHTML = items.length
    ? items
        .map((item) => `<li>${escapeHtml(item.at)} — ${escapeHtml(item.message)}</li>`)
        .join("")
    : `<li>${escapeHtml(UI_RU.common.none)}</li>`;
}

function renderLog(lines) {
  document.getElementById("log").textContent = lines.join("\n");
}

function detailField(label, valueHtml) {
  return `<div class="detail-row"><span class="detail-label">${escapeHtml(label)}:</span> ${valueHtml}</div>`;
}

function renderTaskDetail(detail) {
  const L = UI_RU.taskDetail;
  const none = escapeHtml(UI_RU.common.none);
  const runs = detail.runs.length
    ? detail.runs
        .map(
          (run) =>
            `<li>${escapeHtml(run.id)} — ${escapeHtml(run.agent)}, ${escapeHtml(run.phase)}/${escapeHtml(run.status)}${run.result ? `: ${escapeHtml(run.result)}` : ""}</li>`,
        )
        .join("")
    : `<li>${none}</li>`;
  document.getElementById("task-detail").innerHTML = `
    ${detailField(L.id, escapeHtml(detail.id))}
    ${detailField(L.title, escapeHtml(detail.title))}
    ${detailField(L.description, escapeHtml(detail.description))}
    ${detailField(L.status, badge(detail.status))}
    ${detailField(L.priority, escapeHtml(detail.priority))}
    ${detailField(L.agent, escapeHtml(detail.recommended_agent))}
    ${detailField(L.dependsOn, detail.depends_on.length ? escapeHtml(detail.depends_on.join(", ")) : none)}
    ${detailField(L.attempts, escapeHtml(detail.attempts))}
    ${detailField(L.lastError, detail.last_error ? escapeHtml(detail.last_error) : none)}
    ${detailField(L.createdAt, escapeHtml(detail.created_at))}
    ${detailField(L.updatedAt, escapeHtml(detail.updated_at))}
    <div class="detail-row"><span class="detail-label">${escapeHtml(L.runs)}:</span></div>
    <ul>${runs}</ul>
  `;
}

async function showTaskDetail(taskId) {
  renderTaskDetail(await api(`/api/tasks/${encodeURIComponent(taskId)}`));
}

async function refresh() {
  const errorEl = document.getElementById("lifecycle-error");
  try {
    const [status, workers, providers, tasks, history, log] = await Promise.all([
      api("/api/status"),
      api("/api/workers"),
      api("/api/providers"),
      api("/api/tasks"),
      api("/api/history?limit=50"),
      api("/api/log?limit=50"),
    ]);
    renderStatus(status);
    renderWorkers(workers);
    renderProviders(providers);
    allTasks = tasks;
    renderTasks();
    renderHistory(history);
    renderLog(log);
    errorEl.textContent = "";
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

async function runLifecycleAction(action) {
  const endpoints = {
    start: "/api/lifecycle/start",
    stop: "/api/lifecycle/stop",
  };
  const errorEl = document.getElementById("lifecycle-error");
  errorEl.textContent = "";
  if (action === "stop") {
    const actionLabel = UI_RU.lifecycleActionLabel[action] ?? action;
    if (!window.confirm(UI_RU.errors.confirmAction(actionLabel))) return;
  }
  try {
    await api(endpoints[action], { method: "POST" });
    await refresh();
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

document.getElementById("task-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  currentFilter = button.dataset.filter;
  for (const el of document.querySelectorAll("#task-filters button")) {
    el.dataset.active = String(el === button);
  }
  renderTasks();
});

document
  .getElementById("lifecycle-buttons")
  .addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    runLifecycleAction(button.dataset.action);
  });

document
  .querySelector("#task-table tbody")
  .addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-task-row]");
    if (!row) return;
    showTaskDetail(row.dataset.taskId);
  });

refresh();
setInterval(refresh, POLL_MS);
