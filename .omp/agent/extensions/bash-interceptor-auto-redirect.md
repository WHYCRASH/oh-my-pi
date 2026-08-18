# bash-interceptor auto-redirect — transparent bash→tool translation

> **Location:** `packages/coding-agent/src/tools/bash-redirect.ts` + `packages/coding-agent/src/tools/bash.ts:982`
> **Config:** `~/.omp/agent/config.yml` → `bashInterceptor.enabled: true`
> **Prompt nudge:** `packages/coding-agent/src/prompts/tools/bash.md` (`<critical>`)

## What it does

Models kept calling `bash` with `cat`/`head`/`rg`/`grep`/`find` despite the prompt's `NEVER use shell grep/rg` guidance. The old interceptor just threw `Blocked: use read/grep/glob…`, burning a full tool round-trip before the retry.

Now simple intercepted commands **auto-redirect** to the dedicated tool with a notice, no wasted call.

## Translator `translateBashToTool(command)`

`src/tools/bash-redirect.ts` — quote/escape-aware tokenizer + metachar scan.

- Bails (→ `undefined`, keep blocking) if `| & ; ( ) < >` `` ` `` `$` appears outside quotes, or tokenization fails (incomplete quoting).
- Mappings (anything else → `undefined`):

| bash form | → tool |
|---|---|
| `cat <path>` / `less <path>` / `more <path>` (exactly one non-flag arg) | `read` `{path}` |
| `head -n <N> <path>` / `head -<N> <path>` | `read` `{path: "<path>:1-<N>"}` (`tail` not mapped — no negative selector) |
| `rg|grep|egrep|fgrep|ripgrep|ag|ack [flags] <pattern> [path]` | `grep` `{pattern, path?, case?}` — allowed flags only: `-i`/`--ignore-case`→`case:false`, `-F`/`--fixed-strings`→regex-escaped pattern, combined `-iF`, `fgrep` implicit `-F`, `--` passthrough; any other flag / `-e` / >2 positionals → no redirect |
| `find <dir> -name <glob>` (exactly 4 tokens, predicate must be `-name`) | `glob` `{path: dir==="." ? glob : "dir/glob"}` (`-iname`/`-type` etc. → no redirect) |

## Dispatch `src/tools/bash.ts`

At the existing `bashInterceptor.enabled` loop (`commandsToCheck` = `rawCommand` + cwd-normalized `command`):

```ts
const interception = checkBashInterception(commandToCheck, ctx.toolNames, rules, rawCommand);
if (interception.block) {
  const redirect = translateBashToTool(commandToCheck);
  if (redirect && session.getToolByName?.(redirect.tool)) {
    const result = await targetTool.execute(_toolCallId, {...redirect.input, i: `auto-redirect from bash: ${cmd}`}, signal, undefined, ctx);
    result.content = [{type:"text", text:`[bash "${cmd}" auto-redirected to \`${tool}\` — call \`${tool}\` directly next time]\n` + first.text}, ...rest];
    return result;
  }
  throw new ToolError(interception.message ?? "Command blocked");
}
```

- `checkBashInterception` signature/behavior unchanged; translation is additive.
- `onUpdate` omitted (details types differ); `ctx.toolNames` already gates.
- If `getToolByName` missing (restricted session) → degrades to original block.

## Prompt

`src/prompts/tools/bash.md` `<critical>` now:

```
{{#if hasGrep}}- NEVER use shell `grep`/`rg`; use built-in `grep`.{{/if}}
{{#if hasRead}}- `cat`/`head <N>` a file → `read` (use `path:1-N` selector); NEVER shell cat/head/tail.{{/if}}
{{#if hasRead}}{{#if hasGlob}}- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.{{/if}}{{/if}}
- Avoid `tail` and redirection: output is captured, truncated, and linked as `artifact://<id>`.
```

## Tests

`test/bash-redirect.test.ts`:

- 29 translator unit cases: `cat`/`less`/`more`, quoted paths, `head -n 50`/`head -50`, `rg`/`grep -F`/`--fixed-strings`/`fgrep`/`-iF`/`-i`/`--ignore-case`/`--` with dash pattern, `find src -name`/`find . -name`, rejects for `cat a b`, `cat -n`, `rg | head`, `rg -e`, `rg pat src test`, `tail`, `find -type`, `$(…)`, `>`, `;`, `&&`, `-iname`.
- 3 dispatch integration: `cat`→`read` with notice + captures input, untranslatable `cat a b` still throws `Blocked`, missing `getToolByName` degrades to block.
- `bun test test/bash-redirect.test.ts` 32 pass; `bun run check:types` (`tsgo`) clean.

## Verification (live)

Via `BashTool` wired to real `ReadTool`/`GrepTool`/`GlobTool` in a tmp dir:

- `cat hello.txt` / `head -n 1 hello.txt` / `rg hello .` / `rg -i HELLO .` / `grep -F 'hello world' hello.txt` / `find . -name '*.ts'` → auto-redirect with notice.
- `cat hello.txt app.ts` / `tail -n 5 hello.txt` / `cat hello.txt | head` → correctly blocked.

## Maintenance

- Keep `bash-redirect.ts` conservative: only flat single commands, no pipes/redirects/subshells.
- To add a mapping, extend `translateBashToTool` and add unit cases; keep fallback to block for anything ambiguous.
