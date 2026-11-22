
const { spawnSync } = require("child_process");
const path = require("path");

function fallbackCategory(text) {
  const t = text.toLowerCase();

  if (/wifi|wi-fi|internet|network|router|connection|portal/.test(t))
    return "Network";

  if (/projector|computer|laptop|keyboard|printer|equipment|screen/.test(t))
    return "Equipment";

  if (/water|leak|pipe|tap|plumbing/.test(t))
    return "Facilities";

  if (/clean|garbage|dust|washroom|toilet/.test(t))
    return "Cleanliness";

  if (/library|book|borrow|return/.test(t))
    return "Library";

  if (/security|access|entry|visitor/.test(t))
    return "Security";

  return "General";
}

function fallbackKeywords(text) {
  return [
    ...new Set(
      text.toLowerCase().match(/[a-z]{4,}/g) || []
    )
  ].slice(0, 8);
}

async function analyzeText(text) {
  const url =
    process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";

  try {
    const response = await fetch(`${url}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (_) {}

  return {
    category: fallbackCategory(text),
    keywords: fallbackKeywords(text),
    method: "local-fallback",
    note: "Start the optional Python AI service for TF-IDF analysis."
  };
}

function similarity(a, b) {
  const tokenize = s =>
    new Set(
      (s.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    );

  const A = tokenize(a);
  const B = tokenize(b);

  if (!A.size || !B.size) return 0;

  let intersection = 0;

  for (const word of A) {
    if (B.has(word)) intersection++;
  }

  return intersection /
    (A.size + B.size - intersection);
}

function priorityScore(severity, impact, frequency, duration) {
  const exe = path.join(
    __dirname,
    "..",
    "cpp-engine",
    process.platform === "win32"
      ? "priority_engine.exe"
      : "priority_engine"
  );

  const args = [
    severity,
    impact,
    frequency,
    duration
  ].map(String);

  const result = spawnSync(exe, args, {
    encoding: "utf8",
    timeout: 1500
  });

  if (!result.error && result.status === 0) {
    const value = Number(result.stdout.trim());

    if (Number.isFinite(value)) return value;
  }

  return Math.round(
    (
      0.35 * severity +
      0.25 * impact +
      0.20 * frequency +
      0.20 * duration
    ) * 10
  ) / 10;
}

// NEW: RECURRING INCIDENT PATTERN DETECTOR

function detectRecurringPatterns(reports) {
  const dateCounts = {};
  const locationCounts = {};

  const timestamps = [];

  for (const report of reports) {
    if (report.created_at) {
      const timestamp = new Date(report.created_at);

      if (!Number.isNaN(timestamp.getTime())) {
        timestamps.push(timestamp.getTime());

        const date = timestamp.toISOString().slice(0, 10);

        dateCounts[date] = (dateCounts[date] || 0) + 1;
      }
    }

    const location = String(
      report.location || "Unknown"
    ).trim();

    locationCounts[location] =
      (locationCounts[location] || 0) + 1;
  }

  const timeline = Object.entries(dateCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({
      date,
      reportCount: count
    }));

  const distinctDates = timeline.length;

  const repeatedDates = timeline.filter(
    item => item.reportCount > 1
  );

  timestamps.sort((a, b) => a - b);

  let averageGapHours = null;

  if (timestamps.length > 1) {
    let totalGap = 0;

    for (let i = 1; i < timestamps.length; i++) {
      totalGap += timestamps[i] - timestamps[i - 1];
    }

    averageGapHours = Math.round(
      totalGap /
      (timestamps.length - 1) /
      3600000 * 100
    ) / 100;
  }

  const repeatedLocations = Object.entries(locationCounts)
    .filter(([, count]) => count > 1)
    .map(([location, count]) => ({
      location,
      reportCount: count
    }));

  return {
    totalReports: reports.length,
    distinctDates,
    timeline,
    repeatedDates,
    repeatedLocations,
    averageGapHours,
    recurring: distinctDates > 1 || repeatedDates.length > 0,
    pattern:
      distinctDates > 1
        ? "Reports occurred across multiple dates."
        : repeatedDates.length > 0
          ? "Multiple reports were submitted on the same date."
          : "No repeated reporting pattern established."
  };
}

module.exports = {
  analyzeText,
  similarity,
  priorityScore,
  fallbackCategory,
  detectRecurringPatterns
};
