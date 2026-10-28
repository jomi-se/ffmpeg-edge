import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Compile the actual pure module with the existing compiler, without requiring
// Node's TypeScript stripping or downloading a browser/FFmpeg runtime.
const work = await mkdtemp(join(tmpdir(), "media-command-test-"));
let command;
try {
  const source = await readFile(
    new URL("../src/lib/command.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const modulePath = join(work, "command.mjs");
  await writeFile(modulePath, outputText);
  command = await import(pathToFileURL(modulePath).href);
} finally {
  await rm(work, { recursive: true, force: true });
}

for (const output of [
  "../$OUTPUT",
  "subdir/{output}",
  "https://example.invalid/$OUTPUT",
  "bad\0$OUTPUT",
  "$OUTPUT:payload",
  "{output}\\nested.mp4",
]) {
  test(`rejects unsafe resolved output ${JSON.stringify(output)}`, () => {
    assert.equal(
      command.validateCommandArgs(["-i", "$INPUT", output], "clip.mp4").ok,
      false,
    );
  });
}

for (const output of [
  "$OUTPUT",
  "{output}",
  "prefix-$OUTPUT.mp4",
  "$OUTPUT-{output}.mp4",
  "my output.mp4",
]) {
  test(`uses one resolved output for execution and reading: ${output}`, () => {
    const args = ["-i", "$INPUT", output];
    assert.equal(command.validateCommandArgs(args, "clip.mp4").ok, true);
    const resolved = output.replaceAll(
      /\$OUTPUT|\{output\}/g,
      "clip-converted.mp4",
    );
    assert.equal(command.inferOutputName("clip.mp4", args), resolved);
    assert.deepEqual(command.normalizeArgs(args, "clip.mp4", resolved), [
      "-i",
      "clip.mp4",
      resolved,
    ]);
    assert.equal(args[2], output);
  });
}

test("infers output from its argument rather than a placeholder in a filter", () => {
  assert.equal(
    command.inferOutputName("clip.mp4", [
      "-i",
      "$INPUT",
      "-vf",
      "drawtext=text=$OUTPUT",
      "out.mp4",
    ]),
    "out.mp4",
  );
});

test("validates the filename contributed by a placeholder", () => {
  for (const file of ["../clip.mp4", "proto:clip.mp4"]) {
    assert.equal(
      command.validateCommandArgs(["-i", "$INPUT", "$OUTPUT"], file).ok,
      false,
    );
  }
  assert.equal(
    command.inferOutputName("cash$&.mov", ["-i", "$INPUT", "$OUTPUT"]),
    "cash$&-converted.mp4",
  );
});

test("all accepted input references use the filename actually written to FFmpeg", () => {
  for (const input of ["$INPUT", "{input}", "My clip.mp4", "My_clip.mp4"]) {
    const args = ["-i", input, "out.mp4"];
    assert.equal(command.validateCommandArgs(args, "My clip.mp4").ok, true);
    assert.deepEqual(command.normalizeArgs(args, "My_clip.mp4", "out.mp4"), [
      "-i",
      "My_clip.mp4",
      "out.mp4",
    ]);
  }
});

test("uses the runner's alternate output when input and explicit output coincide", () => {
  assert.deepEqual(
    command.normalizeArgs(
      ["-i", "$INPUT", "clip.mp4"],
      "clip.mp4",
      "clip-converted.mp4",
    ),
    ["-i", "clip.mp4", "clip-converted.mp4"],
  );
});

test("a filename equal to -i cannot turn the following option or output into another input", () => {
  for (const tail of [["out.mp4"], ["-c:v", "copy", "out.mp4"]]) {
    const args = ["-i", "-i", ...tail];
    assert.equal(command.validateCommandArgs(args, "-i").ok, true);
    assert.deepEqual(command.normalizeArgs(args, "selected.bin", "out.mp4"), [
      "-i",
      "selected.bin",
      ...tail,
    ]);
  }
  assert.deepEqual(
    command.normalizeArgs(
      ["-vf", "-i", "-i", "$INPUT", "out.mp4"],
      "selected.bin",
      "out.mp4",
    ),
    ["-vf", "-i", "-i", "selected.bin", "out.mp4"],
  );
});

test("serializing and parsing preserves filter escapes, quotes and spaced output", () => {
  const args = [
    "-i",
    "$INPUT",
    "-vf",
    String.raw`select=not(mod(n\,10)),drawtext=text='a:b'`,
    "my output.mp4",
  ];
  assert.deepEqual(command.parseCommandLine(command.argsToCommand(args)), args);
});

test("a spaced output chip is edited as one literal value", () => {
  const chip = command.commandToChips(["-i", "$INPUT", "my output.mp4"]).at(-1);
  assert.equal(chip.kind, "output");
  assert.deepEqual(command.chipControlFor(chip), {
    type: "text",
    value: "my output.mp4",
    wholeToken: true,
    inputMode: "text",
  });
});
