/** Athena projects use gzip internally, frequently without a .gz extension. */
export function isAthenaProjectFile(file: Pick<File, "name">): boolean {
  return /\.(?:prj|json)(?:\.gz)?$|\.gz$/i.test(file.name)
}
