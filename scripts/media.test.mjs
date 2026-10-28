import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the whole production module. Every external effect is supplied below;
// no FFmpeg runtime, network, media, browser service, or temporary file is used.
const source = await readFile(
  new URL("../src/lib/media.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});

function fixture({
  threads = false,
  failFetch = 0,
  failLoad = 0,
  hangLoad = false,
  cleanupThrows = false,
} = {}) {
  const originalError = new Error("synthetic load failure");
  const instances = [];
  const created = [];
  const revoked = [];
  const live = new Set();
  const timers = new Map();
  let fetchCount = 0;
  class FakeFFmpeg {
    loaded = false;
    listeners = new Set();
    detached = 0;
    terminated = 0;
    config;
    constructor() {
      instances.push(this);
    }
    on(event, listener) {
      assert.equal(event, "log");
      this.listeners.add(listener);
    }
    off(event, listener) {
      assert.equal(event, "log");
      assert(this.listeners.has(listener));
      this.detached++;
      if (cleanupThrows) throw new Error("synthetic detach failure");
      this.listeners.delete(listener);
    }
    async load(config) {
      this.config = config;
      for (const url of Object.values(config)) assert(live.has(url));
      if (instances.indexOf(this) + 1 === failLoad) throw originalError;
      if (hangLoad) return new Promise(() => {});
      this.loaded = true;
    }
    terminate() {
      this.terminated++;
      this.loaded = false;
      if (cleanupThrows) throw new Error("synthetic terminate failure");
    }
  }
  const exports = {};
  const context = vm.createContext({
    exports,
    Blob,
    Error,
    performance,
    SharedArrayBuffer: threads ? SharedArrayBuffer : undefined,
    crossOriginIsolated: threads,
    require(name) {
      if (name === "@ffmpeg/ffmpeg") return { FFmpeg: FakeFFmpeg };
      if (name === "@ffmpeg/util")
        return {
          fetchFile() {
            throw new Error("unexpected media read");
          },
        };
      if (name === "./command") return {};
      if (name === "./log")
        return { log: { info() {}, warn() {}, error() {} } };
      throw new Error(`unexpected import ${name}`);
    },
    window: {
      setTimeout(callback) {
        const id = Symbol("timer");
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        assert(timers.delete(id));
      },
    },
    URL: {
      createObjectURL(blob) {
        assert(blob instanceof Blob);
        const url = `blob:synthetic-${created.length}`;
        created.push(url);
        live.add(url);
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
        assert(live.delete(url), "each URL must be released once");
        if (cleanupThrows) throw new Error("synthetic revoke failure");
      },
    },
    async fetch() {
      if (++fetchCount === failFetch) throw originalError;
      return {
        ok: true,
        status: 200,
        type: "basic",
        url: "https://example.invalid/core",
        headers: {
          get() {
            return null;
          },
        },
        async blob() {
          return new Blob(["synthetic bytes"]);
        },
      };
    },
  });
  vm.runInContext(outputText, context, { filename: "media.cjs" });
  return {
    api: exports,
    originalError,
    instances,
    created,
    revoked,
    live,
    timers,
  };
}

function assertReleased(f, urls) {
  assert.deepEqual(f.revoked, urls);
  assert.equal(f.timers.size, 0);
  for (const url of urls) assert(!f.live.has(url));
}

test("wasm fetch failure releases acquired JavaScript and permits a fresh retry", async () => {
  const f = fixture({ failFetch: 2 });
  await assert.rejects(
    f.api.ensureFfmpeg(),
    (error) => error === f.originalError,
  );
  assert.equal(f.created.length, 1);
  assertReleased(f, f.created);
  assert.equal(f.instances[0].terminated, 1);
  assert.equal(f.instances[0].detached, 0);
  assert.equal(f.api.getFfmpegRuntimeStatus().coreMode, "not-loaded");
  const retried = await f.api.ensureFfmpeg();
  assert.equal(retried, f.instances[1]);
  assert.equal(f.live.size, 2);
  assertReleased(f, f.created.slice(0, 1));
});

test("worker fetch failure releases both multithread assets before fallback", async () => {
  const f = fixture({ threads: true, failFetch: 3 });
  const loaded = await f.api.ensureFfmpeg();
  assert.equal(loaded, f.instances[1]);
  assert.equal(f.instances[0].config, undefined);
  assert.equal(f.instances[0].terminated, 1);
  assert.equal(f.instances[0].detached, 0);
  assert.equal(f.created.length, 4);
  assertReleased(f, f.created.slice(0, 2));
  assert.equal(f.live.size, 2);
  assert.equal(f.api.getFfmpegRuntimeStatus().coreMode, "single-thread");
});

test("single-thread startup rejection detaches, terminates and releases both URLs", async () => {
  const f = fixture({ failLoad: 1 });
  await assert.rejects(
    f.api.ensureFfmpeg(),
    (error) => error === f.originalError,
  );
  assert.equal(f.created.length, 2);
  assertReleased(f, f.created);
  assert.equal(f.instances[0].detached, 1);
  assert.equal(f.instances[0].listeners.size, 0);
  assert.equal(f.instances[0].terminated, 1);
});

test("startup timer expiry releases a still-pending attempt", async () => {
  const f = fixture({ hangLoad: true });
  const pending = f.api.ensureFfmpeg();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.timers.size, 1);
  const rejection = assert.rejects(pending, /FFmpeg core startup timed out/);
  f.timers.values().next().value();
  await rejection;
  assert.equal(f.created.length, 2);
  assertReleased(f, f.created);
  assert.equal(f.instances[0].terminated, 1);
  assert.equal(f.instances[0].listeners.size, 0);
  assert.equal(f.api.getFfmpegRuntimeStatus().coreMode, "not-loaded");
});

test("failed multithread startup releases only its URLs when fallback succeeds", async () => {
  const f = fixture({ threads: true, failLoad: 1 });
  const loaded = await f.api.ensureFfmpeg();
  assert.equal(loaded, f.instances[1]);
  assert.equal(f.created.length, 5);
  assertReleased(f, Object.values(f.instances[0].config));
  assert.deepEqual([...f.live], Object.values(loaded.config));
  assert.equal(f.instances[0].listeners.size, 0);
  assert.equal(f.instances[0].terminated, 1);
  assert.equal(loaded.terminated, 0);
});

for (const threads of [false, true]) {
  test(`successful ${threads ? "multithread" : "single-thread"} load retains assets and reuses cached core`, async () => {
    const f = fixture({ threads });
    const loaded = await f.api.ensureFfmpeg();
    assert.equal(await f.api.ensureFfmpeg(), loaded);
    assert.equal(f.instances.length, 1);
    assert.equal(f.created.length, threads ? 3 : 2);
    assert.deepEqual([...f.live], f.created);
    assertReleased(f, []);
    assert.equal(loaded.listeners.size, 0);
    assert.equal(loaded.terminated, 0);
  });
}

test("cleanup errors neither mask the original failure nor skip later releases", async () => {
  const f = fixture({ failLoad: 1, cleanupThrows: true });
  await assert.rejects(
    f.api.ensureFfmpeg(),
    (error) => error === f.originalError,
  );
  assert.equal(f.instances[0].detached, 1);
  assert.equal(f.instances[0].terminated, 1);
  assert.equal(f.created.length, 2);
  assertReleased(f, f.created);
});
