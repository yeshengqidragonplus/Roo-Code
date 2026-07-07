import type { McpServer } from "@roo-code/types"

/**
 * Reads the mode-level visibility whitelist from a server's validated config.
 * Returns undefined when the server does not restrict visibility (no `modes`
 * field), which means the server is visible to every mode with the "mcp" group.
 */
export function getServerVisibleModes(server: McpServer): string[] | undefined {
	try {
		const config = JSON.parse(server.config) as { modes?: unknown }
		if (
			Array.isArray(config.modes) &&
			config.modes.length > 0 &&
			config.modes.every((mode) => typeof mode === "string")
		) {
			return config.modes
		}
	} catch {
		// Malformed config JSON — treat the server as unrestricted so a config
		// hiccup can never silently hide tools from every mode.
	}
	return undefined
}

/**
 * Whether a server's tools are visible to the given mode.
 * Servers without a `modes` whitelist are visible to all modes.
 */
export function isServerVisibleToMode(server: McpServer, modeSlug: string): boolean {
	const modes = getServerVisibleModes(server)
	return !modes || modes.includes(modeSlug)
}
