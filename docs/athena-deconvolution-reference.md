# Athena deconvolution reference boundary

PR-11 remains requested and Pending. Inspecting executable source confirms that
the missing specification is not merely an unfinished manual page.

At Demeter revision `06afc8da08a5a7d5a26ee14992170fcf5dc67406`,
[Deconvolute.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Deconvolute.pm)
constructs a panel containing an unimplemented notice and a documentation
button. `pull_values`, `push_values` and `mode` are empty hooks. There is no
processing action or scientific algorithm in that module. The
[Athena manual](https://bruceravel.github.io/demeter/documents/Athena/process/deconv.html)
lists deconvolution as future work, and `documentation/DPG/mue/deconvolve.rst`
also describes an algorithm that has not been started. All three files are
recorded by Git blob identity and SHA-256 in the
[primary source catalog](athena-primary-sources.json).

The current web **Deconvolve data** tool uses Larch `xas_deconvolve` on a
normalized signal with Gaussian/Lorentzian width and an optional energy range.
That is a Larch extension with its own existing tests. It cannot supply evidence
of an original Athena algorithm that is absent from this pinned source. The
tool was not removed, substituted with a placeholder, or reclassified as verified
Athena parity. Future deconvolution work must state its executable scientific
reference and separate it from the original Athena control inventory.
