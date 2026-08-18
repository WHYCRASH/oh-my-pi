# go-usage — OpenCode Go Usage for Oh My Pi

> **Location:** `~/.omp/agent/extensions/go-usage.ts` (single auto-discovered file)
> **Command:** `/go-usage [--model=<id>] [--refresh]`
> **TUI:** Ghostty/Kitty with `kitty-graphics` → logo + gauge PNGs; text fallback otherwise

## What it does

Shows live OpenCode Go usage windows and per-model allowances in one TUI card.

- **Live usage** — `GET https://opencode.ai/zen/go/v1/usage` (key from `OPENCODE_GO_API_KEY` or `~/.local/share/opencode/auth.json` → `opencode-go`). Displays `5h / wk / mo` as percent, dollar estimate (`≈$x of $N`), and `resets in …`. Handles 401/403 (`key rejected`) vs network failure (cached fallback) with `ctx.ui.notify`.
- **Limits & models** — parsed from `anomalyco/opencode:packages/web/src/content/docs/go.mdx`:
  - three `**… limit** — $N of usage` bullets → rolling/weekly/monthly caps
  - pipe tables `Model | Model ID` + `Model | Input | … | Usage` → `ModelAllowance[]`
  - requests table `requests per 5h / wk / mo` → `promptsPerMonth`
- **Caching** — `~/.omp/agent/go-usage-cache.json` (5 min TTL). On failure falls back to cache → embedded snapshot (20 models, 2026-08-16).

## Display

**Hybrid renderer** (`customType: "go-usage"` → `MessageRenderer<GoUsageDetails>`):

```
Container
 ├─ Image(OPENCODE_LOGO_B64, 36×10 cells)  ──┐ kitty only
 ├─ Text(buildReport)                         │ table immediately after logo
 └─ Image(buildGaugePng)                      ─┘ 480×80, directly after usage lines
```

- **Logo** — white-on-transparent `~/Downloads/opencode.png` (1282×230, 2.3 KB, base64 `OPENCODE_LOGO_B64`) via `Image` (`imageKey: go-usage-logo`).
- **Table** — `Model | Credit/mo | Prompts/mo`, sorted descending `promptsPerMonth` (missing → last, e.g. MiniMax M2.5 → `—`). Current model row is `bold + reverse-video` (`\x1b[1;7m`) in its sorted position; no `← current` marker, no `Current model:` line, no `--models:` label.
- **Usage block** — immediately before the gauge image so labels read as bar annotations (e.g. `5h 10% · ≈$1.20 of $12 · resets in 4h20m`). No header title; table is first content.
- **Gauges** — 3 pill bars (22 px, radius 11, 2 px track ring, transparent track, gradient fill `mix(accent,black,.25)→mix(accent,white,.7)`). Exported helpers: `encodePng`, `buildGaugePng`, `OPENCODE_LOGO_B64`.
- **Text fallback** — same report, no images, plain percents.

**Animation** — `AnimatedBars` widget (`placement: aboveEditor`, 14×30 ms ≈ 420 ms, ease-out cubic) fills colored `█`/`░` blocks (`coloredBlocks` green→red via `usageHueRgb`) before the card lands; `playFillAnimation` with watchdog.

**Mini-bar** — persistent 1-line widget `go-usage-minibar` top-right above editor border (`5h ████░░░░ NN%`, `MINIBAR_BLOCKS=8`). Installed on `pi.on("turn_start")` only for `opencode-go` models (`isOpenCodeGoModel` checks `provider` + `id` prefix). Refresh: per-prompt with 3-min gate + 5×10-min auto-checks per install cycle (`fromAuto` flag prevents re-arm loops; `absorb(usage, arm)`).

## Caching & fallbacks

| source | label | when |
|---|---|---|
| `fresh` | `live · HH:MM` | fetch within 5 min |
| `cached` | `cached · HH:MM` | network failure |
| `embedded` | `embedded snapshot` | no cache |

Old caches backfilled via `withEmbeddedPrompts()`.

## Verification

- `bun build go-usage.ts --target bun` (via `/tmp/guverify` symlink to `@oh-my-pi`)
- Smoke `buildReport` checks: no header/current marker, table first, usage after table, highlight ANSI, prompt sorting
- TUI: `/go-usage` shows logo, sorted table (MiMo V2.5 150k top), usage block before gauges; `--model=grok-4.5` single row; no-protocol (`TERM_PROGRAM=xterm`, empty Ghostty env) → text only, no bars

## Maintenance

- Update `EMBEDDED` when docs pricing changes (DeepSeek Flash now Off-Peak $15, etc.)
- Keep `CACHE_MAX_AGE_MS = 5*60*1000`; keep `GAUGE_WIDTH=480, HEIGHT=80`
- PNG helpers: `CRC_TABLE`, `crc32`, `pngChunk`, `encodePng`, `parseHex`, `mixRgb`, `inRoundRectXY`, `clampPct`
