/**
 * Typed accessors over a Vite `import.meta.env` bag, with validation.
 *
 * Deliberately takes the environment as an argument rather than reading
 * `import.meta.env` itself. That keeps the package testable in Node, keeps it
 * out of the way of Vite's compile time string replacement, and lets an
 * application pass a merged bag when it needs to.
 */

/** The subset of `import.meta.env` this package relies on. */
export interface ViteEnv {
  MODE?: string | undefined;
  DEV?: boolean | undefined;
  PROD?: boolean | undefined;
  BASE_URL?: string | undefined;
  [key: string]: unknown;
}

/** Raised when required configuration is missing or malformed. */
export class ConfigError extends Error {
  /** Every problem found, not just the first. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid application configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`
    );
    this.name = 'ConfigError';
    this.issues = issues;
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/** Collects issues so startup reports every problem in one pass. */
export class ConfigReader {
  private readonly env: ViteEnv;
  private readonly issues: string[] = [];

  constructor(env: ViteEnv) {
    this.env = env;
  }

  private raw(key: string): string | undefined {
    const value = this.env[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    const asString = String(value).trim();
    return asString === '' ? undefined : asString;
  }

  /** Reads a required string. Records an issue when absent. */
  string(key: string): string {
    const value = this.raw(key);
    if (value === undefined) {
      this.issues.push(`${key} is required but was not set`);
      return '';
    }
    return value;
  }

  /** Reads an optional string, falling back to `fallback`. */
  optionalString(key: string, fallback: string): string {
    return this.raw(key) ?? fallback;
  }

  /**
   * Reads a URL. Accepts an absolute URL or a root relative path.
   *
   * The relative form is not a loophole: both applications legitimately use
   * `/api` in local development, where the Vite dev server proxies it to the
   * backend, and in production where the SPA and the API sit behind one
   * CloudFront distribution.
   */
  url(key: string, options: { required?: boolean; fallback?: string } = {}): string {
    const value = this.raw(key) ?? options.fallback;
    if (value === undefined) {
      if (options.required !== false) {
        this.issues.push(`${key} is required but was not set`);
      }
      return '';
    }
    if (value.startsWith('/')) {
      return value.replace(/\/+$/, '') === '' ? '/' : value.replace(/\/+$/, '');
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      this.issues.push(
        `${key} must be an absolute URL or a root relative path, got "${value}"`
      );
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.issues.push(
        `${key} must use http or https, got "${parsed.protocol}"`
      );
      return '';
    }
    return value.replace(/\/+$/, '');
  }

  /** Reads a boolean. Accepts true/false, 1/0, yes/no, on/off. */
  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw(key);
    if (value === undefined) {
      return fallback;
    }
    const lowered = value.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(lowered)) {
      return false;
    }
    this.issues.push(`${key} must be a boolean, got "${value}"`);
    return fallback;
  }

  /** Reads a value constrained to a fixed set. */
  oneOf<const T extends readonly string[]>(
    key: string,
    allowed: T,
    fallback?: T[number]
  ): T[number] {
    const value = this.raw(key) ?? fallback;
    if (value === undefined) {
      this.issues.push(`${key} is required but was not set`);
      return allowed[0] as T[number];
    }
    if (!allowed.includes(value)) {
      this.issues.push(
        `${key} must be one of ${allowed.join(', ')}, got "${value}"`
      );
      return allowed[0] as T[number];
    }
    return value as T[number];
  }

  /** Records a problem a caller detected itself. */
  addIssue(issue: string): void {
    this.issues.push(issue);
  }

  /** Throws when anything failed. Call once, after reading every key. */
  assertValid(): void {
    if (this.issues.length > 0) {
      throw new ConfigError([...this.issues]);
    }
  }
}
