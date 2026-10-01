# Shared reference foils

In **Data groups**, click a spectrum’s link icon to assign a reference.
For several spectra, mark them or select their rows, then click **Ref**.
The dialog shows the target spectra explicitly and lets you choose any
loaded spectrum with an energy axis. The chosen reference is excluded
from the targets.

Each linked spectrum displays an indented `ref · name` row. Clicking it
opens the original reference spectrum, clears the list search, and expands
its folder if needed. The reference’s `ref · N` badge shows how many spectra
point to it. These child rows are shortcuts to one dataset, so they do not
add duplicate spectra or change the plot’s marked selection.

Use the pencil beside a link to change it or choose **None — remove
reference links**. Removing one sample’s link preserves other samples’
links to the same foil. Assignment and removal support Undo/Redo and
project save/reopen, including JSON and Athena PRJ export.

## Energy behavior

Assigning a reference adopts its current energy shift. Subsequent changes
to an energy shift propagate through the linked family. Removing a link
keeps the spectrum’s current shift. Raw measured arrays are preserved;
processed results are recalculated when a shift changes. The dialog
explains this before applying the assignment. Frozen groups cannot be
shifted by assigning a reference.

Self-links, new cycles, and references involving χ(k) input are rejected.
The older **Tie marked sample and reference** command retains its
sample-first energy-shift choice and now preserves other users of the
same reference.

## Copper demo

**Load copper examples** includes a fifth spectrum, **Cu foil · shared
reference**, linked from the three temperature-series spectra. It reuses
the measured room-temperature Cu foil in `examples/xafsdata/cu_rt01.xmu`
(APS 13-ID, 2001-06-26). Its notes explain that the shared links illustrate
the feature; they do not claim simultaneous reference measurements for
the temperature series. The reference starts unmarked. The Cu₂O spectrum
and prepared EXAFS model remain available.

## API

`assign_reference` accepts selected sample `group_ids` and
`options: {"reference_id": "<group id>"}`. Set `reference_id` to `null`
to remove those outgoing links. The project revision is required, and
the whole change is one undoable operation. Metadata reference edits use
the same assignment rules.
