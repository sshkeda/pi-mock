import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMock,
  createControllableBrain,
  text,
  echo,
  withContextWindowLimit,
  estimateRequestTokens,
} from '../dist/index.js';

const TIMEOUT = 30_000;

function lastAssistant(messages) {
  return [...(messages ?? [])].reverse().find((m) => m.role === 'assistant');
}

test('withContextWindowLimit rejects oversized requests with provider-style message', async () => {
  const mock = await createMock({
    brain: withContextWindowLimit(echo(), {
      maxInputTokens: 120,
      message: ({ actualTokens, maxInputTokens }) =>
        `Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. ${actualTokens} > ${maxInputTokens}","param":"input"},"sequence_number":2}`,
    }),
    startupTimeoutMs: 15000,
  });

  try {
    const oversized = 'X'.repeat(4000);
    const events = await mock.run(oversized, TIMEOUT);
    const end = events.find((e) => e.type === 'agent_end');
    const assistant = lastAssistant(end?.messages);

    assert.ok(assistant, 'expected final assistant message');
    assert.equal(assistant.stopReason, 'error');
    assert.match(assistant.errorMessage, /context_length_exceeded/);
    assert.match(assistant.errorMessage, /Your input exceeds the context window/);

    const req = mock.requests.at(-1);
    assert.ok(req, 'expected recorded request');
    assert.ok(estimateRequestTokens(req) > 120, 'expected request to exceed synthetic token budget');
  } finally {
    await mock.close();
  }
});

test('promptExpectReject captures already-processing prompt rejection', async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt('first');
    const call = await cb.waitForCall(5000);

    const err = await mock.promptExpectReject('second while first is still running', 5000);
    assert.match(err, /already processing/i);

    call.respond(text('done'));
    await mock.drain(TIMEOUT);
  } finally {
    await mock.close();
  }
});
