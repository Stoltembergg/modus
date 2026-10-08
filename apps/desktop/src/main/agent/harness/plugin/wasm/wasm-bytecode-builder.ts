/**
 * @file wasm-bytecode-builder.ts
 * Generates verified, valid WebAssembly binary bytecodes for testing and built-in accelerators.
 */

/**
 * Encodes an unsigned integer into LEB128 bytes.
 */
export function encodeUleb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (true) {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) {
      bytes.push(byte);
      break;
    } else {
      bytes.push(byte | 0x80);
    }
  }
  return bytes;
}

/**
 * Creates a standard WASM section with ID and length header.
 */
export function createSection(sectionId: number, payload: number[]): number[] {
  return [sectionId, ...encodeUleb128(payload.length), ...payload];
}

/**
 * Generates a minimal valid WASM module exporting `add(a: i32, b: i32) -> i32`.
 */
export function buildAddModule(): Uint8Array {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // Type section: (i32, i32) -> i32
  const typeSection = createSection(0x01, [
    0x01, // 1 type
    0x60, // func
    0x02, 0x7f, 0x7f, // 2 params: i32, i32
    0x01, 0x7f, // 1 result: i32
  ]);

  // Function section: func 0 has type 0
  const funcSection = createSection(0x03, [0x01, 0x00]);

  // Export section: export 'add'
  const exportSection = createSection(0x07, [
    0x01, // 1 export
    0x03, 0x61, 0x64, 0x64, // 'add'
    0x00, // kind: func
    0x00, // index: 0
  ]);

  // Code section: local.get 0, local.get 1, i32.add, end
  const codeBody = [0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b];
  const codeSection = createSection(0x0a, [
    0x01, // 1 func
    ...encodeUleb128(codeBody.length),
    ...codeBody,
  ]);

  return new Uint8Array([
    ...header,
    ...typeSection,
    ...funcSection,
    ...exportSection,
    ...codeSection,
  ]);
}

/**
 * Generates a WASM module that imports `env.consume_fuel(units: i32)`
 * and runs a loop consuming fuel on each iteration.
 */
export function buildFuelLoopModule(): Uint8Array {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // Type section:
  // type 0: (i32) -> () (for consume_fuel import)
  // type 1: (i32) -> (i32) (for run_loop)
  const typeSection = createSection(0x01, [
    0x02, // 2 types
    0x60, 0x01, 0x7f, 0x00, // type 0
    0x60, 0x01, 0x7f, 0x01, 0x7f, // type 1: (i32) -> i32
  ]);

  // Import section: import 'env' 'consume_fuel'
  const envBytes = [0x03, 0x65, 0x6e, 0x76];
  const funcBytes = [
    0x0c, 0x63, 0x6f, 0x6e, 0x73, 0x75, 0x6d, 0x65, 0x5f, 0x66, 0x75, 0x65, 0x6c,
  ];
  const importSection = createSection(0x02, [
    0x01, // 1 import
    ...envBytes,
    ...funcBytes,
    0x00, // kind: func
    0x00, // type index: 0
  ]);

  // Function section: func 1 (type 1)
  const funcSection = createSection(0x03, [0x01, 0x01]);

  // Export section: export 'run_loop'
  const exportSection = createSection(0x07, [
    0x01,
    0x08, 0x72, 0x75, 0x6e, 0x5f, 0x6c, 0x6f, 0x6f, 0x70, // 'run_loop'
    0x00, // kind: func
    0x01, // index: 1
  ]);

  // Code section:
  // func(iterations: i32) -> i32
  // loop:
  //   if iterations <= 0 return 0
  //   call consume_fuel(1)
  //   iterations -= 1
  //   br 0
  const codeBody = [
    0x00, // 0 locals
    0x03, 0x40, // loop
    0x20, 0x00, // local.get 0
    0x41, 0x00, // i32.const 0
    0x4c, // i32.le_s (fixed: 0x4c is le_s, 0x4e was ge_s)
    0x04, 0x40, // if
    0x41, 0x00, // i32.const 0
    0x0f, // return
    0x0b, // end if
    0x41, 0x01, // i32.const 1
    0x10, 0x00, // call 0 (consume_fuel)
    0x20, 0x00, // local.get 0
    0x41, 0x01, // i32.const 1
    0x6b, // i32.sub
    0x21, 0x00, // local.set 0
    0x0c, 0x00, // br 0
    0x0b, // end loop
    0x20, 0x00, // local.get 0
    0x0b, // end func
  ];

  const codeSection = createSection(0x0a, [
    0x01,
    ...encodeUleb128(codeBody.length),
    ...codeBody,
  ]);

  return new Uint8Array([
    ...header,
    ...typeSection,
    ...importSection,
    ...funcSection,
    ...exportSection,
    ...codeSection,
  ]);
}

/**
 * Generates a WASM module with exported memory and vector math / tokenizer functions.
 */
export function buildMemoryModule(initialPages = 1): Uint8Array {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // Type section:
  // type 0: (i32, i32) -> i32  (count_chars / token_len)
  // type 1: (i32) -> i32        (alloc / mem size)
  const typeSection = createSection(0x01, [
    0x02,
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x60, 0x01, 0x7f, 0x01, 0x7f,
  ]);

  // Function section: func 0 has type 0, func 1 has type 1
  const funcSection = createSection(0x03, [0x02, 0x00, 0x01]);

  // Memory section: 1 memory with initial pages
  const memorySection = createSection(0x05, [
    0x01,
    0x00, // flags: only min
    ...encodeUleb128(initialPages),
  ]);

  // Export section: 'memory', 'count_tokens', 'alloc'
  const exportSection = createSection(0x07, [
    0x03,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, // 'memory' (kind 2: memory, index 0)
    0x0c, 0x63, 0x6f, 0x75, 0x6e, 0x74, 0x5f, 0x74, 0x6f, 0x62, 0x65, 0x6e, 0x73, 0x00, 0x00, // 'count_tokens'
    0x05, 0x61, 0x6c, 0x6c, 0x6f, 0x63, 0x00, 0x01, // 'alloc'
  ]);

  // Code section:
  // func 0: count_tokens(ptr, len) -> return len (dummy token count)
  const codeBody0 = [
    0x00, // 0 locals
    0x20, 0x01, // local.get 1 (len)
    0x0b, // end
  ];

  // func 1: alloc(size) -> return 64 (fixed offset allocation pointer)
  const codeBody1 = [
    0x00,
    0x41, 0x40, // i32.const 64
    0x0b,
  ];

  const codeSection = createSection(0x0a, [
    0x02,
    ...encodeUleb128(codeBody0.length),
    ...codeBody0,
    ...encodeUleb128(codeBody1.length),
    ...codeBody1,
  ]);

  return new Uint8Array([
    ...header,
    ...typeSection,
    ...funcSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ]);
}
