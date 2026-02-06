/**
 * Retro-styled terminal logger for kahlo-mcp.
 *
 * Provides ANSI-colored, structured output with ASCII art and box-drawing
 * characters for visual appeal and debugging clarity.
 */

/** ANSI escape codes for colors and styles. */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  
  // Retro color palette
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

/** Box-drawing characters for structured output. */
const BOX = {
  topLeft: "╔",
  topRight: "╗",
  bottomLeft: "╚",
  bottomRight: "╝",
  horizontal: "═",
  vertical: "║",
  verticalRight: "╠",
  verticalLeft: "╣",
  horizontalDown: "╦",
  horizontalUp: "╩",
} as const;

/** Log level type (matches config schema). */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * ASCII art banner for kahlo-mcp startup.
 * Inspired by Frida Kahlo's artistic legacy and Frida instrumentation framework.
 */
function renderBanner(): string {
  const banner = [
    `${ANSI.magenta}${ANSI.bold}` +
    "  ┓   ┓ ┓          ",
    "  ┃┏┏┓┣┓┃┏┓━━┏┳┓┏┏┓",
    "  ┛┗┗┻┛┗┗┗┛  ┛┗┗┗┣┛",
    "                 ┛ ",
    `${ANSI.reset}${ANSI.dim}${ANSI.white}`,
    "              ~b33f" +
    `${ANSI.reset}`,
  ].join("\n");
  
  return banner;
}

/**
 * Strip ANSI escape codes from a string to get its display length.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render a boxed section header with dynamic width based on content.
 */
function renderBox(title: string, content: string[], color: string = ANSI.cyan): string {
  const lines: string[] = [];
  
  // We define `innerWidth` as the number of characters between the vertical
  // borders. Each content line is rendered as:
  //
  //   ║␠<content><pad>␠║
  //
  // So we need `innerWidth >= contentLen + 2` (for the two spaces).
  const titleText = ` ${title} `;
  const maxContentLen = content.reduce((max, line) => {
    const len = stripAnsi(line).length;
    return len > max ? len : max;
  }, 0);
  const innerWidth = Math.max(maxContentLen + 2, titleText.length);
  
  // Top border with centered title
  const titleLen = titleText.length;
  const remainingWidth = innerWidth - titleLen;
  const leftPad = Math.floor(remainingWidth / 2);
  const rightPad = remainingWidth - leftPad;
  
  lines.push(
    `${color}${BOX.topLeft}${BOX.horizontal.repeat(leftPad)}${ANSI.bold}${titleText}${ANSI.reset}${color}${BOX.horizontal.repeat(rightPad)}${BOX.topRight}${ANSI.reset}`
  );
  
  // Content lines (strip ANSI from length calculation)
  for (const line of content) {
    const plainLine = stripAnsi(line);
    const padding = Math.max(0, innerWidth - (plainLine.length + 2));
    lines.push(
      `${color}${BOX.vertical}${ANSI.reset} ${line}${" ".repeat(padding)} ${color}${BOX.vertical}${ANSI.reset}`
    );
  }
  
  // Bottom border
  lines.push(
    `${color}${BOX.bottomLeft}${BOX.horizontal.repeat(innerWidth)}${BOX.bottomRight}${ANSI.reset}`
  );
  
  return lines.join("\n");
}

/**
 * Format a timestamp in retro style.
 */
function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${ANSI.dim}${ANSI.gray}${h}:${m}:${s}.${ms}${ANSI.reset}`;
}

/**
 * Get visual indicator for log level.
 */
function getLevelIndicator(level: LogLevel): string {
  switch (level) {
    case "debug":
      return `${ANSI.dim}${ANSI.blue}[DEBUG]${ANSI.reset}`;
    case "info":
      return `${ANSI.cyan}[INFO ]${ANSI.reset}`;
    case "warn":
      return `${ANSI.yellow}[WARN ]${ANSI.reset}`;
    case "error":
      return `${ANSI.red}[ERROR]${ANSI.reset}`;
  }
}

/**
 * Logger instance with configurable minimum level.
 */
export class Logger {
  private minLevel: LogLevel;
  
  constructor(minLevel: LogLevel = "info") {
    this.minLevel = minLevel;
  }
  
  /**
   * Print the startup banner with system information.
   */
  printBanner(info: { transport: string; dataDir: string }): void {
    const output: string[] = [];
    
    output.push("");
    output.push(renderBanner());
    output.push("");
    
    const configLines = [
      `${ANSI.cyan}transport${ANSI.reset}  ${ANSI.white}${info.transport}${ANSI.reset}`,
      `${ANSI.cyan}data-dir${ANSI.reset}   ${ANSI.dim}${info.dataDir}${ANSI.reset}`,
    ];
    output.push(renderBox("CONFIGURATION", configLines, ANSI.magenta));
    output.push("");
    output.push(`  ${ANSI.green}${ANSI.bold}◆${ANSI.reset} ${ANSI.green}Server ready${ANSI.reset} ${ANSI.dim}(listening on stdio)${ANSI.reset}`);
    output.push("");
    
    // Write to stderr to keep stdout reserved for MCP traffic
    process.stderr.write(output.join("\n"));
  }
  
  /**
   * Log a message at the specified level.
   */
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }
    
    const parts = [
      formatTimestamp(),
      getLevelIndicator(level),
      message,
    ];
    
    if (meta && Object.keys(meta).length > 0) {
      parts.push(
        `${ANSI.dim}${JSON.stringify(meta)}${ANSI.reset}`
      );
    }
    
    process.stderr.write(parts.join(" ") + "\n");
  }
  
  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }
  
  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }
  
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }
  
  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }
}
