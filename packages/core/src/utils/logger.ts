// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Configurable logging system for MOQT library
 *
 * Provides a hierarchical logging system with multiple levels and
 * namespace-based filtering. Supports both console output and custom
 * log handlers for integration with external logging systems.
 *
 * @example
 * ```typescript
 * // Configure global log level
 * Logger.setLevel(LogLevel.DEBUG);
 *
 * // Create a logger for a specific module
 * const log = Logger.create('moqt:transport');
 * log.debug('Connection established', { url: 'https://...' });
 * log.info('Stream opened', { streamId: 123 });
 * log.warn('Buffer nearly full', { usage: 0.9 });
 * log.error('Connection failed', new Error('timeout'));
 * ```
 */

/**
 * Log levels in ascending order of severity.
 * Each level includes all levels above it.
 */
export enum LogLevel {
  /** Verbose debugging information */
  TRACE = 0,
  /** Detailed debugging information */
  DEBUG = 1,
  /** General informational messages */
  INFO = 2,
  /** Warning messages for potentially harmful situations */
  WARN = 3,
  /** Error messages for serious problems */
  ERROR = 4,
  /** No logging output */
  SILENT = 5,
}

/**
 * Log entry structure for custom handlers
 */
export interface LogEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Severity level of the log */
  level: LogLevel;
  /** Logger namespace (e.g., 'moqt:transport:stream') */
  namespace: string;
  /** Log message */
  message: string;
  /** Optional additional data */
  data?: unknown;
  /** Optional error object */
  error?: Error;
}

/**
 * Custom log handler function type
 */
export type LogHandler = (entry: LogEntry) => void;

/**
 * Configuration options for Logger
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel;
  /** Enable colored console output (default: true in browsers) */
  colors: boolean;
  /** Enable timestamp prefix (default: true) */
  timestamps: boolean;
  /** Custom log handler for external integration */
  handler?: LogHandler;
  /** Namespace patterns to include (supports wildcards) */
  include?: string[];
  /** Namespace patterns to exclude (supports wildcards) */
  exclude?: string[];
}

/**
 * Default configuration
 */
const defaultConfig: LoggerConfig = {
  level: LogLevel.INFO,
  colors: typeof window !== 'undefined',
  timestamps: true,
};

/**
 * Global configuration state
 */
let globalConfig: LoggerConfig = { ...defaultConfig };

/**
 * Console colors for different log levels
 */
const levelColors: Record<LogLevel, string> = {
  [LogLevel.TRACE]: '#9E9E9E',
  [LogLevel.DEBUG]: '#2196F3',
  [LogLevel.INFO]: '#4CAF50',
  [LogLevel.WARN]: '#FF9800',
  [LogLevel.ERROR]: '#F44336',
  [LogLevel.SILENT]: '',
};

/**
 * Level labels for output
 */
const levelLabels: Record<LogLevel, string> = {
  [LogLevel.TRACE]: 'TRACE',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.SILENT]: '',
};

/**
 * Check if a namespace matches a pattern (supports * wildcard)
 *
 * @param namespace - The namespace to check
 * @param pattern - The pattern to match against
 * @returns True if the namespace matches the pattern
 */
function matchPattern(namespace: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return namespace.startsWith(pattern.slice(0, -1));
  }
  return namespace === pattern;
}

/**
 * Check if a namespace should be logged based on include/exclude patterns
 *
 * @param namespace - The namespace to check
 * @returns True if the namespace should be logged
 */
function shouldLog(namespace: string): boolean {
  const { include, exclude } = globalConfig;

  // If exclude patterns exist and match, skip logging
  if (exclude?.some(pattern => matchPattern(namespace, pattern))) {
    return false;
  }

  // If include patterns exist, only log if matched
  if (include && include.length > 0) {
    return include.some(pattern => matchPattern(namespace, pattern));
  }

  return true;
}

/**
 * Format timestamp for log output
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted timestamp string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().slice(11, 23); // HH:mm:ss.SSS
}

/**
 * Logger class for namespace-based logging
 *
 * @remarks
 * Create logger instances using `Logger.create()` for each module.
 * Configure global settings using static methods on the Logger class.
 *
 * @example
 * ```typescript
 * // In a module
 * const log = Logger.create('moqt:core:messages');
 *
 * // Use the logger
 * log.trace('Encoding message', { type: 'SUBSCRIBE' });
 * log.debug('Message encoded', { bytes: 42 });
 * log.info('Subscription created', { trackId: 'video' });
 * log.warn('Slow encoding detected', { duration: 100 });
 * log.error('Encoding failed', new Error('Invalid message'));
 * ```
 */
export class Logger {
  private readonly namespace: string;

  /**
   * Create a new Logger instance
   *
   * @param namespace - Logger namespace for filtering and identification
   * @private Use Logger.create() instead
   */
  private constructor(namespace: string) {
    this.namespace = namespace;
  }

  /**
   * Create a new logger instance for a specific namespace
   *
   * @param namespace - Hierarchical namespace (e.g., 'moqt:transport:stream')
   * @returns New Logger instance
   *
   * @example
   * ```typescript
   * const log = Logger.create('moqt:transport');
   * const childLog = Logger.create('moqt:transport:stream');
   * ```
   */
  static create(namespace: string): Logger {
    return new Logger(namespace);
  }

  /**
   * Set the global minimum log level
   *
   * @param level - Minimum level to output (messages below this level are suppressed)
   *
   * @example
   * ```typescript
   * // Show only warnings and errors
   * Logger.setLevel(LogLevel.WARN);
   *
   * // Show everything including trace
   * Logger.setLevel(LogLevel.TRACE);
   *
   * // Disable all logging
   * Logger.setLevel(LogLevel.SILENT);
   * ```
   */
  static setLevel(level: LogLevel): void {
    globalConfig.level = level;
  }

  /**
   * Get the current global log level
   *
   * @returns Current minimum log level
   */
  static getLevel(): LogLevel {
    return globalConfig.level;
  }

  /**
   * Configure the logger with multiple options
   *
   * @param config - Partial configuration to merge with current settings
   *
   * @example
   * ```typescript
   * Logger.configure({
   *   level: LogLevel.DEBUG,
   *   colors: false,
   *   timestamps: true,
   *   include: ['moqt:transport:*'],
   *   exclude: ['moqt:transport:heartbeat'],
   * });
   * ```
   */
  static configure(config: Partial<LoggerConfig>): void {
    globalConfig = { ...globalConfig, ...config };
  }

  /**
   * Reset configuration to defaults
   */
  static reset(): void {
    globalConfig = { ...defaultConfig };
  }

  /**
   * Set a custom log handler for external integration
   *
   * @param handler - Function to receive all log entries
   *
   * @example
   * ```typescript
   * // Send logs to an external service
   * Logger.setHandler((entry) => {
   *   fetch('/api/logs', {
   *     method: 'POST',
   *     body: JSON.stringify(entry),
   *   });
   * });
   * ```
   */
  static setHandler(handler: LogHandler | undefined): void {
    globalConfig.handler = handler;
  }

  /**
   * Create a child logger with an extended namespace
   *
   * @param suffix - Suffix to append to current namespace
   * @returns New Logger with extended namespace
   *
   * @example
   * ```typescript
   * const parentLog = Logger.create('moqt:transport');
   * const childLog = parentLog.child('stream');
   * // childLog namespace: 'moqt:transport:stream'
   * ```
   */
  child(suffix: string): Logger {
    return new Logger(`${this.namespace}:${suffix}`);
  }

  /**
   * Log a trace-level message (most verbose)
   *
   * @param message - Log message
   * @param data - Optional additional data
   */
  trace(message: string, data?: unknown): void {
    this.log(LogLevel.TRACE, message, data);
  }

  /**
   * Log a debug-level message
   *
   * @param message - Log message
   * @param data - Optional additional data
   */
  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * Log an info-level message
   *
   * @param message - Log message
   * @param data - Optional additional data
   */
  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * Log a warning-level message
   *
   * @param message - Log message
   * @param data - Optional additional data or Error
   */
  warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * Log an error-level message
   *
   * @param message - Log message
   * @param error - Optional Error object or additional data
   */
  error(message: string, error?: Error | unknown): void {
    this.log(LogLevel.ERROR, message, error);
  }

  /**
   * Internal logging implementation
   *
   * @param level - Log level
   * @param message - Log message
   * @param data - Optional data or error
   */
  private log(level: LogLevel, message: string, data?: unknown): void {
    // Check if this level should be logged
    if (level < globalConfig.level) return;

    // Check namespace filtering
    if (!shouldLog(this.namespace)) return;

    const timestamp = Date.now();
    const entry: LogEntry = {
      timestamp,
      level,
      namespace: this.namespace,
      message,
      data: data instanceof Error ? undefined : data,
      error: data instanceof Error ? data : undefined,
    };

    // Call custom handler if set
    if (globalConfig.handler) {
      globalConfig.handler(entry);
    }

    // Output to console
    this.consoleOutput(entry);
  }

  /**
   * Output log entry to console
   *
   * @param entry - Log entry to output
   */
  private consoleOutput(entry: LogEntry): void {
    const { level, message, data, error } = entry;
    const label = levelLabels[level];

    // Build prefix parts
    const parts: string[] = [];
    if (globalConfig.timestamps) {
      parts.push(formatTimestamp(entry.timestamp));
    }
    parts.push(`[${label}]`);
    parts.push(`[${this.namespace}]`);

    const prefix = parts.join(' ');

    // Select console method
    const consoleFn = level === LogLevel.ERROR ? console.error
      : level === LogLevel.WARN ? console.warn
      : level === LogLevel.DEBUG || level === LogLevel.TRACE ? console.debug
      : console.log;

    // Output with or without colors
    if (globalConfig.colors && typeof window !== 'undefined') {
      const color = levelColors[level];
      const style = `color: ${color}; font-weight: bold`;

      if (error) {
        consoleFn(`%c${prefix}`, style, message, error);
      } else if (data !== undefined) {
        consoleFn(`%c${prefix}`, style, message, data);
      } else {
        consoleFn(`%c${prefix}`, style, message);
      }
    } else {
      if (error) {
        consoleFn(prefix, message, error);
      } else if (data !== undefined) {
        consoleFn(prefix, message, data);
      } else {
        consoleFn(prefix, message);
      }
    }
  }
}

/**
 * Convenience function to create a logger
 * Alias for Logger.create()
 *
 * @param namespace - Logger namespace
 * @returns New Logger instance
 */
export function createLogger(namespace: string): Logger {
  return Logger.create(namespace);
}
