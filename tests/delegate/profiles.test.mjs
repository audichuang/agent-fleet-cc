import { makeDataRoot, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  listProfiles,
  resolveProfile,
  ProfileError,
} from "../../plugins/delegate/scripts/lib/profiles.mjs";

test("listProfiles returns sorted names, empty when dir missing", () => {
  const dataRoot = makeDataRoot();
  assert.deepEqual(listProfiles(dataRoot), []);
  writeProfile(dataRoot, "kimi", { env: {} });
  writeProfile(dataRoot, "glm", { env: {} });
  assert.deepEqual(listProfiles(dataRoot), ["glm", "kimi"]);
});

test("resolveProfile by name loads env block and path", () => {
  const dataRoot = makeDataRoot();
  const file = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
    model: "kimi-k2",
  });
  const profile = resolveProfile({ dataRoot, profile: "kimi", env: {} });
  assert.equal(profile.name, "kimi");
  assert.equal(profile.path, file);
  assert.equal(profile.env.ANTHROPIC_BASE_URL, "https://cheap");
});

test("falls back to DELEGATE_DEFAULT_PROFILE", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "glm", { env: {} });
  const profile = resolveProfile({
    dataRoot,
    env: { DELEGATE_DEFAULT_PROFILE: "glm" },
  });
  assert.equal(profile.name, "glm");
});

test("no profile and no default → ProfileError listing available", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "kimi", { env: {} });
  assert.throws(
    () => resolveProfile({ dataRoot, env: {} }),
    (error) => error instanceof ProfileError && /kimi/.test(error.message),
  );
});

test("missing file and invalid JSON → ProfileError (fail fast, pre-spawn)", async () => {
  const dataRoot = makeDataRoot();
  assert.throws(
    () => resolveProfile({ dataRoot, profile: "nope", env: {} }),
    ProfileError,
  );
  const bad = writeProfile(dataRoot, "bad", {});
  // 蓋成壞 JSON
  (await import("node:fs")).default.writeFileSync(bad, "{not json");
  assert.throws(
    () => resolveProfile({ dataRoot, profile: "bad", env: {} }),
    (error) => error instanceof ProfileError && /not valid JSON/.test(error.message),
  );
});

test("profile names with path traversal are rejected", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "kimi", { env: {} });
  for (const name of ["../evil", "..", "a/b", "/abs", ".hidden"]) {
    assert.throws(
      () => resolveProfile({ dataRoot, profile: name, env: {} }),
      (error) => error instanceof ProfileError && /Invalid profile name/.test(error.message),
      `name: ${name}`,
    );
  }
});

test("profile env with object/array values fails fast at resolve time", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "bad-obj", { env: { NESTED: { a: 1 } } });
  writeProfile(dataRoot, "bad-arr", { env: { LIST: ["x"] } });
  for (const name of ["bad-obj", "bad-arr"]) {
    assert.throws(
      () => resolveProfile({ dataRoot, profile: name, env: {} }),
      (error) => error instanceof ProfileError && /must be a string/.test(error.message),
    );
  }
});

test("explicit settingsPath bypasses the profiles dir", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const dataRoot = makeDataRoot();
  const file = path.join(dataRoot, "anywhere.json");
  fs.writeFileSync(file, JSON.stringify({ env: { A: "1" } }));
  const profile = resolveProfile({ dataRoot, settingsPath: file, env: {} });
  assert.equal(profile.env.A, "1");
});
