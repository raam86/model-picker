// Asks how hard a new session is before its first prompt runs, switches to the
// matching model, and logs one JSON file per session in
// ~/.local/state/model-picker/: the answer, how long it took, the model
// chosen, each turn's model and duration, and the session's end and cost.

const MODEL = {
  'Trivial · Haiku': 'haiku',
  'Easy · Sonnet': 'sonnet',
  'Hard · Opus': 'opus',
  'Intense · Fable': 'fable',
}

const QUESTION = [
  'Trivial: mechanical; a wrong result is obvious at a glance.',
  'Easy: goal and method known; tests or a quick look catch mistakes.',
  'Hard: it can look right and be wrong, or the design is not settled.',
  'Intense: hard, and every claim or word will be judged, or it runs long.',
  '',
  'How hard is this session?',
].join('\n')

async function recordPath($, sessionId) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  return home + '/.local/state/model-picker/' + sessionId + '.json'
}

// Models that answered each turn's requests, keyed by turn id, until the turn ends.
const answeredBy = new Map()

export function register(on) {
  on('prompt.submit', async ($, e, next) => {
    // Only prompts a person typed; -p runs, peers and notifications pass through.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const sessionId = await $.session.id()
    const path = await recordPath($, sessionId)
    if (await $.fs.exists(path)) return next(e)
    // A resumed session already has its model and its cache.
    if ((await $.session.messages()).length > 0) return next(e)

    const record = {
      sessionId,
      cwd: await $.session.cwd(),
      askedAt: new Date().toISOString(),
      modelBefore: await $.session.model(),
      prompt: e.text.slice(0, 300),
      promptChars: e.text.length,
      answer: null,
      difficulty: null,
      model: null,
      turns: [],
    }
    try {
      record.answer = await $.ui.ask(QUESTION, { options: Object.keys(MODEL), header: 'Difficulty' })
    } catch {
      // Dismissed: keep the current model, and log the skip so it counts.
      record.skipped = true
    }
    record.answeredAt = new Date().toISOString()
    record.decisionMs = Date.parse(record.answeredAt) - Date.parse(record.askedAt)
    if (record.answer !== null) {
      record.model = MODEL[record.answer] ?? null
      // A label from the menu, or the words typed under Other.
      record.difficulty = record.model ? record.answer.split(' · ')[0] : record.answer
    }
    await $.fs.write(path, JSON.stringify(record))
    // Skipped, typed under Other, or already on the chosen model: send as is.
    if (!record.model || record.modelBefore.includes(record.model)) return next(e)

    // /model can't run while this hook holds the turn, so hand the prompt back
    // and switch once the session is idle; nothing is cached yet.
    $.clock.after(0, async () => {
      try {
        await $.command.run({ command: 'model', args: record.model })
        record.switchedAt = new Date().toISOString()
      } catch (err) {
        $.ui.status('model-picker: switch to ' + record.model + ' failed: ' + String(err))
        record.switchError = String(err)
      }
      await $.fs.write(path, JSON.stringify(record))
    })
    return { drop: 'Switching to ' + record.answer.split(' · ')[1] + '. Press Enter to send.' }
  }).catch(async ($, e, next) => {
    $.ui.status('model-picker failed: ' + next.error.kind + ' ' + (next.error.message ?? ''))
    return next(e)
  })

  // The models that actually answered each main-conversation request, by turn;
  // the session's reported model can differ from the one a request went to.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage?.model) {
      const models = answeredBy.get(e.turnId) ?? new Set()
      models.add(result.usage.model)
      answeredBy.set(e.turnId, models)
    }
    return result
  })

  // Each main-conversation turn: when it ended, the session's model, the
  // models that answered, how long it took.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const answered = [...(answeredBy.get(e.turnId) ?? [])]
    answeredBy.delete(e.turnId)
    const path = await recordPath($, await $.session.id())
    if (!(await $.fs.exists(path))) return next(e)
    const record = JSON.parse(await $.fs.read(path))
    record.turns.push({ at: new Date().toISOString(), model: await $.session.model(), answeredBy: answered, durationMs: e.durationMs, isAborted: e.isAborted ?? false })
    await $.fs.write(path, JSON.stringify(record))
    return next(e)
  })

  // The session ends, or /clear or /resume starts another: close the record.
  on('session.end', async ($, e, next) => {
    const path = await recordPath($, e.sessionId)
    if (await $.fs.exists(path)) {
      const record = JSON.parse(await $.fs.read(path))
      const usage = await $.session.usage()
      record.endedAt = new Date().toISOString()
      record.endReason = e.reason
      record.costUsd = usage.cost?.usd ?? null
      record.contextTokens = usage.context?.tokens ?? null
      await $.fs.write(path, JSON.stringify(record))
    }
    return next(e)
  })
}
