import { Readable } from "node:stream";
import { Actor } from "apify";
import type { SnapshotStore } from "./automation.js";

type ApifyStore = Awaited<ReturnType<typeof Actor.openKeyValueStore>>;

interface StreamingStoreClient {
  getRecord(key: string, options?: { stream?: boolean }): Promise<{ value?: unknown } | undefined>;
}

function asReadable(key: string, value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (Buffer.isBuffer(value)) return Readable.from(value);
  if (value instanceof Uint8Array) return Readable.from(Buffer.from(value));
  if (typeof value === "string") return Readable.from(Buffer.from(value));
  throw new Error(`Key-value record "${key}" does not contain file bytes.`);
}

/** Adapts an Apify key-value store. File bodies are streamed on write and requested as a stream on read. */
export function snapshotStoreFromApify(store: ApifyStore): SnapshotStore {
  return {
    async putJson(key, value) {
      await store.setValue(key, value as never);
    },
    async getJson<T>(key: string): Promise<T | null> {
      const value = await store.getValue<T>(key);
      return value ?? null;
    },
    async putFile(key, source) {
      await store.setValue(key, source, { contentType: "application/octet-stream" });
    },
    async getFile(key) {
      const client = (store as unknown as { client?: StreamingStoreClient }).client;
      if (client && typeof client.getRecord === "function") {
        const record = await client.getRecord(key, { stream: true });
        if (!record || record.value == null) return null;
        return asReadable(key, record.value);
      }
      const value = await store.getValue(key);
      if (value == null) return null;
      return asReadable(key, value);
    },
    async delete(key) {
      await store.setValue(key, null);
    },
  };
}

export async function openApifySnapshotStore(storeId?: string): Promise<SnapshotStore> {
  const store = storeId ? await Actor.openKeyValueStore(storeId) : await Actor.openKeyValueStore();
  return snapshotStoreFromApify(store);
}

export const apifyDataset = {
  async push(item: Record<string, unknown>): Promise<void> {
    await Actor.pushData(item);
  },
};
