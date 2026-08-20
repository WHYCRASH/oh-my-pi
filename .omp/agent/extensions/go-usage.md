# go-usage — OpenCode Go Usage for Oh My Pi

> **Location:** `~/.omp/agent/extensions/go-usage.ts` (single auto-discovered file)
> **Command:** `/go-usage [--model=<id>] [--refresh] [--debug] [--sort=<key>] [--order=<asc|desc>]`
> **AA cache:** `~/.omp/cache/go-usage-aa.json` (24h TTL, `api/v2/language/models/free` `x-api-key: $AANAL_API_KEY` `100/day`)
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
- **Table** — `Model (24ch) | $/req (4dp) | Requests (remaining/total) | AA Rank | AA $/task`, sorted by `sortKey` (default `aaRank` asc; `—` sinks). Columns: `$/req` via `trackerRequestCost` (effective prices at $60 credit, `0.05*input+0.95*cachedWrite` heuristic), `Requests` = `floor(promptsPerMonth*(1-monthly.percent/100))` / `promptsPerMonth` (missing → `—`), `AA Rank` (intelligence `v4.1` sort desc) + `AA $/task` (`cost_per_task.total_cost`) from `api/v2/language/models/free` (cache `~/.omp/cache/go-usage-aa.json`, 24h TTL). Truncate model names to 24ch; current row `bold+reverse-video` in sorted position.
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

| AA cache | label | when |
|---|---|---|
| `fresh AA` | live | fetch within 24h |
| `cached AA` | cached | network/parse failure |
| `—` | — | no cache & fetch fails (degraded) |

**Sorting** — CLI flags (report is static, no live key handler): `/go-usage s` cycles `aaRank → dollarsPerRequest → requestsRemaining → aaCostPerTask → name` (header shows `▴/▾`), `S` flips `asc/desc`. Programmatic: `--sort=<key> --order=<asc|desc>`. Missing AA ranks/costs sort as `Infinity` so they sink. `tableLines(enriched, currentId, sortKey, sortDir)` is pure and unit-testable.

**Tracker** — `loadTrackerData()` reads `ocgo-price-tracker/data/latest.json` via `Bun.file().json()` (non-blocking, `try/catch` → banner `tracker data unavailable — $/req hidden`). Cheapest tier per normalized name wins (e.g. Luna ≤272K vs >272K); `ALIAS` map handles mismatches (`claude-sonnet-4` etc). Unmatched → `—` for $/req, or `allowance/promptsPerMonth` estimate when tracker missing (e.g. new Muse Spark 60/226600≈$0.0003).

**AA scrape** — free API `https://artificialanalysis.ai/api/v2/language/models/free` (`x-api-key: $AANAL_API_KEY` from `~/dotfiles/.env:14` `aa_erSKIc…`, `process.env.AANAL_API_KEY` precedence, `chmod 600`). `fetchAANALAll()` paginates `?page=1..4` (`page_size 200`, `has_more`), maps `slug`/`name` → `normalizedName`, `evaluations.artificial_analysis_intelligence_index` (sort desc → `rank`), `artificial_analysis_intelligence_index_cost.cost_per_task.total_cost` → `costPerTask`, `pricing` passthrough, `agentic/coding` indices. `401`/`403`/`429` (`Retry-After`/`X-RateLimit-*` `100/day` free) degrade to `—` (`logger.warn`, never crash). Cache `~/.omp/cache/go-usage-aa.json` (`{fetchedAt, rows, intelligence_index_version 4.1}`) `24h` `TTL`, `mkdir -p`, de-duplicates by `normalizedName` cheapest `intelligence` kept. `ALIAS` handles `muse-spark-1.2-contributor` etc. Table shows `AA Rank` (intelligence) + `AA $/task` (cost per task).

## Verification

- `bun build go-usage.ts --target bun` (via `/tmp/guverify` symlink to `@oh-my-pi`)
- Smoke `buildReport` checks: no header/current marker, table first, usage after table, highlight ANSI, prompt sorting
- TUI: `/go-usage` shows logo, sorted table (MiMo V2.5 150k top or cheapest $/req), usage block before gauges; `--model=grok-4.5` single row; no-protocol (`TERM_PROGRAM=xterm`, empty Ghostty env) → text only, no bars
- `/go-usage --debug` logs Luna cost `0.0015` (list) / `0.0060` (effective)
- `/go-usage --sort=dollarsPerRequest --order=asc` cheapest $/req top; `/go-usage s` → next key, `/go-usage S` → flip dir (header `▴/▾`); report is static so `s`/`S` are CLI args, not live TUI keys
- Degraded: `mv data/latest.json data/latest.json.bak && /go-usage` → banner `tracker data unavailable`, other sections render
- AA: free API `api/v2/language/models/free` (`x-api-key: $AANAL_API_KEY`, `100/day` `X-RateLimit-*`) — cold `rm cache; /go-usage` → `≥5` rows (`intelligence`/`cost_per_task`), file `~/.omp/cache/go-usage-aa.json` created, warm `stat` unchanged, `--refresh` bump, `401`/`429` → `—` (still renders), `agentic`/`coding` indices also cached

## Pricing formula

`inputEffective = 0.05*input + 0.95*(cachedWrite ?? input)`
`requestCost = (inputEffective*pattern.input + cachedRead*pattern.cachedRead + output*pattern.output)/1e6`
Prices per 1M tokens, using `effectiveInput/effectiveOutput/effectiveCachedRead/effectiveCachedWrite` at `monthlyCredit 60` (basis `full`). Example Luna ≤272K: `0.2475*1000+0.02*50000+1.2*220=1511.5` → `$0.0015` at list, `$0.0060` at effective (×4). Footer note: `AA $/task from artificialanalysis.ai; not adjusted for OpenCode Go pricing`.

## Maintenance

- Update `EMBEDDED` when docs pricing changes (DeepSeek Flash now Off-Peak $15, etc.)
- Keep `CACHE_MAX_AGE_MS = 5*60*1000`; keep `GAUGE_WIDTH=480, HEIGHT=80`
- PNG helpers: `CRC_TABLE`, `crc32`, `pngChunk`, `encodePng`, `parseHex`, `mixRgb`, `inRoundRectXY`, `clampPct`
