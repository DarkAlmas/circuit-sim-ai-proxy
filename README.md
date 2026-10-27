# circuit-sim AI proxy

HTTPS proxy so [circuit-sim](https://darkalmas.github.io/circuit-sim/) (✦ Помощник) can call Groq with an OpenAI-compatible chat-completions API. The Groq key stays in the server environment. The browser never receives it, and a key pasted by the user is ignored.

Прокси для ✦ Помощник: браузер ходит на этот сервер, сервер ходит в Groq. Ключ Groq только в переменной окружения. В git его нет, клиентский `Authorization` отбрасывается.

## Production URL

After the Vercel project is named `circuit-sim-ai-proxy`:

- Base URL for circuit-sim: `https://circuit-sim-ai-proxy.vercel.app/v1`
- Chat endpoint (`chatUrl()` appends `/chat/completions`): `https://circuit-sim-ai-proxy.vercel.app/v1/chat/completions`

`vercel.json` rewrites `/v1/chat/completions` to the function `api/v1/chat/completions.js`. The direct function URL `/api/v1/chat/completions` works the same way.

## Deploy

1. Import `DarkAlmas/circuit-sim-ai-proxy` in Vercel (framework: Other, Node.js 18+). Root directory is the repo root.
2. Do not put a key in the repo. Programming Bot sets `GROQ_API_KEY` in Vercel → Settings → Environment Variables for Production after deploy. `.env.example` is an empty placeholder.
3. Deploy. The function reads `process.env.GROQ_API_KEY` on each request. If the variable is missing or blank, the proxy returns **503** and does not call Groq.

```bash
# optional CLI deploy, still with the key only in the host environment
npx vercel --prod
```

## curl

```bash
curl -sS "https://circuit-sim-ai-proxy.vercel.app/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Origin: https://darkalmas.github.io" \
  -d '{"messages":[{"role":"user","content":"Ответь одним словом: ок"}]}'
```

No `Authorization` header. If `model` is omitted, the proxy sends `openai/gpt-oss-20b` (`llama-3.1-8b-instant` is retired on Groq and returns 404). A request with `"stream": true` gets **400**; only non-streaming responses are proxied.

Локально (`npx vercel dev`), когда ключ уже задан в окружении процесса, а не в файле репозитория:

```bash
curl -sS "http://localhost:3000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
```

## CORS

Allowed origins are reflected in `Access-Control-Allow-Origin`. Anything else gets **403** and no allow-origin header.

| Origin | Allowed |
| --- | --- |
| `https://darkalmas.github.io` | yes |
| `http://localhost` and `http://localhost:<port>` | yes |
| `http://127.0.0.1` and `http://127.0.0.1:<port>` | yes |
| any other origin | no |

`OPTIONS` preflight is answered with **204** for an allowed origin. Requests with no `Origin` (curl, server-side) are accepted. A browser on another site cannot read the response. Outside a browser, `Origin` can be spoofed; the IP rate limit is the backstop.

Разрешены только страница circuit-sim на GitHub Pages и локальный http. Чужой сайт получит 403.

## Rate limit

20 POST requests per client IP per 10 minutes. The 21st response is **429** with `Retry-After` (seconds until the oldest hit leaves the window). The counter is an in-memory `Map` inside one serverless instance: a cold start resets it, and several instances do not share counts, so a client can exceed 20 while the deployment is scaled out. OPTIONS is not counted.

Лимит 20 запросов / 10 минут на IP хранится в памяти одного инстанса. Это не глобальный счётчик.

## Request limits

- Body cap: 100KB (**413**).
- Upstream call aborted after 30s (**504**). Function `maxDuration` is 35s so the timeout response can still be sent.
- Redirects from Groq are not followed (**502**), so the bearer token is not sent to another host.
- Message text and the API key are not written to logs. Error responses never include the key or the upstream error text.

## circuit-sim setting

Set the assistant base URL to `https://circuit-sim-ai-proxy.vercel.app/v1` and the model to `openai/gpt-oss-20b` (or any other live Groq model id). Omitting `model` uses that same default. Do not send `llama-3.1-8b-instant`: Groq answers 404 for it, and the proxy forwards an explicit model unchanged.

Current circuit-sim (`keyRequired` in `assistant-core.js`) still refuses to send an HTTPS request until some non-empty key is typed in the page. This proxy ignores that header. A follow-up in circuit-sim should treat this origin as keyless so ✦ works with an empty key field.

В текущем circuit-sim https-адрес без ключа в поле ввода не уходит. Прокси чужой ключ всё равно не использует. Чтобы помощник работал совсем без вставки ключа, клиенту нужно разрешить пустой ключ для origin этого прокси. Модель в настройках помощника: `openai/gpt-oss-20b`. Старый id `llama-3.1-8b-instant` Groq больше не обслуживает.

## Tests

```bash
npm test
```
