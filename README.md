# (Frida) Kahlo MCP

<p>
  <img src="kahlo-01.png" align="left" width="200" hspace="12" vspace="6" alt="Kahlo logo" />
  <b>Kahlo</b> is a <a href="https://frida.re/">Frida</a> MCP server that exposes Android dynamic instrumentation capabilities to AI agents. It wraps Frida's runtime manipulation APIs into a structured tool interface, enabling AI systems to attach to processes, inject instrumentation code, capture telemetry, and iterate on analysis workflows without manual intervention.
  <br><br>
  The server manages the full lifecycle of instrumentation sessions: device discovery, process attachment or spawning, job execution with per-script isolation, event streaming with cursor-based pagination, and binary artifact storage. Jobs run in isolated Frida scripts with automatic cleanup on cancellation. A built-in stdlib provides many standard code primitives for Java object inspection, stack traces, Intent parsing, and method hooking.
<br><br>
</p>

For more details, please read the accompanying blog post:
[https://knifecoat.com/Posts/Scalable+research+tooling+for+agent+systems](https://knifecoat.com/Posts/Scalable+research+tooling+for+agent+systems)

<p clear="left" align="center">
  <br><img src="kahlo-02.svg" alt="Kahlo Architecture Diagram" width="800" />
</p>

## Setup & Installation

Edit the existing [`kahlo-mcp/config.json`](kahlo-mcp/config.json) in this repo and set `adbPath` to the **full path** of the ADB binary you want to use. This works fine on Windows and UNIX systems.

```json
{
  "transport": "stdio",
  "logLevel": "info",
  "dataDir": "./data",
  "adbPath": "/path/to/adb"
}
```

Install dependencies and build:

```bash
cd kahlo-mcp
npm install
npm run build
```

| Field | Required | Description |
|-------|----------|-------------|
| `transport` | Yes | Only `"stdio"` is supported for now (SSE coming) |
| `logLevel` | Yes | Use `"info"` for now (more controls coming) |
| `dataDir` | Yes | Directory for runs, modules, drafts, artifacts. Defaults to `kahlo-mcp/data` |
| `adbPath` | Yes | Full path to ADB binary |

Upload a `frida-server` binary to your device that matches the `frida` version in [`kahlo-mcp/package.json`](kahlo-mcp/package.json), then run it (ideally as root).

## MCP Integration

### Claude Code

Edit your claude user json preference file (`/mcp` will show you where):

```json
{
  "mcpServers": {
    "frida-kahlo": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Your/Full/Path/k4hlo/kahlo-mcp/dist/index.js"
      ],
      "cwd": "C:/Your/Full/Path/k4hlo/kahlo-mcp"
    }
  }
}
```

### Cursor

Add to Cursor MCP settings (Preferences > Cursor Settings > Tools & MCP):

```json
{
  "mcpServers": {
    "frida-kahlo": {
      "command": "node",
      "args": ["/Your/Full/Path/k4hlo/kahlo-mcp/dist/index.js"],
      "cwd": "/Your/Full/Path/k4hlo/kahlo-mcp"
    }
  }
}
```

### Codex CLI

You will find your `toml` file under your user configuration folder for `.codex`:

```toml
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"

[mcp_servers.frida-kahlo]
command = "node"
args = ["/Your/Full/Path/k4hlo/kahlo-mcp/dist/index.js"]
cwd = "/Your/Full/Path/k4hlo/kahlo-mcp"
```

## MCP Tools Reference

This section is a quick, utilitarian map of the tool surface. For the complete operational contract (concepts, workflows, failure modes, and full stdlib reference), ask you AI to call `kahlo_mcp_about` to tell you more!

### Introspection

- `kahlo_mcp_about`: returns the kahlo operational contract (tool inventory, concepts, workflows, failure modes, stdlib reference).

### Devices, processes, and ADB

- `kahlo_devices_list`: list connected devices ready for instrumentation.
- `kahlo_devices_get` (`device_id`): detailed device info (model/version/transport) and readiness signals.
- `kahlo_devices_health` (`device_id`): health check for ADB + frida-server presence/running.
- `kahlo_processes_list` (`device_id`, `scope?`): list running processes (pid + name). Use this before `mode="attach"` to get the exact process name.
- `kahlo_adb_command` (`command[]`, `device_id?`, `timeout_ms?`): run an ADB command with the configured ADB binary. For root-only paths, wrap with `su -c` (e.g., `['shell','su','-c','ls /data/data/<pkg>']`).

### Targets (attach/spawn + lifecycle)

- `kahlo_targets_ensure`:
  - **Purpose**: create/ensure a target (an instrumented app process hosting the in-process orchestrator).
  - **Params**: `device_id`, `package`, `mode` (`attach|spawn`), `gating?` (`none|spawn|child`), `bootstrap?`, `bootstrap_params?`, `bootstrap_type?`, plus optional `child_*` bootstrap fields.
  - **Notes**:
    - `mode="attach"`: `package` is the *process name* from `kahlo_processes_list` (often not the Android package id).
    - `mode="spawn"`: `package` is the Android package id (e.g., `com.example.app`).
    - `gating="spawn"` requires `bootstrap` (early hooks while app is suspended, then it resumes automatically).
    - `gating="child"` is present but **does not work on Android** (zygote forks child processes). For multi-process apps, discover `com.example.app:process` names and attach separately.
- `kahlo_targets_status` (`target_id`): target lifecycle + orchestrator agent state (use to diagnose crashes/reinjecting).
- `kahlo_targets_detach` (`target_id`): detach cleanly; cancels all jobs for that target.

### Jobs (run instrumentation code)

- `kahlo_jobs_start`:
  - **Purpose**: start an isolated job (one Frida script instance) inside a target.
  - **Params**: `target_id`, `type?` (`oneshot|interactive|daemon`), `ttl?`, `params?`, and `module`:
    - `{ kind: 'module_ref', module_ref: 'name@version' }`
    - `{ kind: 'draft_id', draft_id: '...' }`
    - `{ kind: 'source', source: '...' }` (inline JS for fast iteration)
  - **Notes**: daemon jobs should call `ctx.heartbeat()` periodically; cancellation unloads the script and Frida cleans up hooks/timers/state.
- `kahlo_jobs_status` (`job_id`): job lifecycle + heartbeat health + metrics + error/result.
- `kahlo_jobs_list` (`target_id`): list jobs for a target (active + historical).
- `kahlo_jobs_cancel` (`job_id`): cancel a job; unloads its script (best-effort cleanup via Frida).

### Telemetry and snapshots

- `kahlo_events_fetch` (`target_id?` or `job_id?`, `cursor?`, `limit?`, `filters?`): poll structured events with cursor-based pagination. `filters` supports `kind` and/or `level`.
- `kahlo_snapshots_get` (`target_id`, `kind`, `options?`): point-in-time state queries (use sparingly; can be expensive).

### Artifacts (large outputs)

- `kahlo_artifacts_list` (`target_id?` or `job_id?`): list artifacts produced by jobs (files/dumps/traces/etc).
- `kahlo_artifacts_get` (`artifact_id`): fetch artifact metadata and either inline payload (small) or a storage reference (large).

### Modules and drafts (reusable job code)

- `kahlo_modules_list`: list versioned modules in the module store.
- `kahlo_modules_get` (`module_ref` like `name@1.2.3`): fetch module source + manifest + provenance.
- `kahlo_modules_createDraft` (`source`, `name?`, `manifest?`): create a mutable draft for iteration.
- `kahlo_modules_createDraftFromJob` (`job_id`, `name?`): "save my working job" as a draft.
- `kahlo_modules_listDrafts`: list drafts (metadata only).
- `kahlo_modules_getDraft` (`draft_id`): fetch draft metadata + full source.
- `kahlo_modules_updateDraft` (`draft_id`, `source`): replace draft source (iterate quickly).
- `kahlo_modules_promoteDraft` (`draft_id`, `name`, `version_strategy`, `notes?`): freeze a draft into a versioned module (`patch|minor|major`).
- `kahlo_modules_promoteFromJob` (`job_id`, `name`, `version_strategy`, `notes?`): promote a tested job directly into a versioned module.

## Stdlib (`ctx.stdlib`)

Every job script gets a preloaded standard library under `ctx.stdlib`. This is the preferred way to do common "instrumentation chores" (stack capture, safe Java calls, overload-safe hooks, bytes/strings, Intent parsing, etc.) without rewriting boilerplate.

Source of truth: `kahlo-mcp/src/backend/jobs/jobScriptStdlib.js`.

### Top-level helpers

- `ctx.stdlib.isJavaAvailable()`: returns `true` if Java APIs can be used in this process.
- `ctx.stdlib.getJavaBridge()`: returns the Java bridge handle (or `null`).
- `ctx.stdlib.requireJava(operation?)`: returns the Java bridge or throws with a helpful message.

### `stack` - Java stack traces

- `capture({ skip?, limit? })`: capture frames as objects (`className`, `methodName`, `fileName`, `lineNumber`, `isNative`).
- `toString({ skip?, limit?, separator? })`: formatted stack trace string.
- `filter(frames, pattern)`: keep frames matching a prefix string or RegExp.
- `findFirst(frames, pattern)`: first matching frame (or `null`).
- `getCaller()`: best-effort "caller" frame (skips internal/runtime frames).
- `getException(throwable)`: format a Java `Throwable` (message + stack + causes) as a string.

### `inspect` - Java object introspection

- `className(obj)`, `simpleClassName(obj)`
- `fields(obj, { includeInherited?, includeStatic? }?)`: enumerate fields (including private).
- `methods(obj, { includeInherited?, includeStatic? }?)`: enumerate methods.
- `getField(obj, fieldName)`: safe field read (`{ ok, value, error? }`).
- `toJson(obj, { maxDepth?, maxArrayLength?, maxStringLength? }?)`: convert common Java objects to JSON-safe structures.
- `isInstance(obj, className)`
- `superclassChain(obj)`
- `interfaces(obj, includeInherited?)`

### `classes` - discovery and loading

- `find(pattern, { limit? }?)`: search loaded classes by prefix string or RegExp.
- `enumerate(callbackOrOptions?)`: list loaded classes (either returns an array, or streams via callback depending on usage).
- `load(className)`: safe `Java.use` (returns `null` on failure).
- `isLoaded(className)`: quick check if a class is loaded.
- `instances(className, { limit? }?)`: enumerate live heap instances (best-effort, can be expensive).
- `getClassLoader(className)`: get the `ClassLoader` for a loaded class (or `null`).

### `bytes` - binary helpers

- `toHex(data, { uppercase?, separator? }?)`, `fromHex(hex)`
- `toBase64(data)`, `fromBase64(base64)`
- `fromJavaBytes(byteArray)`, `toJavaBytes(uint8Array)`
- `equals(a, b)`, `concat(...arrays)`, `slice(data, start, end?)`

### `strings` - conversions and encoding

- `fromJava(javaStringLike)`, `toJava(jsString)`
- `truncate(str, maxLength, ellipsis?)`
- `fromUtf8(data)`, `toUtf8(str)`
- `matches(str, pattern)`
- `safeToString(obj, maxLength?)`

### `intent` - Intent parsing and construction

- `parse(intent)`: returns a structured summary (action/data/type/categories/component/flags/extras).
- `getExtras(intent)`: extract extras Bundle into a JS object (recurses on nested Bundles).
- `getComponent(intent)`, `isExplicit(intent)`
- `create({ action?, data?, type?, flags?, packageName?, className?, extras? })`: build a new Intent (returns `null` on failure).
- `flagsToStrings(flags)`: decode the bitmask to flag names.

### `hook` - hook helpers (Java + native)

- `method(className, methodName, { onEnter?, onLeave? })`: hook a method (all overloads if present).
- `methodWithSignature(className, methodName, paramTypes[], { onEnter?, onLeave? })`: hook a specific overload.
- `allOverloads(className, methodName, handler)`: hook all overloads with a single handler.
- `constructor(className, handler)`: hook all `$init` overloads.
- `onClassLoad(className, callback)`: run `callback(Java.use(className))` once the class becomes available.
- `native(addressOrSymbol, callbacks)`: `Interceptor.attach` wrapper for native hooks.
- `replace(classWrapper, methodName, replacement)`: replace implementation and get a restore function.

### `safe` - fail-closed wrappers

- `java(fn)`: run in `Java.performNow` and return `{ ok, result?, error? }`.
- `call(fn)`: try/catch wrapper returning `{ ok, result?, error? }`.
- `timeout(fn, timeoutMs)`: Promise wrapper returning `{ ok, result?, error? }` (does not cancel underlying work).
- `tryUse(className)`: safe `Java.use` (returns `null` instead of throwing).
- `invoke(obj, methodName, ...args)`: safe method invocation (returns `null` on any failure).
- `get(obj, keyPath, defaultValue?)`: safe property lookup (supports dot paths).

### `time` - timestamps and rate limiting

- `now()`, `nowMs()`, `hrNow()`
- `format(ms)`, `stopwatch()`
- `sleep(ms)`, `measure(fn)`
- `debounce(fn, delayMs)`, `throttle(fn, intervalMs)`
