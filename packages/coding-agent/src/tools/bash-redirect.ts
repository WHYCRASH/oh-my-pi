export interface BashRedirect {
	tool: "read" | "grep" | "glob";
	input: Record<string, unknown>;
}

/**
 * Tokenize a shell command with quote/escape awareness.
 * Returns null on incomplete quoting.
 */
function tokenize(command: string): string[] | null {
	const tokens: string[] = [];
	let i = 0;
	const len = command.length;
	while (i < len) {
		while (i < len && (command[i] === " " || command[i] === "\t")) i++;
		if (i >= len) break;
		let token = "";
		let inSingle = false;
		let inDouble = false;
		let tokenStarted = false;
		while (i < len) {
			const ch = command[i];
			if (inSingle) {
				if (ch === "'") {
					inSingle = false;
					i++;
					tokenStarted = true;
				} else {
					token += ch;
					i++;
					tokenStarted = true;
				}
				continue;
			}
			if (inDouble) {
				if (ch === "\\") {
					if (i + 1 >= len) return null;
					token += command[i + 1];
					i += 2;
					tokenStarted = true;
					continue;
				}
				if (ch === '"') {
					inDouble = false;
					i++;
					tokenStarted = true;
					continue;
				}
				token += ch;
				i++;
				tokenStarted = true;
				continue;
			}
			if (ch === "'") {
				inSingle = true;
				i++;
				tokenStarted = true;
				continue;
			}
			if (ch === '"') {
				inDouble = true;
				i++;
				tokenStarted = true;
				continue;
			}
			if (ch === "\\") {
				if (i + 1 >= len) return null;
				token += command[i + 1];
				i += 2;
				tokenStarted = true;
				continue;
			}
			if (ch === " " || ch === "\t") break;
			token += ch;
			i++;
			tokenStarted = true;
		}
		if (inSingle || inDouble) return null;
		if (tokenStarted) tokens.push(token);
	}
	return tokens;
}

/** Returns true if command contains shell metachars outside quotes. */
function hasMetacharsOutsideQuotes(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "|" || ch === "&" || ch === ";" || ch === "(" || ch === ")" || ch === "<" || ch === ">" || ch === "`" || ch === "$") {
			return true;
		}
	}
	return false;
}

const READ_COMMANDS: Record<string, true> = {
	cat: true,
	less: true,
	more: true,
};
const GREP_COMMANDS: Record<string, true> = {
	grep: true,
	rg: true,
	egrep: true,
	fgrep: true,
	ripgrep: true,
	ag: true,
	ack: true,
};

export function translateBashToTool(command: string): BashRedirect | undefined {
	const trimmed = command.trim();
	if (trimmed.length === 0) return undefined;
	if (hasMetacharsOutsideQuotes(trimmed)) return undefined;
	const tokens = tokenize(trimmed);
	if (tokens === null || tokens.length === 0) return undefined;
	const cmd = tokens[0];

	if (READ_COMMANDS[cmd]) {
		if (tokens.length !== 2) return undefined;
		const arg = tokens[1];
		if (arg.startsWith("-")) return undefined;
		if (arg.length === 0) return undefined;
		return { tool: "read", input: { path: arg } };
	}

	if (cmd === "head") {
		if (tokens.length === 3 && /^-([0-9]+)$/.test(tokens[1])) {
			const n = tokens[1].slice(1);
			if (!/^[1-9][0-9]*$/.test(n)) return undefined;
			const file = tokens[2];
			if (file.startsWith("-") || file.length === 0) return undefined;
			return { tool: "read", input: { path: `${file}:1-${n}` } };
		}
		if (tokens.length === 4 && tokens[1] === "-n") {
			const n = tokens[2];
			if (!/^[1-9][0-9]*$/.test(n)) return undefined;
			const file = tokens[3];
			if (file.startsWith("-") || file.length === 0) return undefined;
			return { tool: "read", input: { path: `${file}:1-${n}` } };
		}
		return undefined;
	}

	if (GREP_COMMANDS[cmd]) {
		let caseInsensitive = false;
		let fixedStrings = false;
		if (cmd === "fgrep") fixedStrings = true;
		let seenDashDash = false;
		const positional: string[] = [];
		for (let idx = 1; idx < tokens.length; idx++) {
			const tok = tokens[idx];
			if (seenDashDash) {
				positional.push(tok);
				continue;
			}
			if (tok === "--") {
				seenDashDash = true;
				continue;
			}
			if (tok.startsWith("-") && tok.length > 1) {
				if (tok.startsWith("--")) {
					if (tok === "--ignore-case") {
						caseInsensitive = true;
						continue;
					}
					if (tok === "--fixed-strings") {
						fixedStrings = true;
						continue;
					}
					return undefined;
				}
				for (let ci = 1; ci < tok.length; ci++) {
					const ch = tok[ci];
					if (ch === "i") {
						caseInsensitive = true;
					} else if (ch === "F") {
						fixedStrings = true;
					} else {
						return undefined;
					}
				}
				continue;
			}
			positional.push(tok);
		}
		if (positional.length === 0 || positional.length > 2) return undefined;
		let pattern = positional[0];
		if (pattern.length === 0) return undefined;
		if (fixedStrings) pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const input: Record<string, unknown> = { pattern };
		if (positional.length === 2) {
			const p = positional[1];
			if (p.length === 0) return undefined;
			input.path = p;
		}
		if (caseInsensitive) input.case = false;
		return { tool: "grep", input };
	}

	if (cmd === "find") {
		if (tokens.length !== 4) return undefined;
		const dir = tokens[1];
		const predicate = tokens[2];
		const glob = tokens[3];
		if (predicate !== "-name") return undefined;
		if (dir.length === 0 || glob.length === 0) return undefined;
		const globPath = dir === "." ? glob : `${dir}/${glob}`;
		return { tool: "glob", input: { path: globPath } };
	}

	return undefined;
}
