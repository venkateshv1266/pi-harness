/**
 * Glob → RegExp for rule path gating (tool scope).
 *
 * `**` crosses path separators; `**` followed by `/` may also match zero
 * directories, so `**` + `/*.ts` matches a root-level `x.ts` as well as a
 * nested `src/x.ts` (bash globstar / minimatch semantics). A single `*`
 * never crosses a separator.
 */
export function globToRegex(glob: string): RegExp {
	let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	re = re.replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*");
	re = re.replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*");
	return new RegExp(re.endsWith("$") ? `^${re}` : `^${re}$`);
}
