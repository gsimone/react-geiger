# react-geiger ☢️

A fast architectural smoke detector for React codebases.

It does **not** try to prove that code is wrong. It looks for concentrations and combinations of low-level React primitives that make a reviewer want to look closer.

Examples:

- lots of `useState` + effects coordinating state → possible implicit state machine
- lots of refs + `.current` writes → possible imperative controller trapped in a component
- `fetch()` inside `useEffect` → possible DIY server state
- lots of `useMemo` / `useCallback` → possible referential-stability ceremony

Tests, stories, generated output, and `use*.ts(x)` custom-hook implementation files are excluded by default.

## Requirements

- Node.js 20+
- Git
- Semgrep

```bash
brew install semgrep
```

## Run it

Clone the repo or copy `react-geiger.mjs` into the root of a Git repository.

Whole repository:

```bash
node react-geiger.mjs
```

Current branch as a PR against the auto-detected default branch:

```bash
node react-geiger.mjs --pr
```

Explicit base:

```bash
node react-geiger.mjs --pr origin/main
```

PR mode only scans changed JS/TS source files.

## Signals

### 🔴 Red

High-value review targets:

- `DIY_SERVER_STATE`
- `ASYNC_EFFECT_WORKFLOW`
- `IMPLICIT_STATE_MACHINE`
- `IMPERATIVE_CONTROLLER`

### 🟠 Orange

Strong architectural smoke:

- `MULTI_STATE_EFFECT`
- `EFFECT_SOUP`
- large `STATE_SOUP`
- `LIFECYCLE_SOUP`
- active `MUTABLE_SUBSYSTEM`

### 🟡 Yellow

Useful supporting evidence:

- smaller `STATE_SOUP`
- passive `MUTABLE_SUBSYSTEM`
- `STATE_WRITE_IN_EFFECT`
- `MUTABLE_REF_WRITES`
- `PROMISE_WORK_IN_EFFECT`
- `MEMOIZATION_SATURATION`

Memoization-only findings are kept separate from the main architectural-smoke list.

## Output

The terminal shows ranked findings and `react-geiger.json` contains the full machine-readable report.

The ranking is only presentation order. It is **not** intended to be a code-quality score.

## Why

LLMs are very good at expanding a semantic operation into locally plausible React machinery:

- workflow → boolean state + effects
- server state → local `data/loading/error` + effect
- mutable subsystem → refs
- synchronization → more effects

Those implementations can look reasonable line-by-line while being architecturally wrong for the codebase.

`react-geiger` is meant to make those changes noisy in review.

## Status

Very early experiment. Current analysis is deliberately Semgrep-first and approximate. The intended next step is an AST/semantic pass for suspicious files only.
