# audiolink — Studio & Admin User Guide

This covers the two pages studio operators and system administrators use
day to day. Field reporters use a separate, simpler "Client" page — they
just open the link they're given and click Start; there's nothing to
learn beyond that, so it isn't covered here.

## Logging in

Go to your station's audiolink address (given to you separately —
looks like `https://<your-domain>:<port>/login`) and sign in with your
Studio or Admin username and password. You'll land on the matching page
automatically.

Click **Log Out** (top right) when you're done, especially on a shared
studio computer.

---

## Studio page

This is where you answer incoming call requests from field reporters.

### The Links table

Every "Link" is a standing, named call address you can share with a
reporter (e.g. "Morning Desk", "OB Van 2"). Admins (or Studio operators,
via the form below the table) create these ahead of time — they don't
expire and can be reused call after call.

Each row shows:
- **Name** and when it was created
- **Status** — a colored badge:
  - *gray, "idle"* — nobody is using it
  - *amber, "armed, waiting for caller"* — you've clicked Start and it's
    ready for the reporter to connect
  - *green, pulsing, "live (m:ss)"* — a call is actually connected right
    now, with elapsed time
- **URL** — the shareable web address for that Link, with a **Copy URL**
  button. Send this to the reporter (text message, email, however you'd
  normally reach them) *before* the call — they open it in their phone
  or laptop's browser.
- **Actions** — **Start**/**Stop**, and **Delete** (only available while
  idle).

### Taking a call

1. Send the reporter the Link's URL ahead of time, if you haven't already.
2. Click **Start** on that Link's row. Your browser will ask for
   microphone permission the first time — allow it.
3. The row's Start button becomes **Stop**, and the status shows
   "activating..." then "waiting for client..." — this is normal; it
   means you're ready and waiting for the reporter to open their link
   and click Start on their end.
4. Once they do, the call connects automatically — no further action
   needed on either side. The status badge turns green and shows a live
   timer.
5. Click **Stop** to end the call at any time. The Link goes back to
   idle and is ready for the next caller.

If the reporter's device disconnects, hangs up, or the call times out
after an hour of inactivity, the Link automatically re-arms itself and
goes straight back to "waiting for client..." on the same row — you
don't need to click Start again. It only fully returns to idle after you
deliberately click Stop.

### Audio Devices

If the studio computer has more than one microphone or speaker (e.g. a
line-level broadcast interface alongside a built-in one), use **Refresh
Devices** to list them and pick the correct Input/Output from the
dropdowns *before* clicking Start on a Link. If you don't touch these,
the system default device is used — fine for a quick test, but on the
real studio hardware you'll normally want to select the actual broadcast
interface explicitly.

### Round-trip

While a call is live, a **Round-trip** figure is shown next to the
status badge — a rough network-latency indicator. It measures the
signaling path only, not the full audio delay you'll perceive by ear,
so don't be alarmed if it reads a few milliseconds while the audio still
feels slightly delayed — some of that is normal audio buffering, not a
fault.

---

## Admin page

Everything on the Studio page, plus system-wide controls.

### System — Link availability

A single switch that enables or disables **every** Link at once —
use this to take the whole system offline (e.g. for maintenance)
without deleting anything. While disabled, reporters trying to connect
see "link is currently unavailable," and Studio can't arm any Link.

Clicking **Disable Link** asks for confirmation first, since it affects
every caller station-wide. Re-enabling is a single click — it's the
safe, restorative direction, so it doesn't need a second confirmation.

### Change Password

Change the password for **either** the Studio or the Admin account from
here (Studio has no password-management screen of its own — this is the
only place to do it). Pick the account from the dropdown, enter and
confirm a new password, and submit.

Passwords must be at least 12 characters and include an uppercase
letter, a lowercase letter, a number, and a symbol — you'll get a
specific error message if one of those is missing. The change takes
effect immediately; it does not log out anyone currently using that
account, so it's safe to change the Studio password even mid-broadcast.

### Links

The same table as the Studio page, plus **Force Terminate** — ends a
live call immediately regardless of who's on it (e.g. if a call needs
to be cut for an emergency, or a studio operator can't reach their own
computer). This asks for confirmation first. The Studio side sees "ended
by admin" and the Link goes fully idle — unlike a normal hang-up, it
does *not* automatically re-arm, so a Studio operator has to
consciously decide to take the next caller.

Creating and deleting Links works the same as on the Studio page. A Link
can't be deleted while it's armed or live — stop or force-terminate it
first.

### Recent Activity

A running log of what's happened: Links created/deleted, calls
started/stopped, and any call-quality problems that were detected
(e.g. a bad connection). Shows 20 events per page (newest first) with
**Previous**/**Next** to page through history, plus **From**/**To**
date-and-time fields to narrow it to a specific window — useful for
checking what happened around a specific call without scrolling through
everything. Click **Clear** to drop the date filter and see everything
again.

This is a plain record for reference, not a live dashboard — click
**Refresh** to pull the latest entries.

---

## Troubleshooting

- **"error: Permission denied"** — the browser's microphone permission
  was denied. Check your browser's site settings for this page and
  allow microphone access, then try Start again.
- **"busy — another session is already active"** — someone is already on
  that specific Link. Either wait, or use a different Link.
- **"link is currently unavailable"** — an Admin has disabled the whole
  system (see System, above), or the Link itself doesn't exist/was
  deleted.
- **"this Link is already active on another browser"** — another Studio
  computer/tab already clicked Start on this same Link. Only one Studio
  can arm a given Link at a time.
- **Studio shows "waiting for client..." indefinitely** — this is
  normal until the reporter opens their link and clicks Start on their
  side; nothing further is needed from Studio until then.
