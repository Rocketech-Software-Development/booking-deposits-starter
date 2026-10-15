export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 500 | 502;

/** An error that is safe to show to the API caller. */
export class AppError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const forbidden = () => new AppError(403, 'forbidden', 'You cannot access this resource');
