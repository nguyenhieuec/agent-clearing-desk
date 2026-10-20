/**
 * The subset of JSON Schema the upstream tool schemas use: type, enum, const, properties,
 * required, additionalProperties: false, items, size limits, pattern and anyOf/oneOf.
 * Unknown keywords are ignored, so a schema the desk cannot fully read never blocks a
 * call the upstream would accept; it only lets the upstream do the rest of the check.
 */
type Schema = Record<string, unknown>;

const MAX_ERRORS = 5;

/** Compiled `pattern` keywords; a schema is stored once, so each pattern compiles once per isolate. */
const patterns = new Map<string, RegExp | null>();

/** The pattern as a RegExp, or null when it is not valid in Unicode mode (then the upstream checks it). */
function compilePattern(source: string): RegExp | null {
  if (!patterns.has(source)) {
    try {
      patterns.set(source, new RegExp(source, 'u'));
    } catch {
      patterns.set(source, null);
    }
  }
  return patterns.get(source) ?? null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: unknown, value: unknown): boolean {
  const actual = typeOf(value);
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some(t => t === actual || (t === 'number' && actual === 'integer'));
}

function checkString(s: Schema, value: string, path: string, errors: string[]): void {
  if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${path} must have at least ${s.minLength} characters`);
  if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${path} must have at most ${s.maxLength} characters`);
  const re = typeof s.pattern === 'string' ? compilePattern(s.pattern) : null;
  if (re && !re.test(value)) errors.push(`${path} must match ${s.pattern}`);
}

function checkNumber(s: Schema, value: number, path: string, errors: string[]): void {
  if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path} must be >= ${s.minimum}`);
  if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${path} must be <= ${s.maximum}`);
}

function checkArray(s: Schema, value: unknown[], path: string, errors: string[]): void {
  if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path} must have at least ${s.minItems} items`);
  if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path} must have at most ${s.maxItems} items`);
  if (s.items && typeof s.items === 'object') value.forEach((item, i) => walk(s.items as Schema, item, `${path}[${i}]`, errors));
}

function checkObject(s: Schema, value: Record<string, unknown>, path: string, errors: string[]): void {
  const props = (s.properties ?? {}) as Record<string, Schema>;
  for (const field of (s.required ?? []) as string[]) {
    if (value[field] === undefined || value[field] === null || value[field] === '') errors.push(`${path}.${field} is required`);
  }
  for (const [field, v] of Object.entries(value)) {
    // Own properties only: "constructor" or "toString" must not pass as declared via Object.prototype.
    if (Object.hasOwn(props, field)) walk(props[field], v, `${path}.${field}`, errors);
    else if (s.additionalProperties === false) errors.push(`${path}.${field} is not an allowed argument`);
  }
}

function walk(s: Schema, value: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS || value === undefined) return;
  const alternatives = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (alternatives && !alternatives.some(alt => validateArguments(alt, value, path).length === 0)) {
    errors.push(`${path} matches none of the allowed forms`);
    return;
  }
  if (s.type !== undefined && !matchesType(s.type, value)) {
    errors.push(`${path} must be ${Array.isArray(s.type) ? s.type.join(' or ') : s.type}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) errors.push(`${path} must be one of ${s.enum.join(', ')}`);
  if (s.const !== undefined && s.const !== value) errors.push(`${path} must be ${JSON.stringify(s.const)}`);
  if (typeof value === 'string') checkString(s, value, path, errors);
  else if (typeof value === 'number') checkNumber(s, value, path, errors);
  else if (Array.isArray(value)) checkArray(s, value, path, errors);
  else if (value && typeof value === 'object') checkObject(s, value as Record<string, unknown>, path, errors);
}

/** Every `pattern` in a schema that cannot compile as a Unicode RegExp, so a tool with one is refused when added. */
export function invalidPatterns(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const own = (schema as Schema).pattern;
  const bad = typeof own === 'string' && compilePattern(own) === null ? [own] : [];
  return [...bad, ...Object.values(schema as Schema).flatMap(invalidPatterns)];
}

/** Problems with `value` under `schema`, at most 5, as short readable lines; [] when it fits. */
export function validateArguments(schema: Schema, value: unknown, path = 'arguments'): string[] {
  const errors: string[] = [];
  walk(schema, value, path, errors);
  return errors;
}
