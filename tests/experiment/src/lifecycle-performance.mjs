/** Measure validated no-op and real body-edit samples, then restore the source. */
export async function measureLifecyclePerformance(props) {
  validate(props);
  let currentDump = props.currentDump;
  let currentIdentity = props.currentIdentity;
  const noops = [];
  for (let index = 0; index < props.noopSamples; index++) {
    const sample = await props.load();
    noops.push(sample.elapsedMs);
    if (
      sample.dump !== currentDump ||
      sample.mode !== "unchanged" ||
      sample.identity !== currentIdentity
    ) {
      throw new Error(
        `${props.language}: performance no-op ${String(index + 1)} replaced the resident generation`,
      );
    }
  }

  const edits = [];
  for (let index = 0; index < props.editSamples; index++) {
    props.writeSource(
      props.sourceText.replace(
        props.editFind,
        props.editReplacements[index % props.editReplacements.length],
      ),
    );
    const sample = await props.load();
    edits.push(sample.elapsedMs);
    if (
      !props.changedModes.includes(sample.mode) ||
      sample.dump === currentDump ||
      sample.identity === currentIdentity
    ) {
      throw new Error(
        `${props.language}: performance edit ${String(index + 1)} did not replace strict provenance`,
      );
    }
    currentDump = sample.dump;
    currentIdentity = sample.identity;
  }

  props.writeSource(props.sourceText);
  const restored = await props.load();
  if (
    !props.changedModes.includes(restored.mode) ||
    restored.dump === currentDump
  ) {
    throw new Error(
      `${props.language}: performance sampling did not restore its source generation`,
    );
  }
  currentDump = restored.dump;
  currentIdentity = restored.identity;

  const noopP95Ms = nearestRankP95(noops);
  const editP95Ms = nearestRankP95(edits);
  if (noopP95Ms >= props.noopP95MaxMs || editP95Ms >= props.editP95MaxMs) {
    throw new Error(
      `${props.language}: lifecycle performance missed its target: ` +
        `no-op p95 ${String(noopP95Ms)}/${String(props.noopP95MaxMs)} ms, ` +
        `edit p95 ${String(editP95Ms)}/${String(props.editP95MaxMs)} ms`,
    );
  }
  return {
    dump: currentDump,
    identity: currentIdentity,
    row: {
      name: "performance",
      status: "passed",
      noopSamples: noops,
      editSamples: edits,
      noopP95Ms,
      editP95Ms,
      noopP95MaxMs: props.noopP95MaxMs,
      editP95MaxMs: props.editP95MaxMs,
    },
  };
}

export function nearestRankP95(samples) {
  if (samples.length === 0) {
    throw new Error("nearestRankP95 requires at least one sample");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function validate(props) {
  for (const [name, value] of Object.entries({
    noopSamples: props.noopSamples,
    editSamples: props.editSamples,
    noopP95MaxMs: props.noopP95MaxMs,
    editP95MaxMs: props.editP95MaxMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `${props.language}: lifecycle performance ${name} must be a positive integer`,
      );
    }
  }
  if (
    typeof props.editFind !== "string" ||
    props.editFind === "" ||
    !Array.isArray(props.editReplacements) ||
    props.editReplacements.length < 2 ||
    props.editReplacements.some(
      (value) => typeof value !== "string" || value === "",
    ) ||
    !props.sourceText.includes(props.editFind)
  ) {
    throw new Error(
      `${props.language}: lifecycle performance requires two real body-edit replacements`,
    );
  }
}
