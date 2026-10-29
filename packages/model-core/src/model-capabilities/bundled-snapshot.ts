import { FABLE_55_LAUNCH } from "../fable-55-launch"
import { SUPPLEMENTAL_MODEL_CAPABILITIES } from "./supplemental-entries"
import type { ModelCapabilitiesSnapshot, ModelCapabilitiesSnapshotEntry } from "./types"

// The launch placeholder only fills gaps: every field the generated catalog defines wins, so its
// undefined launch values can never hide real data once the catalog lists the model. Every other
// supplemental row keeps overriding the generated row on purpose (e.g. the grok output caps).
function fillGaps(
	generated: ModelCapabilitiesSnapshotEntry,
	placeholder: ModelCapabilitiesSnapshotEntry,
): ModelCapabilitiesSnapshotEntry {
	const merged: Record<string, unknown> = { ...placeholder }
	for (const [key, value] of Object.entries(generated)) {
		if (value === undefined) continue
		const base = merged[key]
		merged[key] =
			value !== null && typeof value === "object" && !Array.isArray(value) && base !== null && typeof base === "object"
				? { ...base, ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) }
				: value
	}
	return merged as ModelCapabilitiesSnapshotEntry
}

// The bundled JSON holds thousands of models and every capability lookup asks for the merged
// snapshot, so spreading it per call copied the whole model map dozens of times per roster
// resolution. The merge is pure, so it is built once per input object.
const mergedSnapshots = new WeakMap<ModelCapabilitiesSnapshot, ModelCapabilitiesSnapshot>()

export function getBundledModelCapabilitiesSnapshot(
	snapshotJson: ModelCapabilitiesSnapshot,
): ModelCapabilitiesSnapshot {
	const cached = mergedSnapshots.get(snapshotJson)
	if (cached !== undefined) return cached

	const models = { ...snapshotJson.models, ...SUPPLEMENTAL_MODEL_CAPABILITIES }
	const generatedLaunchRow = snapshotJson.models[FABLE_55_LAUNCH.id]
	if (generatedLaunchRow) models[FABLE_55_LAUNCH.id] = fillGaps(generatedLaunchRow, FABLE_55_LAUNCH)
	const merged: ModelCapabilitiesSnapshot = { ...snapshotJson, models }
	mergedSnapshots.set(snapshotJson, merged)
	return merged
}
