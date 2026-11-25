#!/usr/bin/env node
import { readSync } from "node:fs";
import { isatty } from "node:tty";
import { main } from "./cli.js";

/**
 * One line typed in the terminal, read synchronously from file descriptor 0 (main is synchronous). undefined at the
 * end of input. process.stdin is never touched: opening it as a stream could put the descriptor in non-blocking mode.
 */
function askLine(question: string): string | undefined {
  process.stdout.write(`${question} `);
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n: number;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") n = 0;
      else throw e;
    }
    if (n === 0) return bytes.length ? Buffer.from(bytes).toString("utf8") : undefined;
    if (byte[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(byte[0]);
  }
}

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  // Someone can answer only when both ends are a terminal: a CI, a pipe or the admin's child process never waits.
  ...(isatty(0) && isatty(1) ? { ask: askLine } : {}),
});
