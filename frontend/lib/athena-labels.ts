/** Split a group label so a narrow list can shorten its middle, not its end.
 *
 * A series of scans differs only in the number at the end of each name
 * ("sample_Cu_EXAFS_series.0017"); an end ellipsis turns all of them into the
 * same string. The tail keeps the last number, its separator and whatever
 * follows it (" · reference"), so the head is what gets shortened. */
export function labelParts(label: string): { head: string; tail: string } {
  const match = /[._ -]\d+(?!.*\d)[^\d]*$/.exec(label)
  if (!match || match.index === 0 || label.length - match.index > 24) return derived(label)
  return { head: label.slice(0, match.index), tail: label.slice(match.index) }
}

/** Groups made from one long-named file differ only after its name
 * ("… · Mn fluorescence" and "… · Mn fluorescence · window sum"): keep from the
 * first " · " on, and shorten the file name instead. */
function derived(label: string): { head: string; tail: string } {
  const at = label.indexOf(" · ")
  if (at <= 24 || label.length - at > 48) return { head: label, tail: "" }
  return { head: label.slice(0, at), tail: label.slice(at) }
}
