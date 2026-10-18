# Schema Evolution Guardrails

This document describes VaultQuest's schema versioning system for stored records and public API responses.

## Overview

The schema evolution system provides:

1. **Versioned schemas** for action payloads and API responses
2. **Forward/backward compatibility** validation
3. **Safe handling** of unknown and deprecated fields
4. **Rollback safety** (old code can read new data, new code can read old data)
5. **Migration tooling** and sunset management

## Design Principles

### Compatibility Guarantees

- **Forward compatibility**: Old readers can process data from newer writers (by ignoring unknown fields)
- **Backward compatibility**: New readers can process data from older writers (by providing defaults)
- **Additive changes only**: New versions add optional fields; never remove required fields
- **Explicit breaking changes**: Breaking changes trigger a new major version with sunset timeline

### Failure Modes

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Unknown fields in stored payload | Preserved in `_unknown`, logged | Manual review/quarantine |
| Unreadable payload (corrupted) | `readVersionedPayload()` returns `null` | Quarantine via `PoisonEvent` |
| Sunset version requested | Throw with migration URL | Client must upgrade |
| Type mismatch (schema drift) | Validation fails, quarantine | Manual repair via `runRepairCommand` |

## Versioned Schemas

### Action Payloads

Action payloads are stored in `ActionLedger.actionPayload` as JSON. We support multiple versions:

#### Deposit Payload

**v1** (deprecated: false)
```typescript
{
  vault_id: string;
  amount: string;
  source_account?: string;
}
```

**v2** (current)
```typescript
{
  vault_id: string;
  amount: string;
  source_account?: string;
  memo?: string;          // New in v2
  fee_tier?: "standard" | "express"; // New in v2
}
```

**Compatibility**: v1 readers can process v2 data (ignore `memo`/`fee_tier`). v2 readers can process v1 data (optional fields).

#### Withdraw Payload

**v1** (deprecated: false)
```typescript
{
  vault_id: string;
  amount: string;
  recipient: string;
}
```

**v2** (current)
```typescript
{
  vault_id: string;
  amount: string;
  recipient: string;
  memo?: string;           // New in v2
  priority?: "normal" | "high"; // New in v2
}
```

### API Responses

API responses are serialized at the HTTP boundary. Clients specify version via `Accept-Version` header.

#### Action Response

**v1** (deprecated: true, sunset: 2027-01-01)
```typescript
{
  id: string;
  wallet_address: string;
  action_type: string;
  status: string;
  created_at: string;
}
```

**v2** (current)
```typescript
{
  id: string;
  wallet_address: string;
  action_type: string;
  status: string;
  created_at: string;
  finality_status: string;       // New in v2
  confirmation_depth: number | null; // New in v2
}
```

**Migration**: See `/docs/api-v2-migration` for client upgrade guide.

## Usage

### Reading Stored Payloads

```typescript
import { readVersionedPayload, ACTION_PAYLOAD_SCHEMAS } from "../schemas/versioning.js";

const payload = await prisma.actionLedger.findUnique({ where: { id } });
const parsed = readVersionedPayload(
  ACTION_PAYLOAD_SCHEMAS.deposit,
  payload.actionPayload,
  "v2" // preferred version
);

if (!parsed) {
  // Unreadable payload — quarantine
  await quarantineAction(id, "schema_parse_failure");
  return;
}

if (parsed.hadUnknownFields) {
  logger.warn({ actionId: id, version: parsed.version }, "action payload has unknown fields");
}

// Use parsed.data safely
const vaultId = parsed.data.vault_id;
```

### Emitting API Responses

```typescript
import { emitVersionedResponse, API_RESPONSE_SCHEMAS } from "../schemas/versioning.js";

const requestedVersion = req.headers["accept-version"] ?? "v2";
const action = await ledger.getAction(id);

const { response, version, downgraded } = emitVersionedResponse(
  API_RESPONSE_SCHEMAS.action,
  action,
  requestedVersion
);

if (downgraded) {
  res.header("X-API-Version-Fallback", "true");
}
res.header("X-API-Version", version);
res.send(response);
```

### Validating Compatibility

```typescript
import { validateCompatibility } from "../schemas/versioning.js";
import { depositPayloadV1, depositPayloadV2 } from "../schemas/versioning.js";

const v1Schema = depositPayloadV1;
const v2Schema = depositPayloadV2;
const data = { vault_id: "vault-123", amount: "100" };

const result = validateCompatibility(v1Schema, v2Schema, data);

if (!result.compatible) {
  console.log("Compatibility issues:", result.issues);
  // [{ field: "memo", issue: "unknown_field", message: "..." }]
}
```

## Migration Workflow

### Adding a New Field (Non-Breaking)

1. Define new schema version:
   ```typescript
   const depositPayloadV3 = depositPayloadV2.extend({
     settlement_delay_hours: z.number().int().min(0).max(72).optional(),
   });
   ```

2. Add to `ACTION_PAYLOAD_SCHEMAS`:
   ```typescript
   export const ACTION_PAYLOAD_SCHEMAS = {
     deposit: {
       v1: { ... },
       v2: { ... },
       v3: {
         schema: depositPayloadV3,
         version: { version: "v3", deprecated: false },
         compatibleWith: ["v1", "v2", "v3"],
       },
     },
   };
   ```

3. Write compatibility test covering v2 → v3 and v3 → v2.

4. Deploy: old code ignores new field, new code handles missing field.

### Breaking Change (Requires Sunset)

1. Define new major version (e.g., `v3` removes `source_account`):
   ```typescript
   const depositPayloadV3 = z.object({
     vault_id: z.string(),
     amount: z.string(),
     // source_account removed
   });
   ```

2. Mark old version deprecated with sunset date:
   ```typescript
   v2: {
     schema: depositPayloadV2,
     version: { 
       version: "v2", 
       deprecated: true, 
       sunset: "2027-06-01",
       migration: "/docs/deposit-v3-migration"
     },
   }
   ```

3. Communicate sunset timeline to clients (6+ months).

4. After sunset, `emitVersionedResponse()` throws for v2 requests.

## Operational Edge Cases

### Corrupted Payloads

**Symptom**: `readVersionedPayload()` returns `null`.

**Recovery**:
1. Quarantine action via `PoisonEvent` table.
2. Retrieve raw JSON from `ActionLedger.actionPayload`.
3. Manual repair through `runRepairCommand` or direct DB fix.
4. Re-run indexer over the ledger range if event data is source of truth.

### Schema Drift (Type Mismatch)

**Symptom**: `validateCompatibility()` reports `type_mismatch`.

**Recovery**:
1. Identify drift source (bug in writer, data corruption, incompatible deploy).
2. Run reconciliation: `reconciler.detectDrift()` flags contradictions.
3. Apply repair via `runRepairCommand(apply: true, targets: ["contradiction"])`.
4. If drift is financial, escalate to `manual_review` state.

### Unknown Fields Accumulating

**Symptom**: `parsed.hadUnknownFields === true` for many actions.

**Root cause**: Rollback to older code after deploying v3 writers.

**Recovery**:
1. Redeploy v3 code to restore forward compatibility.
2. Unknown fields are inert; no immediate data loss.
3. Optional: backfill known records with `stripUnknown()` + update.

## Rollback Strategy

### Scenario: Deploy v3, then rollback to v2

**Safe because**:
- v2 readers use `readVersionedPayload()` → fallback to v2 schema.
- Unknown v3 fields preserved in DB, ignored by v2 code.
- No data loss; v3 can be redeployed later.

**Failure mode**:
- If v3 removed a required field, v2 readers fail validation → quarantine.
- Solution: Don't remove required fields; only add optional ones.

### Scenario: API client on v1, server on v2

**Safe because**:
- `emitVersionedResponse()` downgrades to v1 when requested.
- Client doesn't see new fields.
- Server logs deprecation warning.

**Sunset enforcement**:
- After sunset date, server throws `API version v1 is sunset`.
- Client must upgrade to v2 before sunset.

## Testing

Run schema evolution tests:
```bash
npm test -- tests/versioning.spec.ts
```

Coverage:
- ✅ Forward compatibility (v1 reads v2 data)
- ✅ Backward compatibility (v2 reads v1 data)
- ✅ Unknown field detection
- ✅ Compatibility validation (missing fields, type mismatches)
- ✅ Rollback safety
- ✅ Deprecated version handling

## References

- Implementation: `backend/src/schemas/versioning.ts`
- Tests: `backend/tests/versioning.spec.ts`
- Error taxonomy: `backend/src/errorTaxonomy.ts`
- Reconciliation: `backend/docs/ONCHAIN_DRIFT_RUNBOOK.md`
