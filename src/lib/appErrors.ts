// User-facing errors thrown by lib code carry a stable `code` (plus params);
// the UI turns the code into text with errorMessage() from src/i18n/errors.ts.
// The `message` stays today's English text, for logs and existing callers.
// No imports.

export type AppErrorCode =
  | 'category-name-required'
  | 'category-exists'
  | 'category-not-found'
  | 'invalid-currency'
  | 'category-used-by-expenses'
  | 'category-used-by-income'
  | 'category-used-by-recurring'
  | 'recurring-not-found'
  | 'occurrence-not-due'
  | 'validation'
  | 'import-needs-categories'
  | 'import-empty-file'
  | 'import-unknown-columns'
  | 'move-same-space'
  | 'move-too-many'

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly params: Record<string, string | number>

  constructor(
    code: AppErrorCode,
    message: string,
    params: Record<string, string | number> = {},
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.params = params
  }
}

export function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true
  return (
    err instanceof Error &&
    err.name === 'AppError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}
