"""Minimal fixture mimicking a portion of psf/requests/sessions.py."""
from typing import Any, Mapping, Optional


class SessionRedirectMixin:
    pass


class Session:
    """A session object for making HTTP requests."""

    def get(self, url: str, **kwargs: Any) -> "Response":
        """Send a GET request."""
        ...

    def post(
        self,
        url: str,
        data: Optional[Any] = None,
        json: Optional[Any] = None,
        **kwargs: Any,
    ) -> "Response":
        """Send a POST request."""
        ...

    def request(
        self,
        method: str,
        url: str,
        params: Optional[Mapping[str, Any]] = None,
        data: Optional[Any] = None,
        headers: Optional[Mapping[str, str]] = None,
        **kwargs: Any,
    ) -> "Response":
        """Construct and send a Request."""
        ...
