/**
 * Contracts: /plan-lite mode toggle on InteractiveMode.
 *
 * 1. Toggling on enters plan-lite: `planLiteEnabled` flips true, the session
 *    carries `PlanLiteModeState({ enabled: true })`, a `mode_change` entry with
 *    mode `"plan-lite"` is journaled, and the active tool set is untouched
 *    (plan-lite changes no tools).
 * 2. Toggling again exits: state clears, `mode_change` `"none"` is journaled,
 *    and the tool set is still untouched.
 * 3. With `plan-lite.enabled` false, the toggle refuses entry with a warning.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
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

function planLiteEntryCount(manager: SessionManager): number {
	return manager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "plan-lite").length;
}

describe("InteractiveMode plan-lite toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-plan-lite-toggle-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const readTool = stubTool("read");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "plan-lite.enabled": true }),
			modelRegistry,
			toolRegistry: new Map([[readTool.name, readTool]]),
			builtInToolNames: [readTool.name],
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("enters plan-lite without touching the active tool set and journals the mode change", async () => {
		expect(mode.planLiteEnabled).toBe(false);
		expect(session.getPlanLiteModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);

		await mode.handlePlanLiteCommand();

		expect(mode.planLiteEnabled).toBe(true);
		expect(session.getPlanLiteModeState()).toMatchObject({ enabled: true });
		// Plan-lite is steering-only: no tool/model/approval changes.
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(planLiteEntryCount(session.sessionManager)).toBe(1);
	});

	it("exits on the second toggle and journals the none entry", async () => {
		await mode.handlePlanLiteCommand();
		expect(mode.planLiteEnabled).toBe(true);

		await mode.handlePlanLiteCommand();

		expect(mode.planLiteEnabled).toBe(false);
		expect(session.getPlanLiteModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(planLiteEntryCount(session.sessionManager)).toBe(1);
		expect(
			session.sessionManager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "none"),
		).toHaveLength(1);
	});

	it("refuses to enter when plan-lite.enabled is false", async () => {
		const settings = Settings.isolated({ "plan-lite.enabled": false });
		const model = session.model;
		if (!model) throw new Error("Expected active model");
		const disabledSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>(),
			builtInToolNames: [],
		});
		const disabledMode = new InteractiveMode(
			disabledSession,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new EventBus(),
		);
		try {
			const handled = await disabledMode.handlePlanLiteCommand();
			expect(handled).toBe(false);
			expect(disabledMode.planLiteEnabled).toBe(false);
			expect(disabledSession.getPlanLiteModeState()).toBeUndefined();
		} finally {
			disabledMode.stop();
			await disabledSession.dispose();
		}
	});
});
