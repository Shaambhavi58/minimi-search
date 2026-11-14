Minimi Search

Minimi Search is a Node.js chat agent that remembers earlier conversations and checks current facts with web search. Ask a follow-up in a new chat and it can recover the original question, recheck the answer against current sources, and link to the evidence.

Quick start

You'll need Node.js 22.13+, a Groq API key for chat, and a Tavily API key for web search.

git clone https://github.com/Shaambhavi58/minimi-search.git
cd minimi-search
npm install
cp .env.example .env

Set GROQ_API_KEY and TAVILY_API_KEY in .env. If you prefer OpenAI, leave both blank and set a funded OPENAI_API_KEY instead.

npm run dev

Open http://localhost:3000.

Try a follow-up across chats







Step



Prompt





Start a chat



Compare Neon Launch and Supabase Pro. Cite each price using an official source.





Click New chat



What did I ask you earlier today about Neon and Supabase?





Verify the earlier answer



Verify the Supabase Pro price from your earlier answer. Put a clickable official citation immediately after the price.

For a broader change check, ask the agent to shortlist five CRM tools for a 20-person sales team. In a new chat, ask whether any of those products changed pricing or shipped a major update since the shortlist. A current price can verify what a vendor charges today. A claim about when it changed needs dated evidence.

How it works





Recall. SQLite stores completed turns with timestamps and the browser's local calendar date. The server retrieves exact-date matches, recent turns in the current chat, and relevant full-text matches.



Search. Web search is the agent's only tool. The default setup uses Groq for reasoning and Tavily for search. The OpenAI configuration uses hosted web search.



Cite. The server maps cited source IDs to URLs returned by search. The browser renders those URLs as clickable citations next to the claims.

Relative dates use the browser's time zone. An unqualified weekday refers to its most recent occurrence, including today. “Last Tuesday” means Tuesday of the previous Monday–Sunday week. Use an ISO date such as 2026-11-03 when you need an exact day.

Tests and local data

Run npm test without API keys. The offline suite covers date resolution, cross-chat recall, session isolation, response handling, and citation mapping.

Chats persist across server restarts in .data/chat.sqlite and are scoped to the browser's session cookie. The server sends the current message and selected history excerpts to the configured model provider. Keep .env and .data/ local.

See DESIGN.md for architecture choices, tradeoffs, and evaluation plans.