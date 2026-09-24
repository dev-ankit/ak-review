from __future__ import annotations

from typing import TYPE_CHECKING

from ..ui.format import format_name

if TYPE_CHECKING:
    from .types import Item


class Store:
    def __init__(self) -> None:
        self.items: list[Item] = []

    def add(self, item: Item) -> None:
        if not item.id:
            raise ValueError("id")
        self.items.append(item)

    def find(self, id: str) -> Item | None:
        return next((i for i in self.items if i.id == id), None)

    def label(self, id: str) -> str:
        item = self.find(id)
        return format_name(item.name if item else "")


def create_store(seed: list[Item] | None = None) -> Store:
    store = Store()

    def fill() -> None:
        for item in seed or []:
            store.add(item)

    fill()
    return store
