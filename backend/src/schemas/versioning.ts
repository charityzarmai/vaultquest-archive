/**
 * Schema versioning and evolution guardrails (#schema-evolution)
 *
 * Provides:
 *  - Versioned schemas for stored records and API responses
 *  - Forward/backward compatibility validation
 *  - Safe handling of unknown/deprecated fields
 *  - Migration tooling
 */

import { z } from "zod";

// ─── Core versioning types ────────────────────────────────────────────────────

export interface SchemaVersion {
  readonly version: string;
  readonly deprecated?: boolean;
  readonly sunset?: string; // ISO date when version stops working
  readonly migration?: string; // URL/doc for migration guide
}

export interface VersionedSchema<T> {
  readonly schema: z.ZodType<T>;
  readonly version: SchemaVersion;
  readonly compatibleWith?: readonly string[]; // versions this can read
}

// ─── Built-in field handlers ─────────────────────────────────────────────────

/**
 * Strips unknown fields from an object, returning only validated shape.
 * Used for forward compatibility (new fields in old readers).
 */
export function stripUnknown<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  data: unknown
): z.infer<z.ZodObject<T>> | null {
  const result = schema.passthrough().safeParse(data);
  if (!result.success) return null;
  
  // Extract only schema-defined keys
  const validated: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    if (key in result.data) {
      validated[key] = result.data[key];
    }
  }
  return validated as z.infer<z.ZodObject<T>>;
}

/**
 * Validates data against schema, preserving unknown fields in `_unknown`.
 * Enables forward compatibility while maintaining data fidelity.
 */
export function parseWithUnknown<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  data: unknown
): { parsed: z.infer<z.ZodObject<T>>; unknown: Record<string, unknown> } | null {
  const result = schema.passthrough().safeParse(data);
  if (!result.success) return null;

  const parsed: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  const knownKeys = new Set(Object.keys(schema.shape));

  for (const [key, value] of Object.entries(result.data)) {
    if (knownKeys.has(key)) {
      parsed[key] = value;
    } else {
      unknown[key] = value;
    }
  }

  return {
    parsed: parsed as z.infer<z.ZodObject<T>>,
    unknown,
  };
}

// ─── Versioned ActionLedger payload schemas ──────────────────────────────────

const depositPayloadV1 = z.object({
  vault_id: z.string(),
  amount: z.string(),
  source_account: z.string().optional(),
});

const withdrawPayloadV1 = z.object({
  vault_id: z.string(),
  amount: z.string(),
  recipient: z.string(),
});

const depositPayloadV2 = depositPayloadV1.extend({
  memo: z.string().max(100).optional(),
  fee_tier: z.enum(["standard", "express"]).optional(),
});

const withdrawPayloadV2 = withdrawPayloadV1.extend({
  memo: z.string().max(100).optional(),
  priority: z.enum(["normal", "high"]).optional(),
});

export const ACTION_PAYLOAD_SCHEMAS = {
  deposit: {
    v1: {
      schema: depositPayloadV1,
      version: { version: "v1", deprecated: false },
      compatibleWith: ["v1", "v2"],
    } satisfies VersionedSchema<z.infer<typeof depositPayloadV1>>,
    v2: {
      schema: depositPayloadV2,
      version: { version: "v2", deprecated: false },
      compatibleWith: ["v1", "v2"],
    } satisfies VersionedSchema<z.infer<typeof depositPayloadV2>>,
  },
  withdraw: {
    v1: {
      schema: withdrawPayloadV1,
      version: { version: "v1", deprecated: false },
      compatibleWith: ["v1", "v2"],
    } satisfies VersionedSchema<z.infer<typeof withdrawPayloadV1>>,
    v2: {
      schema: withdrawPayloadV2,
      version: { version: "v2", deprecated: false },
      compatibleWith: ["v1", "v2"],
    } satisfies VersionedSchema<z.infer<typeof withdrawPayloadV2>>,
  },
} as const;

// ─── API response versioning ─────────────────────────────────────────────────

const actionResponseV1 = z.object({
  id: z.string().uuid(),
  wallet_address: z.string(),
  action_type: z.string(),
  status: z.string(),
  created_at: z.string().datetime(),
});

const actionResponseV2 = actionResponseV1.extend({
  finality_status: z.string(),
  confirmation_depth: z.number().nullable(),
});

export const API_RESPONSE_SCHEMAS = {
  action: {
    v1: {
      schema: actionResponseV1,
      version: { version: "v1", deprecated: true, sunset: "2027-01-01", migration: "/docs/api-v2-migration" },
      compatibleWith: ["v1"],
    } satisfies VersionedSchema<z.infer<typeof actionResponseV1>>,
    v2: {
      schema: actionResponseV2,
      version: { version: "v2", deprecated: false },
      compatibleWith: ["v2"],
    } satisfies VersionedSchema<z.infer<typeof actionResponseV2>>,
  },
} as const;

// ─── Compatibility validator ─────────────────────────────────────────────────

export interface CompatibilityIssue {
  field: string;
  issue: "missing_required" | "type_mismatch" | "unknown_field" | "deprecated_field";
  message: string;
}

export function validateCompatibility<T extends z.ZodRawShape>(
  sourceSchema: z.ZodObject<T>,
  targetSchema: z.ZodObject<T>,
  data: unknown
): { compatible: boolean; issues: CompatibilityIssue[] } {
  const issues: CompatibilityIssue[] = [];
  
  // Parse with source schema
  const sourceResult = sourceSchema.passthrough().safeParse(data);
  if (!sourceResult.success) {
    return { compatible: false, issues: [{ field: "_root", issue: "type_mismatch", message: "Failed to parse with source schema" }] };
  }

  // Attempt target schema parse
  const targetResult = targetSchema.safeParse(sourceResult.data);
  if (!targetResult.success) {
    for (const err of targetResult.error.errors) {
      issues.push({
        field: err.path.join("."),
        issue: err.code === "invalid_type" ? "type_mismatch" : "missing_required",
        message: err.message,
      });
    }
  }

  // Check for unknown fields in target
  const sourceKeys = new Set(Object.keys(sourceSchema.shape));
  const targetKeys = new Set(Object.keys(targetSchema.shape));
  
  for (const key of Object.keys(sourceResult.data)) {
    if (!targetKeys.has(key) && sourceKeys.has(key)) {
      issues.push({
        field: key,
        issue: "unknown_field",
        message: `Field '${key}' exists in source but not in target`,
      });
    }
  }

  return { compatible: issues.length === 0, issues };
}

// ─── Rollback-safe evolution helpers ─────────────────────────────────────────

/**
 * Safely reads a versioned payload, falling back through compatible versions.
 * Returns null for unreadable payloads (operational edge case: quarantine).
 */
export function readVersionedPayload<T>(
  payloadSchemas: Record<string, VersionedSchema<T>>,
  data: unknown,
  preferredVersion = "v2"
): { data: T; version: string; hadUnknownFields: boolean } | null {
  // Try preferred version first
  if (payloadSchemas[preferredVersion]) {
    const parsed = parseWithUnknown(payloadSchemas[preferredVersion].schema as z.ZodObject<z.ZodRawShape>, data);
    if (parsed) {
      return {
        data: parsed.parsed as T,
        version: preferredVersion,
        hadUnknownFields: Object.keys(parsed.unknown).length > 0,
      };
    }
  }

  // Fall back through compatible versions
  for (const [ver, versionedSchema] of Object.entries(payloadSchemas)) {
    if (ver === preferredVersion) continue;
    const parsed = parseWithUnknown(versionedSchema.schema as z.ZodObject<z.ZodRawShape>, data);
    if (parsed) {
      return {
        data: parsed.parsed as T,
        version: ver,
        hadUnknownFields: Object.keys(parsed.unknown).length > 0,
      };
    }
  }

  return null; // Unreadable payload
}

/**
 * Emits a response in the requested API version, downgrading if needed.
 */
export function emitVersionedResponse<T>(
  responseSchemas: Record<string, VersionedSchema<T>>,
  data: T,
  requestedVersion: string
): { response: unknown; version: string; downgraded: boolean } {
  const requested = responseSchemas[requestedVersion];
  
  if (!requested) {
    // Fallback to latest non-deprecated
    const latest = Object.entries(responseSchemas)
      .filter(([_, vs]) => !vs.version.deprecated)
      .pop();
    
    if (!latest) {
      throw new Error("No non-deprecated response schema available");
    }
    
    return {
      response: latest[1].schema.parse(data),
      version: latest[0],
      downgraded: true,
    };
  }

  // Check if sunset
  if (requested.version.sunset && new Date(requested.version.sunset) < new Date()) {
    throw new Error(`API version ${requestedVersion} is sunset. Migrate to newer version.`);
  }

  return {
    response: requested.schema.parse(data),
    version: requestedVersion,
    downgraded: false,
  };
}
