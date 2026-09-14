#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const CONFIG_PATH = join(tmpdir(), `react-geiger-${process.pid}.json`);
const OUTPUT_PATH = "react-geiger.json";

const args = process.argv.slice(2);
const prIndex = args.indexOf("--pr");
const PR_MODE = prIndex !== -1;
const explicitBase =
  PR_MODE && args[prIndex + 1] && !args[prIndex + 1].startsWith("--")
    ? args[prIndex + 1]
    : null;

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 200,
    ...options,
  });
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function detectBaseRef() {
  const candidates = [];

  if (explicitBase) candidates.push(explicitBase);
  if (process.env.GITHUB_BASE_REF) {
    candidates.push(`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF);
  }

  candidates.push("origin/main", "main", "origin/master", "master");

  for (const candidate of candidates) {
    if (refExists(candidate)) return candidate;
  }

  throw new Error(
    [
      "Could not detect PR base branch.",
      "",
      "Run explicitly:",
      "",
      "  node react-geiger.mjs --pr origin/main",
      "",
    ].join("\n"),
  );
}

function isExcluded(file) {
  const normalized = file.replaceAll("\\", "/");
  const name = basename(normalized);

  if (
    normalized.includes("/__tests__/") ||
    normalized.includes("/__test__/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/e2e/") ||
    normalized.includes("/cypress/") ||
    /\.(test|spec|e2e)\.[jt]sx?$/.test(name)
  ) {
    return true;
  }

  if (
    normalized.includes("/storybook/") ||
    normalized.includes("/stories/") ||
    normalized.includes("/__stories__/") ||
    /\.(story|stories)\.[jt]sx?$/.test(name)
  ) {
    return true;
  }

  // Custom hook implementation files are supposed to use hooks.
  if (/^use(?:[A-Z0-9_-]).*\.[jt]sx?$/.test(name)) return true;

  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/build/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/generated/")
  ) {
    return true;
  }

  return false;
}

function isSourceFile(file) {
  return /\.[jt]sx?$/.test(file);
}

function getAllTrackedFiles() {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter(isSourceFile)
    .filter((file) => !isExcluded(file));
}

function getPrFiles() {
  const baseRef = detectBaseRef();
  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const changed = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    `${mergeBase}..HEAD`,
  ])
    .split("\0")
    .filter(Boolean);

  return {
    baseRef,
    mergeBase,
    changedFiles: changed,
    sourceFiles: changed.filter(isSourceFile).filter((file) => !isExcluded(file)),
  };
}

let scanMetadata;
let targetFiles;

if (PR_MODE) {
  const pr = getPrFiles();
  targetFiles = pr.sourceFiles;
  scanMetadata = {
    mode: "pr",
    baseRef: pr.baseRef,
    mergeBase: pr.mergeBase,
    head: git(["rev-parse", "HEAD"]).trim(),
    changedFiles: pr.changedFiles.length,
    scannedSourceFiles: targetFiles.length,
  };

  console.log(
    [
      "",
      "☢️  REACT GEIGER — PR MODE",
      "",
      `Base: ${pr.baseRef}`,
      `Merge base: ${pr.mergeBase.slice(0, 12)}`,
      `Changed files: ${pr.changedFiles.length}`,
      `Relevant source files: ${targetFiles.length}`,
      "",
    ].join("\n"),
  );
} else {
  targetFiles = getAllTrackedFiles();
  scanMetadata = { mode: "repository", scannedSourceFiles: targetFiles.length };
  console.log(`\n☢️  Scanning ${targetFiles.length.toLocaleString()} tracked source files...\n`);
}

if (targetFiles.length === 0) {
  console.log("✅ No relevant source files to scan.\n");
  process.exit(0);
}

const targetSet = new Set(targetFiles);

const hookDefinitions = [
  ["use-state", "useState"],
  ["use-effect", "useEffect"],
  ["use-layout-effect", "useLayoutEffect"],
  ["use-ref", "useRef"],
  ["use-memo", "useMemo"],
  ["use-callback", "useCallback"],
  ["use-reducer", "useReducer"],
];

function hookRule(id, hook) {
  return {
    id: `react-geiger.${id}`,
    languages: ["typescript", "javascript"],
    severity: "INFO",
    message: hook,
    "pattern-either": [
      { pattern: `${hook}(...)` },
      { pattern: `React.${hook}(...)` },
    ],
  };
}

const effectInside = {
  "pattern-either": [
    {
      "pattern-inside": `
        useEffect(() => {
          ...
        }, ...)
      `,
    },
    {
      "pattern-inside": `
        React.useEffect(() => {
          ...
        }, ...)
      `,
    },
  ],
};

const config = {
  rules: [
    ...hookDefinitions.map(([id, hook]) => hookRule(id, hook)),
    {
      id: "react-geiger.state-write-in-effect",
      languages: ["typescript", "javascript"],
      severity: "INFO",
      message: "state-looking setter inside effect",
      patterns: [
        effectInside,
        { pattern: "$SET(...)" },
        {
          "metavariable-regex": {
            metavariable: "$SET",
            regex: "^set[A-Z_].*",
          },
        },
      ],
    },
    {
      id: "react-geiger.multiple-state-writes-in-effect",
      languages: ["typescript", "javascript"],
      severity: "INFO",
      message: "multiple state-looking setters inside one effect",
      "pattern-either": [
        {
          patterns: [
            {
              pattern: `
                useEffect(() => {
                  ...
                  $SET1(...)
                  ...
                  $SET2(...)
                  ...
                }, ...)
              `,
            },
            { "metavariable-regex": { metavariable: "$SET1", regex: "^set[A-Z_].*" } },
            { "metavariable-regex": { metavariable: "$SET2", regex: "^set[A-Z_].*" } },
          ],
        },
        {
          patterns: [
            {
              pattern: `
                React.useEffect(() => {
                  ...
                  $SET1(...)
                  ...
                  $SET2(...)
                  ...
                }, ...)
              `,
            },
            { "metavariable-regex": { metavariable: "$SET1", regex: "^set[A-Z_].*" } },
            { "metavariable-regex": { metavariable: "$SET2", regex: "^set[A-Z_].*" } },
          ],
        },
      ],
    },
    {
      id: "react-geiger.fetch-in-effect",
      languages: ["typescript", "javascript"],
      severity: "WARNING",
      message: "fetch inside effect",
      patterns: [effectInside, { pattern: "fetch(...)" }],
    },
    {
      id: "react-geiger.async-iife-in-effect",
      languages: ["typescript", "javascript"],
      severity: "WARNING",
      message: "async workflow inside effect",
      patterns: [
        effectInside,
        {
          pattern: `
            (async () => {
              ...
            })()
          `,
        },
      ],
    },
    {
      id: "react-geiger.promise-in-effect",
      languages: ["typescript", "javascript"],
      severity: "INFO",
      message: "promise workflow inside effect",
      patterns: [effectInside, { pattern: "$X.then(...)" }],
    },
    {
      id: "react-geiger.ref-write",
      languages: ["typescript", "javascript"],
      severity: "INFO",
      message: ".current write",
      pattern: "$REF.current = $VALUE",
    },
  ],
};

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

let semgrepOutput;

try {
  const semgrepArgs = ["scan", "--config", CONFIG_PATH, "--json", "--quiet", "--metrics=off"];

  if (!PR_MODE) {
    semgrepArgs.push(
      "--exclude", "**/node_modules/**",
      "--exclude", "**/.next/**",
      "--exclude", "**/dist/**",
      "--exclude", "**/build/**",
      "--exclude", "**/coverage/**",
      "--exclude", "**/generated/**",
      "--exclude", "**/__tests__/**",
      "--exclude", "**/tests/**",
      "--exclude", "**/*.test.ts",
      "--exclude", "**/*.test.tsx",
      "--exclude", "**/*.spec.ts",
      "--exclude", "**/*.spec.tsx",
      "--exclude", "**/*.stories.ts",
      "--exclude", "**/*.stories.tsx",
      ".",
    );
  } else {
    semgrepArgs.push(...targetFiles);
  }

  semgrepOutput = execFileSync("semgrep", semgrepArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 500,
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("\nSemgrep isn't installed.\n\n  brew install semgrep\n");
    process.exit(1);
  }
  throw error;
} finally {
  try {
    unlinkSync(CONFIG_PATH);
  } catch {}
}

const semgrep = JSON.parse(semgrepOutput);
const files = new Map();

function getFile(path) {
  let file = files.get(path);
  if (!file) {
    file = {
      file: path,
      loc: 0,
      useState: 0,
      useEffect: 0,
      useLayoutEffect: 0,
      useRef: 0,
      useMemo: 0,
      useCallback: 0,
      useReducer: 0,
      stateWritesInEffects: 0,
      multiStateWriteEffects: 0,
      fetchesInEffects: 0,
      asyncIifesInEffects: 0,
      promisesInEffects: 0,
      refWrites: 0,
      _seen: new Map(),
    };
    files.set(path, file);
  }
  return file;
}

function resultSpan(result) {
  return [
    result.start?.line ?? 0,
    result.start?.col ?? 0,
    result.end?.line ?? 0,
    result.end?.col ?? 0,
  ].join(":");
}

function incrementUnique(file, field, result, customKey) {
  let seen = file._seen.get(field);
  if (!seen) {
    seen = new Set();
    file._seen.set(field, seen);
  }

  const key = customKey ?? resultSpan(result);
  if (seen.has(key)) return;
  seen.add(key);
  file[field]++;
}

function metavariable(result, name) {
  const variable = result.extra?.metavars?.[name];
  return variable?.abstract_content ?? variable?.match ?? null;
}

const ignoredSetters = new Set(["setTimeout", "setInterval", "setImmediate"]);

function containsIgnoredSetter(result) {
  for (const key of ["$SET", "$SET1", "$SET2"]) {
    const value = metavariable(result, key);
    if (value && ignoredSetters.has(value)) return true;
  }
  return false;
}

const hookIdToField = {
  "use-state": "useState",
  "use-effect": "useEffect",
  "use-layout-effect": "useLayoutEffect",
  "use-ref": "useRef",
  "use-memo": "useMemo",
  "use-callback": "useCallback",
  "use-reducer": "useReducer",
};

const behaviorIdToField = {
  "state-write-in-effect": "stateWritesInEffects",
  "multiple-state-writes-in-effect": "multiStateWriteEffects",
  "fetch-in-effect": "fetchesInEffects",
  "async-iife-in-effect": "asyncIifesInEffects",
  "promise-in-effect": "promisesInEffects",
  "ref-write": "refWrites",
};

for (const result of semgrep.results ?? []) {
  const path = result.path.replace(/^\.\//, "");
  if (!targetSet.has(path) || isExcluded(path)) continue;

  const id = result.check_id.replace(/^.*react-geiger\./, "");
  const file = getFile(path);
  const hookField = hookIdToField[id];

  if (hookField) {
    incrementUnique(file, hookField, result);
    continue;
  }

  const behaviorField = behaviorIdToField[id];
  if (!behaviorField) continue;

  if (
    (id === "state-write-in-effect" || id === "multiple-state-writes-in-effect") &&
    containsIgnoredSetter(result)
  ) {
    continue;
  }

  incrementUnique(file, behaviorField, result);
}

for (const file of files.values()) {
  try {
    file.loc = readFileSync(file.file, "utf8").split("\n").length;
  } catch {
    file.loc = 0;
  }
}

const severityWeight = { red: 100, orange: 10, yellow: 1 };

function signal(type, severity, count, reason) {
  return { type, severity, count, reason };
}

const rows = [];

for (const file of files.values()) {
  const {
    useState,
    useEffect,
    useLayoutEffect,
    useRef,
    useMemo,
    useCallback,
    useReducer,
    stateWritesInEffects,
    multiStateWriteEffects,
    fetchesInEffects,
    asyncIifesInEffects,
    promisesInEffects,
    refWrites,
  } = file;

  const primitiveHooks = useState + useEffect + useLayoutEffect + useRef + useReducer;
  const memoization = useMemo + useCallback;
  const totalHooks = primitiveHooks + memoization;
  const signals = [];

  if (fetchesInEffects > 0) {
    signals.push(signal(
      "DIY_SERVER_STATE",
      "red",
      fetchesInEffects,
      "fetch() is running inside useEffect; check whether query/mutation infrastructure should own this",
    ));
  }

  if (asyncIifesInEffects > 0) {
    signals.push(signal(
      "ASYNC_EFFECT_WORKFLOW",
      "red",
      asyncIifesInEffects,
      "async workflow is embedded inside useEffect",
    ));
  }

  if (
    multiStateWriteEffects >= 2 ||
    (multiStateWriteEffects >= 1 && (useState >= 5 || useEffect >= 3 || stateWritesInEffects >= 5))
  ) {
    signals.push(signal(
      "IMPLICIT_STATE_MACHINE",
      "red",
      multiStateWriteEffects,
      "effects coordinate multiple local state transitions; consider reducer/state machine/domain model",
    ));
  }

  if (useRef >= 5 && refWrites >= 5) {
    signals.push(signal(
      "IMPERATIVE_CONTROLLER",
      "red",
      refWrites,
      "heavy mutable ref activity; consider extracting a controller/class/store/imperative hook",
    ));
  }

  if (
    multiStateWriteEffects >= 1 &&
    !signals.some((entry) => entry.type === "IMPLICIT_STATE_MACHINE")
  ) {
    signals.push(signal(
      "MULTI_STATE_EFFECT",
      "orange",
      multiStateWriteEffects,
      "at least one effect updates multiple state-like values",
    ));
  }

  if (useEffect >= 3) {
    signals.push(signal(
      "EFFECT_SOUP",
      "orange",
      useEffect,
      "many effects in one file; inspect synchronization boundaries",
    ));
  }

  if (useState >= 8) {
    signals.push(signal(
      "STATE_SOUP",
      "orange",
      useState,
      "large amount of local state; check for hidden state model",
    ));
  } else if (useState >= 5) {
    signals.push(signal(
      "STATE_SOUP",
      "yellow",
      useState,
      "local state is becoming substantial",
    ));
  }

  if (useLayoutEffect >= 2) {
    signals.push(signal(
      "LIFECYCLE_SOUP",
      "orange",
      useLayoutEffect,
      "multiple synchronous lifecycle effects",
    ));
  }

  if (
    useRef >= 3 &&
    refWrites >= 3 &&
    !signals.some((entry) => entry.type === "IMPERATIVE_CONTROLLER")
  ) {
    signals.push(signal(
      "MUTABLE_SUBSYSTEM",
      "orange",
      useRef,
      "multiple refs plus .current mutation suggest imperative mutable state",
    ));
  } else if (useRef >= 3) {
    signals.push(signal(
      "MUTABLE_SUBSYSTEM",
      "yellow",
      useRef,
      "many refs; inspect whether mutable state wants a dedicated abstraction",
    ));
  }

  if (stateWritesInEffects >= 3) {
    signals.push(signal(
      "STATE_WRITE_IN_EFFECT",
      "yellow",
      stateWritesInEffects,
      "effects perform multiple state-looking writes",
    ));
  }

  if (
    refWrites >= 5 &&
    useRef > 0 &&
    !signals.some((entry) => entry.type === "IMPERATIVE_CONTROLLER")
  ) {
    signals.push(signal(
      "MUTABLE_REF_WRITES",
      "yellow",
      refWrites,
      "frequent .current mutation",
    ));
  }

  if (promisesInEffects > 0) {
    signals.push(signal(
      "PROMISE_WORK_IN_EFFECT",
      "yellow",
      promisesInEffects,
      "promise workflow embedded inside effect",
    ));
  }

  if (memoization >= 15) {
    signals.push(signal(
      "MEMOIZATION_SATURATION",
      "yellow",
      memoization,
      "heavy useMemo/useCallback usage; possible referential-stability ceremony",
    ));
  }

  if (signals.length === 0) continue;

  const redCount = signals.filter((entry) => entry.severity === "red").length;
  const orangeCount = signals.filter((entry) => entry.severity === "orange").length;
  const yellowCount = signals.filter((entry) => entry.severity === "yellow").length;
  const highestSeverity = redCount > 0 ? "red" : orangeCount > 0 ? "orange" : "yellow";
  const memoOnly = signals.every((entry) => entry.type === "MEMOIZATION_SATURATION");

  const rank =
    redCount * 1000 +
    orangeCount * 100 +
    yellowCount * 10 +
    useEffect * 3 +
    useState +
    useRef * 2 +
    multiStateWriteEffects * 5 +
    stateWritesInEffects * 0.5 +
    refWrites * 0.5;

  rows.push({
    file: file.file,
    loc: file.loc,
    useState,
    useEffect,
    useLayoutEffect,
    useRef,
    useMemo,
    useCallback,
    useReducer,
    stateWritesInEffects,
    multiStateWriteEffects,
    fetchesInEffects,
    asyncIifesInEffects,
    promisesInEffects,
    refWrites,
    primitiveHooks,
    memoization,
    totalHooks,
    hookDensity: file.loc > 0 ? +((totalHooks / file.loc) * 100).toFixed(2) : 0,
    highestSeverity,
    redCount,
    orangeCount,
    yellowCount,
    memoOnly,
    signals,
    rank: +rank.toFixed(1),
  });
}

rows.sort((a, b) => b.rank - a.rank);

const architectural = rows.filter(
  (row) => !row.memoOnly && (row.redCount > 0 || row.orangeCount > 0),
);
const advisory = rows.filter(
  (row) => !row.memoOnly && row.redCount === 0 && row.orangeCount === 0,
);
const memoOnly = rows.filter((row) => row.memoOnly);

function severityIcon(severity) {
  if (severity === "red") return "🔴";
  if (severity === "orange") return "🟠";
  return "🟡";
}

function compactSignals(row) {
  return row.signals
    .filter((entry) => entry.type !== "MEMOIZATION_SATURATION")
    .map((entry) => `${severityIcon(entry.severity)} ${entry.type}:${entry.count}`)
    .join(" ");
}

function printRows(title, list, limit = 100) {
  console.log(`\n${title}\n`);
  if (list.length === 0) {
    console.log("None.\n");
    return;
  }

  console.table(
    list.slice(0, limit).map((row) => ({
      severity: severityIcon(row.highestSeverity),
      file: row.file,
      loc: row.loc,
      state: row.useState,
      effect: row.useEffect,
      ref: row.useRef,
      "set/effect": row.stateWritesInEffects,
      "multi/effect": row.multiStateWriteEffects,
      fetch: row.fetchesInEffects,
      async: row.asyncIifesInEffects,
      ".current": row.refWrites,
      signals: compactSignals(row),
    })),
  );
}

console.log("\n☢️  REACT GEIGER SUMMARY\n");
console.table([
  { category: "🔴 red files", files: rows.filter((row) => row.redCount > 0).length },
  {
    category: "🟠 orange files",
    files: rows.filter((row) => row.redCount === 0 && row.orangeCount > 0).length,
  },
  { category: "🟡 advisory-only", files: advisory.length },
  { category: "🧠 memo-only", files: memoOnly.length },
  { category: "🚨 architectural smoke", files: architectural.length },
]);

printRows("🚨 ARCHITECTURAL SMOKE", architectural, PR_MODE ? 200 : 100);
printRows("🟡 ADVISORY ONLY", advisory, PR_MODE ? 100 : 30);

console.log("\n🧠 MEMOIZATION-ONLY FILES\n");
if (memoOnly.length === 0) {
  console.log("None.\n");
} else {
  console.table(
    memoOnly.slice(0, PR_MODE ? 100 : 30).map((row) => ({
      file: row.file,
      loc: row.loc,
      useMemo: row.useMemo,
      useCallback: row.useCallback,
      total: row.memoization,
      density: row.hookDensity,
    })),
  );
}

const signalCounts = {};
for (const row of rows) {
  for (const entry of row.signals) {
    const current = signalCounts[entry.type] ?? {
      signal: entry.type,
      severity: entry.severity,
      files: 0,
    };
    current.files++;
    if (severityWeight[entry.severity] > severityWeight[current.severity]) {
      current.severity = entry.severity;
    }
    signalCounts[entry.type] = current;
  }
}

console.log("\n📡 SIGNAL COUNTS\n");
console.table(
  Object.values(signalCounts)
    .sort(
      (a, b) =>
        severityWeight[b.severity] - severityWeight[a.severity] || b.files - a.files,
    )
    .map((entry) => ({
      severity: severityIcon(entry.severity),
      signal: entry.signal,
      files: entry.files,
    })),
);

const report = {
  generatedAt: new Date().toISOString(),
  scan: scanMetadata,
  semgrepMatches: semgrep.results?.length ?? 0,
  summary: {
    filesWithAnySignal: rows.length,
    architecturalSmoke: architectural.length,
    redFiles: rows.filter((row) => row.redCount > 0).length,
    orangeFiles: rows.filter((row) => row.redCount === 0 && row.orangeCount > 0).length,
    advisoryOnly: advisory.length,
    memoOnly: memoOnly.length,
  },
  signalCounts,
  architectural,
  advisory,
  memoOnly,
  files: rows,
};

writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

console.log(
  [
    "",
    `✅ Wrote ${OUTPUT_PATH}`,
    "",
    PR_MODE
      ? `PR: ${architectural.length} architectural smoke file(s) across ${targetFiles.length} changed source file(s).`
      : `Repo: ${architectural.length} architectural smoke file(s).`,
    "",
  ].join("\n"),
);
