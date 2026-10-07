import { SUPPLEMENTAL_MODEL_CAPABILITIES } from "./supplemental-entries"
import type { ModelCapabilitiesSnapshot } from "./types"

// The bundled JSON holds thousands of models and every capability lookup asks for the merged
// snapshot, so spreading it per call copied the whole model map dozens of times per roster
// resolution. The merge is pure, so it is built once per input object.
const mergedSnapshots = new WeakMap<ModelCapabilitiesSnapshot, ModelCapabilitiesSnapshot>()

export function getBundledModelCapabilitiesSnapshot(
	snapshotJson: ModelCapabilitiesSnapshot,
): ModelCapabilitiesSnapshot {
	const cached = mergedSnapshots.get(snapshotJson)
	if (cached !== undefined) return cached

	const merged: ModelCapabilitiesSnapshot = {
		...snapshotJson,
		models: {
			...snapshotJson.models,
			...SUPPLEMENTAL_MODEL_CAPABILITIES,
		},
	}
	mergedSnapshots.set(snapshotJson, merged)
	return merged
}
