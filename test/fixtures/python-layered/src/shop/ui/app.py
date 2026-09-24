import json

from shop.lib import fmt_name
from shop.model.store import create_store
from shop.model.types import Item

from . import format as fmt
from .format import format_name

store = create_store()


def title(id: str) -> str:
    return "<h1>" + store.label(id) + "</h1>"


class App:
    def render(self, n: int) -> str:
        store.add(Item(str(n), "x"))
        return json.dumps(
            [
                title("1"),
                fmt.format_name("y"),
                format_name("z"),
                fmt_name("w"),
            ]
        )
