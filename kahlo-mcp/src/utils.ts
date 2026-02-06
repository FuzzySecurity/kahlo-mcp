/**
 * Shared utility functions used across the kahlo codebase.
 *
 * These are centralized here to avoid duplication and ensure consistent behavior.
 *
 * Note: Frida scripts (jobScriptRuntime.js, orchestratorAgent.js) cannot import
 * Node.js modules and must maintain their own implementations of these utilities.
 *
 * @module utils
 */

/**
 * Get current timestamp as an ISO-8601 string.
 *
 * @returns ISO-8601 formatted timestamp (e.g., "2026-01-25T12:34:56.789Z")
 */
export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Type guard to check if a value is a non-null object (Record).
 *
 * @param v - Value to check
 * @returns true if v is a non-null, non-array object
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Safely coerce a value to a Record, returning an empty object if not valid.
 *
 * @param v - Value to coerce
 * @returns The value as a Record, or an empty object if not a valid Record
 */
export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/**
 * Type guard to check if a value is a non-empty string.
 *
 * @param v - Value to check
 * @returns true if v is a string with length > 0 after trimming
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Extract YYYY-MM-DD from an ISO timestamp string.
 *
 * @param tsIso - ISO-8601 timestamp string
 * @returns Date portion (YYYY-MM-DD)
 */
export function yyyyMmDdUtc(tsIso: string): string {
  return tsIso.slice(0, 10);
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

/**
 * LOCK ORDERING POLICY:
 *
 * To prevent deadlocks, locks should be acquired in a consistent order:
 * 1. targetOpsLock (target-level operations)
 * 2. jobOpsLock (job-level operations)
 * 3. draftOpsLock (draft-level operations)
 * 4. moduleOpsLock (module-level operations)
 *
 * NEVER hold a lock while acquiring a lock from an earlier tier.
 * Prefer single locks over nested locks when possible.
 */

/**
 * A keyed lock for serializing async operations.
 *
 * Operations on the same key are serialized (run one at a time).
 * Operations on different keys run concurrently.
 *
 * This prevents race conditions when multiple async operations
 * could interfere with each other (e.g., concurrent job starts,
 * target attach/detach, etc.).
 *
 * Uses atomic promise chaining to guarantee FIFO ordering without race windows.
 * Each caller chains onto the current promise synchronously (before any await),
 * ensuring no two callers can enter the critical section simultaneously.
 *
 * @example
 * ```typescript
 * const lock = new KeyedLock();
 *
 * // These run serially (same key):
 * await lock.withLock("target_123", async () => { ... });
 * await lock.withLock("target_123", async () => { ... });
 *
 * // These can run concurrently (different keys):
 * await Promise.all([
 *   lock.withLock("target_123", async () => { ... }),
 *   lock.withLock("target_456", async () => { ... }),
 * ]);
 * ```
 */
export class KeyedLock {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Execute an async function while holding the lock for the given key.
   *
   * If another operation is in progress for the same key, this will wait
   * until that operation completes before starting. Operations are executed
   * in FIFO order.
   *
   * @param key - The key to lock on
   * @param fn - The async function to execute
   * @returns The result of the function
   * @throws Re-throws any error from the function after releasing the lock
   */
  public async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Capture predecessor BEFORE registering (synchronous - no race window)
    const predecessor = this.locks.get(key) ?? Promise.resolve();

    // Create our release signal
    let release!: () => void;
    const ourLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    // CRITICAL: Register synchronously before any await - this is what
    // prevents the race condition. Multiple callers arriving "simultaneously"
    // will each chain onto the previous caller's promise atomically.
    this.locks.set(key, ourLock);

    try {
      await predecessor; // Wait for predecessor to complete
      return await fn(); // Execute critical section
    } finally {
      release(); // Signal next waiter
      // Only cleanup if we're still the tail (no one chained after us)
      if (this.locks.get(key) === ourLock) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Check if a key currently has an operation in progress.
   *
   * @param key - The key to check
   * @returns true if an operation is in progress for this key
   */
  public isLocked(key: string): boolean {
    return this.locks.has(key);
  }
}
