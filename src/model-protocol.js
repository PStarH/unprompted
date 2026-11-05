/**
 * Provider API protocols accepted by the model connection.
 *
 * The connection stores one protocol independently of the harness:
 *   chat-completions  OpenAI Chat Completions and compatible servers
 *   responses         OpenAI Responses
 *   messages          Anthropic Messages
 *
 * Keeping request/response shaping here means the classic adapter, the tool
 * loop and the Pi adapter cannot drift into different wire formats.
 */

export const DEFAULT_MODEL_PROTOCOL = 'chat-completions';
export const MODEL_PROTOCOLS = Object.freeze(['chat-completions', 'responses', 'messages']);

const PATHS = Object.freeze({
  'chat-completions': '/chat/completions',
  responses: '/responses',
  messages: '/messages'
});

/** Pi's public API names for the same wire protocols. */
export const PI_API_BY_PROTOCOL = Object.freeze({
  'chat-completions': 'openai-completions',
  responses: 'openai-responses',
  messages: 'anthropic-messages'
});

export function isModelProtocol(value) {
  return MODEL_PROTOCOLS.includes(value);
}

export function modelProtocol(value, fallback = DEFAULT_MODEL_PROTOCOL) {
  return isModelProtocol(value) ? value : fallback;
}

export function modelEndpoint(baseUrl, protocol = DEFAULT_MODEL_PROTOCOL) {
  return `${String(baseUrl || '').replace(/\/$/, '')}${PATHS[modelProtocol(protocol)]}`;
}

export function modelHeaders(protocol = DEFAULT_MODEL_PROTOCOL, apiKey = null) {
  const selected = modelProtocol(protocol);
  return {
    'content-type': 'application/json',
    ...(selected === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
    ...(apiKey ? selected === 'messages' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` } : {})
  };
}

function userInput(user) {
  return [{ role: 'user', content: [{ type: 'input_text', text: user }] }];
}

export function simpleRequest({ protocol, model, system, user }) {
  const selected = modelProtocol(protocol);
  if (selected === 'responses') {
    return {
      model,
      temperature: 0,
      instructions: system,
      input: userInput(user),
      text: { format: { type: 'json_object' } }
    };
  }
  if (selected === 'messages') {
    return {
      model,
      max_tokens: 2048,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }]
    };
  }
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  };
}

function responsesOutputText(body) {
  if (typeof body?.output_text === 'string' && body.output_text) return body.output_text;
  return (Array.isArray(body?.output) ? body.output : [])
    .filter(item => item?.type === 'message')
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function assertComplete(protocol, body) {
  if (protocol === 'responses' && ['incomplete', 'failed'].includes(body?.status)) {
    throw new Error('Model provider returned an incomplete response');
  }
  if (protocol === 'messages' && ['max_tokens', 'refusal'].includes(body?.stop_reason)) {
    throw new Error('Model provider returned an incomplete response');
  }
  if (protocol === 'chat-completions' && ['length', 'content_filter'].includes(body?.choices?.[0]?.finish_reason)) {
    throw new Error('Model provider returned an incomplete response');
  }
}

export function responseText(protocol, body) {
  const selected = modelProtocol(protocol);
  assertComplete(selected, body);
  if (selected === 'responses') return responsesOutputText(body);
  if (selected === 'messages') {
    return (Array.isArray(body?.content) ? body.content : [])
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

/** Start a tool-capable conversation for one protocol. */
export function toolConversation(protocol, { system, user }) {
  const selected = modelProtocol(protocol);
  if (selected === 'responses') return { system, input: userInput(user) };
  if (selected === 'messages') return { system, messages: [{ role: 'user', content: user }] };
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

export function toolRequest({ protocol, conversation, model, tools, final = false }) {
  const selected = modelProtocol(protocol);
  if (selected === 'responses') {
    return {
      model,
      temperature: 0,
      instructions: conversation.system,
      input: conversation.input,
      text: { format: { type: 'json_object' } },
      ...(!final ? {
        tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })),
        parallel_tool_calls: false
      } : {})
    };
  }
  if (selected === 'messages') {
    return {
      model,
      max_tokens: 2048,
      temperature: 0,
      system: conversation.system,
      messages: conversation.messages,
      ...(!final ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {})
    };
  }
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: conversation.messages,
    ...(!final ? {
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      parallel_tool_calls: false
    } : {})
  };
}

function boundedArguments(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function validCalls(calls, protocol) {
  if (protocol === 'messages') {
    return calls.every(call => call && typeof call.id === 'string' && call.id && typeof call.name === 'string' && call.name);
  }
  return calls.every(call => call && typeof call.id === 'string' && call.id && typeof call.name === 'string' && call.name && typeof call.arguments === 'string');
}

/**
 * Normalize one provider turn. `raw` is the sanitized assistant turn that can
 * be appended back to the next request without letting remote metadata invent
 * another role or an unauthorized tool.
 */
export function readToolTurn(protocol, body) {
  const selected = modelProtocol(protocol);
  assertComplete(selected, body);
  if (selected === 'responses') {
    const output = Array.isArray(body?.output) ? body.output : [];
    const calls = output
      .filter(item => item?.type === 'function_call')
      .map(item => ({ id: item.call_id || item.id, name: item.name, arguments: boundedArguments(item.arguments) }));
    if (!validCalls(calls, selected)) throw new Error('Model returned invalid tool calls.');
    const raw = output.flatMap(item => {
      if (item?.type === 'message') {
        return [{
          type: 'message', role: 'assistant',
          content: (Array.isArray(item.content) ? item.content : [])
            .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
            .map(part => ({ type: 'output_text', text: part.text }))
        }];
      }
      if (item?.type === 'function_call') {
        return [{
          type: 'function_call', call_id: item.call_id || item.id, name: item.name,
          arguments: boundedArguments(item.arguments)
        }];
      }
      if (item?.type === 'reasoning') {
        return [{
          type: 'reasoning',
          ...(typeof item.id === 'string' ? { id: item.id } : {}),
          ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {}),
          ...(Array.isArray(item.summary) ? { summary: item.summary } : {})
        }];
      }
      return [];
    });
    return { text: responsesOutputText(body), calls, raw };
  }

  if (selected === 'messages') {
    const content = Array.isArray(body?.content) ? body.content : [];
    const calls = content
      .filter(part => part?.type === 'tool_use')
      .map(part => ({ id: part.id, name: part.name, arguments: boundedArguments(part.input) }));
    if (!validCalls(calls, selected)) throw new Error('Model returned invalid tool calls.');
    const raw = content.flatMap(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
      if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
        return [{ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} }];
      }
      return [];
    });
    return {
      text: raw.filter(part => part.type === 'text').map(part => part.text).join(''),
      calls, raw
    };
  }

  const message = body?.choices?.[0]?.message;
  const providerCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (providerCalls.some(call => !call || call.type !== 'function' || typeof call.id !== 'string' || !call.id
    || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) {
    throw new Error('Model returned invalid tool calls.');
  }
  const calls = providerCalls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
  const raw = {
    content: typeof message?.content === 'string' ? message.content : null,
    tool_calls: providerCalls.map(call => ({
      id: call.id, type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments }
    }))
  };
  return { text: typeof message?.content === 'string' ? message.content : '', calls, raw };
}

export function appendToolTurn(protocol, conversation, turn, results) {
  const selected = modelProtocol(protocol);
  if (selected === 'responses') {
    conversation.input.push(...turn.raw);
    for (const { call, text } of results) {
      conversation.input.push({ type: 'function_call_output', call_id: call.id, output: text });
    }
    return;
  }
  if (selected === 'messages') {
    conversation.messages.push({ role: 'assistant', content: turn.raw });
    conversation.messages.push({
      role: 'user',
      content: results.map(({ call, text }) => ({ type: 'tool_result', tool_use_id: call.id, content: text }))
    });
    return;
  }
  conversation.messages.push({ role: 'assistant', content: turn.raw.content, tool_calls: turn.raw.tool_calls });
  for (const { call, text } of results) {
    conversation.messages.push({ role: 'tool', tool_call_id: call.id, content: text });
  }
}
