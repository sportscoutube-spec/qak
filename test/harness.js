// Tiny harness for the 2026-10-12 review tests. Same style as the repo's tests (node:assert, "ok -" lines), plus:
//   t()       a normal test: a failure is a real bug and makes the file exit 1
//   pending() a missing feature: not run, listed as PENDING (the gap is documented, no behaviour is invented)
//   xfail()   a spec/design mismatch: the body asserts what the brief says; it is EXPECTED to fail against the code (XFAIL).
//             If it ever passes, it is reported as XPASS so the mismatch note can be revisited.
export const results = { pass: 0, fail: [], pending: [], xfail: [], xpass: [] };
export async function t(name, fn) { try { await fn(); results.pass++; console.log("ok -", name); } catch (e) { results.fail.push([name, e.message]); console.log("FAIL -", name, "::", e.message); } }
export function pending(name, why) { results.pending.push([name, why]); console.log("PENDING -", name, "::", why); }
export async function xfail(name, why, fn) { try { await fn(); results.xpass.push(name); console.log("XPASS -", name, "(mismatch no longer reproduces; revisit)"); } catch (e) { results.xfail.push([name, why]); console.log("XFAIL -", name, "::", why, "::", e.message); } }
export function done(file) {
  const r = results; console.log(`\n${file}: ${r.pass} passed, ${r.fail.length} failed, ${r.xfail.length} xfail (spec mismatch), ${r.xpass.length} xpass, ${r.pending.length} pending (missing feature)`);
  if (r.fail.length) process.exitCode = 1;
}
