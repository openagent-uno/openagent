# OpenAgent App 1.1.0 beta 59

- Settings → Models is one grid of every configured model: how you access it
  (subscription, API key or local server), its type, the inputs it accepts,
  its status ("Sign-in expired", "Rate limited", "Not reachable", "Off"),
  quota bars for subscription accounts, pricing and its role (default or
  backup). The budgets stay on the same screen.
- "Add model" is a three-step wizard: access and type, provider, then the
  models with their detected inputs, which you can change.
- Editing a model covers its inputs (automatic from the provider, or set by
  hand), sampling, voice, and its provider with every serving account.
- A turn that ends on a tool call (for example one you stopped) now shows the
  model and the time next to Fork. Needs Server 1.1.9 beta75; turn models
  after a reload need Core beta119 (Server beta76).

The app keeps Host Tools beta18, the existing application ID, local profiles
and device consent.
