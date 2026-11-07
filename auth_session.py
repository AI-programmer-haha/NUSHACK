"""
auth_session.py — keep the officer's Supabase session alive.

Supabase access tokens expire (1 hour by default). Previously the app
cleared the session the first time a token failed, which logged officers
out mid-patrol and stopped their offline work from syncing. Now:

  * A token that expires within REFRESH_MARGIN_SECONDS is refreshed
    proactively with the refresh token, before it is used.
  * A token rejected by Supabase is refreshed once and retried.
  * Only a refresh token that Supabase itself rejects ends the session
    (AuthExpired -> 401).
  * If Supabase can't be reached, nothing is cleared (AuthUnavailable ->
    503), so a network blip never logs anyone out.

Refresh tokens are single-use. Two requests from the same browser can race
to refresh the same token, so the result of a refresh is remembered for
REUSE_WINDOW_SECONDS and handed to the second request instead of spending
the token twice.
"""

import base64
import json
import threading
import time

import httpx
from supabase_auth.errors import AuthError, AuthRetryableError

REFRESH_MARGIN_SECONDS = 120
REUSE_WINDOW_SECONDS = 30


class AuthExpired(Exception):
    """The session can't be renewed; the officer must log in again."""


class AuthUnavailable(Exception):
    """Supabase Auth is unreachable; try again later (session kept)."""


_lock = threading.Lock()
_recent_refreshes = {}   # spent refresh token -> (time, (access, refresh, user))


def token_expiry(access_token):
    """Unix expiry ('exp') of a JWT, read without verifying it — only used
    to decide WHEN to refresh; Supabase still verifies every token."""
    try:
        payload = access_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return int(exp) if exp is not None else None
    except (IndexError, ValueError, TypeError, AttributeError):
        return None


def _is_unreachable(error):
    return isinstance(error, (AuthRetryableError, httpx.HTTPError, OSError))


def refresh(client, refresh_token):
    """Exchange a refresh token for (access_token, refresh_token, user)."""
    if not refresh_token:
        raise AuthExpired("No refresh token.")

    with _lock:
        now = time.time()
        for spent, (at, _) in list(_recent_refreshes.items()):
            if now - at > REUSE_WINDOW_SECONDS:
                del _recent_refreshes[spent]

        if refresh_token in _recent_refreshes:
            return _recent_refreshes[refresh_token][1]

        try:
            response = client.auth.refresh_session(refresh_token)
        except Exception as e:
            if _is_unreachable(e):
                raise AuthUnavailable(repr(e)) from e
            if isinstance(e, AuthError):
                raise AuthExpired(str(e)) from e
            raise

        new_session = getattr(response, "session", None)
        if not new_session or not new_session.access_token:
            raise AuthExpired("Refresh returned no session.")

        user = getattr(response, "user", None) or getattr(new_session, "user", None)
        tokens = (new_session.access_token, new_session.refresh_token, user)
        _recent_refreshes[refresh_token] = (now, tokens)
        return tokens


def _get_user(client, access_token):
    try:
        response = client.auth.get_user(access_token)
    except Exception as e:
        if _is_unreachable(e):
            raise AuthUnavailable(repr(e)) from e
        if isinstance(e, AuthError):
            return None            # rejected token -> caller may refresh
        raise
    return getattr(response, "user", None) if response else None


def authenticate(client, flask_session):
    """Return the Supabase user for this Flask session, refreshing the
    tokens (and updating flask_session) when needed."""
    access = flask_session.get("access_token")
    refresh_token = flask_session.get("refresh_token")

    if not access:
        raise AuthExpired("Not logged in.")

    def store(tokens):
        flask_session["access_token"], flask_session["refresh_token"], _ = tokens
        return tokens[0]

    # 1. About to expire? Renew first (saves a failed round trip).
    exp = token_expiry(access)
    if exp is not None and refresh_token and exp - time.time() < REFRESH_MARGIN_SECONDS:
        access = store(refresh(client, refresh_token))
        refresh_token = flask_session["refresh_token"]

    # 2. Verify with Supabase; if rejected, refresh once and retry.
    user = _get_user(client, access)
    if user is None:
        access = store(refresh(client, refresh_token))
        user = _get_user(client, access)

    if user is None:
        raise AuthExpired("Session rejected after refresh.")

    return user
