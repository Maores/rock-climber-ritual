export const meta = {
  name: 'orchestrated-build-rounds',
  description: 'Bounded build-critique-revise rounds against a frozen rubric',
  phases: [
    { title: 'Build', detail: 'domain owners build to contract' },
    { title: 'Integrate', detail: 'merge, contract check, capture evidence' },
    { title: 'Critique', detail: 'fresh critics score the frozen rubric' },
  ],
}

const argv = typeof args === 'string' ? JSON.parse(args) : args

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'defects', 'blindChoice'],
  properties: {
    scores: {
      type: 'array',
      minItems: argv.rubric.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'evidence'],
        properties: {
          id: { enum: argv.rubric.map((c) => c.id) },
          score: { type: 'number', minimum: 1, maximum: 10 },
          evidence: { type: 'string' },
        },
      },
    },
    defects: { type: 'array', items: { type: 'string' } },
    blindChoice: { enum: ['ours', 'reference'] },
  },
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const changelog = []
const rounds = []
let prevTotal = null
let plateau = 0
let verdict = 'rounds-exhausted'

for (let round = 1; round <= argv.caps.maxRounds; round++) {
  log(`Round ${round}/${argv.caps.maxRounds}`)

  phase('Build')
  await parallel(argv.domains.map((d) => () =>
    agent(
      `You own the "${d.name}" domain of this build: ${argv.task}\n` +
      `Working directory: ${argv.workdir}\n` +
      `Files you own (touch nothing else): ${d.files.join(', ')}\n` +
      `Your contract: ${d.contract}\n` +
      `Frozen rubric (build toward every criterion): ${JSON.stringify(argv.rubric)}\n` +
      `Changelog of prior rounds, never retry what already failed:\n` +
      (changelog.join('\n') || '(first round)'),
      { label: `build:${d.name}`, phase: 'Build' }
    )
  ))

  await agent(
    `Integrate the build in ${argv.workdir} for: ${argv.task}\n` +
    `Contracts to verify: ${JSON.stringify(argv.domains.map((d) => ({ name: d.name, contract: d.contract })))}\n` +
    `Confirm the artifact actually runs. Capture evidence for judging into ` +
    `${argv.workdir}/review/round-${round}/ : screenshots for a visual build, ` +
    `command outputs for a behavioral one (this build's reference kind: ${argv.reference.kind}). ` +
    `Evidence MUST cover EVERY rubric criterion: for performance-type criteria capture an fps ` +
    `overlay, a stress or long run past the rubric's failure threshold, and a rapid-input test. Also write ` +
    `${argv.workdir}/review/round-${round}/manifest.md containing ONLY a plain list ` +
    `of the evidence files you captured: file names and captured states only, no build ` +
    `narrative, no mention of fixes or violations, and no interpretive captions (do not ` +
    `label a capture "fresh palette"; critics judge that themselves). Report exactly what you ` +
    `captured and any contract violation you fixed or could not fix.`,
    { label: `integrate:r${round}`, phase: 'Integrate' }
  )

  const reviews = (await parallel(Array.from({ length: argv.caps.critics }, (_, k) => k + 1).map((i) => () =>
    agent(
      `You are adversarial critic #${i}. You have NOT seen how this was built; ` +
      `judge only the artifact evidence.\n` +
      `Evidence: ${argv.workdir}/review/round-${round}/ and its manifest.md (the ` +
      `plain evidence-file list, nothing else).\n` +
      `Reference is ${argv.reference.name} (${argv.reference.kind}). ` +
      `Reference materials: ${argv.reference.materials.join(', ')}\n` +
      `Score EVERY criterion 1-10 against its low/high anchors, one concrete piece ` +
      `of evidence per score. Rubric: ${JSON.stringify(argv.rubric)}\n` +
      `List the most damaging concrete defects you can find. Then the blind ` +
      `side-by-side: ours or the reference, which is better overall? Answer honestly.`,
      { label: `critic${i}:r${round}`, phase: 'Critique', schema: CRITIC_SCHEMA }
    )
  ))).filter(Boolean)

  const perCriterion = argv.rubric.map((c) => {
    const scores = reviews
      .map((r) => r.scores.find((s) => s.id === c.id)?.score)
      .filter((x) => typeof x === 'number')
    return { id: c.id, name: c.name, target: c.target, score: scores.length ? median(scores) : 0, samples: scores.length }
  })
  const degraded = perCriterion.some((c) => c.samples < 2)
  const total = perCriterion.reduce((a, c) => a + c.score, 0)
  const defects = reviews.flatMap((r) => r.defects)
  rounds.push({ round, perCriterion, total, blind: reviews.map((r) => r.blindChoice), defects: defects.slice(0, 15), degraded })
  changelog.push(
    `Round ${round}: total ${total.toFixed(1)}; top defects: ${defects.slice(0, 15).join(' | ')}` +
    (degraded ? `; DEGRADED: criteria with <2 critic samples: ${perCriterion.filter((c) => c.samples < 2).map((c) => c.id).join(', ')}` : '')
  )

  if (perCriterion.every((c) => c.score >= c.target)) { verdict = 'targets-met'; break }
  if (prevTotal !== null && total - prevTotal < argv.caps.minDelta) { plateau++ } else { plateau = 0 }
  prevTotal = total
  if (plateau >= argv.caps.plateauLimit) { verdict = 'plateaued'; break }
}

return { verdict, rounds, changelog }
