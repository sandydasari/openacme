import { describe, it, expect, beforeEach } from "vitest";
import { WasmDatabase } from "../src/wasm/adapter.js";
import { applySchema } from "../src/connection.js";
import {
  createAuthStore,
  LOCAL_OPERATOR_EMAIL,
} from "../src/stores/auth-store.js";

function freshStore() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return createAuthStore(db);
}

describe("AuthStore — local-trusted auto-session", () => {
  let store: ReturnType<typeof createAuthStore>;

  beforeEach(() => {
    store = freshStore();
  });

  it("ensureLocalSession creates the operator once and mints a usable session", () => {
    expect(store.countMembers()).toBe(0);
    const token = store.ensureLocalSession();
    const member = store.resolveSession(token);
    expect(member?.email).toBe(LOCAL_OPERATOR_EMAIL);
    expect(store.countMembers()).toBe(1);

    // Second call reuses the same member (no duplicate row).
    const token2 = store.ensureLocalSession();
    expect(store.countMembers()).toBe(1);
    expect(store.resolveSession(token2)?.id).toBe(member?.id);
  });

  it("the local operator cannot be logged into via the password form", () => {
    store.ensureLocalSession();
    // The password is random and never surfaced.
    expect(store.verifyPassword(LOCAL_OPERATOR_EMAIL, "")).toBeNull();
    expect(store.verifyPassword(LOCAL_OPERATOR_EMAIL, "password")).toBeNull();
  });

  it("deleteLocalOperator removes the member and cascades its sessions", () => {
    const token = store.ensureLocalSession();
    expect(store.resolveSession(token)).not.toBeNull();
    store.deleteLocalOperator();
    expect(store.countMembers()).toBe(0);
    // The cookie can no longer be replayed.
    expect(store.resolveSession(token)).toBeNull();
  });

  it("deleteLocalOperator is a no-op when no operator exists", () => {
    expect(() => store.deleteLocalOperator()).not.toThrow();
    expect(store.countMembers()).toBe(0);
  });

  it("isLocalOperatorEmail matches case/space-insensitively", () => {
    expect(store.isLocalOperatorEmail("  Local@Localhost ")).toBe(true);
    expect(store.isLocalOperatorEmail("founder@example.com")).toBe(false);
  });
});
