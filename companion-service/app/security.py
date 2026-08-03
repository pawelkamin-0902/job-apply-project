from fastapi import Header, HTTPException

from app.config import get_or_create_secret_token
from app import store


async def verify_token(x_api_token: str = Header(default="")) -> None:
    expected = get_or_create_secret_token()
    if not x_api_token or x_api_token != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Api-Token header")


async def get_active_person(x_person: str = Header(default="")) -> str:
    """Which person's data to operate on for this request. Each browser install sends
    its own fixed X-Person header (stored locally there), so multiple browsers sharing
    one companion service each stay pinned to their own profile - switching in one
    can't affect another. Falls back to the server-side settings.person for direct
    API/curl use with no header at all."""
    return x_person.strip() or store.get_settings().person
