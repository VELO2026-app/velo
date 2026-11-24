#!/usr/bin/env node
// FE-234: the brand pins are well-formed (run by the scope job of ci.yml).
// The clone machinery (the hook-proof environment, the token, the failure
// format) is FE-239's shared frontend/scripts/lib/brand-git.mjs; its test
// (brand-git.test.mjs) runs with the frontend suite.
// Locally: node --test .github/scripts/fetch-brand-skins.test.mjs
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBrands } from "./fetch-brand-skins.mjs";

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
