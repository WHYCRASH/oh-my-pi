/**
 * Contract: the plan-lite steering message is assembled into the turn's
 * message history exactly when plan-lite mode state is enabled.
 *
 *  S1. With `setPlanLiteModeState({ enabled: true })`, the agent messages of
 *      the next turn include a `custom` message with `customType`
 *      `"plan-lite-context"` carrying the steering prompt.
 *  S2. With no plan-lite state (undefined), no such message is assembled.
 *  S3. Clearing the state stops injection on subsequent turns.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type CustomMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import planLiteActivePrompt from "../src/prompts/system/plan-lite-active.md" with { type: "text" };

/** A stable, literal (non-templated) line of the steering prompt, so the test
 *  pins the message by its real content rather than a hardcoded copy. */
const STEERING_FRAGMENT = "Plan-lite mode active";

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

function planLiteContextMessages(messages: readonly AgentMessage[]): CustomMessage[] {
	return messages.filter((m): m is CustomMessage => m.role === "custom" && m.customType === "plan-lite-context");
}

interface PlanLiteHarness {
	session: AgentSession;
	mock: MockModel;
}

describe("AgentSession plan-lite steering message", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		expect(planLiteActivePrompt).toContain(STEERING_FRAGMENT);
		authDir = TempDir.createSync("@pi-plan-lite-msg-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-lite-msg-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			await tempDir?.remove();
		}
	});

	async function createSession(): Promise<PlanLiteHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const askTool = makeTool("ask");
		const readTool = makeTool("read");
		const mock = createMockModel({ responses: [{ content: ["done"] }] });

		const created = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [askTool, readTool],
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([
				["ask", askTool],
				["read", readTool],
			]),
			builtInToolNames: ["ask", "read"],
			advisorTools: [],
		});
		session = created;
		return { session: created, mock };
	}

	it("S1: assembles the plan-lite-context steering message when state is enabled", async () => {
		const harness = await createSession();
		harness.session.setPlanLiteModeState({ enabled: true });

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(1);
		const injected = planLiteContextMessages(harness.session.agent.state.messages);
		expect(injected).toHaveLength(1);
		expect(JSON.stringify(injected[0].content)).toContain(STEERING_FRAGMENT);
	});

	it("S2: assembles no plan-lite-context message without state", async () => {
		const harness = await createSession();
		expect(harness.session.getPlanLiteModeState()).toBeUndefined();

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(1);
		expect(planLiteContextMessages(harness.session.agent.state.messages)).toHaveLength(0);
	});

	it("S3: stops assembling after the state is cleared", async () => {
		const harness = await createSession();
		harness.session.setPlanLiteModeState({ enabled: true });

		await harness.session.prompt("first");
		await harness.session.waitForIdle();
		expect(planLiteContextMessages(harness.session.agent.state.messages)).toHaveLength(1);

		harness.session.setPlanLiteModeState(undefined);
		await harness.session.prompt("second");
		await harness.session.waitForIdle();

		expect(harness.mock.calls).toHaveLength(2);
		expect(planLiteContextMessages(harness.session.agent.state.messages)).toHaveLength(1);
	});
});
