# Taking it to production

This guide covers how I would take the assistant from my Mac to a public service efficiently. I research and write it in Milestone 7, with sources and an as-of date for every price and limit.

Planned sections:

1. Hosted chat models: Anthropic Claude, OpenAI, Google Gemini and open-model hosts, compared on quality, latency, price, free tiers and data-use terms, with my recommended default and fallback.
2. Search APIs for fresh information, and the built-in web search tools some model providers offer.
3. Moderation services.
4. Making the model better over time, in order of cost: prompt and persona tuning, retrieval over curated sources, preference data from approved feedback, and fine-tuning. Fine-tuning does not give a model knowledge of recent events; search does.
5. Deployment: container hosting, GPU versus CPU inference, managed database, caching, observability, secrets, CI/CD, and estimated monthly cost for a small demo and for 10,000 users.
6. A production readiness checklist.
