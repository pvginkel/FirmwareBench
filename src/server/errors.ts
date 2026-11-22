// The agent API's errors. Every failure answers a non-2xx status with
// `{"error": <code>, "message": ...}`, so `curl -f` fails on it.

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'no_holder'
  | 'port_not_open'
  | 'busy'
  | 'bad_build_dir'
  | 'wrong_chip'
  | 'flash_failed'
  | 'reset_failed'
  | 'console_failed'
  | 'timed_out';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  bad_build_dir: 400,
  not_found: 404,
  busy: 409,
  wrong_chip: 422,
  flash_failed: 502,
  reset_failed: 502,
  console_failed: 502,
  no_holder: 503,
  port_not_open: 503,
  timed_out: 504,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }

  get status(): number {
    return STATUS[this.code] ?? 500;
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

const CODES = new Set<string>(Object.keys(STATUS));

export function isApiErrorCode(code: unknown): code is ApiErrorCode {
  return typeof code === 'string' && CODES.has(code);
}
