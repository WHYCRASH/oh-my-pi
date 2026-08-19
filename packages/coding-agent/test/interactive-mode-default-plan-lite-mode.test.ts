import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode, shouldEnterPlanLiteModeOnStartup } from "../src/modes/interactive-mode";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("InteractiveMode plan-lite.defaultOnStartup", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-default-plan-lite-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	/** Build an InteractiveMode over a brand-new (never-persisted) session. */
	function createHarness(settings: Settings): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const initialModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const readTool = makeTool("read");
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read"],
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	function startupDecisionHarness(
		sessionSettings: Settings,
		options: { conversation?: boolean; explicitMode?: boolean } = {},
	): boolean {
		return shouldEnterPlanLiteModeOnStartup(
			{
				buildSessionContext: () => ({ messages: options.conversation ? [{}] : [] }) as never,
				getEntries: () => (options.explicitMode ? [{ type: "mode_change" }] : []) as never,
			},
			sessionSettings,
		);
	}

	it("enters plan-lite at startup when the setting is enabled", async () => {
		const created = createHarness(
			Settings.isolated({
				"plan-lite.defaultOnStartup": true,
				"plan-lite.enabled": true,
				"compaction.enabled": false,
			}),
		);

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planLiteEnabled).toBe(true);
		expect(session?.getPlanLiteModeState()).toMatchObject({ enabled: true });
		// Plan-lite is steering-only: the tool set is untouched on entry.
		expect(session?.getActiveToolNames()).toEqual(["read"]);
	});

	it("does not default plan-lite on for brand-new sessions", async () => {
		// Fork policy: `plan-lite.enabled` defaults true, but `defaultOnStartup`
		// defaults false (mirroring plan mode) — startup entry is opt-in. A
		// default-on startup hijacked every mode-focused test session, so the
		// always-on fork behavior is a one-line settings opt-in instead.
		expect(Settings.isolated({}).get("plan-lite.enabled")).toBe(true);
		expect(Settings.isolated({}).get("plan-lite.defaultOnStartup")).toBe(false);
		expect(startupDecisionHarness(Settings.isolated({}))).toBe(false);
	});

	it("enters only when enabled and the session has no conversation or explicit mode", () => {
		const enabled = Settings.isolated({
			"plan-lite.defaultOnStartup": true,
			"plan-lite.enabled": true,
			"compaction.enabled": false,
		});
		expect(startupDecisionHarness(enabled, { conversation: true })).toBe(false);
		expect(startupDecisionHarness(enabled, { explicitMode: true })).toBe(false);
		expect(
			startupDecisionHarness(
				Settings.isolated({
					"plan-lite.defaultOnStartup": true,
					"plan-lite.enabled": false,
					"compaction.enabled": false,
				}),
			),
		).toBe(false);
	});

	it("classifies persisted compaction and mode entries without constructing a TUI", async () => {
		const enabled = Settings.isolated({
			"plan-lite.defaultOnStartup": true,
			"plan-lite.enabled": true,
			"compaction.enabled": false,
		});
		const manager = SessionManager.create(
			tempDir.path(),
			path.join(tempDir.path(), `startup-decision-${Bun.nanoseconds()}`),
		);
		try {
			manager.appendCustomEntry("my-extension-state", { foo: "bar" });
			expect(shouldEnterPlanLiteModeOnStartup(manager, enabled)).toBe(true);

			manager.appendCompaction("prior conversation summary", undefined, "first-kept", 1000);
			expect(shouldEnterPlanLiteModeOnStartup(manager, enabled)).toBe(false);

			manager.appendModeChange("plan-lite");
			manager.appendModeChange("none");
			expect(shouldEnterPlanLiteModeOnStartup(manager, enabled)).toBe(false);
		} finally {
			await manager.close();
		}
	});
});
