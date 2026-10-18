/**
 * API versioning middleware for Fastify
 * 
 * Adds version negotiation to routes via Accept-Version header.
 * Logs deprecation warnings for sunset versions.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import { API_RESPONSE_SCHEMAS } from "../schemas/versioning.js";

export interface VersioningOptions {
  defaultVersion?: string;
  supportedVersions: readonly string[];
  headerName?: string;
}

const DEFAULT_OPTIONS: VersioningOptions = {
  defaultVersion: "v2",
  supportedVersions: ["v1", "v2"],
  headerName: "accept-version",
};

/**
 * Extract requested API version from header, falling back to default.
 */
export function extractVersion(req: FastifyRequest, options = DEFAULT_OPTIONS): string {
  const headerName = options.headerName ?? "accept-version";
  const requested = req.headers[headerName] as string | undefined;
  
  if (!requested) {
    return options.defaultVersion ?? "v2";
  }

  // Normalize version format (accept "1", "v1", "2.0", "v2.0")
  const normalized = requested.toLowerCase().startsWith("v") 
    ? requested.toLowerCase() 
    : `v${requested}`;

  // Validate against supported versions
  if (options.supportedVersions.includes(normalized)) {
    return normalized;
  }

  // Invalid version → use default
  req.log.warn({ requestedVersion: requested, defaultVersion: options.defaultVersion }, 
    "unsupported API version requested, using default");
  
  return options.defaultVersion ?? "v2";
}

/**
 * Checks if the requested version is deprecated and logs warning with sunset info.
 */
export function checkDeprecation(
  version: string,
  req: FastifyRequest,
  reply: FastifyReply
): void {
  // Check action response schemas for deprecation info
  const versionMeta = (API_RESPONSE_SCHEMAS.action as any)[version]?.version;
  
  if (versionMeta?.deprecated) {
    const sunsetDate = versionMeta.sunset ? new Date(versionMeta.sunset) : null;
    const now = new Date();
    const isSunset = sunsetDate && sunsetDate < now;

    req.log.warn({
      version,
      deprecated: true,
      sunset: versionMeta.sunset,
      isSunset,
      migration: versionMeta.migration,
      walletAddress: (req as any).principal?.walletAddress,
    }, "deprecated API version in use");

    // Add deprecation headers
    reply.header("X-API-Version-Deprecated", "true");
    if (versionMeta.sunset) {
      reply.header("X-API-Version-Sunset", versionMeta.sunset);
    }
    if (versionMeta.migration) {
      reply.header("X-API-Version-Migration", versionMeta.migration);
    }

    // If past sunset, reject the request
    if (isSunset) {
      throw new Error(
        `API version ${version} is no longer supported (sunset ${versionMeta.sunset}). ` +
        `Please upgrade to a current version. Migration guide: ${versionMeta.migration ?? "/docs/api-migration"}`
      );
    }
  }
}

/**
 * Fastify preHandler hook that extracts and validates API version.
 * Attaches version to request.apiVersion for downstream handlers.
 */
export const versioningHook = (options?: Partial<VersioningOptions>): preHandlerHookHandler => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const version = extractVersion(req, opts);
    
    // Attach to request for route handlers
    (req as any).apiVersion = version;
    
    // Check deprecation and add headers
    checkDeprecation(version, req, reply);
    
    // Always include version in response
    reply.header("X-API-Version", version);
  };
};

/**
 * Helper to get API version from request (set by versioningHook).
 */
export function getApiVersion(req: FastifyRequest): string {
  return (req as any).apiVersion ?? "v2";
}
