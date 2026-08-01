---
name: clearlist
description: Run a real resale sale end to end. Turn photos of household items into priced listings, publish one shareable sale page, and manage a buyer queue, reservations, and pickup scheduling through the ClearList MCP server. Use when someone is moving, downsizing, clearing an estate, or otherwise selling more than a couple of things at once.
---

# ClearList

[ClearList](https://clearlist.me) is an AI resale manager. You photograph what you
are selling, AI writes each listing with a researched price and estimated dimensions,
and everything lands on one shareable page. Buyers reserve what they want in a
first-come queue and book their own pickup time, so the seller never answers "is this
still available?"

This skill lets you run that whole job for someone through the ClearList MCP server.

## When to use this

Use it when someone says any version of:

- "I'm moving and I need to sell all this stuff"
- "help me sell this couch / these boxes / my parents' house contents"
- "price this and list it somewhere"
- "how much is this worth and where do I sell it"

Do not use it for a single item someone just wants appraised. Answer that directly.
ClearList earns its keep at roughly five items and up, where the page, the queue, and
the scheduling start doing work a chat thread cannot.

## Setup

The MCP server is on npm. No account or API key is needed to start.

```json
{
  "mcpServers": {
    "clearlist": {
      "command": "npx",
      "args": ["-y", "@clearlist/mcp-server"],
      "env": { "CLEARLIST_API_URL": "https://clearlist.me" }
    }
  }
}
```

There is also a hosted server at `https://clearlist.me/api/mcp` for hosts that support
remote MCP with OAuth. Note the difference: the hosted server authenticates over OAuth
and needs a browser, while the npm package supports the no-browser onboarding below.
If the person you are helping has never used ClearList, use the npm package.

## Creating the account

ClearList has no signup page to get past. Account creation is itself a tool, so the
whole thing happens in conversation:

1. Call `send_verification_code({ email })`.
2. Ask them to read you the 6-digit code from their inbox.
3. Call `verify_code({ email, code, agent: true })`. You get back an API key.
4. Hold that key for the rest of the session. Every later call uses it.

There is no password anywhere. Do not invent one, do not ask for one, and do not
suggest they visit the website to "finish setting up." They do not need to.

## The normal flow

1. **Get photos.** Ask for photos of everything. Multiple angles per item is better,
   and mixing several items into one batch is fine.
2. **Create the listings.** Use `bulk_create_listings` for a batch (up to 50 photos,
   it groups them by item for you) or `create_listing` for one thing at a time. Both
   return the AI-written title, description, price, condition, and dimensions.
3. **Check the prices with them.** The prices are model estimates, not live comparable
   sales. Say that plainly if they ask where the number came from. Use `edit_listing`
   for anything they want changed.
4. **Publish.** `publish_page` needs a city and returns the shareable URL. That link
   is the whole product. Tell them to put it wherever they were going to post
   individual listings.
5. **Run the sale.** `get_reservations` shows who reserved what and where the timers
   stand. `reply_to_buyer` answers questions. `mark_picked_up` closes items out.
6. **Optional: scheduling.** `set_availability` turns on pickup slots so buyers book
   their own times instead of negotiating in the inbox.

Check `check_tier_status` before a big batch. The free tier holds 3 active items; the
paid passes are one-time, $20 for 50 items over 30 days and $39 for 200 items over 60
days. If they are over the limit, `generate_payment_link` returns a checkout URL they
open themselves. Do not try to pay for anything on their behalf.

## What you cannot do, on purpose

**You cannot share the seller's home address.** There is no tool for it, and the API
refuses address disclosure to agent credentials at several independent points. This is
not an oversight to work around.

The reason is a specific threat model: someone hiding from an abuser lists their
furniture, the abuser recognizes it, poses as a buyer, and asks for the pickup
address. A confirmation prompt is socially engineerable, and the person most likely to
be targeted is the least able to absorb one mistake.

So if a buyer asks where to pick something up, do not answer it, do not guess, and do
not retype an address you found earlier in the thread. Tell the seller a buyer is
asking and let them share it themselves from the ClearList app. That is the entire
design.

## Full reference

- Developer docs: <https://clearlist.me/developers>
- API reference: <https://clearlist.me/docs/api>
- OpenAPI 3.1 spec: <https://clearlist.me/.well-known/openapi.json>
- Source: <https://github.com/Cuneiform-LLC/clearlist-mcp>
