export class SessionState {
  constructor({ id, stopThreshold = 2 } = {}) {
    this.id = id || `session-${Date.now()}`;
    this.stopThreshold = stopThreshold;
    this.failures = new Map();
    this.authorizations = new Set();
  }

  authorize(scope) {
    this.authorizations.add(scope);
  }

  isAuthorized(scope) {
    return this.authorizations.has(scope);
  }

  authorizationScopes() {
    return [...this.authorizations];
  }

  recordFailure(key) {
    const next = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, next);
    return next;
  }

  failureCount(key) {
    return this.failures.get(key) || 0;
  }

  resetFailure(key) {
    this.failures.delete(key);
  }

  resetWriteFailuresForPath(filePath) {
    for (const key of this.failures.keys()) {
      if (key.includes(":write:") && key.endsWith(filePath)) {
        this.failures.delete(key);
      }
    }
  }

  shouldStop(key) {
    return this.failureCount(key) >= this.stopThreshold;
  }
}
