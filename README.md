# Minimi Search

A local chat agent with web search, clickable citations and dated memory across chats.

## Run

Use Node.js 22.13+ and a [Groq API key](https://console.groq.com/keys) with access to GPT-OSS plus a [Tavily API key](https://app.tavily.com/) for web search. A funded OpenAI API key is an alternative.

```bash
npm install
cp .env.example .env
# Set GROQ_API_KEY and TAVILY_API_KEY in .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app prefers Groq when a Groq key is configured. Node, SQLite and the browser handle everything else. `npm test` runs offline.

## Try the follow-up flow

1. Ask, “Shortlist five CRM tools for a 20-person sales team. Include the lowest practical paid tier for each and cite the pricing.”
2. Click **New chat**. Ask, “What did I ask you today about CRM tools? Is your answer still correct today?”
3. Ask, “Did any of those prices change since our earlier comparison? Flag anything you can't date.”

The app records dates from the browser's time zone when each message is sent. An unqualified weekday refers to its most recent occurrence, including today. “Last Tuesday” refers to the Tuesday of the previous Monday–Sunday week. Dates without years use the most recent matching calendar date. To test a precise interpretation, use an ISO date.

## Data and limits

Completed turns live in `.data/chat.sqlite`. Chats are scoped to the browser's session cookie and persist after a restart. Current messages and selected history excerpts are sent to the configured provider for generation. Public web search is the only model tool. This is a local-first demo with a loopback bind, no accounts and no cross-device sync. Keep the database and `.env` out of source control.

See [DESIGN.md](DESIGN.md) for architecture and tradeoffs.
