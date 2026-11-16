#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
});
