"""
sync_service.py — hands offline operations pushed by field devices to the
database.

Called by POST /sync/push in app.py. Contract (matches static/js/sync-queue.js):

    request:  {"device_id": "...", "operations": [
                 {"client_op_id", "entity_type", "entity_id", "operation",
                  "base_version", "payload", "client_timestamp"}, ...]}
    response: {"results": [
                 {"client_op_id", "status": "applied" | "conflict" | "rejected",
                  "result_version"?, "server_snapshot"?, "error"?}, ...]}

All rules live in the Postgres function public.apply_sync_batch()
(database/migrations/002_atomic_sync.sql), so that each operation's data
change and its sync_logs row are written in ONE transaction:

  * Atomic: a change is never saved without its log entry, or vice versa.
  * Idempotent: a replayed client_op_id is answered from sync_logs.
  * Optimistic concurrency: base_version must match the row's version
    (row locked with FOR UPDATE), otherwise "conflict" + server snapshot.
  * Ownership: the user is auth.uid() from the caller's JWT, never taken
    from the request; owner columns are forced to it.
"""

import httpx
from postgrest.exceptions import APIError

MAX_OPERATIONS_PER_PUSH = 100

# Postgres error codes raised by apply_sync_batch() for request problems.
_FORBIDDEN_CODES = {"42501", "28000"}
_BAD_REQUEST_CODES = {"22023"}


class TransientSyncError(Exception):
    """Database could not be reached; the client should retry later."""


class SyncRequestError(Exception):
    """The request as a whole was refused (bad input or not allowed)."""

    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def process_operations(client, device_id, operations):
    """Apply up to MAX_OPERATIONS_PER_PUSH operations atomically per op.

    `client` must be authenticated as the user (get_user_db()) so that
    auth.uid() inside the database is that user.
    """
    batch = list(operations[:MAX_OPERATIONS_PER_PUSH])

    try:
        response = client.rpc(
            "apply_sync_batch",
            {"p_device_id": device_id, "p_ops": batch}
        ).execute()

    except APIError as e:
        code = str(getattr(e, "code", "") or "")
        message = getattr(e, "message", None) or str(e)

        if code in _FORBIDDEN_CODES:
            raise SyncRequestError(message, 403) from e
        if code in _BAD_REQUEST_CODES:
            raise SyncRequestError(message, 400) from e

        # Anything else (e.g. a failed sync_logs insert) rolled the whole
        # batch back. Nothing was saved, so the device can safely retry.
        raise TransientSyncError(f"{code}: {message}") from e

    except (httpx.HTTPError, OSError) as e:
        raise TransientSyncError(repr(e)) from e

    results = response.data if response is not None else None
    return results if isinstance(results, list) else []
