/**
 * API versioning middleware tests
 */

import { describe, it, expect } from "vitest";
import { extractVersion, checkDeprecation } from "../../src/middleware/apiVersioning.js";

describe("API Versioning Middleware", () => {
  describe("extractVersion", () => {
    it("extracts version from accept-version header", () => {
      const req = {
        headers: { "accept-version": "v2" },
        log: { warn: () => {} },
      } as any;

      const version = extractVersion(req);
      expect(version).toBe("v2");
    });

    it("normalizes version without v prefix", () => {
      const req = {
        headers: { "accept-version": "1" },
        log: { warn: () => {} },
      } as any;

      const version = extractVersion(req);
      expect(version).toBe("v1");
    });

    it("uses default when header missing", () => {
      const req = {
        headers: {},
        log: { warn: () => {} },
      } as any;

      const version = extractVersion(req);
      expect(version).toBe("v2");
    });

    it("uses default for unsupported version", () => {
      const req = {
        headers: { "accept-version": "v99" },
        log: { warn: () => {} },
      } as any;

      const version = extractVersion(req);
      expect(version).toBe("v2");
    });

    it("respects custom default version", () => {
      const req = {
        headers: {},
        log: { warn: () => {} },
      } as any;

      const version = extractVersion(req, {
        defaultVersion: "v1",
        supportedVersions: ["v1", "v2"],
      });
      expect(version).toBe("v1");
    });
  });

  describe("checkDeprecation", () => {
    it("adds deprecation headers for v1", () => {
      const headers: Record<string, string> = {};
      const req = {
        log: { warn: () => {} },
      } as any;
      const reply = {
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      } as any;

      checkDeprecation("v1", req, reply);

      expect(headers["X-API-Version-Deprecated"]).toBe("true");
      expect(headers["X-API-Version-Sunset"]).toBe("2027-01-01");
      expect(headers["X-API-Version-Migration"]).toBe("/docs/api-v2-migration");
    });

    it("does not add deprecation headers for v2", () => {
      const headers: Record<string, string> = {};
      const req = {
        log: { warn: () => {} },
      } as any;
      const reply = {
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      } as any;

      checkDeprecation("v2", req, reply);

      expect(headers["X-API-Version-Deprecated"]).toBeUndefined();
    });

    it("throws for sunset versions", () => {
      const req = {
        log: { warn: () => {} },
      } as any;
      const reply = {
        header: () => {},
      } as any;

      // Mock future date to simulate sunset
      const originalDateNow = Date.now;
      Date.now = () => new Date("2028-01-01").getTime();

      expect(() => {
        checkDeprecation("v1", req, reply);
      }).toThrow(/no longer supported/);

      Date.now = originalDateNow;
    });
  });
});
