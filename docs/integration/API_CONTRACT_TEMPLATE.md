# API contract template

Fill-in-the-blank templates for documenting real endpoints/events once they're confirmed — either endpoints the Customer App exposes for Duo-Face to call, or endpoints/events Duo-Face's own server exposes. **No endpoint names, paths, or payloads below are real** — copy a template and fill it in only once the actual contract is confirmed (see `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`).

---

## Authentication

```
METHOD:
PATH:
AUTH:
REQUEST:
RESPONSE:
ERRORS:
```

## Merchant

```
METHOD:
PATH:
AUTH/ROLE:
REQUEST:
RESPONSE:
```

## Driver

```
METHOD:
PATH:
AUTH/ROLE:
REQUEST:
RESPONSE:
```

## Orders

```
METHOD:
PATH:
AUTH/ROLE:
REQUEST:
RESPONSE:
STATE TRANSITIONS:
```

## Inventory

```
METHOD:
PATH:
AUTH/ROLE:
REQUEST:
RESPONSE:
CONCURRENCY/ATOMICITY:
```

## Realtime

```
EVENT:
DIRECTION:
AUTH:
PAYLOAD:
ROOM/CHANNEL:
TRIGGER:
```

---

## Usage

- One filled-in block per real endpoint/event — don't merge multiple endpoints into one block.
- `STATE TRANSITIONS` (Orders) should reference the allowed-transition map once `services/orderState` exists (CLAUDE.md) — not duplicate it here.
- `CONCURRENCY/ATOMICITY` (Inventory) should describe the actual mechanism the Customer App (or Duo-Face's own DB) uses once confirmed — e.g. an atomic `findOneAndUpdate`, a DB transaction, an optimistic lock. Don't assume CLAUDE.md's `$inc`/`$gte` pattern applies to a system whose database engine isn't confirmed yet.
- `ROOM/CHANNEL` (Realtime) should use Duo-Face's own convention from CLAUDE.md (`merchant:<storeId>`, `driver:<driverId>`, `order:<orderId>`, `store:<storeId>`) for events Duo-Face's server emits; for events consumed *from* the Customer App, document its actual channel naming instead of assuming this convention applies there too.
