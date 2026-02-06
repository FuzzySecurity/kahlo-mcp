/**
 * Type declarations for Kahlo Job Script Standard Library.
 *
 * These types define the shape of the stdlib object and its namespaces
 * for TypeScript consumers and IDE support.
 */

/**
 * Stack frame object returned by stack.capture().
 */
export interface StackFrame {
  className: string;
  methodName: string;
  fileName: string | null;
  lineNumber: number;
}

/**
 * Options for stack capture operations.
 */
export interface StackCaptureOptions {
  skip?: number;
  limit?: number;
  separator?: string;
}

/**
 * Field descriptor returned by inspect.fields().
 */
export interface FieldDescriptor {
  name: string;
  type: string;
  modifiers: string[];
  isStatic: boolean;
  isFinal: boolean;
}

/**
 * Method descriptor returned by inspect.methods().
 */
export interface MethodDescriptor {
  name: string;
  returnType: string;
  paramTypes: string[];
  modifiers: string[];
  isStatic: boolean;
}

/**
 * Options for field/method enumeration.
 */
export interface InspectOptions {
  includeInherited?: boolean;
  includeStatic?: boolean;
}

/**
 * Options for toJson conversion.
 */
export interface ToJsonOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

/**
 * Result object for safe operations.
 */
export interface SafeResult<T = any> {
  ok: boolean;
  result?: T;
  error?: string;
}

/**
 * Result object for field access.
 */
export interface FieldResult<T = any> {
  ok: boolean;
  value: T;
  error?: string;
}

/**
 * Result object for hook operations.
 */
export interface HookResult {
  ok: boolean;
  count?: number;
  error?: string;
}

/**
 * Parsed Intent information.
 */
export interface ParsedIntent {
  action: string | null;
  data: string | null;
  type: string | null;
  categories: string[];
  component: { package: string; class: string } | null;
  flags: number;
  extras: Record<string, any>;
}

/**
 * Options for Intent creation.
 */
export interface IntentOptions {
  data?: string;
  type?: string;
  extras?: Record<string, any>;
}

/**
 * Options for bytes.toHex().
 */
export interface ToHexOptions {
  uppercase?: boolean;
  separator?: string;
}

/**
 * Options for class enumeration.
 */
export interface ClassEnumerateOptions {
  limit?: number;
  filter?: (className: string) => boolean;
}

/**
 * Options for class instance enumeration.
 */
export interface ClassInstanceOptions {
  limit?: number;
}

/**
 * Hook callbacks for method hooking.
 */
export interface HookCallbacks {
  onEnter?: (this: any, args: any[]) => void;
  onLeave?: (this: any, retval: any) => void;
}

/**
 * Stopwatch object for timing measurements.
 */
export interface Stopwatch {
  elapsed(): number;
  elapsedFormatted(): string;
  reset(): void;
}

/**
 * Stack trace utilities namespace.
 */
export interface StackNamespace {
  capture(options?: StackCaptureOptions): StackFrame[];
  toString(options?: StackCaptureOptions): string;
  filter(frames: StackFrame[], pattern: string | RegExp): StackFrame[];
  findFirst(frames: StackFrame[], pattern: string | RegExp): StackFrame | null;
  getCaller(): StackFrame | null;
}

/**
 * Object inspection utilities namespace.
 */
export interface InspectNamespace {
  className(obj: any): string | null;
  simpleClassName(obj: any): string | null;
  fields(obj: any, options?: InspectOptions): FieldDescriptor[];
  methods(obj: any, options?: InspectOptions): MethodDescriptor[];
  getField(obj: any, fieldName: string): FieldResult;
  toJson(obj: any, options?: ToJsonOptions): any;
  isInstance(obj: any, className: string): boolean;
  superclassChain(obj: any): string[];
  interfaces(obj: any, includeInherited?: boolean): string[];
}

/**
 * Java class utilities namespace.
 */
export interface ClassesNamespace {
  find(pattern: string | RegExp, options?: { limit?: number }): string[];
  enumerate(options?: ClassEnumerateOptions): string[];
  load(className: string): any | null;
  isLoaded(className: string): boolean;
  instances(className: string, options?: ClassInstanceOptions): any[];
  getClassLoader(className: string): any | null;
}

/**
 * Binary data utilities namespace.
 */
export interface BytesNamespace {
  toHex(data: ArrayBuffer | Uint8Array | number[], options?: ToHexOptions): string;
  fromHex(hex: string): Uint8Array;
  toBase64(data: ArrayBuffer | Uint8Array | number[]): string;
  fromBase64(base64: string): Uint8Array;
  fromJavaBytes(javaByteArray: any): Uint8Array;
  toJavaBytes(data: Uint8Array | number[]): any;
  equals(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean;
  concat(...arrays: (ArrayBuffer | Uint8Array)[]): Uint8Array;
  slice(data: ArrayBuffer | Uint8Array, start: number, end?: number): Uint8Array;
}

/**
 * String utilities namespace.
 */
export interface StringsNamespace {
  fromJava(javaString: any): string | null;
  toJava(str: string): any;
  truncate(str: string, maxLength: number, ellipsis?: string): string;
  fromUtf8(data: ArrayBuffer | Uint8Array): string;
  toUtf8(str: string): Uint8Array;
  matches(str: string, pattern: string | RegExp): boolean;
  safeToString(obj: any, maxLength?: number): string;
}

/**
 * Android Intent utilities namespace.
 */
export interface IntentNamespace {
  parse(intentObj: any): ParsedIntent;
  getExtras(intentObj: any): Record<string, any>;
  getComponent(intentObj: any): { package: string; class: string } | null;
  isExplicit(intentObj: any): boolean;
  create(action: string, options?: IntentOptions): any;
  flagsToStrings(flags: number): string[];
}

/**
 * Hook utilities namespace.
 */
export interface HookNamespace {
  method(className: string, methodName: string, callbacks: HookCallbacks): HookResult;
  allOverloads(className: string, methodName: string, handler: (args: any[], original: any) => any): HookResult;
  constructor(className: string, handler: (args: any[]) => void): HookResult;
  native(address: NativePointer | string, callbacks: any): HookResult;
  onClassLoad(className: string, callback: (classWrapper: any) => void): HookResult;
  replace(classWrapper: any, methodName: string, replacement: any): () => void;
}

/**
 * Safe execution utilities namespace.
 */
export interface SafeNamespace {
  java<T>(fn: () => T): SafeResult<T>;
  call<T>(fn: () => T): SafeResult<T>;
  invoke(obj: any, methodName: string, ...args: any[]): any | null;
  get(obj: any, key: string, defaultValue?: any): any;
  timeout<T>(fn: () => T, timeoutMs: number): Promise<SafeResult<T>>;
}

/**
 * Result of measure() function.
 */
export interface MeasureResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Time utilities namespace.
 */
export interface TimeNamespace {
  now(): string;
  nowMs(): number;
  hrNow(): number;
  format(ms: number): string;
  stopwatch(): Stopwatch;
  sleep(ms: number): Promise<void>;
  measure<T>(fn: () => T): MeasureResult<T>;
  debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): T;
  throttle<T extends (...args: any[]) => void>(fn: T, intervalMs: number): T;
}

/**
 * Complete stdlib object returned by createStdlib().
 */
export interface Stdlib {
  stack: StackNamespace;
  inspect: InspectNamespace;
  classes: ClassesNamespace;
  bytes: BytesNamespace;
  strings: StringsNamespace;
  intent: IntentNamespace;
  hook: HookNamespace;
  safe: SafeNamespace;
  time: TimeNamespace;
  isJavaAvailable(): boolean;
  getJavaBridge(): any | null;
  requireJava(operation?: string): any;
}

/**
 * Create a stdlib instance with access to the Java bridge.
 *
 * @param javaBridge - The Java bridge object (from frida-java-bridge).
 * @returns Configured stdlib object with all namespaces.
 */
export function createStdlib(javaBridge: any): Stdlib;

/**
 * Stack trace utilities (standalone, not bound to Java bridge).
 */
export const stack: StackNamespace;

/**
 * Object inspection utilities (standalone).
 */
export const inspect: InspectNamespace;

/**
 * Java class utilities (standalone).
 */
export const classes: ClassesNamespace;

/**
 * Binary data utilities (standalone).
 */
export const bytes: BytesNamespace;

/**
 * String utilities (standalone).
 */
export const strings: StringsNamespace;

/**
 * Android Intent utilities (standalone).
 */
export const intent: IntentNamespace;

/**
 * Hook utilities (standalone).
 */
export const hook: HookNamespace;

/**
 * Safe execution utilities (standalone).
 */
export const safe: SafeNamespace;

/**
 * Time utilities (standalone).
 */
export const time: TimeNamespace;
