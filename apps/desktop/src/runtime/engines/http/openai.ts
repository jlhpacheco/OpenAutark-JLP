// OpenAI Responses API engine (also usable with SIWC tokens later).
// Owns: request shape (instructions = the stable prompt, input items with the live context first, function tools, reasoning.effort + summary,
// store:false, stream:true, encrypted reasoning carried between tool rounds) and SSE parsing
// (reasoning summaries per output item with section breaks, D5). B-078: the agent's temperature goes to models without
// reasoning. B-083: effort `none` goes on the wire as `reasoning: {effort: 'none'}` (left out, the model reasons at its
// default medium), and a reasoning model takes the temperature only there (OpenAI: "When reasoning effort is not none,
// remove temperature"); the models that refuse `none` (NO_NONE) are not offered it and run at `low` when it comes anyway.
// Never: uses previous_response_id (stateless: the full projection is sent each turn).

import type { EngineId, Effort } from '../../../shared/model/providers.ts';
import type { EngineEvent, EngineTurnInput } from '../types.ts';
import type { ToolOutput } from '../../tools/types.ts';
import { traceCallId, type TraceCall } from '../../../shared/model/subconscious.ts';
import { ToolNames, contextText, isRecord, num, outputImages, outputText, str, tryJson } from '../shared.ts';
import { HttpEngine, splitInput, type LoopStep } from './base.ts';
import { HttpEngineError, postJson, readSse } from './common.ts';

const LIMIT_CODES = /usage_limit|rate_limit|insufficient_quota|subscription_sharing_usage/;
/** The reasoning families – every gpt generation from 5 up (gpt-5 … gpt-9, gpt-10 and later) and the o-series: they take
 *  reasoning.effort, and a temperature only at effort `none`. Fest 22.11.2026: no list of generation numbers, so the next
 *  one is a reasoning model from its first day; gpt-4o, gpt-4.1, gpt-image-…, gpt-realtime and gpt-oss stay outside it. */
const REASONING = /^(gpt-([5-9]|[1-9]\d)|o\d)/;

/** B-083: reasoning models that refuse effort `none` (OpenAI docs 08.11.2026: GPT-6 Astra, GPT-6.1 Sol; the first gpt-5
 *  generation and the o-series end at minimal/low). GPT-6 Sol, GPT-6 Luna, GPT-6.1 Terra and gpt-5.1+ take it. */
const NO_NONE = /^(gpt-6-astra|gpt-6\.1-sol|gpt-5(-|$)|o\d)|-(codex|pro)(-|$)/; // -codex/-pro variants: not known to take `none` – at worst they run at `low`
const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

/** Reasoning models outside those families (codex-mini-latest): they refuse a temperature at every effort. */
const NO_TEMPERATURE = /^codex-/;

/** B-078/B-083 (D14, D16): the temperature this model gets on the Responses API (0..2) at this effort, undefined where it is
 *  dropped: none asked, codex-mini, a reasoning model above effort `none` (or without an effort to judge by). */
export function openAiTemperature(model: string, value: number | undefined, effort?: Effort): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || NO_TEMPERATURE.test(model)) return undefined;
  if (REASONING.test(model) && (effort !== 'none' || NO_NONE.test(model))) return undefined;
  return Math.max(0, Math.min(2, value));
}

/** B-083: the `reasoning` field for this effort – `none` explicitly (left out, the model reasons at medium), `low` for a model
 *  that refuses `none`, nothing for a model without reasoning at `none`; `max` goes as the API's `xhigh`. */
function reasoningFor(model: string, effort: Effort): Record<string, string> | undefined {
  if (effort !== 'none') return { effort: effort === 'max' ? 'xhigh' : effort, summary: 'auto' };
  if (!REASONING.test(model)) return undefined;
  return NO_NONE.test(model) ? { effort: 'low', summary: 'auto' } : { effort: 'none' };
}

export class OpenAiEngine extends HttpEngine {
  readonly id: EngineId = 'openai';

  protected authHeaders(key: string | undefined): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  protected override effortsFor(model: string): Effort[] {
    if (!REASONING.test(model)) return ['none'];
    return NO_NONE.test(model) ? [...LEVELS] : ['none', ...LEVELS];
  }

  protected async startConversation(input: EngineTurnInput, names: ToolNames, base: string) {
    const content: Array<Record<string, unknown>> = [];
    const context = contextText(input.system.volatile);
    if (context) content.push({ type: 'input_text', text: context });
    for (const part of splitInput(input.input).parts) {
      if (part.type === 'text') content.push({ type: 'input_text', text: part.text });
      else content.push({ type: 'input_image', image_url: `data:${part.mime};base64,${await this.image(part.path)}` });
    }
    const items: unknown[] = [{ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '(continue)' }] }];
    const tools = input.tools.map((tool) => ({ type: 'function', name: names.wire(tool.name), description: tool.description, parameters: tool.inputSchema, strict: false }));
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: input.system.stable,
      store: false, stream: true,
      include: ['reasoning.encrypted_content'],
    };
    if (tools.length) body.tools = tools;
    const reasoning = reasoningFor(input.model, input.effort);
    if (reasoning) body.reasoning = reasoning;
    const temperature = openAiTemperature(input.model, input.temperature, input.effort);
    if (temperature !== undefined) body.temperature = temperature;
    if (input.outputSchema) body.text = { format: { type: 'json_schema', name: 'result', schema: input.outputSchema, strict: false } };

    const step = async (key: string | undefined, emit: (e: EngineEvent) => void): Promise<LoopStep> => {
      const response = await postJson(this.fetchFn, `${base}/responses`, { Accept: 'text/event-stream', ...this.authHeaders(key) }, { ...body, input: items }, input.signal);
      let text = '';
      let final: Record<string, unknown> | undefined;
      const outputs: Record<string, unknown>[] = [];
      for await (const { data } of readSse(response)) {
        if (!isRecord(data)) continue;
        const type = str(data.type);
        if (type === 'response.output_text.delta' && typeof data.delta === 'string') { text += data.delta; emit({ type: 'text', delta: data.delta }); }
        // D5: reasoning per output item (item_id); a later summary part is a section break; the item's end closes the block.
        else if (type === 'response.reasoning_summary_text.delta' && typeof data.delta === 'string') emit({ type: 'reasoning', delta: data.delta, ...(str(data.item_id) ? { id: str(data.item_id) } : {}) });
        else if (type === 'response.reasoning_summary_part.added' && (num(data.summary_index) ?? 0) > 0) emit({ type: 'reasoning', delta: '\n\n', ...(str(data.item_id) ? { id: str(data.item_id) } : {}) });
        else if (type === 'response.output_item.done' && isRecord(data.item)) {
          outputs.push(data.item);
          if (data.item.type === 'reasoning') emit({ type: 'reasoning_end', ...(str(data.item.id) ? { id: str(data.item.id) } : {}) });
        }
        else if (type === 'response.completed' && isRecord(data.response)) final = data.response;
        else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
          const err = isRecord(data.response) && isRecord(data.response.error) ? data.response.error : data;
          const code = String(err.code ?? '');
          if (LIMIT_CODES.test(code)) throw new HttpEngineError({ code: 'rate_limited', message: 'The usage limit of this account was reached.' });
          const u = isRecord(data.response) && isRecord(data.response.usage) ? data.response.usage : undefined;
          throw new HttpEngineError({ code: 'internal', message: type === 'response.incomplete' ? 'The model response was cut off.' : 'The model could not complete this turn.' },
            u ? { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 } : undefined);
        }
      }
      if (!final) throw new HttpEngineError({ code: 'internal', message: 'The model response did not complete.' });
      const output = Array.isArray(final.output) ? final.output.filter(isRecord) : outputs;
      // Carry every output item (reasoning with encrypted content, messages, calls) into the next round.
      // With store:false, item ids cannot be resolved server-side; only reasoning keeps its id.
      items.push(...output.map((item) => {
        if (item.type === 'reasoning') return item;
        const { id: _id, status: _status, ...rest } = item;
        return rest;
      }));
      // Preserve invalid/missing arguments so the shared loop returns an error rather than executing {}.
      const calls = output.filter((item) => item.type === 'function_call').map((item) => ({ id: str(item.call_id) ?? '', name: str(item.name) ?? '', args: tryJson(str(item.arguments) ?? '') }));
      const u = isRecord(final.usage) ? final.usage : {};
      return { text, calls, done: calls.length === 0, usage: { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 }, structured: input.outputSchema ? tryJson(text.trim()) : undefined };
    };

    const addResults = (results: Array<{ id: string; name: string; output: ToolOutput }>) => {
      const images: Array<Record<string, unknown>> = [];
      for (const r of results) {
        items.push({ type: 'function_call_output', call_id: r.id, output: (r.output.isError ? 'ERROR: ' : '') + (outputText(r.output) || 'ok') });
        for (const img of outputImages(r.output)) images.push({ type: 'input_image', image_url: `data:${img.mime};base64,${img.dataBase64}` });
      }
      if (images.length) items.push({ role: 'user', content: [{ type: 'input_text', text: 'Images returned by the tool calls above:' }, ...images] });
    };
    const addUserText = (text: string) => { items.push({ role: 'user', content: [{ type: 'input_text', text }] }); }; // steering (base.ts)
    const injectTrace = (calls: readonly TraceCall[]) => {
      calls.forEach((call, index) => {
        const id = traceCallId(input.runId, index);
        items.push({ type: 'function_call', call_id: id, name: names.wire(call.tool), arguments: JSON.stringify(call.args) }, { type: 'function_call_output', call_id: id, output: call.output });
      });
    };
    return { step, addResults, addUserText, injectTrace };
  }
}
