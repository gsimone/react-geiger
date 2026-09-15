---
name: react-geiger
description: Detect architectural anti-patterns in React codebases using static analysis
---

# react-geiger

A fast architectural smoke detector for React codebases. It identifies concentrations and combinations of React primitives that warrant closer review—not to prove code is wrong, but to make architectural issues visible during code review.

## Installation

### Prerequisites

- Node.js 20+
- Git
- Semgrep (`brew install semgrep`)

### Setup

Copy `react-geiger.mjs` into the root of your Git repository or install via npm:

```bash
npm install react-geiger
```

## Running react-geiger

### Full repository scan

Analyze your entire codebase:

```bash
node react-geiger.mjs
```

### Scan current branch as a PR

Analyze only changed files on your current branch, compared against the auto-detected default branch:

```bash
node react-geiger.mjs --pr
```

### Scan against an explicit base

Compare your current branch against a specific base branch:

```bash
node react-geiger.mjs --pr origin/main
```

PR mode scans only changed JS/TS source files for efficiency.

## Understanding the signals

react-geiger ranks findings by architectural severity. Tests, stories, generated output, and `use*.ts(x)` custom-hook files are excluded by default.

### 🔴 Red — High-value review targets

- **DIY_SERVER_STATE**: Fetch calls inside effects, reinventing server state management
- **ASYNC_EFFECT_WORKFLOW**: Effects coordinating async workflows without a proper state machine
- **IMPLICIT_STATE_MACHINE**: Multiple useState + coordinated effects that should be one machine
- **IMPERATIVE_CONTROLLER**: Refs and `.current` writes trapped in a component

### 🟠 Orange — Strong architectural smoke

- **MULTI_STATE_EFFECT**: Effects that manage multiple state variables
- **EFFECT_SOUP**: Dense effect coordination
- **STATE_SOUP**: Many useState calls (large concentrations)
- **LIFECYCLE_SOUP**: Complex lifecycle coordination
- **MUTABLE_SUBSYSTEM**: Active ref-based controllers

### 🟡 Yellow — Supporting evidence

- **STATE_SOUP** (smaller): Moderate useState concentration
- **MUTABLE_SUBSYSTEM** (passive): Immutable ref usage
- **STATE_WRITE_IN_EFFECT**: Effects that write to state
- **MUTABLE_REF_WRITES**: Ref mutations
- **PROMISE_WORK_IN_EFFECT**: Unhandled promises in effects
- **MEMOIZATION_SATURATION**: Heavy memoization patterns (listed separately)

## Output

Terminal output shows ranked findings with severity indicators. The machine-readable report is saved to `react-geiger.json`.

The ranking is presentation order only — not a code-quality score. Use it as a guide for what to review closely, not as a metric.

## Workflow

1. **Run the scan** on your codebase or PR
2. **Review red findings** first — they're high-signal architectural issues
3. **Investigate orange findings** as supporting evidence for refactoring discussions
4. **Use yellow findings** to understand context and supporting patterns
5. **Redesign if needed** — react-geiger points at symptoms; you diagnose the root architecture

## Example: Detecting DIY server state

```javascript
// react-geiger detects this pattern
function UserProfile({ userId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(e => setError(e))
      .finally(() => setLoading(false));
  }, [userId]);

  // render...
}
```

This triggers `DIY_SERVER_STATE` because the component is reinventing server state management with three coordinated state variables and fetch inside an effect. A proper server-state library (SWR, React Query, Apollo) would be the fix.

## Why react-geiger exists

LLMs are good at expanding semantic operations into locally plausible React machinery. An `useEffect` with `fetch` reads line-by-line, but when scaled across a codebase creates brittleness. react-geiger makes those anti-patterns visible in review so they can be caught before shipping.
