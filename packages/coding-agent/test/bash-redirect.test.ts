import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { translateBashToTool } from "../src/tools/bash-redirect";

describe("translateBashToTool", () => {
	// cat -> read
	test("cat single file -> read", () => {
		expect(translateBashToTool("cat src/foo.ts")).toEqual({ tool: "read", input: { path: "src/foo.ts" } });
	});
	test("cat with quoted path", () => {
		expect(translateBashToTool("cat 'my file.txt'")).toEqual({ tool: "read", input: { path: "my file.txt" } });
	});
	test("less / more -> read", () => {
		expect(translateBashToTool("less README.md")).toEqual({ tool: "read", input: { path: "README.md" } });
		expect(translateBashToTool("more README.md")).toEqual({ tool: "read", input: { path: "README.md" } });
	});

	// head -> read with selector
	test("head -n 50 -> read with selector", () => {
		expect(translateBashToTool("head -n 50 a.md")).toEqual({ tool: "read", input: { path: "a.md:1-50" } });
	});
	test("head -50 -> read with selector", () => {
		expect(translateBashToTool("head -50 a.md")).toEqual({ tool: "read", input: { path: "a.md:1-50" } });
	});

	// grep / rg -> grep
	test("rg pattern src", () => {
		expect(translateBashToTool("rg pattern src")).toEqual({
			tool: "grep",
			input: { pattern: "pattern", path: "src" },
		});
	});
	test("rg pattern without path", () => {
		expect(translateBashToTool("rg myPattern")).toEqual({ tool: "grep", input: { pattern: "myPattern" } });
	});
	test("rg -i pattern -> case:false", () => {
		expect(translateBashToTool("rg -i pattern")).toEqual({
			tool: "grep",
			input: { pattern: "pattern", case: false },
		});
	});
	test("rg --ignore-case pattern", () => {
		expect(translateBashToTool("rg --ignore-case pattern")).toEqual({
			tool: "grep",
			input: { pattern: "pattern", case: false },
		});
	});
	test("grep -F escapes regex", () => {
		expect(translateBashToTool('grep -F "a.b" file')).toEqual({
			tool: "grep",
			input: { pattern: "a\\.b", path: "file" },
		});
	});
	test("grep --fixed-strings", () => {
		expect(translateBashToTool("grep --fixed-strings 'a*b' file")).toEqual({
			tool: "grep",
			input: { pattern: "a\\*b", path: "file" },
		});
	});
	test("fgrep implies -F", () => {
		expect(translateBashToTool("fgrep a.b file")).toEqual({
			tool: "grep",
			input: { pattern: "a\\.b", path: "file" },
		});
	});
	test("combined -iF", () => {
		expect(translateBashToTool("grep -iF pattern file")).toEqual({
			tool: "grep",
			input: { pattern: "pattern", path: "file", case: false },
		});
	});
	test("grep -- pattern with dash", () => {
		expect(translateBashToTool("grep -- -pattern file")).toEqual({
			tool: "grep",
			input: { pattern: "-pattern", path: "file" },
		});
	});

	// find -> glob
	test("find src -name '*.ts' -> glob", () => {
		expect(translateBashToTool("find src -name '*.ts'")).toEqual({ tool: "glob", input: { path: "src/*.ts" } });
	});
	test("find . -name '*.ts' -> glob without dot prefix", () => {
		expect(translateBashToTool("find . -name '*.ts'")).toEqual({ tool: "glob", input: { path: "*.ts" } });
	});

	// rejects -> undefined
	test("cat with two files -> undefined", () => {
		expect(translateBashToTool("cat a b")).toBeUndefined();
	});
	test("cat with flag -> undefined", () => {
		expect(translateBashToTool("cat -n a")).toBeUndefined();
	});
	test("rg with pipe -> undefined", () => {
		expect(translateBashToTool("rg pattern | head")).toBeUndefined();
	});
	test("rg -e flag -> undefined", () => {
		expect(translateBashToTool("rg -e pattern")).toBeUndefined();
	});
	test("rg with two paths -> undefined", () => {
		expect(translateBashToTool("rg pat src test")).toBeUndefined();
	});
	test("tail -> undefined", () => {
		expect(translateBashToTool("tail -n 5 f")).toBeUndefined();
	});
	test("find -type -> undefined", () => {
		expect(translateBashToTool("find . -type f")).toBeUndefined();
	});
	test("$(...) -> undefined", () => {
		expect(translateBashToTool("echo $(cat f)")).toBeUndefined();
	});
	test("grep $(ls) -> undefined", () => {
		expect(translateBashToTool("grep pat $(ls)")).toBeUndefined();
	});
	test("redirection -> undefined", () => {
		expect(translateBashToTool("cat foo > bar")).toBeUndefined();
	});
	test("semicolon -> undefined", () => {
		expect(translateBashToTool("cat foo; echo hi")).toBeUndefined();
	});
	test("&& -> undefined", () => {
		expect(translateBashToTool("cat foo && echo hi")).toBeUndefined();
	});
	test("find -iname -> undefined", () => {
		expect(translateBashToTool("find . -iname '*.ts'")).toBeUndefined();
	});
});

describe("bash auto-redirect dispatch", () => {
	let artifactCounter = 0;

	function createTestToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
		const sessionFile = path.join(cwd, "session.jsonl");
		const sessionDir = path.join(cwd, "session");
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => sessionDir,
			allocateOutputArtifact: async (toolType: string) => {
				fs.mkdirSync(sessionDir, { recursive: true });
				const id = String(++artifactCounter);
				return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
			},
			settings,
			...overrides,
		};
	}

	function createTestToolContext(toolNames: string[]): AgentToolContext {
		return {
			sessionManager: SessionManager.inMemory(),
			modelRegistry: {
				find: () => undefined,
				getAll: () => [],
				getApiKey: async () => undefined,
			} as unknown as AgentToolContext["modelRegistry"],
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			toolNames,
		} as unknown as AgentToolContext;
	}

	test("cat dispatches to read with notice", async () => {
		const testDir = path.join(os.tmpdir(), `bash-redirect-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		fs.writeFileSync(path.join(testDir, "hello.txt"), "hello world\n");

		let capturedInput: unknown;
		const fakeReadTool = {
			name: "read",
			label: "read",
			execute: async (_id: string, params: unknown) => {
				capturedInput = params;
				return { content: [{ type: "text", text: "hello world\n" }] };
			},
		} as unknown as AgentTool;

		const session = createTestToolSession(testDir, Settings.isolated({ "bashInterceptor.enabled": true }), {
			getToolByName: (name: string) => (name === "read" ? fakeReadTool : undefined),
		});
		const bashTool = wrapToolWithMetaNotice(new BashTool(session));
		const ctx = createTestToolContext(["read", "grep", "glob", "bash"]);

		const result = await bashTool.execute(
			"id-1",
			{ command: "cat hello.txt" } as unknown as Parameters<(typeof bashTool)["execute"]>[1],
			undefined,
			undefined,
			ctx,
		);
		expect((capturedInput as unknown as { path: string }).path).toBe("hello.txt");
		const firstText = (
			result.content.find((c: unknown) => (c as { type: string }).type === "text") as unknown as { text: string }
		)?.text as string;
		expect(firstText).toContain("auto-redirected to `read`");
		expect(firstText).toContain("hello world");

		fs.rmSync(testDir, { recursive: true, force: true });
	});

	test("untranslatable cat still blocks", async () => {
		const testDir = path.join(os.tmpdir(), `bash-redirect-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		const session = createTestToolSession(testDir, Settings.isolated({ "bashInterceptor.enabled": true }));
		const bashTool = wrapToolWithMetaNotice(new BashTool(session));
		const ctx = createTestToolContext(["read", "grep", "glob", "bash"]);

		await expect(
			bashTool.execute(
				"id-2",
				{ command: "cat a b" } as unknown as Parameters<(typeof bashTool)["execute"]>[1],
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/Blocked/);

		fs.rmSync(testDir, { recursive: true, force: true });
	});

	test("redirect degrades to block when getToolByName missing", async () => {
		const testDir = path.join(os.tmpdir(), `bash-redirect-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		const session = createTestToolSession(testDir, Settings.isolated({ "bashInterceptor.enabled": true }));
		const bashTool = wrapToolWithMetaNotice(new BashTool(session));
		const ctx = createTestToolContext(["read", "grep", "glob", "bash"]);

		await expect(
			bashTool.execute(
				"id-3",
				{ command: "cat hello.txt" } as unknown as Parameters<(typeof bashTool)["execute"]>[1],
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/Blocked/);

		fs.rmSync(testDir, { recursive: true, force: true });
	});
});
