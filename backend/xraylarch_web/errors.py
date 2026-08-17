from __future__ import annotations

from .contracts import ErrorEnvelope


class WebInputError(ValueError):
    """Stable, serializable error for data supplied to the web boundary."""

    def __init__(
        self,
        code: str,
        message: str,
        fields: tuple[str, ...] = (),
        recovery: str = "Review the input and try again.",
    ) -> None:
        self.code = code
        self.message = message
        self.fields = fields
        self.recovery = recovery
        super().__init__(message)

    @property
    def envelope(self) -> ErrorEnvelope:
        return ErrorEnvelope(
            code=self.code,
            message=self.message,
            fields=self.fields,
            recovery=self.recovery,
        )
