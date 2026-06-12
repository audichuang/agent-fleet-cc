// tests/shared/conformance/reference.conformance.test.mjs
import { runConformanceSuite } from "./conformance.mjs";
import { makeReferenceAdapter } from "./reference-adapter.mjs";

runConformanceSuite({ makeAdapter: makeReferenceAdapter });
