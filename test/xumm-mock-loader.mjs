// ESM loader hook: resolve "xumm" to an in-memory mock (no network). The test drives it via globalThis.__xumm.
export async function resolve(spec, ctx, next) { if (spec === "xumm") return { url: "mock:xumm", shortCircuit: true }; return next(spec, ctx); }
export async function load(url, ctx, next) {
  if (url === "mock:xumm") return { format: "module", shortCircuit: true, source: "export class Xumm { constructor(k) {} get user() { return globalThis.__xumm.user; } get payload() { return globalThis.__xumm.payload; } on() {} async authorize() {} async logout() {} }" };
  return next(url, ctx);
}
