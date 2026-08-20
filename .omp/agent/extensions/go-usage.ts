/**
 * go-usage — OpenCode Go usage limits in the OMP TUI.
 *
 * Data sources:
 *  - Live usage windows: GET https://opencode.ai/zen/go/v1/usage
 *    (Bearer token = opencode-go API key from ~/.local/share/opencode/auth.json
 *     or the OPENCODE_GO_API_KEY env var). Returns percent-of-limit per window:
 *     { usage: { rolling: {status, percent, resetsAt}, weekly: {...}, monthly: {...} } }
 *  - Dollar limits and per-model monthly allowances: raw docs markdown
 *    (anomalyco/opencode repo, packages/web/src/content/docs/go.mdx), parsed for
 *    the three "**… limit** — $N of usage" bullets and the two pipe tables
 *    (endpoints: Model → Model ID; price: Model → Usage allowance). Cached in
 *    ~/.omp/agent/go-usage-cache.json after each successful parse, with an
 *    embedded snapshot as the last-resort fallback.
 *
 * Display is hybrid: the handler sends a plain-text report as `content` plus a
 * kitty-graphics PNG of three usage gauges in `details`. A registered
 * MessageRenderer for customType "go-usage" renders the report as a theme-aware
 * card: on terminals with an image protocol (Ghostty/kitty) it leads with the
 * embedded OpenCode logo, the per-window figures, the sorted model table, and
 * the gauge image; terminals without one render the same text report (percents
 * and dollar figures only — no ASCII bars anywhere). Right before the card
 * lands, a short widget animation plays the three windows filling up as
 * colored green→red bars (TUI only). While an opencode-go model is selected, a
 * small persistent 5h-usage bar sits at the top-right of the prompt window,
 * refreshed on every prompt (3-minute gate) and by up to 5 automatic
 * 10-minute checks.
 */
import { Container, Image, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
import type {
	CustomMessage,
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderOptions,
	MessageRenderer,
} from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DOCS_URL =
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx";
const CACHE_FILE = path.join(os.homedir(), ".omp", "agent", "go-usage-cache.json");
const AUTH_FILE = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 min — fresh data most of the time; cache only rides out brief outages
const CUSTOM_TYPE = "go-usage";

const TRACKER_DATA_PATH = "/home/dautist/Github-Repos/ocgo-price-tracker/data/latest.json";
const AA_CACHE_FILE = path.join(os.homedir(), ".omp", "cache", "go-usage-aa.json");
const AA_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const AA_URLS = [
	"https://artificialanalysis.ai/leaderboards/models",
	"https://artificialanalysis.ai/models",
	"https://artificialanalysis.ai/text/leaderboard/model-ranking",
	"https://artificialanalysis.ai/text/leaderboard",
];
const AA_FETCH_TIMEOUT_MS = 10000;

class UsageKeyRejectedError extends Error {
	constructor() {
		super("usage key rejected");
		this.name = "UsageKeyRejectedError";
	}
}

const WIDGET_KEY = "go-usage";
const ANIM_FRAMES = 14; // quick bar-fill animation (~420ms) before the report card lands
const ANIM_INTERVAL_MS = 30;

const MINIBAR_KEY = "go-usage-minibar";
const MINIBAR_FETCH_GATE_MS = 3 * 60 * 1000; // at most one usage fetch per prompt within 3 min
const MINIBAR_AUTO_INTERVAL_MS = 10 * 60 * 1000;
const MINIBAR_AUTO_MAX = 5; // automatic 10-min refreshes per install cycle
const MINIBAR_BLOCKS = 8;


const FALLBACK_ACCENT = "#89b4fa"; // catppuccin blue
const FALLBACK_TRACK = "#6c7086"; // catppuccin overlay

const GAUGE_WIDTH = 480;
const GAUGE_HEIGHT = 80;

const OPENCODE_LOGO_B64 = "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";

const LOGO_MAX_WIDTH_CELLS = 36;
const LOGO_MAX_HEIGHT_CELLS = 10;


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WindowUsage {
	status: string;
	percent: number;
	resetsAt: string;
}

interface UsageData {
	rolling: WindowUsage;
	weekly: WindowUsage;
	monthly: WindowUsage;
}

interface ModelAllowance {
	displayName: string;
	id: string;
	allowance: number; // monthly usage allowance in dollars (15 | 60)
	/** Official estimated requests/month from the docs table; absent for models the docs don't price-estimate. */
	promptsPerMonth?: number;
}

interface DocsData {
	limits: { rolling: number; weekly: number; monthly: number };
	models: ModelAllowance[];
}

interface CacheData extends DocsData {
	fetchedAt: string;
}

type DocsSource = "fresh" | "cached" | "embedded";

interface ResolvedDocs {
	data: DocsData;
	source: DocsSource;
	fetchedAt?: string;
}

interface GoUsageDetails {
	pngBase64: string;
	pngWidth: number;
	pngHeight: number;
}

interface TrackerPattern {
	input: number;
	cachedRead: number;
	output: number;
}

interface TrackerModel {
	name: string;
	tier: string | null;
	usage: number;
	pattern: TrackerPattern | null;
	effectiveInput: number | null;
	effectiveOutput: number | null;
	effectiveCachedRead: number | null;
	effectiveCachedWrite: number | null;
}

interface TrackerData {
	monthlyCredit: number;
	monthlyCost: number;
	models: TrackerModel[];
}

interface AARow {
	normalizedName: string;
	displayName: string;
	rank: number;
	costPerTask: number | null;
	qualityIndex?: number;
}

interface AACache {
	fetchedAt: string;
	rows: AARow[];
}

interface EnrichedModel extends ModelAllowance {
	dollarsPerRequest: number | null;
	requestsTotal: number | null;
	requestsRemaining: number | null;
	aaRank: number | null;
	aaCostPerTask: number | null;
}

type SortKey = "name" | "dollarsPerRequest" | "requestsRemaining" | "aaRank" | "aaCostPerTask";
type SortDir = "asc" | "desc";



// ---------------------------------------------------------------------------
// Embedded fallback snapshot (captured 2026-08-16 from the docs markdown)
// ---------------------------------------------------------------------------

const EMBEDDED: DocsData = {
	limits: { rolling: 12, weekly: 30, monthly: 60 },
	models: [
		{ displayName: "Grok 4.5", id: "grok-4.5", allowance: 15, promptsPerMonth: 600 },
		{ displayName: "GPT 5.6 Luna (≤ 272K tokens)", id: "gpt-5.6-luna", allowance: 15, promptsPerMonth: 10250 },
		{ displayName: "GLM-5.3", id: "glm-5.3", allowance: 15, promptsPerMonth: 1080 },
		{ displayName: "GLM-5.2", id: "glm-5.2", allowance: 60, promptsPerMonth: 4300 },
		{ displayName: "GLM-5.1", id: "glm-5.1", allowance: 60, promptsPerMonth: 4300 },
		{ displayName: "Kimi K3", id: "kimi-k3", allowance: 15, promptsPerMonth: 490 },
		{ displayName: "Kimi K2.7 Code", id: "kimi-k2.7-code", allowance: 60, promptsPerMonth: 6750 },
		{ displayName: "Kimi K2.6", id: "kimi-k2.6", allowance: 60, promptsPerMonth: 5750 },
		{ displayName: "MiMo V2.5", id: "mimo-v2.5", allowance: 60, promptsPerMonth: 150400 },
		{ displayName: "MiMo V2.5 Pro", id: "mimo-v2.5-pro", allowance: 15, promptsPerMonth: 16300 },
		{ displayName: "MiniMax M3", id: "minimax-m3", allowance: 60, promptsPerMonth: 16000 },
		{ displayName: "MiniMax M2.7", id: "minimax-m2.7", allowance: 60, promptsPerMonth: 17000 },
		{ displayName: "MiniMax M2.5", id: "minimax-m2.5", allowance: 60 }, // no request estimate in docs
		{ displayName: "Qwen3.8 Max", id: "qwen3.8-max", allowance: 15, promptsPerMonth: 810 },
		{ displayName: "Qwen3.7 Max", id: "qwen3.7-max", allowance: 60, promptsPerMonth: 1690 },
		{ displayName: "Qwen3.7 Plus (≤ 256K tokens)", id: "qwen3.7-plus", allowance: 60, promptsPerMonth: 21600 },
		{ displayName: "Qwen3.6 Plus (≤ 256K tokens)", id: "qwen3.6-plus", allowance: 60, promptsPerMonth: 16300 },
		{ displayName: "DeepSeek V4 Pro (Off-Peak)", id: "deepseek-v4-pro", allowance: 15, promptsPerMonth: 5200 },
		{ displayName: "DeepSeek V4 Flash (Off-Peak)", id: "deepseek-v4-flash", allowance: 15, promptsPerMonth: 18900 },
		{ displayName: "Hy3", id: "hy3", allowance: 60, promptsPerMonth: 21500 },
	],
};

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string | null> {
	const envKey = process.env.OPENCODE_GO_API_KEY;
	if (envKey) return envKey;
	try {
		const raw = await readFile(AUTH_FILE, "utf8");
		const parsed = JSON.parse(raw) as Record<string, { key?: unknown } | undefined>;
		const key = parsed?.["opencode-go"]?.key;
		return typeof key === "string" && key.length > 0 ? key : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

async function fetchUsage(key: string): Promise<UsageData> {
	let res: Response;
	try {
		res = await fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		throw new Error("network error");
	}
	if (res.status === 401 || res.status === 403) throw new UsageKeyRejectedError();
	if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
	const json: unknown = await res.json();
	const usage = (json as { usage?: unknown })?.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") throw new Error("unexpected usage API response");
	const window = (k: string): WindowUsage => {
		const v = usage[k] as Record<string, unknown> | undefined;
		return {
			status: typeof v?.status === "string" ? v.status : "ok",
			percent: Number(v?.percent) || 0,
			resetsAt: typeof v?.resetsAt === "string" ? v.resetsAt : "",
		};
	};
	return { rolling: window("rolling"), weekly: window("weekly"), monthly: window("monthly") };
}

// ---------------------------------------------------------------------------
// Docs markdown (limits + per-model allowances)
// ---------------------------------------------------------------------------

async function fetchDocs(): Promise<DocsData | null> {
	try {
		const res = await fetch(DOCS_URL, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) return null;
		const md = await res.text();
		const parsed = parseDocs(md);
		if (!parsed) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function parseDocs(md: string): DocsData | null {
	const limits = { rolling: 0, weekly: 0, monthly: 0 };
	for (const line of md.split("\n")) {
		const m = line.match(/\*\*([^*]+)\*\*\s*—\s*\$(\d+)\s+of\s+usage/);
		if (!m) continue;
		const label = m[1]!.toLowerCase();
		const value = Number(m[2]);
		if (label.includes("5 hour")) limits.rolling = value;
		else if (label.includes("weekly")) limits.weekly = value;
		else if (label.includes("monthly")) limits.monthly = value;
	}
	if (limits.rolling <= 0 || limits.weekly <= 0 || limits.monthly <= 0) return null;

	const endpoints = parsePipeTable(md, cells => cells[0] === "Model" && cells[1] === "Model ID");
	const priceRows = parsePipeTable(
		md,
		cells => cells[0] === "Model" && cells.includes("Input") && cells.includes("Output") && cells.includes("Usage"),
	);
	const requestRows = parsePipeTable(
		md,
		cells => cells[0] === "Model" && (cells[1] ?? "").includes("requests per"),
	);

	const idByName = new Map<string, string>();
	for (const row of endpoints) {
		const name = normalizeName(row[0] ?? "");
		const id = row[1]?.trim();
		if (name && id && !idByName.has(name)) idByName.set(name, id);
	}

	// Official estimated requests/month (the docs' own table). These estimates
	// already account for observed token patterns, caching and any pricing
	// modifiers — no manual multiplier is applied.
	const promptsByName = new Map<string, number>();
	for (const row of requestRows) {
		const name = normalizeName(cleanCell(row[0] ?? ""));
		const perMonth = parseCount(row[3]);
		if (name && perMonth !== null && !promptsByName.has(name)) promptsByName.set(name, perMonth);
	}

	const models: ModelAllowance[] = [];
	const seen = new Set<string>();
	for (const row of priceRows) {
		const display = cleanCell(row[0] ?? "");
		const name = normalizeName(display);
		const id = idByName.get(name);
		if (!name || !id || seen.has(id)) continue;
		const last = row[row.length - 1] ?? "";
		const allowance = Number((last.match(/\$(\d+)/) ?? [])[1]);
		if (!Number.isFinite(allowance) || allowance <= 0) continue;
		seen.add(id);
		models.push({ displayName: display, id, allowance, promptsPerMonth: promptsByName.get(name) });
	}

	return models.length > 0 ? { limits, models } : null;
}

/** Parse a possibly comma-grouped count cell; null when absent/not a positive number. */
function parseCount(cell: string | undefined): number | null {
	const n = Number((cell ?? "").replace(/[,\s]/g, ""));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Strip markdown links and backticks from a table cell. */
function cleanCell(cell: string): string {
	return cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, "").trim();
}

/**
 * Normalize a model display name to a comparable key. Docs tables disagree on
 * spelling between the price table ("MiMo V2.5") and the endpoints table
 * ("MiMo-V2.5"), so spaces collapse to hyphens; trailing context-parenthesized
 * variants ("GPT 5.6 Luna (≤ 272K tokens)") are dropped to share one key.
 */
function normalizeName(name: string): string {
	return name.toLowerCase().replace(/\s*\([^)]*\)\s*$/g, "").replace(/\s+/g, "-");
}

function parsePipeTable(md: string, isHeader: (cells: string[]) => boolean): string[][] {
	const rows: string[][] = [];
	let collecting = false;
	for (const raw of md.split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("|")) {
			if (collecting) break;
			continue;
		}
		let cells = line.split("|").map(c => c.trim());
		if (cells[0] === "") cells.shift();
		if (cells[cells.length - 1] === "") cells.pop();
		if (!collecting) {
			if (isHeader(cells)) collecting = true;
			continue;
		}
		if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // separator row
		rows.push(cells);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Docs cache
// ---------------------------------------------------------------------------

async function loadCache(): Promise<CacheData | null> {
	try {
		const raw = await readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as CacheData;
		if (
			typeof parsed.fetchedAt !== "string" ||
			!parsed.limits ||
			typeof parsed.limits.rolling !== "number" ||
			!Array.isArray(parsed.models)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function isCacheFresh(cache: CacheData): boolean {
	const t = Date.parse(cache.fetchedAt);
	return Number.isFinite(t) && Date.now() - t < CACHE_MAX_AGE_MS;
}

async function saveCache(data: DocsData): Promise<void> {
	try {
		await mkdir(path.dirname(CACHE_FILE), { recursive: true });
		const cache: CacheData = { fetchedAt: new Date().toISOString(), limits: data.limits, models: data.models };
		await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
	} catch {
		// Cache is best-effort; the command works without it.
	}
}

/**
 * Old-format caches (before the requests table was parsed) lack
 * `promptsPerMonth`; backfill them from the embedded snapshot by id.
 */
function withEmbeddedPrompts(models: ModelAllowance[]): ModelAllowance[] {
	const embeddedPrompts = new Map<string, number | undefined>(
		EMBEDDED.models.map(m => [m.id, m.promptsPerMonth]),
	);
	return models.map(m =>
		m.promptsPerMonth !== undefined ? m : { ...m, promptsPerMonth: embeddedPrompts.get(m.id) },
	);
}

async function resolveDocsData(refresh: boolean): Promise<ResolvedDocs> {
	const cached = await loadCache();
	if (!refresh && cached && isCacheFresh(cached)) {
		return {
			data: { limits: cached.limits, models: withEmbeddedPrompts(cached.models) },
			source: "cached",
			fetchedAt: cached.fetchedAt,
		};
	}
	const fetched = await fetchDocs();
	if (fetched) {
		await saveCache(fetched);
		return { data: fetched, source: "fresh" };
	}
	if (cached) {
		return {
			data: { limits: cached.limits, models: withEmbeddedPrompts(cached.models) },
			source: "cached",
			fetchedAt: cached.fetchedAt,
		};
	}
	return { data: EMBEDDED, source: "embedded" };
}
function remainingRequests(total: number | undefined, monthlyPercent: number): number | null {
	if (total == null || !Number.isFinite(total) || total <= 0) return null;
	return Math.floor(total * (1 - monthlyPercent / 100));
}

function trackerRequestCost(m: TrackerModel): number | null {
	if (!m.pattern) return null;
	const input = m.effectiveInput;
	const cached = m.effectiveCachedRead;
	const writeRaw = m.effectiveCachedWrite;
	const output = m.effectiveOutput;
	if (input == null || cached == null || output == null) return null;
	const write = writeRaw ?? input;
	const inputEffective = 0.05 * input + 0.95 * write;
	return (inputEffective * m.pattern.input + cached * m.pattern.cachedRead + output * m.pattern.output) / 1e6;
}

async function loadTrackerData(): Promise<{ data: TrackerData | null; error: string | null }> {
	try {
		const raw = await Bun.file(TRACKER_DATA_PATH).json();
		const models: TrackerModel[] = Array.isArray(raw.models)
			? raw.models.map((m: any) => ({
					name: String(m.name ?? ""),
					tier: m.tier ?? null,
					usage: Number(m.usage) || 0,
					pattern: m.pattern ? { input: Number(m.pattern.input), cachedRead: Number(m.pattern.cachedRead), output: Number(m.pattern.output) } : null,
					effectiveInput: m.effectiveInput ?? null,
					effectiveOutput: m.effectiveOutput ?? null,
					effectiveCachedRead: m.effectiveCachedRead ?? null,
					effectiveCachedWrite: m.effectiveCachedWrite ?? null,
				}))
			: [];
			return { data: { monthlyCredit: Number(raw.monthlyCredit) || 60, monthlyCost: Number(raw.monthlyCost) || 10, models }, error: null };
	} catch (e: any) {
		const msg = e?.message ?? String(e);
		return { data: null, error: msg };
	}
}

// Alias for known name mismatches between tracker and docs
const ALIAS: Record<string, string> = {
	// tracker "claude 4 sonnet" vs docs "claude-sonnet-4" etc — normalize handles most, keep alias for edge cases
	"claude-4-sonnet": "claude-sonnet-4",
	"claude-4-opus": "claude-opus-4",
	"gpt-5.6-luna-≤-272k-tokens": "gpt-5.6-luna",
	"gpt-5.6-luna->-272k-tokens": "gpt-5.6-luna",
};

function buildTrackerMap(tracker: TrackerData): Map<string, TrackerModel> {
	const map = new Map<string, TrackerModel>();
	for (const m of tracker.models) {
		const key = normalizeName(m.name);
		const cost = trackerRequestCost(m);
		if (cost == null) continue;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, m);
		} else {
			const prevCost = trackerRequestCost(existing);
			if (prevCost != null && cost < prevCost) map.set(key, m);
		}
		// also insert alias key if present
		const aliasKey = ALIAS[key];
		if (aliasKey) {
			const aliasExisting = map.get(aliasKey);
			if (!aliasExisting) map.set(aliasKey, m);
			else {
				const aliasPrev = trackerRequestCost(aliasExisting);
				if (aliasPrev != null && cost < aliasPrev) map.set(aliasKey, m);
			}
		}
	}
	return map;
}

function enrichModels(
	models: ModelAllowance[],
	usage: UsageData | null,
	trackerData: TrackerData | null,
	aaMap: Map<string, AARow>,
): EnrichedModel[] {
	const trackerMap = trackerData ? buildTrackerMap(trackerData) : null;
	const monthlyPercent = usage?.monthly.percent ?? 0;
	return models.map(m => {
		const key = normalizeName(m.displayName);
		// also try id
		const idKey = normalizeName(m.id);
		let tm: TrackerModel | undefined;
		if (trackerMap) tm = trackerMap.get(key) ?? trackerMap.get(idKey) ?? trackerMap.get(ALIAS[key] ?? "");
		let dollarsPerRequest = tm ? trackerRequestCost(tm) : null;
		// Fallback: estimate from docs allowance/promptsPerMonth when tracker missing (e.g. new Muse Spark)
		if (dollarsPerRequest == null && m.promptsPerMonth != null && m.allowance > 0) {
			dollarsPerRequest = m.allowance / m.promptsPerMonth;
		}
		const total = m.promptsPerMonth ?? null;
		const remaining = remainingRequests(m.promptsPerMonth, monthlyPercent);
		const aa = aaMap.get(key) ?? aaMap.get(idKey) ?? aaMap.get(ALIAS[key] ?? "");
		return {
			...m,
			dollarsPerRequest,
			requestsTotal: total,
			requestsRemaining: remaining,
			aaRank: aa?.rank ?? null,
			aaCostPerTask: aa?.costPerTask ?? null,
		};
	});
}

// AA cache helpers
async function loadAACache(): Promise<AACache | null> {
	try {
		const raw = await Bun.file(AA_CACHE_FILE).json();
		if (!raw || typeof raw.fetchedAt !== "string" || !Array.isArray(raw.rows)) return null;
		return raw as AACache;
	} catch { return null; }
}
function isAAFresh(cache: AACache): boolean {
	const t = Date.parse(cache.fetchedAt);
	return Number.isFinite(t) && Date.now() - t < AA_TTL_MS;
}
async function saveAACache(rows: AARow[]): Promise<void> {
	try {
		await mkdir(path.dirname(AA_CACHE_FILE), { recursive: true });
		const payload: AACache = { fetchedAt: new Date().toISOString(), rows };
		await writeFile(AA_CACHE_FILE, JSON.stringify(payload, null, 2));
	} catch { /* non-fatal */ }
}
async function fetchAA(): Promise<AARow[] | null> {
	for (const url of AA_URLS) {
		try {
			const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; OMP go-usage)" }, signal: AbortSignal.timeout(AA_FETCH_TIMEOUT_MS) });
			if (!res.ok) continue;
			const html = await res.text();
			const rows = parseAAHtml(html);
			if (rows && rows.length > 0) return rows;
			// Also try RSC variant
			try {
				const rscRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; OMP go-usage)", "RSC": "1" }, signal: AbortSignal.timeout(AA_FETCH_TIMEOUT_MS) });
				if (rscRes.ok) {
					const rsc = await rscRes.text();
					const rscRows = parseAAHtml(rsc);
					if (rscRows && rscRows.length > 0) return rscRows;
				}
			} catch {}
		} catch { continue; }
	}
	// Fallback: puppeteer DOM scrape (accurate live table, no API key)
	try {
		const rows = await fetchAAViaPuppeteer();
		if (rows && rows.length > 0) return rows;
	} catch {}
	// No public AA API and RSC server HTML currently has no rank/cost — degrade to — (plan: logger.warn, never crash)
	return null;
}
async function fetchAAViaPuppeteer(): Promise<AARow[] | null> {
	try {
		const puppeteer = await import("puppeteer-core");
		const browser = await (puppeteer as any).launch({
			executablePath: "/usr/bin/chromium",
			headless: "new",
			args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu","--disable-dev-shm-usage"]
		});
		const page = await browser.newPage();
		await page.setUserAgent("Mozilla/5.0 (compatible; OMP go-usage)");
		await page.goto("https://artificialanalysis.ai/leaderboards/models", {waitUntil:"networkidle2", timeout:20000});
		await new Promise(r=>setTimeout(r as any, 3000));
		const raw = await page.evaluate(()=>{
			const trs = Array.from(document.querySelectorAll('table tbody tr'));
			return trs.map((tr,i)=>{
				const cells = Array.from(tr.querySelectorAll('td')).map(td=> (td as HTMLElement).innerText.trim());
				return {name: cells[0]||"", cost: cells[4]||"", idx:i+1};
			});
		});
		await browser.close();
		const rows: AARow[] = [];
		const cheapest = new Map<string, AARow>();
		for(const r of raw){
			if(!r.name || !r.cost || r.cost==="--") continue;
			const cost = Number(r.cost.replace(/[^0-9.]/g,""));
			if(!Number.isFinite(cost)) continue;
			const norm = normalizeName(r.name);
			const existing = cheapest.get(norm);
			// Keep cheapest cost per normalized name (e.g. Luna low $0.01 vs max $0.05 -> keep $0.01)
			if(!existing || cost < (existing.costPerTask ?? Infinity)){
				cheapest.set(norm, {normalizedName:norm, displayName:r.name, rank:r.idx, costPerTask:cost});
			}
		}
		return Array.from(cheapest.values());
	} catch {
		return null;
	}
}
function parseAAHtml(html: string): AARow[] | null {
	// Try __NEXT_DATA__ JSON
	const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
	if (nextDataMatch) {
		try {
			const data = JSON.parse(nextDataMatch[1]!);
			const rows = walkNextDataForModels(data);
			if (rows && rows.length > 0) return rows;
		} catch {}
	}
	// Try Next.js streaming chunks (__next_f) — unescape and walk
	try {
		const unescaped = html.replace(/\\\"/g, '"').replace(/\\\\/g, '\\');
		// Look for models arrays in the streaming payload
		const rows = walkNextDataForModels(JSON.parse('"' + unescaped.slice(0,10) + '"')); // dummy to test
	} catch {}
	// Attempt to extract via walk on raw html object walk (handles escaped)
	try {
		// Build a pseudo object from html string search
		const candidate = extractAARowsFromHtml(html);
		if (candidate && candidate.length > 0) return candidate;
	} catch {}
	return parseAARegex(html);
}
function extractAARowsFromHtml(html: string): AARow[] | null {
	// Search for JSON-like model objects with rank and cost in the escaped streaming data
	// Pattern: \"name\":\"...\", ... \"rank\":N, ... \"costPerTask\":X
	// Also try unescaped
	const rows: AARow[] = [];
	const re = /\\"name\\":\\"([^\\"]+)\\"[^}]*?\\"rank\\":\s*(\d+)[^}]*?\\"costPerTask\\":\s*([0-9.]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const name = m[1]!;
		const rank = Number(m[2]);
		const cost = Number(m[3]);
		if (name && Number.isFinite(rank) && Number.isFinite(cost)) rows.push({ normalizedName: normalizeName(name), displayName: name, rank, costPerTask: cost });
	}
	if (rows.length > 0) return rows;
	// Try unescaped variant
	const re2 = /"name":\s*"([^"]+)"[^}]*"rank":\s*(\d+)[^}]*"costPerTask":\s*([0-9.]+)/g;
	while ((m = re2.exec(html)) !== null) {
		const name = m[1]!;
		const rank = Number(m[2]);
		const cost = Number(m[3]);
		if (name && Number.isFinite(rank) && Number.isFinite(cost)) rows.push({ normalizedName: normalizeName(name), displayName: name, rank, costPerTask: cost });
	}
	// Also try alternative field names: "cost_per_task", "avgCost", "cost"
	const re3 = /\\"name\\":\\"([^\\"]+)\\"[^}]*?\\"(costPerTask|cost_per_task|avgCost|cost)\\":\s*([0-9.]+)/g;
	while ((m = re3.exec(html)) !== null) {
		const name = m[1]!;
		const cost = Number(m[3]);
		if (name && Number.isFinite(cost)) rows.push({ normalizedName: normalizeName(name), displayName: name, rank: 9999, costPerTask: cost });
	}
	return rows.length ? rows : null;
}
function walkNextDataForModels(data: any): AARow[] | null {
	const found: any[] = [];
	const stack: any[] = [data];
	const seen = new Set<any>();
	while (stack.length) {
		const cur = stack.pop();
		if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
		seen.add(cur);
		if (Array.isArray(cur)) {
			for (const el of cur) stack.push(el);
			continue;
		}
		// heuristically detect model arrays: objects with rank/costPerTask or similar
		for (const k of Object.keys(cur)) {
			const v = cur[k];
			if (Array.isArray(v) && v.length > 5 && typeof v[0] === "object" && v[0] != null) {
				const sample = v[0];
				if ("rank" in sample || "costPerTask" in sample || "cost_per_task" in sample || "avgCost" in sample) {
					found.push(...v);
				}
			}
			if (v && typeof v === "object") stack.push(v);
		}
	}
	if (found.length === 0) return null;
	const rows: AARow[] = [];
	for (const m of found) {
		const name = String(m.displayName ?? m.name ?? m.model ?? m.id ?? "");
		if (!name) continue;
		const rank = Number(m.rank ?? m.position ?? m.index ?? 0);
		const costRaw = m.costPerTask ?? m.cost_per_task ?? m.avgCost ?? m.cost ?? null;
		const cost = costRaw != null ? Number(costRaw) : null;
		rows.push({ normalizedName: normalizeName(name), displayName: name, rank: rank || 9999, costPerTask: Number.isFinite(cost as number) ? (cost as number) : null });
	}
	return rows.length ? rows : null;
}
function parseAARegex(html: string): AARow[] | null {
	// Very loose regex fallback — look for table rows with rank and $ cost
	// Not critical; return null to degrade gracefully
	return null;
}
async function resolveAAData(refresh: boolean): Promise<{ rows: AARow[] | null; fromCache: boolean }> {
	if (!refresh) {
		const cached = await loadAACache();
		if (cached && isAAFresh(cached)) return { rows: cached.rows, fromCache: true };
	}
	const fetched = await fetchAA();
	if (fetched) {
		await saveAACache(fetched);
		return { rows: fetched, fromCache: false };
	}
	const cached = await loadAACache();
	if (cached) return { rows: cached.rows, fromCache: true };
	return { rows: null, fromCache: false };
}



// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGBA, filter 0) + gauge drawing
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const len = new Uint8Array(4);
	new DataView(len.buffer).setUint32(0, data.length);
	const typeBytes = new TextEncoder().encode(type);
	const crcInput = new Uint8Array(typeBytes.length + data.length);
	crcInput.set(typeBytes, 0);
	crcInput.set(data, typeBytes.length);
	const crc = new Uint8Array(4);
	new DataView(crc.buffer).setUint32(0, crc32(crcInput));
	const out = new Uint8Array(12 + data.length);
	out.set(len, 0);
	out.set(typeBytes, 4);
	out.set(data, 8);
	out.set(crc, 8 + data.length);
	return out;
}

/** Encode an 8-bit RGBA raster as a PNG (filter type 0, zlib deflate). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
	const stride = width * 4;
	const raw = new Uint8Array(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: None
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const idat = deflateSync(raw, { level: 9 });

	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, width);
	dv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace

	const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
	const total = parts.reduce((acc, p) => acc + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function parseHex(hex: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return [137, 180, 250];
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(
	a: [number, number, number],
	b: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

/** True when (px, py) lies inside the rounded rect (x0, y0, w, h) with corner radius r. */
function inRoundRectXY(
	px: number,
	py: number,
	x0: number,
	y0: number,
	w: number,
	h: number,
	r: number,
): boolean {
	if (px < x0 || py < y0 || px >= x0 + w || py >= y0 + h) return false;
	const cx = Math.min(Math.max(px, x0 + r), x0 + w - 1 - r);
	const cy = Math.min(Math.max(py, y0 + r), y0 + h - 1 - r);
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy <= r * r;
}

/**
 * Draw three horizontal usage gauges (5h / weekly / monthly) on a transparent
 * 480x80 canvas. Each gauge is a rounded box: a 2px outline in the track color
 * with a transparent interior (no fill color), filled left-to-right by a
 * horizontal gradient (deep accent → light accent) proportional to the percent.
 * No text — labels live in the text report.
 */
export function buildGaugePng(
	usage: { rolling: number; weekly: number; monthly: number },
	accentHex: string,
	trackHex: string,
): { base64: string; width: number; height: number } {
	const width = GAUGE_WIDTH;
	const height = GAUGE_HEIGHT;
	const rgba = new Uint8Array(width * height * 4); // transparent background
	const accent = parseHex(accentHex);
	const track = parseHex(trackHex);

	const PAD = 4;
	const BAR_H = 22;
	const GAP = 5;
	const TOP = 2;
	const OUTER_R = 11; // pill radius for 22px bars
	const STROKE = 2;
	const boxW = width - 2 * PAD;
	const ys = [TOP, TOP + BAR_H + GAP, TOP + 2 * (BAR_H + GAP)];
	const pcts = [clampPct(usage.rolling), clampPct(usage.weekly), clampPct(usage.monthly)];
	const fillFrom = mixRgb(accent, [0, 0, 0], 0.25);
	const fillTo = mixRgb(accent, [255, 255, 255], 0.7);

	for (let g = 0; g < 3; g++) {
		const y0 = ys[g]!;
		const fx0 = PAD + STROKE;
		const fy0 = y0 + STROKE;
		const fh = BAR_H - 2 * STROKE;
		const fillW = Math.max(0, Math.round((pcts[g]! / 100) * (boxW - 2 * STROKE)));
		const fr = Math.min(OUTER_R - STROKE, fillW / 2, fh / 2);

		// Gradient fill (inside the outline), clipped to the rounded rect.
		if (fillW > 0) {
			for (let y = fy0; y < fy0 + fh; y++) {
				for (let x = fx0; x < fx0 + fillW; x++) {
					if (!inRoundRectXY(x, y, fx0, fy0, fillW, fh, fr)) continue;
					const t = (x - fx0) / fillW;
					const c = mixRgb(fillFrom, fillTo, t);
					const off = (y * width + x) * 4;
					rgba[off] = c[0];
					rgba[off + 1] = c[1];
					rgba[off + 2] = c[2];
					rgba[off + 3] = 255;
				}
			}
		}

		// Outline ring: outer rounded rect minus the 2px-inset inner one, so the
		// empty part is a box with no fill color.
		for (let y = y0; y < y0 + BAR_H; y++) {
			for (let x = PAD; x < PAD + boxW; x++) {
				const outer = inRoundRectXY(x, y, PAD, y0, boxW, BAR_H, OUTER_R);
				const inner = inRoundRectXY(
					x,
					y,
					PAD + STROKE,
					y0 + STROKE,
					boxW - 2 * STROKE,
					BAR_H - 2 * STROKE,
					OUTER_R - STROKE,
				);
				if (!outer || inner) continue;
				const off = (y * width + x) * 4;
				rgba[off] = track[0];
				rgba[off + 1] = track[1];
				rgba[off + 2] = track[2];
				rgba[off + 3] = 255;
			}
		}
	}

	return { base64: Buffer.from(encodePng(rgba, width, height)).toString("base64"), width, height };
}

// ---------------------------------------------------------------------------
// Report composition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Colored text bars (widget animation + persistent mini-bar)
// ---------------------------------------------------------------------------

/** HSL → RGB, each channel 0-255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function clampPct(n: number): number {
	return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/** Usage color: hue 120° (green) at 0% → hue 0° (red) at 100%. */
function usageHueRgb(percent: number): [number, number, number] {
	return hslToRgb(120 * (1 - clampPct(percent) / 100), 0.75, 0.55);
}

/** Width of a string with ANSI SGR sequences stripped (for right-alignment math). */
function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** `width` solid blocks colored by usage percent; empty cells in the theme's muted color. */
function coloredBlocks(percent: number, width: number, theme: Theme): string {
	const pct = clampPct(percent);
	const filled = Math.round((pct / 100) * width);
	const [r, g, b] = usageHueRgb(pct);
	return `\x1b[38;2;${r};${g};${b}m${"█".repeat(filled)}${theme.fg("muted", "░".repeat(width - filled))}\x1b[0m`;
}

function formatReset(iso: string): string {
	const ms = Date.parse(iso) - Date.now();
	if (!Number.isFinite(ms)) return "?";
	if (ms <= 0) return "<1m";
	const totalMin = Math.floor(ms / 60000);
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	const m = totalMin % 60;
	const parts: string[] = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0 || parts.length === 0) parts.push(`${m}m`);
	return parts.join("");
}



function bareModelId(id: string | null | undefined): string | null {
	if (!id) return null;
	const idx = id.lastIndexOf("/");
	return idx >= 0 ? id.slice(idx + 1) : id;
}

function formatCount(n: number | undefined): string {
	if (!n || n <= 0) return "—";
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDollarsPerRequest(n: number | null): string {
	if (n == null || !Number.isFinite(n)) return "—";
	return `${n.toFixed(4)}`;
}
function formatRequests(remaining: number | null, total: number | null): string {
	if (remaining == null || total == null) return "—";
	return `${formatCount(remaining)}/${formatCount(total)}`;
}
function truncateModelName(name: string, max: number = 24): string {
	if (name.length <= max) return name;
	return name.slice(0, max - 1) + "…";
}

const SORT_KEYS: SortKey[] = ["aaRank", "dollarsPerRequest", "requestsRemaining", "aaCostPerTask", "name"];
function nextSortKey(cur: SortKey): SortKey {
	const idx = SORT_KEYS.indexOf(cur);
	return SORT_KEYS[(idx + 1) % SORT_KEYS.length]!;
}

function sortedEnriched(models: EnrichedModel[], sortKey: SortKey, sortDir: SortDir): EnrichedModel[] {
	const dir = sortDir === "asc" ? 1 : -1;
	return [...models].sort((a, b) => {
		let va: number | string;
		let vb: number | string;
		switch (sortKey) {
			case "dollarsPerRequest":
				va = a.dollarsPerRequest ?? Infinity;
				vb = b.dollarsPerRequest ?? Infinity;
				break;
			case "requestsRemaining":
				va = a.requestsRemaining ?? -Infinity;
				vb = b.requestsRemaining ?? -Infinity;
				break;
			case "aaRank":
				va = a.aaRank ?? Infinity;
				vb = b.aaRank ?? Infinity;
				break;
			case "aaCostPerTask":
				va = a.aaCostPerTask ?? Infinity;
				vb = b.aaCostPerTask ?? Infinity;
				break;
			case "name":
			default:
				va = a.displayName.toLowerCase();
				vb = b.displayName.toLowerCase();
				if (va < vb) return -1 * dir;
				if (va > vb) return 1 * dir;
				return 0;
		}
		if (typeof va === "number" && typeof vb === "number") {
			if (va !== vb) return (va - vb) * dir;
			return a.displayName.localeCompare(b.displayName);
		}
		return 0;
	});
}

function tableLines(
	rows: EnrichedModel[],
	currentId: string | null,
	sortKey: SortKey = "aaRank",
	sortDir: SortDir = "asc",
): string[] {
	const MODEL_W = 24;
	const SORT_INDICATOR: Record<SortKey, string> = {
		name: "Model",
		dollarsPerRequest: "$/req",
		requestsRemaining: "Requests",
		aaRank: "AA Rank",
		aaCostPerTask: "AA $/task",
	};
	const arrow = sortDir === "asc" ? "▴" : "▾";
	const headerModel = (SORT_INDICATOR[sortKey] === "Model" ? `Model ${arrow}` : "Model").padEnd(MODEL_W + 2);
	const hdrDollars = (SORT_INDICATOR[sortKey] === "$/req" ? `$/req ${arrow}` : "$/req").padEnd(8 + 2);
	const hdrReq = (SORT_INDICATOR[sortKey] === "Requests" ? `Requests ${arrow}` : "Requests").padEnd(16 + 2);
	const hdrRank = (SORT_INDICATOR[sortKey] === "AA Rank" ? `AA Rank ${arrow}` : "AA Rank").padEnd(8 + 2);
	const hdrCost = SORT_INDICATOR[sortKey] === "AA $/task" ? `AA $/task ${arrow}` : "AA $/task";
	const header = `  ${headerModel}${hdrDollars}${hdrReq}${hdrRank}${hdrCost}`;
	const sep = `  ${"─".repeat(MODEL_W)}  ${"─".repeat(8)}  ${"─".repeat(16)}  ${"─".repeat(8)}  ${"─".repeat(9)}`;
	const lines = [header, sep];
	for (const r of rows) {
		const modelCell = truncateModelName(r.displayName, MODEL_W).padEnd(MODEL_W + 2);
		const dollarsCell = formatDollarsPerRequest(r.dollarsPerRequest).padEnd(8 + 2);
		const reqCell = formatRequests(r.requestsRemaining, r.requestsTotal).padEnd(16 + 2);
		const rankCell = (r.aaRank != null ? `#${r.aaRank}` : "—").padEnd(8 + 2);
		const costCell = r.aaCostPerTask != null ? `${r.aaCostPerTask.toFixed(2)}` : "—";
		const row = `  ${modelCell}${dollarsCell}${reqCell}${rankCell}${costCell}`;
		lines.push(r.id === currentId ? `\x1b[1;7m${row}\x1b[0m` : row);
	}
	return lines;
}

function renderModelTable(
	models: EnrichedModel[],
	currentId: string | null,
	onlyModel: string | null,
	sortKey: SortKey = "aaRank",
	sortDir: SortDir = "asc",
): string[] {
	const rows = sortedEnriched(models, sortKey, sortDir);
	if (onlyModel) {
		const row = rows.find(m => m.id === onlyModel);
		if (!row) return [`  ${onlyModel} — no allowance data (not in docs table)`];
		return tableLines([row], currentId, sortKey, sortDir);
	}
	return tableLines(rows, currentId, sortKey, sortDir);
}



function usageLines(usage: UsageData | null, limits: DocsData["limits"]): string[] {
	if (!usage) return [`  5h $${limits.rolling} · wk $${limits.weekly} · mo $${limits.monthly}`];
	const windows: Array<[string, number, WindowUsage]> = [
		["5h", limits.rolling, usage.rolling],
		["wk", limits.weekly, usage.weekly],
		["mo", limits.monthly, usage.monthly],
	];
	return windows.map(([label, limit, w]) => {
		const parts = [
			`  ${label}  ${w.percent}%`,
			`≈$${((w.percent / 100) * limit).toFixed(2)} of $${limit}`,
			`resets in ${formatReset(w.resetsAt)}`,
		];
		if (w.status === "rate-limited") parts.push("LIMITED");
		return parts.join(" · ");
	});
}

export function buildReport(opts: {
	usage: UsageData | null;
	docs: ResolvedDocs;
	currentModelId: string | null;
	onlyModel: string | null;
	trackerData?: TrackerData | null;
	trackerError?: string | null;
	aaRows?: AARow[] | null;
	sortKey?: SortKey;
	sortDir?: SortDir;
}): string {
	const { usage, docs, currentModelId, onlyModel, trackerData, trackerError, aaRows, sortKey = "aaRank", sortDir = "asc" } = opts;
	const aaMap = new Map<string, AARow>();
	if (aaRows) for (const r of aaRows) aaMap.set(r.normalizedName, r);
	const enriched = enrichModels(docs.data.models, usage, trackerData ?? null, aaMap);
	const lines = renderModelTable(enriched, currentModelId, onlyModel, sortKey, sortDir);
	if (trackerError) {
		lines.push("");
		lines.push("  tracker data unavailable — $/req hidden");
	}
	if (aaRows === null || (aaRows && aaRows.length === 0)) {
		// AA degraded is silent in table (shows —), but add footer note
	}
	// Keep the logo-to-list area clean. Usage details sit immediately before
	// the gauge image in the renderer, so they read as labels for those bars.
	lines.push("");
	lines.push(...usageLines(usage, docs.data.limits));
	if (aaRows && aaRows.length > 0) {
		lines.push("  AA $/task from artificialanalysis.ai; not adjusted for OpenCode Go pricing");
	}
	lines.push("  sort: /go-usage s cycles key (aaRank→$/req→Requests→AA $/task→name), /go-usage S flips dir — header shows ▴/▾; also --sort=<key> --order=<asc|desc>");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Renderer (TUI only)
// ---------------------------------------------------------------------------

const renderer: MessageRenderer<GoUsageDetails> = (
	message: CustomMessage<GoUsageDetails>,
	_opts: MessageRenderOptions,
	theme: Theme,
) => {
	const container = new Container();
	const text = typeof message.content === "string" ? message.content : "";
	if (TERMINAL.imageProtocol !== null) {
		container.addChild(
			new Image(
				OPENCODE_LOGO_B64,
				"image/png",
				{ fallbackColor: s => theme.fg("toolOutput", s) },
				{
					maxWidthCells: LOGO_MAX_WIDTH_CELLS,
					maxHeightCells: LOGO_MAX_HEIGHT_CELLS,
					imageKey: "go-usage-logo",
				},
			),
		);
	}
	container.addChild(new Text(text, 0, 0));
	const details = message.details;
	if (TERMINAL.imageProtocol !== null && details?.pngBase64) {
		container.addChild(
			new Image(
				details.pngBase64,
				"image/png",
				{ fallbackColor: s => theme.fg("toolOutput", s) },
				{ maxWidthCells: 60, maxHeightCells: 8, imageKey: "go-usage-gauges" },
			),
		);
	}
	return container;
};

// ---------------------------------------------------------------------------
// Fill-up animation widget (TUI only)
// ---------------------------------------------------------------------------

/**
 * Transient widget above the editor that plays a quick bar-fill animation for
 * the three usage windows, then invokes `onDone`. Renders colored green→red
 * blocks (theme-aware track) and drives repaints through the TUI's
 * component-scoped render request. `dispose()` clears the timer if the widget
 * is removed early.
 */
export class AnimatedBars implements Component {
	#tui: { requestComponentRender(component: Component): void };
	#theme: Theme;
	#onDone: () => void;
	#targets: [number, number, number];
	#frame = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: { requestComponentRender(component: Component): void },
		usage: UsageData,
		theme: Theme,
		onDone: () => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#onDone = onDone;
		this.#targets = [
			clampPct(usage.rolling.percent),
			clampPct(usage.weekly.percent),
			clampPct(usage.monthly.percent),
		];
		this.#timer = setInterval(() => this.#tick(), ANIM_INTERVAL_MS);
	}

	#tick(): void {
		this.#frame++;
		if (this.#frame >= ANIM_FRAMES) {
			if (this.#timer) clearInterval(this.#timer);
			this.#timer = undefined;
			this.#onDone();
			return;
		}
		this.#tui.requestComponentRender(this);
	}

	/** Ease-out cubic: fast start, settling into the final value. */
	#eased(t: number): number {
		return 1 - (1 - t) ** 3;
	}

	render(_width: number): readonly string[] {
		const t = Math.min(1, this.#frame / ANIM_FRAMES);
		const pcts = this.#targets.map(p => p * this.#eased(t));
		return [
			"go-usage ▸",
			`  5h  ${coloredBlocks(pcts[0], 10, this.#theme)} ${Math.round(pcts[0])}%`,
			`  wk  ${coloredBlocks(pcts[1], 10, this.#theme)} ${Math.round(pcts[1])}%`,
			`  mo  ${coloredBlocks(pcts[2], 10, this.#theme)} ${Math.round(pcts[2])}%`,
		];
	}

	dispose(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}
}

async function playFillAnimation(ctx: ExtensionCommandContext, usage: UsageData): Promise<void> {
	await new Promise<void>(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			resolve();
		};
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AnimatedBars(tui, usage, theme, finish), {
			placement: "aboveEditor",
		});
		// Safety net: never let the command hang on a widget that never renders.
		setTimeout(finish, ANIM_FRAMES * ANIM_INTERVAL_MS + 300);
	});
}

// ---------------------------------------------------------------------------
// Persistent 5h mini-bar (TUI only)
// ---------------------------------------------------------------------------

/**
 * Single-line widget pinned above the editor (top-right of the prompt window,
 * next to the context-window usage). Shows the 5-hour usage window as a small
 * green→red bar. Installed only while an opencode-go model is selected.
 *
 * Refresh policy: prompt-triggered (`turn_start`) fetches with a 3-minute gate,
 * plus up to `MINIBAR_AUTO_MAX` automatic refreshes at 10-minute intervals per
 * install cycle. Failures keep the last known value — nothing blocks the
 * prompt flow (the handler is fire-and-forget).
 */
export class GoUsageMinibar implements Component {
	#percent: number | null = null;
	#lastFetchAt = 0;
	#autoChecksLeft = 0;
	#autoTimer: ReturnType<typeof setTimeout> | undefined;
	#tui: { requestComponentRender(component: Component): void } | undefined;
	#theme: Theme | undefined;
	#installed = false;

	/** Called by the widget factory whenever the widget is installed. */
	attach(tui: { requestComponentRender(component: Component): void }, theme: Theme): void {
		this.#tui = tui;
		this.#theme = theme;
		this.#installed = true;
		this.#armAutoChecks();
	}

	dispose(): void {
		this.#installed = false;
		this.#stopAutoChecks();
	}

	/** Prompt-time refresh: only when the 3-minute gate has elapsed. */
	async onTurnStart(): Promise<void> {
		if (Date.now() - this.#lastFetchAt >= MINIBAR_FETCH_GATE_MS) {
			await this.#fetch(false);
		}
	}

	/**
	 * Stamp a fresh usage payload (e.g. from a /go-usage run) and repaint.
	 * `arm` re-arms the auto-check chain when it has run dry — prompt-driven
	 * fetches do this, but auto-check fetches must not (that would loop).
	 */
	absorb(usage: UsageData, arm = false): void {
		this.#lastFetchAt = Date.now();
		this.#percent = clampPct(usage.rolling.percent);
		if (arm) this.#armAutoChecks();
		this.#render();
	}

	async #fetch(fromAuto: boolean): Promise<void> {
		const key = await resolveApiKey();
		if (!key) return;
		try {
			this.absorb(await fetchUsage(key), !fromAuto);
		} catch {
			// Transient failure: keep the last known value; the next prompt or
			// auto-check retries.
		}
	}

	#armAutoChecks(): void {
		if (!this.#installed || this.#autoTimer || this.#autoChecksLeft > 0) return;
		this.#autoChecksLeft = MINIBAR_AUTO_MAX;
		this.#scheduleAuto();
	}

	#scheduleAuto(): void {
		if (this.#autoChecksLeft <= 0) return;
		this.#autoChecksLeft--;
		this.#autoTimer = setTimeout(() => {
			this.#autoTimer = undefined;
			void this.#fetch(true);
			this.#scheduleAuto();
		}, MINIBAR_AUTO_INTERVAL_MS);
	}

	#stopAutoChecks(): void {
		if (this.#autoTimer) clearTimeout(this.#autoTimer);
		this.#autoTimer = undefined;
		this.#autoChecksLeft = 0;
	}

	#render(): void {
		if (!this.#tui || this.#percent === null) return;
		try {
			this.#tui.requestComponentRender(this);
		} catch {
			// Widget may have been torn down mid-frame; nothing to do.
		}
	}

	/** One right-aligned line, or [] while not installed or no fresh usage value. */
	render(width: number): readonly string[] {
		if (!this.#installed || this.#percent === null || !this.#theme) return [];
		const line = `5h ${coloredBlocks(this.#percent, MINIBAR_BLOCKS, this.#theme)} ${Math.round(this.#percent)}%`;
		const pad = Math.max(0, width - visibleLen(line));
		return [" ".repeat(pad) + line];
	}
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

function safeHex(get: () => string, fallback: string): string {
	try {
		return get() || fallback;
	} catch {
		return fallback;
	}
}

async function runGoUsage(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = args.split(/\s+/).filter(Boolean);
	const refresh = tokens.includes("--refresh");
	const debug = tokens.includes("--debug");
	const sortArg = tokens.find(t => t.startsWith("--sort="));
	const orderArg = tokens.find(t => t.startsWith("--order="));
	let sortKey: SortKey = "aaRank";
	let sortDir: SortDir = "asc";
	if (sortArg) {
		const v = sortArg.slice("--sort=".length) as SortKey;
		if ((SORT_KEYS as string[]).includes(v)) sortKey = v;
	}
	if (orderArg) {
		const v = orderArg.slice("--order=".length);
		if (v === "asc" || v === "desc") sortDir = v;
	}
	// bare s/S support for CLI cycling (runGoUsage is stateless, so s→next key from current, S→flip dir)
	if (tokens.includes("s")) {
		sortKey = nextSortKey(sortKey);
	}
	if (tokens.includes("S")) {
		sortDir = sortDir === "asc" ? "desc" : "asc";
	}
	// also allow bare "sort" token
	if (tokens.includes("sort") && !sortArg) {
		sortKey = nextSortKey(sortKey);
	}
	const modelArg = tokens.find(t => t.startsWith("--model="));
	const onlyModel = modelArg ? modelArg.slice("--model=".length) : null;

	const key = await resolveApiKey();
	if (!key) {
		ctx.ui.notify("go-usage: no OpenCode Go API key — run /connect or set OPENCODE_GO_API_KEY", "warning");
		return;
	}

	let usage: UsageData | null = null;
	try {
		usage = await fetchUsage(key);
	} catch (err) {
		if (err instanceof UsageKeyRejectedError) {
			ctx.ui.notify("go-usage: API key rejected or Go subscription missing", "warning");
			return;
		}
		ctx.ui.notify("go-usage: usage API unreachable — showing cached limits only", "warning");
	}
	if (usage) minibar.absorb(usage, true);

	const docs = await resolveDocsData(refresh);
	const currentModelId = bareModelId(ctx.model?.id ?? ctx.models.current()?.id);
	// Load tracker + AA in parallel, non-blocking degrade to null
	const [trackerRes, aaRes] = await Promise.all([
		loadTrackerData(),
		resolveAAData(refresh),
	]);
	const trackerData = trackerRes.data;
	const trackerError = trackerRes.error ? "tracker data unavailable — $/req hidden" : null;
	const aaRows = aaRes.rows;
	if (debug && trackerData) {
		const sample = trackerData.models.find(m => m.name.includes("Luna")) ?? trackerData.models[0];
		if (sample) {
			const cost = trackerRequestCost(sample);
			console.error(`[go-usage --debug] ${sample.name} ${sample.tier ?? ""} cost=${cost} pattern=${JSON.stringify(sample.pattern)} effIn=${sample.effectiveInput} effOut=${sample.effectiveOutput} effRead=${sample.effectiveCachedRead} effWrite=${sample.effectiveCachedWrite}`);
		}
	}
	const reportText = buildReport({ usage, docs, currentModelId, onlyModel, trackerData, trackerError, aaRows, sortKey, sortDir });


	// Quick bar-fill animation before the card lands (TUI only, and only when
	// there are usage bars to animate).
	if (ctx.mode === "tui" && usage) {
		await playFillAnimation(ctx, usage);
	}

	pi.sendMessage({ customType: CUSTOM_TYPE, display: true, content: reportText });
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/** Persistent mini-bar controller shared by the turn handler and the command. */
const minibar = new GoUsageMinibar();
let minibarInstalled = false;

/** True when the currently selected model runs on the OpenCode Go plan. */
function isOpenCodeGoModel(model: { id: string; provider?: string } | undefined): boolean {
	const id = model?.id ?? "";
	return model?.provider === "opencode-go" || id.startsWith("opencode-go");
}

export default function goUsageExtension(pi: ExtensionAPI): void {
	pi.registerCommand("go-usage", {
		description: "Show OpenCode Go usage limits (windows, dollars, per-model allowances)",
		handler: (args, ctx) => runGoUsage(pi, args, ctx),
	});
	pi.registerMessageRenderer(CUSTOM_TYPE, renderer);

	// Keep the 5h mini-bar fresh: on every prompt, refresh the usage if the
	// 3-minute gate has elapsed. Install/remove the widget as the model enters
	// or leaves the OpenCode Go plan (there is no model_changed event, so the
	// gate is re-evaluated on each turn).
	pi.on("turn_start", (_event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
			if (!isOpenCodeGoModel(ctx.model)) {
				if (minibarInstalled) {
					ctx.ui.setWidget(MINIBAR_KEY, undefined);
					minibarInstalled = false;
				}
				return;
			}
			if (!minibarInstalled) {
				ctx.ui.setWidget(
					MINIBAR_KEY,
					(tui, theme) => {
						minibar.attach(tui, theme);
						return minibar;
					},
					{ placement: "aboveEditor" },
				);
				minibarInstalled = true;
			}
			void minibar.onTurnStart();
		} catch {
			// A UI hiccup must never break the prompt flow.
		}
	});
}
