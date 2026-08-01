function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function patternRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^.]+')}$`);
}

function matches(pattern, path) {
  return patternRegExp(pattern).test(path);
}

function matchesPathOrDescendant(pattern, path) {
  const source = patternRegExp(pattern).source.slice(1, -1);
  return new RegExp(`^${source}(?:\\..+)?$`).test(path);
}

function epsilonFor(path, policy) {
  const entries = Object.entries(policy.absoluteEpsilon)
    .filter(([pattern]) => pattern !== 'default' && matchesPathOrDescendant(pattern, path))
    .sort(([left], [right]) => {
      const leftWildcards = (left.match(/\*/g) || []).length;
      const rightWildcards = (right.match(/\*/g) || []).length;
      return leftWildcards - rightWildcards || right.length - left.length;
    });
  return entries.length ? entries[0][1] : policy.absoluteEpsilon.default;
}

function compareCheckpoint(expected, actual, policy) {
  const failures = [];
  const exactPatterns = policy.exact || [];

  function compare(expectedValue, actualValue, path) {
    const exact = exactPatterns.some(pattern => matches(pattern, path));
    if (exact) {
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        failures.push(`${path}: expected exact ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
      }
      return;
    }

    if (typeof expectedValue === 'number') {
      if (typeof actualValue !== 'number' || !Number.isFinite(actualValue)) {
        failures.push(`${path}: expected finite number, got ${JSON.stringify(actualValue)}`);
        return;
      }
      const epsilon = epsilonFor(path, policy);
      if (Math.abs(actualValue - expectedValue) > epsilon) {
        failures.push(`${path}: |${actualValue} - ${expectedValue}| exceeds ${epsilon}`);
      }
      return;
    }

    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) {
        failures.push(`${path}: expected array, got ${typeof actualValue}`);
        return;
      }
      compare(expectedValue.length, actualValue.length, `${path}.length`);
      for (let index = 0; index < expectedValue.length; index++) {
        compare(expectedValue[index], actualValue[index], `${path}.${index}`);
      }
      return;
    }

    if (expectedValue && typeof expectedValue === 'object') {
      if (!actualValue || typeof actualValue !== 'object' || Array.isArray(actualValue)) {
        failures.push(`${path}: expected object, got ${JSON.stringify(actualValue)}`);
        return;
      }
      const expectedKeys = Object.keys(expectedValue).sort();
      const actualKeys = Object.keys(actualValue).sort();
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        failures.push(`${path}: keys differ; expected ${expectedKeys.join(',')}, got ${actualKeys.join(',')}`);
        return;
      }
      for (const key of expectedKeys) {
        compare(expectedValue[key], actualValue[key], path ? `${path}.${key}` : key);
      }
      return;
    }

    if (actualValue !== expectedValue) {
      failures.push(`${path}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  }

  compare(expected, actual, '');
  return failures;
}

module.exports = { compareCheckpoint, epsilonFor };
