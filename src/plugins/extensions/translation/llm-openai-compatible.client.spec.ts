// src/plugins/extensions/translation/llm-openai-compatible.client.spec.ts
import { OpenAiCompatibleClient, parseModelJson } from './llm-openai-compatible.client';
import { ProviderRefusedError } from './core/errors';
import { TranslateRequest } from './core/ports';

const req = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  text: 'hola Doug',
  senderName: 'Ana',
  candidateLangs: ['en', 'es', 'ru'],
  hintLang: 'es',
  glossary: ['Doug', 'Ana'],
  history: [{ author: 'Doug', lang: 'en', text: 'hi', at: '2026-09-16T00:00:00Z' }],
  allowExternal: true,
  ...over,
});

const completion = (content: string) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ choices: [{ message: { content } }] }),
});

/**
 * Routes by URL so the `/language-models` probe and the `/models` fallback stay distinguishable.
 * Omitting `languageModels` simulates a provider without that endpoint (OpenAI, Ollama, LM Studio),
 * which answers 404.
 */
const catalogFetch = (routes: { languageModels?: unknown; models?: unknown }) =>
  jest.fn<Promise<unknown>, [string, RequestInit?]>().mockImplementation((url: string) => {
    if (url.endsWith('/language-models')) {
      const status = routes.languageModels ? 200 : 404;
      return Promise.resolve({
        ok: status === 200,
        status,
        json: () => Promise.resolve(routes.languageModels ?? {}),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes.models ?? { data: [] }) });
  });

function client(over: Partial<ConstructorParameters<typeof OpenAiCompatibleClient>[0]> = {}) {
  return new OpenAiCompatibleClient({
    baseUrl: 'https://api.x.ai/v1/',
    apiKey: 'k',
    model: 'grok-test',
    timeoutMs: 1000,
    ...over,
  });
}

describe('OpenAiCompatibleClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is an external provider named llm', () => {
    const c = client();
    expect(c.name).toBe('llm');
    expect(c.external).toBe(true);
    expect(c.currentModel()).toBe('grok-test');
  });

  it('posts a chat completion with system + JSON user payload and parses the result', async () => {
    const fetchMock = jest
      .fn<Promise<unknown>, [string, RequestInit?]>()
      .mockResolvedValue(completion('{"source":"es","translations":{"en":"hi Doug","ru":"привет Doug"}}'));
    global.fetch = fetchMock as never;

    const out = await client().translateAll(req());

    expect(out).toEqual({
      detected: 'es',
      source: 'es',
      translations: [
        { lang: 'en', text: 'hi Doug' },
        { lang: 'ru', text: 'привет Doug' },
      ],
      provider: 'llm',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init?.body as string) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('grok-test');
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/glossary/);
    const user = JSON.parse(body.messages[1].content) as Record<string, unknown>;
    expect(user).toMatchObject({
      text: 'hola Doug',
      candidateLangs: ['en', 'es', 'ru'],
      hintLang: 'es',
      glossary: ['Doug', 'Ana'],
    });
    expect(user).not.toHaveProperty('allowExternal');
  });

  it('extracts JSON wrapped in code fences or prose', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        completion('Sure!\n```json\n{"source":"es","translations":{"en":"hi","ru":"x"}}\n```'),
      ) as never;
    const out = await client().translateAll(req());
    expect(out.translations[0]).toEqual({ lang: 'en', text: 'hi' });
  });

  it('throws ProviderRefusedError when a required target is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"es","translations":{"en":"hi"}}')) as never;
    await expect(client().translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
  });

  it('throws ProviderRefusedError on refusal prose instead of JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion("I'm sorry, but I can't help with that request.")) as never;
    await expect(client().translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
  });

  it('throws a plain Error on non-JSON that is not a refusal', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('hola => hello')) as never;
    const p = client().translateAll(req());
    await expect(p).rejects.toThrow(/non-JSON/);
    await expect(p).rejects.not.toBeInstanceOf(ProviderRefusedError);
  });

  it('rejects an invalid source code', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(completion('{"source":"Spanish","translations":{"en":"hi","ru":"x"}}')) as never;
    await expect(client().translateAll(req())).rejects.toThrow(/invalid source/);
  });

  // `und`/`mul`/`zxx` are well-formed ISO 639-2 codes that name no language. `source` becomes
  // `detected`, which the coordinator feeds to participant learning — and on a participant's first
  // message learning adopts it at once, so accepting one would put a pseudo-language into the
  // group's known set and have the provider asked to translate *into* it from then on.
  it.each(['und', 'mul', 'zxx', 'UND', 'und-Latn'])('rejects the non-language source code %s', async code => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(completion(`{"source":"${code}","translations":{"en":"hi","ru":"x"}}`)) as never;
    await expect(client().translateAll(req())).rejects.toThrow(/invalid source/);
  });

  it('accepts a BCP-47 source with a script subtag (LibreTranslate emits zh-Hans)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(completion('{"source":"zh-Hans","translations":{"en":"hi","ru":"x"}}')) as never;
    const out = await client().translateAll(req({ candidateLangs: ['en', 'zh-Hans', 'ru'], hintLang: 'zh-Hans' }));
    expect(out).toEqual({
      detected: 'zh-Hans',
      source: 'zh-Hans',
      translations: [
        { lang: 'en', text: 'hi' },
        { lang: 'ru', text: 'x' },
      ],
      provider: 'llm',
    });
  });

  it("canonicalizes a case-drifted source to the group's spelling", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(completion('{"source":"zh-hans","translations":{"en":"hi","ru":"x"}}')) as never;
    const out = await client().translateAll(req({ candidateLangs: ['en', 'zh-Hans', 'ru'], hintLang: 'zh-Hans' }));
    expect(out.detected).toBe('zh-Hans');
    expect(out.source).toBe('zh-Hans');
    expect(out.translations).toEqual([
      { lang: 'en', text: 'hi' },
      { lang: 'ru', text: 'x' },
    ]);
  });

  it('matches a target key case-insensitively rather than calling it a refusal', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(completion('{"source":"es","translations":{"en":"hi","zh-hans":"你好"}}')) as never;
    const out = await client().translateAll(req({ candidateLangs: ['en', 'es', 'zh-Hans'] }));
    expect(out.translations).toEqual([
      { lang: 'en', text: 'hi' },
      { lang: 'zh-Hans', text: '你好' },
    ]);
  });

  it('returns empty translations when candidateLangs is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"de","translations":{}}')) as never;
    const out = await client().translateAll(req({ candidateLangs: [], hintLang: null }));
    expect(out).toEqual({ detected: 'de', source: 'de', translations: [], provider: 'llm' });
  });

  it('aborts on timeout and counts it as a failure', async () => {
    global.fetch = jest.fn(
      (_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    ) as never;
    const c = client({ timeoutMs: 10, failureThreshold: 1 });
    await expect(c.translateAll(req())).rejects.toThrow('aborted');
    expect(c.isHealthy()).toBe(false);
  });

  it('opens the circuit after N transport failures, throws fast while open, and reports unhealthy', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }) as never;
    const c = client({ failureThreshold: 2, cooldownMs: 60000 });
    await expect(c.translateAll(req())).rejects.toThrow('HTTP 500');
    expect(c.isHealthy()).toBe(true);
    await expect(c.translateAll(req())).rejects.toThrow('HTTP 500');
    expect(c.isHealthy()).toBe(false);
    await expect(c.translateAll(req())).rejects.toThrow('circuit open');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('refusals do not count toward the breaker', async () => {
    global.fetch = jest.fn().mockResolvedValue(completion('{"source":"es","translations":{}}')) as never;
    const c = client({ failureThreshold: 1 });
    await expect(c.translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
    await expect(c.translateAll(req())).rejects.toBeInstanceOf(ProviderRefusedError);
    expect(c.isHealthy()).toBe(true);
  });

  it('languages() returns a broad static list including en/es/ru/zh', async () => {
    const langs = await client().languages();
    expect(langs).toEqual(expect.arrayContaining(['en', 'es', 'ru', 'zh']));
    expect(langs.length).toBeGreaterThan(40);
  });

  it('listModels() parses the OpenAI shape without prices', async () => {
    global.fetch = catalogFetch({ models: { object: 'list', data: [{ id: 'gpt-x', object: 'model' }] } }) as never;
    const c = client({ baseUrl: 'https://api.openai.com/v1' });
    expect(await c.listModels()).toEqual([{ id: 'gpt-x' }]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('listModels() converts xAI price fields to USD per 1M tokens', async () => {
    global.fetch = catalogFetch({
      models: { data: [{ id: 'grok-4.3', prompt_text_token_price: 12500, completion_text_token_price: 25000 }] },
    }) as never;
    expect(await client().listModels()).toEqual([{ id: 'grok-4.3', inputPerMTok: 1.25, outputPerMTok: 2.5 }]);
  });

  it('listModels() caches the catalog', async () => {
    global.fetch = catalogFetch({ models: { data: [{ id: 'a' }] } }) as never;
    const c = client();
    await c.listModels();
    await c.listModels();
    // one `/language-models` probe + one `/models` fallback; the second call is served from cache.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('listModels() converts xAI price fields through the /language-models route', async () => {
    // The route actually taken against real xAI. Fixture values are the observed live ones:
    // /language-models carries prompt_text_token_price / completion_text_token_price alongside
    // output_modalities, so preferring that route costs no pricing information.
    global.fetch = catalogFetch({
      languageModels: {
        models: [
          {
            id: 'grok-4.20-0309-non-reasoning',
            output_modalities: ['text'],
            prompt_text_token_price: 12500,
            completion_text_token_price: 25000,
          },
        ],
      },
    }) as never;
    expect(await client().listModels()).toEqual([
      { id: 'grok-4.20-0309-non-reasoning', inputPerMTok: 1.25, outputPerMTok: 2.5 },
    ]);
  });

  it('listModels() prefers /language-models and never calls /models when the provider has it', async () => {
    global.fetch = catalogFetch({
      languageModels: { models: [{ id: 'grok-4.6', output_modalities: ['text'] }] },
    }) as never;
    const c = client();
    expect(await c.listModels()).toEqual([{ id: 'grok-4.6' }]);
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
    expect(urls).toEqual(['https://api.x.ai/v1/language-models']);
  });

  it('listModels() drops models the provider declares as non-text', async () => {
    global.fetch = catalogFetch({
      languageModels: {
        models: [
          { id: 'grok-4.6', output_modalities: ['text'] },
          { id: 'grok-imagine-image', output_modalities: ['image'] },
          { id: 'grok-imagine-video', output_modalities: ['video'] },
        ],
      },
    }) as never;
    expect((await client().listModels()).map(m => m.id)).toEqual(['grok-4.6']);
  });

  it('listModels() keeps models that declare no modalities at all (Ollama / LM Studio)', async () => {
    // A self-hosted catalog publishes neither modalities nor prices. Dropping these would leave
    // every self-hosted operator with an empty model list.
    global.fetch = catalogFetch({ models: { data: [{ id: 'llama3.2' }, { id: 'qwen2.5' }] } }) as never;
    expect((await client({ baseUrl: 'http://localhost:11434/v1' }).listModels()).map(m => m.id)).toEqual([
      'llama3.2',
      'qwen2.5',
    ]);
  });

  it('listModels() filters a mixed /models catalog on declared modalities', async () => {
    global.fetch = catalogFetch({
      models: {
        data: [
          { id: 'chat-a', output_modalities: ['text'] },
          { id: 'draw-b', output_modalities: ['image'] },
          { id: 'bare-c' },
        ],
      },
    }) as never;
    expect((await client().listModels()).map(m => m.id)).toEqual(['chat-a', 'bare-c']);
  });

  it('a successful /language-models probe resets the failure count, like /models does', async () => {
    global.fetch = jest.fn<Promise<unknown>, [string, RequestInit?]>().mockImplementation((url: string) => {
      if (url.endsWith('/language-models')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [{ id: 'grok-4.6', output_modalities: ['text'] }] }),
        });
      }
      return Promise.reject(new Error('boom'));
    }) as never;
    const c = client({ failureThreshold: 2, catalogTtlMs: 0 });

    await expect(c.translateAll(req())).rejects.toThrow('boom'); // failures: 1
    await c.listModels(); // reachable provider -> failures reset to 0
    await expect(c.translateAll(req())).rejects.toThrow('boom'); // failures: 1, not 2

    expect(c.isHealthy()).toBe(true);
  });

  it('a missing /language-models endpoint does not count toward the circuit breaker', async () => {
    global.fetch = catalogFetch({ models: { data: [{ id: 'a' }] } }) as never;
    const c = client({ failureThreshold: 1 });
    await c.listModels();
    expect(c.isHealthy()).toBe(true);
  });

  it('a 404 on /language-models is probed only once per client', async () => {
    global.fetch = catalogFetch({ models: { data: [{ id: 'a' }] } }) as never;
    const c = client({ catalogTtlMs: 0 });
    await c.listModels();
    await c.listModels();
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
    expect(urls.filter(u => u.endsWith('/language-models'))).toHaveLength(1);
    expect(urls.filter(u => u.endsWith('/models'))).toHaveLength(2);
  });

  it('setModel() changes the model on the next request', async () => {
    const fetchMock = jest
      .fn<Promise<unknown>, [string, RequestInit?]>()
      .mockResolvedValue(completion('{"source":"es","translations":{"en":"hi","ru":"x"}}'));
    global.fetch = fetchMock as never;
    const c = client();
    c.setModel('grok-4.6');
    await c.translateAll(req());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe('grok-4.6');
    expect(c.currentModel()).toBe('grok-4.6');
  });
});

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson('{"source":"en","translations":{}}')).toEqual({ source: 'en', translations: {} });
  });
  it('extracts the span from the first { to the last } in surrounding text', () => {
    expect(parseModelJson('Here: {"source":"en","translations":{"es":"x"}} done')).toEqual({
      source: 'en',
      translations: { es: 'x' },
    });
  });
});
