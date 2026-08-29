import React from "react"
import { Package } from "@roo/package"

interface VersionIndicatorProps {
	className?: string
}

const VersionIndicator: React.FC<VersionIndicatorProps> = ({ className = "" }) => {
	return (
		<span
			className={`text-xs text-vscode-descriptionForeground rounded-full px-2 py-1 border select-none ${className}`}>
			v{Package.version}
		</span>
	)
}

export default VersionIndicator
