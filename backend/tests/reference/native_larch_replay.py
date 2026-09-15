"""Replay recorded original Demeter commands on the current numeric backend.

These test oracles import Larch, never the web implementation. Callers pass the
commands retained in the immutable, provenance-checked native fixtures. The
recorded outputs remain historical observations; executing those same commands
separates web compatibility from platform-dependent LAPACK roundoff.
"""
import numpy as np
from larch import Group, Interpreter
from larch.fitting import minimize


def _evaluate(engine, commands):
    if isinstance(commands, str):
        commands = [commands]
    for command in commands:
        engine.eval(command.replace('<<nl>>', ''))
        assert not engine.error, [error.get_error() for error in engine.error]


def _array(engine, name):
    value = np.asarray(engine.symtable.get_symbol(name), dtype=float)
    assert value.ndim == 1 and np.isfinite(value).all(), name
    return value.copy()


def replay_smoothing(command, signal, output='h.xmu'):
    engine = Interpreter()
    engine.symtable.set_symbol('g', Group(xmu=np.array(signal, dtype=float, copy=True),
                                         chi=np.array(signal, dtype=float, copy=True)))
    engine.symtable.set_symbol('h', Group())
    _evaluate(engine, command)
    return _array(engine, output)


def replay_calibration(commands, arrays):
    engine = Interpreter()
    engine.symtable.set_symbol('g', Group(**{
        name: np.array(value, dtype=float, copy=True) for name, value in arrays.items()
    }))
    _evaluate(engine, commands)
    return _array(engine, 'g.smooth')


def replay_alignment(command, standard_energy, standard_mu, moving_energy, moving_mu):
    engine = Interpreter()
    for name, energy, mu in [('standard', standard_energy, standard_mu),
                             ('moving', moving_energy, moving_mu)]:
        engine.symtable.set_symbol(name, Group(energy=np.array(energy, dtype=float, copy=True),
                                              xmu=np.array(mu, dtype=float, copy=True)))
    captured = []

    def capture(*args, **kwargs):
        result = minimize(*args, **kwargs)
        captured.append(result)
        return result

    engine.symtable.set_symbol('minimize', capture)
    _evaluate(engine, command)
    assert len(captured) == 1 and captured[0].success
    fit = captured[0]
    pars = engine.symtable.get_symbol('aa__')
    residual = np.asarray(fit.residual, dtype=float)
    assert residual.ndim == 1 and np.isfinite(residual).all()
    return dict(residual=residual.copy(), fitted_shift=float(pars.esh.value),
                scale=float(pars.scale.value), stderr=pars.esh.stderr,
                chisqr=float(fit.chi_square), redchi=float(fit.chi_reduced))
