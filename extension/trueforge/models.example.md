# Model configuration example (no keys)

How to configure the two models in TrueForge only (never in the extension):

1. Start TrueForge: `npx @truefoundry/trueforge@latest` (default http://localhost:8790).
2. Add a primary model `<PRIMARY_MODEL>` with provider and key entered in the TrueForge UI/config.
3. Add a fallback model `<FALLBACK_MODEL>` the same way.
4. Load `contexo.agent.json` (primary) and `contexo-fallback.agent.json` (fallback).
5. For Task C, break the primary key or endpoint to demonstrate automatic fallback.

Do not commit provider keys or endpoints.
