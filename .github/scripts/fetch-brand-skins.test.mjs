#!/usr/bin/env node
// FE-234: the brand pins are well-formed (run by the scope job of ci.yml).
// Locally: node --test .github/scripts/fetch-brand-skins.test.mjs
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneUrl, planBrands } from "./fetch-brand-skins.mjs";

const config = JSON.parse(
  readFileSync(new URL("../brand-skins.json", import.meta.url), "utf8"),
);

test("the committed pins plan one package dir per brand", () => {
  const plan = planBrands(config, "/out");
  assert.deepEqual(
    plan.map((b) => b.skinDir),
    ["/out/velo-brand/skin", "/out/goodo-brand/skin"],
  );
});

test("a malformed pin throws instead of dropping a brand", () => {
  const bad = {
    brands: {
      x: { repo: "a/b", tag: "main", sha: "f".repeat(40), dir: "skin" },
    },
  };
  assert.throws(() => planBrands(bad, "/out"), /bad tag/);
  assert.throws(() => planBrands({ brands: {} }, "/out"), /no brands/);
});

test("the token goes in the URL only when given", () => {
  assert.equal(cloneUrl("a/b"), "https://github.com/a/b.git");
  assert.equal(
    cloneUrl("a/b", "t"),
    "https://x-access-token:t@github.com/a/b.git",
  );
});
