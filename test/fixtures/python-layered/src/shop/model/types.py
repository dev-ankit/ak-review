from dataclasses import dataclass

__all__ = ["Item"]


@dataclass
class Item:
    id: str
    name: str


Id = str
