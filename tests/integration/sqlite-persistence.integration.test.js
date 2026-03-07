import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "../../apps/platform-api/src/server.js";
import {
  createBuyerState,
  hydrateBuyerState,
  serializeBuyerState
} from "../../packages/buyer-controller-core/src/index.js";
import {
  createSellerState,
  hydrateSellerState,
  serializeSellerState
} from "../../packages/seller-runtime-core/src/index.js";
import { createSqliteSnapshotStore } from "../../packages/sqlite-store/src/index.js";

describe("sqlite snapshot persistence", () => {
  const tempDirs = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  async function createStore(serviceName) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "croc-sqlite-"));
    tempDirs.push(tempDir);
    const store = await createSqliteSnapshotStore({
      databasePath: path.join(tempDir, "state.sqlite"),
      serviceName
    });
    await store.migrate();
    return store;
  }

  it("rehydrates platform snapshot", async () => {
    const store = await createStore("platform-api");
    const state = createPlatformState();
    state.metricsEvents.push({ event_type: "buyer.request.dispatched" });
    await store.saveSnapshot(serializePlatformState(state));

    const restored = createPlatformState();
    hydratePlatformState(restored, await store.loadSnapshot());

    expect(restored.catalog.size).toBeGreaterThan(0);
    expect(restored.metricsEvents).toHaveLength(1);
    store.close();
  });

  it("rehydrates buyer snapshot", async () => {
    const store = await createStore("buyer-controller");
    const state = createBuyerState();
    state.requests.set("req_sqlite_1", {
      request_id: "req_sqlite_1",
      status: "ACKED",
      timeline: [{ event: "ACKED" }]
    });
    await store.saveSnapshot(serializeBuyerState(state));

    const restored = createBuyerState();
    hydrateBuyerState(restored, await store.loadSnapshot());

    expect(restored.requests.get("req_sqlite_1")?.status).toBe("ACKED");
    store.close();
  });

  it("rehydrates seller snapshot", async () => {
    const store = await createStore("seller-controller");
    const state = createSellerState();
    state.tasks.set("task_sqlite_1", { task_id: "task_sqlite_1", request_id: "req_sqlite_1", status: "COMPLETED" });
    state.requestIndex.set("req_sqlite_1", "task_sqlite_1");
    await store.saveSnapshot(serializeSellerState(state));

    const restored = createSellerState();
    hydrateSellerState(restored, await store.loadSnapshot());

    expect(restored.tasks.get("task_sqlite_1")?.status).toBe("COMPLETED");
    expect(restored.requestIndex.get("req_sqlite_1")).toBe("task_sqlite_1");
    store.close();
  });
});
