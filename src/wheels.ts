import type { PyodideInterface } from 'pyodide';

// Pyodide only logs a wheel it could not load, which leaves the failure to whatever imports it
export function requireWheels(py: PyodideInterface, wheels: string[]) {
  const loaded = new Set(Object.values(py.loadedPackages));
  const missing = wheels.filter((wheel) => !loaded.has(wheel)).map((wheel) => wheel.slice(wheel.lastIndexOf('/') + 1));
  if (missing.length > 0) throw new Error(`Could not load ${missing.join(', ')}`);
}
