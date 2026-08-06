// Gate C — contract integrity.
//
// CONTRIBUTING.md tells every other team to read openapi.yaml to find out what
// already exists. That only works if the contract stays in step with the router,
// so this test fails when a route is added to src/app.js without being documented.
//
// Routes are read from the built Express app rather than by grepping the source,
// so loop-registered families expand to their real concrete paths and the check
// cannot be fooled by how a route happens to be written.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";

const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");

function registeredRoutes() {
  const app = createApp({
    store: new MemoryStore(),
    authenticate: async () => ({ id: "contract", email: "contract@example.edu", name: "Contract", role: "admin" }),
  });
  const routes = [];
  for (const layer of (app.router || app._router).stack) {
    if (!layer.route || !layer.route.path.startsWith("/api/v1")) continue;
    for (const [verb, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) routes.push({ verb: verb.toUpperCase(), path: layer.route.path.replace("/api/v1", "") });
    }
  }
  return routes;
}

/**
 * Top-level `  /path:` keys under `paths:`, with the verbs documented for each
 * and any `enum:` values declared for their path parameters.
 */
function pathsInContract(yaml) {
  const documented = new Map();
  let currentPath = null;
  for (const line of yaml.split("\n")) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      documented.set(currentPath, { verbs: new Set(), enums: [] });
      continue;
    }
    if (!currentPath) continue;
    const verbMatch = /^ {4}(get|post|patch|put|delete):\s*$/.exec(line);
    if (verbMatch) documented.get(currentPath).verbs.add(verbMatch[1].toUpperCase());
    const enumMatch = /enum:\s*\[([^\]]+)\]/.exec(line);
    if (enumMatch) documented.get(currentPath).enums.push(enumMatch[1].split(",").map((item) => item.trim()));
  }
  return documented;
}

const segmentsOf = (path) => path.split("/").filter(Boolean);
const isExpressParam = (segment) => segment.startsWith(":");
const isContractParam = (segment) => segment.startsWith("{");

/**
 * A concrete Express path matches a documented path when they have the same
 * shape and each segment either is identical, or is an id-style parameter on
 * both sides, or is a documented enum that actually lists this literal.
 *
 * The enum check is what stops `/{contentType}` behaving as a wildcard: it
 * matches `/committee` because the contract enumerates it, and rejects anything
 * that is not on that list.
 */
function pathsMatch(routePath, documentedPath, enums) {
  const route = segmentsOf(routePath);
  const documented = segmentsOf(documentedPath);
  if (route.length !== documented.length) return false;

  const enumValues = enums.flat();
  return route.every((segment, index) => {
    const other = documented[index];
    if (segment === other) return true;
    if (isExpressParam(segment) && isContractParam(other)) return true;
    // A literal route segment may fill a documented enum parameter.
    if (isContractParam(other) && enumValues.includes(segment)) return true;
    return false;
  });
}

test("Gate C: every route the app registers is documented in openapi.yaml", async () => {
  const documented = pathsInContract(await read("../public/openapi.yaml"));

  const missing = registeredRoutes()
    .filter(({ verb, path }) => ![...documented].some(([documentedPath, { verbs, enums }]) =>
      verbs.has(verb) && pathsMatch(path, documentedPath, enums)))
    .map(({ verb, path }) => `${verb} ${path}`);

  assert.deepEqual(missing, [], `undocumented route(s) — add them to public/openapi.yaml:\n  ${missing.join("\n  ")}`);
});

test("Gate C: the check itself fails when a route is undocumented", async () => {
  // Guards against the gate silently rotting into a no-op.
  const documented = pathsInContract(await read("../public/openapi.yaml"));
  const canary = { verb: "GET", path: "/definitely-not-documented" };

  const matched = [...documented].some(([documentedPath, { verbs, enums }]) =>
    verbs.has(canary.verb) && pathsMatch(canary.path, documentedPath, enums));

  assert.equal(matched, false, "an undocumented route must not match anything in the contract");
});

test("Gate C: the EPIC-03/04 endpoints are all in the contract", async () => {
  const documented = pathsInContract(await read("../public/openapi.yaml"));
  for (const path of ["/holds", "/holds/mine", "/holds/{id}", "/public/holds", "/public/recommendations"]) {
    assert.ok(documented.has(path), `openapi.yaml is missing ${path}`);
  }
  assert.ok(documented.get("/holds").verbs.has("POST"));
  assert.ok(documented.get("/holds/{id}").verbs.has("DELETE"));
});

test("Gate C: the Postman collection covers the new endpoints and stays valid JSON", async () => {
  const collection = JSON.parse(await read("../postman/Spot-InV-BE.postman_collection.json"));
  const urls = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item.request) urls.push(typeof item.request.url === "string" ? item.request.url : item.request.url?.raw || "");
      walk(item.item);
    }
  };
  walk(collection.item);

  for (const fragment of ["/api/v1/holds", "/api/v1/public/holds", "/api/v1/public/recommendations"]) {
    assert.ok(urls.some((url) => url.includes(fragment)), `Postman collection is missing ${fragment}`);
  }

  // Any {{variable}} used in a request must be declared, or the collection is
  // unusable on a teammate's machine.
  const declared = new Set((collection.variable || []).map((item) => item.key));
  const used = new Set();
  for (const url of urls) for (const [, name] of url.matchAll(/\{\{(\w+)\}\}/g)) used.add(name);
  const undeclared = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [], `undeclared Postman variable(s): ${undeclared.join(", ")}`);
});
