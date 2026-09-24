from functools import cache

_MAX = 10


def format_name(name: str) -> str:
    return name[:_MAX] + "…" if len(name) > _MAX else name or "unnamed"


@cache
def shout(name: str) -> str:
    return format_name(name).upper()


async def fetch_name(names: dict[str, str], key: str) -> str:
    try:
        return names[key]
    except KeyError:
        return ""


exclaim = lambda s: shout(s) + "!"
