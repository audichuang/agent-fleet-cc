import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../plugins/antigravity/scripts/lib/args.mjs";

const schema = { booleanOptions: ["json"], valueOptions: ["cwd"] };

test("bare boolean flag is true", () => {
  assert.equal(parseArgs(["--json"], schema).options.json, true);
});

test("falsy spellings disable a boolean flag", () => {
  for (const v of ["false", "0", "no", "off", "", "FALSE", "No"]) {
    assert.equal(parseArgs([`--json=${v}`], schema).options.json, false, `--json=${v}`);
  }
});

test("truthy spellings enable a boolean flag", () => {
  for (const v of ["true", "1", "yes", "on"]) {
    assert.equal(parseArgs([`--json=${v}`], schema).options.json, true, `--json=${v}`);
  }
});
