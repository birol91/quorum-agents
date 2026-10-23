// Load an ESM-only module from CommonJS-emitted code.
//
// tsc with `module: commonjs` downlevels a literal `import(...)` to `require(...)`,
// which throws ERR_REQUIRE_ESM on ESM-only packages (the Agent SDK). Wrapping the
// import in `new Function` hides it from tsc's transform, so a real dynamic
// import() survives to runtime. This is the one sanctioned place for that trick.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

/**
 * Packaged-Electron detour: inside app.asar, Electron's patched fs makes
 * `import('<pkg>')` READ the unpacked file while `import.meta.url` still says
 * `app.asar/...`. A package that spawns child processes from paths derived
 * off import.meta.url (the Agent SDK) then hands the OS a path through the
 * asar archive — a file, not a directory — and spawn dies with ENOTDIR.
 * Resolve such packages to their real app.asar.unpacked entry file instead.
 */
function unpackedEntryUrl(specifier: string): string | null {
  if (typeof __dirname !== 'string' || !__dirname.includes('app.asar')) return null;
  const root = __dirname.slice(0, __dirname.indexOf('app.asar'));
  const dir = `${root}app.asar.unpacked/node_modules/${specifier}`;
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as {
      exports?: Record<string, unknown> | string;
      module?: string;
      main?: string;
    };
    let entry: unknown = typeof pkg.exports === 'object' ? pkg.exports?.['.'] : pkg.exports;
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      entry = e.import ?? e.default;
      if (entry && typeof entry === 'object') entry = (entry as Record<string, unknown>).default;
    }
    const rel = (typeof entry === 'string' ? entry : pkg.module ?? pkg.main ?? 'index.js').replace(/^\.\//, '');
    const file = `${dir}/${rel}`;
    return existsSync(file) ? pathToFileURL(file).href : null;
  } catch {
    return null;
  }
}

export function importEsm<T>(specifier: string): Promise<T> {
  return dynamicImport(unpackedEntryUrl(specifier) ?? specifier) as Promise<T>;
}
