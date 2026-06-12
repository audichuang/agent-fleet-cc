// tests/shared/events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EVENT_TYPES,
  appendEvent,
  readEvents,
  eventsFilePath,
} from "../../shared/lib/core/events.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-events-"));

test("five canonical event types", () => {
  assert.deepEqual(EVENT_TYPES, [
    "job-created",
    "spawned",
    "engine-event",
    "result",
    "finalized",
  ]);
});

test("appendEvent writes one NDJSON line with ts and type", () => {
  const dir = tmp();
  appendEvent(dir, "job-created", { engine: "delegate" });
  appendEvent(dir, "engine-event", { raw: '{"type":"result"}' });
  const lines = fs.readFileSync(eventsFilePath(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, "job-created");
  assert.equal(first.engine, "delegate");
  assert.ok(first.ts);
});

test("appendEvent rejects unknown type", () => {
  assert.throws(() => appendEvent(tmp(), "weird", {}), /unknown event type/);
});

test("readEvents tolerates junk lines and missing file", () => {
  const dir = tmp();
  assert.deepEqual(readEvents(dir), []);
  appendEvent(dir, "result", { ok: true });
  fs.appendFileSync(eventsFilePath(dir), "not-json\n");
  appendEvent(dir, "finalized", { status: "completed" });
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "completed");
});

test("readEvents supports offset for incremental tail", () => {
  const dir = tmp();
  appendEvent(dir, "job-created", {});
  appendEvent(dir, "result", {});
  const all = readEvents(dir);
  const tail = readEvents(dir, { afterIndex: 0 });
  assert.equal(all.length, 2);
  assert.deepEqual(tail, all.slice(1));
});
