# Dr.XAS integration recipe fidelity

The integration contract and the processing recipe have separate versions:
the persistent project API uses contract version 2, while its portable
`CoreProcessingRecipe` still uses recipe version 1.

## Export behavior

An export may claim `science.kind = "recomputable"` only when recipe version 1
can express its processing and all required computed arrays are present.
Three Athena options are outside that recipe:

| Athena option | Information missing from recipe version 1 |
| --- | --- |
| `fnorm` | The separate correction and refit used to compute EXAFS |
| `background_standard_id` | The selected standard's processed, unweighted chi(k) |
| `is_normalized` | The instruction to preserve supplied normalization and use a unit edge step |

For these options, the v2 group export uses the existing
`science.kind = "exported"`, `reason = "unportable_recipe"` representation.
It includes the original authoritative spectrum and the cached arrays supported
by the contract, with no replay recipe. Export does not reprocess or alter the
arrays. The saved options and cached processing evidence are both checked.
Other existing exclusions, such as difference spectra and non-mu data types,
keep their existing reason codes.

The legacy v1 envelope has no representation for computed arrays without a
recipe. Its export, snapshot, and import preparation therefore return HTTP 409
when these options are present; the detail names the unsupported options.
Failed preparation leaves the draft active and editable. It does not bind an
import or seal the draft.

No contract fields, reason codes, or scientific algorithms change. A future
recipe that supports these options must explicitly encode their inputs before
exports using them can be called recomputable.

## Local numerical regression

`backend/tests/test_integration_service.py` replays recipe version 1 through
the local Athena processing implementation using measured data from
`examples/xafsdata/cu_rt01.xmu`. The background-standard case also uses
`examples/xafsdata/cu_10k.xmu`; the already-normalized case uses the first
scan's computed normalization as its input. All recipe fields needed for a
portable export are explicit.

With the pre-fix classification, all four cases claimed to be recomputable.
In the September 28, 2026 local check, the ordinary recipe reproduced all
contract arrays exactly, while dropping the three options produced:

| Dropped option | Example array | Maximum absolute difference |
| --- | --- | ---: |
| `fnorm` | chi(k) | 0.0239720 |
| Background standard | chi(k) | 0.0000179593 |
| Already normalized flag | Flattened spectrum | 0.777711 |

The tests check numerical disagreement and require the affected exports to
preserve all available contract arrays exactly under `exported`. The ordinary
case checks replay agreement with relative and absolute tolerances of 1e-11.
The fnorm case exercises serialization fidelity on measured data; it does not
establish that fnorm is appropriate for this copper transmission measurement.

These are local, same-Larch comparisons. They do not verify the Dr.XAS receiver,
cross-version numerical parity, or a deployed integration.
