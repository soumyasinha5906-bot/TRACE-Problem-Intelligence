const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { Server } = require("socket.io");
const db = require("./db");
const {
  analyzeText,
  similarity,
  priorityScore,
  detectRecurringPatterns
} = require("./analysis");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing from environment variables.");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Please sign in again." });
  }
}

// ADMIN AND TECHNICIAN ACCESS ONLY

function staffOnly(req, res, next) {
  if (!["admin", "technician"].includes(req.user.role)) {
    return res.status(403).json({
      error: "Access denied. Staff access required."
    });
  }

  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}

function emitUpdate(event, payload) {
  io.emit(event, payload);
}

function normalizeLocation(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function makeIncidentTitle(category, location) {
  return `${category} issue — ${location}`;
}


async function processReport(reportId) {
  const report = db.get(
    "SELECT * FROM reports WHERE id = ?",
    [reportId]
  );

  if (!report) return;

  const analysis = await analyzeText(
    `${report.title}. ${report.description}`
  );

  const reportLocation = normalizeLocation(report.location);

  // Only consider unresolved incidents from the same
  // location and category.
  const candidates = db.all(
    `SELECT i.*,
      GROUP_CONCAT(r.title || ' ' || r.description, ' ') AS report_text
     FROM incidents i
     JOIN incident_reports ir ON ir.incident_id = i.id
     JOIN reports r ON r.id = ir.report_id
     WHERE i.status != 'Resolved'
     GROUP BY i.id`
  );

  const newText = `${report.title} ${report.description}`;

  let best = null;
  let bestScore = 0;

  for (const incident of candidates) {
    const sameCategory =
      incident.category === analysis.category;

    const sameLocation =
      normalizeLocation(incident.location) === reportLocation;

    // Never automatically group different locations.
    if (!sameCategory || !sameLocation) continue;

    const textScore = similarity(
      newText,
      incident.report_text || ""
    );

    // Require meaningful textual similarity.
    if (textScore < 0.12) continue;

    if (textScore > bestScore) {
      bestScore = textScore;
      best = incident;
    }
  }

  let incidentId;

  const similarityScore =
    Math.round(bestScore * 100) / 100;

  if (best) {
    incidentId = best.id;

    db.run(
      `INSERT INTO incident_reports
       (incident_id, report_id, similarity)
       VALUES (?, ?, ?)`,
      [incidentId, reportId, similarityScore]
    );

  } else {
    const title = makeIncidentTitle(
      analysis.category,
      report.location
    );

    incidentId = db.run(
      `INSERT INTO incidents
       (title, category, location, priority, status,
        summary, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'Investigating', ?, ?, ?)`,
      [
        title,
        analysis.category,
        report.location,
        "Potential issue identified from submitted reports.",
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );

    db.run(
      `INSERT INTO incident_reports
       (incident_id, report_id, similarity)
       VALUES (?, ?, ?)`,
      [incidentId, reportId, 1]
    );
  }

  // Recalculate priority using all connected reports.
  const linkedReports = db.all(
    `SELECT r.severity
     FROM reports r
     JOIN incident_reports ir
       ON ir.report_id = r.id
     WHERE ir.incident_id = ?`,
    [incidentId]
  );

  const linked = linkedReports.length;

  const severityValues = {
    High: 90,
    Medium: 60,
    Low: 30
  };

  const severity = Math.max(
    ...linkedReports.map(
      r => severityValues[r.severity] || 30
    )
  );

  const impact = Math.min(100, 30 + linked * 10);
  const frequency = Math.min(100, linked * 15);
  const duration = 40;

  const priority = priorityScore(
    severity,
    impact,
    frequency,
    duration
  );

  const now = new Date().toISOString();

  db.run(
    "UPDATE incidents SET priority = ?, updated_at = ? WHERE id = ?",
    [priority, now, incidentId]
  );

  db.run(
    "UPDATE reports SET category = ? WHERE id = ?",
    [analysis.category, reportId]
  );

  db.saveDb();

  emitUpdate("report:processed", {
    reportId,
    incidentId,
    category: analysis.category
  });

  emitUpdate("incident:updated", {
    incidentId,
    priority
  });
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "TRACE API" }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8)
      return res.status(400).json({ error: "Name, email and a password of at least 8 characters are required." });
    if (db.get("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]))
      return res.status(409).json({ error: "An account with this email already exists." });
    const hash = await bcrypt.hash(password, 12);
    const id = db.run(
      "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)",
      [name.trim(), email.toLowerCase().trim(), hash, new Date().toISOString()]
    );
    const user = db.get("SELECT id, name, email, role FROM users WHERE id = ?", [id]);
    res.status(201).json({ token: tokenFor(user), user });
  } catch (e) { res.status(500).json({ error: "Could not register user." }); }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.get("SELECT * FROM users WHERE email = ?", [String(email || "").toLowerCase()]);
  if (!user || !(await bcrypt.compare(password || "", user.password_hash)))
    return res.status(401).json({ error: "Incorrect email or password." });
  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ token: tokenFor(safeUser), user: safeUser });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.get("SELECT id, name, email, role FROM users WHERE id = ?", [req.user.id]);
  res.json({ user });
});

// GET: LIST USERS FOR CORRECTIVE ACTION ASSIGNMENT


app.get("/api/technicians", auth, staffOnly, (req, res) => {
  const technicians = db.all(
    `SELECT id, name, email, role
     FROM users
     ORDER BY name ASC`
  );

  res.json({ technicians });
});

app.get("/api/dashboard", auth, staffOnly, (req, res) => {
  const totalReports = db.get("SELECT COUNT(*) AS n FROM reports").n;
  const activeIncidents = db.get("SELECT COUNT(*) AS n FROM incidents WHERE status != 'Resolved'").n;
  const highPriority = db.get("SELECT COUNT(*) AS n FROM incidents WHERE status != 'Resolved' AND priority >= 70").n;
  const resolved = db.get("SELECT COUNT(*) AS n FROM incidents WHERE status = 'Resolved'").n;
  const recent = db.all(
    `SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 6`
  );
  const byCategory = db.all("SELECT category, COUNT(*) AS count FROM reports GROUP BY category ORDER BY count DESC");
  res.json({ totalReports, activeIncidents, highPriority, resolved, recent, byCategory });
});


app.get("/api/reports", auth, (req, res) => {

  // Admins and technicians can view all reports
  const canViewAll = ["admin", "technician"].includes(req.user.role);

  const reports = db.all(
    `SELECT r.*, u.name AS reporter, 
      i.id AS incident_id,
      i.status AS incident_status
     FROM reports r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN incident_reports ir ON ir.report_id = r.id
     LEFT JOIN incidents i ON i.id = ir.incident_id
     ${canViewAll ? "" : "WHERE r.user_id = ?"}
     ORDER BY r.id DESC`,
    canViewAll ? [] : [req.user.id]
  );

  res.json({ reports });
});

app.post("/api/reports", auth, async (req, res) => {
  const { title, description, category, severity, location } = req.body;
  if (!title || !description || !location)
    return res.status(400).json({ error: "Title, description and location are required." });
  if (String(description).length > 3000)
    return res.status(400).json({ error: "Description must be 3000 characters or fewer." });
  const validSeverity = ["Low", "Medium", "High"].includes(severity) ? severity : "Medium";
  const id = db.run(
    `INSERT INTO reports (user_id, title, description, category, severity, location, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Open', ?)`,
    [req.user.id, title.trim(), description.trim(), category || "General", validSeverity, location.trim(), new Date().toISOString()]
  );
  emitUpdate("report:new", { id, title, location });
  res.status(201).json({ message: "Report saved. TRACE is analyzing it.", reportId: id });
  processReport(id).catch(err => console.error("Report analysis failed:", err));
});

app.get("/api/incidents", auth, staffOnly, (req, res) => {
  const incidents = db.all(
    `SELECT i.*, COUNT(ir.report_id) AS report_count
     FROM incidents i LEFT JOIN incident_reports ir ON ir.incident_id = i.id
     GROUP BY i.id ORDER BY i.priority DESC, i.id DESC`
  );
  res.json({ incidents });
});

// GET INCIDENT DETAILS AND CORRECTIVE ACTION HISTORY

app.get("/api/incidents/:id", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT * FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const reports = db.all(
    `SELECT r.*, u.name AS reporter, ir.similarity
     FROM reports r
     JOIN incident_reports ir ON ir.report_id = r.id
     JOIN users u ON u.id = r.user_id
     WHERE ir.incident_id = ?
     ORDER BY r.id DESC`,
    [incidentId]
  );

  const actions = db.all(
    `SELECT a.*, u.name AS assigned_name
     FROM actions a
     LEFT JOIN users u ON u.id = a.assigned_to
     WHERE a.incident_id = ?
     ORDER BY a.id DESC`,
    [incidentId]
  );

  res.json({
    incident,
    reports,
    actions
  });
});


app.post("/api/incidents/:id/investigate", auth, staffOnly, async (req, res) => {
  try {
    const incident = db.get(
      "SELECT * FROM incidents WHERE id = ?",
      [req.params.id]
    );

    if (!incident) {
      return res.status(404).json({
        error: "Incident not found."
      });
    }

    const reports = db.all(
      `SELECT r.title, r.description, r.location,
              r.severity, r.created_at, ir.similarity
       FROM reports r
       JOIN incident_reports ir ON ir.report_id = r.id
       WHERE ir.incident_id = ?
       ORDER BY r.id DESC`,
      [incident.id]
    );

    if (!reports.length) {
      return res.status(400).json({
        error: "No reports are connected to this incident."
      });
    }

    // 1. CLASSIFY DIRECT AND RELATED EVIDENCE

    const incidentLocation = normalizeLocation(incident.location);

    const directReports = reports.filter(
      r => normalizeLocation(r.location) === incidentLocation
    );

    const relatedReports = reports.filter(
      r => normalizeLocation(r.location) !== incidentLocation
    );

    const evidenceClassification = {
      direct: directReports.map(r => ({
        title: r.title,
        location: r.location,
        severity: r.severity,
        similarity: r.similarity
      })),

      related: relatedReports.map(r => ({
        title: r.title,
        location: r.location,
        severity: r.severity,
        similarity: r.similarity
      }))
    };

    // 2. ANALYZE OBSERVED SYMPTOMS

    const observations = [];

    const combinedText = reports
      .map(r => `${r.title} ${r.description}`)
      .join(" ")
      .toLowerCase();

    const symptomRules = [
      {
        pattern: /wi-?fi|internet|network|disconnect|offline|no connection|not working/,
        message: "Reports indicate network connectivity interruptions."
      },
      {
        pattern: /slow|lag|buffer|loading|delay/,
        message: "Reports indicate slow response or performance problems."
      },
      {
        pattern: /frequently|repeatedly|intermittent|every few minutes/,
        message: "Reports indicate potentially recurring or intermittent problems."
      },
      {
        pattern: /power|electricity|voltage|supply/,
        message: "Reports mention possible power supply problems."
      },
      {
        pattern: /leak|water|pipe|plumbing/,
        message: "Reports indicate a possible water or plumbing issue."
      },
      {
        pattern: /broken|damaged|malfunction|not turning on/,
        message: "Reports describe possible equipment malfunction."
      }
    ];

    for (const rule of symptomRules) {
      if (rule.pattern.test(combinedText)) {
        observations.push(rule.message);
      }
    }

    if (!observations.length) {
      observations.push(
        "Reports share an incident association, but their descriptions do not establish a specific common symptom."
      );
    }

    // 3. SEVERITY ANALYSIS

    const severityWeight = {
      High: 3,
      Medium: 2,
      Low: 1
    };

    const severityCounts = {
      High: 0,
      Medium: 0,
      Low: 0
    };

    let severityPoints = 0;

    for (const report of reports) {
      const level = severityWeight[report.severity] ? report.severity : "Low";

      severityCounts[level]++;
      severityPoints += severityWeight[level];
    }

    const averageSeverity =
      Math.round((severityPoints / reports.length) * 100) / 100;

    // 4. RANK POSSIBLE CAUSES

    const causeRules = {
      Network: [
        {
          name: "Local Wi-Fi access-point or coverage problem",
          patterns: [/wi-?fi/, /signal/, /coverage/, /disconnect/, /connection/],
          action: "Inspect the local access point and verify connectivity in the affected laboratory."
        },
        {
          name: "Network configuration or authentication issue",
          patterns: [/authentication/, /password/, /login/, /configuration/, /ip address/],
          action: "Review network authentication, IP allocation and configuration records."
        },
        {
          name: "Wider network service interruption",
          patterns: [/internet/, /outage/, /gateway/, /router/, /campus network/],
          action: "Check upstream network services and compare connectivity across affected blocks."
        }
      ],

      Equipment: [
        {
          name: "Possible hardware malfunction",
          patterns: [/broken/, /damaged/, /malfunction/, /not working/],
          action: "Inspect the affected equipment and record its operational condition."
        },
        {
          name: "Possible power supply problem",
          patterns: [/power/, /electricity/, /voltage/, /supply/],
          action: "Check the equipment power supply and related electrical records."
        },
        {
          name: "Possible configuration issue",
          patterns: [/configuration/, /settings/, /software/, /restart/],
          action: "Review equipment settings and operational logs."
        }
      ],

      Facilities: [
        {
          name: "Possible plumbing or infrastructure issue",
          patterns: [/water/, /leak/, /pipe/, /plumbing/],
          action: "Inspect the affected infrastructure and check for maintenance requirements."
        },
        {
          name: "Possible maintenance-related problem",
          patterns: [/maintenance/, /repair/, /damaged/, /broken/],
          action: "Review maintenance records and inspect the affected facility."
        }
      ],

      Cleanliness: [
        {
          name: "Possible cleaning or waste-management issue",
          patterns: [/waste/, /garbage/, /dirty/, /cleaning/, /dust/],
          action: "Inspect the affected area and review cleaning schedules."
        },
        {
          name: "Possible shortage of maintenance resources",
          patterns: [/overflow/, /uncollected/, /shortage/],
          action: "Review cleaning schedules and available maintenance resources."
        }
      ],

      Security: [
        {
          name: "Possible access-control issue",
          patterns: [/access/, /entry/, /unauthorized/, /permission/],
          action: "Review access-control records and entry procedures."
        },
        {
          name: "Possible monitoring issue",
          patterns: [/camera/, /monitoring/, /surveillance/, /cctv/],
          action: "Inspect monitoring equipment and relevant operational records."
        }
      ]
    };

    const rules = causeRules[incident.category] || [];

    const rankedCauses = rules.map(rule => {
      let score = 0;
      const supportingReports = [];

      for (const report of reports) {
        const text =
          `${report.title} ${report.description}`.toLowerCase();

        const matches = rule.patterns.some(pattern =>
          pattern.test(text)
        );

        if (matches) {
          const weight = severityWeight[report.severity] || 1;

          score += weight;

          supportingReports.push({
            title: report.title,
            location: report.location,
            severity: report.severity
          });
        }
      }

      return {
        cause: rule.name,
        score,
        supportingReports,
        suggestedAction: rule.action
      };
    });

    // Related locations are a signal worth checking,
    // not proof of a campus-wide failure.
    if (incident.category === "Network" && relatedReports.length > 0) {
      const upstreamCause = rankedCauses.find(
        c => c.cause === "Wider network service interruption"
      );

      if (upstreamCause) {
        upstreamCause.score += relatedReports.length;
      }
    }

    const sortedCauses = rankedCauses
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!sortedCauses.length) {
      sortedCauses.push({
        cause: "Underlying cause cannot be determined from current evidence.",
        score: 0,
        supportingReports: [],
        suggestedAction: "Conduct a physical inspection and review operational records."
      });
    }

    // 5. RECURRING INCIDENT PATTERN ANALYSIS
    
    const patternAnalysis = detectRecurringPatterns(reports);
    
    const timelineData = patternAnalysis.timeline;
    
    const recurring = patternAnalysis.recurring;

    // 6. GENERATE SUGGESTED ACTIONS

    const suggestedActions = [
      ...new Set(sortedCauses.map(c => c.suggestedAction))
    ];

    suggestedActions.push(
      "Inspect the local access point and verify connectivity in the affected laboratory.",
      "Check upstream network services and compare connectivity across affected blocks.",
      "Compare report timestamps to identify recurring patterns.",
      "Document inspection findings and verify whether the issue has been resolved."
    );

    // 7. BUILD INVESTIGATION SUMMARY

    const summary = [
      `${reports.length} report(s) are connected to this ${incident.category} incident at ${incident.location}.`,
      "",
      "OBSERVED SYMPTOMS:",
      ...observations.map(x => `- ${x}`),
      "",
      "EVIDENCE CLASSIFICATION:",
      `- Direct evidence: ${directReports.length} report(s)`,
      `- Related-location evidence: ${relatedReports.length} report(s)`,
      "",
      "SEVERITY ANALYSIS:",
      `- High: ${severityCounts.High}`,
      `- Medium: ${severityCounts.Medium}`,
      `- Low: ${severityCounts.Low}`,
      `- Average severity weight: ${averageSeverity}/3`,
      "",
      "RANKED POSSIBLE CAUSES (NOT VERIFIED):",
      ...sortedCauses.map((c, i) =>
        `${i + 1}. ${c.cause} (evidence score: ${c.score})`
      ),
      "",
      `TIMELINE: ${recurring ? "Multiple reports share one or more dates." : "No repeated same-day reporting pattern established."}`,
      "",
      "These findings are preliminary. Evidence scores are heuristic ranking indicators, not probabilities. Inspection and operational records are required to verify the actual root cause."
    ].join("\n");

    // 8. SAVE INVESTIGATION

    db.run(
      `UPDATE incidents
       SET summary = ?, updated_at = ?
       WHERE id = ?`,
      [summary, new Date().toISOString(), incident.id]
    );

    db.saveDb();

    // 9. RETURN INVESTIGATION RESULTS

    res.json({
      summary,

      evidence: reports.map(r =>
        `${r.title}: ${r.description} | Location: ${r.location} | Severity: ${r.severity} | Similarity: ${r.similarity}`
      ),

      evidenceClassification,

      observations,

      severityAnalysis: {
        counts: severityCounts,
        averageWeight: averageSeverity
      },

      possibleCauses: sortedCauses.map(c => c.cause),
rankedPossibleCauses: sortedCauses,

      suggestedActions,
      
      timeline: timelineData,
      
      recurring,
      
      patternAnalysis,

      confidence:
        "Preliminary rule-based evidence analysis. Root cause not independently verified.",

      method: "Location-aware, severity-weighted rule-based investigation"
    });

  } catch (error) {
    console.error("Investigation error:", error);

    res.status(500).json({
      error: "Could not generate incident investigation."
    });
  }
});


// ============================================
// TRACE TECHNICAL INVESTIGATION MODULE
// ============================================

// GET: FETCH INSPECTION AND CONNECTIVITY HISTORY


app.get("/api/incidents/:id/investigation-records", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT id FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const inspections = db.all(
    `SELECT ir.*, u.name AS technician
     FROM inspection_records ir
     JOIN users u ON u.id = ir.technician_id
     WHERE ir.incident_id = ?
     ORDER BY ir.id DESC`,
    [incidentId]
  );

  const connectivityTests = db.all(
    `SELECT ct.*, u.name AS technician
     FROM connectivity_tests ct
     JOIN users u ON u.id = ct.technician_id
     WHERE ct.incident_id = ?
     ORDER BY ct.id DESC`,
    [incidentId]
  );

  const verifications = db.all(
    `SELECT rv.*, u.name AS technician
     FROM resolution_verifications rv
     JOIN users u ON u.id = rv.technician_id
     WHERE rv.incident_id = ?
     ORDER BY rv.id DESC`,
    [incidentId]
  );

  res.json({
    inspections,
    connectivityTests,
    verifications
  });
});


// POST: SAVE ACCESS POINT / TECHNICAL INSPECTION

app.post("/api/incidents/:id/inspections", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT id FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const {
    inspection_type,
    access_point_status,
    local_connectivity,
    upstream_status,
    findings,
    corrective_action
  } = req.body;

  if (
    !["Access Point", "Network", "General"].includes(inspection_type)
  ) {
    return res.status(400).json({
      error: "Invalid inspection type."
    });
  }

  if (!findings || !String(findings).trim()) {
    return res.status(400).json({
      error: "Inspection findings are required."
    });
  }

  const id = db.run(
    `INSERT INTO inspection_records
     (
       incident_id,
       technician_id,
       inspection_type,
       access_point_status,
       local_connectivity,
       upstream_status,
       findings,
       corrective_action,
       created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      incidentId,
      req.user.id,
      inspection_type,
      access_point_status || "",
      local_connectivity || "",
      upstream_status || "",
      String(findings).trim(),
      corrective_action || "",
      new Date().toISOString()
    ]
  );

    // NOTIFY USER WHEN INSPECTION IS SUBMITTED

  db.run(
    `INSERT INTO notifications
     (
       user_id,
       title,
       message,
       type,
       related_incident_id,
       related_action_id,
       is_read,
       created_at
     )
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
    [
      req.user.id,
      "Inspection Submitted",
      `Inspection findings were saved for Incident #${incidentId}.`,
      "inspection",
      incidentId,
      new Date().toISOString()
    ]
  );

  emitUpdate("investigation:updated", {
    incidentId,
    type: "inspection"
  });

  res.status(201).json({
    message: "Inspection findings saved successfully.",
    inspectionId: id
  });
});


// POST: RECORD A CONNECTIVITY TEST

app.post("/api/incidents/:id/connectivity-tests", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT id FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const {
    block_name,
    laboratory,
    test_type,
    target,
    result,
    response_time_ms,
    notes
  } = req.body;

  if (!block_name || !String(block_name).trim()) {
    return res.status(400).json({
      error: "Block name is required."
    });
  }

  if (!["Local", "Upstream"].includes(test_type)) {
    return res.status(400).json({
      error: "Test type must be Local or Upstream."
    });
  }

  if (!["Success", "Failure", "Not Tested"].includes(result)) {
    return res.status(400).json({
      error: "Invalid connectivity test result."
    });
  }

  if (
    response_time_ms !== undefined &&
    response_time_ms !== null &&
    (
      !Number.isFinite(Number(response_time_ms)) ||
      Number(response_time_ms) < 0
    )
  ) {
    return res.status(400).json({
      error: "Response time must be a non-negative number."
    });
  }

  const id = db.run(
    `INSERT INTO connectivity_tests
     (
       incident_id,
       technician_id,
       block_name,
       laboratory,
       test_type,
       target,
       result,
       response_time_ms,
       notes,
       tested_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      incidentId,
      req.user.id,
      String(block_name).trim(),
      laboratory || "",
      test_type,
      target || "",
      result,
      response_time_ms === undefined || response_time_ms === null
        ? null
        : Number(response_time_ms),
      notes || "",
      new Date().toISOString()
    ]
  );

  emitUpdate("investigation:updated", {
    incidentId,
    type: "connectivity"
  });

  res.status(201).json({
    message: "Connectivity test recorded successfully.",
    testId: id
  });
});


// POST: VERIFY INCIDENT RESOLUTION

app.post("/api/incidents/:id/verify-resolution", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT * FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  if (incident.status === "Resolved") {
    return res.status(400).json({
      error: "This incident is already resolved."
    });
  }

  const { test_result, findings } = req.body;

  if (!["Pass", "Fail"].includes(test_result)) {
    return res.status(400).json({
      error: "Verification result must be Pass or Fail."
    });
  }

  if (!findings || !String(findings).trim()) {
    return res.status(400).json({
      error: "Verification findings are required."
    });
  }

  // A successful recorded connectivity test is
  // required before confirming resolution.

  // Require a successful connectivity test only for network incidents
  if (
    test_result === "Pass" &&
    ["Network", "Connectivity", "Internet"].includes(incident.category)
  ) {
    const latestTest = db.get(
      `SELECT result
      FROM connectivity_tests
      WHERE incident_id = ?
      ORDER BY id DESC
      LIMIT 1`,
      [incidentId]
    );

  if (!latestTest || latestTest.result !== "Success") {
    return res.status(400).json({
      error: "Record a successful connectivity test before verifying resolution."
    });
  }
}

  const now = new Date().toISOString();

  db.run(
    `INSERT INTO resolution_verifications
     (
       incident_id,
       technician_id,
       test_result,
       findings,
       verified_at
     )
     VALUES (?, ?, ?, ?, ?)`,
    [
      incidentId,
      req.user.id,
      test_result,
      String(findings).trim(),
      now
    ]
  );

  if (test_result === "Pass") {
    db.run(
      `UPDATE incidents
       SET status = 'Resolved',
           updated_at = ?
       WHERE id = ?`,
      [now, incidentId]
    );

    // Update all customer reports linked to this incident
    db.run(
      `UPDATE reports
      SET status = 'Resolved'
      WHERE id IN (
        SELECT report_id
        FROM incident_reports
        WHERE incident_id = ?
      )`,
      [incidentId]
    );

    emitUpdate("incident:resolved", {
      incidentId
    });
  } else {
    db.run(
      `UPDATE incidents
       SET status = 'Investigating',
           updated_at = ?
       WHERE id = ?`,
      [now, incidentId]
    );
  }

  emitUpdate("investigation:updated", {
    incidentId,
    type: "verification",
    result: test_result
  });

  res.json({
    message: test_result === "Pass"
      ? "Resolution verified. Incident marked as resolved."
      : "Verification failed. Incident remains under investigation.",
    status: test_result === "Pass"
      ? "Resolved"
      : "Investigating"
  });
});


// ============================================
// ADVANCED CORRECTIVE ACTION TRACKING
// ============================================

// POST: CREATE A CORRECTIVE ACTION

app.post("/api/incidents/:id/actions", auth, staffOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT id FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const {
    description,
    assigned_to,
    priority,
    due_date
  } = req.body;

  if (!description || !String(description).trim()) {
    return res.status(400).json({
      error: "Action description is required."
    });
  }

  const validPriorities = ["Low", "Medium", "High"];
  const selectedPriority = priority || "Medium";

  if (!validPriorities.includes(selectedPriority)) {
    return res.status(400).json({
      error: "Invalid action priority."
    });
  }

  let assignedUser = null;

  if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "") {
    assignedUser = Number(assigned_to);

    if (!Number.isInteger(assignedUser) || assignedUser <= 0) {
      return res.status(400).json({
        error: "Invalid assigned user."
      });
    }

    const userExists = db.get(
      "SELECT id FROM users WHERE id = ?",
      [assignedUser]
    );

    if (!userExists) {
      return res.status(400).json({
        error: "Assigned user does not exist."
      });
    }
  }

  if (
    due_date &&
    !/^\d{4}-\d{2}-\d{2}$/.test(due_date)
  ) {
    return res.status(400).json({
      error: "Due date must use YYYY-MM-DD format."
    });
  }

  const now = new Date().toISOString();

  const id = db.run(
    `INSERT INTO actions
     (
       incident_id,
       description,
       status,
       created_at,
       assigned_to,
       priority,
       due_date,
       completion_notes,
       updated_at
     )
     VALUES (?, ?, 'Pending', ?, ?, ?, ?, '', ?)`,
    [
      incidentId,
      String(description).trim(),
      now,
      assignedUser,
      selectedPriority,
      due_date || null,
      now
    ]
  );

    // NOTIFY ASSIGNED TECHNICIAN

  if (assignedUser) {
    db.run(
      `INSERT INTO notifications
       (
         user_id,
         title,
         message,
         type,
         related_incident_id,
         related_action_id,
         is_read,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        assignedUser,
        "New Corrective Action Assigned",
        `You have been assigned a new corrective action: ${String(description).trim()}`,
        "assignment",
        incidentId,
        id,
        now
      ]
    );
  }

  emitUpdate("action:updated", {
    incidentId,
    actionId: id,
    type: "created"
  });

  res.status(201).json({
    id,
    message: "Corrective action created successfully."
  });
});


// PATCH: UPDATE A CORRECTIVE ACTION

app.patch("/api/actions/:id", auth, staffOnly, (req, res) => {
  const actionId = Number(req.params.id);

  const action = db.get(
    "SELECT * FROM actions WHERE id = ?",
    [actionId]
  );

  if (!action) {
    return res.status(404).json({
      error: "Corrective action not found."
    });
  }

  const {
    description,
    status,
    assigned_to,
    priority,
    due_date,
    completion_notes
  } = req.body;

  const validStatuses = [
    "Pending",
    "In Progress",
    "Completed"
  ];

  const validPriorities = [
    "Low",
    "Medium",
    "High"
  ];

  const newDescription =
    description !== undefined
      ? String(description).trim()
      : action.description;

  const newStatus =
    status !== undefined ? status : action.status;

  const newPriority =
    priority !== undefined ? priority : action.priority;

  const newDueDate =
    due_date !== undefined ? due_date : action.due_date;

  const newNotes =
    completion_notes !== undefined
      ? String(completion_notes).trim()
      : action.completion_notes;

  let newAssignedTo = action.assigned_to;

  if (assigned_to !== undefined) {
    if (assigned_to === null || assigned_to === "") {
      newAssignedTo = null;
    } else {
      newAssignedTo = Number(assigned_to);

      if (!Number.isInteger(newAssignedTo) || newAssignedTo <= 0) {
        return res.status(400).json({
          error: "Invalid assigned user."
        });
      }

      const userExists = db.get(
        "SELECT id FROM users WHERE id = ?",
        [newAssignedTo]
      );

      if (!userExists) {
        return res.status(400).json({
          error: "Assigned user does not exist."
        });
      }
    }
  }

  if (!newDescription) {
    return res.status(400).json({
      error: "Action description cannot be empty."
    });
  }

  if (!validStatuses.includes(newStatus)) {
    return res.status(400).json({
      error: "Invalid action status."
    });
  }

  if (!validPriorities.includes(newPriority)) {
    return res.status(400).json({
      error: "Invalid action priority."
    });
  }

  if (
    newDueDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(newDueDate)
  ) {
    return res.status(400).json({
      error: "Due date must use YYYY-MM-DD format."
    });
  }

  const now = new Date().toISOString();

  const completedAt =
    newStatus === "Completed"
      ? (action.completed_at || now)
      : null;

  db.run(
    `UPDATE actions
     SET description = ?,
         status = ?,
         assigned_to = ?,
         priority = ?,
         due_date = ?,
         completion_notes = ?,
         updated_at = ?,
         completed_at = ?
     WHERE id = ?`,
    [
      newDescription,
      newStatus,
      newAssignedTo,
      newPriority,
      newDueDate || null,
      newNotes,
      now,
      completedAt,
      actionId
    ]
  );

    // NOTIFY USER WHEN ACTION IS COMPLETED

  if (
    newStatus === "Completed" &&
    action.status !== "Completed" &&
    newAssignedTo
  ) {

    db.run(
      `INSERT INTO notifications
       (
         user_id,
         title,
         message,
         type,
         related_incident_id,
         related_action_id,
         is_read,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        newAssignedTo,
        "Corrective Action Completed",
        `Your assigned corrective action has been completed: ${newDescription}`,
        "completion",
        action.incident_id,
        actionId,
        new Date().toISOString()
      ]
    );

    console.log(
      `Completion notification created for Action #${actionId}`
    );
  }

  emitUpdate("action:updated", {
    incidentId: action.incident_id,
    actionId,
    status: newStatus
  });

  res.json({
    message: "Corrective action updated successfully.",
    status: newStatus
  });
});


app.post("/api/incidents/:id/resolve", auth, adminOnly, (req, res) => {
  const incidentId = Number(req.params.id);

  const incident = db.get(
    "SELECT id FROM incidents WHERE id = ?",
    [incidentId]
  );

  if (!incident) {
    return res.status(404).json({
      error: "Incident not found."
    });
  }

  const verification = db.get(
    `SELECT test_result
     FROM resolution_verifications
     WHERE incident_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [incidentId]
  );

  if (!verification || verification.test_result !== "Pass") {
    return res.status(400).json({
      error: "A successful resolution verification is required."
    });
  }

  db.run(
    `UPDATE incidents
     SET status = 'Resolved', updated_at = ?
     WHERE id = ?`,
    [new Date().toISOString(), incidentId]
  );

  emitUpdate("incident:resolved", {
    incidentId
  });

  res.json({
    message: "Incident resolution verified."
  });
});



app.get("/api/analytics", auth, staffOnly, (req, res) => {

  // EXISTING REPORT ANALYTICS

  const categories = db.all(`
    SELECT category, COUNT(*) AS count
    FROM reports
    GROUP BY category
    ORDER BY count DESC
  `);

  const statuses = db.all(`
    SELECT status, COUNT(*) AS count
    FROM incidents
    GROUP BY status
  `);

  const recent = db.all(`
    SELECT date(created_at) AS day, COUNT(*) AS count
    FROM reports
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT 7
  `);

  // CORRECTIVE ACTION OVERVIEW

  const actionStats = db.get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS inProgress,
      SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,

      SUM(
        CASE
          WHEN status != 'Completed'
          AND due_date IS NOT NULL
          AND date(due_date) < date('now', 'localtime')
          THEN 1 ELSE 0
        END
      ) AS overdue

    FROM actions
  `);

  const totalActions = Number(actionStats.total || 0);
  const completedActions = Number(actionStats.completed || 0);

  const completionRate = totalActions > 0
    ? Number(((completedActions / totalActions) * 100).toFixed(1))
    : 0;

  // PRIORITY BREAKDOWN

  const actionPriorities = db.all(`
    SELECT priority, COUNT(*) AS count
    FROM actions
    GROUP BY priority
    ORDER BY
      CASE priority
        WHEN 'High' THEN 1
        WHEN 'Medium' THEN 2
        WHEN 'Low' THEN 3
        ELSE 4
      END
  `);

  // ACTIONS GROUPED BY INCIDENT

  const incidentActions = db.all(`
    SELECT
      i.id AS incident_id,
      i.title AS incident_title,
      i.status AS incident_status,
      COUNT(a.id) AS total_actions,

      SUM(
        CASE WHEN a.status = 'Pending'
        THEN 1 ELSE 0 END
      ) AS pending,

      SUM(
        CASE WHEN a.status = 'In Progress'
        THEN 1 ELSE 0 END
      ) AS in_progress,

      SUM(
        CASE WHEN a.status = 'Completed'
        THEN 1 ELSE 0 END
      ) AS completed,

      SUM(
        CASE
          WHEN a.status != 'Completed'
          AND a.due_date IS NOT NULL
          AND date(a.due_date) < date('now', 'localtime')
          THEN 1 ELSE 0
        END
      ) AS overdue

    FROM incidents i
    JOIN actions a ON a.incident_id = i.id
    GROUP BY i.id, i.title, i.status
    ORDER BY overdue DESC, total_actions DESC
  `);

  // SEND ALL ANALYTICS

  res.json({
    categories,
    statuses,
    recent,

    correctiveActions: {
      total: totalActions,
      pending: Number(actionStats.pending || 0),
      inProgress: Number(actionStats.inProgress || 0),
      completed: completedActions,
      overdue: Number(actionStats.overdue || 0),
      completionRate,
      priorities: actionPriorities,
      byIncident: incidentActions
    }
  });

});


app.get("/api/sla", auth, staffOnly, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // ACTIONS DUE WITHIN THE NEXT 3 DAYS
  const dueSoon = db.all(`
    SELECT
      a.*,
      i.title AS incident_title,
      i.status AS incident_status,
      i.priority AS incident_priority,
      u.name AS assigned_name
    FROM actions a
    JOIN incidents i ON i.id = a.incident_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.status != 'Completed'
      AND a.due_date IS NOT NULL
      AND date(a.due_date) >= date('now', 'localtime')
      AND date(a.due_date) <= date('now', 'localtime', '+3 days')
    ORDER BY date(a.due_date) ASC
  `);

  // OVERDUE ACTIONS
  const overdueActions = db.all(`
    SELECT
      a.*,
      i.title AS incident_title,
      i.status AS incident_status,
      i.priority AS incident_priority,
      u.name AS assigned_name
    FROM actions a
    JOIN incidents i ON i.id = a.incident_id
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.status != 'Completed'
      AND a.due_date IS NOT NULL
      AND date(a.due_date) < date('now', 'localtime')
    ORDER BY
      CASE a.priority
        WHEN 'High' THEN 1
        WHEN 'Medium' THEN 2
        WHEN 'Low' THEN 3
        ELSE 4
      END,
      date(a.due_date) ASC
  `);

  // HIGH-PRIORITY OVERDUE ACTIONS
  const escalated = overdueActions.filter(
    action => action.priority === "High"
  );

  // SLA COMPLIANCE FOR COMPLETED ACTIONS WITH DEADLINES
  const slaStats = db.get(`
    SELECT
      COUNT(*) AS total_completed_with_deadline,
      SUM(
        CASE
          WHEN date(completed_at) <= date(due_date)
          THEN 1 ELSE 0
        END
      ) AS completed_on_time
    FROM actions
    WHERE status = 'Completed'
      AND due_date IS NOT NULL
      AND completed_at IS NOT NULL
  `);

  const totalTracked = Number(
    slaStats.total_completed_with_deadline || 0
  );

  const completedOnTime = Number(
    slaStats.completed_on_time || 0
  );

  const complianceRate = totalTracked > 0
    ? Number(
        ((completedOnTime / totalTracked) * 100).toFixed(1)
      )
    : 0;

  // TOTAL ACTIVE ACTIONS WITH DEADLINES
  const deadlineStats = db.get(`
    SELECT
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN status != 'Completed'
          AND date(due_date) < date('now', 'localtime')
          THEN 1 ELSE 0
        END
      ) AS overdue,
      SUM(
        CASE
          WHEN status != 'Completed'
          AND date(due_date) >= date('now', 'localtime')
          AND date(due_date) <= date('now', 'localtime', '+3 days')
          THEN 1 ELSE 0
        END
      ) AS due_soon
    FROM actions
    WHERE due_date IS NOT NULL
  `);

  res.json({
    today,
    dueSoon,
    overdueActions,
    escalated,
    compliance: {
      tracked: totalTracked,
      completedOnTime,
      rate: complianceRate
    },
    deadlineStats: {
      total: Number(deadlineStats.total || 0),
      overdue: Number(deadlineStats.overdue || 0),
      dueSoon: Number(deadlineStats.due_soon || 0)
    }
  });
});

// ===============================
// NOTIFICATION SYSTEM
// ===============================

app.get("/api/notifications", auth, (req, res) => {

  const notifications = db.all(`
    SELECT *
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `, [req.user.id]);

  const unread = db.get(`
    SELECT COUNT(*) AS count
    FROM notifications
    WHERE user_id = ?
    AND is_read = 0
  `, [req.user.id]);

  res.json({
    notifications,
    unread: Number(unread?.count || 0)
  });

});


app.patch("/api/notifications/:id/read", auth, (req, res) => {

  db.run(`
    UPDATE notifications
    SET is_read = 1
    WHERE id = ?
    AND user_id = ?
  `, [req.params.id, req.user.id]);

  res.json({
    success: true
  });

});


app.patch("/api/notifications/read-all", auth, (req, res) => {

  db.run(`
    UPDATE notifications
    SET is_read = 1
    WHERE user_id = ?
  `, [req.user.id]);

  res.json({
    success: true
  });

});

// ============================================
// AUTOMATED DEADLINE NOTIFICATIONS
// ============================================

function checkActionDeadlines() {

  const actions = db.all(`
    SELECT
      id,
      incident_id,
      description,
      assigned_to,
      priority,
      due_date,

      CASE
        WHEN date(due_date) < date('now', 'localtime')
          THEN 'overdue'

        WHEN date(due_date) <= date('now', 'localtime', '+2 days')
          THEN 'due_soon'

        ELSE NULL
      END AS alert_type

    FROM actions

    WHERE status != 'Completed'
      AND assigned_to IS NOT NULL
      AND due_date IS NOT NULL
      AND date(due_date) <= date('now', 'localtime', '+2 days')
  `);

  for (const action of actions) {

    let type;
    let title;
    let message;

    if (action.alert_type === "overdue") {

      if (action.priority === "High") {
        type = "high_overdue";
        title = "High-Priority Action Overdue";
        message = `Your high-priority corrective action is overdue: ${action.description}`;
      } else {
        type = "overdue";
        title = "Corrective Action Overdue";
        message = `Your corrective action is overdue: ${action.description}`;
      }

    } else {

      type = "due_soon";
      title = "Corrective Action Deadline Approaching";
      message = `Your corrective action is due on ${action.due_date}: ${action.description}`;

    }

    // PREVENT DUPLICATE ALERTS

    const existing = db.get(
      `SELECT id
       FROM notifications
       WHERE user_id = ?
         AND related_action_id = ?
         AND type = ?
       LIMIT 1`,
      [action.assigned_to, action.id, type]
    );

    if (existing) continue;

    // CREATE NOTIFICATION

    db.run(
      `INSERT INTO notifications
       (
         user_id,
         title,
         message,
         type,
         related_incident_id,
         related_action_id,
         is_read,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        action.assigned_to,
        title,
        message,
        type,
        action.incident_id,
        action.id,
        new Date().toISOString()
      ]
    );

    console.log(
      `Deadline notification created for Action #${action.id}`
    );
  }
} 

io.on("connection", socket => {
  socket.emit("connected", { message: "Connected to TRACE live updates." });
});


async function seedDemo() {
  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
  const customerEmail = process.env.DEMO_CUSTOMER_EMAIL;
  const customerPassword = process.env.DEMO_CUSTOMER_PASSWORD;

  if (!adminEmail || !adminPassword || !customerEmail || !customerPassword) {
    throw new Error("Demo account environment variables are missing.");
  }

  // CREATE DEMO ADMIN ACCOUNT
  if (!db.get("SELECT id FROM users WHERE email = ?", [adminEmail])) {
    const hash = await bcrypt.hash(adminPassword, 12);

    db.run(
      "INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)",
      ["TRACE Administrator", adminEmail, hash, "admin", new Date().toISOString()]
    );
  }

  // CREATE DEMO CUSTOMER ACCOUNT
  if (!db.get("SELECT id FROM users WHERE email = ?", [customerEmail])) {
    const hash = await bcrypt.hash(customerPassword, 12);

    db.run(
      "INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)",
      ["TRACE Customer", customerEmail, hash, "customer", new Date().toISOString()]
    );
  }

  const count = db.get("SELECT COUNT(*) AS n FROM reports").n;

  if (count === 0) {
    const admin = db.get("SELECT id FROM users WHERE email = ?", [adminEmail]);

    const samples = [
      ["Wi-Fi disconnects in Lab 3", "Internet connection disconnects every few minutes during classes.", "Network", "High", "Block A - Lab 3"],
      ["Slow internet in Block A", "The campus Wi-Fi is very slow in rooms near Lab 3.", "Network", "Medium", "Block A - Lab 3"],
      ["Unable to access college portal", "The portal stops loading when connected to campus Wi-Fi.", "Network", "Medium", "Block A"],
      ["Projector not starting", "The classroom projector does not turn on.", "Equipment", "Medium", "Block B - Room 204"],
      ["Water tap leaking", "Water is leaking near the wash area.", "Facilities", "Low", "Block C"]
    ];

    for (const s of samples) {
      const id = db.run(
        "INSERT INTO reports (user_id,title,description,category,severity,location,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [admin.id, ...s, "Open", new Date().toISOString()]
      );

      await processReport(id);
    }
  }
}

(async () => {
  await db.initDb();
  await seedDemo();

  // CHECK DEADLINES WHEN TRACE STARTS
  checkActionDeadlines();

  // CHECK AGAIN EVERY 60 SECONDS
  setInterval(() => {
    checkActionDeadlines();
  }, 60 * 1000);

  server.listen(PORT, () => {
    console.log(`TRACE running at http://localhost:${PORT}`);
  });
})();
