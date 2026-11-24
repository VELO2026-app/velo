/**
 * The crash detector's contract types, kept in a module of their own (FE-238).
 *
 * allowlist.ts (the detector's global entries) needs the CrashAllowance type,
 * and crashes.ts imports allowlist's GLOBAL_ALLOWLIST back -- so the type
 * cannot live in either file without an import cycle:
 * allowlist -> crashes -> allowlist. Both import it from here instead;
 * crashes.ts re-exports the trio under its own name for its consumers.
 */

/** A Playwright engine, as `browserType().name()` names it. */
export type BrowserName = 'chromium' | 'firefox' | 'webkit'

/** An API answer a test expects (method, path pattern, status). */
export interface AllowedApi {
  method: string
  path: RegExp
  status: number
}

/**
 * Exceptions to the detector. `reason` is mandatory: it names the known
 * defect or why the answer is a normal outcome for this test.
 */
export interface CrashAllowance {
  reason: string
  /**
   * FE-188: the engines this allowance applies in; absent -- every engine.
   * For what one engine prints and the others never do (a browser warning
   * about our own markup): the same text from another engine stays a signal.
   * A page whose engine cannot be read (no browser object) gets no
   * engine-scoped allowance.
   */
  browsers?: BrowserName[]
  /** console.error texts to ignore. */
  console?: RegExp[]
  /** 4xx/5xx API answers to ignore. */
  api?: AllowedApi[]
  /** Visible error markers to ignore -- for tests of an error screen itself. */
  screen?: Array<'screen-error' | 'not-found'>
  /** Uncaught or reported error messages to ignore. */
  errors?: RegExp[]
}
