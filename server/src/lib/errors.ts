export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);
export const limitReached = (msg: string, details?: unknown) => new AppError(402, 'limit_reached', msg, details);
export const notConfigured = (msg: string, details?: unknown) => new AppError(409, 'not_configured', msg, details);
export const tooMany = (msg = 'Too many requests. Please slow down.') => new AppError(429, 'rate_limited', msg);
