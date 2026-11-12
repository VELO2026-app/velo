#!/usr/bin/njs
// validate-texts <dir>: a texts package checked before the machine switches to
// it (primer.yaml packages.texts.validate, FE-133). Run by the njs CLI of the
// nginx image, as primer-blank's validate.js: the runtime image has no node.
// Every problem is printed with its file and key; any problem is a non-zero
// exit (njs exits 1 on an uncaught error). Dead keys are warnings.
//
// The check itself is scripts/lib/texts-package.mjs, copied beside this file
// as package.js (Dockerfile); the product's base texts are the <lang>.json
// files of /usr/local/lib/primer/texts (scripts/export-base-texts.mjs).

import primer from '/usr/local/lib/primer/package.js'

const command = String(process.argv[1]).split('/').pop()
if (command !== 'validate-texts') {
  throw new Error(`run as validate-texts, not ${command}`)
}
if (process.argv.length !== 3) {
  throw new Error(`usage: ${command} <dir>`)
}
const dir = process.argv[2]
const result = primer.checkTexts(dir)
result.warnings.forEach((warning) => console.log(`${command}: warning: ${warning}`))
result.problems.forEach((problem) => console.log(`${command}: ${problem}`))
if (result.problems.length > 0) {
  throw new Error(`${command}: ${dir}: ${result.problems.length} problem(s)`)
}
console.log(`${command}: ${dir}: ok`)
