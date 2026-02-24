#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const inputPath = process.argv[2] || "audit.latest.json";
const fullPath = path.resolve(process.cwd(), inputPath);

function loadReport(filePath) {
  const buf = fs.readFileSync(filePath);
  const sanitize = (text) => text.replace(/^\uFEFF/, "");

  // PowerShell redirection commonly writes UTF-16LE with BOM.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return JSON.parse(sanitize(buf.toString("utf16le")));
  }

  // UTF-8 BOM fallback.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return JSON.parse(sanitize(buf.toString("utf8").slice(1)));
  }

  return JSON.parse(sanitize(buf.toString("utf8")));
}

function getSeverityWeight(sev) {
  if (sev === "critical") return 4;
  if (sev === "high") return 3;
  if (sev === "moderate") return 2;
  if (sev === "low") return 1;
  return 0;
}

function summarize(report) {
  const vulns = report.vulnerabilities || {};
  const entries = Object.entries(vulns).map(([name, vuln]) => ({ name, ...vuln }));

  const actionable = entries
    .filter((v) => v.fixAvailable)
    .sort((a, b) => getSeverityWeight(b.severity) - getSeverityWeight(a.severity));
  const blocked = entries
    .filter((v) => !v.fixAvailable)
    .sort((a, b) => getSeverityWeight(b.severity) - getSeverityWeight(a.severity));

  return { entries, actionable, blocked };
}

function toVersionParts(raw) {
  const value = String(raw || "").replace(/^[^\d]*/, "");
  const [major = "0", minor = "0", patch = "0"] = value.split(".");
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

function compareVersions(a, b) {
  const pa = toVersionParts(a);
  const pb = toVersionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function loadPackageVersions() {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return {};
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
}

function printSummary(report, triage) {
  const installed = loadPackageVersions();
  const totals = report.metadata?.vulnerabilities || {};
  console.log("Audit Summary");
  console.log(`- total: ${totals.total ?? 0}`);
  console.log(`- critical: ${totals.critical ?? 0}`);
  console.log(`- high: ${totals.high ?? 0}`);
  console.log(`- moderate: ${totals.moderate ?? 0}`);
  console.log(`- low: ${totals.low ?? 0}`);
  console.log("");

  console.log("Actionable Findings (fixAvailable=true)");
  if (triage.actionable.length === 0) {
    console.log("- none");
  } else {
    for (const vuln of triage.actionable) {
      const fix = typeof vuln.fixAvailable === "object" ? JSON.stringify(vuln.fixAvailable) : "true";
      let note = "";
      if (typeof vuln.fixAvailable === "object" && vuln.fixAvailable?.name && vuln.fixAvailable?.version) {
        const current = installed[vuln.fixAvailable.name];
        if (current && compareVersions(vuln.fixAvailable.version, current) < 0) {
          note = ` | note: suggested fix is lower than current declared ${current}`;
        }
      }
      console.log(`- [${vuln.severity}] ${vuln.name} | fix: ${fix}${note}`);
    }
  }
  console.log("");

  console.log("Blocked Findings (fixAvailable=false)");
  if (triage.blocked.length === 0) {
    console.log("- none");
  } else {
    for (const vuln of triage.blocked) {
      console.log(`- [${vuln.severity}] ${vuln.name}`);
    }
  }
}

function main() {
  if (!fs.existsSync(fullPath)) {
    console.error(`Audit file not found: ${fullPath}`);
    process.exit(2);
  }

  const report = loadReport(fullPath);
  const triage = summarize(report);
  printSummary(report, triage);

  const criticalOrHighBlocked = triage.blocked.filter(
    (v) => v.severity === "critical" || v.severity === "high"
  );
  if (criticalOrHighBlocked.length > 0) {
    process.exitCode = 1;
  }
}

main();
