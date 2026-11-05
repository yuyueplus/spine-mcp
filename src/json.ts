export type JsonObject = Record<string, unknown>;

export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

export function safeName(name: string): string {
  if (!name.trim() || name.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('Name is empty, reserved, or too long.');
  }
  return name;
}
