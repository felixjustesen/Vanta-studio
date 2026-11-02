// Lader testerne importere Vanta Platforms egen kode (TypeScript) direkte:
// "@/lib/…" peger på vanta-platform/src/lib/….ts.
const SRC = new URL("../../../../vanta-platform/src/", import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) return next(new URL(`${specifier.slice(2)}.ts`, SRC).href, context);
  return next(specifier, context);
}
