import fs from "fs/promises"
import path from "path"

/** Conservative path check for automatic approval, including existing symlinks. */
export async function isUnprotectedProjectPath(
	projectRoot: string,
	input: string,
	isProtected: (relative: string) => boolean,
): Promise<boolean> {
	try {
		const root = await fs.realpath(projectRoot)
		const candidate = path.resolve(projectRoot, input)
		const lexical = path.relative(path.resolve(projectRoot), candidate)
		if (
			lexical === ".." ||
			lexical.startsWith(`..${path.sep}`) ||
			path.isAbsolute(lexical) ||
			(lexical && isProtected(lexical))
		)
			return false
		let actual: string
		try {
			actual = await fs.realpath(candidate)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
			// A dangling symlink can resolve to a nonexistent file outside the
			// project. Do not mistake it for a new project-local file.
			try {
				await fs.lstat(candidate)
				return false
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return false
			}
			// Only allow a missing final component; unresolved parents ask.
			actual = path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate))
		}
		const relative = path.relative(root, actual)
		return (
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative) &&
			(!relative || !isProtected(relative))
		)
	} catch {
		return false
	}
}
