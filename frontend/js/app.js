const API = "/api";
let token = localStorage.getItem("trace_token");
let currentUser = null;
let socket = null;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function headers() {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function api(url, options = {}) {
  const response = await fetch(API + url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3200);
}
function showAuth() { $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden"); }
function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  const isStaff = currentUser &&
    ["admin", "technician"].includes(currentUser.role);

  // Hide staff-only navigation for customers
  $$('[data-page="dashboard"], [data-page="incidents"], [data-page="analytics"]')
    .forEach(button => {
      button.classList.toggle("hidden", !isStaff);
    });

  if (isStaff) {
    go("dashboard");
  } else {
    go("reports");
  }
}

// ===============================
// NOTIFICATION SYSTEM
// ===============================

async function loadNotifications() {
  try {
    const data = await api("/notifications");

    const count = $("#notificationCount");
    const list = $("#notificationList");

    count.textContent = data.unread;

    count.classList.toggle("hidden", data.unread === 0);

    list.innerHTML = data.notifications.length
      ? data.notifications.map(n => `
          <div class="notification-item ${n.is_read ? "" : "unread"}">
            <strong>${esc(n.title)}</strong>
            <p>${esc(n.message)}</p>
            <small>${dateText(n.created_at)}</small>
            ${!n.is_read ? `
              <button class="text-btn mark-read" data-id="${n.id}">
                Mark as read
              </button>
            ` : ""}
          </div>
        `).join("")
      : '<p class="empty">No notifications yet.</p>';

    $$(".mark-read").forEach(button => {
      button.addEventListener("click", async () => {
        await api(`/notifications/${button.dataset.id}/read`, {
          method: "PATCH"
        });
        await loadNotifications();
      });
    });

  } catch (err) {
    console.error("Notification error:", err);
  }
}


// OPEN AND CLOSE NOTIFICATION PANEL

$("#notificationBell").addEventListener("click", () => {
  $("#notificationPanel").classList.toggle("hidden");
  loadNotifications();
});


// MARK ALL NOTIFICATIONS AS READ

$("#markAllRead").addEventListener("click", async () => {
  try {
    await api("/notifications/read-all", {
      method: "PATCH"
    });

    await loadNotifications();
  } catch (err) {
    toast(err.message);
  }
});

$$("[data-auth-tab]").forEach(btn => btn.addEventListener("click", () => {
  $$("[data-auth-tab]").forEach(b => b.classList.toggle("active", b === btn));
  $("#loginForm").classList.toggle("hidden", btn.dataset.authTab !== "login");
  $("#registerForm").classList.toggle("hidden", btn.dataset.authTab !== "register");
  $("#authMessage").textContent = "";
}));

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try { const data = await api("/auth/login", { method: "POST", body: JSON.stringify(form) }); token = data.token; localStorage.setItem("trace_token", token); await boot(); }
  catch (err) { $("#authMessage").textContent = err.message; }
});
$("#registerForm").addEventListener("submit", async e => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try { const data = await api("/auth/register", { method: "POST", body: JSON.stringify(form) }); token = data.token; localStorage.setItem("trace_token", token); await boot(); }
  catch (err) { $("#authMessage").textContent = err.message; }
});
$("#logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("trace_token"); token = null;
  if (socket) socket.disconnect();
  showAuth();
});

function go(page) {
    const isStaff = currentUser &&
    ["admin", "technician"].includes(currentUser.role);

  if (!isStaff && ["dashboard", "incidents", "analytics"].includes(page)) {
    page = "reports";
  }
  $$(".page").forEach(p => p.classList.add("hidden"));
  $(`#page-${page}`).classList.remove("hidden");
  $$(".nav-item[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  const titles = { dashboard: ["OVERVIEW", "Dashboard"], reports: ["WORKSPACE", "Reports"], incidents: ["INTELLIGENCE", "Incidents"], analytics: ["INSIGHTS", "Analytics"] };
  $("#pageEyebrow").textContent = titles[page][0]; $("#pageTitle").textContent = titles[page][1];
  if (page === "reports") loadReports();
  if (page === "incidents") loadIncidents();
  if (page === "analytics") loadAnalytics();
}
$$("[data-page]").forEach(b => b.addEventListener("click", () => go(b.dataset.page)));
$$("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));

function openReportDialog() { $("#reportDialog").showModal(); }
$("#quickReport").addEventListener("click", openReportDialog);
$("#newReportBtn").addEventListener("click", openReportDialog);
$("#closeDialog").addEventListener("click", () => $("#reportDialog").close());
$("#cancelDialog").addEventListener("click", () => $("#reportDialog").close());

$("#reportForm").addEventListener("submit", async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await api("/reports", { method: "POST", body: JSON.stringify(data) });
    $("#reportDialog").close(); e.target.reset(); toast("Report submitted. TRACE is analyzing it.");
    await loadDashboard(); await loadReports();
  } catch (err) { toast(err.message); }
});

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function severityTag(s) { return `<span class="tag ${String(s).toLowerCase()}">${esc(s)}</span>`; }
function dateText(d) { return new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }

async function loadDashboard() {
  const d = await api("/dashboard");
  $("#statReports").textContent = d.totalReports;
  $("#statIncidents").textContent = d.activeIncidents;
  $("#statHigh").textContent = d.highPriority;
  $("#statResolved").textContent = d.resolved;
  $("#recentReports").innerHTML = d.recent.length ? d.recent.map(r => `
    <div class="report-row"><i class="report-dot"></i><div><strong>${esc(r.title)}</strong><small>${esc(r.location)} · ${esc(r.reporter)}</small></div><div class="right">${severityTag(r.severity)}<small>${dateText(r.created_at)}</small></div></div>`).join("") : '<p class="empty">No reports yet. Submit the first one.</p>';
  $("#categoryBars").innerHTML = d.byCategory.length ? d.byCategory.map(c => `
    <div><div class="bar-head"><span>${esc(c.category)}</span><strong>${c.count}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, c.count / Math.max(...d.byCategory.map(x=>x.count)) * 100)}%"></div></div></div>`).join("") : '<p class="empty">Category data will appear here.</p>';
  $("#todayLabel").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

let cachedReports = [];
async function loadReports() {
  const d = await api("/reports"); cachedReports = d.reports; renderReports();
}
function renderReports() {
  const search = ($("#reportSearch")?.value || "").toLowerCase();
  const category = $("#reportFilter")?.value || "";
  const rows = cachedReports.filter(r => (!category || r.category === category) &&
    `${r.title} ${r.description} ${r.location}`.toLowerCase().includes(search));
  $("#reportsTable").innerHTML = rows.length ? rows.map(r => `<tr>
    <td>${esc(r.title)}<br><small class="muted">#${r.id} · ${dateText(r.created_at)}</small></td>
    <td>${esc(r.category)}</td><td>${esc(r.location)}</td><td>${severityTag(r.severity)}</td>
    <td><span class="tag">${esc(r.incident_status || r.status)}</span></td><td>${esc(r.reporter)}</td></tr>`).join("") :
    '<tr><td colspan="6" class="empty">No matching reports.</td></tr>';
}
$("#reportSearch").addEventListener("input", renderReports);
$("#reportFilter").addEventListener("change", renderReports);

async function loadIncidents() {
  const d = await api("/incidents");
  $("#incidentGrid").innerHTML = d.incidents.length ? d.incidents.map(i => `
    <article class="incident-card" data-incident="${i.id}">
      <div class="incident-meta"><span class="tag">${esc(i.category)}</span><span class="priority-number">${Number(i.priority).toFixed(1)}<small class="muted"> /100</small></span></div>
      <h4>${esc(i.title)}</h4><p>${esc(i.summary || "Reports are being analyzed. Review the connected reports to investigate.")}</p>
      <div class="incident-foot"><span>${esc(i.location)}</span><span>${i.report_count} linked report(s)</span><span class="tag">${esc(i.status)}</span></div>
    </article>`).join("") : '<div class="panel empty">No incidents yet. Submit a report to get started.</div>';
  $$(".incident-card").forEach(card => card.addEventListener("click", () => showIncident(card.dataset.incident)));
}
$("#refreshIncidents").addEventListener("click", loadIncidents);



async function showIncident(id) {
  try {
    const [d, records, technicianData] = await Promise.all([
      api(`/incidents/${id}`),
      api(`/incidents/${id}/investigation-records`),
      api("/technicians")
    ]);

    const inspections = records.inspections || [];
    const tests = records.connectivityTests || [];
    const verifications = records.verifications || [];
    const actions = d.actions || [];
    const technicians = technicianData.technicians || [];

    const technicianOptions = (selectedId) => `
      <option value="">Unassigned</option>
      ${technicians.map(t => `
        <option value="${t.id}"
          ${Number(selectedId) === Number(t.id) ? "selected" : ""}>
          ${esc(t.name)} (${esc(t.role)})
        </option>
      `).join("")}
    `;

    const priorityOptions = (selected) => `
      <option value="Low" ${selected === "Low" ? "selected" : ""}>Low</option>
      <option value="Medium" ${selected === "Medium" ? "selected" : ""}>Medium</option>
      <option value="High" ${selected === "High" ? "selected" : ""}>High</option>
    `;

    const statusOptions = (selected) => `
      <option value="Pending" ${selected === "Pending" ? "selected" : ""}>Pending</option>
      <option value="In Progress" ${selected === "In Progress" ? "selected" : ""}>In Progress</option>
      <option value="Completed" ${selected === "Completed" ? "selected" : ""}>Completed</option>
    `;

    $("#incidentDetail").innerHTML = `
      <div class="detail-head">
        <div>
          <p class="eyebrow">INCIDENT #${d.incident.id}</p>
          <h2>${esc(d.incident.title)}</h2>
          <p class="muted">
            ${esc(d.incident.location)} ·
            ${esc(d.incident.category)}
          </p>
        </div>
        <button class="icon-btn" id="closeIncident">✕</button>
      </div>

      <div class="detail-section">
        <h4>Priority score</h4>
        <div class="priority-number">
          ${Number(d.incident.priority).toFixed(1)} / 100
        </div>
        <p>Status: <span class="tag">${esc(d.incident.status)}</span></p>
      </div>

      <div class="detail-section">
        <h4>Connected reports (${d.reports.length})</h4>

        ${d.reports.map(r => `
          <p>
            <strong>${esc(r.title)}</strong><br>
            ${esc(r.description)}<br>
            <small class="muted">
              ${esc(r.location)} ·
              Similarity: ${Number(r.similarity).toFixed(2)}
            </small>
          </p>
        `).join("") || "<p>No reports linked.</p>"}
      </div>

      <div class="detail-section">
        <h4>AI investigation</h4>

        <div id="investigationText">
          <p>${esc(d.incident.summary || "No investigation generated yet.")}</p>
        </div>

        <button class="primary" id="runInvestigation">
          Generate investigation
        </button>
      </div>

      <div class="detail-section">
        <h3>Technical Investigation Workspace</h3>
        <p class="muted">
          Record physical inspections, compare network connectivity
          and document technical findings.
        </p>

        <form id="inspectionForm">
          <h4>1. Access Point & Laboratory Inspection</h4>

          <label>Inspection type
            <select name="inspection_type" required>
              <option value="Access Point">Access Point</option>
              <option value="Network">Network</option>
              <option value="General">General</option>
            </select>
          </label>

          <label>Access point condition
            <select name="access_point_status">
              <option value="Operational">Operational</option>
              <option value="Unstable">Unstable</option>
              <option value="Offline">Offline</option>
              <option value="Not Checked">Not Checked</option>
            </select>
          </label>

          <label>Local laboratory connectivity
            <select name="local_connectivity">
              <option value="Working">Working</option>
              <option value="Intermittent">Intermittent</option>
              <option value="Unavailable">Unavailable</option>
              <option value="Not Tested">Not Tested</option>
            </select>
          </label>

          <label>Upstream network status
            <select name="upstream_status">
              <option value="Working">Working</option>
              <option value="Intermittent">Intermittent</option>
              <option value="Unavailable">Unavailable</option>
              <option value="Not Tested">Not Tested</option>
            </select>
          </label>

          <label>Inspection findings
            <textarea name="findings" required maxlength="3000"
              placeholder="Describe the inspection observations..."></textarea>
          </label>

          <label>Corrective action taken
            <textarea name="corrective_action" maxlength="2000"
              placeholder="Describe any corrective action..."></textarea>
          </label>

          <button class="primary" type="submit">
            Save inspection findings
          </button>
        </form>
      </div>

      <div class="detail-section">
        <h4>2. Block Connectivity Comparison</h4>

        <form id="connectivityForm">
          <label>University block
            <input name="block_name" required placeholder="e.g. Block A">
          </label>

          <label>Laboratory / Room
            <input name="laboratory" placeholder="e.g. Lab 3">
          </label>

          <label>Connectivity test type
            <select name="test_type" required>
              <option value="Local">Local network</option>
              <option value="Upstream">Upstream network</option>
            </select>
          </label>

          <label>Test target / service
            <input name="target"
              placeholder="e.g. Campus gateway or college portal">
          </label>

          <label>Test result
            <select name="result" required>
              <option value="Success">Successful</option>
              <option value="Failure">Failed</option>
              <option value="Not Tested">Not tested</option>
            </select>
          </label>

          <label>Response time (milliseconds)
            <input name="response_time_ms" type="number"
              min="0" step="0.1" placeholder="e.g. 45">
          </label>

          <label>Additional observations
            <textarea name="notes"
              placeholder="Enter connectivity observations..."></textarea>
          </label>

          <button class="primary" type="submit">
            Record connectivity result
          </button>
        </form>

        <div id="connectivityComparison"></div>
      </div>

      <div class="detail-section">
        <h4>3. Inspection History</h4>

        <div id="inspectionHistory">
          ${inspections.length
            ? inspections.map(item => `
              <div class="history-item">
                <strong>${esc(item.inspection_type)}</strong>
                <p>Technician: ${esc(item.technician)}</p>
                <p>Access point: ${esc(item.access_point_status)}</p>
                <p>Local connectivity: ${esc(item.local_connectivity)}</p>
                <p>Upstream: ${esc(item.upstream_status)}</p>
                <p>${esc(item.findings)}</p>
                <small class="muted">${dateText(item.created_at)}</small>
              </div>
            `).join("")
            : '<p class="empty">No inspections recorded yet.</p>'
          }
        </div>
      </div>

      <div class="detail-section">
        <h4>4. Resolution Verification</h4>

        <p class="muted">
          Record a final connectivity test result before
          confirming whether the incident is resolved.
        </p>

        <form id="verificationForm">
          <label>Verification result
            <select name="test_result" required>
              <option value="Pass">Passed — Issue resolved</option>
              <option value="Fail">Failed — Issue persists</option>
            </select>
          </label>

          <label>Verification findings
            <textarea name="findings" required
              placeholder="Describe the final verification observations..."></textarea>
          </label>

          <button class="primary" type="submit">
            Submit verification
          </button>
        </form>

        <div id="verificationHistory">
          ${verifications.length
            ? verifications.map(v => `
              <div class="history-item">
                <strong>Verification: ${esc(v.test_result)}</strong>
                <p>${esc(v.findings)}</p>
                <small>
                  ${esc(v.technician)} · ${dateText(v.verified_at)}
                </small>
              </div>
            `).join("")
            : '<p class="empty">No verification history yet.</p>'
          }
        </div>
      </div>

      <div class="detail-section">
        <h3>5. Advanced Corrective Action Tracking</h3>

        <p class="muted">
          Create corrective tasks, assign responsibility, set priorities
          and deadlines, and track their completion.
        </p>

        <form id="actionForm">
          <label>Action description
            <textarea name="description" required maxlength="2000"
              placeholder="Describe the corrective action to be performed..."></textarea>
          </label>

          <label>Assign to
            <select name="assigned_to">
              ${technicianOptions(null)}
            </select>
          </label>

          <label>Priority
            <select name="priority" required>
              ${priorityOptions("Medium")}
            </select>
          </label>

          <label>Due date
            <input type="date" name="due_date">
          </label>

          <button class="primary" type="submit">
            + Create corrective action
          </button>
        </form>

        <div class="action-summary">
          <h4>Action Overview</h4>
          <p>Total actions: ${actions.length}</p>
          <p>Pending: ${actions.filter(a => a.status === "Pending").length}</p>
          <p>In progress: ${actions.filter(a => a.status === "In Progress").length}</p>
          <p>Completed: ${actions.filter(a => a.status === "Completed").length}</p>
        </div>

        <h4>Corrective Action History</h4>

        <div id="actionsList">
          ${actions.length
            ? actions.map(a => `
              <div class="history-item action-card">
                <h4>Action #${a.id}</h4>

                <p><strong>${esc(a.description)}</strong></p>

                <p>
                  Assigned to:
                  ${esc(a.assigned_name || "Unassigned")}
                </p>

                <p>
                  Priority:
                  <span class="tag">${esc(a.priority || "Medium")}</span>
                </p>

                <p>
                  Status:
                  <span class="tag">${esc(a.status)}</span>
                </p>

                <p>
                  Due date: ${a.due_date ? esc(a.due_date) : "Not set"}
                </p>

                <p>
                  Created: ${dateText(a.created_at)}
                </p>

                ${a.completed_at ? `
                  <p>Completed: ${dateText(a.completed_at)}</p>
                ` : ""}

                ${a.completion_notes ? `
                  <p>
                    <strong>Completion notes:</strong>
                    ${esc(a.completion_notes)}
                  </p> 
                ` : ""}

                <form class="action-edit-form" data-action-id="${a.id}">
                  <label>Update description
                    <textarea name="description" required>${esc(a.description)}</textarea>
                  </label>

                  <label>Assigned to
                    <select name="assigned_to">
                      ${technicianOptions(a.assigned_to)}
                    </select>
                  </label>

                  <label>Priority
                    <select name="priority">
                      ${priorityOptions(a.priority || "Medium")}
                    </select>
                  </label>

                  <label>Due date
                    <input type="date" name="due_date"
                      value="${a.due_date ? esc(a.due_date) : ""}">
                  </label>

                  <label>Status
                    <select name="status">
                      ${statusOptions(a.status)}
                    </select>
                  </label>

                  <label>Completion notes
                    <textarea name="completion_notes"
                      placeholder="Record work completed or progress...">${esc(a.completion_notes || "")}</textarea>
                  </label>

                  <button class="primary" type="submit">
                    Save action updates
                  </button>
                </form>
              </div>
            `).join("")
            : '<p class="empty">No corrective actions recorded yet.</p>'
          }
        </div>
      </div>
    `;

    const dialog = $("#incidentDialog");

    if (!dialog.open) {
      dialog.showModal();
    }

    // CLOSE INCIDENT DETAILS

    $("#closeIncident").addEventListener("click", () => {
      dialog.close();
    });

    // GENERATE AI INVESTIGATION

    $("#runInvestigation").addEventListener("click", async () => {
      try {
        const result = await api(
          `/incidents/${id}/investigate`,
          {
            method: "POST",
            body: "{}"
          }
        );

        $("#investigationText").innerHTML = `
          <p>${esc(result.summary)}</p>

          <h4>Suggested actions</h4>

          <ul>
            ${result.suggestedActions.map(action =>
              `<li>${esc(action)}</li>`
            ).join("")}
          </ul>

          <h4>Recurring patterns</h4>

          <p>
            ${esc(result.patternAnalysis?.pattern || "No pattern available.")}
          </p>

          <p>
            Reports: ${result.patternAnalysis?.totalReports ?? 0}
          </p>

          <p>
            Distinct dates: ${result.patternAnalysis?.distinctDates ?? 0}
          </p>

          <small class="muted">${esc(result.confidence)}</small>
        `;

        toast("Investigation generated.");
      } catch (err) {
        toast(err.message);
      }
    });

    // SAVE TECHNICAL INSPECTION

    $("#inspectionForm").addEventListener("submit", async e => {
      e.preventDefault();

      const form = Object.fromEntries(new FormData(e.target));

      try {
        await api(`/incidents/${id}/inspections`, {
          method: "POST",
          body: JSON.stringify(form)
        });

        toast("Inspection findings saved.");
        await showIncident(id);
      } catch (err) {
        toast(err.message);
      }
    });

    // SAVE CONNECTIVITY TEST

    $("#connectivityForm").addEventListener("submit", async e => {
      e.preventDefault();

      const form = Object.fromEntries(new FormData(e.target));

      if (form.response_time_ms === "") {
        form.response_time_ms = null;
      } else if (form.response_time_ms !== null) {
        form.response_time_ms = Number(form.response_time_ms);
      }

      try {
        await api(`/incidents/${id}/connectivity-tests`, {
          method: "POST",
          body: JSON.stringify(form)
        });

        toast("Connectivity result recorded.");
        await showIncident(id);
      } catch (err) {
        toast(err.message);
      }
    });

    // DISPLAY CONNECTIVITY COMPARISON

    const comparison = {};

    tests.forEach(test => {
      const key = test.block_name;

      if (!comparison[key]) {
        comparison[key] = {
          total: 0,
          success: 0,
          failure: 0
        };
      }

      comparison[key].total++;

      if (test.result === "Success") {
        comparison[key].success++;
      }

      if (test.result === "Failure") {
        comparison[key].failure++;
      }
    });

    $("#connectivityComparison").innerHTML =
      Object.entries(comparison).length
        ? `
          <h4>Block-wise results</h4>
          ${Object.entries(comparison).map(([block, data]) => `
            <div class="history-item">
              <strong>${esc(block)}</strong>
              <p>Total tests: ${data.total}</p>
              <p>Successful: ${data.success}</p>
              <p>Failed: ${data.failure}</p>
            </div>
          `).join("")}
        `
        : '<p class="empty">No connectivity tests recorded yet.</p>';

    // SAVE RESOLUTION VERIFICATION

    $("#verificationForm").addEventListener("submit", async e => {
      e.preventDefault();

      const form = Object.fromEntries(new FormData(e.target));

      try {
        const result = await api(
          `/incidents/${id}/verify-resolution`,
          {
            method: "POST",
            body: JSON.stringify(form)
          }
        );

        toast(result.message);

        await loadIncidents();
        await loadDashboard();
        await showIncident(id);
      } catch (err) {
        toast(err.message);
      }
    });

    // CREATE CORRECTIVE ACTION

    $("#actionForm").addEventListener("submit", async e => {
      e.preventDefault();

      const form = Object.fromEntries(new FormData(e.target));

      if (form.assigned_to === "") {
        form.assigned_to = null;
      } else {
        form.assigned_to = Number(form.assigned_to);
      }

      if (form.due_date === "") {
        form.due_date = null;
      }

      try {
        await api(`/incidents/${id}/actions`, {
          method: "POST",
          body: JSON.stringify(form)
        });

        toast("Corrective action created successfully.");

        await showIncident(id);
      } catch (err) {
        toast(err.message);
      }
    });

    // UPDATE EXISTING CORRECTIVE ACTION

    document.querySelectorAll(".action-edit-form").forEach(formElement => {
      formElement.addEventListener("submit", async e => {
        e.preventDefault();

        const actionId = formElement.dataset.actionId;
        const form = Object.fromEntries(new FormData(formElement));

        if (form.assigned_to === "") {
          form.assigned_to = null;
        } else {
          form.assigned_to = Number(form.assigned_to);
        }

        if (form.due_date === "") {
          form.due_date = null;
        }

        try {
          await api(`/actions/${actionId}`, {
            method: "PATCH",
            body: JSON.stringify(form)
          });

          toast("Corrective action updated successfully.");

          await showIncident(id);
        } catch (err) {
          toast(err.message);
        }
      });
    });

  } catch (err) {
    toast(err.message);
  }
}


async function loadAnalytics() {
  try {
    const d = await api("/analytics");

    // EXISTING REPORT CATEGORY ANALYTICS

    const max = Math.max(1, ...d.categories.map(x => x.count));

    $("#analyticsCategories").innerHTML =
      d.categories.map(c => `
        <div>
          <div class="bar-head">
            <span>${esc(c.category)}</span>
            <strong>${c.count}</strong>
          </div>
          <div class="bar-track">
            <div class="bar-fill"
              style="width:${c.count / max * 100}%">
            </div>
          </div>
        </div>
      `).join("") || '<p class="empty">No data yet.</p>';

    // EXISTING INCIDENT STATUS ANALYTICS

    const statusMax = Math.max(
      1,
      ...d.statuses.map(x => x.count)
    );

    $("#analyticsStatuses").innerHTML =
      d.statuses.map(s => `
        <div>
          <div class="bar-head">
            <span>${esc(s.status)}</span>
            <strong>${s.count}</strong>
          </div>
          <div class="bar-track">
            <div class="bar-fill"
              style="width:${s.count / statusMax * 100}%">
            </div>
          </div>
        </div>
      `).join("") || '<p class="empty">No incidents yet.</p>';

    // CORRECTIVE ACTION INTELLIGENCE

    const a = d.correctiveActions || {};

    const total = Number(a.total || 0);
    const pending = Number(a.pending || 0);
    const inProgress = Number(a.inProgress || 0);
    const completed = Number(a.completed || 0);
    const overdue = Number(a.overdue || 0);
    const completionRate = Number(a.completionRate || 0);

    const priorities = a.priorities || [];
    const incidents = a.byIncident || [];

    // CREATE THE NEW ANALYTICS SECTION

    let section = $("#actionAnalytics");

    if (!section) {
      section = document.createElement("div");
      section.id = "actionAnalytics";
      section.className = "analytics-action-section";
      $("#page-analytics").appendChild(section);
    }

    const priorityMax = Math.max(
      1,
      ...priorities.map(p => Number(p.count))
    );

    section.innerHTML = `
      <div class="panel" style="margin-top:24px">

        <div class="detail-head">
          <div>
            <p class="eyebrow">TRACE INTELLIGENCE</p>
            <h3>Corrective Action Intelligence</h3>
            <p class="muted">
              Monitor task progress, deadlines and operational performance.
            </p>
          </div>
        </div>

        <div style="
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
          gap:14px;
          margin-top:20px;
        ">

          <div class="history-item">
            <small class="muted">Total Actions</small>
            <h2>${total}</h2>
          </div>

          <div class="history-item">
            <small class="muted">Pending</small>
            <h2>${pending}</h2>
          </div>

          <div class="history-item">
            <small class="muted">In Progress</small>
            <h2>${inProgress}</h2>
          </div>

          <div class="history-item">
            <small class="muted">Completed</small>
            <h2>${completed}</h2>
          </div>

          <div class="history-item">
            <small class="muted">Overdue</small>
            <h2>${overdue}</h2>
          </div>

          <div class="history-item">
            <small class="muted">Completion Rate</small>
            <h2>${completionRate}%</h2>
          </div>

        </div>

        <div style="margin-top:25px">
          <div class="bar-head">
            <strong>Overall completion progress</strong>
            <strong>${completionRate}%</strong>
          </div>

          <div class="bar-track">
            <div class="bar-fill"
              style="width:${Math.min(100, Math.max(0, completionRate))}%">
            </div>
          </div>
        </div>

        <div style="margin-top:30px">
          <h3>Priority Distribution</h3>
          <p class="muted">
            Corrective actions grouped by assigned priority.
          </p>

          ${
            priorities.length
              ? priorities.map(p => `
                <div style="margin-bottom:14px">
                  <div class="bar-head">
                    <span>${esc(p.priority || "Unspecified")}</span>
                    <strong>${Number(p.count)}</strong>
                  </div>

                  <div class="bar-track">
                    <div class="bar-fill"
                      style="width:${Number(p.count) / priorityMax * 100}%">
                    </div>
                  </div>
                </div>
              `).join("")
              : '<p class="empty">No priority data available.</p>'
          }
        </div>

        <div style="margin-top:30px">
          <h3>Incident-wise Action Performance</h3>
          <p class="muted">
            Compare corrective-action progress across incidents.
          </p>

          ${
            incidents.length
              ? incidents.map(i => `
                <div class="history-item" style="margin-bottom:14px">

                  <strong>
                    Incident #${i.incident_id} —
                    ${esc(i.incident_title)}
                  </strong>

                  <p class="muted">
                    Incident status: ${esc(i.incident_status)}
                  </p>

                  <div style="
                    display:grid;
                    grid-template-columns:repeat(auto-fit,minmax(100px,1fr));
                    gap:10px;
                  ">
                    <p>Total: <strong>${Number(i.total_actions)}</strong></p>
                    <p>Pending: <strong>${Number(i.pending || 0)}</strong></p>
                    <p>In Progress: <strong>${Number(i.in_progress || 0)}</strong></p>
                    <p>Completed: <strong>${Number(i.completed || 0)}</strong></p>
                    <p>Overdue: <strong>${Number(i.overdue || 0)}</strong></p>
                  </div>

                </div>
              `).join("")
              : '<p class="empty">No incident corrective actions recorded yet.</p>'
          }
        </div>

      </div>
    `;
    await loadSLA();

  } catch (err) {
    toast("Analytics error: " + err.message);
    console.error(err);
  }
}

async function loadSLA() {
  try {
    const d = await api("/sla");

    let section = $("#slaMonitoring");

    if (!section) {
      section = document.createElement("div");
      section.id = "slaMonitoring";
      section.className = "panel";
      section.style.marginTop = "24px";

      $("#page-analytics").appendChild(section);
    }

    const dueSoon = d.dueSoon || [];
    const overdue = d.overdueActions || [];
    const escalated = d.escalated || [];
    const compliance = d.compliance || {};

    section.innerHTML = `
      <div>
        <p class="eyebrow">OPERATIONAL MONITORING</p>
        <h3>SLA & Deadline Monitoring</h3>
        <p class="muted">
          Monitor approaching deadlines, overdue tasks
          and on-time completion performance.
        </p>
      </div>

      <div style="
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
        gap:14px;
        margin-top:20px;
      ">

        <div class="history-item">
          <small class="muted">Due Soon</small>
          <h2>${dueSoon.length}</h2>
        </div>

        <div class="history-item">
          <small class="muted">Overdue</small>
          <h2>${overdue.length}</h2>
        </div>

        <div class="history-item">
          <small class="muted">High-Priority Overdue</small>
          <h2>${escalated.length}</h2>
        </div>

        <div class="history-item">
          <small class="muted">SLA Compliance</small>
          <h2>${Number(compliance.rate || 0)}%</h2>
        </div>

      </div>

      <div style="margin-top:28px">
        <h4>Overdue Actions</h4>

        ${
          overdue.length
            ? overdue.map(a => `
              <div class="history-item" style="margin-bottom:12px">
                <strong>${esc(a.description)}</strong>

                <p>Incident: ${esc(a.incident_title)}</p>
                <p>Assigned to: ${esc(a.assigned_name || "Unassigned")}</p>
                <p>Priority: ${esc(a.priority)}</p>
                <p>Due date: ${esc(a.due_date)}</p>
                <p>Status: ${esc(a.status)}</p>
              </div>
            `).join("")
            : '<p class="empty">No overdue actions.</p>'
        }
      </div>

      <div style="margin-top:28px">
        <h4>Actions Due Within 3 Days</h4>

        ${
          dueSoon.length
            ? dueSoon.map(a => `
              <div class="history-item" style="margin-bottom:12px">
                <strong>${esc(a.description)}</strong>

                <p>Incident: ${esc(a.incident_title)}</p>
                <p>Assigned to: ${esc(a.assigned_name || "Unassigned")}</p>
                <p>Priority: ${esc(a.priority)}</p>
                <p>Due date: ${esc(a.due_date)}</p>
                <p>Status: ${esc(a.status)}</p>
              </div>
            `).join("")
            : '<p class="empty">No upcoming deadlines within 3 days.</p>'
        }
      </div>

      <div style="margin-top:28px">
        <h4>Escalation Watch</h4>

        ${
          escalated.length
            ? escalated.map(a => `
              <div class="history-item" style="margin-bottom:12px">
                <strong>${esc(a.description)}</strong>
                <p>Incident: ${esc(a.incident_title)}</p>
                <p>Assigned to: ${esc(a.assigned_name || "Unassigned")}</p>
                <p>Due date: ${esc(a.due_date)}</p>
                <p>Status: ${esc(a.status)}</p>
                <p class="muted">
                  High-priority overdue action requires attention.
                </p>
              </div>
            `).join("")
            : '<p class="empty">No high-priority overdue actions.</p>'
        }
      </div>

      <div style="margin-top:28px">
        <h4>SLA Performance</h4>

        <p>Tracked completed actions: ${Number(compliance.tracked || 0)}</p>

        <p>Completed on time: ${Number(compliance.completedOnTime || 0)}</p>

        <div class="bar-track">
          <div class="bar-fill"
            style="width:${Math.min(100, Math.max(0, Number(compliance.rate || 0)))}%">
          </div>
        </div>

        <div class="bar-head">
          <span>On-time completion</span>
          <strong>${Number(compliance.rate || 0)}%</strong>
        </div>
      </div>
    `;

  } catch (err) {
    toast("SLA monitoring error: " + err.message);
    console.error(err);
  }
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on("report:new", data => { toast(`New report submitted: ${data.title}`); loadDashboard(); if (!$("#page-reports").classList.contains("hidden")) loadReports(); });
  socket.on("report:processed", data => { toast(`Report #${data.reportId} analyzed and linked.`); loadDashboard(); loadIncidents(); });
  socket.on("incident:updated", () => { loadDashboard(); if (!$("#page-incidents").classList.contains("hidden")) loadIncidents(); });
  socket.on("incident:resolved", () => { toast("An incident was resolved."); loadDashboard(); loadIncidents(); });
  socket.on("connect", () => $("#activityFeed").innerHTML = '<div class="activity-item">Connected to live TRACE updates.</div>');
  socket.on("investigation:updated", data => {
    toast("Investigation records updated.");
    if (!$("#page-incidents").classList.contains("hidden")) {
      loadIncidents();
    }
  });
}

async function boot() {
  if (!token) return showAuth();

  try {
    const d = await api("/me");
    currentUser = d.user;

    $("#userName").textContent = currentUser.name;
    $("#userRole").textContent = currentUser.role;
    $("#userAvatar").textContent = currentUser.name.charAt(0).toUpperCase();

    showApp();
    connectSocket();

    if (["admin", "technician"].includes(currentUser.role)) {
      await loadDashboard();
      go("dashboard");
    } else {
      go("reports");
    }

  } catch (err) {
    console.error("Login error:", err);
    localStorage.removeItem("trace_token");
    token = null;
    currentUser = null;
    showAuth();
  }
}

boot();
