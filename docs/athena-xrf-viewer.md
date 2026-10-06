# Looking at the raw counts: the XRF spectrum and map viewer

This note records what the viewer shows, what it deliberately does not do to
the numbers, and — before any test was written — the ways each part can fail.
Every failure below has one test named for it.

## The problem

An energy dispersive detector returns a whole X-ray fluorescence spectrum,
several thousand channels wide, at every point of a scan, from every one of
its elements. A fluorescence XAS extraction
(`docs/athena-xrf-xas-reference.md`) folds all of that into a single curve
μ(E), and a MAPS-style fit folds it into element concentrations. Both are
inferences. When one of them disagrees with expectation, the first question is
always what the detector actually recorded, and until now the app had no way
to answer it: the counts went into the fit and only the fit came out.

This panel is the answer to that question and to nothing else. It shows

* the spectrum at a chosen point, element by element and summed, on a
  logarithmic ordinate, because a line three decades below the elastic peak is
  invisible on a linear one;
* the sum over a channel window — a region of interest — across the whole
  scan, plotted against the point index or against any array the file holds;
* that same window as an image, when the file holds the stage positions that
  fold its points into a raster.

Three failures it is meant to catch:
a detector element that recorded nothing while others worked; a
channel window placed on the wrong line, which plots as a smooth and entirely
plausible curve; and a stored energy calibration that puts a known emission
line in the wrong channel.

## Method

### Nothing is corrected

The viewer reads counts and returns counts. There is no deadtime correction,
no division by the incident flux, no background subtraction and no fit. This
is a decision, not an omission: if the panel preprocessed its input, a
disagreement between what it draws and what the extraction fits would be a
statement about two different preprocessings rather than about the fit. The
numbers on the ordinate are therefore raw detector counts, averaged over the
points in the averaging window and summed over the chosen elements.

### A more permissive reader than the extraction's

`read_scan`, which feeds the XAS extraction, refuses a file with no incident
energy array, because no μ(E) can come out of one. The viewer's `read_cube`
accepts it. Both read two layouts: a NeXus-style entry whose data group holds
the cube, and the APS 20-BM detector file, whose `1D Scan/MCA n` arrays are
read as one detector `MCA` (element *n*−1 is `MCA n`) with the monochromator
energy from `X Positions` and every scaler under `Detectors` offered as an
abscissa. A map, one row of a map, or a single spectrum has no energy axis
and is exactly the kind of file somebody wants to look at. What it requires is
one 3-D array shaped (points, elements, channels); a file holding two such
arrays of different lengths is refused rather than guessed at, because they
cannot share one point slider.

Alongside the cube, the reader collects every 1-D numeric array as long as it,
from three layouts: arrays written beside the cube in the data group, the
bluesky stream groups the energy scans here carry, and the `NDAttributes` an
areaDetector writes. That last one matters for map rows, whose per-point
deadtime factors and channel-advance sums are the only arrays in the file.
Those arrays become the choices in the trace abscissa menu.

### Deciding whether a file holds a map

Positions are what make a cube a map. Candidate position arrays are chosen by
name (`x`, `y`, `stage`, `sample`, …), with an explicit veto list
(`energy`, `time`, `scaler`, `deadtime`, …) because the hints are substring
matches and "energy" contains both an x and a y.

A slow axis holds still for a row and then steps, so the row boundaries are
where its difference exceeds half the largest difference; the file is a raster
only when those boundaries are evenly spaced, divide the point count exactly,
and the fast axis sweeps its whole travel inside every row. If the fast axis
runs one way in the first row and the other way in the second, the scan is
serpentine and every other row is reversed before the image is drawn.

When no such pair exists — an energy scan, a single spectrum, one row of a
larger map — the panel says so in words and offers the trace alone. It does
not draw a one-row image, which would present a line profile as a map of the
sample.

### Rebinning, decimation and the limits

* **Rebinning** sums adjacent channels; it never averages them, so the
  ordinate keeps meaning counts. Each bin is labelled by its **centre**
  channel, so that `E = offset + slope · channel` still holds; labelling a bin
  by its first channel shifts the spectrum half a bin left, which at 10 eV a
  channel is a visible calibration error. A remainder past the last full bin
  is dropped.
* **The trace is decimated** to at most 4,000 points for the browser; **the
  map is not**, because dropping every second point of an image drops whole
  pixels out of it. The stride used is returned with the frame.
* **One frame may materialise at most 40 million counts** (points × elements ×
  channels in the window). A map is a hundred times the points of a scan, so
  the per-dimension limits can all be met while their product is far beyond
  memory; the check is on the product, before the read.

### The energy axis is a label, not a result

The spectrum's abscissa comes from `cal_offset` and `cal_slope` typed into the
panel — the beamline's numbers, or those in a `detector_params.json` beside
the data. Nothing here is fitted. The channel window and the window of
interest are both given in **channels**, not keV, so that moving the
calibration never silently moves the window.

### What the browser does

Plotly has no logarithmic colour axis, so the logarithmic map takes
`log10` client-side. A pixel with no counts has no logarithm, and it is sent
as a gap rather than clamped to the bottom of the scale: an unmeasured or dead
pixel must not be drawn as a weak but real signal. Presentation changes —
either logarithmic toggle — redraw without asking the server for a new frame,
and the plots keep their `uirevision`, so the zoom the reader used to find a
line survives the next checkbox. Dragging the point slider is debounced into
one request, since each frame re-reads the detector file on the server.

## What is *not* here

* **No deadtime or flux correction**, as above.
* **No fitting.** Element identification by eye against the calibrated axis is
  all the panel offers; fitting is the extraction's job and MapsTorch's.
* **No multi-file maps.** The map path is implemented and tested, and it draws
  any file that holds a full raster. Stitching separate row files into one
  image is not supported; a single row is reported as a line scan.
* **No region-of-interest arithmetic** — no background window subtracted from
  a peak window, no ratio of two windows. One window, summed.

## How each part can fail

### The reader and the frame (`backend/tests/test_athena_xrf_view.py`)

| Failure | Why it would happen | Test |
| --- | --- | --- |
| A map or a single spectrum cannot be opened at all | reusing the XAS reader, which requires an energy array | `test_a_file_with_no_energy_array_is_still_readable` |
| A point slider drives one cube while the spectrum comes from another | two cubes of different lengths in one file, and the first one sorted wins | `test_detector_arrays_of_different_lengths_are_refused` |
| A frame exhausts memory although every per-dimension limit is met | the limits multiply; a map is a hundred times the points of a scan | `test_an_oversized_window_is_refused_before_it_is_read` |
| An image that looks like a plausible sample but is not the one measured | the counts arrive as one list, and the wrong row length still folds | `test_a_raster_is_folded_into_a_map_in_the_order_it_was_scanned` |
| Zig-zag edges read as a real feature of the sample | a serpentine scan folded as though the stage flew back each row | `test_a_serpentine_raster_is_unwound_rather_than_mirrored` |
| A line profile presented as a map | inventing a second dimension from the positions of one map row | `test_a_single_map_row_is_offered_as_a_trace_and_not_as_a_one_row_image` |
| An energy scan folded into a rectangle of nothing | "energy" matches the `x` and `y` position hints as a substring | `test_an_energy_scan_is_not_mistaken_for_a_map` |
| Pixels missing from the image | decimating the map along with the trace | `test_the_trace_is_decimated_but_the_map_keeps_every_pixel` |
| A neighbouring spectrum shown, looking entirely reasonable | an off-by-one in the point, the averaging block, or the element list | `test_the_spectrum_is_the_counts_at_the_point_asked_for` |
| The end of a scan averaged with its beginning | an averaging block running off the end wraps through negative indexing | `test_averaging_near_the_end_of_the_scan_stays_inside_it` |
| A dead or shadowed element invisible | it is only visible against the others, and hidden in the sum the fit uses | `test_one_element_can_be_looked_at_on_its_own` |
| Somebody else's spectrum returned for a typo, or a 500 | NumPy reads element −1 as the last one and raises on element 99 | `test_an_element_that_does_not_exist_is_refused_rather_than_wrapped` |
| A dead detector and a misplaced window look identical | an empty window sums to zero at every point: a flat trace, a blank map | `test_a_window_of_interest_outside_the_channels_read_is_refused` |
| A rescaled ordinate, or a spectrum shifted half a bin | averaging instead of summing; labelling a bin by its first channel | `test_rebinning_conserves_counts_and_keeps_the_energy_axis_honest` |
| An unevenly stepped scan distorted, a map row with no distance on it | plotting the trace against the point index only | `test_the_trace_can_run_against_an_axis_the_file_holds` |

### The routes (`backend/tests/test_athena_xrf_view_api.py`)

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The panel asks for a detector, a point or an axis that does not exist | every control is built from one inspection response, and it missed one | `test_the_file_is_read_back_with_its_detector_axes_and_shape` |
| The demo uploads the same ten megabytes twice | the extraction's upload is the same bytes but is tagged differently | `test_a_scan_uploaded_for_the_extraction_can_be_looked_at_without_a_second_upload` |
| A 500 from deep inside h5py | a frame request pointed at an ordinary column file reads whatever is there | `test_an_upload_that_is_not_a_detector_file_is_refused` |
| Scrubbing through a map fills the project with history | every slider move asks for a frame, and a frame that wrote anything accumulates | `test_a_frame_does_not_mutate_the_project` |
| A raster file arrives with no image | the map is built from positions only the server has read | `test_a_map_file_comes_back_with_its_image` |
| A stale panel gets a server error instead of a message | a bad point, element or window used to raise out of NumPy | `test_a_bad_frame_request_is_a_message_and_not_a_server_error` |
| The panel goes blank with no error at all | a NaN or infinity is written as a bare `NaN`, which no browser can parse | `test_every_number_in_a_frame_survives_json` |

### The panel (`frontend/components/athena-xrf-view.test.tsx`)

| Failure | Why it would happen | Test |
| --- | --- | --- |
| A control invents a channel count or a point count the file cannot answer | building any control from anything but the inspection response | `builds every control from the one response that read the file` |
| A drag across a scan sends hundreds of reads and lands on the wrong one | one request per slider step, arriving out of order | `asks for one frame when the point slider is dragged, not one for every step` |
| An element hidden from the plot while the server still sums it | dropping it from the drawing instead of from the request | `leaves an unticked detector element out of the request and out of the plot` |
| The reader's zoom lost on every checkbox, or a toggle that changes nothing | asking the server for a presentation change, or a fresh `uirevision` | `redraws presentation changes without reading the file again` |
| A line scan drawn as a one-row map | inventing a second dimension that was never measured | `says a file holds a line scan rather than drawing a one-row image` |
| A sample silently rescaled, and read off the plot as a distance | drawing the image on a pixel grid instead of on the stage positions | `draws a raster file at the stage positions it was measured at` |
| An empty pixel shown as a weak but real signal | clamping a non-positive pixel to the bottom of a logarithmic scale | `leaves an empty pixel empty on a logarithmic colour scale` |
| A refusal that does not say which setting is wrong | sending a window outside the channels read and reporting the server's error alone | `refuses a window of interest outside the channels read before sending it` |
| The spectrum of the point the reader moved away from read as the new one | leaving the previous frame on screen behind an error | `shows the server message instead of the frame it replaced` |
| An unevenly stepped scan distorted in the browser | plotting the trace against the index when the file offers an array | `plots the trace against an array the file holds when one is chosen` |

## Sources

* Mn Kα₁ 5.899 keV, Kα₂ 5.888 keV: X-ray Data Booklet, Table 1-2 (LBNL).
* The HDF5 layouts read here are those written by the beamline's areaDetector
  and bluesky deployments; see `_axes` in
  `backend/xraylarch_web/athena_xrf_view.py` for the three groups searched.
