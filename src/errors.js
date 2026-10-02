export class CachelatticeError extends Error {
  constructor(code, message, status, details = undefined) {
    super(message);
    this.name = 'CachelatticeError';
    this.code = code;
    this.status = status;
    this.details = details;
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

// Verification could not be performed at all: the graph never ran, a cached
// manifest or artifact could not be located or validated, or a node could not
// be re-executed. Nothing partial is returned in this case.
export class VerificationUnavailableError extends CachelatticeError {
  constructor(message) {
    super('verification_unavailable', message, 409);
  }
}

// Verification ran to completion but at least one node's recomputed bytes no
// longer match what the cache holds. Every divergence is carried in
// details.mismatches, sorted by node id.
export class ReproducibilityMismatchError extends CachelatticeError {
  constructor(mismatches) {
    super(
      'reproducibility_mismatch',
      `verification found ${mismatches.length} node(s) whose recomputed bytes differ from the cache`,
      422,
      { mismatches },
    );
  }
}
