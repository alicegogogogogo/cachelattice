export class CachelatticeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'CachelatticeError';
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends CachelatticeError {
  constructor(message) {
    super('validation_error', message, 400);
  }
}

export class ExecutionError extends CachelatticeError {
  constructor(message) {
    super('action_failed', message, 400);
  }
}

export class NotFoundError extends CachelatticeError {
  constructor(message) {
    super('not_found', message, 404);
  }
}

export class ConflictError extends CachelatticeError {
  constructor(message) {
    super('conflict', message, 409);
  }
}
