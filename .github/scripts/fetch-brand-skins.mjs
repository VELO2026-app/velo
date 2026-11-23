#!/usr/bin/env node
// =============================================================================
// VELO CI -- fetch the brand skin packages at their pinned tags (FE-234)
//
// Reads .github/brand-skins.json (repo, tag, commit, package dir per brand),
// clones each repository at its tag into <out-dir>/<brand>, checks that the
// tag still points at the pinned commit, and prints one line for
// $GITHUB_ENV:  BRAND_SKIN_ARGS=--skin <out-dir>/<brand>/<dir> ...
// (the form scripts/build-matrix.mjs takes).
//
// A private brand repository needs a read key: set BRAND_REPO_TOKEN (the
// workflows pass the secret of that name; empty = anonymous, enough while the
// repositories are public). The key is the owner's decision (FE-234).
//
// Usage: node .github/scripts/fetch-brand-skins.mjs <out-dir>
// Node stdlib only. planBrands() and cloneUrl() are exported for the test.
// =============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "brand-skins.json",
);

/** The https URL of a repository; a token goes in as the basic-auth password. */
export function cloneUrl(repo, token = "") {
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

/** The brands of the config as { name, repo, tag, sha, target, skinDir }; a
 *  malformed entry throws, so a typo cannot silently drop a brand. */
export function planBrands(config, outDir) {
  const names = Object.keys(config.brands ?? {});
  if (names.length === 0) throw new Error("brand-skins.json: no brands");
  return names.map((name) => {
    const { repo, tag, sha, dir } = config.brands[name];
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))
      throw new Error(`${name}: bad repo "${repo}"`);
    if (!/^v\d+\.\d+\.\d+$/.test(tag ?? ""))
      throw new Error(`${name}: bad tag "${tag}"`);
    if (!/^[0-9a-f]{40}$/.test(sha ?? ""))
      throw new Error(`${name}: bad sha "${sha}"`);
    if (!/^[\w.-]+$/.test(dir ?? ""))
      throw new Error(`${name}: bad dir "${dir}"`);
    const target = join(outDir, name);
    return { name, repo, tag, sha, target, skinDir: join(target, dir) };
  });
}

function main() {
  const out = process.argv[2];
  if (!out) {
    console.error(
      "usage: node .github/scripts/fetch-brand-skins.mjs <out-dir>",
    );
    process.exit(1);
  }
  const outDir = resolve(out);
  const token = process.env.BRAND_REPO_TOKEN ?? "";
  const brands = planBrands(JSON.parse(readFileSync(CONFIG, "utf8")), outDir);
  for (const b of brands) {
    // Not in the log: the clone URL may carry the token.
    execFileSync(
      "git",
      [
        "-c",
        "advice.detachedHead=false",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        b.tag,
        cloneUrl(b.repo, token),
        b.target,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const head = execFileSync("git", ["-C", b.target, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (head !== b.sha)
      throw new Error(
        `${b.name} ${b.tag} is ${head}, the pin says ${b.sha} -- the tag moved`,
      );
    if (!existsSync(join(b.skinDir, "primer-package.yaml")))
      throw new Error(`${b.name} ${b.tag}: no package at ${b.skinDir}`);
  }
  console.log(
    `BRAND_SKIN_ARGS=${brands.map((b) => `--skin ${b.skinDir}`).join(" ")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
