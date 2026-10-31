import { call } from "./common.mjs";
const before = (await call("query", "bench:counterValue")).value;
const N = 200;
const results = await Promise.all(Array.from({ length: N }, () => call("mutation", "bench:bump")));
const ok = results.filter((r) => r.status === "success");
const errs = results.filter((r) => r.status !== "success").map((r) => r.errorMessage?.split("\n")[0]);
const vals = ok.map((r) => r.value).sort((a, b) => a - b);
const expected = Array.from({ length: N }, (_, i) => before + i + 1);
const after = (await call("query", "bench:counterValue")).value;
console.log(JSON.stringify({
  before, after, expectedAfter: before + N,
  succeeded: ok.length, errors: errs.length, firstErr: errs[0] ?? null,
  distinctReturnValues: new Set(vals).size,
  returnedExactlyOneToN: vals.length === N && vals.every((v, i) => v === expected[i]),
  lostUpdate: after !== before + N,
}));
