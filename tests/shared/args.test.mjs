import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "../../shared/lib/args.mjs";

test("parses value flags, bool flags, and positionals", () => {
  const { flags, positionals } = parseArgs(
    ["fix", "the", "bug", "--profile", "kimi", "--background"],
    { valueFlags: ["profile"], boolFlags: ["background"] },
  );
  assert.equal(flags.profile, "kimi");
  assert.equal(flags.background, true);
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("-- stops flag parsing", () => {
  const { flags, positionals } = parseArgs(["--", "--profile", "x"], {
    valueFlags: ["profile"],
  });
  assert.deepEqual(flags, {});
  assert.deepEqual(positionals, ["--profile", "x"]);
});

test("unknown flag throws UsageError", () => {
  assert.throws(() => parseArgs(["--nope"], {}), UsageError);
});

test("value flag missing its value throws UsageError", () => {
  assert.throws(
    () => parseArgs(["--profile"], { valueFlags: ["profile"] }),
    UsageError,
  );
});
