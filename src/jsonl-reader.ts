// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Byte-exact reader for JSONL session files.
 *
 * Reads complete newline-terminated records from a byte offset using raw byte chunks, so every
 * offset and length is exact regardless of line-ending style or multibyte characters. Splitting
 * happens on byte level before any decoding; a record spanning several read chunks is carried
 * until its newline arrives. An unterminated final segment is a record still being written and is
 * never yielded. Blank and whitespace-only records are skipped, but their bytes still advance the
 * offsets of later records.
 */

import * as fs from "node:fs";

/** A complete newline-terminated record with its exact byte position in the file. */
export interface CompleteRecord {
  /** Absolute byte offset of the record's first byte. */
  offset: number;
  /** Byte length of the record without its line ending (the `\n`, and for CRLF the `\r`). */
  length: number;
  /** UTF-8 decoding of exactly those `length` bytes. */
  text: string;
}

const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;
const NOT_FOUND = -1;
const NO_BYTES = Buffer.alloc(0);
const UTF8 = "utf-8";

/**
 * Yield every complete record at or after `startByte`. `startByte` must be at a record boundary;
 * offsets in the yielded records stay absolute, so a caller can compare them against saved scan
 * positions. The stream ends without yielding the pending tail when the file ends mid-record.
 */
export async function* readCompleteRecords(filePath: string, startByte: number): AsyncGenerator<CompleteRecord> {
  const chunks: AsyncIterable<Buffer> = fs.createReadStream(filePath, { start: startByte });
  let pending: Buffer = NO_BYTES;
  let pendingOffset = startByte;

  for await (const chunk of chunks) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newlineIndex = pending.indexOf(NEWLINE_BYTE);
    while (newlineIndex !== NOT_FOUND) {
      let recordLength = newlineIndex;
      if (recordLength > 0 && pending[recordLength - 1] === CARRIAGE_RETURN_BYTE) {
        recordLength -= 1;
      }
      const text = pending.subarray(0, recordLength).toString(UTF8);
      const consumed = newlineIndex + 1;
      if (text.trim() !== "") {
        yield { offset: pendingOffset, length: recordLength, text };
      }
      pending = pending.subarray(consumed);
      pendingOffset += consumed;
      newlineIndex = pending.indexOf(NEWLINE_BYTE);
    }
  }
}
