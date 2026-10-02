"""Path-dependent EXAFS disorder, using Larch's Einstein and FEFF6 Debye models.

The Python Debye implementation ships with Larch and retains FEFF6 constants.
Using it here also works on hosts without a compatible native libfeff6.
"""
from functools import lru_cache
import ast
import math
from larch.xafs.sigma2_models import EINS_FACTOR, sigma2_correldebye_py

DISORDER_FUNCTIONS = {"sigma2_eins", "sigma2_debye", "eins", "debye"}


def canonical_expression(expression):
    """Translate the two Artemis aliases for native Larch session export."""
    import re
    for alias, name in (("eins", "sigma2_eins"), ("debye", "sigma2_debye")):
        expression = re.sub(rf"\b{alias}(?=\s*\()", name, expression)
    return expression


def _inputs(t, theta, feffdat):
    t, theta = float(t), float(theta)
    if not math.isfinite(t) or t < 0 or not math.isfinite(theta) or theta <= 0:
        raise ValueError("Use sample temperature T >= 0 K and characteristic temperature theta > 0 K.")
    if feffdat is None or len(feffdat.geom) < 2:
        raise ValueError("A Debye–Waller model requires the current FEFF path.")
    if any(not math.isfinite(atom[3]) or atom[3] <= 0 for atom in feffdat.geom):
        raise ValueError("The FEFF path must contain positive atomic masses.")
    return t, theta


def _einstein(t, theta, feffdat):
    t, theta = _inputs(t, theta, feffdat)
    # Larch's formula, with the exact T=0 limit and no clamping of theta.
    inverse_mass = sum(1.0 / atom[3] for atom in feffdat.geom)
    return EINS_FACTOR * inverse_mass / (theta * (math.tanh(theta / (2 * t)) if t else 1.0))


@lru_cache(maxsize=2048)
def _debye_cached(t, theta, rnorman, geometry):
    mass, x, y, z = zip(*geometry)
    return float(sigma2_correldebye_py(len(geometry), max(t, 1.e-5), theta,
                                     rnorman, x, y, z, mass))


def _debye(t, theta, feffdat):
    t, theta = _inputs(t, theta, feffdat)
    rnorman = float(feffdat.rnorman)
    if not math.isfinite(rnorman) or rnorman <= 0:
        raise ValueError("The correlated Debye model requires a positive FEFF Norman radius.")
    geometry = tuple(tuple(float(atom[i]) for i in (3, 4, 5, 6)) for atom in feffdat.geom)
    # Zero-length legs make the FEFF correlation projection undefined.
    for index, atom in enumerate(geometry):
        if atom[1:] == geometry[(index + 1) % len(geometry)][1:]:
            raise ValueError("The correlated Debye model requires nonzero path legs.")
    value = _debye_cached(t, theta, rnorman, geometry)
    if not math.isfinite(value) or value < 0:
        raise ValueError("The correlated Debye calculation did not return a finite, nonnegative sigma2.")
    return value


def evaluate_disorder(name, t, theta, path):
    return (_einstein if name in ("eins", "sigma2_eins") else _debye)(t, theta, path._feffdat)


def runtime_expression(expression):
    """Pass the current path explicitly, only after the public AST was validated."""
    class CurrentPath(ast.NodeTransformer):
        def visit_Call(self, node):
            self.generic_visit(node)
            if node.func.id in DISORDER_FUNCTIONS:
                node.args.append(ast.Name(id="feffpath", ctx=ast.Load()))
            return node
    return ast.unparse(CurrentPath().visit(ast.parse(expression, mode="eval")))


def install_disorder_functions(params):
    """Top-level callables survive lmfit copies without retaining old path state.

    Even copied asteval Procedures can retain their old interpreter. Supplying
    feffpath as an explicit argument reads this evaluation's current symbol table.
    """
    params._asteval.symtable.update(sigma2_eins=_einstein, eins=_einstein,
                                   sigma2_debye=_debye, debye=_debye)


def prepare_disorder_dataset(dataset):
    # feffit creates fresh Parameters, discarding the input group's functions.
    # Install only on this dataset, after that creation and before path setup.
    original = dataset.prepare_fit

    def prepare_fit(params=None, **kwargs):
        install_disorder_functions(params)
        return original(params=params, **kwargs)

    dataset.prepare_fit = prepare_fit
