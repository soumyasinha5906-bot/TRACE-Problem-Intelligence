
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

let db;

const dbDir = path.join(__dirname, "..", "data");
const dbFile = path.join(dbDir, "trace.sqlite");

async function initDb() {
  fs.mkdirSync(dbDir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(dbFile)) {
    const buffer = fs.readFileSync(dbFile);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Investigating',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incident_reports (
      incident_id INTEGER NOT NULL,
      report_id INTEGER NOT NULL UNIQUE,
      similarity REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(incident_id, report_id),
      FOREIGN KEY(incident_id) REFERENCES incidents(id),
      FOREIGN KEY(report_id) REFERENCES reports(id)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      assigned_to INTEGER,
      priority TEXT NOT NULL DEFAULT 'Medium',
      due_date TEXT,
      completion_notes TEXT DEFAULT '',
      updated_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(incident_id) REFERENCES incidents(id),
      FOREIGN KEY(assigned_to) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      related_incident_id INTEGER,
      related_action_id INTEGER,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (related_incident_id) REFERENCES incidents(id),
      FOREIGN KEY (related_action_id) REFERENCES actions(id)
    ); 

    -- TECHNICAL INSPECTION RECORDS

    CREATE TABLE IF NOT EXISTS inspection_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      technician_id INTEGER NOT NULL,
      inspection_type TEXT NOT NULL,
      access_point_status TEXT DEFAULT '',
      local_connectivity TEXT DEFAULT '',
      upstream_status TEXT DEFAULT '',
      findings TEXT NOT NULL,
      corrective_action TEXT DEFAULT '',
      created_at TEXT NOT NULL,

      FOREIGN KEY(incident_id) REFERENCES incidents(id),
      FOREIGN KEY(technician_id) REFERENCES users(id)
    );

    -- CONNECTIVITY TEST RESULTS

    CREATE TABLE IF NOT EXISTS connectivity_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      technician_id INTEGER NOT NULL,
      block_name TEXT NOT NULL,
      laboratory TEXT DEFAULT '',
      test_type TEXT NOT NULL,
      target TEXT DEFAULT '',
      result TEXT NOT NULL,
      response_time_ms REAL,
      notes TEXT DEFAULT '',
      tested_at TEXT NOT NULL,

      FOREIGN KEY(incident_id) REFERENCES incidents(id),
      FOREIGN KEY(technician_id) REFERENCES users(id)
    );

    -- RESOLUTION VERIFICATION HISTORY

    CREATE TABLE IF NOT EXISTS resolution_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      technician_id INTEGER NOT NULL,
      test_result TEXT NOT NULL,
      findings TEXT NOT NULL,
      verified_at TEXT NOT NULL,

      FOREIGN KEY(incident_id) REFERENCES incidents(id),
      FOREIGN KEY(technician_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inspections_incident
    ON inspection_records(incident_id);

    CREATE INDEX IF NOT EXISTS idx_connectivity_incident
    ON connectivity_tests(incident_id);

    CREATE INDEX IF NOT EXISTS idx_connectivity_time
    ON connectivity_tests(tested_at);

    CREATE INDEX IF NOT EXISTS idx_verification_incident
    ON resolution_verifications(incident_id);
  `);

  // MIGRATE EXISTING ACTIONS TABLE

  const actionColumns = all("PRAGMA table_info(actions)")
    .map(column => column.name);

  const newColumns = [
    ["assigned_to", "INTEGER"],
    ["priority", "TEXT NOT NULL DEFAULT 'Medium'"],
    ["due_date", "TEXT"],
    ["completion_notes", "TEXT DEFAULT ''"],
    ["updated_at", "TEXT"],
    ["completed_at", "TEXT"]
  ];

  for (const [column, definition] of newColumns) {
    if (!actionColumns.includes(column)) {
      db.run(`ALTER TABLE actions ADD COLUMN ${column} ${definition}`);
    }
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_actions_incident
    ON actions(incident_id);

    CREATE INDEX IF NOT EXISTS idx_actions_status
    ON actions(status);

    CREATE INDEX IF NOT EXISTS idx_actions_assigned
    ON actions(assigned_to);
  `);

  saveDb();

  return db;
}

function saveDb() {
  if (!db) return;

  const data = db.export();

  fs.writeFileSync(dbFile, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);

  saveDb();

  return db.exec(
    "SELECT last_insert_rowid() AS id"
  )[0]?.values[0][0];
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);

  stmt.bind(params);

  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();

  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

module.exports = {
  initDb,
  run,
  all,
  get,
  saveDb
};