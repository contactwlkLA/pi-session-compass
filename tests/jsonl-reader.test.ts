// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Tests for the byte-exact JSONL record reader.
 *
 * Every assertion checks absolute byte offsets and lengths against byte counts computed
 * independently from the written content, so decoded-string arithmetic can never pass for the
 * wrong reason. The chunk-boundary case uses a record larger than the stream's 64 KiB read chunk
 * consisting only of multibyte characters, so every chunk boundary splits a character.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompleteRecord, readCompleteRecords } from "../src/jsonl-reader.js";

let workDir: string;

function file(name: string): string {
  return path.join(workDir, name);
}

async function collect(filePath: string, startByte: number): Promise<CompleteRecord[]> {
  const records: CompleteRecord[] = [];
  for await (const record of readCompleteRecords(filePath, startByte)) {
    records.push(record);
  }
  return records;
}

/** Byte length of a string in UTF-8. */
function bytes(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

describe("readCompleteRecords", () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-reader-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("yields exact offsets and lengths on LF-terminated records", async () => {
    const records = ['{"n":1}', '{"n":2,"text":"héllo"}', '{"n":3}'];
    const content = `${records.join("\n")}\n`;
    const target = file("lf.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const firstOffset = 0;
    const secondOffset = bytes(records[0]) + 1;
    const thirdOffset = secondOffset + bytes(records[1]) + 1;

    const result = await collect(target, 0);
    expect(result).toEqual([
      { offset: firstOffset, length: bytes(records[0]), text: records[0] },
      { offset: secondOffset, length: bytes(records[1]), text: records[1] },
      { offset: thirdOffset, length: bytes(records[2]), text: records[2] },
    ]);
  });

  it("excludes the CR from CRLF-terminated records", async () => {
    const records = ['{"crlf":1}', '{"crlf":2,"text":"ünïcode"}'];
    const content = `${records.join("\r\n")}\r\n`;
    const target = file("crlf.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const secondOffset = bytes(records[0]) + 2;

    const result = await collect(target, 0);
    expect(result).toEqual([
      { offset: 0, length: bytes(records[0]), text: records[0] },
      { offset: secondOffset, length: bytes(records[1]), text: records[1] },
    ]);
    // Offsets stay on record starts: the byte before each offset ends the previous line.
    const buf = fs.readFileSync(target);
    for (const record of result) {
      expect(record.offset === 0 || buf[record.offset - 1] === 0x0a).toBe(true);
    }
  });

  it("skips blank and whitespace-only records but counts their bytes in later offsets", async () => {
    const first = '{"skip":1}';
    const second = '{"skip":2}';
    const third = '{"skip":3}';
    // blank LF line, then a whitespace-only CRLF line, between complete records
    const content = `${first}\n\n${second}\n   \r\n${third}\n`;
    const target = file("blanks.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const secondOffset = bytes(first) + 1 + 1;
    const thirdOffset = secondOffset + bytes(second) + 1 + bytes("   \r\n");

    const result = await collect(target, 0);
    expect(result).toEqual([
      { offset: 0, length: bytes(first), text: first },
      { offset: secondOffset, length: bytes(second), text: second },
      { offset: thirdOffset, length: bytes(third), text: third },
    ]);
  });

  it("decodes multibyte characters that split across the 64 KiB chunk boundary", async () => {
    // Only multibyte characters (3+3+4+2 bytes per repeat): every chunk boundary splits one.
    const bigText = "漢字🚀é".repeat(7000);
    expect(bytes(bigText)).toBeGreaterThan(65536);
    const first = '{"big":1}';
    const last = '{"big":2}';
    const content = `${first}\n${bigText}\n${last}\n`;
    const target = file("multibyte.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const bigOffset = bytes(first) + 1;
    const lastOffset = bigOffset + bytes(bigText) + 1;

    const result = await collect(target, 0);
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ offset: bigOffset, length: bytes(bigText), text: bigText });
    expect(result[2]).toEqual({ offset: lastOffset, length: bytes(last), text: last });
  });

  it("never yields an unterminated final record", async () => {
    const first = '{"tail":1}';
    const partial = '{"tail":2,"cut":mid';
    const content = `${first}\n${partial}`;
    const target = file("partial.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const result = await collect(target, 0);
    expect(result).toEqual([{ offset: 0, length: bytes(first), text: first }]);
  });

  it("yields the final record once a later append completes it", async () => {
    const first = '{"append":1}';
    const full = '{"append":2,"text":"完整"}';
    const cut = Math.floor(bytes(full) / 2);
    const fullBuf = Buffer.from(full, "utf-8");
    const target = file("append.jsonl");
    fs.writeFileSync(target, `${first}\n${fullBuf.subarray(0, cut).toString("utf-8")}`, "utf-8");

    expect(await collect(target, 0)).toEqual([{ offset: 0, length: bytes(first), text: first }]);

    fs.appendFileSync(target, `${fullBuf.subarray(cut).toString("utf-8")}\n`);

    const result = await collect(target, 0);
    expect(result).toEqual([
      { offset: 0, length: bytes(first), text: first },
      { offset: bytes(first) + 1, length: bytes(full), text: full },
    ]);
  });

  it("reads from a non-zero startByte at a line start with absolute offsets", async () => {
    const records = ['{"from":1}', '{"from":2}', '{"from":3}'];
    const content = `${records.join("\n")}\n`;
    const target = file("start.jsonl");
    fs.writeFileSync(target, content, "utf-8");

    const secondOffset = bytes(records[0]) + 1;
    const thirdOffset = secondOffset + bytes(records[1]) + 1;

    const result = await collect(target, secondOffset);
    expect(result).toEqual([
      { offset: secondOffset, length: bytes(records[1]), text: records[1] },
      { offset: thirdOffset, length: bytes(records[2]), text: records[2] },
    ]);
  });
});
