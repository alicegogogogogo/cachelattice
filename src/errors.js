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

// Verification cannot even be attempted: no successful run to check against,
// or a cache entry that is missing or fails its address checks.
export class VerificationUnavailableError extends CachelatticeError {
  constructor(message) {
    super('verification_unavailable', message, 409);
  }
}

// The cache read fine, but re-executing a frozen action produced different
// bytes. The mismatches ride along as structured details.
export class ReproducibilityMismatchError extends CachelatticeError {
  constructor(message, mismatches) {
    super('reproducibility_mismatch', message, 422);
    this.details = { mismatches };
  }
}
