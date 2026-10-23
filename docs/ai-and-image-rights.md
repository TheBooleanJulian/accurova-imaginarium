# Images, consent and AI processing

A practical checklist for running client work through Imaginarium. It isn't legal advice. For contract wording, check with a lawyer familiar with Singapore's PDPA and copyright law.

## What the app does with images

- **Uploads** (product photos, brand assets, references) are stored unmodified in a private bucket. Only project members can see them, through links that expire after an hour.
- When you press **Run** on a node connected to images, the server sends those images to the configured AI provider (OpenAI, when `AI_PROVIDER=openai`). Images go only to that provider, are downscaled first, and are never exposed by public URL.
- **Generated images** are labelled as AI concepts, pose references or AI edits, in the app and in every PDF. Each carries a statement that it is a planning reference, not a photograph of the real product and not a guarantee of the final shoot.
- Prompts tell the model to preserve real product details exactly and never invent product features, claims or packaging text. Treat outputs as mood and direction, not product truth.

## Before uploading

- **Product photos and brand assets:** confirm with the client that you may use them for preproduction, including processing by a third-party AI service. A line in the quote or brief sign-off is enough.
- **People:** avoid uploading identifiable people (talent, staff, the public) unless you have their consent for this use. Under the PDPA, a photo of an identifiable person is personal data. Prefer inspiration images without recognisable faces, or with talent who signed a release covering AI-assisted preproduction.
- **Inspiration references:** you usually don't own them. They're used to describe mood, light and composition, and prompts tell the model not to copy people, logos or trademarks from them. Don't put third-party images in a client deliverable, including the PDF, unless you have the right to share them. Untick "Include product photos and inspiration references" when exporting if unsure.
- **Confidential launches:** unreleased products are commercially sensitive. Agree with the client before sending them to an external AI provider, and choose a provider and data region they accept.

## Third-party processing

- Review the provider's current API data-usage and retention terms (for OpenAI: platform.openai.com → data controls / enterprise privacy) and make sure they match what you promise clients. Terms change; check them when you sign up and periodically after that.
- Keys live only on the server (`OPENAI_API_KEY`), never in the browser.
- Mock mode (`AI_PROVIDER=mock`) sends nothing anywhere. Use it for demos and training.

## Suggested client wording

> Preproduction concepts may be created with AI image tools from the brief, references and product photos you supply. They are for planning only: they are not photographs of your product and do not guarantee the final images. Materials you share are processed by our AI provider solely to produce these concepts and are not published.

## Retention

- Deleting a project deletes its database rows (cascading) and its stored files.
- Approval and activity history is kept for the life of the project, so sign-off is auditable.
- Agree a retention period with clients (e.g. delete preproduction material 12 months after the shoot), and delete projects accordingly.
