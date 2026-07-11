# Task Template

Each task is written to this 12-field specification. Compared to the 6-field W00 migration format, this adds design depth and acceptance precision.

---

## 12-Field Specification

### Field 1: Task ID + Title

```markdown
### <AREA>-NNN · <One-line title>
```

- **ID**: Namespaced, format `<AREA>-NNN` (e.g., `MIG-FND-002`, `FEAT-AUTH-001`)
- **Title**: Verb-led, one sentence describing what this does. Keep under 60 chars.

### Field 2: Purpose & Scope

```markdown
- **Purpose**: [Why this task exists, what problem it solves]
- **Scope**: [What specific functions/modules are covered]
- **Excluded**: [What is explicitly NOT covered — delegated to other tasks]
```

**Requirement**: Exclusions are mandatory. When unsure about boundaries, put it in exclusions — better than missing it.

**Example**:

```markdown
- **Purpose**: Provide general-purpose atomic JSON file read/write, replacing repeated tmp-file write logic scattered across modules.
- **Scope**: `readJson<T>` read, `writeJsonAtomic` atomic write, `isolateCorrupt` corruption isolation.
- **Excluded**: Not handling JSONL format (delegated to MIG-FND-007); no schema validation (each business module handles its own).
```

### Field 3: Source Mapping

```markdown
- **Source**: [Existing code/artifact paths, listed file-by-file]
  - `path/to/file.py` — `ClassName.method()` — [what is being ported]
  - `path/to/another.py` — `function_name()` — [what is being ported]
```

**Requirement**: Precision at function/class level. No "etc." or "related code."

**Example**:

```markdown
- **Source (Python)**:
  - `agent/tasks/store.py` — `_atomic_write_text()` — atomic write pattern
  - `agent/scheduler/store.py` — filelock + JSON read-modify-write — scheduler store usage
  - `agent/runtime/store.py` — JSONL append + corrupt isolation — runtime store usage
  - `agent/memory_versions.py` — `_atomic_write_text` + `except BaseException` cleanup — rollback pattern
  - `agent/local_config.py` — `_preserve_corrupt_local_config()` — corrupt isolation pattern
```

### Field 4: Target Specification

````markdown
- **Target (TS)**:
  - `packages/core/src/store/atomic-json.ts` — main module
  - Public API:
    ```typescript
    async function readJson<T>(path: string, defaultVal: T): Promise<T>
    async function writeJsonAtomic(path: string, data: unknown): Promise<void>
    async function isolateCorrupt(
      path: string,
      onDiagnostic?: (msg: string) => void,
    ): Promise<string>
    ```
````

**Requirement**: Public APIs must have complete type signatures. Internal helpers are optional.

### Field 5: Detailed Design

This is the **most important field**. Must cover these sub-sections:

#### 5.1 Data Models

Write concrete type definitions as code blocks — not descriptions.

````markdown
#### Data Models

```typescript
interface StoreOptions {
  /** Normalize data before writing */
  normalize?: <T>(data: T) => T
  /** Callback on corrupt file, for diagnostics reporting */
  onCorrupt?: (originalPath: string, corruptPath: string, error: Error) => void
}
```
````

````

#### 5.2 Key Algorithms / Logic

Pseudocode or decision tables. Branch conditions must be explicit.

```markdown
#### Key Algorithms

**writeJsonAtomic flow**:
````

1. Serialize data → JSON string (pretty print, 2-space indent)
2. Write to <path>.tmp.<pid> (same directory, ensures same filesystem)
3. fs.fsync(tmpFd) — force flush to disk
4. fs.rename(tmpPath, path) — same-directory rename is atomic
5. Return success
6. Any step fails → fs.unlink(tmpPath) (best-effort) + rethrow original error

```

**readJson corruption isolation flow**:
```

1. fs.readFile(path, 'utf-8')
2. JSON.parse(content)
3. Success → return parsed result
4. JSON.parse failure:
   a. Copy corrupt file to <path>.corrupt-<ISO8601-timestamp>
   b. Call onCorrupt(path, corruptPath, error)
   c. Return defaultVal

```

```

#### 5.3 State Machines (if applicable)

```markdown
#### State Machine

| Current State | Event         | New State | Side Effect     |
| ------------- | ------------- | --------- | --------------- |
| IDLE          | write request | WRITING   | Create tmp file |
| WRITING       | fsync OK      | RENAMING  | fs.rename       |
| WRITING       | I/O error     | ERROR     | Clean up tmp    |
| RENAMING      | rename OK     | IDLE      | Return success  |
| RENAMING      | rename error  | ERROR     | Clean up tmp    |
```

#### 5.4 Invariants

Must be written as assertions — conditions that hold true under any operation.

```markdown
#### Invariants

1. **Atomicity**: The file is either in old-complete state or new-complete state — never a half-written state.
   Verify: `assert(fileContent === oldContent || fileContent === newContent)`
2. **Data safety**: On write failure, original file content is byte-for-byte unchanged.
   Verify: sha256(original pre-write) === sha256(original post-failure)
3. **Corruption preserved**: Original corrupt file content is fully retained in `.corrupt-*` backup.
   Verify: `assert(corruptFileContent === originalCorruptContent)`
4. **Concurrency safety**: Concurrent writes to the same path produce one complete write (no interleaving).
   Verify: After N concurrent writes, file is parseable by JSON.parse.
```

#### 5.5 Edge Cases

List concrete scenarios (not "handle edge cases"), with expected behavior.

```markdown
#### Edge Cases

| Scenario                                   | Expected Behavior                                                    |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Empty file (0 bytes)                       | `readJson` returns defaultVal, no corrupt backup created             |
| File content is non-JSON text              | Create corrupt backup, return defaultVal                             |
| Directory does not exist                   | `writeJsonAtomic` throws, error message includes path                |
| File locked by another process (Windows)   | rename fails → clean up tmp → throw `FileLockError`                  |
| Disk full                                  | fsync fails → clean up tmp → throw, message includes available space |
| 10 concurrent writeJsonAtomic to same path | All writes complete, final file is intact, 0 corrupt backups         |
| JSON contains undefined / circular ref     | JSON.stringify throws → no tmp created → original file unchanged     |
| Path is a symlink                          | Follow symlink, write to target file                                 |
| Very large JSON (>100MB)                   | Functionally correct, warn log emitted (suggest using JSONL)         |
```

#### 5.6 Compatibility Requirements

```markdown
#### Compatibility

- **Disk format**: JSON indentation is 2-space (matching Python `json.dumps(indent=2)`)
- **Filenames**: Corrupt backup naming `<name>.corrupt-<ts>` matches Python `_preserve_corrupt_local_config`
- **Encoding**: UTF-8 without BOM
```

#### 5.7 Library Selection (if applicable)

```markdown
#### Library Selection

- **JSON parsing**: Native `JSON.parse` (no third-party needed)
- **Atomic write**: Hand-written tmp+rename (avoid `write-file-atomic` — 50+ transitive dependencies for ~10 lines of logic)
- **File locking**: Use `proper-lockfile` (already introduced by MIG-FND-003)
```

### Field 6: Dependencies

```markdown
- **Internal dependencies**: [task ID list]
- **External dependencies**: [npm packages / system libs / external services]
```

**Example**:

```markdown
- **Internal dependencies**: MIG-FND-001 (monorepo skeleton)
- **External dependencies**: `proper-lockfile` (introduced by MIG-FND-003), Node.js `fs/promises`
```

### Field 7: Risk / Complexity

```markdown
- **Complexity**: S / M / L / XL
- **Risk sources**: [specific risk scenarios]
- **Mitigation strategy**: [how to reduce or handle each risk]
```

**Complexity definitions**:

- **S**: Pure logic, no external deps, single file, <100 lines
- **M**: Involves I/O or multiple modules, single or few files, 100-300 lines
- **L**: Cross-module, involves concurrency/network/platform differences, >300 lines
- **XL**: Cross-system boundary, involves protocol design or data migration, requires multiple iterations

**Example**:

```markdown
- **Complexity**: M
- **Risk sources**:
  1. `fs.rename` is atomic within the same directory (POSIX), but not across filesystems — tmp must be forced to target directory
  2. On Windows, `EPERM` is unreliable — some antivirus software briefly locks new files
  3. Race window in concurrent writes — tmp filename includes PID, but extreme PID reuse could collide
  4. Node.js `fs.rename` on Windows won't overwrite existing read-only files — must unlink first
- **Mitigation strategy**:
  1. **Force `tmpDir = path.dirname(targetPath)`** — no tmp directory configuration exposed
  2. Windows EPERM retry 3 times with exponential backoff (100ms, 200ms, 400ms)
  3. tmp filename = `<path>.tmp.<pid>.<random-4-hex>`, collision probability negligible (<1/65536)
  4. Before rename, check if target exists and is read-only → `fs.unlink` first, then rename
```

### Field 8: Test Plan

**Each task MUST have ≥8 test cases** (type/constant definition tasks can drop to 3-5):

| Dimension       | Minimum | Notes                                                       |
| --------------- | ------- | ----------------------------------------------------------- |
| Happy path      | ≥3      | Cover main input variants                                   |
| Edge conditions | ≥3      | Empty/zero/max/boundary/single-element                      |
| Error handling  | ≥2      | Invalid input throws correct exception type + error message |
| **Total**       | **≥8**  |                                                             |

**TDD Flow** (must be written in the plan; skipping RED confirmation = tests are invalid):

```
1. Write all tests listed above
2. Run tests → confirm RED (all fail)
3. Implement functionality → confirm GREEN (all pass)
4. Lint gate: lint must have zero errors before commit
```

```markdown
#### Ported Existing Tests

- `tests/unit/test_store.py` — `test_atomic_write_*` suite (6 tests)
- `tests/unit/test_local_config.py` — `test_preserve_corrupt_*` suite (3 tests)

#### New Tests (≥8)

**Happy path (≥3)**:

1. test_atomic_write_read_roundtrip — write then read yields equivalent data
2. test_atomic_write_preserves_indent — 2-space indentation is consistent
3. test_read_json_returns_typed_object — returns correct TypeScript type

**Edge conditions (≥3)**: 4. test_read_empty_file_returns_default — empty file → defaultVal, no corrupt created 5. test_read_corrupt_json_isolates — corrupt JSON → corrupt backup + defaultVal 6. test_concurrent_writes_no_corruption — 10 concurrent writes → file intact

**Error handling (≥2)**: 7. test_write_to_nonexistent_dir_throws — dir doesn't exist → ENOENT 8. test_windows_eperm_retry — mock EPERM → retries 3 times then throws FileLockError

#### TDD Flow

1. Write the 8 tests above → `npx vitest run atomic-json.test.ts` confirm RED
2. Implement `readJson` / `writeJsonAtomic` / `isolateCorrupt`
3. Run tests confirm GREEN → all pass
4. `npx tsc --noEmit` zero errors

#### Golden Data

- Python generates 100 random nested JSON → Python `_atomic_write_text` writes → TS `readJson` reads → deep compare
```

### Field 9: Acceptance Criteria

**Must use checkbox format**, each item binary-decidable ✓/✗.

```markdown
## Acceptance Criteria

### Functional Correctness

- [ ] `readJson<UserProfile>(path, default)` — normal file returns typed parsed object
- [ ] `readJson<UserProfile>(path, default)` — corrupt file returns default, no exception thrown
- [ ] `readJson<UserProfile>(path, default)` — empty file returns default, no corrupt backup
- [ ] `writeJsonAtomic(path, data)` — after write, `readJson` reads equivalent data
- [ ] `writeJsonAtomic(path, data)` — inode may change but content switches atomically
- [ ] `isolateCorrupt(path)` — copies file to `.corrupt-<ts>` and returns corrupt path

### Atomicity & Data Safety

- [ ] SIGKILL during write — file is either old or new content (no half-written JSON)
- [ ] Write failure (simulated disk full) — original file sha256 unchanged
- [ ] 10 concurrent `writeJsonAtomic` to same path — file parseable by JSON.parse, 0 corrupt backups

### Edge Behaviors

- [ ] Target directory doesn't exist → throws, error message includes path
- [ ] Windows EPERM → auto-retry 3 times, throw `FileLockError` if all fail
- [ ] JSON contains undefined → JSON.stringify omits, no tmp created, original file unchanged
- [ ] Path is symlink → correctly follows and writes to target file
- [ ] Very large JSON (>100MB) → functionally correct, warn log on stderr

### Compatibility

- [ ] Correctly reads files generated by Python `json.dumps(indent=2)`
- [ ] TS `writeJsonAtomic` output is correctly parsed by Python `json.load()`
- [ ] Corrupt backup filename `<name>.corrupt-<ISO8601>` matches Python convention
- [ ] Encoding is UTF-8 without BOM

### Code Quality

- [ ] TypeScript strict mode zero errors
- [ ] No `any` type (except JSON.parse return with explicit `as T` assertion)
- [ ] Functions have JSDoc comments describing purpose and boundaries
```

### Field 10: Effort Estimate

```markdown
- **Estimate**: [X] hours / [Y] story points
- **Rationale**: [brief breakdown of the estimate]
```

**Example**:

```markdown
- **Estimate**: 6 hours / 3 story points
- **Rationale**: Core logic ~80 lines TS (2h), tests ~150 lines (2h), cross-platform verification + golden data (2h)
```

### Field 11: Status

```markdown
- **Status**: ☐ todo / ◐ wip / ☑ done / ⛔ blocked
- **PR**: [link] or —
- **Completed**: [date] or —
```

### Field 12: Notes

```markdown
- **Design decisions**: [what was chosen, why, rejected alternatives]
- **Known limitations**: [scenarios not supported in current version]
- **Deferred TODOs**: [intentionally postponed work + tracking issue]
```

**Example**:

```markdown
- **Design decisions**: Hand-written tmp+rename instead of `write-file-atomic`. The npm package has 50+ transitive dependencies for ~10 lines of core logic — not worth the supply-chain risk.
- **Known limitations**: Does not handle atomicity on distributed filesystems like NFS (consistent with Python behavior).
- **Deferred TODOs**: Support configurable indent width (currently hardcoded 2-space). Tracking: ISSUE-#456
```

---

## Complete Example: MIG-FND-002 (12-Field Version)

Below is the full MIG-FND-002 task rewritten using this template, demonstrating the improvement over the W00 compact format.

---

### MIG-FND-002 · Atomic JSON Store + Corruption Isolation

- **Purpose**: Provide general-purpose atomic JSON file read/write, replacing repeated tmp-file + manual fsync + rename logic scattered across modules. All modules needing JSON persistence (tasks/scheduler/runtime/memory/config) share this primitive.
- **Scope**: `readJson<T>(path, defaultVal)` read, `writeJsonAtomic(path, data)` atomic write, `isolateCorrupt(path)` corruption isolation.
- **Excluded**: Not handling JSONL format (delegated to MIG-FND-007); no schema validation (each business module handles its own); not handling non-JSON formats (TOML/YAML handled separately).

- **Source (Python)**:
  - `agent/tasks/store.py` — `_atomic_write_text()` — tmp-write-then-rename atomic replacement pattern
  - `agent/scheduler/store.py` — filelock + JSON read-modify-write — scheduler store usage
  - `agent/runtime/store.py` — JSONL append + corrupt isolation — runtime store usage
  - `agent/memory_versions.py` — `_atomic_write_text` + `except BaseException` cleanup — finally-cleanup + rethrow pattern
  - `agent/local_config.py` — `_preserve_corrupt_local_config()` — corrupt file backup as `.corrupt-*` pattern

- **Target (TS)**: `packages/core/src/store/atomic-json.ts`

  ```typescript
  // Public API
  export async function readJson<T>(
    path: string,
    defaultVal: T,
    opts?: {
      onCorrupt?: (path: string, corruptPath: string, err: Error) => void
    },
  ): Promise<T>

  export async function writeJsonAtomic(
    path: string,
    data: unknown,
    opts?: { pretty?: boolean; indent?: number },
  ): Promise<void>

  export async function isolateCorrupt(
    path: string,
    onDiagnostic?: (msg: string) => void,
  ): Promise<string> // returns corrupt file path
  ```

- **Internal dependencies**: MIG-FND-001 (monorepo skeleton), MIG-FND-008 (StoreCorruptError type)

- **Detailed Design**:

  #### Data Models

  ```typescript
  interface AtomicJsonOptions {
    /** Indent spaces, default 2 (matches Python json.dumps(indent=2)) */
    indent?: number
    /** Callback on corrupt file, for diagnostics/logging */
    onCorrupt?: (
      originalPath: string,
      corruptPath: string,
      error: Error,
    ) => void
  }

  class StoreCorruptError extends Error {
    constructor(
      message: string,
      public readonly originalPath: string,
      public readonly corruptPath: string,
      public readonly cause: Error,
    ) {
      super(message)
      this.name = 'StoreCorruptError'
    }
  }
  ```

  #### Key Algorithms

  **writeJsonAtomic**:

  ```
  Input: path, data, opts
  1. serialized = JSON.stringify(data, null, opts.indent ?? 2)
  2. tmpPath = `${path}.tmp.${process.pid}.${randomHex(4)}`
  3. try:
     a. fd = await fs.open(tmpPath, 'w', 0o644)
     b. await fd.write(serialized, 'utf-8')
     c. await fd.sync()                  // force flush to disk
     d. await fd.close()
     e. await fs.rename(tmpPath, path)    // same-directory atomic rename
  4. catch err:
     a. await fs.unlink(tmpPath).catch(() => {})  // best-effort cleanup
     b. if (err.code === 'EPERM' && process.platform === 'win32') → retry (max 3 times, 100ms interval)
     c. throw err
  ```

  **readJson**:

  ```
  Input: path, defaultVal, opts
  1. content = await fs.readFile(path, 'utf-8')
  2. if (content.length === 0): return defaultVal   // empty file, no corrupt backup
  3. try: return JSON.parse(content) as T
  4. catch parseErr:
     a. ts = new Date().toISOString().replace(/[:.]/g, '-')
     b. corruptPath = `${path}.corrupt-${ts}`
     c. await fs.copyFile(path, corruptPath)         // preserve original corrupt content
     d. opts?.onCorrupt?.(path, corruptPath, parseErr)
     e. return defaultVal                            // return default, don't throw
  ```

  #### Invariants
  1. **Atomicity**: File final state is either old content or new content — never half-written JSON.
     Verify: `JSON.parse(fs.readFileSync(path))` never throws (after writeJsonAtomic returns)
  2. **Data safety**: After write failure, original file content is byte-for-byte unchanged.
  3. **Corruption preserved**: Original corrupt file content is fully copied to `.corrupt-*` backup.
  4. **Same-directory tmp**: tmp file is always in the same directory as target, ensuring rename atomicity.
     Verify: `path.dirname(tmpPath) === path.dirname(targetPath)`

  #### Edge Cases

  | Scenario                                               | Expected Behavior                                                                  |
  | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
  | Empty file (0 bytes)                                   | `readJson` returns defaultVal, no corrupt backup                                   |
  | File content is non-JSON text                          | Create corrupt backup, return defaultVal                                           |
  | Target directory does not exist                        | Throw `ENOENT`, error message includes full path                                   |
  | Windows file locked by another process                 | `EPERM` → retry 3 times (100ms intervals) → throw `StoreCorruptError`              |
  | Disk full                                              | `fsync` throws `ENOSPC` → clean up tmp → original file unchanged                   |
  | 10 concurrent writeJsonAtomic to same path             | All writes complete, final file is intact JSON, 0 corrupt backups                  |
  | JSON contains undefined / Symbol                       | `JSON.stringify` auto-omits → written JSON lacks that field (JS standard behavior) |
  | Path is a symlink                                      | Follow symlink, write to target file                                               |
  | tmp file already exists (PID reuse + random collision) | Retry with new random, max 5 attempts                                              |

  #### Compatibility
  - **Disk format**: JSON indentation is 2-space (matching Python `json.dumps(data, indent=2)`)
  - **Corrupt naming**: `<name>.corrupt-<ISO8601>` matches Python `_preserve_corrupt_local_config`
  - **Encoding**: UTF-8 without BOM
  - **Number precision**: `JSON.parse` parses numbers as `number` (IEEE 754 double). Large integers (>2^53) require libraries like `json-bigint` at the business layer — unrelated to this primitive.

  #### Library Selection
  - **JSON parse/stringify**: Node.js native `JSON.parse` / `JSON.stringify` (no third-party needed)
  - **Atomic write**: Hand-written tmp+rename (avoid `write-file-atomic` npm package — ~10 lines of logic not worth 50+ transitive dependencies)
  - **Random hex**: `crypto.randomBytes(2).toString('hex')` (Node.js native)

- **Complexity**: M
- **Risk sources**:
  1. `fs.rename` is atomic within same directory (POSIX) but not across filesystems — tmp must be forced to target directory
  2. Windows `EPERM` is unreliable — some antivirus software briefly locks new files
  3. Race window in concurrent writes — tmp filename includes PID + random, extreme PID reuse could collide
  4. Node.js `fs.rename` on Windows won't overwrite existing read-only files — must unlink first
- **Mitigation strategy**:
  1. **Force `tmpDir = path.dirname(targetPath)`** — no tmp directory configuration exposed
  2. Windows EPERM retry 3 times with exponential backoff (100ms, 200ms, 400ms)
  3. tmp filename = `<path>.tmp.<pid>.<random-4-hex>`, collision probability negligible (<1/65536)
  4. Before rename, check if target exists and is read-only → `fs.unlink` first, then rename

- **Test Plan**:

  #### Ported Tests (Python → vitest)

  | Python Test                                                     | vitest Equivalent                                         |
  | --------------------------------------------------------------- | --------------------------------------------------------- |
  | `tests/unit/test_store.py::test_atomic_write_success`           | `atomic-json.test.ts::writeJsonAtomic` normal write       |
  | `tests/unit/test_store.py::test_atomic_write_failure_cleanup`   | `atomic-json.test.ts::writeJsonAtomic` failure cleans tmp |
  | `tests/unit/test_store.py::test_concurrent_atomic_write`        | `atomic-json.test.ts::concurrent write`                   |
  | `tests/unit/test_local_config.py::test_preserve_corrupt`        | `atomic-json.test.ts::readJson` corrupt isolation         |
  | `tests/unit/test_local_config.py::test_corrupt_returns_default` | `atomic-json.test.ts::readJson` returns default           |
  | `tests/unit/test_local_config.py::test_corrupt_backup_content`  | `atomic-json.test.ts::corrupt` content byte-preserved     |

  #### New vitest Cases
  - **Empty file**: 0-byte file readJson returns defaultVal, no corrupt created
  - **Non-JSON content**: text "not json" → corrupt backup + returns defaultVal
  - **Windows EPERM mock**: mock `fs.rename` first-call EPERM → verify 3-retry logic
  - **Disk full mock**: mock `fd.sync()` throws ENOSPC → verify tmp cleanup + original file unchanged
  - **Concurrency safety**: 10 workers concurrent writeJsonAtomic same path, verify final file intact
  - **Symlink**: target is symlink → writes to actual file
  - **Read-only target (Windows)**: target is read-only → unlink first then rename
  - **Large file**: 100MB JSON read/write (verify doesn't block event loop — use `setImmediate` for yielding)

  #### Golden Data
  - Python generates 100 random nested JSON → Python `_atomic_write_text` writes → TS `readJson` reads → deep-compare field consistency
  - Python `json.dumps(data, indent=2)` → TS `readJson` → `writeJsonAtomic` → Python `json.load` → round-trip verify

- **Acceptance Criteria**:

  #### Functional Correctness
  - [ ] `readJson<UserProfile>(validPath, default)` returns correctly typed parsed object
  - [ ] `readJson<UserProfile>(corruptPath, default)` — corrupt file returns default, no exception
  - [ ] `readJson<UserProfile>(emptyPath, default)` — empty file returns default, no corrupt backup
  - [ ] `writeJsonAtomic(path, data)` — after write, `readJson(path)` reads deeply equivalent data
  - [ ] `isolateCorrupt(corruptPath)` — copies file to `.corrupt-<ts>` and returns path

  #### Atomicity & Data Safety
  - [ ] SIGKILL during write — file is either old or new content (no half-written JSON exists)
  - [ ] Write failure (simulated disk full) — original file sha256 unchanged
  - [ ] 10 concurrent `writeJsonAtomic` same path — file parseable by JSON.parse, 0 corrupt backups

  #### Edge Behaviors
  - [ ] Target directory doesn't exist → throws, error message includes full path
  - [ ] Windows EPERM mock → retries 3 times (exponential backoff), throws `StoreCorruptError` after all fail
  - [ ] Path is symlink → writes to target file
  - [ ] Target read-only file (Windows) → unlink first then rename succeeds
  - [ ] 100MB JSON → functionally correct, doesn't block event loop

  #### Compatibility
  - [ ] Correctly reads files generated by Python `json.dumps(data, indent=2)`
  - [ ] TS `writeJsonAtomic` output correctly parsed by Python `json.load()`
  - [ ] Corrupt backup filename `<name>.corrupt-<ISO8601>` matches Python convention
  - [ ] Encoding UTF-8 without BOM

  #### Code Quality
  - [ ] TypeScript strict mode `tsc --noEmit` 0 errors
  - [ ] No `any` type (`JSON.parse` return has explicit `as T` assertion + JSDoc explanation)
  - [ ] All 3 exported functions have complete JSDoc

- **Estimate**: 6 hours / 3 story points
- **Rationale**: Core logic ~80 lines TS (2h), tests ~150 lines (2h), golden data verification + cross-platform testing (2h)

- **Status**: ☑ done · PR: #XX

- **Notes**:
  - **Design decisions**: Hand-written tmp+rename instead of `write-file-atomic`. The npm package has 50+ transitive dependencies for ~10 lines of core logic — not worth the supply-chain risk. Decision record: [LINK]
  - **Known limitations**: Does not handle atomicity on distributed filesystems like NFS/HDFS (consistent with Python behavior — POSIX rename atomicity only guaranteed on local filesystems).
  - **Deferred TODOs**: Support configurable indent width (currently hardcoded 2-space). Tracking: ISSUE-#456
