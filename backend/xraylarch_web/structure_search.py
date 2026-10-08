"""Chemical-formula relevance shared by the CIF search providers."""
from __future__ import annotations

import math
import re
from functools import lru_cache

from pymatgen.core import Composition


@lru_cache(maxsize=1024)
def parse_formula(value: str) -> Composition | None:
    """Parse a formula, leaving mineral names and source IDs as text queries."""
    if not value or len(value) > 5000:
        return None
    compact = re.sub(r"\s+", "", value)
    if not re.fullmatch(r"[A-Za-z0-9.()\[\]{}]+", compact):
        return None
    try:
        composition = Composition(compact, strict=True)
        if composition.valid and composition and all(
            math.isfinite(amount) and amount > 0 for amount in composition.values()
        ):
            return composition
    except (ValueError, TypeError, KeyError, RecursionError):
        pass
    return None


def formula_match_rank(query: str, formula: str) -> int:
    """Exact counts, equivalent ratios, same elements, then other text matches.

    Element order and whitespace do not affect a match. Equivalent ratios keep
    reduced formulae useful, e.g. Li2MnNiO4 for LiMn0.5Ni0.5O2.
    """
    requested = parse_formula(query)
    if requested is None:
        return 3
    candidate = parse_formula(formula)
    if candidate is None or set(requested) != set(candidate):
        return 3
    if requested.almost_equals(candidate, rtol=1e-8, atol=1e-8):
        return 0
    if requested.fractional_composition.almost_equals(candidate.fractional_composition, rtol=1e-8, atol=1e-8):
        return 1
    return 2
