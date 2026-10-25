# Features

## Searching and comparing

- **Every product and price** from Woolworths, Coles, ALDI, IGA and Harris Farm (about 75,000 products), and the liquor shops Dan Murphy's, BWS and Liquorland, refreshed every night. Third-party marketplace listings (Woolworths' Everyday Market) are left out.
- **The cheapest of it, any brand.** Search `1l milk` and the top of the page shows the cheapest 1L milk at your shops, whatever the brand, then the next cheapest and the cheapest at each shop. Search `milk` and it shows each common size with its cheapest, highlighting the best value per litre, kilo or item.
  - "Milk" means plain milk. Lite, lactose-free, oat and so on are one tap away as chips. Free range, barn and cage eggs count as grades of the same thing.
  - Nicknames work: `coke` finds Coca-Cola, and `tp` finds toilet paper.
  - **Fruit and veg** are compared the way they're sold: by the kilo (loose, bagged, or each with a weight) and each, with every shop's price per kg. A plain name means the fresh kind (`tomatoes`, not tinned).
  - The list below puts the thing itself first: bananas before banana bread.
- **Compare equivalents.** Under that, each result shows the cheapest equivalent at every shop. Products count as equivalent when they have **exactly the same pack size** (weight, volume or count) and a similar name, ignoring brand. Woolworths and Coles products are also matched exactly by **barcode**.
- **Wrong match?** Anyone can report one. An admin confirms it, and the fix applies for everyone.
- **Your shops.** Pick the shops you use at sign-up or in Settings, and search only compares those.
- **Your IGA.** Every IGA sets its own prices, so you pick yours by suburb, postcode or "Near me". Only IGAs that publish prices online can be picked, and which ones do is re-checked daily.
- **Alcohol** is hidden unless you turn on **Show alcohol** in Settings. It's recognised by each shop's own category, so ginger beer soft drinks and cooking wine still show.
- **Liquor shops.** With Show alcohol on, Dan Murphy's, BWS and Liquorland join the comparison. Bottles, packs and cases are compared like for like ("24 x 375mL"), and "any six" prices count as multi-buys. With it off, the liquor shops don't appear anywhere, not even for mixers.

## Prices over time

- **Price history.** Each product has a chart of its price over time, alongside the matching products at the other shops. **Price changes** lists the biggest recent rises and drops.
- **Is this a good price?** Products and list items say when today's price is the lowest in months, or when something goes on special in a cycle ("about every 6 weeks, next one likely in ~2 weeks"), so you can wait.
- **Deals on the home page.**
  - **Your regulars on sale:** things you buy often or have on your lists, on special at one of your shops, including a different brand of the same thing.
  - **Unusual deals:** specials that break a product's normal pattern, such as its first special in months or cheaper than its specials usually get. The every-few-weeks half-price cycles are left out.
- **Deals that change the maths.** Multi-buys ("5 for $9") and Everyday Rewards member prices are counted, so list totals use the real cost of the quantity you need.
- **Better-value sizes.** If another pack size of the same item is at least 10% cheaper per kg, litre or item, the list says so, with a **Swap to this** button.
- **Alerts.** Watch a product for a target price or any drop. There's also a Wednesday email of what's on special from your lists.

## Shopping lists

- **Add anything.** Type into the list's Add box and it searches. The cheapest of what you typed is picked by default, or press **Add as note** to keep plain text like "birthday card". **Paste a list** ("milk, bread, 2 x chips") adds several at once.
- **Add cheapest.** Adds "the cheapest 2L milk, any brand" rather than one product. Each shop's pick is worked out again whenever prices change.
- **How each item matches.** For each item choose any brand of the same size, the same brand only, or this exact product. You can pick a different product at a particular shop, or rule a shop out.
- **Always buy it at…** Pin an item to one shop, and the list shows what that costs you.
- **Choose your shops per list.** Each shop gets a card that you can untick. A shop you use shows what it's **saving you** and warns if it's the only place with some items. A shop you've excluded shows what it's **costing you**.
- **Shared lists.** Share a list with your household with an invite link. Everyone sees each other's changes.
- **Order the cheapest.** Splits the list by cheapest shop into a per-shop list with product links and copy and print buttons, and compares the total with buying everything at one shop. When self-hosting, it can also fill your Woolworths and Coles trolleys in a browser on your machine (see [configuration](configuration.md#ordering)).

## In the shop

- **A checklist per shop**, sorted by section (fruit & veg, bakery, dairy…) in the order most supermarkets are laid out. It learns your own shop's layout from the order you tick things off.
- Tap to cross items out, or **scan a barcode** to tick an item or see what it costs elsewhere.
- Ticks sync to everyone on a shared list and work offline. The site can be installed as an app.
- **Finish shop** saves what you bought, so you can repeat it. You can also save regular shops to add in one go.
- **Spending:** each finished shop records what it cost and how much splitting it across shops saved, with a monthly chart.

## Look

- **Light or dark.** The round button in the header switches between Auto (follows your device), Light and Dark, remembered on each device.

## Accounts

- Anyone can search. Signing up gives you a list, settings and alerts.
- Email confirmation, password reset, **changing your email** (confirmed by a link to the new address, with a heads-up to the old one), a privacy page, and data export and account deletion in Settings.

## Running it

- **Admin page.**
  - Start a price refresh and follow it live.
  - See each shop's data health: freshness, how much can be compared, and uncategorised products.
  - Manage admins.
  - Change site settings: email, the privacy page, and sharing the work with helpers.
  - Download backups.
  - See which version is running.
- **Problems come to you.** If a refresh has problems, admins get **one summary email** after it finishes: what failed, what found far fewer products, and what has recovered. Admins are also emailed if a helper goes quiet.
- **Fresh Coles prices without getting blocked.** Coles is refreshed a page every couple of minutes instead of all at once. Searching something whose Coles prices are over a day old fetches them there and then.
- **Blocked shops back off.** When a shop blocks the crawler (Coles' bot check), the crawl stops, remembers where it got to, and carries on a few hours later. It doesn't push through the block.
- **Helpers share the work.** People you trust can run the collector on their own connection.
  - Each shop's refresh is split into departments that the server and collectors share. Coles pages are shared out under one combined limit. Helpers make refreshes more reliable without asking the shops for more.
  - **Invite them by email:** they get what it is, how to set it up and a link to download it themselves, set up for your site.
  - Each helper has its own token and can be turned off.
- **Helpers, one click.** Your own PC (for shops that block your server) or a friend's: each helper has a ready-configured download:
  - a single program for Windows or Linux (including a Raspberry Pi);
  - a zip for a Mac.
  - It sends prices to your site and keeps itself up to date.
- **Backups.** A nightly snapshot, plus optional continuous off-site backup with Litestream.
- **Security.**
  - Passwords are hashed with scrypt.
  - Sessions are HttpOnly, SameSite cookies, and only token hashes are stored.
  - State-changing requests are checked for origin.
  - Requests are rate-limited, and pages send a strict Content-Security-Policy.
  - List endpoints check membership, so outsiders get "not found".
