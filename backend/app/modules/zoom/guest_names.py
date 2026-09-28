# =============================================================================
# VELO Backend -- Guest display-name generator (GT-21 step B)
# =============================================================================
#
# A guest who enters a practice through its public link is offered a name
# such as "Пылающий Шива 12" before entering Zoom, so the master sees people
# instead of one faceless "VELO Guest Link" row (owner ruling: gods of four
# pantheons x qualities, a number on collision).
#
# PURE: no database, no Zoom. The claim path in zoom/service.py feeds it the
# names already in use and makes the result stick through a unique index;
# this module only has to produce a name outside the given set.
#
# THERE IS NO "COULD NOT GENERATE" BRANCH, by construction: the suffix has no
# upper bound and `exclude` is finite, so the search for a free suffix always
# terminates. The only way a claim ends without a name is losing the insert
# race MAX_ATTEMPTS times in a row -- a database event, handled in the claim
# path, not here.
#
# TWO PARTS, ALWAYS. Zoom rejects a registrant with an empty last_name (probe,
# 2026-09-22: HTTP 400, code 300). The quality is first_name, the god plus the
# optional number is last_name -- "Пылающий" / "Шива 12". Every dictionary
# word is a single token (asserted by the tests), so the stored display name
# splits back into exactly these two parts at its first space.
# =============================================================================

import enum
import random
from collections.abc import Iterable
from dataclasses import dataclass


class _Gender(enum.Enum):
    MASCULINE = "m"
    FEMININE = "f"


_M = _Gender.MASCULINE
_F = _Gender.FEMININE

# 48 gods, 12 per pantheon. Gender is carried by the god and picks the
# quality's form -- "Пылающая Фрейя", never "Пылающий Фрейя".
GODS: tuple[tuple[str, _Gender], ...] = (
    # Vedic
    ("Шива", _M), ("Вишну", _M), ("Брахма", _M), ("Индра", _M),
    ("Агни", _M), ("Варуна", _M), ("Сурья", _M), ("Ганеша", _M),
    ("Кали", _F), ("Лакшми", _F), ("Сарасвати", _F), ("Парвати", _F),
    # Greek
    ("Зевс", _M), ("Аполлон", _M), ("Гермес", _M), ("Арес", _M),
    ("Посейдон", _M), ("Гефест", _M), ("Дионис", _M),
    ("Афина", _F), ("Артемида", _F), ("Гера", _F), ("Деметра", _F),
    ("Афродита", _F),
    # Phoenician
    ("Баал", _M), ("Мелькарт", _M), ("Эшмун", _M), ("Дагон", _M),
    ("Решеф", _M), ("Эль", _M), ("Котар", _M),
    ("Астарта", _F), ("Анат", _F), ("Танит", _F), ("Ашера", _F),
    ("Шапаш", _F),
    # Norse
    ("Один", _M), ("Тор", _M), ("Локи", _M), ("Бальдр", _M),
    ("Тюр", _M), ("Хеймдалль", _M), ("Фрейр", _M), ("Браги", _M),
    ("Фрейя", _F), ("Фригг", _F), ("Идунн", _F), ("Сиф", _F),
)

# 16 qualities as (masculine, feminine).
QUALITIES: tuple[tuple[str, str], ...] = (
    ("Пылающий", "Пылающая"), ("Громкий", "Громкая"),
    ("Сильный", "Сильная"), ("Светлый", "Светлая"),
    ("Мудрый", "Мудрая"), ("Быстрый", "Быстрая"),
    ("Смелый", "Смелая"), ("Спокойный", "Спокойная"),
    ("Весёлый", "Весёлая"), ("Ясный", "Ясная"),
    ("Тихий", "Тихая"), ("Звёздный", "Звёздная"),
    ("Солнечный", "Солнечная"), ("Добрый", "Добрая"),
    ("Лунный", "Лунная"), ("Грозный", "Грозная"),
)

# The first number handed out on collision: "Пылающий Шива" is the first
# holder, the second one is "Пылающий Шива 2".
_FIRST_SUFFIX = 2


@dataclass(frozen=True)
class GuestName:
    """A generated name in the two parts Zoom requires."""

    first: str
    last: str

    @property
    def display(self) -> str:
        return f"{self.first} {self.last}"


def _base_names() -> list[GuestName]:
    """Every quality x god pair, 768 of them, in the right grammatical form."""
    return [
        GuestName(first=(masc if gender is _M else fem), last=god)
        for masc, fem in QUALITIES
        for god, gender in GODS
    ]


_BASES: tuple[GuestName, ...] = tuple(_base_names())


def generate(exclude: Iterable[str], rng: random.Random) -> GuestName:
    """Return a name whose display form is not in `exclude`.

    Comparison is casefolded: a master called "пылающий шива" must not see a
    guest "Пылающий Шива" beside him. A free base name is preferred and
    chosen at random among the free ones -- a fixed order would hand a
    crowd a predictable ladder of names, and the feature exists to make
    people distinguishable. Once every base is taken, a random base gets the
    next free number.

    `rng` is a parameter because the choice is random by design; callers in
    production pass a system-seeded generator, tests pass a seeded one.
    """
    taken = {name.casefold() for name in exclude}
    free = [b for b in _BASES if b.display.casefold() not in taken]
    if free:
        return rng.choice(free)

    base = rng.choice(_BASES)
    suffix = _FIRST_SUFFIX
    while f"{base.display} {suffix}".casefold() in taken:
        suffix += 1
    return GuestName(first=base.first, last=f"{base.last} {suffix}")
