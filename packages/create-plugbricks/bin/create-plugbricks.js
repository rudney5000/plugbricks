#!/usr/bin/env node
import { create } from "../lib/create.js";

process.exitCode = create(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
});
