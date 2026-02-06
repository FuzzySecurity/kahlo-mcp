'use strict';

/**
 * Kahlo Job Script Standard Library (stdlib)
 *
 * Provides a collection of utility functions for common Frida/Android
 * instrumentation tasks. The stdlib is organized into namespaces:
 *
 * - stack   : Stack trace capture and formatting
 * - inspect : Object introspection and type discovery
 * - classes : Java class enumeration and loading utilities
 * - bytes   : Binary data manipulation (hex, base64, ArrayBuffer)
 * - strings : String manipulation and encoding helpers
 * - intent  : Android Intent parsing and construction
 * - hook    : Hook installation helpers and patterns
 * - safe    : Safe wrappers that handle exceptions gracefully
 * - time    : Timing utilities (timestamps, duration formatting)
 *
 * This file is bundled with frida-compile alongside the job runtime.
 * All code must be pure Frida JavaScript (no Node.js APIs).
 *
 * @module jobScriptStdlib
 */

// ============================================================================
// Stack Trace Utilities
// ============================================================================

/**
 * Creates the stack trace utilities namespace with access to the Java bridge.
 *
 * Provides functions to capture Java stack traces from the current thread,
 * format them for display, and extract relevant frames.
 *
 * @param {object} javaBridge - Reference to the Frida Java bridge.
 * @returns {object} Stack namespace object with all utility functions.
 * @private
 */
function createStackNamespace(javaBridge) {
  /**
   * Internal helper to match a class name against a pattern.
   *
   * @param {string} className - The class name to test.
   * @param {string|RegExp} pattern - String prefix or RegExp to match.
   * @returns {boolean} True if the class name matches the pattern.
   * @private
   */
  function matchesPattern(className, pattern) {
    if (!className) {
      return false;
    }
    if (pattern instanceof RegExp) {
      return pattern.test(className);
    }
    if (typeof pattern === 'string') {
      return className.indexOf(pattern) === 0;
    }
    return false;
  }

  /**
   * Internal list of class name prefixes to skip when finding the caller.
   * These represent internal Frida/stdlib frames that should be excluded.
   * @private
   */
  var INTERNAL_FRAME_PREFIXES = [
    'java.lang.Thread',
    'java.lang.VMThread',
    'dalvik.system.VMStack',
    'com.android.internal.os'
  ];

  /**
   * Stack trace capture and formatting utilities.
   * @namespace stack
   */
  var stack = {
    /**
     * Capture the current Java stack trace as an array of stack frame objects.
     *
     * Each frame object contains: className, methodName, fileName, lineNumber, isNative.
     *
     * @param {object} [options] - Options for stack capture.
     * @param {number} [options.skip=0] - Number of frames to skip from the top.
     * @param {number} [options.limit] - Maximum number of frames to return.
     * @returns {Array<object>} Array of stack frame objects.
     *
     * @example
     * var frames = ctx.stdlib.stack.capture({ skip: 1, limit: 10 });
     * frames.forEach(function(f) {
     *   ctx.emit('frame', { class: f.className, method: f.methodName });
     * });
     */
    capture: function (options) {
      var opts = options || {};
      var skip = typeof opts.skip === 'number' && opts.skip >= 0 ? opts.skip : 0;
      var limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : undefined;

      var frames = [];

      if (!javaBridge || !javaBridge.available) {
        return frames;
      }

      try {
        javaBridge.perform(function () {
          try {
            var Thread = javaBridge.use('java.lang.Thread');
            var currentThread = Thread.currentThread();
            var stackTrace = currentThread.getStackTrace();

            if (!stackTrace) {
              return;
            }

            var length = stackTrace.length;
            var startIndex = skip;
            var endIndex = limit !== undefined ? Math.min(startIndex + limit, length) : length;

            for (var i = startIndex; i < endIndex; i++) {
              try {
                var element = stackTrace[i];
                if (!element) {
                  continue;
                }

                var className = null;
                var methodName = null;
                var fileName = null;
                var lineNumber = -1;
                var isNative = false;

                try {
                  className = element.getClassName();
                  if (className) {
                    className = String(className);
                  }
                } catch (e) {
                  className = null;
                }

                try {
                  methodName = element.getMethodName();
                  if (methodName) {
                    methodName = String(methodName);
                  }
                } catch (e) {
                  methodName = null;
                }

                try {
                  fileName = element.getFileName();
                  if (fileName) {
                    fileName = String(fileName);
                  }
                } catch (e) {
                  fileName = null;
                }

                try {
                  lineNumber = element.getLineNumber();
                  if (typeof lineNumber !== 'number') {
                    lineNumber = -1;
                  }
                } catch (e) {
                  lineNumber = -1;
                }

                try {
                  isNative = !!element.isNativeMethod();
                } catch (e) {
                  isNative = false;
                }

                frames.push({
                  className: className,
                  methodName: methodName,
                  fileName: fileName,
                  lineNumber: lineNumber,
                  isNative: isNative
                });
              } catch (frameErr) {
                // Skip frames that fail to parse
              }
            }
          } catch (innerErr) {
            // Java.perform callback failed, return empty frames
          }
        });
      } catch (outerErr) {
        // Java.perform itself failed, return empty frames
      }

      return frames;
    },

    /**
     * Capture the current Java stack trace as a formatted string.
     *
     * @param {object} [options] - Options for stack capture.
     * @param {number} [options.skip=0] - Number of frames to skip from the top.
     * @param {number} [options.limit] - Maximum number of frames to include.
     * @param {string} [options.separator='\n'] - Separator between frames.
     * @returns {string} Formatted stack trace string.
     *
     * @example
     * var trace = ctx.stdlib.stack.toString({ limit: 5 });
     * ctx.emit('stack', { trace: trace });
     */
    toString: function (options) {
      var opts = options || {};
      var separator = typeof opts.separator === 'string' ? opts.separator : '\n';

      var frames = stack.capture({
        skip: opts.skip,
        limit: opts.limit
      });

      if (frames.length === 0) {
        return '';
      }

      var lines = [];
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        var className = frame.className || '<unknown class>';
        var methodName = frame.methodName || '<unknown method>';
        var fileName = frame.fileName || 'Unknown Source';
        var lineNumber = frame.lineNumber;

        var location;
        if (frame.isNative) {
          location = 'Native Method';
        } else if (lineNumber >= 0) {
          location = fileName + ':' + lineNumber;
        } else {
          location = fileName;
        }

        lines.push('at ' + className + '.' + methodName + '(' + location + ')');
      }

      return lines.join(separator);
    },

    /**
     * Filter stack frames by class name pattern.
     *
     * @param {Array<object>} frames - Array of frame objects from capture().
     * @param {string|RegExp} pattern - Pattern to match against className.
     * @returns {Array<object>} Filtered array of matching frames.
     *
     * @example
     * var frames = ctx.stdlib.stack.capture();
     * var appFrames = ctx.stdlib.stack.filter(frames, /^com\.example\.app/);
     */
    filter: function (frames, pattern) {
      if (!frames || !Array.isArray(frames)) {
        return [];
      }
      if (pattern === undefined || pattern === null) {
        return frames.slice();
      }

      var result = [];
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        if (frame && matchesPattern(frame.className, pattern)) {
          result.push(frame);
        }
      }
      return result;
    },

    /**
     * Find the first frame matching a class name pattern.
     *
     * @param {Array<object>} frames - Array of frame objects from capture().
     * @param {string|RegExp} pattern - Pattern to match against className.
     * @returns {object|null} First matching frame or null.
     *
     * @example
     * var frames = ctx.stdlib.stack.capture();
     * var firstAppFrame = ctx.stdlib.stack.findFirst(frames, 'com.example.app');
     */
    findFirst: function (frames, pattern) {
      if (!frames || !Array.isArray(frames)) {
        return null;
      }
      if (pattern === undefined || pattern === null) {
        return frames.length > 0 ? frames[0] : null;
      }

      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        if (frame && matchesPattern(frame.className, pattern)) {
          return frame;
        }
      }
      return null;
    },

    /**
     * Get the immediate caller frame (skipping stdlib/Frida internal frames).
     *
     * This function captures the stack trace and returns the first frame
     * that is not from internal Frida/Dalvik/stdlib infrastructure.
     *
     * @returns {object|null} Caller frame object or null if no valid caller found.
     *
     * @example
     * var caller = ctx.stdlib.stack.getCaller();
     * if (caller) {
     *   ctx.emit('caller', { class: caller.className, method: caller.methodName });
     * }
     */
    getCaller: function () {
      // Skip the first few frames which are typically:
      // 0: getStackTrace itself
      // 1: capture() internal
      // 2: getCaller() itself
      // Start with skip=3 to begin at actual user code
      var frames = stack.capture({ skip: 3 });

      if (!frames || frames.length === 0) {
        return null;
      }

      // Find the first frame that is not from internal infrastructure
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        if (!frame || !frame.className) {
          continue;
        }

        var isInternal = false;
        for (var j = 0; j < INTERNAL_FRAME_PREFIXES.length; j++) {
          if (frame.className.indexOf(INTERNAL_FRAME_PREFIXES[j]) === 0) {
            isInternal = true;
            break;
          }
        }

        if (!isInternal) {
          return frame;
        }
      }

      // If all frames are internal, return the first one as fallback
      return frames[0] || null;
    },

    /**
     * Convert a Java Throwable to a full stack trace string including the cause chain.
     *
     * This function formats a Java Throwable (exception) into a human-readable
     * stack trace string, similar to what Java's printStackTrace() produces.
     * It includes the full cause chain by traversing getCause() recursively.
     *
     * @param {object} throwable - A Java Throwable object (Java.Wrapper from Frida).
     * @returns {string} Formatted stack trace string with cause chain, or empty string on error.
     *
     * @example
     * // In a hook that catches an exception:
     * try {
     *   // ... code that might throw
     * } catch (e) {
     *   var trace = ctx.stdlib.stack.getException(e);
     *   ctx.emit('exception', { stackTrace: trace });
     * }
     *
     * @example
     * // Output format:
     * // java.lang.RuntimeException: Main error
     * //     at com.example.MyClass.method(MyClass.java:42)
     * //     at ...
     * // Caused by: java.lang.IllegalArgumentException: Root cause
     * //     at com.example.Other.fail(Other.java:10)
     * //     at ...
     */
    getException: function (throwable) {
      if (!throwable) {
        return '';
      }

      // If Java is not available, try to return basic toString
      if (!javaBridge || !javaBridge.available) {
        try {
          return String(throwable);
        } catch (e) {
          return '';
        }
      }

      var result = '';

      try {
        javaBridge.perform(function () {
          try {
            // Use StringWriter + PrintWriter to capture printStackTrace output
            // This is the most reliable way to get the full formatted trace
            var StringWriter = javaBridge.use('java.io.StringWriter');
            var PrintWriter = javaBridge.use('java.io.PrintWriter');

            var sw = StringWriter.$new();
            var pw = PrintWriter.$new(sw);

            // printStackTrace writes the full trace including cause chain
            throwable.printStackTrace(pw);
            pw.flush();

            result = String(sw.toString());

            // Clean up
            try {
              pw.close();
            } catch (closeErr) {
              // Ignore close errors
            }
            try {
              sw.close();
            } catch (closeErr) {
              // Ignore close errors
            }
          } catch (printStackErr) {
            // Fallback: manually build the stack trace if printStackTrace fails
            try {
              result = buildExceptionString(throwable);
            } catch (fallbackErr) {
              // Last resort: just toString the throwable
              try {
                result = String(throwable.toString());
              } catch (toStringErr) {
                result = '';
              }
            }
          }
        });
      } catch (outerErr) {
        // Java.perform failed, return empty string
        result = '';
      }

      return result;

      /**
       * Internal helper to manually build exception string with cause chain.
       * Used as fallback when printStackTrace is not available.
       *
       * @param {object} t - The throwable to format.
       * @returns {string} Formatted exception string.
       * @private
       */
      function buildExceptionString(t) {
        var lines = [];
        var current = t;
        var isFirst = true;
        var visited = []; // Prevent infinite loops from circular cause chains

        while (current !== null) {
          // Check for circular reference
          for (var v = 0; v < visited.length; v++) {
            try {
              if (current === visited[v] || current.equals(visited[v])) {
                lines.push('[CIRCULAR REFERENCE DETECTED]');
                current = null;
                break;
              }
            } catch (eqErr) {
              // Ignore equality check errors
            }
          }

          if (current === null) {
            break;
          }

          visited.push(current);

          // Get exception class name and message
          var exceptionHeader = '';
          try {
            var className = String(current.getClass().getName());
            var message = null;
            try {
              var msg = current.getMessage();
              if (msg !== null) {
                message = String(msg);
              }
            } catch (msgErr) {
              message = null;
            }

            if (isFirst) {
              exceptionHeader = className;
            } else {
              exceptionHeader = 'Caused by: ' + className;
            }

            if (message !== null && message.length > 0) {
              exceptionHeader += ': ' + message;
            }
          } catch (headerErr) {
            exceptionHeader = isFirst ? '<unknown exception>' : 'Caused by: <unknown exception>';
          }

          lines.push(exceptionHeader);

          // Get stack trace elements
          try {
            var stackTrace = current.getStackTrace();
            if (stackTrace !== null) {
              var stackLength = stackTrace.length;
              for (var i = 0; i < stackLength; i++) {
                try {
                  var element = stackTrace[i];
                  if (element === null) {
                    continue;
                  }

                  var elemClassName = '';
                  var elemMethodName = '';
                  var elemFileName = 'Unknown Source';
                  var elemLineNumber = -1;
                  var elemIsNative = false;

                  try {
                    elemClassName = String(element.getClassName());
                  } catch (e) {
                    elemClassName = '<unknown class>';
                  }

                  try {
                    elemMethodName = String(element.getMethodName());
                  } catch (e) {
                    elemMethodName = '<unknown method>';
                  }

                  try {
                    var fn = element.getFileName();
                    if (fn !== null) {
                      elemFileName = String(fn);
                    }
                  } catch (e) {
                    // Keep default
                  }

                  try {
                    elemLineNumber = element.getLineNumber();
                  } catch (e) {
                    elemLineNumber = -1;
                  }

                  try {
                    elemIsNative = !!element.isNativeMethod();
                  } catch (e) {
                    elemIsNative = false;
                  }

                  var location;
                  if (elemIsNative) {
                    location = 'Native Method';
                  } else if (elemLineNumber >= 0) {
                    location = elemFileName + ':' + elemLineNumber;
                  } else {
                    location = elemFileName;
                  }

                  lines.push('\tat ' + elemClassName + '.' + elemMethodName + '(' + location + ')');
                } catch (elemErr) {
                  lines.push('\tat <error reading frame>');
                }
              }
            }
          } catch (stackErr) {
            lines.push('\t<error reading stack trace>');
          }

          // Move to the cause
          isFirst = false;
          try {
            var cause = current.getCause();
            // Check if cause is the same as current (some exceptions do this)
            if (cause !== null) {
              try {
                if (cause === current || cause.equals(current)) {
                  current = null;
                } else {
                  current = cause;
                }
              } catch (eqErr) {
                current = cause;
              }
            } else {
              current = null;
            }
          } catch (causeErr) {
            current = null;
          }
        }

        return lines.join('\n');
      }
    }
  };

  return stack;
}

/**
 * Default stack namespace instance (without Java bridge).
 * This is replaced by createStdlib with a properly initialized version.
 * @namespace stack
 */
var stack = createStackNamespace(null);

// ============================================================================
// Object Inspection Utilities
// ============================================================================

/**
 * Creates the inspect namespace with access to the Java bridge.
 *
 * Provides functions to inspect Java objects, enumerate their fields
 * and methods, and safely extract values for logging.
 *
 * @param {object} javaBridge - Reference to the Frida Java bridge.
 * @returns {object} Inspect namespace object with all utility functions.
 * @private
 */
function createInspectNamespace(javaBridge) {
  /**
   * Internal helper to check if Java bridge is available.
   *
   * @returns {boolean} True if Java bridge is available and ready.
   * @private
   */
  function isJavaAvailable() {
    return !!(javaBridge && javaBridge.available);
  }

  /**
   * Internal cache for the Modifier class to avoid repeated lookups.
   * @private
   */
  var ModifierClass = null;

  /**
   * Internal helper to get the java.lang.reflect.Modifier class.
   * Uses lazy initialization to avoid loading until needed.
   *
   * @returns {object|null} The Modifier class or null if unavailable.
   * @private
   */
  function getModifierClass() {
    if (ModifierClass !== null) {
      return ModifierClass;
    }
    if (!isJavaAvailable()) {
      return null;
    }
    try {
      ModifierClass = javaBridge.use('java.lang.reflect.Modifier');
      return ModifierClass;
    } catch (e) {
      ModifierClass = null;
      return null;
    }
  }

  /**
   * Internal helper to parse integer modifiers into a human-readable object.
   *
   * @param {number} mods - The integer modifier flags from getModifiers().
   * @returns {object} Object with boolean flags for each modifier type.
   * @private
   */
  function parseModifiers(mods) {
    var result = {
      isPublic: false,
      isPrivate: false,
      isProtected: false,
      isStatic: false,
      isFinal: false,
      isSynchronized: false,
      isVolatile: false,
      isTransient: false,
      isNative: false,
      isAbstract: false
    };

    var Modifier = getModifierClass();
    if (!Modifier) {
      return result;
    }

    try {
      result.isPublic = !!Modifier.isPublic(mods);
      result.isPrivate = !!Modifier.isPrivate(mods);
      result.isProtected = !!Modifier.isProtected(mods);
      result.isStatic = !!Modifier.isStatic(mods);
      result.isFinal = !!Modifier.isFinal(mods);
      result.isSynchronized = !!Modifier.isSynchronized(mods);
      result.isVolatile = !!Modifier.isVolatile(mods);
      result.isTransient = !!Modifier.isTransient(mods);
      result.isNative = !!Modifier.isNative(mods);
      result.isAbstract = !!Modifier.isAbstract(mods);
    } catch (e) {
      // If any modifier check fails, return partial results
    }

    return result;
  }

  /**
   * Internal helper to safely get a class name from a Class object.
   *
   * @param {object} clazz - A Java Class object.
   * @returns {string|null} The class name or null on failure.
   * @private
   */
  function safeGetClassName(clazz) {
    if (!clazz) {
      return null;
    }
    try {
      var name = clazz.getName();
      return name ? String(name) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Object introspection and type discovery utilities.
   * @namespace inspect
   */
  var inspectNamespace = {
    /**
     * Get the Java class name of an object.
     *
     * @param {object} obj - Java object to inspect.
     * @returns {string|null} Fully qualified class name or null.
     *
     * @example
     * var className = ctx.stdlib.inspect.className(myObject);
     * ctx.emit('type', { class: className });
     */
    className: function (obj) {
      if (obj === null || obj === undefined) {
        return null;
      }
      if (!isJavaAvailable()) {
        return null;
      }

      var result = null;
      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            if (clazz) {
              var name = clazz.getName();
              if (name) {
                result = String(name);
              }
            }
          } catch (innerErr) {
            result = null;
          }
        });
      } catch (outerErr) {
        result = null;
      }
      return result;
    },

    /**
     * Get the simple (unqualified) class name of an object.
     *
     * @param {object} obj - Java object to inspect.
     * @returns {string|null} Simple class name or null.
     */
    simpleClassName: function (obj) {
      if (obj === null || obj === undefined) {
        return null;
      }
      if (!isJavaAvailable()) {
        return null;
      }

      var result = null;
      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            if (clazz) {
              var name = clazz.getSimpleName();
              if (name) {
                result = String(name);
              }
            }
          } catch (innerErr) {
            result = null;
          }
        });
      } catch (outerErr) {
        result = null;
      }
      return result;
    },

    /**
     * Enumerate all declared fields of an object's class.
     *
     * @param {object} obj - Java object to inspect.
     * @param {object} [options] - Options for field enumeration.
     * @param {boolean} [options.includeInherited=false] - Include superclass fields.
     * @param {boolean} [options.includeStatic=false] - Include static fields.
     * @returns {Array<object>} Array of field descriptors with name, type, modifiers.
     *
     * @example
     * var fields = ctx.stdlib.inspect.fields(myObject, { includeInherited: true });
     * fields.forEach(function(f) {
     *   ctx.emit('field', { name: f.name, type: f.type });
     * });
     */
    fields: function (obj, options) {
      if (obj === null || obj === undefined) {
        return [];
      }
      if (!isJavaAvailable()) {
        return [];
      }

      var opts = options || {};
      var includeInherited = !!opts.includeInherited;
      var includeStatic = !!opts.includeStatic;
      var result = [];

      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            var visitedNames = {};

            while (clazz !== null) {
              try {
                var declaredFields = clazz.getDeclaredFields();
                if (declaredFields) {
                  var length = declaredFields.length;
                  for (var i = 0; i < length; i++) {
                    try {
                      var field = declaredFields[i];
                      if (!field) {
                        continue;
                      }

                      var fieldName = null;
                      try {
                        fieldName = field.getName();
                        if (fieldName) {
                          fieldName = String(fieldName);
                        }
                      } catch (e) {
                        continue;
                      }

                      // Skip duplicate field names from parent classes
                      if (visitedNames[fieldName]) {
                        continue;
                      }
                      visitedNames[fieldName] = true;

                      var modifiers = 0;
                      try {
                        modifiers = field.getModifiers();
                      } catch (e) {
                        modifiers = 0;
                      }

                      var parsedMods = parseModifiers(modifiers);

                      // Filter out static fields if not requested
                      if (parsedMods.isStatic && !includeStatic) {
                        continue;
                      }

                      var fieldType = null;
                      try {
                        var typeClass = field.getType();
                        if (typeClass) {
                          fieldType = safeGetClassName(typeClass);
                        }
                      } catch (e) {
                        fieldType = null;
                      }

                      var declaringClassName = null;
                      try {
                        var declaringClass = field.getDeclaringClass();
                        if (declaringClass) {
                          declaringClassName = safeGetClassName(declaringClass);
                        }
                      } catch (e) {
                        declaringClassName = null;
                      }

                      result.push({
                        name: fieldName,
                        type: fieldType,
                        declaringClass: declaringClassName,
                        modifiers: parsedMods
                      });
                    } catch (fieldErr) {
                      // Skip fields that fail to process
                    }
                  }
                }
              } catch (declaredErr) {
                // getDeclaredFields failed, continue to superclass
              }

              // Move to superclass if requested
              if (!includeInherited) {
                break;
              }
              try {
                clazz = clazz.getSuperclass();
              } catch (e) {
                clazz = null;
              }
            }
          } catch (innerErr) {
            // Java.perform callback failed
          }
        });
      } catch (outerErr) {
        // Java.perform itself failed
      }

      return result;
    },

    /**
     * Enumerate all declared methods of an object's class.
     *
     * @param {object} obj - Java object to inspect.
     * @param {object} [options] - Options for method enumeration.
     * @param {boolean} [options.includeInherited=false] - Include superclass methods.
     * @param {boolean} [options.includeStatic=false] - Include static methods.
     * @returns {Array<object>} Array of method descriptors with name, returnType, paramTypes.
     */
    methods: function (obj, options) {
      if (obj === null || obj === undefined) {
        return [];
      }
      if (!isJavaAvailable()) {
        return [];
      }

      var opts = options || {};
      var includeInherited = !!opts.includeInherited;
      var includeStatic = !!opts.includeStatic;
      var result = [];

      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            var visitedSignatures = {};

            while (clazz !== null) {
              try {
                var declaredMethods = clazz.getDeclaredMethods();
                if (declaredMethods) {
                  var length = declaredMethods.length;
                  for (var i = 0; i < length; i++) {
                    try {
                      var method = declaredMethods[i];
                      if (!method) {
                        continue;
                      }

                      var methodName = null;
                      try {
                        methodName = method.getName();
                        if (methodName) {
                          methodName = String(methodName);
                        }
                      } catch (e) {
                        continue;
                      }

                      // Build parameter type signature for uniqueness check
                      var paramTypes = [];
                      try {
                        var parameterTypes = method.getParameterTypes();
                        if (parameterTypes) {
                          for (var p = 0; p < parameterTypes.length; p++) {
                            var paramType = safeGetClassName(parameterTypes[p]);
                            paramTypes.push(paramType || 'unknown');
                          }
                        }
                      } catch (e) {
                        paramTypes = [];
                      }

                      var signature = methodName + '(' + paramTypes.join(',') + ')';

                      // Skip duplicate method signatures from parent classes
                      if (visitedSignatures[signature]) {
                        continue;
                      }
                      visitedSignatures[signature] = true;

                      var modifiers = 0;
                      try {
                        modifiers = method.getModifiers();
                      } catch (e) {
                        modifiers = 0;
                      }

                      var parsedMods = parseModifiers(modifiers);

                      // Filter out static methods if not requested
                      if (parsedMods.isStatic && !includeStatic) {
                        continue;
                      }

                      var returnType = null;
                      try {
                        var returnTypeClass = method.getReturnType();
                        if (returnTypeClass) {
                          returnType = safeGetClassName(returnTypeClass);
                        }
                      } catch (e) {
                        returnType = null;
                      }

                      var declaringClassName = null;
                      try {
                        var declaringClass = method.getDeclaringClass();
                        if (declaringClass) {
                          declaringClassName = safeGetClassName(declaringClass);
                        }
                      } catch (e) {
                        declaringClassName = null;
                      }

                      result.push({
                        name: methodName,
                        returnType: returnType,
                        paramTypes: paramTypes,
                        declaringClass: declaringClassName,
                        modifiers: parsedMods
                      });
                    } catch (methodErr) {
                      // Skip methods that fail to process
                    }
                  }
                }
              } catch (declaredErr) {
                // getDeclaredMethods failed, continue to superclass
              }

              // Move to superclass if requested
              if (!includeInherited) {
                break;
              }
              try {
                clazz = clazz.getSuperclass();
              } catch (e) {
                clazz = null;
              }
            }
          } catch (innerErr) {
            // Java.perform callback failed
          }
        });
      } catch (outerErr) {
        // Java.perform itself failed
      }

      return result;
    },

    /**
     * Get the value of a field by name, with safe error handling.
     *
     * @param {object} obj - Java object to inspect.
     * @param {string} fieldName - Name of the field to read.
     * @returns {{ ok: boolean, value: any, error?: string }} Result object.
     *
     * @example
     * var result = ctx.stdlib.inspect.getField(myObject, 'secretKey');
     * if (result.ok) {
     *   ctx.emit('field.value', { name: 'secretKey', value: result.value });
     * }
     */
    getField: function (obj, fieldName) {
      if (obj === null || obj === undefined) {
        return { ok: false, value: null, error: 'Object is null or undefined' };
      }
      if (!fieldName || typeof fieldName !== 'string') {
        return { ok: false, value: null, error: 'Field name must be a non-empty string' };
      }
      if (!isJavaAvailable()) {
        return { ok: false, value: null, error: 'Java bridge not available' };
      }

      var result = { ok: false, value: null, error: null };

      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            var field = null;

            // Search through the class hierarchy for the field
            while (clazz !== null && field === null) {
              try {
                field = clazz.getDeclaredField(fieldName);
              } catch (e) {
                // Field not found in this class, try superclass
                try {
                  clazz = clazz.getSuperclass();
                } catch (superErr) {
                  clazz = null;
                }
              }
            }

            if (!field) {
              result.error = 'Field not found: ' + fieldName;
              return;
            }

            // Make the field accessible (handles private fields)
            try {
              field.setAccessible(true);
            } catch (e) {
              // setAccessible may fail on some Android versions, try anyway
            }

            // Get the field value
            var value = field.get(obj);
            result.ok = true;
            result.value = value;
          } catch (innerErr) {
            result.error = 'Failed to get field: ' + String(innerErr);
          }
        });
      } catch (outerErr) {
        result.error = 'Java.perform failed: ' + String(outerErr);
      }

      return result;
    },

    /**
     * Convert a Java object to a JSON-safe representation for logging.
     *
     * Handles common types (String, primitives, arrays, collections) and
     * falls back to toString() for complex objects.
     *
     * @param {object} obj - Java object to convert.
     * @param {object} [options] - Conversion options.
     * @param {number} [options.maxDepth=2] - Maximum recursion depth for nested objects.
     * @param {number} [options.maxArrayLength=100] - Maximum array elements to include.
     * @param {number} [options.maxStringLength=1000] - Maximum string length.
     * @returns {any} JSON-safe representation.
     *
     * @example
     * var safe = ctx.stdlib.inspect.toJson(myObject, { maxDepth: 3 });
     * ctx.emit('object', { data: safe });
     */
    toJson: function (obj, options) {
      var opts = options || {};
      var maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 2;
      var maxArrayLength = typeof opts.maxArrayLength === 'number' ? opts.maxArrayLength : 100;
      var maxStringLength = typeof opts.maxStringLength === 'number' ? opts.maxStringLength : 1000;

      /**
       * Internal recursive conversion function.
       *
       * @param {any} value - Value to convert.
       * @param {number} depth - Current recursion depth.
       * @param {Array} visited - Array of visited objects for cycle detection.
       * @returns {any} JSON-safe value.
       * @private
       */
      function convertValue(value, depth, visited) {
        // Handle null/undefined
        if (value === null) {
          return null;
        }
        if (value === undefined) {
          return undefined;
        }

        // Handle JavaScript primitives
        var valueType = typeof value;
        if (valueType === 'boolean' || valueType === 'number') {
          return value;
        }
        if (valueType === 'string') {
          if (value.length > maxStringLength) {
            return value.substring(0, maxStringLength) + '...[truncated]';
          }
          return value;
        }

        // Check depth limit
        if (depth > maxDepth) {
          return '[max depth exceeded]';
        }

        // Check for cycles
        for (var v = 0; v < visited.length; v++) {
          if (visited[v] === value) {
            return '[circular reference]';
          }
        }
        visited.push(value);

        // Handle JavaScript arrays
        if (Array.isArray(value)) {
          var jsArr = [];
          var arrLen = Math.min(value.length, maxArrayLength);
          for (var a = 0; a < arrLen; a++) {
            jsArr.push(convertValue(value[a], depth + 1, visited));
          }
          if (value.length > maxArrayLength) {
            jsArr.push('[' + (value.length - maxArrayLength) + ' more elements]');
          }
          return jsArr;
        }

        // Handle plain JavaScript objects (non-Java)
        if (valueType === 'object' && !isJavaAvailable()) {
          try {
            var plainObj = {};
            var keys = Object.keys(value);
            for (var k = 0; k < keys.length; k++) {
              var key = keys[k];
              plainObj[key] = convertValue(value[key], depth + 1, visited);
            }
            return plainObj;
          } catch (e) {
            return String(value);
          }
        }

        // At this point we likely have a Java object
        if (!isJavaAvailable()) {
          return String(value);
        }

        var result = null;
        try {
          javaBridge.perform(function () {
            try {
              // Check if it's a Java String
              try {
                var StringClass = javaBridge.use('java.lang.String');
                if (StringClass.class.isInstance(value)) {
                  var strVal = String(value);
                  if (strVal.length > maxStringLength) {
                    result = strVal.substring(0, maxStringLength) + '...[truncated]';
                  } else {
                    result = strVal;
                  }
                  return;
                }
              } catch (e) {
                // Not a String, continue
              }

              // Check for boxed primitives
              var boxedTypes = [
                'java.lang.Boolean',
                'java.lang.Byte',
                'java.lang.Short',
                'java.lang.Integer',
                'java.lang.Long',
                'java.lang.Float',
                'java.lang.Double',
                'java.lang.Character'
              ];

              for (var b = 0; b < boxedTypes.length; b++) {
                try {
                  var BoxedClass = javaBridge.use(boxedTypes[b]);
                  if (BoxedClass.class.isInstance(value)) {
                    // Use primitive value extraction
                    var clazz = value.getClass();
                    var clazzName = String(clazz.getName());
                    if (clazzName === 'java.lang.Boolean') {
                      result = !!value.booleanValue();
                    } else if (clazzName === 'java.lang.Character') {
                      result = String(value.charValue());
                    } else {
                      // Numeric types
                      result = Number(value);
                    }
                    return;
                  }
                } catch (e) {
                  // Not this boxed type, continue
                }
              }

              // Check for Java arrays
              var clazz = value.getClass();
              if (clazz && clazz.isArray()) {
                var javaArrResult = [];
                try {
                  var ArrayClass = javaBridge.use('java.lang.reflect.Array');
                  var arrLength = ArrayClass.getLength(value);
                  var maxLen = Math.min(arrLength, maxArrayLength);
                  for (var i = 0; i < maxLen; i++) {
                    var elem = ArrayClass.get(value, i);
                    javaArrResult.push(convertValue(elem, depth + 1, visited));
                  }
                  if (arrLength > maxArrayLength) {
                    javaArrResult.push('[' + (arrLength - maxArrayLength) + ' more elements]');
                  }
                } catch (e) {
                  javaArrResult = ['[array access error]'];
                }
                result = javaArrResult;
                return;
              }

              // Check for List
              try {
                var ListClass = javaBridge.use('java.util.List');
                if (ListClass.class.isInstance(value)) {
                  var listResult = [];
                  var listSize = value.size();
                  var maxListLen = Math.min(listSize, maxArrayLength);
                  for (var li = 0; li < maxListLen; li++) {
                    listResult.push(convertValue(value.get(li), depth + 1, visited));
                  }
                  if (listSize > maxArrayLength) {
                    listResult.push('[' + (listSize - maxArrayLength) + ' more elements]');
                  }
                  result = listResult;
                  return;
                }
              } catch (e) {
                // Not a List, continue
              }

              // Check for Set
              try {
                var SetClass = javaBridge.use('java.util.Set');
                if (SetClass.class.isInstance(value)) {
                  var setResult = [];
                  var iterator = value.iterator();
                  var setCount = 0;
                  while (iterator.hasNext() && setCount < maxArrayLength) {
                    setResult.push(convertValue(iterator.next(), depth + 1, visited));
                    setCount++;
                  }
                  if (iterator.hasNext()) {
                    setResult.push('[more elements]');
                  }
                  result = setResult;
                  return;
                }
              } catch (e) {
                // Not a Set, continue
              }

              // Check for Map
              try {
                var MapClass = javaBridge.use('java.util.Map');
                if (MapClass.class.isInstance(value)) {
                  var mapResult = {};
                  var entrySet = value.entrySet();
                  var mapIterator = entrySet.iterator();
                  var mapCount = 0;
                  while (mapIterator.hasNext() && mapCount < maxArrayLength) {
                    var entry = mapIterator.next();
                    var entryKey = entry.getKey();
                    var entryValue = entry.getValue();
                    var keyStr = String(entryKey);
                    mapResult[keyStr] = convertValue(entryValue, depth + 1, visited);
                    mapCount++;
                  }
                  if (mapIterator.hasNext()) {
                    mapResult['[more entries]'] = true;
                  }
                  result = mapResult;
                  return;
                }
              } catch (e) {
                // Not a Map, continue
              }

              // Fallback: use toString()
              try {
                var strRepr = String(value.toString());
                if (strRepr.length > maxStringLength) {
                  strRepr = strRepr.substring(0, maxStringLength) + '...[truncated]';
                }
                result = strRepr;
              } catch (e) {
                result = '[toString() failed]';
              }
            } catch (innerErr) {
              result = '[conversion error: ' + String(innerErr) + ']';
            }
          });
        } catch (outerErr) {
          result = '[Java.perform failed]';
        }

        return result;
      }

      return convertValue(obj, 0, []);
    },

    /**
     * Check if an object is an instance of a given class name.
     *
     * @param {object} obj - Java object to check.
     * @param {string} className - Fully qualified class name.
     * @returns {boolean} True if obj is an instance of the class.
     */
    isInstance: function (obj, className) {
      if (obj === null || obj === undefined) {
        return false;
      }
      if (!className || typeof className !== 'string') {
        return false;
      }
      if (!isJavaAvailable()) {
        return false;
      }

      var result = false;
      try {
        javaBridge.perform(function () {
          try {
            var TargetClass = javaBridge.use(className);
            if (TargetClass && TargetClass.class) {
              result = !!TargetClass.class.isInstance(obj);
            }
          } catch (innerErr) {
            result = false;
          }
        });
      } catch (outerErr) {
        result = false;
      }

      return result;
    },

    /**
     * Get the superclass chain of an object.
     *
     * @param {object} obj - Java object to inspect.
     * @returns {Array<string>} Array of class names from immediate superclass to Object.
     */
    superclassChain: function (obj) {
      if (obj === null || obj === undefined) {
        return [];
      }
      if (!isJavaAvailable()) {
        return [];
      }

      var result = [];
      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();
            if (!clazz) {
              return;
            }

            // Get the superclass (skip the object's own class)
            try {
              clazz = clazz.getSuperclass();
            } catch (e) {
              return;
            }

            while (clazz !== null) {
              var name = safeGetClassName(clazz);
              if (name) {
                result.push(name);
              }
              try {
                clazz = clazz.getSuperclass();
              } catch (e) {
                clazz = null;
              }
            }
          } catch (innerErr) {
            // Java.perform callback failed
          }
        });
      } catch (outerErr) {
        // Java.perform itself failed
      }

      return result;
    },

    /**
     * Get all interfaces implemented by an object's class.
     *
     * @param {object} obj - Java object to inspect.
     * @param {boolean} [includeInherited=true] - Include interfaces from superclasses.
     * @returns {Array<string>} Array of interface class names.
     */
    interfaces: function (obj, includeInherited) {
      if (obj === null || obj === undefined) {
        return [];
      }
      if (!isJavaAvailable()) {
        return [];
      }

      // Default to true if not specified
      var includeFromSuperclasses = includeInherited !== false;
      var result = [];
      var visitedInterfaces = {};

      try {
        javaBridge.perform(function () {
          try {
            var clazz = obj.getClass();

            while (clazz !== null) {
              try {
                var ifaces = clazz.getInterfaces();
                if (ifaces) {
                  for (var i = 0; i < ifaces.length; i++) {
                    var iface = ifaces[i];
                    if (iface) {
                      var ifaceName = safeGetClassName(iface);
                      if (ifaceName && !visitedInterfaces[ifaceName]) {
                        visitedInterfaces[ifaceName] = true;
                        result.push(ifaceName);
                      }
                    }
                  }
                }
              } catch (e) {
                // getInterfaces failed for this class
              }

              // Move to superclass if requested
              if (!includeFromSuperclasses) {
                break;
              }
              try {
                clazz = clazz.getSuperclass();
              } catch (e) {
                clazz = null;
              }
            }
          } catch (innerErr) {
            // Java.perform callback failed
          }
        });
      } catch (outerErr) {
        // Java.perform itself failed
      }

      return result;
    }
  };

  return inspectNamespace;
}

/**
 * Default inspect namespace instance (without Java bridge).
 * This is replaced by createStdlib with a properly initialized version.
 * @namespace inspect
 */
var inspect = createInspectNamespace(null);

// ============================================================================
// Java Class Utilities
// ============================================================================

/**
 * Creates the classes namespace with access to the Java bridge.
 *
 * Provides functions to enumerate loaded classes, find classes by pattern,
 * safely load classes, find live instances, and access class loaders.
 *
 * @param {object} javaBridge - Reference to the Frida Java bridge.
 * @returns {object} Classes namespace object with all utility functions.
 * @private
 */
function createClassesNamespace(javaBridge) {
  /**
   * Internal helper to check if Java bridge is available.
   *
   * @returns {boolean} True if Java bridge is available and ready.
   * @private
   */
  function isJavaAvailable() {
    return !!(javaBridge && javaBridge.available);
  }

  /**
   * Internal helper to test if a class name matches a pattern.
   *
   * Supports both string prefix matching and regular expressions.
   *
   * @param {string} className - The class name to test.
   * @param {string|RegExp} pattern - String prefix or RegExp to match.
   * @returns {boolean} True if the class name matches the pattern.
   * @private
   */
  function matchesPattern(className, pattern) {
    if (!className) {
      return false;
    }
    if (pattern instanceof RegExp) {
      return pattern.test(className);
    }
    if (typeof pattern === 'string') {
      return className.indexOf(pattern) === 0;
    }
    return false;
  }

  /**
   * Java class enumeration and loading utilities.
   * @namespace classes
   */
  var classesNamespace = {
    /**
     * Find loaded classes matching a pattern.
     *
     * Uses Java.enumerateLoadedClassesSync() to search all classes currently
     * loaded in the VM. Supports string prefix matching (e.g., "javax.crypto")
     * or regular expressions (e.g., /javax\.crypto\.Cipher/).
     *
     * Note: This operation enumerates all loaded classes which can be slow
     * on large applications. Always use the limit option to cap results.
     *
     * @param {string|RegExp} pattern - Pattern to match against class names.
     *   String patterns match as prefixes (class name starts with pattern).
     *   RegExp patterns use test() for flexible matching.
     * @param {object} [options] - Search options.
     * @param {number} [options.limit=100] - Maximum number of results to return.
     * @returns {Array<string>} Array of matching fully-qualified class names.
     *
     * @example
     * // Find crypto classes using regex
     * var cryptoClasses = ctx.stdlib.classes.find(/javax\.crypto\./, { limit: 50 });
     * cryptoClasses.forEach(function(name) {
     *   ctx.emit('class.found', { name: name });
     * });
     *
     * @example
     * // Find app-specific classes using prefix
     * var appClasses = ctx.stdlib.classes.find('com.example.myapp', { limit: 200 });
     */
    find: function (pattern, options) {
      if (!isJavaAvailable()) {
        return [];
      }

      var opts = options || {};
      var limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 100;
      var results = [];

      try {
        var allClasses = javaBridge.enumerateLoadedClassesSync();

        for (var i = 0; i < allClasses.length && results.length < limit; i++) {
          var className = allClasses[i];
          if (matchesPattern(className, pattern)) {
            results.push(className);
          }
        }
      } catch (e) {
        // Enumeration failed, return empty array
        return [];
      }

      return results;
    },

    /**
     * Enumerate all loaded classes in the VM.
     *
     * Supports two calling conventions:
     *
     * **Callback style (streaming, memory-efficient):**
     * Pass a callback function as the first argument to receive class names
     * one at a time. This avoids building a large array in memory and is
     * preferred for processing large classpaths.
     *
     * **Options style (array return):**
     * Pass an options object to receive results as an array. This can be
     * memory-intensive on applications with large classpaths. Use the limit
     * option to constrain results, or use find() with a pattern for targeted
     * searches.
     *
     * @param {function|object} [callbackOrOptions] - Either a callback function
     *   for streaming enumeration, or an options object for array-based results.
     *
     *   When a function: Called for each loaded class with signature
     *   `function(className: string) => void`. Exceptions thrown by the callback
     *   are silently caught and enumeration continues.
     *
     *   When an object:
     * @param {number} [callbackOrOptions.limit] - Maximum number of classes to return.
     *   If not specified, returns all loaded classes (use with caution).
     * @param {function} [callbackOrOptions.filter] - Filter function called for each class.
     *   Signature: function(className: string) => boolean.
     *   Return true to include the class in results, false to exclude.
     *   Filter exceptions are silently caught and the class is excluded.
     *
     * @returns {Array<string>|undefined} When called with options object, returns
     *   array of fully-qualified class names. When called with callback, returns
     *   undefined (results are streamed to callback).
     *
     * @example
     * // Callback style (streaming, memory efficient)
     * ctx.stdlib.classes.enumerate(function(className) {
     *   if (className.indexOf('Crypto') !== -1) {
     *     ctx.emit('found', { class: className });
     *   }
     * });
     *
     * @example
     * // Get first 500 loaded classes (options style)
     * var allClasses = ctx.stdlib.classes.enumerate({ limit: 500 });
     *
     * @example
     * // Find Activity subclasses using filter (options style)
     * var activities = ctx.stdlib.classes.enumerate({
     *   limit: 100,
     *   filter: function(name) {
     *     return name.indexOf('Activity') !== -1;
     *   }
     * });
     */
    enumerate: function (callbackOrOptions) {
      // Callback-based streaming enumeration
      if (typeof callbackOrOptions === 'function') {
        if (!isJavaAvailable()) {
          return;
        }

        var callback = callbackOrOptions;

        try {
          var allClasses = javaBridge.enumerateLoadedClassesSync();

          for (var i = 0; i < allClasses.length; i++) {
            try {
              callback(allClasses[i]);
            } catch (callbackErr) {
              // Callback threw an exception, continue enumeration
            }
          }
        } catch (e) {
          // Enumeration failed, nothing to do
        }

        return;
      }

      // Options-based array enumeration (original behavior)
      if (!isJavaAvailable()) {
        return [];
      }

      var opts = callbackOrOptions || {};
      var limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : undefined;
      var filterFn = typeof opts.filter === 'function' ? opts.filter : null;
      var results = [];

      try {
        var allClasses = javaBridge.enumerateLoadedClassesSync();

        for (var i = 0; i < allClasses.length; i++) {
          // Check limit before adding more
          if (limit !== undefined && results.length >= limit) {
            break;
          }

          var className = allClasses[i];

          // Apply filter if provided
          if (filterFn) {
            try {
              if (!filterFn(className)) {
                continue;
              }
            } catch (filterErr) {
              // Filter threw an exception, skip this class
              continue;
            }
          }

          results.push(className);
        }
      } catch (e) {
        // Enumeration failed, return whatever we have so far
        return results;
      }

      return results;
    },

    /**
     * Safely load a class by name, returning null on failure.
     *
     * Wraps Java.use() with try/catch to prevent exceptions when a class
     * cannot be loaded (e.g., not found, class loader issues, security
     * restrictions). Returns a Frida class wrapper that can be used for
     * hooking methods or accessing static fields.
     *
     * @param {string} className - Fully qualified class name to load.
     * @returns {object|null} Frida Java class wrapper for hooking/inspection,
     *   or null if the class could not be loaded.
     *
     * @example
     * // Load and hook a class
     * var SecretManager = ctx.stdlib.classes.load('com.example.SecretManager');
     * if (SecretManager) {
     *   SecretManager.getSecret.implementation = function() {
     *     ctx.emit('secret.accessed', { caller: ctx.stdlib.stack.getCaller() });
     *     return this.getSecret();
     *   };
     * }
     *
     * @example
     * // Check if class exists before using
     * var KeyStore = ctx.stdlib.classes.load('java.security.KeyStore');
     * if (KeyStore) {
     *   var ks = KeyStore.getInstance('AndroidKeyStore');
     *   ks.load(null);
     * }
     */
    load: function (className) {
      if (!isJavaAvailable()) {
        return null;
      }

      if (typeof className !== 'string' || className.length === 0) {
        return null;
      }

      try {
        return javaBridge.use(className);
      } catch (e) {
        // Class not found, access denied, or other loading error
        return null;
      }
    },

    /**
     * Check if a class is currently loaded in the VM.
     *
     * Searches the list of loaded classes to determine if the specified
     * class has been loaded. This does NOT trigger class loading - it only
     * checks if the class is already present.
     *
     * Note: This is O(n) on the number of loaded classes. For performance-
     * critical code that needs repeated checks, consider caching the result
     * of enumerate() and searching locally.
     *
     * @param {string} className - Fully qualified class name to check.
     * @returns {boolean} True if the class is currently loaded in the VM.
     *
     * @example
     * // Wait for a class to be loaded
     * if (ctx.stdlib.classes.isLoaded('com.example.LazyModule')) {
     *   ctx.emit('module.ready', { class: 'com.example.LazyModule' });
     * }
     */
    isLoaded: function (className) {
      if (!isJavaAvailable()) {
        return false;
      }

      if (typeof className !== 'string' || className.length === 0) {
        return false;
      }

      try {
        var allClasses = javaBridge.enumerateLoadedClassesSync();

        for (var i = 0; i < allClasses.length; i++) {
          if (allClasses[i] === className) {
            return true;
          }
        }

        return false;
      } catch (e) {
        return false;
      }
    },

    /**
     * Get live instances of a class currently on the heap.
     *
     * Uses Java.choose() to scan the heap for objects of the specified class.
     * This is an expensive operation that walks the entire heap - use sparingly
     * and always specify a reasonable limit.
     *
     * The returned instances are live references that can be used to call
     * methods, read fields, or pass to other Java APIs. Be aware that the
     * objects may be garbage collected if no other references exist.
     *
     * @param {string} className - Fully qualified class name to find instances of.
     * @param {object} [options] - Options for instance enumeration.
     * @param {number} [options.limit=10] - Maximum number of instances to return.
     *   Keep this value low (< 50) to avoid performance issues.
     * @returns {Array<object>} Array of live Java object instances.
     *
     * @example
     * // Find KeyStore instances and enumerate aliases
     * var keystores = ctx.stdlib.classes.instances('java.security.KeyStore', { limit: 5 });
     * keystores.forEach(function(ks) {
     *   try {
     *     var aliases = ks.aliases();
     *     while (aliases.hasMoreElements()) {
     *       var alias = aliases.nextElement();
     *       ctx.emit('keystore.alias', { alias: String(alias) });
     *     }
     *   } catch (e) {
     *     ctx.emit('keystore.error', { error: e.message });
     *   }
     * });
     *
     * @example
     * // Find SharedPreferences to dump stored values
     * var prefs = ctx.stdlib.classes.instances(
     *   'android.app.SharedPreferencesImpl',
     *   { limit: 3 }
     * );
     */
    instances: function (className, options) {
      if (!isJavaAvailable()) {
        return [];
      }

      if (typeof className !== 'string' || className.length === 0) {
        return [];
      }

      var opts = options || {};
      var limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 10;
      var results = [];

      try {
        javaBridge.choose(className, {
          /**
           * Called for each instance found on the heap.
           * @param {object} instance - Live Java object reference.
           * @returns {string|undefined} Return 'stop' to halt enumeration.
           */
          onMatch: function (instance) {
            if (results.length < limit) {
              results.push(instance);
            }
            // Stop early once we have enough instances
            if (results.length >= limit) {
              return 'stop';
            }
          },
          /**
           * Called when heap enumeration is complete.
           */
          onComplete: function () {
            // Enumeration finished
          }
        });
      } catch (e) {
        // Class not found or choose() failed
        return [];
      }

      return results;
    },

    /**
     * Get the ClassLoader that loaded a given class.
     *
     * Returns the ClassLoader instance responsible for loading the specified
     * class. Useful for understanding class loading hierarchies, accessing
     * classes from plugin/dynamic code, or debugging class resolution issues.
     *
     * Note: Bootstrap classes (java.lang.*, etc.) may return null as they
     * are loaded by the bootstrap class loader which is not represented
     * as a ClassLoader object.
     *
     * @param {string} className - Fully qualified class name.
     * @returns {object|null} ClassLoader instance that loaded the class,
     *   or null if the class cannot be loaded or uses the bootstrap loader.
     *
     * @example
     * // Get and log the class loader for a plugin class
     * var loader = ctx.stdlib.classes.getClassLoader('com.example.plugin.Module');
     * if (loader) {
     *   ctx.emit('classloader.info', {
     *     class: 'com.example.plugin.Module',
     *     loader: String(loader),
     *     loaderClass: String(loader.getClass().getName())
     *   });
     * }
     *
     * @example
     * // Find classes from same class loader
     * var loader = ctx.stdlib.classes.getClassLoader('com.example.TargetClass');
     * if (loader) {
     *   // Use the loader to load related classes that might not be in default classpath
     *   var helperClass = loader.loadClass('com.example.internal.Helper');
     * }
     */
    getClassLoader: function (className) {
      if (!isJavaAvailable()) {
        return null;
      }

      if (typeof className !== 'string' || className.length === 0) {
        return null;
      }

      try {
        var cls = javaBridge.use(className);
        // Access the underlying java.lang.Class and get its ClassLoader
        // cls.class gives us the Java Class object
        return cls.class.getClassLoader();
      } catch (e) {
        // Class not found or cannot access class loader
        return null;
      }
    }
  };

  return classesNamespace;
}

/**
 * Default classes namespace instance (without Java bridge).
 * This is replaced by createStdlib with a properly initialized version.
 * @namespace classes
 */
var classes = createClassesNamespace(null);

// ============================================================================
// Binary Data Utilities
// ============================================================================

/**
 * Binary data manipulation utilities.
 *
 * Provides functions for hex encoding/decoding, base64 conversion,
 * and ArrayBuffer manipulation common in cryptographic instrumentation.
 *
 * @namespace bytes
 */
var bytes = {
  /**
   * Convert bytes to hexadecimal string.
   *
   * @param {ArrayBuffer|Uint8Array|Array<number>} data - Binary data.
   * @param {object} [options] - Formatting options.
   * @param {boolean} [options.uppercase=false] - Use uppercase hex digits.
   * @param {string} [options.separator=''] - Separator between bytes.
   * @returns {string} Hexadecimal string.
   *
   * @example
   * var hex = ctx.stdlib.bytes.toHex(keyBytes, { separator: ':' });
   * ctx.emit('key', { hex: hex });
   */
  toHex: function (data, options) {
    var opts = options || {};
    var uppercase = opts.uppercase === true;
    var separator = opts.separator !== undefined ? opts.separator : '';

    // Normalize input to Uint8Array
    var byteArray;
    if (data instanceof ArrayBuffer) {
      byteArray = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      byteArray = data;
    } else if (Array.isArray(data)) {
      byteArray = new Uint8Array(data);
    } else {
      return '';
    }

    var hexChars = uppercase ? '0123456789ABCDEF' : '0123456789abcdef';
    var result = [];

    for (var i = 0; i < byteArray.length; i++) {
      var b = byteArray[i] & 0xff;
      var high = hexChars[(b >> 4) & 0x0f];
      var low = hexChars[b & 0x0f];
      result.push(high + low);
    }

    return result.join(separator);
  },

  /**
   * Convert hexadecimal string to Uint8Array.
   *
   * @param {string} hex - Hexadecimal string (with or without separators).
   * @returns {Uint8Array} Binary data.
   *
   * @example
   * var data = ctx.stdlib.bytes.fromHex('deadbeef');
   */
  fromHex: function (hex) {
    if (typeof hex !== 'string') {
      return new Uint8Array(0);
    }

    // Strip all non-hex characters (spaces, colons, dashes, etc.)
    var cleaned = hex.replace(/[^0-9a-fA-F]/g, '');

    // Handle odd-length strings by prepending a zero
    if (cleaned.length % 2 !== 0) {
      cleaned = '0' + cleaned;
    }

    var length = cleaned.length / 2;
    var result = new Uint8Array(length);

    for (var i = 0; i < length; i++) {
      var byteStr = cleaned.substr(i * 2, 2);
      result[i] = parseInt(byteStr, 16);
    }

    return result;
  },

  /**
   * Convert bytes to base64 string.
   *
   * @param {ArrayBuffer|Uint8Array|Array<number>} data - Binary data.
   * @returns {string} Base64 encoded string.
   */
  toBase64: function (data) {
    // Normalize input to Uint8Array
    var byteArray;
    if (data instanceof ArrayBuffer) {
      byteArray = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      byteArray = data;
    } else if (Array.isArray(data)) {
      byteArray = new Uint8Array(data);
    } else {
      return '';
    }

    // Try to use Android's Base64 class for compatibility
    if (typeof Java !== 'undefined' && Java.available) {
      try {
        var Base64 = Java.use('android.util.Base64');
        // Convert to Java byte[] (handle signed bytes)
        var javaBytes = bytes.toJavaBytes(byteArray);
        // NO_WRAP = 2 (no line breaks)
        return Base64.encodeToString(javaBytes, 2);
      } catch (e) {
        // Fall through to pure JS implementation
      }
    }

    // Pure JavaScript base64 encoding fallback
    var base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var result = '';
    var len = byteArray.length;

    for (var i = 0; i < len; i += 3) {
      var b1 = byteArray[i];
      var b2 = i + 1 < len ? byteArray[i + 1] : 0;
      var b3 = i + 2 < len ? byteArray[i + 2] : 0;

      var triplet = (b1 << 16) | (b2 << 8) | b3;

      result += base64Chars[(triplet >> 18) & 0x3f];
      result += base64Chars[(triplet >> 12) & 0x3f];
      result += i + 1 < len ? base64Chars[(triplet >> 6) & 0x3f] : '=';
      result += i + 2 < len ? base64Chars[triplet & 0x3f] : '=';
    }

    return result;
  },

  /**
   * Convert base64 string to Uint8Array.
   *
   * @param {string} base64 - Base64 encoded string.
   * @returns {Uint8Array} Binary data.
   */
  fromBase64: function (base64) {
    if (typeof base64 !== 'string' || base64.length === 0) {
      return new Uint8Array(0);
    }

    // Try to use Android's Base64 class for compatibility
    if (typeof Java !== 'undefined' && Java.available) {
      try {
        var Base64 = Java.use('android.util.Base64');
        // DEFAULT = 0
        var javaBytes = Base64.decode(base64, 0);
        return bytes.fromJavaBytes(javaBytes);
      } catch (e) {
        // Fall through to pure JS implementation
      }
    }

    // Pure JavaScript base64 decoding fallback
    var base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var lookup = {};
    for (var c = 0; c < base64Chars.length; c++) {
      lookup[base64Chars[c]] = c;
    }

    // Remove padding and calculate output length
    var cleanedBase64 = base64.replace(/[^A-Za-z0-9+/]/g, '');
    var paddingLen = base64.length - base64.replace(/=/g, '').length;
    var outputLen = Math.floor(cleanedBase64.length * 3 / 4) - paddingLen;
    var result = new Uint8Array(outputLen);

    var j = 0;
    for (var i = 0; i < cleanedBase64.length; i += 4) {
      var c1 = lookup[cleanedBase64[i]] || 0;
      var c2 = lookup[cleanedBase64[i + 1]] || 0;
      var c3 = lookup[cleanedBase64[i + 2]] || 0;
      var c4 = lookup[cleanedBase64[i + 3]] || 0;

      var triplet = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;

      if (j < outputLen) result[j++] = (triplet >> 16) & 0xff;
      if (j < outputLen) result[j++] = (triplet >> 8) & 0xff;
      if (j < outputLen) result[j++] = triplet & 0xff;
    }

    return result;
  },

  /**
   * Convert a Java byte[] to Uint8Array.
   *
   * @param {object} javaByteArray - Java byte[] object.
   * @returns {Uint8Array} JavaScript Uint8Array.
   *
   * @example
   * var jsBytes = ctx.stdlib.bytes.fromJavaBytes(cipher.doFinal(input));
   */
  fromJavaBytes: function (javaByteArray) {
    if (!javaByteArray) {
      return new Uint8Array(0);
    }

    try {
      var length = javaByteArray.length;
      var result = new Uint8Array(length);

      for (var i = 0; i < length; i++) {
        // Java bytes are signed (-128 to 127), convert to unsigned (0 to 255)
        var signedByte = javaByteArray[i];
        result[i] = signedByte < 0 ? signedByte + 256 : signedByte;
      }

      return result;
    } catch (e) {
      return new Uint8Array(0);
    }
  },

  /**
   * Convert Uint8Array to Java byte[].
   *
   * @param {Uint8Array|Array<number>} data - JavaScript byte data.
   * @returns {object} Java byte[] array.
   */
  toJavaBytes: function (data) {
    if (!data) {
      return null;
    }

    // Ensure we have an array-like structure
    var byteArray;
    if (data instanceof Uint8Array) {
      byteArray = data;
    } else if (Array.isArray(data)) {
      byteArray = data;
    } else if (data instanceof ArrayBuffer) {
      byteArray = new Uint8Array(data);
    } else {
      return null;
    }

    if (typeof Java === 'undefined' || !Java.available) {
      return null;
    }

    try {
      // Convert to signed bytes for Java (-128 to 127)
      var signedBytes = [];
      for (var i = 0; i < byteArray.length; i++) {
        var unsignedByte = byteArray[i] & 0xff;
        // Convert unsigned (0-255) to signed (-128 to 127)
        signedBytes.push(unsignedByte > 127 ? unsignedByte - 256 : unsignedByte);
      }

      return Java.array('byte', signedBytes);
    } catch (e) {
      return null;
    }
  },

  /**
   * Compare two byte arrays for equality.
   *
   * @param {ArrayBuffer|Uint8Array} a - First byte array.
   * @param {ArrayBuffer|Uint8Array} b - Second byte array.
   * @returns {boolean} True if arrays have identical content.
   */
  equals: function (a, b) {
    // Normalize both inputs to Uint8Array
    var arrA, arrB;

    if (a instanceof ArrayBuffer) {
      arrA = new Uint8Array(a);
    } else if (a instanceof Uint8Array) {
      arrA = a;
    } else if (Array.isArray(a)) {
      arrA = new Uint8Array(a);
    } else {
      return false;
    }

    if (b instanceof ArrayBuffer) {
      arrB = new Uint8Array(b);
    } else if (b instanceof Uint8Array) {
      arrB = b;
    } else if (Array.isArray(b)) {
      arrB = new Uint8Array(b);
    } else {
      return false;
    }

    // Length check first
    if (arrA.length !== arrB.length) {
      return false;
    }

    // Byte-by-byte comparison
    for (var i = 0; i < arrA.length; i++) {
      if (arrA[i] !== arrB[i]) {
        return false;
      }
    }

    return true;
  },

  /**
   * Concatenate multiple byte arrays.
   *
   * @param {...(ArrayBuffer|Uint8Array)} arrays - Arrays to concatenate.
   * @returns {Uint8Array} Concatenated result.
   */
  concat: function () {
    var arrays = [];
    var totalLength = 0;

    // Normalize all arguments to Uint8Array and compute total length
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i];
      var arr;

      if (arg instanceof ArrayBuffer) {
        arr = new Uint8Array(arg);
      } else if (arg instanceof Uint8Array) {
        arr = arg;
      } else if (Array.isArray(arg)) {
        arr = new Uint8Array(arg);
      } else {
        continue; // Skip invalid arguments
      }

      arrays.push(arr);
      totalLength += arr.length;
    }

    // Create result array and copy all bytes
    var result = new Uint8Array(totalLength);
    var offset = 0;

    for (var j = 0; j < arrays.length; j++) {
      result.set(arrays[j], offset);
      offset += arrays[j].length;
    }

    return result;
  },

  /**
   * Extract a slice from a byte array.
   *
   * @param {ArrayBuffer|Uint8Array} data - Source data.
   * @param {number} start - Start offset.
   * @param {number} [end] - End offset (exclusive).
   * @returns {Uint8Array} Sliced data.
   */
  slice: function (data, start, end) {
    // Normalize input to Uint8Array
    var byteArray;
    if (data instanceof ArrayBuffer) {
      byteArray = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      byteArray = data;
    } else if (Array.isArray(data)) {
      byteArray = new Uint8Array(data);
    } else {
      return new Uint8Array(0);
    }

    // Default end to array length
    var endIndex = end !== undefined ? end : byteArray.length;

    // Bounds checking
    var startIndex = Math.max(0, Math.min(start, byteArray.length));
    endIndex = Math.max(startIndex, Math.min(endIndex, byteArray.length));

    // Use slice to create a copy (subarray would create a view)
    return byteArray.slice(startIndex, endIndex);
  }
};

// ============================================================================
// String Utilities
// ============================================================================

/**
 * String manipulation and encoding utilities.
 *
 * Provides functions for string encoding/decoding, truncation,
 * and safe string extraction from Java objects.
 *
 * @namespace strings
 */
var strings = {
  /**
   * Safely convert a Java String to JavaScript string.
   *
   * Handles null inputs gracefully and catches any exceptions that may occur
   * during the conversion process. Works with Java String objects as well as
   * any Java object that has a toString() method.
   *
   * @param {object} javaString - Java String object (or any object with toString).
   * @returns {string|null} JavaScript string or null on failure/null input.
   *
   * @example
   * var jsStr = ctx.stdlib.strings.fromJava(intent.getAction());
   * if (jsStr !== null) {
   *   ctx.emit('action', { value: jsStr });
   * }
   */
  fromJava: function (javaString) {
    // Handle null/undefined input
    if (javaString === null || javaString === undefined) {
      return null;
    }

    try {
      // Attempt toString() first (works for Java String and other objects)
      if (typeof javaString.toString === 'function') {
        return String(javaString.toString());
      }
      // Fallback to String coercion
      return String(javaString);
    } catch (e) {
      // Conversion failed, return null rather than throwing
      return null;
    }
  },

  /**
   * Convert JavaScript string to Java String object.
   *
   * Creates a new Java String instance from the provided JavaScript string.
   * Requires Java runtime to be available.
   *
   * @param {string} str - JavaScript string to convert.
   * @returns {object|null} Java String object, or null if conversion fails.
   *
   * @example
   * var javaStr = ctx.stdlib.strings.toJava("test");
   * someJavaMethod(javaStr);
   */
  toJava: function (str) {
    // Handle null/undefined input
    if (str === null || str === undefined) {
      return null;
    }

    try {
      // Ensure we have a JS string
      var jsStr = String(str);
      // Create Java String using the constructor
      var JavaString = Java.use('java.lang.String');
      return JavaString.$new(jsStr);
    } catch (e) {
      // Java not available or conversion failed
      return null;
    }
  },

  /**
   * Truncate a string with ellipsis if it exceeds max length.
   *
   * If the string length exceeds maxLength, it is truncated and the ellipsis
   * is appended. The total result length will be exactly maxLength.
   *
   * @param {string} str - String to truncate.
   * @param {number} maxLength - Maximum length including ellipsis.
   * @param {string} [ellipsis='...'] - Ellipsis string to append when truncating.
   * @returns {string} Truncated string, or original if within limit.
   *
   * @example
   * ctx.stdlib.strings.truncate("hello world", 8);  // "hello..."
   * ctx.stdlib.strings.truncate("hi", 8);           // "hi"
   * ctx.stdlib.strings.truncate("hello world", 8, "~"); // "hello w~"
   */
  truncate: function (str, maxLength, ellipsis) {
    // Handle null/undefined input
    if (str === null || str === undefined) {
      return '';
    }

    // Coerce to string
    var s = String(str);

    // Default ellipsis
    var ell = (ellipsis !== null && ellipsis !== undefined) ? String(ellipsis) : '...';

    // Validate maxLength
    if (typeof maxLength !== 'number' || maxLength < 0) {
      return s;
    }

    // If string fits within maxLength, return as-is
    if (s.length <= maxLength) {
      return s;
    }

    // If maxLength is less than or equal to ellipsis length, just return truncated ellipsis
    if (maxLength <= ell.length) {
      return ell.substring(0, maxLength);
    }

    // Truncate and append ellipsis
    var truncateAt = maxLength - ell.length;
    return s.substring(0, truncateAt) + ell;
  },

  /**
   * Convert bytes to UTF-8 string.
   *
   * Decodes binary data as a UTF-8 encoded string. Accepts ArrayBuffer,
   * Uint8Array, or Java byte arrays. Falls back to Java String constructor
   * if TextDecoder is unavailable.
   *
   * @param {ArrayBuffer|Uint8Array|object} data - Binary data to decode.
   * @returns {string} UTF-8 decoded string, or empty string on failure.
   *
   * @example
   * var text = ctx.stdlib.strings.fromUtf8(responseBytes);
   */
  fromUtf8: function (data) {
    // Handle null/undefined input
    if (data === null || data === undefined) {
      return '';
    }

    try {
      // Convert to Uint8Array if needed
      var bytes;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else if (Array.isArray(data)) {
        bytes = new Uint8Array(data);
      } else {
        // Assume it might be a Java byte array or similar
        // Try to convert element by element
        var len = data.length;
        if (typeof len === 'number' && len >= 0) {
          bytes = new Uint8Array(len);
          for (var i = 0; i < len; i++) {
            // Handle signed Java bytes (range -128 to 127)
            var b = data[i];
            bytes[i] = b < 0 ? b + 256 : b;
          }
        } else {
          return '';
        }
      }

      // Try TextDecoder first (may not be available in all Frida environments)
      if (typeof TextDecoder !== 'undefined') {
        var decoder = new TextDecoder('utf-8');
        return decoder.decode(bytes);
      }

      // Fallback: use Java String constructor with UTF-8 charset
      try {
        var JavaString = Java.use('java.lang.String');
        // Convert Uint8Array to Java byte array
        var javaBytes = Java.array('byte', Array.prototype.slice.call(bytes).map(function (b) {
          return b > 127 ? b - 256 : b; // Convert to signed byte
        }));
        var javaStr = JavaString.$new(javaBytes, 'UTF-8');
        return String(javaStr.toString());
      } catch (javaErr) {
        // Java fallback failed, continue to manual decode
      }

      // Last resort: manual UTF-8 decoding for ASCII subset
      var result = '';
      for (var j = 0; j < bytes.length; j++) {
        var byte = bytes[j];
        if (byte < 128) {
          result += String.fromCharCode(byte);
        } else {
          // Non-ASCII: use replacement character
          result += '\uFFFD';
        }
      }
      return result;
    } catch (e) {
      return '';
    }
  },

  /**
   * Convert string to UTF-8 bytes.
   *
   * Encodes a string as UTF-8 binary data. Returns a Uint8Array containing
   * the UTF-8 byte representation of the string.
   *
   * @param {string} str - String to encode.
   * @returns {Uint8Array} UTF-8 encoded bytes, or empty array on failure.
   *
   * @example
   * var bytes = ctx.stdlib.strings.toUtf8("hello");
   * ctx.emit('data', { length: bytes.length });
   */
  toUtf8: function (str) {
    // Handle null/undefined input
    if (str === null || str === undefined) {
      return new Uint8Array(0);
    }

    try {
      // Coerce to string
      var s = String(str);

      // Try TextEncoder first (may not be available in all Frida environments)
      if (typeof TextEncoder !== 'undefined') {
        var encoder = new TextEncoder();
        return encoder.encode(s);
      }

      // Fallback: use Java String.getBytes("UTF-8")
      try {
        var JavaString = Java.use('java.lang.String');
        var javaStr = JavaString.$new(s);
        var javaBytes = javaStr.getBytes('UTF-8');
        // Convert Java byte array to Uint8Array
        var len = javaBytes.length;
        var result = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
          var b = javaBytes[i];
          result[i] = b < 0 ? b + 256 : b; // Convert signed to unsigned
        }
        return result;
      } catch (javaErr) {
        // Java fallback failed, continue to manual encode
      }

      // Last resort: manual UTF-8 encoding
      var bytes = [];
      for (var j = 0; j < s.length; j++) {
        var code = s.codePointAt(j);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xC0 | (code >> 6));
          bytes.push(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
          bytes.push(0xE0 | (code >> 12));
          bytes.push(0x80 | ((code >> 6) & 0x3F));
          bytes.push(0x80 | (code & 0x3F));
        } else {
          // 4-byte encoding for code points >= 0x10000 (emoji, CJK ext-B, etc.)
          bytes.push(0xF0 | (code >> 18));
          bytes.push(0x80 | ((code >> 12) & 0x3F));
          bytes.push(0x80 | ((code >> 6) & 0x3F));
          bytes.push(0x80 | (code & 0x3F));
          j++; // codePointAt() decoded a surrogate pair; skip the low surrogate
        }
      }
      return new Uint8Array(bytes);
    } catch (e) {
      return new Uint8Array(0);
    }
  },

  /**
   * Check if a string matches a pattern (glob or regex).
   *
   * Supports three pattern types:
   * - RegExp: Uses native regex matching
   * - String with '*' wildcards: Converts glob pattern to regex
   * - Plain string: Checks if str starts with the pattern (prefix match)
   *
   * @param {string} str - String to test.
   * @param {string|RegExp} pattern - Pattern to match against.
   * @returns {boolean} True if string matches pattern, false otherwise.
   *
   * @example
   * ctx.stdlib.strings.matches("com.example.app", /^com\.example/);  // true
   * ctx.stdlib.strings.matches("com.example.app", "com.example.*");  // true (glob)
   * ctx.stdlib.strings.matches("com.example.app", "com.example");    // true (prefix)
   * ctx.stdlib.strings.matches("other.app", "com.example");          // false
   */
  matches: function (str, pattern) {
    // Handle null/undefined inputs
    if (str === null || str === undefined) {
      return false;
    }
    if (pattern === null || pattern === undefined) {
      return false;
    }

    try {
      // Coerce str to string
      var s = String(str);

      // If pattern is already a RegExp, use it directly
      if (pattern instanceof RegExp) {
        return pattern.test(s);
      }

      // Coerce pattern to string
      var p = String(pattern);

      // Check if pattern contains glob wildcards
      if (p.indexOf('*') !== -1) {
        // Convert glob pattern to regex
        // Escape regex special characters except *
        var escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        // Convert * to .*
        var regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
        var regex = new RegExp(regexStr);
        return regex.test(s);
      }

      // Plain string: prefix match
      return s.indexOf(p) === 0;
    } catch (e) {
      return false;
    }
  },

  /**
   * Safely extract string representation of any object.
   *
   * Attempts to convert any object to a string representation without throwing.
   * Handles Java objects, null values, circular references, and objects that
   * throw on toString(). Truncates result if it exceeds maxLength.
   *
   * @param {any} obj - Object to stringify.
   * @param {number} [maxLength=1000] - Maximum result length (truncated with ellipsis).
   * @returns {string} String representation, never throws.
   *
   * @example
   * var desc = ctx.stdlib.strings.safeToString(unknownObject);
   * ctx.emit('object', { description: desc });
   */
  safeToString: function (obj, maxLength) {
    // Default maxLength
    var limit = (typeof maxLength === 'number' && maxLength > 0) ? maxLength : 1000;

    try {
      // Handle null/undefined
      if (obj === null) {
        return 'null';
      }
      if (obj === undefined) {
        return 'undefined';
      }

      var result;

      // Handle primitive types directly
      var typeOf = typeof obj;
      if (typeOf === 'string') {
        result = obj;
      } else if (typeOf === 'number' || typeOf === 'boolean') {
        result = String(obj);
      } else if (typeOf === 'function') {
        result = '[Function' + (obj.name ? ': ' + obj.name : '') + ']';
      } else if (typeOf === 'symbol') {
        result = obj.toString();
      } else {
        // Object types - try various approaches
        try {
          // Try toString() first
          if (typeof obj.toString === 'function') {
            var strResult = obj.toString();
            // Check if it's the default [object Object]
            if (strResult === '[object Object]') {
              // Try to get more useful info
              try {
                // For Java objects, try getClass().getName()
                if (typeof obj.getClass === 'function') {
                  var className = obj.getClass().getName();
                  result = '[' + className + ']';
                } else if (obj.constructor && obj.constructor.name) {
                  result = '[' + obj.constructor.name + ']';
                } else {
                  result = strResult;
                }
              } catch (classErr) {
                result = strResult;
              }
            } else {
              result = strResult;
            }
          } else {
            // No toString, describe the type
            result = '[Object]';
          }
        } catch (toStringErr) {
          // toString() threw, try to describe the object
          try {
            if (typeof obj.getClass === 'function') {
              result = '[' + obj.getClass().getName() + ' (toString failed)]';
            } else if (obj.constructor && obj.constructor.name) {
              result = '[' + obj.constructor.name + ' (toString failed)]';
            } else {
              result = '[Object (toString failed)]';
            }
          } catch (descErr) {
            result = '[Object (inaccessible)]';
          }
        }
      }

      // Ensure result is a string
      result = String(result);

      // Truncate if needed
      if (result.length > limit) {
        return result.substring(0, limit - 3) + '...';
      }

      return result;
    } catch (e) {
      // Absolute fallback - should never reach here but be safe
      return '[Error converting to string]';
    }
  }
};

// ============================================================================
// Android Intent Utilities
// ============================================================================

/**
 * Android Intent parsing and construction utilities.
 *
 * Provides functions to extract data from Intent objects, parse
 * intent extras, and construct new intents for testing.
 *
 * @namespace intent
 */
var intent = {
  /**
   * Map of Intent flag values to their names.
   * These are the most commonly used flags from android.content.Intent.
   *
   * @private
   * @type {Object<number, string>}
   */
  _flagMap: {
    0x10000000: 'FLAG_ACTIVITY_NEW_TASK',
    0x04000000: 'FLAG_ACTIVITY_CLEAR_TOP',
    0x08000000: 'FLAG_ACTIVITY_SINGLE_TOP',
    0x00008000: 'FLAG_ACTIVITY_NO_HISTORY',
    0x20000000: 'FLAG_ACTIVITY_MULTIPLE_TASK',
    0x00010000: 'FLAG_ACTIVITY_FORWARD_RESULT',
    0x00020000: 'FLAG_ACTIVITY_PREVIOUS_IS_TOP',
    0x00040000: 'FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS',
    0x00080000: 'FLAG_ACTIVITY_BROUGHT_TO_FRONT',
    0x00100000: 'FLAG_ACTIVITY_RESET_TASK_IF_NEEDED',
    0x00200000: 'FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY',
    0x00400000: 'FLAG_ACTIVITY_CLEAR_WHEN_TASK_RESET',
    0x00800000: 'FLAG_ACTIVITY_NEW_DOCUMENT',
    0x01000000: 'FLAG_ACTIVITY_NO_USER_ACTION',
    0x02000000: 'FLAG_ACTIVITY_REORDER_TO_FRONT',
    0x40000000: 'FLAG_ACTIVITY_NO_ANIMATION',
    0x80000000: 'FLAG_ACTIVITY_CLEAR_TASK',
    0x00004000: 'FLAG_ACTIVITY_TASK_ON_HOME',
    0x00002000: 'FLAG_ACTIVITY_RETAIN_IN_RECENTS',
    0x00000001: 'FLAG_GRANT_READ_URI_PERMISSION',
    0x00000002: 'FLAG_GRANT_WRITE_URI_PERMISSION',
    0x00000004: 'FLAG_FROM_BACKGROUND',
    0x00000008: 'FLAG_DEBUG_LOG_RESOLUTION',
    0x00000010: 'FLAG_EXCLUDE_STOPPED_PACKAGES',
    0x00000020: 'FLAG_INCLUDE_STOPPED_PACKAGES',
    0x00000080: 'FLAG_GRANT_PERSISTABLE_URI_PERMISSION',
    0x00000100: 'FLAG_GRANT_PREFIX_URI_PERMISSION',
    0x00000400: 'FLAG_DIRECT_BOOT_AUTO',
    0x00001000: 'FLAG_RECEIVER_REGISTERED_ONLY',
    0x00000200: 'FLAG_RECEIVER_REPLACE_PENDING',
    0x00000800: 'FLAG_RECEIVER_FOREGROUND'
  },

  /**
   * Extract all information from an Intent object.
   *
   * Parses the Intent by calling its getter methods and extracting
   * action, data URI, MIME type, categories, component, flags, and extras.
   *
   * @param {object} intentObj - Android Intent object.
   * @returns {object} Parsed intent data with the following structure:
   *   - action {string|null} - The intent action (e.g., "android.intent.action.VIEW")
   *   - data {string|null} - The data URI as a string
   *   - type {string|null} - The MIME type
   *   - categories {Array<string>} - Array of category strings
   *   - component {{ package: string, class: string }|null} - Target component
   *   - flags {number} - The raw flags bitmask
   *   - flagNames {Array<string>} - Human-readable flag names
   *   - extras {object} - Key-value object of extras from the Bundle
   *
   * @example
   * var info = ctx.stdlib.intent.parse(receivedIntent);
   * ctx.emit('intent.received', info);
   *
   * @example
   * // Hook Activity.startActivity to capture outgoing intents
   * Activity.startActivity.implementation = function(intent) {
   *   var parsed = ctx.stdlib.intent.parse(intent);
   *   ctx.emit('activity.start', { intent: parsed });
   *   this.startActivity(intent);
   * };
   */
  parse: function (intentObj) {
    var self = this;
    var result = {
      action: null,
      data: null,
      type: null,
      categories: [],
      component: null,
      flags: 0,
      flagNames: [],
      extras: {}
    };

    if (!intentObj) {
      return result;
    }

    try {
      var action = intentObj.getAction();
      if (action !== null) {
        result.action = String(action);
      }
    } catch (e) {
      // Silently ignore errors for individual fields
    }

    try {
      var dataUri = intentObj.getData();
      if (dataUri !== null) {
        result.data = String(dataUri.toString());
      }
    } catch (e) {
      // Silently ignore
    }

    try {
      var mimeType = intentObj.getType();
      if (mimeType !== null) {
        result.type = String(mimeType);
      }
    } catch (e) {
      // Silently ignore
    }

    try {
      var categories = intentObj.getCategories();
      if (categories !== null) {
        var iterator = categories.iterator();
        while (iterator.hasNext()) {
          var cat = iterator.next();
          if (cat !== null) {
            result.categories.push(String(cat));
          }
        }
      }
    } catch (e) {
      // Silently ignore
    }

    result.component = self.getComponent(intentObj);

    try {
      result.flags = intentObj.getFlags();
      result.flagNames = self.flagsToStrings(result.flags);
    } catch (e) {
      // Silently ignore
    }

    result.extras = self.getExtras(intentObj);

    return result;
  },

  /**
   * Extract extras from an Intent as a JavaScript object.
   *
   * Iterates through the Bundle's keys and extracts values using
   * appropriate type-specific getters. Handles nested Bundles recursively
   * and falls back to toString() for Parcelable/Serializable objects.
   *
   * @param {object} intentObj - Android Intent object.
   * @returns {object} Key-value object of extras. Values are converted to
   *   JavaScript primitives where possible, nested Bundles become nested objects.
   *
   * @example
   * var extras = ctx.stdlib.intent.getExtras(intent);
   * if (extras.user_id) {
   *   ctx.emit('extras', { userId: extras.user_id });
   * }
   */
  getExtras: function (intentObj) {
    var self = this;
    var result = {};

    if (!intentObj) {
      return result;
    }

    var bundle;
    try {
      bundle = intentObj.getExtras();
      if (bundle === null) {
        return result;
      }
    } catch (e) {
      return result;
    }

    return self._parseBundle(bundle, 0);
  },

  /**
   * Internal helper to parse a Bundle into a JavaScript object.
   *
   * @private
   * @param {object} bundle - Android Bundle object.
   * @param {number} depth - Current recursion depth.
   * @returns {object} Parsed key-value object.
   */
  _parseBundle: function (bundle, depth) {
    var self = this;
    var result = {};
    var maxDepth = 10;

    if (!bundle || depth > maxDepth) {
      return result;
    }

    try {
      var keySet = bundle.keySet();
      if (keySet === null) {
        return result;
      }

      var iterator = keySet.iterator();
      while (iterator.hasNext()) {
        var key = iterator.next();
        if (key === null) {
          continue;
        }

        var keyStr = String(key);
        try {
          result[keyStr] = self._getBundleValue(bundle, keyStr, depth);
        } catch (e) {
          try {
            var val = bundle.get(key);
            if (val !== null) {
              result[keyStr] = String(val.toString());
            } else {
              result[keyStr] = null;
            }
          } catch (e2) {
            result[keyStr] = '<error reading value>';
          }
        }
      }
    } catch (e) {
      // Return partial results on error
    }

    return result;
  },

  /**
   * Internal helper to extract a typed value from a Bundle.
   *
   * @private
   * @param {object} bundle - Android Bundle object.
   * @param {string} key - The key to extract.
   * @param {number} depth - Current recursion depth.
   * @returns {*} The extracted value in JavaScript-compatible form.
   */
  _getBundleValue: function (bundle, key, depth) {
    var self = this;
    var rawValue = bundle.get(key);

    if (rawValue === null) {
      return null;
    }

    var className;
    try {
      className = rawValue.getClass().getName();
    } catch (e) {
      return String(rawValue.toString());
    }

    try {
      if (className === 'java.lang.String') {
        return String(bundle.getString(key));
      }
      if (className === 'java.lang.Integer' || className === 'int') {
        return bundle.getInt(key);
      }
      if (className === 'java.lang.Long' || className === 'long') {
        var longVal = bundle.getLong(key);
        if (longVal >= -9007199254740991 && longVal <= 9007199254740991) {
          return Number(longVal);
        }
        return String(longVal);
      }
      if (className === 'java.lang.Boolean' || className === 'boolean') {
        return Boolean(bundle.getBoolean(key));
      }
      if (className === 'java.lang.Float' || className === 'float') {
        return bundle.getFloat(key);
      }
      if (className === 'java.lang.Double' || className === 'double') {
        return bundle.getDouble(key);
      }
      if (className === 'java.lang.Short' || className === 'short') {
        return bundle.getShort(key);
      }
      if (className === 'java.lang.Byte' || className === 'byte') {
        return bundle.getByte(key);
      }
      if (className === 'java.lang.Character' || className === 'char') {
        return String(bundle.getChar(key));
      }
      if (className === '[Ljava.lang.String;') {
        var strArr = bundle.getStringArray(key);
        if (strArr === null) {
          return null;
        }
        var strResult = [];
        for (var i = 0; i < strArr.length; i++) {
          strResult.push(strArr[i] !== null ? String(strArr[i]) : null);
        }
        return strResult;
      }
      if (className === '[I') {
        var intArr = bundle.getIntArray(key);
        if (intArr === null) {
          return null;
        }
        var intResult = [];
        for (var j = 0; j < intArr.length; j++) {
          intResult.push(intArr[j]);
        }
        return intResult;
      }
      if (className === '[B') {
        var byteArr = bundle.getByteArray(key);
        if (byteArr === null) {
          return null;
        }
        var hexParts = [];
        for (var k = 0; k < byteArr.length; k++) {
          var b = byteArr[k] & 0xff;
          hexParts.push((b < 16 ? '0' : '') + b.toString(16));
        }
        return { _type: 'byte[]', hex: hexParts.join(''), length: byteArr.length };
      }
      if (className === 'android.os.Bundle') {
        var nestedBundle = bundle.getBundle(key);
        if (nestedBundle === null) {
          return null;
        }
        return self._parseBundle(nestedBundle, depth + 1);
      }
      if (className.indexOf('ArrayList') !== -1) {
        var arrayList = rawValue;
        var arrResult = [];
        var size = arrayList.size();
        for (var m = 0; m < size; m++) {
          var elem = arrayList.get(m);
          if (elem !== null) {
            arrResult.push(String(elem.toString()));
          } else {
            arrResult.push(null);
          }
        }
        return arrResult;
      }
      if (className === 'android.net.Uri' || className.indexOf('Uri') !== -1) {
        return { _type: 'Uri', value: String(rawValue.toString()) };
      }
      if (className === 'android.content.Intent') {
        return { _type: 'Intent', value: self.parse(rawValue) };
      }
      return { _type: className, value: String(rawValue.toString()) };
    } catch (e) {
      try {
        return String(rawValue.toString());
      } catch (e2) {
        return '<error: ' + String(e) + '>';
      }
    }
  },

  /**
   * Get the target component (activity/service/receiver) from an Intent.
   *
   * Extracts the ComponentName from the Intent and returns the package
   * name and class name as a structured object.
   *
   * @param {object} intentObj - Android Intent object.
   * @returns {{ package: string, class: string }|null} Component info with
   *   package and class names, or null if Intent has no explicit component.
   *
   * @example
   * var component = ctx.stdlib.intent.getComponent(intent);
   * if (component) {
   *   ctx.emit('explicit.intent', {
   *     pkg: component.package,
   *     cls: component.class
   *   });
   * }
   */
  getComponent: function (intentObj) {
    if (!intentObj) {
      return null;
    }

    try {
      var component = intentObj.getComponent();
      if (component === null) {
        return null;
      }

      return {
        package: String(component.getPackageName()),
        class: String(component.getClassName())
      };
    } catch (e) {
      return null;
    }
  },

  /**
   * Check if an Intent is explicit (has a target component).
   *
   * @param {object} intentObj - Android Intent object.
   * @returns {boolean} True if Intent has an explicit component target.
   *
   * @example
   * if (ctx.stdlib.intent.isExplicit(intent)) {
   *   ctx.emit('explicit.intent', { action: intent.getAction() });
   * } else {
   *   ctx.emit('implicit.intent', { action: intent.getAction() });
   * }
   */
  isExplicit: function (intentObj) {
    return this.getComponent(intentObj) !== null;
  },

  /**
   * Create a new Android Intent with the specified properties.
   *
   * Constructs an Android Intent object from a single options object containing
   * action, data URI, MIME type, component info, extras, and flags.
   *
   * @param {object} opts - Intent configuration options.
   * @param {string} [opts.action] - Intent action string (e.g., "android.intent.action.VIEW").
   * @param {string} [opts.data] - Intent data URI string.
   * @param {string} [opts.type] - Intent MIME type string.
   * @param {string} [opts.className] - Target class name for explicit intent.
   * @param {string} [opts.packageName] - Target package name for explicit intent.
   * @param {object} [opts.extras] - Extra key-value pairs to add to the Intent.
   * @param {number} [opts.flags] - Intent flags to set.
   * @returns {object} Android Intent object, or null on error.
   *
   * @example
   * var viewIntent = ctx.stdlib.intent.create({
   *   action: 'android.intent.action.VIEW',
   *   data: 'https://example.com',
   *   type: 'text/html',
   *   extras: { key: 'value' }
   * });
   *
   * @example
   * var explicitIntent = ctx.stdlib.intent.create({
   *   action: 'android.intent.action.MAIN',
   *   packageName: 'com.example.app',
   *   className: 'com.example.app.MainActivity'
   * });
   */
  create: function (opts) {
    var self = this;
    try {
      var options = opts || {};
      var Intent = Java.use('android.content.Intent');
      var newIntent;

      if (options.action) {
        newIntent = Intent.$new(options.action);
      } else {
        newIntent = Intent.$new();
      }

      if (options.data) {
        var Uri = Java.use('android.net.Uri');
        var uri = Uri.parse(options.data);
        if (options.type) {
          newIntent.setDataAndType(uri, options.type);
        } else {
          newIntent.setData(uri);
        }
      } else if (options.type) {
        newIntent.setType(options.type);
      }

      if (options.flags !== undefined) {
        newIntent.setFlags(options.flags);
      }

      if (options.packageName && options.className) {
        var ComponentName = Java.use('android.content.ComponentName');
        var compName = ComponentName.$new(options.packageName, options.className);
        newIntent.setComponent(compName);
      }

      if (options.extras) {
        for (var key in options.extras) {
          if (Object.prototype.hasOwnProperty.call(options.extras, key)) {
            var value = options.extras[key];
            self._putExtra(newIntent, key, value);
          }
        }
      }

      return newIntent;
    } catch (e) {
      return null;
    }
  },

  /**
   * Internal helper to put an extra value into an Intent.
   *
   * @private
   * @param {object} intentArg - Android Intent object.
   * @param {string} key - The extra key.
   * @param {*} value - The value to put (string, number, boolean, or array).
   */
  _putExtra: function (intentArg, key, value) {
    if (value === null || value === undefined) {
      return;
    }

    try {
      if (typeof value === 'string') {
        intentArg.putExtra(key, value);
        return;
      }
      if (typeof value === 'boolean') {
        intentArg.putExtra(key, value);
        return;
      }
      if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          if (value >= -2147483648 && value <= 2147483647) {
            intentArg.putExtra(key, value);
          } else {
            var Long = Java.use('java.lang.Long');
            intentArg.putExtra(key, Long.$new(value.toString()).longValue());
          }
        } else {
          intentArg.putExtra(key, value);
        }
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          var emptyArr = Java.array('java.lang.String', []);
          intentArg.putExtra(key, emptyArr);
          return;
        }
        var allStrings = value.every(function (v) {
          return typeof v === 'string';
        });
        if (allStrings) {
          var strArray = Java.array('java.lang.String', value);
          intentArg.putExtra(key, strArray);
        } else {
          var converted = value.map(function (v) {
            return String(v);
          });
          var mixedArray = Java.array('java.lang.String', converted);
          intentArg.putExtra(key, mixedArray);
        }
        return;
      }
      intentArg.putExtra(key, String(value));
    } catch (e) {
      // Silently ignore errors putting extras
    }
  },

  /**
   * Convert Intent flags integer to human-readable array.
   *
   * @param {number} flags - Intent flags bitmask.
   * @returns {Array<string>} Array of flag names that are set.
   *
   * @example
   * var flagNames = ctx.stdlib.intent.flagsToStrings(intent.getFlags());
   * ctx.emit('intent.flags', { flags: flagNames });
   */
  flagsToStrings: function (flags) {
    var result = [];

    if (!flags || flags === 0) {
      return result;
    }

    var flagMap = this._flagMap;
    for (var flagValue in flagMap) {
      if (Object.prototype.hasOwnProperty.call(flagMap, flagValue)) {
        var numValue = parseInt(flagValue, 10);
        if ((flags & numValue) !== 0) {
          result.push(flagMap[flagValue]);
        }
      }
    }

    result.sort();

    return result;
  }
};

// ============================================================================
// Hook Utilities
// ============================================================================

/**
 * Creates the hook utilities namespace with optional metrics callback.
 *
 * Provides convenient wrappers around Frida's Interceptor and Java.use
 * for common hooking patterns with automatic error handling.
 *
 * @param {function|null} onHookInstalled - Optional callback invoked when hooks are installed.
 *        Called with the count of hooks installed (default 1).
 * @returns {object} Hook namespace object with all utility functions.
 * @private
 */
function createHookNamespace(onHookInstalled) {
  /**
   * Internal helper to notify that hooks were installed.
   *
   * @param {number} [count=1] - Number of hooks installed.
   * @private
   */
  function notifyHookInstalled(count) {
    if (typeof onHookInstalled === 'function') {
      try {
        onHookInstalled(count || 1);
      } catch (_) {
        // Swallow callback errors to avoid breaking hook installation
      }
    }
  }

  return {
  /**
   * Hook a Java method with automatic error handling.
   *
   * Installs an implementation hook on the specified Java method. The callbacks
   * object supports onEnter (called with method arguments before execution) and
   * onLeave (called with return value after execution). Use `this` context to
   * share data between onEnter and onLeave. Modify retval.value in onLeave to
   * change the return value.
   *
   * @param {string} className - Fully qualified class name.
   * @param {string} methodName - Method name to hook.
   * @param {object} callbacks - Hook callbacks.
   * @param {function} [callbacks.onEnter] - Called before method execution with (args) array.
   * @param {function} [callbacks.onLeave] - Called after method execution with (retval) wrapper.
   * @returns {{ ok: boolean, error?: string }} Result object.
   *
   * @example
   * ctx.stdlib.hook.method('javax.crypto.Cipher', 'doFinal', {
   *   onEnter: function(args) {
   *     this.input = args[0];
   *   },
   *   onLeave: function(retval) {
   *     ctx.emit('cipher', { input: this.input, output: retval.value });
   *   }
   * });
   */
  method: function (className, methodName, callbacks) {
    var result = { ok: false };

    try {
      Java.perform(function () {
        try {
          var targetClass = Java.use(className);
          var targetMethod = targetClass[methodName];

          if (!targetMethod) {
            result.error = 'Method not found: ' + className + '.' + methodName;
            return;
          }

          // Get the overloads array to hook all signatures
          var overloads = targetMethod.overloads;

          if (!overloads || overloads.length === 0) {
            // Single method, no overloads - hook directly
            targetMethod.implementation = function () {
              var args = [];
              for (var i = 0; i < arguments.length; i++) {
                args.push(arguments[i]);
              }

              var hookContext = {};

              if (callbacks && typeof callbacks.onEnter === 'function') {
                try {
                  callbacks.onEnter.call(hookContext, args);
                } catch (enterErr) {
                  // Swallow onEnter errors to avoid breaking the app
                }
              }

              var returnValue = targetMethod.apply(this, args);

              if (callbacks && typeof callbacks.onLeave === 'function') {
                try {
                  var retvalWrapper = { value: returnValue };
                  callbacks.onLeave.call(hookContext, retvalWrapper);
                  returnValue = retvalWrapper.value;
                } catch (leaveErr) {
                  // Swallow onLeave errors to avoid breaking the app
                }
              }

              return returnValue;
            };
          } else {
            // Hook all overloads
            for (var i = 0; i < overloads.length; i++) {
              (function (overload) {
                overload.implementation = function () {
                  var args = [];
                  for (var j = 0; j < arguments.length; j++) {
                    args.push(arguments[j]);
                  }

                  var hookContext = {};

                  if (callbacks && typeof callbacks.onEnter === 'function') {
                    try {
                      callbacks.onEnter.call(hookContext, args);
                    } catch (enterErr) {
                      // Swallow onEnter errors
                    }
                  }

                  var returnValue = overload.apply(this, args);

                  if (callbacks && typeof callbacks.onLeave === 'function') {
                    try {
                      var retvalWrapper = { value: returnValue };
                      callbacks.onLeave.call(hookContext, retvalWrapper);
                      returnValue = retvalWrapper.value;
                    } catch (leaveErr) {
                      // Swallow onLeave errors
                    }
                  }

                  return returnValue;
                };
              })(overloads[i]);
            }
          }

          result.ok = true;
          notifyHookInstalled(1);
        } catch (innerErr) {
          result.error = String(innerErr);
        }
      });
    } catch (outerErr) {
      result.error = String(outerErr);
    }

    return result;
  },

  /**
   * Hook all overloads of a Java method.
   *
   * Iterates through all method overloads and installs a hook on each one.
   * The handler receives the arguments array and the original method bound to
   * the current instance, allowing it to call the original implementation.
   *
   * @param {string} className - Fully qualified class name.
   * @param {string} methodName - Method name to hook.
   * @param {function} handler - Handler function(args, originalMethod) that should return the result.
   * @returns {{ ok: boolean, count: number, error?: string }} Result object with count of hooked overloads.
   *
   * @example
   * ctx.stdlib.hook.allOverloads('java.net.URL', 'openConnection', function(args, original) {
   *   ctx.emit('url.connect', { url: this.toString() });
   *   return original.call(this, args);
   * });
   */
  allOverloads: function (className, methodName, handler) {
    var result = { ok: false, count: 0 };

    try {
      Java.perform(function () {
        try {
          var targetClass = Java.use(className);
          var targetMethod = targetClass[methodName];

          if (!targetMethod) {
            result.error = 'Method not found: ' + className + '.' + methodName;
            return;
          }

          var overloads = targetMethod.overloads;

          if (!overloads || overloads.length === 0) {
            result.error = 'No overloads found for: ' + className + '.' + methodName;
            return;
          }

          for (var i = 0; i < overloads.length; i++) {
            (function (overload) {
              overload.implementation = function () {
                var args = [];
                for (var j = 0; j < arguments.length; j++) {
                  args.push(arguments[j]);
                }

                // Create original method wrapper that calls the overload
                var self = this;
                var originalMethod = {
                  call: function (thisArg, argsArray) {
                    var callThis = thisArg || self;
                    return overload.call(callThis, argsArray || args);
                  },
                  apply: function (thisArg, argsArray) {
                    var callThis = thisArg || self;
                    return overload.call(callThis, argsArray || args);
                  }
                };

                try {
                  return handler.call(self, args, originalMethod);
                } catch (handlerErr) {
                  // On handler error, fall back to calling original
                  return overload.call(self, args);
                }
              };

              result.count++;
            })(overloads[i]);
          }

          result.ok = true;
          notifyHookInstalled(result.count);
        } catch (innerErr) {
          result.error = String(innerErr);
        }
      });
    } catch (outerErr) {
      result.error = String(outerErr);
    }

    return result;
  },

  /**
   * Hook a constructor (all overloads).
   *
   * Hooks all constructor overloads of a Java class by targeting the $init
   * method. The handler receives the constructor arguments and can inspect
   * or modify them. The original constructor is always called after the handler.
   *
   * @param {string} className - Fully qualified class name.
   * @param {function} handler - Handler function(args) called before constructor executes.
   * @returns {{ ok: boolean, count: number, error?: string }} Result object with count of hooked overloads.
   *
   * @example
   * ctx.stdlib.hook.constructor('java.io.File', function(args) {
   *   ctx.emit('file.new', { path: args[0] ? args[0].toString() : null });
   * });
   */
  constructor: function (className, handler) {
    var result = { ok: false, count: 0 };

    try {
      Java.perform(function () {
        try {
          var targetClass = Java.use(className);
          var initMethod = targetClass.$init;

          if (!initMethod) {
            result.error = 'Constructor not found for: ' + className;
            return;
          }

          var overloads = initMethod.overloads;

          if (!overloads || overloads.length === 0) {
            result.error = 'No constructor overloads found for: ' + className;
            return;
          }

          for (var i = 0; i < overloads.length; i++) {
            (function (overload) {
              overload.implementation = function () {
                var args = [];
                for (var j = 0; j < arguments.length; j++) {
                  args.push(arguments[j]);
                }

                // Call the handler with constructor arguments
                try {
                  handler.call(this, args);
                } catch (handlerErr) {
                  // Swallow handler errors to avoid breaking object construction
                }

                // Call the original constructor
                return overload.call(this, args);
              };

              result.count++;
            })(overloads[i]);
          }

          result.ok = true;
          notifyHookInstalled(result.count);
        } catch (innerErr) {
          result.error = String(innerErr);
        }
      });
    } catch (outerErr) {
      result.error = String(outerErr);
    }

    return result;
  },

  /**
   * Hook a native function by address.
   *
   * Attaches an interceptor to a native function at the specified address.
   * Accepts address as NativePointer, hex string (e.g., "0x12345"), or number.
   * The callbacks object uses Frida's Interceptor.attach format with onEnter
   * and onLeave callbacks.
   *
   * @param {NativePointer|string|number} address - Function address, symbol name, or NativePointer.
   * @param {object} callbacks - Interceptor callbacks with onEnter(args) and/or onLeave(retval).
   * @returns {{ ok: boolean, error?: string }} Result object.
   *
   * @example
   * ctx.stdlib.hook.native(Module.findExportByName('libc.so', 'open'), {
   *   onEnter: function(args) {
   *     this.path = args[0].readUtf8String();
   *   },
   *   onLeave: function(retval) {
   *     ctx.emit('native.open', { path: this.path, fd: retval.toInt32() });
   *   }
   * });
   */
  native: function (address, callbacks) {
    var result = { ok: false };

    try {
      var targetAddr;

      if (typeof address === 'string') {
        // Check if it looks like a hex address
        if (address.indexOf('0x') === 0 || address.indexOf('0X') === 0) {
          targetAddr = new NativePointer(address);
        } else {
          // Treat as symbol name - try to resolve it
          targetAddr = Module.findExportByName(null, address);
          if (!targetAddr) {
            result.error = 'Symbol not found: ' + address;
            return result;
          }
        }
      } else if (typeof address === 'number') {
        targetAddr = new NativePointer(address);
      } else if (address && typeof address.isNull === 'function') {
        // Already a NativePointer
        targetAddr = address;
      } else {
        result.error = 'Invalid address type: expected NativePointer, string, or number';
        return result;
      }

      // Validate the pointer is not null
      if (targetAddr.isNull()) {
        result.error = 'Address is null';
        return result;
      }

      // Attach the interceptor
      Interceptor.attach(targetAddr, callbacks || {});
      result.ok = true;
      notifyHookInstalled(1);
    } catch (err) {
      result.error = String(err);
    }

    return result;
  },

  /**
   * Register a hook to be called when a class is loaded.
   *
   * First checks if the class is already loaded and calls the callback immediately
   * if so. If not loaded, sets up a class loader hook to detect when the class
   * becomes available. This is useful for hooking classes that are loaded
   * dynamically or by custom class loaders.
   *
   * @param {string} className - Fully qualified class name to watch for.
   * @param {function} callback - Called with class wrapper when class is loaded.
   * @returns {{ ok: boolean, error?: string }} Result object.
   *
   * @example
   * ctx.stdlib.hook.onClassLoad('com.example.DynamicClass', function(cls) {
   *   ctx.emit('class.loaded', { name: 'com.example.DynamicClass' });
   *   cls.secretMethod.implementation = function() {
   *     ctx.emit('secret.called', {});
   *     return this.secretMethod();
   *   };
   * });
   */
  onClassLoad: function (className, callback) {
    var result = { ok: false };
    var callbackInvoked = false;

    try {
      Java.perform(function () {
        try {
          // First, try to load the class directly (it might already be loaded)
          try {
            var existingClass = Java.use(className);
            if (existingClass) {
              callbackInvoked = true;
              try {
                callback(existingClass);
              } catch (cbErr) {
                // Swallow callback errors
              }
              result.ok = true;
              return;
            }
          } catch (notLoadedErr) {
            // Class not loaded yet, continue with class loader monitoring
          }

          // Class not yet loaded - set up monitoring via class loader enumeration
          // We periodically check all class loaders for the target class
          var checkInterval = null;
          var checkCount = 0;
          var maxChecks = 100; // Limit checks to avoid infinite polling

          var tryLoadClass = function () {
            if (callbackInvoked) {
              if (checkInterval) {
                clearInterval(checkInterval);
              }
              return;
            }

            checkCount++;
            if (checkCount > maxChecks) {
              if (checkInterval) {
                clearInterval(checkInterval);
              }
              return;
            }

            var originalLoader = Java.classFactory.loader;
            try {
              Java.enumerateClassLoaders({
                onMatch: function (loader) {
                  if (callbackInvoked) {
                    return;
                  }

                  try {
                    // Try to use this class loader to find the class
                    Java.classFactory.loader = loader;
                    var cls = Java.use(className);
                    if (cls && !callbackInvoked) {
                      callbackInvoked = true;
                      if (checkInterval) {
                        clearInterval(checkInterval);
                      }
                      try {
                        callback(cls);
                      } catch (cbErr) {
                        // Swallow callback errors
                      }
                    }
                  } catch (loaderErr) {
                    // This loader doesn't have the class, continue
                  }
                },
                onComplete: function () {
                  // Done enumerating class loaders for this check
                }
              });
            } finally {
              Java.classFactory.loader = originalLoader;
            }
          };

          // Start periodic checking for the class
          checkInterval = setInterval(function () {
            Java.perform(function () {
              tryLoadClass();
            });
          }, 500);

          // Also do an immediate check
          tryLoadClass();

          result.ok = true;
        } catch (innerErr) {
          result.error = String(innerErr);
        }
      });
    } catch (outerErr) {
      result.error = String(outerErr);
    }

    return result;
  },

  /**
   * Temporarily replace a method implementation.
   *
   * Stores the original implementation of a method and replaces it with the
   * provided replacement function. Returns a cleanup function that, when called,
   * restores the original implementation. This is useful for temporary modifications
   * or for creating reversible hooks.
   *
   * @param {object} classWrapper - Java.use() class wrapper.
   * @param {string} methodName - Method name to replace.
   * @param {function} replacement - Replacement implementation function.
   * @returns {function} Cleanup function that restores the original implementation.
   *
   * @example
   * var cls = Java.use('com.example.App');
   * var restore = ctx.stdlib.hook.replace(cls, 'checkLicense', function() {
   *   return true; // Always return licensed
   * });
   * // Later, restore original behavior:
   * restore();
   */
  replace: function (classWrapper, methodName, replacement) {
    var originalImpl = null;
    var isRestored = false;

    try {
      if (!classWrapper || !classWrapper[methodName]) {
        // Return no-op cleanup if method doesn't exist
        return function () {};
      }

      // Store the original implementation
      // A value of null means the method uses its original Java implementation
      originalImpl = classWrapper[methodName].implementation;

      // Set the replacement implementation
      classWrapper[methodName].implementation = replacement;
      notifyHookInstalled(1);
    } catch (err) {
      // On error, return no-op cleanup
      return function () {};
    }

    // Return cleanup function that restores the original
    return function () {
      if (isRestored) {
        return;
      }

      try {
        // Restore original implementation
        // Setting to null tells Frida to use the original Java method
        classWrapper[methodName].implementation = originalImpl;
        isRestored = true;
      } catch (restoreErr) {
        // Swallow restore errors
      }
    };
  },

  /**
   * Hook a specific method overload by parameter types.
   *
   * Targets a single method overload using its exact parameter type signature,
   * allowing precise hooking when a class has multiple overloads of the same
   * method name. The callback receives the arguments array, an original method
   * wrapper (to call the original implementation), and the 'this' object.
   *
   * @param {string} className - Fully qualified class name.
   * @param {string} methodName - Method name to hook.
   * @param {string[]} paramTypes - Array of fully qualified parameter type names
   *        (e.g., ["java.lang.String", "int"]).
   * @param {object} callbacks - Hook callbacks.
   * @param {function} [callbacks.onEnter] - Called before method execution with (args, originalMethod, thisObj).
   * @param {function} [callbacks.onLeave] - Called after method execution with (retval) wrapper.
   * @returns {{ ok: boolean, error?: string }} Result object.
   *
   * @example
   * ctx.stdlib.hook.methodWithSignature('java.lang.String', 'substring', ['int', 'int'], {
   *   onEnter: function(args, originalMethod, thisObj) {
   *     console.log('substring from', args[0], 'to', args[1]);
   *   },
   *   onLeave: function(retval) {
   *     console.log('result:', retval.value);
   *   }
   * });
   *
   * @example
   * // Calling the original method with modified arguments
   * ctx.stdlib.hook.methodWithSignature('com.example.Crypto', 'encrypt', ['[B', 'java.lang.String'], {
   *   onEnter: function(args, originalMethod, thisObj) {
   *     // Log and optionally modify args before execution
   *     ctx.emit('crypto.encrypt', { keyLength: args[0].length });
   *   },
   *   onLeave: function(retval) {
   *     // Modify return value if needed
   *     // retval.value = modifiedValue;
   *   }
   * });
   */
  methodWithSignature: function (className, methodName, paramTypes, callbacks) {
    var result = { ok: false };

    // Validate paramTypes is an array
    if (!Array.isArray(paramTypes)) {
      result.error = 'paramTypes must be an array of type strings';
      return result;
    }

    try {
      Java.perform(function () {
        try {
          var targetClass = Java.use(className);
          var targetMethod = targetClass[methodName];

          if (!targetMethod) {
            result.error = 'Method not found: ' + className + '.' + methodName;
            return;
          }

          // Get the specific overload using the spread of paramTypes
          var specificOverload;
          try {
            // Use apply to spread the paramTypes array as arguments to overload()
            specificOverload = targetMethod.overload.apply(targetMethod, paramTypes);
          } catch (overloadErr) {
            result.error = 'Overload not found: ' + className + '.' + methodName +
              '(' + paramTypes.join(', ') + '). Error: ' + String(overloadErr);
            return;
          }

          if (!specificOverload) {
            result.error = 'Overload not found: ' + className + '.' + methodName +
              '(' + paramTypes.join(', ') + ')';
            return;
          }

          // Replace the implementation with our wrapper
          specificOverload.implementation = function () {
            // Convert arguments to array
            var args = [];
            for (var i = 0; i < arguments.length; i++) {
              args.push(arguments[i]);
            }

            // Create a shared context for onEnter/onLeave communication
            var hookContext = {};

            // Capture 'this' for the originalMethod wrapper
            var self = this;

            // Create original method wrapper that allows calling the original implementation
            var originalMethod = {
              /**
               * Call the original method with the given context and arguments.
               * @param {object} [thisArg] - The 'this' context (defaults to original this).
               * @param {Array} [argsArray] - Arguments array (defaults to original args).
               * @returns {*} The original method's return value.
               */
              call: function (thisArg, argsArray) {
                var callThis = thisArg || self;
                var callArgs = argsArray || args;
                return specificOverload.call(callThis, callArgs);
              },
              /**
               * Apply the original method with the given context and arguments array.
               * @param {object} [thisArg] - The 'this' context (defaults to original this).
               * @param {Array} [argsArray] - Arguments array (defaults to original args).
               * @returns {*} The original method's return value.
               */
              apply: function (thisArg, argsArray) {
                var callThis = thisArg || self;
                var callArgs = argsArray || args;
                return specificOverload.call(callThis, callArgs);
              }
            };

            // Call onEnter if provided
            if (callbacks && typeof callbacks.onEnter === 'function') {
              try {
                callbacks.onEnter.call(hookContext, args, originalMethod, self);
              } catch (enterErr) {
                // Swallow onEnter errors to avoid breaking the app
              }
            }

            // Call the original method
            var returnValue = specificOverload.call(this, args);

            // Call onLeave if provided
            if (callbacks && typeof callbacks.onLeave === 'function') {
              try {
                var retvalWrapper = { value: returnValue };
                callbacks.onLeave.call(hookContext, retvalWrapper);
                returnValue = retvalWrapper.value;
              } catch (leaveErr) {
                // Swallow onLeave errors to avoid breaking the app
              }
            }

            return returnValue;
          };

          result.ok = true;
          notifyHookInstalled(1);
        } catch (innerErr) {
          result.error = String(innerErr);
        }
      });
    } catch (outerErr) {
      result.error = String(outerErr);
    }

    return result;
  }
  };
}

// ============================================================================
// Safe Execution Utilities
// ============================================================================

/**
 * Safe wrappers that handle exceptions gracefully.
 *
 * Provides functions that wrap potentially failing operations
 * and return structured result objects instead of throwing.
 *
 * @namespace safe
 */
var safe = {
  /**
   * Execute a function in the Java runtime context (Java.perform wrapper).
   *
   * Wraps the provided function in Java.performNow() and catches both
   * JavaScript and Java exceptions, returning a structured result object.
   * Uses performNow for synchronous execution which is simpler for callers.
   *
   * @param {function} fn - Function to execute within Java context.
   * @returns {{ ok: boolean, result?: any, error?: string }} Result object.
   *   - ok: true if execution succeeded, false otherwise
   *   - result: return value from fn if ok is true
   *   - error: error message string if ok is false
   *
   * @example
   * var result = ctx.stdlib.safe.java(function() {
   *   var KeyStore = Java.use('java.security.KeyStore');
   *   return KeyStore.getInstance('AndroidKeyStore');
   * });
   * if (result.ok) {
   *   ctx.emit('keystore', { instance: result.result.toString() });
   * } else {
   *   ctx.log('error', 'Failed: ' + result.error);
   * }
   */
  java: function (fn) {
    // Handle null/undefined function gracefully
    if (fn == null || typeof fn !== 'function') {
      return { ok: false, error: 'Invalid function provided' };
    }

    // Check if Java is available globally (Frida injects this)
    if (typeof Java === 'undefined' || !Java.available) {
      return { ok: false, error: 'Java runtime not available' };
    }

    var outcome = { ok: false, error: null, result: undefined };

    try {
      // Use performNow for synchronous execution within Java context
      // This is idempotent - calling when already in context is safe
      Java.performNow(function () {
        try {
          outcome.result = fn();
          outcome.ok = true;
        } catch (innerErr) {
          // Catch exceptions thrown inside the Java context
          outcome.error = safe._extractErrorMessage(innerErr);
        }
      });
    } catch (outerErr) {
      // Catch exceptions from Java.performNow itself (e.g., Java not ready)
      outcome.error = safe._extractErrorMessage(outerErr);
    }

    return outcome;
  },

  /**
   * Execute a function with try/catch, returning a structured result object.
   *
   * This wrapper ensures that no exceptions propagate to the caller. All
   * errors are captured and returned in the result object.
   *
   * @param {function} fn - Function to execute.
   * @returns {{ ok: boolean, result?: any, error?: string }} Result object.
   *   - ok: true if execution succeeded without throwing
   *   - result: return value from fn if ok is true
   *   - error: error message string if ok is false
   *
   * @example
   * var result = ctx.stdlib.safe.call(function() {
   *   return someRiskyOperation();
   * });
   * if (!result.ok) {
   *   ctx.log('warn', 'Operation failed: ' + result.error);
   * }
   */
  call: function (fn) {
    // Handle null/undefined function gracefully
    if (fn == null || typeof fn !== 'function') {
      return { ok: false, error: 'Invalid function provided' };
    }

    try {
      var result = fn();
      return { ok: true, result: result };
    } catch (err) {
      return { ok: false, error: safe._extractErrorMessage(err) };
    }
  },

  /**
   * Call a method on an object, returning null on any error.
   *
   * Safely invokes a method by name on the given object. If the object is
   * null/undefined, the method doesn't exist, or the call throws, returns null.
   *
   * @param {object} obj - Object to call method on.
   * @param {string} methodName - Method name to invoke.
   * @param {...any} args - Arguments to pass to the method.
   * @returns {any|null} Method return value or null on any error.
   *
   * @example
   * var length = ctx.stdlib.safe.invoke(someString, 'length');
   * var substring = ctx.stdlib.safe.invoke(str, 'substring', 0, 10);
   */
  invoke: function (obj, methodName) {
    // Handle null/undefined object gracefully
    if (obj == null) {
      return null;
    }

    // Validate methodName
    if (methodName == null || typeof methodName !== 'string') {
      return null;
    }

    try {
      var method = obj[methodName];

      // Check if method exists and is callable
      if (typeof method !== 'function') {
        return null;
      }

      // Extract remaining arguments (after obj and methodName)
      var args = [];
      for (var i = 2; i < arguments.length; i++) {
        args.push(arguments[i]);
      }

      // Invoke the method with the collected arguments
      return method.apply(obj, args);
    } catch (err) {
      // Silently return null on any error
      return null;
    }
  },

  /**
   * Get a property/field value, returning defaultValue on any error.
   *
   * Safely accesses a property by key on the given object. Supports nested
   * property access using dot notation (e.g., 'a.b.c'). If any part of the
   * path is null/undefined or access throws, returns the default value.
   *
   * @param {object} obj - Object to read from.
   * @param {string} key - Property/field name or dot-separated path.
   * @param {any} [defaultValue=null] - Value to return on error or missing property.
   * @returns {any} Property value or defaultValue.
   *
   * @example
   * var value = ctx.stdlib.safe.get(config, 'server.port', 8080);
   * var name = ctx.stdlib.safe.get(user, 'profile.name', 'Anonymous');
   */
  get: function (obj, key, defaultValue) {
    // Normalize defaultValue - undefined becomes null
    var defVal = (defaultValue === undefined) ? null : defaultValue;

    // Handle null/undefined object gracefully
    if (obj == null) {
      return defVal;
    }

    // Validate key
    if (key == null || typeof key !== 'string') {
      return defVal;
    }

    try {
      // Support nested property access via dot notation
      var parts = key.split('.');
      var current = obj;

      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];

        // Check if current is null/undefined before accessing
        if (current == null) {
          return defVal;
        }

        current = current[part];
      }

      // Return defaultValue if final value is undefined
      // (but allow null as a valid retrieved value)
      if (current === undefined) {
        return defVal;
      }

      return current;
    } catch (err) {
      // Return default on any error (e.g., getter that throws)
      return defVal;
    }
  },

  /**
   * Execute a function with a timeout, returning error if timeout exceeded.
   *
   * Wraps the function execution in a Promise.race against a timeout timer.
   * If the function completes before the timeout, returns its result. If the
   * timeout fires first, returns an error result.
   *
   * Note: The timeout does NOT cancel the underlying function execution -
   * it only causes the returned Promise to resolve with a timeout error.
   * The function may continue running in the background.
   *
   * @param {function} fn - Function to execute (may be sync or async).
   * @param {number} timeoutMs - Timeout in milliseconds.
   * @returns {Promise<{ ok: boolean, result?: any, error?: string }>} Result promise.
   *   - ok: true if function completed before timeout
   *   - result: return value from fn if ok is true
   *   - error: 'Timeout' if timeout exceeded, or error message if fn threw
   *
   * @example
   * var result = await ctx.stdlib.safe.timeout(function() {
   *   return expensiveOperation();
   * }, 5000);
   * if (!result.ok) {
   *   ctx.log('warn', 'Operation timed out or failed: ' + result.error);
   * }
   */
  timeout: function (fn, timeoutMs) {
    // Handle null/undefined function gracefully
    if (fn == null || typeof fn !== 'function') {
      return Promise.resolve({ ok: false, error: 'Invalid function provided' });
    }

    // Validate timeout value
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0 || !isFinite(timeoutMs)) {
      return Promise.resolve({ ok: false, error: 'Invalid timeout value' });
    }

    // Single promise that races fn() against the timeout and cleans up
    // the timer to avoid leaking setTimeout handles (issue 16.22).
    return new Promise(function (resolve) {
      var timerId = setTimeout(function () {
        timerId = null;
        resolve({ ok: false, error: 'Timeout' });
      }, timeoutMs);

      // Wrap fn execution and resolve/reject handling in a helper so
      // we can clear the timer as soon as the function settles.
      function settle(outcome) {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        resolve(outcome);
      }

      try {
        // Execute the function - handle both sync and async
        var result = fn();

        // Check if result is a Promise/thenable
        if (result != null && typeof result.then === 'function') {
          // Async function - wait for it
          result.then(
            function (value) {
              settle({ ok: true, result: value });
            },
            function (err) {
              settle({ ok: false, error: safe._extractErrorMessage(err) });
            }
          );
        } else {
          // Sync function - resolve immediately
          settle({ ok: true, result: result });
        }
      } catch (err) {
        // Sync function threw
        settle({ ok: false, error: safe._extractErrorMessage(err) });
      }
    });
  },

  /**
   * Safe wrapper around Java.use() that returns null instead of throwing.
   *
   * Avoids try-catch boilerplate in module code by wrapping the class lookup
   * and returning null when the class cannot be found or loaded. This is useful
   * when probing for optional classes that may not exist on all Android versions
   * or device configurations.
   *
   * Note: This function must be called within a Java context (inside Java.perform
   * or Java.performNow). If Java is not available, returns null.
   *
   * @param {string} className - Fully qualified Java class name to load.
   * @returns {object|null} Frida Java.Wrapper for the class if found, or null
   *   if the class does not exist or could not be loaded.
   *
   * @example
   * var Cipher = ctx.stdlib.safe.tryUse('javax.crypto.Cipher');
   * if (Cipher) {
   *   Cipher.getInstance.implementation = function(transformation) {
   *     ctx.emit('crypto', { algorithm: transformation });
   *     return this.getInstance(transformation);
   *   };
   * }
   *
   * @example
   * // Probe for Android version-specific classes
   * var BiometricPrompt = ctx.stdlib.safe.tryUse('android.hardware.biometrics.BiometricPrompt');
   * if (BiometricPrompt) {
   *   // Android 9+ biometric API available
   * }
   */
  tryUse: function (className) {
    // Check if Java runtime is available
    if (typeof Java === 'undefined' || !Java.available) {
      return null;
    }

    // Validate className parameter
    if (className == null || typeof className !== 'string' || className.length === 0) {
      return null;
    }

    try {
      return Java.use(className);
    } catch (err) {
      // Class not found, access denied, class loader issues, or other loading error
      return null;
    }
  },

  /**
   * Extract a meaningful error message from various error types.
   *
   * Handles JavaScript Error objects, Java exceptions (which have different
   * structure via Frida's Java bridge), and arbitrary values that might be thrown.
   *
   * @private
   * @param {any} err - The error value to extract a message from.
   * @returns {string} Human-readable error message.
   */
  _extractErrorMessage: function (err) {
    // Handle null/undefined
    if (err == null) {
      return 'Unknown error (null)';
    }

    // Handle Java exceptions - they often have getMessage() method
    if (typeof err.getMessage === 'function') {
      try {
        var javaMsg = err.getMessage();
        if (javaMsg != null) {
          // Include exception class name if available
          var className = '';
          if (typeof err.getClass === 'function') {
            try {
              className = err.getClass().getName() + ': ';
            } catch (e) {
              // Ignore errors getting class name
            }
          }
          return className + javaMsg;
        }
      } catch (e) {
        // Fall through to other methods
      }
    }

    // Handle standard JavaScript Error objects
    if (err instanceof Error) {
      return err.message || err.toString();
    }

    // Handle objects with message property
    if (typeof err.message === 'string') {
      return err.message;
    }

    // Handle objects with description property (some legacy errors)
    if (typeof err.description === 'string') {
      return err.description;
    }

    // Try toString as last resort
    if (typeof err.toString === 'function') {
      try {
        var str = err.toString();
        if (str !== '[object Object]') {
          return str;
        }
      } catch (e) {
        // Fall through
      }
    }

    // Ultimate fallback
    return 'Unknown error';
  }
};

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Timing utilities for timestamps and duration formatting.
 *
 * Provides functions for generating timestamps, measuring durations,
 * and formatting time values for logging.
 *
 * @namespace time
 */
var time = {
  /**
   * Get current timestamp in ISO 8601 format.
   *
   * @returns {string} ISO timestamp string.
   *
   * @example
   * ctx.emit('event', { ts: ctx.stdlib.time.now() });
   */
  now: function () {
    return new Date().toISOString();
  },

  /**
   * Get current timestamp in milliseconds (epoch).
   *
   * @returns {number} Milliseconds since Unix epoch.
   */
  nowMs: function () {
    return Date.now();
  },

  /**
   * Get high-resolution timestamp for performance measurement.
   *
   * @returns {number} High-resolution timestamp (implementation-dependent).
   */
  hrNow: function () {
    // TODO: Consider using performance.now() if available
    return Date.now();
  },

  /**
   * Format a duration in milliseconds to human-readable string.
   *
   * Formats durations according to these rules:
   * - Under 1000ms: "123ms"
   * - Under 60000ms (1 minute): "1.23s" (with 2 decimal places)
   * - Under 3600000ms (1 hour): "1m 30s"
   * - Over 1 hour: "1h 2m 3s"
   *
   * @param {number} ms - Duration in milliseconds.
   * @returns {string} Formatted string (e.g., "1.23s", "456ms", "1m 30s", "1h 2m 3s").
   *
   * @example
   * ctx.stdlib.time.format(500);      // "500ms"
   * ctx.stdlib.time.format(1234);     // "1.23s"
   * ctx.stdlib.time.format(90000);    // "1m 30s"
   * ctx.stdlib.time.format(3723000);  // "1h 2m 3s"
   *
   * var start = ctx.stdlib.time.nowMs();
   * // ... operation ...
   * var duration = ctx.stdlib.time.format(ctx.stdlib.time.nowMs() - start);
   * ctx.emit('timing', { duration: duration });
   */
  format: function (ms) {
    // Handle invalid input gracefully
    if (typeof ms !== 'number' || !isFinite(ms)) {
      return '0ms';
    }

    // Handle negative values (treat as absolute value)
    var duration = Math.abs(ms);

    // Constants for time units
    var MS_PER_SECOND = 1000;
    var MS_PER_MINUTE = 60000;
    var MS_PER_HOUR = 3600000;

    // Under 1 second: show milliseconds
    if (duration < MS_PER_SECOND) {
      return Math.round(duration) + 'ms';
    }

    // Under 1 minute: show seconds with 2 decimal places
    if (duration < MS_PER_MINUTE) {
      var seconds = duration / MS_PER_SECOND;
      return seconds.toFixed(2) + 's';
    }

    // Under 1 hour: show minutes and seconds
    if (duration < MS_PER_HOUR) {
      var totalSeconds = Math.floor(duration / MS_PER_SECOND);
      var mins = Math.floor(totalSeconds / 60);
      var secs = totalSeconds % 60;
      if (secs === 0) {
        return mins + 'm';
      }
      return mins + 'm ' + secs + 's';
    }

    // 1 hour or more: show hours, minutes, and seconds
    var totalSecs = Math.floor(duration / MS_PER_SECOND);
    var hours = Math.floor(totalSecs / 3600);
    var remainingSecs = totalSecs % 3600;
    var minutes = Math.floor(remainingSecs / 60);
    var finalSecs = remainingSecs % 60;

    // Build the formatted string, omitting zero values where appropriate
    var parts = [];
    parts.push(hours + 'h');
    if (minutes > 0 || finalSecs > 0) {
      parts.push(minutes + 'm');
    }
    if (finalSecs > 0) {
      parts.push(finalSecs + 's');
    }

    return parts.join(' ');
  },

  /**
   * Create a stopwatch for measuring elapsed time.
   *
   * @returns {{ elapsed: function(): number, elapsedFormatted: function(): string, reset: function(): void }}
   *
   * @example
   * var sw = ctx.stdlib.time.stopwatch();
   * // ... operation ...
   * ctx.emit('timing', { elapsed: sw.elapsedFormatted() });
   */
  stopwatch: function () {
    var start = Date.now();
    return {
      elapsed: function () {
        return Date.now() - start;
      },
      elapsedFormatted: function () {
        return time.format(Date.now() - start);
      },
      reset: function () {
        start = Date.now();
      }
    };
  },

  /**
   * Sleep for the specified duration (alias for ctx.sleep).
   *
   * @param {number} ms - Milliseconds to sleep.
   * @returns {Promise<void>}
   */
  sleep: function (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  },

  /**
   * Execute a function and measure its wall-clock execution time.
   *
   * Synchronously invokes the provided function and returns both its result
   * and the duration in milliseconds. Useful for performance profiling of
   * synchronous operations within instrumentation code.
   *
   * @param {function(): T} fn - The function to execute and measure.
   * @returns {{ result: T, durationMs: number }} Object containing the function's
   *   return value and the execution duration in milliseconds.
   * @template T
   *
   * @example
   * var m = ctx.stdlib.time.measure(function() {
   *   return heavyOperation();
   * });
   * ctx.emit('perf', { duration: m.durationMs });
   * // Use m.result for the return value
   *
   * @example
   * // Measure and log a class enumeration
   * var measurement = ctx.stdlib.time.measure(function() {
   *   return ctx.stdlib.classes.find(/^com\.example\./);
   * });
   * ctx.emit('classes.found', {
   *   count: measurement.result.length,
   *   durationMs: measurement.durationMs
   * });
   */
  measure: function (fn) {
    var start = Date.now();
    var result = fn();
    var end = Date.now();
    return {
      result: result,
      durationMs: end - start
    };
  },

  /**
   * Create a debounced version of a function.
   *
   * Returns a wrapper function that delays invocation of the provided function
   * until after `delayMs` milliseconds have elapsed since the last call to the
   * wrapper. Useful for rate-limiting high-frequency events like rapid method
   * calls or UI interactions.
   *
   * @param {function(...*): void} fn - The function to debounce.
   * @param {number} delayMs - The delay in milliseconds to wait after the last call.
   * @returns {function(...*): void} A debounced wrapper function that accepts the
   *   same arguments as the original function.
   *
   * @example
   * var debouncedLog = ctx.stdlib.time.debounce(function(msg) {
   *   console.log(msg);
   * }, 100);
   * // Rapid calls will only execute once, 100ms after the last call
   * debouncedLog('first');
   * debouncedLog('second');
   * debouncedLog('third'); // Only this one executes after 100ms
   *
   * @example
   * // Debounce event emission for high-frequency hooks
   * var debouncedEmit = ctx.stdlib.time.debounce(function(data) {
   *   ctx.emit('network.activity', data);
   * }, 500);
   */
  debounce: function (fn, delayMs) {
    var timeoutId = null;
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var self = this;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(function () {
        timeoutId = null;
        fn.apply(self, args);
      }, delayMs);
    };
  },

  /**
   * Create a throttled version of a function.
   *
   * Returns a wrapper function that invokes the provided function at most once
   * per `intervalMs` milliseconds. The first call executes immediately, and
   * subsequent calls within the interval are ignored. Useful for limiting the
   * rate of expensive operations like emitting events or logging.
   *
   * @param {function(...*): void} fn - The function to throttle.
   * @param {number} intervalMs - The minimum interval in milliseconds between invocations.
   * @returns {function(...*): void} A throttled wrapper function that accepts the
   *   same arguments as the original function.
   *
   * @example
   * var throttledEmit = ctx.stdlib.time.throttle(function(data) {
   *   ctx.emit('data', data);
   * }, 1000);
   * // Only emits once per second, even if called more frequently
   *
   * @example
   * // Throttle logging for high-frequency method hooks
   * var throttledLog = ctx.stdlib.time.throttle(function(methodName, args) {
   *   console.log('Called: ' + methodName + ' with ' + args.length + ' args');
   * }, 200);
   */
  throttle: function (fn, intervalMs) {
    var lastExecutionTime = 0;
    return function () {
      var now = Date.now();
      if (now - lastExecutionTime >= intervalMs) {
        lastExecutionTime = now;
        fn.apply(this, arguments);
      }
    };
  }
};

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a stdlib instance with access to the Java bridge.
 *
 * This factory function initializes the stdlib with the provided Java bridge,
 * enabling all Java-dependent utilities to function correctly.
 *
 * @param {object} javaBridge - The Java bridge object (from frida-java-bridge).
 * @returns {object} Configured stdlib object with all namespaces.
 *
 * @example
 * var stdlib = createStdlib(Java);
 * var trace = stdlib.stack.toString();
 *
 * @example
 * // With metrics callback for hook tracking
 * var stdlib = createStdlib(Java, { onHookInstalled: function(count) { metrics.hooks_installed += count; } });
 */
function createStdlib(javaBridge, options) {
  // Store reference to Java bridge for internal use
  var _java = javaBridge;

  // Extract options with defaults
  var opts = options || {};
  var onHookInstalled = typeof opts.onHookInstalled === 'function' ? opts.onHookInstalled : null;

  /**
   * Internal helper to check if Java is available.
   * @returns {boolean}
   */
  function isJavaAvailable() {
    return !!(_java && _java.available);
  }

  /**
   * Internal helper to require Java availability.
   * @param {string} operation - Name of operation requiring Java.
   * @throws {Error} If Java is not available.
   * @returns {object} Java bridge.
   */
  function requireJava(operation) {
    if (!isJavaAvailable()) {
      throw new Error('Java is not available for operation: ' + operation);
    }
    return _java;
  }

  // Create Java-aware namespace instances
  var stackNamespace = createStackNamespace(_java);
  var inspectNamespace = createInspectNamespace(_java);
  var classesNamespace = createClassesNamespace(_java);
  var hookNamespace = createHookNamespace(onHookInstalled);

  // Return the stdlib object with all namespaces
  // Each namespace retains access to _java and helpers via closure
  return {
    /**
     * Stack trace capture and formatting utilities.
     * @type {object}
     */
    stack: stackNamespace,

    /**
     * Object introspection and type discovery utilities.
     * @type {object}
     */
    inspect: inspectNamespace,

    /**
     * Java class enumeration and loading utilities.
     * @type {object}
     */
    classes: classesNamespace,

    /**
     * Binary data manipulation utilities.
     * @type {object}
     */
    bytes: bytes,

    /**
     * String manipulation and encoding utilities.
     * @type {object}
     */
    strings: strings,

    /**
     * Android Intent parsing and construction utilities.
     * @type {object}
     */
    intent: intent,

    /**
     * Hook installation helpers and common patterns.
     * @type {object}
     */
    hook: hookNamespace,

    /**
     * Safe wrappers that handle exceptions gracefully.
     * @type {object}
     */
    safe: safe,

    /**
     * Timing utilities for timestamps and duration formatting.
     * @type {object}
     */
    time: time,

    /**
     * Check if Java runtime is available.
     * @returns {boolean} True if Java APIs can be used.
     */
    isJavaAvailable: isJavaAvailable,

    /**
     * Get the Java bridge reference.
     * @returns {object|null} Java bridge or null if unavailable.
     */
    getJavaBridge: function () {
      return _java;
    },

    /**
     * Require Java availability, throwing if not present.
     * @param {string} [operation] - Operation name for error message.
     * @returns {object} Java bridge.
     * @throws {Error} If Java is not available.
     */
    requireJava: requireJava
  };
}

// ============================================================================
// Module Exports
// ============================================================================

// ES6 export for frida-compile bundling (used by jobScriptRuntime.entry.ts)
export { createStdlib };

// Also expose globally for direct script access
if (typeof globalThis !== 'undefined') {
  globalThis.__kahloStdlib = {
    createStdlib: createStdlib
  };
}
