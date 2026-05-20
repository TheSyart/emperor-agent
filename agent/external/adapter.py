from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .models import ExternalDeliveryResult, ExternalOutbound


class ExternalAdapter(ABC):
    """Base class for future platform adapters.

    Concrete platform implementations belong outside this foundation layer.
    They should translate platform-specific payloads into ExternalInbound and
    use ExternalBridgeService.ingest() to enter the single mainline.
    """

    name: str = "external"
    display_name: str = "External"

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    @property
    def capabilities(self) -> dict[str, Any]:
        return {}

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "capabilities": dict(self.capabilities),
        }

    @abstractmethod
    async def send(self, message: ExternalOutbound) -> ExternalDeliveryResult:
        """Deliver an outbound message to the platform."""
