/**
 * Schema evolution guardrails tests (#schema-evolution)
 */

import { describe, it, expect } from "vitest";
import {
  stripUnknown,
  parseWithUnknown,
  validateCompatibility,
  readVersionedPayload,
  emitVersionedResponse,
  ACTION_PAYLOAD_SCHEMAS,
  API_RESPONSE_SCHEMAS,
} from "../src/schemas/versioning.js";
import { z } from "zod";

describe("Schema Evolution Guardrails", () => {
  describe("stripUnknown", () => {
    it("removes unknown fields from valid data", () => {
      const schema = z.object({ a: z.string(), b: z.number() });
      const data = { a: "test", b: 42, c: "unknown" };
      const result = stripUnknown(schema, data);
      
      expect(result).toEqual({ a: "test", b: 42 });
      expect(result).not.toHaveProperty("c");
    });

    it("returns null for invalid data", () => {
      const schema = z.object({ a: z.string() });
      const result = stripUnknown(schema, { a: 123 });
      
      expect(result).toBeNull();
    });

    it("handles nested objects", () => {
      const schema = z.object({
        name: z.string(),
        nested: z.object({ value: z.number() }),
      });
      const data = {
        name: "test",
        nested: { value: 10, extra: "ignored" },
        unknown: "field",
      };
      const result = stripUnknown(schema, data);
      
      expect(result).toEqual({ name: "test", nested: { value: 10, extra: "ignored" } });
    });
  });

  describe("parseWithUnknown", () => {
    it("separates known and unknown fields", () => {
      const schema = z.object({ a: z.string(), b: z.number() });
      const data = { a: "test", b: 42, c: "new_field", d: true };
      const result = parseWithUnknown(schema, data);
      
      expect(result).not.toBeNull();
      expect(result!.parsed).toEqual({ a: "test", b: 42 });
      expect(result!.unknown).toEqual({ c: "new_field", d: true });
    });

    it("returns null for invalid core schema", () => {
      const schema = z.object({ a: z.string() });
      const result = parseWithUnknown(schema, { a: 123, b: "extra" });
      
      expect(result).toBeNull();
    });

    it("handles data with no unknown fields", () => {
      const schema = z.object({ a: z.string() });
      const data = { a: "test" };
      const result = parseWithUnknown(schema, data);
      
      expect(result).not.toBeNull();
      expect(result!.parsed).toEqual({ a: "test" });
      expect(result!.unknown).toEqual({});
    });
  });

  describe("validateCompatibility", () => {
    it("detects missing required fields", () => {
      const v1 = z.object({ a: z.string() });
      const v2 = z.object({ a: z.string(), b: z.string() });
      const data = { a: "test" };
      
      const result = validateCompatibility(v1, v2, data);
      
      expect(result.compatible).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].field).toBe("b");
      expect(result.issues[0].issue).toBe("missing_required");
    });

    it("detects type mismatches", () => {
      const v1 = z.object({ a: z.string() });
      const v2 = z.object({ a: z.number() });
      const data = { a: "test" };
      
      const result = validateCompatibility(v1, v2, data);
      
      expect(result.compatible).toBe(false);
      expect(result.issues.some(i => i.issue === "type_mismatch")).toBe(true);
    });

    it("detects unknown fields in target", () => {
      const v1 = z.object({ a: z.string(), b: z.string() });
      const v2 = z.object({ a: z.string() });
      const data = { a: "test", b: "extra" };
      
      const result = validateCompatibility(v1, v2, data);
      
      expect(result.issues.some(i => i.issue === "unknown_field" && i.field === "b")).toBe(true);
    });

    it("passes for compatible schemas", () => {
      const v1 = z.object({ a: z.string(), b: z.string().optional() });
      const v2 = z.object({ a: z.string() });
      const data = { a: "test" };
      
      const result = validateCompatibility(v1, v2, data);
      
      expect(result.compatible).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("readVersionedPayload - deposit", () => {
    it("reads v1 deposit payload", () => {
      const data = { vault_id: "vault-123", amount: "100", source_account: "GABC..." };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, data, "v1");
      
      expect(result).not.toBeNull();
      expect(result!.data.vault_id).toBe("vault-123");
      expect(result!.version).toBe("v1");
      expect(result!.hadUnknownFields).toBe(false);
    });

    it("reads v2 deposit payload with new fields", () => {
      const data = {
        vault_id: "vault-123",
        amount: "100",
        memo: "birthday gift",
        fee_tier: "express",
      };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, data, "v2");
      
      expect(result).not.toBeNull();
      expect(result!.data.vault_id).toBe("vault-123");
      expect(result!.data.memo).toBe("birthday gift");
      expect(result!.version).toBe("v2");
      expect(result!.hadUnknownFields).toBe(false);
    });

    it("falls back to v1 when v2 parse fails", () => {
      const data = { vault_id: "vault-123", amount: "100" };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, data, "v2");
      
      expect(result).not.toBeNull();
      expect(result!.version).toBe("v1"); // Fell back
    });

    it("detects unknown fields (forward compatibility)", () => {
      const data = {
        vault_id: "vault-123",
        amount: "100",
        future_field: "from v3",
      };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, data, "v2");
      
      expect(result).not.toBeNull();
      expect(result!.hadUnknownFields).toBe(true);
    });

    it("returns null for unreadable payloads", () => {
      const data = { invalid: "structure" };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, data, "v2");
      
      expect(result).toBeNull();
    });
  });

  describe("readVersionedPayload - withdraw", () => {
    it("reads v1 withdraw payload", () => {
      const data = {
        vault_id: "vault-456",
        amount: "50",
        recipient: "GXYZ...",
      };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.withdraw, data, "v1");
      
      expect(result).not.toBeNull();
      expect(result!.data.vault_id).toBe("vault-456");
      expect(result!.data.recipient).toBe("GXYZ...");
      expect(result!.version).toBe("v1");
    });

    it("reads v2 withdraw with priority field", () => {
      const data = {
        vault_id: "vault-456",
        amount: "50",
        recipient: "GXYZ...",
        priority: "high",
        memo: "urgent",
      };
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.withdraw, data, "v2");
      
      expect(result).not.toBeNull();
      expect(result!.data.priority).toBe("high");
      expect(result!.version).toBe("v2");
    });
  });

  describe("emitVersionedResponse", () => {
    it("emits requested v1 response", () => {
      const data = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        wallet_address: "GABC...",
        action_type: "deposit",
        status: "confirmed",
        created_at: "2026-10-18T12:00:00Z",
      };
      const result = emitVersionedResponse(API_RESPONSE_SCHEMAS.action, data, "v1");
      
      expect(result.version).toBe("v1");
      expect(result.downgraded).toBe(false);
      expect(result.response).toHaveProperty("id");
      expect(result.response).not.toHaveProperty("finality_status");
    });

    it("emits v2 response with finality fields", () => {
      const data = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        wallet_address: "GABC...",
        action_type: "deposit",
        status: "confirmed",
        created_at: "2026-10-18T12:00:00Z",
        finality_status: "finalized",
        confirmation_depth: 10,
      };
      const result = emitVersionedResponse(API_RESPONSE_SCHEMAS.action, data, "v2");
      
      expect(result.version).toBe("v2");
      expect(result.downgraded).toBe(false);
      expect(result.response).toHaveProperty("finality_status");
    });

    it("downgrades to latest non-deprecated when unknown version requested", () => {
      const data = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        wallet_address: "GABC...",
        action_type: "deposit",
        status: "confirmed",
        created_at: "2026-10-18T12:00:00Z",
        finality_status: "finalized",
        confirmation_depth: 5,
      };
      const result = emitVersionedResponse(API_RESPONSE_SCHEMAS.action, data, "v99");
      
      expect(result.version).toBe("v2");
      expect(result.downgraded).toBe(true);
    });
  });

  describe("Rollback safety", () => {
    it("v1 reader can handle v2 data (forward compat)", () => {
      const v2Data = {
        vault_id: "vault-123",
        amount: "100",
        memo: "note",
        fee_tier: "express",
      };
      
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, v2Data, "v1");
      
      expect(result).not.toBeNull();
      expect(result!.version).toBe("v1"); // Successfully fell back
      expect(result!.hadUnknownFields).toBe(true); // Detected extra fields
    });

    it("v2 reader can handle v1 data (backward compat)", () => {
      const v1Data = { vault_id: "vault-123", amount: "100" };
      
      const result = readVersionedPayload(ACTION_PAYLOAD_SCHEMAS.deposit, v1Data, "v2");
      
      expect(result).not.toBeNull();
      expect(result!.data.vault_id).toBe("vault-123");
      // v2 optional fields are absent, no error
    });
  });

  describe("Deprecated version handling", () => {
    it("emits warning metadata for deprecated versions", () => {
      const data = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        wallet_address: "GABC...",
        action_type: "deposit",
        status: "confirmed",
        created_at: "2026-10-18T12:00:00Z",
      };
      
      const versionMeta = API_RESPONSE_SCHEMAS.action.v1.version;
      expect(versionMeta.deprecated).toBe(true);
      expect(versionMeta.sunset).toBe("2027-01-01");
      expect(versionMeta.migration).toBe("/docs/api-v2-migration");
    });
  });
});
