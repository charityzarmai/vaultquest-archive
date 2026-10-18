/**
 * Admin endpoints for schema validation and compatibility checking
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ok } from "../../responses.js";
import {
  ACTION_PAYLOAD_SCHEMAS,
  validateCompatibility,
  readVersionedPayload,
  type CompatibilityIssue,
} from "../../schemas/versioning.js";
import type { PrismaClient } from "@prisma/client";

export type SchemaValidationGuards = {
  adminRead: preHandlerHookHandler;
};

const validatePayloadBody = z.object({
  actionType: z.enum(["deposit", "withdraw"]),
  payload: z.record(z.unknown()),
  version: z.string().optional(),
});

const compatibilityCheckBody = z.object({
  actionType: z.enum(["deposit", "withdraw"]),
  sourceVersion: z.string(),
  targetVersion: z.string(),
  samplePayload: z.record(z.unknown()),
});

const scanBody = z.object({
  actionType: z.enum(["deposit", "withdraw"]).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});

interface PayloadValidationResult {
  valid: boolean;
  version: string | null;
  hadUnknownFields: boolean;
  errors?: string[];
}

interface CompatibilityCheckResult {
  compatible: boolean;
  issues: CompatibilityIssue[];
}

interface ScanResult {
  scanned: number;
  unreadable: number;
  withUnknownFields: number;
  versionDistribution: Record<string, number>;
  samples: Array<{
    actionId: string;
    version: string | null;
    hadUnknownFields: boolean;
  }>;
}

export const schemaValidationRoutes = (
  prisma: PrismaClient,
  guards: SchemaValidationGuards
): FastifyPluginAsync =>
  async (app) => {
    /**
     * POST /admin/schema/validate-payload
     * 
     * Validates an action payload against versioned schemas.
     */
    app.post("/admin/schema/validate-payload", { preHandler: [guards.adminRead] }, async (req) => {
      const body = validatePayloadBody.parse(req.body);
      const schemas = ACTION_PAYLOAD_SCHEMAS[body.actionType];

      const result = readVersionedPayload(
        schemas as any,
        body.payload,
        body.version ?? "v2"
      );

      if (!result) {
        return ok<PayloadValidationResult>({
          valid: false,
          version: null,
          hadUnknownFields: false,
          errors: ["Payload could not be parsed by any supported schema version"],
        });
      }

      return ok<PayloadValidationResult>({
        valid: true,
        version: result.version,
        hadUnknownFields: result.hadUnknownFields,
      });
    });

    /**
     * POST /admin/schema/check-compatibility
     * 
     * Checks compatibility between two schema versions for a given payload.
     */
    app.post("/admin/schema/check-compatibility", { preHandler: [guards.adminRead] }, async (req) => {
      const body = compatibilityCheckBody.parse(req.body);
      const schemas = ACTION_PAYLOAD_SCHEMAS[body.actionType];

      const sourceSchema = (schemas as any)[body.sourceVersion]?.schema;
      const targetSchema = (schemas as any)[body.targetVersion]?.schema;

      if (!sourceSchema || !targetSchema) {
        return ok<CompatibilityCheckResult>({
          compatible: false,
          issues: [
            {
              field: "_root",
              issue: "missing_required",
              message: `Schema version not found: ${!sourceSchema ? body.sourceVersion : body.targetVersion}`,
            },
          ],
        });
      }

      const result = validateCompatibility(sourceSchema, targetSchema, body.samplePayload);

      return ok<CompatibilityCheckResult>({
        compatible: result.compatible,
        issues: result.issues,
      });
    });

    /**
     * POST /admin/schema/scan-payloads
     * 
     * Scans ActionLedger for schema validation issues.
     */
    app.post("/admin/schema/scan-payloads", { preHandler: [guards.adminRead] }, async (req) => {
      const body = scanBody.parse(req.body);

      const actions = await prisma.actionLedger.findMany({
        where: body.actionType ? { actionType: body.actionType } : undefined,
        select: {
          id: true,
          actionType: true,
          actionPayload: true,
        },
        take: body.limit,
        orderBy: { createdAt: "desc" },
      });

      let unreadable = 0;
      let withUnknownFields = 0;
      const versionDistribution: Record<string, number> = {};
      const samples: ScanResult["samples"] = [];

      for (const action of actions) {
        const actionType = action.actionType as "deposit" | "withdraw";
        const schemas = ACTION_PAYLOAD_SCHEMAS[actionType];

        if (!schemas) {
          unreadable++;
          continue;
        }

        const result = readVersionedPayload(schemas as any, action.actionPayload);

        if (!result) {
          unreadable++;
          samples.push({
            actionId: action.id,
            version: null,
            hadUnknownFields: false,
          });
        } else {
          versionDistribution[result.version] = (versionDistribution[result.version] ?? 0) + 1;
          
          if (result.hadUnknownFields) {
            withUnknownFields++;
          }

          if (samples.length < 10) {
            samples.push({
              actionId: action.id,
              version: result.version,
              hadUnknownFields: result.hadUnknownFields,
            });
          }
        }
      }

      return ok<ScanResult>({
        scanned: actions.length,
        unreadable,
        withUnknownFields,
        versionDistribution,
        samples,
      });
    });
  };
