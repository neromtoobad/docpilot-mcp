"""Module-level helpers (the requests top-level convenience functions)."""
from typing import Any, Mapping, Optional

from .sessions import Session


def request(
    method: str,
    url: str,
    **kwargs: Any,
) -> "Response":
    """Construct and send a :class:`Request <Request>`."""
    with Session() as session:
        return session.request(method=method, url=url, **kwargs)


def get(url: str, params: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> "Response":
    """Sends a GET request."""
    return request("get", url, params=params, **kwargs)


def post(url: str, data: Optional[Any] = None, json: Optional[Any] = None, **kwargs: Any) -> "Response":
    """Sends a POST request."""
    return request("post", url, data=data, json=json, **kwargs)
