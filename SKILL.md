---
name: react-geiger
description: Scan a React codebase (or a PR diff) for architectural smoke — DIY server state, effect-driven state machines, imperative ref controllers, effect/state soup — and turn the findings into a review. Use when reviewing React changes, auditing a React repo's architecture, or when asked to run react-geiger.
---

# react-geiger

A Semgrep-backed detector for concentrations of low-level React primitives that
usually mean a semantic operation got expanded into hand-rolled machinery
(workflow → booleans + effects, server state → `data/loading/error` + effect,
mutable subsystem → refs).

It finds review targets. It does **not** prove anything is wrong, and it is not a
quality score. Every finding needs a read of the actual file before you act on it.

## Requirements

- Node.js 20+, Git, and [Semgrep](https://semgrep.dev) on `PATH` (`brew install semgrep`).
- Run from the **root of the target Git repository** — the scan uses `git ls-files`
  and writes `react-geiger.json` into the current directory.

If Semgrep is missing the tool exits 1 with `Semgrep isn't installed.` Install it
and rerun; there is no fallback.

## Run it

```bash
# whole repository
npx --yes github:gsimone/react-geiger

# current branch as a PR against the auto-detected default branch
npx --yes github:gsimone/react-geiger --pr

# explicit base
npx --yes github:gsimone/react-geiger --pr origin/main
```

Note: the `react-geiger` package on npm is an unrelated project. Install from
GitHub, or run `node react-geiger.mjs` from a checkout.

Use `--pr` when reviewing a change — it scans only changed JS/TS source files and
is much faster. Use full-repo mode for an architecture audit.

Base detection order: explicit arg → `origin/$GITHUB_BASE_REF` → `origin/main` →
`main` → `origin/master` → `master`. If none resolve it errors; pass the base
explicitly.

Tests, stories, `dist`/`build`/`.next`/`coverage`/`generated`, and `use*.ts(x)`
custom-hook implementation files are excluded by default — hook files are
*supposed* to use hooks.

**The exit code is 0 even when there are findings.** To gate CI, read the JSON.

## Read the results

Terminal output is a summary. The full report is `react-geiger.json`:

| Key | What's in it |
| --- | --- |
| `scan` | mode, base ref, merge base, file counts |
| `summary` | counts by severity bucket |
| `signalCounts` | which signals fired, and in how many files |
| `architectural` | **start here** — files with red or orange signals, ranked |
| `advisory` | yellow-only files |
| `memoOnly` | files whose only signal is memoization saturation |
| `files` | every file with any signal |

Each row carries per-file hook counts (`useState`, `useEffect`, `useRef`, …),
behavior counts (`fetchesInEffects`, `multiStateWriteEffects`, `refWrites`, …),
and a `signals` array of `{ type, severity, count, reason }`.

Triage quickly with:

```bash
jq -r '.architectural[] | "\(.file)  \([.signals[] | "\(.type):\(.count)"] | join(" "))"' react-geiger.json
```

`rank` is presentation order only. Do not report it as a score.

## What the signals mean

### 🔴 Red — read the file

| Signal | Fires when | Ask |
| --- | --- | --- |
| `DIY_SERVER_STATE` | `fetch()` inside `useEffect` | Should the repo's query/mutation layer own this instead? |
| `ASYNC_EFFECT_WORKFLOW` | async IIFE inside `useEffect` | Is a multi-step workflow living in a lifecycle hook? |
| `IMPLICIT_STATE_MACHINE` | effects write several state values, or one does alongside heavy state/effect use | Is there an unnamed state machine here? Reducer, machine, or domain model? |
| `IMPERATIVE_CONTROLLER` | ≥5 refs and ≥5 `.current` writes | Should this be a class/store/controller living outside React? |

### 🟠 Orange — architectural smoke

`MULTI_STATE_EFFECT` (an effect updates multiple state-like values),
`EFFECT_SOUP` (≥3 effects — inspect synchronization boundaries),
`STATE_SOUP` (≥8 `useState`), `LIFECYCLE_SOUP` (≥2 `useLayoutEffect`),
`MUTABLE_SUBSYSTEM` (≥3 refs *with* ≥3 `.current` writes).

### 🟡 Yellow — supporting evidence only

`STATE_SOUP` (5–7 `useState`), passive `MUTABLE_SUBSYSTEM` (≥3 refs, few writes),
`STATE_WRITE_IN_EFFECT` (≥3 setter calls in effects), `MUTABLE_REF_WRITES`
(≥5 `.current` writes), `PROMISE_WORK_IN_EFFECT` (a `.then` chain in an effect),
`MEMOIZATION_SATURATION` (≥15 `useMemo`/`useCallback`).

Yellow alone is not worth raising. It corroborates a red or orange finding in the
same file.

## What a detection looks like

```javascript
function UserProfile({ userId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [userId]);
}
```

Three signals fire here: `DIY_SERVER_STATE` (fetch in effect),
`PROMISE_WORK_IN_EFFECT` (`.then` chain), and `STATE_SOUP` if the file has enough
sibling state. The review question is whether the codebase already has server-state
infrastructure this should route through.

## Turning a scan into a review

1. Run with `--pr` against the review base.
2. Take `.architectural`, highest rank first.
3. **Open each file.** The analysis is Semgrep-pattern level and approximate — it
   counts primitives, it does not understand the code.
4. Keep only findings where the code really is the pattern the signal names, then
   report each as: file, signal, what it actually looks like, and the architectural
   alternative you'd propose.
5. Drop the rest. False positives are expected and are not a reason to restructure
   working code.

Do not mechanically "fix" findings, do not quote counts as a score, and do not
report a file you have not read.

## Caveats

- Setter detection is name-based (`set[A-Z_]…`), so non-`set*` state updaters are
  missed and `setFoo`-shaped plain functions are counted. `setTimeout`,
  `setInterval`, and `setImmediate` are already excluded.
- Only `useEffect` bodies are inspected for embedded work — not `useLayoutEffect`.
- `react-geiger.json` is written to the working directory. It is already gitignored
  in this repo; add it elsewhere.
